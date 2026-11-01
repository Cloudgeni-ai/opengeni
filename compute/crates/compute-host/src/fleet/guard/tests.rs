use super::*;

#[test]
fn one_guard_at_a_time_and_the_agent_sees_it() {
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join("guard.lock");
    assert_eq!(ready_lock(&lock), dir.path().join("guard.lock.ready"));
    assert!(!held(&lock).unwrap(), "no lock file, no guard");
    let one = hold_lock(&lock).unwrap();
    assert!(held(&lock).unwrap());
    assert!(hold_lock(&lock).is_err(), "a second guard refuses");
    assert!(!guard_ready(&lock).unwrap(), "running is not yet guarding");
    drop(one);
    // A process another test starts at that moment holds a copy of the
    // lock's descriptor until it runs its program, so it may take that
    // long.
    let until = Instant::now() + Duration::from_secs(2);
    while held(&lock).unwrap() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!held(&lock).unwrap());
}

/// The count is odd exactly while the VMs may not run, moves only when
/// that changes, is said again at every step, and vouches for nothing
/// once damaged.
#[test]
fn the_freeze_count_is_odd_while_the_vms_may_not_run() {
    let dir = tempfile::tempdir().unwrap();
    let freezes = Freezes::beside(&dir.path().join("guard.lock"));
    assert_eq!(freezes.path, dir.path().join("guard.lock.freezes"));
    assert_eq!(freezes.read(), None, "no count, nothing vouched for");
    let mut saying = Saying::new(freezes.clone());
    let count = |freezes: &Freezes| freezes.read().map(|said| said.count);
    saying.say(true);
    assert_eq!(count(&freezes), Some(1), "a guard starts odd");
    saying.say(false);
    assert_eq!(count(&freezes), Some(2));
    let said = freezes.read().unwrap();
    assert_eq!(said.guard, saying.guard);
    std::thread::sleep(Duration::from_millis(2));
    saying.say(false);
    let again = freezes.read().unwrap();
    assert_eq!(again.count, 2, "already even");
    assert!(again.at > said.at, "said again, later");
    saying.say(true);
    assert_eq!(count(&freezes), Some(3));
    saying.say(true);
    assert_eq!(count(&freezes), Some(3), "still frozen");
    saying.say(false);
    assert_eq!(count(&freezes), Some(4));
    std::fs::write(&freezes.path, "1 4x 9").unwrap();
    assert_eq!(freezes.read(), None);
    std::fs::write(&freezes.path, "4\n").unwrap();
    assert_eq!(freezes.read(), None, "a count without its guard and time");
    std::fs::write(&freezes.path, "1 4 9 9").unwrap();
    assert_eq!(freezes.read(), None);
}

/// A guard whose count cannot be written still freezes the VMs, and
/// says nothing: what it said before stays, with the time it said it,
/// so it vouches for nothing after the freeze. Its first step that can
/// write says the count again, moved on past the freeze, without
/// waiting for the freezer to change.
#[test]
fn a_count_the_guard_cannot_write_is_not_said() {
    let dir = tempfile::tempdir().unwrap();
    let group = dir.path().join("vms");
    std::fs::create_dir(&group).unwrap();
    std::fs::write(group.join("cgroup.freeze"), "0").unwrap();
    std::fs::write(group.join("cgroup.events"), "populated 1\nfrozen 0\n").unwrap();
    let mut config = config(dir.path(), None);
    config.cgroup = group.clone();
    LeaseFile {
        host: Some(1),
        epoch: Some(1),
        deadline_ns: nanos(boot_now() + Duration::from_secs(600)),
        seq: 1,
    }
    .write(&config.lease_file)
    .unwrap();
    let (guard, cgroup) = (Guard::new(), Cgroup::at(&group));
    let freezes = Freezes::beside(&config.lock);
    let mut saying = Saying::new(freezes.clone());
    let mut fencing = Fencing::new(freezes.fenced());
    let mut last = Acted::default();
    let mut step = |saying: &mut Saying| {
        assert!(
            step_once(
                &guard,
                &cgroup,
                &config,
                &mut last,
                saying,
                &mut fencing,
                false,
            )
            .feed
        );
    };
    step(&mut saying);
    let running = freezes.read().unwrap();
    assert_eq!(running.count, 2, "running");

    // Nothing can be written there now, and a suspend is prepared.
    let staging = freezes.path.with_extension("freezes.staging");
    std::fs::create_dir(&staging).unwrap();
    std::fs::write(&config.suspending, "").unwrap();
    step(&mut saying);
    let frozen = |group: &Path| std::fs::read_to_string(group.join("cgroup.freeze")).unwrap();
    assert_eq!(frozen(&group), "1", "it froze them all the same");
    assert_eq!(freezes.read(), Some(running), "and said nothing");
    for _ in 0..3 {
        step(&mut saying);
    }
    assert_eq!(freezes.read(), Some(running), "nor at its next steps");

    // It can write again: its next step says the count, moved on.
    std::fs::remove_dir(&staging).unwrap();
    step(&mut saying);
    let said = freezes.read().unwrap();
    assert_eq!((said.guard, said.count), (running.guard, 3));
    assert!(said.at > running.at);

    // The suspend is over: it thaws them and says so.
    std::fs::remove_file(&config.suspending).unwrap();
    step(&mut saying);
    assert_eq!(frozen(&group), "0");
    assert_eq!(freezes.read().unwrap().count, 4);
}

