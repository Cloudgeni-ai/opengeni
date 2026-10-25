//! Guests that stop while their VMs run on, as one that powers off does on
//! x86: the host finds them by the connections they no longer take, never
//! saves them, and boots their sandboxes from their disks; a guest that
//! takes none only for a while keeps its programs.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use compute_core::HostPolicy;
use compute_fleet::Guard;
use compute_host::fleet::{Freezes, GUARD_STEP, LeaseGate, boot_now};
use compute_host::protocol::{DurabilityName, HostStatus, Id, LevelName, Reply, SleepConfig};
use compute_host::{GuestChecks, HostConfig};
use tokio::time::{Instant, sleep};

use super::{Delays, Lab, NEVER, SAVE_IN_PLACE, World, id};

/// A lab whose guests listen on a notice port and are checked every
/// `every`, stopped after `misses` checks missed in a row.
async fn checked_lab(world: Arc<World>, every: Duration, misses: u32) -> Lab {
    leased_lab(Lab::root(), world, every, misses, None, None).await
}

/// [`checked_lab`] at `root` on a host that holds `lease`, if any, whose
/// guard keeps `freezes`, if any.
async fn leased_lab(
    root: PathBuf,
    world: Arc<World>,
    every: Duration,
    misses: u32,
    lease: Option<LeaseGate>,
    freezes: Option<Freezes>,
) -> Lab {
    Lab::start_configured(
        root,
        world,
        Delays::default(),
        HostPolicy::default(),
        |config: &mut HostConfig| {
            config.restore_notice_port = Some(53);
            config.guest_checks = GuestChecks { every, misses };
            config.lease = lease;
            config.guard_freezes = freezes;
        },
    )
    .await
}

/// [`checked_lab`] on a host that holds `lease`, with a guard whose count
/// of freezes the test keeps, as the guard does: even, the VMs running.
async fn guarded_lab(
    world: Arc<World>,
    every: Duration,
    misses: u32,
    lease: LeaseGate,
) -> (Lab, Guarded) {
    let root = Lab::root();
    let guarded = Guarded::start(Freezes::beside(&root.join("guard.lock")));
    let lab = leased_lab(
        root,
        world,
        every,
        misses,
        Some(lease),
        Some(guarded.freezes.clone()),
    )
    .await;
    (lab, guarded)
}

/// The test as the guard: what it does to the VMs' freezer, it says in its
/// count first when it freezes them and after when it thaws them, and it
/// says the count again at every step, as the guard does, unless it cannot
/// write it.
struct Guarded {
    freezes: Freezes,
    count: Arc<Mutex<u64>>,
    unwritable: Arc<AtomicBool>,
    steps: tokio::task::JoinHandle<()>,
}

impl Guarded {
    /// Which guard the test is.
    const GUARD: u64 = 7;

    fn start(freezes: Freezes) -> Self {
        freezes.say(Self::GUARD, 2).unwrap();
        let count = Arc::new(Mutex::new(2));
        let unwritable = Arc::new(AtomicBool::new(false));
        let steps = tokio::spawn({
            let (freezes, count, unwritable) =
                (freezes.clone(), Arc::clone(&count), Arc::clone(&unwritable));
            async move {
                loop {
                    sleep(GUARD_STEP).await;
                    let count = count.lock().unwrap();
                    if !unwritable.load(Ordering::Relaxed) {
                        freezes.say(Self::GUARD, *count).unwrap();
                    }
                }
            }
        });
        Self {
            freezes,
            count,
            unwritable,
            steps,
        }
    }

    /// Moves the count on and says it, if it can.
    fn step(&self) {
        let mut count = self.count.lock().unwrap();
        *count += 1;
        if !self.unwritable.load(Ordering::Relaxed) {
            self.freezes.say(Self::GUARD, *count).unwrap();
        }
    }

    fn freeze(&mut self, world: &World) {
        self.step();
        world.frozen.store(true, Ordering::Relaxed);
    }

    fn thaw(&mut self, world: &World) {
        world.frozen.store(false, Ordering::Relaxed);
        self.step();
    }

    /// Whether it can write its count.
    fn writable(&mut self, writable: bool) {
        self.unwritable.store(!writable, Ordering::Relaxed);
    }
}

impl Drop for Guarded {
    fn drop(&mut self) {
        self.steps.abort();
    }
}

/// A lease far from its deadline.
fn open_lease() -> LeaseGate {
    LeaseGate::new(boot_now() + Duration::from_secs(600))
}

/// Whether `sandbox`'s VM was ended with no memory image kept.
fn ended(status: &HostStatus, sandbox: Id) -> bool {
    let found = Lab::sandbox(status, sandbox);
    found.level == LevelName::Saved && !found.memory_saved && found.step.is_none()
}

