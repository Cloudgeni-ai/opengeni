from temporalio import workflow

from cloud_agent_platform.temporal.contracts import WorkflowRunInput, WorkflowRunResult

with workflow.unsafe.imports_passed_through():
    from agents import Runner
    from agents.run import RunConfig
    from agents.sandbox import SandboxRunConfig
    from temporalio.contrib.openai_agents.workflow import temporal_sandbox_client

    from cloud_agent_platform.runtime.openai_agents import build_sandbox_agent


@workflow.defn
class CloudAgentRunWorkflow:
    @workflow.run
    async def run(self, request: WorkflowRunInput) -> WorkflowRunResult:
        agent = build_sandbox_agent(model=request.model)
        result = await Runner.run(
            agent,
            request.prompt,
            run_config=RunConfig(
                sandbox=SandboxRunConfig(
                    client=temporal_sandbox_client(request.sandbox_provider),
                )
            ),
        )
        return WorkflowRunResult(run_id=request.run_id, final_output=str(result.final_output))
