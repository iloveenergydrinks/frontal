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

/** Active Pons deployment, start block 8991118. */
export const PONS_FACTORY = getAddress("0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB");
export const PONS_FACTORY_RUNTIME_HASH =
  "0x0a62b8ed1d88d30c7b342ea8361dfaf0ac336706992cf0c8ba38b129f06391d4" as Hash;
export const PONS_LOCKER = getAddress("0x736D76699C26D0d966744cAe304C000d471f7F35");
export const PONS_LOCKER_RUNTIME_HASH =
  "0xa7880a625a649da833de5597c9f41585bb75e20ef91d45830ccc6f4e49cc281c" as Hash;
export const PONS_PROTOCOL_VERSION = "active-8991118";

/**
 * The legacy deployment (start block 8600612) stays readable for historical
 * launches. Nexus never prepares a new launch against it.
 */
export const PONS_LEGACY_FACTORY = getAddress("0x0c37a24F5D23A486FA692d1500881d698B1F77a4");

const PONS_TOKEN_PARAMS =
  "(string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address feeWallet)";

export const ponsFactoryAbi = parseAbi([
  "function launchEnabled() view returns (bool)",
  "function launchFee() view returns (uint256)",
  "function locker() view returns (address)",
  "function whitelistedLaunchers(address launcher) view returns (bool enabled)",
  "function launchConfigCount() view returns (uint256)",
  "function dexConfigCount() view returns (uint256)",
  "function getLaunchConfig(uint256 id) view returns ((address pairToken,uint256 graduationThreshold,int24 initialTick,uint256 supply,uint16 maxWalletBps,uint16 maxTxBps,uint32 restrictionBlocks,uint24 reservedFee,bool enabled,bool routerRequiresDeadline) config)",
  "function getDexConfig(uint256 id) view returns ((string name,address factory,address positionManager,address swapRouter,uint24 poolFee,int24 tickSpacing,bool enabled) config)",
  "function getLaunchedToken(address token) view returns ((address token,address deployer,address pairedToken,address positionManager,uint256 positionId,uint256 dexId,uint256 launchConfigId,uint256 restrictionsEndBlock,uint256 supply,bool isToken0,uint24 poolFee,bool exists,uint256 initialBuyAmount) launched)",
  "function graduationStatus(address token) view returns (uint256 pairedPrincipal,uint256 threshold,bool graduated)",
  `function predictTokenAddress(${PONS_TOKEN_PARAMS} params,uint256 launchConfigId,uint256 dexId,bytes32 salt,address tokenDeployer) view returns (address)`,
  `function launchToken(${PONS_TOKEN_PARAMS} params,uint256 launchConfigId,uint256 dexId,bytes32 salt) payable returns (address token)`,
  "event TokenLaunched(address indexed token,address indexed deployer,address indexed dexFactory,address pairToken,address pool,uint256 dexId,uint256 launchConfigId,uint256 positionId,uint256 restrictionsEndBlock,uint256 initialBuyAmount)",
]);

const ponsTokenAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function logo() view returns (string)",
  "function description() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function liquidityPool() view returns (address)",
  "function socials() view returns (string twitter,string telegram,string discord,string website,string farcaster)",
]);

const v3FactoryAbi = parseAbi([
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)",
]);

const positionManagerAbi = parseAbi(["function ownerOf(uint256 tokenId) view returns (address owner)"]);

const MAX_SALT_ATTEMPTS = 64;

export interface PonsLaunchOptions {
  dexId?: number;
  /** Receives creator fee payouts and the atomic initial buy; defaults to the launch account. */
  feeWallet?: Address;
  initialBuy?: bigint | number | string;
  launchConfigId?: number;
  salt?: Hash;
  saltSeed?: Hex | string;
}

interface PonsTokenParams {
  description: string;
  feeWallet: Address;
  logo: string;
  name: string;
  socials: {
    discord: string;
    farcaster: string;
    telegram: string;
    twitter: string;
    website: string;
  };
  symbol: string;
}

interface PonsState {
  dex: {
    enabled: boolean;
    factory: Address;
    name: string;
    poolFee: number;
    positionManager: Address;
    swapRouter: Address;
    tickSpacing: number;
  };
  deployment: {
    address: Address;
    protocolVersion: string;
    runtimeCodeHash: Hash;
  };
  launchConfig: {
    enabled: boolean;
    graduationThreshold: bigint;
    initialTick: number;
    maxTxBps: number;
    maxWalletBps: number;
    pairToken: Address;
    reservedFee: number;
    restrictionBlocks: number;
    routerRequiresDeadline: boolean;
    supply: bigint;
  };
  launchFee: bigint;
  snapshot: JsonObject;
}

