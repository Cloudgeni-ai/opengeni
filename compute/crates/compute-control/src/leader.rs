//! The leader: one replica at a time, holding the store's lock, gives up on
//! hosts whose renewals stopped and sizes the host group.
//!
//! It watches each host's renewal count on its own monotonic clock and
//! gives up on a host once the count stood still for the term plus the
//! margin ([`compute_fleet::Expiry`]). A count is timed when its read
//! returns, never when it was asked for: any renewal it shows was sent
//! before then, so the leader never counts from earlier than the host
//! does, however slow the read. Giving up is conditional on the count it
//! watched, so a renewal accepted meanwhile saves the host, and a second
//! leader, which can only happen while the first has not yet seen it lost
//! the lock, is as safe as one. A new leader starts with nothing seen and
//! so waits a whole term and margin before giving up on anyone.
//!
//! The lease only says when giving up is safe, not when it is worth it.
//! A host whose renewals stopped has frozen its VMs, but one cut off only
//! by the network still has them, and runs them on once it renews again;
//! giving up on it costs every sandbox it holds its running programs and
//! what it wrote since its last archive, and resets the whole machine. So
//! while a silent host holds sandboxes the leader waits for it, up to
//! `give_up_after` from its last renewal, unless its group finds its
//! instance stopped or gone, which leaves nothing to keep. One that holds
//! none goes as soon as its lease allows.
//!
//! A host of the group it sizes is fenced before it is given up on: its
//! instance is reset (or found stopped or gone) through the cloud's API,
//! so nothing it ran can still run when its sandboxes go elsewhere. Fences
//! run beside the leader's loop, and a host whose fence fails is not given
//! up on until one succeeds. A host outside any group has only its own
//! deadline, the guard and the watchdog to stop it (ADR 18).

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use compute_fleet::{At, Expiry, GroupView, HostId, LeaseTerms, ScaleDecision, ScalePolicy};
use tokio::task::JoinSet;
use tokio::time::Instant;

use crate::group::{Fenced, GcpGroup, Member, Started};
use crate::metrics::{GaveUp, GroupSeen, Metrics};
use crate::store::{self, Store};
use crate::view::{GroupHost, View};

/// How often the leader looks at renewal counts.
const EVERY: Duration = Duration::from_millis(250);
/// How often a replica that does not lead tries to.
const TRY_EVERY: Duration = Duration::from_secs(1);
/// How long a fence may take before it counts as failed.
const FENCE_WITHIN: Duration = Duration::from_secs(120);
/// How long after a failed fence the next one starts.
const FENCE_AGAIN: Duration = Duration::from_secs(5);
/// How often the leader asks the cloud about the instance of a silent host
/// it waits for.
const LOOK_EVERY: Duration = Duration::from_secs(5);

/// How the leader sizes a host group.
#[derive(Debug)]
pub struct Scaling {
    pub group: Arc<GcpGroup>,
    pub policy: ScalePolicy,
    /// How often it looks.
    pub every: Duration,
    /// How long a member of the group without a registered host counts as
    /// booting, its memory as coming. Past it the member is stalled: it
    /// keeps its place in the group but no longer stands in for capacity,
    /// so the group grows around it.
    pub boot_within: Duration,
}

/// What the leader needs of the store.
pub trait Leases: Send + Sync + 'static {
    /// The renewal count of every host not given up on.
    fn renewals(&self) -> impl Future<Output = store::Result<Vec<(HostId, u64)>>> + Send;

    /// Gives up on `host` if its count is still `renewals`; see
    /// [`Store::give_up`].
    fn give_up(
        &self,
        host: HostId,
        renewals: u64,
    ) -> impl Future<Output = store::Result<Option<usize>>> + Send;
}

impl<S: Store> Leases for S {
    fn renewals(&self) -> impl Future<Output = store::Result<Vec<(HostId, u64)>>> + Send {
        Store::renewals(self)
    }

    fn give_up(
        &self,
        host: HostId,
        renewals: u64,
    ) -> impl Future<Output = store::Result<Option<usize>>> + Send {
        Store::give_up(self, host, renewals, crate::service::now_ms())
    }
}

/// The leader's clock: monotonic time since it began leading. It is
/// Tokio's, so tests can stop and move it.
#[derive(Clone, Copy, Debug)]
pub struct Clock(Instant);

impl Clock {
    #[must_use]
    pub fn start() -> Self {
        Self(Instant::now())
    }

    #[must_use]
    pub fn now(&self) -> At {
        At::from_duration(self.0.elapsed())
    }
}

