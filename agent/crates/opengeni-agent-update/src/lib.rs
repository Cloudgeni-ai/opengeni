//! Self-update for the OpenGeni self-hosted agent (M11b).
//!
//! The updater is **symmetric with the install scripts**: ONE pinned minisign key
//! ([`verify::PINNED_MINISIGN_PUBKEY`], the same base64 the scripts embed and
//! `agent/install/opengeni-agent-minisign.pub` carries), ONE verify routine. It
//! consumes a signed channel manifest (codegen'd [`UpdateManifest`] so the TS
//! publisher and this Rust consumer never drift), verifies each artifact two
//! independent ways (minisign + sha256) plus a version-monotonicity gate, performs
//! an ATOMIC same-filesystem self-replace (incl. the Windows rename-self-aside),
//! and ROLLS BACK to the prior binary on any failed boot health-gate.
//!
//! # Flow
//!
//! 1. **discover** — fetch `<base>/agent/<channel>/manifest.json` + `.minisig`,
//!    verify the manifest's OWN signature against the pinned key, parse it;
//! 2. **gate** — version monotonicity + `min_supported` + the staged-rollout
//!    cohort check ([`manifest::in_rollout`]);
//! 3. **fetch + verify the artifact** — download the target artifact + its
//!    `.minisig`, verify the minisign signature against the pinned key AND the
//!    sha256 from the (signed) manifest — a TAMPERED artifact is rejected here;
//! 4. **apply** — atomic swap with a retained backup ([`apply`]);
//! 5. **health-gate + rollback** — the caller runs the boot health gate; a failure
//!    triggers [`apply::rollback`].
//!
//! # Testing
//!
//! The [`Source`] trait abstracts WHERE bytes come from: production uses
//! [`HttpSource`]; tests use [`DirSource`] over a local mock release dir, signing
//! throwaway artifacts with a generated key so they never touch the release
//! secret. The accept/reject + swap/rollback paths are exercised end-to-end in
//! `tests/`.

#![doc(html_root_url = "https://docs.rs/opengeni-agent-update")]

mod apply;
mod error;
mod manifest;
mod target;
mod verify;

use std::path::{Path, PathBuf};

use opengeni_agent_proto::v1::{UpdateArtifact, UpdateManifest};
use tracing::{info, warn};

pub use apply::{backup_path, promote, replace_running_exe, rollback, swap_binary, BACKUP_SUFFIX};
pub use error::{UpdateError, UpdateResult};
pub use manifest::{artifact_for_target, in_rollout, parse_manifest};
pub use target::{current_target, target_for};
pub use verify::{
    sha256_hex, verify_checksum, verify_signature, verify_version, PINNED_MINISIGN_PUBKEY,
};

/// Where the updater fetches bytes from. Production is [`HttpSource`]; tests use
/// [`DirSource`]. A `Source` resolves URLs the manifest carries verbatim, so the
/// updater logic is identical across both.
pub trait Source {
    /// Fetches the bytes at `url` (an absolute URL for HTTP, or a path-like ref for
    /// a dir source).
    ///
    /// # Errors
    ///
    /// [`UpdateError::Download`] on any transport/IO failure.
    fn fetch(&self, url: &str) -> UpdateResult<Vec<u8>>;
}

/// A filesystem-backed [`Source`] over a local mock release tree (for tests + the
/// `OPENGENI_INSTALL_BASE_URL=file://…` parity with the install scripts). URLs are
/// treated as paths under `root` (a `file://`/`http(s)://` prefix is stripped to
/// its path component).
pub struct DirSource {
    root: PathBuf,
}

impl DirSource {
    /// A dir source rooted at `root`. Manifest/artifact URLs resolve to
    /// `root.join(<path-of-url>)`.
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn resolve(&self, url: &str) -> PathBuf {
        if let Some(rest) = url.strip_prefix("file://") {
            // A file URL carries an ABSOLUTE path (it already includes the root):
            // "file:///tmp/r/agent/a" -> "/tmp/r/agent/a". Use it verbatim.
            return PathBuf::from(rest);
        }
        if let Some((_, after_scheme)) = url.split_once("://") {
            // An http(s) URL: strip scheme + authority, the rest is relative to root.
            let path = after_scheme
                .split_once('/')
                .map_or(after_scheme, |(_, p)| p);
            return self.root.join(path.trim_start_matches('/'));
        }
        // A bare relative path (the manifest's relative artifact/minisig URLs).
        self.root.join(url.trim_start_matches('/'))
    }
}

