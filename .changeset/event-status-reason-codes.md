---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/db": minor
"@opengeni/core": minor
---

Event sources and triggers now say why they are blocked or off as a code clients can word in their own language. `EventSource` and `EventTrigger` gain `statusReasonCode` and `statusReasonDetail`, and `EventTypeDescriptor` gains `unavailableReasonCode` and `unavailableReasonDetail`, next to the existing English sentence (codes are listed in `EVENT_STATUS_REASON_CODES`). `@opengeni/react/automations` adds `eventStatusReasonText`, which words a known code from the host's message catalog (`automations.statusReason.*`) and shows the server's sentence for a code it doesn't know; source and trigger badges, the event source picker and the event type picker use it.
