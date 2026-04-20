from datetime import timedelta

from agents.extensions.sandbox.modal import ModalImageSelector
from temporalio.contrib.openai_agents import (
    ModelActivityParameters,
    OpenAIAgentsPlugin,
    SandboxClientProvider,
)

from cloud_agent_platform.config import Settings
from cloud_agent_platform.sandbox.modal import ModalSandboxClient, ModalSandboxClientOptions


def resolve_temporal_sandbox_provider(settings: Settings) -> str | None:
    if settings.sandbox_backend == "none":
        return None
    return settings.sandbox_backend


def require_temporal_sandbox_provider(settings: Settings) -> str:
    provider = resolve_temporal_sandbox_provider(settings)
    if provider is None:
        raise ValueError("sandbox backend does not expose a Temporal sandbox provider")
    return provider


def build_temporal_sandbox_client_provider(
    settings: Settings,
) -> SandboxClientProvider | None:
    provider = resolve_temporal_sandbox_provider(settings)
    if provider is None:
        return None

    modal_options = ModalSandboxClientOptions(
        app_name=settings.modal_app_name,
        timeout=settings.modal_default_timeout_seconds,
    )
    image = (
        ModalImageSelector.from_tag(settings.modal_image_ref)
        if settings.modal_image_ref is not None
        else None
    )
    return SandboxClientProvider(
        provider,
        ModalSandboxClient(default_options=modal_options, image=image),
    )


def create_openai_agents_plugin(settings: Settings) -> OpenAIAgentsPlugin:
    sandbox_provider = build_temporal_sandbox_client_provider(settings)
    sandbox_clients = () if sandbox_provider is None else (sandbox_provider,)
    return OpenAIAgentsPlugin(
        model_params=ModelActivityParameters(
            start_to_close_timeout=timedelta(seconds=settings.openai_model_activity_timeout_seconds)
        ),
        sandbox_clients=sandbox_clients,
    )
