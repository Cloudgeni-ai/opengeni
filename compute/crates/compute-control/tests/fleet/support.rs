//! A control service on loopback over an in-memory store and archive, with
//! fake hosts that speak the host protocol over mutual TLS: they register,
//! renew, answer requests as a host would (holding what they created or
//! adopted, archiving on a hand-off, claiming the archive on an adopt), or
//! as a test tells them to.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use compute_control::api::key_digest;
use compute_control::authority::{Authority, Proven};
use compute_control::leader::Scaling;
use compute_control::service::Settings;
use compute_control::store::{MemoryStore, Store as _};
use compute_control::tls::Tls;
use compute_control::{Config, Running};
use compute_fleet::{LeaseTerms, OwnerEpoch, Stamp};
use compute_protocol::fleet::{
    Answer, Answered, Capacity, Envelope, Held, HostInfo, REGISTER_PATH, RENEW_PATH, ReadyClones,
    Register, Registered, Renew, Renewed, Verdict,
};
use compute_protocol::host::{ErrorCode, Id, Reply, Request};
use compute_storage::store::{Begun, ChunkStore};
use rcgen::{BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair};
use rustls::pki_types::pem::PemObject as _;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::WebPkiClientVerifier;
use rustls::{ClientConfig, RootCertStore, ServerConfig};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_rustls::TlsAcceptor;

/// The team the tests' sandboxes belong to, and its key.
pub const TEAM: &str = "team-a";
pub const KEY: &str = "key-of-team-a";
/// Another team's key.
pub const OTHER_KEY: &str = "key-of-team-b";
/// The operator's key.
pub const OPERATOR_KEY: &str = "key-of-the-operator";
/// The name hosts reach the service by.
pub const SERVICE: &str = "service.example";

/// Lease terms short enough for a test to see a host lapse: a two-second
/// term, renewed every 200 ms, with the margin the rules need.
#[must_use]
pub fn terms() -> LeaseTerms {
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
    terms.margin = terms.needed_margin();
    terms.validate().expect("valid test terms")
}

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// A certificate authority for the service and its hosts.
pub struct Pki {
    ca: rcgen::Certificate,
    ca_key: KeyPair,
    dir: tempfile::TempDir,
}

impl Pki {
    #[must_use]
    pub fn new() -> Self {
        let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params
            .distinguished_name
            .push(DnType::CommonName, "fleet test authority");
        let ca_key = KeyPair::generate().unwrap();
        let ca = params.self_signed(&ca_key).unwrap();
        Self {
            ca,
            ca_key,
            dir: tempfile::tempdir().unwrap(),
        }
    }

    /// A certificate valid for `name`, as PEM: the certificate and its key.
    #[must_use]
    pub fn issue_pem(&self, name: &str) -> (String, String) {
        self.issue_until(name, None)
    }

    /// The same, valid until `not_after` if given.
    fn issue_until(&self, name: &str, not_after: Option<time::OffsetDateTime>) -> (String, String) {
        let mut params = CertificateParams::new(vec![name.to_owned()]).unwrap();
        // As a host off GCP holds it: proven by a certificate, so it renews
        // by presenting it.
        params
            .distinguished_name
            .push(DnType::OrganizationalUnitName, Proven::Certificate.unit());
        if let Some(not_after) = not_after {
            params.not_before = not_after - time::Duration::days(2);
            params.not_after = not_after;
        }
        params.extended_key_usages = vec![
            ExtendedKeyUsagePurpose::ServerAuth,
            ExtendedKeyUsagePurpose::ClientAuth,
        ];
        let key = KeyPair::generate().unwrap();
        let cert = params.signed_by(&key, &self.ca, &self.ca_key).unwrap();
        (cert.pem(), key.serialize_pem())
    }

    fn roots(&self) -> Arc<RootCertStore> {
        let mut roots = RootCertStore::empty();
        roots.add(self.ca.der().clone()).unwrap();
        Arc::new(roots)
    }

