import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { appendAudit } from "../../packages/audit/index.js";
import {
  buildSessionCookie,
  createSessionToken,
  getActorFromRequest,
  hashPassword,
  hashSessionToken,
  makeActor,
  parseCookies,
  RateLimiter,
  requireAnyPermission,
  requirePermission,
  verifyPassword
} from "../../packages/auth/index.js";
import { authenticateCatsCoBot } from "../../packages/bot-auth/index.js";
import { loadConfig } from "../../packages/config/index.js";
import { createStore, ensureRuntimeDirectories } from "../../packages/database/store.js";
import { AuthError, compareSemver, generateId, hasBlockingFindings, nowIso, sha256, slugify, SubmissionStatus, ValidationError } from "../../packages/domain/index.js";
import { assertGitVersion, commitGitVersion } from "../../packages/git-storage/index.js";
import { saveSubmissionFiles, safeJoin } from "../../packages/object-storage/index.js";
import { computeSkillContentHash } from "../../packages/packager/index.js";
import { mutationVersionReference, parsePrivateSkillMutation } from "../../packages/private-mutations/index.js";
import {
  buildPrivatePackage,
  isPrivateSkillReference,
  opaquePrivateReference,
  parsePrivateSkillUpsert,
  privatePackageMetadata,
  publicVersionAsDownloadedPackage,
  readPrivatePackage,
  writePrivatePackageAtomic
} from "../../packages/private-skills/index.js";
import { processJobs } from "../../packages/queue/index.js";
import { buildManifestDraft, filesFromSubmissionBody } from "../../packages/scanner/index.js";
import { searchPublishedSkills, toRegistryEntry } from "../../packages/search/index.js";
import {
  ensureSigningKey,
  fingerprintPublicKeyPem,
  listActiveSigningKeyCertificates,
  loadSigningKeyCertificate,
  readRootPublicKey
} from "../../packages/signing/index.js";
import { createExaWebAnswerService } from "../../packages/web-answer/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const adminIndexPath = path.resolve(here, "../admin/public/index-v2.html");

