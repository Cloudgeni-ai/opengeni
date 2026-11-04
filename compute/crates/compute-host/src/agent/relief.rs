//! What disk relief may free besides sandboxes' local copies (ADR 30):
//! what the host keeps on local disk only to go faster, templates with
//! their ready sandboxes and cached images, while nothing uses them.
//!
//! The agent measures them, and the local copies of idle archived
//! sandboxes, every [`MEASURE_EVERY`] samples, counting only what removing each
//! frees at least (see [`freed_by_removing`]), and tells the core
//! ([`Input::Cache`], [`Input::LocalCopy`]). The core counts them as room
//! a create, adopt or wake may book, and when one books it asks for those
//! least recently used first to go ([`compute_core::Action::RemoveCache`],
//! or an eviction for a copy). Whether one is in use is checked again
//! before it goes: one in use stays and is forgotten until measured free.
//!
//! Every removal, by disk relief or by the week rule, is an event,
//! `compute.disk.freed`, with its kind, the bytes measured and why.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use compute_core::{CacheId, DiskSpace, Input, Level, Outcome, SandboxId, Step};
use compute_engine::Engine;
use tokio::time::Instant;

use crate::disk_growth::freed_by_removing;
use crate::layout::Paths;
use crate::observe::{Event as Observed, Observer, Severity};
use crate::pool::{self, Shape, Template};
use crate::protocol::ImageId;
use crate::step::local_copy;
use crate::store::Store;

use super::disk::AfterReading;
use super::{Event, HostAgent};

/// How many samples apart what disk relief may free is measured: half a
/// minute at a sample a second.
const MEASURE_EVERY: u32 = 30;

/// Something the host keeps only to go faster.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum Kept {
    /// A shape's template, with its ready sandboxes.
    Template(Shape),
    /// A cached image.
    Image(ImageId),
}

impl Kept {
    /// Its kind's name on events.
    fn kind(self) -> &'static str {
        match self {
            Self::Template(_) => "template",
            Self::Image(_) => "image",
        }
    }
}

/// What one measurement found free to remove.
#[derive(Debug, Default)]
pub(super) struct Measured {
    /// What is kept only to go faster, with what removing it frees and
    /// when it was last used.
    kept: Vec<(Kept, DiskSpace, SystemTime)>,
    /// Idle archived sandboxes, with what giving up their local copy
    /// frees.
    copies: Vec<(SandboxId, DiskSpace)>,
}

/// The agent's side of disk relief.
#[derive(Debug, Default)]
pub(super) struct Relief {
    /// When the last measurement began.
    measured: Option<Instant>,
    /// Whether one is under way.
    measuring: bool,
    /// The core's name for each thing kept, while it is reported.
    ids: HashMap<Kept, CacheId>,
    /// What each name stands for, with what removing it frees.
    kept: HashMap<CacheId, (Kept, DiskSpace)>,
    /// Those being removed.
    removing: HashSet<CacheId>,
    /// The last name given.
    last: u64,
    /// What giving up each idle archived sandbox's local copy frees, as
    /// last measured.
    copies: HashMap<SandboxId, DiskSpace>,
    /// When the week rule last looked for unused images, from the first
    /// sample on.
    images_retired: Option<Instant>,
}

impl Relief {
    /// Whether the week rule is to look for unused images again, at most
    /// `every`, and not before `every` after the first sample.
    pub(super) fn retire_images_now(&mut self, every: Duration) -> bool {
        let last = self.images_retired.get_or_insert_with(Instant::now);
        if last.elapsed() < every {
            return false;
        }
        *last = Instant::now();
        true
    }

    /// The core's name for `kept`, given now if it has none.
    fn id(&mut self, kept: Kept) -> CacheId {
        *self.ids.entry(kept).or_insert_with(|| {
            self.last += 1;
            CacheId(self.last)
        })
    }

    /// Forgets `cache`, returning what it stood for.
    fn forget(&mut self, cache: CacheId) -> Option<(Kept, DiskSpace)> {
        self.removing.remove(&cache);
        let forgotten = self.kept.remove(&cache)?;
        self.ids.remove(&forgotten.0);
        Some(forgotten)
    }

