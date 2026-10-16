//! Sleeping and waking: what each level keeps, and how failures part way
//! are handled.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use compute_core::{HostPolicy, Step};
use compute_host::BusyRule;
use compute_host::protocol::{
    DurabilityName, HostStatus, Id, LevelName, PriorityName, Reply, Request, SleepConfig,
};
use tokio::time::{Instant, sleep};

use super::{Delays, Lab, NEVER, PAUSE_SOON, SAVE_IN_PLACE, SAVE_QUICKLY, id, thaw, vm_name};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sleeping_through_save_keeps_memory_and_disk() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(1);
    lab.create(sandbox, SAVE_QUICKLY).await;
    let first = lab
        .run(sandbox, &["set hello", "write on-disk", "get"])
        .await;
    assert_eq!(first, ["ok", "ok", "hello"]);

    lab.wait_level(sandbox, LevelName::Saved).await;
    assert!(lab.image(sandbox));
    assert!(
        lab.world.live.lock().unwrap().is_empty(),
        "a saved sandbox has no VM"
    );

    let again = lab.run(sandbox, &["get", "disk"]).await;
    assert_eq!(again, ["hello", "on-disk"]);
    assert!(
        !lab.image(sandbox),
        "a restored guest makes the old image stale"
    );
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1);
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 1);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_save_keeps_the_paused_vm_ready_to_resume() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(12);
    lab.create(sandbox, SAVE_IN_PLACE).await;
    assert_eq!(lab.run(sandbox, &["set hello"]).await, ["ok"]);
    let status = lab
        .wait_until("the save to finish", |status| {
            let view = Lab::sandbox(status, sandbox);
            view.durability == DurabilityName::Local && view.step.is_none()
        })
        .await;
    let view = Lab::sandbox(&status, sandbox);
    assert_eq!(view.level, LevelName::Paused);
    assert!(view.memory_saved);
    assert!(lab.image(sandbox));
    assert!(lab.world.live.lock().unwrap().contains(&vm_name(sandbox)));

    let resumes = lab.world.resumes.load(Ordering::SeqCst);
    assert_eq!(lab.run(sandbox, &["get"]).await, ["hello"]);
    assert_eq!(lab.world.resumes.load(Ordering::SeqCst), resumes + 1);
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 0);
    assert!(
        !lab.image(sandbox),
        "a resumed guest makes the saved image stale"
    );
    lab.assert_clean();
}

/// The memory file of the sandbox's current image, made writable.
fn current_image_memory(lab: &Lab, sandbox: Id) -> PathBuf {
    let images = lab.sandbox_dir(sandbox).join("images");
    let newest = std::fs::read_dir(&images)
        .unwrap()
        .filter_map(|entry| {
            let name = entry.unwrap().file_name().into_string().ok()?;
            Some((name.parse::<u64>().ok()?, name))
        })
        .max()
        .map(|(_, name)| name)
        .unwrap();
    let memory = images.join(newest).join("memory");
    let mut permissions = std::fs::metadata(&memory).unwrap().permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    permissions.set_readonly(false);
    std::fs::set_permissions(&memory, permissions).unwrap();
    memory
}

