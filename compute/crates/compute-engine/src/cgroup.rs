//! Linux cgroup v2 groups: one per VM, so the host can account, limit and
//! reclaim each VM's memory on its own.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Mutex, PoisonError};
use std::thread;
use std::time::Duration;

/// Serializes updates of a parent group's `memory.low`, so that the last
/// one written counts every child's.
static PARENT_LOW: Mutex<()> = Mutex::new(());

/// How often [`Cgroup::set_memory_high`] looks whether the limit it is
/// writing applies yet.
const MEMORY_HIGH_LOOK: Duration = Duration::from_millis(20);

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

    /// Bytes of host memory the group's compressed pages take
    /// (`memory.zswap.current`), part of [`Self::memory_current`]; 0 on a
    /// kernel without zswap.
    pub fn memory_compressed(&self) -> io::Result<u64> {
        match read_u64(&self.path.join("memory.zswap.current")) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(0),
            read => read,
        }
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
    /// and the calls (`syscw`), and the bytes of the pages they dirtied
    /// for files (`write_bytes`). A call counts once it returns; a page
    /// counts as it is dirtied, so also one dirtied without a write call,
    /// as a hole punched over part of a block zeroes the rest of that
    /// block. For a Firecracker VMM that covers every write and discard
    /// its synchronous block devices make, besides its tap's and part of
    /// its vsock's traffic (see [`Self::io_bytes`]). A process that ends
    /// between listing and reading is left out, so only differences
    /// between readings of the same processes mean anything.
    pub fn writes(&self) -> io::Result<Writes> {
        let mut total = Writes::default();
        self.each_io(|counters| {
            let found = parse_writes(counters)?;
            total = Writes {
                bytes: total.bytes.saturating_add(found.bytes),
                calls: total.calls.saturating_add(found.calls),
                dirtied: total.dirtied.saturating_add(found.dirtied),
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

    /// Lets the kernel compress the group's memory into zswap, and never
    /// write it to a swap device (`memory.zswap.writeback` 0): what it
    /// compresses stays in RAM, and nothing of the guest reaches a disk.
    /// Needs zswap on (see [`zswap_enabled`]); without it, writeback 0
    /// means nothing and swap would go to disk.
    pub fn open_zswap(&self) -> io::Result<()> {
        fs::write(self.path.join("memory.zswap.writeback"), "0")?;
        fs::write(self.path.join("memory.swap.max"), "max")?;
        fs::write(self.path.join("memory.zswap.max"), "max")
    }

    /// The group's swap slots: bytes of them it holds now
    /// (`memory.swap.current`) and the most it may (`memory.swap.max`,
    /// `None` for no limit). zswap takes a slot for every page it is given,
    /// even one it refuses to keep. `None` on a kernel without swap.
    pub fn swap(&self) -> io::Result<Option<Swap>> {
        let used = match read_u64(&self.path.join("memory.swap.current")) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            read => read?,
        };
        let max = parse_limit(&fs::read_to_string(self.path.join("memory.swap.max"))?)?;
        Ok(Some(Swap { used, max }))
    }

    /// Sets the most swap the group may hold (`memory.swap.max`), or no
    /// limit for `None`. The kernel stops taking its anonymous pages out of
    /// RAM once it holds that much, and takes nothing back for it.
    pub fn set_swap_max(&self, bytes: Option<u64>) -> io::Result<()> {
        let value = bytes.map_or_else(|| "max".to_owned(), |bytes| bytes.to_string());
        fs::write(self.path.join("memory.swap.max"), value)
    }

    /// Bytes of the group's memory the kernel has taken out of RAM so far
    /// without writing it anywhere, at their original size: pages zswap
    /// kept compressed and pages that were all zeros (`zswpout` and
    /// `swpout_zero` in `memory.stat`). 0 on a kernel that says neither.
    pub fn memory_stored(&self) -> io::Result<u64> {
        let stat = fs::read_to_string(self.path.join("memory.stat"))?;
        let page = u64::try_from(rustix::param::page_size()).unwrap_or(4096);
        Ok(stored_pages(&stat).saturating_mul(page))
    }

    /// Asks the kernel to reclaim up to `bytes` from the group now
    /// (`memory.reclaim`): file pages dropped, and with zswap open (see
    /// [`Cgroup::open_zswap`]) anonymous pages compressed. Returns `false`
    /// when it reclaimed less than asked, because what is left is in use or
    /// already compressed. Blocks while it works; call it from a blocking
    /// thread.
    pub fn reclaim(&self, bytes: u64) -> io::Result<bool> {
        match fs::write(self.path.join("memory.reclaim"), bytes.max(1).to_string()) {
            Ok(()) => Ok(true),
            Err(error) if error.raw_os_error() == Some(rustix::io::Errno::AGAIN.raw_os_error()) => {
                Ok(false)
            }
            Err(error) => Err(error),
        }
    }

    /// Drops up to `bytes` of the group's page cache now, and nothing else
    /// (`memory.reclaim` with `swappiness=0`): no anonymous page is
    /// compressed for it. `None` on a kernel that cannot be asked for
    /// cache alone (before 6.9). Blocks while it works; call it from a
    /// blocking thread.
    pub fn drop_cache(&self, bytes: u64) -> io::Result<Option<()>> {
        let asked = format!("{} swappiness=0", bytes.max(1));
        match fs::write(self.path.join("memory.reclaim"), asked) {
            Ok(()) => Ok(Some(())),
            Err(error) if error.raw_os_error() == Some(rustix::io::Errno::AGAIN.raw_os_error()) => {
                Ok(Some(()))
            }
            Err(error) if error.raw_os_error() == Some(rustix::io::Errno::INVAL.raw_os_error()) => {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    /// Bytes of page cache charged to the group that are clean and mapped
    /// by no process, its children's and what ended children left it
    /// included: what [`Cgroup::drop_cache`] can drop at once.
    pub fn droppable_cache(&self) -> io::Result<u64> {
        let stat = fs::read_to_string(self.path.join("memory.stat"))?;
        Ok(Cache::of(&stat).droppable())
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

    /// Sets the memory above which the kernel slows the group's processes
    /// down as they take more (`memory.high`), reclaiming from the group
    /// first and making each wait on its own allocations, or no such
    /// point for `None`. It never ends a process: a group past it only
    /// gets slower.
    ///
    /// Setting it below what the group holds makes the kernel reclaim the
    /// difference. Kernels that honour `O_NONBLOCK` for the file leave that
    /// to the group's own allocations; older ones do it in the write, after
    /// the limit already applies, for as long as reclaim makes progress,
    /// writeback of dirty disk pages included. The writer would wait all
    /// that time: a starting host agent, for one, before it renews its
    /// lease. So the write runs on a thread of its own, and this returns
    /// its result when it ends, or `Ok` as soon as the group shows the new
    /// limit while the kernel goes on reclaiming toward it on that thread.
    /// It never returns before the limit applies: a later setting cannot be
    /// overtaken by this one.
    pub fn set_memory_high(&self, bytes: Option<u64>) -> io::Result<()> {
        let value = bytes.map_or_else(|| "max".to_owned(), |bytes| bytes.to_string());
        let path = self.path.join("memory.high");
        // The kernel keeps whole pages, and shows what it keeps.
        let page = u64::try_from(rustix::param::page_size()).unwrap_or(4096);
        let shown = bytes.map(|bytes| bytes - bytes % page);
        write_until_applied(
            MEMORY_HIGH_LOOK,
            move || write_nonblocking(&path, value.as_bytes()),
            || Ok(self.memory_high()? == shown),
        )
    }

    /// The group's `memory.high` as it is now: `None` for no limit
    /// (`max`), which is also what an operator writing `max` leaves.
    pub fn memory_high(&self) -> io::Result<Option<u64>> {
        let value = fs::read_to_string(self.path.join("memory.high"))?;
        parse_limit(&value)
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

    /// The group's zswap traffic and memory pressure so far, and its
    /// `memory.high` now.
    pub fn memory_stats(&self) -> io::Result<MemoryStats> {
        let stat = fs::read_to_string(self.path.join("memory.stat"))?;
        // Without pressure stall information the file is missing or
        // unreadable; the rest still counts.
        let pressure = fs::read_to_string(self.path.join("memory.pressure")).ok();
        Ok(MemoryStats {
            high: self.memory_high().ok().flatten(),
            ..parse_memory_stats(&stat, pressure.as_deref())
        })
    }

    /// How long, all told, some of the group's processes have waited for
    /// memory (`some total` in `memory.pressure`), the kernel's reclaim and
    /// its slowing of groups past `memory.high` included; `None` without
    /// pressure stall information.
    pub fn memory_waited(&self) -> io::Result<Option<Duration>> {
        let pressure = fs::read_to_string(self.path.join("memory.pressure"))?;
        let stats = parse_memory_stats("", Some(&pressure));
        Ok(stats.pressure_some_us.map(Duration::from_micros))
    }

    /// How many processes in the group and below it the kernel's
    /// out-of-memory killer ended since the group was made (`oom_kill` in
    /// `memory.events`, which counts the groups below too).
    pub fn oom_kills(&self) -> io::Result<u64> {
        let events = fs::read_to_string(self.path.join("memory.events"))?;
        Ok(parse_oom_kills(&events))
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
    /// Bytes its compressed pages take in RAM now (`zswap` in
    /// `memory.stat`); `None` on a kernel that does not say.
    pub compressed: Option<u64>,
    /// Bytes of its memory compressed into zswap now, at their original
    /// size (`zswapped`). Its swap never reaches a disk (writeback is off),
    /// so this is all of its memory out of RAM.
    pub swapped: Option<u64>,
    /// Share of the last ten seconds in which some of the group's processes
    /// waited for memory, in percent (`some avg10` in `memory.pressure`).
    pub pressure_some_avg10: Option<f64>,
    /// Share of the last ten seconds in which all of them did at once, in
    /// percent (`full avg10`): time the group got nothing done for memory.
    pub pressure_full_avg10: Option<f64>,
    /// Microseconds in which some of the group's processes waited for
    /// memory (`some total` in `memory.pressure`); `None` without pressure
    /// stall information.
    pub pressure_some_us: Option<u64>,
    /// Microseconds in which all of them did at once (`full total`).
    pub pressure_full_us: Option<u64>,
    /// Page faults that had to wait for a page to be read in or brought
    /// back from zswap (`pgmajfault` in `memory.stat`).
    pub major_faults: Option<u64>,
    /// Its `memory.high` as the kernel holds it now; `None` for none, or
    /// when it cannot be read.
    pub high: Option<u64>,
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
            "zswap" => stats.compressed = value(),
            "zswapped" => stats.swapped = value(),
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
                ("full", "avg10") => stats.pressure_full_avg10 = value.parse().ok(),
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

/// Bytes of swap the host has (`SwapTotal` in `/proc/meminfo`): what zswap
/// can hold at most, at its pages' original size, since every compressed
/// page takes a swap slot even when it never reaches the device.
pub fn swap_total() -> io::Result<u64> {
    let meminfo = fs::read_to_string("/proc/meminfo")?;
    Ok(meminfo
        .lines()
        .find_map(|line| line.strip_prefix("SwapTotal:"))
        .and_then(|value| value.trim().strip_suffix("kB"))
        .and_then(|kib| kib.trim().parse::<u64>().ok())
        .map_or(0, |kib| kib << 10))
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

/// A group's swap slots; see [`Cgroup::swap`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Swap {
    /// Bytes of slots it holds (`memory.swap.current`).
    pub used: u64,
    /// The most it may hold (`memory.swap.max`); `None` for no limit.
    pub max: Option<u64>,
}

/// Pages a group's `memory.stat` says the kernel took out of RAM without a
/// disk: `zswpout` and `swpout_zero`.
fn stored_pages(stat: &str) -> u64 {
    stat.lines()
        .filter_map(|line| line.split_once(' '))
        .filter(|(name, _)| matches!(*name, "zswpout" | "swpout_zero"))
        .filter_map(|(_, value)| value.trim().parse::<u64>().ok())
        .fold(0, u64::saturating_add)
}

/// `oom_kill` of a `memory.events` file; 0 when it has none.
fn parse_oom_kills(events: &str) -> u64 {
    events
        .lines()
        .filter_map(|line| line.split_once(' '))
        .find(|(name, _)| *name == "oom_kill")
        .and_then(|(_, value)| value.trim().parse().ok())
        .unwrap_or(0)
}

/// A memory limit file's value: bytes, or `None` for `max`.
fn parse_limit(value: &str) -> io::Result<Option<u64>> {
    match value.trim() {
        "max" => Ok(None),
        bytes => bytes
            .parse()
            .map(Some)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error)),
    }
}

/// Writes `value` to the control file at `path`, opened with `O_NONBLOCK`
/// for the kernels that honour it, in one write as cgroup files take it,
/// replacing what is there as [`fs::write`] does.
fn write_nonblocking(path: &Path, value: &[u8]) -> io::Result<()> {
    use rustix::fs::{Mode, OFlags};
    let file = rustix::fs::open(
        path,
        OFlags::WRONLY | OFlags::TRUNC | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let written = rustix::io::write(&file, value)?;
    if written == value.len() {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::WriteZero,
            format!("{} took {written} of {} bytes", path.display(), value.len()),
        ))
    }
}

/// Runs `write` on a thread of its own and returns its result once it
/// ends, or `Ok` once `applied` says its effect shows while it goes on,
/// looking every `look`.
fn write_until_applied(
    look: Duration,
    write: impl FnOnce() -> io::Result<()> + Send + 'static,
    applied: impl Fn() -> io::Result<bool>,
) -> io::Result<()> {
    let (done, outcome) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("cgroup-write".to_owned())
        .spawn(move || {
            // Nobody listens once the effect showed.
            let _ = done.send(write());
        })?;
    loop {
        match outcome.recv_timeout(look) {
            Ok(result) => return result,
            Err(RecvTimeoutError::Timeout) => {
                if applied()? {
                    return Ok(());
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err(io::Error::other("the cgroup write ended without a result"));
            }
        }
    }
}

fn parse_cpu_usage(stat: &str) -> io::Result<Duration> {
    stat.lines()
        .find_map(|line| line.strip_prefix("usage_usec "))
        .and_then(|value| value.trim().parse().ok())
        .map(Duration::from_micros)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "cpu.stat has no usage_usec"))
}

/// What processes have written through `write(2)` and its kin, and the
/// file pages they dirtied; see [`Cgroup::writes`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Writes {
    /// Bytes written.
    pub bytes: u64,
    /// Write calls that returned.
    pub calls: u64,
    /// Bytes of the file pages dirtied, by write calls or otherwise: a
    /// page dirtied again before it is written out counts once.
    pub dirtied: u64,
}

impl Writes {
    /// What was written since `earlier`, a reading of the same processes.
    #[must_use]
    pub fn since(self, earlier: Self) -> Self {
        Self {
            bytes: self.bytes.saturating_sub(earlier.bytes),
            calls: self.calls.saturating_sub(earlier.calls),
            dirtied: self.dirtied.saturating_sub(earlier.dirtied),
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
        dirtied: io_counter(counters, "write_bytes:")?,
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
mod tests;
