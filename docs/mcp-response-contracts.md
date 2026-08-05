# First-party MCP response contracts

Audience: integrators and maintainers of the built-in OpenGeni MCP servers.

OpenGeni's first-party MCP mutation tools return a compact, versioned receipt
instead of returning the full entity they just created or changed. The caller
already has the mutation arguments in its tool-call history; returning prompts,
instructions, commands, evidence, secret values, or other request fields again
wastes model context and duplicates sensitive data across storage and transport
surfaces.

This contract applies to the built-in OpenGeni MCP and docs MCP. It does not
change REST response bodies. Toolspace-proxied tools retain the result contract
of their selected first-party, capability, or per-session provider.

## Mutation receipt v1

The public schema is `McpMutationReceipt` in
`packages/contracts/src/mcp-receipts.ts`. API handlers construct receipts through
`mcpMutationReceipt` in `apps/api/src/mcp/receipts.ts`, which parses the strict
schema before serializing the result. An accidental full-entity or request-field
addition therefore fails closed rather than silently making the result
unbounded.

```json
{
  "receiptVersion": "mcp-mutation-receipt.v1",
  "operation": "session_create",
  "committed": true,
  "outcome": "created",
  "changed": true,
  "resource": {
    "type": "session",
    "id": "11111111-1111-4111-8111-111111111111",
    "version": 1,
    "state": "queued"
  },
  "timestamp": "2026-07-20T00:00:00.000Z",
  "idempotency": { "status": "applied" },
  "warnings": [],
  "id": "11111111-1111-4111-8111-111111111111",
  "rootSessionId": "11111111-1111-4111-8111-111111111111",
  "nestedAgentDepth": 0,
  "effectiveMaxNestedAgentDepth": 3,
  "nextAction": {
    "tool": "session_get",
    "arguments": {
      "sessionId": "11111111-1111-4111-8111-111111111111"
    }
  }
}
```

### Fields and semantics

| Field | Meaning |
| --- | --- |
| `receiptVersion` | Literal `mcp-mutation-receipt.v1`; use this discriminator before reading the rest of the shape. |
| `operation` | The exact MCP mutation tool that produced the receipt. |
| `committed` | Whether the mutation truth described by the receipt committed. A returned `partial_failure` is necessarily committed; validation, authorization, conflict, and fully compensated failures are MCP errors instead of `committed:false` receipts. |
| `outcome` | One of `created`, `updated`, `deleted`, `unchanged`, `accepted`, `triggered`, `repaired`, `replayed`, or `partial_failure`. |
| `changed` | Whether this invocation applied a new authoritative change. `repaired` always carries `true`; `unchanged` and `replayed` always carry `false`. |
| `resource` | Primary server-generated identity: `type`, `id`, and, when authoritative for that resource, `version`, `etag`, and current `state`. |
| `relatedResources` | At most eight additional generated resource identities needed to interpret the mutation. |
| `timestamp` | Authoritative resource/update time when available, otherwise receipt creation time. It is an offset-aware ISO-8601 timestamp. |
| `idempotency.status` | `not_supported`, `not_requested`, `applied`, `replayed`, or `unknown`. `replayed` is emitted only when the authoritative persistence path says the existing operation was replayed. |
| `partialFailure` | Present only for `partial_failure`; names the failed stage and whether retry is safe. |
| `warnings` | Bounded operational warnings, never request or entity bodies. |
| `facts` | At most 16 bounded scalar operation facts. Nested entities and arbitrary JSON are forbidden. |
| `id`, `rootSessionId`, `nestedAgentDepth`, `effectiveMaxNestedAgentDepth` | Required only for `session_create`. These bounded top-level compatibility aliases preserve the generated session identity and immutable descendant-policy lineage without returning the full session. `id` is validated to equal `resource.id`. |
| `updateId` | Required only for `session_steer`; a bounded compatibility alias validated to equal `resource.id`. |
| `nextAction` | A safe explicit read/follow-up tool plus at most eight bounded scalar arguments. |

The schema is intentionally strict and intrinsically bounded: resource strings,
warnings, scalar facts, related resources, and next-action arguments all have
individual UTF-8 byte/count limits. The complete pretty-printed JSON receipt is
also validated against the canonical 64 KiB model-facing envelope, including
JSON escape expansion.

### Replay, no-op, and partial-failure truth

- **Replay is authoritative.** A retry is `outcome:"replayed"`,
  `changed:false`, and `idempotency.status:"replayed"` only when the underlying
  idempotency store reports a replay. In particular, `session_create`, Send, and
  session control do not infer replay merely from a repeated-looking request.
- **Repair is a change.** A keyed `session_create` that finds a session row but
  installs missing initial events, turn, or runnable state, or commits a new
  workflow-wake revision for queued work, is
  `outcome:"repaired"`, `changed:true`, and `idempotency.status:"applied"`.
  Only a fully initialized retry that issues no new wake is a pure replay.
- **No-op is not replay.** An already-paused task, a deduplicated memory write,
  or another mutation that commits no new state can return `unchanged` with the
  applicable non-replay idempotency status.
