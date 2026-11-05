//! What a sweep deletes, a piece at a time: what the pointers it read last
//! time named and none names now, and the unnamed objects of each period
//! it lists.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::time::SystemTime;

use futures::{StreamExt as _, TryStreamExt as _, stream};
use tokio::time::{Duration, Instant};

use super::state::{Piece, State};
use super::stock::{Print, Stock, WITHIN, print};
use super::{LISTS, Names, READS, Report, TRIES, tried};
use crate::Result;
use crate::fresh::sweepable;
use crate::store::{Area, ChunkStore, Listed, Written, written};

/// How often a sweep keeps its record while it lists.
const SAVE_EVERY: Duration = Duration::from_secs(2 * 60);

/// How many listed objects a sweep judges, and deletes, at a time: a page
/// of most stores' listings.
const PAGE: usize = 1_000;

/// Begins listing every period again: finds them with one listing by
/// delimiter of each area, and, unless only looking, drops the records of
/// what objects no pointer names now named, which only save a read.
pub(super) async fn audit(
    store: &ChunkStore,
    state: &mut State,
    stock: &Stock,
    started: SystemTime,
    delete: bool,
) -> Result<()> {
    let mut found = BTreeSet::new();
    for area in Area::ALL {
        found.extend(tried("finding the periods stored", || store.periods(area)).await?);
    }
    tracing::info!(periods = found.len(), "sweep: listing every period again");
    state.audit(found, started);
    if !delete {
        return Ok(());
    }
    match store.list_records(WITHIN).await {
        Ok(records) => {
            let named = format!("{WITHIN}/");
            let unused: Vec<String> = records
                .into_iter()
                .filter(|record| {
                    record
                        .strip_prefix(&named)
                        .is_none_or(|key| !stock.within.contains(key))
                })
                .collect();
            if let Err(error) = store.delete_records(&unused).await {
                tracing::warn!(%error, "sweep: could not drop stale records");
            }
        }
        Err(error) => tracing::warn!(%error, "sweep: could not list its records"),
    }
    Ok(())
}

/// Deletes what the pointers the last sweep kept named, and none names
/// now, of periods a sweep may delete from, and what a delete failed for
/// before; and keeps the pointers as they are now for the next. What is
/// too recent is left to the listing of its period.
pub(super) async fn retire<N: Names>(
    store: &ChunkStore,
    names: &N,
    state: &mut State,
    stock: &Stock,
    started: SystemTime,
    delete: bool,
    report: &mut Report,
) {
    let (held, mut versions) = state.held();
    versions.extend(
        held.into_iter()
            .filter(|(name, bytes)| stock.held.get(name) != Some(bytes))
            .map(|(_, bytes)| bytes),
    );
    let (mut candidates, objects, read) = once_named(names, &versions, stock);
    candidates.extend(state.pending.iter().cloned());
    let retired = read_within(names, &versions, &objects, read, &mut candidates).await;
    let mut unnamed = Vec::new();
    for key in &candidates {
        if stock.prints.contains(&print(key)) {
            continue;
        }
        // The old layout's objects, and keys of none this build knows, are
        // left to listings.
        match written(key) {
            Some(Written::On(period)) if sweepable(period, started) => unnamed.push(key.clone()),
            Some(Written::On(_)) => report.recent += 1,
            Some(Written::Legacy) | None => {}
        }
    }
    report.candidates = candidates.len();
    report.unnamed += unnamed.len();
    tracing::info!(
        replaced = versions.len(),
        candidates = candidates.len(),
        unnamed = unnamed.len(),
        "sweep: found what pointers no longer name"
    );
    if !delete {
        return;
    }
    let deleted = store.delete_all(&unnamed).await.unwrap_or_default();
    report.deleted += deleted.len();
    report.retired = deleted.len();
    state.pending = unnamed
        .into_iter()
        .filter(|key| !deleted.contains(key))
        .collect();
    let records: Vec<String> = objects
        .keys()
        .map(|key| format!("{WITHIN}/{key}"))
        .collect();
    if let Err(error) = store.delete_records(&records).await {
        tracing::warn!(%error, "sweep: could not drop records of objects no longer named");
    }
    state.hold(&stock.held, &retired);
}

