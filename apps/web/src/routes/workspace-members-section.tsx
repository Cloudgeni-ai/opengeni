import { Loader2Icon, PlusIcon, SearchIcon, SlidersHorizontalIcon, UsersIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

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
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/context";
import {
  defaultWorkspaceMemberPermissions,
  workspaceAccessLevels,
  workspaceMemberPermissionGroups,
  type WorkspaceAccessLevel,
} from "@/lib/permissions";
import type {
  SlackUserLinkAccessRequest,
  WorkspaceMember,
  WorkspaceMemberCandidate,
} from "@/types";

/** Organization-owned access entry point plus the separate Slack-link approval queue. */
export function MembersSection(props: { workspaceId: string; canManage: boolean }) {
  return <MembersSectionContent key={props.workspaceId} {...props} />;
}

function MembersSectionContent({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const context = useAppContext();
  const client = context.client;
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [membersLoaded, setMembersLoaded] = useState(false);
  const [membersError, setMembersError] = useState<Error | null>(null);
  const [slackAccessRequests, setSlackAccessRequests] = useState<SlackUserLinkAccessRequest[]>([]);
  const [slackAccessRequestsError, setSlackAccessRequestsError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [memberCandidates, setMemberCandidates] = useState<WorkspaceMemberCandidate[]>([]);
  const [memberCandidatesLoaded, setMemberCandidatesLoaded] = useState(false);
  const [memberCandidatesError, setMemberCandidatesError] = useState<Error | null>(null);
  const [memberSearch, setMemberSearch] = useState("");
  const [selectedOrganizationMembershipId, setSelectedOrganizationMembershipId] = useState("");
  const [memberRole, setMemberRole] = useState<WorkspaceAccessLevel>("member");
  const [customEditor, setCustomEditor] = useState<{
    member: WorkspaceMember;
    permissions: Set<string>;
  } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<WorkspaceMember | null>(null);
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
      setMembers(memberResult.value.filter((member) => member.subjectId.startsWith("user:")));
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
    setMemberCandidatesLoaded(false);
    setMemberCandidatesError(null);
    try {
      const candidates = await client.listWorkspaceMemberCandidates(workspaceId);
      if (candidateRefreshGenerationRef.current !== generation) return;
      setMemberCandidates(candidates);
    } catch (caught) {
      if (candidateRefreshGenerationRef.current !== generation) return;
      setMemberCandidates([]);
      setMemberCandidatesError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      if (candidateRefreshGenerationRef.current === generation) {
        setMemberCandidatesLoaded(true);
      }
    }
  }, [client, workspaceId]);

  useEffect(
    () => () => {
      candidateRefreshGenerationRef.current += 1;
    },
    [],
  );

  function resetAddMemberDialog() {
    candidateRefreshGenerationRef.current += 1;
    setMemberCandidates([]);
    setMemberCandidatesLoaded(false);
    setMemberCandidatesError(null);
    setMemberSearch("");
    setSelectedOrganizationMembershipId("");
    setMemberRole("member");
  }

  function openAddMemberDialog() {
    setAddMemberOpen(true);
    void loadMemberCandidates();
  }

  const normalizedMemberSearch = memberSearch.trim().toLowerCase();
  const visibleMemberCandidates = memberCandidates.filter((candidate) => {
    if (!normalizedMemberSearch) return true;
    return [candidate.name, candidate.email]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(normalizedMemberSearch));
  });

  const candidateLabel = (candidate: WorkspaceMemberCandidate) =>
    candidate.name?.trim() || candidate.email || "Organization member";

  const memberLabel = (member: WorkspaceMember) =>
    member.subjectLabel?.trim() || member.subjectId.replace(/^user:/, "");

  async function addMember() {
    const level = workspaceAccessLevels.find((candidate) => candidate.role === memberRole);
    const candidate = memberCandidates.find(
      (entry) => entry.organizationMembershipId === selectedOrganizationMembershipId,
    );
    if (!candidate || !level) return;
    setBusy(true);
    try {
      await client.addWorkspaceMember(workspaceId, {
        organizationMembershipId: candidate.organizationMembershipId,
        role: level.role,
        permissions: [...level.permissions],
      });
      setAddMemberOpen(false);
      resetAddMemberDialog();
      await refresh();
      toast.success(`${candidateLabel(candidate)} added to the workspace`);
    } catch (caught) {
      toast.error("Could not add this person", {
        description:
          caught instanceof Error
            ? caught.message
            : "They must already be an active member of this organization.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function changeMemberRole(member: WorkspaceMember, role: WorkspaceAccessLevel) {
    const level = workspaceAccessLevels.find((candidate) => candidate.role === role);
    if (!level) return;
    setBusy(true);
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
      toast.success(`${memberLabel(member)} is now ${level.label.toLowerCase()}`);
    } catch (caught) {
      toast.error("Could not update workspace access", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setBusy(false);
    }
  }

  async function saveCustomPermissions() {
    if (!customEditor) return;
    setBusy(true);
    try {
      const permissions = new Set(customEditor.permissions);
      permissions.add("workspace:read");
      const updated = await client.updateWorkspaceMember(
        workspaceId,
        customEditor.member.subjectId,
        { role: "custom", permissions: [...permissions] },
      );
      setMembers((current) =>
        current.map((candidate) =>
          candidate.subjectId === updated.subjectId ? updated : candidate,
        ),
      );
      setCustomEditor(null);
      toast.success("Custom workspace access saved");
    } catch (caught) {
      toast.error("Could not save custom access", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setBusy(false);
    }
  }

  async function removeMember() {
    if (!removeTarget) return false;
    try {
      await client.removeWorkspaceMember(workspaceId, removeTarget.subjectId);
      setMembers((current) =>
        current.filter((member) => member.subjectId !== removeTarget.subjectId),
      );
      toast.success("Workspace access removed");
      setRemoveTarget(null);
    } catch (caught) {
      toast.error("Could not remove workspace access", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
      return false;
    }
  }

  async function approveSlackAccess(request: SlackUserLinkAccessRequest) {
    setBusy(true);
    try {
      await client.approveSlackUserLinkAccessRequest(workspaceId, request.id, {
        expectedVersion: request.version,
        idempotencyKey: crypto.randomUUID(),
        role: "member",
        permissions: [...defaultWorkspaceMemberPermissions],
      });
      await refresh();
      toast.success("Access approved and Slack identity linked");
    } catch (caught) {
      toast.error("Failed to approve access", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setBusy(false);
    }
  }

  async function denySlackAccess(request: SlackUserLinkAccessRequest) {
    setBusy(true);
    try {
      await client.denySlackUserLinkAccessRequest(workspaceId, request.id, {
        expectedVersion: request.version,
        idempotencyKey: crypto.randomUUID(),
      });
      setSlackAccessRequests((current) => current.filter((entry) => entry.id !== request.id));
      toast.success("Access request denied");
    } catch (caught) {
      toast.error("Failed to deny access", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="flex items-center gap-1.5 text-sm font-medium">
          <UsersIcon className="size-3.5 text-brand" />
          People with access
        </h2>
        {canManage ? (
          <Button type="button" size="sm" onClick={openAddMemberDialog}>
            <PlusIcon className="size-3.5" />
            Add member
          </Button>
        ) : null}
      </div>

      {!membersLoaded ? (
        <div className="grid gap-2">
          <Skeleton className="h-16 rounded-lg" />
          <Skeleton className="h-16 rounded-lg" />
        </div>
      ) : null}

      {membersLoaded && members.length === 0 && !membersError ? (
        <EmptyState
          icon={<UsersIcon className="size-4" />}
          title="No members yet"
          description="Add someone to start collaborating in this workspace."
        />
      ) : null}

      {members.length > 0 ? (
        <div className="divide-y divide-border/70 rounded-lg border border-border bg-surface/40">
          {members.map((member) => {
            const label = memberLabel(member);
            const currentLevel = workspaceAccessLevels.find(
              (level) =>
                level.role === member.role &&
                new Set(level.permissions).size === new Set(member.permissions).size &&
                level.permissions.every((permission) => member.permissions.includes(permission)),
            );
            const roleValue = currentLevel?.role ?? "custom";
            const isSelf = member.subjectId === context.accessContext.subjectId;
            return (
              <div
                key={member.subjectId}
                className="grid gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,auto)_auto] sm:items-center"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-full border border-brand/25 bg-brand/10 text-xs font-semibold text-brand">
                    {label.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg">
                      {label}{" "}
                      {isSelf ? (
                        <span className="text-xs font-normal text-fg-subtle">(you)</span>
                      ) : null}
                    </p>
                    <p className="truncate text-xs text-fg-muted">
                      {roleValue === "custom"
                        ? "Custom access"
                        : workspaceAccessLevels.find((level) => level.role === roleValue)
                            ?.description}
                    </p>
                  </div>
                </div>
                {canManage && !isSelf ? (
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Select
                      aria-label={`Workspace access for ${label}`}
                      value={roleValue}
                      disabled={busy}
                      onChange={(event) =>
                        void changeMemberRole(member, event.target.value as WorkspaceAccessLevel)
                      }
                    >
                      {roleValue === "custom" ? (
                        <option value="custom" disabled>
                          Custom access
                        </option>
                      ) : null}
                      {workspaceAccessLevels.map((level) => (
                        <option key={level.role} value={level.role}>
                          {level.label}
                        </option>
                      ))}
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        setCustomEditor({
                          member,
                          permissions: new Set(member.permissions),
                        })
                      }
                    >
                      <SlidersHorizontalIcon className="size-3.5" />
                      Fine-tune
                    </Button>
                  </div>
                ) : (
                  <span className="text-sm text-fg-muted">
                    {roleValue === "custom"
                      ? "Custom access"
                      : workspaceAccessLevels.find((level) => level.role === roleValue)?.label}
                  </span>
                )}
                <div className="flex justify-end">
                  {canManage && !isSelf ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setRemoveTarget(member)}
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {membersError ? (
        <Notice
          title="Workspace members unavailable"
          action={
            <Button type="button" size="sm" variant="ghost" onClick={() => void refresh()}>
              Retry
            </Button>
          }
        >
          {membersError.message}
        </Notice>
      ) : null}

      {canManage && slackAccessRequests.length > 0 ? (
        <div className="grid gap-2 rounded-lg border border-border bg-surface-2/35 p-3">
          <div>
            <p className="text-xs font-medium text-fg">Pending Slack access requests</p>
            <p className="mt-0.5 text-2xs text-fg-subtle">
              Approval grants the standard member permissions and completes Slack identity linking.
            </p>
          </div>
          {slackAccessRequests.map((request) => (
            <div
              key={request.id}
              className="flex flex-col gap-2 rounded-md border border-border/70 bg-surface px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-fg">
                  {request.subjectLabel ?? "Signed-in OpenGeni user"}
                </p>
                <p className="text-2xs text-fg-subtle">
                  Expires {new Date(request.expiresAt).toLocaleString()}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => void approveSlackAccess(request)}
                >
                  Approve
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void denySlackAccess(request)}
                >
                  Deny
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {canManage && slackAccessRequestsError ? (
        <Notice
          title="Pending Slack access requests unavailable"
          action={
            <Button type="button" size="sm" variant="ghost" onClick={() => void refresh()}>
              Retry
            </Button>
          }
        >
          {slackAccessRequestsError.message}
        </Notice>
      ) : null}

      <Dialog
        open={addMemberOpen}
        onOpenChange={(open) => {
          if (busy) return;
          setAddMemberOpen(open);
          if (!open) {
            resetAddMemberDialog();
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add member</DialogTitle>
            <DialogDescription>Select a person and choose their access level.</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void addMember();
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="workspace-member-search">Organization members</Label>
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-fg-muted" />
                <Input
                  id="workspace-member-search"
                  type="search"
                  placeholder="Search by name or email"
                  value={memberSearch}
                  onChange={(event) => setMemberSearch(event.target.value)}
                  disabled={busy || !memberCandidatesLoaded}
                  className="pl-9"
                  autoFocus
                />
              </div>

              {!memberCandidatesLoaded ? (
                <div className="grid gap-2 rounded-lg border border-border p-2">
                  <Skeleton className="h-14 rounded-md" />
                  <Skeleton className="h-14 rounded-md" />
                </div>
              ) : null}

              {memberCandidatesLoaded && memberCandidatesError ? (
                <Notice
                  title="Organization members unavailable"
                  action={
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void loadMemberCandidates()}
                    >
                      Retry
                    </Button>
                  }
                >
                  {memberCandidatesError.message}
                </Notice>
              ) : null}

              {memberCandidatesLoaded && !memberCandidatesError && memberCandidates.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center">
                  <p className="text-sm font-medium text-fg">Everyone is already here</p>
                  <p className="mt-1 text-xs text-fg-muted">
                    All active organization members have access to this workspace.
                  </p>
                </div>
              ) : null}

              {memberCandidatesLoaded &&
              !memberCandidatesError &&
              memberCandidates.length > 0 &&
              visibleMemberCandidates.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-fg-muted">
                  No organization members match “{memberSearch.trim()}”.
                </div>
              ) : null}

              {visibleMemberCandidates.length > 0 ? (
                <div
                  role="listbox"
                  aria-label="Organization members"
                  className="max-h-64 overflow-y-auto rounded-lg border border-border bg-surface/40 p-1.5"
                >
                  {visibleMemberCandidates.map((candidate) => {
                    const selected =
                      candidate.organizationMembershipId === selectedOrganizationMembershipId;
                    const label = candidateLabel(candidate);
                    const roleLabel =
                      candidate.organizationRole === "owner"
                        ? "Owner"
                        : candidate.organizationRole === "admin"
                          ? "Administrator"
                          : "Member";
                    return (
                      <button
                        key={candidate.organizationMembershipId}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        disabled={busy}
                        onClick={() =>
                          setSelectedOrganizationMembershipId(candidate.organizationMembershipId)
                        }
                        className={`flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 ${
                          selected
                            ? "border-brand/40 bg-brand/10"
                            : "border-transparent hover:border-border hover:bg-surface-raised"
                        }`}
                      >
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-brand/20 bg-brand/10 text-xs font-semibold text-brand">
                          {label.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-fg">
                            {label}
                          </span>
                          {candidate.email && candidate.email !== label ? (
                            <span className="block truncate text-xs text-fg-muted">
                              {candidate.email}
                            </span>
                          ) : null}
                        </span>
                        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-fg-muted">
                          {roleLabel}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="workspace-member-role">Access level</Label>
              <Select
                id="workspace-member-role"
                value={memberRole}
                disabled={busy}
                onChange={(event) => setMemberRole(event.target.value as WorkspaceAccessLevel)}
              >
                {workspaceAccessLevels.map((level) => (
                  <option key={level.role} value={level.role}>
                    {level.label}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-fg-muted">
                {workspaceAccessLevels.find((level) => level.role === memberRole)?.description}
              </p>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setAddMemberOpen(false);
                  resetAddMemberDialog();
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  busy || !selectedOrganizationMembershipId || Boolean(memberCandidatesError)
                }
              >
                {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                Add to workspace
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={customEditor !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setCustomEditor(null);
        }}
      >
        <DialogContent className="max-h-[88dvh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Fine-tune workspace access</DialogTitle>
            <DialogDescription>
              {customEditor
                ? `Choose exactly what ${memberLabel(customEditor.member)} can do in this workspace.`
                : "Choose individual workspace permissions."}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto px-1 pb-1">
            {customEditor ? (
              <PermissionGroupPicker
                groups={workspaceMemberPermissionGroups()}
                selected={customEditor.permissions}
                disabled={busy}
                onToggle={(permission) =>
                  setCustomEditor((current) => {
                    if (!current) return null;
                    const permissions = new Set(current.permissions);
                    if (permissions.has(permission)) permissions.delete(permission);
                    else permissions.add(permission);
                    return { ...current, permissions };
                  })
                }
                onSetGroup={(permissions, selected) =>
                  setCustomEditor((current) => {
                    if (!current) return null;
                    const next = new Set(current.permissions);
                    for (const permission of permissions) {
                      if (selected) next.add(permission);
                      else next.delete(permission);
                    }
                    return { ...current, permissions: next };
                  })
                }
              />
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setCustomEditor(null)}
            >
              Cancel
            </Button>
            <Button type="button" disabled={busy} onClick={() => void saveCustomPermissions()}>
              {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              Save custom access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title={
          removeTarget
            ? `Remove ${memberLabel(removeTarget)} from this workspace?`
            : "Remove workspace access?"
        }
        description="They will lose access to this workspace and any private sessions they started here will be stopped."
        confirmLabel="Remove access"
        onConfirm={removeMember}
      />
    </section>
  );
}
