/**
 * HTTP listener and file configuration for a customer-run bridge. It listens
 * on loopback (or a Unix socket) behind the customer's TLS reverse proxy;
 * every request is authenticated by the signed protocol, never by network
 * position. There is no unauthenticated status, unlock or command route.
 */
import { lstatSync, readFileSync } from "node:fs";
import http from "node:http";
import { isAbsolute } from "node:path";
import { VAULT_PROVIDER_WIRE_LIMITS } from "@opengeni/sdk/external-vault-receiver";
import {
  validateBitwardenBridgeConfig,
  type BitwardenBridge,
  type BitwardenBridgeConfig,
} from "./bridge";

export type BitwardenBridgeListen =
  | { host?: string; port: number; allowNonLoopback?: boolean }
  | { path: string };

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export async function serveBitwardenBridge(input: {
  bridge: BitwardenBridge;
  listen: BitwardenBridgeListen;
  /** Request path the reverse proxy forwards. Default `/opengeni/vault`. */
  path?: string;
}): Promise<{ server: http.Server; address: string; close(): Promise<void> }> {
  const route = input.path ?? "/opengeni/vault";
  if ("port" in input.listen) {
    const host = input.listen.host ?? "127.0.0.1";
    if (!LOOPBACK.has(host) && input.listen.allowNonLoopback !== true) {
      throw new Error("the bridge listens on loopback; put a TLS reverse proxy in front of it");
    }
  }
  const server = http.createServer((request, response) => {
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...headers,
      });
      response.end(body);
    };
    const url = new URL(request.url ?? "/", "http://bridge.invalid");
    if (url.pathname !== route) return send(404, JSON.stringify({ error: "not_found" }));
    if (request.method !== "POST") {
      return send(405, JSON.stringify({ error: "method_not_allowed" }), { allow: "POST" });
    }
    const max = VAULT_PROVIDER_WIRE_LIMITS.maxRequestBytes;
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    request.on("data", (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.byteLength;
      if (total > max) {
        aborted = true;
        send(413, JSON.stringify({ error: "request_too_large" }), { connection: "close" });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (aborted) return;
      const controller = new AbortController();
      response.on("close", () => controller.abort());
      input.bridge
        .handle({
          body: Buffer.concat(chunks).toString("utf8"),
          headers: request.headers,
          signal: controller.signal,
        })
        .then(
          (result) => send(result.status, result.body, result.headers),
          () => send(500, JSON.stringify({ error: "internal" })),
        );
    });
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if ("path" in input.listen) server.listen(input.listen.path, () => resolve());
    else server.listen(input.listen.port, input.listen.host ?? "127.0.0.1", () => resolve());
  });
  const bound = server.address();
  const address =
    typeof bound === "string"
      ? `unix:${bound}`
      : `http://${bound?.family === "IPv6" ? `[${bound.address}]` : bound?.address}:${bound?.port}`;
  return {
    server,
    address,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export interface BitwardenBridgeFileConfig {
  bridge: BitwardenBridgeConfig;
  bwSocketPath: string;
  bwServePort?: number;
  stateDir: string;
  listen: BitwardenBridgeListen;
  path?: string;
}

function readSecretFile(path: string): string {
  if (!isAbsolute(path)) throw new Error("secret files must be absolute paths");
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error(`${path} must be a regular file with mode 0600`);
  }
  // Same ownership rule as the bw serve socket and state directory.
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && stat.uid !== uid) {
    throw new Error(`${path} must be owned by the bridge user`);
  }
  return readFileSync(path, "utf8").trim();
}

const FILE_KEYS = new Set([
  "connectionId",
  "opengeni",
  "vaults",
  "accountLabel",
  "readSyncTtlMs",
  "minSyncIntervalMs",
  "allowStaleReads",
  "bitwardenUserId",
  "snapshotTtlMs",
  "maxSnapshots",
  "signingSecretFile",
  "previousSigningSecretFile",
  "bwSocketPath",
  "bwServePort",
  "stateDir",
  "listen",
  "path",
]);
const BRIDGE_KEYS = [
  "accountLabel",
  "readSyncTtlMs",
  "minSyncIntervalMs",
  "allowStaleReads",
  "bitwardenUserId",
  "snapshotTtlMs",
  "maxSnapshots",
] as const;

