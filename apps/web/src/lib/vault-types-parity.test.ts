import { describe, expect, test } from "bun:test";
import * as C from "@opengeni/contracts";
import type { z } from "zod";
import { VAULT_ITEM_PAGE_LIMIT } from "@opengeni/react";
import type * as R from "@opengeni/react";

// @opengeni/react mirrors the vault wire types by hand (it ships no contracts
// runtime). These checks fail to typecheck when a mirror drifts from the zod
// schemas the API validates with.
type Assignable<A, B> = [A] extends [B] ? true : false;
/** Both ways, and for every key (an extra optional key would pass one way). */
type Equal<A, B> =
  Assignable<A, B> extends true
    ? Assignable<B, A> extends true
      ? Assignable<Required<A>, Required<B>> extends true
        ? Assignable<Required<B>, Required<A>>
        : false
      : false
    : false;
function assert<T extends true>(_value?: T): void {}

// Responses: the mirror must describe exactly what the API returns.
assert<Equal<R.VaultSummary, C.VaultSummary>>();
assert<Equal<R.VaultItemSummary, C.VaultItemSummary>>();
assert<Equal<R.VaultItem, C.VaultItem>>();
assert<Equal<R.VaultItemField, C.VaultItemField>>();
assert<Equal<R.VaultFieldVersionMeta, C.VaultFieldVersionMeta>>();
assert<Equal<R.RevealVaultFieldResponse, C.RevealVaultFieldResponse>>();
assert<Equal<R.SessionSecretsView, C.SessionSecretsView>>();
assert<Equal<R.ProviderVaultMeta, C.ProviderVaultMeta>>();
assert<Equal<R.InstallOnePasswordResponse, C.InstallOnePasswordResponse>>();
assert<Equal<R.OnePasswordConnectionSummary, C.OnePasswordConnectionSummary>>();
assert<Equal<R.DisconnectOnePasswordResponse, C.DisconnectOnePasswordResponse>>();
assert<Equal<R.VaultOwnerKind, C.VaultOwnerKind>>();
assert<Equal<R.VaultSyncStatus, C.VaultSyncStatus>>();
assert<Equal<R.VaultItemType, C.VaultItemType>>();
assert<Equal<R.VaultFieldKind, C.VaultFieldKind>>();
assert<Equal<R.VaultErrorCode, C.VaultErrorCode>>();

// Requests: whatever the client sends must pass the route's schema.
assert<Assignable<R.CreateVaultRequest, z.input<typeof C.CreateVaultRequest>>>();
assert<Assignable<R.UpdateVaultRequest, z.input<typeof C.UpdateVaultRequest>>>();
assert<Assignable<R.CreateVaultItemRequest, z.input<typeof C.CreateVaultItemRequest>>>();
assert<Assignable<R.UpdateVaultItemRequest, z.input<typeof C.UpdateVaultItemRequest>>>();
assert<Assignable<R.MoveVaultItemRequest, z.input<typeof C.MoveVaultItemRequest>>>();
assert<Assignable<R.InstallOnePasswordRequest, z.input<typeof C.InstallOnePasswordRequest>>>();
assert<Assignable<R.LinkProviderVaultRequest, z.input<typeof C.LinkProviderVaultRequest>>>();
assert<
  Assignable<R.ReplaceOnePasswordTokenRequest, z.input<typeof C.ReplaceOnePasswordTokenRequest>>
>();
assert<
  Assignable<
    R.CreateManagedProviderVaultRequest,
    z.input<typeof C.CreateManagedProviderVaultRequest>
  >
>();

describe("vault wire types", () => {
  test("the item page size is one the items route accepts", () => {
    expect(C.ListVaultItemsQuery.safeParse({ limit: String(VAULT_ITEM_PAGE_LIMIT) }).success).toBe(
      true,
    );
    expect(
      C.ListVaultItemsQuery.safeParse({ limit: String(VAULT_ITEM_PAGE_LIMIT + 1) }).success,
    ).toBe(false);
  });
});
