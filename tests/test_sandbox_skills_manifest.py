"""Integration: HashiCorp Terraform skills use SDK lazy host indexing for `## Skills`."""

from pathlib import Path

import pytest
from agents.sandbox import Manifest
from agents.sandbox.capabilities import Skills
from agents.sandbox.runtime_session_manager import SandboxRuntimeSessionManager
from cloud_agent_platform.runtime import build_sandbox_agent

_BUNDLED = (
    "azure-verified-modules",
    "refactor-module",
    "terraform-search-import",
    "terraform-stacks",
    "terraform-style-guide",
    "terraform-test",
)


def test_sandbox_skills_uses_lazy_host_indexing() -> None:
    """Lazy `Skills` + `LocalDirLazySkillSource`: metadata from each `SKILL.md` on the host."""
    agent = build_sandbox_agent(model="gpt-5.4-mini")
    skills = next(c for c in agent.capabilities if isinstance(c, Skills))
    assert skills.from_ is None
    assert skills.lazy_from is not None


def test_sandbox_skills_reserves_namespace_in_manifest() -> None:
    """`lazy_from` does not pre-materialize `.agents` in the manifest; it only reserves the path."""
    agent = build_sandbox_agent(model="gpt-5.4-mini")
    start = agent.default_manifest
    assert start is not None
    out = SandboxRuntimeSessionManager._process_manifest(
        list(agent.capabilities),
        start.model_copy(deep=True),
        run_as_user=None,
    )
    assert out is not None
    assert Path(".agents") not in out.entries


@pytest.mark.asyncio
async def test_skills_instructions_list_all_terraform_bundles() -> None:
    """The SDK `## Skills` section names every skill from `SKILL.md` front matter."""
    agent = build_sandbox_agent(model="gpt-5.4-mini")
    skills = next(c for c in agent.capabilities if isinstance(c, Skills))
    text = await skills.instructions(Manifest(root="/workspace"))
    assert text is not None
    assert "## Skills" in text
    assert "### Available skills" in text
    assert "Lazy loading" in text
    for name in _BUNDLED:
        assert name in text, f"Missing skill: {name}"
