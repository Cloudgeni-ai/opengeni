import {
  isValidSecretName,
  VAULT_DEFAULT_PRIMARY_FIELD,
  VAULT_LIMITS,
  type VaultFieldKind,
  type VaultItemType,
  type VaultProviderFreshness,
  type VaultProviderOperations,
  type VaultSyncStatus,
} from "@opengeni/contracts";
import {
  getProviderVaultSyncTarget,
  setVaultSyncStatus,
  upsertProviderVaultItems,
  type Database,
  type StoredProviderFreshness,
  type VaultDbContext,
} from "@opengeni/db";
import {
  isVaultProviderError,
  listProviderItems,
  listProviderVaults,
  providerOperations,
  VaultProviderError,
  type ProviderItemMeta,
  type VaultProvider,
  type VaultProviderContext,
  type VaultProviderErrorCode,
  type VaultProviderRegistry,
} from "@opengeni/vaults";

/**
 * Provider vault metadata mirror (design §10.9, OP-1/OP-4; external vaults
 * §8–§9). A linked vault keeps a metadata-only mirror (item names, types,
 * websites, field names and kinds); values are always read live. A sync costs
 * one vault listing and skips the item listing entirely when the provider's
 * `contentVersion` is unchanged, so FAMILY-plan quotas are not burnt on
 * no-op refreshes.
 *
 * Only a complete, successful traversal replaces the mirror: interrupted,
 * malformed or over-limit inventories (more than `VAULT_LIMITS.itemsPerVault`
 * items) keep the previous mirror and record the failure. An active provider
 * rate limit is never bypassed, not even by a forced refresh.
 *
 * The engine is storage-agnostic: the vault service binds `ProviderMirrorStore`
 * to its tables (`vault_items`, `vault_item_fields`, `vaults.sync_status`,
 * `vaults.rate_limited_until`).
 */

export interface ProviderMirrorField {
  externalFieldId: string;
  name: string;
  kind: VaultFieldKind;
  position: number;
}

export interface ProviderMirrorItem {
  externalItemId: string;
  /** Valid, vault-unique (case-insensitive) secret name. */
  name: string;
  /** The provider's own name, kept when it had to be sanitized or de-duplicated. */
  providerName: string;
  type: VaultItemType;
  websites: string[];
  fields: ProviderMirrorField[];
  primaryExternalFieldId: string | null;
  hasTotp: boolean;
  version: string | null;
  updatedAt: string | null;
}

export interface ProviderMirrorPlan {
  contentVersion: string | null;
  items: ProviderMirrorItem[];
  /**
   * Always 0. A provider vault with more than `VAULT_LIMITS.itemsPerVault`
   * items is refused whole (`provider_inventory_incomplete`), never mirrored
   * as its first items. Kept for compatibility with earlier callers.
   */
  truncated: number;
}

export interface ProviderSyncStatusUpdate {
  syncStatus: VaultSyncStatus;
  syncErrorCode: VaultProviderErrorCode | null;
  syncErrorMessage: string | null;
  rateLimitedUntil: Date | null;
  /** Set only when the provider was reached and the mirror is current. */
  lastSyncedAt: Date | null;
  /**
   * The provider's effective operations for this vault, recorded on every
   * successful check (absent: keep the stored operations).
   */
  operations?: VaultProviderOperations | null;
  /**
   * The provider's own upstream freshness observation from this check; null
   * when it reported none (absent: keep the stored observation). Never
   * Opengeni's own check time.
   */
  freshness?: StoredProviderFreshness | null;
}

export interface ProviderMirrorStore {
  /** Replace the mirror for this vault in one transaction (upsert by external id, drop missing). */
  replaceMirror(plan: ProviderMirrorPlan): Promise<void>;
  setSyncStatus(update: ProviderSyncStatusUpdate): Promise<void>;
}

export interface ProviderVaultSyncTarget {
  externalVaultId: string;
  /** `contentVersion` recorded by the last successful mirror, if any. */
  mirroredContentVersion: string | null;
  rateLimitedUntil: Date | null;
  /** The vault's durable value-cache epoch (0786), passed to the provider as `cacheEpoch`. */
  cacheEpoch?: string | null;
}

export type ProviderVaultSyncResult =
  | { status: "synced"; contentVersion: string | null; itemCount: number; truncated: number }
  | { status: "unchanged"; contentVersion: string | null }
  | { status: "skipped_rate_limited"; rateLimitedUntil: Date }
  | {
      status: "failed";
      syncStatus: VaultSyncStatus;
      code: VaultProviderErrorCode;
      rateLimitedUntil: Date | null;
    };

