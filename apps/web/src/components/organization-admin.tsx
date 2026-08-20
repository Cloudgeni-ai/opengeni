import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import {
  Building2Icon,
  CheckIcon,
  ClockIcon,
  Loader2Icon,
  PencilIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  UserMinusIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { LoadErrorState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import {
  beginOrganizationAdminOperation,
  canInviteOrganizationRole,
  canRevokeOrganizationInvitation,
  isOrganizationConflict,
  maskedOrganizationSubject,
  organizationAdminIdentityKey,
  organizationAdminOperationSlot,
  organizationMemberCapabilities,
  ownsOrganizationAdminOperation,
  retentionPolicySummary,
  sameOrganizationAdminIdentity,
  validRetentionDays,
  type OrganizationAdminIdentity,
  type OrganizationAdminOperationLane,
  type OrganizationAdminOperation,
  type OrganizationAdminResource,
  type OrganizationAdminOperationSlot,
} from "@/lib/organization-admin";
import { formatTimestamp } from "@/lib/format";
import type {
  OrganizationAdministrationOverview,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationMembershipRole,
  OrganizationRetentionPolicy,
} from "@/types";

type OwnedState<Value> = {
  ownerKey: string;
  value: Value;
  loading: boolean;
  error: Error | null;
};

type MemberAction = "suspend" | "reactivate" | "offboard";

export function OrganizationOverviewSection(props: {
  client: OpenGeniCoreClient;
  identity: OrganizationAdminIdentity;
  actorRole: OrganizationMembershipRole | null;
  managedSession: boolean;
  accessibleWorkspaceIds: ReadonlySet<string>;
  onOrganizationChanged: () => void | Promise<void>;
}) {
  const identityKey = organizationAdminIdentityKey(props.identity);
  const identityRef = useRef<OrganizationAdminIdentity | null>(props.identity);
  identityRef.current = props.identity;
  const sequenceRef = useRef(new Map<OrganizationAdminOperationSlot, number>());
  const activeRef = useRef(new Map<OrganizationAdminOperationSlot, OrganizationAdminOperation>());
  const [state, setState] = useState<OwnedState<OrganizationAdministrationOverview | null>>({
    ownerKey: "",
    value: null,
    loading: false,
    error: null,
  });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const canAdminister = props.actorRole === "owner" || props.actorRole === "admin";

  const claim = useCallback(
    (lane: OrganizationAdminOperationLane) => {
      const slot = organizationAdminOperationSlot("overview", lane);
      const operation = beginOrganizationAdminOperation({
        identity: props.identity,
        resource: "overview",
        lane,
        previousSequence: sequenceRef.current.get(slot) ?? 0,
      });
      sequenceRef.current.set(slot, operation.sequence);
      activeRef.current.set(slot, operation);
      return operation;
    },
    [props.identity],
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

  useEffect(() => {
    const active = activeRef.current;
    identityRef.current = props.identity;
    return () => {
      identityRef.current = null;
      active.clear();
    };
  }, [props.identity]);

  const load = useCallback(async () => {
    if (!props.managedSession || !canAdminister || !props.identity.organizationId) {
      setState({ ownerKey: identityKey, value: null, loading: false, error: null });
      return;
    }
    const operation = claim("read");
    setState((current) => ({ ...current, ownerKey: identityKey, loading: true, error: null }));
    try {
      const overview = await props.client.getOrganizationAdministrationOverview(
        props.identity.organizationId,
      );
      if (!owns(operation)) return;
      setName(overview.organization.name);
      setState({ ownerKey: identityKey, value: overview, loading: false, error: null });
    } catch (error) {
      if (!owns(operation)) return;
      setState({
        ownerKey: identityKey,
        value: null,
        loading: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }, [canAdminister, claim, identityKey, owns, props.client, props.identity, props.managedSession]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = state.ownerKey === identityKey ? state : { ...state, value: null, loading: true };
  const overview = visible.value;
  const peopleWithAccess = new Set(
    overview?.workspaces.flatMap((workspace) =>
      workspace.members
        .filter((member) => member.principalKind === "human")
        .map((member) => member.subjectId),
    ) ?? [],
  ).size;

  async function saveName() {
    if (!overview || !name.trim() || name.trim() === overview.organization.name) {
      setEditing(false);
      return;
    }
    const operation = claim("mutation");
    setBusy(true);
    try {
      const organization = await props.client.updateOrganizationName(
        props.identity.organizationId,
        {
          name: name.trim(),
          expectedUpdatedAt: overview.organization.updatedAt,
          operationId: crypto.randomUUID(),
        },
      );
      if (!owns(operation)) return;
      setState((current) =>
        current.ownerKey === identityKey && current.value
          ? { ...current, value: { ...current.value, organization } }
          : current,
      );
      setEditing(false);
      toast.success("Organization name updated");
      await props.onOrganizationChanged();
    } catch (error) {
      if (!owns(operation)) return;
      toast.error("Couldn't update organization name", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (owns(operation)) setBusy(false);
    }
  }

  if (!props.managedSession || !canAdminister) {
    return (
      <Notice tone="muted" title="Organization overview unavailable">
        An active organization owner or administrator session is required.
      </Notice>
    );
  }
  if (visible.error) {
    return (
      <LoadErrorState
        title="Couldn't load the organization"
        error={visible.error}
        onRetry={() => void load()}
      />
    );
  }
  if (!overview) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface p-4 text-sm text-fg-muted">
        <Loader2Icon className="size-4 animate-spin" /> Loading organization…
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <section className="grid gap-4 rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
              Organization
            </p>
            {editing ? (
              <div className="mt-1 flex max-w-lg gap-2">
                <Input
                  aria-label="Organization name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={120}
                  autoFocus
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || !name.trim()}
                  onClick={() => void saveName()}
                >
                  {busy ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <CheckIcon className="size-3.5" />
                  )}{" "}
                  Save
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setName(overview.organization.name);
                    setEditing(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <h2 className="mt-1 text-xl font-semibold tracking-tight">
                {overview.organization.name}
              </h2>
            )}
            <p className="mt-1 text-xs text-fg-muted">
              Manage the shared workspaces and access that make up your company.
            </p>
          </div>
          {!editing ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
              <PencilIcon className="size-3.5" /> Rename
            </Button>
          ) : null}
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <Metric label="Shared workspaces" value={overview.workspaces.length} />
          <Metric label="People with access" value={peopleWithAccess} />
          <Metric label="Your role" value={props.actorRole ?? "Unknown"} />
        </div>
      </section>

      <section className="grid gap-3 rounded-lg border border-border bg-surface p-4">
        <div>
          <h2 className="text-sm font-medium">Workspace access</h2>
          <p className="mt-1 text-xs text-fg-muted">
            Every shared workspace in this organization. Personal workspaces and their content are
            never included.
          </p>
        </div>
        {overview.workspaces.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-4 text-sm text-fg-muted">
            No shared workspaces yet.
          </p>
        ) : (
          <div className="grid gap-2">
            {overview.workspaces.map((workspace) => (
              <details
                key={workspace.id}
                className="group rounded-lg border border-border/80 bg-bg/25"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <Building2Icon className="size-4 shrink-0 text-brand" />
                    <span className="truncate text-sm font-medium">{workspace.name}</span>
                    {props.accessibleWorkspaceIds.has(workspace.id) ? (
                      <span className="rounded-full border border-border px-1.5 py-0.5 text-2xs text-fg-muted">
                        You have access
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-xs text-fg-muted">
                    {workspace.members.length}{" "}
                    {workspace.members.length === 1 ? "member" : "members"}
                  </span>
                </summary>
                <div className="border-t border-border/70 px-3 py-2">
                  {workspace.members.length === 0 ? (
                    <p className="py-2 text-xs text-fg-subtle">No direct workspace access.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-left text-xs">
                        <thead className="text-fg-subtle">
                          <tr>
                            <th className="py-1 pr-4 font-medium">Person or service</th>
                            <th className="py-1 pr-4 font-medium">Role</th>
                            <th className="py-1 font-medium">Access</th>
                          </tr>
                        </thead>
                        <tbody>
                          {workspace.members.map((member) => (
                            <tr key={member.membershipId} className="border-t border-border/50">
                              <td className="py-2 pr-4">
                                <span className="font-medium">
                                  {member.subjectLabel ??
                                    maskedOrganizationSubject(member.subjectId)}
                                </span>
                                <span className="ml-2 text-2xs capitalize text-fg-subtle">
                                  {member.principalKind}
                                </span>
                              </td>
                              <td className="py-2 pr-4 capitalize">{member.role}</td>
                              <td className="py-2 text-fg-muted">
                                {member.permissions.length} permissions
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-border/70 bg-bg/35 px-3 py-2">
      <p className="text-lg font-semibold capitalize">{value}</p>
      <p className="text-2xs text-fg-subtle">{label}</p>
    </div>
  );
}

export function OrganizationPeopleSection(props: {
  client: OpenGeniCoreClient;
  identity: OrganizationAdminIdentity;
  actorRole: OrganizationMembershipRole | null;
  managedSession: boolean;
  onAuthorityChanged: () => void;
}) {
  const identityKey = organizationAdminIdentityKey(props.identity);
  const identityRef = useRef<OrganizationAdminIdentity | null>(props.identity);
  identityRef.current = props.identity;
  const sequenceRef = useRef(new Map<OrganizationAdminOperationSlot, number>());
  const activeRef = useRef(new Map<OrganizationAdminOperationSlot, OrganizationAdminOperation>());
  const [membersState, setMembersState] = useState<OwnedState<OrganizationMember[]>>({
    ownerKey: "",
    value: [],
    loading: false,
    error: null,
  });
  const [adminInvitesState, setAdminInvitesState] = useState<
    OwnedState<{ invitations: OrganizationInvitation[]; nextCursor: string | null }>
  >({ ownerKey: "", value: { invitations: [], nextCursor: null }, loading: false, error: null });
  const [incomingState, setIncomingState] = useState<
    OwnedState<{ invitations: OrganizationInvitation[]; nextCursor: string | null }>
  >({ ownerKey: "", value: { invitations: [], nextCursor: null }, loading: false, error: null });
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrganizationMembershipRole>("member");
  const [roleDrafts, setRoleDrafts] = useState<Record<string, OrganizationMembershipRole>>({});
  const [busyResource, setBusyResource] = useState<OrganizationAdminResource | null>(null);
  const [busyOwnerKey, setBusyOwnerKey] = useState("");
  const [memberConfirmation, setMemberConfirmation] = useState<{
    member: OrganizationMember;
    action: MemberAction;
  } | null>(null);
  const [revokeConfirmation, setRevokeConfirmation] = useState<OrganizationInvitation | null>(null);
  const actionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const peopleHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const [liveOutcome, setLiveOutcome] = useState("");
  const canAdminister = props.actorRole === "owner" || props.actorRole === "admin";

  const claim = useCallback(
    (
      resource: OrganizationAdminResource,
      lane: OrganizationAdminOperationLane,
    ): OrganizationAdminOperation => {
      const slot = organizationAdminOperationSlot(resource, lane);
      const accepted = beginOrganizationAdminOperation({
        identity: props.identity,
        resource,
        lane,
        previousSequence: sequenceRef.current.get(slot) ?? 0,
      });
      sequenceRef.current.set(slot, accepted.sequence);
      activeRef.current.set(slot, accepted);
      return accepted;
    },
    [props.identity],
  );
  const owns = useCallback((accepted: OrganizationAdminOperation) => {
    return ownsOrganizationAdminOperation({
      currentIdentity: identityRef.current,
      currentOperation:
        activeRef.current.get(organizationAdminOperationSlot(accepted.resource, accepted.lane)) ??
        null,
      accepted,
    });
  }, []);
  const ownsIdentity = useCallback(
    () => sameOrganizationAdminIdentity(identityRef.current, props.identity),
    [props.identity],
  );

  useEffect(() => {
    const activeOperations = activeRef.current;
    identityRef.current = props.identity;
    return () => {
      identityRef.current = null;
      activeOperations.clear();
    };
  }, [props.identity]);

  const loadMembers = useCallback(async () => {
    if (!props.managedSession || !canAdminister) {
      setMembersState({ ownerKey: identityKey, value: [], loading: false, error: null });
      return;
    }
    const operation = claim("members", "read");
    setMembersState({ ownerKey: identityKey, value: [], loading: true, error: null });
    try {
      const response = await props.client.listOrganizationMembers(props.identity.organizationId);
      if (!owns(operation)) return;
      setRoleDrafts(Object.fromEntries(response.members.map((member) => [member.id, member.role])));
      setMembersState({
        ownerKey: identityKey,
        value: response.members,
        loading: false,
        error: null,
      });
    } catch (error) {
      if (!owns(operation)) return;
      setMembersState({
        ownerKey: identityKey,
        value: [],
        loading: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }, [
    canAdminister,
    claim,
    identityKey,
    owns,
    props.client,
    props.identity.organizationId,
    props.managedSession,
  ]);

  const loadAdminInvitations = useCallback(
    async (cursor?: string, append = false) => {
      if (!props.managedSession || !canAdminister) {
        setAdminInvitesState({
          ownerKey: identityKey,
          value: { invitations: [], nextCursor: null },
          loading: false,
          error: null,
        });
        return;
      }
      const operation = claim("admin-invitations", "read");
      setAdminInvitesState((current) => ({
        ownerKey: identityKey,
        value:
          append && current.ownerKey === identityKey
            ? current.value
            : { invitations: [], nextCursor: null },
        loading: true,
        error: null,
      }));
      try {
        const response = await props.client.listOrganizationInvitationsForOrganization(
          props.identity.organizationId,
          { ...(cursor ? { cursor } : {}), limit: 50 },
        );
        if (!owns(operation)) return;
        setAdminInvitesState((current) => ({
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
        setAdminInvitesState((current) => ({
          ownerKey: identityKey,
          value:
            current.ownerKey === identityKey
              ? current.value
              : { invitations: [], nextCursor: null },
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        }));
      }
    },
    [
      canAdminister,
      claim,
      identityKey,
      owns,
      props.client,
      props.identity.organizationId,
      props.managedSession,
    ],
  );

  const loadIncomingInvitations = useCallback(
    async (cursor?: string, append = false) => {
      if (!props.managedSession) {
        setIncomingState({
          ownerKey: identityKey,
          value: { invitations: [], nextCursor: null },
          loading: false,
          error: null,
        });
        return;
      }
      const operation = claim("incoming-invitations", "read");
      setIncomingState((current) => ({
        ownerKey: identityKey,
        value:
          append && current.ownerKey === identityKey
            ? current.value
            : { invitations: [], nextCursor: null },
        loading: true,
        error: null,
      }));
      try {
        const response = await props.client.listOrganizationInvitations({
          ...(cursor ? { cursor } : {}),
          limit: 50,
        });
        if (!owns(operation)) return;
        setIncomingState((current) => ({
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
        setIncomingState((current) => ({
          ownerKey: identityKey,
          value:
            current.ownerKey === identityKey
              ? current.value
              : { invitations: [], nextCursor: null },
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        }));
      }
    },
    [claim, identityKey, owns, props.client, props.managedSession],
  );

  useEffect(() => {
    setBusyResource(null);
    setMemberConfirmation(null);
    setRevokeConfirmation(null);
    setLiveOutcome("");
    void loadMembers();
    void loadAdminInvitations();
    void loadIncomingInvitations();
  }, [identityKey, loadAdminInvitations, loadIncomingInvitations, loadMembers]);
  useEffect(() => {
    if (!canInviteOrganizationRole(props.actorRole, inviteRole)) setInviteRole("member");
  }, [inviteRole, props.actorRole]);

  const members =
    membersState.ownerKey === identityKey
      ? membersState
      : { ...membersState, value: [], loading: true, error: null };
  const adminInvites =
    adminInvitesState.ownerKey === identityKey
      ? adminInvitesState
      : {
          ...adminInvitesState,
          value: { invitations: [], nextCursor: null },
          loading: true,
          error: null,
        };
  const incoming =
    incomingState.ownerKey === identityKey
      ? incomingState
      : {
          ...incomingState,
          value: { invitations: [], nextCursor: null },
          loading: true,
          error: null,
        };
  const visibleBusyResource = busyOwnerKey === identityKey ? busyResource : null;

  async function createInvitation() {
    const email = inviteEmail.trim().toLowerCase();
    if (
      !email ||
      !canInviteOrganizationRole(props.actorRole, inviteRole) ||
      visibleBusyResource ||
      adminInvites.loading
    )
      return;
    const operation = claim("admin-invitations", "mutation");
    setBusyOwnerKey(identityKey);
    setBusyResource("admin-invitations");
    try {
      const invitation = await props.client.createOrganizationInvitation(
        props.identity.organizationId,
        {
          email,
          role: inviteRole,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          operationId: crypto.randomUUID(),
        },
      );
      if (!owns(operation)) return;
      setAdminInvitesState((current) => ({
        ownerKey: identityKey,
        value: {
          invitations: [
            invitation,
            ...current.value.invitations.filter((candidate) => candidate.id !== invitation.id),
          ],
          nextCursor: current.value.nextCursor,
        },
        loading: false,
        error: null,
      }));
      setInviteEmail("");
      setLiveOutcome(
        `Invitation created for ${invitation.targetEmail}. It is available in OpenGeni.`,
      );
      toast.success("Organization invitation created");
    } catch (error) {
      if (!owns(operation)) return;
      if (isOrganizationConflict(error)) {
        setBusyResource(null);
        await loadAdminInvitations();
        if (!ownsIdentity()) return;
      }
      toast.error(
        isOrganizationConflict(error) ? "Invitation state changed" : "Invitation failed",
        {
          description: isOrganizationConflict(error)
            ? "The authoritative invitation list was refreshed. Review it before trying again."
            : error instanceof Error
              ? error.message
              : String(error),
        },
      );
    } finally {
      if (owns(operation)) setBusyResource(null);
    }
  }

  async function revokeInvitation(invitation: OrganizationInvitation): Promise<boolean> {
    if (
      visibleBusyResource ||
      adminInvites.loading ||
      !canRevokeOrganizationInvitation(props.actorRole, invitation.role)
    )
      return false;
    const operation = claim("admin-invitations", "mutation");
    setBusyOwnerKey(identityKey);
    setBusyResource("admin-invitations");
    try {
      const updated = await props.client.revokeOrganizationInvitation(
        props.identity.organizationId,
        invitation.id,
        { expectedRevision: invitation.revision, operationId: crypto.randomUUID() },
      );
      if (!owns(operation)) return false;
      setAdminInvitesState((current) => ({
        ...current,
        value: {
          ...current.value,
          invitations: current.value.invitations.map((candidate) =>
            candidate.id === updated.id ? updated : candidate,
          ),
        },
      }));
      setLiveOutcome(`Invitation for ${updated.targetEmail} revoked.`);
      toast.success("Invitation revoked");
      return true;
    } catch (error) {
      if (!owns(operation)) return false;
      if (isOrganizationConflict(error)) {
        setBusyResource(null);
        await loadAdminInvitations();
        if (!ownsIdentity()) return false;
      }
      toast.error(isOrganizationConflict(error) ? "Invitation state changed" : "Revoke failed", {
        description: isOrganizationConflict(error)
          ? "The authoritative invitation list was refreshed. Review it before trying again."
          : error instanceof Error
            ? error.message
            : String(error),
      });
      return false;
    } finally {
      if (owns(operation)) setBusyResource(null);
    }
  }

  async function acceptInvitation(invitation: OrganizationInvitation) {
    if (visibleBusyResource || incoming.loading) return;
    const operation = claim("incoming-invitations", "mutation");
    setBusyOwnerKey(identityKey);
    setBusyResource("incoming-invitations");
    try {
      await props.client.acceptOrganizationInvitation(invitation.id, {
        expectedRevision: invitation.revision,
        operationId: crypto.randomUUID(),
      });
      if (!owns(operation)) return;
      setLiveOutcome(
        `Invitation to organization ${invitation.organizationId.slice(0, 8)} accepted.`,
      );
      toast.success("Organization invitation accepted");
      props.onAuthorityChanged();
    } catch (error) {
      if (!owns(operation)) return;
      if (isOrganizationConflict(error)) {
        setBusyResource(null);
        await loadIncomingInvitations();
        if (!ownsIdentity()) return;
      }
      toast.error(isOrganizationConflict(error) ? "Invitation state changed" : "Accept failed", {
        description: isOrganizationConflict(error)
          ? "Your authoritative invitation list was refreshed. Review it before trying again."
          : error instanceof Error
            ? error.message
            : String(error),
      });
    } finally {
      if (owns(operation)) setBusyResource(null);
    }
  }

  async function changeRole(member: OrganizationMember) {
    const role = roleDrafts[member.id] ?? member.role;
    if (role === member.role || visibleBusyResource) return;
    const operation = claim("members", "mutation");
    setBusyOwnerKey(identityKey);
    setBusyResource("members");
    try {
      const updated = await props.client.updateOrganizationMember(
        props.identity.organizationId,
        member.id,
        {
          kind: "change_role",
          role,
          expectedAuthorizationRevision: member.authorizationRevision,
          operationId: crypto.randomUUID(),
        },
      );
      if (!owns(operation)) return;
      setMembersState((current) => ({
        ...current,
        value: current.value.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        ),
      }));
      setLiveOutcome(`${maskedOrganizationSubject(updated.subjectId)} is now ${updated.role}.`);
      toast.success("Organization role changed");
      if (updated.subjectId === props.identity.subjectId) props.onAuthorityChanged();
    } catch (error) {
      if (!owns(operation)) return;
      if (isOrganizationConflict(error)) {
        setBusyResource(null);
        await loadMembers();
        if (!ownsIdentity()) return;
      }
      toast.error(
        isOrganizationConflict(error) ? "Membership state changed" : "Role change failed",
        {
          description: isOrganizationConflict(error)
            ? "The authoritative member list was refreshed. Review it before trying again."
            : error instanceof Error
              ? error.message
              : String(error),
        },
      );
    } finally {
      if (owns(operation)) setBusyResource(null);
    }
  }

  async function transitionMember(
    member: OrganizationMember,
    action: MemberAction,
  ): Promise<boolean> {
    if (visibleBusyResource) return false;
    const operation = claim("members", "mutation");
    setBusyOwnerKey(identityKey);
    setBusyResource("members");
    try {
      const updated = await props.client.updateOrganizationMember(
        props.identity.organizationId,
        member.id,
        {
          kind: action,
          expectedAuthorizationRevision: member.authorizationRevision,
          operationId: crypto.randomUUID(),
          reason: `${action} from the organization administration console`,
        },
      );
      if (!owns(operation)) return false;
      setMembersState((current) => ({
        ...current,
        value: current.value.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        ),
      }));
      setLiveOutcome(
        `${maskedOrganizationSubject(updated.subjectId)} ${action === "offboard" ? "offboarded" : action === "suspend" ? "suspended" : "reactivated"}.`,
      );
      toast.success(
        `Member ${action === "offboard" ? "offboarded" : action === "suspend" ? "suspended" : "reactivated"}`,
      );
      if (updated.subjectId === props.identity.subjectId) props.onAuthorityChanged();
      return true;
    } catch (error) {
      if (!owns(operation)) return false;
      if (isOrganizationConflict(error)) {
        setBusyResource(null);
        await loadMembers();
        if (!ownsIdentity()) return false;
      }
      toast.error(
        isOrganizationConflict(error) ? "Membership state changed" : `Could not ${action} member`,
        {
          description: isOrganizationConflict(error)
            ? "The authoritative member list was refreshed. Review it before trying again."
            : error instanceof Error
              ? error.message
              : String(error),
        },
      );
      return false;
    } finally {
      if (owns(operation)) setBusyResource(null);
    }
  }

  if (!props.managedSession) {
    return (
      <Notice title="Managed sign-in required">
        Organization membership administration is available only to an authenticated managed human.
      </Notice>
    );
  }

  const pendingIncoming = incoming.value.invitations.filter(
    (invite) => invite.status === "pending",
  );
  const activeOwnerCount = members.value.filter(
    (member) => member.role === "owner" && member.status === "active",
  ).length;
  return (
    <div className="grid gap-5">
      <section
        aria-labelledby="organization-people-heading"
        className="grid gap-3 rounded-lg border border-border bg-surface p-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2
              ref={peopleHeadingRef}
              id="organization-people-heading"
              tabIndex={-1}
              className="flex items-center gap-1.5 text-sm font-medium"
            >
              <UsersIcon className="size-3.5 text-brand" />
              People
            </h2>
            <p className="mt-1 text-xs text-fg-muted">
              Organization authority and lifecycle status. Workspace access is administered
              separately.
            </p>
          </div>
          {canAdminister ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={members.loading || visibleBusyResource === "members"}
              onClick={() => void loadMembers()}
            >
              <RefreshCwIcon className={members.loading ? "size-3.5 animate-spin" : "size-3.5"} />
              Refresh people
            </Button>
          ) : null}
        </div>
        <Notice title="Personal content stays personal">
          Organization administration never grants access to another member&apos;s Personal
          workspace, private sessions, credentials, Connections, or personal resources.
        </Notice>
        {!canAdminister ? (
          <p className="text-xs text-fg-subtle">
            Only organization owners and administrators can view the organization roster.
          </p>
        ) : members.error ? (
          <LoadErrorState
            title="Could not load organization people"
            error={members.error}
            onRetry={() => void loadMembers()}
          />
        ) : members.loading ? (
          <p role="status" className="flex items-center gap-2 text-xs text-fg-muted">
            <Loader2Icon className="size-3.5 animate-spin" />
            Loading organization people…
          </p>
        ) : (
          <div className="grid gap-2">
            {members.value.map((member) => {
              const capability = organizationMemberCapabilities(
                props.actorRole,
                member,
                activeOwnerCount,
              );
              const label =
                member.subjectId === props.identity.subjectId
                  ? "You"
                  : maskedOrganizationSubject(member.subjectId);
              const roleDraft = roleDrafts[member.id] ?? member.role;
              return (
                <article
                  key={member.id}
                  className="grid gap-3 rounded-lg border border-border bg-bg/35 p-3 sm:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-medium">{label}</h3>
                    <p className="mt-0.5 text-xs text-fg-subtle">
                      Profile name and email are unavailable from this API. Stable masked identifier
                      shown.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <span className="rounded-full border border-border px-2 py-0.5 text-xs capitalize">
                        {member.role}
                      </span>
                      <span className="rounded-full border border-border px-2 py-0.5 text-xs capitalize text-fg-muted">
                        {member.status}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-end justify-end gap-2">
                    {capability.canChangeRole ? (
                      <label className="grid gap-1 text-xs text-fg-muted">
                        Role for {label}
                        <select
                          className="h-9 rounded-md border border-border bg-bg px-2 text-sm text-fg"
                          value={roleDraft}
                          disabled={visibleBusyResource === "members"}
                          onChange={(event) =>
                            setRoleDrafts((current) => ({
                              ...current,
                              [member.id]: event.target.value as OrganizationMembershipRole,
                            }))
                          }
                        >
                          {capability.allowedRoles.map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    {capability.canChangeRole && roleDraft !== member.role ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={visibleBusyResource === "members"}
                        onClick={() => void changeRole(member)}
                      >
                        Change role for {label}
                      </Button>
                    ) : null}
                    {capability.canSuspend ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={visibleBusyResource === "members"}
                        onClick={(event) => {
                          actionTriggerRef.current = event.currentTarget;
                          setMemberConfirmation({ member, action: "suspend" });
                        }}
                      >
                        Suspend {label}
                      </Button>
                    ) : null}
                    {capability.canReactivate ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={visibleBusyResource === "members"}
                        onClick={(event) => {
                          actionTriggerRef.current = event.currentTarget;
                          setMemberConfirmation({ member, action: "reactivate" });
                        }}
                      >
                        Reactivate {label}
                      </Button>
                    ) : null}
                    {capability.canOffboard ? (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={visibleBusyResource === "members"}
                        onClick={(event) => {
                          actionTriggerRef.current = event.currentTarget;
                          setMemberConfirmation({ member, action: "offboard" });
                        }}
                      >
                        <UserMinusIcon className="size-3.5" />
                        Offboard {label}
                      </Button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {canAdminister ? (
        <section
          aria-labelledby="organization-invitations-heading"
          className="grid gap-3 rounded-lg border border-border bg-surface p-4"
        >
          <div>
            <h2
              id="organization-invitations-heading"
              className="flex items-center gap-1.5 text-sm font-medium"
            >
              <UserPlusIcon className="size-3.5 text-brand" />
              People &amp; invitations
            </h2>
            <p className="mt-1 text-xs text-fg-muted">
              Invitations currently require an existing registered user and expire after seven days.
            </p>
          </div>
          <fieldset
            disabled={visibleBusyResource === "admin-invitations" || adminInvites.loading}
            className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]"
          >
            <legend className="sr-only">Invite a registered user</legend>
            <div className="grid gap-1">
              <Label htmlFor="organization-invite-email">Registered user email</Label>
              <Input
                id="organization-invite-email"
                type="email"
                autoComplete="email"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
              />
            </div>
            <label className="grid gap-1 text-sm">
              Organization role
              <select
                className="h-9 rounded-md border border-border bg-bg px-2 text-sm"
                value={inviteRole}
                onChange={(event) =>
                  setInviteRole(event.target.value as OrganizationMembershipRole)
                }
              >
                {(["owner", "admin", "member"] as const)
                  .filter((role) => canInviteOrganizationRole(props.actorRole, role))
                  .map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
              </select>
            </label>
            <Button
              className="self-end"
              type="button"
              disabled={
                !inviteEmail.trim() ||
                visibleBusyResource !== null ||
                adminInvites.loading ||
                !canInviteOrganizationRole(props.actorRole, inviteRole)
              }
              onClick={() => void createInvitation()}
            >
              Invite registered user
            </Button>
          </fieldset>
          {adminInvites.error ? (
            <LoadErrorState
              title="Could not load organization invitations"
              error={adminInvites.error}
              onRetry={() => void loadAdminInvitations()}
            />
          ) : adminInvites.loading && adminInvites.value.invitations.length === 0 ? (
            <p role="status" className="text-xs text-fg-muted">
              Loading invitations…
            </p>
          ) : (
            <div className="grid gap-2">
              {adminInvites.value.invitations.map((invite) => (
                <div
                  key={invite.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs"
                >
                  <div>
                    <span className="font-medium">{invite.targetEmail}</span>
                    <span className="ml-2 capitalize text-fg-muted">
                      {invite.role} · {invite.status}
                    </span>
                    <div className="mt-0.5 text-fg-subtle">
                      Expires {formatTimestamp(invite.expiresAt)}
                    </div>
                  </div>
                  {invite.status === "pending" &&
                  canRevokeOrganizationInvitation(props.actorRole, invite.role) ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={visibleBusyResource !== null || adminInvites.loading}
                      onClick={(event) => {
                        actionTriggerRef.current = event.currentTarget;
                        setRevokeConfirmation(invite);
                      }}
                    >
                      Revoke invitation for {invite.targetEmail}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
          {adminInvites.value.nextCursor ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={adminInvites.loading || visibleBusyResource === "admin-invitations"}
              onClick={() =>
                void loadAdminInvitations(adminInvites.value.nextCursor ?? undefined, true)
              }
            >
              Load more invitations
            </Button>
          ) : null}
        </section>
      ) : null}

      <section
        aria-labelledby="incoming-invitations-heading"
        className="grid gap-3 rounded-lg border border-border bg-surface p-4"
      >
        <div>
          <h2
            id="incoming-invitations-heading"
            className="flex items-center gap-1.5 text-sm font-medium"
          >
            <ClockIcon className="size-3.5 text-brand" />
            Your incoming invitations
          </h2>
          <p className="mt-1 text-xs text-fg-muted">
            Accepting creates your own membership and Personal workspace in that organization. It
            grants no access to another member&apos;s personal content.
          </p>
        </div>
        {incoming.error ? (
          <LoadErrorState
            title="Could not load your invitations"
            error={incoming.error}
            onRetry={() => void loadIncomingInvitations()}
          />
        ) : incoming.loading && incoming.value.invitations.length === 0 ? (
          <p role="status" className="text-xs text-fg-muted">
            Loading your invitations…
          </p>
        ) : pendingIncoming.length === 0 ? (
          <p className="text-xs text-fg-subtle">No pending invitations.</p>
        ) : (
          <div className="grid gap-2">
            {pendingIncoming.map((invite) => (
              <div
                key={invite.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs"
              >
                <div>
                  <span className="font-medium">
                    Organization {invite.organizationId.slice(0, 8)}
                  </span>
                  <span className="ml-2 capitalize text-fg-muted">{invite.role}</span>
                  <div className="mt-0.5 text-fg-subtle">
                    Created for {invite.targetEmail} · expires {formatTimestamp(invite.expiresAt)}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  disabled={visibleBusyResource !== null || incoming.loading}
                  onClick={() => void acceptInvitation(invite)}
                >
                  <CheckIcon className="size-3.5" />
                  Accept invitation to organization {invite.organizationId.slice(0, 8)}
                </Button>
              </div>
            ))}
          </div>
        )}
        {incoming.value.nextCursor ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={incoming.loading || visibleBusyResource === "incoming-invitations"}
            onClick={() =>
              void loadIncomingInvitations(incoming.value.nextCursor ?? undefined, true)
            }
          >
            Load more incoming invitations
          </Button>
        ) : null}
      </section>

      <p role="status" aria-live="polite" className="min-h-5 text-xs text-fg-muted">
        {liveOutcome}
      </p>

      <ConfirmDialog
        open={memberConfirmation !== null}
        onOpenChange={(open) => {
          if (!open) setMemberConfirmation(null);
        }}
        title={
          memberConfirmation
            ? `${memberConfirmation.action === "offboard" ? "Offboard" : memberConfirmation.action === "suspend" ? "Suspend" : "Reactivate"} ${memberConfirmation.member.subjectId === props.identity.subjectId ? "your membership" : maskedOrganizationSubject(memberConfirmation.member.subjectId)}?`
            : "Update member?"
        }
        description={
          memberConfirmation ? memberActionDescription(memberConfirmation.action) : undefined
        }
        confirmLabel={
          memberConfirmation
            ? `${memberConfirmation.action === "offboard" ? "Offboard" : memberConfirmation.action === "suspend" ? "Suspend" : "Reactivate"} member`
            : "Update member"
        }
        destructive={memberConfirmation?.action !== "reactivate"}
        cancelAutoFocus
        restoreFocusRef={actionTriggerRef}
        restoreFocusFallbackRef={peopleHeadingRef}
        onConfirm={async () =>
          memberConfirmation
            ? await transitionMember(memberConfirmation.member, memberConfirmation.action)
            : false
        }
      />
      <ConfirmDialog
        open={revokeConfirmation !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeConfirmation(null);
        }}
        title={
          revokeConfirmation
            ? `Revoke invitation for ${revokeConfirmation.targetEmail}?`
            : "Revoke invitation?"
        }
        description="The pending invitation stops working immediately. The registered user is not added to the organization."
        confirmLabel="Revoke invitation"
        cancelAutoFocus
        restoreFocusRef={actionTriggerRef}
        restoreFocusFallbackRef={peopleHeadingRef}
        onConfirm={async () =>
          revokeConfirmation ? await revokeInvitation(revokeConfirmation) : false
        }
      />
    </div>
  );
}

function memberActionDescription(action: MemberAction): string {
  if (action === "suspend") {
    return "Access is revoked immediately, shared-workspace grants are removed, personal grants are revoked, and nonterminal work is cancelled. Personal data is retained under the organization retention policy.";
  }
  if (action === "reactivate") {
    return "Active organization membership and the member's own Personal workspace access are restored. Shared-workspace grants removed during suspension are not restored automatically.";
  }
  return "Offboarding is terminal: access is revoked immediately, work is cancelled, the member cannot be re-invited, and retained personal data follows the organization retention policy.";
}

export function OrganizationRetentionSection(props: {
  client: OpenGeniCoreClient;
  identity: OrganizationAdminIdentity;
  actorRole: OrganizationMembershipRole | null;
  managedSession: boolean;
}) {
  const identityKey = organizationAdminIdentityKey(props.identity);
  const identityRef = useRef<OrganizationAdminIdentity | null>(props.identity);
  identityRef.current = props.identity;
  const sequenceRef = useRef(new Map<OrganizationAdminOperationLane, number>());
  const operationRef = useRef(
    new Map<OrganizationAdminOperationLane, OrganizationAdminOperation>(),
  );
  const [state, setState] = useState<OwnedState<OrganizationRetentionPolicy | null>>({
    ownerKey: "",
    value: null,
    loading: false,
    error: null,
  });
  const [mode, setMode] = useState<"retain" | "delete_after">("retain");
  const [days, setDays] = useState("30");
  const [busy, setBusy] = useState(false);
  const [busyOwnerKey, setBusyOwnerKey] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [liveOutcome, setLiveOutcome] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const canRead =
    props.managedSession && (props.actorRole === "owner" || props.actorRole === "admin");
  const canEdit = props.actorRole === "owner";

  const claim = useCallback(
    (lane: OrganizationAdminOperationLane) => {
      const operation = beginOrganizationAdminOperation({
        identity: props.identity,
        resource: "retention",
        lane,
        previousSequence: sequenceRef.current.get(lane) ?? 0,
      });
      sequenceRef.current.set(lane, operation.sequence);
      operationRef.current.set(lane, operation);
      return operation;
    },
    [props.identity],
  );
  const owns = useCallback(
    (operation: OrganizationAdminOperation) =>
      ownsOrganizationAdminOperation({
        currentIdentity: identityRef.current,
        currentOperation: operationRef.current.get(operation.lane) ?? null,
        accepted: operation,
      }),
    [],
  );
  const ownsIdentity = useCallback(
    () => sameOrganizationAdminIdentity(identityRef.current, props.identity),
    [props.identity],
  );
  useEffect(() => {
    const activeOperations = operationRef.current;
    identityRef.current = props.identity;
    return () => {
      identityRef.current = null;
      activeOperations.clear();
    };
  }, [props.identity]);
  const load = useCallback(async () => {
    if (!canRead) {
      setState({ ownerKey: identityKey, value: null, loading: false, error: null });
      return;
    }
    const operation = claim("read");
    setState({ ownerKey: identityKey, value: null, loading: true, error: null });
    try {
      const policy = await props.client.getOrganizationRetentionPolicy(
        props.identity.organizationId,
      );
      if (!owns(operation)) return;
      setState({ ownerKey: identityKey, value: policy, loading: false, error: null });
      setMode(policy.mode);
      setDays(String(policy.retentionDays ?? 30));
    } catch (error) {
      if (!owns(operation)) return;
      setState({
        ownerKey: identityKey,
        value: null,
        loading: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }, [canRead, claim, identityKey, owns, props.client, props.identity.organizationId]);
  useEffect(() => {
    setBusy(false);
    setConfirming(false);
    setLiveOutcome("");
    void load();
  }, [identityKey, load]);
  const visible =
    state.ownerKey === identityKey ? state : { ...state, value: null, loading: true, error: null };
  const visibleBusy = busyOwnerKey === identityKey && busy;

  async function updatePolicy(): Promise<boolean> {
    if (!visible.value || visibleBusy || !canEdit) return false;
    const retentionDays = mode === "retain" ? null : Number(days);
    if (mode === "delete_after" && !validRetentionDays(retentionDays ?? Number.NaN)) return false;
    const operation = claim("mutation");
    setBusyOwnerKey(identityKey);
    setBusy(true);
    try {
      const updated = await props.client.updateOrganizationRetentionPolicy(
        props.identity.organizationId,
        {
          mode,
          retentionDays,
          expectedVersion: visible.value.version,
          operationId: crypto.randomUUID(),
        },
      );
      if (!owns(operation)) return false;
      setState({ ownerKey: identityKey, value: updated, loading: false, error: null });
      setLiveOutcome("Retention policy updated.");
      toast.success("Retention policy updated");
      return true;
    } catch (error) {
      if (!owns(operation)) return false;
      if (isOrganizationConflict(error)) {
        setBusy(false);
        await load();
        if (!ownsIdentity()) return false;
      }
      toast.error(
        isOrganizationConflict(error) ? "Retention policy changed" : "Retention update failed",
        {
          description: isOrganizationConflict(error)
            ? "The authoritative policy was refreshed. Review it and submit a new action."
            : error instanceof Error
              ? error.message
              : String(error),
        },
      );
      return false;
    } finally {
      if (owns(operation)) setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="organization-retention-heading"
      className="grid gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2
            ref={headingRef}
            id="organization-retention-heading"
            tabIndex={-1}
            className="flex items-center gap-1.5 text-sm font-medium"
          >
            <ShieldCheckIcon className="size-3.5 text-brand" />
            Personal-data retention after offboarding
          </h2>
          <p className="mt-1 text-xs text-fg-muted">
            Retention controls stored personal data after terminal offboarding. It never delays
            immediate access revocation.
          </p>
        </div>
        {canRead ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={visible.loading || visibleBusy}
            onClick={() => void load()}
          >
            <RefreshCwIcon className={visible.loading ? "size-3.5 animate-spin" : "size-3.5"} />
            Refresh policy
          </Button>
        ) : null}
      </div>
      <Notice title="Authority boundary">
        Organization roles do not expose another member&apos;s Personal workspace, private sessions,
        credentials, Connections, or personal resources. Cleanup occurs only through the bounded
        operator retention sweep after eligibility.
      </Notice>
      {!canRead ? (
        <p className="text-xs text-fg-subtle">
          Only organization owners and administrators can read this policy.
        </p>
      ) : visible.error ? (
        <LoadErrorState
          title="Could not load retention policy"
          error={visible.error}
          onRetry={() => void load()}
        />
      ) : visible.loading || !visible.value ? (
        <p role="status" className="flex items-center gap-2 text-xs text-fg-muted">
          <Loader2Icon className="size-3.5 animate-spin" />
          Loading retention policy…
        </p>
      ) : (
        <>
          <p className="text-sm">{retentionPolicySummary(visible.value)}</p>
          <p className="text-xs text-fg-subtle">
            Policy version {visible.value.version} · updated{" "}
            {formatTimestamp(visible.value.updatedAt)}
          </p>
          {canEdit ? (
            <fieldset
              disabled={visibleBusy}
              className="grid gap-3 rounded-md border border-border p-3"
            >
              <legend className="px-1 text-sm font-medium">Owner-only retention policy</legend>
              <label className="flex gap-2 text-sm">
                <input
                  type="radio"
                  name="retention-mode"
                  checked={mode === "retain"}
                  onChange={() => setMode("retain")}
                />
                Retain personal data indefinitely after offboarding
              </label>
              <label className="flex gap-2 text-sm">
                <input
                  type="radio"
                  name="retention-mode"
                  checked={mode === "delete_after"}
                  onChange={() => setMode("delete_after")}
                />
                Make personal data eligible for operator cleanup after a bounded delay
              </label>
              {mode === "delete_after" ? (
                <div className="grid max-w-52 gap-1">
                  <Label htmlFor="retention-days">Retention days (30–90)</Label>
                  <Input
                    id="retention-days"
                    type="number"
                    min={30}
                    max={90}
                    step={1}
                    value={days}
                    onChange={(event) => setDays(event.target.value)}
                  />
                </div>
              ) : null}
              <Button
                ref={triggerRef}
                type="button"
                className="w-fit"
                disabled={
                  visibleBusy ||
                  (mode === visible.value.mode &&
                    (mode === "retain" || Number(days) === visible.value.retentionDays)) ||
                  (mode === "delete_after" && !validRetentionDays(Number(days)))
                }
                onClick={() => setConfirming(true)}
              >
                Review retention change
              </Button>
            </fieldset>
          ) : (
            <p className="text-xs text-fg-subtle">
              Only an organization owner can edit retention. Administrators have read-only access.
            </p>
          )}
        </>
      )}
      <p role="status" aria-live="polite" className="min-h-5 text-xs text-fg-muted">
        {liveOutcome}
      </p>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Change personal-data retention policy?"
        description={
          mode === "retain"
            ? "Offboarded members' personal data will be retained indefinitely. This does not restore or preserve their access."
            : `Offboarded members' personal data will become eligible for the bounded operator cleanup sweep after ${days} days. Access is still revoked immediately at offboarding.`
        }
        confirmLabel="Change retention policy"
        destructive={mode === "delete_after"}
        cancelAutoFocus
        restoreFocusRef={triggerRef}
        restoreFocusFallbackRef={headingRef}
        onConfirm={updatePolicy}
      />
    </section>
  );
}
