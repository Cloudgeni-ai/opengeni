// Workspace settings hub: browse links to workspace config surfaces, then
// name/rename, members, API keys, memory/transcription/Codex policy, Codex
// subscriptions, and a danger zone with workspace deletion. The org/billing
// console lives at Organization settings.
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
  ShrinkIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { CodexSubscriptionsCard } from "@/components/codex-connection";
import { LoadErrorState } from "@/components/common";
import {
  WORKSPACE_BROWSE_ITEMS,
  type WorkspaceConfigItem,
} from "@/components/rail/workspace-nav-data";
import { PreferenceToggleRow, VoiceInputPreferenceRow } from "@/components/transcription-settings";
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
import { ContentPage } from "@/components/ui/content-layout";
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

function BrowseWorkspaceStrip(props: { workspaceId: string; canReadInsights: boolean }) {
  const items = WORKSPACE_BROWSE_ITEMS.filter(
    (item: WorkspaceConfigItem) => !item.requiresAdmin || props.canReadInsights,
  );
  // Leaf catalog only (workspace-nav-data). Do not import workspace-nav.tsx or
  // workspace-nav-icons — that Lucide map shares into the shell and blows the
  // initial bundle. Keep a single BoxIcon use so Rolldown's Lucide grouping
  // stays aligned with the previous Variable-sets card.
  return (
    <nav aria-label="Browse workspace" className="flex flex-wrap items-center gap-x-1 gap-y-1.5">
      <span className="mr-1 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
        Browse
      </span>
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          params={{ workspaceId: props.workspaceId }}
          title={item.description}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          {item.icon === "box" ? <BoxIcon className="size-3.5 shrink-0 text-brand" /> : null}
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

export function WorkspaceSettingsRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const client = context.client;
  const navigate = useNavigate();
  const activeWorkspace =
    context.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const accountId = activeWorkspace?.accountId ?? "";
  const organizationLabel = accountId
    ? orgLabel(accountId, context.accessContext.accountGrants)
    : "Organization";

  const [nameDraft, setNameDraft] = useState(activeWorkspace?.name ?? "");
  const [renaming, setRenaming] = useState(false);
  const canRename =
    activeWorkspace !== null &&
    hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin");

  const canManageMembers = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "members:manage",
  );
  const canDeleteWorkspace = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "workspace:admin",
  );
  // Deleting the account's only workspace is refused server-side; disable the
  // affordance when this is the only workspace in the active account.
  const isOnlyWorkspaceInAccount =
    context.workspaces.filter((workspace) => workspace.accountId === accountId).length <= 1;

  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [apiKeysError, setApiKeysError] = useState<Error | null>(null);
  const [apiKeysLoaded, setApiKeysLoaded] = useState(false);
  const [apiKeyName, setApiKeyName] = useState("Default API key");
  const [selectedPermissions, setSelectedPermissions] = useState<Set<string>>(
    () => new Set(defaultApiKeyPermissions),
  );
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [revokingKey, setRevokingKey] = useState<ApiKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [apiKeysOpen, setApiKeysOpen] = useState(false);
  const canManageApiKeys = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "api_keys:manage",
  );
  const workspaceGrant =
    context.accessContext.workspaceGrants.find((grant) => grant.workspaceId === workspaceId) ??
    null;
  const delegablePermissions = delegableApiKeyPermissions(workspaceGrant?.permissions ?? []);
  const requestedPermissions = [...selectedPermissions].filter((permission) =>
    delegablePermissions.has(permission),
  );

  useEffect(() => {
    setNameDraft(activeWorkspace?.name ?? "");
  }, [activeWorkspace?.id, activeWorkspace?.name]);

  const refreshApiKeys = useCallback(async () => {
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
  }, [canManageApiKeys, client, workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    void refreshApiKeys();
  }, [refreshApiKeys, workspaceId]);

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
      setApiKeysOpen(true);
      toast.success("API key created");
    } catch (error) {
      toast.error("Failed to create API key", {
        description: error instanceof Error ? error.message : String(error),
      });
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
      setApiKeys((current) => current.map((key) => (key.id === revoked.id ? revoked : key)));
      toast.success("API key revoked");
      return true;
    } catch (error) {
      toast.error("Failed to revoke API key", {
        description: error instanceof Error ? error.message : String(error),
      });
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
    const next =
      remaining.find((workspace) => workspace.accountId === accountId) ?? remaining[0] ?? null;
    const deleted = await context.deleteWorkspace(workspaceId);
    if (!deleted) {
      return false;
    }
    context.resetSessionView();
    if (next) {
      await navigate({
        to: "/workspaces/$workspaceId/sessions",
        params: { workspaceId: next.id },
        replace: true,
      });
    } else {
      await navigate({ to: "/", replace: true });
    }
    return true;
  }

  const activeApiKeyCount = apiKeys.filter((key) => !key.revokedAt).length;

  async function finishRename() {
    const name = nameDraft.trim();
    if (!name || name === activeWorkspace?.name) {
      setNameDraft(activeWorkspace?.name ?? "");
      setEditingName(false);
      return;
    }
    await submitRename();
    setEditingName(false);
  }

  return (
    <ContentPage width="standard">
      <section className="grid gap-6 text-left">
        <header className="grid gap-3 border-b border-border pb-4">
          <div className="flex min-w-0 items-center gap-2 text-sm text-fg-muted">
            <SettingsIcon className="size-4 shrink-0 text-brand" />
            <span>Workspace</span>
            <span className="text-fg-subtle">·</span>
            <span className="truncate">{organizationLabel}</span>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            {editingName && canRename ? (
              <form
                className="flex min-w-0 flex-1 items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void finishRename();
                }}
              >
                <Input
                  autoFocus
                  value={nameDraft}
                  onChange={(event) => setNameDraft(event.target.value)}
                  onBlur={() => void finishRename()}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setNameDraft(activeWorkspace?.name ?? "");
                      setEditingName(false);
                    }
                  }}
                  className="h-9 max-w-md text-base font-semibold"
                  placeholder="Workspace name"
                  aria-label="Workspace name"
                />
                <Button
                  type="submit"
                  size="icon-sm"
                  variant="ghost"
                  disabled={renaming || !nameDraft.trim()}
                  aria-label="Save workspace name"
                >
                  {renaming ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <CheckIcon className="size-3.5" />
                  )}
                </Button>
              </form>
            ) : (
              <>
                <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">
                  {activeWorkspace?.name ?? "Workspace"}
                </h1>
                {canRename ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Rename workspace"
                    onClick={() => {
                      setNameDraft(activeWorkspace?.name ?? "");
                      setEditingName(true);
                    }}
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                ) : null}
              </>
            )}
          </div>
          <BrowseWorkspaceStrip workspaceId={workspaceId} canReadInsights={canDeleteWorkspace} />
        </header>

        <MembersSection workspaceId={workspaceId} canManage={canManageMembers} />

        <section aria-labelledby="workspace-preferences-heading" className="grid gap-1">
          <h2 id="workspace-preferences-heading" className="text-sm font-medium">
            Preferences
          </h2>
          <div className="divide-y divide-border/70 rounded-lg border border-border px-3">
            <MemoryPreferenceRow workspaceId={workspaceId} canManage={canRename} />
            <VoiceInputPreferenceRow workspaceId={workspaceId} canManage={canRename} />
            <CodexCompactionPreferenceRow workspaceId={workspaceId} canManage={canRename} />
          </div>
        </section>

        {/* Codex live overview is intentionally once-per-mount; remount at tenant boundary. */}
        <CodexSubscriptionsCard
          key={workspaceId}
          workspaceId={workspaceId}
          canManage={canDeleteWorkspace}
        />

        <details
          className="rounded-lg border border-border"
          open={apiKeysOpen || createdToken != null}
          onToggle={(event) => {
            const next = event.currentTarget.open;
            if (createdToken != null && !next) {
              event.currentTarget.open = true;
              return;
            }
            setApiKeysOpen(next);
          }}
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-2/60 [&::-webkit-details-marker]:hidden">
            <KeyRoundIcon className="size-3.5 shrink-0 text-brand" />
            <span className="min-w-0 flex-1 text-sm font-medium">API keys</span>
            <span className="text-2xs text-fg-subtle">
              {!apiKeysLoaded
                ? "…"
                : activeApiKeyCount === 0
                  ? "None"
                  : `${activeApiKeyCount} active`}
            </span>
            <ChevronDownIcon
              className={cn(
                "size-4 shrink-0 text-fg-subtle transition-transform",
                apiKeysOpen || createdToken != null ? "rotate-180" : "",
              )}
            />
          </summary>
          <div className="grid gap-3 border-t border-border px-3 py-3">
            <p className="text-2xs text-fg-subtle">
              Workspace-scoped keys for calling OpenGeni from another product.
            </p>
            {createdToken ? (
              <Notice tone="success" title="Copy this token now — it won't be shown again.">
                <div className="mt-2 flex min-w-0 items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-bg px-2 py-1.5 text-xs text-fg">
                    {createdToken}
                  </code>
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
                  <Input
                    value={apiKeyName}
                    onChange={(event) => setApiKeyName(event.target.value)}
                    className="h-9"
                  />
                  <Button type="button" disabled={busy} onClick={() => void createKey()}>
                    {busy ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : (
                      <PlusIcon className="size-3.5" />
                    )}
                    Create
                  </Button>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-fg-subtle">
                    A key can only carry permissions your own grant can delegate.
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={delegablePermissions.size === 0}
                    onClick={() => setSelectedPermissions(new Set(delegablePermissions))}
                  >
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
              <p className="text-xs text-fg-subtle">
                You don't have permission to manage API keys here.
              </p>
            )}
            <div className="divide-y divide-border/70 rounded-md border border-border/70">
              {apiKeysError ? (
                <div className="p-2">
                  <LoadErrorState
                    title="Couldn't load API keys"
                    error={apiKeysError}
                    onRetry={() => void refreshApiKeys()}
                  />
                </div>
              ) : !apiKeysLoaded ? (
                <>
                  {[0, 1].map((key) => (
                    <div key={key} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0 space-y-1.5">
                        <Skeleton className="h-4 w-32" />
                        <Skeleton className="h-3 w-24" />
                      </div>
                      <Skeleton className="h-8 w-20 rounded-md" />
                    </div>
                  ))}
                </>
              ) : apiKeys.length === 0 ? (
                <div className="p-2">
                  <EmptyState
                    title="No API keys yet"
                    description={
                      canManageApiKeys
                        ? "Create one above to call OpenGeni from another product."
                        : "Keys created here call OpenGeni from another product."
                    }
                  />
                </div>
              ) : (
                apiKeys.map((apiKey) => (
                  <div
                    key={apiKey.id}
                    className="flex min-w-0 items-center justify-between gap-3 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{apiKey.name}</div>
                      <div className="truncate text-2xs text-fg-subtle">
                        {apiKey.prefix}… · {apiKey.revokedAt ? "revoked" : "active"}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy || Boolean(apiKey.revokedAt)}
                      onClick={() => setRevokingKey(apiKey)}
                    >
                      <Trash2Icon className="size-3.5" />
                      Revoke
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
        </details>

        <ConfirmDialog
          open={revokingKey !== null}
          onOpenChange={(next) => setRevokingKey(next ? revokingKey : null)}
          title={`Revoke API key “${revokingKey?.name ?? ""}”?`}
          description={`Any product calling OpenGeni with ${revokingKey?.prefix ?? ""}… stops working immediately. This can't be undone.`}
          confirmLabel="Revoke key"
          onConfirm={() => (revokingKey ? revokeKey(revokingKey.id) : false)}
        />

        <DangerZone
          workspaceName={activeWorkspace?.name ?? ""}
          canDelete={canDeleteWorkspace}
          isOnlyWorkspaceInAccount={isOnlyWorkspaceInAccount}
          onDelete={deleteWorkspace}
        />
      </section>
    </ContentPage>
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

  const refresh = useCallback(async () => {
    try {
      setMembers(await client.listWorkspaceMembers(workspaceId));
      setError(null);
    } catch (caught) {
      setMembers([]);
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      setLoaded(true);
    }
  }, [client, workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      setMembers((current) => [
        ...current.filter((existing) => existing.subjectId !== member.subjectId),
        member,
      ]);
      setEmail("");
      toast.success("Member added");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      // The API returns 404 "user is not registered" — email invites for
      // not-yet-registered users are deferred. Surface that as a friendly hint.
      if (message.includes("not registered")) {
        toast.error("No account for that email", {
          description: "Email invites are coming soon. Ask them to sign up first, then add them.",
        });
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
      setMembers((current) =>
        current.map((existing) => (existing.subjectId === updated.subjectId ? updated : existing)),
      );
      setEditing(null);
      toast.success("Permissions updated");
    } catch (caught) {
      toast.error("Failed to update member", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(member: WorkspaceMember) {
    setBusy(true);
    try {
      await client.removeWorkspaceMember(workspaceId, member.subjectId);
      setMembers((current) =>
        current.filter((existing) => existing.subjectId !== member.subjectId),
      );
      toast.success("Member removed");
      return true;
    } catch (caught) {
      toast.error("Failed to remove member", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
      return false;
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
        <span className="text-2xs text-fg-subtle">
          {!loaded
            ? ""
            : userMembers.length === 0
              ? "just you"
              : `${userMembers.length} member${userMembers.length === 1 ? "" : "s"}`}
        </span>
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
            {busy ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <UserPlusIcon className="size-3.5" />
            )}
            Add
          </Button>
        </form>
      ) : null}

      {error ? (
        <LoadErrorState
          title="Couldn't load members"
          error={error}
          onRetry={() => void refresh()}
        />
      ) : !loaded ? (
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <Loader2Icon className="size-3.5 animate-spin" />
          Loading members
        </div>
      ) : userMembers.length === 0 ? (
        <p className="text-2xs text-fg-subtle">
          Only you right now
          {canManage ? " — add a teammate above." : "."}
        </p>
      ) : (
        <div className="divide-y divide-border/70 overflow-hidden rounded-lg border border-border">
          {userMembers.map((member) => (
            <div key={member.subjectId} className="grid gap-2 px-3 py-2">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {member.subjectLabel ?? member.subjectId}
                    {member.subjectId === callerSubjectId ? (
                      <span className="ml-1.5 text-fg-subtle">(you)</span>
                    ) : null}
                  </div>
                  <div className="truncate text-2xs text-fg-subtle">
                    {member.role} · {member.permissions.length} permission
                    {member.permissions.length === 1 ? "" : "s"}
                  </div>
                </div>
                {canManage ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        editing === member.subjectId ? setEditing(null) : startEditing(member)
                      }
                    >
                      <ChevronDownIcon
                        className={`size-3.5 transition-transform ${editing === member.subjectId ? "rotate-180" : ""}`}
                      />
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy || member.subjectId === callerSubjectId}
                      aria-label={`Remove ${member.subjectLabel ?? member.subjectId}`}
                      onClick={() => setRemovingMember(member)}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                ) : null}
              </div>
              {canManage && editing === member.subjectId ? (
                <div className="grid gap-3 border-t border-border pt-2">
                  <PermissionGroupPicker
                    groups={workspaceMemberPermissionGroups}
                    selected={editPermissions}
                    onToggle={toggleEditPermission}
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy}
                      onClick={() => void saveEditing(member)}
                    >
                      {busy ? (
                        <Loader2Icon className="size-3.5 animate-spin" />
                      ) : (
                        <CheckIcon className="size-3.5" />
                      )}
                      Save
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

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

function MemoryPreferenceRow({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
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
    <PreferenceToggleRow
      icon={<BrainCircuitIcon className="size-3.5 text-brand" />}
      label="Workspace memory"
      description="Durable facts agents carry across sessions — editable on Documents."
      checked={enabled}
      disabled={saving || !canManage}
      saving={saving}
      onToggle={() => void toggle(!enabled)}
    />
  );
}

/**
 * Default for NEW Codex sessions. Off (= remote_v2): best ChatGPT compaction,
 * Codex-only. On (= portable): can switch to other models mid-session.
 */
function CodexCompactionPreferenceRow({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const context = useAppContext();
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const portable = workspace?.settings?.codexCompactionDefault === "portable";
  const [saving, setSaving] = useState(false);

  async function toggle(nextPortable: boolean) {
    setSaving(true);
    try {
      const updated = await context.updateWorkspaceSettings(workspaceId, {
        codexCompactionDefault: nextPortable ? "portable" : "remote_v2",
      });
      if (updated) {
        toast.success(
          nextPortable
            ? "New Codex sessions can switch to other providers"
            : "New Codex sessions stay on Codex",
        );
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <PreferenceToggleRow
      icon={<ShrinkIcon className="size-3.5 text-brand" />}
      label="Allow other providers (Codex only)"
      description="On: switch from Codex models to other providers mid-session. Off (recommended): better compaction."
      checked={portable}
      disabled={saving || !canManage}
      saving={saving}
      onToggle={() => void toggle(!portable)}
    />
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
  const nameMatches =
    confirmName.trim() === props.workspaceName.trim() && props.workspaceName.trim().length > 0;

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
    <section className="grid gap-2 rounded-lg border border-status-failed/30 bg-status-failed/5 px-3 py-3">
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
          <p className="mt-1.5 text-2xs text-fg-subtle">
            Stop any running sessions first; deletion is refused while one is live.
          </p>
        )}
      </div>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
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
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={busy || !nameMatches}>
                {busy ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <Trash2Icon className="size-4" />
                )}
                Delete workspace
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