/** When the provider gives no retry hint, back off this long after a 429. */
export const PROVIDER_RATE_LIMIT_DEFAULT_BACKOFF_MS = 15 * 60_000;

function incompleteInventory(): VaultProviderError {
  return new VaultProviderError(
    "provider_inventory_incomplete",
    `This vault has more than ${VAULT_LIMITS.itemsPerVault} items, more than Opengeni mirrors. The previous inventory was kept.`,
  );
}

// Same forbidden set as `isValidSecretName` (Q-10).
// oxlint-disable-next-line no-control-regex
const FORBIDDEN_NAME_CHARACTERS = /[/{}#\\\u0000-\u001f\u007f-\u009f]/g;

function nameKey(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

function truncateChars(value: string, max: number): string {
  const chars = [...value];
  return chars.length > max ? chars.slice(0, max).join("") : value;
}

/** Map a provider item name onto a valid secret name (Q-10). */
export function providerSecretName(raw: string, fallback = "Untitled"): string {
  let name = truncateChars(
    raw.normalize("NFC").replace(FORBIDDEN_NAME_CHARACTERS, "-").trim(),
    VAULT_LIMITS.nameMaxChars,
  ).trim();
  if (!name) name = fallback;
  if (/^id:/iu.test(name)) name = `id-${name.slice(3)}`.trim() || fallback;
  return isValidSecretName(name) ? name : fallback;
}

/** Appends " (2)", " (3)" … until the name is unique case-insensitively. */
export function uniqueProviderName(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let n = 2; taken.has(nameKey(candidate)); n += 1) {
    const suffix = ` (${n})`;
    candidate = `${truncateChars(name, VAULT_LIMITS.nameMaxChars - suffix.length).trimEnd()}${suffix}`;
  }
  taken.add(nameKey(candidate));
  return candidate;
}

const PRIMARY_FIELD_FALLBACK = ["password", "value", "credential", "note"] as const;

/**
 * The field a bare `vault/item` reference resolves to: the item type's default
 * (§10B.2), then password → value → credential → note by name, then the first
 * concealed field. TOTP fields are never primary (they have `/otp`).
 */
export function providerPrimaryFieldId(
  item: Pick<ProviderItemMeta, "type" | "fields">,
): string | null {
  const candidates = item.fields.filter((field) => field.kind !== "totp");
  const byName = (name: string) =>
    candidates.find((field) => nameKey(field.name) === name)?.externalFieldId ?? null;
  const typeDefault = VAULT_DEFAULT_PRIMARY_FIELD[item.type];
  if (typeDefault) {
    const found = byName(typeDefault.toLowerCase());
    if (found) return found;
  }
  for (const name of PRIMARY_FIELD_FALLBACK) {
    const found = byName(name);
    if (found) return found;
  }
  if (item.type === "file") {
    const file = candidates.find((field) => field.kind === "file");
    if (file) return file.externalFieldId;
  }
  return candidates.find((field) => field.kind === "concealed")?.externalFieldId ?? null;
}

/**
 * Deterministic mirror projection. Items are ordered by provider name then
 * external id before de-duplication, so the same provider state always yields
 * the same Opengeni names; field names are de-duplicated within each item.
 * More than `VAULT_LIMITS.itemsPerVault` items is refused with
 * `provider_inventory_incomplete`: a partial mirror would present the first
 * items of a larger vault as its complete contents.
 */
export function planProviderMirror(
  items: readonly ProviderItemMeta[],
  contentVersion: string | null,
): ProviderMirrorPlan {
  if (items.length > VAULT_LIMITS.itemsPerVault) throw incompleteInventory();
  const ordered = [...items].sort(
    (a, b) =>
      nameKey(a.name).localeCompare(nameKey(b.name)) ||
      a.externalItemId.localeCompare(b.externalItemId),
  );
  const takenItems = new Set<string>();
  const mirrored = ordered.map((item): ProviderMirrorItem => {
    const name = uniqueProviderName(providerSecretName(item.name), takenItems);
    const takenFields = new Set<string>();
    const fields = item.fields
      .slice(0, VAULT_LIMITS.fieldsPerItem)
      .map((field, position): ProviderMirrorField => {
        let fieldName = providerSecretName(
          field.name,
          field.kind === "totp" ? "one-time password" : "field",
        );
        if (nameKey(fieldName) === "otp") fieldName = "otp code";
        return {
          externalFieldId: field.externalFieldId,
          name: uniqueProviderName(fieldName, takenFields),
          kind: field.kind,
          position,
        };
      });
    return {
      externalItemId: item.externalItemId,
      name,
      providerName: item.name,
      type: item.type,
      websites: item.websites
        .filter((website) => website.length <= VAULT_LIMITS.websiteMaxChars)
        .slice(0, VAULT_LIMITS.websitesPerItem),
      fields,
      primaryExternalFieldId: providerPrimaryFieldId({ type: item.type, fields: item.fields }),
      hasTotp: item.fields.some((field) => field.kind === "totp"),
      version: item.version,
      updatedAt: item.updatedAt,
    };
  });
  return { contentVersion, items: mirrored, truncated: 0 };
}

function validTime(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * One freshness observation for a whole check: `cache` when any page came
 * from a cache, `live` only when every page was live, otherwise `unknown`.
 * `sourceSyncedAt` is the oldest upstream synchronization any page reported
 * (never later than the check itself), and unknown (null) when a non-live
 * page did not say. Null when the provider reported nothing: Opengeni's own
 * check time never stands in for the provider's.
 */
export function aggregateProviderFreshness(
  observations: readonly VaultProviderFreshness[],
  checkedAt: Date,
): StoredProviderFreshness | null {
  if (observations.length === 0) return null;
  let cache = false;
  let unknown = false;
  let unknownTime = false;
  let oldest: number | null = null;
  for (const observation of observations) {
    const source = observation?.source;
    if (source === "cache") cache = true;
    else if (source !== "live") unknown = true;
    const time = validTime(observation?.sourceSyncedAt);
    if (time !== null) oldest = oldest === null ? time : Math.min(oldest, time);
    else if (source !== "live") unknownTime = true;
  }
  const syncedAt =
    unknownTime || oldest === null ? null : new Date(Math.min(oldest, checkedAt.getTime()));
  return {
    source: cache ? "cache" : unknown ? "unknown" : "live",
    sourceSyncedAt: syncedAt ? syncedAt.toISOString() : null,
  };
}

/** Sync status for a provider failure; rate limits persist `rateLimitedUntil`. */
export function providerSyncFailure(
  error: unknown,
  now: Date,
): ProviderSyncStatusUpdate & { syncErrorCode: VaultProviderErrorCode } {
  const code: VaultProviderErrorCode = isVaultProviderError(error)
    ? error.code
    : "provider_unavailable";
  const message = isVaultProviderError(error)
    ? error.message
    : "the vault provider could not be reached";
  if (code === "provider_rate_limited") {
    const retryAfterMs =
      isVaultProviderError(error) && error.retryAfterMs && error.retryAfterMs > 0
        ? error.retryAfterMs
        : PROVIDER_RATE_LIMIT_DEFAULT_BACKOFF_MS;
    return {
      syncStatus: "rate_limited",
      syncErrorCode: code,
      syncErrorMessage: message,
      rateLimitedUntil: new Date(now.getTime() + retryAfterMs),
      lastSyncedAt: null,
    };
  }
  return {
    syncStatus:
      code === "provider_auth_expired" || code === "provider_auth_invalid"
        ? "auth_expired"
        : "error",
    syncErrorCode: code,
    syncErrorMessage: message,
    rateLimitedUntil: null,
    lastSyncedAt: null,
  };
}

/**
 * A provider call whose failure is recorded as sync state. Errors that are not
 * provider errors (adapter defects, timeouts, aborted requests) become a safe
 * `provider_unavailable`; their messages are never stored or shown.
 */
async function providerStep<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (isVaultProviderError(error)) throw error;
    throw new VaultProviderError(
      "provider_unavailable",
      "the vault provider could not be reached or gave an invalid answer",
    );
  }
}

