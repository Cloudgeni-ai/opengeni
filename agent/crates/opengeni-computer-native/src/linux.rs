use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use atspi::proxy::accessible::AccessibleProxy;
use atspi::proxy::action::ActionProxy;
use atspi::proxy::cache::CacheProxy;
use atspi::proxy::component::ComponentProxy;
use atspi::proxy::editable_text::EditableTextProxy;
use atspi::proxy::selection::SelectionProxy;
use atspi::proxy::text::TextProxy;
use atspi::proxy::value::ValueProxy;
use atspi::{
    events::{
        CacheEvents, DocumentEvents, FocusEvents, KeyboardEvents, MouseEvents, ObjectEvents,
        TerminalEvents, WindowEvents,
    },
    AccessibilityConnection, CacheItem, CoordType, Interface, InterfaceSet, LegacyCacheItem,
    ObjectRefOwned, Role, ScrollType, State,
};
use futures::stream::{self, StreamExt as _};
use image::{
    codecs::{jpeg::JpegEncoder, png::PngEncoder},
    imageops::FilterType,
    ExtendedColorType, ImageEncoder as _, RgbaImage,
};
use opengeni_agent_platform::{
    validate_linux_named_key_chord, DesktopBackend as _, LinuxDesktop, LinuxRgbaFrame, LinuxWindow,
    LinuxWindowRect, PlatformError,
};
use opengeni_agent_proto::v1;
use serde_json::json;
use sha2::{Digest as _, Sha256};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::clipboard::NativeClipboardController;
use crate::tree::semantic_roots_equivalent;
use crate::{
    ComputerAdapter, NativeAction, NativeActionCommand, NativeActionValue, NativeAdapterError,
    NativeAdapterErrorCode, NativeAdapterResult, NativeCapabilities, NativeCapturedFrame,
    NativeClipboard, NativeClipboardAction, NativeKeyboardAction, NativeLocator,
    NativeNodeMetadata, NativeNodeValue, NativeObservation, NativePointerAction,
    NativePointerButton, NativeRect, NativeRedactedValue, NativeRedactionReason,
    NativeSemanticAction, NativeSemanticPlatform, NativeTarget, NativeTargetKind, RawSemanticNode,
    SemanticSnapshotIndex,
};

const CACHE_TIMEOUT: Duration = Duration::from_secs(5);
const NATIVE_CALL_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_CACHE_ITEMS: usize = 50_000;
const MAX_ENRICH_CONCURRENCY: usize = 32;
const MAX_DETAILED_ENRICHMENT_NODES: usize = 64;
const MAX_APPLICATION_SNAPSHOTS: usize = 128;
const MAX_WINDOW_FRAME_FENCES: usize = 512;
const MUTATION_SETTLE_DELAYS: [Duration; 4] = [
    Duration::ZERO,
    Duration::from_millis(16),
    Duration::from_millis(32),
    Duration::from_millis(64),
];
const FOCUS_SETTLE_DELAYS: [Duration; 7] = [
    Duration::ZERO,
    Duration::from_millis(16),
    Duration::from_millis(32),
    Duration::from_millis(64),
    Duration::from_millis(128),
    Duration::from_millis(256),
    Duration::from_millis(256),
];

async fn register_semantic_events(connection: &AccessibilityConnection) -> bool {
    // A reused application snapshot is safe only while every event family that
    // can change its semantic tree, focus, text, or window topology is active.
    // Registration is all-or-nothing: a partial listener falls back to fresh
    // AT-SPI snapshots rather than risking stale controls.
    let cache = connection.register_event::<CacheEvents>().await;
    let document = connection.register_event::<DocumentEvents>().await;
    let focus = connection.register_event::<FocusEvents>().await;
    let keyboard = connection.register_event::<KeyboardEvents>().await;
    let mouse = connection.register_event::<MouseEvents>().await;
    let object = connection.register_event::<ObjectEvents>().await;
    let terminal = connection.register_event::<TerminalEvents>().await;
    let window = connection.register_event::<WindowEvents>().await;
    cache.is_ok()
        && document.is_ok()
        && focus.is_ok()
        && keyboard.is_ok()
        && mouse.is_ok()
        && object.is_ok()
        && terminal.is_ok()
        && window.is_ok()
}

#[derive(Clone)]
struct ObjectRecord {
    object: ObjectRefOwned,
    parent: ObjectRefOwned,
    index_in_parent: i32,
    interfaces: InterfaceSet,
    focused: bool,
}

struct StoredObservation {
    target_generation: String,
    snapshot: SemanticSnapshotIndex,
    objects: BTreeMap<String, ObjectRecord>,
}

#[derive(Clone)]
struct CachedApplicationSnapshot {
    generation: u64,
    items: Vec<CacheItem>,
}

#[derive(Clone)]
struct TargetRecord {
    key: String,
    target: NativeTarget,
    x11_window: Option<LinuxWindow>,
}

#[derive(Clone)]
struct TargetLocator {
    application_root: ObjectRefOwned,
    record: TargetRecord,
}

#[derive(Clone)]
struct WindowFrameFence {
    sequence: u64,
    frame_id: String,
    target_generation: String,
    window: LinuxWindow,
    width: u32,
    height: u32,
}

/// Linux semantic adapter over the modern AT-SPI cache and typed interfaces.
/// All object handles remain private; observations contain only short refs.
pub(crate) struct AtspiComputerAdapter {
    connection: AccessibilityConnection,
    incarnation: Uuid,
    sequence: AtomicU64,
    frame_sequence: AtomicU64,
    latest: RwLock<BTreeMap<String, StoredObservation>>,
    target_locators: RwLock<BTreeMap<String, TargetLocator>>,
    desktop: Option<LinuxDesktop>,
    clipboard: Option<NativeClipboardController>,
    latest_screen_frame: RwLock<Option<String>>,
    latest_window_frames: RwLock<BTreeMap<String, WindowFrameFence>>,
    semantic_generation: Arc<AtomicU64>,
    application_snapshots: RwLock<BTreeMap<String, CachedApplicationSnapshot>>,
    semantic_event_cache: Arc<AtomicBool>,
}

impl AtspiComputerAdapter {
    pub(crate) async fn open() -> NativeAdapterResult<Self> {
        let connection = tokio::time::timeout(CACHE_TIMEOUT, AccessibilityConnection::new())
            .await
            .map_err(|_| {
                NativeAdapterError::unavailable(
                    "Linux AT-SPI accessibility bus connection timed out",
                    true,
                )
            })?
            .map_err(|error| {
                NativeAdapterError::unavailable(
                    format!("Linux AT-SPI accessibility bus is unavailable: {error}"),
                    true,
                )
            })?;
        let semantic_generation = Arc::new(AtomicU64::new(0));
        let semantic_event_cache =
            Arc::new(AtomicBool::new(register_semantic_events(&connection).await));
        if semantic_event_cache.load(Ordering::Acquire) {
            let event_connection = connection.clone();
            let event_generation = Arc::clone(&semantic_generation);
            let event_cache_enabled = Arc::clone(&semantic_event_cache);
            tokio::spawn(async move {
                let events = event_connection.event_stream();
                futures::pin_mut!(events);
                while events.next().await.is_some() {
                    event_generation.fetch_add(1, Ordering::AcqRel);
                }
                event_cache_enabled.store(false, Ordering::Release);
                event_generation.fetch_add(1, Ordering::AcqRel);
            });
        }
        Ok(Self {
            connection,
            incarnation: Uuid::new_v4(),
            sequence: AtomicU64::new(0),
            frame_sequence: AtomicU64::new(0),
            latest: RwLock::new(BTreeMap::new()),
            target_locators: RwLock::new(BTreeMap::new()),
            desktop: LinuxDesktop::open_default().ok(),
            clipboard: NativeClipboardController::open().ok(),
            latest_screen_frame: RwLock::new(None),
            latest_window_frames: RwLock::new(BTreeMap::new()),
            semantic_generation,
            application_snapshots: RwLock::new(BTreeMap::new()),
            semantic_event_cache,
        })
    }

    fn screen_target(&self) -> Option<NativeTarget> {
        let display = self.desktop.as_ref()?.probe()?;
        let key = format!("{}\0{}\0{}", display.id, display.width, display.height);
        Some(NativeTarget {
            id: format!("screen:{}", stable_digest(&display.id)),
            target_generation: format!("g_{}", stable_digest(&key)),
            kind: NativeTargetKind::Screen,
            application_id: None,
            process_id: None,
            title: format!("Linux desktop {}", display.id),
            bounds: Some(NativeRect {
                x: 0.0,
                y: 0.0,
                width: f64::from(display.width),
                height: f64::from(display.height),
            }),
            focused: true,
        })
    }

    async fn screen_observation(&self, target: NativeTarget) -> NativeObservation {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        NativeObservation {
            observation_id: format!("o_{}_{}", self.incarnation.simple(), sequence),
            target,
            frame_id: self.latest_screen_frame.read().await.clone(),
            roots: Vec::new(),
            node_count: 0,
            focused_ref: None,
            changed_regions: Vec::new(),
        }
    }

