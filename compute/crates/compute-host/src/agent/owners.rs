//! A host in a fleet: requests fenced by the owner epoch of their
//! sandbox, adopting a sandbox from the store, handing one off, and taking
//! in the fleet service's rulings when the host registers
//! ([ADR 18](../../../docs/adr/0018-the-fleet-service-leases-and-fences.md)).
//!
//! The owner epoch says which ownership of a sandbox this host holds. The
//! service names it on every request about a sandbox, and the agent checks
//! it in the task that acts on the request, so no adopt, drop or new owner
//! can come between the check and the act.
//!
//! A hand-off keeps nothing on disk until its last step: while it runs the
//! sandbox takes no wake, and once its latest state is archived and its VM
//! gone, one record write begins a removal that keeps the store's copy,
//! which a restarted agent finishes. An agent that restarts before that
//! write has handed nothing off: the sandbox is still this host's, wakes
//! as before, and the service, which has had no answer, asks again.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::io;
use std::sync::Arc;

use compute_core::{Input, Level, SandboxId};
use compute_engine::Engine;
use compute_protocol::fleet::Verdict;
use tokio::sync::oneshot;

use crate::layout::{Images, Paths, sync_parent};
use crate::protocol::{Id, SandboxConfig};
use crate::state::{Change, Disk, Record};
use crate::store::{Claimed, Owned, OwnerEpoch, Store};

use super::{Command, Event, HostAgent, HostError, Reply};

/// What waits for a sandbox's copy here to go: an adopt of a later
/// ownership, which then goes on.
#[derive(Debug)]
pub(super) struct Then {
    config: SandboxConfig,
    owner: OwnerEpoch,
    reply: Reply<()>,
}

/// Hand-offs under way, with who waits for each.
pub(super) type HandOffs = HashMap<SandboxId, Vec<Reply<()>>>;

/// Adopts waiting for an earlier ownership's copy to go.
pub(super) type Adopts = HashMap<SandboxId, Then>;

impl Command {
    /// The sandbox a fenced request is about.
    fn sandbox(&self) -> Option<Id> {
        match self {
            Self::Create { id, .. }
            | Self::Remove { id, .. }
            | Self::Touch { id, .. }
            | Self::Sleep { id, .. }
            | Self::Hold { id, .. }
            | Self::Unhold { id, .. }
            | Self::Acquire { id, .. }
            | Self::Check { id, .. } => Some(*id),
            Self::Release { .. }
            | Self::Status { .. }
            | Self::Adopt { .. }
            | Self::HandOff { .. }
            | Self::Reconcile { .. }
            | Self::Owned { .. } => None,
        }
    }

