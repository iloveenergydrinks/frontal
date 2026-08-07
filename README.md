# Nexus

Nexus is an agent-friendly TypeScript library and terminal CLI for guarded token launches on EVM chains. Version 0.1 supports:

- Flap Standard on BNB Smart Chain (`56`).
- Pons V2 on Robinhood Chain (`4663`).

It prepares a content-addressed launch plan before opening a wallet, rebuilds that plan from live protocol state before every simulation and send, estimates exact funding, and verifies the resulting receipt and protocol event. Nexus never accepts or stores a seed phrase or private key.

> Token launches are permanent and can lose all value. Nexus is not an audit of Flap or Pons. Each protocol remains externally controlled and may change or upgrade.

## Status

This repository is a `0.1.0` release candidate. The package name reserved for publication is `nexus-launch`; both installed executables are available as `nexus` and `nexus-cli`. `nexus-cli` itself is occupied on npm by an unrelated package.

The BNB adapter currently passes read-only mainnet simulation and full fork execution/verification. The Robinhood adapter passes full fork execution/verification, but the live Pons V2 factory currently has public launches disabled and the configured Robinhood wallet is not whitelisted. Nexus fails closed until either condition changes.

## Install

Requirements: Node.js `20.19` or newer.

```bash
npm install nexus-launch viem
```

Run the CLI without installing globally:

```bash
npx nexus-launch --json adapters
```

No install script, telemetry, wallet connection, or network request runs when the SDK is imported.

## Terminal configuration

Nexus reads RPC and WalletConnect configuration from the environment. Never put credentials or private keys in command arguments or plan files.

```bash
export NEXUS_BNB_RPC_URL='https://your-bnb-rpc.example'
export NEXUS_RH_RPC_URL='https://your-robinhood-rpc.example'
export NEXUS_WALLETCONNECT_PROJECT_ID='your-walletconnect-project-id'
```

The public chain defaults are sufficient for basic planning when they are healthy. A WalletConnect project ID is required only by `launch execute`.

## CLI workflow

Every agent-facing command supports `--json`. Success and errors use stable envelopes:

```json
{"schemaVersion":"1.0","ok":true,"data":{}}
```

```json
{"schemaVersion":"1.0","ok":false,"error":{"name":"NexusError","code":"INVALID_PLAN","message":"...","broadcast":false}}
```

### 1. Inspect adapters

```bash
nexus --json adapters
```

### 2. Upload Flap profile metadata

Flap expects IPFS metadata. The Node-only uploader validates a PNG is exactly `512x512`, no larger than 10 MiB, uploads through Flap's official service, and reads the result back from its gateway.

```bash
nexus --json metadata flap-upload \
  --creator 0xYourBnbWallet \
  --image ./profile.png \
  --description 'A transparent project description.' \
  --website https://example.com
```

The result contains both the metadata CID required by Flap and the image URI that can be reused by Pons. Uploading metadata does not create a token or open a wallet.

### 3. Prepare and save a plan

Flap Standard:

```bash
nexus --json launch prepare \
  --adapter flap-standard \
  --account 0xYourBnbWallet \
  --name 'Example' \
  --symbol EXAMPLE \
  --description 'No promised utility.' \
  --website https://example.com \
  --metadata-cid bafy... \
  --out ./flap-plan.json
```

Pons V2:

```bash
nexus --json launch prepare \
  --adapter pons-v2 \
  --account 0xYourRobinhoodWallet \
  --name 'Example' \
  --symbol EXAMPLE \
  --description 'No promised utility.' \
  --image ipfs://bafy... \
  --website https://example.com \
  --creator-fee-recipient 0xYourRobinhoodWallet \
  --creator-tax-bps 0 \
  --launch-config-id 0 \
  --out ./pons-plan.json
```

Preparation is signer-free and cannot broadcast. Existing files are not overwritten unless `--force` is explicit. Plans are written with mode `0600`.

### 4. Simulate and review

```bash
nexus --json launch simulate --plan ./flap-plan.json
```

Review at least:

- Exact plan ID, chain, account, protocol address, implementation, and runtime hashes.
- Token name, symbol, profile URI, predicted token address when available.
- Exact transaction target, calldata, and native value.
- Pricing model, migration/liquidity behavior, fees, taxes, and warnings.
- Gas estimate, 20% gas buffer, wallet balance, and shortfall.

Any deployment, live configuration, salt state, transaction, metadata, or review-field change requires a new plan ID.

### 5. Execute one exact plan

For a desktop browser wallet, serve the approved plan on loopback:

```bash
nexus --json launch serve \
  --plan ./flap-plan.json \
  --approve 0xExactPlanId
```

Open the returned `http://127.0.0.1:4173` URL in the browser that contains the exact approved wallet. The local server re-simulates and verifies; the injected wallet broadcasts directly. The server binds only to loopback and protects write endpoints with same-origin and per-process CSRF checks.

For a mobile wallet or QR flow, use WalletConnect:

```bash
nexus --json launch execute \
  --plan ./flap-plan.json \
  --approve 0xExactPlanId
```

Execution:

