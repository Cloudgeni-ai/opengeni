---
"@opengeni/react": patch
"@opengeni/sdk": patch
---

Error toasts and messages no longer show "API 409:" or a request reference when a request is refused for a reason you can act on (a 4xx); they say only what to do. Unexpected failures (5xx, network, unknown) keep a short message. In the session UI's toasts, inline error text, notices and field errors their reference sits behind a quiet "Copy details" (or Technical details); toasts that call sonner directly still show it inline, as before. Toasts no longer show an error's raw text. Archiving a chat with "Keep this chat active" on now offers one action, "Turn off and archive", which turns the setting off and archives; Undo, or a failed archive, turns it back on.
