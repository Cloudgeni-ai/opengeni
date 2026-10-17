//! What the agent tells about itself: the wide events of its steps,
//! requests and streams, the causes and trace context they carry, and the
//! alarms it raises.

use std::sync::Arc;
use std::time::Duration;

use compute_core::{HostPolicy, Level, Priority};
use compute_host::observe::canary::{self, CanaryConfig, CanaryIds};
use compute_host::observe::{
    Alarm, CanaryOutcome, CanaryPath, Event, ObserveConfig, Observer, RequestKind, Severity,
    TraceContext, Value,
};
use compute_host::protocol::{Id, LevelName, PriorityName, Reply, Request, SandboxConfig};
use compute_host::{Directory, Handle, HostAgent, NoStore, Store};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::mpsc;
use tokio::time::Instant;

use super::{Delays, Fake, Lab, NEVER, SAVE_IN_PLACE, SAVE_QUICKLY, World, id};

const TRACE: &str = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

/// A lab whose agent sends every event to the returned receiver.
async fn watched() -> (Lab, Observer, mpsc::Receiver<Event>) {
    let (tap, events) = mpsc::channel(4096);
    let mut kept = None;
    let lab = Lab::start_configured(
        Lab::root(),
        Arc::default(),
        Delays::default(),
        HostPolicy::default(),
        |config| {
            let observer = Observer::start(ObserveConfig {
                journal: false,
                tap: Some(tap),
                ..ObserveConfig::default()
            });
            kept = Some(observer.clone());
            config.observer = observer;
        },
    )
    .await;
    (lab, kept.unwrap(), events)
}

fn text<'a>(event: &'a Event, key: &str) -> Option<&'a str> {
    match event.get(key)? {
        Value::Str(text) => Some(text),
        _ => None,
    }
}

fn int(event: &Event, key: &str) -> Option<i64> {
    match event.get(key)? {
        Value::Int(number) => Some(*number),
        _ => None,
    }
}

/// Every event up to and including the first that `wanted` accepts.
async fn until(events: &mut mpsc::Receiver<Event>, wanted: impl Fn(&Event) -> bool) -> Vec<Event> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut seen = Vec::new();
    loop {
        let event = tokio::time::timeout_at(deadline, events.recv())
            .await
            .unwrap_or_else(|_| panic!("the event never came; saw {seen:#?}"))
            .unwrap();
        let done = wanted(&event);
        seen.push(event);
        if done {
            return seen;
        }
    }
}

fn is(event: &Event, name: &str, key: &str, value: &str) -> bool {
    event.name == name && text(event, key) == Some(value)
}

