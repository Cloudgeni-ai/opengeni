import base64
from dataclasses import dataclass

from infra_agent_contracts import AgentRun
from temporalio.client import Client
from temporalio.service import RPCError, RPCStatusCode

from infra_agent_platform.config import Settings, collect_sandbox_environment
from infra_agent_platform.errors import DispatchError
from infra_agent_platform.temporal.bootstrap import require_temporal_sandbox_provider
from infra_agent_platform.temporal.contracts import WorkflowRunInput, WorkflowRunProgress

GIT_ASKPASS_PATH = "/usr/local/bin/infra-agent-git-askpass"
REASONING_EFFORTS = {"none", "minimal", "low", "medium", "high", "xhigh"}
FALLBACK_GIT_IDENTITY_NAME = "Infra Agent"
FALLBACK_GIT_IDENTITY_EMAIL = "infra-agent@example.invalid"


@dataclass(frozen=True)
class GitIdentity:
    name: str
    email: str


async def create_github_app_installation_token(
    settings: Settings,
    *,
    installation_id: int,
    repository_ids: tuple[int, ...],
) -> str:
    from infra_agent_platform.github_app import (
        GitHubAppAPIError,
        GitHubAppConfigurationError,
    )
    from infra_agent_platform.github_app import (
        create_github_app_installation_token as create_token,
    )

    try:
        return await create_token(
            settings,
            installation_id=installation_id,
            repository_ids=repository_ids,
        )
    except GitHubAppConfigurationError as exc:
        raise DispatchError(
            f"GitHub App is not configured for selected repositories: {', '.join(exc.missing)}"
        ) from exc
    except GitHubAppAPIError as exc:
        raise DispatchError(f"failed to create GitHub App installation token: {exc}") from exc


async def get_github_app_bot_identity(settings: Settings) -> GitIdentity:
    from infra_agent_platform.github_app import (
        GitHubAppAPIError,
        GitHubAppConfigurationError,
    )
    from infra_agent_platform.github_app import (
        get_github_app_bot_identity as get_bot_identity,
    )

    try:
        identity = await get_bot_identity(settings)
    except GitHubAppConfigurationError:
        return GitIdentity(FALLBACK_GIT_IDENTITY_NAME, FALLBACK_GIT_IDENTITY_EMAIL)
    except GitHubAppAPIError:
        return GitIdentity(FALLBACK_GIT_IDENTITY_NAME, FALLBACK_GIT_IDENTITY_EMAIL)
    except Exception:
        return GitIdentity(FALLBACK_GIT_IDENTITY_NAME, FALLBACK_GIT_IDENTITY_EMAIL)
    return GitIdentity(identity.name, identity.email)


def _parse_exposed_ports(raw: str) -> tuple[int, ...]:
    ports: list[int] = []
    for value in raw.split(","):
        value = value.strip()
        if not value:
            continue
        ports.append(int(value))
    return tuple(ports)


def _coerce_positive_int(value: object) -> int | None:
    if isinstance(value, int) and value > 0:
        return value
    if isinstance(value, str) and value.isdigit():
        parsed = int(value)
        return parsed if parsed > 0 else None
    return None


def _reasoning_effort_for_run(metadata: dict[str, object]) -> str | None:
    value = metadata.get("reasoning_effort")
    if value is None:
        return None
    if isinstance(value, str) and value in REASONING_EFFORTS:
        return value
    raise DispatchError(f"invalid reasoning_effort metadata value: {value!r}")


def _github_app_repo_selection(
    resources: list[dict[str, object]],
) -> tuple[int, tuple[int, ...]] | None:
    installation_id: int | None = None
    repository_ids: set[int] = set()
    for resource in resources:
        if resource.get("kind") != "repository":
            continue
        metadata = resource.get("metadata")
        if not isinstance(metadata, dict):
            continue
        raw_installation_id = metadata.get("github_installation_id")
        raw_repository_id = metadata.get("github_repository_id")
        if raw_installation_id is None and raw_repository_id is None:
            continue
        current_installation_id = _coerce_positive_int(raw_installation_id)
        current_repository_id = _coerce_positive_int(raw_repository_id)
        if current_installation_id is None or current_repository_id is None:
            raise DispatchError(
                "GitHub App repository resources require github_installation_id "
                "and github_repository_id"
            )
        if installation_id is None:
            installation_id = current_installation_id
        elif installation_id != current_installation_id:
            raise DispatchError(
                "selected GitHub App repositories must belong to one installation"
            )
        repository_ids.add(current_repository_id)
    if installation_id is None:
        return None
    return installation_id, tuple(sorted(repository_ids))


async def _git_identity_environment(settings: Settings) -> dict[str, str]:
    default_identity = await get_github_app_bot_identity(settings)
    author_name = (
        settings.git_author_name
        or settings.git_committer_name
        or default_identity.name
    )
    author_email = (
        settings.git_author_email
        or settings.git_committer_email
        or default_identity.email
    )
    committer_name = (
        settings.git_committer_name
        or settings.git_author_name
        or default_identity.name
    )
    committer_email = (
        settings.git_committer_email
        or settings.git_author_email
        or default_identity.email
    )
    return {
        "GIT_AUTHOR_NAME": author_name,
        "GIT_AUTHOR_EMAIL": author_email,
        "GIT_COMMITTER_NAME": committer_name,
        "GIT_COMMITTER_EMAIL": committer_email,
    }


