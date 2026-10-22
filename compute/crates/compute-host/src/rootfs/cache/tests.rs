use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime};

use super::{Cache, Missing};
use crate::protocol::ImageId;
use crate::state::Ownership;
use crate::store::{Directory, NoStore};

const WEEK: Duration = Duration::from_secs(7 * 86_400);

/// A store holding one image of `bytes`, and its id.
async fn stored(dir: &Path, bytes: &[u8]) -> (Directory, ImageId) {
    let file = dir.join("built.ext4");
    fs::write(&file, bytes).unwrap();
    let store = Directory::new(dir.join("store"));
    let image = store.put_rootfs(&file).await.unwrap();
    assert_eq!(image, ImageId(*blake3::hash(bytes).as_bytes()));
    (store, image)
}

fn age(path: &Path, by: Duration) {
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(SystemTime::now() - by)
        .unwrap();
}

#[tokio::test]
async fn an_image_is_fetched_once_checked_and_then_kept() {
    let dir = tempfile::tempdir().unwrap();
    let (store, image) = stored(dir.path(), b"an image").await;
    let cache = Cache::open(dir.path().join("rootfs"), WEEK, Ownership::detached()).unwrap();
    assert!(!cache.has(image));
    let held = cache.get(image, &store).await.unwrap();
    assert_eq!(fs::read(&held.path).unwrap(), b"an image");
    drop(held);
    assert!(cache.has(image));
    // Kept: a host without the store still has it, and so does the next
    // agent.
    assert!(cache.get(image, &NoStore).await.is_ok());
    let reopened = Cache::open(dir.path().join("rootfs"), WEEK, Ownership::detached()).unwrap();
    // Checked against its id before the next agent uses it.
    assert!(!reopened.has(image));
    assert!(reopened.hold(image).await.is_some());
    assert!(reopened.has(image));
}

/// A file an earlier agent left under an image's name is used only if it
/// is that image: one that is not is removed, and fetched again.
#[tokio::test]
async fn a_kept_image_that_does_not_match_its_id_is_never_used() {
    let dir = tempfile::tempdir().unwrap();
    let (store, image) = stored(dir.path(), b"the real image").await;
    let rootfs = dir.path().join("rootfs");
    fs::create_dir_all(&rootfs).unwrap();
    let path = rootfs.join(format!("{image}.ext4"));
    // What an old fetch renamed into place after a successor started one.
    fs::write(&path, b"the real").unwrap();
    let cache = Cache::open(rootfs.clone(), WEEK, Ownership::detached()).unwrap();
    assert!(cache.hold(image).await.is_none());
    assert!(!path.exists(), "the wrong file is gone");
    fs::write(&path, b"the real").unwrap();
    let cache = Cache::open(rootfs, WEEK, Ownership::detached()).unwrap();
    let held = cache.get(image, &store).await.unwrap();
    assert_eq!(fs::read(&held.path).unwrap(), b"the real image");
}