/// What earlier pointers named, the objects among it naming more no
/// pointer names now, and which of the pointers named each.
type Once<W> = (
    BTreeSet<String>,
    BTreeMap<String, W>,
    HashMap<String, Vec<usize>>,
);

/// What the earlier pointers `versions` named, by their bytes alone, and
/// the objects among them naming more that no pointer names now, with the
/// versions naming each.
fn once_named<N: Names>(names: &N, versions: &[Vec<u8>], stock: &Stock) -> Once<N::Within> {
    let mut candidates = BTreeSet::new();
    let mut objects = BTreeMap::new();
    let mut by: HashMap<String, Vec<usize>> = HashMap::new();
    for (version, bytes) in versions.iter().enumerate() {
        let said = match names.named(bytes) {
            Ok(said) => said,
            Err(error) => {
                tracing::warn!(%error, "sweep: an earlier pointer this build does not read");
                continue;
            }
        };
        candidates.extend(said.keys);
        for (key, object) in said.within {
            candidates.insert(key.clone());
            // One still named names what the stock counted already.
            if !stock.within.contains(&key) {
                by.entry(key.clone()).or_default().push(version);
                objects.entry(key).or_insert(object);
            }
        }
    }
    (candidates, objects, by)
}

/// Adds to `candidates` what `objects` name, read from the store: the
/// versions an object of which could not be read, to try again next time.
async fn read_within<N: Names>(
    names: &N,
    versions: &[Vec<u8>],
    objects: &BTreeMap<String, N::Within>,
    by: HashMap<String, Vec<usize>>,
    candidates: &mut BTreeSet<String>,
) -> Vec<Vec<u8>> {
    let owned: Vec<(String, N::Within)> = objects
        .iter()
        .map(|(key, object)| (key.clone(), object.clone()))
        .collect();
    let read: Vec<(String, Result<Option<Vec<String>>>)> = stream::iter(owned)
        .map(|(key, object)| async move {
            let read = tried("reading what an earlier copy named", || {
                names.within(&object)
            })
            .await;
            (key, read)
        })
        .buffer_unordered(READS)
        .collect()
        .await;
    let mut failed = HashSet::new();
    for (key, read) in read {
        match read {
            Ok(keys) => candidates.extend(keys.into_iter().flatten()),
            // Gone, or bad for good: what it named waits for a full listing.
            Err(error) if error.is_permanent() => {
                tracing::warn!(%error, key, "sweep: an earlier copy's object is unreadable");
            }
            Err(error) => {
                tracing::warn!(%error, key, "sweep: could not read an earlier copy's object; the next sweep tries");
                failed.extend(by.get(&key).into_iter().flatten().copied());
            }
        }
    }
    failed
        .into_iter()
        .map(|version| versions[version].clone())
        .collect()
}

/// How a sweep lists its pieces.
pub(super) struct Listing<'a> {
    pub store: &'a ChunkStore,
    pub prints: &'a HashSet<Print>,
    pub started: SystemTime,
    pub legacy_before: SystemTime,
    pub delete: bool,
}

/// What listing one piece found and did.
#[derive(Debug, Default)]
struct Found {
    stored: usize,
    stored_bytes: u64,
    recent: usize,
    unknown: usize,
    unnamed: usize,
    unnamed_bytes: u64,
    deleted: usize,
    deleted_bytes: u64,
    /// Whether it deleted every unnamed object it found.
    whole: bool,
}

