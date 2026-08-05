import { inferSearchMetadata, normalizeManifest, sha256, summarizeRisk, toArray, validatePackagePath } from "../domain/index.js";
import { redactString } from "../audit/index.js";
import { parseZipArchive } from "./zip.js";

const findingRules = [
  {
    code: "prompt.override",
    severity: "critical",
    pattern: /(ignore (all )?(previous|above) instructions|system prompt|developer message|override safety|忽略(之前|以上|上面)|系统提示词|开发者消息|绕过安全|泄露提示词)/i,
    message: "疑似要求修改或绕过系统/开发者指令"
  },
  {
    code: "secret.read",
    severity: "critical",
    pattern: /(\.env|\.ssh|id_rsa|id_ed25519|aws_secret_access_key|openai_api_key|github_token|cookie|浏览器.*cookie|私钥|密钥|令牌)/i,
    message: "疑似读取密钥、私钥、token 或私人文件"
  },
  {
    code: "shell.exec",
    severity: "high",
    pattern: /(child_process|spawn\(|exec\(|bash\s+-c|powershell|cmd\.exe|rm\s+-rf|curl\s+.*\|\s*(bash|sh)|wget\s+.*\|\s*(bash|sh)|nc\s+-e|反弹 shell)/i,
    message: "疑似任意 shell 或危险命令执行"
  },
  {
    code: "network.command",
    severity: "high",
    pattern: /(curl\s+https?:|wget\s+https?:|fetch\(\s*['"]https?:|axios\.|requests\.|socket|netcat)/i,
    message: "疑似未经声明的网络访问"
  },
  {
    code: "network.url",
    severity: "low",
    pattern: /https?:\/\/[^\s"')]+/i,
    message: "包含外部 URL，审核时需确认不会作为联网执行入口"
  },
  {
    code: "dynamic.code",
    severity: "high",
    pattern: /(eval\(|new Function\(|import\(.+https?:|download.*execute|下载.*执行|远程.*执行)/i,
    message: "疑似动态下载或执行代码"
  }
];

const executableExtensions = /\.(exe|dll|so|dylib|msi|bat|cmd|ps1|sh|apk|appimage)$/i;
const nestedArchiveExtensions = /\.(zip|tar|tgz|gz|bz2|7z|rar)$/i;

export function filesFromSubmissionBody(body, limits) {
  if (body?.source?.type === "zip") {
    const archive = Buffer.from(String(body.source.archiveBase64 ?? ""), "base64");
    if (!archive.length) throw new Error("zip 上传缺少 archiveBase64");
    return parseZipArchive(archive, limits);
  }
  if (body?.source?.type === "files" || Array.isArray(body?.files)) {
    const files = body.source?.files ?? body.files;
    return files.map((file) => ({
      path: validatePackagePath(file.path, limits),
      buffer: file.contentBase64 ? Buffer.from(String(file.contentBase64), "base64") : Buffer.from(String(file.content ?? ""), "utf8")
    }));
  }
  throw new Error("提交必须包含 source.type=zip 或 source.type=files");
}

export function buildManifestDraft({ form = {}, files = [] }) {
  const skillText = readText(files, "SKILL.md");
  const readme = readText(files, "README.md") || readText(files, "README.zh-CN.md");
  const packageManifest = parseJsonFile(files, "skill.json");
  const merged = {
    ...packageManifest,
    ...form
  };
  const search = inferSearchMetadata({
    ...merged,
    readme,
    skillText
  });
  return normalizeManifest(
    {
      ...merged,
      keywords: [...toArray(merged.keywords), ...search.keywords],
      categories: [...toArray(merged.categories), ...search.categories],
      triggerExamples: [...toArray(merged.triggerExamples), ...search.triggerExamples]
    },
    {
      readme,
      skillText,
      description: firstUsefulLine(skillText || readme) || merged.description
    }
  );
}

export function scanSkillPackage({ files, manifest, config }) {
  const findings = [];
  const inventory = [];
  let expandedBytes = 0;
  const seen = new Set();

  if (!files.some((file) => file.path === manifest.entrypoints.skillFile)) {
    findings.push(makeFinding("high", "structure.missing_entrypoint", `缺少入口文件 ${manifest.entrypoints.skillFile}`));
  }
  if (!files.some((file) => file.path === "skill.json")) {
    findings.push(makeFinding("medium", "structure.missing_manifest_file", "包内缺少 skill.json，服务端会写入规范化 manifest"));
  }

  for (const file of files) {
    let packagePath;
    try {
      packagePath = validatePackagePath(file.path, config.limits);
    } catch (error) {
      findings.push(makeFinding("critical", "path.invalid", error.message, file.path));
      continue;
    }

    if (seen.has(packagePath)) findings.push(makeFinding("high", "path.duplicate", `重复文件路径: ${packagePath}`, packagePath));
    seen.add(packagePath);

    const buffer = file.buffer ?? Buffer.from(file.content ?? "", "utf8");
    expandedBytes += buffer.length;
    if (buffer.length > config.limits.maxSingleFileBytes) {
      findings.push(makeFinding("high", "file.too_large", `单文件超过限制: ${packagePath}`, packagePath));
    }
    if (nestedArchiveExtensions.test(packagePath)) {
      findings.push(makeFinding("low", "archive.nested", "包内包含嵌套压缩包", packagePath));
    }
    if (executableExtensions.test(packagePath) || hasShebang(buffer)) {
      findings.push(makeFinding("low", "file.executable", "包内包含可执行文件或脚本", packagePath));
    }

    const text = decodeText(buffer);
    if (text) {
      scanText(packagePath, text, findings, manifest);
      scanPackageJson(packagePath, text, findings);
    }

    inventory.push({ path: packagePath, size: buffer.length, sha256: sha256(buffer) });
  }

  if (files.length > config.limits.maxFiles) findings.push(makeFinding("high", "package.too_many_files", "文件数量超过限制"));
  if (expandedBytes > config.limits.maxExpandedBytes) findings.push(makeFinding("high", "package.too_large", "展开后体积超过限制"));

  comparePermissions(manifest, findings);

  return {
    status: "passed",
    riskLevel: summarizeRisk(findings),
    findings,
    inventory: inventory.sort((a, b) => a.path.localeCompare(b.path)),
    summary: {
      files: inventory.length,
      totalBytes: expandedBytes,
      findingCount: findings.length,
      highOrCritical: findings.filter((finding) => ["high", "critical"].includes(finding.severity)).length
    }
  };
}

function scanText(filePath, text, findings, manifest) {
  for (const rule of findingRules) {
    const match = text.match(rule.pattern);
    if (match) {
      const adjusted = adjustTextFinding(rule, filePath, manifest);
      findings.push(makeFinding(adjusted.severity, adjusted.code, adjusted.message, filePath, redactString(match[0])));
    }
  }
}

function scanPackageJson(filePath, text, findings) {
  if (!filePath.endsWith("package.json")) return;
  try {
    const pkg = JSON.parse(text);
    const scripts = pkg.scripts ?? {};
    for (const name of ["preinstall", "install", "postinstall", "prepare"]) {
      if (scripts[name]) {
        findings.push(makeFinding("high", "install.hook", `package.json 包含安装生命周期脚本: ${name}`, filePath));
      }
    }
  } catch {
    findings.push(makeFinding("medium", "package_json.invalid", "package.json 无法解析", filePath));
  }
}

function comparePermissions(manifest, findings) {
  const codes = new Set(findings.map((finding) => finding.code));
  if (codes.has("network.command") && manifest.permissions.network === "none") {
    findings.push(makeFinding("high", "permission.network_mismatch", "内容疑似联网，但 manifest 未声明网络权限"));
  }
  if (codes.has("shell.exec") && manifest.permissions.shell === "none") {
    findings.push(makeFinding("high", "permission.shell_mismatch", "内容疑似执行 shell，但 manifest 未声明 shell 权限"));
  }
  if (codes.has("secret.read") && manifest.permissions.secrets === "none") {
    findings.push(makeFinding("critical", "permission.secret_mismatch", "内容疑似读取密钥，但 manifest 未声明并且首版禁止此行为"));
  }
}

function adjustTextFinding(rule, filePath, manifest) {
  if (isDocumentationOrMetadataPath(filePath)) {
    if (rule.code === "secret.read") {
      return {
        severity: "medium",
        code: "secret.reference",
        message: "文档或示例提到密钥/环境变量，需人工确认不会读取用户私密信息"
      };
    }
    if (rule.code === "shell.exec") {
      return {
        severity: "medium",
        code: "shell.reference",
        message: "文档或示例提到命令行操作，需人工确认不会诱导执行危险命令"
      };
    }
    if (rule.code === "network.command") {
      return {
        severity: "medium",
        code: "network.reference",
        message: "文档或示例提到网络访问，需人工确认用途和目标地址"
      };
    }
    if (rule.code === "prompt.override") {
      return {
        severity: "high",
        code: "prompt.reference",
        message: "文档或示例提到系统/开发者指令，需人工确认不是提示词绕过"
      };
    }
  }

  if (rule.code === "network.command" && manifest.permissions.network !== "none") {
    return {
      severity: "medium",
      code: rule.code,
      message: "内容包含已声明的网络访问，需人工复核域名和用途"
    };
  }
  if (rule.code === "shell.exec" && manifest.permissions.shell !== "none") {
    return {
      severity: "medium",
      code: rule.code,
      message: "内容包含已声明的命令执行能力，需人工复核允许命令"
    };
  }

  return rule;
}

function isDocumentationOrMetadataPath(filePath) {
  const normalized = String(filePath ?? "").replaceAll("\\", "/").toLowerCase();
  return (
    normalized.endsWith(".md") ||
    normalized.endsWith(".txt") ||
    normalized.endsWith(".rst") ||
    normalized.endsWith(".adoc") ||
    normalized.endsWith(".schema.json") ||
    normalized === "license" ||
    normalized === "notice" ||
    normalized === ".gitignore" ||
    normalized === ".env.example" ||
    normalized.endsWith("/.env.example")
  );
}

function makeFinding(severity, code, message, filePath = "", evidence = "") {
  return {
    severity,
    code,
    message,
    filePath,
    evidence,
    scanner: "catsco-static-scanner",
    scannerVersion: "0.1.0"
  };
}

function readText(files, targetPath) {
  const file = files.find((item) => item.path.toLowerCase() === targetPath.toLowerCase());
  return file ? decodeText(file.buffer) : "";
}

function parseJsonFile(files, targetPath) {
  const text = readText(files, targetPath);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function firstUsefulLine(text = "") {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line.length >= 12);
}

function decodeText(buffer) {
  if (!buffer || buffer.length > 512 * 1024) return "";
  if (buffer.includes(0)) return "";
  return buffer.toString("utf8");
}

function hasShebang(buffer) {
  return buffer.length > 2 && buffer[0] === 0x23 && buffer[1] === 0x21;
}
