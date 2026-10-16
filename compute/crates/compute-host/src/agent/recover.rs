//! Taking over a state root after a restart: every recorded sandbox is
//! adopted, put back to sleep or blocked, never forgotten.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use compute_core::{Durability, Input, Level, SandboxId, State};
use compute_engine::{Engine, EngineError, ErrorKind, Found, VmSpec};
use futures::StreamExt;

use crate::layout::{Images, Paths, vm_spec};
use crate::protocol::Id;
use crate::state::{Change, Disk, Record, StateError, Stray};
use crate::step::{DiskWatch, LiveMemory, Reconnected};
use crate::store::Store;

use super::{HostAgent, HostError};

/// A VM found still running after an agent restart, with what it is doing
/// and, if its memory is paged, the agent's side of its pager.
type FoundVm<E> = (<E as Engine>::Vm, Found, Option<Reconnected>);

/// For a VM found running that recovery leaves as it is, blocked: the
/// memory its pager still misses keeps coming, so its guest never waits
/// forever on a page.
fn keep_serving<E: Engine>(found: Result<Option<FoundVm<E>>, HostError>) {
    if let Ok(Some((_, _, Some(memory)))) = found {
        memory.serve_detached();
    }
}

impl<E: Engine, S: Store> HostAgent<E, S> {
    pub(super) async fn recover(&mut self, strays: Vec<Stray>) {
        for stray in strays {
            let dir = Paths::new(&self.root, stray.id).dir;
            match stray.problem {
                // Creation never finished or removal nearly had: nothing was
                // promised, and no VM runs without a record.
                None => {
                    if let Err(error) = self.remove_network(stray.id).await {
                        tracing::warn!(id = %stray.id, %error, "could not remove an unrecorded sandbox's network");
                    }
                    if let Err(error) = tokio::fs::remove_dir_all(&dir).await {
                        tracing::warn!(id = %stray.id, %error, "could not tidy an unrecorded sandbox");
                        self.block(
                            stray.id,
                            format!("unrecorded directory left behind: {error}"),
                        );
                        // Removing the id again retries.
                        self.leftovers.insert(stray.id.0, None);
                    }
                }
                Some(problem) => {
                    // Its VM may still run as the user its ordinal names,
                    // behind the host link its ordinal names: no other
                    // sandbox may get that ordinal.
                    let ordinal = self.unreadable_ordinal(stray.id).await;
                    match ordinal {
                        Some(ordinal) => {
                            self.ordinals.insert(ordinal);
                        }
                        // Any new sandbox could get it: none is created
                        // until someone resolves this one.
                        None => {
                            self.unknown_ordinals.insert(stray.id.0);
                        }
                    }
                    tracing::error!(id = %stray.id, %problem, ?ordinal, "unreadable record; blocking the id and leaving the sandbox alone");
                    self.block(stray.id, problem.to_string());
                }
            }
        }
        let mut recovering = Vec::new();
        for (record, settled) in self.settle_records().await {
            let id = record.id;
            if !self.ordinals.insert(record.ordinal) {
                tracing::error!(%id, ordinal = record.ordinal, "ordinal taken twice; leaving the sandbox on disk");
                self.block(id, format!("ordinal {} is taken twice", record.ordinal));
                continue;
            }
            // Nothing is done for a sandbox, not even looking at its VM,
            // before its record is known to be durable: a crash could
            // still bring back an older one.
            let record = match settled {
                Ok(record) => record,
                Err(error) => {
                    tracing::error!(%id, %error, "record not known to be durable; blocking the sandbox and leaving it alone");
                    self.block(id, format!("record not known to be durable: {error}"));
                    continue;
                }
            };
            if record.removing {
                self.remove_recorded(&record, None, Vec::new());
                continue;
            }
            recovering.push(record);
        }
        // Finding VMs and checking networks touch only their own sandbox,
        // so they run for every sandbox at once; the results are taken in
        // one by one.
        let (mut found, broken_networks) = tokio::join!(
            self.find_vms(&recovering),
            self.ensure_networks(&recovering)
        );
        let mut adopted = 0_usize;
        for record in recovering {
            let id = record.id;
            let vm = found
                .remove(&id.0)
                .unwrap_or_else(|| Err(HostError::Io("no result from looking for the VM".into())));
            let result = match broken_networks.get(&id.0) {
                // A VM found running is left as it is: its guest's programs
                // matter more than its network, and its memory keeps coming.
                Some(error) => {
                    keep_serving::<E>(vm);
                    Err(HostError::Io(format!("network not repaired: {error}")))
                }
                None => self.recover_one(record, vm).await,
            };
            match result {
                Ok(true) => adopted += 1,
                Ok(false) => {}
                Err(error) => {
                    tracing::error!(%id, %error, "could not recover sandbox; blocking it and leaving it on disk");
                    self.block(id, format!("not recovered: {error}"));
                }
            }
        }
        tracing::info!(
            sandboxes = self.slots.len(),
            adopted,
            blocked = self.blocked.len(),
            "recovered"
        );
    }

