//! Where a sandbox's step files live, and the small file operations steps
//! share: markers, links, and moving or clearing snapshot files.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::sync::Arc;

#[cfg(target_os = "linux")]
use compute_engine::EngineError;
use compute_engine::SnapshotFiles;

#[cfg(target_os = "linux")]
use super::Reconnected;
use super::{Archived, blocking};
use crate::image::Images;
use crate::layout::{Paths, remove_if_present, write_atomic};
#[cfg(target_os = "linux")]
use crate::lazy::Fetcher;
#[cfg(target_os = "linux")]
use crate::paging::Paging;
use crate::store::Receipt;

/// The sandbox's memory images.
pub(crate) fn images_of(paths: &Paths) -> Images {
    Images::new(paths.dir.join("images"))
}

/// The learned order the guest touches memory after a wake.
pub(super) fn wake_profile(paths: &Paths) -> PathBuf {
    paths.dir.join("wake-profile.json")
}

/// Names the stored copy the record's `archived` flag refers to.
pub(super) fn archive_receipt(paths: &Paths) -> PathBuf {
    paths.dir.join("archive.json")
}

/// Notes, durably, that the stored copy `receipt` names matches the
/// sandbox's files, holding a memory image if `memory`: as an archive
/// does, for a sandbox adopted from the store. Blocks.
pub(crate) fn mark_archived(paths: &Paths, receipt: Receipt, memory: bool) -> io::Result<()> {
    let marker = Archived { receipt, memory };
    let bytes = serde_json::to_vec(&marker).map_err(io::Error::other)?;
    write_atomic(&archive_receipt(paths), &bytes)
}

/// Present while the sandbox's VM may have its memory served by a pager,
/// naming that pager's launch (see [`crate::paging::tag`]).
pub(super) fn paged_marker(paths: &Paths) -> PathBuf {
    paths.dir.join("paged")
}

/// The directory the sandbox's pager writes in, as its VM's user.
pub(super) fn pager_dir(paths: &Paths) -> PathBuf {
    paths.dir.join("pager")
}

/// Where the sandbox's pager listens for the agent.
pub(super) fn pager_control(paths: &Paths) -> PathBuf {
    pager_dir(paths).join("sock")
}

/// Where the sandbox's pager writes the order it learned, until the agent
/// takes it into [`wake_profile`].
pub(super) fn pager_learned(paths: &Paths) -> PathBuf {
    pager_dir(paths).join("learned.json")
}

/// Whether the sandbox's last VM may have had its memory served by a
/// pager.
pub(crate) fn paged(paths: &Paths) -> bool {
    paged_marker(paths).exists()
}

/// Reconnects to the pager of a VM found running after an agent restart;
/// see [`Paging::reconnect`]. What the VM's memory was based on is not
/// known any more.
#[cfg(target_os = "linux")]
pub(crate) async fn reconnect_paging(
    paths: &Paths,
    fetcher: Option<&Arc<Fetcher>>,
) -> Result<Option<Reconnected>, EngineError> {
    let paging = Paging::reconnect(
        &paged_marker(paths),
        &pager_control(paths),
        images_of(paths),
        fetcher.cloned(),
    )
    .await?;
    Ok(paging.map(|paging| Reconnected { paging }))
}

/// The files a diff snapshot is written to, inside the jail.
pub(super) fn diff_files(paths: &Paths) -> SnapshotFiles {
    SnapshotFiles {
        state: paths.in_jail("save.state"),
        memory: paths.in_jail("save.mem"),
    }
}

/// Makes the sandbox's images consistent after a host restart and reports
/// whether a good current image exists, or why not. An error means they
/// could not be checked, which proves nothing about them.
pub(crate) fn recover_images(paths: &Paths) -> io::Result<crate::image::Recovered> {
    images_of(paths).recover()
}

/// Points `link` at `target` with a hard link, replacing what was there.
pub(super) fn link(target: &Path, link: &Path) -> io::Result<()> {
    remove_if_present(link)?;
    fs::hard_link(target, link)
}

/// Moves the snapshot files a VMM wrote in its jail into `scratch`, a
/// directory only the host can reach, and checks each is a plain file of
/// its own. A renamed link stays a link, so the check sees what the VMM
/// left, and nothing jailed can swap it afterwards.
pub(crate) fn take_written(files: &SnapshotFiles, scratch: &Path) -> io::Result<SnapshotFiles> {
    match fs::remove_dir_all(scratch) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    fs::create_dir(scratch)?;
    let taken = SnapshotFiles {
        state: scratch.join("save.state"),
        memory: scratch.join("save.mem"),
    };
    for (written, moved) in [(&files.state, &taken.state), (&files.memory, &taken.memory)] {
        fs::rename(written, moved)?;
        compute_engine::confined::check_written(moved)?;
    }
    Ok(taken)
}

/// Deletes the sandbox's local disk, memory images and snapshot files.
pub(crate) async fn clear_local(paths: &Paths) -> io::Result<()> {
    let paths = paths.clone();
    blocking(move || {
        remove_if_present(&paths.disk)?;
        remove_if_present(&paths.snapshot.state)?;
        remove_if_present(&paths.snapshot.memory)?;
        remove_if_present(&paged_marker(&paths))?;
        images_of(&paths).clear()
    })
    .await
    .and_then(|removed| removed)
}

pub(super) fn drop_snapshot(paths: &Paths) {
    let _ = remove_if_present(&paths.snapshot.state);
    let _ = remove_if_present(&paths.snapshot.memory);
    let _ = remove_if_present(&paged_marker(paths));
    let _ = remove_if_present(&pager_control(paths).with_extension("done"));
    let _ = remove_if_present(&archive_receipt(paths));
    let files = diff_files(paths);
    let _ = remove_if_present(&files.state);
    let _ = remove_if_present(&files.memory);
    let _ = images_of(paths).clear();
}
