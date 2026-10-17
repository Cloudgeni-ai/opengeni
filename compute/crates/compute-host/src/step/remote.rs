//! The steps that move a sandbox's saved copy to and from the object
//! store, or forget it: archive, evict, fetch and forget.

use std::fs;
use std::io;
use std::sync::Arc;

use compute_core::Outcome;
use compute_engine::{Engine, EngineError, ErrorKind};

use super::{
    Archived, Base, Job, archive_receipt, blocking, clear_local, failure, images_of, io_failure,
    learned, pager_learned, state_failure, suspect_error, wake_profile,
};
use crate::image::{Parts, Suspect};
use crate::layout::{remove_if_present, write_atomic};
use crate::state::{Change, Disk, unix_ms_now};
use crate::store::{
    Archive, FetchInto, FetchedMemory, JailedFile, Owned, OwnerEpoch, SavedFiles, SavedImage, Store,
};

impl<E: Engine, S: Store> Job<E, S> {
    pub(super) async fn archive(&mut self) -> Outcome {
        const OP: &str = "archive";
        let images = images_of(&self.paths);
        let image = self.record.image;
        let checked = blocking(move || -> Result<_, Suspect> {
            if !image {
                return Ok(None);
            }
            let Some(image) = images.current_verified()? else {
                return Ok(None);
            };
            let chunks = images.chunk_map(&image)?;
            Ok(Some((image, chunks)))
        })
        .await;
        let memory = match checked {
            Ok(Ok(memory)) => memory,
            Ok(Err(suspect)) => {
                self.quarantine_current(&images_of(&self.paths), &suspect)
                    .await;
                return failure(&suspect_error(OP, suspect));
            }
            Err(error) => return io_failure(OP, error),
        };
        let images = images_of(&self.paths);
        if memory
            .as_ref()
            .is_some_and(|(image, _)| image.meta().remote)
        {
            // Fetched but never woken: the store already holds this image.
            return match self.archived_copy_holds().await {
                Ok(true) => match self.commit(Change::new().archived(true)).await {
                    Ok(()) => Outcome::Done,
                    Err(error) => state_failure(&error),
                },
                Ok(false) => failure(&EngineError::new(
                    ErrorKind::Fatal,
                    OP,
                    "memory image is only partly local and the store no longer holds it",
                )),
                Err(error) => failure(&error),
            };
        }
        let profile = wake_profile(&self.paths);
        // The order the last wake learned, if its pager wrote one.
        let (written, kept) = (pager_learned(&self.paths), profile.clone());
        let memory_len = memory.as_ref().map(|(image, _)| image.meta().memory_len);
        // Only a hint: the archive goes on without it.
        if let Err(error) = blocking(move || learned::take(&written, &kept, memory_len)).await {
            tracing::warn!(id = %self.id, %error, "learned profile not taken");
        }
        let files = SavedFiles {
            disk: JailedFile::new(&self.paths.disk),
            memory: memory.as_ref().map(|(image, chunks)| SavedImage {
                state: images.state(image.generation()),
                memory: images.memory(image.generation()),
                chunks: Some(Arc::new(chunks.0.clone())),
                runtime: image.meta().runtime.clone(),
            }),
            profile: profile.exists().then_some(profile),
        };
        // A number no other archive of this owner has used, even one cut
        // short by a crash: recorded before the store sees it.
        if let Err(error) = self.commit(Change::new().next_save()).await {
            return state_failure(&error);
        }
        let save = self.record.save();
        // The VM stays paused and owned by this step until it returns, and a
        // cancelled archive returns only once nothing is still reading the
        // files, so the disk read here is the disk as it was saved.
        let receipt = match self
            .store
            .archive(self.id, save, &files, &self.cancel)
            .await
        {
            Ok(Archive::Stored(receipt)) => receipt,
            Ok(Archive::Cancelled) => return Outcome::Cancelled,
            // Another archive of this owner got further: this one has
            // nothing to add, and the record stays as it is.
            Ok(Archive::Outdated) => {
                return failure(&EngineError::new(
                    ErrorKind::Transient,
                    OP,
                    "the store holds a later save of this sandbox",
                ));
            }
            Ok(Archive::Fenced { by }) => return self.handed_off(OP, by).await,
            Err(error) => return failure(&error),
        };
        let marker = Archived {
            receipt,
            memory: files.memory.is_some(),
        };
        let written = serde_json::to_vec(&marker)
            .map_err(io::Error::other)
            .and_then(|bytes| write_atomic(&archive_receipt(&self.paths), &bytes));
        if let Err(error) = written {
            return io_failure(OP, error);
        }
        let change = Change::new().archived(true).backed_up(unix_ms_now());
        match self.commit(change).await {
            Ok(()) => Outcome::Done,
            Err(error) => state_failure(&error),
        }
    }

