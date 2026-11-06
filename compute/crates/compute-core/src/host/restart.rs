//! Restarting a sandbox where it is: [`Input::Restart`].
//!
//! A restart ends the sandbox's programs and keeps its files, without
//! moving it: no copy of it goes to object storage first, so it takes as
//! long as ending a VM and deleting a memory image, whatever the store's
//! speed. Nothing saved is lost on the way: the files on local disk, its
//! newest copy, stay, and so does the copy in object storage, whose memory
//! image alone is forgotten, as the [`Step::Forget`] of a long-idle sandbox
//! forgets it.

#[cfg(doc)]
use super::Input;
use super::{Action, Host};
use crate::ids::SandboxId;
use crate::level::Step;
use crate::sandbox::Restart;

impl Host {
    /// Takes in [`Input::Restart`]. Asked again, its VM is asked to end
    /// again, in case the host could not end it the first time.
    pub(super) fn restart(&mut self, sandbox: SandboxId) {
        if let Some(slot) = self.sandboxes.get_mut(&sandbox)
            && !slot.is_broken()
        {
            slot.restart = Some(Restart { ending: false });
            self.mark(sandbox);
        }
    }

    /// Moves a restart of `id` on: cancels a step under way, other than a
    /// boot, which starts it afresh already, or the forget the restart
    /// waits for; ends its VM once no step holds it; and ends the restart
    /// once it has neither a VM nor a memory image. The forget itself is
    /// its next step ([`crate::sandbox::Sandbox::next_step`]).
    pub(super) fn settle_restart(&mut self, id: SandboxId, out: &mut Vec<Action>) {
        let Some(slot) = self.sandboxes.get_mut(&id) else {
            return;
        };
        let Some(restart) = slot.restart else {
            return;
        };
        if slot.is_broken() {
            slot.restart = None;
            return;
        }
        match &mut slot.in_flight {
            Some(flight) if flight.step == Step::Boot => slot.restart = None,
            Some(flight) => {
                if flight.step != Step::Forget && !flight.cancel_sent {
                    flight.cancel_sent = true;
                    out.push(Action::Cancel {
                        sandbox: id,
                        op: flight.op,
                    });
                }
            }
            None if slot.state.level.has_process() => {
                if !restart.ending {
                    slot.restart = Some(Restart { ending: true });
                    out.push(Action::EndForRestart { sandbox: id });
                }
            }
            None if !slot.state.memory_saved => slot.restart = None,
            None => {}
        }
    }
}
