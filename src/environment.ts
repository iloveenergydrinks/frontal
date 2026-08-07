import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

import { createPublicClient, getAddress, http, isAddress, type Address, type Chain, type PublicClient } from "viem";

import { bnbSmartChain, robinhoodChain } from "./chains.js";
import { NexusError } from "./errors.js";
import { flapStandard } from "./flap.js";
import { parseLaunchPlan } from "./launch.js";
import { pons } from "./pons.js";
import { ponsV2 } from "./pons-v2.js";
import { stringifyJson } from "./serialization.js";
import type { LaunchAdapter, LaunchPlan } from "./types.js";

/**
 * Shared host plumbing for the executables. The SDK itself takes caller-supplied
 * clients; only the CLI and MCP server resolve chains and files from the process
 * environment.
 */

export function requireAddress(value: string, field: string): Address {
  if (!isAddress(value)) throw new NexusError("INVALID_ARGUMENT", `${field} must be an EVM address.`);
  return getAddress(value);
}

export function chainFor(chainId: number): Chain {
  if (chainId === bnbSmartChain.id) return bnbSmartChain;
  if (chainId === robinhoodChain.id) return robinhoodChain;
  throw new NexusError("UNSUPPORTED_CHAIN", `Nexus does not support chain ${chainId}.`);
}

export function rpcUrlFor(chainId: number): string {
  if (chainId === bnbSmartChain.id) {
    return process.env.NEXUS_BNB_RPC_URL ?? bnbSmartChain.rpcUrls.default.http[0];
  }
  if (chainId === robinhoodChain.id) {
    return process.env.NEXUS_RH_RPC_URL ?? robinhoodChain.rpcUrls.default.http[0];
  }
  throw new NexusError("UNSUPPORTED_CHAIN", `Nexus does not support chain ${chainId}.`);
}

export function publicClientFor(chainId: number): PublicClient {
  const chain = chainFor(chainId);
  return createPublicClient({ chain, transport: http(rpcUrlFor(chainId)) }) as PublicClient;
}

export function adapterFor(id: string): LaunchAdapter<unknown> {
  if (id === "flap-standard") return flapStandard() as LaunchAdapter<unknown>;
  if (id === "pons") return pons() as LaunchAdapter<unknown>;
  if (id === "pons-v2") return ponsV2() as LaunchAdapter<unknown>;
  throw new NexusError("UNSUPPORTED_ADAPTER", `Unknown adapter ${id}.`);
}

export async function readPlan(path: string): Promise<LaunchPlan> {
  const contents = await readFile(path, "utf8").catch((cause: unknown) => {
    throw new NexusError("INVALID_PLAN", `Unable to read plan ${path}.`, { cause });
  });
  return parseLaunchPlan(contents);
}

export async function writePlan(path: string, plan: LaunchPlan, force: boolean): Promise<void> {
  await writeFile(path, `${stringifyJson(plan)}\n`, {
    encoding: "utf8",
    flag: force ? "w" : "wx",
    mode: 0o600,
  }).catch((cause: unknown) => {
    throw new NexusError(
      "INVALID_ARGUMENT",
      `Unable to write ${path}${force ? "." : "; use force to replace an existing file."}`,
      { cause },
    );
  });
}
