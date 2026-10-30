//! A sandbox's stored copy as its pointer holds it: the head naming its
//! manifests, and which chunks and manifests it keeps from a sweep. Hosts
//! write copies; a host on its own and a fleet's control service both
//! sweep them, so both read them here.

use serde::{Deserialize, Serialize};

use crate::chunk::ChunkRef;
use crate::manifest::ExtentSource;
use crate::store::ChunkStore;
use crate::{Error, Result};

/// The format copies are written in: manifests named with the day they
/// were stored (`<day>/<digest>`, ADR 25).
pub const VERSION: u32 = 4;

/// The format before, whose manifests are named by their digest alone.
/// Read, never written.
pub const VERSION_DIGESTS: u32 = 3;

/// The manifests that make up one sandbox's stored copy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Head {
    pub version: u32,
    pub disk: String,
    pub memory: Option<MemoryHead>,
    /// The order the guest touched memory after its last wake, stored as
    /// one chunk.
    pub profile: Option<ChunkRef>,
    /// The memory pages at the start of that order, packed for one fetch:
    /// the index chunk of a working-set pack.
    pub pack: Option<ChunkRef>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryHead {
    pub state: String,
    pub memory: String,
    /// The runtime that made the image, if known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
}

impl Head {
    /// The head `bytes` hold, in a format this build reads.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let head: Self = serde_json::from_slice(bytes)?;
        if head.version != VERSION && head.version != VERSION_DIGESTS {
            return Err(Error::Invalid("a stored copy of an unknown version"));
        }
        Ok(head)
    }
}

/// The chunk and manifest keys the copy whose pointer holds `pointer`
/// keeps. Anything unreadable fails, so a sweep stops before deleting what
/// it could not account for; only a damaged or missing working-set pack
/// does not, since a wake without it is just slower.
pub async fn names(store: &ChunkStore, pointer: &[u8]) -> Result<Vec<String>> {
    let head = Head::parse(pointer)?;
    let mut manifests = vec![head.disk];
    // A working-set pack holds memory pages, so it is kept only with the
    // memory image it serves.
    let pack = head.memory.as_ref().and(head.pack.as_ref());
    if let Some(memory) = &head.memory {
        manifests.extend([memory.state.clone(), memory.memory.clone()]);
    }
    let mut names = Vec::new();
    for name in manifests {
        let manifest = store.get_manifest(&name).await?;
        names.push(ChunkStore::manifest_key(&name)?);
        names.extend(
            manifest
                .extents
                .iter()
                .filter_map(|extent| match &extent.source {
                    ExtentSource::Chunk { reference, .. } => Some(reference.key()),
                    ExtentSource::Zero | ExtentSource::Base { .. } => None,
                }),
        );
    }
    names.extend(head.profile.as_ref().map(ChunkRef::key));
    if let Some(index) = pack {
        names.push(index.key());
        match pack_parts(store, index).await {
            Ok(parts) => names.extend(parts.iter().map(ChunkRef::key)),
            Err(error) if error.is_permanent() => {
                tracing::warn!(%error, "working-set pack unreadable; its parts may be swept");
            }
            Err(error) => return Err(error),
        }
    }
    Ok(names)
}

/// What a sweep reads of a working-set pack's index: the chunks of its
/// parts. The host reads the rest.
#[derive(Deserialize)]
struct PackParts {
    parts: Vec<PackPart>,
}

#[derive(Deserialize)]
struct PackPart {
    chunk: ChunkRef,
}

/// The chunks of the parts of the working-set pack whose index is `index`.
pub async fn pack_parts(store: &ChunkStore, index: &ChunkRef) -> Result<Vec<ChunkRef>> {
    let parts: PackParts = serde_json::from_slice(&store.get_chunk(index).await?)?;
    Ok(parts.parts.into_iter().map(|part| part.chunk).collect())
}