    async fn cache_items(&self) -> NativeAdapterResult<Vec<CacheItem>> {
        let registry_root = self
            .connection
            .root_accessible_on_registry()
            .await
            .map_err(|error| driver_error("construct AT-SPI registry root", error))?;
        let application_roots = cache_call(registry_root.get_children())
            .await
            .map_err(|error| driver_error("enumerate AT-SPI applications", error))?;
        let snapshots = stream::iter(
            application_roots
                .into_iter()
                .map(|root| async move { self.application_cache(&root).await }),
        )
        .buffer_unordered(MAX_ENRICH_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
        let mut items = Vec::new();
        for snapshot in snapshots {
            // Application accessibility roots are independently ephemeral.
            // Chromium renderers and short-lived dialogs routinely disappear
            // between registry enumeration and cache traversal. One stale app
            // must not make the desktop screen or every other app unavailable.
            let Ok(snapshot) = snapshot else {
                continue;
            };
            items.extend(snapshot);
            if items.len() > MAX_CACHE_ITEMS {
                return Err(NativeAdapterError::definite(
                    NativeAdapterErrorCode::DriverFailed,
                    "AT-SPI cache exceeds the native snapshot envelope",
                    true,
                ));
            }
        }
        Ok(items)
    }

    async fn application_cache(
        &self,
        root: &ObjectRefOwned,
    ) -> NativeAdapterResult<Vec<CacheItem>> {
        let cache_key = object_key(root)?;
        let start_generation = self.semantic_generation.load(Ordering::Acquire);
        if self.semantic_event_cache.load(Ordering::Acquire) {
            let snapshots = self.application_snapshots.read().await;
            if let Some(snapshot) = snapshots
                .get(&cache_key)
                .filter(|snapshot| snapshot.generation == start_generation)
            {
                return Ok(snapshot.items.clone());
            }
        }
        let proxy = CacheProxy::builder(self.connection.connection())
            .destination(root.name().ok_or_else(null_object)?.clone())
            .map_err(|error| driver_error("construct application cache destination", error))?
            .build()
            .await
            .map_err(|error| driver_error("construct application cache proxy", error));
        let cached = match proxy {
            Ok(proxy) => match cache_call(proxy.get_items()).await {
                Ok(items) => Ok(items),
                Err(error) if is_signature_mismatch(&error) => cache_call(proxy.get_legacy_items())
                    .await
                    .map_err(|error| driver_error("read legacy application AT-SPI cache", error))
                    .and_then(convert_legacy_cache),
                Err(error) => Err(driver_error("read application AT-SPI cache", error)),
            },
            Err(error) => Err(error),
        };
        let items = match cached {
            Ok(items) if !items.is_empty() && cache_snapshot_complete(&items) => Ok(items),
            Ok(_) | Err(_) => self.crawl_application(root).await,
        }?;
        if self.semantic_event_cache.load(Ordering::Acquire)
            && self.semantic_generation.load(Ordering::Acquire) == start_generation
        {
            let mut snapshots = self.application_snapshots.write().await;
            snapshots.retain(|_, snapshot| snapshot.generation == start_generation);
            if snapshots.len() >= MAX_APPLICATION_SNAPSHOTS && !snapshots.contains_key(&cache_key) {
                snapshots.clear();
            }
            snapshots.insert(
                cache_key,
                CachedApplicationSnapshot {
                    generation: start_generation,
                    items: items.clone(),
                },
            );
        }
        Ok(items)
    }

    fn invalidate_semantic_cache(&self) {
        self.semantic_generation.fetch_add(1, Ordering::AcqRel);
    }

    async fn crawl_application(
        &self,
        root: &ObjectRefOwned,
    ) -> NativeAdapterResult<Vec<CacheItem>> {
        let mut pending = VecDeque::from([root.clone()]);
        let mut visited = BTreeSet::new();
        let mut items = Vec::new();
        while !pending.is_empty() {
            let mut batch = Vec::with_capacity(MAX_ENRICH_CONCURRENCY);
            while batch.len() < MAX_ENRICH_CONCURRENCY {
                let Some(object) = pending.pop_front() else {
                    break;
                };
                let key = object_key(&object)?;
                if visited.insert(key) {
                    batch.push(object);
                }
            }
            let crawled = stream::iter(
                batch
                    .into_iter()
                    .map(|object| async move { self.crawl_accessible(root, &object).await }),
            )
            .buffer_unordered(MAX_ENRICH_CONCURRENCY)
            .collect::<Vec<_>>()
            .await;
            for result in crawled {
                let (item, children) = result?;
                items.push(item);
                pending.extend(children);
                if items.len() + pending.len() > 10_000 {
                    return Err(NativeAdapterError::definite(
                        NativeAdapterErrorCode::DriverFailed,
                        "AT-SPI application traversal exceeds the semantic node envelope",
                        true,
                    ));
                }
            }
        }
        Ok(items)
    }

    async fn crawl_accessible(
        &self,
        app: &ObjectRefOwned,
        object: &ObjectRefOwned,
    ) -> NativeAdapterResult<(CacheItem, Vec<ObjectRefOwned>)> {
        let proxy = self.accessible_proxy(object).await?;
        let (parent, index, children, ifaces, role, name, states) = futures::join!(
            timed(proxy.parent()),
            timed(proxy.get_index_in_parent()),
            timed(proxy.get_children()),
            timed(proxy.get_interfaces()),
            timed(proxy.get_role()),
            timed(proxy.name()),
            timed(proxy.get_state()),
        );
        let parent = parent.map_err(|error| driver_error("read AT-SPI parent", error))?;
        let index = index.map_err(|error| driver_error("read AT-SPI child index", error))?;
        let children = children.map_err(|error| driver_error("read AT-SPI children", error))?;
        let ifaces = ifaces.map_err(|error| driver_error("read AT-SPI interfaces", error))?;
        let role = role.map_err(|error| driver_error("read AT-SPI role", error))?;
        let name = name.map_err(|error| driver_error("read AT-SPI name", error))?;
        let states = states.map_err(|error| driver_error("read AT-SPI states", error))?;
        let child_count = i32::try_from(children.len()).map_err(|_| {
            NativeAdapterError::definite(
                NativeAdapterErrorCode::DriverFailed,
                "AT-SPI child count exceeds its native range",
                true,
            )
        })?;
        Ok((
            CacheItem {
                object: object.clone(),
                app: app.clone(),
                parent,
                index,
                children: child_count,
                ifaces,
                short_name: role.to_string(),
                role,
                name,
                states,
            },
            children,
        ))
    }

    async fn target_records(&self, items: &[CacheItem]) -> NativeAdapterResult<Vec<TargetRecord>> {
        let candidates: Vec<CacheItem> = items
            .iter()
            .filter(|item| is_target_role(item.role))
            .cloned()
            .collect();
        let enriched = stream::iter(candidates.into_iter().map(|item| async move {
            let key = object_key(&item.object)?;
            let identifier = self.accessible_identifier(&item.object).await;
            let bounds = self.component_bounds(&item.object, item.ifaces).await;
            let process_id = self.process_id(&item.object).await;
            let kind = if item.role == Role::Application {
                NativeTargetKind::App
            } else {
                NativeTargetKind::Window
            };
            let title = first_nonempty(&[&item.name, &item.short_name])
                .unwrap_or_else(|| item.role.to_string());
            let target_id = format!("{}:{}", target_kind_prefix(kind), stable_digest(&key));
            let generation_source = format!(
                "{}\0{}\0{}",
                key,
                process_id.map_or_else(String::new, |pid| pid.to_string()),
                identifier.as_deref().unwrap_or("")
            );
            Ok::<_, NativeAdapterError>(TargetRecord {
                key,
                x11_window: None,
                target: NativeTarget {
                    id: target_id,
                    target_generation: format!("g_{}", stable_digest(&generation_source)),
                    kind,
                    application_id: identifier,
                    process_id,
                    title,
                    bounds,
                    focused: item.states.contains(State::Focused)
                        || item.states.contains(State::Active),
                },
            })
        }))
        .buffer_unordered(MAX_ENRICH_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
        // A single malformed/stale AT-SPI object is not authority to hide the
        // rest of the desktop. A direct observation of that target will still
        // return its precise stale/not-found error.
        let mut records: Vec<TargetRecord> = enriched.into_iter().filter_map(Result::ok).collect();
        let windows = if let Some(desktop) = &self.desktop {
            desktop.windows().await.unwrap_or_default()
        } else {
            Vec::new()
        };
        for record in &mut records {
            record.x11_window = correlate_x11_window(&record.target, &windows);
        }
        // AT-SPI exposes many nested Role::Frame objects inside Chromium and
        // other complex applications. They are semantic children, not desktop
        // windows. Surface only frames/windows that correlate to a real X11
        // window; applications remain available as semantic roots.
        records.retain(|record| {
            record.target.kind == NativeTargetKind::App || record.x11_window.is_some()
        });
        records.sort_by(|left, right| {
            target_kind_rank(left.target.kind)
                .cmp(&target_kind_rank(right.target.kind))
                .then_with(|| left.target.title.cmp(&right.target.title))
                .then_with(|| left.target.id.cmp(&right.target.id))
        });
        Ok(records)
    }

    async fn load_target(
        &self,
        target_id: &str,
    ) -> NativeAdapterResult<(TargetRecord, Vec<CacheItem>)> {
        if let Some(locator) = self.target_locators.read().await.get(target_id).cloned() {
            if let Ok(items) = self.application_cache(&locator.application_root).await {
                if let Some(target) = self.refresh_target(locator.record, &items).await {
                    return Ok((target, items));
                }
            }
        }
        let items = self.cache_items().await?;
        let records = self.target_records(&items).await?;
        self.replace_target_locators(&records, &items).await?;
        let target = records
            .into_iter()
            .find(|record| record.target.id == target_id)
            .ok_or_else(|| {
                NativeAdapterError::definite(
                    NativeAdapterErrorCode::TargetNotFound,
                    "AT-SPI target no longer exists",
                    true,
                )
            })?;
        Ok((target, items))
    }

    /// Refresh one previously resolved target from its coherent application
    /// cache. This avoids re-enriching every nested Chromium frame on each
    /// observation while still re-reading the exact target bounds and X11
    /// correlation. A missing or uncorrelated target falls back to the full
    /// discovery path in `load_target`.
    async fn refresh_target(
        &self,
        mut record: TargetRecord,
        items: &[CacheItem],
    ) -> Option<TargetRecord> {
        let item = items
            .iter()
            .find(|item| object_key(&item.object).ok().as_ref() == Some(&record.key))?;
        record.target.title = first_nonempty(&[&item.name, &item.short_name])
            .unwrap_or_else(|| item.role.to_string());
        record.target.focused =
            item.states.contains(State::Focused) || item.states.contains(State::Active);
        record.target.bounds = self.component_bounds(&item.object, item.ifaces).await;
        if record.target.kind == NativeTargetKind::Window {
            let windows = self.desktop.as_ref()?.windows().await.ok()?;
            record.x11_window = correlate_x11_window(&record.target, &windows);
            record.x11_window.as_ref()?;
        }
        Some(record)
    }

    async fn replace_target_locators(
        &self,
        records: &[TargetRecord],
        items: &[CacheItem],
    ) -> NativeAdapterResult<()> {
        let mut by_key = BTreeMap::new();
        for item in items {
            if let Ok(key) = object_key(&item.object) {
                by_key.insert(key, item);
            }
        }
        let mut locators = BTreeMap::new();
        for record in records {
            let mut key = record.key.clone();
            let mut visited = BTreeSet::new();
            while visited.insert(key.clone()) {
                let Some(item) = by_key.get(&key) else {
                    break;
                };
                if item.role == Role::Application {
                    locators.insert(
                        record.target.id.clone(),
                        TargetLocator {
                            application_root: item.object.clone(),
                            record: record.clone(),
                        },
                    );
                    break;
                }
                if item.parent.is_null() {
                    break;
                }
                let Ok(parent_key) = object_key(&item.parent) else {
                    break;
                };
                key = parent_key;
            }
        }
        *self.target_locators.write().await = locators;
        Ok(())
    }

    async fn observe_target(
        &self,
        target: TargetRecord,
        items: Vec<CacheItem>,
    ) -> NativeAdapterResult<NativeObservation> {
        let descendants = descendant_keys(&target.key, &items)?;
        let selected: Vec<CacheItem> = items
            .into_iter()
            .filter(|item| object_key(&item.object).is_ok_and(|key| descendants.contains(&key)))
            .collect();
        let detailed = selected.len() <= MAX_DETAILED_ENRICHMENT_NODES;
        let enriched = stream::iter(
            selected
                .into_iter()
                .map(|item| async move { self.enrich_node(item, detailed).await }),
        )
        .buffer_unordered(MAX_ENRICH_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
        let pairs = enriched
            .into_iter()
            .collect::<NativeAdapterResult<Vec<_>>>()?;
        let mut raw_nodes = Vec::with_capacity(pairs.len());
        let mut objects = BTreeMap::new();
        for (raw, object) in pairs {
            objects.insert(raw.key.clone(), object);
            raw_nodes.push(raw);
        }
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let observation_id = format!("o_{}_{}", self.incarnation.simple(), sequence);
        let snapshot = SemanticSnapshotIndex::build(
            observation_id.clone(),
            std::slice::from_ref(&target.key),
            raw_nodes,
        )?;
        let focused_ref = find_focused_ref(snapshot.roots());
        let frame_id = self
            .latest_window_frames
            .read()
            .await
            .get(&target.target.id)
            .filter(|frame| {
                frame.target_generation == target.target.target_generation
                    && target
                        .x11_window
                        .as_ref()
                        .is_some_and(|window| same_window_placement(&frame.window, window))
            })
            .map(|frame| frame.frame_id.clone());
        let observation = NativeObservation {
            observation_id,
            target: target.target.clone(),
            frame_id,
            roots: snapshot.roots().to_vec(),
            node_count: snapshot.node_count(),
            focused_ref,
            changed_regions: Vec::new(),
        };
        self.latest.write().await.insert(
            target.target.id,
            StoredObservation {
                target_generation: target.target.target_generation,
                snapshot,
                objects,
            },
        );
        Ok(observation)
    }

    async fn enrich_node(
        &self,
        item: CacheItem,
        detailed: bool,
    ) -> NativeAdapterResult<(RawSemanticNode, ObjectRecord)> {
        let key = object_key(&item.object)?;
        let parent_key = if item.parent.is_null() {
            None
        } else {
            Some(object_key(&item.parent)?)
        };
        // The AT-SPI cache is the coherent observation snapshot. Re-querying
        // every cached Chromium node for descriptions, bounds and text creates
        // hundreds of synchronous calls into the browser and can terminate the
        // native accessibility bridge. Keep observation cache-only; actions
        // resolve the retained native object and use its typed interface.
        let interactive = item.ifaces.contains(Interface::Action)
            || item.ifaces.contains(Interface::EditableText)
            || item.ifaces.contains(Interface::Selection)
            || item.ifaces.contains(Interface::Value)
            || item.states.contains(State::Focusable)
            || is_target_role(item.role);
        let identifier = if detailed && interactive {
            self.accessible_identifier(&item.object).await
        } else {
            None
        };
        let description = if detailed && interactive {
            self.accessible_description(&item.object).await
        } else {
            None
        };
        let bounds = if detailed && interactive {
            self.component_bounds(&item.object, item.ifaces).await
        } else {
            None
        };
        let value = if detailed {
            self.node_value(&item).await
        } else {
            None
        };
        let states = item.states.iter().map(|state| state.to_string()).collect();
        let actions = normalized_actions(&item);
        let interfaces: Vec<String> = item
            .ifaces
            .iter()
            .map(|interface| format!("{interface:?}"))
            .collect();
        let raw = RawSemanticNode {
            key,
            parent_key,
            index_in_parent: item.index,
            role: item.role.to_string(),
            identifier,
            name: first_nonempty(&[&item.name, &item.short_name]),
            description,
            value,
            states,
            bounds,
            actions,
            native: Some(NativeNodeMetadata {
                platform: NativeSemanticPlatform::AtSpi,
                data: json!({
                    "role": item.role.to_string(),
                    "interfaces": interfaces,
                }),
            }),
        };
        let object = ObjectRecord {
            object: item.object,
            parent: item.parent,
            index_in_parent: item.index,
            interfaces: item.ifaces,
            focused: item.states.contains(State::Focused),
        };
        Ok((raw, object))
    }

    async fn accessible_identifier(&self, object: &ObjectRefOwned) -> Option<String> {
        let proxy = self.accessible_proxy(object).await.ok()?;
        timed(proxy.accessible_id())
            .await
            .ok()
            .filter(|value| !value.is_empty())
    }

    async fn accessible_description(&self, object: &ObjectRefOwned) -> Option<String> {
        let proxy = self.accessible_proxy(object).await.ok()?;
        timed(proxy.description())
            .await
            .ok()
            .filter(|value| !value.is_empty())
    }

    async fn component_bounds(
        &self,
        object: &ObjectRefOwned,
        interfaces: InterfaceSet,
    ) -> Option<NativeRect> {
        if !interfaces.contains(Interface::Component) {
            return None;
        }
        let proxy = self.component_proxy(object).await.ok()?;
        let (x, y, width, height) = timed(proxy.get_extents(CoordType::Screen)).await.ok()?;
        (width >= 0 && height >= 0).then_some(NativeRect {
            x: f64::from(x),
            y: f64::from(y),
            width: f64::from(width),
            height: f64::from(height),
        })
    }

    async fn node_value(&self, item: &CacheItem) -> Option<NativeNodeValue> {
        if item.role == Role::PasswordText {
            return Some(NativeNodeValue::Redacted(NativeRedactedValue {
                redacted: true,
                reason: NativeRedactionReason::Password,
            }));
        }
        if item.ifaces.contains(Interface::Value) {
            let proxy = self.value_proxy(&item.object).await.ok()?;
            if let Ok(text) = timed(proxy.text()).await {
                if !text.is_empty() {
                    return Some(NativeNodeValue::Text(text));
                }
            }
            if let Ok(value) = timed(proxy.current_value()).await {
                return Some(NativeNodeValue::Text(value.to_string()));
            }
        }
        if item.ifaces.contains(Interface::EditableText) {
            let proxy = self.text_proxy(&item.object).await.ok()?;
            let count = timed(proxy.character_count()).await.ok()?.clamp(0, 32_768);
            return timed(proxy.get_text(0, count))
                .await
                .ok()
                .filter(|value| !value.is_empty())
                .map(NativeNodeValue::Text);
        }
        None
    }

    async fn process_id(&self, object: &ObjectRefOwned) -> Option<u32> {
        let name = object.name()?.clone();
        let proxy = atspi::zbus::fdo::DBusProxy::new(self.connection.connection())
            .await
            .ok()?;
        timed(proxy.get_connection_unix_process_id(name.into()))
            .await
            .ok()
    }

    async fn accessible_proxy<'a>(
        &'a self,
        object: &ObjectRefOwned,
    ) -> NativeAdapterResult<AccessibleProxy<'a>> {
        AccessibleProxy::builder(self.connection.connection())
            .destination(object.name().ok_or_else(null_object)?.clone())
            .map_err(|error| driver_error("construct accessible destination", error))?
            .path(object.path().clone())
            .map_err(|error| driver_error("construct accessible path", error))?
            .build()
            .await
            .map_err(|error| driver_error("construct accessible proxy", error))
    }

    async fn component_proxy<'a>(
        &'a self,
        object: &ObjectRefOwned,
    ) -> NativeAdapterResult<ComponentProxy<'a>> {
        ComponentProxy::builder(self.connection.connection())
            .destination(object.name().ok_or_else(null_object)?.clone())
            .map_err(|error| driver_error("construct component destination", error))?
            .path(object.path().clone())
            .map_err(|error| driver_error("construct component path", error))?
            .build()
            .await
            .map_err(|error| driver_error("construct component proxy", error))
    }

    async fn action_proxy<'a>(
        &'a self,
        object: &ObjectRefOwned,
    ) -> NativeAdapterResult<ActionProxy<'a>> {
        ActionProxy::builder(self.connection.connection())
            .destination(object.name().ok_or_else(null_object)?.clone())
            .map_err(|error| driver_error("construct action destination", error))?
            .path(object.path().clone())
            .map_err(|error| driver_error("construct action path", error))?
            .build()
            .await
            .map_err(|error| driver_error("construct action proxy", error))
    }

    async fn editable_text_proxy<'a>(
        &'a self,
        object: &ObjectRefOwned,
    ) -> NativeAdapterResult<EditableTextProxy<'a>> {
        EditableTextProxy::builder(self.connection.connection())
            .destination(object.name().ok_or_else(null_object)?.clone())
            .map_err(|error| driver_error("construct editable-text destination", error))?
            .path(object.path().clone())
            .map_err(|error| driver_error("construct editable-text path", error))?
            .build()
            .await
            .map_err(|error| driver_error("construct editable-text proxy", error))
    }

    async fn selection_proxy<'a>(
        &'a self,
        object: &ObjectRefOwned,
    ) -> NativeAdapterResult<SelectionProxy<'a>> {
        SelectionProxy::builder(self.connection.connection())
            .destination(object.name().ok_or_else(null_object)?.clone())
            .map_err(|error| driver_error("construct selection destination", error))?
            .path(object.path().clone())
            .map_err(|error| driver_error("construct selection path", error))?
            .build()
            .await
            .map_err(|error| driver_error("construct selection proxy", error))
    }

    async fn text_proxy<'a>(
        &'a self,
        object: &ObjectRefOwned,
    ) -> NativeAdapterResult<TextProxy<'a>> {
        TextProxy::builder(self.connection.connection())
            .destination(object.name().ok_or_else(null_object)?.clone())
            .map_err(|error| driver_error("construct text destination", error))?
            .path(object.path().clone())
            .map_err(|error| driver_error("construct text path", error))?
            .build()
            .await
            .map_err(|error| driver_error("construct text proxy", error))
    }

    async fn value_proxy<'a>(
        &'a self,
        object: &ObjectRefOwned,
    ) -> NativeAdapterResult<ValueProxy<'a>> {
        ValueProxy::builder(self.connection.connection())
            .destination(object.name().ok_or_else(null_object)?.clone())
            .map_err(|error| driver_error("construct value destination", error))?
            .path(object.path().clone())
            .map_err(|error| driver_error("construct value path", error))?
            .build()
            .await
            .map_err(|error| driver_error("construct value proxy", error))
    }

    async fn perform_semantic(
        &self,
        record: &ObjectRecord,
        action: NativeSemanticAction,
        value: Option<&NativeActionValue>,
    ) -> NativeAdapterResult<()> {
        match action {
            NativeSemanticAction::Invoke => self.perform_named_action(record, None).await,
            NativeSemanticAction::Focus => {
                require_interface(record, Interface::Component, "focus")?;
                let proxy = self.component_proxy(&record.object).await?;
                confirm_mutation(timed(proxy.grab_focus()).await, "focus accessible element")
            }
            NativeSemanticAction::SetValue => self.set_value(record, value).await,
            NativeSemanticAction::Increment | NativeSemanticAction::Decrement => {
                self.adjust_value(record, action).await
            }
            NativeSemanticAction::Select | NativeSemanticAction::Deselect => {
                self.set_selected(record, action == NativeSemanticAction::Select)
                    .await
            }
            NativeSemanticAction::Expand => {
                self.perform_named_action(record, Some(&["expand", "open"]))
                    .await
            }
            NativeSemanticAction::Collapse => {
                self.perform_named_action(record, Some(&["collapse", "close"]))
                    .await
            }
            NativeSemanticAction::ShowMenu => {
                self.perform_named_action(record, Some(&["show menu", "menu", "popup"]))
                    .await
            }
            NativeSemanticAction::ScrollIntoView => {
                require_interface(record, Interface::Component, "scroll_into_view")?;
                let proxy = self.component_proxy(&record.object).await?;
                confirm_mutation(
                    timed(proxy.scroll_to(ScrollType::Anywhere)).await,
                    "scroll accessible element into view",
                )
            }
        }
    }

    async fn perform_named_action(
        &self,
        record: &ObjectRecord,
        names: Option<&[&str]>,
    ) -> NativeAdapterResult<()> {
        require_interface(record, Interface::Action, "invoke")?;
        let proxy = self.action_proxy(&record.object).await?;
        let actions = timed(proxy.get_actions())
            .await
            .map_err(|error| ambiguous("read AT-SPI actions", error))?;
        let index = names.map_or(Some(0), |names| {
            actions.iter().position(|candidate| {
                names
                    .iter()
                    .any(|name| candidate.name.eq_ignore_ascii_case(name))
            })
        });
        let Some(index) = index else {
            return Err(NativeAdapterError::unsupported(
                "accessible element does not expose the requested semantic action",
            ));
        };
        let index = i32::try_from(index).map_err(|_| {
            NativeAdapterError::definite(
                NativeAdapterErrorCode::DriverFailed,
                "AT-SPI action index exceeds its native range",
                false,
            )
        })?;
        confirm_mutation(
            timed(proxy.do_action(index)).await,
            "invoke accessible element",
        )
    }

    async fn set_value(
        &self,
        record: &ObjectRecord,
        value: Option<&NativeActionValue>,
    ) -> NativeAdapterResult<()> {
        let value = value.ok_or_else(|| {
            NativeAdapterError::definite(
                NativeAdapterErrorCode::InvalidAction,
                "set_value requires a value",
                false,
            )
        })?;
        if record.interfaces.contains(Interface::EditableText) {
            let NativeActionValue::String(text) = value else {
                return Err(NativeAdapterError::definite(
                    NativeAdapterErrorCode::InvalidAction,
                    "editable text requires a string value",
                    false,
                ));
            };
            let proxy = self.editable_text_proxy(&record.object).await?;
            return confirm_mutation(
                timed(proxy.set_text_contents(text)).await,
                "set accessible text value",
            );
        }
        if record.interfaces.contains(Interface::Value) {
            let NativeActionValue::Number(number) = value else {
                return Err(NativeAdapterError::definite(
                    NativeAdapterErrorCode::InvalidAction,
                    "numeric accessible value requires a number",
                    false,
                ));
            };
            if !number.is_finite() {
                return Err(NativeAdapterError::definite(
                    NativeAdapterErrorCode::InvalidAction,
                    "numeric accessible value must be finite",
                    false,
                ));
            }
            let proxy = self.value_proxy(&record.object).await?;
            return timed(proxy.set_current_value(*number))
                .await
                .map_err(|error| ambiguous("set accessible numeric value", error));
        }
        Err(NativeAdapterError::unsupported(
            "accessible element does not expose a settable value",
        ))
    }

    async fn adjust_value(
        &self,
        record: &ObjectRecord,
        action: NativeSemanticAction,
    ) -> NativeAdapterResult<()> {
        require_interface(record, Interface::Value, "increment/decrement")?;
        let proxy = self.value_proxy(&record.object).await?;
        let current = timed(proxy.current_value())
            .await
            .map_err(|error| driver_error("read accessible value", error))?;
        let increment = timed(proxy.minimum_increment())
            .await
            .map_err(|error| driver_error("read accessible value increment", error))?;
        let next = if action == NativeSemanticAction::Increment {
            current + increment
        } else {
            current - increment
        };
        timed(proxy.set_current_value(next))
            .await
            .map_err(|error| ambiguous("adjust accessible value", error))
    }

    async fn set_selected(&self, record: &ObjectRecord, selected: bool) -> NativeAdapterResult<()> {
        if record.parent.is_null() || record.index_in_parent < 0 {
            return Err(NativeAdapterError::unsupported(
                "accessible element has no selectable parent",
            ));
        }
        let proxy = self.selection_proxy(&record.parent).await?;
        let result = if selected {
            timed(proxy.select_child(record.index_in_parent)).await
        } else {
            timed(proxy.deselect_child(record.index_in_parent)).await
        };
        confirm_mutation(result, "change accessible selection")
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
        latest.ok_or_else(|| {
            NativeAdapterError::definite(
                NativeAdapterErrorCode::DriverFailed,
                "native mutation settlement produced no observation",
                true,
            )
        })
    }

    async fn observe_after_focus(
        &self,
        target_id: &str,
        expected_object_key: &str,
    ) -> NativeAdapterResult<NativeObservation> {
        let mut consecutive_matches = 0_u8;
        for delay in FOCUS_SETTLE_DELAYS {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            let observation = self.observe(target_id).await?;
            let focused_matches = {
                let latest = self.latest.read().await;
                latest
                    .get(target_id)
                    .and_then(|stored| stored.objects.get(expected_object_key))
                    .is_some_and(|record| record.focused)
            };
            if focused_matches {
                consecutive_matches += 1;
                if consecutive_matches == 2 {
                    return Ok(observation);
                }
            } else {
                consecutive_matches = 0;
            }
        }
        Err(NativeAdapterError::definite(
            NativeAdapterErrorCode::DriverFailed,
            "AT-SPI accepted focus but the requested element did not retain keyboard focus",
            true,
        ))
    }

    async fn validate_screen(
        &self,
        command: &NativeActionCommand,
        target: &NativeTarget,
    ) -> NativeAdapterResult<()> {
        if target.target_generation != command.expected_target_generation {
            return Err(NativeAdapterError::definite(
                NativeAdapterErrorCode::TargetStale,
                "Linux X11 display geometry changed",
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
                let latest = self.latest_screen_frame.read().await;
                if command.expected_frame_id.as_deref() != Some(frame_id)
                    || latest.as_deref() != Some(frame_id)
                {
                    return Err(NativeAdapterError::definite(
                        NativeAdapterErrorCode::FrameStale,
                        "Linux pointer coordinates target a stale captured frame",
                        true,
                    ));
                }
                let bounds = target.bounds.ok_or_else(|| {
                    NativeAdapterError::definite(
                        NativeAdapterErrorCode::DriverFailed,
                        "Linux X11 screen has no geometry",
                        true,
                    )
                })?;
                validate_screen_point(*x, *y, bounds)?;
                match (end_x, end_y) {
                    (Some(end_x), Some(end_y)) => {
                        validate_screen_point(*end_x, *end_y, bounds)?;
                    }
                    (None, None) => {}
                    _ => {
                        return Err(NativeAdapterError::definite(
                            NativeAdapterErrorCode::InvalidAction,
                            "pointer end coordinates must be supplied together",
                            false,
                        ));
                    }
                }
            }
            NativeAction::Keyboard { action, value } => {
                if *action == NativeKeyboardAction::Press {
                    validate_linux_named_key_chord(value)
                        .map_err(|error| invalid_action(error.to_string()))?;
                }
            }
            NativeAction::Clipboard { operation, text } => {
                validate_clipboard_payload(*operation, text.as_deref())?;
                if self.clipboard.is_none() {
                    return Err(NativeAdapterError::unsupported(
                        "native text clipboard is unavailable on this Linux graphical seat",
                    ));
                }
            }
            NativeAction::Semantic { .. }
            | NativeAction::Focus { .. }
            | NativeAction::Launch { .. } => {
                return Err(NativeAdapterError::unsupported(
                    "semantic/focus/launch actions cannot target the X11 screen",
                ));
            }
        }
        Ok(())
    }

    async fn dispatch_screen_action(
        &self,
        command: &NativeActionCommand,
    ) -> NativeAdapterResult<()> {
        let desktop = self.desktop.as_ref().ok_or_else(|| {
            NativeAdapterError::unavailable("Linux X11 input is unavailable", true)
        })?;
        let inputs = screen_inputs(&command.action)?;
        for input in inputs {
            desktop.inject(&input).await.map_err(|error| {
                NativeAdapterError::outcome_unknown(format!(
                    "Linux XTEST delivery could not be confirmed: {error}"
                ))
            })?;
        }
        Ok(())
    }

    async fn capture_window_target(
        &self,
        record: TargetRecord,
    ) -> NativeAdapterResult<NativeCapturedFrame> {
        let desktop = self.desktop.as_ref().ok_or_else(|| {
            NativeAdapterError::unavailable("Linux X11 window capture is unavailable", true)
        })?;
        let window = record.x11_window.clone().ok_or_else(|| {
            NativeAdapterError::definite(
                NativeAdapterErrorCode::TargetNotFound,
                "AT-SPI window could not be correlated to one unambiguous X11 client window",
                true,
            )
        })?;
        let captured = desktop.capture_window(window.id).await.map_err(|error| {
            NativeAdapterError::definite(
                NativeAdapterErrorCode::DriverFailed,
                format!("capture Linux X11 window: {error}"),
                true,
            )
        })?;
        self.finish_window_capture(
            record,
            window,
            captured.width,
            captured.height,
            "image/png",
            captured.png,
        )
        .await
    }

    async fn capture_window_live_target(
        &self,
        record: TargetRecord,
        options: crate::NativeCaptureOptions,
    ) -> NativeAdapterResult<NativeCapturedFrame> {
        let desktop = self.desktop.as_ref().ok_or_else(|| {
            NativeAdapterError::unavailable("Linux X11 window capture is unavailable", true)
        })?;
        let window = record.x11_window.clone().ok_or_else(|| {
            NativeAdapterError::definite(
                NativeAdapterErrorCode::TargetNotFound,
                "AT-SPI window could not be correlated to one unambiguous X11 client window",
                true,
            )
        })?;
        let captured = desktop
            .capture_window_rgba(window.id)
            .await
            .map_err(|error| {
                NativeAdapterError::definite(
                    NativeAdapterErrorCode::DriverFailed,
                    format!("capture Linux X11 live window: {error}"),
                    true,
                )
            })?;
        let (width, height, mime_type, bytes) = encode_live_frame(&captured, options)?;
        self.finish_window_capture(record, window, width, height, mime_type, bytes)
            .await
    }

    async fn finish_window_capture(
        &self,
        record: TargetRecord,
        window: LinuxWindow,
        width: u32,
        height: u32,
        mime_type: &str,
        bytes: Vec<u8>,
    ) -> NativeAdapterResult<NativeCapturedFrame> {
        let desktop = self.desktop.as_ref().ok_or_else(|| {
            NativeAdapterError::unavailable("Linux X11 window capture is unavailable", true)
        })?;
        let current = desktop
            .windows()
            .await
            .map_err(|error| {
                NativeAdapterError::definite(
                    NativeAdapterErrorCode::DriverFailed,
                    format!("refresh Linux X11 window after capture: {error}"),
                    true,
                )
            })?
            .into_iter()
            .find(|candidate| candidate.id == window.id)
            .ok_or_else(|| {
                NativeAdapterError::definite(
                    NativeAdapterErrorCode::TargetNotFound,
                    "X11 window disappeared during capture",
                    true,
                )
            })?;
        if window.id != current.id || window.process_id != current.process_id {
            return Err(NativeAdapterError::definite(
                NativeAdapterErrorCode::TargetStale,
                "X11 window identity changed during capture",
                true,
            ));
        }
        if width != current.bounds.width || height != current.bounds.height {
            return Err(NativeAdapterError::definite(
                NativeAdapterErrorCode::FrameStale,
                "X11 window resized during capture",
                true,
            ));
        }

        let sequence = self.frame_sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let frame_id = format!("f_{}_{}", self.incarnation.simple(), sequence);
        let mut frames = self.latest_window_frames.write().await;
        frames.insert(
            record.target.id.clone(),
            WindowFrameFence {
                sequence,
                frame_id: frame_id.clone(),
                target_generation: record.target.target_generation.clone(),
                window: current,
                width,
                height,
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
        Ok(NativeCapturedFrame {
            frame_id,
            target_id: record.target.id,
            target_generation: record.target.target_generation,
            width,
            height,
            mime_type: mime_type.to_string(),
            sha256: hex::encode(Sha256::digest(&bytes)),
            bytes,
        })
    }

    async fn validate_window_pointer(
        &self,
        command: &NativeActionCommand,
    ) -> NativeAdapterResult<(TargetRecord, WindowFrameFence)> {
        let (record, _) = self.load_target(&command.target_id).await?;
        if record.target.kind != NativeTargetKind::Window {
            return Err(NativeAdapterError::unsupported(
                "window-relative pointer input requires an AT-SPI window target",
            ));
        }
        if record.target.target_generation != command.expected_target_generation {
            return Err(NativeAdapterError::definite(
                NativeAdapterErrorCode::TargetStale,
                "AT-SPI window generation changed",
                true,
            ));
        }
        let current_window = record.x11_window.as_ref().ok_or_else(|| {
            NativeAdapterError::definite(
                NativeAdapterErrorCode::TargetNotFound,
                "AT-SPI window no longer correlates to one X11 client window",
                true,
            )
        })?;
        let frame = self
            .latest_window_frames
            .read()
            .await
            .get(&command.target_id)
            .cloned()
            .ok_or_else(|| {
                NativeAdapterError::definite(
                    NativeAdapterErrorCode::FrameStale,
                    "window has not been captured in this adapter incarnation",
                    true,
                )
            })?;
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
                "only pointer actions may use a window frame",
            ));
        };
        if command.expected_frame_id.as_deref() != Some(frame_id)
            || frame.frame_id != *frame_id
            || frame.target_generation != command.expected_target_generation
            || !same_window_placement(&frame.window, current_window)
        {
            return Err(NativeAdapterError::definite(
                NativeAdapterErrorCode::FrameStale,
                "X11 window frame, placement, or target generation changed",
                true,
            ));
        }
        validate_local_point(*x, *y, frame.width, frame.height)?;
        match (end_x, end_y) {
            (Some(end_x), Some(end_y)) => {
                validate_local_point(*end_x, *end_y, frame.width, frame.height)?;
            }
            (None, None) => {}
            _ => {
                return Err(NativeAdapterError::definite(
                    NativeAdapterErrorCode::InvalidAction,
                    "pointer end coordinates must be supplied together",
                    false,
                ));
            }
        }
        Ok((record, frame))
    }

    async fn dispatch_window_pointer(
        &self,
        command: &NativeActionCommand,
    ) -> NativeAdapterResult<Option<NativeObservation>> {
        let (record, frame) = self.validate_window_pointer(command).await?;
        let desktop = self.desktop.as_ref().ok_or_else(|| {
            NativeAdapterError::unavailable("Linux X11 window input is unavailable", true)
        })?;
        let inputs = pixel_inputs(
            &command.action,
            f64::from(frame.window.bounds.x),
            f64::from(frame.window.bounds.y),
        )?;
        self.latest_window_frames
            .write()
            .await
            .remove(&command.target_id);
        *self.latest_screen_frame.write().await = None;
        desktop
            .inject_window(frame.window.id, frame.window.bounds, inputs)
            .await
            .map_err(|error| match error {
                PlatformError::NotFound(message) => NativeAdapterError::definite(
                    NativeAdapterErrorCode::FrameStale,
                    format!("X11 window changed immediately before input: {message}"),
                    true,
                ),
                error => NativeAdapterError::outcome_unknown(format!(
                    "Linux X11 window input could not be confirmed: {error}"
                )),
            })?;
        Ok(async {
            let items = self.cache_items().await?;
            let current = self
                .target_records(&items)
                .await?
                .into_iter()
                .find(|candidate| candidate.target.id == record.target.id)
                .ok_or_else(|| {
                    NativeAdapterError::definite(
                        NativeAdapterErrorCode::TargetNotFound,
                        "AT-SPI window disappeared after pointer input",
                        true,
                    )
                })?;
            self.observe_target(current, items).await
        }
        .await
        .ok())
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
                            "native text clipboard is unavailable on this Linux graphical seat",
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
impl ComputerAdapter for AtspiComputerAdapter {
    fn capabilities(&self) -> NativeCapabilities {
        let desktop = self.desktop.is_some();
        NativeCapabilities {
            semantic_observation: true,
            app_discovery: true,
            app_launch: false,
            window_capture: self
                .desktop
                .as_ref()
                .is_some_and(LinuxDesktop::supports_window_capture),
            screen_capture: desktop,
            semantic_actions: true,
            pointer_input: desktop,
            keyboard_input: desktop,
            clipboard: self.clipboard.is_some(),
            background_actions: true,
            parallel_apps: true,
        }
    }

    async fn targets(&self) -> NativeAdapterResult<Vec<NativeTarget>> {
        // The X11 screen is an independent, always useful control plane. A
        // transient AT-SPI discovery failure must degrade to pixel control,
        // never remove the desktop or turn UI polling into a 500 loop.
        let mut targets = Vec::new();
        if let Ok(items) = self.cache_items().await {
            if let Ok(records) = self.target_records(&items).await {
                let _ = self.replace_target_locators(&records, &items).await;
                targets.extend(records.into_iter().map(|record| record.target));
            }
        }
        if let Some(screen) = self.screen_target() {
            targets.push(screen);
        }
        Ok(targets)
    }

    async fn observe(&self, target_id: &str) -> NativeAdapterResult<NativeObservation> {
        if let Some(screen) = self.screen_target() {
            if screen.id == target_id {
                return Ok(self.screen_observation(screen).await);
            }
        }
        let (target, items) = self.load_target(target_id).await?;
        self.observe_target(target, items).await
    }

    async fn capture(&self, target_id: &str) -> NativeAdapterResult<NativeCapturedFrame> {
        if let Some(target) = self.screen_target() {
            if target.id == target_id {
                let desktop = self.desktop.as_ref().ok_or_else(|| {
                    NativeAdapterError::unavailable("Linux X11 screen capture is unavailable", true)
                })?;
                let captured = desktop.capture().await.map_err(|error| {
                    NativeAdapterError::definite(
                        NativeAdapterErrorCode::DriverFailed,
                        format!("capture Linux X11 screen: {error}"),
                        true,
                    )
                })?;
                let sequence = self.frame_sequence.fetch_add(1, Ordering::Relaxed) + 1;
                let frame_id = format!("f_{}_{}", self.incarnation.simple(), sequence);
                *self.latest_screen_frame.write().await = Some(frame_id.clone());
                return Ok(NativeCapturedFrame {
                    frame_id,
                    target_id: target.id,
                    target_generation: target.target_generation,
                    width: captured.width,
                    height: captured.height,
                    mime_type: "image/png".to_string(),
                    sha256: hex::encode(Sha256::digest(&captured.png)),
                    bytes: captured.png,
                });
            }
        }
        let (record, _) = self.load_target(target_id).await?;
        self.capture_window_target(record).await
    }

    async fn capture_stream(
        &self,
        target_id: &str,
        options: crate::NativeCaptureOptions,
    ) -> NativeAdapterResult<NativeCapturedFrame> {
        if let Some(target) = self.screen_target() {
            if target.id == target_id {
                let desktop = self.desktop.as_ref().ok_or_else(|| {
                    NativeAdapterError::unavailable("Linux X11 screen capture is unavailable", true)
                })?;
                let captured = desktop.capture_rgba().await.map_err(|error| {
                    NativeAdapterError::definite(
                        NativeAdapterErrorCode::DriverFailed,
                        format!("capture Linux X11 live screen: {error}"),
                        true,
                    )
                })?;
                let (width, height, mime_type, bytes) = encode_live_frame(&captured, options)?;
                let sequence = self.frame_sequence.fetch_add(1, Ordering::Relaxed) + 1;
                let frame_id = format!("f_{}_{}", self.incarnation.simple(), sequence);
                *self.latest_screen_frame.write().await = Some(frame_id.clone());
                return Ok(NativeCapturedFrame {
                    frame_id,
                    target_id: target.id,
                    target_generation: target.target_generation,
                    width,
                    height,
                    mime_type: mime_type.to_string(),
                    sha256: hex::encode(Sha256::digest(&bytes)),
                    bytes,
                });
            }
        }
        let (record, _) = self.load_target(target_id).await?;
        self.capture_window_live_target(record, options).await
    }

    async fn clipboard(&self) -> NativeAdapterResult<NativeClipboard> {
        self.clipboard
            .as_ref()
            .ok_or_else(|| {
                NativeAdapterError::unsupported(
                    "native text clipboard is unavailable on this Linux graphical seat",
                )
            })?
            .read()
            .await
    }

    async fn validate(&self, command: &NativeActionCommand) -> NativeAdapterResult<()> {
        if let Some(screen) = self.screen_target() {
            if screen.id == command.target_id {
                return self.validate_screen(command, &screen).await;
            }
        }
        if matches!(command.action, NativeAction::Pointer { .. }) {
            self.validate_window_pointer(command).await?;
            return Ok(());
        }
        let latest = self.latest.read().await;
        let stored = latest.get(&command.target_id).ok_or_else(|| {
            NativeAdapterError::definite(
                NativeAdapterErrorCode::ObservationStale,
                "native target has not been observed in this adapter incarnation",
                true,
            )
        })?;
        if stored.target_generation != command.expected_target_generation {
            return Err(NativeAdapterError::definite(
                NativeAdapterErrorCode::TargetStale,
                "AT-SPI target generation changed",
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
                        "semantic ref belongs to a stale AT-SPI observation",
                        true,
                    ));
                }
                let _ = stored.snapshot.resolve(locator)?;
            }
            NativeAction::Pointer { .. } | NativeAction::Keyboard { .. } => {
                return Err(NativeAdapterError::unsupported(
                    "Linux pixel input must target the exact X11 screen",
                ));
            }
            NativeAction::Clipboard { operation, text } => {
                validate_clipboard_payload(*operation, text.as_deref())?;
                if matches!(
                    operation,
                    NativeClipboardAction::Copy | NativeClipboardAction::Paste
                ) {
                    return Err(NativeAdapterError::unsupported(
                        "Linux clipboard copy/paste must target the exact X11 screen",
                    ));
                }
                if self.clipboard.is_none() {
                    return Err(NativeAdapterError::unsupported(
                        "native text clipboard is unavailable on this Linux graphical seat",
                    ));
                }
            }
            NativeAction::Focus { target_id } => {
                if target_id != &command.target_id {
                    return Err(NativeAdapterError::definite(
                        NativeAdapterErrorCode::InvalidAction,
                        "focus action target must equal the command target",
                        false,
                    ));
                }
            }
            NativeAction::Launch { .. } => {
                return Err(NativeAdapterError::unsupported(
                    "Linux application launch is unavailable in this adapter",
                ));
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_lines)]
    async fn dispatch(
        &self,
        command: &NativeActionCommand,
    ) -> NativeAdapterResult<Option<NativeObservation>> {
        // Do not wait for the accessibility bus to deliver our own mutation
        // event before the settlement observation. External mutations are
        // invalidated by the registered AT-SPI event stream above.
        self.invalidate_semantic_cache();
        if let Some(result) = self.dispatch_clipboard_storage(command).await {
            return result;
        }
        if let Some(screen) = self.screen_target() {
            if screen.id == command.target_id {
                self.validate_screen(command, &screen).await?;
                *self.latest_screen_frame.write().await = None;
                self.dispatch_screen_action(command).await?;
                return Ok(Some(self.screen_observation(screen).await));
            }
        }
        if matches!(command.action, NativeAction::Pointer { .. }) {
            return self.dispatch_window_pointer(command).await;
        }
        self.validate(command).await?;
        let (record, semantic, before_roots, expected_focus_key) = {
            let latest = self.latest.read().await;
            let stored = latest.get(&command.target_id).ok_or_else(|| {
                NativeAdapterError::definite(
                    NativeAdapterErrorCode::ObservationStale,
                    "AT-SPI observation expired before dispatch",
                    true,
                )
            })?;
            match &command.action {
                NativeAction::Semantic {
                    locator,
                    action,
                    value,
                } => {
                    let key = stored.snapshot.resolve(locator)?;
                    let record = stored.objects.get(key).cloned().ok_or_else(|| {
                        NativeAdapterError::definite(
                            NativeAdapterErrorCode::ObservationStale,
                            "AT-SPI object disappeared from its observation",
                            true,
                        )
                    })?;
                    (
                        record,
                        Some((*action, value.clone())),
                        stored.snapshot.roots().to_vec(),
                        (*action == NativeSemanticAction::Focus).then(|| key.to_string()),
                    )
                }
                NativeAction::Focus { .. } => {
                    let root = stored.snapshot.roots().first().ok_or_else(|| {
                        NativeAdapterError::definite(
                            NativeAdapterErrorCode::TargetNotFound,
                            "AT-SPI target has no accessible root",
                            true,
                        )
                    })?;
                    let key = stored.snapshot.resolve(&NativeLocator::Ref {
                        r#ref: root.r#ref.clone(),
                    })?;
                    let record = stored.objects.get(key).cloned().ok_or_else(|| {
                        NativeAdapterError::definite(
                            NativeAdapterErrorCode::ObservationStale,
                            "AT-SPI target root disappeared",
                            true,
                        )
                    })?;
                    (
                        record,
                        Some((NativeSemanticAction::Focus, None)),
                        stored.snapshot.roots().to_vec(),
                        Some(key.to_string()),
                    )
                }
                NativeAction::Pointer { .. }
                | NativeAction::Keyboard { .. }
                | NativeAction::Clipboard { .. }
                | NativeAction::Launch { .. } => {
                    return Err(NativeAdapterError::unsupported(
                        "native action is unavailable in the AT-SPI adapter",
                    ));
                }
            }
        };
        if let Some((action, value)) = semantic {
            if action == NativeSemanticAction::Focus {
                let locator = self
                    .target_locators
                    .read()
                    .await
                    .get(&command.target_id)
                    .cloned();
                if let Some(window) = locator.and_then(|locator| locator.record.x11_window) {
                    let desktop = self.desktop.as_ref().ok_or_else(|| {
                        NativeAdapterError::unavailable(
                            "Linux X11 window focus is unavailable",
                            true,
                        )
                    })?;
                    desktop
                        .focus_window(window.id, window.bounds)
                        .await
                        .map_err(|error| match error {
                            PlatformError::NotFound(message) => NativeAdapterError::definite(
                                NativeAdapterErrorCode::TargetStale,
                                format!("X11 window changed immediately before focus: {message}"),
                                true,
                            ),
                            error => NativeAdapterError::definite(
                                NativeAdapterErrorCode::DriverFailed,
                                format!("focus correlated Linux X11 window: {error}"),
                                true,
                            ),
                        })?;
                }
            }
            self.perform_semantic(&record, action, value.as_ref())
                .await?;
        }
        self.latest_window_frames
            .write()
            .await
            .remove(&command.target_id);
        *self.latest_screen_frame.write().await = None;
        if let Some(expected_focus_key) = expected_focus_key {
            return Ok(Some(
                self.observe_after_focus(&command.target_id, &expected_focus_key)
                    .await?,
            ));
        }
        Ok(self
            .observe_after_mutation(&command.target_id, &before_roots)
            .await
            .ok())
    }
}

