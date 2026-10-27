//! Disk lengths across restarts: what each sandbox, and each VM an earlier
//! agent left running, books on local disk by its own disk's length; and
//! disks a create asks to be longer than their image's.

use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use compute_core::{DiskPolicy, DiskSpace, HostPolicy};
use compute_host::DiskGauge;
use compute_host::protocol::{ErrorCode, MAX_DISK_MIB, Reply, Request, SandboxConfig};
use tokio::time::{Instant, sleep};

use super::{Delays, Lab, NEVER, World, id, vm_name};

/// A sandbox's record keeps its disk's length, so what it books stays its
/// own disk's however the host's base image changes, in object storage
/// too, where no local file shows it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sandbox_keeps_its_disk_length_when_the_base_image_changes() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(48);
    lab.create(sandbox, NEVER).await;
    let base = lab.root.join("base.img");
    let length = std::fs::metadata(&base).unwrap().len();
    assert_eq!(lab.record(sandbox)["allocation"]["disk_bytes"], length);
    let (root, world) = lab.stop().await;
    std::fs::write(&base, vec![1; 64 << 10]).unwrap();

    let lab = Lab::start(root, world, Delays::default(), HostPolicy::default()).await;
    assert_eq!(lab.record(sandbox)["allocation"]["disk_bytes"], length);
    let other = id(49);
    lab.create(other, NEVER).await;
    assert_eq!(lab.record(other)["allocation"]["disk_bytes"], 64 << 10);
    lab.assert_clean();
}

/// A create may ask for a longer disk than its image's: the disk is made
/// that long at once, its new end a hole the guest grows into, and is
/// recorded and booked at that length, across a restart too. Asking for
/// less than the image holds keeps the image's length, and asking for more
/// than the host's disk can take is refused for disk, leaving nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_create_may_ask_for_a_longer_disk_than_its_image() {
    const IMAGE: u64 = 2 << 20;
    const LONG: u64 = 64 << 20;
    let root = Lab::root();
    std::fs::write(root.join("base.img"), vec![1; 2 << 20]).unwrap();
    let (lab, _) = gauged(root, Arc::default()).await;
    let (long, short, huge) = (id(56), id(57), id(58));
    assert_eq!(create(&lab, long, 64).await, Reply::Done);
    assert_eq!(create(&lab, short, 1).await, Reply::Done);
    let reply = create(&lab, huge, MAX_DISK_MIB).await;
    assert!(
        matches!(&reply, Reply::Error { code: ErrorCode::HostFull, message } if message.contains("disk")),
        "{reply:?}"
    );
    assert!(
        !lab.sandbox_dir(huge).exists(),
        "the refused create made files"
    );
    let disk = |lab: &Lab, sandbox| lab.sandbox_dir(sandbox).join("root/disk.ext4");
    let lengths = |lab: &Lab| {
        [long, short].map(|sandbox| {
            (
                std::fs::metadata(disk(lab, sandbox)).unwrap().len(),
                lab.record(sandbox)["allocation"]["disk_bytes"]
                    .as_u64()
                    .unwrap(),
            )
        })
    };
    assert_eq!(lengths(&lab), [(LONG, LONG), (IMAGE, IMAGE)]);
    let held = std::fs::metadata(disk(&lab, long)).unwrap().blocks() * 512;
    assert!(held < IMAGE + (1 << 20), "its new end is a hole: {held}");

    let (root, world) = lab.stop().await;
    let (lab, gauge) = gauged(root, world).await;
    assert_eq!(lengths(&lab), [(LONG, LONG), (IMAGE, IMAGE)]);
    // Awake, the long disk books all its guest may still write to it: what
    // each books shows as it goes.
    for sandbox in [long, short] {
        assert_eq!(lab.run(sandbox, &["set awake"]).await, ["ok"]);
    }
    sleep(Duration::from_millis(200)).await;
    let both = read(&lab, &gauge).await;
    lab.remove(long).await;
    let without_long = read(&lab, &gauge).await;
    lab.remove(short).await;
    let longer = (both - without_long) - (without_long - read(&lab, &gauge).await);
    assert!(
        longer >= LONG - IMAGE - (1 << 20),
        "the long disk books {longer} more"
    );
    lab.assert_clean();
}

/// A lab at `root` with a disk policy, whose agent reads its disk from the
/// gauge returned, and has read 64 GiB free.
async fn gauged(root: PathBuf, world: Arc<World>) -> (Lab, DiskGauge) {
    let gauge = DiskGauge::default();
    let reading = gauge.clone();
    let lab = Lab::start_configured(
        root,
        world,
        Delays::default(),
        HostPolicy::default(),
        move |config| {
            config.policy.disk = Some(DiskPolicy {
                reserve: 0,
                reserve_inodes: 0,
            });
            config.disk_reading = Some(reading);
        },
    )
    .await;
    read(&lab, &gauge).await;
    (lab, gauge)
}

