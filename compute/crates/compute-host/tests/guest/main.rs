//! Sandbox images built from OCI images (ADR 19) under the host agent and
//! real Firecracker: `compute-guest` as PID 1, envd answering through the
//! gateway port, each sandbox's own environment and token across sleep,
//! templates and reboots, the image's command under its user, and a clean
//! shutdown.
//!
//! Runs as root when `COMPUTE_TEST_LAB` names a lab directory (see the lab
//! test) and `COMPUTE_TEST_GUEST` the directory `guest/build.sh` made. The
//! images are built from public registries at the start, so the host needs
//! the internet:
//!
//! ```text
//! CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER="sudo -E" COMPUTE_TEST_LAB=/lab \
//!   COMPUTE_TEST_GUEST=$HOME/guest-out \
//!   cargo test --release -p compute-host --test guest -- --test-threads 1
//! ```
//!
//! `COMPUTE_TEST_REQUIRE=lab,guest` makes a test that cannot run fail.
//! `COMPUTE_TEST_RESULTS` names a directory for JSON results.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use compute_core::SandboxId;
use compute_host::client::Client;
use compute_host::protocol::{
    HostStatus, Id, ImageId, LevelName, Reply, Request, SandboxConfig, SleepConfig, TemplateState,
};
use tokio::time::{Instant, sleep};

mod envd;
#[path = "../support/required.rs"]
mod required;

use envd::{Envd, init};
use required::skip;

/// The images the tests boot: a name, the OCI reference and the directory
/// a command starts in by default.
const ALPINE: (&str, &str, &str) = ("alpine", "alpine:3.20", "/home/user");
const BUSYBOX: (&str, &str, &str) = ("busybox", "busybox:1.37", "/home/user");
const SANDBOX: (&str, &str, &str) = (
    "sandbox",
    "ghcr.io/cloudgeni-ai/opengeni-sandbox:0.20.0",
    "/workspace",
);

/// The parent cgroup of every VM these tests start.
const CGROUP: &str = "/sys/fs/cgroup/compute-test";

/// The lab and guest directories, or `None` (a skip) without them.
fn setup() -> Option<(PathBuf, PathBuf)> {
    let Some(lab) = std::env::var_os("COMPUTE_TEST_LAB").map(PathBuf::from) else {
        skip("lab", "set COMPUTE_TEST_LAB to run against Firecracker");
        return None;
    };
    let Some(guest) = std::env::var_os("COMPUTE_TEST_GUEST").map(PathBuf::from) else {
        skip(
            "guest",
            "set COMPUTE_TEST_GUEST to the directory guest/build.sh made",
        );
        return None;
    };
    Some((lab, guest))
}

/// Images this test process built, by name. Each run builds afresh into
/// the same directory, so the images always hold the guest under test and
/// earlier runs leave nothing behind.
static BUILT: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);

/// Builds the image `reference` as `name`, once per test process, and
/// returns its file.
fn image(lab: &Path, guest: &Path, (name, reference, _): (&str, &str, &str)) -> PathBuf {
    let mut built = BUILT.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(path) = built.get_or_insert_default().get(name) {
        return path.clone();
    }
    let dir = lab.join("t").join("guest-images");
    std::fs::create_dir_all(&dir).unwrap();
    let output = dir.join(format!("{name}.ext4"));
    let started = Instant::now();
    let run = Command::new(env!("CARGO_BIN_EXE_compute-host"))
        .arg("build-image")
        .arg(reference)
        .arg("--guest")
        .arg(guest)
        .arg("--output")
        .arg(&output)
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "build-image {reference}: {}",
        String::from_utf8_lossy(&run.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&run.stdout).unwrap();
    save_results(
        &format!("image-{name}"),
        &serde_json::json!({
            "reference": reference,
            "build_s": started.elapsed().as_secs_f64(),
            "built": report,
        }),
    );
    built
        .get_or_insert_default()
        .insert(name.to_owned(), output.clone());
    output
}

