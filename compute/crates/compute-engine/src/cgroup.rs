//! Linux cgroup v2 groups: one per VM, so the host can account, limit and
//! reclaim each VM's memory on its own.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

/// Serializes updates of a parent group's `memory.low`, so that the last
/// one written counts every child's.
static PARENT_LOW: Mutex<()> = Mutex::new(());

/// One cgroup v2 directory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cgroup {
    path: PathBuf,
}

impl Cgroup {
    /// Opens or creates the group at `path`.
    pub fn create(path: impl Into<PathBuf>) -> io::Result<Self> {
        let path = path.into();
        match fs::create_dir(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        Ok(Self { path })
    }

    /// Opens or creates a parent group whose children get memory and CPU
    /// controllers.
    pub fn create_parent(path: impl Into<PathBuf>) -> io::Result<Self> {
        let group = Self::create(path)?;
        fs::write(group.path.join("cgroup.subtree_control"), "+memory +cpu")?;
        Ok(group)
    }

    /// The group at `path`, which may or may not exist.
    #[must_use]
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// The group's directory.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The child group `name`.
    pub fn child(&self, name: &str) -> io::Result<Self> {
        Self::create(self.path.join(name))
    }

    /// Bytes of memory charged to the group, compressed swap included.
    pub fn memory_current(&self) -> io::Result<u64> {
        read_u64(&self.path.join("memory.current"))
    }

    /// Bytes of huge pages the group's processes map. The kernel charges
    /// huge pages to a group's `memory.current` only on a cgroup v2 mount
    /// with `memory_hugetlb_accounting`; counting them by process works on
    /// any mount.
    pub fn huge_page_bytes(&self) -> io::Result<u64> {
        let mut mapped = 0_u64;
        for pid in self.processes()? {
            match fs::read_to_string(format!("/proc/{}/status", pid.as_raw_pid())) {
                Ok(status) => mapped = mapped.saturating_add(parse_hugetlb_bytes(&status)),
                Err(error)
                    if error.kind() == io::ErrorKind::NotFound
                        || error.raw_os_error() == Some(rustix::io::Errno::SRCH.raw_os_error()) => {
                }
                Err(error) => return Err(error),
            }
        }
        Ok(mapped)
    }

    /// Processor time the group's processes have used since it was created
    /// (`usage_usec` in cpu.stat).
    pub fn cpu_time(&self) -> io::Result<Duration> {
        let stat = fs::read_to_string(self.path.join("cpu.stat"))?;
        parse_cpu_usage(&stat)
    }

    /// Bytes the group's processes have passed through read and write
    /// system calls (`rchar` plus `wchar` in `/proc/<pid>/io`, every thread
    /// counted). For a Firecracker VMM that covers its network device (the
    /// tap's `readv`/`writev`), its synchronous block device, and vsock
    /// data it copies straight between guest memory and a socket. Vsock
    /// data it buffers under backpressure leaves through `send(2)`, which
    /// these counters miss. A process that ends between listing and reading
    /// is left out, so only differences between readings of the same
    /// processes mean anything.
    pub fn io_bytes(&self) -> io::Result<u64> {
        let procs = fs::read_to_string(self.path.join("cgroup.procs"))?;
        let mut total = 0_u64;
        for pid in procs.split_whitespace() {
            match fs::read_to_string(format!("/proc/{pid}/io")) {
                Ok(counters) => total = total.saturating_add(parse_io_bytes(&counters)?),
                Err(error)
                    if error.kind() == io::ErrorKind::NotFound
                        || error.raw_os_error() == Some(rustix::io::Errno::SRCH.raw_os_error()) => {
                }
                Err(error) => return Err(error),
            }
        }
        Ok(total)
    }

    /// Stops the kernel from compressing or swapping out any more of the
    /// group's memory, as it otherwise may under host memory pressure: no
    /// swap at all (`memory.swap.max`, which zswap needs too) and no zswap.
    /// The group's anonymous memory then stays in RAM. Pages already
    /// compressed stay so until touched. A kernel without swap has no
    /// `memory.swap.max`, and nothing to close.
    pub fn close_zswap(&self) -> io::Result<()> {
        match fs::write(self.path.join("memory.swap.max"), "0") {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        fs::write(self.path.join("memory.zswap.max"), "0")
    }

    /// Sets the memory the group is protected from reclaim for others
    /// (`memory.low`): the kernel takes it only when nothing unprotected is
    /// left to take. Updates the parent's too; see
    /// [`Cgroup::protect_parent`].
    pub fn set_memory_low(&self, bytes: u64) -> io::Result<()> {
        fs::write(self.path.join("memory.low"), bytes.to_string())?;
        self.protect_parent()
    }

    /// Sets the parent group's `memory.low` to the sum of its children's.
    /// A group is protected only as far as its ancestors are, so a parent
    /// left at 0 would protect none of its VMs from the rest of the host.
    /// The sum, not more: on a mount with `memory_recursiveprot` the kernel
    /// hands protection a parent has beyond its children's claims to the
    /// children claiming none, such as paused VMs.
    pub fn protect_parent(&self) -> io::Result<()> {
        let Some(parent) = self.path.parent() else {
            return Ok(());
        };
        let _serial = PARENT_LOW.lock().unwrap_or_else(PoisonError::into_inner);
        let mut total = 0_u64;
        for entry in fs::read_dir(parent)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            match fs::read_to_string(entry.path().join("memory.low")) {
                Ok(low) => total = total.saturating_add(low.trim().parse().unwrap_or(0)),
                // A child group removed meanwhile claims nothing: its
                // directory is gone, or its files answer that it no
                // longer exists while the kernel takes it down.
                Err(error)
                    if error.kind() == io::ErrorKind::NotFound
                        || error.raw_os_error()
                            == Some(rustix::io::Errno::NODEV.raw_os_error()) => {}
                Err(error) => return Err(error),
            }
        }
        fs::write(parent.join("memory.low"), total.to_string())
    }

    /// The group's zswap traffic and memory pressure so far.
    pub fn memory_stats(&self) -> io::Result<MemoryStats> {
        let stat = fs::read_to_string(self.path.join("memory.stat"))?;
        // Without pressure stall information the file is missing or
        // unreadable; the rest still counts.
        let pressure = fs::read_to_string(self.path.join("memory.pressure")).ok();
        Ok(parse_memory_stats(&stat, pressure.as_deref()))
    }

    /// Pushes the group's memory out of RAM: anonymous pages into compressed
    /// memory (zswap, never written to disk), file pages dropped.
    ///
    /// Works in chunks of `chunk` bytes and checks `stop` before each one, so
    /// a caller can interrupt it within one chunk's worth of work. Returns
    /// `true` if it ran until the kernel could reclaim no more, `false` if
    /// `stop` interrupted it. Blocks; call it from a blocking thread.
    pub fn reclaim_to_zswap(&self, chunk: u64, stop: impl Fn() -> bool) -> io::Result<bool> {
        // Callers check that zswap is on (`zswap_enabled`): without it,
        // writeback 0 means nothing and swap would go to disk.
        fs::write(self.path.join("memory.swap.max"), "max")?;
        fs::write(self.path.join("memory.zswap.max"), "max")?;
        fs::write(self.path.join("memory.zswap.writeback"), "0")?;
        let request = chunk.max(1).to_string();
        let reclaim = self.path.join("memory.reclaim");
        loop {
            if stop() {
                return Ok(false);
            }
            match fs::write(&reclaim, &request) {
                Ok(()) => {}
                // EAGAIN means the kernel reclaimed less than asked: what is
                // left is in use or already compressed, so we are done.
                Err(error)
                    if error.raw_os_error() == Some(rustix::io::Errno::AGAIN.raw_os_error()) =>
                {
                    return Ok(true);
                }
                Err(error) => return Err(error),
            }
        }
    }

    /// Kills every process in the group at once (cgroup.kill). Used to
    /// clean up a VMM the host no longer controls.
    pub fn kill_all(&self) -> io::Result<()> {
        match fs::write(self.path.join("cgroup.kill"), "1") {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }

    /// Moves process `pid` into the group.
    pub fn add(&self, pid: u32) -> io::Result<()> {
        fs::write(self.path.join("cgroup.procs"), pid.to_string())
    }

    /// The processes in the group, as the host's PID namespace numbers
    /// them; none if the group is gone.
    pub fn processes(&self) -> io::Result<Vec<rustix::process::Pid>> {
        let procs = match fs::read_to_string(self.path.join("cgroup.procs")) {
            Ok(procs) => procs,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        procs
            .lines()
            .map(|line| {
                line.trim()
                    .parse()
                    .ok()
                    .and_then(rustix::process::Pid::from_raw)
                    .ok_or_else(|| {
                        io::Error::new(io::ErrorKind::InvalidData, format!("bad pid {line:?}"))
                    })
            })
            .collect()
    }

    /// Kills every process in the group and waits a few seconds at most
    /// for them all to be gone. Blocks.
    pub fn end_all(&self) -> io::Result<()> {
        self.kill_all()?;
        let mut delay = Duration::from_millis(1);
        for _ in 0..12 {
            if !self.is_populated()? {
                break;
            }
            std::thread::sleep(delay);
            delay *= 2;
        }
        Ok(())
    }

    /// Whether any process is still in the group.
    pub fn is_populated(&self) -> io::Result<bool> {
        match fs::read_to_string(self.path.join("cgroup.events")) {
            Ok(events) => Ok(events.lines().any(|line| line == "populated 1")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// Removes the group once its processes have exited, and its claim on
    /// the parent's protection with it. Retries briefly, because the kernel
    /// frees an exited process's group membership asynchronously.
    pub fn remove(&self) -> io::Result<()> {
        let mut delay = Duration::from_millis(1);
        for _ in 0..10 {
            match fs::remove_dir(&self.path) {
                Ok(()) => return self.protect_parent(),
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(error)
                    if error.raw_os_error() == Some(rustix::io::Errno::BUSY.raw_os_error()) =>
                {
                    std::thread::sleep(delay);
                    delay *= 2;
                }
                Err(error) => return Err(error),
            }
        }
        fs::remove_dir(&self.path)?;
        self.protect_parent()
    }
}

/// A group's zswap traffic and memory pressure; see
/// [`Cgroup::memory_stats`].
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MemoryStats {
    /// Pages compressed into zswap since the group was created.
    pub zswpout: u64,
    /// Pages brought back from zswap since the group was created.
    pub zswpin: u64,
    /// Share of the last ten seconds in which some of the group's processes
    /// waited for memory, in percent (`some avg10` in `memory.pressure`).
    pub pressure_some_avg10: Option<f64>,
}

fn parse_memory_stats(stat: &str, pressure: Option<&str>) -> MemoryStats {
    let pressure_some_avg10 = pressure.and_then(|pressure| {
        pressure
            .lines()
            .find_map(|line| line.strip_prefix("some "))?
            .split_whitespace()
            .find_map(|pair| pair.strip_prefix("avg10="))?
            .parse()
            .ok()
    });
    MemoryStats {
        zswpout: stat_field(stat, "zswpout"),
        zswpin: stat_field(stat, "zswpin"),
        pressure_some_avg10,
    }
}

/// Field `name` of a `memory.stat`, or 0 if it has none.
fn stat_field(stat: &str, name: &str) -> u64 {
    stat.lines()
        .find_map(|line| line.strip_prefix(name)?.strip_prefix(' '))
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(0)
}

/// Bytes of huge pages a process maps, from its `/proc/<pid>/status`.
fn parse_hugetlb_bytes(status: &str) -> u64 {
    status
        .lines()
        .find_map(|line| line.strip_prefix("HugetlbPages:"))
        .and_then(|value| value.trim().strip_suffix("kB"))
        .and_then(|kib| kib.trim().parse::<u64>().ok())
        .map_or(0, |kib| kib << 10)
}

/// Whether the kernel compresses swapped-out pages into zswap. Without it,
/// swapping a group's memory out writes it to disk.
pub fn zswap_enabled() -> io::Result<bool> {
    match fs::read_to_string("/sys/module/zswap/parameters/enabled") {
        Ok(text) => Ok(matches!(text.trim(), "Y" | "1")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn read_u64(path: &Path) -> io::Result<u64> {
    fs::read_to_string(path)?
        .trim()
        .parse()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn parse_cpu_usage(stat: &str) -> io::Result<Duration> {
    stat.lines()
        .find_map(|line| line.strip_prefix("usage_usec "))
        .and_then(|value| value.trim().parse().ok())
        .map(Duration::from_micros)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "cpu.stat has no usage_usec"))
}

fn parse_io_bytes(counters: &str) -> io::Result<u64> {
    let field = |name: &str| {
        counters
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .and_then(|value| value.trim().parse::<u64>().ok())
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, format!("io has no {name}")))
    };
    Ok(field("rchar:")?.saturating_add(field("wchar:")?))
}

/// Refuses VM groups at `relative` (below the cgroup v2 root) that lie
/// inside the calling process's own group: a memory limit on the caller,
/// such as its service unit's `MemoryMax`, would then count the VMs, and
/// stopping the unit would end them. A caller in the root group belongs to
/// no unit.
pub fn check_outside_own(relative: &Path) -> io::Result<()> {
    let own = parse_own(&fs::read_to_string("/proc/self/cgroup")?).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "no cgroup v2 entry in /proc/self/cgroup",
        )
    })?;
    if encloses(&own, relative) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "VM cgroup /{} is inside this process's own cgroup /{}: its limits \
                 would count the VMs and stopping it would end them",
                relative.display(),
                own.display()
            ),
        ));
    }
    Ok(())
}