/// Leads whenever no other replica does, for as long as it runs.
pub async fn lead<S: Store>(
    store: Arc<S>,
    view: Arc<View>,
    terms: LeaseTerms,
    give_up_after: Duration,
    scaling: Option<Scaling>,
    metrics: Arc<Metrics>,
) {
    loop {
        let lead = match store.try_lead().await {
            Ok(Some(lead)) => lead,
            Ok(None) => {
                tokio::time::sleep(TRY_EVERY).await;
                continue;
            }
            Err(error) => {
                tracing::warn!(%error, "trying to lead failed");
                tokio::time::sleep(TRY_EVERY).await;
                continue;
            }
        };
        tracing::info!("this replica leads");
        metrics.leads(true);
        let leading = Leading::new(
            Arc::clone(&store),
            terms,
            scaling.as_ref().map(|scaling| Arc::clone(&scaling.group)),
        )
        .giving_up_after(give_up_after)
        .reporting_to(Arc::clone(&metrics));
        led(&store, &view, leading, scaling.as_ref(), &metrics, lead).await;
        metrics.leads(false);
        tracing::warn!("this replica no longer leads");
    }
}

async fn led<S: Store>(
    store: &Arc<S>,
    view: &View,
    mut leading: Leading<S>,
    scaling: Option<&Scaling>,
    metrics: &Arc<Metrics>,
    mut lead: S::Lead,
) {
    let mut tick = tokio::time::interval(EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut scaled: Option<Instant> = None;
    let mut boots = Boots::default();
    loop {
        tick.tick().await;
        if !store.leads(&mut lead).await {
            return;
        }
        leading.tick(view).await;
        metrics.still(leading.still());
        if let Some(scaling) = scaling
            && scaled.is_none_or(|when| when.elapsed() >= scaling.every)
        {
            scaled = Some(Instant::now());
            match scale(scaling, view, &mut boots).await {
                Ok((prefix, seen)) => {
                    leading.prefix = Some(prefix);
                    metrics.group(seen);
                }
                Err(error) => {
                    metrics.group_failed();
                    tracing::warn!(%error, "sizing the host group failed");
                }
            }
        }
    }
}

/// What one leadership watches and has under way.
#[derive(Debug)]
pub struct Leading<L> {
    leases: Arc<L>,
    expiry: Expiry,
    clock: Clock,
    /// The group whose hosts are fenced before they are given up on, and
    /// the prefix of its instances' names once read.
    group: Option<Arc<GcpGroup>>,
    prefix: Option<String>,
    fences: JoinSet<FenceResult>,
    /// The host each fence under way is for, and whether it was draining.
    fencing: HashMap<tokio::task::Id, (HostId, bool)>,
    /// Hosts whose last fence failed, and when the next may start.
    again_at: HashMap<HostId, Instant>,
    /// How long a silent host holding sandboxes is waited for.
    give_up_after: Duration,
    /// The silent hosts it waits for, and what it knows of each one's
    /// instance.
    waiting: HashMap<HostId, Look>,
    /// The asks about those instances under way, apart from the ticks so
    /// that a slow answer holds up nothing else.
    looks: JoinSet<(HostId, Option<bool>)>,
    metrics: Arc<Metrics>,
}

/// What the leader knows of the instance of a silent host it waits for.
#[derive(Debug, Default)]
struct Look {
    /// When it last asked the cloud about it.
    asked: Option<Instant>,
    /// Whether an ask is under way.
    asking: bool,
    /// Whether the instance may still hold its memory, as last answered;
    /// until the cloud says it does not, it may.
    holds: Option<bool>,
}

type FenceResult = (HostId, Result<Option<usize>, String>);

/// What follows for a host whose count stood still too long.
enum Lapse {
    GiveUp,
    Fence(Arc<GcpGroup>, String),
    /// Not known yet, or a fence is under way or failed just now.
    Later,
}

impl<L: Leases> Leading<L> {
    /// A leadership that has seen nothing yet, fencing the hosts of
    /// `group`, and giving up on a host as soon as its lease allows.
    #[must_use]
    pub fn new(leases: Arc<L>, terms: LeaseTerms, group: Option<Arc<GcpGroup>>) -> Self {
        Self {
            leases,
            expiry: Expiry::new(terms),
            clock: Clock::start(),
            group,
            prefix: None,
            fences: JoinSet::new(),
            fencing: HashMap::new(),
            again_at: HashMap::new(),
            give_up_after: Duration::ZERO,
            waiting: HashMap::new(),
            looks: JoinSet::new(),
            metrics: Arc::default(),
        }
    }

    /// Waits up to `give_up_after` from its last renewal for a silent host
    /// that holds sandboxes; see the module's documentation.
    #[must_use]
    pub fn giving_up_after(mut self, give_up_after: Duration) -> Self {
        self.give_up_after = give_up_after;
        self
    }

    /// Counts what it gives up on and the fences that fail in `metrics`.
    #[must_use]
    pub fn reporting_to(mut self, metrics: Arc<Metrics>) -> Self {
        self.metrics = metrics;
        self
    }

    /// How long each host's renewal count has stood still, as seen now.
    pub fn still(&self) -> impl Iterator<Item = (HostId, Duration)> + '_ {
        self.expiry.still(self.clock.now())
    }

    /// Reads every host's renewal count and gives up on, or fences, each
    /// whose count stood still too long.
    pub async fn tick(&mut self, view: &View) {
        self.reap();
        let renewals = match self.leases.renewals().await {
            Ok(renewals) => renewals,
            Err(error) => {
                // Seen nothing new: a host is given up on only once the
                // store shows again that its count stood still.
                tracing::warn!(%error, "reading renewal counts failed");
                return;
            }
        };
        let now = self.clock.now();
        // The read lists every host not given up on: one it lacks was
        // given up on (perhaps without this leadership seeing the outcome)
        // and perhaps since forgotten, so nothing is left to watch or try
        // again for it.
        self.expiry.observe_all(renewals, now);
        self.again_at.retain(|host, _| self.expiry.watches(*host));
        let lapsed: Vec<_> = self.expiry.expired(now).collect();
        let still: HashMap<HostId, Duration> = if lapsed.is_empty() {
            HashMap::new()
        } else {
            self.expiry.still(now).collect()
        };
        // A host that renewed again, or is no longer watched, is no longer
        // waited for.
        self.waiting
            .retain(|host, _| lapsed.iter().any(|(lapsed, _)| lapsed == host));
        for (host, renewals) in lapsed {
            let draining = view.draining(host);
            let still = still.get(&host).copied().unwrap_or(Duration::MAX);
            match self.lapse(host, view, still).await {
                Lapse::GiveUp => {
                    let result = self.leases.give_up(host, renewals).await;
                    self.given_up(host, draining, result.map_err(|error| error.to_string()));
                }
                Lapse::Fence(group, name) => {
                    let leases = Arc::clone(&self.leases);
                    let task = self
                        .fences
                        .spawn(fence_and_give_up(leases, group, host, name, renewals));
                    self.fencing.insert(task.id(), (host, draining));
                }
                Lapse::Later => {}
            }
        }
    }

    /// Whether `host`, silent for `still`, is fenced first, given up on
    /// now, or decided later.
    async fn lapse(&mut self, host: HostId, view: &View, still: Duration) -> Lapse {
        if self.fencing.values().any(|(fenced, _)| *fenced == host)
            || self
                .again_at
                .get(&host)
                .is_some_and(|at| Instant::now() < *at)
        {
            return Lapse::Later;
        }
        let waits = still < self.give_up_after && view.holds_sandboxes(host);
        if waits && !self.waiting.contains_key(&host) {
            tracing::warn!(
                host = host.0,
                ?still,
                give_up_after = ?self.give_up_after,
                "a host holding sandboxes stopped renewing; waiting for it before giving up on it"
            );
            self.waiting.insert(host, Look::default());
        }
        let Some(group) = self.group.clone() else {
            return if waits { Lapse::Later } else { Lapse::GiveUp };
        };
        let Some(name) = view.name(host) else {
            // The view has not caught up with the store yet.
            return Lapse::Later;
        };
        if self.prefix.is_none() {
            match group.describe().await {
                Ok(described) => {
                    self.prefix = Some(format!("{}-", described.base_instance_name));
                }
                Err(error) => {
                    // Whether it must be fenced is not known: it waits.
                    tracing::warn!(%error, "reading the host group failed");
                    return Lapse::Later;
                }
            }
        }
        if self
            .prefix
            .as_deref()
            .is_some_and(|prefix| name.starts_with(prefix))
        {
            if waits && self.may_hold_memory(host, &group, &name) {
                return Lapse::Later;
            }
            Lapse::Fence(group, name)
        } else if waits {
            Lapse::Later
        } else {
            Lapse::GiveUp
        }
    }

    /// Whether the instance `name` of silent host `host` may still hold
    /// its memory, as the cloud last answered; it asks again, apart from
    /// the tick, at most every [`LOOK_EVERY`]. Until it answers that the
    /// instance is stopped or gone, it may.
    fn may_hold_memory(&mut self, host: HostId, group: &Arc<GcpGroup>, name: &str) -> bool {
        let look = self.waiting.entry(host).or_default();
        if look.holds == Some(false) {
            return false;
        }
        if !look.asking && look.asked.is_none_or(|at| at.elapsed() >= LOOK_EVERY) {
            look.asking = true;
            look.asked = Some(Instant::now());
            let group = Arc::clone(group);
            let name = name.to_owned();
            self.looks.spawn(async move {
                match group.may_hold_memory(&name).await {
                    Ok(holds) => (host, Some(holds)),
                    Err(error) => {
                        tracing::warn!(%error, %name, "reading a silent host's instance failed");
                        (host, None)
                    }
                }
            });
        }
        true
    }

    /// Takes in the fences and asks about instances that ended.
    fn reap(&mut self) {
        while let Some(joined) = self.looks.try_join_next() {
            // An ask that panicked leaves its host asking: it is then
            // given up on once the wait ends.
            let Ok((host, holds)) = joined else { continue };
            if let Some(look) = self.waiting.get_mut(&host) {
                look.asking = false;
                look.holds = holds.or(look.holds);
            }
        }
        while let Some(joined) = self.fences.try_join_next_with_id() {
            let (id, result) = match joined {
                Ok((id, (_, result))) => (id, result),
                Err(error) => (error.id(), Err(format!("the fence ended: {error}"))),
            };
            if let Some((host, draining)) = self.fencing.remove(&id) {
                self.given_up(host, draining, result);
            }
        }
    }

    /// Takes in how giving up on `host`, `draining` or not, went. A
    /// draining host given up on with no sandboxes left was removed as
    /// planned; any other was lost.
    fn given_up(&mut self, host: HostId, draining: bool, result: Result<Option<usize>, String>) {
        match result {
            Ok(given_up) => {
                // Either way it starts afresh: a host that renewed is
                // watched again from its new count, and one already given
                // up on is no longer listed.
                self.expiry.forget(host);
                self.again_at.remove(&host);
                match given_up {
                    Some(0) if draining => {
                        self.metrics.gave_up(GaveUp::Removed);
                        tracing::info!(host = host.0, "a drained host is gone");
                    }
                    Some(sandboxes) => {
                        self.metrics.gave_up(GaveUp::Lost);
                        tracing::warn!(host = host.0, sandboxes, "gave up on a host");
                    }
                    None => {}
                }
            }
            Err(error) => {
                self.metrics.give_up_failed();
                tracing::warn!(%error, host = host.0, "giving up on a host failed");
                self.again_at.insert(host, Instant::now() + FENCE_AGAIN);
            }
        }
    }

    /// How many fences are under way.
    #[must_use]
    pub fn fences(&self) -> usize {
        self.fencing.len()
    }
}

