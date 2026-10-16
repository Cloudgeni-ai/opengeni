//! Requests from handles, checked against each sandbox's generation.

use std::io;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use compute_core::{Durability, HoldId, Input, Level, Priority, Step};
use compute_engine::Engine;

use crate::layout::{Images, Paths, sync_parent};
use crate::pool::{Shape, Sources, Start, Template, first_files};
use crate::protocol::{BlockedSandbox, HostStatus, Id, SandboxConfig, SandboxStatus, step_name};
use crate::state::{Identity, Record, check_generation};
use crate::step::images_of;
use crate::store::Store;

use super::holds::{Write, hold_id};
use super::{Command, Event, HostAgent, HostError, Reply, Waiter, Woke, unix_ms_now};

/// Replies to `reply` once the write in `outcome` has made a change
/// durable, or with why the change was refused or could not be kept.
fn answer_once_written(outcome: Result<Write, HostError>, reply: Reply<()>) {
    match outcome {
        Ok(write) => {
            tokio::spawn(async move {
                let result = write
                    .await
                    .map_err(|error| HostError::Io(format!("keeping the holds failed: {error}")));
                let _ = reply.send(result);
            });
        }
        Err(error) => {
            let _ = reply.send(Err(error));
        }
    }
}

/// Makes a new sandbox's directory and first files, from `template` where
/// one fits. Blocks.
pub(super) fn new_files(
    paths: &Paths,
    base: &Path,
    template: Option<(&Template, &Sources)>,
) -> io::Result<Start> {
    // The directory must be new: one already there belongs to a sandbox
    // this agent does not know, and is left alone.
    std::fs::create_dir(&paths.dir)?;
    std::fs::create_dir(&paths.jail)?;
    let start = first_files(paths, &images_of(paths), base, template)?;
    // The record, written next, vouches for these: their directory entries
    // must outlast a crash first, all the way up to the one in the
    // sandboxes' directory.
    sync_parent(&paths.disk)?;
    sync_parent(&paths.jail)?;
    sync_parent(&paths.dir)?;
    Ok(start)
}

impl<E: Engine, S: Store> HostAgent<E, S> {
    pub(super) fn on_command(&mut self, command: Command) {
        match command {
            Command::Create { id, config, reply } => self.create(id, config, reply),
            Command::Remove {
                id,
                generation,
                reply,
            } => self.remove(id, generation, reply),
            Command::Touch {
                id,
                generation,
                priority,
                reply,
            } => {
                let result = self.touch(id, generation, priority);
                if let Some(reply) = reply {
                    let _ = reply.send(result);
                }
            }
            Command::Check {
                id,
                generation,
                reply,
            } => {
                let result = match self.records.get(id) {
                    Some(record) => check_generation(&record, Some(generation)).map_err(Into::into),
                    None => Err(HostError::Removed(id)),
                };
                let _ = reply.send(result);
            }
            Command::Sleep {
                id,
                generation,
                level,
                reply,
            } => {
                let result = self
                    .check(id, generation)
                    .and_then(|()| self.request_sleep(id, level));
                let _ = reply.send(result);
            }
            Command::Hold {
                id,
                generation,
                name,
                ttl,
                priority,
                reply,
            } => {
                let outcome = self
                    .check(id, generation)
                    .and_then(|()| self.hold(id, name, ttl, priority));
                answer_once_written(outcome, reply);
            }
            Command::Unhold {
                id,
                generation,
                name,
                reply,
            } => {
                let outcome = self
                    .check(id, generation)
                    .and_then(|()| self.unhold(id, &name));
                answer_once_written(outcome, reply);
            }
            Command::Acquire {
                id,
                generation,
                hold,
                priority,
                reply,
            } => self.acquire(id, generation, hold, priority, reply),
            Command::Release { id, hold } => {
                if self.slots.contains_key(&id.0) {
                    self.input(Input::Release {
                        sandbox: id.0,
                        hold,
                    });
                }
            }
            Command::Status { reply } => {
                let _ = reply.send(self.status());
            }
        }
    }

