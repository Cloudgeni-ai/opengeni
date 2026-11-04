//! Freeing memory for the host when it is short (the host's `shrink`
//! request, ADR 24).
//!
//! The host asks only a sandbox that holds more than it requested, and only
//! once compressing what it borrowed is not enough. The guest first drops
//! its file cache, which costs nothing but rereading. Then it ends, one at
//! a time, the process the kernel's out-of-memory killer would end first
//! (the highest `oom_score`, so `oom_score_adj` counts as it does for the
//! kernel), until it has freed what was asked or holds no more than its
//! request. That is what the guest's own out-of-memory killer would do had
//! the VM only its request: a build step fails with "Killed", and the rest
//! of the sandbox runs on.
//!
//! It never ends PID 1, the processes PID 1 supervises (envd, Opengeni's
//! agent and the image's command, so a sandbox stays reachable and a
//! runner can still report its job), kernel threads, or a process marked
//! never to be ended (`oom_score_adj` -1000). It ends at most
//! [`MOST_ENDED`] processes per request, and ends none after [`DEADLINE`],
//! so that it answers well within the host's wait with what it managed:
//! the host asks again if it must. Last it compacts memory, since the guest
//! reports free memory to the host only in whole 2 MiB blocks.

use std::fs;
use std::io;
use std::path::Path;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use super::sys;

/// Most processes one request ends.
const MOST_ENDED: usize = 8;

/// Longest the guest waits for a process it ended to be gone.
const END_WAIT: Duration = Duration::from_secs(3);

/// Longest one request goes on ending processes: the host waits 15 s for
/// its answer.
const DEADLINE: Duration = Duration::from_secs(8);

/// The flag of a kernel thread in `/proc/<pid>/stat` (`PF_KTHREAD`).
const PF_KTHREAD: u64 = 0x0020_0000;

/// What a request did.
#[derive(Debug, Default)]
pub struct Shrunk {
    /// Bytes more free than before.
    pub freed: u64,
    /// Whether nothing was left that it may end.
    pub spent: bool,
    /// The names of the processes it ended.
    pub ended: Vec<String>,
}

/// Requests run one at a time: a retry from the host waits for the one
/// under way, then finds less to do.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

/// Frees `free` bytes, keeping at least `keep` in use, and never ends a
/// process in `protected`; see the module documentation.
pub fn shrink(free: u64, keep: u64, protected: &[i32]) -> Shrunk {
    let _one = ONE_AT_A_TIME.lock().unwrap_or_else(PoisonError::into_inner);
    let until = Instant::now() + DEADLINE;
    let proc = Path::new("/proc");
    let Some(before) = memory(proc) else {
        return Shrunk::default();
    };
    let enough = |now: &Memory| now.free.saturating_sub(before.free) >= free || now.used() <= keep;
    // Clean file pages and the kernel's caches of names and files.
    if let Err(error) = fs::write("/proc/sys/vm/drop_caches", "3") {
        super::log(&format!("shrink: dropping caches: {error}"));
    }
    let mut shrunk = Shrunk::default();
    // A process it signalled may take a while to go: it is not chosen
    // again, so that the next one is.
    let mut spared = protected.to_vec();
    for _ in 0..MOST_ENDED {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() || memory(proc).is_none_or(|now| enough(&now)) {
            break;
        }
        let Some(victim) = victim(proc, &spared) else {
            shrunk.spent = true;
            break;
        };
        spared.push(victim.pid);
        match end(proc, &victim, left.min(END_WAIT)) {
            Ok(()) => shrunk.ended.push(victim.name),
            // It may have ended by itself meanwhile; the next look tells.
            Err(error) => super::log(&format!("shrink: ending {}: {error}", victim.pid)),
        }
    }
    if let Err(error) = fs::write("/proc/sys/vm/compact_memory", "1") {
        super::log(&format!("shrink: compacting: {error}"));
    }
    shrunk.freed = memory(proc).map_or(0, |now| now.free.saturating_sub(before.free));
    super::log(&format!(
        "shrink: asked {} MiB keeping {} MiB; freed {} MiB, ended {:?}{}",
        free >> 20,
        keep >> 20,
        shrunk.freed >> 20,
        shrunk.ended,
        if shrunk.spent {
            ", nothing left to end"
        } else {
            ""
        }
    ));
    shrunk
}

