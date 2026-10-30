//! A host in a fleet whose agent restarts keeps the lease it holds while
//! the old agent stops and the new one takes back its sandboxes, however
//! long either takes: the guard never freezes their VMs and the service
//! never gives the host up. And a host keeps its pointers in the service,
//! under the registration it holds (ADR 25).

use std::net::{Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use bytes::Bytes;
use compute_core::HostPolicy;
use compute_fleet::{LeaseTerms, OwnerEpoch, Stamp};
use compute_host::fleet::{
    FleetConfig, Joined, Telling, Tls, TlsFiles, hold_lock, ready_lock, wire_terms,
};
use compute_host::protocol::{ErrorCode, Reply, Request};
use compute_host::{HostAgent, NoStore};
use compute_protocol::fleet::{
    Answer, Boot, Envelope, HostInfo, KeptPointer, POINTER_READ_PATH, POINTER_WRITE_PATH,
    PointerFound, PointerRead, PointerWrite, PointerWritten, REGISTER_PATH, RENEW_PATH,
    REPORT_PATH, Register, Registered, Renew, Renewed, Report, Ruling, Sent, Verdict,
};
use compute_storage::pointer_store::{PointerStore as _, Version};
use http_body_util::{BodyExt as _, Full};
use hyper_util::rt::TokioIo;
use rcgen::{BasicConstraints, CertificateParams, IsCa, KeyPair};
use rustls::pki_types::ServerName;
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{Instant, sleep, timeout};
use tokio_rustls::{TlsAcceptor, TlsConnector};

use super::{Delays, Fake, Lab, NEVER, World, id};

/// The registration the fake service gives.
const HOST: u64 = 1;
const EPOCH: u64 = 5;
/// How far the fake service's clock, the fleet's, runs ahead of the
/// host's.
const FLEET_AHEAD: Duration = Duration::from_secs(2 * 86_400);

/// The fleet's clock, as the fake service tells it.
fn fleet_now_ms() -> u64 {
    let now = SystemTime::now() + FLEET_AHEAD;
    u64::try_from(
        now.duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

/// A two-second term, renewed every 200 ms, with the margin the rules
/// need in whole milliseconds, as the service sends terms.
fn terms() -> LeaseTerms {
    let mut terms = LeaseTerms {
        term: Duration::from_secs(2),
        margin: Duration::from_secs(1),
        renew_every: Duration::from_millis(200),
        register_every: Duration::from_millis(200),
        request_window: 50,
        watchdog: Duration::from_secs(1),
        stop: Duration::from_millis(200),
        rate_error_ppm: 1_000,
    };
    let needed = terms.needed_margin().as_millis() + 1;
    terms.margin = Duration::from_millis(u64::try_from(needed).unwrap());
    terms.validate().expect("valid test terms")
}

/// One authority for the hosts and the service, as a fleet has.
struct Authority {
    cert: rcgen::Certificate,
    key: KeyPair,
}

impl Authority {
    fn new() -> Self {
        let key = KeyPair::generate().unwrap();
        let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let cert = params.self_signed(&key).unwrap();
        Self { cert, key }
    }

    /// Files for `name`, valid for `localhost`, trusting this authority.
    fn issue(&self, dir: &Path, name: &str) -> TlsFiles {
        let key = KeyPair::generate().unwrap();
        let params = CertificateParams::new(vec!["localhost".to_owned()]).unwrap();
        let cert = params.signed_by(&key, &self.cert, &self.key).unwrap();
        let files = TlsFiles {
            cert: dir.join(format!("{name}.pem")),
            key: dir.join(format!("{name}.key")),
            peer_ca: dir.join(format!("{name}-ca.pem")),
        };
        std::fs::write(&files.cert, cert.pem()).unwrap();
        std::fs::write(&files.key, key.serialize_pem()).unwrap();
        std::fs::write(&files.peer_ca, self.cert.pem()).unwrap();
        files
    }
}

/// What the fake service heard, and when.
#[derive(Default)]
struct Heard {
    registers: Vec<Register>,
    renewals: Vec<(Instant, Renew)>,
    reports: Vec<Report>,
    /// The host epoch each pointer request was made under.
    pointer_epochs: Vec<u64>,
}

/// A control service that registers the host under [`EPOCH`], keeping
/// everything it lists, and accepts every renewal of that registration.
struct Service {
    heard: Mutex<Heard>,
    terms: LeaseTerms,
}

impl Service {
    async fn start(tls: &Tls, terms: LeaseTerms) -> (Arc<Self>, u16) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let service = Arc::new(Self {
            heard: Mutex::default(),
            terms,
        });
        let acceptor = TlsAcceptor::from(Arc::clone(&tls.server));
        let serving = Arc::clone(&service);
        tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else {
                    continue;
                };
                let (acceptor, service) = (acceptor.clone(), Arc::clone(&serving));
                tokio::spawn(async move {
                    let Ok(tls) = acceptor.accept(tcp).await else {
                        return;
                    };
                    let answer = hyper::service::service_fn(move |request| {
                        let service = Arc::clone(&service);
                        async move { Ok::<_, std::convert::Infallible>(service.answer(request).await) }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(tls), answer)
                        .await;
                });
            }
        });
        (service, port)
    }

    async fn answer(
        &self,
        request: hyper::Request<hyper::body::Incoming>,
    ) -> hyper::Response<Full<Bytes>> {
        let path = request.uri().path().to_owned();
        let body = request.into_body().collect().await.unwrap().to_bytes();
        let json = |value: Vec<u8>| hyper::Response::new(Full::new(Bytes::from(value)));
        let mut heard = self.heard.lock().unwrap();
        match path.as_str() {
            REGISTER_PATH => {
                let register: Register = serde_json::from_slice(&body).unwrap();
                let rulings = register
                    .held
                    .iter()
                    .map(|held| Ruling {
                        id: held.id,
                        verdict: Verdict::Keep {
                            owner_epoch: held.owner_epoch,
                        },
                        link: None,
                    })
                    .collect();
                heard.registers.push(register);
                json(
                    serde_json::to_vec(&Registered::Registered {
                        host: HOST,
                        epoch: EPOCH,
                        terms: wire_terms(self.terms),
                        rulings,
                    })
                    .unwrap(),
                )
            }
            RENEW_PATH => {
                let renew: Renew = serde_json::from_slice(&body).unwrap();
                let renewed = if (renew.host, renew.epoch) == (HOST, EPOCH) {
                    Renewed::Renewed {
                        epoch: renew.epoch,
                        seq: renew.seq,
                    }
                } else {
                    Renewed::Unknown
                };
                heard.renewals.push((Instant::now(), renew));
                json(serde_json::to_vec(&renewed).unwrap())
            }
            REPORT_PATH => {
                heard.reports.push(serde_json::from_slice(&body).unwrap());
                let mut response = hyper::Response::new(Full::new(Bytes::new()));
                *response.status_mut() = hyper::StatusCode::NO_CONTENT;
                response
            }
            // One pointer, `s-1`, kept as version 7; `s-busy` is one the
            // service cannot answer yet, and `s-bad` one it refuses.
            POINTER_READ_PATH | POINTER_WRITE_PATH => {
                let (epoch, name) = if path == POINTER_READ_PATH {
                    let read: PointerRead = serde_json::from_slice(&body).unwrap();
                    (read.epoch, read.name)
                } else {
                    let write: PointerWrite = serde_json::from_slice(&body).unwrap();
                    (write.epoch, write.name)
                };
                heard.pointer_epochs.push(epoch);
                let status = match name.as_str() {
                    _ if epoch != EPOCH => Some(hyper::StatusCode::NOT_FOUND),
                    "s-busy" => Some(hyper::StatusCode::SERVICE_UNAVAILABLE),
                    "s-bad" => Some(hyper::StatusCode::BAD_REQUEST),
                    _ => None,
                };
                if let Some(status) = status {
                    let mut response = hyper::Response::new(Full::new(Bytes::new()));
                    *response.status_mut() = status;
                    return response;
                }
                if path == POINTER_READ_PATH {
                    let found = PointerFound {
                        kept: (name == "s-1").then(|| KeptPointer {
                            owner_epoch: 3,
                            owner_save: 1,
                            pointer: b"a copy".to_vec(),
                            version: 7,
                        }),
                        now_ms: fleet_now_ms(),
                    };
                    json(serde_json::to_vec(&found).unwrap())
                } else {
                    let write: PointerWrite = serde_json::from_slice(&body).unwrap();
                    let written = PointerWritten {
                        version: (write.on == Some(7)).then_some(8),
                        now_ms: fleet_now_ms(),
                    };
                    json(serde_json::to_vec(&written).unwrap())
                }
            }
            _ => {
                let mut response = hyper::Response::new(Full::new(Bytes::new()));
                *response.status_mut() = hyper::StatusCode::NOT_FOUND;
                response
            }
        }
    }

    /// The last renewal number heard.
    fn seq(&self) -> u64 {
        let heard = self.heard.lock().unwrap();
        heard.renewals.last().map_or(0, |(_, renew)| renew.seq)
    }
}

