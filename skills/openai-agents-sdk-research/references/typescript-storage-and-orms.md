# TypeScript Storage And ORMs

Snapshot date: 2026-04-16.

This reference is focused on the TypeScript OpenAI Agents SDK conversation
history, `Session` storage contract, first-party adapters, and ORM/database
extension story.

Current source snapshot:

- TypeScript SDK repo HEAD: `d84b541ace6e7be63e7f7b16625526dd3201620b`.
- npm package: `@openai/agents@0.8.3`.
- Python comparison snapshot: `openai-agents-python` HEAD
  `4f3c8a5379c1b44527c9a0a159d20b46755f4eaf`, PyPI `openai-agents@0.14.1`.

Primary sources:

- TypeScript repo: `https://github.com/openai/openai-agents-js/tree/d84b541ace6e7be63e7f7b16625526dd3201620b`
- npm package: `https://www.npmjs.com/package/@openai/agents`
- Sessions docs source: `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/docs/src/content/docs/guides/sessions.mdx`
- Running agents docs source: `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/docs/src/content/docs/guides/running-agents.mdx`

## Bottom Line

The TypeScript SDK stores client-side conversation history as arrays of
`AgentInputItem` objects. A `Session` is only an async persistence interface for
those items. It is not a full workflow checkpoint, not an ORM abstraction, and
not a database migration system.

First-party TypeScript storage shipped in this snapshot:

| Surface | First-party status | Durable? | Notes |
| --- | --- | --- | --- |
| `MemorySession` | Packaged in `@openai/agents-core` and re-exported by `@openai/agents` | No | Process memory for demos/tests. Source: `packages/agents-core/src/memory/memorySession.ts`. |
| `OpenAIConversationsSession` | Packaged in `@openai/agents-openai` and re-exported by `@openai/agents` | OpenAI-managed | Uses the OpenAI Conversations API as the backing store. Source: `packages/agents-openai/src/memory/openaiConversationsSession.ts`. |
| `OpenAIResponsesCompactionSession` | Packaged decorator in `@openai/agents-openai` | Depends on underlying `Session` | Wraps a `Session`, calls `responses.compact`, clears and rewrites underlying history. It must not wrap `OpenAIConversationsSession`. Source: `packages/agents-openai/src/memory/openaiResponsesCompactionSession.ts`. |
| Custom `Session` | Intended extension point | Depends on implementation | Required for app-owned Postgres, Drizzle, Kysely, Prisma, Redis, DynamoDB, SQLite, raw SQL, or encrypted stores. Source: `packages/agents-core/src/memory/session.ts`. |

Exact answer on ORM/database support in TypeScript:

- Postgres: no first-party packaged TypeScript Postgres adapter in this
  snapshot. Use a custom `Session` against Postgres if the app owns transcript
  storage.
- Drizzle: no first-party Drizzle adapter or official Drizzle example found in
  source/docs.
- Kysely: no first-party Kysely adapter or official Kysely example found in
  source/docs.
- Raw SQL: no packaged raw SQL adapter. The intended pattern is a custom
  `Session`; the Prisma/file examples show the data shape.
- Prisma: first-party example only, under `examples/memory/`; it is not exported
  as a package adapter. Its schema uses Prisma with `provider = "sqlite"` by
  default.
- Redis and DynamoDB: docs name them as possible custom-session backends, but
  no packaged TypeScript Redis/DynamoDB adapter or first-party example was found
  in this source snapshot.

## Conversation History Representation

The public continuation type is `AgentInputItem[]`. Source:
`https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-core/src/types/aliases.ts`.

`AgentInputItem` is a union of protocol model items: user, assistant, system,
hosted tool calls, function calls/results, computer/shell/apply-patch calls and
results, reasoning items, compaction items, and unknown items. This means a
session should store full structured model items, not only chat messages.

The runner normalizes a string input into one user message item and leaves item
arrays as arrays. Source:
`https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-core/src/runner/items.ts`.

