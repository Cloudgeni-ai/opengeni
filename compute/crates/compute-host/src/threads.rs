//! How many threads the agent runs, sized to the host.
//!
//! The agent's own work is small next to its sandboxes': answering
//! requests, driving steps, moving chunks to and from object storage, and
//! compressing memory and disks before upload. Async workers spend their
//! time on store requests (TLS, and decoding fetched chunks); compression
//! is the only work that keeps a processor busy for long, so it gets its
//! own bound, and blocking threads otherwise mostly wait on local disk.
//! None of it should grow with the host's processor count: every processor
//! the agent takes is one its sandboxes do not get. See
//! `docs/measurements.md` for what these defaults were measured against.

use std::num::NonZeroUsize;

/// The agent's thread counts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Threads {
    /// Async worker threads.
    pub workers: usize,
    /// Most threads for blocking work: file and disk work, compression.
    pub blocking: usize,
    /// Most chunks compressed at once across the host, each on a blocking
    /// thread.
    pub compress: usize,
}

impl Threads {
    /// The defaults for a host of `cores` processors: a quarter of them,
    /// from 2 to 8, for async workers and for compression each, and 64
    /// blocking threads more than compression may hold.
    #[must_use]
    pub fn for_cores(cores: usize) -> Self {
        let quarter = (cores / 4).clamp(2, 8);
        Self {
            workers: quarter,
            blocking: quarter + 64,
            compress: quarter,
        }
    }

    /// The defaults for this host.
    #[must_use]
    pub fn for_host() -> Self {
        Self::for_cores(std::thread::available_parallelism().map_or(1, NonZeroUsize::get))
    }
}

#[cfg(test)]
mod tests {
    use super::Threads;

    #[test]
    fn thread_counts_stay_small_on_large_hosts() {
        assert_eq!(
            Threads::for_cores(1),
            Threads {
                workers: 2,
                blocking: 66,
                compress: 2
            }
        );
        assert_eq!(Threads::for_cores(16).workers, 4);
        let large = Threads::for_cores(192);
        assert_eq!((large.workers, large.compress), (8, 8));
        assert!(large.blocking < 512, "{large:?}");
    }
}
