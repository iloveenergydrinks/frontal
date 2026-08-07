# Nexus — Product and Developer-UX Validation Brief

> Implementation status (2026-08-06): accepted scope is implemented as `clinexus` with `nexus` / `clinexus` / `nexus-mcp` executables. Flap Standard and Pons both pass live read-only mainnet simulation and full fork execution. No production token has been broadcast.
>
> Correction (2026-08-06): the first Pons integration targeted `0x7E1EAbd52Ae29598e6483F72dCf1a70b14284dB8`, a deployment that is not the protocol's documented active factory, has never had launches enabled, and exposes a bonding-curve interface the live protocol does not use. It was mistaken for a launch-permission problem. The adapter now targets the documented active factory `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` (start block `8991118`), where launching is permissionless. The section 4 protocol table below is corrected accordingly.

**Status:** Implemented release-candidate validation document  
**Review date:** 2026-08-06  
**Product:** An npm library for launching tokens through existing EVM launch protocols  
**Initial networks:** BNB Smart Chain (`56`) and Robinhood Chain (`4663`)

This document is the gate before implementation. It defines what Nexus is, what version 0.1 will do, how the developer experience should feel, and the evidence required before release.

For each decision marked **Approval required**, choose one:

- [ ] Accept
- [ ] Change — add the change beside the decision
- [ ] Reject

If a decision is changed, update the affected acceptance criteria before development begins.

---

## 1. Product decision

### Product promise

> Nexus lets an application prepare, simulate, submit, and verify a token launch through supported EVM launch protocols using one typed TypeScript API.

Nexus is an integration layer over existing launch protocols. It is not another launchpad, exchange, wallet, indexer, or hosted backend.

### Recommended version 0.1

Ship one open-source TypeScript package with:

1. Flap standard-token launches on BNB Smart Chain.
2. Pons launches on Robinhood Chain.
3. A protocol-adapter interface that does not pretend the protocols have identical economics.
4. Signer-free transaction planning, pre-send simulation, injected-wallet execution, and receipt verification.
5. Capability discovery so applications can render only the controls supported by the selected protocol.
6. A thin agent-friendly terminal interface over the same library.

Do not include custom smart contracts, a hosted API, database, token explorer, trading terminal, private-key handling, or a Pools adapter in version 0.1.

**Approval required — product direction**

- [ ] Accept
- [ ] Change:
- [ ] Reject

---

## 2. Target users and jobs

### Primary users

1. **Dapp developers** adding token launch flows to a website or wallet.
2. **Agent and automation developers** that need deterministic JSON-compatible plans before asking a human or policy engine to sign.
3. **Protocol integrators** that want one interface across Flap and Pons without losing protocol-specific controls.

End users interact with products built on Nexus; they are not expected to call the package directly.

### Jobs to be done

- “Show me which launch venues support this chain and token configuration.”
- “Tell me the exact factory, fees, economics, calldata, and native value before I sign.”
- “Prove the launch will simulate successfully against current chain state.”
- “Let my existing wallet sign the exact transaction.”
- “Return the canonical token address and verify that it came from the expected factory.”
- “Give me a clear, typed failure when the network, protocol version, deployment, configuration, or transaction is wrong.”

### Product success metric

A TypeScript developer starting from an empty project should be able to produce a valid, simulated launch plan on a test environment or fork in **under 15 minutes**, without reading protocol contract source or manually encoding calldata.

**Approval required — users and success metric**

- [ ] Accept
- [ ] Change:
- [ ] Reject

---

## 3. Scope

### In version 0.1

- TypeScript-first API with complete exported types.
- ESM and modern Node/browser bundler support.
- A `nexus` executable with structured `--json` output for terminal agents.
- `viem` clients supplied by the caller.
- Chain and account validation.
- Adapter capability discovery.
- Protocol-specific input validation.
- Metadata normalization and validation.
- Signer-free launch preparation.
- Human-readable launch summary.
- Stable canonical serialization and plan ID.
- Current deployment and runtime-code verification.
- Current protocol economics/configuration reads.
- `eth_call` simulation immediately before send.
- Execution through an injected `WalletClient`.
- Transaction receipt parsing and launch verification.
- Structured errors with stable error codes and recovery guidance.
- Big integers represented safely in JSON output.

