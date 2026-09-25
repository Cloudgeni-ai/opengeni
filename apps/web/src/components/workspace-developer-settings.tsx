import type {
  WorkspaceCredentialProvider,
  WorkspaceWebhook,
  WorkspaceWebhookDelivery,
  WorkspaceWebhookEventType,
} from "@opengeni/sdk";
import {
  CopyIcon,
  KeyRoundIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
  WebhookIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { LoadErrorState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

type IntegrationsClient = Pick<
  OpenGeniBrowserClient,
  | "listWorkspaceWebhooks"
  | "createWorkspaceWebhook"
  | "updateWorkspaceWebhook"
  | "deleteWorkspaceWebhook"
  | "listWorkspaceWebhookDeliveries"
  | "redeliverWorkspaceWebhookDelivery"
  | "getWorkspaceCredentialProvider"
  | "putWorkspaceCredentialProvider"
  | "deleteWorkspaceCredentialProvider"
  | "listWorkspaceSandboxImages"
  | "updateWorkspaceSettings"
>;

const EVENT_OPTIONS: ReadonlyArray<{ type: WorkspaceWebhookEventType; label: string }> = [
  { type: "turn.completed", label: "Turn completed" },
  { type: "turn.failed", label: "Turn failed" },
  { type: "turn.cancelled", label: "Turn cancelled" },
  { type: "session.status.changed", label: "Status changed" },
  { type: "session.requiresAction", label: "Needs approval" },
  { type: "session.humanInput.requested", label: "Question for the user" },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

function SecretNotice({ label, secret }: { label: string; secret: string }) {
  return (
    <Notice tone="success" title={`Copy this ${label} now — it won't be shown again.`}>
      <div className="mt-2 flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-bg px-2 py-1.5 text-xs text-fg">
          {secret}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Copy ${label}`}
          onClick={() =>
            void navigator.clipboard.writeText(secret).then(() => toast.success("Copied"))
          }
        >
          <CopyIcon className="size-3.5" />
        </Button>
      </div>
    </Notice>
  );
}

function DeliveryList({
  client,
  workspaceId,
  webhookId,
}: {
  client: IntegrationsClient;
  workspaceId: string;
  webhookId: string;
}) {
  const [deliveries, setDeliveries] = useState<WorkspaceWebhookDelivery[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const load = useCallback(async () => {
    try {
      const response = await client.listWorkspaceWebhookDeliveries(workspaceId, webhookId, {
        limit: 10,
      });
      setDeliveries(response.deliveries);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(errorMessage(caught)));
    }
  }, [client, workspaceId, webhookId]);
  useEffect(() => {
    void load();
  }, [load]);
  if (error)
    return <LoadErrorState title="Couldn't load deliveries" error={error} onRetry={load} />;
  if (!deliveries) return <Skeleton className="h-4 w-40" />;
  if (deliveries.length === 0) {
    return <p className="text-2xs text-fg-subtle">No deliveries yet.</p>;
  }
  return (
    <ul className="grid gap-1">
      {deliveries.map((delivery) => (
        <li key={delivery.id} className="flex min-w-0 items-center gap-2 text-2xs">
          <span
            className={
              delivery.status === "delivered"
                ? "text-status-completed"
                : delivery.status === "failed"
                  ? "text-status-failed"
                  : "text-fg-muted"
            }
          >
            {delivery.status}
          </span>
          <span className="truncate text-fg-muted">{delivery.eventType}</span>
          <span className="truncate text-fg-subtle">
            {delivery.lastError ?? (delivery.lastStatus ? `HTTP ${delivery.lastStatus}` : "")}
          </span>
          <span className="ml-auto shrink-0 text-fg-subtle">
            {new Date(delivery.createdAt).toLocaleString()}
          </span>
          {delivery.status !== "pending" ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Send again"
              onClick={() =>
                void client
                  .redeliverWorkspaceWebhookDelivery(workspaceId, webhookId, delivery.id)
                  .then(load)
                  .catch((caught: unknown) => toast.error(errorMessage(caught)))
              }
            >
              <RotateCcwIcon className="size-3" />
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function WebhooksSection({
  client,
  workspaceId,
  canManage,
}: {
  client: IntegrationsClient;
  workspaceId: string;
  canManage: boolean;
}) {
  const [webhooks, setWebhooks] = useState<WorkspaceWebhook[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [eventTypes, setEventTypes] = useState<Set<WorkspaceWebhookEventType>>(
    () => new Set(["turn.completed", "turn.failed"]),
  );
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [removing, setRemoving] = useState<WorkspaceWebhook | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setWebhooks((await client.listWorkspaceWebhooks(workspaceId)).webhooks);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(errorMessage(caught)));
    }
  }, [client, workspaceId]);
  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const created = await client.createWorkspaceWebhook(workspaceId, {
        url: url.trim(),
        eventTypes: [...eventTypes],
      });
      setSecret(created.secret);
      setAdding(false);
      setUrl("");
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="grid gap-3" aria-labelledby="workspace-webhooks-heading">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2
            id="workspace-webhooks-heading"
            className="flex items-center gap-2 text-sm font-medium"
          >
            <WebhookIcon className="size-3.5 text-brand" />
            Webhooks
          </h2>
          <p className="mt-1 text-xs text-fg-muted">
            Get a signed request when a turn finishes or the agent needs someone.
          </p>
        </div>
        {canManage && !adding ? (
          <Button type="button" size="sm" onClick={() => setAdding(true)}>
            <PlusIcon className="size-3.5" />
            Add webhook
          </Button>
        ) : null}
      </div>
      {secret ? <SecretNotice label="signing secret" secret={secret} /> : null}
      {adding ? (
        <form
          className="grid gap-3 rounded-lg border border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="webhook-url">Endpoint URL</Label>
            <Input
              id="webhook-url"
              type="url"
              required
              placeholder="https://example.com/opengeni/events"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1 text-xs font-medium">Send these events</legend>
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {EVENT_OPTIONS.map((option) => (
                <label key={option.type} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--color-brand)]"
                    checked={eventTypes.has(option.type)}
                    onChange={(event) => {
                      const next = new Set(eventTypes);
                      if (event.target.checked) next.add(option.type);
                      else next.delete(option.type);
                      setEventTypes(next);
                    }}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy || !url.trim() || eventTypes.size === 0}>
              {busy ? "Adding…" : "Add webhook"}
            </Button>
          </div>
        </form>
      ) : null}
      <div className="divide-y divide-border/70 overflow-hidden rounded-lg border border-border">
        {error ? (
          <div className="p-2">
            <LoadErrorState title="Couldn't load webhooks" error={error} onRetry={load} />
          </div>
        ) : !webhooks ? (
          <div className="px-3 py-2">
            <Skeleton className="h-4 w-48" />
          </div>
        ) : webhooks.length === 0 ? (
          <div className="p-2">
            <EmptyState
              title="No webhooks yet"
              description="Add an endpoint to hear about finished work without polling."
            />
          </div>
        ) : (
          webhooks.map((webhook) => (
            <div key={webhook.id} className="grid gap-2 px-3 py-2">
              <div className="flex min-w-0 items-center gap-3">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  aria-expanded={expanded === webhook.id}
                  onClick={() => setExpanded(expanded === webhook.id ? null : webhook.id)}
                >
                  <div className="truncate text-sm font-medium">{webhook.url}</div>
                  <div className="truncate text-2xs text-fg-subtle">
                    {webhook.enabled ? "" : "Paused · "}
                    {webhook.eventTypes
                      .map(
                        (type) =>
                          EVENT_OPTIONS.find((option) => option.type === type)?.label ?? type,
                      )
                      .join(" · ")}
                  </div>
                </button>
                {canManage ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void client
                        .updateWorkspaceWebhook(workspaceId, webhook.id, {
                          enabled: !webhook.enabled,
                        })
                        .then(load)
                        .catch((caught: unknown) => toast.error(errorMessage(caught)))
                    }
                  >
                    {webhook.enabled ? "Pause" : "Resume"}
                  </Button>
                ) : null}
                {canManage ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove webhook"
                    onClick={() => setRemoving(webhook)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                ) : null}
              </div>
              {expanded === webhook.id ? (
                <DeliveryList client={client} workspaceId={workspaceId} webhookId={webhook.id} />
              ) : null}
            </div>
          ))
        )}
      </div>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
        title="Remove webhook?"
        description="Pending deliveries to this endpoint are dropped."
        confirmLabel="Remove"
        onConfirm={async () => {
          if (!removing) return;
          await client.deleteWorkspaceWebhook(workspaceId, removing.id);
          setRemoving(null);
          await load();
        }}
      />
    </section>
  );
}

function CredentialProviderSection({
  client,
  workspaceId,
  canManage,
}: {
  client: IntegrationsClient;
  workspaceId: string;
  canManage: boolean;
}) {
  const [provider, setProvider] = useState<WorkspaceCredentialProvider | null | undefined>(
    undefined,
  );
  const [error, setError] = useState<Error | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await client.getWorkspaceCredentialProvider(workspaceId);
      setProvider(response.provider);
      setUrl(response.provider?.url ?? "");
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(errorMessage(caught)));
    }
  }, [client, workspaceId]);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async (enabled: boolean) => {
    setBusy(true);
    try {
      const response = await client.putWorkspaceCredentialProvider(workspaceId, {
        url: url.trim(),
        enabled,
      });
      if (response.secret) setSecret(response.secret);
      setProvider(response.provider);
      toast.success("Credential provider saved");
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="grid gap-3" aria-labelledby="workspace-credential-provider-heading">
      <div>
        <h2
          id="workspace-credential-provider-heading"
          className="flex items-center gap-2 text-sm font-medium"
        >
          <KeyRoundIcon className="size-3.5 text-brand" />
          Credential provider
        </h2>
        <p className="mt-1 text-xs text-fg-muted">
          Your service hands the agent short-lived credentials for each run. OpenGeni renews them
          before they expire.
        </p>
      </div>
      {secret ? <SecretNotice label="signing secret" secret={secret} /> : null}
      {error ? (
        <LoadErrorState
          title="Couldn't load the credential provider"
          error={error}
          onRetry={load}
        />
      ) : provider === undefined ? (
        <Skeleton className="h-9 w-full" />
      ) : (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save(provider?.enabled ?? true);
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="credential-provider-url">Endpoint URL</Label>
            <div className="flex gap-2">
              <Input
                id="credential-provider-url"
                type="url"
                required
                disabled={!canManage}
                placeholder="https://example.com/opengeni/credentials"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
              {canManage ? (
                <Button
                  type="submit"
                  size="sm"
                  disabled={busy || !url.trim() || url.trim() === provider?.url}
                >
                  {provider ? "Save" : "Connect"}
                </Button>
              ) : null}
            </div>
          </div>
          {provider ? (
            <div className="flex items-center gap-3">
              <p className="min-w-0 flex-1 text-2xs text-fg-subtle">
                {provider.enabled
                  ? "Runs in this workspace request credentials from this endpoint."
                  : "Paused. Runs use the deployment's credentials."}
              </p>
              {canManage ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void save(!provider.enabled)}
                  >
                    {provider.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setRemoving(true)}>
                    Remove
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}
        </form>
      )}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="Remove credential provider?"
        description="New runs stop receiving credentials from this endpoint. Its signing secret is deleted."
        confirmLabel="Remove"
        onConfirm={async () => {
          await client.deleteWorkspaceCredentialProvider(workspaceId);
          setRemoving(false);
          setSecret(null);
          await load();
        }}
      />
    </section>
  );
}

export function WorkspaceDeveloperSettings({
  client,
  workspaceId,
  canManage,
}: {
  client: IntegrationsClient;
  workspaceId: string;
  canManage: boolean;
}) {
  return (
    <div className="grid gap-8">
      <WebhooksSection client={client} workspaceId={workspaceId} canManage={canManage} />
      <CredentialProviderSection client={client} workspaceId={workspaceId} canManage={canManage} />
    </div>
  );
}

/** Hidden unless the deployment allowlists images a workspace may pick. */
export function WorkspaceSandboxImageRow({
  client,
  workspaceId,
  canManage,
}: {
  client: IntegrationsClient;
  workspaceId: string;
  canManage: boolean;
}) {
  const [images, setImages] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void client
      .listWorkspaceSandboxImages(workspaceId)
      .then((response) => {
        if (cancelled) return;
        setImages(response.images);
        setSelected(response.selected);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId]);
  if (images.length === 0) return null;
  return (
    <div className="flex min-h-10 items-center gap-3 px-1 py-1.5">
      <div className="min-w-0 flex-1">
        <Label htmlFor="workspace-sandbox-image" className="text-sm font-medium">
          Sandbox image
        </Label>
        <p className="truncate text-2xs text-fg-subtle">
          The machine image new sandboxes in this workspace start from.
        </p>
      </div>
      <Select
        id="workspace-sandbox-image"
        className="max-w-72"
        disabled={!canManage || saving}
        value={selected ?? ""}
        onChange={(event) => {
          const next = event.target.value || null;
          setSaving(true);
          void client
            .updateWorkspaceSettings(workspaceId, { defaultSandboxImage: next })
            .then(() => {
              setSelected(next);
              toast.success("Sandbox image saved. Existing sandboxes switch at their next run.");
            })
            .catch((caught: unknown) => toast.error(errorMessage(caught)))
            .finally(() => setSaving(false));
        }}
      >
        <option value="">Deployment default</option>
        {images.map((image) => (
          <option key={image} value={image}>
            {image}
          </option>
        ))}
      </Select>
    </div>
  );
}
