//! Ready sandboxes: restored from their shape's template before anyone
//! asks, so a create only claims one.
//!
//! A template spares a new sandbox its guest's startup, but each one
//! restored from it still waits for its VMM to load the template's state
//! and for its guest to fault its memory back in and answer. A ready
//! sandbox has done all of that ahead of time, in the background and
//! outside the decision core: cloned from the template under a name the
//! host chose, restored, left running until its guest accepts on the
//! template's ready port, then paused. A create of its shape takes the
//! oldest: one record write gives it the requested id and settings (see
//! [`Records::claim`]), and it joins the core as a paused VM whose guest
//! has yet to learn which sandbox it is. Its next resume tells it, and it
//! counts as running only once the guest has acknowledged (see
//! [`Identity::Pending`]).
//!
//! Its directory, jail, cgroup, network namespace and user stay the ones
//! it was filled under, since cgroups and namespaces cannot be renamed:
//! the record keeps that name as its host name, and every path and the
//! VM's name come from it.
//!
//! Until claimed a ready sandbox is disposable. It is never saved,
//! archived or evicted; it is removed when its template goes stale, when
//! the decision core wants its memory back, and when an agent starts. The
//! pool then fills again, a few at a time, each fill under the restore
//! limit and after every restore a sandbox waits for (see
//! [`compute_core::Input::Borrow`]).
//!
//! Memory is one book, kept by the core: every ready sandbox, filling or
//! filled, is a spare VM there (see [`compute_core::Input::Spare`]). A
//! fill starts only within [`compute_core::Host::spare_fits`], room no wake
//! wants, and is booked before it starts; the core counts ready sandboxes
//! against the admission budget and ends them first, with
//! [`compute_core::Action::Discard`], when it needs memory for a wake, its
//! buffer or pressure. A claim takes its ready sandbox off the spares and
//! counts it as unmanaged until the claimed sandbox joins the core, in the
//! same decision, so it is never counted twice or not at all.
//!
//! [`Records::claim`]: crate::state::Records::claim
//! [`Identity::Pending`]: crate::state::Identity::Pending

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use compute_core::{DiskSpace, Durability, Input, Level, Outcome, SandboxId, State, Step};
use compute_engine::{CancellationToken, Engine};
use tokio::time::Instant;

use crate::layout::{Images, Paths, vm_spec};
use crate::net::{Link, Networks};
use crate::pool::{self, Lender, Shape, Sources, Start, Template};
use crate::protocol::{Id, SandboxConfig, TemplateStatus};
use crate::state::{Identity, Record, Records};
use crate::step::{After, Job, Live, LiveMemory};
use crate::store::Store;

use super::requests::new_files;
use super::{Event, HostAgent, HostError, Reply};

/// Most ready sandboxes filled at once on a host.
const FILL_AT_ONCE: usize = 4;
/// How long a shape waits after a failed fill before the next.
const FILL_RETRY: Duration = Duration::from_secs(10);
/// Host memory a fill books beyond its template's footprint: its VMM's
/// own memory and the pages its guest touches between its restore and
/// answering on the ready port, which the template was saved right after.
const FILL_SLACK: u64 = 64 << 20;

/// A ready sandbox waiting for a create.
#[derive(Debug)]
pub(super) struct Idle<V> {
    record: Record,
    template: Arc<Template>,
    live: Live<V>,
}

/// What the ready sandboxes of one shape hold.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct ReadyUsage {
    pub count: u32,
    /// Their resident memory; a whole guest's memory for one that cannot
    /// be read.
    pub resident_bytes: u64,
}

