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

const MAX_OUTPUT_TOKENS = 64_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Per-address budget: a burst for one conversation, refilled slowly. */
const RATE_CAPACITY = 40;
const RATE_REFILL_PER_MS = 40 / (60 * 60 * 1000);

const buckets = new Map();

function allowed(address) {
  const now = Date.now();
  const bucket = buckets.get(address) ?? { tokens: RATE_CAPACITY, at: now };
  bucket.tokens = Math.min(RATE_CAPACITY, bucket.tokens + (now - bucket.at) * RATE_REFILL_PER_MS);
  bucket.at = now;
  if (bucket.tokens < 1) {
    buckets.set(address, bucket);
    return false;
  }
  bucket.tokens -= 1;
  buckets.set(address, bucket);
  return true;
}

// Bound the table so a spray of addresses cannot grow it without limit.
setInterval(() => {
  const now = Date.now();
  for (const [address, bucket] of buckets) {
    if (now - bucket.at > 2 * 60 * 60 * 1000) buckets.delete(address);
  }
}, 10 * 60 * 1000).unref();

function client(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return request.socket.remoteAddress ?? "unknown";
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
  if (!allowed(client(request))) {
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
  if (typeof body !== "object" || body === null || !MODELS.has(body.model)) {
    refuse(response, 400, "This host relays only the Nexus agent models.");
    return true;
  }
  if (typeof body.max_tokens === "number" && body.max_tokens > MAX_OUTPUT_TOKENS) {
    body.max_tokens = MAX_OUTPUT_TOKENS;
  }

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
