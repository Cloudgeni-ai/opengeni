from datetime import timedelta

from temporalio.client import Client
from temporalio.contrib.openai_agents import (
    ModelActivityParameters,
    OpenAIAgentsPlugin,
    SandboxClientProvider,
)
from temporalio.worker import Worker

from cloud_agent_platform.config import Settings
from cloud_agent_platform.sandbox.modal import ModalSandboxClient, ModalSandboxClientOptions
from cloud_agent_platform.temporal.workflows import CloudAgentRunWorkflow


def create_openai_agents_plugin(settings: Settings) -> OpenAIAgentsPlugin:
    sandbox_clients: list[SandboxClientProvider] = []
    if settings.sandbox_backend == "modal":
        modal_options = ModalSandboxClientOptions(
            timeout_seconds=settings.modal_default_timeout_seconds,
            idle_timeout_seconds=settings.modal_idle_timeout_seconds,
            image_ref=settings.modal_image_ref,
        )
        sandbox_clients.append(
            SandboxClientProvider(
                settings.sandbox_provider,
                ModalSandboxClient(settings.modal_app_name, default_options=modal_options),
            )
        )
    return OpenAIAgentsPlugin(
        model_params=ModelActivityParameters(
            start_to_close_timeout=timedelta(seconds=settings.openai_model_activity_timeout_seconds)
        ),
        sandbox_clients=sandbox_clients,
    )


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
