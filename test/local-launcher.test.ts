import { createServer } from "node:net";

import { getAddress, type Hash, type Hex, type PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";

import { prepareLaunch } from "../src/launch.js";
import { startLocalLauncher } from "../src/local-launcher.js";
import type { AdapterContext, LaunchAdapter } from "../src/types.js";

const account = getAddress("0x1111111111111111111111111111111111111111");
const deployment = getAddress("0x2222222222222222222222222222222222222222");
const blockHash = `0x${"ab".repeat(32)}` as Hash;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Unable to allocate a test port.");
  await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
  return address.port;
}

function adapter(): LaunchAdapter<{ note: string }> {
  return {
    capabilities: {
      creatorFees: false,
      deterministicTokenAddress: true,
      initialBuy: "unsupported",
      metadataStorage: ["onchain"],
      pricingModel: "bonding-curve",
      taxToken: false,
    },
    chainId: 56,
    id: "flap-standard",
    version: "local-test",
    prepare: vi.fn(async (context: AdapterContext<{ note: string }>) => ({
      deployment: {
        address: deployment,
        protocolVersion: "test",
        runtimeCodeHash: `0x${"ef".repeat(32)}` as Hash,
      },
      expected: { token: getAddress("0x3333333333333333333333333333333333333333") },
      launch: { note: context.launch.note },
      snapshot: { ready: true },
      summary: { costs: [], liquidity: "test", pricing: "test", protocol: "test", rows: [] },
      transaction: { data: "0x1234" as Hex, to: deployment, value: "0" },
      warnings: [],
    })),
    revalidate: vi.fn(async () => undefined),
    verify: vi.fn(async () => {
      throw new Error("not used");
    }),
  };
}

function publicClient(): PublicClient {
  return {
    call: vi.fn(async () => ({ data: "0xbeef" })),
    estimateGas: vi.fn(async () => 100n),
    getBalance: vi.fn(async () => 1_000n),
    getBlock: vi.fn(async () => ({ hash: blockHash, number: 12n })),
    getBlockNumber: vi.fn(async () => 12n),
    getChainId: vi.fn(async () => 56),
    getGasPrice: vi.fn(async () => 2n),
  } as unknown as PublicClient;
}

describe("localhost launcher", () => {
  it("serves only an approved plan with restrictive browser headers", async () => {
    const client = publicClient();
    const launchAdapter = adapter();
    const plan = await prepareLaunch({
      account,
      adapter: launchAdapter,
      launch: { note: "exact" },
      publicClient: client,
      token: { name: "Nexus", symbol: "NXS" },
    });
    const port = await freePort();
    const local = await startLocalLauncher({
      adapter: launchAdapter,
      approvedPlanId: plan.id,
      plan,
      port,
      publicClient: client,
    });
    try {
      const response = await fetch(local.url);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(html).toContain(plan.id);
      expect(html).not.toContain("privateKey");
    } finally {
      await local.close();
    }
  });

  it("rejects cross-origin simulation and accepts the page CSRF token", async () => {
    const client = publicClient();
    const launchAdapter = adapter();
    const plan = await prepareLaunch({
      account,
      adapter: launchAdapter,
      launch: { note: "exact" },
      publicClient: client,
      token: { name: "Nexus", symbol: "NXS" },
    });
    const port = await freePort();
    const local = await startLocalLauncher({
      adapter: launchAdapter,
      approvedPlanId: plan.id,
      plan,
      port,
      publicClient: client,
    });
    try {
      const denied = await fetch(`${local.url}/api/simulate`, { method: "POST" });
      expect(denied.status).toBe(403);
      const html = await (await fetch(local.url)).text();
      const csrf = /"csrfToken":"([0-9a-f]{64})"/u.exec(html)?.[1];
      expect(csrf).toBeDefined();
      const accepted = await fetch(`${local.url}/api/simulate`, {
        body: "{}",
        headers: {
          "content-type": "application/json",
          origin: local.url,
          "x-nexus-csrf": csrf ?? "",
        },
        method: "POST",
      });
      expect(accepted.status).toBe(200);
      await expect(accepted.json()).resolves.toMatchObject({
        data: { passed: true, planId: plan.id },
        ok: true,
        schemaVersion: "1.0",
      });
    } finally {
      await local.close();
    }
  });
});
