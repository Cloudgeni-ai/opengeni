import asyncio
import io
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

import modal
from agents.sandbox import Manifest
from agents.sandbox.errors import ExecNonZeroError, ExecTransportError, ExposedPortUnavailableError
from agents.sandbox.session.base_sandbox_session import BaseSandboxSession
from agents.sandbox.session.sandbox_client import BaseSandboxClient
from agents.sandbox.session.sandbox_session import SandboxSession
from agents.sandbox.session.sandbox_session_state import SandboxSessionState
from agents.sandbox.snapshot import SnapshotBase, SnapshotSpec, resolve_snapshot
from agents.sandbox.types import ExecResult, ExposedPortEndpoint, User
from pydantic import Field


@dataclass(frozen=True)
class ModalSandboxClientOptions:
    timeout_seconds: int = 900
    idle_timeout_seconds: int | None = 300
    image_ref: str | None = None
    env: Mapping[str, str | None] = field(default_factory=dict)


class ModalSandboxSessionState(SandboxSessionState):
    type: Literal["modal"] = "modal"
    sandbox_id: str | None = None
    app_name: str = Field(min_length=1)


class ModalSandboxClient(BaseSandboxClient[ModalSandboxClientOptions | None]):
    backend_id = "modal"
    supports_default_options = True

    def __init__(
        self,
        app_name: str,
        *,
        default_options: ModalSandboxClientOptions | None = None,
    ) -> None:
        self._app_name = app_name
        self._default_options = default_options or ModalSandboxClientOptions()

    async def create(
        self,
        *,
        snapshot: SnapshotSpec | SnapshotBase | None = None,
        manifest: Manifest | None = None,
        options: ModalSandboxClientOptions | None = None,
    ) -> SandboxSession:
        session_id = uuid4()
        resolved_manifest = manifest or Manifest(root="/workspace")
        state = ModalSandboxSessionState(
            session_id=session_id,
            manifest=resolved_manifest,
            snapshot=resolve_snapshot(snapshot, str(session_id)),
            app_name=self._app_name,
        )
        inner = ModalSandboxSession(state, options or self._default_options)
        return self._wrap_session(inner)

    async def delete(self, session: SandboxSession) -> SandboxSession:
        inner = getattr(session, "_inner", None)
        if not isinstance(inner, ModalSandboxSession):
            raise TypeError("ModalSandboxClient.delete expects a ModalSandboxSession")
        await inner.shutdown()
        return session

    async def resume(self, state: SandboxSessionState) -> SandboxSession:
        if not isinstance(state, ModalSandboxSessionState):
            raise TypeError("ModalSandboxClient.resume expects a ModalSandboxSessionState")
        return self._wrap_session(ModalSandboxSession(state, self._default_options))

    def deserialize_session_state(self, payload: dict[str, object]) -> SandboxSessionState:
        return ModalSandboxSessionState.model_validate(payload)


