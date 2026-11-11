//! The root file system's growth. A sandbox's disk may be longer than its
//! image's file system, from its create or from a later claim, and the
//! guest grows the file system to fill it: at boot, and whenever the kernel
//! says a disk changed length, as it does once the host tells a running or
//! restored guest.
//!
//! ext4 zeroes the inode tables of every block group it adds: a
//! sixty-fourth of the space added, which takes that much of the host's
//! disk too, where a hole takes none. It need not, since what a disk grew
//! by reads as zeroes already. So the root file system stays mounted with
//! `noinit_itable`, which keeps the kernel from zeroing them in the
//! background, and a resize runs without it, since with it a resize zeroes
//! them at once; the zeroing it would then queue is dropped as the option
//! comes back.
//!
//! A guest restored from memory, as a clone of a template or a claimed
//! ready sandbox, may find its disk longer than that memory knew. Its
//! kernel learns of it only once it handles the disk's change after the
//! resume, a moment after the host's restore notice may arrive, so the
//! notice says how long the disk is ([`grow_to`]): the guest waits for its
//! kernel to see that length and grows the file system before it answers,
//! and the sandbox is never used with less room than it asked for.

use std::fs::{self, File};
use std::io;
use std::os::unix::fs::{FileExt, MetadataExt};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use super::{log, spawn, sys};

/// Where an ext4 superblock starts on its device, and how much of it is
/// read.
const SUPERBLOCK_AT: u64 = 1024;
const SUPERBLOCK_LEN: usize = 1024;

/// `s_magic` of an ext2, ext3 or ext4 superblock.
const EXT4_MAGIC: u16 = 0xEF53;

/// `EXT4_FEATURE_INCOMPAT_64BIT`: block counts have a high half.
const INCOMPAT_64BIT: u32 = 0x80;

/// How long a restore notice waits for the kernel to see the disk as long
/// as the host says. The kernel handles the change within milliseconds of
/// the resume; this bounds a guest whose kernel never does, which then
/// grows its file system once it does, as it always has.
pub const LENGTH_WAIT: Duration = Duration::from_secs(5);

/// How often [`grow_to`] looks at the disk's length meanwhile.
const LENGTH_LOOK: Duration = Duration::from_millis(5);

/// Whether the guest keeps the root file system as large as its disk: set
/// once [`keep_root_grown`] has set it up.
static KEEPING: AtomicBool = AtomicBool::new(false);

/// The disk length the root file system was last grown to, or found to
/// fill, in bytes: a restore notice whose disk is no longer reads nothing
/// more of the disk.
static GROWN_TO: AtomicU64 = AtomicU64::new(0);

/// Held while the root file system is looked at and grown: the device
/// events and a restore notice may both ask at once.
static GROWING: Mutex<()> = Mutex::new(());

/// How large an ext4 file system is, as its superblock says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Ext4 {
    block_size: u64,
    blocks: u64,
}

impl Ext4 {
    /// Reads `superblock`, the 1 KiB from byte 1024 of a device; `None`
    /// for anything but ext2, ext3 or ext4.
    fn parse(superblock: &[u8]) -> Option<Self> {
        let le32 = |at: usize| {
            let bytes = superblock.get(at..at + 4)?.try_into().ok()?;
            Some(u32::from_le_bytes(bytes))
        };
        let magic = superblock.get(0x38..0x3A)?;
        if u16::from_le_bytes([magic[0], magic[1]]) != EXT4_MAGIC {
            return None;
        }
        // ext4 blocks are 1 KiB to 64 KiB.
        let log_block = le32(0x18)?;
        if log_block > 6 {
            return None;
        }
        let block_size = 1024_u64 << log_block;
        let high = if le32(0x60)? & INCOMPAT_64BIT == 0 {
            0
        } else {
            le32(0x150)?
        };
        Some(Self {
            block_size,
            blocks: (u64::from(high) << 32) | u64::from(le32(0x04)?),
        })
    }
}