/**
 * Refresh one linked vault's mirror. While `rateLimitedUntil` is in the future
 * the provider is not called at all, even when `force` is set.
 *
 * `force` re-lists items even when `contentVersion` is unchanged and asks the
 * provider to bypass its caches (`forceRefresh`). Every successful check
 * records the provider's effective operations and its own freshness
 * observation, whether or not the mirror changed.
 */
export async function syncProviderVault(input: {
  provider: VaultProvider;
  ctx: VaultProviderContext;
  target: ProviderVaultSyncTarget;
  store: ProviderMirrorStore;
  now?: () => Date;
  /** Re-list items even when `contentVersion` is unchanged, bypassing provider caches. */
  force?: boolean;
}): Promise<ProviderVaultSyncResult> {
  const now = input.now ?? (() => new Date());
  const { target } = input;
  if (target.rateLimitedUntil && target.rateLimitedUntil.getTime() > now().getTime()) {
    return { status: "skipped_rate_limited", rateLimitedUntil: target.rateLimitedUntil };
  }
  const observations: VaultProviderFreshness[] = [];
  const outer = input.ctx.onFreshness;
  const ctx: VaultProviderContext = {
    ...input.ctx,
    ...(target.cacheEpoch !== undefined && input.ctx.cacheEpoch === undefined
      ? { cacheEpoch: target.cacheEpoch }
      : {}),
    ...(input.force ? { forceRefresh: true } : {}),
    onFreshness(freshness) {
      observations.push(freshness);
      outer?.(freshness);
    },
  };
  const succeeded = (): ProviderSyncStatusUpdate => {
    const checkedAt = now();
    return {
      syncStatus: "ok",
      syncErrorCode: null,
      syncErrorMessage: null,
      rateLimitedUntil: null,
      lastSyncedAt: checkedAt,
      freshness: aggregateProviderFreshness(observations, checkedAt),
    };
  };
  try {
    const vaults = await providerStep(() => listProviderVaults(input.provider, ctx));
    const vault = vaults.find((candidate) => candidate.externalVaultId === target.externalVaultId);
    if (!vault) {
      const failure = providerSyncFailure(
        new VaultProviderError(
          "provider_not_found",
          "the linked provider vault no longer exists or is no longer shared with this connection",
        ),
        now(),
      );
      await input.store.setSyncStatus(failure);
      return {
        status: "failed",
        syncStatus: failure.syncStatus,
        code: failure.syncErrorCode,
        rateLimitedUntil: null,
      };
    }
    const operations = providerOperations(input.provider.capabilities(), vault);
    if (
      !input.force &&
      vault.contentVersion !== null &&
      vault.contentVersion === target.mirroredContentVersion
    ) {
      await input.store.setSyncStatus({ ...succeeded(), operations });
      return { status: "unchanged", contentVersion: vault.contentVersion };
    }
    const items = await providerStep(() =>
      listProviderItems(input.provider, ctx, target.externalVaultId),
    );
    const plan = planProviderMirror(items, vault.contentVersion);
    await input.store.replaceMirror(plan);
    await input.store.setSyncStatus({ ...succeeded(), operations });
    return {
      status: "synced",
      contentVersion: plan.contentVersion,
      itemCount: plan.items.length,
      truncated: plan.truncated,
    };
  } catch (error) {
    if (!isVaultProviderError(error)) throw error;
    const failure = providerSyncFailure(error, now());
    await input.store.setSyncStatus(failure);
    return {
      status: "failed",
      syncStatus: failure.syncStatus,
      code: failure.syncErrorCode,
      rateLimitedUntil: failure.rateLimitedUntil,
    };
  }
}

