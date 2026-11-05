---
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/react-native": patch
---

A run with nothing for the person now leaves no trace for them. When a turn's answer is exactly `NO_REPLY` (for example an automation run that found nothing to do), the chat is not marked unread, no inbox reply item opens and no phone notification is sent. The run stays in the session's history. Migration 1278 changes the event cursor, inbox and push triggers; the web and native read-acknowledgement predicate follows the same rule.

A finished turn's phone notification now carries its answer, the same text the chat shows, instead of "The agent replied."; a turn with no answer sends none. Events that arrive close together already start one run, so they give one answer and one notification.

Internal IDs hidden from displayed system text no longer leave broken text behind. An ID now goes with what only named it: its label ("Organisation: <id>"), or a parenthetical that held only it ("(run <id>)"), and the punctuation around it is tidied, so "Connected. Organisation: <id>." reads "Connected." This applies to update summaries and to what an automation run's event says, on web and native.
