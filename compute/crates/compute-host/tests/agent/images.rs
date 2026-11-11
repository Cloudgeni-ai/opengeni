//! Creates naming a sandbox image (ADR 19): the host fetches it from its
//! store once, however many creates wait for it, keeps it, and copies it
//! for each new disk, an agent after a restart included; an image nowhere
//! is refused and frees the id. A create waiting for its image keeps its
//! room.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use compute_core::{Admission, HostPolicy};
use compute_engine::{CancellationToken, EngineError};
use compute_host::protocol::{Id, ImageId, SandboxConfig};
use compute_host::{
    Archive, Claimed, Directory, FetchInto, FetchedMemory, HostAgent, HostError, Owned, OwnerEpoch,
    Receipt, SavedFiles, Stamp, Store,
};
use tokio::sync::Semaphore;

use super::{Delays, Fake, Lab, NEVER, id};

/// The disk of sandbox `id` on an agent whose state root is `state`.
fn disk(state: &Path, id: Id) -> PathBuf {
    state
        .join("vm/firecracker")
        .join(id.to_string())
        .join("root/disk.ext4")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn creates_fetch_their_image_once_keep_it_and_copy_it() {
    let root = Lab::root();
    let store = Directory::new(root.join("store"));
    let file = root.join("image.ext4");
    std::fs::write(&file, b"an image").unwrap();
    let image = store.put_rootfs(&file).await.unwrap();
    let config = Lab::config(&root, HostPolicy::default());
    let state = config.root.clone();
    let world = Arc::default();
    let engine = Fake {
        world: Arc::clone(&world),
        delays: Delays::default(),
    };
    let (handle, agent) = HostAgent::start(config, engine, store).await.unwrap();
    let sandbox = SandboxConfig::new(1, 128, NEVER).with_image(image);

    // Three creates at once share one fetch.
    let creates = (1..=3).map(|n| {
        let (handle, sandbox) = (handle.clone(), sandbox.clone());
        async move { handle.create(id(n), sandbox).await }
    });
    for created in futures::future::join_all(creates).await {
        created.unwrap();
    }
    for n in 1..=3 {
        assert_eq!(std::fs::read(disk(&state, id(n))).unwrap(), b"an image");
    }
    let kept = state.join("rootfs").join(format!("{image}.ext4"));
    assert_eq!(std::fs::read(&kept).unwrap(), b"an image");

    // With the store's copy gone, the host's serves later creates.
    std::fs::remove_file(root.join("store/rootfs").join(format!("{image}.ext4"))).unwrap();
    handle.create(id(4), sandbox.clone()).await.unwrap();
    assert_eq!(std::fs::read(disk(&state, id(4))).unwrap(), b"an image");

    // An image neither has is refused, and the id is free again.
    let nowhere: ImageId = "ab".repeat(32).parse().unwrap();
    let refused = handle
        .create(id(5), SandboxConfig::new(1, 128, NEVER).with_image(nowhere))
        .await;
    assert!(
        matches!(&refused, Err(HostError::Invalid(why)) if why.contains("no image")),
        "{refused:?}"
    );
    handle
        .create(id(5), SandboxConfig::new(1, 128, NEVER))
        .await
        .unwrap();
    assert_eq!(std::fs::read(disk(&state, id(5))).unwrap(), b"base");

    // After a restart, the image the host kept is checked and used, with
    // the store's copy still gone.
    drop(handle);
    tokio::time::timeout(std::time::Duration::from_secs(10), agent)
        .await
        .expect("the agent stops once its handles are gone")
        .unwrap();
    let engine = Fake {
        world,
        delays: Delays::default(),
    };
    let (handle, _agent) = HostAgent::start(
        Lab::config(&root, HostPolicy::default()),
        engine,
        Directory::new(root.join("store")),
    )
    .await
    .unwrap();
    handle.create(id(6), sandbox).await.unwrap();
    assert_eq!(std::fs::read(disk(&state, id(6))).unwrap(), b"an image");
}

/// A store whose image lengths each wait for a permit, so a create naming
/// an image waits for its fetch until the test adds one.
struct Gated {
    inner: Directory,
    sizes: Arc<Semaphore>,
}

impl Store for Gated {
    fn archive(
        &self,
        id: Id,
        save: Stamp,
        files: &SavedFiles,
        cancel: &CancellationToken,
    ) -> impl Future<Output = Result<Archive, EngineError>> + Send {
        self.inner.archive(id, save, files, cancel)
    }

    fn verify(
        &self,
        id: Id,
        receipt: &Receipt,
    ) -> impl Future<Output = Result<bool, EngineError>> + Send {
        self.inner.verify(id, receipt)
    }

    fn fetch(
        &self,
        id: Id,
        into: &FetchInto,
    ) -> impl Future<Output = Result<FetchedMemory, EngineError>> + Send {
        self.inner.fetch(id, into)
    }

    fn delete(
        &self,
        id: Id,
        own: OwnerEpoch,
    ) -> impl Future<Output = Result<Owned<()>, EngineError>> + Send {
        self.inner.delete(id, own)
    }

    fn claim(
        &self,
        id: Id,
        own: OwnerEpoch,
    ) -> impl Future<Output = Result<Owned<Option<Claimed>>, EngineError>> + Send {
        self.inner.claim(id, own)
    }

    fn forget_memory(
        &self,
        id: Id,
        change: Stamp,
    ) -> impl Future<Output = Result<Owned<Option<Receipt>>, EngineError>> + Send {
        self.inner.forget_memory(id, change)
    }

    fn image_len(
        &self,
        image: ImageId,
    ) -> impl Future<Output = Result<Option<u64>, EngineError>> + Send {
        let sizes = Arc::clone(&self.sizes);
        async move {
            sizes.acquire().await.expect("never closed").forget();
            self.inner.image_len(image).await
        }
    }

    fn fetch_image(
        &self,
        image: ImageId,
        path: &Path,
    ) -> impl Future<Output = Result<bool, EngineError>> + Send {
        self.inner.fetch_image(image, path)
    }
}

const MIB: u64 = 1 << 20;

/// A create waiting for its image holds the room of its first wake: one
/// after it that would take that room is refused at once, rather than the
/// waiting one once its image is here. A fetch that fails lets the room
/// go.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_create_waiting_for_its_image_keeps_its_room() {
    let root = Lab::root();
    let store = Directory::new(root.join("store"));
    let file = root.join("image.ext4");
    std::fs::write(&file, b"an image").unwrap();
    let image = store.put_rootfs(&file).await.unwrap();
    let sizes = Arc::new(Semaphore::new(0));
    let gated = Gated {
        inner: store,
        sizes: Arc::clone(&sizes),
    };
    // Room for one sandbox of 256 MiB.
    let lab = Lab::start_stored_configured(root, Arc::default(), gated, |config| {
        config.policy = HostPolicy {
            admission: Some(Admission {
                budget: 384 * MIB,
                buffer: 0,
                busy_grace: Duration::from_millis(100),
            }),
            ..HostPolicy::default()
        };
    })
    .await;
    let sandbox = SandboxConfig::new(1, 256, NEVER);
    let waiting = tokio::spawn({
        let (handle, config) = (lab.handle.clone(), sandbox.clone().with_image(image));
        async move { handle.create(id(1), config).await }
    });
    lab.wait_until("the waiting create's room held", |status| {
        status
            .capacity
            .is_some_and(|capacity| capacity.occupied == 256 * MIB)
    })
    .await;
    let refused = lab.handle.create(id(2), sandbox.clone()).await;
    assert!(
        matches!(refused, Err(HostError::HostFull { .. })),
        "{refused:?}"
    );

    sizes.add_permits(1 << 20);
    waiting.await.unwrap().unwrap();
    assert_eq!(lab.run(id(1), &["disk"]).await, ["an image"]);
    lab.remove(id(1)).await;

    let nowhere: ImageId = "ab".repeat(32).parse().unwrap();
    let missing = lab
        .handle
        .create(id(3), sandbox.clone().with_image(nowhere))
        .await;
    assert!(
        matches!(&missing, Err(HostError::Invalid(why)) if why.contains("no image")),
        "{missing:?}"
    );
    lab.handle.create(id(4), sandbox).await.unwrap();
    lab.assert_clean();
}

