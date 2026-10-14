//! The service agent's persistent, size-bounded log.
//!
//! A service manager is not a reliable log sink on every platform: a macOS
//! LaunchAgent without `StandardErrorPath` discards everything, and a crash
//! leaves nothing to diagnose. The long-running agent therefore also writes its
//! own log under `<config>/logs/`, rotated by size so it never grows without
//! bound. Logging must never take the agent down, so every I/O failure here is
//! swallowed: a lost line is better than a lost agent.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use tracing_subscriber::fmt::MakeWriter;

/// The directory beneath the agent config directory that holds its logs.
pub const LOG_DIRECTORY: &str = "logs";
/// The agent's own rotating log.
pub const AGENT_LOG: &str = "agent.log";
/// The raw stderr capture a service manager writes for the agent (macOS
/// LaunchAgent `StandardErrorPath`). Rust panics after an abort, allocator
/// failures and other output that bypasses `tracing` land here.
pub const AGENT_STDERR_LOG: &str = "agent.stderr.log";
/// Rotate the agent log once it would exceed this size.
pub const MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;
/// Rotated generations kept beside the live file (`.1` newest).
pub const KEPT_GENERATIONS: usize = 2;

/// Returns the log directory for an agent config directory.
#[must_use]
pub fn log_directory(config_dir: &Path) -> PathBuf {
    config_dir.join(LOG_DIRECTORY)
}

/// A size-capped log file shared by every `tracing` event of the process.
#[derive(Debug)]
pub struct RotatingLogFile {
    path: PathBuf,
    max_bytes: u64,
    state: Mutex<State>,
}

#[derive(Debug)]
struct State {
    file: Option<File>,
    size: u64,
}

impl RotatingLogFile {
    /// Opens (appending to) `<directory>/<name>`, creating an owner-only
    /// directory and file.
    ///
    /// # Errors
    ///
    /// Returns the I/O error when the directory or file cannot be opened.
    pub fn open(directory: &Path, name: &str, max_bytes: u64) -> io::Result<Self> {
        create_private_directory(directory)?;
        let path = directory.join(name);
        let file = open_append(&path)?;
        let size = file.metadata()?.len();
        Ok(Self {
            path,
            max_bytes: max_bytes.max(1),
            state: Mutex::new(State {
                file: Some(file),
                size,
            }),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        // A panic while logging must not disable logging for the panic hook.
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn write_record(&self, record: &[u8]) {
        let mut state = self.lock();
        if state.size > 0 && state.size.saturating_add(record.len() as u64) > self.max_bytes {
            state.file = None;
            rotate(&self.path);
            state.size = 0;
        }
        if state.file.is_none() {
            state.file = open_append(&self.path).ok();
            state.size = state
                .file
                .as_ref()
                .and_then(|file| file.metadata().ok())
                .map_or(0, |metadata| metadata.len());
        }
        if let Some(file) = state.file.as_mut() {
            if file.write_all(record).is_ok() {
                state.size = state.size.saturating_add(record.len() as u64);
            } else {
                // Reopen on the next record (for example after the file was
                // removed by hand); never surface the error to the agent.
                state.file = None;
            }
        }
    }
}

/// One formatted `tracing` event. The fmt layer formats a whole event into a
/// buffer and writes it at once; buffering here keeps an event in one file even
/// if a writer ever splits it.
#[derive(Debug)]
pub struct RecordWriter<'a> {
    log: &'a RotatingLogFile,
    buffer: Vec<u8>,
}

impl Write for RecordWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.buffer.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for RecordWriter<'_> {
    fn drop(&mut self) {
        if !self.buffer.is_empty() {
            self.log.write_record(&self.buffer);
        }
    }
}

impl<'a> MakeWriter<'a> for RotatingLogFile {
    type Writer = RecordWriter<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        RecordWriter {
            log: self,
            buffer: Vec::new(),
        }
    }
}

