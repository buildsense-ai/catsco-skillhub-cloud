import { AuthError, ValidationError } from "../domain/index.js";

const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;

export async function authenticateCatsCoBot(config, req, fetchImpl = fetch) {
  const authorization = String(req.headers.authorization ?? "");
  const apiKey = authorization.startsWith("ApiKey ")
    ? authorization.slice("ApiKey ".length).trim()
    : "";
  const claimedBotId = String(req.headers["x-catsco-bot-id"] ?? "").trim();
  if (!apiKey) throw authError("Bot API key is required.", "BOT_AUTH_REQUIRED", 401);
  if (!validBotId(claimedBotId)) {
    throw authError("Bot identity header is invalid.", "BOT_ID_INVALID", 400);
  }

  const baseUrl = normalizeCatsCoBaseUrl(config.botAuth?.catsCoBaseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.botAuth?.timeoutMs ?? 8_000);
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/api/bot/identity`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `ApiKey ${apiKey}`
      },
      redirect: "error",
      signal: controller.signal
    });
    const text = await readTextLimited(response, controller);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw authError("Bot API key is invalid.", "BOT_AUTH_INVALID", response.status);
      }
      throw authError("CatsCo bot authentication is unavailable.", "BOT_AUTH_UPSTREAM_UNAVAILABLE", 503);
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw authError("CatsCo bot authentication returned invalid data.", "BOT_AUTH_UPSTREAM_INVALID", 503);
    }
    const actualBotId = String(value?.uid ?? value?.botId ?? value?.bot_id ?? "").trim();
    if (!validBotId(actualBotId)) {
      throw authError("CatsCo bot authentication omitted the Bot identity.", "BOT_AUTH_UPSTREAM_INVALID", 503);
    }
    if (actualBotId !== claimedBotId) {
      throw authError("Bot API key does not match the declared Bot.", "BOT_BINDING_MISMATCH", 403);
    }
    return {
      botId: actualBotId,
      authority: baseUrl,
      actor: {
        id: `bot:${actualBotId}`,
        userId: null,
        role: "bot",
        roles: ["bot"],
        permissions: ["private_skill.read", "private_skill.write"]
      }
    };
  } catch (error) {
    if (error?.code) throw error;
    if (error?.name === "AbortError") {
      throw authError("CatsCo bot authentication timed out.", "BOT_AUTH_UPSTREAM_TIMEOUT", 503);
    }
    throw authError("CatsCo bot authentication failed.", "BOT_AUTH_UPSTREAM_UNAVAILABLE", 503);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeCatsCoBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value ?? "").trim());
  } catch {
    throw new ValidationError("CatsCo Bot auth base URL is invalid.", "BOT_AUTH_BASE_URL_INVALID", 500);
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
    throw new ValidationError("CatsCo Bot auth requires HTTPS.", "BOT_AUTH_BASE_URL_UNTRUSTED", 500);
  }
  return parsed.origin;
}

function isLoopback(hostname) {
  return ["127.0.0.1", "localhost", "::1"].includes(hostname);
}

function validBotId(value) {
  return /^[A-Za-z0-9._:-]{1,160}$/.test(value);
}

async function readTextLimited(response, controller) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_AUTH_RESPONSE_BYTES) {
    controller.abort();
    throw authError("CatsCo Bot auth response is too large.", "BOT_AUTH_UPSTREAM_INVALID", 503);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_AUTH_RESPONSE_BYTES) {
      controller.abort();
      throw authError("CatsCo Bot auth response is too large.", "BOT_AUTH_UPSTREAM_INVALID", 503);
    }
    chunks.push(Buffer.from(next.value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function authError(message, code, status) {
  const error = new AuthError(message, status);
  error.code = code;
  return error;
}