fn encode_live_frame(
    frame: &LinuxRgbaFrame,
    options: crate::NativeCaptureOptions,
) -> NativeAdapterResult<(u32, u32, &'static str, Vec<u8>)> {
    let (rgba, width, height) = fit_live_rgba(frame, options)?;
    if options.format == crate::NativeFrameFormat::Png {
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(&rgba, width, height, ExtendedColorType::Rgba8)
            .map_err(|error| {
                NativeAdapterError::definite(
                    NativeAdapterErrorCode::DriverFailed,
                    format!("encode Linux live frame: {error}"),
                    true,
                )
            })?;
        return Ok((width, height, "image/png", png));
    }
    let mut rgb = Vec::with_capacity(rgba.len() / 4 * 3);
    for pixel in rgba.chunks_exact(4) {
        rgb.extend_from_slice(&pixel[..3]);
    }
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, options.quality)
        .write_image(&rgb, width, height, ExtendedColorType::Rgb8)
        .map_err(|error| {
            NativeAdapterError::definite(
                NativeAdapterErrorCode::DriverFailed,
                format!("encode Linux live frame: {error}"),
                true,
            )
        })?;
    Ok((width, height, "image/jpeg", jpeg))
}

fn fit_live_rgba(
    frame: &LinuxRgbaFrame,
    options: crate::NativeCaptureOptions,
) -> NativeAdapterResult<(Vec<u8>, u32, u32)> {
    let Some((output_width, output_height)) = crate::model::fit_frame_dimensions(
        frame.width,
        frame.height,
        options.max_width,
        options.max_height,
    ) else {
        return Err(NativeAdapterError::definite(
            NativeAdapterErrorCode::DriverFailed,
            "Linux capture dimensions are invalid",
            true,
        ));
    };
    if (output_width, output_height) == (frame.width, frame.height) {
        return Ok((frame.rgba.clone(), frame.width, frame.height));
    }
    let source =
        RgbaImage::from_raw(frame.width, frame.height, frame.rgba.clone()).ok_or_else(|| {
            NativeAdapterError::definite(
                NativeAdapterErrorCode::DriverFailed,
                "Linux capture RGBA dimensions are inconsistent",
                true,
            )
        })?;
    let resized =
        image::imageops::resize(&source, output_width, output_height, FilterType::Triangle);
    Ok((resized.into_raw(), output_width, output_height))
}

