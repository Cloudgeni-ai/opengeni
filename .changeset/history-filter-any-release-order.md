---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
---

Chat history no longer depends on the server and `@opengeni/react` being released in a particular order. The events API now says when it applies the conversation filter (`X-OpenGeni-Conversation-Filter: 2`, read as `SessionEventPage.conversationFilter`). When a server does not say so, the React history reads keep tool calls in and drop the ones that are not presented in the browser, so an older server that ignores `presentedToolCalls` no longer makes images, published files or Skill cards vanish from history.

A long turn's model bookkeeping also stops filling the history window: each model call's `agent.model.request` and `agent.model.usage` rows load with the turn's steps. The server keeps the request rows up to a turn's first model response, which draw its startup phase, and every bookkeeping row of a turn that has no other steps, so what the conversation shows is unchanged. `createEmbeddedSessionClient` now keeps `listEventPage` when the base client has it.
