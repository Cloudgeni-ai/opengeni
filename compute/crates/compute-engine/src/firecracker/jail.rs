//! Confining each VMM with Firecracker's jailer.
//!
//! The jailer runs as root, then: copies the Firecracker binary into the
//! VM's chroot, joins the VM's network namespace, moves itself into a new
//! cgroup v2 group, pivots into the chroot inside a new mount namespace,
//! creates the few device nodes a VMM needs, drops to the VM's own uid and
//! gid and, with `--new-pid-ns`, forks Firecracker as the first process of
//! a new PID namespace, writes its pid to `/firecracker.pid` and exits.
//! Firecracker then installs its default seccomp filters.
//!
//! The chroot is `<base>/firecracker/<id>/root`, built from the chroot base
//! directory, the binary's file name and the VM's id. [`Jail`] checks that a
//! [`VmSpec`]'s directory has exactly that shape, and translates host paths
//! inside it to the paths the confined VMM sees.

use std::ffi::OsString;
use std::io;
use std::path::{Component, Path, PathBuf};

use crate::spec::VmSpec;

/// The file name the Firecracker binary must have: the jailer names every
/// VM's directory after it.
pub const BINARY_NAME: &str = "firecracker";

/// The chroot directory's own name.
const CHROOT: &str = "root";

/// Where the VMM serves its API, as it sees it.
pub const API_SOCKET: &str = "/api.sock";

/// The pid file the jailer writes into the chroot.
pub const PID_FILE: &str = "firecracker.pid";

/// Files and directories the jailer creates in the chroot on every launch.
/// They must be gone before the next launch, because the jailer refuses to
/// overwrite device nodes or its pid file.
pub const LAUNCH_LEFTOVERS: [&str; 4] = [BINARY_NAME, PID_FILE, "dev", "run"];

/// One VM's jail.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Jail {
    /// The chroot directory on the host.
    root: PathBuf,
    /// The jailer's `--chroot-base-dir`.
    base: PathBuf,
}

impl Jail {
    /// The jail for `spec`, whose directory must be
    /// `<base>/firecracker/<spec.name>/root` with an absolute base.
    pub fn new(spec: &VmSpec) -> Result<Self, String> {
        let shape_error = || {
            format!(
                "VM directory {} must be <base>/{BINARY_NAME}/{}/{CHROOT}",
                spec.dir.display(),
                spec.name
            )
        };
        if !valid_id(&spec.name) {
            return Err(format!(
                "VM name {:?} must be 1 to 64 letters, digits or hyphens",
                spec.name
            ));
        }
        // The jailer accepts any ids, root's too.
        if spec.uid == 0 || spec.gid == 0 {
            return Err(format!(
                "VM {} must run as an unprivileged user, not uid {} gid {}",
                spec.name, spec.uid, spec.gid
            ));
        }
        if !spec.dir.is_absolute()
            || spec
                .dir
                .components()
                .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
        {
            return Err(shape_error());
        }
        let mut up = spec.dir.ancestors().skip(1);
        let (Some(id_dir), Some(binary_dir), Some(base)) = (up.next(), up.next(), up.next()) else {
            return Err(shape_error());
        };
        let named = |path: &Path, name: &str| path.file_name().is_some_and(|own| own == name);
        if !named(&spec.dir, CHROOT)
            || !named(id_dir, &spec.name)
            || !named(binary_dir, BINARY_NAME)
        {
            return Err(shape_error());
        }
        Ok(Self {
            root: spec.dir.clone(),
            base: base.to_path_buf(),
        })
    }

    /// The chroot directory on the host.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The path the confined VMM sees for `host`, which must lie inside the
    /// jail.
    pub fn inside(&self, host: &Path) -> Result<PathBuf, String> {
        let relative = host.strip_prefix(&self.root).map_err(|_| {
            format!(
                "{} is outside the VM's jail {}",
                host.display(),
                self.root.display()
            )
        })?;
        if relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(format!("{} escapes the VM's jail", host.display()));
        }
        Ok(Path::new("/").join(relative))
    }
}

/// What the jailer needs besides the VM's spec.
#[derive(Clone, Debug)]
pub struct Launch<'a> {
    /// The Firecracker binary to copy into the jail.
    pub binary: &'a Path,
    /// The VM's cgroup parent, relative to the cgroup v2 mount.
    pub cgroup_parent: &'a Path,
    /// Network namespace to join, if any.
    pub netns: Option<&'a Path>,
}