fn descendant_keys(root: &str, items: &[CacheItem]) -> NativeAdapterResult<BTreeSet<String>> {
    let mut children = BTreeMap::<String, Vec<String>>::new();
    for item in items {
        if item.parent.is_null() {
            continue;
        }
        children
            .entry(object_key(&item.parent)?)
            .or_default()
            .push(object_key(&item.object)?);
    }
    let mut selected = BTreeSet::new();
    let mut pending = VecDeque::from([root.to_string()]);
    while let Some(key) = pending.pop_front() {
        if !selected.insert(key.clone()) {
            continue;
        }
        if selected.len() > 10_000 {
            return Err(NativeAdapterError::definite(
                NativeAdapterErrorCode::DriverFailed,
                "AT-SPI target tree exceeds the semantic node envelope",
                true,
            ));
        }
        pending.extend(children.get(&key).into_iter().flatten().cloned());
    }
    Ok(selected)
}

fn cache_snapshot_complete(items: &[CacheItem]) -> bool {
    let mut observed_children = BTreeMap::<String, usize>::new();
    for item in items {
        if item.parent.is_null() {
            continue;
        }
        let Ok(parent) = object_key(&item.parent) else {
            return false;
        };
        *observed_children.entry(parent).or_default() += 1;
    }
    items.iter().all(|item| {
        item.children >= 0
            && usize::try_from(item.children).is_ok_and(|expected| {
                object_key(&item.object).ok().is_some_and(|key| {
                    observed_children.get(&key).copied().unwrap_or(0) == expected
                })
            })
    })
}

