import type { Permission } from "@opengeni/contracts";

export type ExternalAuthoritySnapshot = Readonly<{
  accountId: string;
  externalIdentityId: string;
  identityStatus: "active" | "disabled" | "revoked";
  identityRevision: number;
  membershipStatus: "active" | "provisioning" | "suspended" | "revoked";
  workspaceId: string;
  permissions: readonly Permission[];
}>;

export type ExternalLinkAuthoritySnapshot = Readonly<{
  id: string;
  accountId: string;
  externalIdentityId: string;
  revision: number;
  nativeSubjectId: string;
  status: "pending" | "active" | "revoked" | "expired";
  expiresAt: number | null;
  permissions: readonly Permission[];
  nativeAuthority: Readonly<{
    subjectId: string;
    accountId: string;
    workspaceId: string;
    active: boolean;
    permissions: readonly Permission[];
  }>;
}>;

/** Pure permission calculation over already authenticated, live snapshots.
 * This does not authenticate assertions or establish provenance. Callers must
 * read snapshots under their authorization fence, never from request JSON.
 * Linked mode uses the native lane alone: external workspace permissions must
 * not be unioned into that lane, nor must old external resources change owner.
 */
export function externalActorPermissions(input: {
  accountId: string;
  workspaceId: string;
  keyActive: boolean;
  keyAccountId: string;
  keyPermissions: readonly Permission[];
  external: ExternalAuthoritySnapshot;
  linked?: {
    expectedId: string;
    expectedRevision: number;
    authority: ExternalLinkAuthoritySnapshot;
  };
  now: number;
}): Permission[] {
  const external = input.external;
  if (
    !input.keyActive ||
    input.keyAccountId !== input.accountId ||
    external.accountId !== input.accountId ||
    external.identityStatus !== "active" ||
    external.membershipStatus !== "active" ||
    !Number.isSafeInteger(external.identityRevision) ||
    external.identityRevision < 1 ||
    !Number.isFinite(input.now)
  )
    return [];
  let ceiling: readonly Permission[];
  if (input.linked) {
    const { authority: link, expectedId, expectedRevision } = input.linked;
    const native = link.nativeAuthority;
    if (
      !expectedId ||
      link.id !== expectedId ||
      link.accountId !== input.accountId ||
      link.externalIdentityId !== external.externalIdentityId ||
      link.status !== "active" ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1 ||
      link.revision !== expectedRevision ||
      (link.expiresAt !== null &&
        (!Number.isFinite(link.expiresAt) || link.expiresAt <= input.now)) ||
      !native.active ||
      link.nativeSubjectId.length > 1024 ||
      !/^user:[^\r\n]+$(?![\s\S])/.test(link.nativeSubjectId) ||
      native.subjectId !== link.nativeSubjectId ||
      native.accountId !== input.accountId ||
      native.workspaceId !== input.workspaceId
    )
      return [];
    const delegation = new Set(link.permissions);
    ceiling = native.permissions.filter((permission) => delegation.has(permission));
  } else {
    if (external.workspaceId !== input.workspaceId) return [];
    ceiling = external.permissions;
  }
  const allowed = new Set(ceiling);
  return [...new Set(input.keyPermissions)].filter((permission) => allowed.has(permission));
}
