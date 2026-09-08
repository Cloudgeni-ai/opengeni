---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/runtime": minor
"@opengeni/worker-bundle": minor
"@opengeni/sdk": minor
---

Separate command interaction from session history. Add bounded retained-output command reads and use the same operation for command waits. Terminal reads observe completion and suppress only still-pending completion notifications; running reads, claimed notifications, and historical tool results remain unchanged.

Make session history conversation-first with complete-message pagination and explicit results, tools, and debug views. Preserve cursor detail selection, provide oversized-message continuation, and keep queued prompts distinct from processed conversation. Update concise model guidance for the new surfaces.

`command_wait` now uses `waitSeconds`, an output cursor, and the same flat result as `command_read`; clients using the previous command wrapper must update. Apply the additive command-observation migration before starting the new readers.