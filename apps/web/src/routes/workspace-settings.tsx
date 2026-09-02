// Workspace settings hub: browse links to workspace config surfaces, then
// name/rename, members, API keys, memory/transcription/Codex policy, Codex
// subscriptions, and a danger zone with workspace deletion. The org/billing
// console lives at Organization settings.
import { resolveWorkspaceMemoryEnabled } from "@opengeni/contracts";
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
  ShrinkIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { CodexSubscriptionsCard } from "@/components/codex-connection";
import { DefaultSessionModelPreferenceRow } from "@/components/default-session-model";
import { ModelAccessPolicySection } from "@/components/model-access-policy";
import { SuperGrokSubscriptionsCard } from "@/components/supergrok-connection";
import {
  AiGatewayConnectionCard,
  OpenRouterConnectionCard,
} from "@/components/ai-gateway-connection";
import { PersonalWorkspaceBadge } from "@/components/personal-workspace-badge";
import { VideoGenerationPreferenceRow } from "@/components/video-generation-settings";
import { WorkspaceCapabilityDefaults } from "@/components/workspace-capability-defaults";
import { LoadErrorState } from "@/components/common";
import {
  WorkspaceSettingsContent,
  type WorkspaceSettingsSection,
} from "@/components/settings/workspace-settings-shell";
import {
  useOrganizationWorkspaceAdministration,
  type OrganizationWorkspaceAdministration,
} from "@/components/settings/organization-workspace-administration";
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
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useAppContext } from "@/context";
import { orgLabel } from "@/lib/org";
import { isPersonalWorkspace } from "@/lib/managed-self-context";
import {
  apiKeyPermissionGroups,
  defaultApiKeyPermissions,
  delegableApiKeyPermissions,
  hasWorkspacePermission,
} from "@/lib/permissions";
import type { ApiKey, OrganizationMember, OrganizationWorkspaceAccessMember } from "@/types";
import { WorkspaceLearningAdministration } from "./workspace-learning-admin";

export function WorkspaceSettingsRoute({
  workspaceId,
  section,
}: {
  workspaceId: string;
  section: WorkspaceSettingsSection;
}) {
  const context = useAppContext();
  const administration = useOrganizationWorkspaceAdministration();
  const activeWorkspace = context.workspaces.some((workspace) => workspace.id === workspaceId);
  if (!activeWorkspace && administration) {
    return (
      <OrganizationManagedWorkspaceSettings section={section} administration={administration} />
    );
  }
  return <OperationalWorkspaceSettingsRoute workspaceId={workspaceId} section={section} />;
}