impl Source for DirSource {
    fn fetch(&self, url: &str) -> UpdateResult<Vec<u8>> {
        let path = self.resolve(url);
        std::fs::read(&path).map_err(|e| UpdateError::Download {
            url: url.to_string(),
            source: Box::new(e),
        })
    }
}

/// An HTTP-backed [`Source`] using the same blocking rustls reqwest the agent
/// already links. Used by the live agent's self-update path.
pub struct HttpSource {
    client: reqwest::blocking::Client,
}

impl HttpSource {
    /// Builds an HTTP source.
    ///
    /// # Errors
    ///
    /// [`UpdateError::Download`] if the HTTP client cannot be constructed.
    pub fn new() -> UpdateResult<Self> {
        let client = reqwest::blocking::Client::builder()
            .user_agent(concat!("opengeni-agent-update/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| UpdateError::Download {
                url: "client".to_string(),
                source: Box::new(e),
            })?;
        Ok(Self { client })
    }
}

impl Source for HttpSource {
    fn fetch(&self, url: &str) -> UpdateResult<Vec<u8>> {
        let resp = self
            .client
            .get(url)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|e| UpdateError::Download {
                url: url.to_string(),
                source: Box::new(e),
            })?;
        let bytes = resp.bytes().map_err(|e| UpdateError::Download {
            url: url.to_string(),
            source: Box::new(e),
        })?;
        Ok(bytes.to_vec())
    }
}

/// The configuration a self-update check needs.
#[derive(Debug, Clone)]
pub struct UpdateConfig {
    /// The release base URL (the same `OPENGENI_INSTALL_BASE_URL` the install
    /// scripts honor). Manifest at `<base>/agent/<channel>/manifest.json`.
    pub base_url: String,
    /// The channel to follow (`stable` | `beta`).
    pub channel: String,
    /// The agent's stable id (for the rollout cohort hash).
    pub agent_id: String,
    /// The version currently running.
    pub current_version: String,
    /// The target triple to fetch (defaults to [`current_target`]).
    pub target: String,
    /// The pinned minisign public-key text used to verify the manifest + artifact.
    /// Defaults to [`PINNED_MINISIGN_PUBKEY`]; overridable in tests.
    pub pubkey: String,
    /// Allow re-installing the SAME version (a forced re-pin); normally false.
    pub allow_same_version: bool,
}

impl UpdateConfig {
    /// A config with production defaults (the pinned key + the running target).
    #[must_use]
    pub fn new(
        base_url: impl Into<String>,
        channel: impl Into<String>,
        agent_id: impl Into<String>,
        current_version: impl Into<String>,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            channel: channel.into(),
            agent_id: agent_id.into(),
            current_version: current_version.into(),
            target: current_target().to_string(),
            pubkey: PINNED_MINISIGN_PUBKEY.to_string(),
            allow_same_version: false,
        }
    }

    fn manifest_url(&self) -> String {
        format!(
            "{}/agent/{}/manifest.json",
            self.base_url.trim_end_matches('/'),
            self.channel
        )
    }
}

/// The outcome of an update check: either nothing to do, or a verified-and-staged
/// download ready to apply.
#[derive(Debug)]
pub enum CheckOutcome {
    /// No newer build for this channel/target, or the agent is outside the rollout
    /// cohort. The reason is human-facing for logs.
    UpToDate(String),
    /// A newer build is available, downloaded, and CRYPTOGRAPHICALLY VERIFIED. The
    /// caller applies it via [`PendingUpdate::apply_to`] / [`PendingUpdate::apply_running`].
    Available(PendingUpdate),
}

/// A verified, ready-to-install update. The bytes have already passed the minisign
/// + sha256 + version gates; applying is the atomic swap.
#[derive(Debug)]
pub struct PendingUpdate {
    /// The version being installed.
    pub version: String,
    /// Whether the manifest forced this (a CVE path that overrides drain).
    pub force: bool,
    /// The verified artifact bytes.
    bytes: Vec<u8>,
}

