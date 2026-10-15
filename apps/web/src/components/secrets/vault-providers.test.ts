import { describe, expect, test } from "bun:test";
import type { VaultItem, VaultSummary } from "@opengeni/react";

import {
  acceptsItem,
  connectionAttention,
  connectionName,
  creatableTypes,
  everListed,
  healthLabel,
  HOSTED_OPERATIONS,
  isPending,
  LEGACY_PROVIDER_OPERATIONS,
  needsAttention,
  removalLabel,
  sourceHome,
  stillPending,
  vaultHealth,
  vaultOperations,
  writesPausedReason,
  type VaultProviderOperations,
} from "./vault-providers";

let nextId = 0;

function vault(overrides: Partial<VaultSummary> = {}): VaultSummary {
  nextId += 1;
  return {
    id: `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`,
    workspaceId: "ws",
    ownerKind: "workspace",
    ownerLabel: "Platform engineering",
    rootSessionId: null,
    name: `Vault ${nextId}`,
    description: null,
    source: "opengeni",
    mode: "read_write",
    syncStatus: "ok",
    syncErrorCode: null,
    syncErrorMessage: null,
    lastSyncedAt: null,
    rateLimitedUntil: null,
    providerConnectionId: null,
    availability: null,
    isDefault: false,
    itemCount: 0,
    canWrite: true,
    canManage: true,
    generation: 1,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

const PROTON: VaultProviderOperations = {
  ...LEGACY_PROVIDER_OPERATIONS,
  createItemTypes: ["login", "note"],
  updateItem: false,
  removeField: false,
  archiveKind: "trash",
  createTotp: false,
  updateTotp: false,
};

function item(overrides: Partial<Pick<VaultItem, "type" | "fields">> = {}) {
  return { type: "login" as const, fields: [], ...overrides } as Pick<VaultItem, "type" | "fields">;
}

describe("what a vault can do", () => {
  test("hosted vaults do everything; an old server's provider vault keeps 1Password's rules", () => {
    expect(vaultOperations(vault())).toEqual(HOSTED_OPERATIONS);
    expect(vaultOperations(vault({ source: "onepassword" }))).toEqual(LEGACY_PROVIDER_OPERATIONS);
  });

  test("read-only links and people who can't write narrow the provider's operations", () => {
    const proton = vault({ source: "protonpass", providerOperations: PROTON });
    expect(creatableTypes(vaultOperations(proton))).toEqual(["login", "note"]);
    for (const narrowed of [
      { ...proton, mode: "read_only" as const },
      { ...proton, canWrite: false },
    ]) {
      const operations = vaultOperations(narrowed);
      expect(creatableTypes(operations)).toEqual([]);
      expect(operations.archiveItem).toBe(false);
      expect(operations.archiveKind).toBe("none");
      expect(operations.readFiles).toBe(true);
    }
  });

  test("files need file writes and passkeys are never created", () => {
    expect(
      creatableTypes({
        ...HOSTED_OPERATIONS,
        createItemTypes: ["file", "passkey", "login"],
        writeFiles: false,
      }),
    ).toEqual(["login"]);
  });

  test("a copy goes only where its type, files and one-time codes fit", () => {
    const proton = vault({ source: "protonpass", providerOperations: PROTON });
    const totp = { kind: "totp" } as VaultItem["fields"][number];
    const file = { kind: "file" } as VaultItem["fields"][number];
    expect(acceptsItem(proton, item())).toBe(true);
    expect(acceptsItem(proton, item({ type: "api_key" }))).toBe(false);
    expect(acceptsItem(proton, item({ fields: [totp] }))).toBe(false);
    expect(acceptsItem(vault(), item({ type: "file", fields: [file] }))).toBe(true);
    expect(acceptsItem(vault({ ownerKind: "task" }), item())).toBe(false);
    expect(acceptsItem(vault({ canWrite: false }), item())).toBe(false);
  });

  test("removing says where it happens", () => {
    expect(removalLabel(vault(), "archive")).toBe("Archive");
    expect(removalLabel(vault({ source: "protonpass" }), "trash")).toBe(
      "Move to trash in Proton Pass",
    );
    expect(removalLabel(vault({ source: "onepassword" }), "archive")).toBe("Archive in 1Password");
    expect(sourceHome(vault({ source: "external" }))).toBe("your vault service");
  });

  test("writes wait while the provider refuses, is locked or is down", () => {
    const bitwarden = (overrides: Partial<VaultSummary>) =>
      vault({ source: "bitwarden", providerOperations: PROTON, ...overrides });
    for (const [paused, reason] of [
      [bitwarden({ syncStatus: "auth_expired" }), "Changes wait until Bitwarden is reconnected."],
      [
        bitwarden({ syncStatus: "error", syncErrorCode: "provider_locked" }),
        "Changes wait until Bitwarden is unlocked on the bridge.",
      ],
      [
        bitwarden({ freshness: { state: "unavailable" } as VaultSummary["freshness"] }),
        "Changes wait until Bitwarden is reachable again.",
      ],
    ] as const) {
      expect(creatableTypes(vaultOperations(paused))).toEqual([]);
      expect(vaultOperations(paused).archiveItem).toBe(false);
      expect(writesPausedReason(paused)).toBe(reason);
      expect(acceptsItem(paused, item())).toBe(false);
    }
    // Stale, rate-limited and incomplete listings still take writes.
    for (const ok of [
      bitwarden({ freshness: { state: "stale" } as VaultSummary["freshness"] }),
      bitwarden({ syncStatus: "rate_limited" }),
      bitwarden({ syncStatus: "error", syncErrorCode: "provider_inventory_incomplete" }),
    ]) {
      expect(creatableTypes(vaultOperations(ok))).toEqual(["login", "note"]);
      expect(writesPausedReason(ok)).toBeNull();
    }
    expect(writesPausedReason(vault({ syncStatus: "auth_expired" }))).toBeNull();
  });
});

describe("a linked vault's health", () => {
  test("failures are their own states, never an empty healthy vault", () => {
    const linked = (overrides: Partial<VaultSummary>) =>
      vault({ source: "bitwarden", ...overrides });
    expect(vaultHealth(vault({ syncStatus: "error" })).kind).toBe("ok");
    expect(vaultHealth(linked({})).kind).toBe("ok");
    expect(
      vaultHealth(linked({ syncErrorCode: "provider_locked", syncStatus: "error" })).kind,
    ).toBe("locked");
    expect(vaultHealth(linked({ syncStatus: "auth_expired" })).kind).toBe("auth_expired");
    expect(
      vaultHealth(linked({ syncStatus: "error", syncErrorCode: "provider_inventory_incomplete" }))
        .kind,
    ).toBe("incomplete");
    expect(
      vaultHealth(
        linked({
          freshness: {
            state: "unavailable",
            lastCheckedAt: null,
            sourceSyncedAt: null,
            source: "cache",
            errorCode: "provider_unavailable",
            retryAt: null,
          },
        }),
      ).kind,
    ).toBe("unavailable");
    expect(
      vaultHealth(
        linked({
          freshness: {
            state: "stale",
            lastCheckedAt: "2026-10-15T09:00:00Z",
            sourceSyncedAt: null,
            source: "cache",
            errorCode: null,
            retryAt: null,
          },
        }),
      ),
    ).toEqual({ kind: "stale", checkedAt: "2026-10-15T09:00:00Z" });
    expect(vaultHealth(linked({ syncStatus: "error", syncErrorMessage: "boom" }))).toEqual({
      kind: "failed",
      message: "boom",
    });
  });

  test("stale is quiet; offline is for machines you run, unavailable for vendors", () => {
    expect(needsAttention({ kind: "stale", checkedAt: null })).toBe(false);
    expect(needsAttention({ kind: "locked" })).toBe(true);
    expect(healthLabel({ kind: "unavailable" }, "bitwarden")).toBe("Offline");
    expect(healthLabel({ kind: "unavailable" }, "keeper")).toBe("Unavailable");
    expect(healthLabel({ kind: "auth_expired" }, "onepassword")).toBe("Token expired");
    expect(healthLabel({ kind: "auth_expired" }, "keeper")).toBe("Needs reconnect");
    expect(healthLabel({ kind: "stale", checkedAt: null }, "keeper")).toBeNull();
  });

  test("never listed is not the same as empty", () => {
    expect(everListed(vault({ source: "keeper" }))).toBe(false);
    expect(everListed(vault({ source: "keeper", lastSyncedAt: "2026-10-15T09:00:00Z" }))).toBe(
      true,
    );
  });

  test("a connection reports its worst vault, and a server without it first", () => {
    const ok = vault({ source: "keeper" });
    expect(connectionAttention([ok])).toBeNull();
    expect(connectionAttention([ok, vault({ source: "keeper", syncStatus: "error" })])).toBe(
      "sync_failed",
    );
    expect(
      connectionAttention([
        vault({ source: "keeper", syncStatus: "error" }),
        vault({ source: "keeper", syncStatus: "auth_expired" }),
      ]),
    ).toBe("auth_expired");
    expect(connectionAttention([ok], { available: false })).toBe("unavailable_here");
  });

  test("a pending connection asks to finish connecting, after a server without it", () => {
    const ok = vault({ source: "keeper" });
    expect(connectionAttention([], { available: true, verificationStatus: "pending" })).toBe(
      "pending",
    );
    expect(connectionAttention([ok], { available: false, verificationStatus: "pending" })).toBe(
      "unavailable_here",
    );
    expect(connectionAttention([ok], { available: true, verificationStatus: "ready" })).toBeNull();
    expect(isPending({ verificationStatus: "pending" })).toBe(true);
    expect(isPending({})).toBe(false);
  });

  test("a verify that is still pending fails with the provider's reason", () => {
    const ready = { discoveryPending: false } as Parameters<typeof stillPending>[0];
    expect(stillPending(ready)).toBe(ready);
    const pending = {
      discoveryPending: true,
      errorCode: "provider_auth_expired",
    } as Parameters<typeof stillPending>[0];
    expect(() => stillPending(pending)).toThrow();
    try {
      stillPending(pending);
    } catch (error) {
      expect((error as { code?: string; status?: number }).code).toBe("provider_auth_expired");
      expect((error as { status?: number }).status).toBe(409);
    }
    const unknown = { discoveryPending: true } as Parameters<typeof stillPending>[0];
    expect(() => stillPending(unknown)).toThrow();
  });

  test("a connection's name falls back from label to account to provider", () => {
    expect(connectionName({ provider: "keeper", label: " Ops ", accountName: "acme" })).toBe("Ops");
    expect(connectionName({ provider: "keeper", label: null, accountName: "acme" })).toBe("acme");
    expect(connectionName({ provider: "protonpass", label: null, accountName: null })).toBe(
      "Proton Pass",
    );
  });
});
