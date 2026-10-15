import {
  OpenGeniApiError,
  type ExternalVaultProviderKind,
  type InstallVaultProviderResponse,
  type VaultProviderAvailability,
  type VaultProviderConnectionSummary,
  type VaultProviderFreshness,
  type VaultProviderOperations,
} from "@opengeni/sdk";
import type { VaultItem, VaultItemType, VaultSummary } from "@opengeni/react";

import { formatClock } from "./vault-model";

/* ----------------------------------------------------------------------------
   Password managers a workspace can link vaults from, what each one needs,
   what a linked vault can do, and how healthy its listing is. Pure data and
   rules: the pages read these instead of checking a vault's source.
   -------------------------------------------------------------------------- */

export type VaultConnection = VaultProviderConnectionSummary;
export type VaultProviderId = VaultConnection["provider"];
export type { ExternalVaultProviderKind, VaultProviderFreshness, VaultProviderOperations };

/** Picker order: the existing 1Password first, your own service last. */
export const PROVIDER_IDS: readonly VaultProviderId[] = [
  "onepassword",
  "protonpass",
  "keeper",
  "bitwarden",
  "external",
];

export interface ProviderInfo {
  id: VaultProviderId;
  /** Product name, as the vendor writes it. "Your vault service" for external. */
  name: string;
  /** The picker row's one line: what connecting needs. */
  summary: string;
  /** The credential, in a sentence: "the service account token". */
  credential: string;
  /** The ⋯ entry and page that renew access: "Replace token", "Update bridge". */
  renewLabel: string;
  /** What a vault is called on that side, for the chooser. */
  vaultNoun: { one: string; many: string };
  /** Where the values live, for "Values stay in …". */
  home: string;
}

export const PROVIDERS: Record<VaultProviderId, ProviderInfo> = {
  onepassword: {
    id: "onepassword",
    name: "1Password",
    summary: "Link vaults with a service account token.",
    credential: "the service account token",
    renewLabel: "Replace token",
    vaultNoun: { one: "vault", many: "vaults" },
    home: "1Password",
  },
  protonpass: {
    id: "protonpass",
    name: "Proton Pass",
    summary: "Link vaults with a personal access token.",
    credential: "the personal access token",
    renewLabel: "Replace token",
    vaultNoun: { one: "vault", many: "vaults" },
    home: "Proton Pass",
  },
  keeper: {
    id: "keeper",
    name: "Keeper",
    summary: "Link shared folders with a one-time token.",
    credential: "this device's Secrets Manager configuration",
    renewLabel: "Reconnect",
    vaultNoun: { one: "shared folder", many: "shared folders" },
    home: "Keeper",
  },
  bitwarden: {
    id: "bitwarden",
    name: "Bitwarden",
    summary: "Link vaults through a bridge you run.",
    credential: "the bridge address and signing secret",
    renewLabel: "Update bridge",
    vaultNoun: { one: "vault", many: "vaults" },
    home: "Bitwarden",
  },
  external: {
    id: "external",
    name: "Your vault service",
    summary: "Link vaults from a service you run.",
    credential: "the service address and signing secret",
    renewLabel: "Update service",
    vaultNoun: { one: "vault", many: "vaults" },
    home: "your vault service",
  },
};

export function isProviderId(value: unknown): value is VaultProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

/** The provider a vault comes from; null for Opengeni vaults and host-provided ones. */
export function providerOfVault(vault: Pick<VaultSummary, "source">): VaultProviderId | null {
  return isProviderId(vault.source) ? vault.source : null;
}

/**
 * Where a linked vault's items live, for sentences: "1Password", "Proton Pass",
 * "your vault service", or "the app that provides it" for host vaults.
 */
export function sourceHome(vault: Pick<VaultSummary, "source">): string {
  const provider = providerOfVault(vault);
  if (provider) return PROVIDERS[provider].home;
  return vault.source === "host" ? "the app that provides it" : "Opengeni";
}

/** A connection's name: its label, else its account, else the provider. */
export function connectionName(connection: {
  provider?: VaultProviderId | undefined;
  label: string | null;
  accountName: string | null;
}): string {
  return (
    connection.label?.trim() ||
    connection.accountName ||
    PROVIDERS[connection.provider ?? "onepassword"].name
  );
}

/** A bridge or a service is a machine that can be offline; vendors are "unavailable". */
export function isSelfHosted(provider: VaultProviderId | null): boolean {
  return provider === "bitwarden" || provider === "external";
}

/** Providers this server can't connect, each with the reason the picker shows. */
export type ProviderAvailability = Partial<Record<VaultProviderId, string>>;

const NOT_ENABLED = "Not enabled on this server";

/**
 * Which providers this server can't connect. The server's catalog says so
 * even before anyone connects; an older server without one only hints
 * through its existing connections.
 */
