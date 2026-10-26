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

/// The controllers a parent group hands its VMs' groups.
const CONTROLLERS: &str = "+memory +cpu";

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
    /// controllers. The groups above it must have them
    /// ([`enable_controllers_above`]).
    pub fn create_parent(path: impl Into<PathBuf>) -> io::Result<Self> {
        let group = Self::create(path)?;
        enable_controllers(&group.path)?;
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

    /// Bytes of memory charged to the group that the kernel cannot drop
    /// at once: [`Self::memory_current`] less the page cache that is clean
    /// and mapped by no process (`file` less `shmem`, `file_mapped`,
    /// `file_dirty` and `file_writeback` in `memory.stat`), and never less
    /// than what `memory.stat` alone names as held.
    ///
    /// A VMM's page cache is what its block devices read and write and the
    /// images it saves, never guest memory, which is anonymous or mapped.
    /// The kernel charges it to the group that touched it first, yet drops
    /// it whenever memory is short, and `MemAvailable` already counts it,
    /// less the kernel's low watermark, as available: counting it as held
    /// as well would count it twice. Without the fields (an older kernel),
    /// nothing is left out.
    ///
    /// The two files are separate reads, so cache the VMM adds between
    /// them would be subtracted from a total that never had it, leaving
    /// out memory the VM still holds. What `memory.stat` names as held
    /// (`anon`, `kernel`, `sock`, `hugetlb` and the cache that stays) comes
    /// from one read and has no such gap; `memory.current` adds whatever
    /// the file does not name. The larger of the two is never too small.
    pub fn memory_held(&self) -> io::Result<u64> {
        let current = self.memory_current()?;
        let stat = fs::read_to_string(self.path.join("memory.stat"))?;
        Ok(held_memory(current, &stat))
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
        let mut total = 0_u64;
        self.each_io(|counters| {
            total = total.saturating_add(parse_io_bytes(counters)?);
            Ok(())
        })?;
        Ok(total)
    }

    /// What the group's processes have written through `write(2)` and its
    /// kin: the bytes (`wchar` in `/proc/<pid>/io`, every thread counted)
    /// and the calls (`syscw`). A call counts once it returns. For a
    /// Firecracker VMM that covers every write its synchronous block
    /// devices make, besides its tap's and part of its vsock's traffic
    /// (see [`Self::io_bytes`]). A process that ends between listing and
    /// reading is left out, so only differences between readings of the
    /// same processes mean anything.
    pub fn writes(&self) -> io::Result<Writes> {
        let mut total = Writes::default();
        self.each_io(|counters| {
            let found = parse_writes(counters)?;
            total = Writes {
                bytes: total.bytes.saturating_add(found.bytes),
                calls: total.calls.saturating_add(found.calls),
            };
            Ok(())
        })?;
        Ok(total)
    }

    /// Calls `take` with the `/proc/<pid>/io` counters of each of the
    /// group's processes, skipping one that ends meanwhile.
    fn each_io(&self, mut take: impl FnMut(&str) -> io::Result<()>) -> io::Result<()> {
        let procs = fs::read_to_string(self.path.join("cgroup.procs"))?;
        for pid in procs.split_whitespace() {
            match fs::read_to_string(format!("/proc/{pid}/io")) {
                Ok(counters) => take(&counters)?,
                Err(error)
                    if error.kind() == io::ErrorKind::NotFound
                        || error.raw_os_error() == Some(rustix::io::Errno::SRCH.raw_os_error()) => {
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
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

    /// Sets the group's share of contended processor time (`cpu.weight`,
    /// 1 to 10000).
    pub fn set_cpu_weight(&self, weight: u16) -> io::Result<()> {
        fs::write(
            self.path.join("cpu.weight"),
            weight.clamp(1, 10_000).to_string(),
        )
    }

    /// Sets the most memory the group may hold (`memory.max`), or no limit
    /// for `None`. Lowering it below what the group holds makes the kernel
    /// reclaim from it, or end it.
    pub fn set_memory_max(&self, bytes: Option<u64>) -> io::Result<()> {
        let value = bytes.map_or_else(|| "max".to_owned(), |bytes| bytes.to_string());
        fs::write(self.path.join("memory.max"), value)
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
        claim_for_children(parent)
    }

    /// Removes the child groups no process is in, then sets the group's
    /// `memory.low` to the sum of what the rest claim, as
    /// [`Cgroup::protect_parent`] does. VMs that ended while nobody
    /// managed them, such as when the host agent was killed, leave their
    /// groups behind, and each would go on claiming its VM's protection.
    /// Only for a parent whose children are all VMs of one engine, before
    /// it starts any: a group being set up is empty for a moment too.
    pub fn remove_empty_children(&self) -> io::Result<()> {
        let _serial = PARENT_LOW.lock().unwrap_or_else(PoisonError::into_inner);
        for entry in fs::read_dir(&self.path)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            if Self::at(entry.path()).is_populated()? {
                continue;
            }
            match fs::remove_dir(entry.path()) {
                // Gone already, or a process joined it meanwhile: it stays
                // and claims what it does.
                Err(error)
                    if error.kind() != io::ErrorKind::NotFound
                        && error.raw_os_error() != Some(rustix::io::Errno::BUSY.raw_os_error()) =>
                {
                    return Err(error);
                }
                _ => {}
            }
        }
        claim_for_children(&self.path)
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

    /// Asks the kernel to freeze every process in the group and its
    /// descendants (`cgroup.freeze` 1), or to thaw them (0). Freezing
    /// completes asynchronously: [`Self::freezer`] reports when it has.
    pub fn set_frozen(&self, frozen: bool) -> io::Result<()> {
        fs::write(
            self.path.join("cgroup.freeze"),
            if frozen { "1" } else { "0" },
        )
    }

    /// What the kernel reports of the group's freezer and processes. A
    /// group that does not exist is empty.
    pub fn freezer(&self) -> io::Result<Freezer> {
        let asked = match fs::read_to_string(self.path.join("cgroup.freeze")) {
            Ok(value) => value.trim() == "1",
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(Freezer {
                    asked: false,
                    frozen: false,
                    empty: true,
                });
            }
            Err(error) => return Err(error),
        };
        let events = match fs::read_to_string(self.path.join("cgroup.events")) {
            Ok(events) => events,
            Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(error),
        };
        Ok(Freezer::parse(asked, &events))
    }

    /// Whether the group's processes are held frozen: the kernel reports
    /// it frozen, or it or a group above it asks for a freeze (one still
    /// completing, or one a process leaving the group interrupts, holds
    /// the rest all the same). A group that does not exist is not.
    pub fn is_held_frozen(&self) -> io::Result<bool> {
        let freezer = self.freezer()?;
        if freezer.empty {
            return Ok(false);
        }
        if freezer.frozen || freezer.asked {
            return Ok(true);
        }
        // Up to the root group, the only one without a freezer of its own.
        let mut above = self.path.parent();
        while let Some(group) = above {
            match fs::read_to_string(group.join("cgroup.freeze")) {
                Ok(value) if value.trim() == "1" => return Ok(true),
                Ok(_) => above = group.parent(),
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
                Err(error) => return Err(error),
            }
        }
        Ok(false)
    }

    /// The groups directly inside this one; none if it is gone.
    pub fn children(&self) -> io::Result<Vec<Self>> {
        let entries = match fs::read_dir(&self.path) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut children = Vec::new();
        for entry in entries {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                children.push(Self::at(entry.path()));
            }
        }
        Ok(children)
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

/// What the kernel reports of a group's freezer; see [`Cgroup::freezer`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Freezer {
    /// A freeze is asked for (`cgroup.freeze` reads 1), whoever asked.
    pub asked: bool,
    /// Every process in it is frozen (`cgroup.events`: `frozen 1`).
    pub frozen: bool,
    /// No process is in it (`cgroup.events`: `populated 0`).
    pub empty: bool,
}

impl Freezer {
    fn parse(asked: bool, events: &str) -> Self {
        let flag = |name: &str| {
            events.lines().any(|line| {
                line.split_once(' ')
                    .is_some_and(|(key, value)| key == name && value.trim() == "1")
            })
        };
        Self {
            asked,
            frozen: flag("frozen"),
            empty: !flag("populated"),
        }
    }
}

/// A group's zswap traffic, memory pressure and major faults; see
/// [`Cgroup::memory_stats`]. Every count starts at zero with the group.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MemoryStats {
    /// Pages compressed into zswap since the group was created.
    pub zswpout: u64,
    /// Pages brought back from zswap since the group was created.
    pub zswpin: u64,
    /// Share of the last ten seconds in which some of the group's processes
    /// waited for memory, in percent (`some avg10` in `memory.pressure`).
    pub pressure_some_avg10: Option<f64>,
    /// Microseconds in which some of the group's processes waited for
    /// memory (`some total` in `memory.pressure`); `None` without pressure
    /// stall information.
    pub pressure_some_us: Option<u64>,
    /// Microseconds in which all of them did at once (`full total`).
    pub pressure_full_us: Option<u64>,
    /// Page faults that had to wait for a page to be read in or brought
    /// back from zswap (`pgmajfault` in `memory.stat`).
    pub major_faults: Option<u64>,
}

fn parse_memory_stats(stat: &str, pressure: Option<&str>) -> MemoryStats {
    // Every running VM is read every second, so each file is walked once.
    let mut stats = MemoryStats::default();
    for line in stat.lines() {
        let Some((name, value)) = line.split_once(' ') else {
            continue;
        };
        let value = || value.trim().parse().ok();
        match name {
            "zswpout" => stats.zswpout = value().unwrap_or(0),
            "zswpin" => stats.zswpin = value().unwrap_or(0),
            "pgmajfault" => stats.major_faults = value(),
            _ => {}
        }
    }
    for line in pressure.into_iter().flat_map(str::lines) {
        let Some((kind, pairs)) = line.split_once(' ') else {
            continue;
        };
        for (key, value) in pairs
            .split_whitespace()
            .filter_map(|pair| pair.split_once('='))
        {
            match (kind, key) {
                ("some", "avg10") => stats.pressure_some_avg10 = value.parse().ok(),
                ("some", "total") => stats.pressure_some_us = value.parse().ok(),
                ("full", "total") => stats.pressure_full_us = value.parse().ok(),
                _ => {}
            }
        }
    }
    stats
}

/// Bytes of a group's memory the kernel cannot drop at once, from its
/// `memory.current` read before its `memory.stat`; see
/// [`Cgroup::memory_held`].
fn held_memory(current: u64, stat: &str) -> u64 {
    let cache = Cache::of(stat);
    current
        .saturating_sub(cache.droppable())
        .max(cache.named_held)
}

/// Bytes of a group's page cache that is clean and mapped by no process,
/// from its `memory.stat`: what the kernel can drop without writing or
/// unmapping anything.
#[cfg(test)]
fn droppable_cache(stat: &str) -> u64 {
    Cache::of(stat).droppable()
}

/// A group's page cache, and what its `memory.stat` names as held, from
/// one read of the file.
struct Cache {
    /// `file`: page cache, shared memory (tmpfs) included.
    file: u64,
    /// The part of `file` the kernel cannot drop at once: shared memory,
    /// mapped files and cache still to be written. A page that is two of
    /// these may be counted twice, which only counts more as held.
    kept: u64,
    /// `anon`, `kernel`, `sock` and `hugetlb` (each charged apart from the
    /// others and from `file`) and the part of `file` that is kept.
    named_held: u64,
}

impl Cache {
    fn of(stat: &str) -> Self {
        let (mut file, mut kept, mut other) = (0_u64, 0_u64, 0_u64);
        for line in stat.lines() {
            let Some((name, value)) = line.split_once(' ') else {
                continue;
            };
            let Ok(value) = value.trim().parse::<u64>() else {
                continue;
            };
            match name {
                "file" => file = value,
                "shmem" | "file_mapped" | "file_dirty" | "file_writeback" => {
                    kept = kept.saturating_add(value);
                }
                "anon" | "kernel" | "sock" | "hugetlb" => other = other.saturating_add(value),
                _ => {}
            }
        }
        Self {
            file,
            kept,
            named_held: other.saturating_add(file.min(kept)),
        }
    }

    /// Bytes of `file` that are clean and mapped by no process.
    fn droppable(&self) -> u64 {
        self.file.saturating_sub(self.kept)
    }
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

/// Sets `parent`'s `memory.low` to the sum of its child groups'. The caller
/// holds [`PARENT_LOW`].
fn claim_for_children(parent: &Path) -> io::Result<()> {
    let mut total = 0_u64;
    for entry in fs::read_dir(parent)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        match fs::read_to_string(entry.path().join("memory.low")) {
            Ok(low) => total = total.saturating_add(low.trim().parse().unwrap_or(0)),
            // A child group removed meanwhile claims nothing: its directory
            // is gone, or its files answer that it no longer exists while
            // the kernel takes it down.
            Err(error)
                if error.kind() == io::ErrorKind::NotFound
                    || error.raw_os_error() == Some(rustix::io::Errno::NODEV.raw_os_error()) => {}
            Err(error) => return Err(error),
        }
    }
    fs::write(parent.join("memory.low"), total.to_string())
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

/// What processes have written through `write(2)` and its kin; see
/// [`Cgroup::writes`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Writes {
    /// Bytes written.
    pub bytes: u64,
    /// Write calls that returned.
    pub calls: u64,
}

impl Writes {
    /// What was written since `earlier`, a reading of the same processes.
    #[must_use]
    pub fn since(self, earlier: Self) -> Self {
        Self {
            bytes: self.bytes.saturating_sub(earlier.bytes),
            calls: self.calls.saturating_sub(earlier.calls),
        }
    }
}

/// The value of counter `name` (with its colon) in `/proc/<pid>/io`.
fn io_counter(counters: &str, name: &str) -> io::Result<u64> {
    counters
        .lines()
        .find_map(|line| line.strip_prefix(name))
        .and_then(|value| value.trim().parse::<u64>().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, format!("io has no {name}")))
}

fn parse_writes(counters: &str) -> io::Result<Writes> {
    Ok(Writes {
        bytes: io_counter(counters, "wchar:")?,
        calls: io_counter(counters, "syscw:")?,
    })
}

fn parse_io_bytes(counters: &str) -> io::Result<u64> {
    Ok(io_counter(counters, "rchar:")?.saturating_add(io_counter(counters, "wchar:")?))
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

/// Enables the memory and CPU controllers in every group above `relative`
/// (a group below the cgroup v2 hierarchy mounted at `mount`), from the root
/// down, so that group can have them and hand them on to its children. A
/// group gets a controller only once its parent enables it, and systemd
/// enables one at the root only when some unit needs it, which at boot can
/// be after the agent starts.
pub fn enable_controllers_above(mount: &Path, relative: &Path) -> io::Result<()> {
    let mut above: Vec<&Path> = relative.ancestors().skip(1).collect();
    above.reverse();
    for group in above {
        enable_controllers(&mount.join(group))?;
    }
    Ok(())
}

/// Enables the memory and CPU controllers for the children of the group at
/// `group`; enabling one already enabled changes nothing.
fn enable_controllers(group: &Path) -> io::Result<()> {
    let control = group.join("cgroup.subtree_control");
    fs::write(&control, CONTROLLERS).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!("enabling {CONTROLLERS} in {}: {error}", control.display()),
        )
    })
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
    fn controllers_are_enabled_in_every_group_above_a_parent() {
        let mount = tempfile::tempdir().unwrap();
        fs::create_dir_all(mount.path().join("fleet/hosts")).unwrap();
        enable_controllers_above(mount.path(), Path::new("fleet/hosts/vms")).unwrap();
        for group in ["", "fleet", "fleet/hosts"] {
            let control = mount.path().join(group).join("cgroup.subtree_control");
            assert_eq!(fs::read_to_string(control).unwrap(), CONTROLLERS, "{group}");
        }
        assert!(!mount.path().join("fleet/hosts/vms").exists());
        // Only the root is above a group just below it.
        let mount = tempfile::tempdir().unwrap();
        enable_controllers_above(mount.path(), Path::new("compute")).unwrap();
        assert!(mount.path().join("cgroup.subtree_control").exists());
        assert!(!mount.path().join("compute").exists());
    }

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
    fn reads_the_freezer_from_cgroup_events() {
        let running = Freezer::parse(false, "populated 1\nfrozen 0\n");
        assert_eq!(
            running,
            Freezer {
                asked: false,
                frozen: false,
                empty: false
            }
        );
        let frozen = Freezer::parse(true, "populated 1\nfrozen 1\n");
        assert!(frozen.asked && frozen.frozen && !frozen.empty);
        // An empty group a freeze was asked of reports frozen too.
        let empty = Freezer::parse(true, "populated 0\nfrozen 1\n");
        assert!(empty.empty && empty.frozen);
        assert!(Freezer::parse(false, "").empty);
    }

    /// A group with processes is held frozen once the kernel says it is,
    /// or while it or a group above it asks for a freeze, even one that
    /// reads `frozen 0` because a process in it is ending.
    #[test]
    fn a_group_is_held_frozen_by_its_own_freeze_or_one_above() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("vms");
        let vm = parent.join("vm");
        std::fs::create_dir_all(&vm).unwrap();
        let set = |path: &Path, freeze: &str, events: &str| {
            std::fs::write(path.join("cgroup.freeze"), freeze).unwrap();
            std::fs::write(path.join("cgroup.events"), events).unwrap();
        };
        let group = Cgroup::at(&vm);
        set(&parent, "0", "populated 1\nfrozen 0\n");
        set(&vm, "0", "populated 1\nfrozen 0\n");
        assert!(!group.is_held_frozen().unwrap(), "running");
        set(&parent, "1", "populated 1\nfrozen 0\n");
        assert!(group.is_held_frozen().unwrap(), "the group above asks");
        set(&vm, "0", "populated 1\nfrozen 1\n");
        assert!(group.is_held_frozen().unwrap());
        set(&parent, "0", "populated 1\nfrozen 0\n");
        set(&vm, "1", "populated 1\nfrozen 0\n");
        assert!(
            group.is_held_frozen().unwrap(),
            "its own freeze, still completing"
        );
        set(&vm, "1", "populated 0\nfrozen 1\n");
        assert!(!group.is_held_frozen().unwrap(), "nothing left to hold");
        assert!(!Cgroup::at(parent.join("gone")).is_held_frozen().unwrap());

        let names = |group: &Cgroup| {
            let mut names: Vec<_> = group
                .children()
                .unwrap()
                .iter()
                .map(|child| child.path().file_name().unwrap().to_owned())
                .collect();
            names.sort();
            names
        };
        std::fs::create_dir(parent.join("other")).unwrap();
        assert_eq!(
            names(&Cgroup::at(&parent)),
            ["other", "vm"],
            "groups, not files"
        );
        assert_eq!(names(&Cgroup::at(parent.join("gone"))), [""; 0]);
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

    /// Groups VMs left behind claim no protection once an engine starts:
    /// empty ones go, and the parent claims what those with a process do.
    #[test]
    fn empty_groups_left_behind_are_removed_with_their_claims() {
        let parent = tempfile::tempdir().unwrap();
        let running = parent.path().join("running");
        fs::create_dir(&running).unwrap();
        fs::write(running.join("cgroup.events"), "populated 1\nfrozen 0\n").unwrap();
        fs::write(running.join("memory.low"), "536870912\n").unwrap();
        // A real group's control files go with it; here an empty directory
        // stands for one left behind.
        fs::create_dir(parent.path().join("left-behind")).unwrap();
        fs::write(parent.path().join("memory.low"), "9663676416\n").unwrap();
        Cgroup::at(parent.path()).remove_empty_children().unwrap();
        assert!(running.exists());
        assert!(!parent.path().join("left-behind").exists());
        assert_eq!(
            fs::read_to_string(parent.path().join("memory.low")).unwrap(),
            "536870912"
        );
    }

    #[test]
    fn reads_zswap_traffic_and_pressure() {
        let stat = "anon 4096\nzswap 0\nzswapped 0\nzswpin 3\nzswpout 17\nzswpwb 0\n\
                    pgfault 900\npgmajfault 42\n";
        let pressure = "some avg10=1.25 avg60=0.40 avg300=0.08 total=12345\n\
                        full avg10=0.50 avg60=0.10 avg300=0.02 total=4567\n";
        assert_eq!(
            parse_memory_stats(stat, Some(pressure)),
            MemoryStats {
                zswpout: 17,
                zswpin: 3,
                pressure_some_avg10: Some(1.25),
                pressure_some_us: Some(12_345),
                pressure_full_us: Some(4567),
                major_faults: Some(42),
            }
        );
        // Without zswap, fault counts or pressure stall information: absent,
        // not zero.
        assert_eq!(
            parse_memory_stats("anon 4096\n", None),
            MemoryStats::default()
        );
    }

    #[test]
    fn page_cache_the_host_can_drop_is_not_held() {
        // A paused VM just after its 8 GiB image was saved: 330 MB of guest
        // memory, and the image's page cache charged to its group.
        let stat = "anon 329879552\nfile 8237420544\nkernel 22253568\nshmem 8192\n\
                    file_mapped 40960\nfile_dirty 0\nfile_writeback 0\n\
                    active_file 8235515904\ninactive_file 1896448\n";
        assert_eq!(droppable_cache(stat), 8_237_420_544 - 8192 - 40960);
        let group = tempfile::tempdir().unwrap();
        fs::write(group.path().join("memory.current"), "8589553664\n").unwrap();
        fs::write(group.path().join("memory.stat"), stat).unwrap();
        assert_eq!(
            Cgroup::at(group.path()).memory_held().unwrap(),
            8_589_553_664 - (8_237_420_544 - 8192 - 40960)
        );
        // Cache still to be written, shared memory (tmpfs) and mapped files
        // stay held.
        let busy = "file 3000\nshmem 1000\nfile_mapped 500\nfile_dirty 700\nfile_writeback 300\n";
        assert_eq!(droppable_cache(busy), 500);
        // More kept than cached (a page both mapped and dirty) drops nothing.
        assert_eq!(
            droppable_cache("file 100\nfile_mapped 80\nfile_dirty 80\n"),
            0
        );
        // An older kernel's file without the fields leaves everything held.
        assert_eq!(droppable_cache("anon 4096\n"), 0);
        fs::write(group.path().join("memory.stat"), "anon 4096\n").unwrap();
        assert_eq!(
            Cgroup::at(group.path()).memory_held().unwrap(),
            8_589_553_664
        );
    }

    #[test]
    fn cache_added_between_the_two_reads_leaves_nothing_held_out() {
        const MIB: u64 = 1 << 20;
        // 512 MiB held when `memory.current` is read; 1 GiB of clean cache
        // arrives before `memory.stat` is.
        let stat = format!(
            "anon {}\nfile {}\nkernel {}\nsock 0\nshmem 0\nfile_mapped 0\n\
             file_dirty 0\nfile_writeback 0\n",
            500 * MIB,
            1024 * MIB,
            12 * MIB
        );
        assert_eq!(held_memory(512 * MIB, &stat), 512 * MIB);
        // Read at the same moment, the two agree.
        assert_eq!(held_memory(1536 * MIB, &stat), 512 * MIB);
        // Cache dropped between the reads is in the total but not in the
        // file, and only counts more as held.
        assert_eq!(held_memory(1600 * MIB, &stat), 576 * MIB);
        // Mapped, shared and unwritten cache is named as held too, at most
        // the cache there is.
        let busy = format!(
            "anon {}\nfile {}\nshmem {}\nfile_mapped {}\nfile_dirty {}\n",
            100 * MIB,
            300 * MIB,
            200 * MIB,
            100 * MIB,
            50 * MIB
        );
        assert_eq!(held_memory(0, &busy), 400 * MIB);
    }

    #[test]
    fn reads_traffic_from_proc_io() {
        let counters = "rchar: 1000\nwchar: 234\nsyscr: 7\nsyscw: 3\nread_bytes: 4096\n\
                        write_bytes: 0\ncancelled_write_bytes: 0\n";
        assert_eq!(parse_io_bytes(counters).unwrap(), 1234);
        assert!(parse_io_bytes("rchar: 5\n").is_err());
    }

    #[test]
    fn reads_writes_from_proc_io() {
        let counters = "rchar: 1000\nwchar: 234\nsyscr: 7\nsyscw: 3\nread_bytes: 4096\n\
                        write_bytes: 0\ncancelled_write_bytes: 0\n";
        let writes = parse_writes(counters).unwrap();
        assert_eq!(
            writes,
            Writes {
                bytes: 234,
                calls: 3
            }
        );
        assert!(parse_writes("wchar: 5\n").is_err());
        let earlier = Writes {
            bytes: 34,
            calls: 1,
        };
        assert_eq!(
            writes.since(earlier),
            Writes {
                bytes: 200,
                calls: 2
            }
        );
        assert_eq!(earlier.since(writes), Writes::default());
    }
}
