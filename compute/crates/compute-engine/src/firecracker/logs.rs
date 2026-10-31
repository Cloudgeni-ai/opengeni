//! A VM's logs: its guest's serial console, which is the VMM's standard
//! output, and the VMM's own log; and what the guest last wrote on its
//! console, and what the logs last said when the VM was lost.
//!
//! Firecracker on x86 gives a guest no way to power off, so Linux halts
//! instead, as it does for a halt: it stops its processors and its VM runs
//! on, never to end by itself. Just before it stops them, its kernel says
//! so on its console (`kernel_halt` in Linux's `kernel/reboot.c`). The
//! VMM's standard output is that console, kept in the VM's logs. The VMM
//! writes its own log there too, a line for each request the host makes
//! of it (such as its balloon's statistics, every few seconds), so after
//! a halt the guest's last line is followed by the VMM's.

use std::fs::{self, File};
use std::future::Future;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crate::LastWords;
use crate::error::{EngineError, ErrorKind};

/// The VMM's standard output in the VM's logs: its guest's serial console.
pub(super) const CONSOLE_LOG: &str = "console.log";

/// The VMM's own log file in the VM's logs: its standard error, and the
/// jailer's, where a panic goes.
const VMM_LOG: &str = "vmm.log";

/// The log of the pager serving a VM's memory, in the VM's logs: its
/// standard error.
pub(super) const PAGER_LOG: &str = "pager.log";

/// How much of the console's end is read for the guest's last line: some
/// minutes of the VMM's lines after it. The host trims long logs only from
/// their start.
const TAIL: u64 = 64 << 10;

/// How many of the guest's last lines [`last_words`] keeps: a kernel
/// panic's reason and the start of its trace.
const GUEST_LINES: usize = 40;

/// How many of the VMM's and the pager's last lines [`last_words`] keeps.
const OWN_LINES: usize = 20;

/// What Linux writes as its last words when it halts, alone on its line
/// or after the time printk stamps on it: for a halt, and for a power-off
/// it had no way to make.
const HALTED: [&str; 2] = [
    "reboot: System halted",
    "reboot: Power off not available: System halted instead",
];

/// Opens a launch's console and VMM log in the logs directory `dir`,
/// which it makes if it is missing, each a [`fresh`] file.
pub(super) fn open(dir: &Path) -> io::Result<(File, File)> {
    fs::create_dir_all(dir)?;
    Ok((fresh(&dir.join(CONSOLE_LOG))?, fresh(&dir.join(VMM_LOG))?))
}

/// A new, empty file at `path` for a launch's log. A new file rather than
/// the old one emptied: the host trims long logs from their start while
/// VMs run, and a trim measured on the old file must never punch out what
/// the new launch writes into the same file.
fn fresh(path: &Path) -> io::Result<File> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    File::options().write(true).create_new(true).open(path)
}

/// Whether VM `name`'s guest said it halted, on its console at `console`
/// (see [`says_halted`]). The file is read in a blocking task, never on
/// the caller's thread.
pub(super) fn halted(
    console: PathBuf,
    name: String,
) -> impl Future<Output = Result<bool, EngineError>> + Send + 'static {
    const OP: &str = "halted";
    async move {
        tokio::task::spawn_blocking(move || says_halted(&console, &name))
            .await
            .map_err(|error| EngineError::caused_by(ErrorKind::Transient, OP, error))?
            .map_err(|error| EngineError::io(OP, error))
    }
}

/// Whether the last line the guest of VM `name` wrote on the console kept
/// at `path` is its kernel saying it halted. Only the last, and only once
/// it is finished: a guest that wrote anything after, or is still writing
/// its line, is not halted. Reads at most [`TAIL`] bytes and the one
/// before them, which says whether their first line is whole.
fn says_halted(path: &Path, name: &str) -> io::Result<bool> {
    Ok(last_line_halted(&tail(path)?, name))
}

/// The end of the file at `path` from its first whole line in its last
/// [`TAIL`] bytes: reads at most those and the one before them, which
/// says whether their first line is whole (see [`whole_lines`]).
fn tail(path: &Path) -> io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    let start = length.saturating_sub(TAIL + 1);
    file.seek(SeekFrom::Start(start))?;
    let mut read = Vec::new();
    file.take(TAIL + 1).read_to_end(&mut read)?;
    Ok(whole_lines(&read, start).to_vec())
}