    /// The sandbox belongs to the later owner `by`: removal begins, and
    /// leaves the store's copy as that owner stored it. Nothing more of it
    /// runs here.
    async fn handed_off(&mut self, op: &'static str, by: OwnerEpoch) -> Outcome {
        tracing::warn!(id = %self.id, own = %self.record.owner(), %by, "a later owner holds the sandbox; dropping this host's copy");
        if let Err(error) = self.commit(Change::new().handed_off()).await {
            return state_failure(&error);
        }
        failure(&EngineError::new(
            ErrorKind::Fatal,
            op,
            format!("owner epoch {by} holds the sandbox now"),
        ))
    }

    /// Whether the store still holds the copy the archive receipt names.
    async fn archived_copy_holds(&self) -> Result<bool, EngineError> {
        let Ok(bytes) = fs::read(archive_receipt(&self.paths)) else {
            return Ok(false);
        };
        let Ok(marker) = serde_json::from_slice::<Archived>(&bytes) else {
            return Ok(false);
        };
        self.store.verify(self.id, &marker.receipt).await
    }

    /// Deletes the local copy, but only once the store is confirmed to hold
    /// exactly the copy that was archived from it. The disk is recorded as
    /// remote first: a crash in between leaves files nothing relies on,
    /// never a record that relies on deleted files.
    pub(super) async fn evict(&mut self) -> Outcome {
        const OP: &str = "evict";
        let holds = if self.record.archived {
            self.archived_copy_holds().await
        } else {
            Ok(false)
        };
        match holds {
            Ok(true) => {}
            Ok(false) => {
                // The local files may be the only good copy: keep them, and
                // forget the archive so the next one starts afresh.
                if self.record.archived {
                    let _ = self.commit(Change::new().archived(false)).await;
                }
                return failure(&EngineError::new(
                    ErrorKind::Fatal,
                    OP,
                    "the store does not hold the archived copy; keeping the local one",
                ));
            }
            Err(error) => return failure(&error),
        }
        if let Err(error) = self.commit(Change::new().disk(Disk::Remote)).await {
            return state_failure(&error);
        }
        // The sandbox is remote from here on, whatever happens to the local
        // files: what is left behind is deleted on the next recovery.
        if let Err(error) = clear_local(&self.paths).await {
            tracing::warn!(id = %self.id, %error, "local copy not fully deleted after eviction; recovery finishes it");
        }
        Outcome::Done
    }