export function unavailableProviders(
  catalog: readonly VaultProviderAvailability[] | undefined,
  connections: readonly Pick<VaultConnection, "provider" | "available">[] | null,
): ProviderAvailability {
  const result: ProviderAvailability = {};
  if (catalog) {
    for (const each of catalog) if (!each.available) result[each.provider] = NOT_ENABLED;
    return result;
  }
  for (const each of connections ?? []) if (!each.available) result[each.provider] = NOT_ENABLED;
  return result;
}

/* ------------------------------------------------------------- operations */

export const HOSTED_OPERATIONS: VaultProviderOperations = {
  createItemTypes: ["login", "api_key", "note", "file"],
  updateItem: true,
  removeField: true,
  archiveItem: true,
  archiveKind: "archive",
  deleteItem: false,
  restoreItem: true,
  readFiles: true,
  writeFiles: true,
  createTotp: true,
  updateTotp: true,
  createVault: false,
  restoreFieldHistory: true,
};

/** What a provider vault from a server that predates granular operations could do. */
export const LEGACY_PROVIDER_OPERATIONS: VaultProviderOperations = {
  createItemTypes: ["login", "api_key", "note"],
  updateItem: true,
  removeField: true,
  archiveItem: true,
  archiveKind: "archive",
  deleteItem: false,
  restoreItem: false,
  readFiles: true,
  writeFiles: false,
  createTotp: true,
  updateTotp: true,
  createVault: false,
  restoreFieldHistory: false,
};

const NO_WRITES: Partial<VaultProviderOperations> = {
  createItemTypes: [],
  updateItem: false,
  removeField: false,
  archiveItem: false,
  archiveKind: "none",
  restoreItem: false,
  writeFiles: false,
  createTotp: false,
  updateTotp: false,
  createVault: false,
  restoreFieldHistory: false,
};

/**
 * What this person can do to this vault's items here: the provider's
 * operations, narrowed by the linked mode and by the person's permission.
 */
export function vaultOperations(
  vault: Pick<VaultSummary, "source" | "mode" | "canWrite" | "providerOperations"> &
    Partial<Omit<HealthInput, "source">>,
): VaultProviderOperations {
  const base =
    vault.source === "opengeni"
      ? HOSTED_OPERATIONS
      : (vault.providerOperations ?? LEGACY_PROVIDER_OPERATIONS);
  if (!vault.canWrite || vault.mode === "read_only") return { ...base, ...NO_WRITES };
  // A write can't reach a provider that refuses, is locked or is down: it waits.
  if (writesPaused(vault)) return { ...base, ...NO_WRITES };
  return base;
}

/** The health states in which no write can reach the provider. */
function writesPaused(vault: Partial<HealthInput>): VaultHealth["kind"] | null {
  if (!vault.source || vault.source === "opengeni") return null;
  const kind = vaultHealth(vault as HealthInput).kind;
  return kind === "auth_expired" || kind === "locked" || kind === "unavailable" ? kind : null;
}

/** Why this provider vault takes no changes right now, or null when it can. */
export function writesPausedReason(vault: Partial<HealthInput>): string | null {
  const kind = writesPaused(vault);
  if (!kind || !vault.source) return null;
  const provider = providerOfVault({ source: vault.source });
  const home = sourceHome({ source: vault.source });
  switch (kind) {
    case "auth_expired":
      return `Changes wait until ${home} is reconnected.`;
    case "locked":
      return provider === "bitwarden"
        ? `Changes wait until ${home} is unlocked on the bridge.`
        : `Changes wait until ${home} is unlocked.`;
    case "unavailable":
      return isSelfHosted(provider)
        ? `Changes wait until ${home} is reachable again.`
        : `Changes wait until ${home} responds again.`;
    default:
      return null;
  }
}

/** The item types a vault accepts; passkeys never (they come from a browser). */
export function creatableTypes(operations: VaultProviderOperations): VaultItemType[] {
  return operations.createItemTypes.filter(
    (type) => type !== "passkey" && (type !== "file" || operations.writeFiles),
  );
}

/** Whether a vault can take a copy of this item: its type, files and one-time codes. */
export function acceptsItem(
  target: VaultSummary,
  item: Pick<VaultItem, "type" | "fields">,
): boolean {
  if (!target.canWrite || target.ownerKind === "task") return false;
  const operations = vaultOperations(target);
  if (!creatableTypes(operations).includes(item.type)) return false;
  if (item.fields.some((field) => field.kind === "file") && !operations.writeFiles) return false;
  if (item.fields.some((field) => field.kind === "totp") && !operations.createTotp) return false;
  return true;
}

/** How removing an item reads: Archive here, or Archive / Move to trash over there. */
export function removalLabel(
  vault: Pick<VaultSummary, "source">,
  kind: "archive" | "trash",
): string {
  if (vault.source === "opengeni") return "Archive";
  const where = sourceHome(vault);
  return kind === "trash" ? `Move to trash in ${where}` : `Archive in ${where}`;
}

/* ------------------------------------------------------------- health */

