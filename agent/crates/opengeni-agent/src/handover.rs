//! Handing running commands to the successor process image of an in-place
//! agent update.
//!
//! A verified update replaces the binary and then `exec`s it in the same
//! process. Commands, their anchors and every descendant stay children of this
//! PID, in their process group and operation cgroup. The predecessor writes a
//! private manifest of each live job (its process parts, pump state and frame
//! route) and passes its path in [`HANDOVER_ENV`]. The successor reads it
//! first thing, keeps the same connection instance (so the server sees one
//! short reconnect on the same op subjects) and continues each job.
//!
//! Every failure is fail-closed: a job that cannot be continued ends as a
//! typed failure, and a descriptor nobody claims closes the anchor's death
//! lease, which ends that operation as for a crashed runner.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use opengeni_agent_engine::registry::LostReason;
use opengeni_agent_engine::OpId;

use crate::engine::HandedOverOp;

/// `<manifest path>#<nonce>#<descriptor>,...`, set only for the successor
/// image. The descriptor list lets the successor close every carried
/// descriptor even when the manifest itself is unusable.
pub const HANDOVER_ENV: &str = "OPENGENI_AGENT_HANDOVER";

/// Name of the manifest inside the agent's config directory.
pub const MANIFEST_FILE: &str = "update-handover.json";

/// What one process image hands to the next.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HandoverManifest {
    /// Ties the manifest to the exact `exec` that carries it.
    pub nonce: String,
    /// The version that wrote it.
    pub from_version: String,
    /// The connection instance the successor keeps, so op subjects stay valid.
    pub connection_instance_id: String,
    /// The live jobs.
    pub ops: Vec<HandedOverOp>,
    /// Ops that are gone (released, evicted or lost to a restart) whose
    /// starts Opengeni may still deliver: the successor answers those starts
    /// instead of running the ops again.
    #[serde(default)]
    pub lost_markers: Vec<CarriedMarker>,
    /// Control delivery tokens Opengeni still holds that no delivery used.
    /// The successor answers the same subjects, so it takes them over;
    /// otherwise every call Opengeni makes with one right after the update
    /// would fail with an unknown outcome. Added once every link stopped.
    #[serde(default)]
    pub reply_leases: Vec<CarriedReplyLeases>,
}

/// The unused control delivery tokens of one reply scope (an exact link
/// subject), carried to the successor image.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CarriedReplyLeases {
    pub api_url: Option<String>,
    pub connection_id: String,
    pub subject_prefix: String,
    pub leases: Vec<crate::rpc_replay::CarriedLease>,
}

/// Why a carried op is gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CarriedReason {
    /// Its stored result was released.
    Released,
    /// Retention bounds dropped a result that was never final-acked.
    Evicted,
    /// It did not survive an earlier runner restart.
    RunnerRestarted,
}

/// One gone op's marker, carried with the time it is still kept for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CarriedMarker {
    /// The scoped op id.
    pub op_id: String,
    /// Why the op is gone.
    pub reason: CarriedReason,
    /// How much longer the successor keeps it.
    pub remaining_ms: u64,
}

impl From<(OpId, LostReason, u64)> for CarriedMarker {
    fn from((op_id, reason, remaining_ms): (OpId, LostReason, u64)) -> Self {
        Self {
            op_id: op_id.as_str().to_string(),
            reason: match reason {
                LostReason::Released => CarriedReason::Released,
                LostReason::Evicted => CarriedReason::Evicted,
                LostReason::RunnerRestarted => CarriedReason::RunnerRestarted,
            },
            remaining_ms,
        }
    }
}

impl CarriedMarker {
    /// The marker as the registry keeps it.
    #[must_use]
    pub fn into_parts(self) -> (OpId, LostReason, u64) {
        let reason = match self.reason {
            CarriedReason::Released => LostReason::Released,
            CarriedReason::Evicted => LostReason::Evicted,
            CarriedReason::RunnerRestarted => LostReason::RunnerRestarted,
        };
        (OpId::new(self.op_id), reason, self.remaining_ms)
    }
}

