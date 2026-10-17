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

/// A record written before disk lengths were kept learns its own on the
/// next start, from its local disk, before anything of it is admitted;
/// one only in the store, which cannot say here, is blocked rather than
/// booked by today's base image.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_record_without_its_disk_length_learns_it_or_is_blocked() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let (local, remote) = (id(51), id(52));
    lab.create(local, NEVER).await;
    lab.create(remote, NEVER).await;
    let length = lab.record(local)["allocation"]["disk_bytes"].clone();
    let (local_dir, remote_dir) = (lab.sandbox_dir(local), lab.sandbox_dir(remote));
    let (root, world) = lab.stop().await;
    for (dir, disk) in [(&local_dir, "local"), (&remote_dir, "remote")] {
        let path = dir.join("sandbox.json");
        let mut record: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        record["allocation"]
            .as_object_mut()
            .unwrap()
            .remove("disk_bytes");
        record["disk"] = disk.into();
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    }
    // Today's base image no longer says how long their disks are.
    std::fs::write(root.join("base.img"), vec![1; 64 << 10]).unwrap();

    let lab = Lab::start(root, world, Delays::default(), HostPolicy::default()).await;
    assert_eq!(lab.record(local)["allocation"]["disk_bytes"], length);
    let status = lab.status().await;
    assert_eq!(status.blocked.len(), 1, "{status:?}");
    assert_eq!(status.blocked[0].id, remote);
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

/// A VM left running whose record predates keeping disk lengths books its
/// own disk's length while a restart's removal cannot end it, never
/// today's base image, however much shorter that is.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_vm_left_running_books_its_own_disk_not_todays_image() {
    const LONG: u64 = 1 << 40;
    let policy = HostPolicy {
        disk: Some(DiskPolicy {
            reserve: 0,
            reserve_inodes: 0,
        }),
        ..HostPolicy::default()
    };
    let lab = Lab::new(Delays::default(), policy).await;
    let sandbox = id(54);
    lab.create(sandbox, NEVER).await;
    lab.run(sandbox, &["set alive"]).await;
    let dir = lab.sandbox_dir(sandbox);
    let (root, world) = lab.stop().await;
    let path = dir.join("sandbox.json");
    let mut record: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    record["allocation"]
        .as_object_mut()
        .unwrap()
        .remove("disk_bytes");
    record["removing"] = true.into();
    std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    // Its disk is far longer than today's base image.
    let disk = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("disk.ext4"))
        .find(|path| path.exists())
        .expect("the sandbox's disk");
    std::fs::OpenOptions::new()
        .write(true)
        .open(&disk)
        .unwrap()
        .set_len(LONG)
        .unwrap();
    std::fs::write(root.join("base.img"), vec![1; 64 << 10]).unwrap();
    world.unadoptable.lock().unwrap().insert(vm_name(sandbox));
    world.stuck_clean_ups.store(true, Ordering::Relaxed);

    let lab = Lab::start(root, world, Delays::default(), policy).await;
    lab.wait_until("its own disk booked", |status| {
        status.disk.is_some_and(|disk| disk.booked >= LONG)
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
