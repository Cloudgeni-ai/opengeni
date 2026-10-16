//! Requests from handles, checked against each sandbox's generation.

use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use compute_core::{HoldId, Input, Level, Priority, Step};
use compute_engine::Engine;

use crate::layout::{Images, Paths, copy_sparse, sync_parent};
use crate::protocol::{BlockedSandbox, HostStatus, Id, SandboxConfig, SandboxStatus, step_name};
use crate::state::{Record, check_generation};
use crate::store::Store;

use super::{Command, Event, HostAgent, HostError, Reply};

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
                let result = self.check(id, generation).and_then(|()| {
                    if self.slots.contains_key(&id.0) {
                        Ok(())
                    } else {
                        Err(HostError::NotFound(id))
                    }
                });
                if result.is_ok() {
                    self.input(Input::Touch {
                        sandbox: id.0,
                        priority,
                    });
                }
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
                hold,
                ttl,
                priority,
                reply,
            } => {
                let result = self
                    .check(id, generation)
                    .and_then(|()| self.hold(id, hold, ttl, priority));
                let _ = reply.send(result);
            }
            Command::Unhold {
                id,
                generation,
                hold,
                reply,
            } => {
                let result = self
                    .check(id, generation)
                    .and_then(|()| self.unhold(id, hold));
                let _ = reply.send(result);
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
                let _ = reply.send(Err(HostError::Broken(id)));
                return;
            };
            if let Err(error) = check_generation(&record, generation) {
                let _ = reply.send(Err(error.into()));
                return;
            }
            self.blocked.remove(&id.0);
            self.remove_recorded(&record, None, vec![reply]);
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

    pub(super) fn unhold(&mut self, id: Id, hold: HoldId) -> Result<(), HostError> {
        if !self.slots.contains_key(&id.0) {
            return Err(HostError::NotFound(id));
        }
        self.input(Input::Release {
            sandbox: id.0,
            hold,
        });
        Ok(())
    }

    pub(super) fn acquire(
        &mut self,
        id: Id,
        generation: Option<u64>,
        hold: HoldId,
        priority: Priority,
        reply: Reply<PathBuf>,
    ) {
        if let Err(error) = self.check(id, generation) {
            let _ = reply.send(Err(error));
            return;
        }
        let Some(slot) = self.slots.get_mut(&id.0).filter(|slot| !slot.destroy) else {
            let _ = reply.send(Err(HostError::NotFound(id)));
            return;
        };
        slot.waiters.push((generation, reply));
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
            return Err(HostError::Broken(id));
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

    pub(super) fn hold(
        &mut self,
        id: Id,
        hold: HoldId,
        ttl: Option<Duration>,
        priority: Priority,
    ) -> Result<(), HostError> {
        if self.slots.get(&id.0).is_none_or(|slot| slot.destroy) {
            return Err(HostError::NotFound(id));
        }
        let until = ttl.map(|ttl| self.now() + ttl);
        self.input(Input::Hold {
            sandbox: id.0,
            hold,
            until,
            priority,
        });
        Ok(())
    }

    pub(super) fn create(&mut self, id: Id, config: SandboxConfig, reply: Reply<()>) {
        if self.blocked.contains_key(&id.0) {
            let _ = reply.send(Err(HostError::Broken(id)));
            return;
        }
        if self.slots.contains_key(&id.0)
            || self.preparing.contains(&id.0)
            || self.destroying.contains_key(&id.0)
            || self.records.get(id).is_some()
        {
            let _ = reply.send(Err(HostError::Exists(id)));
            return;
        }
        if self.tearing_down.contains_key(&id.0) {
            // An old VM of this id is still being torn down; its teardown
            // must not touch the new sandbox's files.
            let _ = reply.send(Err(HostError::Busy(id)));
            return;
        }
        let policy = match self.sleep_policy(&config) {
            Ok(policy) => policy,
            Err(error) => {
                let _ = reply.send(Err(HostError::Invalid(error)));
                return;
            }
        };
        if policy.rules().archive_after.is_some() && !self.store.is_configured() {
            let _ = reply.send(Err(HostError::Invalid(
                "this host has no store, so sandboxes cannot be archived".into(),
            )));
            return;
        }
        self.preparing.insert(id.0);
        let ordinal = self.take_ordinal();
        let allocation = match self.images.allocate(ordinal) {
            Ok(allocation) => allocation,
            Err(problem) => {
                self.preparing.remove(&id.0);
                self.ordinals.remove(&ordinal);
                let _ = reply.send(Err(HostError::Invalid(problem)));
                return;
            }
        };
        let record = Record::new(id, ordinal, allocation, config);
        let link = Images::link(&record);
        let paths = Paths::new(&self.root, id);
        let dir = paths.dir.clone();
        let base = self.base_image.clone();
        let records = Arc::clone(&self.records);
        let net = self.net.clone();
        let events = self.events_tx.clone();
        tokio::spawn(async move {
            let networks = net.clone();
            let prepared = tokio::task::spawn_blocking(move || {
                // The directory must be new: one already there belongs to a
                // sandbox this agent does not know, and is left alone.
                std::fs::create_dir(&paths.dir)?;
                std::fs::create_dir_all(&paths.jail)?;
                copy_sparse(&base, &paths.disk)?;
                // The record, written next, vouches for these: their
                // directory entries must outlast a crash first.
                sync_parent(&paths.disk)?;
                sync_parent(&paths.jail)?;
                if let (Some(net), Some(link)) = (&networks, &link) {
                    net.ensure(link)?;
                }
                Ok(())
            })
            .await
            .unwrap_or_else(|error| Err(io::Error::other(error)));
            // The record goes last: a directory without one is an
            // unfinished creation and is cleaned up on recovery.
            let result = match prepared {
                Ok(()) => records.insert(record).await.map_err(HostError::from),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    tracing::error!(%id, "a directory for a new sandbox already exists; refusing it");
                    let _ = events.send(Event::Prepared {
                        id,
                        ordinal,
                        result: Err(HostError::Exists(id)),
                        reply,
                    });
                    return;
                }
                Err(error) => Err(HostError::Io(error.to_string())),
            };
            if result.is_err() {
                // The id stays reserved until this is done, so it cannot
                // remove a newer sandbox's files or network.
                if let Some(net) = net {
                    let _ = tokio::task::spawn_blocking(move || net.remove_for(id)).await;
                }
                let _ = tokio::fs::remove_dir_all(&dir).await;
            }
            let _ = events.send(Event::Prepared {
                id,
                ordinal,
                result,
                reply,
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
                    memory_saved: view.state.keeps_programs(),
                    step: view.step.map(|step| step_name(step).to_owned()),
                    holds: view.holds,
                    resident_bytes: slot
                        .vm
                        .as_ref()
                        .and_then(|live| self.engine.resident_bytes(&live.vm).ok()),
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
        }
    }
}
