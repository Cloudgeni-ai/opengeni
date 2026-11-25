---
"@opengeni/react": minor
"@opengeni/react-native": patch
---

A resolved approval notice no longer says "You responded to this approval." when no decision was recorded for it, for example when the turn moved on, was cancelled, replaced by a Steer or failed before it was answered. It now reads "Not answered." with no check mark, and reads as answered if an answer is recorded later. Answers match the question they were given for: its approval id, its turn and its MCP question round, the same way the server keys them (older decisions without a turn or round match the latest open question with that id). A question asked again while its first notice still waits (a worker restart) takes its answer on both notices, and answering an older notice no longer ends a newer one that still asks more. Older requests without an approvals list still read as answered once a decision for their turn, and for their approval id when they carry one, is recorded.

New export from `@opengeni/react/timeline-model`: `noticeApprovalAnswered(item)`, true for a resolved approval notice with a recorded answer.
