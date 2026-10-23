---
"@opengeni/sdk": minor
---

Add event sources and event triggers for automations: `listEventSources`, `createEventSource`, `getEventSource`, `updateEventSource`, `deleteEventSource`, `rotateEventSourceSecret`, `sendTestEvent`, `listEventDeliveries`, `replayEventDelivery`, `listInboundEvents` and `listEventSourceTypes`, plus an `events` field on scheduled tasks and runs. Servers advertise support through `clientConfig.eventTriggers`.
