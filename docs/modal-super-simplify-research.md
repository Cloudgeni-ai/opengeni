# Modal Super-Simplify Research

## Verdict

Recommendation: **B: keep a tiny local shim around the first-party Modal implementation**

Blunt version: the current repo-local Modal client/session/workspace layer is **not justified**. It is a smaller, less capable reimplementation of the SDK's native Modal backend. The only concrete reason not to switch completely today is a **Temporal/options contract mismatch**. That mismatch is small enough that it should be solved with a compatibility shim, not with a local Modal backend.

Default target should be:

1. Delete the local `client.py` / `models.py` / `session.py` / `workspace.py` Modal implementation.
2. Use `agents.extensions.sandbox.modal.ModalSandboxClient` as the real backend.
3. Keep only a small wrapper if we want to preserve the current worker-side "default options" behavior.

## What The Current Local Modal Code Actually Adds

Current local Modal code lives in:

- `packages/cloud_agent_platform/src/cloud_agent_platform/sandbox/modal/client.py`
- `packages/cloud_agent_platform/src/cloud_agent_platform/sandbox/modal/models.py`
- `packages/cloud_agent_platform/src/cloud_agent_platform/sandbox/modal/session.py`
- `packages/cloud_agent_platform/src/cloud_agent_platform/sandbox/modal/workspace.py`

What it adds beyond the SDK:

1. **Worker-side default options injection**
   - Local client sets `supports_default_options = True` and stores `_default_options` in the client constructor.
   - Evidence: `packages/cloud_agent_platform/src/cloud_agent_platform/sandbox/modal/client.py:18,27`

2. **Repo-specific config mapping**
   - `temporal/bootstrap.py` maps `Settings.modal_app_name`, `modal_default_timeout_seconds`, `modal_idle_timeout_seconds`, and `modal_image_ref` into the local client/options.
   - Evidence: `packages/cloud_agent_platform/src/cloud_agent_platform/temporal/bootstrap.py:33-40`

3. **Filesystem API reads/writes**
   - Local `read()` and `write()` use `sandbox.filesystem.read_bytes` / `write_bytes` under the workspace root instead of shelling out to `cat`.
   - Evidence: `packages/cloud_agent_platform/src/cloud_agent_platform/sandbox/modal/workspace.py:17-45`, `tests/test_modal_sandbox_adapter.py:172-204`

4. **Tar-only workspace persistence**
   - Local persistence/hydration is just tar stream out / tar stream in.
   - Evidence: `packages/cloud_agent_platform/src/cloud_agent_platform/sandbox/modal/workspace.py:48-89`

What it does **not** add:

- It does not add PTY support.
- It does not add exposed-port support.
- It does not add richer snapshot modes.
- It does not add native Modal cloud-bucket mount support.

So the local layer is not a strategic abstraction. It is mostly a reduced subset.

## What The First-Party SDK Already Has

Installed versions in this worktree:

- `openai-agents 0.14.1`
- `temporalio 1.26.0`
- `modal 1.4.2`

The SDK already ships a first-party Modal backend in:

- `.venv/lib/python3.12/site-packages/agents/extensions/sandbox/modal/sandbox.py`
- `.venv/lib/python3.12/site-packages/agents/extensions/sandbox/modal/mounts.py`

Important capabilities already present there:

1. **Native Modal sandbox client/session/state**
   - `ModalSandboxClient`, `ModalSandboxClientOptions`, `ModalSandboxSession`, `ModalSandboxSessionState`
   - Evidence: `.venv/lib/python3.12/site-packages/agents/extensions/sandbox/modal/__init__.py:8-19`

2. **PTY support**
   - Evidence: `.venv/lib/python3.12/site-packages/agents/extensions/sandbox/modal/sandbox.py:658-740`

3. **Exposed port resolution via Modal tunnels**
   - Evidence: `.venv/lib/python3.12/site-packages/agents/extensions/sandbox/modal/sandbox.py:434-463`

4. **Multiple workspace persistence modes**
   - `tar`, `snapshot_filesystem`, `snapshot_directory`
   - Evidence: `.venv/lib/python3.12/site-packages/agents/extensions/sandbox/modal/sandbox.py:85-89,1095-1105`

5. **Modal-native cloud bucket mounts**
   - Evidence: `.venv/lib/python3.12/site-packages/agents/extensions/sandbox/modal/mounts.py:27-191`

