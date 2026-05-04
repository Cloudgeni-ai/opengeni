import json
from pathlib import Path

from agents.sandbox import Manifest
from infra_agent_platform.runtime import build_sandbox_agent
from infra_agent_platform.temporal.contracts import WorkflowRunInput
from infra_agent_platform.temporal.workflows import (
    _manifest_with_repository_resources,
    _normalize_manifest_path_keys,
    _processed_sandbox_manifest,
    _sandbox_options_for_request,
)


def test_rehydrated_manifest_recovers_path_keys() -> None:
    """Simulate Temporal: JSON deserializing manifest may turn .agents key into a str."""
    agent = build_sandbox_agent(model="gpt-5.4-mini")
    raw = _processed_sandbox_manifest(agent)
    assert raw is not None
    payload = json.loads(json.dumps(raw.model_dump(mode="json")))
    m2 = Manifest.model_validate(payload)
    # JSON has string keys, so the SDK will not see `.agents` with a `Path` lookup.
    assert m2.entries.get(Path(".agents")) is None
    assert m2.entries.get(".agents") is not None
    norm = _normalize_manifest_path_keys(m2)
    assert norm.entries.get(Path(".agents")) is not None
    k = next(iter(norm.entries))
    assert k == Path(".agents")


def test_repository_resources_merge_into_processed_manifest() -> None:
    agent = build_sandbox_agent(model="gpt-5.4-mini")
    raw = _processed_sandbox_manifest(agent)
    assert raw is not None
    manifest = _manifest_with_repository_resources(
        _normalize_manifest_path_keys(raw),
        [
            {
                "kind": "repository",
                "uri": "https://github.com/cloudgeni-ai/infra-agents.git",
                "metadata": {
                    "host": "github.com",
                    "repo": "cloudgeni-ai/infra-agents",
                    "ref": "main",
                    "subpath": None,
                    "mount_path": "repos/cloudgeni-ai/infra-agents",
                },
            },
            {
                "kind": "repository",
                "uri": "https://git.example.com/platform/modules.git",
                "metadata": {
                    "host": "git.example.com",
                    "repo": "platform/modules",
                    "ref": "v1",
                    "subpath": "terraform",
                    "mount_path": "repos/platform/modules",
                },
            },
        ],
    )

    assert manifest is not None
    assert manifest.entries.get(Path(".agents")) is not None
    first = manifest.entries[Path("repos/cloudgeni-ai/infra-agents")]
    second = manifest.entries[Path("repos/platform/modules")]
    assert first.type == "git_repo"
    assert first.host == "github.com"
    assert first.repo == "cloudgeni-ai/infra-agents"
    assert first.ref == "main"
    assert second.subpath == "terraform"


def test_sandbox_options_follow_provider() -> None:
    modal = _sandbox_options_for_request(
        WorkflowRunInput(
            run_id="run-1",
            prompt="Inspect",
            model="gpt-5.4-mini",
            sandbox_provider="modal",
            sandbox_app_name="infra-agents",
            sandbox_timeout=123,
        )
    )
    docker = _sandbox_options_for_request(
        WorkflowRunInput(
            run_id="run-2",
            prompt="Inspect",
            model="gpt-5.4-mini",
            sandbox_provider="docker",
            sandbox_image_ref="infra-agents-sandbox:local",
            sandbox_exposed_ports=(3000,),
        )
    )

    assert modal.type == "modal"
    assert modal.app_name == "infra-agents"
    assert modal.timeout == 123
    assert docker.type == "docker"
    assert docker.image == "infra-agents-sandbox:local"
    assert docker.exposed_ports == (3000,)


def test_docker_sandbox_options_default_to_local_image() -> None:
    docker = _sandbox_options_for_request(
        WorkflowRunInput(
            run_id="run-3",
            prompt="Inspect",
            model="gpt-5.4-mini",
            sandbox_provider="docker",
        )
    )

    assert docker.type == "docker"
    assert docker.image == "infra-agents-sandbox:local"
