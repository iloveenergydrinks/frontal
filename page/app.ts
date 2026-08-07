import { createPublicClient, createWalletClient, custom, http, type Chain, type EIP1193Provider, type Hash, type PublicClient } from "viem";

import { bnbSmartChain, robinhoodChain, nativeSymbol } from "../src/chains.js";
import { NexusError, toNexusError } from "../src/errors.js";
import { flapStandard } from "../src/flap.js";
import { simulateLaunch, verifyLaunch } from "../src/launch.js";
import { decodePlanUrl } from "../src/plan-url.js";
import { pons } from "../src/pons.js";
import { ponsV2 } from "../src/pons-v2.js";
import type { LaunchAdapter, LaunchPlan } from "../src/types.js";

/**
 * The hosted signing page.
 *
 * It is deliberately static. The plan arrives in the URL fragment, which is
 * never sent to whatever host serves this file, so no server can display one
 * transaction while the wallet signs another. Everything below runs in the
 * reader's browser against a public RPC.
 *
 * Decoding alone is not enough to sign. A content hash proves a plan is
 * internally consistent, not that the protocol still matches it, so this page
 * re-derives the plan from live chain state and simulates the exact transaction
 * before a wallet is ever opened. That check is the reason this page exists
 * rather than a link that just forwards calldata to MetaMask.
 */

declare global {
  interface Window {
    ethereum?: EIP1193Provider & { on?: (event: string, handler: (...args: unknown[]) => void) => void };
  }
}

const RPC_OVERRIDES: Record<number, string | undefined> = {};

function chainFor(chainId: number): Chain {
  if (chainId === bnbSmartChain.id) return bnbSmartChain;
  if (chainId === robinhoodChain.id) return robinhoodChain;
  throw new NexusError("UNSUPPORTED_CHAIN", `This page does not support chain ${chainId}.`);
}

function adapterFor(id: string): LaunchAdapter<unknown> {
  if (id === "flap-standard") return flapStandard() as LaunchAdapter<unknown>;
  if (id === "pons") return pons() as LaunchAdapter<unknown>;
  if (id === "pons-v2") return ponsV2() as LaunchAdapter<unknown>;
  throw new NexusError("UNSUPPORTED_ADAPTER", `This page does not support the ${id} adapter.`);
}

function publicClientFor(chainId: number): PublicClient {
  const chain = chainFor(chainId);
  const url = RPC_OVERRIDES[chainId] ?? chain.rpcUrls.default.http[0];
  return createPublicClient({ chain, transport: http(url) }) as PublicClient;
}

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`Missing element ${id}.`);
  return found;
}

function text(value: string): Text {
  return document.createTextNode(value);
}

function row(label: string, value: string, mono = false): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "row";
  const key = document.createElement("span");
  key.className = "row-label";
  key.append(text(label));
  const val = document.createElement("span");
  val.className = mono ? "row-value mono" : "row-value";
  val.append(text(value));
  wrapper.append(key, val);
  return wrapper;
}

function formatNative(wei: string, chainId: number): string {
  const value = BigInt(wei);
  const symbol = nativeSymbol(chainId);
  if (value === 0n) return `0 ${symbol}`;
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n).toString(10).padStart(18, "0").replace(/0+$/u, "");
  return `${whole.toString(10)}${fraction === "" ? "" : `.${fraction}`} ${symbol}`;
}

function status(kind: "error" | "info" | "ok" | "working", message: string): void {
  const node = element("status");
  node.className = `status status-${kind}`;
  node.replaceChildren(text(message));
}

function fail(error: unknown): void {
  const nexusError = toNexusError(error);
  status("error", nexusError.message);
  if (nexusError.broadcast) {
    const warning = element("broadcast-warning");
    warning.hidden = false;
    warning.replaceChildren(
      text(
        "A transaction may already be onchain. Do not retry — a retry can create a second token. Reconcile the transaction hash and this wallet's nonce before doing anything else.",
      ),
    );
  }
}

let plan: LaunchPlan | undefined;
let adapter: LaunchAdapter<unknown> | undefined;
let revalidated = false;

function renderPlan(loaded: LaunchPlan): void {
  element("plan-id").replaceChildren(text(loaded.id));
  const summary = element("summary");
  summary.replaceChildren();
  summary.append(
    row("Protocol", loaded.summary.protocol),
    row("Chain", String(loaded.chainId)),
    row("Signing wallet", loaded.account, true),
    row("Contract", loaded.transaction.to, true),
    row("Transaction value", formatNative(loaded.transaction.value, loaded.chainId)),
  );
  for (const line of loaded.summary.rows) summary.append(row(line.label, line.value, /^0x/u.test(line.value)));

  const pricing = element("pricing");
  pricing.replaceChildren(text(`${loaded.summary.pricing} ${loaded.summary.liquidity}`));

  const costs = element("costs");
  costs.replaceChildren();
  for (const cost of loaded.summary.costs) {
    costs.append(row(cost.label, formatNative(cost.amount, loaded.chainId)));
  }

  const warnings = element("warnings");
  warnings.replaceChildren();
  for (const warning of loaded.warnings) {
    const item = document.createElement("li");
    const code = document.createElement("strong");
    code.append(text(warning.code));
    item.append(code, text(` — ${warning.message}`));
    warnings.append(item);
  }

  element("calldata").replaceChildren(text(loaded.transaction.data));
  element("plan-section").hidden = false;
}

