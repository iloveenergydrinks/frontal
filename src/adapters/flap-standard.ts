import {
  concatHex,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  getContractAddress,
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
import { erc1967Implementation, requireEqual, runtimeCodeHash } from "../runtime.js";
import type {
  AdapterContext,
  AdapterPreparation,
  JsonObject,
  LaunchAdapter,
  LaunchPlan,
  LaunchResult,
} from "../types.js";

export const FLAP_BNB_PORTAL = getAddress("0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0");
export const FLAP_BNB_PORTAL_RUNTIME_HASH =
  "0x0a3fe6f701ee3cb432f45912e054896327ce5902337eae4d62d01406005a91c3" as Hash;
export const FLAP_BNB_IMPLEMENTATION = getAddress("0x6a3f464728b7197f76cbfa2725da58a27f70bb97");
export const FLAP_BNB_IMPLEMENTATION_RUNTIME_HASH =
  "0x197917cebf304bd653a7e80bff02e1b5eab63b96be3f819d6aecd761ad34e29b" as Hash;
export const FLAP_BNB_STANDARD_TOKEN_IMPLEMENTATION = getAddress("0x88881b6f03090462a969eC7f48385744Eeb63333");
export const FLAP_BNB_STANDARD_TOKEN_RUNTIME_HASH =
  "0xbadfe2870f273437f5957a27b64cf655991a92516ac1cbdfb616bfaeb7d3080c" as Hash;
export const FLAP_BNB_PROTOCOL_VERSION = "v5.17.0";
export const FLAP_BNB_PORTAL_LAUNCHER = getAddress("0x962adf68ef20c6f7b4d7b07d30a563c0e7adf712");
export const FLAP_BNB_PORTAL_LAUNCHER_RUNTIME_HASH =
  "0x8ae88d9f91756733e27d088ccb42d006d1607e1ec9863557742118119799fb17" as Hash;
export const FLAP_BNB_LAUNCHER_V7 = getAddress("0x96d067c4285ab4211bfa6745bf05334bdd3cf7bd");
export const FLAP_BNB_LAUNCHER_V7_RUNTIME_HASH =
  "0x16c98da8ab9dfd473320b9d9cd5c4f0f79355a177a159feed29f8ec703a247d5" as Hash;
export const FLAP_BNB_LAUNCHER_V7_STANDARD = getAddress("0xf92448546839bd8557594589b687e60055fc8445");
export const FLAP_BNB_LAUNCHER_V7_STANDARD_RUNTIME_HASH =
  "0x87de75493075290458665570c48ae694d517ae8aa6750f1383275cdc21a0c326" as Hash;
export const FLAP_BNB_MULTI_DEX_ROUTER = getAddress("0x9818eb714a8c0955c5915c368b2766d950275d24");
export const FLAP_BNB_MULTI_DEX_ROUTER_RUNTIME_HASH =
  "0x56691bdd16e4acaa50d07728fe2c2319705093a9ab064b34177b0ade24c94bf7" as Hash;
export const FLAP_BNB_PCS_INFINITY_CL_MIGRATOR = getAddress("0xc18a2876cb4b273abb872280faff49465cb4ac6c");
export const FLAP_BNB_PCS_INFINITY_CL_MIGRATOR_RUNTIME_HASH =
  "0x37798993cb3c820714d9c6f2a31155a0e1d35fc5bbd6230d748d7f2a230bc516" as Hash;

const TOKEN_V3_PERMIT = 7;
const DEX_THRESHOLD_FOUR_FIFTHS = 1;
const PCS_INFINITY_CL_MIGRATOR = 3;
const DEX0 = 0;
const FEE_TYPE_NONE = 0;
const FEE_TYPE_DIVIDEND = 2;
const DIVIDEND_BPS = 10_000;
const DIVIDEND_MINIMUM_SHARE_BALANCE = 10_000n * 10n ** 18n;

export const flapPortalAbi = parseAbi([
  "function version() view returns (string)",
  "function nonce() view returns (uint256)",
  "function isSpammerBlocked(address spammer) view returns (bool)",
  "function getQuoteTokenConfiguration(address quoteToken) view returns ((uint8 enabled,uint8 defaultCurve,uint8 alternativeCurve,uint8 nativeToQuoteSwapType,uint8 dexId) config)",
  "function getSaltLock(bytes32 salt) view returns ((address locker,uint8 tokenVersion,bool isUsed) entry)",
  "function newTokenV7((string name,string symbol,string meta,uint8 dexThresh,bytes32 salt,uint8 migratorType,address quoteToken,uint256 quoteAmt,bytes permitData,bytes32 extensionID,bytes extensionData,uint8 dexId,uint16 buyTaxRate,uint16 sellTaxRate,uint64 taxDuration,uint64 antiFarmerDuration,address commissionReceiver,uint8 tokenVersion,(uint8 feeType,uint16 bps,address marketingAddress,address dividendToken,uint256 minimumShareBalance)[4] feeConfigs) params) payable returns (address token)",
  "event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)",
]);

const flapTokenAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function metaURI() view returns (string)",
]);