fn convert_legacy_cache(items: Vec<LegacyCacheItem>) -> NativeAdapterResult<Vec<CacheItem>> {
    let mut child_indices = BTreeMap::<String, i32>::new();
    for item in &items {
        for (index, child) in item.children.iter().enumerate() {
            let index = i32::try_from(index).map_err(|_| {
                NativeAdapterError::definite(
                    NativeAdapterErrorCode::DriverFailed,
                    "legacy AT-SPI child index exceeds its native range",
                    true,
                )
            })?;
            child_indices.insert(object_key(child)?, index);
        }
    }
    items
        .into_iter()
        .map(|item| {
            let key = object_key(&item.object)?;
            let children = i32::try_from(item.children.len()).map_err(|_| {
                NativeAdapterError::definite(
                    NativeAdapterErrorCode::DriverFailed,
                    "legacy AT-SPI child count exceeds its native range",
                    true,
                )
            })?;
            Ok(CacheItem {
                object: item.object,
                app: item.app,
                parent: item.parent,
                index: child_indices.get(&key).copied().unwrap_or(-1),
                children,
                ifaces: item.ifaces,
                short_name: item.short_name,
                role: item.role,
                name: item.name,
                states: item.states,
            })
        })
        .collect()
}

fn normalized_actions(item: &CacheItem) -> Vec<String> {
    let mut actions = BTreeSet::new();
    if item.ifaces.contains(Interface::Action) {
        actions.insert("invoke".to_string());
    }
    if item.ifaces.contains(Interface::Component)
        && (item.states.contains(State::Focusable)
            || item.ifaces.contains(Interface::Action)
            || item.ifaces.contains(Interface::EditableText)
            || item.ifaces.contains(Interface::Selection)
            || item.ifaces.contains(Interface::Value)
            || is_target_role(item.role))
    {
        actions.insert("focus".to_string());
        actions.insert("scroll_into_view".to_string());
    }
    if item.ifaces.contains(Interface::EditableText) || item.ifaces.contains(Interface::Value) {
        actions.insert("set_value".to_string());
    }
    if item.ifaces.contains(Interface::Value) {
        actions.insert("decrement".to_string());
        actions.insert("increment".to_string());
    }
    if item.states.contains(State::Selectable) {
        actions.insert("deselect".to_string());
        actions.insert("select".to_string());
    }
    if item.states.contains(State::Expandable) {
        actions.insert("collapse".to_string());
        actions.insert("expand".to_string());
    }
    actions.into_iter().collect()
}