/// What VM `name`'s logs in `dir` last said (see
/// [`crate::Engine::last_words`]). The files are read in a blocking task,
/// never on the caller's thread.
pub(super) async fn last_words(dir: PathBuf, name: String) -> LastWords {
    tokio::task::spawn_blocking(move || read_last_words(&dir, &name))
        .await
        .unwrap_or_else(|error| LastWords {
            guest: format!("(not read: {error})"),
            ..LastWords::default()
        })
}

/// See [`last_words`]. The console holds the guest's lines and the VMM's
/// own; of the VMM's, its API server's only answer the host's requests,
/// such as its balloon's statistics every few seconds, so they are left
/// out. The VMM's log follows its lines on the console: a panic goes
/// there. A missing log says nothing: a VM without a pager has no pager
/// log.
fn read_last_words(dir: &Path, name: &str) -> LastWords {
    let read = |file: &str| match tail(&dir.join(file)) {
        Ok(text) => Ok(String::from_utf8_lossy(&text).into_owned()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(format!("({file} unreadable: {error})")),
    };
    let (guest, mut vmm) = match read(CONSOLE_LOG) {
        Ok(console) => {
            let (vmms, guests): (Vec<String>, Vec<String>) =
                lines(&console).partition(|line| vmm_wrote(line, name));
            let vmms = vmms.into_iter().filter(|line| !answers_host(line, name));
            (last(guests, GUEST_LINES), last(vmms, OWN_LINES))
        }
        Err(unreadable) => (unreadable, String::new()),
    };
    let log =
        read(VMM_LOG).map_or_else(|unreadable| unreadable, |log| last(lines(&log), OWN_LINES));
    if !log.is_empty() {
        if !vmm.is_empty() {
            vmm.push('\n');
        }
        vmm.push_str(&log);
    }
    let pager =
        read(PAGER_LOG).map_or_else(|unreadable| unreadable, |log| last(lines(&log), OWN_LINES));
    LastWords { guest, vmm, pager }
}

/// The lines of `text` that say something, as plain text: without the
/// serial console's carriage returns, terminal colours or other control
/// characters, nor the zeros a log trimmed from its start reads as.
fn lines(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split('\n')
        .map(plain)
        .filter(|line| !line.trim().is_empty())
}

/// `line` without terminal escapes (`ESC [ ... final`) or other control
/// characters but tabs, and without trailing blanks.
fn plain(line: &str) -> String {
    let mut kept = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(char) = chars.next() {
        if char == '\x1b' {
            if chars.peek() == Some(&'[') {
                chars.next();
                // Parameters and intermediates, up to the final byte.
                for char in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&char) {
                        break;
                    }
                }
            }
        } else if !char.is_control() || char == '\t' {
            kept.push(char);
        }
    }
    kept.truncate(kept.trim_end().len());
    kept
}

/// The last `count` of `lines`, one to a line.
fn last(lines: impl IntoIterator<Item = String>, count: usize) -> String {
    let lines: Vec<String> = lines.into_iter().collect();
    lines[lines.len().saturating_sub(count)..].join("\n")
}

/// Whether `line`, one of VM `name`'s VMM's (see [`vmm_wrote`]), is its
/// API server's, as in `... [<name>:fc_api] The API server received ...`.
fn answers_host(line: &str, name: &str) -> bool {
    line.split_once(' ').is_some_and(|(_, rest)| {
        rest.strip_prefix('[')
            .and_then(|rest| rest.strip_prefix(name))
            .and_then(|rest| rest.strip_prefix(":fc_api"))
            .is_some_and(|rest| rest.starts_with([']', ':']))
    })
}

/// What of `read`, read from `start` bytes into its file, begins with a
/// whole line: all of it from the file's start, else only what follows
/// its first newline. A read that begins inside a line has only its end,
/// and the end of a line that mentions the kernel's words can be them
/// exactly.
fn whole_lines(read: &[u8], start: u64) -> &[u8] {
    if start == 0 {
        return read;
    }
    read.iter()
        .position(|&byte| byte == b'\n')
        .map_or(&[], |newline| &read[newline + 1..])
}

/// Whether the last line in `tail` that is neither blank nor the VMM's is
/// the kernel's halt, ended by its newline. Text after the last newline is
/// a line not finished yet: unless it is blank or the VMM's, it is the
/// guest's last, and not a halt.
fn last_line_halted(tail: &[u8], name: &str) -> bool {
    let text = String::from_utf8_lossy(tail);
    let (finished, unfinished) = text.rsplit_once('\n').unwrap_or(("", &text));
    let guests = |line: &&str| !line.is_empty() && !vmm_wrote(line, name);
    if guests(&unfinished.trim_end()) {
        return false;
    }
    finished
        .split('\n')
        .map(str::trim_end)
        .rfind(guests)
        .is_some_and(kernel_halted)
}

