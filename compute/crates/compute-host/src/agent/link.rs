//! Each sandbox's agent link, on a host that keeps them
//! ([ADR 21](../../../../docs/adr/0021-opengeni-runs-natively-its-agent-behind-the-hosts-link.md)):
//! the guest's connections to [`AGENT_LINK_PORT`] go to the host's
//! [`compute_link::Hub`], and the sandbox is attached to it with the link
//! its record names, for as long as the host holds it. The hub keeps the
//! session open while the sandbox sleeps, and wakes it for a message.

use std::sync::Arc;

use compute_engine::{Engine, VmSpec};
use compute_protocol::link::{AGENT_LINK_PORT, Running};

use super::{HostAgent, Level, Toucher};
use crate::guest_ports::{self, Activity, Listeners};
use crate::protocol::Id;
use crate::resume::RunClock;
use crate::store::Store;

/// The file in a sandbox's directory holding its agent's session, which
/// the hub opens again when the host starts.
const SESSION_FILE: &str = "agent-link.json";

impl compute_link::Wake for Toucher {
    fn wake(&self) {
        Activity::wake(self);
    }
}

impl<E: Engine, S: Store> HostAgent<E, S> {
    /// Listens for sandbox `id`'s connections to its agent link, on a host
    /// that keeps agent links. A sandbox the hub has no link for has each
    /// connection closed at once. `clock` counts the time its guest could
    /// run (see [`Self::tell_clocks`]).
    pub(super) fn listen_link(&self, id: Id, spec: &VmSpec, clock: &RunClock) -> Option<Listeners> {
        let hub = self.link.clone()?;
        let sandbox = id.to_string();
        let named: std::sync::Arc<str> = sandbox.as_str().into();
        let serve = move |stream| hub.serve(sandbox.clone(), stream);
        match guest_ports::listen_link(
            named,
            &spec.vsock_path(),
            AGENT_LINK_PORT,
            (spec.uid, spec.gid),
            clock.clone(),
            serve,
        ) {
            Ok(listeners) => Some(listeners),
            Err(error) => {
                tracing::error!(%id, %error, "could not listen for agent-link connections");
                None
            }
        }
    }

    /// Attaches sandbox `id` to the hub with the agent link its record
    /// names, or detaches it when the record names none. Each write of its
    /// session keeps a share of the root's ownership until it lands, so a
    /// successor reads the sessions only after.
    pub(super) fn link_as_recorded(&self, id: Id) {
        let (Some(hub), Some(slot)) = (&self.link, self.slots.get(&id.0)) else {
            return;
        };
        match self.records.get(id).and_then(|record| record.config.link) {
            Some(link) => {
                let wake = Toucher {
                    id,
                    commands: self.commands_tx.clone(),
                    by: super::observe::By::AgentLink,
                };
                hub.attach(
                    id.to_string(),
                    link,
                    slot.paths.dir.join(SESSION_FILE),
                    Arc::new(self.records.ownership()),
                    Arc::new(wake),
                );
                self.tell_link(id);
            }
            None => hub.detach(&id.to_string()),
        }
    }

    /// Tells the hub whether sandbox `id` runs, for its gateway to show and
    /// to count awake time by. The hub passes on only changes, and tells
    /// each session that opens.
    pub(super) fn tell_link(&self, id: Id) {
        let Some(hub) = &self.link else {
            return;
        };
        if self
            .records
            .get(id)
            .is_none_or(|record| record.config.link.is_none())
        {
            return;
        }
        let Some(view) = self.core.sandbox(id.0) else {
            return;
        };
        let running = if view.state.level == Level::Running {
            Running::Awake
        } else {
            Running::Asleep
        };
        hub.running(&id.to_string(), running);
    }

    /// Sandbox `id` leaves the host: its agent's session ends.
    pub(super) fn unlink(&self, id: Id) {
        if let Some(hub) = &self.link {
            hub.detach(&id.to_string());
        }
    }

    /// Tells each sandbox's agent-link streams whether its guest can run
    /// now: its VM runs, with no step that pauses it, and the lease lets
    /// VMs run. Streams its guest has not taken up again end only after
    /// it could run for a while, since it takes them up as soon as it
    /// runs.
    pub(super) fn tell_clocks(&self) {
        if self.link.is_none() {
            return;
        }
        let acting = self.may_act();
        for (id, slot) in &self.slots {
            let runs = acting
                && slot.vm.is_some()
                && self
                    .core
                    .sandbox(*id)
                    .is_some_and(|view| view.state.level == Level::Running && view.step.is_none());
            slot.link_clock.set(runs);
        }
    }
}
