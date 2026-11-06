//! Whether this process runs, or just ran, a command.
//!
//! A stop signal names its sender, but a short-lived sender (`/bin/kill`,
//! `sh -c 'kill …'`, the last `kill` of a script) has often exited, and been
//! reaped, before the receiver can look it up. Such a sender cannot be placed.
//! While a command runs, or shortly after one ended, it most likely was that
//! command (see `signal_sender::Sender::Gone`).

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// Commands running now.
static RUNNING: AtomicUsize = AtomicUsize::new(0);
/// When the last command ended, in milliseconds since [`EPOCH`] plus one; 0
/// when none has ended yet.
static LAST_ENDED: AtomicU64 = AtomicU64::new(0);
static EPOCH: OnceLock<Instant> = OnceLock::new();

fn now_millis() -> u64 {
    let epoch = *EPOCH.get_or_init(Instant::now);
    u64::try_from(epoch.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// Held for as long as one command (an exec's process group or a terminal's
/// shell) may still run.
#[derive(Debug)]
pub(crate) struct RunningCommand(());

impl RunningCommand {
    pub(crate) fn start() -> Self {
        let _ = now_millis();
        RUNNING.fetch_add(1, Ordering::SeqCst);
        Self(())
    }
}

impl Drop for RunningCommand {
    fn drop(&mut self) {
        // The end time first: whoever sees no command running sees it.
        LAST_ENDED.store(now_millis().saturating_add(1), Ordering::SeqCst);
        RUNNING.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Whether a command runs now or ended no longer than `window` ago.
#[must_use]
pub fn commands_ran_within(window: Duration) -> bool {
    if RUNNING.load(Ordering::SeqCst) > 0 {
        return true;
    }
    let ended = LAST_ENDED.load(Ordering::SeqCst);
    ended != 0 && u128::from(now_millis().saturating_sub(ended - 1)) <= window.as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_running_command_counts_until_shortly_after_it_ended() {
        let command = RunningCommand::start();
        assert!(commands_ran_within(Duration::ZERO));
        drop(command);
        assert!(commands_ran_within(Duration::from_secs(60)));
    }
}
