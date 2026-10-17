//! The fleet on real hosts: a deployed service and at least three hosts in
//! a cloud instance group, each running real Firecracker VMs. Run them one
//! at a time (`--test-threads 1`): they end and cut off hosts.
//!
//! They skip unless `COMPUTE_TEST_FLEET_API` names the service's public
//! API (and fail instead when `COMPUTE_TEST_REQUIRE` has `fleet`). The rest
//! of their environment:
//!
//! - `COMPUTE_TEST_FLEET_KEY`, `COMPUTE_TEST_FLEET_OPERATOR_KEY`: a team's
//!   API key and the operator's.
//! - `COMPUTE_TEST_FLEET_WITNESS`: `address:port` that sandboxes can send
//!   UDP to and that reaches this test, which listens on that port.
//! - `COMPUTE_TEST_FLEET_KILL`, `COMPUTE_TEST_FLEET_CUT`: shell commands,
//!   with `{host}` for a host's name, that end a host at once (no shutdown,
//!   nothing saved) and that cut it off from the service but not from the
//!   witness.
//! - `COMPUTE_TEST_FLEET_HOSTS`: the fewest live hosts a test starts with,
//!   3 by default.
//! - `COMPUTE_TEST_FLEET_SCALE`: `VCPUSxMEMORY_MIB/SECONDS`, the shape of
//!   the sandboxes the scale-out test creates and the seconds between
//!   them; without it that test skips.
//!
//! Every sandbox runs a beater: a shell loop holding a count in memory and
//! sending it to the witness 20 times a second. The witness records when
//! each beat arrived and where from. Hosts send their sandboxes' traffic
//! from their own address, so that names the host the VM ran on, and one
//! clock, this test's, orders every beat. A program kept across a move or a
//! restore counts on from where it was; a sandbox that ran on two hosts at
//! once would send beats from both.

mod support;

use std::time::{Duration, Instant};

use support::{Beat, Fleet, address, token};

/// Beats a second.
const RATE: f64 = 20.0;
/// The lease term the service grants (`LeaseTerms::RECOMMENDED`).
const TERM: Duration = Duration::from_secs(10);
/// What a host's VMs may run past its lease's end: the guard's freeze or
/// kill, and the witness's view of it.
const STOP: Duration = Duration::from_secs(1);

/// Beats from `host` that arrived after `since`.
fn from(beats: &[Beat], host: std::net::IpAddr) -> impl Iterator<Item = &Beat> {
    beats.iter().filter(move |beat| beat.from == host)
}

/// A sandbox moves to a second host and on to a third while it sleeps. Each
/// host wakes it with its files and its running program as they were: the
/// beater counts on from where it stopped, from the new host only.
#[tokio::test(flavor = "multi_thread")]
async fn a_sandbox_moves_between_three_hosts_and_keeps_its_files_and_programs() {
    let Some(fleet) = Fleet::from_env() else {
        return;
    };
    let live = fleet.ready().await;
    let id = fleet.create(1, 512, None).await.expect("a create");
    let token = token();
    let pid = fleet.start_beating(&id, &token).await;
    let first = fleet.owner(&id).await.expect("an owner");
    let mut path = vec![first.clone()];
    path.extend(live.iter().filter(|name| **name != first).take(2).cloned());
    assert_eq!(path.len(), 3, "three hosts: {live:?}");
    for pair in path.windows(2) {
        let (was, to) = (&pair[0], &pair[1]);
        let (was_ip, to_ip) = (address(was).await, address(to).await);
        fleet.witness.beat_from(&id, was_ip, Instant::now()).await;
        let moving = Instant::now();
        fleet.sleep(&id, "archived").await;
        fleet.move_to(&id, to).await;
        let moved = moving.elapsed();
        let (alive, kept) = fleet.check(&id, &pid).await;
        let woken = moving.elapsed().saturating_sub(moved);
        assert!(alive, "the beater did not survive the move to {to}");
        assert_eq!(kept, token, "the file changed on the move to {to}");
        assert_eq!(fleet.owner(&id).await.as_deref(), Some(to.as_str()));
        let next = fleet.witness.beat_from(&id, to_ip, moving).await;
        let beats = fleet.witness.beats(&id);
        let last = from(&beats, was_ip)
            .map(|beat| beat.n)
            .max()
            .unwrap_or_default();
        assert!(
            next.n > last && next.n <= last + 10,
            "the count went from {last} on {was} to {} on {to}: not the same program",
            next.n
        );
        assert!(
            from(&beats, was_ip).all(|beat| beat.at < next.at),
            "{was} ran it after {to} did"
        );
        eprintln!(
            "moved {was} -> {to}: sleep and move {moved:?}, wake and command {woken:?}, count {last} -> {}",
            next.n
        );
    }
    fleet.delete(&id).await;
}

