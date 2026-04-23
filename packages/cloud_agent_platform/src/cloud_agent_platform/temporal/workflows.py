from datetime import timedelta
from typing import Any

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from agents import Runner
    from agents.extensions.sandbox.modal import ModalSandboxClientOptions
    from agents.run import RunConfig
    from agents.sandbox import SandboxRunConfig
    from cloud_agent_contracts import AgentRunStatus, EventType
    from temporalio.contrib.openai_agents.workflow import temporal_sandbox_client

    from cloud_agent_platform.runtime.openai_agents import build_sandbox_agent
    from cloud_agent_platform.temporal.activities import EventActivityInput, RunEventActivity
from cloud_agent_platform.temporal.contracts import (
    WorkflowRunInput,
    WorkflowRunProgress,
    WorkflowRunResult,
)


@workflow.defn
class CloudAgentRunWorkflow:
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

    async def _run_agent_turn(self, request: WorkflowRunInput, prompt: str):
        agent = build_sandbox_agent(model=request.model)
        sandbox_options = ModalSandboxClientOptions(
            app_name=request.sandbox_app_name,
            timeout=request.sandbox_timeout,
        )
        return await Runner.run(
            agent,
            prompt,
            run_config=RunConfig(
                sandbox=SandboxRunConfig(
                    client=temporal_sandbox_client(request.sandbox_provider),
                    options=sandbox_options,
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
