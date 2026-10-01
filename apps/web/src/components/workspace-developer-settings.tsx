import type {
  WorkspaceCredentialProvider,
  WorkspaceWebhook,
  WorkspaceWebhookDelivery,
  WorkspaceWebhookEventType,
} from "@opengeni/sdk";
import { PlusIcon, RotateCcwIcon, Trash2Icon, WebhookIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyField } from "@/components/ui/copy-field";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ErrorMessage } from "@/components/ui/error-message";
import { CheckboxField, Field, TextInput } from "@/components/ui/field";
import { ListRow, RowList } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { Notice } from "@/components/ui/notice";
import { RowButton } from "@/components/ui/page-actions";
import { RelativeTime } from "@/components/ui/relative-time";
import { Section, SectionStack } from "@/components/ui/section";
import { Select } from "@/components/ui/select";
import { SettingDangerRow, SettingRow, SettingRowSkeleton } from "@/components/ui/setting-row";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import type { SemanticTone } from "@/components/ui/status-dot";
import { Switch } from "@/components/ui/switch";
import { apiErrorAdvice, apiErrorDetails, isPermissionDenied } from "@/lib/api-error";
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

function eventLabel(type: string): string {
  return EVENT_OPTIONS.find((option) => option.type === type)?.label ?? type;
}

/**
 * A section's data: loading, ready, refused for this viewer (a permission they
 * lack, never an error), or failed.
 */
type Load<T> =
  | { kind: "loading" }
  | { kind: "ready"; value: T }
  | { kind: "denied" }
  | { kind: "failed"; error: unknown };

function loadFailure<T>(error: unknown): Load<T> {
  return isPermissionDenied(error) ? { kind: "denied" } : { kind: "failed", error };
}

/** A failed action: what happened as the title, what to do under it. */
function actionFailed(what: string, error: unknown) {
  toast.error(what, { description: apiErrorAdvice(error) });
}

/** A section's rows failed to load: one row with Try again, the reference in Technical details. */
function LoadFailure({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <ErrorMessage
      className="py-4"
      title={title}
      action={<RowButton onClick={onRetry}>Try again</RowButton>}
      {...apiErrorDetails(error)}
    >
      {apiErrorAdvice(error)}
    </ErrorMessage>
  );
}

/**
 * The viewer can't manage this: say who can, calmly. In a Personal workspace
 * nobody can, so point to a shared workspace instead.
 */
function Unavailable({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Notice tone="muted" title={title}>
      {children}
    </Notice>
  );
}

/** Shown once, right after creating a signing secret. */
function SecretNotice({ label, secret }: { label: string; secret: string }) {
  return (
    <Notice tone="success" title={`Copy this ${label} now. It won't be shown again.`}>
      <CopyField variant="field" className="mt-2" value={secret} label={label} />
    </Notice>
  );
}

const DELIVERY_STATUS: Record<
  WorkspaceWebhookDelivery["status"],
  { label: string; tone: SemanticTone }