fn quarantined(lab: &Lab, sandbox: Id) -> Vec<String> {
    let dir = lab.sandbox_dir(sandbox).join("images/quarantine");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_restore_of_a_good_image_keeps_it_and_tries_again() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(17);
    lab.create(sandbox, SAVE_QUICKLY).await;
    lab.run(sandbox, &["set hello"]).await;
    lab.wait_level(sandbox, LevelName::Saved).await;

    // A VMM may refuse for reasons of the host's own, such as a pager that
    // could not start; the image itself is fine.
    *lab.world.refuse_restores.lock().unwrap() = 2;
    assert_eq!(lab.run(sandbox, &["get"]).await, ["hello"]);
    assert_eq!(*lab.world.refuse_restores.lock().unwrap(), 0);
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 1);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1, "never rebooted");
    assert_eq!(
        Lab::sandbox(&lab.status().await, sandbox).launches,
        4,
        "the boot, two VMMs that refused the image and the restore"
    );
    assert_eq!(quarantined(&lab, sandbox), Vec::<String>::new());
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_restore_of_a_damaged_image_quarantines_it() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(18);
    lab.create(sandbox, SAVE_QUICKLY).await;
    lab.run(sandbox, &["set hello", "write kept"]).await;
    lab.wait_level(sandbox, LevelName::Saved).await;

    // Damage only the memory: the quick check before a restore passes, and
    // only the full check the refusal triggers finds it.
    let memory = current_image_memory(&lab, sandbox);
    let mut bytes = std::fs::read(&memory).unwrap();
    bytes[0] ^= 0xff;
    std::fs::write(&memory, bytes).unwrap();
    *lab.world.refuse_restores.lock().unwrap() = 1;
    assert_eq!(
        lab.run(sandbox, &["get", "disk"]).await,
        ["", "kept"],
        "booted fresh from the files"
    );
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 2);
    let quarantined = quarantined(&lab, sandbox);
    assert!(
        quarantined.len() == 1 && quarantined[0].ends_with("-damaged"),
        "{quarantined:?}"
    );
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_crash_after_a_save_loses_nothing() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(13);
    lab.create(sandbox, SAVE_IN_PLACE).await;
    lab.run(sandbox, &["set hello", "write kept"]).await;
    lab.wait_until("the save to finish", |status| {
        Lab::sandbox(status, sandbox).durability == DurabilityName::Local
    })
    .await;
    lab.world.crash(&vm_name(sandbox));
    lab.wait_level(sandbox, LevelName::Saved).await;
    assert_eq!(lab.run(sandbox, &["get", "disk"]).await, ["hello", "kept"]);
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 1);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_resume_keeps_the_saved_copy_for_a_crash() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(15);
    lab.create(sandbox, SAVE_IN_PLACE).await;
    lab.run(sandbox, &["set hello", "write kept"]).await;
    lab.wait_until("the save to finish", |status| {
        let view = Lab::sandbox(status, sandbox);
        view.durability == DurabilityName::Local && view.step.is_none()
    })
    .await;

    lab.world.refuse_resumes.store(true, Ordering::SeqCst);
    let reply = lab
        .client
        .call(&Request::Touch {
            id: sandbox,
            generation: None,
            priority: PriorityName::Interactive,
        })
        .await
        .unwrap();
    assert_eq!(reply, Reply::Done);
    lab.wait_until("a refused resume", |status| {
        status
            .steps
            .iter()
            .any(|(name, stats)| name == "resume" && stats.failed > 0)
    })
    .await;
    let status = lab.status().await;
    let view = Lab::sandbox(&status, sandbox);
    assert_eq!(view.level, LevelName::Paused);
    assert_eq!(view.durability, DurabilityName::Local, "nothing changed");
    assert!(
        lab.image(sandbox),
        "the guest never ran, so its copy is still marked good"
    );

    // The VM dies before a retry gets through: the copy takes its place,
    // and a restore that is refused keeps it too.
    lab.world.crash(&vm_name(sandbox));
    lab.wait_until("a refused restore", |status| {
        status
            .steps
            .iter()
            .any(|(name, stats)| name == "restore" && stats.failed > 0)
    })
    .await;
    assert!(lab.image(sandbox));
    lab.world.refuse_resumes.store(false, Ordering::SeqCst);
    assert_eq!(lab.run(sandbox, &["get", "disk"]).await, ["hello", "kept"]);
    let restores = lab.world.restores.load(Ordering::Relaxed);
    assert!(restores >= 2);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1);
    assert_eq!(
        Lab::sandbox(&lab.status().await, sandbox).launches,
        u64::try_from(1 + restores).unwrap(),
        "a VM ended again after its resume was refused still counts"
    );
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_vm_that_breaks_down_has_ended_before_its_replacement_starts() {
    let delays = Delays {
        stop: Duration::from_millis(200),
        ..Delays::default()
    };
    let lab = Lab::new(delays, HostPolicy::default()).await;
    let sandbox = id(16);
    lab.create(sandbox, SAVE_IN_PLACE).await;
    lab.run(sandbox, &["set hello", "write kept"]).await;
    lab.wait_until("the save to finish", |status| {
        let view = Lab::sandbox(status, sandbox);
        view.durability == DurabilityName::Local && view.step.is_none()
    })
    .await;

    // The resume lets the guest run and loses track of the VM, whose
    // process takes a while to end. The fresh boot must wait for it.
    lab.world.lose_resumes.store(true, Ordering::SeqCst);
    assert_eq!(lab.run(sandbox, &["get", "disk"]).await, ["", "kept"]);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 2);
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 0);
    assert!(
        !lab.image(sandbox),
        "the guest ran, so the old copy is stale"
    );
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_resume_that_cannot_vouch_again_trusts_no_copy() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(17);
    lab.create(sandbox, SAVE_IN_PLACE).await;
    lab.run(sandbox, &["set hello", "write kept"]).await;
    lab.wait_until("the save to finish", |status| {
        let view = Lab::sandbox(status, sandbox);
        view.durability == DurabilityName::Local && view.step.is_none()
    })
    .await;

    lab.world.refuse_resumes.store(true, Ordering::SeqCst);
    lab.world.freeze_on_refusal.store(true, Ordering::SeqCst);
    let reply = lab
        .client
        .call(&Request::Touch {
            id: sandbox,
            generation: None,
            priority: PriorityName::Interactive,
        })
        .await
        .unwrap();
    assert_eq!(reply, Reply::Done);
    lab.wait_until("a refused resume", |status| {
        status
            .steps
            .iter()
            .any(|(name, stats)| name == "resume" && stats.failed > 0)
    })
    .await;
    lab.world.freeze_on_refusal.store(false, Ordering::SeqCst);
    let dir = lab.sandbox_dir(sandbox);
    if !lab.world.froze.load(Ordering::SeqCst) {
        // Root writes through read-only directories; nothing to test.
        thaw(&dir);
        return;
    }
    let status = lab.status().await;
    let view = Lab::sandbox(&status, sandbox);
    assert_eq!(view.level, LevelName::Paused, "the VM is intact");
    assert_eq!(
        view.durability,
        DurabilityName::Volatile,
        "no unmarked copy is trusted"
    );
    assert!(!lab.image(sandbox));

    thaw(&dir);
    lab.world.refuse_resumes.store(false, Ordering::SeqCst);
    assert_eq!(lab.run(sandbox, &["get", "disk"]).await, ["hello", "kept"]);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1);
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 0);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sleep_request_overrides_the_settings_until_the_next_wake() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(14);
    lab.create(sandbox, NEVER).await;
    lab.run(sandbox, &["set hello", "write kept"]).await;
    assert_eq!(lab.sleep_to(sandbox, LevelName::Saved).await, Reply::Done);
    lab.wait_level(sandbox, LevelName::Saved).await;
    assert!(lab.world.live.lock().unwrap().is_empty());
    assert_eq!(lab.run(sandbox, &["get", "disk"]).await, ["hello", "kept"]);

    // The wake cleared the request: a never-sleeping sandbox stays awake.
    sleep(Duration::from_millis(200)).await;
    let status = lab.status().await;
    assert_eq!(Lab::sandbox(&status, sandbox).level, LevelName::Running);

    // Without a store, nothing can be archived.
    let reply = lab.sleep_to(sandbox, LevelName::Archived).await;
    assert!(
        matches!(&reply, Reply::Error { message, .. } if message.contains("store")),
        "{reply:?}"
    );
    let reply = lab.sleep_to(id(99), LevelName::Paused).await;
    assert!(matches!(reply, Reply::Error { .. }), "{reply:?}");
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn work_inside_the_guest_keeps_it_awake() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(16);
    lab.create(sandbox, PAUSE_SOON).await;
    // The guest starts a background job and nobody is connected any more.
    assert_eq!(lab.run(sandbox, &["busy"]).await, ["ok"]);
    sleep(Duration::from_millis(800)).await;
    let status = lab.status().await;
    assert_eq!(
        Lab::sandbox(&status, sandbox).level,
        LevelName::Running,
        "a busy guest stays awake"
    );
    // The job ends; the sandbox goes idle and pauses.
    assert_eq!(lab.run(sandbox, &["quiet"]).await, ["ok"]);
    let quiet = Instant::now();
    lab.wait_level(sandbox, LevelName::Paused).await;
    assert!(quiet.elapsed() >= Duration::from_millis(200));
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn traffic_keeps_a_guest_awake_while_its_processor_idles() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(18);
    lab.create(sandbox, PAUSE_SOON).await;
    // A download in the background: data flows, the processor mostly waits.
    assert_eq!(lab.run(sandbox, &["stream"]).await, ["ok"]);
    sleep(Duration::from_millis(800)).await;
    let status = lab.status().await;
    assert_eq!(
        Lab::sandbox(&status, sandbox).level,
        LevelName::Running,
        "a guest moving data stays awake"
    );
    assert_eq!(lab.run(sandbox, &["still"]).await, ["ok"]);
    let still = Instant::now();
    lab.wait_level(sandbox, LevelName::Paused).await;
    assert!(still.elapsed() >= Duration::from_millis(200));
    lab.assert_clean();
}

