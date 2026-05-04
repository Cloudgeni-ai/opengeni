"""Integration: `Skills` uses `LocalDir` to `.agents` with processed manifest in workflow."""

from pathlib import Path
from tempfile import TemporaryDirectory

from agents.sandbox.capabilities import Skills
from agents.sandbox.entries import LocalDir
from agents.sandbox.runtime_session_manager import SandboxRuntimeSessionManager
from infra_agent_platform.runtime import build_sandbox_agent
from infra_agent_platform.runtime.openai_agents import _bundled_terraform_skills_dir

_BUNDLED = (
    "azure-verified-modules",
    "refactor-module",
    "terraform-search-import",
    "terraform-stacks",
    "terraform-style-guide",
    "terraform-test",
)


def test_bundled_terraform_folders_on_disk() -> None:
    root = _bundled_terraform_skills_dir()
    for name in _BUNDLED:
        assert (root / name / "SKILL.md").is_file(), name


def test_sandbox_skills_uses_local_dir_absolute() -> None:
    agent = build_sandbox_agent(model="gpt-5.4-mini")
    skills = next(c for c in agent.capabilities if isinstance(c, Skills))
    assert skills.from_ is not None
    assert isinstance(skills.from_, LocalDir)
    assert skills.from_.src is not None
    p = Path(skills.from_.src)
    assert p.is_absolute() and p.is_dir()
    assert len([d for d in p.iterdir() if d.is_dir()]) == 6


def test_sandbox_skills_merges_dot_agents_in_manifest() -> None:
    agent = build_sandbox_agent(model="gpt-5.4-mini")
    skills_cap = next(c for c in agent.capabilities if isinstance(c, Skills))
    start = agent.default_manifest
    assert start is not None
    out = SandboxRuntimeSessionManager._process_manifest(
        list(agent.capabilities),
        start.model_copy(deep=True),
        run_as_user=None,
    )
    assert out is not None
    assert out.entries[Path(".agents")] is skills_cap.from_


def test_readonly_copy_skips_nothing() -> None:
    with TemporaryDirectory() as t:
        p = Path(t)
        (p / "a.txt").write_text("x", encoding="utf-8")
        assert (p / "a.txt").read_text() == "x"
