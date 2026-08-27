// Workspace settings hub: browse links to workspace config surfaces, then
// name/rename, members, API keys, memory/transcription/Codex policy, Codex
// subscriptions, and a danger zone with workspace deletion. The org/billing
// console lives at Organization settings.
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  BrainCircuitIcon,
  CopyIcon,
  KeyRoundIcon,
  Loader2Icon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  ShrinkIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { CodexSubscriptionsCard } from "@/components/codex-connection";
import { DefaultSessionModelPreferenceRow } from "@/components/default-session-model";
import { ModelAccessPolicySection } from "@/components/model-access-policy";
import { SuperGrokSubscriptionsCard } from "@/components/supergrok-connection";
import { AiGatewayConnectionCard } from "@/components/ai-gateway-connection";
import { PersonalWorkspaceBadge } from "@/components/personal-workspace-badge";
import { VideoGenerationPreferenceRow } from "@/components/video-generation-settings";
import { WorkspaceCapabilityDefaults } from "@/components/workspace-capability-defaults";
import { LoadErrorState } from "@/components/common";
import {
  WorkspaceSettingsContent,
  type WorkspaceSettingsSection,
} from "@/components/settings/workspace-settings-shell";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAppContext } from "@/context";
import { orgLabel } from "@/lib/org";
import { isPersonalWorkspace } from "@/lib/managed-self-context";
import {
  apiKeyPermissionGroups,
  defaultApiKeyPermissions,
  defaultWorkspaceMemberPermissions,
  delegableApiKeyPermissions,
  hasWorkspacePermission,
  workspaceAccessLevels,
  workspaceMemberPermissionGroups,
  type WorkspaceAccessLevel,
} from "@/lib/permissions";
import type {
  ApiKey,
  SlackUserLinkAccessRequest,
  WorkspaceMember,
  WorkspaceMemberCandidate,
} from "@/types";
import { WorkspaceLearningAdministration } from "./workspace-learning-admin";

