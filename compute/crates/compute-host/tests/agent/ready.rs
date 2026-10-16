//! Ready sandboxes: restored, warmed and paused ahead of any create, and
//! claimed by one with a single record write.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use tokio::time::sleep;

use compute_core::HostPolicy;
use compute_host::protocol::{
    DurabilityName, HostStatus, Id, LevelName, Reply, Request, SandboxConfig, SleepConfig,
    TemplateState,
};
use compute_host::{HostConfig, PoolConfig, Shape};

use super::{Delays, Lab, NEVER, World, id};

/// The shape [`Lab::create`] gives every sandbox.
const SHAPE: Shape = Shape {
    vcpus: 1,
    memory_mib: 256,
};

fn keeping(ready: u32) -> impl FnOnce(&mut HostConfig) {
    keeping_for(ready, PoolConfig::UNUSED_AFTER)
}

/// [`keeping`], giving the shape up after `unused_after` without a create.
fn keeping_for(ready: u32, unused_after: Duration) -> impl FnOnce(&mut HostConfig) {
    move |config| {
        config.restore_notice_port = Some(53);
        config.pool = Some(PoolConfig {
            ready_port: 52,
            shapes: vec![SHAPE],
            depends_on: Vec::new(),
            ready_timeout: Duration::from_secs(5),
            ready: BTreeMap::from([(SHAPE, ready)]),
            unused_after,
        });
    }
}

async fn ready_lab(root: PathBuf, world: Arc<World>, ready: u32) -> Lab {
    Lab::start_configured(
        root,
        world,
        Delays::default(),
        HostPolicy::default(),
        keeping(ready),
    )
    .await
}

/// Ready, filling and target counts of [`SHAPE`].
fn pool(status: &HostStatus) -> (u32, u32, u32) {
    status
        .templates
        .iter()
        .find(|template| (template.vcpus, template.memory_mib) == (SHAPE.vcpus, SHAPE.memory_mib))
        .map_or((0, 0, 0), |template| {
            (template.ready, template.filling, template.target)
        })
}

async fn wait_filled(lab: &Lab, ready: u32) {
    lab.wait_until(&format!("{ready} ready sandboxes"), |status| {
        pool(status) == (ready, 0, ready)
    })
    .await;
}

