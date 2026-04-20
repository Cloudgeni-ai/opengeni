from temporalio.client import Client
from temporalio.worker import Worker

from cloud_agent_platform.config import Settings
from cloud_agent_platform.temporal.bootstrap import create_openai_agents_plugin
from cloud_agent_platform.temporal.workflows import CloudAgentRunWorkflow


async def connect_client(settings: Settings) -> Client:
    return await Client.connect(
        settings.temporal_host,
        namespace=settings.temporal_namespace,
        plugins=[create_openai_agents_plugin(settings)],
    )


def build_worker(client: Client, settings: Settings) -> Worker:
    return Worker(
        client,
        task_queue=settings.temporal_task_queue,
        workflows=[CloudAgentRunWorkflow],
    )
