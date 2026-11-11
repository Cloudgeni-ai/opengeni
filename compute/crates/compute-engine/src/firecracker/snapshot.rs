//! The snapshot requests sent to Firecracker, and what its answers to a
//! load mean.

use serde_json::{Value, json};

use super::api::ApiError;
use super::huge_pages;
use super::jail::Jail;
use crate::error::{EngineError, ErrorKind};
use crate::profile::{MemoryProfile, ProfileError};
use crate::spec::{MemorySource, RestoreFiles, SnapshotFiles, SnapshotKind, VmSpec};

/// The `/snapshot/load` request for restoring `files` as the VM in `spec`.
///
/// Host-side paths and devices are taken from `spec`, not from the snapshot, so
/// a snapshot restores the same way on another host or in another directory.
/// Paths are the ones the jailed VMM sees. Page size and dirty tracking come
/// from this host's profile, not from the host that took the snapshot: the
/// image is plain memory either way. The profile must already allow
/// `files.memory` (see [`check_source`]). `realtime` asks Firecracker to move
/// the guest's clock on by the time the image was saved, which it can only
/// for an image that recorded the host's realtime clock (see
/// [`lacks_realtime_clock`]).
pub(super) fn load_request(
    spec: &VmSpec,
    jail: &Jail,
    files: &RestoreFiles,
    profile: MemoryProfile,
    realtime: bool,
) -> Result<Value, String> {
    let backend = match &files.memory {
        MemorySource::File(path) => {
            json!({ "backend_type": "File", "backend_path": jail.inside(path)? })
        }
        MemorySource::Pager(pager) => {
            json!({ "backend_type": "Uffd", "backend_path": jail.inside(&pager.socket)? })
        }
    };
    let mut body = json!({
        "snapshot_path": jail.inside(&files.state)?,
        "mem_backend": backend,
        "huge_pages": huge_pages(profile.pages),
        "track_dirty_pages": profile.tracks_dirty_pages(),
        "resume_vm": false,
        "clock_realtime": realtime,
        "vsock_override": { "uds_path": jail.inside(&spec.vsock_path())? },
    });
    if let Some(network) = &spec.network {
        body["network_overrides"] = json!([{ "iface_id": "eth0", "host_dev_name": network.tap }]);
    }
    Ok(body)
}

/// What Firecracker answers a restore asking to move the guest's clock on
/// (`clock_realtime`) from an image that has no realtime clock to move it
/// by.
const NO_REALTIME_CLOCK: &str = "clock_realtime requested but not present in the snapshot state";

/// Whether `error` is Firecracker refusing to move the guest's clock on
/// because the image recorded no realtime clock. KVM records it only on a
/// host whose own clock runs on the processor's stable counter (TSC), so a
/// nested host whose hypervisor gives it no invariant TSC (it runs on
/// `kvm-clock`) saves every image without it. Such an image is sound: it
/// restores without the clock moved, and the guest sets its wall clock from
/// the host's restore notice as after any restore.
pub(super) fn lacks_realtime_clock(error: &ApiError) -> bool {
    matches!(error, ApiError::Status { status: 400, body, .. } if body.contains(NO_REALTIME_CLOCK))
}

/// Refuses memory sources the profile cannot back: Firecracker maps
/// huge-page memory only through a fault handler.
pub(super) fn check_source(
    memory: &MemorySource,
    profile: MemoryProfile,
) -> Result<(), ProfileError> {
    match memory {
        MemorySource::File(_) if profile.needs_pager() => Err(ProfileError::FileBackedHugePages),
        _ => Ok(()),
    }
}

/// The `/snapshot/create` request writing `files`, as the jailed VMM sees
/// them.
pub(super) fn create_request(
    jail: &Jail,
    files: &SnapshotFiles,
    kind: SnapshotKind,
) -> Result<Value, String> {
    Ok(json!({
        "snapshot_type": match kind {
            SnapshotKind::Diff => "Diff",
            SnapshotKind::Full => "Full",
        },
        "snapshot_path": jail.inside(&files.state)?,
        "mem_file_path": jail.inside(&files.memory)?,
        "sync_snapshot_files": true,
    }))
}

/// What a failed `/snapshot/load` means for the image. A VMM that answered
/// and refused it, or exited while loading it, did not load it: the caller
/// decides whether the image is at fault, which a refusal alone never
/// proves (the host may have run short of memory, say). A request lost or
/// late on the way did not even reach a verdict, so it is a transient
/// failure and the image is tried again.
pub(super) fn load_failure(error: ApiError, running: bool) -> EngineError {
    const OP: &str = "restore";
    match error {
        _ if !running => EngineError::new(
            ErrorKind::MemoryLost,
            OP,
            "the VMM exited while loading the image",
        ),
        refused @ ApiError::Status { .. } => {
            EngineError::caused_by(ErrorKind::MemoryLost, OP, refused)
        }
        lost => EngineError::caused_by(ErrorKind::Transient, OP, lost),
    }
}
