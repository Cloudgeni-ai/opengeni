//! Creates naming an image the host does not have yet (ADR 19): it is
//! fetched from the store once, however many creates wait for it, and the
//! creates go on as usual once it is here.
//!
//! The fetch writes the image's file to local disk, so it is booked with
//! the core like any other write first: the store is asked for the file's
//! length, the agent books it, and only then does the fetch start.

use std::sync::Arc;

use compute_core::{DiskSpace, Input};
use compute_engine::{Engine, EngineError};

use crate::protocol::{Id, ImageId, SandboxConfig};
use crate::rootfs::Missing;
use crate::store::{OwnerEpoch, Store};

use super::{Event, HostAgent, HostError, Reply};

/// Inodes a fetch takes: the image's file and its staging name.
const FETCH_INODES: u64 = 2;

/// A fetch of one image and the creates waiting for it.
#[derive(Debug)]
pub(super) struct Fetch {
    /// The name its write is booked under with the core.
    key: Id,
    waiting: Vec<(Id, SandboxConfig, OwnerEpoch, Reply<()>)>,
}

impl Fetch {
    pub(super) fn key(&self) -> Id {
        self.key
    }
}

impl<E: Engine, S: Store> HostAgent<E, S> {
    /// Creates sandbox `id` once the host has `image`, fetching it unless a
    /// fetch already runs. The id is reserved meanwhile.
    pub(super) fn create_after_fetch(
        &mut self,
        image: ImageId,
        id: Id,
        config: SandboxConfig,
        owner: OwnerEpoch,
        reply: Reply<()>,
    ) {
        self.preparing.insert(id.0);
        if let Some(fetch) = self.fetching.get_mut(&image) {
            fetch.waiting.push((id, config, owner, reply));
            return;
        }
        let key = self.spare_name();
        self.fetching.insert(
            image,
            Fetch {
                key,
                waiting: vec![(id, config, owner, reply)],
            },
        );
        let (store, events) = (Arc::clone(&self.store), self.events_tx.clone());
        tokio::spawn(async move {
            let length = store.image_len(image).await;
            let _ = events.send(Event::ImageSized { image, length });
        });
    }

    /// The store told the length of `image`'s file: books the fetch and
    /// starts it, or refuses the creates waiting for it.
    pub(super) fn image_sized(&mut self, image: ImageId, length: Result<Option<u64>, EngineError>) {
        let length = match length {
            Ok(Some(length)) => length,
            Ok(None) => return self.fetch_ended(image, &Err(Missing::Unknown(image).into())),
            Err(error) => {
                let missing = Missing::Failed {
                    image,
                    error: error.to_string(),
                };
                return self.fetch_ended(image, &Err(missing.into()));
            }
        };
        let Some(key) = self.fetching.get(&image).map(Fetch::key) else {
            return;
        };
        // A sparse file of this length takes at most as much as a disk
        // copied from it may.
        let disk = DiskSpace {
            bytes: crate::disk_growth::disk_bound(length, self.allocation_unit),
            inodes: FETCH_INODES,
        };
        if let Some((resource, needed, free)) = self.core.disk_shortage(disk) {
            return self.fetch_ended(
                image,
                &Err(HostError::HostFull {
                    id: key,
                    resource,
                    needed,
                    free,
                }),
            );
        }
        self.input(Input::Writes { key: key.0, disk });
        let (rootfs, store) = (Arc::clone(&self.rootfs), Arc::clone(&self.store));
        let events = self.events_tx.clone();
        tokio::spawn(async move {
            let result = rootfs
                .get(image, &*store)
                .await
                .map(drop)
                .map_err(HostError::from);
            let _ = events.send(Event::ImageFetched { image, result });
        });
    }

    /// The fetch of `image` ended: the creates waiting for it go on, or are
    /// refused with why it failed. What it wrote shows in the next disk
    /// reading.
    pub(super) fn fetch_ended(&mut self, image: ImageId, result: &Result<(), HostError>) {
        let Some(fetch) = self.fetching.remove(&image) else {
            return;
        };
        self.input(Input::Writes {
            key: fetch.key.0,
            disk: DiskSpace::default(),
        });
        if let Err(error) = result {
            tracing::warn!(%image, %error, "creates naming an image could not have it");
        }
        for (id, config, owner, reply) in fetch.waiting {
            self.preparing.remove(&id.0);
            match result {
                // Just fetched, it counts as used now, so it is kept.
                Ok(()) if self.rootfs.has(image) => self.create_fresh(id, config, owner, reply),
                Ok(()) => {
                    let missing = Missing::Failed {
                        image,
                        error: "it was removed again before its creates".into(),
                    };
                    let _ = reply.send(Err(missing.into()));
                }
                Err(error) => {
                    let error = match error {
                        HostError::HostFull {
                            resource,
                            needed,
                            free,
                            ..
                        } => HostError::HostFull {
                            id,
                            resource: *resource,
                            needed: *needed,
                            free: *free,
                        },
                        other => other.clone(),
                    };
                    let _ = reply.send(Err(error));
                }
            }
        }
    }
}
