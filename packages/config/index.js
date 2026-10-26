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
    publicationUpload: {
      enabled: overrides.publicationUploadEnabled ?? readBool("SKILLHUB_PUBLICATION_UPLOAD_ENABLED", false),
      issuer: overrides.publicationUploadIssuer ?? process.env.SKILLHUB_PUBLICATION_UPLOAD_ISSUER ?? "",
      audience: overrides.publicationUploadAudience ?? process.env.SKILLHUB_PUBLICATION_UPLOAD_AUDIENCE ?? "",
      peerSecret: overrides.publicationUploadPeerSecret ?? process.env.SKILLHUB_PUBLICATION_UPLOAD_PEER_SECRET ?? "",
      trustedProxyAddresses: overrides.publicationUploadTrustedProxyAddresses ?? splitList(process.env.SKILLHUB_PUBLICATION_UPLOAD_TRUSTED_PROXY_ADDRESSES)
    },
    publicationCommitService: {
      enabled: overrides.publicationCommitServiceEnabled ?? readBool("SKILLHUB_PUBLICATION_COMMIT_SERVICE_ENABLED", false),
      issuer: overrides.publicationCommitServiceIssuer ?? process.env.SKILLHUB_PUBLICATION_COMMIT_SERVICE_ISSUER ?? "",
      audience: overrides.publicationCommitServiceAudience ?? process.env.SKILLHUB_PUBLICATION_COMMIT_SERVICE_AUDIENCE ?? "",
      peerSecret: overrides.publicationCommitServicePeerSecret ?? process.env.SKILLHUB_PUBLICATION_COMMIT_SERVICE_PEER_SECRET ?? "",
      trustedProxyAddresses: overrides.publicationCommitServiceTrustedProxyAddresses ?? splitList(process.env.SKILLHUB_PUBLICATION_COMMIT_SERVICE_TRUSTED_PROXY_ADDRESSES)
    },
    publicationDescriptionDerivation: {
      enabled: overrides.publicationDescriptionDerivationEnabled ?? readBool("SKILLHUB_PUBLICATION_DESCRIPTION_DERIVATION_ENABLED", false),
      readEnabled: overrides.publicationDescriptionReadEnabled ?? readBool("SKILLHUB_PUBLICATION_DESCRIPTION_READ_ENABLED", false),
      validationEnabled: overrides.publicationDescriptionValidationEnabled ?? readBool("SKILLHUB_PUBLICATION_DESCRIPTION_VALIDATION_ENABLED", false),
      planEnabled: overrides.publicationDescriptionPlanEnabled ?? readBool("SKILLHUB_PUBLICATION_DESCRIPTION_PLAN_ENABLED", false),
      commitAdmissionEnabled: overrides.publicationDescriptionCommitAdmissionEnabled ?? readBool("SKILLHUB_PUBLICATION_DESCRIPTION_COMMIT_ADMISSION_ENABLED", false),
      releasePermit: {
        enabled: overrides.publicationDescriptionReleasePermitEnabled ?? readBool("SKILLHUB_PUBLICATION_DESCRIPTION_RELEASE_PERMIT_ENABLED", false),
        issuer: overrides.publicationDescriptionReleasePermitIssuer ?? process.env.SKILLHUB_PUBLICATION_DESCRIPTION_RELEASE_PERMIT_ISSUER ?? "",
        audience: overrides.publicationDescriptionReleasePermitAudience ?? process.env.SKILLHUB_PUBLICATION_DESCRIPTION_RELEASE_PERMIT_AUDIENCE ?? "",
        peerSecret: overrides.publicationDescriptionReleasePermitPeerSecret ?? process.env.SKILLHUB_PUBLICATION_DESCRIPTION_RELEASE_PERMIT_PEER_SECRET ?? ""
      },
      issuer: overrides.publicationDescriptionDerivationIssuer ?? process.env.SKILLHUB_PUBLICATION_DESCRIPTION_DERIVATION_ISSUER ?? "",
      audience: overrides.publicationDescriptionDerivationAudience ?? process.env.SKILLHUB_PUBLICATION_DESCRIPTION_DERIVATION_AUDIENCE ?? "",
      peerSecret: overrides.publicationDescriptionDerivationPeerSecret ?? process.env.SKILLHUB_PUBLICATION_DESCRIPTION_DERIVATION_PEER_SECRET ?? "",
      trustedProxyAddresses: overrides.publicationDescriptionDerivationTrustedProxyAddresses ?? splitList(process.env.SKILLHUB_PUBLICATION_DESCRIPTION_DERIVATION_TRUSTED_PROXY_ADDRESSES),
      timeoutMs: overrides.publicationDescriptionDerivationTimeoutMs ?? Number(process.env.SKILLHUB_PUBLICATION_DESCRIPTION_DERIVATION_TIMEOUT_MS ?? 30000)
    },
    publicationControl: {
      enabled: overrides.publicationControlEnabled ?? readBool("SKILLHUB_PUBLICATION_CONTROL_ENABLED", false),
      issuer: overrides.publicationControlIssuer ?? process.env.SKILLHUB_PUBLICATION_CONTROL_ISSUER ?? "",
      audience: overrides.publicationControlAudience ?? process.env.SKILLHUB_PUBLICATION_CONTROL_AUDIENCE ?? "",
      peerSecret: overrides.publicationControlPeerSecret ?? process.env.SKILLHUB_PUBLICATION_CONTROL_PEER_SECRET ?? "",
      trustedProxyAddresses: overrides.publicationControlTrustedProxyAddresses ?? splitList(process.env.SKILLHUB_PUBLICATION_CONTROL_TRUSTED_PROXY_ADDRESSES)
    },
    publicationDelegatedWorker: {
      enabled: overrides.publicationDelegatedWorkerEnabled ?? readBool("SKILLHUB_PUBLICATION_DELEGATED_WORKER_ENABLED", false)
    },
    // Cloud acceptance evidence is delivered to the independently
    // authenticated CatsCo peer. Keep this lane dormant until rollout.
    publicationReceiptDelivery: {
      enabled:
        overrides.publicationReceiptDeliveryEnabled
        ?? readBool("SKILLHUB_PUBLICATION_RECEIPT_DELIVERY_ENABLED", false),
      issuer:
        overrides.publicationReceiptDeliveryIssuer
        ?? process.env.SKILLHUB_PUBLICATION_RECEIPT_ISSUER
        ?? "",
      audience:
        overrides.publicationReceiptDeliveryAudience
        ?? process.env.SKILLHUB_PUBLICATION_RECEIPT_AUDIENCE
        ?? "",
      peerSecret:
        overrides.publicationReceiptDeliveryPeerSecret
        ?? process.env.SKILLHUB_PUBLICATION_RECEIPT_PEER_SECRET
        ?? "",
      pollMs: readInt(
        "SKILLHUB_PUBLICATION_RECEIPT_POLL_MS",
        overrides.publicationReceiptDeliveryPollMs ?? 5000
      )
    },
    publicationPublishing: {
      enabled: overrides.publicationPublishingEnabled ?? readBool("SKILLHUB_PUBLICATION_PUBLISHING_ENABLED", false)
    },
    publicationTasks: {
      enabled: overrides.publicationTasksEnabled ?? readBool("SKILLHUB_PUBLICATION_TASKS_ENABLED", false),
      commitTimeoutMs: overrides.publicationCommitTimeoutMs ?? Number(process.env.SKILLHUB_PUBLICATION_COMMIT_TIMEOUT_MS ?? 300000),
      maxTasks: overrides.publicationTasksMaxTasks ?? Number(process.env.SKILLHUB_PUBLICATION_TASKS_MAX_TASKS ?? 10000),
      maxTasksPerOwner: overrides.publicationTasksMaxTasksPerOwner ?? Number(process.env.SKILLHUB_PUBLICATION_TASKS_MAX_TASKS_PER_OWNER ?? 100),
      maxStoredBytes: overrides.publicationTasksMaxStoredBytes ?? Number(process.env.SKILLHUB_PUBLICATION_TASKS_MAX_STORED_BYTES ?? 2 * 1024 ** 3),
      maxStoredBytesPerOwner: overrides.publicationTasksMaxStoredBytesPerOwner ?? Number(process.env.SKILLHUB_PUBLICATION_TASKS_MAX_STORED_BYTES_PER_OWNER ?? 256 * 1024 ** 2),
      candidateTtlMs: overrides.publicationTasksCandidateTtlMs ?? Number(process.env.SKILLHUB_PUBLICATION_TASKS_CANDIDATE_TTL_MS ?? 7 * 86400000),
      retentionMs: overrides.publicationTasksRetentionMs ?? Number(process.env.SKILLHUB_PUBLICATION_TASKS_RETENTION_MS ?? 30 * 86400000),
      leaseMs: overrides.publicationTasksLeaseMs ?? Number(process.env.SKILLHUB_PUBLICATION_TASKS_LEASE_MS ?? 30000)
    },
    publishValidation: {
      enabled: overrides.publishValidationEnabled ?? readBool("SKILLHUB_PUBLISH_VALIDATION_ENABLED", false),
      // Optional-feature budgets are validated inside its handler boundary.
      // Preserve invalid values rather than silently replacing/relaxing them;
      // a bad preflight setting must never prevent the rest of the API starting.
      maxConcurrent: overrides.publishValidationMaxConcurrent ?? Number(process.env.SKILLHUB_PUBLISH_VALIDATION_MAX_CONCURRENT ?? 2),
      requestsPerMinute: overrides.publishValidationRequestsPerMinute ?? Number(process.env.SKILLHUB_PUBLISH_VALIDATION_REQUESTS_PER_MINUTE ?? 30),
      readTimeoutMs: overrides.publishValidationReadTimeoutMs ?? Number(process.env.SKILLHUB_PUBLISH_VALIDATION_READ_TIMEOUT_MS ?? 15000),
      workerTimeoutMs: overrides.publishValidationWorkerTimeoutMs ?? Number(process.env.SKILLHUB_PUBLISH_VALIDATION_WORKER_TIMEOUT_MS ?? 10000),
      workerMemoryMb: overrides.publishValidationWorkerMemoryMb ?? Number(process.env.SKILLHUB_PUBLISH_VALIDATION_WORKER_MEMORY_MB ?? 512),
      limits: {
        maxRequestBytes: overrides.publishValidationMaxRequestBytes ?? Number(process.env.SKILLHUB_PUBLISH_VALIDATION_MAX_REQUEST_BYTES ?? 75 * 1024 * 1024)
      }
    },
    presentations: {
      imagesEnabled: overrides.presentationImagesEnabled ?? readBool("SKILLHUB_PRESENTATION_IMAGES_ENABLED", nodeEnv !== "production"),
      readEnabled: overrides.presentationsReadEnabled ?? readBool("SKILLHUB_PRESENTATIONS_READ_ENABLED", nodeEnv !== "production"),
      writeEnabled: overrides.presentationsWriteEnabled ?? readBool("SKILLHUB_PRESENTATIONS_WRITE_ENABLED", nodeEnv !== "production")
    },
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
      maxUploadsPerMinute:
        overrides.privateSkillMaxUploadsPerMinute
        ?? readInt("SKILLHUB_PRIVATE_MAX_UPLOADS_PER_MINUTE", 300),
      maxFiles:
        overrides.privateSkillMaxFiles
        ?? readInt("SKILLHUB_PRIVATE_MAX_FILES", 200),
      // Mirrors SKILLHUB_MAX_SINGLE_FILE_BYTES for public packages: a Bot
      // publishes its whole local workspace, so a page with embedded artwork
      // must not be rejected here while the public path would accept it.
      maxSingleFileBytes:
        overrides.privateSkillMaxSingleFileBytes
        ?? readInt("SKILLHUB_PRIVATE_MAX_SINGLE_FILE_BYTES", 5 * 1024 * 1024),
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