### Explicitly not in version 0.1

- Nexus-owned launcher contracts or liquidity contracts.
- Custody of keys, seed phrases, or user funds.
- A relayer, hosted signer, or account-abstraction service.
- Token discovery, charts, trading, portfolio, indexing, or social profiles.
- A graphical launchpad.
- Cross-chain bridging.
- Tax/vault Flap token variants.
- The superseded Pons deployment as a launch target.
- Pools integration before an official, stable developer surface exists.
- Metadata pinning as a Nexus-hosted service.
- Automatic transaction retries.

**Approval required — version 0.1 boundary**

- [ ] Accept
- [ ] Change:
- [ ] Reject

---

## 4. Protocol support decision

| Adapter | Chain | Launch model | v0.1 status | Rationale |
|---|---:|---|---|---|
| `flapStandard` | BNB `56` | Bonding curve followed by protocol-defined DEX migration | Build | Flap exposes a documented Portal integration surface. Limit the first adapter to standard tokens. |
| `pons` | Robinhood `4663` | Fixed supply seeded as one-sided Uniswap V3 liquidity, locked at launch | Build | Pons publishes verified source, deployment addresses, and events. Read the selected launch and DEX configuration live. |
| `pons` legacy | Robinhood `4663` | Same model, superseded deployment | Read-only | Kept resolvable for historical launches. Nexus never prepares a new launch against it. |
| `pools` | Robinhood `4663` | Current product labels include Crowd Launch | Blocked | The public product is in beta and no stable public contract registry, ABI, or SDK was identified. Do not productionize a reverse-engineered frontend integration. |

Protocol support is defined by an exact chain, deployment address, protocol version, and verified runtime code—not by a brand name alone.

### Pools unblock conditions

The Pools adapter can enter development only when all of the following exist:

- [ ] Official public developer documentation or an explicitly supported SDK.
- [ ] Canonical production contract addresses and ABIs.
- [ ] Documented launch transaction semantics and value/fee calculations.
- [ ] Documented events sufficient to verify the resulting token and market.
- [ ] Clear integration terms for third-party applications.
- [ ] A stable test method that does not rely on private frontend endpoints.

**Approval required — protocol order**

- [ ] Accept
- [ ] Change:
- [ ] Reject

---

## 5. API and package design

### Package shape

Start with one package and subpath exports:

```text
clinexus
clinexus/flap
clinexus/pons
clinexus/chains
clinexus/mcp
nexus                         # executable exposed by the package
```

The final npm scope/name is subject to registry availability. Do not split into multiple independently versioned packages until package size or release cadence proves that necessary.

Use `viem` as a peer dependency. The caller supplies `PublicClient`, `WalletClient`, and account; Nexus never creates a wallet from a raw private key.

The package executable is a thin shell over the same exported functions. It must not maintain a second launch implementation.

### Core workflow

```ts
import { prepareLaunch, simulateLaunch, sendLaunch, verifyLaunch } from "clinexus";
import { pons } from "clinexus/pons";

const plan = await prepareLaunch({
  adapter: pons(),
  publicClient,
  account,
  token: {
    name: "Example",
    symbol: "EXAMPLE",
    image: "ipfs://...",
    description: "Example community token",
  },
  launch: {
    quoteToken: "0x0000000000000000000000000000000000000000",
    creatorFeeRecipient: account,
    creatorTaxBps: 0,
    initialBuy: 10_000_000_000_000_000n,
  },
});

await simulateLaunch({ publicClient, plan });

// The application renders plan.summary and obtains explicit user approval here.
const hash = await sendLaunch({ walletClient, plan });
const result = await verifyLaunch({ publicClient, plan, hash });
```

`sendLaunch` is a thin convenience wrapper around the injected wallet. The transaction remains available as `plan.transaction` for callers that need their own policy, multisig, smart-account, or signing flow.

### Why protocol inputs remain distinct

The common workflow is normalized; protocol economics are not. Each adapter owns a discriminated input type. This avoids a single configuration object with dozens of optional fields that silently mean different things on different venues.