/// Fences host `host`'s instance `name`, then gives up on the host if its
/// count is still `renewals`, and starts the instance again if the fence
/// found it stopped: it then registers afresh.
async fn fence_and_give_up<L: Leases>(
    leases: Arc<L>,
    group: Arc<GcpGroup>,
    host: HostId,
    name: String,
    renewals: u64,
) -> FenceResult {
    let result = async {
        let fenced = group
            .fence(&name, FENCE_WITHIN)
            .await
            .map_err(|error| format!("fencing {name}: {error:#}"))?;
        tracing::info!(host = host.0, %name, ?fenced, "fenced a host");
        let given_up = leases
            .give_up(host, renewals)
            .await
            .map_err(|error| error.to_string())?;
        if given_up.is_some() && fenced == Fenced::Stopped {
            match group.start(&name).await {
                Ok(Started::Asked) => {}
                // The group deleted it to recreate it.
                Ok(Started::Gone) => tracing::info!(%name, "a fenced host is gone"),
                // The group's next look starts it.
                Err(error) => tracing::warn!(%error, %name, "starting a fenced host failed"),
            }
        }
        Ok(given_up)
    }
    .await;
    (host, result)
}

/// Starts the group's stopped members whose hosts are given up on or never
/// registered, and that the group itself is doing nothing to: a fenced
/// host stopped before the leader could start it again, or one stopped
/// for any other reason. One still live in the view is started once it is
/// given up on. One that fails to start is tried again at the next look,
/// and keeps neither the others from starting nor the group from growing.
async fn start_stopped(scaling: &Scaling, hosts: &HashMap<String, GroupHost>, members: &[Member]) {
    for member in members {
        if !member.stopped || !member.idle || hosts.contains_key(&member.name) {
            continue;
        }
        let name = &member.name;
        tracing::info!(%name, "starting a stopped host");
        match scaling.group.start(name).await {
            Ok(Started::Asked) => {}
            Ok(Started::Gone) => tracing::info!(%name, "a stopped host is gone"),
            Err(error) => tracing::warn!(%error, %name, "starting a stopped host failed"),
        }
    }
}

