from infra_agent_contracts import AgentRun
from temporalio.client import Client
from temporalio.service import RPCError, RPCStatusCode

from infra_agent_platform.config import Settings
from infra_agent_platform.errors import DispatchError
from infra_agent_platform.temporal.bootstrap import require_temporal_sandbox_provider
from infra_agent_platform.temporal.contracts import WorkflowRunInput, WorkflowRunProgress


def _parse_exposed_ports(raw: str) -> tuple[int, ...]:
    ports: list[int] = []
    for value in raw.split(","):
        value = value.strip()
        if not value:
            continue
        ports.append(int(value))
    return tuple(ports)


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
            sandbox_provider=require_temporal_sandbox_provider(self._settings),
            sandbox_app_name=self._settings.modal_app_name,
            sandbox_timeout=self._settings.modal_default_timeout_seconds,
            sandbox_image_ref=(
                self._settings.docker_image
                if self._settings.sandbox_backend == "docker"
                else self._settings.modal_image_ref
            ),
            sandbox_exposed_ports=_parse_exposed_ports(self._settings.docker_exposed_ports),
            resources=[
                resource.model_dump(mode="json")
                for resource in run.resources
            ],
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

    async def submit_follow_up(self, workflow_id: str, prompt: str) -> None:
        client = await self._client_or_connect()
        handle = client.get_workflow_handle(workflow_id)
        try:
            await handle.signal("submit_follow_up", prompt)
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                raise DispatchError(f"workflow not found: {workflow_id}") from exc
            raise DispatchError(f"failed to signal follow-up for {workflow_id}") from exc
        except Exception as exc:
            raise DispatchError(f"failed to signal follow-up for {workflow_id}") from exc

    async def request_cancel(self, workflow_id: str, reason: str | None = None) -> None:
        client = await self._client_or_connect()
        handle = client.get_workflow_handle(workflow_id)
        try:
            await handle.signal("request_cancel", reason)
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                raise DispatchError(f"workflow not found: {workflow_id}") from exc
            raise DispatchError(f"failed to signal cancellation for {workflow_id}") from exc
        except Exception as exc:
            raise DispatchError(f"failed to signal cancellation for {workflow_id}") from exc

    async def query_progress(self, workflow_id: str) -> WorkflowRunProgress:
        client = await self._client_or_connect()
        handle = client.get_workflow_handle(workflow_id)
        try:
            response = await handle.query("progress", result_type=WorkflowRunProgress)
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                raise DispatchError(f"workflow not found: {workflow_id}") from exc
            raise DispatchError(f"failed to query progress for {workflow_id}") from exc
        except Exception as exc:
            raise DispatchError(f"failed to query progress for {workflow_id}") from exc
        if isinstance(response, WorkflowRunProgress):
            return response
        if isinstance(response, dict):
            try:
                return WorkflowRunProgress(**response)
            except TypeError as exc:
                raise DispatchError(
                    f"workflow {workflow_id} returned invalid progress payload"
                ) from exc
        raise DispatchError(f"workflow {workflow_id} returned invalid progress payload")
