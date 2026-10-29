//! Deletes the chunks and manifests no pointer names any more: those of
//! deleted sandboxes, forgotten memory images and replaced copies. The
//! tombstones deleted sandboxes leave stay for good: only a tombstone tells
//! a write held up in flight, however long, that its sandbox is gone, and
//! one is a few hundred bytes.
//!
//! A sweep reads every pointer, keeping it again so no archive begun
//! earlier can replace it, asks which objects each one names, and deletes
//! the other chunks and manifests whose day ended a whole day before it
//! began ([`crate::fresh::sweepable`]); one of the old layout once it was
//! last stored more than [`LEGACY_SWEEP_AFTER`] before. Deletes carry no
//! condition: nothing writes those names again. [`crate::fresh`] explains
//! why that is safe while archives run. Anything it cannot read stops it
//! before it deletes anything: a pointer it could not read may name
//! objects it would otherwise delete. Keys of a layout it does not know
//! are never deleted.
//!
//! Its memory grows with the number of objects stored, and it writes each
//! pointer once; one sweep covers one store prefix.

use std::collections::HashSet;

use futures::{StreamExt as _, TryStreamExt as _, stream};

use crate::fresh::{LEGACY_SWEEP_AFTER, sweepable};
use crate::store::{Area, ChunkStore, Listed, Stock, Written, written};
use crate::{Error, Result};

/// Pointers read at once.
const READS: usize = 32;
/// Objects deleted at once.
const DELETES: usize = 32;

/// What a sweep found, and did.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct Report {
    /// Pointers kept, counting the empty ones that name nothing (an
    /// archive's start) and tombstones.
    pub pointers: usize,
    /// Tombstones of deleted sandboxes found; a sweep keeps them.
    pub tombstones: usize,
    /// Chunks and manifests some pointer names.
    pub named: usize,
    /// Chunks and manifests stored.
    pub stored: usize,
    pub stored_bytes: u64,
    /// Stored objects no pointer names, stored too recently to delete.
    pub recent: usize,
    /// Stored objects under a key of no layout this build knows: never
    /// deleted.
    pub unknown: usize,
    /// Stored objects no pointer names, stored long enough ago to delete.
    pub unnamed: usize,
    pub unnamed_bytes: u64,
    pub deleted: usize,
    pub deleted_bytes: u64,
}

/// Sweeps `store`. `names` answers which chunk and manifest keys (as
/// [`ChunkRef::key`](crate::chunk::ChunkRef::key) and
/// [`ChunkStore::manifest_key`] give them) the pointer holding the given
/// bytes keeps; [`crate::copy::names`] for sandboxes' stored copies. With
/// `delete` false nothing is deleted or written, and the report says what
/// would be deleted.
pub async fn sweep<F, Fut>(store: &ChunkStore, names: F, delete: bool) -> Result<Report>
where
    F: Fn(Vec<u8>) -> Fut,
    Fut: Future<Output = Result<Vec<String>>>,
{
    let started = store.now();
    let legacy_before = started
        .checked_sub(LEGACY_SWEEP_AFTER)
        .ok_or(Error::Invalid("the clock is earlier than the sweep window"))?;
    // Listed after `started`: a pointer missing from the list was first
    // kept by an archive that began after it.
    let pointers = store.pointer_names().await?;
    let mut report = Report {
        pointers: pointers.len(),
        ..Report::default()
    };
    let names = &names;
    let taken: Vec<(Vec<String>, bool)> = stream::iter(pointers)
        .map(|name| async move {
            // Only a sweep that deletes fences: a look stops no archive.
            let stock = if delete {
                store.fence(&name).await?
            } else {
                store.look(&name).await?
            };
            Ok::<_, Error>(match stock {
                Stock::Holds(bytes) if !bytes.is_empty() => (names(bytes).await?, false),
                Stock::Tombstone => (Vec::new(), true),
                // Deleted since the listing, so what it named may go, or
                // the empty pointer of an archive that has not published.
                Stock::Holds(_) | Stock::Gone => (Vec::new(), false),
            })
        })
        .buffer_unordered(READS)
        .try_collect()
        .await?;
    let mut in_use = Vec::with_capacity(taken.len());
    for (named, tombstone) in taken {
        in_use.push(named);
        report.tombstones += usize::from(tombstone);
    }
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
            let old = match written(&listed.key) {
                Some(Written::On(day)) => sweepable(day, started),
                Some(Written::Legacy) => listed.stored_at < legacy_before,
                None => {
                    report.unknown += 1;
                    continue;
                }
            };
            if old {
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
    let removals: Vec<(bool, u64)> = stream::iter(unnamed)
        .map(|listed| async move {
            let deleted = store.delete(&listed.key).await?;
            Ok::<_, Error>((deleted, listed.size))
        })
        .buffer_unordered(DELETES)
        .try_collect()
        .await?;
    for (deleted, size) in removals {
        if deleted {
            report.deleted += 1;
            report.deleted_bytes += size;
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests;
