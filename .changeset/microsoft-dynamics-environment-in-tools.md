---
"@opengeni/runtime": patch
---

Each Microsoft Dynamics Dataverse tool's description now ends with the environment it is connected to (`Environment: <host>.`), so an agent can tell one connected environment from another and notice when a request names an environment that isn't connected yet.
