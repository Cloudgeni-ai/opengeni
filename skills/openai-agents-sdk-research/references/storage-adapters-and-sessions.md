# Storage Adapters And Sessions

Snapshot date: 2026-04-16.

This reference merges the storage adapter, conversation state, `RunState`, approval resume, streaming, and compaction material from `openai-agents-sdk-storage-state`.

## Continuation Strategies

OpenAI running-agents docs describe four ways to continue an agent conversation:

| Strategy | Storage owner | Carry-over value |
| --- | --- | --- |
| `result.history` | App | Full local item list replayed by the app |
| `session` | App/session backend plus SDK | Stable session object or session ID/backing store |
| `conversationId` | OpenAI Conversations API | OpenAI conversation ID |
| `previousResponseId` | OpenAI Responses API | Prior response ID/server chain |

Choose one strategy per conversation history. Mixing local replay with server-managed state can duplicate context. Python session docs are stricter: a session cannot be combined with `conversation_id`, `previous_response_id`, or `auto_previous_response_id` in the same run. Sources: `https://developers.openai.com/api/docs/guides/agents/running-agents`, `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/docs/sessions/index.md`, `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/docs/src/content/docs/guides/sessions.mdx`.

## What Sessions Persist

A session stores conversation input items. The runner loads history before a run, merges it with current-turn input, invokes the model/agent loop, and persists new user input plus generated output/tool items after completion. Sources: Python `session_persistence.py` `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/session_persistence.py`, TypeScript `sessionPersistence.ts` `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-core/src/runner/sessionPersistence.ts`.

Python supports `SessionSettings(limit=N)` and `RunConfig.session_input_callback`. TypeScript supports `sessionInputCallback` for item-array inputs and preserves current-turn delta items if server-managed state is also in play. Sources: same session persistence files above.

## Python Session Contract And Adapters

Python defines `Session` / `SessionABC` with `session_id`, optional `session_settings`, `get_items(limit=None)`, `add_items(items)`, `pop_item()`, and `clear_session()`. `OpenAIResponsesCompactionAwareSession` adds `run_compaction(args)`. Source: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/memory/session.py`.

| Adapter | First-party status | Backing store | Notes |
| --- | --- | --- | --- |
| `SQLiteSession` | Core package | SQLite memory/file | Local/simple apps; JSON in `message_data`; WAL and process-local lock for file mode |
| `AsyncSQLiteSession` | Extension | SQLite via `aiosqlite` | Async SQLite variant |
| `RedisSession` | Extension extra `redis` | Redis hash/list keys | Shared low-latency memory; optional TTL |
| `SQLAlchemySession` | Extension extra `sqlalchemy` | SQLAlchemy async DB | First-party Postgres/MySQL/SQLite route via URLs such as `postgresql+asyncpg://...` |
| `DaprSession` | Extension extra `dapr` | Dapr state store | TTL, consistency, ETag conflict handling |
| `OpenAIConversationsSession` | Core package | OpenAI Conversations API | Server-managed; lazily creates or reuses conversation ID |
| `OpenAIResponsesCompactionSession` | Session decorator | Wraps another session | Calls `responses.compact`; must not wrap `OpenAIConversationsSession` |
| `AdvancedSQLiteSession` | Extension | SQLite plus metadata tables | Branching, usage analytics, structured conversation queries |
| `EncryptedSession` | Extension extra `encrypt` | Wrapper around another session | Fernet envelope per item, per-session HKDF key, TTL checked on decrypt |

Sources: Python sessions docs `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/docs/sessions/index.md`, `pyproject.toml` `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/pyproject.toml`, and source links in `sources-index.md`.

Postgres support is through `SQLAlchemySession`, not a separate `PostgresSession` class in the researched snapshot. Use SQLAlchemy migrations and async engine configuration in production; `create_tables=True` is development/test-oriented. Sources: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/extensions/memory/sqlalchemy_session.py`, `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/docs/sessions/sqlalchemy_session.md`.

## Adapter Storage Details

`SQLiteSession` stores sessions in `agent_sessions` and JSON item rows in `agent_messages.message_data`; reads return chronological order, `limit=N` retrieves latest rows and reverses to chronological order, corrupted JSON rows are skipped, `pop_item()` deletes the latest row, and `clear_session()` deletes session data. Source: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/memory/sqlite_session.py`.

`RedisSession` stores metadata at `<key_prefix>:<session_id>`, messages at `<key_prefix>:<session_id>:messages`, and a counter key; messages are JSON strings in a Redis list and optional TTL applies to all keys. Source: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/extensions/memory/redis_session.py`.

`DaprSession` stores `<session_id>:messages` and `<session_id>:metadata`, supports TTL metadata and consistency options, and uses ETags/optimistic concurrency with retries on conflicts. Source: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/extensions/memory/dapr_session.py`.