export function WorkspaceSettingsRoute({
  workspaceId,
  section,
}: {
  workspaceId: string;
  section: WorkspaceSettingsSection;
}) {
  const context = useAppContext();
  const client = context.client;
  const { captureWorkspaceInvocation, ownsWorkspaceInvocation } = context;
  const navigate = useNavigate();
  const activeWorkspace =
    context.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const accountId = activeWorkspace?.accountId ?? "";
  const organizationLabel = accountId
    ? orgLabel(accountId, context.accessContext.accountGrants)
    : "Organization";
  const personal = isPersonalWorkspace(activeWorkspace, context.managedSelfContext);

  const [nameDraft, setNameDraft] = useState(activeWorkspace?.name ?? "");
  const [nameEditing, setNameEditing] = useState(false);
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
  const canManageConnections = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "connections:write",
  );
  // Deleting the account's only workspace is refused server-side; disable the
  // affordance when this is the only workspace in the active account.
  const isOnlyWorkspaceInAccount =
    context.workspaces.filter((workspace) => workspace.accountId === accountId).length <= 1;

  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [apiKeysError, setApiKeysError] = useState<Error | null>(null);
  const [apiKeysLoaded, setApiKeysLoaded] = useState(false);
  const [apiKeyName, setApiKeyName] = useState("Default API key");
  const [apiKeyDescription, setApiKeyDescription] = useState("");
  const [selectedPermissions, setSelectedPermissions] = useState<Set<string>>(
    () => new Set(defaultApiKeyPermissions),
  );
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [createKeyOpen, setCreateKeyOpen] = useState(false);
  const [revokingKey, setRevokingKey] = useState<ApiKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const [gatewayRevision, setGatewayRevision] = useState(0);
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
    setNameEditing(false);
  }, [activeWorkspace?.id, activeWorkspace?.name]);

  const refreshApiKeys = useCallback(async () => {
    if (!canManageApiKeys) {
      setApiKeys([]);
      setApiKeysError(null);
      setApiKeysLoaded(true);
      return;
    }
    const acceptedTransition = captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return;
    try {
      const nextApiKeys = await client.listApiKeys(workspaceId);
      if (!ownsWorkspaceInvocation(workspaceId, acceptedTransition)) return;
      setApiKeys(nextApiKeys);
      setApiKeysError(null);
    } catch (error) {
      if (!ownsWorkspaceInvocation(workspaceId, acceptedTransition)) return;
      setApiKeys([]);
      setApiKeysError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (ownsWorkspaceInvocation(workspaceId, acceptedTransition)) {
        setApiKeysLoaded(true);
      }
    }
  }, [canManageApiKeys, captureWorkspaceInvocation, client, ownsWorkspaceInvocation, workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    void refreshApiKeys();
  }, [refreshApiKeys, workspaceId]);

  async function submitRename() {
    const name = nameDraft.trim();
    if (!name) {
      return;
    }
    if (name === activeWorkspace?.name) {
      setNameEditing(false);
      return;
    }
    const acceptedTransition = context.captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return;
    setRenaming(true);
    try {
      const renamed = await context.renameWorkspace(workspaceId, name);
      if (renamed && context.ownsWorkspaceInvocation(workspaceId, acceptedTransition)) {
        setNameEditing(false);
        toast.success("Workspace renamed");
      }
    } finally {
      setRenaming(false);
    }
  }

  function cancelRename() {
    setNameDraft(activeWorkspace?.name ?? "");
    setNameEditing(false);
  }

  async function toggleWorkspaceControl() {
    if (!activeWorkspace || !canRename || controlBusy) return;
    const acceptedTransition = context.captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return;
    const action = activeWorkspace.inferenceControl.state === "paused" ? "resume" : "pause";
    setControlBusy(true);
    try {
      const updated = await context.setWorkspaceInferenceControl(workspaceId, action);
      if (updated && context.ownsWorkspaceInvocation(workspaceId, acceptedTransition)) {
        toast.success(action === "pause" ? "Workspace paused" : "Workspace resumed");
      }
    } catch (error) {
      toast.error(`Couldn't ${action} the workspace`, {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setControlBusy(false);
    }
  }

  async function createKey() {
    if (!apiKeyName.trim() || requestedPermissions.length === 0) {
      toast.error("API key name and permissions are required");
      return;
    }
    const acceptedTransition = captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return;
    setBusy(true);
    try {
      const result = await client.createApiKey(workspaceId, {
        name: apiKeyName.trim(),
        ...(apiKeyDescription.trim() ? { description: apiKeyDescription.trim() } : {}),
        permissions: requestedPermissions,
      });
      if (!ownsWorkspaceInvocation(workspaceId, acceptedTransition)) return;
      setCreatedToken(result.token);
      setApiKeys((current) => [result.apiKey, ...current]);
      setApiKeyDescription("");
      setCreateKeyOpen(false);
      toast.success("API key created");
    } catch (error) {
      if (!ownsWorkspaceInvocation(workspaceId, acceptedTransition)) return;
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
      toast.error("Couldn't copy the token", {
        description: "Copy it manually instead.",
      });
    }
  }

  async function revokeKey(apiKeyId: string) {
    const acceptedTransition = captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return false;
    setBusy(true);
    try {
      const revoked = await client.deleteApiKey(workspaceId, apiKeyId);
      if (!ownsWorkspaceInvocation(workspaceId, acceptedTransition)) return false;
      setApiKeys((current) => current.map((key) => (key.id === revoked.id ? revoked : key)));
      toast.success("API key revoked");
      return true;
    } catch (error) {
      if (!ownsWorkspaceInvocation(workspaceId, acceptedTransition)) return false;
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
    const acceptedTransition = context.captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return false;
    // Pick where to land BEFORE the cache drops this workspace.
    const remaining = context.workspaces.filter((workspace) => workspace.id !== workspaceId);
    const next =
      remaining.find((workspace) => workspace.accountId === accountId) ?? remaining[0] ?? null;
    const deleted = await context.deleteWorkspace(workspaceId);
    if (!deleted) {
      return false;
    }
    if (!context.ownsWorkspaceInvocation(workspaceId, acceptedTransition)) return false;
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

  return (
    <WorkspaceSettingsContent section={section}>
      <section className="grid min-w-0 gap-6 text-left">
        {section === "general" ? (
          <>
            <section className="grid max-w-3xl gap-4 border-b border-border pb-5">
              <div className="flex min-w-0 items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
                    Workspace
                  </p>
                  <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2">
                    <h2 className="truncate text-lg font-semibold tracking-tight text-fg">
                      {activeWorkspace?.name ?? "Workspace"}
                    </h2>
                    {personal ? <PersonalWorkspaceBadge /> : null}
                  </div>
                  <p className="mt-1 text-xs text-fg-muted">
                    {personal ? "Private workspace" : "Shared workspace"} in {organizationLabel}
                  </p>
                </div>
                {canRename && !nameEditing ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="shrink-0 text-fg-muted hover:text-fg"
                    onClick={() => setNameEditing(true)}
                    aria-label={`Rename workspace ${activeWorkspace?.name ?? ""}`}
                  >
                    <PencilIcon className="size-3.5" />
                    Rename
                  </Button>
                ) : null}
              </div>
              {nameEditing && canRename ? (
                <form
                  className="grid max-w-xl gap-3 rounded-lg border border-border bg-surface/45 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitRename();
                  }}
                >
                  <div className="grid min-w-0 gap-1.5">
                    <Label htmlFor="workspace-name" className="text-xs text-fg-muted">
                      Workspace name
                    </Label>
                    <Input
                      id="workspace-name"
                      value={nameDraft}
                      onChange={(event) => setNameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") cancelRename();
                      }}
                      disabled={renaming}
                      placeholder="Workspace name"
                      aria-label="Workspace name"
                      autoFocus
                    />
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={renaming}
                      onClick={cancelRename}
                    >
                      <XIcon className="size-3.5" />
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      size="sm"
                      disabled={
                        renaming || !nameDraft.trim() || nameDraft.trim() === activeWorkspace?.name
                      }
                    >
                      {renaming ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                      Save
                    </Button>
                  </div>
                </form>
              ) : null}
            </section>

            <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
              <div>
                <h2 className="text-sm font-medium">Workspace runtime</h2>
                <p className="mt-1 text-xs text-fg-muted">
                  {activeWorkspace?.inferenceControl.state === "paused"
                    ? "New agent work is paused for this workspace."
                    : "Agents can start and continue work in this workspace."}
                </p>
              </div>
              {canRename ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={controlBusy}
                  onClick={() => void toggleWorkspaceControl()}
                >
                  {controlBusy ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : activeWorkspace?.inferenceControl.state === "paused" ? (
                    <PlayIcon className="size-3.5" />
                  ) : (
                    <PauseIcon className="size-3.5" />
                  )}
                  {activeWorkspace?.inferenceControl.state === "paused"
                    ? "Resume workspace"
                    : "Pause workspace"}
                </Button>
              ) : null}
            </section>

            {personal ? <PersonalWorkspaceNotice organizationLabel={organizationLabel} /> : null}

            <section aria-labelledby="workspace-preferences-heading" className="grid min-w-0 gap-2">
              <div>
                <h2 id="workspace-preferences-heading" className="text-sm font-medium">
                  Session defaults
                </h2>
                <p className="mt-1 text-xs text-fg-muted">
                  Applied when someone starts a new session in this workspace.
                </p>
              </div>
              <div className="divide-y divide-border/70 rounded-lg border border-border px-3">
                <MemoryPreferenceRow workspaceId={workspaceId} canManage={canRename} />
                <VoiceInputPreferenceRow workspaceId={workspaceId} canManage={canRename} />
                <VideoGenerationPreferenceRow
                  workspaceId={workspaceId}
                  canManage={canDeleteWorkspace}
                  refreshKey={gatewayRevision}
                />
                <CodexCompactionPreferenceRow workspaceId={workspaceId} canManage={canRename} />
              </div>
            </section>

            <WorkspaceLearningAdministration workspaceId={workspaceId} />
          </>
        ) : null}

        {section === "members" ? (
          personal ? (
            <PersonalWorkspaceNotice organizationLabel={organizationLabel} />
          ) : (
            <MembersSection workspaceId={workspaceId} canManage={canManageMembers} />
          )
        ) : null}

        {section === "tools" ? (
          <WorkspaceCapabilityDefaults
            workspaceId={workspaceId}
            canManage={canRename}
            kind="permissions"
          />
        ) : null}

        {section === "plugins" ? (
          <>
            <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
              <div>
                <h2 className="text-sm font-medium">Install and manage plugins</h2>
                <p className="mt-1 text-xs text-fg-muted">
                  Connect apps, MCP servers, skills, and packs on the Plugins page.
                </p>
              </div>
              <Button asChild type="button" variant="secondary" size="sm">
                <Link to="/workspaces/$workspaceId/plugins" params={{ workspaceId }}>
                  Open Plugins
                  <ArrowUpRightIcon className="size-3.5" />
                </Link>
              </Button>
            </section>
            <WorkspaceCapabilityDefaults
              workspaceId={workspaceId}
              canManage={canRename}
              kind="plugins"
            />
          </>
        ) : null}

        {section === "models" ? (
          <>
            <section className="grid gap-2">
              <div>
                <h2 className="text-sm font-medium">Default model</h2>
                <p className="mt-1 text-xs text-fg-muted">
                  Used when a new session does not choose a different model.
                </p>
              </div>
              <div className="rounded-lg border border-border px-3">
                <DefaultSessionModelPreferenceRow workspaceId={workspaceId} canManage={canRename} />
              </div>
            </section>
            <ModelAccessPolicySection
              key={`model-access:${workspaceId}`}
              workspaceId={workspaceId}
              canManage={canDeleteWorkspace}
            />
            {/* Codex live overview is intentionally once-per-mount; remount at tenant boundary. */}
            <CodexSubscriptionsCard
              key={`codex-subscriptions:${workspaceId}`}
              workspaceId={workspaceId}
              canManage={canManageConnections}
            />
            <SuperGrokSubscriptionsCard
              key={`supergrok:${workspaceId}`}
              workspaceId={workspaceId}
              canManage={canManageConnections}
            />
            <AiGatewayConnectionCard
              workspaceId={workspaceId}
              canManage={canManageConnections}
              onConnectionChange={() => setGatewayRevision((revision) => revision + 1)}
            />
          </>
        ) : null}

        {section === "api-keys" ? (
          <section className="grid gap-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-2 text-sm font-medium">
                  <KeyRoundIcon className="size-3.5 text-brand" />
                  OpenGeni API keys
                </h2>
                <p className="mt-1 text-xs text-fg-muted">
                  Workspace-scoped keys for calling OpenGeni from another product.
                </p>
              </div>
              {canManageApiKeys ? (
                <Button type="button" size="sm" onClick={() => setCreateKeyOpen(true)}>
                  <PlusIcon className="size-3.5" />
                  Create API key
                </Button>
              ) : null}
            </div>
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
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-medium text-fg-muted">Keys</h3>
              <span className="text-2xs text-fg-subtle">
                {!apiKeysLoaded
                  ? "Loading…"
                  : activeApiKeyCount === 0
                    ? "No active keys"
                    : `${activeApiKeyCount} active`}
              </span>
            </div>
            <div className="divide-y divide-border/70 overflow-hidden rounded-lg border border-border">
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
                        ? "Create a key to call OpenGeni from another product."
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
                      {apiKey.description ? (
                        <div className="truncate text-xs text-fg-muted">{apiKey.description}</div>
                      ) : null}
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
            {!canManageApiKeys ? (
              <p className="text-xs text-fg-subtle">
                You don't have permission to manage API keys here.
              </p>
            ) : null}

            <Dialog open={createKeyOpen} onOpenChange={setCreateKeyOpen}>
              <DialogContent className="max-h-[90dvh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-h-[85vh] sm:max-w-2xl">
                <DialogHeader>
                  <DialogTitle>Create API key</DialogTitle>
                  <DialogDescription>
                    Create a workspace-scoped key and choose what it can access.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid min-h-0 gap-5 overflow-y-auto px-1">
                  <div className="grid gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="api-key-name">Name</Label>
                      <Input
                        id="api-key-name"
                        autoFocus
                        value={apiKeyName}
                        onChange={(event) => setApiKeyName(event.target.value)}
                        placeholder="Default API key"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="api-key-description">Description</Label>
                      <Textarea
                        id="api-key-description"
                        value={apiKeyDescription}
                        onChange={(event) => setApiKeyDescription(event.target.value)}
                        placeholder="What will this key be used for?"
                        maxLength={500}
                        rows={3}
                      />
                    </div>
                  </div>
                  <section className="grid gap-3" aria-labelledby="api-key-permissions-heading">
                    <div className="flex flex-wrap items-end justify-between gap-2">
                      <div>
                        <h3 id="api-key-permissions-heading" className="text-sm font-medium">
                          Permissions
                        </h3>
                        <p className="mt-1 text-xs text-fg-muted">
                          A key can only carry permissions your own grant can delegate.
                        </p>
                      </div>
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
                      groups={apiKeyPermissionGroups()}
                      selected={selectedPermissions}
                      delegable={delegablePermissions}
                      disabled={busy}
                      onToggle={togglePermission}
                    />
                  </section>
                </div>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setCreateKeyOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    disabled={busy || !apiKeyName.trim() || requestedPermissions.length === 0}
                    onClick={() => void createKey()}
                  >
                    {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                    Create API key
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </section>
        ) : null}

        <ConfirmDialog
          open={revokingKey !== null}
          onOpenChange={(next) => setRevokingKey(next ? revokingKey : null)}
          title={`Revoke API key “${revokingKey?.name ?? ""}”?`}
          description={`Any product calling OpenGeni with ${revokingKey?.prefix ?? ""}… stops working immediately. This can't be undone.`}
          confirmLabel="Revoke key"
          onConfirm={() => (revokingKey ? revokeKey(revokingKey.id) : false)}
        />

        {section === "danger" ? (
          <DangerZone
            workspaceName={activeWorkspace?.name ?? ""}
            canDelete={canDeleteWorkspace}
            isOnlyWorkspaceInAccount={isOnlyWorkspaceInAccount}
            onDelete={deleteWorkspace}
          />
        ) : null}
      </section>
    </WorkspaceSettingsContent>
  );
}

