//! What a live VM's saved state depends on: the memory its next snapshot
//! is relative to, and the host's watch on its disk.

use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::image::Generation;
use crate::layout::Paths;
#[cfg(target_os = "linux")]
use crate::lazy::Paging;

/// What the VM's memory equals, page for page, apart from what it changed
/// since: what a diff snapshot is relative to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Base {
    /// All zeros: a VM booted fresh.
    Zero,
    /// A published image generation.
    Image(Generation),
    /// Unknown, for example after a failed snapshot or merge: the next
    /// snapshot must hold every page.
    Unknown,
}

/// What a live VM's saved state depends on: what backs its memory, and the
/// host's watch on its disk.
#[derive(Debug)]
pub(crate) struct LiveMemory {
    pub base: Base,
    /// The pager thread serving its memory, if a pager does.
    #[cfg(target_os = "linux")]
    pub paging: Option<Paging>,
    /// Sees every write to the disk that was lost while the VM ran.
    pub disk: Arc<DiskWatch>,
}

impl LiveMemory {
    pub fn booted(disk: DiskWatch) -> Self {
        Self {
            base: Base::Zero,
            #[cfg(target_os = "linux")]
            paging: None,
            disk: Arc::new(disk),
        }
    }

    /// A VM found running after an agent restart: what its memory is based
    /// on is unknown.
    pub fn adopted(disk: DiskWatch) -> Self {
        Self {
            base: Base::Unknown,
            #[cfg(target_os = "linux")]
            paging: None,
            disk: Arc::new(disk),
        }
    }

    /// Resolves if the VM's memory can no longer be served, so the VM must
    /// be stopped.
    pub fn failed(&self) -> impl Future<Output = ()> + Send + 'static {
        #[cfg(target_os = "linux")]
        if let Some(paging) = &self.paging {
            return futures::future::Either::Left(paging.failed());
        }
        futures::future::Either::Right(std::future::pending())
    }
}

/// The host's watch on a VM's disk, which decides whether a snapshot of
/// the VM can be trusted to match a disk that is durable.
///
/// Firecracker logs and ignores a failed flush of a disk, so the guest's
/// writes can be lost without the VMM reporting it. Its drives are given
/// no cache type, so the guest is never offered a flush and the VMM syncs
/// a disk only while it takes a snapshot, which the agent asks for. Linux
/// keeps a writeback error until it is reported by `fsync`, and reports it
/// through every descriptor that was open when it happened, and through a
/// newly opened one as long as no `fsync` has reported it yet.
///
/// So the watch holds a descriptor opened before the VM's VMM starts, and
/// syncs it after each snapshot: that sees every write lost since the VM
/// started, even one the VMM's own sync saw first. Before the VMM can sync
/// the disk, a check marker is made durable in the host-only sandbox
/// directory, and only a clean sync removes it. An agent that restarts
/// beside the VM opens a new descriptor, which sees every lost write no
/// sync reported; any sync that did report one ran under the marker, which
/// the new agent finds. A failure is final for the VM: no snapshot of it
/// is trusted again.
#[derive(Debug)]
pub(crate) struct DiskWatch {
    disk: PathBuf,
    marker: PathBuf,
    /// `None` when an adopted VM's disk could not be opened.
    file: Option<fs::File>,
    failed: AtomicBool,
}

impl DiskWatch {
    /// The watch for a VM about to start from `paths`: no earlier VM's
    /// check concerns it.
    pub fn fresh(paths: &Paths) -> io::Result<Self> {
        let file = crate::layout::open_jailed(&paths.disk)?;
        let marker = check_marker(paths);
        crate::layout::remove_durably(&marker)?;
        Ok(Self {
            disk: paths.disk.clone(),
            marker,
            file: Some(file),
            failed: AtomicBool::new(false),
        })
    }

    /// The watch for a VM found running after an agent restart. It has
    /// failed if a check was under way, since a sync may have reported a
    /// lost write to no one, or if the disk cannot be opened: either way
    /// lost writes could go unseen, so no snapshot is trusted.
    pub fn adopt(paths: &Paths) -> Self {
        let file = crate::layout::open_jailed(&paths.disk)
            .inspect_err(|error| tracing::warn!(disk = %paths.disk.display(), %error, "no watch on an adopted VM's disk"))
            .ok();
        let marker = check_marker(paths);
        let checking = !matches!(
            fs::symlink_metadata(&marker),
            Err(error) if error.kind() == io::ErrorKind::NotFound
        );
        if checking {
            tracing::warn!(disk = %paths.disk.display(), "the agent stopped while checking the disk; no snapshot of its VM is trusted");
        }
        Self {
            disk: paths.disk.clone(),
            marker,
            failed: AtomicBool::new(file.is_none() || checking),
            file,
        }
    }

    /// Starts a check, before anything may sync the disk.
    pub(crate) fn begin(&self) -> io::Result<()> {
        if self.failed() {
            return Err(self.lost());
        }
        crate::layout::write_atomic(&self.marker, b"")
    }

    /// Flushes the disk, failing if any write to it was lost since the
    /// watch was opened, and ends the check that [`DiskWatch::begin`]
    /// started if none was.
    pub(crate) fn sync(&self) -> io::Result<()> {
        let Some(file) = self.file.as_ref().filter(|_| !self.failed()) else {
            return Err(self.lost());
        };
        if let Err(error) =
            crate::layout::failpoint(&self.disk, "sync").and_then(|()| file.sync_all())
        {
            tracing::error!(disk = %self.disk.display(), %error, "the disk lost writes");
            self.failed.store(true, Ordering::Release);
            return Err(self.lost());
        }
        // A marker left behind only costs trust after a restart.
        if let Err(error) = crate::layout::remove_durably(&self.marker) {
            tracing::warn!(marker = %self.marker.display(), %error, "disk check not cleared");
        }
        Ok(())
    }

    pub(super) fn failed(&self) -> bool {
        self.failed.load(Ordering::Acquire)
    }

    fn lost(&self) -> io::Error {
        io::Error::other(format!(
            "{} may have lost writes since its VM started",
            self.disk.display()
        ))
    }
}

/// Present while the host checks a VM's disk, or after a check failed.
pub(super) fn check_marker(paths: &Paths) -> PathBuf {
    paths.dir.join("disk-check")
}
