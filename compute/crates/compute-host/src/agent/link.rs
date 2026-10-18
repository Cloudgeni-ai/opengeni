//! Each sandbox's agent link, on a host that keeps them
//! ([ADR 21](../../../../docs/adr/0021-opengeni-runs-natively-its-agent-behind-the-hosts-link.md)):
//! the guest's connections to [`AGENT_LINK_PORT`] go to the host's
//! [`compute_link::Hub`], and the sandbox is attached to it with the link
//! its record names, for as long as the host holds it. The hub keeps the
//! session open while the sandbox sleeps, and wakes it for a message.

use std::sync::Arc;

use compute_engine::{Engine, VmSpec};
use compute_protocol::link::AGENT_LINK_PORT;

use super::{HostAgent, Toucher};
use crate::guest_ports::{self, Activity, Listeners};
use crate::protocol::Id;
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
    /// connection closed at once.
    pub(super) fn listen_link(&self, id: Id, spec: &VmSpec) -> Option<Listeners> {
        let hub = self.link.clone()?;
        let sandbox = id.to_string();
        let serve = move |stream| hub.serve(sandbox.clone(), stream);
        match guest_ports::listen_link(
            &spec.vsock_path(),
            AGENT_LINK_PORT,
            (spec.uid, spec.gid),
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
    /// names, or detaches it when the record names none.
    pub(super) fn link_as_recorded(&self, id: Id) {
        let (Some(hub), Some(slot)) = (&self.link, self.slots.get(&id.0)) else {
            return;
        };
        match self.records.get(id).and_then(|record| record.config.link) {
            Some(link) => {
                let wake = Toucher {
                    id,
                    commands: self.commands_tx.clone(),
                };
                hub.attach(
                    id.to_string(),
                    link,
                    slot.paths.dir.join(SESSION_FILE),
                    Arc::new(wake),
                );
            }
            None => hub.detach(&id.to_string()),
        }
    }

    /// Sandbox `id` leaves the host: its agent's session ends.
    pub(super) fn unlink(&self, id: Id) {
        if let Some(hub) = &self.link {
            hub.detach(&id.to_string());
        }
    }
}