function PersonalWorkspaceNotice({ organizationLabel }: { organizationLabel: string }) {
  return (
    <section
      aria-labelledby="personal-workspace-heading"
      className="grid gap-2 rounded-lg border border-brand/25 bg-brand/5 p-4"
    >
      <h2 id="personal-workspace-heading" className="flex items-center gap-2 text-sm font-medium">
        <UserIcon className="size-3.5 text-brand" />
        Personal workspace
        <PersonalWorkspaceBadge decorative />
      </h2>
      <p className="text-xs text-fg-muted">
        This workspace is your owner-only context inside {organizationLabel}. Organization
        administrators and other members do not gain access to its sessions or content.
      </p>
    </section>
  );
}

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
    const acceptedTransition = context.captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return;
    setSaving(true);
    try {
      const updated = await context.updateWorkspaceSettings(workspaceId, {
        memoryEnabled: next,
      });
      if (updated && context.ownsWorkspaceInvocation(workspaceId, acceptedTransition)) {
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
      description="Durable facts agents carry across sessions — manage them in Memory."
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
    const acceptedTransition = context.captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return;
    setSaving(true);
    try {
      const updated = await context.updateWorkspaceSettings(workspaceId, {
        codexCompactionDefault: nextPortable ? "portable" : "remote_v2",
      });
      if (updated && context.ownsWorkspaceInvocation(workspaceId, acceptedTransition)) {
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