function parseUint(value: bigint | number | string | undefined, field: string): bigint {
  if (value === undefined) return 0n;
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch (cause) {
    throw new NexusError("INVALID_ARGUMENT", `${field} must be a non-negative integer.`, { cause });
  }
  if (parsed < 0n) throw new NexusError("INVALID_ARGUMENT", `${field} must be non-negative.`);
  return parsed;
}

function parseConfigId(value: number | undefined, field: string): number {
  const id = value ?? 0;
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new NexusError("INVALID_ARGUMENT", `${field} must be a non-negative safe integer.`);
  }
  return id;
}

function normalizeSaltSeed(seed: Hex | string | undefined, fallback: string): Hash {
  if (seed === undefined) return keccak256(stringToHex(fallback));
  if (/^0x[0-9a-fA-F]{64}$/u.test(seed)) return seed as Hash;
  return keccak256(stringToHex(seed));
}

function tokenParams(token: NormalizedTokenMetadata, feeWallet: Address): PonsTokenParams {
  return {
    description: token.description,
    feeWallet,
    logo: token.image,
    name: token.name,
    socials: {
      discord: token.socials.discord,
      farcaster: token.socials.farcaster,
      telegram: token.socials.telegram,
      twitter: token.socials.twitter,
      website: token.socials.website,
    },
    symbol: token.symbol,
  };
}

async function readPonsState(
  publicClient: PublicClient,
  account: Address,
  launchConfigId: number,
  dexId: number,
  blockNumber?: bigint,
): Promise<PonsState> {
  const factoryHash = await runtimeCodeHash(publicClient, PONS_FACTORY, blockNumber);
  requireEqual(
    factoryHash,
    PONS_FACTORY_RUNTIME_HASH,
    `Pons factory runtime hash ${factoryHash} is not the reviewed hash ${PONS_FACTORY_RUNTIME_HASH}.`,
  );
  const contract = { address: PONS_FACTORY, abi: ponsFactoryAbi, blockNumber } as const;
  const [launchEnabled, whitelisted, launchFee, locker, launchConfigCount, dexConfigCount] = await Promise.all([
    publicClient.readContract({ ...contract, functionName: "launchEnabled" }),
    publicClient.readContract({ ...contract, functionName: "whitelistedLaunchers", args: [account] }),
    publicClient.readContract({ ...contract, functionName: "launchFee" }),
    publicClient.readContract({ ...contract, functionName: "locker" }),
    publicClient.readContract({ ...contract, functionName: "launchConfigCount" }),
    publicClient.readContract({ ...contract, functionName: "dexConfigCount" }),
  ]);

  if (!launchEnabled && !whitelisted) {
    throw new NexusError(
      "PROTOCOL_NOT_READY",
      "Pons public launches are disabled and this account is not whitelisted.",
      { recovery: "Wait for public launch enablement or ask Pons to whitelist the exact launch wallet." },
    );
  }
  if (BigInt(launchConfigId) >= launchConfigCount) {
    throw new NexusError("INVALID_ARGUMENT", `Pons has ${launchConfigCount} launch configurations.`);
  }
  if (BigInt(dexId) >= dexConfigCount) {
    throw new NexusError("INVALID_ARGUMENT", `Pons has ${dexConfigCount} DEX configurations.`);
  }
  requireEqual(getAddress(locker), PONS_LOCKER, `Pons locker changed to ${locker}.`);

  const [config, dex, lockerHash] = await Promise.all([
    publicClient.readContract({ ...contract, functionName: "getLaunchConfig", args: [BigInt(launchConfigId)] }),
    publicClient.readContract({ ...contract, functionName: "getDexConfig", args: [BigInt(dexId)] }),
    runtimeCodeHash(publicClient, PONS_LOCKER, blockNumber),
  ]);
  requireEqual(lockerHash, PONS_LOCKER_RUNTIME_HASH, "Pons locker runtime code changed.");
  if (!config.enabled) {
    throw new NexusError("PROTOCOL_NOT_READY", `Pons launch configuration ${launchConfigId} is disabled.`);
  }
  if (!dex.enabled) {
    throw new NexusError("PROTOCOL_NOT_READY", `Pons DEX configuration ${dexId} is disabled.`);
  }

  const dexFactory = getAddress(dex.factory);
  const positionManager = getAddress(dex.positionManager);
  const swapRouter = getAddress(dex.swapRouter);
  const [dexFactoryHash, positionManagerHash, swapRouterHash] = await Promise.all([
    runtimeCodeHash(publicClient, dexFactory, blockNumber),
    runtimeCodeHash(publicClient, positionManager, blockNumber),
    runtimeCodeHash(publicClient, swapRouter, blockNumber),
  ]);

  const snapshot: JsonObject = {
    dexConfig: {
      dexId,
      enabled: dex.enabled,
      factory: dexFactory,
      name: dex.name,
      poolFee: dex.poolFee,
      positionManager,
      swapRouter,
      tickSpacing: dex.tickSpacing,
    },
    dexRuntimeDependencies: {
      factory: { address: dexFactory, runtimeCodeHash: dexFactoryHash },
      positionManager: { address: positionManager, runtimeCodeHash: positionManagerHash },
      swapRouter: { address: swapRouter, runtimeCodeHash: swapRouterHash },
    },
    launchConfig: {
      enabled: config.enabled,
      graduationThreshold: config.graduationThreshold.toString(10),
      initialTick: config.initialTick,
      launchConfigId,
      maxTxBps: config.maxTxBps,
      maxWalletBps: config.maxWalletBps,
      pairToken: getAddress(config.pairToken),
      reservedFee: config.reservedFee,
      restrictionBlocks: config.restrictionBlocks,
      routerRequiresDeadline: config.routerRequiresDeadline,
      supply: config.supply.toString(10),
    },
    launchEnabled,
    launchFee: launchFee.toString(10),
    launcherWhitelisted: whitelisted,
    locker: { address: PONS_LOCKER, runtimeCodeHash: lockerHash },
  };

  return {
    dex: {
      enabled: dex.enabled,
      factory: dexFactory,
      name: dex.name,
      poolFee: dex.poolFee,
      positionManager,
      swapRouter,
      tickSpacing: dex.tickSpacing,
    },
    deployment: {
      address: PONS_FACTORY,
      protocolVersion: PONS_PROTOCOL_VERSION,
      runtimeCodeHash: factoryHash,
    },
    launchConfig: {
      enabled: config.enabled,
      graduationThreshold: config.graduationThreshold,
      initialTick: config.initialTick,
      maxTxBps: config.maxTxBps,
      maxWalletBps: config.maxWalletBps,
      pairToken: getAddress(config.pairToken),
      reservedFee: config.reservedFee,
      restrictionBlocks: config.restrictionBlocks,
      routerRequiresDeadline: config.routerRequiresDeadline,
      supply: config.supply,
    },
    launchFee,
    snapshot,
  };
}