export interface FlapStandardLaunchOptions {
  antiFarmerDuration?: bigint | number | string;
  initialBuy?: bigint | number | string;
  metadataCid: string;
  salt?: Hash;
  saltSeed?: Hex | string;
}

interface FlapDeploymentState {
  deployment: {
    address: Address;
    implementation: { address: Address; runtimeCodeHash: Hash };
    protocolVersion: string;
    runtimeCodeHash: Hash;
  };
  snapshot: JsonObject;
}

function cloneRuntimeCode(implementation: Address): Hex {
  return concatHex([
    "0x363d3d373d3d3d363d73",
    implementation,
    "0x5af43d82803e903d91602b57fd5bf3",
  ]);
}

function cloneInitCode(implementation: Address): Hex {
  return concatHex(["0x3d602d80600a3d3981f3", cloneRuntimeCode(implementation)]);
}

function historicalStateUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
  return /missing trie|historical state|not supported|pruned|state is not available/iu.test(message);
}

export function predictFlapStandardToken(salt: Hash): Address {
  return getContractAddress({
    bytecode: cloneInitCode(FLAP_BNB_STANDARD_TOKEN_IMPLEMENTATION),
    from: FLAP_BNB_PORTAL,
    opcode: "CREATE2",
    salt,
  });
}

function normalizeSaltSeed(seed: Hex | string | undefined, fallback: string): Hash {
  if (seed === undefined) return keccak256(stringToHex(fallback));
  if (/^0x[0-9a-fA-F]{64}$/u.test(seed)) return seed as Hash;
  return keccak256(stringToHex(seed));
}

async function saltLock(
  publicClient: PublicClient,
  salt: Hash,
  blockNumber?: bigint,
): Promise<{ isUsed: boolean; locker: Address; tokenVersion: number }> {
  const entry = await publicClient.readContract({
    address: FLAP_BNB_PORTAL,
    abi: flapPortalAbi,
    functionName: "getSaltLock",
    args: [salt],
    blockNumber,
  });
  return {
    locker: getAddress(entry.locker),
    tokenVersion: entry.tokenVersion,
    isUsed: entry.isUsed,
  };
}

function assertSaltAvailable(
  lock: { isUsed: boolean; locker: Address; tokenVersion: number },
  account: Address,
): void {
  if (lock.isUsed) throw new NexusError("PROTOCOL_CONFIG_CHANGED", "The selected Flap salt was already used.");
  if (lock.locker !== zeroAddress && lock.locker !== account) {
    throw new NexusError("PROTOCOL_CONFIG_CHANGED", `The selected Flap salt is locked by ${lock.locker}.`);
  }
  if (lock.locker === account && lock.tokenVersion !== TOKEN_V3_PERMIT) {
    throw new NexusError(
      "PROTOCOL_CONFIG_CHANGED",
      `The selected Flap salt is locked for token version ${lock.tokenVersion}, not ${TOKEN_V3_PERMIT}.`,
    );
  }
}

