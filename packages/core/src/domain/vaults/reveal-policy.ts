/**
 * Who may see a stored value (docs/secrets.md, "Who can see a value").
 *
 * Using a secret never implies seeing it. Every surface that hands a value to
 * a person or a model (the reveal route, `secret_get`, `fromReference`
 * copies, moves to a password manager) asks this one rule:
 *
 * - A use-only item is never shown to anyone, its creator and admins
 *   included.
 * - An Only me item is shown to its owner (nobody else reaches it).
 * - A shared item (workspace, task or organization vault) is shown to the
 *   person who created it and to whoever administers where it lives:
 *   workspace admins for workspace and task vaults, the organization's owner
 *   and admins for organization vaults. Everyone else may only use it.
 * - An API key holding the literal `secrets:read` permission (an explicit,
 *   admin-made grant for programs) may read any item that is not use-only.
 */
import type { VaultOwnerKind } from "@opengeni/contracts";
import { VaultError } from "@opengeni/db";

export interface RevealViewer {
  /** The person asking, or the person an agent acts for; null when none. */
  subjectId: string | null;
  /** Holds `workspace:admin` in the workspace the request runs in. */
  workspaceAdmin: boolean;
  /** The organization's owner or an admin. */
  accountAdmin: boolean;
  /** An API key with the literal `secrets:read` permission. */
  apiKeyRead: boolean;
}

export interface RevealTarget {
  vaultOwnerKind: VaultOwnerKind;
  createdBySubjectId: string | null;
  useOnly: boolean;
}

export function vaultItemRevealable(item: RevealTarget, viewer: RevealViewer): boolean {
  if (item.useOnly) return false;
  if (viewer.apiKeyRead) return true;
  if (item.vaultOwnerKind === "user") return true;
  const creator = viewer.subjectId !== null && item.createdBySubjectId === viewer.subjectId;
  if (creator) return true;
  return item.vaultOwnerKind === "organization" ? viewer.accountAdmin : viewer.workspaceAdmin;
}

/** The refusal every surface gives, naming the item, never a value. */
export function valueHiddenError(
  item: { id: string; name: string } & Pick<RevealTarget, "useOnly">,
): VaultError {
  return new VaultError(
    "vault_permission_denied",
    item.useOnly
      ? `${item.name} is use-only: its values can be used by reference, never shown or copied`
      : `${item.name} can be used by reference; only the person who saved it or an admin can see or copy its values`,
    { itemId: item.id, reason: item.useOnly ? "use_only" : "use_without_reveal" },
  );
}
