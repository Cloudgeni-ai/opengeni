//! How much a guest's disk may still take of the host's local disk while
//! its VM runs.
//!
//! A guest disk is a file of fixed length. Where files cannot share
//! extents, as on ext4, the most it can take is its length, widened to the
//! filesystem's allocation unit, plus the blocks that map it: what it has
//! allocated already is all it can no longer take. Where files can share
//! extents, as on XFS or btrfs, a disk copied from the base image or a
//! template shares their blocks, and a guest write to a shared block takes
//! a new one: only blocks the disk holds alone are written in place.
//! Btrfs writes every change to new blocks, and frees the old ones only
//! once nothing in their whole extent is still used, and it stores
//! compressed extents in fewer blocks than they hold: there no block a
//! disk holds bounds what it may still take, and its whole bound stays
//! booked.

use std::io;
use std::path::Path;

/// The most a disk file of `length` bytes can take on a filesystem that
/// allocates `unit` bytes at a time: every unit of it, and the blocks
/// that map them. Ext4 maps up to 340 blocks of 4 KiB with each 4 KiB
/// block of its extent tree, XFS more, so 1/256 of the length bounds the
/// map of even a disk written one block apart.
pub(crate) fn disk_bound(length: u64, unit: u64) -> u64 {
    length
        .next_multiple_of(unit.max(1))
        .saturating_add(length / 256)
}

/// A disk length longer than any filesystem holds, for a disk whose length
/// cannot be read: what it books leaves no room to admit anything else.
pub(crate) const UNKNOWN_DISK: u64 = u64::MAX / 4;

/// The length of the disk file at `path` that a VM this agent does not
/// manage may still write to, and [`UNKNOWN_DISK`] when it cannot be read.
/// A missing file is 0 only when `may_be_open` is false, since no VM can
/// have it open; otherwise a VM may still write to it through a descriptor
/// it held when the file was unlinked, so its length is unknown.
pub(crate) fn retained_disk_len(path: &Path, may_be_open: bool) -> u64 {
    match std::fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == io::ErrorKind::NotFound && !may_be_open => 0,
        Err(_) => UNKNOWN_DISK,
    }
}

/// What the disk file at `path` may still take as its guest writes to it:
/// its [`disk_bound`] less what it holds alone. `shares` says whether the
/// filesystem shares extents between files (see
/// [`crate::layout::shares_extents`]): then only blocks no other file
/// holds count, otherwise every allocated block does.
pub(crate) fn headroom(path: &Path, unit: u64, shares: bool) -> io::Result<u64> {
    use std::os::unix::fs::MetadataExt;

    let file = std::fs::File::open(path)?;
    let metadata = file.metadata()?;
    let held = if copies_every_write(&file)? {
        0
    } else if shares {
        unshared_bytes(&file, unit)?
    } else {
        metadata.blocks().saturating_mul(512)
    };
    Ok(disk_bound(metadata.len(), unit).saturating_sub(held))
}

/// Whether `file` is on a filesystem that writes every change to new
/// blocks: btrfs, unless told otherwise per file, which is not counted on.
#[cfg(target_os = "linux")]
fn copies_every_write(file: &std::fs::File) -> io::Result<bool> {
    const BTRFS_SUPER_MAGIC: i64 = 0x9123_683e;
    let found = rustix::fs::fstatfs(file)?;
    #[allow(
        clippy::useless_conversion,
        reason = "f_type's width differs by target"
    )]
    Ok(i64::from(found.f_type) == BTRFS_SUPER_MAGIC)
}

#[cfg(not(target_os = "linux"))]
fn copies_every_write(_: &std::fs::File) -> io::Result<bool> {
    Ok(false)
}

/// What a disk holds alone in `extents`, each its logical start, length
/// and FIEMAP flags, widened to whole allocation units of `unit` bytes.
/// Shared extents are another file's too, and an encoded (compressed)
/// extent takes fewer blocks than it holds, so neither bounds what writing
/// over it takes.
fn held_alone(extents: impl Iterator<Item = (u64, u64, u32)>, unit: u64) -> u64 {
    const ENCODED: u32 = 0x8;
    const SHARED: u32 = 0x2000;
    let unit = unit.max(1);
    extents
        .filter(|(_, _, flags)| flags & (SHARED | ENCODED) == 0)
        .fold(0_u64, |held, (logical, length, _)| {
            let end = logical.saturating_add(length);
            held.saturating_add(end.next_multiple_of(unit) - logical / unit * unit)
        })
}