fn config(dir: &Path, watchdog: Option<(PathBuf, Duration)>) -> GuardConfig {
    GuardConfig {
        cgroup: dir.join("no-cgroup"),
        lease_file: dir.join("lease.json"),
        lock: dir.join("guard.lock"),
        suspending: dir.join("suspending"),
        fence: watchdog.map_or(Fence::None, |(device, timeout)| Fence::Machine {
            device,
            timeout,
        }),
    }
}

/// Past the deadline the guard kills only the VMs that still run. One
/// that is ending while frozen (deleted, or its process killed) reads
/// as not frozen until its memory is released, and so makes the whole
/// cgroup read so: the frozen ones stay frozen all the same, to run on
/// if the lease is renewed.
#[test]
fn past_the_deadline_only_the_vms_still_running_are_killed() {
    let dir = tempfile::tempdir().unwrap();
    let group = dir.path().join("vms");
    let mut config = config(dir.path(), None);
    config.cgroup = group.clone();
    LeaseFile {
        host: Some(1),
        epoch: Some(1),
        deadline_ns: 1,
        seq: 1,
    }
    .write(&config.lease_file)
    .unwrap();
    let set = |path: &Path, freeze: &str, events: &str| {
        std::fs::create_dir_all(path).unwrap();
        std::fs::write(path.join("cgroup.freeze"), freeze).unwrap();
        std::fs::write(path.join("cgroup.events"), events).unwrap();
        std::fs::write(path.join("cgroup.procs"), "").unwrap();
    };
    set(&group, "1", "populated 1\nfrozen 0\n");
    set(&group.join("ending"), "0", "populated 1\nfrozen 0\n");
    set(&group.join("frozen"), "0", "populated 1\nfrozen 1\n");
    set(&group.join("gone"), "0", "populated 0\nfrozen 1\n");
    let killed = |path: &Path| path.join("cgroup.kill").exists();
    let (guard, cgroup) = (Guard::new(), Cgroup::at(&group));
    let freezes = Freezes::beside(&config.lock);
    let fenced = freezes.fenced();
    let mut fencing = Fencing::new(fenced.clone());
    let mut saying = Saying::new(freezes);
    let mut last = Acted::default();
    let before = boot_now();
    let feed = step_once(
        &guard,
        &cgroup,
        &config,
        &mut last,
        &mut saying,
        &mut fencing,
        false,
    )
    .feed;
    assert_eq!(last.vms, Some(GuardAction::Kill));
    assert!(!feed, "not every VM is known to be stopped yet");
    assert!(killed(&group.join("ending")), "the one still running");
    assert!(!killed(&group.join("frozen")), "a frozen VM stays frozen");
    assert!(!killed(&group.join("gone")));
    assert!(!killed(&group));
    // The one killed is recorded, once however many steps its kill
    // takes, so the agent says the guard ended it.
    assert!(fenced.ended("ending", before));
    assert!(!fenced.ended("frozen", before));
    assert!(!fenced.ended("ending", boot_now() + Duration::from_secs(1)));
    assert!(
        !step_once(
            &guard,
            &cgroup,
            &config,
            &mut last,
            &mut saying,
            &mut fencing,
            false,
        )
        .feed
    );
    assert_eq!(fenced.read().len(), 1, "{:?}", fenced.read());

    // A process in the VMs' cgroup itself: everything goes.
    std::fs::write(group.join("cgroup.procs"), "4242\n").unwrap();
    assert!(
        !step_once(
            &guard,
            &cgroup,
            &config,
            &mut last,
            &mut saying,
            &mut fencing,
            false,
        )
        .feed
    );
    assert!(killed(&group));
    assert!(fenced.ended("frozen", before), "every VM went");
}

