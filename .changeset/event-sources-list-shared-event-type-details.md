---
"@opengeni/api-router": patch
---

`event_sources_list` with a `sourceId` no longer repeats the same details for every event type. When all of a source's event types have the same condition fields and MCP `argumentsSchema`, as on an MCP server whose hundreds of types share one shape, the result gives them once in `everyEventType`, and each type carries its name and description. Sources whose types differ return the same result as before. The REST event-types endpoint the trigger editor uses is unchanged.
