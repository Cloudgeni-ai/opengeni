# Sources Index

Snapshot date: 2026-04-16.

This merged skill consolidates:

- `openai-agents-sdk-intel` from `/home/jorge/repos/Cloudgeni-ai/infra-agents-openai-agents-sdk-sandbox-research`, commit `b65532953589028398be3b99956281cf6761dfd2`.
- `openai-agents-sdk-storage-state` from `/home/jorge/repos/Cloudgeni-ai/infra-agents-openai-agents-sdk-storage-state-research`, commit `d640b2f7e418426e8d2745230d6860b97f0be49f`.
- A local `python-sdk-internals.md` reference present during integration, retained because it is commit-pinned to the same OpenAI Python SDK source snapshot and covers non-duplicative run-loop internals.

## Trust Levels

Primary: official docs, official SDK source, package registries, release tags.

Secondary: official blogs, official examples, merged PRs, commits, release notes.

Tertiary: open issues, community demos, stale examples, and local negative source audits. Use only when labeled and avoid treating them as final product truth.

Inference: architecture recommendations derived from multiple source contracts rather than a single official reference architecture.

## OpenAI Platform Docs

- Agents guide: `https://developers.openai.com/api/docs/guides/agents`
  - Trust: primary official docs.
  - Use for product framing, primitives, and Agents SDK positioning.
- Agents SDK guide: `https://developers.openai.com/api/docs/guides/agents-sdk/`
  - Trust: primary official docs.
  - Use for platform-level SDK framing; use SDK docs/source for implementation detail.
- Running agents guide: `https://developers.openai.com/api/docs/guides/agents/running-agents`
  - Trust: primary official docs.
  - Use for continuation strategies, warnings against duplicate context, and streaming resume.
- Results guide: `https://developers.openai.com/api/docs/guides/agents/results`
  - Trust: primary official docs.
  - Use for final result, handoff boundary, interruptions, and saved state.
- Guardrails and approvals guide: `https://developers.openai.com/api/docs/guides/agents/guardrails-approvals`
  - Trust: primary official docs.
  - Use for approval lifecycle, serializing state, and delayed resume.
- Sandbox Agents guide: `https://developers.openai.com/api/docs/guides/agents/sandboxes`
  - Trust: primary official docs.
  - Use for beta status, Python-only/currently Python-first guidance, sandbox concepts, manifests, mounts, snapshots, and memory.
- Hosted shell guide: `https://developers.openai.com/api/docs/guides/tools-shell`
  - Trust: primary official docs.
  - Use for hosted shell tool and distinction from Sandbox Agents.
- Skills guide: `https://developers.openai.com/api/docs/guides/tools-skills`
  - Trust: primary official docs.
  - Use for hosted shell skills context, not as a substitute for Sandbox Agent capabilities.

## OpenAI Python SDK

Official repo snapshot:

- URL: `https://github.com/openai/openai-agents-python/tree/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf`
- Trust: primary source code.
- Snapshot HEAD: `4f3c8a5379c1b44527c9a0a159d20b46755f4eaf`
- Version observed: `0.14.1` in repo and PyPI API.
- PyPI API: `https://pypi.org/pypi/openai-agents/json`

Official docs:

- Docs home: `https://openai.github.io/openai-agents-python/`
- Sandbox Agents: `https://openai.github.io/openai-agents-python/sandbox_agents/`
- Sandbox guide: `https://openai.github.io/openai-agents-python/sandbox/guide/`
- Sandbox clients: `https://openai.github.io/openai-agents-python/sandbox/clients/`
- Sandbox memory: `https://openai.github.io/openai-agents-python/sandbox/memory/`
- Tools: `https://openai.github.io/openai-agents-python/tools/`

Important source paths:

- Sessions docs: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/docs/sessions/index.md`
- Session protocol: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/memory/session.py`
- SQLite session: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/memory/sqlite_session.py`
- Async SQLite session: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/extensions/memory/async_sqlite_session.py`
- SQLAlchemy session: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/extensions/memory/sqlalchemy_session.py`
- SQLAlchemy docs: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/docs/sessions/sqlalchemy_session.md`
- Redis session: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/extensions/memory/redis_session.py`
- Dapr session: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/extensions/memory/dapr_session.py`
- Encrypted session: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/extensions/memory/encrypt_session.py`
- Advanced SQLite session: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/extensions/memory/advanced_sqlite_session.py`
- OpenAI Conversations session: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/memory/openai_conversations_session.py`
- OpenAI Responses compaction session: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/memory/openai_responses_compaction_session.py`
- Session persistence internals: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/session_persistence.py`
- Runner and top-level loop: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run.py`
- Single-turn and streaming loop internals: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/run_loop.py`
- Turn resolution and tool/handoff side effects: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/turn_resolution.py`
- Tool planning: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/tool_planning.py`
- Tool execution and approvals: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/tool_execution.py`
- Run state: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_state.py`
- Result surfaces: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/result.py`
- Run item representations: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/items.py`
- Model interface: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/models/interface.py`
- OpenAI Responses model adapter: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/models/openai_responses.py`
- OpenAI Chat Completions model adapter: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/models/openai_chatcompletions.py`
- `RunState`: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_state.py`
- HITL docs: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/docs/human_in_the_loop.md`
- `SandboxAgent`: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/sandbox_agent.py`
- `SandboxRunConfig`: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_config.py`
- `SandboxSessionState`: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/session/sandbox_session_state.py`
- Sandbox client contract: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/session/sandbox_client.py`
- Sandbox runtime manager: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/runtime_session_manager.py`
- Base sandbox session: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/session/base_sandbox_session.py`
- Manifest: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/manifest.py`
- Mount base: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/entries/mounts/base.py`
- Snapshot: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/snapshot.py`
- Sandbox memory source tree: `https://github.com/openai/openai-agents-python/tree/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/memory`