    /// What removing `kept` frees, as last measured; nothing if unknown.
    fn measured(&self, kept: Kept) -> DiskSpace {
        self.ids
            .get(&kept)
            .and_then(|id| self.kept.get(id))
            .map(|(_, disk)| *disk)
            .unwrap_or_default()
    }
}

/// What one template or image to measure is, where its files are, and
/// when it was last used if known.
type Measure = (Kept, Vec<PathBuf>, Option<SystemTime>);

impl<E: Engine, S: Store> HostAgent<E, S> {
    /// Measures what disk relief may free, in the background, at most
    /// every [`MEASURE_EVERY`] samples and only on a host that books its
    /// disk; [`Event::ReliefMeasured`] brings the result.
    pub(super) fn measure_relief(&mut self) {
        let every = self.sample_every * MEASURE_EVERY;
        let relief = &mut self.relief;
        if relief.measuring
            || relief.measured.is_some_and(|at| at.elapsed() < every)
            || self.core.disk().is_none()
        {
            return;
        }
        relief.measuring = true;
        relief.measured = Some(Instant::now());
        let mut measure: Vec<Measure> = self
            .free_templates()
            .into_iter()
            .map(|(template, ready)| {
                let shape = template.shape();
                let last = self.warm.as_ref().and_then(|warm| warm.uses.last(shape));
                let mut paths = vec![template.dir().to_path_buf()];
                paths.extend(ready);
                (Kept::Template(shape), paths, last)
            })
            .collect();
        measure.extend(
            self.free_images()
                .into_iter()
                .map(|image| (Kept::Image(image), vec![self.rootfs.path(image)], None)),
        );
        let copies: Vec<(SandboxId, Arc<Paths>)> = self
            .slots
            .iter()
            .filter(|(id, slot)| slot.vm.is_none() && self.idle_archived(**id))
            .map(|(id, slot)| (*id, Arc::clone(&slot.paths)))
            .collect();
        let (rootfs, unit) = (Arc::clone(&self.rootfs), self.allocation_unit);
        let events = self.events_tx.clone();
        tokio::task::spawn_blocking(move || {
            let freed = |paths: &[PathBuf]| -> DiskSpace {
                paths.iter().fold(DiskSpace::default(), |sum, path| {
                    let (bytes, inodes) = freed_by_removing(path, unit).unwrap_or_default();
                    sum.add(DiskSpace { bytes, inodes })
                })
            };
            let mut measured = Measured::default();
            for (kept, paths, last) in measure {
                let last = last.or_else(|| match kept {
                    Kept::Image(image) => rootfs.last_used(image).ok(),
                    Kept::Template(_) => std::fs::metadata(&paths[0])
                        .and_then(|found| found.modified())
                        .ok(),
                });
                let disk = freed(&paths);
                if !disk.is_empty() {
                    measured.kept.push((kept, disk, last.unwrap_or(UNIX_EPOCH)));
                }
            }
            for (id, paths) in copies {
                measured.copies.push((id, freed(&local_copy(&paths))));
            }
            let _ = events.send(Event::ReliefMeasured(Box::new(measured)));
        });
    }

    /// Tells the core what a measurement found: what is kept only to go
    /// faster and still unused, forgetting what is not, and what idle
    /// archived sandboxes' local copies hold.
    pub(super) fn relief_measured(&mut self, measured: Measured) {
        self.relief.measuring = false;
        let mut inputs = Vec::new();
        let mut present = HashSet::new();
        for (kept, disk, last) in measured.kept {
            let id = self.relief.id(kept);
            present.insert(id);
            if self.relief.removing.contains(&id) {
                continue;
            }
            self.relief.kept.insert(id, (kept, disk));
            let since_epoch = last.duration_since(UNIX_EPOCH).unwrap_or_default();
            inputs.push(Input::Cache {
                cache: id,
                disk,
                last_used: self.at_unix_ms(u64::try_from(since_epoch.as_millis()).unwrap_or(0)),
            });
        }
        let gone: Vec<CacheId> = self
            .relief
            .kept
            .keys()
            .filter(|id| !present.contains(id) && !self.relief.removing.contains(id))
            .copied()
            .collect();
        for cache in gone {
            self.relief.forget(cache);
            inputs.push(Input::Cache {
                cache,
                disk: DiskSpace::default(),
                last_used: self.now(),
            });
        }
        self.relief.copies.clear();
        for (sandbox, disk) in measured.copies {
            // One that woke meanwhile is measured again once it sleeps.
            if self.idle_archived(sandbox) {
                self.relief.copies.insert(sandbox, disk);
                inputs.push(Input::LocalCopy { sandbox, disk });
            }
        }
        self.inputs(inputs);
    }

