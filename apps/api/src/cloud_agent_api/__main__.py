import uvicorn
from cloud_agent_platform.config import get_settings

from cloud_agent_api.cli import main as cli_entrypoint


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "cloud_agent_api.app:create_app",
        factory=True,
        host="0.0.0.0",
        port=8000,
        log_level="info" if settings.environment != "test" else "warning",
    )


def cli_main() -> None:
    cli_entrypoint()


if __name__ == "__main__":
    main()