```ts
type LaunchRequest =
  | { adapter: FlapStandardAdapter; launch: FlapStandardLaunchOptions }
  | { adapter: PonsV2Adapter; launch: PonsV2LaunchOptions };
```

### Capability discovery

Every adapter exposes capabilities before a UI is rendered:

```ts
type LaunchCapabilities = {
  pricingModel: "bonding-curve" | "fixed-liquidity";
  deterministicTokenAddress: boolean;
  initialBuy: "unsupported" | "optional" | "required";
  creatorFees: boolean;
  taxToken: boolean;
  metadataStorage: readonly ("ipfs" | "https" | "onchain")[];
};
```

Applications must not infer controls from adapter names or chain IDs.

**Approval required — package and API shape**

- [ ] Accept
- [ ] Change:
- [ ] Reject

---

## 6. Launch plan contract

`prepareLaunch` returns a complete, serializable review object before any wallet prompt:

```ts
type LaunchPlan = {
  schemaVersion: "1";
  id: `0x${string}`;
  adapter: {
    id: "flap-standard" | "pons-v2";
    version: string;
  };
  chainId: number;
  account: `0x${string}`;
  deployment: {
    address: `0x${string}`;
    runtimeCodeHash: `0x${string}`;
    protocolVersion: string;
  };
  token: NormalizedTokenMetadata;
  economics: Record<string, JsonValue>;
  transaction: {
    to: `0x${string}`;
    data: `0x${string}`;
    value: string;
  };
  expected: {
    token?: `0x${string}`;
    pricingModel: string;
    liquidityVenue: string;
  };
  summary: LaunchSummary;
  warnings: LaunchWarning[];
};
```

The plan ID binds at least:

- Schema and adapter version.
- Chain ID and sender.
- Factory/Portal address and runtime code hash.
- Live protocol configuration and fee/economics values used to encode the launch.
- Normalized token and metadata inputs.
- Exact transaction target, calldata, and native value.
- Initial-buy and slippage fields when supported.

Changing any bound field produces a new plan ID. Volatile simulation output such as gas estimation is reported separately and is not silently treated as a durable promise.

### Required plan summary

Before a wallet prompt, the application must be able to display:

- Network and chain ID.
- Protocol, adapter version, and factory/Portal address.
- Token name, symbol, metadata URI, and expected token address if deterministic.
- Pricing/launch model in plain language.
- Initial buy and minimum output, if any.
- Protocol fees, creator fees/tax, and native value sent.
- Liquidity destination and lock/migration behavior.
- Material warnings and what can change after launch.

**Approval required — exact-plan model**

- [ ] Accept
- [ ] Change:
- [ ] Reject

---

## 7. Developer UX

### UX principles

1. **Plan before prompting.** No wallet opens until the developer can render the exact action.
2. **Safe by default.** Wrong chain, stale deployment, unsupported configuration, or failed simulation stops the flow.
3. **Progressive disclosure.** Common token fields stay common; venue-specific economics appear only after adapter selection.
4. **No false sameness.** Nexus explains differences such as bonding curves, migration, V3/V4 liquidity, taxes, and permanent locks.
5. **Actionable errors.** Every failure says what failed, whether funds were broadcast, and what the caller can safely do next.
6. **No hidden infrastructure.** The package works with the caller's RPC, wallet, metadata store, and application backend.

### State model

```text
draft
  -> prepared
  -> simulated
  -> awaiting-signature
  -> submitted
  -> confirmed
  -> verified
```

Failure behavior:

- `draft` or `prepared`: safe to edit and prepare a new plan.
- `simulated`: re-simulate if current protocol state changes before signing.
- `awaiting-signature`: wallet rejection returns a non-broadcast error and the same plan may be reviewed again.
- `submitted`: never automatically retry; reconcile the hash and account nonce first.
- `confirmed` but unverified: return the receipt and exact failed verification checks. Do not label the launch successful.

### Error contract

