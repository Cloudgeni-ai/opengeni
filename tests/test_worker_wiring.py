from agents.sandbox import Manifest
from agents.sandbox.snapshot import resolve_snapshot
from cloud_agent_platform.config import Settings
from cloud_agent_platform.runtime import build_sandbox_agent
from cloud_agent_platform.sandbox.modal import ModalSandboxClient, ModalSandboxSessionState
from cloud_agent_platform.temporal.contracts import WorkflowRunInput
from cloud_agent_platform.temporal.worker import create_openai_agents_plugin


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
