from agents.sandbox.capabilities import Skills
from cloud_agent_platform.runtime import build_sandbox_agent


def test_openai_agent_runtime_builds_sandbox_agent() -> None:
    agent = build_sandbox_agent(model="gpt-5.4-mini")

    assert agent.name == "Cloud Agent"
    assert agent.model == "gpt-5.4-mini"
    assert agent.default_manifest is not None
    assert agent.default_manifest.root == "/workspace"
    assert any(type(c) is Skills for c in agent.capabilities)
