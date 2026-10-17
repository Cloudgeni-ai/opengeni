---
"@opengeni/react": patch
---

Fewer duplicate requests when a conversation starts. Mounted readers of one workspace's model catalog (the conversation and the new-chat composer) now share one catalog and config request, `useAvailableModels` readers share one config request, and the provider's API-contract check joins the deployment config read the conversation is already making instead of sending its own.
