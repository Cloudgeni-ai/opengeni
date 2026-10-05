use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_FRAME_AGE: Duration = Duration::from_secs(2);
const MAX_FRAMES_PER_TARGET: usize = 32;
const MAX_FRAMES: usize = 512;

pub(crate) struct CapturedFrame<T> {
    target_id: String,
    frame_id: String,
    superseded_at: Option<Instant>,
    continuation_only: bool,
    invalidation_generation: u64,
    value: T,
}

struct ConfirmedClick<T> {
    operation_id: String,
    target_id: String,
    frame: T,
    x: f64,
    y: f64,
    button: crate::NativePointerButton,
    confirmed_at: Instant,
    invalidation_generation: u64,
}

#[derive(Default)]
struct InvalidationState {
    generation: u64,
    next_admission: u64,
    active_mutations: BTreeMap<u64, Option<String>>,
}

/// One exact nonpointer dispatch invocation. Completion, cancellation and panic
/// synchronously revoke its generation, even when the async frame lock is busy.
/// The invocation nonce keeps overlapping commands with the same operation ID
/// from completing each other's admission.
pub(crate) struct FrameMutationGuard {
    state: Arc<Mutex<InvalidationState>>,
    admission: u64,
}

impl Drop for FrameMutationGuard {
    fn drop(&mut self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.active_mutations.remove(&self.admission).is_some() {
            state.generation = state.generation.wrapping_add(1);
        }
    }
}

/// Metadata for recently painted frames. New captures do not invalidate a
/// viewer's pending gesture; callers still validate the exact live target,
/// generation and geometry before input. Latest still frames keep their
/// existing authority; only superseded metadata expires. No image bytes are
/// retained here.
pub(crate) struct CapturedFrames<T> {
    frames: VecDeque<CapturedFrame<T>>,
    invalidation: Arc<Mutex<InvalidationState>>,
    confirmed_click: Option<ConfirmedClick<T>>,
}

impl<T> CapturedFrames<T> {
    pub(crate) fn new() -> Self {
        Self {
            frames: VecDeque::new(),
            invalidation: Arc::new(Mutex::new(InvalidationState::default())),
            confirmed_click: None,
        }
    }

    pub(crate) fn insert(&mut self, target_id: String, frame_id: String, value: T) {
        self.insert_at(target_id, frame_id, value, Instant::now());
    }

    fn insert_at(&mut self, target_id: String, frame_id: String, value: T, now: Instant) {
        let generation = self.generation();
        self.frames.retain(|frame| {
            frame.invalidation_generation == generation
                && frame
                    .superseded_at
                    .is_none_or(|at| now.saturating_duration_since(at) <= MAX_FRAME_AGE)
        });
        if let Some(latest) = self
            .frames
            .iter_mut()
            .rev()
            .find(|frame| frame.target_id == target_id && frame.superseded_at.is_none())
        {
            latest.superseded_at = Some(now);
        }
        while self
            .frames
            .iter()
            .filter(|frame| frame.target_id == target_id)
            .count()
            >= MAX_FRAMES_PER_TARGET
        {
            if let Some(index) = self
                .frames
                .iter()
                .position(|frame| frame.target_id == target_id)
            {
                self.frames.remove(index);
            }
        }
        self.frames.push_back(CapturedFrame {
            target_id,
            frame_id,
            superseded_at: None,
            continuation_only: false,
            invalidation_generation: generation,
            value,
        });
        while self.frames.len() > MAX_FRAMES {
            // Keep still observations while any superseded metadata can be
            // evicted. Only a new target beyond the global limit evicts a
            // latest frame, matching the previous target-cache bound.
            let oldest = self
                .frames
                .iter()
                .position(|frame| frame.superseded_at.is_some())
                .unwrap_or(0);
            self.frames.remove(oldest);
        }
    }

    pub(crate) fn get(&self, target_id: &str, frame_id: &str) -> Option<&T> {
        self.find_at(target_id, frame_id, Instant::now(), false)
    }

    pub(crate) fn get_for_action(
        &self,
        target_id: &str,
        frame_id: &str,
        action: &crate::NativeAction,
        same_geometry: impl Fn(&T, &T) -> bool,
    ) -> Option<&T> {
        if let crate::NativeAction::Pointer {
            action: crate::NativePointerAction::Click,
            click_count: Some(2),
            continuation_of_operation_id,
            x,
            y,
            button,
            ..
        } = action
        {
            let state = self
                .invalidation
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let confirmed = self.confirmed_click.as_ref()?;
            if !state.active_mutations.is_empty()
                || confirmed.invalidation_generation != state.generation
                || continuation_of_operation_id.as_deref() != Some(&confirmed.operation_id)
                || confirmed.target_id != target_id
                || confirmed.confirmed_at.elapsed() > MAX_FRAME_AGE
                || button.unwrap_or(crate::NativePointerButton::Left) != confirmed.button
                || (x - confirmed.x).hypot(y - confirmed.y) >= 6.0
            {
                return None;
            }
            let frame = self.find_at_generation(
                target_id,
                frame_id,
                Instant::now(),
                true,
                state.generation,
            )?;
            same_geometry(&confirmed.frame, frame).then_some(frame)
        } else {
            self.get(target_id, frame_id)
        }
    }

    #[cfg(test)]
    fn get_at(&self, target_id: &str, frame_id: &str, now: Instant) -> Option<&T> {
        self.find_at(target_id, frame_id, now, false)
    }

    fn find_at(
        &self,
        target_id: &str,
        frame_id: &str,
        now: Instant,
        continuation: bool,
    ) -> Option<&T> {
        self.find_at_generation(target_id, frame_id, now, continuation, self.generation())
    }

    fn find_at_generation(
        &self,
        target_id: &str,
        frame_id: &str,
        now: Instant,
        continuation: bool,
        generation: u64,
    ) -> Option<&T> {
        self.frames
            .iter()
            .rev()
            .find(|frame| {
                frame.target_id == target_id
                    && frame.frame_id == frame_id
                    && frame.invalidation_generation == generation
                    && (continuation || !frame.continuation_only)
                    && frame
                        .superseded_at
                        .is_none_or(|at| now.saturating_duration_since(at) <= MAX_FRAME_AGE)
            })
            .map(|frame| &frame.value)
    }