/// Every sandbox directory, with the id its record answers to.
fn directories(lab: &Lab) -> BTreeMap<String, Option<String>> {
    std::fs::read_dir(lab.root.join("state/vm/firecracker"))
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| {
            let record = std::fs::read(entry.path().join("sandbox.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
            (
                entry.file_name().to_string_lossy().into_owned(),
                record.and_then(|record| record["id"].as_str().map(str::to_owned)),
            )
        })
        .collect()
}

/// The directory whose record answers to `sandbox`, and the record.
fn record_of(lab: &Lab, sandbox: Id) -> (String, serde_json::Value) {
    let (dir, _) = directories(lab)
        .into_iter()
        .find(|(_, answers)| answers.as_deref() == Some(sandbox.to_string().as_str()))
        .unwrap_or_else(|| panic!("no record for {sandbox}"));
    let path = lab.root.join("state/vm/firecracker").join(&dir);
    let record = serde_json::from_slice(&std::fs::read(path.join("sandbox.json")).unwrap());
    (dir, record.unwrap())
}

/// Directories of unclaimed ready sandboxes.
fn ready_dirs(lab: &Lab) -> Vec<String> {
    directories(lab)
        .into_iter()
        .filter(|(dir, answers)| answers.as_deref() == Some(dir.as_str()))
        .filter(|(dir, _)| {
            // One being removed meanwhile is not ready.
            let path = lab.root.join("state/vm/firecracker").join(dir);
            std::fs::read(path.join("sandbox.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                .is_some_and(|record| record["ready"] == true)
        })
        .map(|(dir, _)| dir)
        .collect()
}

async fn create(lab: &Lab, sandbox: Id) -> Reply {
    let config = SandboxConfig {
        vcpus: SHAPE.vcpus,
        memory_mib: SHAPE.memory_mib,
        sleep: NEVER,
    };
    lab.client
        .call(&Request::Create {
            id: sandbox,
            config,
        })
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_create_claims_a_ready_sandbox_that_learns_its_id_before_use() {
    let lab = ready_lab(Lab::root(), Arc::default(), 3).await;
    wait_filled(&lab, 3).await;
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1, "the template");
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 3, "the fills");
    let filled = ready_dirs(&lab);
    assert_eq!(filled.len(), 3);
    let held: Vec<u64> = lab
        .status()
        .await
        .templates
        .iter()
        .map(|template| template.ready_resident_bytes)
        .collect();
    assert_eq!(held, [3 * (100 << 20)], "what the ready sandboxes hold");

    lab.create(id(1), NEVER).await;
    assert_eq!(
        lab.world.restores.load(Ordering::Relaxed),
        3,
        "the claim restored nothing"
    );
    assert_eq!(lab.current(id(1)).await.level, LevelName::Paused);
    let (dir, record) = record_of(&lab, id(1));
    assert_eq!(
        record["image"], false,
        "its disk moved on since the template"
    );
    assert!(
        filled.contains(&dir),
        "it kept the directory it was filled in"
    );
    assert_eq!(record["host"], dir.as_str());
    assert_eq!(record["identity"], "pending");
    assert!(record.get("ready").is_none());

    // Its first command waits for the guest to acknowledge its own id.
    assert_eq!(lab.run(id(1), &["sandbox?"]).await, [id(1).to_string()]);
    assert_eq!(record_of(&lab, id(1)).1["identity"], "known");
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 3);

    // Each claim takes another; the pool fills again.
    lab.create(id(2), NEVER).await;
    assert_eq!(lab.run(id(2), &["sandbox?"]).await, [id(2).to_string()]);
    // Each claim's notice was ordered after its fill's.
    assert_eq!(lab.world.notices_out_of_order.load(Ordering::Relaxed), 0);
    assert_eq!(
        lab.run(id(1), &["write mine", "disk"]).await,
        ["ok", "mine"]
    );
    assert_eq!(lab.run(id(2), &["disk"]).await, ["base"], "disks apart");
    wait_filled(&lab, 3).await;

    // The names a claim keeps are taken: no new sandbox may use them.
    let host: Id = dir.parse().unwrap();
    assert!(matches!(create(&lab, host).await, Reply::Error { .. }));
    let ready: Id = ready_dirs(&lab)[0].parse().unwrap();
    assert!(matches!(create(&lab, ready).await, Reply::Error { .. }));

    // Removing a claimed sandbox removes what its host name holds.
    let removed = lab
        .client
        .call(&Request::Remove {
            id: id(1),
            generation: None,
        })
        .await
        .unwrap();
    assert_eq!(removed, Reply::Done);
    assert!(!directories(&lab).contains_key(&dir));
    lab.assert_clean();
}

/// A claim gives its id a generation it never had: an id removed and
/// created again from another ready sandbox, filled before the removal,
/// never comes back at a generation requests to its old self named.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_claim_never_gives_an_id_a_generation_it_had() {
    let lab = ready_lab(Lab::root(), Arc::default(), 2).await;
    wait_filled(&lab, 2).await;
    let generation = |lab: &Lab| record_of(lab, id(1)).1["generation"].as_u64().unwrap();
    lab.create(id(1), NEVER).await;
    let first = generation(&lab);
    let removed = lab
        .client
        .call(&Request::Remove {
            id: id(1),
            generation: None,
        })
        .await
        .unwrap();
    assert_eq!(removed, Reply::Done);
    lab.create(id(1), NEVER).await;
    let (dir, record) = record_of(&lab, id(1));
    assert_ne!(dir, id(1).to_string(), "it claimed a ready sandbox");
    assert!(record["generation"].as_u64().unwrap() > first);
    // A request issued to its old self is refused.
    let stale = lab
        .client
        .call(&Request::Remove {
            id: id(1),
            generation: Some(first),
        })
        .await
        .unwrap();
    assert!(matches!(stale, Reply::Error { .. }), "{stale:?}");
    lab.assert_clean();
}