/// The host's ready sandboxes.
#[derive(Debug)]
pub(super) struct Ready<V> {
    /// How many to keep of each shape.
    targets: BTreeMap<Shape, u32>,
    /// Paused and waiting, oldest first.
    idle: VecDeque<Idle<V>>,
    /// Being filled, by host name.
    filling: HashMap<SandboxId, Shape>,
    /// Shapes whose last fill failed, until when they wait.
    retry: HashMap<Shape, Instant>,
    /// Every ready sandbox the core counts as a spare VM, filling, filled
    /// or being removed, by host name, with the memory it booked.
    spares: HashMap<SandboxId, u64>,
    /// The name each template build's VM is counted under as a spare VM,
    /// by shape.
    pub(super) building: HashMap<Shape, Id>,
    /// Build VMs that may still run, by VM name, with the name their
    /// memory is counted under as unmanaged.
    pub(super) left_builds: HashMap<String, Id>,
    /// Ready sandboxes a create is claiming, by host name, with whether
    /// their VM ended meanwhile.
    claiming: HashMap<SandboxId, bool>,
}

impl<V> Ready<V> {
    /// Keeps `targets` of each shape.
    pub fn new(targets: BTreeMap<Shape, u32>) -> Self {
        Self {
            targets,
            idle: VecDeque::new(),
            filling: HashMap::new(),
            retry: HashMap::new(),
            spares: HashMap::new(),
            building: HashMap::new(),
            left_builds: HashMap::new(),
            claiming: HashMap::new(),
        }
    }

    /// Ready and filling sandboxes of `shape`.
    fn count(&self, shape: Shape) -> usize {
        self.idle
            .iter()
            .filter(|idle| Shape::of(&idle.record.config) == shape)
            .count()
            + self.filling.values().filter(|each| **each == shape).count()
    }

    /// Adds the ready pool's numbers, with what its ready sandboxes hold
    /// (`usage`, see [`HostAgent::ready_usage`]), to each shape's template
    /// status.
    pub fn status(&self, templates: &mut [TemplateStatus], usage: &BTreeMap<Shape, ReadyUsage>) {
        for status in templates.iter_mut() {
            let shape = Shape {
                vcpus: status.vcpus,
                memory_mib: status.memory_mib,
            };
            let held = usage.get(&shape).copied().unwrap_or_default();
            status.ready = held.count;
            status.ready_resident_bytes = held.resident_bytes;
            let filling = self.filling.values().filter(|each| **each == shape).count();
            status.filling = u32::try_from(filling).unwrap_or(u32::MAX);
            status.target = self.targets.get(&shape).copied().unwrap_or(0);
        }
    }

    /// A fill ended, returning its shape.
    fn finished(&mut self, host: SandboxId) -> Option<Shape> {
        self.filling.remove(&host)
    }
}

/// How a fill ended.
#[derive(Debug)]
pub(super) enum Filled<V> {
    /// Paused and ready, its guest warm.
    Ready {
        vm: V,
        memory: LiveMemory,
        template: Arc<Template>,
    },
    /// It failed before it had a record. Unless `cleaned`, its network may
    /// be left, so its directory stays for the next start to tidy and its
    /// ordinal stays taken until then.
    Unrecorded {
        ordinal: u32,
        cleaned: bool,
        /// The template no longer fits today's inputs.
        stale: Option<Arc<Template>>,
    },
    /// It failed with a record, and a VM if one is left; it is removed.
    Failed { vm: Option<(V, LiveMemory)> },
}

/// One fill: everything it needs away from the agent's task.
struct Fill<E: Engine, S> {
    job: Job<E, S>,
    template: Arc<Template>,
    sources: Arc<Sources>,
    base: PathBuf,
    link: Option<Link>,
    net: Option<Arc<Networks>>,
    records: Arc<Records>,
    lender: Lender,
    ready_port: u32,
    ready_timeout: Duration,
}

