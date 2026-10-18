/**
 * Client for the Bitwarden CLI Vault Management API (`bw serve`), reached
 * only over a private Unix socket. Verified against bitwarden/clients
 * 57e52fcc (CLI 2026.10.0): `apps/cli/src/commands/serve.command.ts` and
 * `apps/cli/src/oss-serve-configurator.ts`.
 *
 * - `bw serve --hostname unix:///path/bw.sock` listens on the socket. Origin
 *   protection stays on: requests carry `Host: localhost:<port>` (port
 *   defaults to 8087) and never an `Origin` header.
 * - Responses are `{ success, message?, data? }`; failures use HTTP 400.
 * - Only status, sync, list, get, create, edit and soft delete are used.
 *   Unlock, login, lock, permanent delete, attachments and arbitrary
 *   commands are never called.
 */
import { lstatSync } from "node:fs";
import http from "node:http";
import { dirname } from "node:path";

export const BITWARDEN_SERVE_DEFAULT_PORT = 8087;

export type BitwardenServeMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface BitwardenServeTransport {
  request(input: {
    method: BitwardenServeMethod;
    path: string;
    body?: string;
    timeoutMs: number;
    maxResponseBytes: number;
  }): Promise<{ status: number; body: string }>;
}

/** Stable reasons; raw CLI messages are never forwarded. */
export type BitwardenServeFailure =
  | "locked"
  | "unauthenticated"
  | "not_found"
  | "permission_denied"
  | "conflict"
  | "rejected"
  | "unavailable"
  | "transport";

export class BitwardenServeError extends Error {
  readonly failure: BitwardenServeFailure;
  /** True when the CLI definitely refused before changing anything. */
  readonly definite: boolean;
  constructor(failure: BitwardenServeFailure, definite: boolean) {
    super(`bw serve request failed: ${failure}`);
    this.name = "BitwardenServeError";
    this.failure = failure;
    this.definite = definite;
  }
}

export class BitwardenPrivatePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BitwardenPrivatePathError";
  }
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/** A directory owned by this user with no group or other permissions. */
export function assertPrivateDirectory(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new BitwardenPrivatePathError(`${path} does not exist`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new BitwardenPrivatePathError(`${path} must be a real directory, not a link`);
  }
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    throw new BitwardenPrivatePathError(`${path} must be owned by the bridge user`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new BitwardenPrivatePathError(`${path} must have mode 0700`);
  }
}

/** The `bw serve` socket must be a socket owned by this user inside a 0700 directory. */
export function assertPrivateSocket(socketPath: string): void {
  assertPrivateDirectory(dirname(socketPath));
  let stat;
  try {
    stat = lstatSync(socketPath);
  } catch {
    throw new BitwardenPrivatePathError(`${socketPath} does not exist; is bw serve running?`);
  }
  if (!stat.isSocket()) throw new BitwardenPrivatePathError(`${socketPath} is not a socket`);
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    throw new BitwardenPrivatePathError(`${socketPath} must be owned by the bridge user`);
  }
}

/**
 * The exact command an operator runs (no shell) after `bw login`/`bw unlock`
 * in their own terminal, with `BW_SESSION` exported there. TCP is never used.
 */
export function bitwardenServeCommand(input: {
  bwPath?: string;
  socketPath: string;
  appDataDir: string;
}): { argv: string[]; env: Record<string, string> } {
  assertPrivateDirectory(input.appDataDir);
  assertPrivateDirectory(dirname(input.socketPath));
  return {
    argv: [input.bwPath ?? "bw", "serve", "--hostname", `unix://${input.socketPath}`],
    env: { BITWARDENCLI_APPDATA_DIR: input.appDataDir, BW_NOINTERACTION: "true" },
  };
}

