import assert from "node:assert/strict";
import process from "node:process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Verifies the MCP server starts, advertises its tools, and — the assertion that
 * matters — exposes nothing that can broadcast a transaction. Execution stays a
 * human action.
 */

const BROADCASTING = /^(execute|serve|send|broadcast|sign|launch_token|submit)/u;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/mcp.js"],
});
const client = new Client({ name: "nexus-mcp-smoke", version: "0.1.0" });

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "get_execution_instructions",
    "list_adapters",
    "prepare_launch",
    "simulate_launch",
    "upload_flap_metadata",
    "verify_launch",
  ]);

  for (const name of names) {
    assert.ok(!BROADCASTING.test(name), `MCP tool ${name} looks like it can broadcast.`);
  }
  for (const tool of tools) {
    assert.ok(
      typeof tool.description === "string" && tool.description.length > 0,
      `MCP tool ${tool.name} has no description.`,
    );
  }

  const adapters = await client.callTool({ name: "list_adapters", arguments: {} });
  const listed = JSON.parse(adapters.content[0].text);
  assert.deepEqual(
    listed.map((adapter) => adapter.id).sort(),
    ["flap-standard", "pons", "pons-v2", "pump-fun"],
  );

  const missingPlan = await client.callTool({
    name: "simulate_launch",
    arguments: { plan: "./does-not-exist.plan.json" },
  });
  assert.equal(missingPlan.isError, true);
  assert.equal(JSON.parse(missingPlan.content[0].text).code, "INVALID_PLAN");

  process.stdout.write(`MCP smoke test passed (${names.length} tools, none can broadcast).\n`);
} finally {
  await client.close().catch(() => undefined);
}
