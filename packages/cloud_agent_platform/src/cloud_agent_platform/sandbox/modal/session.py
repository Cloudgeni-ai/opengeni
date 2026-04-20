import asyncio
import io
from pathlib import Path

import modal
from agents.sandbox.errors import (
    ExecNonZeroError,
    ExecTransportError,
    ExposedPortUnavailableError,
)
from agents.sandbox.session.base_sandbox_session import BaseSandboxSession
from agents.sandbox.types import ExecResult, ExposedPortEndpoint, User

from cloud_agent_platform.sandbox.modal.models import (
    ModalSandboxClientOptions,
    ModalSandboxSessionState,
)
from cloud_agent_platform.sandbox.modal.workspace import (
    as_bytes,
    hydrate_workspace,
    persist_workspace,
    read_workspace_bytes,
    write_workspace_bytes,
)


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
        if await self._resume_backend():
            return
        await self._create_backend()

    async def _resume_backend(self) -> bool:
        if not self.state.sandbox_id:
            return False
        try:
            self._sandbox = await asyncio.to_thread(
                modal.Sandbox.from_id,
                self.state.sandbox_id,
            )
        except Exception:
            self.state = self.state.model_copy(update={"sandbox_id": None})
            return False

        self._set_start_state_preserved(workspace=True)
        return True

    async def _create_backend(self) -> None:
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
            stdout=as_bytes(stdout),
            stderr=as_bytes(stderr),
            exit_code=exit_code,
        )

    async def read(self, path: Path, *, user: str | User | None = None) -> io.IOBase:
        if user is not None:
            raise ExecTransportError(
                command=("modal.Sandbox.filesystem.read_bytes", str(path)),
                context={"reason": "per-user file reads are not supported by this adapter"},
            )

        workspace_path = await self._normalize_path_for_io(path)
        payload = await read_workspace_bytes(
            self._sandbox_or_raise(),
            path=path,
            workspace_path=workspace_path,
        )
        return io.BytesIO(payload)

    async def write(
        self,
        path: Path,
        data: io.IOBase,
        *,
        user: str | User | None = None,
    ) -> None:
        if user is not None:
            raise ExecTransportError(
                command=("modal.Sandbox.filesystem.write_bytes", str(path)),
                context={"reason": "per-user file writes are not supported by this adapter"},
            )

        workspace_path = await self._normalize_path_for_io(path)
        await write_workspace_bytes(
            self._sandbox_or_raise(),
            workspace_path=workspace_path,
            payload=as_bytes(data.read()),
        )

    async def running(self) -> bool:
        if self._sandbox is None:
            return False
        try:
            return await asyncio.to_thread(self._sandbox.poll) is None
        except Exception:
            return False

    async def persist_workspace(self) -> io.IOBase:
        return await persist_workspace(self)

    async def hydrate_workspace(self, data: io.IOBase) -> None:
        await hydrate_workspace(self, data)

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
