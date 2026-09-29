// Settings > Access: who can use this workspace, with one role each. The same
// AccessList rows and verbs as every other place access is edited.
import { Link } from "@tanstack/react-router";
import { SearchIcon, UserPlusIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { SettingsHeaderActions } from "@/components/settings/settings-header-actions";
import { AccessList, type AccessMember } from "@/components/ui/access-list";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import { CheckboxField, Field, FieldStack, TextInput } from "@/components/ui/field";
import { FormDialog, FormPage } from "@/components/ui/form-dialog";
import { ListRow, RowList } from "@/components/ui/list-row";
import { Notice } from "@/components/ui/notice";
import { RelativeTime } from "@/components/ui/relative-time";
import {
  RoleSelect,
  roleLabel,
  type RoleOption,
  type RoleValue,
} from "@/components/ui/role-select";
import { Section, SectionStack } from "@/components/ui/section";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/context";
import { permissionLabel } from "@/lib/api-key-presets";
import { orgLabel } from "@/lib/org";
import {
  workspaceAccessLevels,
  workspaceMemberPermissionGroups,
  type WorkspaceAccessLevel,
} from "@/lib/permissions";
import type {
  SlackUserLinkAccessRequest,
  WorkspaceMember,
  WorkspaceMemberCandidate,
} from "@/types";
import { FLUSH_FORM_PAGE_CLASS } from "@/components/ui/flush-form-page";

/* ----------------------------------------------------------------------------
   Roles and rows, shared with the organization-managed Access page.
   -------------------------------------------------------------------------- */

/** Workspace roles, least to most access. Owner comes from the organization. */
export type WorkspaceRoleId = WorkspaceAccessLevel | "owner";

const ADMIN_ESCALATION =
  "They'll be able to change this workspace's settings, integrations and who has access.";

export const WORKSPACE_ROLE_OPTIONS: RoleOption<WorkspaceRoleId>[] = [
  ...workspaceAccessLevels.map((level) => ({
    id: level.role,
    label: level.label,
    description: level.description,
    escalation: level.role === "admin" ? ADMIN_ESCALATION : undefined,
  })),
  {
    id: "owner",
    label: "Owner",
    description: "Full control of this workspace, including deleting it.",
    disabledReason: "Owners come from the organization. They can't be picked here.",
  },
];

/** The roles someone can be given here: every role but Owner. */
export const ASSIGNABLE_WORKSPACE_ROLES = WORKSPACE_ROLE_OPTIONS.filter(
  (role) => role.id !== "owner",
);

export function initialsOf(name: string): string {
  const words = name
    .replace(/@.*$/, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters =
    words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** "a viewer", "a workspace admin": roles read as nouns inside sentences. */
export function asRole(label: string): string {
  const lower = label.toLowerCase();
  return `${/^[aeiou]/.test(lower) ? "an" : "a"} ${lower}`;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((value) => right.has(value));
}

/**
 * The role a grant shows. A named role whose permissions were changed by hand
 * is a custom grant that can go back to that role.
 */
export function workspaceRoleOf(member: Pick<WorkspaceMember, "role" | "permissions">): {
  role: RoleValue<WorkspaceRoleId>;
  resetRole?: WorkspaceRoleId;
} {
  if (member.role === "owner") return { role: "owner" };
  const level = workspaceAccessLevels.find((candidate) => candidate.role === member.role);
  if (level && sameSet(level.permissions, member.permissions)) return { role: level.role };
  return { role: "custom", resetRole: level?.role };
}

/** API keys are listed on the API keys page, not here. */
function isApiKeySubject(subjectId: string): boolean {
  return subjectId.startsWith("api_key:");
}

export function memberDisplayName(member: Pick<WorkspaceMember, "subjectId" | "subjectLabel">) {
  return member.subjectLabel?.trim() || member.subjectId.replace(/^(user|service):/, "");
}

export function toAccessMember(
  member: WorkspaceMember,
  selfSubjectId: string | undefined,
): AccessMember<WorkspaceRoleId> {
  const name = memberDisplayName(member);
  const { role, resetRole } = workspaceRoleOf(member);
  const isOwner = role === "owner";
  return {
    id: member.subjectId,
    name,
    initials: initialsOf(name),
    kind: member.subjectId.startsWith("service:") ? "service" : "person",
    isYou: member.subjectId === selfSubjectId,
    isOwner,
    role,
    resetRole,
    roleLockedReason: isOwner ? "Owners always have full access." : undefined,
  };
}

/* ----------------------------------------------------------------------------
   Pages that open in place of the list.
   -------------------------------------------------------------------------- */

/**
 * The access list inside an open section, flush like a resource RowList:
 * avatars line up with the section title, the rows keep their 12px padding
 * for the hover, and the hairlines stay inside the content edge.
 */
export const FLUSH_ACCESS_LIST = [
  "-mx-3",
  "[&_ul]:divide-transparent [&_ul>li]:relative",
  "[&_ul>li+li]:before:pointer-events-none [&_ul>li+li]:before:absolute [&_ul>li+li]:before:inset-x-3 [&_ul>li+li]:before:top-0 [&_ul>li+li]:before:h-px [&_ul>li+li]:before:bg-border [&_ul>li+li]:before:content-['']",
  "[&_ul+p]:border-t-0 [&_ul+p]:pt-1 [&_ul~div]:border-t-transparent",
].join(" ");

/** Moves focus to the page title (or its first control) when a page opens in place. */
function OpenedPage({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    const target =
      root?.querySelector<HTMLElement>("h1[tabindex]") ??
      root?.querySelector<HTMLElement>("input, a[href], button");
    target?.focus({ preventScroll: true });
  }, []);
  return (
    <div ref={ref} className="min-w-0">
      {children}
    </div>
  );
}

export interface AddCandidate {
  id: string;
  name: string;
  /** One quiet line: email and organization role. */
  description: string;
  searchText: string;
}

/** Show a search field once the list is long enough to need one. */
const SEARCH_THRESHOLD = 6;

function RoleField({
  value,
  onChange,
  roles,
}: {
  value: WorkspaceAccessLevel;
  onChange: (value: WorkspaceAccessLevel) => void;
  roles: readonly RoleOption<WorkspaceAccessLevel>[];
}) {
  const labelId = useId();
  const role = roles.find((each) => each.id === value);
  return (
    <div className="flex min-w-0 flex-col">
      <span id={labelId} className="mb-2 text-sm font-medium text-fg">
        Role
      </span>
      <RoleSelect
        size="md"
        align="start"
        aria-labelledby={labelId}
        roles={roles}
        value={value}
        onValueChange={(next) => {
          if (next) onChange(next);
        }}
        className="w-full max-w-80"
      />
      <p className="mt-1.5 text-xs leading-4.5 text-fg-muted">{role?.description}</p>
    </div>
  );
}

/** Add people who are already in the organization, with one role. A page, not a dialog. */
export function AddPeoplePage({
  workspaceName,
  organizationName,
  candidates,
  loadError,
  onRetry,
  roles,
  inviteLink,
  onSubmit,
  onClose,
}: {
  workspaceName: string;
  organizationName: string;
  /** Null while loading. */
  candidates: AddCandidate[] | null;
  loadError?: Error | null;
  onRetry?: () => void;
  roles: readonly RoleOption<WorkspaceAccessLevel>[];
  /** "Invite people" in the organization, when the viewer can reach it. */
  inviteLink?: ReactNode;
  /** Adds everyone picked. Throw a user-facing error to keep the page open. */
  onSubmit: (ids: string[], role: WorkspaceAccessLevel) => Promise<void>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [role, setRole] = useState<WorkspaceAccessLevel>("member");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string>();
  const count = selected.length;
  const query = search.trim().toLowerCase();
  const visible = (candidates ?? []).filter(
    (candidate) => !query || candidate.searchText.includes(query),
  );

  let body: ReactNode;
  if (loadError) {
    body = (
      <Notice
        tone="failed"
        title={`Couldn't load people from ${organizationName}`}
        action={
          onRetry ? (
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              Try again
            </Button>
          ) : undefined
        }
      >
        {loadErrorText(loadError)}
      </Notice>
    );
  } else if (candidates === null) {
    body = (
      <div role="status" aria-label="Loading people" className="flex flex-col gap-4">
        {[0, 1, 2].map((key) => (
          <div key={key} className="flex items-center gap-3">
            <Skeleton className="size-4 rounded-[4px] bg-surface-3" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-36 rounded-full bg-surface-3" />
              <Skeleton className="h-3 w-52 rounded-full bg-surface-3" />
            </div>
          </div>
        ))}
      </div>
    );
  } else if (candidates.length === 0) {
    body = (
      <p className="text-sm text-fg-muted">
        Everyone in {organizationName} already has access to {workspaceName}.
      </p>
    );
  } else {
    body = (
      <FieldStack>
        <Field label="People" group error={error}>
          <div className="flex min-w-0 flex-col gap-3">
            {candidates.length > SEARCH_THRESHOLD ? (
              <div className="relative">
                <SearchIcon
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-fg-subtle"
                />
                <TextInput
                  type="search"
                  aria-label="Search people"
                  placeholder="Search by name or email"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="h-9 pl-9"
                  suppressAutofill
                />
              </div>
            ) : null}
            {visible.length === 0 ? (
              <p className="text-sm text-fg-muted">No one matches “{search.trim()}”.</p>
            ) : (
              visible.map((candidate) => (
                <CheckboxField
                  key={candidate.id}
                  label={candidate.name}
                  description={candidate.description}
                  checked={selected.includes(candidate.id)}
                  onCheckedChange={(checked) => {
                    setError(undefined);
                    setSelected((current) =>
                      checked
                        ? [...current, candidate.id]
                        : current.filter((each) => each !== candidate.id),
                    );
                  }}
                />
              ))
            )}
          </div>
        </Field>
        <RoleField value={role} onChange={setRole} roles={roles} />
      </FieldStack>
    );
  }

  return (
    <OpenedPage>
      <FormPage
        back={{ label: "Access", onClick: onClose }}
        className={FLUSH_FORM_PAGE_CLASS}
        title={`Add people to ${workspaceName}`}
        description={`Choose people who are already in ${organizationName}.`}
        submitLabel={
          count <= 1 ? (count === 1 ? "Add 1 person" : "Add to workspace") : `Add ${count} people`
        }
        pendingLabel="Adding…"
        submitDisabled={!candidates || candidates.length === 0 || Boolean(loadError)}
        footerStart={
          inviteLink ? (
            <>
              New to {organizationName}? {inviteLink}
            </>
          ) : undefined
        }
        onCancel={onClose}
        onSubmit={async () => {
          if (count === 0) {
            setError("Choose at least one person.");
            return false;
          }
          await onSubmit(selected, role);
          return true;
        }}
        onSubmitted={onClose}
      >
        {body}
      </FormPage>
    </OpenedPage>
  );
}

/** Hand-picked permissions for one person, behind "Custom permissions…". */
function CustomPermissionsPage({
  member,
  workspaceName,
  onSave,
  onClose,
}: {
  member: WorkspaceMember;
  workspaceName: string;
  onSave: (permissions: Set<string>) => Promise<void>;
  onClose: () => void;
}) {
  const [permissions, setPermissions] = useState(() => new Set(member.permissions));
  return (
    <OpenedPage>
      <FormPage
        back={{ label: "Access", onClick: onClose }}
        className={FLUSH_FORM_PAGE_CLASS}
        title={`Custom permissions for ${memberDisplayName(member)}`}
        description={`Choose exactly what they can do in ${workspaceName}. Picking a role later replaces these.`}
        submitLabel="Save permissions"
        pendingLabel="Saving…"
        onCancel={onClose}
        onSubmit={async () => {
          await onSave(permissions);
          return true;
        }}
        onSubmitted={onClose}
      >
        <div className="flex min-w-0 flex-col gap-6">
          {workspaceMemberPermissionGroups().map((group) => (
            <Field key={group.label} label={group.label} group>
              <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                {group.permissions
                  // Old names the API still accepts: shown only when already granted.
                  .filter(
                    (permission) =>
                      !permission.startsWith("environments:") ||
                      member.permissions.includes(permission),
                  )
                  .map((permission) => (
                    <CheckboxField
                      key={permission}
                      label={permissionLabel(permission)}
                      description={
                        <code translate="no" className="font-mono text-2xs text-fg-subtle">
                          {permission}
                        </code>
                      }
                      // Seeing the workspace is part of every grant.
                      disabled={permission === "workspace:read"}
                      checked={permission === "workspace:read" || permissions.has(permission)}
                      onCheckedChange={(checked) =>
                        setPermissions((current) => {
                          const next = new Set(current);
                          if (checked) next.add(permission);
                          else next.delete(permission);
                          return next;
                        })
                      }
                    />
                  ))}
              </div>
            </Field>
          ))}
        </div>
      </FormPage>
    </OpenedPage>
  );
}

/* ----------------------------------------------------------------------------
   Requests from Slack.
   -------------------------------------------------------------------------- */

function requestName(request: SlackUserLinkAccessRequest): string {
  return request.subjectLabel?.trim() || "Signed-in Opengeni user";
}

function ReviewRequestDialog({
  request,
  workspaceName,
  onApprove,
  onDecline,
  onOpenChange,
}: {
  request: SlackUserLinkAccessRequest | null;
  workspaceName: string;
  onApprove: (request: SlackUserLinkAccessRequest, role: WorkspaceAccessLevel) => Promise<void>;
  onDecline: (request: SlackUserLinkAccessRequest) => Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const [role, setRole] = useState<WorkspaceAccessLevel>("member");
  const [declining, setDeclining] = useState(false);
  const roleLabelId = useId();
  return (
    <FormDialog
      open={request !== null}
      onOpenChange={(next) => {
        if (next) setRole("member");
        onOpenChange(next);
      }}
      size="sm"
      title={request ? `Give ${requestName(request)} access?` : "Access request"}
      description={
        request
          ? `Asked from Slack to use ${workspaceName}. Giving access also links their Slack account.`
          : undefined
      }
      submitLabel="Give access"
      pendingLabel="Adding…"
      footerStart={
        <Button
          type="button"
          variant="ghost"
          disabled={declining}
          onClick={async () => {
            if (!request) return;
            setDeclining(true);
            try {
              await onDecline(request);
              onOpenChange(false);
            } finally {
              setDeclining(false);
            }
          }}
          className="-ml-3 pointer-coarse:h-11"
        >
          Decline
        </Button>
      }
      onSubmit={async () => {
        if (!request) return false;
        await onApprove(request, role);
        return true;
      }}
    >
      {request ? (
        <div className="min-w-0">
          <p id={roleLabelId} className="mb-2 text-sm font-medium text-fg">
            Role
          </p>
          <RoleSelect
            variant="list"
            aria-labelledby={roleLabelId}
            roles={ASSIGNABLE_WORKSPACE_ROLES as RoleOption<WorkspaceAccessLevel>[]}
            value={role}
            subjectName={requestName(request)}
            onValueChange={(next) => {
              if (next) setRole(next);
            }}
          />
        </div>
      ) : null}
    </FormDialog>
  );
}

/* ----------------------------------------------------------------------------
   The page.
   -------------------------------------------------------------------------- */

/** A page that opens in place of the list. */
export type AccessView = { kind: "add" } | { kind: "custom"; subjectId: string } | null;

export function MembersSection(props: {
  workspaceId: string;
  canManage: boolean;
  /**
   * The page open in place of the list, when the URL owns it. Without these
   * the section keeps it in its own state.
   */
  view?: AccessView;
  onViewChange?: (view: AccessView) => void;
}) {
  return <MembersSectionContent key={props.workspaceId} {...props} />;
}

function MembersSectionContent({
  workspaceId,
  canManage,
  view: controlledView,
  onViewChange,
}: {
  workspaceId: string;
  canManage: boolean;
  view?: AccessView;
  onViewChange?: (view: AccessView) => void;
}) {
  const context = useAppContext();
  const client = context.client;
  const selfSubjectId = context.accessContext?.subjectId;
  const activeWorkspace = context.workspaces?.find((workspace) => workspace.id === workspaceId);
  const workspaceName = activeWorkspace?.name ?? "this workspace";
  const organizationName = activeWorkspace
    ? orgLabel(activeWorkspace.accountId, context.accessContext.accountGrants ?? [])
    : "your organization";
  // A local install has one person: nobody else to add, and no People page.
  const singleUser = context.clientConfig?.productAccessMode === "local";
  const canAddPeople = canManage && !singleUser;

  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [membersLoaded, setMembersLoaded] = useState(false);
  const [membersError, setMembersError] = useState<Error | null>(null);
  const [slackAccessRequests, setSlackAccessRequests] = useState<SlackUserLinkAccessRequest[]>([]);
  const [slackAccessRequestsError, setSlackAccessRequestsError] = useState<Error | null>(null);
  const [memberCandidates, setMemberCandidates] = useState<WorkspaceMemberCandidate[] | null>(null);
  const [memberCandidatesError, setMemberCandidatesError] = useState<Error | null>(null);
  const [savingIds, setSavingIds] = useState<string[]>([]);
  const [removeTarget, setRemoveTarget] = useState<WorkspaceMember | null>(null);
  const [reviewing, setReviewing] = useState<SlackUserLinkAccessRequest | null>(null);
  const [localView, setLocalView] = useState<AccessView>(null);
  const view = controlledView !== undefined ? controlledView : localView;
  const setView = (next: AccessView) => {
    if (onViewChange) onViewChange(next);
    else setLocalView(next);
  };

  const refreshGenerationRef = useRef(0);
  const candidateRefreshGenerationRef = useRef(0);
  const currentRefreshScopeRef = useRef<{
    canManage: boolean;
    client: typeof client;
    workspaceId: string;
  }>({ canManage, client, workspaceId });
  currentRefreshScopeRef.current = { canManage, client, workspaceId };

  const refresh = useCallback(async () => {
    const currentScope = currentRefreshScopeRef.current;
    if (
      !currentScope ||
      currentScope.workspaceId !== workspaceId ||
      currentScope.canManage !== canManage ||
      currentScope.client !== client
    ) {
      return;
    }
    const generation = ++refreshGenerationRef.current;
    const isCurrentRefresh = () => {
      const nextScope = currentRefreshScopeRef.current;
      return (
        refreshGenerationRef.current === generation &&
        nextScope?.workspaceId === workspaceId &&
        nextScope.canManage === canManage &&
        nextScope.client === client
      );
    };
    setMembersError(null);
    setSlackAccessRequestsError(null);
    const [memberResult, slackResult] = await Promise.allSettled([
      client.listWorkspaceMembers(workspaceId),
      canManage ? client.listSlackUserLinkAccessRequests(workspaceId) : Promise.resolve([]),
    ]);
    if (!isCurrentRefresh()) return;
    if (memberResult.status === "fulfilled") {
      // Every person and service with a grant is listed, owners included; API
      // keys have their own page.
      setMembers(memberResult.value.filter((member) => !isApiKeySubject(member.subjectId)));
    } else {
      setMembersError(
        memberResult.reason instanceof Error
          ? memberResult.reason
          : new Error(String(memberResult.reason)),
      );
    }
    setMembersLoaded(true);
    if (slackResult.status === "fulfilled") {
      setSlackAccessRequests(slackResult.value);
    } else {
      setSlackAccessRequestsError(
        slackResult.reason instanceof Error
          ? slackResult.reason
          : new Error(String(slackResult.reason)),
      );
    }
  }, [canManage, client, workspaceId]);

  useEffect(() => {
    refreshGenerationRef.current += 1;
    setMembers([]);
    setMembersLoaded(false);
    setMembersError(null);
    setSlackAccessRequests([]);
    setSlackAccessRequestsError(null);
    void refresh();
    return () => {
      refreshGenerationRef.current += 1;
    };
  }, [refresh]);

  const loadMemberCandidates = useCallback(async () => {
    const generation = ++candidateRefreshGenerationRef.current;
    setMemberCandidates(null);
    setMemberCandidatesError(null);
    try {
      const candidates = await client.listWorkspaceMemberCandidates(workspaceId);
      if (candidateRefreshGenerationRef.current !== generation) return;
      setMemberCandidates(candidates);
    } catch (caught) {
      if (candidateRefreshGenerationRef.current !== generation) return;
      setMemberCandidates([]);
      setMemberCandidatesError(caught instanceof Error ? caught : new Error(String(caught)));
    }
  }, [client, workspaceId]);

  useEffect(
    () => () => {
      candidateRefreshGenerationRef.current += 1;
    },
    [],
  );

  const adding = view?.kind === "add" && canAddPeople;
  // A single-user install has nobody to add: an old ?view=add link lands on the list.
  const addUnavailable = view?.kind === "add" && singleUser;
  useEffect(() => {
    if (addUnavailable) setView(null);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only when the link asks for it
  }, [addUnavailable]);
  useEffect(() => {
    if (adding) void loadMemberCandidates();
  }, [adding, loadMemberCandidates]);

  const memberLabel = memberDisplayName;

  async function addMembers(ids: string[], role: WorkspaceAccessLevel) {
    const level = workspaceAccessLevels.find((candidate) => candidate.role === role);
    if (!level) return;
    const picked = (memberCandidates ?? []).filter((candidate) =>
      ids.includes(candidate.organizationMembershipId),
    );
    const added: string[] = [];
    try {
      for (const candidate of picked) {
        await client.addWorkspaceMember(workspaceId, {
          organizationMembershipId: candidate.organizationMembershipId,
          role: level.role,
          permissions: [...level.permissions],
        });
        added.push(candidate.name?.trim() || candidate.email || "Organization member");
      }
    } catch (caught) {
      if (added.length > 0) void refresh();
      const reason =
        caught instanceof Error && caught.message
          ? caught.message
          : "They must still be an active member of the organization.";
      throw new Error(
        added.length > 0
          ? `Added ${added.join(", ")}, but couldn't add the rest. ${reason}`
          : `Couldn't add them. ${reason}`,
        { cause: caught },
      );
    }
    await refresh();
    toast.success(added.length === 1 ? `Added ${added[0]}` : `Added ${added.length} people`, {
      description: `As ${asRole(level.label)} in ${workspaceName}.`,
    });
  }

  async function changeMemberRole(member: WorkspaceMember, role: WorkspaceAccessLevel) {
    const level = workspaceAccessLevels.find((candidate) => candidate.role === role);
    if (!level) return;
    setSavingIds((ids) => [...ids, member.subjectId]);
    try {
      const updated = await client.updateWorkspaceMember(workspaceId, member.subjectId, {
        role,
        permissions: [...level.permissions],
      });
      setMembers((current) =>
        current.map((candidate) =>
          candidate.subjectId === updated.subjectId ? updated : candidate,
        ),
      );
      toast.success(`${memberLabel(member)} is now ${asRole(level.label)}`);
    } catch (caught) {
      toast.error(`Couldn't change ${memberLabel(member)}'s role`, {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setSavingIds((ids) => ids.filter((id) => id !== member.subjectId));
    }
  }

  async function saveCustomPermissions(member: WorkspaceMember, selected: Set<string>) {
    const permissions = new Set(selected);
    permissions.add("workspace:read");
    try {
      const updated = await client.updateWorkspaceMember(workspaceId, member.subjectId, {
        role: "custom",
        permissions: [...permissions],
      });
      setMembers((current) =>
        current.map((candidate) =>
          candidate.subjectId === updated.subjectId ? updated : candidate,
        ),
      );
      toast.success(`Saved custom permissions for ${memberLabel(member)}`);
    } catch (caught) {
      throw new Error(
        `Couldn't save the permissions. ${caught instanceof Error ? caught.message : String(caught)}`,
        { cause: caught },
      );
    }
  }

  async function removeMember() {
    if (!removeTarget) return false;
    try {
      await client.removeWorkspaceMember(workspaceId, removeTarget.subjectId);
    } catch (caught) {
      throw new Error(
        `Couldn't remove ${memberLabel(removeTarget)}. ${
          caught instanceof Error ? caught.message : String(caught)
        }`,
        { cause: caught },
      );
    }
    const removed = removeTarget;
    setMembers((current) => current.filter((member) => member.subjectId !== removed.subjectId));
    toast.success(`Removed ${memberLabel(removed)} from ${workspaceName}`);
    setRemoveTarget(null);
    return true;
  }

  async function approveSlackAccess(
    request: SlackUserLinkAccessRequest,
    role: WorkspaceAccessLevel,
  ) {
    const level = workspaceAccessLevels.find((candidate) => candidate.role === role);
    if (!level) return;
    try {
      await client.approveSlackUserLinkAccessRequest(workspaceId, request.id, {
        expectedVersion: request.version,
        idempotencyKey: crypto.randomUUID(),
        role: level.role,
        permissions: [...level.permissions],
      });
    } catch (caught) {
      throw new Error(
        `Couldn't give access. ${caught instanceof Error ? caught.message : String(caught)}`,
        { cause: caught },
      );
    }
    await refresh();
    toast.success(`${requestName(request)} can now use ${workspaceName}`, {
      description: "Their Slack account is linked.",
    });
  }

  async function denySlackAccess(request: SlackUserLinkAccessRequest) {
    try {
      await client.denySlackUserLinkAccessRequest(workspaceId, request.id, {
        expectedVersion: request.version,
        idempotencyKey: crypto.randomUUID(),
      });
      setSlackAccessRequests((current) => current.filter((entry) => entry.id !== request.id));
      toast.success(`Declined ${requestName(request)}'s request`);
    } catch (caught) {
      toast.error("Couldn't decline the request", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
      throw caught;
    }
  }

  const organizationPeopleLink = (children: ReactNode) => (
    <Link
      to="/workspaces/$workspaceId/organization"
      params={{ workspaceId }}
      search={{ section: "people" }}
      className="rounded-sm font-medium text-brand underline-offset-2 hover:underline"
    >
      {children}
    </Link>
  );

  /* Pages in place of the list. */
  if (adding) {
    return (
      <AddPeoplePage
        workspaceName={workspaceName}
        organizationName={organizationName}
        candidates={
          memberCandidates?.map((candidate) => {
            const name = candidate.name?.trim() || candidate.email || "Organization member";
            const orgRole =
              candidate.organizationRole === "owner"
                ? "Organization owner"
                : candidate.organizationRole === "admin"
                  ? "Organization admin"
                  : null;
            return {
              id: candidate.organizationMembershipId,
              name,
              description: [candidate.email !== name ? candidate.email : null, orgRole]
                .filter(Boolean)
                .join(" · "),
              searchText: [candidate.name, candidate.email].filter(Boolean).join(" ").toLowerCase(),
            };
          }) ?? null
        }
        loadError={memberCandidatesError}
        onRetry={() => void loadMemberCandidates()}
        roles={ASSIGNABLE_WORKSPACE_ROLES as RoleOption<WorkspaceAccessLevel>[]}
        inviteLink={organizationPeopleLink("Invite people")}
        onSubmit={addMembers}
        onClose={() => setView(null)}
      />
    );
  }
  const customMember =
    view?.kind === "custom" && canManage
      ? members.find((member) => member.subjectId === view.subjectId)
      : undefined;
  if (customMember) {
    return (
      <CustomPermissionsPage
        member={customMember}
        workspaceName={workspaceName}
        onSave={(permissions) => saveCustomPermissions(customMember, permissions)}
        onClose={() => setView(null)}
      />
    );
  }

  const accessMembers = members.map((member) => toAccessMember(member, selfSubjectId));
  const bySubject = (entry: AccessMember<WorkspaceRoleId>) =>
    members.find((member) => member.subjectId === entry.id);
  const showRequests = canManage && slackAccessRequests.length > 0;

  return (
    <>
      {canAddPeople ? (
        <SettingsHeaderActions>
          <Button type="button" onClick={() => setView({ kind: "add" })}>
            <UserPlusIcon aria-hidden="true" />
            Add people
          </Button>
        </SettingsHeaderActions>
      ) : null}
      <SectionStack>
        {showRequests ? (
          <Section
            title="Requests"
            description="People who asked from Slack to use this workspace."
          >
            <RowList label="Access requests" variant="resource" flush>
              {slackAccessRequests.map((request) => (
                <ListRow
                  key={request.id}
                  leading={
                    <Avatar aria-hidden="true">
                      <AvatarFallback className="bg-surface-2 text-xs font-semibold text-fg-muted">
                        {initialsOf(requestName(request))}
                      </AvatarFallback>
                    </Avatar>
                  }
                  title={requestName(request)}
                  meta={[
                    "Asked from Slack",
                    <RelativeTime
                      key="expires"
                      date={request.expiresAt}
                      prefix="Expires"
                      inSentence
                    />,
                  ]}
                  control={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="pointer-coarse:h-11"
                      onClick={() => setReviewing(request)}
                    >
                      Review
                    </Button>
                  }
                />
              ))}
            </RowList>
          </Section>
        ) : null}
        {canManage && slackAccessRequestsError ? (
          <Notice
            tone="failed"
            title="Couldn't load access requests from Slack"
            action={
              <Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>
                Try again
              </Button>
            }
          >
            {slackAccessRequestsError.message}
          </Notice>
        ) : null}
        <Section
          title="People"
          description={
            singleUser ? (
              "This is a single-user install, so only you have access."
            ) : (
              <>
                People come from {organizationName}. To invite someone new, go to{" "}
                {organizationPeopleLink("Organization > People")}.
              </>
            )
          }
        >
          <AccessList
            label={`People with access to ${workspaceName}`}
            roles={WORKSPACE_ROLE_OPTIONS}
            members={accessMembers}
            loading={!membersLoaded}
            loadingRows={3}
            className={FLUSH_ACCESS_LIST}
            error={
              membersError
                ? {
                    message: `Couldn't load who has access to ${workspaceName}.`,
                    detail: membersError.message,
                    onRetry: () => void refresh(),
                  }
                : undefined
            }
            readOnlyReason={
              canManage ? undefined : "Only workspace admins can change who has access."
            }
            savingIds={savingIds}
            onRoleChange={(entry, role) => {
              const member = bySubject(entry);
              if (!member || !role || role === "owner") return;
              return changeMemberRole(member, role);
            }}
            onResetToRole={(entry) => {
              const member = bySubject(entry);
              if (!member || !entry.resetRole || entry.resetRole === "owner") return;
              return changeMemberRole(member, entry.resetRole);
            }}
            onCustomize={(entry) => setView({ kind: "custom", subjectId: entry.id })}
            onRemove={(entry) => setRemoveTarget(bySubject(entry) ?? null)}
            emptyMessage={
              canAddPeople ? (
                <>
                  Only you have access.{" "}
                  <button
                    type="button"
                    onClick={() => setView({ kind: "add" })}
                    className="rounded-sm font-medium text-brand underline-offset-2 hover:underline"
                  >
                    Add people from {organizationName}
                  </button>{" "}
                  to share this workspace.
                </>
              ) : (
                "Only you have access."
              )
            }
          />
        </Section>
      </SectionStack>

      <ReviewRequestDialog
        request={reviewing}
        workspaceName={workspaceName}
        onApprove={approveSlackAccess}
        onDecline={denySlackAccess}
        onOpenChange={(open) => (open ? null : setReviewing(null))}
      />

      <DestructiveConfirm
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title={
          removeTarget
            ? `Remove ${memberLabel(removeTarget)} from ${workspaceName}?`
            : "Remove from workspace?"
        }
        consequences={[
          `They lose access to ${workspaceName} right away.`,
          "Private sessions they started here are stopped.",
          `They stay in ${organizationName}. You can add them again later.`,
        ]}
        confirmLabel="Remove from workspace"
        pendingLabel="Removing…"
        onConfirm={removeMember}
      />
    </>
  );
}

/** The role label a member row reads. */
export function workspaceRoleLabel(member: Pick<WorkspaceMember, "role" | "permissions">): string {
  return roleLabel(WORKSPACE_ROLE_OPTIONS, workspaceRoleOf(member).role);
}

/** What went wrong and what to do, without API codes or references. */
function loadErrorText(error: Error): string {
  const status = (error as { status?: unknown }).status;
  if (status === 403) {
    return "You don't have permission to add people here. A workspace admin can add them.";
  }
  return "Check your connection and try again.";
}
