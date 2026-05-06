from infra_agent_platform.temporal.contracts import WorkflowRunInput


def test_workflow_contract_is_primitive_payload() -> None:
    payload = WorkflowRunInput(
        run_id="run-1",
        prompt="Inspect the workspace",
        model="gpt-5.4-mini",
        sandbox_provider="modal",
    )

    assert payload.sandbox_provider == "modal"
    assert payload.resources == []


def test_workflow_contract_accepts_repository_resources() -> None:
    payload = WorkflowRunInput(
        run_id="run-1",
        prompt="Inspect the workspace",
        model="gpt-5.4-mini",
        sandbox_provider="modal",
        resources=[
            {
                "kind": "repository",
                "uri": "https://github.com/cloudgeni-ai/infra-agents.git",
                "metadata": {
                    "host": "github.com",
                    "repo": "cloudgeni-ai/infra-agents",
                    "ref": "main",
                    "subpath": None,
                    "mount_path": "repos/cloudgeni-ai/infra-agents",
                },
            }
        ],
    )

    assert payload.resources[0]["metadata"]["mount_path"] == "repos/cloudgeni-ai/infra-agents"


def test_workflow_contract_accepts_reasoning_effort() -> None:
    payload = WorkflowRunInput(
        run_id="run-1",
        prompt="Inspect the workspace",
        model="gpt-5.5",
        sandbox_provider="modal",
        reasoning_effort="high",
    )

    assert payload.reasoning_effort == "high"


def test_workflow_contract_accepts_docker_sandbox_options() -> None:
    payload = WorkflowRunInput(
        run_id="run-1",
        prompt="Inspect the workspace",
        model="gpt-5.4-mini",
        sandbox_provider="docker",
        sandbox_image_ref="infra-agents-sandbox:local",
        sandbox_exposed_ports=(3000, 8000),
    )

    assert payload.sandbox_provider == "docker"
    assert payload.sandbox_image_ref == "infra-agents-sandbox:local"
    assert payload.sandbox_exposed_ports == (3000, 8000)


def test_workflow_contract_accepts_sandbox_environment() -> None:
    payload = WorkflowRunInput(
        run_id="run-1",
        prompt="Inspect the workspace",
        model="gpt-5.4-mini",
        sandbox_provider="docker",
        sandbox_environment={"GH_TOKEN": "test-token"},
    )

    assert payload.sandbox_environment == {"GH_TOKEN": "test-token"}
