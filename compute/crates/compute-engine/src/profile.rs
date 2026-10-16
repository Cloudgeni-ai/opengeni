//! How a host backs, saves and compresses guest memory.
//!
//! Two kinds of host need different choices, and several combinations of
//! those choices are unsafe or self-defeating, so a host picks one
//! validated [`MemoryProfile`] and every VM on it follows that profile:
//!
//! - **Bare metal**: ordinary 4 KiB pages, KVM dirty-page tracking, and
//!   compression into zswap allowed. Saves write only the pages the guest
//!   changed since the VM's memory source, whatever is swapped.
//! - **Nested** (a VM inside a cloud VM): 2 MiB huge pages from a reserved
//!   pool, which makes the outer hypervisor's job far cheaper. Dirty tracking
//!   would split every huge page into 4 KiB mappings and cancel that, so saves
//!   instead write the pages that are resident. Huge pages cannot be swapped,
//!   so "resident" is exactly "everything not identical to the source".
//!
//! [`MemoryProfile::validate`] refuses the combinations that break either
//! rule.

use std::fmt;
use std::str::FromStr;

/// The page size backing guest memory.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PageSize {
    /// Ordinary 4 KiB pages: swappable, and compressible into zswap.
    Base,
    /// Explicit 2 MiB huge pages from the host's reserved hugetlb pool.
    Huge,
}

impl PageSize {
    /// Bytes per page.
    #[must_use]
    pub const fn bytes(self) -> u64 {
        match self {
            Self::Base => 4 << 10,
            Self::Huge => 2 << 20,
        }
    }
}

/// How a save decides which pages to write.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SaveMode {
    /// Pages KVM saw the guest write since the VM's memory source. Correct
    /// whatever is swapped or compressed, but forces 4 KiB mappings.
    Dirty,
    /// Pages resident in host memory. Correct only when guest memory can
    /// never be swapped out, since a swapped page looks absent.
    Resident,
}

/// A combination of memory choices that would lose data or defeat itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ProfileError {
    /// Dirty tracking splits huge pages into 4 KiB mappings.
    #[error("dirty-page tracking forces 4 KiB mappings and cancels huge pages")]
    DirtyHugePages,
    /// A resident-only save cannot see pages that were swapped out.
    #[error("resident-page saves miss swapped pages; use them only with huge pages")]
    ResidentSwappable,
    /// Huge pages cannot be swapped, so there is nothing to compress.
    #[error("huge pages cannot be compressed into zswap")]
    CompressedHugePages,
    /// Firecracker restores huge-page memory only through a fault handler.
    #[error("huge-page memory cannot be restored by mapping a file; use a pager")]
    FileBackedHugePages,
    /// The profile forbids compressing memory.
    #[error("this host's memory profile does not allow compression")]
    CompressionDisabled,
}

/// How one host backs, saves and compresses guest memory. Build one with
/// [`MemoryProfile::bare_metal`] or [`MemoryProfile::nested`], or check a
/// custom one with [`MemoryProfile::validate`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct MemoryProfile {
    /// Page size backing guest memory.
    pub pages: PageSize,
    /// Which pages a save writes.
    pub save: SaveMode,
    /// Whether paused VMs may be compressed into zswap.
    pub compress: bool,
}

impl Default for MemoryProfile {
    fn default() -> Self {
        Self::bare_metal()
    }
}

impl MemoryProfile {
    /// Bare-metal hosts: 4 KiB pages, dirty tracking, zswap allowed.
    #[must_use]
    pub const fn bare_metal() -> Self {
        Self {
            pages: PageSize::Base,
            save: SaveMode::Dirty,
            compress: true,
        }
    }

    /// Nested hosts: 2 MiB huge pages, resident-page saves, no zswap.
    #[must_use]
    pub const fn nested() -> Self {
        Self {
            pages: PageSize::Huge,
            save: SaveMode::Resident,
            compress: false,
        }
    }

    /// The profile a host should use, from the text of its `/proc/cpuinfo`:
    /// nested when the CPU says it runs under a hypervisor (the x86
    /// `hypervisor` flag, which cloud VMs report and bare metal does not),
    /// bare metal otherwise, including on CPUs that report no such flag.
    #[must_use]
    pub fn for_cpuinfo(cpuinfo: &str) -> Self {
        let under_hypervisor = cpuinfo
            .lines()
            .filter_map(|line| line.split_once(':'))
            .filter(|(key, _)| key.trim() == "flags")
            .any(|(_, flags)| flags.split_whitespace().any(|flag| flag == "hypervisor"));
        if under_hypervisor {
            Self::nested()
        } else {
            Self::bare_metal()
        }
    }