impl HandoverManifest {
    /// Value of [`HANDOVER_ENV`] for this manifest at `path`.
    #[must_use]
    pub fn env_value(&self, path: &Path) -> String {
        let descriptors: Vec<String> = self
            .ops
            .iter()
            .filter_map(|op| op.job.exec.as_ref())
            .flat_map(opengeni_agent_platform::ExecHandover::descriptors)
            .map(|fd| fd.to_string())
            .collect();
        format!(
            "{}#{}#{}",
            path.display(),
            self.nonce,
            descriptors.join(",")
        )
    }

    /// Where each job's carried frames are.
    fn frame_files(&self) -> Vec<PathBuf> {
        self.ops
            .iter()
            .map(|op| op.job.state.frames_path().to_path_buf())
            .collect()
    }
}

/// Writes the manifest readable only by this user, replacing any stale one.
///
/// # Errors
///
/// The file could not be written.
pub fn write_manifest(path: &Path, manifest: &HandoverManifest) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(manifest).map_err(std::io::Error::other)?;
    let temporary = path.with_extension("json.tmp");
    let _ = std::fs::remove_file(&temporary);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temporary, path)
}

/// Adds the unused control delivery tokens to the manifest already written
/// at `path` for the same `exec`.
///
/// # Errors
///
/// The manifest could not be read or written again.
pub fn carry_reply_leases(path: &Path, leases: Vec<CarriedReplyLeases>) -> std::io::Result<()> {
    let mut manifest = read_manifest(path).map_err(std::io::Error::other)?;
    manifest.reply_leases = leases;
    write_manifest(path, &manifest)
}

/// Why an inherited handover could not be read.
#[derive(Debug, thiserror::Error)]
pub enum InheritError {
    /// [`HANDOVER_ENV`] is malformed.
    #[error("malformed handover reference")]
    Reference,
    /// The manifest could not be read or parsed.
    #[error("unreadable handover manifest: {0}")]
    Manifest(String),
    /// The manifest belongs to another `exec`.
    #[error("handover manifest does not match this process")]
    Nonce,
    /// A carried descriptor is unusable.
    #[error("handed-over descriptor {0} is unusable: {1}")]
    Descriptor(i32, std::io::Error),
}

static INHERITED: Mutex<Option<HandoverManifest>> = Mutex::new(None);

/// Reads and consumes a handover left by the predecessor image, if any. Call
/// it first in `main`, before any thread or child process exists: it makes
/// every carried descriptor close-on-exec again until a job claims it.
///
/// # Errors
///
/// A handover was announced but cannot be used; its descriptors are then
/// closed, which ends those operations.
pub fn inherit_from_env() -> Result<bool, InheritError> {
    let Some(reference) = std::env::var_os(HANDOVER_ENV) else {
        return Ok(false);
    };
    // Single-threaded here (the caller's contract), so removing the variable
    // races nothing. Commands and later images must not see it.
    std::env::remove_var(HANDOVER_ENV);
    let reference = reference
        .into_string()
        .map_err(|_| InheritError::Reference)?;
    let mut parts = reference.rsplitn(3, '#');
    let (Some(descriptors), Some(nonce), Some(path)) = (parts.next(), parts.next(), parts.next())
    else {
        return Err(InheritError::Reference);
    };
    let descriptors: Vec<i32> = descriptors
        .split(',')
        .filter(|fd| !fd.is_empty())
        .map(str::parse)
        .collect::<Result<_, _>>()
        .map_err(|_| InheritError::Reference)?;
    let path = PathBuf::from(path);
    let manifest = read_manifest(&path).and_then(|manifest| {
        if manifest.nonce == nonce {
            Ok(manifest)
        } else {
            Err(InheritError::Nonce)
        }
    });
    let _ = std::fs::remove_file(&path);
    let manifest = match manifest {
        Ok(manifest) => manifest,
        Err(error) => {
            // Close every carried descriptor: each anchor then ends its
            // operation instead of leaving it unobserved.
            for fd in descriptors {
                opengeni_agent_platform::discard_inherited_fd(fd);
            }
            return Err(error);
        }
    };
    for &fd in &descriptors {
        if let Err(error) = opengeni_agent_platform::keep_inherited_fd_private(fd) {
            // Without every descriptor the handover is not trustworthy.
            for fd in descriptors {
                opengeni_agent_platform::discard_inherited_fd(fd);
            }
            return Err(InheritError::Descriptor(fd, error));
        }
    }
    *INHERITED.lock().expect("inherited handover") = Some(manifest);
    Ok(true)
}

