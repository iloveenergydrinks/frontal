import { describe, expect, it } from "vitest";

import {
  PONS_FACTORY,
  PONS_FACTORY_RUNTIME_HASH,
  PONS_LEGACY_FACTORY,
  PONS_LOCKER,
  pons,
} from "../src/pons.js";

/**
 * Pons was first integrated against a deployment that is not the protocol's
 * documented active factory. These assertions pin the reviewed identity so a
 * retarget has to be deliberate.
 */
describe("pons deployment identity", () => {
  it("targets the documented active factory and locker", () => {
    expect(PONS_FACTORY).toBe("0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB");
    expect(PONS_LOCKER).toBe("0x736D76699C26D0d966744cAe304C000d471f7F35");
    expect(PONS_FACTORY_RUNTIME_HASH).toBe(
      "0x0a62b8ed1d88d30c7b342ea8361dfaf0ac336706992cf0c8ba38b129f06391d4",
    );
  });

  it("never uses the superseded deployment as a launch target", () => {
    expect(PONS_LEGACY_FACTORY).not.toBe(PONS_FACTORY);
  });

  it("describes the live launch model", () => {
    const adapter = pons();
    expect(adapter.id).toBe("pons");
    expect(adapter.chainId).toBe(4663);
    expect(adapter.capabilities.pricingModel).toBe("fixed-liquidity");
    expect(adapter.capabilities.deterministicTokenAddress).toBe(true);
    expect(adapter.capabilities.initialBuy).toBe("unsupported");
  });

  it("rejects the V1 router's unprotected atomic initial buy", async () => {
    await expect(
      pons().prepare({
        account: "0x0731dD4Aad7B14363fc2e77ff934646e809A46D8",
        blockHash: `0x${"11".repeat(32)}`,
        blockNumber: 1n,
        launch: { initialBuy: 1n },
        publicClient: {} as never,
        token: {
          description: "",
          image: "",
          name: "Nexus",
          socials: { discord: "", farcaster: "", telegram: "", twitter: "", website: "" },
          symbol: "NXS",
        },
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });
});
