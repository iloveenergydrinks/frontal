import { getAddress, type Address, type Hash, type PublicClient, type TransactionReceipt, type WalletClient } from "viem";
import { describe, expect, it, vi } from "vitest";

import { prepareLaunch, sendLaunch, simulateLaunch, verifyLaunch } from "../src/launch.js";
import { hashPlan } from "../src/serialization.js";
import type { AdapterContext, AdapterPreparation, LaunchAdapter, LaunchPlan, LaunchResult } from "../src/types.js";

const account = getAddress("0x1111111111111111111111111111111111111111");
const deployment = getAddress("0x2222222222222222222222222222222222222222");
const token = getAddress("0x3333333333333333333333333333333333333333");
const blockHash = `0x${"ab".repeat(32)}` as Hash;
const transactionHash = `0x${"cd".repeat(32)}` as Hash;

interface TestLaunch {
  note: string;
}

function preparation(context: AdapterContext<TestLaunch>): AdapterPreparation {
  return {
    deployment: {
      address: deployment,
      protocolVersion: "test-v1",
      runtimeCodeHash: `0x${"ef".repeat(32)}`,
    },
    expected: { token },
    launch: { note: context.launch.note },
    snapshot: { epoch: "1" },
    summary: {
      costs: [{ amount: "7", asset: "ETH", label: "Launch fee" }],
      liquidity: "locked",
      pricing: "curve",
      protocol: "test",
      rows: [{ label: "Token", value: token }],
    },
    transaction: { data: "0x1234", to: deployment, value: "7" },
    warnings: [{ code: "TEST", message: "Test adapter" }],
  };
}

function adapter(): LaunchAdapter<TestLaunch> {
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
    version: "test-v1",
    prepare: vi.fn(async (context: AdapterContext<TestLaunch>) => preparation(context)),
    revalidate: vi.fn(async () => undefined),
    verify: vi.fn(async (_client, plan, receipt): Promise<LaunchResult> => ({
      adapterId: "flap-standard",
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber.toString(10),
      chainId: 56,
      planId: plan.id,
      protocol: "test",
      receipt,
      token,
      transactionHash: receipt.transactionHash,
      verified: true,
    })),
  };
}

function receipt(): TransactionReceipt {
  return {
    blockHash,
    blockNumber: 12n,
    contractAddress: null,
    cumulativeGasUsed: 100n,
    effectiveGasPrice: 2n,
    from: account,
    gasUsed: 100n,
    logs: [],
    logsBloom: `0x${"00".repeat(256)}`,
    status: "success",
    to: deployment,
    transactionHash,
    transactionIndex: 0,
    type: "eip1559",
  };
}

function publicClient(overrides: Record<string, unknown> = {}): PublicClient {
  const launchReceipt = receipt();
  return {
    call: vi.fn(async () => ({ data: "0xbeef" })),
    estimateGas: vi.fn(async () => 100n),
    getBalance: vi.fn(async () => 1_000n),
    getBlock: vi.fn(async () => ({ hash: blockHash, number: 12n })),
    getBlockNumber: vi.fn(async () => 12n),
    getChainId: vi.fn(async () => 56),
    getGasPrice: vi.fn(async () => 2n),
    getTransaction: vi.fn(async () => ({
      blockHash,
      from: account,
      hash: transactionHash,
      input: "0x1234",
      to: deployment,
      value: 7n,
    })),
    getTransactionReceipt: vi.fn(async () => launchReceipt),
    waitForTransactionReceipt: vi.fn(async () => launchReceipt),
    ...overrides,
  } as unknown as PublicClient;
}

async function plan(client = publicClient(), launchAdapter = adapter()): Promise<LaunchPlan> {
  return prepareLaunch({
    account,
    adapter: launchAdapter,
    launch: { note: "exact" },
    publicClient: client,
    token: { name: "Nexus", symbol: "NXS" },
  });
}