/// When each member of the group without a registered host was first seen
/// so, as one leadership has watched it.
#[derive(Debug, Default)]
struct Boots(HashMap<String, Boot>);

#[derive(Clone, Copy, Debug)]
struct Boot {
    since: Instant,
    stalled: bool,
}

impl Boots {
    /// Counts a group of `target_size` places, whose manager lists
    /// `members`, against the `hosts` registered under its names, so that
    /// each place counts once:
    ///
    /// - a listed member with a host brings that host, live or draining;
    /// - one without a host is booting, within `within` of when this
    ///   leadership first saw it without one, and stalled past it;
    /// - one the group is removing holds no place and brings nothing;
    /// - a host the listing does not name may be one the group has not
    ///   listed yet, or one it has let go: such hosts take the places
    ///   asked for and not listed, as many as there are, the ones with
    ///   least to bring first, and only those bring anything;
    /// - the places left of those are booting.
    ///
    /// Says once when a member stalls, and when a stalled one registers.
    fn count(
        &mut self,
        target_size: u32,
        members: &[Member],
        hosts: &HashMap<String, GroupHost>,
        within: Duration,
        policy: &ScalePolicy,
    ) -> GroupView {
        let now = Instant::now();
        let mut before = std::mem::take(&mut self.0);
        let mut seen = GroupView::default();
        let mut listed = 0u32;
        for member in members {
            if member.leaving {
                continue;
            }
            listed += 1;
            let boot = before.remove(&member.name);
            if let Some(host) = hosts.get(&member.name) {
                if boot.is_some_and(|boot| boot.stalled) {
                    tracing::info!(name = %member.name, "a stalled host registered");
                }
                bring(&mut seen, host, policy);
                continue;
            }
            let mut boot = boot.unwrap_or(Boot {
                since: now,
                stalled: false,
            });
            if now.duration_since(boot.since) < within {
                seen.booting += 1;
            } else {
                if !boot.stalled {
                    tracing::warn!(
                        name = %member.name,
                        ?within,
                        "a host group member has not registered in time; its memory no longer counts as coming"
                    );
                    boot.stalled = true;
                }
                seen.stalled += 1;
            }
            self.0.insert(member.name.clone(), boot);
        }
        let names: HashSet<&str> = members.iter().map(|member| member.name.as_str()).collect();
        let mut unnamed: Vec<&GroupHost> = hosts
            .iter()
            .filter(|(name, _)| !names.contains(name.as_str()))
            .map(|(_, host)| host)
            .collect();
        // Least spare first, so a host the group has let go never makes
        // the group look roomier than one it is yet to list would.
        unnamed.sort_by_key(|host| {
            if host.draining {
                0
            } else {
                host.free_memory_mib
            }
        });
        let mut unlisted = target_size.saturating_sub(listed);
        for host in unnamed {
            if unlisted == 0 {
                break;
            }
            bring(&mut seen, host, policy);
            unlisted -= 1;
        }
        seen.booting += unlisted;
        seen
    }
}