    /// Returns the profile if it is safe, or the first rule it breaks.
    pub const fn validate(self) -> Result<Self, ProfileError> {
        match (self.pages, self.save, self.compress) {
            (PageSize::Huge, SaveMode::Dirty, _) => Err(ProfileError::DirtyHugePages),
            (PageSize::Base, SaveMode::Resident, _) => Err(ProfileError::ResidentSwappable),
            (PageSize::Huge, _, true) => Err(ProfileError::CompressedHugePages),
            _ => Ok(self),
        }
    }

    /// Whether the VMM tracks dirty pages.
    #[must_use]
    pub const fn tracks_dirty_pages(self) -> bool {
        matches!(self.save, SaveMode::Dirty)
    }

    /// Whether guest memory must be served by a page-fault handler even when
    /// the image is on local disk. Firecracker restores huge-page memory only
    /// through a handler, never by mapping the file.
    #[must_use]
    pub const fn needs_pager(self) -> bool {
        matches!(self.pages, PageSize::Huge)
    }
}

impl fmt::Display for MemoryProfile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if *self == Self::bare_metal() {
            f.write_str("bare-metal")
        } else if *self == Self::nested() {
            f.write_str("nested")
        } else {
            write!(f, "{self:?}")
        }
    }
}

impl FromStr for MemoryProfile {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, String> {
        match text {
            "bare-metal" => Ok(Self::bare_metal()),
            "nested" => Ok(Self::nested()),
            other => Err(format!(
                "unknown memory profile {other}; use bare-metal or nested"
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_safe_combinations_validate() {
        let mut valid = Vec::new();
        for pages in [PageSize::Base, PageSize::Huge] {
            for save in [SaveMode::Dirty, SaveMode::Resident] {
                for compress in [false, true] {
                    let profile = MemoryProfile {
                        pages,
                        save,
                        compress,
                    };
                    if profile.validate().is_ok() {
                        valid.push(profile);
                    }
                }
            }
        }
        let bare_metal_without_zswap = MemoryProfile {
            compress: false,
            ..MemoryProfile::bare_metal()
        };
        assert_eq!(
            valid,
            [
                bare_metal_without_zswap,
                MemoryProfile::bare_metal(),
                MemoryProfile::nested()
            ]
        );
    }

    #[test]
    fn refusals_name_the_broken_rule() {
        let dirty_huge = MemoryProfile {
            save: SaveMode::Dirty,
            ..MemoryProfile::nested()
        };
        assert_eq!(dirty_huge.validate(), Err(ProfileError::DirtyHugePages));
        let resident_base = MemoryProfile {
            save: SaveMode::Resident,
            compress: false,
            ..MemoryProfile::bare_metal()
        };
        assert_eq!(
            resident_base.validate(),
            Err(ProfileError::ResidentSwappable)
        );
        let compressed_huge = MemoryProfile {
            compress: true,
            ..MemoryProfile::nested()
        };
        assert_eq!(
            compressed_huge.validate(),
            Err(ProfileError::CompressedHugePages)
        );
    }

    #[test]
    fn names_round_trip() {
        for profile in [MemoryProfile::bare_metal(), MemoryProfile::nested()] {
            assert_eq!(profile.to_string().parse::<MemoryProfile>(), Ok(profile));
        }
        assert!("huge".parse::<MemoryProfile>().is_err());
    }

    #[test]
    fn a_host_under_a_hypervisor_gets_the_nested_profile() {
        let cloud_vm = "processor\t: 0\nflags\t\t: fpu vme lahf_lm hypervisor avx2\n";
        let bare_metal = "processor\t: 0\nflags\t\t: fpu vme lahf_lm avx2\n";
        let no_flags = "processor\t: 0\nFeatures\t: fp asimd evtstrm\n";
        assert_eq!(
            MemoryProfile::for_cpuinfo(cloud_vm),
            MemoryProfile::nested()
        );
        assert_eq!(
            MemoryProfile::for_cpuinfo(bare_metal),
            MemoryProfile::bare_metal()
        );
        assert_eq!(
            MemoryProfile::for_cpuinfo(no_flags),
            MemoryProfile::bare_metal()
        );
    }
}
