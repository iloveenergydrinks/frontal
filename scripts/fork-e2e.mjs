import { spawn } from "node:child_process";
import { once } from "node:events";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
} from "viem";
import { bsc } from "viem/chains";

import { flapStandard } from "../dist/flap.js";
import { prepareLaunch, sendLaunch, simulateLaunch, verifyLaunch } from "../dist/index.js";
import { pons } from "../dist/pons.js";
import { ponsV2 } from "../dist/pons-v2.js";

const BNB_ACCOUNT = getAddress("0xbdeBf49903Ab0BE38FbC242a236AC5c83CE49AaA");
const RH_ACCOUNT = getAddress("0x0731dD4Aad7B14363fc2e77ff934646e809A46D8");
const TEST_BALANCE = "0x21e19e0c9bab2400000";

async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const payload = await response.json();
  if (payload.error !== undefined) throw new Error(`${method} failed: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

async function startFork({ chainId, port, upstream }) {
  const process = spawn(
    "anvil",
    ["--fork-url", upstream, "--port", String(port), "--chain-id", String(chainId), "--silent"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let diagnostics = "";
  process.stderr.on("data", (chunk) => {
    diagnostics = `${diagnostics}${String(chunk)}`.slice(-8_000);
  });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`Anvil exited before startup. ${diagnostics}`);
    try {
      const actual = Number(BigInt(await rpc(url, "eth_chainId")));
      if (actual !== chainId) throw new Error(`Fork returned chain ${actual}, expected ${chainId}.`);
      return { diagnostics: () => diagnostics, process, url };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  process.kill("SIGTERM");
  throw new Error(`Timed out starting Anvil. ${diagnostics}`);
}

async function stopFork(fork) {
  if (fork.process.exitCode !== null) return;
  fork.process.kill("SIGTERM");
  await Promise.race([once(fork.process, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (fork.process.exitCode === null) fork.process.kill("SIGKILL");
}

async function fundAndImpersonate(url, addresses) {
  for (const address of addresses) {
    await rpc(url, "anvil_setBalance", [address, TEST_BALANCE]);
    await rpc(url, "anvil_impersonateAccount", [address]);
  }
}

async function runFlap() {
  const fork = await startFork({
    chainId: 56,
    port: 18_547,
    upstream: process.env.NEXUS_BNB_FORK_URL ?? process.env.NEXUS_BNB_RPC_URL ?? "https://bsc-dataseed.bnbchain.org",
  });
  try {
    await fundAndImpersonate(fork.url, [BNB_ACCOUNT]);
    const publicClient = createPublicClient({ chain: bsc, transport: http(fork.url) });
    const walletClient = createWalletClient({ account: BNB_ACCOUNT, chain: bsc, transport: http(fork.url) });
    const adapter = flapStandard();
    const plan = await prepareLaunch({
      account: BNB_ACCOUNT,
      adapter,
      launch: {
        antiFarmerDuration: 0,
        initialBuy: 0,
        metadataCid: "bafybeigdyrnexusforkmetadata",
        saltSeed: "nexus-cli-fork-e2e-v1",
      },
      publicClient,
      token: {
        description: "Disposable local-fork launch.",
        name: "Nexus Fork E2E",
        socials: { website: "https://cli.nexus" },
        symbol: "NXFORK",
      },
    });
    const simulation = await simulateLaunch({ adapter, plan, publicClient });
    const hash = await sendLaunch({ adapter, plan, publicClient, walletClient });
    const result = await verifyLaunch({ adapter, hash, plan, publicClient });
    await rpc(fork.url, "anvil_stopImpersonatingAccount", [BNB_ACCOUNT]);
    return {
      adapter: adapter.id,
      hash,
      planId: plan.id,
      shortfall: simulation.funding.shortfall,
      token: result.token,
      verified: result.verified,
    };
  } catch (error) {
    throw new Error(`Flap fork E2E failed. ${fork.diagnostics()}`, { cause: error });
  } finally {
    await stopFork(fork);
  }
}

async function runPons() {
  const fork = await startFork({
    chainId: 4_663,
    port: 18_548,
    upstream:
      process.env.NEXUS_RH_FORK_URL ??
      process.env.NEXUS_RH_RPC_URL ??
      "https://rpc.mainnet.chain.robinhood.com",
  });
  try {
    await fundAndImpersonate(fork.url, [RH_ACCOUNT]);
    const chain = defineChain({
      id: 4_663,
      name: "Robinhood Chain fork",
      nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
      rpcUrls: { default: { http: [fork.url] } },
    });
    const publicClient = createPublicClient({ chain, transport: http(fork.url) });
    const adapter = pons();
    const plan = await prepareLaunch({
      account: RH_ACCOUNT,
      adapter,
      launch: {
        dexId: 0,
        feeWallet: RH_ACCOUNT,
        initialBuy: 0,
        launchConfigId: 0,
        saltSeed: "nexus-cli-fork-e2e-v1",
      },
      publicClient,
      token: {
        description: "Disposable local-fork launch.",
        image: "ipfs://bafybeigdyrnexusforkimage",
        name: "Nexus Fork E2E",
        socials: { website: "https://cli.nexus" },
        symbol: "NXFORK",
      },
    });
    const simulation = await simulateLaunch({ adapter, plan, publicClient });
    const walletClient = createWalletClient({ account: RH_ACCOUNT, chain, transport: http(fork.url) });
    const hash = await sendLaunch({ adapter, plan, publicClient, walletClient });
    const result = await verifyLaunch({ adapter, hash, plan, publicClient });
    await rpc(fork.url, "anvil_stopImpersonatingAccount", [RH_ACCOUNT]);
    return {
      adapter: adapter.id,
      hash,
      market: result.market,
      planId: plan.id,
      predictedToken: plan.request.launch.predictedToken,
      shortfall: simulation.funding.shortfall,
      token: result.token,
      verified: result.verified,
    };
  } catch (error) {
    throw new Error(`Pons fork E2E failed. ${fork.diagnostics()}`, { cause: error });
  } finally {
    await stopFork(fork);
  }
}

async function runPonsV2() {
  const fork = await startFork({
    chainId: 4_663,
    port: 18_549,
    upstream:
      process.env.NEXUS_RH_FORK_URL ??
      process.env.NEXUS_RH_RPC_URL ??
      "https://rpc.mainnet.chain.robinhood.com",
  });
  try {
    await fundAndImpersonate(fork.url, [RH_ACCOUNT]);
    const chain = defineChain({
      id: 4_663,
      name: "Robinhood Chain fork",
      nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
      rpcUrls: { default: { http: [fork.url] } },
    });
    const publicClient = createPublicClient({ chain, transport: http(fork.url) });
    const adapter = ponsV2();
    const plan = await prepareLaunch({
      account: RH_ACCOUNT,
      adapter,
      launch: {
        buybackEnabled: false,
        creatorFeeRecipient: RH_ACCOUNT,
        creatorTaxBps: 0,
        launchConfigId: 0,
        saltSeed: "nexus-cli-pons-v2-fork-e2e-v1",
      },
      publicClient,
      token: {
        description: "Disposable local-fork Pons V2 launch.",
        image: "ipfs://bafybeigdyrnexusforkimage",
        name: "Nexus V2 Fork E2E",
        socials: { website: "https://cli.nexus" },
        symbol: "NXV2",
      },
    });
    const simulation = await simulateLaunch({ adapter, plan, publicClient });
    const walletClient = createWalletClient({ account: RH_ACCOUNT, chain, transport: http(fork.url) });
    const hash = await sendLaunch({ adapter, plan, publicClient, walletClient });
    const result = await verifyLaunch({ adapter, hash, plan, publicClient });
    await rpc(fork.url, "anvil_stopImpersonatingAccount", [RH_ACCOUNT]);
    return {
      adapter: adapter.id,
      curve: result.market,
      hash,
      planId: plan.id,
      predictedToken: plan.request.launch.predictedToken,
      shortfall: simulation.funding.shortfall,
      token: result.token,
      verified: result.verified,
    };
  } catch (error) {
    throw new Error(`Pons V2 fork E2E failed. ${fork.diagnostics()}`, { cause: error });
  } finally {
    await stopFork(fork);
  }
}

const results = [];
results.push(await runFlap());
results.push(await runPons());
results.push(await runPonsV2());
process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`);
