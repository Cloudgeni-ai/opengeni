//! Setting up the guest's system: mounts, network, identity and clock.

use std::fs::{self, File, OpenOptions, Permissions};
use std::io::{self, Write};
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::Path;

use super::{log, sys};
use crate::agent::STATE_DIR;
use crate::cmdline::Network;
use crate::identity::{self, MACHINE_ID_FILE, OWNER_FILE, SANDBOX_FILE};

/// The file systems every guest gets, in order. One already mounted (the
/// kernel mounts `/dev` itself) is left as it is.
const MOUNTS: &[(&str, &str, &str, libc::c_ulong, &str)] = &[
    (
        "proc",
        "/proc",
        "proc",
        libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
        "",
    ),
    (
        "sysfs",
        "/sys",
        "sysfs",
        libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
        "",
    ),
    ("devtmpfs", "/dev", "devtmpfs", libc::MS_NOSUID, "mode=0755"),
    (
        "devpts",
        "/dev/pts",
        "devpts",
        libc::MS_NOSUID | libc::MS_NOEXEC,
        "newinstance,ptmxmode=0666,mode=0620,gid=5",
    ),
    (
        "tmpfs",
        "/dev/shm",
        "tmpfs",
        libc::MS_NOSUID | libc::MS_NODEV,
        "mode=1777",
    ),
    (
        "tmpfs",
        "/run",
        "tmpfs",
        libc::MS_NOSUID | libc::MS_NODEV,
        "mode=0755",
    ),
    (
        "cgroup2",
        "/sys/fs/cgroup",
        "cgroup2",
        libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
        "",
    ),
];

/// Links in `/dev` that programs expect and `devtmpfs` does not make.
const DEV_LINKS: &[(&str, &str)] = &[
    ("/proc/self/fd", "/dev/fd"),
    ("/proc/self/fd/0", "/dev/stdin"),
    ("/proc/self/fd/1", "/dev/stdout"),
    ("/proc/self/fd/2", "/dev/stderr"),
];

/// Mounts the basics and makes what programs expect around them.
pub fn mount_basics() {
    for &(source, target, kind, flags, data) in MOUNTS {
        let _ = fs::create_dir_all(target);
        match sys::mount(source, target, kind, flags, data) {
            Err(error) if error.raw_os_error() != Some(libc::EBUSY) => {
                log(&format!("mount {target}: {error}"));
            }
            _ => {}
        }
    }
    for (target, link) in DEV_LINKS {
        if fs::symlink_metadata(link).is_err() {
            let _ = symlink(target, link);
        }
    }
    // Every terminal comes from this instance of devpts.
    let _ = fs::remove_file("/dev/ptmx");
    let _ = symlink("pts/ptmx", "/dev/ptmx");
    for dir in ["/tmp", "/var/tmp"] {
        let _ = fs::create_dir_all(dir);
        let _ = fs::set_permissions(dir, Permissions::from_mode(0o1777));
    }
    // envd puts the processes it starts in cgroups of their own.
    for controller in ["+cpu", "+memory", "+io", "+pids"] {
        let _ = fs::write("/sys/fs/cgroup/cgroup.subtree_control", controller);
    }
}

/// Sets up the network from the kernel's `ip=` argument. The lab kernel
/// does most of it itself; what is already in place is left alone.
pub fn network(network: Option<&Network>) {
    if let Err(error) = sys::interface_up("lo") {
        log(&format!("loopback: {error}"));
    }
    let Some(network) = network else {
        return;
    };
    let configured = sys::interface_address(&network.device)
        .ok()
        .flatten()
        .is_some_and(|address| address == network.address);
    let result = (|| {
        if !configured {
            sys::set_interface_address(&network.device, network.address, network.netmask)?;
        }
        sys::interface_up(&network.device)?;
        if let Some(gateway) = network.gateway {
            sys::add_default_route(gateway)?;
        }
        io::Result::Ok(())
    })();
    if let Err(error) = result {
        log(&format!("network on {}: {error}", network.device));
    }
    if !network.dns.is_empty() {
        write_resolv_conf(&network.resolv_conf());
    }
    if fs::symlink_metadata("/etc/hosts").is_err() {
        let _ = fs::write("/etc/hosts", "127.0.0.1\tlocalhost\n::1\tlocalhost\n");
    }
}

/// Writes `/etc/resolv.conf`, unless it is the kernel's own list, which
/// already says the same.
fn write_resolv_conf(text: &str) {
    const PATH: &str = "/etc/resolv.conf";
    if fs::read_link(PATH).is_ok_and(|target| target == Path::new("/proc/net/pnp")) {
        return;
    }
    let _ = fs::remove_file(PATH);
    if let Err(error) = replace(PATH, text, 0o644) {
        log(&format!("resolv.conf: {error}"));
    }
}

