from datetime import timedelta
from pathlib import Path
from typing import Any

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from agents import Runner, RunResult
    from agents.extensions.sandbox.modal import ModalSandboxClientOptions
    from agents.run import RunConfig
    from agents.sandbox import Manifest, SandboxAgent, SandboxRunConfig
    from agents.sandbox.entries import BaseEntry, GitRepo
    from agents.sandbox.runtime_session_manager import SandboxRuntimeSessionManager
    from agents.sandbox.sandboxes.docker import DockerSandboxClientOptions
    from infra_agent_contracts import AgentRunStatus, EventType, ResourceKind
    from temporalio.contrib.openai_agents.workflow import temporal_sandbox_client

    from infra_agent_platform.runtime.openai_agents import build_sandbox_agent
    from infra_agent_platform.temporal.activities import EventActivityInput, RunEventActivity
from infra_agent_platform.temporal.contracts import (
    WorkflowRunInput,
    WorkflowRunProgress,
    WorkflowRunResult,
)


def _normalize_manifest_path_keys(manifest: Manifest) -> Manifest:
    """Temporal payload decoding turns dict keys into str; re-coerce to Path for `Skills`."""
    if not manifest.entries:
        return manifest
    out: dict[str | Path, BaseEntry] = {}
    for key, value in manifest.entries.items():
        coerced = Path(key) if not isinstance(key, Path) else key
        out[coerced] = value
    return manifest.model_copy(update={"entries": out})


def _processed_sandbox_manifest(agent: SandboxAgent) -> Manifest | None:
    """Merge capabilities into the default manifest for fresh sandbox session creation."""
    base = agent.default_manifest
    if base is None:
        return None
    return SandboxRuntimeSessionManager._process_manifest(
        list(agent.capabilities),
        base.model_copy(deep=True),
        run_as_user=None,
    )


def _repository_manifest_entries(resources: list[dict[str, Any]]) -> dict[Path, GitRepo]:
    entries: dict[Path, GitRepo] = {}
    for resource in resources:
        if resource.get("kind") != ResourceKind.REPOSITORY.value:
            continue
        metadata = resource.get("metadata")
        if not isinstance(metadata, dict):
            continue
        host = str(metadata.get("host") or "").strip()
        repo = str(metadata.get("repo") or "").strip()
        ref = str(metadata.get("ref") or "").strip()
        mount_path = str(metadata.get("mount_path") or "").strip().strip("/")
        subpath = metadata.get("subpath")
        if subpath is not None:
            subpath = str(subpath).strip().strip("/") or None
        if not host or not repo or not ref or not mount_path:
            continue
        entries[Path(mount_path)] = GitRepo(
            host=host,
            repo=repo,
            ref=ref,
            subpath=subpath,
        )
    return entries


def _manifest_with_repository_resources(
    manifest: Manifest | None,
    resources: list[dict[str, Any]],
) -> Manifest | None:
    if manifest is None:
        return None
    resource_entries = _repository_manifest_entries(resources)
    if not resource_entries:
        return manifest
    entries: dict[str | Path, BaseEntry] = dict(manifest.entries)
    for path, entry in resource_entries.items():
        entries[path] = entry
    return manifest.model_copy(update={"entries": entries})


def _sandbox_options_for_request(
    request: WorkflowRunInput,
) -> ModalSandboxClientOptions | DockerSandboxClientOptions:
    if request.sandbox_provider == "docker":
        image = request.sandbox_image_ref or "infra-agents-sandbox:local"
        return DockerSandboxClientOptions(
            image=image,
            exposed_ports=request.sandbox_exposed_ports,
        )
    return ModalSandboxClientOptions(
        app_name=request.sandbox_app_name,
        timeout=request.sandbox_timeout,
    )


