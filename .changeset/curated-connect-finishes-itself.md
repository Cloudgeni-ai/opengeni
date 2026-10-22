---
"@opengeni/react": patch
---

Connecting a built-in integration such as Outlook or Gmail now finishes by itself after sign-in: setup loads the reviewed tools and installs them, showing "Finishing setup…" instead of stopping at a "Choose tools" step. Before, closing the window or leaving the page at that step left the account connected with no tools, so agents could not use it. Custom OpenAPI and GraphQL sources still ask which tools to add, and any error brings the manual controls back.