/// Asks the host at `address`, as the service, `request` under the
/// registration and the renewal `stamp`.
async fn ask(
    client: rustls::ClientConfig,
    address: SocketAddr,
    stamp: u64,
    request: Request,
) -> Answer {
    let tcp = TcpStream::connect(address).await.unwrap();
    let name = ServerName::try_from("localhost").unwrap();
    let tls = TlsConnector::from(Arc::new(client))
        .connect(name, tcp)
        .await
        .unwrap();
    let mut stream = BufReader::new(tls);
    let envelope = Envelope {
        sent: Sent {
            host_epoch: EPOCH,
            stamp,
            owner_epoch: None,
        },
        request,
    };
    let mut line = serde_json::to_vec(&envelope).unwrap();
    line.push(b'\n');
    stream.get_mut().write_all(&line).await.unwrap();
    stream.get_mut().flush().await.unwrap();
    let mut answer = String::new();
    stream.read_line(&mut answer).await.unwrap();
    serde_json::from_str(&answer).unwrap()
}

/// Starts an agent on the lab at `root` in `fleet`, as the agent binary
/// does; returns once it has started, with the fleet's part.
async fn join(
    fleet: &FleetConfig,
    root: &Path,
    world: &Arc<World>,
) -> (compute_host::Handle, tokio::task::JoinHandle<()>, Joined) {
    let prepared = fleet.clone().prepare().unwrap();
    let mut config = Lab::config(root, HostPolicy::default());
    config.lease = Some(prepared.gate.clone());
    let engine = Fake {
        world: Arc::clone(world),
        delays: Delays::default(),
    };
    let starting = fleet
        .clone()
        .start(prepared, HostAgent::start(config, engine, NoStore));
    let ((handle, agent), joined) = Box::pin(starting).await.unwrap();
    (handle, agent, joined)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[expect(clippy::too_many_lines, reason = "one scenario, step by step")]
async fn a_restarted_agent_keeps_its_lease_while_it_takes_back_its_sandboxes() {
    // Sandboxes whose VMs run, as on a busy host.
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandboxes = [id(1), id(2), id(3)];
    for sandbox in sandboxes {
        lab.create(sandbox, NEVER).await;
        lab.run(sandbox, &["set alive"]).await;
    }
    let (root, world) = lab.stop().await;
    let boots = world.boots.load(Ordering::Relaxed);
    assert_eq!(boots, sandboxes.len());

    let terms = terms();
    let authority = Authority::new();
    let service_tls = Tls::load(&authority.issue(&root, "service")).unwrap();
    let (service, port) = Service::start(&service_tls, terms).await;
    let listen = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .unwrap()
        .local_addr()
        .unwrap();
    let fleet = FleetConfig {
        guest: None,
        control: format!("https://localhost:{port}"),
        info: HostInfo {
            name: "host-a.example".into(),
            address: listen.to_string(),
            zone: "zone-a".into(),
            profile: "nested".into(),
            cpu_template: "test".into(),
            memory_mib: 4096,
            cpu_millis: 4000,
            disk_mib: 4096,
            offers: Vec::new(),
            boot: None,
        },
        image: "base".into(),
        listen,
        tls: authority.issue(&root, "host"),
        lease_file: root.join("run/lease"),
        guard_lock: root.join("guard.lock"),
        terms,
        agent_link_ca: None,
        boot: None,
    };
    // A guard holds the VMs to the lease file.
    let _guard = hold_lock(&ready_lock(&fleet.guard_lock)).unwrap();

    // The first run registers and renews.
    let (handle, agent, mut joined) = join(&fleet, &root, &world).await;
    let registered = Instant::now() + Duration::from_secs(10);
    let renewed = async {
        while service.heard.lock().unwrap().renewals.len() < 3 {
            assert!(Instant::now() < registered, "the first run never renewed");
            sleep(Duration::from_millis(20)).await;
        }
    };
    tokio::select! {
        result = joined.run() => panic!("left the fleet: {result:?}"),
        () = renewed => {}
    }

    // It stops, taking longer than the lease runs: the lease is renewed
    // until it has, and the service's requests are refused meanwhile.
    let stopped = Instant::now();
    let asked_while_stopping = joined
        .stopping(async {
            sleep(terms.term).await;
            let answer = ask(
                service_tls.client.clone(),
                listen,
                service.seq(),
                Request::Status,
            )
            .await;
            sleep(terms.margin).await;
            answer
        })
        .await;
    assert!(
        matches!(
            asked_while_stopping.reply,
            Reply::Error {
                code: ErrorCode::Unavailable,
                ..
            }
        ),
        "{asked_while_stopping:?}"
    );
    {
        let heard = service.heard.lock().unwrap();
        let during: Vec<&(Instant, Renew)> = heard
            .renewals
            .iter()
            .filter(|(at, _)| *at >= stopped + terms.renew_every)
            .collect();
        assert!(
            during.len() > 5,
            "{} renewals while it stopped",
            during.len()
        );
        assert!(
            during
                .iter()
                .all(|(_, renew)| renew.epoch == EPOCH && renew.capacity.is_none()),
            "{during:?}"
        );
    }
    drop(handle);
    timeout(Duration::from_secs(5), agent)
        .await
        .expect("the first run stops")
        .unwrap();

    // The next run takes longer to take back its VMs than the lease runs.
    *world.adopt_delay.lock().unwrap() = terms.term + terms.margin;
    let prepared = fleet.clone().prepare().unwrap();
    let gate = prepared.gate.clone();
    assert!(
        gate.is_open(),
        "the first run's lease still runs, {:?} after it began to stop",
        stopped.elapsed()
    );
    let mut config = Lab::config(&root, HostPolicy::default());
    config.lease = Some(gate.clone());
    let engine = Fake {
        world: Arc::clone(&world),
        delays: Delays::default(),
    };
    let restarted = Instant::now();
    let start = fleet
        .clone()
        .start(prepared, HostAgent::start(config, engine, NoStore));
    tokio::pin!(start);
    let mut asked_while_starting = None;
    let ((handle, _agent), mut joined) = loop {
        tokio::select! {
            started = &mut start => break started.unwrap(),
            () = sleep(Duration::from_millis(10)) => {
                assert!(
                    gate.is_open(),
                    "the lease ran out {:?} into the restart",
                    restarted.elapsed()
                );
                if asked_while_starting.is_none() && restarted.elapsed() > terms.term {
                    asked_while_starting = Some(tokio::spawn(ask(
                        service_tls.client.clone(),
                        listen,
                        service.seq(),
                        Request::Status,
                    )));
                }
            }
        }
    };
    let joined = tokio::spawn(async move { joined.run().await });
    let took = restarted.elapsed();
    assert!(
        took > terms.term + terms.margin,
        "taking back the VMs outlasted the lease's term and margin: {took:?}"
    );

    // Refused, so the service places a create elsewhere and its callers
    // try again.
    let answer = asked_while_starting.expect("asked").await.unwrap();
    assert!(
        matches!(
            answer.reply,
            Reply::Error {
                code: ErrorCode::Unavailable,
                ..
            }
        ),
        "{answer:?}"
    );

    // Renewed all along under the same registration, without saying what
    // the host can take on until it could.
    {
        let heard = service.heard.lock().unwrap();
        assert_eq!(heard.registers.len(), 1, "it never registered again");
        let during: Vec<&(Instant, Renew)> = heard
            .renewals
            .iter()
            .filter(|(at, _)| *at >= restarted && *at < restarted + took)
            .collect();
        assert!(
            during.len() > 5,
            "{} renewals while it started",
            during.len()
        );
        assert!(
            during
                .iter()
                .all(|(_, renew)| renew.epoch == EPOCH && renew.capacity.is_none()),
            "{during:?}"
        );
        let gaps = heard
            .renewals
            .windows(2)
            .map(|pair| pair[1].0 - pair[0].0)
            .max()
            .unwrap();
        assert!(gaps < terms.term, "{gaps:?} between renewals");
    }
    let said = Instant::now() + Duration::from_secs(5);
    loop {
        let capacity = {
            let heard = service.heard.lock().unwrap();
            heard
                .renewals
                .iter()
                .rev()
                .find_map(|(_, renew)| renew.capacity.clone())
                .or_else(|| heard.reports.last().map(|report| report.capacity.clone()))
        };
        if capacity.is_some_and(|capacity| capacity.sandboxes == 3) {
            break;
        }
        assert!(Instant::now() < said, "it never said what it holds");
        sleep(Duration::from_millis(20)).await;
    }

    // It serves the service again, with every sandbox as it was.
    let answer = ask(
        service_tls.client.clone(),
        listen,
        service.seq(),
        Request::Status,
    )
    .await;
    let Reply::Status(status) = answer.reply else {
        panic!("{answer:?}");
    };
    assert_eq!(status.sandboxes.len(), sandboxes.len());
    assert_eq!(
        world.boots.load(Ordering::Relaxed),
        boots,
        "nothing rebooted"
    );
    joined.abort();
    drop(handle);
}

/// A metadata server whose guest attribute names `named`, answering
/// every request `delay` late; returns its URL and the attribute.
async fn metadata(named: &str, delay: Duration) -> (String, Arc<Mutex<String>>) {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let value = Arc::new(Mutex::new(named.to_owned()));
    let attribute = Arc::clone(&value);
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else {
                continue;
            };
            let value = Arc::clone(&value);
            tokio::spawn(async move {
                let answer = hyper::service::service_fn(
                    move |request: hyper::Request<hyper::body::Incoming>| {
                        let value = Arc::clone(&value);
                        async move {
                            sleep(delay).await;
                            let put = request.method() == hyper::Method::PUT;
                            let body = request.into_body().collect().await.unwrap().to_bytes();
                            let mut value = value.lock().unwrap();
                            let answer = if put {
                                *value = String::from_utf8(body.to_vec()).unwrap();
                                Bytes::new()
                            } else {
                                Bytes::from(value.clone())
                            };
                            Ok::<_, std::convert::Infallible>(hyper::Response::new(Full::new(
                                answer,
                            )))
                        }
                    },
                );
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(tcp), answer)
                    .await;
            });
        }
    });
    (url, attribute)
}

