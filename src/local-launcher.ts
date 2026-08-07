import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

import type { Hash, PublicClient } from "viem";

import { NexusError, toNexusError } from "./errors.js";
import { simulateLaunch, verifyLaunch } from "./launch.js";
import { stringifyJson } from "./serialization.js";
import type { LaunchAdapter, LaunchPlan } from "./types.js";

interface LocalLauncherParameters<TLaunch> {
  adapter: LaunchAdapter<TLaunch>;
  approvedPlanId: Hash;
  plan: LaunchPlan;
  port?: number;
  publicClient: PublicClient;
}

export interface LocalLauncherServer {
  close(): Promise<void>;
  url: string;
}

const MAX_REQUEST_BYTES = 2_048;

function safeJson(value: unknown): string {
  return stringifyJson(value, false).replaceAll("<", "\\u003c");
}

function envelope(data: unknown): string {
  return stringifyJson({ data, ok: true, schemaVersion: "1.0" });
}

function errorEnvelope(error: unknown): string {
  return stringifyJson({
    error: toNexusError(error).toJSON(),
    ok: false,
    schemaVersion: "1.0",
  });
}

function sendJson(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_REQUEST_BYTES) throw new NexusError("INVALID_ARGUMENT", "Request body is too large.");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (cause) {
    throw new NexusError("INVALID_ARGUMENT", "Request body must be valid JSON.", { cause });
  }
}

