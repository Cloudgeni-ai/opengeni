// @opengeni/react/automations: automations for any host. `AutomationsPanel`
// is the drop-in: a workspace's or a chat's automations, with create, edit,
// on and off, Run now and recent runs, read and written through the host's
// client. The parts it is built from stay available for a host's own pages:
// the form and its "When" (schedule and event triggers), the trigger editor,
// the event source tile and words, the delivery log and event rows, and the
// pure models behind them. Apart from the panel nothing here fetches on its
// own or assumes a router.
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
  AutomationsPanel,
  type AutomationEventServer,
  type AutomationsPanelProps,
} from "./components/automations/automations-panel";
export { AutomationForm, type AutomationFormProps } from "./components/automations/automation-form";
export {
  AUTOMATION_FREQUENCIES,
  AutomationWhenField,
  type AutomationWhenFieldProps,
} from "./components/automations/automation-when-field";
export {
  AUTOMATION_NAME_MAX_LENGTH,
  automationCadence,
  automationCadenceIssue,
  automationCadenceRepeats,
  automationCadenceWords,
  automationCreateRequest,
  automationDraftFrom,
  automationListensForEvents,
  automationName,
  automationNextRun,
  automationRunEventsLabel,
  automationRunStatusLabel,
  automationRunTriggerLabel,
  automationScheduleSpec,
  automationScheduleWords,
  automationUpdateRequest,
  automationWhenSentence,
  automationWhenWords,
  defaultAutomationCadence,
  deriveAutomationName,
  hasAutomationDraftIssues,
  hasEventTriggers,
  isAgentAutomation,
  isFinishedOnce,
  newAutomationDraft,
  sortAutomations,
  validateAutomationDraft,
  viewerTimeZone,
} from "./components/automations/automation-model";
export type {
  AutomationDestination,
  AutomationDraft,
  AutomationDraftIssues,
  AutomationScheduleWords,
} from "./components/automations/automation-model";
export {
  EventArgumentsField,
  type EventArgumentsFieldProps,
} from "./components/automations/event-arguments-field";
export {
  eventArgumentFields,
  eventArgumentLabel,
  eventArgumentsForEvent,
  eventArgumentsValue,
  withEventArgument,
} from "./components/automations/event-arguments-model";
export type {
  EventArgumentField,
  EventArgumentOption,
} from "./components/automations/event-arguments-model";
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
