import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import {
  getOrganizationPrivateSessionSettings,
  updateOrganizationPrivateSessionSettings,
} from "@opengeni/sdk/organization-private-session-settings";
import { retryOrganizationUserSetupDelivery } from "@opengeni/sdk/organization-user-setup";
import {
  ArrowUpRightIcon,
  Building2Icon,
  CheckIcon,
  ClockIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
type WorkspaceNamedRole = Exclude<WorkspaceMemberRole, "custom">;
const WORKSPACE_MEMBER_BASELINE_PERMISSION = "workspace:read" as const satisfies SdkPermission;

type CustomPermissionEditor = {
  workspace: OrganizationWorkspaceAccess;
  member: OrganizationWorkspaceAccessMember;
  permissions: SdkPermission[];
};

function editableWorkspaceMemberPermissions(permissions: readonly string[]): SdkPermission[] {
  const editable = workspaceMemberPermissionGroups().flatMap((group) => group.permissions);
  const editableSet = new Set<string>(editable);
  return [
    WORKSPACE_MEMBER_BASELINE_PERMISSION,
    ...permissions.filter(
      (permission): permission is SdkPermission =>
        permission !== WORKSPACE_MEMBER_BASELINE_PERMISSION && editableSet.has(permission),
    ),
  ];
}

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
  client: OpenGeniBrowserClient;
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
    <section className="grid gap-3 border-b border-border pb-6">
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
        <Notice tone="muted" title="Private sessions are not enabled on this installation">
          Ask the deployment operator to enable private-session support. When it is ready, this
          control becomes available automatically.
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

function workspaceMemberLabel(member: OrganizationWorkspaceAccessMember): string {
  return (
    member.name ??
    member.email ??
    member.subjectLabel ??
    maskedOrganizationSubject(member.subjectId)
  );
}

export function OrganizationOverviewSection(props: {
  client: OpenGeniBrowserClient;
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
    Record<string, WorkspaceNamedRole>
  >({});
  const [workspaceMemberRoleDrafts, setWorkspaceMemberRoleDrafts] = useState<
    Record<string, WorkspaceMemberRole>
  >({});
  const [customPermissionEditor, setCustomPermissionEditor] =
    useState<CustomPermissionEditor | null>(null);
  const [workspaceNameDrafts, setWorkspaceNameDrafts] = useState<Record<string, string>>({});
  const [accessBusyWorkspaceId, setAccessBusyWorkspaceId] = useState<string | null>(null);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
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
    setCustomPermissionEditor(null);
    setCreateWorkspaceOpen(false);
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
    const pending = pendingWorkspaceAccessRef.current.get(workspaceId);
    const attempt =
      pending?.membershipId === member.id &&
      pending.role === role &&
      pending.expectedUpdatedAt === null &&
      pending.permissions === undefined
        ? pending
        : {
            membershipId: member.id,
            role,
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
        {
          role: attempt.role as WorkspaceNamedRole,
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
  ): Promise<boolean> {
    const resolvedPermissions =
      role === "custom" ? editableWorkspaceMemberPermissions(permissions ?? []) : permissions;
    if (!member.organizationMembershipId || (role === "custom" && !resolvedPermissions?.length)) {
      return false;
    }
    const key = `${workspace.id}:${member.organizationMembershipId}`;
    const pending = pendingWorkspaceAccessRef.current.get(key);
    const attempt =
      pending?.membershipId === member.organizationMembershipId &&
      pending.role === role &&
      pending.expectedUpdatedAt === member.updatedAt &&
      JSON.stringify(pending.permissions ?? []) === JSON.stringify(resolvedPermissions ?? [])
        ? pending
        : {
            membershipId: member.organizationMembershipId,
            role,
            ...(resolvedPermissions ? { permissions: resolvedPermissions } : {}),
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
      return true;
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
      return false;
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
      setCreateWorkspaceOpen(false);
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
      <div className="flex items-center gap-2 border-b border-border py-5 text-sm text-fg-muted">
        <Loader2Icon className="size-4 animate-spin" /> Loading organization…
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-4">
      <section className="grid gap-4 border-b border-border pb-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
              Organization
            </p>
            {editing ? (
              <div className="mt-1 flex max-w-lg gap-2">
                <Input
                  aria-label="Organization name"
                  name="organization-name"
                  autoComplete="off"
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
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>
              <PencilIcon className="size-3.5" /> Rename
            </Button>
          ) : null}
        </div>
        <div className="grid grid-cols-1 divide-y divide-border border-y border-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <Metric label="Shared workspaces" value={overview.workspaces.length} />
          <Metric label="People with access" value={peopleWithAccess} />
          <Metric
            label="Your role"
            value={props.actorRole ? ORGANIZATION_ROLE_LABELS[props.actorRole] : "Unknown"}
          />
        </div>
      </section>

      <section className="grid gap-3 border-b border-border pb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">Workspaces &amp; access</h2>
            <p className="mt-1 text-xs text-fg-muted">
              Create shared workspaces, then choose which organization members can use each one.
              Personal workspaces stay private.
            </p>
          </div>
          <Button type="button" size="sm" onClick={() => setCreateWorkspaceOpen(true)}>
            <PlusIcon className="size-3.5" />
            Create new workspace
          </Button>
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
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-xs text-fg-muted">
                        {workspace.members.length}{" "}
                        {workspace.members.length === 1 ? "member" : "members"}
                      </span>
                      {props.accessibleWorkspaceIds.has(workspace.id) ? (
                        <a
                          href={`/workspaces/${encodeURIComponent(workspace.id)}/settings?section=general`}
                          aria-label={`Open ${workspace.name} workspace settings`}
                          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          Open settings
                          <ArrowUpRightIcon className="size-3.5" />
                        </a>
                      ) : null}
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
                          name={`workspace-name-${workspace.id}`}
                          autoComplete="off"
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
                                [workspace.id]: event.target.value as WorkspaceNamedRole,
                              }))
                            }
                          >
                            {overview.roles.map((role) => (
                              <option key={role.role} value={role.role}>
                                {role.label}
                              </option>
                            ))}
                          </Select>
                        </label>
                        <Button
                          type="button"
                          size="sm"
                          disabled={
                            accessBusyWorkspaceId === workspace.id ||
                            !(workspaceAssignments[workspace.id] ?? "")
                          }
                          onClick={() => void addWorkspaceAccess(workspace.id)}
                        >
                          {accessBusyWorkspaceId === workspace.id ? (
                            <Loader2Icon className="size-3.5 animate-spin" />
                          ) : null}
                          Add access
                        </Button>
                      </div>
                    ) : null}
                    {workspace.members.length === 0 ? (
                      <p className="py-2 text-xs text-fg-subtle">No direct workspace access.</p>
                    ) : (
                      <div className="grid gap-2">
                        {workspace.members.map((member) => {
                          const memberKey = `${workspace.id}:${member.membershipId}`;
                          const roleDraft = workspaceMemberRoleDrafts[memberKey] ?? member.role;
                          const roleDescription =
                            roleDraft === "custom"
                              ? `${member.permissions.length} individually selected permissions`
                              : (overview.roles.find((role) => role.role === roleDraft)
                                  ?.description ?? "Named workspace role");
                          return (
                            <div
                              key={member.membershipId}
                              className="grid min-w-0 gap-3 rounded-md border border-border/70 bg-bg/25 p-3 md:grid-cols-[minmax(11rem,1fr)_minmax(15rem,1.35fr)_auto] md:items-center"
                            >
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium">
                                  {workspaceMemberLabel(member)}
                                </div>
                                <div className="mt-0.5 text-2xs capitalize text-fg-subtle">
                                  {member.principalKind}
                                </div>
                              </div>
                              <div className="grid min-w-0 gap-1.5">
                                {member.principalKind === "human" ? (
                                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                                    <Select
                                      aria-label={`Workspace access for ${workspaceMemberLabel(member)}`}
                                      className="min-w-0 flex-1 sm:min-w-48"
                                      value={roleDraft}
                                      disabled={
                                        accessBusyWorkspaceId === workspace.id ||
                                        !member.organizationMembershipId
                                      }
                                      onChange={(event) => {
                                        const role = event.target.value as WorkspaceNamedRole;
                                        setWorkspaceMemberRoleDrafts((current) => ({
                                          ...current,
                                          [memberKey]: role,
                                        }));
                                        void updateWorkspaceAccess(workspace, member, role);
                                      }}
                                    >
                                      {roleDraft === "custom" ? (
                                        <option value="custom" disabled>
                                          Custom access
                                        </option>
                                      ) : null}
                                      {overview.roles.map((role) => (
                                        <option key={role.role} value={role.role}>
                                          {role.label}
                                        </option>
                                      ))}
                                    </Select>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="shrink-0"
                                      disabled={
                                        accessBusyWorkspaceId === workspace.id ||
                                        !member.organizationMembershipId
                                      }
                                      aria-label={`Fine-tune permissions for ${workspaceMemberLabel(member)}`}
                                      onClick={() =>
                                        setCustomPermissionEditor({
                                          workspace,
                                          member,
                                          permissions: editableWorkspaceMemberPermissions(
                                            member.permissions,
                                          ),
                                        })
                                      }
                                    >
                                      <SlidersHorizontalIcon className="size-3.5" />
                                      Fine-tune
                                    </Button>
                                  </div>
                                ) : (
                                  <span className="text-sm capitalize text-fg-muted">
                                    {member.role}
                                  </span>
                                )}
                                <p className="min-w-0 text-xs leading-4 text-fg-muted">
                                  {roleDescription}
                                </p>
                              </div>
                              <div className="flex justify-end">
                                {member.subjectId !== props.identity.subjectId &&
                                member.principalKind === "human" &&
                                member.organizationMembershipId ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    disabled={accessBusyWorkspaceId === workspace.id}
                                    onClick={() => setRevokeWorkspaceAccess({ workspace, member })}
                                  >
                                    Remove access
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </section>
      <Dialog
        open={createWorkspaceOpen}
        onOpenChange={(open) => {
          if (creatingWorkspace) return;
          setCreateWorkspaceOpen(open);
          if (!open) setNewWorkspaceName("");
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create a new workspace</DialogTitle>
            <DialogDescription>
              Workspaces keep sessions, tools, integrations, and access separate within your
              organization.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void createWorkspace();
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="new-workspace-name">Workspace name</Label>
              <Input
                id="new-workspace-name"
                aria-label="New workspace name"
                name="workspace-name"
                autoComplete="off"
                placeholder="For example, Product team…"
                value={newWorkspaceName}
                onChange={(event) => setNewWorkspaceName(event.target.value)}
                disabled={creatingWorkspace}
                autoFocus
              />
              <p className="text-xs text-fg-muted">
                You can invite organization members after it is created.
              </p>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={creatingWorkspace}
                onClick={() => {
                  setCreateWorkspaceOpen(false);
                  setNewWorkspaceName("");
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!newWorkspaceName.trim() || creatingWorkspace}>
                {creatingWorkspace ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                Create workspace
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={customPermissionEditor !== null}
        onOpenChange={(open) => {
          if (!open && accessBusyWorkspaceId === null) setCustomPermissionEditor(null);
        }}
      >
        <DialogContent className="max-h-[92dvh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-h-[88vh] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Fine-tune workspace access</DialogTitle>
            <DialogDescription>
              {customPermissionEditor
                ? `Choose exactly what ${workspaceMemberLabel(customPermissionEditor.member)} can do in ${customPermissionEditor.workspace.name}.`
                : "Choose exactly what this person can do."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid min-h-0 gap-5 overflow-y-auto px-1 pb-1">
            <section className="grid gap-2" aria-labelledby="access-starting-point-heading">
              <div>
                <h3 id="access-starting-point-heading" className="text-sm font-medium">
                  Start with a simple access level
                </h3>
                <p className="mt-1 text-xs text-fg-muted">
                  Pick the closest level, then adjust individual permissions below.
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                {overview.roles.map((role) => (
                  <button
                    key={role.role}
                    type="button"
                    className="grid min-w-0 gap-1 rounded-md border border-border bg-bg/35 p-3 text-left transition-colors hover:border-border-strong hover:bg-surface-2 disabled:opacity-50"
                    disabled={accessBusyWorkspaceId !== null}
                    aria-label={`Use ${role.label} permissions`}
                    onClick={() =>
                      setCustomPermissionEditor((current) =>
                        current
                          ? {
                              ...current,
                              permissions: editableWorkspaceMemberPermissions(role.permissions),
                            }
                          : null,
                      )
                    }
                  >
                    <span className="text-sm font-medium">{role.label}</span>
                    <span className="text-xs leading-4 text-fg-muted">{role.description}</span>
                  </button>
                ))}
              </div>
            </section>
            <section className="grid gap-3 border-t border-border pt-4">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium">Individual permissions</h3>
                  <p className="mt-1 text-xs text-fg-muted">
                    Workspace membership and basic visibility are included automatically. Choose the
                    additional actions this person may perform.
                  </p>
                </div>
              </div>
              <PermissionGroupPicker
                groups={workspaceMemberPermissionGroups()}
                selected={new Set(customPermissionEditor?.permissions ?? [])}
                disabled={accessBusyWorkspaceId !== null}
                onToggle={(permission) =>
                  setCustomPermissionEditor((current) => {
                    if (!current) return null;
                    const selected = new Set(current.permissions);
                    if (selected.has(permission as SdkPermission)) {
                      selected.delete(permission as SdkPermission);
                    } else {
                      selected.add(permission as SdkPermission);
                    }
                    return { ...current, permissions: [...selected] };
                  })
                }
                onSetGroup={(permissions, shouldSelect) =>
                  setCustomPermissionEditor((current) => {
                    if (!current) return null;
                    const selected = new Set(current.permissions);
                    for (const permission of permissions) {
                      if (shouldSelect) selected.add(permission as SdkPermission);
                      else selected.delete(permission as SdkPermission);
                    }
                    return { ...current, permissions: [...selected] };
                  })
                }
              />
            </section>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={accessBusyWorkspaceId !== null}
              onClick={() => setCustomPermissionEditor(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                !customPermissionEditor ||
                customPermissionEditor.permissions.length === 0 ||
                accessBusyWorkspaceId !== null
              }
              onClick={() => {
                if (!customPermissionEditor) return;
                const editor = customPermissionEditor;
                void updateWorkspaceAccess(
                  editor.workspace,
                  editor.member,
                  "custom",
                  editor.permissions,
                ).then((saved) => {
                  if (saved) setCustomPermissionEditor(null);
                });
              }}
            >
              {accessBusyWorkspaceId !== null ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : null}
              Save custom access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
    <div className="px-3 py-3 first:pl-0 last:pr-0 sm:px-5">
      <p className="text-base font-semibold capitalize">{value}</p>
      <p className="mt-0.5 text-2xs uppercase tracking-wide text-fg-subtle">{label}</p>
    </div>
  );
}

export function OrganizationPeopleSection(props: {
  client: OpenGeniBrowserClient;
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
  const [inviteRole, setInviteRole] = useState<OrganizationMembershipRole>("member");
  const [inviteWorkspaces, setInviteWorkspaces] = useState<OrganizationWorkspaceAccess[]>([]);
  const [inviteWorkspaceIds, setInviteWorkspaceIds] = useState<string[]>([]);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");
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
    setInviteDialogOpen(false);
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
      setInviteWorkspaceIds([]);
      setInviteDialogOpen(false);
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
  const pendingAdminInvites = adminInvites.value.invitations.filter(
    (invite) => invite.status === "pending",
  );
  const activeOwnerCount = members.value.filter(
    (member) => member.role === "owner" && member.status === "active",
  ).length;
  const normalizedMemberSearch = memberSearch.trim().toLowerCase();
  const visibleMembers = members.value.filter((member) => {
    if (!normalizedMemberSearch) return true;
    return [
      organizationMemberLabel(member, props.identity.subjectId),
      member.email,
      ORGANIZATION_ROLE_LABELS[member.role],
      organizationMemberStatusLabel(member.status),
      ...member.sharedWorkspaceAccess.map((access) => access.workspaceName),
    ]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(normalizedMemberSearch));
  });
  return (
    <div className="grid min-w-0 gap-5 [&>section>*]:min-w-0 [&>section]:min-w-0">
      <section
        aria-labelledby="organization-people-heading"
        className="grid gap-4 border-b border-border pb-6"
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
              Manage organization roles and shared workspace access. Personal workspaces and private
              resources are never shared here.
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
          <div className="overflow-hidden rounded-xl border border-border bg-surface/30">
            <div className="flex flex-col gap-3 border-b border-border bg-surface-raised/35 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative w-full sm:max-w-xs">
                <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
                <Input
                  type="search"
                  aria-label="Search organization people"
                  placeholder="Search people or workspaces"
                  value={memberSearch}
                  onChange={(event) => setMemberSearch(event.target.value)}
                  className="h-8 pl-9"
                />
              </div>
              <p className="shrink-0 text-xs tabular-nums text-fg-subtle">
                {normalizedMemberSearch
                  ? `${visibleMembers.length} of ${members.value.length}`
                  : `${members.value.length} ${members.value.length === 1 ? "person" : "people"}`}
              </p>
            </div>

            <div
              aria-hidden="true"
              className="hidden grid-cols-[minmax(13rem,1.5fr)_minmax(11rem,1.15fr)_10.5rem_7rem_2.5rem] gap-3 border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-fg-subtle md:grid"
            >
              <span>Person</span>
              <span>Shared workspaces</span>
              <span>Organization role</span>
              <span>Status</span>
              <span />
            </div>

            {visibleMembers.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <p className="text-sm font-medium text-fg">No matching people</p>
                <p className="mt-1 text-xs text-fg-muted">
                  Try a name, email, role, status, or workspace.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-border/70">
                {visibleMembers.map((member) => {
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
                  const memberName = member.name?.trim() || member.email || label;
                  const avatarLetter = memberName.slice(0, 1).toUpperCase();
                  const workspaceAccessTitle = member.sharedWorkspaceAccess
                    .map((access) => `${access.workspaceName} (${access.role})`)
                    .join(", ");
                  const firstWorkspace = member.sharedWorkspaceAccess[0];
                  const additionalWorkspaceCount = Math.max(
                    0,
                    member.sharedWorkspaceAccess.length - 1,
                  );
                  const hasMemberActions =
                    capability.canSuspend || capability.canReactivate || capability.canOffboard;
                  return (
                    <article
                      key={member.id}
                      className="grid min-w-0 gap-3 px-3 py-3 transition-colors hover:bg-surface-raised/35 md:grid-cols-[minmax(13rem,1.5fr)_minmax(11rem,1.15fr)_10.5rem_7rem_2.5rem] md:items-center"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-brand/20 bg-brand/10 text-xs font-semibold text-brand">
                          {avatarLetter}
                        </span>
                        <div className="min-w-0">
                          <h3 className="truncate text-sm font-medium">{label}</h3>
                          {member.email && member.email !== label ? (
                            <p className="truncate text-xs text-fg-subtle">{member.email}</p>
                          ) : null}
                        </div>
                      </div>

                      <div className="min-w-0 text-xs text-fg-muted" title={workspaceAccessTitle}>
                        {firstWorkspace ? (
                          <p className="truncate">
                            <span className="text-fg">{firstWorkspace.workspaceName}</span>
                            <span className="ml-1 text-fg-subtle">{firstWorkspace.role}</span>
                            {additionalWorkspaceCount > 0 ? (
                              <span className="ml-1.5 rounded-full bg-surface-raised px-1.5 py-0.5 text-[11px] text-fg-muted">
                                +{additionalWorkspaceCount}
                              </span>
                            ) : null}
                          </p>
                        ) : (
                          <span className="text-fg-subtle">No shared workspaces</span>
                        )}
                      </div>

                      <div className="flex min-w-0 items-center gap-1.5">
                        {soleActiveOwner ? (
                          <div
                            className="min-w-0 flex-1"
                            title="Add another owner before changing this role."
                          >
                            <Select
                              aria-label={`Organization role for ${label}`}
                              aria-describedby={soleOwnerReasonId}
                              value={member.role}
                              disabled
                              className="h-8"
                            >
                              <option value={member.role}>
                                {ORGANIZATION_ROLE_LABELS[member.role]}
                              </option>
                            </Select>
                            <span id={soleOwnerReasonId} className="sr-only">
                              Add another active owner before changing this role.
                            </span>
                          </div>
                        ) : capability.canChangeRole ? (
                          <div className="min-w-0 flex-1">
                            <Select
                              aria-label={`Organization role for ${label}`}
                              value={roleDraft}
                              disabled={visibleBusyResource === "members"}
                              className="h-8"
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
                          </div>
                        ) : (
                          <span className="truncate text-sm text-fg-muted">
                            {ORGANIZATION_ROLE_LABELS[member.role]}
                          </span>
                        )}
                        {capability.canChangeRole && roleDraft !== member.role ? (
                          <Button
                            type="button"
                            size="icon-sm"
                            aria-label={`Save role for ${label}`}
                            title="Save role"
                            disabled={visibleBusyResource === "members"}
                            onClick={() => void changeRole(member)}
                          >
                            <CheckIcon className="size-3.5" />
                          </Button>
                        ) : null}
                      </div>

                      <div className="flex items-center gap-1.5 text-xs text-fg-muted">
                        <span
                          aria-hidden="true"
                          className={`size-1.5 rounded-full ${
                            member.status === "active"
                              ? "bg-success"
                              : member.status === "provisioning"
                                ? "bg-warning"
                                : "bg-fg-subtle"
                          }`}
                        />
                        <span>{organizationMemberStatusLabel(member.status)}</span>
                        {soleActiveOwner ? (
                          <span className="hidden text-fg-subtle xl:inline">· sole owner</span>
                        ) : null}
                      </div>

                      <div className="flex justify-end">
                        {hasMemberActions ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`More actions for ${label}`}
                                title="More actions"
                                disabled={visibleBusyResource === "members"}
                                onClick={(event) => {
                                  actionTriggerRef.current = event.currentTarget;
                                }}
                              >
                                <MoreHorizontalIcon className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                              {capability.canSuspend ? (
                                <DropdownMenuItem
                                  onSelect={() =>
                                    setMemberConfirmation({ member, action: "suspend" })
                                  }
                                >
                                  <PauseIcon />
                                  Pause access
                                </DropdownMenuItem>
                              ) : null}
                              {capability.canReactivate ? (
                                <DropdownMenuItem
                                  onSelect={() =>
                                    setMemberConfirmation({ member, action: "reactivate" })
                                  }
                                >
                                  <PlayIcon />
                                  Restore access
                                </DropdownMenuItem>
                              ) : null}
                              {capability.canOffboard &&
                              (capability.canSuspend || capability.canReactivate) ? (
                                <DropdownMenuSeparator />
                              ) : null}
                              {capability.canOffboard ? (
                                <DropdownMenuItem
                                  variant="destructive"
                                  onSelect={() =>
                                    setMemberConfirmation({ member, action: "offboard" })
                                  }
                                >
                                  <UserMinusIcon />
                                  Remove from organization
                                </DropdownMenuItem>
                              ) : null}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            disabled
                            aria-label={`No actions available for ${label}`}
                            title={
                              soleActiveOwner
                                ? "Add another owner before changing, pausing, or removing this member."
                                : "No actions available"
                            }
                          >
                            <MoreHorizontalIcon className="size-4" />
                          </Button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>

      {canAdminister ? (
        <section
          aria-labelledby="organization-invitations-heading"
          className="grid gap-4 border-b border-border pb-6"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2
                id="organization-invitations-heading"
                className="flex items-center gap-1.5 text-sm font-medium"
              >
                <UserPlusIcon className="size-3.5 text-brand" />
                Invitations
              </h2>
              <p className="mt-1 text-xs text-fg-muted">
                Invite people who are not in this organization yet.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              disabled={adminInvites.loading || visibleBusyResource !== null}
              onClick={() => setInviteDialogOpen(true)}
            >
              <PlusIcon className="size-3.5" />
              Invite person
            </Button>
          </div>
          {adminInvites.error ? (
            <LoadErrorState
              title="Could not load organization invitations"
              error={adminInvites.error}
              onRetry={() => void loadAdminInvitations()}
            />
          ) : adminInvites.loading && pendingAdminInvites.length === 0 ? (
            <p role="status" className="text-xs text-fg-muted">
              Loading invitations…
            </p>
          ) : pendingAdminInvites.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center">
              <p className="text-sm font-medium text-fg">No pending invitations</p>
              <p className="mt-1 text-xs text-fg-muted">
                Invite someone when you&apos;re ready to grow the organization.
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-surface/30">
              <div className="flex items-center justify-between border-b border-border bg-surface-raised/35 px-3 py-2">
                <span className="text-xs font-medium text-fg-muted">Pending</span>
                <span className="text-xs tabular-nums text-fg-subtle">
                  {pendingAdminInvites.length}
                </span>
              </div>
              <div className="divide-y divide-border/70">
                {pendingAdminInvites.map((invite) => {
                  const canRetry = !invite.delivery || invite.delivery.retryState === "available";
                  const canRevoke = canRevokeOrganizationInvitation(props.actorRole, invite.role);
                  const deliveryLabel =
                    invite.delivery?.state === "sent"
                      ? "Sent"
                      : invite.delivery?.state === "pending"
                        ? "Sending"
                        : invite.delivery?.state === "failed"
                          ? "Delivery failed"
                          : invite.delivery?.state === "outcome_unknown"
                            ? "Delivery needs review"
                            : "Not sent";
                  const workspaceNames = invite.initialWorkspaceIds.map(
                    (workspaceId) =>
                      inviteWorkspaces.find((workspace) => workspace.id === workspaceId)?.name ??
                      "Unavailable workspace",
                  );
                  return (
                    <div
                      key={invite.id}
                      className="flex min-w-0 items-center gap-3 px-3 py-3 transition-colors hover:bg-surface-raised/35"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface-raised text-xs font-semibold text-fg-muted">
                        {(invite.targetName || invite.targetEmail).slice(0, 1).toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-fg">
                          {invite.targetName || invite.targetEmail}
                        </p>
                        {invite.targetName ? (
                          <p className="truncate text-xs text-fg-subtle">{invite.targetEmail}</p>
                        ) : null}
                        <p className="mt-1 truncate text-xs text-fg-muted">
                          {ORGANIZATION_ROLE_LABELS[invite.role]} · {deliveryLabel} · Expires{" "}
                          {formatTimestamp(invite.expiresAt)}
                          {workspaceNames.length > 0
                            ? ` · ${workspaceNames.length} ${workspaceNames.length === 1 ? "workspace" : "workspaces"}`
                            : ""}
                        </p>
                        {(!invite.delivery ||
                          invite.delivery.state === "failed" ||
                          invite.delivery.state === "outcome_unknown") && (
                          <InvitationDeliveryStatus invitation={invite} />
                        )}
                      </div>
                      {canRetry || canRevoke ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`More actions for invitation to ${invite.targetEmail}`}
                              title="More actions"
                              disabled={visibleBusyResource !== null || adminInvites.loading}
                              onClick={(event) => {
                                actionTriggerRef.current = event.currentTarget;
                              }}
                            >
                              <MoreHorizontalIcon className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48">
                            {canRetry ? (
                              <DropdownMenuItem
                                aria-label={`${invite.delivery ? "Retry delivery" : "Send invitation"} to ${invite.targetEmail}`}
                                onSelect={() => void retryInvitationDelivery(invite)}
                              >
                                <RefreshCwIcon />
                                {invite.delivery ? "Retry delivery" : "Send invitation"}
                              </DropdownMenuItem>
                            ) : null}
                            {canRetry && canRevoke ? <DropdownMenuSeparator /> : null}
                            {canRevoke ? (
                              <DropdownMenuItem
                                variant="destructive"
                                aria-label={`Revoke invitation for ${invite.targetEmail}`}
                                onSelect={() => setRevokeConfirmation(invite)}
                              >
                                <UserMinusIcon />
                                Revoke invitation
                              </DropdownMenuItem>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled
                          aria-label={`No actions available for invitation to ${invite.targetEmail}`}
                        >
                          <MoreHorizontalIcon className="size-4" />
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
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

          <Dialog
            open={inviteDialogOpen}
            onOpenChange={(open) => {
              if (visibleBusyResource === "admin-invitations") return;
              setInviteDialogOpen(open);
              if (!open) {
                setInviteEmail("");
                setInviteRole("member");
                setInviteWorkspaceIds([]);
              }
            }}
          >
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Invite person</DialogTitle>
                <DialogDescription>
                  They&apos;ll receive an email invitation to join this organization.
                </DialogDescription>
              </DialogHeader>
              <form
                className="grid gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createInvitation();
                }}
              >
                <div className="grid gap-1.5">
                  <Label htmlFor="organization-invite-email">Email address</Label>
                  <Input
                    id="organization-invite-email"
                    type="email"
                    name="email"
                    autoComplete="email"
                    spellCheck={false}
                    value={inviteEmail}
                    onChange={(event) => setInviteEmail(event.target.value)}
                    placeholder="name@company.com"
                    autoFocus
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="organization-invite-role">Organization role</Label>
                  <Select
                    id="organization-invite-role"
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
                </div>
                {inviteWorkspaces.length > 0 ? (
                  <details className="group rounded-lg border border-border bg-surface/30">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-sm font-medium text-fg marker:hidden">
                      <span>Workspace access</span>
                      <span className="text-xs font-normal text-fg-subtle">
                        {inviteWorkspaceIds.length === 0
                          ? "Optional"
                          : `${inviteWorkspaceIds.length} selected`}
                      </span>
                    </summary>
                    <div className="grid gap-2 border-t border-border px-3 py-3 sm:grid-cols-2">
                      {inviteWorkspaces.map((workspace) => (
                        <label key={workspace.id} className="flex items-center gap-2 text-sm">
                          <input
                            name="initial-workspace-access"
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
                          <span className="truncate">{workspace.name}</span>
                        </label>
                      ))}
                    </div>
                  </details>
                ) : null}
                <DialogFooter>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={visibleBusyResource === "admin-invitations"}
                    onClick={() => {
                      setInviteDialogOpen(false);
                      setInviteEmail("");
                      setInviteRole("member");
                      setInviteWorkspaceIds([]);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={
                      !inviteEmail.trim() ||
                      visibleBusyResource !== null ||
                      adminInvites.loading ||
                      !canInviteOrganizationRole(props.actorRole, inviteRole)
                    }
                  >
                    {visibleBusyResource === "admin-invitations" ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : null}
                    Send invitation
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </section>
      ) : null}

      {incoming.error || pendingIncoming.length > 0 ? (
        <section
          aria-labelledby="incoming-invitations-heading"
          className="grid gap-3 border-b border-border pb-6"
        >
          <div>
            <h2
              id="incoming-invitations-heading"
              className="flex items-center gap-1.5 text-sm font-medium"
            >
              <ClockIcon className="size-3.5 text-brand" />
              Invitations for you
            </h2>
            <p className="mt-1 text-xs text-fg-muted">
              Join another organization that invited you.
            </p>
          </div>
          {incoming.error ? (
            <LoadErrorState
              title="Could not load your invitations"
              error={incoming.error}
              onRetry={() => void loadIncomingInvitations()}
            />
          ) : (
            <div className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border bg-surface/30">
              {pendingIncoming.map((invite) => (
                <div
                  key={invite.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-3 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg">
                      {invite.organizationName ||
                        `Organization ${invite.organizationId.slice(0, 8)}`}
                    </p>
                    <p className="mt-0.5 text-xs text-fg-subtle">
                      {ORGANIZATION_ROLE_LABELS[invite.role]} · Expires{" "}
                      {formatTimestamp(invite.expiresAt)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={visibleBusyResource !== null || incoming.loading}
                    onClick={() => void acceptInvitation(invite)}
                  >
                    <CheckIcon className="size-3.5" />
                    Accept
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
              Load more invitations
            </Button>
          ) : null}
        </section>
      ) : null}

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
  client: OpenGeniBrowserClient;
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
      className="grid gap-4 border-b border-border pb-6"
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
            <fieldset disabled={visibleBusy} className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">Owner-only retention policy</legend>
              <label className="flex cursor-pointer gap-3 rounded-lg border border-border bg-bg/25 p-3 text-sm transition-colors has-[:checked]:border-brand/50 has-[:checked]:bg-brand/5">
                <input
                  className="mt-0.5 shrink-0 accent-brand"
                  type="radio"
                  name="retention-mode"
                  checked={mode === "retain"}
                  onChange={() => setMode("retain")}
                />
                <span>
                  <span className="block font-medium">Retain indefinitely</span>
                  <span className="mt-0.5 block text-xs text-fg-muted">
                    Keep removed members&apos; retained personal data until an operator acts.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer gap-3 rounded-lg border border-border bg-bg/25 p-3 text-sm transition-colors has-[:checked]:border-brand/50 has-[:checked]:bg-brand/5">
                <input
                  className="mt-0.5 shrink-0 accent-brand"
                  type="radio"
                  name="retention-mode"
                  checked={mode === "delete_after"}
                  onChange={() => setMode("delete_after")}
                />
                <span>
                  <span className="block font-medium">Set a cleanup window</span>
                  <span className="mt-0.5 block text-xs text-fg-muted">
                    Make retained personal data eligible for operator cleanup after a delay.
                  </span>
                </span>
              </label>
              {mode === "delete_after" ? (
                <div className="grid max-w-52 gap-1">
                  <Label htmlFor="retention-days">Retention days (30–90)</Label>
                  <Input
                    id="retention-days"
                    name="retention-days"
                    autoComplete="off"
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
