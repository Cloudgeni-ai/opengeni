---
"@opengeni/contracts": patch
"@opengeni/react": patch
"@opengeni/runtime": patch
---

Claude's web-search citation tags no longer show as raw markup in chat. With Anthropic's native web search, Claude marks quotes with `cite` tags that the API turns into citations only in ordinary answer text, so an answer given through the `wait_for_input` reply arrived with the tags intact. The Claude transport now rewrites them in that reply into the quoted text linked to the search result the tag's index names (or plain text when the index names no result). Chat timelines (web, desktop and mobile), copied text, Slack and Teams also show any remaining tag as its text, while fenced and inline code keep their contents exactly. `@opengeni/contracts/claude-cite-tags` exports `hasClaudeCiteTag`, `rewriteClaudeCiteTags` and the `ClaudeCiteSource` type.
