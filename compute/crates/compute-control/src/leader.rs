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
//! A host of the group it sizes is fenced before it is given up on: its
//! instance is reset (or found stopped or gone) through the cloud's API,
//! so nothing it ran can still run when its sandboxes go elsewhere. Fences
//! run beside the leader's loop, and a host whose fence fails is not given
//! up on until one succeeds. A host outside any group has only its own
//! deadline, the guard and the watchdog to stop it (ADR 18).

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use compute_fleet::{At, Expiry, HostId, HostState, LeaseTerms, ScaleDecision, ScalePolicy};
use tokio::task::JoinSet;
use tokio::time::Instant;

use crate::group::{Fenced, GcpGroup, Member, Started};
use crate::store::{self, Store};
use crate::view::View;

/// How often the leader looks at renewal counts.
const EVERY: Duration = Duration::from_millis(250);
/// How often a replica that does not lead tries to.
const TRY_EVERY: Duration = Duration::from_secs(1);
/// How long a fence may take before it counts as failed.
const FENCE_WITHIN: Duration = Duration::from_secs(120);
/// How long after a failed fence the next one starts.
const FENCE_AGAIN: Duration = Duration::from_secs(5);

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
        Store::give_up(self, host, renewals)
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
    scaling: Option<Scaling>,
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
        led(&store, &view, terms, scaling.as_ref(), lead).await;
        tracing::warn!("this replica no longer leads");
    }
}

