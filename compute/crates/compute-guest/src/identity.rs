//! A sandbox's machine identity: its id, host name and machine id.
//!
//! A guest booted for a sandbox takes the id from the kernel command line
//! and, unless its disk already belongs to that sandbox, a fresh random
//! machine id. A restore notice that names another sandbox (a clone of a
//! template, or of a ready sandbox) gives it a machine id derived from the
//! notice's seed, so a retried notice derives the same one. The files are
//! those the lab image's services write, so both images look alike.

use std::fmt::Write as _;

use sha2::{Digest, Sha256};

/// Holds the sandbox the disk's machine identity was made for.
pub const OWNER_FILE: &str = "/etc/opengeni-identity";
/// Holds the sandbox the guest currently is.
pub const SANDBOX_FILE: &str = "/run/sandbox-id";
pub const MACHINE_ID_FILE: &str = "/etc/machine-id";

/// The machine id a notice with `seed_hex` for `sandbox` gives: the first
/// 32 hex digits of SHA-256 over `seed:sandbox`.
#[must_use]
pub fn derived_machine_id(seed_hex: &str, sandbox: &str) -> String {
    let digest = Sha256::digest(format!("{seed_hex}:{sandbox}"));
    hex(&digest[..16])
}

/// A machine id from 16 random bytes.
#[must_use]
pub fn random_machine_id(bytes: &[u8; 16]) -> String {
    hex(bytes)
}

/// The host name for `sandbox`: the kernel holds at most 64 bytes, and
/// the lab image keeps the first 63.
#[must_use]
pub fn host_name(sandbox: &str) -> &str {
    &sandbox[..sandbox.len().min(63)]
}

/// Whether the disk's identity, read from [`OWNER_FILE`], belongs to
/// `sandbox`.
#[must_use]
pub fn owned_by(owner_file: Option<&str>, sandbox: &str) -> bool {
    owner_file.is_some_and(|owner| owner.trim() == sandbox)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derived_ids_match_the_lab_images() {
        // python3 -c 'import hashlib; print(hashlib.sha256(b"00ff:abc").hexdigest()[:32])'
        assert_eq!(
            derived_machine_id("00ff", "abc"),
            "ac344de95e93d9e95bf95791f9a0859e"
        );
        assert_eq!(derived_machine_id("00ff", "abc").len(), 32);
        assert_ne!(
            derived_machine_id("00ff", "abd"),
            derived_machine_id("00ff", "abc")
        );
    }

    #[test]
    fn random_ids_are_32_hex_digits() {
        let id = random_machine_id(&[0xab; 16]);
        assert_eq!(id, "ab".repeat(16));
    }

    #[test]
    fn host_names_keep_63_bytes() {
        assert_eq!(host_name("abc"), "abc");
        assert_eq!(host_name(&"x".repeat(80)).len(), 63);
    }

    #[test]
    fn ownership_ignores_the_newline() {
        assert!(owned_by(Some("abc\n"), "abc"));
        assert!(!owned_by(Some("abd\n"), "abc"));
        assert!(!owned_by(None, "abc"));
    }
}
