from infra_agent_contracts import AgentRunCreate
from infra_agent_platform.repositories import InMemoryRunRepository


async def seeded_run_repository(prompt: str = "Inspect the workspace") -> InMemoryRunRepository:
    repository = InMemoryRunRepository()
    await repository.create_run(AgentRunCreate(prompt=prompt))
    return repository