/// Bounds a file that another process keeps open for appending (the service
/// manager's stderr capture). It cannot be renamed away, so once it exceeds
/// `max_bytes` its contents move to `<name>.1` and it is truncated in place.
pub fn bound_appended_file(path: &Path, max_bytes: u64) {
    let Ok(metadata) = std::fs::metadata(path) else {
        return;
    };
    if metadata.len() <= max_bytes {
        return;
    }
    let previous = generation_path(path, 1);
    if std::fs::copy(path, &previous).is_ok() {
        if let Ok(file) = OpenOptions::new().write(true).open(path) {
            let _ = file.set_len(0);
        }
    }
}

fn rotate(path: &Path) {
    for generation in (1..KEPT_GENERATIONS).rev() {
        let _ = std::fs::rename(
            generation_path(path, generation),
            generation_path(path, generation + 1),
        );
    }
    let _ = std::fs::rename(path, generation_path(path, 1));
}

fn generation_path(path: &Path, generation: usize) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{generation}"));
    path.with_file_name(name)
}

/// Creates `directory` (and parents) restricted to the owner on Unix.
///
/// # Errors
///
/// Returns the I/O error when it cannot be created or restricted.
pub fn create_private_directory(directory: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(directory)?;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(directory)
    }
}

fn open_append(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(log: &RotatingLogFile, line: &str) {
        let mut writer = log.make_writer();
        writer.write_all(line.as_bytes()).unwrap();
    }

    #[test]
    fn rotates_by_size_and_keeps_bounded_generations() {
        let directory = tempfile::tempdir().unwrap();
        let logs = directory.path().join("logs");
        let log = RotatingLogFile::open(&logs, AGENT_LOG, 100).unwrap();
        for index in 0..12 {
            write(&log, &format!("record {index:02} {}\n", "x".repeat(30)));
        }
        let live = std::fs::read_to_string(logs.join("agent.log")).unwrap();
        let first = std::fs::read_to_string(logs.join("agent.log.1")).unwrap();
        let second = std::fs::read_to_string(logs.join("agent.log.2")).unwrap();
        assert!(!logs.join("agent.log.3").exists());
        // Each 41-byte record is whole in exactly one file; 2 fit under 100 bytes.
        assert_eq!(live.lines().count(), 2);
        assert!(live.contains("record 10") && live.contains("record 11"));
        assert!(first.contains("record 08") && first.contains("record 09"));
        assert!(second.contains("record 06") && second.contains("record 07"));
        for content in [&live, &first, &second] {
            assert!(content.len() as u64 <= 100);
        }
    }

    #[test]
    fn appends_across_reopen_and_survives_external_removal() {
        let directory = tempfile::tempdir().unwrap();
        let log = RotatingLogFile::open(directory.path(), AGENT_LOG, 1_000).unwrap();
        write(&log, "before restart\n");
        drop(log);
        let log = RotatingLogFile::open(directory.path(), AGENT_LOG, 1_000).unwrap();
        let path = directory.path().join(AGENT_LOG);
        write(&log, "after restart\n");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "before restart\nafter restart\n"
        );
        // A deleted file is recreated on rotation instead of logging into the void.
        std::fs::remove_file(&path).unwrap();
        write(&log, "y".repeat(990).as_str());
        write(&log, "after removal\n");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "after removal\n");
    }

    #[cfg(unix)]
    #[test]
    fn log_directory_and_file_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let logs = directory.path().join("logs");
        let log = RotatingLogFile::open(&logs, AGENT_LOG, 1_000).unwrap();
        write(&log, "line\n");
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&logs), 0o700);
        assert_eq!(mode(&logs.join(AGENT_LOG)), 0o600);
    }

    #[test]
    fn bounds_an_externally_appended_file_in_place() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(AGENT_STDERR_LOG);
        let mut holder = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .unwrap();
        holder.write_all(&[b'a'; 64]).unwrap();
        bound_appended_file(&path, 100);
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 64);
        holder.write_all(&[b'b'; 64]).unwrap();
        bound_appended_file(&path, 100);
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 0);
        assert_eq!(
            std::fs::metadata(directory.path().join("agent.stderr.log.1"))
                .unwrap()
                .len(),
            128
        );
        // The holder's append-mode descriptor keeps writing at the new end.
        holder.write_all(b"after\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "after\n");
    }
}
