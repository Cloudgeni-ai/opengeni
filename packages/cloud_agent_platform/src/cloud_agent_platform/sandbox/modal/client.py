from agents.extensions.sandbox.modal import (
    ModalImageSelector,
    ModalSandboxClientOptions,
    ModalSandboxSelector,
)
from agents.extensions.sandbox.modal import (
    ModalSandboxClient as FirstPartyModalSandboxClient,
)
from agents.sandbox import Manifest
from agents.sandbox.session.dependencies import Dependencies
from agents.sandbox.session.manager import Instrumentation
from agents.sandbox.session.sandbox_session import SandboxSession
from agents.sandbox.snapshot import SnapshotBase, SnapshotSpec


class ModalSandboxClient(FirstPartyModalSandboxClient):
    """Tiny Temporal compatibility shim over the first-party Modal sandbox client."""

    supports_default_options = True

    def __init__(
        self,
        *,
        default_options: ModalSandboxClientOptions,
        image: ModalImageSelector | None = None,
        sandbox: ModalSandboxSelector | None = None,
        instrumentation: Instrumentation | None = None,
        dependencies: Dependencies | None = None,
    ) -> None:
        super().__init__(
            image=image,
            sandbox=sandbox,
            instrumentation=instrumentation,
            dependencies=dependencies,
        )
        self._default_options = default_options

    async def create(
        self,
        *,
        snapshot: SnapshotSpec | SnapshotBase | None = None,
        manifest: Manifest | None = None,
        options: ModalSandboxClientOptions | None = None,
    ) -> SandboxSession:
        return await super().create(
            snapshot=snapshot,
            manifest=manifest,
            options=options or self._default_options,
        )