async def _sandbox_environment_for_run(
    settings: Settings,
    resources: list[dict[str, object]],
) -> dict[str, str]:
    environment = collect_sandbox_environment(settings)
    for key, value in (await _git_identity_environment(settings)).items():
        environment.setdefault(key, value)
    selection = _github_app_repo_selection(resources)
    if selection is None:
        return environment

    installation_id, repository_ids = selection
    token = await create_github_app_installation_token(
        settings,
        installation_id=installation_id,
        repository_ids=repository_ids,
    )

    environment.update(
        {
            "GH_TOKEN": token,
            "GITHUB_TOKEN": token,
            "GIT_ASKPASS": GIT_ASKPASS_PATH,
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
            "GIT_CONFIG_VALUE_0": (
                "AUTHORIZATION: basic "
                + base64.b64encode(f"x-access-token:{token}".encode()).decode()
            ),
            "GIT_TERMINAL_PROMPT": "0",
        }
    )
    return environment


class TemporalRunDispatcher:
    def __init__(self, settings: Settings, client: Client | None = None) -> None:
        self._settings = settings
        self._client = client

    async def _client_or_connect(self) -> Client:
        if self._client is not None:
            return self._client
        try:
            self._client = await Client.connect(
                self._settings.temporal_host,
                namespace=self._settings.temporal_namespace,
            )
        except Exception as exc:
            raise DispatchError("failed to connect to Temporal") from exc
        return self._client

    async def dispatch(self, run: AgentRun) -> str:
        workflow_id = f"agent-run-{run.id}"
        resources = [resource.model_dump(mode="json") for resource in run.resources]
        payload = WorkflowRunInput(
            run_id=str(run.id),
            prompt=run.prompt,
            model=self._settings.openai_model,
            reasoning_effort=_reasoning_effort_for_run(run.metadata),
            sandbox_provider=require_temporal_sandbox_provider(self._settings),
            sandbox_app_name=self._settings.modal_app_name,
            sandbox_timeout=self._settings.modal_default_timeout_seconds,
            sandbox_create_timeout=self._settings.modal_sandbox_create_timeout_seconds,
            sandbox_image_ref=(
                self._settings.docker_image
                if self._settings.sandbox_backend == "docker"
                else self._settings.modal_image_ref
            ),
            sandbox_exposed_ports=_parse_exposed_ports(self._settings.docker_exposed_ports),
            sandbox_environment=await _sandbox_environment_for_run(self._settings, resources),
            resources=resources,
            metadata=run.metadata,
        )
        client = await self._client_or_connect()
        try:
            await client.start_workflow(
                self._settings.temporal_workflow_type,
                payload,
                id=workflow_id,
                task_queue=self._settings.temporal_task_queue,
            )
        except Exception as exc:
            raise DispatchError(f"failed to start workflow {workflow_id}") from exc
        return workflow_id

    async def submit_follow_up(self, workflow_id: str, prompt: str) -> None:
        client = await self._client_or_connect()
        handle = client.get_workflow_handle(workflow_id)
        try:
            await handle.signal("submit_follow_up", prompt)
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                raise DispatchError(f"workflow not found: {workflow_id}") from exc
            raise DispatchError(f"failed to signal follow-up for {workflow_id}") from exc
        except Exception as exc:
            raise DispatchError(f"failed to signal follow-up for {workflow_id}") from exc

    async def request_cancel(self, workflow_id: str, reason: str | None = None) -> None:
        client = await self._client_or_connect()
        handle = client.get_workflow_handle(workflow_id)
        try:
            await handle.signal("request_cancel", reason)
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                raise DispatchError(f"workflow not found: {workflow_id}") from exc
            raise DispatchError(f"failed to signal cancellation for {workflow_id}") from exc
        except Exception as exc:
            raise DispatchError(f"failed to signal cancellation for {workflow_id}") from exc

    async def query_progress(self, workflow_id: str) -> WorkflowRunProgress:
        client = await self._client_or_connect()
        handle = client.get_workflow_handle(workflow_id)
        try:
            response = await handle.query("progress", result_type=WorkflowRunProgress)
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                raise DispatchError(f"workflow not found: {workflow_id}") from exc
            raise DispatchError(f"failed to query progress for {workflow_id}") from exc
        except Exception as exc:
            raise DispatchError(f"failed to query progress for {workflow_id}") from exc
        if isinstance(response, WorkflowRunProgress):
            return response
        if isinstance(response, dict):
            try:
                return WorkflowRunProgress(**response)
            except TypeError as exc:
                raise DispatchError(
                    f"workflow {workflow_id} returned invalid progress payload"
                ) from exc
        raise DispatchError(f"workflow {workflow_id} returned invalid progress payload")
