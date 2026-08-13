use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use async_trait::async_trait;
use image::{
    codecs::{jpeg::JpegEncoder, png::PngEncoder},
    ExtendedColorType, ImageEncoder as _,
};
use opengeni_agent_macos_ffi::{
    accessibility_trusted, capture_display_rgba, capture_display_rgba_sized, capture_window_rgba,
    capture_window_rgba_sized, focus_and_inject_target, focus_and_inject_window, focus_target,
    inject_batch, inject_display_batch, input_monitoring_granted, launch_application,
    list_displays, list_targets, machine_locked, probe_display, screen_capture_granted,
    start_display_frame_stream, start_window_frame_stream, DisplayInfo, InputEvent, KeyAction,
    MacAxAction, MacAxActionValue, MacAxController, MacAxElementSelector, MacAxNode, MacAxValue,
    MacFfiError, MacFrameStream, MacRect, MacTargetInfo, MacTargetKind, MacWindowFrame,
    PointerAction, PointerButton, RgbaFrame,
};
use serde_json::json;
use sha2::{Digest as _, Sha256};
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

use crate::clipboard::NativeClipboardController;
use crate::tree::semantic_roots_equivalent;
use crate::{
    ComputerAdapter, NativeAction, NativeActionCommand, NativeActionValue, NativeAdapterError,
    NativeAdapterErrorCode, NativeAdapterResult, NativeCapabilities, NativeCaptureOptions,
    NativeCapturedFrame, NativeClipboard, NativeClipboardAction, NativeFrameFormat,
    NativeKeyboardAction, NativeLocator, NativeNodeMetadata, NativeNodeValue, NativeObservation,
    NativePointerAction, NativePointerButton, NativeRect, NativeRedactedValue,
    NativeRedactionReason, NativeSemanticAction, NativeSemanticPlatform, NativeTarget,
    NativeTargetKind, RawSemanticNode, SemanticSnapshotIndex,
};

const MAX_WINDOW_FRAME_FENCES: usize = 512;
const MUTATION_SETTLE_DELAYS: [Duration; 4] = [
    Duration::ZERO,
    Duration::from_millis(16),
    Duration::from_millis(32),
    Duration::from_millis(64),
];

#[derive(Clone)]
struct TargetRecord {
    target: NativeTarget,
    native: MacTargetInfo,
}

#[derive(Clone)]
struct ScreenRecord {
    target: NativeTarget,
    display: DisplayInfo,
}

struct StoredObservation {
    target_generation: String,
    target: TargetRecord,
    snapshot: SemanticSnapshotIndex,
    selectors: BTreeMap<String, MacAxElementSelector>,
}

#[derive(Clone)]
struct ScreenFrameFence {
    frame_id: String,
    target_generation: String,
    width: u32,
    height: u32,
}

#[derive(Clone)]
struct WindowFrameFence {
    sequence: u64,
    frame_id: String,
    target_generation: String,
    window_id: u32,
    bounds: MacRect,
    width: u32,
    height: u32,
}

struct LiveCapture {
    options: NativeCaptureOptions,
    target_generation: String,
    stream: Arc<MacFrameStream>,
}

/// macOS AX/ScreenCaptureKit adapter. Retained AX objects and observers live in
/// the audited FFI controller; this layer owns public observation/frame fences.
pub(crate) struct AxComputerAdapter {
    incarnation: Uuid,
    sequence: AtomicU64,
    frame_sequence: AtomicU64,
    ax: StdMutex<Option<Arc<MacAxController>>>,
    targets: RwLock<BTreeMap<String, TargetRecord>>,
    latest: RwLock<BTreeMap<String, StoredObservation>>,
    latest_screen_frames: RwLock<BTreeMap<String, ScreenFrameFence>>,
    latest_window_frames: RwLock<BTreeMap<String, WindowFrameFence>>,
    live_captures: StdMutex<BTreeMap<String, LiveCapture>>,
    live_capture_lifecycle: Mutex<()>,
    clipboard: Option<NativeClipboardController>,
    /// macOS exposes one foreground Aqua input seat per login session. AX-only
    /// mutations stay parallel on their per-process workers, but anything that
    /// focuses/launches an app or emits CGEvent input must hold this queue.
    input_seat: Mutex<()>,
}

impl AxComputerAdapter {
    pub(crate) fn open() -> NativeAdapterResult<Self> {
        let locked = machine_locked().map_err(map_ffi_pre_dispatch)?;
        if !locked && probe_display().is_none() && !accessibility_trusted() {
            return Err(NativeAdapterError::unavailable(
                "no macOS GUI session or computer-control grant is available",
                true,
            ));
        }
        let ax = if accessibility_trusted() {
            Some(Arc::new(
                MacAxController::open().map_err(map_ffi_pre_dispatch)?,
            ))
        } else {
            None
        };
        Ok(Self {
            incarnation: Uuid::new_v4(),
            sequence: AtomicU64::new(0),
            frame_sequence: AtomicU64::new(0),
            ax: StdMutex::new(ax),
            targets: RwLock::new(BTreeMap::new()),
            latest: RwLock::new(BTreeMap::new()),
            latest_screen_frames: RwLock::new(BTreeMap::new()),
            latest_window_frames: RwLock::new(BTreeMap::new()),
            live_captures: StdMutex::new(BTreeMap::new()),
            live_capture_lifecycle: Mutex::new(()),
            clipboard: NativeClipboardController::open().ok(),
            input_seat: Mutex::new(()),
        })
    }

    fn ensure_unlocked() -> NativeAdapterResult<()> {
        if machine_locked().map_err(map_ffi_pre_dispatch)? {
            Err(NativeAdapterError::definite(
                NativeAdapterErrorCode::MachineLocked,
                "macOS login session is locked; unlock it on the machine to continue",
                true,
            ))
        } else {
            Ok(())
        }
    }

    fn ax_controller(&self) -> NativeAdapterResult<Option<Arc<MacAxController>>> {
        if !accessibility_trusted() {
            return Ok(None);
        }
        let mut controller = self
            .ax
            .lock()
            .map_err(|_| driver_failure("macOS Accessibility controller lock is poisoned"))?;
        if controller.is_none() {
            *controller = Some(Arc::new(
                MacAxController::open().map_err(map_ffi_pre_dispatch)?,
            ));
        }
        Ok(controller.clone())
    }

    fn screen_records() -> NativeAdapterResult<Vec<ScreenRecord>> {
        let displays = list_displays().map_err(map_ffi_pre_dispatch)?;
        Ok(displays
            .into_iter()
            .map(|display| {
                let target = NativeTarget {
                    id: format!("screen:{}", display.id),
                    target_generation: format!(
                        "g_{}",
                        stable_digest(&format!(
                            "{}:{}x{}@{},{}:{}x{}:{}",
                            display.id,
                            display.width,
                            display.height,
                            display.point_x,
                            display.point_y,
                            display.point_width,
                            display.point_height,
                            display.is_main
                        ))
                    ),
                    kind: NativeTargetKind::Screen,
                    application_id: None,
                    process_id: None,
                    title: if display.is_main {
                        "macOS Main Display".to_string()
                    } else {
                        format!("macOS Display {}", display.id)
                    },
                    bounds: Some(NativeRect {
                        x: display.point_x,
                        y: display.point_y,
                        width: display.point_width,
                        height: display.point_height,
                    }),
                    focused: display.is_main,
                };
                ScreenRecord { target, display }
            })
            .collect())
    }

