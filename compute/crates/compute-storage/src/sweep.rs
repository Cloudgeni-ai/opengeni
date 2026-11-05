//! Deletes the chunks and manifests no pointer names any more: those of
//! deleted sandboxes, forgotten memory images and replaced copies. The
//! tombstones deleted sandboxes leave stay for good: only a tombstone tells
//! a write held up in flight, however long, that its sandbox is gone, and
//! one is a few hundred bytes.
//!
//! A sweep reads every pointer, keeping it again so no archive begun
//! earlier can replace it, and learns what each one names. It deletes an
//! object only if no pointer names it then and its period ended a clock
//! disagreement before the sweep began ([`crate::fresh::sweepable`]); one
//! of the old layout once it was last stored more than
//! [`LEGACY_SWEEP_AFTER`] before, and the pointers were kept where the
//! sweep reads them for as long. Deletes carry no condition: nothing writes
//! those names again. [`crate::fresh`] explains why that is safe while
//! archives run. Keys of a layout it does not know are never deleted.
//!
//! It does not list everything stored each time (ADR 29). Nothing writes a
//! name of a period a sweep may delete from, so once a sweep has listed
//! such a period, an object in it can become garbage only by a pointer
//! ceasing to name it. Each sweep therefore lists only the periods no
//! sweep has listed since they became sweepable, newest first and for at
//! most [`BUDGET`], leaving the rest to the next; and deletes, of what the
//! pointers it read last time named, what none names now. Once a day it
//! lists every period again, to find what a write held up in flight left
//! behind. What it did it keeps in a record under
//! [`RECORDS`](crate::store::RECORDS), with what each manifest and
//! working-set pack named, so a manifest is read once, not every sweep.
//! Those records only pick what to look at: every delete is judged against
//! what the pointers name now, so a record lost or wrong can leave garbage
//! behind, never take a named object.
//!
//! A sweep that cannot read a pointer, or an object one names, after
//! trying again stops before it deletes anything: what it could not read
//! may name what it would otherwise delete. A period it cannot list, or a
//! delete that fails, is left to the next sweep. It reports its progress
//! as it goes.
//!
//! Its memory grows with the number of keys the pointers name, eight bytes
//! each, and the pointers it keeps; one sweep covers one store prefix.

use std::future::Future;
use std::time::{Duration, SystemTime};

use crate::fresh::LEGACY_SWEEP_AFTER;
use crate::store::ChunkStore;
use crate::{Error, Result};

mod pieces;
mod state;
mod stock;

/// Pointers, and the objects they name, read at once.
const READS: usize = 32;
/// Periods listed at once.
const LISTS: usize = 8;
/// How many times a read or listing is tried before a sweep gives it up.
const TRIES: u32 = 3;

/// How long a sweep keeps starting to list periods before it leaves the
/// rest to the next, so that hourly sweeps do not run into each other.
pub const BUDGET: Duration = Duration::from_secs(40 * 60);

/// How often a sweep lists every period again.
pub const AUDIT_EVERY: Duration = Duration::from_secs(86_400);

/// What a pointer names, as far as its bytes alone tell: the keys of the
/// chunks and manifests it keeps, and the objects among them that name
/// more, each with what [`Names::within`] reads.
#[derive(Clone, Debug)]
pub struct Named<W> {
    pub keys: Vec<String>,
    /// Objects named that keep other objects, by key: content-addressed,
    /// so what one names never changes.
    pub within: Vec<(String, W)>,
}

impl<W> Default for Named<W> {
    fn default() -> Self {
        Self {
            keys: Vec::new(),
            within: Vec::new(),
        }
    }
}

/// Which chunk and manifest keys (as [`ChunkRef::key`](crate::chunk::ChunkRef::key)
/// and [`ChunkStore::manifest_key`] give them) a pointer keeps;
/// [`crate::copy::Copies`] for sandboxes' stored copies.
pub trait Names: Sync {
    /// An object that names more, as [`Named::within`] gives it.
    type Within: Clone + Send + Sync;

    /// What the pointer holding `pointer` names, by its bytes alone.
    ///
    /// # Errors
    ///
    /// When the bytes are not a pointer this build reads.
    fn named(&self, pointer: &[u8]) -> Result<Named<Self::Within>>;

