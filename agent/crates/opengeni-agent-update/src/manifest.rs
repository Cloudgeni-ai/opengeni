//! The signed channel manifest — discovery + artifact selection + cohort gating.
//!
//! OpenGeni owns release truth via a tiny signed JSON manifest per channel
//! (`$BASE/agent/{stable,beta}/manifest.json` + `.minisig`), NOT the raw GitHub
//! API. The manifest is itself minisign-signed, so a compromised
//! CDN can neither redirect to an attacker artifact nor roll the fleet backward.
//! The wire shape mirrors the codegen'd [`UpdateManifest`] proto so the TS
//! publisher and this Rust consumer never drift.

use opengeni_agent_proto::v1::{UpdateArtifact, UpdateManifest};
use serde::Deserialize;

use crate::error::{UpdateError, UpdateResult};

/// The on-the-wire JSON shape of the channel manifest. It is a 1:1 mirror of the
/// proto [`UpdateManifest`]; we keep a serde struct (rather than a proto-JSON
/// mapping) so the field names are explicit and stable for the TS publisher.
#[derive(Debug, Clone, Deserialize)]
pub struct ManifestJson {
    /// `stable` | `beta`.
    pub channel: String,
    /// The version this manifest promotes.
    pub version: String,
    /// The lowest version still permitted (downgrade-attack floor).
    pub min_supported: String,
    /// Staged-rollout gate: an agent applies when `cohort_value < rollout_percent`.
    #[serde(default = "default_rollout")]
    pub rollout_percent: u32,
    /// Per-channel salt mixed into the cohort hash so a re-publish can reshuffle.
    #[serde(default)]
    pub cohort_salt: String,
    /// One entry per target triple.
    pub artifacts: Vec<ArtifactJson>,
    /// Human release notes.
    #[serde(default)]
    pub notes_url: String,
    /// When the manifest was signed (unix epoch ms).
    #[serde(default)]
    pub signed_at_ms: i64,
    /// When true, override drain and update mid-session (a security-CVE path).
    #[serde(default)]
    pub force: bool,
}

/// One artifact row in the manifest.
#[derive(Debug, Clone, Deserialize)]
pub struct ArtifactJson {
    /// Target triple, e.g. `x86_64-unknown-linux-musl`.
    pub target: String,
    /// Where to download the artifact.
    pub url: String,
    /// Expected size in bytes (advisory).
    #[serde(default)]
    pub size: u64,
    /// Lowercase-hex sha256 the updater verifies the download against.
    pub sha256: String,
    /// URL of the detached minisign signature.
    pub minisig_url: String,
}

fn default_rollout() -> u32 {
    100
}

impl From<ManifestJson> for UpdateManifest {
    fn from(m: ManifestJson) -> Self {
        Self {
            channel: m.channel,
            version: m.version,
            min_supported: m.min_supported,
            rollout_percent: m.rollout_percent,
            cohort_salt: m.cohort_salt,
            artifacts: m.artifacts.into_iter().map(Into::into).collect(),
            notes_url: m.notes_url,
            signed_at_ms: m.signed_at_ms,
            force: m.force,
        }
    }
}

impl From<ArtifactJson> for UpdateArtifact {
    fn from(a: ArtifactJson) -> Self {
        Self {
            target: a.target,
            url: a.url,
            size: a.size,
            sha256: a.sha256,
            minisig_url: a.minisig_url,
        }
    }
}

/// Parses the JSON manifest body into the proto [`UpdateManifest`].
///
/// # Errors
///
/// [`UpdateError::Manifest`] if the JSON is malformed.
pub fn parse_manifest(json: &[u8]) -> UpdateResult<UpdateManifest> {
    let parsed: ManifestJson =
        serde_json::from_slice(json).map_err(|e| UpdateError::Manifest(e.to_string()))?;
    Ok(parsed.into())
}

/// Selects the artifact for a target triple.
///
/// # Errors
///
/// [`UpdateError::NoArtifactForTarget`] when no row matches.
pub fn artifact_for_target<'m>(
    manifest: &'m UpdateManifest,
    target: &str,
) -> UpdateResult<&'m UpdateArtifact> {
    manifest
        .artifacts
        .iter()
        .find(|a| a.target == target)
        .ok_or_else(|| UpdateError::NoArtifactForTarget(target.to_string()))
}

