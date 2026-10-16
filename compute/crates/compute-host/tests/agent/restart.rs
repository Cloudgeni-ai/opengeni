//! Agent restarts and removal: VMs taken back, ids blocked, generations
//! fenced, teardowns ordered.

use std::sync::atomic::Ordering;
use std::time::Duration;

use compute_core::HostPolicy;
use compute_host::protocol::{
    DurabilityName, ErrorCode, Id, LevelName, PriorityName, Reply, Request, SandboxConfig,
    SleepConfig,
};
use tokio::time::Instant;

use super::{Delays, Lab, NEVER, PAUSE_SOON, SAVE_IN_PLACE, SAVE_QUICKLY, id, vm_name};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restarted_agent_takes_back_running_vms_and_recovers_the_rest() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let (saved, running, paused) = (id(6), id(7), id(12));
    let in_place = id(14);
    lab.create(saved, SAVE_QUICKLY).await;
    lab.create(running, NEVER).await;
    lab.create(paused, PAUSE_SOON).await;
    lab.create(in_place, SAVE_IN_PLACE).await;
    lab.run(saved, &["set kept", "write saved-disk"]).await;
    lab.run(running, &["set alive", "write running-disk"]).await;
    lab.run(paused, &["set asleep"]).await;
    lab.run(in_place, &["set copied"]).await;
    lab.wait_level(saved, LevelName::Saved).await;
    lab.wait_level(paused, LevelName::Paused).await;
    lab.wait_until("the save in place", |status| {
        let view = Lab::sandbox(status, in_place);
        view.durability == DurabilityName::Local && view.step.is_none()
    })
    .await;
    let before = lab.status().await;
    let (root, world) = lab.stop().await;

    // VMs outlive the agent.
    assert!(world.live.lock().unwrap().contains(&vm_name(running)));
    assert!(world.live.lock().unwrap().contains(&vm_name(paused)));
    let lab = Lab::start(root, world, Delays::default(), HostPolicy::default()).await;
    let after = lab.status().await;
    assert_eq!(after.sandboxes.len(), 4);
    for (old, new) in before.sandboxes.iter().zip(&after.sandboxes) {
        assert_eq!(
            (old.id, old.level, old.durability, old.generation),
            (new.id, new.level, new.durability, new.generation),
            "a restart changed a sandbox"
        );
    }
    assert_eq!(lab.world.adopted.load(Ordering::Relaxed), 3);
    assert!(
        lab.image(in_place),
        "a paused VM taken back keeps its saved copy"
    );
    assert_eq!(
        lab.run(saved, &["get", "disk"]).await,
        ["kept", "saved-disk"]
    );
    assert_eq!(
        lab.run(running, &["get", "disk"]).await,
        ["alive", "running-disk"],
        "the running VM was taken back as it was"
    );
    assert_eq!(lab.run(paused, &["get"]).await, ["asleep"]);
    assert_eq!(lab.run(in_place, &["get"]).await, ["copied"]);
    assert_eq!(
        lab.world.boots.load(Ordering::Relaxed),
        4,
        "nothing rebooted"
    );
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 1);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn requests_for_a_replaced_execution_are_refused() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(13);
    lab.create(sandbox, SAVE_QUICKLY).await;
    assert_eq!(lab.current(sandbox).await.generation, 0, "not yet run");
    lab.run(sandbox, &["set first"]).await;
    let first = lab.current(sandbox).await.generation;
    assert_eq!(first, 1);
    let wake = |generation| Request::Wake {
        id: sandbox,
        generation: Some(generation),
        priority: PriorityName::Interactive,
    };
    assert!(matches!(
        lab.client.call(&wake(first)).await.unwrap(),
        Reply::Woken { .. }
    ));

    // Saving and restoring keep the guest's programs, so the execution
    // goes on.
    lab.wait_level(sandbox, LevelName::Saved).await;
    assert_eq!(lab.run(sandbox, &["get"]).await, ["first"]);
    assert_eq!(lab.current(sandbox).await.generation, first);
    assert!(matches!(
        lab.client.call(&wake(first)).await.unwrap(),
        Reply::Woken { .. }
    ));

    // A crash loses them: the next boot is a new execution.
    lab.world.crash(&vm_name(sandbox));
    assert_eq!(lab.run(sandbox, &["get"]).await, [""]);
    let second = lab.current(sandbox).await.generation;
    assert_eq!(second, first + 1);
    let reply = lab.client.call(&wake(first)).await.unwrap();
    assert!(
        matches!(
            reply,
            Reply::Error {
                code: ErrorCode::Stale,
                ..
            }
        ),
        "{reply:?}"
    );
    let reply = lab
        .client
        .call(&Request::Remove {
            id: sandbox,
            generation: Some(first),
        })
        .await
        .unwrap();
    assert!(
        matches!(
            reply,
            Reply::Error {
                code: ErrorCode::Stale,
                ..
            }
        ),
        "{reply:?}"
    );
    assert_eq!(lab.status().await.sandboxes.len(), 1, "a stale remove ran");
    let reply = lab
        .client
        .call(&Request::Remove {
            id: sandbox,
            generation: Some(second),
        })
        .await
        .unwrap();
    assert_eq!(reply, Reply::Done);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_removal_cut_short_finishes_on_the_next_start() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let (doomed, kept) = (id(14), id(15));
    lab.create(doomed, NEVER).await;
    lab.create(kept, NEVER).await;
    lab.run(doomed, &["set x"]).await;
    let dir = lab.sandbox_dir(doomed);
    let (root, world) = lab.stop().await;

    // The agent died right after recording that removal began.
    let path = dir.join("sandbox.json");
    let mut record: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    record["removing"] = true.into();
    std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    // And an unfinished creation left a directory without a record.
    let unfinished = root.join("state/vm/firecracker").join(id(16).to_string());
    std::fs::create_dir_all(unfinished.join("root")).unwrap();

    let lab = Lab::start(root, world, Delays::default(), HostPolicy::default()).await;
    lab.wait_until("the removal to finish", |_| !dir.exists())
        .await;
    let status = lab.status().await;
    assert_eq!(status.sandboxes.len(), 1);
    assert_eq!(status.sandboxes[0].id, kept);
    assert!(!unfinished.exists());
    assert!(
        !lab.world.live.lock().unwrap().contains(&vm_name(doomed)),
        "the removed sandbox's VM still runs"
    );
    // Its id is free again.
    lab.create(doomed, NEVER).await;
    assert_eq!(lab.run(doomed, &["get"]).await, [""]);
    lab.assert_clean();
}

