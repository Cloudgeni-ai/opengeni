//! The order a guest touches its memory after a wake, learned by one wake
//! and prefetched by the next.

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::Page;

/// Most pages a learned profile keeps.
const PROFILE_PAGES: usize = 1 << 16;
/// The page sizes a guest's memory comes in.
const PAGE_SIZES: std::ops::RangeInclusive<u64> = 4 << 10..=2 << 20;

/// The pages a guest touched first after a wake, in order, as image
/// offsets. Prefetched before the next wake.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WakeProfile {
    pub version: u32,
    pub offsets: Vec<u64>,
    /// Bytes per page; 0 in profiles recorded before it was kept.
    #[serde(default)]
    pub page_size: u64,
}

impl WakeProfile {
    /// Reads a profile, or an empty one if there is none or it is unusable.
    #[must_use]
    pub fn load(path: &Path) -> Self {
        std::fs::read(path).map_or_else(|_| Self::default(), |bytes| Self::parse(&bytes))
    }

    /// Decodes a stored profile, or an empty one if it is unusable.
    #[must_use]
    pub fn parse(bytes: &[u8]) -> Self {
        serde_json::from_slice::<Self>(bytes)
            .ok()
            .filter(|profile| profile.version == 1)
            .unwrap_or_default()
    }

    /// Whether this profile can describe memory of `memory_len` bytes: a
    /// page size guest memory comes in, no more pages than a profile keeps,
    /// each the start of a page inside the memory. Whoever reads a profile
    /// written by a pager checks this first: a pager runs as its VM's user.
    #[must_use]
    pub fn fits(&self, memory_len: u64) -> bool {
        let page = self.page_size;
        self.version == 1
            && page.is_power_of_two()
            && PAGE_SIZES.contains(&page)
            && self.offsets.len() <= PROFILE_PAGES
            && self.offsets.iter().all(|offset| {
                offset.is_multiple_of(page)
                    && offset
                        .checked_add(page)
                        .is_some_and(|end| end <= memory_len)
            })
    }

    /// The profile after a wake that prefetched `self` and then faulted on
    /// `touched`, pages of `page_size` bytes: pages prefetched never fault,
    /// so the old order is kept and new pages follow it, up to a bound.
    #[must_use]
    pub fn learn(&self, touched: &[u64], page_size: u64) -> Self {
        let mut seen = HashSet::new();
        let offsets = self
            .offsets
            .iter()
            .chain(touched)
            .copied()
            .filter(|offset| seen.insert(*offset))
            .take(PROFILE_PAGES)
            .collect();
        Self {
            version: 1,
            offsets,
            page_size,
        }
    }
}

/// How many pages from the front of `plan` fit in `budget` bytes, and at
/// least one if there are any, so a wake always waits for its first page.
#[must_use]
pub fn ready_prefix(plan: &[Page], budget: u64) -> usize {
    let mut bytes = 0_u64;
    plan.iter()
        .position(|page| {
            bytes = bytes.saturating_add(page.size);
            bytes > budget
        })
        .map_or(plan.len(), |over| over.max(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pages(sizes: &[u64]) -> Vec<Page> {
        let mut offset = 0;
        sizes
            .iter()
            .enumerate()
            .map(|(index, &size)| {
                let page = Page {
                    address: offset,
                    offset,
                    size,
                    index,
                };
                offset += size;
                page
            })
            .collect()
    }

    #[test]
    fn a_wake_waits_for_the_profile_prefix_that_fits_its_budget() {
        assert_eq!(ready_prefix(&[], 4096), 0);
        assert_eq!(ready_prefix(&pages(&[4096; 10]), 4 * 4096), 4);
        assert_eq!(ready_prefix(&pages(&[4096; 3]), 1 << 20), 3);
        // A huge page larger than the budget is still waited for.
        assert_eq!(ready_prefix(&pages(&[2 << 20; 4]), 1 << 20), 1);
        assert_eq!(ready_prefix(&pages(&[2 << 20; 4]), 4 << 20), 2);
    }

    #[test]
    fn learning_keeps_the_old_order_first_and_each_page_once() {
        let old = WakeProfile {
            version: 1,
            offsets: vec![8192, 0],
            page_size: 4096,
        };
        let learned = old.learn(&[4096, 0, 12288], 4096);
        assert_eq!(learned.offsets, vec![8192, 0, 4096, 12288]);
        assert_eq!(
            WakeProfile::parse(b"{\"version\":2,\"offsets\":[]}"),
            WakeProfile::default()
        );
    }

    #[test]
    fn a_profile_fits_only_memory_it_can_describe() {
        let profile = |offsets: Vec<u64>, page_size| WakeProfile {
            version: 1,
            offsets,
            page_size,
        };
        let len = 4 << 20;
        assert!(profile(vec![0, 4096, len - 4096], 4096).fits(len));
        assert!(profile(vec![2 << 20], 2 << 20).fits(len));
        assert!(!profile(vec![len], 4096).fits(len));
        assert!(!profile(vec![u64::MAX - 4095], 4096).fits(len));
        assert!(!profile(vec![u64::MAX], 4096).fits(len));
        assert!(!profile(vec![100], 4096).fits(len));
        assert!(!profile(vec![0], 0).fits(len));
        assert!(!profile(vec![0], 3 << 10).fits(len));
        assert!(!profile(vec![0], 4 << 20).fits(len));
        assert!(!profile(vec![0; PROFILE_PAGES + 1], 4096).fits(len));
        assert!(!WakeProfile::default().fits(len));
    }
}
