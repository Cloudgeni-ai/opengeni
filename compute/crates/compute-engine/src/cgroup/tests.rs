use super::*;

#[test]
fn memory_high_is_set_and_read_back_as_it_is_now() {
    let dir = tempfile::tempdir().unwrap();
    let group = Cgroup::at(dir.path());
    fs::write(dir.path().join("memory.high"), "").unwrap();
    group.set_memory_high(Some(30 << 30)).unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("memory.high")).unwrap(),
        (30_u64 << 30).to_string()
    );
    assert_eq!(group.memory_high().unwrap(), Some(30 << 30));
    // What the kernel shows, and what an operator lifting it leaves.
    fs::write(dir.path().join("memory.high"), "max\n").unwrap();
    assert_eq!(group.memory_high().unwrap(), None);
    group.set_memory_high(Some(1 << 30)).unwrap();
    group.set_memory_high(None).unwrap();
    assert_eq!(group.memory_high().unwrap(), None);
    fs::write(dir.path().join("memory.high"), "lots").unwrap();
    assert!(group.memory_high().is_err());
}

#[test]
fn swap_is_read_and_limited_and_absent_without_swap() {
    let dir = tempfile::tempdir().unwrap();
    let group = Cgroup::at(dir.path());
    assert_eq!(group.swap().unwrap(), None, "a kernel without swap");
    fs::write(dir.path().join("memory.swap.current"), "8192\n").unwrap();
    fs::write(dir.path().join("memory.swap.max"), "max\n").unwrap();
    assert_eq!(
        group.swap().unwrap(),
        Some(Swap {
            used: 8192,
            max: None
        })
    );
    group.set_swap_max(Some(1 << 26)).unwrap();
    assert_eq!(group.swap().unwrap().unwrap().max, Some(1 << 26));
    group.set_swap_max(None).unwrap();
    assert_eq!(group.swap().unwrap().unwrap().max, None);
}

#[test]
fn pages_stored_without_a_disk_are_those_compressed_or_all_zeros() {
    let stat = "anon 4096\nzswap 1024\nzswpin 3\nzswpout 17\nzswpwb 0\n\
                swpin_zero 1\nswpout_zero 5\npswpout 9\n";
    assert_eq!(stored_pages(stat), 22);
    assert_eq!(stored_pages("anon 4096\n"), 0, "a kernel that says neither");
}

