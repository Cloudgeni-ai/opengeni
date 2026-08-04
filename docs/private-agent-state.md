# Private agent state and temporary capabilities

OpenGeni uses two redaction profiles because private model state and public diagnostics have different jobs.

## Decision

Private agent state preserves intentionally returned temporary capabilities such as signed object-storage URLs, upload headers, one-time download links, and opaque continuation handles. Removing those values makes otherwise valid tools impossible to use.

Exact host-known secrets are still removed by provenance before private state reaches the model or durable storage. The worker registers values it injected or resolved, then replaces those exact bytes wherever they appear.

Do not classify a value as secret at the private boundary only because its field name, header name, token shape, or URL query parameter looks credential-like.

## Profiles

| Profile | Surfaces | Behavior |
| --- | --- | --- |
| Private agent | model input, `session_history_items`, pending tool call/result receipts, resumable `agent_run_states` | Redact exact registered host-known values; preserve intentional tool-returned capabilities and structured protocol data. |
| Strict public | `session_events`, SSE/audit projections, logs, diagnostics, errors, final human-facing output | Redact exact registered values plus credential-shaped fields, headers, assignments, provider tokens, URL userinfo, and signed-query material. |

Private does not mean unbounded. Existing item normalization, tool-output truncation, protocol validation, RLS, and access controls still apply.

## Invariants

1. A successful tool result must remain executable by the same private agent turn and by a legitimate resumed turn.
2. Host-resolved variable-set values, MCP headers, provider credentials, and other registered secrets must not enter private model state verbatim, even if echoed by a tool.
3. Public/audit surfaces must not inherit the more permissive private profile.
4. A capability returned by a tool must not be copied into public logs or audit events merely because private history retains it.
5. New private-state persistence paths must use `createPrivateAgentRedactor`; public or diagnostic paths use `createSecretRedactor` or their existing strict sanitizer.

## Canonical implementation and tests

- Shared profiles: `packages/contracts/src/secret-redaction.ts`
- Worker registration and boundary selection: `apps/worker/src/activities/agent-turn.ts`
- Contract regression tests: `packages/contracts/test/secret-redaction.test.ts`
- Turn-boundary regression tests: `apps/worker/test/agent-turn.test.ts`

The private-profile tests must cover both halves of the contract: a signed upload capability survives unchanged, while an exact registered host secret embedded beside it is redacted.
