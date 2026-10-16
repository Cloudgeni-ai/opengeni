//! What a live VM's saved state depends on: the memory its next snapshot
//! is relative to, and the host's watch on its disk.

use std::fs;
use std::io;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::image::Generation;
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
    /// Sees every write to the disk that was lost since it was opened.
    pub disk: Option<Arc<DiskWatch>>,
}

impl LiveMemory {
    pub fn booted(disk: DiskWatch) -> Self {
        Self {
            base: Base::Zero,
            #[cfg(target_os = "linux")]
            paging: None,
            disk: Some(Arc::new(disk)),
        }
    }

    /// A VM found running after an agent restart: what its memory is based
    /// on is unknown, and its disk watch, if one could be opened, sees only
    /// writes lost from now on.
    pub fn adopted(disk: Option<DiskWatch>) -> Self {
        Self {
            base: Base::Unknown,
            #[cfg(target_os = "linux")]
            paging: None,
            disk: disk.map(Arc::new),
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

/// A descriptor on a VM's disk that the host opens before the VM's VMM
/// starts and keeps for the VM's life.
///
/// Firecracker logs and ignores a failed flush of a disk, so the guest's
/// writes can be lost without the VMM reporting it. Linux reports a
/// writeback error on `fsync` through every descriptor that was open when
/// it happened, even after another descriptor has seen it, so syncing this
/// one before a snapshot is trusted catches every write lost since the VM
/// started. A failure is final: the disk lost writes, and no snapshot of
/// this VM is trusted again.
#[derive(Debug)]
pub(crate) struct DiskWatch {
    file: fs::File,
    failed: AtomicBool,
}

impl DiskWatch {
    /// Opens the watch on the disk at `path`, in the VM's jail.
    pub fn open(path: &Path) -> io::Result<Self> {
        Ok(Self {
            file: crate::layout::open_jailed(path)?,
            failed: AtomicBool::new(false),
        })
    }

    /// Flushes the disk, failing if any write to it was lost since the
    /// watch was opened.
    pub(super) fn sync(&self, path: &Path) -> io::Result<()> {
        if !self.failed.load(Ordering::Acquire) {
            match crate::layout::failpoint(path, "sync").and_then(|()| self.file.sync_all()) {
                Ok(()) => return Ok(()),
                Err(error) => {
                    tracing::error!(disk = %path.display(), %error, "the disk lost writes");
                    self.failed.store(true, Ordering::Release);
                }
            }
        }
        Err(io::Error::other(format!(
            "{} lost writes since its VM started",
            path.display()
        )))
    }

    pub(super) fn failed(&self) -> bool {
        self.failed.load(Ordering::Acquire)
    }
}
