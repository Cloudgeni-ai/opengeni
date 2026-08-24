// Workspace settings hub: browse links to workspace config surfaces, then
// name/rename, members, API keys, memory/transcription/Codex policy, Codex
// subscriptions, and a danger zone with workspace deletion. The org/billing
// console lives at Organization settings.
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  BrainCircuitIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  KeyRoundIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  ShrinkIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserIcon,
  UserPlusIcon,
  UsersIcon,
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
  workspaceMemberPermissionGroups,
} from "@/lib/permissions";
import type { ApiKey, SlackUserLinkAccessRequest, WorkspaceMember } from "@/types";

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
    if (!name || name === activeWorkspace?.name) {
      return;
    }
    const acceptedTransition = context.captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return;
    setRenaming(true);
    try {
      const renamed = await context.renameWorkspace(workspaceId, name);
      if (renamed && context.ownsWorkspaceInvocation(workspaceId, acceptedTransition)) {
        toast.success("Workspace renamed");
      }
    } finally {
      setRenaming(false);
    }
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
            <section className="grid max-w-xl gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-medium">Workspace name</h2>
                  {personal ? <PersonalWorkspaceBadge /> : null}
                </div>
                <p className="mt-1 text-xs text-fg-muted">Shown throughout {organizationLabel}.</p>
              </div>
              <form
                className="flex min-w-0 items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitRename();
                }}
              >
                <Input
                  value={nameDraft}
                  onChange={(event) => setNameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setNameDraft(activeWorkspace?.name ?? "");
                    }
                  }}
                  disabled={!canRename || renaming}
                  className="h-9 text-sm"
                  placeholder="Workspace name"
                  aria-label="Workspace name"
                />
                {canRename ? (
                  <Button
                    type="submit"
                    size="sm"
                    variant="secondary"
                    disabled={
                      renaming || !nameDraft.trim() || nameDraft.trim() === activeWorkspace?.name
                    }
                  >
                    {renaming ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                    Save
                  </Button>
                ) : null}
              </form>
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
              canManage={canDeleteWorkspace}
            />
            <SuperGrokSubscriptionsCard
              key={`supergrok:${workspaceId}`}
              workspaceId={workspaceId}
              canManage={canDeleteWorkspace}
            />
            <AiGatewayConnectionCard
              workspaceId={workspaceId}
              canManage={canDeleteWorkspace}
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

/** "People with access": the workspace's USER members, with add/edit/remove. */
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
  const [slackAccessRequests, setSlackAccessRequests] = useState<SlackUserLinkAccessRequest[]>([]);
  const [slackAccessRequestsError, setSlackAccessRequestsError] = useState<Error | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editPermissions, setEditPermissions] = useState<Set<string>>(() => new Set());
  const [removingMember, setRemovingMember] = useState<WorkspaceMember | null>(null);
  const callerSubjectId = context.accessContext.subjectId;
  const refreshGenerationRef = useRef(0);
  const currentRefreshScopeRef = useRef<{
    canManage: boolean;
    client: typeof client;
    workspaceId: string;
  }>({ canManage, client, workspaceId });
  currentRefreshScopeRef.current = { canManage, client, workspaceId };

  // Only USER subjects are people; api_key subjects belong to the API keys
  // section above and are excluded here.
  const userMembers = members.filter((member) => member.subjectId.startsWith("user:"));

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
    setMembers([]);
    setSlackAccessRequests([]);
    setSlackAccessRequestsError(null);
    setError(null);
    setLoaded(false);

    // The member roster is primary; pending Slack requests are a manager-only
    // auxiliary surface. Start both concurrently, but settle their UI state independently.
    const membersPromise = Promise.resolve().then(() => client.listWorkspaceMembers(workspaceId));
    const slackAccessRequestsOutcomePromise = canManage
      ? Promise.resolve()
          .then(() => client.listSlackUserLinkAccessRequests(workspaceId))
          .then(
            (value) => ({ status: "fulfilled", value }) as const,
            (reason) => ({ status: "rejected", reason }) as const,
          )
      : null;

    if (slackAccessRequestsOutcomePromise) {
      void slackAccessRequestsOutcomePromise.then((outcome) => {
        if (!isCurrentRefresh()) {
          return;
        }
        if (outcome.status === "fulfilled") {
          setSlackAccessRequests(outcome.value);
          setSlackAccessRequestsError(null);
        } else {
          setSlackAccessRequests([]);
          setSlackAccessRequestsError(
            outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason)),
          );
        }
      });
    }

    try {
      const nextMembers = await membersPromise;
      if (!isCurrentRefresh()) {
        return;
      }
      setMembers(nextMembers);
      setError(null);
    } catch (caught) {
      if (!isCurrentRefresh()) {
        return;
      }
      setMembers([]);
      setError(caught instanceof Error ? caught : new Error(String(caught)));
      return;
    } finally {
      if (isCurrentRefresh()) {
        setLoaded(true);
      }
    }
  }, [canManage, client, workspaceId]);

  useEffect(() => {
    refreshGenerationRef.current += 1;
    setMembers([]);
    setSlackAccessRequests([]);
    setSlackAccessRequestsError(null);
    setError(null);
    setLoaded(false);
    setEditing(null);
    setEditPermissions(new Set());
    setRemovingMember(null);
    void refresh();
    return () => {
      refreshGenerationRef.current += 1;
    };
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

      {canManage && slackAccessRequests.length > 0 ? (
        <div className="grid gap-2 rounded-lg border border-border bg-surface-2/35 p-3">
          <div>
            <p className="text-xs font-medium text-fg">Pending Slack access requests</p>
            <p className="mt-0.5 text-2xs text-fg-subtle">
              Approval grants the standard collaborator role and completes Slack identity linking.
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
                    groups={workspaceMemberPermissionGroups()}
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
