"""Integration: Skills capability merges bundled HashiCorp skills into the sandbox manifest."""

from pathlib import Path

from agents.sandbox.capabilities import Skills
from agents.sandbox.entries import LocalDir
from agents.sandbox.runtime_session_manager import SandboxRuntimeSessionManager
from cloud_agent_platform.runtime import build_sandbox_agent


def test_sandbox_skills_add_local_dir_to_manifest() -> None:
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
    from_entry = out.entries[Path(".agents")]
    assert from_entry is skills_cap.from_
    local_root = skills_cap.from_
    assert isinstance(local_root, LocalDir)
    assert local_root.src is not None
    # Bundled: six sibling skill dirs in the merged copy
    assert len([d for d in Path(local_root.src).iterdir() if d.is_dir()]) == 6