export type VaultHealth =
  | { kind: "ok" }
  | { kind: "stale"; checkedAt: string | null }
  | { kind: "syncing" }
  | { kind: "rate_limited"; until: string | null }
  | { kind: "auth_expired" }
  | { kind: "locked" }
  | { kind: "unavailable" }
  | { kind: "incomplete" }
  | { kind: "failed"; message: string | null };

const AUTH_CODES = new Set(["provider_auth_expired", "provider_auth_invalid"]);

type HealthInput = Pick<
  VaultSummary,
  | "source"
  | "syncStatus"
  | "syncErrorCode"
  | "syncErrorMessage"
  | "rateLimitedUntil"
  | "freshness"
  | "lastSyncedAt"
>;

/**
 * One reading of a linked vault's state. A failure never reads as an empty,
 * healthy vault: locked, unreachable and incomplete listings are their own states.
 */
export function vaultHealth(vault: HealthInput): VaultHealth {
  if (vault.source === "opengeni") return { kind: "ok" };
  const freshness = vault.freshness;
  const code = freshness?.errorCode ?? vault.syncErrorCode;
  if (vault.syncStatus === "auth_expired" || (code && AUTH_CODES.has(code)))
    return { kind: "auth_expired" };
  if (code === "provider_locked") return { kind: "locked" };
  if (vault.syncStatus === "rate_limited" || code === "provider_rate_limited")
    return { kind: "rate_limited", until: freshness?.retryAt ?? vault.rateLimitedUntil };
  if (code === "provider_inventory_incomplete") return { kind: "incomplete" };
  if (freshness?.state === "unavailable") return { kind: "unavailable" };
  if (vault.syncStatus === "error") return { kind: "failed", message: vault.syncErrorMessage };
  if (vault.syncStatus === "syncing" || freshness?.state === "refreshing")
    return { kind: "syncing" };
  if (freshness?.state === "stale")
    return { kind: "stale", checkedAt: freshness.lastCheckedAt ?? vault.lastSyncedAt };
  return { kind: "ok" };
}

/** Opengeni has listed this vault's items at least once. */
export function everListed(vault: Pick<VaultSummary, "lastSyncedAt" | "freshness">): boolean {
  return Boolean(vault.lastSyncedAt ?? vault.freshness?.lastCheckedAt);
}

/** Whether a health state needs someone to look (a row badge, a banner). */
export function needsAttention(health: VaultHealth): boolean {
  return health.kind !== "ok" && health.kind !== "stale";
}

/** The row label of a health state, or null when the row shows none. */
export function healthLabel(health: VaultHealth, provider: VaultProviderId | null): string | null {
  switch (health.kind) {
    case "ok":
    case "stale":
      return null;
    case "syncing":
      return "Syncing";
    case "rate_limited": {
      const until = formatClock(health.until);
      return until ? `Rate limited until ${until}` : "Rate limited";
    }
    case "auth_expired":
      return provider === "onepassword" || provider === "protonpass"
        ? "Token expired"
        : "Needs reconnect";
    case "locked":
      return "Locked";
    case "unavailable":
      return isSelfHosted(provider) ? "Offline" : "Unavailable";
    case "incomplete":
      return "Incomplete";
    case "failed":
      return "Sync failed";
  }
}

/** What a connection needs, judged from its linked vaults. Worst first; null while fine. */
export type ConnectionAttention =
  | "unavailable_here"
  | "pending"
  | "auth_expired"
  | "locked"
  | "unavailable"
  | "sync_failed"
  | "incomplete"
  | "rate_limited";

export function connectionAttention(
  vaults: HealthInput[],
  connection?: Pick<VaultConnection, "available" | "verificationStatus">,
): ConnectionAttention | null {
  if (connection && connection.available === false) return "unavailable_here";
  if (connection?.verificationStatus === "pending") return "pending";
  const kinds = new Set(vaults.map((vault) => vaultHealth(vault).kind));
  if (kinds.has("auth_expired")) return "auth_expired";
  if (kinds.has("locked")) return "locked";
  if (kinds.has("unavailable")) return "unavailable";
  if (kinds.has("failed")) return "sync_failed";
  if (kinds.has("incomplete")) return "incomplete";
  if (kinds.has("rate_limited")) return "rate_limited";
  return null;
}

/** Setup saved the access but couldn't finish checking it; linking waits for Finish connecting. */
export function isPending(connection: Pick<VaultConnection, "verificationStatus">): boolean {
  return connection.verificationStatus === "pending";
}

/**
 * A verify that came back still pending, as the error its code describes,
 * so callers show the same copy as for any other provider refusal.
 */
export function stillPending(result: InstallVaultProviderResponse): InstallVaultProviderResponse {
  if (!result.discoveryPending) return result;
  const code = result.errorCode ?? "provider_unavailable";
  throw new OpenGeniApiError(409, JSON.stringify({ error: { code, message: code } }), {
    mutation: true,
  });
}