    /// The authority, as the service holds it, loaded from a directory as
    /// it loads it.
    #[must_use]
    pub fn authority(&self) -> Arc<Authority> {
        let dir = self.dir.path();
        std::fs::write(dir.join("ca.crt"), self.ca.pem()).unwrap();
        std::fs::write(dir.join("ca.key"), self.ca_key.serialize_pem()).unwrap();
        Arc::new(Authority::load(dir).unwrap())
    }

    /// The service's settings, for the names the tests reach it by.
    #[must_use]
    pub fn service(&self) -> Tls {
        Tls::new(
            self.authority(),
            vec![SERVICE.to_owned(), Ipv4Addr::LOCALHOST.to_string()],
        )
        .unwrap()
    }

    fn parts(pem: &(String, String)) -> (Vec<CertificateDer<'static>>, PrivateKeyDer<'static>) {
        let chain = CertificateDer::pem_slice_iter(pem.0.as_bytes())
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        (
            chain,
            PrivateKeyDer::from_pem_slice(pem.1.as_bytes()).unwrap(),
        )
    }

    /// What a host calls the service with: its certificate for `name`.
    #[must_use]
    pub fn host_client(&self, name: &str) -> ClientConfig {
        Self::client_of(&self.issue_pem(name), self.roots())
    }

    /// The same, with a certificate that expired a day ago.
    #[must_use]
    pub fn expired_host_client(&self, name: &str) -> ClientConfig {
        let yesterday = time::OffsetDateTime::now_utc() - time::Duration::days(1);
        Self::client_of(&self.issue_until(name, Some(yesterday)), self.roots())
    }

    /// A client presenting `pem` (certificate and key), trusting `roots`.
    #[must_use]
    pub fn client_of(pem: &(String, String), roots: Arc<RootCertStore>) -> ClientConfig {
        let (chain, key) = Self::parts(pem);
        ClientConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_client_auth_cert(chain, key)
            .unwrap()
    }

    /// The authority's roots, for a client of the service.
    #[must_use]
    pub fn trusted(&self) -> Arc<RootCertStore> {
        self.roots()
    }

    /// What a caller without a host certificate calls the service with: it
    /// trusts the authority but presents nothing.
    #[must_use]
    pub fn anonymous_client(&self) -> ClientConfig {
        ClientConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(self.roots())
            .with_no_client_auth()
    }

    /// What a host serves the service with, trusting only the authority.
    #[must_use]
    pub fn host_server(&self, name: &str) -> ServerConfig {
        let (chain, key) = Self::parts(&self.issue_pem(name));
        let verifier = WebPkiClientVerifier::builder_with_provider(self.roots(), provider())
            .build()
            .unwrap();
        ServerConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_client_cert_verifier(verifier)
            .with_single_cert(chain, key)
            .unwrap()
    }
}

