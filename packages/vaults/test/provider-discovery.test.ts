import { describe, expect, test } from "bun:test";
import {
  collectProviderPages,
  createProviderCallBudget,
  listProviderItems,
  providerOperations,
  type VaultProviderCapabilities,
} from "../src/index";
import { createFakeVaultProvider } from "../src/testing/index";

const identity = (item: { id: string }) => item.id;

describe("complete provider inventories", () => {
  test("traverses bounded pages with their snapshot", async () => {
    const requests: unknown[] = [];
    const result = await collectProviderPages({
      maxItems: 3,
      identity,
      page: async (request) => {
        requests.push(request);
        return request.cursor
          ? { items: [{ id: "b" }], nextCursor: null, snapshot: "version1" }
          : { items: [{ id: "a" }], nextCursor: "page2", snapshot: "version1" };
      },
    });
    expect(result).toEqual([{ id: "a" }, { id: "b" }]);
    expect(requests).toEqual([{ limit: 3 }, { limit: 2, cursor: "page2", snapshot: "version1" }]);
  });

  test("refuses oversized, duplicate, changed and looping pages without certifying completion", async () => {
    for (const mode of [
      "oversized",
      "duplicate",
      "snapshot",
      "loop",
      "emptySnapshot",
      "stale",
    ] as const) {
      let calls = 0;
      const run = collectProviderPages({
        maxItems: 3,
        identity,
        page: async () => {
          calls++;
          return {
            items:
              mode === "oversized"
                ? Array.from({ length: 4 }, (_, i) => ({ id: String(i) }))
                : mode === "loop"
                  ? []
                  : [{ id: mode === "duplicate" ? "same" : String(calls) }],
            nextCursor: mode === "loop" ? "same" : calls === 1 ? "next" : null,
            snapshot:
              mode === "emptySnapshot" ? "" : mode === "snapshot" ? String(calls) : "stable",
            ...(mode === "stale"
              ? {
                  freshness: {
                    state: "stale" as const,
                    lastCheckedAt: null,
                    sourceSyncedAt: null,
                    source: "cache" as const,
                    errorCode: null,
                    retryAt: null,
                  },
                }
              : {}),
          };
        },
      });
      await expect(run).rejects.toMatchObject({ code: "provider_inventory_incomplete" });
    }
  });

  test("an exactly full final page succeeds; a continuation beyond the bound fails", async () => {
    const page = { items: [{ id: "a" }], nextCursor: null, snapshot: null };
    expect(
      await collectProviderPages({ maxItems: 1, identity, page: async () => page }),
    ).toHaveLength(1);
    await expect(
      collectProviderPages({
        maxItems: 1,
        identity,
        page: async () => ({ ...page, nextCursor: "more" }),
      }),
    ).rejects.toMatchObject({ code: "provider_inventory_incomplete" });
  });

  test("cancellation stops before invoking upstream", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    await expect(
      collectProviderPages({
        maxItems: 3,
        identity,
        signal: controller.signal,
        page: async () => {
          called = true;
          return { items: [], nextCursor: null, snapshot: null };
        },
      }),
    ).rejects.toBeDefined();
    expect(called).toBe(false);
  });

  test("old array providers cannot silently truncate or return duplicate IDs", async () => {
    const provider = createFakeVaultProvider({ vaults: [{ externalVaultId: "v", name: "V" }] });
    const item = {
      externalItemId: "i",
      name: "I",
      type: "login" as const,
      websites: [],
      fields: [],
      version: null,
      updatedAt: null,
    };
    provider.listItems = async () => [item, item];
    await expect(
      listProviderItems(
        provider,
        { connectionId: null, budget: createProviderCallBudget(10) },
        "v",
      ),
    ).rejects.toMatchObject({ code: "provider_inventory_incomplete" });
  });
});

describe("effective provider capabilities", () => {
  const legacy: VaultProviderCapabilities = {
    write: true,
    createVault: true,
    totp: true,
    files: true,
    groupGrants: false,
    passkeys: false,
  };

  test("preserves the legacy port without inventing file writes or permanent delete", () => {
    expect(providerOperations(legacy)).toMatchObject({
      createItemTypes: ["login", "api_key", "note"],
      updateItem: true,
      deleteItem: false,
      readFiles: true,
      writeFiles: false,
      restoreFieldHistory: false,
    });
  });

  test("a vault cannot widen the global adapter's operations", () => {
    const narrow = {
      ...providerOperations(legacy),
      updateItem: false,
      removeField: false,
      archiveItem: false,
      archiveKind: "none" as const,
    };
    const effective = providerOperations(
      { ...legacy, operations: narrow },
      { operations: providerOperations(legacy) },
    );
    expect(effective.updateItem).toBe(false);
    expect(effective.removeField).toBe(false);
    expect(effective.updateTotp).toBe(false);
    expect(effective.archiveItem).toBe(false);
    expect(effective.archiveKind).toBe("none");
  });

  test("read-only grants or legacy write=false clamp all writes", () => {
    for (const operations of [
      providerOperations(legacy, { writeAccess: "read_only" }),
      providerOperations({ ...legacy, write: false, operations: providerOperations(legacy) }),
    ]) {
      expect(operations).toMatchObject({
        createItemTypes: [],
        updateItem: false,
        removeField: false,
        archiveItem: false,
        archiveKind: "none",
        createVault: false,
        createTotp: false,
        updateTotp: false,
        writeFiles: false,
        readFiles: true,
      });
    }
  });

  test("unknown grants remain explicit and are enforced upstream, not invented as read-write", () => {
    expect(providerOperations(legacy, { writeAccess: "unknown" })).toEqual(
      providerOperations(legacy),
    );
  });
});
