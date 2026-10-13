import {
  vaultErrorCode,
  vaultErrorDetail,
  type VaultErrorCode,
  type VaultItemSummary,
  type VaultItemType,
  type VaultSummary,
} from "@opengeni/react";

import { resolveWorkspaceAgentDefaults, type AgentCapabilities } from "@opengeni/contracts";
import { userErrorText } from "@/lib/api-error";

/* ----------------------------------------------------------------------------
   Secrets: vocabulary, grouping and error copy shared by every Secrets page.
   Vocabulary (design §13A.1, no synonyms): Secrets, vault, item, field;
   "Only me", "This workspace", "This task", "Organization"; "1Password",
   "Read-only", "Read & write"; "Copy reference", "Reveal", "Generate".
   -------------------------------------------------------------------------- */

export type VaultGroupId = "user" | "workspace" | "managers";

export const VAULT_GROUP_TITLE: Record<VaultGroupId, string> = {
  user: "Only me",
  workspace: "This workspace",
  managers: "Password managers",
};

export function vaultGroup(vault: VaultSummary): VaultGroupId | null {
  if (vault.ownerKind === "task") return null;
  if (vault.source !== "opengeni") return "managers";
  return vault.ownerKind === "user" ? "user" : "workspace";
}

export function groupVaults(
  vaults: VaultSummary[],
): { id: VaultGroupId; vaults: VaultSummary[] }[] {
  const order: VaultGroupId[] = ["user", "workspace", "managers"];
  return order
    .map((id) => ({
      id,
      vaults: vaults
        .filter((vault) => vaultGroup(vault) === id)
        .sort((a, b) =>
          a.isDefault !== b.isDefault ? (a.isDefault ? -1 : 1) : a.name.localeCompare(b.name),
        ),
    }))
    .filter((group) => group.vaults.length > 0);
}

export const OWNER_LABEL: Record<VaultSummary["ownerKind"], string> = {
  user: "Only me",
  workspace: "This workspace",
  organization: "Organization",
  task: "This task",
};

export const SOURCE_LABEL: Record<VaultSummary["source"], string> = {
  opengeni: "Opengeni",
  onepassword: "1Password",
  host: "Host",
};

export const MODE_LABEL: Record<VaultSummary["mode"], string> = {
  read_only: "Read-only",
  read_write: "Read & write",
};

/** Who a vault is shared with, in one short phrase. */
export function vaultAudience(vault: VaultSummary, organizationName: string): string {
  switch (vault.ownerKind) {
    case "user":
      return "Only you";
    case "task":
      return "This task and its subtasks";
    case "workspace":
      return "Everyone in this workspace";
    case "organization": {
      const availability = vault.availability;
      if (!availability || availability.allowedWorkspaceIds === null) {
        return `Every workspace in ${organizationName}`;
      }
      const count = availability.allowedWorkspaceIds.length;
      return `${count} ${count === 1 ? "workspace" : "workspaces"} in ${organizationName}`;
    }
  }
}

export const ITEM_TYPE_LABEL: Record<VaultItemType, string> = {
  login: "Login",
  api_key: "API key",
  note: "Note",
  file: "File",
  passkey: "Passkey",
};

export const ITEM_TYPE_FILTERS: { value: "all" | VaultItemType; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "login", label: "Logins" },
  { value: "api_key", label: "API keys" },
  { value: "note", label: "Notes" },
  { value: "file", label: "Files" },
  { value: "passkey", label: "Passkeys" },
];

export function itemsLabel(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "item" : "items"}`;
}

/** The row's second line: the username, else the first website. */
export function itemSubtitle(item: VaultItemSummary): string | undefined {
  if (item.username) return item.username;
  if (item.websites[0]) return hostOf(item.websites[0]);
  return undefined;
}

export function hostOf(website: string): string {
  try {
    return new URL(website.includes("://") ? website : `https://${website}`).host;
  } catch {
    return website;
  }
}

/* ------------------------------------------------------------- expiry */

export const EXPIRING_SOON_DAYS = 14;
const DAY_MS = 86_400_000;

export type ExpiryState =
  | { kind: "expired"; at: Date }
  | { kind: "expiring"; at: Date; days: number }
  | null;

export function expiryState(expiresAt: string | null, now = Date.now()): ExpiryState {
  if (!expiresAt) return null;
  const at = new Date(expiresAt);
  const ms = at.getTime() - now;
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return { kind: "expired", at };
  const days = Math.ceil(ms / DAY_MS);
  return days <= EXPIRING_SOON_DAYS ? { kind: "expiring", at, days } : null;
}

