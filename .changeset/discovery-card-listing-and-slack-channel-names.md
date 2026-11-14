---
"@opengeni/runtime": patch
"@opengeni/contracts": minor
"@opengeni/sdk": minor
---

`tool_list` browsing now shows an integration's Connect card the way `tool_search` does: a first page that a `namePrefix` or `group` filter left empty, when the filter's words name exactly one integration the person can connect and nobody installed, adds the same `notConnected` notice and `connectCard` field, through the same lookup, card tool, dedupe and policy. Browsing without such a filter is unchanged. A search that opens with a one-word integration name as the label of what follows ("Airtable list records…", "Linear: create an issue") now names it distinctively, so it shows the card too; a sentence-opening capital before an ordinary word ("Linear regression") still does not.

When tool discovery shows no new card for an integration a request may name, the run records a new `tool.discovery_card` session event (in `@opengeni/contracts` `SessionEventType` and `@opengeni/sdk` `SESSION_EVENT_TYPES`) with its source, outcome (`skipped`, `already_shown`, `not_shown`, `failed`), reason and the integrations concerned.

A `tool_list` `namePrefix` that is one digest-aliased MCP tool's `mcp_<digest>` now lists every tool of that tool's connection, since each aliased tool has its own digest.

The Slack tools' `channel` argument now also accepts a channel name (`#general` or `general`), resolved to its conversation ID, with a clear error when the name is not found, ambiguous or cannot be looked up. Conversation IDs work as before.