    /// Removes `cache`, as disk relief asks, if nothing uses it now;
    /// [`Event::CacheGone`] says whether it went. One in use, or no
    /// longer known, is forgotten.
    pub(super) fn remove_cache(&mut self, cache: CacheId) {
        let kept = self.relief.kept.get(&cache).map(|(kept, _)| *kept);
        let removal = match kept {
            Some(Kept::Template(shape)) => self.retire_for_disk(shape),
            Some(Kept::Image(image)) if self.free_images().contains(&image) => {
                let rootfs = Arc::clone(&self.rootfs);
                Some(Box::pin(async move { rootfs.remove(image).await })
                    as std::pin::Pin<Box<dyn Future<Output = bool> + Send>>)
            }
            _ => None,
        };
        let Some(removal) = removal else {
            self.relief.forget(cache);
            self.input(Input::Cache {
                cache,
                disk: DiskSpace::default(),
                last_used: self.now(),
            });
            return;
        };
        self.relief.removing.insert(cache);
        let events = self.events_tx.clone();
        tokio::spawn(async move {
            let removed = removal.await;
            let _ = events.send(Event::CacheGone { cache, removed });
        });
    }

    /// The removal of `cache` ended: what it held is free once `removed`,
    /// otherwise it is forgotten until measured again.
    pub(super) fn cache_gone(&mut self, cache: CacheId, removed: bool) {
        let forgotten = self.relief.forget(cache);
        if !removed {
            self.input(Input::Cache {
                cache,
                disk: DiskSpace::default(),
                last_used: self.now(),
            });
            return;
        }
        self.input(Input::CacheRemoved { cache });
        if let Some((kept, disk)) = forgotten {
            self.disk_freed(kept.kind(), disk.bytes, "relief");
        }
    }

    /// Says that `bytes` of local disk went with something of `kind` for
    /// `reason`: `relief` for room something booked, `unused` for the
    /// week rule, `sleep` for a sandbox's own sleep policy.
    pub(super) fn disk_freed(&self, kind: &'static str, bytes: u64, reason: &'static str) {
        freed(&self.observer, kind, bytes, reason);
    }

    /// Says that the week rule removed `kept`, with what it held as last
    /// measured.
    pub(super) fn retired_unused(&self, kept: Kept) {
        self.disk_freed(kept.kind(), self.relief.measured(kept).bytes, "unused");
    }

    /// What removing each cached image frees, as last measured, for
    /// [`retired_images`].
    pub(super) fn measured_images(&self) -> HashMap<ImageId, u64> {
        self.relief
            .kept
            .values()
            .filter_map(|(kept, disk)| match kept {
                Kept::Image(image) => Some((*image, disk.bytes)),
                Kept::Template(_) => None,
            })
            .collect()
    }

    /// Whether `step` of sandbox `id`, ending with `outcome`, gave up its
    /// local copy, and if so whether disk relief asked for that: asked
    /// before the core takes the end in, while it still says so.
    pub(super) fn gave_up_copy(
        &self,
        id: SandboxId,
        step: Option<Step>,
        outcome: Outcome,
    ) -> Option<bool> {
        (step == Some(Step::Evict) && outcome == Outcome::Done).then(|| {
            self.core
                .sandbox(id)
                .is_some_and(|view| view.floor == Level::Remote)
        })
    }

    /// Says that sandbox `id`'s local copy went: for disk relief if
    /// `relieved`, else for its own sleep policy.
    pub(super) fn copy_freed(&mut self, id: SandboxId, relieved: bool) {
        let bytes = self.relief.copies.remove(&id).unwrap_or_default().bytes;
        self.disk_freed("copy", bytes, if relieved { "relief" } else { "sleep" });
    }

    /// Whether sandbox `id` is archived, idle and between steps, so its
    /// local copy may be measured.
    fn idle_archived(&self, id: SandboxId) -> bool {
        self.core.sandbox(id).is_some_and(|view| {
            view.state.level == Level::Archived && view.step.is_none() && !view.wants_awake
        })
    }

