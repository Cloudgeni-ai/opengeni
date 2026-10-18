//! Linux process hardening behind one small, audited unsafe boundary.
//!
//! Rust requires [`std::os::unix::process::CommandExt::pre_exec`] to be called
//! from `unsafe` because the closure runs after `fork` in a potentially
//! multi-threaded process. The agent workspace otherwise forbids unsafe code, so
//! the raw async-signal-safe operations live only in this leaf crate.

#[cfg(target_os = "linux")]
use std::fs::File;

#[cfg(target_os = "linux")]
#[allow(unsafe_code)]
mod ffi;

#[cfg(unix)]
#[allow(unsafe_code)]
mod inherited;

#[cfg(unix)]
pub use inherited::claim_inherited_fd;

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod process_group;
#[cfg(target_os = "macos")]
pub use process_group::process_group_has_live_children;

/// Configures `command` to set its own Linux OOM victim bias to `score` after
/// `fork` but before user code can run or create descendants. `score` must be in
/// the kernel ABI's nonnegative range; values above 1000 are capped at the ABI
/// maximum before the post-fork hook is registered.
///
/// The hook is deliberately best-effort. A restrictive kernel policy must not
/// turn an otherwise valid command into a spawn failure; the parent performs a
/// second observable write after spawn and reports failure there.
#[cfg(target_os = "linux")]
pub fn configure_oom_score_adj_before_exec(command: &mut tokio::process::Command, score: u16) {
    ffi::configure_oom_score_adj_before_exec(command, score);
}

/// Configures `command` to move its forked process into an already-created
/// cgroup before `execve(2)`. Every descendant is therefore born in the same
/// cgroup even if user code immediately creates another session or process
/// group.
///
/// `cgroup_procs` must be an open writable handle for the destination
/// `cgroup.procs`. A failed migration always fails spawn before user code runs;
/// there is no post-spawn repair mode.
#[cfg(target_os = "linux")]
pub fn configure_process_cgroup_before_exec(
    command: &mut tokio::process::Command,
    cgroup_procs: File,
) {
    ffi::configure_process_cgroup_before_exec(command, cgroup_procs);
}

/// Configures `command` to run as `uid`/`gid` with exactly `groups` as its
/// supplementary groups. The switch is registered as a pre-exec hook, so it runs
/// after every hook registered before it (cgroup migration and OOM bias still
/// run with the agent's privileges) and before user code. A failed switch fails
/// the spawn; the child never runs with the agent's credentials.
#[cfg(target_os = "linux")]
pub fn configure_credentials_before_exec(
    command: &mut tokio::process::Command,
    uid: u32,
    gid: u32,
    groups: Vec<u32>,
) {
    ffi::configure_credentials_before_exec(command, uid, gid, groups);
}

/// Irreversibly switches the CALLING THREAD ONLY to `uid`/`gid` with exactly
/// `groups` as supplementary groups (real, effective, saved and filesystem ids
/// all change, and a non-root result loses every capability). Other threads keep
/// their credentials. Threads and processes later created by this thread inherit
/// the new identity. Call it only on a dedicated thread that ends after its work.
///
/// # Errors
///
/// Returns the OS error of the first credential syscall that fails; the thread
/// may then hold a partially switched identity and must not do further work.
#[cfg(target_os = "linux")]
pub fn drop_current_thread_credentials(uid: u32, gid: u32, groups: &[u32]) -> std::io::Result<()> {
    ffi::drop_current_thread_credentials(uid, gid, groups)
}

/// Non-Linux stub so whole-workspace cross-platform checks retain one API.
#[cfg(not(target_os = "linux"))]
pub fn configure_oom_score_adj_before_exec(_command: &mut tokio::process::Command, _score: u16) {}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use std::io::Read as _;

    use super::*;

    fn successful_command() -> tokio::process::Command {
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", "exit 0"]);
        command
    }

    #[test]
    fn oom_hook_writes_the_requested_precomputed_score() {
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", "cat /proc/self/oom_score_adj"]);
        configure_oom_score_adj_before_exec(&mut command, 1000);
        let output = command
            .as_std_mut()
            .output()
            .expect("run OOM-score fixture");
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "1000");
    }

    #[test]
    fn pre_exec_hook_writes_the_exact_child_pid() {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "opengeni-pre-exec-cgroup-pid-{}",
            std::process::id()
        ));
        let destination = std::fs::OpenOptions::new()
            // Refuse an existing path so a test running in a shared temporary
            // directory cannot follow or overwrite a planted symlink.
            .create_new(true)
            .write(true)
            .open(&path)
            .expect("create PID destination");
        let mut command = successful_command();
        configure_process_cgroup_before_exec(&mut command, destination);
        let mut child = command
            .as_std_mut()
            .spawn()
            .expect("spawn migrated fixture");
        let expected = child.id().to_string();
        let status = child.wait().expect("wait for fixture child");
        assert!(status.success());

        let mut actual = String::new();
        std::fs::File::open(&path)
            .expect("open PID destination")
            .read_to_string(&mut actual)
            .expect("read child PID");
        let _ = std::fs::remove_file(path);
        assert_eq!(actual, expected);
    }

    fn is_root() -> bool {
        std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|status| {
                status
                    .lines()
                    .find(|line| line.starts_with("Uid:"))
                    .map(|line| line.split_whitespace().nth(2) == Some("0"))
            })
            .unwrap_or(false)
    }

    #[test]
    fn credential_hook_runs_the_child_as_the_requested_identity() {
        if !is_root() {
            eprintln!("skipped: needs root");
            return;
        }
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", "echo $(id -u) $(id -g) $(id -G)"]);
        configure_credentials_before_exec(&mut command, 65534, 65534, vec![65534, 12345]);
        let output = command
            .as_std_mut()
            .output()
            .expect("run credential fixture");
        assert!(output.status.success());
        let text = String::from_utf8_lossy(&output.stdout);
        let fields: Vec<&str> = text.split_whitespace().collect();
        assert_eq!(&fields[..2], &["65534", "65534"]);
        let mut groups = fields[2..].to_vec();
        groups.sort_unstable();
        assert_eq!(groups, vec!["12345", "65534"]);
    }

    #[test]
    fn thread_credential_drop_leaves_other_threads_unchanged() {
        if !is_root() {
            eprintln!("skipped: needs root");
            return;
        }
        let dropped = std::thread::spawn(|| {
            drop_current_thread_credentials(65534, 65534, &[65534]).expect("drop thread creds");
            std::fs::read_to_string("/proc/thread-self/status").expect("read thread status")
        })
        .join()
        .expect("join");
        assert!(dropped.lines().any(
            |line| line.starts_with("Uid:") && line.split_whitespace().nth(2) == Some("65534")
        ));
        assert!(is_root(), "the process' other threads stay root");
    }

    #[test]
    fn placement_failure_always_fences_exec() {
        let failed_destination = std::fs::OpenOptions::new()
            .write(true)
            .open("/dev/full")
            .expect("open deterministic write-failure device");
        let mut required = successful_command();
        configure_process_cgroup_before_exec(&mut required, failed_destination);
        assert!(
            required.as_std_mut().spawn().is_err(),
            "required placement must fail spawn"
        );
    }
}