fn require_interface(
    record: &ObjectRecord,
    interface: Interface,
    action: &str,
) -> NativeAdapterResult<()> {
    if record.interfaces.contains(interface) {
        Ok(())
    } else {
        Err(NativeAdapterError::unsupported(format!(
            "accessible element does not support {action}"
        )))
    }
}

fn confirm_mutation<E: std::fmt::Display>(
    result: Result<bool, E>,
    action: &str,
) -> NativeAdapterResult<()> {
    match result {
        Ok(true) => Ok(()),
        Ok(false) => Err(NativeAdapterError::definite(
            NativeAdapterErrorCode::DriverFailed,
            format!("AT-SPI refused to {action}"),
            true,
        )),
        Err(error) => Err(ambiguous(action, error)),
    }
}

fn is_target_role(role: Role) -> bool {
    matches!(
        role,
        Role::Application | Role::Frame | Role::Window | Role::Dialog
    )
}

const fn target_kind_rank(kind: NativeTargetKind) -> u8 {
    match kind {
        NativeTargetKind::App => 0,
        NativeTargetKind::Window => 1,
        NativeTargetKind::Screen => 2,
    }
}

const fn target_kind_prefix(kind: NativeTargetKind) -> &'static str {
    match kind {
        NativeTargetKind::App => "app",
        NativeTargetKind::Window => "window",
        NativeTargetKind::Screen => "screen",
    }
}

fn object_key(object: &ObjectRefOwned) -> NativeAdapterResult<String> {
    let name = object.name_as_str().ok_or_else(null_object)?;
    Ok(format!("{name}\0{}", object.path_as_str()))
}

fn correlate_x11_window(target: &NativeTarget, windows: &[LinuxWindow]) -> Option<LinuxWindow> {
    if target.kind != NativeTargetKind::Window {
        return None;
    }
    let process_scoped = target.process_id.is_some();
    let mut candidates: Vec<&LinuxWindow> = if let Some(process_id) = target.process_id {
        windows
            .iter()
            .filter(|window| window.process_id == Some(process_id))
            .collect()
    } else {
        let title = normalized_title(&target.title);
        if title.is_empty() {
            return None;
        }
        windows
            .iter()
            .filter(|window| normalized_title(&window.title) == title)
            .collect()
    };
    if candidates.is_empty() {
        return None;
    }
    let mut placement_match = !process_scoped;

    let title = normalized_title(&target.title);
    if !title.is_empty() {
        let titled: Vec<&LinuxWindow> = candidates
            .iter()
            .copied()
            .filter(|window| normalized_title(&window.title) == title)
            .collect();
        if !titled.is_empty() {
            candidates = titled;
            placement_match = true;
        }
    }
    if let Some(bounds) = target.bounds {
        let placed: Vec<&LinuxWindow> = candidates
            .iter()
            .copied()
            .filter(|window| bounds_close(bounds, window.bounds))
            .collect();
        if !placed.is_empty() {
            candidates = placed;
            placement_match = true;
        }
    }
    (placement_match && candidates.len() == 1).then(|| candidates[0].clone())
}

fn normalized_title(value: &str) -> String {
    value
        .split_whitespace()
        .flat_map(str::chars)
        .flat_map(char::to_lowercase)
        .collect()
}