    /// Every record as found, with what its file durably holds or why that
    /// is unknown. Each sandbox's own directory is synced, so they are
    /// settled all at once.
    async fn settle_records(&self) -> Vec<(Record, Result<Record, StateError>)> {
        const CONCURRENT: usize = 64;
        futures::stream::iter(self.records.all())
            .map(|found| async move {
                let settled = self.records.settle(found.id).await;
                (found, settled)
            })
            .buffer_unordered(CONCURRENT)
            .collect()
            .await
    }

    /// Stops managing sandbox `id` for now: requests for it fail with
    /// [`HostError::Broken`] and status lists it with `problem`. Its record,
    /// files and any VM stay as they are; a recorded sandbox can still be
    /// removed.
    pub(super) fn block(&mut self, id: Id, problem: String) {
        self.blocked.insert(id.0, problem);
    }

    /// Looks for every recorded sandbox's VM, taking back those still
    /// running and clearing what dead ones left. Sandboxes whose disk is
    /// remote have no VM to find.
    pub(super) async fn find_vms(
        &self,
        records: &[Record],
    ) -> HashMap<SandboxId, Result<Option<FoundVm<E>>, HostError>> {
        /// Enough to hide each lookup's round trip to its VMM without
        /// opening thousands of descriptors at once.
        const CONCURRENT: usize = 64;
        futures::stream::iter(records)
            .map(|record| async move {
                let paths = Paths::new(&self.root, record.id);
                let spec = vm_spec(record, &paths, &self.images);
                let found = match record.disk {
                    Disk::Local => self
                        .adopt_local(record.id, &spec, &paths)
                        .await
                        .map_err(|error| HostError::Io(error.to_string())),
                    // An eviction that could not delete everything left
                    // files nothing relies on.
                    Disk::Remote => match self.engine.clean_up(&spec).await {
                        Ok(()) => crate::step::clear_local(&paths)
                            .await
                            .map(|()| None)
                            .map_err(|error| HostError::Io(error.to_string())),
                        Err(error) => Err(HostError::Io(error.to_string())),
                    },
                };
                (record.id.0, found)
            })
            .buffer_unordered(CONCURRENT)
            .collect()
            .await
    }

    /// Takes back the VM left running for a sandbox whose disk is local.
    ///
    /// A VM whose memory a pager serves keeps that pager, a process of its
    /// own; the agent reconnects to it first, so filling resumes before
    /// anything asks the VMM. A VM whose pager died while the guest still
    /// needed it can never run again: it is ended, and the record still
    /// says whether a saved image stands in for it. Anything less certain
    /// leaves the VM as it is, its memory still served.
    async fn adopt_local(
        &self,
        id: Id,
        spec: &VmSpec,
        paths: &Paths,
    ) -> Result<Option<FoundVm<E>>, EngineError> {
        let memory = if crate::step::paged(paths) {
            match self.reconnect_paging(paths).await {
                Ok(memory) => memory,
                Err(error) if error.kind == ErrorKind::MemoryLost => {
                    // Its pager runs but nothing it waits for can come, so
                    // the VMM may be stuck on a fault and never answer:
                    // it is ended without being asked.
                    tracing::warn!(%id, %error, "the VM's memory cannot be served; ending it");
                    return self.engine.clean_up(spec).await.map(|()| None);
                }
                Err(error) => return Err(error),
            }
        } else {
            None
        };
        match self.engine.adopt(spec).await {
            Ok(Some((vm, how))) => {
                if memory.is_some() {
                    tracing::info!(%id, "reconnected to the VM's memory pager");
                }
                Ok(Some((vm, how, memory)))
            }
            Ok(None) => {
                if let Some(memory) = memory {
                    memory.close().await;
                }
                Ok(None)
            }
            // The engine saw the loss and ended the VM itself.
            Err(error) if error.kind == ErrorKind::MemoryLost => {
                if let Some(memory) = memory {
                    memory.close().await;
                }
                tracing::warn!(%id, %error, "the VM's memory pager died; the VM was ended");
                Ok(None)
            }
            // The VM may still run and its guest wait on a page: the
            // sandbox is blocked, but its memory keeps coming until the
            // pager holds all of it.
            Err(error) => {
                if let Some(memory) = memory {
                    memory.serve_detached();
                }
                Err(error)
            }
        }
    }