/** Binds the mirror store to the 0739 routines for one connected vault. */
export function databaseProviderMirrorStore(
  db: Database,
  context: VaultDbContext,
  vaultId: string,
): ProviderMirrorStore {
  return {
    async replaceMirror(plan) {
      await upsertProviderVaultItems(db, context, {
        vaultId,
        contentVersion: plan.contentVersion,
        items: plan.items.map((item) => ({
          providerItemRef: item.externalItemId,
          providerVersion: item.version,
          // Passkeys live only in hosted vaults (D20); providers never mirror them.
          type: item.type === "passkey" ? "login" : item.type,
          // The base name: the routine de-duplicates against the stored mirror
          // so names stay sticky per provider item.
          name: providerSecretName(item.providerName),
          websites: item.websites,
          primaryFieldRef: item.primaryExternalFieldId,
          fields: item.fields.map((field) => ({
            providerFieldRef: field.externalFieldId,
            name: field.name,
            kind: field.kind,
          })),
        })),
      });
    },
    async setSyncStatus(update) {
      await setVaultSyncStatus(db, context, {
        vaultId,
        status: update.syncStatus,
        errorCode: update.syncErrorCode,
        errorMessage: update.syncErrorMessage,
        rateLimitedUntil: update.rateLimitedUntil?.toISOString() ?? null,
        ...(update.operations !== undefined ? { operations: update.operations } : {}),
        ...(update.freshness !== undefined ? { freshness: update.freshness } : {}),
      });
    },
  };
}

