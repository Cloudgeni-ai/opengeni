import {
  isValidSecretName,
  VAULT_DEFAULT_PRIMARY_FIELD,
  VAULT_LIMITS,
  type VaultFieldKind,
  type VaultItemType,
  type VaultSyncStatus,
} from "@opengeni/contracts";
import {
  getProviderVaultSyncTarget,
  setVaultSyncStatus,
  upsertProviderVaultItems,
  type Database,
  type VaultDbContext,
} from "@opengeni/db";
import {
  isVaultProviderError,
  VaultProviderError,
  type ProviderItemMeta,
  type VaultProvider,
  type VaultProviderContext,
  type VaultProviderErrorCode,
  type VaultProviderRegistry,
} from "@opengeni/vaults";

/**
 * Provider vault metadata mirror (design §10.9, OP-1/OP-4). A linked
 * 1Password or host vault keeps a metadata-only mirror (item names, types,
 * websites, field names and kinds); values are always read live. A sync costs
 * one `listVaults` call and skips `listItems` entirely when the provider's
 * `contentVersion` is unchanged, so FAMILY-plan quotas are not burnt on
 * no-op refreshes.
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
  /** Items beyond `VAULT_LIMITS.itemsPerVault` that were not mirrored. */
  truncated: number;
}

export interface ProviderSyncStatusUpdate {
  syncStatus: VaultSyncStatus;
  syncErrorCode: VaultProviderErrorCode | null;
  syncErrorMessage: string | null;
  rateLimitedUntil: Date | null;
  /** Set only when the provider was reached and the mirror is current. */
  lastSyncedAt: Date | null;
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
 */
export function planProviderMirror(
  items: readonly ProviderItemMeta[],
  contentVersion: string | null,
): ProviderMirrorPlan {
  const ordered = [...items].sort(
    (a, b) =>
      nameKey(a.name).localeCompare(nameKey(b.name)) ||
      a.externalItemId.localeCompare(b.externalItemId),
  );
  const kept = ordered.slice(0, VAULT_LIMITS.itemsPerVault);
  const takenItems = new Set<string>();
  const mirrored = kept.map((item): ProviderMirrorItem => {
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
  return { contentVersion, items: mirrored, truncated: ordered.length - kept.length };
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
 * Refresh one linked vault's mirror. While `rateLimitedUntil` is in the future
 * the provider is not called at all unless `force` is set.
 */
export async function syncProviderVault(input: {
  provider: VaultProvider;
  ctx: VaultProviderContext;
  target: ProviderVaultSyncTarget;
  store: ProviderMirrorStore;
  now?: () => Date;
  /** Re-list items even when `contentVersion` is unchanged. */
  force?: boolean;
}): Promise<ProviderVaultSyncResult> {
  const now = input.now ?? (() => new Date());
  const { target } = input;
  if (
    target.rateLimitedUntil &&
    target.rateLimitedUntil.getTime() > now().getTime() &&
    !input.force
  ) {
    return { status: "skipped_rate_limited", rateLimitedUntil: target.rateLimitedUntil };
  }
  try {
    const vaults = await input.provider.listVaults(input.ctx);
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
    if (
      !input.force &&
      vault.contentVersion !== null &&
      vault.contentVersion === target.mirroredContentVersion
    ) {
      await input.store.setSyncStatus({
        syncStatus: "ok",
        syncErrorCode: null,
        syncErrorMessage: null,
        rateLimitedUntil: null,
        lastSyncedAt: now(),
      });
      return { status: "unchanged", contentVersion: vault.contentVersion };
    }
    const items = await input.provider.listItems(input.ctx, target.externalVaultId);
    const plan = planProviderMirror(items, vault.contentVersion);
    await input.store.replaceMirror(plan);
    await input.store.setSyncStatus({
      syncStatus: "ok",
      syncErrorCode: null,
      syncErrorMessage: null,
      rateLimitedUntil: null,
      lastSyncedAt: now(),
    });
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
      });
    },
  };
}

/**
 * Sync one linked vault the caller reaches: load its provider refs and mirror
 * version, resolve its provider, refresh the mirror and record sync status.
 */
export async function syncLinkedProviderVault(input: {
  db: Database;
  context: VaultDbContext;
  vaultId: string;
  providers: VaultProviderRegistry;
  budget?: VaultProviderContext["budget"];
  force?: boolean;
  now?: () => Date;
}): Promise<ProviderVaultSyncResult> {
  const target = await getProviderVaultSyncTarget(input.db, input.context, input.vaultId);
  const store = databaseProviderMirrorStore(input.db, input.context, input.vaultId);
  let provider: VaultProvider;
  try {
    provider = await input.providers.forVault({
      source: target.source,
      providerConnectionId: target.providerConnectionId,
    });
  } catch (error) {
    if (!isVaultProviderError(error)) throw error;
    const failure = providerSyncFailure(error, (input.now ?? (() => new Date()))());
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
    },
    target: {
      externalVaultId: target.providerVaultRef,
      mirroredContentVersion: target.providerContentVersion,
      rateLimitedUntil: target.rateLimitedUntil ? new Date(target.rateLimitedUntil) : null,
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

/** The vault fields a freshness check needs (a `VaultRow` has them all). */
export type LinkedVaultFreshness = {
  id: string;
  source: string;
  syncStatus: VaultSyncStatus;
  lastSyncedAt: string | null;
  rateLimitedUntil: string | null;
  updatedAt: string;
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

const linkedVaultRefreshes = new Map<string, Promise<ProviderVaultSyncResult | null>>();

/**
 * Bring stale linked vault mirrors up to date, so items added in the provider
 * (for example straight in 1Password) are found without anyone pressing Sync.
 *
 * Each refresh is the ordinary non-forced sync: one `listVaults` call, and an
 * item listing only when the provider says the vault changed. Refreshes of the
 * same vault share one call per process. The caller waits at most `waitMs`;
 * slower refreshes finish in the background and record their own status.
 * Never throws: failures are recorded as the vault's sync status.
 *
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
  const now = (input.now ?? (() => new Date()))();
  const stale = input.vaults.filter((vault) => linkedVaultNeedsRefresh(vault, input.maxAgeMs, now));
  if (stale.length === 0) return [];
  const changed: string[] = [];
  const runs = stale.map((vault) => {
    let run = linkedVaultRefreshes.get(vault.id);
    if (!run) {
      run = syncLinkedProviderVault({
        db: input.db,
        context: input.context,
        vaultId: vault.id,
        providers: input.providers,
        ...(input.now ? { now: input.now } : {}),
      })
        .catch(() => null)
        .finally(() => linkedVaultRefreshes.delete(vault.id));
      linkedVaultRefreshes.set(vault.id, run);
    }
    return run.then((result) => {
      if (result?.status === "synced") changed.push(vault.id);
    });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(runs),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, input.waitMs ?? LINKED_VAULT_REFRESH_WAIT_MS);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return [...changed];
}