/// Runs a background download in `sandbox` and checks the traffic alone
/// keeps it awake, then that it pauses once the traffic stops.
async fn check_traffic_keeps_awake(lab: &Lab, sandbox: Id) {
    lab.create(sandbox, PAUSE_SOON).await;
    assert_eq!(lab.run(sandbox, &["stream"]).await, ["ok"]);
    sleep(Duration::from_millis(800)).await;
    assert_eq!(
        Lab::sandbox(&lab.status().await, sandbox).level,
        LevelName::Running,
        "traffic alone keeps the guest awake"
    );
    assert_eq!(lab.run(sandbox, &["still"]).await, ["ok"]);
    lab.wait_level(sandbox, LevelName::Paused).await;
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn traffic_counts_when_processor_use_cannot_be_read() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    lab.world.unreadable_cpu.store(true, Ordering::SeqCst);
    check_traffic_keeps_awake(&lab, id(19)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rule_that_ignores_the_processor_still_counts_traffic() {
    let lab = Lab::start_configured(
        Lab::root(),
        Arc::default(),
        Delays::default(),
        HostPolicy::default(),
        |config| {
            config.busy = Some(BusyRule {
                cpu_percent: 0,
                io_bytes_per_second: 100_000,
                window: Duration::from_millis(100),
            });
        },
    )
    .await;
    check_traffic_keeps_awake(&lab, id(20)).await;
}

/// A pause and a wake that both fall between two readings: the data the
/// pause moved is the host's work, and must not keep the guest awake.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pause_and_wake_between_two_readings_is_not_guest_activity() {
    const EVERY: Duration = Duration::from_millis(400);
    const PAUSE_AFTER: Duration = Duration::from_millis(1_000);
    let lab = Lab::start_configured(
        Lab::root(),
        Arc::default(),
        Delays::default(),
        HostPolicy::default(),
        |config| {
            config.sample_every = EVERY;
            // Shorter than a reading's interval: each reading judges the
            // traffic since the one before.
            config.busy = Some(BusyRule {
                cpu_percent: 50,
                io_bytes_per_second: 100_000,
                window: Duration::from_millis(1),
            });
        },
    )
    .await;
    let sandbox = id(21);
    let pause_after_ms = u64::try_from(PAUSE_AFTER.as_millis()).unwrap();
    lab.create(
        sandbox,
        SleepConfig {
            pause_after_ms: Some(pause_after_ms),
            ..NEVER
        },
    )
    .await;
    assert_eq!(lab.run(sandbox, &["quiet"]).await, ["ok"]);
    lab.world.transition_traffic.store(true, Ordering::SeqCst);

    // Right after a reading, pause and wake again well before the next.
    let seen = lab.world.samples.load(Ordering::SeqCst);
    while lab.world.samples.load(Ordering::SeqCst) == seen {
        sleep(Duration::from_millis(1)).await;
    }
    let window = Instant::now();
    assert_eq!(lab.sleep_to(sandbox, LevelName::Paused).await, Reply::Done);
    lab.wait_level(sandbox, LevelName::Paused).await;
    assert_eq!(lab.run(sandbox, &["quiet"]).await, ["ok"]);
    let woke = Instant::now();
    assert!(
        woke - window < EVERY / 2,
        "the pause and wake took {:?}, too long to fall between readings",
        woke - window
    );

    // Had the pause's traffic counted, the next reading would have found
    // the guest busy and put its pause off past this.
    lab.wait_level(sandbox, LevelName::Paused).await;
    let idle = woke.elapsed();
    assert!(
        idle < PAUSE_AFTER + EVERY / 2,
        "paused {idle:?} after the wake, later than its {PAUSE_AFTER:?} idle allowance"
    );
    lab.assert_clean();
}

#[test]
fn the_busy_rule_counts_processor_use_or_traffic() {
    let rule = BusyRule {
        cpu_percent: 25,
        io_bytes_per_second: 4096,
        window: Duration::from_secs(5),
    };
    let five = Duration::from_secs(5);
    let cpu = |millis| Duration::from_millis(millis);
    assert!(!rule.is_busy(cpu(0), 0, five), "an idle guest");
    assert!(rule.is_busy(cpu(1250), 0, five), "a quarter of a processor");
    assert!(!rule.is_busy(cpu(1249), 0, five));
    assert!(rule.is_busy(cpu(0), 5 * 4096, five), "4 KiB a second");
    assert!(!rule.is_busy(cpu(0), 5 * 4096 - 1, five));
    assert!(
        !rule.is_busy(cpu(5000), u64::MAX, Duration::ZERO),
        "no time passed"
    );
    let processor_only = BusyRule {
        io_bytes_per_second: 0,
        ..rule
    };
    assert!(!processor_only.watches_io());
    assert!(!processor_only.is_busy(cpu(0), u64::MAX, five));
    let traffic_only = BusyRule {
        cpu_percent: 0,
        ..rule
    };
    assert!(!traffic_only.is_busy(cpu(5000), 0, five));
    assert!(traffic_only.is_busy(cpu(0), u64::MAX, five));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_named_hold_wakes_a_sandbox_and_keeps_it_awake_until_it_lapses() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(17);
    lab.create(sandbox, PAUSE_SOON).await;
    let hold = |ttl_ms| Request::Hold {
        id: sandbox,
        generation: None,
        hold: "turn".into(),
        ttl_ms,
        priority: PriorityName::Interactive,
    };
    let started = Instant::now();
    assert_eq!(
        lab.client.call(&hold(Some(600))).await.unwrap(),
        Reply::Done
    );
    // Holding wakes it: a turn starting is a good moment to boot.
    lab.wait_level(sandbox, LevelName::Running).await;
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1);
    sleep(Duration::from_millis(450)).await;
    let status = lab.status().await;
    assert_eq!(Lab::sandbox(&status, sandbox).level, LevelName::Running);
    assert_eq!(Lab::sandbox(&status, sandbox).holds, 1);
    // Nobody refreshed it: it lapses, and the idle clock runs from there.
    lab.wait_level(sandbox, LevelName::Paused).await;
    assert!(
        started.elapsed() >= Duration::from_millis(800),
        "{:?}",
        started.elapsed()
    );

    // A hold without expiry lasts until released.
    assert_eq!(lab.client.call(&hold(None)).await.unwrap(), Reply::Done);
    lab.wait_level(sandbox, LevelName::Running).await;
    sleep(Duration::from_millis(400)).await;
    let status = lab.status().await;
    assert_eq!(Lab::sandbox(&status, sandbox).level, LevelName::Running);
    let release = Request::Release {
        id: sandbox,
        generation: None,
        hold: "turn".into(),
    };
    assert_eq!(lab.client.call(&release).await.unwrap(), Reply::Done);
    lab.wait_level(sandbox, LevelName::Paused).await;

    let missing = Request::Release {
        id: id(98),
        generation: None,
        hold: "turn".into(),
    };
    let reply = lab.client.call(&missing).await.unwrap();
    assert!(matches!(reply, Reply::Error { .. }), "{reply:?}");
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_host_that_cannot_compress_refuses_to() {
    let lab = Lab::start_configured(
        Lab::root(),
        Arc::default(),
        Delays::default(),
        HostPolicy::default(),
        |config| config.can_compress = false,
    )
    .await;
    let sandbox = id(18);
    let compressible = SleepConfig {
        compress: true,
        ..PAUSE_SOON
    };
    lab.create(sandbox, compressible).await;
    lab.run(sandbox, &["set x"]).await;
    let reply = lab.sleep_to(sandbox, LevelName::Compressed).await;
    assert!(
        matches!(&reply, Reply::Error { message, .. } if message.contains("compress")),
        "{reply:?}"
    );
    assert_eq!(lab.sleep_to(sandbox, LevelName::Paused).await, Reply::Done);
    lab.wait_level(sandbox, LevelName::Paused).await;
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn forgetting_memory_keeps_the_files() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(15);
    let forget_soon = SleepConfig {
        forget_after_ms: Some(150),
        ..SAVE_QUICKLY
    };
    lab.create(sandbox, forget_soon).await;
    lab.run(sandbox, &["set hello", "write kept"]).await;
    lab.wait_until("the memory image to be forgotten", |status| {
        let view = Lab::sandbox(status, sandbox);
        view.level == LevelName::Saved && !view.memory_saved && view.step.is_none()
    })
    .await;
    assert!(!lab.image(sandbox));
    assert_eq!(lab.run(sandbox, &["get", "disk"]).await, ["", "kept"]);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 2);
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 0);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_burst_of_wakes_respects_the_restore_limit() {
    let policy = HostPolicy {
        limits: HostPolicy::default().limits.with(Step::Restore, 8),
        ..HostPolicy::default()
    };
    let delays = Delays {
        restore: Duration::from_millis(20),
        ..Delays::default()
    };
    let lab = Arc::new(Lab::new(delays, policy).await);
    let ids: Vec<Id> = (0..60).map(id).collect();
    for (n, sandbox) in ids.iter().enumerate() {
        lab.create(*sandbox, SAVE_QUICKLY).await;
        let value = format!("set v{n}");
        lab.run(*sandbox, &[&value]).await;
    }
    for sandbox in &ids {
        lab.wait_level(*sandbox, LevelName::Saved).await;
    }
    let started = Instant::now();
    let mut wakes = tokio::task::JoinSet::new();
    for (n, sandbox) in ids.iter().enumerate() {
        let (lab, sandbox) = (Arc::clone(&lab), *sandbox);
        wakes.spawn(async move { (n, lab.run(sandbox, &["get"]).await) });
    }
    while let Some(result) = wakes.join_next().await {
        let (n, output) = result.unwrap();
        assert_eq!(output, [format!("v{n}")]);
    }
    let elapsed = started.elapsed();
    let max = lab.world.max_restoring.load(Ordering::SeqCst);
    assert!(max <= 8, "{max} restores ran at once");
    assert!(max >= 4, "restores were not concurrent: {max}");
    // 60 restores of 20 ms, 8 at a time, need at least 8 rounds.
    assert!(elapsed >= Duration::from_millis(140), "{elapsed:?}");
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_crash_loses_memory_but_keeps_files() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(2);
    lab.create(sandbox, NEVER).await;
    lab.run(sandbox, &["set hello", "write kept"]).await;
    lab.world.crash(&vm_name(sandbox));
    lab.wait_until("the crash to be noticed", |status| {
        status.sandboxes[0].level == LevelName::Saved && !status.sandboxes[0].memory_saved
    })
    .await;
    let after = lab.run(sandbox, &["get", "disk"]).await;
    assert_eq!(after, ["", "kept"]);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 2);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_wake_interrupts_compression() {
    let delays = Delays {
        compress: Duration::from_secs(5),
        ..Delays::default()
    };
    let lab = Lab::new(delays, HostPolicy::default()).await;
    let sandbox = id(3);
    let compressible = SleepConfig {
        pause_after_ms: Some(20),
        compress: true,
        ..NEVER
    };
    lab.create(sandbox, compressible).await;
    lab.run(sandbox, &["set warm"]).await;
    lab.wait_level(sandbox, LevelName::Paused).await;
    assert_eq!(
        lab.sleep_to(sandbox, LevelName::Compressed).await,
        Reply::Done
    );
    lab.wait_until("compression to start", |status| {
        status.sandboxes[0].step.as_deref() == Some("compress")
    })
    .await;
    let started = Instant::now();
    assert_eq!(lab.run(sandbox, &["get"]).await, ["warm"]);
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(lab.world.compress_cancelled.load(Ordering::Relaxed), 1);
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 0);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_wake_during_save_resumes_the_paused_vm() {
    let delays = Delays {
        snapshot: Duration::from_millis(300),
        ..Delays::default()
    };
    let lab = Lab::new(delays, HostPolicy::default()).await;
    let sandbox = id(4);
    lab.create(sandbox, SAVE_IN_PLACE).await;
    lab.run(sandbox, &["set warm"]).await;
    lab.wait_until("the save to start", |status| {
        status.sandboxes[0].step.as_deref() == Some("save")
    })
    .await;
    assert_eq!(lab.run(sandbox, &["get"]).await, ["warm"]);
    assert_eq!(
        lab.world.restores.load(Ordering::Relaxed),
        0,
        "no restore needed"
    );
    assert!(
        !lab.image(sandbox),
        "a cancelled save must not leave a valid-looking image"
    );
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_wake_names_the_step_it_met_and_concurrent_wakes_share_one_restore() {
    let delays = Delays {
        snapshot: Duration::from_millis(300),
        restore: Duration::from_millis(100),
        ..Delays::default()
    };
    let lab = Arc::new(Lab::new(delays, HostPolicy::default()).await);
    let sandbox = id(13);
    let launches = |status: &HostStatus| Lab::sandbox(status, sandbox).launches;
    lab.create(sandbox, NEVER).await;
    assert_eq!(launches(&lab.status().await), 0, "creating costs no VM");
    assert_eq!(lab.run(sandbox, &["set warm"]).await, ["ok"]);
    assert_eq!(launches(&lab.status().await), 1, "the first use boots it");

    // A wake that arrives while the memory is being saved says so, and
    // resumes the paused VM instead of starting another.
    assert_eq!(lab.sleep_to(sandbox, LevelName::Saved).await, Reply::Done);
    lab.wait_until("the save to start", |status| {
        Lab::sandbox(status, sandbox).step.as_deref() == Some("save")
    })
    .await;
    let reply = lab.wake(sandbox).await;
    assert!(
        matches!(&reply, Reply::Woken { during: Some(step), .. } if step == "save"),
        "{reply:?}"
    );
    assert_eq!(launches(&lab.status().await), 1);

    // Sixteen wakes of a sandbox saved to disk share one restored VM.
    assert_eq!(lab.sleep_to(sandbox, LevelName::Saved).await, Reply::Done);
    lab.wait_level(sandbox, LevelName::Saved).await;
    let mut wakes = tokio::task::JoinSet::new();
    for _ in 0..16 {
        let lab = Arc::clone(&lab);
        wakes.spawn(async move { lab.wake(sandbox).await });
    }
    while let Some(reply) = wakes.join_next().await {
        let reply = reply.unwrap();
        assert!(matches!(reply, Reply::Woken { .. }), "{reply:?}");
    }
    assert_eq!(launches(&lab.status().await), 2, "one restore served all");
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 1);
    assert_eq!(lab.run(sandbox, &["get"]).await, ["warm"]);
    lab.assert_clean();
}

