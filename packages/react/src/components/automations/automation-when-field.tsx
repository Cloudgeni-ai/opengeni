/**
 * An automation's "When": its schedule and its event triggers, each optional.
 * With neither it runs only when someone presses Run now. Controlled and
 * data-agnostic like `EventTriggersField`: the host passes the sources it can
 * read and a loader for each source's event types.
 */
import { useId, useMemo, type ReactNode } from "react";
import { CircleAlertIcon, PlusIcon, Trash2Icon } from "lucide-react";

import type { EventSource, EventTypeDescriptor } from "@opengeni/sdk";

import { useOpenGeniText } from "../../messages/runtime";
import { Button } from "../../ui/button";
import {
  CadencePicker,
  timeZoneLabels,
  type CadenceFrequency,
  type CadenceTimeZoneOption,
  type CadenceValue,
} from "../../ui/cadence-picker";
import { cn } from "../../lib/cn";
import { defaultAutomationCadence, viewerTimeZone as localTimeZone } from "./automation-model";
import { EventTriggersField } from "./event-trigger-editor";
import type { EventSourceLogoResolver } from "./event-source-tile";
import type { EventTriggersDraft, EventTriggersIssues } from "./event-trigger-model";

/**
 * The frequencies an automation's schedule can store. No "Every month on day
 * N": the API's calendar spec has no day of month yet.
 */
export const AUTOMATION_FREQUENCIES: readonly CadenceFrequency[] = [
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "interval",
  "once",
];

export interface AutomationWhenFieldProps {
  /** Null: no schedule. */
  cadence: CadenceValue | null;
  onCadenceChange: (cadence: CadenceValue | null) => void;
  events: EventTriggersDraft;
  onEventsChange: (events: EventTriggersDraft) => void;
  /** Event triggers run here. False offers the schedule only. */
  eventTriggers: boolean;
  /** Sources the person can point triggers at; undefined while loading. */
  sources: EventSource[] | undefined;
  /** Reads one source's event types. */
  loadEventTypes: (sourceId: string) => Promise<EventTypeDescriptor[]>;
  eventIssues?: EventTriggersIssues | undefined;
  /** Why the schedule and the events don't fit together. */
  error?: string | undefined;
  sourceLogo?: EventSourceLogoResolver | undefined;
  /** Opens the host's "Add a source" page; offered when no source fits. */
  onAddSource?: (() => void) | undefined;
  /** Arguments a new MCP subscription starts with; see `EventTriggersField`. */
  argumentDefaults?: Readonly<Record<string, unknown>> | undefined;
  /** Default `AUTOMATION_FREQUENCIES`. */
  frequencies?: readonly CadenceFrequency[] | undefined;
  /** Suggested zones. Default: the viewer's, the schedule's and UTC. */
  timeZones?: readonly CadenceTimeZoneOption[] | undefined;
  /** Default: the browser's zone. */
  viewerTimeZone?: string | undefined;
  /** The clock for previews. */
  now?: Date | undefined;
  /** Notes under the triggers, such as what a run can open. */
  children?: ReactNode;
  disabled?: boolean | undefined;
  className?: string | undefined;
}

export function AutomationWhenField({
  cadence,
  onCadenceChange,
  events,
  onEventsChange,
  eventTriggers,
  sources,
  loadEventTypes,
  eventIssues,
  error,
  sourceLogo,
  onAddSource,
  argumentDefaults,
  frequencies = AUTOMATION_FREQUENCIES,
  timeZones,
  viewerTimeZone,
  now,
  children,
  disabled = false,
  className,
}: AutomationWhenFieldProps) {
  const t = useOpenGeniText();
  const labelId = useId();
  const viewerZone = viewerTimeZone ?? localTimeZone();
  const scheduleZone = cadence?.timeZone ?? viewerZone;
  const zones = useMemo(
    () =>
      timeZones ??
      [...new Set([viewerZone, scheduleZone, "UTC"])].map((id) => ({
        id,
        ...timeZoneLabels(id, t),
      })),
    [scheduleZone, t, timeZones, viewerZone],
  );
  const addSchedule = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => onCadenceChange(defaultAutomationCadence(viewerZone))}
      disabled={disabled}
      className="pointer-coarse:h-11"
    >
      <PlusIcon aria-hidden="true" />
      {t("automations.whenField.addSchedule")}
    </Button>
  );
  const picker = cadence ? (
    <CadencePicker
      aria-labelledby={labelId}
      value={cadence}
      onChange={onCadenceChange}
      frequencies={frequencies}
      now={now}
      viewerTimeZone={viewerZone}
      timeZones={zones}
      disabled={disabled}
      className="min-w-0 flex-1"
    />
  ) : null;
  const nothing = !cadence && events.triggers.length === 0;
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className={cn("flex min-w-0 flex-col gap-3", className)}
    >
      <p id={labelId} className="m-0 text-sm leading-5 font-medium text-fg">
        {t("automations.panel.when")}
      </p>
      {picker && eventTriggers ? (
        // Beside event triggers the schedule is one block among others, and removable.
        <div
          role="group"
          aria-label={t("automations.whenField.schedule")}
          className="flex min-w-0 items-start gap-3 rounded-lg border border-border bg-surface p-4"
        >
          {picker}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onCadenceChange(null)}
            disabled={disabled}
            aria-label={t("automations.whenField.removeSchedule")}
            title={t("automations.whenField.removeSchedule")}
            className="shrink-0 text-fg-muted pointer-coarse:size-11"
          >
            <Trash2Icon aria-hidden="true" />
          </Button>
        </div>
      ) : (
        picker
      )}
      {nothing ? (
        <p className="m-0 text-sm leading-5 text-fg-muted">
          {eventTriggers
            ? t("automations.whenField.manualUntilAdded")
            : t("automations.whenField.manual")}
        </p>
      ) : null}
      {eventTriggers ? (
        <EventTriggersField
          value={events}
          onChange={onEventsChange}
          sources={sources}
          loadEventTypes={loadEventTypes}
          issues={eventIssues}
          sourceLogo={sourceLogo}
          onAddSource={onAddSource}
          argumentDefaults={argumentDefaults}
          actions={cadence ? null : addSchedule}
          disabled={disabled}
        />
      ) : cadence ? null : (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">{addSchedule}</div>
      )}
      {children}
      {cadence && events.triggers.length > 0 && !error ? (
        <p className="m-0 text-xs leading-4.5 text-fg-muted">{t("automations.whenField.both")}</p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="m-0 flex min-w-0 items-start gap-1.5 text-xs leading-4.5 text-danger"
        >
          <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      ) : null}
    </div>
  );
}
