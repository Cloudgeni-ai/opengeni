---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Make a finished child's result carry its answer. An idle `child_terminal_result` now includes optional `payload.finalAnswer`: the child's newest result-bearing answer, frozen by the idle settlement, bounded to 8 KiB UTF-8 with a head/tail truncation marker and a `session_events` pointer to the full text (`childTerminalResultFinalAnswer`, `CHILD_TERMINAL_RESULT_FINAL_ANSWER_MAX_BYTES`). Worker enrichment now merges onto the committed payload instead of replacing it, and an untruncated answer serves as the parent claim's consumption evidence. When a parent's exact live attempt reads a direct child's complete answer through `session_wait` or `session_events`, the still-pending idle result for that answer is superseded (`consumed_by_parent_read`, `supersedeConsumedChildTerminalResults`) and `session_wait` reports the remaining own pending input. The operational contract and the `session_create`, `session_wait`, `session_get`, `session_send_message`, and `wait_for_input` descriptions now price a child, prefer a direct answer or reusing an existing child, and steer multi-minute waits to `wait_for_input` instead of alternating `session_wait` and `session_get`. No tool is capped or removed.