impl Listing<'_> {
    /// Lists what is still to list, newest first, several at once, starting
    /// new pieces until `deadline` (at least one), keeping `state` as it
    /// goes.
    pub async fn all(&self, state: &mut State, deadline: Instant, report: &mut Report) {
        let pieces = state.pieces();
        let mut saved = Instant::now();
        let mut listing = stream::iter(pieces.into_iter().enumerate())
            .take_while(|(at, _)| std::future::ready(*at == 0 || Instant::now() < deadline))
            .map(|(_, piece)| async move {
                let listed = self.one(piece).await;
                (piece, listed)
            })
            .buffer_unordered(LISTS);
        while let Some((piece, listed)) = listing.next().await {
            report.listed += 1;
            match listed {
                Ok(listed) => {
                    // Nothing writes the old layout again, so what of it is
                    // too recent to delete is listed again until it is not.
                    let waits = piece == Piece::Legacy && listed.recent > 0;
                    if !listed.whole {
                        report.failed += 1;
                    } else if !waits {
                        state.settle(piece);
                    }
                    tracing::info!(
                        %piece,
                        stored = listed.stored,
                        unnamed = listed.unnamed,
                        deleted = listed.deleted,
                        left = state.left(),
                        "sweep: listed"
                    );
                    report.stored += listed.stored;
                    report.stored_bytes += listed.stored_bytes;
                    report.recent += listed.recent;
                    report.unknown += listed.unknown;
                    report.unnamed += listed.unnamed;
                    report.unnamed_bytes += listed.unnamed_bytes;
                    report.deleted += listed.deleted;
                    report.deleted_bytes += listed.deleted_bytes;
                }
                Err(error) => {
                    report.failed += 1;
                    tracing::warn!(%error, %piece, "sweep: could not list; the next sweep does");
                }
            }
            if self.delete && saved.elapsed() >= SAVE_EVERY {
                state.save(self.store).await;
                saved = Instant::now();
            }
        }
        drop(listing);
        if self.delete {
            state.save(self.store).await;
        }
    }

    /// Lists `piece`, deleting (unless only looking) what in it no pointer
    /// names and is old enough, a page at a time. A listing that fails is
    /// tried again from after the last page done.
    async fn one(&self, piece: Piece) -> Result<Found> {
        let unders = match piece {
            Piece::Period(period) => Area::ALL
                .iter()
                .map(|area| format!("{}/{period}", area.periodic()))
                .collect(),
            Piece::Legacy => vec!["manifests/v1".to_owned(), "chunks/v1".to_owned()],
        };
        let mut found = Found {
            whole: true,
            ..Found::default()
        };
        for under in unders {
            let mut after = None;
            let mut delay = Duration::from_secs(1);
            let mut tries = 1;
            loop {
                match self.pages(&under, &mut after, &mut found).await {
                    Ok(()) => break,
                    Err(error) if !error.is_permanent() && tries < TRIES => {
                        tracing::warn!(%error, %piece, tries, "sweep: listing again after the last page done");
                        tokio::time::sleep(delay).await;
                        delay *= 4;
                        tries += 1;
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        Ok(found)
    }

    /// Lists what is under `under` after `after`, a page at a time, judging
    /// and deleting each page before the next and moving `after` past it.
    async fn pages(
        &self,
        under: &str,
        after: &mut Option<String>,
        found: &mut Found,
    ) -> Result<()> {
        let mut pages = self
            .store
            .list_after(under, after.as_deref())
            .try_chunks(PAGE);
        while let Some(page) = pages.next().await {
            let page = page.map_err(|failed| failed.1)?;
            let last = page.last().map(|listed| listed.key.clone());
            let before = found.stored;
            self.page(page, found).await?;
            *after = last;
            // A period of many objects says how far it is, every hundred
            // pages or so.
            if before / (100 * PAGE) != found.stored / (100 * PAGE) {
                tracing::info!(
                    under,
                    stored = found.stored,
                    deleted = found.deleted,
                    "sweep: listing"
                );
            }
        }
        Ok(())
    }

    /// Judges the objects of one page, deleting those no pointer names that
    /// are old enough.
    async fn page(&self, page: Vec<Listed>, found: &mut Found) -> Result<()> {
        let mut unnamed = Vec::new();
        let mut sizes = HashMap::new();
        for listed in page {
            found.stored += 1;
            found.stored_bytes += listed.size;
            if self.prints.contains(&print(&listed.key)) {
                continue;
            }
            let old = match written(&listed.key) {
                Some(Written::On(period)) => sweepable(period, self.started),
                Some(Written::Legacy) => listed.stored_at < self.legacy_before,
                None => {
                    found.unknown += 1;
                    continue;
                }
            };
            if old {
                found.unnamed += 1;
                found.unnamed_bytes += listed.size;
                sizes.insert(listed.key.clone(), listed.size);
                unnamed.push(listed.key);
            } else {
                found.recent += 1;
            }
        }
        if self.delete && !unnamed.is_empty() {
            let deleted = self.store.delete_all(&unnamed).await?;
            found.deleted += deleted.len();
            found.deleted_bytes += deleted.iter().filter_map(|key| sizes.get(key)).sum::<u64>();
            found.whole &= deleted.len() == unnamed.len();
        }
        Ok(())
    }
}
