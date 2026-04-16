# Overview

Snapshot date: 2026-04-16.

This reference merges the ecosystem-level summary from `openai-agents-sdk-intel` commit `b65532953589028398be3b99956281cf6761dfd2` and the storage/state summary from `openai-agents-sdk-storage-state` commit `d640b2f7e418426e8d2745230d6860b97f0be49f`.

The Python internals reference in this skill adds a source-level audit of the
Python run loop, model/provider boundary, tool execution, approvals, handoffs,
sessions, `RunState`, sandbox control flow, and performance/memory pressure
points at OpenAI Agents Python SDK commit
`4f3c8a5379c1b44527c9a0a159d20b46755f4eaf`.

## Current Ecosystem Snapshot

OpenAI's 2026-04-15 announcement frames the next Agents SDK evolution around Sandbox Agents, Temporal support, and a dedicated Agents SDK model in GPT-5.4. It says Sandbox Agents are Python-first and TypeScript support is coming soon. Source: `https://openai.com/index/the-next-evolution-of-the-agents-sdk/`.

Python is the implemented Sandbox Agents surface in this snapshot. The official Python SDK repo was checked at commit `4f3c8a5379c1b44527c9a0a159d20b46755f4eaf`; PyPI and repo metadata reported `openai-agents` version `0.14.1`. Sources: `https://github.com/openai/openai-agents-python/tree/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf`, `https://pypi.org/pypi/openai-agents/json`.

The TypeScript SDK is official for Agents SDK workflows but, at commit `d84b541ace6e7be63e7f7b16625526dd3201620b`, source audit did not find implemented `SandboxAgent` or `SandboxRunConfig` APIs. npm reported `@openai/agents` version `0.8.3`. Sources: `https://github.com/openai/openai-agents-js/tree/d84b541ace6e7be63e7f7b16625526dd3201620b`, `https://www.npmjs.com/package/@openai/agents`.

Temporal's OpenAI Agents SDK integration is official in Temporal's Python SDK. Temporal's blog says the integration became generally available on 2026-03-23, while the Temporal SDK README labels sandbox support pre-release. Sources: `https://temporal.io/blog/announcing-openai-agents-sdk-integration`, `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/README.md`.

## State Mental Model

The SDK has multiple state surfaces. They can appear in the same user workflow but have different persistence owners.

| Layer | Owns | Typical durable storage | Main SDK surface |
| --- | --- | --- | --- |
| Conversation history | Prior user input, assistant output, tool calls/results | Session backend, OpenAI Conversations API, Responses continuation, or app-managed history | `Session`, `conversationId`, `previousResponseId`, `result.history` |
| Interrupted run state | Paused execution position, approvals, generated items, tool state, trace metadata | App DB, queue, or file with serialized `RunState` | `RunState`, `result.to_state()`, state JSON/string |
| Sandbox execution state | Workspace files, commands, ports, provider session, manifest, snapshot, mounts | Live sandbox, `SandboxSessionState`, snapshots, mounted storage | Python Sandbox Agents |
| Sandbox memory | Long-term memory files generated in workspace | Live sandbox, snapshot, `session_state`, mounted storage | Python sandbox `Memory` capability |
| External artifacts/blobs | Large files, user assets, generated outputs, logs, snapshots | Object storage, OpenAI Files, provider volume, sandbox workspace | App artifact index plus SDK references |

Source basis: OpenAI running agents docs, Python and TypeScript session docs/source, Python sandbox docs/source, and storage-state source audit recorded in `sources-index.md`.
For Python SDK internals, use `python-sdk-internals.md` before broader
ecosystem summaries.

## Practical Architecture Summary

Pick one conversation continuation strategy for a given conversation history: app-managed `result.history`, SDK `session`, OpenAI Conversations API via `conversationId`, or Responses API continuation via `previousResponseId`. Mixing local replay with server-managed state can duplicate context, and Python session docs explicitly prohibit combining a session with `conversation_id`, `previous_response_id`, or `auto_previous_response_id` in the same run. Sources: `https://developers.openai.com/api/docs/guides/agents/running-agents`, `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/docs/sessions/index.md`, `https://github.com/openai/openai-agents-js/blob/d84b541ace6e7be63e7f7b16625526dd3201620b/docs/src/content/docs/guides/sessions.mdx`.

Use Python when the implementation needs Sandbox Agents now. This is a direct interpretation of the Python docs/source containing `SandboxAgent`, manifests, clients, snapshots, memory, and Temporal sandbox integration, combined with the JS source audit and OpenAI's "coming soon" TypeScript statement.

Use Temporal when a workflow must survive retries, worker restarts, long-running tool/model calls, or delayed human approvals. Temporal routes model calls, activity tools, MCP calls, and sandbox operations through workflow/activity boundaries, but workflow code must obey Temporal determinism restrictions. Sources: `https://temporal.io/blog/announcing-openai-agents-sdk-integration`, `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/README.md`.

Use separate stores for separate lifecycles: session store for conversation items, run-state store for paused/interrupted `RunState`, artifact store for large files, artifact index for lineage/retention, and snapshot/provider storage for sandbox workspaces. This is an inference from SDK contracts, not a single official reference architecture.

## Stable Conclusions

- Session rows store conversation history items, not complete workflow checkpoints.
- `RunState` is the checkpoint for approvals, interruptions, current execution position, and resume metadata.
- Sandbox state is separate from SDK session memory and includes provider session state plus optional snapshots and mounts.
- Sandbox memory is file-based workspace memory, not an SDK `Session` adapter.
- Mounts are intentionally skipped by sandbox snapshots; the remote store remains the durable owner.
- Python has broader first-party storage adapters than TypeScript in this snapshot.
- TypeScript durable SQL/Redis/Dynamo-style stores are custom implementations or examples unless current source exports new packaged adapters.
