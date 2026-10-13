import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";
import type { VaultErrorCode, VaultSummary } from "@opengeni/react";
import {
  connectionAttention,
  expiryLabel,
  expiryState,
  groupVaults,
  isMissingKeyError,
  itemsLabel,
  secretsCapabilityOff,
  secretsOffIn,
  syncLabel,
  vaultErrorText,
  vaultsOfConnection,
} from "./vault-model";
import { draftSecretsRows, sessionSecretsSummary } from "./session-secrets-panel";
import { scheduleSecretsSummary } from "./schedule-secrets-field";

const NOW = Date.parse("2026-10-12T12:00:00Z");
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

function vaultApiError(status: number, code: VaultErrorCode, details?: Record<string, unknown>) {
  return new OpenGeniApiError(
    status,
    JSON.stringify({ error: code, message: "raw server text", ...(details ? { details } : {}) }),
    { mutation: false },
  );
}

describe("vault list grouping", () => {
  test("groups by owner whatever the source, the default first, then by name, and hides task vaults", () => {
    const groups = groupVaults([
      vault({ name: "Zeta", ownerKind: "workspace" }),
      vault({ name: "Alpha", ownerKind: "workspace" }),
      vault({ name: "Shared", ownerKind: "workspace", isDefault: true }),
      vault({ name: "Mine", ownerKind: "user" }),
      vault({ name: "My 1P", ownerKind: "user", source: "onepassword" }),
      vault({ name: "Org", ownerKind: "organization" }),
      vault({ name: "1P", ownerKind: "workspace", source: "onepassword" }),
      vault({ name: "Task", ownerKind: "task" }),
    ]);
    expect(groups.map((group) => [group.id, group.vaults.map((each) => each.name)])).toEqual([
      ["user", ["Mine", "My 1P"]],
      ["workspace", ["Shared", "1P", "Alpha", "Org", "Zeta"]],
    ]);
  });

  test("a connection's vaults and what it needs", () => {
    const connectionId = "00000000-0000-4000-8000-0000000000c1";
    const linked = [
      vault({ name: "B", source: "onepassword", providerConnectionId: connectionId }),
      vault({ name: "A", source: "onepassword", providerConnectionId: connectionId }),
      vault({ name: "Other", source: "onepassword" }),
      vault({ name: "Mine" }),
    ];
    const ofConnection = vaultsOfConnection(linked, connectionId);
    expect(ofConnection.map((each) => each.name)).toEqual(["A", "B"]);
    expect(connectionAttention(ofConnection)).toBeNull();
    expect(connectionAttention([...ofConnection, vault({ syncStatus: "error" })])).toBe(
      "sync_failed",
    );
    expect(
      connectionAttention([vault({ syncStatus: "error" }), vault({ syncStatus: "auth_expired" })]),
    ).toBe("token_expired");
  });

  test("an empty list has no groups and item counts read naturally", () => {
    expect(groupVaults([])).toEqual([]);
    expect(itemsLabel(1)).toBe("1 item");
    expect(itemsLabel(1400)).toBe(`${(1400).toLocaleString()} items`);
  });
});

describe("expiry", () => {
  test("no badge for no date or a date beyond two weeks", () => {
    expect(expiryState(null, NOW)).toBeNull();
    expect(expiryState("2026-11-30T00:00:00Z", NOW)).toBeNull();
    expect(expiryState("not a date", NOW)).toBeNull();
  });

  test("expiring within two weeks and expired", () => {
    const soon = expiryState("2026-10-15T12:00:00Z", NOW);
    expect(soon).toMatchObject({ kind: "expiring", days: 3 });
    expect(expiryLabel(soon!)).toBe("Expires in 3 days");
    expect(expiryLabel(expiryState("2026-10-12T18:00:00Z", NOW)!)).toBe("Expires today");
    const past = expiryState("2026-10-01T00:00:00Z", NOW);
    expect(past?.kind).toBe("expired");
    expect(expiryLabel(past!)).toBe("Expired");
  });
});

