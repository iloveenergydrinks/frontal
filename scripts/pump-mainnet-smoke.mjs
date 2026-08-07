import { GLOBAL_PDA, PUMP_SDK } from "@pump-fun/pump-sdk";
import { Connection, Keypair } from "@solana/web3.js";

import { pumpFun } from "../dist/pump-fun.js";

const connection = new Connection(
  process.env.NEXUS_SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  "confirmed",
);
const globalInfo = await connection.getAccountInfo(GLOBAL_PDA, "confirmed");
if (globalInfo === null) throw new Error("Pump global account is unavailable.");
const payer = PUMP_SDK.decodeGlobal(globalInfo).feeRecipient.toBase58();
const mintSigner = Keypair.generate();
const adapter = pumpFun();
const plan = await adapter.prepare({
  connection,
  payer,
  creator: payer,
  token: { name: "Nexus Read-Only Probe", symbol: "NXPROBE" },
  launch: {
    mint: mintSigner.publicKey.toBase58(),
    metadataUri: "https://example.com/nexus-read-only-probe.json",
  },
});
const simulation = await adapter.simulate(connection, plan);
if (!simulation.passed || simulation.logs.length === 0) {
  throw new Error("Pump mainnet simulation did not return a successful execution trace.");
}
process.stdout.write(
  `Pump mainnet read-only smoke passed at slot ${simulation.slot} (${simulation.unitsConsumed} compute units).\n`,
);
