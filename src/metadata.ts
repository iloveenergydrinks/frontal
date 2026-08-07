import { NexusError } from "./errors.js";
import type { NormalizedTokenMetadata, SocialLinks, TokenMetadata } from "./types.js";

const UNSAFE_UNICODE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/u;
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

export function normalizeMetadataText(value: string, field: string, required: boolean): string {
  const normalized = value.normalize("NFC").trim();
  if (required && normalized.length === 0) {
    throw new NexusError("INVALID_TOKEN_METADATA", `${field} is required.`);
  }
  if (UNSAFE_UNICODE.test(normalized) || UNPAIRED_SURROGATE.test(normalized)) {
    throw new NexusError("INVALID_TOKEN_METADATA", `${field} contains unsafe control or invisible characters.`);
  }
  return normalized;
}

export function normalizeHttpsUrl(value: string | undefined, field: string): string {
  if (value === undefined || value.trim() === "") return "";
  const cleaned = normalizeMetadataText(value, field, false);
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new NexusError("INVALID_TOKEN_METADATA", `${field} must be a valid HTTPS URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new NexusError("INVALID_TOKEN_METADATA", `${field} must use HTTPS.`);
  }
  return parsed.toString();
}

function cleanImage(value: string | undefined): string {
  if (value === undefined || value.trim() === "") return "";
  const cleaned = normalizeMetadataText(value, "image", false);
  if (cleaned.startsWith("ipfs://")) return cleaned;
  return normalizeHttpsUrl(cleaned, "image");
}

export function normalizeTokenMetadata(token: TokenMetadata): NormalizedTokenMetadata {
  const socials: SocialLinks = token.socials ?? {};
  return {
    name: normalizeMetadataText(token.name, "name", true),
    symbol: normalizeMetadataText(token.symbol, "symbol", true),
    description: normalizeMetadataText(token.description ?? "", "description", false),
    image: cleanImage(token.image),
    socials: {
      discord: normalizeHttpsUrl(socials.discord, "socials.discord"),
      farcaster: normalizeHttpsUrl(socials.farcaster, "socials.farcaster"),
      telegram: normalizeHttpsUrl(socials.telegram, "socials.telegram"),
      twitter: normalizeHttpsUrl(socials.twitter, "socials.twitter"),
      website: normalizeHttpsUrl(socials.website, "socials.website"),
    },
  };
}