fn snapshots(lab: &Lab) -> usize {
    lab.world
        .snapshots
        .iter()
        .map(|taken| taken.load(Ordering::Relaxed))
        .sum()
}

/// A guest that stops is never paused and saved, however soon its sandbox
/// would sleep: that would keep it stopped. Once it has missed enough
/// checks its VM is ended, and the next use boots the sandbox from its
/// disk, with its files.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_guest_that_stops_is_ended_and_its_sandbox_boots_from_its_disk() {
    let every = Duration::from_millis(100);
    let lab = checked_lab(Arc::default(), every, 3).await;
    let sandbox = id(1);
    lab.create(sandbox, SAVE_IN_PLACE).await;
    lab.run(sandbox, &["set kept", "write on-disk"]).await;
    lab.wait_until("the save to finish", |status| {
        let found = Lab::sandbox(status, sandbox);
        found.durability == DurabilityName::Local && found.step.is_none()
    })
    .await;
    let saved = snapshots(&lab);

    assert_eq!(lab.run(sandbox, &["halt"]).await, ["ok"]);
    let halted = Instant::now();
    // Its VM process is stopped after the sandbox is reported ended.
    lab.wait_until("the stopped guest's VM to be ended", |status| {
        ended(status, sandbox) && lab.world.live.lock().unwrap().is_empty()
    })
    .await;
    // Three checks a period apart.
    assert!(
        halted.elapsed() >= every,
        "ended after {:?}, before it missed its checks",
        halted.elapsed()
    );
    assert_eq!(snapshots(&lab), saved, "the stopped guest was saved");

    assert_eq!(lab.run(sandbox, &["get", "disk"]).await, ["", "on-disk"]);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 2);
    lab.assert_clean();
}

/// A sandbox saved with its guest stopped (on purpose here, as an older
/// host did, or one short of memory, which does not wait) brings the
/// stopped guest back on its next wake. It is found stopped then, and the
/// wake after boots it from its disk.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sandbox_saved_with_its_guest_stopped_boots_from_its_disk_after_its_next_wake() {
    // Checks far apart, so the save comes long before the first.
    let lab = checked_lab(Arc::default(), Duration::from_millis(400), 2).await;
    let sandbox = id(2);
    lab.create(sandbox, NEVER).await;
    lab.run(sandbox, &["set kept", "write on-disk", "halt"])
        .await;
    assert_eq!(lab.sleep_to(sandbox, LevelName::Saved).await, Reply::Done);
    lab.wait_until("the stopped guest to be saved", |status| {
        let found = Lab::sandbox(status, sandbox);
        found.level == LevelName::Saved && found.memory_saved && found.step.is_none()
    })
    .await;

    // Its memory image holds the stopped guest, which this wake restores.
    let woken = lab.wake(sandbox).await;
    assert!(matches!(woken, Reply::Woken { .. }), "{woken:?}");
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 1);
    lab.wait_until("the restored stopped guest's VM to be ended", |status| {
        ended(status, sandbox)
    })
    .await;

    assert_eq!(lab.run(sandbox, &["get", "disk"]).await, ["", "on-disk"]);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 2);
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 1);
    lab.assert_clean();
}

/// A guest that takes no connection for fewer checks than it may miss (as
/// one far behind on a busy host) keeps its programs. Its sandbox stays
/// awake meanwhile, and sleeps once its guest takes a connection again.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_guest_that_takes_no_connection_for_a_while_keeps_its_programs() {
    let lab = checked_lab(Arc::default(), Duration::from_millis(100), 6).await;
    let sandbox = id(3);
    let pause_quickly = SleepConfig {
        pause_after_ms: Some(100),
        ..NEVER
    };
    lab.create(sandbox, pause_quickly).await;
    lab.run(sandbox, &["set kept", "stall 350"]).await;
    sleep(Duration::from_millis(300)).await;
    let found = lab.current(sandbox).await;
    assert_eq!(
        found.level,
        LevelName::Running,
        "a sandbox whose guest takes no connection stays awake: {found:?}"
    );

    lab.wait_level(sandbox, LevelName::Paused).await;
    assert_eq!(lab.run(sandbox, &["get"]).await, ["kept"]);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1);
    lab.assert_clean();
}