    pub(super) fn remove(&mut self, id: Id, generation: Option<u64>, reply: Reply<()>) {
        if self.blocked.contains_key(&id.0) {
            // A blocked sandbox with a readable record can still be removed:
            // removal stops whatever VM it has and retries any removal that
            // stopped part way.
            let Some(record) = self.records.get(id) else {
                match self.leftovers.get(&id.0) {
                    Some(&left) => self.remove_leftovers(id, left, reply),
                    None => {
                        let _ = reply.send(Err(self.blocked_error(id)));
                    }
                }
                return;
            };
            if let Err(error) = check_generation(&record, generation) {
                let _ = reply.send(Err(error.into()));
                return;
            }
            self.blocked.remove(&id.0);
            self.remove_recorded(&record, None, vec![reply], None);
            return;
        }
        if let Err(error) = self.check(id, generation) {
            let _ = reply.send(Err(error));
            return;
        }
        if let Some(slot) = self.slots.get_mut(&id.0) {
            slot.removers.push(reply);
            self.input(Input::Remove { sandbox: id.0 });
        } else if let Some(removers) = self.destroying.get_mut(&id.0) {
            removers.push(reply);
        } else if self.preparing.contains(&id.0) {
            let _ = reply.send(Err(HostError::Busy(id)));
        } else {
            let _ = reply.send(Err(HostError::NotFound(id)));
        }
    }

    /// Marks sandbox `id` used now, if it exists at `generation`.
    fn touch(
        &mut self,
        id: Id,
        generation: Option<u64>,
        priority: Priority,
    ) -> Result<(), HostError> {
        self.check(id, generation)?;
        if !self.slots.contains_key(&id.0) {
            return Err(HostError::NotFound(id));
        }
        self.input(Input::Touch {
            sandbox: id.0,
            priority,
        });
        Ok(())
    }

    /// Ends named hold `name`, returning the write that makes its end
    /// durable. If it was already gone, an earlier release may still be
    /// on its way to disk, or have failed to get there: the write then
    /// resolves once that release is kept.
    pub(super) fn unhold(&mut self, id: Id, name: &str) -> Result<Write, HostError> {
        let Some(slot) = self.slots.get_mut(&id.0) else {
            return Err(HostError::NotFound(id));
        };
        let write = if slot.holds.remove(name) {
            slot.holds.write(unix_ms_now())
        } else {
            slot.holds.flush()
        };
        self.input(Input::Release {
            sandbox: id.0,
            hold: hold_id(name),
        });
        Ok(write)
    }

    pub(super) fn acquire(
        &mut self,
        id: Id,
        generation: Option<u64>,
        hold: HoldId,
        priority: Priority,
        reply: Reply<Woke>,
    ) {
        if let Err(error) = self.check(id, generation) {
            let _ = reply.send(Err(error));
            return;
        }
        let during = self.core.sandbox(id.0).and_then(|view| view.step);
        let Some(slot) = self.slots.get_mut(&id.0).filter(|slot| !slot.destroy) else {
            let _ = reply.send(Err(HostError::NotFound(id)));
            return;
        };
        slot.waiters.push(Waiter {
            generation,
            during,
            reply,
        });
        self.input(Input::Hold {
            sandbox: id.0,
            hold,
            until: None,
            priority,
        });
        self.settle(id);
    }

    /// Refuses a request that names an execution the sandbox no longer
    /// runs.
    pub(super) fn check(&self, id: Id, generation: Option<u64>) -> Result<(), HostError> {
        if self.blocked.contains_key(&id.0) {
            return Err(self.blocked_error(id));
        }
        match self.records.get(id) {
            Some(record) => Ok(check_generation(&record, generation)?),
            None => Ok(()),
        }
    }

    pub(super) fn request_sleep(&mut self, id: Id, level: Level) -> Result<(), HostError> {
        if !self.slots.contains_key(&id.0) {
            return Err(HostError::NotFound(id));
        }
        if level >= Level::Archived && !self.store.is_configured() {
            return Err(HostError::Invalid(
                "this host has no store, so sandboxes cannot be archived".into(),
            ));
        }
        if level >= Level::Saved
            && self
                .core
                .sandbox(id.0)
                .is_some_and(|view| view.unsavable && view.state.durability == Durability::Volatile)
        {
            return Err(HostError::Invalid(format!(
                "sandbox {id}'s VM may have lost disk writes, so it cannot be saved; \
                 it sleeps no deeper than compressed until its VM is replaced"
            )));
        }
        if level == Level::Compressed && !self.can_compress {
            return Err(HostError::Invalid(
                "this host cannot compress memory; ask for saved instead".into(),
            ));
        }
        self.input(Input::Sleep {
            sandbox: id.0,
            level,
        });
        Ok(())
    }