/// A record the agent cannot read blocks its id: the sandbox is reported,
/// its VM and files are left alone, the id cannot be created again, and
/// no newcomer gets its ordinal (its VM's user and host link).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unreadable_record_blocks_its_id() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let (broken, other) = (id(40), id(41));
    lab.create(broken, NEVER).await;
    assert_eq!(lab.run(broken, &["set alive"]).await, ["ok"]);
    let ordinal = lab.record(broken)["ordinal"].clone();
    let (root, world) = lab.stop().await;
    let lab = Lab::start(root, world, Delays::default(), HostPolicy::default()).await;
    let mut record = lab.record(broken);
    record["generation"] = "unreadable".into();
    let path = lab.sandbox_dir(broken).join("sandbox.json");
    std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    let (root, world) = lab.stop().await;
    let lab = Lab::start(root, world, Delays::default(), HostPolicy::default()).await;

    let status = lab.status().await;
    assert!(status.sandboxes.is_empty(), "{status:?}");
    assert_eq!(status.blocked.len(), 1);
    assert_eq!(status.blocked[0].id, broken);
    assert!(
        lab.world.live.lock().unwrap().contains(&vm_name(broken)),
        "its VM is left running"
    );
    for request in [
        Request::Create {
            id: broken,
            config: SandboxConfig {
                vcpus: 1,
                memory_mib: 256,
                sleep: NEVER,
            },
        },
        Request::Wake {
            id: broken,
            generation: None,
            priority: PriorityName::Interactive,
        },
        Request::Remove {
            id: broken,
            generation: None,
        },
    ] {
        let reply = lab.client.call(&request).await.unwrap();
        assert!(
            matches!(
                reply,
                Reply::Error {
                    code: ErrorCode::Broken,
                    ..
                }
            ),
            "{request:?}: {reply:?}"
        );
    }
    assert!(path.exists(), "its files are left alone");
    lab.create(other, NEVER).await;
    assert_ne!(lab.record(other)["ordinal"], ordinal);
    lab.assert_clean();
}

