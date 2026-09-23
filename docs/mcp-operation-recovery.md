# MCP operation outcome recovery

An MCP caller timeout does not prove that the provider stopped or rolled back a
mutation. OpenGeni can retain an operation locator before dispatch and recover
its eventual result through an explicitly configured, observation-only provider
tool. It never repeats the original mutation to discover its outcome.

This is an opt-in OpenGeni provider contract. Tool annotations do not enable it.
In particular, an idempotent write can still execute when the original request
never arrived; replaying that write is not an observation.

## Configuration and supported callers

Trusted server configuration maps each recoverable mutation to its observer:

```json
{
  "id": "operations",
  "url": "https://provider.example/mcp",
  "connectionRef": {
    "connectionId": "11111111-1111-4111-8111-111111111111",
    "providerDomain": "provider.example",
    "kind": "oauth2"
  },
  "operationRecovery": {
    "commit_value": { "observerTool": "observe_operation" }
  }
}
```

The normal worker binds this configuration to its exact accepted attempt and
durable operation store. Both configuration and persistence are needed to enable
capture. Configuration alone in a runtime embedding does not create persistence.

The initial implementation supports remote, brokered MCP calls in model and
Codemode execution. Inline credentials, local MCP adapters and current-human
workspace-gateway calls cannot acquire recovery authority merely from a matching
URL. Unsupported configured execution fails before its mutation when recovery
and persistence are enabled. Legacy host credentials without a durable accepted
binding cannot supply the required authority digest.

The observer must remain available in the current attempt's selected catalog.
Reads use the normal gateway and its current authorization and approval checks;
configuration does not bypass those checks.

## Provider contract

For a configured mutation, the provider receives its ordinary arguments and the
UUID `_meta.opengeniOperationId`. Before acknowledging a terminal operation, it
must durably associate that reference with the exact authenticated operation,
original tool, argument fingerprint and result. It must not infer identity from
a model-supplied `operationId` or `sourceCallId` argument.

The fingerprint is SHA-256 over OpenGeni's canonical JSON encoding of the exact
original arguments: recursively sorted object keys, preserved array order, and
ordinary JSON string encoding, encoded as UTF-8. The implementation is
`digestCanonicalJson` in `packages/tool-gateway/src/catalog.ts`.

The observer receives:

```json
{
  "version": 1,
  "operationRef": "11111111-1111-4111-8111-111111111111",
  "originalTool": "commit_value",
  "fingerprint": {
    "version": 1,
    "algorithm": "sha256",
    "value": "<64 lowercase hexadecimal characters>"
  }
}
```

It must authenticate the current caller, authorize the original operation's
scope, validate the reference/tool/fingerprint binding, and only read evidence.
It must never claim, create, restart or execute the mutation. A missing or
uncommitted receipt means `unknown`, not failure or permission to retry.

Return an MCP result whose `structuredContent` echoes `version`, `operationRef`
and `fingerprint`, with exactly one of these states:

| Status | Additional fields | Meaning |
| --- | --- | --- |
| `unknown` | None | No terminal or positive pending evidence is visible. |
| `pending` | Nonempty `evidenceRevision` | Positive evidence establishes that the operation is pending. |
| `completed` | Nonempty `receiptRevision` (at most 1,024 UTF-8 bytes), `result` | The exact retained MCP-shaped result of the original invocation. |
| `conflict` | None | The supplied identity conflicts with retained evidence. |

A committed domain failure belongs in `completed.result` with `isError: true`.
An outer MCP `isError` response, including an authentication failure, is not a
terminal operation receipt. Changed references or fingerprints are rejected.
Repeated terminal observations must agree; conflicting terminal evidence never
overwrites the first retained receipt.

## Explicit result reads

The attempt-local `operation_read` tool accepts either the returned operation
UUID or the exact original `sourceTurnId` and `sourceCallId`. The latter supports
discovery when the original response was lost. Ambiguous source matches must not
select the latest operation automatically.

The caller cannot provide a destination, observer, replacement arguments or
credential reference. Those are constrained by the immutable operation record
and trusted current configuration. Provider observation requires independently
valid current authority for the original principal and connection binding. A
historical one-use grant is not renewed by possessing an operation locator.

The actual physical observer request is also fenced against the original
authority digest, closing the race between credential lookup and provider use.
Stored result disclosure still requires current authorized session access, but
does not require another provider request.

## Persistence and restart semantics

The ledger captures identity before the physical mutation. A lost capture
acknowledgment prevents dispatch; an existing operation identity never authorizes
another mutation. A worker crash between capture and provider contact leaves an
unknown outcome, not evidence that the operation was sent or not sent.

Original invocation outcome and observed terminal result are separate. A later
receipt never rewrites the original timeout or creates a second output for the
original SDK call. Instead, the new `operation_read` invocation returns its own
ordinary tool result through the existing session-result lifecycle.

Observation claims are distinct from mutation execution. Repeated authorized
reads can recover after a process restart or lost settlement acknowledgment.
Terminal receipt settlement is idempotent; repeated explicit read calls may
legitimately return the same receipt. Unknown and pending observations do not
schedule inference, create machine-input wakes or replay a write.

SDK call IDs remain arbitrary correlation strings. Durable operation IDs remain
UUIDs; substituting SDK IDs into the UUID contract would break existing callers.

## Rollout boundaries

Apply the additive ledger migration and exact runtime-role privileges before
enabling configured producers. Publish a coherent runtime/worker/config/database
set. Upgrade all claim-capable workers before enabling recovery mappings: older
claimers may acquire membership and session locks in the opposite order from
the recovery ledger. Do not enable this feature in a mixed old/new claimer pool.
Provider support must be implemented and verified separately before enabling
its mapping; installing the OpenGeni code cannot make an unsupported provider
observation-only. Historical calls lacking a captured binding are not backfilled
by guessing their arguments, authority or operation reference.

Canonical sources: `packages/runtime/src/mcp-operation-dispatch.ts`,
`packages/runtime/src/mcp-operation-observation.ts`,
`apps/worker/src/activities/mcp-operation-reader.ts`,
`apps/worker/src/activities/mcp-operation-observer.ts`, and
`packages/db/src/mcp-operations.ts`.