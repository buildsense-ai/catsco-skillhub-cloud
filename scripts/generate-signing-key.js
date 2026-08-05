import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../packages/config/index.js";

const config = loadConfig({ allowAutoKeygen: true });
const force = process.argv.includes("--force");

await fs.mkdir(path.dirname(config.signing.privateKeyPath), { recursive: true, mode: 0o700 });
await fs.mkdir(path.dirname(config.signing.publicKeyPath), { recursive: true, mode: 0o700 });

if (!force) {
  const exists = await Promise.all([
    fs.stat(config.signing.privateKeyPath).then(() => true).catch(() => false),
    fs.stat(config.signing.publicKeyPath).then(() => true).catch(() => false)
  ]);
  if (exists.some(Boolean)) {
    console.error("Signing key already exists. Use --force only if you intentionally rotate or recreate local keys.");
    process.exit(1);
  }
}

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });

await fs.writeFile(config.signing.privateKeyPath, privateKeyPem, { mode: 0o600 });
await fs.writeFile(config.signing.publicKeyPath, publicKeyPem, { mode: 0o644 });

console.log(`Generated Ed25519 signing key:
key id: ${config.signing.keyId}
private: ${config.signing.privateKeyPath}
public:  ${config.signing.publicKeyPath}`);

