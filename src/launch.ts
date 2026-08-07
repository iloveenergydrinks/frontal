import {
  getAddress,
  numberToHex,
  type Hash,
  type PublicClient,
} from "viem";

import { nativeSymbol } from "./chains.js";
import { NexusError, toNexusError } from "./errors.js";
import { normalizeTokenMetadata } from "./metadata.js";
import { assertPlanId, canonicalJson, hashPlan } from "./serialization.js";
import type {
  AdapterPreparation,
  LaunchPlan,
  LaunchResult,
  LaunchSimulation,
  PrepareLaunchParameters,
  SendLaunchParameters,
  SimulateLaunchParameters,
  VerifyLaunchParameters,
} from "./types.js";

async function pinnedLatestBlock(publicClient: PublicClient): Promise<{
  hash: Hash;
  number: bigint;
}> {
  const first = await publicClient.getBlock({ blockTag: "latest" });
  if (first.hash === null) throw new NexusError("RPC_ERROR", "Latest block has no hash.");
  const pinned = await publicClient.getBlock({ blockNumber: first.number });
  if (pinned.hash === null || pinned.hash !== first.hash) {
    throw new NexusError(
      "RPC_ERROR",
      "The latest block changed during state collection. Retry preparation on a stable RPC head.",
    );
  }
  return { hash: first.hash, number: first.number };
}

async function reconstructPlan<TLaunch>(
  adapter: SimulateLaunchParameters<TLaunch>["adapter"],
  plan: LaunchPlan,
  publicClient: PublicClient,
): Promise<AdapterPreparation> {
  const block = await pinnedLatestBlock(publicClient);
  const normalizedToken = normalizeTokenMetadata(plan.request.token);
  if (canonicalJson(normalizedToken) !== canonicalJson(plan.request.token)) {
    throw new NexusError("INVALID_PLAN", "The plan contains non-canonical token metadata.");
  }
  const reconstructed = await adapter.prepare({
    account: plan.account,
    blockHash: block.hash,
    blockNumber: block.number,
    launch: plan.request.launch as TLaunch,
    publicClient,
    token: normalizedToken,
  });
  const committed = {
    deployment: plan.deployment,
    expected: plan.expected,
    launch: plan.request.launch,
    snapshot: plan.snapshot,
    summary: plan.summary,
    transaction: plan.transaction,
    warnings: plan.warnings,
  };
  if (canonicalJson(reconstructed) !== canonicalJson(committed)) {
    throw new NexusError(
      "PLAN_CHANGED",
      "The exact launch plan no longer reconstructs from current protocol state. Prepare and approve a new plan.",
    );
  }
  const pinned = await publicClient.getBlock({ blockNumber: block.number });
  if (pinned.hash === null || pinned.hash !== block.hash) {
    throw new NexusError(
      "RPC_ERROR",
      "The pinned block changed during plan reconstruction. Retry on a stable RPC head.",
    );
  }
  return reconstructed;
}

function assertAdapterMatches<TLaunch>(
  adapter: SimulateLaunchParameters<TLaunch>["adapter"],
  plan: LaunchPlan,
): void {
  assertPlanId(plan);
  if (adapter.id !== plan.adapter.id || adapter.version !== plan.adapter.version) {
    throw new NexusError("INVALID_PLAN", "The supplied adapter does not match the saved launch plan.");
  }
  if (adapter.chainId !== plan.chainId) {
    throw new NexusError("INVALID_PLAN", "The adapter chain does not match the saved launch plan.");
  }
}

async function assertChain(publicClient: PublicClient, expectedChainId: number): Promise<void> {
  const chainId = await publicClient.getChainId();
  if (chainId !== expectedChainId) {
    throw new NexusError(
      "UNSUPPORTED_CHAIN",
      `Adapter requires chain ${expectedChainId}, but the RPC returned chain ${chainId}.`,
    );
  }
}