async fn led<S: Store>(
    store: &Arc<S>,
    view: &View,
    terms: LeaseTerms,
    scaling: Option<&Scaling>,
    mut lead: S::Lead,
) {
    let group = scaling.map(|scaling| Arc::clone(&scaling.group));
    let mut leading = Leading::new(Arc::clone(store), terms, group);
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
        if let Some(scaling) = scaling
            && scaled.is_none_or(|when| when.elapsed() >= scaling.every)
        {
            scaled = Some(Instant::now());
            match scale(scaling, view, &mut boots).await {
                Ok(prefix) => leading.prefix = Some(prefix),
                Err(error) => tracing::warn!(%error, "sizing the host group failed"),
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
    /// The host each fence under way is for.
    fencing: HashMap<tokio::task::Id, HostId>,
    /// Hosts whose last fence failed, and when the next may start.
    again_at: HashMap<HostId, Instant>,
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
    /// `group`.
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
        }
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
        for (host, count) in renewals {
            self.expiry.observe(host, count, now);
        }
        let lapsed: Vec<_> = self.expiry.expired(now).collect();
        for (host, renewals) in lapsed {
            match self.lapse(host, view).await {
                Lapse::GiveUp => {
                    let result = self.leases.give_up(host, renewals).await;
                    self.given_up(host, result.map_err(|error| error.to_string()));
                }
                Lapse::Fence(group, name) => {
                    let leases = Arc::clone(&self.leases);
                    let task = self
                        .fences
                        .spawn(fence_and_give_up(leases, group, host, name, renewals));
                    self.fencing.insert(task.id(), host);
                }
                Lapse::Later => {}
            }
        }
    }

    /// Whether `host` is fenced first, given up on now, or decided later.
    async fn lapse(&mut self, host: HostId, view: &View) -> Lapse {
        if self.fencing.values().any(|fenced| *fenced == host)
            || self
                .again_at
                .get(&host)
                .is_some_and(|at| Instant::now() < *at)
        {
            return Lapse::Later;
        }
        let Some(group) = &self.group else {
            return Lapse::GiveUp;
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
            Lapse::Fence(Arc::clone(group), name)
        } else {
            Lapse::GiveUp
        }
    }

    /// Takes in the fences that ended.
    fn reap(&mut self) {
        while let Some(joined) = self.fences.try_join_next_with_id() {
            let (id, result) = match joined {
                Ok((id, (_, result))) => (id, result),
                Err(error) => (error.id(), Err(format!("the fence ended: {error}"))),
            };
            if let Some(host) = self.fencing.remove(&id) {
                self.given_up(host, result);
            }
        }
    }

    /// Takes in how giving up on `host` went.
    fn given_up(&mut self, host: HostId, result: Result<Option<usize>, String>) {
        match result {
            Ok(given_up) => {
                // Either way it starts afresh: a host that renewed is
                // watched again from its new count, and one already given
                // up on is no longer listed.
                self.expiry.forget(host);
                self.again_at.remove(&host);
                if let Some(sandboxes) = given_up {
                    tracing::warn!(host = host.0, sandboxes, "gave up on a host");
                }
            }
            Err(error) => {
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

/// Whether `name` is a host the service counts on: registered and not
/// given up on.
fn hosted(view: &View, name: &str) -> bool {
    view.named(name)
        .is_some_and(|known| known.state != HostState::Lost)
}

/// Starts the group's stopped members whose hosts are given up on or never
/// registered, and that the group itself is doing nothing to: a fenced
/// host stopped before the leader could start it again, or one stopped
/// for any other reason. One still live in the view is started once it is
/// given up on. One that fails to start is tried again at the next look,
/// and keeps neither the others from starting nor the group from growing.
async fn start_stopped(scaling: &Scaling, view: &View, members: &[Member]) {
    for member in members {
        if !member.stopped || !member.idle || hosted(view, &member.name) {
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
    /// How many of `members` without a host are booting, within `within`
    /// of when they were first seen without one, and how many are past it.
    /// Says once when a member stalls, and when a stalled one registers.
    fn count(&mut self, members: &[Member], view: &View, within: Duration) -> (u32, u32) {
        let now = Instant::now();
        let mut before = std::mem::take(&mut self.0);
        let (mut booting, mut stalled) = (0u32, 0u32);
        for member in members {
            let seen = before.remove(&member.name);
            if hosted(view, &member.name) {
                if seen.is_some_and(|boot| boot.stalled) {
                    tracing::info!(name = %member.name, "a stalled host registered");
                }
                continue;
            }
            let mut boot = seen.unwrap_or(Boot {
                since: now,
                stalled: false,
            });
            if now.duration_since(boot.since) < within {
                booting += 1;
            } else {
                if !boot.stalled {
                    tracing::warn!(
                        name = %member.name,
                        ?within,
                        "a host group member has not registered in time; its memory no longer counts as coming"
                    );
                    boot.stalled = true;
                }
                stalled += 1;
            }
            self.0.insert(member.name.clone(), boot);
        }
        (booting, stalled)
    }
}

/// Grows the group if its spare memory would run short, and starts its
/// stopped members whose hosts are gone. A member without a host counts
/// as booting for [`Scaling::boot_within`]; one stalled past that keeps
/// its place in the group but brings nothing, so the group grows past it.
/// Returns the prefix of its instances' names.
async fn scale(scaling: &Scaling, view: &View, boots: &mut Boots) -> anyhow::Result<String> {
    let described = scaling.group.describe().await?;
    let prefix = format!("{}-", described.base_instance_name);
    let members = scaling.group.members().await?;
    start_stopped(scaling, view, &members).await;
    let mut seen = view.group(|name| name.starts_with(&prefix));
    let (booting, stalled) = boots.count(&members, view, scaling.boot_within);
    // Asked for, and not listed yet.
    let unlisted = described
        .target_size
        .saturating_sub(u32::try_from(members.len()).unwrap_or(u32::MAX));
    seen.booting = booting + unlisted;
    match scaling.policy.decide(&seen) {
        ScaleDecision::Grow { to } => {
            let to = to.saturating_add(stalled).min(scaling.policy.max_hosts);
            if to > described.target_size {
                tracing::info!(
                    from = described.target_size,
                    to,
                    stalled,
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
    Ok(prefix)
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
        let view = View::new(1);
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
}
