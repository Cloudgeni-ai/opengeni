import asyncio

from agents import set_tracing_disabled
from infra_agent_platform.config import get_settings
from infra_agent_platform.modal_environ import apply_modal_client_environ
from infra_agent_platform.temporal.worker import build_worker, connect_client


async def amain() -> None:
    settings = get_settings()
    # Modal's Python client reads MODAL_TOKEN_* from os.environ; map from Settings first.
    apply_modal_client_environ(settings)
    if settings.disable_openai_tracing:
        set_tracing_disabled(True)
    client = await connect_client(settings)
    worker = build_worker(client, settings)
    await worker.run()


def main() -> None:
    asyncio.run(amain())


if __name__ == "__main__":
    main()