    pub(crate) fn latest(&self, target_id: &str) -> Option<&T> {
        let generation = self.generation();
        self.frames
            .iter()
            .rev()
            .find(|frame| {
                frame.target_id == target_id
                    && frame.invalidation_generation == generation
                    && frame.superseded_at.is_none()
                    && !frame.continuation_only
            })
            .map(|frame| &frame.value)
    }

    pub(crate) fn clear(&mut self) {
        let invalidation = Arc::clone(&self.invalidation);
        let mut state = invalidation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.clear_in_generation(&mut state);
    }

    fn clear_in_generation(&mut self, state: &mut InvalidationState) {
        self.frames.clear();
        self.confirmed_click = None;
        state.generation = state.generation.wrapping_add(1);
    }

    fn generation(&self) -> u64 {
        self.invalidation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .generation
    }

    fn begin_mutation(&mut self, operation_id: Option<&str>) -> FrameMutationGuard {
        self.clear();
        let mut state = self
            .invalidation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            state.next_admission = state.next_admission.wrapping_add(1);
            if !state.active_mutations.contains_key(&state.next_admission) {
                break;
            }
        }
        let admission = state.next_admission;
        state
            .active_mutations
            .insert(admission, operation_id.map(str::to_owned));
        FrameMutationGuard {
            state: Arc::clone(&self.invalidation),
            admission,
        }
    }

    #[cfg(test)]
    fn take_click_frames(
        &mut self,
        target_id: &str,
        frame_id: &str,
        same_geometry: impl Fn(&T, &T) -> bool,
    ) -> Vec<CapturedFrame<T>> {
        let invalidation = Arc::clone(&self.invalidation);
        let mut state = invalidation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let retained = self.take_click_frames_in_generation(
            target_id,
            frame_id,
            same_geometry,
            state.generation,
        );
        self.clear_in_generation(&mut state);
        retained
    }

    fn take_click_frames_in_generation(
        &mut self,
        target_id: &str,
        frame_id: &str,
        same_geometry: impl Fn(&T, &T) -> bool,
        generation: u64,
    ) -> Vec<CapturedFrame<T>> {
        let selected = self.frames.iter().position(|frame| {
            frame.target_id == target_id
                && frame.frame_id == frame_id
                && frame.invalidation_generation == generation
        });
        let mut retained = Vec::new();
        if let Some(index) = selected {
            let now = Instant::now();
            let clicked = &self.frames[index];
            let eligible: Vec<bool> = self
                .frames
                .iter()
                .enumerate()
                .map(|(position, frame)| {
                    position >= index
                        && frame.target_id == target_id
                        && frame.invalidation_generation == generation
                        && same_geometry(&clicked.value, &frame.value)
                        && frame
                            .superseded_at
                            .is_none_or(|at| now.saturating_duration_since(at) <= MAX_FRAME_AGE)
                })
                .collect();
            for (position, mut frame) in self.frames.drain(..).enumerate() {
                if !eligible[position] {
                    continue;
                }
                // Exact prior deadlines survive repeated continuations. Latest
                // pre-click captures get one bounded continuation deadline.
                frame.superseded_at.get_or_insert(now);
                if position != index {
                    frame.continuation_only = true;
                }
                retained.push(frame);
            }
        }
        retained
    }

    fn restore_click_frame(&mut self, mut frame: CapturedFrame<T>, generation: u64) {
        if frame
            .superseded_at
            .is_some_and(|at| at.elapsed() > MAX_FRAME_AGE)
            || self.frames.len() >= MAX_FRAMES
            || self
                .frames
                .iter()
                .filter(|entry| entry.target_id == frame.target_id)
                .count()
                >= MAX_FRAMES_PER_TARGET
            || self
                .frames
                .iter()
                .any(|entry| entry.target_id == frame.target_id && entry.frame_id == frame.frame_id)
        {
            return;
        }
        frame.invalidation_generation = generation;
        self.frames.push_front(frame);
    }
}

/// Background mutations stay independent from physical-seat delivery. Their
/// admission nevertheless fences click proof for the whole future's lifetime.
pub(crate) async fn dispatch_with_mutation_invalidation<T, O>(
    frames: &tokio::sync::RwLock<CapturedFrames<T>>,
    operation_id: Option<&str>,
    delivery: impl std::future::Future<Output = crate::NativeAdapterResult<O>>,
) -> crate::NativeAdapterResult<O> {
    let guard = frames.write().await.begin_mutation(operation_id);
    let result = delivery.await;
    drop(guard);
    result
}

