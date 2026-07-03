# Conversation context compaction

OpenGeni runs long-lived agent sessions whose `session_history_items` can grow
past the model context window. Compaction is provider-aware:

- **OpenAI platform / server mode** keeps using the Responses API server-side
  `context_management` path. This path is intentionally unchanged.
- **Azure / client mode** uses OpenGeni's local compaction, now simplified to
  **Codex CLI parity**: checkpoint summarize the current active history, then
  rebuild active history as user messages plus one summary.

Code wins over this document. The main files are:

- `packages/config/src/index.ts` - mode and window settings.
- `packages/runtime/src/context-compaction.ts` - client threshold, Codex prompt
  constants, rebuild helpers, typed `CompactionNeededError`, and the read-path
  budget guard.
- `packages/runtime/src/index.ts` - tool-less summarizer call and per-model-call
  input filter.
- `apps/worker/src/activities/context-compaction.ts` - DB orchestrator for
  client compaction.
- `apps/worker/src/activities/agent-turn.ts` - turn-start check, manual
  `/compact`, per-call proactive recovery, and provider overflow recovery.
- `packages/db/src/index.ts` - `applyContextCompaction`,
  `getActiveSessionHistoryItems`, `setSessionLastInputTokens`, and
  `nextSessionHistoryPosition`.

## Mode Resolution

`contextCompactionMode` (`OPENGENI_CONTEXT_COMPACTION_MODE`) accepts:

| mode | result |
| --- | --- |
| `auto` | `server` when `openaiProvider === "openai"`, otherwise `client` |
| `server` | force server-side compaction |
| `client` | force client-side compaction |
| `off` | no compaction |

The server path still uses `contextServerCompactThresholdTokens` when set,
otherwise `floor(contextWindowTokens * contextCompactionThresholdRatio)`.
`contextCompactionThresholdRatio` is configured with
`OPENGENI_COMPACTION_THRESHOLD_RATIO`, defaults to `0.6`, and is clamped to
`[0.3, 0.9]`.

## Client Trigger

Client mode has one threshold:

```
signal > contextWindowTokens * contextCompactionThresholdRatio
```

With the defaults (`1,050,000` window, ratio `0.6`), the threshold is
`630,000`.

The signal prefers provider-reported input tokens:

- Turn-start compaction reads `sessions.last_input_tokens`, which is persisted
  from provider usage.
- Mid-turn proactive compaction reads the most recent provider usage observed in
  the current activity.
- `chars / 4` estimation is only the pre-first-call fallback when no provider
  signal exists yet.

The old client soft/hard fraction pair and `contextKeepRecentTokens` no longer
drive client compaction. Those config keys remain parsed for environment
back-compat, but both client and server default thresholds now use
`contextCompactionThresholdRatio`. `contextSummaryMaxTokens` is also parsed for
back-compat; client compaction uses the fixed `SUMMARY_BUFFER_TOKENS` output
ceiling.

## Client Rebuild

The checkpoint summarizer call is tool-less and receives a rendered transcript
string, not raw SDK/Responses history items. The transcript is built from:

1. Current active history.
2. One synthesized user message containing Codex CLI's
   `prompts/templates/compact/prompt.md` text verbatim.

Rendering all providers to text deliberately avoids provider tool-call protocol
validation during summarization; SDK-vs-wire item drift such as `callId` vs
`call_id` cannot reject a compaction request.

The model output is wrapped with Codex CLI's `summary_prefix.md` text verbatim
and stored as one plain user `message` item with
`opengeni_context_summary: true`.

The new active history is:

1. All real user messages in order, excluding prior OpenGeni summary items.
2. Each retained user message capped at 20k estimated tokens by truncating the
   middle with a marker.
3. One summary item appended last.

Assistant messages, tool calls/results, reasoning items, and images are removed
from active history. They are not deleted: the compaction DB transaction marks
the old active rows inactive and inserts replacement active rows, preserving the
audit trail.

If the full rendered summarizer call fails or returns no summary, OpenGeni
retries the summarizer once with a hard-trimmed transcript that drops the oldest
rendered items and keeps the checkpoint prompt. If that also fails, OpenGeni
performs a deterministic non-LLM fallback compaction: keep initial instruction
messages and the most recent user messages that fit a strict fallback budget,
middle-truncate any oversized retained message, and append a mechanical
fallback summary item. A required compaction therefore writes a smaller active
history whenever a DB write is possible.

## Turn Flows

Turn-start client compaction runs before reading history for a fresh
`user.message` or `goal.continuation` turn. Manual `/compact` sets the existing
durable request flag and forces this same rebuild on the next turn.

The per-model-call filter still performs screenshot elision and the existing
input budget guard. In client mode, when the single threshold is crossed
mid-turn, it throws `CompactionNeededError`. `agent-turn.ts` handles that error
through the same recovery loop as provider context-window overflow:

- If no model/tool progress was persisted, compact and retry inside the same
  activity, bounded by a per-turn recovery cap.
- If progress was persisted, compact and requeue the turn with a resume notice
  (`reason: "context_compacted"`).
- If a turn already resumed from compaction immediately needs compaction again,
  it falls back to idle instead of looping.
- A `compacted:false` result is never treated as success. The turn reports
  `compaction summarization failed: ...` instead of retrying unchanged or
  surfacing a misleading `Context compaction needed` threshold error.

Provider context-window overflow remains a reactive safety path and reuses the
same compaction/retry/requeue logic.

## Read-Path Guard

`enforceInputBudget` remains a request-local airbag. It can drop the oldest
history at a clean user-message boundary so an oversized input is not sent. It
does not create summaries and does not mutate the DB. It exists behind the
real compaction path as a last-resort guard.
