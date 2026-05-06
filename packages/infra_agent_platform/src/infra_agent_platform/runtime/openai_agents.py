from pathlib import Path
from typing import Any, Literal, cast

from agents import ModelSettings
from agents.model_settings import Reasoning
from agents.sandbox import Manifest, SandboxAgent
from agents.sandbox.capabilities import Filesystem, Shell, Skills
from agents.sandbox.capabilities.filesystem import FilesystemToolSet
from agents.sandbox.entries import LocalDir


def _bundled_terraform_skills_dir() -> Path:
    return (Path(__file__).resolve().parent.parent / "bundled_hashicorp_terraform_skills").resolve()


def _hashicorp_terraform_skills() -> Skills:
    # LocalDir: manifest serializes a path only. Worker applies copy from that host path.
    return Skills(from_=LocalDir(src=_bundled_terraform_skills_dir()))


def _configure_filesystem_tools(toolset: FilesystemToolSet) -> None:
    # Temporal's OpenAI workflow runner in our pinned SDK version does not
    # support the apply_patch sandbox tool type.
    # Map it to another supported tool instance so the generated tool list
    # contains only Temporal-compatible tool types.
    toolset.apply_patch = cast(Any, toolset.view_image)


ReasoningEffortValue = Literal["none", "minimal", "low", "medium", "high", "xhigh"]


def build_sandbox_agent(
    *,
    model: str,
    reasoning_effort: str | None = None,
    name: str = "Infra Agent",
) -> SandboxAgent[None]:
    manifest = Manifest(root="/workspace")
    effort = cast(ReasoningEffortValue, reasoning_effort)
    model_settings = (
        ModelSettings(reasoning=Reasoning(effort=effort))
        if reasoning_effort is not None
        else ModelSettings()
    )
    return SandboxAgent(
        name=name,
        model=model,
        model_settings=model_settings,
        instructions=(
            "You are a standalone infra agent. Work inside the sandbox workspace, "
            "use files and shell commands when they are useful, and return a concise "
            "summary of completed work and produced artifacts. "
            "The workspace includes Terraform and infrastructure skills under "
            "`.agents/<skill-name>/` (for example `.agents/terraform-style-guide/SKILL.md` "
            "and `.agents/checkov/SKILL.md`); "
            "repository resources, when provided, are mounted under "
            "`repos/<org-or-path>/<repo-name>/`; "
            "use a shell `ls` or the filesystem tools to confirm paths before assuming "
            "files are missing. When asked to create a pull request, complete the full "
            "workflow yourself: make the requested change, create a branch, commit, push, "
            "and run `gh pr create` with `gh -R owner/repo` when needed. Do not stop by "
            "printing commands for the user unless a command fails because a required "
            "credential or permission is unavailable. Before using Azure CLI, run "
            "`infra-agent-azure-login` once when AZURE_* or ARM_* service-principal "
            "environment variables are present; Terraform can use ARM_* directly."
        ),
        default_manifest=manifest,
        capabilities=[
            Filesystem(configure_tools=_configure_filesystem_tools),
            Shell(),
            _hashicorp_terraform_skills(),
        ],
    )
