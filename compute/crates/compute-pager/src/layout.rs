use serde::{Deserialize, Serialize};
use std::{collections::HashSet, io};

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// Firecracker handshake region. Both page-size fields are in **bytes**.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Mapping {
    pub base_host_virt_addr: u64,
    pub size: u64,
    pub offset: u64,
    #[serde(default)]
    pub page_size: u64,
    #[serde(default)]
    pub page_size_kib: u64,
}

/// One page's host destination and snapshot source.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Page {
    pub address: u64,
    pub offset: u64,
    pub size: u64,
    pub index: usize,
}

/// Validated mappings; page indices address compact per-page state.
#[derive(Debug)]
pub struct Layout {
    regions: Vec<Mapping>,
    starts: Vec<usize>,
    pages: usize,
}

impl Layout {
    pub fn new(mut regions: Vec<Mapping>, snapshot_bytes: u64) -> io::Result<Self> {
        if regions.is_empty() {
            return Err(invalid("empty memory layout"));
        }
        regions.sort_by_key(|r| r.base_host_virt_addr);
        let mut starts = Vec::with_capacity(regions.len());
        let mut pages = 0_usize;
        let mut previous_end = 0;
        let mut sources = Vec::new();
        for region in &mut regions {
            if region.page_size == 0 {
                region.page_size = region.page_size_kib;
            } else if region.page_size_kib != 0 && region.page_size_kib != region.page_size {
                return Err(invalid("conflicting page sizes"));
            }
            let size = region.page_size;
            if !matches!(size, 4096 | 2_097_152)
                || region.size == 0
                || !region.size.is_multiple_of(size)
                || !region.offset.is_multiple_of(size)
                || !region.base_host_virt_addr.is_multiple_of(size)
            {
                return Err(invalid("unsupported or unaligned page geometry"));
            }
            let end = region
                .base_host_virt_addr
                .checked_add(region.size)
                .ok_or_else(|| invalid("host address overflow"))?;
            let source_end = region
                .offset
                .checked_add(region.size)
                .filter(|end| *end <= snapshot_bytes)
                .ok_or_else(|| invalid("snapshot range out of bounds"))?;
            if region.base_host_virt_addr < previous_end {
                return Err(invalid("overlapping host regions"));
            }
            previous_end = end;
            sources.push((region.offset, source_end));
            starts.push(pages);
            pages = pages
                .checked_add(
                    usize::try_from(region.size / size)
                        .map_err(|_| invalid("page count overflow"))?,
                )
                .ok_or_else(|| invalid("page count overflow"))?;
        }
        sources.sort_unstable();
        if sources.windows(2).any(|pair| pair[0].1 > pair[1].0) {
            return Err(invalid("overlapping snapshot ranges"));
        }
        Ok(Self {
            regions,
            starts,
            pages,
        })
    }

    #[must_use]
    pub fn page_count(&self) -> usize {
        self.pages
    }
    #[must_use]
    pub fn regions(&self) -> &[Mapping] {
        &self.regions
    }

    #[must_use]
    pub fn region_end(&self, address: u64) -> Option<u64> {
        let index = self
            .regions
            .partition_point(|r| r.base_host_virt_addr <= address)
            .checked_sub(1)?;
        let region = &self.regions[index];
        let end = region.base_host_virt_addr + region.size;
        (address < end).then_some(end)
    }

    #[must_use]
    pub fn address(&self, address: u64) -> Option<Page> {
        let i = self
            .regions
            .partition_point(|r| r.base_host_virt_addr <= address)
            .checked_sub(1)?;
        let r = &self.regions[i];
        let relative = address.checked_sub(r.base_host_virt_addr)?;
        if relative >= r.size {
            return None;
        }
        let relative = relative / r.page_size * r.page_size;
        Some(Page {
            address: r.base_host_virt_addr + relative,
            offset: r.offset + relative,
            size: r.page_size,
            index: self.starts[i] + usize::try_from(relative / r.page_size).ok()?,
        })
    }

