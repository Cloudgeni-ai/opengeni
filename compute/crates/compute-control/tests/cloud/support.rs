//! A deployed fleet as the tests reach it: its public API, its hosts by
//! name, the commands that end or cut off a host, and the witness every
//! test sandbox reports to.

use std::collections::BTreeMap;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpStream;

/// The guest port whose shell runs what a test sends.
const SHELL_PORT: u32 = 52;
/// How long one command in a guest may take, including its wake.
const EXEC_WITHIN: Duration = Duration::from_secs(180);

/// One count a sandbox's beater sent, as the witness received it.
#[derive(Clone, Debug)]
pub struct Beat {
    /// When it arrived, on this test's clock.
    pub at: Instant,
    /// The host it came from: hosts send their sandboxes' traffic from
    /// their own address.
    pub from: IpAddr,
    /// The count.
    pub n: u64,
}

/// Receives every sandbox's beats, on a thread of its own so it outlives
/// each test's runtime.
#[derive(Debug)]
pub struct Witness {
    /// Where sandboxes send to.
    pub advertised: SocketAddr,
    beats: Arc<Mutex<BTreeMap<String, Vec<Beat>>>>,
}

impl Witness {
    fn start(advertised: SocketAddr) -> Self {
        let socket = UdpSocket::bind(("0.0.0.0", advertised.port())).expect("the witness's port");
        let beats = Arc::new(Mutex::new(BTreeMap::<String, Vec<Beat>>::new()));
        let kept = Arc::clone(&beats);
        std::thread::spawn(move || {
            let mut buffer = [0u8; 256];
            loop {
                let Ok((read, from)) = socket.recv_from(&mut buffer) else {
                    continue;
                };
                let at = Instant::now();
                let text = String::from_utf8_lossy(&buffer[..read]);
                let mut words = text.split_whitespace();
                let (Some(id), Some(Ok(n))) = (words.next(), words.next().map(str::parse)) else {
                    continue;
                };
                kept.lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .entry(id.to_owned())
                    .or_default()
                    .push(Beat {
                        at,
                        from: from.ip(),
                        n,
                    });
            }
        });
        Self { advertised, beats }
    }

    /// Every beat sandbox `id` sent so far, in the order they arrived.
    pub fn beats(&self, id: &str) -> Vec<Beat> {
        self.beats
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(id)
            .cloned()
            .unwrap_or_default()
    }

