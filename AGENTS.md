# Nexus for agents

Nexus prepares, simulates, and verifies token launches on existing EVM launch
protocols. You can do all of that autonomously. You cannot launch a token, and
neither can Nexus — broadcasting requires a human approving one exact plan and
signing in a wallet Nexus never holds a key for.

Read this before driving `nexus` or the `nexus-launch` MCP server.

## The rule that governs everything

**A plan ID is an approval token, and only a human issues it.**

`prepare` produces a plan: the exact factory and its verified runtime code, the
exact calldata, the exact native value, the predicted token address, the
economics, the warnings, and the funding requirement. All of it is hashed into
one content-addressed ID.

Change anything — the name, the image, the launch configuration, the protocol's
own deployment — and the ID changes, which invalidates any approval of the old
one. So approval is bound to exact content, never to intent.

You may automate collection, preparation, simulation, explanation, and
verification. You must not infer approval to spend funds from a conversational
request. "Launch me a coin called X" is a request to *prepare a plan*, not to
broadcast one.

## What you can and cannot do

| You can | You cannot |
|---|---|
| Discover adapters and capabilities | Broadcast a transaction |
| Prepare and save plans | Approve a plan on the human's behalf |
| Simulate against live state | Hold, request, or handle a private key or seed phrase |
| Explain costs, warnings, funding | Retry after a possible broadcast |
| Verify a mined transaction | Claim a launch succeeded without verifying it |

There is no MCP tool that sends a transaction. This is deliberate. If you find
yourself looking for one, the answer is `get_execution_instructions` — it
returns the exact command for the human to run.

## Workflow

1. **`list_adapters`** first. Protocols differ in ways that change what you
   should even ask for. Flap is a bonding curve on BNB that migrates to
   PancakeSwap; Pons is a fixed supply on Robinhood Chain seeded straight into a
   locked Uniswap V3 pool with no migration. `capabilities.initialBuy` tells you
   whether an initial buy is possible at all. Do not offer a control the selected
   adapter does not support.

2. **Collect metadata from the human.** Never invent a token name, symbol,
   description, or image. Never search the filesystem for an image — use only a
   path the human gave you.

3. **Upload metadata if the adapter needs it.** `flap-standard` requires an IPFS
   CID, so `upload_flap_metadata` must run first with a 512x512 PNG. It publishes
   the image publicly and cannot be undone, so confirm before calling it. `pons`
   stores the profile URI onchain and needs no upload.

4. **`prepare_launch`.** Signer-free; it cannot broadcast. Save the plan to a
   path the human can see.

5. **`simulate_launch`.** This rebuilds the plan from current chain state and
   compares every committed field, then simulates the real call and reports
   funding. A plan that no longer matches live state fails here rather than at
   send. Always simulate before showing a plan for approval.

6. **Present the plan for approval.** Show at minimum: the plan ID, chain,
   account, protocol and its address, the token name and symbol, the predicted
   token address, the transaction value, every warning, and the funding line
   including any shortfall. Show warnings in full — never summarize away a
   warning about an unprotected buy, a permanent lock, or an upgradeable
   protocol.

7. **Hand off execution.** Give the human what `get_execution_instructions`
   returns and stop. `serve` is for a desktop browser wallet and `execute` opens
   a WalletConnect QR for a phone; both assume they are at the machine holding
   the plan. If the response includes `signingUrl`, the operator has configured
   a hosted signing page and that link works for someone with no local checkout.
   When you give them a link, tell them the plan ID it must display — a page
   showing a different ID means the link was altered, and they should not sign.
   They approve the plan ID and sign in their own wallet.

8. **`verify_launch`** once they give you a transaction hash. Report what it
   returns. Do not describe a launch as successful before this passes.

## Funding

If the wallet cannot cover value plus gas, simulation reports an exact
shortfall. Report it and stop. Do not offer to fund the wallet, bridge assets,
move funds between accounts, or suggest a different wallet — the human funds the
exact planned address externally, then you re-simulate the unchanged plan.

## Failure handling

Errors carry stable codes. The ones that change your behavior:

- `PROTOCOL_NOT_READY` — the protocol itself is gating launches. Not retryable
  by you.
- `PLAN_CHANGED`, `PROTOCOL_CONFIG_CHANGED`, `DEPLOYMENT_CODE_MISMATCH` — live
  state moved. Prepare a fresh plan and get fresh approval. Never reuse the old
  plan ID.
- `INSUFFICIENT_FUNDS` — report the shortfall; do not work around it.
- **`broadcast: true` on any error — stop.** A transaction may already be onchain.
  Give the human the transaction hash if you have one and tell them to reconcile
  it and the sender's nonce before anything else. Never retry: a retry can create
  a second token.

## Things that are never yours to do

- Do not put a private key, seed phrase, or RPC credential into a command
  argument, a plan file, a log, or your own output. Nexus reads credentials from
  the environment only.
- Do not edit a plan file by hand. Prepare a new one.
- Do not present Nexus, Flap, or Pons as audited. They are not.
- Do not describe a token launch as an investment, and do not predict what a
  token will be worth. Launches are permanent and can lose all value.