/// A stand-in for the VMs' cgroup, `vms`, with a group of its own for each
/// VM, none holding a process itself.
struct Groups {
    vms: PathBuf,
}

impl Groups {
    fn new(dir: &Path) -> Self {
        let groups = Self {
            vms: dir.join("vms"),
        };
        set_group(&groups.vms, "0", true, false);
        groups
    }

    /// A running VM's group, marked its sandbox's only copy if `only`;
    /// `None` if the test's file system keeps no user extended attributes.
    fn vm(&self, name: &str, only: bool) -> Option<PathBuf> {
        let path = self.vms.join(name);
        set_group(&path, "0", true, false);
        if only && Cgroup::at(&path).set_only_copy(true).is_err() {
            eprintln!(
                "skipped: the test directory's file system keeps no user extended attributes"
            );
            return None;
        }
        Some(path)
    }

    /// What the kernel would report once the freezes asked for took: each
    /// group frozen that asks for a freeze, or whose cgroup above does.
    fn settle(&self) {
        let asked =
            |path: &Path| std::fs::read_to_string(path.join("cgroup.freeze")).unwrap() == "1";
        let above = asked(&self.vms);
        let mut all = true;
        for entry in std::fs::read_dir(&self.vms).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                let frozen = above || asked(&path);
                all &= frozen;
                let freeze = std::fs::read_to_string(path.join("cgroup.freeze")).unwrap();
                set_group(&path, &freeze, true, frozen);
            }
        }
        let freeze = std::fs::read_to_string(self.vms.join("cgroup.freeze")).unwrap();
        set_group(&self.vms, &freeze, true, all);
    }
}

/// Makes `path` a group whose freeze reads `freeze`, as populated and
/// frozen as said.
fn set_group(path: &Path, freeze: &str, populated: bool, frozen: bool) {
    std::fs::create_dir_all(path).unwrap();
    std::fs::write(path.join("cgroup.freeze"), freeze).unwrap();
    std::fs::write(
        path.join("cgroup.events"),
        format!(
            "populated {}\nfrozen {}\n",
            u8::from(populated),
            u8::from(frozen)
        ),
    )
    .unwrap();
    std::fs::write(path.join("cgroup.procs"), "").unwrap();
}

fn freeze_of(path: &Path) -> String {
    std::fs::read_to_string(path.join("cgroup.freeze")).unwrap()
}