```ts
type NexusError = {
  code:
    | "UNSUPPORTED_CHAIN"
    | "UNSUPPORTED_CAPABILITY"
    | "INVALID_TOKEN_METADATA"
    | "DEPLOYMENT_CODE_MISMATCH"
    | "PROTOCOL_CONFIG_CHANGED"
    | "SIMULATION_REVERTED"
    | "WALLET_REJECTED"
    | "TRANSACTION_REVERTED"
    | "RECEIPT_NOT_FOUND"
    | "LAUNCH_VERIFICATION_FAILED";
  message: string;
  recovery?: string;
  broadcast: boolean;
  cause?: unknown;
};
```

Errors must never contain private RPC credentials, signed transactions, or unredacted provider URLs.

### Metadata UX

The core package validates already-hosted metadata and accepts `ipfs://` or HTTPS references according to adapter capabilities. Uploading is a separate optional interface:

```ts
interface MetadataStore {
  upload(metadata: TokenMetadata): Promise<{ uri: string }>;
}
```

Version 0.1 may include a generic interface and test implementation, but it must not force a vendor or operate a Nexus storage service.

### Terminal-agent configuration

For terminal use, Nexus is the application that configures the metadata adapter. Configuration happens once per machine or agent environment; it is not repeated for every launch.

```text
nexus configure metadata
nexus launch prepare \
  --adapter pons \
  --name "Example" \
  --symbol EXAMPLE \
  --image ./example.png \
  --account 0x...
```

The terminal host supplies:

- A local image path, HTTPS image URL, or already-hosted metadata URI.
- An RPC endpoint through configuration or environment.
- A metadata provider selected through a `MetadataStore` adapter.
- A wallet connection or an account address for signer-free preparation.

Recommended storage behavior:

1. Nexus reads the explicitly supplied image; it does not search the filesystem.
2. It validates file type, dimensions, byte size, and content hash.
3. The configured metadata adapter uploads the image, then the token metadata document.
4. Provider credentials come from an environment secret or operating-system keychain. They are never written into a launch plan, shell history, repository, or JSON output.
5. The resulting URI is bound to the launch plan.

The initial adapter should target IPFS-compatible pinning because Flap expects IPFS metadata. Callers may also bypass uploading with an existing supported `ipfs://` URI. An S3-compatible bucket alone is not a universal replacement when a protocol requires an IPFS CID.

There is no reliable zero-configuration upload without somebody operating and paying for storage. If Nexus later promises “just attach an image,” that requires a Nexus-hosted upload service and is a separate product/security decision.

Wallet behavior in a terminal follows the same boundary:

- Preparation and simulation need only an account address.
- Execution can use a caller-injected wallet, WalletConnect, hardware wallet, smart-account provider, or return the unsigned transaction to another signer.
- Nexus does not save raw private keys.
- If the wallet lacks native funds, Nexus returns an exact funding request with protocol value, initial buy, gas estimate, buffer, current balance, and shortfall. The operator funds that address externally and asks Nexus to revalidate.

Agent-facing commands must separate preparation from execution:

```text
nexus launch prepare --json ...
nexus launch simulate --plan <plan-file> --json
nexus launch execute --plan <plan-file> --json
nexus launch verify --plan <plan-file> --tx 0x... --json
```

Execution requires explicit approval of the displayed plan. A terminal agent may automate collection and preparation, but it must not infer approval to spend funds from a conversational request alone.

**Approval required — developer UX and metadata boundary**

- [ ] Accept
- [ ] Change:
- [ ] Reject

---

## 8. Feature acceptance checklist

### Adapter discovery and validation

- [ ] A caller can list adapters supported for chain `56` or `4663`.
- [ ] A caller can inspect capabilities without connecting a wallet.
- [ ] Selecting an adapter on the wrong chain fails before calldata is built.
- [ ] Unsupported fields fail explicitly; they are never ignored.
- [ ] Adapter deployment addresses and versions are inspectable.

### Planning

- [ ] A caller can prepare a plan with only a public client and account address.
- [ ] Preparation performs no write and opens no wallet.
- [ ] Identical normalized inputs and chain state produce the same plan ID.
- [ ] The plan contains exact calldata, target, value, economics, and disclosures.
- [ ] All big integers serialize as decimal strings in JSON views.
- [ ] Token metadata rejects control characters, deceptive invisible characters, invalid URLs, and adapter-specific size/format violations.