/// Whether `event`, a device event as the kernel sends one, says a block
/// device changed length.
fn is_resize(event: &[u8]) -> bool {
    let has = |wanted: &[u8]| event.split(|byte| *byte == 0).any(|field| field == wanted);
    has(b"SUBSYSTEM=block") && has(b"RESIZE=1")
}

/// Keeps the root file system as large as its disk: it defers zeroing
/// inode tables (see the module's notes), grows the file system now if its
/// disk is longer, and again each time the kernel says a disk grew. A root
/// that is not ext4, or is read-only, is left as it is.
pub fn keep_root_grown() {
    match sys::root_read_only() {
        Ok(false) => {}
        Ok(true) => return,
        Err(error) => {
            log(&format!("disk: {error}"));
            return;
        }
    }
    if let Err(error) = sys::remount_root("noinit_itable") {
        log(&format!("disk: not growing / with its disk: {error}"));
        return;
    }
    // Taken before the first look, so a disk that grows in between is not
    // missed.
    let events = sys::DeviceEvents::open()
        .inspect_err(|error| log(&format!("disk: device events: {error}")));
    KEEPING.store(true, Ordering::Relaxed);
    report(grow_root());
    if let Ok(events) = events {
        spawn("disk", move || watch(&events));
    }
}

/// Grows the root file system to fill its disk, which the host says is
/// `length` bytes long, before a restore notice is answered: it waits up
/// to `within` for the kernel to see the disk that long (a whole disk; a
/// partition never is), then grows the file system if the disk grew since
/// it was last grown. Nothing if the guest does not keep the root grown
/// ([`keep_root_grown`]).
pub fn grow_to(length: u64, within: Duration) {
    if !KEEPING.load(Ordering::Relaxed) {
        return;
    }
    // The kernel counts a disk in sectors of 512 bytes.
    let wanted = length / 512 * 512;
    let until = Instant::now() + within;
    let seen = loop {
        match root_device() {
            Ok(device) if device.length >= wanted || !device.whole => break device.length,
            Ok(device) if Instant::now() >= until => {
                log(&format!(
                    "disk: the host made the disk {} MiB, the kernel still sees {} MiB",
                    wanted >> 20,
                    device.length >> 20
                ));
                break device.length;
            }
            Ok(_) => std::thread::sleep(LENGTH_LOOK),
            Err(error) => {
                log(&format!("disk: could not read its length: {error}"));
                return;
            }
        }
    };
    if seen > GROWN_TO.load(Ordering::Relaxed) {
        report(grow_root());
    }
}

/// Grows the root file system each time a disk changes length.
fn watch(events: &sys::DeviceEvents) {
    let mut buffer = vec![0; 8192];
    loop {
        match events.next(&mut buffer) {
            Ok(event) if is_resize(event) => report(grow_root()),
            Ok(_) => {}
            // Events came faster than they were read; one lost may have
            // been a resize.
            Err(error) if error.raw_os_error() == Some(libc::ENOBUFS) => report(grow_root()),
            Err(error) => {
                log(&format!("disk: device events: {error}"));
                return;
            }
        }
    }
}

fn report(grown: io::Result<Option<(u64, u64)>>) {
    match grown {
        Ok(Some((from, to))) => log(&format!(
            "disk: grew / from {} to {} MiB",
            from >> 20,
            to >> 20
        )),
        Ok(None) => {}
        Err(error) => log(&format!("disk: could not grow /: {error}")),
    }
}

/// Grows the root file system to fill its disk if the disk is longer, and
/// returns its length in bytes before and after.
fn grow_root() -> io::Result<Option<(u64, u64)>> {
    let _growing = GROWING.lock().unwrap_or_else(PoisonError::into_inner);
    let Device { length, node, .. } = root_device()?;
    let mut superblock = [0; SUPERBLOCK_LEN];
    File::open(node)?.read_exact_at(&mut superblock, SUPERBLOCK_AT)?;
    let Some(found) = Ext4::parse(&superblock) else {
        return Ok(None);
    };
    let blocks = length / found.block_size;
    if blocks <= found.blocks {
        GROWN_TO.fetch_max(length, Ordering::Relaxed);
        return Ok(None);
    }
    sys::remount_root("init_itable")?;
    let resized = sys::resize_file_system("/", blocks);
    let deferred = sys::remount_root("noinit_itable");
    resized?;
    deferred?;
    GROWN_TO.fetch_max(length, Ordering::Relaxed);
    Ok(Some((
        found.blocks * found.block_size,
        blocks * found.block_size,
    )))
}