function OperationalWorkspaceSettingsRoute({
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
            <Suspense fallback={<MembersSectionFallback />}>
              <LazyMembersSection workspaceId={workspaceId} canManage={canManageMembers} />
            </Suspense>
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
            <section className="rounded-lg border border-border bg-surface px-4 py-3">
              <p className="text-xs leading-5 text-fg-muted">
                Organization Vercel AI Gateway and OpenRouter models appear here when connected by
                an organization admin. Workspace-only connections below remain independent.
              </p>
              <Link
                to="/workspaces/$workspaceId/organization"
                params={{ workspaceId }}
                search={{ section: "models" }}
                className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
              >
                Open organization model settings <ArrowUpRightIcon className="size-3.5" />
              </Link>
            </section>
            <section className="grid gap-2">
              <div>
                <h2 className="text-sm font-medium">Default model</h2>
                <p className="mt-1 text-xs text-fg-muted">
                  Used when a new session does not choose a different model.
                </p>
              </div>
              <div className="rounded-lg border border-border px-3">
                <DefaultSessionModelPreferenceRow
                  key={`default-model:${workspaceId}:${gatewayRevision}`}
                  workspaceId={workspaceId}
                  canManage={canRename}
                />
              </div>
            </section>
            <ModelAccessPolicySection
              key={`model-access:${workspaceId}:${gatewayRevision}`}
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
              canManageConnection={canManageConnections}
              canManageCustomModels={canRename}
              onConnectionChange={() => setGatewayRevision((revision) => revision + 1)}
            />
            <OpenRouterConnectionCard
              workspaceId={workspaceId}
              canManageConnection={canManageConnections}
              canManageCustomModels={canRename}
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

function managedWorkspaceMemberLabel(member: OrganizationWorkspaceAccessMember): string {
  return member.name ?? member.email ?? member.subjectLabel ?? "Workspace member";
}

function OrganizationManagedWorkspaceSettings({
  section,
  administration,
}: {
  section: WorkspaceSettingsSection;
  administration: OrganizationWorkspaceAdministration;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const { organizationId, overview, workspace, refresh } = administration;
  const [name, setName] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(section === "members");
  const [selectedMembershipId, setSelectedMembershipId] = useState("");
  const [selectedRole, setSelectedRole] = useState<"viewer" | "member" | "admin">("member");
  const [removing, setRemoving] = useState<OrganizationWorkspaceAccessMember | null>(null);

  useEffect(() => setName(workspace.name), [workspace.name]);
  useEffect(() => {
    if (section !== "members") return;
    let disposed = false;
    setMembersLoading(true);
    void context.client
      .listOrganizationAdministrationMembers(organizationId)
      .then((response) => {
        if (!disposed) setMembers(response.members.filter((member) => member.status === "active"));
      })
      .catch((error) => {
        if (!disposed) {
          toast.error("Couldn't load organization members", {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .finally(() => {
        if (!disposed) setMembersLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [context.client, organizationId, section, overview]);

  const assignedSubjects = new Set(workspace.members.map((member) => member.subjectId));
  const candidates = members.filter((member) => !assignedSubjects.has(member.subjectId));

  async function rename() {
    const nextName = name.trim();
    if (!nextName || nextName === workspace.name || busy) return;
    setBusy(true);
    try {
      await context.client.updateOrganizationWorkspace(organizationId, workspace.id, {
        name: nextName,
        expectedUpdatedAt: workspace.updatedAt,
        operationId: crypto.randomUUID(),
      });
      toast.success("Workspace renamed");
      refresh();
    } catch (error) {
      toast.error("Couldn't rename workspace", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  async function addMember() {
    if (!selectedMembershipId || busy) return;
    setBusy(true);
    try {
      await context.client.putOrganizationWorkspaceMember(
        organizationId,
        workspace.id,
        selectedMembershipId,
        {
          role: selectedRole,
          expectedUpdatedAt: null,
          operationId: crypto.randomUUID(),
        },
      );
      setSelectedMembershipId("");
      toast.success("Workspace access added");
      await context.revalidatePrincipalAccess();
      refresh();
    } catch (error) {
      toast.error("Couldn't add workspace access", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  async function setMemberRole(
    member: OrganizationWorkspaceAccessMember,
    role: "viewer" | "member" | "admin",
  ) {
    if (!member.organizationMembershipId || busy) return;
    setBusy(true);
    try {
      await context.client.putOrganizationWorkspaceMember(
        organizationId,
        workspace.id,
        member.organizationMembershipId,
        {
          role,
          expectedUpdatedAt: member.updatedAt,
          operationId: crypto.randomUUID(),
        },
      );
      toast.success("Workspace access updated");
      await context.revalidatePrincipalAccess();
      refresh();
    } catch (error) {
      toast.error("Couldn't update workspace access", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(): Promise<boolean> {
    if (!removing?.organizationMembershipId || busy) return false;
    setBusy(true);
    try {
      await context.client.revokeOrganizationWorkspaceMember(
        organizationId,
        workspace.id,
        removing.organizationMembershipId,
        {
          expectedUpdatedAt: removing.updatedAt,
          operationId: crypto.randomUUID(),
        },
      );
      setRemoving(null);
      toast.success("Workspace access removed");
      await context.revalidatePrincipalAccess();
      refresh();
      return true;
    } catch (error) {
      toast.error("Couldn't remove workspace access", {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function deleteWorkspace(): Promise<boolean> {
    setBusy(true);
    try {
      await context.client.deleteOrganizationWorkspace(organizationId, workspace.id);
      await context.revalidatePrincipalAccess();
      const next = context.workspaces.find((candidate) => candidate.accountId === organizationId);
      if (next) {
        await navigate({
          to: "/workspaces/$workspaceId/organization",
          params: { workspaceId: next.id },
          search: { section: "overview" },
          replace: true,
        });
      } else {
        await navigate({ to: "/", replace: true });
      }
      return true;
    } catch (error) {
      toast.error("Couldn't delete workspace", {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (section !== "general" && section !== "members" && section !== "danger") {
    return (
      <WorkspaceSettingsContent section={section}>
        <Notice tone="muted" title="Workspace access required">
          Organization administrators can manage identity, members, and deletion here without
          receiving access to workspace content.
        </Notice>
      </WorkspaceSettingsContent>
    );
  }

  return (
    <WorkspaceSettingsContent section={section}>
      <section className="grid min-w-0 gap-6 text-left">
        <Notice tone="muted" title="Organization management mode">
          You can manage this shared workspace, but this does not give you access to its chats,
          files, credentials, or integrations.
        </Notice>

        {section === "general" ? (
          <section className="grid gap-3 rounded-lg border border-border p-4">
            <div>
              <h2 className="text-sm font-medium">Workspace name</h2>
              <p className="mt-1 text-xs text-fg-muted">Shown to everyone with workspace access.</p>
            </div>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void rename();
              }}
            >
              <label className="grid min-w-56 flex-1 gap-1 text-xs text-fg-muted">
                Name
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={120}
                />
              </label>
              <Button
                type="submit"
                size="sm"
                disabled={busy || !name.trim() || name.trim() === workspace.name}
              >
                {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                Save name
              </Button>
            </form>
          </section>
        ) : null}

        {section === "members" ? (
          <section className="grid gap-4">
            <div>
              <h2 className="text-sm font-medium">People with access</h2>
              <p className="mt-1 text-xs text-fg-muted">
                Workspace access is separate from organization administration.
              </p>
            </div>
            {candidates.length > 0 ? (
              <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
                <label className="grid min-w-56 flex-1 gap-1 text-xs text-fg-muted">
                  Organization member
                  <Select
                    value={selectedMembershipId}
                    onChange={(event) => setSelectedMembershipId(event.target.value)}
                    disabled={busy}
                  >
                    <option value="">Choose a person…</option>
                    {candidates.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name ?? member.email ?? "Member"}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="grid min-w-40 gap-1 text-xs text-fg-muted">
                  Access
                  <Select
                    value={selectedRole}
                    onChange={(event) => setSelectedRole(event.target.value as typeof selectedRole)}
                    disabled={busy}
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
                  disabled={busy || !selectedMembershipId}
                  onClick={() => void addMember()}
                >
                  Add access
                </Button>
              </div>
            ) : null}
            {membersLoading ? (
              <p role="status" className="text-xs text-fg-muted">
                Loading organization members…
              </p>
            ) : workspace.members.length === 0 ? (
              <EmptyState
                title="No one has access"
                description="Add an organization member to this workspace."
              />
            ) : (
              <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {workspace.members.map((member) => (
                  <div
                    key={member.membershipId}
                    className="flex flex-wrap items-center gap-3 px-3 py-3"
                  >
                    <div className="min-w-48 flex-1">
                      <p className="truncate text-sm font-medium">
                        {managedWorkspaceMemberLabel(member)}
                      </p>
                      <p className="text-2xs capitalize text-fg-subtle">{member.principalKind}</p>
                    </div>
                    {member.organizationMembershipId && member.principalKind === "human" ? (
                      <Select
                        className="w-44"
                        value={member.role}
                        disabled={busy}
                        onChange={(event) =>
                          void setMemberRole(
                            member,
                            event.target.value as "viewer" | "member" | "admin",
                          )
                        }
                      >
                        {member.role === "custom" ? (
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
                    ) : (
                      <span className="text-xs capitalize text-fg-muted">{member.role}</span>
                    )}
                    {member.organizationMembershipId &&
                    member.subjectId !== context.accessContext.subjectId ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => setRemoving(member)}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : null}

        {section === "danger" ? (
          <DangerZone
            workspaceName={workspace.name}
            canDelete
            isOnlyWorkspaceInAccount={false}
            onDelete={deleteWorkspace}
          />
        ) : null}

        <ConfirmDialog
          open={removing !== null}
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          title={`Remove ${removing ? managedWorkspaceMemberLabel(removing) : "member"}?`}
          description="Their workspace access stops immediately. Their organization membership and Personal workspace are unchanged."
          confirmLabel="Remove access"
          onConfirm={removeMember}
        />
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

const LazyMembersSection = lazy(async () => {
  const module = await import("./workspace-members-section");
  return { default: module.MembersSection };
});

function MembersSectionFallback() {
  return (
    <div role="status" className="grid gap-2" aria-label="Loading workspace members">
      <Skeleton className="h-16 rounded-lg" />
      <Skeleton className="h-16 rounded-lg" />
    </div>
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
  const enabled = workspace ? resolveWorkspaceMemoryEnabled(workspace.settings) : false;
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
      description="Let agents autonomously save and correct durable facts, incidents, decisions, and outcomes across sessions."
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
