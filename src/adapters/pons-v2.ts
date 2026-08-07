import {
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  stringToHex,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";

import { NexusError } from "../errors.js";
import { comparePlanSnapshot } from "../launch.js";
import { canonicalJson } from "../serialization.js";
import { historicalStateUnavailable, requireEqual, runtimeCodeHash } from "../runtime.js";
import type {
  AdapterContext,
  AdapterPreparation,
  JsonObject,
  LaunchAdapter,
  LaunchPlan,
  LaunchResult,
  NormalizedTokenMetadata,
} from "../types.js";

export const PONS_V2_FACTORY = getAddress("0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");
export const PONS_V2_FACTORY_RUNTIME_HASH =
  "0x89a27da6f703e0a7cdd4f233e7cb57604ff75b164530962d3ff7cf8483a67d84" as Hash;
export const PONS_V2_POOL_MANAGER = getAddress("0x8366a39CC670B4001A1121B8F6A443A643e40951");
export const PONS_V2_POSITION_MANAGER = getAddress("0x58daec3116aae6D93017bAAea7749052E8a04fA7");
export const PONS_V2_PERMIT2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
export const PONS_V2_LOCKER = getAddress("0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952");
export const PONS_V2_MEME_HOOK = getAddress("0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044");
export const PONS_V2_FEE_ESCROW = getAddress("0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e");
export const PONS_V2_BUYBACK_VAULT = getAddress("0x42df2a798f82289E177311362e8f5ccC45c1219c");
export const PONS_V2_GRADUATION_EXECUTOR = getAddress("0xC7819B64A1dAECD7eC19856d026cb14EfBd89046");
export const PONS_V2_LAUNCH_DEPLOYER = getAddress("0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42");
export const PONS_V2_LAUNCH_AND_BUY = getAddress("0xe33E9E479dF8802cb0866d5d05258bEc4cF62948");
export const PONS_V2_GRADUATION_GUARD = getAddress("0xf5695117b99B6f6401e67d4195BD653628176C6C");

export const PONS_V2_LAUNCH_DEPLOYER_RUNTIME_HASH =
  "0xeade22566c766377f6adfb99534f2772251efad9568642c0704a7051418e624c" as Hash;

const PONS_V2_PROTOCOL_VERSION = "v2-current-stack-2026-08-07";
const MAX_SALT_ATTEMPTS = 64;

const dependencyPins = {
  poolManager: {
    address: PONS_V2_POOL_MANAGER,
    runtimeCodeHash: "0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626" as Hash,
  },
  positionManager: {
    address: PONS_V2_POSITION_MANAGER,
    runtimeCodeHash: "0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2" as Hash,
  },
  permit2: {
    address: PONS_V2_PERMIT2,
    runtimeCodeHash: "0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca" as Hash,
  },
  locker: {
    address: PONS_V2_LOCKER,
    runtimeCodeHash: "0x58455f80b3773871d601a025e56ec27c71ab3bbb8e2ca6b17828954450742025" as Hash,
  },
  memeHook: {
    address: PONS_V2_MEME_HOOK,
    runtimeCodeHash: "0xc21b1e6c1b45403e81a581f22ed6d9c747997af1cfdac1b1dc9f4b1d346a10db" as Hash,
  },
  feeEscrow: {
    address: PONS_V2_FEE_ESCROW,
    runtimeCodeHash: "0xf25f75cfbc1637ba068dc34f69098fa4e8a80f8ee8fe7bf7820594e0b3fed2f1" as Hash,
  },
  buybackVault: {
    address: PONS_V2_BUYBACK_VAULT,
    runtimeCodeHash: "0x5de8480874faffefa539648f1a7d6c1e69b39da3fa34de22fc95eb7586aece03" as Hash,
  },
  graduationExecutor: {
    address: PONS_V2_GRADUATION_EXECUTOR,
    runtimeCodeHash: "0xf59f43072fdc50674bb88eabef0318906a803e4af2e9ff115239d53e50046e2a" as Hash,
  },
  launchDeployer: {
    address: PONS_V2_LAUNCH_DEPLOYER,
    runtimeCodeHash: PONS_V2_LAUNCH_DEPLOYER_RUNTIME_HASH,
  },
  launchForwarder: {
    address: PONS_V2_LAUNCH_AND_BUY,
    runtimeCodeHash: "0xed9065184519eaa24a22c2556403d5d8bbb230ff94dbc5c414cf5028e20e52e7" as Hash,
  },
  graduationGuard: {
    address: PONS_V2_GRADUATION_GUARD,
    runtimeCodeHash: "0x6847e5d5df83bb7a51c5780302a5da9cfbdae60b7f7fa850f83ade5be816ecea" as Hash,
  },
} as const;

const SOCIALS =
  "(string twitter,string telegram,string discord,string website,string farcaster)";
const TOKEN_PARAMS =
  `(string name,string symbol,string logo,string description,${SOCIALS} socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt)`;
const FEE_POLICY =
  "(address protocolFeeRecipient,uint16 protocolFeeShareBps,uint16 buybackBurnBps,uint16 hookFeeBps,uint16 maxInternalPriceImpactBps)";
const LAUNCH_DEPLOYMENT =
  `(address pairToken,address creatorFeeRecipient,address originalDeployer,address feePolicy,${FEE_POLICY} policy,address feeEscrow,address buybackVault,uint256 phantomQuote,uint256 curveFeeBps,uint256 creatorTaxBps,bool buybackEnabled,uint256 graduationThreshold,uint256 supply,bytes32 salt,string name,string symbol,string logo,string description,${SOCIALS} socials)`;

export const ponsV2FactoryAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function canLaunch(address launcher) view returns (bool)",
  "function launchEnabled() view returns (bool)",
  "function whitelistedLaunchers(address launcher) view returns (bool)",
  "function launchFee() view returns (uint256)",
  "function maxCreatorTaxBps() view returns (uint256)",
  "function snipeTaxStartBps() view returns (uint256)",
  "function snipeTaxSeconds() view returns (uint256)",
  "function launchConfigCount() view returns (uint256)",
  "function getLaunchConfig(uint256 id) view returns ((uint256 supply,uint256 curveFeeBps,uint256 phantomQuote,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,bool enabled) config)",
  "function approvedPairTokens(address pairToken) view returns (bool)",
  "function pairTokenEconomics(address pairToken) view returns (uint256 phantomQuote,uint256 graduationThreshold,uint8 decimals)",
  "function previewLaunchEconomics(uint256 launchConfigId,address pairToken) view returns (bytes32)",
  "function poolManager() view returns (address)",
  "function positionManager() view returns (address)",
  "function permit2() view returns (address)",
  "function locker() view returns (address)",
  "function memeHook() view returns (address)",
  "function feeEscrow() view returns (address)",
  "function buybackVault() view returns (address)",
  "function graduationExecutor() view returns (address)",
  "function launchDeployer() view returns (address)",
  "function launchForwarder() view returns (address)",
  "function graduationGuard() view returns (address)",
  `function launchToken(${TOKEN_PARAMS} params,uint256 launchConfigId,address pairToken) payable returns (address token,address curve)`,
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists) launched)",
  "event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)",
]);

