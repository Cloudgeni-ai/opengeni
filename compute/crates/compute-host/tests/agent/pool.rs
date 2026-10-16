//! Warm templates: new sandboxes restore a booted guest instead of booting.

use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use compute_core::HostPolicy;
use compute_host::protocol::{HostStatus, Id, LevelName, TemplateState};
use compute_host::{HostConfig, PoolConfig, Shape};
use tokio::time::Instant;

use super::{Delays, Lab, NEVER, World, id};

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
        .filter(|path| path.file_name().unwrap() != "vm")
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