/// Replaces `path` with `text` all at once, through a file beside it,
/// for good once this returns.
pub fn replace(path: &str, text: &str, mode: u32) -> io::Result<()> {
    crate::given::write_durably(Path::new(path), text.as_bytes(), mode)
}

/// The guest booted for `sandbox`: it records the id, takes its host name
/// and, if the disk's machine identity was made for another sandbox (a
/// template's, or none), makes a fresh one. The agent's own state goes
/// with that identity: it is the other sandbox's (its instance lock,
/// command spool and browser controller state, ADR 22), and this boot
/// starts the agent only after it is gone. The owner goes last, so a
/// failure part way is done again by the next boot.
pub fn boot_identity(sandbox: &str) {
    let owner = fs::read_to_string(OWNER_FILE).ok();
    let result = (|| {
        if !identity::owned_by(owner.as_deref(), sandbox) {
            remove_tree(Path::new(STATE_DIR))?;
            let mut bytes = [0_u8; 16];
            io::Read::read_exact(&mut File::open("/dev/urandom")?, &mut bytes)?;
            replace(
                MACHINE_ID_FILE,
                &format!("{}\n", identity::random_machine_id(&bytes)),
                0o444,
            )?;
            replace(OWNER_FILE, &format!("{sandbox}\n"), 0o644)?;
        }
        replace(SANDBOX_FILE, &format!("{sandbox}\n"), 0o644)
    })();
    if let Err(error) = result {
        log(&format!("identity: {error}"));
    }
    if let Err(error) = sys::set_host_name(identity::host_name(sandbox)) {
        log(&format!("host name: {error}"));
    }
    name_self(identity::host_name(sandbox));
}

/// Removes the directory `path` and everything under it, if it is there.
fn remove_tree(path: &Path) -> io::Result<()> {
    match fs::remove_dir_all(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// Makes the guest's own host name `name` resolve locally (see
/// [`identity::hosts_naming`]). The file need not survive a crash: every
/// boot and new identity writes it again. A symlinked hosts file belongs
/// to whatever manages it and is left alone.
fn name_self(name: &str) {
    let path = Path::new(identity::HOSTS_FILE);
    if fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return;
    }
    let hosts = fs::read_to_string(path).ok();
    let named = identity::hosts_naming(hosts.as_deref(), name);
    if hosts.as_deref() == Some(named.as_str()) {
        return;
    }
    let next = path.with_extension("opengeni-next");
    let result = fs::write(&next, &named).and_then(|()| {
        fs::set_permissions(&next, Permissions::from_mode(0o644))?;
        fs::rename(&next, path)
    });
    if let Err(error) = result {
        let _ = fs::remove_file(&next);
        log(&format!("hosts file: {error}"));
    }
}

/// The sandbox the guest currently is.
pub fn current_sandbox() -> Option<String> {
    fs::read_to_string(SANDBOX_FILE)
        .ok()
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty())
}

/// A notice told the guest it is `sandbox`. Takes a machine id derived
/// from the notice's seed when it is another sandbox, or the disk's
/// identity is not its own. The owner goes last, so a failure part way is
/// renewed again by a retry.
pub fn renew_identity(sandbox: &str, seed_hex: &str) -> io::Result<()> {
    let owner = fs::read_to_string(OWNER_FILE).ok();
    if current_sandbox().as_deref() == Some(sandbox)
        && identity::owned_by(owner.as_deref(), sandbox)
    {
        return Ok(());
    }
    let machine_id = identity::derived_machine_id(seed_hex, sandbox);
    replace(MACHINE_ID_FILE, &format!("{machine_id}\n"), 0o444)?;
    sys::set_host_name(identity::host_name(sandbox))?;
    name_self(identity::host_name(sandbox));
    replace(OWNER_FILE, &format!("{sandbox}\n"), 0o644)?;
    replace(SANDBOX_FILE, &format!("{sandbox}\n"), 0o644)
}

/// Mixes `seed` into the kernel's input pool and reseeds its generator
/// from it at once. Returns whether it did.
pub fn reseed(seed: &[u8]) -> bool {
    let result = (|| {
        let mut pool = OpenOptions::new().write(true).open("/dev/urandom")?;
        pool.write_all(seed)?;
        sys::reseed_random(&pool)
    })();
    match result {
        Ok(()) => true,
        Err(error) => {
            log(&format!("reseed: {error}"));
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_earlier_sandboxs_agent_state_is_removed_whole_and_none_is_no_error() {
        let dir = std::env::temp_dir().join(format!("guest-state-{}", std::process::id()));
        fs::create_dir_all(dir.join("spool/commands")).unwrap();
        fs::write(dir.join("instance.lock"), "another sandbox").unwrap();
        fs::write(dir.join("spool/commands/1.json"), "{}").unwrap();
        remove_tree(&dir).unwrap();
        assert!(!dir.exists());
        remove_tree(&dir).unwrap();
    }
}
