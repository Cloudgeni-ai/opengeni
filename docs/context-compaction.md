# Conversation context compaction

OpenGeni freezes a per-session compaction mode at create time
(`sessions.codex_compaction_mode`):

| Mode | When | Mechanism |
| --- | --- | --- |
| `portable` | All non-Codex sessions; existing sessions (backfill); new Codex sessions when the workspace sets `codexCompactionDefault: "portable"` | Durable plaintext checkpoint (Codex CLI local path). Free mid-session provider switching. |
| `remote_v2` | New Codex sessions by default (`codexCompactionDefault` absent or `"remote_v2"`) | Codex remote compaction v2 (wire `compaction_trigger` → opaque `{ type: "compaction", encrypted_content }`). On a valid compaction item, install and recompute usage — same as Codex CLI (no local “must shrink / must differ” gate). The compact request **must** reuse the ordinary turn prompt-cache prefix: model-visible tool schemas + the exact agent `instructions` + active history + `compaction_trigger` (CLI `base_instructions` / `model_visible_specs` parity). Empty instructions are rejected. Operator `/compact` on `remote_v2` builds the agent first so that prefix matches (portable `/compact` still skips prepareTools/sandbox). Retained cleartext keeps recent user/developer messages **including images** within the 64k budget. The Agents SDK rejects a bare trigger item, so OpenGeni emits `{ type: "unknown", providerData: { type: "compaction_trigger" } }` through `CompactionResponsesModel` and the Codex fetch normalizer restores the wire shape. Session is **Codex-only** for its lifetime (HTTP + worker admission). |

There is no off switch, compatibility ladder, request-local history trim, or
deterministic non-model fallback. A `remote_v2` session never silently falls
back to portable on remote failure (avoids mixed history shapes). Azure /
OpenAI platform remote compact APIs are out of scope.

Workspace setting `codexCompactionDefault` only affects **new** Codex sessions;
later setting changes never move an already-frozen session.

The portable path follows Codex CLI 0.146.0 local compaction (upstream tag
`rust-v0.146.0`, commit `be449751a978f02e5bbba886999662956c7f38f5`) and is used
for OpenAI, Azure, registry providers, and portable-locked Codex sessions.

The implementation lives in:

- `packages/runtime/src/context-compaction.ts`: thresholds, portable rebuild,
  remote v2 retain/rebuild helpers, and the typed compaction signal.
- `packages/runtime/src/index.ts`: portable summarizer + `requestRemoteCompactionV2`.
- `apps/worker/src/activities/context-compaction.ts`: mode branch, summarizer
  retry, remote fail-closed path, fenced durable replacement.
- `apps/worker/src/activities/agent-turn.ts`: pre-call and same-turn recovery;
  Codex ALS beta/turn-metadata headers for remote v2.
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

The Codex subscription catalog verified with Codex CLI 0.146.0 on 2026-07-29
has:

| quantity | tokens |
| --- | ---: |
| raw context window | 272,000 |
| effective input window (95%) | 258,400 |
| automatic compaction limit (90%) | 244,800 |

Before a provider response exists, the guard estimates the complete outgoing
request: active items, instructions, and tool schemas. After a response, it
anchors to that exact response's provider-reported **total** tokens and adds all
locally appended items after the last model-generated item, plus any positive
instruction or tool-schema growth. That anchor is accepted only when the usage
revision belongs to the immediately preceding model request. If stream
consumption lags the SDK's background model loop, the guard uses the complete
request estimate instead of binding delayed usage to a newer request. A durable prior-turn input count is only a
conservative floor; it can never hide a larger active-history estimate. Attempt
fencing prevents a stale worker from overwriting durable token state.
MCP schemas marked `defer_loading:true` are excluded from that estimate because
the provider excludes them from context until a bounded `tool_search_output`
discloses a match. The disclosed definition is then ordinary structured history
and is counted there.

Opaque Codex items (`type: "compaction"` with `encrypted_content`, and
reasoning with encrypted content) use Codex CLI's encrypted-payload heuristic
(`visible_bytes ≈ len * 3/4 - 650`, then `ceil(bytes / 4)` tokens). They are
never JSON-stringified into the local budget — that mistake treated ciphertext
as prompt text, inflated `last_input_tokens` after remote_v2, and re-triggered
auto-compaction.