/// Has the agent of `lab` read 64 GiB free, then tells what its disk book
/// holds.
async fn read(lab: &Lab, gauge: &DiskGauge) -> u64 {
    gauge.give(DiskSpace {
        bytes: 64 << 30,
        inodes: 1 << 30,
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    while !gauge.taken() {
        assert!(Instant::now() < deadline, "no sample took the reading");
        sleep(Duration::from_millis(5)).await;
    }
    lab.status().await.disk.unwrap().booked
}

/// Asks `lab` for sandbox `sandbox` with a disk of at least `disk_mib`.
async fn create(lab: &Lab, sandbox: compute_host::protocol::Id, disk_mib: u32) -> Reply {
    let config = SandboxConfig::new(1, 256, NEVER).with_disk_mib(disk_mib);
    lab.client
        .call(&Request::Create {
            id: sandbox,
            config,
        })
        .await
        .unwrap()
}

/// A VM left running books its own disk's length while a restart's removal
/// cannot end it, however much it grew past the length its record keeps,
/// and never today's base image, however much shorter that is.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_vm_left_running_books_its_own_disk_not_todays_image() {
    const LONG: u64 = 1 << 40;
    retained_disk_booking(54, LONG, |disk| {
        std::fs::OpenOptions::new()
            .write(true)
            .open(disk)
            .unwrap()
            .set_len(LONG)
            .unwrap();
    })
    .await;
}

/// A missing disk does not prove a VM left running writes no more: it may
/// hold the unlinked file open. Its length is unknown, so it books more
/// than any disk holds until its removal ends it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_vm_left_running_without_its_disk_file_books_an_unknown_length() {
    retained_disk_booking(55, 1 << 60, |disk| std::fs::remove_file(disk).unwrap()).await;
}

/// Leaves sandbox `n`'s VM running, unadoptable and unending, with a
/// record under removal and `change` made to its disk, and checks that a
/// restart books at least `booked` for it until a removal ends it.
async fn retained_disk_booking(n: u128, booked: u64, change: impl FnOnce(&std::path::Path)) {
    let policy = HostPolicy {
        disk: Some(DiskPolicy {
            reserve: 0,
            reserve_inodes: 0,
        }),
        ..HostPolicy::default()
    };
    let lab = Lab::new(Delays::default(), policy).await;
    let sandbox = id(n);
    lab.create(sandbox, NEVER).await;
    lab.run(sandbox, &["set alive"]).await;
    let dir = lab.sandbox_dir(sandbox);
    let (root, world) = lab.stop().await;
    let path = dir.join("sandbox.json");
    let mut record: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    record["removing"] = true.into();
    std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    let disk = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("disk.ext4"))
        .find(|path| path.exists())
        .expect("the sandbox's disk");
    change(&disk);
    // Today's base image is far shorter than any disk here.
    std::fs::write(root.join("base.img"), vec![1; 64 << 10]).unwrap();
    world.unadoptable.lock().unwrap().insert(vm_name(sandbox));
    world.stuck_clean_ups.store(true, Ordering::Relaxed);

    let lab = Lab::start(root, world, Delays::default(), policy).await;
    lab.wait_until("its disk booked", |status| {
        status.disk.is_some_and(|disk| disk.booked >= booked)
    })
    .await;
    lab.world.stuck_clean_ups.store(false, Ordering::Relaxed);
    let reply = lab
        .client
        .call(&Request::Remove {
            id: sandbox,
            generation: None,
        })
        .await
        .unwrap();
    assert_eq!(reply, Reply::Done);
    lab.wait_until("its booking gone once it ended", |status| {
        status.disk.is_some_and(|disk| disk.booked == 0)
    })
    .await;
    lab.assert_clean();
}

/// A VM a restart cannot take back may still write to local disk: a save
/// an earlier agent started, and its guest's disk. What it may write stays
/// booked until its removal ends it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_vm_left_unmanaged_keeps_its_disk_booked_until_it_ends() {
    let policy = HostPolicy {
        disk: Some(DiskPolicy {
            reserve: 0,
            reserve_inodes: 0,
        }),
        ..HostPolicy::default()
    };
    let lab = Lab::new(Delays::default(), policy).await;
    let sandbox = id(53);
    lab.create(sandbox, NEVER).await;
    lab.run(sandbox, &["set alive"]).await;
    let memory = lab.record(sandbox)["config"]["memory_mib"]
        .as_u64()
        .unwrap()
        << 20;
    let (root, world) = lab.stop().await;
    world.unadoptable.lock().unwrap().insert(vm_name(sandbox));

    let lab = Lab::start(root, world, Delays::default(), policy).await;
    lab.wait_until("its next save and growth booked", |status| {
        status.disk.is_some_and(|disk| disk.booked > memory)
    })
    .await;
    let reply = lab
        .client
        .call(&Request::Remove {
            id: sandbox,
            generation: None,
        })
        .await
        .unwrap();
    assert_eq!(reply, Reply::Done);
    lab.wait_until("its booking gone once it ended", |status| {
        status.disk.is_some_and(|disk| disk.booked == 0)
    })
    .await;
    lab.assert_clean();
}
