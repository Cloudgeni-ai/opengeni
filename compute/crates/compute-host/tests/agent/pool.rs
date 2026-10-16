//! Warm templates: new sandboxes restore a booted guest instead of booting.

use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use compute_core::HostPolicy;
use compute_host::protocol::{HostStatus, Id, LevelName, Reply, TemplateState};
use compute_host::{HostConfig, PoolConfig, Shape};
use tokio::time::{Instant, sleep};

use super::{Delays, Lab, NEVER, World, id, vm_name};

/// The shape [`Lab::create`] gives every sandbox.
const SHAPE: Shape = Shape {
    vcpus: 1,
    memory_mib: 256,
};

fn warm(shapes: Vec<Shape>) -> impl FnOnce(&mut HostConfig) {
    move |config| {
        config.restore_notice_port = Some(53);
        config.pool = Some(PoolConfig {
            ready_port: 52,
            shapes,
            depends_on: Vec::new(),
            ready_timeout: Duration::from_secs(5),
            ready: std::collections::BTreeMap::new(),
            unused_after: PoolConfig::UNUSED_AFTER,
        });
    }
}

async fn warm_lab(root: PathBuf, world: Arc<World>, delays: Delays, shapes: Vec<Shape>) -> Lab {
    Lab::start_configured(root, world, delays, HostPolicy::default(), warm(shapes)).await
}

fn template_state(status: &HostStatus) -> Option<TemplateState> {
    status
        .templates
        .iter()
        .find(|template| (template.vcpus, template.memory_mib) == (SHAPE.vcpus, SHAPE.memory_mib))
        .map(|template| template.state)
}

async fn wait_ready(lab: &Lab) {
    lab.wait_until("a ready template", |status| {
        template_state(status) == Some(TemplateState::Ready)
    })
    .await;
}

/// The directories of every ready template.
fn templates(root: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(root.join("state/templates"))
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| !["vm", "used"].contains(&path.file_name().unwrap().to_str().unwrap()))
        .collect();
    found.sort();
    found
}

/// The memory file of the only image in `images`.
fn image_memory(images: &Path) -> PathBuf {
    let current = std::fs::read_to_string(images.join("current")).unwrap();
    images.join(current.trim()).join("memory")
}

fn memory_saved(status: &HostStatus, sandbox: Id) -> bool {
    Lab::sandbox(status, sandbox).memory_saved
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn new_sandboxes_restore_the_template_and_learn_who_they_are() {
    let lab = warm_lab(Lab::root(), Arc::default(), Delays::default(), vec![SHAPE]).await;
    wait_ready(&lab).await;
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1, "the template");
    assert!(
        lab.world.live.lock().unwrap().is_empty(),
        "the template's VM has ended"
    );
    let template = templates(&lab.root).pop().unwrap();

    let sandboxes = [id(1), id(2), id(3)];
    for sandbox in sandboxes {
        lab.create(sandbox, NEVER).await;
        let status = lab.status().await;
        let view = Lab::sandbox(&status, sandbox);
        assert_eq!(view.level, LevelName::Saved);
        assert!(
            view.memory_saved,
            "a template's sandbox holds a memory image"
        );
        // Its image is the template's own file: one page cache for all.
        let inode = |path: PathBuf| std::fs::metadata(path).unwrap().ino();
        assert_eq!(
            inode(image_memory(&lab.sandbox_dir(sandbox).join("images"))),
            inode(image_memory(&template.join("images")))
        );
    }
    for sandbox in sandboxes {
        assert_eq!(
            lab.run(sandbox, &["sandbox?"]).await,
            [sandbox.to_string()],
            "told its own id before anything reached it"
        );
    }
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1, "none booted");
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 3);

    // Each has a disk of its own.
    assert_eq!(
        lab.run(id(1), &["write mine", "disk"]).await,
        ["ok", "mine"]
    );
    assert_eq!(lab.run(id(2), &["disk"]).await, ["base"]);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn without_a_ready_template_a_sandbox_boots_cold_at_once() {
    let delays = Delays {
        boot: Duration::from_millis(300),
        ..Delays::default()
    };
    let lab = warm_lab(Lab::root(), Arc::default(), delays, Vec::new()).await;
    assert!(
        lab.status().await.templates.is_empty(),
        "built on first use"
    );

    let started = Instant::now();
    lab.create(id(1), NEVER).await;
    assert!(
        started.elapsed() < Duration::from_millis(250),
        "creating never waits for a template build"
    );
    assert!(!memory_saved(&lab.status().await, id(1)));
    assert_eq!(lab.run(id(1), &["sandbox?"]).await, [""]);

    wait_ready(&lab).await;
    lab.create(id(2), NEVER).await;
    assert!(memory_saved(&lab.status().await, id(2)));
    assert_eq!(lab.run(id(2), &["sandbox?"]).await, [id(2).to_string()]);
    assert_eq!(
        lab.world.boots.load(Ordering::Relaxed),
        2,
        "one cold, one template"
    );
    lab.assert_clean();
}