Typed `input_image`, `image_url`, structured `image`, and
`computer_screenshot` objects are projected as native media before the generic
JSON/text estimate. Explicit detail and dimensions are retained; when needed,
a bounded byte prefix can recover PNG, GIF, WebP VP8X, or JPEG geometry. The
PNG path accepts geometry only from a complete first IHDR chunk with a valid
CRC32 over its type and 13-byte data. The dimension-aware estimate is capped, and unknown geometry uses one explicit
conservative bounded fallback. Inline image bytes or data-URL base64 therefore
do not grow the text estimate linearly. A data URL inside ordinary textual
content is still text and receives ordinary text accounting.

## Model-facing tool output

Every resolved model carries a textual tool-output policy. The Codex catalog's
10,000-token policy is the default; OpenGeni applies Codex's exact 1.2x JSON
serialization allowance, UTF-8-safe head/tail truncation, and explicit
`…N tokens truncated…` marker. Structured textual parts share one sequential
budget while images, files, and encrypted content remain structured.

The same pure normalizer runs at both canonical boundaries: before new
`session_history_items` rows are written and again at the final live model-input
seam. Raw pending tool-call receipts remain out-of-band until settlement so
Pause, Steer, failure, and deploy recovery can still reconcile the real outcome.
UI/audit events are a separate projection and are never used to reconstruct
model history.

The final request-time filter is not a compaction boundary. For an unchanged
canonical prefix and settings, a later provider request must reproduce the
earlier serialized filtered prefix exactly. Deterministic protocol
normalization and output bounding are allowed; arbitrary text must not be
classified or rewritten, and deleting or reordering an earlier
`view_image` call/result pair is not. Only the fenced durable replacement below
may remove active history.

## What the summarizer sees

The compaction model receives:

1. a bounded, protocol-valid temporary copy of the current active model history;
2. one final user message containing Codex's checkpoint prompt;
3. the same system instructions as the running agent;
4. no tools and no provider-side context-management policy.

Explicit compaction is a new accepted logical turn and therefore composes the
same deterministic workspace instruction-policy and preference-descriptor
governance as an ordinary agent turn. Its service initiator may inherit the
causal human's immutable preference authority from the latest started turn;
pure service compaction has no personal preference authority. The exact
snapshot is attempt-fenced, recovery reuses it, and Documents/RAG evidence are
never promoted into governance.

Responses providers use the Agents SDK's structured Responses conversion, so
tool calls/results remain real protocol items on the wire. Chat providers use a
request-local transcript adapter because Chat Completions has a different item
protocol. It projects only record types the Chat converter cannot express,
preserves their readable historical facts, and never mutates canonical history.
Historical `tool_search` calls and outputs are not rerun, compared with the
current catalog, or reclassified. There is no switch-time rewrite and no second
durable history form.

Before the provider call, OpenGeni estimates the complete checkpoint input. It
replaces aggregate oversized tool results oldest-first only in the temporary
copy, preserving recent detail. If that remains too large, it removes whole
oldest user-delimited work units and re-sanitizes the suffix so no tool result,
call, or reasoning fragment is orphaned. The first request is kept beneath the
effective input ceiling, raw window minus requested summary, and estimator
headroom. If the provider still reports context overflow, OpenGeni performs one
half-size refit and one final request. The 50% retry covers the greater-than-2×
provider/byte-estimator skew measured in the production incident. It never
issues one failing provider call per history item.

These reductions belong only to the explicit compaction transition and their
rewrite/drop counts are recorded on `session.context.compacted`. The unmodified
active history remains the source for the durable replacement and stays
byte-for-byte active if either provider request fails. For Codex subscriptions,
terminal SSE `response.failed` and `response.error` events that arrive on HTTP
200 become one non-retried, marked provider error with a bounded projection of
type/code/message/parameter and response identity; arbitrary nested diagnostics
are omitted and truncation is explicit. They are never misclassified as an
empty summary. A genuinely successful but empty response is a distinct typed
compaction failure with bounded, content-free response diagnostics. OpenGeni
never installs a manufactured placeholder as conversation truth.

## Durable replacement

The replacement history is:

1. the newest real user messages that fit one cumulative 20,000-token budget,
   in chronological order;
2. one user-role summary item prefixed with Codex's `summary_prefix.md` text and
   marked `opengeni_context_summary: true`.

Prior summaries are not kept as user boundaries. Portable retention strips
images from retained user messages; **remote_v2** keeps `input_image` parts in
the cleartext suffix (CLI parity). Durable machine inputs participate in the
history being summarized like every other canonical model item. Assistant
messages, reasoning, tool calls, and tool results leave the active model
history but remain in inactive audit rows.

