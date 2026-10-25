//! A host in a fleet: requests fenced by the owner epoch of their
//! sandbox, adopting a sandbox from the store, handing one off, and taking
//! in the control service's rulings when the host registers
//! ([ADR 18](../../../docs/adr/0018-the-control-service-leases-and-fences.md)).
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
//!
//! An adopt after the last owner was lost takes up the store's copy from
//! its files alone: it deletes the copy's memory image as it claims it, so
//! the next wake boots, as after a crash, and no guest is brought back at
//! a point it had already run past (see [`crate::protocol::Request::Adopt`]).

use std::cmp::Ordering;
use std::collections::HashMap;
use std::io;
use std::sync::Arc;

use compute_core::{Input, Level, SandboxId};
use compute_engine::Engine;
use compute_protocol::fleet::{Ruling, Verdict};
use tokio::sync::oneshot;

use crate::layout::{Images, Paths, sync_parent};
use crate::observe::{Alarm, Observer, alarm_event};
use crate::protocol::{Id, SandboxConfig};
use crate::state::{Change, Disk, Record};
use crate::store::{Claimed, Owned, OwnerEpoch, Stamp, Store};

use super::disk::{AfterReading, Room};
use super::remove::unmake;
use super::requests::first_wake_by_ms;
use super::{Command, Event, HostAgent, HostError, Reply};
use crate::fleet::Admission;

