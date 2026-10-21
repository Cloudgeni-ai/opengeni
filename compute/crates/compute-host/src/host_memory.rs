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
    // The kernel clamps a negative estimate to zero, so at zero the
    // per-CPU pages may only make up part of a shortfall it hides.
    let available = match field("MemAvailable:")? {
        0 => 0,
        kib => kib
            .saturating_mul(1024)
            .saturating_add(per_cpu_pages(zoneinfo).saturating_mul(page)),
    };
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

/// What the host reports about its memory and pressure besides what is
/// available; each is `None` where the kernel does not report it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HostGauges {
    /// Bytes zswap holds, compressed (`Zswap` in `/proc/meminfo`).
    pub zswap_stored: Option<u64>,
    /// Bytes of memory it holds, before compression (`Zswapped`).
    pub zswap_original: Option<u64>,
    /// Free pages in the huge-page pool (`HugePages_Free`).
    pub huge_pages_free: Option<u64>,
    /// Total stall microseconds, `some` and `full`, for memory, I/O and
    /// processors, from `/proc/pressure`.
    pub pressure: [[Option<u64>; 2]; 3],
}

/// Reads [`HostGauges`].
#[must_use]
pub fn host_gauges() -> HostGauges {
    let meminfo = fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let pressure = ["memory", "io", "cpu"]
        .map(|resource| fs::read_to_string(format!("/proc/pressure/{resource}")).ok());
    parse_gauges(&meminfo, pressure.each_ref().map(Option::as_deref))
}

/// [`host_gauges`] from the text of `/proc/meminfo` and of each pressure
/// file, if readable.
pub(crate) fn parse_gauges(meminfo: &str, pressure: [Option<&str>; 3]) -> HostGauges {
    let field = |name: &str| -> Option<u64> {
        let line = meminfo.lines().find_map(|line| line.strip_prefix(name))?;
        line.strip_prefix(':')?
            .split_whitespace()
            .next()?
            .parse()
            .ok()
    };
    let total = |text: Option<&str>, kind: &str| -> Option<u64> {
        text?
            .lines()
            .find_map(|line| line.strip_prefix(kind)?.strip_prefix(' '))?
            .split_whitespace()
            .find_map(|pair| pair.strip_prefix("total="))?
            .parse()
            .ok()
    };
    HostGauges {
        zswap_stored: field("Zswap").map(|kib| kib << 10),
        zswap_original: field("Zswapped").map(|kib| kib << 10),
        huge_pages_free: field("HugePages_Free"),
        pressure: pressure.map(|text| [total(text, "some"), total(text, "full")]),
    }
}

#[cfg(test)]
mod tests {
    use super::{HostGauges, parse, parse_gauges};

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

    /// At zero `MemAvailable` may hide a shortfall larger than what the
    /// per-CPU lists hold: nothing is available.
    #[test]
    fn nothing_is_available_when_mem_available_is_zero() {
        assert_eq!(parse("MemAvailable: 0 kB\n", ZONEINFO, false), Some(0));
    }

    /// Readings the kernel does not give are absent, not zero: a host
    /// without zswap, or a resource without `full` pressure.
    #[test]
    fn host_gauges_are_read_where_the_kernel_reports_them() {
        let meminfo = "MemTotal: 1000 kB\nZswap:  64 kB\nZswapped: 256 kB\nHugePages_Free: 7\n";
        let memory = "some avg10=0.00 avg60=0.00 avg300=0.00 total=1500\n\
                      full avg10=0.00 avg60=0.00 avg300=0.00 total=700\n";
        let cpu = "some avg10=0.00 avg60=0.00 avg300=0.00 total=99\n";
        let gauges = parse_gauges(meminfo, [Some(memory), None, Some(cpu)]);
        assert_eq!(
            gauges,
            HostGauges {
                zswap_stored: Some(64 << 10),
                zswap_original: Some(256 << 10),
                huge_pages_free: Some(7),
                pressure: [[Some(1500), Some(700)], [None, None], [Some(99), None]],
            }
        );
        assert_eq!(
            parse_gauges("MemTotal: 1 kB\n", [None; 3]),
            HostGauges::default()
        );
    }
}