const hookAbi = parseAbi([
  `function currentFeePolicy() view returns (${FEE_POLICY})`,
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
]);

const launchDeployerAbi = parseAbi([
  `function predictLaunchAddresses(${LAUNCH_DEPLOYMENT} params) view returns (address token,address curve)`,
]);

const tokenAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function curve() view returns (address)",
  "function deployer() view returns (address)",
  "function launchFactory() view returns (address)",
  `function getTokenInfo() view returns (address tokenDeployer,string tokenLogo,string tokenDescription,${SOCIALS} tokenSocials)`,
]);

const curveAbi = parseAbi([
  "function token() view returns (address)",
  "function pairToken() view returns (address)",
  "function factory() view returns (address)",
  "function feePolicy() view returns (address)",
  "function feeEscrow() view returns (address)",
  "function buybackVault() view returns (address)",
  "function protocolFeeRecipient() view returns (address)",
  "function protocolFeeShareBps() view returns (uint256)",
  "function buybackBurnBps() view returns (uint256)",
  "function maxInternalPriceImpactBps() view returns (uint256)",
  "function phantomQuote() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function graduationThreshold() view returns (uint256)",
  "function buybackEnabled() view returns (bool)",
  "function snipeTaxStartBps() view returns (uint256)",
  "function snipeTaxSeconds() view returns (uint256)",
]);

export interface PonsV2LaunchOptions {
  buybackEnabled?: boolean;
  creatorFeeRecipient?: Address;
  creatorTaxBps?: number;
  initialBuy?: bigint | number | string;
  launchConfigId?: number;
  pairToken?: Address;
  salt?: Hash;
  saltSeed?: Hex | string;
}

interface FeePolicySnapshot {
  buybackBurnBps: number;
  hookFeeBps: number;
  maxInternalPriceImpactBps: number;
  protocolFeeRecipient: Address;
  protocolFeeShareBps: number;
}

interface LaunchConfigSnapshot {
  curveFeeBps: bigint;
  enabled: boolean;
  graduationThreshold: bigint;
  phantomQuote: bigint;
  poolFee: number;
  supply: bigint;
  tickSpacing: number;
}

interface PonsV2State {
  config: LaunchConfigSnapshot;
  deployment: {
    address: Address;
    protocolVersion: string;
    runtimeCodeHash: Hash;
  };
  economics: Hash;
  effectiveGraduationThreshold: bigint;
  effectivePhantomQuote: bigint;
  launchFee: bigint;
  policy: FeePolicySnapshot;
  snipeTaxSeconds: bigint;
  snipeTaxStartBps: bigint;
  snapshot: JsonObject;
}

interface PonsV2TokenParams {
  buybackEnabled: boolean;
  creatorFeeRecipient: Address;
  creatorTaxBps: number;
  description: string;
  expectedEconomics: Hash;
  logo: string;
  name: string;
  salt: Hash;
  socials: Required<NormalizedTokenMetadata["socials"]>;
  symbol: string;
}

