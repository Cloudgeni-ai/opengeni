from typing import Any

from infra_agent_platform.temporal.contracts import (
    WorkflowRunInput,
    WorkflowRunProgress,
    WorkflowRunResult,
)

__all__ = [
    "InfraAgentRunWorkflow",
    "TemporalRunDispatcher",
    "WorkflowRunInput",
    "WorkflowRunProgress",
    "WorkflowRunResult",
    "build_temporal_sandbox_client_provider",
    "build_worker",
    "connect_client",
    "create_openai_agents_plugin",
    "require_temporal_sandbox_provider",
    "resolve_temporal_sandbox_provider",
]


def __getattr__(name: str) -> Any:
    if name == "InfraAgentRunWorkflow":
        from infra_agent_platform.temporal.workflows import InfraAgentRunWorkflow

        return InfraAgentRunWorkflow
    if name == "TemporalRunDispatcher":
        from infra_agent_platform.temporal.dispatcher import TemporalRunDispatcher

        return TemporalRunDispatcher
    if name in {
        "build_temporal_sandbox_client_provider",
        "create_openai_agents_plugin",
        "require_temporal_sandbox_provider",
        "resolve_temporal_sandbox_provider",
    }:
        from infra_agent_platform.temporal import bootstrap

        return getattr(bootstrap, name)
    if name in {"build_worker", "connect_client"}:
        from infra_agent_platform.temporal import worker

        return getattr(worker, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
