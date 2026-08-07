#!/usr/bin/env node

import process from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Hash } from "viem";

import {
  adapterFor,
  pumpFunConnection,
  publicClientFor,
  readAnyPlan,
  requireAddress,
  writeAnyPlan,
} from "./environment.js";
import { NexusError, toNexusError } from "./errors.js";
import { uploadFlapMetadata } from "./flap-metadata.js";
import { flapStandard } from "./flap.js";
import { prepareLaunch, simulateLaunch, verifyLaunch } from "./launch.js";
import { encodePlanUrl } from "./plan-url.js";
import { pons } from "./pons.js";
import { ponsV2 } from "./pons-v2.js";
import {
  pumpFun,
  simulatePumpFunLaunch,
  verifyPumpFunLaunch,
  type PumpFunLaunchPlan,
} from "./pump-fun.js";
import { canonicalJson } from "./serialization.js";
import type { LaunchPlan, SocialLinks, TokenMetadata } from "./types.js";

/**
 * Nexus over the Model Context Protocol.
 *
 * Every tool here is signer-free: preparation, simulation, and verification read
 * chain state and write plan files, and none of them can broadcast. Execution
 * stays a human action in a wallet Nexus does not control, so the model can
 * describe the exact command to run but can never run it. That boundary is the
 * product, not an implementation detail — do not add a tool that sends a
 * transaction.
 */

const SERVER_NAME = "nexus-launch";
const SERVER_VERSION = "0.4.0";

/** Where an operator hosts the signing page. Override with NEXUS_SIGNING_URL. */
const DEFAULT_SIGNING_URL = "https://cli.nexus/";

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ text: string; type: "text" }>;
  isError?: boolean;
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: canonicalJson(data as never) }] };
}

function fail(error: unknown): ToolResult {
  return {
    content: [{ type: "text", text: canonicalJson(toNexusError(error).toJSON() as never) }],
    isError: true,
  };
}

const tokenShape = {
  description: z.string().optional().describe("Plain-language description. No promised utility."),
  discord: z.string().optional(),
  farcaster: z.string().optional(),
  image: z.string().optional().describe("Profile URI. Pons stores it onchain; Flap uses the uploaded CID."),
  name: z.string().describe("Token name."),
  symbol: z.string().describe("Token symbol."),
  telegram: z.string().optional(),
  twitter: z.string().optional(),
  website: z.string().optional(),
};

type TokenInput = {
  description?: string | undefined;
  discord?: string | undefined;
  farcaster?: string | undefined;
  image?: string | undefined;
  name: string;
  symbol: string;
  telegram?: string | undefined;
  twitter?: string | undefined;
  website?: string | undefined;
};

function metadataFrom(input: TokenInput): TokenMetadata {
  const socials: SocialLinks = {
    ...(input.discord === undefined ? {} : { discord: input.discord }),
    ...(input.farcaster === undefined ? {} : { farcaster: input.farcaster }),
    ...(input.telegram === undefined ? {} : { telegram: input.telegram }),
    ...(input.twitter === undefined ? {} : { twitter: input.twitter }),
    ...(input.website === undefined ? {} : { website: input.website }),
  };
  return {
    name: input.name,
    symbol: input.symbol,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.image === undefined ? {} : { image: input.image }),
    ...(Object.keys(socials).length === 0 ? {} : { socials }),
  };
}

/** The review surface a human needs before approving a plan ID. */
function isPumpPlan(plan: LaunchPlan | PumpFunLaunchPlan): plan is PumpFunLaunchPlan {
  return plan.adapter.id === "pump-fun";
}

