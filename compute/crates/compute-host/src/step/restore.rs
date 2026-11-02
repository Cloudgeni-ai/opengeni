//! The restore step: waking a sandbox from its saved memory image.
//!
//! The image is linked into the jail and served to the VMM straight from
//! its file or through a pager (fetching from the store when its memory is
//! still there), and marked stale only once the restored VM is recorded as
//! running, before its guest runs. A VMM that refuses the image settles it
//! only when the image is proven bad or can never be read here; otherwise
//! the refusal may have been the host's, and the image is kept for a retry.

use std::sync::Arc;
use std::time::Duration;

use compute_core::{Failure, Outcome};
use compute_engine::{
    Engine, EngineError, ErrorKind, MemoryProfile, MemorySource, Readable, RestoreFiles,
};

use super::{
    After, Base, DiskWatch, Job, LiveMemory, blocking, failure, images_of, io_failure, link,
    paged_marker, state_failure, suspect_error,
};
#[cfg(target_os = "linux")]
use super::{learned, pager_control, pager_dir, pager_learned, wake_profile};
use crate::image::{Images, Suspect, Verified};
use crate::layout::remove_durably;
#[cfg(target_os = "linux")]
use crate::layout::{remove_if_present, write_atomic};
#[cfg(target_os = "linux")]
use crate::lazy::Hydration;
use crate::observe::notes;
#[cfg(target_os = "linux")]
use crate::paging::Paging;
use crate::state::{Change, Disk};
use crate::store::Store;
#[cfg(target_os = "linux")]
use crate::working_set::{PageSet, READY_BYTES, WakeProfile};

/// Longest a wake waits for its learned working set before resuming the
/// guest anyway; whatever is missing then arrives on demand.
const PREFETCH_LIMIT: Duration = Duration::from_secs(5);
/// How many times in a row a sandbox's wakes may fail, the last one the
/// VMM refusing an image made on another kind of host, before the
/// sandbox gives the image up and boots from its disk. With the wake
/// backoff that is a few seconds: room for a refusal that was the host's,
/// such as a pager that could not start, to pass.
pub(super) const REFUSALS_FROM_ELSEWHERE: u32 = 5;

impl<E: Engine, S: Store> Job<E, S> {
    /// Starts from the saved image, marks the image stale before the guest
    /// runs, then resumes.
    pub(super) async fn restore(&mut self) -> (Outcome, After<E::Vm>) {
        const OP: &str = "restore";
        if !self.record.image || self.record.disk != Disk::Local {
            return (Outcome::Failed(Failure::MemoryLost), After::NoVm);
        }
        let images = images_of(&self.paths);
        let image = match self.saved_image(&images).await {
            Ok(image) => image,
            Err(outcome) => return (outcome, After::NoVm),
        };
        notes::phase("verify");
        let paths = self.paths.clone();
        let watch = match blocking(move || DiskWatch::fresh(&paths))
            .await
            .and_then(|opened| opened)
        {
            Ok(watch) => watch,
            Err(error) => return (io_failure(OP, error), After::NoVm),
        };
        let (memory, live_memory) = match self.memory_source(&images, &image, watch) {
            Ok(prepared) => prepared,
            Err(error) => return (failure(&error), After::NoVm),
        };
        let source = match &memory {
            MemorySource::File(_) => "file",
            MemorySource::Pager(_) if image.meta().remote => "remote",
            MemorySource::Pager(_) => "pager",
        };
        notes::detail("compute.memory.source", source);
        let files = RestoreFiles {
            state: self.paths.snapshot.state.clone(),
            memory,
            made_under: image.meta().runtime.clone(),
        };
        // On any failure below the VM process is gone before its memory's
        // pager and hydration are stopped and joined, so a retry never
        // fills the same file beside them.
        if let Err(error) = self.launching() {
            live_memory.close().await;
            return (io_failure(OP, error), After::NoVm);
        }
        let vm = match self.engine.restore(&self.spec, &files).await {
            Ok(vm) => {
                self.launches += 1;
                self.hold_watch(&vm, &live_memory.disk).await;
                self.record_started(&vm, Some(&image)).await;
                vm
            }
            Err(error) => {
                self.launches += u32::from(error.launched);
                let outcome = if error.kind == ErrorKind::MemoryLost {
                    self.rejected(&images, &image, &live_memory, &error).await
                } else {
                    failure(&error)
                };
                if error.kind == ErrorKind::Fatal {
                    // A VMM the engine could not end may still run on this
                    // memory: its guest must never wait forever on a page.
                    live_memory.serve_detached();
                } else {
                    live_memory.close().await;
                }
                return (outcome, After::NoVm);
            }
        };
        notes::phase("load");
        // Before the image is marked stale, so a failure may try it again.
        if let Err(error) = self.tell_disk_length(&vm).await {
            let outcome = self.end_with_memory(vm, live_memory, failure(&error)).await;
            return (outcome, After::NoVm);
        }
        let archived = self.record.archived;
        // A restore continues the saved execution: the generation stays.
        let running = Change::new().image(false).archived(false);
        if let Err(error) = self.commit(running).await {
            let outcome = self
                .end_with_memory(vm, live_memory, state_failure(&error))
                .await;
            return (outcome, After::NoVm);
        }
        notes::phase("commit");
        #[cfg(target_os = "linux")]
        if let Some(paging) = &live_memory.paging {
            paging.prefetched(PREFETCH_LIMIT).await;
        }
        notes::phase("prefetch");
        if let Err(error) = self.engine.resume(&vm).await {
            // The VM ends before the image is reconsidered, so no second
            // process ever runs from the same files.
            let ended = self.end_with_memory(vm, live_memory, Outcome::Done).await;
            if ended != Outcome::Done {
                return (ended, After::NoVm);
            }
            return (
                self.after_failed_wake(&error, true, archived).await,
                After::NoVm,
            );
        }
        // The host's share of a restore is done; the guest's answer is
        // not the limit's concern.
        self.unthrottle();
        notes::phase("resume");
        let told = self.tell_guest_restored().await;
        notes::phase("notice");
        tracing::debug!(id = %self.id, source, "memory image restored");
        if let Err(outcome) = told {
            return (outcome, After::New(vm, live_memory));
        }
        self.woke().await;
        (Outcome::Done, After::New(vm, live_memory))
    }

