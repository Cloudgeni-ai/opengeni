use super::{Capacity, ClassId, Demand, Fleet, HostId, HostInfo, HostState, Rng, ShapeKey, ZoneId};

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
        free_disk_mib: 100_000,
        ready: Vec::new(),
        sandboxes: 0,
    }
}

fn demand(memory_mib: u64) -> Demand {
    Demand {
        memory_mib,
        memory_max_mib: memory_mib * 2,
        disk_mib: 1_000,
        shape: None,
        class: None,
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
    assert_eq!(fleet.place(&demand(500), &[HostId(3)], &mut rng), None);
    assert_eq!(fleet.place(&demand(5_000), &[], &mut rng), None);
    let mut disk = demand(500);
    disk.disk_mib = 1_000_000;
    assert_eq!(fleet.place(&disk, &[], &mut rng), None);
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
    wanted.shape = Some(SHAPE);
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
    wanted.class = Some(ClassId(5));
    let mut rng = Rng::new(4);
    let placed = fleet.place(&wanted, &[], &mut rng).unwrap();
    assert_eq!(placed.host, HostId(99));
    assert!(placed.same_class);
    let placed = fleet.place(&wanted, &[HostId(99)], &mut rng).unwrap();
    assert!(!placed.same_class);
}

#[test]
fn huge_page_hosts_need_all_the_guest_memory() {
    let mut fleet = Fleet::new();
    let huge = HostInfo {
        huge_pages: true,
        ..info(0)
    };
    fleet.upsert(HostId(1), huge, HostState::Live, capacity(1_500));
    let mut rng = Rng::new(5);
    assert!(fleet.place(&demand(700), &[], &mut rng).is_some());
    assert!(fleet.place(&demand(800), &[], &mut rng).is_none());
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
    wanted.shape = Some(SHAPE);
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
