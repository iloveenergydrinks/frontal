import { describe, expect, it } from "vitest";

import { NexusError } from "../src/errors.js";
import { canonicalJson, hashPlan, stringifyJson } from "../src/serialization.js";
import type { LaunchPlan } from "../src/types.js";

describe("canonical serialization", () => {
  it("sorts object keys and encodes bigint as decimal strings", () => {
    expect(canonicalJson({ z: 2n, a: { y: true, x: "ok" } })).toBe(
      '{"a":{"x":"ok","y":true},"z":"2"}',
    );
    expect(stringifyJson({ value: 123n })).toContain('"123"');
  });

  it("rejects values that cannot be committed to a plan", () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrowError(NexusError);
    expect(() => canonicalJson({ value: Symbol("unsafe") })).toThrowError(NexusError);
  });

  it("changes the plan hash when any committed field changes", () => {
    const plan = {
      schemaVersion: "1",
      adapter: { id: "flap-standard", version: "0.1.0" },
      chainId: 56,
      account: "0x1111111111111111111111111111111111111111",
      deployment: {
        address: "0x2222222222222222222222222222222222222222",
        protocolVersion: "test",
        runtimeCodeHash: `0x${"aa".repeat(32)}`,
      },
      preparedAt: { blockHash: `0x${"bb".repeat(32)}`, blockNumber: "1" },
      request: {
        token: {
          name: "Nexus",
          symbol: "NXS",
          description: "",
          image: "",
          socials: { discord: "", farcaster: "", telegram: "", twitter: "", website: "" },
        },
        launch: {},
      },
      snapshot: {},
      transaction: { to: "0x2222222222222222222222222222222222222222", data: "0x", value: "0" },
      expected: {},
      summary: { protocol: "test", pricing: "test", liquidity: "test", costs: [], rows: [] },
      warnings: [],
    } satisfies Omit<LaunchPlan, "id">;
    expect(hashPlan({ ...plan, chainId: 97 })).not.toBe(hashPlan(plan));
  });
});
