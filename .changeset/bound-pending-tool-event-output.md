---
"@opengeni/db": patch
---

Store a pending tool call's replay output within the same 256 KiB bound as its `agent.toolCall.output` event. A tool that returned more than PostgreSQL can hold in one JSONB string (256 MiB) used to fail the whole turn with SQLSTATE 54000; the stored copy now keeps a head and tail preview with a `truncation` marker, and recovery replays that marker on the event.
