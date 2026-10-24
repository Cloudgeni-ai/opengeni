/**
 * One event source: whether it is on, how it is connected, the automations
 * it starts, and what it received (its events and the raw delivery log).
 * Whoever manages it can rename, test, rotate or replace its secret, turn it
 * off and delete it; everyone else who can see it reads it.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  KeyRoundIcon,
  LinkIcon,
  PlusIcon,
  RotateCcwIcon,
  SendIcon,
  TextCursorInputIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { EVENT_RETENTION_DAYS } from "@opengeni/contracts/event-triggers";
import {
  EVENT_DELIVERY_COLUMNS,
  EventDeliveryRow,
  EventSourceTile,
  INBOUND_EVENT_COLUMNS,
  InboundEventRow,
  eventSourceKindLabel,
  eventSourceStatusBadge,
  eventTriggerWords,
  pastedWebhookSetup,
} from "@opengeni/react/automations";
import { useAppContext } from "@opengeni/react/app/app-context";
import { DestructiveConfirm } from "@opengeni/react/app/components/ui/destructive-confirm";
import { Button } from "@opengeni/react/ui/button";
import { DetailPage, DetailPageBody, DetailPageHeader } from "@opengeni/react/ui/detail-page";
import { DetailSection } from "@opengeni/react/ui/detail-sheet";
import { DropdownMenuItem, DropdownMenuSeparator } from "@opengeni/react/ui/dropdown-menu";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { ErrorMessage } from "@opengeni/react/ui/error-message";
import { Field, FieldStack, TextInput } from "@opengeni/react/ui/field";
import { FormDialog } from "@opengeni/react/ui/form-dialog";
import { InlineHelp } from "@opengeni/react/ui/inline-help";
import {
  LineTabs,
  LineTabsContent,
  LineTabsList,
  LineTabsTrigger,
} from "@opengeni/react/ui/line-tabs";
import { ListRow, ListRowSkeleton, RowList } from "@opengeni/react/ui/list-row";
import { Notice } from "@opengeni/react/ui/notice";
import { MoreMenu } from "@opengeni/react/ui/page-actions";
import { SelectMenu } from "@opengeni/react/ui/select-menu";
import { SettingRow } from "@opengeni/react/ui/setting-row";
import { Skeleton } from "@opengeni/react/ui/skeleton";
import { StatusBadge } from "@opengeni/react/ui/status-badge";
import { Switch } from "@opengeni/react/ui/switch";
import { Textarea } from "@opengeni/react/ui/textarea";
import { apiErrorDetails } from "@opengeni/react/ui/api-error";
import type {
  EventDelivery,
  EventSource,
  EventTypeDescriptor,
  InboundEvent,
  ScheduledTask,
} from "@opengeni/sdk";

import { SecretOnce } from "@/components/ui/secret-field";

import {
  eventSourcePath,
  inAppClick,
  schedulePath,
  ScheduleTile,
  useScheduleNavigation,
  type ScheduleNavigation,
} from "./schedule-parts";
import { scheduleErrorText } from "./schedule-model";
import { PastedWebhookSteps, StandardWebhookHelp, WebhookUrlField } from "./event-source-setup";
import { useEventSourceLogo } from "./use-event-sources";

const NAME_MAX_LENGTH = 120;
const PAGE_SIZE = 50;
const TEST_EVENT_TYPE = "opengeni.test";

type Load =
  | { status: "loading" }
  | { status: "ready"; source: EventSource }
  | { status: "error"; error: unknown };

export function EventSourceDetailPage({
  workspaceId,
  sourceId,
}: {
  workspaceId: string;
  sourceId: string;
}) {
  const { client } = useAppContext();
  const go = useScheduleNavigation(workspaceId);
  const logo = useEventSourceLogo();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [usedBy, setUsedBy] = useState<ScheduledTask[] | undefined>(undefined);
  const [tab, setTab] = useState("overview");
  const [dialog, setDialog] = useState<"rename" | "secret" | "rotate" | "test" | "delete" | null>(
    null,
  );
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const source = await client.getEventSource(workspaceId, sourceId);
      setLoad({ status: "ready", source });
    } catch (error) {
      setLoad((current) => (current.status === "ready" ? current : { status: "error", error }));
    }
    // What starts from it: every automation the viewer can see with a trigger on it.
    client.listScheduledTasks(workspaceId).then(
      (tasks) =>
        setUsedBy(
          tasks.filter((task) =>
            task.events?.triggers.some((trigger) => trigger.sourceId === sourceId),
          ),
        ),
      () => setUsedBy((current) => current ?? []),
    );
  }, [client, sourceId, workspaceId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (load.status !== "ready") {
    return (
      <DetailPage back={{ label: "Event sources", onClick: go.sources }}>
        {load.status === "loading" ? (
          <div className="flex flex-col gap-3 pt-2" aria-busy="true">
            <Skeleton className="h-10 w-64" />
            <Skeleton className="h-4 w-48" />
          </div>
        ) : (
          <ErrorMessage
            align="center"
            title="Couldn't open this event source"
            {...apiErrorDetails(load.error)}
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="pointer-coarse:h-11"
                onClick={() => {
                  setLoad({ status: "loading" });
                  void refresh();
                }}
              >
                Try again
              </Button>
            }
          >
            It may have been deleted, or you may not have access to it.
          </ErrorMessage>
        )}
      </DetailPage>
    );
  }

  const source = load.source;
  const manage = source.viewerAccess === "manage";
  const badge = eventSourceStatusBadge(source);
  const setup = pastedWebhookSetup(source);
  const replaceSource = (next: EventSource) => setLoad({ status: "ready", source: next });

  const setActive = async (active: boolean) => {
    setBusy(true);
    try {
      replaceSource(
        await client.updateEventSource(workspaceId, source.id, {
          status: active ? "active" : "disabled",
        }),
      );
      toast.success(active ? "Turned on" : "Turned off", {
        description: active
          ? `${source.name} starts automations again.`
          : `${source.name} ignores new events until you turn it back on.`,
      });
    } catch (error) {
      toast.error(`Couldn't turn ${active ? "on" : "off"} ${source.name}`, {
        description: scheduleErrorText(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const setShared = async (shared: boolean) => {
    setBusy(true);
    try {
      replaceSource(
        await client.updateEventSource(workspaceId, source.id, {
          visibility: shared ? "workspace" : "private",
        }),
      );
    } catch (error) {
      toast.error("Couldn't change who can use it", { description: scheduleErrorText(error) });
    } finally {
      setBusy(false);
    }
  };

  const copyLink = () => {
    const url = new URL(eventSourcePath(workspaceId, source.id), window.location.origin).toString();
    void navigator.clipboard
      ?.writeText(url)
      .then(() => toast("Link copied"))
      .catch(() => toast.error("Couldn't copy the link"));
  };

  return (
    <DetailPage back={{ label: "Event sources", onClick: go.sources }}>
      <LineTabs value={tab} onValueChange={setTab}>
        <DetailPageHeader
          leading={<EventSourceTile source={source} logo={logo} />}
          title={source.name}
          chips={
            badge ? (
              <StatusBadge status={badge.status} reason={badge.reason ?? undefined}>
                {badge.label}
              </StatusBadge>
            ) : undefined
          }
          meta={[
            eventSourceKindLabel(source),
            source.visibility === "private" ? "Only its owner" : "Everyone in this workspace",
          ]}
          actions={
            <>
              {manage && source.status === "active" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setDialog("test")}
                  className="rounded-[10px] pointer-coarse:h-11"
                >
                  <SendIcon aria-hidden="true" />
                  Send test event
                </Button>
              ) : null}
              <MoreMenu label={`More actions for ${source.name}`}>
                {manage ? (
                  <DropdownMenuItem onSelect={() => setDialog("rename")}>
                    <TextCursorInputIcon />
                    Rename
                  </DropdownMenuItem>
                ) : null}
                {manage && setup ? (
                  <DropdownMenuItem onSelect={() => setDialog("secret")}>
                    <KeyRoundIcon />
                    {source.awaitingSigningSecret
                      ? `Paste ${setup.secretName}`
                      : `Replace ${setup.secretName}`}
                  </DropdownMenuItem>
                ) : null}
                {manage && source.kind === "webhook" && source.adapter === "standard" ? (
                  <DropdownMenuItem onSelect={() => setDialog("rotate")}>
                    <RotateCcwIcon />
                    Rotate signing secret
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onSelect={copyLink}>
                  <LinkIcon />
                  Copy link
                </DropdownMenuItem>
                {manage ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setDialog("delete")}>
                      <Trash2Icon />
                      Delete
                    </DropdownMenuItem>
                  </>
                ) : null}
              </MoreMenu>
            </>
          }
          tabs={
            <LineTabsList aria-label={`${source.name} sections`}>
              <LineTabsTrigger value="overview">Overview</LineTabsTrigger>
              <LineTabsTrigger value="events">Events</LineTabsTrigger>
              <LineTabsTrigger value="deliveries">Deliveries</LineTabsTrigger>
            </LineTabsList>
          }
        />
        <LineTabsContent value="overview">
          <DetailPageBody>
            <Overview
              workspaceId={workspaceId}
              source={source}
              usedBy={usedBy}
              busy={busy}
              go={go}
              onActiveChange={(active) => void setActive(active)}
              onSharedChange={(shared) => void setShared(shared)}
              onPasteSecret={() => setDialog("secret")}
            />
          </DetailPageBody>
        </LineTabsContent>
        <LineTabsContent value="events">
          <DetailPageBody>
            <DetailSection className="pt-4">
              <EventsTab workspaceId={workspaceId} source={source} />
            </DetailSection>
          </DetailPageBody>
        </LineTabsContent>
        <LineTabsContent value="deliveries">
          <DetailPageBody>
            <DetailSection className="pt-4">
              <DeliveriesTab workspaceId={workspaceId} source={source} canReplay={manage} />
            </DetailSection>
          </DetailPageBody>
        </LineTabsContent>
      </LineTabs>

      <RenameDialog
        open={dialog === "rename"}
        onOpenChange={(open) => setDialog(open ? "rename" : null)}
        name={source.name}
        onRename={async (name) =>
          replaceSource(await client.updateEventSource(workspaceId, source.id, { name }))
        }
      />
      {setup ? (
        <PasteSecretDialog
          open={dialog === "secret"}
          onOpenChange={(open) => setDialog(open ? "secret" : null)}
          source={source}
          onSave={async (signingSecret) => {
            replaceSource(
              await client.updateEventSource(workspaceId, source.id, { signingSecret }),
            );
            toast.success(
              source.awaitingSigningSecret ? `${setup.app} connected` : "Secret replaced",
              { description: source.name },
            );
          }}
        />
      ) : null}
      <FormDialog
        open={dialog === "rotate"}
        onOpenChange={(open) => setDialog(open ? "rotate" : null)}
        size="sm"
        title="Rotate signing secret?"
        description="Your app's requests are refused until it signs with the new secret. The old one stops working now."
        submitLabel="Rotate secret"
        pendingLabel="Rotating…"
        initialFocus="cancel"
        onSubmit={async () => {
          const rotated = await client.rotateEventSourceSecret(workspaceId, source.id);
          setRotatedSecret(rotated.signingSecret);
          return true;
        }}
      />
      <FormDialog
        open={rotatedSecret !== null}
        onOpenChange={(open) => {
          if (!open) setRotatedSecret(null);
        }}
        dismissible={false}
        size="md"
        title="New signing secret"
        description={source.name}
        submitLabel="I've saved it"
        cancelLabel={null}
        showClose={false}
      >
        {rotatedSecret ? <SecretOnce value={rotatedSecret} label="signing secret" /> : null}
      </FormDialog>
      <TestEventDialog
        open={dialog === "test"}
        onOpenChange={(open) => setDialog(open ? "test" : null)}
        workspaceId={workspaceId}
        source={source}
        usedBy={usedBy ?? []}
      />
      <DestructiveConfirm
        open={dialog === "delete"}
        onOpenChange={(open) => setDialog(open ? "delete" : null)}
        {...(usedBy && usedBy.length > 0
          ? {
              variant: "blocked" as const,
              title: `${source.name} is in use`,
              description: "Remove its triggers from these automations first, then delete it.",
              dependencies: usedBy.map((task) => ({
                id: task.id,
                kind: "automation" as const,
                kindLabel: "Automation",
                name: task.name,
                href: schedulePath(workspaceId, task.id),
              })),
              onOpenDependency: (dependency: { id: string }) => {
                setDialog(null);
                go.detail(dependency.id);
              },
            }
          : {
              title: `Delete ${source.name}?`,
              consequences: [
                source.kind === "webhook"
                  ? "Requests to its URL are refused."
                  : "Opengeni stops listening to it.",
                "Its events and delivery log are deleted.",
                "This can't be undone.",
              ],
              confirmLabel: "Delete source",
              pendingLabel: "Deleting…",
              onConfirm: async () => {
                await client.deleteEventSource(workspaceId, source.id);
                toast.success(`${source.name} deleted`);
                go.sources();
              },
            })}
      />
    </DetailPage>
  );
}

/* ----------------------------------------------------------------------------
   Overview.
   -------------------------------------------------------------------------- */