/// Removes frame files a crashed or failed handover left in the spool root,
/// keeping those of jobs being continued.
pub fn remove_stray_frames(spool_root: &Path, manifest: Option<&HandoverManifest>) {
    let keep = manifest
        .map(HandoverManifest::frame_files)
        .unwrap_or_default();
    let Ok(entries) = std::fs::read_dir(spool_root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path
            .extension()
            .is_some_and(|extension| extension == "handover")
            && !keep.contains(&path)
        {
            let _ = std::fs::remove_file(&path);
        }
    }
}

fn read_manifest(path: &Path) -> Result<HandoverManifest, InheritError> {
    let bytes = std::fs::read(path).map_err(|error| InheritError::Manifest(error.to_string()))?;
    serde_json::from_slice(&bytes).map_err(|error| InheritError::Manifest(error.to_string()))
}

/// Takes the inherited handover for the run loop to adopt.
pub fn take_inherited() -> Option<HandoverManifest> {
    INHERITED.lock().expect("inherited handover").take()
}

/// Returns the inherited handover's connection instance without taking it.
pub fn inherited_connection_instance() -> Option<String> {
    INHERITED
        .lock()
        .expect("inherited handover")
        .as_ref()
        .map(|manifest| manifest.connection_instance_id.clone())
}

/// Operation cgroup leaves the successor must keep rather than reclaim.
pub fn inherited_cgroup_dirs() -> Vec<PathBuf> {
    INHERITED
        .lock()
        .expect("inherited handover")
        .as_ref()
        .map(|manifest| {
            manifest
                .ops
                .iter()
                .filter_map(|op| op.job.exec.as_ref()?.op_cgroup_dir().map(Path::to_path_buf))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_manifest_is_private_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(MANIFEST_FILE);
        let manifest = HandoverManifest {
            nonce: "n1".into(),
            from_version: "0.0.0".into(),
            connection_instance_id: "instance".into(),
            ops: Vec::new(),
            lost_markers: vec![CarriedMarker {
                op_id: "scope:op-1".into(),
                reason: CarriedReason::Released,
                remaining_ms: 1_800_000,
            }],
            reply_leases: Vec::new(),
        };
        write_manifest(&path, &manifest).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert_eq!(read_manifest(&path).unwrap(), manifest);

        let leases = vec![CarriedReplyLeases {
            api_url: Some("https://opengeni.example".into()),
            connection_id: "default".into(),
            subject_prefix: "agent.w.a.connection.instance".into(),
            leases: vec![crate::rpc_replay::CarriedLease {
                token: "00000000-0000-4000-8000-000000000000".into(),
                issued_at: std::time::Duration::from_millis(1_500),
                expires_at: std::time::Duration::from_millis(241_500),
            }],
        }];
        carry_reply_leases(&path, leases.clone()).unwrap();
        let carried = read_manifest(&path).unwrap();
        assert_eq!(carried.reply_leases, leases);
        assert_eq!(
            HandoverManifest {
                reply_leases: Vec::new(),
                ..carried
            },
            manifest,
            "only the tokens are added"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert!(manifest.env_value(&path).ends_with("#n1#"));
    }

    #[test]
    fn a_manifest_from_an_image_without_carried_tokens_still_reads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(MANIFEST_FILE);
        std::fs::write(
            &path,
            br#"{"nonce":"n1","from_version":"0.0.0","connection_instance_id":"instance","ops":[]}"#,
        )
        .unwrap();
        assert!(read_manifest(&path).unwrap().reply_leases.is_empty());
    }
}
