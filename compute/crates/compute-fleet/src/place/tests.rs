use super::{
    Capacity, ClassId, Demand, Fleet, HostId, HostInfo, HostState, Prefer, Rng, ShapeKey, ZoneId,
};

const SHAPE: ShapeKey = ShapeKey(42);

fn info(zone: u16) -> HostInfo {
    HostInfo {
        zone: ZoneId(zone),
        class: ClassId(0),
        huge_pages: false,
    }
}

fn capacity(free_mib: u64) -> Capacity {
    Capacity {
        memory_mib: 64 * 1024,
        free_memory_mib: free_mib,
        free_cpu_millis: 64_000,
        free_disk_mib: 100_000,
        ready: Vec::new(),
        sandboxes: 0,
    }
}

fn demand(memory_mib: u64) -> Demand {
    Demand {
        memory_mib,
        memory_max_mib: memory_mib * 2,
        cpu_millis: 0,
        disk_mib: 1_000,
        prefer: Prefer::Any,
    }
}

fn fleet(hosts: u64, free_mib: u64) -> Fleet {
    let mut fleet = Fleet::new();
    for id in 0..hosts {
        #[allow(clippy::cast_possible_truncation)]
        let zone = (id % 3) as u16;
        fleet.upsert(HostId(id), info(zone), HostState::Live, capacity(free_mib));
    }
    fleet
}

#[test]
fn only_live_hosts_that_fit_and_were_not_excluded_are_chosen() {
    let mut fleet = fleet(4, 1_000);
    fleet.update(HostId(0), capacity(100));
    fleet.set_state(HostId(1), HostState::Lost);
    fleet.set_state(HostId(2), HostState::Draining);
    let mut rng = Rng::new(1);
    for _ in 0..200 {
        let placed = fleet.place(&demand(500), &[], &mut rng).unwrap();
        assert_eq!(placed.host, HostId(3));
    }
    // When none fits by the view, a live host is asked anyway, and only
    // once every live host has refused is nothing left.
    let asked = fleet.place(&demand(500), &[HostId(3)], &mut rng).unwrap();
    assert_eq!(asked.host, HostId(0));
    assert_eq!(
        fleet.place(&demand(500), &[HostId(3), HostId(0)], &mut rng),
        None
    );
    for _ in 0..50 {
        let host = fleet.place(&demand(5_000), &[], &mut rng).unwrap().host;
        assert!(host == HostId(0) || host == HostId(3), "asked {host:?}");
    }
    let mut disk = demand(500);
    disk.disk_mib = 1_000_000;
    assert!(fleet.place(&disk, &[], &mut rng).is_some());
    // No host's memory could ever hold it.
    assert_eq!(fleet.place(&demand(100_000), &[], &mut rng), None);
}

#[test]
fn a_host_found_by_walking_the_pool_when_few_fit() {
    let mut fleet = fleet(5_000, 100);
    fleet.update(HostId(4_321), capacity(10_000));
    let mut rng = Rng::new(9);
    for _ in 0..50 {
        assert_eq!(
            fleet.place(&demand(1_000), &[], &mut rng).unwrap().host,
            HostId(4_321)
        );
    }
}

#[test]
fn a_host_with_a_ready_clone_is_preferred() {
    let mut fleet = fleet(50, 8_000);
    let mut ready = capacity(2_000);
    ready.ready = vec![(SHAPE, 2)];
    fleet.update(HostId(7), ready);
    let mut wanted = demand(1_000);
    wanted.prefer = Prefer::ReadyClone(SHAPE);
    let mut rng = Rng::new(3);
    let placed = fleet.place(&wanted, &[], &mut rng).unwrap();
    assert_eq!(placed.host, HostId(7));
    assert!(placed.ready);
    // Using both clones takes the host out of the ready set.
    fleet.reserve(placed, &wanted);
    fleet.reserve(placed, &wanted);
    let placed = fleet.place(&wanted, &[], &mut rng).unwrap();
    assert!(!placed.ready);
    assert_ne!(
        placed.host,
        HostId(7),
        "the host with less free memory won without a clone"
    );
}

#[test]
fn the_class_of_the_memory_image_is_preferred_then_any() {
    let mut fleet = fleet(30, 8_000);
    let other = HostInfo {
        class: ClassId(5),
        ..info(1)
    };
    fleet.upsert(HostId(99), other, HostState::Live, capacity(1_000));
    let mut wanted = demand(500);
    wanted.prefer = Prefer::Class(ClassId(5));
    let mut rng = Rng::new(4);
    let placed = fleet.place(&wanted, &[], &mut rng).unwrap();
    assert_eq!(placed.host, HostId(99));
    assert!(placed.same_class);
    let placed = fleet.place(&wanted, &[HostId(99)], &mut rng).unwrap();
    assert!(!placed.same_class);
}

#[test]
fn an_adopt_goes_to_its_class_even_past_ready_clones_and_more_memory() {
    // Every host of class 0 has a ready clone and eight times the memory;
    // the one of the image's class has neither.
    let mut fleet = Fleet::new();
    for id in 0..30 {
        let mut roomy = capacity(8_000);
        roomy.ready = vec![(SHAPE, 4)];
        fleet.upsert(
            HostId(id),
            info(u16::try_from(id % 3).unwrap()),
            HostState::Live,
            roomy,
        );
    }
    let image_class = HostInfo {
        class: ClassId(5),
        ..info(1)
    };
    fleet.upsert(HostId(99), image_class, HostState::Live, capacity(1_000));
    let mut wanted = demand(500);
    wanted.prefer = Prefer::Class(ClassId(5));
    let mut rng = Rng::new(9);
    for _ in 0..50 {
        let placed = fleet.place(&wanted, &[], &mut rng).unwrap();
        assert_eq!(
            placed.host,
            HostId(99),
            "a ready clone won over the image's class"
        );
        assert!(placed.same_class && !placed.ready);
    }
}

