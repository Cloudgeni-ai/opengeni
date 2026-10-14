import {
  PERSONAL_RESOURCE_SHARED_OUTPUT_WARNING_VERSION,
  type OpenGeniApiError,
  type PersonalResourceAttachmentIntent,
  type Rig,
  type ResourceAuthorityScope,
  type Session,
  type UserResourceAuthoritySummary,
  type Workspace,
} from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

import type { AuthSession } from "@/types";
import type { ManagedSelfContext } from "./managed-self-context";

export type PersonalAttachmentMode = PersonalResourceAttachmentIntent["mode"];

export type PersonalResourceOwnerScope = Readonly<{
  identityKey: string;
  subjectId: string;
  organizationId: string;
  targetWorkspaceId: string;
  personalWorkspaceId: string;
}>;

export type PersonalResourceCatalog = Readonly<{
  personalRigs: Rig[];
  rigs: Rig[];
  rigAuthorities: UserResourceAuthoritySummary[];
  connectedMachineAuthorities: UserResourceAuthoritySummary[];
  rigAuthoritiesTruncated: boolean;
  connectedMachineAuthoritiesTruncated: boolean;
  truncated: boolean;
}>;

/**
 * Personal resources a session is bound to. Only-me vaults need no attachment:
 * references resolve under the acting person's own authority at execution time.
 */
export type FixedPersonalResources = Readonly<{
  rigId: string | null;
  rigScope?: ResourceAuthorityScope | null | undefined;
  connectedMachine: Readonly<{ enrollmentId: string; name: string }> | null;
}>;

const AUTHORITY_PAGE_LIMIT = 100;
const AUTHORITY_MAX_PAGES = 4;

/**
 * Resolve the only browser identity allowed to discover personal resources.
 * Organization-admin grants, workspace membership, names and creator facts are
 * intentionally insufficient: the tuple must come from the current managed
 * cookie, access projection and active server-issued membership pointer.
 */
export function resolvePersonalResourceOwnerScope(input: {
  authMode: string;
  authSession: AuthSession | null;
  accessSubjectId: string;
  managedSelfContext: ManagedSelfContext | null;
  workspace: Pick<Workspace, "id" | "accountId"> | null;
  session?: Pick<Session, "id" | "tenancy"> | null;
}): PersonalResourceOwnerScope | null {
  const { authSession, managedSelfContext, workspace, session } = input;
  if (
    input.authMode !== "managedSession" ||
    !authSession ||
    !managedSelfContext ||
    !workspace ||
    managedSelfContext.identity.managedUserId !== authSession.user.id ||
    managedSelfContext.identity.subjectId !== input.accessSubjectId
  ) {
    return null;
  }
  if (session && session.tenancy?.ownedByCurrentUser !== true) return null;
  const membership = managedSelfContext.memberships.find(
    (candidate) =>
      candidate.status === "active" && candidate.organizationId === workspace.accountId,
  );
  if (!membership) return null;
  return {
    identityKey: [
      managedSelfContext.identity.credentialGeneration,
      managedSelfContext.identity.subjectId,
      membership.id,
      membership.personalWorkspaceId,
      workspace.accountId,
      workspace.id,
      session?.id ?? "new",
      session?.tenancy?.authorityEpoch ?? "new",
    ].join(":"),
    subjectId: managedSelfContext.identity.subjectId,
    organizationId: workspace.accountId,
    targetWorkspaceId: workspace.id,
    personalWorkspaceId: membership.personalWorkspaceId,
  };
}

