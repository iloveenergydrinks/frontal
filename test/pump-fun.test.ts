import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  PUMP_FUN_PROGRAM_DATA,
  PUMP_FUN_PROGRAM_DATA_HASH,
  PUMP_FUN_PROGRAM_ID,
  PUMP_FUN_PROGRAM_UPGRADE_AUTHORITY,
  parsePumpFunLaunchPlan,
  pumpFun,
} from "../src/pump-fun.js";

describe("Pump.fun adapter identity", () => {
  it("pins the official current mainnet program and upgrade authority", () => {
    expect(PUMP_FUN_PROGRAM_ID).toBe("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    expect(PUMP_FUN_PROGRAM_DATA).toBe("B5MvUwXdiW1NMM6QFFD3ssPKBujD4zMohncbM73Z2BQu");
    expect(PUMP_FUN_PROGRAM_DATA_HASH).toBe(
      "ead956366bbdfc5e06c25deabca92e29f3b2c159f1ef22c5095c9199ac8b5a80",
    );
    expect(PUMP_FUN_PROGRAM_UPGRADE_AUTHORITY).toBe("7gZufwwAo17y5kg8FMyJy2phgpvv9RSdzWtdXiWHjFr8");
  });

  it("exposes Pump as a separate Solana bonding-curve adapter", () => {
    const adapter = pumpFun();
    expect(adapter.id).toBe("pump-fun");
    expect(adapter.chainFamily).toBe("solana");
    expect(adapter.cluster).toBe("mainnet-beta");
    expect(adapter.capabilities.pricingModel).toBe("bonding-curve");
    expect(adapter.capabilities.deterministicTokenAddress).toBe(true);
    expect(adapter.capabilities.initialBuy).toBe("unsupported");
  });

  it("rejects an initial buy before touching RPC state", async () => {
    const payer = Keypair.generate().publicKey.toBase58();
    const mint = Keypair.generate().publicKey.toBase58();
    await expect(
      pumpFun().prepare({
        connection: {} as never,
        creator: payer,
        launch: { initialBuy: "1", metadataUri: "https://example.com/token.json", mint },
        payer,
        token: { name: "Nexus", symbol: "NXS" },
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });

  it("enforces Pump's UTF-8 name limit before touching RPC state", async () => {
    const payer = Keypair.generate().publicKey.toBase58();
    const mint = Keypair.generate().publicKey.toBase58();
    await expect(
      pumpFun().prepare({
        connection: {} as never,
        creator: payer,
        launch: { metadataUri: "https://example.com/token.json", mint },
        payer,
        token: { name: "x".repeat(33), symbol: "X" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_TOKEN_METADATA" });
  });

  it("returns a stable INVALID_PLAN error for malformed JSON objects", () => {
    expect(() => parsePumpFunLaunchPlan('{"id":"0x00","adapter":{"id":"pump-fun"}}')).toThrowError(
      expect.objectContaining({ code: "INVALID_PLAN" }),
    );
  });
});