describe("provider sync status", () => {
  test("a healthy vault has no label; problems say what happened", () => {
    expect(syncLabel(vault())).toBeNull();
    expect(syncLabel(vault({ syncStatus: "error" }))).toBe("Sync failed");
    expect(syncLabel(vault({ syncStatus: "auth_expired" }))).toBe("Token expired");
    expect(syncLabel(vault({ syncStatus: "rate_limited" }))).toBe("Rate limited");
    expect(
      syncLabel(vault({ syncStatus: "rate_limited", rateLimitedUntil: "2026-10-12T13:00:00Z" })),
    ).toStartWith("Rate limited until ");
  });
});

describe("error copy (UI-9)", () => {
  test("vault errors read as product sentences, never raw codes or server text", () => {
    const readOnly = vaultErrorText(vaultApiError(409, "vault_read_only"));
    expect(readOnly).toBe(
      "This vault is read-only. Change it in 1Password or link it as Read & write.",
    );
    expect(readOnly).not.toContain("raw server text");
    expect(vaultErrorText(vaultApiError(409, "vault_name_conflict"))).toContain("Choose another");
  });

  test("a rate limit names when to try again", () => {
    expect(
      vaultErrorText(
        vaultApiError(429, "provider_rate_limited", { retryAt: "2026-10-12T13:00:00Z" }),
      ),
    ).toStartWith("1Password is limiting requests. Try again after ");
  });

  test("the missing encryption key is recognised", () => {
    expect(isMissingKeyError(vaultApiError(503, "encryption_key_missing"))).toBe(true);
    expect(isMissingKeyError(vaultApiError(404, "vault_not_found"))).toBe(false);
  });
});

describe("the Secrets capability", () => {
  test("explicit choices decide; following the default does not", () => {
    expect(secretsOffIn(undefined)).toBeNull();
    expect(secretsOffIn("all")).toBe(false);
    expect(secretsOffIn("none")).toBe(true);
    expect(secretsOffIn({ from: "all", secrets: false })).toBe(true);
    expect(secretsOffIn({ from: "none", secrets: true })).toBe(false);
    expect(secretsOffIn({ from: "none" })).toBe(true);
    expect(secretsOffIn({ from: "all" })).toBe(false);
  });

  test("workspace defaults without a choice leave Secrets on", () => {
    expect(secretsCapabilityOff(undefined)).toBe(false);
    expect(secretsCapabilityOff({})).toBe(false);
  });
});

describe("chat and schedule Secrets summaries", () => {
  test("the + row reads All, a count, or None", () => {
    const rows = [vault(), vault(), vault()];
    expect(
      sessionSecretsSummary(
        { mode: "all" },
        rows.map(() => ({ selected: true })),
      ),
    ).toBe("All");
    expect(sessionSecretsSummary(undefined, null)).toBe("All");
    expect(
      sessionSecretsSummary({ mode: "selected", vaultIds: [rows[0]!.id] }, [
        { selected: true },
        { selected: false },
      ]),
    ).toBe("1 vault");
    expect(sessionSecretsSummary({ mode: "selected", vaultIds: ["a", "b"] }, null)).toBe(
      "2 vaults",
    );
    expect(sessionSecretsSummary({ mode: "selected", vaultIds: [] }, [])).toBe("None");
  });

  test("a new chat lists every vault but task vaults, checked by its draft policy", () => {
    const mine = vault({ ownerKind: "user" });
    const shared = vault();
    const task = vault({ ownerKind: "task" });
    const all = draftSecretsRows([mine, shared, task], { mode: "all" });
    expect(all.map((row) => [row.id, row.selected, row.selectable])).toEqual([
      [mine.id, true, true],
      [shared.id, true, true],
    ]);
    const narrowed = draftSecretsRows([mine, shared], { mode: "selected", vaultIds: [shared.id] });
    expect(narrowed.map((row) => row.selected)).toEqual([false, true]);
  });

  test("a schedule summarizes only a narrowing", () => {
    expect(scheduleSecretsSummary(undefined)).toBeNull();
    expect(scheduleSecretsSummary({ mode: "all" })).toBeNull();
    expect(scheduleSecretsSummary({ mode: "selected", vaultIds: [] })).toBe("No secrets");
    expect(scheduleSecretsSummary({ mode: "selected", vaultIds: ["a"] })).toBe("1 vault");
  });
});