- **Partial failure means partial commit.** The receipt says which stage failed,
  whether a retry is safe, and what resource identity remains authoritative. A
  scheduled-task database change followed by failed schedule synchronization is
  a partial failure only when compensation failed and the database mutation
  remains committed. If compensation restores the prior persistence state, the
  operation throws an MCP error instead.
- **Session usage-recording failure is returned, not thrown.** Session creation
  and workflow wake have already committed at that point. A keyless receipt is
  `partialFailure.retryable:false` and says not to retry; a keyed receipt is
  retryable only with the same idempotency key. A failed usage-recording attempt
  on a pure keyed retry retains `idempotency.status:"replayed"` and
  `changed:false` while reporting `outcome:"partial_failure"`.
- **Noncommit failures remain errors.** Authorization, input validation,
  missing resources, conflicts, and failures before commit preserve their
  existing MCP error behavior. They do not return a success-shaped receipt.

## Response classification and complete tool matrix

The following is the complete built-in registration inventory. Availability is
still permission-, deployment-, session-, and Toolspace-mode-dependent.

| Server / tools | Class | Response contract |
| --- | --- | --- |
| First-party: `set_session_title` | Mutation | v1 receipt |
| First-party: `scheduled_tasks_create`, `scheduled_tasks_update`, `scheduled_tasks_pause`, `scheduled_tasks_resume`, `scheduled_tasks_trigger`, `scheduled_tasks_delete` | Mutation | v1 receipt |
| First-party: `goal_set`, `goal_update`, `goal_complete`, `goal_pause` | Mutation | v1 receipt |
| First-party: `memory_save`, `memory_correct` | Mutation | v1 receipt |
| First-party: `rig_propose_change`, `rig_verify`, `rig_promote` | Mutation | v1 receipt |
| First-party: `session_create`, `session_send_message`, `session_pause`, `session_resume`, `session_steer`, `set_other_session_title` | Mutation | v1 receipt |
| First-party: `variable_set_set_variable`, deprecated `environment_set_variable` | Mutation | v1 receipt; secret values are never returned |
| Docs: `memory_propose` | Mutation | v1 receipt |
| First-party: `files_get_download_url` | Read | Bounded access URL/result required to perform the read; not a redundant entity echo |
| First-party: `github_repositories_list` | List | Existing bounded list/read result |
| First-party: `social_connections_list`, `social_posts_recent` | List | Existing bounded list result |
| First-party: `social_daily_analysis_context` | Read | Existing bounded analysis input projection |
| First-party: `scheduled_tasks_list` | List | Compact, offset-paginated list result; scheduled-task entity bodies are not returned |
| First-party: `scheduled_task_runs_list` | List | Existing caller-limited run list; not a redundant mutation echo |
| First-party: `scheduled_tasks_get` | Read | Compact summary by default; optional explicitly bounded entity projection |
| First-party: `memory_search` | List/read | Existing bounded search result |
| First-party: `sandboxes_list` | List | Existing fleet projection |
| First-party: `rig_list`, `sessions_list`, `variable_set_list`, deprecated `environment_list` | List | Existing compact list projections; variable values are never returned |
| First-party: `rig_get`, `session_get` | Read | Existing exact-ID, bounded detail projections |
| First-party: `session_events` | List/read | Existing paginated and byte-bounded monitoring result |
| Docs: `list_document_bases` | List | Existing document-base list result |
| Docs: `search_documents`, `knowledge_search`, `memory_search` | List/read | Existing bounded retrieval result |
| Docs: `fetch_document_chunk`, `knowledge_fetch` | Read | Explicit chunk read result |
| First-party: `sandbox_attach`, `sandbox_swap` | Action output | The returned routing target and epoch are the essential result of the action, not an echo of the request |
| First-party: `run_on` | Action output | Essential remote stdout/read/write result |
| First-party: `sandbox_provision` | Action output | Essential provisioning or human enrollment result |
| First-party: `github_connect_link` | Action output | Essential short-lived browser/configuration result |
| First-party: `github_token` | Action output | Essential short-lived credential result; callers must handle it as a secret |
| Toolspace-proxied tools (dynamic selected tool names) | Provider/selected-tool output | Preserve the selected first-party or upstream provider result; proxy/raw-transfer adaptation is outside this receipt contract |

Reads, lists, and action outputs are not converted into receipts: their result
contains information the caller did not already provide. This work removes
redundant mutation echo; it is not a blanket instruction to replace useful tool
output with acknowledgements.

## Scheduled-task reads

`scheduled_tasks_list` defaults to 25 rows and accepts `limit` up to 50 plus a
numeric `offset` up to 10,000. It fetches only the requested page plus one row
for `hasMore`, and returns compact summaries. Prompts, goal text, resources,
tools, and metadata values are represented by byte/count facts rather than
serialized in every list row. The complete pretty-printed model result has an
exact 64 KiB cap; when byte pressure drops rows from the pagination edge,
`projection.rowsDroppedForBytes`, `page.hasMore`, and `page.nextOffset` preserve
truthful forward progress.

