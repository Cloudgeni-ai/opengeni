---
"@opengeni/react": patch
---

Sent user messages now show their attachments the way the composer showed them before sending: images as thumbnails that open in the preview, other files as named chips that open or download. This applies to history, optimistic sends and accepted steers. The composer's attachment chips moved to a shared module and gained a read-only mode, and the console's separate large-preview rendering of message files was replaced by the same chips.
