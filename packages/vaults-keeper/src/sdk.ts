import * as nodeCrypto from "node:crypto";
import { constants as fsConstants, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as nodePath from "node:path";
import type * as KeeperSdkModule from "@keeper-security/secrets-manager-core";
import { VaultProviderError } from "./contract";

/** The official SDK release this adapter is written and tested against. */
export const KEEPER_SDK_VERSION = "17.6.0";
export const KEEPER_SDK_PACKAGE = "@keeper-security/secrets-manager-core";
/** SHA-256 of `dist/index.cjs.js` in @keeper-security/secrets-manager-core 17.6.0. */
export const KEEPER_SDK_SHA256 = "94787ce51324f36c1b62d19ac29fbe3b9b206305695e508b76585a4d6e39635c";

export type KeeperSdk = typeof KeeperSdkModule;
export type KeeperRecord = KeeperSdkModule.KeeperRecord;
export type KeeperFolder = KeeperSdkModule.KeeperFolder;
export type KeeperFile = KeeperSdkModule.KeeperFile;
export type KeeperSecrets = KeeperSdkModule.KeeperSecrets;
export type KeyValueStorage = KeeperSdkModule.KeyValueStorage;
export type SecretManagerOptions = KeeperSdkModule.SecretManagerOptions;
export type KeeperQueryFunction = NonNullable<SecretManagerOptions["queryFunction"]>;
export type KeeperHttpResponse = Awaited<ReturnType<KeeperQueryFunction>>;

/**
 * Bounded log capture for one SDK instance. The SDK reports skipped records,
 * folders and files only through `console.error`; those lines carry record
 * UIDs and error text, so they are inspected here and never forwarded.
 */
export class CapturedConsole {
  readonly lines: string[] = [];
  private static readonly MAX_LINES = 200;
  private static readonly MAX_CHARS = 500;
  private push(args: unknown[]) {
    if (this.lines.length >= CapturedConsole.MAX_LINES) return;
    const text = args
      .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)))
      .join(" ");
    this.lines.push(text.slice(0, CapturedConsole.MAX_CHARS));
  }
  readonly error = (...args: unknown[]) => this.push(args);
  readonly warn = (...args: unknown[]) => this.push(args);
  readonly log = (...args: unknown[]) => this.push(args);
  readonly info = (...args: unknown[]) => this.push(args);
  readonly debug = (...args: unknown[]) => this.push(args);

  /** True when the SDK dropped a record, folder or file it could not decrypt. */
  get skippedSomething(): boolean {
    return this.lines.some((line) => /skipped due to error|could not be decrypted/.test(line));
  }
}

function denied(module: string): never {
  throw new Error(`The Keeper SDK may not use ${module} inside Opengeni`);
}

/**
 * Modules handed to each SDK instance. `fs` exposes only its constants (read
 * at load for symlink-safe flags); every function is absent, so the SDK's
 * on-disk config and response cache cannot write anything. `https` and `os`
 * are empty: all network goes through the adapter's own transport.
 */
const FS_STUB = Object.freeze({ constants: fsConstants });
const HTTPS_STUB = Object.freeze({});
const OS_STUB = Object.freeze({});

function sdkRequire(name: string): unknown {
  switch (name) {
    case "crypto":
      return nodeCrypto;
    case "path":
      return nodePath;
    case "fs":
      return FS_STUB;
    case "https":
      return HTTPS_STUB;
    case "os":
      return OS_STUB;
    default:
      return denied(name);
  }
}

type SdkFactory = (
  module: { exports: Record<string, unknown> },
  exports: Record<string, unknown>,
  require: (name: string) => unknown,
  console: CapturedConsole,
) => void;

let compiled: { sha256: string; factory: SdkFactory } | null = null;

/** Reads the installed SDK's CommonJS build (a read only; nothing is executed here). */
export function readInstalledKeeperSdkSource(): string {
  const require = createRequire(import.meta.url);
  let path: string;
  try {
    path = require.resolve(KEEPER_SDK_PACKAGE);
  } catch {
    throw new VaultProviderError(
      "provider_unavailable",
      `${KEEPER_SDK_PACKAGE} ${KEEPER_SDK_VERSION} is not installed on this Opengeni server`,
    );
  }
  return readFileSync(path, "utf8");
}

/**
 * Compiles the pinned SDK once. The source must match the 17.6.0 build byte
 * for byte; any other version is refused rather than run with unknown
 * semantics.
 */
