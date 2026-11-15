//! Repairing a sandbox's file system while no VM uses its disk.
//!
//! A guest's kernel records every ext4 error it meets in the file
//! system's superblock: the error state, a count, and the first and the
//! latest error's time, function and code. It cannot repair its own root
//! file system, which stays mounted while the guest runs, and with the
//! `continue` error behaviour it runs on with the damage. Only the host can
//! repair it, and only while no VM has the disk open: before a fresh boot.
//!
//! [`check`] reads the superblock, one kilobyte, and runs `e2fsck` only
//! when it records errors or fails its checksum, so a fresh boot of a
//! healthy disk costs one small read. `e2fsck` parses bytes the guest
//! controls, so it runs as the VM's own unprivileged user, on a
//! descriptor the host opened without following links, never as root.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::confined::{self, Owned};

/// Where an ext4 superblock starts on its device, and its length.
const SUPERBLOCK_AT: u64 = 1024;
const SUPERBLOCK_LEN: usize = 1024;

/// `s_magic` of an ext2, ext3 or ext4 superblock.
const MAGIC: u16 = 0xEF53;
/// `EXT2_ERROR_FS` in `s_state`: the kernel met an error.
const STATE_ERRORS: u16 = 0x0002;
/// `EXT4_FEATURE_RO_COMPAT_METADATA_CSUM`: the superblock has a checksum.
const METADATA_CSUM: u32 = 0x0400;
/// Where the superblock's checksum is: its last four bytes.
const CHECKSUM_AT: usize = 0x3FC;

/// How much of `e2fsck`'s output a [`Repair`] keeps, its passes left out.
const OUTPUT_KEPT: usize = 4096;

/// One error a superblock records.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Recorded {
    /// When, in seconds since the Unix epoch.
    pub unix_seconds: u64,
    /// The kernel function that met it, such as `ext4_lookup`.
    pub function: String,
    /// Its line in the kernel's source.
    pub line: u32,
    /// The error, such as `EFSCORRUPTED`.
    pub code: &'static str,
    /// The inode it concerned, or zero.
    pub inode: u32,
}

/// What an ext4 superblock says about the file system's health.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Superblock {
    /// The kernel marked the file system as having errors.
    pub has_errors: bool,
    /// How many errors the kernel met since the last full check.
    pub error_count: u32,
    /// The first of them.
    pub first: Option<Recorded>,
    /// The latest.
    pub last: Option<Recorded>,
    /// The superblock fails its own checksum.
    pub bad_checksum: bool,
}

impl Superblock {
    /// Reads `bytes`, the kilobyte from byte 1024 of a disk; `None` for
    /// anything but ext2, ext3 or ext4.
    #[must_use]
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < SUPERBLOCK_LEN {
            return None;
        }
        let le16 = |at: usize| u16::from_le_bytes([bytes[at], bytes[at + 1]]);
        let le32 = |at: usize| {
            u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
        };
        if le16(0x38) != MAGIC {
            return None;
        }
        let checksummed = le32(0x64) & METADATA_CSUM != 0;
        // ext4 keeps the raw CRC32C, without its final inversion.
        let bad_checksum =
            checksummed && !crc32c::crc32c(&bytes[..CHECKSUM_AT]) != le32(CHECKSUM_AT);
        let error_count = le32(0x194);
        let recorded = |time: usize, function: usize, line: usize, inode: usize, code: usize| {
            let seconds = le32(time);
            (seconds != 0).then(|| Recorded {
                unix_seconds: u64::from(seconds),
                function: name(&bytes[function..function + 32]),
                line: le32(line),
                code: error_code(bytes[code]),
                inode: le32(inode),
            })
        };
        Some(Self {
            has_errors: le16(0x3A) & STATE_ERRORS != 0,
            error_count,
            first: recorded(0x198, 0x1A8, 0x1C8, 0x19C, 0x27A),
            last: recorded(0x1CC, 0x1E0, 0x1D4, 0x1D0, 0x27B),
            bad_checksum,
        })
    }

    /// Whether the file system needs `e2fsck` before it is mounted again.
    /// A superblock that only says it was not unmounted cleanly does not:
    /// the kernel replays its journal as it mounts.
    #[must_use]
    pub fn needs_repair(&self) -> bool {
        self.has_errors || self.error_count > 0 || self.bad_checksum
    }
}

