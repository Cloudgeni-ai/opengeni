import pytest
from agents import OpenAIProvider
from agents.extensions.sandbox.modal import ModalImageSelector, ModalSandboxClient
from cloud_agent_platform.config import Settings
from cloud_agent_platform.temporal.bootstrap import (
    build_temporal_sandbox_client_provider,
    build_model_provider,
    create_openai_agents_plugin,
    require_temporal_sandbox_provider,
    resolve_temporal_sandbox_provider,
)
from pydantic import ValidationError


def test_temporal_plugin_can_be_created_without_sandbox_backend() -> None:
    plugin = create_openai_agents_plugin(Settings(sandbox_backend="none"))

    assert plugin is not None


def test_temporal_sandbox_provider_follows_backend_selection() -> None:
    settings = Settings(
        modal_app_name="infra-agents-modal",
        modal_default_timeout_seconds=123,
        modal_image_ref="ghcr.io/cloudgeni/modal:latest",
    )

    assert resolve_temporal_sandbox_provider(settings) == "modal"
    assert require_temporal_sandbox_provider(settings) == "modal"

    provider = build_temporal_sandbox_client_provider(settings)
    assert provider is not None
    assert provider.name == "modal"
    assert isinstance(provider._client, ModalSandboxClient)
    assert provider._client._default_image == ModalImageSelector.from_tag(
        "ghcr.io/cloudgeni/modal:latest"
    )


def test_temporal_sandbox_provider_is_absent_without_backend() -> None:
    settings = Settings(sandbox_backend="none")

    assert resolve_temporal_sandbox_provider(settings) is None
    assert build_temporal_sandbox_client_provider(settings) is None
    with pytest.raises(ValueError):
        require_temporal_sandbox_provider(settings)


def test_settings_reject_temporal_dispatch_without_sandbox_backend() -> None:
    with pytest.raises(ValidationError):
        Settings(enable_temporal_dispatch=True, sandbox_backend="none")


def test_build_model_provider_uses_azure_client_when_configured() -> None:
    provider = build_model_provider(
        Settings(
            openai_provider="azure",
            azure_openai_endpoint="https://example.openai.azure.com",
            azure_openai_deployment="gpt-5-4-prod",
            azure_openai_api_version="2025-04-01-preview",
            azure_openai_api_key="test-key",
        )
    )

    assert isinstance(provider, OpenAIProvider)
    model = provider.get_model("gpt-5.4")
    assert model.model == "gpt-5.4"
    assert str(model._client.base_url) == (
        "https://example.openai.azure.com/openai/deployments/gpt-5-4-prod/"
    )


def test_build_model_provider_uses_default_openai_when_unset() -> None:
    assert build_model_provider(Settings()) is None