/// Waits until `check` holds, polling, or panics after `within`.
pub async fn until(within: Duration, what: &str, mut check: impl AsyncFnMut() -> bool) {
    let deadline = Instant::now() + within;
    while !check().await {
        assert!(Instant::now() < deadline, "not within {within:?}: {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Whether the service counts `host`'s renewals: it has not given up on
/// the host.
pub async fn counted(fleet: &Fleet, host: &FakeHost) -> bool {
    fleet
        .store
        .renewals()
        .await
        .unwrap()
        .iter()
        .any(|(counted, _)| *counted == compute_fleet::HostId(host.id()))
}

/// Waits until the service gives up on `host`, and returns when it did.
pub async fn given_up(fleet: &Fleet, host: &FakeHost) -> Instant {
    let within = fleet.terms.term + fleet.terms.margin + Duration::from_secs(2);
    until(within, "the host is given up on", async || {
        !counted(fleet, host).await
    })
    .await;
    Instant::now()
}

/// A control service and what it runs on.
pub struct Fleet {
    pub pki: Pki,
    pub store: Arc<MemoryStore>,
    pub archive: ChunkStore,
    pub running: Running<MemoryStore>,
    pub terms: LeaseTerms,
    http: reqwest::Client,
}

impl Fleet {
    pub async fn start() -> Self {
        Self::start_with(None, |_| {}).await
    }

    /// A fleet whose leader sizes `scaling`, with `settings` adjusted.
    pub async fn start_with(scaling: Option<Scaling>, adjust: impl FnOnce(&mut Settings)) -> Self {
        let pki = Pki::new();
        let store = Arc::new(MemoryStore::new());
        for (key, team) in [
            (KEY, TEAM),
            (OTHER_KEY, "team-b"),
            (OPERATOR_KEY, "operator"),
        ] {
            store.add_key(&key_digest(key), team).await.unwrap();
        }
        let archive = ChunkStore::new(
            Arc::new(object_store::memory::InMemory::new()),
            object_store::path::Path::from("fleet"),
        );
        let terms = terms();
        let mut settings = Settings {
            terms,
            wake_within: Duration::from_secs(10),
            ..Settings::default()
        };
        adjust(&mut settings);
        let loopback = SocketAddr::from((Ipv4Addr::LOCALHOST, 0));
        let running = compute_control::start(
            Arc::clone(&store),
            Config {
                api: loopback,
                api_tls: None,
                hosts: loopback,
                tls: pki.service(),
                identity: None,
                archive: Some(archive.clone()),
                settings,
                operator: "operator".into(),
                scaling,
                seed: 7,
                e2b: None,
            },
        )
        .await
        .unwrap();
        Self {
            pki,
            store,
            archive,
            running,
            terms,
            http: reqwest::Client::new(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.running.api)
    }

    /// A request to the public API with `key`.
    pub async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        key: Option<&str>,
        body: Option<Value>,
    ) -> (u16, Value) {
        let mut request = self.http.request(method, self.url(path));
        if let Some(key) = key {
            request = request.header("x-api-key", key);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap();
        let value = if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::String(text))
        };
        (status, value)
    }

    pub async fn post(&self, path: &str, body: Value) -> (u16, Value) {
        self.call(reqwest::Method::POST, path, Some(KEY), Some(body))
            .await
    }

    pub async fn get(&self, path: &str) -> (u16, Value) {
        self.call(reqwest::Method::GET, path, Some(KEY), None).await
    }

    pub async fn delete(&self, path: &str) -> (u16, Value) {
        self.call(reqwest::Method::DELETE, path, Some(KEY), None)
            .await
    }

    /// Creates a sandbox of the default image and shape for the team, and
    /// returns its id.
    pub async fn create(&self, metadata: Value) -> String {
        let (status, body) = self
            .post(
                "/v1/sandboxes",
                serde_json::json!({ "vcpus": 1, "memory_mib": 256, "metadata": metadata }),
            )
            .await;
        assert_eq!(status, 201, "create: {body}");
        body["id"].as_str().unwrap().to_owned()
    }

    /// Starts a host named `name` that answers as an ordinary host, and
    /// waits until this replica's view has it.
    pub async fn host(&self, name: &str) -> FakeHost {
        let host = FakeHost::start(self, name, roomy()).await;
        self.sees(&host).await;
        host
    }

    /// Waits until this replica's view has `host` under its current
    /// registration.
    pub async fn sees(&self, host: &FakeHost) {
        let view = Arc::clone(self.running.service.view());
        let (id, epoch) = (host.id(), host.epoch());
        until(
            Duration::from_secs(5),
            "the view sees the host",
            async || {
                view.target(compute_fleet::HostId(id))
                    .is_some_and(|target| target.epoch.0 == epoch)
            },
        )
        .await;
    }
}

/// Room for many sandboxes.
#[must_use]
pub fn roomy() -> Capacity {
    Capacity {
        memory_free_mib: 64 * 1024,
        cpu_millis: 64_000,
        cpu_free_millis: 64_000,
        disk_free_mib: 1 << 20,
        ready: Vec::new(),
        awake: 0,
        sandboxes: 0,
    }
}

/// Parses a sandbox id as the API gives it.
#[must_use]
pub fn id(text: &str) -> Id {
    text.parse().unwrap()
}

/// What a fake host does with one request.
#[derive(Clone, Debug)]
pub enum Act {
    /// What an ordinary host would.
    Ordinary,
    /// What an ordinary host would, after this long.
    After(Duration),
    /// Answers this.
    Reply(Reply),
}

/// Decides each request; [`Act::Ordinary`] for all by default.
pub type Behaviour = Arc<dyn Fn(&Envelope) -> Act + Send + Sync>;

/// The rest of a connect's connection, past the host's answer: the guest
/// port's side of the stream.
pub type GuestStream = BufReader<tokio_rustls::server::TlsStream<TcpStream>>;

/// Plays the guest's side of each connect to a sandbox and port; without
/// one, every guest port echoes.
pub type Guest = Arc<
    dyn Fn(Id, u32, GuestStream) -> std::pin::Pin<Box<dyn Future<Output = ()> + Send>>
        + Send
        + Sync,
>;

/// A request a fake host received, and whether its caller kept its side of
/// the connection open until the answer.
#[derive(Clone, Debug)]
pub struct Seen {
    pub envelope: Envelope,
    pub open_until_answer: Option<bool>,
}

struct HostInner {
    name: String,
    address: SocketAddr,
    archive: ChunkStore,
    hosts_url: String,
    http: reqwest::Client,
    capacity: Mutex<Capacity>,
    /// Its host id and registration.
    id: AtomicU64,
    epoch: AtomicU64,
    /// The last renewal sent under the registration.
    seq: AtomicU64,
    /// Sandboxes it holds, by owner epoch.
    held: Mutex<HashMap<Id, u64>>,
    saves: AtomicU64,
    seen: Mutex<Vec<Seen>>,
    behaviour: Mutex<Behaviour>,
    guest: Mutex<Option<Guest>>,
    renewing: AtomicBool,
    /// Whether it checks that callers keep their side open.
    check_open: AtomicBool,
    /// Renewals a request's stamp may be behind its own before it refuses
    /// the request as expired, as a real host does; 0 never refuses.
    window: AtomicU64,
    attempt: AtomicU64,
}

/// A host that registers with the service and answers its requests.
pub struct FakeHost {
    inner: Arc<HostInner>,
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for FakeHost {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

impl FakeHost {
    /// Starts a host named `name` reporting `capacity`, and has it
    /// register; it renews until told to stop.
    pub async fn start(fleet: &Fleet, name: &str, capacity: Capacity) -> Self {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let http = reqwest::Client::builder()
            .use_preconfigured_tls(fleet.pki.host_client(name))
            .https_only(true)
            .build()
            .unwrap();
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).unwrap();
        let inner = Arc::new(HostInner {
            name: name.to_owned(),
            address,
            archive: fleet.archive.clone(),
            hosts_url: format!("https://{}", fleet.running.hosts),
            http,
            capacity: Mutex::new(capacity),
            id: AtomicU64::new(0),
            epoch: AtomicU64::new(0),
            seq: AtomicU64::new(0),
            held: Mutex::new(HashMap::new()),
            saves: AtomicU64::new(0),
            seen: Mutex::new(Vec::new()),
            behaviour: Mutex::new(Arc::new(|_| Act::Ordinary)),
            guest: Mutex::new(None),
            renewing: AtomicBool::new(true),
            check_open: AtomicBool::new(false),
            window: AtomicU64::new(0),
            attempt: AtomicU64::new(u64::from_le_bytes(random) >> 1),
        });
        let acceptor = TlsAcceptor::from(Arc::new(fleet.pki.host_server(name)));
        let mut host = Self {
            inner: Arc::clone(&inner),
            tasks: vec![tokio::spawn(serve(Arc::clone(&inner), listener, acceptor))],
        };
        let answer = host.register().await;
        assert!(
            matches!(answer, Registered::Registered { .. }),
            "{name} did not register: {answer:?}"
        );
        host.tasks
            .push(tokio::spawn(renew(inner, fleet.terms.renew_every)));
        host
    }

    #[must_use]
    pub fn id(&self) -> u64 {
        self.inner.id.load(Ordering::SeqCst)
    }

    #[must_use]
    pub fn epoch(&self) -> u64 {
        self.inner.epoch.load(Ordering::SeqCst)
    }

    /// Registers anew, as a restarted agent does: a new attempt, listing
    /// what it holds.
    pub async fn register(&self) -> Registered {
        register(&self.inner).await
    }

    /// Sends the registration attempt it sent last again, unchanged.
    pub async fn register_again(&self) -> Registered {
        let attempt = self.inner.attempt.load(Ordering::SeqCst);
        send_register(&self.inner, attempt).await
    }

    /// Stops or resumes its renewals.
    pub fn renewing(&self, on: bool) {
        self.inner.renewing.store(on, Ordering::SeqCst);
    }

    /// Has it decide requests by `behaviour`.
    pub fn behave(&self, behaviour: impl Fn(&Envelope) -> Act + Send + Sync + 'static) {
        *self.inner.behaviour.lock().unwrap() = Arc::new(behaviour);
    }

    /// Plays the guest's side of connects with `guest`.
    pub fn guest(&self, guest: Guest) {
        *self.inner.guest.lock().unwrap() = Some(guest);
    }

    /// Has it check, before each answer, that the caller still has its
    /// side of the connection open.
    pub fn check_open(&self) {
        self.inner.check_open.store(true, Ordering::SeqCst);
    }

    /// Has it refuse, as expired, requests whose stamp is more than
    /// `renewals` behind the last renewal it sent.
    pub fn refuse_older_than(&self, renewals: u64) {
        self.inner.window.store(renewals, Ordering::SeqCst);
    }

    /// Reports ready clones of the fleet's default image and shape from
    /// its next renewal.
    pub fn advertise_ready(&self) {
        self.inner.capacity.lock().unwrap().ready = vec![ReadyClones {
            image: "base".into(),
            vcpus: 1,
            memory_mib: 256,
            count: 4,
        }];
    }

    /// Sets what it reports it can take on, from its next renewal.
    pub fn set_capacity(&self, capacity: Capacity) {
        *self.inner.capacity.lock().unwrap() = capacity;
    }

    /// The requests it received.
    #[must_use]
    pub fn seen(&self) -> Vec<Seen> {
        self.inner.seen.lock().unwrap().clone()
    }

    /// The requests it received, by their op's name.
    #[must_use]
    pub fn ops(&self) -> Vec<&'static str> {
        self.seen()
            .iter()
            .map(|seen| op_name(&seen.envelope.request))
            .collect()
    }

    /// Whether each adopt of `id` it received was to take the copy up from
    /// its files alone, in the order received.
    #[must_use]
    pub fn adopts(&self, id: Id) -> Vec<bool> {
        self.seen()
            .iter()
            .filter_map(|seen| match &seen.envelope.request {
                Request::Adopt {
                    id: adopted, whole, ..
                } if *adopted == id => Some(!*whole),
                _ => None,
            })
            .collect()
    }

    /// Whether it holds `id`, and under which owner epoch.
    #[must_use]
    pub fn holds(&self, id: Id) -> Option<u64> {
        self.inner.held.lock().unwrap().get(&id).copied()
    }

    /// Holds sandbox `id` under `owner_epoch` from now on.
    pub fn hold(&self, id: Id, owner_epoch: u64) {
        self.inner.held.lock().unwrap().insert(id, owner_epoch);
    }

    /// Archives `id` as its owner under `owner_epoch` would.
    pub async fn archive(&self, id: Id, owner_epoch: u64) {
        self.try_archive(id, owner_epoch).await.unwrap();
    }

    /// Tries to archive `id` under `owner_epoch`, as a host that may no
    /// longer own it would.
    pub async fn try_archive(&self, id: Id, owner_epoch: u64) -> Result<(), String> {
        archive(&self.inner, id, owner_epoch).await
    }

    /// Asks the service, as this host over its mutual TLS, for link tokens
    /// under `name` for `gateways`.
    pub async fn link_tokens(&self, name: &str, gateways: &[&str]) -> (u16, Value) {
        let response = self
            .inner
            .http
            .post(format!(
                "{}{}",
                self.inner.hosts_url,
                compute_protocol::fleet::LINK_TOKENS_PATH
            ))
            .json(&serde_json::json!({ "name": name, "gateways": gateways }))
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap();
        (
            status,
            serde_json::from_str(&text).unwrap_or(Value::String(text)),
        )
    }
}

/// A request's op, as the protocol names it.
#[must_use]
pub fn op_name(request: &Request) -> &'static str {
    match request {
        Request::Create { .. } => "create",
        Request::Wake { .. } => "wake",
        Request::Connect { .. } => "connect",
        Request::Remove { .. } => "remove",
        Request::HandOff { .. } => "hand_off",
        Request::Adopt { .. } => "adopt",
        Request::Sleep { .. } => "sleep",
        _ => "other",
    }
}

async fn register(inner: &HostInner) -> Registered {
    let attempt = inner.attempt.fetch_add(1, Ordering::SeqCst) + 1;
    send_register(inner, attempt).await
}

async fn send_register(inner: &HostInner, attempt: u64) -> Registered {
    let held: Vec<Held> = inner
        .held
        .lock()
        .unwrap()
        .iter()
        .map(|(&id, &owner_epoch)| Held { id, owner_epoch })
        .collect();
    let id = inner.id.load(Ordering::SeqCst);
    let body = Register {
        host: (id != 0).then_some(id),
        attempt,
        info: HostInfo {
            name: inner.name.clone(),
            address: inner.address.to_string(),
            zone: "zone-a".into(),
            profile: "nested".into(),
            cpu_template: "none".into(),
            memory_mib: 64 * 1024,
            cpu_millis: 64_000,
            disk_mib: 1 << 20,
        },
        capacity: inner.capacity.lock().unwrap().clone(),
        held,
    };
    let response = inner
        .http
        .post(format!("{}{REGISTER_PATH}", inner.hosts_url))
        .json(&body)
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "registering: {}",
        response.status()
    );
    let answer: Registered = response.json().await.unwrap();
    if let Registered::Registered {
        host,
        epoch,
        rulings,
        ..
    } = &answer
    {
        inner.id.store(*host, Ordering::SeqCst);
        // Renewals count from the start of each registration; the same
        // registration answered again goes on counting.
        if inner.epoch.swap(*epoch, Ordering::SeqCst) != *epoch {
            inner.seq.store(0, Ordering::SeqCst);
        }
        let mut held = inner.held.lock().unwrap();
        for ruling in rulings {
            match ruling.verdict {
                Verdict::Keep { owner_epoch } => {
                    held.insert(ruling.id, owner_epoch);
                }
                Verdict::Refetch { .. } | Verdict::Drop => {
                    held.remove(&ruling.id);
                }
            }
        }
    }
    answer
}