/// Remove input authority during delivery. Confirmed success restores the exact
/// first-click operation and bounded matching captures for one count-2 input.
/// Frames alone never prove delivery. Failure/unknown/intervening mutation
/// revoke both the causal proof and retained input authority.
// Keep admission, delivery and settlement in one sequence so the shared
// mutation epoch cannot be renewed across the asynchronous boundary.
#[allow(clippy::too_many_lines)]
pub(crate) async fn dispatch_with_frame_invalidation<T: Clone, O>(
    frames: &tokio::sync::RwLock<CapturedFrames<T>>,
    command: Option<&crate::NativeActionCommand>,
    same_geometry: impl Fn(&T, &T) -> bool,
    delivery: impl std::future::Future<Output = crate::NativeAdapterResult<O>>,
) -> crate::NativeAdapterResult<O> {
    let (retained, generation, first_click) = {
        let mut frames = frames.write().await;
        // RAII completion can advance the shared epoch independently of this
        // async frame lock. Never replace this original epoch after Clone.
        let admission_generation = frames.generation();
        if let Some(command) = command {
            if let Err(message) = command.validate_click_identity() {
                frames.clear();
                return Err(crate::NativeAdapterError::definite(
                    crate::NativeAdapterErrorCode::InvalidAction,
                    message,
                    false,
                ));
            }
            if let crate::NativeAction::Pointer { frame_id, .. } = &command.action {
                if command.expected_frame_id.as_deref() != Some(frame_id)
                    || frames
                        .get_for_action(
                            &command.target_id,
                            command.expected_frame_id.as_deref().unwrap_or(""),
                            &command.action,
                            &same_geometry,
                        )
                        .is_none()
                {
                    frames.clear();
                    return Err(crate::NativeAdapterError::definite(
                        crate::NativeAdapterErrorCode::FrameStale,
                        "pointer frame has no current input authority",
                        false,
                    ));
                }
            }
        }
        let first_click = command.and_then(|command| {
            let crate::NativeAction::Pointer {
                action: crate::NativePointerAction::Click,
                frame_id,
                x,
                y,
                button,
                ..
            } = &command.action
            else {
                return None;
            };
            if command.action.pointer_click_count() != Ok(1) {
                return None;
            }
            let operation_id = command.operation_id.as_ref()?;
            if uuid::Uuid::parse_str(operation_id).is_err() {
                return None;
            }
            let frame = frames.get(&command.target_id, frame_id)?.clone();
            Some(ConfirmedClick {
                operation_id: operation_id.clone(),
                target_id: command.target_id.clone(),
                frame,
                x: *x,
                y: *y,
                button: button.unwrap_or(crate::NativePointerButton::Left),
                confirmed_at: Instant::now(),
                invalidation_generation: admission_generation,
            })
        });
        // Only native metadata comparisons run inside this final barrier.
        // No Clone or await can let a completed background epoch be renewed.
        let invalidation = Arc::clone(&frames.invalidation);
        let mut state = invalidation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.generation != admission_generation
            && command.is_some_and(|command| {
                matches!(command.action, crate::NativeAction::Pointer { .. })
            })
        {
            frames.clear_in_generation(&mut state);
            return Err(crate::NativeAdapterError::definite(
                crate::NativeAdapterErrorCode::FrameStale,
                "pointer frame generation changed before delivery",
                false,
            ));
        }
        let click_frame = command.and_then(crate::NativeActionCommand::retained_click_frame);
        let retained = if let Some((target_id, frame_id)) = click_frame {
            frames.take_click_frames_in_generation(
                target_id,
                frame_id,
                &same_geometry,
                admission_generation,
            )
        } else {
            Vec::new()
        };
        frames.clear_in_generation(&mut state);
        (retained, state.generation, first_click)
    };
    let result = delivery.await;
    let mut frames = frames.write().await;
    if result.is_ok() {
        let invalidation = Arc::clone(&frames.invalidation);
        let state = invalidation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.generation == generation && state.active_mutations.is_empty() {
            for retained in retained.into_iter().rev() {
                frames.restore_click_frame(retained, generation);
            }
            // A continuation consumes rather than renews the first proof.
            frames.confirmed_click = first_click.map(|mut proof| {
                proof.invalidation_generation = generation;
                proof
            });
        }
    } else {
        frames.clear();
    }
    result
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn a_prevalidated_clone_cannot_deliver_or_retag_a_completed_background_frame() {
        let frames = tokio::sync::RwLock::new(super::CapturedFrames::new());
        let mut validated = None;
        super::dispatch_with_mutation_invalidation(&frames, None, async {
            frames
                .write()
                .await
                .insert("screen-1".into(), "painted-a".into(), (400, 300));
            validated = frames
                .read()
                .await
                .get_for_action(
                    "screen-1",
                    "painted-a",
                    &click("painted-a", 1).action,
                    |a, b| a == b,
                )
                .copied();
            Ok::<(), crate::NativeAdapterError>(())
        })
        .await
        .unwrap();
        assert_eq!(validated, Some((400, 300)));
        let mut delivered = false;
        let error = super::dispatch_with_frame_invalidation(
            &frames,
            Some(&click("painted-a", 1)),
            |a, b| a == b,
            async {
                delivered = true;
                Ok::<(), crate::NativeAdapterError>(())
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, crate::NativeAdapterErrorCode::FrameStale);
        assert!(!delivered);
        assert!(frames.read().await.get("screen-1", "painted-a").is_none());
    }

    type CloneCancellation = Box<dyn FnOnce() + Send>;
    type CloneHook = std::sync::Arc<std::sync::Mutex<Option<CloneCancellation>>>;

    struct ScheduledCloneFrame {
        geometry: (u32, u32),
        cancel_at_clone: CloneHook,
    }

    impl Clone for ScheduledCloneFrame {
        fn clone(&self) -> Self {
            // Model another task's completion while immutable metadata clones.
            let cancel = self.cancel_at_clone.lock().unwrap().take();
            if let Some(cancel) = cancel {
                cancel();
            }
            Self {
                geometry: self.geometry,
                cancel_at_clone: std::sync::Arc::clone(&self.cancel_at_clone),
            }
        }
    }

    #[tokio::test]
    async fn guard_drop_during_first_clone_refuses_both_deliveries_without_renewing_epoch() {
        use std::future::Future;
        use std::task::{Context, Poll, Waker};
        let frames = std::sync::Arc::new(tokio::sync::RwLock::new(super::CapturedFrames::new()));
        let background_frames = std::sync::Arc::clone(&frames);
        let mut background = Box::pin(async move {
            super::dispatch_with_mutation_invalidation(&background_frames, None, async {
                std::future::pending::<crate::NativeAdapterResult<()>>().await
            })
            .await
        });
        let mut context = Context::from_waker(Waker::noop());
        assert!(matches!(
            background.as_mut().poll(&mut context),
            Poll::Pending
        ));
        let cancel: Box<dyn FnOnce() + Send> = Box::new(move || drop(background));
        frames.write().await.insert(
            "screen-1".into(),
            "painted-a".into(),
            ScheduledCloneFrame {
                geometry: (400, 300),
                cancel_at_clone: std::sync::Arc::new(std::sync::Mutex::new(Some(cancel))),
            },
        );
        let mut first_delivered = false;
        let first = super::dispatch_with_frame_invalidation(
            &frames,
            Some(&click("painted-a", 1)),
            |a, b| a.geometry == b.geometry,
            async {
                first_delivered = true;
                Ok::<(), crate::NativeAdapterError>(())
            },
        )
        .await;
        assert!(first.is_err() && !first_delivered);
        frames.write().await.insert(
            "screen-1".into(),
            "fresh-b".into(),
            ScheduledCloneFrame {
                geometry: (400, 300),
                cancel_at_clone: std::sync::Arc::new(std::sync::Mutex::new(None)),
            },
        );
        let mut second_delivered = false;
        let second = super::dispatch_with_frame_invalidation(
            &frames,
            Some(&click("fresh-b", 2)),
            |a, b| a.geometry == b.geometry,
            async {
                second_delivered = true;
                Ok::<(), crate::NativeAdapterError>(())
            },
        )
        .await;
        assert!(second.is_err() && !second_delivered);
    }

    async fn earlier_background_overlap(completed_before_second: bool, outcome: u8) {
        let frames = tokio::sync::RwLock::new(super::CapturedFrames::new());
        let started = tokio::sync::Notify::new();
        let finish = tokio::sync::Notify::new();
        let settled = tokio::sync::Notify::new();
        let background = async {
            let result = super::dispatch_with_mutation_invalidation(
                &frames,
                Some("33333333-3333-4333-8333-333333333333"),
                async {
                    started.notify_one();
                    finish.notified().await;
                    match outcome {
                        0 => Ok(()),
                        1 => Err(crate::NativeAdapterError::definite(
                            crate::NativeAdapterErrorCode::DriverFailed,
                            "Synthetic background refusal",
                            false,
                        )),
                        _ => Err(crate::NativeAdapterError::outcome_unknown(
                            "Synthetic background uncertainty",
                        )),
                    }
                },
            )
            .await;
            assert_eq!(result.is_ok(), outcome == 0);
            settled.notify_one();
        };
        let click_pair = async {
            started.notified().await;
            // A live capture may finish after the earlier background admission.
            frames
                .write()
                .await
                .insert("screen-1".into(), "painted-a".into(), (400, 300));
            super::dispatch_with_frame_invalidation(
                &frames,
                Some(&click("painted-a", 1)),
                |a, b| a == b,
                async { Ok::<(), crate::NativeAdapterError>(()) },
            )
            .await
            .unwrap();
            if completed_before_second {
                finish.notify_one();
                settled.notified().await;
            }
            frames
                .write()
                .await
                .insert("screen-1".into(), "fresh-b".into(), (400, 300));
            let mut delivered = false;
            let result = super::dispatch_with_frame_invalidation(
                &frames,
                Some(&click("fresh-b", 2)),
                |a, b| a == b,
                async {
                    delivered = true;
                    Ok::<(), crate::NativeAdapterError>(())
                },
            )
            .await;
            if !completed_before_second {
                finish.notify_one();
                settled.notified().await;
            }
            assert!(result.is_err() && !delivered);
        };
        tokio::join!(background, click_pair);
        // Completion does not permanently narrow ordinary click capability.
        frames
            .write()
            .await
            .insert("screen-1".into(), "fresh-c".into(), (400, 300));
        let mut new_first = click("fresh-c", 1);
        new_first.operation_id = Some("44444444-4444-4444-8444-444444444444".into());
        super::dispatch_with_frame_invalidation(&frames, Some(&new_first), |a, b| a == b, async {
            Ok::<(), crate::NativeAdapterError>(())
        })
        .await
        .unwrap();
        frames
            .write()
            .await
            .insert("screen-1".into(), "fresh-d".into(), (400, 300));
        let mut new_second = click("fresh-d", 2);
        if let crate::NativeAction::Pointer {
            continuation_of_operation_id,
            ..
        } = &mut new_second.action
        {
            *continuation_of_operation_id = new_first.operation_id;
        }
        super::dispatch_with_frame_invalidation(&frames, Some(&new_second), |a, b| a == b, async {
            Ok::<(), crate::NativeAdapterError>(())
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn earlier_background_admission_fences_clicks_while_pending_and_after_every_settlement() {
        for completed_before_second in [false, true] {
            for outcome in [0, 1, 2] {
                earlier_background_overlap(completed_before_second, outcome).await;
            }
        }
    }

    #[tokio::test]
    async fn background_completion_invalidates_frames_captured_during_its_admission() {
        let frames = tokio::sync::RwLock::new(super::CapturedFrames::new());
        super::dispatch_with_mutation_invalidation(&frames, None, async {
            frames
                .write()
                .await
                .insert("screen-1".into(), "during-background".into(), 1);
            assert_eq!(
                frames.read().await.get("screen-1", "during-background"),
                Some(&1)
            );
            Ok::<(), crate::NativeAdapterError>(())
        })
        .await
        .unwrap();
        assert!(frames
            .read()
            .await
            .get("screen-1", "during-background")
            .is_none());
        assert!(frames.read().await.latest("screen-1").is_none());
    }

    #[tokio::test]
    async fn background_starting_during_first_delivery_prevents_restoration() {
        let frames = tokio::sync::RwLock::new(super::CapturedFrames::new());
        frames
            .write()
            .await
            .insert("screen-1".into(), "painted-a".into(), 1);
        super::dispatch_with_frame_invalidation(
            &frames,
            Some(&click("painted-a", 1)),
            |a, b| a == b,
            async {
                super::dispatch_with_mutation_invalidation(&frames, None, async {
                    Ok::<(), crate::NativeAdapterError>(())
                })
                .await
            },
        )
        .await
        .unwrap();
        frames
            .write()
            .await
            .insert("screen-1".into(), "fresh-b".into(), 1);
        let mut delivered = false;
        let result = super::dispatch_with_frame_invalidation(
            &frames,
            Some(&click("fresh-b", 2)),
            |a, b| a == b,
            async {
                delivered = true;
                Ok::<(), crate::NativeAdapterError>(())
            },
        )
        .await;
        assert!(result.is_err() && !delivered);
    }

    #[tokio::test]
    async fn cancelling_or_panicking_background_futures_releases_exact_admission_without_proof() {
        for panics in [false, true] {
            let frames =
                std::sync::Arc::new(tokio::sync::RwLock::new(super::CapturedFrames::new()));
            let started = std::sync::Arc::new(tokio::sync::Notify::new());
            let finish = std::sync::Arc::new(tokio::sync::Notify::new());
            let background = tokio::spawn({
                let frames = std::sync::Arc::clone(&frames);
                let started = std::sync::Arc::clone(&started);
                let finish = std::sync::Arc::clone(&finish);
                async move {
                    super::dispatch_with_mutation_invalidation(&frames, None, async {
                        started.notify_one();
                        finish.notified().await;
                        assert!(!panics, "Synthetic background panic");
                        Ok::<(), crate::NativeAdapterError>(())
                    })
                    .await
                }
            });
            started.notified().await;
            frames
                .write()
                .await
                .insert("screen-1".into(), "painted-a".into(), 1);
            super::dispatch_with_frame_invalidation(
                &frames,
                Some(&click("painted-a", 1)),
                |a, b| a == b,
                async { Ok::<(), crate::NativeAdapterError>(()) },
            )
            .await
            .unwrap();
            if panics {
                finish.notify_one();
            } else {
                background.abort();
            }
            let failure = background.await.unwrap_err();
            assert_eq!(failure.is_panic(), panics);
            let invalidation = std::sync::Arc::clone(&frames.read().await.invalidation);
            assert!(invalidation.lock().unwrap().active_mutations.is_empty());
            frames
                .write()
                .await
                .insert("screen-1".into(), "fresh-b".into(), 1);
            let mut delivered = false;
            let result = super::dispatch_with_frame_invalidation(
                &frames,
                Some(&click("fresh-b", 2)),
                |a, b| a == b,
                async {
                    delivered = true;
                    Ok::<(), crate::NativeAdapterError>(())
                },
            )
            .await;
            assert!(result.is_err() && !delivered);
            // The dropped invocation does not leave the helper permanently busy.
            frames
                .write()
                .await
                .insert("screen-1".into(), "fresh-c".into(), 1);
            super::dispatch_with_frame_invalidation(
                &frames,
                Some(&click("fresh-c", 1)),
                |a, b| a == b,
                async { Ok::<(), crate::NativeAdapterError>(()) },
            )
            .await
            .unwrap();
            assert!(frames
                .read()
                .await
                .get_for_action(
                    "screen-1",
                    "fresh-c",
                    &click("fresh-c", 2).action,
                    |a, b| a == b
                )
                .is_some());
        }
    }

    #[tokio::test]
    async fn overlapping_same_operation_ids_have_independent_admission_lifetimes() {
        let frames = tokio::sync::RwLock::new(super::CapturedFrames::new());
        let first = frames
            .write()
            .await
            .begin_mutation(Some("33333333-3333-4333-8333-333333333333"));
        let second = frames
            .write()
            .await
            .begin_mutation(Some("33333333-3333-4333-8333-333333333333"));
        drop(first);
        frames
            .write()
            .await
            .insert("screen-1".into(), "painted-a".into(), 1);
        super::dispatch_with_frame_invalidation(
            &frames,
            Some(&click("painted-a", 1)),
            |a, b| a == b,
            async { Ok::<(), crate::NativeAdapterError>(()) },
        )
        .await
        .unwrap();
        assert!(frames
            .read()
            .await
            .get_for_action(
                "screen-1",
                "painted-a",
                &click("painted-a", 2).action,
                |a, b| a == b
            )
            .is_none());
        drop(second);
        frames
            .write()
            .await
            .insert("screen-1".into(), "fresh-b".into(), 1);
        assert!(frames
            .read()
            .await
            .get_for_action(
                "screen-1",
                "fresh-b",
                &click("fresh-b", 2).action,
                |a, b| a == b
            )
            .is_none());
    }

    #[tokio::test]
    async fn fresh_frames_never_replace_failed_or_unknown_first_delivery() {
        for error in [
            crate::NativeAdapterError::definite(
                crate::NativeAdapterErrorCode::DriverFailed,
                "synthetic refusal",
                false,
            ),
            crate::NativeAdapterError::outcome_unknown("synthetic unknown"),
        ] {
            let frames = tokio::sync::RwLock::new(super::CapturedFrames::new());
            frames
                .write()
                .await
                .insert("screen-1".into(), "painted-a".into(), (400, 300));
            let first = click("painted-a", 1);
            super::dispatch_with_frame_invalidation(&frames, Some(&first), |a, b| a == b, async {
                Err::<(), _>(error)
            })
            .await
            .unwrap_err();
            frames
                .write()
                .await
                .insert("screen-1".into(), "fresh-b".into(), (400, 300));
            let second = click("fresh-b", 2);
            let delivered = std::sync::atomic::AtomicBool::new(false);
            let result = super::dispatch_with_frame_invalidation(
                &frames,
                Some(&second),
                |a, b| a == b,
                async {
                    delivered.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                },
            )
            .await;
            assert!(result.is_err());
            assert!(!delivered.load(std::sync::atomic::Ordering::SeqCst));
        }
    }

    #[tokio::test]
    async fn continuation_binds_identity_button_point_geometry_and_expires_without_capture_renewal()
    {
        let frames = tokio::sync::RwLock::new(super::CapturedFrames::new());
        frames
            .write()
            .await
            .insert("screen-1".into(), "painted-a".into(), (400, 300));
        super::dispatch_with_frame_invalidation(
            &frames,
            Some(&click("painted-a", 1)),
            |a, b| a == b,
            async { Ok(()) },
        )
        .await
        .unwrap();
        frames
            .write()
            .await
            .insert("screen-1".into(), "fresh-b".into(), (400, 300));
        let second = click("fresh-b", 2);
        assert!(frames
            .read()
            .await
            .get_for_action("screen-1", "fresh-b", &second.action, |a, b| a == b)
            .is_some());
        for change in ["identity", "button", "point"] {
            let mut wrong = second.clone();
            let crate::NativeAction::Pointer {
                continuation_of_operation_id,
                button,
                x,
                ..
            } = &mut wrong.action
            else {
                unreachable!()
            };
            match change {
                "identity" => {
                    *continuation_of_operation_id =
                        Some("33333333-3333-4333-8333-333333333333".into());
                }
                "button" => *button = Some(crate::NativePointerButton::Right),
                _ => *x += 6.0,
            }
            assert!(frames
                .read()
                .await
                .get_for_action("screen-1", "fresh-b", &wrong.action, |a, b| a == b)
                .is_none());
        }
        frames
            .write()
            .await
            .insert("screen-1".into(), "resized".into(), (800, 600));
        assert!(frames
            .read()
            .await
            .get_for_action(
                "screen-1",
                "resized",
                &click("resized", 2).action,
                |a, b| a == b
            )
            .is_none());
        frames
            .write()
            .await
            .confirmed_click
            .as_mut()
            .unwrap()
            .confirmed_at = std::time::Instant::now()
            .checked_sub(std::time::Duration::from_secs(3))
            .unwrap();
        frames
            .write()
            .await
            .insert("screen-1".into(), "new-capture".into(), (400, 300));
        assert!(frames
            .read()
            .await
            .get_for_action(
                "screen-1",
                "new-capture",
                &click("new-capture", 2).action,
                |a, b| a == b
            )
            .is_none());
    }

    #[tokio::test]
    async fn intervening_mutation_and_one_consumed_continuation_cannot_be_revived_by_fresh_frames()
    {
        for intervening in [true, false] {
            let frames = tokio::sync::RwLock::new(super::CapturedFrames::new());
            frames
                .write()
                .await
                .insert("screen-1".into(), "painted-a".into(), (400, 300));
            super::dispatch_with_frame_invalidation(
                &frames,
                Some(&click("painted-a", 1)),
                |a, b| a == b,
                async { Ok(()) },
            )
            .await
            .unwrap();
            frames
                .write()
                .await
                .insert("screen-1".into(), "fresh-b".into(), (400, 300));
            let second = click("fresh-b", 2);
            super::dispatch_with_frame_invalidation(
                &frames,
                if intervening { None } else { Some(&second) },
                |a, b| a == b,
                async { Ok(()) },
            )
            .await
            .unwrap();
            frames
                .write()
                .await
                .insert("screen-1".into(), "fresh-c".into(), (400, 300));
            assert!(frames
                .read()
                .await
                .get_for_action(
                    "screen-1",
                    "fresh-c",
                    &click("fresh-c", 2).action,
                    |a, b| a == b
                )
                .is_none());
        }
    }

    fn click(frame_id: &str, count: u8) -> crate::NativeActionCommand {
        serde_json::from_value(serde_json::json!({
            "operationId": if count == 2 { "22222222-2222-4222-8222-222222222222" } else { "11111111-1111-4111-8111-111111111111" },
            "targetId": "screen-1",
            "expectedTargetGeneration": "screen-generation-1",
            "expectedObservationId": null,
            "expectedFrameId": frame_id,
            "action": {
                "type": "pointer", "action": "click", "clickCount": count,
                "frameId": frame_id, "x": 40, "y": 60,
                "continuationOfOperationId": if count == 2 { Some("11111111-1111-4111-8111-111111111111") } else { None }
            }
        }))
        .unwrap()
    }

    fn pre_delivery_frames(
        bounds: (i32, i32, i32, i32),
    ) -> super::CapturedFrames<(i32, i32, i32, i32)> {
        let mut frames = super::CapturedFrames::new();
        for frame_id in ["older", "painted-a", "painted-b"] {
            frames.insert("screen-1".into(), frame_id.into(), bounds);
        }
        frames.insert(
            "screen-1".into(),
            "changed-geometry".into(),
            (-1280, -200, 640, 360),
        );
        frames.insert("screen-2".into(), "other-target".into(), bounds);
        frames
    }

    fn assert_continuation_scope(
        frames: &super::CapturedFrames<(i32, i32, i32, i32)>,
        bounds: &(i32, i32, i32, i32),
        second: &crate::NativeActionCommand,
    ) {
        assert_eq!(frames.get("screen-1", "painted-a"), Some(bounds));
        assert!(frames.get("screen-1", "painted-b").is_none());
        assert!(frames.latest("screen-1").is_none());
        for action in [
            click("painted-b", 1).action,
            serde_json::from_value(serde_json::json!({ "type": "pointer", "action": "drag", "frameId": "painted-b", "x": 40, "y": 60, "endX": 80, "endY": 90 })).unwrap(),
            crate::NativeAction::Keyboard { action: crate::NativeKeyboardAction::Press, value: "Enter".into() },
        ] {
            assert!(frames.get_for_action("screen-1", "painted-b", &action, |left, right| left == right).is_none());
        }
        assert_eq!(
            frames.get_for_action("screen-1", "painted-b", &second.action, |left, right| left
                == right),
            Some(bounds)
        );
        for frame_id in ["older", "changed-geometry", "future-frame"] {
            assert!(frames
                .get_for_action("screen-1", frame_id, &second.action, |left, right| left
                    == right)
                .is_none());
        }
        assert!(frames
            .get_for_action(
                "screen-2",
                "other-target",
                &second.action,
                |left, right| left == right
            )
            .is_none());
    }

    #[tokio::test]
    async fn pre_delivery_newer_paint_continues_only_as_one_second_click() {
        let bounds = (-1280, -200, 1280, 720);
        let frames = tokio::sync::RwLock::new(pre_delivery_frames(bounds));
        let first = click("painted-a", 1);
        let second = click("painted-b", 2);
        let original_deadline = frames
            .read()
            .await
            .frames
            .iter()
            .find(|frame| frame.frame_id == "painted-b")
            .unwrap()
            .superseded_at;
        let mut delivered_counts = Vec::new();
        assert_eq!(
            frames.read().await.get_for_action(
                "screen-1",
                "painted-a",
                &first.action,
                |left, right| left == right
            ),
            Some(&bounds)
        );
        super::dispatch_with_frame_invalidation(
            &frames,
            Some(&first),
            |left, right| left == right,
            async {
                assert!(frames
                    .read()
                    .await
                    .get_for_action("screen-1", "painted-a", &first.action, |left, right| left
                        == right)
                    .is_none());
                assert!(frames
                    .read()
                    .await
                    .get_for_action("screen-1", "painted-b", &second.action, |left, right| left
                        == right)
                    .is_none());
                delivered_counts.push(first.action.pointer_click_count().unwrap());
                Ok::<_, crate::NativeAdapterError>(())
            },
        )
        .await
        .unwrap();
        assert_continuation_scope(&*frames.read().await, &bounds, &second);
        super::dispatch_with_frame_invalidation(
            &frames,
            Some(&second),
            |left, right| left == right,
            async {
                assert!(frames
                    .read()
                    .await
                    .get_for_action("screen-1", "painted-b", &second.action, |left, right| left
                        == right)
                    .is_none());
                delivered_counts.push(second.action.pointer_click_count().unwrap());
                Ok::<_, crate::NativeAdapterError>(())
            },
        )
        .await
        .unwrap();
        assert_eq!(delivered_counts, [1, 2]);
        let frames = frames.read().await;
        assert!(frames
            .get_for_action("screen-1", "painted-b", &second.action, |left, right| left
                == right)
            .is_none());
        assert!(frames.get("screen-1", "painted-b").is_none());
        assert!(frames.latest("screen-1").is_none());
        assert_eq!(
            frames.frames.front().unwrap().superseded_at,
            original_deadline
        );
    }

    #[tokio::test]
    async fn failed_or_unknown_continuation_revokes_both_retained_paints() {
        for error in [
            crate::NativeAdapterError::definite(
                crate::NativeAdapterErrorCode::InvalidAction,
                "synthetic rejection",
                false,
            ),
            crate::NativeAdapterError::outcome_unknown("synthetic unknown delivery"),
        ] {
            let frames = tokio::sync::RwLock::new(super::CapturedFrames::new());
            frames
                .write()
                .await
                .insert("screen-1".into(), "painted-a".into(), 1);
            frames
                .write()
                .await
                .insert("screen-1".into(), "painted-b".into(), 1);
            let first = click("painted-a", 1);
            let second = click("painted-b", 2);
            super::dispatch_with_frame_invalidation(
                &frames,
                Some(&first),
                |left, right| left == right,
                async { Ok::<_, crate::NativeAdapterError>(()) },
            )
            .await
            .unwrap();
            assert!(frames
                .read()
                .await
                .get_for_action("screen-1", "painted-b", &second.action, |left, right| left
                    == right)
                .is_some());
            let result = super::dispatch_with_frame_invalidation(
                &frames,
                Some(&second),
                |left, right| left == right,
                async { Err::<(), _>(error) },
            )
            .await;
            assert!(result.is_err());
            assert!(frames.read().await.get("screen-1", "painted-a").is_none());
            assert!(frames
                .read()
                .await
                .get_for_action("screen-1", "painted-b", &second.action, |left, right| left
                    == right)
                .is_none());
        }
    }

    #[tokio::test]
    async fn intervening_mutation_revokes_both_pre_delivery_paints() {
        let frames = tokio::sync::RwLock::new(super::CapturedFrames::new());
        frames
            .write()
            .await
            .insert("screen-1".into(), "painted-a".into(), 1);
        frames
            .write()
            .await
            .insert("screen-1".into(), "painted-b".into(), 1);
        let first = click("painted-a", 1);
        super::dispatch_with_frame_invalidation(
            &frames,
            Some(&first),
            |left, right| left == right,
            async {
                super::dispatch_with_frame_invalidation(
                    &frames,
                    None,
                    |left, right| left == right,
                    async { Ok::<_, crate::NativeAdapterError>(()) },
                )
                .await
                .unwrap();
                Ok::<_, crate::NativeAdapterError>(())
            },
        )
        .await
        .unwrap();
        assert!(frames.read().await.get("screen-1", "painted-a").is_none());
        assert!(frames
            .read()
            .await
            .get_for_action(
                "screen-1",
                "painted-b",
                &click("painted-b", 2).action,
                |left, right| left == right
            )
            .is_none());
    }

    #[tokio::test]
    async fn continuation_restoration_keeps_target_and_global_bounds() {
        let frames = tokio::sync::RwLock::new(super::CapturedFrames::new());
        for index in 0..super::MAX_FRAMES_PER_TARGET {
            frames
                .write()
                .await
                .insert("screen-1".into(), format!("painted-{index}"), 1);
        }
        let first = click("painted-0", 1);
        super::dispatch_with_frame_invalidation(
            &frames,
            Some(&first),
            |left, right| left == right,
            async { Ok::<_, crate::NativeAdapterError>(()) },
        )
        .await
        .unwrap();
        assert_eq!(
            frames.read().await.frames.len(),
            super::MAX_FRAMES_PER_TARGET
        );
        assert!(frames.read().await.latest("screen-1").is_none());
        super::dispatch_with_frame_invalidation(
            &frames,
            Some(&first),
            |left, right| left == right,
            async {
                for index in 0..super::MAX_FRAMES {
                    frames
                        .write()
                        .await
                        .insert(format!("other-screen-{index}"), "fresh".into(), 2);
                }
                Ok::<_, crate::NativeAdapterError>(())
            },
        )
        .await
        .unwrap();
        assert_eq!(frames.read().await.frames.len(), super::MAX_FRAMES);
        assert!(frames
            .read()
            .await
            .get_for_action(
                "screen-1",
                "painted-31",
                &click("painted-31", 2).action,
                |left, right| left == right
            )
            .is_none());
        assert_eq!(frames.read().await.latest("other-screen-511"), Some(&2));
    }

    #[tokio::test]
    async fn intervening_invalidation_prevents_successful_click_from_restoring_old_authority() {
        let frames = tokio::sync::RwLock::new(super::CapturedFrames::new());
        frames
            .write()
            .await
            .insert("screen-1".into(), "painted-a".into(), 1);
        super::dispatch_with_frame_invalidation(
            &frames,
            Some(&click("painted-a", 1)),
            |left, right| left == right,
            async {
                super::dispatch_with_frame_invalidation(
                    &frames,
                    None,
                    |left, right| left == right,
                    async { Ok::<_, crate::NativeAdapterError>(()) },
                )
                .await
                .unwrap();
                frames
                    .write()
                    .await
                    .insert("screen-1".into(), "painted-b".into(), 2);
                Ok::<_, crate::NativeAdapterError>(())
            },
        )
        .await
        .unwrap();
        assert!(frames.read().await.get("screen-1", "painted-a").is_none());
        assert_eq!(frames.read().await.latest("screen-1"), Some(&2));
    }

    #[tokio::test]
    async fn completed_click_restores_only_its_exact_fence_after_injection() {
        let frames = tokio::sync::RwLock::new(super::CapturedFrames::new());
        frames.write().await.insert(
            "screen-1".into(),
            "painted-a".into(),
            (-1280, -200, 1280, 720),
        );
        let original = *frames.read().await.get("screen-1", "painted-a").unwrap();
        super::dispatch_with_frame_invalidation(
            &frames,
            Some(&click("painted-a", 1)),
            |left, right| left == right,
            async {
                assert!(frames.read().await.get("screen-1", "painted-a").is_none());
                frames.write().await.insert(
                    "screen-1".into(),
                    "painted-b".into(),
                    (-1280, -200, 640, 360),
                );
                Ok::<_, crate::NativeAdapterError>(original)
            },
        )
        .await
        .unwrap();
        assert_eq!(
            frames.read().await.get("screen-1", "painted-a"),
            Some(&original)
        );
        assert_eq!(
            frames.read().await.latest("screen-1"),
            Some(&(-1280, -200, 640, 360))
        );
        let first_age = frames
            .read()
            .await
            .frames
            .iter()
            .find(|frame| frame.frame_id == "painted-a")
            .unwrap()
            .superseded_at;
        super::dispatch_with_frame_invalidation(
            &frames,
            Some(&click("painted-a", 1)),
            |left, right| left == right,
            async { Ok::<_, crate::NativeAdapterError>(()) },
        )
        .await
        .unwrap();
        assert_eq!(
            frames.read().await.frames.front().unwrap().superseded_at,
            first_age
        );
        assert_eq!(
            frames.read().await.get("screen-1", "painted-a"),
            Some(&original)
        );
        assert!(frames.read().await.get("screen-1", "painted-b").is_none());
        super::dispatch_with_frame_invalidation(
            &frames,
            None,
            |left, right| left == right,
            async { Ok::<_, crate::NativeAdapterError>(()) },
        )
        .await
        .unwrap();
        assert!(frames.read().await.get("screen-1", "painted-a").is_none());
    }

    #[tokio::test]
    async fn failed_or_unknown_click_injection_does_not_restore_any_frame() {
        for error in [
            crate::NativeAdapterError::definite(
                crate::NativeAdapterErrorCode::InvalidAction,
                "synthetic rejection",
                false,
            ),
            crate::NativeAdapterError::outcome_unknown("synthetic unknown delivery"),
        ] {
            let frames = tokio::sync::RwLock::new(super::CapturedFrames::new());
            frames
                .write()
                .await
                .insert("screen-1".into(), "painted-a".into(), 1);
            let result = super::dispatch_with_frame_invalidation(
                &frames,
                Some(&click("painted-a", 1)),
                |left, right| left == right,
                async {
                    frames
                        .write()
                        .await
                        .insert("screen-1".into(), "painted-b".into(), 2);
                    Err::<(), _>(error)
                },
            )
            .await;
            assert!(result.is_err());
            assert!(frames.read().await.get("screen-1", "painted-a").is_none());
            assert!(frames.read().await.get("screen-1", "painted-b").is_none());
        }
    }

    #[test]
    fn click_restoration_keeps_its_retention_deadline_and_never_revives_expired_metadata() {
        let now = std::time::Instant::now();
        let mut frames = super::CapturedFrames::new();
        frames.insert_at("screen-1".into(), "painted-a".into(), 1, now);
        let mut retained = frames
            .take_click_frames("screen-1", "painted-a", |left, right| left == right)
            .pop()
            .unwrap();
        retained.superseded_at = Some(now.checked_sub(std::time::Duration::from_secs(3)).unwrap());
        frames.restore_click_frame(retained, frames.generation());
        assert!(frames.get("screen-1", "painted-a").is_none());
        frames.insert_at("screen-1".into(), "painted-a".into(), 1, now);
        let retained = frames
            .take_click_frames("screen-1", "painted-a", |left, right| left == right)
            .pop()
            .unwrap();
        let age = retained.superseded_at;
        frames.restore_click_frame(retained, frames.generation());
        frames.insert_at(
            "screen-1".into(),
            "painted-b".into(),
            2,
            now + std::time::Duration::from_millis(200),
        );
        assert_eq!(frames.frames.front().unwrap().superseded_at, age);
    }
    use super::*;

    #[test]
    fn painted_frame_survives_new_captures_with_its_original_dimensions() {
        let now = Instant::now();
        let mut frames = CapturedFrames::new();
        frames.insert_at("window".into(), "painted".into(), (720, 450), now);
        for index in 1..=3 {
            frames.insert_at(
                "window".into(),
                format!("new-{index}"),
                (1440, 900),
                now + Duration::from_millis(index * 100),
            );
        }
        assert_eq!(
            frames.get_at("window", "painted", now + Duration::from_millis(380)),
            Some(&(720, 450))
        );
        assert_eq!(frames.get_at("other-window", "painted", now), None);
        assert_eq!(frames.get_at("window", "unknown-frame", now), None);
        assert_eq!(
            frames.get_at(
                "window",
                "painted",
                now + Duration::from_millis(100) + MAX_FRAME_AGE + Duration::from_nanos(1)
            ),
            None
        );
    }

    #[test]
    fn latest_still_frame_keeps_authority_through_model_planning() {
        let now = Instant::now();
        let mut frames = CapturedFrames::new();
        frames.insert_at("window".into(), "still".into(), (720, 450), now);
        assert_eq!(
            frames.get_at("window", "still", now + Duration::from_secs(60)),
            Some(&(720, 450))
        );
        let resumed = now + Duration::from_secs(60);
        frames.insert_at("window".into(), "stream".into(), (1440, 900), resumed);
        assert_eq!(
            frames.get_at("window", "still", resumed + Duration::from_millis(280)),
            Some(&(720, 450))
        );
        assert_eq!(
            frames.get_at(
                "window",
                "still",
                resumed + MAX_FRAME_AGE + Duration::from_nanos(1)
            ),
            None
        );
        assert_eq!(
            frames.get_at("window", "stream", resumed + Duration::from_secs(60)),
            Some(&(1440, 900))
        );
    }

    #[test]
    fn target_and_global_retention_are_bounded_and_mutations_invalidate_history() {
        let now = Instant::now();
        let mut frames = CapturedFrames::new();
        for index in 0..=MAX_FRAMES_PER_TARGET {
            frames.insert_at("window".into(), index.to_string(), index, now);
        }
        assert_eq!(frames.frames.len(), MAX_FRAMES_PER_TARGET);
        assert_eq!(frames.get_at("window", "0", now), None);
        frames.clear();
        assert_eq!(frames.get_at("window", "32", now), None);
        for index in 0..=MAX_FRAMES {
            frames.insert_at(index.to_string(), "frame".into(), index, now);
        }
        assert_eq!(frames.frames.len(), MAX_FRAMES);
        assert_eq!(frames.get_at("0", "frame", now), None);
        frames.insert_at("1".into(), "new-frame".into(), 1, now);
        assert_eq!(frames.get_at("1", "frame", now), None);
        assert_eq!(
            frames.get_at("2", "frame", now + Duration::from_secs(60)),
            Some(&2)
        );
        assert_eq!(
            frames.get_at("1", "new-frame", now + Duration::from_secs(60)),
            Some(&1)
        );
        frames.clear();
        assert!(frames.frames.is_empty());
    }
}