    /// Answers the request with `error` instead of carrying it out.
    fn refuse(self, error: HostError) {
        match self {
            Self::Create { reply, .. }
            | Self::Remove { reply, .. }
            | Self::Sleep { reply, .. }
            | Self::Hold { reply, .. }
            | Self::Unhold { reply, .. }
            | Self::Check { reply, .. }
            | Self::Adopt { reply, .. }
            | Self::HandOff { reply, .. }
            | Self::Reconcile { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::Touch { reply, .. } => {
                if let Some(reply) = reply {
                    let _ = reply.send(Err(error));
                }
            }
            Self::Acquire { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::Release { .. } | Self::Status { .. } | Self::Owned { .. } => {}
        }
    }
}

impl<E: Engine, S: Store> HostAgent<E, S> {
    /// Carries out `command`, sent for the ownership of its sandbox under
    /// `owner`, only if that is the one this host holds. One under an
    /// earlier epoch is refused as stale; one under a later epoch finds
    /// nothing here, since this host's copy may be behind the store's.
    pub(super) fn owned(&mut self, owner: OwnerEpoch, command: Command) {
        let Some(record) = command.sandbox().and_then(|id| self.records.get(id)) else {
            self.on_command(command);
            return;
        };
        let (id, held) = (record.id, record.owner());
        if held > owner {
            command.refuse(HostError::Superseded {
                id,
                held: held.0,
                asked: owner.0,
            });
            return;
        }
        if held == owner {
            self.on_command(command);
            return;
        }
        match command {
            // A create sent again under a later epoch after its try under
            // an earlier one landed here: the copy is as new as any, and is
            // the later epoch's from now on.
            Command::Create { config, reply, .. }
                if !record.removing
                    && record.config == config
                    && self.slots.get(&id.0).is_some_and(|slot| !slot.destroy) =>
            {
                self.take_owner(id, owner, reply);
            }
            command => command.refuse(HostError::NotFound(id)),
        }
    }

    /// Records `owner` as the ownership of sandbox `id` this host holds,
    /// then answers `reply`. A step under way whose next write names the
    /// record as it was fails and is tried again: no archive it began can
    /// then take a save number of the ownership before.
    fn take_owner(&mut self, id: Id, owner: OwnerEpoch, reply: Reply<()>) {
        let records = Arc::clone(&self.records);
        tokio::spawn(async move {
            let result = records
                .amend(id, Change::new().owner(owner))
                .await
                .map(|_| ())
                .map_err(HostError::from);
            let _ = reply.send(result);
        });
    }

    /// Takes sandbox `id` over from the store's latest copy as its owner
    /// under `owner`; see [`crate::protocol::Request::Adopt`].
    pub(super) fn adopt(
        &mut self,
        id: Id,
        config: SandboxConfig,
        owner: OwnerEpoch,
        reply: Reply<()>,
    ) {
        if self.blocked.contains_key(&id.0) {
            let _ = reply.send(Err(self.blocked_error(id)));
            return;
        }
        if !self.store.is_configured() {
            let _ = reply.send(Err(HostError::Invalid(
                "this host has no store to adopt sandboxes from".into(),
            )));
            return;
        }
        if let Some(record) = self.records.get(id)
            && !self.destroying.contains_key(&id.0)
        {
            let held = record.owner();
            match held.cmp(&owner) {
                Ordering::Greater => {
                    let _ = reply.send(Err(HostError::Superseded {
                        id,
                        held: held.0,
                        asked: owner.0,
                    }));
                }
                // Adopting again: done, unless the copy is going or of
                // other settings.
                Ordering::Equal => {
                    let same = !record.removing && record.config == config;
                    let _ = reply.send(if same {
                        Ok(())
                    } else {
                        Err(HostError::Exists(id))
                    });
                }
                // The copy of an earlier ownership goes first, leaving the
                // store's; then the adopt goes on.
                Ordering::Less => self.drop_copy(
                    id,
                    Some(Then {
                        config,
                        owner,
                        reply,
                    }),
                ),
            }
            return;
        }
        if self.preparing.contains(&id.0)
            || self.destroying.contains_key(&id.0)
            || self.tearing_down.contains_key(&id.0)
        {
            let _ = reply.send(Err(HostError::Busy(id)));
            return;
        }
        if self.hosts.contains_key(&id.0) {
            let _ = reply.send(Err(HostError::Exists(id)));
            return;
        }
        if let Err(error) = self.can_create(id, &config) {
            let _ = reply.send(Err(error));
            return;
        }
        let ordinal = match self.take_ordinal() {
            Ok(ordinal) => ordinal,
            Err(problem) => {
                let _ = reply.send(Err(HostError::Io(problem)));
                return;
            }
        };
        let allocation = match self.images.allocate(ordinal) {
            Ok(allocation) => allocation,
            Err(problem) => {
                self.ordinals.remove(&ordinal);
                let _ = reply.send(Err(HostError::Invalid(problem)));
                return;
            }
        };
        self.preparing.insert(id.0);
        self.claim_copy(
            id,
            Record::new(id, ordinal, allocation, config),
            owner,
            reply,
        );
    }

    /// Claims the store's copy of the sandbox `record` is the new record
    /// of, under `owner`, and makes it this host's at Remote.
    fn claim_copy(&mut self, id: Id, mut record: Record, owner: OwnerEpoch, reply: Reply<()>) {
        let ordinal = record.ordinal;
        let link = Images::link(&record);
        let paths = Paths::new(&self.root, id);
        let (store, records, net) = (
            Arc::clone(&self.store),
            Arc::clone(&self.records),
            self.net.clone(),
        );
        let events = self.events_tx.clone();
        tokio::spawn(async move {
            let result = match store.claim(id, owner).await {
                Err(error) => Err(HostError::Io(error.to_string())),
                Ok(Owned::Fenced { by }) => Err(HostError::Superseded {
                    id,
                    held: by.0,
                    asked: owner.0,
                }),
                Ok(Owned::Done(None)) => Err(HostError::NoCopy(id)),
                Ok(Owned::Done(Some(claimed))) => {
                    let made = adopted_files(&paths, &claimed, net.clone(), link).await;
                    match made {
                        Ok(()) => {
                            remote_record(&mut record, owner, &claimed);
                            records.insert(record).await.map_err(HostError::from)
                        }
                        Err(error) => Err(HostError::Io(error.to_string())),
                    }
                }
            };
            if result.is_err() {
                // The id stays reserved until this is done, so it cannot
                // remove a newer sandbox's files or network.
                if let Some(net) = net {
                    let _ =
                        tokio::task::spawn_blocking(move || net.remove(id, Some(ordinal))).await;
                }
                if let Err(error) = tokio::fs::remove_dir_all(&paths.dir).await
                    && error.kind() != io::ErrorKind::NotFound
                {
                    tracing::warn!(%id, %error, "an adopt that failed left files behind");
                }
            }
            let _ = events.send(Event::Prepared {
                id,
                ordinal,
                result,
                reply,
                stale: None,
            });
        });
    }

    /// Hands sandbox `id`, held under `owner`, off; see
    /// [`crate::protocol::Request::HandOff`].
    pub(super) fn hand_off(&mut self, id: Id, owner: OwnerEpoch, reply: Reply<()>) {
        if self.blocked.contains_key(&id.0) {
            let _ = reply.send(Err(self.blocked_error(id)));
            return;
        }
        if let Some(removers) = self.destroying.get_mut(&id.0) {
            // Already going: answered once it is gone.
            removers.push(reply);
            return;
        }
        let Some(record) = self.records.get(id) else {
            let _ = reply.send(Err(if self.preparing.contains(&id.0) {
                HostError::Busy(id)
            } else {
                HostError::NotFound(id)
            }));
            return;
        };
        let held = record.owner();
        if held != owner {
            let _ = reply.send(Err(if held > owner {
                HostError::Superseded {
                    id,
                    held: held.0,
                    asked: owner.0,
                }
            } else {
                HostError::NotFound(id)
            }));
            return;
        }
        if !self.store.is_configured() {
            let _ = reply.send(Err(HostError::Invalid(
                "this host has no store to hand sandboxes off through".into(),
            )));
            return;
        }
        let Some(slot) = self.slots.get_mut(&id.0) else {
            let _ = reply.send(Err(HostError::Busy(id)));
            return;
        };
        if slot.destroy {
            slot.removers.push(reply);
            return;
        }
        if let Some(waiting) = self.handing_off.get_mut(&id.0) {
            waiting.push(reply);
            return;
        }
        let awake = self.core.sandbox(id.0).is_none_or(|view| {
            view.holds > 0 || (view.state.level == Level::Running && view.step.is_none())
        });
        if awake {
            let _ = reply.send(Err(HostError::Awake(id)));
            return;
        }
        if let Err(error) = self.request_sleep(id, Level::Archived) {
            let _ = reply.send(Err(error));
            return;
        }
        self.handing_off.insert(id.0, vec![reply]);
        self.continue_hand_off(id);
    }

    /// Refuses to wake sandbox `id` while it is being handed off.
    pub(super) fn not_handing_off(&self, id: Id) -> Result<(), HostError> {
        if self.handing_off.contains_key(&id.0) {
            Err(HostError::HandingOff(id))
        } else {
            Ok(())
        }
    }

    /// Moves a hand-off of sandbox `id` on once its latest state is in the
    /// store and nothing of it runs: its removal begins, keeping the
    /// store's copy, and its waiters are answered once the removal ends.
    pub(super) fn continue_hand_off(&mut self, id: Id) {
        if !self.handing_off.contains_key(&id.0) {
            return;
        }
        if self.core.sandbox(id.0).is_some_and(|view| view.broken) {
            self.fail_hand_off(id, &HostError::Broken(id));
            return;
        }
        let archived = self
            .core
            .sandbox(id.0)
            .is_some_and(|view| view.step.is_none() && view.state.level >= Level::Archived);
        let Some(slot) = self.slots.get_mut(&id.0) else {
            return;
        };
        if slot.destroy || !archived || slot.vm.is_some() {
            return;
        }
        slot.hand_off = true;
        slot.removers
            .extend(self.handing_off.remove(&id.0).unwrap_or_default());
        self.input(Input::Remove { sandbox: id.0 });
    }

    /// Ends any hand-off of sandbox `id` with `error`, as when it broke.
    pub(super) fn fail_hand_off(&mut self, id: Id, error: &HostError) {
        for waiter in self.handing_off.remove(&id.0).unwrap_or_default() {
            let _ = waiter.send(Err(error.clone()));
        }
    }

    /// Drops this host's copy of sandbox `id`, keeping the store's, then
    /// goes on with `then` once it is gone. Its waiters, and those of any
    /// hand-off under way, are answered when it is.
    fn drop_copy(&mut self, id: Id, then: Option<Then>) {
        if let Some(then) = then {
            self.then_adopt.insert(id.0, then);
        }
        if self.destroying.contains_key(&id.0) {
            return;
        }
        let waiting = self.handing_off.remove(&id.0).unwrap_or_default();
        if let Some(slot) = self.slots.get_mut(&id.0) {
            slot.hand_off = true;
            slot.removers.extend(waiting);
            self.input(Input::Remove { sandbox: id.0 });
        } else {
            for waiter in waiting {
                let _ = waiter.send(Err(HostError::NotFound(id)));
            }
            // Nothing here to wait for that a later try would not find.
            if let Some(then) = self.then_adopt.remove(&id.0) {
                let _ = then.reply.send(Err(HostError::Busy(id)));
            }
        }
    }

    /// A removal of sandbox `id` ended: an adopt that waited for it goes
    /// on, or fails with it.
    pub(super) fn dropped(&mut self, id: Id, result: &Result<(), HostError>) {
        let Some(Then {
            config,
            owner,
            reply,
        }) = self.then_adopt.remove(&id.0)
        else {
            return;
        };
        match result {
            Ok(()) => self.adopt(id, config, owner, reply),
            Err(error) => {
                let _ = reply.send(Err(error.clone()));
            }
        }
    }

    /// Takes in the fleet service's rulings on the sandboxes this host
    /// listed when it registered: keeps each it is told to under the owner
    /// epoch it names, drops the rest, keeping the store's copies, and
    /// adopts again those whose copy here is behind the store's. Answers
    /// once every drop is done, so the new lease lets only what the service
    /// gave this host run.
    pub(super) fn reconcile(&mut self, rulings: Vec<(Id, Verdict)>, reply: Reply<()>) {
        if let Some((&id, _)) = self.blocked.first_key_value() {
            let _ = reply.send(Err(HostError::Blocked {
                id: Id(id),
                reason: "a sandbox the host does not manage may still run a VM another host now \
                         runs; remove it before the host registers"
                    .into(),
            }));
            return;
        }
        let rulings: HashMap<_, _> = rulings.into_iter().collect();
        let mut waits = Vec::new();
        for record in self.records.all() {
            if record.ready {
                continue;
            }
            let id = record.id;
            let verdict = rulings.get(&id).copied().unwrap_or(Verdict::Drop);
            let (done, answer) = oneshot::channel();
            match verdict {
                Verdict::Keep { owner_epoch } => {
                    let owner = OwnerEpoch(owner_epoch);
                    if owner == record.owner() || record.removing {
                        continue;
                    }
                    // The service decides afresh whether it goes.
                    self.fail_hand_off(
                        id,
                        &HostError::Superseded {
                            id,
                            held: owner_epoch,
                            asked: record.owner().0,
                        },
                    );
                    self.take_owner(id, owner, done);
                }
                Verdict::Drop => {
                    if let Some(removers) = self.destroying.get_mut(&id.0) {
                        removers.push(done);
                    } else if let Some(slot) = self.slots.get_mut(&id.0) {
                        slot.removers.push(done);
                        self.drop_copy(id, None);
                    } else {
                        continue;
                    }
                }
                Verdict::Refetch { owner_epoch } => {
                    let then = Then {
                        config: record.config.clone(),
                        owner: OwnerEpoch(owner_epoch),
                        reply: done,
                    };
                    self.drop_copy(id, Some(then));
                }
            }
            waits.push((id, answer));
        }
        tokio::spawn(async move {
            let mut result = Ok(());
            for (id, answer) in waits {
                let outcome = answer.await.unwrap_or(Err(HostError::Stopped));
                // A drop that finds the sandbox already gone is done too.
                match outcome {
                    Ok(()) | Err(HostError::NotFound(_) | HostError::Removed(_)) => {}
                    Err(error) => {
                        tracing::error!(%id, %error, "a ruling could not be carried out");
                        if result.is_ok() {
                            result = Err(error);
                        }
                    }
                }
            }
            let _ = reply.send(result);
        });
    }
}

/// Makes an adopted sandbox's directory, network and archive receipt, all
/// durable before its record vouches for them. Blocks in the background.
async fn adopted_files(
    paths: &Paths,
    claimed: &Claimed,
    net: Option<Arc<crate::net::Networks>>,
    link: Option<crate::net::Link>,
) -> io::Result<()> {
    let paths = paths.clone();
    let (receipt, memory) = (claimed.receipt.clone(), claimed.memory);
    tokio::task::spawn_blocking(move || {
        // The directory must be new: one already there belongs to a sandbox
        // this agent does not know, and is left alone.
        std::fs::create_dir(&paths.dir)?;
        std::fs::create_dir(&paths.jail)?;
        crate::step::mark_archived(&paths, receipt, memory)?;
        sync_parent(&paths.jail)?;
        sync_parent(&paths.dir)?;
        if let (Some(net), Some(link)) = (&net, &link) {
            net.ensure(link)?;
        }
        Ok(())
    })
    .await
    .map_err(io::Error::other)?
}

/// Makes `record` that of a sandbox kept only in the store, as `claimed`
/// left it, owned under `owner`.
fn remote_record(record: &mut Record, owner: OwnerEpoch, claimed: &Claimed) {
    record.disk = Disk::Remote;
    record.image = claimed.memory;
    record.archived = true;
    record.owner_epoch = owner.0;
    record.saves = claimed.save;
}
