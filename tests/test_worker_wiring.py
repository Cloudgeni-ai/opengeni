import io
from pathlib import Path

import pytest
from agents.sandbox import Manifest
from agents.sandbox.errors import (
    InvalidManifestPathError,
    WorkspaceArchiveWriteError,
    WorkspaceReadNotFoundError,
)
from agents.sandbox.snapshot import resolve_snapshot
from agents.sandbox.types import ExecResult
from cloud_agent_platform.config import Settings
from cloud_agent_platform.runtime import build_sandbox_agent
from cloud_agent_platform.sandbox.modal import (
    ModalSandboxClient,
    ModalSandboxClientOptions,
    ModalSandboxSession,
    ModalSandboxSessionState,
)
from cloud_agent_platform.temporal.contracts import WorkflowRunInput
from cloud_agent_platform.temporal.worker import create_openai_agents_plugin
from pydantic import ValidationError


def test_openai_agent_runtime_builds_sandbox_agent() -> None:
    agent = build_sandbox_agent(model="gpt-5.4-mini")

    assert agent.name == "Cloud Agent"
    assert agent.model == "gpt-5.4-mini"
    assert agent.default_manifest is not None
    assert agent.default_manifest.root == "/workspace"


def test_temporal_plugin_can_be_created_without_sandbox_backend() -> None:
    plugin = create_openai_agents_plugin(Settings(sandbox_backend="none"))

    assert plugin is not None


def test_modal_sandbox_state_round_trips() -> None:
    state = ModalSandboxSessionState(
        manifest=Manifest(root="/workspace"),
        snapshot=resolve_snapshot(None, "test-session"),
        app_name="infra-agents-test",
        sandbox_id="sb-123",
    )
    payload = state.model_dump(mode="json")

    hydrated = ModalSandboxClient("infra-agents-test").deserialize_session_state(payload)

    assert isinstance(hydrated, ModalSandboxSessionState)
    assert hydrated.sandbox_id == "sb-123"


def test_workflow_contract_is_primitive_payload() -> None:
    payload = WorkflowRunInput(
        run_id="run-1",
        prompt="Inspect the workspace",
        model="gpt-5.4-mini",
        sandbox_provider="modal",
    )

    assert payload.sandbox_provider == "modal"


class _FakeFilesystem:
    def __init__(self) -> None:
        self.read_calls: list[str] = []
        self.write_calls: list[tuple[bytes, str]] = []

    def read_bytes(self, remote_path: str) -> bytes:
        self.read_calls.append(remote_path)
        return b"hello from sandbox"

    def write_bytes(self, data: bytes, remote_path: str) -> None:
        self.write_calls.append((data, remote_path))


class _FakeSandbox:
    def __init__(self) -> None:
        self.filesystem = _FakeFilesystem()


class _ValidationTestSession(ModalSandboxSession):
    def __init__(
        self,
        state: ModalSandboxSessionState,
        *,
        exec_result: ExecResult,
    ) -> None:
        super().__init__(state, ModalSandboxClientOptions())
        self._exec_result = exec_result
        self.exec_calls: list[tuple[tuple[str, ...], bool | list[str], str | None]] = []

    async def exec(
        self,
        *command: str | Path,
        timeout: float | None = None,
        shell: bool | list[str] = True,
        user: str | None = None,
    ) -> ExecResult:
        del timeout
        self.exec_calls.append((tuple(str(part) for part in command), shell, user))
        return self._exec_result


def _modal_state() -> ModalSandboxSessionState:
    return ModalSandboxSessionState(
        manifest=Manifest(root="/workspace"),
        snapshot=resolve_snapshot(None, "test-session"),
        app_name="infra-agents-test",
        sandbox_id="sb-123",
    )


@pytest.mark.asyncio
async def test_modal_sandbox_file_io_uses_filesystem_api_under_workspace() -> None:
    session = _ValidationTestSession(
        _modal_state(),
        exec_result=ExecResult(stdout=b"", stderr=b"", exit_code=0),
    )
    fake_sandbox = _FakeSandbox()
    session._sandbox = fake_sandbox

    read_back = await session.read(Path("notes/output.txt"))
    await session.write(Path("artifacts/result.bin"), io.BytesIO(b"payload"))

    assert read_back.read() == b"hello from sandbox"
    assert len(session.exec_calls) == 2
    assert fake_sandbox.filesystem.read_calls == ["/workspace/notes/output.txt"]
    assert fake_sandbox.filesystem.write_calls == [(b"payload", "/workspace/artifacts/result.bin")]


@pytest.mark.asyncio
async def test_modal_read_rejects_paths_outside_workspace() -> None:
    session = _ValidationTestSession(
        _modal_state(),
        exec_result=ExecResult(stdout=b"", stderr=b"", exit_code=0),
    )
    fake_sandbox = _FakeSandbox()
    session._sandbox = fake_sandbox

    with pytest.raises(InvalidManifestPathError):
        await session.read(Path("/tmp/outside.txt"))

    assert session.exec_calls == []
    assert fake_sandbox.filesystem.read_calls == []


@pytest.mark.asyncio
async def test_modal_write_surfaces_validation_failures_before_filesystem_write() -> None:
    session = _ValidationTestSession(
        _modal_state(),
        exec_result=ExecResult(stdout=b"", stderr=b"permission denied", exit_code=1),
    )
    fake_sandbox = _FakeSandbox()
    session._sandbox = fake_sandbox

    with pytest.raises(WorkspaceArchiveWriteError):
        await session.write(Path("artifacts/result.bin"), io.BytesIO(b"payload"))

    assert fake_sandbox.filesystem.write_calls == []


@pytest.mark.asyncio
async def test_modal_read_surfaces_access_check_failures_before_filesystem_read() -> None:
    session = _ValidationTestSession(
        _modal_state(),
        exec_result=ExecResult(stdout=b"", stderr=b"missing", exit_code=1),
    )
    fake_sandbox = _FakeSandbox()
    session._sandbox = fake_sandbox

    with pytest.raises(WorkspaceReadNotFoundError):
        await session.read(Path("notes/output.txt"))

    assert fake_sandbox.filesystem.read_calls == []


def test_settings_expose_sandbox_provider_only_when_backend_exists() -> None:
    assert Settings().sandbox_provider == "modal"

    with pytest.raises(ValueError):
        _ = Settings(sandbox_backend="none").sandbox_provider


def test_settings_reject_temporal_dispatch_without_sandbox_backend() -> None:
    with pytest.raises(ValidationError):
        Settings(enable_temporal_dispatch=True, sandbox_backend="none")