export function expiryLabel(state: NonNullable<ExpiryState>): string {
  if (state.kind === "expired") return "Expired";
  return state.days <= 1 ? "Expires today" : `Expires in ${state.days} days`;
}

/* ------------------------------------------------------------- sync */

export function formatClock(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

export function syncLabel(vault: VaultSummary): string | null {
  switch (vault.syncStatus) {
    case "ok":
      return null;
    case "syncing":
      return "Syncing";
    case "error":
      return "Sync failed";
    case "auth_expired":
      return "Token expired";
    case "rate_limited": {
      const until = formatClock(vault.rateLimitedUntil);
      return until ? `Rate limited until ${until}` : "Rate limited";
    }
  }
}

/* ------------------------------------------------------------- errors (UI-9) */

const ERROR_COPY: Partial<Record<VaultErrorCode, string>> = {
  vault_not_found: "This vault isn't here anymore. It may have been deleted.",
  vault_item_not_found: "This item isn't here anymore. It may have been deleted or moved.",
  vault_field_not_found: "This field isn't on the item anymore. Reload to see the latest version.",
  vault_name_conflict: "A vault with this name already exists. Choose another name.",
  vault_item_name_conflict:
    "An item with this name already exists in this vault. Choose another name.",
  vault_limit_reached: "You've reached the vault limit. Delete a vault you no longer need first.",
  vault_read_only: "This vault is read-only. Change it in 1Password or link it as Read & write.",
  vault_generation_conflict:
    "This changed elsewhere since you opened it. Reload to get the latest version.",
  vault_permission_denied: "You don't have access to do this. Ask a workspace admin.",
  vault_reveal_requires_human: "Only a person can reveal this value.",
  vault_policy_outside_parent:
    "The parent task doesn't allow these vaults. Pick from the vaults it allows.",
  encryption_key_missing:
    "Secrets can't be stored or read until the server's encryption key is set. Ask whoever runs this Opengeni server.",
  provider_auth_invalid:
    "1Password rejected this token. Check it's a service account token, then paste it again.",
  provider_auth_expired:
    "The 1Password token expired. Paste a new service account token to reconnect.",
  provider_rate_limited: "1Password is limiting requests. Try again in a few minutes.",
  provider_unavailable: "1Password didn't respond. Try again in a moment.",
  provider_conflict: "This item changed in 1Password. Sync, then try again.",
  secret_save_forbidden: "You can't save secrets there. Choose another place.",
  invalid_secret_name: "Names can't contain /, {, }, # or \\, or start or end with a space.",
  secret_value_too_large:
    "This value is too large. Text can be up to 64 KB and files up to 256 KB.",
  human_auth_required: "Sign in again to continue.",
};

/** What happened and what to do, never a raw code. */
export function vaultErrorText(error: unknown, fallback?: string): string {
  const code = vaultErrorCode(error);
  if (code === "provider_rate_limited") {
    const retryAt = vaultErrorDetail(error, "retryAt");
    const clock = typeof retryAt === "string" ? formatClock(retryAt) : null;
    if (clock) return `1Password is limiting requests. Try again after ${clock}.`;
  }
  const copy = code ? ERROR_COPY[code] : undefined;
  return copy ?? userErrorText(error, fallback);
}

/** An Error carrying the user-facing copy, for FormPage and confirm throwers. */
export function vaultError(error: unknown, fallback?: string): Error {
  const wrapped = new Error(vaultErrorText(error, fallback));
  (wrapped as Error & { cause?: unknown }).cause = error;
  return wrapped;
}

export function isMissingKeyError(error: unknown): boolean {
  return vaultErrorCode(error) === "encryption_key_missing";
}

export function isNotFoundError(error: unknown): boolean {
  const code = vaultErrorCode(error);
  if (code === "vault_not_found" || code === "vault_item_not_found") return true;
  return (error as { status?: unknown } | null)?.status === 404;
}

export function isPermissionError(error: unknown): boolean {
  if (vaultErrorCode(error) === "vault_permission_denied") return true;
  return (error as { status?: unknown } | null)?.status === 403;
}

/**
 * Whether these capabilities turn Secrets off: true or false when they decide
 * it, null when they follow the workspace default (or there are none).
 */
export function secretsOffIn(capabilities: AgentCapabilities | undefined): boolean | null {
  if (capabilities === undefined) return null;
  if (capabilities === "all") return false;
  if (capabilities === "none") return true;
  if (capabilities.secrets !== undefined) return !capabilities.secrets;
  return capabilities.from === "none";
}

/** The workspace default turns Secrets off for its agents. */
export function secretsCapabilityOff(settings: unknown): boolean {
  return secretsOffIn(resolveWorkspaceAgentDefaults(settings)?.capabilities) ?? false;
}