/// Sends `request` with a trace context, as a caller instrumented with
/// OpenTelemetry would.
async fn traced(lab: &Lab, request: &Request) -> Reply {
    let mut json = serde_json::to_value(request).unwrap();
    json["traceparent"] = TRACE.into();
    let stream = UnixStream::connect(lab.root.join("host.sock"))
        .await
        .unwrap();
    let mut stream = BufReader::new(stream);
    let mut line = json.to_string();
    line.push('\n');
    stream.get_mut().write_all(line.as_bytes()).await.unwrap();
    let mut reply = String::new();
    stream.read_line(&mut reply).await.unwrap();
    serde_json::from_str(&reply).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_traced_wake_and_the_step_it_caused_share_the_trace() {
    let (lab, observer, mut events) = watched().await;
    let sandbox = id(60);
    lab.create(sandbox, NEVER).await;
    let reply = traced(
        &lab,
        &Request::Wake {
            id: sandbox,
            generation: None,
            priority: PriorityName::Interactive,
        },
    )
    .await;
    assert!(matches!(reply, Reply::Woken { .. }), "{reply:?}");
    let seen = until(&mut events, |event| {
        is(event, "compute.request", "compute.request", "wake")
    })
    .await;
    let trace: TraceContext = TRACE.parse().unwrap();
    let boot = seen
        .iter()
        .find(|event| is(event, "compute.step", "compute.step", "boot"))
        .expect("the boot's event comes before the reply's");
    assert_eq!(text(boot, "compute.cause"), Some("request"));
    assert_eq!(text(boot, "compute.outcome"), Some("done"));
    assert_eq!(text(boot, "compute.level.after"), Some("running"));
    assert_eq!(boot.trace, Some(trace));
    assert_eq!(
        text(boot, "compute.sandbox.id"),
        Some(sandbox.to_string().as_str())
    );
    for phase in ["compute.phase.prepare_us", "compute.phase.launch_us"] {
        assert!(int(boot, phase).is_some(), "{phase} in {boot:#?}");
    }
    let wake = seen.last().unwrap();
    assert_eq!(wake.trace, Some(trace));
    assert_eq!(text(wake, "compute.result"), Some("ok"));
    assert_eq!(text(wake, "compute.during"), None, "no step was under way");
    assert_eq!(
        int(wake, "compute.op.id"),
        int(boot, "compute.op.id"),
        "the request names the step it joined"
    );
    let create = seen
        .iter()
        .find(|event| is(event, "compute.request", "compute.request", "create"))
        .unwrap();
    assert_eq!(create.trace, None, "only traced requests carry a trace");

    // A traced sleep: every step down to the level it asked for carries
    // the trace; a later wake nobody traced does not.
    let sleep = Request::Sleep {
        id: sandbox,
        generation: None,
        level: LevelName::Saved,
    };
    assert_eq!(traced(&lab, &sleep).await, Reply::Done);
    let seen = until(&mut events, |event| {
        is(event, "compute.step", "compute.step", "save")
    })
    .await;
    for step in ["pause", "save"] {
        let event = seen
            .iter()
            .find(|event| is(event, "compute.step", "compute.step", step))
            .unwrap();
        assert_eq!(text(event, "compute.cause"), Some("request"), "{step}");
        assert_eq!(event.trace, Some(trace), "{step}");
    }
    let pause = seen
        .iter()
        .find(|event| is(event, "compute.step", "compute.step", "pause"))
        .unwrap();
    assert_eq!(text(pause, "compute.level.before"), Some("running"));
    assert_eq!(text(pause, "compute.level.after"), Some("paused"));
    lab.wait_level(sandbox, LevelName::Saved).await;
    assert!(matches!(lab.wake(sandbox).await, Reply::Woken { .. }));
    let seen = until(&mut events, |event| {
        is(event, "compute.request", "compute.request", "wake")
    })
    .await;
    let wake = seen
        .iter()
        .find(|event| {
            event.name == "compute.step" && text(event, "compute.level.after") == Some("running")
        })
        .expect("a step woke it");
    assert_eq!(text(wake, "compute.cause"), Some("request"));
    assert_eq!(wake.trace, None);
    assert_eq!(seen.last().unwrap().trace, None);
    assert_eq!(observer.metrics().requests(RequestKind::Wake, None), 2);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn renewing_a_hold_or_reading_status_is_only_counted() {
    let (lab, observer, mut events) = watched().await;
    let sandbox = id(61);
    lab.create(sandbox, NEVER).await;
    let hold = Request::Hold {
        id: sandbox,
        generation: None,
        hold: "job".into(),
        ttl_ms: Some(60_000),
        priority: PriorityName::Background,
    };
    for _ in 0..3 {
        assert_eq!(lab.client.call(&hold).await.unwrap(), Reply::Done);
    }
    lab.status().await;
    let release = Request::Release {
        id: sandbox,
        generation: None,
        hold: "job".into(),
    };
    assert_eq!(lab.client.call(&release).await.unwrap(), Reply::Done);
    let seen = until(&mut events, |event| {
        is(event, "compute.request", "compute.request", "release")
    })
    .await;
    let requests: Vec<&str> = seen
        .iter()
        .filter(|event| event.name == "compute.request")
        .filter_map(|event| text(event, "compute.request"))
        .collect();
    assert_eq!(requests, ["create", "hold", "release"]);
    let metrics = observer.metrics();
    assert_eq!(metrics.requests(RequestKind::Hold, None), 3);
    assert!(metrics.requests(RequestKind::Status, None) >= 1);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn idle_sleeps_and_streams_tell_what_they_did() {
    let (lab, _observer, mut events) = watched().await;
    let sandbox = id(62);
    lab.create(sandbox, SAVE_IN_PLACE).await;
    assert_eq!(lab.run(sandbox, &["set hello"]).await, ["ok"]);
    let seen = until(&mut events, |event| event.name == "compute.stream").await;
    let stream = seen.last().unwrap();
    assert_eq!(text(stream, "compute.stream.end"), Some("finished"));
    assert_eq!(int(stream, "compute.port"), Some(52));
    // "set hello\nexit\n" in, "ok\n" out.
    assert_eq!(int(stream, "compute.bytes.to_guest"), Some(15));
    assert_eq!(int(stream, "compute.bytes.to_client"), Some(3));
    let connect = seen
        .iter()
        .find(|event| is(event, "compute.request", "compute.request", "connect"))
        .expect("the connection is told once when established");
    assert_eq!(text(connect, "compute.result"), Some("ok"));

    let seen = until(&mut events, |event| {
        is(event, "compute.step", "compute.step", "save")
    })
    .await;
    for step in ["pause", "save"] {
        let event = seen
            .iter()
            .find(|event| is(event, "compute.step", "compute.step", step))
            .unwrap();
        assert_eq!(text(event, "compute.cause"), Some("idle"), "{step}");
    }
    let save = seen.last().unwrap();
    assert_eq!(text(save, "compute.durability.after"), Some("local"));
    assert!(
        int(save, "compute.phase.snapshot_us").is_some(),
        "{save:#?}"
    );
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_damaged_image_raises_its_alarms_once_each() {
    let (lab, observer, mut events) = watched().await;
    let sandbox: Id = id(63);
    lab.create(sandbox, SAVE_QUICKLY).await;
    lab.run(sandbox, &["set hello"]).await;
    lab.wait_level(sandbox, LevelName::Saved).await;
    let memory = super::sleep::current_image_memory(&lab, sandbox);
    let mut bytes = std::fs::read(&memory).unwrap();
    bytes[0] ^= 0xff;
    std::fs::write(&memory, bytes).unwrap();
    *lab.world.refuse_restores.lock().unwrap() = 1;
    assert_eq!(lab.run(sandbox, &["get"]).await, [""], "booted fresh");

    let seen = until(&mut events, |event| {
        is(event, "compute.alarm", "compute.alarm", "quarantined")
    })
    .await;
    let failed = seen
        .iter()
        .find(|event| {
            is(
                event,
                "compute.alarm",
                "compute.alarm",
                "verification_failed",
            )
        })
        .unwrap();
    assert_eq!(
        text(failed, "compute.sandbox.id"),
        Some(sandbox.to_string().as_str())
    );
    assert_eq!(text(failed, "compute.step"), Some("restore"));
    let metrics = observer.metrics();
    assert_eq!(metrics.alarms(Alarm::VerificationFailed), 1);
    assert_eq!(metrics.alarms(Alarm::Quarantined), 1);
    assert_eq!(metrics.alarms(Alarm::Broken), 0);
    assert_eq!(metrics.alarms(Alarm::CopyLost), 0);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_image_found_damaged_at_start_raises_its_alarms() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox: Id = id(64);
    lab.create(sandbox, SAVE_QUICKLY).await;
    lab.run(sandbox, &["set hello"]).await;
    lab.wait_level(sandbox, LevelName::Saved).await;
    let memory = super::sleep::current_image_memory(&lab, sandbox);
    let (root, world) = lab.stop().await;
    std::fs::remove_file(memory.with_file_name("state")).unwrap();

    let (tap, mut events) = mpsc::channel(4096);
    let mut kept = None;
    let lab = Lab::start_configured(
        root,
        world,
        Delays::default(),
        HostPolicy::default(),
        |config| {
            let observer = Observer::start(ObserveConfig {
                journal: false,
                tap: Some(tap),
                ..ObserveConfig::default()
            });
            kept = Some(observer.clone());
            config.observer = observer;
        },
    )
    .await;
    let observer = kept.unwrap();
    let mut raised = Vec::new();
    while raised.len() < 4 {
        let seen = until(&mut events, |event| event.name == "compute.alarm").await;
        let alarm = seen.last().unwrap();
        assert_eq!(
            text(alarm, "compute.sandbox.id"),
            Some(sandbox.to_string().as_str())
        );
        raised.push(text(alarm, "compute.alarm").unwrap().to_owned());
    }
    raised.sort();
    assert_eq!(
        raised,
        [
            "copy_lost",
            "programs_lost",
            "quarantined",
            "verification_failed"
        ]
    );
    let metrics = observer.metrics();
    for alarm in [
        Alarm::VerificationFailed,
        Alarm::Quarantined,
        Alarm::CopyLost,
        Alarm::ProgramsLost,
    ] {
        assert_eq!(metrics.alarms(alarm), 1, "{alarm:?}");
    }
    assert_eq!(lab.run(sandbox, &["get"]).await, [""], "booted fresh");
    lab.assert_clean();
}

/// An agent on a fresh lab root with `store`, whose events go to the
/// returned receiver.
async fn agent_with<S: Store>(
    world: Arc<World>,
    store: impl FnOnce(&std::path::Path) -> S,
) -> (Handle, Observer, mpsc::Receiver<Event>) {
    let root = Lab::root();
    let (tap, events) = mpsc::channel(4096);
    let mut config = Lab::config(&root, HostPolicy::default());
    config.observer = Observer::start(ObserveConfig {
        journal: false,
        tap: Some(tap),
        ..ObserveConfig::default()
    });
    let observer = config.observer.clone();
    let engine = Fake {
        world,
        delays: Delays::default(),
    };
    let (handle, _agent) = HostAgent::start(config, engine, store(&root))
        .await
        .unwrap();
    (handle, observer, events)
}

/// Runs the canary until it reported `runs` times, and returns what each
/// run reported.
async fn canary_runs(
    handle: Handle,
    events: &mut mpsc::Receiver<Event>,
    canary: CanaryConfig,
    runs: usize,
) -> Vec<Event> {
    let running = tokio::spawn(canary::run(handle, canary));
    let mut reported = Vec::new();
    while reported.len() < runs {
        let seen = until(events, |event| event.name == "compute.canary").await;
        reported.push(seen.last().unwrap().clone());
    }
    running.abort();
    reported
}

fn outcomes(reported: &[Event]) -> Vec<(&str, &str)> {
    reported
        .iter()
        .map(|event| {
            (
                text(event, "compute.canary.path").unwrap(),
                text(event, "compute.outcome").unwrap(),
            )
        })
        .collect()
}

const IDS: CanaryIds = CanaryIds {
    sandbox: Id(compute_core::SandboxId(
        0xca4a_7900_0000_0000_0000_0000_0007_0001,
    )),
    fresh: Id(compute_core::SandboxId(
        0xca4a_7900_0000_0000_0000_0000_0007_0002,
    )),
};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_canary_reports_every_path() {
    let (handle, observer, mut events) =
        agent_with(Arc::default(), |root| Directory::new(root.join("store"))).await;
    let canary = CanaryConfig {
        port: Some(52),
        ..CanaryConfig::new(Duration::from_millis(20), true, IDS)
    };
    let paths = canary.paths();
    assert_eq!(paths, CanaryPath::ALL);
    // Each path once, then the first again: the sandbox it left serves on.
    let reported = canary_runs(handle, &mut events, canary, paths.len() + 1).await;
    assert_eq!(
        outcomes(&reported),
        [
            ("resume", "ok"),
            ("restore", "ok"),
            ("remote", "ok"),
            ("create", "ok"),
            ("resume", "ok"),
        ]
    );
    for run in &reported {
        assert_eq!(run.severity, Severity::Info);
        assert!(int(run, "compute.wake_us").is_some(), "{run:#?}");
        assert!(
            int(run, "compute.connect_us").is_some(),
            "the guest answered"
        );
        assert!(int(run, "compute.op.id").is_some(), "a wake step ran");
    }
    assert_eq!(
        text(&reported[2], "compute.sandbox.id"),
        Some(IDS.sandbox.to_string().as_str())
    );
    assert_eq!(
        text(&reported[3], "compute.sandbox.id"),
        Some(IDS.fresh.to_string().as_str())
    );
    let metrics = observer.metrics();
    assert_eq!(
        metrics.canary_runs(CanaryPath::Resume, CanaryOutcome::Ok),
        2
    );
    assert_eq!(
        metrics.canary_runs(CanaryPath::Remote, CanaryOutcome::Ok),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_canary_path_its_host_cannot_take_fails_and_says_so() {
    let (handle, observer, mut events) = agent_with(Arc::default(), |_| NoStore).await;
    // Claimed for a host without a store.
    let canary = CanaryConfig::new(Duration::from_millis(20), true, IDS);
    let reported = canary_runs(handle, &mut events, canary, 3).await;
    assert_eq!(
        outcomes(&reported),
        [("resume", "ok"), ("restore", "ok"), ("remote", "failed")]
    );
    let remote = &reported[2];
    assert_eq!(remote.severity, Severity::Error);
    assert!(text(remote, "compute.error").is_some(), "{remote:#?}");
    assert_eq!(
        observer
            .metrics()
            .canary_runs(CanaryPath::Remote, CanaryOutcome::Failed),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_canary_wake_that_booted_afresh_fails() {
    // Every resume loses the VM, so the host falls back to booting the
    // sandbox afresh: it runs, but what ran in it is gone.
    let world = Arc::new(World::default());
    world
        .lose_resumes
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let (handle, observer, mut events) = agent_with(world, |_| NoStore).await;
    let canary = CanaryConfig {
        timeout: Duration::from_secs(10),
        ..CanaryConfig::new(Duration::from_millis(20), false, IDS)
    };
    let reported = canary_runs(handle, &mut events, canary, 1).await;
    assert_eq!(outcomes(&reported), [("resume", "failed")]);
    assert_eq!(reported[0].severity, Severity::Error);
    assert_eq!(
        observer
            .metrics()
            .canary_runs(CanaryPath::Resume, CanaryOutcome::Failed),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_traced_wake_from_the_store_carries_its_trace_to_the_end() {
    let (handle, _observer, mut events) =
        agent_with(Arc::default(), |root| Directory::new(root.join("store"))).await;
    let sandbox = id(61);
    handle
        .create(sandbox, SandboxConfig::new(1, 128, NEVER))
        .await
        .unwrap();
    drop(
        handle
            .acquire(sandbox, None, Priority::Interactive)
            .await
            .unwrap(),
    );
    handle.sleep(sandbox, None, Level::Remote).await.unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    while !handle
        .status()
        .await
        .unwrap()
        .sandboxes
        .iter()
        .any(|status| {
            status.id == sandbox && status.level == LevelName::Remote && status.step.is_none()
        })
    {
        assert!(Instant::now() < deadline, "never got to the store");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let trace: TraceContext = TRACE.parse().unwrap();
    drop(
        handle
            .traced(Some(trace))
            .acquire(sandbox, None, Priority::Interactive)
            .await
            .unwrap(),
    );
    let seen = until(&mut events, |event| {
        is(event, "compute.step", "compute.step", "restore")
    })
    .await;
    let steps: Vec<(&str, Option<TraceContext>)> = seen
        .iter()
        .filter(|event| event.name == "compute.step")
        .filter(|event| event.trace.is_some() || text(event, "compute.cause") == Some("request"))
        .map(|event| (text(event, "compute.step").unwrap(), event.trace))
        .collect();
    let woke: Vec<_> = steps
        .iter()
        .skip_while(|(step, _)| *step != "fetch")
        .copied()
        .collect();
    assert_eq!(
        woke,
        [("fetch", Some(trace)), ("restore", Some(trace))],
        "{steps:?}"
    );
}
