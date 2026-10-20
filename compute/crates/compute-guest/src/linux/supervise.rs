//! Children of PID 1: starting them, and reaping them and every orphan.
//!
//! PID 1 inherits every orphan in the guest, so it reaps any child that
//! ends, not only its own. [`Children`] keeps the processes it started and
//! tells whoever waits on one when it ends. Reaping and starting share one
//! lock: a child that fails to start is waited on by the standard library
//! itself, so the reaper must not take it first, and a child that ends at
//! once is reaped only after it is registered.

use std::collections::HashMap;
use std::io;
use std::process::Command;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Mutex, PoisonError};

use super::sys::{self, Exit};

/// The processes PID 1 started and waits on.
#[derive(Debug, Default)]
pub struct Children {
    waiting: Mutex<HashMap<i32, Sender<Exit>>>,
}

impl Children {
    /// Starts `command`. The receiver gets how it ended.
    pub fn spawn(&self, command: &mut Command) -> io::Result<(i32, Receiver<Exit>)> {
        let mut waiting = self.waiting.lock().unwrap_or_else(PoisonError::into_inner);
        let child = command.spawn()?;
        let pid = i32::try_from(child.id()).map_err(|_| io::Error::other("pid out of range"))?;
        let (sender, receiver) = channel();
        waiting.insert(pid, sender);
        Ok((pid, receiver))
    }

    /// Reaps every child that has ended, telling those waiting on one.
    pub fn reap(&self) {
        let mut waiting = self.waiting.lock().unwrap_or_else(PoisonError::into_inner);
        while let Some((pid, exit)) = sys::reap() {
            if let Some(sender) = waiting.remove(&pid) {
                let _ = sender.send(exit);
            }
        }
    }

    /// Sends `signal` to `pid` if it is a child that has not ended yet,
    /// so never to a process that took over the number of one reaped.
    pub fn signal(&self, pid: i32, signal: libc::c_int) -> io::Result<()> {
        let waiting = self.waiting.lock().unwrap_or_else(PoisonError::into_inner);
        if waiting.contains_key(&pid) {
            sys::kill(pid, signal)
        } else {
            Ok(())
        }
    }
}

/// The new command, for the program at `path`, starting with no signal
/// blocked. All children go through here.
pub fn command(path: &str) -> Command {
    let mut command = Command::new(path);
    sys::unblock_signals(&mut command);
    command
}