/// With its lease run out, the guard freezes each VM on its own and
/// leaves running the one marked its sandbox's only copy, kills a fenced
/// one that has not frozen by the deadline and never the only copy, and
/// thaws them once the lease is renewed. The count says the VMs are
/// stopped while any fenced one is.
#[test]
fn the_guard_leaves_a_vm_that_is_its_sandboxes_only_copy_running() {
    let dir = tempfile::tempdir().unwrap();
    let groups = Groups::new(dir.path());
    let (fenced_vm, Some(only)) = (groups.vm("fenced", false).unwrap(), groups.vm("only", true))
    else {
        return;
    };
    let mut config = config(dir.path(), None);
    config.cgroup = groups.vms.clone();
    let lease = |deadline: At| {
        LeaseFile {
            host: Some(1),
            epoch: Some(1),
            deadline_ns: nanos(deadline),
            seq: 1,
        }
        .write(&config.lease_file)
        .unwrap();
    };
    // Inside the lead: the fenced VM freezes, the only copy runs on.
    lease(boot_now() + Duration::from_secs(2));
    let (guard, cgroup) = (Guard::new(), Cgroup::at(&groups.vms));
    let freezes = Freezes::beside(&config.lock);
    let fenced = freezes.fenced();
    let mut fencing = Fencing::new(fenced.clone());
    let mut saying = Saying::new(freezes.clone());
    let mut last = Acted::default();
    let mut step = |config: &GuardConfig| {
        step_once(
            &guard,
            &cgroup,
            config,
            &mut last,
            &mut saying,
            &mut fencing,
            false,
        )
    };
    let stepped = step(&config);
    assert!(stepped.feed, "the deadline is ahead");
    assert_eq!(freeze_of(&fenced_vm), "1");
    assert_eq!(freeze_of(&only), "0");
    assert_eq!(freeze_of(&groups.vms), "0", "the cgroup above stays thawed");
    assert_eq!(freezes.read().unwrap().count % 2, 1, "odd: a VM is stopped");
    groups.settle();
    // Past the deadline: with the fenced VM frozen, it feeds the watchdog
    // and kills nothing.
    lease(At::from_millis(1));
    assert!(step(&config).feed);
    assert!(!fenced_vm.join("cgroup.kill").exists());
    assert!(!only.join("cgroup.kill").exists());
    // A fenced VM that has not frozen by then is killed, and recorded.
    let late = groups.vm("late", false).unwrap();
    let before = boot_now();
    assert!(!step(&config).feed, "a fenced VM still runs");
    assert_eq!(
        std::fs::read_to_string(late.join("cgroup.kill")).unwrap(),
        "1"
    );
    assert!(fenced.ended("late", before));
    assert!(!fenced.ended("only", before));
    assert!(!only.join("cgroup.kill").exists(), "never the only copy");
    set_group(&late, "0", false, false);
    assert!(step(&config).feed, "every fenced VM is frozen or gone");
    std::fs::remove_dir_all(&late).unwrap();
    // One whose mark an agent that has ended set is frozen, not killed.
    let orphan = groups.vm("orphan", false).unwrap();
    rustix::fs::setxattr(
        &orphan,
        compute_engine::cgroup::ONLY_COPY,
        format!("{} 1", std::process::id()).as_bytes(),
        rustix::fs::XattrFlags::empty(),
    )
    .unwrap();
    assert!(!step(&config).feed, "it runs, and nothing vouches for it");
    assert_eq!(freeze_of(&orphan), "1");
    assert!(!orphan.join("cgroup.kill").exists());
    groups.settle();
    assert!(step(&config).feed);
    // Renewed: the fenced VM is thawed, and the count says they run.
    lease(boot_now() + Duration::from_secs(600));
    let stepped = step(&config);
    assert!(stepped.feed);
    assert!(!stepped.may_stop, "not before the thaw shows");
    assert_eq!(freeze_of(&fenced_vm), "0");
    assert_eq!(freeze_of(&orphan), "0");
    assert_eq!(freezes.read().unwrap().count % 2, 0, "even: they run");
    groups.settle();
    assert!(step(&config).may_stop);
}

/// After an earlier guard froze the whole cgroup, the guard has each
/// fenced VM ask for its own freeze and thaws the cgroup, so the only
/// copy runs again and the fenced ones never do. Asked to stop while the
/// lease runs out, it hands them over frozen as a whole, its own freezes
/// thawed, as a guard of an earlier release expects them.
#[test]
fn the_guard_takes_over_and_hands_over_vms_frozen_as_a_whole() {
    let dir = tempfile::tempdir().unwrap();
    let groups = Groups::new(dir.path());
    let (fenced_vm, Some(only)) = (groups.vm("fenced", false).unwrap(), groups.vm("only", true))
    else {
        return;
    };
    std::fs::write(groups.vms.join("cgroup.freeze"), "1").unwrap();
    groups.settle();
    let mut config = config(dir.path(), None);
    config.cgroup = groups.vms.clone();
    // No lease file: the lease has run out.
    let (guard, cgroup) = (Guard::new(), Cgroup::at(&groups.vms));
    let freezes = Freezes::beside(&config.lock);
    let mut fencing = Fencing::new(freezes.fenced());
    let mut saying = Saying::new(freezes);
    let mut last = Acted::default();
    let mut step = |stopping: bool| {
        step_once(
            &guard,
            &cgroup,
            &config,
            &mut last,
            &mut saying,
            &mut fencing,
            stopping,
        )
    };
    let stepped = step(false);
    assert_eq!(
        freeze_of(&fenced_vm),
        "1",
        "its own freeze, before the thaw"
    );
    assert_eq!(freeze_of(&groups.vms), "0");
    assert_eq!(freeze_of(&only), "0");
    assert!(stepped.feed);
    groups.settle();
    assert!(!fenced_vm.join("cgroup.kill").exists());
    // Asked to stop: the whole cgroup freezes first.
    let stepped = step(true);
    assert_eq!(freeze_of(&groups.vms), "1");
    assert!(!stepped.may_stop, "the only copy may still run");
    groups.settle();
    // Then its own freezes go, and it may stop.
    assert!(!step(true).may_stop);
    assert_eq!(freeze_of(&fenced_vm), "0");
    groups.settle();
    let stepped = step(true);
    assert!(stepped.may_stop && stepped.feed);
    assert_eq!(freeze_of(&groups.vms), "1", "frozen as a whole");
}