export function createApiServer(config = loadConfig(), dependencies = {}) {
  const store = dependencies.store ?? createStore(config);
  const limiter = new RateLimiter({ windowMs: 60_000, limit: 600, maxBuckets: 20_000 });
  const botWriteLimiter = new RateLimiter({ windowMs: 60_000, limit: 30, maxBuckets: 20_000 });
  const botReadLimiter = new RateLimiter({ windowMs: 60_000, limit: 600, maxBuckets: 20_000 });
  const botHistoryLimiter = new RateLimiter({ windowMs: 60_000, limit: 120, maxBuckets: 20_000 });
  let activePrivateUploads = 0;
  const exaWebAnswer = createExaWebAnswerService();

  return http.createServer(async (req, res) => {
    res.setHeader("X-Request-Id", randomId());
    applyCors(config, req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const ip = getIp(req);
    if (!limiter.check(ip)) {
      sendJson(res, 429, { error: { code: "rate_limited", message: "请求过于频繁" } });
      return;
    }

    try {
      const url = new URL(req.url ?? "/", config.publicBaseUrl);
      const pathname = decodeURIComponent(url.pathname);

      if (await exaWebAnswer.handleHttp(req, res, pathname)) return;

      if (req.method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, { ok: true, service: "catsco-skillhub-api", time: nowIso() });
        return;
      }

      if (req.method === "GET" && pathname === "/readyz") {
        await ensureRuntimeDirectories(config);
        const stats = await store.healthStats();
        let privateSkills;
        if (config.privateSkills.readEnabled || config.privateSkills.historyEnabled || config.privateSkills.writeEnabled || config.mutationWriter?.enabled) {
          privateSkills = await store.privateSkillReadiness();
          await fsp.access(config.paths.private, fs.constants.R_OK | fs.constants.W_OK);
          if (!privateSkills.ready) {
            throw new ValidationError(
              "Private Bot Skill storage is not ready.",
              "PRIVATE_SKILL_NOT_READY",
              503
            );
          }
        }
        sendJson(res, 200, { ok: true, ...stats, ...(privateSkills ? { privateSkills } : {}) });
        return;
      }

      if (req.method === "GET" && pathname === "/admin") {
        res.writeHead(302, { Location: "/admin/" });
        res.end();
        return;
      }

      if (req.method === "GET" && pathname === "/admin/") {
        await serveStaticFile(res, adminIndexPath, "text/html; charset=utf-8");
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/packages/")) {
        await servePackagePath(config, res, pathname);
        return;
      }

      if (pathname === "/api/internal/bot/private-skill-versions" && req.method === "PUT") {
        if (!config.mutationWriter?.enabled || !config.mutationWriter?.secret) {
          throw new ValidationError(
            "Private mutation writes are disabled.",
            "MUTATION_WRITES_DISABLED",
            503
          );
        }
        authenticateMutationWriter(config, req);
        const body = await readJson(req, config.mutationWriter.maxRequestBytes);
        const input = parsePrivateSkillMutation(body, config);
        const authority = normalizeAuthority(config.botAuth.catsCoBaseUrl);
        const ownerBotId = input.botUid;
        const createdAt = nowIso();
        const versionInput = {
          mutationRecordId: generateId("mutation"),
          privateSkillId: opaquePrivateReference("ps", 16),
          skillId: opaquePrivateReference("priv", 20),
          privateVersionId: opaquePrivateReference("pv", 16),
          version: opaquePrivateReference("v", 24),
          createdAt,
          leaseExpiresAt: new Date(Date.parse(createdAt) + 15 * 60 * 1000).toISOString()
        };
        const reservation = await store.reservePrivateSkillMutation({
          envelope: {
            ...input,
            authority,
            ownerBotId,
            maxVersionsPerBot: config.privateSkills.maxVersionsPerBot,
            maxBytesPerBot: config.privateSkills.maxBytesPerBot
          },
          versionInput
        });
        if (!reservation.version) {
          throw new ValidationError(
            "The private Skill mutation reservation is unavailable.",
            "MUTATION_DEPENDENCY_UNAVAILABLE",
            503
          );
        }
        if (reservation.mutation.status === "active" && reservation.version.status === "active") {
          sendJson(res, 200, privateMutationFacts(input, reservation.version, true));
          return;
        }
        if (reservation.version.status === "rejected") {
          throw new ValidationError(
            "The private Skill mutation was rejected.",
            reservation.version.failureCode || "MUTATION_WRITE_REJECTED",
            422
          );
        }
        const sourceVersion = await commitGitVersion({
          config,
          scope: "private",
          skillId: reservation.version.skillId,
          version: reservation.version.version,
          files: input.input.files,
          createdAt: reservation.version.createdAt,
          metadata: {
            authority,
            ownerBotId,
            localSkillId: input.localSkillId,
            mutationId: input.mutationId,
            grantId: input.grantId,
            actorUserUid: input.actorUserUid,
            operation: input.operation,
            contentHash: input.candidateContentHash
          }
        });
        let stored;
        try {
          const packageValue = buildPrivatePackage({
            reservation: reservation.version,
            input: input.input,
            sourceVersion
          });
          stored = await writePrivatePackageAtomic(config, packageValue);
          const activated = await store.activatePrivateSkillMutation({
            authority,
            ownerBotId,
            mutationId: input.mutationId,
            activation: {
              packagePath: stored.packagePath,
              packageSha256: stored.packageSha256,
              packageBytes: stored.packageBytes,
              storageBackend: "git-v1",
              gitRepositoryId: sourceVersion.repositoryId,
              gitCommitSha: sourceVersion.commitSha,
              gitTreeSha: sourceVersion.treeSha,
              gitTag: sourceVersion.tag,
              artifactSha256: stored.packageSha256
            }
          });
          if (!activated) {
            throw new ValidationError(
              "Private Skill mutation activation is unavailable.",
              "MUTATION_ACTIVATION_RETRYABLE",
              503
            );
          }
          await appendAudit(store, {
            actor: { id: "catsco-mutation-writer", role: "service", userId: null },
            action: reservation.created ? "private_skill.mutation_created" : "private_skill.mutation_replayed",
            resourceType: "privateSkillMutation",
            resourceId: `${authority}/${ownerBotId}/${input.mutationId}`,
            metadata: {
              mutationId: input.mutationId,
              grantId: input.grantId,
              botId: ownerBotId,
              actorUserUid: input.actorUserUid,
              sourceTopicId: input.sourceTopicId,
              sourceMessageId: input.sourceMessageId,
              runtimeBodyId: input.runtimeBodyId,
              localSkillId: input.localSkillId,
              operation: input.operation,
              contentHash: input.candidateContentHash,
              gitCommitSha: sourceVersion.commitSha
            },
            ip
          });
          sendJson(res, reservation.created ? 201 : 200, privateMutationFacts(input, activated.version, !reservation.created));
          return;
        } catch (error) {
          // Keep the durable mutation pending for retry. C1 treats a lost
          // response as uncertain because Git/artifact may already exist.
          if (stored && error?.code === "MUTATION_IMMUTABLE_CONFLICT") {
            await store.rejectPrivateSkillMutation({
              authority,
              ownerBotId,
              mutationId: input.mutationId,
              failureCode: error.code
            }).catch(() => {});
          }
          throw error;
        }
      }

      if (pathname === "/api/bot/private-skill-packages" && req.method === "PUT") {
        if (!config.privateSkills.writeEnabled) {
          throw new ValidationError("Private Skill uploads are disabled.", "PRIVATE_SKILL_WRITES_DISABLED", 503);
        }
        const identity = await authenticateCatsCoBot(config, req);
        requireAllowedPrivateSkillBot(config, identity.botId);
        if (activePrivateUploads >= config.privateSkills.maxConcurrentUploads) {
          sendJson(res, 503, {
            error: {
              code: "PRIVATE_SKILL_UPLOAD_BUSY",
              message: "Private Skill upload capacity is busy."
            }
          }, { "Retry-After": "5" });
          return;
        }
        activePrivateUploads += 1;
        let uploadReleased = false;
        const releaseUpload = () => {
          if (uploadReleased) return;
          uploadReleased = true;
          activePrivateUploads = Math.max(0, activePrivateUploads - 1);
        };
        res.once("finish", releaseUpload);
        res.once("close", releaseUpload);
        if (!botWriteLimiter.check(`${identity.authority}\0${identity.botId}`)) {
          sendJson(res, 429, { error: { code: "PRIVATE_SKILL_RATE_LIMITED", message: "Too many private Skill uploads." } }, {
            "Retry-After": "60"
          });
          return;
        }
        const body = await readJson(req, config.privateSkills.maxRequestBytes);
        const input = parsePrivateSkillUpsert(body, config);
        if (input.origin && isPrivateSkillReference(input.origin.skillId)) {
          const ownedOrigin = await store.findPrivateSkillVersion({
            authority: identity.authority,
            ownerBotId: identity.botId,
            skillId: input.origin.skillId,
            version: input.origin.version
          });
          if (!ownedOrigin) {
            throw new ValidationError(
              "Private Skill origin is unavailable to this Bot.",
              "PRIVATE_SKILL_ORIGIN_NOT_FOUND",
              400
            );
          }
        }
        // Non-private origins are untrusted provenance metadata. They can
        // outlive a rebuilt public Registry and must never authorize reads.
        const createdAt = nowIso();
        const reservation = await store.reservePrivateSkillVersion({
          authority: identity.authority,
          ownerBotId: identity.botId,
          localSkillId: input.localSkillId,
          name: input.name,
          contentHash: input.contentHash,
          origin: input.origin,
          fileCount: input.files.length,
          totalBytes: input.totalBytes,
          privateSkillId: opaquePrivateReference("ps", 16),
          skillId: opaquePrivateReference("priv", 20),
          privateVersionId: opaquePrivateReference("pv", 16),
          version: opaquePrivateReference("v", 24),
          createdAt,
          leaseExpiresAt: new Date(Date.parse(createdAt) + 15 * 60 * 1000).toISOString(),
          maxVersionsPerBot: config.privateSkills.maxVersionsPerBot,
          maxBytesPerBot: config.privateSkills.maxBytesPerBot
        });
        const reserved = reservation.version;
        if (reserved.name !== input.name || !referencesEqual(reserved.origin, input.origin)) {
          throw new ValidationError(
            "The idempotent private Skill version has different metadata.",
            "PRIVATE_SKILL_IDEMPOTENCY_CONFLICT",
            409
          );
        }
        if (reserved.status === "rejected") {
          throw new ValidationError(
            "The private Skill package was rejected.",
            reserved.failureCode || "PRIVATE_SKILL_REJECTED",
            422
          );
        }
        if (reserved.status === "active") {
          const stored = await readPrivatePackage(reserved, config);
          sendJson(res, 200, privatePackageMetadata(stored));
          return;
        }
        const sourceVersion = await commitGitVersion({
          config,
          scope: "private",
          skillId: reserved.skillId,
          version: reserved.version,
          files: input.files,
          createdAt: reserved.createdAt,
          metadata: {
            authority: identity.authority,
            ownerBotId: identity.botId,
            localSkillId: input.localSkillId,
            contentHash: input.contentHash
          }
        });
        const packageValue = buildPrivatePackage({ reservation: reserved, input, sourceVersion });
        let stored;
        let activated;
        try {
          stored = await writePrivatePackageAtomic(config, packageValue);
          activated = await store.activatePrivateSkillVersion({
            id: reserved.id,
            packagePath: stored.packagePath,
            packageSha256: stored.packageSha256,
            packageBytes: stored.packageBytes,
            storageBackend: "git-v1",
            gitRepositoryId: sourceVersion.repositoryId,
            gitCommitSha: sourceVersion.commitSha,
            gitTreeSha: sourceVersion.treeSha,
            gitTag: sourceVersion.tag,
            artifactSha256: stored.packageSha256
          });
          if (!activated) {
            throw new ValidationError(
              "Private Skill package could not be activated.",
              "PRIVATE_SKILL_ACTIVATION_FAILED",
              503
            );
          }
        } catch (error) {
          const failureCode = error?.code === "PRIVATE_SKILL_IMMUTABLE_CONFLICT"
            ? error.code
            : stored
              ? "PRIVATE_SKILL_ACTIVATION_RETRYABLE"
              : "PRIVATE_SKILL_WRITE_RETRYABLE";
          await store.rejectPrivateSkillVersion({ id: reserved.id, failureCode }).catch(() => {});
          throw error;
        }
        await appendAudit(store, {
          actor: identity.actor,
          action: reservation.created ? "private_skill.created" : "private_skill.recovered",
          resourceType: "privateSkillVersion",
          resourceId: `${activated.skillId}@${activated.version}`,
          metadata: {
            botId: identity.botId,
            fileCount: activated.fileCount,
            totalBytes: activated.totalBytes
          },
          ip
        });
        sendJson(res, reservation.created ? 201 : 200, privatePackageMetadata(packageValue));
        return;
      }

      if (pathname === "/api/bot/private-skill-metadata" && req.method === "POST") {
        if (!config.privateSkills.readEnabled) {
          throw new ValidationError("Private Skill metadata is unavailable.", "PRIVATE_SKILL_READS_DISABLED", 503);
        }
        const identity = await authenticateCatsCoBot(config, req);
        requireAllowedPrivateSkillBot(config, identity.botId);
        if (!botReadLimiter.check(`${identity.authority}\0${identity.botId}`)) {
          sendJson(res, 429, {
            error: {
              code: "PRIVATE_SKILL_READ_RATE_LIMITED",
              message: "Too many private Skill metadata requests."
            }
          }, { "Retry-After": "60" });
          return;
        }
        const references = parsePrivateSkillMetadataRequest(
          await readJson(req, PRIVATE_SKILL_METADATA_MAX_REQUEST_BYTES)
        );
        const versions = await store.findPrivateSkillMetadata({
          authority: identity.authority,
          ownerBotId: identity.botId,
          references
        });
        sendJson(res, 200, {
          skills: versions.map((version) => ({
            source: "skillhub",
            skillId: version.skillId,
            version: version.version,
            displayName: version.name,
            revisionNumber: version.revisionNumber,
            changeSource: version.hasConversationMutation ? "conversation_mutation" : "runtime_backup",
            lastChangedAt: version.lastChangedAt || version.activatedAt || version.createdAt
          }))
        }, { "Cache-Control": "private, no-store" });
        return;
      }

      if (pathname === "/api/bot/private-skill-history" && req.method === "POST") {
        if (!config.privateSkills.historyEnabled) {
          throw new ValidationError("Private Skill history is unavailable.", "PRIVATE_SKILL_HISTORY_DISABLED", 503);
        }
        const identity = await authenticateCatsCoBot(config, req);
        requireAllowedPrivateSkillBot(config, identity.botId);
        if (!botHistoryLimiter.check(`${identity.authority}\0${identity.botId}`)) {
          sendJson(res, 429, {
            error: {
              code: "PRIVATE_SKILL_HISTORY_RATE_LIMITED",
              message: "Too many private Skill history requests."
            }
          }, { "Retry-After": "60" });
          return;
        }
        const input = parsePrivateSkillHistoryRequest(
          await readJson(req, PRIVATE_SKILL_HISTORY_MAX_REQUEST_BYTES)
        );
        const history = await store.listPrivateSkillHistory({
          authority: identity.authority,
          ownerBotId: identity.botId,
          ...input
        });
        sendJson(res, 200, {
          skillId: input.skillId,
          versions: history.versions.map((version) => ({
            source: "skillhub",
            skillId: version.skillId,
            version: version.version,
            displayName: version.name,
            revisionNumber: version.revisionNumber,
            changeSource: version.hasConversationMutation ? "conversation_mutation" : "runtime_backup",
            lastChangedAt: version.lastChangedAt || version.activatedAt || version.createdAt
          })),
          nextBeforeRevisionNumber: history.nextBeforeRevisionNumber
        }, { "Cache-Control": "private, no-store" });
        return;
      }

      const botPackageMatch = pathname.match(/^\/api\/bot\/skill-packages\/(.+)\/versions\/([^/]+)$/);
      if (botPackageMatch && req.method === "GET") {
        if (!config.privateSkills.readEnabled) {
          throw new ValidationError("Skill package was not found.", "SKILL_PACKAGE_NOT_FOUND", 404);
        }
        const identity = await authenticateCatsCoBot(config, req);
        requireAllowedPrivateSkillBot(config, identity.botId);
        if (!botReadLimiter.check(`${identity.authority}\0${identity.botId}`)) {
          sendJson(res, 429, {
            error: {
              code: "PRIVATE_SKILL_READ_RATE_LIMITED",
              message: "Too many private Skill downloads."
            }
          }, { "Retry-After": "60" });
          return;
        }
        const skillId = requireReferencePart(botPackageMatch[1], "skillId", 240);
        const version = requireReferencePart(botPackageMatch[2], "version", 120);
        const privateVersion = await store.findPrivateSkillVersion({
          authority: identity.authority,
          ownerBotId: identity.botId,
          skillId,
          version
        });
        if (privateVersion) {
          await assertStoredGitVersion(config, privateVersion, "private");
          const stored = await readPrivatePackage(privateVersion, config);
          await appendAudit(store, {
            actor: identity.actor,
            action: "private_skill.downloaded",
            resourceType: "privateSkillVersion",
            resourceId: `${skillId}@${version}`,
            metadata: { botId: identity.botId },
            ip
          });
          sendJson(res, 200, stored, { "Cache-Control": "private, no-store" });
          return;
        }
        if (skillId.startsWith("priv_")) {
          throw new ValidationError("Skill package was not found.", "PRIVATE_SKILL_NOT_FOUND", 404);
        }
        const published = await store.findRecoverablePublishedVersion(skillId, version);
        if (!published) {
          throw new ValidationError("Skill package was not found.", "SKILL_PACKAGE_NOT_FOUND", 404);
        }
        await assertStoredGitVersion(config, published, "public");
        const downloaded = await publicVersionAsDownloadedPackage(published, config);
        sendJson(res, 200, downloaded, { "Cache-Control": "private, no-store" });
        return;
      }

      if (pathname === "/api/auth/register" && req.method === "POST") {
        const body = await readJson(req, 128 * 1024);
        const user = await store.createUser({
          email: requireEmail(body.email),
          passwordHash: hashPassword(body.password),
          displayName: requireText(body.displayName || body.email, "displayName", 2, 80)
        });
        const session = await createLoginSession({ config, store, user, req, res });
        await appendAudit(store, { actor: { userId: user.id, role: "user" }, action: "auth.register", resourceType: "user", resourceId: user.id, ip });
        sendJson(res, 201, { user: publicUser(user), roles: ["user"], permissions: session.actor.permissions });
        return;
      }

      if (pathname === "/api/auth/login" && req.method === "POST") {
        const body = await readJson(req, 128 * 1024);
        const user = await store.getUserByEmail(requireEmail(body.email));
        if (!user || !verifyPassword(body.password, user.passwordHash)) {
          throw new AuthError("邮箱或密码错误", 401);
        }
        const session = await createLoginSession({ config, store, user, req, res });
        await appendAudit(store, { actor: session.actor, action: "auth.login", resourceType: "user", resourceId: user.id, ip });
        sendJson(res, 200, {
          user: publicUser(user),
          roles: session.actor.roles,
          permissions: session.actor.permissions,
          developerProfile: session.actor.developerProfile
        });
        return;
      }

      if (pathname === "/api/auth/catsco-exchange" && req.method === "POST") {
        const body = await readJson(req, 128 * 1024);
        const catsBaseUrl = normalizeHttpBaseUrl(body.baseUrl || body.httpBaseUrl || "https://app.catsco.cc");
        const catsToken = String(body.token || "").trim();
        if (!catsToken) throw new AuthError("CatsCo token missing", 401);
        const catsUser = await verifyCatsCoToken(catsBaseUrl, catsToken);
        const hintUser = body.user || {};
        const uid = String(catsUser.uid || catsUser.id || hintUser.uid || "").trim();
        if (!uid) throw new AuthError("CatsCo user uid missing", 401);
        const username = String(catsUser.username || hintUser.username || `catsco_${uid}`).trim();
        const displayName = String(catsUser.display_name || catsUser.displayName || hintUser.displayName || username).trim();
        const namespace = slugify(username, `catsco-${uid}`);
        const syntheticEmail = `catsco-${slugify(uid, "user")}@catsco.local`;
        const existingProfile = typeof store.getDeveloperProfileByNamespace === "function"
          ? await store.getDeveloperProfileByNamespace(namespace)
          : null;
        let user = existingProfile ? await store.getUserById(existingProfile.userId) : null;
        if (!user) user = await store.getUserByEmail(syntheticEmail);
        if (!user) {
          user = await store.createUser({
            email: syntheticEmail,
            passwordHash: hashPassword(`${createSessionToken()}:${uid}`),
            displayName
          });
        }
        if (!existingProfile || existingProfile.userId === user.id) {
          await store.ensureDeveloperProfile({
            userId: user.id,
            namespace,
            displayName,
            contact: `catsco:${uid}`,
            approvedBy: "catsco"
          });
        } else {
          await store.grantRole({ userId: user.id, role: "developer", grantedBy: "catsco" });
        }
        const session = await createLoginSession({ config, store, user, req, res });
        await appendAudit(store, {
          actor: session.actor,
          action: "auth.catsco_exchange",
          resourceType: "user",
          resourceId: user.id,
          metadata: { catsUid: uid, catsUsername: username },
          ip
        });
        sendJson(res, 200, {
          user: publicUser(user),
          roles: session.actor.roles,
          permissions: session.actor.permissions,
          developerProfile: session.actor.developerProfile,
          catsCo: {
            uid,
            username,
            displayName
          }
        });
        return;
      }

      if (pathname === "/api/auth/logout" && req.method === "POST") {
        const cookies = parseCookies(req);
        const token = cookies[config.session.cookieName];
        if (token) await store.revokeSession(hashSessionToken(token, config.session.secret));
        res.setHeader("Set-Cookie", buildSessionCookie(config, "", { clear: true }));
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === "/api/auth/me" && req.method === "GET") {
        const actor = await getActorFromRequest(config, store, req);
        const user = await store.getUserById(actor.userId);
        sendJson(res, 200, {
          user: publicUser(user),
          roles: actor.roles,
          permissions: actor.permissions,
          developerProfile: actor.developerProfile
        });
        return;
      }

      if (isRetiredReviewWorkflowPath(pathname)) {
        sendJson(res, 410, {
          error: {
            code: "skillhub.review_flow_retired",
            message: "SkillHub developer/reviewer review workflow has been retired. Logged-in users can share Skills directly."
          }
        });
        return;
      }

      if (pathname === "/api/developer-applications" && req.method === "POST") {
        const actor = await requireActor(config, store, req, "developer_application.create");
        const body = await readJson(req, 128 * 1024);
        const existingProfile = await store.getDeveloperProfile(actor.userId);
        if (existingProfile?.status === "approved") {
          throw new ValidationError("当前账号已经是开发者", "developer.already_approved", 409);
        }
        const app = await store.createDeveloperApplication({
          userId: actor.userId,
          namespace: slugify(requireText(body.namespace, "namespace", 2, 48), "dev"),
          displayName: requireText(body.displayName, "displayName", 2, 80),
          contact: requireText(body.contact, "contact", 3, 160),
          websiteUrl: String(body.websiteUrl ?? "").trim().slice(0, 300),
          reason: requireText(body.reason, "reason", 10, 2000)
        });
        await appendAudit(store, { actor, action: "developer_application.created", resourceType: "developerApplication", resourceId: app.id, ip });
        sendJson(res, 201, { application: app });
        return;
      }

      if (pathname === "/api/developer-applications/me" && req.method === "GET") {
        const actor = await requireActor(config, store, req, "developer_application.read_own");
        const [application, profile] = await Promise.all([
          store.getDeveloperApplicationForUser(actor.userId),
          store.getDeveloperProfile(actor.userId)
        ]);
        sendJson(res, 200, { application, developerProfile: profile });
        return;
      }

      if (pathname === "/api/admin/developer-applications" && req.method === "GET") {
        const actor = await requireActor(config, store, req, "developer_application.review");
        const applications = await store.listDeveloperApplications(url.searchParams.get("status") ?? "");
        await appendAudit(store, { actor, action: "developer_application.list", resourceType: "developerApplication", resourceId: "list", ip });
        sendJson(res, 200, { applications });
        return;
      }

      const appDecision = pathname.match(/^\/api\/admin\/developer-applications\/([^/]+)\/(approve|reject)$/);
      if (appDecision && req.method === "POST") {
        const actor = await requireActor(config, store, req, "developer_application.review");
        const body = await readJson(req, 128 * 1024, true);
        const application =
          appDecision[2] === "approve"
            ? await store.approveDeveloperApplication({ applicationId: appDecision[1], reviewerId: actor.userId, comment: String(body.comment ?? "") })
            : await store.rejectDeveloperApplication({ applicationId: appDecision[1], reviewerId: actor.userId, comment: String(body.comment ?? "") });
        if (!application) throw new ValidationError("申请不存在或状态不可处理", "developer_application.not_found", 404);
        await appendAudit(store, {
          actor,
          action: `developer_application.${appDecision[2]}`,
          resourceType: "developerApplication",
          resourceId: appDecision[1],
          ip
        });
        sendJson(res, 200, { application });
        return;
      }

      if (pathname === "/api/admin/users" && req.method === "GET") {
        const actor = await requireActor(config, store, req, "user.manage");
        const users = await store.listUsers();
        await appendAudit(store, { actor, action: "user.list", resourceType: "user", resourceId: "list", ip });
        sendJson(res, 200, { users: users.map(({ passwordHash, ...user }) => user) });
        return;
      }

      const grantRole = pathname.match(/^\/api\/admin\/users\/([^/]+)\/roles$/);
      if (grantRole && req.method === "POST") {
        const actor = await requireActor(config, store, req, "role.grant");
        const body = await readJson(req, 64 * 1024);
        const role = requireRoleName(body.role);
        await store.grantRole({ userId: grantRole[1], role, grantedBy: actor.userId });
        await appendAudit(store, { actor, action: "role.grant", resourceType: "user", resourceId: grantRole[1], metadata: { role }, ip });
        sendJson(res, 200, { ok: true });
        return;
      }

      const revokeRole = pathname.match(/^\/api\/admin\/users\/([^/]+)\/roles\/([^/]+)$/);
      if (revokeRole && req.method === "DELETE") {
        const actor = await requireActor(config, store, req, "role.revoke");
        const role = requireRoleName(revokeRole[2]);
        if (role === "admin") {
          const activeAdmins = await store.countActiveRole("admin");
          if (activeAdmins <= 1) {
            throw new ValidationError("至少需要保留一个管理员账号", "admin.last_admin", 409);
          }
          if (revokeRole[1] === actor.userId) {
            throw new ValidationError("不能撤销自己的 admin 角色，请使用另一个管理员账号操作", "admin.self_revoke", 409);
          }
        }
        await store.revokeRole({ userId: revokeRole[1], role });
        await appendAudit(store, { actor, action: "role.revoke", resourceType: "user", resourceId: revokeRole[1], metadata: { role }, ip });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === "/api/admin/package-versions" && req.method === "GET") {
        const actor = await requireAdminActor(config, store, req, "package.yank");
        const packageVersions = await store.listPackageVersionsForAdmin({
          status: url.searchParams.get("status") ?? "",
          search: url.searchParams.get("q") ?? "",
          limit: Number(url.searchParams.get("limit") ?? 100)
        });
        await appendAudit(store, { actor, action: "package_version.list", resourceType: "packageVersion", resourceId: "list", ip });
        sendJson(res, 200, { packageVersions });
        return;
      }

      if (pathname === "/api/admin/skill-versions" && req.method === "GET") {
        const actor = await requireAdminActor(config, store, req, "package.yank");
        const versions = await store.listPackageVersionsForAdmin({
          status: url.searchParams.get("status") ?? "",
          search: url.searchParams.get("q") ?? "",
          limit: Number(url.searchParams.get("limit") ?? 100)
        });
        await appendAudit(store, { actor, action: "skill_version.list_admin", resourceType: "skillVersion", resourceId: "list", ip });
        sendJson(res, 200, { skillVersions: versions.map((version) => ({ ...toRegistryEntry(version), packageVersionId: version.id, status: version.status, yankedAt: version.yankedAt })) });
        return;
      }

      if (pathname === "/api/admin/namespaces" && req.method === "GET") {
        const actor = await requireAdminActor(config, store, req, "package.yank");
        const namespaces = typeof store.listAdminNamespaces === "function"
          ? await store.listAdminNamespaces({ search: url.searchParams.get("q") ?? "" })
          : [];
        await appendAudit(store, { actor, action: "namespace.list_admin", resourceType: "namespace", resourceId: "list", ip });
        sendJson(res, 200, { namespaces });
        return;
      }

      if (pathname === "/api/admin/skills" && req.method === "GET") {
        const actor = await requireAdminActor(config, store, req, "package.yank");
        const skills = typeof store.listAdminSkills === "function"
          ? await store.listAdminSkills({
              namespace: url.searchParams.get("namespace") ?? "",
              status: url.searchParams.get("status") ?? "",
              search: url.searchParams.get("q") ?? "",
              limit: Number(url.searchParams.get("limit") ?? 500)
            })
          : [];
        await appendAudit(store, { actor, action: "skill.list_admin", resourceType: "skill", resourceId: "list", ip });
        sendJson(res, 200, { skills });
        return;
      }

      const adminSkillVersions = pathname.match(/^\/api\/admin\/skills\/(.+)\/versions$/);
      if (adminSkillVersions && req.method === "GET") {
        const actor = await requireAdminActor(config, store, req, "package.yank");
        const skillId = decodeURIComponent(adminSkillVersions[1]);
        const versions = typeof store.listPackageVersionsForSkill === "function"
          ? await store.listPackageVersionsForSkill(skillId)
          : [];
        await appendAudit(store, { actor, action: "skill_version.list_for_skill_admin", resourceType: "skill", resourceId: skillId, ip });
        sendJson(res, 200, {
          skillVersions: versions.map((version) => ({
            ...toRegistryEntry(version),
            packageVersionId: version.id,
            status: version.status,
            yankedAt: version.yankedAt
          }))
        });
        return;
      }

      if (pathname === "/api/admin/audit-logs" && req.method === "GET") {
        const actor = await requireAdminActor(config, store, req, "audit.read");
        const auditLogs = await store.listAuditLogs({
          action: url.searchParams.get("action") ?? "",
          resourceType: url.searchParams.get("resourceType") ?? "",
          actorUserId: url.searchParams.get("actorUserId") ?? "",
          limit: Number(url.searchParams.get("limit") ?? 100)
        });
        sendJson(res, 200, { auditLogs });
        return;
      }

      if (pathname === "/api/developer/manifest-drafts" && req.method === "POST") {
        const actor = await requireActor(config, store, req, "manifest.create");
        const body = await readJson(req, config.limits.uploadMaxBytes);
        const files = body.source || body.files ? filesFromSubmissionBody(body, config.limits) : [];
        const manifest = buildManifestDraft({ form: body.form ?? body.manifest ?? body, files });
        await appendAudit(store, { actor, action: "manifest.draft", resourceType: "manifest", resourceId: manifest.id, ip });
        sendJson(res, 200, { manifest });
        return;
      }

      if (pathname === "/api/skills/share" && req.method === "POST") {
        const actor = await requireAuthenticatedActor(config, store, req);
        const body = await readJson(req, config.limits.uploadMaxBytes * 2);
        const files = filesFromSubmissionBody(body, config.limits);
        let manifest = namespaceQuickShareManifest(buildManifestDraft({ form: body.manifest ?? body.form ?? {}, files }), actor);
        let normalizedFiles = upsertManifestFile(files, manifest);
        const publishedVersions = await store.listPublishedVersionsForSkill(manifest.id);
        const historicalVersions = typeof store.listPackageVersionsForSkill === "function"
          ? await store.listPackageVersionsForSkill(manifest.id)
          : publishedVersions;
        const latestPublished = publishedVersions.length
          ? publishedVersions.reduce((best, item) => compareSemver(item.version, best.version) > 0 ? item : best, publishedVersions[0])
          : null;
        const latestHistorical = historicalVersions.length
          ? historicalVersions.reduce((best, item) => compareSemver(item.version, best.version) > 0 ? item : best, historicalVersions[0])
          : null;
        const skillHub = latestPublished && body.confirmVersionPublish !== true
          ? skillHubMetadataForPackageVersion(manifest, latestPublished)
          : skillHubMetadataForManifest(
              manifest,
              latestHistorical ? bumpPatch(latestHistorical.version) : manifest.version,
              nowIso()
            );
        manifest = withSkillHubMetadata({ ...manifest, version: skillHub.version }, skillHub);
        normalizedFiles = upsertManifestFile(injectSkillHubMetadataFiles(files, manifest, skillHub), manifest);
        const contentHash = computeSkillContentHash(normalizedFiles);
        const existing =
          await store.findPackageBySkillContentHash(manifest.id, contentHash) ||
          await findExistingByCanonicalPackageContentHash(publishedVersions, contentHash);
        if (existing) {
          sendJson(res, 200, {
            existing: true,
            skillId: manifest.id,
            latestVersion: existing.version,
            contentHash,
            skillHub: skillHubMetadataForPackageVersion(manifest, existing),
            packageVersion: toRegistryEntry(existing)
          });
          return;
        }
        if (publishedVersions.length && body.confirmVersionPublish !== true) {
          sendJson(res, 200, {
            requiresConfirmation: true,
            skillId: manifest.id,
            latestVersion: latestPublished.version,
            contentHash
          });
          return;
        }
        const uploadId = generateId("upl");
        const inventory = await saveSubmissionFiles(config, uploadId, normalizedFiles, config.limits);
        await store.enqueueJob("publish_skill_version", {
          uploadId,
          manifest,
          publisher: actor,
          releaseAt: skillHub.uploadedAt
        });
        await appendAudit(store, {
          actor,
          action: "skill.shared",
          resourceType: "skill",
          resourceId: manifest.id,
          metadata: { skillId: manifest.id, version: manifest.version },
          ip
        });
        if (body.runJobsInline === true && !config.isProduction) await processJobs(config);
        sendJson(res, 201, {
          upload: {
            id: uploadId,
            skillId: manifest.id,
            version: manifest.version,
            fileCount: inventory.length,
            totalBytes: inventory.reduce((sum, item) => sum + item.size, 0)
          },
          skill: toRegistryEntry({
            id: "",
            skillId: manifest.id,
            skillName: manifest.name,
            displayName: manifest.displayName,
            version: manifest.version,
            manifest,
            packageUrl: "",
            contentHash,
            checksumSha256: "",
            signature: {},
            publishedAt: nowIso(),
            downloadCount: 0
          }),
          skillHub,
          contentHash
        });
        return;
      }

      if (pathname === "/api/developer/submissions" && req.method === "GET") {
        const actor = await requireActor(config, store, req, "submission.read_own");
        const submissions = await store.listSubmissionsForDeveloper(actor.userId);
        sendJson(res, 200, { submissions });
        return;
      }

      if (pathname === "/api/developer/package-versions" && req.method === "GET") {
        const actor = await requireAuthenticatedActor(config, store, req);
        const packageVersions = typeof store.listPackageVersionsForOwner === "function"
          ? await store.listPackageVersionsForOwner(actor.userId, {
              limit: Number(url.searchParams.get("limit") ?? 100)
            })
          : [];
        await appendAudit(store, { actor, action: "package_version.list_own", resourceType: "packageVersion", resourceId: "own", ip });
        sendJson(res, 200, {
          packageVersions: packageVersions.map((version) => ({
            ...toRegistryEntry(version),
            packageVersionId: version.id,
            status: version.status,
            yankedAt: version.yankedAt
          }))
        });
        return;
      }

      if (pathname === "/api/me/skill-versions" && req.method === "GET") {
        const actor = await requireAuthenticatedActor(config, store, req);
        const versions = typeof store.listPackageVersionsForOwner === "function"
          ? await store.listPackageVersionsForOwner(actor.userId, {
              limit: Number(url.searchParams.get("limit") ?? 100)
            })
          : [];
        await appendAudit(store, { actor, action: "skill_version.list_own", resourceType: "skillVersion", resourceId: "own", ip });
        sendJson(res, 200, {
          skillVersions: versions.map((version) => ({
            ...toRegistryEntry(version),
            packageVersionId: version.id,
            status: version.status,
            yankedAt: version.yankedAt
          })),
          packageVersions: versions.map((version) => ({
            ...toRegistryEntry(version),
            packageVersionId: version.id,
            status: version.status,
            yankedAt: version.yankedAt
          }))
        });
        return;
      }

      const developerYankVersion = pathname.match(/^\/api\/developer\/package-versions\/([^/]+)\/yank$/);
      if (developerYankVersion && req.method === "POST") {
        const actor = await requireAuthenticatedActor(config, store, req);
        const body = await readJson(req, 64 * 1024, true);
        const target = typeof store.findPackageVersionWithOwner === "function"
          ? await store.findPackageVersionWithOwner(developerYankVersion[1])
          : null;
        if (!target) throw new ValidationError("版本不存在", "package.not_found", 404);
        if (target.ownerUserId !== actor.userId) {
          throw new AuthError("只能管理自己上传的 Skill 版本", 403);
        }
        const version = await store.yankPackageVersion(developerYankVersion[1]);
        if (!version) throw new ValidationError("版本不存在或已下架", "package.not_found", 404);
        await appendAudit(store, {
          actor,
          action: "package.yanked_own",
          resourceType: "packageVersion",
          resourceId: developerYankVersion[1],
          metadata: {
            skillId: version.skillId,
            version: version.version,
            reason: String(body.reason ?? body.comment ?? "").trim().slice(0, 1000)
          },
          ip
        });
        sendJson(res, 200, { packageVersion: toRegistryEntry(version) });
        return;
      }

      const meYankVersion = pathname.match(/^\/api\/me\/skill-versions\/([^/]+)\/yank$/);
      if (meYankVersion && req.method === "POST") {
        const actor = await requireAuthenticatedActor(config, store, req);
        const body = await readJson(req, 64 * 1024, true);
        const target = typeof store.findPackageVersionWithOwner === "function"
          ? await store.findPackageVersionWithOwner(meYankVersion[1])
          : null;
        if (!target) throw new ValidationError("Version not found", "package.not_found", 404);
        if (target.ownerUserId !== actor.userId) {
          throw new AuthError("You can only manage Skill versions you uploaded", 403);
        }
        const version = await store.yankPackageVersion(meYankVersion[1]);
        if (!version) throw new ValidationError("Version not found or already yanked", "package.not_found", 404);
        await appendAudit(store, {
          actor,
          action: "skill_version.yanked_own",
          resourceType: "skillVersion",
          resourceId: meYankVersion[1],
          metadata: {
            skillId: version.skillId,
            version: version.version,
            reason: String(body.reason ?? body.comment ?? "").trim().slice(0, 1000)
          },
          ip
        });
        sendJson(res, 200, { skillVersion: toRegistryEntry(version), packageVersion: toRegistryEntry(version) });
        return;
      }

      const meRestoreVersion = pathname.match(/^\/api\/me\/skill-versions\/([^/]+)\/restore$/);
      if (meRestoreVersion && req.method === "POST") {
        const actor = await requireAuthenticatedActor(config, store, req);
        const target = typeof store.findPackageVersionWithOwner === "function"
          ? await store.findPackageVersionWithOwner(meRestoreVersion[1])
          : null;
        if (!target) throw new ValidationError("Version not found", "package.not_found", 404);
        if (target.ownerUserId !== actor.userId) {
          throw new AuthError("You can only manage Skill versions you uploaded", 403);
        }
        const version = typeof store.restorePackageVersion === "function"
          ? await store.restorePackageVersion(meRestoreVersion[1])
          : null;
        if (!version) throw new ValidationError("Version not found", "package.not_found", 404);
        await appendAudit(store, {
          actor,
          action: "skill_version.restored_own",
          resourceType: "skillVersion",
          resourceId: meRestoreVersion[1],
          metadata: {
            skillId: version.skillId,
            version: version.version
          },
          ip
        });
        sendJson(res, 200, { skillVersion: toRegistryEntry(version), packageVersion: toRegistryEntry(version) });
        return;
      }

      const meDeleteVersion = pathname.match(/^\/api\/me\/skill-versions\/([^/]+)$/);
      if (meDeleteVersion && req.method === "DELETE") {
        const actor = await requireAuthenticatedActor(config, store, req);
        const target = typeof store.findPackageVersionWithOwner === "function"
          ? await store.findPackageVersionWithOwner(meDeleteVersion[1])
          : null;
        if (!target) throw new ValidationError("Version not found", "package.not_found", 404);
        if (target.ownerUserId !== actor.userId) {
          throw new AuthError("You can only delete Skill versions you uploaded", 403);
        }
        const version = await store.deletePackageVersion(meDeleteVersion[1]);
        if (!version) throw new ValidationError("Version not found", "package.not_found", 404);
        await appendAudit(store, {
          actor,
          action: "skill_version.hidden_own",
          resourceType: "skillVersion",
          resourceId: meDeleteVersion[1],
          metadata: { skillId: version.skillId, version: version.version },
          ip
        });
        sendJson(res, 200, {
          ok: true,
          retained: true,
          skillVersion: toRegistryEntry(version),
          packageVersion: toRegistryEntry(version)
        });
        return;
      }

      const developerSubmissionMatch = pathname.match(/^\/api\/developer\/submissions\/([^/]+)$/);
      if (developerSubmissionMatch && req.method === "GET") {
        const actor = await requireActor(config, store, req, "submission.read_own");
        const submission = await store.getSubmission(developerSubmissionMatch[1]);
        if (!submission) throw new ValidationError("提交不存在", "submission.not_found", 404);
        if (submission.submitterId !== actor.userId && !actor.permissions.includes("submission.review_queue")) {
          throw new AuthError("不能查看其他开发者的提交", 403);
        }
        const scanRun = await store.getScanRun(submission.latestScanRunId);
        sendJson(res, 200, { submission, scanRun });
        return;
      }

      if (pathname === "/api/reviewer/submissions" && req.method === "GET") {
        await requireActor(config, store, req, "submission.review_queue");
        const submissions = await store.listReviewSubmissions(url.searchParams.get("status") ?? "");
        sendJson(res, 200, { submissions });
        return;
      }

      const reviewApprove = pathname.match(/^\/api\/reviewer\/submissions\/([^/]+)\/approve$/);
      if (reviewApprove && req.method === "POST") {
        const actor = await requireActor(config, store, req, "submission.approve");
        const body = await readJson(req, 128 * 1024, true);
        const submission = await store.getSubmission(reviewApprove[1]);
        if (!submission) throw new ValidationError("提交不存在", "submission.not_found", 404);
        if (submission.submitterId === actor.userId) throw new AuthError("审核员不能审核自己的提交", 403);
        if (submission.status !== SubmissionStatus.REVIEW_PENDING) {
          throw new ValidationError(`当前状态不能通过审核: ${submission.status}`, "submission.invalid_status", 409);
        }
        const scanRun = await store.getScanRun(submission.latestScanRunId);
        if (scanRun && hasBlockingFindings(scanRun.findings)) {
          throw new ValidationError("扫描存在 high/critical 风险，不能通过审核", "submission.blocked_by_scan", 409);
        }
        const approved = await store.approveSubmission({ submissionId: submission.id, reviewerId: actor.userId, comment: String(body.comment ?? "") });
        await store.enqueueJob("publish_package", { submissionId: submission.id, reviewer: actor });
        await appendAudit(store, {
          actor,
          action: "submission.approved",
          resourceType: "submission",
          resourceId: submission.id,
          metadata: { skillId: submission.normalizedManifest.id, version: submission.normalizedManifest.version },
          ip
        });
        sendJson(res, 200, { submission: approved, scanRun });
        return;
      }

      const reviewDecision = pathname.match(/^\/api\/reviewer\/submissions\/([^/]+)\/(reject|request-changes)$/);
      if (reviewDecision && req.method === "POST") {
        const actor = await requireActor(config, store, req, reviewDecision[2] === "reject" ? "submission.reject" : "submission.request_changes");
        const body = await readJson(req, 128 * 1024, true);
        const action = reviewDecision[2] === "reject" ? "reject" : "request_changes";
        const status = action === "reject" ? SubmissionStatus.REJECTED : SubmissionStatus.CHANGES_REQUESTED;
        const submission = await store.markSubmissionReviewDecision({
          submissionId: reviewDecision[1],
          reviewerId: actor.userId,
          action,
          status,
          comment: String(body.comment ?? "")
        });
        if (!submission) throw new ValidationError("提交不存在", "submission.not_found", 404);
        await appendAudit(store, { actor, action: `submission.${action}`, resourceType: "submission", resourceId: reviewDecision[1], ip });
        sendJson(res, 200, { submission });
        return;
      }

      const yankMatch = pathname.match(/^\/api\/admin\/package-versions\/([^/]+)\/yank$/);
      if (yankMatch && req.method === "POST") {
        const actor = await requireAdminActor(config, store, req, "package.yank");
        const body = await readJson(req, 64 * 1024, true);
        const version = await store.yankPackageVersion(yankMatch[1]);
        if (!version) throw new ValidationError("版本不存在", "package.not_found", 404);
        await appendAudit(store, {
          actor,
          action: "package.yanked",
          resourceType: "packageVersion",
          resourceId: yankMatch[1],
          metadata: {
            skillId: version.skillId,
            version: version.version,
            reason: String(body.reason ?? body.comment ?? "").trim().slice(0, 1000)
          },
          ip
        });
        sendJson(res, 200, { packageVersion: version });
        return;
      }

      const adminYankSkillVersion = pathname.match(/^\/api\/admin\/skill-versions\/([^/]+)\/yank$/);
      if (adminYankSkillVersion && req.method === "POST") {
        const actor = await requireAdminActor(config, store, req, "package.yank");
        const body = await readJson(req, 64 * 1024, true);
        const version = await store.yankPackageVersion(adminYankSkillVersion[1]);
        if (!version) throw new ValidationError("Version not found", "package.not_found", 404);
        await appendAudit(store, {
          actor,
          action: "skill_version.yanked_admin",
          resourceType: "skillVersion",
          resourceId: adminYankSkillVersion[1],
          metadata: {
            skillId: version.skillId,
            version: version.version,
            reason: String(body.reason ?? body.comment ?? "").trim().slice(0, 1000)
          },
          ip
        });
        sendJson(res, 200, { skillVersion: toRegistryEntry(version), packageVersion: version });
        return;
      }

      const adminRestoreSkillVersion = pathname.match(/^\/api\/admin\/skill-versions\/([^/]+)\/restore$/);
      if (adminRestoreSkillVersion && req.method === "POST") {
        const actor = await requireAdminActor(config, store, req, "package.yank");
        const version = typeof store.restorePackageVersion === "function"
          ? await store.restorePackageVersion(adminRestoreSkillVersion[1])
          : null;
        if (!version) throw new ValidationError("Version not found", "package.not_found", 404);
        await appendAudit(store, {
          actor,
          action: "skill_version.restored_admin",
          resourceType: "skillVersion",
          resourceId: adminRestoreSkillVersion[1],
          metadata: { skillId: version.skillId, version: version.version },
          ip
        });
        sendJson(res, 200, { skillVersion: toRegistryEntry(version), packageVersion: version });
        return;
      }

      const adminDeleteSkillVersion = pathname.match(/^\/api\/admin\/skill-versions\/([^/]+)$/);
      if (adminDeleteSkillVersion && req.method === "DELETE") {
        const actor = await requireAdminActor(config, store, req, "package.yank");
        const version = await store.deletePackageVersion(adminDeleteSkillVersion[1]);
        if (!version) throw new ValidationError("Version not found", "package.not_found", 404);
        await appendAudit(store, {
          actor,
          action: "skill_version.hidden_admin",
          resourceType: "skillVersion",
          resourceId: adminDeleteSkillVersion[1],
          metadata: { skillId: version.skillId, version: version.version },
          ip
        });
        sendJson(res, 200, { ok: true, retained: true, skillVersion: toRegistryEntry(version) });
        return;
      }

      const adminDeleteSkill = pathname.match(/^\/api\/admin\/skills\/(.+)$/);
      if (adminDeleteSkill && req.method === "DELETE") {
        const actor = await requireAdminActor(config, store, req, "package.yank");
        const result = await store.deleteSkill(adminDeleteSkill[1]);
        await appendAudit(store, {
          actor,
          action: "skill.hidden_admin",
          resourceType: "skill",
          resourceId: adminDeleteSkill[1],
          metadata: { versionCount: result.versions?.length ?? 0 },
          ip
        });
        sendJson(res, 200, {
          ok: true,
          retained: true,
          hiddenVersions: result.versions?.length ?? 0
        });
        return;
      }

      if (pathname === "/api/skills" && req.method === "GET") {
        const versions = await store.listPublishedVersions();
        const skills = searchPublishedSkills(versions, url.searchParams.get("q") ?? "", {
          category: url.searchParams.get("category") ?? "",
          agentVersion: url.searchParams.get("agent_version") ?? "",
          platform: url.searchParams.get("platform") ?? "",
          searchMode: url.searchParams.get("search_mode") ?? ""
        });
        sendJson(res, 200, { skills });
        return;
      }

      const versionsMatch = pathname.match(/^\/api\/skills\/(.+)\/versions$/);
      if (versionsMatch && req.method === "GET") {
        const versions = await store.listPublishedVersionsForSkill(versionsMatch[1]);
        sendJson(res, 200, { versions: versions.map(toRegistryEntry) });
        return;
      }

      const versionMatch = pathname.match(/^\/api\/skills\/(.+)\/versions\/([^/]+)$/);
      if (versionMatch && req.method === "GET") {
        const version = await store.findPublishedVersion(versionMatch[1], versionMatch[2]);
        if (!version) throw new ValidationError("版本不存在或未发布", "version.not_found", 404);
        await assertStoredGitVersion(config, version, "public");
        sendJson(res, 200, { version: toRegistryEntry(version) });
        return;
      }

      const downloadMatch = pathname.match(/^\/api\/skills\/(.+)\/versions\/([^/]+)\/download$/);
      if (downloadMatch && req.method === "GET") {
        const actor = await getActorFromRequest(config, store, req, { allowPublic: true, allowAgent: true });
        const version = await store.findPublishedVersion(downloadMatch[1], downloadMatch[2]);
        if (!version) throw new ValidationError("版本不存在或未发布", "version.not_found", 404);
        await assertStoredGitVersion(config, version, "public");
        await store.incrementDownload({ packageVersionId: version.id, userId: actor.userId, ip, userAgent: req.headers["user-agent"] ?? "" });
        await serveStaticFile(res, version.packagePath, "application/octet-stream", {
          "Content-Disposition": `attachment; filename="${version.packageFile}"`,
          "X-CatsCo-Checksum-Sha256": version.checksumSha256,
          "X-CatsCo-Signature-Key-Id": version.signature.keyId
        });
        return;
      }

      const skillMatch = pathname.match(/^\/api\/skills\/(.+)$/);
      if (skillMatch && req.method === "GET") {
        const versions = await store.listPublishedVersionsForSkill(skillMatch[1]);
        if (!versions.length) throw new ValidationError("Skill 不存在或未发布", "skill.not_found", 404);
        sendJson(res, 200, { skill: toRegistryEntry(versions[0]), versions: versions.map(toRegistryEntry) });
        return;
      }

      if (pathname === "/api/trust/public-keys" && req.method === "GET") {
        const [rootKey, signingKey] = await Promise.all([
          readRootPublicKey(config),
          ensureSigningKey(config)
        ]);
        await loadSigningKeyCertificate(config, signingKey);
        const certificates = await listActiveSigningKeyCertificates(config);
        sendJson(res, 200, {
          trustModel: "root-signed-signing-keys",
          root: {
            keyId: rootKey.keyId,
            algorithm: rootKey.algorithm,
            fingerprintSha256: fingerprintPublicKeyPem(rootKey.publicKeyPem)
          },
          keys: certificates.map((certificate) => ({
            keyId: certificate.subject.keyId,
            algorithm: certificate.subject.algorithm,
            publicKeyPem: certificate.subject.publicKeyPem,
            fingerprintSha256: certificate.subject.fingerprintSha256,
            certificate
          }))
        });
        return;
      }

      sendJson(res, 404, { error: { code: "not_found", message: "接口不存在" } });
    } catch (error) {
      sendError(res, error);
    }
  });
}