class ModalSandboxSession(BaseSandboxSession):
    state: ModalSandboxSessionState

    def __init__(
        self,
        state: ModalSandboxSessionState,
        options: ModalSandboxClientOptions,
    ) -> None:
        self.state = state
        self._options = options
        self._sandbox: modal.Sandbox | None = None

    def _image(self) -> modal.Image:
        if self._options.image_ref:
            return modal.Image.from_registry(self._options.image_ref, add_python="3.12")
        return modal.Image.debian_slim(python_version="3.12")

    def _sandbox_or_raise(self) -> modal.Sandbox:
        if self._sandbox is None:
            raise ExecTransportError(
                command=("modal", "sandbox"),
                context={"reason": "sandbox has not been started"},
            )
        return self._sandbox

    async def _ensure_backend_started(self) -> None:
        if self._sandbox is not None:
            return
        if self.state.sandbox_id:
            try:
                self._sandbox = await asyncio.to_thread(
                    modal.Sandbox.from_id,
                    self.state.sandbox_id,
                )
                self._set_start_state_preserved(workspace=True)
                return
            except Exception:
                self.state = self.state.model_copy(update={"sandbox_id": None})

        app = modal.App(self.state.app_name)
        try:
            sandbox = await asyncio.to_thread(
                modal.Sandbox.create,
                "sleep",
                "infinity",
                app=app,
                image=self._image(),
                env=dict(self._options.env),
                timeout=self._options.timeout_seconds,
                idle_timeout=self._options.idle_timeout_seconds,
                workdir="/",
            )
        except Exception as exc:
            raise ExecTransportError(
                command=("modal.Sandbox.create",),
                context={"app_name": self.state.app_name},
                cause=exc,
            ) from exc

        self._sandbox = sandbox
        self.state = self.state.model_copy(update={"sandbox_id": sandbox.object_id})
        self._set_start_state_preserved(workspace=False)

    async def _prepare_backend_workspace(self) -> None:
        result = await self.exec("mkdir", "-p", self.state.manifest.root, shell=False)
        if not result.ok():
            raise ExecNonZeroError(result, command=("mkdir", "-p", self.state.manifest.root))

    async def _after_start_failed(self) -> None:
        await self._shutdown_backend()

    async def _exec_internal(
        self,
        *command: str | Path,
        timeout: float | None = None,
    ) -> ExecResult:
        sandbox = self._sandbox_or_raise()
        command_text = tuple(str(part) for part in command)
        try:
            process = await asyncio.to_thread(
                sandbox.exec,
                *command_text,
                timeout=int(timeout) if timeout is not None else None,
                workdir=self.state.manifest.root if self.state.workspace_root_ready else "/",
                text=False,
            )
            exit_code = await asyncio.to_thread(process.wait)
            stdout = await asyncio.to_thread(process.stdout.read)
            stderr = await asyncio.to_thread(process.stderr.read)
        except Exception as exc:
            raise ExecTransportError(
                command=command_text,
                context={"sandbox_id": self.state.sandbox_id},
                cause=exc,
            ) from exc
        return ExecResult(
            stdout=_as_bytes(stdout),
            stderr=_as_bytes(stderr),
            exit_code=exit_code,
        )

    async def read(self, path: Path, *, user: str | User | None = None) -> io.IOBase:
        if user is not None:
            raise ExecTransportError(
                command=("modal.Sandbox.open", str(path)),
                context={"reason": "per-user file reads are not supported by this adapter"},
            )
        sandbox = self._sandbox_or_raise()

        def read_file() -> bytes:
            with sandbox.open(str(path), "rb") as remote_file:
                return _as_bytes(remote_file.read())

        try:
            return io.BytesIO(await asyncio.to_thread(read_file))
        except Exception as exc:
            raise ExecTransportError(
                command=("modal.Sandbox.open", str(path)),
                context={"operation": "read"},
                cause=exc,
            ) from exc

    async def write(
        self,
        path: Path,
        data: io.IOBase,
        *,
        user: str | User | None = None,
    ) -> None:
        if user is not None:
            raise ExecTransportError(
                command=("modal.Sandbox.open", str(path)),
                context={"reason": "per-user file writes are not supported by this adapter"},
            )
        sandbox = self._sandbox_or_raise()
        payload = data.read()

        def write_file() -> None:
            parent = str(Path(path).parent)
            process = sandbox.exec("mkdir", "-p", parent, text=False)
            exit_code = process.wait()
            if exit_code != 0:
                raise RuntimeError(f"failed to create remote parent directory: {parent}")
            with sandbox.open(str(path), "wb") as remote_file:
                remote_file.write(_as_bytes(payload))

        try:
            await asyncio.to_thread(write_file)
        except Exception as exc:
            raise ExecTransportError(
                command=("modal.Sandbox.open", str(path)),
                context={"operation": "write"},
                cause=exc,
            ) from exc

    async def running(self) -> bool:
        if self._sandbox is None:
            return False
        try:
            return await asyncio.to_thread(self._sandbox.poll) is None
        except Exception:
            return False

    async def persist_workspace(self) -> io.IOBase:
        root = self.state.manifest.root
        result = await self.exec("tar", "-C", root, "-cf", "-", ".", shell=False)
        if not result.ok():
            raise ExecNonZeroError(result, command=("tar", "-C", root, "-cf", "-", "."))
        return io.BytesIO(result.stdout)

    async def hydrate_workspace(self, data: io.IOBase) -> None:
        archive_path = Path("/tmp/infra-agents-workspace.tar")
        root = self.state.manifest.root
        await self.write(archive_path, data)
        result = await self.exec("mkdir", "-p", root, shell=False)
        if not result.ok():
            raise ExecNonZeroError(result, command=("mkdir", "-p", root))
        result = await self.exec("tar", "-C", root, "-xf", archive_path, shell=False)
        if not result.ok():
            raise ExecNonZeroError(result, command=("tar", "-C", root, "-xf", archive_path))
        cleanup = await self.exec("rm", "-f", archive_path, shell=False)
        if not cleanup.ok():
            raise ExecNonZeroError(cleanup, command=("rm", "-f", archive_path))

    async def _resolve_exposed_port(self, port: int) -> ExposedPortEndpoint:
        raise ExposedPortUnavailableError(
            port=port,
            exposed_ports=self.state.exposed_ports,
            reason="backend_unavailable",
            context={"backend": "modal"},
        )

    async def _shutdown_backend(self) -> None:
        sandbox = self._sandbox
        if sandbox is None:
            return
        try:
            await asyncio.to_thread(sandbox.terminate, wait=True)
        finally:
            try:
                await asyncio.to_thread(sandbox.detach)
            finally:
                self._sandbox = None


def _as_bytes(value: Any) -> bytes:
    if isinstance(value, bytes):
        return value
    if isinstance(value, bytearray):
        return bytes(value)
    if isinstance(value, str):
        return value.encode("utf-8")
    raise TypeError(f"expected bytes-compatible value, got {type(value).__name__}")