/// A record so damaged that the user and network its sandbox holds cannot
/// be told stops all creation: any newcomer could be handed the same ones.
/// Creation resumes once the damaged sandbox is gone.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unknown_ordinal_stops_creation_until_it_is_resolved() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let (broken, other) = (id(42), id(43));
    lab.create(broken, NEVER).await;
    let (root, world) = lab.stop().await;
    let dir = root.join("state/vm/firecracker").join(broken.to_string());
    std::fs::write(dir.join("sandbox.json"), b"{ not a record").unwrap();
    let lab = Lab::start(root, world, Delays::default(), HostPolicy::default()).await;

    assert_eq!(lab.status().await.blocked.len(), 1);
    let reply = lab.client.call(&create_request(other)).await.unwrap();
    assert!(is_error(&reply, ErrorCode::Internal), "{reply:?}");

    let (root, world) = lab.stop().await;
    world.live.lock().unwrap().remove(&vm_name(broken));
    std::fs::remove_dir_all(&dir).unwrap();
    let lab = Lab::start(root, world, Delays::default(), HostPolicy::default()).await;
    lab.create(other, NEVER).await;
    lab.assert_clean();
}

/// A removal that deleted the record but not the files can be retried
/// with Remove, and a successful retry unblocks the id.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_removal_that_left_files_behind_is_retried_by_removing_again() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let doomed = id(44);
    lab.create(doomed, NEVER).await;
    let stuck = lab.sandbox_dir(doomed).join("stuck");
    std::fs::create_dir(&stuck).unwrap();
    std::fs::write(stuck.join("file"), b"").unwrap();
    if !super::freeze(&stuck) {
        // Root deletes it anyway; nothing to test.
        super::thaw(&stuck);
        return;
    }
    let remove = Request::Remove {
        id: doomed,
        generation: None,
    };
    let reply = lab.client.call(&remove).await.unwrap();
    assert!(matches!(reply, Reply::Error { .. }), "{reply:?}");
    let status = lab.status().await;
    assert_eq!(status.blocked.len(), 1, "{status:?}");
    assert!(!lab.sandbox_dir(doomed).join("sandbox.json").exists());

    super::thaw(&stuck);
    assert_eq!(lab.client.call(&remove).await.unwrap(), Reply::Done);
    let status = lab.status().await;
    assert!(status.blocked.is_empty(), "{status:?}");
    assert!(!lab.sandbox_dir(doomed).exists());
    lab.create(doomed, NEVER).await;
    lab.assert_clean();
}

fn create_request(id: Id) -> Request {
    Request::Create {
        id,
        config: SandboxConfig {
            vcpus: 1,
            memory_mib: 256,
            sleep: NEVER,
        },
    }
}

fn is_error(reply: &Reply, expected: ErrorCode) -> bool {
    matches!(reply, Reply::Error { code, .. } if *code == expected)
}

/// A sandbox whose recovery fails is blocked, never forgotten: its record
/// and files stay, its id cannot be created afresh over them, and removing
/// it deletes it properly.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_recovery_blocks_the_id_until_removed() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(43);
    lab.create(sandbox, SAVE_QUICKLY).await;
    lab.run(sandbox, &["set x"]).await;
    lab.wait_level(sandbox, LevelName::Saved).await;
    let dir = lab.sandbox_dir(sandbox);
    let (root, world) = lab.stop().await;
    std::fs::remove_file(dir.join("root/disk.ext4")).unwrap();

    let lab = Lab::start(root, world, Delays::default(), HostPolicy::default()).await;
    let status = lab.status().await;
    assert!(status.sandboxes.is_empty(), "{status:?}");
    assert_eq!(status.blocked.len(), 1);
    assert_eq!(status.blocked[0].id, sandbox);
    let reply = lab.client.call(&create_request(sandbox)).await.unwrap();
    assert!(is_error(&reply, ErrorCode::Broken), "{reply:?}");
    assert!(dir.join("sandbox.json").exists(), "its record is kept");

    let reply = lab
        .client
        .call(&Request::Remove {
            id: sandbox,
            generation: None,
        })
        .await
        .unwrap();
    assert_eq!(reply, Reply::Done);
    assert!(!dir.exists());
    assert_eq!(lab.status().await.blocked.len(), 0);
    lab.create(sandbox, NEVER).await;
    assert_eq!(lab.run(sandbox, &["get"]).await, [""]);
    lab.assert_clean();
}

