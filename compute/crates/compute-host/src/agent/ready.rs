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
//! host memory runs low (before the core frees memory of real sandboxes),
//! and when an agent starts. The pool then fills again, a few at a time,
//! each fill under the restore limit and after every restore a sandbox
//! waits for (see [`compute_core::Input::Borrow`]).
//!
//! [`Records::claim`]: crate::state::Records::claim
//! [`Identity::Pending`]: crate::state::Identity::Pending

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use compute_core::{Durability, Input, Level, MemoryPolicy, Outcome, SandboxId, State, Step};
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
/// Memory kept free beyond a fill's own when the host has no memory
/// policy to say how much.
const DEFAULT_RESERVE: u64 = 1 << 30;

/// A ready sandbox waiting for a create.
#[derive(Debug)]
pub(super) struct Idle<V> {
    record: Record,
    template: Arc<Template>,
    live: Live<V>,
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
    /// Memory that ready sandboxes being removed for want of it will free,
    /// by host name.
    freeing: HashMap<SandboxId, u64>,
    /// Memory a fill leaves free besides its own.
    reserve: u64,
    /// Ready sandboxes a create is claiming, by host name, with whether
    /// their VM ended meanwhile.
    claiming: HashMap<SandboxId, bool>,
}

impl<V> Ready<V> {
    /// Keeps `targets` of each shape, filling while available memory
    /// stays above the high watermark of `memory`, if set.
    pub fn new(targets: BTreeMap<Shape, u32>, memory: Option<MemoryPolicy>) -> Self {
        Self {
            targets,
            idle: VecDeque::new(),
            filling: HashMap::new(),
            retry: HashMap::new(),
            freeing: HashMap::new(),
            reserve: memory.map_or(DEFAULT_RESERVE, |memory| memory.high_watermark),
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

    /// Adds the ready pool's numbers to each shape's template status.
    pub fn status(&self, templates: &mut [TemplateStatus]) {
        let count = |shape: Shape, filling: bool| {
            let n = if filling {
                self.filling.values().filter(|each| **each == shape).count()
            } else {
                self.idle
                    .iter()
                    .filter(|idle| Shape::of(&idle.record.config) == shape)
                    .count()
            };
            u32::try_from(n).unwrap_or(u32::MAX)
        };
        for status in templates.iter_mut() {
            let shape = Shape {
                vcpus: status.vcpus,
                memory_mib: status.memory_mib,
            };
            status.ready = count(shape, false);
            status.filling = count(shape, true);
            status.target = self.targets.get(&shape).copied().unwrap_or(0);
        }
    }

    /// Memory that ready sandboxes being removed will soon give back.
    pub fn freeing(&self) -> u64 {
        self.freeing.values().sum()
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
    /// It failed before it had a record; nothing of it is left.
    Unrecorded {
        ordinal: u32,
        /// The template no longer fits today's inputs.
        stale: Option<Arc<Template>>,
    },
    /// It failed with a record, and a VM if one is left; it is removed.
    Failed { vm: Option<V> },
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
        let unrecorded = |stale| Filled::Unrecorded { ordinal, stale };
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
                self.forget(host, ordinal).await;
                return unrecorded(stale.then_some(self.template));
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
                    After::New(vm, _) => Some(vm),
                    After::Kept(live) => Some(live.vm),
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
            return Filled::Failed { vm: Some(vm) };
        }
        Filled::Ready {
            vm,
            memory,
            template: self.template,
        }
    }

    /// Removes what a fill made before its record existed.
    async fn forget(&self, host: Id, ordinal: u32) {
        if let Some(net) = self.net.clone() {
            let _ = tokio::task::spawn_blocking(move || net.remove(host, Some(ordinal))).await;
        }
        let _ = tokio::fs::remove_dir_all(&self.job.paths.dir).await;
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
            || self.records.get(id).is_some()
    }

    /// Starts filling ready sandboxes wherever fewer are kept than asked
    /// for, the shape's template is ready, and memory allows.
    pub(super) fn refill(&mut self) {
        if self.ready.targets.is_empty()
            || !self.unknown_ordinals.is_empty()
            || !self.unknown_builds.is_empty()
        {
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
                && self.memory_allows(shape)
            {
                self.fill(shape, &template);
            }
        }
    }

    /// Whether the host's memory leaves room for one more fill of `shape`
    /// on top of those under way. Unknown memory allows it.
    fn memory_allows(&self, shape: Shape) -> bool {
        let Some(available) = self.available_memory else {
            return true;
        };
        let each = u64::from(shape.memory_mib) << 20;
        let filling = u64::try_from(self.ready.filling.len()).unwrap_or(u64::MAX);
        let needed = self
            .ready
            .reserve
            .saturating_add(each.saturating_mul(filling.saturating_add(1)));
        available >= needed
    }

    /// Starts filling one ready sandbox of `shape` from `template`.
    fn fill(&mut self, shape: Shape, template: &Arc<Template>) {
        let Some(warm) = &self.warm else {
            return;
        };
        let (sources, ready_port, ready_timeout) = (
            Arc::clone(&warm.sources),
            warm.ready_port,
            warm.ready_timeout,
        );
        let mut host = fresh_name();
        while self.name_taken(host) {
            host = fresh_name();
        }
        let ordinal = self.take_ordinal();
        let allocation = match self.images.allocate(ordinal) {
            Ok(allocation) => allocation,
            Err(problem) => {
                tracing::warn!(%shape, %problem, "no room for a ready sandbox");
                self.ordinals.remove(&ordinal);
                self.ready.retry.insert(shape, Instant::now() + FILL_RETRY);
                return;
            }
        };
        let config = SandboxConfig {
            vcpus: shape.vcpus,
            memory_mib: shape.memory_mib,
            sleep: crate::protocol::SleepConfig::default(),
        };
        let mut record = Record::new(host, ordinal, allocation, config);
        record.ready = true;
        record.image = true;
        record.identity = Identity::Pending;
        let paths = Paths::of(&self.root, &record);
        let spec = vm_spec(&record, &paths, &self.images);
        let link = Images::link(&record);
        self.ready.filling.insert(host.0, shape);
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
    }

    /// Takes in a finished fill.
    pub(super) fn filled(&mut self, host: Id, filled: Filled<E::Vm>) {
        let Some(shape) = self.ready.filling.remove(&host.0) else {
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
                    self.ready.idle.push_back(idle);
                } else {
                    self.discard(idle);
                }
            }
            Filled::Unrecorded { ordinal, stale } => {
                self.ordinals.remove(&ordinal);
                self.ready.retry.insert(shape, Instant::now() + FILL_RETRY);
                if let Some(template) = stale {
                    self.template_stale(&template);
                }
            }
            Filled::Failed { vm } => {
                self.ready.retry.insert(shape, Instant::now() + FILL_RETRY);
                if let Some(record) = self.records.get(host) {
                    self.remove_recorded(&record, vm, Vec::new());
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
        self.remove_recorded(&record, Some(live.vm), Vec::new());
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

    /// When memory is low, removes ready sandboxes, oldest first, until
    /// what they free would lift available memory to the high watermark.
    /// Returns the memory that removals under way will free, which the
    /// core counts as available so it frees no real sandbox's in their
    /// stead.
    pub(super) fn relieve_with_ready(&mut self, available: u64) -> u64 {
        let Some(memory) = self
            .memory_policy
            .filter(|memory| available < memory.low_watermark)
        else {
            return self.ready.freeing();
        };
        let sizes: Vec<u64> = self
            .ready
            .idle
            .iter()
            .map(|idle| {
                self.engine
                    .resident_bytes(&idle.live.vm)
                    .unwrap_or_else(|_| u64::from(idle.record.config.memory_mib) << 20)
            })
            .collect();
        let count = to_free(available, self.ready.freeing(), &sizes, memory);
        for bytes in sizes.into_iter().take(count) {
            let Some(idle) = self.ready.idle.pop_front() else {
                break;
            };
            tracing::info!(host = %idle.record.id, bytes, "memory is low; removing a ready sandbox");
            self.ready.freeing.insert(idle.record.id.0, bytes);
            self.discard(idle);
        }
        self.ready.freeing()
    }

    /// A ready sandbox's removal ended: what it held is free or never
    /// will be.
    pub(super) fn ready_removed(&mut self, host: Id) {
        self.ready.freeing.remove(&host.0);
    }

    /// Gives the oldest ready sandbox of `config`'s shape to the new
    /// sandbox `id`, if there is one. Takes `reply` only then.
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
        let (host, fence) = (idle.record.id, idle.record.fence());
        self.ready.claiming.insert(host.0, false);
        let template = Arc::clone(&idle.template);
        tokio::spawn(async move {
            // A template that no longer fits today's kernel, image or VMM
            // makes its ready sandboxes stale too.
            let fits = tokio::task::spawn_blocking(move || template.fits(&sources))
                .await
                .map_err(std::io::Error::other)
                .and_then(|fits| fits);
            let result = match fits {
                Ok(true) => Some(
                    records
                        .claim(host, fence, id, config.clone())
                        .await
                        .map_err(HostError::from),
                ),
                Ok(false) => None,
                Err(error) => Some(Err(HostError::Io(error.to_string()))),
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
            Some(Ok(record)) => record,
            None => {
                // Stale: every ready sandbox of the template goes, and the
                // create starts over without one.
                let template = Arc::clone(&idle.template);
                self.discard(idle);
                self.template_stale(&template);
                self.create(id, config, reply);
                return;
            }
            Some(Err(error)) => {
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
                self.remove_recorded(&current, Some(live.vm), Vec::new());
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
        // template: its disk moved on.
        self.input(Input::Add {
            sandbox: id.0,
            state: State::new(Level::Paused, Durability::Volatile, false),
            policy,
        });
        if died {
            self.exited(id, incarnation);
        }
        tracing::debug!(%id, %host, "ready sandbox claimed");
        let _ = reply.send(Ok(()));
    }
}

/// How many of the ready sandboxes holding `sizes` bytes each, oldest
/// first, to remove when `available` bytes are free and removals under way
/// will free `freeing` more: none above the low watermark, otherwise enough
/// to reach the high one, or all of them.
fn to_free(available: u64, freeing: u64, sizes: &[u64], memory: MemoryPolicy) -> usize {
    if available >= memory.low_watermark {
        return 0;
    }
    let mut expected = available.saturating_add(freeing);
    let mut count = 0;
    for size in sizes {
        if expected >= memory.high_watermark {
            break;
        }
        expected = expected.saturating_add(*size);
        count += 1;
    }
    count
}

/// A claim's outcome, for the agent's task.
#[derive(Debug)]
pub(super) struct Claimed<V> {
    idle: Idle<V>,
    /// The claimed record, why the claim failed, or `None` when the
    /// template turned out stale and nothing was written.
    result: Option<Result<Record, HostError>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1 << 20;

    #[test]
    fn low_memory_frees_ready_sandboxes_up_to_the_high_watermark() {
        let memory = MemoryPolicy {
            low_watermark: 1000 * MIB,
            high_watermark: 1500 * MIB,
            compressed_percent: 50,
        };
        let sizes = [200 * MIB, 200 * MIB, 200 * MIB, 200 * MIB];
        assert_eq!(to_free(1000 * MIB, 0, &sizes, memory), 0, "not low");
        assert_eq!(to_free(900 * MIB, 0, &sizes, memory), 3, "900 + 3 x 200");
        assert_eq!(
            to_free(900 * MIB, 400 * MIB, &sizes, memory),
            1,
            "removals under way count"
        );
        assert_eq!(to_free(0, 0, &sizes, memory), 4, "all, and not enough");
        assert_eq!(to_free(0, 0, &[], memory), 0);
    }
}
