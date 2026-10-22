//! Snapshot paging with a deterministic, separately testable memory-layout core.
//!
//! A single owner serializes faults, removal events and prefetch.

mod layout;
pub use layout::{Layout, Mapping, Page, Profile};
pub mod control;
pub mod source;
pub use source::{MappedFile, Source};
mod wake;
pub use wake::{WakeProfile, ready_prefix};

#[cfg(target_os = "linux")]
pub mod linux;