/// Renews every `every` while renewing is on; registers again when the
/// service no longer knows the registration.
async fn renew(inner: Arc<HostInner>, every: Duration) {
    loop {
        tokio::time::sleep(every).await;
        if !inner.renewing.load(Ordering::SeqCst) {
            continue;
        }
        let body = Renew {
            host: inner.id.load(Ordering::SeqCst),
            epoch: inner.epoch.load(Ordering::SeqCst),
            seq: inner.seq.fetch_add(1, Ordering::SeqCst) + 1,
            capacity: inner.capacity.lock().unwrap().clone(),
        };
        let sent = inner
            .http
            .post(format!("{}{RENEW_PATH}", inner.hosts_url))
            .json(&body)
            .send()
            .await;
        let Ok(response) = sent else { continue };
        if let Ok(Renewed::Unknown) = response.json::<Renewed>().await {
            let _ = register(&inner).await;
        }
    }
}

async fn serve(inner: Arc<HostInner>, listener: TcpListener, acceptor: TlsAcceptor) {
    loop {
        let Ok((tcp, _)) = listener.accept().await else {
            continue;
        };
        let inner = Arc::clone(&inner);
        let acceptor = acceptor.clone();
        tokio::spawn(async move {
            if let Ok(tls) = acceptor.accept(tcp).await {
                answer(&inner, BufReader::new(tls)).await;
            }
        });
    }
}

