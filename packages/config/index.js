import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readBool(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function readInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function splitList(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig(overrides = {}) {
  const nodeEnv = overrides.nodeEnv ?? process.env.NODE_ENV ?? "development";
  const root = path.resolve(overrides.root ?? process.env.SKILLHUB_ROOT ?? repoRoot);
  const storageRoot = path.resolve(overrides.storageRoot ?? process.env.SKILLHUB_STORAGE_ROOT ?? path.join(root, "storage"));
  const logsRoot = path.resolve(overrides.logsRoot ?? process.env.SKILLHUB_LOGS_ROOT ?? path.join(root, "logs"));
  const sharedRoot = path.resolve(overrides.sharedRoot ?? process.env.SKILLHUB_SHARED_ROOT ?? path.join(root, "shared"));

  return {
    nodeEnv,
    isProduction: nodeEnv === "production",
    host: overrides.host ?? process.env.SKILLHUB_HOST ?? "127.0.0.1",
    port: readInt("SKILLHUB_PORT", overrides.port ?? 9000),
    publicBaseUrl: overrides.publicBaseUrl ?? process.env.SKILLHUB_PUBLIC_BASE_URL ?? "http://127.0.0.1:9000",
    packageBaseUrl: overrides.packageBaseUrl ?? process.env.SKILLHUB_PACKAGE_BASE_URL ?? "http://127.0.0.1:9000/packages",
    databaseUrl: overrides.databaseUrl ?? process.env.SKILLHUB_DATABASE_URL ?? "",
    allowedOrigins: overrides.allowedOrigins ?? splitList(process.env.SKILLHUB_ALLOWED_ORIGINS),
    root,
    storageRoot,
    logsRoot,
    sharedRoot,
    paths: {
      intake: path.join(storageRoot, "intake"),
      packages: path.join(storageRoot, "packages"),
      artifacts: path.join(storageRoot, "blobs", "sha256"),
      reviews: path.join(storageRoot, "reviews"),
      tmp: path.join(storageRoot, "tmp"),
      private: path.join(sharedRoot, "private"),
      privateArtifacts: path.join(sharedRoot, "private", "blobs", "sha256"),
      gitPublic: path.join(sharedRoot, "git", "public"),
      gitPrivate: path.join(sharedRoot, "git", "private"),
      keys: path.join(sharedRoot, "keys")
    },
    limits: {
      uploadMaxBytes: readInt("SKILLHUB_UPLOAD_MAX_BYTES", overrides.uploadMaxBytes ?? 50 * 1024 * 1024),
      maxFiles: readInt("SKILLHUB_MAX_FILES", overrides.maxFiles ?? 500),
      maxExpandedBytes: readInt("SKILLHUB_MAX_EXPANDED_BYTES", overrides.maxExpandedBytes ?? 100 * 1024 * 1024),
      maxSingleFileBytes: readInt("SKILLHUB_MAX_SINGLE_FILE_BYTES", overrides.maxSingleFileBytes ?? 5 * 1024 * 1024),
      maxPathLength: readInt("SKILLHUB_MAX_PATH_LENGTH", overrides.maxPathLength ?? 180),
      maxPathDepth: readInt("SKILLHUB_MAX_PATH_DEPTH", overrides.maxPathDepth ?? 12)
    },
    signing: {
      keyId: overrides.signingKeyId ?? process.env.SKILLHUB_SIGNING_KEY_ID ?? "catsco-skillhub-dev-1",
      privateKeyPath:
        overrides.signingPrivateKeyPath ??
        process.env.SKILLHUB_SIGNING_PRIVATE_KEY_PATH ??
        path.join(sharedRoot, "keys", "skillhub-ed25519-private.pem"),
      publicKeyPath:
        overrides.signingPublicKeyPath ??
        process.env.SKILLHUB_SIGNING_PUBLIC_KEY_PATH ??
        path.join(sharedRoot, "keys", "skillhub-ed25519-public.pem"),
      certificatePath:
        overrides.signingCertificatePath ??
        process.env.SKILLHUB_SIGNING_CERTIFICATE_PATH ??
        path.join(sharedRoot, "keys", "skillhub-signing-certificate.json"),
      certificateArchiveDir:
        overrides.signingCertificateArchiveDir ??
        process.env.SKILLHUB_SIGNING_CERTIFICATE_ARCHIVE_DIR ??
        path.join(sharedRoot, "keys", "signing-certificates"),
      allowAutoKeygen: overrides.allowAutoKeygen ?? readBool("SKILLHUB_ALLOW_AUTO_KEYGEN", nodeEnv !== "production"),
      certificateExpiresAt:
        overrides.signingCertificateExpiresAt ??
        process.env.SKILLHUB_SIGNING_CERTIFICATE_EXPIRES_AT ??
        new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    },
    rootSigning: {
      keyId: overrides.rootKeyId ?? process.env.SKILLHUB_ROOT_KEY_ID ?? "catsco-root-dev-1",
      privateKeyPath:
        overrides.rootPrivateKeyPath ??
        process.env.SKILLHUB_ROOT_PRIVATE_KEY_PATH ??
        path.join(sharedRoot, "keys", "catsco-root-ed25519-private.pem"),
      publicKeyPath:
        overrides.rootPublicKeyPath ??
        process.env.SKILLHUB_ROOT_PUBLIC_KEY_PATH ??
        path.join(sharedRoot, "keys", "catsco-root-ed25519-public.pem"),
      allowAutoKeygen: overrides.allowAutoRootKeygen ?? readBool("SKILLHUB_ALLOW_AUTO_ROOT_KEYGEN", nodeEnv !== "production")
    },
    session: {
      secret: overrides.sessionSecret ?? process.env.SKILLHUB_SESSION_SECRET ?? "",
      cookieName: overrides.cookieName ?? process.env.SKILLHUB_COOKIE_NAME ?? "catsco_session",
      cookieDomain: overrides.cookieDomain ?? process.env.SKILLHUB_COOKIE_DOMAIN ?? "",
      cookieSecure: overrides.cookieSecure ?? readBool("SKILLHUB_COOKIE_SECURE", nodeEnv === "production"),
      ttlDays: readInt("SKILLHUB_SESSION_TTL_DAYS", overrides.sessionTtlDays ?? 30)
    },
    agent: {
      clientSecret: overrides.agentClientSecret ?? process.env.SKILLHUB_AGENT_CLIENT_SECRET ?? ""
    },
    botAuth: {
      catsCoBaseUrl:
        overrides.catsCoBaseUrl
        ?? process.env.SKILLHUB_CATSCO_BASE_URL
        ?? "https://app.catsco.cc",
      timeoutMs: readInt("SKILLHUB_CATSCO_AUTH_TIMEOUT_MS", overrides.catsCoAuthTimeoutMs ?? 8_000)
    },
    privateSkills: {
      readEnabled:
        overrides.privateSkillsReadEnabled
        ?? readBool("SKILLHUB_PRIVATE_SKILLS_READ_ENABLED", nodeEnv !== "production"),
      historyEnabled:
        overrides.privateSkillHistoryEnabled
        ?? readBool(
          "SKILLHUB_PRIVATE_SKILLS_HISTORY_ENABLED",
          overrides.privateSkillsReadEnabled
            ?? readBool("SKILLHUB_PRIVATE_SKILLS_READ_ENABLED", nodeEnv !== "production")
        ),
      writeEnabled:
        overrides.privateSkillsWriteEnabled
        ?? readBool("SKILLHUB_PRIVATE_SKILLS_WRITE_ENABLED", nodeEnv !== "production"),
      allowedBotIds:
        overrides.privateSkillAllowedBotIds
        ?? splitList(process.env.SKILLHUB_PRIVATE_SKILL_ALLOWED_BOT_IDS),
      allowAllBots:
        overrides.privateSkillAllowAllBots
        ?? readBool("SKILLHUB_PRIVATE_SKILL_ALLOW_ALL_BOTS", nodeEnv !== "production"),
      maxConcurrentUploads:
        overrides.privateSkillMaxConcurrentUploads
        ?? readInt("SKILLHUB_PRIVATE_MAX_CONCURRENT_UPLOADS", 2),
      maxFiles:
        overrides.privateSkillMaxFiles
        ?? readInt("SKILLHUB_PRIVATE_MAX_FILES", 200),
      maxSingleFileBytes:
        overrides.privateSkillMaxSingleFileBytes
        ?? readInt("SKILLHUB_PRIVATE_MAX_SINGLE_FILE_BYTES", 2 * 1024 * 1024),
      maxTotalBytes:
        overrides.privateSkillMaxTotalBytes
        ?? readInt("SKILLHUB_PRIVATE_MAX_TOTAL_BYTES", 20 * 1024 * 1024),
      maxRequestBytes:
        overrides.privateSkillMaxRequestBytes
        ?? readInt("SKILLHUB_PRIVATE_MAX_REQUEST_BYTES", 30 * 1024 * 1024),
      maxVersionsPerBot:
        overrides.privateSkillMaxVersionsPerBot
        ?? readInt("SKILLHUB_PRIVATE_MAX_VERSIONS_PER_BOT", 2_000),
      maxBytesPerBot:
        overrides.privateSkillMaxBytesPerBot
        ?? readInt("SKILLHUB_PRIVATE_MAX_BYTES_PER_BOT", 2 * 1024 * 1024 * 1024)
    },
    mutationWriter: {
      enabled:
        overrides.mutationWriterEnabled
        ?? readBool("SKILLHUB_MUTATION_WRITER_ENABLED", false),
      secret:
        overrides.mutationWriterSecret
        ?? process.env.SKILLHUB_MUTATION_WRITER_SECRET
        ?? "",
      maxRequestBytes:
        overrides.mutationWriterMaxRequestBytes
        ?? readInt("SKILLHUB_MUTATION_WRITER_MAX_REQUEST_BYTES", 30 * 1024 * 1024)
    },
    worker: {
      id: overrides.workerId ?? process.env.SKILLHUB_WORKER_ID ?? `worker-${process.pid}`,
      pollMs: readInt("SKILLHUB_WORKER_POLL_MS", overrides.workerPollMs ?? 3000)
    }
  };
}
