//! Two classes of object-storage transfer on one host.
//!
//! **Foreground** transfers are ones a sandbox is waiting on right now: the
//! disk, state and working-set pack of a wake, and the chunks a guest
//! faults on. **Background** transfers only complete copies: hydration of
//! a woken sandbox's memory file. Both share the host's network, so a
//! hundred sandboxes waking at once would otherwise wait behind the
//! background filling of those that woke first. While any foreground
//! transfer runs, background ones are held to a few, enough that copies
//! still complete and saves waiting on them still finish. Once nothing
//! foreground remains, every background transfer may run again, those
//! queued for one of the few included.

use std::sync::Arc;

use tokio::sync::{Semaphore, SemaphorePermit, watch};

/// Background transfers in flight on the whole host when nothing waits.
const BACKGROUND: usize = 128;
/// Background transfers in flight while something waits on a foreground
/// one: about a quarter of the host's background width.
const BACKGROUND_WHILE_WAITED_ON: usize = 32;

/// The host's two transfer classes; see the module documentation.
#[derive(Debug)]
pub struct Lanes {
    /// How many foreground transfers are under way.
    foreground: watch::Sender<usize>,
    background: Semaphore,
    while_waited_on: Semaphore,
}

impl Default for Lanes {
    fn default() -> Self {
        Self {
            foreground: watch::Sender::new(0),
            background: Semaphore::new(BACKGROUND),
            while_waited_on: Semaphore::new(BACKGROUND_WHILE_WAITED_ON),
        }
    }
}

impl Lanes {
    /// Marks foreground transfers under way until the guard drops.
    #[must_use]
    pub fn foreground(self: &Arc<Self>) -> Foreground {
        self.foreground.send_modify(|waited_on| *waited_on += 1);
        Foreground(Arc::clone(self))
    }

    /// Waits for a background transfer slot. A slot taken while anything
    /// foreground is under way also takes one of the few kept for that
    /// time, or waits until nothing foreground remains; one taken while
    /// all was quiet keeps going if foreground work starts, which costs at
    /// most one transfer's time.
    pub async fn background(&self) -> Background<'_> {
        let slot = self.background.acquire().await.ok();
        let mut quiet = self.foreground.subscribe();
        // Both waits can be dropped unfinished: a permit granted to the
        // losing one goes back to its semaphore.
        let narrow = tokio::select! {
            biased;
            _ = quiet.wait_for(|waited_on| *waited_on == 0) => None,
            narrow = self.while_waited_on.acquire() => narrow.ok(),
        };
        Background {
            _slot: slot,
            _narrow: narrow,
        }
    }

    #[cfg(test)]
    fn waited_on(&self) -> usize {
        *self.foreground.borrow()
    }
}

/// Foreground transfers are under way while this lives.
#[derive(Debug)]
pub struct Foreground(Arc<Lanes>);

impl Drop for Foreground {
    fn drop(&mut self) {
        self.0.foreground.send_modify(|waited_on| *waited_on -= 1);
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

    /// Transfers queued for one of the few slots kept while something
    /// waits all start once the last wait ends, rather than one by one as
    /// the narrowed ones finish.
    #[tokio::test]
    async fn queued_transfers_widen_once_nothing_waits() {
        let lanes = Arc::new(Lanes::default());
        let waited_on = lanes.foreground();
        let mut running = Vec::new();
        for _ in 0..BACKGROUND_WHILE_WAITED_ON {
            running.push(lanes.background().await);
        }
        let queued = futures::future::join_all(
            (0..BACKGROUND - BACKGROUND_WHILE_WAITED_ON).map(|_| lanes.background()),
        );
        tokio::pin!(queued);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut queued)
                .await
                .is_err(),
            "queued transfers ran beyond the narrow width while a wait was under way"
        );
        drop(waited_on);
        let started = tokio::time::timeout(Duration::from_secs(5), queued)
            .await
            .expect("queued transfers stayed narrow after the last wait ended");
        assert_eq!(started.len(), BACKGROUND - BACKGROUND_WHILE_WAITED_ON);
        assert_eq!(running.len(), BACKGROUND_WHILE_WAITED_ON);
    }
}
