/**
 * Durable replay and idempotency storage for a single bridge process: one
 * JSON file in a private (0700) state directory, rewritten atomically
 * (temporary file, fsync, rename) before each decision is acknowledged.
 * Results are mutation metadata only; values are never stored.
 *
 * Not for several processes sharing one directory: use a database-backed
 * `ExternalVaultReceiverStore` for that.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { open, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  ExternalVaultReceiverError,
  type ExternalVaultReceiverStore,
} from "@opengeni/sdk/external-vault-receiver";
import { assertPrivateDirectory } from "./bw-serve";

type State = {
  version: 1;
  requests: Record<string, number>;
  mutations: Record<
    string,
    { digest: string; expiresAt: number; state: "pending" | "completed"; result?: unknown }
  >;
};

export function createFileExternalVaultReceiverStore(options: {
  directory: string;
  maxEntries?: number;
  now?: () => number;
}): ExternalVaultReceiverStore & { size(): number } {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(options.directory);
  const file = join(options.directory, "receiver-state.json");
  const maxEntries = options.maxEntries ?? 50_000;
  const now = options.now ?? (() => Date.now());
  let state: State = { version: 1, requests: {}, mutations: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as State;
    if (parsed?.version === 1 && parsed.requests && parsed.mutations) state = parsed;
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
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(state));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
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
  };
}
