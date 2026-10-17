//! A store that starts no archive once the host's lease has run out.
//!
//! Every write to object storage is fenced by the owner epoch already, so
//! this guards nothing a fence would let through. It keeps a host that is
//! cut off from doing work nobody will use: once its deadline has passed
//! the service may give each of its sandboxes to another host at any
//! moment, and the VMs are frozen, so there is nothing new to archive.
//! Claims, deletes and forgets still go through, because reconciling with
//! the service, which happens before the deadline moves again, needs them.

use std::sync::Arc;

use compute_engine::{CancellationToken, EngineError, ErrorKind};
use compute_storage::store::ChunkStore;

use super::LeaseGate;
use crate::lanes::Lanes;
use crate::protocol::Id;
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