function Overview({
  workspaceId,
  source,
  usedBy,
  busy,
  go,
  onActiveChange,
  onSharedChange,
  onPasteSecret,
}: {
  workspaceId: string;
  source: EventSource;
  usedBy: ScheduledTask[] | undefined;
  busy: boolean;
  go: ScheduleNavigation;
  onActiveChange: (active: boolean) => void;
  onSharedChange: (shared: boolean) => void;
  onPasteSecret: () => void;
}) {
  const manage = source.viewerAccess === "manage";
  const setup = pastedWebhookSetup(source);
  const waiting = source.awaitingSigningSecret && setup;
  return (
    <>
      <DetailSection className="pt-6">
        {waiting ? (
          <Notice
            tone="waiting"
            title={`Waiting for ${setup.app}'s ${setup.secretName}`}
            className="mb-4"
            action={
              manage ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={onPasteSecret}
                  className="pointer-coarse:h-11"
                >
                  Connect {setup.app}
                </Button>
              ) : undefined
            }
          >
            {manage
              ? `Paste its URL into ${setup.app}, then paste the ${setup.secretName} ${setup.app} shows here. Until then its deliveries are refused.`
              : `Its owner still needs to paste the ${setup.secretName} from ${setup.app}.`}
          </Notice>
        ) : source.status === "blocked" && source.statusReason ? (
          <Notice tone="failed" title="It can't receive events" className="mb-4">
            {source.statusReason}
          </Notice>
        ) : null}
        <SettingRow
          label="Active"
          description={
            source.status === "disabled"
              ? "Off: it ignores new events until you turn it back on."
              : "Its events can start automations."
          }
          control={
            <Switch
              aria-label={`${source.name} is active`}
              checked={source.status !== "disabled"}
              onCheckedChange={onActiveChange}
              pending={busy}
              disabled={!manage || Boolean(waiting)}
              disabledReason={
                waiting
                  ? `Paste the ${setup.secretName} first.`
                  : "Only its owner or a workspace admin can turn it off."
              }
            />
          }
        />
        {source.kind === "webhook" && source.ownerSubjectId !== null ? (
          <SettingRow
            label="Shared with the workspace"
            description={
              source.visibility === "workspace"
                ? "Everyone in this workspace can start automations from it and read its events."
                : "Only its owner can use it. Workspace admins can still manage it."
            }
            control={
              <Switch
                aria-label={`${source.name} is shared with the workspace`}
                checked={source.visibility === "workspace"}
                onCheckedChange={onSharedChange}
                pending={busy}
                disabled={!manage}
                disabledReason="Only its owner or a workspace admin can change this."
              />
            }
          />
        ) : null}
      </DetailSection>
      <DetailSection title="Connection">
        <Connection source={source} />
      </DetailSection>
      <DetailSection title="Used by">
        <UsedBy workspaceId={workspaceId} source={source} usedBy={usedBy} go={go} />
      </DetailSection>
    </>
  );
}

