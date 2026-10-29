//! The pointers to a fleet's stored copies, which the service keeps in its
//! store ([ADR 25](../../../docs/adr/0025-pointers-in-the-control-service-and-objects-by-day.md)).
//! [`Pointers`] answers hosts, the service's own changes and the sweep,
//! but only once the pointers hosts of earlier releases kept in the object
//! store were moved in, which [`import`] does once no live host keeps them
//! there any more. Until then it answers that it cannot yet, and they try
//! again.
//!
//! It also tells hosts the fleet's clock ([`Pointers::now_ms`]), the
//! store's: hosts name the day of what they store by it, and a sweep
//! starts by it, so no host's own clock decides what a sweep may delete.

use std::collections::HashSet;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use bytes::Bytes;
use compute_fleet::{HostState, Stamp};
use compute_storage::fresh::{offset_ms, shifted};
use compute_storage::pointer_store::{Kept, ObjectPointers, PointerStore, Version};
use compute_storage::store::SETTLE;
use futures::future::BoxFuture;
use futures::{StreamExt as _, TryStreamExt as _};

use crate::metrics::Metrics;
use crate::store::{Found, Import, PointerRow, Store, StoreError};

/// How many pointers an import reads from the object store at once.
const READ_AT_ONCE: usize = 16;

/// How long a replica goes by its own clock, moved by how far the fleet's
/// was ahead when it last read it, before it reads the fleet's again.
const CLOCK_FOR: Duration = Duration::from_secs(30);

/// How far a replica's clock may be from the fleet's before it warns.
const CLOCK_WARN_MS: i64 = 60_000;

/// Why a pointer was not read or written.
#[derive(Debug, thiserror::Error)]
pub enum Unanswered {
    /// The pointers hosts kept in the object store are not moved in yet.
    #[error("the fleet's pointers are not in the service yet; try again")]
    NotImported,
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// The fleet's pointers in the service's store.
pub struct Pointers<S> {
    store: Arc<S>,
    /// Set once the store says they were imported, which it never unsays.
    imported: AtomicBool,
    /// When this replica last read the fleet's clock, on its monotonic
    /// clock, and how far ahead of its own system clock it was, in
    /// milliseconds.
    compared: Mutex<Option<(Instant, i64)>>,
}

impl<S> fmt::Debug for Pointers<S> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Pointers")
            .field("imported", &self.imported.load(Ordering::Relaxed))
            .finish_non_exhaustive()
    }
}

impl<S: Store> Pointers<S> {
    #[must_use]
    pub fn new(store: Arc<S>) -> Self {
        Self {
            store,
            imported: AtomicBool::new(false),
            compared: Mutex::new(None),
        }
    }

    /// The fleet's clock now, in milliseconds since 1970: the store's,
    /// read again every [`CLOCK_FOR`].
    pub async fn now_ms(&self) -> Result<u64, Unanswered> {
        let compared = *self.compared.lock().unwrap_or_else(PoisonError::into_inner);
        let offset = match compared {
            Some((at, offset)) if at.elapsed() < CLOCK_FOR => offset,
            _ => {
                let asked = SystemTime::now();
                let fleet = self.store.clock_ms().await?;
                let answered = SystemTime::now();
                let midway = asked + answered.duration_since(asked).unwrap_or_default() / 2;
                let offset = offset_ms(fleet, midway);
                if offset.saturating_abs() > CLOCK_WARN_MS {
                    tracing::warn!(
                        offset_ms = offset,
                        "this replica's clock is far from the fleet's (its database's); \
                         hosts and sweeps go by the fleet's"
                    );
                }
                *self.compared.lock().unwrap_or_else(PoisonError::into_inner) =
                    Some((Instant::now(), offset));
                offset
            }
        };
        Ok(millis(shifted(SystemTime::now(), offset)))
    }

