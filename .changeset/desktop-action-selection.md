---
"@opengeni/react": patch
---

Preserve the current Desktop selection and generation when an action receipt arrives after a view or source change. Discard previous source state before paint, while retaining current observations during same-source refreshes. Keep explicit focus behavior and fresh fences for immediate sequential input. Prevent earlier action deliveries and their refreshes from replacing newer settled observations or control failures while returning each operation's result to its caller. Fence selection observations and errors to their exact invocation so a selection round trip cannot revive an obsolete view. Order selection observations with refresh reads while preserving current action outcomes.