    fn load_screen(target_id: &str) -> NativeAdapterResult<Option<ScreenRecord>> {
        Ok(Self::screen_records()?
            .into_iter()
            .find(|record| record.target.id == target_id))
    }

    async fn refresh_target_records(&self) -> NativeAdapterResult<Vec<TargetRecord>> {
        let targets = tokio::task::spawn_blocking(list_targets)
            .await
            .map_err(|error| driver_failure(format!("macOS target task failed: {error}")))?
            .map_err(map_ffi_pre_dispatch)?;
        let records: Vec<TargetRecord> = targets.into_iter().map(target_record).collect();
        *self.targets.write().await = records
            .iter()
            .cloned()
            .map(|record| (record.target.id.clone(), record))
            .collect();
        Ok(records)
    }

    async fn load_target(&self, target_id: &str) -> NativeAdapterResult<TargetRecord> {
        if let Some(record) = self.targets.read().await.get(target_id).cloned() {
            return Ok(record);
        }
        self.refresh_target_records()
            .await?
            .into_iter()
            .find(|record| record.target.id == target_id)
            .ok_or_else(|| {
                NativeAdapterError::definite(
                    NativeAdapterErrorCode::TargetNotFound,
                    "macOS app/window target no longer exists",
                    true,
                )
            })
    }

    async fn screen_observation(&self, target: NativeTarget) -> NativeObservation {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let frame_id = self
            .latest_screen_frames
            .read()
            .await
            .get(&target.id)
            .filter(|frame| frame.target_generation == target.target_generation)
            .map(|frame| frame.frame_id.clone());
        NativeObservation {
            observation_id: format!("o_{}_{}", self.incarnation.simple(), sequence),
            target,
            frame_id,
            roots: Vec::new(),
            node_count: 0,
            focused_ref: None,
            changed_regions: Vec::new(),
        }
    }

    async fn observe_target(&self, record: TargetRecord) -> NativeAdapterResult<NativeObservation> {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let observation_id = format!("o_{}_{}", self.incarnation.simple(), sequence);
        let frame_id = self.window_frame_for(&record).await;
        let controller = self.ax_controller()?;
        if controller.is_none() && record.native.kind == MacTargetKind::Application {
            return Err(NativeAdapterError::definite(
                NativeAdapterErrorCode::PermissionDenied,
                "macOS Accessibility permission is required to observe applications",
                true,
            ));
        }
        let can_observe = controller.is_some()
            && (record.native.kind == MacTargetKind::Application
                || record.native.ax_window.is_some());
        if !can_observe {
            self.latest.write().await.remove(&record.target.id);
            return Ok(NativeObservation {
                observation_id,
                target: record.target,
                frame_id,
                roots: Vec::new(),
                node_count: 0,
                focused_ref: None,
                changed_regions: Vec::new(),
            });
        }
        let controller = controller.expect("checked above");
        let native = record.native.clone();
        let snapshot = tokio::task::spawn_blocking(move || controller.snapshot(&native))
            .await
            .map_err(|error| driver_failure(format!("macOS AX snapshot task failed: {error}")))?
            .map_err(map_ffi_pre_dispatch)?;
        let mut selectors = BTreeMap::new();
        let raw_nodes: Vec<RawSemanticNode> = snapshot
            .nodes
            .into_iter()
            .map(|node| {
                selectors.insert(node.key.clone(), node.selector.clone());
                raw_node(node)
            })
            .collect();
        let semantic =
            SemanticSnapshotIndex::build(observation_id.clone(), &snapshot.root_keys, raw_nodes)?;
        let focused_ref = find_focused_ref(semantic.roots());
        let observation = NativeObservation {
            observation_id,
            target: record.target.clone(),
            frame_id,
            roots: semantic.roots().to_vec(),
            node_count: semantic.node_count(),
            focused_ref,
            changed_regions: Vec::new(),
        };
        self.latest.write().await.insert(
            record.target.id.clone(),
            StoredObservation {
                target_generation: record.target.target_generation.clone(),
                target: record,
                snapshot: semantic,
                selectors,
            },
        );
        Ok(observation)
    }

    async fn window_frame_for(&self, record: &TargetRecord) -> Option<String> {
        if record.target.kind != NativeTargetKind::Window {
            return None;
        }
        let window_id = record.native.window_id?;
        let bounds = record.native.bounds?;
        self.latest_window_frames
            .read()
            .await
            .get(&record.target.id)
            .filter(|frame| {
                frame.target_generation == record.target.target_generation
                    && frame.window_id == window_id
                    && rect_nearly_equal(frame.bounds, bounds, 2.0)
            })
            .map(|frame| frame.frame_id.clone())
    }

    async fn observe_after_mutation(
        &self,
        target_id: &str,
        before_roots: &[crate::NativeSemanticNode],
    ) -> NativeAdapterResult<NativeObservation> {
        let mut latest = None;
        let mut prior_roots = before_roots.to_vec();
        let mut changed = false;
        for delay in MUTATION_SETTLE_DELAYS {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            let observation = self.observe(target_id).await?;
            if changed && semantic_roots_equivalent(&observation.roots, &prior_roots) {
                return Ok(observation);
            }
            changed |= !semantic_roots_equivalent(&observation.roots, &prior_roots);
            prior_roots.clone_from(&observation.roots);
            latest = Some(observation);
        }
        latest.ok_or_else(|| driver_failure("macOS mutation produced no observation"))
    }

    async fn invalidate_frames(&self) {
        self.latest_screen_frames.write().await.clear();
        self.latest_window_frames.write().await.clear();
    }

    async fn capture_screen(
        &self,
        record: ScreenRecord,
        options: Option<NativeCaptureOptions>,
    ) -> NativeAdapterResult<NativeCapturedFrame> {
        let display_id = record.display.id.clone();
        let captured = tokio::task::spawn_blocking(move || match options {
            Some(options) => {
                capture_display_rgba_sized(&display_id, options.max_width, options.max_height)
            }
            None => capture_display_rgba(&display_id),
        })
        .await
        .map_err(|error| driver_failure(format!("macOS capture task failed: {error}")))?
        .map_err(map_ffi_pre_dispatch)?;
        self.finish_screen_capture(record, captured, options).await
    }

    async fn finish_screen_capture(
        &self,
        record: ScreenRecord,
        captured: RgbaFrame,
        options: Option<NativeCaptureOptions>,
    ) -> NativeAdapterResult<NativeCapturedFrame> {
        let current = Self::load_screen(&record.target.id)?.ok_or_else(|| {
            NativeAdapterError::definite(
                NativeAdapterErrorCode::TargetNotFound,
                "macOS display disappeared during capture",
                true,
            )
        })?;
        if current.target.target_generation != record.target.target_generation
            || current.display.width != record.display.width
            || current.display.height != record.display.height
        {
            return Err(NativeAdapterError::definite(
                NativeAdapterErrorCode::FrameStale,
                "macOS display geometry changed during capture",
                true,
            ));
        }
        let (bytes, mime_type) =
            encode_frame(&captured.rgba, captured.width, captured.height, options)?;
        let frame_id = self.next_frame_id();
        self.latest_screen_frames.write().await.insert(
            record.target.id.clone(),
            ScreenFrameFence {
                frame_id: frame_id.clone(),
                target_generation: record.target.target_generation.clone(),
                width: captured.width,
                height: captured.height,
            },
        );
        Ok(captured_frame(
            frame_id,
            record.target,
            captured.width,
            captured.height,
            mime_type,
            bytes,
        ))
    }

