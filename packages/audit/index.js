import { generateId, nowIso } from "../domain/index.js";

export async function appendAudit(store, { actor, action, resourceType, resourceId, metadata = {}, ip = "" }) {
  const entry = {
    id: generateId("audit"),
    actorId: actor?.userId ?? actor?.id ?? "system",
    actorRole: actor?.role ?? "system",
    action,
    resourceType,
    resourceId,
    metadata: redact(metadata),
    ip,
    createdAt: nowIso()
  };
  await store.appendAudit(entry);
  return entry;
}

export function redact(value) {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (/authorization|cookie|token|secret|password|private/i.test(key)) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redact(item);
      }
    }
    return result;
  }
  return value;
}

export function redactString(text) {
  return String(text)
    .replace(/(sk-[A-Za-z0-9_-]{12})[A-Za-z0-9_-]+/g, "$1...[REDACTED]")
    .replace(/([A-Za-z0-9_]{8})[A-Za-z0-9_\-]{16,}([A-Za-z0-9_]{4})/g, "$1...[REDACTED]...$2")
    .slice(0, 2000);
}
