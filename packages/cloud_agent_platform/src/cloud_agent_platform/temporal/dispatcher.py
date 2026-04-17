from cloud_agent_contracts import AgentRun
from temporalio.client import Client

from cloud_agent_platform.config import Settings
from cloud_agent_platform.errors import DispatchError
from cloud_agent_platform.temporal.contracts import WorkflowRunInput


class TemporalRunDispatcher:
    def __init__(self, settings: Settings, client: Client | None = None) -> None:
        self._settings = settings
        self._client = client

    async def _client_or_connect(self) -> Client:
        if self._client is not None:
            return self._client
        try:
            self._client = await Client.connect(
                self._settings.temporal_host,
                namespace=self._settings.temporal_namespace,
            )
        except Exception as exc:
            raise DispatchError("failed to connect to Temporal") from exc
        return self._client

    async def dispatch(self, run: AgentRun) -> str:
        workflow_id = f"agent-run-{run.id}"
        payload = WorkflowRunInput(
            run_id=str(run.id),
            prompt=run.prompt,
            model=self._settings.openai_model,
            sandbox_provider=self._settings.sandbox_provider_name,
            metadata=run.metadata,
        )
        client = await self._client_or_connect()
        try:
            await client.start_workflow(
                self._settings.temporal_workflow_type,
                payload,
                id=workflow_id,
                task_queue=self._settings.temporal_task_queue,
            )
        except Exception as exc:
            raise DispatchError(f"failed to start workflow {workflow_id}") from exc
        return workflow_id
