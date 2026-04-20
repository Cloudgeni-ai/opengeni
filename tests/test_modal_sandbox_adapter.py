import io
from pathlib import Path
from typing import Any

import pytest
from agents.sandbox import Manifest
from agents.sandbox.errors import (
    InvalidManifestPathError,
    WorkspaceArchiveWriteError,
    WorkspaceReadNotFoundError,
)
from agents.sandbox.snapshot import resolve_snapshot
from agents.sandbox.types import ExecResult, User
from cloud_agent_platform.sandbox.modal import (
    ModalSandboxClient,
    ModalSandboxClientOptions,
    ModalSandboxSession,
    ModalSandboxSessionState,
)
from modal.exception import SandboxFilesystemNotFoundError, SandboxFilesystemPermissionError


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


class _FakeFilesystem:
    def __init__(
        self,
        *,
        read_error: BaseException | None = None,
        write_error: BaseException | None = None,
    ) -> None:
        self.read_calls: list[str] = []
        self.write_calls: list[tuple[bytes, str]] = []
        self._read_error = read_error
        self._write_error = write_error

    def read_bytes(self, remote_path: str) -> bytes:
        self.read_calls.append(remote_path)
        if self._read_error is not None:
            raise self._read_error
        return b"hello from sandbox"

    def write_bytes(self, data: bytes, remote_path: str) -> None:
        self.write_calls.append((data, remote_path))
        if self._write_error is not None:
            raise self._write_error


class _FakeStreamWriter:
    def __init__(self) -> None:
        self.chunks: list[bytes] = []
        self.eof = False

    def write(self, data: bytes) -> None:
        self.chunks.append(data)

    def drain(self) -> None:
        return

    def write_eof(self) -> None:
        self.eof = True


class _FakeStreamReader:
    def __init__(self, payload: bytes = b"") -> None:
        self.payload = payload

    def read(self) -> bytes:
        return self.payload


class _FakeTarProcess:
    def __init__(self, stderr: bytes = b"", exit_code: int = 0) -> None:
        self.stdin = _FakeStreamWriter()
        self.stderr = _FakeStreamReader(stderr)
        self.stdout = _FakeStreamReader()
        self._exit_code = exit_code

    def wait(self) -> int:
        return self._exit_code


class _FakeSandbox:
    def __init__(
        self,
        *,
        process: "_FakeTarProcess | None" = None,
        read_error: BaseException | None = None,
        write_error: BaseException | None = None,
    ) -> None:
        self.filesystem = _FakeFilesystem(read_error=read_error, write_error=write_error)
        self.process = process or _FakeTarProcess()
        self.exec_calls: list[tuple[tuple[str, ...], str | None, bool]] = []

    def exec(
        self,
        *command: str,
        workdir: str | None = None,
        text: bool = True,
        timeout: int | None = None,
    ) -> "_FakeTarProcess":
        del timeout
        self.exec_calls.append((command, workdir, text))
        return self.process


class _StubModalSandboxSession(ModalSandboxSession):
    def __init__(
        self,
        state: ModalSandboxSessionState,
        *,
        sandbox: Any | None = None,
        exec_result: ExecResult | None = None,
    ) -> None:
        super().__init__(state, ModalSandboxClientOptions())
        self._sandbox_stub = sandbox
        self._exec_result = exec_result or ExecResult(stdout=b"", stderr=b"", exit_code=0)
        self.exec_calls: list[tuple[tuple[str, ...], bool | list[str], str | User | None]] = []

    def _sandbox_or_raise(self) -> Any:
        if self._sandbox_stub is not None:
            return self._sandbox_stub
        return super()._sandbox_or_raise()

    async def exec(
        self,
        *command: str | Path,
        timeout: float | None = None,
        shell: bool | list[str] = True,
        user: str | User | None = None,
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


def _make_session(
    *,
    sandbox: Any | None = None,
    exec_result: ExecResult | None = None,
) -> _StubModalSandboxSession:
    return _StubModalSandboxSession(
        _modal_state(),
        sandbox=sandbox,
        exec_result=exec_result,
    )


@pytest.mark.asyncio
async def test_modal_sandbox_file_io_uses_filesystem_api_under_workspace() -> None:
    fake_sandbox = _FakeSandbox()
    session = _make_session(sandbox=fake_sandbox)

    read_back = await session.read(Path("notes/output.txt"))
    await session.write(Path("artifacts/result.bin"), io.BytesIO(b"payload"))

    assert read_back.read() == b"hello from sandbox"
    assert session.exec_calls == []
    assert fake_sandbox.filesystem.read_calls == ["/workspace/notes/output.txt"]
    assert fake_sandbox.filesystem.write_calls == [(b"payload", "/workspace/artifacts/result.bin")]


@pytest.mark.asyncio
async def test_modal_read_rejects_paths_outside_workspace() -> None:
    fake_sandbox = _FakeSandbox()
    session = _make_session(sandbox=fake_sandbox)

    with pytest.raises(InvalidManifestPathError):
        await session.read(Path("/tmp/outside.txt"))

    assert session.exec_calls == []
    assert fake_sandbox.filesystem.read_calls == []


@pytest.mark.asyncio
async def test_modal_read_maps_filesystem_not_found_to_workspace_error() -> None:
    fake_sandbox = _FakeSandbox(read_error=SandboxFilesystemNotFoundError("missing"))
    session = _make_session(sandbox=fake_sandbox)

    with pytest.raises(WorkspaceReadNotFoundError):
        await session.read(Path("notes/output.txt"))

    assert fake_sandbox.filesystem.read_calls == ["/workspace/notes/output.txt"]


@pytest.mark.asyncio
async def test_modal_write_maps_filesystem_errors_to_workspace_write_error() -> None:
    fake_sandbox = _FakeSandbox(write_error=SandboxFilesystemPermissionError("permission denied"))
    session = _make_session(sandbox=fake_sandbox)

    with pytest.raises(WorkspaceArchiveWriteError):
        await session.write(Path("artifacts/result.bin"), io.BytesIO(b"payload"))

    assert fake_sandbox.filesystem.write_calls == [(b"payload", "/workspace/artifacts/result.bin")]


@pytest.mark.asyncio
async def test_modal_hydrate_workspace_streams_archive_to_tar_stdin_without_staging_file() -> None:
    tar_process = _FakeTarProcess()
    fake_sandbox = _FakeSandbox(process=tar_process)
    session = _make_session(
        sandbox=fake_sandbox,
        exec_result=ExecResult(stdout=b"", stderr=b"", exit_code=0),
    )

    await session.hydrate_workspace(io.BytesIO(b"archive-bytes"))

    assert session.exec_calls == [(("mkdir", "-p", "/workspace"), False, None)]
    assert fake_sandbox.exec_calls == [(("tar", "-C", "/workspace", "-xf", "-"), "/", False)]
    assert fake_sandbox.filesystem.write_calls == []
    assert tar_process.stdin.chunks == [b"archive-bytes"]
    assert tar_process.stdin.eof is True


@pytest.mark.asyncio
async def test_modal_persist_workspace_reads_tar_stream_from_workspace() -> None:
    session = _make_session(
        exec_result=ExecResult(stdout=b"archive-bytes", stderr=b"", exit_code=0),
    )

    persisted = await session.persist_workspace()

    assert session.exec_calls == [(("tar", "-C", "/workspace", "-cf", "-", "."), False, None)]
    assert persisted.read() == b"archive-bytes"
