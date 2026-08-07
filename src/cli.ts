#!/usr/bin/env node

import process from "node:process";

import UniversalProvider from "@walletconnect/universal-provider";
import { Command } from "commander";
import qrcode from "qrcode-terminal";
import {
  createWalletClient,
  custom,
  type EIP1193Provider,
  type Hash,
} from "viem";

import { startChat } from "./agent.js";
import {
  adapterFor,
  chainFor,
  publicClientFor,
  readPlan,
  requireAddress,
  rpcUrlFor,
  writePlan,
} from "./environment.js";
import { NexusError, toNexusError } from "./errors.js";
import { uploadFlapMetadata } from "./flap-metadata.js";
import { flapStandard, type FlapStandardLaunchOptions } from "./flap.js";
import { prepareLaunch, sendLaunch, simulateLaunch, verifyLaunch } from "./launch.js";
import { startLocalLauncher } from "./local-launcher.js";
import { encodePlanUrl } from "./plan-url.js";
import { pons, type PonsLaunchOptions } from "./pons.js";
import { ponsV2, type PonsV2LaunchOptions } from "./pons-v2.js";
import { stringifyJson } from "./serialization.js";
import type { LaunchPlan, SocialLinks, TokenMetadata } from "./types.js";

interface GlobalOptions {
  json?: boolean;
}

interface CommonPrepareOptions {
  account: string;
  adapter: string;
  description?: string;
  discord?: string;
  farcaster?: string;
  force?: boolean;
  image?: string;
  name: string;
  out: string;
  symbol: string;
  telegram?: string;
  twitter?: string;
  website?: string;
}

interface PrepareOptions extends CommonPrepareOptions {
  antiFarmerDuration?: string;
  buybackEnabled?: boolean;
  creatorFeeRecipient?: string;
  creatorTaxBps?: string;
  dexId?: string;
  feeWallet?: string;
  initialBuy?: string;
  launchConfigId?: string;
  metadataCid?: string;
  pairToken?: string;
  salt?: string;
  saltSeed?: string;
}

interface PlanFileOptions {
  plan: string;
}

interface ServeOptions extends PlanFileOptions {
  approve: string;
  port: string;
}

const program = new Command();
let emittedFailure = false;

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

function success(data: unknown, command: Command): void {
  if (globalOptions(command).json === true) {
    process.stdout.write(`${stringifyJson({ schemaVersion: "1.0", ok: true, data })}\n`);
    return;
  }
  process.stdout.write(`${stringifyJson(data)}\n`);
}

function failure(error: unknown): never {
  const nexusError = toNexusError(error);
  emittedFailure = true;
  process.stdout.write(
    `${stringifyJson({ schemaVersion: "1.0", ok: false, error: nexusError.toJSON() })}\n`,
  );
  process.exitCode = 1;
  throw nexusError;
}

function parseInteger(value: string | undefined, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new NexusError("INVALID_ARGUMENT", `${field} must be a non-negative safe integer.`);
  }
  return parsed;
}

function metadataFrom(options: CommonPrepareOptions): TokenMetadata {
  const socials: SocialLinks = {
    ...(options.discord === undefined ? {} : { discord: options.discord }),
    ...(options.farcaster === undefined ? {} : { farcaster: options.farcaster }),
    ...(options.telegram === undefined ? {} : { telegram: options.telegram }),
    ...(options.twitter === undefined ? {} : { twitter: options.twitter }),
    ...(options.website === undefined ? {} : { website: options.website }),
  };
  return {
    name: options.name,
    symbol: options.symbol,
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.image === undefined ? {} : { image: options.image }),
    ...(Object.keys(socials).length === 0 ? {} : { socials }),
  };
}

