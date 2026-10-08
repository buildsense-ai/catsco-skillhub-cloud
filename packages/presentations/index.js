import { AuthError, ValidationError } from "../domain/index.js";

// Fits every field at its individual UTF-16 limit, including 3-byte CJK.
// The wire envelope also allows JSON Unicode escaping and target/reason fields.
export const PRESENTATION_CONTENT_MAX_BYTES = 80 * 1024;
export const PRESENTATION_REQUEST_MAX_BYTES = 176 * 1024;
export const PRESENTATION_CATEGORIES = Object.freeze([
  { id: "research", label: "搜索与研究" },
  { id: "documents", label: "文档与写作" },
  { id: "data", label: "数据与表格" },
  { id: "media", label: "图像与影音" },
  { id: "web", label: "网页与应用" },
  { id: "development", label: "编程与开发" },
  { id: "automation", label: "办公与自动化" },
  { id: "other", label: "其他 / 待分类" }
]);

function invalid(message) {
  throw new ValidationError(message, "presentation.invalid", 400);
}

function object(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Expected an object.");
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid("Unsupported presentation field.");
}

function text(value, max, required = true) {
  if (typeof value !== "string") invalid("Expected plain text.");
  const result = value.trim();
  if ((required && !result) || result.length > max || !result.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) {
    invalid("Presentation text is empty, too long or contains control characters.");
  }
  return result;
}

function list(value, max, parse) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) invalid("Too many presentation items.");
  return value.map(parse);
}

export function parsePresentationContent(value) {
  object(value, ["schemaVersion", "summary", "primaryCategory", "tags", "scenarios", "steps", "example", "requirements", "limitations", "details", "images"]);
  if (value.schemaVersion !== 1) invalid("Unsupported presentation schema.");
  if (!PRESENTATION_CATEGORIES.some(({ id }) => id === value.primaryCategory)) invalid("Unknown primary category.");
  const content = {
    schemaVersion: 1,
    summary: text(value.summary, 240),
    primaryCategory: value.primaryCategory,
    tags: [...new Set(list(value.tags, 5, (item) => text(item, 40)))],
    scenarios: list(value.scenarios, 3, (item) => {
      object(item, ["title", "description"]);
      return { title: text(item.title, 80), description: text(item.description, 400) };
    }),
    steps: list(value.steps, 6, (item) => text(item, 400)),
    requirements: list(value.requirements, 8, (item) => text(item, 300)),
    limitations: list(value.limitations, 8, (item) => text(item, 300)),
    details: value.details === undefined ? "" : text(value.details, 8000, false)
  };
  if (value.images !== undefined) {
    content.images = list(value.images, 6, (item) => {
      object(item, ["assetId", "alt", "caption"]);
      return { assetId: parsePresentationAssetId(item.assetId), alt: text(item.alt, 240),
        caption: item.caption === undefined ? "" : text(item.caption, 500, false) };
    });
    if (new Set(content.images.map((item) => item.assetId)).size !== content.images.length) invalid("Duplicate image references.");
  }
  if (value.example !== undefined) {
    object(value.example, ["kind", "input", "output"]);
    if (!["document", "image", "generic"].includes(value.example.kind)) invalid("Unknown example template.");
    content.example = {
      kind: value.example.kind,
      input: text(value.example.input, 2000),
      output: text(value.example.output, 2000)
    };
  }
  if (Buffer.byteLength(JSON.stringify(content), "utf8") > PRESENTATION_CONTENT_MAX_BYTES) invalid("Presentation is too large.");
  return content;
}

export function parsePresentationAssetId(value) {
  if (typeof value !== "string" || !/^pa_[a-f0-9]{32}$/.test(value)) invalid("Invalid image reference.");
  return value;
}

export function parsePresentationAssetWrite(value, upload = true) {
  object(value, ["skillId", "version", "reason", ...(upload ? ["dataBase64"] : [])]);
  return { ...parsePresentationTarget(value), reason: value.reason === undefined ? "" : text(value.reason, 500, false) };
}

export function parsePresentationTarget(value) {
  const skillId = text(value.skillId, 240);
  const version = text(value.version, 100);
  // Public IDs only. No private bot references or arbitrary path segments.
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(skillId)
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    invalid("Invalid public Skill reference.");
  }
  return { skillId, version };
}

export function parsePresentationWrite(value, action) {
  object(value, ["skillId", "version", "expectedRevision", "reason", ...(action === "draft" ? ["content"] : [])]);
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 || value.expectedRevision >= 2147483647) {
    invalid("expectedRevision must be a nonnegative revision.");
  }
  return {
    ...parsePresentationTarget(value),
    expectedRevision: value.expectedRevision,
    reason: value.reason === undefined ? "" : text(value.reason, 500, false),
    ...(action === "draft" ? { content: parsePresentationContent(value.content) } : {})
  };
}

export function assertPresentationEditor(actor, ownerUserId, reason, writing = false) {
  if (!actor?.userId || !["user", "developer", "reviewer", "admin"].includes(actor.role)) {
    throw new AuthError("Human publisher login required.", 401);
  }
  const admin = actor.roles?.includes("admin") === true;
  if (actor.userId !== ownerUserId && !admin) {
    throw new ValidationError("Skill presentation not found.", "presentation.not_found", 404);
  }
  if (admin && actor.userId !== ownerUserId && writing && !reason?.trim()) {
    invalid("An administrator edit requires a reason.");
  }
}

// All strings are inert plain text. Consumers MUST escape them; do not use an
// HTML/Markdown renderer with raw HTML enabled. Examples are never test proof.
export function publicPresentation(row) {
  if (!row?.published_content) return null;
  return {
    schemaVersion: 1,
    skillId: row.skill_id,
    version: row.version,
    sourceContentHash: row.content_hash || null,
    revision: row.published_revision,
    content: row.published_content,
    exampleDisclosure: "illustrative_not_tested",
    origin: row.published_origin,
    publishedAt: new Date(row.published_at).toISOString()
  };
}