impl PendingUpdate {
    /// The verified artifact size, for logging.
    #[must_use]
    pub fn size(&self) -> usize {
        self.bytes.len()
    }

    /// Applies the verified update to an explicit install path (the testable path),
    /// returning the retained backup path for the boot health-gate / rollback.
    ///
    /// # Errors
    ///
    /// [`UpdateError::Io`] on a filesystem failure.
    pub fn apply_to(&self, install_path: &Path) -> UpdateResult<PathBuf> {
        swap_binary(install_path, &self.bytes)
    }

    /// Applies the verified update to the CURRENTLY-RUNNING executable (the live
    /// agent path; handles the running-exe lock on every OS).
    ///
    /// # Errors
    ///
    /// [`UpdateError::Io`] if the swap fails.
    pub fn apply_running(&self) -> UpdateResult<PathBuf> {
        replace_running_exe(&self.bytes)
    }
}

/// Checks for and fully VERIFIES (but does not apply) an update against `source`.
///
/// This is the orchestrator: fetch+verify the manifest, gate on version + rollout,
/// fetch+verify the artifact (minisign + sha256). On success the returned
/// [`PendingUpdate`] holds bytes that have already passed every gate, so applying
/// is purely the atomic swap.
///
/// # Errors
///
/// Any [`UpdateError`] from a fetch/verify/gate step. A tampered manifest or
/// artifact yields [`UpdateError::Signature`]; a wrong checksum
/// [`UpdateError::Checksum`]; a downgrade [`UpdateError::VersionGate`].
pub fn check_update(source: &dyn Source, config: &UpdateConfig) -> UpdateResult<CheckOutcome> {
    // 1. Discover: fetch the manifest + its detached signature, verify the
    //    manifest's OWN signature against the pinned key, then parse.
    let manifest_url = config.manifest_url();
    let manifest_bytes = source.fetch(&manifest_url)?;
    let manifest_sig = source.fetch(&format!("{manifest_url}.minisig"))?;
    verify_signature(
        &manifest_bytes,
        &String::from_utf8_lossy(&manifest_sig),
        &config.pubkey,
    )?;
    let manifest = parse_manifest(&manifest_bytes)?;
    info!(
        channel = %manifest.channel,
        version = %manifest.version,
        "fetched + verified the channel manifest"
    );

    // 2. Gate: version monotonicity + min_supported.
    if let Err(e) = verify_version(
        &manifest.version,
        &config.current_version,
        &manifest.min_supported,
        config.allow_same_version,
    ) {
        return Ok(CheckOutcome::UpToDate(format!("no newer build: {e}")));
    }

    // 3. Gate: staged-rollout cohort. A forced manifest overrides cohorting.
    if !manifest.force
        && !in_rollout(
            &config.agent_id,
            &manifest.cohort_salt,
            manifest.rollout_percent,
        )
    {
        return Ok(CheckOutcome::UpToDate(format!(
            "version {} is staged at {}% and this agent is not yet in the cohort",
            manifest.version, manifest.rollout_percent
        )));
    }

    // 4. Fetch + verify the artifact for this target.
    let artifact = artifact_for_target(&manifest, &config.target)?;
    let bytes = fetch_and_verify_artifact(source, artifact, &config.pubkey)?;
    info!(version = %manifest.version, size = bytes.len(), "downloaded + verified the update artifact");

    Ok(CheckOutcome::Available(PendingUpdate {
        version: manifest.version.clone(),
        force: manifest.force,
        bytes,
    }))
}

/// Downloads an artifact + its detached signature and runs BOTH gates (minisign
/// against the pinned key, then sha256 against the signed manifest). Returns the
/// verified bytes. A tampered artifact never makes it past here.
fn fetch_and_verify_artifact(
    source: &dyn Source,
    artifact: &UpdateArtifact,
    pubkey: &str,
) -> UpdateResult<Vec<u8>> {
    let bytes = source.fetch(&artifact.url)?;
    let sig = source.fetch(&artifact.minisig_url)?;

    // GATE 1: minisign signature against the pinned key (network-independent).
    verify_signature(&bytes, &String::from_utf8_lossy(&sig), pubkey)?;
    // GATE 2: sha256 against the (signed) manifest value.
    verify_checksum(&bytes, &artifact.sha256)?;
    Ok(bytes)
}

