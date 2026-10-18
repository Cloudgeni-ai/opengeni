//! Per-request run-as: executing one request as another local user.
//!
//! A request's `run_as` names a local account (a user name, else a decimal
//! uid). It is honored only where it really works: on Linux with the agent
//! running as root, which is what [`supported`] reports and the Hello advertises
//! as `Capabilities.run_as`. Everywhere else a non-empty `run_as` is a typed
//! [`PlatformError::Unsupported`], never silently ignored.
//!
//! Two mechanisms carry the identity, both built on the audited credential
//! primitives of `opengeni-agent-linux-ffi`:
//!
//! * contained exec/git children switch credentials in a pre-exec hook that
//!   runs after cgroup placement (which still needs the agent's privileges);
//! * PTY spawns, file operations and transactional-write staging run on a
//!   disposable thread whose own credentials were switched. The kernel then
//!   enforces the user's permissions, files and directories it creates belong
//!   to the user, and a process forked from that thread inherits the identity.
//!   No other agent thread changes identity, and the thread ends afterwards.

use std::future::Future;
use std::path::PathBuf;

use crate::error::{PlatformError, PlatformResult};

/// A resolved local account a request runs as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunAsIdentity {
    /// Login name from the password database.
    pub name: String,
    /// User id.
    pub uid: u32,
    /// Primary group id.
    pub gid: u32,
    /// Every group the account belongs to, its primary group included.
    pub groups: Vec<u32>,
    /// Home directory: `HOME` and the target of `~` paths.
    pub home: PathBuf,
    /// Login shell: `SHELL` and the default PTY program.
    pub shell: PathBuf,
}