    /// Brings the stored copy back: the disk and device state whole, memory
    /// left in the store where it can be paged in, as a new image.
    pub(super) async fn fetch(&mut self) -> Outcome {
        const OP: &str = "fetch";
        let paths = self.paths.clone();
        let scratch = paths.dir.join("fetching");
        let _ = fs::remove_dir_all(&scratch);
        // The store writes a new file, never through whatever an earlier
        // VMM may have left at the disk's path.
        let stale = paths.disk.clone();
        if let Err(error) = blocking(move || remove_if_present(&stale))
            .await
            .and_then(|removed| removed)
        {
            return io_failure(OP, error);
        }
        let into = FetchInto {
            disk: paths.disk.clone(),
            scratch: scratch.clone(),
            profile: wake_profile(&paths),
            memory: self.record.image,
            seed: Some(self.base_image.clone()),
        };
        let fetched = match self.store.fetch(self.id, &into).await {
            Ok(fetched) => fetched,
            Err(error) => {
                let _ = fs::remove_dir_all(&scratch);
                return failure(&error);
            }
        };
        let images = images_of(&paths);
        let memory_len = self.spec.memory_bytes();
        let published = blocking(move || {
            let published = match &fetched {
                FetchedMemory::None => images.clear().map_err(Suspect::from).map(|()| None),
                FetchedMemory::Local {
                    state,
                    memory,
                    runtime,
                } => images
                    .publish_made_by(
                        Parts::Whole {
                            state,
                            memory,
                            len: memory_len,
                        },
                        runtime.as_deref(),
                    )
                    .map(Some),
                FetchedMemory::Remote {
                    state,
                    memory_len,
                    chunks,
                    manifest,
                    prefilled,
                    runtime,
                } => images
                    .publish_made_by(
                        Parts::Remote {
                            state,
                            memory_len: *memory_len,
                            chunks: crate::image::ChunkMap(chunks.clone()),
                            manifest,
                            prefilled: prefilled.as_ref(),
                        },
                        runtime.as_deref(),
                    )
                    .map(Some),
            };
            let _ = fs::remove_dir_all(&scratch);
            published
        })
        .await;
        let outcome = match published {
            Ok(Ok(Some(image))) => {
                let images = images_of(&paths);
                if let Err(error) = images.retire(&image, &[]) {
                    tracing::warn!(id = %self.id, %error, "old memory images not removed");
                }
                Outcome::Done
            }
            Ok(Ok(None)) => Outcome::Done,
            Ok(Err(suspect)) => failure(&suspect_error(OP, suspect)),
            Err(error) => io_failure(OP, error),
        };
        if outcome != Outcome::Done {
            return outcome;
        }
        match self.commit(Change::new().disk(Disk::Local)).await {
            Ok(()) => Outcome::Done,
            Err(error) => state_failure(&error),
        }
    }

    /// Deletes the memory image here and in the store, keeping the files.
    /// The image is unmarked first, so a crash part-way never claims an
    /// image that is gone.
    pub(super) async fn forget(&mut self) -> Outcome {
        const OP: &str = "forget";
        // The image a paused VM's pager reads stays until the pager holds
        // all of it. That wait comes first, so a forget cancelled during it
        // has changed nothing.
        if let Some(live) = self.live.as_ref() {
            match self.settled(live, OP).await {
                None => return Outcome::Cancelled,
                Some(Err(error)) => return failure(&error),
                Some(Ok(())) => {}
            }
        }
        if self.record.image
            && let Err(error) = self.commit(Change::new().image(false)).await
        {
            return state_failure(&error);
        }
        // A paused VM loses the base its next diff would be merged over.
        if let Some(live) = self.live.as_mut() {
            live.memory.base = Base::Unknown;
        }
        let paths = self.paths.clone();
        let cleared = blocking(move || {
            remove_if_present(&paths.snapshot.state)?;
            remove_if_present(&paths.snapshot.memory)?;
            images_of(&paths).clear()
        })
        .await
        .and_then(|cleared| cleared);
        if let Err(error) = cleared {
            return io_failure(OP, error);
        }
        if !self.record.archived {
            return Outcome::Done;
        }
        // Until the new receipt is written, the old one no longer matches
        // the store, so nothing evicts against a copy in flux.
        let receipt = match self.store.forget_memory(self.id, self.record.owner()).await {
            Ok(Owned::Done(Some(receipt))) => receipt,
            Ok(Owned::Done(None)) => {
                return match self.commit(Change::new().archived(false)).await {
                    Ok(()) => Outcome::Done,
                    Err(error) => state_failure(&error),
                };
            }
            Ok(Owned::Fenced { by }) => return self.handed_off(OP, by).await,
            Err(error) => return failure(&error),
        };
        let marker = Archived {
            receipt,
            memory: false,
        };
        let written = serde_json::to_vec(&marker)
            .map_err(io::Error::other)
            .and_then(|bytes| write_atomic(&archive_receipt(&self.paths), &bytes));
        match written {
            Ok(()) => Outcome::Done,
            Err(error) => io_failure(OP, error),
        }
    }
}
