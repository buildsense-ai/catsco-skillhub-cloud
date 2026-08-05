import { loadConfig } from "../packages/config/index.js";
import { fingerprintPublicKeyPem, issueSigningKeyCertificate } from "../packages/signing/index.js";

const config = loadConfig();
const certificate = await issueSigningKeyCertificate(config);

console.log(`Issued SkillHub package signing key certificate:
subject: ${certificate.subject.keyId}
issuer: ${certificate.issuer.keyId}
expiresAt: ${certificate.expiresAt}
subject fingerprint: ${certificate.subject.fingerprintSha256}
certificate: ${config.signing.certificatePath}

Root public key fingerprint for Agent trust anchor:
${certificate.issuer.publicKeyFingerprintSha256}
`);

