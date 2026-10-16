//! Two classes of object-storage transfer on one host.
//!
//! **Foreground** transfers are ones a sandbox is waiting on right now: the
//! disk, state and working-set pack of a wake, and the chunks a guest
//! faults on. **Background** transfers only complete copies: hydration of
//! a woken sandbox's memory file. Both share the host's network, so a
//! hundred sandboxes waking at once would otherwise wait behind the
//! background filling of those that woke first. While any foreground
//! transfer runs, background ones are held to a few, enough that copies
//! still complete and saves waiting on them still finish.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use tokio::sync::{Semaphore, SemaphorePermit};

/// Background transfers in flight on the whole host when nothing waits.
const BACKGROUND: usize = 128;
/// Background transfers in flight while something waits on a foreground
/// one: about a quarter of the host's background width.
const BACKGROUND_WHILE_WAITED_ON: usize = 32;

/// The host's two transfer classes; see the module documentation.
#[derive(Debug)]
pub struct Lanes {
    foreground: AtomicUsize,
    background: Semaphore,
    while_waited_on: Semaphore,
}

impl Default for Lanes {
    fn default() -> Self {
        Self {
            foreground: AtomicUsize::new(0),
            background: Semaphore::new(BACKGROUND),
            while_waited_on: Semaphore::new(BACKGROUND_WHILE_WAITED_ON),
        }
    }
}

impl Lanes {
    /// Marks foreground transfers under way until the guard drops.
    #[must_use]
    pub fn foreground(self: &Arc<Self>) -> Foreground {
        self.foreground.fetch_add(1, Ordering::AcqRel);
        Foreground(Arc::clone(self))
    }

    /// Waits for a background transfer slot. A slot taken while anything
    /// foreground is under way also takes one of the few kept for that
    /// time; one taken while all was quiet keeps going if foreground work
    /// starts, which costs at most one transfer's time.
    pub async fn background(&self) -> Background<'_> {
        let slot = self.background.acquire().await.ok();
        let narrow = if self.foreground.load(Ordering::Acquire) > 0 {
            self.while_waited_on.acquire().await.ok()
        } else {
            None
        };
        Background {
            _slot: slot,
            _narrow: narrow,
        }
    }

    #[cfg(test)]
    fn waited_on(&self) -> usize {
        self.foreground.load(Ordering::Acquire)
    }
}

/// Foreground transfers are under way while this lives.
#[derive(Debug)]
pub struct Foreground(Arc<Lanes>);

impl Drop for Foreground {
    fn drop(&mut self) {
        self.0.foreground.fetch_sub(1, Ordering::AcqRel);
    }
}

/// A background transfer's slot, released when it drops.
#[derive(Debug)]
pub struct Background<'a> {
    _slot: Option<SemaphorePermit<'a>>,
    _narrow: Option<SemaphorePermit<'a>>,
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// How many background slots can be held at once right now.
    async fn width(lanes: &Lanes) -> usize {
        let mut held = Vec::new();
        while let Ok(slot) =
            tokio::time::timeout(Duration::from_millis(20), lanes.background()).await
        {
            held.push(slot);
        }
        held.len()
    }

    #[tokio::test]
    async fn background_narrows_while_anything_waits_on_the_foreground() {
        let lanes = Arc::new(Lanes::default());
        assert_eq!(width(&lanes).await, BACKGROUND);
        let waited_on = lanes.foreground();
        let again = lanes.foreground();
        assert_eq!(lanes.waited_on(), 2);
        assert_eq!(width(&lanes).await, BACKGROUND_WHILE_WAITED_ON);
        drop(waited_on);
        assert_eq!(width(&lanes).await, BACKGROUND_WHILE_WAITED_ON);
        drop(again);
        assert_eq!(lanes.waited_on(), 0);
        assert_eq!(width(&lanes).await, BACKGROUND);
    }

    #[tokio::test]
    async fn a_narrowed_transfer_frees_both_of_its_slots() {
        let lanes = Arc::new(Lanes::default());
        let waited_on = lanes.foreground();
        let narrowed = lanes.background().await;
        assert_eq!(width(&lanes).await, BACKGROUND_WHILE_WAITED_ON - 1);
        drop(narrowed);
        assert_eq!(width(&lanes).await, BACKGROUND_WHILE_WAITED_ON);
        drop(waited_on);
        assert_eq!(width(&lanes).await, BACKGROUND);
    }
}
