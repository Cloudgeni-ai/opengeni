# Conversation context compaction

OpenGeni has one compaction mechanism: durable, portable plaintext compaction
that follows the local compaction path in Codex CLI 0.144.4. It is used for
OpenAI, Azure, Codex subscriptions, and registry providers. There is no
provider-side mode, off switch, compatibility ladder, request-local history
trim, or deterministic non-model fallback.

Portable plaintext is required for the Codex subscription pool. A session can
move between independently authenticated ChatGPT subscriptions, while Codex's
remote encrypted compaction item is tied to the provider/account that created
it. Persisting that opaque item would make a later subscription unable to
recover the compacted assistant/tool history.

The implementation lives in:

- `packages/runtime/src/context-compaction.ts`: thresholds, upstream prompt and
  prefix, rebuild rules, and the typed compaction signal.
- `packages/runtime/src/index.ts`: the tool-less summarizer and per-call signal.
- `apps/worker/src/activities/context-compaction.ts`: summarizer retry and the
  fenced durable replacement.
- `apps/worker/src/activities/agent-turn.ts`: pre-call and same-turn recovery.
- `packages/db/src/index.ts`: the atomic history replacement and token signal.

## Token limits

Each resolved model can declare three distinct values:

| value | purpose |
| --- | --- |
| raw context window | basis for automatic compaction |
| effective input window | provider-safe input ceiling |
| automatic compaction limit | proactive checkpoint trigger |

If a model has no explicit automatic limit, OpenGeni uses
`floor(rawWindow * contextCompactionThresholdRatio)`. The ratio defaults to
0.9 and is clamped to 0.3–0.9. An explicit limit is capped at 90% of the raw
window, matching Codex core.

The Codex subscription catalog verified with Codex CLI 0.144.4 on 2026-07-14
has:

| quantity | tokens |
| --- | ---: |
| raw context window | 272,000 |
| effective input window (95%) | 258,400 |
| automatic compaction limit (90%) | 244,800 |

The signal prefers provider-reported input usage from the exact current turn
attempt. Before the first provider usage exists, it estimates serialized input
at roughly four characters per token. Attempt fencing prevents a stale worker
from overwriting the signal used by the current attempt.

## What the summarizer sees

The compaction model receives:

1. the current active model history as structured items;
2. one final user message containing Codex's checkpoint prompt;
3. the same system instructions as the running agent;
4. no tools and no provider-side context-management policy.

Responses providers use the Agents SDK's structured Responses conversion, so
tool calls/results remain real protocol items on the wire. Chat providers use a
plain-text adapter because Chat Completions has a different item protocol.

If the summarizer request exceeds the context window, OpenGeni removes exactly
one oldest history item and retries, retaining the checkpoint prompt. It repeats
until the request fits or only the prompt remains. Other provider errors
propagate and do not mutate active history. An empty model summary becomes
Codex's explicit `(no summary available)` placeholder.

## Durable replacement

The replacement history is:

1. the newest real user messages that fit one cumulative 20,000-token budget,
   in chronological order;
2. one user-role summary item prefixed with Codex's `summary_prefix.md` text and
   marked `opengeni_context_summary: true`.

Prior summaries, platform-authored ephemeral context, and images are not kept
as user boundaries. Assistant messages, reasoning, tool calls, and tool results
leave the active model history but remain in inactive audit rows.

The generated replacement must estimate strictly smaller than the active input.
One transaction locks workspace, session, and turn; verifies
`turnId + executionGeneration + attemptId`; supersedes every old active row;
inserts the replacement at fresh whole-number positions; updates
`last_input_tokens`; records `session.context.compacted`; and clears a manual
compaction request when applicable. A stale attempt can do none of those writes.

## Turn behavior

Before a fresh user or goal inference, the worker checks the durable token
signal and any manual compaction request. During an inference, the per-model-call
filter raises `CompactionNeededError` when the threshold is reached. A provider
context-window rejection enters the same path.

The successful summarizer response reports usage through the same durable,
idempotency-keyed `agent.model.usage` and billing-ledger path as an ordinary
model call, owned by the current execution attempt. Codex subscription
allowance headers use the same per-account request context and remain separate
from OpenGeni token billing.

Both paths compact and restart sampling inside the same activity, turn,
attempt, and sandbox. Compaction never creates a prompt-queue row, a recovery
message, a new logical turn, or another sandbox. The model then sees the durable
replacement history and continues the work.

If summarization fails, the turn ends with an honest
`context_compaction_failed` result. OpenGeni does not continue with silently
trimmed input and does not install a mechanical fallback summary.

Manual `/compact` sets one durable idempotent request. During active inference,
the worker observes it at the next model boundary and retries sampling in the
same logical turn after replacement. While idle, the request creates one
born-running `source="compaction"` maintenance execution on the existing turn
ledger. That execution is not conversational work and is never a prompt-queue
row; it exists to own model allocation, attempt fencing, recovery, and
settlement, and it never prepares tools or a sandbox.

The exact attempt that successfully installs the replacement clears the request
in the same transaction. If there is no active history, or the generated
checkpoint is not strictly smaller, the exact attempt instead records
`session.context.compaction.skipped` with that reason and clears the request in
one transaction without changing history. A failed, paused, recovered, or
superseded attempt cannot lose the request or publish a current compaction
result.