#[test]
fn a_cgroup_write_that_fails_at_once_says_so() {
    let missing = Cgroup::at("/nonexistent/compute-engine-test");
    assert_eq!(
        missing.set_memory_high(Some(1 << 30)).unwrap_err().kind(),
        io::ErrorKind::NotFound
    );
    let never = || Ok(false);
    let refused = write_until_applied(
        Duration::from_millis(5),
        || Err(io::Error::from(io::ErrorKind::InvalidInput)),
        never,
    );
    assert_eq!(refused.unwrap_err().kind(), io::ErrorKind::InvalidInput);
    let panicked = write_until_applied(Duration::from_millis(5), || panic!("in the write"), never);
    assert!(panicked.is_err());
    // Late, after the caller has been looking for a while: still told.
    let late = write_until_applied(
        Duration::from_millis(5),
        || {
            thread::sleep(Duration::from_millis(200));
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        },
        never,
    );
    assert_eq!(late.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
}

#[test]
fn a_cgroup_write_the_kernel_holds_for_reclaim_is_not_waited_out() {
    // As an older kernel holds a write of `memory.high` below what the
    // group holds until it has reclaimed the difference, the limit
    // already set.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("memory.high");
    fs::write(&file, "max").unwrap();
    let (release, held) = mpsc::channel::<()>();
    let started = std::time::Instant::now();
    let written = file.clone();
    write_until_applied(
        Duration::from_millis(5),
        move || {
            fs::write(&written, "1024")?;
            let _ = held.recv_timeout(Duration::from_secs(30));
            Ok(())
        },
        || Ok(fs::read_to_string(&file)? == "1024"),
    )
    .unwrap();
    let waited = started.elapsed();
    drop(release);
    assert!(
        waited < Duration::from_secs(5),
        "waited {waited:?} for a held write"
    );
}

#[test]
fn a_cgroup_write_held_before_it_applies_is_waited_for() {
    // Nothing may count on a limit that is not set yet, and a later
    // setting must not be overtaken by this one.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("memory.high");
    fs::write(&file, "max").unwrap();
    let (release, held) = mpsc::channel::<()>();
    let releaser = thread::spawn(move || {
        thread::sleep(Duration::from_millis(200));
        release.send(()).unwrap();
    });
    let started = std::time::Instant::now();
    let written = file.clone();
    write_until_applied(
        Duration::from_millis(5),
        move || {
            let _ = held.recv_timeout(Duration::from_secs(30));
            fs::write(&written, "1024")
        },
        || Ok(fs::read_to_string(&file)? == "1024"),
    )
    .unwrap();
    assert!(started.elapsed() >= Duration::from_millis(200));
    assert_eq!(fs::read_to_string(&file).unwrap(), "1024");
    releaser.join().unwrap();
}

#[test]
fn controllers_are_enabled_in_every_group_above_a_parent() {
    let mount = tempfile::tempdir().unwrap();
    fs::create_dir_all(mount.path().join("fleet/hosts")).unwrap();
    enable_controllers_above(mount.path(), Path::new("fleet/hosts/vms")).unwrap();
    for group in ["", "fleet", "fleet/hosts"] {
        let control = mount.path().join(group).join("cgroup.subtree_control");
        assert_eq!(fs::read_to_string(control).unwrap(), CONTROLLERS, "{group}");
    }
    assert!(!mount.path().join("fleet/hosts/vms").exists());
    // Only the root is above a group just below it.
    let mount = tempfile::tempdir().unwrap();
    enable_controllers_above(mount.path(), Path::new("compute")).unwrap();
    assert!(mount.path().join("cgroup.subtree_control").exists());
    assert!(!mount.path().join("compute").exists());
}

#[test]
fn vm_groups_must_lie_outside_the_callers_own() {
    let own = parse_own("0::/system.slice/compute-host.service\n").unwrap();
    assert_eq!(own, Path::new("system.slice/compute-host.service"));
    assert!(!encloses(&own, Path::new("compute")));
    assert!(!encloses(
        &own,
        Path::new("system.slice/compute-host.service2")
    ));
    assert!(encloses(
        &own,
        Path::new("system.slice/compute-host.service/vms")
    ));
    assert!(encloses(
        &own,
        Path::new("system.slice/compute-host.service")
    ));
    // A process in the root group, as in a container without a unit.
    let root = parse_own("0::/\n").unwrap();
    assert!(!encloses(&root, Path::new("compute")));
    assert_eq!(parse_own("1:name=systemd:/x\n"), None);
}

#[test]
fn reads_the_freezer_from_cgroup_events() {
    let running = Freezer::parse(false, "populated 1\nfrozen 0\n");
    assert_eq!(
        running,
        Freezer {
            asked: false,
            frozen: false,
            empty: false
        }
    );
    let frozen = Freezer::parse(true, "populated 1\nfrozen 1\n");
    assert!(frozen.asked && frozen.frozen && !frozen.empty);
    // An empty group a freeze was asked of reports frozen too.
    let empty = Freezer::parse(true, "populated 0\nfrozen 1\n");
    assert!(empty.empty && empty.frozen);
    assert!(Freezer::parse(false, "").empty);
}

/// A group with processes is held frozen once the kernel says it is,
/// or while it or a group above it asks for a freeze, even one that
/// reads `frozen 0` because a process in it is ending.
#[test]
fn a_group_is_held_frozen_by_its_own_freeze_or_one_above() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("vms");
    let vm = parent.join("vm");
    std::fs::create_dir_all(&vm).unwrap();
    let set = |path: &Path, freeze: &str, events: &str| {
        std::fs::write(path.join("cgroup.freeze"), freeze).unwrap();
        std::fs::write(path.join("cgroup.events"), events).unwrap();
    };
    let group = Cgroup::at(&vm);
    set(&parent, "0", "populated 1\nfrozen 0\n");
    set(&vm, "0", "populated 1\nfrozen 0\n");
    assert!(!group.is_held_frozen().unwrap(), "running");
    set(&parent, "1", "populated 1\nfrozen 0\n");
    assert!(group.is_held_frozen().unwrap(), "the group above asks");
    set(&vm, "0", "populated 1\nfrozen 1\n");
    assert!(group.is_held_frozen().unwrap());
    set(&parent, "0", "populated 1\nfrozen 0\n");
    set(&vm, "1", "populated 1\nfrozen 0\n");
    assert!(
        group.is_held_frozen().unwrap(),
        "its own freeze, still completing"
    );
    set(&vm, "1", "populated 0\nfrozen 1\n");
    assert!(!group.is_held_frozen().unwrap(), "nothing left to hold");
    assert!(!Cgroup::at(parent.join("gone")).is_held_frozen().unwrap());

    let names = |group: &Cgroup| {
        let mut names: Vec<_> = group
            .children()
            .unwrap()
            .iter()
            .map(|child| child.path().file_name().unwrap().to_owned())
            .collect();
        names.sort();
        names
    };
    std::fs::create_dir(parent.join("other")).unwrap();
    assert_eq!(
        names(&Cgroup::at(&parent)),
        ["other", "vm"],
        "groups, not files"
    );
    assert_eq!(names(&Cgroup::at(parent.join("gone"))), [""; 0]);
}

