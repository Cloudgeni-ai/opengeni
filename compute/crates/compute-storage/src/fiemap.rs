//! FIEMAP candidate filtering for immutable same-filesystem reflink snapshots.
//!
//! Extent addresses are local hints, NEVER portable identifiers. Both files must
//! remain immutable and open throughout comparison. Unsupported extent flags
//! conservatively require reading the bytes. Hole transitions are dirty too.
use std::{
    collections::BTreeSet,
    fs::File,
    ops::Range,
    os::{fd::AsRawFd, unix::fs::MetadataExt},
};

use crate::{Error, Result};

const BATCH: usize = 256;
const FS_IOC_FIEMAP: libc::c_ulong = 0xc020_660b;
const LAST: u32 = 1;
const SHARED: u32 = 0x2000;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct RawExtent {
    logical: u64,
    physical: u64,
    length: u64,
    reserved64: [u64; 2],
    flags: u32,
    reserved: [u32; 3],
}

#[repr(C)]
struct Request {
    start: u64,
    length: u64,
    flags: u32,
    mapped: u32,
    count: u32,
    reserved: u32,
    extents: [RawExtent; BATCH],
}

#[derive(Clone, Debug)]
pub struct Mapping {
    pub logical: Range<u64>,
    pub physical: u64,
    pub flags: u32,
}

pub fn mappings(file: &File) -> Result<Vec<Mapping>> {
    let mut result = Vec::new();
    let mut start = 0;
    loop {
        let mut request = Request {
            start,
            length: u64::MAX - start,
            flags: 1,
            mapped: 0,
            count: u32::try_from(BATCH).map_err(|_| Error::Invalid("FIEMAP batch"))?,
            reserved: 0,
            extents: [RawExtent::default(); BATCH],
        };
        // SAFETY: the C-compatible request owns space for count extents, remains
        // live for the ioctl, and its descriptor belongs to a borrowed open file.
        if unsafe { libc::ioctl(file.as_raw_fd(), FS_IOC_FIEMAP, &raw mut request) } < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        if request.mapped as usize > BATCH {
            return Err(Error::Invalid("FIEMAP count"));
        }
        if request.mapped == 0 {
            break;
        }
        let mut last = false;
        for extent in &request.extents[..request.mapped as usize] {
            let end = extent
                .logical
                .checked_add(extent.length)
                .ok_or(Error::Invalid("FIEMAP overflow"))?;
            if end <= start || extent.length == 0 {
                return Err(Error::Invalid("FIEMAP progress"));
            }
            start = end;
            last = extent.flags & LAST != 0;
            result.push(Mapping {
                logical: extent.logical..end,
                physical: extent.physical,
                flags: extent.flags,
            });
        }
        if last {
            break;
        }
    }
    Ok(result)
}

/// Return exact byte ranges whose physical mappings differ. Byte comparison can
/// remove false positives, but is required for all returned candidates.
pub fn candidates(before: &File, after: &File) -> Result<Vec<Range<u64>>> {
    let a = before.metadata()?;
    let b = after.metadata()?;
    if a.dev() != b.dev() || a.len() != b.len() {
        return Err(Error::Invalid(
            "FIEMAP needs equal-size same-filesystem files",
        ));
    }
    Ok(compare_maps(&mappings(before)?, &mappings(after)?, a.len()))
}

fn compare_maps(before: &[Mapping], after: &[Mapping], size: u64) -> Vec<Range<u64>> {
    let mut boundaries = BTreeSet::from([0, size]);
    for extent in before.iter().chain(after) {
        boundaries.insert(extent.logical.start.min(size));
        boundaries.insert(extent.logical.end.min(size));
    }
    let points: Vec<_> = boundaries.into_iter().collect();
    let mut ranges: Vec<Range<u64>> = Vec::new();
    let mut ai = 0;
    let mut bi = 0;
    for window in points.windows(2) {
        let start = window[0];
        let end = window[1];
        while before.get(ai).is_some_and(|e| e.logical.end <= start) {
            ai += 1;
        }
        while after.get(bi).is_some_and(|e| e.logical.end <= start) {
            bi += 1;
        }
        let a = before.get(ai).filter(|e| e.logical.contains(&start));
        let b = after.get(bi).filter(|e| e.logical.contains(&start));
        let equal = match (a, b) {
            (None, None) => true,
            (Some(a), Some(b)) if (a.flags | b.flags) & !(LAST | SHARED) == 0 => a
                .physical
                .checked_add(start - a.logical.start)
                .zip(b.physical.checked_add(start - b.logical.start))
                .is_some_and(|(a, b)| a == b),
            _ => false,
        };
        if !equal {
            if let Some(last) = ranges.last_mut().filter(|r| r.end == start) {
                last.end = end;
            } else {
                ranges.push(start..end);
            }
        }
    }
    ranges
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holes_unknown_flags_and_extent_splits() {
        let a = [Mapping {
            logical: 0..8192,
            physical: 10000,
            flags: SHARED,
        }];
        let b = [
            Mapping {
                logical: 0..4096,
                physical: 10000,
                flags: SHARED,
            },
            Mapping {
                logical: 4096..8192,
                physical: 14096,
                flags: SHARED,
            },
        ];
        assert_eq!(compare_maps(&a, &b, 12288), Vec::<Range<u64>>::new());
        assert_eq!(compare_maps(&a, &[], 12288), vec![0..8192]);
        assert_eq!(compare_maps(&[], &a, 12288), vec![0..8192]);
        let unknown = [Mapping {
            flags: 2,
            ..a[0].clone()
        }];
        assert_eq!(compare_maps(&a, &unknown, 12288), vec![0..8192]);
    }
}
