import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import {
  getOrganizationPrivateSessionSettings,
  updateOrganizationPrivateSessionSettings,
} from "@opengeni/sdk/organization-private-session-settings";
import { retryOrganizationUserSetupDelivery } from "@opengeni/sdk/organization-user-setup";
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
import { PermissionGroupPicker } from "@/components/permission-picker";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
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
import { workspaceMemberPermissionGroups } from "@/lib/permissions";
import type {
  OrganizationAdministrationOverview,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationMembershipRole,
  OrganizationPrivateSessionSettings,
  OrganizationRetentionPolicy,
  OrganizationWorkspaceAccess,
  OrganizationWorkspaceAccessMember,
  SdkPermission,
} from "@/types";

type OwnedState<Value> = {
  ownerKey: string;
  value: Value;
  loading: boolean;
  error: Error | null;
};

type MemberAction = "suspend" | "reactivate" | "offboard";

const ORGANIZATION_ROLE_LABELS: Record<OrganizationMembershipRole, string> = {
  owner: "Owner",
  admin: "Administrator",
  member: "Member",
};

type WorkspaceMemberRole = OrganizationWorkspaceAccessMember["role"];

function organizationMemberStatusLabel(status: OrganizationMember["status"]): string {
  if (status === "suspended") return "Access paused";
  if (status === "revoked") return "Removed";
  if (status === "provisioning") return "Joining";
  return "Active";
}

function invitationDeliveryOutcome(invitation: OrganizationInvitation): string {
  switch (invitation.delivery?.state) {
    case "sent":
      return `Invitation sent to ${invitation.targetEmail}.`;
    case "failed":
      return `Invitation recorded for ${invitation.targetEmail}, but delivery failed. Retry is available.`;
    case "outcome_unknown":
      return invitation.delivery.retryState === "reconciliation_required"
        ? `Invitation recorded for ${invitation.targetEmail}; the provider outcome must be reconciled before any new invitation is sent.`
        : `Invitation recorded for ${invitation.targetEmail}; the provider outcome is unknown. A safe retry is available.`;
    case "pending":
      return `Invitation recorded for ${invitation.targetEmail}; delivery is still pending.`;
    case "revoked":
      return `Invitation for ${invitation.targetEmail} is revoked.`;
    default:
      return `Invitation recorded for ${invitation.targetEmail}; delivery has not started.`;
  }
}

function InvitationDeliveryStatus({ invitation }: { invitation: OrganizationInvitation }) {
  const delivery = invitation.delivery;
  if (!delivery) return <p className="mt-0.5 text-fg-subtle">Delivery not started</p>;
  const label =
    invitation.status !== "pending" &&
    (delivery.state === "failed" || delivery.state === "outcome_unknown")
      ? `Delivery ${delivery.state === "failed" ? "failed" : "outcome unknown"} — invitation ${invitation.status}`
      : delivery.retryState === "reconciliation_required"
        ? "Provider outcome requires reconciliation — do not resend"
        : {
            pending: "Delivery pending",
            sent: "Email sent",
            failed: "Delivery failed — retry available",
            outcome_unknown: "Provider outcome unknown — safe retry available",
            revoked: "Delivery revoked",
          }[delivery.state];
  return (
    <p className="mt-0.5 text-fg-subtle">
      {label} · {delivery.attemptCount} {delivery.attemptCount === 1 ? "attempt" : "attempts"}
    </p>
  );
}

function memberActionTitle(action: MemberAction, target: string): string {
  if (action === "suspend") return `Pause access for ${target}?`;
  if (action === "reactivate") return `Restore access for ${target}?`;
  return `Remove ${target} from the organization?`;
}

function memberActionConfirmLabel(action: MemberAction): string {
  if (action === "suspend") return "Confirm pause";
  if (action === "reactivate") return "Restore member access";
  return "Remove member";
}

function memberActionFailureTitle(action: MemberAction): string {
  if (action === "suspend") return "Could not pause member access";
  if (action === "reactivate") return "Could not restore member access";
  return "Could not remove member";
}

type PendingOrganizationRename = {
  ownerKey: string;
  name: string;
  expectedUpdatedAt: string;
  operationId: string;
};

type PendingWorkspaceRename = {
  name: string;
  expectedUpdatedAt: string;
  operationId: string;
};

type PendingWorkspaceAccess = {
  membershipId: string;
  role: WorkspaceMemberRole;
  permissions?: SdkPermission[];
  expectedUpdatedAt: string | null;
  operationId: string;
};

type PendingWorkspaceRevoke = {
  membershipId: string;
  expectedUpdatedAt: string;
  operationId: string;
};