function factoryFor(source: string, expectedSha256: string): SdkFactory {
  const sha256 = nodeCrypto.createHash("sha256").update(source).digest("hex");
  if (compiled && compiled.sha256 === sha256) return compiled.factory;
  if (sha256 !== expectedSha256) {
    throw new VaultProviderError(
      "provider_unavailable",
      `The installed Keeper SDK is not ${KEEPER_SDK_PACKAGE} ${KEEPER_SDK_VERSION}`,
    );
  }
  // eslint-disable-next-line no-new-func -- a fresh module scope per instance is the isolation boundary.
  const factory = new Function("module", "exports", "require", "console", source) as SdkFactory;
  compiled = { sha256, factory };
  return factory;
}

export interface KeeperSdkInstance {
  sdk: KeeperSdk;
  console: CapturedConsole;
}

export interface KeeperSdkLoader {
  /** A new, private SDK module instance (its own key cache and platform). */
  instance(): KeeperSdkInstance;
}

/**
 * The SDK keeps decrypted application, folder and record keys in a
 * module-global cache and reads keys from that cache before storage, so one
 * module instance must never serve two connections. Each operation evaluates
 * the pinned CommonJS build in a fresh scope, which gives it its own cache,
 * platform and storage serialization, and is discarded afterwards.
 */
export function createKeeperSdkLoader(
  options: { source?: string | (() => string); expectedSha256?: string } = {},
): KeeperSdkLoader {
  let factory: SdkFactory | null = null;
  return {
    instance() {
      if (!factory) {
        const source =
          typeof options.source === "function"
            ? options.source()
            : (options.source ?? readInstalledKeeperSdkSource());
        factory = factoryFor(source, options.expectedSha256 ?? KEEPER_SDK_SHA256);
      }
      const captured = new CapturedConsole();
      const module = { exports: {} as Record<string, unknown> };
      factory(module, module.exports, sdkRequire, captured);
      return { sdk: module.exports as unknown as KeeperSdk, console: captured };
    },
  };
}

/** Default transport limits. */
export const KEEPER_REQUEST_TIMEOUT_MS = 15_000;
export const KEEPER_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new VaultProviderError(
      "provider_unavailable",
      "Keeper returned more data than Opengeni reads",
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new VaultProviderError(
        "provider_unavailable",
        "Keeper returned more data than Opengeni reads",
      );
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function withDeadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * The SDK's request function, reimplemented over `fetch` so requests follow no
 * redirects, honour the caller's abort signal, and read bounded bodies. Headers
 * match the SDK's `postFunction` (PublicKeyId, TransmissionKey, Authorization).
 */
export function createKeeperFetchTransport(
  options: { fetch?: typeof fetch; maxResponseBytes?: number; signal?: AbortSignal } = {},
): KeeperQueryFunction {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxBytes = options.maxResponseBytes ?? KEEPER_MAX_RESPONSE_BYTES;
  return async (url, transmissionKey, payload, _allowUnverifiedCertificate, timeoutMs) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        PublicKeyId: String(transmissionKey.publicKeyId),
        TransmissionKey: Buffer.from(transmissionKey.encryptedKey).toString("base64"),
        Authorization: `Signature ${Buffer.from(payload.signature).toString("base64")}`,
        "User-Agent": `Opengeni (KSM JS ${KEEPER_SDK_VERSION})`,
      },
      body: payload.payload as Uint8Array<ArrayBuffer>,
      redirect: "error",
      signal: withDeadline(options.signal, timeoutMs ?? KEEPER_REQUEST_TIMEOUT_MS),
    });
    const data = await readBounded(response, maxBytes);
    return { statusCode: response.status, headers: Object.fromEntries(response.headers), data };
  };
}

/** Downloads an encrypted file body from a Keeper-issued URL, bounded in size and time. */
export type KeeperFileFetcher = (
  url: string,
  options: { signal?: AbortSignal; maxBytes: number; timeoutMs: number },
) => Promise<Uint8Array>;

export function createKeeperFileFetcher(
  fetchImpl: typeof fetch = globalThis.fetch,
): KeeperFileFetcher {
  return async (url, options) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      throw new VaultProviderError("provider_unavailable", "Keeper returned a non-HTTPS file URL");
    }
    const response = await fetchImpl(parsed, {
      redirect: "error",
      signal: withDeadline(options.signal, options.timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new VaultProviderError(
        "provider_unavailable",
        `Keeper file storage returned HTTP ${response.status}`,
      );
    }
    return readBounded(response, options.maxBytes);
  };
}
