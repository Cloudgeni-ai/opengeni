from typing import Any, cast

from agents.sandbox import Manifest, SandboxAgent
from agents.sandbox.capabilities import Filesystem, Shell
from agents.sandbox.capabilities.filesystem import FilesystemToolSet


def _configure_filesystem_tools(toolset: FilesystemToolSet) -> None:
    # Temporal's OpenAI workflow runner in our pinned SDK version does not
    # support the apply_patch sandbox tool type.
    # Map it to another supported tool instance so the generated tool list
    # contains only Temporal-compatible tool types.
    toolset.apply_patch = cast(Any, toolset.view_image)


def build_sandbox_agent(*, model: str, name: str = "Cloud Agent") -> SandboxAgent[None]:
    manifest = Manifest(root="/workspace")
    return SandboxAgent(
        name=name,
        model=model,
        instructions=(
            "You are a standalone cloud agent. Work inside the sandbox workspace, "
            "use files and shell commands when they are useful, and return a concise "
            "summary of completed work and produced artifacts."
        ),
        default_manifest=manifest,
        capabilities=[Filesystem(configure_tools=_configure_filesystem_tools), Shell()],
    )