async fn answer(
    inner: &HostInner,
    mut stream: BufReader<tokio_rustls::server::TlsStream<TcpStream>>,
) {
    let mut line = String::new();
    if stream.read_line(&mut line).await.unwrap_or(0) == 0 {
        return;
    }
    let envelope: Envelope = serde_json::from_str(&line).expect("an envelope");
    // A caller gone before its answer has abandoned its request, so the
    // service must keep its side open while it waits.
    let open_until_answer = if inner.check_open.load(Ordering::SeqCst) {
        let mut byte = [0u8; 1];
        let read = tokio::time::timeout(Duration::from_millis(100), stream.read(&mut byte)).await;
        Some(read.is_err())
    } else {
        None
    };
    inner.seen.lock().unwrap().push(Seen {
        envelope: envelope.clone(),
        open_until_answer,
    });
    let behaviour = Arc::clone(&inner.behaviour.lock().unwrap());
    let window = inner.window.load(Ordering::SeqCst);
    let reply = if window > 0
        && envelope.sent.stamp.saturating_add(window) < inner.seq.load(Ordering::SeqCst)
    {
        error(
            ErrorCode::Expired,
            "sent too long before this host's renewal",
        )
    } else {
        match behaviour(&envelope) {
            Act::Reply(reply) => reply,
            Act::Ordinary => ordinary(inner, &envelope).await,
            Act::After(wait) => {
                tokio::time::sleep(wait).await;
                ordinary(inner, &envelope).await
            }
        }
    };
    let answer = Answer {
        answered: Answered {
            host_epoch: Some(inner.epoch.load(Ordering::SeqCst)),
            seq: inner.seq.load(Ordering::SeqCst),
        },
        reply: reply.clone(),
    };
    let mut out = serde_json::to_vec(&answer).unwrap();
    out.push(b'\n');
    if stream.get_mut().write_all(&out).await.is_err() {
        return;
    }
    let _ = stream.get_mut().flush().await;
    if matches!(reply, Reply::Connected { .. }) {
        let guest = inner.guest.lock().unwrap().clone();
        if let (Some(guest), Request::Connect { id, port, .. }) = (guest, &envelope.request) {
            guest(*id, *port, stream).await;
        } else {
            // The guest port echoes.
            let (mut read, mut write) = tokio::io::split(stream);
            let _ = tokio::io::copy(&mut read, &mut write).await;
        }
    }
}