    /// Answers whether the fleet's pointers are in the store, asking it
    /// until they are.
    async fn ready(&self) -> Result<(), Unanswered> {
        if self.imported.load(Ordering::Acquire) {
            return Ok(());
        }
        if self.store.pointers_imported().await?.is_none() {
            return Err(Unanswered::NotImported);
        }
        self.imported.store(true, Ordering::Release);
        Ok(())
    }

    /// Pointer `name`, or `None` when there is none.
    pub async fn read(&self, name: &str) -> Result<Option<PointerRow>, Unanswered> {
        self.ready().await?;
        Ok(self.store.pointer(name).await?)
    }

    /// Keeps `pointer` under `owner` as `name` only if it is still version
    /// `on` (with `None`, only if there is none): the version it is kept as,
    /// or `None` when it changed meanwhile.
    pub async fn write(
        &self,
        name: &str,
        owner: Stamp,
        pointer: &[u8],
        on: Option<i64>,
    ) -> Result<Option<i64>, Unanswered> {
        self.ready().await?;
        Ok(self.store.write_pointer(name, owner, pointer, on).await?)
    }
}

/// `at` in milliseconds since 1970.
fn millis(at: SystemTime) -> u64 {
    at.duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

fn storage(error: &Unanswered) -> compute_storage::Error {
    compute_storage::Error::Transfer(error.to_string())
}

impl<S: Store> PointerStore for Pointers<S> {
    fn read<'a>(&'a self, name: &'a str) -> BoxFuture<'a, compute_storage::Result<Option<Kept>>> {
        Box::pin(async move {
            let row = Pointers::read(self, name)
                .await
                .map_err(|error| storage(&error))?;
            Ok(row.map(|row| Kept {
                owner: row.owner,
                pointer: Bytes::from(row.pointer),
                version: Version::Row(row.version),
            }))
        })
    }

    fn write<'a>(
        &'a self,
        name: &'a str,
        owner: Stamp,
        pointer: Bytes,
        on: Option<&'a Version>,
    ) -> BoxFuture<'a, compute_storage::Result<Option<Version>>> {
        Box::pin(async move {
            let on = match on {
                None => None,
                Some(Version::Row(version)) => Some(*version),
                Some(Version::Object { .. }) => {
                    return Err(compute_storage::Error::Invalid(
                        "an object's version names no pointer the service keeps",
                    ));
                }
            };
            let kept = Pointers::write(self, name, owner, &pointer, on)
                .await
                .map_err(|error| storage(&error))?;
            Ok(kept.map(Version::Row))
        })
    }

    fn names(&self) -> BoxFuture<'_, compute_storage::Result<Vec<String>>> {
        Box::pin(async move {
            self.ready().await.map_err(|error| storage(&error))?;
            self.store
                .pointer_names()
                .await
                .map_err(|error| storage(&error.into()))
        })
    }
}

/// Moves the fleet's pointers from `from`, the object store the service
/// names `url`, into the store once no live or draining host keeps its
/// pointers there, trying every `every` until that is done; from then on
/// `pointers` answers. Every replica may run it: the store imports once.
pub async fn import<S: Store>(
    pointers: Arc<Pointers<S>>,
    from: ObjectPointers,
    url: String,
    every: Duration,
    metrics: Arc<Metrics>,
) {
    let mut waiting_for = Vec::new();
    loop {
        match import_once(&*pointers.store, &from, &url).await {
            Ok(Import::Done(imported)) => {
                pointers.imported.store(true, Ordering::Release);
                metrics.pointers(true, 0);
                tracing::info!(
                    from = %imported.from,
                    at_ms = imported.at_ms,
                    "the fleet's pointers are in the service"
                );
                return;
            }
            Ok(Import::Waiting(hosts)) => {
                metrics.pointers(false, hosts.len());
                if hosts != waiting_for {
                    tracing::warn!(
                        ?hosts,
                        "the fleet's pointers stay in the object store, and nothing is \
                         archived, while these hosts of an earlier release keep theirs there"
                    );
                    waiting_for = hosts;
                }
            }
            Err(error) => {
                tracing::warn!(%error, "moving the fleet's pointers into the service failed; trying again");
            }
        }
        tokio::time::sleep(every).await;
    }
}