/// Adds what `host` brings to `seen`, its rooms for the largest sandbox
/// by `policy` among it.
fn bring(seen: &mut GroupView, host: &GroupHost, policy: &ScalePolicy) {
    if host.draining {
        seen.draining += 1;
    } else {
        seen.hosts += 1;
        seen.memory_mib += host.memory_mib;
        seen.free_memory_mib += host.free_memory_mib;
        seen.memory_rooms = seen
            .memory_rooms
            .saturating_add(policy.rooms(host.free_memory_mib, None));
        seen.cpu_millis += host.cpu_millis;
        seen.free_cpu_millis += host.free_cpu_millis;
        seen.most_cpu_millis = seen.most_cpu_millis.max(host.cpu_millis);
        seen.host_cpu_millis = seen.host_cpu_millis.max(host.registered_cpu_millis);
        seen.rooms = seen
            .rooms
            .saturating_add(policy.rooms(host.free_memory_mib, Some(host.free_cpu_millis)));
    }
}

/// The group size that gives `seen` the `usable` hosts the policy asks
/// for: the group holds its draining and stalled places besides, so it
/// grows from its present size by as many as are short, up to `max_hosts`.
fn grown_size(target_size: u32, seen: &GroupView, usable: u32, max_hosts: u32) -> u32 {
    let short = usable.saturating_sub(seen.hosts + seen.booting);
    target_size.saturating_add(short).min(max_hosts)
}