function planDigest(plan: LaunchPlan | PumpFunLaunchPlan): Record<string, unknown> {
  if (isPumpPlan(plan)) {
    return {
      planId: plan.id,
      adapter: plan.adapter.id,
      chainFamily: plan.chainFamily,
      cluster: plan.cluster,
      payer: plan.payer,
      creator: plan.creator,
      deployment: plan.deployment,
      expected: plan.expected,
      preparedAt: plan.preparedAt,
      summary: plan.summary,
      warnings: plan.warnings,
    };
  }
  return {
    planId: plan.id,
    adapter: plan.adapter.id,
    chainId: plan.chainId,
    account: plan.account,
    deployment: plan.deployment,
    expected: plan.expected,
    preparedAt: plan.preparedAt,
    summary: plan.summary,
    transaction: plan.transaction,
    warnings: plan.warnings,
  };
}

async function executionInstructions(
  plan: LaunchPlan | PumpFunLaunchPlan,
  planPath: string,
): Promise<Record<string, unknown>> {
  if (isPumpPlan(plan)) {
    return {
      approvalRequired: true,
      planId: plan.id,
      note:
        "Pump execution is an application action: call sendPumpFunLaunch with this exact plan, a Solana wallet, and the matching ephemeral mint signer kept only in memory. The hosted EVM signing page is incompatible.",
      afterBroadcast: `nexus launch verify --plan ${planPath} --tx <solana-signature>`,
    };
  }
  const instructions: Record<string, unknown> = {
    approvalRequired: true,
    planId: plan.id,
    note: "Nexus cannot broadcast. A human approves this exact plan ID and signs in their own wallet.",
    desktopBrowserWallet: `nexus launch serve --plan ${planPath} --approve ${plan.id}`,
    mobileOrQrWallet: `nexus launch execute --plan ${planPath} --approve ${plan.id}`,
    afterBroadcast: `nexus launch verify --plan ${planPath} --tx <transaction-hash>`,
  };
  // A hosted signing page is the only handoff that works when the human has no
  // local checkout, so offer the link when an operator has configured one. The
  // plan travels in the URL fragment and never reaches that page's server.
  const signingPage = process.env.NEXUS_SIGNING_URL ?? DEFAULT_SIGNING_URL;
  if (signingPage.trim() !== "") {
    try {
      instructions.signingUrl = await encodePlanUrl(plan, signingPage.trim());
      instructions.signingUrlNote =
        "Tell the human to confirm the page shows plan ID " +
        plan.id +
        " before approving. A different ID means the link was altered.";
    } catch (error) {
      instructions.signingUrlError = toNexusError(error).message;
    }
  }
  return instructions;
}

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