export async function startApiServer(config = loadConfig()) {
  assertProductionConfig(config);
  await ensureRuntimeDirectories(config);
  const server = createApiServer(config);
  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  console.log(`CatsCo SkillHub API listening on http://${config.host}:${config.port}`);
  return server;
}

async function requireActor(config, store, req, permission) {
  const actor = await getActorFromRequest(config, store, req, { allowAgent: true });
  requireAnyPermission(actor, [permission]);
  return actor;
}

async function requireAdminActor(config, store, req, permission) {
  const actor = await getActorFromRequest(config, store, req, { allowAgent: false });
  requireAnyPermission(actor, [permission]);
  return actor;
}

async function requireAuthenticatedActor(config, store, req) {
  return getActorFromRequest(config, store, req, { allowAgent: true });
}

async function createLoginSession({ config, store, user, req, res }) {
  const roles = await store.getRoles(user.id);
  const developerProfile = await store.getDeveloperProfile(user.id);
  const token = createSessionToken();
  const tokenHash = hashSessionToken(token, config.session.secret);
  const expiresAt = new Date(Date.now() + config.session.ttlDays * 24 * 60 * 60 * 1000).toISOString();
  await store.createSession({
    userId: user.id,
    tokenHash,
    expiresAt,
    ipHash: sha256(getIp(req)).slice(0, 16),
    userAgent: req.headers["user-agent"] ?? ""
  });
  res.setHeader("Set-Cookie", buildSessionCookie(config, token));
  return { actor: makeActor({ user, roles, developerProfile }) };
}

