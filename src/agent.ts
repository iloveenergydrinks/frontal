import { createInterface } from "node:readline/promises";
import process from "node:process";

import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

import { adapterFor, publicClientFor, readPlan, requireAddress, writePlan } from "./environment.js";
import { toNexusError } from "./errors.js";
import { uploadFlapMetadata } from "./flap-metadata.js";
import { flapStandard } from "./flap.js";
import { prepareLaunch, simulateLaunch, verifyLaunch } from "./launch.js";
import { encodePlanUrl } from "./plan-url.js";
import { pons } from "./pons.js";
import { ponsV2 } from "./pons-v2.js";
import { canonicalJson } from "./serialization.js";
import type { LaunchPlan, SocialLinks, TokenMetadata } from "./types.js";
import type { Hash } from "viem";

/**
 * The conversational agent.
 *
 * Every tool here is signer-free. There is no tool that broadcasts, and adding
 * one would collapse the design: the model may prepare, simulate, and explain a
 * launch, but a human approves one exact plan ID and signs it in a wallet Nexus
 * never holds a key for. Putting a model on the other side of that line is the
 * failure this whole product is built to prevent.
 */

const MODEL = "claude-opus-5";
const FALLBACK_MODEL = "claude-opus-4-8";
const SIGNING_URL = process.env.NEXUS_SIGNING_URL ?? "https://cli.nexus/";
/** Where to relay model traffic when the user has no Anthropic credential. */
const RELAY_URL = process.env.NEXUS_RELAY_URL ?? "https://cli.nexus";

const SYSTEM = `You are Nexus, a terminal agent that walks someone through launching a token on an EVM chain.

You prepare, simulate, and explain launches. You cannot launch one, and neither can Nexus: broadcasting requires a human approving one exact plan ID and signing in their own wallet. You have no tool that sends a transaction, by design. Do not look for one, and never imply you performed a launch.

## The rule everything rests on

A plan ID is an approval token. \`prepare_launch\` hashes the exact factory, calldata, value, predicted token address, economics, and warnings into one content-addressed ID. Change anything and the ID changes, which invalidates any approval of the old one. Approval is bound to exact content, never to intent.

"Launch me a coin called X" is a request to prepare a plan, not to broadcast one.

## Workflow

1. Call list_adapters first. The protocols differ in ways that change what you should even ask for. Flap is a bonding curve on BNB that migrates to PancakeSwap. Pons V1 is fixed supply on Robinhood Chain and seeds a locked Uniswap V3 pool immediately. Pons V2 starts on a bonding curve and graduates into permanently locked Uniswap V4 liquidity. Nexus does not offer an initial buy on any adapter until it can bind a nonzero minimum output. Do not offer a control the chosen adapter does not have.
2. Ask the human for the name, symbol, description, image, and links. Never invent them, and never search their filesystem for an image — use only a path they gave you.
3. flap-standard needs an IPFS metadata CID, so upload_flap_metadata must run first with a 512x512 PNG. That publishes the image publicly and cannot be undone: confirm before calling it. Both Pons adapters store the profile URI onchain and need no upload.
4. prepare_launch, then simulate_launch. Simulation rebuilds the plan from live chain state and compares every field, so a plan that no longer matches reality fails there rather than at signing. Always simulate before presenting anything for approval.
5. Present the plan: the plan ID, chain, account, protocol and its address, the token name and symbol, the predicted token address, the transaction value, the funding line including any shortfall, and every warning in full. Never summarise away a warning about an unprotected buy, a permanent lock, or an upgradeable protocol.
6. Give them the signing link from get_signing_link, tell them the plan ID the page must display, and stop. A page showing a different ID means the link was altered and they should not sign.
7. When they give you a transaction hash, call verify_launch and report what it returns. Do not describe a launch as successful before that passes.

## Funding

If the wallet cannot cover value plus gas, simulation reports an exact shortfall. Report it and stop. Do not offer to fund the wallet, bridge assets, move funds between accounts, or suggest a different wallet — they fund the exact planned address externally, then you re-simulate the unchanged plan.

## Failures

Errors carry stable codes. PROTOCOL_NOT_READY means the protocol itself is gating launches and you cannot retry around it. PLAN_CHANGED, PROTOCOL_CONFIG_CHANGED, and DEPLOYMENT_CODE_MISMATCH mean live state moved: prepare a fresh plan and get fresh approval, never reusing the old plan ID. If any error carries broadcast: true, stop. A transaction may already be onchain. Give them the hash if you have one and tell them to reconcile it and the sender's nonce before anything else. Never retry — a retry can create a second token.

## Never

Never put a private key, seed phrase, or RPC credential into a command, a file, or your own output. Never edit a plan file by hand; prepare a new one. Never present Nexus, Flap, or Pons as audited, because none of them are. Never describe a launch as an investment or predict what a token will be worth. Launches are permanent and can lose all value.

Write in plain sentences. Lead with what matters. Explain the trade-offs a launch actually carries rather than cheerleading it.`;

