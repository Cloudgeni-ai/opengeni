//! Which of a paused VM's memory its guest gave back to the host.
//!
//! A guest reports the memory it frees through the balloon (free page
//! reporting), and Firecracker discards each reported range: the guest
//! reads zeros there from then on. Firecracker does not count a discard as
//! a change, so a diff snapshot leaves those pages out, and an image made
//! from it goes on holding what they held before they were freed. An image
//! of an idle sandbox then holds nearly every page it ever used.
//!
//! For memory mapped from an image file (a wake from a local image),
//! Firecracker discards by mapping fresh anonymous memory over the range,
//! so a discarded range is an anonymous mapping inside the file's mapping.
//! Such a mapping is private, so a page of it that is neither present nor
//! swapped out has never been written since the discard and reads as
//! zeros. Nothing else is: a page of the file's own mapping holds the
//! image's bytes or the guest's, and memory not mapped from the file
//! (a fresh boot, or a wake served by a pager) is left out, since only the
//! file's mapping says which image bytes an address holds.
//!
//! This runs while the VM is paused, after its snapshot, so the guest
//! cannot write meanwhile. Only the VMM's own devices can, and a page one
//! writes is present, so it is never counted. A range the VMM discards
//! after the snapshot was free in the guest's own state already: zeros are
//! what the guest expects of it.

use std::fs::File;
use std::future::Future;
use std::io;
use std::ops::Range;
use std::os::unix::fs::{FileExt as _, MetadataExt as _};
use std::path::Path;

use rustix::process::Pid;

use crate::{EngineError, ErrorKind};

/// A page the kernel has in memory.
const PRESENT: u64 = 1 << 63;

/// A page the kernel keeps elsewhere: in swap, compressed, being moved,
/// or a marker.
const SWAPPED: u64 = 1 << 62;

/// Pagemap entries read at once.
const ENTRIES_PER_READ: usize = 1 << 16;

/// [`freed`] for the VMM process `pid`, clipped to the image's length, off
/// the async runtime: the engine's
/// [`freed_memory`](crate::Engine::freed_memory).
pub(super) fn freed_memory(
    pid: Pid,
    memory: &Path,
) -> impl Future<Output = Result<Vec<Range<u64>>, EngineError>> + Send + 'static {
    const OP: &str = "freed_memory";
    let (pid, memory) = (pid.as_raw_nonzero().get(), memory.to_owned());
    async move {
        let found = tokio::task::spawn_blocking(move || {
            let image_len = std::fs::metadata(&memory)?.len();
            let mut ranges = freed(pid, &memory)?;
            // A mapping past the file's end reads no image bytes.
            ranges.retain_mut(|range| {
                range.end = range.end.min(image_len);
                range.start < range.end
            });
            Ok::<_, io::Error>(ranges)
        })
        .await
        .map_err(|error| EngineError::caused_by(ErrorKind::Transient, OP, error))?;
        found.map_err(|error| EngineError::io(OP, error))
    }
}

/// The ranges of the memory image at `memory`, as mapped by process `pid`,
/// that its guest gave back and that read as zeros now (see the module's
/// documentation): sorted, apart, and whole pages. Empty when the process
/// does not map that file.
fn freed(pid: i32, memory: &Path) -> io::Result<Vec<Range<u64>>> {
    let metadata = std::fs::metadata(memory)?;
    let file = Mapped {
        major: u64::from(rustix::fs::major(metadata.dev())),
        minor: u64::from(rustix::fs::minor(metadata.dev())),
        inode: metadata.ino(),
    };
    let maps = std::fs::read_to_string(format!("/proc/{pid}/maps"))?;
    let pagemap = File::open(format!("/proc/{pid}/pagemap"))?;
    let page = rustix::param::page_size() as u64;
    zeroed(&maps, &file, page, |start, entries| {
        read_entries(&pagemap, start, entries, page)
    })
}

/// The file whose mapping holds guest memory, as `/proc/<pid>/maps` names
/// it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Mapped {
    major: u64,
    minor: u64,
    inode: u64,
}

/// One line of `/proc/<pid>/maps`.
#[derive(Debug, PartialEq, Eq)]
struct Area<'a> {
    start: u64,
    end: u64,
    perms: &'a str,
    offset: u64,
    major: u64,
    minor: u64,
    inode: u64,
}