    /// Waits until sandbox `id` has sent a beat from `host` that arrived
    /// after `since`, and returns it.
    pub async fn beat_from(&self, id: &str, host: IpAddr, since: Instant) -> Beat {
        let started = Instant::now();
        loop {
            if let Some(beat) = self
                .beats(id)
                .into_iter()
                .find(|beat| beat.from == host && beat.at > since)
            {
                return beat;
            }
            assert!(
                started.elapsed() < Duration::from_secs(30),
                "no beat from {id} on {host}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

/// A deployed fleet.
#[derive(Debug)]
pub struct Fleet {
    api: String,
    key: String,
    operator: String,
    kill: String,
    cut: String,
    /// Fewest live hosts each test starts with.
    pub hosts: usize,
    http: reqwest::Client,
    pub witness: &'static Witness,
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is needed with COMPUTE_TEST_FLEET_API"))
}

impl Fleet {
    /// The fleet the environment names, or none (and the test skips)
    /// unless `COMPUTE_TEST_REQUIRE` has `fleet`.
    pub fn from_env() -> Option<Self> {
        static WITNESS: OnceLock<Witness> = OnceLock::new();
        let Ok(api) = std::env::var("COMPUTE_TEST_FLEET_API") else {
            let required = std::env::var("COMPUTE_TEST_REQUIRE")
                .is_ok_and(|names| names.split(',').any(|name| name == "fleet"));
            assert!(
                !required,
                "COMPUTE_TEST_REQUIRE has fleet: set COMPUTE_TEST_FLEET_API"
            );
            eprintln!("skipped: no COMPUTE_TEST_FLEET_API");
            return None;
        };
        let witness = WITNESS.get_or_init(|| {
            Witness::start(
                env("COMPUTE_TEST_FLEET_WITNESS")
                    .parse()
                    .expect("COMPUTE_TEST_FLEET_WITNESS is address:port"),
            )
        });
        Some(Self {
            api: api.trim_end_matches('/').to_owned(),
            key: env("COMPUTE_TEST_FLEET_KEY"),
            operator: env("COMPUTE_TEST_FLEET_OPERATOR_KEY"),
            kill: env("COMPUTE_TEST_FLEET_KILL"),
            cut: env("COMPUTE_TEST_FLEET_CUT"),
            hosts: std::env::var("COMPUTE_TEST_FLEET_HOSTS")
                .map_or(3, |hosts| hosts.parse().expect("COMPUTE_TEST_FLEET_HOSTS")),
            http: reqwest::Client::new(),
            witness,
        })
    }

    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        key: &str,
        body: Option<Value>,
    ) -> (u16, Value) {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.api))
            .header("x-api-key", key)
            .timeout(Duration::from_secs(400));
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.expect("the fleet's API");
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        let value = serde_json::from_str(&text).unwrap_or(Value::String(text));
        (status, value)
    }

    /// A call that must succeed, and its answer.
    pub async fn ok(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Value {
        let (status, value) = self.call(method.clone(), path, &self.key, body).await;
        assert!(
            (200..300).contains(&status),
            "{method} {path}: {status} {value}"
        );
        value
    }

    /// Creates a sandbox of `vcpus` and `memory_mib` that never sleeps by
    /// itself, copied to object storage every `checkpoint_ms` if given.
    pub async fn create(
        &self,
        vcpus: u8,
        memory_mib: u32,
        checkpoint_ms: Option<u64>,
    ) -> Result<String, (u16, Value)> {
        let sleep =
            checkpoint_ms.map_or_else(|| json!({}), |every| json!({"checkpoint_every_ms": every}));
        let body = json!({
            "vcpus": vcpus,
            "memory_mib": memory_mib,
            "sleep": sleep,
            "metadata": {"test": "cloud"},
        });
        let (status, value) = self
            .call(
                reqwest::Method::POST,
                "/v1/sandboxes",
                &self.key,
                Some(body),
            )
            .await;
        if status == 201 {
            Ok(value["id"]
                .as_str()
                .expect("a created sandbox's id")
                .to_owned())
        } else {
            Err((status, value))
        }
    }

    /// The host that owns sandbox `id`, if one does.
    pub async fn owner(&self, id: &str) -> Option<String> {
        let view = self
            .ok(reqwest::Method::GET, &format!("/v1/sandboxes/{id}"), None)
            .await;
        view["host"].as_str().map(str::to_owned)
    }

    /// Puts sandbox `id` at least as deep as `level`.
    pub async fn sleep(&self, id: &str, level: &str) {
        self.ok(
            reqwest::Method::POST,
            &format!("/v1/sandboxes/{id}/sleep"),
            Some(json!({"level": level})),
        )
        .await;
    }

    /// Moves sandbox `id` to host `to`.
    pub async fn move_to(&self, id: &str, to: &str) {
        let moved = self
            .ok(
                reqwest::Method::POST,
                &format!("/v1/sandboxes/{id}/move"),
                Some(json!({"to": to})),
            )
            .await;
        assert_eq!(moved["host"].as_str(), Some(to), "{moved}");
    }

    /// Deletes sandbox `id`.
    pub async fn delete(&self, id: &str) {
        let (status, value) = self
            .call(
                reqwest::Method::DELETE,
                &format!("/v1/sandboxes/{id}"),
                &self.key,
                None,
            )
            .await;
        assert!(
            status < 300 || status == 404,
            "delete {id}: {status} {value}"
        );
    }

    /// Every host the service knows, as the operator sees them.
    pub async fn all_hosts(&self) -> Vec<Value> {
        let (status, value) = self
            .call(reqwest::Method::GET, "/v1/hosts", &self.operator, None)
            .await;
        assert_eq!(status, 200, "{value}");
        value.as_array().cloned().unwrap_or_default()
    }

    /// The live hosts' names, sorted, and the memory free for sandboxes on
    /// them in MiB as they last reported it, both from one reading of the
    /// hosts, so the two always describe the same fleet.
    pub async fn capacity(&self) -> (Vec<String>, u64) {
        let hosts = self.all_hosts().await;
        let live = hosts.iter().filter(|host| host["state"] == "live");
        let free = live
            .clone()
            .filter_map(|host| host["memory_free_mib"].as_u64())
            .sum();
        let mut names: Vec<String> = live
            .filter_map(|host| host["name"].as_str().map(str::to_owned))
            .collect();
        names.sort();
        (names, free)
    }

    /// The live hosts' names, sorted.
    pub async fn live(&self) -> Vec<String> {
        self.capacity().await.0
    }

    /// Waits until at least the fleet's fewest hosts are live.
    pub async fn ready(&self) -> Vec<String> {
        let started = Instant::now();
        loop {
            let live = self.live().await;
            if live.len() >= self.hosts {
                return live;
            }
            assert!(
                started.elapsed() < Duration::from_secs(600),
                "only {live:?} live; the tests need {}",
                self.hosts
            );
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }

    /// Runs `script` in sandbox `id`'s shell, waking it, and returns its
    /// output. Retries while the service cannot reach the sandbox yet; one
    /// deadline covers every try, each from its connect to its last byte,
    /// so a service that accepts and never answers fails the test too.
    pub async fn exec(&self, id: &str, script: &str) -> String {
        let deadline = tokio::time::Instant::now() + EXEC_WITHIN;
        loop {
            match tokio::time::timeout_at(deadline, self.try_exec(id, script)).await {
                Ok(Ok(output)) => return output,
                Ok(Err(error)) => {
                    let again = tokio::time::Instant::now() + Duration::from_millis(500);
                    assert!(again < deadline, "{id}: {error}");
                    tokio::time::sleep_until(again).await;
                }
                Err(elapsed) => panic!("{id}: no answer within {EXEC_WITHIN:?}: {elapsed}"),
            }
        }
    }

    async fn try_exec(&self, id: &str, script: &str) -> Result<String, String> {
        let address = self.api.trim_start_matches("http://");
        let mut tcp = TcpStream::connect(address)
            .await
            .map_err(|error| error.to_string())?;
        let request = format!(
            "GET /v1/sandboxes/{id}/connect/{SHELL_PORT} HTTP/1.1\r\nhost: fleet\r\nx-api-key: {}\r\n\
             connection: upgrade\r\nupgrade: {}\r\n\r\n",
            self.key,
            compute_control::api::STREAM_PROTOCOL
        );
        tcp.write_all(request.as_bytes())
            .await
            .map_err(|error| error.to_string())?;
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            let read = tcp
                .read(&mut byte)
                .await
                .map_err(|error| error.to_string())?;
            if read == 0 {
                return Err(format!(
                    "the head ended early: {}",
                    String::from_utf8_lossy(&head)
                ));
            }
            head.push(byte[0]);
        }
        let head = String::from_utf8_lossy(&head).into_owned();
        if !head.starts_with("HTTP/1.1 101") {
            let mut body = Vec::new();
            let _ = tokio::time::timeout(Duration::from_secs(2), tcp.read_to_end(&mut body)).await;
            return Err(format!(
                "{} {}",
                head.lines().next().unwrap_or_default(),
                String::from_utf8_lossy(&body)
            ));
        }
        tcp.write_all(format!("{script}\nexit\n").as_bytes())
            .await
            .map_err(|error| error.to_string())?;
        let mut output = Vec::new();
        tokio::time::timeout(Duration::from_secs(60), tcp.read_to_end(&mut output))
            .await
            .map_err(|_| "the command did not end".to_owned())?
            .map_err(|error| error.to_string())?;
        Ok(String::from_utf8_lossy(&output).into_owned())
    }

    /// Starts the beater and writes `token` to a file in sandbox `id`;
    /// returns the beater's process id.
    pub async fn start_beating(&self, id: &str, token: &str) -> String {
        let witness = self.witness.advertised;
        let output = self
            .exec(
                id,
                &format!(
                    "mkdir -p /root/fleet && echo {token} > /root/fleet/token && sync\n\
                     setsid bash -c 'n=0; while :; do n=$((n+1)); \
                     echo \"{id} $n\" 2>/dev/null > /dev/udp/{ip}/{port}; sleep 0.05; done' \
                     </dev/null >/dev/null 2>&1 &\n\
                     echo pid=$!",
                    ip = witness.ip(),
                    port = witness.port(),
                ),
            )
            .await;
        field(&output, "pid").to_owned()
    }

    /// What sandbox `id` says of its beater `pid` and its token file.
    pub async fn check(&self, id: &str, pid: &str) -> (bool, String) {
        let output = self
            .exec(
                id,
                &format!("kill -0 {pid} 2>/dev/null && echo alive=yes || echo alive=no\necho token=$(cat /root/fleet/token)"),
            )
            .await;
        (
            field(&output, "alive") == "yes",
            field(&output, "token").to_owned(),
        )
    }

    /// Ends `host` at once, with no chance to save anything.
    pub fn kill(&self, host: &str) {
        run(&self.kill, host);
    }

    /// Cuts `host` off from the service, but not from the witness.
    pub fn cut(&self, host: &str) {
        run(&self.cut, host);
    }
}

fn run(template: &str, host: &str) {
    let command = template.replace("{host}", host);
    let status = Command::new("sh")
        .arg("-c")
        .arg(&command)
        .status()
        .expect("sh");
    assert!(status.success(), "{command}: {status}");
}

/// The value of the line `name=value` in `output`.
pub fn field<'a>(output: &'a str, name: &str) -> &'a str {
    output
        .lines()
        .find_map(|line| line.trim().strip_prefix(name)?.strip_prefix('='))
        .unwrap_or_else(|| panic!("no {name}= in {output:?}"))
}

/// The address `host` resolves to.
pub async fn address(host: &str) -> IpAddr {
    tokio::net::lookup_host((host, 0))
        .await
        .unwrap_or_else(|error| panic!("{host}: {error}"))
        .next()
        .unwrap_or_else(|| panic!("{host} has no address"))
        .ip()
}

/// A token no earlier run wrote.
pub fn token() -> String {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).expect("random bytes");
    format!("{:016x}", u64::from_le_bytes(bytes))
}