impl<E: Engine, S: Store> Fill<E, S> {
    /// Clones the template, records the new ready sandbox, restores it,
    /// waits for its guest and pauses it.
    async fn run(mut self) -> Filled<E::Vm> {
        let (host, ordinal) = (self.job.id, self.job.record.ordinal);
        let unrecorded = |cleaned, stale| Filled::Unrecorded {
            ordinal,
            cleaned,
            stale,
        };
        let prepared = {
            let (paths, base) = (self.job.paths.clone(), self.base.clone());
            let (template, sources) = (Arc::clone(&self.template), Arc::clone(&self.sources));
            let (net, link) = (self.net.clone(), self.link.clone());
            tokio::task::spawn_blocking(move || {
                let start = new_files(&paths, &base, Some((&template, &sources)))?;
                if start == Start::Template
                    && let (Some(net), Some(link)) = (&net, &link)
                {
                    net.ensure(link)?;
                }
                Ok::<_, std::io::Error>(start)
            })
            .await
            .unwrap_or_else(|error| Err(std::io::Error::other(error)))
        };
        let stale = matches!(prepared, Ok(Start::Stale));
        let inserted = match prepared {
            Ok(Start::Template) => self
                .records
                .insert(self.job.record.clone())
                .await
                .map_err(|error| error.to_string()),
            Ok(start) => Err(format!("the template could not be copied ({start:?})")),
            Err(error) => Err(error.to_string()),
        };
        match inserted {
            Ok(record) => self.job.record = record,
            Err(error) => {
                tracing::warn!(%host, %error, "could not fill a ready sandbox");
                let cleaned = self.forget(host, ordinal).await;
                return unrecorded(cleaned, stale.then_some(self.template));
            }
        }
        // Its restore waits behind every restore a sandbox asked for, and
        // frees its place once the VMM runs.
        let loan = self.lender.borrow(Step::Restore).await;
        self.job.unthrottle = Some(Box::new(move || drop(loan)));
        let engine = Arc::clone(&self.job.engine);
        let spec = self.job.spec.clone();
        let ran = self.job.run(Step::Restore).await;
        let (vm, memory) = match (ran.outcome, ran.after) {
            (Outcome::Done, After::New(vm, memory)) => (vm, memory),
            (outcome, after) => {
                tracing::warn!(%host, ?outcome, "a ready sandbox's restore failed");
                let vm = match after {
                    After::New(vm, memory) => Some((vm, memory)),
                    After::Kept(live) => Some((live.vm, live.memory)),
                    After::NoVm => None,
                };
                return Filled::Failed { vm };
            }
        };
        let warmed = pool::ready(&*engine, &vm, &spec, self.ready_port, self.ready_timeout).await;
        let paused = match warmed {
            Ok(()) => engine.pause(&vm).await.map_err(|error| error.to_string()),
            Err(error) => Err(error),
        };
        if let Err(error) = paused {
            tracing::warn!(%host, %error, "a ready sandbox's guest did not get ready");
            return Filled::Failed {
                vm: Some((vm, memory)),
            };
        }
        Filled::Ready {
            vm,
            memory,
            template: self.template,
        }
    }

    /// Removes what a fill made before its record existed. Returns whether
    /// its network is gone; if not, its directory stays, so the next start
    /// finds it unrecorded and tidies it.
    async fn forget(&self, host: Id, ordinal: u32) -> bool {
        if let Some(net) = self.net.clone() {
            let removed = tokio::task::spawn_blocking(move || net.remove(host, Some(ordinal)))
                .await
                .map_err(|error| error.to_string())
                .and_then(|removed| removed.map_err(|error| error.to_string()));
            if let Err(error) = removed {
                tracing::error!(%host, ordinal, %error, "a failed ready sandbox's network is left; it stays until the next start");
                return false;
            }
        }
        let _ = tokio::fs::remove_dir_all(&self.job.paths.dir).await;
        true
    }
}

/// A name for a new ready sandbox: random, so it is no sandbox's id.
fn fresh_name() -> Id {
    let mut bytes = [0_u8; 16];
    let random =
        std::fs::File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut bytes));
    if random.is_err() {
        // Unique enough on one host, and checked against every name in use.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos());
        bytes = nanos.to_le_bytes();
    }
    Id(SandboxId(u128::from_le_bytes(bytes)))
}

