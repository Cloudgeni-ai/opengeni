//! What a guest last wrote to its serial console.
//!
//! Firecracker on x86 gives a guest no way to power off, so Linux halts
//! instead, as it does for a halt: it stops its processors and its VM runs
//! on, never to end by itself. Just before it stops them, its kernel says
//! so on its console (`kernel_halt` in Linux's `kernel/reboot.c`). The
//! VMM's standard output is that console, kept in the VM's logs. The VMM
//! writes its own log there too, a line for each request the host makes
//! of it (such as its balloon's statistics, every few seconds), so after
//! a halt the guest's last line is followed by the VMM's.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

/// The VMM's standard output in the VM's logs: its guest's serial console.
pub(super) const CONSOLE_LOG: &str = "console.log";

/// How much of the console's end is read for the guest's last line: some
/// minutes of the VMM's lines after it. The host trims long logs only from
/// their start.
const TAIL: u64 = 64 << 10;

/// What Linux writes as its last words when it halts, after a timestamp
/// if its messages carry one: for a halt, and for a power-off it had no
/// way to make.
const HALTED: [&str; 2] = [
    "reboot: System halted",
    "reboot: Power off not available: System halted instead",
];

/// Whether the last line the guest of VM `name` wrote on the console kept
/// at `path` is its kernel saying it halted. Only the last: a guest that
/// wrote anything after is not halted. Reads at most [`TAIL`] bytes.
pub(super) fn says_halted(path: &Path, name: &str) -> io::Result<bool> {
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(TAIL)))?;
    let mut tail = Vec::new();
    file.take(TAIL).read_to_end(&mut tail)?;
    Ok(last_line_halted(&tail, name))
}

/// Whether the last line in `tail` that is neither blank nor the VMM's is
/// a [`HALTED`] one.
fn last_line_halted(tail: &[u8], name: &str) -> bool {
    String::from_utf8_lossy(tail)
        .lines()
        .map(str::trim_end)
        .rfind(|line| !line.is_empty() && !vmm_wrote(line, name))
        .is_some_and(|line| HALTED.iter().any(|said| line.ends_with(said)))
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
            "[    9.2] reboot: Power off not available: System halted instead\r\n"
        ));
        assert!(said("booted\nreboot: System halted"));
        assert!(said("reboot: System halted\r\n\r\n\n"));
        // Anything after it, or nothing like it, is not a halt.
        assert!(!said("reboot: System halted\r\nstill here\r\n"));
        assert!(!said("reboot: Restarting system\r\n"));
        assert!(!said("reboot: System halted instead of what\r\n"));
        assert!(!said("[   41.07] reboot: Power down\r\n"));
        assert!(!said(""));
        assert!(!said("\r\n"));
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
            "[   41.07] reboot: System halted\r\n{vmm}{vmm}"
        )));
        assert!(!said(&format!(
            "[   41.07] reboot: System halted\r\n{vmm}up\r\n{vmm}"
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
}