/**
 * Sync one linked vault the caller reaches: load its provider refs and mirror
 * version, resolve its provider, refresh the mirror and record sync status.
 * The provider context carries the vault's durable cache epoch; the
 * registry binds the trusted authority, never this caller.
 */
export async function syncLinkedProviderVault(input: {
  db: Database;
  context: VaultDbContext;
  vaultId: string;
  providers: VaultProviderRegistry;
  budget?: VaultProviderContext["budget"];
  /** Re-list items and bypass provider caches; an active rate limit still applies. */
  force?: boolean;
  now?: () => Date;
  signal?: AbortSignal;
  /** Runtime-only observation of the provider's freshness reports. */
  onFreshness?: VaultProviderContext["onFreshness"];
}): Promise<ProviderVaultSyncResult> {
  const target = await getProviderVaultSyncTarget(input.db, input.context, input.vaultId);
  const store = databaseProviderMirrorStore(input.db, input.context, input.vaultId);
  const now = input.now ?? (() => new Date());
  const rateLimitedUntil = target.rateLimitedUntil ? new Date(target.rateLimitedUntil) : null;
  // Do not even load a provider (and its credential) while the provider asked us to wait.
  if (rateLimitedUntil && rateLimitedUntil.getTime() > now().getTime()) {
    return { status: "skipped_rate_limited", rateLimitedUntil };
  }
  let provider: VaultProvider;
  try {
    provider = await input.providers.forVault({
      source: target.source,
      providerConnectionId: target.providerConnectionId,
    });
  } catch (error) {
    if (!isVaultProviderError(error)) throw error;
    const failure = providerSyncFailure(error, now());
    await store.setSyncStatus(failure);
    return {
      status: "failed",
      syncStatus: failure.syncStatus,
      code: failure.syncErrorCode,
      rateLimitedUntil: failure.rateLimitedUntil,
    };
  }
  return await syncProviderVault({
    provider,
    ctx: {
      connectionId: target.providerConnectionId,
      budget: input.budget ?? { take() {} },
      cacheEpoch: target.providerCacheEpoch ?? null,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onFreshness ? { onFreshness: input.onFreshness } : {}),
    },
    target: {
      externalVaultId: target.providerVaultRef,
      mirroredContentVersion: target.providerContentVersion,
      rateLimitedUntil,
      cacheEpoch: target.providerCacheEpoch ?? null,
    },
    store,
    ...(input.now ? { now: input.now } : {}),
    ...(input.force ? { force: true } : {}),
  });
}

/** How stale a linked vault's mirror may be before a search refreshes it. */
export const LINKED_VAULT_SEARCH_MAX_AGE_MS = 10 * 60_000;
/** How stale it may be before a reference that found nothing refreshes it. */
export const LINKED_VAULT_MISS_MAX_AGE_MS = 2 * 60_000;
/** How long a search or resolution waits for refreshes before answering. */
export const LINKED_VAULT_REFRESH_WAIT_MS = 8_000;
/**
 * How long a person opening a linked vault waits for its stale mirror to
 * refresh before the page shows what is mirrored; a slower refresh finishes in
 * the background and the next load shows it.
 */
export const LINKED_VAULT_OPEN_WAIT_MS = 3_000;
/**
 * How long one background refresh may run. Afterwards it is abandoned for
 * de-duplication, so one unresponsive provider cannot pin a vault as
 * "refreshing" for every later caller.
 */
export const LINKED_VAULT_REFRESH_TIMEOUT_MS = 60_000;

/** The vault fields a freshness check needs (a `VaultRow` has them all). */
export type LinkedVaultFreshness = {
  id: string;
  source: string;
  syncStatus: VaultSyncStatus;
  lastSyncedAt: string | null;
  rateLimitedUntil: string | null;
  updatedAt: string;
  syncErrorCode?: string | null;
  providerFreshness?: StoredProviderFreshness | null;
};

/**
 * Whether a linked vault's mirror is older than `maxAgeMs`. A vault whose last
 * sync failed counts from that failure (it is recorded as `updatedAt`), so a
 * broken connection is retried once per `maxAgeMs`, not on every call. A vault
 * under a provider rate limit is never stale until the limit lifts.
 */
