import { createHash, randomUUID } from "node:crypto";
import { parseTree } from "jsonc-parser";
import { parseDocument } from "yaml";
import { decodeSource, IntakeError } from "./intake.js";

export const RULE_VERSION = "skillhub-publish-v1.0.0";
const DEFAULT_LIMITS = Object.freeze({
  uploadMaxBytes: 50 * 1024 * 1024, maxRequestBytes: 75 * 1024 * 1024, maxFiles: 500,
  maxSingleFileBytes: 5 * 1024 * 1024, maxExpandedBytes: 100 * 1024 * 1024,
  maxPathLength: 180, maxPathDepth: 12, maxDepth: 64, maxNodes: 100_000,
  maxReportBytes: 48 * 1024, maxIssues: 50
});
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = value => createHash("sha256").update(value).digest("hex");
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

export function effectiveLimits(input = {}) {
  const limits = {};
  for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const value = input[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid validation configuration");
    limits[key] = value;
  }
  // These are protocol ceilings, not operator-expandable response sizes.
  limits.maxIssues = Math.min(limits.maxIssues, 50);
  limits.maxReportBytes = Math.min(limits.maxReportBytes, 48 * 1024);
  if (limits.maxReportBytes < 2048) throw new Error("Invalid report budget");
  return limits;
}

export function describeRules(input = {}) {
  return {
    schemaVersion: "1", ruleVersion: RULE_VERSION, profile: "skillhub-publish-v1",
    limits: effectiveLimits(input),
    capabilities: { preflight: true, publicationTasks: false, automaticRepair: false },
    coverage: { functionalTesting: false, comprehensiveSecurityAudit: false,
      redistributionRights: false, unicodeFilesystemEquivalence: false,
      frontmatterLanguages: ["yaml", "json"], defaultPlatforms: ["windows", "macos", "linux"] }
  };
}

class InputError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

// Count structural depth before allocating an AST. Strings/escapes cannot add depth.
function guardJsonDepth(text, limits) {
  let depth = 0, quoted = false, escaped = false;
  for (const c of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{" || c === "[") {
      if (++depth > limits.maxDepth) throw new InputError("json.limit_exceeded", "JSON 层级超过处理限制。", 413);
    } else if (c === "}" || c === "]") depth--;
  }
}

export function parseStrictJson(text, inputLimits = {}) {
  const limits = effectiveLimits(inputLimits);
  guardJsonDepth(text, limits);
  const errors = [];
  const tree = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true });
  if (!tree || errors.length) throw new InputError("json.invalid", "JSON 格式无效。");
  let count = 0;
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (++count > limits.maxNodes) throw new InputError("json.limit_exceeded", "JSON 节点超过处理限制。", 413);
    if (node.type === "number" && !Number.isFinite(node.value)) throw new InputError("json.number_invalid", "JSON 数值超出支持范围。");
    if (node.type === "object") {
      const names = new Set();
      for (const property of node.children ?? []) {
        const key = property.children[0].value;
        if (names.has(key)) throw new InputError("json.duplicate_key", "JSON 存在重复字段。");
        names.add(key);
      }
    }
    const children = node.children ?? [];
    if (count + pending.length + children.length > limits.maxNodes) throw new InputError("json.limit_exceeded", "JSON 节点超过处理限制。", 413);
    for (const child of children) pending.push(child);
  }
  // JSON.parse preserves own __proto__ as data; never merge this into configuration.
  try { return JSON.parse(text); }
  catch { throw new InputError("json.invalid", "JSON 格式无效。"); }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort(byteOrder).map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  if (typeof value === "number" && !Number.isFinite(value)) throw new InputError("json.number_invalid", "JSON 数值超出支持范围。");
  return JSON.stringify(value);
}

function issue(code, message, options = {}) {
  return { code, category: "format", blocking: true, location: {}, message,
    repairPolicy: "manual", ...options };
}

function responseFor(issues, limits, candidateHash, coverage = "complete", status) {
  issues.sort((a, b) => Number(b.blocking) - Number(a.blocking)
    || byteOrder(a.code, b.code) || (a.location.entryIndex ?? -1) - (b.location.entryIndex ?? -1));
  const rejected = issues.some(i => i.blocking) || coverage !== "complete";
  const report = {
    schemaVersion: "1", ruleVersion: RULE_VERSION, profile: "skillhub-publish-v1",
    reportId: randomUUID(), outcome: rejected ? "rejected" : "passed", coverage,
    candidateHash, limitsFingerprint: digest(canonical(limits)),
    issues: issues.slice(0, limits.maxIssues), truncated: issues.length > limits.maxIssues,
    nextAction: rejected ? "review_report" : "none"
  };
  const body = rejected
    ? { error: { code: "skillhub.publish_validation_failed", message: "发布预检未通过，请查看问题报告。", validation: report } }
    : { validation: report };
  while (Buffer.byteLength(`${JSON.stringify(body, null, 2)}\n`) > limits.maxReportBytes && report.issues.length) {
    report.issues.pop(); report.truncated = true;
  }
  return { status: status ?? (rejected ? 422 : 200), body };
}