/// A create keeps its room however long its image takes: the hold of its
/// first wake is renewed while it waits, well past when an unwoken first
/// wake stops being booked.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_create_keeps_its_room_however_long_its_image_takes() {
    let root = Lab::root();
    let store = Directory::new(root.join("store"));
    let file = root.join("image.ext4");
    std::fs::write(&file, b"an image").unwrap();
    let image = store.put_rootfs(&file).await.unwrap();
    let sizes = Arc::new(Semaphore::new(0));
    let gated = Gated {
        inner: store,
        sizes: Arc::clone(&sizes),
    };
    let within = Duration::from_millis(300);
    // Room for one sandbox of 256 MiB.
    let lab = Lab::start_stored_configured(root, Arc::default(), gated, |config| {
        config.first_wake_within = within;
        config.policy = HostPolicy {
            admission: Some(Admission {
                budget: 384 * MIB,
                buffer: 0,
                busy_grace: Duration::from_millis(100),
            }),
            ..HostPolicy::default()
        };
    })
    .await;
    let sandbox = SandboxConfig::new(1, 256, NEVER);
    let waiting = tokio::spawn({
        let (handle, config) = (lab.handle.clone(), sandbox.clone().with_image(image));
        async move { handle.create(id(1), config).await }
    });
    lab.wait_until("the waiting create's room held", |status| {
        status
            .capacity
            .is_some_and(|capacity| capacity.occupied == 256 * MIB)
    })
    .await;
    tokio::time::sleep(within * 4).await;
    let occupied = lab
        .status()
        .await
        .capacity
        .map(|capacity| capacity.occupied);
    assert_eq!(
        occupied,
        Some(256 * MIB),
        "the hold lapsed while its create waited"
    );
    let refused = lab.handle.create(id(2), sandbox.clone()).await;
    assert!(
        matches!(refused, Err(HostError::HostFull { .. })),
        "{refused:?}"
    );

    sizes.add_permits(1 << 20);
    waiting.await.unwrap().unwrap();
    lab.remove(id(1)).await;
    lab.assert_clean();
}