/// A guest restored from a template thinks it is the template until it
/// acknowledges the notice naming its sandbox. One that does not is never
/// used: its VM is ended, and the sandbox boots from its disk instead. That
/// disk is the template's too, machine identity and all, so the booted
/// guest must acknowledge the same notice before the sandbox runs; until
/// it does, the boot is retried.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_clone_that_never_learns_which_sandbox_it_is_is_never_used() {
    let lab = warm_lab(Lab::root(), Arc::default(), Delays::default(), vec![SHAPE]).await;
    wait_ready(&lab).await;
    lab.create(id(1), NEVER).await;
    assert_eq!(
        lab.record(id(1))["identity"],
        "pending",
        "recorded before restore"
    );

    // The restored guest refuses, then the booted one, until it no longer
    // does. One that takes its id but cannot apply the seed would draw the
    // numbers its siblings draw: it is turned down the same way.
    let refuse = |on: bool| lab.world.refuse_notices.store(on, Ordering::Relaxed);
    let unseed = |on: bool| lab.world.unseeded_notices.store(on, Ordering::Relaxed);
    let turns: [(Id, &dyn Fn(bool)); 2] = [(id(1), &refuse), (id(3), &unseed)];
    for (sandbox, turn_down) in turns {
        if sandbox != id(1) {
            lab.create(sandbox, NEVER).await;
        }
        let (restores, boots) = (
            lab.world.restores.load(Ordering::Relaxed),
            lab.world.boots.load(Ordering::Relaxed),
        );
        let turned_down = lab.world.notices_turned_down.load(Ordering::Relaxed);
        turn_down(true);
        let (woken, ()) = tokio::join!(lab.wake(sandbox), async {
            while lab.world.notices_turned_down.load(Ordering::Relaxed) < turned_down + 2 {
                sleep(Duration::from_millis(5)).await;
            }
            assert_eq!(
                lab.record(sandbox)["identity"],
                "pending",
                "a boot whose guest did not acknowledge settles nothing"
            );
            turn_down(false);
        });
        assert!(matches!(woken, Reply::Woken { .. }), "{woken:?}");
        assert_eq!(lab.world.restores.load(Ordering::Relaxed), restores + 1);
        assert_eq!(
            lab.world.boots.load(Ordering::Relaxed),
            boots + 2,
            "a boot that was turned down, then one that was not"
        );
        assert_eq!(
            lab.run(sandbox, &["sandbox?"]).await,
            [sandbox.to_string()],
            "the booted guest acknowledged its id"
        );
        assert_eq!(
            lab.record(sandbox)["identity"],
            "known",
            "and that settles it"
        );
    }

    // An acknowledged notice is recorded, so nothing after it repeats it.
    lab.create(id(2), NEVER).await;
    assert_eq!(lab.run(id(2), &["sandbox?"]).await, [id(2).to_string()]);
    assert_eq!(lab.record(id(2))["identity"], "known");
    lab.assert_clean();
}

/// An agent that stopped after restoring a template's sandbox but before
/// its guest acknowledged which sandbox it is leaves a VM that may still
/// think it is the template. The next agent ends it rather than take it
/// back, and the sandbox boots from its disk on its next wake.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restart_ends_a_clone_whose_guest_was_never_told() {
    let lab = warm_lab(Lab::root(), Arc::default(), Delays::default(), vec![SHAPE]).await;
    wait_ready(&lab).await;
    lab.create(id(1), NEVER).await;
    lab.run(id(1), &["set x"]).await;
    let dir = lab.sandbox_dir(id(1));
    let (root, world) = lab.stop().await;
    assert!(world.live.lock().unwrap().contains(&vm_name(id(1))));

    // The agent died after the guest ran but before its answer was
    // recorded.
    let path = dir.join("sandbox.json");
    let mut record: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(record["image"], false, "recorded before the guest ran");
    record["identity"] = "pending".into();
    std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();

    let lab = warm_lab(root, world, Delays::default(), vec![SHAPE]).await;
    assert!(
        !lab.world.live.lock().unwrap().contains(&vm_name(id(1))),
        "its VM was ended"
    );
    assert_eq!(
        Lab::sandbox(&lab.status().await, id(1)).level,
        LevelName::Saved
    );
    assert_eq!(lab.run(id(1), &["get"]).await, [""], "booted afresh");
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 2);
    assert_eq!(lab.record(id(1))["identity"], "known");
    lab.assert_clean();
}