/**
 * The Robinhood Chain agent mascot from cli.nexus — the lime star.
 *
 * Stored as the site's own pixel grid rather than pre-rendered escape codes, so
 * the terminal can drop to monochrome when colour is unwelcome. Index 0 is
 * transparent; the rest index PALETTE.
 */
const PALETTE = ["#ccff00", "#96c000", "#233300", "#0d0d0d", "#f6f6f2"] as const;

const MASCOT_ROWS = [
  "00000000033000000000",
  "00000000311300000000",
  "00030000311300003000",
  "00313303111130331300",
  "00031131111113113000",
  "00031111111111113000",
  "00003111111111130000",
  "00031541111154113000",
  "03311441111144111330",
  "31111441111144111123",
  "32211111111111112223",
  "03321111441111122330",
  "00032111111111223000",
  "00003111111111130000",
  "00031221111122123000",
  "00032232111223223000",
  "00323303212230332300",
  "00030000312300003000",
  "00000000322300000000",
  "00000000033000000000",
];

function ansi(hex: string, background: boolean): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\u001B[${background ? 48 : 38};2;${r};${g};${b}m`;
}

function mascot(coloured: boolean): string {
  const at = (row: number, column: number): string | undefined => {
    const index = MASCOT_ROWS[row]?.charCodeAt(column);
    if (index === undefined || index === 48) return undefined; // "0" is transparent
    const colour = PALETTE[index - 49];
    // Without colour the eyes and mouth would fill in solid like the body and
    // the face would disappear, so punch them out as gaps instead.
    if (!coloured && colour === "#0d0d0d") return undefined;
    return colour;
  };
  const lines: string[] = [];
  for (let row = 0; row < MASCOT_ROWS.length; row += 2) {
    let line = "";
    for (let column = 0; column < (MASCOT_ROWS[0]?.length ?? 0); column += 1) {
      const top = at(row, column);
      const bottom = at(row + 1, column);
      if (!coloured) {
        line += top && bottom ? "\u2588" : top ? "\u2580" : bottom ? "\u2584" : " ";
        continue;
      }
      if (top !== undefined && bottom !== undefined) {
        line += `${ansi(top, false)}${ansi(bottom, true)}\u2580\u001B[0m`;
      } else if (top !== undefined) {
        line += `${ansi(top, false)}\u2580\u001B[0m`;
      } else if (bottom !== undefined) {
        line += `${ansi(bottom, false)}\u2584\u001B[0m`;
      } else {
        line += " ";
      }
    }
    lines.push(line.replace(/\s+$/u, ""));
  }
  return lines.join("\n");
}

interface TokenInput {
  description?: string | undefined;
  discord?: string | undefined;
  farcaster?: string | undefined;
  image?: string | undefined;
  name: string;
  symbol: string;
  telegram?: string | undefined;
  twitter?: string | undefined;
  website?: string | undefined;
}

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

function digest(plan: LaunchPlan): Record<string, unknown> {
  return {
    planId: plan.id,
    adapter: plan.adapter.id,
    chainId: plan.chainId,
    account: plan.account,
    deployment: plan.deployment,
    expected: plan.expected,
    summary: plan.summary,
    transaction: plan.transaction,
    warnings: plan.warnings,
  };
}

function report(value: unknown): string {
  return canonicalJson(value as never);
}

function failed(error: unknown): string {
  return canonicalJson(toNexusError(error).toJSON() as never);
}

const tokenShape = {
  description: z.string().optional(),
  discord: z.string().optional(),
  farcaster: z.string().optional(),
  image: z.string().optional().describe("Profile URI. Pons stores it onchain; Flap uses the uploaded CID."),
  name: z.string(),
  symbol: z.string(),
  telegram: z.string().optional(),
  twitter: z.string().optional(),
  website: z.string().optional(),
};

const listAdapters = betaZodTool({
  name: "list_adapters",
  description:
    "List supported launch protocols with their chain and capabilities. Call this before collecting token details so you only ask for controls the chosen protocol supports.",
  inputSchema: z.object({}),
  run: () => {
    try {
      return report(
        [flapStandard(), pons(), ponsV2()].map((adapter) => ({
          id: adapter.id,
          chainId: adapter.chainId,
          capabilities: adapter.capabilities,
        })),
      );
    } catch (error) {
      return failed(error);
    }
  },
});

const prepareLaunchTool = betaZodTool({
  name: "prepare_launch",
  description:
    "Build a content-addressed launch plan from live protocol state and save it. Signer-free and cannot broadcast. Returns the plan ID that is the unit of human approval.",
  inputSchema: z.object({
    ...tokenShape,
    account: z.string().describe("Exact launch wallet. Nexus never holds its key."),
    adapter: z.enum(["flap-standard", "pons", "pons-v2"]),
    buybackEnabled: z.boolean().optional().describe("Enable Pons V2 creator buybacks."),
    creatorFeeRecipient: z.string().optional().describe("Pons V2 creator fee recipient."),
    creatorTaxBps: z.number().int().min(0).max(10_000).optional().describe("Pons V2 creator tax in basis points."),
    feeWallet: z.string().optional().describe("Pons V1 creator fee recipient."),
    initialBuy: z
      .string()
      .optional()
      .describe("Reserved for future guarded launch-and-buy support. Every current adapter rejects nonzero."),
    metadataCid: z.string().optional().describe("Bare IPFS CID. Required for flap-standard."),
    out: z.string().describe("Path to write the plan file."),
  }),
  run: async (input) => {
    try {
      const account = requireAddress(input.account, "account");
      const adapter = adapterFor(input.adapter);
      const launch = input.adapter === "flap-standard"
        ? { metadataCid: input.metadataCid ?? "" }
        : input.adapter === "pons"
          ? {
              dexId: 0,
              launchConfigId: 0,
              ...(input.feeWallet === undefined
                ? {}
                : { feeWallet: requireAddress(input.feeWallet, "feeWallet") }),
              ...(input.initialBuy === undefined ? {} : { initialBuy: input.initialBuy }),
            }
          : {
              buybackEnabled: input.buybackEnabled ?? false,
              creatorTaxBps: input.creatorTaxBps ?? 0,
              launchConfigId: 0,
              ...(input.creatorFeeRecipient === undefined
                ? {}
                : { creatorFeeRecipient: requireAddress(input.creatorFeeRecipient, "creatorFeeRecipient") }),
              ...(input.initialBuy === undefined ? {} : { initialBuy: input.initialBuy }),
            };
      const plan = await prepareLaunch({
        account,
        adapter,
        launch,
        publicClient: publicClientFor(adapter.chainId),
        token: metadataFrom(input),
      });
      await writePlan(input.out, plan, true);
      return report({ ...digest(plan), planPath: input.out });
    } catch (error) {
      return failed(error);
    }
  },
});

const simulateLaunchTool = betaZodTool({
  name: "simulate_launch",
  description:
    "Rebuild the saved plan from current chain state, compare every committed field, simulate the exact transaction, and report funding. Read-only.",
  inputSchema: z.object({ plan: z.string().describe("Path to a saved plan file.") }),
  run: async (input) => {
    try {
      const plan = await readPlan(input.plan);
      const simulation = await simulateLaunch({
        adapter: adapterFor(plan.adapter.id),
        plan,
        publicClient: publicClientFor(plan.chainId),
      });
      return report({ simulation, planId: plan.id, summary: plan.summary, warnings: plan.warnings });
    } catch (error) {
      return failed(error);
    }
  },
});

const signingLink = betaZodTool({
  name: "get_signing_link",
  description:
    "Return the link a human opens to review and sign one exact plan. Nexus cannot broadcast; the human approves the plan ID and signs in their own wallet. Never claim a launch happened from this.",
  inputSchema: z.object({ plan: z.string().describe("Path to a saved plan file.") }),
  run: async (input) => {
    try {
      const plan = await readPlan(input.plan);
      return report({
        url: await encodePlanUrl(plan, SIGNING_URL),
        planId: plan.id,
        note: `The page must display plan ID ${plan.id}. A different ID means the link was altered.`,
      });
    } catch (error) {
      return failed(error);
    }
  },
});

const verifyLaunchTool = betaZodTool({
  name: "verify_launch",
  description:
    "Verify a mined transaction against an exact saved plan: sender, target, calldata, value, the protocol's canonical event, the factory record, and the resulting token.",
  inputSchema: z.object({
    plan: z.string().describe("Path to the approved plan file."),
    tx: z.string().describe("Transaction hash."),
  }),
  run: async (input) => {
    try {
      const plan = await readPlan(input.plan);
      const result = await verifyLaunch({
        adapter: adapterFor(plan.adapter.id),
        hash: input.tx as Hash,
        plan,
        publicClient: publicClientFor(plan.chainId),
      });
      const { receipt: _receipt, ...rest } = result;
      return report(rest);
    } catch (error) {
      return failed(error);
    }
  },
});

const uploadMetadata = betaZodTool({
  name: "upload_flap_metadata",
  description:
    "Upload a 512x512 PNG and token metadata through Flap's official IPFS service. Required before a flap-standard launch. This publishes the image publicly and cannot be undone, so confirm with the human first.",
  inputSchema: z.object({
    creator: z.string(),
    description: z.string().optional(),
    image: z.string().describe("Local path to a 512x512 PNG, at most 10 MiB."),
    website: z.string().optional(),
  }),
  run: async (input) => {
    try {
      return report(
        await uploadFlapMetadata({
          creator: requireAddress(input.creator, "creator"),
          imagePath: input.image,
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.website === undefined ? {} : { website: input.website }),
        }),
      );
    } catch (error) {
      return failed(error);
    }
  },
});

const TOOLS = [
  listAdapters,
  prepareLaunchTool,
  simulateLaunchTool,
  signingLink,
  verifyLaunchTool,
  uploadMetadata,
];

export async function startChat(): Promise<void> {
  // With a credential of your own, talk to Anthropic directly and pay for your
  // own tokens. Without one, relay through the operator's host so that
  // installing the package is the only setup step. Either way no key is ever
  // written to disk or embedded in this package.
  const own = (process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? "").trim() !== "";
  const client = own
    ? new Anthropic()
    : new Anthropic({ baseURL: RELAY_URL, apiKey: "relayed-by-host" });
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  const io = createInterface({ input: process.stdin, output: process.stdout });

  // Only on a real terminal — piped output stays machine-readable.
  if (process.stdout.isTTY === true) {
    const colour = (process.env.NO_COLOR ?? "") === "" && process.env.TERM !== "dumb";
    process.stdout.write(`${mascot(colour)}\n\n`);
  }
  process.stdout.write(
    "Nexus — token launches on BNB Smart Chain and Robinhood Chain.\n" +
      "I prepare and simulate a launch; you approve the plan and sign in your own wallet.\n" +
      "Launches are permanent and can lose all value. Nexus is unaudited.\n" +
      "Type your request, or 'exit' to leave.\n\n",
  );

  try {
    for (;;) {
      let line: string;
      try {
        line = (await io.question("you › ")).trim();
      } catch {
        // stdin closed (Ctrl-D, or piped input ran out) — leave quietly.
        break;
      }
      if (line === "") continue;
      if (line === "exit" || line === "quit") break;
      messages.push({ role: "user", content: line });

      process.stdout.write("\nnexus › ");
      try {
        const runner = client.beta.messages.toolRunner({
          model: MODEL,
          max_tokens: 64_000,
          system: SYSTEM,
          tools: TOOLS,
          messages,
          stream: true,
          betas: ["server-side-fallback-2026-06-01"],
          fallbacks: [{ model: FALLBACK_MODEL }],
          output_config: { effort: "high" },
        });

        // The model speaks once before a tool call and again after it. Without a
        // break the two run together mid-sentence.
        let spoke = false;
        let pending = false;
        for await (const stream of runner) {
          for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              if (pending) {
                process.stdout.write("\n\n");
                pending = false;
              }
              process.stdout.write(event.delta.text);
              spoke = true;
            }
          }
          if (spoke) pending = true;
          const message = await stream.finalMessage();
          if (message.stop_reason === "refusal") {
            process.stdout.write("\n[Declined by safety classifiers. Rephrase, or ask for something else.]");
            break;
          }
        }
        const final = await runner.done();
        messages.push({ role: "assistant", content: final.content });
      } catch (error) {
        if (error instanceof Anthropic.AuthenticationError) {
          process.stdout.write(
            own
              ? "\n[Anthropic rejected your credentials. Check ANTHROPIC_API_KEY.]"
              : "\n[The Nexus host is not accepting agent requests right now.]",
          );
          continue;
        }
        if (error instanceof Anthropic.RateLimitError) {
          process.stdout.write(
            own
              ? "\n[Rate limited by the Anthropic API. Wait a moment and try again.]"
              : "\n[The shared Nexus host is rate limited. Wait a few minutes, or set ANTHROPIC_API_KEY to use your own.]",
          );
          continue;
        }
        const nexusError = toNexusError(error);
        process.stdout.write(`\n[${nexusError.code}] ${nexusError.message}`);
        if (nexusError.broadcast) {
          process.stdout.write(
            "\nA transaction may already be onchain. Do not retry — reconcile the hash and this wallet's nonce first.",
          );
        }
      }
      process.stdout.write("\n\n");
    }
  } finally {
    io.close();
  }
}