impl RunAsIdentity {
    /// The login environment a child of this identity starts with. Request
    /// environment variables are applied after these and may override them.
    #[must_use]
    pub fn login_env(&self) -> [(&'static str, String); 4] {
        [
            ("HOME", self.home.to_string_lossy().into_owned()),
            ("USER", self.name.clone()),
            ("LOGNAME", self.name.clone()),
            ("SHELL", self.shell.to_string_lossy().into_owned()),
        ]
    }
}

/// Whether this agent honors `run_as`: Linux, running as root.
#[must_use]
pub fn supported() -> bool {
    #[cfg(target_os = "linux")]
    {
        nix::unistd::geteuid().is_root()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Resolves a request's `run_as`. Empty means the agent's own account (`None`).
///
/// # Errors
///
/// [`PlatformError::Unsupported`] where run-as is not [`supported`],
/// [`PlatformError::RunAsUnknownUser`] when no account matches, and an OS error
/// when the password database cannot be read.
pub fn resolve(run_as: &str) -> PlatformResult<Option<RunAsIdentity>> {
    if run_as.is_empty() {
        return Ok(None);
    }
    if !supported() {
        return Err(PlatformError::Unsupported(
            "run_as requires an agent running as root on Linux".to_string(),
        ));
    }
    lookup(run_as).map(Some)
}

/// Looks `run_as` up as a user name first, then as a decimal uid.
#[cfg(target_os = "linux")]
pub(crate) fn lookup(run_as: &str) -> PlatformResult<RunAsIdentity> {
    use nix::unistd::{getgrouplist, Uid, User};

    let database = |error: nix::Error| {
        PlatformError::os(format!("run_as: read the password database: {error}"))
    };
    let unknown = || PlatformError::RunAsUnknownUser(run_as.to_string());
    let user = if let Some(user) = User::from_name(run_as).map_err(database)? {
        user
    } else {
        let uid = run_as.parse::<u32>().map_err(|_| unknown())?;
        User::from_uid(Uid::from_raw(uid))
            .map_err(database)?
            .ok_or_else(unknown)?
    };
    let name = std::ffi::CString::new(user.name.clone()).map_err(|_| unknown())?;
    let mut groups: Vec<u32> = getgrouplist(&name, user.gid)
        .map_err(|error| {
            PlatformError::os(format!("run_as: list the groups of {}: {error}", user.name))
        })?
        .into_iter()
        .map(nix::unistd::Gid::as_raw)
        .collect();
    groups.sort_unstable();
    groups.dedup();
    let shell = if user.shell.as_os_str().is_empty() {
        PathBuf::from("/bin/sh")
    } else {
        user.shell
    };
    Ok(RunAsIdentity {
        name: user.name,
        uid: user.uid.as_raw(),
        gid: user.gid.as_raw(),
        groups,
        home: user.dir,
        shell,
    })
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn lookup(_run_as: &str) -> PlatformResult<RunAsIdentity> {
    Err(PlatformError::Unsupported(
        "run_as requires an agent running as root on Linux".to_string(),
    ))
}

/// Registers the identity's credential switch on a contained child. Call it
/// after every pre-exec hook that needs the agent's privileges.
#[cfg(target_os = "linux")]
pub(crate) fn configure_child(identity: &RunAsIdentity, command: &mut tokio::process::Command) {
    opengeni_agent_linux_ffi::configure_credentials_before_exec(
        command,
        identity.uid,
        identity.gid,
        identity.groups.clone(),
    );
}

/// Runs `work` on a disposable thread switched to `identity`, waiting for it.
///
/// # Errors
///
/// The credential switch's OS error, a thread that could not start or ended
/// without a result, or `work`'s own error.
pub(crate) fn on_identity_thread<T, F>(identity: &RunAsIdentity, work: F) -> PlatformResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> PlatformResult<T> + Send + 'static,
{
    spawn_identity_thread(identity, work, |result| result)?
        .join()
        .map_err(|_| PlatformError::os("run_as worker thread panicked"))?
}

/// Runs the future `make` builds on a disposable thread switched to
/// `identity` (its own single-threaded runtime; blocking helpers it starts
/// inherit the identity), or in place when `identity` is `None`. The caller's
/// update-drain reservation follows the work onto that thread.
///
/// # Errors
///
/// The credential switch's OS error, a thread or runtime that could not start
/// or ended without a result, or the future's own error.
pub(crate) async fn run<T, F, Fut>(identity: Option<RunAsIdentity>, make: F) -> PlatformResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = PlatformResult<T>> + Send,
{
    let Some(identity) = identity else {
        return make().await;
    };
    let reservation = crate::current_work_reservation();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    spawn_identity_thread(
        &identity,
        move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| PlatformError::from_io("run_as worker runtime", &error))?;
            runtime.block_on(crate::with_work_reservation(reservation, make()))
        },
        move |result| {
            let _ = sender.send(result);
        },
    )?;
    receiver
        .await
        .map_err(|_| PlatformError::os("run_as worker ended without a result"))?
}

/// Starts the thread: switch credentials, run `work`, hand its result to
/// `deliver`. A failed switch never runs `work`.
fn spawn_identity_thread<T, R, F, D>(
    identity: &RunAsIdentity,
    work: F,
    deliver: D,
) -> PlatformResult<std::thread::JoinHandle<R>>
where
    R: Send + 'static,
    F: FnOnce() -> PlatformResult<T> + Send + 'static,
    D: FnOnce(PlatformResult<T>) -> R + Send + 'static,
{
    let reservation = crate::current_work_reservation();
    let (uid, gid, groups) = (identity.uid, identity.gid, identity.groups.clone());
    std::thread::Builder::new()
        .name("opengeni-run-as".into())
        .spawn(move || {
            crate::with_work_reservation_sync(reservation, move || {
                deliver(switch_current_thread(uid, gid, &groups).and_then(|()| work()))
            })
        })
        .map_err(|error| PlatformError::from_io("start run_as worker thread", &error))
}

#[cfg(target_os = "linux")]
fn switch_current_thread(uid: u32, gid: u32, groups: &[u32]) -> PlatformResult<()> {
    opengeni_agent_linux_ffi::drop_current_thread_credentials(uid, gid, groups)
        .map_err(|error| PlatformError::from_io("switch to the run_as user", &error))
}

#[cfg(not(target_os = "linux"))]
fn switch_current_thread(_uid: u32, _gid: u32, _groups: &[u32]) -> PlatformResult<()> {
    Err(PlatformError::Unsupported(
        "run_as requires an agent running as root on Linux".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_run_as_is_the_agent_account() {
        assert_eq!(resolve("").unwrap(), None);
    }

    #[test]
    fn unsupported_agents_refuse_a_non_empty_run_as() {
        if supported() {
            return;
        }
        assert!(matches!(
            resolve("nobody"),
            Err(PlatformError::Unsupported(_))
        ));
    }

    #[test]
    fn login_env_comes_from_the_account() {
        let identity = RunAsIdentity {
            name: "dev".into(),
            uid: 1000,
            gid: 1000,
            groups: vec![1000],
            home: "/home/dev".into(),
            shell: "/bin/bash".into(),
        };
        assert_eq!(
            identity.login_env(),
            [
                ("HOME", "/home/dev".to_string()),
                ("USER", "dev".to_string()),
                ("LOGNAME", "dev".to_string()),
                ("SHELL", "/bin/bash".to_string()),
            ]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn lookup_resolves_names_and_decimal_uids() {
        let by_name = lookup("root").expect("root exists");
        assert_eq!((by_name.uid, by_name.gid), (0, 0));
        assert!(by_name.groups.contains(&0));
        assert_eq!(lookup("0").expect("uid 0 exists"), by_name);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn lookup_reports_unknown_users_with_their_typed_code() {
        for missing in ["opengeni-no-such-user", "4000000000"] {
            let error = lookup(missing).expect_err("no such account");
            assert!(matches!(error, PlatformError::RunAsUnknownUser(_)));
            assert_eq!(
                error.code(),
                opengeni_agent_proto::v1::ErrorCode::RunAsUnknownUser
            );
            assert!(!error.retryable());
        }
    }
}