async function selectSalt(
  publicClient: PublicClient,
  account: Address,
  seed: Hash,
  requested: Hash | undefined,
  blockNumber: bigint,
): Promise<{ iterations: number; lock: { isUsed: boolean; locker: Address; tokenVersion: number }; predicted: Address; salt: Hash }> {
  if (requested !== undefined) {
    const predicted = predictFlapStandardToken(requested);
    if (!predicted.toLowerCase().endsWith("8888")) {
      throw new NexusError("INVALID_ARGUMENT", "Flap standard-token salt must predict an address ending in 8888.");
    }
    const lock = await saltLock(publicClient, requested, blockNumber);
    assertSaltAvailable(lock, account);
    const code = await publicClient.getCode({ address: predicted, blockNumber });
    if (code !== undefined && code !== "0x") throw new NexusError("INVALID_ARGUMENT", "Predicted Flap token already exists.");
    return { salt: requested, predicted, iterations: 0, lock };
  }

  let candidate = seed;
  for (let iterations = 0; iterations < 5_000_000; iterations += 1) {
    const predicted = predictFlapStandardToken(candidate);
    if (predicted.toLowerCase().endsWith("8888")) {
      const lock = await saltLock(publicClient, candidate, blockNumber);
      const code = await publicClient.getCode({ address: predicted, blockNumber });
      if (
        !lock.isUsed &&
        (lock.locker === zeroAddress || (lock.locker === account && lock.tokenVersion === TOKEN_V3_PERMIT)) &&
        (code === undefined || code === "0x")
      ) {
        return { salt: candidate, predicted, iterations, lock };
      }
    }
    candidate = keccak256(candidate);
  }
  throw new NexusError("PROTOCOL_NOT_READY", "No available Flap vanity salt was found within 5,000,000 attempts.");
}

