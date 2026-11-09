//! Restarting a sandbox where it is ([`crate::protocol::Request::Restart`]):
//! its VM ends without being saved and its memory image is forgotten, here
//! and in the store, so its next wake boots it from its files on this host.
//! The core sequences it ([`compute_core::Input::Restart`]); the agent ends
//! the VM when asked and answers once the core says it is done.
//!
//! Nothing is stored first, so a restart takes as long as ending a VM,
//! whatever the store's speed, and the sandbox's newest copy, its files
//! here, is never given up. A wake asked meanwhile waits and then boots it.

use std::collections::HashMap;

use compute_core::{Input, SandboxId};
use compute_engine::Engine;

use super::{End, HostAgent, HostError, Reply};
use crate::protocol::Id;
use crate::store::Store;

/// Restarts under way, with who waits for each.
pub(super) type Restarts = HashMap<SandboxId, Vec<Reply<()>>>;

impl<E: Engine, S: Store> HostAgent<E, S> {
    /// Restarts sandbox `id` where it is, answering `reply` once its VM has
    /// ended and its memory image is gone. Refused while it is being
    /// created, removed or handed off, and for a broken sandbox. Asked
    /// again while one is under way, it joins it.
    pub(super) fn restart(&mut self, id: Id, reply: Reply<()>) {
        let refused = if self.blocked.contains_key(&id.0) {
            Some(self.blocked_error(id))
        } else if self.handing_off.contains_key(&id.0) {
            Some(HostError::HandingOff(id))
        } else if self.records.get(id).is_none() {
            Some(
                if self.destroying.contains_key(&id.0) || self.settling(id) {
                    HostError::Busy(id)
                } else {
                    HostError::NotFound(id)
                },
            )
        } else if self.destroying.contains_key(&id.0)
            || self.settling(id)
            || self.slots.get(&id.0).is_none_or(|slot| slot.destroy)
        {
            Some(HostError::Busy(id))
        } else if self.core.sandbox(id.0).is_none_or(|view| view.broken) {
            Some(HostError::Broken(id))
        } else {
            None
        };
        if let Some(error) = refused {
            let _ = reply.send(Err(error));
            return;
        }
        tracing::info!(%id, "restarting from its files where it is");
        self.restarting.entry(id.0).or_default().push(reply);
        self.input(Input::Restart { sandbox: id.0 });
        self.continue_restart(id);
    }

    /// Answers the waiters of a restart of `id` once the core no longer
    /// restarts it: done, broken on the way, or given up with its memory
    /// image kept, which could not be forgotten, so it wakes from its last
    /// save.
    pub(super) fn continue_restart(&mut self, id: Id) {
        if !self.restarting.contains_key(&id.0) {
            return;
        }
        if self.core.restarting(id.0) {
            return;
        }
        let result = match self.core.sandbox(id.0) {
            Some(view) if view.broken => Err(HostError::Broken(id)),
            Some(view) if view.state.memory_saved && !view.state.level.has_process() => {
                Err(HostError::Io(format!(
                    "sandbox {id}'s saved memory image could not be forgotten, so it was not \
                     restarted; it wakes from its last save"
                )))
            }
            Some(_) => Ok(()),
            None => Err(HostError::Removed(id)),
        };
        for waiter in self.restarting.remove(&id.0).unwrap_or_default() {
            let _ = waiter.send(result.clone());
        }
    }

    /// Ends `id`'s running VM for a restart, without saving it. The core
    /// asks only while no step holds the VM; one that is gone already is
    /// reported lost on its own.
    pub(super) fn end_for_restart(&mut self, id: Id) {
        let Some(incarnation) = self
            .slots
            .get(&id.0)
            .and_then(|slot| slot.vm.as_ref())
            .map(|live| live.incarnation)
        else {
            return;
        };
        tracing::info!(%id, "ending a VM without a save, for a restart");
        self.lost_vm(id, incarnation, End::ForRestart);
    }
}
