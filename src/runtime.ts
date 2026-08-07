import {
  getAddress,
  keccak256,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";

import { NexusError } from "./errors.js";

export const ERC1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

export async function runtimeCodeHash(
  publicClient: PublicClient,
  address: Address,
  blockNumber?: bigint,
): Promise<Hash> {
  const code = await publicClient.getCode({ address, blockNumber });
  if (code === undefined || code === "0x") {
    throw new NexusError("DEPLOYMENT_CODE_MISMATCH", `No runtime code exists at ${address}.`);
  }
  return keccak256(code);
}

export async function erc1967Implementation(
  publicClient: PublicClient,
  proxy: Address,
  blockNumber?: bigint,
): Promise<Address> {
  const value = await publicClient.getStorageAt({ address: proxy, blockNumber, slot: ERC1967_IMPLEMENTATION_SLOT });
  if (value === undefined || value === "0x" || /^0x0+$/u.test(value)) {
    throw new NexusError("DEPLOYMENT_CODE_MISMATCH", `${proxy} has no ERC-1967 implementation.`);
  }
  return getAddress(`0x${value.slice(-40)}` as Hex);
}

export function requireEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new NexusError("DEPLOYMENT_CODE_MISMATCH", message);
}

/** True when a provider rejected a historical read because it does not retain that state. */
export function historicalStateUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
  return /missing trie|historical state|not supported|pruned|state is not available/iu.test(message);
}