async function revalidate(): Promise<void> {
  if (plan === undefined || adapter === undefined) return;
  status("working", "Rebuilding this plan from live chain state and simulating the exact transaction…");
  element("revalidate").setAttribute("disabled", "true");
  try {
    const publicClient = publicClientFor(plan.chainId);
    const simulation = await simulateLaunch({ adapter, plan, publicClient });
    const funding = simulation.funding;
    const details = element("simulation");
    details.replaceChildren();
    details.append(
      row("Simulation", "passed against current state"),
      row("Checked at block", simulation.blockNumber),
      row("Estimated gas", simulation.gasEstimate),
      row("Wallet balance", formatNative(funding.balance, plan.chainId)),
      row("Total required", formatNative(funding.required, plan.chainId)),
      row("Shortfall", formatNative(funding.shortfall, plan.chainId)),
    );
    element("simulation-section").hidden = false;
    revalidated = true;
    if (BigInt(funding.shortfall) > 0n) {
      status(
        "error",
        `This wallet is short ${formatNative(funding.shortfall, plan.chainId)}. Fund ${plan.account} externally, then revalidate again. Do not edit the plan.`,
      );
      return;
    }
    status("ok", "The plan still matches live protocol state and the wallet can cover it. Review everything above, then connect a wallet.");
    element("connect").removeAttribute("disabled");
  } catch (error) {
    revalidated = false;
    fail(error);
  } finally {
    element("revalidate").removeAttribute("disabled");
  }
}

async function connectAndSign(): Promise<void> {
  if (plan === undefined || adapter === undefined) return;
  if (!revalidated) {
    status("error", "Revalidate against live chain state before signing.");
    return;
  }
  const provider = window.ethereum;
  if (provider === undefined) {
    status("error", "No injected wallet was found in this browser.");
    return;
  }
  const button = element("connect");
  button.setAttribute("disabled", "true");
  try {
    status("working", "Requesting accounts…");
    const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    const connected = accounts[0];
    if (connected === undefined || connected.toLowerCase() !== plan.account.toLowerCase()) {
      throw new NexusError(
        "INVALID_ARGUMENT",
        `This plan must be signed by ${plan.account}. The connected wallet is ${connected ?? "unavailable"}.`,
      );
    }
    const expectedChain = `0x${plan.chainId.toString(16)}`;
    let current = (await provider.request({ method: "eth_chainId" })) as string;
    if (current.toLowerCase() !== expectedChain) {
      status("working", `Switching the wallet to chain ${plan.chainId}…`);
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: expectedChain }] });
      current = (await provider.request({ method: "eth_chainId" })) as string;
    }
    if (current.toLowerCase() !== expectedChain) {
      throw new NexusError("INVALID_ARGUMENT", `The wallet is not on chain ${plan.chainId}.`);
    }

    // Re-derive one final time against the head the wallet will broadcast into.
    status("working", "Final check against current state before the wallet opens…");
    const publicClient = publicClientFor(plan.chainId);
    await simulateLaunch({ adapter, plan, publicClient });

    const walletClient = createWalletClient({
      account: plan.account,
      chain: chainFor(plan.chainId),
      transport: custom(provider),
    });
    status("working", "Approve the exact transaction in your wallet. Nexus does not retry after a possible broadcast.");
    const hash = (await walletClient.sendTransaction({
      account: plan.account,
      chain: chainFor(plan.chainId),
      to: plan.transaction.to,
      data: plan.transaction.data,
      value: BigInt(plan.transaction.value),
    })) as Hash;

    element("tx-hash").replaceChildren(text(hash));
    element("result-section").hidden = false;
    status("working", `Broadcast ${hash}. Waiting for a receipt and verifying it…`);

    const result = await verifyLaunch({ adapter, hash, plan, publicClient });
    const verified = element("verified");
    verified.replaceChildren();
    verified.append(
      row("Verified", "yes"),
      row("Token", result.token, true),
      ...(result.market === undefined ? [] : [row("Market", result.market, true)]),
      row("Block", result.blockNumber),
    );
    status("ok", "Launched and verified against the protocol's own record.");
  } catch (error) {
    fail(error);
  } finally {
    button.removeAttribute("disabled");
  }
}

async function boot(): Promise<void> {
  try {
    const rpcParameter = new URLSearchParams(window.location.search).get("rpc");
    if (rpcParameter !== null && rpcParameter !== "") {
      const url = new URL(rpcParameter);
      if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
        throw new NexusError("INVALID_ARGUMENT", "An RPC override must use https or loopback.");
      }
    }
    if (window.location.hash === "" || window.location.hash === "#") {
      element("home").hidden = false;
      return;
    }
    element("home").hidden = true;
    element("signing").hidden = false;
    document.title = "Review and sign a Nexus launch";
    status("working", "Decoding and checking the plan against its own content hash…");
    const loaded = await decodePlanUrl(window.location.hash);
    plan = loaded;
    adapter = adapterFor(loaded.adapter.id);
    if (rpcParameter !== null && rpcParameter !== "") RPC_OVERRIDES[loaded.chainId] = rpcParameter;
    renderPlan(loaded);
    status(
      "info",
      "The plan matches its own content hash. Confirm the plan ID above is the one you approved, then revalidate it against live chain state.",
    );
    element("revalidate").removeAttribute("disabled");
  } catch (error) {
    fail(error);
  }
}

element("revalidate").addEventListener("click", () => void revalidate());
element("connect").addEventListener("click", () => void connectAndSign());
void boot();
