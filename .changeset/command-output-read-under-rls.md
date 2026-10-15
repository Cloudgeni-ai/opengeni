---
"@opengeni/db": patch
---

Reading a background command's output no longer walks every output chunk the session ever produced. Under row-level security the existing page index could not use its JSON `commandId` key (the `->>` operator is not leakproof, so policies demote it to a per-row filter), so each `command_read`/`command_wait` in a long session scanned the whole session's command output: tens of thousands of rows and seconds per read on a busy deployment. A new online index (`session_events_command_output_client_idx`, built concurrently in rolling migration 0788) keys output by its client event id in byte order, and the read bounds its scan to the command's id prefix and the cursor. Results are unchanged.