export async function prepareLaunch<TLaunch>(
  parameters: PrepareLaunchParameters<TLaunch>,
): Promise<LaunchPlan> {
  const { account, adapter, launch, publicClient } = parameters;
  await assertChain(publicClient, adapter.chainId);
  const block = await pinnedLatestBlock(publicClient);
  const token = normalizeTokenMetadata(parameters.token);
  const prepared = await adapter.prepare({
    account: getAddress(account),
    blockHash: block.hash,
    blockNumber: block.number,
    launch,
    publicClient,
    token,
  });

  const withoutId: Omit<LaunchPlan, "id"> = {
    schemaVersion: "1",
    adapter: { id: adapter.id, version: adapter.version },
    chainId: adapter.chainId,
    account: getAddress(account),
    deployment: prepared.deployment,
    preparedAt: { blockHash: block.hash, blockNumber: block.number.toString(10) },
    request: { token, launch: prepared.launch },
    snapshot: prepared.snapshot,
    transaction: prepared.transaction,
    expected: prepared.expected,
    summary: prepared.summary,
    warnings: prepared.warnings,
  };
  const pinned = await publicClient.getBlock({ blockNumber: block.number });
  if (pinned.hash === null || pinned.hash !== block.hash) {
    throw new NexusError(
      "RPC_ERROR",
      "The pinned block changed during launch preparation. Retry on a stable RPC head.",
    );
  }
  return { ...withoutId, id: hashPlan(withoutId) };
}

export async function simulateLaunch<TLaunch>(
  parameters: SimulateLaunchParameters<TLaunch>,
): Promise<LaunchSimulation> {
  const { adapter, plan, publicClient } = parameters;
  assertAdapterMatches(adapter, plan);
  await assertChain(publicClient, plan.chainId);
  await reconstructPlan(adapter, plan, publicClient);
  await adapter.revalidate(publicClient, plan);
  const transaction = {
    account: plan.account,
    data: plan.transaction.data,
    to: plan.transaction.to,
    value: BigInt(plan.transaction.value),
  } as const;

  let gasEstimate: bigint;
  let returnData: `0x${string}` | undefined;
  try {
    const [call, estimate] = await Promise.all([
      publicClient.call(transaction),
      publicClient.estimateGas(transaction),
    ]);
    gasEstimate = estimate;
    returnData = call.data;
  } catch (cause) {
    throw new NexusError("SIMULATION_REVERTED", "The exact launch transaction reverted during simulation.", {
      cause,
      recovery: "Inspect the protocol error, prepare a new plan, and do not submit this transaction.",
    });
  }

  const [balance, gasPrice, blockNumber] = await Promise.all([
    publicClient.getBalance({ address: plan.account }),
    publicClient.getGasPrice(),
    publicClient.getBlockNumber(),
  ]);
  const gasCost = gasEstimate * gasPrice;
  const gasBufferBps = BigInt(parameters.gasBufferBps ?? 2_000);
  if (gasBufferBps < 0n || gasBufferBps > 10_000n) {
    throw new NexusError("INVALID_ARGUMENT", "gasBufferBps must be between 0 and 10000.");
  }
  const gasBuffer = (gasCost * gasBufferBps) / 10_000n;
  const transactionValue = BigInt(plan.transaction.value);
  const required = transactionValue + gasCost + gasBuffer;
  const shortfall = balance >= required ? 0n : required - balance;

  return {
    passed: true,
    planId: plan.id,
    blockNumber: blockNumber.toString(10),
    gasEstimate: gasEstimate.toString(10),
    ...(returnData === undefined ? {} : { returnData }),
    funding: {
      account: plan.account,
      asset: nativeSymbol(plan.chainId),
      balance: balance.toString(10),
      estimatedGas: gasEstimate.toString(10),
      estimatedGasCost: gasCost.toString(10),
      gasBuffer: gasBuffer.toString(10),
      transactionValue: transactionValue.toString(10),
      required: required.toString(10),
      shortfall: shortfall.toString(10),
    },
  };
}

