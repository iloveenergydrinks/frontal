import {
  GLOBAL_PDA,
  PUMP_PROGRAM_ID as SDK_PUMP_PROGRAM_ID,
  PUMP_SDK,
  bondingCurvePda,
  type Global,
} from "@pump-fun/pump-sdk";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getMint,
  getTokenMetadata,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Keypair,
  type Signer,
} from "@solana/web3.js";
import type { Hash } from "viem";

import { NexusError } from "./errors.js";
import { normalizeMetadataText, normalizeTokenMetadata } from "./metadata.js";
import { canonicalJson, hashCanonicalPlan } from "./serialization.js";
import type {
  JsonObject,
  LaunchCapabilities,
  LaunchSummary,
  LaunchWarning,
  NormalizedTokenMetadata,
  TokenMetadata,
} from "./types.js";

export const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_FUN_PROGRAM_OWNER = "BPFLoaderUpgradeab1e11111111111111111111111";
export const PUMP_FUN_PROGRAM_ACCOUNT_HASH =
  "8101492b544ce08703d5de95363bf796e7e4cd17d03639cfe603071fb59652eb";
export const PUMP_FUN_PROGRAM_DATA = "B5MvUwXdiW1NMM6QFFD3ssPKBujD4zMohncbM73Z2BQu";
export const PUMP_FUN_PROGRAM_DATA_HASH =
  "ead956366bbdfc5e06c25deabca92e29f3b2c159f1ef22c5095c9199ac8b5a80";
export const PUMP_FUN_PROGRAM_DEPLOYMENT_SLOT = "433095571";
export const PUMP_FUN_PROGRAM_UPGRADE_AUTHORITY = "7gZufwwAo17y5kg8FMyJy2phgpvv9RSdzWtdXiWHjFr8";
export const PUMP_FUN_SDK_VERSION = "1.36.0";
export const PUMP_FUN_TOKEN_DECIMALS = 6;
export const PUMP_FUN_TOKEN_SUPPLY = "1000000000000000";

const COMMITMENT = "confirmed" as const;
const FINALITY = "finalized" as const;
const ZERO_SIGNATURE = new Uint8Array(64);

export interface PumpFunLaunchOptions {
  cashback?: boolean;
  initialBuy?: string;
  mayhemMode?: boolean;
  metadataUri: string;
  mint: string;
}

export interface SerializedSolanaInstruction {
  accounts: Array<{ isSigner: boolean; isWritable: boolean; publicKey: string }>;
  data: string;
  programId: string;
}

export interface PumpFunLaunchPlan {
  adapter: { id: "pump-fun"; sdkVersion: string; version: string };
  chainFamily: "solana";
  cluster: "mainnet-beta";
  creator: string;
  deployment: {
    owner: string;
    programAccountHash: string;
    programData: {
      address: string;
      deploymentSlot: string;
      reviewedDataHash: string;
      upgradeAuthority: string;
    };
    programId: string;
  };
  expected: {
    associatedBondingCurve: string;
    bondingCurve: string;
    mint: string;
    tokenDecimals: number;
    tokenProgram: string;
    tokenSupply: string;
  };
  id: Hash;
  instructions: SerializedSolanaInstruction[];
  payer: string;
  preparedAt: { slot: string };
  request: {
    launch: Required<PumpFunLaunchOptions>;
    token: NormalizedTokenMetadata;
  };
  schemaVersion: "1";
  snapshot: JsonObject;
  summary: LaunchSummary;
  warnings: LaunchWarning[];
}

export interface PumpFunPrepareParameters {
  connection: Connection;
  creator: string;
  launch: PumpFunLaunchOptions;
  payer: string;
  token: TokenMetadata;
}

export interface PumpFunSimulation {
  blockhash: string;
  feeLamports: string;
  estimatedDebitLamports: string;
  logs: string[];
  passed: true;
  payerBalanceLamports: string;
  planId: Hash;
  slot: string;
  unitsConsumed: string;
}

export interface PumpFunWallet {
  publicKey: PublicKey;
  signTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction>;
}

