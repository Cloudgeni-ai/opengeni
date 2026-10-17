//! How long the service's decisions take at fleet scale: 5,000 hosts and
//! 500,000 sandboxes, with the fleet filling up as it goes.
//!
//! Each decision a create, wake, renewal or recovery pass needs is timed
//! on its own, and its 99th percentile must stay well under a millisecond
//! (twenty times that in a debug build). The service's real cost per
//! request is its store round trips; these are what it adds on top.
//!
//! `FLEET_BUDGET_PRINT=1` prints the percentiles, as recorded in
//! `docs/measurements.md` from a release build.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use compute_fleet::{
    At, Capacity, ClassId, Demand, Expiry, Fleet, HostId, HostInfo, HostState, LeaseTerms,
    OwnerEpoch, Ownership, Prefer, Rng, SandboxId, ShapeKey, Verdict, ZoneId, reconcile,
};

const HOSTS: u64 = 5_000;
const SANDBOXES: u64 = 500_000;
const HOST_MEMORY_MIB: u64 = 384 * 1024;
const SHAPES: u64 = 8;

/// Per-decision durations of one kind.
#[derive(Default)]
struct Timings(Vec<Duration>);

impl Timings {
    fn time<T>(&mut self, work: impl FnOnce() -> T) -> T {
        let start = Instant::now();
        // Kept, so the optimiser cannot drop work whose result goes unused.
        let out = std::hint::black_box(work());
        self.0.push(start.elapsed());
        out
    }

    fn percentile(&mut self, per_mille: usize) -> Duration {
        self.0.sort_unstable();
        let index = (self.0.len() * per_mille / 1_000).min(self.0.len() - 1);
        self.0[index]
    }

    fn check(&mut self, what: &str) {
        let (p50, p99, max) = (
            self.percentile(500),
            self.percentile(990),
            self.percentile(1_000),
        );
        if std::env::var_os("FLEET_BUDGET_PRINT").is_some() {
            println!(
                "{what:<34} n={:>7}  p50 {:>8.2} µs  p99 {:>8.2} µs  max {:>9.2} µs",
                self.0.len(),
                micros(p50),
                micros(p99),
                micros(max)
            );
        }
        let budget = if cfg!(debug_assertions) {
            Duration::from_millis(20)
        } else {
            Duration::from_millis(1)
        };
        assert!(p99 < budget, "{what}: p99 {p99:?} over {budget:?}");
    }
}

fn micros(span: Duration) -> f64 {
    span.as_secs_f64() * 1e6
}

fn host_info(id: u64) -> HostInfo {
    HostInfo {
        zone: ZoneId(u16::try_from(id % 3).unwrap()),
        class: ClassId(u16::try_from(id % 2).unwrap()),
        huge_pages: id.is_multiple_of(4),
    }
}

fn capacity(free_memory_mib: u64, sandboxes: u32, rng: &mut Rng) -> Capacity {
    let ready = (0..SHAPES)
        .filter_map(|shape| {
            let count = u32::try_from(rng.below(4)).unwrap();
            rng.chance(1, 3).then_some((ShapeKey(shape), count))
        })
        .collect();
    Capacity {
        memory_mib: HOST_MEMORY_MIB,
        free_memory_mib,
        free_disk_mib: 2_000_000,
        ready,
        sandboxes,
    }
}

fn demand(rng: &mut Rng) -> Demand {
    let memory_mib = [512, 1_024, 2_048, 4_096][rng.index(4)];
    Demand {
        memory_mib,
        memory_max_mib: memory_mib * 2,
        disk_mib: 1_024,
        // Creates and adopts in equal parts.
        prefer: if rng.chance(1, 2) {
            Prefer::ReadyClone(ShapeKey(rng.below(SHAPES)))
        } else {
            Prefer::Class(ClassId(u16::try_from(rng.below(2)).unwrap()))
        },
    }
}

