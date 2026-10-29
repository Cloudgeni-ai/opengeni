//! The pointers to a fleet's stored copies, which the service keeps in its
//! store ([ADR 25](../../../docs/adr/0025-pointers-in-the-control-service-and-objects-by-day.md)).
//! [`Pointers`] answers hosts, the service's own changes and the sweep,
//! but only once the pointers hosts of earlier releases kept in the object
//! store were moved in, which [`import`] does once no live host keeps them
//! there any more. Until then it answers that it cannot yet, and they try
//! again.

use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use bytes::Bytes;
use compute_fleet::{HostState, Stamp};
use compute_storage::pointer_store::{Kept, ObjectPointers, PointerStore, Version};
use futures::future::BoxFuture;
use futures::{StreamExt as _, TryStreamExt as _};

use crate::store::{Found, Import, PointerRow, Store, StoreError};

/// How many pointers an import reads from the object store at once.
const READ_AT_ONCE: usize = 16;

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
        }
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
) {
    let mut waiting_for = Vec::new();
    loop {
        match import_once(&*pointers.store, &from, &url).await {
            Ok(Import::Done(imported)) => {
                pointers.imported.store(true, Ordering::Release);
                tracing::info!(
                    from = %imported.from,
                    at_ms = imported.at_ms,
                    "the fleet's pointers are in the service"
                );
                return;
            }
            Ok(Import::Waiting(hosts)) => {
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
    let found: Vec<Found> = futures::stream::iter(names)
        .map(|name| async move {
            let kept = from.read(&name).await?;
            Ok::<_, compute_storage::Error>(kept.map(|kept| Found {
                name,
                owner: kept.owner,
                pointer: kept.pointer.to_vec(),
            }))
        })
        .buffer_unordered(READ_AT_ONCE)
        .try_filter_map(|found| async move { Ok(found) })
        .try_collect()
        .await?;
    let count = found.len();
    let done = store.import_pointers(&found, url, at_ms, seen).await?;
    if matches!(&done, Import::Done(imported) if imported.at_ms == at_ms) {
        tracing::info!(count, "moved the fleet's pointers into the service");
    }
    Ok(done)
}