/// A host that tells its cloud of its machine's boot first registers once
/// the cloud took it, however slow the metadata server, and names the
/// boot as it was written: counted one past the boot named before.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_host_registers_naming_the_boot_its_cloud_took() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let (root, world) = lab.stop().await;
    let terms = terms();
    let authority = Authority::new();
    let service_tls = Tls::load(&authority.issue(&root, "service")).unwrap();
    let (service, port) = Service::start(&service_tls, terms).await;
    let (url, attribute) =
        metadata(r#"{"id":"boot-before","nth":4}"#, Duration::from_secs(1)).await;
    let listen = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .unwrap()
        .local_addr()
        .unwrap();
    let fleet = FleetConfig {
        guest: None,
        control: format!("https://localhost:{port}"),
        info: HostInfo {
            name: "host-a.example".into(),
            address: listen.to_string(),
            zone: "zone-a".into(),
            profile: "nested".into(),
            cpu_template: "test".into(),
            memory_mib: 4096,
            cpu_millis: 4000,
            disk_mib: 4096,
            offers: Vec::new(),
            boot: None,
        },
        image: "base".into(),
        listen,
        tls: authority.issue(&root, "host"),
        lease_file: root.join("run/lease"),
        guard_lock: root.join("guard.lock"),
        terms,
        agent_link_ca: None,
        boot: Some(Telling {
            id: "boot-now".into(),
            metadata: url,
        }),
    };
    let _guard = hold_lock(&ready_lock(&fleet.guard_lock)).unwrap();
    let (handle, _agent, mut joined) = join(&fleet, &root, &world).await;
    let within = Instant::now() + Duration::from_secs(15);
    let registered = async {
        while service.heard.lock().unwrap().registers.is_empty() {
            assert!(Instant::now() < within, "it never registered");
            sleep(Duration::from_millis(20)).await;
        }
    };
    tokio::select! {
        result = joined.run() => panic!("left the fleet: {result:?}"),
        () = registered => {}
    }
    let told = Boot {
        id: "boot-now".into(),
        nth: 5,
    };
    let heard = service.heard.lock().unwrap();
    assert_eq!(heard.registers[0].info.boot, Some(told.clone()));
    let written: Boot = serde_json::from_str(&attribute.lock().unwrap()).unwrap();
    assert_eq!(written, told);
    drop(heard);
    drop(handle);
}