/// The guest's memory, from `/proc/meminfo`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Memory {
    total: u64,
    free: u64,
}

impl Memory {
    /// Bytes in use, file cache included.
    fn used(&self) -> u64 {
        self.total.saturating_sub(self.free)
    }
}

fn memory(proc: &Path) -> Option<Memory> {
    parse_meminfo(&fs::read_to_string(proc.join("meminfo")).ok()?)
}

fn parse_meminfo(text: &str) -> Option<Memory> {
    let field = |name: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(name))
            .and_then(|value| value.trim().strip_suffix("kB"))
            .and_then(|kib| kib.trim().parse::<u64>().ok())
            .map(|kib| kib << 10)
    };
    Some(Memory {
        total: field("MemTotal:")?,
        free: field("MemFree:")?,
    })
}

/// A process the guest may end.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Victim {
    pid: i32,
    /// When it started, in clock ticks after boot: a later process that
    /// takes over its number starts later.
    start: u64,
    name: String,
    /// Its `oom_score`, 0 to 2000.
    score: u64,
    /// Its resident pages, which break ties.
    resident: u64,
}

/// The process the out-of-memory killer would end first, if any may be.
fn victim(proc: &Path, protected: &[i32]) -> Option<Victim> {
    let me = i32::try_from(std::process::id()).unwrap_or(1);
    fs::read_dir(proc)
        .ok()?
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse::<i32>().ok())
        .filter(|pid| *pid > 1 && *pid != me && !protected.contains(pid))
        .filter_map(|pid| candidate(proc, pid))
        .max_by_key(|victim| (victim.score, victim.resident))
}

/// Process `pid` as a victim; `None` for one the guest must not end, or
/// that is gone.
fn candidate(proc: &Path, pid: i32) -> Option<Victim> {
    let dir = proc.join(pid.to_string());
    let (name, state, flags, start) = parse_stat(&fs::read_to_string(dir.join("stat")).ok()?)?;
    if matches!(state, 'Z' | 'X' | 'x') || flags & PF_KTHREAD != 0 {
        return None;
    }
    let read = |file: &str| -> Option<i64> {
        fs::read_to_string(dir.join(file))
            .ok()?
            .split_whitespace()
            .next()?
            .parse()
            .ok()
    };
    if read("oom_score_adj")? == -1000 {
        return None;
    }
    let resident = fs::read_to_string(dir.join("statm"))
        .ok()
        .and_then(|statm| statm.split_whitespace().nth(1)?.parse().ok())
        .unwrap_or(0);
    Some(Victim {
        pid,
        start,
        name,
        score: u64::try_from(read("oom_score")?).ok()?,
        resident,
    })
}

/// The name, state, flags and start time in `/proc/<pid>/stat`. The name
/// is in parentheses and may hold any character, a `)` too, so the fields
/// after it start after the last one.
fn parse_stat(text: &str) -> Option<(String, char, u64, u64)> {
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    let name = text.get(open + 1..close)?.to_owned();
    let fields: Vec<&str> = text.get(close + 1..)?.split_whitespace().collect();
    // Fields 3, 9 and 22 of proc_pid_stat(5), counted from the state.
    let state = fields.first()?.chars().next()?;
    let flags = fields.get(6)?.parse().ok()?;
    let start = fields.get(19)?.parse().ok()?;
    Some((name, state, flags, start))
}