function page(plan: LaunchPlan, csrfToken: string, nonce: string): string {
  const pageData = safeJson({ csrfToken, plan });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Nexus — Approved launch</title>
  <style nonce="${nonce}">
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; background:#070a0d; color:#eefaff; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:radial-gradient(circle at 50% 0,#11232a 0,#070a0d 42%); }
    main { width:min(820px,calc(100% - 32px)); margin:0 auto; padding:48px 0 72px; }
    header { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:24px; }
    h1 { font-size:26px; margin:0; letter-spacing:-.03em; }
    .badge { color:#dfff00; border:1px solid #405000; background:#151b00; padding:7px 10px; border-radius:999px; font-size:12px; font-weight:800; }
    .card { background:rgba(13,18,22,.94); border:1px solid #26333a; border-radius:18px; padding:22px; box-shadow:0 24px 80px rgba(0,0,0,.36); margin-top:14px; }
    .identity { display:flex; justify-content:space-between; gap:20px; align-items:end; }
    .token { font-size:30px; font-weight:850; letter-spacing:-.04em; }
    .symbol { color:#5feeff; font:700 14px ui-monospace,SFMono-Regular,monospace; }
    .label { color:#83929a; font-size:11px; font-weight:750; text-transform:uppercase; letter-spacing:.1em; margin-bottom:5px; }
    .mono { overflow-wrap:anywhere; font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; color:#c7d5db; }
    .plan-id { color:#fff; }
    .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; margin-top:18px; }
    .item { background:#090d10; border:1px solid #1b272d; border-radius:12px; padding:13px; }
    .warnings { margin:0; padding-left:18px; color:#e6c979; font-size:13px; line-height:1.55; }
    .actions { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:18px; }
    button { appearance:none; border:0; border-radius:12px; padding:14px 16px; font-weight:850; font-size:14px; cursor:pointer; background:#27e5f3; color:#001013; }
    button.primary { background:#dfff00; }
    button:disabled { opacity:.35; cursor:not-allowed; }
    .status { min-height:52px; margin-top:14px; padding:13px; border-radius:12px; background:#090d10; border:1px solid #1b272d; font:12px/1.5 ui-monospace,SFMono-Regular,monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
    .ok { color:#dfff00; } .error { color:#ff8f8f; } a { color:#5feeff; }
    .fine { color:#83929a; font-size:12px; line-height:1.55; margin-top:14px; }
    @media (max-width:640px) { main{padding-top:24px}.grid,.actions{grid-template-columns:1fr}.identity{align-items:start;flex-direction:column}.token{font-size:26px} }
  </style>
</head>
<body>
<main>
  <header><h1>Nexus local launcher</h1><span class="badge">EXACT PLAN APPROVED</span></header>
  <section class="card">
    <div class="identity"><div><div class="label">Token</div><div class="token" id="token"></div></div><div class="symbol" id="network"></div></div>
    <div class="grid" id="plan-grid"></div>
  </section>
  <section class="card">
    <div class="label">Approved plan ID</div><div class="mono plan-id" id="plan-id"></div>
    <div class="actions"><button id="connect">Connect browser wallet</button><button class="primary" id="launch" disabled>Launch exact plan</button></div>
    <div class="status" id="status">Waiting for the exact approved wallet. Nothing has been broadcast.</div>
    <div class="fine">The browser wallet sends the transaction directly to the chain. This localhost server can only re-simulate and verify the approved plan; it cannot sign, alter, or broadcast it. Never retry after an ambiguous submission.</div>
  </section>
  <section class="card"><div class="label">Material warnings</div><ul class="warnings" id="warnings"></ul></section>
</main>
<script nonce="${nonce}">
const boot=${pageData};
const plan=boot.plan;
const requiredAccount=plan.account.toLowerCase();
const expectedChain='0x'+Number(plan.chainId).toString(16);
const status=document.querySelector('#status');
const connect=document.querySelector('#connect');
const launch=document.querySelector('#launch');
let connected=false;
let submitted=false;
const chainConfig=plan.chainId===56?{chainId:'0x38',chainName:'BNB Smart Chain',nativeCurrency:{name:'BNB',symbol:'BNB',decimals:18},rpcUrls:['https://bsc-dataseed.bnbchain.org'],blockExplorerUrls:['https://bscscan.com']}:{chainId:'0x1237',chainName:'Robinhood Chain',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:['https://rpc.mainnet.chain.robinhood.com'],blockExplorerUrls:['https://robinhoodchain.blockscout.com']};
const setStatus=(message,type='')=>{status.textContent=message;status.className='status '+type;};
const row=(label,value)=>{const item=document.createElement('div');item.className='item';const l=document.createElement('div');l.className='label';l.textContent=label;const v=document.createElement('div');v.className='mono';v.textContent=value;item.append(l,v);return item;};
document.querySelector('#token').textContent=plan.request.token.name+' ('+plan.request.token.symbol+')';
document.querySelector('#network').textContent=chainConfig.chainName+' · '+plan.chainId;
document.querySelector('#plan-id').textContent=plan.id;
const grid=document.querySelector('#plan-grid');
grid.append(row('Launch account',plan.account),row('Predicted token',plan.expected.token||'Protocol assigned'),row('Protocol',plan.summary.protocol),row('Transaction value',plan.transaction.value+' base units'),row('Transaction target',plan.transaction.to),row('Initial buy',plan.request.launch.initialBuy||'None'));
for(const warning of plan.warnings){const li=document.createElement('li');li.textContent=warning.message;document.querySelector('#warnings').append(li);}
async function api(path,body={}){const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),45000);try{const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json','x-nexus-csrf':boot.csrfToken},body:JSON.stringify(body),signal:controller.signal});const value=await response.json();if(!value.ok){const error=new Error(value.error.message);error.nexus=value.error;throw error;}return value.data;}catch(error){if(error&&error.name==='AbortError')throw new Error('Local verification timed out after 45 seconds. Do not retry a submitted transaction; reconcile its hash first.');throw error;}finally{clearTimeout(timeout);}}
async function ensureWallet(){
  if(!window.ethereum)throw new Error('No injected browser wallet found. Open this URL in a browser with your wallet extension enabled.');
  let accounts=await window.ethereum.request({method:'eth_requestAccounts'});
  let chain=await window.ethereum.request({method:'eth_chainId'});
  if(chain.toLowerCase()!==expectedChain){try{await window.ethereum.request({method:'wallet_switchEthereumChain',params:[{chainId:expectedChain}]});}catch(error){if(error&&error.code===4902){await window.ethereum.request({method:'wallet_addEthereumChain',params:[chainConfig]});}else{throw error;}}chain=await window.ethereum.request({method:'eth_chainId'});}
  accounts=await window.ethereum.request({method:'eth_accounts'});
  if(chain.toLowerCase()!==expectedChain)throw new Error('Wallet is on the wrong chain. Expected '+plan.chainId+'.');
  if(!accounts.some(account=>account.toLowerCase()===requiredAccount))throw new Error('Wallet does not expose the exact approved account '+plan.account+'.');
  connected=true;launch.disabled=false;connect.textContent='Wallet connected';setStatus('Exact account and chain connected. Launch remains unbroadcast.','ok');
}
connect.addEventListener('click',async()=>{try{connect.disabled=true;setStatus('Connecting wallet…');await ensureWallet();}catch(error){connected=false;launch.disabled=true;connect.disabled=false;setStatus(error.message,'error');}});
launch.addEventListener('click',async()=>{
  if(!connected||submitted)return;
  launch.disabled=true;connect.disabled=true;
  try{
    await ensureWallet();
    setStatus('Reconstructing and simulating the exact approved plan…');
    const simulation=await api('/api/simulate');
    if(simulation.planId.toLowerCase()!==plan.id.toLowerCase())throw new Error('Simulation returned a different plan ID.');
    if(BigInt(simulation.funding.shortfall)!==0n)throw new Error('Wallet funding shortfall: '+simulation.funding.shortfall+' '+simulation.funding.asset+' base units.');
    setStatus('Simulation passed. Confirm only the exact transaction shown by your wallet.');
    const value='0x'+BigInt(plan.transaction.value).toString(16);
    let hash;
    try{hash=await window.ethereum.request({method:'eth_sendTransaction',params:[{from:plan.account,to:plan.transaction.to,data:plan.transaction.data,value}]});}
    catch(error){if(error&&error.code===4001){throw new Error('Wallet rejected the transaction. Nothing was authorized.');}throw new Error('Wallet submission outcome is ambiguous: '+error.message+' Check wallet activity and the sender nonce before any retry.');}
    submitted=true;
    setStatus('Transaction submitted: '+hash+'\\nWaiting for canonical receipt verification…');
    const result=await api('/api/verify',{hash});
    const explorer=chainConfig.blockExplorerUrls[0]+'/tx/'+hash;
    status.textContent='VERIFIED\\nToken: '+result.token+'\\nTransaction: ';
    const link=document.createElement('a');link.href=explorer;link.target='_blank';link.rel='noreferrer';link.textContent=hash;status.append(link);status.className='status ok';
  }catch(error){setStatus(error.message,'error');if(!submitted){launch.disabled=!connected;connect.disabled=false;}}
});
if(window.ethereum){window.ethereum.on?.('accountsChanged',()=>{connected=false;launch.disabled=true;connect.disabled=false;connect.textContent='Reconnect browser wallet';setStatus('Wallet account changed. Reconnect and revalidate before launch.');});window.ethereum.on?.('chainChanged',()=>{connected=false;launch.disabled=true;connect.disabled=false;connect.textContent='Reconnect browser wallet';setStatus('Wallet chain changed. Reconnect and revalidate before launch.');});}
</script>
</body>
</html>`;
}

export async function startLocalLauncher<TLaunch>(
  parameters: LocalLauncherParameters<TLaunch>,
): Promise<LocalLauncherServer> {
  const { adapter, approvedPlanId, plan, publicClient } = parameters;
  if (approvedPlanId.toLowerCase() !== plan.id.toLowerCase()) {
    throw new NexusError("INVALID_PLAN", "Local launcher approval does not match the exact saved plan ID.");
  }
  const port = parameters.port ?? 4_173;
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    throw new NexusError("INVALID_ARGUMENT", "Local launcher port must be between 1024 and 65535.");
  }
  const host = "127.0.0.1";
  const origin = `http://${host}:${port}`;
  const csrfToken = randomBytes(32).toString("hex");
  const nonce = randomBytes(18).toString("base64");
  const html = page(plan, csrfToken, nonce);

  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader(
      "content-security-policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    response.setHeader("cross-origin-opener-policy", "same-origin");
    response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    if (request.headers.host !== `${host}:${port}`) {
      sendJson(response, 403, errorEnvelope(new NexusError("INVALID_ARGUMENT", "Invalid local launcher host.")));
      return;
    }
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || !url.pathname.startsWith("/api/")) {
      sendJson(response, 404, errorEnvelope(new NexusError("INVALID_ARGUMENT", "Route not found.")));
      return;
    }
    if (request.headers.origin !== origin || request.headers["x-nexus-csrf"] !== csrfToken) {
      sendJson(response, 403, errorEnvelope(new NexusError("INVALID_ARGUMENT", "Local launcher request rejected.")));
      return;
    }
    try {
      if (url.pathname === "/api/simulate") {
        const simulation = await simulateLaunch({ adapter, plan, publicClient });
        sendJson(response, 200, envelope(simulation));
        return;
      }
      if (url.pathname === "/api/verify") {
        const body = (await readJson(request)) as { hash?: unknown };
        if (typeof body.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(body.hash)) {
          throw new NexusError("INVALID_ARGUMENT", "Verification requires a transaction hash.");
        }
        const result = await verifyLaunch({ adapter, hash: body.hash as Hash, plan, publicClient });
        sendJson(response, 200, envelope(result));
        return;
      }
      sendJson(response, 404, errorEnvelope(new NexusError("INVALID_ARGUMENT", "Route not found.")));
    } catch (error) {
      sendJson(response, 400, errorEnvelope(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  }).catch((cause: unknown) => {
    throw new NexusError("RPC_ERROR", `Unable to start the local launcher on ${origin}.`, { cause });
  });
  return {
    url: origin,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
