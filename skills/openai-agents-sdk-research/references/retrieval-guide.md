# Retrieval Guide

Snapshot date: 2026-04-16.

Use this guide to choose the smallest useful reference, refresh currentness, and keep answers source-backed.

## Route By Question

| Question | Read |
| --- | --- |
| Python agent loop, model calls, tools, approvals, handoffs, sessions, run state, sandbox control flow | `python-sdk-internals.md` |
| Python performance, memory, hot paths, serialization, and network boundaries | `python-sdk-internals.md` |
| Overall SDK status, Python versus TypeScript, version snapshot | `overview.md`, then `sources-index.md` |
| Sandbox Agent architecture, hosted shell distinction, clients, capabilities | `sandbox-agents-and-state.md`, then `python-sdk-internals.md` |
| Sandbox session state, snapshots, manifests, mounts, memory | `sandbox-agents-and-state.md`, then `blob-and-artifact-storage.md` |
| Temporal durable execution, workflow restrictions, sandbox clients under Temporal | `temporal-integration.md` |
| Storage adapters, Postgres support, Redis/Dapr/SQLAlchemy/SQLite | `storage-adapters-and-sessions.md`, then `python-sdk-internals.md` |
| TypeScript storage, ORM support, Postgres, Drizzle, Prisma, Kysely, Redis, DynamoDB, custom `Session` data model | `typescript-storage-and-orms.md`, then `storage-adapters-and-sessions.md` |
| Conversation continuation, sessions, `RunState`, approvals, streaming resume | `storage-adapters-and-sessions.md`, then `python-sdk-internals.md` |
| Large files, OpenAI files, sandbox artifacts, artifact indexes | `blob-and-artifact-storage.md`, then `sandbox-agents-and-state.md` |
| Currentness, trust levels, source URLs, package versions | `sources-index.md` |
| Gaps, conflicts, caveats, production risks | `open-questions.md` |

## Source Trust

Prefer official docs and source over examples. Treat official examples as implementation patterns, not proof that an adapter or API is packaged. Treat open issues and community demos as lower signal. When a claim is an inference from multiple source contracts, label it as an inference.

If the answer depends on current package versions, model availability, hosted provider behavior, TypeScript sandbox support, or Temporal GA/beta status, verify against official sources first. The merged research snapshot is dated 2026-04-16.

## Terms To Keep Distinct

- `Session`: conversation item persistence interface.
- `session_id`: stable ID for a session store; in OpenAI Conversations sessions, it may be the conversation ID.
- `conversation_id` / `conversationId`: OpenAI Conversations API server-managed state ID or app grouping value.
- `previous_response_id` / `previousResponseId`: Responses API server-managed continuation chain.
- `RunState`: serialized paused/interrupted run checkpoint.
- `SandboxSessionState`: provider/workspace sandbox resume payload.
- `snapshot`: saved sandbox workspace contents for restore.
- `manifest`: desired fresh-session sandbox workspace layout.
- `Memory` capability: sandbox file-based long-term memory, not an SDK session adapter.
- `hosted shell`: OpenAI-hosted tool/container surface, not the same thing as Python `SandboxAgent`.

## Source Search Commands

From a Python SDK checkout:

```bash
rg -n "class .*Session|SessionABC|OpenAIResponsesCompaction|RunState|SandboxRunConfig|SandboxSessionState|MemoryLayoutConfig|Snapshot" src docs
rg -n "agent_sessions|agent_messages|message_data|CREATE TABLE|RedisSession|SQLAlchemySession|DaprSession" src/agents docs/sessions
rg -n "session_state|snapshot|manifest|mount|ephemeral|workspace_root_ready|SandboxAgent|SandboxRunConfig" src/agents/sandbox docs/sandbox
```

From a TypeScript SDK checkout:

```bash
rg -n "interface Session|class .*Session|OpenAIResponsesCompaction|RunState|sessionPersistence|Uint8Array|data:" packages docs
rg -n "MemorySession|OpenAIConversationsSession|examples/memory|SandboxAgent|SandboxRunConfig" packages docs examples
rg -n "postgres|postgresql|drizzle|prisma|kysely|redis|dynamodb|sqlite|orm|sql" packages docs examples package.json README.md
```

## Answer Pattern

1. State the practical answer.
2. Name the language/version/commit if known.
3. Cite source-backed facts and label trust level when ambiguity exists.
4. Separate direct source claims from inferences.
5. State the implementation implication and what must be re-verified for current production use.

## Refresh Checklist

1. Confirm current SDK versions and commits in PyPI/npm and official repos.
2. Re-check OpenAI docs for Agents, running agents, results, approvals, sessions, hosted shell, sandboxes, and tools.
3. Re-check Temporal docs/source for `temporalio.contrib.openai_agents`.
4. Re-check source for class names, constructor options, schema fields, support matrices, and beta/GA wording.
5. Update `sources-index.md` first, then the specific reference file.
6. Move unsupported or changed claims into `open-questions.md`.
