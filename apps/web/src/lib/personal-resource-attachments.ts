import {
  PERSONAL_RESOURCE_SHARED_OUTPUT_WARNING_VERSION,
  type OpenGeniApiError,
  type PersonalResourceAttachmentIntent,
  type Rig,
  type ResourceAuthorityScope,
  type Session,
  type UserResourceAuthoritySummary,
  type VariableSet,
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
  personalVariableSets: VariableSet[];
  personalRigs: Rig[];
  variableSets: VariableSet[];
  rigs: Rig[];
  variableSetAuthorities: UserResourceAuthoritySummary[];
  rigAuthorities: UserResourceAuthoritySummary[];
  connectedMachineAuthorities: UserResourceAuthoritySummary[];
  variableSetAuthoritiesTruncated: boolean;
  rigAuthoritiesTruncated: boolean;
  connectedMachineAuthoritiesTruncated: boolean;
  truncated: boolean;
}>;

export type FixedPersonalResources = Readonly<{
  variableSetIds?: readonly string[] | undefined;
  variableSetScopes?: readonly (ResourceAuthorityScope | null)[] | undefined;
  /** @deprecated compatibility alias for one selected set. */
  variableSetId: string | null;
  variableSetScope?: ResourceAuthorityScope | null | undefined;
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
  resourceKind: "variable_set" | "rig" | "connected_machine",
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
  const [variableSets, rigs, variableSetPage, rigPage, connectedMachinePage] = await Promise.all([
    // User-scoped resources follow their owner into every workspace in the
    // organization. Resolve them through the session's current workspace so a
    // shared-workspace chat never depends on a second Personal-workspace route
    // remaining selectable in the browser.
    client.listVariableSets(scope.targetWorkspaceId),
    client.listRigs(scope.targetWorkspaceId),
    listAuthorityPages(client, scope.targetWorkspaceId, "variable_set"),
    listAuthorityPages(client, scope.targetWorkspaceId, "rig"),
    listAuthorityPages(client, scope.targetWorkspaceId, "connected_machine"),
  ]);
  const personalVariableSets = variableSets.filter(
    (resource) => resource.scope === "user" && resource.status === "active",
  );
  const personalRigs = rigs.filter(
    (resource) => resource.scope === "user" && resource.status === "active",
  );
  const matchesResource = (
    authority: UserResourceAuthoritySummary,
    kind: "variable_set" | "rig",
    resource: { id: string; workspaceId: string },
  ): boolean =>
    authority.resourceKind === kind &&
    authority.resourceId === resource.id &&
    authority.status === "active" &&
    authority.originWorkspaceId === resource.workspaceId;
  const variableSetAuthorities = variableSetPage.authorities.filter((authority) =>
    personalVariableSets.some((resource) => matchesResource(authority, "variable_set", resource)),
  );
  const rigAuthorities = rigPage.authorities.filter((authority) =>
    personalRigs.some((resource) => matchesResource(authority, "rig", resource)),
  );
  return {
    personalVariableSets,
    personalRigs,
    variableSets: personalVariableSets.filter((resource) =>
      variableSetAuthorities.some((authority) => authority.resourceId === resource.id),
    ),
    rigs: personalRigs.filter((resource) =>
      rigAuthorities.some((authority) => authority.resourceId === resource.id),
    ),
    variableSetAuthorities,
    rigAuthorities,
    connectedMachineAuthorities: connectedMachinePage.authorities.filter(
      (authority) =>
        authority.resourceKind === "connected_machine" && authority.status === "active",
    ),
    variableSetAuthoritiesTruncated: variableSetPage.truncated,
    rigAuthoritiesTruncated: rigPage.truncated,
    connectedMachineAuthoritiesTruncated: connectedMachinePage.truncated,
    truncated: variableSetPage.truncated || rigPage.truncated || connectedMachinePage.truncated,
  };
}

