import { describe, expect, it } from "vitest";

import {
  PONS_V2_FACTORY,
  PONS_V2_FACTORY_RUNTIME_HASH,
  PONS_V2_LAUNCH_DEPLOYER,
  PONS_V2_LAUNCH_DEPLOYER_RUNTIME_HASH,
  PONS_V2_LOCKER,
  ponsV2,
} from "../src/pons-v2.js";

describe("Pons V2 deployment identity", () => {
  it("pins the current factory, CREATE2 deployer, and permanent locker", () => {
    expect(PONS_V2_FACTORY).toBe("0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");
    expect(PONS_V2_FACTORY_RUNTIME_HASH).toBe(
      "0x89a27da6f703e0a7cdd4f233e7cb57604ff75b164530962d3ff7cf8483a67d84",
    );
    expect(PONS_V2_LAUNCH_DEPLOYER).toBe("0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42");
    expect(PONS_V2_LAUNCH_DEPLOYER_RUNTIME_HASH).toBe(
      "0xeade22566c766377f6adfb99534f2772251efad9568642c0704a7051418e624c",
    );
    expect(PONS_V2_LOCKER).toBe("0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952");
  });

  it("exposes V2 as a separate deterministic bonding-curve adapter", () => {
    const adapter = ponsV2();
    expect(adapter.id).toBe("pons-v2");
    expect(adapter.chainId).toBe(4663);
    expect(adapter.capabilities.pricingModel).toBe("bonding-curve");
    expect(adapter.capabilities.deterministicTokenAddress).toBe(true);
    expect(adapter.capabilities.initialBuy).toBe("unsupported");
    expect(adapter.capabilities.taxToken).toBe(true);
  });
});
