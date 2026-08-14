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

/// Configures `command` to raise its own Linux OOM victim bias after `fork` but
/// before user code can run or create descendants.
///
/// The hook is deliberately best-effort. A restrictive kernel policy must not
/// turn an otherwise valid command into a spawn failure; the parent performs a
/// second observable write after spawn and reports failure there.
#[cfg(target_os = "linux")]
pub fn configure_oom_score_adj_before_exec(command: &mut tokio::process::Command) {
    ffi::configure_oom_score_adj_before_exec(command);
}

/// Configures `command` to move its forked process into an already-created
/// cgroup before `execve(2)`. Every descendant is therefore born in the same
/// cgroup even if user code immediately creates another session or process
/// group.
///
/// `cgroup_procs` must be an open writable handle for the destination
/// `cgroup.procs`. When `required` is true, a failed migration fails spawn before
/// user code runs; otherwise the caller may perform observable post-spawn
/// fallback placement.
#[cfg(target_os = "linux")]
pub fn configure_process_cgroup_before_exec(
    command: &mut tokio::process::Command,
    cgroup_procs: File,
    required: bool,
) {
    ffi::configure_process_cgroup_before_exec(command, cgroup_procs, required);
}

/// Non-Linux stub so whole-workspace cross-platform checks retain one API.
#[cfg(not(target_os = "linux"))]
pub fn configure_oom_score_adj_before_exec(_command: &mut tokio::process::Command) {}

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
        configure_process_cgroup_before_exec(&mut command, destination, true);
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
    fn required_failure_fences_exec_while_best_effort_preserves_spawn() {
        let failed_destination = || {
            std::fs::OpenOptions::new()
                .write(true)
                .open("/dev/full")
                .expect("open deterministic write-failure device")
        };

        let mut required = successful_command();
        configure_process_cgroup_before_exec(&mut required, failed_destination(), true);
        assert!(
            required.as_std_mut().spawn().is_err(),
            "required placement must fail spawn"
        );

        let mut best_effort = successful_command();
        configure_process_cgroup_before_exec(&mut best_effort, failed_destination(), false);
        let status = best_effort
            .as_std_mut()
            .status()
            .expect("best-effort placement preserves spawn");
        assert!(status.success());
    }
}
