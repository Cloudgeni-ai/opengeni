//! Deletes the chunks and manifests no pointer names any more: those of
//! deleted sandboxes, forgotten memory images and replaced copies.
//!
//! A sweep reads every pointer, storing it again so no archive begun
//! earlier can replace it, asks its owner which objects each one names,
//! and deletes the other chunks and manifests stored more than
//! [`Freshness::sweep_after`](crate::fresh::Freshness::sweep_after) before
//! it began, each only if nothing stored it again since the sweep looked.
//! [`crate::fresh`] explains why that is safe while archives run. Anything
//! it cannot read stops it before it deletes anything: a pointer it could
//! not read may name objects it would otherwise delete.
//!
//! Its memory grows with the number of objects stored, and it writes each
//! pointer once; one sweep covers one store prefix.

use std::collections::HashSet;

use futures::{StreamExt as _, TryStreamExt as _, stream};

use crate::store::{Area, ChunkStore, Listed, Removal};
use crate::{Error, Result};

/// Pointers read at once.
const READS: usize = 32;
/// Objects deleted at once.
const DELETES: usize = 32;

/// What a sweep found, and did.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct Report {
    /// Pointer objects listed, counting the empty ones that name nothing
    /// (an archive's start, or a delete where deletes carry no condition).
    pub pointers: usize,
    /// Chunks and manifests some pointer names.
    pub named: usize,
    /// Chunks and manifests stored.
    pub stored: usize,
    pub stored_bytes: u64,
    /// Stored objects no pointer names, stored too recently to delete.
    pub recent: usize,
    /// Stored objects no pointer names, stored long enough ago to delete.
    pub unnamed: usize,
    pub unnamed_bytes: u64,
    pub deleted: usize,
    pub deleted_bytes: u64,
    /// Old enough when listed, but stored again before the delete.
    pub kept: usize,
}

/// Sweeps `store`. `names` answers which chunk and manifest keys (as
/// [`ChunkRef::key`](crate::chunk::ChunkRef::key) and
/// [`ChunkStore::manifest_key`] give them) the pointer holding the given
/// bytes keeps. With `delete` false nothing is deleted, and the report says
/// what would be. A sweep that deletes is refused before it stores any
/// pointer again where the store cannot delete on condition, as
/// [`ChunkStore::deletes_on_condition`] says, and every sweep is refused
/// over a store holding pointers it cannot read (see
/// [`ChunkStore::refuse_unstamped_pointers`]).
pub async fn sweep<F, Fut>(store: &ChunkStore, names: F, delete: bool) -> Result<Report>
where
    F: Fn(Vec<u8>) -> Fut,
    Fut: Future<Output = Result<Vec<String>>>,
{
    if delete && !store.deletes_on_condition() {
        return Err(Error::Unsupported(
            "deleting stored objects needs a delete on condition (GCS)",
        ));
    }
    store.refuse_unstamped_pointers().await?;
    let started = store.now();
    let before = started
        .checked_sub(store.freshness().sweep_after())
        .ok_or(Error::Invalid("the clock is earlier than the sweep window"))?;
    // Listed after `started`: a pointer missing from the list was first
    // stored by an archive that began after it.
    let pointers = store.list(Area::Pointers).await?;
    let mut report = Report {
        pointers: pointers.len(),
        ..Report::default()
    };
    let names = &names;
    let in_use: Vec<Vec<String>> = stream::iter(pointers)
        .map(|listed| async move {
            // Only a sweep that deletes fences: a look stops no archive.
            let bytes = if delete {
                store.fence(&listed.key).await?
            } else {
                let name =
                    ChunkStore::pointer_name(&listed.key).ok_or(Error::Invalid("pointer key"))?;
                store.get_pointer(name).await?
            };
            match bytes {
                Some(bytes) if !bytes.is_empty() => names(bytes).await,
                // Deleted since the listing, so what it named may go, or
                // the empty pointer of an archive that has not published.
                _ => Ok(Vec::new()),
            }
        })
        .buffer_unordered(READS)
        .try_collect()
        .await?;
    let in_use: HashSet<String> = in_use.into_iter().flatten().collect();
    report.named = in_use.len();

    let mut unnamed: Vec<Listed> = Vec::new();
    for area in [Area::Manifests, Area::Chunks] {
        for listed in store.list(area).await? {
            report.stored += 1;
            report.stored_bytes += listed.size;
            if in_use.contains(&listed.key) {
                continue;
            }
            if listed.stored_at < before {
                report.unnamed += 1;
                report.unnamed_bytes += listed.size;
                unnamed.push(listed);
            } else {
                report.recent += 1;
            }
        }
    }
    if !delete {
        return Ok(report);
    }
    let removals: Vec<(Removal, u64)> = stream::iter(unnamed)
        .map(|listed| async move {
            let removal = store.delete_if_stored_before(&listed.key, before).await?;
            Ok::<_, Error>((removal, listed.size))
        })
        .buffer_unordered(DELETES)
        .try_collect()
        .await?;
    for (removal, size) in removals {
        match removal {
            Removal::Deleted => {
                report.deleted += 1;
                report.deleted_bytes += size;
            }
            Removal::Kept => report.kept += 1,
            Removal::Gone => {}
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests;
