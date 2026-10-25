//! Which stored copies this host knows the store holds whole.
//!
//! An archive reuses the chunks an earlier copy names, at the same offsets,
//! instead of storing the same bytes again. Reusing a chunk the store has
//! lost (deleted by hand, or by a fault) would name it in the new copy too,
//! so an archive asks the store about each chunk it reuses, unless a copy
//! this host confirmed recently names it: a copy it stored or verified
//! itself, or an image it checked chunk by chunk. A confirmation lasts a
//! day. A failed verification drops the sandbox's, and every image's: the
//! archive after it asks about every chunk it reuses again, and so stores
//! again whatever is lost.
//!
//! None of this decides what a sweep may delete: everything an archive
//! reuses is named by a pointer it read after it began, which the sweep's
//! fence covers ([ADR 17](../../../docs/adr/0017-sweeping-unnamed-chunks.md)).
//! Nor does it decide whether a copy is good: eviction verifies every
//! chunk regardless ([ADR 7](../../../docs/adr/0007-never-delete-the-only-good-copy.md)).

use std::collections::HashMap;
use std::sync::{Arc, PoisonError};
use std::time::{Duration, SystemTime};

use compute_storage::chunk::ChunkRef;
use tokio::sync::Mutex;

use crate::protocol::{Id, ImageId};
use crate::store::Receipt;

/// How long a confirmation lasts. A chunk the store lost is asked about
/// again within this long by every archive that reuses it.
pub(super) const CONFIRMED_FOR: Duration = Duration::from_secs(24 * 60 * 60);

/// Whether something confirmed at `at` is still confirmed at `now`. A time
/// "in the future" by this clock is not.
pub(super) fn fresh(at: SystemTime, now: SystemTime) -> bool {
    now.duration_since(at).is_ok_and(|age| age < CONFIRMED_FOR)
}

/// The chunks of a stored image's disk, by offset, every one of which the
/// store held at `at`.
#[derive(Debug)]
pub(super) struct ImageChunks {
    /// The image pointer they come from, as stored then.
    pub receipt: Receipt,
    pub chunks: HashMap<u64, ChunkRef>,
    pub at: SystemTime,
}

type ImageSlot = Arc<Mutex<Option<Arc<ImageChunks>>>>;

/// The copies this host confirmed, and when.
#[derive(Debug, Default)]
pub(super) struct Confirmed {
    sandboxes: std::sync::Mutex<HashMap<Id, (Receipt, SystemTime)>>,
    /// One slot per image, so the archives of many sandboxes made from it
    /// wait for one check of it rather than each making their own.
    images: std::sync::Mutex<HashMap<ImageId, ImageSlot>>,
}

impl Confirmed {
    /// When the copy `receipt` of `id` was confirmed, if it was and that
    /// is still recent at `now`.
    pub(super) fn sandbox(&self, id: Id, receipt: &Receipt, now: SystemTime) -> Option<SystemTime> {
        let sandboxes = self
            .sandboxes
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        sandboxes
            .get(&id)
            .filter(|(held, at)| held == receipt && fresh(*at, now))
            .map(|(_, at)| *at)
    }

    /// Records that every chunk the copy `receipt` of `id` names was in
    /// the store at `at`.
    pub(super) fn confirm_sandbox(&self, id: Id, receipt: Receipt, at: SystemTime) {
        let mut sandboxes = self
            .sandboxes
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        sandboxes.insert(id, (receipt, at));
    }

    /// Forgets what was confirmed of `id`.
    pub(super) fn drop_sandbox(&self, id: Id) {
        let mut sandboxes = self
            .sandboxes
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        sandboxes.remove(&id);
    }

    /// The slot holding what was confirmed of `image`. Slots of images
    /// confirmed too long ago to count go as a new one is made, so a host
    /// whose images are replaced every day keeps a day of them.
    pub(super) fn image_slot(&self, image: ImageId, now: SystemTime) -> ImageSlot {
        let mut images = self.images.lock().unwrap_or_else(PoisonError::into_inner);
        if !images.contains_key(&image) {
            images.retain(|_, slot| match slot.try_lock() {
                Ok(held) => held.as_ref().is_some_and(|chunks| fresh(chunks.at, now)),
                // Being confirmed right now.
                Err(_) => true,
            });
        }
        Arc::clone(images.entry(image).or_default())
    }

    /// Forgets every image confirmed: one of their chunks may be what the
    /// store lost. A check under way finishes into a slot no archive
    /// reads any more.
    pub(super) fn drop_images(&self) {
        self.images
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }
}
