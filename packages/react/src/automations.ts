// @opengeni/react/automations: the reusable parts of event-driven automations.
// The trigger editor (which events start a run, and only when), the event
// source tile and words, the delivery log and event rows, and the pure models
// behind them. A host renders these inside its own automation form and pages,
// and passes its client's event-source reads in, so nothing here fetches on
// its own or assumes a router.
import type { EventDelivery } from "@opengeni/sdk";
import { createOpenGeniText } from "./messages/runtime";
import type { RowListColumn } from "./ui/list-row";
import type { ProductStatus } from "./ui/status-badge";
import { eventRowColumns as rowColumns } from "./components/automations/event-rows";
import {
  eventDeliveryStatusBadge as deliveryStatusBadge,
  eventSourceChoices as sourceChoices,
  type EventSourceChoiceMeta as ChoiceMeta,
} from "./components/automations/event-source-model";
import { eventCommonFields as commonFields } from "./components/automations/event-trigger-model";

export {
  DEFAULT_EVENT_RUNS_PER_HOUR,
  EVENT_CONDITION_OPERATORS,
  eventCommonFields,
  EVENT_TRIGGER_CONDITIONS_MAX,
  EVENT_TRIGGER_TYPES_MAX,
  EVENT_TRIGGERS_PER_AUTOMATION_MAX,
  MAX_EVENT_RUNS_PER_HOUR,
  emptyEventTriggersDraft,
  eventConditionDraftFrom,
  eventConditionFieldSuggestions,
  eventConditionFromDraft,
  eventConditionOperator,
  eventConditionOperatorLabel,
  eventConditionsLabel,
  eventTriggerDraftFrom,
  eventTriggersDraftFrom,
  eventTriggersInputFrom,
  eventTriggersShortLabel,
  eventTriggerWords,
  eventTypeDescriptor,
  eventTypeIssue,
  eventTypeLabel,
  eventTypesLabel,
  hasEventTriggerIssues,
  newEventConditionDraft,
  newEventTriggerDraft,
  sameEventTriggers,
  validateEventTriggers,
} from "./components/automations/event-trigger-model";
export type {
  EventConditionDraft,
  EventConditionOperatorOption,
  EventTriggerDraft,
  EventTriggerIssues,
  EventTriggersDraft,
  EventTriggersIssues,
  EventTriggerWords,
} from "./components/automations/event-trigger-model";
export {
  WEBHOOK_ADAPTER_OF,
  byteSizeLabel,
  createEventSourceRequest,
  deliveryEventsLabel,
  deliveryTitle,
  eventActorLabel,
  eventDeliveryStatusBadge,
  eventSourceAddLabel,
  eventSourceChoiceMeta,
  eventSourceChoiceName,
  eventSourceChoiceOf,
  eventSourceChoices,
  eventSourceKindLabel,
  eventSourceProviderDomain,
  eventSourceStatusBadge,
  eventSourceSubjectOfChoice,
  isEventSourceChoice,
  pastedWebhookSetup,
} from "./components/automations/event-source-model";
export type {
  EventSourceChoice,
  EventSourceChoiceMeta,
  PastedWebhookSetup,
} from "./components/automations/event-source-model";
export {
  EventSourceTile,
  eventSourceLogoResolver,
} from "./components/automations/event-source-tile";
export type {
  EventSourceLogoResolver,
  EventSourceLogoSubject,
} from "./components/automations/event-source-tile";
export {
  EventConditionsEditor,
  EventTriggerEditor,
  EventTriggersField,
  EventTypePicker,
  useEventTypes,
} from "./components/automations/event-trigger-editor";
export type {
  EventTriggerEditorProps,
  EventTriggersFieldProps,
  EventTypesState,
} from "./components/automations/event-trigger-editor";
export {
  EventTriggerSummary,
  type EventTriggerSummaryProps,
} from "./components/automations/event-trigger-summary";
export {
  EventDeliveryRow,
  InboundEventDetail,
  InboundEventRow,
  eventRowColumns,
  inboundEventMeta,
} from "./components/automations/event-rows";
export {
  SESSION_AUTOMATION_WAIT_LABEL,
  sessionAutomationWait,
  sessionAutomationWaitLabel,
  type SessionAutomationWait,
} from "./session-list-model";

// English-only constants from before the automation parts took the host's text.
// They stay until the next major; new code calls the functions above with `t`.
const english = createOpenGeniText();

/** @deprecated English only. Use `eventSourceChoices(t)`. */
export const EVENT_SOURCE_CHOICES: readonly ChoiceMeta[] = sourceChoices(english);

/** @deprecated English only. Use `eventDeliveryStatusBadge(t, status)`. */
export const EVENT_DELIVERY_STATUS: Record<
  EventDelivery["status"],
  { status: ProductStatus; label: string }
> = {
  accepted: deliveryStatusBadge(english, "accepted"),
  ignored: deliveryStatusBadge(english, "ignored"),
  rejected: deliveryStatusBadge(english, "rejected"),
  failed: deliveryStatusBadge(english, "failed"),
};

/** @deprecated English only. Use `eventCommonFields(t)`. */
export const EVENT_COMMON_FIELDS: ReadonlyArray<{ field: string; description: string }> =
  commonFields(english);

/** @deprecated English only. Use `eventRowColumns(t)`. */
export const INBOUND_EVENT_COLUMNS: RowListColumn[] = rowColumns(english);

/** @deprecated English only. Use `eventRowColumns(t)`. */
export const EVENT_DELIVERY_COLUMNS: RowListColumn[] = rowColumns(english);
