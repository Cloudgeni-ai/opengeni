/**
 * Durable replay and idempotency storage for a single bridge process: one
 * JSON file in a private (0700) state directory, rewritten atomically
 * (temporary file, fsync, rename, directory fsync) before each decision is
 * acknowledged. Results are mutation metadata only; values are never stored.
 * The same file pins the Bitwarden account each connection is bound to.
 *
 * Not for several processes sharing one directory: use a database-backed
 * `ExternalVaultReceiverStore` for that.
 */
import { mkdirSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import {
  ExternalVaultReceiverError,
  type ExternalVaultReceiverStore,
} from "@opengeni/sdk/external-vault-receiver";
import type { BitwardenAccountPinStore } from "./bridge";
import { assertPrivateDirectory, isBitwardenGuid } from "./bw-serve";

type State = {
  version: 1;
  requests: Record<string, number>;
  mutations: Record<
    string,
    { digest: string; expiresAt: number; state: "pending" | "completed"; result?: unknown }
  >;
  /** Connection id -> pinned Bitwarden user id. Optional for older state files. */
  accounts?: Record<string, string>;
};

/** Durability steps, replaceable only to observe them in tests. */
export interface FileStoreSyncHooks {
  /** fsync a directory after a rename into it. */
  syncDirectory(path: string): Promise<void>;
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await fs.open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function createFileExternalVaultReceiverStore(options: {
  directory: string;
  maxEntries?: number;
  now?: () => number;
  /** Test hook; production uses fsync. */
  sync?: FileStoreSyncHooks;
}): ExternalVaultReceiverStore & BitwardenAccountPinStore & { size(): number } {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(options.directory);
  const file = join(options.directory, "receiver-state.json");
  const maxEntries = options.maxEntries ?? 50_000;
  const now = options.now ?? (() => Date.now());
  const syncDirectory = options.sync?.syncDirectory ?? fsyncDirectory;
  let state: State = { version: 1, requests: {}, mutations: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as State;
    if (parsed?.version !== 1 || !parsed.requests || !parsed.mutations) {
      throw new Error("unrecognized state");
    }
    if (
      parsed.accounts !== undefined &&
      (typeof parsed.accounts !== "object" ||
        parsed.accounts === null ||
        !Object.values(parsed.accounts).every(isBitwardenGuid))
    ) {
      throw new Error("unrecognized account pins");
    }
    state = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      // A corrupt state file must not silently reopen replay windows.
      throw new Error(`cannot read bridge state ${file}`, { cause: error });
    }
  }

  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  function prune() {
    const t = now();
    for (const [key, expiresAt] of Object.entries(state.requests)) {
      if (expiresAt <= t) delete state.requests[key];
    }
    for (const [key, entry] of Object.entries(state.mutations)) {
      if (entry.expiresAt <= t) delete state.mutations[key];
    }
  }

  const size = () => Object.keys(state.requests).length + Object.keys(state.mutations).length;

  async function persist() {
    const temporary = `${file}.${process.pid}.tmp`;
    const handle = await fs.open(temporary, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(state));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    // The rename itself is durable only once the directory entry is flushed.
    await syncDirectory(options.directory);
  }

  /** Apply a change and persist it; on failure the in-memory state is restored. */
  async function commit<T>(change: () => T): Promise<T> {
    const before = structuredClone(state);
    const result = change();
    try {
      await persist();
    } catch (error) {
      state = before;
      throw error;
    }
    return result;
  }

  const key = (connectionId: string, id: string) => `${connectionId}\u0000${id}`;

  return {
    size,
    rememberRequest: ({ connectionId, requestId, expiresAt }) =>
      serial(async () => {
        prune();
        const k = key(connectionId, requestId);
        if (state.requests[k] !== undefined) return false;
        if (size() >= maxEntries) throw new ExternalVaultReceiverError("provider_rate_limited");
        return commit(() => {
          state.requests[k] = expiresAt.getTime();
          return true;
        });
      }),
    claimMutation: ({ connectionId, idempotencyKey, digest, expiresAt }) =>
      serial(async () => {
        prune();
        const existing = state.mutations[key(connectionId, idempotencyKey)];
        if (existing) {
          if (existing.digest !== digest) return { state: "mismatch" as const };
          return existing.state === "completed"
            ? { state: "completed" as const, result: structuredClone(existing.result) }
            : { state: "pending" as const };
        }
        if (size() >= maxEntries) throw new ExternalVaultReceiverError("provider_rate_limited");
        return commit(() => {
          state.mutations[key(connectionId, idempotencyKey)] = {
            digest,
            expiresAt: expiresAt.getTime(),
            state: "pending",
          };
          return { state: "claimed" as const };
        });
      }),
    completeMutation: ({ connectionId, idempotencyKey, digest, result }) =>
      serial(async () => {
        const entry = state.mutations[key(connectionId, idempotencyKey)];
        if (!entry || entry.digest !== digest) throw new Error("mutation claim missing");
        await commit(() => {
          entry.state = "completed";
          entry.result = structuredClone(result);
        });
      }),
    releaseMutation: ({ connectionId, idempotencyKey, digest }) =>
      serial(async () => {
        const k = key(connectionId, idempotencyKey);
        if (state.mutations[k]?.digest !== digest) return;
        await commit(() => {
          delete state.mutations[k];
        });
      }),
    readBitwardenAccount: (connectionId) =>
      serial(async () => state.accounts?.[connectionId.toLowerCase()] ?? null),
    pinBitwardenAccount: (connectionId, userId) =>
      serial(async () => {
        if (!isBitwardenGuid(userId)) throw new Error("Bitwarden user ids are UUIDs");
        const k = connectionId.toLowerCase();
        const existing = state.accounts?.[k];
        if (existing) return existing;
        return commit(() => {
          state.accounts = { ...state.accounts, [k]: userId.toLowerCase() };
          return userId.toLowerCase();
        });
      }),
  };
}
