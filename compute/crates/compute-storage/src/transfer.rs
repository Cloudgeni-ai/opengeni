//! Copies a store's stored copies to another object store, for moving an
//! archive from one store to another: every chunk and manifest a pointer
//! keeps, as [`crate::copy::parts`] names them, under the same keys. The
//! pointers stay where they are kept (with a fleet, in its control service,
//! ADR 25), so once hosts and the service are pointed at the new store they
//! read the same names there.
//!
//! What the new store holds already is not copied again: a copy that
//! stopped goes on where it was, and a second copy finds only what was
//! stored since the first. So copy while hosts still archive to the old
//! store, then once more after archives stop, before switching. Each
//! object is checked against its name as it is read and stored as an
//! archive stores it, verified in transit; the store copied from is only
//! read. What no pointer names, which a sweep would delete, stays behind,
//! as do quarantined copies and the pointers an object store kept.
//!
//! A pointer whose copy cannot be read, or an object that cannot be
//! copied, is reported and the rest is copied, so the report says what is
//! missing before anyone switches stores.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures::{StreamExt as _, stream};

use crate::copy::{Part, parts};
use crate::store::{Area, ChunkStore, Stock};
use crate::{Error, Result};

/// Pointers read at once.
const READS: usize = 16;

/// How many objects copied between two progress lines in the log.
const PROGRESS_EVERY: usize = 10_000;

/// What a copy found, and did.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct Report {
    /// Pointers read, counting tombstones and the empty ones that name
    /// nothing.
    pub pointers: usize,
    pub tombstones: usize,
    /// Chunks and manifests the pointers keep, each counted once.
    pub named: usize,
    /// Of those, the ones the new store held already.
    pub present: usize,
    pub copied: usize,
    pub copied_bytes: u64,
    /// Pointers whose stored copy could not be read: what they keep is
    /// copied only where another pointer keeps it too.
    pub unreadable: Vec<Unread>,
    /// Objects that could not be copied.
    pub failed: Vec<Unread>,
}

impl Report {
    /// Whether the new store holds everything the pointers keep.
    #[must_use]
    pub fn complete(&self) -> bool {
        self.unreadable.is_empty() && self.failed.is_empty()
    }
}

/// A pointer or object a copy could not read or copy, and why.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Unread {
    pub name: String,
    pub error: String,
}

/// Copies to `to` every chunk and manifest a pointer of `from` keeps that
/// `to` does not hold yet, `at_once` objects at a time (at least one).
/// Pointers are read from wherever `from` keeps them
/// ([`ChunkStore::with_pointers`]); `to`'s are neither read nor written.
///
/// # Errors
///
/// When the pointers or the new store's listing cannot be read. A pointer
/// or object that cannot be read or copied is reported instead.
pub async fn copy(from: &ChunkStore, to: &ChunkStore, at_once: usize) -> Result<Report> {
    // Listed first: what an archive stores in `to` meanwhile is copied
    // again, which writes the same bytes.
    let mut held: HashMap<String, u64> = HashMap::new();
    for area in [Area::Manifests, Area::Chunks] {
        held.extend(
            to.list(area)
                .await?
                .into_iter()
                .map(|listed| (listed.key, listed.size)),
        );
    }

    let pointers = from.pointer_names().await?;
    let mut report = Report {
        pointers: pointers.len(),
        ..Report::default()
    };
    let read: Vec<(String, Result<Option<Vec<Part>>>)> = stream::iter(pointers)
        .map(|name| async move {
            let kept = async {
                Ok::<_, Error>(match from.look(&name).await? {
                    Stock::Holds(bytes) if !bytes.is_empty() => Some(parts(from, &bytes).await?),
                    Stock::Tombstone => None,
                    // Deleted since the listing, or an archive's start.
                    Stock::Holds(_) | Stock::Gone => Some(Vec::new()),
                })
            }
            .await;
            (name, kept)
        })
        .buffer_unordered(READS)
        .collect()
        .await;
    let mut named: HashMap<String, Part> = HashMap::new();
    for (name, kept) in read {
        match kept {
            Ok(Some(kept)) => {
                for part in kept {
                    named.insert(part.key()?, part);
                }
            }
            Ok(None) => report.tombstones += 1,
            Err(error) => report.unreadable.push(Unread {
                name,
                error: error.to_string(),
            }),
        }
    }
    report.named = named.len();

    let missing: Vec<(String, Part)> = named
        .into_iter()
        .filter(|(key, part)| match (held.get(key), part) {
            (None, _) => true,
            // A chunk of another length is not the chunk: copied over,
            // after the bytes there are kept in quarantine.
            (Some(size), Part::Chunk(reference)) => *size != u64::from(reference.stored_len),
            (Some(_), Part::Manifest(_)) => false,
        })
        .collect();
    report.present = report.named - missing.len();

    let total = missing.len();
    let done = AtomicUsize::new(0);
    let done = &done;
    let mut report = stream::iter(missing)
        .map(|(key, part)| async move {
            let copied = async {
                let bytes = match &part {
                    Part::Manifest(name) => from.get_stored_manifest(name).await?,
                    Part::Chunk(reference) => from.get_stored_chunk(reference).await?,
                };
                let size = bytes.len() as u64;
                to.put_stored(&key, bytes).await?;
                Ok::<_, Error>(size)
            }
            .await;
            let finished = done.fetch_add(1, Ordering::Relaxed) + 1;
            if finished.is_multiple_of(PROGRESS_EVERY) {
                tracing::info!(finished, total, "copying the archive");
            }
            (key, copied)
        })
        .buffer_unordered(at_once.max(1))
        .fold(report, |mut report, (key, copied)| async move {
            match copied {
                Ok(size) => {
                    report.copied += 1;
                    report.copied_bytes += size;
                }
                Err(error) => report.failed.push(Unread {
                    name: key,
                    error: error.to_string(),
                }),
            }
            report
        })
        .await;
    report.unreadable.sort_by(|a, b| a.name.cmp(&b.name));
    report.failed.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(report)
}

#[cfg(test)]
mod tests;
