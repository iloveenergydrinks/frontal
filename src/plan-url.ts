import { NexusError } from "./errors.js";
import { parseLaunchPlan } from "./launch.js";
import { canonicalJson } from "./serialization.js";
import type { LaunchPlan } from "./types.js";

/**
 * Carries a launch plan to a signing page inside a URL fragment.
 *
 * The fragment is chosen over a plan ID and server-side storage on purpose: a
 * fragment is never sent to a server, so no host sits between the plan and the
 * human reviewing it. Approval means something only when the plan displayed is
 * the plan signed, and a server in the middle can break that silently.
 *
 * Tampering is caught rather than trusted. `parseLaunchPlan` recomputes the
 * content hash and rejects any plan whose bytes no longer match its own ID, so
 * an edited link fails to decode instead of rendering a different transaction.
 * The signing page must still show the decoded plan ID for the human to compare
 * against the one they approved, and still revalidate against live chain state.
 *
 * Uses `CompressionStream`, which exists in browsers and in Node 18 or newer, so
 * this module stays usable on both sides of the handoff.
 */

export const PLAN_URL_KEY = "plan";
export const PLAN_URL_VERSION = "1";

/** Refuses to decode anything larger than this before allocating. */
export const PLAN_URL_MAX_ENCODED_BYTES = 512 * 1024;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
  return base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new NexusError("INVALID_PLAN", "Plan link payload is not base64url.");
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  if (typeof atob === "function") {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  return new Uint8Array(Buffer.from(padded, "base64"));
}

async function through(bytes: Uint8Array, transform: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform as ReadableWritablePair);
  const buffer = await new Response(stream as BodyInit).arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Encodes an exact plan into a signing URL. Throws if the plan's bytes do not
 * hash to its own ID, so a malformed plan cannot be handed off in the first
 * place.
 */
export async function encodePlanUrl(plan: LaunchPlan, baseUrl: string): Promise<string> {
  parseLaunchPlan(canonicalJson(plan));
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (cause) {
    throw new NexusError("INVALID_ARGUMENT", `${baseUrl} is not a valid URL.`, { cause });
  }
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new NexusError(
      "INVALID_ARGUMENT",
      "A plan link must use https, or loopback for local testing. A plaintext link can be rewritten in transit.",
    );
  }
  const json = new TextEncoder().encode(canonicalJson(plan));
  const compressed = await through(json, new CompressionStream("gzip"));
  url.hash = `${PLAN_URL_KEY}=${PLAN_URL_VERSION}.${toBase64Url(compressed)}`;
  return url.toString();
}

/**
 * Decodes a plan from a full URL or a bare fragment. The returned plan is
 * verified against its own content hash; it is not yet verified against chain
 * state, which remains the caller's job before anything is signed.
 */
export async function decodePlanUrl(input: string): Promise<LaunchPlan> {
  let fragment = input;
  const hashIndex = input.indexOf("#");
  if (hashIndex !== -1) fragment = input.slice(hashIndex + 1);
  if (fragment.startsWith("#")) fragment = fragment.slice(1);

  const parameters = new URLSearchParams(fragment);
  const payload = parameters.get(PLAN_URL_KEY);
  if (payload === null || payload === "") {
    throw new NexusError("INVALID_PLAN", `The link has no ${PLAN_URL_KEY} fragment.`);
  }
  const separator = payload.indexOf(".");
  if (separator === -1) {
    throw new NexusError("INVALID_PLAN", "Plan link payload has no version prefix.");
  }
  const version = payload.slice(0, separator);
  if (version !== PLAN_URL_VERSION) {
    throw new NexusError(
      "INVALID_PLAN",
      `Plan link version ${version} is not supported; this build reads version ${PLAN_URL_VERSION}.`,
    );
  }
  const body = payload.slice(separator + 1);
  if (body.length > PLAN_URL_MAX_ENCODED_BYTES) {
    throw new NexusError("INVALID_PLAN", "Plan link payload is too large.");
  }
  const compressed = fromBase64Url(body);
  let json: string;
  try {
    json = new TextDecoder().decode(await through(compressed, new DecompressionStream("gzip")));
  } catch (cause) {
    throw new NexusError("INVALID_PLAN", "Plan link payload is not valid gzip data.", { cause });
  }
  return parseLaunchPlan(json);
}