export async function sendLaunch<TLaunch>(parameters: SendLaunchParameters<TLaunch>): Promise<Hash> {
  const simulation = await simulateLaunch(parameters);
  if (BigInt(simulation.funding.shortfall) > 0n) {
    throw new NexusError(
      "INSUFFICIENT_FUNDS",
      `${simulation.funding.account} is short ${simulation.funding.shortfall} ${simulation.funding.asset} base units.`,
      { recovery: "Fund the exact address on the exact chain, then simulate the unchanged plan again." },
    );
  }
  const walletAccount = parameters.walletClient.account;
  if (walletAccount !== undefined && walletAccount !== null && getAddress(walletAccount.address) !== parameters.plan.account) {
    throw new NexusError("INVALID_ARGUMENT", "The connected wallet account does not match the launch plan.");
  }
  try {
    return await parameters.walletClient.sendTransaction({
      account: parameters.plan.account,
      chain: parameters.walletClient.chain,
      data: parameters.plan.transaction.data,
      to: parameters.plan.transaction.to,
      value: BigInt(parameters.plan.transaction.value),
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const rejected = /reject|denied|cancel/u.test(message.toLowerCase());
    throw new NexusError(rejected ? "WALLET_REJECTED" : "RPC_ERROR", message, {
      broadcast: !rejected,
      cause,
      recovery: rejected
        ? "No transaction was authorized."
        : "The submission outcome is unknown. Reconcile the sender nonce and wallet activity before retrying.",
    });
  }
}

export async function verifyLaunch<TLaunch>(
  parameters: VerifyLaunchParameters<TLaunch>,
): Promise<LaunchResult> {
  const { adapter, hash, plan, publicClient } = parameters;
  assertAdapterMatches(adapter, plan);
  await assertChain(publicClient, plan.chainId);
  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      confirmations: parameters.confirmations ?? 1,
      hash,
    });
  } catch (cause) {
    throw new NexusError("RECEIPT_NOT_FOUND", `No confirmed receipt was found for ${hash}.`, {
      broadcast: true,
      cause,
      recovery: "Reconcile the transaction hash and sender nonce before considering any resubmission.",
    });
  }
  if (receipt.status !== "success") {
    throw new NexusError("TRANSACTION_REVERTED", `Transaction ${hash} reverted.`, { broadcast: true });
  }
  if (
    getAddress(receipt.from) !== plan.account ||
    receipt.to === null ||
    getAddress(receipt.to) !== plan.transaction.to
  ) {
    throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Receipt sender or target does not match the launch plan.", {
      broadcast: true,
    });
  }
  const [transaction, canonicalBlock] = await Promise.all([
    publicClient.getTransaction({ hash }),
    publicClient.getBlock({ blockNumber: receipt.blockNumber }),
  ]);
  if (
    getAddress(transaction.from) !== plan.account ||
    transaction.to === null ||
    getAddress(transaction.to) !== plan.transaction.to ||
    transaction.input !== plan.transaction.data ||
    transaction.value !== BigInt(plan.transaction.value) ||
    transaction.blockHash !== receipt.blockHash ||
    canonicalBlock.hash !== receipt.blockHash
  ) {
    throw new NexusError(
      "LAUNCH_VERIFICATION_FAILED",
      "Confirmed transaction or canonical block does not match the exact launch plan.",
      { broadcast: true },
    );
  }
  let result: LaunchResult;
  try {
    result = await adapter.verify(publicClient, plan, receipt);
  } catch (cause) {
    const error = toNexusError(cause, "LAUNCH_VERIFICATION_FAILED");
    if (error.broadcast) throw error;
    throw new NexusError(error.code, error.message, {
      broadcast: true,
      cause,
      ...(error.details === undefined ? {} : { details: error.details }),
      ...(error.recovery === undefined ? {} : { recovery: error.recovery }),
    });
  }
  const [finalReceipt, finalBlock] = await Promise.all([
    publicClient.getTransactionReceipt({ hash }),
    publicClient.getBlock({ blockNumber: receipt.blockNumber }),
  ]);
  if (
    finalReceipt.status !== "success" ||
    finalReceipt.blockHash !== receipt.blockHash ||
    finalReceipt.blockNumber !== receipt.blockNumber ||
    finalBlock.hash !== receipt.blockHash
  ) {
    throw new NexusError(
      "LAUNCH_VERIFICATION_FAILED",
      "The launch receipt changed or was removed from the canonical chain during verification.",
      { broadcast: true },
    );
  }
  return result;
}

export function parseLaunchPlan(input: string): LaunchPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (cause) {
    throw new NexusError("INVALID_PLAN", "Plan file is not valid JSON.", { cause });
  }
  if (typeof parsed !== "object" || parsed === null || !("id" in parsed)) {
    throw new NexusError("INVALID_PLAN", "Plan file does not contain a launch plan.");
  }
  const plan = parsed as LaunchPlan;
  assertPlanId(plan);
  return plan;
}

export function comparePlanSnapshot(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new NexusError("PROTOCOL_CONFIG_CHANGED", `${label} changed after this plan was prepared. Prepare a new plan.`);
  }
}

export function toRpcTransaction(plan: LaunchPlan): Record<string, string> {
  return {
    from: plan.account,
    to: plan.transaction.to,
    data: plan.transaction.data,
    value: numberToHex(BigInt(plan.transaction.value)),
  };
}

export function explainError(error: unknown): NexusError {
  return toNexusError(error);
}
