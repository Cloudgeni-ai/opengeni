import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { retryOrganizationUserSetupDelivery } from "@opengeni/sdk/organization-user-setup";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  beginOrganizationAdminOperation,
  isOrganizationConflict,
  organizationAdminIdentityKey,
  organizationAdminOperationSlot,
  ownsOrganizationAdminOperation,
  sameOrganizationAdminIdentity,
  type OrganizationAdminIdentity,
  type OrganizationAdminOperation,
  type OrganizationAdminOperationLane,
  type OrganizationAdminOperationSlot,
  type OrganizationAdminResource,
} from "@/lib/organization-admin";
import type {
  OrganizationAdministrationOverview,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationMembershipRole,
  OrganizationWorkspaceAccess,
  OrganizationWorkspaceAccessMember,
} from "@/types";

/* ----------------------------------------------------------------------------
   The organization's people, invitations and shared workspaces, loaded once
   for the People, Workspaces and General pages, with every change they make.

   Each read and write keeps the ownership fence it had before: a response
   that arrives after the signed-in identity or a newer request changed is
   dropped. Writes whose outcome is unknown keep their operation id, so trying
   again reconciles the same request instead of making a second one.
   -------------------------------------------------------------------------- */

export type WorkspaceRoleId = "viewer" | "member" | "admin";
export type MemberAction = "suspend" | "reactivate" | "offboard";

/** A user-facing error: what happened and what to do. Thrown by the actions. */
export class DirectoryActionError extends Error {}

interface Loaded<Value> {
  value: Value;
  loading: boolean;
  error: Error | null;
}

interface Owned<Value> extends Loaded<Value> {
  ownerKey: string;
}

type Pending<Request> = Request & { operationId: string };

export interface InviteResult {
  sent: OrganizationInvitation[];
  failed: { email: string; message: string }[];
}

export interface OrganizationDirectory {
  identity: OrganizationAdminIdentity;
  /** How the signed-in person is named when the server has no name ("Local dev"). */
  youLabel: string | null;
  actorRole: OrganizationMembershipRole | null;
  /** Owners and admins manage people and workspaces. */
  canAdminister: boolean;
  /** Single-user local mode: no people, no invitations. */
  singleUser: boolean;
  /** A managed human session (people and invitations exist). */
  managedSession: boolean;
  overview: Loaded<OrganizationAdministrationOverview | null>;
  members: Loaded<OrganizationMember[]>;
  invitations: Loaded<{ invitations: OrganizationInvitation[]; nextCursor: string | null }>;
  /** Workspace ids the signed-in person can open. */
  accessibleWorkspaceIds: ReadonlySet<string>;
  /** Your own organization membership, when the members list has it. */
  you: OrganizationMember | null;
  reload: () => Promise<void>;
  loadMoreInvitations: () => Promise<void>;

  renameOrganization: (name: string) => Promise<void>;
  createWorkspace: (name: string) => Promise<string | null>;
  renameWorkspace: (workspace: OrganizationWorkspaceAccess, name: string) => Promise<void>;
  deleteWorkspace: (workspace: OrganizationWorkspaceAccess) => Promise<void>;
  /** Gives or changes a workspace role. `current` is the grant being replaced, if any. */
  setWorkspaceRole: (input: {
    workspaceId: string;
    organizationMembershipId: string;
    role: WorkspaceRoleId;
    current: OrganizationWorkspaceAccessMember | null;
  }) => Promise<void>;
  removeWorkspaceAccess: (input: {
    workspaceId: string;
    member: OrganizationWorkspaceAccessMember;
  }) => Promise<void>;
  changeOrganizationRole: (
    member: OrganizationMember,
    role: OrganizationMembershipRole,
  ) => Promise<void>;
  transitionMember: (member: OrganizationMember, action: MemberAction) => Promise<void>;
  invite: (input: {
    emails: string[];
    role: OrganizationMembershipRole;
    workspaceIds: string[];
  }) => Promise<InviteResult>;
  retryInvitation: (invitation: OrganizationInvitation) => Promise<OrganizationInvitation>;
  revokeInvitation: (invitation: OrganizationInvitation) => Promise<void>;
}

const DirectoryContext = createContext<OrganizationDirectory | null>(null);