function Connection({ source }: { source: EventSource }) {
  if (source.kind === "webhook") {
    const setup = pastedWebhookSetup(source);
    return (
      <FieldStack>
        <WebhookUrlField
          url={source.webhookUrl}
          hint={setup ? setup.urlStep : "Your app sends its signed events here."}
        />
        {setup ? null : <StandardWebhookHelp />}
      </FieldStack>
    );
  }
  return (
    <p className="m-0 text-sm leading-5 text-fg-muted">
      {source.kind === "github"
        ? "Through the Opengeni GitHub App, for the repositories it is installed on. Nothing to set up."
        : source.kind === "slack"
          ? "Through the Opengeni Slack bot, for the channels it is in. Invite it to a channel to hear from it."
          : source.kind === "gmail"
            ? "Through its owner's Gmail connection. Opengeni checks the mailbox for new mail."
            : "Through its owner's sign-in to the MCP server, using the server's own events."}
    </p>
  );
}

function UsedBy({
  workspaceId,
  source,
  usedBy,
  go,
}: {
  workspaceId: string;
  source: EventSource;
  usedBy: ScheduledTask[] | undefined;
  go: ScheduleNavigation;
}) {
  if (usedBy === undefined) {
    return (
      <RowList label="Automations using it" flush busy>
        <ListRowSkeleton count={2} />
      </RowList>
    );
  }
  if (usedBy.length === 0) {
    return (
      <InlineHelp
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => go.create({ source: source.id })}
            className="pointer-coarse:h-11"
          >
            <PlusIcon aria-hidden="true" />
            New automation
          </Button>
        }
      >
        No automation starts from it yet.
      </InlineHelp>
    );
  }
  return (
    <RowList label="Automations using it" flush>
      {usedBy.map((task) => {
        const triggers = (task.events?.triggers ?? []).filter(
          (trigger) => trigger.sourceId === source.id,
        );
        const words = triggers.map((trigger) => {
          const described = eventTriggerWords(trigger, [source]);
          return described.conditions
            ? `${described.events}, ${described.conditions}`
            : described.events;
        });
        return (
          <ListRow
            key={task.id}
            leading={<ScheduleTile task={task} />}
            title={task.name}
            description={words.join("; ")}
            status={
              task.status === "paused" ? <StatusBadge variant="dot" status="paused" /> : undefined
            }
            href={schedulePath(workspaceId, task.id)}
            linkProps={{ onClick: inAppClick(() => go.detail(task.id)) }}
          />
        );
      })}
    </RowList>
  );
}

