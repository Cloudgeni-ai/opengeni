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
