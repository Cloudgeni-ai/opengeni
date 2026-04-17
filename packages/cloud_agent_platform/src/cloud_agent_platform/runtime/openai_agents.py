from agents.sandbox import Manifest, SandboxAgent
from agents.sandbox.capabilities import Filesystem, Shell


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
        capabilities=[Filesystem(), Shell()],
    )