impl Area<'_> {
    fn maps(&self, file: &Mapped) -> bool {
        self.inode == file.inode && self.major == file.major && self.minor == file.minor
    }

    /// Memory nothing backs but the process's own pages: anonymous,
    /// private and writable, as a discard leaves it.
    fn anonymous(&self) -> bool {
        self.inode == 0 && self.major == 0 && self.minor == 0 && self.perms == "rw-p"
    }
}

fn parse(line: &str) -> Option<Area<'_>> {
    let mut fields = line.split_ascii_whitespace();
    let (start, end) = fields.next()?.split_once('-')?;
    let perms = fields.next()?;
    let offset = fields.next()?;
    let (major, minor) = fields.next()?.split_once(':')?;
    let inode = fields.next()?;
    Some(Area {
        start: u64::from_str_radix(start, 16).ok()?,
        end: u64::from_str_radix(end, 16).ok()?,
        perms,
        offset: u64::from_str_radix(offset, 16).ok()?,
        major: u64::from_str_radix(major, 16).ok()?,
        minor: u64::from_str_radix(minor, 16).ok()?,
        inode: inode.parse().ok()?,
    })
}

/// The image ranges that read as zeros, from the process's `maps` and its
/// pagemap entries, which `entries(start, count)` reads for `count` pages
/// from address `start`.
///
/// The file's mapping is one or more regions, each mapping a run of the
/// file at its own address: the parts of one region keep the same
/// distance between address and file offset. Between the first and last
/// part of a region, every address is the region's, so an anonymous
/// mapping there is a discarded range of it, at the region's distance. A
/// discard at a region's very start or end is not between two parts and is
/// left out: it goes on holding what it held.
fn zeroed(
    maps: &str,
    file: &Mapped,
    page: u64,
    mut entries: impl FnMut(u64, usize) -> io::Result<Vec<u64>>,
) -> io::Result<Vec<Range<u64>>> {
    let areas: Vec<Area<'_>> = maps.lines().filter_map(parse).collect();
    // Each region by the distance between its addresses and file offsets:
    // its first address, its last, and that distance.
    let mut regions: Vec<(u64, u64, u64)> = Vec::new();
    for area in areas.iter().filter(|area| area.maps(file)) {
        let Some(distance) = area.start.checked_sub(area.offset) else {
            continue;
        };
        match regions.iter_mut().find(|region| region.2 == distance) {
            Some(region) => {
                region.0 = region.0.min(area.start);
                region.1 = region.1.max(area.end);
            }
            None => regions.push((area.start, area.end, distance)),
        }
    }
    let mut zeros: Vec<Range<u64>> = Vec::new();
    for area in areas.iter().filter(|area| area.anonymous()) {
        let Some(&(_, _, distance)) = regions
            .iter()
            .find(|(first, last, _)| *first <= area.start && area.end <= *last)
        else {
            continue;
        };
        if !area.start.is_multiple_of(page) || !area.end.is_multiple_of(page) {
            continue;
        }
        let mut address = area.start;
        while address < area.end {
            let count = usize::try_from((area.end - address) / page)
                .unwrap_or(usize::MAX)
                .min(ENTRIES_PER_READ);
            let read = entries(address, count)?;
            if read.len() != count {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "pagemap ended early",
                ));
            }
            for (index, entry) in read.into_iter().enumerate() {
                if entry & (PRESENT | SWAPPED) != 0 {
                    continue;
                }
                let start = address + index as u64 * page - distance;
                match zeros.last_mut() {
                    Some(last) if last.end == start => last.end += page,
                    _ => zeros.push(start..start + page),
                }
            }
            address += count as u64 * page;
        }
    }
    zeros.sort_by_key(|range| range.start);
    let mut merged: Vec<Range<u64>> = Vec::with_capacity(zeros.len());
    for range in zeros {
        match merged.last_mut() {
            Some(last) if last.end >= range.start => last.end = last.end.max(range.end),
            _ => merged.push(range),
        }
    }
    Ok(merged)
}

/// `count` pagemap entries from address `start`.
fn read_entries(pagemap: &File, start: u64, count: usize, page: u64) -> io::Result<Vec<u64>> {
    let mut bytes = vec![0_u8; count * 8];
    pagemap.read_exact_at(&mut bytes, start / page * 8)?;
    Ok(bytes
        .as_chunks::<8>()
        .0
        .iter()
        .map(|entry| u64::from_ne_bytes(*entry))
        .collect())
}

#[cfg(test)]
mod tests;