impl<E: Engine, S: Store> HostAgent<E, S> {
    /// Whether `id` names a sandbox, a ready sandbox or a directory the
    /// host knows of.
    fn name_taken(&self, id: Id) -> bool {
        self.slots.contains_key(&id.0)
            || self.preparing.contains(&id.0)
            || self.destroying.contains_key(&id.0)
            || self.blocked.contains_key(&id.0)
            || self.tearing_down.contains_key(&id.0)
            || self.hosts.contains_key(&id.0)
            || self.ready.filling.contains_key(&id.0)
            || self.ready.spares.contains_key(&id.0)
            || self.ready.left_builds.values().any(|name| *name == id)
            || self.records.get(id).is_some()
    }

    /// A name for a spare VM that names nothing else on the host.
    pub(super) fn spare_name(&self) -> Id {
        let mut name = fresh_name();
        while self.name_taken(name) {
            name = fresh_name();
        }
        name
    }

    /// Starts filling ready sandboxes wherever fewer are kept than asked
    /// for, the shape's template is ready, and memory allows.
    pub(super) fn refill(&mut self) {
        if self.ready.targets.is_empty() || self.ordinals_known().is_err() {
            return;
        }
        let now = Instant::now();
        let targets: Vec<(Shape, u32)> = self
            .ready
            .targets
            .iter()
            .map(|(shape, target)| (*shape, *target))
            .collect();
        for (shape, target) in targets {
            if self
                .ready
                .retry
                .get(&shape)
                .is_some_and(|until| now < *until)
            {
                continue;
            }
            let Some(template) = self.warm.as_ref().and_then(|warm| warm.pool.ready(shape)) else {
                self.want_template(shape);
                continue;
            };
            while self.ready.filling.len() < FILL_AT_ONCE
                && self.ready.count(shape) < target as usize
                && self.memory_allows(&template)
                && self.fill(shape, &template)
            {}
        }
    }

    /// Whether the core leaves room for one more ready sandbox filled from
    /// `template`: room no wake wants, above the admission buffer and the
    /// high watermark, counting every spare booked already, and disk for
    /// its fill (see [`HostAgent::fill_disk`]).
    pub(super) fn memory_allows(&self, template: &Template) -> bool {
        self.core
            .spare_fits(self.fill_memory(template), self.fill_disk())
    }

    /// What a ready sandbox filled from `template` books of host memory
    /// until it is ready and measured: what its VM holds once the
    /// template's whole image is in (see [`Template::footprint`]), and
    /// [`FILL_SLACK`] for its VMM and what its guest touches before it
    /// answers, never more than its whole guest memory. With huge pages,
    /// which no guest gives back, every sandbox reserves its whole size,
    /// and so does a fill.
    fn fill_memory(&self, template: &Template) -> u64 {
        let whole = template.shape().bytes();
        if self.reserve_whole {
            return whole;
        }
        template.footprint().saturating_add(FILL_SLACK).min(whole)
    }

    /// Books `bytes` for the spare VM `host` with the core: `filling` until
    /// it is ready, then what it holds; and `disk`, what it may still write.
    pub(super) fn book_spare(&mut self, host: Id, bytes: u64, disk: DiskSpace, filling: bool) {
        self.ready.spares.insert(host.0, bytes);
        self.input(Input::Spare {
            sandbox: host.0,
            bytes,
            disk,
            filling,
        });
    }

    /// The spare VM `host`, if it is one, has ended, or its removal stopped
    /// part way (`ended` false): then its memory stays counted, as
    /// unmanaged, until removing it again finishes.
    pub(super) fn spare_gone(&mut self, host: Id, ended: bool) {
        let Some(bytes) = self.ready.spares.remove(&host.0) else {
            return;
        };
        let gone = Input::Spare {
            sandbox: host.0,
            bytes: 0,
            disk: DiskSpace::default(),
            filling: false,
        };
        if ended {
            self.input(gone);
        } else {
            self.inputs([
                Input::Unmanaged {
                    sandbox: host.0,
                    bytes,
                },
                gone,
            ]);
        }
    }

