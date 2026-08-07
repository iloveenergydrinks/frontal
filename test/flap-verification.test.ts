import {
  concatHex,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { describe, expect, it, vi } from "vitest";

import {
  FLAP_BNB_PORTAL,
  FLAP_BNB_STANDARD_TOKEN_IMPLEMENTATION,
  flapPortalAbi,
  flapStandard,
} from "../src/adapters/flap-standard.js";
import type { LaunchPlan } from "../src/types.js";

const account = getAddress("0x1111111111111111111111111111111111111111");
const token = getAddress("0x2222222222222222222222222222222222222222");
const receiptBlockHash = `0x${"ab".repeat(32)}` as Hash;
const fallbackBlockHash = `0x${"bc".repeat(32)}` as Hash;
const transactionHash = `0x${"cd".repeat(32)}` as Hash;
const metadataCid = "bafytestmetadata";

function plan(): LaunchPlan {
  return {
    account,
    adapter: { id: "flap-standard", version: "0.1.0" },
    chainId: 56,
    deployment: {
      address: FLAP_BNB_PORTAL,
      protocolVersion: "test",
      runtimeCodeHash: `0x${"01".repeat(32)}`,
    },
    expected: { token },
    id: `0x${"02".repeat(32)}`,
    preparedAt: { blockHash: `0x${"03".repeat(32)}`, blockNumber: "99" },
    request: {
      launch: { metadataCid, predictedToken: token },
      token: {
        description: "",
        image: "",
        name: "Nexus",
        socials: { discord: "", farcaster: "", telegram: "", twitter: "", website: "" },
        symbol: "NXS",
      },
    },
    schemaVersion: "1",
    snapshot: {},
    summary: { costs: [], liquidity: "test", pricing: "test", protocol: "test", rows: [] },
    transaction: { data: "0x1234", to: FLAP_BNB_PORTAL, value: "0" },
    warnings: [],
  };
}

function receipt(): TransactionReceipt {
  const topics = encodeEventTopics({ abi: flapPortalAbi, eventName: "TokenCreated" });
  const data = encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "address" },
      { type: "uint256" },
      { type: "address" },
      { type: "string" },
      { type: "string" },
      { type: "string" },
    ],
    [1n, account, 7n, token, "Nexus", "NXS", metadataCid],
  );
  return {
    blockHash: receiptBlockHash,
    blockNumber: 100n,
    contractAddress: null,
    cumulativeGasUsed: 100n,
    effectiveGasPrice: 1n,
    from: account,
    gasUsed: 100n,
    logs: [
      {
        address: FLAP_BNB_PORTAL,
        blockHash: receiptBlockHash,
        blockNumber: 100n,
        data,
        logIndex: 0,
        removed: false,
        topics: topics as [Hex, ...Hex[]],
        transactionHash,
        transactionIndex: 0,
      },
    ],
    logsBloom: `0x${"00".repeat(256)}`,
    status: "success",
    to: FLAP_BNB_PORTAL,
    transactionHash,
    transactionIndex: 0,
    type: "eip1559",
  };
}

describe("Flap launch verification", () => {
  it("pins and rechecks current state when the RPC prunes receipt-block state", async () => {
    const cloneRuntime = concatHex([
      "0x363d3d373d3d3d363d73",
      FLAP_BNB_STANDARD_TOKEN_IMPLEMENTATION,
      "0x5af43d82803e903d91602b57fd5bf3",
    ]);
    const client = {
      getBlock: vi.fn(async () => ({ hash: fallbackBlockHash, number: 110n })),
      getBlockNumber: vi.fn(async () => 110n),
      getCode: vi.fn(async ({ blockNumber }: { blockNumber?: bigint }) => {
        if (blockNumber === 100n) throw new Error("missing trie node: historical state is pruned");
        return cloneRuntime;
      }),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === "name") return "Nexus";
        if (functionName === "symbol") return "NXS";
        return metadataCid;
      }),
    } as unknown as PublicClient;

    const result = await flapStandard().verify(client, plan(), receipt());

    expect(result).toMatchObject({
      stateVerification: {
        blockHash: fallbackBlockHash,
        blockNumber: "110",
        mode: "current-fallback",
      },
      token,
      verified: true,
    });
    expect(client.getBlock).toHaveBeenCalledTimes(2);
    expect(client.readContract).toHaveBeenCalledTimes(3);
  });
});