describe("guarded launch workflow", () => {
  it("prepares and simulates an exact reconstructed transaction", async () => {
    const client = publicClient();
    const launchAdapter = adapter();
    const launchPlan = await plan(client, launchAdapter);
    const simulation = await simulateLaunch({ adapter: launchAdapter, plan: launchPlan, publicClient: client });
    expect(simulation.passed).toBe(true);
    expect(simulation.funding).toMatchObject({
      balance: "1000",
      estimatedGasCost: "200",
      gasBuffer: "40",
      required: "247",
      shortfall: "0",
      transactionValue: "7",
    });
    expect(launchAdapter.prepare).toHaveBeenCalledTimes(2);
  });

  it("rejects a self-hashed plan whose transaction does not reconstruct", async () => {
    const client = publicClient();
    const launchAdapter = adapter();
    const valid = await plan(client, launchAdapter);
    const { id: _oldId, ...tamperedWithoutId } = {
      ...valid,
      transaction: { ...valid.transaction, to: getAddress("0x4444444444444444444444444444444444444444") },
    };
    const tampered: LaunchPlan = { ...tamperedWithoutId, id: hashPlan(tamperedWithoutId) };
    await expect(
      simulateLaunch({ adapter: launchAdapter, plan: tampered, publicClient: client }),
    ).rejects.toMatchObject({ code: "PLAN_CHANGED" });
  });

  it("verifies sender, exact calldata, value, receipt, and canonical block", async () => {
    const client = publicClient();
    const launchAdapter = adapter();
    const launchPlan = await plan(client, launchAdapter);
    const result = await verifyLaunch({
      adapter: launchAdapter,
      hash: transactionHash,
      plan: launchPlan,
      publicClient: client,
    });
    expect(result).toMatchObject({ token, transactionHash, verified: true });
  });

  it("rejects a successful receipt whose transaction input differs", async () => {
    const client = publicClient({
      getTransaction: vi.fn(async () => ({
        blockHash,
        from: account,
        hash: transactionHash,
        input: "0xdead",
        to: deployment,
        value: 7n,
      })),
    });
    const launchAdapter = adapter();
    const launchPlan = await plan(client, launchAdapter);
    await expect(
      verifyLaunch({ adapter: launchAdapter, hash: transactionHash, plan: launchPlan, publicClient: client }),
    ).rejects.toMatchObject({ broadcast: true, code: "LAUNCH_VERIFICATION_FAILED" });
  });

  it("distinguishes wallet rejection from an unknown submission outcome", async () => {
    const client = publicClient();
    const launchAdapter = adapter();
    const launchPlan = await plan(client, launchAdapter);
    const wallet = (message: string) =>
      ({
        account: { address: account },
        chain: { id: 56 },
        sendTransaction: vi.fn(async () => {
          throw new Error(message);
        }),
      }) as unknown as WalletClient;

    await expect(
      sendLaunch({ adapter: launchAdapter, plan: launchPlan, publicClient: client, walletClient: wallet("User rejected") }),
    ).rejects.toMatchObject({ broadcast: false, code: "WALLET_REJECTED" });
    await expect(
      sendLaunch({ adapter: launchAdapter, plan: launchPlan, publicClient: client, walletClient: wallet("timeout") }),
    ).rejects.toMatchObject({ broadcast: true, code: "RPC_ERROR" });
  });

  it("rejects an underfunded account before opening a broadcast path", async () => {
    const client = publicClient({ getBalance: vi.fn(async (_args: { address: Address }) => 1n) });
    const launchAdapter = adapter();
    const launchPlan = await plan(client, launchAdapter);
    await expect(
      sendLaunch({
        adapter: launchAdapter,
        plan: launchPlan,
        publicClient: client,
        walletClient: { account: { address: account } } as unknown as WalletClient,
      }),
    ).rejects.toMatchObject({ broadcast: false, code: "INSUFFICIENT_FUNDS" });
  });
});
