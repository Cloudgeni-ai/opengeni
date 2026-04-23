from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="CLOUD_AGENT_",
        extra="ignore",
    )

    service_name: str = "infra-agents"
    environment: str = "local"
    database_url: str = "sqlite:///./var/infra_agents.db"

    temporal_host: str = "localhost:7233"
    temporal_namespace: str = "default"
    temporal_task_queue: str = "cloud-agent-runs"
    temporal_workflow_type: str = "CloudAgentRunWorkflow"
    enable_temporal_dispatch: bool = False

    openai_provider: Literal["openai", "azure"] = "openai"
    openai_model: str = "gpt-5.4-mini"
    openai_model_activity_timeout_seconds: int = Field(default=120, ge=1)
    disable_openai_tracing: bool = False
    azure_openai_base_url: str | None = None
    azure_openai_endpoint: str | None = None
    azure_openai_deployment: str | None = None
    azure_openai_api_version: str | None = None
    azure_openai_api_key: str | None = None
    azure_openai_ad_token: str | None = None

    sandbox_backend: Literal["modal", "none"] = "modal"
    modal_app_name: str = "infra-agents-sandbox"
    modal_default_timeout_seconds: int = Field(default=900, ge=1)
    modal_image_ref: str | None = None
    # Map to MODAL_TOKEN_ID / MODAL_TOKEN_SECRET for the official `modal` client (worker applies).
    modal_token_id: str | None = None
    modal_token_secret: str | None = None
    modal_profile: str | None = None
    modal_config_path: Path | None = None

    var_dir: Path = Path("var")
    api_event_poll_seconds: float = Field(default=0.5, ge=0.1, le=10.0)
    cors_allow_origin_regex: str = (
        r"https?://(localhost|127\.0\.0\.1)(:\d+)?"
    )

    @model_validator(mode="before")
    @classmethod
    def _empty_modal_tokens_to_none(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        for k in ("modal_token_id", "modal_token_secret", "modal_profile", "modal_config_path"):
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
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
