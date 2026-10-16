//! How much memory the host has for new guests, as the agent reads it.
//!
//! `MemAvailable` leaves out free pages the kernel keeps on per-CPU lists.
//! On a host with many CPUs those lists hold gigabytes after a process
//! frees its memory, and drain back over tens of seconds, so a reading of
//! `MemAvailable` alone shows memory freed long after it can be used:
//! measured on a 192-CPU host, about 1 GiB of a 6 GiB process that exited
//! was still on those lists 15 s later. Their pages, counted in
//! `/proc/zoneinfo`, are added back.

use std::fs;

/// Bytes of memory a new guest can have now: `MemAvailable` and the free
/// pages on per-CPU lists; on a huge-page profile (`huge`), no more than
/// the free huge-page pool, which guests take their memory from and
/// `MemAvailable` leaves out. `None` if `/proc/meminfo` cannot be read.
#[must_use]
pub fn available(huge: bool) -> Option<u64> {
    let meminfo = fs::read_to_string("/proc/meminfo").ok()?;
    let zoneinfo = fs::read_to_string("/proc/zoneinfo").unwrap_or_default();
    parse(&meminfo, &zoneinfo, huge)
}

/// [`available`] from the text of `/proc/meminfo` and `/proc/zoneinfo`.
pub(crate) fn parse(meminfo: &str, zoneinfo: &str, huge: bool) -> Option<u64> {
    let field = |name: &str| -> Option<u64> {
        let line = meminfo.lines().find(|line| line.starts_with(name))?;
        line.split_whitespace().nth(1)?.parse().ok()
    };
    let page = u64::try_from(rustix::param::page_size()).unwrap_or(4096);
    let available = field("MemAvailable:")?
        .saturating_mul(1024)
        .saturating_add(per_cpu_pages(zoneinfo).saturating_mul(page));
    if !huge {
        return Some(available);
    }
    let pool = field("HugePages_Free:")? * field("Hugepagesize:")? * 1024;
    Some(available.min(pool))
}

/// Free pages on the per-CPU lists of every zone: the `count` of each CPU's
/// pageset in `/proc/zoneinfo`.
fn per_cpu_pages(zoneinfo: &str) -> u64 {
    zoneinfo
        .lines()
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            (words.next()? == "count:").then_some(())?;
            words.next()?.parse::<u64>().ok()
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::parse;

    const MEMINFO: &str = "MemTotal: 131072000 kB
MemAvailable:   16777216 kB
HugePages_Total:   55000
HugePages_Free:     1024
Hugepagesize:       2048 kB
";

    const ZONEINFO: &str = "Node 0, zone   Normal
  pages free     1000
        nr_free_pages 1000
  pagesets
    cpu: 0
              count: 256
              high:  512
              batch: 63
  vm stats threshold: 72
    cpu: 1
              count: 768
              high:  512
              batch: 63
";

    #[test]
    fn huge_page_guests_count_the_free_pool() {
        assert_eq!(parse(MEMINFO, "", false), Some(16 << 30));
        assert_eq!(parse(MEMINFO, "", true), Some(2 << 30));
        assert_eq!(parse("MemAvailable: 4 kB\n", "", true), None);
    }

    #[test]
    fn free_pages_on_per_cpu_lists_are_available() {
        let page = u64::try_from(rustix::param::page_size()).unwrap_or(4096);
        assert_eq!(
            parse(MEMINFO, ZONEINFO, false),
            Some((16 << 30) + 1024 * page)
        );
        assert_eq!(parse(MEMINFO, ZONEINFO, true), Some(2 << 30));
    }
}
