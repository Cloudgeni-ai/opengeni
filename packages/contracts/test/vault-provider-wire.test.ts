import { describe, expect, test } from "bun:test";
import {
  VAULT_PROVIDER_WIRE_LIMITS,
  VAULT_PROVIDER_WIRE_VERSION,
  VaultProviderWireItemMeta,
  VaultProviderWireRequest,
  isVaultProviderWireMutation,
  parseVaultProviderWireResponse,
  vaultProviderWireResponseKey,
} from "../src/index";

const REQUEST_ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const request = (operation: unknown, extra: Record<string, unknown> = {}) => ({
  version: VAULT_PROVIDER_WIRE_VERSION,
  type: "request",
  requestId: REQUEST_ID,
  sentAt: "2026-10-15T12:00:00.000Z",
  provider: "bitwarden",
  connectionId: "6f1c3c1e-2b1a-4c55-9d1e-0a0b0c0d0e0f",
  authority: { accountId: "a", workspaceId: "w", subjectId: null, connectionWorkspaceId: "w" },
  operation,
  ...extra,
});
const meta = {
  externalItemId: "item-1",
  name: "GitHub",
  type: "login",
  websites: [],
  fields: [{ externalFieldId: "login.password", name: "password", kind: "concealed" }],
  version: null,
  updatedAt: null,
};

describe("opengeni.vault.v1 wire", () => {
  test("requests are strict and bounded", () => {
    expect(VaultProviderWireRequest.safeParse(request({ op: "describe" })).success).toBe(true);
    expect(
      VaultProviderWireRequest.safeParse(request({ op: "describe" }, { extra: 1 })).success,
    ).toBe(false);
    expect(
      VaultProviderWireRequest.safeParse(request({ op: "describe", command: "unlock" })).success,
    ).toBe(false);
    expect(VaultProviderWireRequest.safeParse(request({ op: "unlock" })).success).toBe(false);
    const list = (limit: number) =>
      request({ op: "list_vaults", page: { limit }, forceRefresh: false, cacheEpoch: null });
    expect(
      VaultProviderWireRequest.safeParse(list(VAULT_PROVIDER_WIRE_LIMITS.pageSizeMax)).success,
    ).toBe(true);
    expect(
      VaultProviderWireRequest.safeParse(list(VAULT_PROVIDER_WIRE_LIMITS.pageSizeMax + 1)).success,
    ).toBe(false);
    const read = (ids: string[]) =>
      request({
        op: "read_fields",
        externalVaultId: "v",
        externalItemId: "i",
        externalFieldIds: ids,
        forceRefresh: false,
        cacheEpoch: null,
      });
    expect(VaultProviderWireRequest.safeParse(read(["a", "a"])).success).toBe(false);
    expect(VaultProviderWireRequest.safeParse(read([])).success).toBe(false);
    expect(
      VaultProviderWireRequest.safeParse(
        request({ op: "archive_item", externalVaultId: "v", externalItemId: "i" }),
      ).success,
    ).toBe(false);
  });

  test("item metadata has no place for values", () => {
    expect(VaultProviderWireItemMeta.safeParse(meta).success).toBe(true);
    expect(VaultProviderWireItemMeta.safeParse({ ...meta, value: "hunter2" }).success).toBe(false);
    expect(
      VaultProviderWireItemMeta.safeParse({
        ...meta,
        fields: [
          {
            externalFieldId: "login.password",
            name: "password",
            kind: "concealed",
            value: "hunter2",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      VaultProviderWireItemMeta.safeParse({
        ...meta,
        fields: [
          { externalFieldId: "a", name: "Password", kind: "concealed" },
          { externalFieldId: "b", name: "password", kind: "concealed" },
        ],
      }).success,
    ).toBe(false);
  });

  test("responses must match the request id and operation", () => {
    const response = {
      version: VAULT_PROVIDER_WIRE_VERSION,
      type: "response",
      requestId: REQUEST_ID,
      ok: true,
      op: "list_items",
      result: { items: [meta], nextCursor: null, snapshot: null },
      freshness: null,
    };
    expect(
      parseVaultProviderWireResponse(response, { requestId: REQUEST_ID, op: "list_items" })?.ok,
    ).toBe(true);
    expect(
      parseVaultProviderWireResponse(response, { requestId: REQUEST_ID, op: "list_vaults" }),
    ).toBeNull();
    expect(
      parseVaultProviderWireResponse(response, {
        requestId: "1f0e0d0c-0b0a-4908-8706-050403020100",
        op: "list_items",
      }),
    ).toBeNull();
    expect(
      parseVaultProviderWireResponse(
        {
          ...response,
          result: { items: [{ ...meta, password: "x" }], nextCursor: null, snapshot: null },
        },
        { requestId: REQUEST_ID, op: "list_items" },
      ),
    ).toBeNull();
  });

  test("mutations and the response key are explicit", () => {
    expect(isVaultProviderWireMutation("write_item")).toBe(true);
    expect(isVaultProviderWireMutation("archive_item")).toBe(true);
    expect(isVaultProviderWireMutation("read_fields")).toBe(false);
    expect(vaultProviderWireResponseKey("s")).not.toBe("s");
  });
});