/// A template build whose VM cannot be proven gone keeps its ordinal, so
/// no sandbox gets the user its VMM may still run as, until a later start
/// of the agent ends it, whether or not that agent keeps templates.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_build_whose_vm_may_survive_keeps_its_user_taken() {
    let world = Arc::<World>::default();
    world.stuck_clean_ups.store(true, Ordering::Relaxed);
    let lab = warm_lab(
        Lab::root(),
        Arc::clone(&world),
        Delays::default(),
        vec![SHAPE],
    )
    .await;
    wait_ready(&lab).await;
    let jails = lab.root.join("state/templates/vm/firecracker");
    let leftovers = || std::fs::read_dir(&jails).unwrap().count();
    assert_eq!(leftovers(), 1, "its files stay with it");
    lab.create(id(1), NEVER).await;
    assert_eq!(
        lab.record(id(1))["ordinal"],
        1,
        "the build's ordinal is taken"
    );
    let (root, world) = lab.stop().await;

    // An agent that keeps no templates still ends it, and frees its user.
    world.stuck_clean_ups.store(false, Ordering::Relaxed);
    let lab = Lab::start(root, world, Delays::default(), HostPolicy::default()).await;
    assert_eq!(leftovers(), 0, "the leftover build is gone");
    lab.create(id(2), NEVER).await;
    assert_eq!(lab.record(id(2))["ordinal"], 0);
    let (root, world) = lab.stop().await;

    // One whose ordinal nothing records could clash with any sandbox, and
    // with any template build: neither a create nor a configured shape's
    // build takes an ordinal while it may run.
    std::fs::create_dir_all(jails.join("template-feedface/root")).unwrap();
    world.stuck_clean_ups.store(true, Ordering::Relaxed);
    remove_templates(&root);
    let lab = warm_lab(root, world, Delays::default(), vec![SHAPE]).await;
    refuse_creates_and_builds(&lab).await;
    let (root, world) = lab.stop().await;
    world.stuck_clean_ups.store(false, Ordering::Relaxed);
    let lab = Lab::start(root, world, Delays::default(), HostPolicy::default()).await;
    lab.create(id(3), NEVER).await;
    let (root, world) = lab.stop().await;

    // The same for a sandbox whose record is unreadable and whose user is
    // unknown.
    let record = root
        .join("state/vm/firecracker")
        .join(id(3).to_string())
        .join("sandbox.json");
    std::fs::write(record, b"{").unwrap();
    remove_templates(&root);
    let lab = warm_lab(root, world, Delays::default(), vec![SHAPE]).await;
    refuse_creates_and_builds(&lab).await;
    lab.stop().await;
}

/// Removes every finished template, so the next agent must build.
fn remove_templates(root: &Path) {
    for template in templates(root) {
        std::fs::remove_dir_all(template).unwrap();
    }
}

/// Checks that `lab`, started with an ordinal it cannot know, creates no
/// sandbox and builds no template.
async fn refuse_creates_and_builds(lab: &Lab) {
    let boots = lab.world.boots.load(Ordering::Relaxed);
    lab.wait_until("a template build refused", |status| {
        template_state(status) == Some(TemplateState::Failed)
    })
    .await;
    let config = compute_host::protocol::SandboxConfig {
        vcpus: 1,
        memory_mib: 256,
        sleep: NEVER,
    };
    let refused = lab
        .client
        .call(&compute_host::protocol::Request::Create { id: id(4), config })
        .await
        .unwrap();
    assert!(matches!(refused, Reply::Error { .. }), "{refused:?}");
    assert_eq!(
        lab.world.boots.load(Ordering::Relaxed),
        boots,
        "nothing booted"
    );
}

/// A template found on disk whose memory changed without changing its
/// length passes the light check each clone makes. A starting agent checks
/// every chunk once before it uses the template, and builds it again.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_template_corrupted_on_disk_is_rebuilt() {
    let lab = warm_lab(Lab::root(), Arc::default(), Delays::default(), vec![SHAPE]).await;
    wait_ready(&lab).await;
    let (root, world) = lab.stop().await;
    let memory = image_memory(&templates(&root)[0].join("images"));
    let mut bytes = std::fs::read(&memory).unwrap();
    let first = bytes.first_mut().expect("the template has memory");
    *first ^= 0x5a;
    std::fs::set_permissions(&memory, std::os::unix::fs::PermissionsExt::from_mode(0o644)).unwrap();
    std::fs::write(&memory, &bytes).unwrap();

    let lab = warm_lab(root, world, Delays::default(), vec![SHAPE]).await;
    wait_ready(&lab).await;
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 2, "built again");
    lab.create(id(1), NEVER).await;
    assert!(memory_saved(&lab.status().await, id(1)), "from the new one");
    assert_eq!(lab.run(id(1), &["sandbox?"]).await, [id(1).to_string()]);
    lab.assert_clean();
}

