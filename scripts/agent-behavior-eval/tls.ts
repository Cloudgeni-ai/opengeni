import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startTestMcpServer, type TestMcpServer } from "@opengeni/testing";

/**
 * Per-session MCP servers must be `https:` (SessionMcpServerInput). The shared
 * fake MCP server (`@opengeni/testing` startTestMcpServer) serves plain HTTP, so
 * the eval fronts it with a loopback TLS proxy using a throwaway self-signed
 * certificate. The eval process trusts that certificate through
 * NODE_EXTRA_CA_CERTS, which Bun reads only at startup — run.ts re-executes
 * itself once with a CA bundle (existing extra CAs + this certificate).
 */
const TLS_DIR = join(tmpdir(), "opengeni-behavior-eval-tls");
export const EVAL_TLS_CERT = join(TLS_DIR, "cert.pem");
export const EVAL_TLS_KEY = join(TLS_DIR, "key.pem");
export const EVAL_CA_BUNDLE = join(TLS_DIR, "ca-bundle.pem");

export function ensureEvalTlsMaterial(): void {
  if (existsSync(EVAL_TLS_CERT) && existsSync(EVAL_TLS_KEY)) return;
  mkdirSync(TLS_DIR, { recursive: true });
  const result = Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      EVAL_TLS_KEY,
      "-out",
      EVAL_TLS_CERT,
      "-days",
      "30",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(`openssl failed to create the eval TLS certificate: ${result.stderr}`);
  }
}

/** CA bundle = any pre-existing NODE_EXTRA_CA_CERTS (e.g. a corporate proxy CA) + eval cert. */
export function writeEvalCaBundle(existingExtraCaPath: string | undefined): string {
  ensureEvalTlsMaterial();
  const parts: string[] = [];
  if (
    existingExtraCaPath &&
    existingExtraCaPath !== EVAL_CA_BUNDLE &&
    existsSync(existingExtraCaPath)
  ) {
    parts.push(readFileSync(existingExtraCaPath, "utf8").trim());
  }
  parts.push(readFileSync(EVAL_TLS_CERT, "utf8").trim());
  writeFileSync(EVAL_CA_BUNDLE, `${parts.join("\n")}\n`);
  return EVAL_CA_BUNDLE;
}

export type TlsMcpServer = {
  url: string;
  calls: TestMcpServer["calls"];
  close: () => void;
};

export function startTlsTestMcpServer(
  options: Parameters<typeof startTestMcpServer>[0] = {},
): TlsMcpServer {
  ensureEvalTlsMaterial();
  const inner = startTestMcpServer(options);
  const upstream = new URL(inner.url);
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: Bun.file(EVAL_TLS_CERT), key: Bun.file(EVAL_TLS_KEY) },
    async fetch(request) {
      const url = new URL(request.url);
      const target = new URL(url.pathname + url.search, upstream);
      const headers = new Headers(request.headers);
      headers.delete("host");
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const response = await fetch(target, {
        method: request.method,
        headers,
        ...(hasBody ? { body: await request.arrayBuffer() } : {}),
      });
      return new Response(response.body, { status: response.status, headers: response.headers });
    },
  });
  return {
    url: `https://127.0.0.1:${proxy.port}/mcp`,
    calls: inner.calls,
    close: () => {
      proxy.stop(true);
      inner.close();
    },
  };
}