#[test]
fn reads_processor_time_from_cpu_stat() {
    let stat = "usage_usec 1234567\nuser_usec 1000000\nsystem_usec 234567\n";
    assert_eq!(
        parse_cpu_usage(stat).unwrap(),
        Duration::from_micros(1_234_567)
    );
    assert!(parse_cpu_usage("user_usec 5\n").is_err());
}

/// Groups VMs left behind claim no protection once an engine starts:
/// empty ones go, and the parent claims what those with a process do.
#[test]
fn empty_groups_left_behind_are_removed_with_their_claims() {
    let parent = tempfile::tempdir().unwrap();
    let running = parent.path().join("running");
    fs::create_dir(&running).unwrap();
    fs::write(running.join("cgroup.events"), "populated 1\nfrozen 0\n").unwrap();
    fs::write(running.join("memory.low"), "536870912\n").unwrap();
    // A real group's control files go with it; here an empty directory
    // stands for one left behind.
    fs::create_dir(parent.path().join("left-behind")).unwrap();
    fs::write(parent.path().join("memory.low"), "9663676416\n").unwrap();
    Cgroup::at(parent.path()).remove_empty_children().unwrap();
    assert!(running.exists());
    assert!(!parent.path().join("left-behind").exists());
    assert_eq!(
        fs::read_to_string(parent.path().join("memory.low")).unwrap(),
        "536870912"
    );
}

#[test]
fn reads_zswap_traffic_and_pressure() {
    // (Kills by the out-of-memory killer are read beside them.)
    assert_eq!(
        parse_oom_kills("low 0\nhigh 12\nmax 3\noom 2\noom_kill 2\noom_group_kill 0\n"),
        2
    );
    assert_eq!(parse_oom_kills("low 0\nhigh 0\n"), 0);
    let stat = "anon 4096\nzswap 1024\nzswapped 8192\nzswpin 3\nzswpout 17\nzswpwb 0\n\
                pgfault 900\npgmajfault 42\n";
    let pressure = "some avg10=1.25 avg60=0.40 avg300=0.08 total=12345\n\
                    full avg10=0.50 avg60=0.10 avg300=0.02 total=4567\n";
    assert_eq!(
        parse_memory_stats(stat, Some(pressure)),
        MemoryStats {
            zswpout: 17,
            zswpin: 3,
            compressed: Some(1024),
            swapped: Some(8192),
            pressure_some_avg10: Some(1.25),
            pressure_full_avg10: Some(0.5),
            pressure_some_us: Some(12_345),
            pressure_full_us: Some(4567),
            major_faults: Some(42),
            high: None,
        }
    );
    // Without zswap, fault counts or pressure stall information: absent,
    // not zero.
    assert_eq!(
        parse_memory_stats("anon 4096\n", None),
        MemoryStats::default()
    );
}

#[test]
fn page_cache_the_host_can_drop_is_not_held() {
    // A paused VM just after its 8 GiB image was saved: 330 MB of guest
    // memory, and the image's page cache charged to its group.
    let stat = "anon 329879552\nfile 8237420544\nkernel 22253568\nshmem 8192\n\
                file_mapped 40960\nfile_dirty 0\nfile_writeback 0\n\
                active_file 8235515904\ninactive_file 1896448\n";
    assert_eq!(droppable_cache(stat), 8_237_420_544 - 8192 - 40960);
    let group = tempfile::tempdir().unwrap();
    fs::write(group.path().join("memory.current"), "8589553664\n").unwrap();
    fs::write(group.path().join("memory.stat"), stat).unwrap();
    assert_eq!(
        Cgroup::at(group.path()).memory_held().unwrap(),
        8_589_553_664 - (8_237_420_544 - 8192 - 40960)
    );
    // Cache still to be written, shared memory (tmpfs) and mapped files
    // stay held.
    let busy = "file 3000\nshmem 1000\nfile_mapped 500\nfile_dirty 700\nfile_writeback 300\n";
    assert_eq!(droppable_cache(busy), 500);
    // More kept than cached (a page both mapped and dirty) drops nothing.
    assert_eq!(
        droppable_cache("file 100\nfile_mapped 80\nfile_dirty 80\n"),
        0
    );
    // An older kernel's file without the fields leaves everything held.
    assert_eq!(droppable_cache("anon 4096\n"), 0);
    fs::write(group.path().join("memory.stat"), "anon 4096\n").unwrap();
    assert_eq!(
        Cgroup::at(group.path()).memory_held().unwrap(),
        8_589_553_664
    );
}