export function linkedVaultNeedsRefresh(
  vault: LinkedVaultFreshness,
  maxAgeMs: number,
  now: Date,
): boolean {
  if (vault.source === "opengeni") return false;
  if (vault.rateLimitedUntil && new Date(vault.rateLimitedUntil).getTime() > now.getTime()) {
    return false;
  }
  const last =
    vault.syncStatus === "ok" || vault.syncStatus === "syncing"
      ? vault.lastSyncedAt
      : vault.updatedAt;
  if (!last) return true;
  return now.getTime() - new Date(last).getTime() >= maxAgeMs;
}

function isoOrNull(value: string | null | undefined): string | null {
  const time = validTime(value);
  return time === null ? null : new Date(time).toISOString();
}

/**
 * The freshness a person or agent sees for a linked vault (design §9);
 * undefined for hosted vaults. `lastCheckedAt` is Opengeni's last successful
 * check; `source` and `sourceSyncedAt` are only what the provider itself
 * reported then. `current` means checked successfully within `maxAgeMs`;
 * `stale` means not recently checked (or a rate limit just lifted);
 * `refreshing` means a check is running; `unavailable` means the last check
 * failed, with its safe error code and, under a rate limit, the retry time.
 */
export function providerVaultFreshness(
  vault: LinkedVaultFreshness,
  now: Date,
  options: { maxAgeMs?: number; refreshing?: boolean } = {},
): VaultProviderFreshness | undefined {
  if (vault.source === "opengeni") return undefined;
  const stored = vault.providerFreshness ?? null;
  const failed = vault.syncStatus !== "ok" && vault.syncStatus !== "syncing";
  const base = {
    lastCheckedAt: isoOrNull(vault.lastSyncedAt),
    sourceSyncedAt: isoOrNull(stored?.sourceSyncedAt),
    source:
      stored?.source === "live" || stored?.source === "cache"
        ? stored.source
        : ("unknown" as const),
    errorCode: failed && vault.syncErrorCode ? vault.syncErrorCode.slice(0, 100) : null,
    retryAt: null as string | null,
  };
  if (options.refreshing || vault.syncStatus === "syncing") return { state: "refreshing", ...base };
  if (vault.syncStatus === "rate_limited") {
    const retryAt = isoOrNull(vault.rateLimitedUntil);
    if (retryAt !== null && Date.parse(retryAt) > now.getTime()) {
      return { state: "unavailable", ...base, retryAt };
    }
    return { state: "stale", ...base };
  }
  if (failed) return { state: "unavailable", ...base };
  const checked = base.lastCheckedAt === null ? null : Date.parse(base.lastCheckedAt);
  const maxAgeMs = options.maxAgeMs ?? LINKED_VAULT_SEARCH_MAX_AGE_MS;
  if (checked === null || now.getTime() - checked >= maxAgeMs) return { state: "stale", ...base };
  return { state: "current", ...base };
}

/**
 * Whose refresh this is: concurrent refreshes share one provider call only
 * within the same tenant, workspace and acting principal, because the
 * provider registry (and its credential) is bound to that authority.
 */
export function vaultRefreshScopeKey(context: VaultDbContext): string {
  if (context.kind === "subject") {
    return `${context.accountId}|${context.workspaceId}|subject|${context.subjectId}`;
  }
  const principal = context.principal;
  switch (principal.kind) {
    case "attempt":
      return `${principal.accountId}|${principal.workspaceId}|attempt|${principal.attemptId}|${principal.executionGeneration}`;
    case "site_viewer":
      return `${principal.accountId}|${principal.workspaceId}|site|${principal.siteId}|${principal.siteVersion}|${principal.subjectId}`;
    case "human":
      return `${principal.accountId}|${principal.workspaceId}|human|${principal.subjectId}|${principal.viaApiKey ? "key" : principal.verifiedHuman ? "verified" : "unverified"}`;
  }
}

const linkedVaultRefreshes = new Map<string, Promise<ProviderVaultSyncResult | null>>();

export type LinkedVaultRefreshOutcome = {
  vaultId: string;
  /**
   * `not_due`: hosted, recently checked, or under an active rate limit (no
   * provider call); `pending`: still running when the wait ended; `done`:
   * finished with `result`; `failed`: the refresh itself failed unexpectedly.
   */
  state: "not_due" | "pending" | "done" | "failed";
  result: ProviderVaultSyncResult | null;
};