async function listAuthorityPages(
  client: OpenGeniBrowserClient,
  workspaceId: string,
  resourceKind: "rig" | "connected_machine",
): Promise<{
  authorities: UserResourceAuthoritySummary[];
  truncated: boolean;
}> {
  const authorities: UserResourceAuthoritySummary[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < AUTHORITY_MAX_PAGES; pageNumber += 1) {
    const page = await client.listUserResourceAuthorities(workspaceId, {
      resourceKind,
      limit: AUTHORITY_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    authorities.push(...page.authorities);
    if (!page.nextCursor) return { authorities, truncated: false };
    cursor = page.nextCursor;
  }
  return { authorities, truncated: true };
}

/** Bounded metadata-only load. Resource values and grant credentials never enter web state. */
export async function loadPersonalResourceCatalog(
  client: OpenGeniBrowserClient,
  scope: PersonalResourceOwnerScope,
): Promise<PersonalResourceCatalog> {
  const [rigs, rigPage, connectedMachinePage] = await Promise.all([
    // User-scoped resources follow their owner into every workspace in the
    // organization. Resolve them through the session's current workspace so a
    // shared-workspace chat never depends on a second Personal-workspace route
    // remaining selectable in the browser.
    client.listRigs(scope.targetWorkspaceId),
    listAuthorityPages(client, scope.targetWorkspaceId, "rig"),
    listAuthorityPages(client, scope.targetWorkspaceId, "connected_machine"),
  ]);
  const personalRigs = rigs.filter(
    (resource) => resource.scope === "user" && resource.status === "active",
  );
  const rigAuthorities = rigPage.authorities.filter((authority) =>
    personalRigs.some(
      (resource) =>
        authority.resourceKind === "rig" &&
        authority.resourceId === resource.id &&
        authority.status === "active" &&
        authority.originWorkspaceId === resource.workspaceId,
    ),
  );
  return {
    personalRigs,
    rigs: personalRigs.filter((resource) =>
      rigAuthorities.some((authority) => authority.resourceId === resource.id),
    ),
    rigAuthorities,
    connectedMachineAuthorities: connectedMachinePage.authorities.filter(
      (authority) =>
        authority.resourceKind === "connected_machine" && authority.status === "active",
    ),
    rigAuthoritiesTruncated: rigPage.truncated,
    connectedMachineAuthoritiesTruncated: connectedMachinePage.truncated,
    truncated: rigPage.truncated || connectedMachinePage.truncated,
  };
}

export function personalSelection(
  catalog: PersonalResourceCatalog | null,
  fixed: FixedPersonalResources,
): {
  rigs: Rig[];
  connectedMachines: Array<Readonly<{ enrollmentId: string; name: string }>>;
  resourceCount: number;
  personalResourceCount: number;
  closureUnverified: boolean;
} {
  const personalRigs = fixed.rigId
    ? (catalog?.personalRigs.filter((resource) => resource.id === fixed.rigId) ?? [])
    : [];
  const rigs = fixed.rigId
    ? (catalog?.rigs.filter((resource) => resource.id === fixed.rigId) ?? [])
    : [];
  const personalConnectedMachines = fixed.connectedMachine ? [fixed.connectedMachine] : [];
  const connectedMachines = fixed.connectedMachine
    ? catalog?.connectedMachineAuthorities.some(
        (authority) => authority.resourceId === fixed.connectedMachine?.enrollmentId,
      )
      ? [fixed.connectedMachine]
      : []
    : [];
  const personalResourceCount = personalRigs.length + personalConnectedMachines.length;
  const closureUnverified = Boolean(
    (personalRigs.length > 0 &&
      (catalog?.rigAuthoritiesTruncated || rigs.length !== personalRigs.length)) ||
    (personalConnectedMachines.length > 0 &&
      (catalog?.connectedMachineAuthoritiesTruncated ||
        connectedMachines.length !== personalConnectedMachines.length)),
  );
  return {
    rigs,
    connectedMachines,
    resourceCount: rigs.length + connectedMachines.length,
    personalResourceCount,
    closureUnverified,
  };
}

export function buildPersonalResourceAttachmentIntent(input: {
  mode: PersonalAttachmentMode | null;
  visibility: "private" | "workspace";
  acknowledged: boolean;
  expectedAuthorityEpoch?: number | undefined;
  resourceCount: number;
}): PersonalResourceAttachmentIntent | undefined {
  if (
    input.resourceCount === 0 ||
    input.mode === null ||
    (input.visibility === "workspace" && !input.acknowledged)
  ) {
    return undefined;
  }
  return {
    mode: input.mode,
    ...(input.expectedAuthorityEpoch !== undefined
      ? { expectedAuthorityEpoch: input.expectedAuthorityEpoch }
      : {}),
    workspaceSharedAcknowledged: input.visibility === "workspace" && input.acknowledged,
    sharedOutputWarningVersion: PERSONAL_RESOURCE_SHARED_OUTPUT_WARNING_VERSION,
  };
}

/**
 * The owner's consent for their own Connected Machine in this chat. Moving the
 * chat onto the machine is that consent, so the message that tells the agent
 * where it runs carries it. It names no resource: the server derives the
 * machine from the chat's active pointer and checks the owner and the chat's
 * authority epoch. Without it a chat moved mid-session has no grant for the
 * machine, and every turn after the move is refused at admission.
 */
export function personalMachineUseIntent(
  tenancy:
    | Pick<NonNullable<Session["tenancy"]>, "visibility" | "authorityEpoch">
    | null
    | undefined,
): PersonalResourceAttachmentIntent | undefined {
  if (!tenancy) return undefined;
  return buildPersonalResourceAttachmentIntent({
    mode: "session",
    visibility: tenancy.visibility === "workspace" ? "workspace" : "private",
    acknowledged: true,
    expectedAuthorityEpoch: tenancy.authorityEpoch,
    resourceCount: 1,
  });
}

/**
 * Reconcile the Rig restored from a durable new-session draft against the
 * scoped catalog without discarding it while that catalog is still loading.
 */
export function reconcileNewSessionFixedResources(input: {
  selectedRigId: string;
  selectableRigIds: readonly string[];
  rigsSettled: boolean;
}): {
  rigId: string;
  selectionResolved: boolean;
} {
  const selectable = new Set(input.selectableRigIds);
  const rigId =
    input.selectedRigId && input.rigsSettled && !selectable.has(input.selectedRigId)
      ? ""
      : input.selectedRigId;
  return {
    rigId,
    selectionResolved:
      input.selectedRigId.length === 0 ||
      (input.rigsSettled && selectable.has(input.selectedRigId)),
  };
}

/** Show recovery only when the selected Rig is actually blocked by a failed catalog. */
export function newSessionFixedResourceCatalogFailed(input: {
  selectedRigId: string;
  selectionResolved: boolean;
  rigCatalogFailed: boolean;
}): boolean {
  if (input.selectionResolved) return false;
  return input.selectedRigId.length > 0 && input.rigCatalogFailed;
}

/** Stable typed identity for resetting shared-output acknowledgement. */
export function personalResourceSelectionIdentityKey(input: {
  rigId?: string | null | undefined;
  connectedMachineId?: string | null | undefined;
}): string {
  return [
    ...new Set([
      ...(input.rigId ? [`rig:${input.rigId}`] : []),
      ...(input.connectedMachineId ? [`connected_machine:${input.connectedMachineId}`] : []),
    ]),
  ]
    .sort()
    .join("\u0000");
}

/**
 * Selecting a personal resource is consent for the owner's work in this session,
 * including its continuations. Visibility does not change the duration of access.
 */
export function newSessionPersonalResourceAttachment(input: {
  personalResourceCount: number;
  visibility: "private" | "workspace";
}): {
  intent: PersonalResourceAttachmentIntent | undefined;
} {
  return {
    intent: buildPersonalResourceAttachmentIntent({
      mode: "session",
      visibility: input.visibility,
      // Choosing the Only-me resource in the setup is the acknowledgement;
      // the adjacent copy explains that shared-session outputs remain visible.
      acknowledged: input.visibility === "workspace",
      resourceCount: input.personalResourceCount,
    }),
  };
}

export function isPersonalAttachmentConflict(
  error: unknown,
  input: { personalResourceAttachment?: PersonalResourceAttachmentIntent } | undefined,
): boolean {
  const candidate = error as Partial<OpenGeniApiError> | null;
  return Boolean(
    input?.personalResourceAttachment &&
    candidate &&
    (candidate.status === 403 || candidate.status === 409) &&
    candidate.outcomeUnknown !== true,
  );
}

/** Refresh both fixed-resource catalogs after a definitive conflict. */
export async function recoverNewSessionPersonalResourceAttachment(input: {
  error: unknown;
  attemptedInput: { personalResourceAttachment?: PersonalResourceAttachmentIntent } | undefined;
  refreshCatalogs: () => Promise<void>;
}): Promise<boolean> {
  if (!isPersonalAttachmentConflict(input.error, input.attemptedInput)) return false;
  await input.refreshCatalogs();
  return true;
}
