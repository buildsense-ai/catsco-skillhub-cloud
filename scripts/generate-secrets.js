import crypto from "node:crypto";

function token() {
  return crypto.randomBytes(32).toString("base64url");
}

console.log(`# Add these values to /opt/catsco/skillhub/shared/.env
SKILLHUB_SESSION_SECRET=${token()}${token()}
SKILLHUB_AGENT_CLIENT_SECRET=${token()}${token()}`);
