// Workspace settings: workspace name/rename, "People with access" (workspace
// members on the workspace_memberships model), the workspace-scoped API keys
// (moved here out of the old account page), a link to Environments, and a
// danger zone with workspace deletion. The org/billing console lives at
// Organization settings.
import { Link, useNavigate } from "@tanstack/react-router";
import {
  BoxIcon,
  BrainCircuitIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  KeyRoundIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  SettingsIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { CodexSubscriptionsCard } from "@/components/codex-connection";
import { LoadErrorState, PageHeader } from "@/components/common";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/context";
import { orgLabel } from "@/lib/org";
import { cn } from "@/lib/utils";
import {
  apiKeyPermissionGroups,
  defaultApiKeyPermissions,
  defaultWorkspaceMemberPermissions,
  delegableApiKeyPermissions,
  hasWorkspacePermission,
  workspaceMemberPermissionGroups,
} from "@/lib/permissions";
import type { ApiKey, WorkspaceMember } from "@/types";

export function WorkspaceSettingsRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const client = context.client;
  const navigate = useNavigate();
  const activeWorkspace = context.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const accountId = activeWorkspace?.accountId ?? "";
  const organizationLabel = accountId ? orgLabel(accountId, context.accessContext.accountGrants) : "Organization";

  const [nameDraft, setNameDraft] = useState(activeWorkspace?.name ?? "");
  const [renaming, setRenaming] = useState(false);
  const canRename = activeWorkspace !== null && hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin");

  const canManageMembers = hasWorkspacePermission(context.accessContext, workspaceId, "members:manage");
  const canDeleteWorkspace = hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin");
  // Deleting the account's only workspace is refused server-side; disable the
  // affordance when this is the only workspace in the active account.
  const isOnlyWorkspaceInAccount = context.workspaces.filter((workspace) => workspace.accountId === accountId).length <= 1;

  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [apiKeysError, setApiKeysError] = useState<Error | null>(null);
  const [apiKeysLoaded, setApiKeysLoaded] = useState(false);
  const [apiKeyName, setApiKeyName] = useState("Default API key");
  const [selectedPermissions, setSelectedPermissions] = useState<Set<string>>(() => new Set(defaultApiKeyPermissions));
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [revokingKey, setRevokingKey] = useState<ApiKey | null>(null);
  const [busy, setBusy] = useState(false);
  const canManageApiKeys = hasWorkspacePermission(context.accessContext, workspaceId, "api_keys:manage");
  const workspaceGrant = context.accessContext.workspaceGrants.find((grant) => grant.workspaceId === workspaceId) ?? null;
  const delegablePermissions = delegableApiKeyPermissions(workspaceGrant?.permissions ?? []);
  const requestedPermissions = [...selectedPermissions].filter((permission) => delegablePermissions.has(permission));

  useEffect(() => {
    setNameDraft(activeWorkspace?.name ?? "");
  }, [activeWorkspace?.id, activeWorkspace?.name]);

  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    void refreshApiKeys();
  }, [workspaceId]);

  async function refreshApiKeys() {
    if (!canManageApiKeys) {
      setApiKeys([]);
      setApiKeysError(null);
      setApiKeysLoaded(true);
      return;
    }
    try {
      setApiKeys(await client.listApiKeys(workspaceId));
      setApiKeysError(null);
    } catch (error) {
      setApiKeys([]);
      setApiKeysError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setApiKeysLoaded(true);
    }
  }

  async function submitRename() {
    const name = nameDraft.trim();
    if (!name || name === activeWorkspace?.name) {
      return;
    }
    setRenaming(true);
    try {
      const renamed = await context.renameWorkspace(workspaceId, name);
      if (renamed) {
        toast.success("Workspace renamed");
      }
    } finally {
      setRenaming(false);
    }
  }

  async function createKey() {
    if (!apiKeyName.trim() || requestedPermissions.length === 0) {
      toast.error("API key name and permissions are required");
      return;
    }
    setBusy(true);
    try {
      const result = await client.createApiKey(workspaceId, {
        name: apiKeyName.trim(),
        permissions: requestedPermissions,
      });
      setCreatedToken(result.token);
      setApiKeys((current) => [result.apiKey, ...current]);
      toast.success("API key created");
    } catch (error) {
      toast.error("Failed to create API key", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function copyToken(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      toast.success("Token copied");
    } catch {
      toast.error("Couldn't copy the token", { description: "Copy it manually instead." });
    }
  }

  async function revokeKey(apiKeyId: string) {
    setBusy(true);
    try {
      const revoked = await client.deleteApiKey(workspaceId, apiKeyId);
      setApiKeys((current) => current.map((key) => key.id === revoked.id ? revoked : key));
      toast.success("API key revoked");
      return true;
    } catch (error) {
      toast.error("Failed to revoke API key", { description: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  function togglePermission(permission: string) {
    setSelectedPermissions((current) => {
      const next = new Set(current);
      if (next.has(permission)) {
        next.delete(permission);
      } else {
        next.add(permission);
      }
      return next;
    });
  }

  async function deleteWorkspace(): Promise<boolean> {
    // Pick where to land BEFORE the cache drops this workspace.
    const remaining = context.workspaces.filter((workspace) => workspace.id !== workspaceId);
    const next = remaining.find((workspace) => workspace.accountId === accountId) ?? remaining[0] ?? null;
    const deleted = await context.deleteWorkspace(workspaceId);
    if (!deleted) {
      return false;
    }
    context.resetSessionView();
    if (next) {
      await navigate({ to: "/workspaces/$workspaceId/sessions", params: { workspaceId: next.id }, replace: true });
    } else {
      await navigate({ to: "/", replace: true });
    }
    return true;
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col overflow-y-auto px-4 py-5 sm:px-6 lg:px-8">
      <section className="grid gap-5 text-left">
        <PageHeader
          icon={<SettingsIcon className="size-4" />}
          title="Workspace settings"
          description={activeWorkspace ? `${activeWorkspace.name} · ${organizationLabel}` : organizationLabel}
        />

        {/* Workspace name / rename */}
        <section className="grid gap-3 rounded-lg border border-border bg-surface p-4">
          <div>
            <h2 className="flex items-center gap-1.5 text-sm font-medium">
              <PencilIcon className="size-3.5 text-brand" />
              Workspace name
            </h2>
            <p className="mt-1 text-xs text-fg-muted">The name shows everywhere this workspace appears.</p>
          </div>
          {canRename ? (
            <form
              className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"
              onSubmit={(event) => {
                event.preventDefault();
                void submitRename();
              }}
            >
              <Input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} className="h-9" placeholder="production" />
              <Button type="submit" disabled={renaming || !nameDraft.trim() || nameDraft.trim() === activeWorkspace?.name}>
                {renaming ? <Loader2Icon className="size-3.5 animate-spin" /> : <CheckIcon className="size-3.5" />}
                Save
              </Button>
            </form>
          ) : (
            <p className="text-xs text-fg-subtle">Only workspace admins can rename this workspace.</p>
          )}
        </section>

        {/* People with access (workspace members) */}
        <MembersSection workspaceId={workspaceId} canManage={canManageMembers} />

        {/* Environments link */}
        <section className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface p-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-1.5 text-sm font-medium">
              <BoxIcon className="size-3.5 text-brand" />
              Environments
            </h2>
            <p className="mt-1 text-xs text-fg-muted">Variable sets injected into sandboxes at session start.</p>
          </div>
          <Button asChild type="button" variant="secondary" size="sm">
            <Link to="/workspaces/$workspaceId/environments" params={{ workspaceId }}>
              Manage environments
            </Link>
          </Button>
        </section>

        {/* Workspace memory (long-lived agent memory) */}
        <MemorySettingsSection workspaceId={workspaceId} canManage={canRename} />

        {/* Codex (ChatGPT) subscriptions (multi-account) */}
        <CodexSubscriptionsCard workspaceId={workspaceId} canManage={canDeleteWorkspace} />

        {/* API keys (moved from the old account page) */}
        <section className="grid gap-3 rounded-lg border border-border bg-surface p-4">
          <div>
            <h2 className="flex items-center gap-1.5 text-sm font-medium">
              <KeyRoundIcon className="size-3.5 text-brand" />
              API keys
            </h2>
            <p className="mt-1 text-xs text-fg-muted">Workspace-scoped keys for calling OpenGeni from another product.</p>
          </div>
          {createdToken ? (
            <Notice tone="success" title="Copy this token now — it won't be shown again.">
              <div className="mt-2 flex min-w-0 items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-bg px-2 py-1.5 text-xs text-fg">{createdToken}</code>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Copy token"
                  onClick={() => void copyToken(createdToken)}
                >
                  <CopyIcon className="size-3.5" />
                </Button>
              </div>
            </Notice>
          ) : null}
          {canManageApiKeys ? (
            <>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <Input value={apiKeyName} onChange={(event) => setApiKeyName(event.target.value)} className="h-9" />
                <Button type="button" disabled={busy} onClick={() => void createKey()}>
                  {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlusIcon className="size-3.5" />}
                  Create
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-fg-subtle">A key can only carry permissions your own grant can delegate.</p>
                <Button type="button" variant="ghost" size="sm" disabled={delegablePermissions.size === 0} onClick={() => setSelectedPermissions(new Set(delegablePermissions))}>
                  Select all delegable
                </Button>
              </div>
              <PermissionGroupPicker
                groups={apiKeyPermissionGroups}
                selected={selectedPermissions}
                delegable={delegablePermissions}
                onToggle={togglePermission}
              />
            </>
          ) : (
            <p className="text-xs text-fg-subtle">You don't have permission to manage API keys here.</p>
          )}
          <div className="grid gap-2">
            {apiKeysError ? (
              <LoadErrorState title="Couldn't load API keys" error={apiKeysError} onRetry={() => void refreshApiKeys()} />
            ) : !apiKeysLoaded ? (
              <>
                {[0, 1].map((key) => (
                  <div key={key} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg/35 px-3 py-2">
                    <div className="min-w-0 space-y-1.5">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                    <Skeleton className="h-8 w-20 rounded-md" />
                  </div>
                ))}
              </>
            ) : apiKeys.length === 0 ? (
              <EmptyState
                title="No API keys yet"
                description={canManageApiKeys ? "Create one above to call OpenGeni from another product." : "Keys created here call OpenGeni from another product."}
              />
            ) : apiKeys.map((apiKey) => (
              <div key={apiKey.id} className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-bg/35 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{apiKey.name}</div>
                  <div className="mt-1 truncate text-xs text-fg-subtle">{apiKey.prefix}… · {apiKey.revokedAt ? "revoked" : "active"}</div>
                </div>
                <Button type="button" variant="ghost" size="sm" disabled={busy || Boolean(apiKey.revokedAt)} onClick={() => setRevokingKey(apiKey)}>
                  <Trash2Icon className="size-3.5" />
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        </section>

        <ConfirmDialog
          open={revokingKey !== null}
          onOpenChange={(next) => setRevokingKey(next ? revokingKey : null)}
          title={`Revoke API key “${revokingKey?.name ?? ""}”?`}
          description={`Any product calling OpenGeni with ${revokingKey?.prefix ?? ""}… stops working immediately. This can't be undone.`}
          confirmLabel="Revoke key"
          onConfirm={() => (revokingKey ? revokeKey(revokingKey.id) : false)}
        />

        {/* Danger zone */}
        <DangerZone
          workspaceName={activeWorkspace?.name ?? ""}
          canDelete={canDeleteWorkspace}
          isOnlyWorkspaceInAccount={isOnlyWorkspaceInAccount}
          onDelete={deleteWorkspace}
        />
      </section>
    </div>
  );
}

/** "People with access": the workspace's USER members, with add/edit/remove. */
function MembersSection({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const context = useAppContext();
  const client = context.client;
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editPermissions, setEditPermissions] = useState<Set<string>>(() => new Set());
  const [removingMember, setRemovingMember] = useState<WorkspaceMember | null>(null);
  const callerSubjectId = context.accessContext.subjectId;

  // Only USER subjects are people; api_key subjects belong to the API keys
  // section above and are excluded here.
  const userMembers = members.filter((member) => member.subjectId.startsWith("user:"));

  useEffect(() => {
    void refresh();
  }, [workspaceId]);

  async function refresh() {
    try {
      setMembers(await client.listWorkspaceMembers(workspaceId));
      setError(null);
    } catch (caught) {
      setMembers([]);
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      setLoaded(true);
    }
  }

  async function addMember() {
    const trimmed = email.trim();
    if (!trimmed) {
      toast.error("Enter an email address");
      return;
    }
    setBusy(true);
    try {
      const member = await client.addWorkspaceMember(workspaceId, {
        email: trimmed,
        permissions: [...defaultWorkspaceMemberPermissions],
      });
      setMembers((current) => [...current.filter((existing) => existing.subjectId !== member.subjectId), member]);
      setEmail("");
      toast.success("Member added");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      // The API returns 404 "user is not registered" — email invites for
      // not-yet-registered users are deferred. Surface that as a friendly hint.
      if (message.includes("not registered")) {
        toast.error("No account for that email", { description: "Email invites are coming soon. Ask them to sign up first, then add them." });
      } else {
        toast.error("Failed to add member", { description: message });
      }
    } finally {
      setBusy(false);
    }
  }

  function startEditing(member: WorkspaceMember) {
    setEditing(member.subjectId);
    setEditPermissions(new Set(member.permissions));
  }

  function toggleEditPermission(permission: string) {
    setEditPermissions((current) => {
      const next = new Set(current);
      if (next.has(permission)) {
        next.delete(permission);
      } else {
        next.add(permission);
      }
      return next;
    });
  }

  async function saveEditing(member: WorkspaceMember) {
    setBusy(true);
    try {
      const updated = await client.updateWorkspaceMember(workspaceId, member.subjectId, {
        permissions: [...editPermissions],
      });
      setMembers((current) => current.map((existing) => existing.subjectId === updated.subjectId ? updated : existing));
      setEditing(null);
      toast.success("Permissions updated");
    } catch (caught) {
      toast.error("Failed to update member", { description: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(member: WorkspaceMember) {
    setBusy(true);
    try {
      await client.removeWorkspaceMember(workspaceId, member.subjectId);
      setMembers((current) => current.filter((existing) => existing.subjectId !== member.subjectId));
      toast.success("Member removed");
      return true;
    } catch (caught) {
      toast.error("Failed to remove member", { description: caught instanceof Error ? caught.message : String(caught) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-3 rounded-lg border border-border bg-surface p-4">
      <div>
        <h2 className="flex items-center gap-1.5 text-sm font-medium">
          <UsersIcon className="size-3.5 text-brand" />
          People with access
        </h2>
        <p className="mt-1 text-xs text-fg-muted">People who can act in this workspace, and what each one can do.</p>
      </div>

      {canManage ? (
        <form
          className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            void addMember();
          }}
        >
          <Input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="h-9"
            placeholder="teammate@example.com"
            aria-label="Add member by email"
          />
          <Button type="submit" disabled={busy || !email.trim()}>
            {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <UserPlusIcon className="size-3.5" />}
            Add member
          </Button>
        </form>
      ) : (
        <p className="text-xs text-fg-subtle">Only members who can manage people can add or remove access.</p>
      )}

      <div className="grid gap-2">
        {error ? (
          <LoadErrorState title="Couldn't load members" error={error} onRetry={() => void refresh()} />
        ) : !loaded ? (
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <Loader2Icon className="size-3.5 animate-spin" />
            Loading members
          </div>
        ) : userMembers.length === 0 ? (
          <EmptyState
            title="Only you have access"
            description={canManage ? "Add a teammate by email above to share this workspace." : undefined}
          />
        ) : userMembers.map((member) => (
          <div key={member.subjectId} className="grid gap-2 rounded-lg border border-border bg-bg/35 px-3 py-2">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {member.subjectLabel ?? member.subjectId}
                  {member.subjectId === callerSubjectId ? <span className="ml-1.5 text-fg-subtle">(you)</span> : null}
                </div>
                <div className="mt-1 truncate text-xs text-fg-subtle">
                  {member.role} · {member.permissions.length} permission{member.permissions.length === 1 ? "" : "s"}
                </div>
              </div>
              {canManage ? (
                <div className="flex shrink-0 items-center gap-1">
                  <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => editing === member.subjectId ? setEditing(null) : startEditing(member)}>
                    <ChevronDownIcon className={`size-3.5 transition-transform ${editing === member.subjectId ? "rotate-180" : ""}`} />
                    Edit
                  </Button>
                  <Button type="button" variant="ghost" size="sm" disabled={busy || member.subjectId === callerSubjectId} onClick={() => setRemovingMember(member)}>
                    <Trash2Icon className="size-3.5" />
                    Remove
                  </Button>
                </div>
              ) : null}
            </div>
            {canManage && editing === member.subjectId ? (
              <div className="grid gap-3 border-t border-border pt-3">
                <PermissionGroupPicker
                  groups={workspaceMemberPermissionGroups}
                  selected={editPermissions}
                  onToggle={toggleEditPermission}
                />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button>
                  <Button type="button" size="sm" disabled={busy} onClick={() => void saveEditing(member)}>
                    {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <CheckIcon className="size-3.5" />}
                    Save permissions
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={removingMember !== null}
        onOpenChange={(next) => setRemovingMember(next ? removingMember : null)}
        title={`Remove ${removingMember?.subjectLabel ?? removingMember?.subjectId ?? ""} from this workspace?`}
        description="They lose access to this workspace immediately. You can add them again later."
        confirmLabel="Remove access"
        onConfirm={() => (removingMember ? removeMember(removingMember) : false)}
      />
    </section>
  );
}

/** Workspace memory: a per-workspace toggle for the long-lived agent memory. */
function MemorySettingsSection({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const context = useAppContext();
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const enabled = workspace?.settings?.memoryEnabled === true;
  const [saving, setSaving] = useState(false);

  async function toggle(next: boolean) {
    setSaving(true);
    try {
      const updated = await context.updateWorkspaceSettings(workspaceId, { memoryEnabled: next });
      if (updated) {
        toast.success(next ? "Workspace memory enabled" : "Workspace memory disabled");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="grid gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <BrainCircuitIcon className="size-3.5 text-brand" />
            Workspace memory
          </h2>
          <p className="mt-1 text-xs text-fg-muted">
            Lets agents remember durable facts — preferences, environment details, decisions — across sessions in this
            workspace. Everything saved is visible and editable on the Documents page.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          {saving ? <Loader2Icon className="size-3.5 animate-spin text-fg-subtle" /> : null}
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Workspace memory"
            disabled={saving || !canManage}
            onClick={() => void toggle(!enabled)}
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              enabled ? "border-brand bg-brand" : "border-border bg-surface-2",
            )}
          >
            <span
              className={cn(
                "inline-block size-3.5 rounded-full bg-white shadow-sm transition-transform",
                enabled ? "translate-x-4" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
      </div>
      {!canManage ? (
        <p className="text-xs text-fg-subtle">Only workspace admins can change this.</p>
      ) : null}
    </section>
  );
}

/** Danger zone: delete the workspace behind a typed-name confirmation. */
function DangerZone(props: {
  workspaceName: string;
  canDelete: boolean;
  isOnlyWorkspaceInAccount: boolean;
  onDelete: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  const nameMatches = confirmName.trim() === props.workspaceName.trim() && props.workspaceName.trim().length > 0;

  const disabledReason = !props.canDelete
    ? "Only workspace admins can delete this workspace."
    : props.isOnlyWorkspaceInAccount
      ? "You can't delete an organization's only workspace."
      : null;

  async function confirmDelete() {
    if (!nameMatches) {
      return;
    }
    setBusy(true);
    // onDelete (context.deleteWorkspace) surfaces its own error toast; on
    // success it navigates away, unmounting this dialog.
    const ok = await props.onDelete();
    if (ok) {
      toast.success("Workspace deleted");
    } else {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-3 rounded-lg border border-status-failed/30 bg-status-failed/5 p-4">
      <div>
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-status-failed">
          <TriangleAlertIcon className="size-3.5" />
          Danger zone
        </h2>
        <p className="mt-1 text-xs text-fg-muted">
          Workspace deletion is irreversible and removes every session, environment, and API key.
        </p>
      </div>
      <div>
        <span title={disabledReason ?? undefined} className="inline-block">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={Boolean(disabledReason)}
            onClick={() => {
              setConfirmName("");
              setOpen(true);
            }}
          >
            <Trash2Icon className="size-3.5" />
            Delete workspace
          </Button>
        </span>
        {disabledReason ? (
          <p className="mt-1.5 text-2xs text-fg-subtle">{disabledReason}</p>
        ) : (
          <p className="mt-1.5 text-2xs text-fg-subtle">Stop any running sessions first; deletion is refused while one is live.</p>
        )}
      </div>

      <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
        <DialogContent className="sm:max-w-sm">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void confirmDelete();
            }}
          >
            <DialogHeader>
              <DialogTitle>Delete workspace</DialogTitle>
              <DialogDescription>
                This permanently removes the workspace and everything in it. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 grid gap-1.5">
              <Label htmlFor="confirm-workspace-name">
                Type <span className="font-mono text-fg">{props.workspaceName}</span> to confirm
              </Label>
              <Input
                id="confirm-workspace-name"
                value={confirmName}
                onChange={(event) => setConfirmName(event.target.value)}
                placeholder={props.workspaceName}
                autoFocus
                autoComplete="off"
              />
            </div>
            <DialogFooter className="mt-4">
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" variant="destructive" disabled={busy || !nameMatches}>
                {busy ? <Loader2Icon className="size-4 animate-spin" /> : <Trash2Icon className="size-4" />}
                Delete workspace
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
