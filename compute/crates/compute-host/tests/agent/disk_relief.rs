//! Disk relief (ADR 30): a create short of disk by no more than what the
//! host keeps only to go faster, a template or a cached image nothing
//! uses, has that removed and goes on once a reading shows the room; one
//! that would need what it uses itself is refused, and that stays. The
//! tests give the agent its disk readings one at a time, and count only
//! inodes, so each create is decided exactly when they say.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use compute_core::{DiskPolicy, DiskSpace, HostPolicy};
use compute_host::protocol::{DiskStatus, HostStatus, Id, ImageId, SandboxConfig, TemplateState};
use compute_host::{Directory, DiskGauge, Handle, HostAgent, HostError, PoolConfig, Shape};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep};

use super::{Delays, Fake, Lab, NEVER, id};

/// More bytes than anything here books, so only inodes are ever short.
const PLENTY: u64 = 1 << 50;

/// The shape of the template the host keeps, when it keeps one.
const SHAPE: Shape = Shape {
    image: None,
    vcpus: 1,
    memory_mib: 256,
};

struct Host {
    handle: Handle,
    gauge: DiskGauge,
    /// An image only the store has.
    image: ImageId,
    root: PathBuf,
}

impl Host {
    /// A host that books its disk, keeping a template of [`SHAPE`] if
    /// `warm`, and has read plenty free.
    async fn start(warm: bool) -> Self {
        let root = Lab::root();
        let store = Directory::new(root.join("store"));
        let file = root.join("image.ext4");
        std::fs::write(&file, b"an image").unwrap();
        let image = store.put_rootfs(&file).await.unwrap();
        let policy = HostPolicy {
            disk: Some(DiskPolicy {
                reserve: 0,
                reserve_inodes: 0,
            }),
            ..HostPolicy::default()
        };
        let gauge = DiskGauge::default();
        // Taken before any template build starts, which needs a reading.
        gauge.give(DiskSpace {
            bytes: PLENTY,
            inodes: PLENTY,
        });
        let mut config = Lab::config(&root, policy);
        config.disk_reading = Some(gauge.clone());
        if warm {
            config.restore_notice_port = Some(53);
            config.pool = Some(PoolConfig {
                ready_port: 52,
                shapes: vec![SHAPE],
                depends_on: Vec::new(),
                ready_timeout: Duration::from_secs(5),
                ready: std::collections::BTreeMap::new(),
                unused_after: PoolConfig::UNUSED_AFTER,
            });
        }
        let engine = Fake {
            world: Arc::default(),
            delays: Delays::default(),
        };
        let (handle, _agent) = HostAgent::start(config, engine, store).await.unwrap();
        let host = Self {
            handle,
            gauge,
            image,
            root,
        };
        host.read(PLENTY).await;
        host
    }

    /// Has the agent read `inodes` free, and plenty of bytes, then tells
    /// what its disk book holds.
    async fn read(&self, inodes: u64) -> DiskStatus {
        self.gauge.give(DiskSpace {
            bytes: PLENTY,
            inodes,
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.gauge.taken() {
            assert!(Instant::now() < deadline, "no sample took the reading");
            sleep(Duration::from_millis(5)).await;
        }
        self.disk().await
    }

    async fn disk(&self) -> DiskStatus {
        let status = self.handle.status().await.unwrap();
        status.disk.expect("a disk policy")
    }

    async fn wait_until(&self, what: &str, done: impl Fn(&HostStatus) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let status = self.handle.status().await.unwrap();
            if done(&status) {
                return;
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            sleep(Duration::from_millis(10)).await;
        }
    }

    /// Waits until the host has measured something disk relief may free.
    async fn wait_reclaimable(&self) {
        self.wait_until("something disk relief may free", |status| {
            status.disk.is_some_and(|disk| disk.reclaimable > 0)
        })
        .await;
    }

    /// Creates sandbox `id`, of `vcpus` and [`SHAPE`]'s memory, never
    /// saved by the host on its own, so it books no save.
    fn create(
        &self,
        id: Id,
        vcpus: u8,
        image: Option<ImageId>,
    ) -> JoinHandle<Result<(), HostError>> {
        let handle = self.handle.clone();
        let mut config = SandboxConfig::new(vcpus, SHAPE.memory_mib, NEVER);
        if let Some(image) = image {
            config = config.with_image(image);
        }
        tokio::spawn(async move { handle.create(id, config).await })
    }

    /// The directories of the ready templates.
    fn templates(&self) -> Vec<PathBuf> {
        templates(&self.root)
    }
}

/// The directories of every ready template on the lab at `root`.
fn templates(root: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(root.join("state/templates"))
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path.file_name().unwrap().to_str().unwrap();
            !["vm", "used", "inputs"].contains(&name) && !name.starts_with('.')
        })
        .collect()
}

