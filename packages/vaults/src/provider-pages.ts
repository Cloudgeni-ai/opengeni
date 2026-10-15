import { VAULT_LIMITS } from "@opengeni/contracts";
import {
  VaultProviderError,
  type ProviderItemMeta,
  type ProviderPage,
  type ProviderPageRequest,
  type ProviderVault,
  type VaultProvider,
  type VaultProviderContext,
} from "./provider";

export const PROVIDER_PAGE_SIZE = 100;
export const PROVIDER_MAX_PAGES = 100;

function incomplete(): never {
  // Do not echo untrusted cursors, item names or response bodies in errors.
  throw new VaultProviderError(
    "provider_inventory_incomplete",
    "The provider inventory could not be read completely. The previous inventory was kept.",
  );
}

/**
 * A full traversal or a refusal, never a silently truncated mirror. A caller
 * may replace missing items only after this resolves successfully.
 */
export async function collectProviderPages<T>(input: {
  page: (request: ProviderPageRequest) => Promise<ProviderPage<T>>;
  identity: (item: T) => string;
  maxItems: number;
  signal?: AbortSignal;
}): Promise<T[]> {
  if (!Number.isSafeInteger(input.maxItems) || input.maxItems < 1 || input.maxItems > 10_000)
    incomplete();
  const items: T[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let snapshot: string | null | undefined;
  for (let count = 0; count < PROVIDER_MAX_PAGES; count++) {
    input.signal?.throwIfAborted();
    const limit = Math.min(PROVIDER_PAGE_SIZE, input.maxItems - items.length);
    if (limit < 1) incomplete();
    const page = await input.page({
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(snapshot != null ? { snapshot } : {}),
    });
    input.signal?.throwIfAborted();
    if (
      !page ||
      !Array.isArray(page.items) ||
      page.items.length > limit ||
      (page.snapshot !== null &&
        (typeof page.snapshot !== "string" ||
          page.snapshot.length === 0 ||
          page.snapshot.length > 1024)) ||
      (page.nextCursor !== null &&
        (typeof page.nextCursor !== "string" ||
          page.nextCursor.length === 0 ||
          page.nextCursor.length > 1024))
    )
      incomplete();
    if (snapshot !== undefined && page.snapshot !== snapshot) incomplete();
    snapshot = page.snapshot;
    if (page.freshness && page.freshness.state !== "current") incomplete();
    for (const item of page.items) {
      const id = input.identity(item);
      if (typeof id !== "string" || id.length === 0 || id.length > 300 || ids.has(id)) incomplete();
      ids.add(id);
      items.push(item);
    }
    if (page.nextCursor === null) return items;
    if (items.length >= input.maxItems || cursors.has(page.nextCursor)) incomplete();
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return incomplete();
}

function validateLegacyInventory<T>(items: T[], identity: (item: T) => string, max: number): T[] {
  if (!Array.isArray(items) || items.length > max) incomplete();
  const ids = new Set<string>();
  for (const item of items) {
    const id = identity(item);
    if (typeof id !== "string" || !id || id.length > 300 || ids.has(id)) incomplete();
    ids.add(id);
  }
  return items;
}

/** Legacy array providers remain compatible; new remote providers page natively. */
export async function listProviderVaults(
  provider: VaultProvider,
  ctx: VaultProviderContext,
): Promise<ProviderVault[]> {
  const identity = (vault: ProviderVault) => vault.externalVaultId;
  if (provider.listVaultPage) {
    return collectProviderPages({
      page: async (page) => {
        const result = await provider.listVaultPage!(ctx, page);
        if (result.freshness) ctx.onFreshness?.(result.freshness);
        return result;
      },
      identity,
      maxItems: VAULT_LIMITS.vaultsPerOwnerScope,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  }
  ctx.signal?.throwIfAborted();
  const items = await provider.listVaults(ctx);
  ctx.signal?.throwIfAborted();
  return validateLegacyInventory(items, identity, VAULT_LIMITS.vaultsPerOwnerScope);
}

export async function listProviderItems(
  provider: VaultProvider,
  ctx: VaultProviderContext,
  externalVaultId: string,
): Promise<ProviderItemMeta[]> {
  const identity = (item: ProviderItemMeta) => item.externalItemId;
  if (provider.listItemPage) {
    return collectProviderPages({
      page: async (page) => {
        const result = await provider.listItemPage!(ctx, externalVaultId, page);
        if (result.freshness) ctx.onFreshness?.(result.freshness);
        return result;
      },
      identity,
      maxItems: VAULT_LIMITS.itemsPerVault,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  }
  ctx.signal?.throwIfAborted();
  const items = await provider.listItems(ctx, externalVaultId);
  ctx.signal?.throwIfAborted();
  return validateLegacyInventory(items, identity, VAULT_LIMITS.itemsPerVault);
}
