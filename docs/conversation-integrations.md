# Conversation integration kernel

OpenGeni's provider-neutral conversation integration boundary lives in
`packages/core/src/domain/conversation-integrations.ts`. It defines the
normalized facts and delivery semantics that future Slack, Teams, Discord, or
similar adapters can share without treating any provider's wire format as the
domain model.

This is an inert foundation. It does not migrate the existing Slack
implementation, add provider I/O, define persistence, or change the session,
turn, API, worker, OAuth, or UI lifecycle.

## Identities and inbound envelopes

Every provider-owned identifier is an explicit `{ provider, kind, value }`
triple. `provider` is a canonical namespace, `kind` identifies the opaque value
as an installation, actor, conversation, thread, event, message, attachment, or
receipt, and `value` remains opaque. Adapters must not compare bare provider
values across kinds or namespaces.

The kernel derives versioned SHA-256 identities with length-framed inputs:

- event identity binds provider + exact installation + provider event;
- actor identity binds provider + exact installation + provider actor;
- route identity binds provider + exact installation + conversation + optional
  thread;
- delivery operation identity binds provider + exact installation + the
  caller's durable logical operation key.

An adapter must compose a provider event value that is unique within the exact
installation when its upstream event identifier has a narrower scope. A
duplicate delivery of that same value then converges to the same canonical
event identity.

`ConversationInboundEnvelope` carries the installation, normalized actor and
route, provider event and message identities, canonical occurrence timestamp,
one normalized signal, exact accepted text, and attachment references. Signals
are `start`, `continue`, or a typed `control` (`stop` or `resume`).

Text is validated as well-formed Unicode, NUL-free, and at most 32 KiB of UTF-8.
Its accepted bytes are otherwise preserved: the kernel does not trim, redact,
classify, or rewrite credential-shaped content.

Attachments are a closed, metadata-only shape: a namespaced opaque attachment
pointer plus optional leaf filename, media type, byte size, and SHA-256 digest.
Raw bytes, credentials, object-store keys, signed URLs, private provider URLs,
and provider-specific fields are not part of the contract. Absolute URLs are
also rejected as opaque attachment pointers.

This inbound conversation metadata is distinct from the tool-time connector
attachment transfer contract. An authorized connection-backed MCP tool may
later materialize exact bytes through the private versioned envelope documented
in [`mcp-response-contracts.md`](mcp-response-contracts.md), but adapters must
not promote a conversation attachment reference itself into download authority.

## Outbound delivery

`ConversationDeliveryCommand` has three operations: `post`, `update`, and
`delete`. Before the first provider call, a future adapter must choose and
durably retain one logical operation key. Reconstructing a command with the same
installation and key produces the same operation identity across retries and
process restarts.

The command also carries a canonical request digest over the operation kind,
installation, route, target message, and exact text. A durable delivery ledger
must compare both the operation identity and request digest. Reusing one logical
key for different request content is a conflict, not a retry.

`ConversationProviderReceipt` binds a successful provider observation back to
the exact operation identity and request digest. It retains namespaced provider
message and optional receipt identifiers without interpreting them.

Delivery outcomes intentionally distinguish whether replay is safe:

| Outcome | Required next action |
| --- | --- |
| `not_started` | Retry the same operation identity. |
| `retryable_failure` | Retry the same operation identity only when the adapter knows the mutation did not commit or the provider guarantees equivalent idempotency. |
| `unknown` | Reconcile the same operation first; never blindly replay it. |
| `permanent_failure` | Stop; do not retry. |
| `success` | Complete with the bound provider receipt. |

`conversationDeliveryNextAction` and
`assertConversationDeliveryMayRetry` make this decision executable. In
particular, an ambiguous timeout, interrupted connection, or incomplete
provider response after a request may have started is `unknown`, not
`retryable_failure`.

## Adapter obligations

A provider adapter built on this kernel remains responsible for:

1. authenticating the delivery and resolving the exact installation before
   normalization;
2. enforcing tenant, provider permission, and provider-specific routing rules;
3. mapping provider events to normalized signals without changing accepted user
   text;
4. keeping provider credentials, fetch URLs, and raw attachment content outside
   the normalized envelope;
5. choosing durable logical operation keys, recording the provider-call start
   boundary outside this pure contract, and reconciling `unknown` outcomes;
6. translating normalized intent into OpenGeni's existing authoritative
   session/turn lifecycle rather than creating a parallel one.

The exported normalizers and assertions reject non-plain objects, unknown
fields, malformed identifiers, mismatched namespaces/installations, forged
derived identities, non-canonical timestamps, and exceeded bounds. Canonical
JSON helpers emit properties in a fixed order and validate the complete value
before projection, providing deterministic wire bytes for tests, hashing, or a
future persistence boundary.

## Non-goals

The kernel deliberately does not define provider clients, webhook handlers,
OAuth installations, database tables, retry schedulers, session ownership,
policy, or provider capability discovery. Those boundaries require concrete
authority and lifecycle decisions and must not be inferred from this contract.
