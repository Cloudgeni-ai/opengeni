---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
"@opengeni/api-router": patch
---

A JavaScript dialog (alert, confirm, prompt) that a browser action opens no longer leaves the call hanging or silent. The action returns at once with the dialog's type and text, even when no page view was requested; a batch stops at the dialog and says how many of its actions ran; and page reads, fenced batch steps and screenshots that the dialog blocks end immediately with the same guidance to answer it with `handle_dialog`, instead of waiting out their timeouts. This holds in managed browsers and in the user's own Chrome.
