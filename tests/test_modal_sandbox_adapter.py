import pytest
from agents.extensions.sandbox.modal import (
    ModalSandboxClient as FirstPartyModalSandboxClient,
)
from agents.sandbox import Manifest
from agents.sandbox.snapshot import resolve_snapshot
from cloud_agent_platform.sandbox.modal import (
    ModalSandboxClient,
    ModalSandboxClientOptions,
    ModalSandboxSessionState,
)


def test_modal_sandbox_state_round_trips() -> None:
    state = ModalSandboxSessionState(
        manifest=Manifest(root="/workspace"),
        snapshot=resolve_snapshot(None, "test-session"),
        app_name="infra-agents-test",
        sandbox_id="sb-123",
    )
    payload = state.model_dump(mode="json")

    hydrated = ModalSandboxClient(
        default_options=ModalSandboxClientOptions(app_name="infra-agents-test")
    ).deserialize_session_state(payload)

    assert isinstance(hydrated, ModalSandboxSessionState)
    assert hydrated.sandbox_id == "sb-123"


@pytest.mark.asyncio
async def test_modal_shim_uses_default_options_when_temporal_flow_passes_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorded: dict[str, object] = {}

    async def fake_create(
        self: FirstPartyModalSandboxClient,
        *,
        snapshot: object = None,
        manifest: Manifest | None = None,
        options: ModalSandboxClientOptions,
    ) -> str:
        recorded["self"] = self
        recorded["snapshot"] = snapshot
        recorded["manifest"] = manifest
        recorded["options"] = options
        return "created-session"

    monkeypatch.setattr(FirstPartyModalSandboxClient, "create", fake_create)

    default_options = ModalSandboxClientOptions(app_name="infra-agents-modal", timeout=123)
    client = ModalSandboxClient(default_options=default_options)
    manifest = Manifest(root="/workspace")

    result = await client.create(manifest=manifest)

    assert result == "created-session"
    assert recorded["manifest"] == manifest
    assert recorded["options"] == default_options


@pytest.mark.asyncio
async def test_modal_shim_preserves_explicit_options_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorded: dict[str, object] = {}

    async def fake_create(
        self: FirstPartyModalSandboxClient,
        *,
        snapshot: object = None,
        manifest: Manifest | None = None,
        options: ModalSandboxClientOptions,
    ) -> str:
        recorded["options"] = options
        return "created-session"

    monkeypatch.setattr(FirstPartyModalSandboxClient, "create", fake_create)

    client = ModalSandboxClient(
        default_options=ModalSandboxClientOptions(app_name="infra-agents-default", timeout=123)
    )
    explicit_options = ModalSandboxClientOptions(app_name="infra-agents-explicit", timeout=456)

    result = await client.create(options=explicit_options)

    assert result == "created-session"
    assert recorded["options"] == explicit_options
