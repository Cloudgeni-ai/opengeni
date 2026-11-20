# list_models and privacy_facts found through tool search

No system-prompt text changes and no tool description changes. Only which
tools a new session's requests carry changes.

`list_models` and `privacy_facts` were in every request of every session. A
session created after migration 1513 now finds them through tool search by
exact name, like any deferred tool, on every turn that has the search router
for other tools. On a turn without the router they stay in the request, so
they never bring the router (and its larger schemas and discovery
instructions) on their own.

Existing sessions are unchanged. Each session records its first-request tools
revision once, before its first model request, in
`sessions.first_request_tools_revision`: every session that existed before the
migration is 0 and keeps both tools in every request; a session that never ran
an attempt gets 1. Forks copy their source's value. No text an earlier request
sent ever changes.

Size, per request of a revision-1 session with the router: the two tool
definitions, 1,166 bytes as Responses tool JSON (`list_models` 549,
`privacy_facts` 617), about 237 tokens (o200k: 113 and 124). The search result that loads them when needed adds their schemas once,
after the request that asked for them.

Why it is general: both tools serve rare requests (switching models, privacy
questions) yet were paid for on every call. The text that names them still
reads correctly when they are deferred: the privacy rule ("only from
`privacy_facts`") and the model-switching tool's "pick a sensible model from
list_models" name an exact tool, and the tool discovery section already says
deferred schemas are omitted from the first request and that known exact
names load directly.
