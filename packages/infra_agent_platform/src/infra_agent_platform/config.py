import os
import re
from collections.abc import Mapping
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

SANDBOX_ENV_PROFILES: dict[str, tuple[str, ...]] = {
    "azure": (
        "ARM_CLIENT_ID",
        "ARM_CLIENT_SECRET",
        "ARM_TENANT_ID",
        "ARM_SUBSCRIPTION_ID",
        "AZURE_CLIENT_ID",
        "AZURE_CLIENT_SECRET",
        "AZURE_TENANT_ID",
        "AZURE_SUBSCRIPTION_ID",
        "AZURE_AUTHORITY_HOST",
    ),
    "github": (
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "GIT_AUTHOR_NAME",
        "GIT_AUTHOR_EMAIL",
        "GIT_COMMITTER_NAME",
        "GIT_COMMITTER_EMAIL",
    ),
}

_ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="INFRA_AGENT_",
        extra="ignore",
    )

    service_name: str = "infra-agents"
    environment: str = "local"
    database_url: str = "sqlite:///./var/infra_agents.db"

    temporal_host: str = "localhost:7233"
    temporal_namespace: str = "default"
    temporal_task_queue: str = "infra-agent-runs"
    temporal_workflow_type: str = "InfraAgentRunWorkflow"
    enable_temporal_dispatch: bool = False

    openai_provider: Literal["openai", "azure"] = "openai"
    openai_model: str = "gpt-5.5"
    openai_model_activity_timeout_seconds: int = Field(default=120, ge=1)
    disable_openai_tracing: bool = False
    azure_openai_base_url: str | None = None
    azure_openai_endpoint: str | None = None
    azure_openai_deployment: str | None = None
    azure_openai_api_version: str | None = None
    azure_openai_api_key: str | None = None
    azure_openai_ad_token: str | None = None

    sandbox_backend: Literal["modal", "docker", "none"] = "modal"
    modal_app_name: str = "infra-agents-sandbox"
    modal_default_timeout_seconds: int = Field(default=900, ge=1)
    modal_sandbox_create_timeout_seconds: float = Field(default=600, ge=1)
    modal_image_ref: str | None = None
    modal_dockerfile: Path | None = Path("docker/sandbox.Dockerfile")
    modal_docker_context_dir: Path = Path(".")
    # Map to MODAL_TOKEN_ID / MODAL_TOKEN_SECRET for the official `modal` client (worker applies).
    modal_token_id: str | None = None
    modal_token_secret: str | None = None
    modal_profile: str | None = None
    modal_config_path: Path | None = None
    docker_image: str = "infra-agents-sandbox:local"
    docker_exposed_ports: str = ""
    sandbox_env_profiles: str = "azure,github"
    sandbox_env_extra_vars: str = ""
    # Deprecated compatibility override. When set, it replaces profiles + extra vars.
    sandbox_env_vars: str | None = None
    git_author_name: str | None = None
    git_author_email: str | None = None
    git_committer_name: str | None = None
    git_committer_email: str | None = None

    var_dir: Path = Path("var")
    api_event_poll_seconds: float = Field(default=0.5, ge=0.1, le=10.0)
    cors_allow_origin_regex: str = r"https?://(localhost|127\.0\.0\.1)(:\d+)?"
    github_app_manifest_base_url: str | None = None
    github_app_manifest_state_secret: str | None = None
    github_app_id: str | None = None
    github_client_id: str | None = None
    github_client_secret: str | None = None
    github_app_slug: str | None = None
    github_webhook_secret: str | None = None
    github_app_private_key: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _empty_modal_tokens_to_none(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        for k in (
            "modal_token_id",
            "modal_token_secret",
            "modal_profile",
            "modal_config_path",
            "modal_image_ref",
            "modal_dockerfile",
            "git_author_name",
            "git_author_email",
            "git_committer_name",
            "git_committer_email",
        ):
            if k in data and data[k] == "":
                data[k] = None
        return data

    @model_validator(mode="after")
    def _validate_dispatch_configuration(self) -> "Settings":
        if self.enable_temporal_dispatch and self.sandbox_backend == "none":
            raise ValueError(
                "enable_temporal_dispatch requires a configured sandbox backend for workflow"
                " execution"
            )
        if self.openai_provider == "azure":
            if self.azure_openai_base_url is None and self.azure_openai_endpoint is None:
                raise ValueError(
                    "openai_provider=azure requires azure_openai_base_url or azure_openai_endpoint"
                )
            if self.azure_openai_base_url is None and self.azure_openai_deployment is None:
                raise ValueError(
                    "openai_provider=azure using azure_openai_endpoint requires"
                    " azure_openai_deployment"
                )
            if self.azure_openai_base_url is None and self.azure_openai_api_version is None:
                raise ValueError(
                    "openai_provider=azure using azure_openai_endpoint requires"
                    " azure_openai_api_version"
                )
            if self.azure_openai_api_key is None and self.azure_openai_ad_token is None:
                raise ValueError(
                    "openai_provider=azure requires azure_openai_api_key or azure_openai_ad_token"
                )
        if (self.modal_token_id is None) != (self.modal_token_secret is None):
            raise ValueError(
                "modal_token_id and modal_token_secret must both be set or both omitted"
                " (or use modal token / ~/.modal.toml only)"
            )
        for value in self.docker_exposed_ports.split(","):
            value = value.strip()
            if not value:
                continue
            try:
                port = int(value)
            except ValueError as exc:
                raise ValueError(
                    "docker_exposed_ports must be a comma-separated list of TCP port numbers"
                ) from exc
            if port < 1 or port > 65535:
                raise ValueError("docker_exposed_ports values must be between 1 and 65535")
        _sandbox_environment_variable_names(self)
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def collect_sandbox_environment(
    settings: Settings,
    environ: Mapping[str, str] | None = None,
) -> dict[str, str]:
    source = os.environ if environ is None else environ
    out: dict[str, str] = {}
    for name in _sandbox_environment_variable_names(settings):
        value = source.get(name)
        if value:
            out[name] = value
    return out


def _sandbox_environment_variable_names(settings: Settings) -> tuple[str, ...]:
    legacy_override = settings.sandbox_env_vars
    if legacy_override is not None:
        return _unique_env_names(_split_csv(legacy_override), field_name="sandbox_env_vars")

    profile_names = [name.lower() for name in _split_csv(settings.sandbox_env_profiles)]
    if "none" in profile_names:
        if len(profile_names) > 1:
            raise ValueError("sandbox_env_profiles cannot combine 'none' with other profiles")
        profile_names = []

    names: list[str] = []
    for profile in profile_names:
        profile_vars = SANDBOX_ENV_PROFILES.get(profile)
        if profile_vars is None:
            known = ", ".join(sorted([*SANDBOX_ENV_PROFILES, "none"]))
            raise ValueError(
                f"unknown sandbox_env_profiles value {profile!r}; expected one of: {known}"
            )
        names.extend(profile_vars)

    names.extend(_split_csv(settings.sandbox_env_extra_vars))
    return _unique_env_names(names, field_name="sandbox environment")


def _split_csv(raw: str) -> list[str]:
    return [value.strip() for value in raw.split(",") if value.strip()]


def _unique_env_names(raw_names: list[str], *, field_name: str) -> tuple[str, ...]:
    names: list[str] = []
    seen: set[str] = set()
    for name in raw_names:
        if not _ENV_NAME_RE.fullmatch(name):
            raise ValueError(f"{field_name} contains invalid environment variable name: {name!r}")
        if name in seen:
            continue
        names.append(name)
        seen.add(name)
    return tuple(names)