/// What waits for a sandbox's copy here to go: an adopt of a later
/// ownership, which then goes on.
#[derive(Debug)]
pub(super) struct Then {
    config: SandboxConfig,
    owner: OwnerEpoch,
    /// Whether it is taken up from the copy's files alone.
    from_files: bool,
    reply: Reply<()>,
    /// The registration the request was admitted under, for one from the
    /// control service: the adopt goes on only while the host still holds it
    /// and its lease runs. `None` for the rulings' own adopts.
    under: Option<u64>,
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
            Self::Traced(_, command) => command.sandbox(),
            Self::Release { .. }
            | Self::Status { .. }
            | Self::Inventory { .. }
            | Self::Adopt { .. }
            | Self::HandOff { .. }
            | Self::Reconcile { .. }
            | Self::Inspect { .. }
            | Self::Owned { .. } => None,
        }
    }

    /// Answers the request with `error` instead of carrying it out.
    pub(super) fn refuse(self, error: HostError) {
        match self {
            Self::Create { reply, .. }
            | Self::Remove { reply, .. }
            | Self::Sleep { reply, .. }
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
            Self::Hold { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::Acquire { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::Inspect { reply, .. } => {
                let _ = reply.send(None);
            }
            Self::Traced(_, command) => command.refuse(error),
            Self::Release { .. }
            | Self::Status { .. }
            | Self::Inventory { .. }
            | Self::Owned { .. } => {}
        }
    }
}

impl<E: Engine, S: Store> HostAgent<E, S> {
    /// Carries out a request only a host in a fleet gets.
    pub(super) fn on_fleet_command(&mut self, command: Command) {
        match command {
            Command::Adopt {
                id,
                config,
                owner,
                from_files,
                reply,
            } => self.adopt(id, config, owner, from_files, reply),
            Command::HandOff {
                id,
                owner,
                awake,
                reply,
            } => self.hand_off(id, owner, awake, reply),
            Command::Reconcile { rulings, reply } => self.reconcile(rulings, reply),
            Command::Owned {
                owner,
                admission,
                command,
            } => self.owned(owner, admission, *command),
            Command::Inventory { reply } => {
                let _ = reply.send(self.inventory());
            }
            other => self.on_command(other),
        }
    }

    /// Carries out `command`, sent for the ownership of its sandbox under
    /// `owner`, only if that is the one this host holds. One under an
    /// earlier epoch is refused as stale; one under a later epoch finds
    /// nothing here, since this host's copy may be behind the store's.
    ///
    /// The listener admitted it under `admission`; it may have waited
    /// since, so it is carried out only if the lease would still admit it.
    /// Nothing sent under a registration the host no longer holds then
    /// acts here, and no create or adopt starts once the host lists what
    /// it holds to register again. An adopt or hand-off, which names its
    /// owner itself, goes on to its own checks once admitted.
    pub(super) fn owned(
        &mut self,
        owner: OwnerEpoch,
        admission: Option<Admission>,
        command: Command,
    ) {
        if let (Some(admission), Some(gate)) = (admission, &self.lease)
            && !gate.admits(admission)
        {
            command.refuse(HostError::NotAdmitted);
            return;
        }
        // A create, adopt or change of owner under way may yet land: until
        // it has, nothing about the sandbox is answered "not found", which
        // the service could take as final.
        if let Some(id) = command.sandbox()
            && self.settling(id)
        {
            command.refuse(HostError::Busy(id));
            return;
        }
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
            // the later epoch's from now on, with that epoch's agent link.
            Command::Create { config, reply, .. }
                if !record.removing
                    && record.config.same_sandbox(&config)
                    && self.slots.get(&id.0).is_some_and(|slot| !slot.destroy) =>
            {
                self.take_owner(id, Change::new().owner(owner).link(config.link), reply);
            }
            command => command.refuse(HostError::NotFound(id)),
        }
    }

    /// Records the ownership of sandbox `id` this host holds, and the agent
    /// link that goes with it, as `change` says, then answers `reply`. A
    /// step under way whose next write names the record as it was fails and
    /// is tried again: no archive it began can then take a save number of
    /// the ownership before.
    pub(super) fn take_owner(&mut self, id: Id, change: Change, reply: Reply<()>) {
        let records = Arc::clone(&self.records);
        let events = self.events_tx.clone();
        *self.owning.entry(id.0).or_insert(0) += 1;
        tokio::spawn(async move {
            let result = records
                .amend(id, change)
                .await
                .map(|_| ())
                .map_err(HostError::from);
            let _ = events.send(Event::OwnerTaken { id, result, reply });
        });
    }

    /// A change of owner of sandbox `id` landed or failed.
    pub(super) fn owner_taken(&mut self, id: Id, result: Result<(), HostError>, reply: Reply<()>) {
        if let Some(count) = self.owning.get_mut(&id.0) {
            *count -= 1;
            if *count == 0 {
                self.owning.remove(&id.0);
            }
        }
        if result.is_ok() {
            self.link_as_recorded(id);
        }
        let _ = reply.send(result);
    }

    /// Whether a create, adopt or change of owner of sandbox `id` is under
    /// way, or an adopt waits to start.
    fn settling(&self, id: Id) -> bool {
        self.preparing.contains(&id.0)
            || self.owning.contains_key(&id.0)
            || self.then_adopt.contains_key(&id.0)
    }

    /// What the host holds, for a registration, once nothing that could
    /// still give it a sandbox is under way; otherwise how many such are.
    /// Hand-offs that have not begun their removal end now, unfinished:
    /// the sandbox stays this host's, listed, and the service asks again
    /// under the new registration. Creates and fetches waiting for a disk
    /// reading are refused now, unstarted, and asked again too: with no
    /// lease held no reading comes (see [`HostAgent::run`]), so they would
    /// keep the list waiting for good. None of these can start meanwhile,
    /// with no registration held.
    pub(super) fn inventory(&mut self) -> Result<crate::protocol::HostStatus, usize> {
        let handing_off: Vec<SandboxId> = self.handing_off.keys().copied().collect();
        for id in handing_off {
            self.fail_hand_off(Id(id), &HostError::NotAdmitted);
        }
        self.refuse_after_reading(&HostError::NotAdmitted);
        let unsettled =
            self.preparing.len() + self.owning.values().sum::<usize>() + self.then_adopt.len();
        if unsettled > 0 {
            return Err(unsettled);
        }
        Ok(self.status())
    }

    /// Takes sandbox `id` over from the store's latest copy as its owner
    /// under `owner`, from its files alone with `from_files`; see
    /// [`crate::protocol::Request::Adopt`].
    pub(super) fn adopt(
        &mut self,
        id: Id,
        config: SandboxConfig,
        owner: OwnerEpoch,
        from_files: bool,
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
        if self.preparing.contains(&id.0) {
            // Perhaps this very adopt's earlier attempt, still claiming its
            // copy or making its files, which may yet be refused: retrying
            // once it is done tells.
            let _ = reply.send(Err(HostError::Busy(id)));
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
                // other settings. An agent link sent changed is taken up.
                Ordering::Equal => {
                    if record.removing || !record.config.same_sandbox(&config) {
                        let _ = reply.send(Err(HostError::Exists(id)));
                    } else if record.config.link == config.link {
                        let _ = reply.send(Ok(()));
                    } else {
                        self.take_owner(id, Change::new().owner(owner).link(config.link), reply);
                    }
                }
                // The copy of an earlier ownership goes first, leaving the
                // store's; then the adopt goes on.
                Ordering::Less => {
                    let under = self
                        .lease
                        .as_ref()
                        .and_then(|gate| gate.answered().host_epoch);
                    self.drop_copy(
                        id,
                        Some(Then {
                            config,
                            owner,
                            from_files,
                            reply,
                            under,
                        }),
                    );
                }
            }
            return;
        }
        if self.destroying.contains_key(&id.0) || self.tearing_down.contains_key(&id.0) {
            let _ = reply.send(Err(HostError::Busy(id)));
            return;
        }
        if self.hosts.contains_key(&id.0) {
            let _ = reply.send(Err(HostError::Exists(id)));
            return;
        }
        // Its first wake fetches it, so it must fit as that wake would.
        // Only the copy tells how long its disk is, so until the copy is
        // claimed the wake is checked and booked without it; its disk is
        // judged by the copy's own then (see `Self::adopted_room`).
        let unclaimed = self.size(&config, Some(0));
        match self.can_create(id, &config, unclaimed, true) {
            Ok(Room::Now) => {}
            Ok(Room::AfterReading) => {
                let waiting = AfterReading::Adopt(id, Box::new(config), owner, from_files, reply);
                self.after_reading(waiting);
                return;
            }
            Err(error) => {
                let _ = reply.send(Err(error));
                return;
            }
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
        let by_ms = first_wake_by_ms();
        self.input(self.first_wake(id, unclaimed, true, by_ms));
        let mut record = Record::new(id, ordinal, allocation, config);
        record.first_wake_by_ms = Some(by_ms);
        self.claim_copy(id, record, owner, from_files, reply);
    }

    /// Claims the store's copy of the sandbox `record` is the new record
    /// of, under `owner`; with `from_files`, without the copy's memory
    /// image. Nothing of it is made on this host until
    /// [`Self::copy_claimed`] admits it.
    fn claim_copy(
        &mut self,
        id: Id,
        mut record: Record,
        owner: OwnerEpoch,
        from_files: bool,
        reply: Reply<()>,
    ) {
        let ordinal = record.ordinal;
        let store = Arc::clone(&self.store);
        let events = self.events_tx.clone();
        let observer = self.observer.clone();
        tokio::spawn(async move {
            let claimed = match store.claim(id, owner).await {
                Err(error) => Err(HostError::Io(error.to_string())),
                Ok(Owned::Fenced { by }) => Err(HostError::Superseded {
                    id,
                    held: by.0,
                    asked: owner.0,
                }),
                Ok(Owned::Done(None)) => Err(HostError::NoCopy(id)),
                Ok(Owned::Done(Some(claimed))) => {
                    files_only(&*store, &observer, id, owner, claimed, from_files).await
                }
            };
            let event = match claimed {
                Ok(claimed) => {
                    remote_record(&mut record, owner, &claimed);
                    Event::CopyClaimed {
                        record: Box::new(record),
                        claimed: Box::new(claimed),
                        reply,
                    }
                }
                Err(error) => Event::Prepared {
                    id,
                    ordinal,
                    result: Err(error),
                    reply,
                    stale: None,
                    left: None,
                },
            };
            let _ = events.send(event);
        });
    }

    /// Admits the first wake of adopted sandbox `record`, whose copy is
    /// claimed as `claimed`, with the copy's own disk, then makes its
    /// files and records it. One this host cannot wake now is refused
    /// before anything of it is made here, leaving the store's copy for
    /// another host. Its record is written last, so neither the same adopt
    /// asked again nor an agent that starts meanwhile takes it as adopted
    /// before it is admitted and its files are whole.
    pub(super) fn copy_claimed(&mut self, record: Record, claimed: Claimed, reply: Reply<()>) {
        let (id, ordinal) = (record.id, record.ordinal);
        if let Err(refused) = self.adopted_room(&record) {
            self.prepared(id, ordinal, Err(refused), reply, None, None);
            return;
        }
        let link = Images::link(&record);
        let paths = Paths::new(&self.root, id);
        let (records, net) = (Arc::clone(&self.records), self.net.clone());
        let events = self.events_tx.clone();
        tokio::spawn(async move {
            let (result, left) = match adopted_files(&paths, &claimed, net.clone(), link).await {
                // A directory already there belongs to a sandbox this
                // agent does not know, and is left alone.
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    tracing::error!(%id, "a directory for an adopted sandbox already exists; refusing it");
                    (Err(HostError::Exists(id)), None)
                }
                made => {
                    let result = match made {
                        Ok(()) => records
                            .insert(record)
                            .await
                            .map(Box::new)
                            .map_err(HostError::from),
                        Err(error) => Err(HostError::Io(error.to_string())),
                    };
                    let left = match &result {
                        Ok(_) => None,
                        Err(_) => unmake(id, Some(ordinal), &paths.dir, net)
                            .await
                            .err()
                            .map(|error| error.to_string()),
                    };
                    (result, left)
                }
            };
            let _ = events.send(Event::Prepared {
                id,
                ordinal,
                result,
                reply,
                stale: None,
                left,
            });
        });
    }

    /// Hands sandbox `id`, held under `owner`, off, even while it is awake
    /// with `awake`; see [`crate::protocol::Request::HandOff`].
    ///
    /// It is sent unfenced, so it keeps the barrier [`Self::owned`] keeps:
    /// while a create, adopt or change of owner may yet land, or a removal
    /// that would delete the store's copy runs, it is answered busy, never
    /// "not found", which the service could take as final. It joins only a
    /// removal that hands the sandbox off.
    ///
    /// Handed off awake, every hold on it ends at once: from then on the
    /// hand-off refuses new ones, as it refuses wakes, so the streams that
    /// held it end at their next write, and nothing keeps it from being
    /// paused, saved and archived with its memory. Holds named in its
    /// record stay recorded: one renewed after a hand-off that did not
    /// finish holds it again.
    pub(super) fn hand_off(&mut self, id: Id, owner: OwnerEpoch, awake: bool, reply: Reply<()>) {
        if self.blocked.contains_key(&id.0) {
            let _ = reply.send(Err(self.blocked_error(id)));
            return;
        }
        if self.settling(id) {
            let _ = reply.send(Err(HostError::Busy(id)));
            return;
        }
        let Some(record) = self.records.get(id) else {
            let _ = reply.send(Err(if self.destroying.contains_key(&id.0) {
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
        if let Some(removers) = self.destroying.get_mut(&id.0) {
            // Already going: a hand-off is answered once it is gone; a
            // removal that deletes the store's copy is not one.
            if self.handing_away.contains(&id.0) {
                removers.push(reply);
            } else {
                let _ = reply.send(Err(HostError::Busy(id)));
            }
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
            if slot.hand_off || record.handed_off {
                slot.removers.push(reply);
            } else {
                let _ = reply.send(Err(HostError::Busy(id)));
            }
            return;
        }
        if let Some(waiting) = self.handing_off.get_mut(&id.0) {
            waiting.push(reply);
            return;
        }
        let Some(view) = self.core.sandbox(id.0) else {
            let _ = reply.send(Err(HostError::Awake(id)));
            return;
        };
        let held = view.holds > 0;
        if (held || view.runs()) && !awake {
            let _ = reply.send(Err(HostError::Awake(id)));
            return;
        }
        if let Err(error) = self.request_sleep(id, Level::Archived) {
            let _ = reply.send(Err(error));
            return;
        }
        if held {
            self.input(Input::LetGo { sandbox: id.0 });
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
            from_files,
            reply,
            under,
        }) = self.then_adopt.remove(&id.0)
        else {
            return;
        };
        let held =
            |gate: &crate::fleet::LeaseGate| gate.is_open() && gate.answered().host_epoch == under;
        if under.is_some() && !self.lease.as_ref().is_some_and(held) {
            let _ = reply.send(Err(HostError::NotAdmitted));
            return;
        }
        match result {
            Ok(()) => self.adopt(id, config, owner, from_files, reply),
            Err(error) => {
                let _ = reply.send(Err(error.clone()));
            }
        }
    }

    /// Takes in the control service's rulings on the sandboxes this host
    /// listed when it registered: keeps each it is told to under the owner
    /// epoch it names, with the agent link that epoch's ticket gives, drops
    /// the rest, keeping the store's copies, and adopts again those whose
    /// copy here is behind the store's. Answers once every drop is done, so
    /// the new lease lets only what the service gave this host run.
    pub(super) fn reconcile(&mut self, rulings: Vec<Ruling>, reply: Reply<()>) {
        if let Some((&id, _)) = self.blocked.first_key_value() {
            let _ = reply.send(Err(HostError::Blocked {
                id: Id(id),
                reason: "a sandbox the host does not manage may still run a VM another host now \
                         runs; remove it before the host registers"
                    .into(),
            }));
            return;
        }
        let mut rulings: HashMap<_, _> = rulings
            .into_iter()
            .map(|ruling| (ruling.id, (ruling.verdict, ruling.link)))
            .collect();
        let mut waits = Vec::new();
        for record in self.records.all() {
            if record.ready {
                continue;
            }
            let id = record.id;
            let (verdict, link) = rulings.remove(&id).unwrap_or((Verdict::Drop, None));
            let (done, answer) = oneshot::channel();
            match verdict {
                Verdict::Keep { owner_epoch } => {
                    let owner = OwnerEpoch(owner_epoch);
                    if record.removing {
                        continue;
                    }
                    if owner == record.owner() {
                        // Kept as it was, unless its link changed.
                        if record.config.link == link {
                            continue;
                        }
                        self.take_owner(id, Change::new().link(link), done);
                        waits.push((id, answer));
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
                    self.take_owner(id, Change::new().owner(owner).link(link), done);
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
                Verdict::Refetch { owner_epoch, whole } => {
                    let mut config = record.config.clone();
                    config.link = link;
                    let then = Then {
                        config,
                        owner: OwnerEpoch(owner_epoch),
                        from_files: !whole,
                        reply: done,
                        under: None,
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
/// Fails with [`io::ErrorKind::AlreadyExists`], having made nothing, when
/// the sandbox's directory is already there.
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

/// The copy `claimed` names, taken up from its files alone with
/// `from_files`: its memory image is deleted from the store first, as the
/// claim's next save, so a later adopt or wake never restores it. A try
/// whose answer was lost finds the change done; an adopt tried again
/// claims the copy without the image and leaves it be. Deleting the image
/// raises [`Alarm::ProgramsLost`], as a VM that died does: the sandbox
/// boots fresh from its disk, and whatever ran in it is gone.
async fn files_only<S: Store>(
    store: &S,
    observer: &Observer,
    id: Id,
    owner: OwnerEpoch,
    claimed: Claimed,
    from_files: bool,
) -> Result<Claimed, HostError> {
    if !from_files || !claimed.memory {
        return Ok(claimed);
    }
    let change = Stamp {
        epoch: owner,
        save: claimed.save + 1,
    };
    match store.forget_memory(id, change).await {
        Err(error) => Err(HostError::Io(error.to_string())),
        Ok(Owned::Fenced { by }) => Err(HostError::Superseded {
            id,
            held: by.0,
            asked: owner.0,
        }),
        Ok(Owned::Done(None)) => Err(HostError::NoCopy(id)),
        Ok(Owned::Done(Some(receipt))) => {
            tracing::info!(%id, "adopted from its files: its last owner was lost, so its memory image may be stale");
            let what =
                "running programs lost: adopted from its files, its memory image may be stale";
            observer.alarm(
                Alarm::ProgramsLost,
                alarm_event(what).with("compute.sandbox.id", id.to_string()),
            );
            Ok(Claimed {
                save: change.save,
                receipt,
                memory: false,
                disk_bytes: claimed.disk_bytes,
            })
        }
    }
}

/// Makes `record` that of a sandbox kept only in the store, as `claimed`
/// left it, owned under `owner`.
fn remote_record(record: &mut Record, owner: OwnerEpoch, claimed: &Claimed) {
    record.disk = Disk::Remote;
    record.image = claimed.memory;
    record.archived = true;
    record.owner_epoch = owner.0;
    record.saves = claimed.save;
    record.allocation.disk_bytes = Some(claimed.disk_bytes);
}