Generated model/tool/handoff output is represented during a run as `RunItem`
objects. Each `RunItem` wraps a protocol `rawItem` and often the current agent.
`result.history` and `RunState.history` convert the original input plus
generated `RunItem`s back to `AgentInputItem[]` with `getTurnInput()`. Sources:

- `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-core/src/items.ts`
- `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-core/src/result.ts`
- `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-core/src/runState.ts`

When persisting to a session, the runner saves current-turn input plus model
output items. It excludes approval placeholder items, can omit reasoning item
IDs when configured, strips transient IDs from function/tool-search items, and
serializes binary values to data URLs. Source:
`https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-core/src/runner/sessionPersistence.ts`.

Implementation implication: a durable store should preserve the full JSON item
payload. Flattening to `{role, text}` loses tool calls, tool outputs, reasoning
items, hosted tool state, compaction items, and future protocol variants.

## The `Session` Interface

The TypeScript `Session` interface requires exactly five async methods:

```ts
interface Session {
  getSessionId(): Promise<string>;
  getItems(limit?: number): Promise<AgentInputItem[]>;
  addItems(items: AgentInputItem[]): Promise<void>;
  popItem(): Promise<AgentInputItem | undefined>;
  clearSession(): Promise<void>;
}
```

Source:
`https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-core/src/memory/session.ts`.

Contract details confirmed from source:

- `getItems(limit)` should return the latest `limit` items in chronological
  order.
- `addItems()` appends items to the existing history.
- `popItem()` removes and returns the latest item.
- `clearSession()` removes all items for the session and resets state.
- `getSessionId()` returns or creates the stable store identifier.

Optional compaction extension:

```ts
interface OpenAIResponsesCompactionAwareSession extends Session {
  runCompaction(args?: OpenAIResponsesCompactionArgs):
    | Promise<OpenAIResponsesCompactionResult | null>
    | OpenAIResponsesCompactionResult
    | null;
}
```

The runner invokes `runCompaction()` after a completed turn is persisted when
the session implements that method. Source:
`https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-core/src/runner/sessionPersistence.ts`.

There is no TypeScript equivalent of Python `SessionSettings` in the interface
in this snapshot.

## How The Runner Uses A Session

Docs say that when a session is present, the runner fetches stored conversation
items before each run, persists new user input and assistant output after the
run, and keeps the session usable when resuming from interrupted `RunState`.
Source:
`https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/docs/src/content/docs/guides/sessions.mdx`.

Source-confirmed lifecycle:

1. Before a new run, `prepareInputItemsWithSession()` calls `session.getItems()`
   and converts the current turn input to `AgentInputItem[]`.
2. Without `sessionInputCallback`, it concatenates history and new input for
   client-managed sessions.
3. With `conversationId` or `previousResponseId`, prior turns are recovered by
   OpenAI server state; local session handling focuses on the current-turn
   delta.
4. After non-streaming completion, `saveToSession()` writes current-turn input
   plus output items in one `session.addItems()` call for client-managed
   history.
5. For streaming, the SDK can persist input first and append outputs once the
   turn completes.
6. The state tracks `_currentTurnPersistedItemCount` to avoid duplicate writes
   across resume/retry/streaming boundaries.

Sources:

- `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-core/src/run.ts`
- `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-core/src/runner/sessionPersistence.ts`

Docs/source caveat: the sessions docs say `sessionInputCallback` only runs when
turn input is already an item array. The source at this commit calls the
callback whenever one is provided, after converting string input to
`AgentInputItem[]`. Treat source as authoritative for implementation behavior
and re-check this if upgrading the SDK.

## First-Party TypeScript Examples

Official examples under the TypeScript repo are examples, not packaged
adapters:

| Example | Source | What it demonstrates | Status |
| --- | --- | --- | --- |
| Custom in-memory session | `examples/docs/sessions/customSession.ts` | Minimal `Session` implementation with cloned `AgentInputItem[]` | Docs example only. |
| File-backed session | `examples/memory/sessions/file.ts` | JSON file per session, append/read/pop/clear | Example only, not production-safe for concurrency. |
| Prisma-backed session | `examples/memory/sessions/prisma.ts` and `examples/memory/prisma/schema.prisma` | `Session` plus `SessionItem` rows with monotonically increasing `position` and JSON item payload | Example only. Schema defaults to SQLite. |
| AI SDK UI session map | `examples/ai-sdk-ui/src/app/lib/session.ts` | Demo map from app session ID to OpenAI `conversationId` | Not a `Session` backend; explicitly demo in-memory state. |