/// A host cut off from the service stops its VMs by the end of its lease,
/// before the service gives up on it and wakes them elsewhere from their
/// last checkpoint: no beat from the old host arrives after the first from
/// the new one. The service resets the host's instance before it gives up,
/// and the host comes back.
#[tokio::test(flavor = "multi_thread")]
async fn a_cut_off_host_stops_its_vms_before_they_run_elsewhere() {
    let Some(fleet) = Fleet::from_env() else {
        return;
    };
    fleet.ready().await;
    let id = fleet.create(1, 512, Some(10_000)).await.expect("a create");
    let token = token();
    let pid = fleet.start_beating(&id, &token).await;
    let host = fleet.owner(&id).await.expect("an owner");
    let host_ip = address(&host).await;
    // Long enough for a checkpoint that holds the beater.
    tokio::time::sleep(Duration::from_secs(25)).await;
    fleet.cut(&host);
    let cut = Instant::now();
    let (alive, kept) = fleet.check(&id, &pid).await;
    let back = cut.elapsed();
    assert!(alive, "the beater did not come back");
    assert_eq!(kept, token);
    let owner = fleet.owner(&id).await.expect("a new owner");
    assert_ne!(owner, host, "it came back on the host that was cut off");
    let next = fleet
        .witness
        .beat_from(&id, address(&owner).await, cut)
        .await;
    // Anything still on its way from the old host has arrived by now.
    tokio::time::sleep(Duration::from_secs(30)).await;
    let beats = fleet.witness.beats(&id);
    let last = from(&beats, host_ip)
        .map(|beat| beat.at)
        .max()
        .expect("beats from the old host");
    assert!(last < next.at, "it ran on both hosts at once");
    let ran_on = last.saturating_duration_since(cut);
    assert!(
        ran_on <= TERM + STOP,
        "the old host's VM ran {ran_on:?} after the cut, past its lease"
    );
    eprintln!(
        "cut off {host}: its VM's last beat {ran_on:?} after the cut; the first on {owner} {:?} after it ({:?} later); \
         the command answered after {back:?}",
        next.at - cut,
        next.at - last
    );
    // The host's instance was reset; it registers again.
    let started = Instant::now();
    while !fleet.live().await.contains(&host) {
        assert!(
            started.elapsed() < Duration::from_secs(600),
            "{host} never came back"
        );
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    eprintln!("{host} live again {:?} after the cut", cut.elapsed());
    assert!(
        from(&fleet.witness.beats(&id), host_ip).all(|beat| beat.at <= last),
        "the old host ran it again"
    );
    fleet.delete(&id).await;
}

/// Sandboxes on a host that dies come back elsewhere from their last
/// checkpoints, each losing only what it did since: its program counts on
/// from the checkpoint, and no more than a checkpoint period is lost.
#[tokio::test(flavor = "multi_thread")]
async fn a_dead_hosts_sandboxes_come_back_elsewhere_losing_only_what_changed_since_their_checkpoints()
 {
    const EVERY: Duration = Duration::from_secs(15);
    let Some(fleet) = Fleet::from_env() else {
        return;
    };
    fleet.ready().await;
    let mut sandboxes = Vec::new();
    let mut victim = None;
    for _ in 0..3 {
        let id = fleet
            .create(1, 512, Some(u64::try_from(EVERY.as_millis()).unwrap()))
            .await
            .expect("a create");
        let token = token();
        let pid = fleet.start_beating(&id, &token).await;
        let owner = fleet.owner(&id).await.expect("an owner");
        let victim = victim.get_or_insert(owner.clone());
        if owner != *victim {
            fleet.sleep(&id, "archived").await;
            fleet.move_to(&id, victim).await;
            assert!(fleet.check(&id, &pid).await.0);
        }
        sandboxes.push((id, token, pid));
    }
    let victim = victim.expect("a host");
    let victim_ip = address(&victim).await;
    // Two periods, so each has a checkpoint after its move.
    tokio::time::sleep(EVERY * 2 + Duration::from_secs(5)).await;
    fleet.kill(&victim);
    let killed = Instant::now();
    for (id, token, pid) in &sandboxes {
        let (alive, kept) = fleet.check(id, pid).await;
        let back = killed.elapsed();
        assert!(alive, "{id}'s beater did not come back");
        assert_eq!(kept, *token);
        let owner = fleet.owner(id).await.expect("a new owner");
        assert_ne!(owner, victim);
        let next = fleet
            .witness
            .beat_from(id, address(&owner).await, killed)
            .await;
        let beats = fleet.witness.beats(id);
        let last = from(&beats, victim_ip)
            .map(|beat| beat.n)
            .max()
            .expect("beats");
        assert!(
            next.n <= last + 1,
            "{id} counted on past what the host had: {last} -> {}",
            next.n
        );
        #[allow(clippy::cast_precision_loss)]
        let missed = Duration::from_secs_f64((last + 1 - next.n) as f64 / RATE);
        assert!(
            missed <= EVERY + Duration::from_secs(5),
            "{id} lost {missed:?} of work, more than a checkpoint period"
        );
        eprintln!(
            "{id}: back on {owner} {back:?} after the kill, {missed:?} of its work lost (count {last} -> {})",
            next.n
        );
    }
    for (id, ..) in &sandboxes {
        fleet.delete(id).await;
    }
}

/// Busy sandboxes created one after another, more than the starting hosts
/// have room for, all succeed: the service grows the instance group while
/// spare memory is still left. Each runs a beater, so it stays awake and
/// keeps its memory; idle ones would sleep and give theirs back.
#[tokio::test(flavor = "multi_thread")]
async fn the_group_grows_before_spare_capacity_runs_out() {
    let Some(fleet) = Fleet::from_env() else {
        return;
    };
    let Ok(scale) = std::env::var("COMPUTE_TEST_FLEET_SCALE") else {
        eprintln!("skipped: no COMPUTE_TEST_FLEET_SCALE");
        return;
    };
    let (shape, every) = scale.split_once('/').expect("VCPUSxMEMORY_MIB/SECONDS");
    let (vcpus, memory_mib) = shape.split_once('x').expect("VCPUSxMEMORY_MIB");
    let (vcpus, memory_mib): (u8, u32) = (vcpus.parse().unwrap(), memory_mib.parse().unwrap());
    let every = Duration::from_secs(every.parse().unwrap());
    let started_with = fleet.ready().await;
    let free = fleet.free_mib().await;
    let count = free / u64::from(memory_mib) + 2;
    eprintln!(
        "{} hosts with {free} MiB free; creating {count} sandboxes of {shape}",
        started_with.len()
    );
    let started = Instant::now();
    let mut created = Vec::new();
    let mut grew = None;
    let mut least = free;
    for made in 0..count {
        let id = fleet
            .create(vcpus, memory_mib, None)
            .await
            .unwrap_or_else(|failed| panic!("create {made} of {count} failed: {failed:?}"));
        fleet.start_beating(&id, &token()).await;
        created.push(id);
        let live = fleet.live().await;
        if grew.is_none() && live.len() > started_with.len() {
            grew = Some((started.elapsed(), made + 1));
        }
        if grew.is_none() {
            least = least.min(fleet.free_mib().await);
        }
        tokio::time::sleep(every).await;
    }
    let (after, made) = grew.expect("the group never grew");
    eprintln!(
        "a new host was live {after:?} in, after {made} creates, with {least} MiB still free at least; \
         all {count} creates succeeded on {} hosts",
        fleet.live().await.len()
    );
    for id in &created {
        fleet.delete(id).await;
    }
}