fn error(code: ErrorCode, message: &str) -> Reply {
    Reply::Error {
        message: message.into(),
        code,
    }
}

/// An ordinary host's status: each sandbox it holds runs its first boot.
fn status(inner: &HostInner) -> Reply {
    let sandboxes: Vec<Value> = inner
        .held
        .lock()
        .unwrap()
        .iter()
        .map(|(id, owner_epoch)| {
            serde_json::json!({
                "id": id.to_string(),
                "generation": 1,
                "owner_epoch": owner_epoch,
                "revision": 1,
                "level": "running",
                "durability": "volatile",
                "memory_saved": true,
                "step": null,
                "holds": 0,
                "broken": false,
            })
        })
        .collect();
    let status = serde_json::json!({
        "sandboxes": sandboxes,
        "steps": [],
        "available_memory": null,
    });
    Reply::Status(Box::new(
        serde_json::from_value(status).expect("a host's status"),
    ))
}

/// What an ordinary host answers.
async fn ordinary(inner: &HostInner, envelope: &Envelope) -> Reply {
    let owner_epoch = envelope.sent.owner_epoch.unwrap_or(0);
    let holds = |id: &Id| inner.held.lock().unwrap().contains_key(id);
    match &envelope.request {
        Request::Create { id, .. } => {
            inner.held.lock().unwrap().insert(*id, owner_epoch);
            Reply::Done
        }
        Request::Wake { id, .. } if holds(id) => Reply::Woken {
            waited_us: 5,
            during: None,
            generation: 1,
        },
        Request::Connect { id, .. } if holds(id) => Reply::Connected {
            waited_us: 5,
            connect_us: 3,
            generation: 1,
        },
        Request::Sleep { id, .. } if holds(id) => Reply::Done,
        Request::Status => status(inner),
        Request::Wake { .. } | Request::Connect { .. } | Request::Sleep { .. } => {
            error(ErrorCode::NotFound, "no such sandbox")
        }
        Request::Remove { id, .. } => match inner.held.lock().unwrap().remove(id) {
            Some(_) => Reply::Done,
            None => error(ErrorCode::NotFound, "no such sandbox"),
        },
        Request::HandOff { id, owner_epoch } => {
            if !holds(id) {
                return error(ErrorCode::NotFound, "no such sandbox");
            }
            match archive(inner, *id, *owner_epoch).await {
                Ok(()) => {
                    inner.held.lock().unwrap().remove(id);
                    Reply::Done
                }
                Err(why) => error(ErrorCode::Stale, &why),
            }
        }
        Request::Adopt {
            id, owner_epoch, ..
        } => match inner
            .archive
            .claim(&id.to_string(), OwnerEpoch(*owner_epoch))
            .await
        {
            Ok(Some((stamp, _))) => {
                // Its next save goes past the copy it took up, as a real
                // host's does.
                inner.saves.fetch_max(stamp.save, Ordering::SeqCst);
                inner.held.lock().unwrap().insert(*id, *owner_epoch);
                Reply::Done
            }
            Ok(None) => error(ErrorCode::NotFound, "no archive to adopt"),
            Err(why) => error(ErrorCode::Stale, &why.to_string()),
        },
        _ => Reply::Done,
    }
}