Source URLs:

- `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/examples/docs/sessions/customSession.ts`
- `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/examples/memory/sessions/file.ts`
- `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/examples/memory/sessions/prisma.ts`
- `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/examples/memory/prisma/schema.prisma`
- `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/examples/ai-sdk-ui/src/app/lib/session.ts`

The Prisma example validates stored JSON with `protocol.ModelItem.safeParse()`
before returning it as `AgentInputItem`. That is a useful production pattern:
validate on read or write, skip/quarantine invalid rows, and keep the raw JSON
for forward compatibility.

## Community Pattern Status

The official TypeScript repo does not maintain a catalog of community session
stores in this snapshot. Random community repos or packages should not be used
as evidence of first-party support.

The pattern confirmed by first-party docs/examples is portable across Drizzle,
Kysely, Prisma, raw SQL, Postgres, Redis, DynamoDB, and similar stores:
implement `Session`, store full `AgentInputItem` JSON in chronological order,
and keep `RunState` persistence separate.

## Expected Data Model For Production

There is no official TypeScript SQL schema. The extension point is to implement
`Session` yourself. A conservative relational shape derived from the interface
and Prisma example is:

```sql
create table agent_sessions (
  id text primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sdk_package text,
  sdk_version text,
  metadata jsonb not null default '{}'
);

create table agent_session_items (
  id bigserial primary key,
  session_id text not null references agent_sessions(id) on delete cascade,
  position bigint not null,
  item jsonb not null,
  created_at timestamptz not null default now(),
  unique (session_id, position)
);

create index agent_session_items_session_position_idx
  on agent_session_items (session_id, position);
```

Method mapping:

- `getSessionId()`: create or verify `agent_sessions.id`; return it.
- `getItems()`: select by `session_id`, order by `position asc`.
- `getItems(limit)`: select latest `limit` rows by `position desc`, then reverse
  to chronological order.
- `addItems(items)`: in one transaction, lock or otherwise serialize writes for
  the session, read the current max `position`, insert each item with increasing
  positions, and update `agent_sessions.updated_at`.
- `popItem()`: in one transaction, select the highest `position`, delete it,
  and return its JSON as `AgentInputItem`.
- `clearSession()`: delete rows for the session, or delete the session row with
  cascade if that matches app semantics.

Minimal TypeScript shape:

```ts
import type { AgentInputItem, Session } from '@openai/agents';

export class DbSession implements Session {
  constructor(
    private readonly db: AppDb,
    private readonly id: string,
  ) {}

  async getSessionId() {
    await this.db.ensureSession(this.id);
    return this.id;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const sessionId = await this.getSessionId();
    const rows = await this.db.listSessionItems(sessionId, { limit });
    return rows.map((row) => validateAgentInputItem(row.item));
  }

  async addItems(items: AgentInputItem[]) {
    if (!items.length) return;
    const sessionId = await this.getSessionId();
    await this.db.transaction(async (tx) => {
      await tx.appendSessionItems(sessionId, items);
    });
  }

  async popItem() {
    const sessionId = await this.getSessionId();
    return this.db.popLatestSessionItem(sessionId);
  }

  async clearSession() {
    await this.db.clearSessionItems(this.id);
  }
}
```

`AppDb`, locking, and JSON validation are app-owned. In Drizzle, Kysely, Prisma,
or raw SQL, the same contract applies: append full `AgentInputItem` JSON in a
stable order and return chronological `AgentInputItem[]`.

## Persisting Resume-Friendly State

A session store is not enough for production resume. `RunState` serializes the
paused/interrupted run, including current turn, current agent, original input,
model responses, context usage/approvals/tool input, tool-use tracker,
guardrail results, current step, generated items, pending nested agent-tool run
states, current-turn persisted count, server conversation IDs, reasoning policy,
and trace state. Source:
`https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-core/src/runState.ts`.

