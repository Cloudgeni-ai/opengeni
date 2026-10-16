//! Linux cgroup v2 groups: one per VM, so the host can account, limit and
//! reclaim each VM's memory on its own.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

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

    /// Pushes the group's memory out of RAM: anonymous pages into compressed
    /// memory (zswap, never written to disk), file pages dropped.
    ///
    /// Works in chunks of `chunk` bytes and checks `stop` before each one, so
    /// a caller can interrupt it within one chunk's worth of work. Returns
    /// `true` if it ran until the kernel could reclaim no more, `false` if
    /// `stop` interrupted it. Blocks; call it from a blocking thread.
    pub fn reclaim_to_zswap(&self, chunk: u64, stop: impl Fn() -> bool) -> io::Result<bool> {
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

    /// Removes the group once its processes have exited. Retries briefly,
    /// because the kernel frees an exited process's group membership
    /// asynchronously.
    pub fn remove(&self) -> io::Result<()> {
        let mut delay = Duration::from_millis(1);
        for _ in 0..10 {
            match fs::remove_dir(&self.path) {
                Ok(()) => return Ok(()),
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
        fs::remove_dir(&self.path)
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn reads_traffic_from_proc_io() {
        let counters = "rchar: 1000\nwchar: 234\nsyscr: 7\nsyscw: 3\nread_bytes: 4096\n\
                        write_bytes: 0\ncancelled_write_bytes: 0\n";
        assert_eq!(parse_io_bytes(counters).unwrap(), 1234);
        assert!(parse_io_bytes("rchar: 5\n").is_err());
    }
}
