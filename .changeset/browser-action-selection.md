---
"@opengeni/react": patch
---

Keep browser actions on the selected tab when earlier receipts arrive after a source, tab, controller or document change. Discard prior source state before paint and capture immutable controller fences. Preserve immediate input from completed receipts for the same page without extra accessibility requests. Prevent earlier action deliveries from replacing newer settled observations or failures while returning each operation's result to its caller. Fence selection observations and errors to their exact invocation so a selection round trip cannot revive an obsolete view. Order selection observations with refresh reads while preserving current action outcomes.

Prevent older tab-open and tab-close results from replacing later selections. Reconcile their inventory after pending selections settle without replacing the selected page's observation.
