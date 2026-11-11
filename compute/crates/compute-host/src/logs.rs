//! Keeps the logs VM processes write beside their sandbox bounded.
//!
//! A sandbox's directory holds the guest's serial console, its VMM's log
//! and its pager's (see [`crate::layout`]). The guest writes its console at
//! will, and none of those processes stops for the agent, so a guest that
//! prints without end would otherwise fill the host's disk. Every
//! [`EVERY`], the agent frees all but about the last [`KEEP`] bytes of each
//! longer log by punching a hole over its start: the file keeps its length
//! and every writer its position, so nothing written later is lost, and the
//! end of the log reads as before.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use compute_engine::CancellationToken;
use rustix::fs::{FallocateFlags, FileType, Mode, OFlags, Stat, fallocate, fstat, open};

/// The end of each log that is kept.
pub const KEEP: u64 = 1 << 20;
/// How often logs are trimmed. An emulated serial console carries a few
/// megabytes a second at most, so a log outgrows [`KEEP`] by about that
/// much at most before it is trimmed.
pub const EVERY: Duration = Duration::from_secs(2);
/// Holes are punched in whole blocks.
const BLOCK: u64 = 4096;

/// Trims the logs of every sandbox under `root` every [`EVERY`] until
/// `stop`.
pub async fn keep_trimmed(root: PathBuf, stop: CancellationToken) {
    let mut every = tokio::time::interval(EVERY);
    every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            () = stop.cancelled() => return,
            _ = every.tick() => {}
        }
        let root = root.clone();
        match tokio::task::spawn_blocking(move || trim_all(&root)).await {
            Ok(Ok(0)) => {}
            Ok(Ok(freed)) => tracing::debug!(freed, "trimmed sandbox logs"),
            Ok(Err(error)) => tracing::warn!(%error, "could not trim sandbox logs"),
            Err(error) => tracing::warn!(%error, "log trimming failed"),
        }
    }
}

/// Trims every `*.log` in each sandbox directory under `root`; returns the
/// bytes of disk freed. A log that cannot be trimmed is skipped.
pub fn trim_all(root: &Path) -> io::Result<u64> {
    let sandboxes = match fs::read_dir(crate::layout::sandboxes_dir(root)) {
        Ok(sandboxes) => sandboxes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    let mut freed = 0;
    for sandbox in sandboxes.flatten() {
        let Ok(files) = fs::read_dir(sandbox.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().is_none_or(|extension| extension != "log") {
                continue;
            }
            match trim(&path) {
                Ok(bytes) => freed += bytes,
                Err(error) => {
                    tracing::debug!(path = %path.display(), %error, "log not trimmed");
                }
            }
        }
    }
    Ok(freed)
}

/// Frees all but about the last [`KEEP`] bytes of the regular file at
/// `path` once it holds more than twice that; returns the bytes freed.
pub fn trim(path: &Path) -> io::Result<u64> {
    // Not following links, and not waiting on a pipe without a reader:
    // only a regular file is trimmed.
    let file = open(
        path,
        OFlags::WRONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let before = fstat(&file)?;
    if FileType::from_raw_mode(before.st_mode) != FileType::RegularFile {
        return Ok(0);
    }
    let was_held = held(&before);
    if was_held <= 2 * KEEP {
        return Ok(0);
    }
    let len = u64::try_from(before.st_size).unwrap_or(0);
    let head = len.saturating_sub(KEEP) / BLOCK * BLOCK;
    fallocate(
        &file,
        FallocateFlags::PUNCH_HOLE | FallocateFlags::KEEP_SIZE,
        0,
        head,
    )?;
    Ok(was_held.saturating_sub(held(&fstat(&file)?)))
}

/// The disk space a file takes.
fn held(stat: &Stat) -> u64 {
    u64::try_from(stat.st_blocks).unwrap_or(0) * 512
}

#[cfg(test)]
mod tests {
    use std::fs::OpenOptions;
    use std::io::{Read, Seek, SeekFrom, Write};

    use super::*;

    /// A log far past the limit keeps its length and its end, holds about
    /// [`KEEP`] bytes afterwards, and goes on growing at the end for the
    /// writer that kept it open.
    #[test]
    fn a_long_log_keeps_only_its_end_and_its_writer_carries_on() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("console.log");
        let mut writer = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .unwrap();
        let line: Vec<u8> = (0..=255u8).cycle().take(1000).collect();
        for _ in 0..8_000 {
            writer.write_all(&line).unwrap();
        }
        writer.sync_all().unwrap();
        let len = fs::metadata(&path).unwrap().len();
        let mut end_before = vec![0; usize::try_from(KEEP).unwrap()];
        read_end(&path, &mut end_before);

        let freed = trim(&path).unwrap();
        assert!(freed >= len - 2 * KEEP, "freed only {freed} of {len}");
        let stat = fstat(fs::File::open(&path).unwrap()).unwrap();
        assert!(held(&stat) <= KEEP + 2 * BLOCK, "holds {}", held(&stat));
        assert_eq!(fs::metadata(&path).unwrap().len(), len);
        let mut end_after = vec![0; end_before.len()];
        read_end(&path, &mut end_after);
        assert_eq!(end_after, end_before);

        writer.write_all(b"after\n").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), len + 6);
        assert_eq!(
            trim(&path).unwrap(),
            0,
            "a log just trimmed was trimmed again"
        );
    }

    #[test]
    fn short_logs_links_and_pipes_are_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let sandbox = crate::layout::sandboxes_dir(root).join("a");
        fs::create_dir_all(&sandbox).unwrap();
        let short = sandbox.join("vmm.log");
        fs::write(&short, vec![1; 4 * usize::try_from(KEEP).unwrap() / 3]).unwrap();
        let long = sandbox.join("console.log");
        fs::write(&long, vec![2; 4 * usize::try_from(KEEP).unwrap()]).unwrap();
        let elsewhere = root.join("elsewhere.log");
        fs::write(&elsewhere, vec![3; 4 * usize::try_from(KEEP).unwrap()]).unwrap();
        std::os::unix::fs::symlink(&elsewhere, sandbox.join("link.log")).unwrap();
        rustix::fs::mknodat(
            rustix::fs::CWD,
            sandbox.join("pipe.log"),
            FileType::Fifo,
            Mode::RUSR | Mode::WUSR,
            0,
        )
        .unwrap();
        let not_a_log = sandbox.join("disk.ext4");
        fs::write(&not_a_log, vec![4; 4 * usize::try_from(KEEP).unwrap()]).unwrap();
        let held_of = |path: &Path| held(&fstat(fs::File::open(path).unwrap()).unwrap());
        let untouched = [&short, &elsewhere, &not_a_log].map(|path| (path, held_of(path)));

        let freed = trim_all(root).unwrap();
        assert!(freed >= 2 * KEEP, "freed {freed}");
        assert!(held_of(&long) <= KEEP + 2 * BLOCK);
        for (path, before) in untouched {
            assert_eq!(held_of(path), before, "{} was trimmed", path.display());
        }
    }

    fn read_end(path: &Path, into: &mut [u8]) {
        let mut file = fs::File::open(path).unwrap();
        file.seek(SeekFrom::End(-i64::try_from(into.len()).unwrap()))
            .unwrap();
        file.read_exact(into).unwrap();
    }
}