    /// Decides what the VMM refusing to load `image` means. The image is
    /// given up only when it is proven bad: a local image that fails the
    /// deep check goes to quarantine, a remote image whose store copy is
    /// bad or gone is dropped, and an image in a snapshot format no VMM the
    /// engine keeps can read is given up, since none ever will. Otherwise
    /// the refusal may have been the host's (memory short, a pager that
    /// could not start or reach the store, a VMM killed while loading) and
    /// the image is kept for a retry. An image made on another kind of
    /// host (another processor model or host kernel) is kept too, but only
    /// for [`REFUSALS_FROM_ELSEWHERE`] wakes in a row: its saved processor
    /// state may not fit this host, which does not change while it runs,
    /// and nothing sends the sandbox to a host like the one that made it.
    async fn rejected(
        &mut self,
        images: &Images,
        image: &Verified,
        memory: &LiveMemory,
        error: &EngineError,
    ) -> Outcome {
        const OP: &str = "restore";
        tracing::warn!(id = %self.id, %error, "the VMM refused the memory image");
        let made_under = image.meta().runtime.as_deref().unwrap_or("");
        if let Some(why) = self.refused_for_good(made_under) {
            if let Err(error) = self.commit(Change::new().image(false)).await {
                return state_failure(&error);
            }
            return failure(&EngineError::new(
                ErrorKind::MemoryLost,
                OP,
                format!("{why}; {error}"),
            ));
        }
        if image.meta().remote {
            #[cfg(target_os = "linux")]
            let lost = memory
                .paging
                .as_ref()
                .and_then(|paging| paging.hydration.as_ref())
                .and_then(|hydration| hydration.failure())
                .filter(|why| why.permanent);
            #[cfg(not(target_os = "linux"))]
            let lost: Option<String> = {
                let _ = memory;
                None
            };
            if let Some(why) = lost {
                if let Err(error) = self.commit(Change::new().image(false)).await {
                    return state_failure(&error);
                }
                return failure(&EngineError::caused_by(ErrorKind::MemoryLost, OP, why));
            }
            return failure(&EngineError::new(
                ErrorKind::Transient,
                OP,
                error.to_string(),
            ));
        }
        let checked = {
            let images = images.clone();
            let generation = image.generation();
            blocking(move || images.verify(generation, crate::image::Depth::Deep)).await
        };
        match checked {
            Ok(Ok(_)) => {
                tracing::warn!(
                    id = %self.id,
                    "the refused image passes every check; keeping it and trying again"
                );
                failure(&EngineError::new(
                    ErrorKind::Transient,
                    OP,
                    error.to_string(),
                ))
            }
            Ok(Err(Suspect::Io(error))) | Err(error) => io_failure(OP, error),
            Ok(Err(suspect)) => {
                self.quarantine_current(images, &suspect).await;
                failure(&suspect_error(OP, suspect))
            }
        }
    }

    /// Why the VMM refusing an image made under `made_under` settles it,
    /// if it does: no VMM the engine keeps reads its format, or it was made
    /// on another kind of host and this is its
    /// [`REFUSALS_FROM_ELSEWHERE`]th wake in a row to fail.
    fn refused_for_good(&self, made_under: &str) -> Option<String> {
        match self.engine.reads(made_under) {
            Readable::No(why) => {
                tracing::warn!(
                    id = %self.id,
                    made_under,
                    why,
                    "no VMM here reads the refused image; waking from the disk"
                );
                Some(format!("the memory image cannot be read here: {why}"))
            }
            Readable::Elsewhere(why) => {
                let refusals = self.failures.saturating_add(1);
                if refusals < REFUSALS_FROM_ELSEWHERE {
                    tracing::warn!(
                        id = %self.id,
                        made_under,
                        why,
                        refusals,
                        "the refused image was made on another kind of host"
                    );
                    return None;
                }
                tracing::warn!(
                    id = %self.id,
                    made_under,
                    why,
                    refusals,
                    "the VMM keeps refusing an image made on another kind of host; \
                     waking from the disk"
                );
                Some(format!(
                    "the memory image was refused {refusals} wakes in a row, and {why}"
                ))
            }
            Readable::Yes | Readable::Unknown => {
                if made_under != self.engine.runtime() {
                    tracing::warn!(
                        id = %self.id,
                        made_under,
                        runtime = self.engine.runtime(),
                        "the refused image was made under another runtime"
                    );
                }
                None
            }
        }
    }