    /// What every ready sandbox waiting for a create holds now, for the
    /// core's book.
    pub(super) fn spare_readings(&mut self) -> Vec<Input> {
        let readings: Vec<(SandboxId, u64)> = self
            .ready
            .idle
            .iter()
            // Never 0, which would tell the core it ended.
            .map(|idle| (idle.record.id.0, self.ready_resident(idle).max(1)))
            .collect();
        readings
            .into_iter()
            .map(|(host, bytes)| {
                self.ready.spares.insert(host, bytes);
                Input::Spare {
                    sandbox: host,
                    bytes,
                    disk: DiskSpace::default(),
                    filling: false,
                }
            })
            .collect()
    }

    /// Ends the ready sandbox `host` for memory, as the core asked.
    pub(super) fn discard_spare(&mut self, host: Id) {
        let Some(at) = self
            .ready
            .idle
            .iter()
            .position(|idle| idle.record.id == host)
        else {
            // Already being removed or claimed: the core hears of it then.
            tracing::debug!(%host, "no ready sandbox to end for memory");
            return;
        };
        if let Some(idle) = self.ready.idle.remove(at) {
            tracing::info!(%host, "ending a ready sandbox for memory");
            self.discard(idle);
        }
    }

    /// Starts filling one ready sandbox of `shape` from `template`.
    /// Returns whether it started; one that cannot start has set when its
    /// shape tries again.
    fn fill(&mut self, shape: Shape, template: &Arc<Template>) -> bool {
        let Some(warm) = &self.warm else {
            return false;
        };
        let (sources, ready_port, ready_timeout) = (
            Arc::clone(&warm.sources),
            warm.ready_port,
            warm.ready_timeout,
        );
        let host = self.spare_name();
        let Ok(ordinal) = self.take_ordinal() else {
            self.ready.retry.insert(shape, Instant::now() + FILL_RETRY);
            return false;
        };
        let allocation = match self.images.allocate(ordinal) {
            Ok(allocation) => allocation,
            Err(problem) => {
                tracing::warn!(%shape, %problem, "no room for a ready sandbox");
                self.ordinals.remove(&ordinal);
                self.ready.retry.insert(shape, Instant::now() + FILL_RETRY);
                return false;
            }
        };
        let config = SandboxConfig::new(
            shape.vcpus,
            shape.memory_mib,
            crate::protocol::SleepConfig::default(),
        );
        let mut record = Record::new(host, ordinal, allocation, config);
        record.ready = true;
        record.image = true;
        record.identity = Identity::Pending;
        let paths = Paths::of(&self.root, &record);
        let spec = vm_spec(&record, &paths, &self.images);
        let link = Images::link(&record);
        self.ready.filling.insert(host.0, shape);
        // Booked before it starts, so no wake takes the same room.
        let (memory, disk) = (self.fill_memory(template), self.fill_disk());
        self.book_spare(host, memory, disk, true);
        let fill = Fill {
            job: self.job(record, spec, paths, CancellationToken::new()),
            template: Arc::clone(template),
            sources,
            base: self.base_image.clone(),
            link,
            net: self.net.clone(),
            records: Arc::clone(&self.records),
            lender: self.lender.clone(),
            ready_port,
            ready_timeout,
        };
        let events = self.events_tx.clone();
        tokio::spawn(async move {
            let filled = fill.run().await;
            let _ = events.send(Event::Filled {
                host,
                filled: Box::new(filled),
            });
        });
        true
    }

