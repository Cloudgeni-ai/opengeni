//! The request protocol and guest connections.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use compute_core::HostPolicy;
use compute_host::GuestPort;
use compute_host::protocol::{
    ErrorCode, LevelName, PriorityName, Reply, Request, SandboxConfig, SleepConfig,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, UnixStream};
use tokio::time::Instant;

use super::{Delays, Lab, NEVER, PAUSE_SOON, SAVE_IN_PLACE, SAVE_QUICKLY, id};

/// `request` as the line a client sends.
fn request_line(request: &Request) -> Vec<u8> {
    let mut line = serde_json::to_vec(request).unwrap();
    line.push(b'\n');
    line
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn status_says_what_the_host_runs() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    assert_eq!(lab.status().await.about.runtime, "fake");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_wake_its_caller_gave_up_on_lets_go_of_the_sandbox() {
    let delays = Delays {
        boot: Duration::from_secs(5),
        ..Delays::default()
    };
    let lab = Lab::new(delays, HostPolicy::default()).await;
    let sandbox = id(9);
    lab.create(sandbox, PAUSE_SOON).await;
    let mut caller = UnixStream::connect(lab.root.join("host.sock"))
        .await
        .unwrap();
    let wake = Request::Wake {
        id: sandbox,
        generation: None,
        priority: PriorityName::Interactive,
    };
    caller.write_all(&request_line(&wake)).await.unwrap();
    lab.wait_until("the wake to hold the sandbox", |status| {
        Lab::sandbox(status, sandbox).holds == 1
    })
    .await;
    // The caller hangs up long before the boot could finish: nothing
    // keeps the sandbox awake for it any more.
    drop(caller);
    let gone = Instant::now();
    lab.wait_until("the abandoned wake to let go", |status| {
        Lab::sandbox(status, sandbox).holds == 0
    })
    .await;
    assert!(
        gone.elapsed() < Duration::from_secs(2),
        "held until the boot ended: {:?}",
        gone.elapsed()
    );
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bytes_sent_before_a_connection_is_ready_reach_the_guest() {
    let delays = Delays {
        boot: Duration::from_millis(200),
        ..Delays::default()
    };
    let lab = Lab::new(delays, HostPolicy::default()).await;
    let sandbox = id(10);
    lab.create(sandbox, NEVER).await;
    let mut caller = UnixStream::connect(lab.root.join("host.sock"))
        .await
        .unwrap();
    let mut bytes = request_line(&Request::Connect {
        id: sandbox,
        generation: None,
        port: 52,
        priority: PriorityName::Interactive,
    });
    bytes.extend_from_slice(b"set early\nget\nexit\n");
    caller.write_all(&bytes).await.unwrap();
    let mut output = String::new();
    caller.read_to_string(&mut output).await.unwrap();
    let (reply, rest) = output.split_once('\n').unwrap();
    assert!(
        matches!(
            serde_json::from_str::<Reply>(reply).unwrap(),
            Reply::Connected { .. }
        ),
        "{reply}"
    );
    assert_eq!(rest, "ok\nearly\n");
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_caller_that_has_sent_everything_still_gets_its_answer() {
    let delays = Delays {
        boot: Duration::from_millis(200),
        ..Delays::default()
    };
    let lab = Lab::new(delays, HostPolicy::default()).await;
    let sandbox = id(11);
    lab.create(sandbox, NEVER).await;
    // A wake whose caller closes its sending side right after asking.
    let mut caller = UnixStream::connect(lab.root.join("host.sock"))
        .await
        .unwrap();
    let wake = Request::Wake {
        id: sandbox,
        generation: None,
        priority: PriorityName::Interactive,
    };
    caller.write_all(&request_line(&wake)).await.unwrap();
    caller.shutdown().await.unwrap();
    let mut output = String::new();
    caller.read_to_string(&mut output).await.unwrap();
    assert!(
        matches!(
            serde_json::from_str::<Reply>(output.trim_end()).unwrap(),
            Reply::Woken { .. }
        ),
        "{output}"
    );
    // A connection whose caller sends its input and closes: the guest gets
    // the input, then the end of it, and the caller every answer.
    let mut caller = UnixStream::connect(lab.root.join("host.sock"))
        .await
        .unwrap();
    let mut bytes = request_line(&Request::Connect {
        id: sandbox,
        generation: None,
        port: 52,
        priority: PriorityName::Interactive,
    });
    bytes.extend_from_slice(b"set early\nget\n");
    caller.write_all(&bytes).await.unwrap();
    caller.shutdown().await.unwrap();
    let mut output = String::new();
    tokio::time::timeout(Duration::from_secs(10), caller.read_to_string(&mut output))
        .await
        .expect("the guest sees the end of the input")
        .unwrap();
    let (reply, rest) = output.split_once('\n').unwrap();
    assert!(
        matches!(
            serde_json::from_str::<Reply>(reply).unwrap(),
            Reply::Connected { .. }
        ),
        "{reply}"
    );
    assert_eq!(rest, "ok\nearly\n");
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_caller_that_sent_much_and_hung_up_lets_go_of_the_sandbox() {
    let delays = Delays {
        boot: Duration::from_secs(5),
        ..Delays::default()
    };
    let lab = Lab::new(delays, HostPolicy::default()).await;
    let sandbox = id(12);
    lab.create(sandbox, PAUSE_SOON).await;
    let mut caller = UnixStream::connect(lab.root.join("host.sock"))
        .await
        .unwrap();
    let mut bytes = request_line(&Request::Connect {
        id: sandbox,
        generation: None,
        port: 52,
        priority: PriorityName::Interactive,
    });
    // More than any buffer the agent might keep for the guest.
    bytes.extend(std::iter::repeat_n(b'x', 96 << 10));
    let _ = tokio::time::timeout(Duration::from_secs(1), caller.write_all(&bytes)).await;
    lab.wait_until("the connection to hold the sandbox", |status| {
        Lab::sandbox(status, sandbox).holds == 1
    })
    .await;
    drop(caller);
    let gone = Instant::now();
    lab.wait_until("the abandoned connection to let go", |status| {
        Lab::sandbox(status, sandbox).holds == 0
    })
    .await;
    assert!(
        gone.elapsed() < Duration::from_secs(2),
        "held until the boot ended: {:?}",
        gone.elapsed()
    );
    lab.assert_clean();
}

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
    // A repeat with the same settings is a retry and succeeds; other
    // settings for an existing id are refused.
    let reply = lab
        .client
        .call(&Request::Create {
            id: missing,
            config: SandboxConfig {
                vcpus: 1,
                memory_mib: 512,
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
