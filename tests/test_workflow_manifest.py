import json
from pathlib import Path

from agents.sandbox import Manifest
from cloud_agent_platform.runtime import build_sandbox_agent
from cloud_agent_platform.temporal.workflows import (
    _normalize_manifest_path_keys,
    _processed_sandbox_manifest,
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