fn bounds_close(native: NativeRect, x11: LinuxWindowRect) -> bool {
    let tolerance = native.width.max(native.height).mul_add(0.05, 8.0);
    (native.x - f64::from(x11.x)).abs() <= tolerance
        && (native.y - f64::from(x11.y)).abs() <= tolerance
        && (native.width - f64::from(x11.width)).abs() <= tolerance
        && (native.height - f64::from(x11.height)).abs() <= tolerance
}

fn same_window_placement(left: &LinuxWindow, right: &LinuxWindow) -> bool {
    left.id == right.id && left.process_id == right.process_id && left.bounds == right.bounds
}

fn validate_local_point(x: f64, y: f64, width: u32, height: u32) -> NativeAdapterResult<()> {
    if !x.is_finite()
        || !y.is_finite()
        || x < 0.0
        || y < 0.0
        || x >= f64::from(width)
        || y >= f64::from(height)
    {
        return Err(NativeAdapterError::definite(
            NativeAdapterErrorCode::InvalidAction,
            "pointer coordinates are outside the captured X11 window",
            false,
        ));
    }
    Ok(())
}

fn validate_screen_point(x: f64, y: f64, bounds: NativeRect) -> NativeAdapterResult<()> {
    if !x.is_finite()
        || !y.is_finite()
        || x < bounds.x
        || y < bounds.y
        || x >= bounds.x + bounds.width
        || y >= bounds.y + bounds.height
    {
        return Err(NativeAdapterError::definite(
            NativeAdapterErrorCode::InvalidAction,
            "pointer coordinates are outside the captured X11 screen",
            false,
        ));
    }
    Ok(())
}

fn screen_inputs(action: &NativeAction) -> NativeAdapterResult<Vec<v1::DesktopInput>> {
    pixel_inputs(action, 0.0, 0.0)
}

fn pixel_inputs(
    action: &NativeAction,
    offset_x: f64,
    offset_y: f64,
) -> NativeAdapterResult<Vec<v1::DesktopInput>> {
    match action {
        NativeAction::Pointer {
            action,
            x,
            y,
            end_x,
            end_y,
            delta_x,
            delta_y,
            button,
            ..
        } => {
            let x = checked_i32(*x + offset_x, "pointer x")?;
            let y = checked_i32(*y + offset_y, "pointer y")?;
            let button = match button.unwrap_or(NativePointerButton::Left) {
                NativePointerButton::Left => v1::PointerButton::Left,
                NativePointerButton::Right => v1::PointerButton::Right,
                NativePointerButton::Middle => v1::PointerButton::Middle,
            };
            match action {
                NativePointerAction::Scroll => Ok(vec![desktop_input(
                    v1::desktop_input::Event::Scroll(v1::ScrollEvent {
                        x,
                        y,
                        delta_x: checked_i32(delta_x.unwrap_or(0.0), "horizontal scroll delta")?,
                        delta_y: checked_i32(delta_y.unwrap_or(0.0), "vertical scroll delta")?,
                    }),
                )]),
                NativePointerAction::Drag => {
                    let end_x = checked_i32(
                        end_x.ok_or_else(|| invalid_action("drag requires endX"))? + offset_x,
                        "drag end x",
                    )?;
                    let end_y = checked_i32(
                        end_y.ok_or_else(|| invalid_action("drag requires endY"))? + offset_y,
                        "drag end y",
                    )?;
                    Ok(vec![
                        pointer_input(x, y, v1::PointerAction::Down, button),
                        pointer_input(end_x, end_y, v1::PointerAction::Move, button),
                        pointer_input(end_x, end_y, v1::PointerAction::Up, button),
                    ])
                }
                NativePointerAction::Click
                | NativePointerAction::DoubleClick
                | NativePointerAction::Move => {
                    let action = match action {
                        NativePointerAction::Click => v1::PointerAction::Click,
                        NativePointerAction::DoubleClick => v1::PointerAction::DoubleClick,
                        NativePointerAction::Move => v1::PointerAction::Move,
                        NativePointerAction::Scroll | NativePointerAction::Drag => unreachable!(),
                    };
                    Ok(vec![pointer_input(x, y, action, button)])
                }
            }
        }
        NativeAction::Keyboard { action, value } => Ok(vec![desktop_input(
            v1::desktop_input::Event::Key(v1::KeyEvent {
                key: value.clone(),
                is_text: *action == NativeKeyboardAction::Type,
                action: v1::KeyAction::Press as i32,
            }),
        )]),
        NativeAction::Clipboard { operation, text } => {
            validate_clipboard_payload(*operation, text.as_deref())?;
            let key = match operation {
                NativeClipboardAction::Copy => "Control+c",
                NativeClipboardAction::Paste => "Control+v",
                NativeClipboardAction::Write | NativeClipboardAction::Clear => {
                    return Err(NativeAdapterError::unsupported(
                        "clipboard storage mutations are not X11 key input",
                    ));
                }
            };
            Ok(vec![desktop_input(v1::desktop_input::Event::Key(
                v1::KeyEvent {
                    key: key.to_string(),
                    is_text: false,
                    action: v1::KeyAction::Press as i32,
                },
            ))])
        }
        NativeAction::Semantic { .. }
        | NativeAction::Focus { .. }
        | NativeAction::Launch { .. } => Err(NativeAdapterError::unsupported(
            "action is not an X11 screen input",
        )),
    }
}

fn validate_clipboard_payload(
    operation: NativeClipboardAction,
    text: Option<&str>,
) -> NativeAdapterResult<()> {
    if (operation == NativeClipboardAction::Write) != text.is_some() {
        return Err(invalid_action(
            "native clipboard text is required exactly for write",
        ));
    }
    if text.is_some_and(|value| value.len() > 1024 * 1024) {
        return Err(invalid_action(
            "native clipboard text exceeds its UTF-8 byte envelope",
        ));
    }
    Ok(())
}

fn pointer_input(
    x: i32,
    y: i32,
    action: v1::PointerAction,
    button: v1::PointerButton,
) -> v1::DesktopInput {
    desktop_input(v1::desktop_input::Event::Pointer(v1::PointerEvent {
        x,
        y,
        action: action as i32,
        button: button as i32,
    }))
}

fn desktop_input(event: v1::desktop_input::Event) -> v1::DesktopInput {
    v1::DesktopInput {
        channel_id: String::new(),
        event: Some(event),
    }
}

fn checked_i32(value: f64, label: &str) -> NativeAdapterResult<i32> {
    if !value.is_finite() || value < f64::from(i32::MIN) || value > f64::from(i32::MAX) {
        return Err(invalid_action(format!(
            "{label} is outside the native input range"
        )));
    }
    #[allow(clippy::cast_possible_truncation)]
    Ok(value.round() as i32)
}

fn invalid_action(message: impl Into<String>) -> NativeAdapterError {
    NativeAdapterError::definite(NativeAdapterErrorCode::InvalidAction, message, false)
}

fn null_object() -> NativeAdapterError {
    NativeAdapterError::definite(
        NativeAdapterErrorCode::DriverFailed,
        "AT-SPI returned a null accessible object",
        true,
    )
}

fn stable_digest(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    hex::encode(&digest[..12])
}