function namespaceQuickShareManifest(manifest, actor) {
  const namespace = slugify(actor?.developerProfile?.namespace || actor?.name || actor?.userId || "user", "user");
  const rawId = String(manifest.id || manifest.name || "skill").trim();
  const idParts = rawId.split("/").map((part) => part.trim()).filter(Boolean);
  const rawSkillName = String(manifest.name || manifest.displayName || "").trim() || (idParts.length === 2 ? idParts[1] : rawId);
  const skillName = slugify(rawSkillName || manifest.name || "skill", "skill");
  return {
    ...manifest,
    id: `${namespace}/${skillName}`,
    author: {
      ...(manifest.author || {}),
      name: namespace
    },
    runtime: {
      ...manifest.runtime,
      minAgentVersion: manifest.runtime?.minAgentVersion || "0.0.0",
      platforms: Array.isArray(manifest.runtime?.platforms) && manifest.runtime.platforms.length ? manifest.runtime.platforms : []
    }
  };
}

function skillHubMetadataForManifest(manifest, version, uploadedAt) {
  const author = String(manifest.id || "").split("/")[0] || "user";
  return {
    author,
    version: String(version || manifest.version || "1.0.0"),
    uploadedAt: String(uploadedAt || nowIso())
  };
}

function skillHubMetadataForPackageVersion(manifest, packageVersion) {
  const metadata = packageVersion?.manifest?.skillHub;
  if (metadata?.author && metadata?.version && metadata?.uploadedAt) {
    return {
      author: String(metadata.author),
      version: String(metadata.version),
      uploadedAt: String(metadata.uploadedAt)
    };
  }
  return skillHubMetadataForManifest(manifest, packageVersion?.version, packageVersion?.publishedAt);
}

function normalizeHttpBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationError("CatsCo baseUrl 无效", "catsco.base_url.invalid", 400);
  }
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new ValidationError("CatsCo baseUrl 只支持 http/https", "catsco.base_url.invalid", 400);
  }
  return parsed.origin;
}

async function verifyCatsCoToken(baseUrl, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let response;
  try {
    response = await fetch(`${baseUrl}/api/me`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new AuthError("CatsCo token 验证超时", 408);
    }
    throw new AuthError(`CatsCo token 验证失败：${error?.message || String(error)}`, 502);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!response.ok) {
    throw new AuthError(data?.error || data?.message || "CatsCo token 无效", response.status);
  }
  return data;
}

async function findExistingByCanonicalPackageContentHash(publishedVersions, contentHash) {
  for (const version of publishedVersions) {
    try {
      const packageText = await fsp.readFile(version.packagePath, "utf8");
      const packageObject = JSON.parse(packageText);
      const files = packageObject?.payload?.files;
      if (Array.isArray(files) && computeSkillContentHash(files) === contentHash) {
        return version;
      }
    } catch (_error) {
      // Ignore unreadable legacy packages; normal content_hash lookup still handles current rows.
    }
  }
  return null;
}

function withSkillHubMetadata(manifest, skillHub) {
  return {
    ...manifest,
    skillHub,
    skillhub_author: skillHub.author,
    skillhub_version: skillHub.version,
    skillhub_uploaded_at: skillHub.uploadedAt
  };
}