@workflow.defn
class InfraAgentRunWorkflow:
    def __init__(self) -> None:
        self._follow_ups: list[str] = []
        self._cancel_requested = False
        self._waiting_for_follow_up = False
        self._state = "initializing"
        self._turn = 0
        self._last_output: str | None = None
        self._run_id: str | None = None

    @workflow.signal
    def submit_follow_up(self, prompt: str) -> None:
        if prompt.strip():
            self._follow_ups.append(prompt)

    @workflow.signal
    def request_cancel(self, reason: str | None = None) -> None:
        del reason
        self._cancel_requested = True

    @workflow.query
    def progress(self) -> WorkflowRunProgress:
        run_id = self._run_id or ""
        return WorkflowRunProgress(
            run_id=run_id,
            state=self._state,
            turn=self._turn,
            queue_depth=len(self._follow_ups),
            cancellation_requested=self._cancel_requested,
            waiting_for_follow_up=self._waiting_for_follow_up,
            last_output=self._last_output,
        )

    @workflow.run
    async def run(self, request: WorkflowRunInput) -> WorkflowRunResult:
        self._run_id = request.run_id
        await self._publish_event(
            request.run_id,
            EventType.RUN_STARTED,
            {"status": AgentRunStatus.RUNNING.value},
            status=AgentRunStatus.RUNNING,
        )
        prompt = request.prompt
        last_output = ""
        self._state = AgentRunStatus.RUNNING.value
        try:
            while True:
                if self._cancel_requested:
                    self._state = AgentRunStatus.CANCELLED.value
                    await self._publish_event(
                        request.run_id,
                        EventType.RUN_CANCELLED,
                        {
                            "status": AgentRunStatus.CANCELLED.value,
                            "turn": self._turn,
                        },
                        status=AgentRunStatus.CANCELLED,
                    )
                    return WorkflowRunResult(run_id=request.run_id, final_output=last_output)
                self._turn += 1
                result = await self._run_agent_turn(request, prompt)
                last_output = str(result.final_output)
                self._last_output = last_output
                await self._publish_event(
                    request.run_id,
                    EventType.RUN_COMPLETED,
                    {
                        "status": AgentRunStatus.RUNNING.value,
                        "turn_status": AgentRunStatus.SUCCEEDED.value,
                        "turn": self._turn,
                        "output": last_output,
                    },
                    status=AgentRunStatus.RUNNING,
                )
                self._waiting_for_follow_up = True
                self._state = AgentRunStatus.WAITING.value
                await self._publish_event(
                    request.run_id,
                    EventType.RUN_WAITING,
                    {
                        "status": AgentRunStatus.WAITING.value,
                        "turn": self._turn,
                    },
                    status=AgentRunStatus.WAITING,
                )
                await workflow.wait_condition(
                    lambda: bool(self._follow_ups) or self._cancel_requested
                )
                self._waiting_for_follow_up = False
                if self._cancel_requested:
                    continue
                prompt = self._follow_ups.pop(0)
                self._state = AgentRunStatus.RUNNING.value
                await self._publish_event(
                    request.run_id,
                    EventType.RUN_FOLLOW_UP,
                    {
                        "status": AgentRunStatus.RUNNING.value,
                        "turn": self._turn + 1,
                        "prompt": prompt,
                    },
                    status=AgentRunStatus.RUNNING,
                )
        except Exception as exc:
            self._state = AgentRunStatus.FAILED.value
            await self._publish_event(
                request.run_id,
                EventType.RUN_FAILED,
                {
                    "status": AgentRunStatus.FAILED.value,
                    "turn": self._turn,
                    "error": str(exc),
                },
                status=AgentRunStatus.FAILED,
            )
            raise

    async def _run_agent_turn(self, request: WorkflowRunInput, prompt: str) -> RunResult:
        agent = build_sandbox_agent(model=request.model)
        sandbox_options = _sandbox_options_for_request(request)
        raw = _processed_sandbox_manifest(agent)
        processed = _normalize_manifest_path_keys(raw) if raw is not None else None
        processed = _manifest_with_repository_resources(processed, request.resources)
        return await Runner.run(
            agent,
            prompt,
            run_config=RunConfig(
                sandbox=SandboxRunConfig(
                    client=temporal_sandbox_client(request.sandbox_provider),
                    options=sandbox_options,
                    manifest=processed,
                )
            ),
        )

    async def _publish_event(
        self,
        run_id: str,
        event_type: EventType,
        payload: dict[str, Any],
        *,
        status: AgentRunStatus,
    ) -> None:
        await workflow.execute_activity_method(
            RunEventActivity.publish_event,
            EventActivityInput(
                run_id=run_id,
                event_type=event_type.value,
                payload=payload,
                status=status,
            ),
            start_to_close_timeout=timedelta(seconds=30),
        )
