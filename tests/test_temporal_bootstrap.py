import pytest
from agents import OpenAIProvider
from agents.extensions.sandbox.modal import ModalImageSelector, ModalSandboxClient
from agents.sandbox.sandboxes.docker import DockerSandboxClient
from infra_agent_platform.config import Settings, collect_sandbox_environment
from infra_agent_platform.temporal.bootstrap import (
    build_model_provider,
    build_temporal_sandbox_client_provider,
    create_openai_agents_plugin,
    require_temporal_sandbox_provider,
    resolve_temporal_sandbox_provider,
)
from pydantic import ValidationError


@pytest.fixture(autouse=True)
def _clear_infra_agent_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir("/tmp")
    monkeypatch.delenv("INFRA_AGENT_ENABLE_TEMPORAL_DISPATCH", raising=False)
    monkeypatch.delenv("INFRA_AGENT_OPENAI_PROVIDER", raising=False)
    monkeypatch.delenv("INFRA_AGENT_AZURE_OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("INFRA_AGENT_AZURE_OPENAI_ENDPOINT", raising=False)
    monkeypatch.delenv("INFRA_AGENT_AZURE_OPENAI_DEPLOYMENT", raising=False)
    monkeypatch.delenv("INFRA_AGENT_AZURE_OPENAI_API_VERSION", raising=False)
    monkeypatch.delenv("INFRA_AGENT_AZURE_OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("INFRA_AGENT_AZURE_OPENAI_AD_TOKEN", raising=False)
    monkeypatch.delenv("INFRA_AGENT_SANDBOX_ENV_PROFILES", raising=False)
    monkeypatch.delenv("INFRA_AGENT_SANDBOX_ENV_EXTRA_VARS", raising=False)
    monkeypatch.delenv("INFRA_AGENT_SANDBOX_ENV_VARS", raising=False)


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


def test_temporal_sandbox_provider_supports_docker_backend() -> None:
    settings = Settings(sandbox_backend="docker")

    assert resolve_temporal_sandbox_provider(settings) == "docker"
    assert require_temporal_sandbox_provider(settings) == "docker"

    provider = build_temporal_sandbox_client_provider(settings)
    assert provider is not None
    assert provider.name == "docker"
    assert isinstance(provider._client, DockerSandboxClient)


def test_temporal_sandbox_provider_is_absent_without_backend() -> None:
    settings = Settings(sandbox_backend="none")

    assert resolve_temporal_sandbox_provider(settings) is None
    assert build_temporal_sandbox_client_provider(settings) is None
    with pytest.raises(ValueError):
        require_temporal_sandbox_provider(settings)


def test_settings_reject_temporal_dispatch_without_sandbox_backend() -> None:
    with pytest.raises(ValidationError):
        Settings(enable_temporal_dispatch=True, sandbox_backend="none")


@pytest.mark.parametrize("value", ["abc", "3000,-1", "65536"])
def test_settings_reject_invalid_docker_exposed_ports(value: str) -> None:
    with pytest.raises(ValidationError, match="docker_exposed_ports"):
        Settings(sandbox_backend="docker", docker_exposed_ports=value)


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


def test_build_model_provider_uses_azure_base_url_when_configured() -> None:
    provider = build_model_provider(
        Settings(
            openai_provider="azure",
            azure_openai_base_url="https://openai-production-neu.openai.azure.com/openai/v1",
            azure_openai_api_key="test-key",
        )
    )

    assert isinstance(provider, OpenAIProvider)
    model = provider.get_model("gpt-5.4")
    assert model.model == "gpt-5.4"
    assert (
        str(model._client.base_url) == "https://openai-production-neu.openai.azure.com/openai/v1/"
    )
    assert type(model._client).__name__ == "AsyncOpenAI"


def test_collect_sandbox_environment_uses_profiles() -> None:
    settings = Settings(sandbox_env_profiles="github,azure")

    assert collect_sandbox_environment(
        settings,
        {
            "GH_TOKEN": "gh-test",
            "ARM_SUBSCRIPTION_ID": "sub-test",
            "INFRA_AGENT_AZURE_OPENAI_API_KEY": "model-key",
            "UNLISTED_SECRET": "nope",
        },
    ) == {
        "GH_TOKEN": "gh-test",
        "ARM_SUBSCRIPTION_ID": "sub-test",
    }


def test_collect_sandbox_environment_adds_extra_vars() -> None:
    settings = Settings(
        sandbox_env_profiles="github",
        sandbox_env_extra_vars="TF_VAR_region,CUSTOM_PROVIDER_TOKEN",
    )

    assert collect_sandbox_environment(
        settings,
        {
            "GH_TOKEN": "gh-test",
            "TF_VAR_region": "westeurope",
            "CUSTOM_PROVIDER_TOKEN": "provider-test",
            "ARM_SUBSCRIPTION_ID": "not-enabled",
        },
    ) == {
        "GH_TOKEN": "gh-test",
        "TF_VAR_region": "westeurope",
        "CUSTOM_PROVIDER_TOKEN": "provider-test",
    }


def test_collect_sandbox_environment_supports_legacy_explicit_override() -> None:
    settings = Settings(
        sandbox_env_profiles="github,azure",
        sandbox_env_extra_vars="CUSTOM_PROVIDER_TOKEN",
        sandbox_env_vars="GH_TOKEN,ARM_SUBSCRIPTION_ID,MISSING",
    )

    assert collect_sandbox_environment(
        settings,
        {
            "GH_TOKEN": "gh-test",
            "ARM_SUBSCRIPTION_ID": "sub-test",
            "CUSTOM_PROVIDER_TOKEN": "not-enabled",
            "MISSING": "",
        },
    ) == {
        "GH_TOKEN": "gh-test",
        "ARM_SUBSCRIPTION_ID": "sub-test",
    }


def test_sandbox_environment_can_disable_profiles() -> None:
    settings = Settings(sandbox_env_profiles="none")

    assert collect_sandbox_environment(settings, {"GH_TOKEN": "gh-test"}) == {}


def test_sandbox_environment_rejects_unknown_profile() -> None:
    with pytest.raises(ValidationError, match="unknown sandbox_env_profiles value"):
        Settings(sandbox_env_profiles="aws")


def test_sandbox_environment_rejects_invalid_extra_var_name() -> None:
    with pytest.raises(ValidationError, match="invalid environment variable name"):
        Settings(sandbox_env_extra_vars="VALID,INVALID-NAME")
