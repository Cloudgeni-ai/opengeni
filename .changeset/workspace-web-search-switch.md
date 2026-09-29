---
"@opengeni/contracts": patch
"@opengeni/worker-bundle": patch
"@opengeni/sdk": patch
---

Workspace settings accept `agentWebSearchEnabled: false`, which removes the provider-hosted `web_search` tool from that workspace's turns. It only narrows: an absent or `true` value follows the deployment and model as before.
