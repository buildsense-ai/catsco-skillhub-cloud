import { getActorFromRequest } from "../../packages/auth/index.js";
import { AuthError, ValidationError } from "../../packages/domain/index.js";
import {
  PRESENTATION_CATEGORIES, PRESENTATION_MAX_BYTES, parsePresentationTarget, parsePresentationWrite
} from "../../packages/presentations/index.js";
import { searchPublishedSkillsPage } from "../../packages/search/index.js";

export async function handlePresentationRequest({ config, store, req, res, url, pathname, readJson, sendJson }) {
  if (!pathname.startsWith("/api/skill-presentations") && !pathname.startsWith("/api/catalogue/")) return false;
  if (!config.presentations?.readEnabled) {
    throw new ValidationError("Skill presentations are not enabled.", "presentation.disabled", 503);
  }
  if (pathname === "/api/catalogue/categories" && req.method === "GET") {
    sendJson(res, 200, { schemaVersion: 1, categories: PRESENTATION_CATEGORIES });
    return true;
  }
  if (pathname === "/api/catalogue/skills" && req.method === "GET") {
    const rawLimit = url.searchParams.get("limit");
    if (rawLimit !== null && !/^[1-9][0-9]{0,2}$/.test(rawLimit)) {
      throw new ValidationError("Catalogue limit must be an integer between 1 and 100.", "catalogue.limit_invalid", 400);
    }
    const result = searchPublishedSkillsPage(await store.listCatalogueVersions(), url.searchParams.get("q") || "", {
      category: url.searchParams.get("category") || "",
      platform: url.searchParams.get("platform") || "",
      agentVersion: url.searchParams.get("agent_version") || "",
      searchMode: url.searchParams.get("search_mode") || "",
      ...(rawLimit !== null ? { limit: Number(rawLimit) } : {}),
      ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") } : {})
    });
    sendJson(res, 200, result);
    return true;
  }
  if (req.method === "GET" && ["/api/skill-presentations", "/api/skill-presentations/draft"].includes(pathname)) {
    const draft = pathname.endsWith("/draft");
    const actor = draft ? await humanActor(config, store, req) : undefined;
    const target = parsePresentationTarget({ skillId: url.searchParams.get("skillId"), version: url.searchParams.get("version") });
    const presentation = await store.getSkillPresentation({ ...target, draft, actor });
    sendJson(res, 200, { presentation }, { "Cache-Control": "private, no-store" });
    return true;
  }
  const action = pathname === "/api/skill-presentations/draft" && req.method === "PUT" ? "draft"
    : pathname === "/api/skill-presentations/publish" && req.method === "POST" ? "publish"
      : pathname === "/api/skill-presentations/unpublish" && req.method === "POST" ? "unpublish" : null;
  if (action) {
    if (!config.presentations.writeEnabled) {
      throw new ValidationError("Presentation editing is disabled.", "presentation.writes_disabled", 503);
    }
    assertJsonOrigin(config, req);
    const actor = await humanActor(config, store, req);
    const input = await readJson(req, PRESENTATION_MAX_BYTES);
    parsePresentationWrite(input, action);
    const presentation = await store.writeSkillPresentation(input, actor, action, req.socket.remoteAddress || "");
    sendJson(res, 200, { presentation }, { "Cache-Control": "private, no-store" });
    return true;
  }
  throw new ValidationError("Presentation route not found.", "presentation.route_not_found", 404);
}

async function humanActor(config, store, req) {
  const actor = await getActorFromRequest(config, store, req, { allowAgent: false });
  if (!actor.userId || !["user", "developer", "reviewer", "admin"].includes(actor.role)) {
    throw new AuthError("Human publisher login required.", 401);
  }
  return actor;
}

function assertJsonOrigin(config, req) {
  if (String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new ValidationError("Content-Type must be application/json.", "presentation.content_type", 415);
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const allowed = new Set([new URL(config.publicBaseUrl).origin, ...config.allowedOrigins]);
    if (typeof origin !== "string" || !allowed.has(origin)) throw new AuthError("Origin not allowed.", 403);
  }
}
