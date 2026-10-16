//! What a live VM's saved state depends on: the memory its next snapshot
//! is relative to, and the host's watch on its disk.

use std::fs;
use std::io;
use std::os::fd::OwnedFd;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::image::Generation;
use crate::layout::Paths;
use compute_engine::{EngineError, ErrorKind};

#[cfg(target_os = "linux")]
use crate::paging::Paging;

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
    /// The agent's side of the pager process serving its memory, if one
    /// does.
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

    /// A VM found running after an agent restart whose pager the agent
    /// reconnected to: what its memory is based on is unknown.
    pub fn reconnected(disk: DiskWatch, pager: Reconnected) -> Self {
        #[cfg(not(target_os = "linux"))]
        let Reconnected {} = pager;
        Self {
            base: Base::Unknown,
            #[cfg(target_os = "linux")]
            paging: Some(pager.paging),
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

    /// Says the agent is about to end the VM, so its pager going away is
    /// expected rather than lost memory. Call it before stopping the VM.
    pub fn ending(&self) {
        #[cfg(target_os = "linux")]
        if let Some(paging) = &self.paging {
            paging.ending();
        }
    }

    /// Waits until the image this VM's memory comes from is whole and its
    /// pager, if it has one, holds every byte: until then the image must
    /// stay the current one, unsealed and in place, so an agent that
    /// restarts can still fill it by name. Saves and forgetting the image
    /// wait for this.
    pub async fn settled(&self, operation: &'static str) -> Result<(), EngineError> {
        #[cfg(target_os = "linux")]
        if let Some(paging) = &self.paging {
            if let Some(hydration) = paging.hydration.clone() {
                hydration.finished().await.map_err(|why| {
                    let kind = if why.permanent {
                        ErrorKind::MemoryLost
                    } else {
                        ErrorKind::Transient
                    };
                    EngineError::caused_by(kind, operation, why)
                })?;
            }
            paging.complete().await.map_err(|why| {
                let kind = match why {
                    crate::paging::Incomplete::Failed => ErrorKind::MemoryLost,
                    crate::paging::Incomplete::Stopped => ErrorKind::Transient,
                };
                EngineError::new(kind, operation, "the pager does not hold the whole image")
            })?;
        }
        #[cfg(not(target_os = "linux"))]
        let _ = operation;
        Ok(())
    }

    /// For a VM that has ended and whose files are about to be deleted:
    /// stops serving and fetching its memory and returns once nothing more
    /// will be written for it.
    pub async fn close(self) {
        #[cfg(target_os = "linux")]
        if let Some(paging) = &self.paging {
            paging.close().await;
        }
    }
}

/// The pager of a VM found running after an agent restart, reconnected
/// before the VM itself is taken back.
#[derive(Debug)]
pub(crate) struct Reconnected {
    #[cfg(target_os = "linux")]
    pub paging: Paging,
}

impl Reconnected {
    /// For a VM that was not taken back after all: stops serving and
    /// fetching its memory.
    pub async fn close(self) {
        #[cfg(target_os = "linux")]
        self.paging.close().await;
    }

    /// For a VM that may still run but was not taken back: goes on serving
    /// and fetching its memory in the background until the pager holds all
    /// of it, or ends with the VM, so its guest never waits forever on a
    /// page. The pager needs no agent after that.
    pub fn serve_detached(self) {
        #[cfg(target_os = "linux")]
        tokio::spawn(async move {
            let _ = self.paging.complete().await;
        });
    }
}

/// The host's watch on a VM's disk, which decides whether a snapshot of
/// the VM can be trusted to match a disk that is durable.
///
/// Firecracker logs and ignores a failed flush of a disk, so the guest's
/// writes can be lost without the VMM reporting it. Linux keeps a
/// writeback error for each open file description: `fsync` through one
/// reports every error since that description was opened, or since it
/// last reported one, whatever other descriptions reported meanwhile. A
/// description opened later only sees errors no `fsync` has reported yet,
/// and the VMM syncs its own on a snapshot or whenever the guest asks
/// (which it may, offered or not).
///
/// So the watch holds a description opened before the VM's VMM starts,
/// which only the watch ever syncs, after each snapshot: that sees every
/// write lost since the VM started. The VM's engine keeps the same
/// description for as long as the VM lives ([`Engine::hold`]), so an agent
/// that restarts beside the VM gets it back ([`Engine::held`]) and sees
/// all the same. Before the VMM can sync the disk, a check marker is made
/// durable in the host-only sandbox directory, and only a clean sync
/// removes it: a sync that reported an error to an agent that stopped
/// before it could act ran under the marker, which the next agent finds.
/// A failure is final for the VM: no snapshot of it is trusted again.
///
/// [`Engine::hold`]: compute_engine::Engine::hold
/// [`Engine::held`]: compute_engine::Engine::held
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

    /// The watch for a VM found running after an agent restart, through
    /// `held`, the description the VM's engine kept for it. It has failed
    /// if a check was under way, since a sync may have reported a lost
    /// write to no one, or if nothing was kept or what was is not the
    /// VM's disk: either way lost writes could go unseen, so no snapshot is
    /// trusted.
    pub fn adopt(paths: &Paths, held: Option<OwnedFd>) -> Self {
        let file = held
            .ok_or_else(|| io::Error::other("no description of the disk was kept"))
            .and_then(|held| {
                let held = fs::File::from(held);
                let disk = crate::layout::open_jailed(&paths.disk)?.metadata()?;
                let kept = held.metadata()?;
                if (kept.dev(), kept.ino()) == (disk.dev(), disk.ino()) {
                    Ok(held)
                } else {
                    Err(io::Error::other("the kept description is of another file"))
                }
            })
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

    /// A new descriptor for the watch's open file description, for the
    /// engine to keep; `None` if the watch has none.
    pub(super) fn description(&self) -> io::Result<Option<OwnedFd>> {
        self.file
            .as_ref()
            .map(|file| file.try_clone().map(OwnedFd::from))
            .transpose()
    }

    /// Starts a check, before anything may sync the disk.
    pub(super) fn begin(&self) -> io::Result<()> {
        if self.failed() {
            return Err(self.lost());
        }
        crate::layout::write_atomic(&self.marker, b"")
    }

    /// Flushes the disk, failing if any write to it was lost since the
    /// watch was opened, and ends the check that [`DiskWatch::begin`]
    /// started if none was.
    pub(super) fn sync(&self) -> io::Result<()> {
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

    pub(crate) fn failed(&self) -> bool {
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
