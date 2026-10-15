import { createHmac, randomBytes } from "node:crypto";
import { type VaultProvider, type VaultProviderOperations } from "./contract";
import {
  type ProtonPassVaultProvider,
  type ProtonPassVaultProviderOptions,
  createProtonPassVaultProvider,
} from "./provider";
import { FILE_FIELD_PREFIX } from "./mapping";
import { restrictToOperations } from "./operations";

export const PROTON_PASS_POOL_MAX_SESSIONS = 32;
export const PROTON_PASS_POOL_IDLE_MS = 15 * 60_000;

export type ProtonPassProviderPoolOptions = Omit<
  ProtonPassVaultProviderOptions,
  "token" | "operations"
> & {
  /** Most CLI sessions kept at once; the least recently used is logged out first. */
  maxSessions?: number;
  /** A session unused this long is logged out, wiped and forgotten (token included). */
  poolIdleMs?: number;
  /** Builds one session's provider (tests). */
  create?: (options: ProtonPassVaultProviderOptions) => ProtonPassVaultProvider;
};

export interface ProtonPassProviderPool {
  /**
   * The provider for a token. Calls with the same token share one logged-in
   * CLI session (the same Proton identity and scope); different tokens never
   * share a session, state directory or cache. The returned provider is
   * narrowed to `operations` when given.
   */
  provider(token: string, operations?: VaultProviderOperations): VaultProvider;
  /** Logs every session out and wipes their state directories. */
  close(): Promise<void>;
  /** Sessions currently held (tests and diagnostics). */
  size(): number;
}

type Entry = { provider: ProtonPassVaultProvider; lastUsed: number; active: number };

/**
 * A process-wide pool of Proton Pass CLI sessions. Logging in creates a
 * Proton session, so each token logs in once and its session is reused until
 * it goes idle. Entries are keyed by an HMAC of the token under a random
 * per-pool key, so the map holds no token-derived value that outlives the
 * process.
 */
export function createProtonPassProviderPool(
  options: ProtonPassProviderPoolOptions,
): ProtonPassProviderPool {
  const {
    maxSessions = PROTON_PASS_POOL_MAX_SESSIONS,
    poolIdleMs = PROTON_PASS_POOL_IDLE_MS,
    create = createProtonPassVaultProvider,
    ...providerOptions
  } = options;
  const now = providerOptions.now ?? Date.now;
  const key = randomBytes(32);
  const entries = new Map<string, Entry>();
  let sweeper: ReturnType<typeof setInterval> | null = null;

  function retire(id: string, entry: Entry) {
    entries.delete(id);
    void entry.provider.close().catch(() => {});
    if (entries.size === 0 && sweeper) {
      clearInterval(sweeper);
      sweeper = null;
    }
  }

  function sweep() {
    const at = now();
    for (const [id, entry] of entries) {
      if (entry.active === 0 && at - entry.lastUsed >= poolIdleMs) retire(id, entry);
    }
  }

  function evictForRoom() {
    while (entries.size >= maxSessions) {
      let oldest: [string, Entry] | null = null;
      for (const pair of entries) {
        if (pair[1].active > 0) continue;
        if (!oldest || pair[1].lastUsed < oldest[1].lastUsed) oldest = pair;
      }
      if (!oldest) return;
      retire(oldest[0], oldest[1]);
    }
  }

  function entryFor(token: string): Entry {
    const id = createHmac("sha256", key).update(token).digest("hex");
    sweep();
    let entry = entries.get(id);
    if (!entry) {
      evictForRoom();
      entry = { provider: create({ ...providerOptions, token }), lastUsed: now(), active: 0 };
      entries.set(id, entry);
      if (!sweeper) {
        sweeper = setInterval(sweep, Math.max(1_000, Math.min(poolIdleMs, 60_000)));
        sweeper.unref?.();
      }
    }
    return entry;
  }

  function tracked(token: string): VaultProvider {
    const run = async <T>(work: (provider: ProtonPassVaultProvider) => Promise<T>): Promise<T> => {
      const entry = entryFor(token);
      entry.active += 1;
      entry.lastUsed = now();
      try {
        return await work(entry.provider);
      } finally {
        entry.active -= 1;
        entry.lastUsed = now();
      }
    };
    const sample = entryFor(token).provider;
    return {
      id: sample.id,
      capabilities: () => sample.capabilities(),
      validate: (ctx) => run((provider) => provider.validate(ctx)),
      listVaults: (ctx) => run((provider) => provider.listVaults(ctx)),
      listItems: (ctx, vaultId) => run((provider) => provider.listItems(ctx, vaultId)),
      readFields: (ctx, vaultId, itemId, fieldIds) =>
        run((provider) => provider.readFields(ctx, vaultId, itemId, fieldIds)),
      writeItem: (ctx, vaultId, item) => run((provider) => provider.writeItem(ctx, vaultId, item)),
      archiveItem: (ctx, vaultId, itemId) =>
        run((provider) => provider.archiveItem(ctx, vaultId, itemId)),
    };
  }

  return {
    provider(token, operations) {
      return restrictToOperations(tracked(token), operations, FILE_FIELD_PREFIX);
    },
    async close() {
      if (sweeper) clearInterval(sweeper);
      sweeper = null;
      const all = [...entries.values()];
      entries.clear();
      await Promise.all(all.map((entry) => entry.provider.close().catch(() => {})));
    },
    size: () => entries.size,
  };
}