/// The caller's group below the root, from `/proc/self/cgroup`.
fn parse_own(text: &str) -> Option<PathBuf> {
    text.lines()
        .find_map(|line| line.strip_prefix("0::"))
        .map(|path| PathBuf::from(path.trim().trim_start_matches('/')))
}

/// Whether group `inner` is `outer` or below it; the root encloses nothing
/// here.
fn encloses(outer: &Path, inner: &Path) -> bool {
    !outer.as_os_str().is_empty() && inner.starts_with(outer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vm_groups_must_lie_outside_the_callers_own() {
        let own = parse_own("0::/system.slice/compute-host.service\n").unwrap();
        assert_eq!(own, Path::new("system.slice/compute-host.service"));
        assert!(!encloses(&own, Path::new("compute")));
        assert!(!encloses(
            &own,
            Path::new("system.slice/compute-host.service2")
        ));
        assert!(encloses(
            &own,
            Path::new("system.slice/compute-host.service/vms")
        ));
        assert!(encloses(
            &own,
            Path::new("system.slice/compute-host.service")
        ));
        // A process in the root group, as in a container without a unit.
        let root = parse_own("0::/\n").unwrap();
        assert!(!encloses(&root, Path::new("compute")));
        assert_eq!(parse_own("1:name=systemd:/x\n"), None);
    }

    #[test]
    fn reads_processor_time_from_cpu_stat() {
        let stat = "usage_usec 1234567\nuser_usec 1000000\nsystem_usec 234567\n";
        assert_eq!(
            parse_cpu_usage(stat).unwrap(),
            Duration::from_micros(1_234_567)
        );
        assert!(parse_cpu_usage("user_usec 5\n").is_err());
    }

    #[test]
    fn reads_zswap_traffic_and_pressure() {
        let stat = "anon 4096\nzswap 0\nzswapped 0\nzswpin 3\nzswpout 17\nzswpwb 0\n";
        let pressure = "some avg10=1.25 avg60=0.40 avg300=0.08 total=12345\n\
                        full avg10=0.50 avg60=0.10 avg300=0.02 total=4567\n";
        assert_eq!(
            parse_memory_stats(stat, Some(pressure)),
            MemoryStats {
                zswpout: 17,
                zswpin: 3,
                pressure_some_avg10: Some(1.25),
            }
        );
        // Without zswap or pressure stall information.
        assert_eq!(
            parse_memory_stats("anon 4096\n", None),
            MemoryStats::default()
        );
    }

    #[test]
    fn reads_traffic_from_proc_io() {
        let counters = "rchar: 1000\nwchar: 234\nsyscr: 7\nsyscw: 3\nread_bytes: 4096\n\
                        write_bytes: 0\ncancelled_write_bytes: 0\n";
        assert_eq!(parse_io_bytes(counters).unwrap(), 1234);
        assert!(parse_io_bytes("rchar: 5\n").is_err());
    }
}
