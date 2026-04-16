# Sandbox Agents And State

Snapshot date: 2026-04-16.

This reference merges Sandbox Agent architecture from `openai-agents-sdk-intel` and sandbox persistence/state detail from `openai-agents-sdk-storage-state`.

## Canonical Sources

Primary docs:

- OpenAI Sandbox Agents guide: `https://developers.openai.com/api/docs/guides/agents/sandboxes`
- Python Sandbox Agents docs: `https://openai.github.io/openai-agents-python/sandbox_agents/`
- Python sandbox guide: `https://openai.github.io/openai-agents-python/sandbox/guide/`
- Python sandbox clients: `https://openai.github.io/openai-agents-python/sandbox/clients/`
- Python sandbox memory: `https://openai.github.io/openai-agents-python/sandbox/memory/`
- Python tools docs, including hosted shell: `https://openai.github.io/openai-agents-python/tools/`
- Hosted shell guide: `https://developers.openai.com/api/docs/guides/tools-shell`

Primary source at Python SDK commit `4f3c8a5379c1b44527c9a0a159d20b46755f4eaf`:

- `src/agents/sandbox/sandbox_agent.py`: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/sandbox_agent.py`
- `src/agents/run_config.py`: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_config.py`
- `src/agents/sandbox/runtime_session_manager.py`: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/runtime_session_manager.py`
- `src/agents/sandbox/session/sandbox_session_state.py`: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/session/sandbox_session_state.py`
- `src/agents/sandbox/session/base_sandbox_session.py`: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/session/base_sandbox_session.py`
- `src/agents/sandbox/manifest.py`: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/manifest.py`
- `src/agents/sandbox/snapshot.py`: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/snapshot.py`

## What A Sandbox Agent Is

OpenAI platform docs call sandbox agents a beta feature that lets an agent use a filesystem and commands in a persistent workspace. Source: `https://developers.openai.com/api/docs/guides/agents/sandboxes`.

In Python, `SandboxAgent` is still an `Agent`; it keeps the normal agent surface such as instructions, tools, handoffs, MCP servers, model settings, output type, guardrails, and hooks. Sandbox runtime is supplied through `RunConfig(sandbox=SandboxRunConfig(...))`, not stored as transport on the agent. Sources: `https://openai.github.io/openai-agents-python/sandbox/guide/`, `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/sandbox_agent.py`, `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_config.py`.

Use Sandbox Agents when workspace persistence, file edits, command execution, generated artifacts, snapshots, provider choice, or resume behavior are design features. Use hosted shell when the task only needs occasional OpenAI-hosted command execution. This is an implementation inference from hosted shell docs and the sandbox guide. Sources: `https://developers.openai.com/api/docs/guides/tools-shell`, `https://openai.github.io/openai-agents-python/sandbox/guide/`.

## Runtime And State Layers

The sandbox design splits two planes:

- Control plane: agent loop, model calls, tool routing, handoffs, approvals, tracing, recovery, and run state.
- Sandbox execution plane: workspace files, commands, ports, backend isolation, helper setup, and provider session lifecycle.

SDK `Session` history does not automatically persist sandbox filesystem state. Sandbox state needs a live session, serialized `session_state`, snapshot, mount, provider persistence, or an app artifact index. Sources: `https://developers.openai.com/api/docs/guides/agents/sandboxes`, `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/runtime_session_manager.py`.

`SandboxRunConfig` fields include `client`, `options`, `session`, `session_state`, `manifest`, `snapshot`, and `concurrency_limits`. Source: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_config.py`.

Sandbox session resolution order is:

1. Reuse a live `run_config.sandbox.session`.
2. Resume sandbox state stored in `RunState`.
3. Resume explicit `run_config.sandbox.session_state`.
4. Create a fresh session from manifest/snapshot, including `agent.default_manifest` when present.

Source: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/runtime_session_manager.py`.

## Manifest, Capabilities, And Instructions

