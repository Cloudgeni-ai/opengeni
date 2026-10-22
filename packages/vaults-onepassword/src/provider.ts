import {
  type ProviderCallBudget,
  type ProviderFieldValue,
  type ProviderItemMeta,
  type ProviderVault,
  type SecretMaterial,
  type VaultProvider,
  type VaultProviderCapabilities,
  type VaultProviderContext,
  VaultProviderError,
  parseTotpInput,
} from "./contract";
import {
  ONEPASSWORD_REQUEST_COST,
  type OnePasswordOperation,
  type OnePasswordPlanTier,
  type ProviderCallOp,
  onePasswordQuotaFor,
} from "./budget";
import { isOnePasswordSessionError, mapOnePasswordError } from "./errors";
import { applyWrite, buildCreateParams, mapItemFields, toProviderItemMeta } from "./mapping";
import {
  ONEPASSWORD_INTEGRATION_NAME,
  type OnePasswordClientCache,
  type OnePasswordSdk,
  type OnePasswordSdkClient,
  type SdkItem,
  loadOnePasswordSdk,
  sharedOnePasswordClientCache,
} from "./sdk";
import { describeOnePasswordToken, onePasswordTokenFingerprint } from "./token";

/** design §10.9 / VAULT_LIMITS.providerValueCacheMs */
export const ONEPASSWORD_VALUE_CACHE_MS = 60_000;
/** Items per `items.getAll` request when mirroring metadata. */
export const ONEPASSWORD_GET_ALL_BATCH = 50;

/**
 * Group permissions granted on a managed vault: the Teams "edit" bundle
 * (read, reveal, item history, create, update, archive, delete).
 */
export const ONEPASSWORD_MANAGED_GROUP_PERMISSIONS = 32 | 16 | 1024 | 128 | 64 | 256 | 512;

/** Creation succeeded; only the subsequent sharing step failed or is unknown. */
export class OnePasswordVaultCreatedError extends VaultProviderError {
  constructor(
    readonly createdVault: ProviderVault,
    failure: VaultProviderError,
  ) {
    super(
      failure.code,
      "The vault was created, but its group access could not be confirmed. Do not create it again.",
      failure.retryAfterMs,
    );
  }
}

/**
 * 1Password vault and item IDs are short lowercase alphanumerics (26 chars).
 * Anything else cannot exist, so refuse it as not found before spending a
 * request (and before the SDK reports it as a generic validation error).
 */
const ONEPASSWORD_ID = /^[a-z0-9]{1,64}$/i;
function assertOnePasswordIds(...ids: Array<string | undefined>) {
  for (const id of ids) {
    if (id !== undefined && !ONEPASSWORD_ID.test(id)) {
      throw new VaultProviderError("provider_not_found", "No such 1Password vault or item");
    }
  }
}

export type OnePasswordVaultProviderOptions = {
  token: string;
  planTier?: OnePasswordPlanTier;
  /** Injected SDK (tests); defaults to the pinned dynamic import. */
  sdk?: OnePasswordSdk | (() => Promise<OnePasswordSdk>);
  clientCache?: OnePasswordClientCache;
  integrationVersion?: string;
  now?: () => number;
  valueCacheMs?: number;
};

export type OnePasswordVaultProvider = VaultProvider & {
  readonly planTier: OnePasswordPlanTier;
  /** Deletes a vault this service account created (managed-vault cleanup, live tests). */
  deleteVault(ctx: VaultProviderContext, externalVaultId: string): Promise<void>;
  /** Permanently deletes an item (live-test cleanup only; product paths archive). */
  deleteItem(
    ctx: VaultProviderContext,
    externalVaultId: string,
    externalItemId: string,
  ): Promise<void>;
};

type CachedItem = { at: number; epoch: string | null; item: Promise<SdkItem> };

/**
 * Values never outlive the attempt that read them: the cache is keyed by the
 * attempt's budget object (one per attempt or request), so it is dropped with it.
 * Within an attempt, entries are scoped to the connection and token that read
 * them, and to the vault's durable cache epoch: a mirror refresh in any API or
 * worker process advances the epoch, so later reads fetch the item again.
 */
const attemptItemCaches = new WeakMap<ProviderCallBudget, Map<string, CachedItem>>();

