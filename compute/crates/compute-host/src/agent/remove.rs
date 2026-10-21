//! Deleting sandboxes, in an order that a crash at any point leaves either
//! finishable on the next start of the agent or finished.

use std::io;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use compute_engine::{Engine, VmSpec};
use tokio::time::sleep;

use crate::layout::{Paths, vm_spec};
use crate::net::Networks;
use crate::protocol::Id;
use crate::state::{Change, Fence, Record, Records};
use crate::step::LiveMemory;
use crate::store::{Owned, Store};

use super::holds::Closing;
use super::{Event, HostAgent, HostError, Leftover, Reply};

impl<E: Engine, S: Store> HostAgent<E, S> {
    pub(super) fn destroy_now(&mut self, id: Id) {
        let Some(mut slot) = self.slots.remove(&id.0) else {
            return;
        };
        self.unlink(id);
        for waiter in slot.waiters.drain(..) {
            let _ = waiter.reply.send(Err(HostError::Removed(id)));
        }
        let live = slot.vm.take();
        if let Some(live) = &live {
            live.stopping.store(true, Ordering::Release);
        }
        let mut removers = std::mem::take(&mut slot.removers);
        // A hand-off under way ends with the sandbox, however it goes.
        removers.extend(self.handing_off.remove(&id.0).unwrap_or_default());
        if let Some(record) = self.records.get(id) {
            let closing = slot.holds.close();
            self.remove_recorded_as(
                &record,
                live.map(|live| (live.vm, live.memory)),
                removers,
                Some(closing),
                slot.hand_off,
            );
        } else {
            tracing::error!(%id, "removing a sandbox without a record");
            for remover in removers {
                let _ = remover.send(Err(HostError::NotFound(id)));
            }
        }
    }

    /// Deletes a recorded sandbox in the background, once `holds` has
    /// closed its holds writer if it had one. Its ordinal and id stay taken
    /// until nothing of it is left.
    pub(super) fn remove_recorded(
        &mut self,
        record: &Record,
        vm: Option<(E::Vm, LiveMemory)>,
        removers: Vec<Reply<()>>,
        holds: Option<Closing>,
    ) {
        self.remove_recorded_as(record, vm, removers, holds, false);
    }

    /// [`Self::remove_recorded`], keeping the store's copy if `hand_off`.
    fn remove_recorded_as(
        &mut self,
        record: &Record,
        vm: Option<(E::Vm, LiveMemory)>,
        removers: Vec<Reply<()>>,
        holds: Option<Closing>,
        hand_off: bool,
    ) {
        let (id, host) = (record.id, record.host());
        self.destroying.insert(id.0, removers);
        if hand_off || record.handed_off {
            self.handing_away.insert(id.0);
        }
        let paths = Paths::of(&self.root, record);
        let spec = vm_spec(record, &paths, &self.images);
        let engine = Arc::clone(&self.engine);
        let store = Arc::clone(&self.store);
        let records = Arc::clone(&self.records);
        let net = self.net.clone();
        let events = self.events_tx.clone();
        let (ordinal, fence) = (record.ordinal, record.fence());
        tokio::spawn(async move {
            if let Some(closing) = holds {
                closing.await;
            }
            let removal = Removal {
                engine: &*engine,
                store: &*store,
                records: &records,
                net,
                id,
                host,
                hand_off,
            };
            let ended = || {
                let _ = events.send(Event::VmEnded { id, host });
            };
            let result = removal.run(fence, vm, &spec, &paths.dir, ended).await;
            if let Err(error) = &result {
                tracing::error!(%id, %error, "removal stopped; the next start of the agent finishes it");
            }
            let _ = events.send(Event::Destroyed {
                id,
                host,
                ordinal: Some(ordinal),
                result,
            });
        });
    }

    /// Deletes in the background what a removal left of a sandbox whose
    /// record is already gone: its network and its directory.
    pub(super) fn remove_leftovers(&mut self, id: Id, left: Leftover, reply: Reply<()>) {
        let Leftover { host, ordinal } = left;
        self.blocked.remove(&id.0);
        self.leftovers.remove(&id.0);
        self.destroying.insert(id.0, vec![reply]);
        let dir = Paths::new(&self.root, host).dir;
        let net = self.net.clone();
        let records = Arc::clone(&self.records);
        let events = self.events_tx.clone();
        tokio::spawn(async move {
            // Keeps the state root, and the host, locked until it is done.
            let _records = records;
            let result = unmake(host, ordinal, &dir, net).await;
            let _ = events.send(Event::Destroyed {
                id,
                host,
                ordinal,
                result,
            });
        });
    }
}

/// Deleting one sandbox, in an order that a crash at any point leaves
/// either finishable on the next start or finished.
struct Removal<'a, E, S> {
    engine: &'a E,
    store: &'a S,
    records: &'a Records,
    net: Option<Arc<Networks>>,
    id: Id,
    /// The name its network was made under.
    host: Id,
    /// It is handed off: the store's copy stays for its next owner.
    hand_off: bool,
}

