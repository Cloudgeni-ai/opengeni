/**
 * Event sources: the apps and webhooks whose events can start automations.
 * One flat list, each row opening the source's own page; Add a source opens
 * the form page. Reached from Automations, so it keeps a link back.
 */
import { LockIcon, PlusIcon, RadioTowerIcon } from "lucide-react";

import { t } from "@opengeni/react/app/lib/console-text";
import {
  EventSourceTile,
  eventSourceChoices,
  eventSourceKindLabel,
  eventSourceStatusBadge,
  eventSourceSubjectOfChoice,
  type EventSourceChoice,
  type EventSourceLogoResolver,
} from "@opengeni/react/automations";
import { Button } from "@opengeni/react/ui/button";
import { DetailPage, DetailPageHeader } from "@opengeni/react/ui/detail-page";
import {
  EmptyState,
  EmptyStateTemplate,
  EmptyStateTemplates,
} from "@opengeni/react/ui/empty-state";
import { ErrorMessage } from "@opengeni/react/ui/error-message";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@opengeni/react/ui/list-row";
import { LogoTile } from "@opengeni/react/ui/logo-tile";
import { MetaChip } from "@opengeni/react/ui/meta-chip";
import { Notice } from "@opengeni/react/ui/notice";
import { RelativeTime } from "@opengeni/react/ui/relative-time";
import { StatusBadge } from "@opengeni/react/ui/status-badge";
import { apiErrorDetails } from "@opengeni/react/ui/api-error";
import type { EventSource } from "@opengeni/sdk";

import {
  eventSourcePath,
  inAppClick,
  useScheduleAccess,
  useScheduleNavigation,
} from "./schedule-parts";
import { useEventSourceLogo, useEventSources, useEventTriggersEnabled } from "./use-event-sources";

const COLUMNS: RowListColumn[] = [{ id: "last", label: "Last delivery", width: 136 }];

export function EventSourcesPage({ workspaceId }: { workspaceId: string }) {
  const enabled = useEventTriggersEnabled();
  const access = useScheduleAccess(workspaceId);
  const go = useScheduleNavigation(workspaceId);
  const logo = useEventSourceLogo();
  const { sources, error, reload } = useEventSources(workspaceId, enabled);
  const loading = enabled && sources === undefined;
  const sorted = [...(sources ?? [])].sort((left, right) => left.name.localeCompare(right.name));

  return (
    <DetailPage back={{ label: "Automations", onClick: go.list }}>
      <DetailPageHeader
        leading={<LogoTile name="Event sources" icon={<RadioTowerIcon />} />}
        title="Event sources"
        meta={["Apps and webhooks whose events can start an automation"]}
        actions={
          enabled && access.canManage && sorted.length > 0 ? (
            <Button
              type="button"
              size="sm"
              onClick={() => go.newSource()}
              className="rounded-[10px] pointer-coarse:h-11"
            >
              <PlusIcon aria-hidden="true" />
              Add a source
            </Button>
          ) : undefined
        }
      />
      <div className="mt-6 min-w-0">
        {!enabled ? (
          <Notice title="Event triggers are off on this Opengeni server">
            Automations here run on a schedule or when someone presses Run now.
          </Notice>
        ) : loading ? (
          <RowList label="Event sources" columns={COLUMNS} flush busy>
            <ListRowSkeleton count={3} />
          </RowList>
        ) : error && sorted.length === 0 ? (
          <ErrorMessage
            align="center"
            title="Couldn't load event sources"
            {...apiErrorDetails(error)}
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={reload}
                className="pointer-coarse:h-11"
              >
                Try again
              </Button>
            }
          >
            Check your connection, then try again. Sources keep receiving events either way.
          </ErrorMessage>
        ) : sorted.length === 0 ? (
          <EventSourcesEmpty
            canManage={access.canManage}
            logo={logo}
            onAdd={(choice) => go.newSource(choice)}
          />
        ) : (
          <RowList label="Event sources" columns={COLUMNS} flush>
            {sorted.map((source) => (
              <EventSourceListRow
                key={source.id}
                source={source}
                logo={logo}
                href={eventSourcePath(workspaceId, source.id)}
                onOpen={() => go.source(source.id)}
              />
            ))}
          </RowList>
        )}
      </div>
    </DetailPage>
  );
}

function EventSourceListRow({
  source,
  logo,
  href,
  onOpen,
}: {
  source: EventSource;
  logo: EventSourceLogoResolver;
  href: string;
  onOpen: () => void;
}) {
  const badge = eventSourceStatusBadge(t, source);
  return (
    <ListRow
      leading={<EventSourceTile source={source} logo={logo} />}
      title={source.name}
      titleAddon={
        source.visibility === "private" ? (
          <MetaChip icon={<LockIcon />}>Only me</MetaChip>
        ) : undefined
      }
      description={eventSourceKindLabel(t, source)}
      status={
        badge ? (
          <StatusBadge variant="dot" status={badge.status} reason={badge.reason ?? undefined}>
            {badge.label}
          </StatusBadge>
        ) : undefined
      }
      cells={{
        last: source.lastDeliveryAt ? (
          <RelativeTime date={source.lastDeliveryAt} inSentence />
        ) : (
          <span className="text-fg-subtle">Nothing yet</span>
        ),
      }}
      href={href}
      linkProps={{ onClick: inAppClick(onOpen) }}
    />
  );
}

/** The sources that connect without leaving Opengeni come first. */
const STARTER_CHOICES = eventSourceChoices(t)
  .filter((choice) => choice.setup === "automatic")
  .slice(0, 3);

function EventSourcesEmpty({
  canManage,
  logo,
  onAdd,
}: {
  canManage: boolean;
  logo: EventSourceLogoResolver;
  onAdd: (choice?: EventSourceChoice) => void;
}) {
  return (
    <EmptyState
      variant="page"
      icon={<RadioTowerIcon />}
      title="No event sources yet"
      description={
        canManage
          ? "Connect an app or a webhook, then start automations when something happens there."
          : "Event sources let automations start when something happens in another app. Ask a workspace admin for access to add one."
      }
      action={
        canManage ? (
          <Button type="button" onClick={() => onAdd()} className="pointer-coarse:h-11">
            <PlusIcon aria-hidden="true" />
            Add a source
          </Button>
        ) : undefined
      }
      className="pt-12"
      templates={
        canManage ? (
          <EmptyStateTemplates label="Or start with">
            {STARTER_CHOICES.map((choice) => (
              <EmptyStateTemplate
                key={choice.choice}
                tile={
                  <EventSourceTile
                    source={eventSourceSubjectOfChoice(t, choice.choice)}
                    logo={logo}
                    size="md"
                  />
                }
                title={choice.name}
                description={choice.description}
                onSelect={() => onAdd(choice.choice)}
              />
            ))}
          </EmptyStateTemplates>
        ) : undefined
      }
    />
  );
}
