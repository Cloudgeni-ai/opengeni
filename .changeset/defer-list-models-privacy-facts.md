---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
---

New sessions find `list_models` and `privacy_facts` through tool search instead of carrying them in every model request, saving about 1.2 KB (roughly 240 tokens) per request whenever the turn has the search router. Each session records which tools its requests carry in `sessions.first_request_tools_revision` (migration 1513) once, before its first model request, so existing sessions keep exactly the tools they already send. `BuildAgentOptions.firstRequestToolsRevision` selects the behaviour; omitting it keeps both tools in every request.
