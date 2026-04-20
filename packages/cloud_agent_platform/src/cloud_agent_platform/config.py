from functools import lru_cache
from pathlib import Path
from typing import Literal

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

    openai_model: str = "gpt-5.4-mini"
    openai_model_activity_timeout_seconds: int = Field(default=120, ge=1)

    sandbox_backend: Literal["modal", "none"] = "modal"
    sandbox_provider_name: str | None = None
    modal_app_name: str = "infra-agents-sandbox"
    modal_default_timeout_seconds: int = Field(default=900, ge=1)
    modal_idle_timeout_seconds: int | None = Field(default=300, ge=1)
    modal_image_ref: str | None = None

    var_dir: Path = Path("var")

    @model_validator(mode="before")
    @classmethod
    def _derive_sandbox_provider(cls, values: object) -> object:
        if not isinstance(values, dict):
            return values

        normalized = dict(values)
        backend = normalized.get("sandbox_backend", "modal")
        provider_name = normalized.get("sandbox_provider_name")
        expected_provider = None if backend == "none" else str(backend)

        if provider_name in {None, ""}:
            normalized["sandbox_provider_name"] = expected_provider
            return normalized

        if provider_name != expected_provider:
            raise ValueError(
                "sandbox_provider_name must match sandbox_backend or be omitted for automatic"
                " derivation"
            )

        return normalized

    def require_sandbox_provider_name(self) -> str:
        if self.sandbox_provider_name is None:
            raise ValueError("sandbox backend does not expose a provider name")
        return self.sandbox_provider_name


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