export function personalSelection(
  catalog: PersonalResourceCatalog | null,
  fixed: FixedPersonalResources,
): {
  variableSets: VariableSet[];
  rigs: Rig[];
  connectedMachines: Array<Readonly<{ enrollmentId: string; name: string }>>;
  resourceCount: number;
  personalResourceCount: number;
  closureUnverified: boolean;
} {
  const variableSetIds =
    fixed.variableSetIds ?? (fixed.variableSetId === null ? [] : [fixed.variableSetId]);
  const selectedVariableSetIds = new Set(variableSetIds);
  const expectedPersonalVariableSetIds = new Set(
    variableSetIds.filter((_variableSetId, index) => fixed.variableSetScopes?.[index] === "user"),
  );
  const personalVariableSets =
    catalog?.personalVariableSets.filter((resource) => selectedVariableSetIds.has(resource.id)) ??
    [];
  for (const resource of personalVariableSets) expectedPersonalVariableSetIds.add(resource.id);
  const personalRigs = fixed.rigId
    ? (catalog?.personalRigs.filter((resource) => resource.id === fixed.rigId) ?? [])
    : [];
  const variableSets =
    catalog?.variableSets.filter((resource) => selectedVariableSetIds.has(resource.id)) ?? [];
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
  const personalResourceCount =
    personalVariableSets.length + personalRigs.length + personalConnectedMachines.length;
  const closureUnverified = Boolean(
    (expectedPersonalVariableSetIds.size > 0 &&
      (catalog?.variableSetAuthoritiesTruncated ||
        [...expectedPersonalVariableSetIds].some(
          (variableSetId) =>
            !personalVariableSets.some((resource) => resource.id === variableSetId) ||
            !variableSets.some((resource) => resource.id === variableSetId),
        ))) ||
    (personalRigs.length > 0 &&
      (catalog?.rigAuthoritiesTruncated || rigs.length !== personalRigs.length)) ||
    (personalConnectedMachines.length > 0 &&
      (catalog?.connectedMachineAuthoritiesTruncated ||
        connectedMachines.length !== personalConnectedMachines.length)),
  );
  return {
    variableSets,
    rigs,
    connectedMachines,
    resourceCount: variableSets.length + rigs.length + connectedMachines.length,
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
 * The session composer must offer only resources the current workspace grant
 * can actually attach. The scoped Variable Set list already applies the
 * account/workspace/subject RLS boundary; these final capability and product
 * gates keep read-only and non-managed callers from seeing unusable choices.
 */
export function selectableSessionVariableSets(
  variableSets: readonly VariableSet[],
  input: {
    canAttach: boolean;
    canUse: boolean;
    personalResourcesAvailable: boolean;
  },
): VariableSet[] {
  if (!input.canAttach || !input.canUse) return [];
  return variableSets.filter(
    (variableSet) =>
      variableSet.status === "active" &&
      (variableSet.scope !== "user" || input.personalResourcesAvailable),
  );
}

export function newSessionVariableSetResolutionSource(input: {
  canAttach: boolean;
  canUse: boolean;
  canListVariableSets: boolean;
  canListSecrets: boolean;
}): "catalog" | "attachment" | "denied" {
  if (!input.canAttach || !input.canUse) return "denied";
  return input.canListVariableSets && input.canListSecrets ? "catalog" : "attachment";
}

/**
 * Reconcile fixed resources restored from a durable new-session draft against
 * the scoped catalogs without discarding them while those catalogs are still
 * loading. A selected Rig also waits for the Variable Set catalog because its
 * active version can contribute default Variable Sets to the attachment; every
 * inherited default must resolve in the target workspace before the Rig is
 * considered attachable.
 */
export function reconcileNewSessionFixedResources(input: {
  selectedVariableSetIds: readonly string[];
  selectedRigId: string;
  selectedRigDefaultVariableSetIds: readonly string[];
  selectableVariableSetIds: readonly string[];
  selectableRigIds: readonly string[];
  variableSetsSettled: boolean;
  rigsSettled: boolean;
}): {
  variableSetIds: string[];
  rigId: string;
  selectionResolved: boolean;
} {
  const selectableVariableSetIds = new Set(input.selectableVariableSetIds);
  const selectableRigIds = new Set(input.selectableRigIds);
  const variableSetIds = input.variableSetsSettled
    ? input.selectedVariableSetIds.filter((id) => selectableVariableSetIds.has(id))
    : [...input.selectedVariableSetIds];
  const selectedRigDefaultsResolved = input.selectedRigDefaultVariableSetIds.every((id) =>
    selectableVariableSetIds.has(id),
  );
  const rigId =
    input.selectedRigId &&
    input.rigsSettled &&
    (!selectableRigIds.has(input.selectedRigId) ||
      (input.variableSetsSettled && !selectedRigDefaultsResolved))
      ? ""
      : input.selectedRigId;
  const variableSetCatalogRequired =
    input.selectedVariableSetIds.length > 0 || input.selectedRigId.length > 0;
  const variableSetSelectionResolved =
    !variableSetCatalogRequired ||
    (input.variableSetsSettled &&
      input.selectedVariableSetIds.every((id) => selectableVariableSetIds.has(id)) &&
      selectedRigDefaultsResolved);
  const rigSelectionResolved =
    input.selectedRigId.length === 0 ||
    (input.rigsSettled && selectableRigIds.has(input.selectedRigId));
  return {
    variableSetIds,
    rigId,
    selectionResolved: variableSetSelectionResolved && rigSelectionResolved,
  };
}

/** Show recovery only when a selected fixed resource is actually blocked by a failed catalog. */
export function newSessionFixedResourceCatalogFailed(input: {
  selectedVariableSetIds: readonly string[];
  selectedRigId: string;
  selectionResolved: boolean;
  variableSetCatalogFailed: boolean;
  rigCatalogFailed: boolean;
}): boolean {
  if (input.selectionResolved) return false;
  return (
    ((input.selectedVariableSetIds.length > 0 || input.selectedRigId.length > 0) &&
      input.variableSetCatalogFailed) ||
    (input.selectedRigId.length > 0 && input.rigCatalogFailed)
  );
}

/** Stable typed identity for resetting shared-output acknowledgement. */
export function personalResourceSelectionIdentityKey(input: {
  variableSetIds: readonly string[];
  rigId?: string | null | undefined;
  connectedMachineId?: string | null | undefined;
}): string {
  return [
    ...new Set([
      ...input.variableSetIds.map((id) => `variable_set:${id}`),
      ...(input.rigId ? [`rig:${input.rigId}`] : []),
      ...(input.connectedMachineId ? [`connected_machine:${input.connectedMachineId}`] : []),
    ]),
  ]
    .sort()
    .join("\u0000");
}

/**
 * Selecting a personal resource is the explicit user action. Private sessions
 * retain that authority for the session; workspace-visible sessions receive
 * message-only authority for the creating human's first message.
 */
export function newSessionPersonalResourceAttachment(input: {
  personalResourceCount: number;
  visibility: "private" | "workspace";
}): {
  intent: PersonalResourceAttachmentIntent | undefined;
} {
  return {
    intent: buildPersonalResourceAttachmentIntent({
      mode: input.visibility === "private" ? "session" : "once",
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