    async fn capture_window(
        &self,
        record: TargetRecord,
        options: Option<NativeCaptureOptions>,
    ) -> NativeAdapterResult<NativeCapturedFrame> {
        let window_id = record.native.window_id.ok_or_else(|| {
            NativeAdapterError::unsupported(
                "macOS window is not unambiguously correlated to ScreenCaptureKit",
            )
        })?;
        let process_id = record.native.process_id;
        let captured = tokio::task::spawn_blocking(move || match options {
            Some(options) => capture_window_rgba_sized(
                window_id,
                process_id,
                options.max_width,
                options.max_height,
            ),
            None => capture_window_rgba(window_id, process_id),
        })
        .await
        .map_err(|error| driver_failure(format!("macOS window capture task failed: {error}")))?
        .map_err(map_ffi_pre_dispatch)?;
        self.finish_window_capture(record, captured, options).await
    }

    async fn finish_window_capture(
        &self,
        record: TargetRecord,
        captured: MacWindowFrame,
        options: Option<NativeCaptureOptions>,
    ) -> NativeAdapterResult<NativeCapturedFrame> {
        if record.native.window_id != Some(captured.window_id) {
            return Err(NativeAdapterError::definite(
                NativeAdapterErrorCode::FrameStale,
                "macOS window identity changed during capture",
                true,
            ));
        }
        if record
            .native
            .bounds
            .is_some_and(|bounds| !rect_nearly_equal(bounds, captured.bounds, 2.0))
        {
            return Err(NativeAdapterError::definite(
                NativeAdapterErrorCode::FrameStale,
                "macOS window moved or resized during capture",
                true,
            ));
        }
        let (bytes, mime_type) = encode_frame(
            &captured.frame.rgba,
            captured.frame.width,
            captured.frame.height,
            options,
        )?;
        let sequence = self.frame_sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let frame_id = format!("f_{}_{}", self.incarnation.simple(), sequence);
        let mut frames = self.latest_window_frames.write().await;
        frames.insert(
            record.target.id.clone(),
            WindowFrameFence {
                sequence,
                frame_id: frame_id.clone(),
                target_generation: record.target.target_generation.clone(),
                window_id: captured.window_id,
                bounds: captured.bounds,
                width: captured.frame.width,
                height: captured.frame.height,
            },
        );
        while frames.len() > MAX_WINDOW_FRAME_FENCES {
            let oldest = frames
                .iter()
                .min_by_key(|(_, frame)| frame.sequence)
                .map(|(target_id, _)| target_id.clone());
            let Some(oldest) = oldest else {
                break;
            };
            frames.remove(&oldest);
        }
        drop(frames);
        Ok(captured_frame(
            frame_id,
            record.target,
            captured.frame.width,
            captured.frame.height,
            mime_type,
            bytes,
        ))
    }

    fn live_capture(
        &self,
        target_id: &str,
        options: NativeCaptureOptions,
        target_generation: &str,
    ) -> NativeAdapterResult<Arc<MacFrameStream>> {
        let captures = self
            .live_captures
            .lock()
            .map_err(|_| driver_failure("macOS live-capture registry lock is poisoned"))?;
        let capture = captures
            .get(target_id)
            .ok_or_else(|| driver_failure("macOS live capture was not started for this target"))?;
        if capture.options != options || capture.target_generation != target_generation {
            return Err(NativeAdapterError::definite(
                NativeAdapterErrorCode::FrameStale,
                "macOS live capture configuration or target generation changed",
                true,
            ));
        }
        Ok(Arc::clone(&capture.stream))
    }

    fn next_frame_id(&self) -> String {
        let sequence = self.frame_sequence.fetch_add(1, Ordering::Relaxed) + 1;
        format!("f_{}_{}", self.incarnation.simple(), sequence)
    }

    async fn validate_screen(
        &self,
        command: &NativeActionCommand,
        record: &ScreenRecord,
    ) -> NativeAdapterResult<()> {
        if record.target.target_generation != command.expected_target_generation {
            return Err(NativeAdapterError::definite(
                NativeAdapterErrorCode::TargetStale,
                "macOS display geometry changed",
                true,
            ));
        }
        match &command.action {
            NativeAction::Pointer {
                frame_id,
                x,
                y,
                end_x,
                end_y,
                ..
            } => {
                let frames = self.latest_screen_frames.read().await;
                let frame = frames
                    .get(&command.target_id)
                    .ok_or_else(|| stale_frame("macOS screen"))?;
                if command.expected_frame_id.as_deref() != Some(frame_id)
                    || frame.frame_id != *frame_id
                    || frame.target_generation != command.expected_target_generation
                {
                    return Err(stale_frame("macOS screen"));
                }
                validate_local_point(*x, *y, frame.width, frame.height)?;
                validate_optional_end(*end_x, *end_y, frame.width, frame.height)?;
            }
            NativeAction::Keyboard { .. } | NativeAction::Launch { .. } => {}
            NativeAction::Clipboard { operation, text } => {
                validate_clipboard_payload(*operation, text.as_deref())?;
                if self.clipboard.is_none() {
                    return Err(NativeAdapterError::unsupported(
                        "native text clipboard is unavailable on this macOS login seat",
                    ));
                }
            }
            NativeAction::Semantic { .. } | NativeAction::Focus { .. } => {
                return Err(NativeAdapterError::unsupported(
                    "semantic/focus actions cannot target the macOS screen",
                ));
            }
        }
        Ok(())
    }

    async fn validate_window_pointer(
        &self,
        command: &NativeActionCommand,
    ) -> NativeAdapterResult<(TargetRecord, WindowFrameFence)> {
        let record = self.load_target(&command.target_id).await?;
        if record.target.kind != NativeTargetKind::Window || record.native.ax_window.is_none() {
            return Err(NativeAdapterError::unsupported(
                "window-relative input requires one exact AX/SCK-correlated macOS window",
            ));
        }
        if record.target.target_generation != command.expected_target_generation {
            return Err(NativeAdapterError::definite(
                NativeAdapterErrorCode::TargetStale,
                "macOS window generation changed",
                true,
            ));
        }
        let frame = self
            .latest_window_frames
            .read()
            .await
            .get(&command.target_id)
            .cloned()
            .ok_or_else(|| stale_frame("macOS window"))?;
        let NativeAction::Pointer {
            frame_id,
            x,
            y,
            end_x,
            end_y,
            ..
        } = &command.action
        else {
            return Err(NativeAdapterError::unsupported(
                "only pointer input may use a macOS window frame",
            ));
        };
        if command.expected_frame_id.as_deref() != Some(frame_id)
            || frame.frame_id != *frame_id
            || frame.target_generation != command.expected_target_generation
            || record.native.window_id != Some(frame.window_id)
            || record
                .native
                .bounds
                .is_none_or(|bounds| !rect_nearly_equal(bounds, frame.bounds, 2.0))
        {
            return Err(stale_frame("macOS window"));
        }
        validate_local_point(*x, *y, frame.width, frame.height)?;
        validate_optional_end(*end_x, *end_y, frame.width, frame.height)?;
        Ok((record, frame))
    }