/// The bytes `file` holds alone, as the kernel maps its extents
/// (`FS_IOC_FIEMAP`); see [`held_alone`]. Extents still waiting to be
/// written out count, since the filesystem already set space aside for
/// them.
#[cfg(target_os = "linux")]
fn unshared_bytes(file: &std::fs::File, unit: u64) -> io::Result<u64> {
    use rustix::ioctl::{Updater, ioctl, opcode};

    const EXTENTS: u32 = 256;
    const LAST: u32 = 0x1;
    const FIEMAP: rustix::ioctl::Opcode = opcode::read_write::<Header>(b'f', 11);

    /// `struct fiemap` of `linux/fiemap.h`, without its extents.
    #[repr(C)]
    #[derive(Default)]
    struct Header {
        start: u64,
        length: u64,
        flags: u32,
        mapped: u32,
        count: u32,
        reserved: u32,
    }
    /// `struct fiemap_extent`.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct Extent {
        logical: u64,
        physical: u64,
        length: u64,
        reserved64: [u64; 2],
        flags: u32,
        reserved: [u32; 3],
    }
    #[repr(C)]
    struct Map {
        header: Header,
        extents: [Extent; EXTENTS as usize],
    }

    let mut map = Box::new(Map {
        header: Header::default(),
        extents: [Extent::default(); EXTENTS as usize],
    });
    let mut held = 0_u64;
    let mut start = 0_u64;
    loop {
        map.header = Header {
            start,
            length: u64::MAX - start,
            count: EXTENTS,
            ..Header::default()
        };
        // SAFETY: `FIEMAP` is `FS_IOC_FIEMAP`, whose argument is a `struct
        // fiemap` followed by `count` extents, which `Map` lays out in C
        // order; the kernel writes at most `count` of them.
        unsafe { ioctl(file, Updater::<FIEMAP, Map>::new(&mut map)) }?;
        let mapped = map.header.mapped.min(EXTENTS) as usize;
        let Some(last) = map.extents[..mapped].last().copied() else {
            return Ok(held);
        };
        let extents = map.extents[..mapped]
            .iter()
            .map(|extent| (extent.logical, extent.length, extent.flags));
        held = held.saturating_add(held_alone(extents, unit));
        if last.flags & LAST != 0 {
            return Ok(held);
        }
        start = last.logical.saturating_add(last.length);
    }
}

/// [`unshared_bytes`] where extents cannot be mapped: every allocated
/// block, as if none were shared.
#[cfg(not(target_os = "linux"))]
fn unshared_bytes(file: &std::fs::File, _: u64) -> io::Result<u64> {
    use std::os::unix::fs::MetadataExt;

    Ok(file.metadata()?.blocks().saturating_mul(512))
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::FileExt;

    use super::*;

    const MIB: u64 = 1 << 20;

    #[test]
    fn a_disk_may_take_its_whole_length_and_its_map() {
        assert_eq!(disk_bound(256 * MIB, 4096), 257 * MIB);
        assert_eq!(disk_bound(MIB + 1, MIB), 2 * MIB + 4096);
    }

    /// Only extents a disk holds alone, stored as they are, bound what
    /// writing over them takes: a shared one is another file's too, and a
    /// compressed one takes fewer blocks than it holds.
    #[test]
    fn shared_and_compressed_extents_are_not_held_alone() {
        let plain = (0, 8 * MIB, 0);
        let shared = (8 * MIB, MIB, 0x2000);
        let compressed = (16 * MIB, 4 * MIB, 0x8);
        let last = (32 * MIB, 4096, 0x1);
        assert_eq!(
            held_alone([plain, shared, compressed, last].into_iter(), 4096),
            8 * MIB + 4096
        );
        // Widened to whole allocation units.
        assert_eq!(held_alone([(100, 10, 0)].into_iter(), 4096), 4096);
    }

    /// What a disk holds already it can no longer take, so its headroom
    /// shrinks as its guest writes.
    #[test]
    fn headroom_shrinks_by_what_the_disk_holds() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("disk.ext4");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(64 * MIB).unwrap();
        let empty = headroom(&path, 4096, false).unwrap();
        assert_eq!(empty, disk_bound(64 * MIB, 4096));
        file.write_all_at(&vec![7; 8 << 20], 0).unwrap();
        file.sync_all().unwrap();
        let written = headroom(&path, 4096, false).unwrap();
        assert!(
            (empty - 9 * MIB..=empty - 8 * MIB).contains(&written),
            "8 MiB written: {empty} -> {written}"
        );
        assert_eq!(
            headroom(&path, 4096, true).unwrap(),
            written,
            "nothing is shared"
        );
    }

    /// Where extents are shared, a copy takes nothing until its guest
    /// writes, and its headroom is then still all of its bound: each write
    /// to a shared block takes a new one.
    #[cfg(target_os = "linux")]
    #[test]
    fn shared_blocks_leave_the_whole_bound() {
        let dir = tempfile::tempdir().unwrap();
        if !crate::layout::shares_extents(dir.path()).unwrap() {
            eprintln!("skipped: the temporary directory cannot share extents");
            return;
        }
        let base = dir.path().join("base.ext4");
        let file = std::fs::File::create(&base).unwrap();
        file.write_all_at(&vec![7; 8 << 20], 0).unwrap();
        file.set_len(64 * MIB).unwrap();
        file.sync_all().unwrap();
        let copy = dir.path().join("copy.ext4");
        crate::layout::copy_sparse(&base, &copy).unwrap();
        let bound = disk_bound(64 * MIB, 4096);
        assert_eq!(headroom(&copy, 4096, true).unwrap(), bound);
        let copied = std::fs::OpenOptions::new().write(true).open(&copy).unwrap();
        copied.write_all_at(&vec![9; 1 << 20], 32 * MIB).unwrap();
        copied.sync_all().unwrap();
        assert_eq!(headroom(&copy, 4096, true).unwrap(), bound - MIB);
    }
}
