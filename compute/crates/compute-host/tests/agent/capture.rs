//! Captures (ADR 22): a saved sandbox's disk stored as a sandbox image,
//! whole as its last save left it, whatever the sandbox does next.
//!
//! The copy shares the disk's blocks, so these run only where
//! `COMPUTE_TEST_SHARED_EXTENTS_DIR` names a directory whose files share
//! extents (see the checkpoint tests); hosts that cannot are refused.

use std::sync::Arc;
use std::time::Duration;

use compute_core::HostPolicy;
use compute_host::Directory;
use compute_host::protocol::{ErrorCode, Id, ImageId, LevelName, Reply, Request, SandboxConfig};
use tokio::time::{Instant, sleep};

use super::checkpoint::shared_extents;
use super::{Delays, Lab, NEVER, id};

async fn ask(lab: &Lab, sandbox: Id, key: &str) -> Reply {
    lab.client
        .call(&Request::Capture {
            id: sandbox,
            generation: None,
            key: key.into(),
        })
        .await
        .unwrap()
}

/// Asks until the capture `key` is stored, answering its image and length.
async fn captured(lab: &Lab, sandbox: Id, key: &str) -> (ImageId, u64) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match ask(lab, sandbox, key).await {
            Reply::Captured { image, length } => return (image, length),
            Reply::Capturing => {}
            other => panic!("capture {key}: {other:?}"),
        }
        assert!(Instant::now() < deadline, "capture {key} never ended");
        sleep(Duration::from_millis(5)).await;
    }
}

fn refused_with(reply: &Reply, code: ErrorCode) -> bool {
    matches!(reply, Reply::Error { code: found, .. } if *found == code)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_saved_sandbox_is_stored_as_an_image_its_later_writes_never_reach() {
    let Some(dir) = shared_extents() else {
        return;
    };
    let root = Lab::root_in(&dir);
    let shelf = root.join("shelf");
    let lab = Lab::start_stored(root.clone(), Arc::default(), Directory::new(&shelf)).await;
    let sandbox = id(1);
    lab.create(sandbox, NEVER).await;
    lab.run(sandbox, &["write prepared"]).await;

    // Awake, it is refused: its disk is still changing.
    let awake = ask(&lab, sandbox, "k1").await;
    assert!(refused_with(&awake, ErrorCode::Busy), "{awake:?}");

    assert_eq!(lab.sleep_to(sandbox, LevelName::Saved).await, Reply::Done);
    lab.wait_level(sandbox, LevelName::Saved).await;
    assert_eq!(ask(&lab, sandbox, "k1").await, Reply::Capturing);
    // Woken and written at once, while the copy is stored.
    lab.run(sandbox, &["write changed"]).await;
    let (image, length) = captured(&lab, sandbox, "k1").await;
    assert_eq!(length, "prepared".len() as u64);
    assert_eq!(
        captured(&lab, sandbox, "k1").await,
        (image, length),
        "a later ask with the key hears the same image"
    );
    let stored = shelf.join("rootfs").join(format!("{image}.ext4"));
    assert_eq!(std::fs::read(&stored).unwrap(), b"prepared");
    let copies = root.join("state/capture");
    assert_eq!(
        std::fs::read_dir(&copies).unwrap().count(),
        0,
        "the copy goes once stored"
    );

    // The image starts new sandboxes with the disk it was saved with.
    let made = id(2);
    let reply = lab
        .client
        .call(&Request::Create {
            id: made,
            config: SandboxConfig::new(1, 128, NEVER).with_image(image),
        })
        .await
        .unwrap();
    assert_eq!(reply, Reply::Done);
    assert_eq!(lab.run(made, &["disk"]).await, ["prepared"]);
    assert_eq!(lab.run(sandbox, &["disk"]).await, ["changed"]);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_capture_needs_a_store_files_that_share_blocks_and_a_valid_key() {
    // No store: nowhere to keep the image.
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(3);
    lab.create(sandbox, NEVER).await;
    assert_eq!(lab.sleep_to(sandbox, LevelName::Saved).await, Reply::Done);
    lab.wait_level(sandbox, LevelName::Saved).await;
    let reply = ask(&lab, sandbox, "k").await;
    assert!(refused_with(&reply, ErrorCode::Unavailable), "{reply:?}");
    let reply = ask(&lab, sandbox, "not a key").await;
    assert!(refused_with(&reply, ErrorCode::Invalid), "{reply:?}");

    // A store, on files that share no blocks: only where /tmp is such.
    let root = Lab::root();
    let lab = Lab::start_stored(
        root.clone(),
        Arc::default(),
        Directory::new(root.join("shelf")),
    )
    .await;
    if lab.status().await.about.checkpoints {
        eprintln!("skipped the block-sharing half: files under /tmp share extents here");
        return;
    }
    lab.create(sandbox, NEVER).await;
    assert_eq!(lab.sleep_to(sandbox, LevelName::Saved).await, Reply::Done);
    lab.wait_level(sandbox, LevelName::Saved).await;
    let reply = ask(&lab, sandbox, "k").await;
    assert!(refused_with(&reply, ErrorCode::Unavailable), "{reply:?}");
}
