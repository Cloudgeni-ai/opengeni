# Structured human input

OpenGeni has a built-in `request_human_input` agent tool for questions that need
an answer before the current turn can continue. A single request can contain up
to 20 text, single-select, or multi-select questions. Select questions can
optionally accept an `Other` value; requests can optionally allow Skip and can
carry a durable expiry deadline.

This is not tool approval. Approval asks whether an already-proposed tool may
run and can approve or reject it. Structured human input is itself a tool call:
OpenGeni always authorizes that built-in call, freezes the SDK `RunState`, and
later injects one of these structured outcomes into that exact call:

- `answered`, with validated question answers;
- `skipped`, only when the request allows it;
- `expired`, when its durable deadline wins the settlement race; or
- `cancelled`, when the owning turn is permanently replaced or terminated.

The agent sees that outcome as ordinary tool output and decides how to proceed.
No outcome creates a synthetic `user.message`, no response starts a new logical
turn, and a host must not translate Skip or expiry into approval rejection.

## Durable lifecycle

One `request_human_input` interruption maps to one row in
`session_human_input_requests`. Its deterministic request id is derived from the
session, turn, and SDK tool-call id, so the same logical interruption retains
its identity when a recovery advances the execution generation. The row stores
the validated question contract, carries the current generation as its mutable
settlement fence, and has a strong foreign key to the attempt that first
created it. That creation attempt is immutable provenance; a recovery attempt
does not replace it.

The worker atomically writes the serialized `agent_run_states` checkpoint, all
new human-input rows, the requested events, and the session's
`requires_action` status. A crash therefore cannot expose a request without its
resumable SDK state, or a resumable state without its request. On recovery,
OpenGeni loads the response selected by the triggering
`user.humanInputResponse` event and injects it directly into the matching tool
call. It does not rediscover the response through a best-effort event or tool
call lookup during execution.

Settlement is first-writer-wins under a database lock and compare-and-set:

- a human answer and the expiry timer cannot both win;
- one requires-action boundary admits only one resume event, even when a model
  proposed parallel structured-input and ordinary approval calls. Remaining
  interruptions can settle after the first response is claimed and re-frozen;
- a response is accepted only for the current execution generation;
- a recovery may advance that generation but cannot change the persisted
  questions, Skip policy, or deadline for the same stable tool call;
- a client event id makes response retries idempotent;
- Steer, cancellation, supersession, terminal failure, and completion close
  any still-pending request as `cancelled`;
- Pause preserves an unexecuted request, just as it preserves an ordinary
  pending approval. Resume admits that same frozen turn;
- expiry is enforced by a replay-safe Temporal timer and remains correct across
  worker restart or `continueAsNew`. A stale early timer caused by bounded
  workflow/database clock skew re-arms with an interruptible floor instead of
  spinning the workflow and database;

`session_events` remains the redacted audit/live projection. The request table
is the authoritative actionable read model; event delivery merely tells a
client to reconcile it. Neither store is model conversation history.

## Agent tool contract

The public schemas are in `@opengeni/contracts` and mirrored by
`@opengeni/sdk`:

```ts
type RequestHumanInputToolInput = {
  questions: Array<{
    id: string;
    kind: "text" | "single_select" | "multi_select";
    prompt: string;
    label?: string | null;
    helpText?: string | null;
    options: Array<{ id: string; label: string; description?: string | null }>;
    required: boolean;
    allowOther: boolean;
    validation?: {
      minLength?: number | null;
      maxLength?: number | null;
      minSelections?: number | null;
      maxSelections?: number | null;
    } | null;
  }>;
  allowSkip: boolean;
  expiresInSeconds?: number | null;
};
```

The API validates the response again against the persisted questions. It
rejects unknown or duplicate question/option ids, missing required answers,
invalid `Other` use, the wrong cardinality, and length/selection-bound
violations. User-controlled regular expressions are intentionally not part of
the contract.

## API and permissions

Pending or historical requests are readable with `sessions:read`:

- `GET /v1/workspaces/:workspaceId/sessions/:sessionId/human-input-requests`
  (optional `status` query)
- `GET /v1/workspaces/:workspaceId/sessions/:sessionId/human-input-requests/:requestId`

A response uses the ordinary controlled event endpoint and therefore requires
`sessions:control`:

```json
{
  "type": "user.humanInputResponse",
  "clientEventId": "host-generated-idempotency-key",
  "payload": {
    "requestId": "request-uuid",
    "response": {
      "outcome": "answered",
      "answers": [{ "questionId": "region", "values": ["eu"] }]
    }
  }
}
```

The SDK exposes `listHumanInputRequests`, `getHumanInputRequest`, and
`submitHumanInputResponse`. A stale, settled, or wrong-generation response is a
`409`; a malformed answer is a `422`; an unknown request is a `404`.

## React and embedded hosts

`@opengeni/react` exposes two layers:

- `useHumanInputRequests(sessionId)` is the headless lifecycle primitive. It
  reads the authoritative pending set, reconciles after relevant session
  events, can share a host's existing event feed, and guards duplicate submits.
- `HumanInputForm` is the optional accessible default renderer. It supports all
  question kinds, `Other`, validation, Skip, deadline presentation, and host
  overrides for title, description, labels, and styling.

The stock OpenGeni session route mounts both. An embedded product may mount the
same component, compose its own renderer over the hook, or use the SDK through
its backend proxy. It should not maintain an independent request state machine:
access control stays at the host/OpenGeni API boundary, while the OpenGeni row,
turn checkpoint, workflow timer, and response event remain the durable truth.

## Acceptance boundary

Structured input counts as supported only when the contracts, persisted owner,
atomic runtime checkpoint, API authorization, SDK, embed UI, restart/expiry
behavior, and real-database tests all remain present. A form mock or a model
prompt that merely describes a question is not equivalent support.
