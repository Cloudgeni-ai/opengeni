---
"@opengeni/react": minor
"@opengeni/react-native": patch
---

A resolved approval notice no longer says "You responded to this approval." when no decision was recorded for it, for example when the turn moved on before it was answered. It now reads "Ended without an answer." with no check mark. An answer recorded for another turn never counts as this wait's answer. A request asked again before it was answered (a worker restart) takes the answer on both notices. Older requests without an approvals list still read as answered once a decision for their turn, and for their approval id when they carry one, is recorded.

New export from `@opengeni/react/timeline-model`: `noticeApprovalAnswered(item)`, true for a resolved approval notice with a recorded answer.
