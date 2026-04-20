from uuid import uuid4

from agents.sandbox import Manifest
from agents.sandbox.session.sandbox_client import BaseSandboxClient
from agents.sandbox.session.sandbox_session import SandboxSession
from agents.sandbox.session.sandbox_session_state import SandboxSessionState
from agents.sandbox.snapshot import SnapshotBase, SnapshotSpec, resolve_snapshot

from cloud_agent_platform.sandbox.modal.models import (
    ModalSandboxClientOptions,
    ModalSandboxSessionState,
)
from cloud_agent_platform.sandbox.modal.session import ModalSandboxSession


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
