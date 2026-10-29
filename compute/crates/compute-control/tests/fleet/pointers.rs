//! A fleet's pointers move from its object store into the service once no
//! host of an earlier release is live, and hosts reach them only under a
//! registration the service knows (ADR 25).

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use compute_fleet::{OwnerEpoch, Stamp};
use compute_protocol::fleet::{
    Capacity, POINTER_READ_PATH, POINTER_WRITE_PATH, PointerFound, PointerRead, PointerWrite,
    PointerWritten, REGISTER_PATH,
};
use compute_storage::pointer_store::PointerStore as _;
use compute_storage::store::ChunkStore;

use crate::support::{FakeHost, Fleet, Seed, register_of, roomy, until};

const NAME: &str = "s-kept-by-an-earlier-host";

fn earlier() -> Capacity {
    Capacity {
        pointers_in_service: false,
        ..roomy()
    }
}

async fn read(fleet: &Fleet, host: &str, epoch: u64) -> (u16, String) {
    let read = PointerRead {
        epoch,
        name: NAME.into(),
    };
    fleet.post_as_host(host, POINTER_READ_PATH, &read).await
}

#[tokio::test(flavor = "multi_thread")]
async fn pointers_an_earlier_release_kept_move_into_the_service_once_none_of_its_hosts_is_live() {
    // A pointer a host of an earlier release kept in the object store, and
    // that host still registered.
    let objects = ChunkStore::new(
        Arc::new(object_store::memory::InMemory::new()),
        object_store::path::Path::from("fleet"),
    );
    let stamp = Stamp {
        epoch: OwnerEpoch(4),
        save: 2,
    };
    objects
        .object_pointers()
        .write(NAME, stamp, Bytes::from_static(b"an earlier copy"), None)
        .await
        .unwrap()
        .expect("created");
    // It never renews, and is given up on a few seconds after its lease
    // lapses: time enough to see the move wait for it.
    let fleet = Fleet::start_seeded(
        Seed {
            objects: Some(objects.clone()),
            hosts: vec![register_of("host-earlier", earlier())],
        },
        |settings| settings.give_up_after = Duration::from_secs(4),
    )
    .await;

    // A host of this release joins, but reads no pointer while the earlier
    // host may still write its own to the object store.
    let host = FakeHost::start(&fleet, "host-now", roomy()).await;
    let (status, body) = read(&fleet, "host-now", host.epoch()).await;
    assert_eq!(status, 503, "read before the move: {body}");
    assert!(
        objects.check_pointers().await.is_ok(),
        "the object store was marked before the move"
    );

    // Once the earlier host is given up on, the pointer is in the service.
    let mut found = String::new();
    until(
        Duration::from_secs(20),
        "the pointers move in",
        async || {
            let (status, body) = read(&fleet, "host-now", host.epoch()).await;
            found = body;
            status == 200
        },
    )
    .await;
    let kept = serde_json::from_str::<PointerFound>(&found)
        .unwrap()
        .kept
        .expect("the earlier pointer");
    assert_eq!(kept.pointer, b"an earlier copy");
    assert_eq!((kept.owner_epoch, kept.owner_save), (4, 2));

    // The object store's pointers are marked as moved: a host on its own,
    // or a sweep by them, refuses the store.
    let refused = objects.check_pointers().await;
    assert!(
        matches!(refused, Err(compute_storage::Error::Unsupported(_))),
        "{refused:?}"
    );

    // A write lands only on the version it read, and once.
    let write = |on| PointerWrite {
        epoch: host.epoch(),
        name: NAME.into(),
        owner_epoch: 5,
        owner_save: 1,
        pointer: b"a newer copy".to_vec(),
        on,
    };
    let (status, body) = fleet
        .post_as_host("host-now", POINTER_WRITE_PATH, &write(Some(kept.version)))
        .await;
    assert_eq!(status, 200, "{body}");
    let written: PointerWritten = serde_json::from_str(&body).unwrap();
    let version = written.version.expect("written on the version read");
    assert_ne!(version, kept.version);
    let (status, body) = fleet
        .post_as_host("host-now", POINTER_WRITE_PATH, &write(Some(kept.version)))
        .await;
    assert_eq!(status, 200, "{body}");
    let late: PointerWritten = serde_json::from_str(&body).unwrap();
    assert_eq!(late.version, None, "a write on a replaced version landed");
    let (status, body) = fleet
        .post_as_host("host-now", POINTER_WRITE_PATH, &write(None))
        .await;
    assert_eq!(status, 200, "{body}");
    let twice: PointerWritten = serde_json::from_str(&body).unwrap();
    assert_eq!(twice.version, None, "a create over a kept pointer landed");

    // A registration the service does not know, and another host's, are
    // refused.
    let (status, body) = read(&fleet, "host-now", host.epoch() + 1_000).await;
    assert_eq!(status, 404, "an unknown registration read: {body}");
    let (status, body) = read(&fleet, "host-other", host.epoch()).await;
    assert_eq!(status, 404, "another host's registration read: {body}");

    // From now on a host of the earlier release is refused registration.
    let (status, body) = fleet
        .post_as_host(
            "host-earlier",
            REGISTER_PATH,
            &register_of("host-earlier", earlier()),
        )
        .await;
    assert_eq!(
        status, 409,
        "an earlier host registered after the move: {body}"
    );
}
