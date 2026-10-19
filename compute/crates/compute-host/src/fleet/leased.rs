//! A store that starts no archive once the host's lease has run out.
//!
//! Every write to object storage is fenced by the owner epoch already, so
//! this guards nothing a fence would let through. It keeps a host that is
//! cut off from doing work nobody will use: once its deadline has passed
//! the service may give each of its sandboxes to another host at any
//! moment, and the VMs are frozen, so there is nothing new to archive.
//! Claims, deletes and forgets still go through, because reconciling with
//! the service, which happens before the deadline moves again, needs them,
//! and so do reads. Every method is passed on, the defaulted ones too: a
//! default here would answer for a store that holds the thing.

use std::path::Path;
use std::sync::Arc;

use compute_engine::{CancellationToken, EngineError, ErrorKind};
use compute_storage::store::ChunkStore;

use super::LeaseGate;
use crate::lanes::Lanes;
use crate::protocol::{Id, ImageId};
use crate::store::{
    Archive, Claimed, FetchInto, FetchedMemory, Owned, OwnerEpoch, Receipt, SavedFiles, Stamp,
    Store,
};

/// `S`, refusing to start an archive while `gate` is closed.
#[derive(Debug)]
pub struct Leased<S> {
    store: S,
    gate: LeaseGate,
}

impl<S> Leased<S> {
    /// Wraps `store`.
    pub const fn new(store: S, gate: LeaseGate) -> Self {
        Self { store, gate }
    }
}

impl<S: Store> Store for Leased<S> {
    fn is_configured(&self) -> bool {
        self.store.is_configured()
    }

    async fn archive(
        &self,
        id: Id,
        save: Stamp,
        files: &SavedFiles,
        cancel: &CancellationToken,
    ) -> Result<Archive, EngineError> {
        if !self.gate.is_open() {
            return Err(EngineError::new(
                ErrorKind::Transient,
                "archive",
                "the host's lease has run out: it archives nothing until renewed",
            ));
        }
        self.store.archive(id, save, files, cancel).await
    }

    async fn verify(&self, id: Id, receipt: &Receipt) -> Result<bool, EngineError> {
        self.store.verify(id, receipt).await
    }

    async fn fetch(&self, id: Id, into: &FetchInto) -> Result<FetchedMemory, EngineError> {
        self.store.fetch(id, into).await
    }

    async fn delete(&self, id: Id, own: OwnerEpoch) -> Result<Owned<()>, EngineError> {
        self.store.delete(id, own).await
    }

    async fn claim(&self, id: Id, own: OwnerEpoch) -> Result<Owned<Option<Claimed>>, EngineError> {
        self.store.claim(id, own).await
    }

    async fn disk_len(&self, id: Id) -> Result<Option<u64>, EngineError> {
        self.store.disk_len(id).await
    }

    async fn image_len(&self, image: ImageId) -> Result<Option<u64>, EngineError> {
        self.store.image_len(image).await
    }

    async fn fetch_image(&self, image: ImageId, path: &Path) -> Result<bool, EngineError> {
        self.store.fetch_image(image, path).await
    }

    fn chunks(&self) -> Option<(&ChunkStore, &Arc<Lanes>)> {
        self.store.chunks()
    }

    async fn forget_memory(
        &self,
        id: Id,
        change: Stamp,
    ) -> Result<Owned<Option<Receipt>>, EngineError> {
        self.store.forget_memory(id, change).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet::boot_now;
    use crate::store::Directory;

    #[tokio::test]
    async fn reads_of_stored_images_and_disks_go_through_whether_the_gate_is_open_or_not() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("image.ext4");
        std::fs::write(&file, b"an image").unwrap();
        let directory = Directory::new(dir.path().join("store"));
        let image = directory.put_rootfs(&file).await.unwrap();
        let leased = Leased::new(directory, LeaseGate::new(boot_now()));
        assert!(!leased.gate.is_open());
        assert_eq!(leased.image_len(image).await.unwrap(), Some(8));
        let copy = dir.path().join("copy.ext4");
        assert!(leased.fetch_image(image, &copy).await.unwrap());
        assert_eq!(std::fs::read(&copy).unwrap(), b"an image");
        let id = Id(compute_core::SandboxId(1));
        assert_eq!(leased.disk_len(id).await.unwrap(), None);
    }
}
