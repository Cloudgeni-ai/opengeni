//! What Firecracker is told about a VM's drives: how each is set up at a
//! boot, which files its user owns, when the writes it started on them have
//! returned, and that a drive's file grew.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::FirecrackerVm;
use super::api::Api;
use crate::confined::Owned;
use crate::error::{EngineError, ErrorKind};
use crate::spec::{Drive, VmSpec};

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

/// `PATCH /drives/{id}` for a drive whose file at `path`, as the VMM sees
/// it, grew: the VMM opens the file again, takes its length as the
/// device's and tells the guest its configuration changed. Everything else
/// about the drive, discards included, stays as it was set up.
fn grown(drive: &Drive, path: &Path) -> Value {
    json!({
        "drive_id": drive.id,
        "path_on_host": path,
    })
}

/// The drives a guest may write to, which are the only ones that grow.
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

/// [`crate::Engine::resize_drives`]: each writable drive of `vm`, started
/// from `spec`, is opened again at its length now. A refused request
/// changed nothing.
pub(super) async fn resize(vm: &FirecrackerVm, spec: &VmSpec) -> Result<(), EngineError> {
    const OP: &str = "resize_drives";
    for drive in writable(&spec.drives) {
        let path = vm.inside(OP, &drive.path)?;
        let at = format!("/drives/{}", drive.id);
        vm.call(OP, ErrorKind::Transient, "PATCH", &at, &grown(drive, &path))
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_grown_drive_names_only_its_file() {
        let drive = |read_only| Drive {
            id: "rootfs".into(),
            path: PathBuf::from("/srv/vm/disk"),
            root: true,
            read_only,
        };
        assert_eq!(
            grown(&drive(false), Path::new("/disk")),
            json!({ "drive_id": "rootfs", "path_on_host": "/disk" })
        );
        let drives = [drive(true), drive(false)];
        let ids: Vec<bool> = writable(&drives).map(|drive| drive.read_only).collect();
        assert_eq!(ids, [false]);
    }
}