/// Ends `victim` and waits, at most `wait`, for it to be gone; never a
/// process that took over its number since it was read.
fn end(proc: &Path, victim: &Victim, wait: Duration) -> io::Result<()> {
    let started = || {
        fs::read_to_string(proc.join(victim.pid.to_string()).join("stat"))
            .ok()
            .and_then(|stat| parse_stat(&stat))
            .map(|(_, _, _, start)| start)
    };
    let gone = || io::Error::new(io::ErrorKind::NotFound, "it ended meanwhile");
    // The descriptor names this process for as long as it is open, so one
    // checked after opening it is the one signalled.
    let pidfd = sys::pidfd_open(victim.pid)?;
    if started() != Some(victim.start) {
        return Err(gone());
    }
    sys::pidfd_kill(&pidfd)?;
    if sys::wait_ended(&pidfd, wait)? {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "ended, but still there",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory of its own, removed with it.
    struct Root(std::path::PathBuf);

    impl Root {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A fake `/proc` with `processes` as (pid, name, state, flags,
    /// `oom_score`, `oom_score_adj`, resident pages).
    fn procfs(processes: &[(i32, &str, char, u64, i64, i64, u64)]) -> Root {
        use std::sync::atomic::{AtomicU32, Ordering};
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let root = Root(std::env::temp_dir().join(format!(
            "compute-guest-shrink-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )));
        fs::create_dir_all(root.path()).unwrap();
        fs::write(
            root.path().join("meminfo"),
            "MemTotal:       8000000 kB\nMemFree:         100000 kB\nMemAvailable: 300000 kB\n",
        )
        .unwrap();
        fs::create_dir(root.path().join("self")).unwrap();
        for &(pid, name, state, flags, score, adj, resident) in processes {
            let dir = root.path().join(pid.to_string());
            fs::create_dir(&dir).unwrap();
            fs::write(
                dir.join("stat"),
                format!(
                    "{pid} ({name}) {state} 1 {pid} {pid} 0 -1 {flags} 0 0 0 0 1 2 0 0 20 0 1 0 {} 1000 {resident}\n",
                    1000 + pid
                ),
            )
            .unwrap();
            fs::write(dir.join("oom_score"), format!("{score}\n")).unwrap();
            fs::write(dir.join("oom_score_adj"), format!("{adj}\n")).unwrap();
            fs::write(
                dir.join("statm"),
                format!("{} {resident} 0 0 0 0 0\n", resident * 2),
            )
            .unwrap();
        }
        root
    }

    #[test]
    fn ends_what_the_kernel_would_end_first_and_never_what_it_must_keep() {
        let root = procfs(&[
            (1, "compute-guest", 'S', 0, 900, 0, 900),
            (2, "kthreadd", 'S', PF_KTHREAD, 0, 0, 0),
            (40, "envd", 'S', 0, 800, 0, 800),
            (41, "Runner.Listener", 'S', 0, 700, 0, 700),
            (90, "sshd", 'S', 0, 999, -1000, 999),
            (120, "rustc", 'R', 0, 600, 0, 600),
            (121, "cc1plus", 'R', 0, 650, 0, 640),
            (122, "zombie (x)", 'Z', 0, 2000, 0, 0),
        ]);
        let victim = victim(root.path(), &[40, 41]).unwrap();
        assert_eq!(victim.name, "cc1plus");
        assert_eq!(victim.pid, 121);
        assert_eq!(victim.start, 1121);
        // Nothing left once the rest are kept too.
        assert_eq!(victim_except(&root, &[40, 41, 120, 121]), None);
    }

    fn victim_except(root: &Root, protected: &[i32]) -> Option<String> {
        victim(root.path(), protected).map(|victim| victim.name)
    }

    #[test]
    fn ties_go_to_the_larger_process() {
        let root = procfs(&[
            (10, "small", 'S', 0, 500, 0, 10),
            (11, "large", 'S', 0, 500, 0, 9000),
        ]);
        assert_eq!(victim_except(&root, &[]).as_deref(), Some("large"));
    }

    #[test]
    fn reads_names_with_parentheses_and_spaces() {
        let (name, state, flags, start) = parse_stat(
            "77 (tmux: server (1)) S 1 77 77 0 -1 4194560 0 0 0 0 1 2 0 0 20 0 1 0 5555 1000 300\n",
        )
        .unwrap();
        assert_eq!(name, "tmux: server (1)");
        assert_eq!(state, 'S');
        assert_eq!(flags, 4_194_560);
        assert_eq!(start, 5555);
    }

    #[test]
    fn counts_the_page_cache_as_in_use() {
        let memory =
            parse_meminfo("MemTotal: 4096 kB\nMemFree: 1024 kB\nCached: 2048 kB\n").unwrap();
        assert_eq!(memory.used(), 3 << 20);
        assert_eq!(parse_meminfo("MemTotal: 1 kB\n"), None);
    }
}