    async fn dispatch_window_pointer(
        &self,
        command: &NativeActionCommand,
    ) -> NativeAdapterResult<Option<NativeObservation>> {
        let _seat = self.input_seat.lock().await;
        let (record, frame) = self.validate_window_pointer(command).await?;
        let inputs = pointer_inputs(&command.action)?;
        self.invalidate_frames().await;
        tokio::task::spawn_blocking(move || {
            focus_and_inject_window(
                &record.native,
                frame.bounds,
                frame.width,
                frame.height,
                &inputs,
            )
        })
        .await
        .map_err(|error| {
            NativeAdapterError::outcome_unknown(format!(
                "macOS window input task failed after dispatch: {error}"
            ))
        })?
        .map_err(map_ffi_mutation)?;
        // Raw input already completed atomically against the exact captured
        // window. Rebuilding a large AX tree only to decorate this receipt can
        // add a full second and does not strengthen the dispatch proof; callers
        // get live pixels immediately and may explicitly observe when needed.
        Ok(None)
    }

    async fn validate_observed_action(
        &self,
        command: &NativeActionCommand,
    ) -> NativeAdapterResult<()> {
        let current = self.load_target(&command.target_id).await?;
        if current.target.target_generation != command.expected_target_generation {
            return Err(NativeAdapterError::definite(
                NativeAdapterErrorCode::TargetStale,
                "macOS app/window identity changed after observation",
                true,
            ));
        }
        let latest = self.latest.read().await;
        let stored = latest.get(&command.target_id).ok_or_else(|| {
            NativeAdapterError::definite(
                NativeAdapterErrorCode::ObservationStale,
                "macOS target has not been semantically observed",
                true,
            )
        })?;
        if stored.target_generation != command.expected_target_generation {
            return Err(NativeAdapterError::definite(
                NativeAdapterErrorCode::TargetStale,
                "macOS target generation changed",
                true,
            ));
        }
        match &command.action {
            NativeAction::Semantic { locator, .. } => {
                if matches!(locator, NativeLocator::Ref { .. })
                    && command.expected_observation_id.as_deref()
                        != Some(stored.snapshot.observation_id())
                {
                    return Err(NativeAdapterError::definite(
                        NativeAdapterErrorCode::ObservationStale,
                        "semantic ref belongs to a stale macOS AX observation",
                        true,
                    ));
                }
                let key = stored.snapshot.resolve(locator)?;
                if !stored.selectors.contains_key(key) {
                    return Err(NativeAdapterError::definite(
                        NativeAdapterErrorCode::ObservationStale,
                        "macOS AX observation lost its native selector",
                        true,
                    ));
                }
            }
            NativeAction::Focus { target_id } if target_id == &command.target_id => {}
            NativeAction::Focus { .. } => {
                return Err(invalid("focus action target must equal the command target"));
            }
            _ => {
                return Err(NativeAdapterError::unsupported(
                    "action does not use a semantic macOS observation",
                ));
            }
        }
        Ok(())
    }

    async fn dispatch_semantic(
        &self,
        command: &NativeActionCommand,
    ) -> NativeAdapterResult<Option<NativeObservation>> {
        // Explicit target focus changes the shared foreground seat. Ordinary AX
        // actions remain parallel and never acquire the seat queue.
        let _seat = if matches!(
            command.action,
            NativeAction::Focus { .. }
                | NativeAction::Semantic {
                    action: NativeSemanticAction::Focus,
                    ..
                }
        ) {
            Some(self.input_seat.lock().await)
        } else {
            None
        };
        self.validate_observed_action(command).await?;
        let (record, selector, action, before_roots) = {
            let latest = self.latest.read().await;
            let stored = latest.get(&command.target_id).ok_or_else(|| {
                NativeAdapterError::definite(
                    NativeAdapterErrorCode::ObservationStale,
                    "macOS AX observation expired before dispatch",
                    true,
                )
            })?;
            let (selector, action) = match &command.action {
                NativeAction::Semantic {
                    locator,
                    action,
                    value,
                } => {
                    let key = stored.snapshot.resolve(locator)?;
                    let selector = stored.selectors.get(key).cloned().ok_or_else(|| {
                        NativeAdapterError::definite(
                            NativeAdapterErrorCode::ObservationStale,
                            "macOS AX element disappeared from its observation",
                            true,
                        )
                    })?;
                    (
                        Some(selector),
                        Some(mac_ax_action(*action, value.as_ref())?),
                    )
                }
                NativeAction::Focus { .. } => (None, None),
                _ => unreachable!("validated semantic action"),
            };
            (
                stored.target.clone(),
                selector,
                action,
                stored.snapshot.roots().to_vec(),
            )
        };
        self.invalidate_frames().await;
        if let (Some(selector), Some(action)) = (selector, action) {
            let controller = self.ax_controller()?.ok_or_else(|| {
                NativeAdapterError::definite(
                    NativeAdapterErrorCode::PermissionDenied,
                    "macOS Accessibility permission is required for semantic actions",
                    true,
                )
            })?;
            let native = record.native.clone();
            tokio::task::spawn_blocking(move || {
                controller.perform_action(&native, &selector, &action)
            })
            .await
            .map_err(|error| {
                NativeAdapterError::outcome_unknown(format!(
                    "macOS AX action task failed after dispatch: {error}"
                ))
            })?
            .map_err(map_ffi_mutation)?;
        } else {
            let native = record.native.clone();
            tokio::task::spawn_blocking(move || focus_target(&native))
                .await
                .map_err(|error| {
                    NativeAdapterError::outcome_unknown(format!(
                        "macOS focus task failed after dispatch: {error}"
                    ))
                })?
                .map_err(map_ffi_mutation)?;
        }
        Ok(self
            .observe_after_mutation(&record.target.id, &before_roots)
            .await
            .ok())
    }

    async fn dispatch_keyboard_target(
        &self,
        command: &NativeActionCommand,
    ) -> NativeAdapterResult<Option<NativeObservation>> {
        let _seat = self.input_seat.lock().await;
        let record = self.load_target(&command.target_id).await?;
        if record.target.target_generation != command.expected_target_generation
            || record.native.ax_window.is_none() && record.target.kind == NativeTargetKind::Window
        {
            return Err(NativeAdapterError::definite(
                NativeAdapterErrorCode::TargetStale,
                "macOS keyboard target changed",
                true,
            ));
        }
        let input = keyboard_or_clipboard_input(&command.action)?;
        self.invalidate_frames().await;
        tokio::task::spawn_blocking(move || focus_and_inject_target(&record.native, &[input]))
            .await
            .map_err(|error| {
                NativeAdapterError::outcome_unknown(format!(
                    "macOS keyboard task failed after dispatch: {error}"
                ))
            })?
            .map_err(map_ffi_mutation)?;
        // Raw input already completed atomically against the exact target.
        // Keep acknowledgement on the input critical path; semantic state is a
        // separate explicit observation and live capture publishes convergence.
        Ok(None)
    }

    async fn dispatch_clipboard_storage(
        &self,
        command: &NativeActionCommand,
    ) -> Option<NativeAdapterResult<Option<NativeObservation>>> {
        let NativeAction::Clipboard { operation, text } = &command.action else {
            return None;
        };
        if !matches!(
            operation,
            NativeClipboardAction::Write | NativeClipboardAction::Clear
        ) {
            return None;
        }
        Some(
            async {
                self.validate(command).await?;
                self.clipboard
                    .as_ref()
                    .ok_or_else(|| {
                        NativeAdapterError::unsupported(
                            "native text clipboard is unavailable on this macOS login seat",
                        )
                    })?
                    .mutate(*operation, text.clone())
                    .await?;
                Ok(self.observe(&command.target_id).await.ok())
            }
            .await,
        )
    }
}

