import crypto from "node:crypto";
import { verifyPayload } from "../signing/index.js";

export async function searchSkills(baseUrl, { query = "", agentVersion = "", platform = "" } = {}) {
  const url = new URL("/api/skills", baseUrl);
  if (query) url.searchParams.set("q", query);
  if (agentVersion) url.searchParams.set("agent_version", agentVersion);
  if (platform) url.searchParams.set("platform", platform);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`SkillHub search failed: ${response.status}`);
  return response.json();
}

export async function getPublicKeys(baseUrl) {
  const response = await fetch(new URL("/api/trust/public-keys", baseUrl));
  if (!response.ok) throw new Error(`SkillHub public keys failed: ${response.status}`);
  return response.json();
}

export async function downloadAndVerifyPackage({
  packageUrl,
  checksumSha256,
  publicKeyPem,
  publicKeys
}) {
  const response = await fetch(packageUrl);
  if (!response.ok) throw new Error(`Package download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== checksumSha256) {
    throw new Error("Package checksum mismatch");
  }
  const packageObject = JSON.parse(bytes.toString("utf8"));
  const selectedKey = Array.isArray(publicKeys)
    ? publicKeys.find((key) => key?.keyId === packageObject?.signature?.keyId)?.publicKeyPem
    : publicKeyPem;
  if (typeof selectedKey !== "string" || !selectedKey) {
    throw new Error("Package signing key is not trusted");
  }
  const ok = verifyPayload(packageObject.payload, packageObject.signature, selectedKey);
  if (!ok) throw new Error("Package signature verification failed");
  return packageObject;
}