1. Verifies the supplied approval equals the saved plan ID.
2. Reconstructs every committed field from current protocol state.
3. Simulates the exact transaction and checks funding again.
4. Opens WalletConnect and requires the exact planned account on the exact chain.
5. Broadcasts once, waits for a receipt, and verifies sender, target, calldata, value, block, canonical protocol event, and deployed code.

Nexus never retries after a possible broadcast. If submission or verification becomes ambiguous, it returns `broadcast:true` and the known transaction hash when available. Reconcile that hash and sender nonce before doing anything else.

Receipt verification is pinned to the canonical receipt block. Some public BNB RPCs prune historical contract state; when that is the only unavailable check, Flap verification additionally pins a current block, verifies the exact immutable minimal-proxy runtime and token metadata there, rechecks that block hash, and returns `stateVerification.mode: "current-fallback"`. Use an archive-capable RPC when receipt-block state verification is required.

### 6. Verify an existing transaction

```bash
nexus --json launch verify \
  --plan ./flap-plan.json \
  --tx 0xTransactionHash
```

## SDK

The core SDK uses caller-supplied `viem` clients and is browser-compatible. Filesystem metadata upload is isolated in `nexus-launch/flap-metadata`; the WalletConnect dependency is isolated in the CLI.

```ts
import { createPublicClient, http } from "viem";
import { bsc } from "viem/chains";
import { flapStandard } from "nexus-launch/flap";
import { prepareLaunch, simulateLaunch } from "nexus-launch";

const publicClient = createPublicClient({ chain: bsc, transport: http(process.env.BNB_RPC_URL) });
const adapter = flapStandard();

const plan = await prepareLaunch({
  account: "0x...",
  adapter,
  publicClient,
  token: {
    name: "Example",
    symbol: "EXAMPLE",
    description: "No promised utility.",
    socials: { website: "https://example.com" },
  },
  launch: { metadataCid: "bafy...", initialBuy: 0 },
});

const simulation = await simulateLaunch({ adapter, plan, publicClient });
```

The unsigned transaction is always available as `plan.transaction`. Applications can inject their own `WalletClient` into `sendLaunch`; they do not need to use the Nexus CLI.

Node-only Flap metadata upload:

```ts
import { uploadFlapMetadata } from "nexus-launch/flap-metadata";
```

## Protocol behavior

### Flap Standard

- Calls the live BNB Portal `newTokenV7` standard-token route.
- Creates a deterministic `8888`-suffix Token V3 address.
- Uses the live native-BNB quote configuration, 80% DEX threshold, and PancakeSwap Infinity CL migration path.
- The currently live-compatible standard configuration directs distributable fees to eligible token holders in native BNB with a 10,000-token threshold. It does not direct those fees to a creator marketing wallet.
- Embedded initial buy is disabled because the protocol call has no minimum-output field.
- Nexus pins the Portal proxy, implementation, token implementation, launch facets, Multi-DEX router, PCS migrator, protocol version, quote configuration, salt lock, and runtime hashes.

### Pons V2

- Calls the live Robinhood Chain V2 factory.
- Reads and binds the selected launch configuration, launch fee, creator-tax ceiling, public/whitelist gate, and economics digest.
- Uses the Pons constant-product bonding curve and protocol-defined graduation into permanently locked full-range Uniswap V4 liquidity.
- Creator tax and buyback are explicit adapter options; initial buy is not part of `launchToken`.
- Live production preparation is unavailable while public launch is disabled and the exact account is not whitelisted.

## Metadata and funding

Nexus reads only the image path explicitly supplied by the operator. It does not search the filesystem, generate a profile automatically, bridge assets, fund wallets, or custody gas. After simulation, `funding` reports the exact chain asset, account, balance, transaction value, estimated gas, buffer, total requirement, and shortfall. Funding happens externally and the unchanged plan must be simulated again.

## Security model

- Plans use canonical JSON and a `keccak256` content ID; all big integers are decimal strings.
- A valid content hash alone is not trusted. Simulation reconstructs the adapter output and compares all deployment, request, snapshot, summary, warning, expected-output, target, data, and value fields.
- Latest-state reads are pinned to a block number/hash and checked again after state collection.
- Runtime bytecode and upgrade implementation identities are fail-closed constants for the reviewed adapter version.
- Every send performs an immediate exact reconstruction and simulation.
- Verification checks the full mined transaction and canonical block before and after adapter-specific receipt checks.
- Private keys, seed phrases, signed payloads, and RPC URLs do not belong in plans, command arguments, logs, or errors.

External protocols are still trusted dependencies. Their owners, proxies, factories, routers, migrators, liquidity systems, metadata service, and governance remain outside Nexus control.

## Development and verification

```bash
npm run check
npm run test:fork
npm audit --omit=dev
```

`npm run test:fork` starts local Anvil forks, impersonates only public test identities on localhost, and broadcasts exclusively to those local forks. It never signs or sends a mainnet transaction.

The release check performs strict TypeScript validation, unit tests, ESM build, clean tarball installation, executable smoke tests, error-exit checks, and an npm pack manifest review.

See [PRODUCT_VALIDATION.md](./PRODUCT_VALIDATION.md) for the feature and UX acceptance document. The launch plan schema is published at [schemas/launch-plan.schema.json](./schemas/launch-plan.schema.json).

## License

MIT