    /// Takes in a finished fill.
    pub(super) fn filled(&mut self, host: Id, filled: Filled<E::Vm>) {
        let Some(shape) = self.ready.finished(host.0) else {
            return;
        };
        match filled {
            Filled::Ready {
                vm,
                memory,
                template,
            } => {
                self.ready.retry.remove(&shape);
                let live = self.own(host, vm, memory);
                let Some(record) = self.records.get(host) else {
                    tracing::error!(%host, "a ready sandbox lost its record");
                    return;
                };
                let idle = Idle {
                    record,
                    template,
                    live,
                };
                let current = self.warm.as_ref().and_then(|warm| warm.pool.ready(shape));
                let wanted = self.ready.targets.get(&shape).copied().unwrap_or(0) as usize;
                if current.is_some_and(|current| Arc::ptr_eq(&current, &idle.template))
                    && self.ready.count(shape) < wanted
                {
                    tracing::debug!(%host, %shape, "ready sandbox filled");
                    // Ready, and only then: the core may end it at once, so
                    // it must be found waiting. What it holds is measured
                    // from now on.
                    let bytes = self.ready_resident(&idle).max(1);
                    self.ready.idle.push_back(idle);
                    self.book_spare(host, bytes, DiskSpace::default(), false);
                } else {
                    // Counted as filling until its removal ends it.
                    self.discard(idle);
                }
            }
            Filled::Unrecorded {
                ordinal,
                cleaned,
                stale,
            } => {
                // It never started a VM.
                self.spare_gone(host, true);
                // Its VMM's user and host link may still be in use.
                if cleaned {
                    self.ordinals.remove(&ordinal);
                }
                self.ready.retry.insert(shape, Instant::now() + FILL_RETRY);
                if let Some(template) = stale {
                    self.template_stale(&template);
                }
            }
            Filled::Failed { vm } => {
                // Its VM, if any, is counted as filling until its removal
                // ends it.
                self.ready.retry.insert(shape, Instant::now() + FILL_RETRY);
                if let Some(record) = self.records.get(host) {
                    self.remove_recorded(&record, vm, Vec::new(), None);
                } else {
                    tracing::error!(%host, "a failed ready sandbox has no record");
                }
            }
        }
    }

    /// Removes a ready sandbox in the background.
    fn discard(&mut self, idle: Idle<E::Vm>) {
        let Idle { record, live, .. } = idle;
        live.stopping.store(true, Ordering::Release);
        let record = self.records.get(record.id).unwrap_or(record);
        self.remove_recorded(&record, Some((live.vm, live.memory)), Vec::new(), None);
    }

    /// Removes the ready sandboxes of `shape` filled from any template but
    /// its ready one, such as after a rebuild.
    pub(super) fn discard_stale_ready(&mut self, shape: Shape) {
        let current = self.warm.as_ref().and_then(|warm| warm.pool.ready(shape));
        let (keep, stale): (VecDeque<_>, VecDeque<_>) = std::mem::take(&mut self.ready.idle)
            .into_iter()
            .partition(|idle: &Idle<E::Vm>| {
                Shape::of(&idle.record.config) != shape
                    || current
                        .as_ref()
                        .is_some_and(|current| Arc::ptr_eq(current, &idle.template))
            });
        self.ready.idle = keep;
        for idle in stale {
            self.discard(idle);
        }
    }

    /// Handles the end of a ready sandbox's VM; false if `host` names
    /// none.
    pub(super) fn ready_exited(&mut self, host: Id, incarnation: u64) -> bool {
        if let Some(died) = self.ready.claiming.get_mut(&host.0) {
            // Its claim hands the news on with the VM.
            *died = true;
            return true;
        }
        let Some(at) = self
            .ready
            .idle
            .iter()
            .position(|idle| idle.record.id == host && idle.live.incarnation == incarnation)
        else {
            return false;
        };
        tracing::warn!(%host, "a ready sandbox's VM ended");
        if let Some(idle) = self.ready.idle.remove(at) {
            self.discard(idle);
        }
        true
    }

    /// What the ready sandboxes hold, by shape: how many and their
    /// resident memory. They are disposable, so they are the first memory
    /// given back when the host runs low.
    pub(super) fn ready_usage(&self) -> BTreeMap<Shape, ReadyUsage> {
        let mut usage = BTreeMap::<Shape, ReadyUsage>::new();
        for idle in &self.ready.idle {
            let held = usage.entry(Shape::of(&idle.record.config)).or_default();
            held.count = held.count.saturating_add(1);
            held.resident_bytes = held
                .resident_bytes
                .saturating_add(self.ready_resident(idle));
        }
        usage
    }