/// The jailer's command line for `spec`.
pub fn jailer_args(spec: &VmSpec, jail: &Jail, launch: &Launch<'_>) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::with_capacity(32);
    let mut push = |flag: &str, value: OsString| {
        args.push(flag.into());
        args.push(value);
    };
    push("--id", spec.name.clone().into());
    push("--exec-file", launch.binary.into());
    push("--uid", spec.uid.to_string().into());
    push("--gid", spec.gid.to_string().into());
    push("--chroot-base-dir", jail.base.clone().into());
    push("--cgroup-version", "2".into());
    push("--parent-cgroup", launch.cgroup_parent.into());
    // Any property makes the jailer create the VM's own group under the
    // parent. This one also keeps the VM's memory out of swap devices:
    // compressed pages stay in RAM, and nothing of the guest reaches disk.
    push("--cgroup", "memory.zswap.writeback=0".into());
    // And a running VM is never compressed either, not even by the kernel
    // under host memory pressure: zswap opens only while the agent
    // compresses the paused VM (see `Cgroup::reclaim_to_zswap`). Refused by
    // zswap, a page is not swapped out instead, since writeback is off.
    push("--cgroup", "memory.zswap.max=0".into());
    // What the VM is guaranteed: its requested memory is kept from reclaim
    // for others (reclaim the agent asks of this group itself, to compress
    // it, is not held back), and contended processors are shared by
    // request. `memory.low` rather than `memory.min`: admission keeps the
    // requests within the host, so the kernel always finds unprotected
    // memory first, and should it not, slowing a VM beats the out-of-memory
    // killer that `memory.min` would call instead.
    let low = u64::from(spec.memory_request_mib) << 20;
    push("--cgroup", format!("memory.low={low}").into());
    push(
        "--cgroup",
        format!("cpu.weight={}", spec.cpu_weight.clamp(1, 10_000)).into(),
    );
    if let Some(netns) = launch.netns {
        push("--netns", netns.into());
    }
    args.push("--new-pid-ns".into());
    args.push("--".into());
    args.push("--api-sock".into());
    args.push(API_SOCKET.into());
    args
}

/// Whether `id` is a valid jailer and Firecracker instance id.
fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.chars().all(|c| c == '-' || c.is_ascii_alphanumeric())
}

/// Removes the file at `path`; succeeds if there is none.
pub(super) async fn remove_if_present(path: &Path) -> io::Result<()> {
    match tokio::fs::remove_file(path).await {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::VmSpec;

    fn spec(dir: &str, name: &str) -> VmSpec {
        VmSpec {
            name: name.into(),
            dir: dir.into(),
            logs: "/var/lib/compute/vm/firecracker/abc".into(),
            uid: 4_000_001,
            gid: 4_000_001,
            vcpus: 1,
            memory_mib: 256,
            memory_request_mib: 256,
            cpu_weight: 100,
            kernel: format!("{dir}/vmlinux").into(),
            boot_args: String::new(),
            drives: Vec::new(),
            network: None,
            free_page_reporting: true,
        }
    }

    #[test]
    fn a_jail_is_the_chroot_the_jailer_builds() {
        let jail = Jail::new(&spec("/var/lib/compute/vm/firecracker/abc/root", "abc")).unwrap();
        assert_eq!(jail.base, Path::new("/var/lib/compute/vm"));
        assert_eq!(
            jail.inside(Path::new("/var/lib/compute/vm/firecracker/abc/root/vm.mem"))
                .unwrap(),
            Path::new("/vm.mem")
        );
        assert_eq!(
            jail.inside(Path::new("/var/lib/compute/vm/firecracker/abc/root/a/b"))
                .unwrap(),
            Path::new("/a/b")
        );
    }

    #[test]
    fn paths_outside_the_jail_are_refused() {
        let mut root = spec("/srv/vm/firecracker/abc/root", "abc");
        root.uid = 0;
        assert!(Jail::new(&root).is_err(), "a VMM may not run as root");
        root.uid = 7;
        root.gid = 0;
        assert!(
            Jail::new(&root).is_err(),
            "a VMM may not run in root's group"
        );
        let jail = Jail::new(&spec("/srv/vm/firecracker/abc/root", "abc")).unwrap();
        assert!(
            jail.inside(Path::new("/srv/vm/firecracker/abc/sandbox.json"))
                .is_err()
        );
        assert!(
            jail.inside(Path::new("/srv/vm/firecracker/abc/root/../x"))
                .is_err()
        );
        assert!(jail.inside(Path::new("/etc/passwd")).is_err());
    }

    #[test]
    fn misshapen_directories_are_refused() {
        for (dir, name) in [
            ("/srv/vm/firecracker/abc/jail", "abc"),
            ("/srv/vm/firecracker/other/root", "abc"),
            ("/srv/vm/cloud-hypervisor/abc/root", "abc"),
            ("relative/firecracker/abc/root", "abc"),
            ("/srv/vm/firecracker/../root", ".."),
            ("/firecracker/abc", "abc"),
            ("/srv/vm/firecracker/a_b/root", "a_b"),
        ] {
            assert!(Jail::new(&spec(dir, name)).is_err(), "{dir} accepted");
        }
    }

    #[test]
    fn the_jailer_gets_its_own_user_cgroup_and_pid_namespace() {
        let mut spec = spec("/srv/vm/firecracker/abc/root", "abc");
        spec.memory_request_mib = 128;
        spec.cpu_weight = 50;
        let jail = Jail::new(&spec).unwrap();
        let args = jailer_args(
            &spec,
            &jail,
            &Launch {
                binary: Path::new("/opt/bin/firecracker"),
                cgroup_parent: Path::new("compute"),
                netns: Some(Path::new("/run/netns/ogc-abc")),
            },
        );
        let text: Vec<String> = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            text.join(" "),
            "--id abc --exec-file /opt/bin/firecracker --uid 4000001 --gid 4000001 \
             --chroot-base-dir /srv/vm --cgroup-version 2 --parent-cgroup compute \
             --cgroup memory.zswap.writeback=0 --cgroup memory.zswap.max=0 \
             --cgroup memory.low=134217728 --cgroup cpu.weight=50 \
             --netns /run/netns/ogc-abc --new-pid-ns \
             -- --api-sock /api.sock"
        );
    }
}