    /// The keys `object` names, read from the store; `None` when it is
    /// unreadable for good and keeps nothing.
    fn within(
        &self,
        object: &Self::Within,
    ) -> impl Future<Output = Result<Option<Vec<String>>>> + Send;
}

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
    /// Objects naming others whose names were read, and those whose names
    /// a record kept from an earlier sweep.
    pub read: usize,
    pub remembered: usize,
    /// Whether this sweep began listing every period again.
    pub audit: bool,
    /// Objects looked at because a pointer named them the sweep before and
    /// may not now, or an earlier delete of them failed.
    pub candidates: usize,
    /// Of those deleted, how many were candidates: found without listing.
    pub retired: usize,
    /// Periods (and the old layout) listed, those that failed and are
    /// listed again by the next sweep, and those still to list.
    pub listed: usize,
    pub failed: usize,
    pub left: usize,
    /// Chunks and manifests in the periods listed.
    pub stored: usize,
    pub stored_bytes: u64,
    /// Objects no pointer names, stored too recently to delete.
    pub recent: usize,
    /// Stored objects under a key of no layout this build knows: never
    /// deleted.
    pub unknown: usize,
    /// Objects no pointer names, stored long enough ago to delete; bytes
    /// as listed (not counting candidates, whose size is not read).
    pub unnamed: usize,
    pub unnamed_bytes: u64,
    pub deleted: usize,
    pub deleted_bytes: u64,
}

/// Sweeps `store` for up to [`BUDGET`]: see [`sweep_within`].
pub async fn sweep<N: Names>(
    store: &ChunkStore,
    names: &N,
    delete: bool,
    pointers_since: SystemTime,
) -> Result<Report> {
    sweep_within(store, names, delete, pointers_since, BUDGET).await
}

/// Sweeps `store`, by what `names` says each pointer keeps, starting to
/// list periods for up to `budget` (at least one). With `delete` false
/// nothing is deleted or written, and the report says what would be
/// deleted.
///
/// `pointers_since` is when the pointers began to be kept where `store`
/// reads them: when a fleet's were moved into its control service. Objects
/// of the old layout, which only pointers from before then name, are kept
/// until [`LEGACY_SWEEP_AFTER`] after it, so a pointer every listing of a
/// store still catching up missed has that long to be adopted before what
/// it names may go.
///
/// # Errors
///
/// When it cannot read its record, a pointer or an object one names, after
/// trying again; it deletes nothing then.
pub async fn sweep_within<N: Names>(
    store: &ChunkStore,
    names: &N,
    delete: bool,
    pointers_since: SystemTime,
    budget: Duration,
) -> Result<Report> {
    let started = store.now();
    let deadline = tokio::time::Instant::now() + budget;
    let legacy_window = started
        .checked_sub(LEGACY_SWEEP_AFTER)
        .ok_or(Error::Invalid("the clock is earlier than the sweep window"))?;
    // Nothing of the old layout goes while the pointers are newer than that.
    let legacy_before = if pointers_since <= legacy_window {
        legacy_window
    } else {
        SystemTime::UNIX_EPOCH
    };
    let loaded = state::State::load(store).await?;
    let due = state::State::due(loaded.as_ref(), started);
    let stock = stock::take(store, names, delete).await?;
    let mut report = Report {
        pointers: stock.pointers,
        tombstones: stock.tombstones,
        named: stock.prints.len(),
        read: stock.read,
        remembered: stock.remembered,
        ..Report::default()
    };
    tracing::info!(
        pointers = report.pointers,
        named = report.named,
        read = report.read,
        remembered = report.remembered,
        "sweep: took stock of every pointer"
    );
    let fresh = loaded.is_none();
    let mut state = loaded.unwrap_or_default();
    if due {
        match pieces::audit(store, &mut state, &stock, started, delete).await {
            Ok(()) => report.audit = true,
            // With nothing listed before, there is nothing to go on.
            Err(error) if fresh => return Err(error),
            Err(error) => {
                tracing::warn!(%error, "sweep: could not begin listing every period; the next sweep tries");
            }
        }
    }
    pieces::retire(
        store,
        names,
        &mut state,
        &stock,
        started,
        delete,
        &mut report,
    )
    .await;
    state.extend(started);
    if delete {
        state.save(store).await;
    }
    let listing = pieces::Listing {
        store,
        prints: &stock.prints,
        started,
        legacy_before,
        delete,
    };
    listing.all(&mut state, deadline, &mut report).await;
    report.left = state.left();
    tracing::info!(
        deleted = report.deleted,
        deleted_bytes = report.deleted_bytes,
        listed = report.listed,
        failed = report.failed,
        left = report.left,
        "sweep: done"
    );
    Ok(report)
}

/// Runs `attempt` up to [`TRIES`] times while it fails in a way that may
/// pass, waiting longer each time.
async fn tried<T, F, Fut>(what: &str, mut attempt: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    let mut delay = Duration::from_secs(1);
    let mut tries = 1;
    loop {
        match attempt().await {
            Err(error) if !error.is_permanent() && tries < TRIES => {
                tracing::warn!(%error, what, tries, "sweep: trying again");
                tokio::time::sleep(delay).await;
                delay *= 4;
                tries += 1;
            }
            result => return result,
        }
    }
}

#[cfg(test)]
mod tests;