function launchOptions(options: PrepareOptions): FlapStandardLaunchOptions | PonsLaunchOptions | PonsV2LaunchOptions {
  if (options.adapter === "flap-standard") {
    if (options.metadataCid === undefined) {
      throw new NexusError("INVALID_ARGUMENT", "--metadata-cid is required for flap-standard.");
    }
    return {
      metadataCid: options.metadataCid,
      ...(options.antiFarmerDuration === undefined
        ? {}
        : { antiFarmerDuration: options.antiFarmerDuration }),
      ...(options.initialBuy === undefined ? {} : { initialBuy: options.initialBuy }),
      ...(options.salt === undefined ? {} : { salt: options.salt as Hash }),
      ...(options.saltSeed === undefined ? {} : { saltSeed: options.saltSeed }),
    };
  }
  if (options.adapter === "pons") {
    return {
      dexId: parseInteger(options.dexId, "dexId", 0),
      launchConfigId: parseInteger(options.launchConfigId, "launchConfigId", 0),
      ...(options.feeWallet === undefined
        ? {}
        : { feeWallet: requireAddress(options.feeWallet, "feeWallet") }),
      ...(options.initialBuy === undefined ? {} : { initialBuy: options.initialBuy }),
      ...(options.salt === undefined ? {} : { salt: options.salt as Hash }),
      ...(options.saltSeed === undefined ? {} : { saltSeed: options.saltSeed }),
    };
  }
  if (options.adapter === "pons-v2") {
    return {
      buybackEnabled: options.buybackEnabled ?? false,
      creatorTaxBps: parseInteger(options.creatorTaxBps, "creatorTaxBps", 0),
      launchConfigId: parseInteger(options.launchConfigId, "launchConfigId", 0),
      ...(options.creatorFeeRecipient === undefined
        ? {}
        : { creatorFeeRecipient: requireAddress(options.creatorFeeRecipient, "creatorFeeRecipient") }),
      ...(options.initialBuy === undefined ? {} : { initialBuy: options.initialBuy }),
      ...(options.pairToken === undefined
        ? {}
        : { pairToken: requireAddress(options.pairToken, "pairToken") }),
      ...(options.salt === undefined ? {} : { salt: options.salt as Hash }),
      ...(options.saltSeed === undefined ? {} : { saltSeed: options.saltSeed }),
    };
  }
  throw new NexusError("UNSUPPORTED_ADAPTER", `Unknown adapter ${options.adapter}.`);
}

async function walletConnectFor(plan: LaunchPlan): Promise<{
  provider: UniversalProvider;
  walletClient: ReturnType<typeof createWalletClient>;
}> {
  const projectId = process.env.NEXUS_WALLETCONNECT_PROJECT_ID;
  if (projectId === undefined || projectId.trim() === "") {
    throw new NexusError(
      "INVALID_ARGUMENT",
      "NEXUS_WALLETCONNECT_PROJECT_ID is required for execution.",
      { recovery: "Set it in the process environment; never place credentials in command arguments." },
    );
  }
  const chain = chainFor(plan.chainId);
  const rpcUrl = rpcUrlFor(plan.chainId);
  const provider = await UniversalProvider.init({
    projectId,
    metadata: {
      name: "Nexus CLI",
      description: "Guarded EVM token launch execution",
      url: "https://cli.nexus",
      icons: [],
    },
  });
  provider.on("display_uri", (uri: string) => {
    process.stderr.write("Scan with the wallet that owns the exact plan account:\n");
    qrcode.generate(uri, { small: true }, (code: string) => process.stderr.write(`${code}\n`));
  });
  const namespace = `eip155:${chain.id}`;
  const session = await provider.connect({
    namespaces: {
      eip155: {
        chains: [namespace],
        events: ["accountsChanged", "chainChanged"],
        methods: ["eth_sendTransaction"],
        rpcMap: { [chain.id]: rpcUrl },
      },
    },
  });
  if (session === undefined) throw new NexusError("WALLET_REJECTED", "WalletConnect did not create a session.");
  const connectedAccounts = session.namespaces.eip155?.accounts ?? [];
  const expected = `${namespace}:${plan.account}`.toLowerCase();
  if (!connectedAccounts.some((account) => account.toLowerCase() === expected)) {
    await provider.disconnect().catch(() => undefined);
    throw new NexusError(
      "INVALID_ARGUMENT",
      `Connected wallet does not expose ${plan.account} on chain ${plan.chainId}.`,
    );
  }
  provider.setDefaultChain(namespace, rpcUrl);
  const walletClient = createWalletClient({
    account: plan.account,
    chain,
    transport: custom(provider as unknown as EIP1193Provider),
  });
  return { provider, walletClient };
}

program
  .name("nexus")
  .description("Guarded EVM token launch planning, simulation, execution, and verification")
  .version("0.3.1")
  .option("--json", "emit the stable Nexus JSON envelope")
  .action(async function (this: Command) {
    // No subcommand: the conversational agent is the front door.
    try {
      await startChat();
    } catch (error) {
      failure(error);
    }
  });

program
  .command("chat")
  .description("talk to the Nexus agent; it prepares and simulates, you approve and sign")
  .action(async function (this: Command) {
    try {
      await startChat();
    } catch (error) {
      failure(error);
    }
  });

program
  .command("adapters")
  .description("list supported launch adapters and capabilities")
  .action(function (this: Command) {
    try {
      const adapters = [flapStandard(), pons(), ponsV2()].map((adapter) => ({
        id: adapter.id,
        version: adapter.version,
        chainId: adapter.chainId,
        capabilities: adapter.capabilities,
      }));
      success(adapters, this);
    } catch (error) {
      failure(error);
    }
  });

