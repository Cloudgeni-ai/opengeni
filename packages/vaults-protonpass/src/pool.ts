import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { VaultProviderError, type VaultProvider, type VaultProviderOperations } from "./contract";
import {
  type ProtonPassVaultProvider,
  type ProtonPassVaultProviderOptions,
  createProtonPassVaultProvider,
  protonPassCapabilities,
} from "./provider";
import { FILE_FIELD_PREFIX } from "./mapping";
import { restrictToOperations } from "./operations";

export const PROTON_PASS_POOL_MAX_SESSIONS = 32;
export const PROTON_PASS_POOL_IDLE_MS = 15 * 60_000;
/** Retry hint when every pooled session is busy. */
export const PROTON_PASS_POOL_BUSY_RETRY_MS = 5_000;

export type ProtonPassProviderPoolOptions = Omit<
  ProtonPassVaultProviderOptions,
  "token" | "operations"
> & {
  /**
   * Hard limit on CLI sessions held at once. At the limit the least recently
   * used idle session is logged out; when every session is busy the call is
   * refused with `provider_rate_limited` instead of growing the pool.
   */
  maxSessions?: number;
  /** A session unused this long is logged out, wiped and forgotten (token included). */
  poolIdleMs?: number;
  /** Builds one session's provider (tests). */
  create?: (options: ProtonPassVaultProviderOptions) => ProtonPassVaultProvider;
};

export type ProtonPassPoolProviderOptions = {
  /**
   * The session scope, normally the Opengeni connection id. Providers with
   * the same connection id and token share one logged-in CLI session. Without
   * it the provider gets its own scope: a session no other provider uses.
   */
  connectionId?: string;
  /** Operations verified at setup; the provider is narrowed to them. */
  operations?: VaultProviderOperations;
};

export interface ProtonPassProviderPool {
  /**
   * A provider for one connection's token. Sessions are never shared across
   * connections, even for the same token, nor across tokens: each has its own
   * CLI login, state directory, key and cache. The session is created on the
   * first call, not here.
   */
  provider(token: string, options?: ProtonPassPoolProviderOptions): VaultProvider;
  /** Logs every session out and wipes their state directories; later calls are refused. */
  close(): Promise<void>;
  /** Sessions currently held (tests and diagnostics). */
  size(): number;
}

type Entry = {
  provider: ProtonPassVaultProvider;
  scope: string;
  lastUsed: number;
  active: number;
};

/**
 * A process-wide pool of Proton Pass CLI sessions. Logging in creates a
 * Proton session, so each connection logs in once and its session is reused
 * until it goes idle. Entries are keyed by an HMAC of scope and token under a
 * random per-pool key, so the map holds no token-derived value that outlives
 * the process.
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
  if (!Number.isInteger(maxSessions) || maxSessions < 1) {
    throw new RangeError("maxSessions must be a positive integer");
  }
  const now = providerOptions.now ?? Date.now;
  const key = randomBytes(32);
  const entries = new Map<string, Entry>();
  let sweeper: ReturnType<typeof setInterval> | null = null;
  let closed = false;

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

  function entryFor(scope: string, token: string): Entry {
    if (closed) {
      throw new VaultProviderError(
        "provider_unavailable",
        "The Proton Pass session pool is closed",
      );
    }
    const id = createHmac("sha256", key)
      .update(JSON.stringify([scope, token]))
      .digest("hex");
    sweep();
    const existing = entries.get(id);
    if (existing) return existing;
    // A new token for this scope (rotation): its old idle sessions go now.
    for (const [otherId, other] of entries) {
      if (other.scope === scope && other.active === 0) retire(otherId, other);
    }
    evictForRoom();
    if (entries.size >= maxSessions) {
      throw new VaultProviderError(
        "provider_rate_limited",
        "Every Proton Pass CLI session on this server is busy; try again shortly",
        PROTON_PASS_POOL_BUSY_RETRY_MS,
      );
    }
    const entry: Entry = {
      provider: create({ ...providerOptions, token }),
      scope,
      lastUsed: now(),
      active: 0,
    };
    entries.set(id, entry);
    if (!sweeper) {
      sweeper = setInterval(sweep, Math.max(1_000, Math.min(poolIdleMs, 60_000)));
      sweeper.unref?.();
    }
    return entry;
  }

  function tracked(scope: string, token: string): VaultProvider {
    const run = async <T>(work: (provider: ProtonPassVaultProvider) => Promise<T>): Promise<T> => {
      const entry = entryFor(scope, token);
      entry.active += 1;
      entry.lastUsed = now();
      try {
        return await work(entry.provider);
      } finally {
        entry.active -= 1;
        entry.lastUsed = now();
      }
    };
    return {
      id: "protonpass",
      capabilities: protonPassCapabilities,
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
    provider(token, { connectionId, operations } = {}) {
      const scope =
        connectionId === undefined ? `standalone:${randomUUID()}` : `connection:${connectionId}`;
      return restrictToOperations(tracked(scope, token), operations, FILE_FIELD_PREFIX);
    },
    async close() {
      closed = true;
      if (sweeper) clearInterval(sweeper);
      sweeper = null;
      const all = [...entries.values()];
      entries.clear();
      await Promise.all(all.map((entry) => entry.provider.close().catch(() => {})));
    },
    size: () => entries.size,
  };
}