#[test]
fn huge_page_hosts_need_all_the_guest_memory() {
    let mut fleet = Fleet::new();
    let huge = HostInfo {
        huge_pages: true,
        ..info(0)
    };
    fleet.upsert(HostId(1), huge, HostState::Live, capacity(1_500));
    fleet.upsert(HostId(2), info(1), HostState::Live, capacity(1_000));
    let mut rng = Rng::new(5);
    // 700 MiB requested, 1400 MiB at most: both fit.
    assert!(fleet.place(&demand(700), &[HostId(2)], &mut rng).is_some());
    // 800 MiB requested fits the plain host, but the huge-page one needs
    // all 1600 MiB.
    for _ in 0..50 {
        assert_eq!(
            fleet.place(&demand(800), &[], &mut rng).unwrap().host,
            HostId(2)
        );
    }
    // A huge-page host whose memory could never hold all of it is not
    // asked at all.
    let small = Capacity {
        memory_mib: 1_500,
        ..capacity(1_500)
    };
    fleet.update(HostId(1), small);
    assert_eq!(fleet.place(&demand(800), &[HostId(2)], &mut rng), None);
}

#[test]
fn reservations_spread_a_burst_evenly() {
    let mut fleet = fleet(100, 64 * 1024);
    let mut rng = Rng::new(6);
    let wanted = demand(256);
    for _ in 0..10_000 {
        let placed = fleet.place(&wanted, &[], &mut rng).unwrap();
        fleet.reserve(placed, &wanted);
    }
    let counts: Vec<u32> = fleet.hosts().map(|(_, _, _, c)| c.sandboxes).collect();
    let (least, most) = (counts.iter().min().unwrap(), counts.iter().max().unwrap());
    // Two choices keep the spread within a few sandboxes of the mean (100).
    assert!(*least >= 90 && *most <= 110, "spread {least}..{most}");
}

#[test]
fn the_view_steers_but_never_refuses() {
    // One host with room for two by its report: creates and removes in
    // quick succession leave reservations its next report may not clear,
    // and a report can still book a sandbox removed since.
    let mut one = fleet(1, 2_000);
    let mut rng = Rng::new(3);
    let wanted = demand(1_000);
    for _ in 0..5 {
        let placed = one.place(&wanted, &[], &mut rng).unwrap();
        assert_eq!(placed.host, HostId(0));
        one.reserve(placed, &wanted);
    }
    assert_eq!(one.get(HostId(0)).unwrap().2.free_memory_mib, 0);
    // The host is still asked; once it refuses, nothing is left.
    assert_eq!(one.place(&wanted, &[HostId(0)], &mut rng), None);
    // More than its report says it has free: still asked.
    assert_eq!(
        one.place(&demand(3_000), &[], &mut rng).unwrap().host,
        HostId(0)
    );

    // With a host that fits after what was sent, that one is chosen.
    let mut two = fleet(2, 2_000);
    for _ in 0..2 {
        two.reserve(
            super::Placement {
                host: HostId(0),
                ready: false,
                same_class: false,
            },
            &wanted,
        );
    }
    for _ in 0..100 {
        assert_eq!(two.place(&wanted, &[], &mut rng).unwrap().host, HostId(1));
    }
    // A report resets what was counted.
    two.update(HostId(0), capacity(2_000));
    assert_eq!(two.get(HostId(0)).unwrap().2.free_memory_mib, 2_000);
}

#[test]
fn the_two_candidates_come_from_different_zones() {
    // Zone 0 has one host with plenty of room, zone 1 many with a little:
    // drawing two from the same zone would rarely see the big one.
    let mut fleet = Fleet::new();
    fleet.upsert(HostId(0), info(0), HostState::Live, capacity(50_000));
    for id in 1..=40 {
        fleet.upsert(HostId(id), info(1), HostState::Live, capacity(1_000));
    }
    let mut rng = Rng::new(8);
    let big = (0..1_000)
        .filter(|_| fleet.place(&demand(100), &[], &mut rng).unwrap().host == HostId(0))
        .count();
    // It is picked whenever it is drawn at all.
    assert!(big > 250, "picked {big} times in 1000");
}

#[test]
fn removed_and_replaced_hosts_leave_no_trace_in_the_indexes() {
    let mut fleet = fleet(10, 4_000);
    let mut ready = capacity(4_000);
    ready.ready = vec![(SHAPE, 1)];
    fleet.update(HostId(3), ready.clone());
    fleet.remove(HostId(3));
    assert_eq!(fleet.len(), 9);
    let mut wanted = demand(100);
    wanted.prefer = Prefer::ReadyClone(SHAPE);
    let mut rng = Rng::new(2);
    for _ in 0..100 {
        let placed = fleet.place(&wanted, &[], &mut rng).unwrap();
        assert!(!placed.ready);
        assert_ne!(placed.host, HostId(3));
    }
    // The freed slot is reused by the next host.
    fleet.upsert(HostId(77), info(0), HostState::Live, ready);
    assert!(fleet.place(&wanted, &[], &mut rng).unwrap().ready);
    assert!(fleet.ready.values().all(|pool| pool.len() > 0));
    fleet.set_state(HostId(77), HostState::Lost);
    assert!(fleet.ready.is_empty());
    assert_eq!(fleet.emptiest(|_| true), Some(HostId(0)));
}
