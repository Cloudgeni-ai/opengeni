//! Warns of a turn of the agent's loop that took long, naming what it
//! did: the loop answers nothing meanwhile, not even what the host can
//! take on, and a stall such as #6976's could then only be seen from the
//! lease's side, which cannot say where the loop was.

use std::time::{Duration, Instant};

/// A turn this long is warned of: well before the lease, which renews
/// every few seconds and reads what the host can take on as it does,
/// warns of a reading that waited two renewals.
const SLOW: Duration = Duration::from_secs(2);

/// One turn of the loop, from its start until it is dropped.
pub(super) struct Turn {
    what: &'static str,
    started: Instant,
}

impl Turn {
    /// A turn doing `what`, starting now.
    pub(super) fn of(what: &'static str) -> Self {
        Self {
            what,
            started: Instant::now(),
        }
    }
}

impl Drop for Turn {
    fn drop(&mut self) {
        let took = self.started.elapsed();
        if took >= SLOW {
            tracing::warn!(
                turn = self.what,
                took_ms = u64::try_from(took.as_millis()).unwrap_or(u64::MAX),
                "a turn of the agent's loop took long: it answered nothing meanwhile"
            );
        }
    }
}