#[test]
fn the_record_of_vms_ended_keeps_the_latest() {
    let dir = tempfile::tempdir().unwrap();
    let fenced = Freezes::beside(&dir.path().join("guard.lock")).fenced();
    assert!(fenced.read().is_empty(), "none before the first");
    let names: Vec<String> = (0..Fenced::KEPT + 5).map(|n| format!("vm{n}")).collect();
    fenced.record(&names).unwrap();
    let kept = fenced.read();
    assert_eq!(kept.len(), Fenced::KEPT);
    assert_eq!(kept[0].0, "vm5", "the oldest went first");
    assert!(fenced.ended(&format!("vm{}", Fenced::KEPT + 4), At::ZERO));
    assert!(!fenced.ended("vm0", At::ZERO));
}

/// A guard whose watchdog cannot be armed exits without ever looking
/// ready, while one that guards does.
#[test]
fn a_guard_is_ready_only_once_its_watchdog_is_armed() {
    let dir = tempfile::tempdir().unwrap();
    let broken = config(
        dir.path(),
        Some((dir.path().join("no-watchdog"), Duration::from_secs(3))),
    );
    let watcher = {
        let lock = broken.lock.clone();
        std::thread::spawn(move || {
            let started = std::time::Instant::now();
            while started.elapsed() < Duration::from_millis(300) {
                assert!(!guard_ready(&lock).unwrap(), "ready before armed");
            }
        })
    };
    assert!(run_guard(&broken, &AtomicBool::new(false)).is_err());
    watcher.join().unwrap();
    assert!(!guard_ready(&broken.lock).unwrap());
    assert!(!held(&broken.lock).unwrap(), "its lock went with it");

    let mut working = config(dir.path(), None);
    // A freezer it cannot read: a file where the group should be.
    working.cgroup = dir.path().join("not-a-group");
    std::fs::write(&working.cgroup, "").unwrap();
    let lock = working.lock.clone();
    // An earlier guard's count: this one says its own, odd, and stays
    // odd while it cannot read the freezer, saying so at every step.
    Freezes::beside(&lock).say(1, 6).unwrap();
    let earlier = Freezes::beside(&lock).read().unwrap();
    std::thread::spawn(move || run_guard(&working, &AtomicBool::new(false)));
    let started = std::time::Instant::now();
    while !guard_ready(&lock).unwrap() {
        assert!(started.elapsed() < Duration::from_secs(5), "never ready");
        std::thread::sleep(Duration::from_millis(10));
    }
    let first = Freezes::beside(&lock).read().unwrap();
    assert_ne!(first.guard, earlier.guard);
    assert_eq!(first.count, 1);
    std::thread::sleep(STEP * 3);
    let later = Freezes::beside(&lock).read().unwrap();
    assert_eq!((later.guard, later.count), (first.guard, 1));
    assert!(later.at > first.at, "said again at its steps");
}

/// A look at whether a guard is ready (the agent's, as it starts with
/// the guard after an upgrade) holds the ready lock for a moment. A
/// guard taking the lock just then runs on and takes it a step later,
/// rather than ending, which the watchdog would answer with a reset.
#[test]
fn a_look_at_whether_the_guard_is_ready_does_not_end_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut working = config(dir.path(), None);
    working.cgroup = dir.path().join("not-a-group");
    std::fs::write(&working.cgroup, "").unwrap();
    let lock = working.lock.clone();
    std::fs::create_dir_all(lock.parent().unwrap()).unwrap();
    // One look, held for longer than a moment.
    let watcher = File::create(ready_lock(&lock)).unwrap();
    flock(&watcher, FlockOperation::NonBlockingLockShared).unwrap();
    let guard = std::thread::spawn(move || run_guard(&working, &AtomicBool::new(false)));
    std::thread::sleep(STEP * 3);
    assert!(!guard.is_finished(), "the guard runs on");
    assert!(!guard_ready(&lock).unwrap(), "not ready while looked at");
    drop(watcher);
    let started = std::time::Instant::now();
    while !guard_ready(&lock).unwrap() {
        assert!(started.elapsed() < Duration::from_secs(5), "never ready");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!guard.is_finished());
}

