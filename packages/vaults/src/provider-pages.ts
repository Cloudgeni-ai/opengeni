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
 * A bounded provider inventory and what it proves (external vaults §8).
 */
export interface ProviderInventory<T> {
  items: T[];
  /**
   * Whether the listing also proves which items are absent. It does when it
   * was one response (a single page or a legacy array listing), or when
   * every page carried the same provider snapshot token. Offset or position
   * cursors without a snapshot can skip an existing item that moved across
   * a page boundary while the pages were read (an earlier item was deleted
   * meanwhile), so such a multi-page listing proves only what it contains.
   * Never remove, or report as missing, anything absent from an inventory
   * that is not consistent.
   */
  consistent: boolean;
}

export interface ProviderPageTraversal<T> {
  page: (request: ProviderPageRequest) => Promise<ProviderPage<T>>;
  identity: (item: T) => string;
  maxItems: number;
  signal?: AbortSignal;
}

/**
 * A full traversal or a refusal (`provider_inventory_incomplete`), never a
 * prefix presented as the whole. A caller may remove items absent from it
 * only when it is `consistent`.
 */
export async function traverseProviderPages<T>(
  input: ProviderPageTraversal<T>,
): Promise<ProviderInventory<T>> {
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
    // One page is one response; later pages are consistent only under the
    // same snapshot (a changed snapshot was refused above).
    if (page.nextCursor === null) return { items, consistent: count === 0 || snapshot !== null };
    if (items.length >= input.maxItems || cursors.has(page.nextCursor)) incomplete();
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return incomplete();
}

/**
 * Enumeration: everything a complete bounded traversal listed, or a refusal.
 * It does not say whether absence is proven; use `traverseProviderPages`
 * before removing anything that is not listed.
 */
export async function collectProviderPages<T>(input: ProviderPageTraversal<T>): Promise<T[]> {
  return (await traverseProviderPages(input)).items;
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

/**
 * The provider's vaults and whether absence is proven. Legacy array
 * providers remain compatible (one response is consistent); new remote
 * providers page natively.
 */
export async function readProviderVaultInventory(
  provider: VaultProvider,
  ctx: VaultProviderContext,
): Promise<ProviderInventory<ProviderVault>> {
  const identity = (vault: ProviderVault) => vault.externalVaultId;
  if (provider.listVaultPage) {
    return traverseProviderPages({
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
  return {
    items: validateLegacyInventory(items, identity, VAULT_LIMITS.vaultsPerOwnerScope),
    consistent: true,
  };
}

/** Enumeration of the provider's vaults (discovery and linking). */
export async function listProviderVaults(
  provider: VaultProvider,
  ctx: VaultProviderContext,
): Promise<ProviderVault[]> {
  return (await readProviderVaultInventory(provider, ctx)).items;
}

/**
 * A provider vault's item metadata and whether absence is proven: only a
 * consistent inventory may replace a mirror.
 */
export async function readProviderItemInventory(
  provider: VaultProvider,
  ctx: VaultProviderContext,
  externalVaultId: string,
): Promise<ProviderInventory<ProviderItemMeta>> {
  const identity = (item: ProviderItemMeta) => item.externalItemId;
  if (provider.listItemPage) {
    return traverseProviderPages({
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
  return {
    items: validateLegacyInventory(items, identity, VAULT_LIMITS.itemsPerVault),
    consistent: true,
  };
}

/**
 * Enumeration of a provider vault's item metadata. It does not prove which
 * items are absent; mirror replacement uses `readProviderItemInventory`.
 */
export async function listProviderItems(
  provider: VaultProvider,
  ctx: VaultProviderContext,
  externalVaultId: string,
): Promise<ProviderItemMeta[]> {
  return (await readProviderItemInventory(provider, ctx, externalVaultId)).items;
}
