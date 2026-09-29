---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
"@opengeni/sdk": patch
---

`createSession` and scheduled-task `agentConfig` accept `disabledBuiltinTools: ["human_input", "web_search"]` to remove `request_human_input` and provider-hosted web search for that session. The opt-out only narrows, is frozen at creation, and is inherited by child sessions. Web search opt-outs (session or workspace `agentWebSearchEnabled: false`) now also stop the SuperGrok transport from appending its own hosted `web_search`/`x_search` tools.