/// Imports once if it can; reads the object store only once no host
/// seems to keep its pointers there, and the store checks that again,
/// and that no such host changed since it was seen.
async fn import_once<S: Store>(
    store: &S,
    from: &ObjectPointers,
    url: &str,
) -> anyhow::Result<Import> {
    if let Some(imported) = store.pointers_imported().await? {
        return Ok(Import::Done(imported));
    }
    let hosts = store.hosts_changed(0).await?;
    let seen = hosts.iter().map(|host| host.changed).max().unwrap_or(0);
    let waiting: Vec<String> = hosts
        .into_iter()
        .filter(|host| host.state != HostState::Lost && !host.capacity.pointers_in_service)
        .map(|host| host.info.name)
        .collect();
    if !waiting.is_empty() {
        return Ok(Import::Waiting(waiting));
    }
    let at_ms = u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis(),
    )?;
    // Marked before it is read: a sweep by the pointers left there, which
    // nothing updates from now on, would delete what the service's name.
    from.mark_moved(at_ms).await?;
    let names = from.names().await?;
    let found = read_listed(names, SETTLE, |name| async move { from.read(&name).await }).await?;
    let count = found.len();
    let done = store.import_pointers(&found, url, at_ms, seen).await?;
    if matches!(&done, Import::Done(imported) if imported.at_ms == at_ms) {
        tracing::info!(count, "moved the fleet's pointers into the service");
    }
    Ok(done)
}

/// Reads every pointer of `names`, which an object store listed, with
/// `read`. Nothing removes a pointer from an object store, so one listed
/// that reads as not there is on a store still catching up: it is read
/// again for up to `settle`, and if it is still not there the whole read
/// fails, to be tried again, since leaving it out would leave what it
/// names to a sweep.
async fn read_listed<F, Fut>(
    names: Vec<String>,
    settle: Duration,
    read: F,
) -> anyhow::Result<Vec<Found>>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = compute_storage::Result<Option<Kept>>>,
{
    let read = &read;
    futures::stream::iter(names)
        .map(|name| async move {
            let started = tokio::time::Instant::now();
            let mut delay = Duration::from_millis(100);
            loop {
                if let Some(kept) = read(name.clone()).await? {
                    return Ok(Found {
                        name,
                        owner: kept.owner,
                        pointer: kept.pointer.to_vec(),
                    });
                }
                let left = settle.saturating_sub(started.elapsed());
                anyhow::ensure!(
                    !left.is_zero(),
                    "the object store listed pointer {name} but does not have it"
                );
                tokio::time::sleep(delay.min(left)).await;
                delay = (delay * 2).min(Duration::from_secs(10));
            }
        })
        .buffer_unordered(READ_AT_ONCE)
        .try_collect()
        .await
}

/// Keeps every pointer `from` still holds from before the import that the
/// store has none of, as the import would have: one an import missed, on
/// an object store that listed or read it late. A pointer the store keeps
/// wins, and nothing removes one, so a name it lacks was never moved in;
/// nothing writes to `from` any more, so what it holds is what an earlier
/// release last wrote. A sweep adopts before it fences, so it never
/// deletes what such a pointer names. Answers the names adopted.
///
/// # Errors
///
/// When the store or the object store fails, or a listed pointer is not
/// there.
pub async fn adopt<S: Store>(store: &S, from: &ObjectPointers) -> anyhow::Result<Vec<String>> {
    let missing = missed(store, from).await?;
    if missing.is_empty() {
        return Ok(Vec::new());
    }
    let found = read_listed(
        missing,
        SETTLE,
        |name| async move { from.read(&name).await },
    )
    .await?;
    let adopted = store.adopt_pointers(&found).await?;
    let names: Vec<String> = found.into_iter().map(|found| found.name).collect();
    tracing::warn!(
        adopted,
        ?names,
        "kept pointers the object store held from before the import that the service \
         did not have: an import missed them"
    );
    Ok(names)
}

