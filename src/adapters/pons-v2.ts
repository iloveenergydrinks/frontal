import {
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  isAddress,
  parseAbi,
  zeroAddress,
  type Address,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
} from "viem";

import { NexusError } from "../errors.js";
import { comparePlanSnapshot } from "../launch.js";
import { canonicalJson } from "../serialization.js";
import { requireEqual, runtimeCodeHash } from "../runtime.js";
import type {
  AdapterContext,
  AdapterPreparation,
  JsonObject,
  LaunchAdapter,
  LaunchPlan,
  LaunchResult,
} from "../types.js";

export const PONS_V2_FACTORY = getAddress("0x7E1EAbd52Ae29598e6483F72dCf1a70b14284dB8");
export const PONS_V2_RUNTIME_HASH =
  "0x9d6391ccd6730301cf53ea0f520b42d9f13d9dd11ba803c19ae3a01d145b7d9e" as Hash;

export const ponsV2Abi = parseAbi([
  "function launchEnabled() view returns (bool)",
  "function launchFee() view returns (uint256)",
  "function maxCreatorTaxBps() view returns (uint256)",
  "function whitelistedLaunchers(address launcher) view returns (bool)",
  "function getLaunchConfig(uint256 id) view returns ((uint256 supply,uint256 curveFeeBps,uint256 phantomQuote,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,bool enabled) config)",
  "function previewLaunchEconomics(uint256 launchConfigId,address pairToken) view returns (bytes32)",
  "function launchToken((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics) params,uint256 launchConfigId,address pairToken) payable returns (address token,address curve)",
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists) launched)",
  "event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)",
]);

export interface PonsV2LaunchOptions {
  buybackEnabled?: boolean;
  creatorFeeRecipient?: Address;
  creatorTaxBps?: number;
  launchConfigId?: number;
  pairToken?: Address;
}