/// Whether `line` is exactly the kernel's halt, after the printk time
/// (`[%5lu.%06lu] `) if it has one.
fn kernel_halted(line: &str) -> bool {
    let message = match line.strip_prefix('[') {
        Some(stamped) => match stamped.split_once("] ") {
            Some((time, message)) if printk_time(time) => message,
            _ => return false,
        },
        None => line,
    };
    HALTED.contains(&message)
}

/// Whether `time` is a printk time: seconds since boot, right-aligned in
/// at least five places, a point, and six digits of microseconds.
fn printk_time(time: &str) -> bool {
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    time.len() >= 12
        && time
            .trim_start_matches(' ')
            .split_once('.')
            .is_some_and(|(seconds, micros)| digits(seconds) && micros.len() == 6 && digits(micros))
}

/// Whether `line` is one of VM `name`'s VMM's own: when, then the VM and
/// what in the VMM wrote it, as in
/// `2026-10-26T17:10:44.801090024 [<name>:fc_api] The API server ...`.
fn vmm_wrote(line: &str, name: &str) -> bool {
    let Some((at, rest)) = line.split_once(' ') else {
        return false;
    };
    let dated = at.len() > 10
        && at.as_bytes()[..4].iter().all(u8::is_ascii_digit)
        && at.as_bytes()[4] == b'-'
        && at.contains('T');
    dated
        && rest
            .strip_prefix('[')
            .and_then(|rest| rest.strip_prefix(name))
            .is_some_and(|rest| rest.starts_with([':', ']']))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAME: &str = "01a1792e3b25748aa75de996ac0d454b";

    #[test]
    fn only_a_last_line_the_kernel_wrote_halting_says_halted() {
        let said = |text: &str| last_line_halted(text.as_bytes(), NAME);
        // As the kernel writes them, with and without timestamps, through
        // the serial console's line endings.
        assert!(said("[   41.071811] reboot: System halted\r\n"));
        assert!(said(
            "[    9.200000] reboot: Power off not available: System halted instead\r\n"
        ));
        assert!(said("[123456.000001] reboot: System halted\n"));
        assert!(said("booted\nreboot: System halted\n"));
        assert!(said("reboot: System halted\r\n\r\n\n"));
        // Anything after it, or nothing like it, is not a halt.
        assert!(!said("reboot: System halted\r\nstill here\r\n"));
        assert!(!said("reboot: System halted\r\nstill wri"));
        assert!(!said("reboot: Restarting system\r\n"));
        assert!(!said("reboot: System halted instead of what\r\n"));
        assert!(!said("[   41.071811] reboot: Power down\r\n"));
        assert!(!said(""));
        assert!(!said("\r\n"));
        // Only the kernel's line itself: one that mentions it, as a
        // diagnostic saying the opposite does, is not a halt.
        assert!(!said(
            "healthcheck: expected but did not observe reboot: System halted\r\n"
        ));
        assert!(!said("echo reboot: System halted\r\n"));
        assert!(!said("[app] reboot: System halted\r\n"));
        assert!(!said("[   41.07] reboot: System halted\r\n"));
        assert!(!said("[41.071811]reboot: System halted\r\n"));
        // Nor one not finished yet: the guest may still be writing it.
        assert!(!said("[   41.071811] reboot: System halted"));
        assert!(!said("reboot: System halted"));
        // Bytes that are not text do not hide the line after them.
        assert!(last_line_halted(b"\xff\xfe\nreboot: System halted\n", NAME));
    }

    #[test]
    fn the_vmms_own_lines_after_the_guests_are_skipped() {
        let said = |text: &str| last_line_halted(text.as_bytes(), NAME);
        let vmm = "2026-10-26T17:10:44.801090024 [01a1792e3b25748aa75de996ac0d454b:fc_api] \
                   The API server received a Get request on \"/balloon/statistics\".\n\
                   2026-10-26T17:10:44.801173711 [01a1792e3b25748aa75de996ac0d454b:fc_api] \
                   The request was executed successfully. Status code: 200 OK.\n";
        assert!(said(&format!(
            "[   41.071811] reboot: System halted\r\n{vmm}{vmm}"
        )));
        assert!(!said(&format!(
            "[   41.071811] reboot: System halted\r\n{vmm}up\r\n{vmm}"
        )));
        // The VMM's line it is still writing hides nothing; the guest's
        // does.
        let started = &vmm[..80];
        assert!(said(&format!(
            "[   41.071811] reboot: System halted\r\n{vmm}{started}"
        )));
        assert!(!said(&format!(
            "[   41.071811] reboot: System halted\r\n{vmm}up"
        )));
        // Only this VM's VMM's: another's, or a guest's line with no date,
        // is the guest's.
        let other = vmm.replace(NAME, "0000000000000000000000000000000b");
        assert!(!said(&format!("reboot: System halted\r\n{other}")));
        assert!(!said(&format!(
            "reboot: System halted\r\n[{NAME}:fc_api] up\r\n"
        )));
        // Nothing but the VMM's says nothing.
        assert!(!said(vmm));

        // The end of a staging guest's console after `poweroff -f`: its
        // programs' last lines, its kernel's, then the VMM's.
        let staging = format!(
            "\x1b[2m2026-10-26T17:12:17.923243Z\x1b[0m \x1b[32m INFO\x1b[0m nats event: \
             connected\r\n\
             [14999.591265] reboot: Power off not available: System halted instead\r\n\
             {vmm}"
        );
        assert!(said(&staging));
    }

    #[test]
    fn the_console_is_read_from_its_end() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONSOLE_LOG);
        assert!(
            says_halted(&path, NAME).is_err(),
            "a missing console says nothing"
        );

        let mut text = "x".repeat(3 * 65536);
        text.push_str("\n[   41.071811] reboot: System halted\r\n");
        std::fs::write(&path, &text).unwrap();
        assert!(says_halted(&path, NAME).unwrap());

        text.push_str(&"y".repeat(2 * 65536));
        std::fs::write(&path, &text).unwrap();
        assert!(!says_halted(&path, NAME).unwrap());

        std::fs::write(&path, "").unwrap();
        assert!(!says_halted(&path, NAME).unwrap());
    }

    /// A read of the console's end that begins inside a line drops that
    /// line: its end alone can be the kernel's words exactly.
    #[test]
    fn a_line_the_tail_cut_is_not_the_guests_last_words() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONSOLE_LOG);
        let halt = "reboot: System halted\n";
        // One of the VMM's lines, long enough that it and the halt words
        // fill the tail exactly.
        let dated = format!("2026-10-26T17:10:44.801090024 [{NAME}:fc_api] ");
        let pad = usize::try_from(TAIL).unwrap() - halt.len() - dated.len() - 1;
        let vmm = format!("{dated}{}\n", "p".repeat(pad));
        let with = |before: &str| {
            std::fs::write(&path, format!("booted\n{before}{halt}{vmm}")).unwrap();
            says_halted(&path, NAME).unwrap()
        };
        // The tail begins just after `observe `: the diagnostic's end is
        // the halt words, but the line is the diagnostic's.
        assert!(!with("healthcheck: expected but did not observe "));
        assert!(!last_line_halted(
            format!("booted\nhealthcheck: expected but did not observe {halt}{vmm}").as_bytes(),
            NAME
        ));
        // The tail begins at the line itself: the byte before it is the
        // newline that ends the line before, so the line is whole.
        assert!(with(""));
        // A file no longer than the tail is read whole.
        std::fs::write(&path, format!("{halt}{vmm}")).unwrap();
        assert!(says_halted(&path, NAME).unwrap());

        assert_eq!(whole_lines(b"cut\nwhole\n", 0), b"cut\nwhole\n");
        assert_eq!(whole_lines(b"cut\nwhole\n", 1), b"whole\n");
        assert_eq!(whole_lines(b"\nwhole\n", 1), b"whole\n");
        assert_eq!(whole_lines(b"no newline", 1), b"");
    }

    #[test]
    fn a_late_trim_of_the_last_log_spares_the_new_one() {
        use std::io::Write;
        use std::os::unix::fs::FileExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(VMM_LOG);
        fs::write(&path, vec![b'o'; 64 << 10]).unwrap();
        // The trimmer opens and measures the old log...
        let trimming = File::options().write(true).open(&path).unwrap();
        let measured = trimming.metadata().unwrap().len();
        // ...a new launch starts its log meanwhile...
        let mut launched = fresh(&path).unwrap();
        launched.write_all(b"new launch\n").unwrap();
        // ...and the trim lands on what it measured.
        let zeros = vec![0; usize::try_from(measured).unwrap()];
        trimming.write_all_at(&zeros, 0).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new launch\n");
    }

    #[test]
    fn a_launch_opens_both_logs_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        drop(open(&logs).unwrap());
        fs::write(logs.join(CONSOLE_LOG), "old console").unwrap();
        fs::write(logs.join(VMM_LOG), "old log").unwrap();
        drop(open(&logs).unwrap());
        assert_eq!(fs::read(logs.join(CONSOLE_LOG)).unwrap(), b"");
        assert_eq!(fs::read(logs.join(VMM_LOG)).unwrap(), b"");
    }

    #[test]
    fn last_words_keep_what_says_why_a_vm_was_lost() {
        use std::fmt::Write as _;

        let dir = tempfile::tempdir().unwrap();
        let api = format!(
            "2026-10-30T15:12:48.801090024 [{NAME}:fc_api] The API server received a Get \
             request on \"/balloon/statistics\".\n"
        );
        let mut console =
            String::from("\x1b[2m2026-10-30T15:10:00Z\x1b[0m \x1b[32m INFO\x1b[0m booted\r\n");
        for line in 0..60 {
            write!(console, "[  100.{line:06}] guest line {line}\r\n").unwrap();
            console.push_str(&api);
        }
        console.push_str("[  101.000000] Kernel panic - not syncing: Fatal exception\r\n");
        write!(
            console,
            "2026-10-30T15:12:49.000000000 [{NAME}:main] Vmm is stopping.\n{api}"
        )
        .unwrap();
        fs::write(dir.path().join(CONSOLE_LOG), console).unwrap();
        fs::write(
            dir.path().join(VMM_LOG),
            "thread 'fc_vcpu 0' panicked at src/vmm/src/vstate/vcpu.rs:1:1\n\0\0\n",
        )
        .unwrap();

        let words = read_last_words(dir.path(), NAME);
        let guest: Vec<&str> = words.guest.lines().collect();
        assert_eq!(guest.len(), GUEST_LINES, "{guest:?}");
        assert_eq!(guest[0], "[  100.000021] guest line 21");
        assert_eq!(
            guest.last(),
            Some(&"[  101.000000] Kernel panic - not syncing: Fatal exception")
        );
        // The VMM's own lines and its log, without its answers to the
        // host; and no pager, so nothing for it.
        assert_eq!(
            words.vmm,
            format!(
                "2026-10-30T15:12:49.000000000 [{NAME}:main] Vmm is stopping.\n\
                 thread 'fc_vcpu 0' panicked at src/vmm/src/vstate/vcpu.rs:1:1"
            )
        );
        assert_eq!(words.pager, "");

        // Colours and control characters go; what the guest wrote stays.
        fs::write(dir.path().join(CONSOLE_LOG), console_start()).unwrap();
        fs::write(dir.path().join(PAGER_LOG), "memory file gone\n").unwrap();
        let words = read_last_words(dir.path(), NAME);
        assert_eq!(words.guest, "2026-10-30T15:10:00Z  INFO booted");
        assert_eq!(words.pager, "memory file gone");
    }

    fn console_start() -> &'static str {
        "\x1b[2m2026-10-30T15:10:00Z\x1b[0m \x1b[32m INFO\x1b[0m booted\r\n\r\n"
    }

    #[test]
    fn last_words_say_what_could_not_be_read() {
        let dir = tempfile::tempdir().unwrap();
        // No logs at all: nothing to say.
        assert_eq!(read_last_words(dir.path(), NAME), LastWords::default());
        // A log that cannot be read says so in its place.
        fs::create_dir(dir.path().join(CONSOLE_LOG)).unwrap();
        let words = read_last_words(dir.path(), NAME);
        assert!(
            words.guest.starts_with("(console.log unreadable: "),
            "{words:?}"
        );
        assert_eq!(words.vmm, "");
    }

    #[test]
    fn only_the_api_servers_lines_answer_the_host() {
        let line = |module: &str| format!("2026-10-30T15:12:49.000000000 [{NAME}:{module}] x");
        assert!(answers_host(&line("fc_api"), NAME));
        assert!(answers_host(&line("fc_api:INFO"), NAME));
        assert!(!answers_host(&line("main"), NAME));
        assert!(!answers_host(&line("fc_vcpu 0"), NAME));
        assert!(!answers_host(&line("fc_api_more"), NAME));
        assert!(!answers_host(
            "2026-10-30T15:12:49.000000000 [other:fc_api] x",
            NAME
        ));
    }
}
