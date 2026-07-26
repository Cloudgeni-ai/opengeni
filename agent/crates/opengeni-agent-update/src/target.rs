//! Target-triple resolution.
//!
//! The updater picks the manifest artifact whose `target` matches the running
//! binary's triple. We derive it from the compile-time target (the most reliable
//! source — the binary IS for that triple) and expose a mapping from the proto
//! [`Os`]/[`Arch`] for the control-plane `UpdateCheck` path.

use opengeni_agent_proto::v1::{Arch, Os};

/// The target triple of the RUNNING binary, derived from the compile-time target.
/// macOS reports the universal-binary asset triple (`universal-apple-darwin`)
/// because the release ships one fat binary for both arches.
#[must_use]
pub fn current_target() -> &'static str {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "x86_64-unknown-linux-musl"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "aarch64-unknown-linux-musl"
    }
    #[cfg(target_os = "macos")]
    {
        // One universal asset covers both macOS arches.
        "universal-apple-darwin"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "x86_64-pc-windows-msvc"
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        "aarch64-pc-windows-msvc"
    }
    #[cfg(not(any(
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        target_os = "macos",
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
    )))]
    {
        "unknown"
    }
}

/// Maps a proto [`Os`]/[`Arch`] to the release target triple. Used when the
/// control plane asks "is there an update for THIS agent's target" via the
/// `UpdateCheck` RPC. Returns `None` for an unspecified/unsupported combination.
#[must_use]
pub fn target_for(os: Os, arch: Arch) -> Option<&'static str> {
    match (os, arch) {
        (Os::Linux, Arch::X8664) => Some("x86_64-unknown-linux-musl"),
        (Os::Linux, Arch::Aarch64) => Some("aarch64-unknown-linux-musl"),
        // macOS ships one universal asset regardless of the reported arch.
        (Os::Macos, _) => Some("universal-apple-darwin"),
        (Os::Windows, Arch::X8664) => Some("x86_64-pc-windows-msvc"),
        (Os::Windows, Arch::Aarch64) => Some("aarch64-pc-windows-msvc"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_target_is_a_known_triple() {
        // On the CI/dev Linux x86_64 host this is the musl triple; the assertion is
        // only that it is not the "unknown" fallback on a supported host.
        let t = current_target();
        assert!(t.contains('-'), "expected a triple, got {t:?}");
    }

    #[test]
    fn proto_os_arch_maps_to_triples() {
        assert_eq!(
            target_for(Os::Linux, Arch::X8664),
            Some("x86_64-unknown-linux-musl")
        );
        assert_eq!(
            target_for(Os::Macos, Arch::Aarch64),
            Some("universal-apple-darwin")
        );
        assert_eq!(
            target_for(Os::Windows, Arch::X8664),
            Some("x86_64-pc-windows-msvc")
        );
        assert_eq!(target_for(Os::Unspecified, Arch::Unspecified), None);
    }
}
