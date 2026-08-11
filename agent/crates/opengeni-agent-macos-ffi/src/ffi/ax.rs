//! macOS Accessibility/AppKit implementation inside the crate's audited FFI boundary.

#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::too_many_lines
)]

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{mpsc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use accessibility_sys::{
    kAXApplicationActivatedNotification, kAXApplicationDeactivatedNotification,
    kAXDescriptionAttribute, kAXElementBusyAttribute, kAXEnabledAttribute,
    kAXErrorNotificationAlreadyRegistered, kAXErrorSuccess, kAXExpandedAttribute,
    kAXFocusedAttribute, kAXFocusedUIElementChangedNotification,
    kAXFocusedWindowChangedNotification, kAXHelpAttribute, kAXIdentifierAttribute,
    kAXLabelValueAttribute, kAXLayoutChangedNotification, kAXMainAttribute,
    kAXMainWindowChangedNotification, kAXMinimizedAttribute, kAXPositionAttribute,
    kAXRoleAttribute, kAXSecureTextFieldSubrole, kAXSelectedAttribute,
    kAXSelectedChildrenChangedNotification, kAXSizeAttribute, kAXSubroleAttribute,
    kAXTitleAttribute, kAXTitleChangedNotification, kAXUIElementDestroyedNotification,
    kAXValueAttribute, kAXValueChangedNotification, kAXValueTypeCGPoint, kAXValueTypeCGSize,
    kAXWindowCreatedNotification, AXObserverAddNotification, AXObserverCreate,
    AXObserverGetRunLoopSource, AXObserverRef, AXObserverRemoveNotification,
    AXUIElementCopyAttributeValue, AXUIElementCopyMultipleAttributeValues, AXUIElementRef,
    AXValueGetType, AXValueGetTypeID, AXValueGetValue,
};
use block2::RcBlock;
use core_foundation::array::CFArray;
use core_foundation::base::{CFGetTypeID, CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::number::CFNumber;
use core_foundation::runloop::{kCFRunLoopDefaultMode, CFRunLoop, CFRunLoopSource};
use core_foundation::string::CFString;
use objc2_app_kit::{
    NSApplicationActivationOptions, NSApplicationActivationPolicy, NSRunningApplication,
    NSWorkspace, NSWorkspaceOpenConfiguration,
};
use objc2_foundation::NSError;

use super::{ax_element::AxElement, ShareableWindow};
use crate::{
    MacAxAction, MacAxActionValue, MacAxElementSelector, MacAxFingerprint, MacAxNode,
    MacAxObservedState, MacAxPathStep, MacAxSnapshot, MacAxValue, MacAxWindowSelector, MacFfiError,
    MacRect, MacTargetInfo, MacTargetKind,
};

const AX_MESSAGE_TIMEOUT_SECONDS: f32 = 0.5;
const AX_SNAPSHOT_DEADLINE: Duration = Duration::from_secs(6);
const AX_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
const AX_WORKER_POLL: Duration = Duration::from_millis(20);
const AX_WORKER_LIVENESS_POLL: Duration = Duration::from_secs(1);
const MAX_AX_APPS: usize = 256;
const MAX_AX_WINDOWS_PER_APP: usize = 256;
const MAX_AX_NODES: usize = 5_000;
const MAX_AX_DEPTH: usize = 64;
const MAX_AX_OBSERVED_ELEMENTS: usize = 512;
const MAX_AX_SNAPSHOTS_PER_PROCESS: usize = 32;
const MAX_AX_ACTIONS_PER_NODE: usize = 64;
const MAX_STRING_CHARS: usize = 32_768;
const AX_CONTAINS_PROTECTED_CONTENT: &str = "AXContainsProtectedContent";
const AX_SCROLL_TO_VISIBLE_ACTION: &str = "AXScrollToVisible";
const AX_CORE_ATTRIBUTES: [&str; 16] = [
    "AXRole",
    "AXSubrole",
    "AXIdentifier",
    "AXTitle",
    "AXLabelValue",
    "AXDescription",
    "AXHelp",
    "AXEnabled",
    "AXFocused",
    "AXElementBusy",
    "AXMinimized",
    "AXSelected",
    "AXExpanded",
    AX_CONTAINS_PROTECTED_CONTENT,
    kAXPositionAttribute,
    kAXSizeAttribute,
];

pub(crate) struct MacAxControllerImpl {
    workers: Mutex<HashMap<u32, AxWorkerHandle>>,
}

struct AxWorkerHandle {
    sender: mpsc::Sender<AxWorkerCommand>,
    join: Option<JoinHandle<()>>,
    process_generation: String,
}

enum AxWorkerCommand {
    Snapshot {
        target: MacTargetInfo,
        response: mpsc::Sender<Result<MacAxSnapshot, MacFfiError>>,
    },
    Perform {
        target: MacTargetInfo,
        selector: Box<MacAxElementSelector>,
        action: MacAxAction,
        response: mpsc::Sender<Result<(), MacFfiError>>,
    },
    Shutdown,
}

struct StoredSnapshot {
    snapshot_id: String,
    target: MacTargetInfo,
    elements: HashMap<String, AxElement>,
    notification_keys: Vec<(usize, String)>,
}

struct AxWorkerState {
    app: AxElement,
    next_snapshot: u64,
    snapshots: HashMap<String, StoredSnapshot>,
    observer: Option<AxObserver>,
    notification_rx: mpsc::Receiver<()>,
}

struct AxObserver {
    raw: AXObserverRef,
    _owner: CFType,
    source: CFRunLoopSource,
    run_loop: CFRunLoop,
    context: Box<AxObserverContext>,
    registrations: HashMap<(usize, String), ObserverRegistration>,
    base_keys: HashSet<(usize, String)>,
}

struct ObserverRegistration {
    element: AxElement,
    references: usize,
}

struct AxObserverContext {
    sender: mpsc::SyncSender<()>,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct AxPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct AxSize {
    width: f64,
    height: f64,
}

#[derive(Clone)]
struct AxNodeCore {
    fingerprint: MacAxFingerprint,
    description: Option<String>,
    value: Option<MacAxValue>,
    enabled: Option<bool>,
    focused: Option<bool>,
    busy: Option<bool>,
    minimized: Option<bool>,
    selected: Option<bool>,
    expanded: Option<bool>,
}

struct PendingNode {
    element: AxElement,
    key: String,
    parent_key: Option<String>,
    index_in_parent: i32,
    depth: usize,
    core: AxNodeCore,
    path: Vec<MacAxPathStep>,
}

impl MacAxControllerImpl {
    pub(crate) fn open() -> Result<Self, MacFfiError> {
        require_accessibility()?;
        Ok(Self {
            workers: Mutex::new(HashMap::new()),
        })
    }

    pub(crate) fn snapshot(&self, target: &MacTargetInfo) -> Result<MacAxSnapshot, MacFfiError> {
        require_accessibility()?;
        let sender = self.worker(target)?;
        let (response, receiver) = mpsc::channel();
        sender
            .send(AxWorkerCommand::Snapshot {
                target: target.clone(),
                response,
            })
            .map_err(|_| MacFfiError::Ffi("AX worker exited before snapshot".to_string()))?;
        receiver.recv_timeout(AX_COMMAND_TIMEOUT).map_err(|_| {
            MacFfiError::TimedOut("AX snapshot exceeded its 15 second worker envelope".to_string())
        })?
    }

    pub(crate) fn perform_action(
        &self,
        target: &MacTargetInfo,
        selector: &MacAxElementSelector,
        action: &MacAxAction,
    ) -> Result<(), MacFfiError> {
        require_accessibility()?;
        let sender = self.worker(target)?;
        let (response, receiver) = mpsc::channel();
        sender
            .send(AxWorkerCommand::Perform {
                target: target.clone(),
                selector: Box::new(selector.clone()),
                action: action.clone(),
                response,
            })
            .map_err(|_| MacFfiError::Ffi("AX worker exited before action".to_string()))?;
        receiver.recv_timeout(AX_COMMAND_TIMEOUT).map_err(|_| {
            // The worker timeout is deliberately outcome-unknown for a mutation:
            // the AX call may still have crossed its side-effect boundary.
            MacFfiError::OutcomeUnknown(
                "AX action did not settle within its 15 second worker envelope".to_string(),
            )
        })?
    }

    fn worker(&self, target: &MacTargetInfo) -> Result<mpsc::Sender<AxWorkerCommand>, MacFfiError> {
        let process_id = target.process_id;
        let mut workers = self
            .workers
            .lock()
            .map_err(|_| MacFfiError::Ffi("AX worker registry is poisoned".to_string()))?;
        let finished: Vec<u32> = workers
            .iter()
            .filter_map(|(pid, worker)| {
                worker
                    .join
                    .as_ref()
                    .is_some_and(JoinHandle::is_finished)
                    .then_some(*pid)
            })
            .collect();
        for pid in finished {
            if let Some(mut worker) = workers.remove(&pid) {
                if let Some(join) = worker.join.take() {
                    let _ = join.join();
                }
            }
        }
        let can_reuse = workers.get(&process_id).is_some_and(|worker| {
            worker.process_generation == target.process_generation
                && worker.join.as_ref().is_some_and(|join| !join.is_finished())
        });
        if can_reuse {
            return Ok(workers
                .get(&process_id)
                .expect("checked reusable worker")
                .sender
                .clone());
        }
        if let Some(mut stale) = workers.remove(&process_id) {
            let _ = stale.sender.send(AxWorkerCommand::Shutdown);
            if let Some(join) = stale.join.take() {
                let _ = join.join();
            }
        }
        if workers.len() >= MAX_AX_APPS {
            return Err(MacFfiError::Ffi(format!(
                "AX worker registry exceeds its {MAX_AX_APPS}-process envelope"
            )));
        }
        let (sender, receiver) = mpsc::channel();
        let (ready, ready_receiver) = mpsc::channel();
        let worker_target = target.clone();
        let join = thread::Builder::new()
            .name(format!("opengeni-ax-{process_id}"))
            .spawn(move || ax_worker_main(&worker_target, &receiver, &ready))
            .map_err(|error| MacFfiError::Ffi(format!("spawn AX worker: {error}")))?;
        match ready_receiver.recv_timeout(Duration::from_secs(3)) {
            Ok(Ok(())) => {
                workers.insert(
                    process_id,
                    AxWorkerHandle {
                        sender: sender.clone(),
                        join: Some(join),
                        process_generation: target.process_generation.clone(),
                    },
                );
                Ok(sender)
            }
            Ok(Err(error)) => {
                let _ = join.join();
                Err(error)
            }
            Err(_) => {
                let _ = sender.send(AxWorkerCommand::Shutdown);
                let _ = join.join();
                Err(MacFfiError::TimedOut(
                    "AX worker initialization timed out".to_string(),
                ))
            }
        }
    }
}

impl Drop for MacAxControllerImpl {
    fn drop(&mut self) {
        let Ok(mut workers) = self.workers.lock() else {
            return;
        };
        for worker in workers.values() {
            let _ = worker.sender.send(AxWorkerCommand::Shutdown);
        }
        for worker in workers.values_mut() {
            if let Some(join) = worker.join.take() {
                let _ = join.join();
            }
        }
        workers.clear();
    }
}

fn ax_worker_main(
    worker_target: &MacTargetInfo,
    commands: &mpsc::Receiver<AxWorkerCommand>,
    ready: &mpsc::Sender<Result<(), MacFfiError>>,
) {
    let process_id = worker_target.process_id;
    let Ok(pid) = i32::try_from(process_id) else {
        let _ = ready.send(Err(MacFfiError::Invalid(
            "target process id exceeds the macOS pid range".to_string(),
        )));
        return;
    };
    let app = AxElement::application(pid);
    if let Err(error) = app.set_messaging_timeout(AX_MESSAGE_TIMEOUT_SECONDS) {
        let _ = ready.send(Err(MacFfiError::Ffi(format!(
            "initialize AX application root: {error}"
        ))));
        return;
    }
    // AX notifications are invalidation hints, not a lossless event log. One
    // pending signal is sufficient and prevents a chatty app from growing an
    // unbounded callback queue while a snapshot is being traversed.
    let (notification_tx, notification_rx) = mpsc::sync_channel(1);
    let observer = match AxObserver::open(pid, &app, notification_tx) {
        Ok(observer) => Some(observer),
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    let mut state = AxWorkerState {
        app,
        next_snapshot: 0,
        snapshots: HashMap::new(),
        observer,
        notification_rx,
    };
    let _ = ready.send(Ok(()));
    let mut last_liveness_poll = Instant::now();

    loop {
        state.pump_notifications();
        match commands.recv_timeout(AX_WORKER_POLL) {
            Ok(AxWorkerCommand::Snapshot { target, response }) => {
                state.pump_notifications();
                let _ = response.send(state.snapshot(target));
            }
            Ok(AxWorkerCommand::Perform {
                target,
                selector,
                action,
                response,
            }) => {
                state.pump_notifications();
                let _ = response.send(state.perform(&target, &selector, &action));
            }
            Ok(AxWorkerCommand::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if last_liveness_poll.elapsed() >= AX_WORKER_LIVENESS_POLL {
            if validate_running_application(worker_target).is_err() {
                break;
            }
            last_liveness_poll = Instant::now();
        }
    }
    state.invalidate_all();
}

impl AxWorkerState {
    fn pump_notifications(&mut self) {
        if self.observer.is_some() {
            let _ = unsafe {
                CFRunLoop::run_in_mode(kCFRunLoopDefaultMode, Duration::from_millis(1), true)
            };
        }
        if self.notification_rx.try_iter().next().is_some() {
            self.invalidate_all();
        }
    }

    fn snapshot(&mut self, target: MacTargetInfo) -> Result<MacAxSnapshot, MacFfiError> {
        validate_running_application(&target)?;
        let target_key = target_key(&target);
        self.remove_snapshot(&target_key);
        if self.snapshots.len() >= MAX_AX_SNAPSHOTS_PER_PROCESS {
            // A process can expose an arbitrary number of windows. Clear the
            // bounded retained-object cache rather than allowing old refs to
            // grow memory indefinitely; callers simply receive stale refs.
            self.invalidate_all();
        }
        self.next_snapshot = self.next_snapshot.saturating_add(1);
        let snapshot_id = format!("axs_{}_{}", target.process_id, self.next_snapshot);
        let (snapshot, elements) = build_snapshot(&self.app, &target, snapshot_id.clone())?;
        let notification_keys = self.observer.as_mut().map_or_else(Vec::new, |observer| {
            observer.register_snapshot(&elements, &snapshot)
        });
        self.snapshots.insert(
            target_key,
            StoredSnapshot {
                snapshot_id,
                target,
                elements,
                notification_keys,
            },
        );
        Ok(snapshot)
    }

    fn perform(
        &mut self,
        target: &MacTargetInfo,
        selector: &MacAxElementSelector,
        action: &MacAxAction,
    ) -> Result<(), MacFfiError> {
        validate_running_application(target)?;
        let key = target_key(target);
        let stored = self.snapshots.get(&key).ok_or_else(|| {
            MacFfiError::SelectorStale(
                "AX observation was invalidated before action dispatch".to_string(),
            )
        })?;
        if stored.snapshot_id != selector.snapshot_id || stored.target != *target {
            return Err(MacFfiError::SelectorStale(
                "AX selector does not belong to the target's latest observation".to_string(),
            ));
        }
        let element = if let Some(element) = stored.elements.get(&selector.element_key) {
            if verify_fingerprint(
                element,
                selector
                    .path
                    .last()
                    .map_or(&selector.root, |step| &step.fingerprint),
            )
            .is_ok()
            {
                element.clone()
            } else {
                resolve_selector_from_app(&self.app, target, selector)?
            }
        } else {
            resolve_selector_from_app(&self.app, target, selector)?
        };
        verify_observed_state(&element, &selector.observed_state)?;
        let result = perform_element_action(&element, action);
        // An attempted semantic mutation ends the observation generation even
        // on an ambiguous native error; callers must observe before another act.
        self.remove_snapshot(&key);
        result
    }

    fn remove_snapshot(&mut self, key: &str) {
        if let Some(snapshot) = self.snapshots.remove(key) {
            if let Some(observer) = &mut self.observer {
                observer.unregister_keys(&snapshot.notification_keys);
            }
        }
    }

    fn invalidate_all(&mut self) {
        let snapshots = std::mem::take(&mut self.snapshots);
        if let Some(observer) = &mut self.observer {
            for snapshot in snapshots.values() {
                observer.unregister_keys(&snapshot.notification_keys);
            }
        }
    }
}

impl AxObserver {
    fn open(pid: i32, app: &AxElement, sender: mpsc::SyncSender<()>) -> Result<Self, MacFfiError> {
        let mut raw = core::ptr::null_mut();
        let result = unsafe { AXObserverCreate(pid, ax_observer_callback, &raw mut raw) };
        if result != kAXErrorSuccess || raw.is_null() {
            return Err(MacFfiError::Ffi(format!(
                "AXObserverCreate failed with code {result}"
            )));
        }
        let owner = unsafe { CFType::wrap_under_create_rule(raw.cast()) };
        let source_ref = unsafe { AXObserverGetRunLoopSource(raw) };
        if source_ref.is_null() {
            return Err(MacFfiError::Ffi(
                "AXObserver returned no run-loop source".to_string(),
            ));
        }
        let source = unsafe { CFRunLoopSource::wrap_under_get_rule(source_ref) };
        let run_loop = CFRunLoop::get_current();
        unsafe {
            run_loop.add_source(&source, kCFRunLoopDefaultMode);
        }
        let mut observer = Self {
            raw,
            _owner: owner,
            source,
            run_loop,
            context: Box::new(AxObserverContext { sender }),
            registrations: HashMap::new(),
            base_keys: HashSet::new(),
        };
        for notification in [
            kAXMainWindowChangedNotification,
            kAXFocusedWindowChangedNotification,
            kAXFocusedUIElementChangedNotification,
            kAXApplicationActivatedNotification,
            kAXApplicationDeactivatedNotification,
            kAXWindowCreatedNotification,
            kAXLayoutChangedNotification,
        ] {
            if let Some(key) = observer.register(app, notification) {
                observer.base_keys.insert(key);
            }
        }
        Ok(observer)
    }

    fn register_snapshot(
        &mut self,
        elements: &HashMap<String, AxElement>,
        snapshot: &MacAxSnapshot,
    ) -> Vec<(usize, String)> {
        let mut keys = Vec::new();
        for (index, node) in snapshot.nodes.iter().enumerate() {
            let Some(element) = elements.get(&node.key) else {
                continue;
            };
            let notifications: &[&str] = if index == 0 {
                &[
                    kAXUIElementDestroyedNotification,
                    kAXValueChangedNotification,
                    kAXTitleChangedNotification,
                    kAXLayoutChangedNotification,
                    kAXSelectedChildrenChangedNotification,
                ]
            } else if index <= MAX_AX_OBSERVED_ELEMENTS
                && (!node.actions.is_empty() || node.value.is_some())
            {
                &[
                    kAXUIElementDestroyedNotification,
                    kAXValueChangedNotification,
                ]
            } else {
                &[]
            };
            for notification in notifications {
                if let Some(key) = self.register(element, notification) {
                    keys.push(key);
                }
            }
        }
        keys
    }

    fn register(&mut self, element: &AxElement, notification: &str) -> Option<(usize, String)> {
        let identity = element.as_concrete_TypeRef() as usize;
        let key = (identity, notification.to_string());
        if let Some(registration) = self.registrations.get_mut(&key) {
            registration.references = registration.references.saturating_add(1);
            return Some(key);
        }
        let notification_string = CFString::new(notification);
        let context = core::ptr::from_ref(&*self.context)
            .cast_mut()
            .cast::<core::ffi::c_void>();
        let result = unsafe {
            AXObserverAddNotification(
                self.raw,
                element.as_concrete_TypeRef(),
                notification_string.as_concrete_TypeRef(),
                context,
            )
        };
        if result != kAXErrorSuccess && result != kAXErrorNotificationAlreadyRegistered {
            return None;
        }
        self.registrations.insert(
            key.clone(),
            ObserverRegistration {
                element: element.clone(),
                references: 1,
            },
        );
        Some(key)
    }

    fn unregister_keys(&mut self, keys: &[(usize, String)]) {
        for key in keys {
            if self.base_keys.contains(key) {
                if let Some(registration) = self.registrations.get_mut(key) {
                    registration.references = registration.references.saturating_sub(1).max(1);
                }
                continue;
            }
            let remove = self.registrations.get_mut(key).is_some_and(|registration| {
                registration.references = registration.references.saturating_sub(1);
                registration.references == 0
            });
            if !remove {
                continue;
            }
            if let Some(registration) = self.registrations.remove(key) {
                let notification = CFString::new(&key.1);
                unsafe {
                    let _ = AXObserverRemoveNotification(
                        self.raw,
                        registration.element.as_concrete_TypeRef(),
                        notification.as_concrete_TypeRef(),
                    );
                }
            }
        }
    }
}

impl Drop for AxObserver {
    fn drop(&mut self) {
        unsafe {
            self.run_loop
                .remove_source(&self.source, kCFRunLoopDefaultMode);
        }
    }
}

unsafe extern "C" fn ax_observer_callback(
    _observer: AXObserverRef,
    _element: AXUIElementRef,
    _notification: core_foundation::string::CFStringRef,
    refcon: *mut core::ffi::c_void,
) {
    if refcon.is_null() {
        return;
    }
    let context: &AxObserverContext = unsafe { &*refcon.cast::<AxObserverContext>() };
    let _ = context.sender.try_send(());
}

pub(super) fn list_targets(shareable_windows: &[ShareableWindow]) -> Vec<MacTargetInfo> {
    let workspace = NSWorkspace::sharedWorkspace();
    let workspace_applications = workspace.runningApplications();
    let mut applications = Vec::new();
    let mut application_processes = HashSet::new();
    // ScreenCaptureKit reflects new GUI processes immediately, while
    // NSWorkspace's collection can lag when this controller has no AppKit run
    // loop. Resolve those exact PIDs first so a long-lived agent never loses
    // semantic control of newly launched apps.
    for window in shareable_windows {
        let Ok(process_id) = i32::try_from(window.process_id) else {
            continue;
        };
        if application_processes.insert(process_id) {
            if let Some(application) =
                NSRunningApplication::runningApplicationWithProcessIdentifier(process_id)
            {
                applications.push(application);
            }
        }
    }
    for application in &workspace_applications {
        if application_processes.insert(application.processIdentifier()) {
            applications.push(application);
        }
    }
    let mut targets = Vec::new();
    let mut correlated_window_ids = HashSet::new();

    for application in applications
        .iter()
        .filter(|application| {
            !application.isTerminated()
                && application.activationPolicy() != NSApplicationActivationPolicy::Prohibited
        })
        .take(MAX_AX_APPS)
    {
        let activation_policy = application.activationPolicy();
        let pid = application.processIdentifier();
        let Ok(process_id) = u32::try_from(pid) else {
            continue;
        };
        let application_id = application
            .bundleIdentifier()
            .map(|value| value.to_string());
        let application_name = application.localizedName().map_or_else(
            || format!("Process {process_id}"),
            |value| value.to_string(),
        );
        let Some(process_generation) = application_generation(application) else {
            continue;
        };
        let focused = application.isActive();
        let app_shareable: Vec<&ShareableWindow> = shareable_windows
            .iter()
            .filter(|window| window.process_id == process_id)
            .collect();
        let meaningful_shareable: Vec<&ShareableWindow> = app_shareable
            .iter()
            .copied()
            .filter(|window| meaningful_shareable_window(window))
            .collect();

        let mut ax_windows = Vec::new();
        if super::accessibility_trusted() {
            let app = AxElement::application(pid);
            let _ = app.set_messaging_timeout(AX_MESSAGE_TIMEOUT_SECONDS);
            if let Ok((windows, _truncated)) = app.windows_bounded(MAX_AX_WINDOWS_PER_APP) {
                for (index, window) in windows.into_iter().enumerate() {
                    let Ok(window_index) = u32::try_from(index) else {
                        break;
                    };
                    if let Some(fingerprint) = fingerprint(&window) {
                        ax_windows.push((window_index, window, fingerprint));
                    }
                }
            }
        }

        let mut resolved_ax_windows = Vec::new();
        for (window_index, window, fingerprint) in ax_windows {
            let matched = correlate_shareable_window(
                process_id,
                &fingerprint,
                &meaningful_shareable,
                &correlated_window_ids,
            );
            let is_main = focused
                && window
                    .bool_attribute(kAXMainAttribute)
                    .ok()
                    .is_some_and(bool::from);
            let minimized = window
                .bool_attribute(kAXMinimizedAttribute)
                .ok()
                .is_some_and(bool::from);
            if fingerprint.title.as_deref().is_none_or(str::is_empty)
                && matched.is_none()
                && !is_main
                && !minimized
            {
                continue;
            }
            if let Some(matched) = matched {
                correlated_window_ids.insert(matched.window_id);
            }
            resolved_ax_windows.push((window_index, window, fingerprint, matched, is_main));
        }

        if activation_policy != NSApplicationActivationPolicy::Regular
            && resolved_ax_windows.is_empty()
            && meaningful_shareable.is_empty()
        {
            continue;
        }
        let ax_bounds = union_bounds(
            resolved_ax_windows
                .iter()
                .filter_map(|(_, _, fingerprint, _, _)| fingerprint.bounds),
        );
        let app_bounds = ax_bounds
            .or_else(|| union_bounds(meaningful_shareable.iter().map(|window| window.bounds)));
        targets.push(MacTargetInfo {
            kind: MacTargetKind::Application,
            process_id,
            process_generation: process_generation.clone(),
            application_id: application_id.clone(),
            application_name: application_name.clone(),
            title: application_name.clone(),
            bounds: app_bounds,
            focused,
            window_id: None,
            ax_window: None,
        });

        for (window_index, _window, fingerprint, matched, is_focused) in resolved_ax_windows {
            let title = fingerprint
                .title
                .clone()
                .filter(|title| !title.is_empty())
                .or_else(|| {
                    matched
                        .map(|candidate| candidate.title.clone())
                        .filter(|title| !title.is_empty())
                })
                .unwrap_or_else(|| application_name.clone());
            targets.push(MacTargetInfo {
                kind: MacTargetKind::Window,
                process_id,
                process_generation: process_generation.clone(),
                application_id: application_id.clone(),
                application_name: application_name.clone(),
                title,
                bounds: fingerprint
                    .bounds
                    .or_else(|| matched.map(|window| window.bounds)),
                focused: is_focused,
                window_id: matched.map(|window| window.window_id),
                ax_window: Some(MacAxWindowSelector {
                    window_index,
                    fingerprint,
                }),
            });
        }
    }

    // ScreenCaptureKit remains useful without Accessibility and for apps whose
    // AX window list is incomplete. Such targets retain exact capture/pixel
    // capability while honestly exposing no semantic selector.
    for window in shareable_windows {
        if correlated_window_ids.contains(&window.window_id) || !meaningful_shareable_window(window)
        {
            continue;
        }
        let Ok(process_generation) = application_generation_for_pid(window.process_id) else {
            continue;
        };
        targets.push(MacTargetInfo {
            kind: MacTargetKind::Window,
            process_id: window.process_id,
            process_generation,
            application_id: window.application_id.clone(),
            application_name: window.application_name.clone(),
            title: window.title.clone(),
            bounds: Some(window.bounds),
            focused: window.focused,
            window_id: Some(window.window_id),
            ax_window: None,
        });
    }

    targets.sort_by(|left, right| {
        target_rank(left.kind)
            .cmp(&target_rank(right.kind))
            .then_with(|| left.application_name.cmp(&right.application_name))
            .then_with(|| left.title.cmp(&right.title))
            .then_with(|| left.process_id.cmp(&right.process_id))
            .then_with(|| left.window_id.cmp(&right.window_id))
    });
    targets.dedup_by(|left, right| same_target(left, right));
    targets
}

fn meaningful_shareable_window(window: &ShareableWindow) -> bool {
    !window.title.trim().is_empty()
        || (window.on_screen && window.bounds.width >= 64.0 && window.bounds.height >= 64.0)
}

fn build_snapshot(
    app: &AxElement,
    target: &MacTargetInfo,
    snapshot_id: String,
) -> Result<(MacAxSnapshot, HashMap<String, AxElement>), MacFfiError> {
    let (root, root_window) = target_root_from_app(app, target)?;
    let root_core = read_node_core(&root, true).ok_or_else(|| {
        MacFfiError::TargetStale("target Accessibility root no longer exists".to_string())
    })?;
    let root_fingerprint = root_core.fingerprint.clone();
    let deadline = Instant::now() + AX_SNAPSHOT_DEADLINE;
    let mut pending = VecDeque::from([PendingNode {
        element: root,
        key: "root".to_string(),
        parent_key: None,
        index_in_parent: 0,
        depth: 0,
        core: root_core,
        path: Vec::new(),
    }]);
    let mut visited = HashSet::new();
    let mut nodes = Vec::new();
    let mut elements = HashMap::new();
    let mut focused_key = None;

    while let Some(current) = pending.pop_front() {
        if nodes.len() >= MAX_AX_NODES || Instant::now() >= deadline {
            if let Some(parent) = current.parent_key.as_deref() {
                mark_truncated(&mut nodes, parent);
            }
            for remaining in pending {
                if let Some(parent) = remaining.parent_key.as_deref() {
                    mark_truncated(&mut nodes, parent);
                }
            }
            break;
        }
        let identity = current.element.as_concrete_TypeRef() as usize;
        if !visited.insert(identity) {
            continue;
        }
        elements.insert(current.key.clone(), current.element.clone());
        let mut node = inspect_node(
            &current.element,
            current.key.clone(),
            current.parent_key.clone(),
            current.index_in_parent,
            MacAxElementSelector {
                snapshot_id: snapshot_id.clone(),
                element_key: current.key.clone(),
                window: root_window.clone(),
                root: root_fingerprint.clone(),
                observed_state: observed_state(&current.core),
                path: current.path.clone(),
            },
            current.core,
        );
        if node.states.iter().any(|state| state == "focused") && focused_key.is_none() {
            focused_key = Some(node.key.clone());
        }

        if current.depth >= MAX_AX_DEPTH || Instant::now() >= deadline {
            node.children_truncated = true;
        } else if let Ok((children, children_truncated)) = current
            .element
            .children_bounded(MAX_AX_NODES.saturating_sub(nodes.len() + pending.len()))
        {
            node.children_truncated |= children_truncated;
            for (index, child) in children.into_iter().enumerate() {
                if nodes.len() + pending.len() >= MAX_AX_NODES {
                    node.children_truncated = true;
                    break;
                }
                let Ok(child_index) = u32::try_from(index) else {
                    node.children_truncated = true;
                    break;
                };
                let Some(child_core) = read_node_core(&child, true) else {
                    continue;
                };
                let child_fingerprint = child_core.fingerprint.clone();
                let mut path = current.path.clone();
                path.push(MacAxPathStep {
                    child_index,
                    fingerprint: child_fingerprint.clone(),
                });
                pending.push_back(PendingNode {
                    element: child,
                    key: format!("{}/{}", current.key, child_index),
                    parent_key: Some(current.key.clone()),
                    index_in_parent: i32::try_from(index).unwrap_or(i32::MAX),
                    depth: current.depth + 1,
                    core: child_core,
                    path,
                });
            }
        }
        nodes.push(node);
    }

    Ok((
        MacAxSnapshot {
            snapshot_id,
            target: target.clone(),
            root_keys: vec!["root".to_string()],
            nodes,
            focused_key,
        },
        elements,
    ))
}

fn perform_element_action(element: &AxElement, action: &MacAxAction) -> Result<(), MacFfiError> {
    match action {
        MacAxAction::Invoke => perform_first_action(element, &["AXPress", "AXConfirm", "AXPick"]),
        MacAxAction::Focus => {
            if element.is_settable(kAXFocusedAttribute).unwrap_or(false) {
                let value = CFBoolean::true_value().into_CFType();
                set_cf_attribute(element, kAXFocusedAttribute, &value)
            } else {
                Err(MacFfiError::ActionUnsupported(
                    "element focus is not settable; use target focus for its app/window"
                        .to_string(),
                ))
            }
        }
        MacAxAction::SetValue(value) => {
            if !element.is_settable(kAXValueAttribute).unwrap_or(false) {
                return Err(MacFfiError::ActionUnsupported(
                    "element value is not settable".to_string(),
                ));
            }
            let value = match value {
                MacAxActionValue::String(value) => CFString::new(value).into_CFType(),
                MacAxActionValue::Number(value) => {
                    if !value.is_finite() {
                        return Err(MacFfiError::Invalid(
                            "AX numeric value must be finite".to_string(),
                        ));
                    }
                    CFNumber::from(*value).into_CFType()
                }
                MacAxActionValue::Boolean(value) => CFBoolean::from(*value).into_CFType(),
            };
            set_cf_attribute(element, kAXValueAttribute, &value)
        }
        MacAxAction::Increment => perform_exact_action(element, "AXIncrement"),
        MacAxAction::Decrement => perform_exact_action(element, "AXDecrement"),
        MacAxAction::Select => set_bool_attribute(element, kAXSelectedAttribute, true),
        MacAxAction::Deselect => set_bool_attribute(element, kAXSelectedAttribute, false),
        MacAxAction::Expand => set_bool_attribute(element, kAXExpandedAttribute, true),
        MacAxAction::Collapse => set_bool_attribute(element, kAXExpandedAttribute, false),
        MacAxAction::ShowMenu => perform_exact_action(element, "AXShowMenu"),
        MacAxAction::ScrollIntoView => perform_exact_action(element, AX_SCROLL_TO_VISIBLE_ACTION),
    }
}

pub(super) fn focus_target(target: &MacTargetInfo) -> Result<(), MacFfiError> {
    validate_running_application(target)?;
    let pid = i32::try_from(target.process_id).map_err(|_| {
        MacFfiError::Invalid("target process id exceeds the macOS pid range".to_string())
    })?;
    let application = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
        .ok_or_else(|| MacFfiError::TargetStale("application is no longer running".to_string()))?;
    // Resolve and verify the exact window before the first foreground side
    // effect. A stale selector therefore remains a definite safe rejection.
    let window = if target.kind == MacTargetKind::Window {
        require_accessibility()?;
        Some(target_root(target)?.0)
    } else {
        None
    };
    #[allow(deprecated)]
    let options = NSApplicationActivationOptions::ActivateAllWindows
        | NSApplicationActivationOptions::ActivateIgnoringOtherApps;
    if !application.activateWithOptions(options) {
        return Err(MacFfiError::OutcomeUnknown(
            "AppKit did not confirm application activation".to_string(),
        ));
    }
    if let Some(window) = window {
        window.perform_action("AXRaise").map_err(|error| {
            MacFfiError::OutcomeUnknown(format!("AXRaise could not be confirmed: {error}"))
        })?;
    }
    Ok(())
}

pub(super) fn current_target_bounds(target: &MacTargetInfo) -> Result<MacRect, MacFfiError> {
    require_accessibility()?;
    validate_running_application(target)?;
    let (element, _) = target_root(target)?;
    fingerprint(&element)
        .and_then(|fingerprint| fingerprint.bounds)
        .ok_or_else(|| {
            MacFfiError::TargetStale(
                "AX target no longer exposes finite logical bounds".to_string(),
            )
        })
}

pub(super) fn launch_application(application_id: &str) -> Result<(), MacFfiError> {
    if application_id.trim().is_empty() {
        return Err(MacFfiError::Invalid(
            "application bundle identifier is empty".to_string(),
        ));
    }
    let workspace = NSWorkspace::sharedWorkspace();
    let identifier = objc2_foundation::NSString::from_str(application_id);
    let url = workspace
        .URLForApplicationWithBundleIdentifier(&identifier)
        .ok_or_else(|| {
            MacFfiError::TargetStale(format!(
                "no installed application has bundle id {application_id}"
            ))
        })?;
    let configuration = NSWorkspaceOpenConfiguration::configuration();
    configuration.setActivates(true);
    configuration.setAddsToRecentItems(false);
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let completion = RcBlock::new(
        move |application: *mut NSRunningApplication, error: *mut NSError| {
            if !application.is_null() {
                let _ = tx.send(Ok(()));
            } else if error.is_null() {
                let _ = tx.send(Err("LaunchServices returned no application".to_string()));
            } else {
                let error: &NSError = unsafe { &*error };
                let _ = tx.send(Err(format!("{error}")));
            }
        },
    );
    workspace.openApplicationAtURL_configuration_completionHandler(
        &url,
        &configuration,
        Some(&*completion),
    );
    match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(message)) => Err(MacFfiError::OutcomeUnknown(format!(
            "LaunchServices rejected application launch: {message}"
        ))),
        Err(_) => Err(MacFfiError::OutcomeUnknown(
            "LaunchServices did not settle within 15 seconds after accepting the request"
                .to_string(),
        )),
    }
}

fn target_root(
    target: &MacTargetInfo,
) -> Result<(AxElement, Option<MacAxWindowSelector>), MacFfiError> {
    let pid = i32::try_from(target.process_id).map_err(|_| {
        MacFfiError::Invalid("target process id exceeds the macOS pid range".to_string())
    })?;
    let app = AxElement::application(pid);
    app.set_messaging_timeout(AX_MESSAGE_TIMEOUT_SECONDS)
        .map_err(|error| MacFfiError::Ffi(format!("set AX timeout: {error}")))?;
    target_root_from_app(&app, target)
}

fn target_root_from_app(
    app: &AxElement,
    target: &MacTargetInfo,
) -> Result<(AxElement, Option<MacAxWindowSelector>), MacFfiError> {
    match target.kind {
        MacTargetKind::Application => Ok((app.clone(), None)),
        MacTargetKind::Window => {
            let selector = target.ax_window.as_ref().ok_or_else(|| {
                MacFfiError::PermissionDenied(
                    "window was discovered through capture but has no AX selector".to_string(),
                )
            })?;
            let window = resolve_window(app, selector)?;
            Ok((window, Some(selector.clone())))
        }
    }
}

fn resolve_selector_from_app(
    app: &AxElement,
    target: &MacTargetInfo,
    selector: &MacAxElementSelector,
) -> Result<AxElement, MacFfiError> {
    let (mut element, current_window) = target_root_from_app(app, target)?;
    if current_window != selector.window {
        return Err(MacFfiError::SelectorStale(
            "selector belongs to a different AX window target".to_string(),
        ));
    }
    verify_fingerprint(&element, &selector.root)?;
    for step in &selector.path {
        let child = element.child_at(step.child_index as usize).map_err(|_| {
            MacFfiError::SelectorStale("AX child path is no longer available".to_string())
        })?;
        verify_fingerprint(&child, &step.fingerprint)?;
        element = child;
    }
    Ok(element)
}

fn resolve_window(
    app: &AxElement,
    selector: &MacAxWindowSelector,
) -> Result<AxElement, MacFfiError> {
    let (windows, windows_truncated) =
        app.windows_bounded(MAX_AX_WINDOWS_PER_APP)
            .map_err(|error| {
                MacFfiError::TargetStale(format!(
                    "application no longer exposes AX windows: {error}"
                ))
            })?;
    if let Some(candidate) = windows.get(selector.window_index as usize) {
        if fingerprint(candidate)
            .as_ref()
            .is_some_and(|value| fingerprint_matches(value, &selector.fingerprint))
        {
            return Ok(candidate.clone());
        }
    }
    let matches: Vec<AxElement> = windows
        .into_iter()
        .filter(|window| {
            fingerprint(window)
                .as_ref()
                .is_some_and(|value| fingerprint_matches(value, &selector.fingerprint))
        })
        .collect();
    match matches.as_slice() {
        [window] => Ok(window.clone()),
        [] if windows_truncated => Err(MacFfiError::TargetStale(
            "AX window is outside the bounded application window envelope".to_string(),
        )),
        [] => Err(MacFfiError::TargetStale(
            "AX window fingerprint no longer matches".to_string(),
        )),
        _ => Err(MacFfiError::TargetStale(
            "AX window fingerprint became ambiguous".to_string(),
        )),
    }
}

fn inspect_node(
    element: &AxElement,
    key: String,
    parent_key: Option<String>,
    index_in_parent: i32,
    selector: MacAxElementSelector,
    core: AxNodeCore,
) -> MacAxNode {
    let mut states = Vec::new();
    push_bool_state(&mut states, "enabled", "disabled", core.enabled);
    push_true_state(&mut states, "focused", core.focused);
    push_true_state(&mut states, "busy", core.busy);
    push_true_state(&mut states, "minimized", core.minimized);
    push_bool_state(&mut states, "selected", "not_selected", core.selected);
    push_bool_state(&mut states, "expanded", "collapsed", core.expanded);

    let mut raw_actions = element.action_names().map_or_else(
        |_| Vec::new(),
        |names| {
            names
                .into_iter()
                .take(MAX_AX_ACTIONS_PER_NODE)
                .map(|name| bounded(&name.to_string(), 256))
                .collect()
        },
    );
    raw_actions.sort();
    raw_actions.dedup();
    let actions = normalized_actions(element, &raw_actions);
    let fingerprint = core.fingerprint;
    MacAxNode {
        key,
        parent_key,
        index_in_parent,
        role: normalize_ax_name(&fingerprint.role),
        subrole: fingerprint.subrole.clone(),
        identifier: fingerprint.identifier.clone(),
        name: fingerprint.title.clone(),
        description: core.description,
        value: core.value,
        states,
        bounds: fingerprint.bounds,
        actions,
        raw_actions,
        selector,
        children_truncated: false,
    }
}

fn read_node_core(element: &AxElement, include_value: bool) -> Option<AxNodeCore> {
    let values = copy_core_attributes(element);
    let (
        role,
        subrole,
        identifier,
        title,
        description,
        enabled,
        focused,
        busy,
        minimized,
        selected,
        expanded,
        protected,
        bounds,
    ) = if let Some(values) = values {
        let role = string_value(values.first()?)?;
        let subrole = values.get(1).and_then(string_value);
        let identifier = values.get(2).and_then(string_value);
        let title = values
            .get(3)
            .and_then(string_value)
            .or_else(|| values.get(4).and_then(string_value));
        let description = values
            .get(5)
            .and_then(string_value)
            .or_else(|| values.get(6).and_then(string_value));
        let enabled = values.get(7).and_then(bool_value);
        let focused = values.get(8).and_then(bool_value);
        let busy = values.get(9).and_then(bool_value);
        let minimized = values.get(10).and_then(bool_value);
        let selected = values.get(11).and_then(bool_value);
        let expanded = values.get(12).and_then(bool_value);
        let protected = values.get(13).and_then(bool_value).unwrap_or(false)
            || subrole.as_deref() == Some(kAXSecureTextFieldSubrole);
        let bounds = values
            .get(14)
            .and_then(ax_point_value)
            .zip(values.get(15).and_then(ax_size_value))
            .map(|(point, size)| MacRect {
                x: point.x,
                y: point.y,
                width: size.width,
                height: size.height,
            })
            .filter(|rect| valid_rect(*rect));
        (
            role,
            subrole,
            identifier,
            title,
            description,
            enabled,
            focused,
            busy,
            minimized,
            selected,
            expanded,
            protected,
            bounds,
        )
    } else {
        let role = element.string_attribute(kAXRoleAttribute).ok()?.to_string();
        let subrole = element
            .string_attribute(kAXSubroleAttribute)
            .ok()
            .map(|value| value.to_string())
            .filter(|value| !value.is_empty());
        let protected = subrole.as_deref() == Some(kAXSecureTextFieldSubrole)
            || optional_bool(element, AX_CONTAINS_PROTECTED_CONTENT).unwrap_or(false);
        (
            role,
            subrole,
            element
                .string_attribute(kAXIdentifierAttribute)
                .ok()
                .map(|value| value.to_string()),
            element
                .string_attribute(kAXTitleAttribute)
                .ok()
                .map(|value| value.to_string())
                .or_else(|| {
                    element
                        .string_attribute(kAXLabelValueAttribute)
                        .ok()
                        .map(|value| value.to_string())
                }),
            element
                .string_attribute(kAXDescriptionAttribute)
                .ok()
                .map(|value| value.to_string())
                .or_else(|| {
                    element
                        .string_attribute(kAXHelpAttribute)
                        .ok()
                        .map(|value| value.to_string())
                }),
            element
                .bool_attribute(kAXEnabledAttribute)
                .ok()
                .map(bool::from),
            element
                .bool_attribute(kAXFocusedAttribute)
                .ok()
                .map(bool::from),
            element
                .bool_attribute(kAXElementBusyAttribute)
                .ok()
                .map(bool::from),
            element
                .bool_attribute(kAXMinimizedAttribute)
                .ok()
                .map(bool::from),
            optional_bool(element, kAXSelectedAttribute),
            optional_bool(element, kAXExpandedAttribute),
            protected,
            ax_bounds(element),
        )
    };
    let value = if include_value {
        if protected {
            Some(MacAxValue::Password)
        } else {
            element
                .attribute(kAXValueAttribute)
                .ok()
                .and_then(|value| cf_value(&value))
        }
    } else {
        None
    };
    Some(AxNodeCore {
        fingerprint: MacAxFingerprint {
            role: bounded(&role, 256),
            subrole: subrole
                .map(|value| bounded(&value, 256))
                .filter(|value| !value.is_empty()),
            identifier: identifier
                .map(|value| bounded(&value, 2_048))
                .filter(|value| !value.is_empty()),
            title: title
                .map(|value| bounded(&value, 8_192))
                .filter(|value| !value.is_empty()),
            bounds,
        },
        description: description
            .map(|value| bounded(&value, 8_192))
            .filter(|value| !value.is_empty()),
        value,
        enabled,
        focused,
        busy,
        minimized,
        selected,
        expanded,
    })
}

fn copy_core_attributes(element: &AxElement) -> Option<Vec<CFType>> {
    let names: Vec<CFString> = AX_CORE_ATTRIBUTES
        .iter()
        .map(|name| CFString::new(name))
        .collect();
    let attributes = CFArray::from_CFTypes(&names);
    let mut values = core::ptr::null();
    let result = unsafe {
        AXUIElementCopyMultipleAttributeValues(
            element.as_concrete_TypeRef(),
            attributes.as_concrete_TypeRef(),
            0,
            &raw mut values,
        )
    };
    if result != kAXErrorSuccess || values.is_null() {
        return None;
    }
    let values = unsafe { CFArray::<CFType>::wrap_under_create_rule(values) };
    if values.len() != AX_CORE_ATTRIBUTES.len() as isize {
        return None;
    }
    Some(values.into_iter().map(|value| (*value).clone()).collect())
}

fn string_value(value: &CFType) -> Option<String> {
    value.downcast::<CFString>().map(|value| value.to_string())
}

fn bool_value(value: &CFType) -> Option<bool> {
    value.downcast::<CFBoolean>().map(bool::from)
}

fn ax_point_value(value: &CFType) -> Option<AxPoint> {
    let mut point = AxPoint::default();
    ax_value_into(value, kAXValueTypeCGPoint, (&raw mut point).cast()).then_some(point)
}

fn ax_size_value(value: &CFType) -> Option<AxSize> {
    let mut size = AxSize::default();
    ax_value_into(value, kAXValueTypeCGSize, (&raw mut size).cast()).then_some(size)
}

fn ax_value_into(value: &CFType, value_type: u32, output: *mut core::ffi::c_void) -> bool {
    if unsafe { CFGetTypeID(value.as_CFTypeRef()) } != unsafe { AXValueGetTypeID() } {
        return false;
    }
    let value = value
        .as_CFTypeRef()
        .cast_mut()
        .cast::<accessibility_sys::__AXValue>();
    unsafe { AXValueGetType(value) == value_type && AXValueGetValue(value, value_type, output) }
}

fn fingerprint(element: &AxElement) -> Option<MacAxFingerprint> {
    read_node_core(element, false).map(|core| core.fingerprint)
}

fn verify_fingerprint(element: &AxElement, expected: &MacAxFingerprint) -> Result<(), MacFfiError> {
    let current = fingerprint(element).ok_or_else(|| {
        MacFfiError::SelectorStale("AX element no longer exposes its identity".to_string())
    })?;
    if fingerprint_matches(&current, expected) {
        Ok(())
    } else {
        Err(MacFfiError::SelectorStale(
            "AX element fingerprint changed after observation".to_string(),
        ))
    }
}

fn fingerprint_matches(left: &MacAxFingerprint, right: &MacAxFingerprint) -> bool {
    left.role == right.role
        && left.subrole == right.subrole
        && left.identifier == right.identifier
        && left.title == right.title
        && rects_match(left.bounds, right.bounds, 0.75)
}

fn correlate_shareable_window<'a>(
    process_id: u32,
    fingerprint: &MacAxFingerprint,
    windows: &[&'a ShareableWindow],
    used: &HashSet<u32>,
) -> Option<&'a ShareableWindow> {
    let candidates: Vec<&ShareableWindow> = windows
        .iter()
        .copied()
        .filter(|window| {
            window.process_id == process_id
                && !used.contains(&window.window_id)
                && rects_match(fingerprint.bounds, Some(window.bounds), 2.0)
        })
        .collect();
    if candidates.len() == 1 {
        return Some(candidates[0]);
    }
    let title = fingerprint.title.as_deref()?.trim();
    let best_score = candidates
        .iter()
        .map(|window| window_title_match_score(title, &window.title))
        .max()?;
    if best_score == 0 {
        return None;
    }
    let mut best = candidates
        .into_iter()
        .filter(|window| window_title_match_score(title, &window.title) == best_score);
    let matched = best.next()?;
    best.next().is_none().then_some(matched)
}

/// AX and ScreenCaptureKit do not promise identical window titles. Chrome, for
/// example, exposes `Page - Google Chrome - Profile` through AX while SCK
/// commonly exposes only `Page`. Correlate that documented shape without ever
/// picking arbitrarily when PID + geometry still leave a tie.
fn window_title_match_score(ax_title: &str, capture_title: &str) -> u8 {
    let ax_title = ax_title.trim();
    let capture_title = capture_title.trim();
    if ax_title.is_empty() || capture_title.is_empty() {
        return 0;
    }
    if ax_title == capture_title {
        return 4;
    }
    if title_has_app_suffix(ax_title, capture_title)
        || title_has_app_suffix(capture_title, ax_title)
    {
        return 3;
    }
    if ax_title.eq_ignore_ascii_case(capture_title) {
        return 2;
    }
    // ScreenCaptureKit truncates some Chrome titles in the middle. A long,
    // unique leading run still safely distinguishes same-sized windows; the
    // caller rejects equal-score ties rather than guessing.
    u8::from(
        ax_title
            .chars()
            .zip(capture_title.chars())
            .take_while(|(left, right)| left == right)
            .count()
            >= 16,
    )
}

fn title_has_app_suffix(longer: &str, shorter: &str) -> bool {
    let Some(suffix) = longer.strip_prefix(shorter) else {
        return false;
    };
    [" - ", " — ", " · "]
        .iter()
        .any(|separator| suffix.starts_with(separator))
}

fn validate_running_application(target: &MacTargetInfo) -> Result<(), MacFfiError> {
    let pid = i32::try_from(target.process_id).map_err(|_| {
        MacFfiError::Invalid("target process id exceeds the macOS pid range".to_string())
    })?;
    let application = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
        .ok_or_else(|| MacFfiError::TargetStale("application is no longer running".to_string()))?;
    if application.isTerminated() {
        return Err(MacFfiError::TargetStale(
            "application terminated after discovery".to_string(),
        ));
    }
    if application_generation(&application).as_deref() != Some(&target.process_generation) {
        return Err(MacFfiError::TargetStale(
            "process id belongs to another application launch generation".to_string(),
        ));
    }
    let current_id = application
        .bundleIdentifier()
        .map(|value| value.to_string());
    if target.application_id.is_some() && target.application_id != current_id {
        return Err(MacFfiError::TargetStale(
            "process id now belongs to a different application".to_string(),
        ));
    }
    Ok(())
}

fn application_generation(application: &NSRunningApplication) -> Option<String> {
    let launched_at = application.launchDate()?.timeIntervalSinceReferenceDate();
    launched_at
        .is_finite()
        .then(|| format!("launch_{:016x}", launched_at.to_bits()))
}

fn application_generation_for_pid(process_id: u32) -> Result<String, MacFfiError> {
    let pid = i32::try_from(process_id).map_err(|_| {
        MacFfiError::Invalid("target process id exceeds the macOS pid range".to_string())
    })?;
    let application = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
        .ok_or_else(|| MacFfiError::TargetStale("application is no longer running".to_string()))?;
    application_generation(&application).ok_or_else(|| {
        MacFfiError::TargetStale(
            "application launch generation is unavailable from AppKit".to_string(),
        )
    })
}

fn observed_state(core: &AxNodeCore) -> MacAxObservedState {
    MacAxObservedState {
        description: core.description.clone(),
        value: core.value.clone(),
        enabled: core.enabled,
        focused: core.focused,
        busy: core.busy,
        minimized: core.minimized,
        selected: core.selected,
        expanded: core.expanded,
    }
}

fn verify_observed_state(
    element: &AxElement,
    expected: &MacAxObservedState,
) -> Result<(), MacFfiError> {
    let current = read_node_core(element, true).ok_or_else(|| {
        MacFfiError::SelectorStale(
            "AX element no longer exposes its observed semantic state".to_string(),
        )
    })?;
    if observed_state(&current) == *expected {
        Ok(())
    } else {
        Err(MacFfiError::SelectorStale(
            "AX element state changed after observation".to_string(),
        ))
    }
}

fn require_accessibility() -> Result<(), MacFfiError> {
    if super::accessibility_trusted() {
        Ok(())
    } else {
        Err(MacFfiError::PermissionDenied(
            "Accessibility permission is required for semantic computer control".to_string(),
        ))
    }
}

fn perform_first_action(element: &AxElement, choices: &[&str]) -> Result<(), MacFfiError> {
    let names: Vec<String> = element
        .action_names()
        .map_err(|error| {
            MacFfiError::ActionUnsupported(format!("element exposes no AX actions: {error}"))
        })?
        .into_iter()
        .map(|value| value.to_string())
        .collect();
    let choice = choices
        .iter()
        .find(|choice| names.iter().any(|name| name == **choice))
        .ok_or_else(|| {
            MacFfiError::ActionUnsupported(
                "element exposes no press, confirm, or pick action".to_string(),
            )
        })?;
    perform_exact_action(element, choice)
}

fn perform_exact_action(element: &AxElement, action: &str) -> Result<(), MacFfiError> {
    let action_name = CFString::new(action);
    let supported = element
        .action_names()
        .is_ok_and(|names| names.into_iter().any(|value| value == action_name));
    if !supported {
        return Err(MacFfiError::ActionUnsupported(format!(
            "element does not expose {action}"
        )));
    }
    element.perform_action(action).map_err(|error| {
        MacFfiError::OutcomeUnknown(format!("{action} could not be confirmed: {error}"))
    })
}

fn set_bool_attribute(element: &AxElement, name: &str, value: bool) -> Result<(), MacFfiError> {
    if !element.is_settable(name).unwrap_or(false) {
        return Err(MacFfiError::ActionUnsupported(format!(
            "element attribute {name} is not settable"
        )));
    }
    let value = CFBoolean::from(value).into_CFType();
    set_cf_attribute(element, name, &value)
}

fn set_cf_attribute(
    element: &AxElement,
    attribute: &str,
    value: &CFType,
) -> Result<(), MacFfiError> {
    element.set_attribute(attribute, value).map_err(|error| {
        MacFfiError::OutcomeUnknown(format!(
            "AX attribute mutation could not be confirmed: {error}"
        ))
    })
}

fn normalized_actions(element: &AxElement, raw: &[String]) -> Vec<String> {
    let mut actions = Vec::new();
    if raw
        .iter()
        .any(|value| matches!(value.as_str(), "AXPress" | "AXConfirm" | "AXPick"))
    {
        actions.push("invoke".to_string());
    }
    if raw.iter().any(|value| value == "AXIncrement") {
        actions.push("increment".to_string());
    }
    if raw.iter().any(|value| value == "AXDecrement") {
        actions.push("decrement".to_string());
    }
    if raw.iter().any(|value| value == "AXShowMenu") {
        actions.push("show_menu".to_string());
    }
    if raw.iter().any(|value| value == AX_SCROLL_TO_VISIBLE_ACTION) {
        actions.push("scroll_into_view".to_string());
    }
    if element.is_settable(kAXFocusedAttribute).unwrap_or(false) {
        actions.push("focus".to_string());
    }
    if element.is_settable(kAXValueAttribute).unwrap_or(false) {
        actions.push("set_value".to_string());
    }
    if element.is_settable(kAXSelectedAttribute).unwrap_or(false) {
        actions.extend(["select".to_string(), "deselect".to_string()]);
    }
    if element.is_settable(kAXExpandedAttribute).unwrap_or(false) {
        actions.extend(["expand".to_string(), "collapse".to_string()]);
    }
    actions.sort();
    actions.dedup();
    actions
}

fn cf_value(value: &CFType) -> Option<MacAxValue> {
    if let Some(value) = value.downcast::<CFString>() {
        let value = bounded(&value.to_string(), MAX_STRING_CHARS);
        return (!value.is_empty()).then_some(MacAxValue::Text(value));
    }
    if let Some(value) = value.downcast::<CFBoolean>() {
        return Some(MacAxValue::Boolean(bool::from(value)));
    }
    value
        .downcast::<CFNumber>()
        .and_then(|value| value.to_f64())
        .filter(|value| value.is_finite())
        .map(MacAxValue::Number)
}

fn optional_bool(element: &AxElement, name: &str) -> Option<bool> {
    element.bool_attribute(name).ok().map(bool::from)
}

fn ax_bounds(element: &AxElement) -> Option<MacRect> {
    let point = copy_ax_point(element)?;
    let size = copy_ax_size(element)?;
    let rect = MacRect {
        x: point.x,
        y: point.y,
        width: size.width,
        height: size.height,
    };
    valid_rect(rect).then_some(rect)
}

fn copy_ax_point(element: &AxElement) -> Option<AxPoint> {
    let mut point = AxPoint::default();
    copy_ax_value(
        element,
        kAXPositionAttribute,
        kAXValueTypeCGPoint,
        (&raw mut point).cast(),
    )
    .then_some(point)
}

fn copy_ax_size(element: &AxElement) -> Option<AxSize> {
    let mut size = AxSize::default();
    copy_ax_value(
        element,
        kAXSizeAttribute,
        kAXValueTypeCGSize,
        (&raw mut size).cast(),
    )
    .then_some(size)
}

fn copy_ax_value(
    element: &AxElement,
    attribute: &str,
    value_type: u32,
    output: *mut core::ffi::c_void,
) -> bool {
    let attribute = CFString::new(attribute);
    let mut value: CFTypeRef = core::ptr::null();
    let error = unsafe {
        AXUIElementCopyAttributeValue(
            element.as_concrete_TypeRef(),
            attribute.as_concrete_TypeRef(),
            &raw mut value,
        )
    };
    if error != kAXErrorSuccess || value.is_null() {
        return false;
    }
    let value = unsafe { CFType::wrap_under_create_rule(value) };
    if unsafe { CFGetTypeID(value.as_CFTypeRef()) } != unsafe { AXValueGetTypeID() } {
        return false;
    }
    let value = value
        .as_CFTypeRef()
        .cast_mut()
        .cast::<accessibility_sys::__AXValue>();
    unsafe { AXValueGetType(value) == value_type && AXValueGetValue(value, value_type, output) }
}

fn union_bounds(bounds: impl Iterator<Item = MacRect>) -> Option<MacRect> {
    bounds
        .filter(|rect| valid_rect(*rect))
        .reduce(|left, right| {
            let x = left.x.min(right.x);
            let y = left.y.min(right.y);
            let max_x = (left.x + left.width).max(right.x + right.width);
            let max_y = (left.y + left.height).max(right.y + right.height);
            MacRect {
                x,
                y,
                width: max_x - x,
                height: max_y - y,
            }
        })
}

fn rects_match(left: Option<MacRect>, right: Option<MacRect>, tolerance: f64) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            (left.x - right.x).abs() <= tolerance
                && (left.y - right.y).abs() <= tolerance
                && (left.width - right.width).abs() <= tolerance
                && (left.height - right.height).abs() <= tolerance
        }
        _ => false,
    }
}