    /// Holds sandbox `id` awake for `name`, returning the write that makes
    /// the hold durable.
    pub(super) fn hold(
        &mut self,
        id: Id,
        name: String,
        ttl: Option<Duration>,
        priority: Priority,
    ) -> Result<Write, HostError> {
        if self.slots.get(&id.0).is_none_or(|slot| slot.destroy) {
            return Err(HostError::NotFound(id));
        }
        let until = ttl.map(|ttl| self.now() + ttl);
        self.input(Input::Hold {
            sandbox: id.0,
            hold: hold_id(&name),
            until,
            priority,
        });
        let now_ms = unix_ms_now();
        let lapses_ms = ttl
            .map(|ttl| now_ms.saturating_add(u64::try_from(ttl.as_millis()).unwrap_or(u64::MAX)));
        let slot = self.slots.get_mut(&id.0).ok_or(HostError::NotFound(id))?;
        slot.holds.set(name, lapses_ms);
        Ok(slot.holds.write(now_ms))
    }

    /// The refusal of a request for blocked sandbox `id`.
    fn blocked_error(&self, id: Id) -> HostError {
        HostError::Blocked {
            id,
            reason: self.blocked.get(&id.0).cloned().unwrap_or_default(),
        }
    }

    /// The answer to creating `id` with `config` when no work is needed: a
    /// refusal, or success for a repeat of a create that already happened.
    fn create_answer(&self, id: Id, config: &SandboxConfig) -> Option<Result<(), HostError>> {
        if self.blocked.contains_key(&id.0) {
            return Some(Err(self.blocked_error(id)));
        }
        if let Err(problem) = self.ordinals_known() {
            return Some(Err(HostError::Io(problem)));
        }
        if self.preparing.contains(&id.0) {
            // Perhaps this very create's earlier attempt: retrying once it
            // is done tells.
            return Some(Err(HostError::Busy(id)));
        }
        let record = self.records.get(id);
        if self.slots.contains_key(&id.0)
            || self.destroying.contains_key(&id.0)
            || self.hosts.contains_key(&id.0)
            || record.is_some()
        {
            // Creating is idempotent: a client retrying a create whose reply
            // it lost finds the sandbox it asked for. One with other
            // settings, or on its way out, is someone else's.
            let same = self.slots.get(&id.0).is_some_and(|slot| !slot.destroy)
                && !self.destroying.contains_key(&id.0)
                && record.is_some_and(|record| !record.removing && record.config == *config);
            return Some(if same {
                Ok(())
            } else {
                Err(HostError::Exists(id))
            });
        }
        if self.tearing_down.contains_key(&id.0) {
            // An old VM of this id is still being torn down; its teardown
            // must not touch the new sandbox's files.
            return Some(Err(HostError::Busy(id)));
        }
        match self.sleep_policy(config) {
            Err(error) => Some(Err(HostError::Invalid(error))),
            Ok(policy) if policy.rules().archive_after.is_some() && !self.store.is_configured() => {
                Some(Err(HostError::Invalid(
                    "this host has no store, so sandboxes cannot be archived".into(),
                )))
            }
            Ok(_) => None,
        }
    }

