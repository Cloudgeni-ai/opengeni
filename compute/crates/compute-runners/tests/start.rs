//! The runner image's start command (`docker/github-runner-start.sh`),
//! run with stand-ins for `dockerd`, `docker` and `setpriv`: the runner
//! starts, and so connects to GitHub, only once the sandbox is ready.

use std::fs;
use std::os::unix::fs::PermissionsExt as _;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const SCRIPT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../docker/github-runner-start.sh"
);

/// A `dockerd` that fails its first `STUB_CRASHES` starts, then answers
/// after `STUB_DELAY` seconds and runs until the test says stop.
const DOCKERD: &str = r#"#!/bin/bash
n=$(( $(cat "$STUB/starts" 2>/dev/null || echo 0) + 1 ))
echo "$n" >"$STUB/starts"
if [ "$n" -le "${STUB_CRASHES:-0}" ]; then echo "start $n fails"; exit 1; fi
sleep "${STUB_DELAY:-0}"
touch "$STUB/up"
until [ -e "$STUB/stop" ]; do sleep 0.1; done
"#;

const DOCKER: &str = r#"#!/bin/bash
[ "$1" = info ] && [ -e "$STUB/up" ]
"#;

/// Records what the sandbox looked like when the runner started.
const SETPRIV: &str = r#"#!/bin/bash
{
  [ -e "$STUB/up" ] && echo docker-up
  [ -e "$STUB/warm" ] && echo warm
  ls "$COMPUTE_RUNNER_ACTIVITY"
  echo "$@"
} >"$STUB/ran"
"#;

struct Sandbox {
    dir: PathBuf,
}

impl Sandbox {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("runner-start-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for sub in ["bin", "stub", "home", "activity"] {
            fs::create_dir_all(dir.join(sub)).unwrap();
        }
        for (name, body) in [
            ("dockerd", DOCKERD),
            ("docker", DOCKER),
            ("setpriv", SETPRIV),
        ] {
            let path = dir.join("bin").join(name);
            fs::write(&path, body).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        Self { dir }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    fn stub(&self, name: &str) -> PathBuf {
        self.dir.join("stub").join(name)
    }

    /// Runs the start command with `env`, until it exits (within 20 s);
    /// returns what it said.
    fn start(&self, env: &[(&str, &str)]) -> String {
        let path = format!(
            "{}:{}",
            self.path("bin").display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let mut child = Command::new("bash")
            .arg(SCRIPT)
            .env_clear()
            .env("PATH", path)
            .env("STUB", self.path("stub"))
            .env("COMPUTE_RUNNER_LOG", self.path("dockerd.log"))
            .env("COMPUTE_RUNNER_ACTIVITY", self.path("activity"))
            .env("COMPUTE_RUNNER_HOME", self.path("home"))
            .envs(env.iter().copied())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while child.try_wait().unwrap().is_none() {
            if Instant::now() > deadline {
                child.kill().unwrap();
                fs::write(self.stub("stop"), "").unwrap();
                panic!("the start command never ended");
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let output = child.wait_with_output().unwrap();
        let said = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.status.success(), "{said}");
        said
    }

    /// What the runner saw when it started.
    fn ran(&self) -> String {
        fs::read_to_string(self.stub("ran")).unwrap_or_default()
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::write(self.stub("stop"), "");
        std::thread::sleep(Duration::from_millis(300));
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn starts(sandbox: &Sandbox) -> u32 {
    fs::read_to_string(sandbox.stub("starts"))
        .unwrap()
        .trim()
        .parse()
        .unwrap()
}

/// A slow Docker is waited for: the runner starts once Docker answers,
/// counted as a running command, as `runner`.
#[test]
fn the_runner_starts_once_docker_answers() {
    let sandbox = Sandbox::new("slow");
    sandbox.start(&[
        ("ACTIONS_RUNNER_INPUT_JITCONFIG", "jit"),
        ("STUB_DELAY", "2"),
    ]);
    let ran = sandbox.ran();
    assert!(ran.contains("docker-up"), "{ran}");
    assert!(
        ran.contains("runner."),
        "counted as a running command: {ran}"
    );
    assert!(ran.contains("--reuid=runner"), "{ran}");
}

/// A dockerd that exits is started again, and the runner waits for it:
/// it never starts without Docker.
#[test]
fn a_dockerd_that_exits_is_started_again_before_the_runner() {
    let sandbox = Sandbox::new("crash");
    let said = sandbox.start(&[
        ("ACTIONS_RUNNER_INPUT_JITCONFIG", "jit"),
        ("STUB_CRASHES", "2"),
    ]);
    assert_eq!(starts(&sandbox), 3, "{said}");
    assert!(said.contains("dockerd exited; it starts again"), "{said}");
    assert!(sandbox.ran().contains("docker-up"), "{}", sandbox.ran());
}

/// The image's own check is waited for as well as Docker.
#[test]
fn the_images_own_check_is_waited_for() {
    let sandbox = Sandbox::new("check");
    let warm = sandbox.stub("warm");
    let later = warm.clone();
    let maker = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(1));
        fs::write(later, "").unwrap();
    });
    let check = format!("test -e '{}'", warm.display());
    sandbox.start(&[
        ("ACTIONS_RUNNER_INPUT_JITCONFIG", "jit"),
        ("COMPUTE_RUNNER_READY", &check),
    ]);
    maker.join().unwrap();
    let ran = sandbox.ran();
    assert!(ran.contains("docker-up") && ran.contains("warm"), "{ran}");
}