function parseUint(value: bigint | number | string | undefined, field: string): bigint {
  if (value === undefined) return 0n;
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch (cause) {
    throw new NexusError("INVALID_ARGUMENT", `${field} must be a non-negative integer.`, { cause });
  }
}

function parseConfigId(value: number | undefined): number {
  const id = value ?? 0;
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new NexusError("INVALID_ARGUMENT", "launchConfigId must be a non-negative safe integer.");
  }
  return id;
}

function normalizeSaltSeed(seed: Hex | string | undefined, fallback: string): Hash {
  if (seed === undefined) return keccak256(stringToHex(fallback));
  if (/^0x[0-9a-fA-F]{64}$/u.test(seed)) return seed as Hash;
  return keccak256(stringToHex(seed));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function requireMaxBytes(value: string, maximum: number, field: string): void {
  if (byteLength(value) > maximum) {
    throw new NexusError("INVALID_TOKEN_METADATA", `${field} exceeds the Pons V2 ${maximum}-byte limit.`);
  }
}

function validateMetadata(token: NormalizedTokenMetadata): void {
  if (token.name.length === 0 || token.symbol.length === 0) {
    throw new NexusError("INVALID_TOKEN_METADATA", "Pons V2 requires a non-empty token name and symbol.");
  }
  requireMaxBytes(token.name, 64, "name");
  requireMaxBytes(token.symbol, 16, "symbol");
  requireMaxBytes(token.image, 512, "image");
  requireMaxBytes(token.description, 2_048, "description");
  for (const [name, value] of Object.entries(token.socials)) {
    requireMaxBytes(value, 256, `socials.${name}`);
  }
}

async function readPonsV2State(
  publicClient: PublicClient,
  account: Address,
  launchConfigId: number,
  pairToken: Address,
  blockNumber?: bigint,
): Promise<PonsV2State> {
  const factoryHash = await runtimeCodeHash(publicClient, PONS_V2_FACTORY, blockNumber);
  requireEqual(
    factoryHash,
    PONS_V2_FACTORY_RUNTIME_HASH,
    `Pons V2 factory runtime hash ${factoryHash} is not the reviewed hash ${PONS_V2_FACTORY_RUNTIME_HASH}.`,
  );
  const contract = { address: PONS_V2_FACTORY, abi: ponsV2FactoryAbi, blockNumber } as const;
  const [
    owner,
    pendingOwner,
    canLaunch,
    launchEnabled,
    whitelisted,
    launchFee,
    maxCreatorTaxBps,
    snipeTaxStartBps,
    snipeTaxSeconds,
    launchConfigCount,
    ...dependencyAddresses
  ] = await Promise.all([
    publicClient.readContract({ ...contract, functionName: "owner" }),
    publicClient.readContract({ ...contract, functionName: "pendingOwner" }),
    publicClient.readContract({ ...contract, functionName: "canLaunch", args: [account] }),
    publicClient.readContract({ ...contract, functionName: "launchEnabled" }),
    publicClient.readContract({ ...contract, functionName: "whitelistedLaunchers", args: [account] }),
    publicClient.readContract({ ...contract, functionName: "launchFee" }),
    publicClient.readContract({ ...contract, functionName: "maxCreatorTaxBps" }),
    publicClient.readContract({ ...contract, functionName: "snipeTaxStartBps" }),
    publicClient.readContract({ ...contract, functionName: "snipeTaxSeconds" }),
    publicClient.readContract({ ...contract, functionName: "launchConfigCount" }),
    ...Object.keys(dependencyPins).map((functionName) =>
      publicClient.readContract({ ...contract, functionName: functionName as keyof typeof dependencyPins }),
    ),
  ]);

  if (!canLaunch) {
    throw new NexusError("PROTOCOL_NOT_READY", "Pons V2 does not currently allow this wallet to launch.", {
      recovery: "Wait for public launch enablement or have Pons whitelist the exact launch wallet.",
    });
  }
  if (BigInt(launchConfigId) >= launchConfigCount) {
    throw new NexusError("INVALID_ARGUMENT", `Pons V2 has ${launchConfigCount} launch configurations.`);
  }
  const config = await publicClient.readContract({
    ...contract,
    functionName: "getLaunchConfig",
    args: [BigInt(launchConfigId)],
  });
  if (!config.enabled) {
    throw new NexusError("PROTOCOL_NOT_READY", `Pons V2 launch configuration ${launchConfigId} is disabled.`);
  }

  const entries = Object.entries(dependencyPins);
  const dependencyHashes = await Promise.all(
    entries.map(async ([name, pin], index) => {
      const actual = getAddress(String(dependencyAddresses[index]));
      requireEqual(actual, pin.address, `Pons V2 ${name} changed to ${actual}.`);
      const hash = await runtimeCodeHash(publicClient, actual, blockNumber);
      requireEqual(hash, pin.runtimeCodeHash, `Pons V2 ${name} runtime code changed.`);
      return [name, { address: actual, runtimeCodeHash: hash }] as const;
    }),
  );

  const hook = { address: PONS_V2_MEME_HOOK, abi: hookAbi, blockNumber } as const;
  const [policy, hookOwner, hookPendingOwner, economics, pairApproved, pairEconomics] = await Promise.all([
    publicClient.readContract({ ...hook, functionName: "currentFeePolicy" }),
    publicClient.readContract({ ...hook, functionName: "owner" }),
    publicClient.readContract({ ...hook, functionName: "pendingOwner" }),
    publicClient.readContract({
      ...contract,
      functionName: "previewLaunchEconomics",
      args: [BigInt(launchConfigId), pairToken],
    }),
    pairToken === zeroAddress
      ? Promise.resolve(true)
      : publicClient.readContract({ ...contract, functionName: "approvedPairTokens", args: [pairToken] }),
    pairToken === zeroAddress
      ? Promise.resolve([config.phantomQuote, config.graduationThreshold, 18] as const)
      : publicClient.readContract({ ...contract, functionName: "pairTokenEconomics", args: [pairToken] }),
  ]);
  if (!pairApproved || pairEconomics[0] === 0n || pairEconomics[1] === 0n) {
    throw new NexusError("PROTOCOL_NOT_READY", `Pons V2 has not approved ${pairToken} as a launch pair.`);
  }

  const normalizedPolicy: FeePolicySnapshot = {
    protocolFeeRecipient: getAddress(policy.protocolFeeRecipient),
    protocolFeeShareBps: policy.protocolFeeShareBps,
    buybackBurnBps: policy.buybackBurnBps,
    hookFeeBps: policy.hookFeeBps,
    maxInternalPriceImpactBps: policy.maxInternalPriceImpactBps,
  };
  const normalizedConfig: LaunchConfigSnapshot = {
    supply: config.supply,
    curveFeeBps: config.curveFeeBps,
    phantomQuote: config.phantomQuote,
    graduationThreshold: config.graduationThreshold,
    poolFee: config.poolFee,
    tickSpacing: config.tickSpacing,
    enabled: config.enabled,
  };
  const dependencies = Object.fromEntries(dependencyHashes) as JsonObject;
  const snapshot: JsonObject = {
    governance: {
      owner: getAddress(owner),
      pendingOwner: getAddress(pendingOwner),
      hookOwner: getAddress(hookOwner),
      hookPendingOwner: getAddress(hookPendingOwner),
    },
    launchGate: { canLaunch, launchEnabled, launcherWhitelisted: whitelisted },
    launchFee: launchFee.toString(10),
    maxCreatorTaxBps: maxCreatorTaxBps.toString(10),
    snipeProtection: {
      startBps: snipeTaxStartBps.toString(10),
      seconds: snipeTaxSeconds.toString(10),
    },
    launchConfig: {
      launchConfigId,
      supply: config.supply.toString(10),
      curveFeeBps: config.curveFeeBps.toString(10),
      phantomQuote: config.phantomQuote.toString(10),
      graduationThreshold: config.graduationThreshold.toString(10),
      poolFee: config.poolFee,
      tickSpacing: config.tickSpacing,
      enabled: config.enabled,
    },
    pair: {
      address: pairToken,
      approved: pairApproved,
      decimals: pairEconomics[2],
      phantomQuote: pairEconomics[0].toString(10),
      graduationThreshold: pairEconomics[1].toString(10),
    },
    economics,
    feePolicy: {
      ...normalizedPolicy,
      protocolFeeShareBps: normalizedPolicy.protocolFeeShareBps,
    },
    dependencies,
  };

  return {
    config: normalizedConfig,
    deployment: {
      address: PONS_V2_FACTORY,
      protocolVersion: PONS_V2_PROTOCOL_VERSION,
      runtimeCodeHash: factoryHash,
    },
    economics,
    effectiveGraduationThreshold: pairEconomics[1],
    effectivePhantomQuote: pairEconomics[0],
    launchFee,
    policy: normalizedPolicy,
    snipeTaxSeconds,
    snipeTaxStartBps,
    snapshot,
  };
}

function launchDeployment(
  account: Address,
  token: NormalizedTokenMetadata,
  params: PonsV2TokenParams,
  pairToken: Address,
  state: PonsV2State,
): Record<string, unknown> {
  return {
    pairToken,
    creatorFeeRecipient: params.creatorFeeRecipient,
    originalDeployer: account,
    feePolicy: PONS_V2_MEME_HOOK,
    policy: state.policy,
    feeEscrow: PONS_V2_FEE_ESCROW,
    buybackVault: PONS_V2_BUYBACK_VAULT,
    phantomQuote: state.effectivePhantomQuote,
    curveFeeBps: state.config.curveFeeBps,
    creatorTaxBps: BigInt(params.creatorTaxBps),
    buybackEnabled: params.buybackEnabled,
    graduationThreshold: state.effectiveGraduationThreshold,
    supply: state.config.supply,
    salt: params.salt,
    name: token.name,
    symbol: token.symbol,
    logo: token.image,
    description: token.description,
    socials: token.socials,
  };
}

async function prediction(
  publicClient: PublicClient,
  account: Address,
  token: NormalizedTokenMetadata,
  params: PonsV2TokenParams,
  pairToken: Address,
  state: PonsV2State,
  blockNumber?: bigint,
): Promise<{ curve: Address; free: boolean; token: Address }> {
  const [predictedToken, predictedCurve] = await publicClient.readContract({
    address: PONS_V2_LAUNCH_DEPLOYER,
    abi: launchDeployerAbi,
    functionName: "predictLaunchAddresses",
    args: [launchDeployment(account, token, params, pairToken, state) as never],
    blockNumber,
  });
  const tokenAddress = getAddress(predictedToken);
  const curveAddress = getAddress(predictedCurve);
  const [tokenCode, curveCode] = await Promise.all([
    publicClient.getCode({ address: tokenAddress, blockNumber }),
    publicClient.getCode({ address: curveAddress, blockNumber }),
  ]);
  return {
    token: tokenAddress,
    curve: curveAddress,
    free: (tokenCode === undefined || tokenCode === "0x") && (curveCode === undefined || curveCode === "0x"),
  };
}

async function selectSalt(
  publicClient: PublicClient,
  account: Address,
  token: NormalizedTokenMetadata,
  base: Omit<PonsV2TokenParams, "salt">,
  pairToken: Address,
  state: PonsV2State,
  seed: Hash,
  requested: Hash | undefined,
  blockNumber?: bigint,
): Promise<{ curve: Address; salt: Hash; token: Address }> {
  let salt = requested ?? seed;
  const attempts = requested === undefined ? MAX_SALT_ATTEMPTS : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = await prediction(
      publicClient,
      account,
      token,
      { ...base, salt },
      pairToken,
      state,
      blockNumber,
    );
    if (candidate.free) return { ...candidate, salt };
    salt = keccak256(salt);
  }
  throw new NexusError(
    "PROTOCOL_CONFIG_CHANGED",
    requested === undefined
      ? `No free Pons V2 CREATE2 salt was found within ${MAX_SALT_ATTEMPTS} attempts.`
      : "The requested Pons V2 salt predicts a token or curve address that already has code.",
  );
}