export type LinkedVaultRefreshReport = {
  outcomes: LinkedVaultRefreshOutcome[];
  /** Vaults whose mirror changed before the wait ended. */
  changed: string[];
  /** Vaults whose refresh was still running when the wait ended. */
  pending: string[];
};

/**
 * Bring linked vault mirrors up to date, so items added in the provider (for
 * example straight in 1Password) are found without anyone pressing Sync.
 *
 * Without `force`, only vaults older than `maxAgeMs` refresh, with the
 * ordinary sync (one vault listing; an item listing only when the provider
 * says the vault changed). `force` re-lists every given provider vault and
 * bypasses provider caches, but never an active rate limit. Refreshes of the
 * same vault by the same principal share one call per process. The caller
 * waits at most `waitMs`; slower refreshes finish in the background and
 * record their own status. Never throws: failures are recorded as the vault's
 * sync status.
 */
export async function refreshLinkedVaults(input: {
  db: Database;
  context: VaultDbContext;
  vaults: readonly LinkedVaultFreshness[];
  providers: VaultProviderRegistry;
  /** Refresh vaults whose last check is at least this old (default: the search age). */
  maxAgeMs?: number;
  force?: boolean;
  waitMs?: number;
  now?: () => Date;
}): Promise<LinkedVaultRefreshReport> {
  const now = (input.now ?? (() => new Date()))();
  const maxAgeMs = input.maxAgeMs ?? LINKED_VAULT_SEARCH_MAX_AGE_MS;
  const scope = vaultRefreshScopeKey(input.context);
  const outcomes = new Map<string, LinkedVaultRefreshOutcome>();
  const changed: string[] = [];
  const runs: Promise<void>[] = [];
  for (const vault of input.vaults) {
    if (outcomes.has(vault.id)) continue;
    const limited =
      vault.rateLimitedUntil !== null && new Date(vault.rateLimitedUntil).getTime() > now.getTime();
    const due =
      vault.source !== "opengeni" &&
      !limited &&
      (input.force || linkedVaultNeedsRefresh(vault, maxAgeMs, now));
    const outcome: LinkedVaultRefreshOutcome = {
      vaultId: vault.id,
      state: due ? "pending" : "not_due",
      result: null,
    };
    outcomes.set(vault.id, outcome);
    if (!due) continue;
    const key = `${scope}|${vault.id}|${input.force ? "force" : "stale"}`;
    let run = linkedVaultRefreshes.get(key);
    if (!run) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      run = Promise.race([
        syncLinkedProviderVault({
          db: input.db,
          context: input.context,
          vaultId: vault.id,
          providers: input.providers,
          signal: AbortSignal.timeout(LINKED_VAULT_REFRESH_TIMEOUT_MS),
          ...(input.force ? { force: true } : {}),
          ...(input.now ? { now: input.now } : {}),
        }),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), LINKED_VAULT_REFRESH_TIMEOUT_MS);
          timer.unref?.();
        }),
      ])
        .catch(() => {
          outcome.state = "failed";
          return null;
        })
        .finally(() => {
          if (timer) clearTimeout(timer);
          linkedVaultRefreshes.delete(key);
        });
      linkedVaultRefreshes.set(key, run);
    }
    runs.push(
      run.then((result) => {
        if (outcome.state === "pending") outcome.state = result ? "done" : "failed";
        outcome.result = result;
        if (result?.status === "synced") changed.push(vault.id);
      }),
    );
  }
  if (runs.length > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(runs),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, input.waitMs ?? LINKED_VAULT_REFRESH_WAIT_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
  const list = [...outcomes.values()].map((outcome) => ({ ...outcome }));
  return {
    outcomes: list,
    changed: [...changed],
    pending: list
      .filter((outcome) => outcome.state === "pending")
      .map((outcome) => outcome.vaultId),
  };
}

/**
 * The ordinary stale refresh (`refreshLinkedVaults` without `force`).
 * Returns the ids of the vaults whose mirror changed before the wait ended.
 */
export async function refreshStaleLinkedVaults(input: {
  db: Database;
  context: VaultDbContext;
  vaults: readonly LinkedVaultFreshness[];
  providers: VaultProviderRegistry;
  maxAgeMs: number;
  waitMs?: number;
  now?: () => Date;
}): Promise<string[]> {
  const report = await refreshLinkedVaults(input);
  return report.changed;
}