fn valid_rect(rect: MacRect) -> bool {
    rect.x.is_finite()
        && rect.y.is_finite()
        && rect.width.is_finite()
        && rect.height.is_finite()
        && rect.width >= 0.0
        && rect.height >= 0.0
}

fn push_bool_state(states: &mut Vec<String>, yes: &str, no: &str, value: Option<bool>) {
    if let Some(value) = value {
        states.push(if value { yes } else { no }.to_string());
    }
}

fn push_true_state(states: &mut Vec<String>, name: &str, value: Option<bool>) {
    if value == Some(true) {
        states.push(name.to_string());
    }
}

fn mark_truncated(nodes: &mut [MacAxNode], key: &str) {
    if let Some(node) = nodes.iter_mut().find(|node| node.key == key) {
        node.children_truncated = true;
    }
}

fn normalize_ax_name(value: &str) -> String {
    let value = value.strip_prefix("AX").unwrap_or(value);
    let mut output = String::new();
    for (index, character) in value.chars().enumerate() {
        if character.is_uppercase() && index > 0 {
            output.push('_');
        }
        output.extend(character.to_lowercase());
    }
    if output.is_empty() {
        "unknown".to_string()
    } else {
        output
    }
}

fn bounded(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn target_rank(kind: MacTargetKind) -> u8 {
    match kind {
        MacTargetKind::Application => 0,
        MacTargetKind::Window => 1,
    }
}

fn target_key(target: &MacTargetInfo) -> String {
    match target.kind {
        MacTargetKind::Application => format!("app:{}", target.process_id),
        MacTargetKind::Window => target.window_id.map_or_else(
            || {
                let index = target
                    .ax_window
                    .as_ref()
                    .map_or(u32::MAX, |selector| selector.window_index);
                format!("window:{}:ax:{index}", target.process_id)
            },
            |window_id| format!("window:{}:sck:{window_id}", target.process_id),
        ),
    }
}

fn same_target(left: &MacTargetInfo, right: &MacTargetInfo) -> bool {
    left.kind == right.kind
        && left.process_id == right.process_id
        && match (left.kind, left.window_id, right.window_id) {
            (MacTargetKind::Application, _, _) => true,
            (MacTargetKind::Window, Some(left), Some(right)) => left == right,
            (MacTargetKind::Window, _, _) => left.ax_window == right.ax_window,
        }
}