    /// The templates nothing uses now, each with the directories of its
    /// idle ready sandboxes: no create, adopt or fill copies from it or
    /// waits to, and nothing else holds it.
    fn free_templates(&self) -> Vec<(Arc<Template>, Vec<PathBuf>)> {
        let Some(warm) = &self.warm else {
            return Vec::new();
        };
        let (shapes, _) = self.waiting_uses();
        warm.pool
            .templates()
            .into_iter()
            .filter(|template| !shapes.contains(&template.shape()))
            .filter_map(|template| {
                let (idle, filling) = self.ready.of_template(&template);
                // The pool's and this one, and one for each idle ready
                // sandbox; any other is a copy or claim under way.
                let held = Arc::strong_count(&template) - 2;
                if filling || held > idle.len() {
                    return None;
                }
                let dirs = idle
                    .into_iter()
                    .map(|record| Paths::of(&self.root, record).dir)
                    .collect();
                Some((template, dirs))
            })
            .collect()
    }

    /// The cached images nothing uses now: none a kept or building
    /// template is of, or a create or fetch waits for. One a copy holds
    /// is never removed (see [`crate::rootfs::Cache::remove`]).
    fn free_images(&self) -> HashSet<ImageId> {
        let keep = self
            .warm
            .as_ref()
            .map(|warm| warm.pool.images())
            .unwrap_or_default();
        let (_, images) = self.waiting_uses();
        self.rootfs
            .images()
            .into_iter()
            .filter(|image| !keep.contains(image) && !images.contains(image))
            .collect()
    }

    /// The shapes and images of the creates and adopts that wait for a
    /// disk reading or an image.
    fn waiting_uses(&self) -> (HashSet<Shape>, HashSet<ImageId>) {
        let reading = self.after_reading.iter().filter_map(|work| match work {
            AfterReading::Create(_, config, ..) | AfterReading::Adopt(_, config, ..) => {
                Some(&**config)
            }
            AfterReading::Claimed(record, ..) => Some(&record.config),
            _ => None,
        });
        let fetching = self
            .fetching
            .values()
            .flat_map(|fetch| fetch.waiting().map(|(_, config)| config));
        let mut shapes = HashSet::new();
        let mut images: HashSet<ImageId> = self.fetching.keys().copied().collect();
        for config in reading.chain(fetching) {
            shapes.insert(Shape::of(config));
            images.extend(config.image);
        }
        (shapes, images)
    }

    /// Retires `shape`'s template for disk relief if nothing uses it now,
    /// discarding its ready sandboxes, and returns the removal of its
    /// files. A create of the shape builds it again.
    fn retire_for_disk(
        &mut self,
        shape: Shape,
    ) -> Option<std::pin::Pin<Box<dyn Future<Output = bool> + Send>>> {
        let free = self
            .free_templates()
            .into_iter()
            .any(|(template, _)| template.shape() == shape);
        if !free {
            return None;
        }
        let retired = self.warm.as_mut()?.pool.retire(shape);
        self.discard_stale_ready(shape);
        let template = retired?.template?;
        tracing::info!(%shape, "template retired for disk");
        Some(Box::pin(pool::remove(&template)))
    }
}

/// Says through `observer` that the week rule removed `images`, each with
/// what it held as `measured` (see [`HostAgent::measured_images`]).
pub(super) fn retired_images(
    observer: &Observer,
    images: &[ImageId],
    measured: &HashMap<ImageId, u64>,
) {
    for image in images {
        let bytes = measured.get(image).copied().unwrap_or(0);
        freed(observer, Kept::Image(*image).kind(), bytes, "unused");
    }
}

/// Says through `observer` that `bytes` of local disk went with something
/// of `kind` for `reason`.
fn freed(observer: &Observer, kind: &'static str, bytes: u64, reason: &'static str) {
    tracing::info!(kind, bytes, reason, "local disk freed");
    observer.emit(
        Observed::new("compute.disk.freed", Severity::Info)
            .with("compute.disk.kind", kind)
            .with("compute.disk.bytes", bytes)
            .with("compute.disk.reason", reason),
    );
}
