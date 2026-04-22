import asyncio

from agents import set_tracing_disabled
from cloud_agent_platform.config import get_settings
from cloud_agent_platform.temporal.worker import build_worker, connect_client


async def amain() -> None:
    settings = get_settings()
    if settings.disable_openai_tracing:
        set_tracing_disabled(True)
    client = await connect_client(settings)
    worker = build_worker(client, settings)
    await worker.run()


def main() -> None:
    asyncio.run(amain())


if __name__ == "__main__":
    main()