/// A function name as the kernel writes it: up to 32 bytes, NUL padded.
fn name(bytes: &[u8]) -> String {
    let end = bytes
        .iter()
        .position(|&byte| byte == 0)
        .unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

/// The name of an ext4 error code, as `dumpe2fs` prints it.
fn error_code(code: u8) -> &'static str {
    const NAMES: [&str; 17] = [
        "UNKNOWN",
        "EIO",
        "ENOMEM",
        "EFSBADCRC",
        "EFSCORRUPTED",
        "ENOSPC",
        "ENOKEY",
        "EROFS",
        "EFBIG",
        "EEXIST",
        "ERANGE",
        "EOVERFLOW",
        "EBUSY",
        "ENOTDIR",
        "ENOTEMPTY",
        "ESHUTDOWN",
        "EFAULT",
    ];
    NAMES.get(usize::from(code)).copied().unwrap_or("UNKNOWN")
}

/// What a repair did.
#[derive(Clone, Debug)]
pub struct Repair {
    /// The superblock before it.
    pub before: Superblock,
    /// The superblock after it, if it could be read.
    pub after: Option<Superblock>,
    /// `e2fsck`'s exit status: 0 for nothing found, 1 for errors fixed,
    /// 4 and above for errors left or a failure; `None` if it was killed.
    pub exit: Option<i32>,
    /// How many problems it fixed: the questions it answered yes to.
    pub fixes: u64,
    /// What it said, without its pass headings, cut to a few kilobytes.
    pub output: String,
    /// How long it ran.
    pub took: Duration,
}

impl Repair {
    /// Whether the file system is healthy now.
    #[must_use]
    pub fn repaired(&self) -> bool {
        matches!(self.exit, Some(0..=3))
            && self
                .after
                .as_ref()
                .is_some_and(|after| !after.needs_repair())
    }
}

/// Reads the superblock of the disk at `path` in a VM's jail, and repairs
/// its file system with `e2fsck` if it records errors. `None` when there
/// was nothing to repair, or the disk holds no ext4 file system.
///
/// No VM may have the disk open. The disk is handed to `uid`/`gid`, the
/// VM's user, as a launch would hand it over, and `e2fsck` runs as that
/// user on a descriptor opened without following links: it parses bytes
/// the guest wrote, so it gets no more than the VM's own user has.
///
/// # Errors
///
/// The disk cannot be read or handed over, or `e2fsck` cannot be run.
pub fn check(path: &Path, uid: u32, gid: u32) -> io::Result<Option<Repair>> {
    let disk = open(path, false)?;
    let Some(before) = superblock(&disk)? else {
        return Ok(None);
    };
    if !before.needs_repair() {
        return Ok(None);
    }
    confined::hand_over(path, Owned::File, uid, gid)?;
    let disk = open(path, true)?;
    if disk.metadata()?.uid() != uid {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{} changed hands before its repair", path.display()),
        ));
    }
    let started = Instant::now();
    // The disk is the child's standard input; it opens it again through
    // that descriptor, so its own permissions decide.
    let ran = Command::new("e2fsck")
        .args(["-f", "-y", "/proc/self/fd/0"])
        // Nothing of the host agent's environment, which may hold its
        // credentials, but where to find the program.
        .env_clear()
        .envs(std::env::var_os("PATH").map(|path| ("PATH", path)))
        .env("LC_ALL", "C")
        .uid(uid)
        .gid(gid)
        .stdin(Stdio::from(disk.try_clone()?))
        .output()?;
    let took = started.elapsed();
    let said = format!(
        "{}{}",
        String::from_utf8_lossy(&ran.stdout),
        String::from_utf8_lossy(&ran.stderr)
    );
    Ok(Some(Repair {
        before,
        after: superblock(&disk).ok().flatten(),
        exit: ran.status.code(),
        fixes: said
            .lines()
            .filter(|line| line.trim_end().ends_with("? yes"))
            .count() as u64,
        output: kept(&said),
        took,
    }))
}