/// A paused VM's guest takes no connection, as with a real VMM: it is not
/// checked, however long it stays paused.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_paused_guest_is_not_found_stopped() {
    let world = Arc::new(World::default());
    world.paused_take_nothing.store(true, Ordering::Relaxed);
    let lab = checked_lab(world, Duration::from_millis(50), 2).await;
    let sandbox = id(4);
    let pause_quickly = SleepConfig {
        pause_after_ms: Some(50),
        ..NEVER
    };
    lab.create(sandbox, pause_quickly).await;
    lab.run(sandbox, &["set kept"]).await;
    lab.wait_level(sandbox, LevelName::Paused).await;
    // Many times the checks it could miss.
    sleep(Duration::from_millis(600)).await;
    assert_eq!(lab.current(sandbox).await.level, LevelName::Paused);
    assert_eq!(lab.run(sandbox, &["get"]).await, ["kept"]);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1);
    lab.assert_clean();
}

/// A check its guest could not take all through, because its VM was
/// paused meanwhile, counts for nothing, even when the connection fails
/// only once the VM runs again, as with a VMM frozen with its guest. A
/// guest paused and woken again and again with checks under way keeps its
/// programs.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_check_across_a_pause_counts_for_nothing() {
    let world = Arc::new(World::default());
    world.pause_fails_handshakes.store(true, Ordering::Relaxed);
    let lab = checked_lab(Arc::clone(&world), Duration::from_millis(10), 2).await;
    let sandbox = id(5);
    lab.create(sandbox, NEVER).await;
    lab.run(sandbox, &["set kept"]).await;
    for _ in 0..6 {
        // A check is under way, slow to be taken, and fails a moment after
        // the VM runs again; the pause's and wake's own connections are
        // not slow. No other check begins before it ends.
        world.handshake_ms.store(150, Ordering::Relaxed);
        let deadline = Instant::now() + Duration::from_secs(5);
        while world.handshaking.load(Ordering::Relaxed) == 0 {
            assert!(Instant::now() < deadline, "no check began");
            sleep(Duration::from_millis(1)).await;
        }
        world.handshake_ms.store(0, Ordering::Relaxed);
        assert_eq!(lab.sleep_to(sandbox, LevelName::Paused).await, Reply::Done);
        lab.wait_level(sandbox, LevelName::Paused).await;
        let woken = lab.wake(sandbox).await;
        assert!(matches!(woken, Reply::Woken { .. }), "{woken:?}");
    }
    world.handshake_ms.store(0, Ordering::Relaxed);
    // The last failure arrives.
    sleep(Duration::from_millis(200)).await;
    assert_eq!(lab.current(sandbox).await.level, LevelName::Running);
    assert_eq!(lab.run(sandbox, &["get"]).await, ["kept"]);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1);
    lab.assert_clean();
}

/// A check the host cannot make, its VMM's socket out of reach, says
/// nothing about the guest: however many fail, it keeps its programs.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_check_the_host_cannot_make_counts_for_nothing() {
    let lab = checked_lab(Arc::default(), Duration::from_millis(20), 2).await;
    let sandbox = id(6);
    lab.create(sandbox, NEVER).await;
    lab.run(sandbox, &["set kept"]).await;
    let socket = lab.world.vsocks.lock().unwrap().last().unwrap().clone();
    let aside = socket.with_extension("aside");
    std::fs::rename(&socket, &aside).unwrap();
    // Many times the checks it could miss.
    sleep(Duration::from_millis(500)).await;
    assert_eq!(lab.current(sandbox).await.level, LevelName::Running);
    std::fs::rename(&aside, &socket).unwrap();
    assert_eq!(lab.run(sandbox, &["get"]).await, ["kept"]);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1);
    lab.assert_clean();
}

/// A guest slow to take connections, slower than it may take to answer
/// whether commands run, but not stopped, is not kept awake by it: it
/// takes them within the time a check gives it, so its sandbox sleeps once
/// idle.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_guest_slow_to_take_connections_still_sleeps() {
    let lab = checked_lab(Arc::default(), Duration::from_millis(100), 3).await;
    let sandbox = id(7);
    let pause_quickly = SleepConfig {
        pause_after_ms: Some(100),
        ..NEVER
    };
    lab.create(sandbox, pause_quickly).await;
    lab.run(sandbox, &["set kept"]).await;
    lab.world.handshake_ms.store(1_300, Ordering::Relaxed);
    lab.wait_level(sandbox, LevelName::Paused).await;
    lab.world.handshake_ms.store(0, Ordering::Relaxed);
    assert_eq!(lab.run(sandbox, &["get"]).await, ["kept"]);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1);
    lab.assert_clean();
}