#[async_trait]
impl ComputerAdapter for AxComputerAdapter {
    fn capabilities(&self) -> NativeCapabilities {
        let unlocked = machine_locked().is_ok_and(|locked| !locked);
        capabilities_for_grants(MacCapabilityGrants {
            unlocked,
            accessibility: accessibility_trusted(),
            input_monitoring: input_monitoring_granted(),
            screen_capture: screen_capture_granted(),
            clipboard: self.clipboard.is_some(),
        })
    }

    async fn targets(&self) -> NativeAdapterResult<Vec<NativeTarget>> {
        Self::ensure_unlocked()?;
        let mut targets: Vec<NativeTarget> = self
            .refresh_target_records()
            .await?
            .into_iter()
            .map(|record| record.target)
            .collect();
        targets.extend(
            Self::screen_records()?
                .into_iter()
                .map(|record| record.target),
        );
        Ok(targets)
    }

    async fn observe(&self, target_id: &str) -> NativeAdapterResult<NativeObservation> {
        Self::ensure_unlocked()?;
        if let Some(screen) = Self::load_screen(target_id)? {
            return Ok(self.screen_observation(screen.target).await);
        }
        let record = self.load_target(target_id).await?;
        self.observe_target(record).await
    }

    async fn capture(&self, target_id: &str) -> NativeAdapterResult<NativeCapturedFrame> {
        Self::ensure_unlocked()?;
        if let Some(screen) = Self::load_screen(target_id)? {
            return self.capture_screen(screen, None).await;
        }
        let record = self.load_target(target_id).await?;
        match record.target.kind {
            NativeTargetKind::Window => self.capture_window(record, None).await,
            NativeTargetKind::App => Err(NativeAdapterError::unsupported(
                "capture one exact macOS window target rather than an ambiguous application",
            )),
            NativeTargetKind::Screen => unreachable!(),
        }
    }

    async fn start_capture_stream(
        &self,
        target_id: &str,
        options: NativeCaptureOptions,
    ) -> NativeAdapterResult<()> {
        Self::ensure_unlocked()?;
        let _lifecycle = self.live_capture_lifecycle.lock().await;

        let (target_generation, stream) =
            if let Some(screen) = Self::load_screen(target_id)? {
                let target_generation = screen.target.target_generation.clone();
                {
                    let captures = self.live_captures.lock().map_err(|_| {
                        driver_failure("macOS live-capture registry lock is poisoned")
                    })?;
                    if captures.get(target_id).is_some_and(|capture| {
                        capture.options == options && capture.target_generation == target_generation
                    }) {
                        return Ok(());
                    }
                }
                let display_id = screen.display.id;
                let stream = tokio::task::spawn_blocking(move || {
                    start_display_frame_stream(&display_id, options.max_width, options.max_height)
                })
                .await
                .map_err(|error| {
                    driver_failure(format!("macOS live-display startup task failed: {error}"))
                })?
                .map_err(map_ffi_pre_dispatch)?;
                (target_generation, Arc::new(stream))
            } else {
                let record = self.load_target(target_id).await?;
                if record.target.kind != NativeTargetKind::Window {
                    return Err(NativeAdapterError::unsupported(
                        "live capture requires one exact macOS window or screen",
                    ));
                }
                let window_id = record.native.window_id.ok_or_else(|| {
                    NativeAdapterError::unsupported(
                        "macOS window is not unambiguously correlated to ScreenCaptureKit",
                    )
                })?;
                let process_id = record.native.process_id;
                let target_generation = record.target.target_generation;
                {
                    let captures = self.live_captures.lock().map_err(|_| {
                        driver_failure("macOS live-capture registry lock is poisoned")
                    })?;
                    if captures.get(target_id).is_some_and(|capture| {
                        capture.options == options && capture.target_generation == target_generation
                    }) {
                        return Ok(());
                    }
                }
                let stream = tokio::task::spawn_blocking(move || {
                    start_window_frame_stream(
                        window_id,
                        process_id,
                        options.max_width,
                        options.max_height,
                    )
                })
                .await
                .map_err(|error| {
                    driver_failure(format!("macOS live-window startup task failed: {error}"))
                })?
                .map_err(map_ffi_pre_dispatch)?;
                (target_generation, Arc::new(stream))
            };

        let previous = self
            .live_captures
            .lock()
            .map_err(|_| driver_failure("macOS live-capture registry lock is poisoned"))?
            .insert(
                target_id.to_string(),
                LiveCapture {
                    options,
                    target_generation,
                    stream,
                },
            );
        if let Some(previous) = previous {
            tokio::task::spawn_blocking(move || previous.stream.stop())
                .await
                .map_err(|error| {
                    driver_failure(format!("macOS old live-capture shutdown failed: {error}"))
                })?;
        }
        Ok(())
    }

    async fn capture_stream(
        &self,
        target_id: &str,
        options: NativeCaptureOptions,
    ) -> NativeAdapterResult<NativeCapturedFrame> {
        Self::ensure_unlocked()?;
        if let Some(screen) = Self::load_screen(target_id)? {
            let stream = self.live_capture(target_id, options, &screen.target.target_generation)?;
            let captured = tokio::task::spawn_blocking(move || stream.next_frame())
                .await
                .map_err(|error| {
                    driver_failure(format!("macOS live-display frame task failed: {error}"))
                })?
                .map_err(map_ffi_pre_dispatch)?;
            return self
                .finish_screen_capture(screen, captured, Some(options))
                .await;
        }
        let record = self.load_target(target_id).await?;
        match record.target.kind {
            NativeTargetKind::Window => {
                let stream =
                    self.live_capture(target_id, options, &record.target.target_generation)?;
                let frame = tokio::task::spawn_blocking(move || stream.next_frame())
                    .await
                    .map_err(|error| {
                        driver_failure(format!("macOS live-window frame task failed: {error}"))
                    })?
                    .map_err(map_ffi_pre_dispatch)?;
                let window_id = record.native.window_id.ok_or_else(|| {
                    NativeAdapterError::unsupported(
                        "macOS window is not unambiguously correlated to ScreenCaptureKit",
                    )
                })?;
                let bounds = record.native.bounds.ok_or_else(|| {
                    driver_failure("macOS window has no stable live-capture bounds")
                })?;
                self.finish_window_capture(
                    record,
                    MacWindowFrame {
                        window_id,
                        bounds,
                        frame,
                    },
                    Some(options),
                )
                .await
            }
            NativeTargetKind::App => Err(NativeAdapterError::unsupported(
                "capture one exact macOS window target rather than an ambiguous application",
            )),
            NativeTargetKind::Screen => unreachable!(),
        }
    }

    async fn stop_capture_stream(&self, target_id: &str) -> NativeAdapterResult<()> {
        let _lifecycle = self.live_capture_lifecycle.lock().await;
        let capture = self
            .live_captures
            .lock()
            .map_err(|_| driver_failure("macOS live-capture registry lock is poisoned"))?
            .remove(target_id);
        if let Some(capture) = capture {
            tokio::task::spawn_blocking(move || capture.stream.stop())
                .await
                .map_err(|error| {
                    driver_failure(format!("macOS live-capture shutdown task failed: {error}"))
                })?;
        }
        Ok(())
    }

    async fn clipboard(&self) -> NativeAdapterResult<NativeClipboard> {
        Self::ensure_unlocked()?;
        self.clipboard
            .as_ref()
            .ok_or_else(|| {
                NativeAdapterError::unsupported(
                    "native text clipboard is unavailable on this macOS login seat",
                )
            })?
            .read()
            .await
    }

