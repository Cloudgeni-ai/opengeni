from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from infra_agent_contracts import ArtifactKind


@dataclass(frozen=True)
class ArtifactWrite:
    run_id: UUID
    kind: ArtifactKind
    name: str
    data: bytes
    media_type: str | None = None


@dataclass(frozen=True)
class StoredArtifact:
    uri: str
    size_bytes: int


class FilesystemArtifactStore:
    def __init__(self, root: Path) -> None:
        self._root = root

    def put(self, write: ArtifactWrite) -> StoredArtifact:
        run_root = self._root / str(write.run_id)
        run_root.mkdir(parents=True, exist_ok=True)
        path = run_root / write.name
        path.write_bytes(write.data)
        return StoredArtifact(uri=path.as_uri(), size_bytes=len(write.data))