async function readFlapState(
  publicClient: PublicClient,
  account: Address,
  blockNumber?: bigint,
): Promise<FlapDeploymentState> {
  const [
    proxyHash,
    implementation,
    version,
    blocked,
    quoteConfig,
    tokenImplHash,
    portalLauncherHash,
    launcherV7Hash,
    launcherV7StandardHash,
    multiDexRouterHash,
    pcsInfinityMigratorHash,
  ] = await Promise.all([
    runtimeCodeHash(publicClient, FLAP_BNB_PORTAL, blockNumber),
    erc1967Implementation(publicClient, FLAP_BNB_PORTAL, blockNumber),
    publicClient.readContract({
      address: FLAP_BNB_PORTAL,
      abi: flapPortalAbi,
      functionName: "version",
      blockNumber,
    }),
    publicClient.readContract({
      address: FLAP_BNB_PORTAL,
      abi: flapPortalAbi,
      functionName: "isSpammerBlocked",
      args: [account],
      blockNumber,
    }),
    publicClient.readContract({
      address: FLAP_BNB_PORTAL,
      abi: flapPortalAbi,
      functionName: "getQuoteTokenConfiguration",
      args: [zeroAddress],
      blockNumber,
    }),
    runtimeCodeHash(publicClient, FLAP_BNB_STANDARD_TOKEN_IMPLEMENTATION, blockNumber),
    runtimeCodeHash(publicClient, FLAP_BNB_PORTAL_LAUNCHER, blockNumber),
    runtimeCodeHash(publicClient, FLAP_BNB_LAUNCHER_V7, blockNumber),
    runtimeCodeHash(publicClient, FLAP_BNB_LAUNCHER_V7_STANDARD, blockNumber),
    runtimeCodeHash(publicClient, FLAP_BNB_MULTI_DEX_ROUTER, blockNumber),
    runtimeCodeHash(publicClient, FLAP_BNB_PCS_INFINITY_CL_MIGRATOR, blockNumber),
  ]);
  requireEqual(proxyHash, FLAP_BNB_PORTAL_RUNTIME_HASH, "Flap Portal proxy runtime hash changed.");
  requireEqual(implementation, FLAP_BNB_IMPLEMENTATION, "Flap Portal implementation address changed.");
  const implementationHash = await runtimeCodeHash(publicClient, implementation, blockNumber);
  requireEqual(implementationHash, FLAP_BNB_IMPLEMENTATION_RUNTIME_HASH, "Flap Portal implementation code changed.");
  requireEqual(version, FLAP_BNB_PROTOCOL_VERSION, "Flap Portal version changed.");
  requireEqual(tokenImplHash, FLAP_BNB_STANDARD_TOKEN_RUNTIME_HASH, "Flap standard-token implementation changed.");
  requireEqual(portalLauncherHash, FLAP_BNB_PORTAL_LAUNCHER_RUNTIME_HASH, "Flap Portal launcher code changed.");
  requireEqual(launcherV7Hash, FLAP_BNB_LAUNCHER_V7_RUNTIME_HASH, "Flap V7 launcher code changed.");
  requireEqual(
    launcherV7StandardHash,
    FLAP_BNB_LAUNCHER_V7_STANDARD_RUNTIME_HASH,
    "Flap V7 standard-launch implementation changed.",
  );
  requireEqual(multiDexRouterHash, FLAP_BNB_MULTI_DEX_ROUTER_RUNTIME_HASH, "Flap Multi-DEX router code changed.");
  requireEqual(
    pcsInfinityMigratorHash,
    FLAP_BNB_PCS_INFINITY_CL_MIGRATOR_RUNTIME_HASH,
    "Flap PCS Infinity CL migrator code changed.",
  );
  if (blocked) {
    throw new NexusError("PROTOCOL_NOT_READY", "The launch account is blocked by the Flap Portal.");
  }
  if (quoteConfig.enabled !== 1) {
    throw new NexusError("PROTOCOL_NOT_READY", "Flap native-BNB launches are currently disabled.");
  }
  return {
    deployment: {
      address: FLAP_BNB_PORTAL,
      protocolVersion: version,
      runtimeCodeHash: proxyHash,
      implementation: { address: implementation, runtimeCodeHash: implementationHash },
    },
    snapshot: {
      accountBlocked: blocked,
      quoteConfig: {
        alternativeCurve: quoteConfig.alternativeCurve,
        defaultCurve: quoteConfig.defaultCurve,
        dexId: quoteConfig.dexId,
        enabled: quoteConfig.enabled,
        nativeToQuoteSwapType: quoteConfig.nativeToQuoteSwapType,
      },
      standardTokenImplementation: FLAP_BNB_STANDARD_TOKEN_IMPLEMENTATION,
      standardTokenRuntimeHash: tokenImplHash,
      launchRuntimeDependencies: {
        portalLauncher: { address: FLAP_BNB_PORTAL_LAUNCHER, runtimeCodeHash: portalLauncherHash },
        launcherV7: { address: FLAP_BNB_LAUNCHER_V7, runtimeCodeHash: launcherV7Hash },
        launcherV7Standard: {
          address: FLAP_BNB_LAUNCHER_V7_STANDARD,
          runtimeCodeHash: launcherV7StandardHash,
        },
        multiDexRouter: { address: FLAP_BNB_MULTI_DEX_ROUTER, runtimeCodeHash: multiDexRouterHash },
        pcsInfinityCLMigrator: {
          address: FLAP_BNB_PCS_INFINITY_CL_MIGRATOR,
          runtimeCodeHash: pcsInfinityMigratorHash,
        },
      },
    },
  };
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

export function flapStandard(): LaunchAdapter<FlapStandardLaunchOptions> {
  return {
    id: "flap-standard",
    version: "0.1.0",
    chainId: 56,
    capabilities: {
      creatorFees: false,
      deterministicTokenAddress: true,
      initialBuy: "unsupported",
      metadataStorage: ["ipfs"],
      pricingModel: "bonding-curve",
      taxToken: false,
    },
    async prepare(context: AdapterContext<FlapStandardLaunchOptions>): Promise<AdapterPreparation> {
      if (!/^[a-zA-Z0-9]+$/u.test(context.launch.metadataCid)) {
        throw new NexusError("INVALID_TOKEN_METADATA", "Flap metadataCid must be a bare IPFS CID.");
      }
      const initialBuy = parseUint(context.launch.initialBuy, "initialBuy");
      if (initialBuy !== 0n) {
        throw new NexusError(
          "UNSUPPORTED_CAPABILITY",
          "Flap newTokenV7 has no minimum-output field for its embedded buy; Nexus v0.1 refuses an unprotected initial buy.",
        );
      }
      const antiFarmerDuration = parseUint(context.launch.antiFarmerDuration, "antiFarmerDuration");
      if (antiFarmerDuration > (1n << 64n) - 1n) {
        throw new NexusError("INVALID_ARGUMENT", "antiFarmerDuration exceeds uint64.");
      }
      const state = await readFlapState(context.publicClient, context.account, context.blockNumber);
      const seed = normalizeSaltSeed(
        context.launch.saltSeed,
        `${context.account}:${context.token.name}:${context.token.symbol}:${context.blockHash}`,
      );
      const selection = await selectSalt(
        context.publicClient,
        context.account,
        seed,
        context.launch.salt,
        context.blockNumber,
      );
      const launch = {
        antiFarmerDuration: antiFarmerDuration.toString(10),
        dividendBps: DIVIDEND_BPS,
        dividendMinimumShareBalance: DIVIDEND_MINIMUM_SHARE_BALANCE.toString(10),
        dividendToken: zeroAddress,
        initialBuy: "0",
        metadataCid: context.launch.metadataCid,
        predictedToken: selection.predicted,
        salt: selection.salt,
      } satisfies JsonObject;
      const data = encodeFunctionData({
        abi: flapPortalAbi,
        functionName: "newTokenV7",
        args: [
          {
            name: context.token.name,
            symbol: context.token.symbol,
            meta: context.launch.metadataCid,
            dexThresh: DEX_THRESHOLD_FOUR_FIFTHS,
            salt: selection.salt,
            migratorType: PCS_INFINITY_CL_MIGRATOR,
            quoteToken: zeroAddress,
            quoteAmt: 0n,
            permitData: "0x",
            extensionID: `0x${"00".repeat(32)}`,
            extensionData: "0x",
            dexId: DEX0,
            buyTaxRate: 0,
            sellTaxRate: 0,
            taxDuration: 0n,
            antiFarmerDuration,
            commissionReceiver: zeroAddress,
            tokenVersion: TOKEN_V3_PERMIT,
            feeConfigs: [
              {
                feeType: FEE_TYPE_DIVIDEND,
                bps: DIVIDEND_BPS,
                marketingAddress: zeroAddress,
                dividendToken: zeroAddress,
                minimumShareBalance: DIVIDEND_MINIMUM_SHARE_BALANCE,
              },
              {
                feeType: FEE_TYPE_NONE,
                bps: 0,
                marketingAddress: zeroAddress,
                dividendToken: zeroAddress,
                minimumShareBalance: 0n,
              },
              {
                feeType: FEE_TYPE_NONE,
                bps: 0,
                marketingAddress: zeroAddress,
                dividendToken: zeroAddress,
                minimumShareBalance: 0n,
              },
              {
                feeType: FEE_TYPE_NONE,
                bps: 0,
                marketingAddress: zeroAddress,
                dividendToken: zeroAddress,
                minimumShareBalance: 0n,
              },
            ],
          },
        ],
      });
      const snapshot: JsonObject = {
        ...state.snapshot,
        saltLock: {
          isUsed: selection.lock.isUsed,
          locker: selection.lock.locker,
          tokenVersion: selection.lock.tokenVersion,
        },
      };
      return {
        deployment: state.deployment,
        launch,
        snapshot,
        transaction: { to: FLAP_BNB_PORTAL, data, value: "0" },
        expected: {
          token: selection.predicted,
          pricingModel: "Flap constant-product bonding curve",
          liquidityVenue: "PancakeSwap Infinity CL migration",
          feeDistribution: "100% of configured distributable fees to eligible token holders in native BNB",
        },
        summary: {
          protocol: "Flap Standard",
          pricing: "Flap bonding curve with the current native-BNB quote configuration.",
          liquidity: "Migrates through Flap's Token V3 path into PancakeSwap Infinity concentrated liquidity.",
          costs: [{ label: "Launch transaction value", asset: "BNB", amount: "0" }],
          rows: [
            { label: "Portal", value: FLAP_BNB_PORTAL },
            { label: "Portal version", value: FLAP_BNB_PROTOCOL_VERSION },
            { label: "Launch entrypoint", value: "newTokenV7 / TOKEN_V3_PERMIT" },
            { label: "Metadata CID", value: context.launch.metadataCid },
            { label: "Fee distribution", value: "100% native-BNB dividends to eligible holders" },
            { label: "Dividend threshold", value: "10,000 tokens" },
            { label: "Predicted token", value: selection.predicted },
            { label: "DEX threshold", value: "80% sold" },
            { label: "Initial buy", value: "None" },
          ],
        },
        warnings: [
          {
            code: "UPGRADEABLE_PROTOCOL",
            message: "Flap Portal is upgradeable. Any implementation, runtime, version, or quote-config change invalidates this plan.",
          },
          {
            code: "EXTERNAL_PROTOCOL",
            message: "Nexus has not audited Flap. Bonding-curve trades currently charge the protocol's live fee.",
          },
          {
            code: "HOLDER_DIVIDENDS",
            message:
              "The live Flap V7 standard path routes configured distributable fees to eligible token holders, not to a creator marketing wallet.",
          },
        ],
      };
    },
    async revalidate(publicClient: PublicClient, plan: LaunchPlan): Promise<void> {
      const state = await readFlapState(publicClient, plan.account);
      const salt = String(plan.request.launch.salt) as Hash;
      const predicted = predictFlapStandardToken(salt);
      if (predicted !== getAddress(String(plan.request.launch.predictedToken))) {
        throw new NexusError("INVALID_PLAN", "Flap predicted token does not match the plan salt.");
      }
      const lock = await saltLock(publicClient, salt);
      assertSaltAvailable(lock, plan.account);
      const code = await publicClient.getCode({ address: predicted });
      if (code !== undefined && code !== "0x") {
        throw new NexusError("PROTOCOL_CONFIG_CHANGED", "The predicted Flap token address is no longer empty.");
      }
      const snapshot: JsonObject = {
        ...state.snapshot,
        saltLock: { isUsed: lock.isUsed, locker: lock.locker, tokenVersion: lock.tokenVersion },
      };
      comparePlanSnapshot(snapshot, plan.snapshot, "Flap Portal state");
      if (canonicalJson(state.deployment) !== canonicalJson(plan.deployment)) {
        throw new NexusError("DEPLOYMENT_CODE_MISMATCH", "Flap deployment changed after plan preparation.");
      }
    },
    async verify(
      publicClient: PublicClient,
      plan: LaunchPlan,
      receipt: TransactionReceipt,
    ): Promise<LaunchResult> {
      const launches: Array<{
        creator: Address;
        meta: string;
        name: string;
        symbol: string;
        token: Address;
      }> = [];
      for (const log of receipt.logs) {
        if (getAddress(log.address) !== FLAP_BNB_PORTAL) continue;
        try {
          const decoded = decodeEventLog({ abi: flapPortalAbi, data: log.data, topics: log.topics });
          if (decoded.eventName === "TokenCreated") launches.push(decoded.args);
        } catch {
          // Other Portal events in the same receipt are expected.
        }
      }
      if (launches.length !== 1) {
        throw new NexusError(
          "LAUNCH_VERIFICATION_FAILED",
          `Expected one Flap TokenCreated event, found ${launches.length}.`,
          { broadcast: true },
        );
      }
      const launched = launches[0];
      if (launched === undefined) throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Missing Flap launch event.");
      const expectedToken = getAddress(String(plan.request.launch.predictedToken));
      if (
        getAddress(launched.creator) !== plan.account ||
        getAddress(launched.token) !== expectedToken ||
        launched.name !== plan.request.token.name ||
        launched.symbol !== plan.request.token.symbol ||
        launched.meta !== String(plan.request.launch.metadataCid)
      ) {
        throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Flap TokenCreated event does not match the plan.", {
          broadcast: true,
        });
      }
      const expectedCloneHash = keccak256(cloneRuntimeCode(FLAP_BNB_STANDARD_TOKEN_IMPLEMENTATION));
      let stateBlockNumber = receipt.blockNumber;
      let stateBlockHash = receipt.blockHash;
      let stateVerificationMode: "current-fallback" | "receipt-block" = "receipt-block";
      const readTokenState = async (blockNumber: bigint): Promise<{ meta: string; name: string; symbol: string }> => {
        const tokenCodeHash = await runtimeCodeHash(publicClient, expectedToken, blockNumber);
        requireEqual(tokenCodeHash, expectedCloneHash, "Flap token is not the exact pinned standard-token clone.");
        const [name, symbol, meta] = await Promise.all([
          publicClient.readContract({
            address: expectedToken,
            abi: flapTokenAbi,
            functionName: "name",
            blockNumber,
          }),
          publicClient.readContract({
            address: expectedToken,
            abi: flapTokenAbi,
            functionName: "symbol",
            blockNumber,
          }),
          publicClient.readContract({
            address: expectedToken,
            abi: flapTokenAbi,
            functionName: "metaURI",
            blockNumber,
          }),
        ]);
        return { meta, name, symbol };
      };
      let tokenState: { meta: string; name: string; symbol: string };
      try {
        tokenState = await readTokenState(stateBlockNumber);
      } catch (error) {
        if (!historicalStateUnavailable(error)) throw error;
        stateBlockNumber = await publicClient.getBlockNumber();
        stateVerificationMode = "current-fallback";
        const stateBlock = await publicClient.getBlock({ blockNumber: stateBlockNumber });
        if (stateBlock.hash === null) {
          throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Fallback state block has no canonical hash.", {
            broadcast: true,
          });
        }
        stateBlockHash = stateBlock.hash;
        tokenState = await readTokenState(stateBlockNumber);
        const finalStateBlock = await publicClient.getBlock({ blockNumber: stateBlockNumber });
        if (finalStateBlock.hash !== stateBlockHash) {
          throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Fallback state block changed during verification.", {
            broadcast: true,
          });
        }
      }
      if (
        tokenState.name !== launched.name ||
        tokenState.symbol !== launched.symbol ||
        tokenState.meta !== launched.meta
      ) {
        throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Flap token getters do not match the launch event.", {
          broadcast: true,
        });
      }
      return {
        verified: true,
        adapterId: "flap-standard",
        protocol: "Flap Standard",
        planId: plan.id,
        chainId: plan.chainId,
        transactionHash: receipt.transactionHash,
        blockHash: receipt.blockHash,
        blockNumber: receipt.blockNumber.toString(10),
        token: expectedToken,
        receipt,
        stateVerification: {
          blockHash: stateBlockHash,
          blockNumber: stateBlockNumber.toString(10),
          mode: stateVerificationMode,
        },
      };
    },
  };
}