/// Every fetch stages under a name of its own, and the cache keeps its
/// agent's state root until its last piece of work ends.
#[tokio::test(flavor = "multi_thread")]
async fn fetches_never_share_a_staging_name_and_keep_the_root() {
    use crate::state::{Records, StateError};
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state");
    let (records, _) = Records::open(state.clone(), Duration::from_millis(100), None)
        .await
        .unwrap();
    let cache = std::sync::Arc::new(
        Cache::open(dir.path().join("rootfs"), WEEK, records.ownership()).unwrap(),
    );
    let image = ImageId([3; 32]);
    let (first, second) = (cache.staging(image), cache.staging(image));
    assert_ne!(first, second);
    let other = Cache::open(dir.path().join("other"), WEEK, Ownership::detached()).unwrap();
    assert_ne!(other.staging(image).file_name(), first.file_name());
    drop(records);
    let early = Records::open(state.clone(), Duration::from_millis(100), None).await;
    assert!(
        matches!(early, Err(StateError::Locked(_))),
        "a successor took the root while the cache could still write"
    );
    drop(cache);
    assert!(
        Records::open(state, Duration::from_secs(10), None)
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn concurrent_creates_of_one_image_share_its_fetch() {
    let dir = tempfile::tempdir().unwrap();
    let (store, image) = stored(dir.path(), &vec![7; 1 << 20]).await;
    let cache = Cache::open(dir.path().join("rootfs"), WEEK, Ownership::detached()).unwrap();
    let (first, second) = tokio::join!(
        async {
            let held = cache.get(image, &store).await.unwrap();
            fs::read(&held.path).unwrap()
        },
        async {
            let held = cache.get(image, &store).await.unwrap();
            fs::read(&held.path).unwrap()
        },
    );
    assert_eq!(first, vec![7; 1 << 20]);
    assert_eq!(first, second);
    let names: Vec<_> = fs::read_dir(dir.path().join("rootfs"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names.len(), 1, "{names:?}");
}

/// Creates of one image copy it at the same time: none waits for another
/// to finish its copy, an agent's first check of a kept image included.
#[tokio::test]
async fn copies_of_one_image_share_it() {
    let dir = tempfile::tempdir().unwrap();
    let (store, image) = stored(dir.path(), b"an image").await;
    let cache = Cache::open(dir.path().join("rootfs"), WEEK, Ownership::detached()).unwrap();
    let first = cache.get(image, &store).await.unwrap();
    let second = tokio::time::timeout(Duration::from_secs(5), cache.get(image, &store))
        .await
        .expect("a second create waits for none")
        .unwrap();
    let third = tokio::time::timeout(Duration::from_secs(5), cache.hold(image))
        .await
        .expect("a third create waits for none")
        .unwrap();
    assert!(
        cache
            .retire(&HashSet::new(), SystemTime::now() + WEEK * 2)
            .await
            .is_empty(),
        "never removed while copied"
    );
    drop((first, second, third));

    let reopened = Cache::open(dir.path().join("rootfs"), WEEK, Ownership::detached()).unwrap();
    let (one, other) = tokio::join!(reopened.hold(image), reopened.hold(image));
    let (one, other) = (one.unwrap(), other.unwrap());
    assert_eq!(fs::read(&one.path).unwrap(), b"an image");
    assert_eq!(one.path, other.path);
}

/// Creates that find an image still to be checked or fetched wait for
/// that work alone: once it is done, none waits for another's copy.
#[tokio::test(flavor = "multi_thread")]
async fn creates_waiting_for_a_check_or_fetch_never_wait_for_a_copy() {
    let dir = tempfile::tempdir().unwrap();
    let (store, image) = stored(dir.path(), b"an image").await;
    let store = std::sync::Arc::new(store);
    let kept = dir.path().join("rootfs");
    {
        let cache = Cache::open(kept.clone(), WEEK, Ownership::detached()).unwrap();
        drop(cache.get(image, &*store).await.unwrap());
    }

    // A kept image, unchecked, wanted by two creates queued behind a
    // removal's look at it.
    let cache = std::sync::Arc::new(Cache::open(kept, WEEK, Ownership::detached()).unwrap());
    let removal = cache.locks(image).file.write_owned().await;
    let holds: Vec<_> = (0..2)
        .map(|_| {
            let cache = std::sync::Arc::clone(&cache);
            tokio::spawn(async move { cache.hold(image).await })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(removal);
    let mut held = Vec::new();
    for hold in holds {
        held.push(patient(hold).await.expect("checked and kept"));
    }

    // An image to fetch, wanted by two creates at once.
    let fresh = std::sync::Arc::new(
        Cache::open(dir.path().join("fresh"), WEEK, Ownership::detached()).unwrap(),
    );
    let locks = fresh.locks(image);
    let work = locks.work.lock().await;
    let gets: Vec<_> = (0..2)
        .map(|_| {
            let (cache, store) = (std::sync::Arc::clone(&fresh), std::sync::Arc::clone(&store));
            tokio::spawn(async move { cache.get(image, &*store).await })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(work);
    for get in gets {
        held.push(patient(get).await.expect("fetched once"));
    }
    assert_eq!(fs::read_dir(dir.path().join("fresh")).unwrap().count(), 1);
    for held in &held {
        assert_eq!(fs::read(&held.path).unwrap(), b"an image");
    }
}

/// What `task` ends with, which must be soon.
async fn patient<T>(task: tokio::task::JoinHandle<T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("waits for no copy")
        .unwrap()
}

#[tokio::test]
async fn an_image_nowhere_or_damaged_is_refused_and_leaves_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let cache = Cache::open(dir.path().join("rootfs"), WEEK, Ownership::detached()).unwrap();
    let nowhere = ImageId([9; 32]);
    assert!(matches!(
        cache.get(nowhere, &NoStore).await,
        Err(Missing::Unknown(image)) if image == nowhere
    ));

    let (store, image) = stored(dir.path(), b"the real image").await;
    fs::write(
        dir.path()
            .join("store/rootfs")
            .join(format!("{image}.ext4")),
        b"something else",
    )
    .unwrap();
    assert!(matches!(
        cache.get(image, &store).await,
        Err(Missing::Failed { .. })
    ));
    assert!(!cache.has(image));
    assert_eq!(fs::read_dir(dir.path().join("rootfs")).unwrap().count(), 0);
}

#[tokio::test]
async fn unused_images_retire_unless_kept_or_in_use() {
    let dir = tempfile::tempdir().unwrap();
    let cache = Cache::open(dir.path().join("rootfs"), WEEK, Ownership::detached()).unwrap();
    let mut images = Vec::new();
    for bytes in [&b"one"[..], b"two", b"three", b"four"] {
        let (store, image) = stored(dir.path(), bytes).await;
        drop(cache.get(image, &store).await.unwrap());
        images.push(image);
    }
    let [recent, kept, held, old] = images[..] else {
        panic!()
    };
    for image in [kept, held, old] {
        age(&cache.path(image), WEEK + Duration::from_secs(60));
    }
    let holding = cache.get(held, &NoStore).await.unwrap();
    // Getting it marked it used: age it again while it is held.
    age(&holding.path, WEEK + Duration::from_secs(60));
    let keep: HashSet<_> = [kept].into();
    let removed = cache.retire(&keep, SystemTime::now()).await;
    assert_eq!(removed, vec![old]);
    assert!(!cache.has(old) && !cache.path(old).exists());
    for image in [recent, kept, held] {
        assert!(cache.has(image) && cache.path(image).exists());
    }
    drop(holding);
    assert_eq!(cache.retire(&keep, SystemTime::now()).await, vec![held]);
}

#[tokio::test]
async fn a_fetch_an_earlier_agent_left_is_removed() {
    let dir = tempfile::tempdir().unwrap();
    let rootfs = dir.path().join("rootfs");
    fs::create_dir_all(&rootfs).unwrap();
    let image = ImageId(*blake3::hash(b"whole").as_bytes());
    fs::write(rootfs.join(format!("{image}.ext4.fetching")), b"part").unwrap();
    fs::write(rootfs.join(format!("{image}.ext4.fetching.1-2-3")), b"part").unwrap();
    fs::write(rootfs.join(format!("{image}.ext4")), b"whole").unwrap();
    fs::write(rootfs.join("not-an-image"), b"other").unwrap();
    let cache = Cache::open(rootfs.clone(), WEEK, Ownership::detached()).unwrap();
    let mut names: Vec<_> = fs::read_dir(&rootfs)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, [format!("{image}.ext4"), "not-an-image".to_owned()]);
    assert!(cache.hold(image).await.is_some());
}