const metadata = program.command("metadata").description("prepare protocol metadata");
metadata
  .command("flap-upload")
  .description("upload and read back a PNG through Flap's official IPFS service")
  .requiredOption("--creator <address>", "creator wallet")
  .requiredOption("--image <path>", "PNG image path")
  .option("--description <text>", "token description")
  .option("--telegram <url>", "Telegram HTTPS URL")
  .option("--twitter <url>", "X/Twitter HTTPS URL")
  .option("--website <url>", "website HTTPS URL")
  .action(async function (
    this: Command,
    options: {
      creator: string;
      description?: string;
      image: string;
      telegram?: string;
      twitter?: string;
      website?: string;
    },
  ) {
    try {
      const result = await uploadFlapMetadata({
        creator: requireAddress(options.creator, "creator"),
        imagePath: options.image,
        ...(options.description === undefined ? {} : { description: options.description }),
        ...(options.telegram === undefined ? {} : { telegram: options.telegram }),
        ...(options.twitter === undefined ? {} : { twitter: options.twitter }),
        ...(options.website === undefined ? {} : { website: options.website }),
      });
      success(result, this);
    } catch (error) {
      failure(error);
    }
  });

const launch = program.command("launch").description("guarded launch workflow");
launch
  .command("prepare")
  .description("prepare a content-addressed launch plan without signing")
  .requiredOption("--adapter <id>", "flap-standard, pons (V1), or pons-v2")
  .requiredOption("--account <address>", "exact launch wallet")
  .requiredOption("--name <name>", "token name")
  .requiredOption("--symbol <symbol>", "token symbol")
  .option("--description <text>", "token description")
  .option("--image <uri>", "IPFS or HTTPS image URI")
  .option("--website <url>", "website HTTPS URL")
  .option("--twitter <url>", "X/Twitter HTTPS URL")
  .option("--telegram <url>", "Telegram HTTPS URL")
  .option("--discord <url>", "Discord HTTPS URL")
  .option("--farcaster <url>", "Farcaster HTTPS URL")
  .option("--metadata-cid <cid>", "bare Flap metadata CID")
  .option("--salt <bytes32>", "explicit CREATE2 salt")
  .option("--salt-seed <seed>", "deterministic salt-search seed")
  .option("--anti-farmer-duration <seconds>", "Flap anti-farmer duration", "0")
  .option("--initial-buy <base-units>", "atomic buy amount; unsupported adapters reject nonzero")
  .option("--fee-wallet <address>", "Pons V1 creator fee recipient")
  .option("--creator-fee-recipient <address>", "Pons V2 creator fee recipient")
  .option("--creator-tax-bps <bps>", "Pons V2 creator tax in basis points", "0")
  .option("--buyback-enabled", "enable Pons V2 creator buybacks")
  .option("--pair-token <address>", "Pons V2 approved quote token; defaults to native ETH")
  .option("--launch-config-id <id>", "Pons launch configuration", "0")
  .option("--dex-id <id>", "Pons V1 DEX configuration", "0")
  .option("--out <path>", "plan output file", "nexus-launch-plan.json")
  .option("--force", "replace an existing output file")
  .action(async function (this: Command, options: PrepareOptions) {
    try {
      const account = requireAddress(options.account, "account");
      const adapter = adapterFor(options.adapter);
      const plan = await prepareLaunch({
        account,
        adapter,
        publicClient: publicClientFor(adapter.chainId),
        token: metadataFrom(options),
        launch: launchOptions(options),
      });
      await writePlan(options.out, plan, options.force ?? false);
      success({ plan, savedTo: options.out }, this);
    } catch (error) {
      failure(error);
    }
  });

launch
  .command("simulate")
  .description("revalidate and simulate the exact saved plan")
  .requiredOption("--plan <path>", "saved plan JSON")
  .action(async function (this: Command, options: PlanFileOptions) {
    try {
      const plan = await readPlan(options.plan);
      const adapter = adapterFor(plan.adapter.id);
      const simulation = await simulateLaunch({
        adapter,
        plan,
        publicClient: publicClientFor(plan.chainId),
      });
      success({ plan, simulation }, this);
    } catch (error) {
      failure(error);
    }
  });