function port(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${key} must be a port number`);
  }
  return value;
}

function parseListen(value: unknown): BitwardenBridgeListen {
  if (value === undefined) return { host: "127.0.0.1", port: 8788 };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("listen must be an object");
  }
  const listen = value as Record<string, unknown>;
  if ("path" in listen) {
    if (
      Object.keys(listen).length !== 1 ||
      typeof listen.path !== "string" ||
      !isAbsolute(listen.path)
    ) {
      throw new Error("listen.path must be the only key and an absolute path");
    }
    return { path: listen.path };
  }
  for (const key of Object.keys(listen)) {
    if (key !== "host" && key !== "port" && key !== "allowNonLoopback") {
      throw new Error(`unknown listen key ${key}`);
    }
  }
  if (listen.host !== undefined && (typeof listen.host !== "string" || !listen.host)) {
    throw new Error("listen.host must be text");
  }
  if (listen.allowNonLoopback !== undefined && typeof listen.allowNonLoopback !== "boolean") {
    throw new Error("listen.allowNonLoopback must be true or false");
  }
  return {
    port: port(listen.port, "listen.port"),
    ...(listen.host !== undefined ? { host: listen.host as string } : {}),
    ...(listen.allowNonLoopback !== undefined
      ? { allowNonLoopback: listen.allowNonLoopback as boolean }
      : {}),
  };
}

/**
 * Load a JSON config. Signing secrets come from 0600 files
 * (`signingSecretFile`, optional `previousSigningSecretFile`) or the
 * `OPENGENI_VAULT_SIGNING_SECRET` environment variable; never from the JSON.
 * Types are checked strictly and unknown keys are refused.
 */
export function loadBitwardenBridgeConfigFile(
  path: string,
  env: Record<string, string | undefined> = process.env,
): BitwardenBridgeFileConfig {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("the bridge config must be a JSON object");
  }
  const raw = parsed as Record<string, any>;
  if ("signingSecrets" in raw || "signingSecret" in raw) {
    throw new Error("put signing secrets in signingSecretFile, not in the config JSON");
  }
  for (const key of Object.keys(raw)) {
    if (!FILE_KEYS.has(key)) throw new Error(`unknown bridge config key ${key}`);
  }
  for (const key of ["signingSecretFile", "previousSigningSecretFile"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") {
      throw new Error(`${key} must be an absolute path`);
    }
  }
  const secrets: string[] = [];
  if (typeof raw.signingSecretFile === "string")
    secrets.push(readSecretFile(raw.signingSecretFile));
  else if (env.OPENGENI_VAULT_SIGNING_SECRET) secrets.push(env.OPENGENI_VAULT_SIGNING_SECRET);
  if (typeof raw.previousSigningSecretFile === "string") {
    secrets.push(readSecretFile(raw.previousSigningSecretFile));
  }
  for (const key of ["bwSocketPath", "stateDir"] as const) {
    if (typeof raw[key] !== "string" || !isAbsolute(raw[key])) {
      throw new Error(`${key} must be an absolute path`);
    }
  }
  if (raw.path !== undefined && (typeof raw.path !== "string" || !raw.path.startsWith("/"))) {
    throw new Error("path must start with /");
  }
  const bridge: BitwardenBridgeConfig = {
    connectionId: raw.connectionId,
    signingSecrets: secrets,
    opengeni: raw.opengeni,
    vaults: raw.vaults,
  };
  for (const key of BRIDGE_KEYS) {
    if (raw[key] !== undefined) (bridge as unknown as Record<string, unknown>)[key] = raw[key];
  }
  validateBitwardenBridgeConfig(bridge);
  return {
    bridge,
    bwSocketPath: raw.bwSocketPath,
    ...(raw.bwServePort !== undefined ? { bwServePort: port(raw.bwServePort, "bwServePort") } : {}),
    stateDir: raw.stateDir,
    listen: parseListen(raw.listen),
    ...(raw.path !== undefined ? { path: raw.path } : {}),
  };
}
