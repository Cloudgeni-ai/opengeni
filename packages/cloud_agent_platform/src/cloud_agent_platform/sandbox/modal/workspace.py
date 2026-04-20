import asyncio
import io
from pathlib import Path
from typing import TYPE_CHECKING, Any

import modal
from agents.sandbox.errors import (
    ExecNonZeroError,
    ExecTransportError,
    WorkspaceArchiveReadError,
    WorkspaceArchiveWriteError,
    WorkspaceReadNotFoundError,
)
from agents.sandbox.types import ExecResult

if TYPE_CHECKING:
    from cloud_agent_platform.sandbox.modal.session import ModalSandboxSession


async def read_workspace_bytes(
    sandbox: modal.Sandbox,
    *,
    path: Path,
    workspace_path: Path,
) -> bytes:
    try:
        payload = await asyncio.to_thread(
            sandbox.filesystem.read_bytes,
            str(workspace_path),
        )
    except modal.exception.SandboxFilesystemNotFoundError as exc:
        raise WorkspaceReadNotFoundError(path=path, cause=exc) from exc
    except Exception as exc:
        raise WorkspaceArchiveReadError(path=workspace_path, cause=exc) from exc
    return as_bytes(payload)


async def write_workspace_bytes(
    sandbox: modal.Sandbox,
    *,
    workspace_path: Path,
    payload: bytes,
) -> None:
    try:
        await asyncio.to_thread(
            sandbox.filesystem.write_bytes,
            payload,
            str(workspace_path),
        )
    except Exception as exc:
        raise WorkspaceArchiveWriteError(path=workspace_path, cause=exc) from exc


async def persist_workspace(session: "ModalSandboxSession") -> io.IOBase:
    root = session.state.manifest.root
    result = await session.exec("tar", "-C", root, "-cf", "-", ".", shell=False)
    if not result.ok():
        raise ExecNonZeroError(result, command=("tar", "-C", root, "-cf", "-", "."))
    return io.BytesIO(result.stdout)


async def hydrate_workspace(session: "ModalSandboxSession", data: io.IOBase) -> None:
    root = session.state.manifest.root
    result = await session.exec("mkdir", "-p", root, shell=False)
    if not result.ok():
        raise ExecNonZeroError(result, command=("mkdir", "-p", root))
    await _extract_workspace_archive(session, root=root, data=data)


async def _extract_workspace_archive(
    session: "ModalSandboxSession",
    *,
    root: str,
    data: io.IOBase,
) -> None:
    sandbox = session._sandbox_or_raise()
    command = ("tar", "-C", root, "-xf", "-")

    try:
        process = await asyncio.to_thread(
            sandbox.exec,
            *command,
            workdir="/",
            text=False,
        )
        await _write_stream_to_stdin(process.stdin, data)
        stderr = await asyncio.to_thread(process.stderr.read)
        exit_code = await asyncio.to_thread(process.wait)
    except Exception as exc:
        raise ExecTransportError(
            command=command,
            context={"operation": "hydrate_workspace", "workspace_root": root},
            cause=exc,
        ) from exc

    result = ExecResult(stdout=b"", stderr=as_bytes(stderr), exit_code=exit_code)
    if not result.ok():
        raise ExecNonZeroError(result, command=command)


async def _write_stream_to_stdin(stdin: Any, data: io.IOBase) -> None:
    while True:
        chunk = data.read(64 * 1024)
        if not chunk:
            break
        stdin.write(as_bytes(chunk))
        await asyncio.to_thread(stdin.drain)
    stdin.write_eof()
    await asyncio.to_thread(stdin.drain)


def as_bytes(value: Any) -> bytes:
    if isinstance(value, bytes):
        return value
    if isinstance(value, bytearray):
        return bytes(value)
    if isinstance(value, str):
        return value.encode("utf-8")
    raise TypeError(f"expected bytes-compatible value, got {type(value).__name__}")
