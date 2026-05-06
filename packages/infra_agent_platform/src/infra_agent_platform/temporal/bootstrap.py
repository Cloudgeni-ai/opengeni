from datetime import timedelta
from pathlib import Path

from agents import OpenAIProvider
from agents.extensions.sandbox.modal import ModalImageSelector, ModalSandboxClient
from agents.models.interface import ModelProvider
from openai import AsyncAzureOpenAI, AsyncOpenAI
from temporalio.contrib.openai_agents import (
    ModelActivityParameters,
    OpenAIAgentsPlugin,
    SandboxClientProvider,
)

from infra_agent_platform.config import Settings


def _resolve_path_from_cwd(path: Path) -> Path:
    return path if path.is_absolute() else Path.cwd() / path


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
    if provider == "docker":
        from agents.sandbox.sandboxes.docker import DockerSandboxClient

        from docker import from_env as docker_from_env  # type: ignore[attr-defined]

        return SandboxClientProvider(provider, DockerSandboxClient(docker_from_env()))

    image = None
    if settings.modal_image_ref is not None:
        image = ModalImageSelector.from_tag(settings.modal_image_ref)
    elif settings.modal_dockerfile is not None:
        import modal

        dockerfile = _resolve_path_from_cwd(settings.modal_dockerfile)
        context_dir = _resolve_path_from_cwd(settings.modal_docker_context_dir)
        if not dockerfile.is_file():
            raise ValueError(f"modal Dockerfile does not exist: {dockerfile}")
        image = ModalImageSelector.from_image(
            modal.Image.from_dockerfile(
                dockerfile,
                context_dir=context_dir,
            )
        )
    client = ModalSandboxClient(image=image)
    return SandboxClientProvider(provider, client)


def build_model_provider(settings: Settings) -> ModelProvider | None:
    if settings.openai_provider == "azure":
        if settings.azure_openai_base_url is not None:
            api_key = settings.azure_openai_api_key or settings.azure_openai_ad_token
            if api_key is None:
                raise ValueError(
                    "azure openai provider using base_url requires"
                    " azure_openai_api_key or azure_openai_ad_token"
                )
            openai_client = AsyncOpenAI(
                base_url=settings.azure_openai_base_url,
                api_key=api_key,
                max_retries=0,
            )
            return OpenAIProvider(openai_client=openai_client)

        if (
            settings.azure_openai_endpoint is None
            or settings.azure_openai_deployment is None
            or settings.azure_openai_api_version is None
        ):
            raise ValueError(
                "azure openai provider requires either base_url"
                " or endpoint+deployment+api_version"
            )
        azure_client = AsyncAzureOpenAI(
            azure_endpoint=settings.azure_openai_endpoint,
            azure_deployment=settings.azure_openai_deployment,
            api_version=settings.azure_openai_api_version,
            api_key=settings.azure_openai_api_key,
            azure_ad_token=settings.azure_openai_ad_token,
            max_retries=0,
        )
        return OpenAIProvider(openai_client=azure_client)
    return None


def create_openai_agents_plugin(settings: Settings) -> OpenAIAgentsPlugin:
    sandbox_provider = build_temporal_sandbox_client_provider(settings)
    sandbox_clients = () if sandbox_provider is None else (sandbox_provider,)
    model_provider = build_model_provider(settings)
    return OpenAIAgentsPlugin(
        model_params=ModelActivityParameters(
            start_to_close_timeout=timedelta(seconds=settings.openai_model_activity_timeout_seconds)
        ),
        model_provider=model_provider,
        sandbox_clients=sandbox_clients,
    )