#[test]
fn cache_added_between_the_two_reads_leaves_nothing_held_out() {
    const MIB: u64 = 1 << 20;
    // 512 MiB held when `memory.current` is read; 1 GiB of clean cache
    // arrives before `memory.stat` is.
    let stat = format!(
        "anon {}\nfile {}\nkernel {}\nsock 0\nshmem 0\nfile_mapped 0\n\
         file_dirty 0\nfile_writeback 0\n",
        500 * MIB,
        1024 * MIB,
        12 * MIB
    );
    assert_eq!(held_memory(512 * MIB, &stat), 512 * MIB);
    // Read at the same moment, the two agree.
    assert_eq!(held_memory(1536 * MIB, &stat), 512 * MIB);
    // Cache dropped between the reads is in the total but not in the
    // file, and only counts more as held.
    assert_eq!(held_memory(1600 * MIB, &stat), 576 * MIB);
    // Mapped, shared and unwritten cache is named as held too, at most
    // the cache there is.
    let busy = format!(
        "anon {}\nfile {}\nshmem {}\nfile_mapped {}\nfile_dirty {}\n",
        100 * MIB,
        300 * MIB,
        200 * MIB,
        100 * MIB,
        50 * MIB
    );
    assert_eq!(held_memory(0, &busy), 400 * MIB);
}

#[test]
fn reads_traffic_from_proc_io() {
    let counters = "rchar: 1000\nwchar: 234\nsyscr: 7\nsyscw: 3\nread_bytes: 4096\n\
                    write_bytes: 0\ncancelled_write_bytes: 0\n";
    assert_eq!(parse_io_bytes(counters).unwrap(), 1234);
    assert!(parse_io_bytes("rchar: 5\n").is_err());
}

#[test]
fn reads_writes_from_proc_io() {
    let counters = "rchar: 1000\nwchar: 234\nsyscr: 7\nsyscw: 3\nread_bytes: 4096\n\
                    write_bytes: 8192\ncancelled_write_bytes: 0\n";
    let writes = parse_writes(counters).unwrap();
    assert_eq!(
        writes,
        Writes {
            bytes: 234,
            calls: 3,
            dirtied: 8192,
        }
    );
    assert!(parse_writes("wchar: 5\n").is_err());
    assert!(parse_writes("wchar: 5\nsyscw: 1\n").is_err());
    let earlier = Writes {
        bytes: 34,
        calls: 1,
        dirtied: 4096,
    };
    assert_eq!(
        writes.since(earlier),
        Writes {
            bytes: 200,
            calls: 2,
            dirtied: 4096,
        }
    );
    assert_eq!(earlier.since(writes), Writes::default());
}

/// A hole punched over part of a block a file shares takes a new block
/// for the rest of it: a page dirtied with no write call, which only
/// the dirtied pages count. Runs where `COMPUTE_TEST_SHARED_EXTENTS_DIR`
/// names a directory whose files share extents; a gate that lists
/// `shared-extents` in `COMPUTE_TEST_REQUIRE` fails it instead of
/// skipping.
#[test]
fn a_partial_discard_of_shared_blocks_counts_as_dirtied() {
    use rustix::fs::{FallocateFlags, fallocate, ioctl_ficlone};
    use std::os::unix::fs::FileExt;

    const BLOCK: u64 = 4096;
    const BLOCKS: u64 = 1024;
    let Some(dir) = std::env::var_os("COMPUTE_TEST_SHARED_EXTENTS_DIR") else {
        let required = std::env::var("COMPUTE_TEST_REQUIRE").unwrap_or_default();
        assert!(
            !required
                .split(',')
                .any(|need| need.trim() == "shared-extents"),
            "a required test cannot run: COMPUTE_TEST_SHARED_EXTENTS_DIR is not set"
        );
        eprintln!("skipped: COMPUTE_TEST_SHARED_EXTENTS_DIR is not set");
        return;
    };
    let dir = tempfile::tempdir_in(dir).unwrap();
    let original = fs::File::create_new(dir.path().join("original")).unwrap();
    original
        .write_all_at(&vec![1_u8; usize::try_from(BLOCKS * BLOCK).unwrap()], 0)
        .unwrap();
    original.sync_all().unwrap();
    let copy = fs::File::create_new(dir.path().join("copy")).unwrap();
    ioctl_ficlone(&copy, &original).unwrap();

    let own = || parse_writes(&fs::read_to_string("/proc/self/io").unwrap()).unwrap();
    let before = own();
    for block in 0..BLOCKS {
        let flags = FallocateFlags::PUNCH_HOLE | FallocateFlags::KEEP_SIZE;
        fallocate(&copy, flags, block * BLOCK + 512, 512).unwrap();
    }
    let after = own().since(before);
    // Other tests of this process may write meanwhile, but none
    // dirties less.
    assert!(
        after.dirtied >= BLOCKS * BLOCK,
        "{BLOCKS} partial discards dirtied only {after:?}"
    );
}