    pub(super) fn create(&mut self, id: Id, config: SandboxConfig, reply: Reply<()>) {
        if let Some(answer) = self.create_answer(id, &config) {
            let _ = reply.send(answer);
            return;
        }
        self.template_used(Shape::of(&config));
        let Some((config, reply)) = self.claim(id, config, reply) else {
            return;
        };
        let ordinal = match self.take_ordinal() {
            Ok(ordinal) => ordinal,
            Err(problem) => {
                let _ = reply.send(Err(HostError::Io(problem)));
                return;
            }
        };
        self.preparing.insert(id.0);
        let allocation = match self.images.allocate(ordinal) {
            Ok(allocation) => allocation,
            Err(problem) => {
                self.preparing.remove(&id.0);
                self.ordinals.remove(&ordinal);
                let _ = reply.send(Err(HostError::Invalid(problem)));
                return;
            }
        };
        let template = self.template_for(Shape::of(&config));
        let sources = self.warm.as_ref().map(|warm| Arc::clone(&warm.sources));
        let mut record = Record::new(id, ordinal, allocation, config);
        let link = Images::link(&record);
        let paths = Paths::new(&self.root, id);
        let dir = paths.dir.clone();
        let base = self.base_image.clone();
        let records = Arc::clone(&self.records);
        let net = self.net.clone();
        let events = self.events_tx.clone();
        tokio::spawn(async move {
            let networks = net.clone();
            let from = template.clone();
            let prepared = tokio::task::spawn_blocking(move || {
                let warm = from.as_deref().zip(sources.as_deref());
                let start = new_files(&paths, &base, warm)?;
                if let (Some(net), Some(link)) = (&networks, &link) {
                    net.ensure(link)?;
                }
                Ok(start)
            })
            .await
            .unwrap_or_else(|error| Err(io::Error::other(error)));
            let stale = match prepared {
                Ok(Start::Stale) => template,
                _ => None,
            };
            // The record goes last: a directory without one is an
            // unfinished creation and is cleaned up on recovery.
            let result = match prepared {
                Ok(start) => {
                    // A sandbox started from a template holds a memory image
                    // of a guest that never ran as it: its first wake
                    // restores it.
                    // It learns which sandbox it is from the restore notice.
                    if start == Start::Template {
                        record.image = true;
                        record.identity = Identity::Pending;
                    }
                    records.insert(record).await.map_err(HostError::from)
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    tracing::error!(%id, "a directory for a new sandbox already exists; refusing it");
                    let _ = events.send(Event::Prepared {
                        id,
                        ordinal,
                        result: Err(HostError::Exists(id)),
                        reply,
                        stale,
                    });
                    return;
                }
                Err(error) => Err(HostError::Io(error.to_string())),
            };
            if result.is_err() {
                // The id stays reserved until this is done, so it cannot
                // remove a newer sandbox's files or network.
                if let Some(net) = net {
                    let _ =
                        tokio::task::spawn_blocking(move || net.remove(id, Some(ordinal))).await;
                }
                let _ = tokio::fs::remove_dir_all(&dir).await;
            }
            let _ = events.send(Event::Prepared {
                id,
                ordinal,
                result,
                reply,
                stale,
            });
        });
    }

    pub(super) fn status(&self) -> HostStatus {
        let mut sandboxes: Vec<SandboxStatus> = self
            .slots
            .iter()
            .filter_map(|(id, slot)| {
                let view = self.core.sandbox(*id)?;
                let record = self.records.get(Id(*id));
                Some(SandboxStatus {
                    id: Id(*id),
                    generation: record.as_ref().map_or(0, |record| record.generation),
                    revision: record.as_ref().map_or(0, |record| record.revision),
                    level: view.state.level.into(),
                    durability: view.state.durability.into(),
                    backed_up_ms: record.as_ref().and_then(|record| record.backed_up_ms),
                    memory_saved: view.state.keeps_programs(),
                    step: view.step.map(|step| step_name(step).to_owned()),
                    holds: view.holds,
                    launches: slot.launches,
                    resident_bytes: slot
                        .vm
                        .as_ref()
                        .and_then(|live| self.engine.resident_bytes(&live.vm).ok()),
                    unsavable: view.unsavable,
                    broken: view.broken,
                })
            })
            .collect();
        sandboxes.sort_by_key(|sandbox| sandbox.id);
        let steps = Step::ALL
            .iter()
            .map(|step| {
                let mut stats = self.stats[step.index()];
                stats.in_flight = self.core.in_flight(*step);
                (step_name(*step).to_owned(), stats)
            })
            .collect();
        #[cfg(target_os = "linux")]
        let store_stalled_ms = self
            .fetcher
            .as_ref()
            .and_then(|fetcher| fetcher.stalled_for())
            .map(|stalled| u64::try_from(stalled.as_millis()).unwrap_or(u64::MAX));
        #[cfg(not(target_os = "linux"))]
        let store_stalled_ms = None;
        HostStatus {
            sandboxes,
            steps,
            available_memory: self.available_memory,
            reclaimable_memory: self.core.reclaimable_memory(),
            blocked: self
                .blocked
                .iter()
                .map(|(id, problem)| BlockedSandbox {
                    id: Id(*id),
                    problem: problem.clone(),
                })
                .collect(),
            templates: {
                let mut templates = self
                    .warm
                    .as_ref()
                    .map(|warm| warm.pool.status())
                    .unwrap_or_default();
                self.ready.status(&mut templates, &self.ready_usage());
                templates
            },
            store_stalled_ms,
            unseen_activity: self.unseen_activity,
            about: self.about.clone(),
        }
    }
}
