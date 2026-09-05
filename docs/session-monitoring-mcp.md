# Compact session monitoring over MCP

`sessions_list` and `session_get` default to `detail: "compact"`. This is a
model-facing projection change only: REST session/queue reads, SDK session
objects, topology, and UI defaults keep their existing shapes. The workspace
tool gateway and Codemode invoke the same MCP handlers and receive the same
projection. Clients that need the previous MCP fields must request
`detail: "full"` explicitly.

## Discovery

An ordinary `sessions_list` row has exactly `id`, `title`, `status`, and
`updatedAt`. A non-null `parentSessionId` appears only when related-session
authorization permits it. A goal adds `{ status, summary }`; paused and completed
goals remain visible as well as active ones, so session `idle` cannot be mistaken
for goal completion. Use `session_get` for the goal's evidence or pause rationale.
A meaningful effective pause adds `pause.state`, the primary `source` when
present, and a positive `additionalBlockerCount` when there are further blockers.
An active session with no blockers has no `pause` field.

Roots with descendants needing action, paused descendants, or failed descendants
include only the positive counts in `attention`. If the bounded tree walk was
truncated, `attention.truncated: true` signals that counts are lower bounds even
when no attention was found in the visited prefix. No zero-valued child tree is
returned on an ordinary row.

The compact page has `sessions`, `total`, and `nextCursor`. A null cursor means
the traversal is complete. Send each non-null cursor unchanged with the same
filters; cursors retain the exact timestamp (including PostgreSQL microseconds),
revision, rank, snapshot, and filter binding. `orderBy: "updatedAt"` also returns
`updatedThrough`, including on empty pages. This decimal activity revision is the
next incremental scan's `updatedAfter`, not an application timestamp. Creation
order remains the default without search; query/subject default to relevance.

`detail: "full"` selects the previous bounded discovery projection: root flags,
child aggregates, queue counts, nullable fields, per-field loss booleans, and
diagnostic pagination/byte facts. It does **not** return full session
configuration or history.

Related-work evidence is optional:

- Plain compact browse does not read work claims or emit `relatedWork`.
- `includeRelatedWork: true` includes the existing bounded advisory evidence.
- Full mode defaults to evidence; `includeRelatedWork: false` disables its claim
  read on a browse request while retaining the legacy empty evidence shape.
- A nonblank `query` or exact `subject` always enables evidence, even when
  `includeRelatedWork` is false. The operator's discovery rollout switch remains
  authoritative; disabled search fails before discovery storage reads.
- Every returned evidence object preserves literal `advisoryOnly: true` and
  `noAdditionalAccess: true`. Claims are nonexclusive evidence, not locks or
  instructions. See [work discovery](work-discovery.md).

`includeLastMessage: true` adds available bounded previews and a nonzero
`queuedPromptCount`. No human/API prompt is previewed until its turn has been
claimed. Previews share a 16,384-byte UTF-8 budget, spent in database result order.
Omitted previews carry an exact message-type `session_events` drill-down with
`direction: "before"`, `limit: 1`, `mode: "monitoring"`, and
`payloadMode: "summary"`. No-preview is the default.

The final pretty-printed page is limited to 128,000 bytes. Compact responses
emit text truncation flags only for actual text loss, and `responseTruncated`
plus a reason only when rows were removed to fit that byte boundary. Ordinary
count pagination is not truncation. A byte-truncated page resumes after its last
**returned** row, never after a dropped row. An envelope too small for even one
row fails explicitly instead of emitting an unusable cursor.

## Child management

`session_get` compact includes `id`, `title`, `status`, `lastSequence`,
`updatedAt`, and queue counts when a queue snapshot is available. Meaningful
optional fields are:

- `parentSessionId` and `activeTurnId`;
- `goal`: status and summary, plus stored completion `evidence`, pause
  `rationale`, and `pausedReason` when present;
- `progress`: the latest recorded `goal.progress` note with its durable sequence
  and timestamp (not an inferred liveness signal);
- `pause`: the effective primary blocker, including its reason when authorized,
  and the count of additional blockers;
- `wait`: the declared session-level wait reason and absolute deadline;
- `stopping`: positive attempt/background-command settlement counts when present;
- `queue.stoppingPreviousAttempt: true` while the previous attempt has not
  proved quiescence. Counts are visible queued human/API turns and pending
  machine inputs, never their prompts or payloads.

The goal/progress database read selects bounded text prefixes and original
Unicode character counts, not whole goal metadata or event payloads. Compact
mode does not assemble `effectiveToolPolicy`. Title, goal, evidence, progress,
pause, and wait text are independently bounded with explicit loss flags; the
final result is capped at 64 KiB. It fails rather than silently dropping a goal
outcome or blocker at the final boundary.

`detail: "full"` returns the previous bounded configuration projection,
including `initialMessage`, instructions, metadata previews, resources, selected
tools, `effectiveToolPolicy`, Variable Set ids, and projection byte/loss facts.
It is configuration inspection, not the compact goal/progress response with
extra fields. Variable values are never returned.

A goal's `completed` status is not a terminal child result. Use `lastSequence`
with `session_wait` and `waitFor: "completion"` to join a child's completed
result. Use `session_events` for more progress or exact retained evidence.
Do not use `session_get` on your own current session to reconstruct conversation
context.

## Authority and implementation

Both detail modes use the same permission checks, live attempt validation,
tenancy/private-session filtering, Slack-private scope, and optional host
narrowing. Authorization runs before list filtering, ranking, totals, cursors,
and evidence reads. A target-only grant can see a generic ancestor blocker, but
not that ancestor's id, title, actor, or pause reason. Queue control must be
projected before either detail serializer and never reapplied raw afterward.
Policy provenance follows the same boundary: target-only reads null a non-target
`inheritedFromSessionId` in both `toolPolicy` and `effectiveToolPolicy`, so later
effective-policy assembly cannot restore the hidden identity. Policy mode, tool
sets, counts, and root-authorized lineage remain unchanged.

Canonical compact row, detail, pause, text and evidence-selection helpers live
in `packages/contracts/src/session-mcp-projections.ts`. The API's
`mcp/session-view.ts` and `mcp/server.ts` enforce final MCP byte envelopes and
preserve the legacy full serializers. `getSessionMcpMonitoringSummary` and
`listSessionDiscoverySummaries` in `packages/db/src/index.ts` own the bounded
storage reads. These helpers are presentation boundaries, never authorization.