export function OrganizationPrivateSessionsSection(props: {
  client: OpenGeniCoreClient;
  identity: OrganizationAdminIdentity;
  actorRole: OrganizationMembershipRole | null;
  managedSession: boolean;
}) {
  const identityKey = organizationAdminIdentityKey(props.identity);
  const identityRef = useRef<OrganizationAdminIdentity | null>(props.identity);
  identityRef.current = props.identity;
  const sequenceRef = useRef(new Map<OrganizationAdminOperationSlot, number>());
  const activeRef = useRef(new Map<OrganizationAdminOperationSlot, OrganizationAdminOperation>());
  const [state, setState] = useState<OwnedState<OrganizationPrivateSessionSettings | null>>({
    ownerKey: "",
    value: null,
    loading: false,
    error: null,
  });
  const [busy, setBusy] = useState(false);
  const [busyOwnerKey, setBusyOwnerKey] = useState("");
  const canAdminister = props.actorRole === "owner" || props.actorRole === "admin";

  const claim = useCallback(
    (lane: OrganizationAdminOperationLane) => {
      const slot = organizationAdminOperationSlot("private-sessions", lane);
      const operation = beginOrganizationAdminOperation({
        identity: props.identity,
        resource: "private-sessions",
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
    setState({ ownerKey: identityKey, value: null, loading: true, error: null });
    try {
      const value = await getOrganizationPrivateSessionSettings(
        props.client,
        props.identity.organizationId,
      );
      if (!owns(operation)) return;
      setState({ ownerKey: identityKey, value, loading: false, error: null });
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
  const settings = visible.value;
  const visibleBusy = busyOwnerKey === identityKey && busy;

  async function setEnabled(enabled: boolean) {
    if (!settings || visibleBusy) return;
    const operation = claim("mutation");
    setBusyOwnerKey(identityKey);
    setBusy(true);
    try {
      const value = await updateOrganizationPrivateSessionSettings(
        props.client,
        props.identity.organizationId,
        {
          enabled,
          expectedVersion: settings.version,
          operationId: crypto.randomUUID(),
        },
      );
      if (!owns(operation)) return;
      setState({ ownerKey: identityKey, value, loading: false, error: null });
      toast.success(enabled ? "Only me chats enabled" : "Only me chats disabled");
    } catch (error) {
      if (!owns(operation)) return;
      if (isOrganizationConflict(error)) await load();
      toast.error("Couldn't update Only me chats", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (owns(operation)) setBusy(false);
    }
  }

  if (!props.managedSession || !canAdminister) return null;
  return (
    <section className="grid gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <ShieldCheckIcon className="size-3.5 text-brand" />
            Only me chats
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-fg-muted">
            Let members with permission to start chats in a shared workspace create a session that
            only they can open. This setting does not affect Personal workspaces.
          </p>
        </div>
        {settings ? (
          <Button
            type="button"
            variant={settings.enabled ? "secondary" : "default"}
            size="sm"
            disabled={visibleBusy || (!settings.available && !settings.enabled)}
            onClick={() => void setEnabled(!settings.enabled)}
          >
            {visibleBusy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            {settings.enabled ? "Disable" : "Enable"}
          </Button>
        ) : null}
      </div>
      {visible.error ? (
        <LoadErrorState
          title="Couldn't load Only me chat settings"
          error={visible.error}
          onRetry={() => void load()}
        />
      ) : visible.loading || !settings ? (
        <p role="status" className="flex items-center gap-2 text-xs text-fg-muted">
          <Loader2Icon className="size-3.5 animate-spin" /> Loading Only me chat settings…
        </p>
      ) : !settings.available ? (
        <Notice tone="muted" title="Not available yet">
          This deployment has not completed the private-session readiness activation for this
          organization.
        </Notice>
      ) : (
        <p className="text-xs text-fg-subtle">
          {settings.enabled
            ? "Members who have permission to start chats in a workspace can choose Only me."
            : "Organization workspaces currently create workspace-visible chats only."}
        </p>
      )}
    </section>
  );
}

function organizationMemberLabel(member: OrganizationMember, currentSubjectId?: string): string {
  if (member.name?.trim()) {
    return member.subjectId === currentSubjectId
      ? `${member.name.trim()} (you)`
      : member.name.trim();
  }
  if (member.email) return member.email;
  if (member.subjectId === currentSubjectId) return "You";
  return maskedOrganizationSubject(member.subjectId);
}

export function OrganizationOverviewSection(props: {
  client: OpenGeniCoreClient;
  identity: OrganizationAdminIdentity;
  actorRole: OrganizationMembershipRole | null;
  managedSession: boolean;
  accessibleWorkspaceIds: ReadonlySet<string>;
  onOrganizationChanged: () => void | Promise<void>;
  onCreateWorkspace: (name: string, operationId: string) => Promise<void>;
}) {
  const identityKey = organizationAdminIdentityKey(props.identity);
  const identityRef = useRef<OrganizationAdminIdentity | null>(props.identity);
  identityRef.current = props.identity;
  const sequenceRef = useRef(new Map<OrganizationAdminOperationSlot, number>());
  const activeRef = useRef(new Map<OrganizationAdminOperationSlot, OrganizationAdminOperation>());
  const pendingRenameRef = useRef<PendingOrganizationRename | null>(null);
  const pendingCreateWorkspaceRef = useRef<{
    name: string;
    operationId: string;
  } | null>(null);
  const pendingWorkspaceRenameRef = useRef(new Map<string, PendingWorkspaceRename>());
  const pendingWorkspaceAccessRef = useRef(new Map<string, PendingWorkspaceAccess>());
  const pendingWorkspaceRevokeRef = useRef(new Map<string, PendingWorkspaceRevoke>());
  const [state, setState] = useState<OwnedState<OrganizationAdministrationOverview | null>>({
    ownerKey: "",
    value: null,
    loading: false,
    error: null,
  });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [organizationMembers, setOrganizationMembers] = useState<OrganizationMember[]>([]);
  const [workspaceAssignments, setWorkspaceAssignments] = useState<Record<string, string>>({});
  const [workspaceAssignmentAccess, setWorkspaceAssignmentAccess] = useState<
    Record<string, WorkspaceMemberRole>
  >({});
  const [workspaceAssignmentCustomPermissions, setWorkspaceAssignmentCustomPermissions] = useState<
    Record<string, SdkPermission[]>
  >({});
  const [workspaceMemberRoleDrafts, setWorkspaceMemberRoleDrafts] = useState<
    Record<string, WorkspaceMemberRole>
  >({});
  const [workspaceMemberCustomPermissions, setWorkspaceMemberCustomPermissions] = useState<
    Record<string, SdkPermission[]>
  >({});
  const [workspaceNameDrafts, setWorkspaceNameDrafts] = useState<Record<string, string>>({});
  const [accessBusyWorkspaceId, setAccessBusyWorkspaceId] = useState<string | null>(null);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [revokeWorkspaceAccess, setRevokeWorkspaceAccess] = useState<{
    workspace: OrganizationWorkspaceAccess;
    member: OrganizationWorkspaceAccessMember;
  } | null>(null);
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
    if (pendingRenameRef.current?.ownerKey !== identityKey) {
      pendingRenameRef.current = null;
    }
    pendingWorkspaceRenameRef.current.clear();
    pendingWorkspaceAccessRef.current.clear();
    pendingWorkspaceRevokeRef.current.clear();
    setRevokeWorkspaceAccess(null);
    return () => {
      identityRef.current = null;
      active.clear();
    };
  }, [identityKey, props.identity]);

  const load = useCallback(async () => {
    if (!props.managedSession || !canAdminister || !props.identity.organizationId) {
      setState({
        ownerKey: identityKey,
        value: null,
        loading: false,
        error: null,
      });
      return;
    }
    const operation = claim("read");
    setState((current) => ({
      ...current,
      ownerKey: identityKey,
      loading: true,
      error: null,
    }));
    try {
      const [overview, memberPage] = await Promise.all([
        props.client.getOrganizationAdministrationOverview(props.identity.organizationId),
        props.client.listOrganizationAdministrationMembers(props.identity.organizationId),
      ]);
      if (!owns(operation)) return;
      const pendingRename = pendingRenameRef.current;
      if (
        pendingRename?.ownerKey === identityKey &&
        overview.organization.name === pendingRename.name &&
        overview.organization.updatedAt !== pendingRename.expectedUpdatedAt
      ) {
        pendingRenameRef.current = null;
      }
      setName(overview.organization.name);
      setWorkspaceNameDrafts(
        Object.fromEntries(overview.workspaces.map((workspace) => [workspace.id, workspace.name])),
      );
      setWorkspaceMemberRoleDrafts(
        Object.fromEntries(
          overview.workspaces.flatMap((workspace) =>
            workspace.members.map((member) => [
              `${workspace.id}:${member.membershipId}`,
              member.role,
            ]),
          ),
        ),
      );
      setWorkspaceMemberCustomPermissions(
        Object.fromEntries(
          overview.workspaces.flatMap((workspace) =>
            workspace.members.map((member) => [
              `${workspace.id}:${member.membershipId}`,
              member.permissions.filter((permission): permission is SdkPermission =>
                workspaceMemberPermissionGroups().some((group) =>
                  group.permissions.some((candidate) => candidate === permission),
                ),
              ),
            ]),
          ),
        ),
      );
      setOrganizationMembers(memberPage.members.filter((member) => member.status === "active"));
      setState({
        ownerKey: identityKey,
        value: overview,
        loading: false,
        error: null,
      });
    } catch (error) {
      if (!owns(operation)) return;
      setState({
        ownerKey: identityKey,
        value: null,
        loading: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      setOrganizationMembers([]);
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

  async function addWorkspaceAccess(workspaceId: string) {
    const membershipId = workspaceAssignments[workspaceId];
    const member = organizationMembers.find((candidate) => candidate.id === membershipId);
    if (!member) return;
    const role = workspaceAssignmentAccess[workspaceId] ?? "member";
    const permissions =
      role === "custom" ? (workspaceAssignmentCustomPermissions[workspaceId] ?? []) : undefined;
    if (role === "custom" && (!permissions || permissions.length === 0)) return;
    const pending = pendingWorkspaceAccessRef.current.get(workspaceId);
    const attempt =
      pending?.membershipId === member.id &&
      pending.role === role &&
      pending.expectedUpdatedAt === null &&
      JSON.stringify(pending.permissions ?? []) === JSON.stringify(permissions ?? [])
        ? pending
        : {
            membershipId: member.id,
            role,
            ...(permissions ? { permissions } : {}),
            expectedUpdatedAt: null,
            operationId: crypto.randomUUID(),
          };
    pendingWorkspaceAccessRef.current.set(workspaceId, attempt);
    setAccessBusyWorkspaceId(workspaceId);
    try {
      await props.client.putOrganizationWorkspaceMember(
        props.identity.organizationId,
        workspaceId,
        member.id,
        attempt.role === "custom"
          ? {
              role: "custom",
              permissions: attempt.permissions ?? [],
              expectedUpdatedAt: attempt.expectedUpdatedAt,
              operationId: attempt.operationId,
            }
          : {
              role: attempt.role,
              expectedUpdatedAt: attempt.expectedUpdatedAt,
              operationId: attempt.operationId,
            },
      );
      pendingWorkspaceAccessRef.current.delete(workspaceId);
      setWorkspaceAssignments((current) => ({ ...current, [workspaceId]: "" }));
      setWorkspaceAssignmentAccess((current) => ({
        ...current,
        [workspaceId]: "member",
      }));
      setWorkspaceAssignmentCustomPermissions((current) => ({
        ...current,
        [workspaceId]: [],
      }));
      toast.success(`${organizationMemberLabel(member)} can now access this workspace`);
      await load();
    } catch (error) {
      const outcomeUnknown =
        typeof error === "object" &&
        error !== null &&
        (error as { outcomeUnknown?: unknown }).outcomeUnknown === true;
      if (!outcomeUnknown) pendingWorkspaceAccessRef.current.delete(workspaceId);
      if (isOrganizationConflict(error)) await load();
      toast.error("Couldn't add workspace access", {
        description: outcomeUnknown
          ? "The result is not known yet. Retry to safely reconcile the same request."
          : error instanceof Error
            ? error.message
            : String(error),
      });
    } finally {
      setAccessBusyWorkspaceId(null);
    }
  }

  async function updateWorkspaceAccess(
    workspace: OrganizationWorkspaceAccess,
    member: OrganizationWorkspaceAccessMember,
    role: WorkspaceMemberRole,
    permissions?: SdkPermission[],
  ) {
    if (!member.organizationMembershipId || (role === "custom" && !permissions?.length)) return;
    const key = `${workspace.id}:${member.organizationMembershipId}`;
    const pending = pendingWorkspaceAccessRef.current.get(key);
    const attempt =
      pending?.membershipId === member.organizationMembershipId &&
      pending.role === role &&
      pending.expectedUpdatedAt === member.updatedAt &&
      JSON.stringify(pending.permissions ?? []) === JSON.stringify(permissions ?? [])
        ? pending
        : {
            membershipId: member.organizationMembershipId,
            role,
            ...(permissions ? { permissions } : {}),
            expectedUpdatedAt: member.updatedAt,
            operationId: crypto.randomUUID(),
          };
    pendingWorkspaceAccessRef.current.set(key, attempt);
    setAccessBusyWorkspaceId(workspace.id);
    try {
      await props.client.putOrganizationWorkspaceMember(
        props.identity.organizationId,
        workspace.id,
        member.organizationMembershipId,
        attempt.role === "custom"
          ? {
              role: "custom",
              permissions: attempt.permissions ?? [],
              expectedUpdatedAt: attempt.expectedUpdatedAt,
              operationId: attempt.operationId,
            }
          : {
              role: attempt.role,
              expectedUpdatedAt: attempt.expectedUpdatedAt,
              operationId: attempt.operationId,
            },
      );
      pendingWorkspaceAccessRef.current.delete(key);
      toast.success(role === "custom" ? "Custom workspace access saved" : "Workspace role saved");
      await load();
    } catch (error) {
      const outcomeUnknown =
        typeof error === "object" &&
        error !== null &&
        (error as { outcomeUnknown?: unknown }).outcomeUnknown === true;
      if (!outcomeUnknown) pendingWorkspaceAccessRef.current.delete(key);
      if (isOrganizationConflict(error)) await load();
      toast.error("Couldn't update workspace access", {
        description: outcomeUnknown
          ? "The result is not known yet. Retry to safely reconcile the same request."
          : error instanceof Error
            ? error.message
            : String(error),
      });
    } finally {
      setAccessBusyWorkspaceId(null);
    }
  }

  async function removeWorkspaceAccess(): Promise<boolean> {
    const confirmation = revokeWorkspaceAccess;
    if (!confirmation?.member.organizationMembershipId) return false;
    const key = `${confirmation.workspace.id}:${confirmation.member.organizationMembershipId}`;
    const pending = pendingWorkspaceRevokeRef.current.get(key);
    const attempt =
      pending?.membershipId === confirmation.member.organizationMembershipId &&
      pending.expectedUpdatedAt === confirmation.member.updatedAt
        ? pending
        : {
            membershipId: confirmation.member.organizationMembershipId,
            expectedUpdatedAt: confirmation.member.updatedAt,
            operationId: crypto.randomUUID(),
          };
    pendingWorkspaceRevokeRef.current.set(key, attempt);
    setAccessBusyWorkspaceId(confirmation.workspace.id);
    try {
      await props.client.revokeOrganizationWorkspaceMember(
        props.identity.organizationId,
        confirmation.workspace.id,
        confirmation.member.organizationMembershipId,
        {
          expectedUpdatedAt: attempt.expectedUpdatedAt,
          operationId: attempt.operationId,
        },
      );
      pendingWorkspaceRevokeRef.current.delete(key);
      toast.success("Workspace access removed");
      await load();
      return true;
    } catch (error) {
      const outcomeUnknown =
        typeof error === "object" &&
        error !== null &&
        (error as { outcomeUnknown?: unknown }).outcomeUnknown === true;
      if (!outcomeUnknown) pendingWorkspaceRevokeRef.current.delete(key);
      if (isOrganizationConflict(error)) await load();
      toast.error("Couldn't remove workspace access", {
        description: outcomeUnknown
          ? "The result is not known yet. Retry to safely reconcile the same request."
          : error instanceof Error
            ? error.message
            : String(error),
      });
      return false;
    } finally {
      setAccessBusyWorkspaceId(null);
    }
  }

  async function saveWorkspaceName(workspace: OrganizationWorkspaceAccess) {
    const requestedName = workspaceNameDrafts[workspace.id]?.trim();
    if (!requestedName || requestedName === workspace.name) return;
    const pending = pendingWorkspaceRenameRef.current.get(workspace.id);
    const attempt =
      pending?.name === requestedName && pending.expectedUpdatedAt === workspace.updatedAt
        ? pending
        : {
            name: requestedName,
            expectedUpdatedAt: workspace.updatedAt,
            operationId: crypto.randomUUID(),
          };
    pendingWorkspaceRenameRef.current.set(workspace.id, attempt);
    setAccessBusyWorkspaceId(workspace.id);
    try {
      await props.client.updateOrganizationWorkspace(
        props.identity.organizationId,
        workspace.id,
        attempt,
      );
      pendingWorkspaceRenameRef.current.delete(workspace.id);
      toast.success("Workspace name updated");
      await load();
    } catch (error) {
      const outcomeUnknown =
        typeof error === "object" &&
        error !== null &&
        (error as { outcomeUnknown?: unknown }).outcomeUnknown === true;
      if (!outcomeUnknown) pendingWorkspaceRenameRef.current.delete(workspace.id);
      if (isOrganizationConflict(error)) await load();
      toast.error("Couldn't update workspace name", {
        description: outcomeUnknown
          ? "The result is not known yet. Retry to safely reconcile the same request."
          : error instanceof Error
            ? error.message
            : String(error),
      });
    } finally {
      setAccessBusyWorkspaceId(null);
    }
  }

  async function createWorkspace() {
    const requestedName = newWorkspaceName.trim();
    if (!requestedName) return;
    const currentAttempt = pendingCreateWorkspaceRef.current;
    const attempt =
      currentAttempt?.name === requestedName
        ? currentAttempt
        : { name: requestedName, operationId: crypto.randomUUID() };
    pendingCreateWorkspaceRef.current = attempt;
    setCreatingWorkspace(true);
    try {
      await props.onCreateWorkspace(attempt.name, attempt.operationId);
      pendingCreateWorkspaceRef.current = null;
      setNewWorkspaceName("");
      toast.success(`${requestedName} created`);
      await load();
    } catch (error) {
      const outcomeUnknown =
        typeof error === "object" &&
        error !== null &&
        (error as { outcomeUnknown?: unknown }).outcomeUnknown === true;
      if (!outcomeUnknown) pendingCreateWorkspaceRef.current = null;
      toast.error("Couldn't create workspace", {
        description: outcomeUnknown
          ? "The result is not known yet. Retry to safely reconcile the same request."
          : error instanceof Error
            ? error.message
            : String(error),
      });
    } finally {
      setCreatingWorkspace(false);
    }
  }

  async function saveName() {
    const requestedName = name.trim();
    if (!overview || !requestedName || requestedName === overview.organization.name) {
      setEditing(false);
      return;
    }
    const existingAttempt = pendingRenameRef.current;
    const attempt: PendingOrganizationRename =
      existingAttempt?.ownerKey === identityKey &&
      existingAttempt.name === requestedName &&
      existingAttempt.expectedUpdatedAt === overview.organization.updatedAt
        ? existingAttempt
        : {
            ownerKey: identityKey,
            name: requestedName,
            expectedUpdatedAt: overview.organization.updatedAt,
            operationId: crypto.randomUUID(),
          };
    pendingRenameRef.current = attempt;
    const operation = claim("mutation");
    setBusy(true);
    try {
      const organization = await props.client.updateOrganizationName(
        props.identity.organizationId,
        {
          name: attempt.name,
          expectedUpdatedAt: attempt.expectedUpdatedAt,
          operationId: attempt.operationId,
        },
      );
      if (!owns(operation)) return;
      if (pendingRenameRef.current?.operationId === attempt.operationId) {
        pendingRenameRef.current = null;
      }
      setState((current) =>
        current.ownerKey === identityKey && current.value
          ? { ...current, value: { ...current.value, organization } }
          : current,
      );
      setEditing(false);
      toast.success("Organization name updated");
      try {
        await props.onOrganizationChanged();
      } catch (error) {
        if (!owns(operation)) return;
        toast.error("Organization name updated, but the account menu couldn't refresh", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      if (!owns(operation)) return;
      const outcomeUnknown =
        typeof error === "object" &&
        error !== null &&
        (error as { outcomeUnknown?: unknown }).outcomeUnknown === true;
      if (!outcomeUnknown && pendingRenameRef.current?.operationId === attempt.operationId) {
        pendingRenameRef.current = null;
      }
      toast.error("Couldn't update organization name", {
        description: outcomeUnknown
          ? "The result is not yet known. Retry Save to reconcile the same request safely."
          : error instanceof Error
            ? error.message
            : String(error),
      });
    } finally {
      if (owns(operation)) setBusy(false);
    }
  }

  if (!props.managedSession) {
    return (
      <Notice tone="muted" title="Organization overview unavailable">
        A managed user session is required.
      </Notice>
    );
  }
  if (!canAdminister) {
    return (
      <Notice tone="muted" title="Organization administration unavailable">
        Your current organization role does not allow you to change this organization.
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
    <div className="grid min-w-0 gap-4">
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
          <Metric
            label="Your role"
            value={props.actorRole ? ORGANIZATION_ROLE_LABELS[props.actorRole] : "Unknown"}
          />
        </div>
      </section>

      <section className="grid gap-3 rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">Workspaces &amp; access</h2>
            <p className="mt-1 text-xs text-fg-muted">
              Create shared workspaces, then choose which organization members can use each one.
              Personal workspaces stay private.
            </p>
          </div>
          <form
            className="flex w-full min-w-0 gap-2 sm:w-auto"
            onSubmit={(event) => {
              event.preventDefault();
              void createWorkspace();
            }}
          >
            <Input
              aria-label="New workspace name"
              placeholder="New workspace name"
              value={newWorkspaceName}
              onChange={(event) => setNewWorkspaceName(event.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              disabled={!newWorkspaceName.trim() || creatingWorkspace}
            >
              {creatingWorkspace ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              Create workspace
            </Button>
          </form>
        </div>
        {overview.workspaces.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-4 text-sm text-fg-muted">
            No shared workspaces yet.
          </p>
        ) : (
          <div className="grid gap-2">
            {overview.workspaces.map((workspace) => {
              const workspaceSubjectIds = new Set(
                workspace.members.map((member) => member.subjectId),
              );
              const assignableMembers = organizationMembers.filter(
                (member) => !workspaceSubjectIds.has(member.subjectId),
              );
              return (
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
                  <div className="grid gap-3 border-t border-border/70 px-3 py-3">
                    <form
                      className="flex flex-wrap items-end gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveWorkspaceName(workspace);
                      }}
                    >
                      <label className="grid min-w-56 flex-1 gap-1 text-xs text-fg-muted">
                        Workspace name
                        <Input
                          aria-label={`Workspace name for ${workspace.name}`}
                          value={workspaceNameDrafts[workspace.id] ?? workspace.name}
                          disabled={accessBusyWorkspaceId === workspace.id}
                          onChange={(event) =>
                            setWorkspaceNameDrafts((current) => ({
                              ...current,
                              [workspace.id]: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <Button
                        type="submit"
                        size="sm"
                        variant="secondary"
                        disabled={
                          accessBusyWorkspaceId === workspace.id ||
                          !(workspaceNameDrafts[workspace.id] ?? "").trim() ||
                          (workspaceNameDrafts[workspace.id] ?? "").trim() === workspace.name
                        }
                      >
                        Save name
                      </Button>
                    </form>
                    {assignableMembers.length > 0 ? (
                      <div className="flex flex-wrap items-end gap-2 rounded-md border border-border/70 bg-surface/60 p-2">
                        <label className="grid min-w-56 flex-1 gap-1 text-xs text-fg-muted">
                          Add organization member
                          <Select
                            className="min-w-56"
                            value={workspaceAssignments[workspace.id] ?? ""}
                            disabled={accessBusyWorkspaceId === workspace.id}
                            onChange={(event) =>
                              setWorkspaceAssignments((current) => ({
                                ...current,
                                [workspace.id]: event.target.value,
                              }))
                            }
                          >
                            <option value="">Choose a person…</option>
                            {assignableMembers.map((member) => (
                              <option key={member.id} value={member.id}>
                                {organizationMemberLabel(member, props.identity.subjectId)}
                              </option>
                            ))}
                          </Select>
                        </label>
                        <label className="grid min-w-52 gap-1 text-xs text-fg-muted">
                          Workspace access
                          <Select
                            aria-label={`Workspace access for new member in ${workspace.name}`}
                            value={workspaceAssignmentAccess[workspace.id] ?? "member"}
                            disabled={accessBusyWorkspaceId === workspace.id}
                            onChange={(event) =>
                              setWorkspaceAssignmentAccess((current) => ({
                                ...current,
                                [workspace.id]: event.target.value as WorkspaceMemberRole,
                              }))
                            }
                          >
                            {overview.roles.map((role) => (
                              <option key={role.role} value={role.role}>
                                {role.label}
                              </option>
                            ))}
                            <option value="custom">Custom permissions…</option>
                          </Select>
                        </label>
                        <Button
                          type="button"
                          size="sm"
                          disabled={
                            accessBusyWorkspaceId === workspace.id ||
                            !(workspaceAssignments[workspace.id] ?? "") ||
                            (workspaceAssignmentAccess[workspace.id] === "custom" &&
                              (workspaceAssignmentCustomPermissions[workspace.id]?.length ?? 0) ===
                                0)
                          }
                          onClick={() => void addWorkspaceAccess(workspace.id)}
                        >
                          {accessBusyWorkspaceId === workspace.id ? (
                            <Loader2Icon className="size-3.5 animate-spin" />
                          ) : null}
                          Add access
                        </Button>
                        {workspaceAssignmentAccess[workspace.id] === "custom" ? (
                          <details open className="w-full rounded-md border border-border/70 p-3">
                            <summary className="cursor-pointer text-xs font-medium">
                              Advanced custom permissions
                            </summary>
                            <p className="my-2 text-xs text-fg-muted">
                              Use named roles for normal access. This advanced path preserves exact
                              raw permissions for integrations and legacy grants.
                            </p>
                            <PermissionGroupPicker
                              groups={workspaceMemberPermissionGroups()}
                              selected={
                                new Set(workspaceAssignmentCustomPermissions[workspace.id] ?? [])
                              }
                              disabled={accessBusyWorkspaceId === workspace.id}
                              onToggle={(permission) =>
                                setWorkspaceAssignmentCustomPermissions((current) => {
                                  const selected = new Set(current[workspace.id] ?? []);
                                  if (selected.has(permission as SdkPermission)) {
                                    selected.delete(permission as SdkPermission);
                                  } else {
                                    selected.add(permission as SdkPermission);
                                  }
                                  return {
                                    ...current,
                                    [workspace.id]: [...selected],
                                  };
                                })
                              }
                            />
                          </details>
                        ) : null}
                      </div>
                    ) : null}
                    {workspace.members.length === 0 ? (
                      <p className="py-2 text-xs text-fg-subtle">No direct workspace access.</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="min-w-full text-left text-xs">
                          <thead className="text-fg-subtle">
                            <tr>
                              <th className="py-1 pr-4 font-medium">Person or service</th>
                              <th className="py-1 pr-4 font-medium">Workspace access</th>
                              <th className="py-1 font-medium">Details</th>
                              <th className="py-1 text-right font-medium">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {workspace.members.map((member) => {
                              const memberKey = `${workspace.id}:${member.membershipId}`;
                              const roleDraft = workspaceMemberRoleDrafts[memberKey] ?? member.role;
                              const customPermissions =
                                workspaceMemberCustomPermissions[memberKey] ?? [];
                              return (
                                <tr key={member.membershipId} className="border-t border-border/50">
                                  <td className="py-2 pr-4">
                                    <span className="font-medium">
                                      {member.name ??
                                        member.email ??
                                        member.subjectLabel ??
                                        maskedOrganizationSubject(member.subjectId)}
                                    </span>
                                    <span className="ml-2 text-2xs capitalize text-fg-subtle">
                                      {member.principalKind}
                                    </span>
                                  </td>
                                  <td className="py-2 pr-4">
                                    {member.principalKind === "human" ? (
                                      <Select
                                        aria-label={`Workspace access for ${
                                          member.subjectLabel ??
                                          maskedOrganizationSubject(member.subjectId)
                                        }`}
                                        className="min-w-48"
                                        value={roleDraft}
                                        disabled={
                                          accessBusyWorkspaceId === workspace.id ||
                                          !member.organizationMembershipId
                                        }
                                        onChange={(event) => {
                                          const role = event.target.value as WorkspaceMemberRole;
                                          setWorkspaceMemberRoleDrafts((current) => ({
                                            ...current,
                                            [memberKey]: role,
                                          }));
                                          if (role !== "custom") {
                                            void updateWorkspaceAccess(workspace, member, role);
                                          }
                                        }}
                                      >
                                        {overview.roles.map((role) => (
                                          <option key={role.role} value={role.role}>
                                            {role.label}
                                          </option>
                                        ))}
                                        <option value="custom">Custom permissions…</option>
                                      </Select>
                                    ) : (
                                      <span className="capitalize text-fg-muted">
                                        {member.role}
                                      </span>
                                    )}
                                  </td>
                                  <td className="py-2 text-fg-muted">
                                    {roleDraft === "custom" ? (
                                      <details open={member.role === "custom"} className="min-w-64">
                                        <summary className="cursor-pointer">
                                          {customPermissions.length} custom permissions
                                        </summary>
                                        <div className="mt-2 grid gap-2 rounded-md border border-border/70 p-2">
                                          <PermissionGroupPicker
                                            groups={workspaceMemberPermissionGroups()}
                                            selected={new Set(customPermissions)}
                                            disabled={accessBusyWorkspaceId === workspace.id}
                                            onToggle={(permission) =>
                                              setWorkspaceMemberCustomPermissions((current) => {
                                                const selected = new Set(current[memberKey] ?? []);
                                                if (selected.has(permission as SdkPermission)) {
                                                  selected.delete(permission as SdkPermission);
                                                } else {
                                                  selected.add(permission as SdkPermission);
                                                }
                                                return { ...current, [memberKey]: [...selected] };
                                              })
                                            }
                                          />
                                          <Button
                                            type="button"
                                            size="sm"
                                            disabled={
                                              accessBusyWorkspaceId === workspace.id ||
                                              customPermissions.length === 0 ||
                                              !member.organizationMembershipId
                                            }
                                            onClick={() =>
                                              void updateWorkspaceAccess(
                                                workspace,
                                                member,
                                                "custom",
                                                customPermissions,
                                              )
                                            }
                                          >
                                            Save custom permissions
                                          </Button>
                                        </div>
                                      </details>
                                    ) : (
                                      (overview.roles.find((role) => role.role === roleDraft)
                                        ?.description ?? "Named workspace role")
                                    )}
                                  </td>
                                  <td className="py-2 text-right">
                                    {member.subjectId !== props.identity.subjectId &&
                                    member.principalKind === "human" &&
                                    member.organizationMembershipId ? (
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        disabled={accessBusyWorkspaceId === workspace.id}
                                        onClick={() =>
                                          setRevokeWorkspaceAccess({ workspace, member })
                                        }
                                      >
                                        Remove access
                                      </Button>
                                    ) : null}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </section>
      <ConfirmDialog
        open={revokeWorkspaceAccess !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeWorkspaceAccess(null);
        }}
        title={
          revokeWorkspaceAccess
            ? `Remove access to ${revokeWorkspaceAccess.workspace.name}?`
            : "Remove workspace access?"
        }
        description="Access stops immediately. Active sessions and unfinished work in this workspace are fenced, and Personal workspace access is unchanged."
        confirmLabel="Remove workspace access"
        cancelAutoFocus
        onConfirm={removeWorkspaceAccess}
      />
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
    OwnedState<{
      invitations: OrganizationInvitation[];
      nextCursor: string | null;
    }>
  >({
    ownerKey: "",
    value: { invitations: [], nextCursor: null },
    loading: false,
    error: null,
  });
  const [incomingState, setIncomingState] = useState<
    OwnedState<{
      invitations: OrganizationInvitation[];
      nextCursor: string | null;
    }>
  >({
    ownerKey: "",
    value: { invitations: [], nextCursor: null },
    loading: false,
    error: null,
  });
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<OrganizationMembershipRole>("member");
  const [inviteWorkspaces, setInviteWorkspaces] = useState<OrganizationWorkspaceAccess[]>([]);
  const [inviteWorkspaceIds, setInviteWorkspaceIds] = useState<string[]>([]);
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
      setMembersState({
        ownerKey: identityKey,
        value: [],
        loading: false,
        error: null,
      });
      setInviteWorkspaces([]);
      setInviteWorkspaceIds([]);
      return;
    }
    const operation = claim("members", "read");
    setMembersState({
      ownerKey: identityKey,
      value: [],
      loading: true,
      error: null,
    });
    try {
      const [membersOutcome, overviewOutcome] = await Promise.allSettled([
        Promise.resolve().then(() =>
          props.client.listOrganizationAdministrationMembers(props.identity.organizationId),
        ),
        Promise.resolve().then(() =>
          props.client.getOrganizationAdministrationOverview(props.identity.organizationId),
        ),
      ]);
      if (!owns(operation)) return;
      if (membersOutcome.status === "rejected") throw membersOutcome.reason;
      const response = membersOutcome.value;
      setRoleDrafts(Object.fromEntries(response.members.map((member) => [member.id, member.role])));
      const nextInviteWorkspaces =
        overviewOutcome.status === "fulfilled" ? overviewOutcome.value.workspaces : [];
      setInviteWorkspaces(nextInviteWorkspaces);
      setInviteWorkspaceIds((current) =>
        current.filter((workspaceId) =>
          nextInviteWorkspaces.some((workspace) => workspace.id === workspaceId),
        ),
      );
      setMembersState({
        ownerKey: identityKey,
        value: response.members,
        loading: false,
        error: null,
      });
    } catch (error) {
      if (!owns(operation)) return;
      setInviteWorkspaces([]);
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
    const name = inviteName.trim();
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
          ...(name ? { name } : {}),
          role: inviteRole,
          initialWorkspaceIds: inviteWorkspaceIds,
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
      setInviteName("");
      setInviteWorkspaceIds([]);
      setLiveOutcome(invitationDeliveryOutcome(invitation));
      toast.success(
        invitation.delivery?.state === "sent"
          ? "Invitation sent"
          : "Organization invitation recorded",
      );
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

  async function retryInvitationDelivery(invitation: OrganizationInvitation) {
    if (visibleBusyResource || adminInvites.loading || invitation.status !== "pending") return;
    const operation = claim("admin-invitations", "mutation");
    setBusyOwnerKey(identityKey);
    setBusyResource("admin-invitations");
    try {
      const delivery = await retryOrganizationUserSetupDelivery(
        props.client,
        props.identity.organizationId,
        invitation.id,
        { operationId: crypto.randomUUID() },
      );
      if (!owns(operation)) return;
      setAdminInvitesState((current) => ({
        ...current,
        ownerKey: identityKey,
        value: {
          ...current.value,
          invitations: current.value.invitations.map((candidate) =>
            candidate.id === invitation.id ? { ...candidate, delivery } : candidate,
          ),
        },
      }));
      const updated = { ...invitation, delivery };
      setLiveOutcome(invitationDeliveryOutcome(updated));
      if (delivery.state === "sent") toast.success("Invitation sent");
      else toast.error("Invitation delivery still needs attention");
    } catch (error) {
      if (!owns(operation)) return;
      toast.error(isOrganizationConflict(error) ? "Invitation state changed" : "Retry failed", {
        description: isOrganizationConflict(error)
          ? "Refresh the invitation list before trying again."
          : error instanceof Error
            ? error.message
            : String(error),
      });
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
        {
          expectedRevision: invitation.revision,
          operationId: crypto.randomUUID(),
        },
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
          candidate.id === updated.id ? { ...candidate, ...updated } : candidate,
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
          candidate.id === updated.id ? { ...candidate, ...updated } : candidate,
        ),
      }));
      setLiveOutcome(
        `${maskedOrganizationSubject(updated.subjectId)}: ${
          action === "offboard"
            ? "removed from the organization"
            : action === "suspend"
              ? "access paused"
              : "access restored"
        }.`,
      );
      toast.success(
        action === "offboard"
          ? "Member removed from the organization"
          : action === "suspend"
            ? "Member access paused"
            : "Member access restored",
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
        isOrganizationConflict(error)
          ? "Membership state changed"
          : memberActionFailureTitle(action),
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
    <div className="grid min-w-0 gap-5 [&>section>*]:min-w-0 [&>section]:min-w-0">
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
              Invite your team, choose their organization role, and manage who can access each
              shared workspace.
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
              const label = organizationMemberLabel(member, props.identity.subjectId);
              const roleDraft = roleDrafts[member.id] ?? member.role;
              const soleActiveOwner =
                member.role === "owner" && member.status === "active" && activeOwnerCount <= 1;
              const soleOwnerReasonId = `sole-owner-reason-${member.id}`;
              return (
                <article
                  key={member.id}
                  className="grid gap-3 rounded-lg border border-border bg-bg/35 p-3 sm:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-medium">{label}</h3>
                    {member.email && member.email !== label ? (
                      <p className="mt-0.5 truncate text-xs text-fg-subtle">{member.email}</p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <span className="rounded-full border border-border px-2 py-0.5 text-xs">
                        {ORGANIZATION_ROLE_LABELS[member.role]}
                      </span>
                      <span className="rounded-full border border-border px-2 py-0.5 text-xs text-fg-muted">
                        {organizationMemberStatusLabel(member.status)}
                      </span>
                    </div>
                    {member.sharedWorkspaceAccess.length > 0 ? (
                      <p className="mt-2 text-xs text-fg-subtle">
                        Shared access:{" "}
                        {member.sharedWorkspaceAccess
                          .map((access) => `${access.workspaceName} (${access.role})`)
                          .join(", ")}
                      </p>
                    ) : (
                      <p className="mt-2 text-xs text-fg-subtle">No shared workspace access</p>
                    )}
                  </div>
                  <div className="grid min-w-48 content-start gap-2 sm:justify-items-end">
                    {soleActiveOwner ? (
                      <label className="grid w-full gap-1 text-xs text-fg-muted sm:w-48">
                        Organization role
                        <Select
                          aria-label={`Organization role for ${label}`}
                          aria-describedby={soleOwnerReasonId}
                          value={member.role}
                          disabled
                        >
                          <option value={member.role}>
                            {ORGANIZATION_ROLE_LABELS[member.role]}
                          </option>
                        </Select>
                      </label>
                    ) : capability.canChangeRole ? (
                      <label className="grid w-full gap-1 text-xs text-fg-muted sm:w-48">
                        Organization role
                        <Select
                          aria-label={`Organization role for ${label}`}
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
                              {ORGANIZATION_ROLE_LABELS[role]}
                            </option>
                          ))}
                        </Select>
                      </label>
                    ) : null}
                    <div className="flex w-full flex-wrap justify-end gap-2">
                      {capability.canChangeRole && roleDraft !== member.role ? (
                        <Button
                          type="button"
                          size="sm"
                          disabled={visibleBusyResource === "members"}
                          onClick={() => void changeRole(member)}
                        >
                          Save role
                        </Button>
                      ) : null}
                      {capability.canSuspend ? (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          aria-label={`Pause access for ${label}`}
                          disabled={visibleBusyResource === "members"}
                          onClick={(event) => {
                            actionTriggerRef.current = event.currentTarget;
                            setMemberConfirmation({
                              member,
                              action: "suspend",
                            });
                          }}
                        >
                          Pause access
                        </Button>
                      ) : null}
                      {capability.canReactivate ? (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          aria-label={`Restore access for ${label}`}
                          disabled={visibleBusyResource === "members"}
                          onClick={(event) => {
                            actionTriggerRef.current = event.currentTarget;
                            setMemberConfirmation({
                              member,
                              action: "reactivate",
                            });
                          }}
                        >
                          Restore access
                        </Button>
                      ) : null}
                      {capability.canOffboard ? (
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          aria-label={`Remove ${label} from the organization`}
                          disabled={visibleBusyResource === "members"}
                          onClick={(event) => {
                            actionTriggerRef.current = event.currentTarget;
                            setMemberConfirmation({
                              member,
                              action: "offboard",
                            });
                          }}
                        >
                          <UserMinusIcon className="size-3.5" />
                          Remove
                        </Button>
                      ) : null}
                      {soleActiveOwner ? (
                        <>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled
                            aria-describedby={soleOwnerReasonId}
                          >
                            Pause access
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled
                            aria-describedby={soleOwnerReasonId}
                          >
                            <UserMinusIcon className="size-3.5" />
                            Remove
                          </Button>
                        </>
                      ) : null}
                    </div>
                    {soleActiveOwner ? (
                      <p id={soleOwnerReasonId} className="max-w-60 text-xs text-fg-subtle">
                        Assign another active owner before changing, pausing, or removing the sole
                        owner.
                      </p>
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
              Invite someone by email with an organization role and explicit shared workspace
              access. OpenGeni records every delivery attempt and invitations expire after seven
              days.
            </p>
          </div>
          <fieldset
            disabled={visibleBusyResource === "admin-invitations" || adminInvites.loading}
            className="grid gap-2 sm:grid-cols-2"
          >
            <legend className="sr-only">Invite someone to the organization</legend>
            <div className="grid gap-1">
              <Label htmlFor="organization-invite-email">Email address</Label>
              <Input
                id="organization-invite-email"
                type="email"
                autoComplete="email"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="organization-invite-name">Name</Label>
              <Input
                id="organization-invite-name"
                autoComplete="name"
                value={inviteName}
                onChange={(event) => setInviteName(event.target.value)}
                placeholder="Optional"
              />
            </div>
            <label className="grid min-w-44 gap-1 text-sm">
              Organization role
              <Select
                value={inviteRole}
                onChange={(event) =>
                  setInviteRole(event.target.value as OrganizationMembershipRole)
                }
              >
                {(["owner", "admin", "member"] as const)
                  .filter((role) => canInviteOrganizationRole(props.actorRole, role))
                  .map((role) => (
                    <option key={role} value={role}>
                      {ORGANIZATION_ROLE_LABELS[role]}
                    </option>
                  ))}
              </Select>
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
              Invite
            </Button>
            <div className="grid gap-2 sm:col-span-2">
              <span className="text-sm">Initial shared workspace access</span>
              {inviteWorkspaces.length === 0 ? (
                <p className="text-xs text-fg-muted">
                  No shared workspaces are available. The invite creates organization membership
                  only.
                </p>
              ) : (
                <div className="grid gap-2 rounded-md border border-border/70 p-3 sm:grid-cols-2">
                  {inviteWorkspaces.map((workspace) => (
                    <label key={workspace.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={inviteWorkspaceIds.includes(workspace.id)}
                        onChange={(event) =>
                          setInviteWorkspaceIds((current) =>
                            event.target.checked
                              ? [...new Set([...current, workspace.id])]
                              : current.filter((workspaceId) => workspaceId !== workspace.id),
                          )
                        }
                      />
                      <span>{workspace.name}</span>
                    </label>
                  ))}
                </div>
              )}
              <p className="text-xs text-fg-subtle">
                Selected access is granted when the invitation is accepted. Personal workspaces are
                never listed here.
              </p>
            </div>
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
          ) : adminInvites.value.invitations.length === 0 ? (
            <p className="text-xs text-fg-muted">
              No organization invitations yet. Invite someone above when you are ready.
            </p>
          ) : (
            <div className="grid gap-2">
              {adminInvites.value.invitations.map((invite) => (
                <div
                  key={invite.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs"
                >
                  <div>
                    <span className="font-medium">
                      {invite.targetName ? `${invite.targetName} · ` : ""}
                      {invite.targetEmail}
                    </span>
                    <span className="ml-2 text-fg-muted">
                      {ORGANIZATION_ROLE_LABELS[invite.role]} · {invite.status}
                    </span>
                    <div className="mt-0.5 text-fg-subtle">
                      Expires {formatTimestamp(invite.expiresAt)}
                    </div>
                    <div className="mt-0.5 text-fg-subtle">
                      Shared access:{" "}
                      {invite.initialWorkspaceIds.length === 0
                        ? "none"
                        : invite.initialWorkspaceIds
                            .map(
                              (workspaceId) =>
                                inviteWorkspaces.find((workspace) => workspace.id === workspaceId)
                                  ?.name ?? "Unavailable workspace",
                            )
                            .join(", ")}
                    </div>
                    <InvitationDeliveryStatus invitation={invite} />
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    {invite.status === "pending" &&
                    (!invite.delivery || invite.delivery.retryState === "available") ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        aria-label={`${invite.delivery ? "Retry delivery" : "Send invitation"} to ${invite.targetEmail}`}
                        disabled={visibleBusyResource !== null || adminInvites.loading}
                        onClick={() => void retryInvitationDelivery(invite)}
                      >
                        <RefreshCwIcon className="size-3.5" />
                        {invite.delivery ? "Retry delivery" : "Send invitation"}
                      </Button>
                    ) : null}
                    {invite.status === "pending" &&
                    canRevokeOrganizationInvitation(props.actorRole, invite.role) ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="max-w-full whitespace-normal text-right"
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
                  <span className="ml-2 text-fg-muted">
                    {ORGANIZATION_ROLE_LABELS[invite.role]}
                  </span>
                  <div className="mt-0.5 text-fg-subtle">
                    Created for {invite.targetEmail} · expires {formatTimestamp(invite.expiresAt)}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  className="max-w-full whitespace-normal text-right"
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
            ? memberActionTitle(
                memberConfirmation.action,
                memberConfirmation.member.subjectId === props.identity.subjectId
                  ? "your membership"
                  : maskedOrganizationSubject(memberConfirmation.member.subjectId),
              )
            : "Update member?"
        }
        description={
          memberConfirmation ? memberActionDescription(memberConfirmation.action) : undefined
        }
        confirmLabel={
          memberConfirmation ? memberActionConfirmLabel(memberConfirmation.action) : "Update member"
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
    return "This immediately pauses organization access, removes shared-workspace access, revokes personal grants, and cancels unfinished work. Personal data is retained under the organization retention policy.";
  }
  if (action === "reactivate") {
    return "This restores organization membership and the member's own Personal workspace. Shared-workspace access removed when access was paused is not restored automatically.";
  }
  return "Removing a member is permanent: access ends immediately, unfinished work is cancelled, the member cannot be invited again, and retained personal data follows the organization retention policy.";
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
      setState({
        ownerKey: identityKey,
        value: null,
        loading: false,
        error: null,
      });
      return;
    }
    const operation = claim("read");
    setState({
      ownerKey: identityKey,
      value: null,
      loading: true,
      error: null,
    });
    try {
      const policy = await props.client.getOrganizationRetentionPolicy(
        props.identity.organizationId,
      );
      if (!owns(operation)) return;
      setState({
        ownerKey: identityKey,
        value: policy,
        loading: false,
        error: null,
      });
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
      setState({
        ownerKey: identityKey,
        value: updated,
        loading: false,
        error: null,
      });
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
            Personal-data retention after removal
          </h2>
          <p className="mt-1 text-xs text-fg-muted">
            Retention controls stored personal data after someone is permanently removed. It never
            delays immediate access removal.
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
                Retain personal data indefinitely after removal
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
            ? "Removed members' personal data will be retained indefinitely. This does not restore or preserve their access."
            : `Removed members' personal data will become eligible for the bounded operator cleanup sweep after ${days} days. Access still ends immediately when the member is removed.`
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