launch
  .command("serve")
  .description("serve one approved plan to an injected browser wallet on 127.0.0.1")
  .requiredOption("--plan <path>", "saved plan JSON")
  .requiredOption("--approve <plan-id>", "exact approved plan ID")
  .option("--port <port>", "localhost TCP port", "4173")
  .action(async function (this: Command, options: ServeOptions) {
    let local: Awaited<ReturnType<typeof startLocalLauncher>> | undefined;
    try {
      const plan = await readPlan(options.plan);
      if (options.approve.toLowerCase() !== plan.id.toLowerCase()) {
        throw new NexusError(
          "INVALID_PLAN",
          `Approval ${options.approve} does not match exact plan ID ${plan.id}.`,
        );
      }
      const port = parseInteger(options.port, "port", 4_173);
      const adapter = adapterFor(plan.adapter.id);
      local = await startLocalLauncher({
        adapter,
        approvedPlanId: plan.id,
        plan,
        port,
        publicClient: publicClientFor(plan.chainId),
      });
      success(
        {
          account: plan.account,
          chainId: plan.chainId,
          planId: plan.id,
          url: local.url,
          warning: "Open only this 127.0.0.1 URL in the browser that contains the exact approved wallet.",
        },
        this,
      );
      await new Promise<void>((resolve) => {
        const stop = (): void => resolve();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    } catch (error) {
      failure(error);
    } finally {
      await local?.close().catch(() => undefined);
    }
  });

launch
  .command("execute")
  .description("simulate, approve in WalletConnect, broadcast, and verify one exact plan")
  .requiredOption("--plan <path>", "saved plan JSON")
  .requiredOption("--approve <plan-id>", "exact plan ID shown during review")
  .action(async function (this: Command, options: PlanFileOptions & { approve: string }) {
    let provider: UniversalProvider | undefined;
    let transactionHash: Hash | undefined;
    try {
      const plan = await readPlan(options.plan);
      if (options.approve.toLowerCase() !== plan.id.toLowerCase()) {
        throw new NexusError(
          "INVALID_PLAN",
          `Approval ${options.approve} does not match exact plan ID ${plan.id}.`,
        );
      }
      const adapter = adapterFor(plan.adapter.id);
      const publicClient = publicClientFor(plan.chainId);
      const connected = await walletConnectFor(plan);
      provider = connected.provider;
      transactionHash = await sendLaunch({
        adapter,
        plan,
        publicClient,
        walletClient: connected.walletClient,
      });
      let result;
      try {
        result = await verifyLaunch({ adapter, plan, publicClient, hash: transactionHash });
      } catch (cause) {
        throw new NexusError(
          "LAUNCH_VERIFICATION_FAILED",
          `Transaction ${transactionHash} was broadcast but launch verification did not complete.`,
          {
            broadcast: true,
            cause,
            details: { transactionHash },
            recovery: "Reconcile this exact hash and sender nonce. Do not submit another launch.",
          },
        );
      }
      success({ transactionHash, result }, this);
    } catch (error) {
      if (transactionHash !== undefined && !(error instanceof NexusError && error.broadcast)) {
        failure(
          new NexusError("RPC_ERROR", `Transaction ${transactionHash} may have been broadcast.`, {
            broadcast: true,
            cause: error,
            details: { transactionHash },
            recovery: "Reconcile this exact hash and sender nonce. Do not submit another launch.",
          }),
        );
      }
      failure(error);
    } finally {
      await provider?.disconnect().catch(() => undefined);
    }
  });

launch
  .command("link")
  .description("encode a saved plan into a signing URL; the plan rides in the fragment and never reaches a server")
  .requiredOption("--plan <path>", "saved plan JSON")
  .option("--base-url <url>", "https base URL of the signing page", "https://cli.nexus/")
  .action(async function (this: Command, options: PlanFileOptions & { baseUrl: string }) {
    try {
      const plan = await readPlan(options.plan);
      const url = await encodePlanUrl(plan, options.baseUrl);
      success(
        {
          url,
          planId: plan.id,
          chainId: plan.chainId,
          account: plan.account,
          note: "The signing page must display this exact plan ID. Compare it before approving anything.",
        },
        this,
      );
    } catch (error) {
      failure(error);
    }
  });

launch
  .command("verify")
  .description("verify a known transaction against an exact saved plan")
  .requiredOption("--plan <path>", "saved plan JSON")
  .requiredOption("--tx <hash>", "transaction hash")
  .action(async function (this: Command, options: PlanFileOptions & { tx: string }) {
    try {
      if (!/^0x[0-9a-fA-F]{64}$/u.test(options.tx)) {
        throw new NexusError("INVALID_ARGUMENT", "--tx must be a 32-byte transaction hash.");
      }
      const plan = await readPlan(options.plan);
      const adapter = adapterFor(plan.adapter.id);
      const result = await verifyLaunch({
        adapter,
        plan,
        publicClient: publicClientFor(plan.chainId),
        hash: options.tx as Hash,
      });
      success(result, this);
    } catch (error) {
      failure(error);
    }
  });

program.exitOverride();

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof NexusError) {
    // Action handlers already emitted the stable error envelope.
    process.exitCode = 1;
  } else if (error instanceof Error && error.name === "CommanderError") {
    process.exitCode = 1;
  } else {
    failure(error);
  }
}

if (emittedFailure) process.exitCode = 1;
