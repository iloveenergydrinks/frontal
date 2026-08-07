import { describe, expect, it } from "vitest";

import { NexusError } from "../src/errors.js";
import { decodePlanUrl, encodePlanUrl, PLAN_URL_VERSION } from "../src/plan-url.js";
import { hashPlan } from "../src/serialization.js";
import type { LaunchPlan } from "../src/types.js";

function samplePlan(): LaunchPlan {
  const withoutId = {
    account: "0x0731dD4Aad7B14363fc2e77ff934646e809A46D8",
    adapter: { id: "pons", version: "0.1.0" },
    chainId: 4663,
    deployment: {
      address: "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB",
      protocolVersion: "active-8991118",
      runtimeCodeHash: "0x0a62b8ed1d88d30c7b342ea8361dfaf0ac336706992cf0c8ba38b129f06391d4",
    },
    expected: { token: "0x0649E0F5119fb882DA44Cb35615820D95dE65ba3" },
    preparedAt: {
      blockHash: "0x678071f794d9be4f97e322feaa153045f448637dd92d9656d2fabd5518a1fe7f",
      blockNumber: "29833947",
    },
    request: {
      launch: { dexId: 0, initialBuy: "0", launchConfigId: 0 },
      token: {
        description: "Disposable validation token.",
        image: "ipfs://bafy",
        name: "Example",
        socials: { discord: "", farcaster: "", telegram: "", twitter: "", website: "https://cli.nexus/" },
        symbol: "EX",
      },
    },
    schemaVersion: "1",
    snapshot: { launchEnabled: true, launchFee: "500000000000000" },
    summary: {
      costs: [{ amount: "500000000000000", asset: "ETH", label: "Launch fee" }],
      liquidity: "Locked at launch.",
      pricing: "Fixed supply.",
      protocol: "Pons",
      rows: [{ label: "Factory", value: "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB" }],
    },
    transaction: { data: "0xdeadbeef", to: "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB", value: "500000000000000" },
    warnings: [{ code: "EXTERNAL_PROTOCOL", message: "Nexus has not audited Pons." }],
  } as unknown as Omit<LaunchPlan, "id">;
  return { ...withoutId, id: hashPlan(withoutId) } as LaunchPlan;
}

describe("plan links", () => {
  it("round-trips a plan through a URL fragment", async () => {
    const plan = samplePlan();
    const url = await encodePlanUrl(plan, "https://cli.nexus/launch");
    const decoded = await decodePlanUrl(url);
    expect(decoded).toEqual(plan);
    expect(decoded.id).toBe(plan.id);
  });

  it("keeps the plan in the fragment, which is never sent to a server", async () => {
    const url = new URL(await encodePlanUrl(samplePlan(), "https://cli.nexus/launch"));
    expect(url.search).toBe("");
    expect(url.pathname).toBe("/launch");
    expect(url.hash.startsWith(`#plan=${PLAN_URL_VERSION}.`)).toBe(true);
  });

  it("compresses well enough to paste into a chat message", async () => {
    const url = await encodePlanUrl(samplePlan(), "https://cli.nexus/launch");
    expect(url.length).toBeLessThan(4_000);
  });

  it("accepts a bare fragment as well as a full URL", async () => {
    const plan = samplePlan();
    const url = await encodePlanUrl(plan, "https://cli.nexus/launch");
    const fragment = url.slice(url.indexOf("#"));
    await expect(decodePlanUrl(fragment)).resolves.toEqual(plan);
    await expect(decodePlanUrl(fragment.slice(1))).resolves.toEqual(plan);
  });

  it("rejects a tampered payload instead of rendering a different transaction", async () => {
    const plan = samplePlan();
    const url = await encodePlanUrl(plan, "https://cli.nexus/launch");
    const tampered = `${url.slice(0, -4)}${url.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`;
    await expect(decodePlanUrl(tampered)).rejects.toThrow(NexusError);
  });

  it("rejects a plan whose contents no longer match its own ID", async () => {
    const plan = samplePlan();
    const forged = { ...plan, transaction: { ...plan.transaction, value: "999999999999999999" } };
    // The forged plan keeps the original ID, which is exactly the attack the
    // content hash exists to catch.
    const url = await encodePlanUrl(plan, "https://cli.nexus/launch");
    const decoded = await decodePlanUrl(url);
    expect(decoded.transaction.value).toBe(plan.transaction.value);
    await expect(encodePlanUrl(forged as LaunchPlan, "https://cli.nexus/launch")).rejects.toThrow(
      /Plan ID mismatch/u,
    );
  });

  it("refuses a plaintext link that could be rewritten in transit", async () => {
    await expect(encodePlanUrl(samplePlan(), "http://cli.nexus/launch")).rejects.toThrow(/https/u);
  });

  it("allows loopback for local testing", async () => {
    await expect(encodePlanUrl(samplePlan(), "http://127.0.0.1:4173/")).resolves.toContain("#plan=");
  });

  it("rejects an unknown payload version rather than guessing", async () => {
    await expect(decodePlanUrl("#plan=99.AAAA")).rejects.toThrow(/version 99/u);
  });

  it("reports a missing fragment clearly", async () => {
    await expect(decodePlanUrl("https://cli.nexus/launch")).rejects.toThrow(/no plan fragment/u);
  });
});
