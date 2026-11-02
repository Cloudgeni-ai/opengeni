---
"@opengeni/react": patch
"@opengeni/sdk": patch
---

Error toasts and messages no longer show "API 409:" or a request reference when a request is refused for a reason you can act on (a 4xx); they say only what to do. Unexpected failures (5xx, network, unknown) keep a short message, and their reference is available behind a quiet "Copy details" (or Technical details) instead of inline text. Toasts no longer show an error's raw text. Archiving a chat with "Keep this chat active" on now offers one action, "Turn off and archive", which turns the setting off and archives; Undo, or a failed archive, turns it back on.