/// Deterministic staged-rollout cohorting: an agent is IN the
/// rollout when `blake3(agent_id + cohort_salt) % 100 < rollout_percent`. The same
/// agent always lands in the same cohort for a given salt, so a `5 → 25 → 50 → 100`
/// promotion is monotonic per agent (no agent flaps in and out). `rollout_percent
/// >= 100` is everyone; `0` is no one.
#[must_use]
pub fn in_rollout(agent_id: &str, cohort_salt: &str, rollout_percent: u32) -> bool {
    if rollout_percent >= 100 {
        return true;
    }
    if rollout_percent == 0 {
        return false;
    }
    let mut hasher = blake3::Hasher::new();
    hasher.update(agent_id.as_bytes());
    hasher.update(cohort_salt.as_bytes());
    let digest = hasher.finalize();
    // Take the first 8 bytes as a u64 and mod 100 for a stable 0..99 bucket.
    let bytes = digest.as_bytes();
    let mut head = [0u8; 8];
    head.copy_from_slice(&bytes[..8]);
    let bucket = u64::from_le_bytes(head) % 100;
    bucket < u64::from(rollout_percent)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_json() -> &'static str {
        r#"{
          "channel": "stable",
          "version": "1.2.0",
          "min_supported": "1.0.0",
          "rollout_percent": 25,
          "cohort_salt": "salt-abc",
          "artifacts": [
            {"target":"x86_64-unknown-linux-musl","url":"https://x/a","size":10,
             "sha256":"deadbeef","minisig_url":"https://x/a.minisig"},
            {"target":"aarch64-apple-darwin","url":"https://x/b","size":11,
             "sha256":"feedface","minisig_url":"https://x/b.minisig"}
          ],
          "notes_url": "https://x/notes",
          "signed_at_ms": 123,
          "force": false
        }"#
    }

    #[test]
    fn parses_manifest_and_selects_target() {
        let m = parse_manifest(sample_json().as_bytes()).expect("parse");
        assert_eq!(m.version, "1.2.0");
        assert_eq!(m.rollout_percent, 25);
        let art = artifact_for_target(&m, "aarch64-apple-darwin").expect("artifact");
        assert_eq!(art.sha256, "feedface");
        assert!(artifact_for_target(&m, "nope-triple").is_err());
    }

    #[test]
    fn malformed_manifest_is_a_typed_error() {
        assert!(matches!(
            parse_manifest(b"{ not json").unwrap_err(),
            UpdateError::Manifest(_)
        ));
    }

    #[test]
    fn rollout_full_and_empty_are_absolute() {
        assert!(in_rollout("any", "s", 100));
        assert!(in_rollout("any", "s", 200));
        assert!(!in_rollout("any", "s", 0));
    }

    #[test]
    fn rollout_is_deterministic_and_monotonic_per_agent() {
        // For a fixed agent + salt, a higher percent is a superset: if an agent is
        // in at P, it is in at every percent >= P (its bucket is fixed).
        let agent = "agent-deadbeef";
        let salt = "salt-xyz";
        let mut first_in: Option<u32> = None;
        for percent in 0..=100 {
            let inside = in_rollout(agent, salt, percent);
            if inside && first_in.is_none() {
                first_in = Some(percent);
            }
            // Once in, always in for higher percents.
            if let Some(p) = first_in {
                assert!(inside || percent < p, "agent flapped out at {percent}");
            }
        }
    }

    #[test]
    fn rollout_spreads_agents_across_buckets() {
        // A 50% rollout should include roughly (not exactly) half of many agents —
        // assert it is neither all nor none, proving the hash actually spreads.
        let salt = "spread-salt";
        let included = (0..1000)
            .filter(|i| in_rollout(&format!("agent-{i}"), salt, 50))
            .count();
        assert!(
            included > 300 && included < 700,
            "got {included}/1000 at 50%"
        );
    }
}
