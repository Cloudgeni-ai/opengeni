// @opengeni/react/automations: the reusable parts of event-driven automations.
// The trigger editor (which events start a run, and only when), the event
// source tile and words, the delivery log and event rows, and the pure models
// behind them. A host renders these inside its own automation form and pages,
// and passes its client's event-source reads in, so nothing here fetches on
// its own or assumes a router.
export {
  DEFAULT_EVENT_RUNS_PER_HOUR,
  EVENT_CONDITION_OPERATORS,
  EVENT_COMMON_FIELDS,
  EVENT_TRIGGER_CONDITIONS_MAX,
  EVENT_TRIGGER_TYPES_MAX,
  EVENT_TRIGGERS_PER_AUTOMATION_MAX,
  MAX_EVENT_RUNS_PER_HOUR,
  emptyEventTriggersDraft,
  eventConditionDraftFrom,
  eventConditionFieldSuggestions,
  eventConditionFromDraft,
  eventConditionOperator,
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
  EVENT_DELIVERY_STATUS,
  EVENT_SOURCE_CHOICES,
  WEBHOOK_ADAPTER_OF,
  byteSizeLabel,
  createEventSourceRequest,
  deliveryEventsLabel,
  eventActorLabel,
  eventSourceAddLabel,
  eventSourceChoiceMeta,
  eventSourceChoiceOf,
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
  EVENT_DELIVERY_COLUMNS,
  EventDeliveryRow,
  INBOUND_EVENT_COLUMNS,
  InboundEventDetail,
  InboundEventRow,
  inboundEventMeta,
} from "./components/automations/event-rows";
export {
  SESSION_AUTOMATION_WAIT_LABEL,
  sessionAutomationWait,
  type SessionAutomationWait,
} from "./session-list-model";