async function saltCandidate(
  publicClient: PublicClient,
  account: Address,
  params: PonsTokenParams,
  launchConfigId: number,
  dexId: number,
  salt: Hash,
  state: PonsState,
  blockNumber?: bigint,
): Promise<{ free: boolean; predicted: Address }> {
  const predicted = await publicClient.readContract({
    address: PONS_FACTORY,
    abi: ponsFactoryAbi,
    functionName: "predictTokenAddress",
    args: [params, BigInt(launchConfigId), BigInt(dexId), salt, account],
    blockNumber,
  });
  const [code, pool] = await Promise.all([
    publicClient.getCode({ address: predicted, blockNumber }),
    publicClient.readContract({
      address: state.dex.factory,
      abi: v3FactoryAbi,
      functionName: "getPool",
      args: [predicted, state.launchConfig.pairToken, state.dex.poolFee],
      blockNumber,
    }),
  ]);
  const free = (code === undefined || code === "0x") && getAddress(pool) === zeroAddress;
  return { free, predicted: getAddress(predicted) };
}

async function selectSalt(
  publicClient: PublicClient,
  account: Address,
  params: PonsTokenParams,
  launchConfigId: number,
  dexId: number,
  state: PonsState,
  seed: Hash,
  requested: Hash | undefined,
  blockNumber?: bigint,
): Promise<{ predicted: Address; salt: Hash }> {
  if (requested !== undefined) {
    const candidate = await saltCandidate(
      publicClient,
      account,
      params,
      launchConfigId,
      dexId,
      requested,
      state,
      blockNumber,
    );
    if (!candidate.free) {
      throw new NexusError(
        "PROTOCOL_CONFIG_CHANGED",
        `The requested Pons salt predicts ${candidate.predicted}, which already has code or a pool.`,
      );
    }
    return { predicted: candidate.predicted, salt: requested };
  }
  let salt = seed;
  for (let attempt = 0; attempt < MAX_SALT_ATTEMPTS; attempt += 1) {
    const candidate = await saltCandidate(
      publicClient,
      account,
      params,
      launchConfigId,
      dexId,
      salt,
      state,
      blockNumber,
    );
    if (candidate.free) return { predicted: candidate.predicted, salt };
    salt = keccak256(salt);
  }
  throw new NexusError(
    "PROTOCOL_NOT_READY",
    `No free Pons salt was found within ${MAX_SALT_ATTEMPTS} attempts.`,
  );
}

