/**
 * The agent relay.
 *
 * So that `npx nexus-launch` works with nothing to configure, the CLI points the
 * Anthropic SDK at this host instead of at Anthropic, and the operator's key is
 * added here on the way out. The key never leaves this process, so it is never
 * in the published package, in a user's shell, or on their disk.
 *
 * That means the operator pays for every conversation, which is the whole risk:
 * an open relay in front of a metered API is somebody else's budget. Everything
 * below exists to bound that — one narrow route, an allowlist of models, a cap
 * on output tokens, a per-address rate limit, and a request-size ceiling.
 */

const UPSTREAM = "https://api.anthropic.com";

/** Only the models the agent actually runs on, so nobody can bill a fleet through it. */
const MODELS = new Set(["claude-opus-5", "claude-opus-4-8"]);

const MAX_OUTPUT_TOKENS = 8_192;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_MESSAGES = 100;
const MAX_BUCKETS = 10_000;
const UPSTREAM_TIMEOUT_MS = 120_000;

const NEXUS_TOOLS = new Set([
  "get_signing_link",
  "list_adapters",
  "prepare_launch",
  "simulate_launch",
  "upload_flap_metadata",
  "verify_launch",
]);

/** Per-address budget: a burst for one conversation, refilled slowly. */
const RATE_CAPACITY = 20;
const RATE_REFILL_PER_MS = 20 / (60 * 60 * 1000);
const GLOBAL_RATE_CAPACITY = 120;
const GLOBAL_RATE_REFILL_PER_MS = 120 / (60 * 60 * 1000);

const buckets = new Map();
const globalBucket = { tokens: GLOBAL_RATE_CAPACITY, at: Date.now() };

function take(bucket, capacity, refillPerMs, now) {
  bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.at) * refillPerMs);
  bucket.at = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function allowed(address) {
  const now = Date.now();
  if (!take(globalBucket, GLOBAL_RATE_CAPACITY, GLOBAL_RATE_REFILL_PER_MS, now)) return false;
  if (!buckets.has(address) && buckets.size >= MAX_BUCKETS) return false;
  const bucket = buckets.get(address) ?? { tokens: RATE_CAPACITY, at: now };
  const permitted = take(bucket, RATE_CAPACITY, RATE_REFILL_PER_MS, now);
  buckets.set(address, bucket);
  return permitted;
}

// Bound the table so a spray of addresses cannot grow it without limit.
setInterval(() => {
  const now = Date.now();
  for (const [address, bucket] of buckets) {
    if (now - bucket.at > 2 * 60 * 60 * 1000) buckets.delete(address);
  }
}, 10 * 60 * 1000).unref();

export function clientAddress(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    // Reverse proxies append their observed peer to the right. The leftmost
    // value is user-controlled on many deployments and must not identify a
    // rate-limit bucket.
    return forwarded.split(",").at(-1).trim();
  }
  return request.socket.remoteAddress ?? "unknown";
}

export function validateRelayBody(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "Request body must be an object.";
  }
  if (!MODELS.has(body.model)) return "This host relays only the Nexus agent models.";
  if (!Number.isInteger(body.max_tokens) || body.max_tokens <= 0) {
    return "max_tokens must be a positive integer.";
  }
  if (typeof body.system !== "string" || !body.system.startsWith("You are Nexus, a terminal agent")) {
    return "This host relays only the Nexus agent system prompt.";
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > MAX_MESSAGES) {
    return `messages must contain between 1 and ${MAX_MESSAGES} entries.`;
  }
  if (body.messages.some((message) =>
    typeof message !== "object" || message === null || !["assistant", "user"].includes(message.role))) {
    return "messages contains an invalid role.";
  }
  if (!Array.isArray(body.tools) || body.tools.length !== NEXUS_TOOLS.size) {
    return "This host requires the exact Nexus tool set.";
  }
  const names = new Set(body.tools.map((tool) =>
    typeof tool === "object" && tool !== null ? tool.name : undefined));
  if (names.size !== NEXUS_TOOLS.size || [...NEXUS_TOOLS].some((name) => !names.has(name))) {
    return "This host requires the exact Nexus tool set.";
  }
  if (body.fallbacks !== undefined &&
    (!Array.isArray(body.fallbacks) || body.fallbacks.some((fallback) =>
      typeof fallback !== "object" || fallback === null || !MODELS.has(fallback.model)))) {
    return "This host relays only the Nexus agent fallback models.";
  }
  return undefined;
}

function refuse(response, status, message) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Returns true when it handled the request. */
export async function relay(request, response, pathname) {
  if (pathname !== "/v1/messages") return false;

  const key = process.env.ANTHROPIC_API_KEY;
  if (key === undefined || key.trim() === "") {
    refuse(response, 503, "This host is not configured to relay agent requests.");
    return true;
  }
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST" });
    response.end();
    return true;
  }
  if (!allowed(clientAddress(request))) {
    response.writeHead(429, { "content-type": "application/json; charset=utf-8", "retry-after": "300" });
    response.end(
      JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "Too many agent requests from this address. Try again shortly." },
      }),
    );
    return true;
  }

  const raw = await readBody(request);
  if (raw === undefined) {
    refuse(response, 413, "Request body is too large.");
    return true;
  }

  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    refuse(response, 400, "Request body is not valid JSON.");
    return true;
  }
  const invalid = validateRelayBody(body);
  if (invalid !== undefined) {
    refuse(response, 400, invalid);
    return true;
  }
  body.max_tokens = Math.min(body.max_tokens, MAX_OUTPUT_TOKENS);

  // Forward only what the API needs. The caller's own auth headers are dropped
  // rather than passed through, so this host's key is the only one in play.
  const headers = {
    "content-type": "application/json",
    "anthropic-version": request.headers["anthropic-version"] ?? "2023-06-01",
    "x-api-key": key,
  };
  const beta = request.headers["anthropic-beta"];
  if (typeof beta === "string") headers["anthropic-beta"] = beta;

  let upstream;
  try {
    upstream = await fetch(`${UPSTREAM}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    refuse(response, 502, "The agent upstream is unreachable.");
    return true;
  }

  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "cache-control": "no-store",
  });
  if (upstream.body === null) {
    response.end();
    return true;
  }
  for await (const chunk of upstream.body) response.write(chunk);
  response.end();
  return true;
}