    async fn reconnect_paging(&self, paths: &Paths) -> Result<Option<Reconnected>, EngineError> {
        #[cfg(target_os = "linux")]
        {
            crate::step::reconnect_paging(paths, self.fetcher.as_ref()).await
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = paths;
            Ok(None)
        }
    }

    /// Makes sure every recorded sandbox's network is complete and has the
    /// current rules, all at once, and returns those that could not be.
    /// A VM still running keeps its network untouched but for what was
    /// missing and the rules; after a host reboot every network is rebuilt.
    pub(super) async fn ensure_networks(&self, records: &[Record]) -> HashMap<SandboxId, String> {
        let mut failed = HashMap::new();
        let Some(net) = &self.net else {
            return failed;
        };
        let mut work = tokio::task::JoinSet::new();
        let mut unanswered = HashSet::new();
        for record in records {
            let Some(link) = Images::link(record) else {
                continue;
            };
            let (id, net) = (record.id, Arc::clone(net));
            unanswered.insert(id.0);
            work.spawn_blocking(move || (id, net.ensure(&link)));
        }
        while let Some(done) = work.join_next().await {
            match done {
                Ok((id, result)) => {
                    unanswered.remove(&id.0);
                    if let Err(error) = result {
                        tracing::error!(%id, %error, "could not set up the sandbox's network");
                        failed.insert(id.0, error.to_string());
                    }
                }
                Err(error) => tracing::error!(%error, "network setup panicked"),
            }
        }
        // A task that panicked never said whose network it was.
        for id in unanswered {
            failed.insert(id, "network setup panicked".into());
        }
        failed
    }

    pub(super) async fn remove_network(&self, id: Id) -> Result<(), HostError> {
        let Some(net) = self.net.clone() else {
            return Ok(());
        };
        tokio::task::spawn_blocking(move || net.remove(id, None))
            .await
            .map_err(|error| HostError::Io(error.to_string()))?
            .map_err(|error| HostError::Io(error.to_string()))
    }

    /// Brings one recorded sandbox back under management. Returns whether
    /// a VM was still running it.
    pub(super) async fn recover_one(
        &mut self,
        record: Record,
        found: Result<Option<FoundVm<E>>, HostError>,
    ) -> Result<bool, HostError> {
        let id = record.id;
        let policy = match self.sleep_policy(&record.config) {
            Ok(policy) => policy,
            Err(error) => {
                keep_serving::<E>(found);
                return Err(HostError::Invalid(error));
            }
        };
        let size = self.size(&record.config);
        let paths = Paths::new(&self.root, id);
        let spec = vm_spec(&record, &paths, &self.images);
        let (state, vm) = if let Some((vm, found, memory)) = found? {
            match self.adopted_state(&record, found).await {
                Ok(state) => (state, Some((vm, memory))),
                Err(error) => {
                    keep_serving::<E>(Ok(Some((vm, found, memory))));
                    return Err(error);
                }
            }
        } else {
            (self.sleeping_state(&record, &paths).await?, None)
        };
        let adopted = vm.is_some();
        // Taken back before the agent can ask the VMM to sync the disk, so
        // it sees what the disk lost while no agent watched; see
        // `DiskWatch`.
        let watch = match &vm {
            Some((vm, _)) => {
                let held = self.engine.held(vm).await.unwrap_or_else(|error| {
                    tracing::warn!(%id, %error, "could not take back the disk watch");
                    None
                });
                Some(DiskWatch::adopt(&paths, held))
            }
            None => None,
        };
        let unsavable = watch.as_ref().is_some_and(DiskWatch::failed);
        self.insert(id, paths, spec);
        if let (Some((vm, pager)), Some(watch)) = (vm, watch) {
            // What its memory was based on is unknown, so its next save
            // holds every page.
            let memory = match pager {
                Some(pager) => LiveMemory::reconnected(watch, pager),
                None => LiveMemory::adopted(watch),
            };
            let live = self.own(id, vm, memory);
            if let Some(slot) = self.slots.get_mut(&id.0) {
                slot.incarnation = Some(live.incarnation);
                slot.vm = Some(live);
            }
        }
        self.input(Input::Add {
            sandbox: id.0,
            state,
            policy,
            size,
        });
        if unsavable {
            // It still runs and wakes, but is never saved.
            self.input(Input::Unsavable { sandbox: id.0 });
        }
        Ok(adopted)
    }

