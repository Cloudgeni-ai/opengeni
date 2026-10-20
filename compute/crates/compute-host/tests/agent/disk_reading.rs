//! Work that may fit on disk once the next reading shows what bookings
//! that ended wrote: it waits for that reading, which lets it in or
//! refuses it, and a host registering again refuses it unstarted, since
//! with no lease held no reading comes. The tests give the agent its disk
//! readings one at a time, so each is decided exactly when they say.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use compute_core::{DiskPolicy, DiskSpace, HostPolicy};
use compute_host::fleet::{LeaseGate, boot_now};
use compute_host::protocol::{DiskStatus, Id, ImageId, SandboxConfig};
use compute_host::{Directory, DiskGauge, Handle, HostAgent, HostError};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep};

use super::{Delays, Fake, Lab, NEVER, id};

/// More bytes than anything here books, so only inodes are ever short.
const PLENTY: u64 = 1 << 50;

/// How long work that waits for a reading is watched not to finish:
/// several samples, none of which takes a reading.
const WAITS: Duration = Duration::from_millis(300);

struct Host {
    handle: Handle,
    gauge: DiskGauge,
    /// An image only the store has.
    image: ImageId,
    _root: PathBuf,
}

impl Host {
    async fn start(lease: Option<LeaseGate>) -> Self {
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
        let mut config = Lab::config(&root, policy);
        config.disk_reading = Some(gauge.clone());
        config.lease = lease;
        let engine = Fake {
            world: Arc::default(),
            delays: Delays::default(),
        };
        let (handle, _agent) = HostAgent::start(config, engine, store).await.unwrap();
        Self {
            handle,
            gauge,
            image,
            _root: root,
        }
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

    fn create(&self, id: Id, image: Option<ImageId>) -> JoinHandle<Result<(), HostError>> {
        let handle = self.handle.clone();
        let mut config = SandboxConfig::new(1, 128, NEVER);
        if let Some(image) = image {
            config = config.with_image(image);
        }
        tokio::spawn(async move { handle.create(id, config).await })
    }

    /// Creates sandbox `id` with room to spare and measures, in inodes,
    /// what a new sandbox's first files book until a reading shows them,
    /// and what its next save books while it runs.
    async fn measure(&self, id: Id) -> (u64, u64) {
        self.read(PLENTY).await;
        self.create(id, None).await.unwrap().unwrap();
        let with_first = self.disk().await.inodes_booked;
        let save = self.read(PLENTY).await.inodes_booked;
        let first = with_first - save;
        assert!(first > 2, "first files {first}, save {save}");
        (first, save)
    }
}

/// A create short of inodes by no more than what an earlier create's
/// files booked waits for the next reading: one that shows room lets it
/// in, one that shows none refuses it and frees its id.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_create_that_may_fit_waits_for_the_reading_that_decides_it() {
    let host = Host::start(None).await;
    let (first, save) = host.measure(id(1)).await;

    // One sandbox more leaves room for half another's first files, until
    // a reading shows what its own wrote.
    host.read(2 * save + first + first / 2).await;
    host.create(id(2), None).await.unwrap().unwrap();
    assert_eq!(host.disk().await.inodes_free, first / 2);
    let waiting = host.create(id(3), None);
    sleep(WAITS).await;
    assert!(!waiting.is_finished(), "it waits for a reading");

    // The reading shows room: it goes on, and leaves the next one waiting
    // in turn.
    host.read(3 * save + first + first / 2).await;
    waiting.await.unwrap().unwrap();
    let refused = host.create(id(4), None);
    sleep(WAITS).await;
    assert!(!refused.is_finished(), "it waits for a reading");

    // This one shows none: it is refused, and its id is free again.
    host.read(3 * save + first / 2).await;
    let refused = refused.await.unwrap();
    assert!(
        matches!(refused, Err(HostError::HostFull { .. })),
        "{refused:?}"
    );
    host.read(PLENTY).await;
    host.create(id(4), None).await.unwrap().unwrap();
}

/// With no lease held no reading comes, so a host registering again
/// refuses the creates and image fetches waiting for one, unstarted,
/// rather than wait for them to settle: the service asks again under the
/// new registration, and they go on.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_registering_host_refuses_work_waiting_for_a_disk_reading() {
    let gate = LeaseGate::new(boot_now() + Duration::from_secs(60));
    let host = Host::start(Some(gate.clone())).await;
    let (first, save) = host.measure(id(1)).await;

    // One sandbox more leaves room for neither another's first files nor
    // the image's fetch, until a reading shows what its own wrote.
    host.read(2 * save + first + 1).await;
    host.create(id(2), None).await.unwrap().unwrap();
    let create = host.create(id(3), None);
    let fetch = host.create(id(4), Some(host.image));
    sleep(WAITS).await;
    assert!(!create.is_finished() && !fetch.is_finished());

    gate.set(boot_now());
    let listed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match host.handle.inventory().await.unwrap() {
                Ok(listed) => break listed,
                Err(_) => sleep(Duration::from_millis(5)).await,
            }
        }
    })
    .await
    .expect("the list does not wait for work only a reading could decide");
    let mut held: Vec<Id> = listed.sandboxes.iter().map(|held| held.id).collect();
    held.sort_unstable();
    assert_eq!(held, [id(1), id(2)]);
    for refused in [create.await.unwrap(), fetch.await.unwrap()] {
        assert!(
            matches!(refused, Err(HostError::NotAdmitted)),
            "{refused:?}"
        );
    }

    // Renewed, the same creates go on.
    gate.set(boot_now() + Duration::from_secs(60));
    host.read(PLENTY).await;
    host.create(id(3), None).await.unwrap().unwrap();
    host.create(id(4), Some(host.image)).await.unwrap().unwrap();
}
