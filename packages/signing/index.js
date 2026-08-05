import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function ensureSigningKey(config) {
  await fs.mkdir(path.dirname(config.signing.privateKeyPath), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(config.signing.publicKeyPath), { recursive: true, mode: 0o700 });

  try {
    const [privateKeyPem, publicKeyPem] = await Promise.all([
      fs.readFile(config.signing.privateKeyPath, "utf8"),
      fs.readFile(config.signing.publicKeyPath, "utf8")
    ]);
    return {
      keyId: config.signing.keyId,
      privateKeyPem,
      publicKeyPem,
      algorithm: "ed25519"
    };
  } catch (error) {
    if (!config.signing.allowAutoKeygen) {
      throw new Error(`签名密钥不存在，请先运行 scripts/generate-signing-key.js: ${error.message}`);
    }
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  await fs.writeFile(config.signing.privateKeyPath, privateKeyPem, { mode: 0o600 });
  await fs.writeFile(config.signing.publicKeyPath, publicKeyPem, { mode: 0o644 });
  return {
    keyId: config.signing.keyId,
    privateKeyPem,
    publicKeyPem,
    algorithm: "ed25519"
  };
}

export async function ensureRootKey(config) {
  await fs.mkdir(path.dirname(config.rootSigning.privateKeyPath), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(config.rootSigning.publicKeyPath), { recursive: true, mode: 0o700 });

  try {
    const [privateKeyPem, publicKeyPem] = await Promise.all([
      fs.readFile(config.rootSigning.privateKeyPath, "utf8"),
      fs.readFile(config.rootSigning.publicKeyPath, "utf8")
    ]);
    return {
      keyId: config.rootSigning.keyId,
      privateKeyPem,
      publicKeyPem,
      algorithm: "ed25519"
    };
  } catch (error) {
    if (!config.rootSigning.allowAutoKeygen) {
      throw new Error(`Root 签名密钥不存在，请先运行 scripts/generate-root-key.js: ${error.message}`);
    }
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  await fs.writeFile(config.rootSigning.privateKeyPath, privateKeyPem, { mode: 0o600 });
  await fs.writeFile(config.rootSigning.publicKeyPath, publicKeyPem, { mode: 0o644 });
  return {
    keyId: config.rootSigning.keyId,
    privateKeyPem,
    publicKeyPem,
    algorithm: "ed25519"
  };
}

export async function readRootPublicKey(config) {
  const publicKeyPem = await fs.readFile(config.rootSigning.publicKeyPath, "utf8");
  return {
    keyId: config.rootSigning.keyId,
    publicKeyPem,
    algorithm: "ed25519"
  };
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

export function signPayload(payload, key, options = {}) {
  const bytes = Buffer.from(canonicalJson(payload));
  const signature = crypto.sign(null, bytes, key.privateKeyPem).toString("base64");
  return {
    algorithm: "ed25519",
    keyId: key.keyId,
    signature,
    signedAt: canonicalSigningTime(options.signedAt)
  };
}

function canonicalSigningTime(value) {
  if (value === undefined) return new Date().toISOString();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Signing timestamp is invalid");
  return parsed.toISOString();
}

export function fingerprintPublicKeyPem(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ type: "spki", format: "der" });
  return `sha256:${crypto.createHash("sha256").update(der).digest("hex")}`;
}

export function createSigningKeyCertificate({ rootKey, signingKey, expiresAt }) {
  const issuedAt = new Date().toISOString();
  assertCertificateWindow(issuedAt, expiresAt);
  const payload = {
    schemaVersion: "1.0.0",
    subject: {
      keyId: signingKey.keyId,
      algorithm: signingKey.algorithm,
      publicKeyPem: signingKey.publicKeyPem,
      fingerprintSha256: fingerprintPublicKeyPem(signingKey.publicKeyPem)
    },
    issuer: {
      keyId: rootKey.keyId,
      algorithm: rootKey.algorithm,
      publicKeyFingerprintSha256: fingerprintPublicKeyPem(rootKey.publicKeyPem)
    },
    usages: ["skillpkg.sign"],
    issuedAt,
    expiresAt
  };
  return {
    ...payload,
    signature: signPayload(payload, rootKey)
  };
}

export async function issueSigningKeyCertificate(config) {
  const [rootKey, signingKey] = await Promise.all([
    ensureRootKey(config),
    ensureSigningKey(config)
  ]);
  await archiveExistingCurrentCertificate(config, rootKey.publicKeyPem);
  const certificate = createSigningKeyCertificate({
    rootKey,
    signingKey,
    expiresAt: config.signing.certificateExpiresAt
  });
  await archiveSigningKeyCertificate(config, certificate, rootKey.publicKeyPem);
  await writeFileAtomic(
    config.signing.certificatePath,
    `${JSON.stringify(certificate, null, 2)}\n`,
    0o644
  );
  return certificate;
}

export async function loadSigningKeyCertificate(config, signingKey) {
  let certificate;
  try {
    certificate = JSON.parse(await fs.readFile(config.signing.certificatePath, "utf8"));
  } catch (error) {
    if (config.isProduction) {
      throw new Error(`签名公钥证书不存在，请先运行 scripts/issue-signing-certificate.js: ${error.message}`);
    }
    certificate = await issueSigningKeyCertificate(config);
  }

  if (certificate.subject?.keyId !== signingKey.keyId || certificate.subject?.publicKeyPem !== signingKey.publicKeyPem) {
    throw new Error("签名公钥证书与当前 package signing key 不匹配");
  }

  const rootPublicKey = await readRootPublicKey(config);
  if (!verifySigningKeyCertificate(certificate, rootPublicKey.publicKeyPem)) {
    throw new Error("签名公钥证书无法通过 root public key 验证");
  }
  await archiveSigningKeyCertificate(config, certificate, rootPublicKey.publicKeyPem);
  return certificate;
}

export async function loadSigningKeyCertificateByKeyId(config, keyId, signedPackage = undefined) {
  validateSigningKeyId(keyId);
  const rootPublicKey = await readRootPublicKey(config);
  const candidates = await readCertificateCandidates(config, keyId);
  const trusted = candidates
    .filter((certificate) => safelyTrustCertificate(
      certificate,
      rootPublicKey.publicKeyPem,
      keyId,
      signedPackage
    ))
    .sort((a, b) => certificateExpiry(b) - certificateExpiry(a));
  if (!trusted.length) {
    throw new Error(`No active root-signed package certificate is available for keyId ${keyId}`);
  }
  return trusted[0];
}

export async function listActiveSigningKeyCertificates(config) {
  const rootPublicKey = await readRootPublicKey(config);
  const candidates = await readAllCertificateCandidates(config);
  const byKeyId = new Map();
  for (const certificate of candidates) {
    const keyId = certificate?.subject?.keyId;
    if (!safelyTrustCertificate(certificate, rootPublicKey.publicKeyPem, keyId)) continue;
    const existing = byKeyId.get(keyId);
    if (
      existing
      && existing.subject.fingerprintSha256 !== certificate.subject.fingerprintSha256
    ) {
      throw new Error(`Package signing keyId ${keyId} maps to multiple public keys`);
    }
    if (!existing || certificateExpiry(certificate) > certificateExpiry(existing)) {
      byKeyId.set(keyId, certificate);
    }
  }
  return [...byKeyId.values()].sort((a, b) =>
    String(a.subject.keyId).localeCompare(String(b.subject.keyId))
  );
}

export function verifyPayload(payload, signature, publicKeyPem) {
  const bytes = Buffer.from(canonicalJson(payload));
  return crypto.verify(null, bytes, publicKeyPem, Buffer.from(signature.signature, "base64"));
}

export function verifySigningKeyCertificate(certificate, rootPublicKeyPem) {
  try {
    if (!verifySigningKeyCertificateIntegrity(certificate, rootPublicKeyPem)) return false;
    return certificateExpiry(certificate) > Date.now();
  } catch {
    return false;
  }
}

async function archiveExistingCurrentCertificate(config, rootPublicKeyPem) {
  let certificate;
  try {
    certificate = JSON.parse(await fs.readFile(config.signing.certificatePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error(`Current package signing certificate cannot be preserved: ${error.message}`);
  }
  if (!verifySigningKeyCertificateIntegrity(certificate, rootPublicKeyPem)) {
    throw new Error("Current package signing certificate is not root-trusted and cannot be rotated");
  }
  await archiveSigningKeyCertificate(config, certificate, rootPublicKeyPem);
}

async function archiveSigningKeyCertificate(config, certificate, rootPublicKeyPem) {
  const keyId = certificate?.subject?.keyId;
  validateSigningKeyId(keyId);
  if (!verifySigningKeyCertificateIntegrity(certificate, rootPublicKeyPem)) {
    throw new Error("Package signing certificate cannot be archived because its trust chain is invalid");
  }
  const directory = signingCertificateKeyDir(config, keyId);
  const serialized = `${JSON.stringify(certificate, null, 2)}\n`;
  const certificateId = crypto.createHash("sha256").update(canonicalJson(certificate)).digest("hex");
  const target = path.join(directory, `${certificateId}.json`);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await assertKeyIdFingerprintIsStable(directory, certificate);
  await claimKeyIdFingerprint(directory, certificate);
  const temporary = path.join(
    directory,
    `.${certificateId}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  try {
    await writeSyncedFile(temporary, serialized, 0o644);
    await fs.link(temporary, target);
    await syncDirectory(directory);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let matches = false;
    try {
      const existing = JSON.parse(await fs.readFile(target, "utf8"));
      matches = canonicalJson(existing) === canonicalJson(certificate);
    } catch {
      matches = false;
    }
    if (!matches) {
      await writeFileAtomic(target, serialized, 0o644);
    }
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

function signingCertificateKeyDir(config, keyId) {
  const keyHash = crypto.createHash("sha256").update(keyId).digest("hex");
  return path.join(config.signing.certificateArchiveDir, keyHash);
}

function validateSigningKeyId(keyId) {
  if (
    typeof keyId !== "string"
    || keyId.length < 1
    || keyId.length > 240
    || !/^[A-Za-z0-9._:-]+$/.test(keyId)
  ) {
    throw new Error("Package signing keyId is invalid");
  }
}

function isTrustedSigningKeyCertificate(certificate, rootPublicKeyPem, expectedKeyId) {
  return (
    certificate?.subject?.keyId === expectedKeyId
    && certificate?.subject?.algorithm === "ed25519"
    && typeof certificate?.subject?.publicKeyPem === "string"
    && certificate.subject.fingerprintSha256 === fingerprintPublicKeyPem(certificate.subject.publicKeyPem)
    && verifySigningKeyCertificate(certificate, rootPublicKeyPem)
  );
}

function safelyTrustCertificate(certificate, rootPublicKeyPem, expectedKeyId, signedPackage) {
  try {
    if (!isTrustedSigningKeyCertificate(certificate, rootPublicKeyPem, expectedKeyId)) return false;
    if (!signedPackage) return true;
    return verifyPayload(
      signedPackage.payload,
      signedPackage.signature,
      certificate.subject.publicKeyPem
    );
  } catch {
    return false;
  }
}

function verifySigningKeyCertificateIntegrity(certificate, rootPublicKeyPem) {
  if (!certificate || typeof certificate !== "object") return false;
  const { signature, ...payload } = certificate;
  if (!signature) return false;
  if (!Array.isArray(payload.usages) || !payload.usages.includes("skillpkg.sign")) return false;
  if (!validCertificateWindow(payload.issuedAt, payload.expiresAt)) return false;
  return verifyPayload(payload, signature, rootPublicKeyPem);
}

function validCertificateWindow(issuedAt, expiresAt) {
  if (!isCanonicalIsoTime(issuedAt) || !isCanonicalIsoTime(expiresAt)) return false;
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  return issued < expires && issued <= Date.now() + 5 * 60 * 1000;
}

function assertCertificateWindow(issuedAt, expiresAt) {
  if (!validCertificateWindow(issuedAt, expiresAt) || Date.parse(expiresAt) <= Date.now()) {
    throw new Error("Package signing certificate validity window is invalid");
  }
}

function isCanonicalIsoTime(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

async function readCertificateCandidates(config, keyId) {
  const candidates = [];
  try {
    const current = JSON.parse(await fs.readFile(config.signing.certificatePath, "utf8"));
    if (current?.subject?.keyId === keyId) candidates.push(current);
  } catch {
    // Historical verification continues through the archive.
  }
  const directory = signingCertificateKeyDir(config, keyId);
  candidates.push(...await readCertificateDirectory(directory));
  return candidates;
}

async function readAllCertificateCandidates(config) {
  const candidates = [];
  try {
    candidates.push(JSON.parse(await fs.readFile(config.signing.certificatePath, "utf8")));
  } catch {
    // The current pointer is optional while a rotation is in progress.
  }
  try {
    const directories = await fs.readdir(config.signing.certificateArchiveDir, {
      withFileTypes: true
    });
    for (const entry of directories) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      candidates.push(...await readCertificateDirectory(
        path.join(config.signing.certificateArchiveDir, entry.name)
      ));
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return candidates;
}

async function readCertificateDirectory(directory) {
  const certificates = [];
  try {
    const names = await fs.readdir(directory);
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const certificate = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
        const expected = crypto.createHash("sha256").update(canonicalJson(certificate)).digest("hex");
        if (name !== `${expected}.json`) continue;
        certificates.push(certificate);
      } catch {
        // A malformed candidate never blocks other valid certificates.
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return certificates;
}

async function assertKeyIdFingerprintIsStable(directory, certificate) {
  for (const existing of await readCertificateDirectory(directory)) {
    if (
      existing?.subject?.keyId === certificate.subject.keyId
      && existing?.subject?.fingerprintSha256 !== certificate.subject.fingerprintSha256
    ) {
      throw new Error(`Package signing keyId ${certificate.subject.keyId} already belongs to another public key`);
    }
  }
}

async function claimKeyIdFingerprint(directory, certificate) {
  const binding = {
    schemaVersion: "1.0.0",
    keyId: certificate.subject.keyId,
    fingerprintSha256: certificate.subject.fingerprintSha256
  };
  const target = path.join(directory, "binding.json");
  const serialized = `${JSON.stringify(binding, null, 2)}\n`;
  const temporary = path.join(
    directory,
    `.binding.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  try {
    await writeSyncedFile(temporary, serialized, 0o644);
    await fs.link(temporary, target);
    await syncDirectory(directory);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let existing;
    try {
      existing = JSON.parse(await fs.readFile(target, "utf8"));
    } catch {
      throw new Error(`Package signing keyId ${binding.keyId} has an unreadable fingerprint binding`);
    }
    if (
      existing?.schemaVersion !== binding.schemaVersion
      || existing?.keyId !== binding.keyId
      || existing?.fingerprintSha256 !== binding.fingerprintSha256
    ) {
      throw new Error(`Package signing keyId ${binding.keyId} already belongs to another public key`);
    }
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

async function writeFileAtomic(filePath, content, mode) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  try {
    await writeSyncedFile(temporary, content, mode);
    await fs.rename(temporary, filePath);
    await syncDirectory(directory);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

async function writeSyncedFile(filePath, content, mode) {
  const handle = await fs.open(filePath, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
    // Windows and some mounted filesystems do not support directory fsync.
  } finally {
    await handle?.close().catch(() => {});
  }
}

function certificateExpiry(certificate) {
  const value = new Date(certificate?.expiresAt ?? 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map((item) => sortValue(item));
  if (value && typeof value === "object" && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortValue(item)])
    );
  }
  return value;
}
