# Open Questions And Gaps

Snapshot date: 2026-04-16.

This file merges unresolved issues from both source skills. Surface these caveats in production recommendations.

## TypeScript Sandbox Agents

Status: implementation gap.

OpenAI's 2026-04-15 announcement says TypeScript support for the new Sandbox Agent capability is coming soon, but the JS SDK source snapshot did not contain `SandboxAgent` or `SandboxRunConfig`. Do not design a TypeScript Sandbox Agent implementation without re-checking current JS docs and source. Sources: `https://openai.com/index/the-next-evolution-of-the-agents-sdk/`, `https://github.com/openai/openai-agents-js/tree/d84b541ace6e7be63e7f7b16625526dd3201620b`.

## Sandbox Agent API Stability

Status: confirmed beta.

OpenAI platform docs and Python SDK docs label Sandbox Agents beta. Expect API or provider behavior changes, especially around capabilities, snapshots, hosted providers, Temporal sandbox integration, and memory. Sources: `https://developers.openai.com/api/docs/guides/agents/sandboxes`, `https://openai.github.io/openai-agents-python/sandbox_agents/`.

## Temporal Status Split

Status: conflicting source wording.

Temporal's blog says the OpenAI Agents SDK integration became generally available on 2026-03-23, while the Temporal SDK README labels sandbox support pre-release and samples still mention public preview. Treat core integration as GA per the blog, but re-check sandbox-specific status before production commitments. Sources: `https://temporal.io/blog/announcing-openai-agents-sdk-integration`, `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/README.md`, `https://github.com/temporalio/samples-python/tree/29fc4af7c1f350a30cd1d45b8ead4b3c9494aec4/openai_agents`.

## Cross-Layer Transactions

Status: known gap.

No researched first-party API provides one atomic transaction across SDK session items, serialized `RunState`, sandbox session state, workspace snapshots, and external artifacts. If the app needs exactly-once or recoverable multi-resource workflows, build an app-level transaction/outbox/saga around SDK calls.

## Python Performance Benchmarks

Status: measurement gap.

No source-level benchmark was found for the Python runner, item conversion,
session persistence, run-state serialization, tool scheduling, or sandbox
startup/snapshot costs. Treat performance and memory claims in
`python-sdk-internals.md` as source-based inference unless a workload has been
measured.

## Hosted Tool Internals

Status: remote platform gap.

The Python SDK shows hosted tools have already run by the time response items
are processed locally, but the SDK source does not expose hosted-tool
scheduling, isolation, retries, billing, or latency behavior. Use official
platform docs or measurement for those claims.

## Server-Managed Conversation Semantics

Status: remote platform gap.

The SDK exposes `conversation_id`, `previous_response_id`, and automatic
previous response tracking, but OpenAI API storage, retention, conflict
handling, and concurrent access semantics are server-side behavior. Re-check
current OpenAI docs before making operational guarantees.

## TypeScript Durable Adapters

Status: known gap.

The researched TypeScript SDK ships `MemorySession`, `OpenAIConversationsSession`, and `OpenAIResponsesCompactionSession`, but no first-party packaged Redis/Postgres/SQLite/DynamoDB adapter. Implement `Session` against the app datastore or adapt examples, and do not describe example stores as first-party packaged adapters unless current source exports them.

## Python Postgres Naming

Status: known gap.

Postgres support is through first-party `SQLAlchemySession`, not a separately named `PostgresSession` in the researched snapshot. Avoid telling users to import `PostgresSession` unless a newer SDK version adds it.

## RunState Compatibility And Secrets

Status: confirmed caveat.

`RunState` has a schema version and may serialize app context, approvals, tool input, agent/tool identities, tracing metadata, server continuation IDs, and sandbox state. Store SDK version/commit and app agent-definition version next to long-lived serialized states. Avoid secrets in serialized context unless encrypted and intentional. Source: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_state.py`.

## Sandbox Provider Resume Semantics

Status: confirmed caveat.

The sandbox client contract permits providers to reattach to existing backend resources or create replacements that hydrate from snapshots when original resources are unavailable. Hosted provider state and snapshot behavior can differ by backend. Test resume behavior per provider under deleted container, expired hosted session, missing snapshot, changed manifest, missing mount credentials, and provider API outage. Source: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/session/sandbox_client.py`.

## Security Boundary Claims

Status: wording risk.

Do not claim that all sandbox clients provide identical security isolation. The Python docs recommend Unix local for getting started, Docker for container isolation, and hosted providers for managed execution. Actual isolation depends on backend and deployment configuration. Sources: `https://openai.github.io/openai-agents-python/sandbox/clients/`, `https://openai.github.io/openai-agents-python/sandbox/guide/`.

## Secrets And Environment Handling

Status: implementation risk.

The manifest source includes environment fields and unresolved source commentary around secret-store ergonomics. Avoid assuming a complete secret-management story from the manifest alone. Re-check current SDK source before production credential guidance. Source: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/manifest.py`.

## Mount Persistence

Status: confirmed caveat.

Mounts are intentionally treated as ephemeral for snapshot/persistence flows. Snapshotting a workspace does not copy mounted remote storage. Persist mount definitions and credentials/secrets references separately, and treat remote object store lifecycle as outside the snapshot. Sources: `https://openai.github.io/openai-agents-python/sandbox/clients/`, `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/entries/mounts/base.py`.

## Sandbox Memory Durability

Status: confirmed caveat.

Sandbox memory is generated from workspace files and flushed during pre-stop/session close behavior. It is not a transactional memory database. For durable memory, keep `memories/` and `sessions/` on persistent mounted storage or ensure snapshots capture them. Source: `https://openai.github.io/openai-agents-python/sandbox/memory/`.

## Compaction And Audit History

Status: confirmed caveat.

Responses compaction clears and rewrites the underlying session with compacted output. Keep append-only audit/event logs separately if exact reconstruction, compliance review, or analytics matter. Sources: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/memory/openai_responses_compaction_session.py`, `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-openai/src/memory/openaiResponsesCompactionSession.ts`.

## Binary Payloads

Status: confirmed caveat.

TypeScript session persistence can inline binary data as base64 data URLs. Python JSON session stores can technically store JSON payloads that include encoded data, but the session abstraction is not a file/object store. Use object storage or OpenAI file IDs for large binaries and store references in session items or app metadata. Source: `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-core/src/runner/sessionPersistence.ts`.

## MCP Durability

Status: confirmed limitation.

Temporal's README says Temporal durability does not extend to MCP servers. If an Agents SDK workflow depends on MCP state, the MCP server must provide its own durability or recovery path. Source: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/README.md`.

## Dedicated Agents SDK Model

Status: product-currentness risk.

OpenAI's 2026-04-15 announcement mentions a dedicated Agents SDK model in GPT-5.4. Model IDs, availability, pricing, and recommended selection can change quickly, so verify current OpenAI docs before implementation or cost guidance. Source: `https://openai.com/index/the-next-evolution-of-the-agents-sdk/`.

## Source Freshness

Status: update requirement.

This research reflects docs/source checked on 2026-04-16 using the commits recorded in `sources-index.md`. Re-check official docs and SDK source before implementing against a newer SDK or making current-product claims.