/// The root file system's device.
struct Device {
    /// Its length in bytes.
    length: u64,
    /// Its node, such as `/dev/vda`.
    node: String,
    /// Whether it is a whole disk rather than a partition of one, whose
    /// length is never the disk's.
    whole: bool,
}

/// The root file system's device.
fn root_device() -> io::Result<Device> {
    let device = fs::metadata("/")?.dev();
    let sys = format!(
        "/sys/dev/block/{}:{}",
        libc::major(device),
        libc::minor(device)
    );
    let invalid = || io::Error::from(io::ErrorKind::InvalidData);
    let sectors: u64 = fs::read_to_string(format!("{sys}/size"))?
        .trim()
        .parse()
        .map_err(|_| invalid())?;
    let uevent = fs::read_to_string(format!("{sys}/uevent"))?;
    let name = uevent
        .lines()
        .find_map(|line| line.strip_prefix("DEVNAME="))
        .ok_or_else(invalid)?;
    Ok(Device {
        length: sectors.saturating_mul(512),
        node: format!("/dev/{name}"),
        whole: !Path::new(&format!("{sys}/partition")).exists(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn superblock(log_block: u32, low: u32, high: u32, wide: bool) -> Vec<u8> {
        let mut block = vec![0; SUPERBLOCK_LEN];
        block[0x04..0x08].copy_from_slice(&low.to_le_bytes());
        block[0x18..0x1C].copy_from_slice(&log_block.to_le_bytes());
        block[0x38..0x3A].copy_from_slice(&EXT4_MAGIC.to_le_bytes());
        let incompat: u32 = if wide { 0x242 | INCOMPAT_64BIT } else { 0x242 };
        block[0x60..0x64].copy_from_slice(&incompat.to_le_bytes());
        block[0x150..0x154].copy_from_slice(&high.to_le_bytes());
        block
    }

    #[test]
    fn reads_an_ext4_superblocks_size() {
        let found = Ext4::parse(&superblock(2, 755_186, 0, true)).unwrap();
        assert_eq!(
            found,
            Ext4 {
                block_size: 4096,
                blocks: 755_186
            }
        );
        let wide = Ext4::parse(&superblock(2, 5, 1, true)).unwrap();
        assert_eq!(wide.blocks, (1 << 32) + 5);
        // Without 64-bit counts the high half is not a count.
        let narrow = Ext4::parse(&superblock(0, 5, 1, false)).unwrap();
        assert_eq!((narrow.block_size, narrow.blocks), (1024, 5));
    }

    #[test]
    fn anything_but_ext4_is_left_alone() {
        let mut other = superblock(2, 5, 0, true);
        other[0x38] = 0;
        assert_eq!(Ext4::parse(&other), None);
        assert_eq!(Ext4::parse(&other[..0x40]), None);
        assert_eq!(Ext4::parse(&superblock(64, 5, 0, true)), None);
    }

    #[test]
    fn only_a_block_devices_resize_counts() {
        let resize = b"change@/devices/pci0000:00/virtio0/block/vda\0ACTION=change\0\
            DEVPATH=/devices/pci0000:00/virtio0/block/vda\0SUBSYSTEM=block\0RESIZE=1\0\
            DEVNAME=vda\0DEVTYPE=disk\0SEQNUM=1102\0";
        assert!(is_resize(resize));
        let other = b"change@/devices/virtual/net/lo\0ACTION=change\0SUBSYSTEM=net\0RESIZE=1\0";
        assert!(!is_resize(other));
        let added = b"add@/devices/virtual/block/loop0\0ACTION=add\0SUBSYSTEM=block\0";
        assert!(!is_resize(added));
    }
}