function exactSocials(value: Required<NormalizedTokenMetadata["socials"]>): Required<NormalizedTokenMetadata["socials"]> {
  return {
    twitter: value.twitter,
    telegram: value.telegram,
    discord: value.discord,
    website: value.website,
    farcaster: value.farcaster,
  };
}

export function ponsV2(): LaunchAdapter<PonsV2LaunchOptions> {
  return {
    id: "pons-v2",
    version: "0.1.0",
    chainId: 4663,
    capabilities: {
      creatorFees: true,
      deterministicTokenAddress: true,
      initialBuy: "unsupported",
      metadataStorage: ["onchain", "https", "ipfs"],
      pricingModel: "bonding-curve",
      taxToken: true,
    },
    async prepare(context: AdapterContext<PonsV2LaunchOptions>): Promise<AdapterPreparation> {
      const initialBuy = parseUint(context.launch.initialBuy, "initialBuy");
      if (initialBuy !== 0n) {
        throw new NexusError(
          "UNSUPPORTED_CAPABILITY",
          "pons-v2 direct launch plans do not include an initial buy. Launch-and-buy requires a separately quoted minimum output.",
        );
      }
      validateMetadata(context.token);
      const launchConfigId = parseConfigId(context.launch.launchConfigId);
      const pairToken = getAddress(context.launch.pairToken ?? zeroAddress);
      const creatorFeeRecipient = getAddress(context.launch.creatorFeeRecipient ?? context.account);
      const creatorTaxBps = context.launch.creatorTaxBps ?? 0;
      if (!Number.isInteger(creatorTaxBps) || creatorTaxBps < 0 || creatorTaxBps > 10_000) {
        throw new NexusError("INVALID_ARGUMENT", "creatorTaxBps must be an integer between 0 and 10000.");
      }
      const state = await readPonsV2State(
        context.publicClient,
        context.account,
        launchConfigId,
        pairToken,
        context.blockNumber,
      );
      const maximum = Number(state.snapshot.maxCreatorTaxBps);
      if (creatorTaxBps > maximum) {
        throw new NexusError("INVALID_ARGUMENT", `creatorTaxBps exceeds the live Pons V2 ceiling of ${maximum}.`);
      }
      const base = {
        name: context.token.name,
        symbol: context.token.symbol,
        logo: context.token.image,
        description: context.token.description,
        socials: context.token.socials,
        creatorFeeRecipient,
        creatorTaxBps,
        buybackEnabled: context.launch.buybackEnabled ?? false,
        expectedEconomics: state.economics,
      } satisfies Omit<PonsV2TokenParams, "salt">;
      const seed = normalizeSaltSeed(
        context.launch.saltSeed,
        `${context.account}:${context.token.name}:${context.token.symbol}:${context.blockHash}`,
      );
      const selected = await selectSalt(
        context.publicClient,
        context.account,
        context.token,
        base,
        pairToken,
        state,
        seed,
        context.launch.salt,
        context.blockNumber,
      );
      const params: PonsV2TokenParams = { ...base, salt: selected.salt };
      const data = encodeFunctionData({
        abi: ponsV2FactoryAbi,
        functionName: "launchToken",
        args: [params, BigInt(launchConfigId), pairToken],
      });
      const launch = {
        buybackEnabled: params.buybackEnabled,
        creatorFeeRecipient,
        creatorTaxBps,
        initialBuy: "0",
        launchConfigId,
        pairToken,
        predictedCurve: selected.curve,
        predictedToken: selected.token,
        salt: selected.salt,
      } satisfies JsonObject;

      return {
        deployment: state.deployment,
        launch,
        snapshot: state.snapshot,
        transaction: { to: PONS_V2_FACTORY, data, value: state.launchFee.toString(10) },
        expected: {
          token: selected.token,
          curve: selected.curve,
          economics: state.economics,
          graduationThreshold: state.effectiveGraduationThreshold.toString(10),
          pricingModel: "constant-product bonding curve",
          liquidityVenue: "permanently locked full-range Uniswap V4 after graduation",
        },
        summary: {
          protocol: "Pons V2",
          pricing: "Constant-product bonding curve with launch economics pinned into calldata.",
          liquidity: "The curve graduates automatically into a permanently locked full-range Uniswap V4 position.",
          costs: [{ label: "Launch fee", asset: "ETH", amount: state.launchFee.toString(10) }],
          rows: [
            { label: "Factory", value: PONS_V2_FACTORY },
            { label: "Deployment", value: PONS_V2_PROTOCOL_VERSION },
            { label: "Launch config", value: String(launchConfigId) },
            { label: "Pair token", value: pairToken },
            { label: "Supply", value: state.config.supply.toString(10) },
            { label: "Curve fee", value: `${state.config.curveFeeBps} bps` },
            { label: "Creator tax", value: `${creatorTaxBps} bps` },
            { label: "Creator fee recipient", value: creatorFeeRecipient },
            { label: "Buybacks", value: params.buybackEnabled ? "enabled" : "disabled" },
            { label: "Predicted token", value: selected.token },
            { label: "Predicted curve", value: selected.curve },
            { label: "Salt", value: selected.salt },
            { label: "Economics digest", value: state.economics },
          ],
        },
        warnings: [
          {
            code: "EXTERNAL_PROTOCOL",
            message:
              "Nexus has not audited Pons V2. Its owner controls launch gating, future configurations, pair approvals, launch fees, snipe-tax settings, and creator-tax ceilings.",
          },
          {
            code: "SNIPE_TAX",
            message: `New curves snapshot an opening buy tax of ${state.snipeTaxStartBps} bps decaying over ${state.snipeTaxSeconds} seconds. The launcher and creator fee recipient are exempt.`,
          },
          {
            code: "PERMANENT_LOCK",
            message:
              "At graduation, reserves seed a full-range Uniswap V4 position held permanently by the Pons locker. Nexus cannot recover it.",
          },
          {
            code: "NO_ATOMIC_INITIAL_BUY",
            message:
              "This Nexus adapter launches only. It will not use Pons launch-and-buy until a separately quoted, nonzero minimum output is bound into the plan.",
          },
        ],
      };
    },
    async revalidate(publicClient: PublicClient, plan: LaunchPlan): Promise<void> {
      const launchConfigId = Number(plan.request.launch.launchConfigId);
      const pairToken = getAddress(String(plan.request.launch.pairToken));
      const state = await readPonsV2State(publicClient, plan.account, launchConfigId, pairToken);
      comparePlanSnapshot(state.snapshot, plan.snapshot, "Pons V2 launch configuration");
      if (canonicalJson(state.deployment) !== canonicalJson(plan.deployment)) {
        throw new NexusError("DEPLOYMENT_CODE_MISMATCH", "Pons V2 deployment changed after plan preparation.");
      }
      const params: PonsV2TokenParams = {
        name: plan.request.token.name,
        symbol: plan.request.token.symbol,
        logo: plan.request.token.image,
        description: plan.request.token.description,
        socials: plan.request.token.socials,
        creatorFeeRecipient: getAddress(String(plan.request.launch.creatorFeeRecipient)),
        creatorTaxBps: Number(plan.request.launch.creatorTaxBps),
        buybackEnabled: Boolean(plan.request.launch.buybackEnabled),
        expectedEconomics: state.economics,
        salt: String(plan.request.launch.salt) as Hash,
      };
      const candidate = await prediction(publicClient, plan.account, plan.request.token, params, pairToken, state);
      if (
        candidate.token !== getAddress(String(plan.request.launch.predictedToken)) ||
        candidate.curve !== getAddress(String(plan.request.launch.predictedCurve))
      ) {
        throw new NexusError("INVALID_PLAN", "Pons V2 predicted addresses no longer match the saved plan.");
      }
      if (!candidate.free) {
        throw new NexusError("PROTOCOL_CONFIG_CHANGED", "The planned Pons V2 token or curve address now has code.");
      }
    },
    async verify(
      publicClient: PublicClient,
      plan: LaunchPlan,
      receipt: TransactionReceipt,
    ): Promise<LaunchResult> {
      const launches: Array<{
        curve: Address;
        deployer: Address;
        graduationThreshold: bigint;
        launchConfigId: bigint;
        pairToken: Address;
        token: Address;
      }> = [];
      for (const log of receipt.logs) {
        if (getAddress(log.address) !== PONS_V2_FACTORY) continue;
        try {
          const decoded = decodeEventLog({ abi: ponsV2FactoryAbi, data: log.data, topics: log.topics });
          if (decoded.eventName === "TokenLaunched") launches.push(decoded.args);
        } catch {
          // Other factory events in the same transaction are expected.
        }
      }
      if (launches.length !== 1) {
        throw new NexusError(
          "LAUNCH_VERIFICATION_FAILED",
          `Expected one Pons V2 TokenLaunched event, found ${launches.length}.`,
          { broadcast: true },
        );
      }
      const launched = launches[0];
      if (launched === undefined) {
        throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Missing Pons V2 launch event.", { broadcast: true });
      }
      const expectedToken = getAddress(String(plan.request.launch.predictedToken));
      const expectedCurve = getAddress(String(plan.request.launch.predictedCurve));
      const pairToken = getAddress(String(plan.request.launch.pairToken));
      const snapshotConfig = plan.snapshot.launchConfig as JsonObject;
      const snapshotPair = plan.snapshot.pair as JsonObject;
      const snapshotPolicy = plan.snapshot.feePolicy as JsonObject;
      const snapshotSnipe = plan.snapshot.snipeProtection as JsonObject;
      if (
        getAddress(launched.token) !== expectedToken ||
        getAddress(launched.curve) !== expectedCurve ||
        getAddress(launched.deployer) !== plan.account ||
        getAddress(launched.pairToken) !== pairToken ||
        launched.launchConfigId !== BigInt(String(plan.request.launch.launchConfigId)) ||
        launched.graduationThreshold !== BigInt(String(snapshotPair.graduationThreshold))
      ) {
        throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Pons V2 launch event does not match the plan.", {
          broadcast: true,
        });
      }

      const readState = async (blockNumber: bigint): Promise<{ tokenInfo: JsonObject }> => {
        const record = await publicClient.readContract({
          address: PONS_V2_FACTORY,
          abi: ponsV2FactoryAbi,
          functionName: "getLaunchedToken",
          args: [expectedToken],
          blockNumber,
        });
        if (
          !record.exists ||
          getAddress(record.token) !== expectedToken ||
          getAddress(record.curve) !== expectedCurve ||
          getAddress(record.deployer) !== plan.account ||
          getAddress(record.creatorFeeRecipient) !== getAddress(String(plan.request.launch.creatorFeeRecipient)) ||
          getAddress(record.pairToken) !== pairToken ||
          record.graduationThreshold !== BigInt(String(snapshotPair.graduationThreshold)) ||
          record.poolFee !== Number(snapshotConfig.poolFee) ||
          record.tickSpacing !== Number(snapshotConfig.tickSpacing) ||
          record.creatorTaxBps !== Number(plan.request.launch.creatorTaxBps) ||
          record.buybackEnabled !== Boolean(plan.request.launch.buybackEnabled) ||
          record.phase !== 0
        ) {
          throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Pons V2 factory launch record is inconsistent.", {
            broadcast: true,
          });
        }
        await Promise.all([
          runtimeCodeHash(publicClient, expectedToken, blockNumber),
          runtimeCodeHash(publicClient, expectedCurve, blockNumber),
        ]);
        const tokenContract = { address: expectedToken, abi: tokenAbi, blockNumber } as const;
        const curveContract = { address: expectedCurve, abi: curveAbi, blockNumber } as const;
        const [name, symbol, supply, tokenCurve, tokenDeployer, launchFactory, info, curveState] = await Promise.all([
          publicClient.readContract({ ...tokenContract, functionName: "name" }),
          publicClient.readContract({ ...tokenContract, functionName: "symbol" }),
          publicClient.readContract({ ...tokenContract, functionName: "totalSupply" }),
          publicClient.readContract({ ...tokenContract, functionName: "curve" }),
          publicClient.readContract({ ...tokenContract, functionName: "deployer" }),
          publicClient.readContract({ ...tokenContract, functionName: "launchFactory" }),
          publicClient.readContract({ ...tokenContract, functionName: "getTokenInfo" }),
          Promise.all([
            publicClient.readContract({ ...curveContract, functionName: "token" }),
            publicClient.readContract({ ...curveContract, functionName: "pairToken" }),
            publicClient.readContract({ ...curveContract, functionName: "factory" }),
            publicClient.readContract({ ...curveContract, functionName: "feePolicy" }),
            publicClient.readContract({ ...curveContract, functionName: "feeEscrow" }),
            publicClient.readContract({ ...curveContract, functionName: "buybackVault" }),
            publicClient.readContract({ ...curveContract, functionName: "protocolFeeRecipient" }),
            publicClient.readContract({ ...curveContract, functionName: "protocolFeeShareBps" }),
            publicClient.readContract({ ...curveContract, functionName: "buybackBurnBps" }),
            publicClient.readContract({ ...curveContract, functionName: "maxInternalPriceImpactBps" }),
            publicClient.readContract({ ...curveContract, functionName: "phantomQuote" }),
            publicClient.readContract({ ...curveContract, functionName: "feeBps" }),
            publicClient.readContract({ ...curveContract, functionName: "creatorTaxBps" }),
            publicClient.readContract({ ...curveContract, functionName: "graduationThreshold" }),
            publicClient.readContract({ ...curveContract, functionName: "buybackEnabled" }),
            publicClient.readContract({ ...curveContract, functionName: "snipeTaxStartBps" }),
            publicClient.readContract({ ...curveContract, functionName: "snipeTaxSeconds" }),
          ]),
        ]);
        const [infoDeployer, logo, description, socials] = info;
        if (
          name !== plan.request.token.name ||
          symbol !== plan.request.token.symbol ||
          supply !== BigInt(String(snapshotConfig.supply)) ||
          getAddress(tokenCurve) !== expectedCurve ||
          getAddress(tokenDeployer) !== plan.account ||
          getAddress(launchFactory) !== PONS_V2_FACTORY ||
          getAddress(infoDeployer) !== plan.account ||
          logo !== plan.request.token.image ||
          description !== plan.request.token.description ||
          canonicalJson(exactSocials(socials)) !== canonicalJson(plan.request.token.socials)
        ) {
          throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Pons V2 token state does not match the plan.", {
            broadcast: true,
          });
        }
        const expectedCurveState = [
          expectedToken,
          pairToken,
          PONS_V2_FACTORY,
          PONS_V2_MEME_HOOK,
          PONS_V2_FEE_ESCROW,
          PONS_V2_BUYBACK_VAULT,
          getAddress(String(snapshotPolicy.protocolFeeRecipient)),
          BigInt(String(snapshotPolicy.protocolFeeShareBps)),
          BigInt(String(snapshotPolicy.buybackBurnBps)),
          BigInt(String(snapshotPolicy.maxInternalPriceImpactBps)),
          BigInt(String(snapshotPair.phantomQuote)),
          BigInt(String(snapshotConfig.curveFeeBps)),
          BigInt(String(plan.request.launch.creatorTaxBps)),
          BigInt(String(snapshotPair.graduationThreshold)),
          Boolean(plan.request.launch.buybackEnabled),
          BigInt(String(snapshotSnipe.startBps)),
          BigInt(String(snapshotSnipe.seconds)),
        ] as const;
        if (canonicalJson(curveState.map((value) => typeof value === "bigint" ? value.toString(10) : value)) !==
          canonicalJson(expectedCurveState.map((value) => typeof value === "bigint" ? value.toString(10) : value))) {
          throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Pons V2 curve state does not match the plan.", {
            broadcast: true,
          });
        }
        return { tokenInfo: { name, symbol, logo, description } };
      };

      let stateBlockNumber = receipt.blockNumber;
      let stateBlockHash = receipt.blockHash;
      let mode: "current-fallback" | "receipt-block" = "receipt-block";
      try {
        await readState(stateBlockNumber);
      } catch (error) {
        if (error instanceof NexusError && error.code === "LAUNCH_VERIFICATION_FAILED") throw error;
        if (!historicalStateUnavailable(error)) throw error;
        stateBlockNumber = await publicClient.getBlockNumber();
        mode = "current-fallback";
        const stateBlock = await publicClient.getBlock({ blockNumber: stateBlockNumber });
        if (stateBlock.hash === null) {
          throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Fallback state block has no canonical hash.", {
            broadcast: true,
          });
        }
        stateBlockHash = stateBlock.hash;
        await readState(stateBlockNumber);
        const finalStateBlock = await publicClient.getBlock({ blockNumber: stateBlockNumber });
        if (finalStateBlock.hash !== stateBlockHash) {
          throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Fallback state block changed during verification.", {
            broadcast: true,
          });
        }
      }

      return {
        verified: true,
        adapterId: "pons-v2",
        protocol: "Pons V2",
        planId: plan.id,
        chainId: plan.chainId,
        transactionHash: receipt.transactionHash,
        blockHash: receipt.blockHash,
        blockNumber: receipt.blockNumber.toString(10),
        token: expectedToken,
        market: expectedCurve,
        receipt,
        stateVerification: {
          blockHash: stateBlockHash,
          blockNumber: stateBlockNumber.toString(10),
          mode,
        },
      };
    },
  };
}
