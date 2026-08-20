---
"@opengeni/contracts": patch
"@opengeni/react": patch
---

Stop the workbench Changes/Files/Terminal/Browser/Desktop surfaces from hanging when a workspace is force-drained for credits.

Browser and Desktop creates now map `SandboxViewerAdmissionBlockedError` to the same 402/429 `/viewers` already returns, instead of a generic 500. The workbench treats a 402 handshake as a credit-exhaustion error, keeps the machine chip Offline instead of Waking forever, and parses older BrowserSession capability documents that omit `permissions`.