export function createOnePasswordVaultProvider(
  options: OnePasswordVaultProviderOptions,
): OnePasswordVaultProvider {
  const token = options.token.trim();
  const planTier = options.planTier ?? "teams";
  const now = options.now ?? Date.now;
  const clients = options.clientCache ?? sharedOnePasswordClientCache;
  const valueCacheMs = options.valueCacheMs ?? ONEPASSWORD_VALUE_CACHE_MS;
  const description = describeOnePasswordToken(token);
  let fingerprint: Promise<string> | null = null;
  let sdkPromise: Promise<OnePasswordSdk> | null = null;

  const loadSdk = () => {
    sdkPromise ??=
      typeof options.sdk === "function"
        ? options.sdk()
        : options.sdk
          ? Promise.resolve(options.sdk)
          : loadOnePasswordSdk();
    return sdkPromise;
  };

  async function keys(ctx: VaultProviderContext) {
    fingerprint ??= onePasswordTokenFingerprint(token);
    const tokenKey = await fingerprint;
    return {
      client: `${ctx.connectionId ?? "token"}:${tokenKey}`,
      quota: ctx.connectionId ?? `token:${tokenKey}`,
    };
  }

  async function call<T>(
    ctx: VaultProviderContext,
    op: ProviderCallOp,
    operation: OnePasswordOperation,
    fn: (client: OnePasswordSdkClient) => Promise<T>,
  ): Promise<T> {
    ctx.signal?.throwIfAborted();
    const key = await keys(ctx);
    const quota = onePasswordQuotaFor(key.quota, planTier, now);
    ctx.budget.take(op);
    // A cold client signs in first; charge that before spending anything.
    const cost =
      ONEPASSWORD_REQUEST_COST[operation] +
      (clients.has(key.client) ? 0 : ONEPASSWORD_REQUEST_COST.signIn);
    quota.take(op, cost);
    const sdk = await loadSdk();
    const classes = {
      ...(sdk.RateLimitExceededError ? { RateLimitExceededError: sdk.RateLimitExceededError } : {}),
      ...(sdk.AuthExpiredError ? { AuthExpiredError: sdk.AuthExpiredError } : {}),
    };
    for (let attempt = 0; ; attempt += 1) {
      // Set once a mutation is handed to the SDK: a failure 1Password does not
      // classify after that may still have been applied.
      let sent = false;
      try {
        const client = await clients.get(key.client, () =>
          sdk.createClient({
            auth: token,
            integrationName: ONEPASSWORD_INTEGRATION_NAME,
            integrationVersion: options.integrationVersion ?? "1",
          }),
        );
        sent =
          op === "write" ||
          operation === "vaultsCreate" ||
          operation === "vaultsDelete" ||
          operation === "grantGroupPermissions";
        return await fn(client);
      } catch (error) {
        const mapped = mapOnePasswordError(error, classes);
        if (mapped.code === "provider_rate_limited" && mapped.retryAfterMs) {
          quota.block(mapped.retryAfterMs);
        }
        if (mapped.code === "provider_auth_expired" || mapped.code === "provider_auth_invalid") {
          clients.drop(key.client);
        }
        if (attempt === 0 && isOnePasswordSessionError(mapped)) continue;
        if (sent && mapped.code === "provider_unavailable") {
          // Never reported as a plain failure that invites saving it again.
          throw new VaultProviderError(
            "provider_outcome_unknown",
            "1Password did not confirm the change; it may have been applied",
          );
        }
        throw mapped;
      }
    }
  }

  function itemCache(ctx: VaultProviderContext): Map<string, CachedItem> {
    let cache = attemptItemCaches.get(ctx.budget);
    if (!cache) {
      cache = new Map();
      attemptItemCaches.set(ctx.budget, cache);
    }
    return cache;
  }

  /**
   * Live item read, cached per attempt for 60 s with single-flight. A changed
   * `cacheEpoch` or `forceRefresh` reads the item again and replaces the entry.
   */
  async function getItem(
    ctx: VaultProviderContext,
    vaultId: string,
    itemId: string,
  ): Promise<SdkItem> {
    const { client: clientKey } = await keys(ctx);
    // No await between the lookup and the insert below keeps the single flight.
    const cache = itemCache(ctx);
    const cacheKey = `${clientKey}|${vaultId}/${itemId}`;
    const epoch = ctx.cacheEpoch ?? null;
    const cached = cache.get(cacheKey);
    if (cached && !ctx.forceRefresh && cached.epoch === epoch && now() - cached.at < valueCacheMs) {
      return await cached.item;
    }
    const item = call(ctx, "read", "itemsGet", (client) => client.items.get(vaultId, itemId));
    cache.set(cacheKey, { at: now(), epoch, item });
    item.catch(() => {
      if (cache.get(cacheKey)?.item === item) cache.delete(cacheKey);
    });
    return await item;
  }

  /** Drops the attempt's cached copies of an item, whichever connection read them. */
  function forgetItem(ctx: VaultProviderContext, vaultId: string, itemId: string) {
    const cache = attemptItemCaches.get(ctx.budget);
    if (!cache) return;
    const suffix = `|${vaultId}/${itemId}`;
    for (const cacheKey of [...cache.keys()]) {
      if (cacheKey.endsWith(suffix)) cache.delete(cacheKey);
    }
  }

  async function materialFor(
    ctx: VaultProviderContext,
    item: SdkItem,
    externalFieldId: string,
  ): Promise<SecretMaterial> {
    const field = mapItemFields(item).find(
      (candidate) => candidate.externalFieldId === externalFieldId,
    );
    if (!field) {
      throw new VaultProviderError(
        "provider_not_found",
        `1Password item "${item.title}" has no field ${externalFieldId}`,
      );
    }
    if (field.source === "notes") return { type: "text", value: item.notes };
    if (field.source === "file") {
      const bytes = await call(ctx, "read", "filesRead", (client) =>
        client.items.files.read(item.vaultId, item.id, field.file),
      );
      return { type: "bytes", value: bytes };
    }
    if (field.kind === "totp") {
      try {
        return { type: "totp", params: parseTotpInput(field.field.value) };
      } catch {
        const details = field.field.details?.content as { code?: string } | undefined;
        if (details?.code) return { type: "text", value: details.code };
        throw new VaultProviderError(
          "provider_unavailable",
          `The one-time password in 1Password item "${item.title}" is not a valid TOTP seed`,
        );
      }
    }
    return { type: "text", value: field.field.value };
  }

  const provider: OnePasswordVaultProvider = {
    id: "onepassword",
    planTier,

    capabilities(): VaultProviderCapabilities {
      return {
        write: true,
        createVault: true,
        totp: true,
        // File and Document fields are readable; writing them is not supported.
        files: false,
        groupGrants: planTier !== "family",
        passkeys: false,
      };
    },

    async validate(ctx) {
      await provider.listVaults(ctx);
      return { accountName: description.accountName };
    },

    async listVaults(ctx): Promise<ProviderVault[]> {
      const vaults = await call(ctx, "list", "vaultsList", (client) => client.vaults.list());
      return vaults.map((vault) => ({
        externalVaultId: vault.id,
        name: vault.title,
        contentVersion: vault.contentVersion === undefined ? null : String(vault.contentVersion),
        itemCount: typeof vault.activeItemCount === "number" ? vault.activeItemCount : null,
      }));
    },

    async listItems(ctx, externalVaultId): Promise<ProviderItemMeta[]> {
      assertOnePasswordIds(externalVaultId);
      const overviews = await call(ctx, "list", "itemsList", (client) =>
        client.items.list(externalVaultId, {
          type: "ByState",
          content: { active: true, archived: false },
        }),
      );
      const items: ProviderItemMeta[] = [];
      for (let start = 0; start < overviews.length; start += ONEPASSWORD_GET_ALL_BATCH) {
        const ids = overviews.slice(start, start + ONEPASSWORD_GET_ALL_BATCH).map((o) => o.id);
        const batch = await call(ctx, "read", "itemsGetAll", (client) =>
          client.items.getAll(externalVaultId, ids),
        );
        for (const response of batch.individualResponses) {
          // An item deleted between list and getAll simply drops out of the mirror.
          if (response.content) items.push(toProviderItemMeta(response.content));
        }
      }
      return items;
    },

    async readFields(ctx, externalVaultId, externalItemId, externalFieldIds) {
      assertOnePasswordIds(externalVaultId, externalItemId);
      const item = await getItem(ctx, externalVaultId, externalItemId);
      const values: ProviderFieldValue[] = [];
      for (const externalFieldId of externalFieldIds) {
        values.push({ externalFieldId, material: await materialFor(ctx, item, externalFieldId) });
      }
      return values;
    },

    async writeItem(ctx, externalVaultId, write) {
      assertOnePasswordIds(externalVaultId, write.externalItemId);
      if (!write.externalItemId) {
        const params = buildCreateParams(externalVaultId, write);
        const created = await call(ctx, "write", "itemsCreate", (client) =>
          client.items.create(params),
        );
        return toProviderItemMeta(created);
      }
      const itemId = write.externalItemId;
      forgetItem(ctx, externalVaultId, itemId);
      for (let attempt = 0; ; attempt += 1) {
        const current = await call(ctx, "read", "itemsGet", (client) =>
          client.items.get(externalVaultId, itemId),
        );
        if (
          write.expectedVersion !== undefined &&
          write.expectedVersion !== null &&
          String(current.version) !== write.expectedVersion
        ) {
          throw new VaultProviderError(
            "provider_conflict",
            `1Password item "${current.title}" changed (version ${current.version}, expected ${write.expectedVersion}); reload and retry`,
          );
        }
        const next = applyWrite(current, write);
        try {
          const saved = await call(ctx, "write", "itemsPut", (client) => client.items.put(next));
          return toProviderItemMeta(saved);
        } catch (error) {
          // Without an explicit expected version, a concurrent edit is re-read and
          // the same field patch re-applied once; never overwrite a stale view.
          const retry =
            error instanceof VaultProviderError &&
            error.code === "provider_conflict" &&
            attempt === 0 &&
            (write.expectedVersion === undefined || write.expectedVersion === null);
          if (!retry) throw error;
        } finally {
          forgetItem(ctx, externalVaultId, itemId);
        }
      }
    },

    async archiveItem(ctx, externalVaultId, externalItemId) {
      assertOnePasswordIds(externalVaultId, externalItemId);
      await call(ctx, "write", "itemsArchive", (client) =>
        client.items.archive(externalVaultId, externalItemId),
      );
      forgetItem(ctx, externalVaultId, externalItemId);
    },

    async createVault(ctx, input) {
      if (input.groupId && planTier === "family") {
        throw new VaultProviderError(
          "provider_unavailable",
          "1Password Families accounts have no groups; share the vault in 1Password instead",
        );
      }
      const vault = await call(ctx, "admin", "vaultsCreate", (client) =>
        client.vaults.create({
          title: input.name,
          ...(input.description ? { description: input.description } : {}),
          allowAdminsAccess: input.allowAdminsAccess,
        }),
      );
      const created: ProviderVault = {
        externalVaultId: vault.id,
        name: vault.title,
        contentVersion: vault.contentVersion === undefined ? null : String(vault.contentVersion),
        itemCount: typeof vault.activeItemCount === "number" ? vault.activeItemCount : 0,
      };
      if (input.groupId) {
        const groupId = input.groupId;
        try {
          await call(ctx, "admin", "grantGroupPermissions", (client) =>
            client.vaults.grantGroupPermissions(vault.id, [
              { groupId, permissions: ONEPASSWORD_MANAGED_GROUP_PERMISSIONS },
            ]),
          );
        } catch (error) {
          throw new OnePasswordVaultCreatedError(
            created,
            error instanceof VaultProviderError ? error : mapOnePasswordError(error),
          );
        }
      }
      return created;
    },

    async deleteVault(ctx, externalVaultId) {
      assertOnePasswordIds(externalVaultId);
      await call(ctx, "admin", "vaultsDelete", (client) => client.vaults.delete(externalVaultId));
    },

    async deleteItem(ctx, externalVaultId, externalItemId) {
      assertOnePasswordIds(externalVaultId, externalItemId);
      await call(ctx, "write", "itemsDelete", (client) =>
        client.items.delete(externalVaultId, externalItemId),
      );
      forgetItem(ctx, externalVaultId, externalItemId);
    },
  };
  return provider;
}