/* ----------------------------------------------------------------------------
   Events and deliveries.
   -------------------------------------------------------------------------- */

type Page<T> = {
  items: T[] | undefined;
  cursor: string | null;
  loading: boolean;
  error: unknown;
};

/** A newest-first list read a page at a time. */
function useCursorPages<T>(
  read: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>,
) {
  const [page, setPage] = useState<Page<T>>({
    items: undefined,
    cursor: null,
    loading: true,
    error: null,
  });
  const fetchPage = useCallback(
    async (cursor: string | undefined) => {
      setPage((current) => ({ ...current, loading: true, error: null }));
      try {
        const next = await read(cursor);
        setPage((current) => ({
          items: cursor ? [...(current.items ?? []), ...next.items] : next.items,
          cursor: next.nextCursor,
          loading: false,
          error: null,
        }));
      } catch (error) {
        setPage((current) => ({ ...current, loading: false, error }));
      }
    },
    [read],
  );
  useEffect(() => {
    void fetchPage(undefined);
  }, [fetchPage]);
  return {
    ...page,
    reload: () => void fetchPage(undefined),
    loadMore: () => void fetchPage(page.cursor ?? undefined),
  };
}

function PagedList<T>({
  label,
  columns,
  pages,
  empty,
  errorTitle,
  children,
}: {
  label: string;
  columns: Parameters<typeof RowList>[0]["columns"];
  pages: ReturnType<typeof useCursorPages<T>>;
  empty: { title: string; description: string };
  errorTitle: string;
  children: (items: T[]) => ReactNode;
}) {
  if (pages.items === undefined) {
    if (pages.error) {
      return (
        <ErrorMessage
          align="center"
          title={errorTitle}
          {...apiErrorDetails(pages.error)}
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={pages.reload}
              className="pointer-coarse:h-11"
            >
              Try again
            </Button>
          }
        >
          Check your connection, then try again.
        </ErrorMessage>
      );
    }
    return (
      <RowList label={label} columns={columns} flush busy>
        <ListRowSkeleton count={4} />
      </RowList>
    );
  }
  if (pages.items.length === 0) {
    return <EmptyState variant="inline" title={empty.title} description={empty.description} />;
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <RowList label={label} columns={columns} flush>
        {children(pages.items)}
      </RowList>
      {pages.error ? (
        <p role="alert" className="m-0 text-sm text-danger">
          Couldn't load more. {scheduleErrorText(pages.error)}
        </p>
      ) : null}
      {pages.cursor ? (
        <Button
          type="button"
          variant="outline"
          className="self-start pointer-coarse:h-11"
          disabled={pages.loading}
          onClick={pages.loadMore}
        >
          {pages.loading ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}

function EventsTab({ workspaceId, source }: { workspaceId: string; source: EventSource }) {
  const { client } = useAppContext();
  const read = useCallback(
    async (cursor: string | undefined) => {
      const page = await client.listInboundEvents(workspaceId, source.id, {
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      return { items: page.events, nextCursor: page.nextCursor };
    },
    [client, source.id, workspaceId],
  );
  const pages = useCursorPages<InboundEvent>(read);
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <PagedList
      label={`Events from ${source.name}`}
      columns={INBOUND_EVENT_COLUMNS}
      pages={pages}
      errorTitle="Couldn't load its events"
      empty={{
        title: "No events yet",
        description: `Events show here as they arrive. Opengeni keeps them for ${EVENT_RETENTION_DAYS} days.`,
      }}
    >
      {(events) =>
        events.map((event) => (
          <InboundEventRow
            key={event.id}
            event={event}
            expanded={expanded === event.id}
            onToggle={() => setExpanded((current) => (current === event.id ? null : event.id))}
          />
        ))
      }
    </PagedList>
  );
}

function DeliveriesTab({
  workspaceId,
  source,
  canReplay,
}: {
  workspaceId: string;
  source: EventSource;
  canReplay: boolean;
}) {
  const { client } = useAppContext();
  const read = useCallback(
    async (cursor: string | undefined) => {
      const page = await client.listEventDeliveries(workspaceId, source.id, {
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      return { items: page.deliveries, nextCursor: page.nextCursor };
    },
    [client, source.id, workspaceId],
  );
  const pages = useCursorPages<EventDelivery>(read);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [replaying, setReplaying] = useState<string | null>(null);
  const replay = async (delivery: EventDelivery) => {
    setReplaying(delivery.id);
    try {
      const replayed = await client.replayEventDelivery(workspaceId, source.id, delivery.id);
      toast.success("Delivery replayed", {
        description:
          replayed.status === "accepted"
            ? "Its events went through the triggers again."
            : (replayed.reason ?? "It was checked again."),
      });
      pages.reload();
    } catch (error) {
      toast.error("Couldn't replay the delivery", { description: scheduleErrorText(error) });
    } finally {
      setReplaying(null);
    }
  };
  return (
    <PagedList
      label={`Deliveries to ${source.name}`}
      columns={EVENT_DELIVERY_COLUMNS}
      pages={pages}
      errorTitle="Couldn't load its deliveries"
      empty={{
        title: "Nothing received yet",
        description:
          source.kind === "webhook"
            ? "Every request to its URL shows here, including ones that were refused."
            : "Everything Opengeni receives from it shows here.",
      }}
    >
      {(deliveries) =>
        deliveries.map((delivery) => (
          <EventDeliveryRow
            key={delivery.id}
            delivery={delivery}
            canReplay={canReplay && delivery.bodyRetained}
            replaying={replaying === delivery.id}
            onReplay={() => void replay(delivery)}
            expanded={expanded === delivery.id}
            onToggle={() =>
              setExpanded((current) => (current === delivery.id ? null : delivery.id))
            }
          />
        ))
      }
    </PagedList>
  );
}

/* ----------------------------------------------------------------------------
   Dialogs.
   -------------------------------------------------------------------------- */

function RenameDialog({
  open,
  onOpenChange,
  name: current,
  onRename,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  onRename: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(current);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    if (open) {
      setName(current);
      setError(undefined);
    }
  }, [current, open]);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title="Rename event source"
      submitLabel="Rename"
      pendingLabel="Renaming…"
      onSubmit={async () => {
        const trimmed = name.trim();
        if (!trimmed) {
          setError("Enter a name.");
          return false;
        }
        if (trimmed.length > NAME_MAX_LENGTH) {
          setError(`Keep the name under ${NAME_MAX_LENGTH} characters.`);
          return false;
        }
        if (trimmed !== current) await onRename(trimmed);
        return true;
      }}
    >
      <Field label="Name" error={error}>
        <TextInput
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            if (error) setError(undefined);
          }}
          suppressAutofill
        />
      </Field>
    </FormDialog>
  );
}

function PasteSecretDialog({
  open,
  onOpenChange,
  source,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: EventSource;
  onSave: (secret: string) => Promise<void>;
}) {
  const setup = pastedWebhookSetup(source)!;
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    if (open) {
      setSecret("");
      setError(undefined);
    }
  }, [open]);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={source.awaitingSigningSecret ? `Connect ${setup.app}` : `Replace ${setup.secretName}`}
      description={
        source.awaitingSigningSecret
          ? `It starts receiving events once ${setup.app} has its URL and Opengeni has the ${setup.secretName}.`
          : `Use this when the ${setup.secretName} changed in ${setup.app}.`
      }
      submitLabel={`Save ${setup.secretName}`}
      pendingLabel="Saving…"
      onSubmit={async () => {
        const trimmed = secret.trim();
        if (trimmed.length < 8) {
          setError(`Paste the ${setup.secretName} ${setup.app} shows.`);
          return false;
        }
        await onSave(trimmed);
        return true;
      }}
    >
      <PastedWebhookSteps
        source={source}
        secret={secret}
        error={error}
        onSecretChange={(value) => {
          setSecret(value);
          if (error) setError(undefined);
        }}
      />
    </FormDialog>
  );
}

