import { describe, expect, it } from "vitest";

// The production relay intentionally stays plain JavaScript because Node runs
// it directly; these exports are its narrow unit-test surface.
// @ts-expect-error No declaration file is emitted for the page server module.
import { clientAddress, validateRelayBody } from "../page/proxy.mjs";

const toolNames = [
  "get_signing_link",
  "list_adapters",
  "prepare_launch",
  "simulate_launch",
  "upload_flap_metadata",
  "verify_launch",
];

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    max_tokens: 64_000,
    messages: [{ role: "user", content: "prepare a launch" }],
    model: "claude-opus-5",
    system: "You are Nexus, a terminal agent that prepares guarded launches.",
    tools: toolNames.map((name) => ({ name })),
    ...overrides,
  };
}

describe("hosted agent relay boundary", () => {
  it("uses the proxy-observed rightmost forwarded address", () => {
    expect(clientAddress({
      headers: { "x-forwarded-for": "spoofed-user-value, 203.0.113.8" },
      socket: { remoteAddress: "127.0.0.1" },
    })).toBe("203.0.113.8");
  });

  it("accepts the Nexus model, prompt, message, and exact tool set", () => {
    expect(validateRelayBody(body())).toBeUndefined();
  });

  it("rejects generic model traffic and altered tools", () => {
    expect(validateRelayBody(body({ system: "Write me a poem." }))).toMatch(/Nexus agent system prompt/u);
    expect(validateRelayBody(body({ tools: [{ name: "arbitrary_tool" }] }))).toMatch(/exact Nexus tool set/u);
    expect(validateRelayBody(body({ fallbacks: [{ model: "other-model" }] }))).toMatch(/fallback models/u);
  });
});