function injectSkillHubMetadataFiles(files, manifest, skillHub) {
  const entry = manifest.entrypoints?.skillFile || "SKILL.md";
  return files.map((file) => {
    if (file.path !== entry) return file;
    const text = fileBuffer(file).toString("utf8");
    return {
      ...file,
      buffer: Buffer.from(applySkillHubFrontmatter(text, skillHub), "utf8")
    };
  });
}

function applySkillHubFrontmatter(markdown, skillHub) {
  const text = String(markdown || "");
  const fields = {
    skillhub_author: skillHub.author,
    skillhub_version: skillHub.version,
    skillhub_uploaded_at: skillHub.uploadedAt
  };
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return `---\n${frontmatterLines(fields)}---\n\n${text}`;
  }
  const head = match[1].split(/\r?\n/).filter((line) => !/^skillhub_(author|version|uploaded_at)\s*:/.test(line));
  const body = text.slice(match[0].length).replace(/^\r?\n/, "");
  return `---\n${[...head, ...frontmatterLines(fields).trimEnd().split("\n")].filter(Boolean).join("\n")}\n---\n\n${body}`;
}

function frontmatterLines(fields) {
  return Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(String(value))}\n`).join("");
}

function fileBuffer(file) {
  if (file.buffer) return file.buffer;
  if (file.contentBase64) return Buffer.from(file.contentBase64, "base64");
  return Buffer.from(String(file.content ?? ""), "utf8");
}

function bumpPatch(version) {
  const parts = String(version || "0.0.0").split(/[+-]/)[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
  while (parts.length < 3) parts.push(0);
  parts[2] += 1;
  return parts.slice(0, 3).join(".");
}

function isRetiredReviewWorkflowPath(pathname) {
  return (
    pathname === "/api/developer-applications" ||
    pathname === "/api/developer-applications/me" ||
    pathname.startsWith("/api/admin/developer-applications") ||
    pathname === "/api/developer/manifest-drafts" ||
    pathname === "/api/developer/submissions" ||
    pathname.startsWith("/api/developer/submissions/") ||
    pathname === "/api/developer/package-versions" ||
    /^\/api\/developer\/package-versions\/[^/]+\/yank$/.test(pathname) ||
    pathname === "/api/reviewer/submissions" ||
    pathname.startsWith("/api/reviewer/submissions/")
  );
}

function upsertManifestFile(files, manifest) {
  const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return [...files.filter((file) => file.path !== "skill.json"), { path: "skill.json", buffer: manifestBuffer }];
}

async function readJson(req, limit, allowEmpty = false) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new ValidationError("请求体超过大小限制", "body.too_large", 413);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text && allowEmpty) return {};
  if (!text) throw new ValidationError("请求体不能为空", "body.empty");
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("请求体不是合法 JSON", "body.invalid_json");
  }
}

function sendJson(res, status, body, headers = {}) {
  const payload = Buffer.from(`${JSON.stringify(body, null, 2)}\n`, "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(payload);
}

function sendError(res, error) {
  const status = error.status ?? (error instanceof AuthError ? 401 : 500);
  const safeMessage = status >= 500 ? "服务器内部错误" : error.message;
  sendJson(res, status, { error: { code: error.code ?? "internal_error", message: safeMessage } });
  if (status >= 500) console.error(error);
}

async function servePackagePath(config, res, pathname) {
  const relative = pathname.replace(/^\/packages\//, "");
  const parts = relative.split("/").map(decodeURIComponent).filter(Boolean);
  if (parts[0] === "sha256" && parts.length === 2) {
    const match = parts[1].match(/^([a-f0-9]{64})\.skillpkg$/);
    if (!match) throw new ValidationError("包路径不存在", "package_path.invalid", 404);
    const absolute = await safeJoin(config.paths.artifacts, `${match[1].slice(0, 2)}/${parts[1]}`);
    await serveStaticFile(res, absolute, "application/octet-stream", {
      "Cache-Control": "public, max-age=31536000, immutable"
    });
    return;
  }
  if (parts.length < 3) throw new ValidationError("包路径不存在", "package_path.invalid", 404);
  const absolute = await safeJoin(config.paths.packages, parts.join("/"));
  await serveStaticFile(res, absolute, "application/octet-stream", { "Cache-Control": "public, max-age=31536000, immutable" });
}

async function serveStaticFile(res, filePath, contentType, extraHeaders = {}) {
  const stat = await fsp.stat(filePath).catch((error) => {
    if (error.code === "ENOENT") throw new ValidationError("文件不存在", "file.not_found", 404);
    throw error;
  });
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Last-Modified": stat.mtime.toUTCString(),
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });
  fs.createReadStream(filePath).pipe(res);
}

async function assertStoredGitVersion(config, version, scope) {
  if (version.storageBackend !== "git-v1") return;
  if (
    !version.gitRepositoryId
    || !version.gitCommitSha
    || !version.gitTreeSha
    || !version.gitTag
  ) {
    throw new ValidationError(
      "Git-backed Skill version metadata is incomplete.",
      "GIT_VERSION_METADATA_MISSING",
      500
    );
  }
  try {
    const verified = await assertGitVersion({
      config,
      scope,
      skillId: version.skillId,
      tag: version.gitTag,
      commitSha: version.gitCommitSha,
      treeSha: version.gitTreeSha
    });
    if (verified.repositoryId !== version.gitRepositoryId) {
      throw new Error("Git repository identifier mismatch");
    }
  } catch (error) {
    throw new ValidationError(
      `Git-backed Skill version integrity check failed: ${error?.message || String(error)}`,
      "GIT_VERSION_INTEGRITY_FAILED",
      500
    );
  }
}

async function removePackageFile(filePath) {
  if (!filePath) return;
  try {
    await fsp.rm(filePath, { force: true });
  } catch (_error) {
    // Database state is authoritative; missing package files should not block admin cleanup.
  }
}

async function removePackageVersionDir(filePath) {
  if (!filePath) return;
  try {
    await fsp.rmdir(path.dirname(filePath));
  } catch (_error) {
    // Directory may still contain other files or already be gone.
  }
}

async function removePackageDirForSkill(config, skillId) {
  const parts = String(skillId || "").split("/").filter(Boolean);
  if (parts.length < 2) return;
  try {
    const absolute = await safeJoin(config.paths.packages, parts.join("/"));
    await fsp.rm(absolute, { recursive: true, force: true });
  } catch (_error) {
    // Package directories are cleanup artifacts; DB state remains authoritative.
  }
}

async function removeEmptyPackageDirsForSkill(config, skillId) {
  const parts = String(skillId || "").split("/").filter(Boolean);
  if (parts.length < 2) return;
  try {
    const absolute = await safeJoin(config.paths.packages, parts.join("/"));
    const entries = await fsp.readdir(absolute, { recursive: true, withFileTypes: true }).catch(() => []);
    const hasFiles = entries.some((entry) => entry.isFile());
    if (!hasFiles) await fsp.rm(absolute, { recursive: true, force: true });
  } catch (_error) {
    // Best-effort cleanup only.
  }
}

function applyCors(config, req, res) {
  const origin = req.headers.origin;
  const allowed = origin && config.allowedOrigins.includes(origin);
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Requested-With, X-CatsCo-Bot-Id");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  }
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt
  };
}

function requireEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ValidationError("邮箱格式不正确", "email.invalid");
  return email;
}

function requireText(value, field, min, max) {
  const text = String(value ?? "").trim();
  if (text.length < min) throw new ValidationError(`${field} 至少需要 ${min} 个字符`, `${field}.too_short`);
  if (text.length > max) throw new ValidationError(`${field} 不能超过 ${max} 个字符`, `${field}.too_long`);
  return text;
}

function requireRoleName(role) {
  const value = String(role ?? "").trim();
  if (!["user", "developer", "reviewer", "admin"].includes(value)) {
    throw new ValidationError("角色不合法", "role.invalid");
  }
  return value;
}

function requireReferencePart(value, field, maxLength) {
  const text = String(value ?? "").trim();
  if (
    !text
    || text.length > maxLength
    || /[\u0000-\u001f\u007f]/.test(text)
    || hasUnpairedSurrogate(text)
  ) {
    throw new ValidationError(`${field} is invalid.`, "PRIVATE_SKILL_REFERENCE_INVALID", 400);
  }
  return text;
}

function hasUnpairedSurrogate(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const PRIVATE_SKILL_METADATA_MAX_REFERENCES = 256;
const PRIVATE_SKILL_METADATA_MAX_SKILL_ID_LENGTH = 240;
const PRIVATE_SKILL_METADATA_MAX_VERSION_LENGTH = 120;
// JSON.stringify escapes an unpaired UTF-16 surrogate as six ASCII bytes. The
// parser rejects such strings, but the transport must still admit the bounded
// payload so it can return the semantic 400 response instead of an earlier 413.
// Valid BMP characters use at most three bytes per code unit and surrogate
// pairs use fewer, so six is the complete worst-case JSON expansion.
export const PRIVATE_SKILL_METADATA_MAX_REQUEST_BYTES =
  64
  + PRIVATE_SKILL_METADATA_MAX_REFERENCES
    * (64 + 6 * (PRIVATE_SKILL_METADATA_MAX_SKILL_ID_LENGTH + PRIVATE_SKILL_METADATA_MAX_VERSION_LENGTH));

export function parsePrivateSkillMetadataRequest(value) {
  const references = value?.references;
  if (!Array.isArray(references) || references.length > PRIVATE_SKILL_METADATA_MAX_REFERENCES) {
    throw new ValidationError(
      "Private Skill metadata references are invalid.",
      "PRIVATE_SKILL_METADATA_REFERENCES_INVALID",
      400
    );
  }
  const seen = new Set();
  const parsed = [];
  for (const reference of references) {
    const skillId = requireReferencePart(
      reference?.skillId,
      "skillId",
      PRIVATE_SKILL_METADATA_MAX_SKILL_ID_LENGTH
    );
    const version = requireReferencePart(
      reference?.version,
      "version",
      PRIVATE_SKILL_METADATA_MAX_VERSION_LENGTH
    );
    if (!isPrivateSkillReference(skillId)) {
      throw new ValidationError(
        "Private Skill metadata only accepts private references.",
        "PRIVATE_SKILL_METADATA_REFERENCE_INVALID",
        400
      );
    }
    const key = `${skillId}\0${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push({ skillId, version });
  }
  return parsed;
}