6. **First-party Temporal integration rail**
   - Worker side registers `SandboxClientProvider(name, client)`.
   - Workflow side uses `temporal_sandbox_client(name)`.
   - Evidence:
     - `.venv/lib/python3.12/site-packages/temporalio/contrib/openai_agents/sandbox/_sandbox_client_provider.py:39-109`
     - `.venv/lib/python3.12/site-packages/temporalio/contrib/openai_agents/workflow.py:247-275`

## Current Temporal Wiring In This Repo

The repo currently expects this shape:

1. Worker bootstrap creates a named `SandboxClientProvider`.
   - `build_temporal_sandbox_client_provider()` returns `SandboxClientProvider(provider, client)`.
   - Evidence: `packages/cloud_agent_platform/src/cloud_agent_platform/temporal/bootstrap.py:25-41`

2. Workflow only passes the provider name.
   - `SandboxRunConfig(client=temporal_sandbox_client(request.sandbox_provider))`
   - No sandbox `options` are passed.
   - Evidence: `packages/cloud_agent_platform/src/cloud_agent_platform/temporal/workflows.py:20-25`

3. Dispatcher only serializes `sandbox_provider`, not provider-specific options.
   - Evidence: `packages/cloud_agent_platform/src/cloud_agent_platform/temporal/contracts.py:6-12`
   - Evidence: `packages/cloud_agent_platform/src/cloud_agent_platform/temporal/dispatcher.py:27-34`

This is the key reason a tiny shim is useful.

## Concrete Blockers To A Full Direct Swap

### Blocker 1: The current workflow does not pass `SandboxRunConfig.options`, but the first-party Modal client requires them

This is the real blocker.

Evidence chain:

1. Agents runtime requires `run_config.sandbox.options` unless the client declares `supports_default_options = True`.
   - Evidence: `.venv/lib/python3.12/site-packages/agents/sandbox/runtime_session_manager.py:367-380`

2. Local client explicitly sets `supports_default_options = True`.
   - Evidence: `packages/cloud_agent_platform/src/cloud_agent_platform/sandbox/modal/client.py:18`

3. First-party `ModalSandboxClient` does **not** declare `supports_default_options = True`.
   - Evidence: no override in `.venv/lib/python3.12/site-packages/agents/extensions/sandbox/modal/sandbox.py`

4. First-party `ModalSandboxClient.create()` explicitly rejects `options=None`.
   - Evidence: `.venv/lib/python3.12/site-packages/agents/extensions/sandbox/modal/sandbox.py:1803-1829`

5. Reproduced directly in this environment:

```text
ValueError
ModalSandboxClient.create requires options with app_name
```

Command run:

```bash
uv run python - <<'PY'
import asyncio
from agents.extensions.sandbox.modal import ModalSandboxClient

async def main():
    client = ModalSandboxClient()
    try:
        await client.create(options=None)
    except Exception as exc:
        print(type(exc).__name__)
        print(str(exc))

asyncio.run(main())
PY
```

Conclusion: a direct swap to the first-party client **without** either:

- changing the workflow contract to pass `ModalSandboxClientOptions`, or
- adding a tiny local default-options wrapper

will break sandbox creation immediately.

### Blocker 2: The repo currently configures `idle_timeout`, and the first-party Modal client does not expose that knob

Evidence:

- Local config exposes `modal_idle_timeout_seconds`.
  - `packages/cloud_agent_platform/src/cloud_agent_platform/config.py:32`
- Local session passes it to `modal.Sandbox.create(... idle_timeout=...)`.
  - `packages/cloud_agent_platform/src/cloud_agent_platform/sandbox/modal/session.py:77-86`
- Local bootstrap wires it through.
  - `packages/cloud_agent_platform/src/cloud_agent_platform/temporal/bootstrap.py:33-40`
- Grep for `idle_timeout` in the first-party Modal backend returned no matches.

This is a real capability mismatch, but it does **not** justify keeping the full local backend. The correct native-rails answer is to drop this local config knob unless it is proven necessary, or upstream support for it into the SDK if it truly matters.

## Ranked Options

### 1. Preferred: B — tiny compatibility shim over the first-party Modal client

Why this is best:

- Keeps the native first-party Modal implementation as the actual backend.
- Preserves the repo's current Temporal contract, where workflows only pass `sandbox_provider`.
- Avoids threading provider-specific options through `WorkflowRunInput`.
- Lets us delete almost all local Modal code immediately.

What the shim should do:

- Hold default `agents.extensions.sandbox.modal.ModalSandboxClientOptions`.
- Set `supports_default_options = True`.
- On `create(..., options=None)`, delegate to the first-party client with stored defaults.
- Delegate `resume`, `delete`, and `deserialize_session_state` directly.
- Optionally set `ModalImageSelector.from_tag(settings.modal_image_ref)` in bootstrap.

This should be a very small wrapper, not a reimplementation.

### 2. Acceptable but worse: A — fully direct first-party swap with no shim

This is viable only if we are willing to widen the workflow contract so sandbox options are passed explicitly.

That would require:

- changing `WorkflowRunInput`
- changing `TemporalRunDispatcher`
- changing `CloudAgentRunWorkflow`
- deciding how to serialize provider-specific options cleanly

This is more invasive than necessary for this repo.

### 3. Reject: C — keep the current local Modal adapter

This is not justified.

Why not:

- It duplicates the SDK's native Modal rail.
- It is less featureful than the SDK implementation.
- The only hard blocker found is default-options handling, which is small enough to solve with a wrapper.
- `idle_timeout` alone is not enough reason to preserve a whole custom client/session/workspace stack.

## Recommended Implementation Plan

Chosen path: **B**

1. Add a tiny local wrapper around `agents.extensions.sandbox.modal.ModalSandboxClient`.
2. Export first-party `ModalSandboxClientOptions` directly from the repo-local sandbox module.
3. In `temporal/bootstrap.py`, instantiate the wrapper with:
   - default `ModalSandboxClientOptions(app_name=settings.modal_app_name, timeout=settings.modal_default_timeout_seconds)`
   - `ModalImageSelector.from_tag(settings.modal_image_ref)` when `modal_image_ref` is set
4. Remove `modal_idle_timeout_seconds` from settings, tests, and docs unless there is a demonstrated production need.
5. Delete the repo-local Modal session/state/workspace implementation.
6. Replace adapter tests with small shim/bootstrap tests that prove:
   - default options are injected when workflow passes none
   - provider still registers under the same `"modal"` name
   - first-party option/state types round-trip correctly through the Temporal plugin

## Files That Would Need To Change

For the preferred path B:

- `packages/cloud_agent_platform/src/cloud_agent_platform/temporal/bootstrap.py`
- `packages/cloud_agent_platform/src/cloud_agent_platform/config.py`
- `packages/cloud_agent_platform/src/cloud_agent_platform/sandbox/modal/__init__.py`
- `packages/cloud_agent_platform/src/cloud_agent_platform/sandbox/__init__.py`
- `tests/test_temporal_bootstrap.py`
- `tests/test_modal_sandbox_adapter.py`
- `.env.example`
- `docs/bootstrap.md`

Files that should be deleted:

- `packages/cloud_agent_platform/src/cloud_agent_platform/sandbox/modal/client.py`
- `packages/cloud_agent_platform/src/cloud_agent_platform/sandbox/modal/models.py`
- `packages/cloud_agent_platform/src/cloud_agent_platform/sandbox/modal/session.py`
- `packages/cloud_agent_platform/src/cloud_agent_platform/sandbox/modal/workspace.py`

Files that would also change if you insist on option A instead of B:

- `packages/cloud_agent_platform/src/cloud_agent_platform/temporal/contracts.py`
- `packages/cloud_agent_platform/src/cloud_agent_platform/temporal/dispatcher.py`
- `packages/cloud_agent_platform/src/cloud_agent_platform/temporal/workflows.py`
- `tests/test_temporal_contracts.py`

## Commands Run

```bash
git -C /home/jorge/repos/Cloudgeni-ai/infra-agents worktree add -b feat/modal-super-simplify /home/jorge/repos/Cloudgeni-ai/infra-agents-modal-super-simplify main
```

```bash
sed -n '1,220p' /home/jorge/repos/Cloudgeni-ai/infra-agents-modal-super-simplify/packages/cloud_agent_platform/src/cloud_agent_platform/temporal/bootstrap.py
sed -n '1,260p' /home/jorge/repos/Cloudgeni-ai/infra-agents-modal-super-simplify/packages/cloud_agent_platform/src/cloud_agent_platform/temporal/workflows.py
sed -n '1,220p' /home/jorge/repos/Cloudgeni-ai/infra-agents-modal-super-simplify/packages/cloud_agent_platform/src/cloud_agent_platform/temporal/contracts.py
sed -n '1,220p' /home/jorge/repos/Cloudgeni-ai/infra-agents-modal-super-simplify/packages/cloud_agent_platform/src/cloud_agent_platform/temporal/dispatcher.py
```