/// The names of the pointers `from` holds from before the import that the
/// store has none of, which [`adopt`] would keep.
///
/// # Errors
///
/// When the store or the object store fails.
pub async fn missed<S: Store>(store: &S, from: &ObjectPointers) -> anyhow::Result<Vec<String>> {
    let kept: HashSet<String> = store.pointer_names().await?.into_iter().collect();
    Ok(from
        .names()
        .await?
        .into_iter()
        .filter(|name| !kept.contains(name))
        .collect())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use compute_fleet::OwnerEpoch;
    use object_store::memory::InMemory;
    use object_store::path::Path;

    use super::*;
    use crate::store::MemoryStore;

    fn stamp(epoch: u64, save: u64) -> Stamp {
        Stamp {
            epoch: OwnerEpoch(epoch),
            save,
        }
    }

    fn kept(pointer: &'static [u8]) -> Kept {
        Kept {
            owner: stamp(1, 1),
            pointer: Bytes::from_static(pointer),
            version: Version::Row(1),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_listed_pointer_read_as_not_there_is_read_again_and_never_left_out() {
        // A store catching up: the pointer reads as not there twice, then
        // is there.
        let reads = AtomicUsize::new(0);
        let found = read_listed(vec!["s-1".into()], SETTLE, |_| {
            let read = reads.fetch_add(1, Ordering::Relaxed);
            async move { Ok((read >= 2).then(|| kept(b"late"))) }
        })
        .await
        .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].pointer, b"late");
        assert_eq!(reads.load(Ordering::Relaxed), 3);

        // One that never turns up fails the whole read, once the settle
        // ran out, rather than leave it out.
        let started = tokio::time::Instant::now();
        let failed = read_listed(
            vec!["s-1".into(), "s-gone".into()],
            SETTLE,
            |name| async move { Ok((name == "s-1").then(|| kept(b"here"))) },
        )
        .await;
        let error = failed
            .expect_err("a listed pointer was left out")
            .to_string();
        assert!(error.contains("s-gone"), "{error}");
        assert!(started.elapsed() >= SETTLE);
    }

    #[tokio::test]
    async fn a_pointer_the_import_missed_is_adopted_and_a_kept_one_wins() {
        let from = ObjectPointers::new(Arc::new(InMemory::new()), Path::from("fleet"));
        for (name, pointer) in [("s-kept", &b"older"[..]), ("s-missed", b"missed")] {
            from.write(name, stamp(1, 1), Bytes::from_static(pointer), None)
                .await
                .unwrap()
                .expect("created");
        }
        let store = MemoryStore::new();
        let version = store
            .write_pointer("s-kept", stamp(5, 2), b"newer", None)
            .await
            .unwrap()
            .expect("created");

        assert_eq!(missed(&store, &from).await.unwrap(), vec!["s-missed"]);
        assert_eq!(adopt(&store, &from).await.unwrap(), vec!["s-missed"]);
        let adopted = store.pointer("s-missed").await.unwrap().expect("adopted");
        assert_eq!(
            (adopted.owner, adopted.pointer.as_slice()),
            (stamp(1, 1), &b"missed"[..])
        );
        assert_eq!(
            store.pointer("s-kept").await.unwrap(),
            Some(PointerRow {
                owner: stamp(5, 2),
                pointer: b"newer".to_vec(),
                version,
            })
        );
        assert!(
            adopt(&store, &from).await.unwrap().is_empty(),
            "adopted once"
        );
    }

    #[tokio::test]
    async fn the_fleets_clock_is_the_stores() {
        let pointers = Pointers::new(Arc::new(MemoryStore::new()));
        let now = millis(SystemTime::now());
        let fleet = pointers.now_ms().await.unwrap();
        assert!(fleet.abs_diff(now) < 5_000, "{fleet} {now}");
        // Read again within the window, the offset is reused.
        assert!(pointers.now_ms().await.unwrap() >= fleet);
    }
}
