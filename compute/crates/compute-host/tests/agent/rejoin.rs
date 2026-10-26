//! A host in a fleet whose agent restarts keeps the lease it holds while
//! the old agent stops and the new one takes back its sandboxes, however
//! long either takes: the guard never freezes their VMs and the service
//! never gives the host up.

use std::net::{Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use compute_core::HostPolicy;
use compute_fleet::LeaseTerms;
use compute_host::fleet::{FleetConfig, Joined, Tls, TlsFiles, hold_lock, ready_lock, wire_terms};
use compute_host::protocol::{ErrorCode, Reply, Request};
use compute_host::{HostAgent, NoStore};
use compute_protocol::fleet::{
    Answer, Envelope, HostInfo, REGISTER_PATH, RENEW_PATH, REPORT_PATH, Register, Registered,
    Renew, Renewed, Report, Ruling, Sent, Verdict,
};
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
            boot: None,
        },
        image: "base".into(),
        listen,
        tls: authority.issue(&root, "host"),
        lease_file: root.join("run/lease"),
        guard_lock: root.join("guard.lock"),
        terms,
        agent_link_ca: None,
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