/// Asked to stop with its lease run out and the VMs still running, a
/// guard goes on killing them and stops only once they are gone, at a
/// step that may feed the watchdog, as closing it does. With a lease
/// that is valid it stops at its first step.
#[test]
fn a_guard_asked_to_stop_stops_only_at_a_step_that_may_feed_the_watchdog() {
    let dir = tempfile::tempdir().unwrap();
    let group = dir.path().join("vms");
    // One VM, running, in a group of its own inside the VMs' cgroup,
    // which holds no process itself: the guard kills that VM.
    let vm = group.join("vm");
    for path in [&group, &vm] {
        std::fs::create_dir_all(path).unwrap();
        std::fs::write(path.join("cgroup.freeze"), "0").unwrap();
        std::fs::write(path.join("cgroup.events"), "populated 1\nfrozen 0\n").unwrap();
        std::fs::write(path.join("cgroup.procs"), "").unwrap();
    }
    let events = group.join("cgroup.events");
    let mut lapsed = config(dir.path(), None);
    lapsed.cgroup = group.clone();
    // No lease file: the lease has run out.
    let valid = lapsed.clone();
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let guard = {
        let stop = std::sync::Arc::clone(&stop);
        std::thread::spawn(move || run_guard(&lapsed, &stop))
    };
    let started = std::time::Instant::now();
    while !guard_ready(&valid.lock).unwrap() {
        assert!(started.elapsed() < Duration::from_secs(5), "never ready");
        std::thread::sleep(Duration::from_millis(10));
    }
    stop.store(true, Ordering::Relaxed);
    // It goes on killing them: a kill written after it was asked to
    // stop, however slowly the steps come on a busy machine.
    let kill = vm.join("cgroup.kill");
    let _ = std::fs::remove_file(&kill);
    let started = std::time::Instant::now();
    while std::fs::read_to_string(&kill).ok().as_deref() != Some("1") {
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "it stopped killing them"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    std::thread::sleep(STEP * 3);
    assert!(!guard.is_finished(), "it stopped with the VMs running");
    // They are gone: it may feed the watchdog, and stops.
    std::fs::write(vm.join("cgroup.events"), "populated 0\nfrozen 0\n").unwrap();
    std::fs::write(&events, "populated 0\nfrozen 0\n").unwrap();
    let started = std::time::Instant::now();
    while !guard.is_finished() {
        assert!(started.elapsed() < Duration::from_secs(5), "never stopped");
        std::thread::sleep(Duration::from_millis(10));
    }
    guard.join().unwrap().unwrap();
    assert!(!held(&valid.lock).unwrap(), "its lock went with it");

    std::fs::write(&events, "populated 1\nfrozen 0\n").unwrap();
    LeaseFile {
        host: Some(1),
        epoch: Some(1),
        deadline_ns: nanos(boot_now() + Duration::from_secs(600)),
        seq: 1,
    }
    .write(&valid.lease_file)
    .unwrap();
    let started = std::time::Instant::now();
    run_guard(&valid, &AtomicBool::new(true)).unwrap();
    assert!(
        started.elapsed() < STEP * 5,
        "a valid lease, it stops at once"
    );
}

/// A stand-in for systemd's notification socket, as systemd 255
/// deals with it: it keeps a descriptor it is asked to keep if it
/// `keeps`; one it refuses it holds on, `closing` long, and closes
/// later, from another thread, after it went on to the messages after
/// it; a barrier's it closes as it deals with it.
struct Systemd {
    socket: PathBuf,
    /// What it keeps in the store.
    store: Arc<std::sync::Mutex<Vec<std::os::fd::OwnedFd>>>,
    /// What it refused and has yet to close.
    closing: Arc<std::sync::Mutex<Vec<std::os::fd::OwnedFd>>>,
    /// How many times it was asked to keep a descriptor.
    asked: Arc<std::sync::atomic::AtomicUsize>,
    done: Arc<AtomicBool>,
}

impl Systemd {
    fn start(socket: PathBuf, keeps: bool, closing: Duration) -> Self {
        use std::io::IoSliceMut;
        use std::mem::MaybeUninit;

        use rustix::net::{RecvAncillaryBuffer, RecvAncillaryMessage, RecvFlags, recvmsg};

        let notifications = std::os::unix::net::UnixDatagram::bind(&socket).unwrap();
        notifications
            .set_read_timeout(Some(Duration::from_millis(20)))
            .unwrap();
        let systemd = Self {
            socket,
            store: Arc::default(),
            closing: Arc::default(),
            asked: Arc::default(),
            done: Arc::default(),
        };
        let (store, refused, asked, done) = (
            Arc::clone(&systemd.store),
            Arc::clone(&systemd.closing),
            Arc::clone(&systemd.asked),
            Arc::clone(&systemd.done),
        );
        std::thread::spawn(move || {
            while !done.load(Ordering::Relaxed) {
                let mut text = [0_u8; 256];
                let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(1))];
                let mut control = RecvAncillaryBuffer::new(&mut space);
                let Ok(received) = recvmsg(
                    &notifications,
                    &mut [IoSliceMut::new(&mut text)],
                    &mut control,
                    RecvFlags::empty(),
                ) else {
                    continue;
                };
                let fds: Vec<std::os::fd::OwnedFd> = control
                    .drain()
                    .filter_map(|message| match message {
                        RecvAncillaryMessage::ScmRights(fds) => Some(fds),
                        _ => None,
                    })
                    .flatten()
                    .collect();
                if !text[..received.bytes].starts_with(b"FDSTORE=1\n") {
                    drop(fds);
                    continue;
                }
                asked.fetch_add(1, Ordering::Relaxed);
                if keeps {
                    store.lock().unwrap().extend(fds);
                    continue;
                }
                let count = fds.len();
                refused.lock().unwrap().extend(fds);
                let refused = Arc::clone(&refused);
                std::thread::spawn(move || {
                    std::thread::sleep(closing);
                    let mut held = refused.lock().unwrap();
                    let closed = count.min(held.len());
                    held.drain(..closed);
                });
            }
        });
        systemd
    }

    fn socket(&self) -> Option<&str> {
        self.socket.to_str()
    }

    /// How the guard lists the store: what it keeps, not what it holds.
    fn list(&self) -> ListStore {
        let store = Arc::clone(&self.store);
        Arc::new(move |identity| {
            Ok(store
                .lock()
                .unwrap()
                .iter()
                .any(|kept| kept::Identity::of(kept.as_fd()).unwrap() == identity))
        })
    }

    /// Whether it holds a file it refused, `fd`'s, yet to close it.
    fn closing(&self, fd: BorrowedFd<'_>) -> bool {
        let identity = kept::Identity::of(fd).unwrap();
        self.closing
            .lock()
            .unwrap()
            .iter()
            .any(|held| kept::Identity::of(held.as_fd()).unwrap() == identity)
    }
}