/// Grows the group if its spare memory would run short, and starts its
/// stopped members whose hosts are gone. A member without a host counts
/// as booting for [`Scaling::boot_within`]; one stalled past that keeps
/// its place in the group but brings nothing, so the group grows past it.
/// Returns the prefix of its instances' names.
/// Sizes the group once; answers its instances' name prefix and how it
/// looked.
async fn scale(
    scaling: &Scaling,
    view: &View,
    boots: &mut Boots,
) -> anyhow::Result<(String, GroupSeen)> {
    let described = scaling.group.describe().await?;
    let prefix = format!("{}-", described.base_instance_name);
    let members = scaling.group.members().await?;
    let hosts = view.group(|name| name.starts_with(&prefix));
    start_stopped(scaling, &hosts, &members).await;
    let seen = boots.count(
        described.target_size,
        &members,
        &hosts,
        scaling.boot_within,
        &scaling.policy,
    );
    match scaling.policy.decide(&seen) {
        ScaleDecision::Grow { to } => {
            let to = grown_size(described.target_size, &seen, to, scaling.policy.max_hosts);
            if to > described.target_size {
                tracing::info!(
                    from = described.target_size,
                    to,
                    draining = seen.draining,
                    stalled = seen.stalled,
                    free_mib = seen.free_memory_mib,
                    "growing the host group"
                );
                scaling.group.resize(to).await?;
            }
        }
        ScaleDecision::Shrink => {
            tracing::info!(
                "the host group has more spare than it needs; drain a host to shrink it"
            );
        }
        ScaleDecision::Hold => {}
    }
    let seen = GroupSeen {
        view: seen,
        size: described.target_size,
        max: scaling.policy.max_hosts,
    };
    Ok((prefix, seen))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    const HOST: HostId = HostId(1);

    fn terms() -> LeaseTerms {
        let mut terms = LeaseTerms {
            term: Duration::from_secs(2),
            margin: Duration::from_secs(1),
            renew_every: Duration::from_millis(200),
            register_every: Duration::from_millis(200),
            request_window: 50,
            watchdog: Duration::from_secs(1),
            stop: Duration::from_millis(200),
            rate_error_ppm: 1_000,
        };
        terms.margin = terms.needed_margin();
        terms.validate().unwrap()
    }

    /// Renewal counts read through `delays`, one per read, then at once;
    /// each read returns the count as it is when the read returns.
    struct Slow {
        count: AtomicU64,
        delays: Mutex<Vec<Duration>>,
        given_up: Mutex<Option<Instant>>,
    }

    impl Leases for Slow {
        async fn renewals(&self) -> store::Result<Vec<(HostId, u64)>> {
            let delay = {
                let mut delays = self.delays.lock().unwrap();
                if delays.is_empty() {
                    Duration::ZERO
                } else {
                    delays.remove(0)
                }
            };
            tokio::time::sleep(delay).await;
            Ok(vec![(HOST, self.count.load(Ordering::SeqCst))])
        }

        fn give_up(
            &self,
            _host: HostId,
            renewals: u64,
        ) -> impl Future<Output = store::Result<Option<usize>>> + Send {
            let answer = if self.count.load(Ordering::SeqCst) == renewals {
                self.given_up.lock().unwrap().get_or_insert(Instant::now());
                Some(0)
            } else {
                None
            };
            std::future::ready(Ok(answer))
        }
    }

    /// A read that takes longer than the margin shows a renewal sent just
    /// before it returned: the host's lease runs a whole term from that
    /// renewal, and the leader must not give up on it before then, however
    /// fast its later reads are.
    #[tokio::test(start_paused = true)]
    async fn a_slow_read_never_gives_up_on_a_host_within_its_lease() {
        let terms = terms();
        let slow = terms.margin + Duration::from_secs(1);
        let leases = Arc::new(Slow {
            count: AtomicU64::new(1),
            delays: Mutex::new(vec![slow]),
            given_up: Mutex::new(None),
        });
        let view = View::new(1, terms.term);
        let mut leading = Leading::new(Arc::clone(&leases), terms, None);
        let begun = Instant::now();
        // The host renews once, just before the slow read returns, and
        // never again: its lease runs until then plus the term.
        let renews_after = slow.saturating_sub(Duration::from_millis(10));
        let renewer = tokio::spawn({
            let leases = Arc::clone(&leases);
            async move {
                tokio::time::sleep(renews_after).await;
                leases.count.store(2, Ordering::SeqCst);
            }
        });
        let lease_ends = begun + renews_after + terms.term;
        while leases.given_up.lock().unwrap().is_none() {
            leading.tick(&view).await;
            tokio::time::sleep(EVERY).await;
        }
        renewer.await.unwrap();
        let given_up = leases.given_up.lock().unwrap().unwrap();
        assert!(
            given_up >= lease_ends + terms.margin.saturating_sub(EVERY),
            "gave up {:?} after the start, the lease ran {:?}",
            given_up - begun,
            lease_ends - begun
        );
    }

    const GIB: u64 = 1024;

    /// One host that stops renewing, and a give-up that takes but whose
    /// answer is lost: the leader hears an error.
    #[derive(Default)]
    struct AnswerLost {
        given_up: std::sync::atomic::AtomicBool,
        give_ups: AtomicU64,
    }

    impl Leases for AnswerLost {
        fn renewals(&self) -> impl Future<Output = store::Result<Vec<(HostId, u64)>>> + Send {
            std::future::ready(Ok(if self.given_up.load(Ordering::SeqCst) {
                Vec::new()
            } else {
                vec![(HOST, 1)]
            }))
        }

        fn give_up(
            &self,
            _host: HostId,
            _renewals: u64,
        ) -> impl Future<Output = store::Result<Option<usize>>> + Send {
            self.give_ups.fetch_add(1, Ordering::SeqCst);
            self.given_up.store(true, Ordering::SeqCst);
            std::future::ready(Err(store::StoreError::Database(
                "the connection closed".into(),
            )))
        }
    }

    /// A host given up on without the leader hearing it worked, and then
    /// forgotten, leaves nothing behind in the leader: the next read lacks
    /// it, so it is neither watched nor tried again.
    #[tokio::test(start_paused = true)]
    async fn a_host_the_reads_no_longer_list_is_neither_watched_nor_tried_again() {
        let terms = terms();
        let leases = Arc::new(AnswerLost::default());
        let view = View::new(1, terms.term);
        let mut leading = Leading::new(Arc::clone(&leases), terms, None);
        while leases.give_ups.load(Ordering::SeqCst) == 0 {
            leading.tick(&view).await;
            tokio::time::sleep(EVERY).await;
        }
        leading.tick(&view).await;
        assert_eq!(leading.still().count(), 0, "no longer watched");
        // Long past the wait before a failed give-up is tried again.
        for _ in 0..100 {
            tokio::time::sleep(FENCE_AGAIN).await;
            leading.tick(&view).await;
        }
        assert_eq!(leases.give_ups.load(Ordering::SeqCst), 1, "not tried again");
        assert!(leading.again_at.is_empty(), "nor waiting to be");
    }

    /// Rooms for sandboxes of up to 4 GiB and 2 processors, two kept.
    const POLICY: ScalePolicy = ScalePolicy {
        spare_per_mille: 200,
        spare_largest: 2,
        largest_mib: 4 * GIB,
        largest_cpu_millis: 2000,
        host_memory_mib: 64 * GIB,
        min_hosts: 1,
        max_hosts: 10,
    };

    fn member(name: &str) -> Member {
        Member {
            name: name.to_owned(),
            stopped: false,
            idle: true,
            leaving: false,
        }
    }

    fn live(free_gib: u64) -> GroupHost {
        GroupHost {
            draining: false,
            memory_mib: 64 * GIB,
            free_memory_mib: free_gib * GIB,
            cpu_millis: 30_000,
            free_cpu_millis: 30_000,
            registered_cpu_millis: 30_000,
        }
    }

    fn hosts(named: &[(&str, GroupHost)]) -> HashMap<String, GroupHost> {
        named
            .iter()
            .map(|(name, host)| ((*name).to_owned(), *host))
            .collect()
    }

    /// An allowance every member without a host is within, and one every
    /// such member is past.
    const BOOTING: Duration = Duration::from_secs(3_600);
    const STALLED: Duration = Duration::ZERO;

    #[tokio::test]
    async fn a_registered_host_the_listing_does_not_name_takes_one_place() {
        // One place asked for, nothing listed yet, and its host registered.
        let seen =
            Boots::default().count(1, &[], &hosts(&[("hosts-a", live(1))]), BOOTING, &POLICY);
        assert_eq!((seen.hosts, seen.booting), (1, 0), "{seen:?}");
        assert_eq!(grown_size(1, &seen, 2, 10), 2);
        // Two places asked for: the other is booting.
        let seen =
            Boots::default().count(2, &[], &hosts(&[("hosts-a", live(1))]), BOOTING, &POLICY);
        assert_eq!((seen.hosts, seen.booting), (1, 1), "{seen:?}");
    }

    #[tokio::test]
    async fn a_host_the_group_let_go_brings_nothing_without_a_place_for_it() {
        // One place, listed; the other host was let go (abandoned, its
        // listing gone) but is still registered.
        let members = [member("hosts-a")];
        let registered = hosts(&[("hosts-a", live(1)), ("hosts-b", live(64))]);
        let seen = Boots::default().count(1, &members, &registered, BOOTING, &POLICY);
        assert_eq!(
            (seen.hosts, seen.booting, seen.free_memory_mib),
            (1, 0, GIB),
            "{seen:?}"
        );
        assert_eq!(grown_size(1, &seen, 2, 10), 2);
        // With one place not listed, only the host with least spare takes it.
        let registered = hosts(&[
            ("hosts-a", live(1)),
            ("hosts-b", live(64)),
            ("hosts-c", live(2)),
        ]);
        let seen = Boots::default().count(2, &members, &registered, BOOTING, &POLICY);
        assert_eq!(
            (seen.hosts, seen.booting, seen.free_memory_mib),
            (2, 0, 3 * GIB),
            "{seen:?}"
        );
    }

    #[tokio::test]
    async fn draining_and_stalled_places_are_grown_around() {
        let mut draining = live(64);
        draining.draining = true;
        let members = [member("hosts-a"), member("hosts-b"), member("hosts-c")];
        let registered = hosts(&[("hosts-a", live(1)), ("hosts-b", draining)]);
        let seen = Boots::default().count(3, &members, &registered, STALLED, &POLICY);
        assert_eq!(
            (seen.hosts, seen.draining, seen.stalled, seen.booting),
            (1, 1, 1, 0),
            "{seen:?}"
        );
        // Two usable hosts wanted, one live: one more on top of the three
        // places.
        assert_eq!(grown_size(3, &seen, 2, 10), 4);
        assert_eq!(grown_size(3, &seen, 2, 3), 3, "never past the maximum");
        // Within the allowance the third member is coming.
        let seen = Boots::default().count(3, &members, &registered, BOOTING, &POLICY);
        assert_eq!((seen.booting, seen.stalled), (1, 0), "{seen:?}");
    }

    #[tokio::test]
    async fn a_stalled_member_holds_off_a_shrink() {
        let policy = POLICY;
        let members = [
            member("hosts-a"),
            member("hosts-b"),
            member("hosts-c"),
            member("hosts-d"),
        ];
        let registered = hosts(&[
            ("hosts-a", live(64)),
            ("hosts-b", live(64)),
            ("hosts-c", live(64)),
        ]);
        let mut boots = Boots::default();
        let booting = boots.count(4, &members, &registered, BOOTING, &POLICY);
        assert_eq!(policy.decide(&booting), ScaleDecision::Hold);
        let stalled = boots.count(4, &members, &registered, STALLED, &POLICY);
        assert_eq!(stalled.stalled, 1, "{stalled:?}");
        assert_eq!(policy.decide(&stalled), ScaleDecision::Hold);
        let settled = boots.count(3, &members[..3], &registered, STALLED, &POLICY);
        assert_eq!(policy.decide(&settled), ScaleDecision::Shrink, "control");
    }

    #[tokio::test]
    async fn a_member_the_group_is_removing_holds_no_place() {
        let mut leaving = member("hosts-a");
        leaving.leaving = true;
        let members = [leaving, member("hosts-b")];
        let registered = hosts(&[("hosts-a", live(64)), ("hosts-b", live(1))]);
        let seen = Boots::default().count(1, &members, &registered, BOOTING, &POLICY);
        assert_eq!(
            (seen.hosts, seen.booting, seen.free_memory_mib),
            (1, 0, GIB),
            "{seen:?}"
        );
    }

    #[tokio::test]
    async fn spare_in_slivers_across_hosts_holds_no_room_and_grows_the_group() {
        let sliver = GroupHost {
            cpu_millis: 7500,
            free_cpu_millis: 1500,
            registered_cpu_millis: 7500,
            ..live(64)
        };
        let members = [
            member("hosts-a"),
            member("hosts-b"),
            member("hosts-c"),
            member("hosts-d"),
        ];
        let registered = hosts(&[
            ("hosts-a", sliver),
            ("hosts-b", sliver),
            ("hosts-c", sliver),
            ("hosts-d", sliver),
        ]);
        let seen = Boots::default().count(4, &members, &registered, BOOTING, &POLICY);
        assert_eq!(
            (seen.free_cpu_millis, seen.rooms, seen.memory_rooms),
            (6000, 0, 64),
            "{seen:?}"
        );
        // 6000 free is all the share asks, but no host can take a sandbox
        // of 2 processors: one more host, which brings three rooms.
        assert_eq!(POLICY.decide(&seen), ScaleDecision::Grow { to: 5 });
    }

    /// Hosts that registered with 7.5 processors but guarantee none now,
    /// say while something beside their sandboxes takes all of them, have
    /// no processor time to spare: the group grows by what a new host
    /// brings and never shrinks, however much memory is free.
    #[tokio::test]
    async fn hosts_guaranteeing_no_processor_time_now_grow_the_group() {
        let none = GroupHost {
            cpu_millis: 0,
            free_cpu_millis: 0,
            registered_cpu_millis: 7500,
            ..live(64)
        };
        let members = [
            member("hosts-a"),
            member("hosts-b"),
            member("hosts-c"),
            member("hosts-d"),
        ];
        let registered = hosts(&[
            ("hosts-a", none),
            ("hosts-b", none),
            ("hosts-c", none),
            ("hosts-d", none),
        ]);
        let seen = Boots::default().count(4, &members, &registered, BOOTING, &POLICY);
        assert_eq!(
            (
                seen.cpu_millis,
                seen.host_cpu_millis,
                seen.most_cpu_millis,
                seen.rooms
            ),
            (0, 7500, 0, 0),
            "{seen:?}"
        );
        assert_eq!(POLICY.decide(&seen), ScaleDecision::Grow { to: 5 });
        let full = ScalePolicy {
            max_hosts: 4,
            ..POLICY
        };
        assert_eq!(full.decide(&seen), ScaleDecision::Hold);
    }
}
