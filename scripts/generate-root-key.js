import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../packages/config/index.js";
import { fingerprintPublicKeyPem } from "../packages/signing/index.js";

const config = loadConfig({ allowAutoRootKeygen: true });
const force = process.argv.includes("--force");

await fs.mkdir(path.dirname(config.rootSigning.privateKeyPath), { recursive: true, mode: 0o700 });
await fs.mkdir(path.dirname(config.rootSigning.publicKeyPath), { recursive: true, mode: 0o700 });

if (!force) {
  const exists = await Promise.all([
    fs.stat(config.rootSigning.privateKeyPath).then(() => true).catch(() => false),
    fs.stat(config.rootSigning.publicKeyPath).then(() => true).catch(() => false)
  ]);
  if (exists.some(Boolean)) {
    console.error("Root signing key already exists. Use --force only for an intentional root rotation ceremony.");
    process.exit(1);
  }
}

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });

await fs.writeFile(config.rootSigning.privateKeyPath, privateKeyPem, { mode: 0o600 });
await fs.writeFile(config.rootSigning.publicKeyPath, publicKeyPem, { mode: 0o644 });

console.log(`Generated CatsCo root Ed25519 key:
key id: ${config.rootSigning.keyId}
fingerprint: ${fingerprintPublicKeyPem(publicKeyPem)}
private: ${config.rootSigning.privateKeyPath}
public:  ${config.rootSigning.publicKeyPath}

Embed this public key into CatsCo Agent trusted roots before release:

${publicKeyPem}`);

