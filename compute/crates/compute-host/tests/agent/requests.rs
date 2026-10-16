//! The request protocol and guest connections.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use compute_core::HostPolicy;
use compute_host::GuestPort;
use compute_host::protocol::{
    ErrorCode, LevelName, PriorityName, Reply, Request, SandboxConfig, SleepConfig,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, UnixStream};

use super::{Delays, Lab, NEVER, SAVE_IN_PLACE, SAVE_QUICKLY, id};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bad_requests_are_refused() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let missing = id(8);
    let reply = lab
        .client
        .call(&Request::Wake {
            id: missing,
            generation: None,
            priority: PriorityName::Interactive,
        })
        .await
        .unwrap();
    assert!(
        matches!(
            reply,
            Reply::Error {
                code: ErrorCode::NotFound,
                ..
            }
        ),
        "{reply:?}"
    );
    let config = SandboxConfig {
        vcpus: 1,
        memory_mib: 256,
        memory_request_mib: None,
        cpu_request_millis: None,
        sleep: SleepConfig {
            archive_after_ms: Some(90),
            ..SAVE_IN_PLACE
        },
    };
    let reply = lab
        .client
        .call(&Request::Create {
            id: missing,
            config,
        })
        .await
        .unwrap();
    assert!(
        matches!(&reply, Reply::Error { message, .. } if message.contains("store")),
        "{reply:?}"
    );
    let reply = lab
        .client
        .call(&Request::Create {
            id: missing,
            config: SandboxConfig {
                vcpus: 1,
                memory_mib: 256,
                memory_request_mib: None,
                cpu_request_millis: None,
                sleep: SleepConfig {
                    save_after_ms: Some(10),
                    ..NEVER
                },
            },
        })
        .await
        .unwrap();
    assert!(
        matches!(&reply, Reply::Error { message, .. } if message.contains("pause")),
        "saving needs pausing first: {reply:?}"
    );
    lab.create(missing, NEVER).await;
    let reply = lab
        .client
        .call(&Request::Create {
            id: missing,
            config: SandboxConfig {
                vcpus: 1,
                memory_mib: 256,
                memory_request_mib: None,
                cpu_request_millis: None,
                sleep: NEVER,
            },
        })
        .await
        .unwrap();
    assert!(matches!(reply, Reply::Error { .. }), "{reply:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn data_for_a_sleeping_sandbox_wakes_it() {
    let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = upstream.local_addr().unwrap();
    let ports: Vec<GuestPort> = vec![format!("4222={address},wake").parse().unwrap()];
    let lab = Lab::start_configured(
        Lab::root(),
        Arc::default(),
        Delays::default(),
        HostPolicy::default(),
        |config| config.guest_ports = ports,
    )
    .await;
    let sandbox = id(10);
    lab.create(
        sandbox,
        SleepConfig {
            pause_after_ms: Some(30),
            ..NEVER
        },
    )
    .await;
    lab.run(sandbox, &["set up"]).await;

    // The test plays the guest: it opens a connection to its host, the way
    // an agent inside the VM dials vsock address 2.
    let socket = lab.sandbox_dir(sandbox).join("root/vsock.sock_4222");
    let mut guest = UnixStream::connect(&socket).await.unwrap();
    let (mut server, _) = upstream.accept().await.unwrap();
    guest.write_all(b"hello").await.unwrap();
    let mut hello = [0; 5];
    server.read_exact(&mut hello).await.unwrap();
    assert_eq!(&hello, b"hello");

    lab.wait_level(sandbox, LevelName::Paused).await;
    let resumes = lab.world.resumes.load(Ordering::SeqCst);
    server.write_all(b"wake up").await.unwrap();
    lab.wait_until("inbound data to wake the sandbox", |_| {
        lab.world.resumes.load(Ordering::SeqCst) > resumes
    })
    .await;
    let mut message = [0; 7];
    guest.read_exact(&mut message).await.unwrap();
    assert_eq!(&message, b"wake up");

    // Removing the sandbox closes its listeners and their sockets.
    lab.client
        .call(&Request::Remove {
            id: sandbox,
            generation: None,
        })
        .await
        .unwrap();
    assert!(!socket.exists());
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restored_guest_is_told_before_anything_else_reaches_it() {
    let lab = Lab::start_configured(
        Lab::root(),
        Arc::default(),
        Delays::default(),
        HostPolicy::default(),
        |config| config.restore_notice_port = Some(53),
    )
    .await;
    let sandbox = id(11);
    lab.create(sandbox, SAVE_QUICKLY).await;
    // A freshly booted guest has nothing stale to fix.
    assert_eq!(lab.run(sandbox, &["told-restored?"]).await, ["false"]);

    lab.wait_level(sandbox, LevelName::Saved).await;
    // The first thing to reach the restored guest finds it already told.
    assert_eq!(lab.run(sandbox, &["told-restored?"]).await, ["true"]);
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 1);
    lab.assert_clean();
}