fn save_results(name: &str, results: &serde_json::Value) {
    println!("{name}: {results}");
    if let Some(dir) = std::env::var_os("COMPUTE_TEST_RESULTS") {
        let dir = PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{name}.json")),
            serde_json::to_vec_pretty(results).unwrap(),
        )
        .unwrap();
    }
}

/// How many Firecracker processes run on the host.
fn firecrackers() -> usize {
    let output = Command::new("pgrep")
        .args(["-c", "-x", "firecracker"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .unwrap_or(0)
}

fn id(n: usize) -> Id {
    Id(SandboxId((0x6e5 << 64) | n as u128))
}

/// One agent on its own state root, copying new disks from one image.
struct Host {
    root: PathBuf,
    socket: PathBuf,
    child: Option<Child>,
    client: Client,
}

impl Host {
    async fn start(lab: &Path, name: &str, image: &Path, extra: &[&str]) -> Self {
        let root = lab
            .join("t")
            .join(format!("g-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let socket = root.join("agent.sock");
        let log = std::fs::File::create(root.join("agent.log")).unwrap();
        let profile = std::env::var("COMPUTE_TEST_PROFILE")
            .map(|name| vec!["--memory-profile".to_owned(), name])
            .unwrap_or_default();
        let child = Command::new(env!("CARGO_BIN_EXE_compute-host"))
            .arg("--socket")
            .arg(&socket)
            .arg("serve")
            .arg("--root")
            .arg(root.join("state"))
            .arg("--firecracker")
            .arg(lab.join("bin/firecracker"))
            .arg("--jailer")
            .arg(lab.join("bin/jailer"))
            .arg("--kernel")
            .arg(lab.join("vmlinux"))
            .arg("--base-image")
            .arg(image)
            .arg("--cgroup")
            .arg(CGROUP)
            .args(["--network", "--restore-notice-port", "53"])
            .args(profile)
            .args(extra)
            .env("RUST_LOG", "info")
            .stdout(Stdio::null())
            .stderr(log)
            .spawn()
            .unwrap();
        let client = Client::new(&socket);
        let deadline = Instant::now() + Duration::from_secs(60);
        while !(socket.exists() && client.call(&Request::Status).await.is_ok()) {
            assert!(Instant::now() < deadline, "the agent never came up");
            sleep(Duration::from_millis(20)).await;
        }
        Self {
            root,
            socket,
            child: Some(child),
            client,
        }
    }

    async fn status(&self) -> HostStatus {
        match self.client.call(&Request::Status).await.unwrap() {
            Reply::Status(status) => *status,
            other => panic!("{other:?}"),
        }
    }

    async fn wait_until(&self, what: &str, done: impl Fn(&HostStatus) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(300);
        while !done(&self.status().await) {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            sleep(Duration::from_millis(50)).await;
        }
    }

    async fn create(&self, sandbox: Id, vcpus: u8, memory_mib: u32) {
        self.create_as(
            sandbox,
            SandboxConfig::new(vcpus, memory_mib, SleepConfig::default()),
        )
        .await
        .unwrap();
    }

    /// Creates `sandbox` as `config` says; the agent's error if it refuses.
    async fn create_as(&self, sandbox: Id, config: SandboxConfig) -> Result<(), String> {
        let reply = self
            .client
            .call(&Request::Create {
                id: sandbox,
                config,
            })
            .await
            .unwrap();
        match reply {
            Reply::Done => Ok(()),
            other => Err(format!("{other:?}")),
        }
    }

    async fn sleep_to(&self, sandbox: Id, level: LevelName) {
        let request = Request::Sleep {
            id: sandbox,
            generation: None,
            level,
        };
        assert_eq!(self.client.call(&request).await.unwrap(), Reply::Done);
        self.wait_until("the sandbox asleep", |status| {
            status
                .sandboxes
                .iter()
                .any(|found| found.id == sandbox && found.level == level)
        })
        .await;
    }

    fn steps(status: &HostStatus, name: &str) -> u64 {
        status
            .steps
            .iter()
            .find(|(step, _)| step == name)
            .map_or(0, |(_, stats)| stats.done)
    }

    /// The directory of the only sandbox VM on this host.
    fn vm_dir(&self) -> PathBuf {
        let dir = self.root.join("state/vm/firecracker");
        let mut found: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.join("console.log").exists())
            .collect();
        assert_eq!(found.len(), 1, "{found:?}");
        found.pop().unwrap()
    }

    /// Removes every sandbox, ends the agent and deletes its files.
    async fn finish(mut self) {
        for sandbox in self.status().await.sandboxes {
            let reply = self
                .client
                .call(&Request::Remove {
                    id: sandbox.id,
                    generation: None,
                })
                .await
                .unwrap();
            assert_eq!(reply, Reply::Done);
        }
        self.end();
        let _ = std::fs::remove_dir_all(&self.root);
    }

    fn end(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = std::fs::remove_file(&self.socket);
    }
}

impl Drop for Host {
    /// A failed test leaves its agent's log with the results and its VMs
    /// ended, so the next test starts clean.
    fn drop(&mut self) {
        self.end();
        if std::thread::panicking() {
            if let Some(dir) = std::env::var_os("COMPUTE_TEST_RESULTS") {
                let name = self
                    .root
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                let _ = std::fs::copy(
                    self.root.join("agent.log"),
                    PathBuf::from(dir).join(format!("{name}-failed-agent.log")),
                );
            }
            if let Ok(vms) = std::fs::read_dir(CGROUP) {
                for vm in vms.flatten().filter(|vm| vm.path().is_dir()) {
                    let _ = std::fs::write(vm.path().join("cgroup.kill"), "1");
                }
            }
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}

/// The checks every image passes once its sandbox has its token: its own
/// environment, the default user and directory, and the token required.
async fn assert_own(host: &Host, sandbox: Id, token: &str, value: &str, workdir: &str) {
    let refused = Envd::new(&host.client, sandbox)
        .run("true")
        .await
        .expect_err("a request without the token");
    assert!(refused.starts_with("401"), "{sandbox}: {refused}");
    let wrong = Envd::new(&host.client, sandbox)
        .with_token("not-the-token")
        .run("true")
        .await
        .expect_err("a request with another token");
    assert!(wrong.starts_with("401"), "{sandbox}: {wrong}");
    let ran = Envd::new(&host.client, sandbox)
        .with_token(token)
        .run("id -un; pwd; echo \"$FOO\"")
        .await
        .unwrap();
    assert_eq!(
        (ran.stdout.as_str(), ran.exit_code),
        (format!("user\n{workdir}\n{value}\n").as_str(), 0),
        "{sandbox}: {ran:?}"
    );
}

/// Each image boots with `compute-guest` as PID 1 and envd answers through
/// the gateway; a create's `init` gives the sandbox its environment and
/// token, files go in and out, and all of it holds across a save and a
/// restore from the memory image.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn images_boot_envd_and_keep_their_sandbox_across_sleep() {
    let Some((lab, guest)) = setup() else {
        return;
    };
    let mut results = serde_json::Map::new();
    for spec in [ALPINE, BUSYBOX, SANDBOX] {
        let (name, _, workdir) = spec;
        let image = image(&lab, &guest, spec);
        let host = Host::start(&lab, name, &image, &[]).await;
        let sandbox = id(0);
        let created = Instant::now();
        host.create(sandbox, 1, 1024).await;
        let anyone = Envd::new(&host.client, sandbox);
        anyone.wait_healthy(Duration::from_secs(120)).await;
        let healthy_ms = created.elapsed().as_secs_f64() * 1e3;

        let token = format!("token-{name}");
        init(&host.client, sandbox, &[("FOO", name)], &token).await;
        assert_own(&host, sandbox, &token, name, workdir).await;
        let envd = Envd::new(&host.client, sandbox).with_token(&token);
        let data = format!("hello from {name}\n").repeat(1000);
        assert_eq!(
            envd.upload("/tmp/hello.txt", data.as_bytes()).await,
            Ok(hyper::StatusCode::OK)
        );
        let (status, body) = envd.download("/tmp/hello.txt").await.unwrap();
        assert_eq!(
            (status, &body[..]),
            (hyper::StatusCode::OK, data.as_bytes())
        );
        let root = envd.with_user("root").run("id -un").await.unwrap();
        assert_eq!(root.stdout, "root\n");

        let restores = Host::steps(&host.status().await, "restore");
        host.sleep_to(sandbox, LevelName::Saved).await;
        let woke = Instant::now();
        Envd::new(&host.client, sandbox)
            .with_token(&token)
            .wait_healthy(Duration::from_secs(60))
            .await;
        let wake_ms = woke.elapsed().as_secs_f64() * 1e3;
        assert!(
            Host::steps(&host.status().await, "restore") > restores,
            "{name}: woke from its memory image"
        );
        assert_own(&host, sandbox, &token, name, workdir).await;
        let (status, body) = Envd::new(&host.client, sandbox)
            .with_token(&token)
            .download("/tmp/hello.txt")
            .await
            .unwrap();
        assert_eq!(
            (status, &body[..]),
            (hyper::StatusCode::OK, data.as_bytes())
        );
        results.insert(
            name.to_owned(),
            serde_json::json!({ "create_to_healthy_ms": healthy_ms, "wake_to_healthy_ms": wake_ms }),
        );
        host.finish().await;
    }
    save_results("guest-images", &serde_json::Value::Object(results));
}

/// Which image a sandbox runs: `alpine` or `busybox`.
async fn distribution(host: &Host, sandbox: Id, token: &str) -> String {
    let ran = Envd::new(&host.client, sandbox)
        .with_token(token)
        .run("if [ -e /etc/alpine-release ]; then echo alpine; else echo busybox; fi")
        .await
        .unwrap();
    ran.stdout.trim().to_owned()
}

/// A create may name a stored image instead of the host's base image. The
/// host fetches it from its store once, checks it, keeps it, and builds a
/// template of that image and shape, from which later creates of it start;
/// sandboxes of the base image on the same host are unaffected. A create
/// naming an image no store has is refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn creates_name_their_image_fetched_once_with_its_own_template() {
    let Some((lab, guest)) = setup() else {
        return;
    };
    let alpine = image(&lab, &guest, ALPINE);
    let busybox = image(&lab, &guest, BUSYBOX);
    let store = lab
        .join("t")
        .join(format!("g-store-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&store);
    let stored = Command::new(env!("CARGO_BIN_EXE_compute-host"))
        .arg("build-image")
        .arg(BUSYBOX.1)
        .arg("--guest")
        .arg(&guest)
        .arg("--output")
        .arg(busybox.with_file_name("busybox-stored.ext4"))
        .arg("--store")
        .arg(&store)
        .output()
        .unwrap();
    assert!(stored.status.success(), "{stored:?}");
    let report: serde_json::Value = serde_json::from_slice(&stored.stdout).unwrap();
    let image: ImageId = report["image"].as_str().unwrap().parse().unwrap();
    let _ = std::fs::remove_file(busybox.with_file_name("busybox-stored.ext4"));

    let store_arg = store.to_string_lossy().into_owned();
    let host = Host::start(
        &lab,
        "img",
        &alpine,
        &["--store", &store_arg, "--template-ready-port", "54"],
    )
    .await;
    let of_image = || SandboxConfig::new(1, 512, SleepConfig::default()).with_image(image);
    let (first, base, warm) = (id(10), id(11), id(12));
    let fetching = Instant::now();
    host.create_as(first, of_image()).await.unwrap();
    let fetch_s = fetching.elapsed().as_secs_f64();
    host.create(base, 1, 512).await;
    for (sandbox, expected) in [(first, "busybox"), (base, "alpine")] {
        Envd::new(&host.client, sandbox)
            .wait_healthy(Duration::from_secs(120))
            .await;
        init(&host.client, sandbox, &[], "token").await;
        assert_eq!(distribution(&host, sandbox, "token").await, expected);
    }
    assert!(
        host.root
            .join(format!("state/rootfs/{image}.ext4"))
            .exists()
    );

    // The image's own template, beside the base image's.
    host.wait_until("a ready template of the image", |status| {
        status
            .templates
            .iter()
            .any(|template| template.image == Some(image) && template.state == TemplateState::Ready)
    })
    .await;
    let boots = Host::steps(&host.status().await, "boot");
    host.create_as(warm, of_image()).await.unwrap();
    Envd::new(&host.client, warm)
        .wait_healthy(Duration::from_secs(60))
        .await;
    init(&host.client, warm, &[("FOO", "warm")], "token-warm").await;
    assert_eq!(distribution(&host, warm, "token-warm").await, "busybox");
    assert_own(&host, warm, "token-warm", "warm", BUSYBOX.2).await;
    assert_eq!(
        Host::steps(&host.status().await, "boot"),
        boots,
        "it restored the image's template"
    );

    let unknown = host
        .create_as(
            id(13),
            SandboxConfig::new(1, 512, SleepConfig::default()).with_image(ImageId([7; 32])),
        )
        .await
        .expect_err("an image no store has");
    assert!(unknown.contains("no image"), "{unknown}");
    save_results(
        "guest-image-fetch",
        &serde_json::json!({ "first_create_with_fetch_s": fetch_s }),
    );
    host.finish().await;
    let _ = std::fs::remove_dir_all(&store);
}

/// Sandboxes started from a warm template of an image each get their own
/// environment and token: one's token opens only its own envd.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn templates_give_each_sandbox_its_own_environment_and_token() {
    let Some((lab, guest)) = setup() else {
        return;
    };
    let image = image(&lab, &guest, ALPINE);
    let host = Host::start(
        &lab,
        "tpl",
        &image,
        &["--template-ready-port", "54", "--template", "1x512"],
    )
    .await;
    host.wait_until("a ready template", |status| {
        status
            .templates
            .iter()
            .any(|template| template.state == TemplateState::Ready)
    })
    .await;
    let sandboxes = [id(1), id(2)];
    for (n, &sandbox) in sandboxes.iter().enumerate() {
        host.create(sandbox, 1, 512).await;
        init(
            &host.client,
            sandbox,
            &[("FOO", &format!("own-{n}"))],
            &format!("token-{n}"),
        )
        .await;
    }
    for (n, &sandbox) in sandboxes.iter().enumerate() {
        assert_own(
            &host,
            sandbox,
            &format!("token-{n}"),
            &format!("own-{n}"),
            ALPINE.2,
        )
        .await;
        let other = format!("token-{}", 1 - n);
        let refused = Envd::new(&host.client, sandbox)
            .with_token(&other)
            .run("true")
            .await
            .expect_err("another sandbox's token");
        assert!(refused.starts_with("401"), "{refused}");
    }
    let status = host.status().await;
    assert_eq!(Host::steps(&status, "boot"), 0, "every sandbox restored");
    host.finish().await;
}

/// A copy of the alpine image whose config is `config`, as
/// `<name>.ext4`, and the config's file beside it.
fn command_image(lab: &Path, guest: &Path, name: &str, config: &serde_json::Value) -> PathBuf {
    let alpine = image(lab, guest, ALPINE);
    let image = alpine.with_file_name(format!("{name}.ext4"));
    let copied = Command::new("cp")
        .arg("--sparse=always")
        .arg(&alpine)
        .arg(&image)
        .status()
        .unwrap();
    assert!(copied.success());
    let local = image.with_extension("json");
    std::fs::write(&local, config.to_string()).unwrap();
    for request in [
        "rm /opengeni/image.json".to_owned(),
        format!("write {} /opengeni/image.json", local.display()),
    ] {
        let edited = Command::new("debugfs")
            .args(["-w", "-R", &request])
            .arg(&image)
            .output()
            .unwrap();
        assert!(edited.status.success(), "debugfs {request}: {edited:?}");
    }
    let _ = std::fs::remove_file(&local);
    image
}

/// Whether `path` exists in the sandbox, asked as root.
async fn exists(envd: &Envd<'_>, path: &str) -> bool {
    let ran = envd
        .run(&format!("test -e {path} && echo yes || echo no"))
        .await
        .unwrap();
    ran.stdout.trim() == "yes"
}

/// The image's command runs once the sandbox has its own init, as `docker
/// run` would: under the image's user, in its working directory, with its
/// environment and then the sandbox's. A guest told to stop sends it
/// `SIGTERM` (which it can handle), ends its processes, leaves its file
/// system clean and ends the VM; booted again from its disk, it still
/// holds its sandbox's environment and token, and the command starts
/// again.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_image_command_runs_as_its_user_and_the_guest_shuts_down_cleanly() {
    let Some((lab, guest)) = setup() else {
        return;
    };
    let config = serde_json::json!({
        "user": "nobody",
        "workingDir": "/srv/app",
        "env": ["PATH=/usr/sbin:/usr/bin:/sbin:/bin", "GREETING=hello"],
        "entrypoint": ["/bin/sh", "-c"],
        "cmd": ["trap 'echo got-term > /tmp/term-got; exit 0' TERM; \
                 echo \"$(id -un) $(pwd) $HOME $GREETING $FOO\" > /tmp/command-ran; \
                 while :; do sleep 1; done"],
    });
    let image = command_image(&lab, &guest, "alpine-command", &config);

    let host = Host::start(&lab, "command", &image, &[]).await;
    let sandbox = id(3);
    host.create(sandbox, 1, 512).await;
    let before = Envd::new(&host.client, sandbox).with_user("root");
    before.wait_healthy(Duration::from_secs(120)).await;
    // Not before the sandbox has its own init.
    assert!(!exists(&before, "/tmp/command-ran").await);
    init(&host.client, sandbox, &[("FOO", "kept")], "token-command").await;
    let root = Envd::new(&host.client, sandbox)
        .with_token("token-command")
        .with_user("root");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !exists(&root, "/tmp/command-ran").await {
        assert!(Instant::now() < deadline, "the command never ran");
        sleep(Duration::from_millis(100)).await;
    }
    let ran = root
        .run("cat /tmp/command-ran; ps -o user,args | grep '[t]erm-got'")
        .await
        .unwrap();
    assert_eq!(
        ran.stdout.lines().next(),
        Some("nobody /srv/app / hello kept"),
        "{ran:?}"
    );
    assert!(
        ran.stdout
            .lines()
            .nth(1)
            .is_some_and(|ps| ps.starts_with("nobody")),
        "{ran:?}"
    );
    // The image's PATH is the image's; envd's processes get the sandbox's.
    assert_own(&host, sandbox, "token-command", "kept", "/srv/app").await;

    // Told to stop, as a power button or the host would.
    let _ = root.run("rm /tmp/command-ran; kill -TERM 1").await;
    let deadline = Instant::now() + Duration::from_secs(60);
    let vm = host.vm_dir();
    let console = vm.join("console.log");
    loop {
        let log = std::fs::read_to_string(&console).unwrap_or_default();
        if log.contains("reboot: Restarting system") {
            assert!(log.contains("compute-guest: shutting down"), "{log}");
            assert!(!log.contains("Kernel panic"), "{log}");
            break;
        }
        assert!(Instant::now() < deadline, "the guest never ended: {log}");
        sleep(Duration::from_millis(100)).await;
    }
    while firecrackers() > 0 {
        assert!(Instant::now() < deadline, "the VM never ended");
        sleep(Duration::from_millis(100)).await;
    }
    let checked = Command::new("e2fsck")
        .args(["-f", "-n"])
        .arg(vm.join("root/disk.ext4"))
        .output()
        .unwrap();
    assert!(
        checked.status.success(),
        "the disk is not clean: {}",
        String::from_utf8_lossy(&checked.stdout)
    );

    // Booted again from its disk, it is the same sandbox, and its command
    // handled the TERM it got and runs again.
    root.wait_healthy(Duration::from_secs(120)).await;
    assert_own(&host, sandbox, "token-command", "kept", "/srv/app").await;
    let term = root.run("cat /tmp/term-got").await.unwrap();
    assert_eq!(term.stdout.trim(), "got-term", "{term:?}");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !exists(&root, "/tmp/command-ran").await {
        assert!(Instant::now() < deadline, "the command did not start again");
        sleep(Duration::from_millis(100)).await;
    }
    host.finish().await;
    let _ = std::fs::remove_file(&image);
}

/// A warm template of an image with a command never runs the command:
/// each sandbox started from it runs it once given its own init, after it
/// took its own identity, so nothing the command makes is shared between
/// sandboxes.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_template_runs_the_image_command_in_each_sandbox_not_in_itself() {
    let Some((lab, guest)) = setup() else {
        return;
    };
    let config = serde_json::json!({
        "entrypoint": ["/bin/sh", "-c"],
        "cmd": ["{ cat /etc/machine-id; echo \"$FOO\"; } > /tmp/command-saw; exec sleep 100000"],
    });
    let image = command_image(&lab, &guest, "alpine-template-command", &config);
    let host = Host::start(
        &lab,
        "tplcmd",
        &image,
        &["--template-ready-port", "54", "--template", "1x512"],
    )
    .await;
    host.wait_until("a ready template", |status| {
        status
            .templates
            .iter()
            .any(|template| template.state == TemplateState::Ready)
    })
    .await;
    let sandboxes = [id(4), id(5)];
    let mut machine_ids = Vec::new();
    for (n, &sandbox) in sandboxes.iter().enumerate() {
        host.create(sandbox, 1, 512).await;
        let before = Envd::new(&host.client, sandbox).with_user("root");
        assert!(
            !exists(&before, "/tmp/command-saw").await,
            "the command ran before the sandbox's init"
        );
        let token = format!("token-{n}");
        init(
            &host.client,
            sandbox,
            &[("FOO", &format!("own-{n}"))],
            &token,
        )
        .await;
        let root = Envd::new(&host.client, sandbox)
            .with_token(&token)
            .with_user("root");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !exists(&root, "/tmp/command-saw").await {
            assert!(Instant::now() < deadline, "the command never ran");
            sleep(Duration::from_millis(100)).await;
        }
        let ran = root
            .run("cat /tmp/command-saw /etc/machine-id")
            .await
            .unwrap();
        let lines: Vec<&str> = ran.stdout.lines().collect();
        assert_eq!(lines.len(), 3, "{ran:?}");
        assert_eq!(lines[0], lines[2], "the command saw the sandbox's identity");
        assert_eq!(lines[1], format!("own-{n}"), "and its environment");
        machine_ids.push(lines[0].to_owned());
    }
    assert_ne!(machine_ids[0], machine_ids[1]);
    let status = host.status().await;
    assert_eq!(Host::steps(&status, "boot"), 0, "every sandbox restored");
    host.finish().await;
    let _ = std::fs::remove_file(&image);
}
