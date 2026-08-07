import { keccak256, stringToHex, type Hash } from "viem";

import { NexusError } from "./errors.js";
import type { JsonValue, LaunchPlan } from "./types.js";

function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new NexusError("INVALID_PLAN", "Plans cannot contain non-finite numbers.");
    return value;
  }
  if (typeof value === "bigint") return value.toString(10);
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) result[key] = canonicalize(member);
    }
    return result;
  }
  throw new NexusError("INVALID_PLAN", `Plans cannot contain values of type ${typeof value}.`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function hashPlan(plan: Omit<LaunchPlan, "id">): Hash {
  return keccak256(stringToHex(canonicalJson(plan)));
}

export function assertPlanId(plan: LaunchPlan): void {
  const { id, ...withoutId } = plan;
  const actual = hashPlan(withoutId);
  if (actual !== id) {
    throw new NexusError("INVALID_PLAN", `Plan ID mismatch: expected ${id}, reconstructed ${actual}.`);
  }
}

export function stringifyJson(value: unknown, pretty = true): string {
  return JSON.stringify(canonicalize(value), null, pretty ? 2 : undefined);
}