    fn ready_resident(&self, idle: &Idle<E::Vm>) -> u64 {
        self.engine
            .resident_bytes(&idle.live.vm)
            .unwrap_or_else(|_| u64::from(idle.record.config.memory_mib) << 20)
    }

    /// Gives the oldest ready sandbox of `config`'s shape to the new
    /// sandbox `id`, if there is one. Takes `reply` only then.
    ///
    /// Ready sandboxes are filled guaranteed their whole shape. A request
    /// for less, of memory or processor, takes one all the same: its VM is
    /// given the request's guarantees before the claim is recorded (see
    /// [`Engine::set_guarantees`]), processor share at once and memory
    /// protection from its first resume, which also tells its guest which
    /// sandbox it is. Everything else a request sets is the sandbox's
    /// record, not its VM's. A VM that cannot be given them goes, and the
    /// create starts without a ready sandbox.
    pub(super) fn claim(
        &mut self,
        id: Id,
        config: SandboxConfig,
        reply: Reply<()>,
    ) -> Option<(SandboxConfig, Reply<()>)> {
        let shape = Shape::of(&config);
        let Some(at) = self
            .ready
            .idle
            .iter()
            .position(|idle| Shape::of(&idle.record.config) == shape)
        else {
            return Some((config, reply));
        };
        let idle = self.ready.idle.remove(at)?;
        let Some(sources) = self.warm.as_ref().map(|warm| Arc::clone(&warm.sources)) else {
            self.ready.idle.insert(at, idle);
            return Some((config, reply));
        };
        self.preparing.insert(id.0);
        let records = Arc::clone(&self.records);
        let events = self.events_tx.clone();
        let engine = Arc::clone(&self.engine);
        let (host, fence) = (idle.record.id, idle.record.fence());
        self.ready.claiming.insert(host.0, false);
        // No longer spare, but its VM holds what it did until the claimed
        // sandbox joins the core.
        let bytes = self.ready.spares.remove(&host.0).unwrap_or(shape.bytes());
        self.inputs([
            Input::Spare {
                sandbox: host.0,
                bytes: 0,
                disk: DiskSpace::default(),
                filling: false,
            },
            Input::Unmanaged {
                sandbox: host.0,
                bytes,
            },
        ]);
        let template = Arc::clone(&idle.template);
        let filled = &idle.record.config;
        let guarantees = (config.memory_request(), config.cpu_weight());
        let change = guarantees != (filled.memory_request(), filled.cpu_weight());
        tokio::spawn(async move {
            // A template that no longer fits today's kernel, image or VMM
            // makes its ready sandboxes stale too.
            let fits = tokio::task::spawn_blocking(move || template.fits(&sources))
                .await
                .map_err(std::io::Error::other)
                .and_then(|fits| fits);
            let fits = fits.map(|fits| {
                if !fits {
                    return Fit::Stale;
                }
                let (memory, weight) = guarantees;
                match change.then(|| engine.set_guarantees(&idle.live.vm, memory, weight)) {
                    Some(Err(error)) => Fit::Unfit(error.to_string()),
                    _ => Fit::Fits,
                }
            });
            let result = match fits {
                Ok(Fit::Fits) => ClaimResult::Claimed(
                    records
                        .claim(host, fence, id, config.clone())
                        .await
                        .map(Box::new)
                        .map_err(HostError::from),
                ),
                Ok(Fit::Stale) => ClaimResult::Stale,
                Ok(Fit::Unfit(error)) => ClaimResult::Unfit(error),
                Err(error) => ClaimResult::Claimed(Err(HostError::Io(error.to_string()))),
            };
            let _ = events.send(Event::Claimed {
                id,
                config,
                reply,
                claimed: Box::new(Claimed { idle, result }),
            });
        });
        None
    }

