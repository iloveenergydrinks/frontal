import type {
  Address,
  Hash,
  Hex,
  PublicClient,
  TransactionReceipt,
  WalletClient,
} from "viem";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type AdapterId = "flap-standard" | "pons";

export interface SocialLinks {
  discord?: string;
  farcaster?: string;
  telegram?: string;
  twitter?: string;
  website?: string;
}

export interface TokenMetadata {
  description?: string;
  image?: string;
  name: string;
  socials?: SocialLinks;
  symbol: string;
}

export interface NormalizedTokenMetadata {
  description: string;
  image: string;
  name: string;
  socials: Required<SocialLinks>;
  symbol: string;
}

export interface LaunchCapabilities {
  creatorFees: boolean;
  deterministicTokenAddress: boolean;
  initialBuy: "optional" | "required" | "unsupported";
  metadataStorage: readonly ("https" | "ipfs" | "onchain")[];
  pricingModel: "bonding-curve" | "fixed-liquidity";
  taxToken: boolean;
}

export interface DeploymentSnapshot {
  address: Address;
  implementation?: {
    address: Address;
    runtimeCodeHash: Hash;
  };
  protocolVersion: string;
  runtimeCodeHash: Hash;
}

export interface LaunchTransaction {
  data: Hex;
  to: Address;
  value: string;
}

export interface LaunchWarning {
  code: string;
  message: string;
}

export interface LaunchSummary {
  costs: Array<{ amount: string; asset: string; label: string }>;
  liquidity: string;
  pricing: string;
  protocol: string;
  rows: Array<{ label: string; value: string }>;
}

export interface LaunchPlan {
  account: Address;
  adapter: {
    id: AdapterId;
    version: string;
  };
  chainId: number;
  deployment: DeploymentSnapshot;
  expected: JsonObject;
  id: Hash;
  preparedAt: {
    blockHash: Hash;
    blockNumber: string;
  };
  request: {
    launch: JsonObject;
    token: NormalizedTokenMetadata;
  };
  schemaVersion: "1";
  snapshot: JsonObject;
  summary: LaunchSummary;
  transaction: LaunchTransaction;
  warnings: LaunchWarning[];
}

export interface FundingRequirement {
  account: Address;
  asset: string;
  balance: string;
  estimatedGas: string;
  estimatedGasCost: string;
  gasBuffer: string;
  required: string;
  shortfall: string;
  transactionValue: string;
}

export interface LaunchSimulation {
  blockNumber: string;
  funding: FundingRequirement;
  gasEstimate: string;
  passed: true;
  planId: Hash;
  returnData?: JsonValue;
}

export interface LaunchResult {
  adapterId: AdapterId;
  blockHash: Hash;
  blockNumber: string;
  chainId: number;
  market?: Address;
  planId: Hash;
  protocol: string;
  receipt: TransactionReceipt;
  token: Address;
  transactionHash: Hash;
  verified: true;
  stateVerification?: {
    blockHash: Hash;
    blockNumber: string;
    mode: "current-fallback" | "receipt-block";
  };
}

export interface AdapterPreparation {
  deployment: DeploymentSnapshot;
  expected: JsonObject;
  launch: JsonObject;
  snapshot: JsonObject;
  summary: LaunchSummary;
  transaction: LaunchTransaction;
  warnings: LaunchWarning[];
}

export interface AdapterContext<TLaunch> {
  account: Address;
  blockHash: Hash;
  blockNumber: bigint;
  launch: TLaunch;
  publicClient: PublicClient;
  token: NormalizedTokenMetadata;
}

export interface LaunchAdapter<TLaunch> {
  readonly capabilities: LaunchCapabilities;
  readonly chainId: number;
  readonly id: AdapterId;
  readonly version: string;
  prepare(context: AdapterContext<TLaunch>): Promise<AdapterPreparation>;
  revalidate(publicClient: PublicClient, plan: LaunchPlan): Promise<void>;
  verify(publicClient: PublicClient, plan: LaunchPlan, receipt: TransactionReceipt): Promise<LaunchResult>;
}

export interface PrepareLaunchParameters<TLaunch> {
  account: Address;
  adapter: LaunchAdapter<TLaunch>;
  launch: TLaunch;
  publicClient: PublicClient;
  token: TokenMetadata;
}

export interface SimulateLaunchParameters<TLaunch> {
  adapter: LaunchAdapter<TLaunch>;
  gasBufferBps?: number;
  plan: LaunchPlan;
  publicClient: PublicClient;
}

export interface SendLaunchParameters<TLaunch> extends SimulateLaunchParameters<TLaunch> {
  walletClient: WalletClient;
}

export interface VerifyLaunchParameters<TLaunch> {
  adapter: LaunchAdapter<TLaunch>;
  confirmations?: number;
  hash: Hash;
  plan: LaunchPlan;
  publicClient: PublicClient;
}