    #[must_use]
    pub fn offset(&self, offset: u64) -> Option<Page> {
        self.regions.iter().find_map(|r| {
            let relative = offset.checked_sub(r.offset)?;
            (relative < r.size)
                .then(|| self.address(r.base_host_virt_addr + relative))
                .flatten()
        })
    }

    /// Ordered distinct pages, preserving first-touch priority.
    pub fn plan(&self, offsets: &[u64]) -> io::Result<Vec<Page>> {
        let mut seen = HashSet::new();
        offsets
            .iter()
            .map(|offset| {
                self.offset(*offset)
                    .ok_or_else(|| invalid("profile offset outside snapshot"))
            })
            .filter_map(|page| match page {
                Ok(page) if seen.insert(page.index) => Some(Ok(page)),
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            })
            .collect()
    }
}

/// Bind a working set to an immutable snapshot identity supplied by its owner.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Profile {
    pub version: u32,
    pub snapshot_id: String,
    pub offsets: Vec<u64>,
}

impl Profile {
    pub fn validate(&self, snapshot_id: &str, layout: &Layout) -> io::Result<Vec<Page>> {
        if self.version != 1 || self.snapshot_id != snapshot_id {
            return Err(invalid("profile version or snapshot identity mismatch"));
        }
        layout.plan(&self.offsets)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn region(base: u64, size: u64, offset: u64, page_size: u64) -> Mapping {
        Mapping {
            base_host_virt_addr: base,
            size,
            offset,
            page_size,
            page_size_kib: 0,
        }
    }
    #[test]
    fn translates_holes_and_boundaries() {
        let layout = Layout::new(
            vec![
                region(0x10000, 8192, 0, 4096),
                region(0x20000, 4096, 8192, 4096),
            ],
            12288,
        )
        .unwrap();
        assert_eq!(layout.address(0x11007).unwrap().offset, 4096);
        assert!(layout.address(0x12000).is_none());
        assert!(layout.address(u64::MAX).is_none());
        assert_eq!(layout.offset(8192).unwrap().address, 0x20000);
        assert_eq!(layout.page_count(), 3);
        assert_eq!(layout.region_end(0x11007), Some(0x12000));
        assert_eq!(layout.region_end(0x12000), None);
    }
    #[test]
    fn rejects_overlap_truncation_and_overflow() {
        assert!(Layout::new(vec![region(4096, 8192, 0, 4096)], 4096).is_err());
        assert!(Layout::new(vec![region(u64::MAX - 4095, 4096, 0, 4096)], 4096).is_err());
        assert!(
            Layout::new(
                vec![region(4096, 8192, 0, 4096), region(8192, 4096, 8192, 4096)],
                12288
            )
            .is_err()
        );
        assert!(
            Layout::new(
                vec![region(4096, 4096, 0, 4096), region(8192, 4096, 0, 4096)],
                8192
            )
            .is_err()
        );
    }
    #[test]
    fn legacy_field_is_bytes_not_kibibytes() {
        let r: Mapping = serde_json::from_str(
            r#"{"base_host_virt_addr":2097152,"size":2097152,"offset":0,"page_size_kib":2097152}"#,
        )
        .unwrap();
        assert_eq!(Layout::new(vec![r], 2_097_152).unwrap().page_count(), 1);
    }
    #[test]
    fn ordered_profile_is_bound_and_deduplicated() {
        let layout = Layout::new(vec![region(4096, 12288, 0, 4096)], 12288).unwrap();
        let profile = Profile {
            version: 1,
            snapshot_id: "synthetic-v1".into(),
            offsets: vec![8192, 0, 8193, 4096],
        };
        assert_eq!(
            profile
                .validate("synthetic-v1", &layout)
                .unwrap()
                .iter()
                .map(|p| p.offset)
                .collect::<Vec<_>>(),
            vec![8192, 0, 4096]
        );
        assert!(profile.validate("other", &layout).is_err());
    }
}
