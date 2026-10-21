//! Disk lengths across restarts: what each sandbox, and each VM an earlier
//! agent left running, books on local disk by its own disk's length.

use std::sync::atomic::Ordering;

use compute_core::{DiskPolicy, HostPolicy};
use compute_host::protocol::{Reply, Request};

use super::{Delays, Lab, NEVER, id, vm_name};

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
