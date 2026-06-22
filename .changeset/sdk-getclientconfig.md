---
"@opengeni/sdk": patch
---

Publish the SDK source that adds `OpenGeniClient.getClientConfig()` (returns `ClientConfig`). The method was added to the source but never republished, while `@opengeni/react@0.3.0` already depends on it — so react@0.3.0 consumers could not typecheck against the published sdk@0.2.0. Released as a patch so it stays within react@0.3.0's `^0.2.0` range.