const PRIVATE_SKILL_HISTORY_DEFAULT_LIMIT = 50;
const PRIVATE_SKILL_HISTORY_MAX_LIMIT = 100;
export const PRIVATE_SKILL_HISTORY_MAX_REQUEST_BYTES =
  96 + 6 * PRIVATE_SKILL_METADATA_MAX_SKILL_ID_LENGTH;

export function parsePrivateSkillHistoryRequest(value) {
  const skillId = requireReferencePart(
    value?.skillId,
    "skillId",
    PRIVATE_SKILL_METADATA_MAX_SKILL_ID_LENGTH
  );
  if (!isPrivateSkillReference(skillId)) {
    throw new ValidationError(
      "Private Skill history only accepts private references.",
      "PRIVATE_SKILL_HISTORY_REFERENCE_INVALID",
      400
    );
  }
  const rawLimit = value?.limit ?? PRIVATE_SKILL_HISTORY_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > PRIVATE_SKILL_HISTORY_MAX_LIMIT) {
    throw new ValidationError(
      "Private Skill history limit is invalid.",
      "PRIVATE_SKILL_HISTORY_LIMIT_INVALID",
      400
    );
  }
  const rawBefore = value?.beforeRevisionNumber;
  if (rawBefore != null && (!Number.isSafeInteger(rawBefore) || rawBefore < 1 || rawBefore > 1_000_000_000)) {
    throw new ValidationError(
      "Private Skill history cursor is invalid.",
      "PRIVATE_SKILL_HISTORY_CURSOR_INVALID",
      400
    );
  }
  return {
    skillId,
    limit: rawLimit,
    beforeRevisionNumber: rawBefore ?? null
  };
}