### Protocol integrity

- [ ] The adapter verifies runtime bytecode at the selected factory/Portal.
- [ ] A changed or missing deployment fails closed.
- [ ] Mutable launch economics are read from chain and bound to the plan.
- [ ] A relevant config change between preparation and execution forces a new plan.
- [ ] No curve, fee, launch configuration, or migration threshold is silently hardcoded when the protocol exposes it onchain.

### Simulation and execution

- [ ] The exact transaction simulates successfully immediately before send.
- [ ] A revert is decoded into a protocol-aware error when possible.
- [ ] Wallet rejection is distinguishable from an onchain revert.
- [ ] Execution works with browser wallets and externally managed `WalletClient` accounts.
- [ ] The package never accepts a seed phrase or raw private key.
- [ ] No ambiguous submitted transaction is automatically retried.

### Verification

- [ ] Nexus waits for the caller-selected confirmation policy.
- [ ] It verifies receipt status and expected transaction target.
- [ ] It decodes the canonical protocol launch event.
- [ ] It verifies the resulting token belongs to the expected factory/Portal launch.
- [ ] It returns token address, transaction hash, block, protocol identity, and available market/liquidity identity.
- [ ] Missing, conflicting, or malformed events fail verification.

### Package quality

- [ ] Types work under TypeScript strict mode.
- [ ] Package works in current supported Node LTS and Vite-based browser builds.
- [ ] Package publishes ESM with an explicit exports map and source maps.
- [ ] Importing one adapter does not bundle all adapters.
- [ ] No install script, telemetry, or network request runs on package import.
- [ ] Public functions have runnable examples and API reference documentation.
- [ ] Release artifacts are reproducible and npm provenance is enabled.

---

## 9. Protocol-specific acceptance

### Flap standard adapter

- [ ] Uses the official BNB Portal integration surface.
- [ ] Pins an adapter-supported deployment/version and verifies runtime code.
- [ ] Reads current token/curve/migration parameters from chain where exposed.
- [ ] Supports only the standard token path in version 0.1.
- [ ] Rejects tax-token and vault options with `UNSUPPORTED_CAPABILITY`.
- [ ] Produces the metadata form/URI expected by the live protocol.
- [ ] Parses the protocol's canonical token-creation event.
- [ ] Explains the bonding-curve and migration behavior in the plan summary.
- [ ] Uses a provider capable of the required reads; BNB public endpoints with restricted methods are not assumed to be archival/indexing providers.

### Pons adapter

- [ ] Uses the deployment the protocol documents as active, verified by address and runtime code, and never the superseded deployment.
- [ ] Reads and validates the selected live launch configuration and DEX configuration, including that both are enabled.
- [ ] Binds the launch fee, locker, pair token, supply, graduation threshold, launch-block restrictions, and the runtime code of the pool factory, position manager, and swap router to the plan.
- [ ] Commits the protocol's own `predictTokenAddress` result and rejects a salt whose token address or pool already exists.
- [ ] Explains fixed supply, one-sided liquidity, the locked position, and that no migration occurs.
- [ ] Treats the atomic creator buy as opt-in and warns that the protocol executes it with no minimum output.
- [ ] Verifies the emitted token, pool, position, factory launch record, onchain token metadata, and that the locker holds the position.
- [ ] Detects factory deployment or runtime-code changes before send.

### Deployment-identity decision

Protocol support is defined by an exact chain, deployment address, and verified runtime code. A brand name, a repository, or an interface that merely looks like the protocol is not sufficient evidence that a contract is the live deployment.

- [ ] Before an adapter is built, confirm the target address against the protocol's own published integration documentation and confirm it is transacting.

---

## 10. UX validation sessions

Run these sessions against a local fork, protocol-supported test environment, or non-broadcast simulation. Do not use mainnet funds for UX research.

### Session A — first integration

Give a TypeScript developer only the README and a blank Vite or Node project.

Tasks:

1. Install Nexus and `viem`.
2. List adapters for a chosen chain.
3. Prepare a launch plan.
4. Explain from the returned object what will happen and how much native value is required.
5. Simulate the transaction.

Pass conditions:

- [ ] Completed in under 15 minutes.
- [ ] No contract source or block explorer was needed.
- [ ] No private key was copied into code.
- [ ] The developer correctly explains the pricing model and liquidity outcome.
- [ ] Any confusion is captured as an API or documentation issue, not dismissed as user error.

### Session A2 — first terminal launch plan

Give an agent or operator the Nexus executable, a funded account address, an RPC configuration, metadata-provider credentials, and a local image.

Pass conditions:

- [ ] The image and metadata are uploaded without exposing provider credentials.
- [ ] The command returns structured JSON containing the metadata URI, exact funding requirement, plan ID, and transaction.
- [ ] Preparation opens no wallet and broadcasts nothing.
- [ ] An insufficient balance returns the exact asset, address, and shortfall.
- [ ] A separate execute command requires explicit approval and re-simulation.

### Session B — venue comparison

Ask a developer to compare Flap on BNB with Pons V2 on Robinhood Chain.

Pass conditions:

- [ ] Common token fields feel consistent.
- [ ] Protocol-specific fields are visibly different and understandable.
- [ ] The developer can identify chain, factory, fees, pricing model, and migration/liquidity behavior for both.
- [ ] The interface does not suggest that economics are interchangeable.

### Session C — failure recovery

Introduce one case at a time:

- Wrong chain.
- Invalid metadata.
- Unsupported tax option.
- Changed protocol configuration.
- Simulation revert.
- Wallet rejection.
- Submitted transaction that cannot yet be found.
- Confirmed receipt with an unexpected event.

Pass conditions:

- [ ] The developer knows whether anything was broadcast.
- [ ] The error identifies the failed stage.
- [ ] Recovery guidance is safe and specific.
- [ ] No case encourages blind resubmission.

### Session D — application UI handoff

Give a frontend developer only `LaunchCapabilities`, `LaunchPlan.summary`, and the adapter-specific input types.

Pass conditions:

- [ ] They can render the form without hardcoding protocol names.
- [ ] They can render a complete review screen before the wallet prompt.
- [ ] Unsupported controls are absent, not disabled without explanation.
- [ ] Warnings and costs fit without parsing calldata or raw logs.

---

## 11. Required test scenarios before release

Each adapter needs fixture-based unit tests and fork integration tests for:

1. Valid minimum launch.
2. Valid launch with every supported optional capability.
3. Wrong chain and wrong account.
4. Invalid name, symbol, image, URI, and description.
5. Unsupported protocol-specific option.
6. Missing deployment code and mismatched runtime hash.
7. Protocol configuration drift after plan creation.
8. Simulation revert with decoded and unknown revert data.
9. Wallet rejection before broadcast.
10. Reverted receipt.
11. Successful receipt with correct launch event.
12. Successful-looking receipt with missing or conflicting launch event.
13. JSON serialization round trip of a plan.
14. Browser and Node package smoke tests.
15. No side effects when importing the package.

No integration test may broadcast to BNB mainnet or Robinhood Chain mainnet.

---

## 12. Security and trust boundaries

Nexus reduces integration mistakes; it does not make an external protocol safe.

Required controls:

- Unsigned transaction plan by default.
- Exact deployment address and runtime-code verification.
- Live economics/config reads rather than stale documentation constants.
- Immediate pre-send simulation of the unchanged transaction.
- Explicit slippage/minimum-output protection for any supported initial buy.
- Receipt and event verification tied to the selected adapter deployment.
- No secret handling, relaying, custody, or automatic retries.
- Dependency lock, release provenance, two-person npm release control, and documented compromised-release response.

Required documentation language:

- Nexus is not an auditor and does not guarantee the external protocol.
- Token launches and purchases can lose all value.
- Protocol fees and behavior can change according to each protocol's governance/control model.
- Applications are responsible for legal, sanctions, consumer-protection, and jurisdictional review.

---

## 13. Risks and stop conditions

