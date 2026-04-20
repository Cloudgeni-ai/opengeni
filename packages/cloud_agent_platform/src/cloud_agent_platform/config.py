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
    modal_app_name: str = "infra-agents-sandbox"
    modal_default_timeout_seconds: int = Field(default=900, ge=1)
    modal_idle_timeout_seconds: int | None = Field(default=300, ge=1)
    modal_image_ref: str | None = None

    var_dir: Path = Path("var")

    @model_validator(mode="after")
    def _validate_dispatch_configuration(self) -> "Settings":
        if self.enable_temporal_dispatch and self.sandbox_backend == "none":
            raise ValueError(
                "enable_temporal_dispatch requires a configured sandbox backend for workflow"
                " execution"
            )
        return self

@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