/// A template a file of which is gone is not kept as ready: the sandbox
/// that found it boots cold, and the template is built again.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_template_missing_a_file_is_rebuilt() {
    let lab = warm_lab(Lab::root(), Arc::default(), Delays::default(), vec![SHAPE]).await;
    wait_ready(&lab).await;
    let old = templates(&lab.root);
    std::fs::remove_file(old[0].join("disk.ext4")).unwrap();

    lab.create(id(1), NEVER).await;
    assert!(!memory_saved(&lab.status().await, id(1)), "booted cold");
    lab.wait_until("a rebuilt template", |status| {
        template_state(status) == Some(TemplateState::Ready)
            && status.templates.len() == 1
            && templates(&lab.root)
                .iter()
                .all(|dir| dir.join("disk.ext4").exists())
    })
    .await;
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 2, "built again");

    lab.create(id(2), NEVER).await;
    assert!(memory_saved(&lab.status().await, id(2)), "from the new one");
    assert_eq!(lab.run(id(2), &["sandbox?"]).await, [id(2).to_string()]);
    lab.assert_clean();
}

/// Template builds count against the host's boot and save limits like any
/// sandbox's steps: with one boot and one save at a time, builds for
/// several shapes never boot at once.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn template_builds_respect_the_boot_limit() {
    let delays = Delays {
        boot: Duration::from_millis(100),
        ..Delays::default()
    };
    let policy = HostPolicy {
        limits: compute_core::StepLimits::default()
            .with(compute_core::Step::Boot, 1)
            .with(compute_core::Step::Save, 1),
        ..HostPolicy::default()
    };
    let shapes = vec![
        SHAPE,
        Shape {
            vcpus: 2,
            memory_mib: 256,
        },
        Shape {
            vcpus: 1,
            memory_mib: 512,
        },
    ];
    let lab =
        Lab::start_configured(Lab::root(), Arc::default(), delays, policy, warm(shapes)).await;
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut most = 0;
    loop {
        let builds = lab
            .world
            .live
            .lock()
            .unwrap()
            .iter()
            .filter(|name| name.starts_with("template-"))
            .count();
        most = most.max(builds);
        let status = lab.status().await;
        if status.templates.len() == 3
            && status
                .templates
                .iter()
                .all(|template| template.state == TemplateState::Ready)
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "templates never built: {status:?}"
        );
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    // One booting and one being saved; without the limits all three boot
    // at once.
    assert!(most <= 2, "{most} build VMs at once");
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_changed_base_image_rebuilds_the_template() {
    let lab = warm_lab(Lab::root(), Arc::default(), Delays::default(), vec![SHAPE]).await;
    wait_ready(&lab).await;
    let old = templates(&lab.root);

    std::fs::write(lab.root.join("base.img"), "base two").unwrap();
    lab.create(id(1), NEVER).await;
    assert!(
        !memory_saved(&lab.status().await, id(1)),
        "an outdated template is not used"
    );
    assert_eq!(lab.run(id(1), &["disk"]).await, ["base two"]);

    let rebuilt = lab
        .wait_until("a rebuilt template", |status| {
            template_state(status) == Some(TemplateState::Ready)
        })
        .await;
    assert_eq!(rebuilt.templates.len(), 1);
    let new = templates(&lab.root);
    assert_eq!(new.len(), 1, "the old template is gone: {new:?}");
    assert_ne!(new, old);

    lab.create(id(2), NEVER).await;
    assert!(memory_saved(&lab.status().await, id(2)));
    assert_eq!(lab.run(id(2), &["disk"]).await, ["base two"]);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn templates_outlive_the_agent_and_its_leftovers_do_not() {
    let world = Arc::<World>::default();
    let lab = warm_lab(
        Lab::root(),
        Arc::clone(&world),
        Delays::default(),
        vec![SHAPE],
    )
    .await;
    wait_ready(&lab).await;
    let (root, world) = lab.stop().await;
    let kept = templates(&root);

    // What a build cut short by a crash leaves.
    let state = root.join("state/templates");
    std::fs::create_dir_all(state.join("1x256-0123456789abcdef.building")).unwrap();
    let jail = state.join("vm/firecracker/template-0123456789abcdef/root");
    std::fs::create_dir_all(&jail).unwrap();

    let lab = warm_lab(root, world, Delays::default(), vec![SHAPE]).await;
    assert_eq!(
        template_state(&lab.status().await),
        Some(TemplateState::Ready),
        "ready at once"
    );
    assert_eq!(templates(&lab.root), kept);
    assert!(!jail.exists(), "a dead build's jail is removed");
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1, "not rebuilt");

    lab.create(id(1), NEVER).await;
    assert_eq!(lab.run(id(1), &["sandbox?"]).await, [id(1).to_string()]);
    lab.assert_clean();
}
