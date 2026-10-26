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

use std::fs::{self, File};
use std::io;
use std::os::unix::fs::{FileExt, MetadataExt};

use super::{log, spawn, sys};

/// Where an ext4 superblock starts on its device, and how much of it is
/// read.
const SUPERBLOCK_AT: u64 = 1024;
const SUPERBLOCK_LEN: usize = 1024;

/// `s_magic` of an ext2, ext3 or ext4 superblock.
const EXT4_MAGIC: u16 = 0xEF53;

/// `EXT4_FEATURE_INCOMPAT_64BIT`: block counts have a high half.
const INCOMPAT_64BIT: u32 = 0x80;

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
    report(grow_root());
    if let Ok(events) = events {
        spawn("disk", move || watch(&events));
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
    let (length, node) = root_device()?;
    let mut superblock = [0; SUPERBLOCK_LEN];
    File::open(node)?.read_exact_at(&mut superblock, SUPERBLOCK_AT)?;
    let Some(found) = Ext4::parse(&superblock) else {
        return Ok(None);
    };
    let blocks = length / found.block_size;
    if blocks <= found.blocks {
        return Ok(None);
    }
    sys::remount_root("init_itable")?;
    let resized = sys::resize_file_system("/", blocks);
    let deferred = sys::remount_root("noinit_itable");
    resized?;
    deferred?;
    Ok(Some((
        found.blocks * found.block_size,
        blocks * found.block_size,
    )))
}

/// The root file system's device: its length in bytes, and its node.
fn root_device() -> io::Result<(u64, String)> {
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
    Ok((sectors.saturating_mul(512), format!("/dev/{name}")))
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