/// A host whose sandbox numbers run out keeps the ready sandboxes it could
/// fill, and keeps answering.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn running_out_of_sandbox_numbers_stops_filling_and_nothing_else() {
    let lab = Lab::start_configured(
        Lab::root(),
        Arc::default(),
        Delays::default(),
        HostPolicy::default(),
        |config| {
            keeping(5)(config);
            // Users for sandbox numbers 0 to 2 only.
            config.first_uid = u32::MAX - 3;
        },
    )
    .await;
    lab.wait_until("three ready sandboxes, and no more", |status| {
        pool(status) == (3, 0, 5)
    })
    .await;
    sleep(Duration::from_millis(300)).await;
    assert_eq!(pool(&lab.status().await), (3, 0, 5));
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ready_sandboxes_go_with_a_stale_template_and_the_create_boots() {
    let lab = ready_lab(Lab::root(), Arc::default(), 2).await;
    wait_filled(&lab, 2).await;
    let stale = ready_dirs(&lab);

    std::fs::write(lab.root.join("base.img"), "base two").unwrap();
    lab.create(id(1), NEVER).await;
    assert_eq!(
        lab.run(id(1), &["sandbox?", "disk"]).await,
        ["", "base two"],
        "booted from today's image, its id on its command line"
    );
    assert_eq!(record_of(&lab, id(1)).0, id(1).to_string());

    // A new template, and ready sandboxes cloned from it.
    wait_filled(&lab, 2).await;
    let fresh = ready_dirs(&lab);
    assert!(
        fresh.iter().all(|dir| !stale.contains(dir)),
        "{stale:?} {fresh:?}"
    );
    lab.create(id(2), NEVER).await;
    assert_eq!(
        lab.run(id(2), &["sandbox?", "disk"]).await,
        [id(2).to_string(), "base two".to_owned()]
    );
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restart_removes_ready_sandboxes_and_keeps_claimed_ones() {
    let lab = ready_lab(Lab::root(), Arc::default(), 3).await;
    wait_filled(&lab, 3).await;
    // One claimed and used, one claimed and never woken.
    lab.create(id(1), NEVER).await;
    assert_eq!(
        lab.run(id(1), &["set kept", "sandbox?"]).await,
        ["ok".to_owned(), id(1).to_string()]
    );
    lab.create(id(2), NEVER).await;
    wait_filled(&lab, 3).await;
    let before = ready_dirs(&lab);
    let hosts = [record_of(&lab, id(1)).0, record_of(&lab, id(2)).0];
    let (root, world) = lab.stop().await;

    let lab = ready_lab(root, world, 3).await;
    wait_filled(&lab, 3).await;
    let after = ready_dirs(&lab);
    assert!(
        after.iter().all(|dir| !before.contains(dir)),
        "all refilled"
    );
    for dir in &before {
        assert!(!lab.world.live.lock().unwrap().contains(dir), "{dir} ended");
    }

    // The used one kept running with its programs; the other is still
    // paused and learns its id on its first resume.
    assert_eq!(lab.current(id(1)).await.level, LevelName::Running);
    assert_eq!(lab.run(id(1), &["get"]).await, ["kept"]);
    assert_eq!(lab.current(id(2)).await.level, LevelName::Paused);
    assert_eq!(lab.run(id(2), &["sandbox?"]).await, [id(2).to_string()]);
    assert_eq!([record_of(&lab, id(1)).0, record_of(&lab, id(2)).0], hosts);
    let host: Id = hosts[1].parse().unwrap();
    assert!(matches!(create(&lab, host).await, Reply::Error { .. }));
    lab.assert_clean();
}

/// A ready sandbox kept long before its claim is idle only from the claim:
/// an agent restarted before its first wake does not find it overdue.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_claimed_sandbox_is_idle_from_its_claim_across_a_restart() {
    // Wide enough that a restart on a loaded host fits well inside the save
    // time, and the fill is older than it.
    const SAVE_SOON: SleepConfig = SleepConfig {
        pause_after_ms: Some(100),
        save_after_ms: Some(4_000),
        ..NEVER
    };
    let lab = ready_lab(Lab::root(), Arc::default(), 1).await;
    wait_filled(&lab, 1).await;
    // Older than the policy allows before the claim.
    sleep(Duration::from_millis(5_000)).await;
    let before = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    lab.create(id(1), SAVE_SOON).await;
    let used = record_of(&lab, id(1)).1["last_used_ms"].as_u64().unwrap();
    assert!(
        u128::from(used) >= before,
        "the record keeps the fill's last use"
    );
    let claimed = std::time::Instant::now();
    let (root, world) = lab.stop().await;

    let lab = ready_lab(root, world, 1).await;
    sleep(Duration::from_millis(500)).await;
    let view = lab.current(id(1)).await;
    assert!(
        claimed.elapsed() < Duration::from_secs(3),
        "the restart took too long"
    );
    assert_eq!(
        (view.level, view.durability),
        (LevelName::Paused, DurabilityName::Volatile),
        "saved at once, as if idle since its fill: {view:?}"
    );
    // Its own idle time still saves it.
    lab.wait_until("saved once idle", |status| {
        Lab::sandbox(status, id(1)).durability == DurabilityName::Local
    })
    .await;
    assert_eq!(lab.run(id(1), &["sandbox?"]).await, [id(1).to_string()]);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_ready_sandbox_whose_vm_dies_is_replaced() {
    let lab = ready_lab(Lab::root(), Arc::default(), 2).await;
    wait_filled(&lab, 2).await;
    let dead = ready_dirs(&lab).remove(0);
    lab.world.crash(&dead);
    lab.wait_until("the dead one replaced", |status| {
        pool(status) == (2, 0, 2) && !directories_of(status, &lab).contains(&dead)
    })
    .await;
    lab.create(id(1), NEVER).await;
    assert_eq!(lab.run(id(1), &["sandbox?"]).await, [id(1).to_string()]);
    lab.assert_clean();
}

/// [`ready_dirs`], for use in a status predicate.
fn directories_of(_: &HostStatus, lab: &Lab) -> Vec<String> {
    ready_dirs(lab)
}

/// [`SHAPE`]'s template state.
fn template_state(status: &HostStatus) -> Option<TemplateState> {
    status
        .templates
        .iter()
        .find(|template| (template.vcpus, template.memory_mib) == (SHAPE.vcpus, SHAPE.memory_mib))
        .map(|template| template.state)
}

/// The template directories on disk.
fn template_dirs(lab: &Lab) -> Vec<String> {
    std::fs::read_dir(lab.root.join("state/templates"))
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name != "used" && name != "vm")
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unused_shape_gives_up_its_template_and_ready_sandboxes_until_its_next_create() {
    // Long enough for a template build and both fills to finish inside it
    // while the other tests load the host's disk.
    const UNUSED: Duration = Duration::from_secs(5);
    let start = |root, world| {
        Lab::start_configured(
            root,
            world,
            Delays::default(),
            HostPolicy::default(),
            keeping_for(2, UNUSED),
        )
    };
    let lab = start(Lab::root(), Arc::default()).await;
    wait_filled(&lab, 2).await;
    let filled = ready_dirs(&lab);
    assert_eq!(template_dirs(&lab).len(), 1);

    // No create for the whole period: the template and the ready
    // sandboxes go, and nothing fills again.
    lab.wait_until("the shape retired", |status| {
        template_state(status) == Some(TemplateState::Retired) && pool(status) == (0, 0, 2)
    })
    .await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !ready_dirs(&lab).is_empty() || !template_dirs(&lab).is_empty() {
        assert!(tokio::time::Instant::now() < deadline, "retired files left");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    for dir in &filled {
        assert!(!lab.world.live.lock().unwrap().contains(dir), "{dir} ended");
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(pool(&lab.status().await), (0, 0, 2), "no refill");
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1, "no rebuild");

    // A restart remembers when the shape was last used: still retired.
    let (root, world) = lab.stop().await;
    let lab = start(root, world).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let status = lab.status().await;
    assert_eq!(template_state(&status), Some(TemplateState::Retired));
    assert_eq!(pool(&status), (0, 0, 2));
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1, "no rebuild");

    // Its next create starts without the template, which comes back with
    // its ready sandboxes.
    lab.create(id(1), NEVER).await;
    wait_filled(&lab, 2).await;
    assert_eq!(
        template_state(&lab.status().await),
        Some(TemplateState::Ready)
    );
    assert_eq!(lab.run(id(1), &["disk"]).await, ["base"]);
    lab.assert_clean();
}