    /// Takes in a claim: the new sandbox joins the core as a paused VM
    /// whose guest learns its id on its first resume.
    pub(super) fn claimed(
        &mut self,
        id: Id,
        config: SandboxConfig,
        reply: Reply<()>,
        claimed: Claimed<E::Vm>,
    ) {
        self.preparing.remove(&id.0);
        let Claimed { idle, result } = claimed;
        let host = idle.record.id;
        let died = self.ready.claiming.remove(&host.0).unwrap_or(false);
        let record = match result {
            ClaimResult::Claimed(Ok(record)) => *record,
            ClaimResult::Stale => {
                // Stale: every ready sandbox of the template goes, and the
                // create starts over without one.
                let template = Arc::clone(&idle.template);
                self.discard(idle);
                self.template_stale(&template);
                self.create(id, config, reply);
                return;
            }
            ClaimResult::Unfit(error) => {
                // Nothing was written: it goes, and the create starts
                // without a ready sandbox, so the next one is not tried.
                tracing::warn!(%id, %host, %error, "a ready sandbox could not be given the request's guarantees");
                self.discard(idle);
                self.create_from(id, config, reply, false);
                return;
            }
            ClaimResult::Claimed(Err(error)) => {
                tracing::error!(%id, %host, %error, "could not claim a ready sandbox");
                // Whichever name its record answers to now, it goes.
                let Idle { record, live, .. } = idle;
                live.stopping.store(true, Ordering::Release);
                let current = self
                    .records
                    .get(id)
                    .filter(|record| record.host() == host)
                    .or_else(|| self.records.get(host))
                    .unwrap_or(record);
                if current.id == id {
                    self.hosts.insert(host.0, id.0);
                }
                self.remove_recorded(&current, Some((live.vm, live.memory)), Vec::new(), None);
                let _ = reply.send(Err(error));
                return;
            }
        };
        let policy = match self.sleep_policy(&record.config) {
            Ok(policy) => policy,
            Err(problem) => {
                // Checked before the claim; nothing changed it since.
                tracing::error!(%id, %problem, "a claimed sandbox's settings are invalid");
                let _ = reply.send(Err(HostError::Invalid(problem)));
                return;
            }
        };
        self.hosts.insert(host.0, id.0);
        let paths = Paths::of(&self.root, &record);
        let spec = vm_spec(&record, &paths, &self.images);
        self.insert(id, paths, spec);
        let live = idle.live;
        let incarnation = live.incarnation;
        if let Some(slot) = self.slots.get_mut(&id.0) {
            slot.incarnation = Some(incarnation);
            slot.vm = Some(live);
        }
        // Paused, with no saved copy of what its guest did since the
        // template: its disk moved on. Idle since the claim, as its record
        // says, so a restart counts from the same moment. Its VM's memory
        // moves from the host name it was counted under to the sandbox, in
        // one decision.
        let last_activity = record
            .last_used_ms
            .map_or_else(|| self.now(), |unix_ms| self.at_unix_ms(unix_ms));
        let size = self.size(&record.config);
        self.inputs([
            Input::Add {
                sandbox: id.0,
                state: State::new(Level::Paused, Durability::Volatile, false),
                policy,
                size,
                last_activity,
            },
            Input::Unmanaged {
                sandbox: host.0,
                bytes: 0,
            },
        ]);
        if died {
            self.exited(id, incarnation);
        }
        tracing::debug!(%id, %host, "ready sandbox claimed");
        let _ = reply.send(Ok(()));
    }
}

/// A claim's outcome, for the agent's task.
#[derive(Debug)]
pub(super) struct Claimed<V> {
    idle: Idle<V>,
    result: ClaimResult,
}

/// How a claim ended.
#[derive(Debug)]
enum ClaimResult {
    /// The claimed record, or why the claim failed.
    Claimed(Result<Box<Record>, HostError>),
    /// The template turned out stale; nothing was written.
    Stale,
    /// Its VM could not be given the request's guarantees, for the reason
    /// given; nothing was written.
    Unfit(String),
}

/// Whether a ready sandbox can be claimed.
enum Fit {
    Fits,
    Stale,
    Unfit(String),
}
