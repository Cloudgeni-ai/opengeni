// Workspace settings: workspace name/rename, the workspace-scoped API keys
// (moved here out of the old account page), a link to Environments, and a
// danger zone. The org/billing console lives at Organization settings.
import { Link } from "@tanstack/react-router";
import {
  BoxIcon,
  CheckIcon,
  CopyIcon,
  KeyRoundIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  SettingsIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { EmptyState, LoadErrorState, PageHeader } from "@/components/common";
import { PermissionGroupPicker } from "@/components/permission-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppContext } from "@/context";
import { orgLabel } from "@/lib/org";
import {
  apiKeyPermissionGroups,
  defaultApiKeyPermissions,
  delegableApiKeyPermissions,
  hasWorkspacePermission,
} from "@/lib/permissions";
import type { ApiKey } from "@/types";

export function WorkspaceSettingsRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const client = context.client;
  const activeWorkspace = context.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const accountId = activeWorkspace?.accountId ?? "";
  const organizationLabel = accountId ? orgLabel(accountId, context.accessContext.accountGrants) : "Organization";

  const [nameDraft, setNameDraft] = useState(activeWorkspace?.name ?? "");
  const [renaming, setRenaming] = useState(false);
  const canRename = activeWorkspace !== null && hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin");

  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [apiKeysError, setApiKeysError] = useState<Error | null>(null);
  const [apiKeyName, setApiKeyName] = useState("Default API key");
  const [selectedPermissions, setSelectedPermissions] = useState<Set<string>>(() => new Set(defaultApiKeyPermissions));
  const [createdToken, setCreatedToken] = useState<string | null>(null);
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
      return;
    }
    try {
      setApiKeys(await client.listApiKeys(workspaceId));
      setApiKeysError(null);
    } catch (error) {
      setApiKeys([]);
      setApiKeysError(error instanceof Error ? error : new Error(String(error)));
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

  async function revokeKey(apiKeyId: string) {
    setBusy(true);
    try {
      const revoked = await client.deleteApiKey(workspaceId, apiKeyId);
      setApiKeys((current) => current.map((key) => key.id === revoked.id ? revoked : key));
      toast.success("API key revoked");
    } catch (error) {
      toast.error("Failed to revoke API key", { description: error instanceof Error ? error.message : String(error) });
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

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col overflow-y-auto px-4 py-5 sm:px-6 lg:px-8">
      <section className="grid gap-5 text-left">
        <PageHeader
          icon={<SettingsIcon className="size-4" />}
          title="Workspace settings"
          description={activeWorkspace ? `${activeWorkspace.name} · ${organizationLabel}` : organizationLabel}
        />

        {/* Workspace name / rename */}
        <section className="grid gap-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-4">
          <div>
            <h2 className="flex items-center gap-1.5 text-sm font-medium">
              <PencilIcon className="size-3.5 text-[color:var(--color-brand)]" />
              Workspace name
            </h2>
            <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">The name shows everywhere this workspace appears.</p>
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
            <p className="text-xs text-[color:var(--color-fg-subtle)]">Only workspace admins can rename this workspace.</p>
          )}
        </section>

        {/* Environments link */}
        <section className="flex items-center justify-between gap-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-1.5 text-sm font-medium">
              <BoxIcon className="size-3.5 text-[color:var(--color-brand)]" />
              Environments
            </h2>
            <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">Variable sets injected into sandboxes at session start.</p>
          </div>
          <Button asChild type="button" variant="secondary" size="sm">
            <Link to="/workspaces/$workspaceId/environments" params={{ workspaceId }}>
              Manage environments
            </Link>
          </Button>
        </section>

        {/* API keys (moved from the old account page) */}
        <section className="grid gap-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-4">
          <div>
            <h2 className="flex items-center gap-1.5 text-sm font-medium">
              <KeyRoundIcon className="size-3.5 text-[color:var(--color-brand)]" />
              API keys
            </h2>
            <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">Workspace-scoped keys for calling OpenGeni from another product.</p>
          </div>
          {createdToken ? (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3">
              <div className="text-xs font-medium text-emerald-200">Token shown once</div>
              <div className="mt-2 flex min-w-0 items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-[color:var(--color-bg)] px-2 py-1.5 text-xs">{createdToken}</code>
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => void navigator.clipboard.writeText(createdToken)}>
                  <CopyIcon className="size-3.5" />
                </Button>
              </div>
            </div>
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
                <p className="text-xs text-[color:var(--color-fg-subtle)]">A key can only carry permissions your own grant can delegate.</p>
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
            <p className="text-xs text-[color:var(--color-fg-subtle)]">This subject cannot manage API keys for this workspace.</p>
          )}
          <div className="grid gap-2">
            {apiKeysError ? (
              <LoadErrorState title="Couldn't load API keys" error={apiKeysError} onRetry={() => void refreshApiKeys()} />
            ) : apiKeys.length === 0 ? (
              <EmptyState>No API keys.</EmptyState>
            ) : apiKeys.map((apiKey) => (
              <div key={apiKey.id} className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/35 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{apiKey.name}</div>
                  <div className="mt-1 truncate text-xs text-[color:var(--color-fg-subtle)]">{apiKey.prefix}... · {apiKey.revokedAt ? "revoked" : "active"}</div>
                </div>
                <Button type="button" variant="ghost" size="sm" disabled={busy || Boolean(apiKey.revokedAt)} onClick={() => void revokeKey(apiKey.id)}>
                  <Trash2Icon className="size-3.5" />
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        </section>

        {/* Danger zone */}
        <section className="grid gap-3 rounded-lg border border-[color:var(--color-status-failed)]/30 bg-[color:var(--color-status-failed)]/5 p-4">
          <div>
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-[color:var(--color-status-failed)]">
              <TriangleAlertIcon className="size-3.5" />
              Danger zone
            </h2>
            <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
              Workspace deletion is irreversible and removes every session, environment, and API key.
            </p>
          </div>
          <div>
            <Button type="button" variant="destructive" size="sm" disabled title="Workspace deletion is not yet available in the console.">
              <Trash2Icon className="size-3.5" />
              Delete workspace
            </Button>
            <p className="mt-1.5 text-[11px] text-[color:var(--color-fg-subtle)]">Contact an organization admin to delete a workspace.</p>
          </div>
        </section>
      </section>
    </div>
  );
}