export function createUnixSocketBitwardenTransport(options: {
  socketPath: string;
  /** `bw serve --port`, used only for the Host header origin check. */
  port?: number;
  /** Recheck socket ownership and permissions before every request. Default true. */
  verifySocket?: boolean;
}): BitwardenServeTransport {
  const host = `localhost:${options.port ?? BITWARDEN_SERVE_DEFAULT_PORT}`;
  if (options.verifySocket !== false) assertPrivateSocket(options.socketPath);
  return {
    request({ method, path, body, timeoutMs, maxResponseBytes }) {
      if (options.verifySocket !== false) assertPrivateSocket(options.socketPath);
      return new Promise((resolve, reject) => {
        let settled = false;
        let sent = false;
        const finish = (error: unknown, value?: { status: number; body: string }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve(value!);
        };
        const headers: Record<string, string> = { host, accept: "application/json" };
        if (body !== undefined) {
          headers["content-type"] = "application/json";
          headers["content-length"] = String(Buffer.byteLength(body));
        }
        const request = http.request(
          { socketPath: options.socketPath, method, path, headers, agent: false },
          (response) => {
            const chunks: Buffer[] = [];
            let total = 0;
            response.on("data", (chunk: Buffer) => {
              total += chunk.byteLength;
              if (total > maxResponseBytes) {
                response.destroy();
                finish(new BitwardenServeError("transport", false));
                return;
              }
              chunks.push(chunk);
            });
            response.on("end", () =>
              finish(null, {
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
            response.on("error", () => finish(new BitwardenServeError("transport", false)));
          },
        );
        const timer = setTimeout(() => {
          request.destroy();
          finish(new BitwardenServeError("transport", !sent));
        }, timeoutMs);
        request.on("error", () => finish(new BitwardenServeError("transport", !sent)));
        request.on("finish", () => {
          sent = true;
        });
        request.end(body);
      });
    },
  };
}

export interface BitwardenStatus {
  status: "unlocked" | "locked" | "unauthenticated";
  lastSync: string | null;
  userId: string | null;
  userEmail: string | null;
  serverUrl: string | null;
}

export type BitwardenItem = Record<string, unknown> & {
  id: string;
  type: number;
  revisionDate?: unknown;
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isBitwardenGuid(value: unknown): value is string {
  return typeof value === "string" && GUID.test(value);
}

/** Exact CLI messages that prove nothing changed (from the commands at 57e52fcc). */
function classify(message: string): { failure: BitwardenServeFailure; definite: boolean } {
  const text = message.trim();
  if (text === "Vault is locked.") return { failure: "locked", definite: true };
  if (text === "You are not logged in.") return { failure: "unauthenticated", definite: true };
  if (text === "Not found.") return { failure: "not_found", definite: true };
  if (
    text.startsWith("You do not have permission to") ||
    text.includes("restricted by organizational policy") ||
    text.startsWith("An organization policy restricts")
  ) {
    return { failure: "permission_denied", definite: true };
  }
  if (text.startsWith("You may not edit a deleted item")) {
    return { failure: "not_found", definite: true };
  }
  // Server precondition on lastKnownRevisionDate.
  if (text.includes("out of date")) return { failure: "conflict", definite: true };
  return { failure: "rejected", definite: false };
}

export interface BitwardenServeClientOptions {
  transport: BitwardenServeTransport;
  timeoutMs?: number;
  /** Bounds a whole-vault listing response. Default 64 MiB. */
  maxListBytes?: number;
}

export class BitwardenServeClient {
  readonly #transport: BitwardenServeTransport;
  readonly #timeoutMs: number;
  readonly #maxListBytes: number;

  constructor(options: BitwardenServeClientOptions) {
    this.#transport = options.transport;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxListBytes = options.maxListBytes ?? 64 * 1024 * 1024;
  }

  async #call(
    method: BitwardenServeMethod,
    path: string,
    options: { body?: unknown; maxBytes?: number; mutation?: boolean } = {},
  ): Promise<unknown> {
    let response: { status: number; body: string };
    try {
      response = await this.#transport.request({
        method,
        path,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        timeoutMs: this.#timeoutMs,
        maxResponseBytes: options.maxBytes ?? 4 * 1024 * 1024,
      });
    } catch (error) {
      // A private-path refusal happens before anything is sent.
      if (error instanceof BitwardenServeError || error instanceof BitwardenPrivatePathError) {
        throw error;
      }
      throw new BitwardenServeError("transport", false);
    }
    let parsed: { success?: unknown; message?: unknown; data?: unknown };
    try {
      parsed = JSON.parse(response.body);
    } catch {
      // Origin-protection 403s and other non-JSON responses.
      throw new BitwardenServeError(
        response.status === 403 ? "permission_denied" : "unavailable",
        response.status === 403 || !options.mutation,
      );
    }
    if (parsed?.success === true && response.status >= 200 && response.status < 300) {
      return parsed.data;
    }
    if (parsed?.success === false && typeof parsed.message === "string") {
      const { failure, definite } = classify(parsed.message);
      throw new BitwardenServeError(failure, definite || !options.mutation);
    }
    throw new BitwardenServeError("unavailable", !options.mutation);
  }

  async status(): Promise<BitwardenStatus> {
    const data = (await this.#call("GET", "/status")) as {
      object?: unknown;
      template?: Record<string, unknown>;
    };
    const template = data?.template;
    const status = template?.status;
    if (status !== "unlocked" && status !== "locked" && status !== "unauthenticated") {
      throw new BitwardenServeError("unavailable", true);
    }
    const text = (value: unknown) => (typeof value === "string" && value ? value : null);
    const lastSync = text(template?.lastSync);
    return {
      status,
      lastSync:
        lastSync && Number.isFinite(Date.parse(lastSync)) ? new Date(lastSync).toISOString() : null,
      userId: text(template?.userId),
      userEmail: text(template?.userEmail),
      serverUrl: text(template?.serverUrl),
    };
  }

  /** Full upstream sync (`POST /sync?force=true`). */
  async sync(): Promise<void> {
    await this.#call("POST", "/sync?force=true");
  }

  /** Active (not trashed, not archived) items; the CLI excludes both by default. */
  async listItems(filter: { personal: true } | { collectionId: string }): Promise<BitwardenItem[]> {
    const query =
      "personal" in filter
        ? "organizationid=null"
        : `collectionid=${encodeURIComponent(filter.collectionId)}`;
    const data = (await this.#call("GET", `/list/object/items?${query}`, {
      maxBytes: this.#maxListBytes,
    })) as { object?: unknown; data?: unknown };
    if (data?.object !== "list" || !Array.isArray(data.data)) {
      throw new BitwardenServeError("unavailable", true);
    }
    return data.data.filter(isItem);
  }

  async listCollections(): Promise<Array<{ id: string; organizationId: string; name: string }>> {
    const data = (await this.#call("GET", "/list/object/collections")) as {
      object?: unknown;
      data?: unknown;
    };
    if (data?.object !== "list" || !Array.isArray(data.data)) {
      throw new BitwardenServeError("unavailable", true);
    }
    return data.data.flatMap((entry) => {
      const c = entry as Record<string, unknown>;
      return isBitwardenGuid(c?.id) &&
        isBitwardenGuid(c.organizationId) &&
        typeof c.name === "string"
        ? [{ id: c.id.toLowerCase(), organizationId: c.organizationId.toLowerCase(), name: c.name }]
        : [];
    });
  }

  /** GUID only: a non-GUID id makes the CLI search by text instead. */
  async getItem(id: string): Promise<BitwardenItem> {
    if (!isBitwardenGuid(id)) throw new BitwardenServeError("not_found", true);
    const data = await this.#call("GET", `/object/item/${id.toLowerCase()}`);
    if (!isItem(data) || data.id.toLowerCase() !== id.toLowerCase()) {
      throw new BitwardenServeError("unavailable", true);
    }
    return data;
  }

  async createItem(body: Record<string, unknown>): Promise<BitwardenItem> {
    const data = await this.#call("POST", "/object/item", { body, mutation: true });
    if (!isItem(data)) throw new BitwardenServeError("rejected", false);
    return data;
  }

  /** The body is the complete current item with edits; its revisionDate is the precondition. */
  async editItem(id: string, body: Record<string, unknown>): Promise<BitwardenItem> {
    if (!isBitwardenGuid(id)) throw new BitwardenServeError("not_found", true);
    const data = await this.#call("PUT", `/object/item/${id.toLowerCase()}`, {
      body,
      mutation: true,
    });
    if (!isItem(data) || data.id.toLowerCase() !== id.toLowerCase()) {
      throw new BitwardenServeError("rejected", false);
    }
    return data;
  }

  /** Recoverable soft delete to Trash. Never `?permanent=true`. */
  async trashItem(id: string): Promise<void> {
    if (!isBitwardenGuid(id)) throw new BitwardenServeError("not_found", true);
    await this.#call("DELETE", `/object/item/${id.toLowerCase()}`, { mutation: true });
  }
}

function isItem(value: unknown): value is BitwardenItem {
  const item = value as Record<string, unknown> | null;
  return (
    !!item &&
    typeof item === "object" &&
    !Array.isArray(item) &&
    isBitwardenGuid(item.id) &&
    typeof item.type === "number"
  );
}