/// A stopped guest of a sandbox due to sleep for being idle takes no
/// connection when asked whether commands still run, so it stays awake
/// and is asked again and again. The asks leave its guest running, so the
/// checks across them still count, and find it stopped.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stopped_guest_asked_again_and_again_whether_commands_run_is_found() {
    let lab = checked_lab(Arc::default(), Duration::from_millis(100), 3).await;
    let sandbox = id(8);
    let pause_quickly = SleepConfig {
        pause_after_ms: Some(30),
        ..NEVER
    };
    lab.create(sandbox, pause_quickly).await;
    lab.run(sandbox, &["write on-disk"]).await;
    assert_eq!(lab.run(sandbox, &["halt"]).await, ["ok"]);
    // Each connection it fails takes a while, so asks and checks overlap.
    lab.world.handshake_ms.store(200, Ordering::Relaxed);
    lab.wait_until("the stopped guest's VM to be ended", |status| {
        ended(status, sandbox)
    })
    .await;
    lab.world.handshake_ms.store(0, Ordering::Relaxed);
    assert_eq!(snapshots(&lab), 0, "the stopped guest was saved");
    assert_eq!(lab.run(sandbox, &["disk"]).await, ["on-disk"]);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 2);
    lab.assert_clean();
}

/// The guard freezes every VM a moment ([`Guard::LEAD`]) before the
/// lease's deadline, and thaws them at its next step once the lease is
/// renewed. On a host whose renewals come that late again and again, the
/// checks the freezes fail count for nothing, whether a check began
/// before a renewal or just after it: a guest that runs keeps its
/// programs.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn checks_the_guard_froze_count_for_nothing() {
    let world = Arc::new(World::default());
    let mut deadline = boot_now() + Duration::from_secs(2);
    let gate = LeaseGate::new(deadline);
    let (lab, mut guard) = guarded_lab(
        Arc::clone(&world),
        Duration::from_millis(20),
        2,
        gate.clone(),
    )
    .await;
    let sandbox = id(9);
    lab.create(sandbox, NEVER).await;
    lab.run(sandbox, &["set kept"]).await;
    for _ in 0..5 {
        // Into the guard's lead before the deadline: it freezes the VMs.
        let left = deadline.saturating_since(boot_now());
        sleep(left.saturating_sub(Guard::LEAD) + Duration::from_millis(50)).await;
        guard.freeze(&world);
        sleep(Duration::from_millis(500)).await;
        // Renewed late, again: the guard thaws them at its next step.
        deadline = boot_now() + Guard::LEAD + Duration::from_millis(300);
        gate.set(deadline);
        sleep(GUARD_STEP).await;
        guard.thaw(&world);
    }
    gate.set(boot_now() + Duration::from_secs(60));
    // The last checks end.
    sleep(Duration::from_millis(400)).await;
    assert_eq!(lab.current(sandbox).await.level, LevelName::Running);
    assert_eq!(lab.run(sandbox, &["get"]).await, ["kept"]);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1);
    lab.assert_clean();
}

/// The guard acts on its own steps, so its freeze can come at any moment
/// of a check, however late, with the lease still far from its deadline:
/// no deadline or wait tells, but its count does. Even on a host that
/// ends a VM at its first miss, checks a freeze cut short count for
/// nothing, and the guest keeps its programs.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_freeze_late_in_a_check_counts_for_nothing() {
    let world = Arc::new(World::default());
    let (lab, mut guard) = guarded_lab(
        Arc::clone(&world),
        Duration::from_millis(20),
        1,
        open_lease(),
    )
    .await;
    let sandbox = id(10);
    lab.create(sandbox, NEVER).await;
    lab.run(sandbox, &["set kept"]).await;
    for _ in 0..3 {
        // A check is under way, slow to be taken.
        world.handshake_ms.store(300, Ordering::Relaxed);
        let began = Instant::now() + Duration::from_secs(5);
        while world.handshaking.load(Ordering::Relaxed) == 0 {
            assert!(Instant::now() < began, "no check began");
            sleep(Duration::from_millis(1)).await;
        }
        // Well into it, the guard freezes the VMs, and the guest takes
        // the connection no further.
        sleep(Duration::from_millis(150)).await;
        guard.freeze(&world);
        sleep(Duration::from_millis(400)).await;
        world.handshake_ms.store(0, Ordering::Relaxed);
        guard.thaw(&world);
        sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(lab.current(sandbox).await.level, LevelName::Running);
    assert_eq!(lab.run(sandbox, &["get"]).await, ["kept"]);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1);
    lab.assert_clean();
}