    /// Where a sandbox whose VM was found still running stands. A paused
    /// VM keeps the saved copy its record vouches for: every step that lets
    /// a guest run withdraws the record's word first. A running VM has
    /// moved past any copy, and a paused one without a memory image has no
    /// copy of its current state.
    pub(super) async fn adopted_state(
        &self,
        record: &Record,
        found: Found,
    ) -> Result<State, HostError> {
        // The image itself is checked when a step relies on it, and set
        // aside if it proves bad.
        let keeps_copy = found == Found::Paused && record.image;
        if !keeps_copy && (record.image || record.archived) {
            let stale = Change::new().image(false).archived(false);
            self.records
                .commit(record.id, record.fence(), stale)
                .await?;
        }
        Ok(match found {
            Found::Running => State::RUNNING,
            Found::Paused if keeps_copy => {
                let durability = if record.archived {
                    Durability::Remote
                } else {
                    Durability::Local
                };
                State::new(Level::Paused, durability, true)
            }
            Found::Paused => State::new(Level::Paused, Durability::Volatile, false),
        })
    }

    /// The ordinal a sandbox with an unreadable record was given, from
    /// what is left: the record's `ordinal` field if the file still parses
    /// as JSON, else the owner of its disk, which every launch hands to
    /// the VM's user. `None` if it never launched, when no VM or user can
    /// clash with a newcomer's.
    pub(super) async fn unreadable_ordinal(&self, id: Id) -> Option<u32> {
        use std::os::unix::fs::MetadataExt;
        let paths = Paths::new(&self.root, id);
        let from_record = tokio::fs::read(&paths.record)
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|record| record.get("ordinal")?.as_u64())
            .and_then(|ordinal| u32::try_from(ordinal).ok());
        if from_record.is_some() {
            return from_record;
        }
        // A launch hands the disk to the VMM's user, and the jail's
        // files are created by it.
        for path in [&paths.disk, &paths.jail] {
            if let Ok(metadata) = tokio::fs::symlink_metadata(path).await
                && let Some(ordinal) = metadata.uid().checked_sub(self.images.first_uid)
            {
                return Some(ordinal);
            }
        }
        None
    }

    /// Where a sandbox without a VM stands, from its record, checked
    /// against the files the record relies on.
    pub(super) async fn sleeping_state(
        &self,
        record: &Record,
        paths: &Paths,
    ) -> Result<State, HostError> {
        match record.disk {
            Disk::Remote => Ok(State::new(Level::Remote, Durability::Remote, record.image)),
            Disk::Local => {
                if !paths.disk.exists() {
                    return Err(HostError::Io("the recorded local disk is missing".into()));
                }
                let mut image = record.image;
                if image {
                    let images = paths.clone();
                    let recovered =
                        tokio::task::spawn_blocking(move || crate::step::recover_images(&images))
                            .await
                            .map_err(|error| HostError::Io(error.to_string()))?;
                    match recovered {
                        Ok(true) => {}
                        Ok(false) => {
                            tracing::warn!(id = %record.id, "recorded memory image is missing; its programs are lost");
                            let lost = Change::new().image(false);
                            self.records.commit(record.id, record.fence(), lost).await?;
                            image = false;
                        }
                        // The record keeps vouching for the image: a wake
                        // checks it again, and never boots fresh over it.
                        Err(error) => tracing::warn!(
                            id = %record.id,
                            %error,
                            "memory image unreadable for now; keeping it"
                        ),
                    }
                }
                Ok(if record.archived {
                    State::new(Level::Archived, Durability::Remote, image)
                } else {
                    State::new(Level::Saved, Durability::Local, image)
                })
            }
        }
    }
}