    async fn validate(&self, command: &NativeActionCommand) -> NativeAdapterResult<()> {
        Self::ensure_unlocked()?;
        if let Some(screen) = Self::load_screen(&command.target_id)? {
            return self.validate_screen(command, &screen).await;
        }
        match &command.action {
            NativeAction::Pointer { .. } => {
                self.validate_window_pointer(command).await?;
                Ok(())
            }
            NativeAction::Semantic { .. } | NativeAction::Focus { .. } => {
                self.validate_observed_action(command).await
            }
            NativeAction::Keyboard { .. } | NativeAction::Clipboard { .. } => {
                if let NativeAction::Clipboard { operation, text } = &command.action {
                    validate_clipboard_payload(*operation, text.as_deref())?;
                    if self.clipboard.is_none() {
                        return Err(NativeAdapterError::unsupported(
                            "native text clipboard is unavailable on this macOS login seat",
                        ));
                    }
                }
                let record = self.load_target(&command.target_id).await?;
                if record.target.target_generation != command.expected_target_generation {
                    return Err(NativeAdapterError::definite(
                        NativeAdapterErrorCode::TargetStale,
                        "macOS keyboard target generation changed",
                        true,
                    ));
                }
                Ok(())
            }
            NativeAction::Launch { .. } => Err(NativeAdapterError::unsupported(
                "macOS application launch must target the screen",
            )),
        }
    }

    async fn dispatch(
        &self,
        command: &NativeActionCommand,
    ) -> NativeAdapterResult<Option<NativeObservation>> {
        Self::ensure_unlocked()?;
        if let Some(result) = self.dispatch_clipboard_storage(command).await {
            return result;
        }
        if let Some(screen) = Self::load_screen(&command.target_id)? {
            // Screen pointer/keyboard input and activating application launch
            // all contend for the same physical Aqua seat.
            let _seat = self.input_seat.lock().await;
            self.validate_screen(command, &screen).await?;
            let frame = if matches!(command.action, NativeAction::Pointer { .. }) {
                self.latest_screen_frames
                    .read()
                    .await
                    .get(&command.target_id)
                    .cloned()
            } else {
                None
            };
            self.invalidate_frames().await;
            match &command.action {
                NativeAction::Pointer { .. } => {
                    let frame = frame.ok_or_else(|| stale_frame("macOS screen"))?;
                    inject_display_batch(
                        &screen.display,
                        frame.width,
                        frame.height,
                        &pointer_inputs(&command.action)?,
                    )
                    .map_err(map_ffi_mutation)?;
                }
                NativeAction::Keyboard { .. } | NativeAction::Clipboard { .. } => {
                    inject_batch(&[keyboard_or_clipboard_input(&command.action)?])
                        .map_err(map_ffi_mutation)?;
                }
                NativeAction::Launch { application_id } => {
                    let application_id = application_id.clone();
                    tokio::task::spawn_blocking(move || launch_application(&application_id))
                        .await
                        .map_err(|error| {
                            NativeAdapterError::outcome_unknown(format!(
                                "macOS launch task failed after dispatch: {error}"
                            ))
                        })?
                        .map_err(map_ffi_mutation)?;
                }
                NativeAction::Semantic { .. } | NativeAction::Focus { .. } => unreachable!(),
            }
            return Ok(Some(self.screen_observation(screen.target).await));
        }
        match &command.action {
            NativeAction::Pointer { .. } => self.dispatch_window_pointer(command).await,
            NativeAction::Keyboard { .. } | NativeAction::Clipboard { .. } => {
                self.dispatch_keyboard_target(command).await
            }
            NativeAction::Semantic { .. } | NativeAction::Focus { .. } => {
                self.dispatch_semantic(command).await
            }
            NativeAction::Launch { .. } => Err(NativeAdapterError::unsupported(
                "macOS application launch must target the screen",
            )),
        }
    }
}

#[derive(Clone, Copy)]
#[allow(clippy::struct_excessive_bools)]
struct MacCapabilityGrants {
    unlocked: bool,
    accessibility: bool,
    input_monitoring: bool,
    screen_capture: bool,
    clipboard: bool,
}

fn capabilities_for_grants(grants: MacCapabilityGrants) -> NativeCapabilities {
    let semantic = grants.unlocked && grants.accessibility;
    let input = semantic && grants.input_monitoring;
    let capture = grants.unlocked && grants.screen_capture;
    NativeCapabilities {
        semantic_observation: semantic,
        app_discovery: grants.unlocked,
        app_launch: grants.unlocked,
        window_capture: capture,
        screen_capture: capture,
        semantic_actions: semantic,
        pointer_input: input,
        keyboard_input: input,
        clipboard: grants.unlocked && grants.clipboard,
        background_actions: semantic,
        parallel_apps: semantic,
    }
}

fn target_record(native: MacTargetInfo) -> TargetRecord {
    let kind = match native.kind {
        MacTargetKind::Application => NativeTargetKind::App,
        MacTargetKind::Window => NativeTargetKind::Window,
    };
    let identity = match native.kind {
        MacTargetKind::Application => format!(
            "app\0{}\0{}\0{}",
            native.process_id,
            native.process_generation,
            native.application_id.as_deref().unwrap_or("")
        ),
        MacTargetKind::Window => native.window_id.map_or_else(
            || {
                let selector = native.ax_window.as_ref();
                format!(
                    "window\0{}\0{}\0ax:{}",
                    native.process_id,
                    native.process_generation,
                    selector.map_or(u32::MAX, |value| value.window_index),
                )
            },
            |window_id| {
                format!(
                    "window\0{}\0{}\0sck:{window_id}",
                    native.process_id, native.process_generation
                )
            },
        ),
    };
    let prefix = match kind {
        NativeTargetKind::App => "app",
        NativeTargetKind::Window => "window",
        NativeTargetKind::Screen => unreachable!(),
    };
    let digest = stable_digest(&identity);
    let generation_identity = match native.kind {
        MacTargetKind::Application => identity,
        // ScreenCaptureKit's window id plus process-launch generation is the
        // exact physical window lifetime. Title, focus and bounds are mutable
        // metadata; putting them in the generation tears down a live stream
        // during normal app interaction. AX-only windows have no native id, so
        // retain the fingerprint fence until they become capturable.
        MacTargetKind::Window if native.window_id.is_some() => identity,
        MacTargetKind::Window => format!(
            "{}\0{}\0{:?}\0{:?}",
            identity, native.title, native.bounds, native.ax_window
        ),
    };
    let target = NativeTarget {
        id: format!("{prefix}:{digest}"),
        target_generation: format!("g_{}", stable_digest(&generation_identity)),
        kind,
        application_id: native.application_id.clone(),
        process_id: Some(native.process_id),
        title: native.title.clone(),
        bounds: native.bounds.map(native_rect),
        focused: native.focused,
    };
    TargetRecord { target, native }
}

fn raw_node(node: MacAxNode) -> RawSemanticNode {
    let value = node.value.map(|value| match value {
        MacAxValue::Text(value) => NativeNodeValue::Text(value),
        MacAxValue::Number(value) => NativeNodeValue::Text(value.to_string()),
        MacAxValue::Boolean(value) => NativeNodeValue::Text(value.to_string()),
        MacAxValue::Password => NativeNodeValue::Redacted(NativeRedactedValue {
            redacted: true,
            reason: NativeRedactionReason::Password,
        }),
    });
    RawSemanticNode {
        key: node.key,
        parent_key: node.parent_key,
        index_in_parent: node.index_in_parent,
        role: node.role,
        identifier: node.identifier,
        name: node.name,
        description: node.description,
        value,
        states: node.states,
        bounds: node.bounds.map(native_rect),
        actions: node.actions,
        native: Some(NativeNodeMetadata {
            platform: NativeSemanticPlatform::MacAx,
            data: json!({
                "subrole": node.subrole,
                "rawActions": node.raw_actions,
                "childrenTruncated": node.children_truncated,
            }),
        }),
    }
}

