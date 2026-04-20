from cloud_agent_platform.temporal.contracts import WorkflowRunInput


def test_workflow_contract_is_primitive_payload() -> None:
    payload = WorkflowRunInput(
        run_id="run-1",
        prompt="Inspect the workspace",
        model="gpt-5.4-mini",
        sandbox_provider="modal",
    )

    assert payload.sandbox_provider == "modal"