/// A VM the restarted agent cannot check on is left running and its
/// sandbox blocked; only removing it stops the VM.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_vm_that_cannot_be_checked_is_left_running() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(44);
    lab.create(sandbox, NEVER).await;
    lab.run(sandbox, &["set alive"]).await;
    let (root, world) = lab.stop().await;
    world.unadoptable.lock().unwrap().insert(vm_name(sandbox));

    let lab = Lab::start(root, world, Delays::default(), HostPolicy::default()).await;
    let status = lab.status().await;
    assert_eq!(status.blocked.len(), 1, "{status:?}");
    assert!(
        lab.world.live.lock().unwrap().contains(&vm_name(sandbox)),
        "the VM was stopped"
    );
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1);
    let reply = lab
        .client
        .call(&Request::Remove {
            id: sandbox,
            generation: None,
        })
        .await
        .unwrap();
    assert_eq!(reply, Reply::Done);
    assert!(!lab.world.live.lock().unwrap().contains(&vm_name(sandbox)));
    lab.assert_clean();
}

/// A VM that died is torn down before its replacement starts, however long
/// the teardown takes, so the teardown never touches the new VM's jail.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_replacement_waits_for_the_dead_vms_teardown() {
    let delays = Delays {
        stop: Duration::from_millis(300),
        ..Delays::default()
    };
    let lab = Lab::new(delays, HostPolicy::default()).await;
    let sandbox = id(45);
    lab.create(sandbox, NEVER).await;
    lab.run(sandbox, &["set lost"]).await;
    lab.world.crash(&vm_name(sandbox));
    let started = Instant::now();
    assert_eq!(lab.run(sandbox, &["get"]).await, [""]);
    assert!(started.elapsed() >= Duration::from_millis(250));
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 2);
    lab.assert_clean();
}

/// An agent that stops part way through checking a VM's disk leaves no
/// proof the disk kept every write. The next agent takes the VM back and
/// never saves it, but the sandbox is not broken: it still wakes and runs.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_vm_whose_disk_check_was_cut_short_still_wakes_and_runs() {
    const SAVE_LATER: SleepConfig = SleepConfig {
        pause_after_ms: Some(30),
        save_after_ms: Some(1_500),
        ..NEVER
    };
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(47);
    lab.create(sandbox, SAVE_LATER).await;
    lab.run(sandbox, &["set alive"]).await;
    lab.wait_level(sandbox, LevelName::Paused).await;
    let marker = lab.sandbox_dir(sandbox).join("disk-check");
    let (root, world) = lab.stop().await;
    // As if the agent stopped after the VMM synced the disk but before it
    // learned how that went.
    std::fs::write(&marker, "").unwrap();

    let lab = Lab::start(root, world, Delays::default(), HostPolicy::default()).await;
    let view = lab.current(sandbox).await;
    assert!(view.unsavable && !view.broken, "{view:?}");
    let reply = lab.sleep_to(sandbox, LevelName::Saved).await;
    assert!(is_error(&reply, ErrorCode::Invalid), "{reply:?}");
    // Well past its save time it is still only paused, and never saved.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let view = lab.current(sandbox).await;
    assert_eq!(
        (view.level, view.durability),
        (LevelName::Paused, DurabilityName::Volatile),
        "{view:?}"
    );
    assert!(!lab.image(sandbox));
    assert!(marker.exists(), "the record of the cut-short check went");

    let reply = lab.wake(sandbox).await;
    assert!(matches!(reply, Reply::Woken { .. }), "{reply:?}");
    assert_eq!(lab.run(sandbox, &["get"]).await, ["alive"]);
    let view = lab.current(sandbox).await;
    assert!(view.unsavable && !view.broken, "{view:?}");
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1);
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 0);
    lab.assert_clean();
}

/// A sandbox recorded as remote whose eviction left local files behind has
/// them deleted on the next start; nothing relies on them.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn local_files_an_eviction_left_are_deleted_on_restart() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(46);
    lab.create(sandbox, SAVE_QUICKLY).await;
    lab.run(sandbox, &["set x"]).await;
    lab.wait_level(sandbox, LevelName::Saved).await;
    let dir = lab.sandbox_dir(sandbox);
    let (root, world) = lab.stop().await;
    // As if the eviction recorded the disk remote, then failed to delete.
    let path = dir.join("sandbox.json");
    let mut record: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    record["disk"] = "remote".into();
    std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    assert!(dir.join("root/disk.ext4").exists());

    let lab = Lab::start(root, world, Delays::default(), HostPolicy::default()).await;
    assert_eq!(lab.current(sandbox).await.level, LevelName::Remote);
    assert!(!dir.join("root/disk.ext4").exists());
    assert!(
        std::fs::read_dir(dir.join("images")).map_or(true, |entries| entries.count() == 0),
        "memory images are left"
    );
    lab.assert_clean();
}