On the **portable** path, the generated replacement must estimate strictly
smaller than the active input, and its deterministic fingerprint must differ
from the latest durable replacement (an exact repeat settles as
`replacement_unchanged`). **remote_v2** follows Codex CLI: a valid opaque
compaction item is installed without those local gates; token usage is
recomputed from the opaque-aware estimate afterward.

One transaction locks workspace, session, and turn; verifies
`turnId + executionGeneration + attemptId`; supersedes every old active row;
inserts the replacement at fresh whole-number positions; updates
`last_input_tokens`; records `session.context.compacted`; and clears a manual
compaction request when applicable. A stale attempt can do none of those writes.

## Timeline UX

Compaction is maintenance of **conversation memory** (model history), not a
rewrite of the chat transcript. The React timeline projects a first-class
`context-compaction` landmark (not a foldable notice):

| Event | Landmark phase |
| --- | --- |
| `session.context.compaction.requested` (idle manual claim) | `started` until a later finish settles it |
| `session.context.compaction.started` (attempt-fenced, before provider call) | `started` — live-published so the UI can show progress |
| `session.context.compacted` | `compacted` with optional `~before → ~after` tokens |
| `session.context.compaction.skipped` | `skipped` with a short reason |

Start and finish for the same turn settle in place (one landmark). The landmark
is a turn boundary, so mid-turn auto-compact stays visible between collapsed
pre/post activity instead of vanishing inside a chevron. Copy always reminds
that chat history above is unchanged. Provider `implementation` stays in the
event payload for debug, not as hero UI text.

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

If summarization produces an authoritative terminal failure, the turn ends
with an honest `context_compaction_failed` result. OpenGeni does not continue
with silently trimmed input and does not install a mechanical fallback summary.
Retryable provider failures instead recover the same accepted turn through the
ordinary provider/capacity path; they do not create another goal continuation,
and an explicit `/compact` request remains pending for that same-turn retry.
When a terminal failure belongs to an explicit `/compact`, one attempt-fenced
database settlement records
`session.context.compaction.skipped(reason="summarization_failed")`, clears that
one request, records `turn.failed`, and returns the session to idle. For a
failure during same-turn recovery, the exact turn is settled once. Machine
inputs already visible to the model remain delivered in active history and are
never requeued; only genuinely new updates remain pending. A worker crash
therefore cannot clear the request without matching terminal truth, and an idle
maintenance execution cannot immediately recreate itself forever. With no
newer actionable work wake, the workflow ends instead of retrying against
unchanged history. A later human/API prompt, Steer, explicitly requested
Compact, or genuinely new machine input can create newer truth and make one new
attempt. The active history stays unchanged throughout.

Codex-subscription responses are streaming on the wire even for this
non-streaming summarizer. Terminal `response.failed`, `response.error`, `error`,
and `response.incomplete` events are converted to ordinary non-2xx provider
errors before the SDK sees them; a stream with no terminal event is a protocol
error. None of these shapes may collapse to `{}` or be mislabeled as a
semantically empty assistant response. Persisted diagnostics contain only
bounded status/code/request identifiers, never the provider message or model
input.

When the latest finished inference has `code="context_compaction_failed"`, an
active goal remains active and ordinary pending system/child/schedule updates
remain durable, but neither may start another inference against the unchanged
history. A queued human/API prompt or Agent Steer instruction remains runnable
and receives the pending updates at its normal boundary. Explicit `/compact`
also remains runnable; it does not consume those updates, but a successful
checkpoint supplies newer finished-turn truth so the existing pending batch can
run next. This gate neither creates queue work nor consumes a goal
continuation/no-progress counter.

Manual `/compact` sets one durable idempotent request. During active inference,
the worker observes it at the next model boundary and retries sampling in the
same logical turn after replacement. While idle, the request creates one
born-running `source="compaction"` maintenance execution on the existing turn
ledger. That execution is not conversational work and is never a prompt-queue
row; it exists to own model allocation, attempt fencing, recovery, and
settlement. Portable `/compact` still skips prepareTools/sandbox. `remote_v2`
`/compact` prepares tools and builds the agent first so the compact request
reuses the ordinary tools→instructions cache prefix, then settles without
inference.

The exact attempt that successfully installs the replacement clears the request
in the same transaction. If there is no active history, the generated
checkpoint is not strictly smaller, or it exactly repeats the latest durable
replacement, the exact attempt instead records
`session.context.compaction.skipped` with that reason and clears the request in
one transaction without changing history. A failed, paused, recovered, or
superseded attempt cannot lose the request or publish a current compaction
result; only an authoritatively recorded terminal summarization failure consumes
the request as described above.
