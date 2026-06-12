# Run lifecycle: turns, goals, and memory

This is the orientation for how an OpenGeni agent run actually executes over
time. It ties together three subsystems a contributor touching the session
workflow, the worker activity, or the runtime must keep straight. Code wins
over this doc; the canonical sources are `apps/worker/src/workflows/session.ts`,
`apps/worker/src/activities/agent-turn.ts`, and `packages/runtime/src/index.ts`.

## Turns

A **turn** is one unit of agent work inside a session: an input (a user message,
a goal continuation, or an approval decision) is processed until the agent
reaches a natural stopping point. One turn runs as one non-retryable Temporal
activity (`runAgentTurn`; the activity is also registered under its former name
`runAgentSegment` for in-flight workflow-history compatibility — do not schedule
the old name in new code). Inside that activity the OpenAI Agents SDK loop makes
as many model calls and tool calls as the work needs.

**Runs have no length limits, by design.** What the SDK calls "turns" are model
calls; `OPENGENI_AGENT_MAX_MODEL_CALLS_PER_TURN` exists but defaults to
effectively unbounded. There is no continuation cap and the agent activity's
Temporal timeout is measured in days, not hours. OpenGeni is built for agents
that legitimately run for a very long time, so **run length is bounded by
symptoms, never by counts**: the no-progress detector and budget exhaustion are
the real guards. Do not reintroduce count- or duration-based caps on legitimate
run length; if a run is misbehaving, detect the pathology, do not cap the clock.

Two recoverable conditions end a turn gracefully (idle the session, keep the
context) instead of failing it, so a long run survives them: hitting the
model-call cap (if one is configured) and provider rate-limit backpressure on a
goal-bearing session. A budget/credit exhaustion between model calls likewise
idles the turn rather than failing the session, so a top-up lets the same
session continue.

## Goals — what makes long runs continue

Agents stop prematurely. A **goal** flips the default so that finishing a turn
with nothing queued does not idle the session out — the workflow synthesizes a
continuation turn and the agent must explicitly `goal_complete` or `goal_pause`
to stop. This is the mechanism behind every multi-day autonomous run. Full
detail in `docs/goals.md`; the one-line model: queued user input always wins
over a continuation, and goals are bounded by progress/budget guards, not counts.

## Memory — three stores, three jobs

A session's content lives in three places. Keep them straight; reaching for the
wrong one is the classic mistake.

1. **`session_history_items` — conversation truth (the model-facing store).**
   Ordered, verbatim SDK `AgentInputItem` JSON, unredacted, RLS-scoped. This is
   what a new turn's input is built from. It is dual-written as the agent
   streams (reconciled after every model response and at every turn-end path)
   so a crash loses at most the single in-flight model call. The read path is
   selected by `OPENGENI_SESSION_HISTORY_SOURCE` (default `items`).
2. **`agent_run_states` — approval resume only.** The serialized SDK `RunState`
   blob is an opaque, SDK-version-gated process checkpoint. Its one legitimate
   job is resuming a turn that paused mid-flight for a human approval
   (`requires_action`); a half-finished tool approval cannot be represented as
   plain history items. In items mode the blob is written only for that case.
   Do not use it as conversation memory.
3. **`session_events` — the redacted human/audit timeline.** Append-only,
   per-session sequence numbers, drives replay/SSE/UI. It is **secret-redacted
   and lossy** (reasoning items and several item types are dropped), so it is
   correct for humans and auditing and must never be fed back to the model.

Sandbox recovery state is persisted separately again, in
`sandbox_session_envelopes`: the small versioned descriptor (provider handle /
snapshot reference / manifest) used to reattach, snapshot-restore, or rebuild
the session's sandbox on its next turn — decoupled from the RunState blob.

See issue #35 for the rationale and the dual-write → flagged-read → default-flip
migration history.
