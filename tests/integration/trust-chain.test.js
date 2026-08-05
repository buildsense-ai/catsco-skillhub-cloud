import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../../packages/config/index.js";
import {
  createSigningKeyCertificate,
  ensureRootKey,
  ensureSigningKey,
  fingerprintPublicKeyPem,
  verifySigningKeyCertificate
} from "../../packages/signing/index.js";

test("root key signs package signing key certificates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "catsco-skillhub-trust-"));
  try {
    const config = loadConfig({
      root,
      storageRoot: path.join(root, "storage"),
      logsRoot: path.join(root, "logs"),
      sharedRoot: path.join(root, "shared"),
      allowAutoKeygen: true,
      allowAutoRootKeygen: true,
      nodeEnv: "test"
    });
    const rootKey = await ensureRootKey(config);
    const signingKey = await ensureSigningKey(config);
    const certificate = createSigningKeyCertificate({
      rootKey,
      signingKey,
      expiresAt: "2027-01-01T00:00:00.000Z"
    });

    assert.equal(certificate.issuer.keyId, rootKey.keyId);
    assert.equal(certificate.subject.keyId, signingKey.keyId);
    assert.equal(certificate.subject.fingerprintSha256, fingerprintPublicKeyPem(signingKey.publicKeyPem));
    assert.equal(verifySigningKeyCertificate(certificate, rootKey.publicKeyPem), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