export function pons(): LaunchAdapter<PonsLaunchOptions> {
  return {
    id: "pons",
    version: "0.2.0",
    chainId: 4663,
    capabilities: {
      creatorFees: true,
      deterministicTokenAddress: true,
      initialBuy: "unsupported",
      metadataStorage: ["onchain", "https", "ipfs"],
      pricingModel: "fixed-liquidity",
      taxToken: false,
    },
    async prepare(context: AdapterContext<PonsLaunchOptions>): Promise<AdapterPreparation> {
      const launchConfigId = parseConfigId(context.launch.launchConfigId, "launchConfigId");
      const dexId = parseConfigId(context.launch.dexId, "dexId");
      const feeWallet = getAddress(context.launch.feeWallet ?? context.account);
      const initialBuy = parseUint(context.launch.initialBuy, "initialBuy");
      if (initialBuy !== 0n) {
        throw new NexusError(
          "UNSUPPORTED_CAPABILITY",
          "Nexus will not use Pons V1's atomic initial buy because it has no minimum-output protection.",
        );
      }
      if (context.token.name.length === 0 || context.token.symbol.length === 0) {
        throw new NexusError("INVALID_TOKEN_METADATA", "Pons requires a non-empty token name and symbol.");
      }

      const state = await readPonsState(
        context.publicClient,
        context.account,
        launchConfigId,
        dexId,
        context.blockNumber,
      );
      const params = tokenParams(context.token, feeWallet);
      const seed = normalizeSaltSeed(
        context.launch.saltSeed,
        `${context.account}:${context.token.name}:${context.token.symbol}:${context.blockHash}`,
      );
      const selection = await selectSalt(
        context.publicClient,
        context.account,
        params,
        launchConfigId,
        dexId,
        state,
        seed,
        context.launch.salt,
        context.blockNumber,
      );

      const value = state.launchFee + initialBuy;
      const launch = {
        dexId,
        feeWallet,
        initialBuy: initialBuy.toString(10),
        launchConfigId,
        predictedToken: selection.predicted,
        salt: selection.salt,
      } satisfies JsonObject;
      const data = encodeFunctionData({
        abi: ponsFactoryAbi,
        functionName: "launchToken",
        args: [params, BigInt(launchConfigId), BigInt(dexId), selection.salt],
      });

      const warnings = [
        {
          code: "EXTERNAL_PROTOCOL",
          message:
            "Nexus has not audited Pons. The factory owner controls the launch fee, launch configurations, and DEX configurations.",
        },
        {
          code: "LAUNCH_RESTRICTIONS",
          message: `Buys are restricted for ${state.launchConfig.restrictionBlocks} blocks after launch: at most ${state.launchConfig.maxWalletBps / 100}% of supply held and ${state.launchConfig.maxTxBps / 100}% bought per wallet. Selling and transfers are unrestricted.`,
        },
        {
          code: "PERMANENT_LOCK",
          message:
            "The entire supply is seeded as one-sided liquidity and the resulting Uniswap V3 position is transferred to the Pons locker. Nexus cannot recover it.",
        },
      ];
      return {
        deployment: state.deployment,
        launch,
        snapshot: state.snapshot,
        transaction: { to: PONS_FACTORY, data, value: value.toString(10) },
        expected: {
          token: selection.predicted,
          graduationThreshold: state.launchConfig.graduationThreshold.toString(10),
          pricingModel: "Fixed supply seeded as one-sided Uniswap V3 liquidity",
          liquidityVenue: `Uniswap V3 ${state.dex.poolFee / 10_000}% ${state.launchConfig.pairToken} pool locked by the Pons locker`,
        },
        summary: {
          protocol: "Pons V1",
          pricing:
            "Fixed supply priced by the pool's initial tick; every buy and sell trades against that same locked pool.",
          liquidity:
            "Liquidity is locked at launch and stays in the same pool through graduation. There is no migration.",
          costs: [
            { label: "Launch fee", asset: "ETH", amount: state.launchFee.toString(10) },
            { label: "Initial buy", asset: "ETH", amount: initialBuy.toString(10) },
          ],
          rows: [
            { label: "Factory", value: PONS_FACTORY },
            { label: "Deployment", value: PONS_PROTOCOL_VERSION },
            { label: "Launch config", value: String(launchConfigId) },
            { label: "DEX", value: `${state.dex.name} (id ${dexId})` },
            { label: "Pool fee", value: `${state.dex.poolFee / 10_000}%` },
            { label: "Pair token", value: state.launchConfig.pairToken },
            { label: "Supply", value: state.launchConfig.supply.toString(10) },
            { label: "Graduation threshold", value: state.launchConfig.graduationThreshold.toString(10) },
            { label: "Fee wallet", value: feeWallet },
            { label: "Predicted token", value: selection.predicted },
            { label: "Salt", value: selection.salt },
            {
              label: "Launch restrictions",
              value: `${state.launchConfig.restrictionBlocks} blocks, ${state.launchConfig.maxWalletBps / 100}% max wallet, ${state.launchConfig.maxTxBps / 100}% max buy`,
            },
          ],
        },
        warnings,
      };
    },
    async revalidate(publicClient: PublicClient, plan: LaunchPlan): Promise<void> {
      const launchConfigId = Number(plan.request.launch.launchConfigId);
      const dexId = Number(plan.request.launch.dexId);
      const state = await readPonsState(publicClient, plan.account, launchConfigId, dexId);
      comparePlanSnapshot(state.snapshot, plan.snapshot, "Pons launch configuration");
      if (canonicalJson(state.deployment) !== canonicalJson(plan.deployment)) {
        throw new NexusError("DEPLOYMENT_CODE_MISMATCH", "Pons deployment changed after plan preparation.");
      }
      const params = tokenParams(plan.request.token, getAddress(String(plan.request.launch.feeWallet)));
      const candidate = await saltCandidate(
        publicClient,
        plan.account,
        params,
        launchConfigId,
        dexId,
        String(plan.request.launch.salt) as Hash,
        state,
      );
      if (candidate.predicted !== getAddress(String(plan.request.launch.predictedToken))) {
        throw new NexusError("INVALID_PLAN", "Pons predicted token no longer matches the plan salt.");
      }
      if (!candidate.free) {
        throw new NexusError(
          "PROTOCOL_CONFIG_CHANGED",
          `The planned Pons token address ${candidate.predicted} now has code or an existing pool.`,
        );
      }
    },
    async verify(
      publicClient: PublicClient,
      plan: LaunchPlan,
      receipt: TransactionReceipt,
    ): Promise<LaunchResult> {
      const launches: Array<{
        dexFactory: Address;
        dexId: bigint;
        deployer: Address;
        initialBuyAmount: bigint;
        launchConfigId: bigint;
        pairToken: Address;
        pool: Address;
        positionId: bigint;
        restrictionsEndBlock: bigint;
        token: Address;
      }> = [];
      for (const log of receipt.logs) {
        if (getAddress(log.address) !== PONS_FACTORY) continue;
        try {
          const decoded = decodeEventLog({ abi: ponsFactoryAbi, data: log.data, topics: log.topics });
          if (decoded.eventName === "TokenLaunched") launches.push(decoded.args);
        } catch {
          // Other factory events in the same receipt are expected.
        }
      }
      if (launches.length !== 1) {
        throw new NexusError(
          "LAUNCH_VERIFICATION_FAILED",
          `Expected one Pons TokenLaunched event, found ${launches.length}.`,
          { broadcast: true },
        );
      }
      const launched = launches[0];
      if (launched === undefined) throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Missing Pons launch event.");

      const snapshotDex = plan.snapshot.dexConfig as JsonObject;
      const snapshotConfig = plan.snapshot.launchConfig as JsonObject;
      const expectedToken = getAddress(String(plan.request.launch.predictedToken));
      if (
        getAddress(launched.deployer) !== plan.account ||
        getAddress(launched.token) !== expectedToken ||
        launched.launchConfigId !== BigInt(String(plan.request.launch.launchConfigId)) ||
        launched.dexId !== BigInt(String(plan.request.launch.dexId)) ||
        getAddress(launched.dexFactory) !== getAddress(String(snapshotDex.factory)) ||
        getAddress(launched.pairToken) !== getAddress(String(snapshotConfig.pairToken)) ||
        launched.initialBuyAmount !== BigInt(String(plan.request.launch.initialBuy))
      ) {
        throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Pons TokenLaunched event does not match the plan.", {
          broadcast: true,
        });
      }
      if (getAddress(launched.pool) === zeroAddress) {
        throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Pons launch reported no pool.", { broadcast: true });
      }

      const positionManager = getAddress(String(snapshotDex.positionManager));
      const readState = async (
        blockNumber: bigint,
      ): Promise<{
        description: string;
        logo: string;
        name: string;
        pool: Address;
        positionOwner: Address;
        supply: bigint;
        symbol: string;
      }> => {
        const record = await publicClient.readContract({
          address: PONS_FACTORY,
          abi: ponsFactoryAbi,
          functionName: "getLaunchedToken",
          args: [expectedToken],
          blockNumber,
        });
        if (
          !record.exists ||
          getAddress(record.token) !== expectedToken ||
          getAddress(record.deployer) !== plan.account ||
          getAddress(record.pairedToken) !== getAddress(launched.pairToken) ||
          getAddress(record.positionManager) !== positionManager ||
          record.positionId !== launched.positionId ||
          record.dexId !== launched.dexId ||
          record.launchConfigId !== launched.launchConfigId ||
          record.restrictionsEndBlock !== launched.restrictionsEndBlock ||
          record.supply !== BigInt(String(snapshotConfig.supply)) ||
          record.poolFee !== Number(snapshotDex.poolFee) ||
          record.initialBuyAmount !== launched.initialBuyAmount
        ) {
          throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Pons factory launch record is inconsistent.", {
            broadcast: true,
          });
        }
        await runtimeCodeHash(publicClient, expectedToken, blockNumber);
        const token = { address: expectedToken, abi: ponsTokenAbi, blockNumber } as const;
        const [name, symbol, logo, description, supply, pool, positionOwner] = await Promise.all([
          publicClient.readContract({ ...token, functionName: "name" }),
          publicClient.readContract({ ...token, functionName: "symbol" }),
          publicClient.readContract({ ...token, functionName: "logo" }),
          publicClient.readContract({ ...token, functionName: "description" }),
          publicClient.readContract({ ...token, functionName: "totalSupply" }),
          publicClient.readContract({ ...token, functionName: "liquidityPool" }),
          publicClient.readContract({
            address: positionManager,
            abi: positionManagerAbi,
            functionName: "ownerOf",
            args: [launched.positionId],
            blockNumber,
          }),
        ]);
        return {
          description,
          logo,
          name,
          pool: getAddress(pool),
          positionOwner: getAddress(positionOwner),
          supply,
          symbol,
        };
      };

      let stateBlockNumber = receipt.blockNumber;
      let stateBlockHash = receipt.blockHash;
      let mode: "current-fallback" | "receipt-block" = "receipt-block";
      let tokenState: Awaited<ReturnType<typeof readState>>;
      try {
        tokenState = await readState(stateBlockNumber);
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
        tokenState = await readState(stateBlockNumber);
        const finalStateBlock = await publicClient.getBlock({ blockNumber: stateBlockNumber });
        if (finalStateBlock.hash !== stateBlockHash) {
          throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Fallback state block changed during verification.", {
            broadcast: true,
          });
        }
      }

      if (
        tokenState.name !== plan.request.token.name ||
        tokenState.symbol !== plan.request.token.symbol ||
        tokenState.logo !== plan.request.token.image ||
        tokenState.description !== plan.request.token.description ||
        tokenState.supply !== BigInt(String(snapshotConfig.supply)) ||
        tokenState.pool !== getAddress(launched.pool)
      ) {
        throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Pons token state does not match the plan.", {
          broadcast: true,
        });
      }
      if (tokenState.positionOwner !== PONS_LOCKER) {
        throw new NexusError(
          "LAUNCH_VERIFICATION_FAILED",
          `The launch position is held by ${tokenState.positionOwner}, not the Pons locker.`,
          { broadcast: true },
        );
      }

      return {
        verified: true,
        adapterId: "pons",
        protocol: "Pons V1",
        planId: plan.id,
        chainId: plan.chainId,
        transactionHash: receipt.transactionHash,
        blockHash: receipt.blockHash,
        blockNumber: receipt.blockNumber.toString(10),
        token: expectedToken,
        market: getAddress(launched.pool),
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
