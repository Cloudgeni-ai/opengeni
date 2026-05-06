from agents.sandbox.capabilities import Skills
from infra_agent_platform.runtime import build_sandbox_agent


def test_openai_agent_runtime_builds_sandbox_agent() -> None:
    agent = build_sandbox_agent(model="gpt-5.4-mini")

    assert agent.name == "Infra Agent"
    assert agent.model == "gpt-5.4-mini"
    assert agent.default_manifest is not None
    assert agent.default_manifest.root == "/workspace"
    assert any(type(c) is Skills for c in agent.capabilities)
    inst = agent.instructions
    assert inst is not None
    assert ".agents/" in str(inst) or ".agents" in str(inst)
    assert ".agents/checkov/SKILL.md" in str(inst)
    assert "gh pr create" in str(inst)


def test_openai_agent_runtime_applies_reasoning_effort() -> None:
    agent = build_sandbox_agent(model="gpt-5.5", reasoning_effort="high")

    assert agent.model == "gpt-5.5"
    assert agent.model_settings.reasoning is not None
    assert agent.model_settings.reasoning.effort == "high"