> = {
  pending: { label: "Pending", tone: "neutral" },
  delivered: { label: "Delivered", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

function DeliveryList({
  client,
  workspaceId,
  webhookId,
  canManage,
}: {
  client: IntegrationsClient;
  workspaceId: string;
  webhookId: string;
  canManage: boolean;
}) {
  const [state, setState] = useState<Load<WorkspaceWebhookDelivery[]>>({ kind: "loading" });
  const load = useCallback(async () => {
    try {
      const response = await client.listWorkspaceWebhookDeliveries(workspaceId, webhookId, {
        limit: 10,
      });
      setState({ kind: "ready", value: response.deliveries });
    } catch (caught) {
      setState(loadFailure(caught));
    }
  }, [client, workspaceId, webhookId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === "loading") return <Skeleton className="h-4 w-48" />;
  if (state.kind === "denied") {
    return (
      <p className="text-xs leading-4.5 text-fg-muted">Only workspace admins can see deliveries.</p>
    );
  }
  if (state.kind === "failed") {
    return (
      <ErrorMessage
        variant="inline"
        title="Couldn't load deliveries."
        action={
          <button
            type="button"
            onClick={() => void load()}
            className="text-sm font-medium text-brand underline-offset-4 hover:underline"
          >
            Try again
          </button>
        }
        {...apiErrorDetails(state.error)}
      />
    );
  }
  if (state.value.length === 0) {
    return <p className="text-xs leading-4.5 text-fg-muted">No deliveries yet.</p>;
  }
  return (
    <ul aria-label="Recent deliveries" className="grid gap-1">
      {state.value.map((delivery) => {
        const status = DELIVERY_STATUS[delivery.status];
        const detail =
          delivery.lastError ?? (delivery.lastStatus ? `HTTP ${delivery.lastStatus}` : null);
        return (
          <li key={delivery.id} className="flex min-h-7 min-w-0 items-center gap-3 text-xs">
            <StatusBadge variant="dot" tone={status.tone} className="w-20 shrink-0">
              {status.label}
            </StatusBadge>
            <span className="shrink-0 text-fg">{eventLabel(delivery.eventType)}</span>
            {detail ? <span className="min-w-0 truncate text-fg-muted">{detail}</span> : null}
            <RelativeTime
              date={delivery.createdAt}
              className="ml-auto shrink-0 text-xs text-fg-subtle"
            />
            {canManage && delivery.status !== "pending" ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Send again"
                className="shrink-0"
                onClick={() =>
                  void client
                    .redeliverWorkspaceWebhookDelivery(workspaceId, webhookId, delivery.id)
                    .then(load)
                    .catch((caught: unknown) => actionFailed("Couldn't send it again", caught))
                }
              >
                <RotateCcwIcon aria-hidden="true" className="size-3.5" />
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function AddWebhookForm({
  onCancel,
  onAdd,
}: {
  onCancel: () => void;
  onAdd: (request: { url: string; eventTypes: WorkspaceWebhookEventType[] }) => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [eventTypes, setEventTypes] = useState<Set<WorkspaceWebhookEventType>>(
    () => new Set(["turn.completed", "turn.failed"]),
  );
  const [busy, setBusy] = useState(false);
  return (
    <form
      aria-label="Add webhook"
      className="flex min-w-0 flex-col gap-5 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void onAdd({ url: url.trim(), eventTypes: [...eventTypes] }).finally(() => setBusy(false));
      }}
    >
      <Field label="Endpoint URL" id="webhook-url" required>
        <TextInput
          type="url"
          required
          placeholder="https://example.com/opengeni/events"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          suppressAutofill
        />
      </Field>
      <fieldset className="min-w-0">
        <legend className="mb-2 text-sm font-medium text-fg">Send these events</legend>
        <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          {EVENT_OPTIONS.map((option) => (
            <CheckboxField
              key={option.type}
              label={option.label}
              checked={eventTypes.has(option.type)}
              onCheckedChange={(checked) => {
                const next = new Set(eventTypes);
                if (checked) next.add(option.type);
                else next.delete(option.type);
                setEventTypes(next);
              }}
            />
          ))}
        </div>
      </fieldset>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy || !url.trim() || eventTypes.size === 0}>
          {busy ? "Adding…" : "Add webhook"}
        </Button>
      </div>
    </form>
  );
}

function WebhooksSection({
  client,
  workspaceId,
  canManage,
  personal,
}: {
  client: IntegrationsClient;
  workspaceId: string;
  canManage: boolean;
  personal: boolean;
}) {
  const [state, setState] = useState<Load<WorkspaceWebhook[]>>({ kind: "loading" });
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [removing, setRemoving] = useState<WorkspaceWebhook | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await client.listWorkspaceWebhooks(workspaceId);
      setState({ kind: "ready", value: response.webhooks });
    } catch (caught) {
      setState(loadFailure(caught));
    }
  }, [client, workspaceId]);
  useEffect(() => {
    void load();
  }, [load]);

  const add = async (request: { url: string; eventTypes: WorkspaceWebhookEventType[] }) => {
    try {
      const created = await client.createWorkspaceWebhook(workspaceId, request);
      setSecret(created.secret);
      setAdding(false);
      await load();
    } catch (caught) {
      actionFailed("Couldn't add the webhook", caught);
    }
  };

  const setEnabled = (webhook: WorkspaceWebhook, enabled: boolean) => {
    setToggling(webhook.id);
    void client
      .updateWorkspaceWebhook(workspaceId, webhook.id, { enabled })
      .then(load)
      .catch((caught: unknown) =>
        actionFailed(
          enabled ? "Couldn't resume the webhook" : "Couldn't pause the webhook",
          caught,
        ),
      )
      .finally(() => setToggling(null));
  };

  const webhooks = state.kind === "ready" ? state.value : [];
  const addButton = (
    <Button type="button" size="sm" onClick={() => setAdding(true)}>
      <PlusIcon aria-hidden="true" />
      Add webhook
    </Button>
  );

  let rows: ReactNode;
  if (state.kind === "loading") {
    rows = <SettingRowSkeleton />;
  } else if (state.kind === "denied") {
    rows = personal ? (
      <Unavailable title="Webhooks aren't available in a Personal workspace.">
        Add them in a shared workspace, where workspace admins manage them.
      </Unavailable>
    ) : (
      <Unavailable title="Only workspace admins can manage webhooks.">
        Ask a workspace admin for access.
      </Unavailable>
    );
  } else if (state.kind === "failed") {
    rows = <LoadFailure title="Couldn't load webhooks." error={state.error} onRetry={load} />;
  } else if (webhooks.length === 0) {
    rows = adding ? null : (
      <SettingRow
        label="No webhooks yet"
        description={
          canManage
            ? "Add an endpoint to hear about finished work without polling."
            : "A workspace admin can add an endpoint that hears about finished work."
        }
        control={canManage ? addButton : undefined}
      />
    );
  } else {
    rows = (
      <RowList label="Webhooks" flush>
        {webhooks.map((webhook) => (
          <ListRow
            key={webhook.id}
            leading={<LogoTile icon={<WebhookIcon />} />}
            title={webhook.url}
            description={webhook.eventTypes.map(eventLabel).join(" · ")}
            indicator="expand"
            expanded={expanded === webhook.id}
            onOpen={() => setExpanded(expanded === webhook.id ? null : webhook.id)}
            panel={
              <DeliveryList
                client={client}
                workspaceId={workspaceId}
                webhookId={webhook.id}
                canManage={canManage}
              />
            }
            control={
              canManage ? (
                <Switch
                  size="sm"
                  aria-label={`Send events to ${webhook.url}`}
                  checked={webhook.enabled}
                  pending={toggling === webhook.id}
                  onCheckedChange={(enabled) => setEnabled(webhook, enabled)}
                />
              ) : undefined
            }
            menuLabel={`Actions for ${webhook.url}`}
            menu={
              canManage ? (
                <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(webhook)}>
                  <Trash2Icon aria-hidden="true" />
                  Remove
                </DropdownMenuItem>
              ) : undefined
            }
          />
        ))}
      </RowList>
    );
  }

  return (
    <>
      <Section
        title="Webhooks"
        description="Get a signed request when a turn finishes or the agent needs someone."
        action={canManage && !adding && webhooks.length > 0 ? addButton : undefined}
      >
        {secret ? <SecretNotice label="signing secret" secret={secret} /> : null}
        {adding ? <AddWebhookForm onCancel={() => setAdding(false)} onAdd={add} /> : null}
        {rows}
      </Section>
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
    </>
  );
}

function CredentialProviderSection({
  client,
  workspaceId,
  canManage,
  personal,
}: {
  client: IntegrationsClient;
  workspaceId: string;
  canManage: boolean;
  personal: boolean;
}) {
  const [state, setState] = useState<Load<WorkspaceCredentialProvider | null>>({
    kind: "loading",
  });
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await client.getWorkspaceCredentialProvider(workspaceId);
      setState({ kind: "ready", value: response.provider });
      setUrl(response.provider?.url ?? "");
    } catch (caught) {
      setState(loadFailure(caught));
    }
  }, [client, workspaceId]);
  useEffect(() => {
    void load();
  }, [load]);

  const provider = state.kind === "ready" ? state.value : null;
  const save = async (next: { url: string; enabled: boolean }) => {
    setBusy(true);
    try {
      const response = await client.putWorkspaceCredentialProvider(workspaceId, next);
      if (response.secret) setSecret(response.secret);
      setState({ kind: "ready", value: response.provider });
      toast.success(provider ? "Credential provider saved" : "Credential provider connected");
    } catch (caught) {
      actionFailed("Couldn't save the credential provider", caught);
    } finally {
      setBusy(false);
    }
  };

  let rows: ReactNode;
  if (state.kind === "loading") {
    rows = <SettingRowSkeleton />;
  } else if (state.kind === "denied") {
    rows = personal ? (
      <Unavailable title="A credential provider isn't available in a Personal workspace.">
        Set one up in a shared workspace, where workspace admins manage it.
      </Unavailable>
    ) : (
      <Unavailable title="Only workspace admins can manage the credential provider.">
        Ask a workspace admin for access.
      </Unavailable>
    );
  } else if (state.kind === "failed") {
    rows = (
      <LoadFailure
        title="Couldn't load the credential provider."
        error={state.error}
        onRetry={load}
      />
    );
  } else {
    const trimmed = url.trim();
    const changed = trimmed !== (provider?.url ?? "");
    rows = (
      <>
        <form
          aria-label="Credential provider endpoint"
          className="py-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save({ url: trimmed, enabled: provider?.enabled ?? true });
          }}
        >
          <Field
            label="Endpoint URL"
            id="credential-provider-url"
            hint={
              canManage
                ? provider
                  ? undefined
                  : "Runs use the deployment's credentials until you connect one."
                : "Only workspace admins can change this."
            }
          >
            <div className="flex min-w-0 gap-2">
              <TextInput
                type="url"
                required
                disabled={!canManage}
                placeholder="https://example.com/opengeni/credentials"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                suppressAutofill
              />
              {canManage && (!provider || changed) ? (
                <Button
                  type="submit"
                  className="shrink-0 pointer-coarse:h-11"
                  disabled={busy || !trimmed}
                >
                  {provider ? "Save" : "Connect"}
                </Button>
              ) : null}
            </div>
          </Field>
        </form>
        {provider ? (
          <SettingRow
            label="Use this endpoint"
            description="Runs in this workspace request their credentials from it. Off, they use the deployment's credentials."
            control={
              <Switch
                checked={provider.enabled}
                pending={busy}
                disabled={!canManage}
                disabledReason={canManage ? undefined : "Only workspace admins can change this."}
                onCheckedChange={(enabled) => void save({ url: provider.url, enabled })}
              />
            }
          />
        ) : null}
        {provider && canManage ? (
          <SettingDangerRow
            label="Remove credential provider"
            description="Its signing secret is deleted."
            disabled={busy}
            onClick={() => setRemoving(true)}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      <Section
        title="Credential provider"
        description="Your service hands the agent short-lived credentials for each run. Opengeni renews them before they expire."
      >
        {secret ? <SecretNotice label="signing secret" secret={secret} /> : null}
        {rows}
      </Section>
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
    </>
  );
}

export function WorkspaceDeveloperSettings({
  client,
  workspaceId,
  canManage,
  personal = false,
}: {
  client: IntegrationsClient;
  workspaceId: string;
  canManage: boolean;
  /** A Personal workspace: nobody administers it, so say where these live instead. */
  personal?: boolean;
}) {
  return (
    <SectionStack>
      <WebhooksSection
        client={client}
        workspaceId={workspaceId}
        canManage={canManage}
        personal={personal}
      />
      <CredentialProviderSection
        client={client}
        workspaceId={workspaceId}
        canManage={canManage}
        personal={personal}
      />
    </SectionStack>
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
    <SettingRow
      label="Sandbox image"
      description="The machine image new sandboxes in this workspace start from."
      controlWidth="select"
      control={
        <Select
          id="workspace-sandbox-image"
          aria-label="Sandbox image"
          className="h-8 bg-surface"
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
              .catch((caught: unknown) => actionFailed("Couldn't save the sandbox image", caught))
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
      }
    />
  );
}