impl<E: Engine, S: Store> Removal<'_, E, S> {
    /// Records that removal began, ends the VM, deletes the store's copy,
    /// then the record, then the files. Until the record is gone a restart
    /// resumes the removal; after, the directory is an unrecorded stray
    /// that recovery deletes. Calls `ended` as soon as the VM is known to
    /// have ended, before the rest.
    async fn run(
        &self,
        fence: Fence,
        vm: Option<(E::Vm, LiveMemory)>,
        spec: &VmSpec,
        dir: &Path,
        ended: impl FnOnce(),
    ) -> Result<(), HostError> {
        let id = self.id;
        let begun = if self.hand_off {
            Change::new().handed_off()
        } else {
            Change::new().removing()
        };
        let record = self.records.commit(id, fence, begun).await?;
        let stopped = match vm {
            Some((vm, memory)) => {
                memory.ending();
                let stopped = self.engine.stop(vm).await;
                if stopped.is_ok() {
                    // Whatever serves or fetches its memory writes into
                    // the directory about to go, so it ends first.
                    memory.close().await;
                } else {
                    // The VM may still run, and then still fault on its
                    // memory; the directory stays, since removal stops
                    // here.
                    memory.serve_detached();
                }
                stopped
            }
            None => self.engine.clean_up(spec).await,
        };
        stopped.map_err(|error| HostError::Io(error.to_string()))?;
        ended();
        if let Some(net) = self.net.clone() {
            // The record holds its ordinal until it is removed below.
            let ordinal = record.allocation.link.map(|_| record.ordinal);
            let host = self.host;
            tokio::task::spawn_blocking(move || net.remove(host, ordinal))
                .await
                .map_err(|error| HostError::Io(error.to_string()))?
                .map_err(|error| HostError::Io(error.to_string()))?;
        }
        // A sandbox handed to another owner keeps its stored copy; one a
        // later owner took meanwhile does too.
        if !record.handed_off {
            let deleted = self
                .store
                .delete(id, record.owner())
                .await
                .map_err(|error| HostError::Io(error.to_string()))?;
            if let Owned::Fenced { by } = deleted {
                tracing::warn!(%id, own = %record.owner(), %by, "a later owner holds the stored copy; it stays");
            }
        }
        self.records.remove(id, record.fence()).await?;
        // The pager of a VM that ended on its own may still be writing its
        // last file here; a moment later the directory is quiet.
        let mut tries = 0;
        loop {
            match tokio::fs::remove_dir_all(dir).await {
                Err(error) if error.kind() == io::ErrorKind::DirectoryNotEmpty && tries < 10 => {
                    tries += 1;
                    sleep(Duration::from_millis(50)).await;
                }
                Err(error) if error.kind() != io::ErrorKind::NotFound => {
                    return Err(HostError::Io(error.to_string()));
                }
                _ => return Ok(()),
            }
        }
    }
}

/// Deletes what is left of a sandbox that has no record, never had one or
/// lost it to a removal: its network, made under `host` with `ordinal`,
/// then its directory `dir`. The directory goes only once the network is
/// gone, so whatever a failure leaves is found again on recovery. Its id
/// stays reserved until this is done, so it cannot delete a newer
/// sandbox's files or network.
pub(super) async fn unmake(
    host: Id,
    ordinal: Option<u32>,
    dir: &Path,
    net: Option<Arc<Networks>>,
) -> Result<(), HostError> {
    let failed = |error: &dyn std::fmt::Display| HostError::Io(error.to_string());
    if let Some(net) = net {
        tokio::task::spawn_blocking(move || net.remove(host, ordinal))
            .await
            .map_err(|error| failed(&error))?
            .map_err(|error| failed(&error))?;
    }
    match tokio::fs::remove_dir_all(dir).await {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(failed(&error)),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use compute_core::SandboxId;

    use super::*;

    /// What [`unmake`] cannot delete it says, keeping the rest for a later
    /// try, which deletes it; a directory already gone is deleted.
    #[tokio::test]
    async fn unmaking_says_what_it_could_not_delete_and_a_later_try_deletes_it() {
        let root = tempfile::tempdir().unwrap();
        let (dir, stuck) = (
            root.path().join("sandbox"),
            root.path().join("sandbox/stuck"),
        );
        std::fs::create_dir_all(&stuck).unwrap();
        std::fs::write(stuck.join("file"), b"").unwrap();
        let mode = |path: &Path, mode| {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
        };
        mode(&stuck, 0o555);
        if std::fs::write(stuck.join("probe"), b"").is_ok() {
            // Root deletes it anyway; nothing to test.
            mode(&stuck, 0o755);
            return;
        }
        let id = Id(SandboxId(7));

        let failed = unmake(id, Some(0), &dir, None).await;
        assert!(matches!(failed, Err(HostError::Io(_))), "{failed:?}");
        assert!(
            stuck.join("file").exists(),
            "what it could not delete stays"
        );

        mode(&stuck, 0o755);
        assert_eq!(unmake(id, Some(0), &dir, None).await, Ok(()));
        assert!(!dir.exists());
        assert_eq!(unmake(id, Some(0), &dir, None).await, Ok(()));
    }
}