/// Runs the boot health-gate result handling: on `Ok`, [`promote`] (delete the
/// backup); on `Err`, [`rollback`] (restore the prior binary) and surface the
/// failure. The caller supplies the actual health check (NATS ping + a structural
/// self-op); this helper centralizes the promote-or-rollback decision so the
/// "a bad update must never brick the user's hardware" invariant lives in one place.
///
/// # Errors
///
/// Returns the health-check error after a successful rollback, or an
/// [`UpdateError::Io`] if the rollback itself fails (the worst case the local
/// safety net then handles).
pub fn finalize_update(install_path: &Path, health: UpdateResult<()>) -> UpdateResult<()> {
    match health {
        Ok(()) => {
            promote(install_path)?;
            info!("update promoted: the new binary passed the boot health gate");
            Ok(())
        }
        Err(health_err) => {
            warn!(error = %health_err, "boot health gate FAILED; rolling back to the prior binary");
            rollback(install_path)?;
            Err(UpdateError::HealthCheck(health_err.to_string()))
        }
    }
}

/// Builds the codegen'd [`UpdateManifest`] → JSON the publisher writes (the inverse
/// of [`parse_manifest`]); exposed so a test or a Rust-side publisher can emit a
/// manifest the same shape the TS publisher does.
///
/// # Errors
///
/// [`UpdateError::Manifest`] if serialization fails (it should not for a valid
/// manifest).
pub fn manifest_to_json(manifest: &UpdateManifest) -> UpdateResult<Vec<u8>> {
    // Mirror the serde field names by going through the JSON shape.
    let value = serde_json::json!({
        "channel": manifest.channel,
        "version": manifest.version,
        "min_supported": manifest.min_supported,
        "rollout_percent": manifest.rollout_percent,
        "cohort_salt": manifest.cohort_salt,
        "artifacts": manifest.artifacts.iter().map(|a| serde_json::json!({
            "target": a.target,
            "url": a.url,
            "size": a.size,
            "sha256": a.sha256,
            "minisig_url": a.minisig_url,
        })).collect::<Vec<_>>(),
        "notes_url": manifest.notes_url,
        "signed_at_ms": manifest.signed_at_ms,
        "force": manifest.force,
    });
    serde_json::to_vec(&value).map_err(|e| UpdateError::Manifest(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_source_resolves_scheme_and_host() {
        let src = DirSource::new("/root");
        // http(s): scheme+authority stripped, the rest is relative to root.
        assert_eq!(
            src.resolve("https://get.opengeni.ai/agent/a"),
            PathBuf::from("/root/agent/a")
        );
        // file://: the path is absolute (it already embeds the root) — used verbatim.
        assert_eq!(
            src.resolve("file:///root/agent/a"),
            PathBuf::from("/root/agent/a")
        );
        // bare relative (the manifest's artifact/minisig URLs) join to root.
        assert_eq!(src.resolve("agent/a"), PathBuf::from("/root/agent/a"));
        assert_eq!(src.resolve("/agent/a"), PathBuf::from("/root/agent/a"));
    }

    #[test]
    fn manifest_json_roundtrips_through_proto() {
        let m = UpdateManifest {
            channel: "stable".to_string(),
            version: "1.0.1".to_string(),
            min_supported: "1.0.0".to_string(),
            rollout_percent: 50,
            cohort_salt: "s".to_string(),
            artifacts: vec![UpdateArtifact {
                target: "x86_64-unknown-linux-musl".to_string(),
                url: "https://x/a".to_string(),
                size: 3,
                sha256: "ab".to_string(),
                minisig_url: "https://x/a.minisig".to_string(),
            }],
            notes_url: "https://x/n".to_string(),
            signed_at_ms: 7,
            force: false,
        };
        let json = manifest_to_json(&m).expect("to_json");
        let back = parse_manifest(&json).expect("parse");
        assert_eq!(back.version, "1.0.1");
        assert_eq!(back.artifacts[0].target, "x86_64-unknown-linux-musl");
        assert_eq!(back.rollout_percent, 50);
    }
}
