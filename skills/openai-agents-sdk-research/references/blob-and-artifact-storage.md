# Blob And Artifact Storage

Snapshot date: 2026-04-16.

This reference merges the artifact/blob storage guidance from `openai-agents-sdk-storage-state` with sandbox workspace state from `openai-agents-sdk-intel`.

## Sessions Are Not General Blob Stores

Agents SDK session abstractions primarily persist conversation items. Python SQLite and SQLAlchemy store serialized item JSON in `message_data`; Redis stores serialized JSON strings in a Redis list; Dapr stores JSON arrays of serialized item strings; OpenAI Conversations-backed sessions store through the Conversations API. Sources: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/memory/sqlite_session.py`, `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/extensions/memory/sqlalchemy_session.py`, `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/extensions/memory/redis_session.py`, `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/extensions/memory/dapr_session.py`.

Large assets should be referenced by file ID, URL, object-storage key, sandbox workspace path, snapshot ID, or provider volume ID rather than embedded blindly into every session row. This is an inference from the session adapter contracts and storage schemas.

## TypeScript Binary Normalization

TypeScript session persistence normalizes binary item data before session writes: `Uint8Array` data becomes `data:<mediaType>;base64,...`, and transient call IDs are stripped for relevant protocol items. There is no generic first-party TypeScript blob adapter behind `Session` in the researched snapshot. Source: `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-core/src/runner/sessionPersistence.ts`.

## OpenAI Conversations Sessions And Files

TypeScript `OpenAIConversationsSession` maps API conversation content to agent input items including `input_text`, `input_image` by URL or file ID, and `input_file` by file data, file URL, or file ID. Python `OpenAIConversationsSession` delegates item storage to the Conversations API. For binary/file payloads, use API-supported file ID/URL/data forms rather than assuming a local SDK session database manages file bytes. Sources: `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-openai/src/memory/openaiConversationsSession.ts`, `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/memory/openai_conversations_session.py`.

## Sandbox Workspace Artifacts

Sandbox-generated files live in the sandbox workspace and persist according to sandbox lifecycle:

- Same live sandbox session: files remain while the session/workspace is alive.
- Serialized `session_state`: can reconnect or resume provider state where supported.
- Snapshot: saves/restores workspace contents, excluding skip paths and ephemeral entries/mounts.
- Mounted storage: remote data remains in the mounted store and is skipped by snapshots.

Sources: OpenAI sandbox guide `https://developers.openai.com/api/docs/guides/agents/sandboxes`, base sandbox session source `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/session/base_sandbox_session.py`.

The SDK does not automatically index every generated workspace file into a session database. Durable artifact retrieval needs app metadata such as workspace path, snapshot ID, mounted bucket/container/key, provider session or volume ID, MIME type, size, hash, creating run ID, retention policy, and access policy.

## Snapshots As Artifact Persistence

Snapshots persist workspace contents as a restorable unit. `LocalSnapshot` stores tar files on local disk, `RemoteSnapshot` delegates to an app/provider-supplied remote blob abstraction, and provider-specific clients may use native snapshot identifiers or tar fallback. Source: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/snapshot.py`.

Caveats:

- Snapshots are workspace-level restore points, not artifact catalogs.
- Mounted remote storage is skipped.
- Snapshot retention and cleanup are app/provider policy concerns.
- Default local snapshots have SDK-managed cleanup for stale default local snapshot files, but production retention should be explicit.

## Mounts As Durable Artifact Storage

Remote mounts are the cleanest SDK-native pattern for large durable sandbox data: store datasets, generated outputs, or memory files in S3/GCS/R2/Azure/etc., mount them into the workspace, and let snapshots skip the mount so snapshot payloads stay bounded. Source: `https://openai.github.io/openai-agents-python/sandbox/clients/`.

Tradeoff: restoring a snapshot without the same mount will not restore mounted remote data. Persist mount identity, bucket/container names, prefixes, credentials/secrets references, and lifecycle policy outside the snapshot.

## Sandbox Memory Files

Sandbox memory is file-based. Default files include `sessions/<rollout-id>.jsonl`, `memories/MEMORY.md`, `memories/memory_summary.md`, `memories/raw_memories.md`, `memories/phase_two_selection.json`, `memories/raw_memories/<rollout-id>.md`, `memories/rollout_summaries/<rollout-id>_<slug>.md`, and `memories/skills/`. Source: `https://openai.github.io/openai-agents-python/sandbox/memory/`.

These files are workspace artifacts. Persist them through live session reuse, snapshot, `session_state`, or mounted persistent storage.

## Recommended Production Pattern

Use separate stores for separate lifecycle needs:

- Session store: conversation items and limited metadata.
- Run-state store: serialized paused/interrupted `RunState`.
- Artifact store: object storage, OpenAI Files, mounted buckets, or provider volumes.
- Artifact index: app database table linking run/session/conversation IDs to file IDs, object keys, workspace paths, hashes, retention, and access policy.
- Snapshot store: workspace restore points with explicit retention policy.

Do not rely on a session adapter alone for durable files, large binary payloads, auditable artifact lineage, or exactly-once cross-resource semantics.
