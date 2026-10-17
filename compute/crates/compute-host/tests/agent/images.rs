//! Creates naming a sandbox image (ADR 19): the host fetches it from its
//! store once, however many creates wait for it, keeps it, and copies it
//! for each new disk; an image nowhere is refused and frees the id.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use compute_core::HostPolicy;
use compute_host::protocol::{Id, ImageId, SandboxConfig};
use compute_host::{Directory, HostAgent, HostError};

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
    let engine = Fake {
        world: Arc::default(),
        delays: Delays::default(),
    };
    let (handle, _agent) = HostAgent::start(config, engine, store).await.unwrap();
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
}