server.registerTool(
  "list_adapters",
  {
    title: "List launch adapters",
    description:
      "List supported launch protocols with their chain and capabilities. Read this before collecting token details so you only ask for controls the selected protocol actually supports.",
    inputSchema: {},
  },
  () => {
    try {
      return ok(
        [
          ...[flapStandard(), pons(), ponsV2()].map((adapter) => ({
            id: adapter.id,
            version: adapter.version,
            chainFamily: "evm",
            chainId: adapter.chainId,
            capabilities: adapter.capabilities,
          })),
          {
            id: pumpFun().id,
            version: pumpFun().version,
            chainFamily: pumpFun().chainFamily,
            cluster: pumpFun().cluster,
            capabilities: pumpFun().capabilities,
          },
        ],
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "prepare_launch",
  {
    title: "Prepare a launch plan",
    description:
      "Build a content-addressed launch plan from live protocol state and save it to disk. Signer-free and cannot broadcast. Returns a plan ID that is the unit of human approval: any change to the token, protocol configuration, or deployment produces a different ID.",
    inputSchema: {
      ...tokenShape,
      account: z.string().describe("Exact launch wallet. Nexus never holds its key."),
      adapter: z.enum(["flap-standard", "pons", "pons-v2", "pump-fun"]),
      buybackEnabled: z.boolean().optional().describe("Enable Pons V2 creator buybacks."),
      creatorFeeRecipient: z.string().optional().describe("Pons V2 creator fee recipient."),
      creatorTaxBps: z.number().int().min(0).max(10_000).optional().describe("Pons V2 creator tax in basis points."),
      dexId: z.number().int().nonnegative().optional().describe("Pons V1 DEX configuration. Default 0."),
      feeWallet: z.string().optional().describe("Pons V1 creator fee recipient."),
      creator: z.string().optional().describe("Pump creator public key. Defaults to the payer."),
      mint: z.string().optional().describe("Pump ephemeral mint public key. Never provide its secret."),
      metadataUri: z.string().optional().describe("Pump metadata JSON URI. HTTPS, IPFS, or Arweave."),
      mayhemMode: z.boolean().optional().describe("Enable Pump mayhem mode."),
      cashback: z.boolean().optional().describe("Enable Pump cashback mode."),
      force: z.boolean().optional().describe("Replace an existing plan file."),
      initialBuy: z
        .string()
        .optional()
        .describe("Reserved for future guarded launch-and-buy support. Every current adapter rejects nonzero."),
      launchConfigId: z.number().int().nonnegative().optional().describe("Pons launch configuration. Default 0."),
      metadataCid: z.string().optional().describe("Bare IPFS CID. Required for flap-standard."),
      out: z.string().describe("Path to write the plan file. Written with mode 0600."),
      saltSeed: z.string().optional().describe("Deterministic salt-search seed."),
    },
  },
  async (input) => {
    try {
      if (input.adapter === "pump-fun") {
        if (input.mint === undefined || input.metadataUri === undefined) {
          throw new NexusError("INVALID_ARGUMENT", "pump-fun requires mint and metadataUri.");
        }
        const plan = await pumpFun().prepare({
          connection: pumpFunConnection(),
          payer: input.account,
          creator: input.creator ?? input.account,
          token: metadataFrom(input),
          launch: {
            mint: input.mint,
            metadataUri: input.metadataUri,
            mayhemMode: input.mayhemMode ?? false,
            cashback: input.cashback ?? false,
            ...(input.initialBuy === undefined ? {} : { initialBuy: input.initialBuy }),
          },
        });
        await writeAnyPlan(input.out, plan, input.force ?? false);
        return ok({
          ...planDigest(plan),
          planPath: input.out,
          nextStep: "Call simulate_launch, review the exact plan ID, then execute in an application holding the matching mint signer only in memory.",
        });
      }
      const account = requireAddress(input.account, "account");
      const adapter = adapterFor(input.adapter);
      const launch = input.adapter === "flap-standard"
        ? {
              metadataCid: input.metadataCid ?? "",
              ...(input.initialBuy === undefined ? {} : { initialBuy: input.initialBuy }),
              ...(input.saltSeed === undefined ? {} : { saltSeed: input.saltSeed }),
            }
        : input.adapter === "pons"
          ? {
              dexId: input.dexId ?? 0,
              launchConfigId: input.launchConfigId ?? 0,
              ...(input.feeWallet === undefined
                ? {}
                : { feeWallet: requireAddress(input.feeWallet, "feeWallet") }),
              ...(input.initialBuy === undefined ? {} : { initialBuy: input.initialBuy }),
              ...(input.saltSeed === undefined ? {} : { saltSeed: input.saltSeed }),
            }
          : {
              buybackEnabled: input.buybackEnabled ?? false,
              creatorTaxBps: input.creatorTaxBps ?? 0,
              launchConfigId: input.launchConfigId ?? 0,
              ...(input.creatorFeeRecipient === undefined
                ? {}
                : { creatorFeeRecipient: requireAddress(input.creatorFeeRecipient, "creatorFeeRecipient") }),
              ...(input.initialBuy === undefined ? {} : { initialBuy: input.initialBuy }),
              ...(input.saltSeed === undefined ? {} : { saltSeed: input.saltSeed }),
            };
      const plan = await prepareLaunch({
        account,
        adapter,
        launch,
        publicClient: publicClientFor(adapter.chainId),
        token: metadataFrom(input),
      });
      await writeAnyPlan(input.out, plan, input.force ?? false);
      return ok({
        ...planDigest(plan),
        planPath: input.out,
        nextStep: "Call simulate_launch on this plan, then show the summary and warnings to the human for approval.",
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "simulate_launch",
  {
    title: "Simulate a saved plan",
    description:
      "Rebuild the saved plan from current chain state, compare every committed field, simulate the exact transaction, and report funding. Read-only. A plan that no longer matches live state fails here rather than at send.",
    inputSchema: { plan: z.string().describe("Path to a saved plan file.") },
  },
  async (input) => {
    try {
      const plan = await readAnyPlan(input.plan);
      if (isPumpPlan(plan)) {
        const simulation = await simulatePumpFunLaunch(pumpFunConnection(), plan);
        return ok({
          simulation,
          planId: plan.id,
          summary: plan.summary,
          warnings: plan.warnings,
          execution: await executionInstructions(plan, input.plan),
        });
      }
      const adapter = adapterFor(plan.adapter.id);
      const simulation = await simulateLaunch({
        adapter,
        plan,
        publicClient: publicClientFor(plan.chainId),
      });
      return ok({
        simulation,
        planId: plan.id,
        summary: plan.summary,
        warnings: plan.warnings,
        execution: await executionInstructions(plan, input.plan),
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "get_execution_instructions",
  {
    title: "Get the execution command for a human",
    description:
      "Return the exact command a human runs to approve and broadcast a plan. Nexus has no tool that broadcasts: the human passes the plan ID as explicit approval and signs in their own wallet. Never claim a launch happened based on this tool.",
    inputSchema: { plan: z.string().describe("Path to a saved plan file.") },
  },
  async (input) => {
    try {
      const plan = await readAnyPlan(input.plan);
      return ok(await executionInstructions(plan, input.plan));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "verify_launch",
  {
    title: "Verify a broadcast launch",
    description:
      "Verify a mined transaction against an exact saved plan: sender, target, calldata, value, the protocol's canonical event, the factory record, and the resulting token. Use this to confirm an outcome instead of assuming one.",
    inputSchema: {
      plan: z.string().describe("Path to the saved plan file that was approved."),
      tx: z.string().describe("Transaction hash."),
    },
  },
  async (input) => {
    try {
      const plan = await readAnyPlan(input.plan);
      if (isPumpPlan(plan)) {
        return ok(await verifyPumpFunLaunch(pumpFunConnection(), plan, input.tx));
      }
      const adapter = adapterFor(plan.adapter.id);
      const result = await verifyLaunch({
        adapter,
        hash: input.tx as Hash,
        plan,
        publicClient: publicClientFor(plan.chainId),
      });
      const { receipt: _receipt, ...summary } = result;
      return ok(summary);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "upload_flap_metadata",
  {
    title: "Upload Flap profile metadata",
    description:
      "Upload a 512x512 PNG and token metadata through Flap's official IPFS service and read it back. Required before a flap-standard launch. This publishes the image publicly and is irreversible, so confirm with the human before calling it. It does not create a token or open a wallet.",
    inputSchema: {
      creator: z.string().describe("Creator wallet address."),
      description: z.string().optional(),
      image: z.string().describe("Local path to a 512x512 PNG, at most 10 MiB."),
      telegram: z.string().optional(),
      twitter: z.string().optional(),
      website: z.string().optional(),
    },
  },
  async (input) => {
    try {
      const result = await uploadFlapMetadata({
        creator: requireAddress(input.creator, "creator"),
        imagePath: input.image,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.telegram === undefined ? {} : { telegram: input.telegram }),
        ...(input.twitter === undefined ? {} : { twitter: input.twitter }),
        ...(input.website === undefined ? {} : { website: input.website }),
      });
      return ok(result);
    } catch (error) {
      return fail(error);
    }
  },
);

export async function startNexusMcpServer(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

await startNexusMcpServer().catch((error: unknown) => {
  process.stderr.write(`${toNexusError(error).message}\n`);
  process.exitCode = 1;
});