export interface PumpFunResult {
  adapterId: "pump-fun";
  bondingCurve: string;
  cluster: "mainnet-beta";
  mint: string;
  planId: Hash;
  protocol: "Pump.fun";
  signature: string;
  slot: string;
  verified: true;
}

export interface PumpFunAdapter {
  readonly capabilities: LaunchCapabilities;
  readonly chainFamily: "solana";
  readonly cluster: "mainnet-beta";
  readonly id: "pump-fun";
  readonly version: string;
  prepare(parameters: PumpFunPrepareParameters): Promise<PumpFunLaunchPlan>;
  simulate(connection: Connection, plan: PumpFunLaunchPlan): Promise<PumpFunSimulation>;
  verify(connection: Connection, plan: PumpFunLaunchPlan, signature: string): Promise<PumpFunResult>;
}

function publicKey(value: string, field: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch (cause) {
    throw new NexusError("INVALID_ARGUMENT", `${field} must be a valid Solana public key.`, { cause });
  }
}

function validateByteLength(value: string, maximum: number, field: string): void {
  if (new TextEncoder().encode(value).length > maximum) {
    throw new NexusError("INVALID_TOKEN_METADATA", `${field} must be at most ${maximum} UTF-8 bytes for Pump.fun.`);
  }
}

function normalizeMetadataUri(value: string): string {
  const uri = normalizeMetadataText(value, "metadataUri", true);
  validateByteLength(uri, 200, "metadataUri");
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch (cause) {
    throw new NexusError("INVALID_TOKEN_METADATA", "metadataUri must be a valid HTTPS, IPFS, or Arweave URI.", {
      cause,
    });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "ipfs:" && parsed.protocol !== "ar:") {
    throw new NexusError("INVALID_TOKEN_METADATA", "metadataUri must use HTTPS, ipfs:, or ar:.");
  }
  return uri;
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(data).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readU32(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

function readU64(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}

function parseProgramDataPointer(data: Uint8Array): PublicKey {
  if (data.length !== 36 || readU32(data, 0) !== 2) {
    throw new NexusError("DEPLOYMENT_CODE_MISMATCH", "Pump program is not the expected upgradeable-loader Program account.");
  }
  return new PublicKey(data.slice(4, 36));
}

function parseProgramDataHeader(data: Uint8Array): { deploymentSlot: bigint; upgradeAuthority: PublicKey | null } {
  if (data.length < 13 || readU32(data, 0) !== 3) {
    throw new NexusError("DEPLOYMENT_CODE_MISMATCH", "Pump ProgramData header is malformed.");
  }
  const option = data[12];
  if (option === 0) return { deploymentSlot: readU64(data, 4), upgradeAuthority: null };
  if (option !== 1 || data.length < 45) {
    throw new NexusError("DEPLOYMENT_CODE_MISMATCH", "Pump ProgramData upgrade-authority field is malformed.");
  }
  return { deploymentSlot: readU64(data, 4), upgradeAuthority: new PublicKey(data.slice(13, 45)) };
}

function globalSnapshot(global: Global): JsonObject {
  return {
    initialized: global.initialized,
    authority: global.authority.toBase58(),
    feeRecipient: global.feeRecipient.toBase58(),
    initialVirtualTokenReserves: global.initialVirtualTokenReserves.toString(10),
    initialVirtualSolReserves: global.initialVirtualSolReserves.toString(10),
    initialRealTokenReserves: global.initialRealTokenReserves.toString(10),
    tokenTotalSupply: global.tokenTotalSupply.toString(10),
    feeBasisPoints: global.feeBasisPoints.toString(10),
    withdrawAuthority: global.withdrawAuthority.toBase58(),
    enableMigrate: global.enableMigrate,
    poolMigrationFee: global.poolMigrationFee.toString(10),
    creatorFeeBasisPoints: global.creatorFeeBasisPoints.toString(10),
    feeRecipients: global.feeRecipients.map((entry) => entry.toBase58()),
    setCreatorAuthority: global.setCreatorAuthority.toBase58(),
    adminSetCreatorAuthority: global.adminSetCreatorAuthority.toBase58(),
    createV2Enabled: global.createV2Enabled,
    whitelistPda: global.whitelistPda.toBase58(),
    reservedFeeRecipient: global.reservedFeeRecipient.toBase58(),
    mayhemModeEnabled: global.mayhemModeEnabled,
    reservedFeeRecipients: global.reservedFeeRecipients.map((entry) => entry.toBase58()),
    isCashbackEnabled: global.isCashbackEnabled,
    buybackFeeRecipients: global.buybackFeeRecipients.map((entry) => entry.toBase58()),
    buybackBasisPoints: global.buybackBasisPoints.toString(10),
    initialVirtualQuoteReserves: global.initialVirtualQuoteReserves.toString(10),
    whitelistedQuoteMints: global.whitelistedQuoteMints.map((entry) => entry.toBase58()),
  };
}

function serializeInstruction(instruction: TransactionInstruction): SerializedSolanaInstruction {
  return {
    programId: instruction.programId.toBase58(),
    accounts: instruction.keys.map((key) => ({
      publicKey: key.pubkey.toBase58(),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
    data: Buffer.from(instruction.data).toString("base64"),
  };
}

function deserializeInstruction(instruction: SerializedSolanaInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: publicKey(instruction.programId, "instruction.programId"),
    keys: instruction.accounts.map((key) => ({
      pubkey: publicKey(key.publicKey, "instruction account"),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
    data: Buffer.from(instruction.data, "base64"),
  });
}

function assertPlanId(plan: PumpFunLaunchPlan): void {
  const { id, ...withoutId } = plan;
  const actual = hashCanonicalPlan(withoutId);
  if (id !== actual) throw new NexusError("INVALID_PLAN", `Pump plan ID mismatch: expected ${id}, reconstructed ${actual}.`);
}

function assertPlanShape(plan: PumpFunLaunchPlan): void {
  const candidate = plan as unknown as Record<string, unknown>;
  const adapter = candidate.adapter;
  const deployment = candidate.deployment;
  const request = candidate.request;
  const expected = candidate.expected;
  if (
    typeof adapter !== "object" || adapter === null ||
    typeof deployment !== "object" || deployment === null ||
    typeof (deployment as Record<string, unknown>).programData !== "object" ||
    (deployment as Record<string, unknown>).programData === null ||
    typeof request !== "object" || request === null ||
    typeof (request as Record<string, unknown>).launch !== "object" ||
    (request as Record<string, unknown>).launch === null ||
    typeof expected !== "object" || expected === null ||
    !Array.isArray(candidate.instructions)
  ) {
    throw new NexusError("INVALID_PLAN", "The saved plan is not a structurally valid Pump.fun plan.");
  }
  assertPlanId(plan);
  if (
    plan.schemaVersion !== "1" ||
    plan.adapter.id !== "pump-fun" ||
    plan.adapter.version !== "0.1.0" ||
    plan.adapter.sdkVersion !== PUMP_FUN_SDK_VERSION ||
    plan.chainFamily !== "solana" ||
    plan.cluster !== "mainnet-beta" ||
    plan.instructions.length !== 1 ||
    plan.deployment.programId !== PUMP_FUN_PROGRAM_ID ||
    plan.deployment.owner !== PUMP_FUN_PROGRAM_OWNER ||
    plan.deployment.programAccountHash !== PUMP_FUN_PROGRAM_ACCOUNT_HASH ||
    plan.deployment.programData.address !== PUMP_FUN_PROGRAM_DATA ||
    plan.deployment.programData.reviewedDataHash !== PUMP_FUN_PROGRAM_DATA_HASH ||
    plan.deployment.programData.deploymentSlot !== PUMP_FUN_PROGRAM_DEPLOYMENT_SLOT ||
    plan.deployment.programData.upgradeAuthority !== PUMP_FUN_PROGRAM_UPGRADE_AUTHORITY ||
    plan.instructions[0]?.programId !== PUMP_FUN_PROGRAM_ID ||
    plan.request.launch.initialBuy !== "0" ||
    plan.request.launch.mint !== plan.expected.mint ||
    plan.expected.tokenProgram !== TOKEN_2022_PROGRAM_ID.toBase58() ||
    plan.expected.tokenDecimals !== PUMP_FUN_TOKEN_DECIMALS ||
    plan.expected.tokenSupply !== PUMP_FUN_TOKEN_SUPPLY
  ) {
    throw new NexusError("INVALID_PLAN", "The saved plan is not a supported Pump.fun mainnet plan.");
  }
  const mint = publicKey(plan.expected.mint, "expected.mint");
  const curve = bondingCurvePda(mint);
  const associated = getAssociatedTokenAddressSync(mint, curve, true, TOKEN_2022_PROGRAM_ID);
  if (
    plan.expected.bondingCurve !== curve.toBase58() ||
    plan.expected.associatedBondingCurve !== associated.toBase58()
  ) {
    throw new NexusError("INVALID_PLAN", "Pump plan contains inconsistent derived addresses.");
  }
}

async function collectState(
  connection: Connection,
  mint: PublicKey,
): Promise<{ global: Global; globalDataHash: string; slot: number }> {
  const program = new PublicKey(PUMP_FUN_PROGRAM_ID);
  const owner = new PublicKey(PUMP_FUN_PROGRAM_OWNER);
  const first = await connection.getMultipleAccountsInfoAndContext([program, GLOBAL_PDA, mint], {
    commitment: COMMITMENT,
  });
  const [programInfo, globalInfo, mintInfo] = first.value;
  if (programInfo == null || !programInfo.executable || !programInfo.owner.equals(owner)) {
    throw new NexusError("DEPLOYMENT_CODE_MISMATCH", "Pump program account is missing or has the wrong loader owner.");
  }
  if ((await sha256(programInfo.data)) !== PUMP_FUN_PROGRAM_ACCOUNT_HASH) {
    throw new NexusError("DEPLOYMENT_CODE_MISMATCH", "Pump program account hash no longer matches the reviewed identity.");
  }
  if (!parseProgramDataPointer(programInfo.data).equals(new PublicKey(PUMP_FUN_PROGRAM_DATA))) {
    throw new NexusError("DEPLOYMENT_CODE_MISMATCH", "Pump program now points to different ProgramData.");
  }
  if (globalInfo == null || !globalInfo.owner.equals(program)) {
    throw new NexusError("PROTOCOL_NOT_READY", "Pump global account is missing or has the wrong owner.");
  }
  if (mintInfo !== null) throw new NexusError("PROTOCOL_NOT_READY", "The plan's mint account already exists.");

  const header = await connection.getAccountInfoAndContext(new PublicKey(PUMP_FUN_PROGRAM_DATA), {
    commitment: COMMITMENT,
    dataSlice: { offset: 0, length: 45 },
    minContextSlot: first.context.slot,
  });
  if (header.value === null || !header.value.owner.equals(owner)) {
    throw new NexusError("DEPLOYMENT_CODE_MISMATCH", "Pump ProgramData account is missing or has the wrong owner.");
  }
  const identity = parseProgramDataHeader(header.value.data);
  if (
    identity.deploymentSlot.toString(10) !== PUMP_FUN_PROGRAM_DEPLOYMENT_SLOT ||
    identity.upgradeAuthority?.toBase58() !== PUMP_FUN_PROGRAM_UPGRADE_AUTHORITY
  ) {
    throw new NexusError(
      "DEPLOYMENT_CODE_MISMATCH",
      "Pump was upgraded or its upgrade authority changed after Nexus reviewed this adapter.",
    );
  }

  const final = await connection.getMultipleAccountsInfoAndContext([program, GLOBAL_PDA, mint], {
    commitment: COMMITMENT,
    minContextSlot: header.context.slot,
  });
  const [finalProgram, finalGlobal, finalMint] = final.value;
  if (
    finalProgram == null ||
    finalGlobal == null ||
    finalMint !== null ||
    (await sha256(finalProgram.data)) !== PUMP_FUN_PROGRAM_ACCOUNT_HASH
  ) {
    throw new NexusError("PROTOCOL_CONFIG_CHANGED", "Pump state changed while Nexus was collecting the launch snapshot.");
  }
  const global = PUMP_SDK.decodeGlobal(finalGlobal);
  return { global, globalDataHash: await sha256(finalGlobal.data), slot: final.context.slot };
}

export async function preparePumpFunLaunch(parameters: PumpFunPrepareParameters): Promise<PumpFunLaunchPlan> {
  const initialBuy = parameters.launch.initialBuy ?? "0";
  if (!/^\d+$/u.test(initialBuy)) throw new NexusError("INVALID_ARGUMENT", "initialBuy must be base-10 lamports.");
  if (BigInt(initialBuy) !== 0n) {
    throw new NexusError(
      "UNSUPPORTED_CAPABILITY",
      "Pump.fun initial buys are disabled until Nexus can bind and revalidate an exact minimum token output.",
    );
  }

  const payer = publicKey(parameters.payer, "payer");
  const creator = publicKey(parameters.creator, "creator");
  const mint = publicKey(parameters.launch.mint, "mint");
  const token = normalizeTokenMetadata(parameters.token);
  validateByteLength(token.name, 32, "name");
  validateByteLength(token.symbol, 13, "symbol");
  const metadataUri = normalizeMetadataUri(parameters.launch.metadataUri);
  const mayhemMode = parameters.launch.mayhemMode ?? false;
  const cashback = parameters.launch.cashback ?? false;
  const state = await collectState(parameters.connection, mint);
  if (!state.global.createV2Enabled) throw new NexusError("PROTOCOL_NOT_READY", "Pump create_v2 is currently disabled.");
  if (state.global.tokenTotalSupply.toString(10) !== PUMP_FUN_TOKEN_SUPPLY) {
    throw new NexusError("PROTOCOL_CONFIG_CHANGED", "Pump's configured token supply changed after adapter review.");
  }
  if (mayhemMode && !state.global.mayhemModeEnabled) {
    throw new NexusError("PROTOCOL_NOT_READY", "Pump mayhem mode is currently disabled.");
  }
  if (cashback && !state.global.isCashbackEnabled) {
    throw new NexusError("PROTOCOL_NOT_READY", "Pump cashback coins are currently disabled.");
  }
  if (!SDK_PUMP_PROGRAM_ID.equals(new PublicKey(PUMP_FUN_PROGRAM_ID))) {
    throw new NexusError("DEPLOYMENT_CODE_MISMATCH", "The installed Pump SDK targets a different program.");
  }

  const instruction = await PUMP_SDK.createV2Instruction({
    mint,
    name: token.name,
    symbol: token.symbol,
    uri: metadataUri,
    creator,
    user: payer,
    mayhemMode,
    cashback,
  });
  const bondingCurve = bondingCurvePda(mint);
  const associatedBondingCurve = getAssociatedTokenAddressSync(
    mint,
    bondingCurve,
    true,
    TOKEN_2022_PROGRAM_ID,
  );
  const launch: Required<PumpFunLaunchOptions> = {
    mint: mint.toBase58(),
    metadataUri,
    mayhemMode,
    cashback,
    initialBuy,
  };
  const snapshot: JsonObject = {
    globalAddress: GLOBAL_PDA.toBase58(),
    globalDataHash: state.globalDataHash,
    global: globalSnapshot(state.global),
  };
  const summary: LaunchSummary = {
    protocol: "Pump.fun create_v2",
    pricing: "Pump bonding curve, then protocol-controlled migration",
    liquidity: "Managed by Pump.fun; Nexus does not custody liquidity",
    costs: [{ label: "Initial buy", amount: "0", asset: "lamports" }],
    rows: [
      { label: "Network", value: "Solana mainnet-beta" },
      { label: "Payer", value: payer.toBase58() },
      { label: "Creator", value: creator.toBase58() },
      { label: "Mint", value: mint.toBase58() },
      { label: "Metadata", value: metadataUri },
      { label: "Mayhem mode", value: mayhemMode ? "enabled" : "disabled" },
      { label: "Cashback", value: cashback ? "enabled" : "disabled" },
    ],
  };
  const warnings: LaunchWarning[] = [
    {
      code: "UPGRADEABLE_PROTOCOL",
      message: `Pump is upgradeable by ${PUMP_FUN_PROGRAM_UPGRADE_AUTHORITY}; any upgrade invalidates this plan.`,
    },
    {
      code: "EPHEMERAL_MINT_SIGNER_REQUIRED",
      message: "Execution requires the private mint signer matching this plan. Never save that secret in the plan.",
    },
    {
      code: "EXTERNAL_METADATA",
      message: "The token's metadata remains dependent on the exact external URI committed here.",
    },
  ];
  const withoutId: Omit<PumpFunLaunchPlan, "id"> = {
    schemaVersion: "1",
    adapter: { id: "pump-fun", version: "0.1.0", sdkVersion: PUMP_FUN_SDK_VERSION },
    chainFamily: "solana",
    cluster: "mainnet-beta",
    payer: payer.toBase58(),
    creator: creator.toBase58(),
    deployment: {
      programId: PUMP_FUN_PROGRAM_ID,
      owner: PUMP_FUN_PROGRAM_OWNER,
      programAccountHash: PUMP_FUN_PROGRAM_ACCOUNT_HASH,
      programData: {
        address: PUMP_FUN_PROGRAM_DATA,
        reviewedDataHash: PUMP_FUN_PROGRAM_DATA_HASH,
        deploymentSlot: PUMP_FUN_PROGRAM_DEPLOYMENT_SLOT,
        upgradeAuthority: PUMP_FUN_PROGRAM_UPGRADE_AUTHORITY,
      },
    },
    preparedAt: { slot: state.slot.toString(10) },
    request: { token, launch },
    snapshot,
    instructions: [serializeInstruction(instruction)],
    expected: {
      mint: mint.toBase58(),
      bondingCurve: bondingCurve.toBase58(),
      associatedBondingCurve: associatedBondingCurve.toBase58(),
      tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
      tokenDecimals: PUMP_FUN_TOKEN_DECIMALS,
      tokenSupply: PUMP_FUN_TOKEN_SUPPLY,
    },
    summary,
    warnings,
  };
  return { ...withoutId, id: hashCanonicalPlan(withoutId) };
}

async function revalidate(connection: Connection, plan: PumpFunLaunchPlan): Promise<void> {
  assertPlanShape(plan);
  const mint = publicKey(plan.expected.mint, "expected.mint");
  const state = await collectState(connection, mint);
  const actualSnapshot: JsonObject = {
    globalAddress: GLOBAL_PDA.toBase58(),
    globalDataHash: state.globalDataHash,
    global: globalSnapshot(state.global),
  };
  if (canonicalJson(actualSnapshot) !== canonicalJson(plan.snapshot)) {
    throw new NexusError("PLAN_CHANGED", "Pump global state changed after preparation. Prepare and approve a new plan.");
  }
  const reconstructed = await preparePumpFunLaunch({
    connection,
    payer: plan.payer,
    creator: plan.creator,
    token: plan.request.token,
    launch: plan.request.launch,
  });
  if (
    canonicalJson(reconstructed.instructions) !== canonicalJson(plan.instructions) ||
    canonicalJson(reconstructed.expected) !== canonicalJson(plan.expected) ||
    canonicalJson(reconstructed.deployment) !== canonicalJson(plan.deployment)
  ) {
    throw new NexusError("PLAN_CHANGED", "The exact Pump instruction no longer reconstructs. Prepare a new plan.");
  }
}

export async function buildPumpFunTransaction(
  plan: PumpFunLaunchPlan,
  blockhash: string,
): Promise<VersionedTransaction> {
  assertPlanShape(plan);
  const message = new TransactionMessage({
    payerKey: publicKey(plan.payer, "payer"),
    recentBlockhash: blockhash,
    instructions: plan.instructions.map(deserializeInstruction),
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

export async function simulatePumpFunLaunch(
  connection: Connection,
  plan: PumpFunLaunchPlan,
): Promise<PumpFunSimulation> {
  await revalidate(connection, plan);
  const latest = await connection.getLatestBlockhashAndContext(COMMITMENT);
  const transaction = await buildPumpFunTransaction(plan, latest.value.blockhash);
  const [simulation, fee, payerBalance] = await Promise.all([
    connection.simulateTransaction(transaction, {
      accounts: { addresses: [plan.payer], encoding: "base64" },
      commitment: COMMITMENT,
      sigVerify: false,
    }),
    connection.getFeeForMessage(transaction.message, COMMITMENT),
    connection.getBalance(publicKey(plan.payer, "payer"), COMMITMENT),
  ]);
  if (simulation.value.err !== null) {
    throw new NexusError("SIMULATION_REVERTED", "The exact Pump create_v2 transaction failed simulation.", {
      details: { error: simulation.value.err, logs: simulation.value.logs ?? [] },
      recovery: "Inspect the logs, then prepare a new plan. Do not submit this transaction.",
    });
  }
  if (fee.value === null) throw new NexusError("RPC_ERROR", "Solana RPC did not return a transaction fee.");
  if (payerBalance < fee.value) {
    throw new NexusError("INSUFFICIENT_FUNDS", `Pump payer is short ${fee.value - payerBalance} lamports for the fee alone.`);
  }
  const payerAfter = simulation.value.accounts?.[0]?.lamports;
  const estimatedDebit = payerAfter === undefined || payerAfter === null
    ? fee.value
    : Math.max(0, payerBalance - payerAfter);
  return {
    passed: true,
    planId: plan.id,
    slot: simulation.context.slot.toString(10),
    blockhash: latest.value.blockhash,
    feeLamports: fee.value.toString(10),
    estimatedDebitLamports: estimatedDebit.toString(10),
    payerBalanceLamports: payerBalance.toString(10),
    unitsConsumed: (simulation.value.unitsConsumed ?? 0).toString(10),
    logs: simulation.value.logs ?? [],
  };
}

export async function sendPumpFunLaunch(parameters: {
  connection: Connection;
  mintSigner: Keypair | Signer;
  plan: PumpFunLaunchPlan;
  wallet: PumpFunWallet;
}): Promise<string> {
  const { connection, mintSigner, plan, wallet } = parameters;
  if (wallet.publicKey.toBase58() !== plan.payer) {
    throw new NexusError("INVALID_ARGUMENT", "The connected Solana wallet does not match the plan payer.");
  }
  if (mintSigner.publicKey.toBase58() !== plan.expected.mint) {
    throw new NexusError("INVALID_ARGUMENT", "The ephemeral mint signer does not match the mint committed in the plan.");
  }
  const simulation = await simulatePumpFunLaunch(connection, plan);
  const transaction = await buildPumpFunTransaction(plan, simulation.blockhash);
  transaction.sign([mintSigner]);
  let signed: VersionedTransaction;
  try {
    signed = await wallet.signTransaction(transaction);
  } catch (cause) {
    throw new NexusError("WALLET_REJECTED", "The Solana wallet did not authorize the Pump launch.", {
      cause,
      recovery: "No transaction was submitted.",
    });
  }
  if (signed.signatures.some((signature) => signature.every((byte, index) => byte === ZERO_SIGNATURE[index]))) {
    throw new NexusError("WALLET_REJECTED", "The signed Pump transaction is missing a required signature.");
  }
  try {
    return await connection.sendRawTransaction(signed.serialize(), {
      maxRetries: 0,
      preflightCommitment: COMMITMENT,
      skipPreflight: false,
    });
  } catch (cause) {
    throw new NexusError("RPC_ERROR", "Pump transaction submission failed with an unknown broadcast outcome.", {
      broadcast: true,
      cause,
      recovery: "Reconcile the exact signature and mint account before considering another submission.",
    });
  }
}

export async function verifyPumpFunLaunch(
  connection: Connection,
  plan: PumpFunLaunchPlan,
  signature: string,
): Promise<PumpFunResult> {
  assertPlanShape(plan);
  const transaction = await connection.getTransaction(signature, {
    commitment: FINALITY,
    maxSupportedTransactionVersion: 0,
  });
  if (transaction === null) {
    throw new NexusError("RECEIPT_NOT_FOUND", `No confirmed Solana transaction was found for ${signature}.`, {
      broadcast: true,
    });
  }
  if (transaction.meta === null || transaction.meta.err !== null) {
    throw new NexusError("TRANSACTION_REVERTED", `Pump transaction ${signature} failed.`, { broadcast: true });
  }
  const expected = await buildPumpFunTransaction(plan, transaction.transaction.message.recentBlockhash);
  if (
    !Buffer.from(expected.message.serialize()).equals(
      Buffer.from(transaction.transaction.message.serialize()),
    )
  ) {
    throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Confirmed Solana transaction does not match the exact Pump plan.", {
      broadcast: true,
    });
  }

  const mintAddress = publicKey(plan.expected.mint, "expected.mint");
  const bondingCurveAddress = publicKey(plan.expected.bondingCurve, "expected.bondingCurve");
  const [mint, metadata, bondingCurveInfo] = await Promise.all([
    getMint(connection, mintAddress, FINALITY, TOKEN_2022_PROGRAM_ID),
    getTokenMetadata(connection, mintAddress, FINALITY, TOKEN_2022_PROGRAM_ID),
    connection.getAccountInfo(bondingCurveAddress, FINALITY),
  ]);
  if (
    mint.decimals !== PUMP_FUN_TOKEN_DECIMALS ||
    mint.supply.toString(10) !== plan.expected.tokenSupply ||
    metadata === null ||
    metadata.name !== plan.request.token.name ||
    metadata.symbol !== plan.request.token.symbol ||
    metadata.uri !== plan.request.launch.metadataUri ||
    bondingCurveInfo === null
  ) {
    throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Pump mint, metadata, or bonding curve does not match the plan.", {
      broadcast: true,
    });
  }
  const curve = PUMP_SDK.decodeBondingCurve(bondingCurveInfo);
  if (
    curve.creator.toBase58() !== plan.creator ||
    curve.tokenTotalSupply.toString(10) !== plan.expected.tokenSupply ||
    curve.isMayhemMode !== plan.request.launch.mayhemMode ||
    curve.isCashbackCoin !== plan.request.launch.cashback
  ) {
    throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Pump bonding-curve configuration does not match the plan.", {
      broadcast: true,
    });
  }
  return {
    verified: true,
    adapterId: "pump-fun",
    protocol: "Pump.fun",
    cluster: "mainnet-beta",
    planId: plan.id,
    signature,
    slot: transaction.slot.toString(10),
    mint: mintAddress.toBase58(),
    bondingCurve: bondingCurveAddress.toBase58(),
  };
}

export function parsePumpFunLaunchPlan(input: string): PumpFunLaunchPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (cause) {
    throw new NexusError("INVALID_PLAN", "Pump plan file is not valid JSON.", { cause });
  }
  if (typeof parsed !== "object" || parsed === null || !("id" in parsed)) {
    throw new NexusError("INVALID_PLAN", "Plan file does not contain a Pump launch plan.");
  }
  const plan = parsed as PumpFunLaunchPlan;
  assertPlanShape(plan);
  return plan;
}

export function pumpFun(): PumpFunAdapter {
  return {
    id: "pump-fun",
    version: "0.1.0",
    chainFamily: "solana",
    cluster: "mainnet-beta",
    capabilities: {
      creatorFees: true,
      deterministicTokenAddress: true,
      initialBuy: "unsupported",
      metadataStorage: ["https", "ipfs", "arweave"],
      pricingModel: "bonding-curve",
      taxToken: false,
    },
    prepare: preparePumpFunLaunch,
    simulate: simulatePumpFunLaunch,
    verify: verifyPumpFunLaunch,
  };
}
