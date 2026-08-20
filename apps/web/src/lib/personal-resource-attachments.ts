import {
  PERSONAL_RESOURCE_SHARED_OUTPUT_WARNING_VERSION,
  type OpenGeniApiError,
  type PersonalResourceAttachmentIntent,
  type Rig,
  type Session,
  type UserResourceAuthoritySummary,
  type VariableSet,
  type Workspace,
} from "@opengeni/sdk";
import type { OpenGeniCoreClient } from "@opengeni/sdk/core";

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
  variableSets: VariableSet[];
  rigs: Rig[];
  variableSetAuthorities: UserResourceAuthoritySummary[];
  rigAuthorities: UserResourceAuthoritySummary[];
  truncated: boolean;
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
  client: OpenGeniCoreClient,
  workspaceId: string,
  resourceKind: "variable_set" | "rig",
): Promise<{ authorities: UserResourceAuthoritySummary[]; truncated: boolean }> {
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
  client: OpenGeniCoreClient,
  scope: PersonalResourceOwnerScope,
): Promise<PersonalResourceCatalog> {
  const [variableSets, rigs, variableSetPage, rigPage] = await Promise.all([
    client.listVariableSets(scope.personalWorkspaceId),
    client.listRigs(scope.personalWorkspaceId),
    listAuthorityPages(client, scope.targetWorkspaceId, "variable_set"),
    listAuthorityPages(client, scope.targetWorkspaceId, "rig"),
  ]);
  const eligible = (
    authority: UserResourceAuthoritySummary,
    kind: "variable_set" | "rig",
  ): boolean =>
    authority.resourceKind === kind &&
    authority.status === "active" &&
    authority.originWorkspaceId === scope.personalWorkspaceId;
  return {
    variableSets: variableSets.filter(
      (resource) =>
        resource.scope === "user" &&
        resource.status === "active" &&
        variableSetPage.authorities.some(
          (authority) =>
            eligible(authority, "variable_set") && authority.resourceId === resource.id,
        ),
    ),
    rigs: rigs.filter(
      (resource) =>
        resource.scope === "user" &&
        resource.status === "active" &&
        rigPage.authorities.some(
          (authority) => eligible(authority, "rig") && authority.resourceId === resource.id,
        ),
    ),
    variableSetAuthorities: variableSetPage.authorities.filter((authority) =>
      eligible(authority, "variable_set"),
    ),
    rigAuthorities: rigPage.authorities.filter((authority) => eligible(authority, "rig")),
    truncated: variableSetPage.truncated || rigPage.truncated,
  };
}

export function personalSelection(
  catalog: PersonalResourceCatalog | null,
  fixed: { variableSetId: string | null; rigId: string | null },
): { variableSets: VariableSet[]; rigs: Rig[]; resourceCount: number } {
  const variableSets = fixed.variableSetId
    ? (catalog?.variableSets.filter((resource) => resource.id === fixed.variableSetId) ?? [])
    : [];
  const rigs = fixed.rigId
    ? (catalog?.rigs.filter((resource) => resource.id === fixed.rigId) ?? [])
    : [];
  return { variableSets, rigs, resourceCount: variableSets.length + rigs.length };
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
