import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds the static signing page. The output is plain files with no server
 * behind them, which is the point: the plan arrives in a URL fragment, so a host
 * that never sees the plan cannot tamper with what the signer reviews.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "page-dist");

rmSync(out, { force: true, recursive: true });
mkdirSync(out, { recursive: true });

execFileSync(
  join(root, "node_modules", ".bin", "esbuild"),
  [
    join(root, "page", "app.ts"),
    "--bundle",
    "--format=esm",
    "--target=es2022",
    "--minify",
    "--legal-comments=none",
    `--outfile=${join(out, "app.js")}`,
  ],
  { stdio: "inherit" },
);

copyFileSync(join(root, "page", "index.html"), join(out, "index.html"));
process.stdout.write(`Signing page built into ${out}\n`);
