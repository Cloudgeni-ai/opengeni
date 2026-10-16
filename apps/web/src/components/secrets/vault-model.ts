import {
  vaultErrorCode,
  vaultErrorDetail,
  type OnePasswordPlanTier,
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

export type VaultGroupId = "user" | "workspace";

export const VAULT_GROUP_TITLE: Record<VaultGroupId, string> = {
  user: "Only me",
  workspace: "This workspace",
};

/**
 * Vaults are grouped by who can use them, whatever their source: a vault
 * linked from a personal 1Password account sits under Only me, next to the
 * person's own vaults. Its tile says where the items come from.
 */
export function vaultGroup(vault: VaultSummary): VaultGroupId | null {
  if (vault.ownerKind === "task") return null;
  return vault.ownerKind === "user" ? "user" : "workspace";
}

export function groupVaults(
  vaults: VaultSummary[],
): { id: VaultGroupId; vaults: VaultSummary[] }[] {
  const order: VaultGroupId[] = ["user", "workspace"];
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

/* ------------------------------------------------------------- connections */

export type ConnectionOwner = "user" | "workspace" | "organization";

/** "Only me", "This workspace" or "Organization", as on vaults. */
export function connectionOwnerLabel(owner: ConnectionOwner): string {
  return OWNER_LABEL[owner];
}

/** Who can use the vaults linked through a connection, as one sentence. */
export function connectionAudience(owner: ConnectionOwner, organizationName: string): string {
  return owner === "user"
    ? "Only you, and only work you start, can use its vaults."
    : owner === "workspace"
      ? "Everyone in this workspace can use its vaults."
      : `Workspaces in ${organizationName} can use its vaults.`;
}

/** The vaults linked through one connection, by name. */
export function vaultsOfConnection(vaults: VaultSummary[], connectionId: string): VaultSummary[] {
  return vaults
    .filter((vault) => vault.source !== "opengeni" && vault.providerConnectionId === connectionId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const PLAN_LABEL: Record<OnePasswordPlanTier, string> = {
  family: "Individual or Family",
  teams: "Teams",
  business: "Business",
};

export const OWNER_LABEL: Record<VaultSummary["ownerKind"], string> = {
  user: "Only me",
  workspace: "This workspace",
  organization: "Organization",
  task: "This task",
};

export const SOURCE_LABEL: Record<VaultSummary["source"], string> = {
  opengeni: "Opengeni",
  onepassword: "1Password",
  host: "Your app",
  external: "Your vault service",
  protonpass: "Proton Pass",
  keeper: "Keeper",
  bitwarden: "Bitwarden",
};

export const MODE_LABEL: Record<VaultSummary["mode"], string> = {
  read_only: "Read-only",
  read_write: "Read & write",
};

/** Who a vault is shared with, in one short phrase. */
export function vaultAudience(vault: VaultSummary, organizationName: string): string {
  switch (vault.ownerKind) {
    case "user": {
      const allowed = vault.availability?.allowedWorkspaceIds ?? null;
      if (allowed === null) return "Only you, in all your workspaces";
      // Its home (Personal) workspace always has it.
      const others = allowed.filter((id) => id !== vault.workspaceId).length;
      if (others === 0) return "Only you, in your Personal workspace";
      return `Only you, in Personal and ${others} other ${others === 1 ? "workspace" : "workspaces"}`;
    }
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
  vault_generation_conflict:
    "This changed elsewhere since you opened it. Reload to get the latest version.",
  vault_permission_denied: "You don't have access to do this. Ask a workspace admin.",
  vault_reveal_requires_human: "Only a person can reveal this value.",
  vault_policy_outside_parent:
    "The parent task doesn't allow these vaults. Pick from the vaults it allows.",
  encryption_key_missing:
    "Secrets can't be stored or read until the server's encryption key is set. Ask whoever runs this Opengeni server.",
  secret_save_forbidden: "You can't save secrets there. Choose another place.",
  invalid_secret_name: "Names can't contain /, {, }, # or \\, or start or end with a space.",
  secret_value_too_large:
    "This value is too large. Text can be up to 64 KB and files up to 256 KB.",
  human_auth_required: "Sign in again to continue.",
};

/** 1Password's own words, kept from before other password managers. */
const ONEPASSWORD_COPY: Partial<Record<VaultErrorCode, string>> = {
  provider_auth_invalid:
    "1Password rejected this token. Check it's a service account token, then paste it again.",
  provider_auth_expired:
    "The 1Password token expired. Paste a new service account token to reconnect.",
};

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Copy for the errors that come from a password manager. `home` names it
 * ("Proton Pass"); without one the sentence says "the password manager".
 */
function providerCopy(code: VaultErrorCode, home: string | null): string | undefined {
  if (home === "1Password" && ONEPASSWORD_COPY[code]) return ONEPASSWORD_COPY[code];
  const where = home ?? "the password manager";
  const Where = capitalized(where);
  switch (code) {
    case "vault_read_only":
      return home
        ? `This vault is read-only. Change it in ${where} or link it as Read & write.`
        : "This vault is read-only. Link it as Read & write to save to it.";
    case "provider_auth_invalid":
      return `${Where} didn't accept the saved access. Reconnect it to keep using its vaults.`;
    case "provider_auth_expired":
      return `Access to ${where} expired. Reconnect it to keep using its vaults.`;
    case "provider_rate_limited":
      return `${Where} is limiting requests. Try again in a few minutes.`;
    case "provider_unavailable":
      return `${Where} didn't respond. Try again in a moment.`;
    case "provider_conflict":
      return `This item changed in ${where}. Sync, then try again.`;
    case "provider_locked":
      return home === "Bitwarden"
        ? "Bitwarden is locked on the bridge. Unlock it there, then try again."
        : `${Where} is locked. Unlock it, then try again.`;
    case "provider_inventory_incomplete":
      return `Not every item in ${where} could be listed. Try again in a moment.`;
    case "provider_outcome_unknown":
      return `${Where} didn't confirm the change. Check there before you try again, so nothing is saved twice.`;
    default:
      return undefined;
  }
}

/** What happened and what to do, never a raw code. `home` names the password manager. */
export function vaultErrorText(error: unknown, fallback?: string, home?: string | null): string {
  const code = vaultErrorCode(error);
  const where = home ?? homeOfError(error);
  if (code === "provider_rate_limited") {
    const retryAt = vaultErrorDetail(error, "retryAt");
    const clock = typeof retryAt === "string" ? formatClock(retryAt) : null;
    if (clock)
      return `${capitalized(where ?? "the password manager")} is limiting requests. Try again after ${clock}.`;
  }
  const copy = code ? (providerCopy(code, where) ?? ERROR_COPY[code]) : undefined;
  return copy ?? userErrorText(error, fallback);
}

// The password manager an error came from, remembered by vaultError so a caller
// that unwraps `cause` and asks for the copy again still names it.
const ERROR_HOMES = new WeakMap<object, string>();

function homeOfError(error: unknown): string | null {
  return typeof error === "object" && error !== null ? (ERROR_HOMES.get(error) ?? null) : null;
}

/** An Error carrying the user-facing copy, for FormPage and confirm throwers. */
export function vaultError(error: unknown, fallback?: string, home?: string | null): Error {
  if (home && typeof error === "object" && error !== null) ERROR_HOMES.set(error, home);
  const wrapped = new Error(vaultErrorText(error, fallback, home));
  (wrapped as Error & { cause?: unknown }).cause = error;
  if (home) ERROR_HOMES.set(wrapped, home);
  return wrapped;
}

export function isMissingKeyError(error: unknown): boolean {
  return vaultErrorCode(error) === "encryption_key_missing";
}

/* ------------------------------------------------- confirmed provider writes */

/** A confirmed create awaiting inventory, not a failed or uncertain write. */
export function savedCreation(
  caught: unknown,
  itemName: string,
  vaultName: string,
): { title: string; description: string } | null {
  const error = (caught as { cause?: unknown } | null)?.cause ?? caught;
  if (vaultErrorDetail(error, "saved") !== true) return null;
  return {
    title: `Saved ${itemName}`,
    description: `It will appear in ${vaultName} after the next successful sync. Don't save it again.`,
  };
}

/* ------------------------------------------------- a move that half finished */

/** A move or copy that failed after its copy was saved: what to tell the person. */
export interface SavedTransfer {
  title: string;
  description: string;
  /** The saved copy, when the server could name it (it may not be listed yet). */
  copy: { vaultId: string; itemId: string } | null;
  /** The original was archived or trashed too, so its page is gone. */
  originalRemoved: boolean;
}

function stringDetail(error: unknown, key: string): string | null {
  const value = vaultErrorDetail(error, key);
  return typeof value === "string" && value ? value : null;
}

/**
 * A failed move or copy whose copy was saved anyway (`details.saved`), so it
 * mustn't be offered again: a retry would save a second copy. Null for an
 * ordinary failure, which stays retryable. The error's code says why the
 * original was kept (a provider that didn't answer, a changed original, one
 * no longer listed), so the copy here never reads the code alone.
 */
export function savedTransfer(
  caught: unknown,
  context: {
    mode: "move" | "copy";
    itemName: string;
    targetName: string;
    /** Where the original lives: "Proton Pass", or the vault's name in Opengeni. */
    source: string;
    removal: "archive" | "trash";
  },
): SavedTransfer | null {
  const error = (caught as { cause?: unknown } | null)?.cause ?? caught;
  if (vaultErrorDetail(error, "saved") !== true) return null;
  const { mode, itemName, targetName, source, removal } = context;
  const vaultId = stringDetail(error, "vaultId");
  const itemId = stringDetail(error, "itemId");
  const copy = vaultId && itemId ? { vaultId, itemId } : null;
  const later = copy ? "" : ` It appears in ${targetName} after the next sync.`;
  const originalRemoved = mode === "move" && vaultErrorDetail(error, "sourceArchived") === true;
  if (mode === "copy" || originalRemoved) {
    return {
      title:
        mode === "move"
          ? `Moved ${itemName} to ${targetName}`
          : `Copied ${itemName} to ${targetName}`,
      description: `${later.trim() || `It's saved in ${targetName}.`} Don't ${mode} it again.`,
      copy,
      originalRemoved,
    };
  }
  const removing = removal === "trash" ? "Trashing" : "Archiving";
  const remove = removal === "trash" ? "move the original to trash" : "archive the original";
  const again = "Don't move it again;";
  const changed = vaultErrorDetail(error, "sourceChanged") === true;
  const reason = !changed
    ? `${removing} the original in ${source} didn't finish. ${again} check ${source} and ${remove} if it's still there.`
    : vaultErrorCode(error) === "vault_item_not_found"
      ? `The original is no longer listed in ${source}. ${again} check ${source} for it.`
      : `${itemName} changed in ${source} during the move, so the original was kept. ${again} compare the two, then update the copy or ${remove}.`;
  return {
    title: `Saved a copy in ${targetName}`,
    description: `${reason}${later}`,
    copy,
    originalRemoved: false,
  };
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