`scheduled_tasks_get` returns the same summary by default. Passing
`includeEntity:true` explicitly requests a bounded detail projection:

- prompt preview: at most 8 KiB UTF-8;
- goal text and success criteria: at most 2 KiB UTF-8 each;
- resource identities, tool identities, agent metadata keys, and task metadata
  keys: at most 20 each;
- metadata values: never included;
- exact original/delivered byte or count facts and truncation flags; and
- a complete pretty-printed response no larger than 64 KiB.

The full scheduled-task REST detail contract remains available to authorized
non-model clients and is unchanged.

## Compatibility and migration

This is an intentional breaking change for MCP consumers that assumed a
mutation returned a full entity. Small server-authored facts used by existing
session orchestration remain available as bounded compatibility aliases:

- `session_create` preserves `id`, `rootSessionId`, `nestedAgentDepth`, and
  `effectiveMaxNestedAgentDepth` at the top level;
- `session_steer` preserves top-level `updateId`.

The versioned compatibility path is:

1. Detect `receiptVersion === "mcp-mutation-receipt.v1"`.
2. Prefer the primary generated identity at `receipt.resource.id`. For
   `session_create`, the bounded top-level `id` alias remains equal to it for
   existing orchestration consumers.
3. Inspect `committed`, `outcome`, `changed`, and `idempotency.status` instead of
   inferring success or replay from an entity body.
4. When entity details are actually needed, call `receipt.nextAction.tool` or
   the corresponding explicit bounded get/read tool.
5. Do not expect request fields to be copied into the result; retain them from
   the original tool call if the client needs them.

For example, a legacy `session_create` result copied the caller's message and
instructions into a full session:

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "initialMessage": "<32 KiB already present in the tool call>",
  "instructions": "<32 KiB already present in the tool call>",
  "status": "queued",
  "queueVersion": 1,
  "createdAt": "2026-07-20T00:00:00.000Z"
}
```

The new result is the receipt shown at the top of this page. The bounded
top-level lineage aliases are sufficient to spawn descendants under the same
depth policy. Call `session_get({sessionId: receipt.resource.id})` when any other
current session projection is needed.

The REST API is unchanged. The React timeline's worker-reference projection is
a tolerant reader: it recognizes v1 `resource.type:"session"` receipts and the
legacy full-session top-level `id` during migration.

## Measured byte and context reduction

The deterministic regression fixture uses production-style pretty-printed JSON
and UTF-8 byte measurement. Approximate tokens are `ceil(bytes / 4)`; they are a
coarse comparison, not provider billing truth. Pathological inputs cover two
32 KiB multibyte session fields, large scheduled prompt/resources/tools/metadata,
large goal fields, the maximum accepted 4,000-byte memory text, and the maximum
8,192-byte rig command plus 2,000-byte note.

| Mutation | Request bytes | Duplicated input bytes | Legacy response bytes | Receipt bytes | Approx. legacy tokens | Approx. receipt tokens | Reduction |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `session_create` | 65,610 | 65,536 | 65,998 | 636 | 16,500 | 159 | 99.04% |
| `scheduled_tasks_create` | 113,758 | 111,596 | 114,123 | 544 | 28,531 | 136 | 99.52% |
| `goal_complete` | 98,357 | 98,304 | 131,380 | 535 | 32,845 | 134 | 99.59% |
| `memory_save` | 4,059 | 4,000 | 4,423 | 553 | 1,106 | 139 | 87.50% |
| `rig_propose_change` | 10,276 | 10,192 | 10,587 | 748 | 2,647 | 187 | 92.93% |

The same smaller serialized mutation result is reused by more than the immediate
MCP response. It reduces subsequent model tool history, the persisted
tool-result/event representation, and NATS/SSE/realtime projections:

| Surface | Legacy bytes | Receipt bytes | Reduction |
| --- | ---: | ---: | ---: |
| Model history | 66,021 | 613 | 99.07% |
| Event | 66,134 | 816 | 98.77% |
| Realtime | 66,031 | 623 | 99.06% |

Canonical measurement: `apps/api/test/mcp-receipt-size.test.ts`.

## Boundaries and residual compatibility risk

- **Universal output-safety boundary:** receipts are intrinsically bounded and the maximum
  contract-shaped receipt is tested below 64 KiB. Universal output
  normalization/truncation across arbitrary provider and tool output remains
  a separate safety layer; compact receipts do not replace it.
- **Connector/raw-transfer boundary:** this contract does not change
  `apps/api/src/mcp/toolspace.ts`, runtime connector proxy adaptation,
  worker/storage attachment transfer, provider wrappers, or raw-byte paths.
  Those selected/upstream results remain provider-owned.
- **Compatibility risk:** public MCP behavior is intentionally breaking for
  third-party clients that parse full mutation entities. Consumers must migrate
  to `receipt.resource.id` plus explicit reads. REST behavior is unchanged.