    /// Links `image` into the jail and decides how the VM's memory is
    /// served: mapped straight from the file where the profile allows,
    /// otherwise through a pager, fetching from the store if the image's
    /// memory is still there.
    fn memory_source(
        &self,
        images: &Images,
        image: &Verified,
        disk: DiskWatch,
    ) -> Result<(MemorySource, LiveMemory), EngineError> {
        const OP: &str = "restore";
        let paths = &self.paths;
        let generation = image.generation();
        let io = |error| EngineError::io(OP, error);
        link(&images.state(generation), &paths.snapshot.state).map_err(io)?;
        let profile: MemoryProfile = self.engine.memory_profile();
        let mut live = LiveMemory {
            base: Base::Image(generation),
            #[cfg(target_os = "linux")]
            paging: None,
            disk: Arc::new(disk),
        };
        if !image.meta().remote && !profile.needs_pager() {
            link(&images.memory(generation), &paths.snapshot.memory).map_err(io)?;
            remove_durably(&paged_marker(paths)).map_err(io)?;
            return Ok((MemorySource::File(paths.snapshot.memory.clone()), live));
        }
        #[cfg(target_os = "linux")]
        {
            let (paging, tag) = self.start_paging(images, image)?;
            let socket = paths.in_jail("uffd.sock");
            let options = compute_pager::linux::serve::Options {
                vmm_socket: socket.clone(),
                control: pager_control(paths),
                memory: images.memory(generation),
                tag,
                complete: !image.meta().remote,
                profile: Some(wake_profile(paths)),
                learned: Some(pager_learned(paths)),
                ready_bytes: READY_BYTES,
                record_for: self.pager.record_for,
                // The engine adds the VMM's API socket, which it places.
                api_socket: None,
                // And the VM's user, which it knows.
                user: None,
            };
            live.paging = Some(paging);
            let mut args = vec![std::ffi::OsString::from("pager")];
            args.extend(options.args());
            let pager = compute_engine::PagerSpec {
                socket,
                dir: pager_dir(paths),
                program: self.pager.program.clone(),
                args,
            };
            Ok((MemorySource::Pager(pager), live))
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = live;
            Err(EngineError::new(
                ErrorKind::Fatal,
                OP,
                "paged memory needs Linux",
            ))
        }
    }

    /// Starts the agent's side of the pager about to serve `image`: marks
    /// the sandbox as paged by this launch and, for a remote image, starts
    /// filling its memory file. Returns it with the launch's tag.
    #[cfg(target_os = "linux")]
    fn start_paging(
        &self,
        images: &Images,
        image: &Verified,
    ) -> Result<(Paging, String), EngineError> {
        const OP: &str = "restore";
        let io = |error| EngineError::io(OP, error);
        let paths = &self.paths;
        let generation = image.generation();
        let memory = images.memory(generation);
        let control = pager_control(paths);
        let tag = crate::paging::tag(generation);
        let file = (
            crate::paging::identity(&memory).map_err(io)?,
            std::fs::metadata(&memory).map_err(io)?.len(),
        );
        learned::make_dir(&pager_dir(paths)).map_err(io)?;
        // What the last pager learned, the one this pager starts from.
        learned::take(&pager_learned(paths), &wake_profile(paths), Some(file.1));
        remove_if_present(&crate::paging::done_file(&control)).map_err(io)?;
        // Written before the pager starts, so an agent that restarts knows
        // the VM's memory may need it, and which launch to look for.
        write_atomic(&paged_marker(paths), tag.as_bytes()).map_err(io)?;
        if !image.meta().remote {
            let paging = Paging::start(control, tag.clone(), file, None, Vec::new());
            return Ok((paging, tag));
        }
        let Some(fetcher) = &self.fetcher else {
            return Err(EngineError::new(
                ErrorKind::MemoryLost,
                OP,
                "the memory image is in a store this host cannot page from",
            ));
        };
        let (refs, hashes) = crate::paging::remote_chunks(images, image, OP)?;
        let filled = images.filled(image).map_err(io)?;
        let first = WakeProfile::load(&wake_profile(paths)).offsets;
        let hydration = Hydration::start(
            Arc::clone(fetcher),
            &memory,
            refs,
            hashes,
            PageSet::new(&filled),
            &[],
            &first,
        )
        .map_err(io)?;
        let paging = Paging::start(control, tag.clone(), file, Some(hydration), filled);
        Ok((paging, tag))
    }
}
