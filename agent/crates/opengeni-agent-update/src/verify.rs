//! Artifact verification — symmetric with the install scripts (one pinned key,
//! one routine).
//!
//! Three independent gates, ALL fail-closed (dossier §23.2):
//!   1. **minisign signature** against the pinned ed25519 public key — a tampered
//!      or attacker-substituted artifact is rejected here, independent of the
//!      network (the key is compiled into the binary, not trusted from TLS);
//!   2. **sha256** against the value in the (itself-signed) manifest — catches a
//!      truncation distinctly from a tamper;
//!   3. **version monotonicity + `min_supported`** — a downgrade-attack rejection.
//!
//! The pinned key is the SAME base64 the install scripts embed and the same one
//! `agent/install/opengeni-agent-minisign.pub` carries, so install and self-update
//! share one trust root.

use minisign_verify::{PublicKey, Signature};
use semver::Version;
use sha2::{Digest, Sha256};

use crate::error::{UpdateError, UpdateResult};

/// The PINNED minisign public key (the base64 line of
/// `agent/install/opengeni-agent-minisign.pub`). This is the self-update trust
/// root: an artifact is rejected unless its detached minisign signature verifies
/// against THIS key. Rotating it means shipping a new signed binary — by design,
/// exactly like rotating the key embedded in the install scripts.
pub const PINNED_MINISIGN_PUBKEY: &str =
    "untrusted comment: minisign public key: 726E51117501AA9A\n\
     RWSaqgF1EVFuci7hXvDJO7cBh2xf2k0XKhCpvl23aWKG+nMAGfZ6D2Pn";

/// Verifies a detached minisign signature over `artifact` against `pubkey_str`
/// (the two-line minisign public-key text). Used with [`PINNED_MINISIGN_PUBKEY`]
/// in production; tests pass a throwaway key so they never need the release secret.
///
/// # Errors
///
/// [`UpdateError::Signature`] if the key/signature cannot be parsed or the
/// signature does not verify — a tampered artifact lands here and is never
/// installed.
pub fn verify_signature(
    artifact: &[u8],
    signature_text: &str,
    pubkey_str: &str,
) -> UpdateResult<()> {
    // minisign-verify's `from_base64` takes the bare key line; `decode` takes the
    // full 2-line text. We accept either input (the install scripts embed the bare
    // line; the .pub file is 2-line) by extracting the base64 line ourselves.
    let public_key = PublicKey::from_base64(pubkey_line(pubkey_str))
        .map_err(|e| UpdateError::Signature(format!("bad public key: {e}")))?;
    let signature = Signature::decode(signature_text)
        .map_err(|e| UpdateError::Signature(format!("bad signature: {e}")))?;
    public_key
        .verify(artifact, &signature, false)
        .map_err(|e| UpdateError::Signature(format!("signature did not verify: {e}")))
}

/// minisign's `PublicKey::decode` wants only the base64 key line (not the
/// `untrusted comment:` header). Extract the last non-empty, non-comment line.
fn pubkey_line(pubkey_str: &str) -> &str {
    pubkey_str
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty() && !l.starts_with("untrusted comment:"))
        .unwrap_or(pubkey_str)
}

/// Computes the lowercase-hex sha256 of `bytes`.
#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Verifies the artifact's sha256 matches `expected` (from the signed manifest).
///
/// # Errors
///
/// [`UpdateError::Checksum`] on a mismatch.
pub fn verify_checksum(artifact: &[u8], expected: &str) -> UpdateResult<()> {
    let actual = sha256_hex(artifact);
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(UpdateError::Checksum {
            expected: expected.to_string(),
            actual,
        })
    }
}

/// Enforces version monotonicity + the `min_supported` floor.
///
/// Accepts `candidate` only when it is strictly newer than `current` (or equal,
/// when `allow_equal` — a forced re-pin of the same version) AND not below
/// `min_supported`. This is the downgrade-attack protection: a signed manifest
/// can never roll an agent backward past `min_supported`.
///
/// # Errors
///
/// [`UpdateError::SemVer`] if a version string is unparsable; [`UpdateError::VersionGate`]
/// if the candidate is rejected.
pub fn verify_version(
    candidate: &str,
    current: &str,
    min_supported: &str,
    allow_equal: bool,
) -> UpdateResult<()> {
    let cand = parse(candidate)?;
    let cur = parse(current)?;
    let floor = parse(min_supported)?;

    let newer_enough = if allow_equal { cand >= cur } else { cand > cur };
    if newer_enough && cand >= floor {
        Ok(())
    } else {
        Err(UpdateError::VersionGate {
            candidate: candidate.to_string(),
            current: current.to_string(),
            min_supported: min_supported.to_string(),
        })
    }
}

fn parse(value: &str) -> UpdateResult<Version> {
    Version::parse(value).map_err(|source| UpdateError::SemVer {
        value: value.to_string(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_and_rejects() {
        let body = b"hello world";
        let hash = sha256_hex(body);
        assert!(verify_checksum(body, &hash).is_ok());
        assert!(matches!(
            verify_checksum(body, "00").unwrap_err(),
            UpdateError::Checksum { .. }
        ));
    }

    #[test]
    fn version_gate_requires_strictly_newer_by_default() {
        // Newer is accepted.
        assert!(verify_version("1.2.0", "1.1.0", "1.0.0", false).is_ok());
        // Equal is rejected unless allow_equal.
        assert!(verify_version("1.1.0", "1.1.0", "1.0.0", false).is_err());
        assert!(verify_version("1.1.0", "1.1.0", "1.0.0", true).is_ok());
        // Older is rejected (downgrade).
        assert!(verify_version("1.0.0", "1.1.0", "1.0.0", false).is_err());
    }

    #[test]
    fn version_gate_enforces_min_supported_floor() {
        // Candidate newer than current but BELOW the min_supported floor => reject.
        let err = verify_version("0.9.0", "0.8.0", "1.0.0", false).unwrap_err();
        assert!(matches!(err, UpdateError::VersionGate { .. }));
    }

    #[test]
    fn invalid_version_is_a_typed_error() {
        assert!(matches!(
            verify_version("not-a-version", "1.0.0", "1.0.0", false).unwrap_err(),
            UpdateError::SemVer { .. }
        ));
    }

    #[test]
    fn pinned_pubkey_parses() {
        // The pinned key must be a well-formed minisign public key (a typo in the
        // embed would brick every self-update — catch it at test time).
        assert!(PublicKey::from_base64(pubkey_line(PINNED_MINISIGN_PUBKEY)).is_ok());
    }

    #[test]
    fn pubkey_line_strips_the_comment_header() {
        let line = pubkey_line(PINNED_MINISIGN_PUBKEY);
        assert!(!line.starts_with("untrusted comment:"));
        assert_eq!(
            line,
            "RWSaqgF1EVFuci7hXvDJO7cBh2xf2k0XKhCpvl23aWKG+nMAGfZ6D2Pn"
        );
    }
}
