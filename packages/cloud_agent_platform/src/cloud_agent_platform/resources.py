from dataclasses import dataclass
from typing import Any

from cloud_agent_contracts import ResourceKind, ResourceRef


@dataclass(frozen=True)
class ResourceDescriptor:
    kind: ResourceKind
    uri: str
    metadata: dict[str, Any]


def describe_resource(resource: ResourceRef | None) -> ResourceDescriptor | None:
    if resource is None:
        return None
    return ResourceDescriptor(
        kind=resource.kind,
        uri=resource.uri,
        metadata=dict(resource.metadata),
    )