`Manifest` defines the fresh-session workspace contract: version, root, entries, environment, users, groups, and remote mount command allowlist. Entries must be relative to the workspace root and cannot escape it. Sources: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/manifest.py`, `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/entries/base.py`.

Preparation resolves a sandbox session, determines the workspace, processes capabilities, builds final instructions, binds capability tools, and runs through the normal Runner API. The documented instruction order is default/base sandbox prompt, user instructions, capability instruction fragments, remote-mount policy, and filesystem tree. Sources: `https://openai.github.io/openai-agents-python/sandbox/guide/`, `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/runtime_agent_preparation.py`.

Default capabilities are `Filesystem`, `Shell`, and `Compaction`. `Filesystem` exposes image viewing and patch application; `Shell` exposes command execution and PTY stdin where supported. Sources: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/capabilities/capabilities.py`, `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/capabilities/filesystem.py`, `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/capabilities/shell.py`.

## SandboxSessionState And Resume

`SandboxSessionState` serializes provider/session state with fields including `type`, `session_id`, `snapshot`, `manifest`, `exposed_ports`, `snapshot_fingerprint`, `snapshot_fingerprint_version`, and `workspace_root_ready`. Provider subclasses add backend-specific fields. Source: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/session/sandbox_session_state.py`.

`BaseSandboxClient` defines create, delete, resume, serialize, and deserialize operations. Resume semantics are provider-specific: a client may reattach to an existing backend or create a replacement and hydrate from snapshot if the original backend is unavailable. Source: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/session/sandbox_client.py`.

The runtime manager can serialize sandbox resume state with `backend_id`, current agent key/name, `session_state`, and `sessions_by_agent`. It validates resumed state against the configured backend and supports multiple sandbox sessions keyed by agent. Source: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/runtime_session_manager.py`.

## Snapshots, Mounts, And Memory

`SnapshotBase` supports `NoopSnapshot`, `LocalSnapshot`, and `RemoteSnapshot`. Local snapshots are tar payloads under a base path; remote snapshots delegate storage to a dependency client. Snapshots are workspace-level restore points, not item-level artifact catalogs. Source: `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/snapshot.py`.

Mounts are ephemeral for snapshot purposes. Snapshotting a workspace skips mounted remote storage rather than copying remote bucket/container data into the snapshot. Sources: `https://openai.github.io/openai-agents-python/sandbox/clients/`, `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/entries/mounts/base.py`.

Built-in remote mount types include `S3Mount`, `GCSMount`, `R2Mount`, `AzureBlobMount`, and `S3FilesMount`. Docs list mount support across Docker, Modal, Cloudflare, Blaxel, Daytona, E2B, Runloop, and Vercel, with Vercel having no hosted-specific mount strategy noted in the snapshot. Source: `https://openai.github.io/openai-agents-python/sandbox/clients/`.

Sandbox memory is file-based and separate from SDK `Session`. It uses workspace files under `sessions/` and `memories/` by default, requires `Shell` for reads, and requires `Filesystem` for live memory updates. Reuse memory by preserving the same live sandbox, resuming `session_state`, restoring a snapshot, or using mounted persistent storage. Source: `https://openai.github.io/openai-agents-python/sandbox/memory/`.

## Clients And Backends

Official docs say to start with `UnixLocalSandboxClient`, use Docker for container isolation, and consider hosted providers for managed execution. Local clients include Unix local and Docker; hosted extension clients are present for Blaxel, Cloudflare, Daytona, E2B, Modal, Runloop, and Vercel in the snapshot source. Sources: `https://openai.github.io/openai-agents-python/sandbox/clients/`, `https://github.com/openai/openai-agents-python/tree/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/extensions/sandbox`.

Do not claim all sandbox backends provide identical security isolation. The actual boundary depends on backend and deployment configuration. Treat `Permissions` as materialized file permissions, not model permissions, approval policy, or API credentials. Sources: `https://openai.github.io/openai-agents-python/sandbox/guide/`, `https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/sandbox_agent.py`.

## Production Implications

- Persist `RunState` separately from conversation session history.
- For sandbox agents, store a live session reference, serialized `SandboxSessionState`, snapshot ID/config, or provider persistence handle.
- Track SDK and provider backend versions with long-lived sandbox state.
- Use mounted persistent storage for large durable artifacts or memory files that must survive snapshot/provider cleanup.
- Test each backend under deleted containers, expired hosted sessions, missing snapshots, changed manifests, missing mount credentials, and provider outages.