/// Waits for the template of [`SHAPE`] to be ready, then has `id` copy
/// it, which measures what a new sandbox's first files book: they stay
/// booked until the next reading.
async fn template_and_first_files(host: &Host, id: Id) -> u64 {
    host.wait_until("a ready template", |status| {
        status
            .templates
            .iter()
            .any(|template| template.vcpus == SHAPE.vcpus && template.state == TemplateState::Ready)
    })
    .await;
    host.read(PLENTY).await;
    host.create(id, SHAPE.vcpus, None).await.unwrap().unwrap();
    let first = host.disk().await.inodes_booked;
    assert_eq!(host.read(PLENTY).await.inodes_booked, 0, "it books no save");
    assert!(first > 1, "first files {first}");
    first
}

/// A create one inode short has the cached image nothing uses removed,
/// then goes on once a reading shows the room.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_create_short_only_by_an_unused_image_has_it_removed() {
    let host = Host::start(false).await;
    host.create(id(1), 1, Some(host.image))
        .await
        .unwrap()
        .unwrap();
    host.read(PLENTY).await;
    host.create(id(3), 1, None).await.unwrap().unwrap();
    let first = host.disk().await.inodes_booked;
    assert_eq!(host.read(PLENTY).await.inodes_booked, 0, "it books no save");
    host.wait_reclaimable().await;
    let cached = host
        .root
        .join("state/rootfs")
        .join(format!("{}.ext4", host.image));
    assert!(cached.exists(), "{}", cached.display());

    host.read(first - 1).await;
    let waiting = host.create(id(2), 1, None);
    let deadline = Instant::now() + Duration::from_secs(5);
    while cached.exists() {
        assert!(Instant::now() < deadline, "the image was never removed");
        sleep(Duration::from_millis(10)).await;
    }
    assert!(!waiting.is_finished(), "it waits for a reading");
    host.read(first).await;
    waiting.await.unwrap().unwrap();
}

/// A create one inode short has the template nothing uses retired and
/// removed, then goes on once a reading shows the room; a create of its
/// shape builds it again.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_create_short_only_by_an_unused_template_has_it_removed() {
    let host = Host::start(true).await;
    let first = template_and_first_files(&host, id(9)).await;
    assert_eq!(host.templates().len(), 1);
    host.wait_reclaimable().await;

    host.read(first - 1).await;
    let waiting = host.create(id(2), 2, None);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !host.templates().is_empty() {
        assert!(Instant::now() < deadline, "the template was never removed");
        sleep(Duration::from_millis(10)).await;
    }
    assert!(!waiting.is_finished(), "it waits for a reading");
    host.read(PLENTY).await;
    waiting.await.unwrap().unwrap();
}

/// A create one inode short that would copy the template is refused
/// rather than have that template removed, which stays.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_template_a_waiting_create_copies_is_never_removed_for_it() {
    let host = Host::start(true).await;
    let first = template_and_first_files(&host, id(9)).await;
    host.wait_reclaimable().await;

    host.read(first - 1).await;
    let refused = host.create(id(2), SHAPE.vcpus, None);
    sleep(Duration::from_millis(300)).await;
    assert!(!refused.is_finished(), "it waits for a reading");
    host.read(first - 1).await;
    let refused = refused.await.unwrap();
    assert!(
        matches!(refused, Err(HostError::HostFull { .. })),
        "{refused:?}"
    );
    assert_eq!(host.templates().len(), 1, "the template stays");
}