#[test]
#[expect(clippy::too_many_lines, reason = "one scenario, step by step")]
fn decisions_stay_well_under_a_millisecond_at_5000_hosts_and_500000_sandboxes() {
    let mut rng = Rng::new(7);
    let mut fleet = Fleet::new();
    let mut rows: BTreeMap<SandboxId, Ownership> = BTreeMap::new();
    let mut on_host: Vec<Vec<SandboxId>> = vec![Vec::new(); usize::try_from(HOSTS).unwrap()];
    let mut used = vec![0_u64; usize::try_from(HOSTS).unwrap()];
    for id in 0..HOSTS {
        let capacity = capacity(HOST_MEMORY_MIB, 0, &mut rng);
        fleet.upsert(HostId(id), host_info(id), HostState::Live, capacity);
    }

    // Creates: place, then count it against the host until it reports.
    let mut create = Timings::default();
    let mut next = 0_u64;
    while next < SANDBOXES {
        let wanted = demand(&mut rng);
        let placed = create.time(|| {
            let placement = fleet.place(&wanted, &[], &mut rng)?;
            fleet.reserve(placement, &wanted);
            Some(placement)
        });
        let placement = placed.expect("the fleet has room for every sandbox");
        let id = SandboxId(u128::from(next));
        next += 1;
        rows.insert(id, Ownership::created(placement.host));
        let host = usize::try_from(placement.host.0).unwrap();
        on_host[host].push(id);
        used[host] += wanted.memory_mib;
    }
    create.check("create: place and reserve");

    // Renewals: every host reports its capacity.
    let mut renew = Timings::default();
    for round in 0..3 {
        for id in 0..HOSTS {
            let host = usize::try_from(id).unwrap();
            let free = HOST_MEMORY_MIB.saturating_sub(used[host] / (round + 1));
            let sandboxes = u32::try_from(on_host[host].len()).unwrap();
            let report = capacity(free, sandboxes, &mut rng);
            renew.time(|| fleet.update(HostId(id), report));
        }
    }
    renew.check("renewal: capacity into the view");

    // Creates again once the fleet is nearly full, so most draws miss.
    for id in 0..HOSTS {
        let host = usize::try_from(id).unwrap();
        let free = if id % 50 == 0 { 64 * 1024 } else { 256 };
        let report = capacity(free, u32::try_from(on_host[host].len()).unwrap(), &mut rng);
        fleet.update(HostId(id), report);
    }
    let mut full = Timings::default();
    let mut found = 0;
    for _ in 0..20_000 {
        let wanted = demand(&mut rng);
        let placement = full.time(|| fleet.place(&wanted, &[], &mut rng));
        let host = placement.expect("some hosts have room").host;
        assert_eq!(host.0 % 50, 0, "placed on a full host");
        found += 1;
    }
    assert_eq!(found, 20_000);
    full.check("create: place, fleet 98 % full");

    // The worst case: nothing fits, so every pool is walked to the end.
    for id in (0..HOSTS).step_by(50) {
        let host = usize::try_from(id).unwrap();
        let report = capacity(256, u32::try_from(on_host[host].len()).unwrap(), &mut rng);
        fleet.update(HostId(id), report);
    }
    let mut none = Timings::default();
    for _ in 0..2_000 {
        let wanted = demand(&mut rng);
        assert!(none.time(|| fleet.place(&wanted, &[], &mut rng)).is_none());
    }
    none.check("create: no host has room");

    // Wakes: the owner lookup in front of the proxy hop.
    let mut wake = Timings::default();
    for _ in 0..200_000 {
        let id = SandboxId(u128::from(rng.below(SANDBOXES)));
        wake.time(|| rows.get(&id).and_then(|row| row.owner));
    }
    wake.check("wake: find the owner");

    // Recovery: one pass of the leader over every host's renewal count.
    let terms = LeaseTerms::RECOMMENDED;
    let mut expiry = Expiry::new(terms);
    let mut pass = Timings::default();
    let mut counts = vec![0_u64; usize::try_from(HOSTS).unwrap()];
    for tick in 0..200_u64 {
        let now = At::from_millis(tick * 250);
        for count in &mut counts {
            if rng.chance(1, 13) {
                *count += 1;
            }
        }
        pass.time(|| {
            for (id, count) in counts.iter().enumerate() {
                expiry.observe(HostId(id as u64), *count, now);
            }
            expiry.expired(now).count()
        });
    }
    pass.check("recovery: one pass over all hosts");

    // A host coming back lists what it has: one decision per sandbox, and
    // losing one clears every sandbox it owned.
    let mut back = Timings::default();
    let mut lose = Timings::default();
    for id in 0..200_u64 {
        let host = HostId(id * 7 % HOSTS);
        let owned = on_host[usize::try_from(host.0).unwrap()].clone();
        lose.time(|| {
            for sandbox in &owned {
                if let Some(row) = rows.get_mut(sandbox) {
                    *row = row.clear().set;
                }
            }
        });
        let verdicts: Vec<Verdict> = back.time(|| {
            owned
                .iter()
                .map(|sandbox| reconcile(host, OwnerEpoch::FIRST, rows.get(sandbox).copied()))
                .collect()
        });
        // Nobody took them since: the host gets each back.
        assert!(
            verdicts
                .iter()
                .all(|verdict| matches!(verdict, Verdict::Reclaim { .. }))
        );
    }
    lose.check("loss: clear a host's sandboxes");
    back.check("registration: reconcile a host");
}