```bash
sed -n '1,220p' /home/jorge/repos/Cloudgeni-ai/infra-agents-modal-super-simplify/packages/cloud_agent_platform/src/cloud_agent_platform/sandbox/modal/client.py
sed -n '1,260p' /home/jorge/repos/Cloudgeni-ai/infra-agents-modal-super-simplify/packages/cloud_agent_platform/src/cloud_agent_platform/sandbox/modal/session.py
sed -n '1,220p' /home/jorge/repos/Cloudgeni-ai/infra-agents-modal-super-simplify/packages/cloud_agent_platform/src/cloud_agent_platform/sandbox/modal/models.py
sed -n '1,240p' /home/jorge/repos/Cloudgeni-ai/infra-agents-modal-super-simplify/packages/cloud_agent_platform/src/cloud_agent_platform/sandbox/modal/workspace.py
sed -n '1,320p' /home/jorge/repos/Cloudgeni-ai/infra-agents-modal-super-simplify/tests/test_modal_sandbox_adapter.py
```

```bash
sed -n '1,320p' /home/jorge/repos/Cloudgeni-ai/infra-agents-modal-super-simplify/.venv/lib/python3.12/site-packages/agents/extensions/sandbox/modal/sandbox.py
sed -n '1,220p' /home/jorge/repos/Cloudgeni-ai/infra-agents-modal-super-simplify/.venv/lib/python3.12/site-packages/agents/extensions/sandbox/modal/mounts.py
sed -n '1,260p' /home/jorge/repos/Cloudgeni-ai/infra-agents-modal-super-simplify/.venv/lib/python3.12/site-packages/agents/sandbox/session/sandbox_client.py
sed -n '1,320p' /home/jorge/repos/Cloudgeni-ai/infra-agents-modal-super-simplify/.venv/lib/python3.12/site-packages/agents/sandbox/session/base_sandbox_session.py
sed -n '1,220p' /home/jorge/repos/Cloudgeni-ai/infra-agents-modal-super-simplify/.venv/lib/python3.12/site-packages/temporalio/contrib/openai_agents/sandbox/_sandbox_client_provider.py
sed -n '1,280p' /home/jorge/repos/Cloudgeni-ai/infra-agents-modal-super-simplify/.venv/lib/python3.12/site-packages/temporalio/contrib/openai_agents/sandbox/_temporal_sandbox_client.py
sed -n '240,320p' /home/jorge/repos/Cloudgeni-ai/infra-agents-modal-super-simplify/.venv/lib/python3.12/site-packages/temporalio/contrib/openai_agents/workflow.py
sed -n '340,395p' /home/jorge/repos/Cloudgeni-ai/infra-agents-modal-super-simplify/.venv/lib/python3.12/site-packages/agents/sandbox/runtime_session_manager.py
```

```bash
uv run python - <<'PY'
from importlib.metadata import version
for pkg in ['openai-agents','temporalio','modal']:
    print(pkg, version(pkg))
PY
```

```bash
uv run python - <<'PY'
import asyncio
from agents.extensions.sandbox.modal import ModalSandboxClient

async def main():
    client = ModalSandboxClient()
    try:
        await client.create(options=None)
    except Exception as exc:
        print(type(exc).__name__)
        print(str(exc))

asyncio.run(main())
PY
```

```bash
grep -n "idle_timeout" \
  /home/jorge/repos/Cloudgeni-ai/infra-agents-modal-super-simplify/.venv/lib/python3.12/site-packages/agents/extensions/sandbox/modal/sandbox.py \
  /home/jorge/repos/Cloudgeni-ai/infra-agents-modal-super-simplify/packages/cloud_agent_platform/src/cloud_agent_platform/config.py \
  /home/jorge/repos/Cloudgeni-ai/infra-agents-modal-super-simplify/packages/cloud_agent_platform/src/cloud_agent_platform/sandbox/modal/session.py \
  /home/jorge/repos/Cloudgeni-ai/infra-agents-modal-super-simplify/packages/cloud_agent_platform/src/cloud_agent_platform/sandbox/modal/models.py \
  /home/jorge/repos/Cloudgeni-ai/infra-agents-modal-super-simplify/packages/cloud_agent_platform/src/cloud_agent_platform/temporal/bootstrap.py
```
