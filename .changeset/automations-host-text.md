---
"@opengeni/react": minor
---

The automation parts in `@opengeni/react/automations` now speak the host's language. Every label, hint and validation message comes from the message catalog under `automations.*`, so `OpenGeniMessagesProvider` translates the trigger editor, event source tiles, delivery log and the "waiting for an event" status like the rest of the UI. The pure helpers take the `t` from `useOpenGeniText()` first. New: `eventSourceChoices(t)`, `eventSourceChoiceName`, `eventDeliveryStatusBadge`, `eventCommonFields(t)`, `eventConditionOperatorLabel`, `eventRowColumns(t)` and `sessionAutomationWaitLabel`. The English-only constants they replace (`EVENT_SOURCE_CHOICES`, `EVENT_DELIVERY_STATUS`, `EVENT_COMMON_FIELDS`, `INBOUND_EVENT_COLUMNS`, `EVENT_DELIVERY_COLUMNS`, `SESSION_AUTOMATION_WAIT_LABEL`) are deprecated.
