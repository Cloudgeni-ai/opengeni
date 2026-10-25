---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/runtime": patch
"@opengeni/api-router": minor
---

Event sources that need no setting up are ready to use. An MCP server the person is signed in to that offers events, a Gmail account they connected and "This workspace" are listed by `GET /v1/workspaces/:workspaceId/event-sources/ready` (`client.listReadyEventSources`) with a key such as `mcp-server:<serverId>`, `gmail:<connectionId>` or `workspace`. A trigger's `sourceId` can be that key: saving adds the person's own source behind it, or reuses the one they have. Agents see them under `readyToAdd` in `event_sources_list` and can set up an automation on one without anyone adding a source first. `AutomationsPanel` and the web app's form offer them in the source picker; `useEventSourceStandIns` takes `readySources`, and stand-in ids are now the ready keys.
