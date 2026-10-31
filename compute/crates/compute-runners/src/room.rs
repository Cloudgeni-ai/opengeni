//! A pool's places: the most sandboxes it has at once, which its runners
//! and its warm template's builder share, so a refresh never takes the
//! pool past its maximum.
//!
//! A builder takes a place only while GitHub has assigned the pool fewer
//! jobs than it has places, and idle runners make way for it. While it
//! holds one, the pool keeps at most one runner fewer and tells GitHub it
//! takes one job fewer; a job beyond that waits for the refresh to end.

use std::sync::Arc;

use tokio::sync::watch;

/// What the pool holds, as it last said, and whether a builder holds a
/// place.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Held {
    /// Whether the pool has said since it began to lead: what it holds
    /// is not known before, nor while another replica leads.
    known: bool,
    /// The pool's runners, those starting too.
    runners: usize,
    /// The jobs GitHub has assigned the pool.
    assigned: u32,
    /// Whether a builder holds a place.
    building: bool,
}

/// A pool's places, shared with its builder.
#[derive(Clone, Debug)]
pub struct Room {
    places: u32,
    held: Arc<watch::Sender<Held>>,
}

/// A builder's place, given back when dropped.
#[derive(Debug)]
pub struct Place(Room);

impl Drop for Place {
    fn drop(&mut self) {
        self.0.held.send_modify(|held| held.building = false);
    }
}

impl Room {
    /// A pool's `places`: its most runners at once.
    #[must_use]
    pub fn new(places: u32) -> Self {
        Self {
            places,
            held: Arc::new(watch::Sender::new(Held::default())),
        }
    }

    /// Whether a builder holds a place.
    #[must_use]
    pub fn building(&self) -> bool {
        self.held.borrow().building
    }

    /// The places runners may have now: all but a builder's.
    #[must_use]
    pub fn for_runners(&self) -> u32 {
        self.places.saturating_sub(u32::from(self.building()))
    }

    /// The pool says it holds `runners` and GitHub has assigned it
    /// `assigned` jobs, and asks how many runners it may have: `wanted`
    /// given the places runners may have. Those it lacks are counted as
    /// held from now on, before they start, so a builder never takes a
    /// place a runner is starting in.
    pub fn hold(&self, runners: usize, assigned: u32, wanted: impl FnOnce(u32) -> usize) -> usize {
        let mut target = 0;
        self.held.send_if_modified(|held| {
            target = wanted(self.places.saturating_sub(u32::from(held.building)));
            let said = Held {
                known: true,
                runners: runners.max(target),
                assigned,
                building: held.building,
            };
            let changed = *held != said;
            *held = said;
            changed
        });
        target
    }

    /// The pool no longer leads, and what it holds is no longer known.
    pub fn forget(&self) {
        self.held.send_if_modified(|held| {
            let changed = held.known;
            held.known = false;
            changed
        });
    }

    /// Takes a place for a builder: once the pool has said what it holds
    /// and has been assigned fewer jobs than it has places, then, keeping
    /// the place, waits for a runner to make way if the pool holds them
    /// all. Dropping the future before then gives the place back.
    pub async fn take(&self) -> Place {
        let mut seen = self.held.subscribe();
        loop {
            let mut taken = false;
            self.held.send_if_modified(|held| {
                taken = held.known && !held.building && held.assigned < self.places;
                if taken {
                    held.building = true;
                }
                taken
            });
            if taken {
                break;
            }
            // The room holds the sender, so this waits for a change.
            let _ = seen.changed().await;
        }
        let place = Place(self.clone());
        let places = usize::try_from(self.places).unwrap_or(usize::MAX);
        let _ = seen.wait_for(|held| held.runners < places).await;
        place
    }

    /// Waits until a builder takes a place, when `building` is false, or
    /// gives it back, when true.
    pub async fn moved(&self, building: bool) {
        let mut seen = self.held.subscribe();
        let _ = seen.wait_for(|held| held.building != building).await;
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    async fn soon<T>(future: impl Future<Output = T>) -> Option<T> {
        tokio::time::timeout(Duration::from_millis(100), future)
            .await
            .ok()
    }

    /// How a pool wanting `most` runners answers, given the places runners
    /// may have.
    fn wanting(most: u32) -> impl FnOnce(u32) -> usize {
        move |places| usize::try_from(most.min(places)).unwrap()
    }

    #[tokio::test]
    async fn a_builder_waits_until_the_pool_has_said_and_its_jobs_leave_a_place() {
        let room = Room::new(2);
        assert!(soon(room.take()).await.is_none(), "the pool has not said");
        assert_eq!(room.hold(2, 2, wanting(2)), 2);
        assert!(
            soon(room.take()).await.is_none(),
            "two jobs fill both places"
        );
        assert_eq!(room.hold(2, 1, wanting(1)), 1);
        let taking = tokio::spawn({
            let room = room.clone();
            async move { room.take().await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(room.building(), "the place is taken at once");
        assert_eq!(room.for_runners(), 1);
        assert!(!taking.is_finished(), "while the runner idle stays");
        assert_eq!(
            room.hold(2, 1, wanting(2)),
            1,
            "runners get the places the builder leaves"
        );
        // The idle runner goes.
        room.hold(1, 1, wanting(2));
        let place = soon(taking).await.expect("a place").unwrap();
        assert!(soon(room.take()).await.is_none(), "one builder at a time");
        drop(place);
        assert!(!room.building());
        assert_eq!(room.for_runners(), 2);
    }

    #[tokio::test]
    async fn a_builder_waits_while_another_replica_leads() {
        let room = Room::new(2);
        room.hold(0, 0, |_| 0);
        room.forget();
        assert!(soon(room.take()).await.is_none());
        room.hold(0, 0, |_| 0);
        assert!(soon(room.take()).await.is_some());
    }

    #[tokio::test]
    async fn a_take_given_up_gives_its_place_back() {
        let room = Room::new(1);
        room.hold(1, 0, |_| 1);
        assert!(soon(room.take()).await.is_none(), "the idle runner stays");
        assert!(!room.building(), "a take given up holds nothing");
    }

    #[tokio::test]
    async fn moves_are_seen() {
        let room = Room::new(2);
        room.hold(0, 0, |_| 0);
        assert!(soon(room.moved(false)).await.is_none());
        let place = room.take().await;
        assert!(soon(room.moved(false)).await.is_some());
        assert!(soon(room.moved(true)).await.is_none());
        drop(place);
        assert!(soon(room.moved(true)).await.is_some());
    }
}