fn first_nonempty(values: &[&str]) -> Option<String> {
    values
        .iter()
        .find(|value| !value.trim().is_empty())
        .map(|value| (*value).to_string())
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

async fn timed<T, E>(future: impl Future<Output = Result<T, E>>) -> Result<T, E>
where
    E: From<atspi::zbus::Error>,
{
    match tokio::time::timeout(NATIVE_CALL_TIMEOUT, future).await {
        Ok(result) => result,
        Err(_) => Err(atspi::zbus::Error::Failure(
            "native accessibility call timed out".to_string(),
        )
        .into()),
    }
}

async fn cache_call<T>(
    future: impl Future<Output = atspi::zbus::Result<T>>,
) -> atspi::zbus::Result<T> {
    match tokio::time::timeout(CACHE_TIMEOUT, future).await {
        Ok(result) => result,
        Err(_) => Err(atspi::zbus::Error::Failure(
            "AT-SPI cache snapshot timed out".to_string(),
        )),
    }
}

fn is_signature_mismatch(error: &atspi::zbus::Error) -> bool {
    matches!(
        error,
        atspi::zbus::Error::Variant(zvariant::Error::SignatureMismatch(_, _))
    )
}

fn driver_error(context: &str, error: impl std::fmt::Display) -> NativeAdapterError {
    NativeAdapterError::definite(
        NativeAdapterErrorCode::DriverFailed,
        format!("{context}: {error}"),
        true,
    )
}

fn ambiguous(context: &str, error: impl std::fmt::Display) -> NativeAdapterError {
    NativeAdapterError::outcome_unknown(format!(
        "{context} outcome could not be confirmed: {error}"
    ))
}

#[cfg(test)]
mod live_tests {
    use std::time::{Duration, Instant};

    use tokio::io::{AsyncBufReadExt as _, BufReader};
    use tokio::process::Command;

    use super::*;

    fn native_window(process_id: Option<u32>, title: &str, bounds: NativeRect) -> NativeTarget {
        NativeTarget {
            id: "window:test".to_string(),
            target_generation: "g_test".to_string(),
            kind: NativeTargetKind::Window,
            application_id: None,
            process_id,
            title: title.to_string(),
            bounds: Some(bounds),
            focused: false,
        }
    }

    fn x11_window(id: u32, process_id: Option<u32>, title: &str, x: i32) -> LinuxWindow {
        LinuxWindow {
            id,
            process_id,
            title: title.to_string(),
            bounds: LinuxWindowRect {
                x,
                y: 20,
                width: 420,
                height: 180,
            },
        }
    }

    #[test]
    fn live_frame_encoding_downscales_jpeg_without_changing_aspect_ratio() {
        let frame = LinuxRgbaFrame {
            rgba: vec![255_u8; 1_280 * 800 * 4],
            width: 1_280,
            height: 800,
        };
        let options = crate::NativeCaptureOptions {
            format: crate::NativeFrameFormat::Jpeg,
            quality: 72,
            max_width: 720,
            max_height: 720,
        };

        let (width, height, mime_type, bytes) =
            encode_live_frame(&frame, options).expect("encode compact Linux live frame");

        assert_eq!((width, height), (720, 450));
        assert_eq!(mime_type, "image/jpeg");
        let decoded = image::load_from_memory(&bytes).expect("decode JPEG");
        assert_eq!((decoded.width(), decoded.height()), (720, 450));
    }

    #[test]
    fn live_frame_encoding_preserves_bounded_png_geometry() {
        let frame = LinuxRgbaFrame {
            rgba: vec![128_u8; 640 * 360 * 4],
            width: 640,
            height: 360,
        };
        let options = crate::NativeCaptureOptions {
            format: crate::NativeFrameFormat::Png,
            quality: 80,
            max_width: 720,
            max_height: 720,
        };

        let (width, height, mime_type, bytes) =
            encode_live_frame(&frame, options).expect("encode bounded Linux live frame");

        assert_eq!((width, height), (640, 360));
        assert_eq!(mime_type, "image/png");
        let decoded = image::load_from_memory(&bytes).expect("decode PNG");
        assert_eq!((decoded.width(), decoded.height()), (640, 360));
    }

    #[test]
    fn x11_correlation_uses_pid_then_title_and_geometry_without_guessing() {
        let target = native_window(
            Some(42),
            "Editor — notes",
            NativeRect {
                x: 510.0,
                y: 20.0,
                width: 420.0,
                height: 180.0,
            },
        );
        let windows = vec![
            x11_window(1, Some(42), "Editor — settings", 10),
            x11_window(2, Some(42), " Editor   — NOTES ", 510),
            x11_window(3, Some(7), "Editor — notes", 510),
        ];
        assert_eq!(
            correlate_x11_window(&target, &windows).map(|w| w.id),
            Some(2)
        );

        let ambiguous = native_window(Some(42), "Editor", target.bounds.expect("bounds"));
        let duplicates = vec![
            x11_window(4, Some(42), "Editor", 510),
            x11_window(5, Some(42), "Editor", 510),
        ];
        assert!(correlate_x11_window(&ambiguous, &duplicates).is_none());
    }

    #[test]
    fn x11_correlation_without_pid_requires_a_unique_title() {
        let target = native_window(
            None,
            "Workspace",
            NativeRect {
                x: 10.0,
                y: 20.0,
                width: 420.0,
                height: 180.0,
            },
        );
        assert_eq!(
            correlate_x11_window(
                &target,
                &[
                    x11_window(9, None, "other", 10),
                    x11_window(10, None, "Workspace", 10),
                ],
            )
            .map(|window| window.id),
            Some(10)
        );
        assert!(correlate_x11_window(
            &target,
            &[
                x11_window(10, None, "Workspace", 10),
                x11_window(11, None, "Workspace", 10),
            ],
        )
        .is_none());
    }

    const GTK_FIXTURE: &str = r"
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk

window = Gtk.Window(title='OpenGeni AT-SPI Fixture')
window.set_default_size(420, 180)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
window.add(box)
entry = Gtk.Entry()
entry.get_accessible().set_name('Fixture input')
button = Gtk.Button(label='Apply')
status = Gtk.Label(label='Ready')
status.get_accessible().set_name('Fixture status')
button.connect('clicked', lambda _button: status.set_text('Applied: ' + entry.get_text()))
box.pack_start(entry, True, True, 0)
box.pack_start(button, True, True, 0)
box.pack_start(status, True, True, 0)
window.connect('destroy', Gtk.main_quit)
window.show_all()
print('READY', flush=True)
Gtk.main()
";

    const GTK_OCCLUDER: &str = r"
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk

window = Gtk.Window(title='OpenGeni X11 Occluder')
window.set_default_size(420, 180)
window.set_decorated(False)
window.move(0, 0)
area = Gtk.EventBox()
area.override_background_color(Gtk.StateFlags.NORMAL, Gdk.RGBA(0.9, 0.1, 0.1, 1.0))
window.add(area)
window.connect('destroy', Gtk.main_quit)
window.show_all()
print('READY', flush=True)
Gtk.main()
";

    #[tokio::test]
    #[ignore = "requires an isolated X11 seat, AT-SPI bus, GTK 3 and python3-gi"]
    #[allow(clippy::too_many_lines)]
    async fn controls_live_gtk_through_atspi_and_rejects_stale_refs() {
        let mut fixture = Command::new("python3")
            .args(["-c", GTK_FIXTURE])
            .env("NO_AT_BRIDGE", "0")
            .env("GTK_MODULES", "gail:atk-bridge")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .expect("launch GTK accessibility fixture");
        let stdout = fixture.stdout.take().expect("fixture stdout");
        let ready = BufReader::new(stdout)
            .lines()
            .next_line()
            .await
            .expect("read fixture readiness")
            .expect("fixture readiness line");
        assert_eq!(ready, "READY");

        let adapter = AtspiComputerAdapter::open()
            .await
            .expect("open AT-SPI adapter");
        let deadline = Instant::now() + Duration::from_secs(10);
        let (target, screen) = loop {
            let targets = adapter.targets().await.expect("enumerate AT-SPI targets");
            let target = targets
                .iter()
                .find(|target| {
                    target.kind == NativeTargetKind::Window
                        && target.title == "OpenGeni AT-SPI Fixture"
                })
                .cloned();
            let screen = targets
                .iter()
                .find(|target| target.kind == NativeTargetKind::Screen)
                .cloned();
            if let (Some(target), Some(screen)) = (target, screen) {
                break (target, screen);
            }
            assert!(
                Instant::now() < deadline,
                "fixture window never reached AT-SPI; last targets: {targets:#?}"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        };

        let initial = adapter.observe(&target.id).await.expect("observe fixture");
        let entry_ref = find_ref(&initial.roots, "Fixture input").expect("entry ref");
        let set_value = command(
            &initial,
            entry_ref.clone(),
            NativeSemanticAction::SetValue,
            Some(NativeActionValue::String("hello from AT-SPI".to_string())),
        );
        let after_value = adapter
            .dispatch(&set_value)
            .await
            .expect("set entry value")
            .expect("semantic set-value returns a settlement observation");
        assert!(has_text(&after_value.roots, "hello from AT-SPI"));

        let stale = command(&initial, entry_ref, NativeSemanticAction::Focus, None);
        let stale_error = adapter
            .validate(&stale)
            .await
            .expect_err("old observation ref must be stale");
        assert_eq!(stale_error.code, NativeAdapterErrorCode::ObservationStale);

        let apply_ref = find_ref(&after_value.roots, "Apply").expect("button ref");
        let invoke = command(&after_value, apply_ref, NativeSemanticAction::Invoke, None);
        let after_invoke = adapter
            .dispatch(&invoke)
            .await
            .expect("invoke button")
            .expect("semantic invoke returns a settlement observation");
        assert!(
            has_text(&after_invoke.roots, "Applied: hello from AT-SPI"),
            "updated label absent from observation: {:#?}",
            after_invoke.roots
        );

        let entry_ref = find_ref(&after_invoke.roots, "Fixture input").expect("fresh entry ref");
        let set_pixel_value = command(
            &after_invoke,
            entry_ref,
            NativeSemanticAction::SetValue,
            Some(NativeActionValue::String("hello from XTEST".to_string())),
        );
        let after_pixel_value = adapter
            .dispatch(&set_pixel_value)
            .await
            .expect("set value before pixel click")
            .expect("semantic set-value returns a settlement observation");
        let button_bounds = find_bounds(&after_pixel_value.roots, "Apply").expect("button bounds");
        let window_bounds = after_pixel_value
            .target
            .bounds
            .expect("fixture window bounds");
        assert!(adapter.capabilities().window_capture);
        let frame = adapter
            .capture(&target.id)
            .await
            .expect("capture correlated X11 window");
        assert_eq!(frame.target_id, target.id);
        assert_eq!((frame.width, frame.height), (420, 180));
        assert!(frame.bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        let click = pointer_command(
            &target,
            &frame,
            button_bounds.x - window_bounds.x + button_bounds.width / 2.0,
            button_bounds.y - window_bounds.y + button_bounds.height / 2.0,
        );
        adapter
            .dispatch(&click)
            .await
            .expect("click GTK button through window-relative XTEST");
        tokio::time::sleep(Duration::from_millis(50)).await;
        let after_pixel = adapter
            .observe(&target.id)
            .await
            .expect("observe XTEST result");
        assert!(has_text(&after_pixel.roots, "Applied: hello from XTEST"));

        let newer_frame = adapter
            .capture(&target.id)
            .await
            .expect("capture newer X11 window frame");
        assert_ne!(newer_frame.frame_id, frame.frame_id);

        let mut occluder = Command::new("python3")
            .args(["-c", GTK_OCCLUDER])
            .env("NO_AT_BRIDGE", "0")
            .env("GTK_MODULES", "gail:atk-bridge")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .expect("launch GTK occluder");
        let occluder_stdout = occluder.stdout.take().expect("occluder stdout");
        let occluder_ready = BufReader::new(occluder_stdout)
            .lines()
            .next_line()
            .await
            .expect("read occluder readiness")
            .expect("occluder readiness line");
        assert_eq!(occluder_ready, "READY");
        tokio::time::sleep(Duration::from_millis(50)).await;
        let covered_screen = adapter
            .capture(&screen.id)
            .await
            .expect("capture screen with X11 occluder");
        let (screen_red, screen_sampled) = red_pixels(&covered_screen.bytes, 420, 180);
        assert!(
            screen_red * 10 > screen_sampled * 8,
            "the root capture must prove the red window actually covers the fixture"
        );
        let occluded_frame = adapter
            .capture(&target.id)
            .await
            .expect("capture fixture through an occluding X11 window");
        let (window_red, window_sampled) = red_pixels(
            &occluded_frame.bytes,
            occluded_frame.width,
            occluded_frame.height,
        );
        assert!(
            window_red * 10 < window_sampled,
            "Composite capture must read the fixture backing pixmap, not the red root pixels"
        );
        let stale_frame = adapter
            .validate(&click)
            .await
            .expect_err("old pixel frame must be stale");
        assert_eq!(stale_frame.code, NativeAdapterErrorCode::FrameStale);

        let screen_frame = adapter
            .capture(&screen.id)
            .await
            .expect("capture X11 screen fallback");
        assert_eq!((screen_frame.width, screen_frame.height), (1280, 800));
        assert!(screen_frame.bytes.starts_with(b"\x89PNG\r\n\x1a\n"));

        occluder.kill().await.expect("stop GTK occluder");
        occluder.wait().await.expect("reap GTK occluder");

        fixture.kill().await.expect("stop GTK fixture");
        fixture.wait().await.expect("reap GTK fixture");
    }

    fn command(
        observation: &NativeObservation,
        r#ref: String,
        action: NativeSemanticAction,
        value: Option<NativeActionValue>,
    ) -> NativeActionCommand {
        NativeActionCommand {
            target_id: observation.target.id.clone(),
            expected_target_generation: observation.target.target_generation.clone(),
            expected_observation_id: Some(observation.observation_id.clone()),
            expected_frame_id: None,
            action: NativeAction::Semantic {
                locator: NativeLocator::Ref { r#ref },
                action,
                value,
            },
        }
    }

    fn pointer_command(
        screen: &NativeTarget,
        frame: &NativeCapturedFrame,
        x: f64,
        y: f64,
    ) -> NativeActionCommand {
        NativeActionCommand {
            target_id: screen.id.clone(),
            expected_target_generation: frame.target_generation.clone(),
            expected_observation_id: None,
            expected_frame_id: Some(frame.frame_id.clone()),
            action: NativeAction::Pointer {
                frame_id: frame.frame_id.clone(),
                action: NativePointerAction::Click,
                x,
                y,
                end_x: None,
                end_y: None,
                delta_x: None,
                delta_y: None,
                button: Some(NativePointerButton::Left),
            },
        }
    }

    fn find_ref(nodes: &[crate::NativeSemanticNode], name: &str) -> Option<String> {
        for node in nodes {
            if node.name.as_deref() == Some(name) {
                return Some(node.r#ref.clone());
            }
            if let Some(found) = find_ref(&node.children, name) {
                return Some(found);
            }
        }
        None
    }

    fn find_bounds(nodes: &[crate::NativeSemanticNode], name: &str) -> Option<NativeRect> {
        for node in nodes {
            if node.name.as_deref() == Some(name) {
                return node.bounds;
            }
            if let Some(found) = find_bounds(&node.children, name) {
                return Some(found);
            }
        }
        None
    }

    fn has_text(nodes: &[crate::NativeSemanticNode], expected: &str) -> bool {
        nodes.iter().any(|node| {
            node.name.as_deref() == Some(expected)
                || matches!(&node.value, Some(NativeNodeValue::Text(value)) if value == expected)
                || has_text(&node.children, expected)
        })
    }

    fn red_pixels(png: &[u8], width: u32, height: u32) -> (usize, usize) {
        let image = image::load_from_memory(png)
            .expect("decode captured PNG")
            .to_rgb8();
        let mut red = 0usize;
        let mut sampled = 0usize;
        for (x, y, pixel) in image.enumerate_pixels() {
            if x >= width || y >= height {
                continue;
            }
            sampled += 1;
            if pixel[0] > 180 && pixel[1] < 80 && pixel[2] < 80 {
                red += 1;
            }
        }
        assert!(sampled > 0, "captured PNG sample must not be empty");
        (red, sampled)
    }
}