impl Drop for Systemd {
    fn drop(&mut self) {
        self.done.store(true, Ordering::Relaxed);
    }
}

/// Steps `keeping` every 20 ms for `within`, or until it sees the
/// watchdog `device` kept; with `each` called on every step.
fn keep_for(
    keeping: &mut Keeping,
    device: &File,
    socket: Option<&str>,
    within: Duration,
    mut each: impl FnMut(),
) -> bool {
    let until = Instant::now() + within;
    while Instant::now() < until {
        if keeping.kept(device.as_fd(), socket) {
            return true;
        }
        each();
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

/// A guard is ready only once systemd lists the watchdog in the
/// service's store: not when systemd refuses it, though it still holds
/// it after it dealt with the request, nor outside systemd, nor while
/// it cannot list the store.
#[test]
fn a_guard_is_ready_only_once_systemd_lists_its_watchdog_in_the_store() {
    let dir = tempfile::tempdir().unwrap();
    let device = File::create(dir.path().join("device")).unwrap();

    // systemd refuses it, and closes it only well after it went on.
    let systemd = Systemd::start(
        dir.path().join("refusing"),
        false,
        Duration::from_millis(900),
    );
    let mut keeping = Keeping::new(false, systemd.list());
    let mut seen_closing = false;
    let kept = keep_for(
        &mut keeping,
        &device,
        systemd.socket(),
        Duration::from_millis(1600),
        || seen_closing |= systemd.closing(device.as_fd()),
    );
    assert!(!kept, "systemd does not keep it");
    assert!(seen_closing, "systemd held it after it refused it");
    assert!(keeping.told);
    assert!(systemd.asked.load(Ordering::Relaxed) >= 2, "asked again");

    // systemd keeps it.
    let systemd = Systemd::start(dir.path().join("keeping"), true, Duration::ZERO);
    let mut keeping = Keeping::new(false, systemd.list());
    let socket = systemd.socket();
    assert!(keep_for(
        &mut keeping,
        &device,
        socket,
        Duration::from_secs(2),
        || {}
    ));
    assert!(!keeping.told);

    // Taken over from the store, it is kept there already: the guard
    // sends the barrier alone, not a second copy systemd would refuse.
    let systemd = Systemd::start(dir.path().join("taken-over"), true, Duration::ZERO);
    systemd
        .store
        .lock()
        .unwrap()
        .push(device.try_clone().unwrap().into());
    let mut keeping = Keeping::new(true, systemd.list());
    let socket = systemd.socket();
    assert!(keep_for(
        &mut keeping,
        &device,
        socket,
        Duration::from_secs(2),
        || {}
    ));
    assert_eq!(systemd.asked.load(Ordering::Relaxed), 0, "not asked again");
    assert_eq!(systemd.store.lock().unwrap().len(), 1);

    // The store cannot be listed: it is listed again, and systemd not
    // asked again to keep what it may keep already.
    let systemd = Systemd::start(dir.path().join("unlisted"), true, Duration::ZERO);
    let listed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counting = Arc::clone(&listed);
    let mut keeping = Keeping::new(
        false,
        Arc::new(move |_| {
            counting.fetch_add(1, Ordering::Relaxed);
            Err(io::Error::other("no systemd-analyze"))
        }),
    );
    let socket = systemd.socket();
    assert!(!keep_for(
        &mut keeping,
        &device,
        socket,
        Duration::from_millis(2500),
        || {}
    ));
    assert!(keeping.told);
    assert_eq!(systemd.asked.load(Ordering::Relaxed), 1, "asked once");
    assert!(listed.load(Ordering::Relaxed) >= 2, "listed again");

    // Not run by systemd.
    let mut keeping = Keeping::new(false, Arc::new(|_| Ok(true)));
    assert!(!keeping.kept(device.as_fd(), None));
    assert!(keeping.told);
}

/// systemd slow to take its messages, as on a host short of memory:
/// the guard's step, which feeds the watchdog, never waits for it, and
/// the guard is ready once systemd takes them again.
#[test]
fn a_guard_whose_systemd_is_slow_steps_on_time_and_asks_again() {
    let dir = tempfile::tempdir().unwrap();
    let device = File::create(dir.path().join("device")).unwrap();
    let path = dir.path().join("notify");
    let slow = std::os::unix::net::UnixDatagram::bind(&path).unwrap();
    let queued = kept::fill_queue(&path);
    let mut keeping = Keeping::new(false, Arc::new(|_| Ok(false)));
    let mut slowest = Duration::ZERO;
    // Long enough to ask a few times.
    let until = Instant::now() + KEEP_AGAIN * 2 + STEP;
    while Instant::now() < until {
        let started = Instant::now();
        assert!(!keeping.kept(device.as_fd(), path.to_str()));
        slowest = slowest.max(started.elapsed());
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(keeping.told, "said why it is not ready");
    assert!(slowest < STEP, "a step waited {slowest:?} on systemd");

    // systemd takes its messages again.
    drop((slow, queued));
    std::fs::remove_file(&path).unwrap();
    let systemd = Systemd::start(path.clone(), true, Duration::ZERO);
    keeping.list = systemd.list();
    assert!(keep_for(
        &mut keeping,
        &device,
        systemd.socket(),
        KEEP_AGAIN * 3,
        || {}
    ));
}

/// A host whose guests hold more memory than it has must not stall
/// its guard into the watchdog's reset: the installed unit gives the
/// guard the processor first, and it is never restarted.
#[test]
fn the_installed_guard_runs_first_and_is_never_restarted() {
    let unit = include_str!("../../../../../deploy/host/compute-guard.service");
    let set: Vec<&str> = unit
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with('#'))
        .collect();
    for directive in [
        "CPUSchedulingPolicy=fifo",
        "CPUSchedulingPriority=1",
        "OOMScoreAdjust=-1000",
        "Restart=no",
        "ExecStart=/opt/compute/current/compute-host guard",
    ] {
        assert!(
            set.contains(&directive),
            "compute-guard.service lacks {directive}"
        );
    }
}
