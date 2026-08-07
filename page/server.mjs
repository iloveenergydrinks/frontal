import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Serves the built signing page.
 *
 * The page is static and the plan arrives in the URL fragment, which browsers
 * never transmit, so this process never sees a launch plan and cannot alter one.
 * Its only job is to hand over two files under headers that stop the page from
 * being framed, from leaking a referrer, or from loading anything it did not
 * ship with.
 */

const root = join(dirname(dirname(fileURLToPath(import.meta.url))), "page-dist");
const port = Number(process.env.PORT ?? 8080);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

// Only what the page actually needs: its own script, and RPC calls to the
// chains it can launch on.
const CONNECT = [
  "'self'",
  "https://rpc.mainnet.chain.robinhood.com",
  "https://bsc-dataseed.bnbchain.org",
].join(" ");

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  `connect-src ${CONNECT}`,
  "img-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const server = createServer(async (request, response) => {
  response.setHeader("content-security-policy", CSP);
  response.setHeader("cross-origin-opener-policy", "same-origin");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }

  const requested = new URL(request.url ?? "/", "http://localhost").pathname;
  const relative = normalize(requested === "/" ? "/index.html" : requested).replace(/^(\.\.[/\\])+/u, "");
  const file = join(root, relative);
  if (!file.startsWith(root)) {
    response.writeHead(403).end();
    return;
  }
  const type = TYPES[extname(file)];
  if (type === undefined) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, { "cache-control": "no-cache", "content-type": type });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(404).end();
  }
});

server.listen(port, () => process.stdout.write(`Signing page listening on ${port}\n`));