function safeLocation(file, entryIndex, field) {
  // Even relative names can contain secrets; use an index unless the name is a known metadata file.
  const known = ["SKILL.md", "skill.json", "README.md"].includes(file.path);
  return { entryIndex, ...(known ? { relativePath: file.path } : {}), ...(field ? { field } : {}) };
}

function safePath(p, limits) {
  if (typeof p !== "string" || !p || !p.isWellFormed() || p.length > limits.maxPathLength) return false;
  const parts = p.split("/");
  return parts.length <= limits.maxPathDepth && !/[\x00-\x1f\x7f\\]/.test(p)
    && !/^[a-z]:/i.test(p) && !p.startsWith("~") && !parts.some(s => !s || s === "." || s === "..");
}

function pathsValid(files, limits, issues) {
  const seen = new Set();
  let valid = true;
  for (const [entryIndex, file] of files.entries()) {
    const p = file.path;
    if (!safePath(p, limits)) {
      valid = false;
      issues.push(issue("path.unsafe", "文件路径不是安全的包内相对路径。", {category: "package_safety", location: {entryIndex}}));
    }
    if (seen.has(p)) {
      valid = false;
      issues.push(issue("path.duplicate", "包内存在重复文件路径。", {category: "package_safety", location: {entryIndex}}));
    }
    seen.add(p);
  }
  for (const [entryIndex, file] of files.entries()) {
    const parts = file.path.split("/");
    if (parts.slice(0, -1).some((_, i) => seen.has(parts.slice(0, i + 1).join("/")))) {
      valid = false;
      issues.push(issue("path.collision", "同一路径同时作为文件和目录使用。", {category: "package_safety", location: {entryIndex}}));
    }
  }
  return valid;
}