/// Opens a disk in a VM's jail without following a link, and checks that
/// it is a regular file with no other name.
fn open(path: &Path, write: bool) -> io::Result<File> {
    let flags = rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK;
    let file = OpenOptions::new()
        .read(true)
        .write(write)
        .custom_flags(flags.bits().cast_signed())
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() || metadata.nlink() != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{} is not a regular file of its own", path.display()),
        ));
    }
    Ok(file)
}

/// The superblock of `disk`, or `None` if it holds no ext4 file system.
fn superblock(disk: &File) -> io::Result<Option<Superblock>> {
    let mut bytes = [0; SUPERBLOCK_LEN];
    match disk.read_exact_at(&mut bytes, SUPERBLOCK_AT) {
        Ok(()) => Ok(Superblock::parse(&bytes)),
        // Shorter than a superblock: no file system at all.
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => Ok(None),
        Err(error) => Err(error),
    }
}

/// `e2fsck`'s output without its pass headings, cut to [`OUTPUT_KEPT`].
fn kept(said: &str) -> String {
    let mut kept = String::new();
    for line in said.lines() {
        if line.starts_with("Pass ") || line.trim().is_empty() {
            continue;
        }
        if kept.len() + line.len() + 1 > OUTPUT_KEPT {
            kept.push('…');
            break;
        }
        kept.push_str(line);
        kept.push('\n');
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh ext4 image of `bytes` at `path`, or `None` without
    /// e2fsprogs.
    pub(crate) fn make_ext4(path: &Path, bytes: u64) -> Option<()> {
        File::create(path).unwrap().set_len(bytes).unwrap();
        let made = Command::new("mkfs.ext4")
            .args(["-q", "-F"])
            .arg(path)
            .status()
            .ok()?;
        made.success().then_some(())
    }

    fn debugfs(path: &Path, request: &str) {
        let ran = Command::new("debugfs")
            .args(["-w", "-R", request])
            .arg(path)
            .output()
            .unwrap();
        assert!(ran.status.success(), "debugfs {request}: {ran:?}");
    }

    fn read(path: &Path) -> Superblock {
        superblock(&File::open(path).unwrap()).unwrap().unwrap()
    }

    #[test]
    fn reads_what_a_superblock_records_of_its_errors() {
        let dir = tempfile::tempdir().unwrap();
        let disk = dir.path().join("disk.ext4");
        if make_ext4(&disk, 64 << 20).is_none() {
            eprintln!("skipped: no mkfs.ext4");
            return;
        }
        let clean = read(&disk);
        assert!(!clean.needs_repair(), "{clean:?}");
        assert_eq!((clean.error_count, clean.first.clone()), (0, None));

        for request in [
            "ssv state 3",
            "ssv error_count 12228",
            "ssv first_error_time 20261106000914",
            "ssv first_error_func ext4_orphan_get",
            "ssv first_error_line 1427",
            "ssv first_error_ino 99",
            "ssv last_error_time 20261113182733",
            "ssv last_error_func ext4_lookup",
            "ssv last_error_line 1791",
        ] {
            debugfs(&disk, request);
        }
        let damaged = read(&disk);
        assert!(damaged.needs_repair());
        assert!(damaged.has_errors && !damaged.bad_checksum, "{damaged:?}");
        assert_eq!(damaged.error_count, 12228);
        let first = damaged.first.unwrap();
        assert_eq!(first.function, "ext4_orphan_get");
        assert_eq!((first.line, first.inode), (1427, 99));
        let last = damaged.last.unwrap();
        assert_eq!((last.function.as_str(), last.line), ("ext4_lookup", 1791));
        assert!(last.unix_seconds > first.unix_seconds);
    }

    #[test]
    fn names_error_codes_and_finds_a_bad_checksum() {
        let dir = tempfile::tempdir().unwrap();
        let disk = dir.path().join("disk.ext4");
        if make_ext4(&disk, 64 << 20).is_none() {
            eprintln!("skipped: no mkfs.ext4");
            return;
        }
        let mut bytes = [0; SUPERBLOCK_LEN];
        File::open(&disk)
            .unwrap()
            .read_exact_at(&mut bytes, SUPERBLOCK_AT)
            .unwrap();
        // A first error with its code, and the checksum left as it was.
        bytes[0x198..0x19C].copy_from_slice(&1_794_000_000_u32.to_le_bytes());
        bytes[0x27A] = 4;
        let found = Superblock::parse(&bytes).unwrap();
        assert_eq!(found.first.as_ref().unwrap().code, "EFSCORRUPTED");
        assert!(found.bad_checksum && found.needs_repair());

        bytes[0x38] = 0;
        assert_eq!(Superblock::parse(&bytes), None, "not ext4");
    }

    #[test]
    fn a_disk_without_errors_is_left_alone_and_one_with_errors_is_repaired() {
        let dir = tempfile::tempdir().unwrap();
        let disk = dir.path().join("disk.ext4");
        if make_ext4(&disk, 64 << 20).is_none() {
            eprintln!("skipped: no mkfs.ext4");
            return;
        }
        let (uid, gid) = (
            rustix::process::geteuid().as_raw(),
            rustix::process::getegid().as_raw(),
        );
        let modified = || disk.metadata().unwrap().modified().unwrap();
        let before = modified();
        assert!(check(&disk, uid, gid).unwrap().is_none());
        assert_eq!(modified(), before, "a healthy disk was written");

        // A directory entry naming a deleted inode, as lost writes leave
        // one, which the kernel recorded meeting.
        debugfs(&disk, "mkdir lost");
        debugfs(&disk, "write /dev/null lost/file");
        debugfs(&disk, "clri lost/file");
        debugfs(&disk, "ssv state 3");
        debugfs(&disk, "ssv error_count 3");
        debugfs(&disk, "ssv last_error_time 20261113182733");
        debugfs(&disk, "ssv last_error_func ext4_lookup");

        let repair = check(&disk, uid, gid).unwrap().expect("no repair");
        assert_eq!(repair.before.error_count, 3);
        assert!(repair.repaired(), "{repair:?}");
        assert!(repair.fixes > 0, "{repair:?}");
        assert_eq!(repair.exit, Some(1), "{repair:?}");
        let after = read(&disk);
        assert!(!after.needs_repair(), "{after:?}");
        assert_eq!((after.error_count, after.last), (0, None));
        assert!(check(&disk, uid, gid).unwrap().is_none(), "checked again");
    }

    #[test]
    fn a_linked_disk_is_never_repaired() {
        let dir = tempfile::tempdir().unwrap();
        let disk = dir.path().join("elsewhere.ext4");
        if make_ext4(&disk, 64 << 20).is_none() {
            eprintln!("skipped: no mkfs.ext4");
            return;
        }
        debugfs(&disk, "ssv state 3");
        let link = dir.path().join("disk.ext4");
        std::os::unix::fs::symlink(&disk, &link).unwrap();
        let (uid, gid) = (
            rustix::process::geteuid().as_raw(),
            rustix::process::getegid().as_raw(),
        );
        assert!(check(&link, uid, gid).is_err());
        assert!(read(&disk).needs_repair(), "the linked file was repaired");
    }
}