/// A restart does not reset how long a sleeping sandbox has been idle, so
/// its retention clocks run on: a sandbox idle for almost its forget time
/// forgets its memory soon after the restart, not a full period later.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restart_keeps_how_long_a_sandbox_has_been_idle() {
    const FORGET_MS: u64 = 60_000;
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(47);
    let config = SleepConfig {
        forget_after_ms: Some(FORGET_MS),
        ..SAVE_QUICKLY
    };
    let unix_ms = || {
        u64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap()
    };
    lab.create(sandbox, config).await;
    let used = unix_ms();
    lab.run(sandbox, &["set x"]).await;
    lab.wait_level(sandbox, LevelName::Saved).await;
    let recorded = lab.record(sandbox)["last_used_ms"].as_u64().unwrap();
    assert!(
        (used..=unix_ms()).contains(&recorded),
        "the save recorded the last activity: {recorded} not after {used}"
    );
    let dir = lab.sandbox_dir(sandbox);
    let (root, world) = lab.stop().await;
    // As if its last activity were most of a forget period ago.
    let path = dir.join("sandbox.json");
    let mut record: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    record["last_used_ms"] = (unix_ms() - FORGET_MS + 500).into();
    std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();

    let lab = Lab::start(root, world, Delays::default(), HostPolicy::default()).await;
    lab.wait_until("the memory forgotten", |status| {
        !Lab::sandbox(status, sandbox).memory_saved
    })
    .await;
    assert_eq!(lab.run(sandbox, &["get"]).await, [""], "booted fresh");
    lab.assert_clean();
}

/// Creating a sandbox whose directory is already there is refused, and the
/// directory is left as it was.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn create_refuses_an_existing_directory() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(42);
    let dir = lab.sandbox_dir(sandbox);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("kept"), "kept").unwrap();
    let reply = lab
        .client
        .call(&Request::Create {
            id: sandbox,
            config: SandboxConfig {
                vcpus: 1,
                memory_mib: 256,
                sleep: NEVER,
            },
        })
        .await
        .unwrap();
    assert!(
        matches!(
            reply,
            Reply::Error {
                code: ErrorCode::Exists,
                ..
            }
        ),
        "{reply:?}"
    );
    assert_eq!(std::fs::read_to_string(dir.join("kept")).unwrap(), "kept");
    assert_eq!(lab.status().await.sandboxes.len(), 0, "nothing was created");
    lab.assert_clean();
}

/// A client that lost the reply to its create retries it: the same
/// settings find the sandbox already made, other settings are refused, and
/// either way there is one sandbox.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_repeated_create_succeeds_only_with_the_same_settings() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(43);
    let config = SandboxConfig {
        vcpus: 1,
        memory_mib: 256,
        sleep: NEVER,
    };
    let create = |config: SandboxConfig| Request::Create {
        id: sandbox,
        config,
    };
    for _ in 0..2 {
        let reply = lab.client.call(&create(config.clone())).await.unwrap();
        assert!(matches!(reply, Reply::Done), "{reply:?}");
    }
    let other = SandboxConfig {
        memory_mib: 512,
        ..config.clone()
    };
    let reply = lab.client.call(&create(other)).await.unwrap();
    assert!(
        matches!(
            reply,
            Reply::Error {
                code: ErrorCode::Exists,
                ..
            }
        ),
        "{reply:?}"
    );
    assert_eq!(lab.status().await.sandboxes.len(), 1);
    let reply = lab
        .client
        .call(&Request::Remove {
            id: sandbox,
            generation: None,
        })
        .await
        .unwrap();
    assert!(matches!(reply, Reply::Done), "{reply:?}");
    let reply = lab
        .client
        .call(&Request::Remove {
            id: sandbox,
            generation: None,
        })
        .await
        .unwrap();
    assert!(
        matches!(
            reply,
            Reply::Error {
                code: ErrorCode::NotFound,
                ..
            }
        ),
        "a repeated remove: {reply:?}"
    );
    lab.assert_clean();
}