interface PonsState {
  deployment: {
    address: Address;
    protocolVersion: string;
    runtimeCodeHash: Hash;
  };
  snapshot: JsonObject;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function requireMaxBytes(value: string, maximum: number, field: string): void {
  if (byteLength(value) > maximum) {
    throw new NexusError("INVALID_TOKEN_METADATA", `${field} exceeds the Pons V2 ${maximum}-byte limit.`);
  }
}

async function readPonsState(
  publicClient: PublicClient,
  account: Address,
  launchConfigId: number,
  pairToken: Address,
  blockNumber?: bigint,
): Promise<PonsState> {
  const codeHash = await runtimeCodeHash(publicClient, PONS_V2_FACTORY, blockNumber);
  requireEqual(
    codeHash,
    PONS_V2_RUNTIME_HASH,
    `Pons V2 runtime hash ${codeHash} is not the reviewed hash ${PONS_V2_RUNTIME_HASH}.`,
  );
  const contract = { address: PONS_V2_FACTORY, abi: ponsV2Abi, blockNumber } as const;
  const [launchEnabled, whitelisted, launchFee, maxCreatorTaxBps, launchConfig, economics] =
    await Promise.all([
      publicClient.readContract({ ...contract, functionName: "launchEnabled" }),
      publicClient.readContract({ ...contract, functionName: "whitelistedLaunchers", args: [account] }),
      publicClient.readContract({ ...contract, functionName: "launchFee" }),
      publicClient.readContract({ ...contract, functionName: "maxCreatorTaxBps" }),
      publicClient.readContract({ ...contract, functionName: "getLaunchConfig", args: [BigInt(launchConfigId)] }),
      publicClient.readContract({
        ...contract,
        functionName: "previewLaunchEconomics",
        args: [BigInt(launchConfigId), pairToken],
      }),
    ]);

  const snapshot: JsonObject = {
    economics,
    launchConfig: {
      curveFeeBps: launchConfig.curveFeeBps.toString(10),
      enabled: launchConfig.enabled,
      graduationThreshold: launchConfig.graduationThreshold.toString(10),
      phantomQuote: launchConfig.phantomQuote.toString(10),
      poolFee: launchConfig.poolFee,
      supply: launchConfig.supply.toString(10),
      tickSpacing: launchConfig.tickSpacing,
    },
    launchConfigId,
    launchEnabled,
    launchFee: launchFee.toString(10),
    launcherWhitelisted: whitelisted,
    maxCreatorTaxBps: maxCreatorTaxBps.toString(10),
    pairToken,
  };
  return {
    deployment: {
      address: PONS_V2_FACTORY,
      protocolVersion: "v2-source-d5491e20",
      runtimeCodeHash: codeHash,
    },
    snapshot,
  };
}

function assertReady(snapshot: JsonObject): void {
  if (snapshot.launchEnabled !== true && snapshot.launcherWhitelisted !== true) {
    throw new NexusError(
      "PROTOCOL_NOT_READY",
      "Pons V2 public launches are disabled and this account is not whitelisted.",
      { recovery: "Wait for public launch enablement or ask Pons to whitelist the exact launch wallet." },
    );
  }
  const config = snapshot.launchConfig;
  if (typeof config !== "object" || config === null || Array.isArray(config) || config.enabled !== true) {
    throw new NexusError("PROTOCOL_NOT_READY", "The selected Pons V2 launch configuration is disabled.");
  }
}

export function ponsV2(): LaunchAdapter<PonsV2LaunchOptions> {
  return {
    id: "pons-v2",
    version: "0.1.0",
    chainId: 4663,
    capabilities: {
      creatorFees: true,
      deterministicTokenAddress: false,
      initialBuy: "unsupported",
      metadataStorage: ["onchain", "https", "ipfs"],
      pricingModel: "bonding-curve",
      taxToken: true,
    },
    async prepare(context: AdapterContext<PonsV2LaunchOptions>): Promise<AdapterPreparation> {
      const launchConfigId = context.launch.launchConfigId ?? 0;
      if (!Number.isSafeInteger(launchConfigId) || launchConfigId < 0) {
        throw new NexusError("INVALID_ARGUMENT", "launchConfigId must be a non-negative safe integer.");
      }
      const pairToken = getAddress(context.launch.pairToken ?? zeroAddress);
      const creatorFeeRecipient = getAddress(context.launch.creatorFeeRecipient ?? context.account);
      const creatorTaxBps = context.launch.creatorTaxBps ?? 0;
      if (!Number.isInteger(creatorTaxBps) || creatorTaxBps < 0 || creatorTaxBps > 10_000) {
        throw new NexusError("INVALID_ARGUMENT", "creatorTaxBps must be an integer between 0 and 10000.");
      }
      if (!isAddress(creatorFeeRecipient)) {
        throw new NexusError("INVALID_ARGUMENT", "creatorFeeRecipient must be an EVM address.");
      }
      requireMaxBytes(context.token.name, 64, "name");
      requireMaxBytes(context.token.symbol, 16, "symbol");
      requireMaxBytes(context.token.image, 512, "image");
      requireMaxBytes(context.token.description, 2_048, "description");
      for (const [name, value] of Object.entries(context.token.socials)) requireMaxBytes(value, 256, `socials.${name}`);

      const state = await readPonsState(
        context.publicClient,
        context.account,
        launchConfigId,
        pairToken,
        context.blockNumber,
      );
      assertReady(state.snapshot);
      const maxCreatorTaxBps = Number(state.snapshot.maxCreatorTaxBps);
      if (creatorTaxBps > maxCreatorTaxBps) {
        throw new NexusError("INVALID_ARGUMENT", `creatorTaxBps exceeds the live Pons ceiling of ${maxCreatorTaxBps}.`);
      }
      const economics = state.snapshot.economics;
      if (typeof economics !== "string") throw new NexusError("RPC_ERROR", "Pons economics digest is malformed.");
      const launch = {
        buybackEnabled: context.launch.buybackEnabled ?? false,
        creatorFeeRecipient,
        creatorTaxBps,
        launchConfigId,
        pairToken,
      } satisfies JsonObject;
      const transactionData = encodeFunctionData({
        abi: ponsV2Abi,
        functionName: "launchToken",
        args: [
          {
            name: context.token.name,
            symbol: context.token.symbol,
            logo: context.token.image,
            description: context.token.description,
            socials: context.token.socials,
            creatorFeeRecipient,
            creatorTaxBps,
            buybackEnabled: context.launch.buybackEnabled ?? false,
            expectedEconomics: economics as Hash,
          },
          BigInt(launchConfigId),
          pairToken,
        ],
      });
      const config = state.snapshot.launchConfig as JsonObject;
      return {
        deployment: state.deployment,
        launch,
        snapshot: state.snapshot,
        transaction: {
          to: PONS_V2_FACTORY,
          data: transactionData,
          value: String(state.snapshot.launchFee),
        },
        expected: {
          pricingModel: "constant-product bonding curve",
          liquidityVenue: "permanently locked full-range Uniswap V4 after graduation",
          economics,
        },
        summary: {
          protocol: "Pons V2",
          pricing: "Constant-product bonding curve; live economics are pinned to this plan.",
          liquidity: "Graduates into a permanently locked, full-range Uniswap V4 position.",
          costs: [{ label: "Launch fee", asset: "ETH", amount: String(state.snapshot.launchFee) }],
          rows: [
            { label: "Factory", value: PONS_V2_FACTORY },
            { label: "Launch config", value: String(launchConfigId) },
            { label: "Supply", value: String(config.supply) },
            { label: "Curve fee (bps)", value: String(config.curveFeeBps) },
            { label: "Creator tax (bps)", value: String(creatorTaxBps) },
            { label: "Economics digest", value: economics },
          ],
        },
        warnings: [
          {
            code: "EXTERNAL_PROTOCOL",
            message: "Nexus has not audited Pons V2. The factory owner controls future launch configurations.",
          },
          {
            code: "NO_ATOMIC_INITIAL_BUY",
            message: "Pons V2 launchToken does not perform an atomic creator buy; this plan launches only.",
          },
        ],
      };
    },
    async revalidate(publicClient: PublicClient, plan: LaunchPlan): Promise<void> {
      const launchConfigId = Number(plan.request.launch.launchConfigId);
      const pairToken = getAddress(String(plan.request.launch.pairToken));
      const state = await readPonsState(publicClient, plan.account, launchConfigId, pairToken);
      assertReady(state.snapshot);
      comparePlanSnapshot(state.snapshot, plan.snapshot, "Pons V2 launch configuration");
      if (canonicalJson(state.deployment) !== canonicalJson(plan.deployment)) {
        throw new NexusError("DEPLOYMENT_CODE_MISMATCH", "Pons V2 deployment changed after plan preparation.");
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
        launchConfigId: bigint;
        pairToken: Address;
        token: Address;
      }> = [];
      for (const log of receipt.logs) {
        if (getAddress(log.address) !== PONS_V2_FACTORY) continue;
        try {
          const decoded = decodeEventLog({ abi: ponsV2Abi, data: log.data, topics: log.topics });
          if (decoded.eventName === "TokenLaunched") launches.push(decoded.args);
        } catch {
          // Other factory events in the receipt are expected and ignored.
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
      if (launched === undefined || getAddress(launched.deployer) !== plan.account) {
        throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Pons launch deployer does not match the plan.", {
          broadcast: true,
        });
      }
      if (
        launched.launchConfigId !== BigInt(String(plan.request.launch.launchConfigId)) ||
        getAddress(launched.pairToken) !== getAddress(String(plan.request.launch.pairToken))
      ) {
        throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Pons launch configuration does not match the plan.", {
          broadcast: true,
        });
      }
      const record = await publicClient.readContract({
        address: PONS_V2_FACTORY,
        abi: ponsV2Abi,
        functionName: "getLaunchedToken",
        args: [launched.token],
        blockNumber: receipt.blockNumber,
      });
      if (
        record.exists !== true ||
        getAddress(record.token) !== getAddress(launched.token) ||
        getAddress(record.curve) !== getAddress(launched.curve) ||
        getAddress(record.deployer) !== plan.account
      ) {
        throw new NexusError("LAUNCH_VERIFICATION_FAILED", "Pons factory launch record is inconsistent.", {
          broadcast: true,
        });
      }
      await runtimeCodeHash(publicClient, launched.token, receipt.blockNumber);
      await runtimeCodeHash(publicClient, launched.curve, receipt.blockNumber);
      return {
        verified: true,
        adapterId: "pons-v2",
        protocol: "Pons V2",
        planId: plan.id,
        chainId: plan.chainId,
        transactionHash: receipt.transactionHash,
        blockHash: receipt.blockHash,
        blockNumber: receipt.blockNumber.toString(10),
        token: getAddress(launched.token),
        market: getAddress(launched.curve),
        receipt,
      };
    },
  };
}
