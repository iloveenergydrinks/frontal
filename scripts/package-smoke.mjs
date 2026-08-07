import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const project = process.cwd();
const directory = mkdtempSync(join(tmpdir(), "nexus-package-smoke-"));

try {
  const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", directory], {
    cwd: project,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const packed = JSON.parse(packOutput);
  const filename = packed[0]?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not return a tarball filename.");
  execFileSync("npm", ["init", "-y"], { cwd: directory, stdio: "ignore" });
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "viem@2.55.11", join(directory, filename)],
    { cwd: directory, stdio: "ignore" },
  );
  for (const bin of ["nexus", "nexus-launch", "nexus-mcp"]) {
    if (!existsSync(join(directory, "node_modules", ".bin", bin))) {
      throw new Error(`Installed package is missing the ${bin} executable.`);
    }
  }
  const output = execFileSync(join(directory, "node_modules", ".bin", "nexus"), ["--json", "adapters"], {
    cwd: directory,
    encoding: "utf8",
  });
  const envelope = JSON.parse(output);
  if (envelope?.schemaVersion !== "1.0" || envelope?.ok !== true || envelope?.data?.length !== 3) {
    throw new Error(`Installed CLI returned an invalid envelope: ${readFileSync(join(directory, "package.json"), "utf8")}`);
  }
  let failure;
  try {
    execFileSync(
      join(directory, "node_modules", ".bin", "nexus"),
      ["--json", "launch", "prepare", "--adapter", "unsupported"],
      { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    failure = error;
  }
  if (failure?.status !== 1) throw new Error("Installed CLI errors must exit with status 1.");
  writeFileSync(
    join(directory, "index.html"),
    '<main id="app"></main><script type="module" src="/main.js"></script>\n',
  );
  writeFileSync(
    join(directory, "main.js"),
    'import { canonicalJson } from "nexus-launch"; import { flapStandard } from "nexus-launch/flap"; import { pons } from "nexus-launch/pons"; import { ponsV2 } from "nexus-launch/pons-v2"; document.querySelector("#app").textContent = canonicalJson([flapStandard().id, pons().id, ponsV2().id]);\n',
  );
  execFileSync(join(project, "node_modules", ".bin", "vite"), ["build", "--logLevel", "silent"], {
    cwd: directory,
    stdio: "ignore",
  });
  process.stdout.write(`Installed package smoke test passed (${filename}).\n`);
} finally {
  rmSync(directory, { force: true, recursive: true });
}