fn mac_ax_action(
    action: NativeSemanticAction,
    value: Option<&NativeActionValue>,
) -> NativeAdapterResult<MacAxAction> {
    Ok(match action {
        NativeSemanticAction::Invoke => MacAxAction::Invoke,
        NativeSemanticAction::Focus => MacAxAction::Focus,
        NativeSemanticAction::SetValue => {
            let value = value.ok_or_else(|| invalid("set_value requires a value"))?;
            MacAxAction::SetValue(match value {
                NativeActionValue::String(value) => MacAxActionValue::String(value.clone()),
                NativeActionValue::Number(value) if value.is_finite() => {
                    MacAxActionValue::Number(*value)
                }
                NativeActionValue::Number(_) => {
                    return Err(invalid("set_value number must be finite"));
                }
                NativeActionValue::Boolean(value) => MacAxActionValue::Boolean(*value),
            })
        }
        NativeSemanticAction::Increment => MacAxAction::Increment,
        NativeSemanticAction::Decrement => MacAxAction::Decrement,
        NativeSemanticAction::Select => MacAxAction::Select,
        NativeSemanticAction::Deselect => MacAxAction::Deselect,
        NativeSemanticAction::Expand => MacAxAction::Expand,
        NativeSemanticAction::Collapse => MacAxAction::Collapse,
        NativeSemanticAction::ShowMenu => MacAxAction::ShowMenu,
        NativeSemanticAction::ScrollIntoView => MacAxAction::ScrollIntoView,
    })
}

fn pointer_inputs(action: &NativeAction) -> NativeAdapterResult<Vec<InputEvent>> {
    let NativeAction::Pointer {
        action,
        x,
        y,
        end_x,
        end_y,
        delta_x,
        delta_y,
        button,
        ..
    } = action
    else {
        return Err(invalid("expected pointer action"));
    };
    let button = match button.unwrap_or(NativePointerButton::Left) {
        NativePointerButton::Left => PointerButton::Left,
        NativePointerButton::Right => PointerButton::Right,
        NativePointerButton::Middle => PointerButton::Middle,
    };
    let (x, y) = checked_point(*x, *y)?;
    Ok(match action {
        NativePointerAction::Click => vec![InputEvent::Pointer {
            x,
            y,
            button,
            action: PointerAction::Click,
        }],
        NativePointerAction::DoubleClick => vec![InputEvent::Pointer {
            x,
            y,
            button,
            action: PointerAction::DoubleClick,
        }],
        NativePointerAction::Move => vec![InputEvent::Pointer {
            x,
            y,
            button,
            action: PointerAction::Move,
        }],
        NativePointerAction::Scroll => vec![
            InputEvent::Pointer {
                x,
                y,
                button,
                action: PointerAction::Move,
            },
            InputEvent::Scroll {
                dx: checked_i32(delta_x.unwrap_or(0.0), "horizontal scroll delta")?,
                dy: checked_i32(delta_y.unwrap_or(0.0), "vertical scroll delta")?,
            },
        ],
        NativePointerAction::Drag => {
            let (end_x, end_y) = checked_point(
                end_x.ok_or_else(|| invalid("drag requires endX"))?,
                end_y.ok_or_else(|| invalid("drag requires endY"))?,
            )?;
            vec![
                InputEvent::Pointer {
                    x,
                    y,
                    button,
                    action: PointerAction::Down,
                },
                InputEvent::Pointer {
                    x: end_x,
                    y: end_y,
                    button,
                    action: PointerAction::Move,
                },
                InputEvent::Pointer {
                    x: end_x,
                    y: end_y,
                    button,
                    action: PointerAction::Up,
                },
            ]
        }
    })
}

fn keyboard_or_clipboard_input(action: &NativeAction) -> NativeAdapterResult<InputEvent> {
    match action {
        NativeAction::Keyboard { action, value } => Ok(match action {
            NativeKeyboardAction::Type => InputEvent::Key {
                text: Some(value.clone()),
                named: None,
                action: KeyAction::Press,
            },
            NativeKeyboardAction::Press => InputEvent::Key {
                text: None,
                named: Some(value.clone()),
                action: KeyAction::Press,
            },
        }),
        NativeAction::Clipboard { operation, text } => {
            validate_clipboard_payload(*operation, text.as_deref())?;
            let named = match operation {
                NativeClipboardAction::Copy => "Command+c",
                NativeClipboardAction::Paste => "Command+v",
                NativeClipboardAction::Write | NativeClipboardAction::Clear => {
                    return Err(NativeAdapterError::unsupported(
                        "clipboard storage mutations are not macOS key input",
                    ));
                }
            };
            Ok(InputEvent::Key {
                text: None,
                named: Some(named.to_string()),
                action: KeyAction::Press,
            })
        }
        _ => Err(invalid("expected keyboard or clipboard-transfer action")),
    }
}

fn validate_clipboard_payload(
    operation: NativeClipboardAction,
    text: Option<&str>,
) -> NativeAdapterResult<()> {
    if (operation == NativeClipboardAction::Write) != text.is_some() {
        return Err(invalid(
            "native clipboard text is required exactly for write",
        ));
    }
    if text.is_some_and(|value| value.len() > 1024 * 1024) {
        return Err(invalid(
            "native clipboard text exceeds its UTF-8 byte envelope",
        ));
    }
    Ok(())
}

fn encode_png(rgba: &[u8], width: u32, height: u32) -> NativeAdapterResult<Vec<u8>> {
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(rgba, width, height, ExtendedColorType::Rgba8)
        .map_err(|error| driver_failure(format!("encode macOS capture: {error}")))?;
    Ok(png)
}

fn encode_frame(
    rgba: &[u8],
    width: u32,
    height: u32,
    options: Option<NativeCaptureOptions>,
) -> NativeAdapterResult<(Vec<u8>, String)> {
    if options.is_none_or(|options| options.format == NativeFrameFormat::Png) {
        return Ok((encode_png(rgba, width, height)?, "image/png".to_string()));
    }
    let quality = options.map_or(80, |options| options.quality);
    let mut rgb = Vec::with_capacity(rgba.len() / 4 * 3);
    for pixel in rgba.chunks_exact(4) {
        rgb.extend_from_slice(&pixel[..3]);
    }
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, quality)
        .write_image(&rgb, width, height, ExtendedColorType::Rgb8)
        .map_err(|error| driver_failure(format!("encode macOS live frame: {error}")))?;
    Ok((jpeg, "image/jpeg".to_string()))
}

fn captured_frame(
    frame_id: String,
    target: NativeTarget,
    width: u32,
    height: u32,
    mime_type: String,
    bytes: Vec<u8>,
) -> NativeCapturedFrame {
    NativeCapturedFrame {
        frame_id,
        target_id: target.id,
        target_generation: target.target_generation,
        width,
        height,
        mime_type,
        sha256: hex::encode(Sha256::digest(&bytes)),
        bytes,
    }
}

