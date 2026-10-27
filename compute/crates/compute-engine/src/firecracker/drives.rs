//! What Firecracker is told about a VM's drives: how each is set up at a
//! boot, which files its user owns, and when the writes it started on them
//! have returned.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::api::Api;
use crate::confined::Owned;
use crate::error::{EngineError, ErrorKind};
use crate::spec::Drive;

/// `/drives/{id}` for a fresh boot, with the drive's file at `path` as the
/// VMM sees it.
///
/// No `cache_type`: Firecracker's default, `Unsafe`, offers the guest no
/// flush, so the VMM syncs a drive only while it takes a snapshot. Callers
/// that check a disk for lost writes around each snapshot rely on that.
///
/// A writable drive takes the guest's discards (the default `Sync` engine
/// punches a hole in the file for each), so the host gets back what the
/// guest's file system frees once the guest trims it. The device's
/// snapshot state keeps the feature, so a restore needs no request; an
/// image whose VM booted without it restores without it.
///
/// No `io_engine` either: discards need the default `Sync` engine, and
/// [`settled`] relies on it finishing each request on the VMM's own
/// thread.
pub(super) fn drive_config(drive: &Drive, path: &Path) -> Value {
    json!({
        "drive_id": drive.id,
        "path_on_host": path,
        "is_root_device": drive.root,
        "is_read_only": drive.read_only,
        "discard": !drive.read_only,
    })
}

/// The drives a guest may write to.
fn writable(drives: &[Drive]) -> impl Iterator<Item = &Drive> {
    drives.iter().filter(|drive| !drive.read_only)
}

/// The drive files handed to a VM's user before its VMM starts: the
/// writable ones. A read-only drive's file stays the host's, so the VMM
/// cannot change it.
pub(super) fn owned(drives: &[Drive]) -> Vec<(PathBuf, Owned)> {
    writable(drives)
        .map(|drive| (drive.path.clone(), Owned::File))
        .collect()
}

/// [`crate::Engine::settle_writes`]: one API request the VMM answers.
///
/// The VMM answers on the thread that also does its drives' I/O, between
/// events, and a drive with Firecracker's default synchronous engine
/// (which [`drive_config`] keeps) finishes each request within the event
/// that starts it. So once the answer comes, every write the VMM had
/// started before the request has returned.
pub(super) async fn settled(api: Api) -> Result<(), EngineError> {
    api.call("GET", "/", None)
        .await
        .map(drop)
        .map_err(|error| EngineError::caused_by(ErrorKind::Transient, "settle_writes", error))
}