Release and provenance:

- Python release `v0.14.0`: `https://github.com/openai/openai-agents-python/releases/tag/v0.14.0`
- Sandbox Agents PR: `https://github.com/openai/openai-agents-python/pull/2889`
- Sandbox Agents merge commit: `https://github.com/openai/openai-agents-python/commit/2d665c9a67fdf3198a0daa0f9978b8239d78e78b`
- Lazy instruction skills issue, lower signal: `https://github.com/openai/openai-agents-python/issues/2906`

## OpenAI TypeScript SDK

Official repo snapshot:

- URL: `https://github.com/openai/openai-agents-js/tree/d84b541ace6e7be63e7f7b16625526dd3201620b`
- Trust: primary source code.
- Snapshot HEAD: `d84b541ace6e7be63e7f7b16625526dd3201620b`
- Version observed: `0.8.3` across package manifests and npm registry.
- npm package: `https://www.npmjs.com/package/@openai/agents`

Official docs:

- Docs home: `https://openai.github.io/openai-agents-js/`
- TypeScript sessions docs: `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/docs/src/content/docs/guides/sessions.mdx`

Important source paths:

- Session interface: `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-core/src/memory/session.ts`
- `MemorySession`: `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-core/src/memory/memorySession.ts`
- OpenAI Conversations session: `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-openai/src/memory/openaiConversationsSession.ts`
- OpenAI Responses compaction: `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-openai/src/memory/openaiResponsesCompactionSession.ts`
- Session persistence: `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-core/src/runner/sessionPersistence.ts`
- `RunState`: `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/packages/agents-core/src/runState.ts`
- Examples: `https://github.com/openai/openai-agents-js/tree/d84b541ace6e7be63e7f7b16625526dd3201620b/examples`

Source audit note:

- Trust: tertiary negative source audit.
- Audit: `rg "SandboxAgent|SandboxRunConfig|temporal_sandbox" /tmp/openai-agents-research-js` returned no Sandbox Agent API matches at commit `d84b541ace6e7be63e7f7b16625526dd3201620b`.
- Use only alongside the stronger official announcement that TypeScript support was coming soon.

## OpenAI Announcements

- 2026-04-15 announcement: `https://openai.com/index/the-next-evolution-of-the-agents-sdk/`
  - Trust: secondary official announcement.
  - Use for new capability framing, Python-first Sandbox Agents, Temporal support, and TypeScript support coming soon.
- 2025-03-11 agents launch: `https://openai.com/index/new-tools-for-building-agents/`
  - Trust: secondary official announcement.
  - Use for historical Responses API, Agents SDK, tools, and tracing context.

## Temporal Sources

Official status and source:

- Temporal blog: `https://temporal.io/blog/announcing-openai-agents-sdk-integration`
- Temporal change-log: `https://temporal.io/change-log/openai-agents-sdk-integration`
- Temporal Python SDK snapshot: `https://github.com/temporalio/sdk-python/tree/447472e51f8c39c3a4e5cee08c524d72d09a774c`
- Snapshot HEAD: `447472e51f8c39c3a4e5cee08c524d72d09a774c`
- Tag observed: `1.26.0`
- PyPI API: `https://pypi.org/pypi/temporalio/json`
- Temporal OpenAI Agents README: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/README.md`

Temporal source paths:

- `_temporal_openai_agents.py`: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/_temporal_openai_agents.py`
- `_openai_runner.py`: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/_openai_runner.py`
- `_invoke_model_activity.py`: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/_invoke_model_activity.py`
- `workflow.py`: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/workflow.py`
- `sandbox/_temporal_sandbox_client.py`: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/sandbox/_temporal_sandbox_client.py`
- `sandbox/_temporal_sandbox_session.py`: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/sandbox/_temporal_sandbox_session.py`
- `sandbox/_sandbox_client_provider.py`: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/sandbox/_sandbox_client_provider.py`

Examples and PR context:

- Temporal samples: `https://github.com/temporalio/samples-python/tree/29fc4af7c1f350a30cd1d45b8ead4b3c9494aec4/openai_agents`
- Samples HEAD: `29fc4af7c1f350a30cd1d45b8ead4b3c9494aec4`
- Sandbox support PR: `https://github.com/temporalio/sdk-python/pull/1452`
- Tool registry PR: `https://github.com/temporalio/sdk-python/pull/1435`

## Community Sources

- Temporal community demos: `https://github.com/temporal-community/openai-agents-demos/tree/ee5f871b48cb26ec28239ef7a4719ab10c4903e8`
- Trust: tertiary community examples.
- Use only for ideas, not product status or API authority.

## Local Research Provenance

The OpenAI docs MCP server was registered during the sandbox/Temporal research with `codex mcp add openaiDeveloperDocs --url https://developers.openai.com/mcp`, but MCP tools were not exposed in that already-running session. Official web/docs/source fallback was used.

The storage/state research relied on official docs/source snapshots, package metadata, and local source audits recorded above. It did not use third-party sources as primary support for adapter claims.

## Explicit Inference Labels

These are derived from source/docs rather than a single official architecture recommendation:

- Use separate stores for session history, serialized `RunState`, sandbox snapshots, and artifact indexes in production.
- Implement an app-level transaction/outbox/saga if exactly-once semantics are required across session DB writes, serialized run state, sandbox state, and object storage.
- Treat compaction as a working-history rewrite and keep audit logs separately.
- Store SDK/provider version markers next to long-lived serialized state.