function targetPlatforms(files, manifest, issues) {
  const platforms = manifest.platforms ?? manifest.runtime?.platforms ?? ["windows", "macos", "linux"];
  if (!Array.isArray(platforms) || !platforms.length || platforms.some(p => !["windows", "macos", "linux"].includes(p))) {
    issues.push(issue("manifest.platforms_invalid", "目标平台须为 windows、macos、linux 的非空列表。", {location: {field: "platforms"}}));
    return;
  }
  const seen = new Map();
  const unicodeSeen = new Map();
  for (const [entryIndex, file] of files.entries()) {
    const parts = file.path.split("/");
    const location = safeLocation(file, entryIndex);
    if (platforms.includes("windows") && parts.some(s => /[<>:"|?*]/.test(s) || /[ .]$/.test(s)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) {
      issues.push(issue("path.target_invalid", "文件路径不兼容声明的 Windows 目标。", {category: "compatibility", location}));
    }
    if (platforms.some(p => p === "windows" || p === "macos")) {
      const folded = file.path.replace(/[A-Z]/g, c => c.toLowerCase());
      if (seen.has(folded)) issues.push(issue("path.collision", "文件路径在声明的大小写不敏感目标上冲突。", {category: "compatibility", location}));
      seen.set(folded, entryIndex);
      const unicode = file.path.normalize("NFC").toLowerCase();
      if (unicodeSeen.has(unicode) && unicodeSeen.get(unicode) !== folded) {
        issues.push(issue("compatibility.unicode_path", "文件路径可能在目标平台发生 Unicode 归一冲突，请人工核对。", {category: "compatibility", blocking: false, location}));
      }
      unicodeSeen.set(unicode, folded);
    }
  }
  // Include file/directory prefix collisions after ASCII case folding.
  for (const [entryIndex, file] of files.entries()) {
    const parts = file.path.replace(/[A-Z]/g, c => c.toLowerCase()).split("/");
    if (parts.slice(0, -1).some((_, i) => seen.has(parts.slice(0, i + 1).join("/")))) {
      issues.push(issue("path.collision", "目标平台上文件与目录路径冲突。", {category: "compatibility", location: safeLocation(file, entryIndex)}));
    }
  }
}

function textFile(file) {
  return new TextDecoder("utf-8", { fatal: true }).decode(file.buffer);
}

function yamlMetadata(text, limits) {
  const doc = parseDocument(text, { uniqueKeys: true, strict: true, version: "1.2", schema: "core" });
  if (doc.errors.length) throw new InputError(doc.errors.some(e => e.code === "DUPLICATE_KEY") ? "frontmatter.duplicate_key" : "frontmatter.invalid", "入口 frontmatter 语法无效或字段重复。");
  if (doc.warnings.length) throw new InputError("frontmatter.unsupported", "入口 frontmatter 含不支持的标签或语法。");
  // Bound AST traversal before materializing aliases. Never run custom YAML tags.
  let count = 0;
  const pending = [{node: doc.contents, depth: 0}];
  while (pending.length) {
    const {node, depth} = pending.pop();
    if (!node || typeof node !== "object") continue;
    if (++count > limits.maxNodes || depth > limits.maxDepth) throw new InputError("frontmatter.limit_exceeded", "入口 frontmatter 超过解析预算。", 413);
    if (node.items) for (const child of node.items) pending.push({node: child, depth: depth + 1});
    if (node.key) pending.push({node: node.key, depth: depth + 1});
    if (node.value && typeof node.value === "object") pending.push({node: node.value, depth: depth + 1});
  }
  const value = doc.toJS({ maxAliasCount: 10 });
  // A cycle/alias cannot create unlimited later traversal or hash work.
  const objects = new Set(); const values = [{value, depth: 0}]; count = 0;
  while (values.length) {
    const current = values.pop();
    if (++count > limits.maxNodes || current.depth > limits.maxDepth) throw new InputError("frontmatter.limit_exceeded", "入口 frontmatter 超过解析预算。", 413);
    if (current.value && typeof current.value === "object") {
      if (objects.has(current.value)) throw new InputError("frontmatter.alias_unsupported", "入口 frontmatter 含重复或循环引用，请展开后重试。");
      objects.add(current.value);
      for (const child of Object.values(current.value)) values.push({value: child, depth: current.depth + 1});
    }
  }
  return value;
}

function frontmatter(file, entryIndex, limits, issues) {
  const location = safeLocation(file, entryIndex);
  let data;
  try {
    const text = textFile(file).replace(/^\uFEFF/, "");
    const match = text.match(/^---[ \t]*(?:(yaml|json)[ \t]*)?\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) {
      issues.push(issue("frontmatter.missing", "入口须包含受支持的 YAML 或 JSON frontmatter。", {location}));
      return;
    }
    data = match[1] === "json" ? parseStrictJson(match[2], limits) : yamlMetadata(match[2], limits);
    if (!object(data)) throw new InputError("frontmatter.invalid", "入口 frontmatter 必须是字段对象。");
  } catch (error) {
    if (error instanceof InputError && error.status === 413) throw error;
    issues.push(issue(error instanceof InputError ? error.code : "frontmatter.invalid", "入口 frontmatter 无法安全解析，请检查语法、编码和预算。", {location}));
    return;
  }
  if (typeof data.name !== "string" || !data.name.trim()) issues.push(issue("metadata.name_invalid", "入口 name 必须是非空文本。", {location: {...location, field: "name"}}));
  else if (data.name !== data.name.trim()) issues.push(issue("metadata.name_whitespace", "入口 name 不能包含首尾空白。", {location: {...location, field: "name"}}));
  if (data.description === undefined || data.description === null || (typeof data.description === "string" && !data.description.trim())) {
    issues.push(issue("metadata.description_missing", "入口缺少 description；可生成草稿，但确认后才能写入发布副本。", {repairPolicy: "confirmation_required", location: {...location, field: "description"}}));
  } else if (typeof data.description !== "string") issues.push(issue("metadata.description_type", "入口 description 必须是文本，不能自动转换类型。", {location: {...location, field: "description"}}));
}

function inspectManifest(value, location, issues, limits) {
  if (!object(value)) { issues.push(issue("manifest.invalid", "发布 manifest 必须是对象。", {location})); return {}; }
  for (const field of ["name", "id", "displayName", "description"]) {
    if (Object.hasOwn(value, field) && (typeof value[field] !== "string" || !value[field].trim())) {
      issues.push(issue("manifest.field_invalid", "显式 manifest 文本字段不能为空或使用非文本类型。", {location: {...location, field}}));
    }
  }
  if (Object.hasOwn(value, "version") && (typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.version))) issues.push(issue("manifest.version_invalid", "显式版本必须使用受支持的 SemVer。", {location: {...location, field: "version"}}));
  if (value.entrypoints !== undefined && !object(value.entrypoints)) issues.push(issue("manifest.entrypoint_invalid", "entrypoints 必须是对象。", {location: {...location, field: "entrypoints"}}));
  const entry = value.entrypoints?.skillFile;
  if (entry !== undefined && value.skillFile !== undefined && entry !== value.skillFile) issues.push(issue("entrypoint.ambiguous", "同一来源的入口字段互相冲突。", {location}));
  for (const fieldValue of [entry, value.skillFile]) if (fieldValue !== undefined && !safePath(fieldValue, limits)) issues.push(issue("manifest.entrypoint_invalid", "入口必须是安全的非空相对路径文本。", {location}));
  if (value.runtime !== undefined && !object(value.runtime)) issues.push(issue("manifest.runtime_invalid", "runtime 必须是对象。", {location: {...location,field:"runtime"}}));
  for (const [field, platforms] of [["platforms",value.platforms],["runtime.platforms",value.runtime?.platforms]]) {
    if (platforms !== undefined && (!Array.isArray(platforms) || !platforms.length || platforms.some(p => !["windows","macos","linux"].includes(p)))) {
      issues.push(issue("manifest.platforms_invalid", "显式目标平台必须是受支持平台的非空列表。", {location:{...location,field}}));
    }
  }
  return value;
}

export function validatePublishRequest(rawJson, inputLimits = {}) {
  const limits = effectiveLimits(inputLimits);
  try {
    if (typeof rawJson !== "string") throw new InputError("body.invalid", "请求体必须是 JSON 文本。");
    // HTTP applies the same encoded transport cap before buffering.
    if (Buffer.byteLength(rawJson) > limits.maxRequestBytes) throw new InputError("body.too_large", "请求体超过上传限制。", 413);
    const body = parseStrictJson(rawJson, limits);
    if (!object(body) || Object.keys(body).some(k => !["source", "manifest", "form"].includes(k)) || (Object.hasOwn(body, "manifest") && Object.hasOwn(body, "form"))) throw new InputError("body.invalid", "请提供单一 source，且 manifest 与 form 不能同时出现。");
    const explicit = body.manifest ?? body.form ?? {};
    if (!object(explicit) || body.manifest === null || body.form === null) throw new InputError("manifest.invalid", "manifest/form 必须是对象。");
    // Validate finite numbers in every user parameter before canonicalization.
    canonical(explicit);
    const files = decodeSource(body, limits);
    const issues = [];
    if (!pathsValid(files, limits, issues)) return responseFor(issues, limits, null, "partial");
    const candidateHash = digest(canonical({ domain: "skillhub-publish-candidate-v1", manifest: explicit,
      files: [...files].sort((a,b) => byteOrder(a.path,b.path)).map(f => ({path:f.path,size:f.buffer.length,sha256:digest(f.buffer)})) }));
    let packaged = {};
    const manifestIndex = files.findIndex(f => f.path === "skill.json");
    if (manifestIndex !== -1) {
      const file = files[manifestIndex];
      try { packaged = inspectManifest(parseStrictJson(textFile(file), limits), safeLocation(file, manifestIndex), issues, limits); }
      catch (error) {
        if (error instanceof InputError && error.status === 413) throw error;
        issues.push(issue("manifest.invalid_json", "原始 skill.json 格式或编码无效，不能自动替换掩盖。", {location: safeLocation(file,manifestIndex)}));
      }
    }
    inspectManifest(explicit, {field: "manifest"}, issues, limits);
    const manifest = {...packaged, ...explicit};
    targetPlatforms(files, manifest, issues);
    const selectedEntry = explicit.entrypoints?.skillFile ?? explicit.skillFile ?? packaged.entrypoints?.skillFile ?? packaged.skillFile ?? "SKILL.md";
    const entryIndex = files.findIndex(f => f.path === selectedEntry);
    if (entryIndex < 0) {
      const candidates = files.filter(f => /(^|\/)SKILL\.md$/.test(f.path));
      issues.push(issue(candidates.length > 1 ? "entrypoint.ambiguous" : "entrypoint.missing", "未找到选定入口；请明确 Skill 根目录和入口文件。", {location: {field: "entrypoints.skillFile"}}));
    } else {
      frontmatter(files[entryIndex], entryIndex, limits, issues);
      if (selectedEntry !== "SKILL.md") issues.push(issue("compatibility.custom_entrypoint", "自定义入口不保证所有 Runtime 能发现，请核对目标运行环境。", {blocking:false, category:"compatibility", repairPolicy:"none", location:safeLocation(files[entryIndex],entryIndex)}));
    }
    return responseFor(issues, limits, candidateHash);
  } catch (error) {
    if (!(error instanceof InputError || error instanceof IntakeError)) throw error;
    if (error.status === 422) return responseFor([issue(error.code, error.message, {category:"package_safety", location: Number.isInteger(error.entryIndex) ? {entryIndex:error.entryIndex} : {}})], limits, null, "partial");
    return {status:error.status, body:{error:{code:error.code,message:error.message}}};
  }
}
