// Developer > Webhooks: the list (a settings card), one page per webhook with
// its deliveries and Send test event, and the Add / Edit webhook form page.
import type {
  IntegrationEndpointTestResult,
  IntegrationWorkspaceFilter,
  WorkspaceInheritedIntegrationsResponse,
  WorkspaceWebhookDelivery,
  WorkspaceWebhookEventType,
} from "@opengeni/sdk";
import {
  CalendarIcon,
  KeyRoundIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  SendIcon,
  Trash2Icon,
  WebhookIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import {
  DetailAside,
  DetailAsideItem,
  DetailPage,
  DetailPageBody,
  DetailPageHeader,
} from "@/components/ui/detail-page";
import { DetailSection } from "@/components/ui/detail-sheet";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { CheckboxField, Field, FieldStack, TextInput } from "@/components/ui/field";
import { FormPage } from "@/components/ui/form-dialog";
import { FLUSH_DETAIL_PAGE_CLASS, FLUSH_FORM_PAGE_CLASS } from "@/components/ui/flush-form-page";
import { InlineHelp } from "@/components/ui/inline-help";
import { ListRow, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { MoreMenu, RowButton } from "@/components/ui/page-actions";
import { RelativeTime } from "@/components/ui/relative-time";
import { SecretOnce } from "@/components/ui/secret-field";
import { Section } from "@/components/ui/section";
import { SettingRow, SettingRowSkeleton } from "@/components/ui/setting-row";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import type { SemanticTone } from "@/components/ui/status-dot";
import { userErrorText } from "@/lib/api-error";

import type { DeveloperIntegrationsApi, IntegrationWebhook } from "./integrations-api";
import {
  actionFailed,
  dateLabel,
  displayUrl,
  ExternalLink,
  LoadFailure,
  Unavailable,
  urlHost,
  untilLabel,
  useLoad,
  workspaceFilterLabel,
  type Load,
} from "./shared";
import { CodeSample, EndpointTestResult, WEBHOOKS_GUIDE_URL } from "./test-result";
import { WorkspaceFilterField } from "./workspace-filter-field";
import {
  DEFAULT_WEBHOOK_EVENTS,
  WEBHOOK_EVENT_GROUPS,
  webhookEventLabel,
  webhookEventsSummary,
} from "./webhook-events";

const MAX_ATTEMPTS = 12;
const RECENT_DELIVERIES = 25;

/* ----------------------------------------------------------------------------
   Health: only what needs attention is shown.
   -------------------------------------------------------------------------- */

export type WebhookHealth =
  | { kind: "paused" }
  | { kind: "failing"; delivery: WorkspaceWebhookDelivery }
  | { kind: "retrying"; delivery: WorkspaceWebhookDelivery }
  | { kind: "healthy"; delivery: WorkspaceWebhookDelivery }
  | { kind: "unused" };

/** The newest delivery that was tried decides; a paused endpoint says so first. */
export function webhookHealth(
  webhook: Pick<IntegrationWebhook, "enabled">,
  deliveries: readonly WorkspaceWebhookDelivery[] | null,
): WebhookHealth {
  if (!webhook.enabled) return { kind: "paused" };
  const tried = deliveries?.find(
    (delivery) => delivery.status !== "pending" || delivery.attempts > 0,
  );
  if (!tried) return { kind: "unused" };
  if (tried.status === "failed") return { kind: "failing", delivery: tried };
  if (tried.status === "pending") return { kind: "retrying", delivery: tried };
  return { kind: "healthy", delivery: tried };
}

function lastTriedAt(delivery: WorkspaceWebhookDelivery): string {
  return delivery.deliveredAt ?? delivery.failedAt ?? delivery.createdAt;
}

function HealthBadge({ health, variant }: { health: WebhookHealth; variant: "dot" | "outline" }) {
  if (health.kind === "paused") {
    return (
      <StatusBadge status="paused" variant={variant}>
        Paused
      </StatusBadge>
    );
  }
  if (health.kind === "failing") {
    return (
      <StatusBadge tone="danger" variant={variant}>
        Failing
      </StatusBadge>
    );
  }
  if (health.kind === "retrying") {
    return (
      <StatusBadge tone="progress" variant={variant} pulse={false}>
        Retrying
      </StatusBadge>
    );
  }
  return null;
}

/* ----------------------------------------------------------------------------
   The list, as a settings card.
   -------------------------------------------------------------------------- */

const COLUMNS: RowListColumn[] = [{ id: "last", label: "Last sent", width: 116 }];

function useLatestDeliveries(api: DeveloperIntegrationsApi, webhooks: IntegrationWebhook[] | null) {
  const [byId, setById] = useState<Record<string, WorkspaceWebhookDelivery[] | null>>({});
  useEffect(() => {
    if (!webhooks) return;
    let cancelled = false;
    void Promise.all(
      webhooks.map(async (webhook) => {
        try {
          return [webhook.id, await api.listDeliveries(webhook.id, 10)] as const;
        } catch {
          return [webhook.id, null] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setById(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [api, webhooks]);
  return byId;
}

function InheritedWebhooksLine({
  inherited,
  organizationSettingsHref,
}: {
  inherited: WorkspaceInheritedIntegrationsResponse["webhooks"];
  organizationSettingsHref?: (() => void) | undefined;
}) {
  if (inherited.length === 0) return null;
  const hosts = [...new Set(inherited.map((webhook) => urlHost(webhook.url)))];
  return (
    <div className="py-3">
      <InlineHelp
        icon
        action={
          organizationSettingsHref ? (
            <button
              type="button"
              onClick={organizationSettingsHref}
              className="rounded-sm font-medium text-brand underline-offset-2 hover:underline"
            >
              Organization settings
            </button>
          ) : undefined
        }
      >
        {inherited.length === 1
          ? "An organization webhook also gets"
          : `${inherited.length} organization webhooks also get`}{" "}
        this workspace's events ({hosts.join(", ")}).
      </InlineHelp>
    </div>
  );
}

export function WebhooksSection({
  api,
  canManage,
  personal,
  inherited,
  onOpen,
  onAdd,
  onOpenOrganizationSettings,
}: {
  api: DeveloperIntegrationsApi;
  canManage: boolean;
  personal: boolean;
  inherited: WorkspaceInheritedIntegrationsResponse["webhooks"];
  onOpen: (webhook: IntegrationWebhook) => void;
  onAdd: () => void;
  onOpenOrganizationSettings?: (() => void) | undefined;
}) {
  const read = useCallback(() => api.listWebhooks(), [api]);
  const [state, reload] = useLoad(read);
  const webhooks = state.kind === "ready" ? state.value : null;
  const deliveries = useLatestDeliveries(api, webhooks);
  const organization = api.scope === "organization";
  const scopeWord = organization ? "organization" : "workspace";

  const addButton = (
    <Button type="button" size="sm" onClick={onAdd}>
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
      <Unavailable title={`Only ${scopeWord} admins can manage webhooks.`}>
        Ask {organization ? "an organization" : "a workspace"} admin for access.
      </Unavailable>
    );
  } else if (state.kind === "failed") {
    rows = <LoadFailure title="Couldn't load webhooks." error={state.error} onRetry={reload} />;
  } else if (state.value.length === 0) {
    rows = (
      <SettingRow
        label="No webhooks yet"
        description={
          canManage
            ? "Add your endpoint to hear when work finishes or the agent needs someone."
            : `${organization ? "An organization" : "A workspace"} admin can add an endpoint here.`
        }
        control={canManage ? addButton : undefined}
      />
    );
  } else {
    rows = (
      <RowList label="Webhooks" columns={COLUMNS} nameLabel="Endpoint" flush>
        {state.value.map((webhook) => {
          const recent = deliveries[webhook.id] ?? null;
          const health = webhookHealth(webhook, recent);
          const last =
            health.kind === "failing" || health.kind === "retrying" || health.kind === "healthy"
              ? health.delivery
              : null;
          return (
            <ListRow
              key={webhook.id}
              leading={<LogoTile icon={<WebhookIcon />} />}
              title={displayUrl(webhook.url)}
              status={<HealthBadge health={health} variant="dot" />}
              description={
                organization
                  ? `${workspaceFilterLabel(webhook.workspaceFilter)} · ${webhookEventsSummary(webhook.eventTypes, 1)}`
                  : webhookEventsSummary(webhook.eventTypes, 1)
              }
              cells={{
                last: last ? (
                  <RelativeTime date={lastTriedAt(last)} />
                ) : recent ? (
                  <span className="text-fg-subtle">None yet</span>
                ) : null,
              }}
              indicator="open"
              onOpen={() => onOpen(webhook)}
            />
          );
        })}
      </RowList>
    );
  }

  return (
    <Section
      title="Webhooks"
      description={
        organization
          ? "Your endpoint gets a signed POST for events in the shared workspaces you choose."
          : "Your endpoint gets a signed POST when something happens here, so your product doesn't have to poll."
      }
      action={canManage && webhooks && webhooks.length > 0 ? addButton : undefined}
    >
      {rows}
      {!organization ? (
        <InheritedWebhooksLine
          inherited={inherited}
          organizationSettingsHref={onOpenOrganizationSettings}
        />
      ) : null}
    </Section>
  );
}

/* ----------------------------------------------------------------------------
   A webhook's page.
   -------------------------------------------------------------------------- */

const DELIVERY_TONE: Record<"delivered" | "failed" | "retrying" | "queued", SemanticTone> = {
  delivered: "success",
  failed: "danger",
  retrying: "progress",
  queued: "neutral",
};

function deliveryState(delivery: WorkspaceWebhookDelivery) {
  if (delivery.status === "delivered") return "delivered" as const;
  if (delivery.status === "failed") return "failed" as const;
  return delivery.attempts > 0 ? ("retrying" as const) : ("queued" as const);
}

const DELIVERY_LABEL = {
  delivered: "Delivered",
  failed: "Failed",
  retrying: "Retrying",
  queued: "Queued",
} as const;

function deliveryDetail(delivery: WorkspaceWebhookDelivery, paused: boolean): ReactNode {
  const answer = delivery.lastStatus ? `HTTP ${delivery.lastStatus}` : delivery.lastError;
  const state = deliveryState(delivery);
  if (state === "delivered") return answer;
  if (state === "failed") {
    return `${answer ?? "No answer"} · gave up after ${delivery.attempts} attempts`;
  }
  if (paused) return "Waiting until you resume the webhook";
  if (state === "queued") return "Sending soon";
  return (
    <>
      {answer ?? "No answer"} · attempt {delivery.attempts} of {MAX_ATTEMPTS}
      {delivery.nextAttemptAt ? ` · next try ${untilLabel(delivery.nextAttemptAt)}` : null}
    </>
  );
}

function DeliveryRows({
  deliveries,
  paused,
  canManage,
  onRedeliver,
}: {
  deliveries: WorkspaceWebhookDelivery[];
  paused: boolean;
  canManage: boolean;
  onRedeliver: (delivery: WorkspaceWebhookDelivery) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <ul aria-label="Recent deliveries" className="m-0 grid list-none p-0">
      {deliveries.map((delivery) => {
        const state = deliveryState(delivery);
        return (
          <li
            key={delivery.id}
            className="flex min-h-12 min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-border py-2 last:border-b-0"
          >
            <StatusBadge
              variant="dot"
              tone={DELIVERY_TONE[state]}
              pulse={false}
              className="w-20 shrink-0"
            >
              {DELIVERY_LABEL[state]}
            </StatusBadge>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm leading-5 text-fg">
                {webhookEventLabel(delivery.eventType)}
              </span>
              <span className="text-xs leading-4.5 text-fg-muted">
                {deliveryDetail(delivery, paused)}
              </span>
            </div>
            <RelativeTime
              date={lastTriedAt(delivery)}
              className="shrink-0 text-xs text-fg-subtle"
            />
            {canManage && state !== "queued" && state !== "retrying" ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Send ${webhookEventLabel(delivery.eventType)} again`}
                title="Send again"
                disabled={busy === delivery.id}
                className="shrink-0 pointer-coarse:size-11"
                onClick={() => {
                  setBusy(delivery.id);
                  void onRedeliver(delivery).finally(() => setBusy(null));
                }}
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

function verifySnippet(): string {
  return `import { verifyWebhookEvent } from "@opengeni/sdk";

// Use the raw body: verify before parsing.
const { event } = await verifyWebhookEvent({
  body: await request.text(),
  headers: request.headers,
  secret: process.env.OPENGENI_WEBHOOK_SECRET!,
});
if (event.type === "webhook.test") return new Response(null, { status: 204 });
// Delivery is at least once: skip an event.id you already handled.`;
}

function PageSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex min-w-0 flex-col gap-8">
      <div className="flex items-start gap-4">
        <Skeleton className="size-10 rounded-[10px]" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
      </div>
      <Skeleton className="h-24 w-full rounded-[14px]" />
    </div>
  );
}

export function WebhookPage({
  api,
  webhookId,
  canManage,
  backLabel,
  onBack,
  onEdit,
}: {
  api: DeveloperIntegrationsApi;
  webhookId: string;
  canManage: boolean;
  backLabel: string;
  onBack: () => void;
  onEdit: () => void;
}) {
  const readWebhook = useCallback(
    async () => (await api.listWebhooks()).find((webhook) => webhook.id === webhookId) ?? null,
    [api, webhookId],
  );
  const [state, , setWebhook] = useLoad(readWebhook);
  const readDeliveries = useCallback(
    () => api.listDeliveries(webhookId, RECENT_DELIVERIES),
    [api, webhookId],
  );
  const [deliveries, reloadDeliveries] = useLoad(readDeliveries);
  const [test, setTest] = useState<{ result: IntegrationEndpointTestResult; at: Date } | null>(
    null,
  );
  const [testing, setTesting] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const back = { label: backLabel, onClick: onBack };

  if (state.kind === "loading") {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        <PageSkeleton label="Loading webhook" />
      </DetailPage>
    );
  }
  if (state.kind !== "ready" || !state.value) {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        <EmptyState
          variant="page"
          icon={<WebhookIcon />}
          title={
            state.kind === "denied" ? "Only admins can see webhooks" : "This webhook isn't here"
          }
          description={
            state.kind === "failed"
              ? `Couldn't load it. ${userErrorText(state.error, "Try again.")}`
              : state.kind === "denied"
                ? "Ask an admin for access."
                : "It may have been removed, or the link is wrong."
          }
          action={
            <Button type="button" variant="outline" onClick={onBack}>
              Back to {backLabel}
            </Button>
          }
        />
      </DetailPage>
    );
  }

  const webhook = state.value;
  const recent = deliveries.kind === "ready" ? deliveries.value : null;
  const health = webhookHealth(webhook, recent);
  const organization = api.scope === "organization";

  const setEnabled = async (enabled: boolean) => {
    setToggling(true);
    try {
      setWebhook(await api.updateWebhook(webhook.id, { enabled }));
      toast(enabled ? "Webhook resumed" : "Webhook paused", {
        description: enabled
          ? "Queued events go out now."
          : "Events queue up and go out when you resume it.",
      });
    } catch (error) {
      actionFailed(enabled ? "Couldn't resume the webhook" : "Couldn't pause the webhook", error);
    } finally {
      setToggling(false);
    }
  };

  const sendTest = async () => {
    if (!api.testWebhook) return;
    setTesting(true);
    try {
      setTest({ result: await api.testWebhook(webhook.id), at: new Date() });
    } catch (error) {
      actionFailed("Couldn't send a test event", error);
    } finally {
      setTesting(false);
    }
  };

  const rotate = async () => {
    try {
      setSecret(await api.rotateWebhookSecret(webhook.id));
    } catch (error) {
      actionFailed("Couldn't create a new signing secret", error);
    }
  };

  const paused = !webhook.enabled;
  const primary = !canManage ? null : paused ? (
    <Button type="button" size="sm" disabled={toggling} onClick={() => void setEnabled(true)}>
      <PlayIcon aria-hidden="true" />
      Resume
    </Button>
  ) : api.testWebhook ? (
    <RowButton disabled={testing} onClick={() => void sendTest()}>
      <SendIcon aria-hidden="true" />
      {testing ? "Sending…" : "Send test event"}
    </RowButton>
  ) : null;

  return (
    <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
      <DetailPageHeader
        leading={<LogoTile icon={<WebhookIcon />} />}
        title={<span className="[overflow-wrap:anywhere]">{displayUrl(webhook.url)}</span>}
        chips={
          <>
            <HealthBadge health={health} variant="outline" />
            {organization ? <MetaChip>Organization</MetaChip> : null}
          </>
        }
        meta={[
          <span key="events">{webhookEventsSummary(webhook.eventTypes)}</span>,
          organization ? (
            <span key="filter">{workspaceFilterLabel(webhook.workspaceFilter)}</span>
          ) : null,
          <span key="added" className="whitespace-nowrap">
            added {dateLabel(webhook.createdAt)}
          </span>,
        ]}
        actions={
          canManage ? (
            <>
              {primary}
              <MoreMenu label={`More actions for ${urlHost(webhook.url)}`}>
                <DropdownMenuItem onSelect={onEdit}>
                  <PencilIcon aria-hidden="true" />
                  Edit
                </DropdownMenuItem>
                {paused && api.testWebhook ? (
                  <DropdownMenuItem onSelect={() => void sendTest()}>
                    <SendIcon aria-hidden="true" />
                    Send test event
                  </DropdownMenuItem>
                ) : null}
                {!paused ? (
                  <DropdownMenuItem onSelect={() => void setEnabled(false)}>
                    <PauseIcon aria-hidden="true" />
                    Pause
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onSelect={() => void rotate()}>
                  <KeyRoundIcon aria-hidden="true" />
                  New signing secret
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(true)}>
                  <Trash2Icon aria-hidden="true" />
                  Remove
                </DropdownMenuItem>
              </MoreMenu>
            </>
          ) : null
        }
      />
      <DetailPageBody
        aside={
          <DetailAside label="Webhook details">
            <DetailAsideItem label="Endpoint">
              <CopyField value={webhook.url} label="endpoint URL" truncate="middle" />
            </DetailAsideItem>
            <DetailAsideItem label="Events">
              <ul className="m-0 grid list-none gap-0.5 p-0">
                {webhook.eventTypes.map((type) => (
                  <li key={type}>{webhookEventLabel(type)}</li>
                ))}
              </ul>
            </DetailAsideItem>
            {organization ? (
              <DetailAsideItem label="Workspaces">
                {workspaceFilterLabel(webhook.workspaceFilter)}
              </DetailAsideItem>
            ) : null}
            <DetailAsideItem label="Signing secret">
              <span className="text-fg-muted">Shown once, when it was made.</span>
            </DetailAsideItem>
            <DetailAsideItem label="Added" icon={<CalendarIcon />}>
              {dateLabel(webhook.createdAt)}
            </DetailAsideItem>
            <DetailAsideItem label="Webhook ID">
              <CopyField value={webhook.id} label="webhook ID" truncate="middle" />
            </DetailAsideItem>
          </DetailAside>
        }
      >
        {secret ? (
          <DetailSection>
            <SecretOnce
              value={secret}
              label="signing secret"
              details="The old secret stopped working. Update your endpoint now."
            />
          </DetailSection>
        ) : null}
        {test ? (
          <DetailSection>
            <EndpointTestResult
              kind="webhook"
              result={test.result}
              testedAt={test.at}
              onDismiss={() => setTest(null)}
            />
          </DetailSection>
        ) : null}
        {paused ? (
          <DetailSection>
            <InlineHelp icon>
              Paused. New events wait in the queue and go out when you resume it.
            </InlineHelp>
          </DetailSection>
        ) : null}
        <DetailSection
          title="Deliveries"
          description="The last 25. Opengeni retries a delivery with growing gaps, up to 12 times, until your endpoint answers 2xx."
          action={
            deliveries.kind === "ready" && deliveries.value.length > 0 ? (
              <RowButton onClick={() => void reloadDeliveries()}>Refresh</RowButton>
            ) : undefined
          }
        >
          {deliveries.kind === "loading" ? (
            <Skeleton className="h-24 w-full rounded-[14px]" />
          ) : deliveries.kind === "failed" ? (
            <LoadFailure
              title="Couldn't load deliveries."
              error={deliveries.error}
              onRetry={reloadDeliveries}
            />
          ) : deliveries.kind === "denied" ? (
            <InlineHelp>Only admins can see deliveries.</InlineHelp>
          ) : deliveries.value.length === 0 ? (
            <InlineHelp>
              Nothing sent yet. Deliveries show here when a chosen event happens
              {api.testWebhook ? "; Send test event checks the endpoint now" : ""}.
            </InlineHelp>
          ) : (
            <DeliveryRows
              deliveries={deliveries.value}
              paused={paused}
              canManage={canManage}
              onRedeliver={async (delivery) => {
                try {
                  await api.redeliver(webhook.id, delivery.id);
                  await reloadDeliveries();
                  toast("Queued to send again");
                } catch (error) {
                  actionFailed("Couldn't send it again", error);
                }
              }}
            />
          )}
        </DetailSection>
        <DetailSection
          title="Verify requests"
          description={
            <>
              Each request carries an OpenGeni-Signature header made with this webhook's signing
              secret. Check it before you trust the body.{" "}
              <ExternalLink href={WEBHOOKS_GUIDE_URL}>Guide</ExternalLink>
            </>
          }
        >
          <CodeSample label="Receiver" code={verifySnippet()} />
        </DetailSection>
      </DetailPageBody>
      <DestructiveConfirm
        open={removing}
        onOpenChange={setRemoving}
        variant="consequences"
        title={`Remove the webhook to ${urlHost(webhook.url)}?`}
        consequences={[
          "Opengeni stops sending events to this endpoint.",
          "Deliveries still waiting are dropped.",
          "Its signing secret is deleted. This can't be undone.",
        ]}
        confirmLabel="Remove webhook"
        pendingLabel="Removing…"
        onConfirm={async () => {
          try {
            await api.deleteWebhook(webhook.id);
          } catch (error) {
            throw new Error(`Couldn't remove the webhook. ${userErrorText(error, "Try again.")}`, {
              cause: error,
            });
          }
          toast("Webhook removed");
          onBack();
        }}
      />
    </DetailPage>
  );
}

/* ----------------------------------------------------------------------------
   Add webhook and Edit webhook.
   -------------------------------------------------------------------------- */

function EventPicker({
  selected,
  organization,
  onToggle,
}: {
  selected: ReadonlySet<WorkspaceWebhookEventType>;
  organization: boolean;
  onToggle: (type: WorkspaceWebhookEventType, checked: boolean) => void;
}) {
  return (
    <div className="@container/events min-w-0">
      <div className="grid min-w-0 gap-6 @[34rem]/events:grid-cols-2">
        {WEBHOOK_EVENT_GROUPS.filter((group) => !(organization && group.workspaceOnly)).map(
          (group) => (
            <fieldset key={group.label} className="m-0 min-w-0 border-0 p-0">
              <legend className="mb-2 p-0 text-xs leading-4.5 font-medium text-fg">
                {group.label}
              </legend>
              <div className="flex min-w-0 flex-col gap-3">
                {group.events.map((event) => (
                  <CheckboxField
                    key={event.type}
                    label={event.label}
                    description={event.description}
                    checked={selected.has(event.type)}
                    onCheckedChange={(checked) => onToggle(event.type, checked)}
                  />
                ))}
              </div>
            </fieldset>
          ),
        )}
      </div>
    </div>
  );
}

export function WebhookFormPage({
  api,
  canManage,
  existing,
  backLabel,
  onClose,
  onFinished,
}: {
  api: DeveloperIntegrationsApi;
  canManage: boolean;
  /** Edit this webhook; omitted to add one. */
  existing?: IntegrationWebhook | Load<IntegrationWebhook | null>;
  backLabel: string;
  onClose: () => void;
  onFinished: (webhook: IntegrationWebhook) => void;
}) {
  const current = useMemo(() => {
    if (!existing) return null;
    if ("kind" in existing) return existing.kind === "ready" ? existing.value : undefined;
    return existing;
  }, [existing]);
  const organization = api.scope === "organization";
  const [url, setUrl] = useState(current?.url ?? "");
  const [events, setEvents] = useState<Set<WorkspaceWebhookEventType>>(
    () => new Set(current?.eventTypes ?? DEFAULT_WEBHOOK_EVENTS),
  );
  const [filter, setFilter] = useState<IntegrationWorkspaceFilter | null>(
    current?.workspaceFilter ?? null,
  );
  const [errors, setErrors] = useState<{ url?: string; events?: string; filter?: string }>({});
  const [created, setCreated] = useState<{ webhook: IntegrationWebhook; secret: string } | null>(
    null,
  );

  useEffect(() => {
    if (!current) return;
    setUrl(current.url);
    setEvents(new Set(current.eventTypes));
    setFilter(current.workspaceFilter ?? null);
  }, [current]);

  const back = { label: backLabel, onClick: onClose };
  if (!canManage) {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        <EmptyState
          variant="page"
          icon={<WebhookIcon />}
          title="Only admins can add webhooks"
          description="Ask an admin to add the endpoint for you."
        />
      </DetailPage>
    );
  }
  if (current === undefined) {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        <PageSkeleton label="Loading webhook" />
      </DetailPage>
    );
  }

  if (created) {
    return (
      <FormPage
        className={FLUSH_FORM_PAGE_CLASS}
        title="Webhook added"
        description={`${displayUrl(created.webhook.url)} · ${webhookEventsSummary(created.webhook.eventTypes)}`}
        submitLabel="I've saved it"
        cancelLabel={null}
        onSubmit={() => true}
        onSubmitted={() => onFinished(created.webhook)}
      >
        <SecretOnce
          value={created.secret}
          label="signing secret"
          details="Your endpoint uses it to check that each request comes from Opengeni. Next, send a test event from the webhook's page."
        />
      </FormPage>
    );
  }

  const submit = async () => {
    const trimmed = url.trim();
    const nextErrors: typeof errors = {};
    if (!/^https?:\/\/\S+$/i.test(trimmed))
      nextErrors.url = "Enter the full URL, starting with https://.";
    if (events.size === 0) nextErrors.events = "Pick at least one event.";
    if (organization && filter && !filter.externalSource.trim()) {
      nextErrors.filter = "Enter the external source, or send for every shared workspace.";
    }
    setErrors(nextErrors);
    if (nextErrors.url || nextErrors.events || nextErrors.filter) return false;
    const eventTypes = WEBHOOK_EVENT_GROUPS.flatMap((group) => group.events)
      .map((event) => event.type)
      .filter((type) => events.has(type));
    const workspaceFilter = organization
      ? filter
        ? { externalSource: filter.externalSource.trim() }
        : null
      : undefined;
    try {
      if (current) {
        const updated = await api.updateWebhook(current.id, {
          url: trimmed,
          eventTypes,
          ...(organization ? { workspaceFilter } : {}),
        });
        toast("Webhook saved");
        onFinished(updated);
        return true;
      }
      setCreated(
        await api.createWebhook({
          url: trimmed,
          eventTypes,
          ...(organization ? { workspaceFilter } : {}),
        }),
      );
      return true;
    } catch (error) {
      throw new Error(
        `Couldn't ${current ? "save" : "add"} the webhook. ${userErrorText(error, "Try again.")}`,
        { cause: error },
      );
    }
  };

  return (
    <FormPage
      className={FLUSH_FORM_PAGE_CLASS}
      back={back}
      title={current ? "Edit webhook" : "Add webhook"}
      description={
        organization
          ? "Opengeni sends a signed POST to your endpoint for each event you pick, from the shared workspaces you choose."
          : "Opengeni sends a signed POST to your endpoint for each event you pick."
      }
      submitLabel={current ? "Save" : "Add webhook"}
      pendingLabel={current ? "Saving…" : "Adding…"}
      onSubmit={submit}
      onCancel={onClose}
    >
      <FieldStack>
        <Field
          label="Endpoint URL"
          id="webhook-url"
          error={errors.url}
          hint="Answer with any 2xx within 10 seconds. Anything else is retried."
        >
          <TextInput
            type="url"
            placeholder="https://your-product.example/opengeni/events"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setErrors((value) => ({ ...value, url: undefined }));
            }}
            suppressAutofill
          />
        </Field>
        {organization ? (
          <WorkspaceFilterField
            value={filter}
            error={errors.filter}
            onChange={(next) => {
              setFilter(next);
              setErrors((value) => ({ ...value, filter: undefined }));
            }}
          />
        ) : null}
        <Field label="Events" group error={errors.events}>
          <EventPicker
            selected={events}
            organization={organization}
            onToggle={(type, checked) => {
              setErrors((value) => ({ ...value, events: undefined }));
              setEvents((value) => {
                const next = new Set(value);
                if (checked) next.add(type);
                else next.delete(type);
                return next;
              });
            }}
          />
        </Field>
      </FieldStack>
    </FormPage>
  );
}