/// A launch that failed and could not prove that the VMM it may have
/// started is gone leaves the sandbox broken: nothing is launched beside a
/// VMM that may still run on its disk.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_launch_that_could_not_clean_up_is_never_retried() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(31);
    lab.create(sandbox, NEVER).await;
    lab.world.stuck_boots.store(true, Ordering::SeqCst);
    let reply = lab.wake(sandbox).await;
    assert!(!matches!(reply, Reply::Woken { .. }), "{reply:?}");
    sleep(Duration::from_millis(500)).await;
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1, "launched again");
    assert!(lab.current(sandbox).await.broken);
    let _ = lab.wake(sandbox).await;
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1, "launched again");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_late_exit_notice_is_not_blamed_on_a_new_vm() {
    let delays = Delays {
        snapshot: Duration::from_millis(100),
        exit_notice: Duration::from_millis(300),
        ..Delays::default()
    };
    let lab = Lab::new(delays, HostPolicy::default()).await;
    let sandbox = id(9);
    lab.create(sandbox, SAVE_QUICKLY).await;
    lab.run(sandbox, &["set old"]).await;
    lab.wait_until("the save to start", |status| {
        status.sandboxes[0].step.as_deref() == Some("save")
    })
    .await;
    // The VM dies mid-save; the save fails and the host learns of the exit
    // from the failed step long before the exit notice itself arrives.
    lab.world.crash(&vm_name(sandbox));
    assert_eq!(lab.run(sandbox, &["get", "set new"]).await, ["", "ok"]);
    sleep(Duration::from_millis(500)).await;
    assert_eq!(
        lab.run(sandbox, &["get"]).await,
        ["new"],
        "the new VM was blamed"
    );
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 2);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn remove_waits_for_a_running_save_and_deletes_everything() {
    let delays = Delays {
        snapshot: Duration::from_millis(200),
        ..Delays::default()
    };
    let lab = Lab::new(delays, HostPolicy::default()).await;
    let sandbox = id(5);
    lab.create(sandbox, SAVE_QUICKLY).await;
    lab.run(sandbox, &["set x"]).await;
    lab.wait_until("the save to start", |status| {
        status.sandboxes[0].step.as_deref() == Some("save")
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
    assert!(!lab.sandbox_dir(sandbox).exists());
    assert!(lab.world.live.lock().unwrap().is_empty());
    assert_eq!(lab.status().await.sandboxes.len(), 0);
    // The id is free again.
    lab.create(sandbox, NEVER).await;
    assert_eq!(lab.run(sandbox, &["get"]).await, [""]);
    lab.assert_clean();
}
