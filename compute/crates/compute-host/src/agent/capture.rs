//! Copying a saved sandbox's disk for a capture
//! ([`crate::protocol::Request::Capture`], ADR 22).
//!
//! The copy is made here, in the agent's own loop, because that is what
//! orders it with the sandbox's steps: the decision core starts a step
//! only from this loop, so while the copy is made no wake can begin, and
//! the copy is of the disk exactly as its last save left it. Its guest
//! wrote its disks out before that save, so the copy is whole without the
//! memory saved beside it. It shares the disk's blocks, so making it takes
//! a few milliseconds whatever the disk's size, and a guest that wakes
//! afterwards writes new blocks of its own, which its disk's growth books
//! as for any write to a shared block. A host whose files cannot share
//! blocks takes no capture: copying the bytes would hold up every other
//! sandbox here meanwhile.

use std::path::Path;

use compute_core::Level;
use compute_engine::Engine;

use super::{Command, Handle, HostAgent, HostError};
use crate::capture::{Begun, CaptureProgress};
use crate::protocol::{Id, valid_capture_key};
use crate::store::Store;

impl Handle {
    /// Stores sandbox `id`'s disk as a sandbox image, if it is saved here
    /// (see [`crate::protocol::Request::Capture`]). The first ask with
    /// `key` copies the disk and starts storing the copy, answering
    /// [`CaptureProgress::Capturing`]; asks with the same key then learn
    /// how the store stands. With a `generation`, only while the sandbox is
    /// still at it.
    ///
    /// # Errors
    ///
    /// [`HostError::Awake`] while the sandbox is awake, waking, holds or is
    /// not saved here; [`HostError::CannotCapture`] on a host with no store
    /// or whose files cannot share blocks; [`HostError::Io`] once for a
    /// store that failed, after which the next ask copies again.
    pub async fn capture(
        &self,
        id: Id,
        generation: Option<u64>,
        key: &str,
    ) -> Result<CaptureProgress, HostError> {
        if !valid_capture_key(key) {
            return Err(HostError::Invalid(format!(
                "capture key {key:?} is not 1 to 64 letters, digits, - and _"
            )));
        }
        let Some(captures) = &self.captures else {
            return Err(HostError::CannotCapture(
                "it has no store to keep images in".into(),
            ));
        };
        match captures.begin(key) {
            Begun::Known(progress) => Ok(progress),
            Begun::Failed(message) => Err(HostError::Io(format!(
                "storing capture {key} failed: {message}"
            ))),
            Begun::Copy => {
                let into = captures.path(key);
                let copied = self
                    .ask(|reply| Command::Capture {
                        id,
                        generation,
                        into,
                        reply,
                    })
                    .await
                    .and_then(|copied| copied);
                match copied {
                    Ok(length) => {
                        captures.copied(key, length);
                        Ok(CaptureProgress::Capturing)
                    }
                    Err(error) => {
                        captures.not_copied(key);
                        Err(error)
                    }
                }
            }
        }
    }
}

impl<E: Engine, S: Store> HostAgent<E, S> {
    /// Copies sandbox `id`'s disk to the new file `into`, if it is saved
    /// here with nothing under way and nothing wanting it awake, and
    /// answers the copy's length.
    pub(super) fn capture(
        &self,
        id: Id,
        generation: Option<u64>,
        into: &Path,
    ) -> Result<u64, HostError> {
        if !self.store.is_configured() {
            return Err(HostError::CannotCapture(
                "it has no store to keep images in".into(),
            ));
        }
        if !self.shares_extents() {
            return Err(HostError::CannotCapture(
                "its files cannot share blocks, so a copy would take as long as the disk".into(),
            ));
        }
        self.check(id, generation)?;
        self.not_handing_off(id)?;
        if self.settling(id) || self.destroying.contains_key(&id.0) {
            return Err(HostError::Busy(id));
        }
        let slot = self
            .slots
            .get(&id.0)
            .filter(|slot| !slot.destroy)
            .ok_or(HostError::NotFound(id))?;
        let view = self.core.sandbox(id.0).ok_or(HostError::NotFound(id))?;
        let saved_here = matches!(view.state.level, Level::Saved | Level::Archived);
        if view.broken {
            return Err(HostError::Broken(id));
        }
        if !saved_here
            || view.step.is_some()
            || view.wants_awake
            || slot.vm.is_some()
            || slot.op.is_some()
            || slot.deferred.is_some()
        {
            return Err(HostError::Awake(id));
        }
        let copied = (|| {
            // The VMM that ran in the jail may have left a link to a host
            // file or a pipe in the disk's place: open it as a jailed file.
            let disk = crate::layout::open_jailed(&slot.paths.disk)?;
            let length = disk.metadata()?.len();
            remove_if_there(into)?;
            crate::layout::copy_file(&disk, into)?;
            Ok::<_, std::io::Error>(length)
        })();
        copied.map_err(|error| {
            let _ = remove_if_there(into);
            HostError::Io(format!("copying sandbox {id}'s disk: {error}"))
        })
    }
}

fn remove_if_there(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}