`EncryptedSession` wraps another session and stores encrypted envelope items with `__enc__`, version, key ID, and Fernet payload. Expired or invalid ciphertext is skipped on read; ciphertext can remain in the underlying store until popped or cleared. Sources: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/extensions/memory/encrypt_session.py`, `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/docs/sessions/encrypted_session.md`.

## TypeScript Session Contract And Adapters

TypeScript defines `Session` with `getSessionId()`, `getItems(limit?)`, `addItems(items)`, `popItem()`, and `clearSession()`. `OpenAIResponsesCompactionAwareSession` adds `runCompaction(args)`. Source: `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-core/src/memory/session.ts`.

| Adapter | First-party status | Backing store | Notes |
| --- | --- | --- | --- |
| `MemorySession` | Core package | Process memory | Demos/tests; not recommended for production |
| `OpenAIConversationsSession` | OpenAI package | OpenAI Conversations API | Server-managed; can lazily create or reuse a conversation |
| `OpenAIResponsesCompactionSession` | OpenAI package decorator | Wraps another `Session` | Calls `responses.compact`; must not use `OpenAIConversationsSession` underneath |
| Custom `Session` | Supported extension point | Any app store | Required for Redis/DynamoDB/SQLite/Postgres/Prisma-style durable stores in the snapshot |

Sources: TypeScript sessions docs `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/docs/src/content/docs/guides/sessions.mdx`, `MemorySession` `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-core/src/memory/memorySession.ts`, `OpenAIConversationsSession` `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-openai/src/memory/openaiConversationsSession.ts`, `OpenAIResponsesCompactionSession` `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-openai/src/memory/openaiResponsesCompactionSession.ts`.

TypeScript durable SQL/Redis/DynamoDB/Prisma-style stores are custom or examples in this snapshot, not first-party packaged adapters unless current source now exports them. Source: TypeScript sessions docs and examples index in `sources-index.md`.

## RunState And Resume

`RunState` is a serialized checkpoint for a paused or interrupted run, not just chat history. Python `RunState` includes current turn, agents, original input, generated items, model responses, session items, context, approvals, usage, metadata, serialized tool input, current step/interruption state, continuation IDs, prompt cache key, reasoning item ID policy, guardrail results, tool-use tracker snapshot, current-turn persisted item count, trace state, sandbox resume payload, and schema version. The researched Python source shows schema version `1.9`. Source: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_state.py`.

TypeScript `RunState` serializes analogous run data: current turn, agents, original input, model responses, context JSON, tool tracker, guardrail results, current step, generated items, pending agent-tool runs, persisted-item count, continuation IDs, reasoning policy, and trace state. It does not include Python sandbox state in the snapshot. Source: `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-core/src/runState.ts`.

For human-in-the-loop approval resume: pause on approval interruption, convert result to state, persist `state.to_json()` or `state.to_string()`, approve/reject on the state object, and resume the original top-level run. If using sessions, resume with the same backing store. Sources: `https://developers.openai.com/api/docs/guides/agents/guardrails-approvals`, `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/docs/human_in_the_loop.md`, `https://developers.openai.com/api/docs/guides/agents/results`.

Streaming runs use the same pause/resume model: drain the stream, inspect interruptions, serialize `RunState` for delayed work, and resume from state instead of starting a fresh turn. Session persistence tracks already persisted items to avoid duplicate history across streaming/retry/resume boundaries. Sources: `https://developers.openai.com/api/docs/guides/agents/running-agents`, `https://developers.openai.com/api/docs/guides/agents/results`, Python and TS session persistence sources above.

## Compaction

`OpenAIResponsesCompactionSession` exists in Python and TypeScript as a session decorator. It wraps an underlying session, calls `responses.compact`, defaults to compaction after at least 10 candidate non-user/non-compaction items, supports modes based on latest `previous_response_id` chain or full input items, clears the underlying session, and rewrites it with compacted output. It must not be used with `OpenAIConversationsSession`. Sources: Python `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/memory/openai_responses_compaction_session.py`, TS `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-openai/src/memory/openaiResponsesCompactionSession.ts`.

Treat compaction as a working-history rewrite. If audit logs, analytics, or compliance reconstruction matter, store append-only records separately before compaction overwrites the working session history.

## Adapter Selection Guidance

- Local Python prototype: `SQLiteSession("id", "conversations.db")`.
- Async Python app on existing Postgres: `SQLAlchemySession.from_url("id", "postgresql+asyncpg://...", create_tables=False)` with migrations.
- Python distributed low-latency chat state: `RedisSession` with explicit TTL/retention.
- Python cloud-native platform already using Dapr: `DaprSession`.
- OpenAI server-managed conversation storage: `OpenAIConversationsSession` or direct `conversationId`, but do not also replay local history.
- TypeScript durable store: implement `Session` against the app datastore and persist `AgentInputItem[]` plus metadata.
- Sensitive stored transcripts: wrap Python sessions with `EncryptedSession`, or implement encryption in custom TS/session stores.

Production inference: pair a session store with a separate store for serialized `RunState` and a separate artifact/object store for large files. The SDK session store alone is not a complete workflow database.