/// Publishes an archive of `id` under `owner_epoch`.
async fn archive(inner: &HostInner, id: Id, owner_epoch: u64) -> Result<(), String> {
    let name = id.to_string();
    let stamp = Stamp {
        epoch: OwnerEpoch(owner_epoch),
        save: inner.saves.fetch_add(1, Ordering::SeqCst) + 1,
    };
    match inner.archive.begin(&name, stamp).await {
        Ok(Begun::Publish(publication)) => inner
            .archive
            .publish(
                publication,
                format!("{name} by {}", inner.name).into_bytes(),
            )
            .await
            .map_err(|error| error.to_string()),
        Ok(other) => Err(format!("not published: {other:?}")),
        Err(error) => Err(error.to_string()),
    }
}

/// Opens a connect stream through the public API: the head of its answer,
/// and the raw connection after it.
pub async fn connect(fleet: &Fleet, id: &str, port: u32) -> (String, TcpStream) {
    let mut tcp = TcpStream::connect(fleet.running.api).await.unwrap();
    let request = format!(
        "GET /v1/sandboxes/{id}/connect/{port} HTTP/1.1\r\nhost: fleet\r\nx-api-key: {KEY}\r\n\
         connection: upgrade\r\nupgrade: {}\r\n\r\n",
        compute_control::api::STREAM_PROTOCOL
    );
    tcp.write_all(request.as_bytes()).await.unwrap();
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        assert_eq!(
            tcp.read(&mut byte).await.unwrap(),
            1,
            "the head ended early"
        );
        head.push(byte[0]);
    }
    (String::from_utf8(head).unwrap(), tcp)
}