export function useOrganizationDirectory(): OrganizationDirectory {
  const value = useContext(DirectoryContext);
  if (!value) throw new Error("useOrganizationDirectory needs an OrganizationDirectoryProvider");
  return value;
}

/** For the settings shell, which renders above or without the provider. */
export function useOptionalOrganizationDirectory(): OrganizationDirectory | null {
  return useContext(DirectoryContext);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isOutcomeUnknown(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { outcomeUnknown?: unknown }).outcomeUnknown === true
  );
}

/** One user-facing sentence for a failed write. */
function failure(error: unknown, conflict: string): DirectoryActionError {
  if (isOutcomeUnknown(error)) {
    return new DirectoryActionError(
      "We couldn't confirm whether that worked. Try again to finish the same change safely.",
    );
  }
  if (isOrganizationConflict(error)) return new DirectoryActionError(conflict);
  const message = error instanceof Error && error.message ? error.message : String(error);
  return new DirectoryActionError(message);
}

const EMPTY_INVITATIONS = { invitations: [] as OrganizationInvitation[], nextCursor: null };

export function OrganizationDirectoryProvider({
  client,
  identity,
  actorRole,
  managedSession,
  singleUser,
  accessibleWorkspaceIds,
  youLabel = null,
  onAuthorityChanged,
  onCreateWorkspace,
  onDeleteWorkspace,
  children,
}: {
  youLabel?: string | null;
  client: OpenGeniBrowserClient;
  identity: OrganizationAdminIdentity;
  actorRole: OrganizationMembershipRole | null;
  /** A managed human session or the single-user local administrator. */
  managedSession: boolean;
  singleUser: boolean;
  accessibleWorkspaceIds: ReadonlySet<string>;
  /** Refreshes the signed-in person's grants after a change that affects them. */
  onAuthorityChanged: () => void | Promise<void>;
  /** Creates a shared workspace; returns its id when known. */
  onCreateWorkspace: (name: string, operationId: string) => Promise<string | null>;
  /** Deletes a shared workspace and moves away from it when it's the one in the URL. */
  onDeleteWorkspace: (workspaceId: string) => Promise<void>;
  children: ReactNode;
}) {
  const identityKey = organizationAdminIdentityKey(identity);
  const identityRef = useRef<OrganizationAdminIdentity | null>(identity);
  identityRef.current = identity;
  const sequenceRef = useRef(new Map<OrganizationAdminOperationSlot, number>());
  const activeRef = useRef(new Map<OrganizationAdminOperationSlot, OrganizationAdminOperation>());
  const canAdminister = actorRole === "owner" || actorRole === "admin";
  const peopleEnabled = managedSession && canAdminister && !singleUser;

  const [overview, setOverview] = useState<Owned<OrganizationAdministrationOverview | null>>({
    ownerKey: "",
    value: null,
    loading: true,
    error: null,
  });
  const [members, setMembers] = useState<Owned<OrganizationMember[]>>({
    ownerKey: "",
    value: [],
    loading: true,
    error: null,
  });
  const [invitations, setInvitations] = useState<
    Owned<{ invitations: OrganizationInvitation[]; nextCursor: string | null }>
  >({ ownerKey: "", value: EMPTY_INVITATIONS, loading: true, error: null });

  // Writes whose outcome is unknown, by target, so a retry reuses the operation id.
  const pendingRef = useRef(new Map<string, Pending<Record<string, unknown>>>());

  const claim = useCallback(
    (resource: OrganizationAdminResource, lane: OrganizationAdminOperationLane) => {
      const slot = organizationAdminOperationSlot(resource, lane);
      const operation = beginOrganizationAdminOperation({
        identity,
        resource,
        lane,
        previousSequence: sequenceRef.current.get(slot) ?? 0,
      });
      sequenceRef.current.set(slot, operation.sequence);
      activeRef.current.set(slot, operation);
      return operation;
    },
    [identity],
  );
  const owns = useCallback(
    (operation: OrganizationAdminOperation) =>
      ownsOrganizationAdminOperation({
        currentIdentity: identityRef.current,
        currentOperation:
          activeRef.current.get(
            organizationAdminOperationSlot(operation.resource, operation.lane),
          ) ?? null,
        accepted: operation,
      }),
    [],
  );
  const ownsIdentity = useCallback(
    () => sameOrganizationAdminIdentity(identityRef.current, identity),
    [identity],
  );

  useEffect(() => {
    const active = activeRef.current;
    const pending = pendingRef.current;
    identityRef.current = identity;
    return () => {
      identityRef.current = null;
      active.clear();
      pending.clear();
    };
  }, [identity]);

  /** Reuses the pending attempt for `key` when its request is unchanged. */
  const attempt = useCallback(
    <Request extends Record<string, unknown>>(key: string, request: Request): Pending<Request> => {
      const pending = pendingRef.current.get(key);
      if (pending) {
        const { operationId: _operationId, ...rest } = pending;
        if (JSON.stringify(rest) === JSON.stringify(request)) return pending as Pending<Request>;
      }
      const next = { ...request, operationId: crypto.randomUUID() };
      pendingRef.current.set(key, next);
      return next;
    },
    [],
  );
  const settle = useCallback((key: string, error?: unknown) => {
    if (error === undefined || !isOutcomeUnknown(error)) pendingRef.current.delete(key);
  }, []);

  const loadOverview = useCallback(async () => {
    if (!managedSession || !canAdminister || !identity.organizationId) {
      setOverview({ ownerKey: identityKey, value: null, loading: false, error: null });
      return;
    }
    const operation = claim("overview", "read");
    setOverview((current) => ({
      ownerKey: identityKey,
      value: current.ownerKey === identityKey ? current.value : null,
      loading: true,
      error: null,
    }));
    try {
      const value = await client.getOrganizationAdministrationOverview(identity.organizationId);
      if (!owns(operation)) return;
      setOverview({ ownerKey: identityKey, value, loading: false, error: null });
    } catch (error) {
      if (!owns(operation)) return;
      setOverview({ ownerKey: identityKey, value: null, loading: false, error: asError(error) });
    }
  }, [canAdminister, claim, client, identity.organizationId, identityKey, managedSession, owns]);

  const loadMembers = useCallback(async () => {
    if (!peopleEnabled) {
      setMembers({ ownerKey: identityKey, value: [], loading: false, error: null });
      return;
    }
    const operation = claim("members", "read");
    setMembers((current) => ({
      ownerKey: identityKey,
      value: current.ownerKey === identityKey ? current.value : [],
      loading: true,
      error: null,
    }));
    try {
      const response = await client.listOrganizationAdministrationMembers(identity.organizationId);
      if (!owns(operation)) return;
      setMembers({ ownerKey: identityKey, value: response.members, loading: false, error: null });
    } catch (error) {
      if (!owns(operation)) return;
      setMembers({ ownerKey: identityKey, value: [], loading: false, error: asError(error) });
    }
  }, [claim, client, identity.organizationId, identityKey, owns, peopleEnabled]);

  const loadInvitations = useCallback(
    async (cursor?: string, append = false) => {
      if (!peopleEnabled) {
        setInvitations({
          ownerKey: identityKey,
          value: EMPTY_INVITATIONS,
          loading: false,
          error: null,
        });
        return;
      }
      const operation = claim("admin-invitations", "read");
      setInvitations((current) => ({
        ownerKey: identityKey,
        value: current.ownerKey === identityKey ? current.value : EMPTY_INVITATIONS,
        loading: true,
        error: null,
      }));
      try {
        const response = await client.listOrganizationInvitationsForOrganization(
          identity.organizationId,
          { ...(cursor ? { cursor } : {}), limit: 50 },
        );
        if (!owns(operation)) return;
        setInvitations((current) => ({
          ownerKey: identityKey,
          value: {
            invitations:
              append && current.ownerKey === identityKey
                ? [...current.value.invitations, ...response.invitations]
                : response.invitations,
            nextCursor: response.nextCursor,
          },
          loading: false,
          error: null,
        }));
      } catch (error) {
        if (!owns(operation)) return;
        setInvitations((current) => ({
          ownerKey: identityKey,
          value: current.ownerKey === identityKey ? current.value : EMPTY_INVITATIONS,
          loading: false,
          error: asError(error),
        }));
      }
    },
    [claim, client, identity.organizationId, identityKey, owns, peopleEnabled],
  );

  const reload = useCallback(async () => {
    await Promise.all([loadOverview(), loadMembers(), loadInvitations()]);
  }, [loadInvitations, loadMembers, loadOverview]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /* ------------------------------------------------------------ mutations */

  const renameOrganization = useCallback(
    async (name: string) => {
      const current = overview.ownerKey === identityKey ? overview.value : null;
      if (!current) throw new DirectoryActionError("The organization hasn't loaded yet.");
      const key = "organization-name";
      const request = attempt(key, {
        name,
        expectedUpdatedAt: current.organization.updatedAt,
      });
      const operation = claim("overview", "mutation");
      try {
        const organization = await client.updateOrganizationName(identity.organizationId, request);
        settle(key);
        if (!owns(operation)) return;
        setOverview((state) =>
          state.ownerKey === identityKey && state.value
            ? { ...state, value: { ...state.value, organization } }
            : state,
        );
        await onAuthorityChanged();
      } catch (error) {
        settle(key, error);
        if (isOrganizationConflict(error) && ownsIdentity()) await loadOverview();
        throw failure(
          error,
          "Someone else changed the organization. Check the name and try again.",
        );
      }
    },
    [
      attempt,
      claim,
      client,
      identity.organizationId,
      identityKey,
      loadOverview,
      onAuthorityChanged,
      overview,
      owns,
      ownsIdentity,
      settle,
    ],
  );

  const createWorkspace = useCallback(
    async (name: string) => {
      const key = "create-workspace";
      const request = attempt(key, { name });
      try {
        const id = await onCreateWorkspace(request.name, request.operationId);
        settle(key);
        if (ownsIdentity()) await loadOverview();
        return id;
      } catch (error) {
        settle(key, error);
        throw failure(error, "That workspace changed. Refresh and try again.");
      }
    },
    [attempt, loadOverview, onCreateWorkspace, ownsIdentity, settle],
  );

  const renameWorkspace = useCallback(
    async (workspace: OrganizationWorkspaceAccess, name: string) => {
      const key = `rename-workspace:${workspace.id}`;
      const request = attempt(key, { name, expectedUpdatedAt: workspace.updatedAt });
      try {
        await client.updateOrganizationWorkspace(identity.organizationId, workspace.id, request);
        settle(key);
        if (ownsIdentity()) await loadOverview();
      } catch (error) {
        settle(key, error);
        if (isOrganizationConflict(error) && ownsIdentity()) await loadOverview();
        throw failure(error, "Someone else changed this workspace. Check its name and try again.");
      }
    },
    [attempt, client, identity.organizationId, loadOverview, ownsIdentity, settle],
  );

  const deleteWorkspace = useCallback(
    async (workspace: OrganizationWorkspaceAccess) => {
      try {
        await onDeleteWorkspace(workspace.id);
      } catch (error) {
        throw failure(error, "This workspace changed. Refresh and try again.");
      }
      if (ownsIdentity()) await loadOverview();
    },
    [loadOverview, onDeleteWorkspace, ownsIdentity],
  );

  const setWorkspaceRole = useCallback(
    async ({
      workspaceId,
      organizationMembershipId,
      role,
      current,
    }: {
      workspaceId: string;
      organizationMembershipId: string;
      role: WorkspaceRoleId;
      current: OrganizationWorkspaceAccessMember | null;
    }) => {
      const key = `workspace-access:${workspaceId}:${organizationMembershipId}`;
      const request = attempt(key, {
        role,
        expectedUpdatedAt: current?.updatedAt ?? null,
      });
      try {
        await client.putOrganizationWorkspaceMember(
          identity.organizationId,
          workspaceId,
          organizationMembershipId,
          request,
        );
        settle(key);
      } catch (error) {
        settle(key, error);
        if (isOrganizationConflict(error) && ownsIdentity()) await reload();
        throw failure(error, "Someone else changed this access. We refreshed it; try again.");
      }
      if (ownsIdentity()) await Promise.all([loadOverview(), loadMembers()]);
      if (organizationMembershipId === you(members, identity)?.id) await onAuthorityChanged();
    },
    [
      attempt,
      client,
      identity,
      loadMembers,
      loadOverview,
      members,
      onAuthorityChanged,
      ownsIdentity,
      reload,
      settle,
    ],
  );

  const removeWorkspaceAccess = useCallback(
    async ({
      workspaceId,
      member,
    }: {
      workspaceId: string;
      member: OrganizationWorkspaceAccessMember;
    }) => {
      if (!member.organizationMembershipId) {
        throw new DirectoryActionError("Service accounts get access from their API key.");
      }
      const key = `workspace-revoke:${workspaceId}:${member.organizationMembershipId}`;
      const request = attempt(key, { expectedUpdatedAt: member.updatedAt });
      try {
        await client.revokeOrganizationWorkspaceMember(
          identity.organizationId,
          workspaceId,
          member.organizationMembershipId,
          request,
        );
        settle(key);
      } catch (error) {
        settle(key, error);
        if (isOrganizationConflict(error) && ownsIdentity()) await reload();
        throw failure(error, "Someone else changed this access. We refreshed it; try again.");
      }
      if (ownsIdentity()) await Promise.all([loadOverview(), loadMembers()]);
      if (member.subjectId === identity.subjectId) await onAuthorityChanged();
    },
    [
      attempt,
      client,
      identity,
      loadMembers,
      loadOverview,
      onAuthorityChanged,
      ownsIdentity,
      reload,
      settle,
    ],
  );

  const replaceMember = useCallback(
    (updated: Partial<OrganizationMember> & { id: string }) =>
      setMembers((current) => ({
        ...current,
        value: current.value.map((candidate) =>
          candidate.id === updated.id ? { ...candidate, ...updated } : candidate,
        ),
      })),
    [],
  );

  const changeOrganizationRole = useCallback(
    async (member: OrganizationMember, role: OrganizationMembershipRole) => {
      const operation = claim("members", "mutation");
      try {
        const updated = await client.updateOrganizationMember(identity.organizationId, member.id, {
          kind: "change_role",
          role,
          expectedAuthorizationRevision: member.authorizationRevision,
          operationId: crypto.randomUUID(),
        });
        if (owns(operation)) replaceMember(updated);
        if (updated.subjectId === identity.subjectId) await onAuthorityChanged();
      } catch (error) {
        if (isOrganizationConflict(error) && ownsIdentity()) await loadMembers();
        throw failure(error, "Someone else changed this person. We refreshed their details.");
      }
    },
    [claim, client, identity, loadMembers, onAuthorityChanged, owns, ownsIdentity, replaceMember],
  );

  const transitionMember = useCallback(
    async (member: OrganizationMember, action: MemberAction) => {
      const operation = claim("members", "mutation");
      try {
        const updated = await client.updateOrganizationMember(identity.organizationId, member.id, {
          kind: action,
          expectedAuthorizationRevision: member.authorizationRevision,
          operationId: crypto.randomUUID(),
          reason: `${action} from the organization administration console`,
        });
        if (owns(operation)) replaceMember(updated);
        if (updated.subjectId === identity.subjectId) await onAuthorityChanged();
      } catch (error) {
        if (isOrganizationConflict(error) && ownsIdentity()) await loadMembers();
        throw failure(error, "Someone else changed this person. We refreshed their details.");
      }
      // Suspending and removing also end workspace access.
      if (ownsIdentity()) await Promise.all([loadOverview(), loadMembers()]);
    },
    [
      claim,
      client,
      identity,
      loadMembers,
      loadOverview,
      onAuthorityChanged,
      owns,
      ownsIdentity,
      replaceMember,
    ],
  );

  const invite = useCallback(
    async ({
      emails,
      role,
      workspaceIds,
    }: {
      emails: string[];
      role: OrganizationMembershipRole;
      workspaceIds: string[];
    }): Promise<InviteResult> => {
      const operation = claim("admin-invitations", "mutation");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const sent: OrganizationInvitation[] = [];
      const failed: InviteResult["failed"] = [];
      for (const email of emails) {
        const key = `invite:${email}`;
        const request = attempt(key, {
          email,
          role,
          initialWorkspaceIds: [...workspaceIds].sort(),
        });
        try {
          const invitation = await client.createOrganizationInvitation(identity.organizationId, {
            ...request,
            expiresAt,
          });
          settle(key);
          sent.push(invitation);
        } catch (error) {
          settle(key, error);
          failed.push({
            email,
            message: failure(error, "The invitation list changed. Check it and try again.").message,
          });
        }
      }
      if (sent.length > 0 && owns(operation)) {
        setInvitations((current) => ({
          ...current,
          ownerKey: identityKey,
          value: {
            invitations: [
              ...sent,
              ...current.value.invitations.filter(
                (candidate) => !sent.some((each) => each.id === candidate.id),
              ),
            ],
            nextCursor: current.value.nextCursor,
          },
        }));
      }
      if (failed.length > 0 && ownsIdentity()) await loadInvitations();
      return { sent, failed };
    },
    [
      attempt,
      claim,
      client,
      identity.organizationId,
      identityKey,
      loadInvitations,
      owns,
      ownsIdentity,
      settle,
    ],
  );

  const replaceInvitation = useCallback(
    (updated: OrganizationInvitation) =>
      setInvitations((current) => ({
        ...current,
        value: {
          ...current.value,
          invitations: current.value.invitations.map((candidate) =>
            candidate.id === updated.id ? updated : candidate,
          ),
        },
      })),
    [],
  );

  const retryInvitation = useCallback(
    async (invitation: OrganizationInvitation) => {
      const operation = claim("admin-invitations", "mutation");
      try {
        const delivery = await retryOrganizationUserSetupDelivery(
          client,
          identity.organizationId,
          invitation.id,
          { operationId: crypto.randomUUID() },
        );
        const updated = { ...invitation, delivery };
        if (owns(operation)) replaceInvitation(updated);
        return updated;
      } catch (error) {
        if (isOrganizationConflict(error) && ownsIdentity()) await loadInvitations();
        throw failure(error, "This invitation changed. We refreshed the list.");
      }
    },
    [
      claim,
      client,
      identity.organizationId,
      loadInvitations,
      owns,
      ownsIdentity,
      replaceInvitation,
    ],
  );

  const revokeInvitation = useCallback(
    async (invitation: OrganizationInvitation) => {
      const operation = claim("admin-invitations", "mutation");
      try {
        const updated = await client.revokeOrganizationInvitation(
          identity.organizationId,
          invitation.id,
          { expectedRevision: invitation.revision, operationId: crypto.randomUUID() },
        );
        if (owns(operation)) replaceInvitation(updated);
      } catch (error) {
        if (isOrganizationConflict(error) && ownsIdentity()) await loadInvitations();
        throw failure(error, "This invitation changed. We refreshed the list.");
      }
    },
    [
      claim,
      client,
      identity.organizationId,
      loadInvitations,
      owns,
      ownsIdentity,
      replaceInvitation,
    ],
  );

  const loadMoreInvitations = useCallback(async () => {
    const cursor = invitations.ownerKey === identityKey ? invitations.value.nextCursor : null;
    if (cursor) await loadInvitations(cursor, true);
  }, [identityKey, invitations, loadInvitations]);

  const value = useMemo<OrganizationDirectory>(() => {
    const visible = <Value,>(state: Owned<Value>, empty: Value): Loaded<Value> =>
      state.ownerKey === identityKey
        ? { value: state.value, loading: state.loading, error: state.error }
        : { value: empty, loading: true, error: null };
    const visibleMembers = visible(members, []);
    return {
      identity,
      youLabel,
      actorRole,
      canAdminister,
      singleUser,
      managedSession,
      overview: visible(overview, null),
      members: visibleMembers,
      invitations: visible(invitations, EMPTY_INVITATIONS),
      accessibleWorkspaceIds,
      you: visibleMembers.value.find((member) => member.subjectId === identity.subjectId) ?? null,
      reload,
      loadMoreInvitations,
      renameOrganization,
      createWorkspace,
      renameWorkspace,
      deleteWorkspace,
      setWorkspaceRole,
      removeWorkspaceAccess,
      changeOrganizationRole,
      transitionMember,
      invite,
      retryInvitation,
      revokeInvitation,
    };
  }, [
    accessibleWorkspaceIds,
    actorRole,
    canAdminister,
    changeOrganizationRole,
    createWorkspace,
    deleteWorkspace,
    identity,
    identityKey,
    invitations,
    invite,
    loadMoreInvitations,
    managedSession,
    members,
    overview,
    reload,
    removeWorkspaceAccess,
    renameOrganization,
    renameWorkspace,
    retryInvitation,
    revokeInvitation,
    setWorkspaceRole,
    singleUser,
    transitionMember,
    youLabel,
  ]);

  return <DirectoryContext.Provider value={value}>{children}</DirectoryContext.Provider>;
}

function you(
  members: Owned<OrganizationMember[]>,
  identity: OrganizationAdminIdentity,
): OrganizationMember | null {
  return members.value.find((member) => member.subjectId === identity.subjectId) ?? null;
}