/// A host reaches the pointers the service keeps (ADR 25) with its
/// certificate and under the registration it holds; before it holds one it
/// asks nothing, and a refusal it can try again is told apart from one it
/// cannot.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[expect(clippy::too_many_lines, reason = "one scenario, step by step")]
async fn a_host_keeps_its_pointers_in_the_service_under_its_registration() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let (root, world) = lab.stop().await;
    let terms = terms();
    let authority = Authority::new();
    let service_tls = Tls::load(&authority.issue(&root, "service")).unwrap();
    let (service, port) = Service::start(&service_tls, terms).await;
    let listen = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .unwrap()
        .local_addr()
        .unwrap();
    let fleet = FleetConfig {
        guest: None,
        control: format!("https://localhost:{port}"),
        info: HostInfo {
            name: "host-a.example".into(),
            address: listen.to_string(),
            zone: "zone-a".into(),
            profile: "nested".into(),
            cpu_template: "test".into(),
            memory_mib: 4096,
            cpu_millis: 4000,
            disk_mib: 4096,
            offers: Vec::new(),
            boot: None,
        },
        image: "base".into(),
        listen,
        tls: authority.issue(&root, "host"),
        lease_file: root.join("run/lease"),
        guard_lock: root.join("guard.lock"),
        terms,
        agent_link_ca: None,
        boot: None,
    };
    let _guard = hold_lock(&ready_lock(&fleet.guard_lock)).unwrap();
    let prepared = fleet.clone().prepare().unwrap();
    let pointers = fleet.pointers(&prepared.gate).unwrap();
    let clock = pointers.clock();

    // Not registered yet: nothing is asked, and the read is tried again.
    let early = pointers.read("s-1").await;
    assert!(
        matches!(early, Err(compute_storage::Error::Transfer(_))),
        "{early:?}"
    );
    assert_eq!(
        service.heard.lock().unwrap().pointer_epochs,
        Vec::<u64>::new()
    );

    let mut config = Lab::config(&root, HostPolicy::default());
    config.lease = Some(prepared.gate.clone());
    let engine = Fake {
        world: Arc::clone(&world),
        delays: Delays::default(),
    };
    let starting = fleet
        .clone()
        .start(prepared, HostAgent::start(config, engine, NoStore));
    let ((handle, _agent), mut joined) = Box::pin(starting).await.unwrap();
    let within = Instant::now() + Duration::from_secs(15);
    let read = async {
        loop {
            if let Ok(kept) = pointers.read("s-1").await {
                return kept;
            }
            assert!(Instant::now() < within, "never read under its registration");
            sleep(Duration::from_millis(20)).await;
        }
    };
    let kept = tokio::select! {
        result = joined.run() => panic!("left the fleet: {result:?}"),
        kept = read => kept.expect("pointer s-1"),
    };
    assert_eq!(&kept.pointer[..], b"a copy");
    assert_eq!(
        kept.owner,
        Stamp {
            epoch: OwnerEpoch(3),
            save: 1
        }
    );
    assert_eq!(kept.version, Version::Row(7));
    assert!(pointers.read("s-2").await.unwrap().is_none());
    // The host now goes by the fleet's clock, two days ahead of its own,
    // to name what it stores.
    let ahead = clock
        .now()
        .duration_since(SystemTime::now())
        .expect("the fleet's clock is ahead");
    assert!(
        ahead.abs_diff(FLEET_AHEAD) < Duration::from_secs(60),
        "{ahead:?}"
    );

    // A write lands on the version it read, and not on another.
    let stamp = Stamp {
        epoch: OwnerEpoch(4),
        save: 1,
    };
    let landed = pointers
        .write(
            "s-1",
            stamp,
            Bytes::from_static(b"newer"),
            Some(&kept.version),
        )
        .await
        .unwrap();
    assert_eq!(landed, Some(Version::Row(8)));
    let late = pointers
        .write(
            "s-1",
            stamp,
            Bytes::from_static(b"late"),
            Some(&Version::Row(6)),
        )
        .await
        .unwrap();
    assert_eq!(late, None);

    // The service not answering yet is tried again; a refusal is not.
    let busy = pointers.read("s-busy").await;
    assert!(
        matches!(busy, Err(compute_storage::Error::Transfer(_))),
        "{busy:?}"
    );
    let bad = pointers.read("s-bad").await;
    assert!(
        matches!(bad, Err(compute_storage::Error::Invalid(_))),
        "{bad:?}"
    );
    let names = pointers.names().await;
    assert!(
        matches!(names, Err(compute_storage::Error::Unsupported(_))),
        "{names:?}"
    );
    let heard = service.heard.lock().unwrap();
    assert!(
        heard.pointer_epochs.iter().all(|epoch| *epoch == EPOCH),
        "{:?}",
        heard.pointer_epochs
    );
    drop(heard);
    drop(handle);
}
