import crypto from "node:crypto";
import { AuthError, Role, ValidationError } from "../domain/index.js";

export const permissionsByRole = {
  [Role.PUBLIC]: ["skill.search", "skill.read", "trust.read"],
  [Role.AGENT]: ["skill.search", "skill.read", "skill.download", "trust.read"],
  user: ["skill.search", "skill.read", "skill.download", "developer_application.create", "developer_application.read_own"],
  developer: ["submission.create", "submission.read_own", "manifest.create"],
  reviewer: ["submission.review_queue", "submission.approve", "submission.reject", "submission.request_changes", "scan.read"],
  admin: [
    "user.manage",
    "role.grant",
    "role.revoke",
    "developer_application.review",
    "package.yank",
    "audit.read",
    "system.manage"
  ]
};

export function hashPassword(password) {
  const normalized = String(password ?? "");
  if (normalized.length < 10) {
    throw new ValidationError("密码至少需要 10 个字符", "password.too_short");
  }
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(normalized, salt, 64).toString("base64url");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, storedHash) {
  const [scheme, salt, expected] = String(storedHash ?? "").split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const actual = crypto.scryptSync(String(password ?? ""), salt, 64).toString("base64url");
  return safeEqual(actual, expected);
}

export function createSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashSessionToken(token, secret = "") {
  return crypto.createHmac("sha256", String(secret)).update(String(token)).digest("hex");
}

export function parseCookies(req) {
  const header = req.headers.cookie ?? "";
  const result = {};
  for (const item of header.split(";")) {
    const index = item.indexOf("=");
    if (index === -1) continue;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    result[key] = decodeURIComponent(value);
  }
  return result;
}

export function buildSessionCookie(config, token, { clear = false } = {}) {
  const parts = [
    `${config.session.cookieName}=${clear ? "" : encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax"
  ];
  if (config.session.cookieSecure) parts.push("Secure");
  if (config.session.cookieDomain) parts.push(`Domain=${config.session.cookieDomain}`);
  if (clear) parts.push("Max-Age=0");
  else parts.push(`Max-Age=${config.session.ttlDays * 24 * 60 * 60}`);
  return parts.join("; ");
}

export function permissionsForRoles(roles = []) {
  const allRoles = new Set(roles);
  if (!allRoles.has(Role.PUBLIC) && !allRoles.has(Role.AGENT) && !allRoles.has(Role.SYSTEM)) {
    allRoles.add("user");
  }
  if (allRoles.has("admin")) {
    for (const role of ["developer", "reviewer"]) allRoles.add(role);
  }
  const permissions = new Set();
  for (const role of allRoles) {
    for (const permission of permissionsByRole[role] ?? []) permissions.add(permission);
  }
  return [...permissions].sort();
}

export function makeActor({ user, roles = [], developerProfile = null }) {
  return {
    id: user.id,
    userId: user.id,
    email: user.email,
    name: user.displayName,
    role: roles.includes("admin") ? "admin" : roles.includes("reviewer") ? "reviewer" : roles.includes("developer") ? "developer" : "user",
    roles: [...new Set(["user", ...roles])],
    permissions: permissionsForRoles(roles),
    developerProfile
  };
}

export async function getActorFromRequest(config, store, req, { allowPublic = false, allowAgent = false } = {}) {
  const agent = getAgentActor(config, req);
  if (agent && allowAgent) return agent;

  const cookies = parseCookies(req);
  const token = cookies[config.session.cookieName];
  if (!token) {
    if (allowPublic) return publicActor();
    throw new AuthError("请先登录", 401);
  }
  const session = await store.getSessionByTokenHash(hashSessionToken(token, config.session.secret));
  if (!session) {
    if (allowPublic) return publicActor();
    throw new AuthError("登录状态已失效，请重新登录", 401);
  }
  const user = await store.getUserById(session.userId);
  const roles = await store.getRoles(session.userId);
  const developerProfile = await store.getDeveloperProfile(session.userId);
  return makeActor({ user, roles, developerProfile });
}

export function publicActor() {
  return {
    id: "public",
    userId: null,
    email: "",
    name: "Public",
    role: Role.PUBLIC,
    roles: [Role.PUBLIC],
    permissions: permissionsForRoles([Role.PUBLIC])
  };
}

export function getAgentActor(config, req) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token || !config.agent.clientSecret || !safeEqual(token, config.agent.clientSecret)) return null;
  return {
    id: "agent",
    userId: null,
    email: "",
    name: "CatsCo Agent",
    role: Role.AGENT,
    roles: [Role.AGENT],
    permissions: permissionsForRoles([Role.AGENT])
  };
}

export function requirePermission(actor, permission) {
  if (!actor.permissions?.includes(permission) && !actor.permissions?.includes("system.manage")) {
    throw new AuthError("权限不足", 403);
  }
}

export function requireAnyPermission(actor, permissions) {
  if (permissions.some((permission) => actor.permissions?.includes(permission)) || actor.permissions?.includes("system.manage")) return;
  throw new AuthError("权限不足", 403);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export class RateLimiter {
  constructor({ windowMs = 60_000, limit = 120, maxBuckets = 20_000 } = {}) {
    this.windowMs = windowMs;
    this.limit = limit;
    this.maxBuckets = maxBuckets;
    this.buckets = new Map();
    this.lastSweepAt = 0;
  }

  check(key) {
    const now = Date.now();
    if (now - this.lastSweepAt >= this.windowMs || this.buckets.size >= this.maxBuckets) {
      this.sweep(now);
    }
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (this.buckets.size >= this.maxBuckets) return false;
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= this.limit;
  }

  sweep(now = Date.now()) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    this.lastSweepAt = now;
  }
}