fn native_rect(rect: MacRect) -> NativeRect {
    NativeRect {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
    }
}

fn find_focused_ref(nodes: &[crate::NativeSemanticNode]) -> Option<String> {
    for node in nodes {
        if node.states.iter().any(|state| state == "focused") {
            return Some(node.r#ref.clone());
        }
        if let Some(found) = find_focused_ref(&node.children) {
            return Some(found);
        }
    }
    None
}

fn validate_local_point(x: f64, y: f64, width: u32, height: u32) -> NativeAdapterResult<()> {
    if !x.is_finite()
        || !y.is_finite()
        || x < 0.0
        || y < 0.0
        || x >= f64::from(width)
        || y >= f64::from(height)
    {
        return Err(invalid(
            "pointer coordinates are outside the exact captured macOS frame",
        ));
    }
    Ok(())
}

fn validate_optional_end(
    end_x: Option<f64>,
    end_y: Option<f64>,
    width: u32,
    height: u32,
) -> NativeAdapterResult<()> {
    match (end_x, end_y) {
        (Some(x), Some(y)) => validate_local_point(x, y, width, height),
        (None, None) => Ok(()),
        _ => Err(invalid("pointer end coordinates must be supplied together")),
    }
}

fn checked_point(x: f64, y: f64) -> NativeAdapterResult<(i32, i32)> {
    Ok((checked_i32(x, "pointer x")?, checked_i32(y, "pointer y")?))
}

fn checked_i32(value: f64, label: &str) -> NativeAdapterResult<i32> {
    if !value.is_finite() || value < f64::from(i32::MIN) || value > f64::from(i32::MAX) {
        return Err(invalid(format!(
            "{label} is outside the native coordinate range"
        )));
    }
    #[allow(clippy::cast_possible_truncation)]
    Ok(value.round() as i32)
}

fn rect_nearly_equal(left: MacRect, right: MacRect, tolerance: f64) -> bool {
    (left.x - right.x).abs() <= tolerance
        && (left.y - right.y).abs() <= tolerance
        && (left.width - right.width).abs() <= tolerance
        && (left.height - right.height).abs() <= tolerance
}

fn stable_digest(value: &str) -> String {
    hex::encode(&Sha256::digest(value.as_bytes())[..16])
}

fn stale_frame(label: &str) -> NativeAdapterError {
    NativeAdapterError::definite(
        NativeAdapterErrorCode::FrameStale,
        format!("{label} pointer coordinates target a stale captured frame"),
        true,
    )
}

fn invalid(message: impl Into<String>) -> NativeAdapterError {
    NativeAdapterError::definite(NativeAdapterErrorCode::InvalidAction, message, false)
}

fn driver_failure(message: impl Into<String>) -> NativeAdapterError {
    NativeAdapterError::definite(NativeAdapterErrorCode::DriverFailed, message, true)
}

fn map_ffi_pre_dispatch(error: MacFfiError) -> NativeAdapterError {
    match error {
        MacFfiError::Unsupported(message) | MacFfiError::ActionUnsupported(message) => {
            NativeAdapterError::unsupported(message)
        }
        MacFfiError::PermissionDenied(message) => {
            NativeAdapterError::definite(NativeAdapterErrorCode::PermissionDenied, message, true)
        }
        MacFfiError::TargetStale(message) => {
            NativeAdapterError::definite(NativeAdapterErrorCode::TargetStale, message, true)
        }
        MacFfiError::SelectorStale(message) => {
            NativeAdapterError::definite(NativeAdapterErrorCode::ObservationStale, message, true)
        }
        MacFfiError::Invalid(message) => {
            NativeAdapterError::definite(NativeAdapterErrorCode::InvalidAction, message, false)
        }
        MacFfiError::TimedOut(message) => {
            NativeAdapterError::definite(NativeAdapterErrorCode::Timeout, message, true)
        }
        MacFfiError::OutcomeUnknown(message) => NativeAdapterError::outcome_unknown(message),
        MacFfiError::InputInterrupted(message) => {
            NativeAdapterError::definite(NativeAdapterErrorCode::Unavailable, message, true)
        }
        MacFfiError::Ffi(message) => driver_failure(message),
    }
}

fn map_ffi_mutation(error: MacFfiError) -> NativeAdapterError {
    match error {
        MacFfiError::OutcomeUnknown(message) => NativeAdapterError::outcome_unknown(message),
        other => map_ffi_pre_dispatch(other),
    }
}

#[cfg(test)]
mod capability_tests {
    use super::*;

    fn window_target(window_id: Option<u32>, title: &str, x: f64) -> MacTargetInfo {
        MacTargetInfo {
            kind: MacTargetKind::Window,
            process_id: 42,
            process_generation: "launch-1".to_string(),
            application_id: Some("com.example.fixture".to_string()),
            application_name: "Fixture".to_string(),
            title: title.to_string(),
            bounds: Some(MacRect {
                x,
                y: 20.0,
                width: 800.0,
                height: 600.0,
            }),
            focused: false,
            window_id,
            ax_window: None,
        }
    }

    #[test]
    fn native_window_generation_survives_mutable_title_and_bounds() {
        let initial = target_record(window_target(Some(77), "Initial", 10.0));
        let changed = target_record(window_target(Some(77), "Changed", 30.0));
        assert_eq!(initial.target.id, changed.target.id);
        assert_eq!(
            initial.target.target_generation,
            changed.target.target_generation
        );

        let ax_only_initial = target_record(window_target(None, "Initial", 10.0));
        let ax_only_changed = target_record(window_target(None, "Changed", 30.0));
        assert_eq!(ax_only_initial.target.id, ax_only_changed.target.id);
        assert_ne!(
            ax_only_initial.target.target_generation,
            ax_only_changed.target.target_generation
        );
    }

    #[test]
    fn projects_each_live_tcc_and_lock_boundary_independently() {
        let complete_grants = MacCapabilityGrants {
            unlocked: true,
            accessibility: true,
            input_monitoring: true,
            screen_capture: true,
            clipboard: true,
        };
        let complete = capabilities_for_grants(complete_grants);
        assert!(
            complete.semantic_actions
                && complete.pointer_input
                && complete.window_capture
                && complete.clipboard
        );

        let accessibility_revoked = capabilities_for_grants(MacCapabilityGrants {
            accessibility: false,
            ..complete_grants
        });
        assert!(!accessibility_revoked.semantic_observation);
        assert!(!accessibility_revoked.semantic_actions);
        assert!(!accessibility_revoked.pointer_input);
        assert!(accessibility_revoked.window_capture);

        let monitoring_revoked = capabilities_for_grants(MacCapabilityGrants {
            input_monitoring: false,
            ..complete_grants
        });
        assert!(monitoring_revoked.semantic_actions);
        assert!(!monitoring_revoked.pointer_input && !monitoring_revoked.keyboard_input);
        assert!(monitoring_revoked.window_capture);

        let capture_revoked = capabilities_for_grants(MacCapabilityGrants {
            screen_capture: false,
            ..complete_grants
        });
        assert!(capture_revoked.semantic_actions && capture_revoked.pointer_input);
        assert!(!capture_revoked.window_capture && !capture_revoked.screen_capture);

        let locked = capabilities_for_grants(MacCapabilityGrants {
            unlocked: false,
            ..complete_grants
        });
        assert!(!locked.app_discovery && !locked.app_launch);
        assert!(
            !locked.semantic_actions
                && !locked.pointer_input
                && !locked.window_capture
                && !locked.clipboard
        );
    }
}