| Risk | Mitigation | Stop condition |
|---|---|---|
| Protocol upgrades invalidate encoding or verification | Pin deployment/version/runtime hash; read current config | Runtime or ABI behavior differs from the reviewed adapter |
| A generic API hides economic differences | Discriminated adapter inputs and explicit summaries | A required protocol field cannot be represented without ambiguous semantics |
| Pools integration relies on reverse engineering | Wait for official developer surface | No canonical ABI/address/event documentation |
| Metadata availability is mistaken for launch success | Keep storage external and return metadata URI separately | Required metadata cannot be durably hosted by the caller |
| RPC limitations break planning or verification | Document required methods; test provider behavior | Provider cannot perform required current-state reads or receipt/log calls |
| npm compromise exposes downstream users | Provenance, protected publishing, minimal dependencies | Release process lacks independent control and recoverability |
| Mainnet-only testing risks funds | Fork tests and explicit non-broadcast harness | A test path can sign or broadcast to production networks |

---

## 14. Final decisions to record

Complete this table before implementation begins.

| Decision | Recommendation | Final choice |
|---|---|---|
| Product boundary | Launch integration SDK only | Launch SDK and thin terminal CLI |
| v0.1 adapters | Flap standard + Pons V2 | Flap Standard + Pons V2 |
| Superseded Pons deployment | Read-only; never a launch target | Recorded |
| Pools | Block until official integration surface | Deferred |
| Package structure | One package with subpath exports | `clinexus` with core, chain, Flap, Pons, Node metadata, and MCP subpaths |
| Terminal interface | Thin `nexus` executable over the library, with stable JSON output | `nexus`, `clinexus`, and `nexus-mcp` binaries |
| Web3 dependency | Caller-supplied `viem` clients | `viem` peer dependency |
| Signing | Injected wallet only; no keys | SDK `WalletClient`; CLI WalletConnect |
| Send helper | Thin optional wrapper; raw transaction always exposed | Implemented |
| Metadata hosting | External interface; no Nexus service | Flap official IPFS helper; URI passthrough for Pons |
| Default metadata adapter | IPFS-compatible provider configured once by the terminal operator | Explicit `metadata flap-upload` command |
| Deployment integrity | Address + runtime hash + live config pinned to plan | Implemented with critical dependency hashes |
| Automatic retry | Never after broadcast | Implemented |
| License | Decide before package publication | MIT |
| npm name/scope | Verify availability before scaffolding | `clinexus` available; `nexus-cli` and `cli-nexus` unavailable |

Reviewer: Product owner  
Decision date: 2026-08-06  
Outcome: **GO for release-candidate validation; production writes still require exact plan-ID approval**

---

## 15. Go/no-go gate

Development may start when:

- [ ] Sections 1–7 are accepted or updated.
- [ ] Protocol order is approved.
- [ ] The final-decision table is complete.
- [ ] At least one official source for each v0.1 protocol's ABI, deployment, and events is archived or pinned for implementation.

Version 0.1 may publish when:

- [ ] Every feature-acceptance item in scope passes.
- [ ] All four UX sessions pass or have explicitly accepted findings.
- [ ] Required unit, fork, packaging, and no-broadcast tests pass.
- [ ] Security/trust-boundary documentation is present.
- [ ] A clean-room developer meets the first-plan time target.
- [ ] npm ownership, provenance, versioning, license, and incident response are documented.

Any failed integrity, simulation, verification, secret-handling, or production-broadcast control is a release blocker—not a warning.

---

## 16. Research references

These are discovery references, not substitutes for pinning exact source, ABI, deployment, and runtime code during implementation.

- Robinhood Chain overview: <https://docs.robinhood.com/chain>
- BNB Smart Chain documentation: <https://docs.bnbchain.org/bnb-smart-chain/>
- Flap documentation: <https://docs.flap.sh/>
- Flap BNB contracts: <https://docs.flap.sh/technical-documentation/smart-contracts/bnb-smart-chain>
- Pons source and deployments: <https://github.com/ponsdotdev/ponsfamily>
- Pons launchpad: <https://www.ponsfamily.com/launchpad>
- Pools product: <https://pools.trade/>
