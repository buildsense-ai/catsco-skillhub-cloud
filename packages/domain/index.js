import crypto from "node:crypto";
import path from "node:path";

export const SubmissionStatus = Object.freeze({
  SUBMITTED: "submitted",
  SCAN_PENDING: "scan_pending",
  SCANNING: "scanning",
  SCAN_FAILED: "scan_failed",
  REVIEW_PENDING: "review_pending",
  CHANGES_REQUESTED: "changes_requested",
  APPROVED: "approved",
  REJECTED: "rejected",
  PACKAGING: "packaging",
  PUBLISHED: "published",
  BUILD_FAILED: "build_failed"
});

export const PackageStatus = Object.freeze({
  PUBLISHED: "published",
  YANKED: "yanked",
  DEPRECATED: "deprecated"
});

export const JobStatus = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed"
});

export const Role = Object.freeze({
  PUBLIC: "public",
  AGENT: "agent",
  DEVELOPER: "developer",
  REVIEWER: "reviewer",
  ADMIN: "admin",
  SYSTEM: "system"
});

export function nowIso() {
  return new Date().toISOString();
}

export function generateId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function slugify(value, fallbackPrefix = "skill") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (normalized) return normalized.slice(0, 72);
  const hash = sha256(String(value ?? crypto.randomUUID())).slice(0, 10);
  return `${fallbackPrefix}-${hash}`;
}

export function assertSemver(version) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(version ?? ""))) {
    throw new ValidationError("version 必须使用 SemVer，例如 1.0.0", "manifest.version");
  }
}

export class ValidationError extends Error {
  constructor(message, code = "validation_error", status = 400) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
    this.status = status;
  }
}

export class AuthError extends Error {
  constructor(message = "Unauthorized", status = 401) {
    super(message);
    this.name = "AuthError";
    this.code = "auth_error";
    this.status = status;
  }
}

export function toArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/[,\n，、]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

export function uniqueArray(items, max = 30) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const text = String(item ?? "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text.slice(0, 80));
    if (result.length >= max) break;
  }
  return result;
}

const domainKeywordMap = [
  {
    match: ["合同", "contract", "legal", "法务", "条款"],
    keywords: ["合同审查", "合同风险", "法务审核", "条款检查", "违约责任", "付款条款"],
    categories: ["legal"],
    examples: ["帮我审查这份采购合同的风险点", "检查合同里的付款和违约条款"]
  },
  {
    match: ["ppt", "powerpoint", "汇报", "演示", "presentation"],
    keywords: ["PPT", "汇报材料", "演示文稿", "幻灯片", "总结汇报"],
    categories: ["office"],
    examples: ["把这份材料整理成 PPT 汇报", "帮我优化演示文稿结构"]
  },
  {
    match: ["工程量", "清单", "boq", "造价", "算量", "招标"],
    keywords: ["工程量清单", "BOQ", "造价", "清单计价", "招标工程量", "综合单价"],
    categories: ["construction"],
    examples: ["根据工程量清单生成报价", "检查这份 BOQ 是否有漏项"]
  },
  {
    match: ["excel", "spreadsheet", "表格", "数据"],
    keywords: ["Excel", "表格分析", "数据清洗", "公式检查", "报表"],
    categories: ["office"],
    examples: ["帮我分析这张 Excel 表", "检查表格公式有没有错误"]
  }
];

export function inferSearchMetadata(input = {}) {
  const text = [
    input.name,
    input.displayName,
    input.description,
    input.readme,
    input.skillText,
    ...(toArray(input.keywords)),
    ...(toArray(input.tags))
  ]
    .join("\n")
    .toLowerCase();

  const keywords = [...toArray(input.keywords), ...toArray(input.tags)];
  const categories = [...toArray(input.categories)];
  const examples = [...toArray(input.triggerExamples)];

  for (const group of domainKeywordMap) {
    if (group.match.some((word) => text.includes(word.toLowerCase()))) {
      keywords.push(...group.keywords);
      categories.push(...group.categories);
      examples.push(...group.examples);
    }
  }

  return {
    keywords: uniqueArray(keywords, 40),
    categories: uniqueArray(categories, 8),
    triggerExamples: uniqueArray(examples, 12)
  };
}