/// While the host's sleep hook prepares a suspend, the guard keeps every
/// VM frozen for as long as that takes, with the lease far from its
/// deadline and the machine not yet suspended: every check meanwhile fails
/// in full, and neither clock tells why. The guard's count does, so none
/// counts, and the guest keeps its programs once the VMs thaw.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn checks_while_a_suspend_is_prepared_count_for_nothing() {
    let world = Arc::new(World::default());
    let (lab, mut guard) = guarded_lab(
        Arc::clone(&world),
        Duration::from_millis(20),
        5,
        open_lease(),
    )
    .await;
    let sandbox = id(11);
    lab.create(sandbox, NEVER).await;
    lab.run(sandbox, &["set kept"]).await;
    guard.freeze(&world);
    // Many times the checks it could miss, each slow to fail.
    world.handshake_ms.store(40, Ordering::Relaxed);
    sleep(Duration::from_millis(1_500)).await;
    world.handshake_ms.store(0, Ordering::Relaxed);
    guard.thaw(&world);
    sleep(Duration::from_millis(200)).await;
    assert_eq!(lab.current(sandbox).await.level, LevelName::Running);
    assert_eq!(lab.run(sandbox, &["get"]).await, ["kept"]);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1);
    lab.assert_clean();
}

/// On a host with a lease, a guest that stops while the guard leaves the
/// VMs running, its count even and steady, is found and ended as on a host
/// on its own; its sandbox boots from its disk.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stopped_guest_on_a_guarded_host_is_ended() {
    let world = Arc::new(World::default());
    let (lab, _guard) = guarded_lab(
        Arc::clone(&world),
        Duration::from_millis(20),
        3,
        open_lease(),
    )
    .await;
    let sandbox = id(12);
    lab.create(sandbox, NEVER).await;
    lab.run(sandbox, &["write on-disk"]).await;
    assert_eq!(lab.run(sandbox, &["halt"]).await, ["ok"]);
    lab.wait_until("the stopped guest's VM to be ended", |status| {
        ended(status, sandbox)
    })
    .await;
    assert_eq!(snapshots(&lab), 0, "the stopped guest was saved");
    assert_eq!(lab.run(sandbox, &["disk"]).await, ["on-disk"]);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 2);
    lab.assert_clean();
}

/// A guard older than the agent keeps no count of its freezes, so on a
/// host with a lease and no count, no check vouches for a miss: a guest
/// that takes no connection there is not ended, stopped or not, until the
/// host starts a guard that keeps one. Better that than a healthy guest
/// ended.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn without_the_guards_count_no_miss_counts() {
    let world = Arc::new(World::default());
    let lab = leased_lab(
        Lab::root(),
        Arc::clone(&world),
        Duration::from_millis(20),
        1,
        Some(open_lease()),
        None,
    )
    .await;
    let sandbox = id(13);
    lab.create(sandbox, NEVER).await;
    lab.run(sandbox, &["set kept"]).await;
    world.frozen.store(true, Ordering::Relaxed);
    // Many times the checks it could miss.
    sleep(Duration::from_millis(500)).await;
    world.frozen.store(false, Ordering::Relaxed);
    assert_eq!(lab.current(sandbox).await.level, LevelName::Running);
    assert_eq!(lab.run(sandbox, &["get"]).await, ["kept"]);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1);
    lab.assert_clean();
}

/// A guard that cannot write its count still freezes the VMs, and says
/// nothing: what it said before, an even count, vouches for nothing after.
/// So even on a host that ends a VM at its first miss, the checks it froze
/// count for nothing, and the guest keeps its programs. Once it can write
/// again, it says its count at its next step, and a guest that stops is
/// found as before.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_guard_that_cannot_write_its_count_vouches_for_no_miss() {
    let world = Arc::new(World::default());
    let (lab, mut guard) = guarded_lab(
        Arc::clone(&world),
        Duration::from_millis(20),
        1,
        open_lease(),
    )
    .await;
    let sandbox = id(14);
    lab.create(sandbox, NEVER).await;
    lab.run(sandbox, &["set kept"]).await;
    guard.writable(false);
    guard.freeze(&world);
    // Many times the checks it could miss, each slow to fail.
    world.handshake_ms.store(40, Ordering::Relaxed);
    sleep(Duration::from_millis(1_500)).await;
    world.handshake_ms.store(0, Ordering::Relaxed);
    guard.thaw(&world);
    sleep(Duration::from_millis(200)).await;
    assert_eq!(lab.current(sandbox).await.level, LevelName::Running);
    assert_eq!(lab.run(sandbox, &["get"]).await, ["kept"]);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1);

    guard.writable(true);
    assert_eq!(lab.run(sandbox, &["halt"]).await, ["ok"]);
    lab.wait_until("the stopped guest's VM to be ended", |status| {
        ended(status, sandbox)
    })
    .await;
    assert_eq!(lab.run(sandbox, &["get"]).await, [""]);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 2);
    lab.assert_clean();
}
