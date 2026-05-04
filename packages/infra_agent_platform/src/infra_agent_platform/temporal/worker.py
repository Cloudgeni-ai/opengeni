from temporalio.client import Client
from temporalio.worker import Worker

from infra_agent_platform.config import Settings
from infra_agent_platform.temporal.activities import RunEventActivity
from infra_agent_platform.temporal.bootstrap import create_openai_agents_plugin
from infra_agent_platform.temporal.workflows import InfraAgentRunWorkflow


async def connect_client(settings: Settings) -> Client:
    return await Client.connect(
        settings.temporal_host,
        namespace=settings.temporal_namespace,
        plugins=[create_openai_agents_plugin(settings)],
    )


def build_worker(client: Client, settings: Settings) -> Worker:
    run_event_activity = RunEventActivity(settings.database_url)
    return Worker(
        client,
        task_queue=settings.temporal_task_queue,
        workflows=[InfraAgentRunWorkflow],
        activities=[run_event_activity.publish_event, run_event_activity.ensure_run_exists],
    )