export function normalizeManifest(input = {}, inferred = {}) {
  const displayName = String(input.displayName ?? input.display_name ?? input.title ?? input.name ?? inferred.displayName ?? "").trim();
  if (!displayName) throw new ValidationError("manifest 缺少 displayName/name", "manifest.displayName");

  const name = slugify(input.name ?? input.id ?? displayName, "skill");
  const version = String(input.version ?? inferred.version ?? "1.0.0").trim();
  assertSemver(version);

  const description = String(input.description ?? inferred.description ?? "").trim();
  if (!description) {
    throw new ValidationError("description 不能为空，请说明 Skill 的用途或适用场景", "manifest.description");
  }

  const search = inferSearchMetadata({
    ...input,
    displayName,
    description,
    readme: inferred.readme,
    skillText: inferred.skillText
  });

  const permissions = normalizePermissions(input.permissions ?? {});
  const minAgentVersion =
    input.minAgentVersion ??
    input.min_agent_version ??
    input.runtime?.minAgentVersion ??
    input.runtime?.min_agent_version ??
    "1.14.0";

  return {
    schemaVersion: "1.0.0",
    id: slugify(input.id ?? input.skillId ?? name, "skill"),
    name,
    displayName,
    version,
    description: description.slice(0, 800),
    author: {
      name: String(input.author?.name ?? input.authorName ?? input.publisher ?? "Unknown").trim().slice(0, 120),
      url: String(input.author?.url ?? input.authorUrl ?? "").trim().slice(0, 300)
    },
    license: String(input.license ?? "UNLICENSED").trim().slice(0, 80),
    homepageUrl: String(input.homepageUrl ?? input.homepage_url ?? "").trim().slice(0, 300),
    repositoryUrl: String(input.repositoryUrl ?? input.repository_url ?? "").trim().slice(0, 300),
    categories: uniqueArray([...toArray(input.categories), ...search.categories], 8),
    tags: uniqueArray(toArray(input.tags), 20),
    keywords: uniqueArray([...toArray(input.keywords), ...search.keywords], 40),
    triggerExamples: uniqueArray([...toArray(input.triggerExamples), ...search.triggerExamples], 12),
    permissions,
    runtime: {
      minAgentVersion: String(minAgentVersion).trim(),
      platforms: uniqueArray(toArray(input.platforms ?? input.runtime?.platforms ?? ["windows", "macos", "linux"]), 8)
    },
    entrypoints: {
      skillFile: String(input.entrypoints?.skillFile ?? input.skillFile ?? "SKILL.md").trim()
    },
    createdBy: input.createdBy ?? undefined
  };
}

export function normalizePermissions(input = {}) {
  const network = input.network ?? "none";
  const shell = input.shell ?? "none";
  const filesystem = input.filesystem ?? input.fileSystem ?? "none";
  const secrets = input.secrets ?? "none";
  return {
    filesystem: normalizePermissionValue(filesystem, ["none", "workspace", "user_selected", "readonly"]),
    network: normalizePermissionValue(network, ["none", "domain_allowlist"]),
    networkDomains: uniqueArray(toArray(input.networkDomains ?? input.network_domains), 20),
    shell: normalizePermissionValue(shell, ["none", "specific_commands"]),
    shellCommands: uniqueArray(toArray(input.shellCommands ?? input.shell_commands), 20),
    secrets: normalizePermissionValue(secrets, ["none", "user_selected"])
  };
}

function normalizePermissionValue(value, allowed) {
  const text = String(value ?? "none").trim();
  return allowed.includes(text) ? text : "none";
}

export function validatePackagePath(packagePath, limits = {}) {
  const raw = String(packagePath ?? "");
  if (!raw || raw.length > (limits.maxPathLength ?? 180)) {
    throw new ValidationError(`非法文件路径: ${raw}`, "path.invalid");
  }
  if (raw.includes("\0") || /[\x00-\x1F]/.test(raw)) {
    throw new ValidationError(`文件路径包含控制字符: ${raw}`, "path.control_char");
  }
  if (raw.includes("\\") || /^[a-zA-Z]:/.test(raw) || raw.startsWith("/") || raw.startsWith("~")) {
    throw new ValidationError(`文件路径必须是包内相对 POSIX 路径: ${raw}`, "path.absolute_or_windows");
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized.startsWith("../") || normalized === ".." || path.posix.isAbsolute(normalized)) {
    throw new ValidationError(`文件路径不能逃逸包目录: ${raw}`, "path.traversal");
  }
  const segments = normalized.split("/");
  if (segments.length > (limits.maxPathDepth ?? 12)) {
    throw new ValidationError(`文件路径层级过深: ${raw}`, "path.too_deep");
  }
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ValidationError(`文件路径包含非法段: ${raw}`, "path.invalid_segment");
  }
  return normalized;
}

export function compareSemver(a, b) {
  const pa = String(a ?? "0.0.0").split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b ?? "0.0.0").split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

export function hasBlockingFindings(findings = []) {
  return findings.some((finding) => ["high", "critical"].includes(finding.severity));
}

export function summarizeRisk(findings = []) {
  if (findings.some((finding) => finding.severity === "critical")) return "critical";
  if (findings.some((finding) => finding.severity === "high")) return "high";
  if (findings.some((finding) => finding.severity === "medium")) return "medium";
  if (findings.some((finding) => finding.severity === "low")) return "low";
  return "low";
}

export function publicManifest(manifest) {
  const copy = structuredClone(manifest);
  delete copy.createdBy;
  return copy;
}
