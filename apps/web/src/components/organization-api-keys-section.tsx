import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import {
  ArrowRightIcon,
  Building2Icon,
  CheckIcon,
  CopyIcon,
  KeyRoundIcon,
  Loader2Icon,
  PlusIcon,
  ServerIcon,
  Trash2Icon,
  UserRoundIcon,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { LoadErrorState } from "@/components/common";
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
import { formatTimestamp } from "@/lib/format";
import type { ApiKey } from "@/types";

type CreateOrganizationApiKeyRequest = Parameters<
  OpenGeniBrowserClient["createOrganizationApiKey"]
>[1];
type CreateApiKeyResponse = Awaited<ReturnType<OpenGeniBrowserClient["createOrganizationApiKey"]>>;

export type OrganizationApiKeysSectionProps = {
  organizationId: string;
  canManage: boolean;
  listApiKeys: () => Promise<ApiKey[]>;
  createApiKey: (request: CreateOrganizationApiKeyRequest) => Promise<CreateApiKeyResponse>;
  deleteApiKey: (apiKeyId: string) => Promise<ApiKey>;
};

const defaultKeyName = "Organization automation";

/** Organization integration onboarding plus API-key lifecycle. */
export function OrganizationApiKeysSection(props: OrganizationApiKeysSectionProps) {
  const { canManage, listApiKeys } = props;
  const headingId = useId();
  const createTriggerRef = useRef<HTMLButtonElement | null>(null);
  const revokeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const keyListHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const createDialogContentRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(true);
  const readSequenceRef = useRef(0);
  const mutationSequenceRef = useRef(0);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [apiKeysError, setApiKeysError] = useState<Error | null>(null);
  const [apiKeysLoaded, setApiKeysLoaded] = useState(false);
  const [apiKeyName, setApiKeyName] = useState(defaultKeyName);
  const [apiKeyDescription, setApiKeyDescription] = useState("");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [createError, setCreateError] = useState<Error | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [copiedTarget, setCopiedTarget] = useState<"organization" | "quick-start" | "token" | null>(
    null,
  );
  const [createKeyOpen, setCreateKeyOpen] = useState(false);
  const [revokingKey, setRevokingKey] = useState<ApiKey | null>(null);
  const [busyAction, setBusyAction] = useState<"create" | string | null>(null);
  const activeApiKeyCount = apiKeys.filter((key) => apiKeyStatus(key) === "active").length;
  const quickStart = organizationQuickStart(props.organizationId);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      readSequenceRef.current += 1;
      mutationSequenceRef.current += 1;
    };
  }, []);

  const refreshApiKeys = useCallback(async () => {
    const sequence = readSequenceRef.current + 1;
    readSequenceRef.current = sequence;
    if (!canManage) {
      setApiKeys([]);
      setApiKeysError(null);
      setApiKeysLoaded(true);
      return;
    }
    try {
      const nextApiKeys = await listApiKeys();
      if (!mountedRef.current || readSequenceRef.current !== sequence) return;
      setApiKeys(nextApiKeys);
      setApiKeysError(null);
    } catch (error) {
      if (!mountedRef.current || readSequenceRef.current !== sequence) return;
      setApiKeysError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (mountedRef.current && readSequenceRef.current === sequence) {
        setApiKeysLoaded(true);
      }
    }
  }, [canManage, listApiKeys]);

  useEffect(() => {
    void refreshApiKeys();
  }, [refreshApiKeys]);

  function resetCreateDialog() {
    setApiKeyName(defaultKeyName);
    setApiKeyDescription("");
    setCreatedToken(null);
    setCreateError(null);
    setCopiedTarget(null);
  }

  function setCreateDialogOpen(open: boolean) {
    if (busyAction === "create") return;
    if (!open && createdToken) return;
    setCreateKeyOpen(open);
    if (!open) resetCreateDialog();
  }

  function closeCreatedTokenDialog() {
    setCreateKeyOpen(false);
    resetCreateDialog();
  }

  async function createKey() {
    const name = apiKeyName.trim();
    if (!name) return;
    const sequence = mutationSequenceRef.current + 1;
    mutationSequenceRef.current = sequence;
    setBusyAction("create");
    setCreateError(null);
    setCreatedToken(null);
    try {
      const result = await props.createApiKey({
        name,
        ...(apiKeyDescription.trim() ? { description: apiKeyDescription.trim() } : {}),
      });
      if (!mountedRef.current || mutationSequenceRef.current !== sequence) return;
      setApiKeys((current) => [
        result.apiKey,
        ...current.filter((key) => key.id !== result.apiKey.id),
      ]);
      setCreatedToken(result.token);
      setApiKeyName(defaultKeyName);
      setApiKeyDescription("");
      setStatusMessage("Organization API key created. Copy the full secret before closing.");
    } catch (error) {
      if (!mountedRef.current || mutationSequenceRef.current !== sequence) return;
      const createFailure = error instanceof Error ? error : new Error(String(error));
      setCreateError(createFailure);
      toast.error("Failed to create organization API key", {
        description: createFailure.message,
      });
    } finally {
      if (mountedRef.current && mutationSequenceRef.current === sequence) setBusyAction(null);
    }
  }

  async function copyText(
    value: string,
    target: "organization" | "quick-start" | "token",
    label: string,
  ) {
    try {
      await navigator.clipboard.writeText(value);
      if (!mountedRef.current) return;
      setCopiedTarget(target);
      setStatusMessage(`${label} copied.`);
    } catch {
      toast.error(`Couldn't copy ${label.toLowerCase()}`, {
        description: "Select the value and copy it manually.",
      });
    }
  }

  async function revokeKey(apiKey: ApiKey): Promise<boolean> {
    const sequence = mutationSequenceRef.current + 1;
    mutationSequenceRef.current = sequence;
    setBusyAction(apiKey.id);
    try {
      const revoked = await props.deleteApiKey(apiKey.id);
      if (!mountedRef.current || mutationSequenceRef.current !== sequence) return false;
      setApiKeys((current) => current.map((key) => (key.id === revoked.id ? revoked : key)));
      setStatusMessage("Organization API key revoked.");
      return true;
    } catch (error) {
      if (!mountedRef.current || mutationSequenceRef.current !== sequence) return false;
      toast.error("Failed to revoke organization API key", {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      if (mountedRef.current && mutationSequenceRef.current === sequence) setBusyAction(null);
    }
  }

  const createButton = (
    <Button
      ref={createTriggerRef}
      type="button"
      size="sm"
      onClick={() => setCreateDialogOpen(true)}
    >
      <PlusIcon aria-hidden="true" className="size-3.5" />
      Create Organization API Key
    </Button>
  );

  return (
    <div className="grid min-w-0 gap-6">
      <span role="status" aria-live="polite" className="sr-only">
        {statusMessage}
      </span>
      <section
        aria-labelledby={`${headingId}-integration`}
        className="grid gap-4 border-b border-border pb-6"
      >
        <div className="min-w-0">
          <h2
            id={`${headingId}-integration`}
            className="flex items-center gap-2 text-sm font-medium"
          >
            <ServerIcon aria-hidden="true" className="size-3.5 shrink-0 text-brand" />
            Server-side integration
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-fg-muted">
            Use one server-held credential to provision and operate every organization workspace
            used by your external product.
          </p>
          <p className="mt-2 text-xs font-medium leading-5 text-fg">
            Organization API keys can access organization workspaces, never personal workspaces.
          </p>
        </div>

        <div className="grid min-w-0 gap-2">
          <Label htmlFor={`${headingId}-organization-id`}>Organization ID</Label>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
            <code
              id={`${headingId}-organization-id`}
              translate="no"
              tabIndex={0}
              className="min-w-0 flex-1 select-all overflow-auto rounded-md border border-border bg-surface-2/40 px-3 py-2 font-mono text-xs break-all text-fg"
            >
              {props.organizationId}
            </code>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void copyText(props.organizationId, "organization", "Organization ID")}
            >
              {copiedTarget === "organization" ? (
                <CheckIcon aria-hidden="true" className="size-3.5" />
              ) : (
                <CopyIcon aria-hidden="true" className="size-3.5" />
              )}
              {copiedTarget === "organization" ? "Copied" : "Copy ID"}
            </Button>
          </div>
          <p className="text-xs leading-5 text-fg-subtle">
            Keep the API key in your external product&apos;s server-side secret manager. Never ship
            it to a browser or mobile bundle.
          </p>
        </div>

        <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-stretch">
          <ScopeStep
            icon={<KeyRoundIcon aria-hidden="true" className="size-3.5" />}
            title="Organization credential"
            detail="Workspace provisioning, administration, and API-key management"
          />
          <ArrowRightIcon
            aria-hidden="true"
            className="mx-auto hidden size-4 self-center text-fg-subtle sm:block"
          />
          <ScopeStep
            icon={<Building2Icon aria-hidden="true" className="size-3.5" />}
            title="Organization workspace"
            detail="Tenant settings, sessions, files, and tools"
          />
          <ArrowRightIcon
            aria-hidden="true"
            className="mx-auto hidden size-4 self-center text-fg-subtle sm:block"
          />
          <ScopeStep
            icon={<ServerIcon aria-hidden="true" className="size-3.5" />}
            title="Session"
            detail="Explicit Skills, resources, and user requests"
          />
        </div>
        <p className="flex items-center gap-2 text-xs leading-5 text-fg-subtle">
          <UserRoundIcon aria-hidden="true" className="size-3.5 shrink-0" />
          Personal workspaces and personal resources remain human-only.
        </p>
      </section>

      <section aria-labelledby={headingId} className="grid gap-5 border-b border-border pb-6">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={headingId} className="flex items-center gap-2 text-sm font-medium text-pretty">
              <KeyRoundIcon aria-hidden="true" className="size-3.5 shrink-0 text-brand" />
              Organization API keys
            </h2>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-fg-muted">
              Rotate server-side credentials without changing the tenant-to-workspace mapping.
            </p>
          </div>
          {props.canManage && apiKeysLoaded && (apiKeysError || apiKeys.length > 0)
            ? createButton
            : null}
        </div>

        <div className="flex items-center justify-between gap-3">
          <h3
            ref={keyListHeadingRef}
            tabIndex={-1}
            className="text-xs font-medium text-fg-muted outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            Keys
          </h3>
          <span className="text-2xs text-fg-subtle tabular-nums" aria-live="polite">
            {!props.canManage || (apiKeysError && apiKeys.length === 0)
              ? "Unavailable"
              : !apiKeysLoaded
                ? "Loading…"
                : activeApiKeyCount === 0
                  ? "No active keys"
                  : `${activeApiKeyCount} active`}
          </span>
        </div>

        {!props.canManage ? (
          <Notice tone="info" title="API key management unavailable">
            <p>You don&apos;t have permission to view or manage organization API keys.</p>
          </Notice>
        ) : apiKeysError && apiKeys.length === 0 ? (
          <LoadErrorState
            title="Couldn't load organization API keys"
            error={apiKeysError}
            onRetry={() => void refreshApiKeys()}
          />
        ) : !apiKeysLoaded ? (
          <div className="divide-y divide-border/70 overflow-hidden rounded-lg border border-border">
            {[0, 1].map((key) => (
              <div key={key} className="flex items-center justify-between gap-3 px-3 py-3">
                <div className="min-w-0 space-y-1.5">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-48 max-w-full" />
                </div>
                <Skeleton className="h-8 w-20 rounded-md" />
              </div>
            ))}
          </div>
        ) : apiKeys.length === 0 ? (
          <EmptyState
            icon={<KeyRoundIcon aria-hidden="true" className="size-4" />}
            title="No organization API keys yet"
            description="Create a key for an automation or integration that works across the organization."
            action={props.canManage ? createButton : undefined}
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            {apiKeysError ? (
              <div className="border-b border-border p-2">
                <LoadErrorState
                  title="Couldn't refresh organization API keys"
                  error={apiKeysError}
                  onRetry={() => void refreshApiKeys()}
                />
              </div>
            ) : null}
            <ul className="divide-y divide-border/70">
              {apiKeys.map((apiKey) => {
                const status = apiKeyStatus(apiKey);
                return (
                  <li
                    key={apiKey.id}
                    className="flex min-w-0 flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="min-w-0 truncate text-sm font-medium">{apiKey.name}</span>
                        <span
                          className={
                            status !== "active"
                              ? "rounded-full border border-border px-2 py-0.5 text-2xs text-fg-subtle"
                              : "rounded-full border border-status-idle/30 bg-status-idle/5 px-2 py-0.5 text-2xs text-status-idle"
                          }
                        >
                          {status === "revoked"
                            ? "Revoked"
                            : status === "expired"
                              ? "Expired"
                              : "Active"}
                        </span>
                      </div>
                      {apiKey.description ? (
                        <p className="mt-0.5 break-words text-xs leading-5 text-fg-muted">
                          {apiKey.description}
                        </p>
                      ) : null}
                      <p className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-1 font-mono text-2xs text-fg-subtle">
                        <span translate="no" className="min-w-0 truncate">
                          {apiKey.prefix}…
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">
                          Created {formatTimestamp(apiKey.createdAt)}
                        </span>
                        {apiKey.lastUsedAt ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="tabular-nums">
                              Last used {formatTimestamp(apiKey.lastUsedAt)}
                            </span>
                          </>
                        ) : null}
                        {apiKey.expiresAt ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="tabular-nums">
                              Expires {formatTimestamp(apiKey.expiresAt)}
                            </span>
                          </>
                        ) : null}
                      </p>
                    </div>
                    <Button
                      ref={status === "active" ? revokeTriggerRef : undefined}
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="self-start sm:self-auto"
                      aria-label={`Revoke organization API key ${apiKey.name}`}
                      disabled={busyAction !== null || Boolean(apiKey.revokedAt)}
                      onClick={(event) => {
                        revokeTriggerRef.current = event.currentTarget;
                        setRevokingKey(apiKey);
                      }}
                    >
                      {busyAction === apiKey.id ? (
                        <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2Icon aria-hidden="true" className="size-3.5" />
                      )}
                      Revoke
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      <section aria-labelledby={`${headingId}-quick-start`} className="grid min-w-0 gap-3">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={`${headingId}-quick-start`} className="text-sm font-medium">
              Quick start
            </h2>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-fg-muted">
              Store the key in a server-side environment variable, ensure one workspace per external
              tenant, apply explicit workspace settings, then create a session with the Skills your
              product selected.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void copyText(quickStart, "quick-start", "Quick start")}
          >
            {copiedTarget === "quick-start" ? (
              <CheckIcon aria-hidden="true" className="size-3.5" />
            ) : (
              <CopyIcon aria-hidden="true" className="size-3.5" />
            )}
            {copiedTarget === "quick-start" ? "Copied" : "Copy code"}
          </Button>
        </div>
        <pre
          tabIndex={0}
          className="max-w-full overflow-auto overscroll-contain rounded-lg border border-border bg-surface-2/30 p-3 text-xs leading-5 text-fg"
        >
          <code translate="no" className="font-mono">
            {quickStart}
          </code>
        </pre>
        <p className="text-xs leading-5 text-fg-subtle">
          Reuse the same external source and tenant ID after an ambiguous result. A replay returns
          the original workspace without overwriting its settings.
        </p>
      </section>

      <Dialog open={createKeyOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent
          ref={createDialogContentRef}
          tabIndex={-1}
          showCloseButton={!createdToken}
          className="max-h-[90dvh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden overscroll-contain sm:max-h-[85vh] sm:max-w-2xl"
          onOpenAutoFocus={(event) => {
            if (!window.matchMedia("(max-width: 639px)").matches) return;
            event.preventDefault();
            requestAnimationFrame(() => createDialogContentRef.current?.focus());
          }}
          onEscapeKeyDown={(event) => {
            if (createdToken) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (createdToken) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (createdToken) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            if (!createTriggerRef.current?.isConnected) return;
            event.preventDefault();
            createTriggerRef.current.focus();
          }}
        >
          {createdToken ? (
            <>
              <DialogHeader>
                <DialogTitle>Organization API Key Created</DialogTitle>
                <DialogDescription>
                  Copy the full secret before closing this dialog. It will not be shown again.
                </DialogDescription>
              </DialogHeader>
              <div className="grid min-h-0 gap-4 overflow-y-auto overscroll-contain px-1">
                <Notice tone="waiting" title="Store this secret now">
                  <p>The full token is available only in this success state.</p>
                </Notice>
                <code
                  translate="no"
                  tabIndex={0}
                  className="block max-h-40 select-all overflow-auto overscroll-contain rounded-md border border-border bg-bg px-3 py-2 font-mono text-xs break-all text-fg"
                >
                  {createdToken}
                </code>
                <div className="grid gap-1.5">
                  <span className="text-xs font-medium text-fg">
                    Server-side environment variable
                  </span>
                  <code
                    translate="no"
                    className="select-all overflow-auto rounded-md border border-border bg-surface-2/40 px-3 py-2 font-mono text-xs text-fg-muted"
                  >
                    OPENGENI_ORGANIZATION_API_KEY=&lt;secret copied above&gt;
                  </code>
                </div>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  onClick={() => void copyText(createdToken, "token", "API key")}
                >
                  {copiedTarget === "token" ? (
                    <CheckIcon aria-hidden="true" className="size-3.5" />
                  ) : (
                    <CopyIcon aria-hidden="true" className="size-3.5" />
                  )}
                  {copiedTarget === "token" ? "Copied" : "Copy API key"}
                </Button>
                <Button type="button" variant="secondary" onClick={closeCreatedTokenDialog}>
                  I&apos;ve stored this key
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Create Organization API Key</DialogTitle>
                <DialogDescription>
                  Create a fixed-scope server credential for your external product.
                </DialogDescription>
              </DialogHeader>
              <div className="grid min-h-0 gap-5 overflow-y-auto overscroll-contain px-1">
                {createError ? (
                  <Notice tone="failed" title="The API key was not created">
                    <p>{createError.message}</p>
                    <p>Check your permission and plan limit, then retry with the values below.</p>
                  </Notice>
                ) : null}
                <div className="grid gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor={`${headingId}-name`}>Name</Label>
                    <Input
                      id={`${headingId}-name`}
                      name="organization-api-key-name"
                      autoComplete="off"
                      value={apiKeyName}
                      onChange={(event) => setApiKeyName(event.target.value)}
                      placeholder="Production automation…"
                      maxLength={200}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={`${headingId}-description`}>Description</Label>
                    <Textarea
                      id={`${headingId}-description`}
                      name="organization-api-key-description"
                      autoComplete="off"
                      value={apiKeyDescription}
                      onChange={(event) => setApiKeyDescription(event.target.value)}
                      placeholder="What will use this key?…"
                      maxLength={500}
                      rows={3}
                    />
                  </div>
                </div>
                <Notice tone="info" title="Provision and manage all organization workspaces">
                  <p>
                    The key can list, create, and administer organization workspaces and manage
                    their API keys. It cannot access Personal workspaces or read plaintext secrets.
                  </p>
                </Notice>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busyAction !== null}
                  onClick={() => setCreateDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={busyAction !== null || !apiKeyName.trim()}
                  onClick={() => void createKey()}
                >
                  {busyAction === "create" ? (
                    <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin" />
                  ) : null}
                  Create Organization API Key
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={revokingKey !== null}
        onOpenChange={(open) => setRevokingKey(open ? revokingKey : null)}
        title={`Revoke organization API key “${revokingKey?.name ?? ""}”?`}
        description={
          revokingKey
            ? `All external-product calls using ${revokingKey.prefix}… stop immediately. Revocation can't be undone.`
            : undefined
        }
        confirmLabel="Revoke key"
        cancelAutoFocus
        restoreFocusRef={revokeTriggerRef}
        restoreFocusFallbackRef={keyListHeadingRef}
        onConfirm={() => (revokingKey ? revokeKey(revokingKey) : false)}
      />
    </div>
  );
}

function ScopeStep({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border px-3 py-2.5">
      <div className="flex items-center gap-2 text-xs font-medium text-fg">
        <span className="shrink-0 text-brand">{icon}</span>
        <span className="min-w-0 break-words">{title}</span>
      </div>
      <p className="mt-1 text-2xs leading-4 text-fg-subtle">{detail}</p>
    </div>
  );
}

function organizationQuickStart(organizationId: string): string {
  return `import { OpenGeniClient } from "@opengeni/sdk";

const client = new OpenGeniClient({
  baseUrl: process.env.OPENGENI_API_BASE_URL!,
  apiKey: process.env.OPENGENI_ORGANIZATION_API_KEY!,
});

const { workspace } = await client.ensureWorkspace({
  accountId: "${organizationId}",
  externalSource: "your-product",
  externalId: tenant.id,
  name: tenant.name,
});

await client.updateWorkspaceSettings(workspace.id, {
  memoryEnabled: true,
  agentHumanInputEnabled: true,
});

const session = await client.createSession(workspace.id, {
  initialMessage: userMessage,
  idempotencyKey: productRequest.id,
  skills: selectedSkills,
});`;
}

function apiKeyStatus(apiKey: ApiKey): "active" | "expired" | "revoked" {
  if (apiKey.revokedAt) return "revoked";
  if (apiKey.expiresAt && Date.parse(apiKey.expiresAt) <= Date.now()) return "expired";
  return "active";
}