/**
 * Sends one made-up event through the source's triggers. It offers the types
 * the source's automations listen for first, so a test can start them.
 */
function TestEventDialog({
  open,
  onOpenChange,
  workspaceId,
  source,
  usedBy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  source: EventSource;
  usedBy: ScheduledTask[];
}) {
  const { client } = useAppContext();
  const [types, setTypes] = useState<EventTypeDescriptor[] | undefined>(undefined);
  const [type, setType] = useState(TEST_EVENT_TYPE);
  const [data, setData] = useState("");
  const [error, setError] = useState<string | undefined>();
  const listened = [
    ...new Set(
      usedBy.flatMap((task) =>
        (task.events?.triggers ?? [])
          .filter((trigger) => trigger.sourceId === source.id)
          .flatMap((trigger) => trigger.eventTypes)
          .filter((each) => each !== "*" && !each.endsWith(".*")),
      ),
    ),
  ];
  // The listened types are read when the dialog opens, not on every render.
  const listenedRef = useRef(listened);
  listenedRef.current = listened;
  useEffect(() => {
    if (!open) return;
    setType(listenedRef.current[0] ?? TEST_EVENT_TYPE);
    setData("");
    setError(undefined);
    let live = true;
    client.listEventSourceTypes(workspaceId, source.id).then(
      (next) => live && setTypes(next),
      () => live && setTypes([]),
    );
    return () => {
      live = false;
    };
  }, [client, open, source.id, workspaceId]);
  const options = [
    ...new Set([
      ...listened,
      ...(types ?? []).filter((each) => each.available).map((each) => each.type),
      ...(source.kind === "mcp" ? [] : [TEST_EVENT_TYPE]),
    ]),
  ]
    .filter((each) => each !== "*" && !each.endsWith(".*"))
    .map((each) => ({
      value: each,
      label: each,
      ...(listened.includes(each) ? { meta: "An automation listens for it" } : {}),
    }));
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title="Send a test event"
      description="It goes through this source's triggers like a real event, so matching automations run."
      submitLabel="Send test event"
      pendingLabel="Sending…"
      onSubmit={async () => {
        let parsed: Record<string, unknown> = {};
        if (data.trim()) {
          try {
            const value: unknown = JSON.parse(data);
            if (typeof value !== "object" || value === null || Array.isArray(value))
              throw new Error();
            parsed = value as Record<string, unknown>;
          } catch {
            setError('Enter a JSON object, for example {"title": "Checkout is slow"}.');
            return false;
          }
        }
        const result = await client.sendTestEvent(workspaceId, source.id, { type, data: parsed });
        const started = result.matchedAutomationIds.length;
        toast.success("Test event sent", {
          description:
            started === 0
              ? "No automation matched it. Its event is in the Events tab."
              : `It started ${started === 1 ? "1 automation" : `${started} automations`}.`,
        });
        return true;
      }}
    >
      <FieldStack>
        <Field label="Event type">
          <SelectMenu
            options={options}
            value={type}
            onValueChange={setType}
            loading={types === undefined}
            loadingLabel="Loading event types…"
          />
        </Field>
        <Field
          label="Data"
          optional
          error={error}
          hint="A JSON object. Conditions on data.<field> match it."
        >
          <Textarea
            value={data}
            onChange={(event) => {
              setData(event.target.value);
              if (error) setError(undefined);
            }}
            rows={5}
            className="font-mono text-xs"
            placeholder='{"title": "Checkout is slow"}'
          />
        </Field>
      </FieldStack>
    </FormDialog>
  );
}