Production pattern:

| Store | Contains | Owner |
| --- | --- | --- |
| Session store | Chronological `AgentInputItem` history for model context | Custom `Session`, `MemorySession`, or OpenAI Conversations API |
| Run state store | `RunState.toString()` / `RunState.toJSON()` for paused approvals, interruptions, retries, nested agent-tool resumes | App database |
| Conversation metadata | Active agent name/version, user/workspace IDs, retention policy, current `conversationId` or `previousResponseId` if using server-managed state | App database |
| Artifact/blob store | Large files, images, audio, generated artifacts | Object store or OpenAI Files, with references in items/metadata |
| Audit/event log | Append-only user turns, tool calls, approvals, compaction events | App database/log pipeline |

Use one conversation continuation strategy per transcript:

- App-managed `result.history`.
- SDK `session`.
- OpenAI `conversationId`.
- OpenAI `previousResponseId`.

The TypeScript docs warn that mixing client-managed history with
server-managed state can duplicate context. `conversationId` and
`previousResponseId` are mutually exclusive. Source:
`https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/docs/src/content/docs/guides/running-agents.mdx`.

## Python Differences

Python has broader first-party durable session adapters in this snapshot:

| Python adapter | First-party status | TypeScript equivalent |
| --- | --- | --- |
| `SQLiteSession` | Core package | No packaged TS equivalent; use custom `Session` or example patterns. |
| `AsyncSQLiteSession` | Extension | No packaged TS equivalent. |
| `SQLAlchemySession` | Extension extra; can target Postgres/MySQL/SQLite via SQLAlchemy URLs | No packaged TS Postgres/ORM equivalent. |
| `RedisSession` | Extension extra | No packaged TS Redis equivalent. |
| `DaprSession` | Extension extra | No packaged TS Dapr equivalent. |
| `EncryptedSession` | Extension wrapper | No packaged TS equivalent; implement encryption in custom store. |
| `AdvancedSQLiteSession` | Extension | No packaged TS equivalent. |
| `OpenAIConversationsSession` | Core package | TS has `OpenAIConversationsSession`. |
| `OpenAIResponsesCompactionSession` | Session decorator | TS has `OpenAIResponsesCompactionSession`. |

Python source pointers:

- Python session protocol: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/memory/session.py`
- Python SQLite: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/memory/sqlite_session.py`
- Python SQLAlchemy: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/extensions/memory/sqlalchemy_session.py`
- Python Redis: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/extensions/memory/redis_session.py`
- Python Dapr: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/extensions/memory/dapr_session.py`

Postgres on Python is first-party but indirect through `SQLAlchemySession`, not
a separate `PostgresSession` class in this snapshot. Postgres on TypeScript is
absent as a packaged first-party adapter.

## Confirmed Versus Inferred

Confirmed from TypeScript source/docs:

- Conversation history is carried as `AgentInputItem[]`.
- `Session` requires only five async methods.
- `MemorySession`, `OpenAIConversationsSession`, and
  `OpenAIResponsesCompactionSession` are first-party TypeScript exports.
- The TypeScript docs explicitly tell users to implement `Session` for custom
  storage such as Redis, DynamoDB, SQLite, or another datastore.
- First-party source includes file-backed and Prisma-backed example sessions.
- No first-party TypeScript Postgres, Drizzle, Kysely, Redis, DynamoDB, or raw
  SQL adapter is exported in this snapshot.

Inferred production guidance:

- Use a relational item table with `(session_id, position, item_json)` for
  app-owned durable transcript storage.
- Persist serialized `RunState` separately from session items.
- Keep append-only audit logs separate from compacted working history.
- Store large binary/file payloads outside session rows when practical; the SDK
  can inline binary values as data URLs, but a session is not an object store.
- Add SDK package/version and app agent-definition version markers next to
  long-lived `RunState` and session data to make migrations safer.

Open caveat: community packages or private app patterns may exist outside the
official repo. This reference only treats official OpenAI docs/source as
authoritative for support status.