function referencesEqual(left, right) {
  if (!left && !right) return true;
  return Boolean(left)
    && Boolean(right)
    && left.skillId === right.skillId
    && left.version === right.version;
}

function requireAllowedPrivateSkillBot(config, botId) {
  const allowed = config.privateSkills.allowedBotIds;
  if ((!Array.isArray(allowed) || allowed.length === 0) && !config.privateSkills.allowAllBots) {
    throw new ValidationError(
      "Private Skill sync has not been enabled for any Bot.",
      "PRIVATE_SKILL_BOT_NOT_ALLOWED",
      403
    );
  }
  if (!config.privateSkills.allowAllBots && Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(botId)) {
    throw new ValidationError(
      "This Bot is not enabled for private Skill sync.",
      "PRIVATE_SKILL_BOT_NOT_ALLOWED",
      403
    );
  }
}

function privateMutationFacts(input, version, replayed = false) {
  const reference = mutationVersionReference({
    localSkillId: input.localSkillId,
    version: version.version,
    contentHash: input.candidateContentHash
  });
  return {
    mutationId: input.mutationId,
    reference,
    afterReference: reference,
    gitCommitSHA: version.gitCommitSha,
    gitRepositoryId: version.gitRepositoryId,
    gitTreeSHA: version.gitTreeSha,
    gitTag: version.gitTag,
    replayed
  };
}

function authenticateMutationWriter(config, req) {
  const authorization = String(req.headers.authorization ?? "");
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  const expected = String(config.mutationWriter?.secret ?? "");
  const actualBytes = Buffer.from(token);
  const expectedBytes = Buffer.from(expected);
  if (
    !token
    || !expected
    || actualBytes.length !== expectedBytes.length
    || !crypto.timingSafeEqual(actualBytes, expectedBytes)
  ) {
    throw new AuthError("Mutation writer authentication is required.", 401);
  }
}

function normalizeAuthority(value) {
  let parsed;
  try {
    parsed = new URL(String(value ?? ""));
  } catch {
    throw new ValidationError("CatsCo authority is invalid.", "MUTATION_AUTHORITY_INVALID", 500);
  }
  return parsed.origin;
}

function assertProductionConfig(config) {
  if (config.isProduction) {
    if (config.privateSkills.writeEnabled && !config.privateSkills.readEnabled) {
      throw new Error("Private Skill writes require private Skill reads to remain enabled.");
    }
    if (
      (config.privateSkills.readEnabled || config.privateSkills.historyEnabled || config.privateSkills.writeEnabled)
      && config.privateSkills.allowedBotIds.length === 0
      && !config.privateSkills.allowAllBots
    ) {
      throw new Error("Private Skill rollout requires a Bot allowlist or an explicit allow-all flag.");
    }
    if (
      config.privateSkills.maxFiles < 1
      || config.privateSkills.maxFiles > 200
      || config.privateSkills.maxSingleFileBytes < 1
      || config.privateSkills.maxSingleFileBytes > 2 * 1024 * 1024
      || config.privateSkills.maxTotalBytes < 1
      || config.privateSkills.maxTotalBytes > 20 * 1024 * 1024
      || config.privateSkills.maxRequestBytes < config.privateSkills.maxTotalBytes
      || config.privateSkills.maxRequestBytes > 30 * 1024 * 1024
      || config.privateSkills.maxConcurrentUploads < 1
      || config.privateSkills.maxVersionsPerBot < 1
      || config.privateSkills.maxBytesPerBot < config.privateSkills.maxTotalBytes
    ) {
      throw new Error("Private Skill limits are outside the supported production safety boundary.");
    }
    if (config.privateSkills.readEnabled || config.privateSkills.historyEnabled || config.privateSkills.writeEnabled) {
      let catsCoUrl;
      try {
        catsCoUrl = new URL(config.botAuth.catsCoBaseUrl);
      } catch {
        throw new Error("SKILLHUB_CATSCO_BASE_URL is invalid.");
      }
      if (catsCoUrl.protocol !== "https:") {
        throw new Error("Production private Skill authentication requires HTTPS CatsCo.");
      }
    }
    if (!config.databaseUrl) throw new Error("生产环境必须设置 SKILLHUB_DATABASE_URL");
    if (!config.session.secret || config.session.secret.length < 32) throw new Error("生产环境必须设置长度足够的 SKILLHUB_SESSION_SECRET");
    if (config.mutationWriter.enabled && config.mutationWriter.secret.length < 32) {
      throw new Error("生产 mutation writer requires a dedicated service secret of at least 32 characters");
    }
    if (config.mutationWriter.enabled) {
      let catsCoUrl;
      try {
        catsCoUrl = new URL(config.botAuth.catsCoBaseUrl);
      } catch {
        throw new Error("SKILLHUB_CATSCO_BASE_URL is invalid.");
      }
      if (catsCoUrl.protocol !== "https:") {
        throw new Error("Production mutation writer requires HTTPS CatsCo.");
      }
    }
  }
}

function getIp(req) {
  const remote = String(req.socket.remoteAddress ?? "").trim();
  const isLoopbackProxy = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
  if (isLoopbackProxy) {
    const realIp = String(req.headers["x-real-ip"] ?? "").trim();
    if (realIp) return realIp;
  }
  return remote;
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startApiServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
