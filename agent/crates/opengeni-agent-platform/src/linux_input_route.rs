//! Preflight the actual XTEST device route on a fresh, server-guarded connection.
//! Core focus alone does not exclude active or passive grabs by another client.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use x11rb::connection::{Connection as _, RequestConnection as _};
use x11rb::protocol::res::ConnectionExt as _;
use x11rb::protocol::xproto::{ConnectionExt as _, GrabMode, GrabStatus, ModMask, Window};
use x11rb::protocol::{xinput as xi, xkb};
use x11rb::rust_connection::RustConnection;
use x11rb::x11_utils::Serialize as _;

use super::{PreparedInput, KEY_PRESS, KEY_RELEASE};
use crate::error::{PlatformError, PlatformResult};

const MAX_EVENTS: usize = 1_024;
const MAX_ROUTE_WINDOWS: usize = 64;
const MAX_DEVICES: usize = 32;
const MAX_PROBE_REQUESTS: usize = 4_096;
const DELIVERY_LIMIT: Duration = Duration::from_secs(2);

fn unavailable(reason: impl std::fmt::Display) -> PlatformError {
    PlatformError::Unsupported(format!("X11 window input route is not verified: {reason}"))
}

// Bound expansion before loading a keymap or allocating a prepared batch.
pub(super) fn validate_input_size(
    inputs: &[opengeni_agent_proto::v1::DesktopInput],
) -> PlatformResult<()> {
    use opengeni_agent_proto::v1::desktop_input::Event;
    let mut count = 0_usize;
    for input in inputs.iter().take(MAX_EVENTS + 1) {
        let size = match input.event.as_ref() {
            Some(Event::Key(key)) if key.is_text => key
                .key
                .chars()
                .take(MAX_EVENTS + 1)
                .count()
                .saturating_mul(4),
            Some(Event::Key(key)) => {
                if key.key.len() > 128 {
                    return Err(unavailable("named key exceeds its bound"));
                }
                key.key.split('+').count().saturating_mul(2)
            }
            Some(Event::Pointer(_)) => 5,
            Some(Event::Scroll(_)) => 1 + 4 * super::MAX_SCROLL_CLICKS as usize,
            None => return Err(unavailable("input event is absent")),
        };
        count = count.saturating_add(size);
        if count > MAX_EVENTS {
            return Err(unavailable("input batch exceeds its bound"));
        }
    }
    if inputs.len() > MAX_EVENTS {
        return Err(unavailable("input batch exceeds its bound"));
    }
    Ok(())
}

/// Socket shutdown wakes a blocking reader and causes the server to release
/// this connection's grabs. The duplicated descriptor is never used for input.
pub(super) struct DeliveryDeadline {
    started: Instant,
    cancel: Option<mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<bool>>,
}

impl DeliveryDeadline {
    pub(super) fn start(conn: &RustConnection) -> PlatformResult<Self> {
        let socket = rustix::io::dup(conn.stream())
            .map_err(|error| unavailable(format!("delivery deadline socket: {error}")))?;
        let (cancel, waiting) = mpsc::channel();
        let started = Instant::now();
        let thread = std::thread::Builder::new()
            .name("x11-input-deadline".into())
            .spawn(move || match waiting.recv_timeout(DELIVERY_LIMIT) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => false,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let _ = rustix::net::shutdown(&socket, rustix::net::Shutdown::Both);
                    true
                }
            })
            .map_err(|error| unavailable(format!("delivery deadline task: {error}")))?;
        Ok(Self {
            started,
            cancel: Some(cancel),
            thread: Some(thread),
        })
    }

    pub(super) fn finish(mut self) -> PlatformResult<()> {
        let elapsed = self.started.elapsed();
        let expired = self.stop();
        if expired || elapsed >= DELIVERY_LIMIT {
            Err(unavailable("delivery deadline expired"))
        } else {
            Ok(())
        }
    }

    fn stop(&mut self) -> bool {
        if let Some(cancel) = self.cancel.take() {
            let _ = cancel.send(());
        }
        self.thread
            .take()
            .is_some_and(|thread| thread.join().unwrap_or(true))
    }
}

impl Drop for DeliveryDeadline {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Clone, Copy, Debug)]
enum Event {
    Motion(i32, i32),
    Key(u8, bool),
    Button(u8, bool),
}

fn events(inputs: &[PreparedInput]) -> PlatformResult<Vec<Event>> {
    use opengeni_agent_proto::v1::PointerAction;
    let mut result = Vec::new();
    if inputs.len() > MAX_EVENTS {
        return Err(unavailable("input batch exceeds its bound"));
    }
    for input in inputs {
        match input {
            PreparedInput::Key { events, .. } => {
                for &(kind, key) in events {
                    if kind != KEY_PRESS && kind != KEY_RELEASE {
                        return Err(unavailable("unsupported key event"));
                    }
                    result.push(Event::Key(key, kind == KEY_PRESS));
                }
            }
            PreparedInput::Pointer(pointer) => {
                result.push(Event::Motion(pointer.x, pointer.y));
                let button = super::x_button_code(pointer.button());
                match pointer.action() {
                    PointerAction::Move | PointerAction::Unspecified => (),
                    PointerAction::Click => {
                        result.extend([Event::Button(button, true), Event::Button(button, false)]);
                    }
                    PointerAction::DoubleClick => {
                        for _ in 0..2 {
                            result.extend([
                                Event::Button(button, true),
                                Event::Button(button, false),
                            ]);
                        }
                    }
                    PointerAction::Down => result.push(Event::Button(button, true)),
                    PointerAction::Up => result.push(Event::Button(button, false)),
                }
            }
            PreparedInput::Scroll(scroll) => {
                result.push(Event::Motion(scroll.x, scroll.y));
                for (delta, negative, positive) in [(scroll.delta_y, 4, 5), (scroll.delta_x, 6, 7)]
                {
                    let clicks = delta.unsigned_abs().min(super::MAX_SCROLL_CLICKS);
                    for _ in 0..clicks {
                        let button = if delta < 0 { negative } else { positive };
                        result.extend([Event::Button(button, true), Event::Button(button, false)]);
                    }
                }
            }
        }
        if result.len() > MAX_EVENTS {
            return Err(unavailable("input batch exceeds its bound"));
        }
    }
    Ok(result)
}

#[derive(Debug, PartialEq, Eq)]
struct Devices {
    pointer: u16,
    keyboard: u16,
    test_pointer: u8,
    test_keyboard: u8,
    keyboards: Vec<u8>,
    topology: Vec<(u16, u16, u16, bool)>,
}

// Keep the bounded topology, marker and keyboard-class census together:
// filtering before the full census would hide invalid XTEST devices.
#[allow(clippy::too_many_lines)]
fn devices(conn: &RustConnection) -> PlatformResult<Devices> {
    let version = xi::xi_query_version(conn, 2, 0)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?;
    if version.major_version < 2 {
        return Err(unavailable("XInput 2 is unavailable"));
    }
    let pointer = xi::xi_get_client_pointer(conn, x11rb::NONE)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?
        .deviceid;
    let infos = xi::xi_query_device(conn, 0_u16)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?
        .infos;
    if infos.len() > MAX_DEVICES {
        return Err(unavailable("device topology exceeds its bound"));
    }
    // Core delivery is client-pointer dependent. Do not infer its recipients
    // from aggregate window masks when clients can use another master pair.
    if infos
        .iter()
        .filter(|info| info.enabled && info.type_ == xi::DeviceType::MASTER_POINTER)
        .count()
        != 1
        || infos
            .iter()
            .filter(|info| info.enabled && info.type_ == xi::DeviceType::MASTER_KEYBOARD)
            .count()
            != 1
    {
        return Err(unavailable(
            "multiple master pairs have ambiguous core recipients",
        ));
    }
    let master = infos
        .iter()
        .find(|info| {
            info.deviceid == pointer && info.enabled && info.type_ == xi::DeviceType::MASTER_POINTER
        })
        .ok_or_else(|| unavailable("client pointer is not an enabled master"))?;
    let keyboard = master.attachment;
    if !infos.iter().any(|info| {
        info.enabled
            && info.deviceid == keyboard
            && info.attachment == pointer
            && info.type_ == xi::DeviceType::MASTER_KEYBOARD
    }) {
        return Err(unavailable("client pointer keyboard pairing changed"));
    }
    let property = conn
        .intern_atom(true, b"XTEST Device")
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?
        .atom;
    if property == x11rb::NONE {
        return Err(unavailable("XTEST device identity is unavailable"));
    }
    let mut test_pointer = Vec::new();
    let mut test_keyboard = Vec::new();
    let mut keyboards = Vec::new();
    let mut topology = Vec::new();
    for info in infos {
        topology.push((
            info.deviceid,
            info.type_.into(),
            info.attachment,
            info.enabled,
        ));
        let id = u8::try_from(info.deviceid)
            .map_err(|_| unavailable("device id is outside the XI1 range"))?;
        if info.type_ == xi::DeviceType::MASTER_KEYBOARD
            || info.type_ == xi::DeviceType::SLAVE_KEYBOARD
        {
            if id == 255 {
                return Err(unavailable("reserved modifier-device id"));
            }
            keyboards.push(id);
        }
        let identity = xi::xi_get_property(conn, info.deviceid, false, property, x11rb::NONE, 0, 1)
            .map_err(unavailable)?
            .reply()
            .map_err(unavailable)?;
        // Native XTEST devices have an immutable marker. The same property is
        // forgeable on ordinary devices: census every marked device before
        // filtering, so a floated native device cannot be hidden by a forgery.
        let is_test = identity.type_ == u32::from(x11rb::protocol::xproto::AtomEnum::INTEGER)
            && identity.bytes_after == 0
            && identity.num_items == 1
            && matches!(identity.items, xi::XIGetPropertyItems::Data8(ref data) if data.as_slice() == [1]);
        if !is_test {
            continue;
        }
        if !info.enabled
            || (info.type_ != xi::DeviceType::SLAVE_POINTER
                && info.type_ != xi::DeviceType::SLAVE_KEYBOARD)
        {
            return Err(unavailable(
                "marked XTEST device is disabled, floating or not a slave",
            ));
        }
        if info.type_ == xi::DeviceType::SLAVE_POINTER && info.attachment == pointer {
            if info.classes.iter().any(|class| matches!(&class.data, xi::DeviceClassData::Button(buttons) if buttons.state.iter().any(|bits| *bits != 0))) {
                return Err(unavailable("XTEST pointer already has a held button"));
            }
            test_pointer.push(id);
        }
        if info.type_ == xi::DeviceType::SLAVE_KEYBOARD && info.attachment == keyboard {
            test_keyboard.push(id);
        }
    }
    if test_pointer.len() != 1 || test_keyboard.len() != 1 {
        return Err(unavailable("XTEST device pairing is ambiguous"));
    }
    // XI1 allows any KeyClass modifier device, including floating or disabled
    // keyboards. XI2 enabled/master/slave filtering is not a complete census.
    let legacy = xi::list_input_devices(conn)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?;
    if legacy.devices.len() > MAX_DEVICES {
        return Err(unavailable("XI1 device census exceeds its bound"));
    }
    let mut offset = 0_usize;
    for info in &legacy.devices {
        let end = offset + usize::from(info.num_class_info);
        let classes = legacy
            .infos
            .get(offset..end)
            .ok_or_else(|| unavailable("XI1 class census is incomplete"))?;
        offset = end;
        if classes
            .iter()
            .any(|class| matches!(class.info, xi::InputInfoInfo::Key(_)))
        {
            if info.device_id == 255 {
                return Err(unavailable("reserved modifier-device id"));
            }
            keyboards.push(info.device_id);
        }
    }
    if offset != legacy.infos.len() {
        return Err(unavailable("XI1 class census has trailing entries"));
    }
    topology.sort_unstable();
    keyboards.sort_unstable();
    keyboards.dedup();
    Ok(Devices {
        pointer,
        keyboard,
        test_pointer: test_pointer[0],
        test_keyboard: test_keyboard[0],
        keyboards,
        topology,
    })
}

fn state(conn: &RustConnection, device: u16) -> PlatformResult<xkb::GetStateReply> {
    xkb::get_state(conn, device)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)
}

fn neutral_state(state: &xkb::GetStateReply) -> bool {
    u16::from(state.mods) == 0
        && u16::from(state.base_mods) == 0
        && u16::from(state.latched_mods) == 0
        && u16::from(state.locked_mods) == 0
        && u16::from(state.grab_mods) == 0
        && u16::from(state.compat_grab_mods) == 0
        && u16::from(state.lookup_mods) == 0
        && u16::from(state.compat_lookup_mods) == 0
        && u8::from(state.group) == 0
        && state.base_group == 0
        && state.latched_group == 0
        && u8::from(state.locked_group) == 0
        && u16::from(state.ptr_btn_state) == 0
}

// Validate the complete wire action range and its modifier interpretation in
// one pass before any action is accepted.
#[allow(clippy::too_many_lines)]
fn effects(
    conn: &RustConnection,
    device: u16,
    keys: &BTreeSet<u8>,
) -> PlatformResult<BTreeMap<u8, u8>> {
    let initial = state(conn, device)?;
    if !neutral_state(&initial) {
        return Err(unavailable(
            "keyboard has held, locked, latched or grouped input",
        ));
    }
    let controls = xkb::get_controls(conn, device)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?;
    // Dormant acceleration, feedback and neutral IgnoreGroupLock are ordinary
    // defaults. Reject active filtering/redirecting controls, not their options.
    let unsafe_controls = u32::from(
        xkb::BoolCtrl::SLOW_KEYS
            | xkb::BoolCtrl::BOUNCE_KEYS
            | xkb::BoolCtrl::STICKY_KEYS
            | xkb::BoolCtrl::MOUSE_KEYS
            | xkb::BoolCtrl::ACCESS_X_KEYS
            | xkb::BoolCtrl::OVERLAY1_MASK
            | xkb::BoolCtrl::OVERLAY2_MASK,
    );
    // A previously armed timeout may fire even after its enable bit is cleared.
    // Its stored target must not enable a filter or re-enable suppressed repeat.
    let timeout_values =
        u32::from(controls.access_x_timeout_values) & u32::from(controls.access_x_timeout_mask);
    let timeout_target = (u32::from(controls.enabled_controls)
        & !u32::from(controls.access_x_timeout_mask))
        | timeout_values;
    if u32::from(controls.enabled_controls) & unsafe_controls != 0
        || timeout_target & unsafe_controls != 0
        || timeout_values & u32::from(xkb::BoolCtrl::REPEAT_KEYS) != 0
        || u16::from(controls.internal_mods_mask) != 0
    {
        return Err(unavailable("keyboard controls change the input route"));
    }
    let compat = xkb::get_compat_map(conn, device, xkb::SetOfGroup::from(1_u8), false, 0, 0)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?;
    if compat.group_rtrn.len() != 1 || u16::from(compat.group_rtrn[0].mask) != 0 {
        return Err(unavailable(
            "keyboard compatibility modifiers are not neutral",
        ));
    }
    let parts =
        xkb::MapPart::KEY_ACTIONS | xkb::MapPart::KEY_BEHAVIORS | xkb::MapPart::MODIFIER_MAP;
    let mapping = xkb::get_map(
        conn,
        device,
        parts,
        xkb::MapPart::from(0_u16),
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        xkb::VMod::from(0_u16),
        0,
        0,
        0,
        0,
        0,
        0,
    )
    .map_err(unavailable)?
    .reply()
    .map_err(unavailable)?;
    let modifier_map = mapping
        .map
        .modmap_rtrn
        .as_ref()
        .ok_or_else(|| unavailable("modifier map is absent"))?
        .iter()
        .map(|item| {
            u8::try_from(u16::from(item.mods))
                .map(|mods| (item.keycode, mods))
                .map_err(unavailable)
        })
        .collect::<PlatformResult<BTreeMap<_, _>>>()?;
    let behaviors = mapping
        .map
        .behaviors_rtrn
        .as_ref()
        .ok_or_else(|| unavailable("key behaviors are absent"))?;
    if behaviors.iter().any(|item| {
        keys.contains(&item.keycode)
            && item.behavior.as_common().type_ != u8::from(xkb::BehaviorType::DEFAULT)
    }) {
        return Err(unavailable("key behavior changes the input route"));
    }
    let actions = mapping
        .map
        .key_actions
        .as_ref()
        .ok_or_else(|| unavailable("key actions are absent"))?;
    if actions.acts_rtrn_count.len() != usize::from(mapping.n_key_actions) {
        return Err(unavailable("key-action map is incomplete"));
    }
    let mut offset = 0_usize;
    let mut result = BTreeMap::new();
    for (index, &count) in actions.acts_rtrn_count.iter().enumerate() {
        let key = usize::from(mapping.first_key_action) + index;
        let end = offset
            .checked_add(usize::from(count))
            .ok_or_else(|| unavailable("key-action count overflow"))?;
        let choices = actions
            .acts_rtrn_acts
            .get(offset..end)
            .ok_or_else(|| unavailable("key-action map is truncated"))?;
        offset = end;
        let Ok(key) = u8::try_from(key) else {
            return Err(unavailable("key-action range is invalid"));
        };
        if !keys.contains(&key) {
            continue;
        }
        let modifier = modifier_map.get(&key).copied().unwrap_or(0);
        let mut action_effect = None;
        for action in choices {
            let kind = action.as_noaction().type_;
            let effect = if kind == xkb::SAType::NO_ACTION {
                0
            } else if kind == xkb::SAType::SET_MODS {
                let mods = action.as_setmods();
                let mask = if u8::from(mods.flags) & u8::from(xkb::SA::USE_MOD_MAP_MODS) != 0 {
                    modifier
                } else {
                    u8::try_from(u16::from(mods.mask)).map_err(unavailable)?
                };
                if mask != modifier
                    || u8::from(mods.vmods_high) != 0
                    || u8::from(mods.vmods_low) != 0
                    || u8::from(mods.flags)
                        & !(u8::from(xkb::SA::USE_MOD_MAP_MODS) | u8::from(xkb::SA::CLEAR_LOCKS))
                        != 0
                {
                    return Err(unavailable("key modifier action is not modeled"));
                }
                mask
            } else {
                return Err(unavailable("key action redirects or changes input"));
            };
            if action_effect.is_some_and(|previous| previous != effect) {
                return Err(unavailable("key action differs between levels"));
            }
            action_effect = Some(effect);
        }
        let effect = action_effect.unwrap_or(0);
        if effect != modifier {
            return Err(unavailable("key action and modifier map disagree"));
        }
        result.insert(key, effect);
    }
    if offset != actions.acts_rtrn_acts.len() || !keys.iter().all(|key| result.contains_key(key)) {
        return Err(unavailable("requested key-action range is incomplete"));
    }
    Ok(result)
}

fn controls_bytes(controls: &xkb::GetControlsReply, ignore_repeat: bool) -> [u8; 92] {
    let mut value = *controls;
    value.sequence = 0;
    if ignore_repeat {
        value.enabled_controls = xkb::BoolCtrl::from(
            u32::from(value.enabled_controls) & !u32::from(xkb::BoolCtrl::REPEAT_KEYS),
        );
    }
    value.serialize()
}

fn set_repeat(conn: &RustConnection, device: u16, enabled: bool) -> PlatformResult<()> {
    let request = xkb::SetControlsRequest {
        device_spec: device,
        affect_enabled_controls: xkb::BoolCtrl::REPEAT_KEYS,
        enabled_controls: if enabled {
            xkb::BoolCtrl::REPEAT_KEYS
        } else {
            xkb::BoolCtrl::default()
        },
        change_controls: xkb::Control::CONTROLS_ENABLED,
        ..Default::default()
    };
    conn.send_trait_request_without_reply(request)
        .map_err(unavailable)?
        .check()
        .map_err(unavailable)
}

// XKB registers restoration on the server, before any control is changed.
// Socket loss or the delivery deadline therefore restores each device's
// original repeat bit; timing and per-key repeat configuration are never set.
struct RepeatGuard {
    original: Vec<(u16, xkb::GetControlsReply)>,
}

impl RepeatGuard {
    fn suspend(conn: &RustConnection, devices: &Devices) -> PlatformResult<Self> {
        let mut affected = devices
            .keyboards
            .iter()
            .copied()
            .filter(|&id| {
                u16::from(id) == devices.keyboard
                    || devices
                        .topology
                        .iter()
                        .any(|&(device, kind, attachment, enabled)| {
                            device == u16::from(id)
                                && enabled
                                && kind != u16::from(xi::DeviceType::MASTER_POINTER)
                                && kind != u16::from(xi::DeviceType::MASTER_KEYBOARD)
                                && (attachment == devices.keyboard || attachment == devices.pointer)
                        })
            })
            .map(u16::from)
            .collect::<Vec<_>>();
        affected.sort_unstable_by_key(|&id| (id != devices.keyboard, id));
        if affected.first() != Some(&devices.keyboard)
            || !affected.contains(&u16::from(devices.test_keyboard))
        {
            return Err(unavailable("repeat restoration census is incomplete"));
        }
        let original = affected
            .into_iter()
            .map(|id| {
                xkb::get_controls(conn, id)
                    .map_err(unavailable)?
                    .reply()
                    .map_err(unavailable)
                    .map(|controls| (id, controls))
            })
            .collect::<PlatformResult<Vec<_>>>()?;
        for (id, controls) in &original {
            let value = xkb::BoolCtrl::from(
                u32::from(controls.enabled_controls) & u32::from(xkb::BoolCtrl::REPEAT_KEYS),
            );
            let reply = xkb::per_client_flags(
                conn,
                *id,
                xkb::PerClientFlag::AUTO_RESET_CONTROLS,
                xkb::PerClientFlag::AUTO_RESET_CONTROLS,
                xkb::BoolCtrl::REPEAT_KEYS,
                xkb::BoolCtrl::REPEAT_KEYS,
                value,
            )
            .map_err(unavailable)?
            .reply()
            .map_err(unavailable)?;
            if u32::from(reply.supported) & u32::from(xkb::PerClientFlag::AUTO_RESET_CONTROLS) == 0
                || reply.auto_ctrls != xkb::BoolCtrl::REPEAT_KEYS
                || reply.auto_ctrls_values != value
            {
                return Err(unavailable(
                    "server did not register exact repeat restoration",
                ));
            }
        }
        // A master control change also affects its attached KeyClass devices.
        // Every such device was registered before this first mutation.
        set_repeat(conn, devices.keyboard, false)?;
        let guard = Self { original };
        guard.verify_suppressed(conn)?;
        Ok(guard)
    }

    fn verify_suppressed(&self, conn: &RustConnection) -> PlatformResult<()> {
        for (id, original) in &self.original {
            let current = xkb::get_controls(conn, *id)
                .map_err(unavailable)?
                .reply()
                .map_err(unavailable)?;
            let mut expected = *original;
            expected.enabled_controls = xkb::BoolCtrl::from(
                u32::from(expected.enabled_controls) & !u32::from(xkb::BoolCtrl::REPEAT_KEYS),
            );
            if controls_bytes(&current, false) != controls_bytes(&expected, false) {
                return Err(unavailable(
                    "repeat is not suppressed with original controls preserved",
                ));
            }
        }
        Ok(())
    }

    fn restore(self, conn: &RustConnection) -> PlatformResult<()> {
        // Master first: its restoration fans out. Then restore each slave's
        // own original bit, which can legitimately differ from the master.
        for (id, original) in &self.original {
            set_repeat(
                conn,
                *id,
                u32::from(original.enabled_controls) & u32::from(xkb::BoolCtrl::REPEAT_KEYS) != 0,
            )?;
        }
        for (id, original) in &self.original {
            let current = xkb::get_controls(conn, *id)
                .map_err(unavailable)?
                .reply()
                .map_err(unavailable)?;
            if controls_bytes(&current, false) != controls_bytes(original, false) {
                return Err(unavailable("original keyboard controls were not restored"));
            }
        }
        // Clear only our reset bit after all devices are restored and checked.
        for (id, _) in &self.original {
            let reply = xkb::per_client_flags(
                conn,
                *id,
                xkb::PerClientFlag::AUTO_RESET_CONTROLS,
                xkb::PerClientFlag::AUTO_RESET_CONTROLS,
                xkb::BoolCtrl::REPEAT_KEYS,
                xkb::BoolCtrl::default(),
                xkb::BoolCtrl::default(),
            )
            .map_err(unavailable)?
            .reply()
            .map_err(unavailable)?;
            if u32::from(reply.auto_ctrls) & u32::from(xkb::BoolCtrl::REPEAT_KEYS) != 0 {
                return Err(unavailable("repeat restoration record was not cleared"));
            }
        }
        Ok(())
    }
}

#[derive(Debug, PartialEq, Eq)]
struct SymbolRoute {
    mask: u16,
    levels: u8,
    rules: Vec<(bool, u16, u8)>,
    symbols: Vec<u32>,
    // Include unused groups and preserve rules in the immutable map proof.
    type_bytes: Vec<u8>,
    symbol_bytes: Vec<u8>,
}

impl SymbolRoute {
    fn symbol(&self, modifiers: u16) -> PlatformResult<u32> {
        let effective = modifiers & self.mask;
        let matches = self
            .rules
            .iter()
            .filter(|(active, mask, _)| *active && *mask == effective)
            .collect::<Vec<_>>();
        if matches.len() > 1 {
            return Err(unavailable("XKB level selection is ambiguous"));
        }
        let level = matches.first().map_or(0, |entry| entry.2);
        if level >= self.levels {
            return Err(unavailable("XKB level is outside the key type"));
        }
        self.symbols
            .get(usize::from(level))
            .copied()
            .filter(|symbol| *symbol != 0)
            .ok_or_else(|| unavailable("XKB key level has no symbol"))
    }
}

fn symbol_routes(
    conn: &RustConnection,
    device: u16,
    keys: &BTreeSet<u8>,
) -> PlatformResult<BTreeMap<u8, SymbolRoute>> {
    let parts = xkb::MapPart::KEY_TYPES | xkb::MapPart::KEY_SYMS;
    let map = xkb::get_map(
        conn,
        device,
        parts,
        xkb::MapPart::from(0_u16),
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        xkb::VMod::from(0_u16),
        0,
        0,
        0,
        0,
        0,
        0,
    )
    .map_err(unavailable)?
    .reply()
    .map_err(unavailable)?;
    let types = map
        .map
        .types_rtrn
        .as_ref()
        .ok_or_else(|| unavailable("XKB key types are absent"))?;
    let symbols = map
        .map
        .syms_rtrn
        .as_ref()
        .ok_or_else(|| unavailable("XKB key symbols are absent"))?;
    let mut result = BTreeMap::new();
    for &key in keys {
        let entry = usize::from(
            key.checked_sub(map.first_key_sym)
                .ok_or_else(|| unavailable("XKB key is before the symbol range"))?,
        );
        let symbol = symbols
            .get(entry)
            .ok_or_else(|| unavailable("XKB symbol range is incomplete"))?;
        // XKB stores the number of groups in the low four bits.
        if symbol.group_info.trailing_zeros() >= 4 || symbol.width == 0 {
            return Err(unavailable("XKB group zero is unavailable"));
        }
        let index = usize::from(
            symbol.kt_index[0]
                .checked_sub(map.first_type)
                .ok_or_else(|| unavailable("XKB type is before the type range"))?,
        );
        let kind = types
            .get(index)
            .ok_or_else(|| unavailable("XKB type range is incomplete"))?;
        if kind.num_levels == 0 || kind.num_levels > symbol.width {
            return Err(unavailable("XKB symbol width differs from its type"));
        }
        result.insert(
            key,
            SymbolRoute {
                mask: u16::from(kind.mods_mask),
                levels: kind.num_levels,
                rules: kind
                    .map
                    .iter()
                    .map(|entry| (entry.active, u16::from(entry.mods_mask), entry.level))
                    .collect(),
                symbols: symbol
                    .syms
                    .get(..usize::from(symbol.width))
                    .ok_or_else(|| unavailable("XKB group-zero symbols are truncated"))?
                    .to_vec(),
                type_bytes: kind.serialize(),
                symbol_bytes: symbol.serialize(),
            },
        );
    }
    Ok(result)
}

fn neutral_slave_keys(conn: &RustConnection, device: u8) -> PlatformResult<()> {
    let state = xi::query_device_state(conn, device)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?;
    let keys = state
        .classes
        .iter()
        .filter_map(|class| match &class.data {
            xi::InputStateData::Key(keys) => Some(keys),
            _ => None,
        })
        .collect::<Vec<_>>();
    if keys.len() != 1 || keys[0].num_keys == 0 || keys[0].keys.iter().any(|bits| *bits != 0) {
        return Err(unavailable("XTEST keyboard held-key state is not neutral"));
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
struct Snapshot {
    devices: Devices,
    focus: Window,
    slave_focus: Window,
    modifier_states: BTreeMap<u8, u16>,
    controls: BTreeMap<u8, [u8; 92]>,
    effects: BTreeMap<u8, u8>,
    symbols: Vec<u32>,
    symbols_per_key: u8,
    meanings: BTreeMap<u8, SymbolRoute>,
    buttons: Vec<u8>,
    master_buttons: Vec<u8>,
}

// The immutable route proof binds all bounded device state and mappings in
// the same server-guarded sequence.
#[allow(clippy::too_many_lines)]
fn snapshot(
    conn: &RustConnection,
    root: Window,
    keys: &BTreeSet<u8>,
    buttons: &BTreeSet<u8>,
) -> PlatformResult<Snapshot> {
    let devices = devices(conn)?;
    if !xkb::use_extension(conn, 1, 0)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?
        .supported
    {
        return Err(unavailable("XKB is unavailable"));
    }
    let focus = xi::xi_get_focus(conn, devices.keyboard)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?
        .focus;
    if focus
        != conn
            .get_input_focus()
            .map_err(unavailable)?
            .reply()
            .map_err(unavailable)?
            .focus
        || focus <= 1
    {
        return Err(unavailable("core and master keyboard focus disagree"));
    }
    let slave = xi::get_device_focus(conn, devices.test_keyboard)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?
        .focus;
    // PointerRoot is a normal XI1 slave default. It is admitted only into this
    // provisional snapshot: preflight must retain the empty XI1 grab before it
    // returns permission to inject. Preserve the actual value in the proof.
    let slave_focus = slave;
    if slave != 1 && slave != 3 && slave != focus {
        return Err(unavailable(
            "XTEST keyboard focus differs from the original client",
        ));
    }
    neutral_slave_keys(conn, devices.test_keyboard)?;
    if conn
        .query_keymap()
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?
        .keys
        .iter()
        .any(|bits| *bits != 0)
    {
        return Err(unavailable("keyboard already has a held key"));
    }
    let pointer = xi::xi_query_pointer(conn, root, devices.pointer)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?;
    if !pointer.same_screen || pointer.buttons.iter().any(|bits| *bits != 0) {
        return Err(unavailable("pointer already has a held button"));
    }
    let mut modifier_states = BTreeMap::new();
    let mut controls = BTreeMap::new();
    for &device in &devices.keyboards {
        modifier_states.insert(device, u16::from(state(conn, u16::from(device))?.grab_mods));
        let value = xkb::get_controls(conn, u16::from(device))
            .map_err(unavailable)?
            .reply()
            .map_err(unavailable)?;
        controls.insert(device, controls_bytes(&value, true));
    }
    let effects = effects(conn, devices.keyboard, keys)?;
    if effects != self::effects(conn, u16::from(devices.test_keyboard), keys)? {
        return Err(unavailable("XTEST and master modifier actions differ"));
    }
    let meanings = symbol_routes(conn, devices.keyboard, keys)?;
    if meanings != symbol_routes(conn, u16::from(devices.test_keyboard), keys)? {
        return Err(unavailable(
            "XTEST and master XKB key types or symbols differ",
        ));
    }
    let min = conn.setup().min_keycode;
    let count = conn
        .setup()
        .max_keycode
        .checked_sub(min)
        .and_then(|n| n.checked_add(1))
        .ok_or_else(|| unavailable("keyboard map range is invalid"))?;
    let core = conn
        .get_keyboard_mapping(min, count)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?;
    let slave = xi::get_device_key_mapping(conn, devices.test_keyboard, min, count)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?;
    if core.keysyms_per_keycode != slave.keysyms_per_keycode || core.keysyms != slave.keysyms {
        return Err(unavailable("XTEST and core symbol maps differ"));
    }
    let button_map = xi::get_device_button_mapping(conn, devices.test_pointer)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?
        .map;
    // A slave's identity mapping does not establish the master mapping. The
    // server applies both independently, including during passive-grab lookup.
    // The census above requires one master pair, so this core query is exact.
    let master_button_map = conn
        .get_pointer_mapping()
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?
        .map;
    for &button in buttons {
        if button == 0 || button_map.get(usize::from(button - 1)) != Some(&button) {
            return Err(unavailable("XTEST pointer button mapping is not identity"));
        }
        if master_button_map.get(usize::from(button - 1)) != Some(&button) {
            return Err(unavailable("master pointer button mapping is not identity"));
        }
    }
    // Extended pointer button actions can manufacture keys or change controls.
    for device in [devices.pointer, u16::from(devices.test_pointer)] {
        let info = xkb::get_device_info(
            conn,
            device,
            xkb::XIFeature::BUTTON_ACTIONS,
            true,
            0,
            0,
            xkb::LedClass::from(0_u16),
            0_u16,
        )
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?;
        if info
            .btn_actions
            .iter()
            .any(|action| action.as_noaction().type_ != xkb::SAType::NO_ACTION)
        {
            return Err(unavailable("pointer button action changes the input route"));
        }
    }
    Ok(Snapshot {
        devices,
        focus,
        slave_focus,
        modifier_states,
        controls,
        effects,
        symbols: core.keysyms,
        symbols_per_key: core.keysyms_per_keycode,
        meanings,
        buttons: button_map,
        master_buttons: master_button_map,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Kind {
    Key,
    Button,
    Enter,
    Focus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Tuple {
    kind: Kind,
    detail: u8,
    modifiers: u16,
}

fn tuples(events: &[Event], effects: &BTreeMap<u8, u8>) -> PlatformResult<BTreeSet<Tuple>> {
    let mut pressed = BTreeSet::new();
    let mut buttons = BTreeSet::new();
    let mut result = BTreeSet::new();
    for event in events {
        let modifiers = pressed.iter().fold(0_u16, |bits, key| {
            bits | u16::from(*effects.get(key).unwrap_or(&0))
        });
        match *event {
            Event::Key(key, true) => {
                if !pressed.insert(key) {
                    return Err(unavailable("duplicate held key in batch"));
                }
                result.insert(Tuple {
                    kind: Kind::Key,
                    detail: key,
                    modifiers,
                });
            }
            Event::Key(key, false) => {
                if !pressed.remove(&key) {
                    return Err(unavailable("unmatched key release in batch"));
                }
            }
            Event::Button(button, true) => {
                if !buttons.insert(button) {
                    return Err(unavailable("duplicate held button in batch"));
                }
                result.insert(Tuple {
                    kind: Kind::Button,
                    detail: button,
                    modifiers,
                });
            }
            Event::Button(button, false) => {
                if !buttons.remove(&button) {
                    return Err(unavailable("unmatched button release in batch"));
                }
            }
            Event::Motion(_, _) => {
                result.insert(Tuple {
                    kind: Kind::Enter,
                    detail: 0,
                    modifiers,
                });
            }
        }
        result.insert(Tuple {
            kind: Kind::Focus,
            detail: 0,
            modifiers,
        });
    }
    if !pressed.is_empty() || !buttons.is_empty() {
        return Err(unavailable("window-qualified batch leaves input held"));
    }
    Ok(result)
}

fn ancestry(conn: &RustConnection, root: Window, leaf: Window) -> PlatformResult<Vec<Window>> {
    let mut result = Vec::new();
    let mut current = leaf;
    for _ in 0..MAX_ROUTE_WINDOWS {
        if current == x11rb::NONE || result.contains(&current) {
            return Err(unavailable("window ancestry is ambiguous"));
        }
        result.push(current);
        if current == root {
            result.reverse();
            return Ok(result);
        }
        current = conn
            .query_tree(current)
            .map_err(unavailable)?
            .reply()
            .map_err(unavailable)?
            .parent;
    }
    Err(unavailable("window ancestry exceeds its bound"))
}

fn point_leaf(conn: &RustConnection, root: Window, x: i32, y: i32) -> PlatformResult<Window> {
    let (x, y) = (
        i16::try_from(x).map_err(unavailable)?,
        i16::try_from(y).map_err(unavailable)?,
    );
    let mut current = root;
    let mut seen = BTreeSet::new();
    for _ in 0..MAX_ROUTE_WINDOWS {
        if !seen.insert(current) {
            return Err(unavailable("pointer ancestry is ambiguous"));
        }
        let reply = conn
            .translate_coordinates(root, current, x, y)
            .map_err(unavailable)?
            .reply()
            .map_err(unavailable)?;
        if !reply.same_screen {
            return Err(unavailable("pointer point changed display"));
        }
        if reply.child == x11rb::NONE {
            return Ok(current);
        }
        current = reply.child;
    }
    Err(unavailable("pointer ancestry exceeds its bound"))
}

fn master_pointer_routes(
    conn: &RustConnection,
    root: Window,
    window: Window,
    events: &[Event],
) -> PlatformResult<Vec<(Window, u32, u32)>> {
    use x11rb::protocol::xproto::EventMask;
    let clients = conn
        .res_query_clients()
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?
        .clients;
    let mut position = None;
    let mut pressed = BTreeSet::new();
    let mut masks = BTreeMap::new();
    for event in events {
        let filter = match *event {
            Event::Motion(x, y) => {
                position = Some((x, y));
                let mut mask = EventMask::POINTER_MOTION;
                if !pressed.is_empty() {
                    mask |= EventMask::BUTTON_MOTION;
                }
                for (button, part) in [
                    (1, EventMask::BUTTON1_MOTION),
                    (2, EventMask::BUTTON2_MOTION),
                    (3, EventMask::BUTTON3_MOTION),
                    (4, EventMask::BUTTON4_MOTION),
                    (5, EventMask::BUTTON5_MOTION),
                ] {
                    if pressed.contains(&button) {
                        mask |= part;
                    }
                }
                mask
            }
            Event::Button(_, true) => EventMask::BUTTON_PRESS,
            Event::Button(_, false) => EventMask::BUTTON_RELEASE,
            Event::Key(_, _) => continue,
        };
        let (x, y) =
            position.ok_or_else(|| unavailable("pointer batch has no observed position"))?;
        let path = ancestry(conn, root, point_leaf(conn, root, x, y)?)?;
        if !path.contains(&window) {
            return Err(unavailable(
                "master pointer route left the original subtree",
            ));
        }
        let filter = u32::from(filter);
        let mut stopped = false;
        for &candidate in path.iter().rev() {
            if !super::same_x11_client(window, candidate, &clients) {
                return Err(unavailable("master pointer route reaches a foreign window"));
            }
            let (_, blocked) = if let Some(value) = masks.get(&candidate) {
                *value
            } else {
                let attributes = conn
                    .get_window_attributes(candidate)
                    .map_err(unavailable)?
                    .reply()
                    .map_err(unavailable)?;
                let value = (
                    u32::from(attributes.all_event_masks),
                    u32::from(attributes.do_not_propagate_mask),
                );
                masks.insert(candidate, value);
                value
            };
            // Selection is conditional: access policy or an interfering grab
            // can skip a recipient. Only a matching do-not-propagate mask
            // unconditionally stops core propagation within the owned subtree.
            if blocked & filter != 0 {
                stopped = true;
                break;
            }
            if candidate == window {
                break;
            }
        }
        if !stopped {
            return Err(unavailable(
                "master pointer event can propagate above the original window",
            ));
        }
        if let Event::Button(button, down) = *event {
            if down {
                pressed.insert(button);
            } else {
                pressed.remove(&button);
            }
        }
        if masks.len() > MAX_ROUTE_WINDOWS {
            return Err(unavailable("master pointer routes exceed their bound"));
        }
    }
    Ok(masks
        .into_iter()
        .map(|(id, (selected, blocked))| (id, selected, blocked))
        .collect())
}

fn active_probes(
    conn: &RustConnection,
    root: Window,
    devices: &Devices,
    keeper: bool,
) -> PlatformResult<()> {
    // Master XI2 grabs do not detach devices. Core grabs and XI1 slave grabs
    // cover the other namespaces, including an independently grabbed XTEST slave.
    if conn
        .grab_keyboard(
            false,
            root,
            x11rb::CURRENT_TIME,
            GrabMode::ASYNC,
            GrabMode::ASYNC,
        )
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?
        .status
        != GrabStatus::SUCCESS
    {
        return Err(unavailable("keyboard is actively grabbed"));
    }
    conn.ungrab_keyboard(x11rb::CURRENT_TIME)
        .map_err(unavailable)?
        .check()
        .map_err(unavailable)?;
    if conn
        .grab_pointer(
            false,
            root,
            x11rb::protocol::xproto::EventMask::NO_EVENT,
            GrabMode::ASYNC,
            GrabMode::ASYNC,
            x11rb::NONE,
            x11rb::NONE,
            x11rb::CURRENT_TIME,
        )
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?
        .status
        != GrabStatus::SUCCESS
    {
        return Err(unavailable("pointer is actively grabbed"));
    }
    conn.ungrab_pointer(x11rb::CURRENT_TIME)
        .map_err(unavailable)?
        .check()
        .map_err(unavailable)?;
    for device in [devices.keyboard, devices.pointer] {
        if xi::xi_grab_device(
            conn,
            root,
            x11rb::CURRENT_TIME,
            x11rb::NONE,
            device,
            GrabMode::ASYNC,
            GrabMode::ASYNC,
            xi::GrabOwner::NO_OWNER,
            &[],
        )
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?
        .status
            != GrabStatus::SUCCESS
        {
            return Err(unavailable("master device is actively grabbed"));
        }
        xi::xi_ungrab_device(conn, x11rb::CURRENT_TIME, device)
            .map_err(unavailable)?
            .check()
            .map_err(unavailable)?;
    }
    for device in [devices.test_keyboard, devices.test_pointer] {
        // Reprobing/ungrabbing this device would remove our retained keeper.
        if keeper {
            continue;
        }
        if xi::grab_device(
            conn,
            root,
            x11rb::CURRENT_TIME,
            GrabMode::ASYNC,
            GrabMode::ASYNC,
            false,
            device,
            &[],
        )
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?
        .status
            != GrabStatus::SUCCESS
        {
            return Err(unavailable("XTEST device is actively grabbed"));
        }
        xi::ungrab_device(conn, x11rb::CURRENT_TIME, device)
            .map_err(unavailable)?
            .check()
            .map_err(unavailable)?;
    }
    Ok(())
}

// Keep the shared budget and matching core, XI2 and XI1 grab/ungrab pairs
// contiguous so every protocol's refusal boundary is visible.
#[allow(clippy::too_many_lines)]
fn passive_probe(
    conn: &RustConnection,
    window: Window,
    tuple: Tuple,
    snap: &Snapshot,
    budget: &mut usize,
) -> PlatformResult<()> {
    let xi_kind = match tuple.kind {
        Kind::Key => xi::GrabType::KEYCODE,
        Kind::Button => xi::GrabType::BUTTON,
        Kind::Enter => xi::GrabType::ENTER,
        Kind::Focus => xi::GrabType::FOCUS_IN,
    };
    let (master, slave) = if tuple.kind == Kind::Key || tuple.kind == Kind::Focus {
        (snap.devices.keyboard, snap.devices.test_keyboard)
    } else {
        (snap.devices.pointer, snap.devices.test_pointer)
    };
    let cost = 4 + if tuple.kind == Kind::Key || tuple.kind == Kind::Button {
        2 + snap.devices.keyboards.len() * 2
    } else {
        0
    };
    *budget = budget
        .checked_add(cost)
        .ok_or_else(|| unavailable("probe count overflow"))?;
    if *budget > MAX_PROBE_REQUESTS {
        return Err(unavailable("route probe count exceeds its bound"));
    }
    let mods = ModMask::from(tuple.modifiers);
    match tuple.kind {
        Kind::Key => {
            conn.grab_key(
                false,
                window,
                mods,
                tuple.detail,
                GrabMode::ASYNC,
                GrabMode::ASYNC,
            )
            .map_err(unavailable)?
            .check()
            .map_err(unavailable)?;
            conn.ungrab_key(tuple.detail, window, mods)
                .map_err(unavailable)?
                .check()
                .map_err(unavailable)?;
        }
        Kind::Button => {
            conn.grab_button(
                false,
                window,
                x11rb::protocol::xproto::EventMask::NO_EVENT,
                GrabMode::ASYNC,
                GrabMode::ASYNC,
                x11rb::NONE,
                x11rb::NONE,
                tuple.detail.into(),
                mods,
            )
            .map_err(unavailable)?
            .check()
            .map_err(unavailable)?;
            conn.ungrab_button(tuple.detail.into(), window, mods)
                .map_err(unavailable)?
                .check()
                .map_err(unavailable)?;
        }
        _ => (),
    }
    for device in [master, u16::from(slave)] {
        let reply = xi::xi_passive_grab_device(
            conn,
            x11rb::CURRENT_TIME,
            window,
            x11rb::NONE,
            u32::from(tuple.detail),
            device,
            xi_kind,
            xi::GrabMode22::ASYNC,
            GrabMode::ASYNC,
            xi::GrabOwner::NO_OWNER,
            &[],
            &[u32::from(tuple.modifiers)],
        )
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?;
        if !reply.modifiers.is_empty() {
            return Err(unavailable("device has a matching passive grab"));
        }
        xi::xi_passive_ungrab_device(
            conn,
            window,
            u32::from(tuple.detail),
            device,
            xi_kind,
            &[u32::from(tuple.modifiers)],
        )
        .map_err(unavailable)?
        .check()
        .map_err(unavailable)?;
    }
    if tuple.kind == Kind::Key || tuple.kind == Kind::Button {
        // XI1 permits a different modifier device. An unrelated keyboard keeps
        // its current state; the XTEST keyboard and paired master follow the batch.
        for &modifier in &snap.devices.keyboards {
            let modifiers = if u16::from(modifier) == snap.devices.keyboard
                || modifier == snap.devices.test_keyboard
            {
                tuple.modifiers
            } else {
                *snap
                    .modifier_states
                    .get(&modifier)
                    .ok_or_else(|| unavailable("modifier device disappeared"))?
            };
            let mods = ModMask::from(modifiers);
            if tuple.kind == Kind::Key {
                xi::grab_device_key(
                    conn,
                    window,
                    mods,
                    modifier,
                    slave,
                    tuple.detail,
                    GrabMode::ASYNC,
                    GrabMode::ASYNC,
                    false,
                    &[],
                )
                .map_err(unavailable)?
                .check()
                .map_err(unavailable)?;
                xi::ungrab_device_key(conn, window, mods, modifier, tuple.detail, slave)
                    .map_err(unavailable)?
                    .check()
                    .map_err(unavailable)?;
            } else {
                xi::grab_device_button(
                    conn,
                    window,
                    slave,
                    modifier,
                    mods,
                    GrabMode::ASYNC,
                    GrabMode::ASYNC,
                    tuple.detail,
                    false,
                    &[],
                )
                .map_err(unavailable)?
                .check()
                .map_err(unavailable)?;
                xi::ungrab_device_button(conn, window, mods, modifier, tuple.detail, slave)
                    .map_err(unavailable)?
                    .check()
                    .map_err(unavailable)?;
            }
        }
    }
    Ok(())
}

pub(super) struct RoutingProof {
    before: Snapshot,
    keys: BTreeSet<u8>,
    buttons: BTreeSet<u8>,
    repeat: Option<RepeatGuard>,
    window: Window,
    events: Vec<Event>,
    pointer_routes: Vec<(Window, u32, u32)>,
}

impl RoutingProof {
    pub(super) fn verify(&self, conn: &RustConnection, root: Window) -> PlatformResult<()> {
        if let Some(repeat) = &self.repeat {
            repeat.verify_suppressed(conn)?;
        }
        if self.before != snapshot(conn, root, &self.keys, &self.buttons)? {
            return Err(unavailable(
                "device route or neutral input state changed during delivery",
            ));
        }
        if self.pointer_routes != master_pointer_routes(conn, root, self.window, &self.events)? {
            return Err(unavailable("master pointer delivery boundaries changed"));
        }
        active_probes(conn, root, &self.before.devices, true)
    }

    pub(super) fn release(self, conn: &RustConnection) -> PlatformResult<()> {
        if let Some(repeat) = self.repeat {
            repeat.restore(conn)?;
        }
        for device in [
            self.before.devices.test_keyboard,
            self.before.devices.test_pointer,
        ] {
            xi::ungrab_device(conn, x11rb::CURRENT_TIME, device)
                .map_err(unavailable)?
                .check()
                .map_err(unavailable)?;
        }
        Ok(())
    }
}

fn modifier_mask(symbol: u32) -> Option<u8> {
    match symbol {
        0xffe1 | 0xffe2 => Some(1),
        0xffe3 | 0xffe4 => Some(4),
        0xffe9 | 0xffea => Some(8),
        0xffeb | 0xffec => Some(64),
        _ => None,
    }
}

// Compare the entire prepared sequence with text/chord intent before any
// key can be emitted; no partial prefix can pass independently.
#[allow(clippy::too_many_lines)]
fn verify_key_intent(
    conn: &RustConnection,
    inputs: &[PreparedInput],
    snapshot: &Snapshot,
) -> PlatformResult<()> {
    let first = conn.setup().min_keycode;
    for input in inputs {
        let PreparedInput::Key { request, events } = input else {
            continue;
        };
        let text = request
            .key
            .chars()
            .map(|character| match character {
                '\n' | '\r' => 0xff0d,
                '\t' => 0xff09,
                character => character as u32,
            })
            .collect::<Vec<_>>();
        let chord = if request.is_text {
            Vec::new()
        } else {
            super::parse_named_key_chord(&request.key)?
        };
        let mut expected = if request.is_text {
            text.iter()
        } else {
            chord.iter()
        };
        let mut held = BTreeSet::new();
        for &(kind, key) in events {
            if kind == KEY_RELEASE {
                held.remove(&key);
                continue;
            }
            let modifiers = held
                .iter()
                .fold(0_u16, |mask, held| mask | u16::from(snapshot.effects[held]));
            let meaning = snapshot
                .meanings
                .get(&key)
                .ok_or_else(|| unavailable("requested key meaning is absent"))?;
            let effect = *snapshot
                .effects
                .get(&key)
                .ok_or_else(|| unavailable("requested modifier effect is absent"))?;
            if request.is_text && effect != 0 {
                if effect != 1 || modifier_mask(meaning.symbol(0)?) != Some(1) {
                    return Err(unavailable("text Shift key has another modifier effect"));
                }
            } else {
                let wanted = *expected.next().ok_or_else(|| {
                    unavailable("prepared key sequence differs from requested input")
                })?;
                if let Some(mask) = modifier_mask(wanted) {
                    if request.is_text || effect != mask || meaning.symbol(0)? != wanted {
                        return Err(unavailable(
                            "named modifier effect differs from the request",
                        ));
                    }
                } else {
                    if effect != 0 {
                        return Err(unavailable("requested glyph acts as a modifier"));
                    }
                    let wanted = if request.is_text {
                        wanted
                    } else {
                        // Chord modifiers must not make an XKB type select an
                        // unexpected symbol. Preserve the core base/Shift intent.
                        let offset = usize::from(
                            key.checked_sub(first)
                                .ok_or_else(|| unavailable("core key range changed"))?,
                        ) * usize::from(snapshot.symbols_per_key);
                        let base = snapshot
                            .symbols
                            .get(offset)
                            .copied()
                            .ok_or_else(|| unavailable("core key symbols are incomplete"))?;
                        if base != wanted {
                            return Err(unavailable(
                                "named glyph requires an explicit Shift chord",
                            ));
                        }
                        if modifiers & 1 == 0 {
                            wanted
                        } else {
                            snapshot
                                .symbols
                                .get(offset + 1)
                                .copied()
                                .filter(|symbol| *symbol != 0)
                                .unwrap_or(base)
                        }
                    };
                    if meaning.symbol(modifiers)? != wanted
                        || request.is_text && modifiers & !1 != 0
                    {
                        return Err(unavailable("XKB key type changes the requested glyph"));
                    }
                }
            }
            held.insert(key);
        }
        if expected.next().is_some() {
            return Err(unavailable("prepared sequence omits requested input"));
        }
    }
    Ok(())
}

// Preserve the audited order: full route census, passive and active probes,
// retained slave keepers, then repeat suppression and its final snapshot.
#[allow(clippy::too_many_lines)]
pub(super) fn preflight(
    conn: &RustConnection,
    root: Window,
    window: Window,
    inputs: &[PreparedInput],
) -> PlatformResult<RoutingProof> {
    let events = events(inputs)?;
    let keys = events
        .iter()
        .filter_map(|event| {
            if let Event::Key(key, _) = event {
                Some(*key)
            } else {
                None
            }
        })
        .collect::<BTreeSet<_>>();
    let buttons = events
        .iter()
        .filter_map(|event| {
            if let Event::Button(button, _) = event {
                Some(*button)
            } else {
                None
            }
        })
        .collect::<BTreeSet<_>>();
    let before = snapshot(conn, root, &keys, &buttons)?;
    verify_key_intent(conn, inputs, &before)?;
    let pointer_routes = master_pointer_routes(conn, root, window, &events)?;
    let tuples = tuples(&events, &before.effects)?;
    let mut keyboard_path = ancestry(conn, root, before.focus)?;
    if !keyboard_path.contains(&window) {
        return Err(unavailable("keyboard path left the original window"));
    }
    let mut pointer_path = BTreeSet::new();
    let current = conn
        .query_pointer(root)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?;
    let clients = conn
        .res_query_clients()
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?
        .clients;
    for event in std::iter::once(Event::Motion(
        i32::from(current.root_x),
        i32::from(current.root_y),
    ))
    .chain(events.iter().copied())
    {
        if let Event::Motion(x, y) = event {
            let path = ancestry(conn, root, point_leaf(conn, root, x, y)?)?;
            if let Some(focus) = path.iter().position(|candidate| *candidate == before.focus) {
                // Master keyboard delivery can start below its focus at the
                // pointer sprite. A foreign embedded child is a foreign route.
                if path[focus..]
                    .iter()
                    .any(|child| !super::same_x11_client(window, *child, &clients))
                {
                    return Err(unavailable(
                        "keyboard sprite route belongs to another client",
                    ));
                }
                keyboard_path.extend(path[focus..].iter().copied());
            }
            pointer_path.extend(path);
        }
    }
    if pointer_path.len() > MAX_ROUTE_WINDOWS {
        return Err(unavailable("pointer routes exceed their bound"));
    }
    keyboard_path.sort_unstable();
    keyboard_path.dedup();
    if keyboard_path.len() > MAX_ROUTE_WINDOWS {
        return Err(unavailable("keyboard routes exceed their bound"));
    }
    let mut budget = 0;
    // Passive focus/crossing checks precede the active probes, whose focus
    // notifications must not activate an existing foreign passive grab.
    for tuple in tuples {
        let windows = if tuple.kind == Kind::Key || tuple.kind == Kind::Focus {
            keyboard_path.iter().copied().collect::<BTreeSet<_>>()
        } else {
            pointer_path.clone()
        };
        for owner in windows {
            passive_probe(conn, owner, tuple, &before, &mut budget)?;
        }
    }
    active_probes(conn, root, &before.devices, false)?;
    if before != snapshot(conn, root, &keys, &buttons)? {
        return Err(unavailable("device route changed during preflight"));
    }
    // XI1 (not XI2) leaves the actual XTEST slave attached. Empty classes and
    // owner_events=false suppress its replica; the separate master event still
    // follows the original explicit focus. Never retain a master/core grab.
    for device in [before.devices.test_keyboard, before.devices.test_pointer] {
        if xi::grab_device(
            conn,
            before.focus,
            x11rb::CURRENT_TIME,
            GrabMode::ASYNC,
            GrabMode::ASYNC,
            false,
            device,
            &[],
        )
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?
        .status
            != GrabStatus::SUCCESS
        {
            return Err(unavailable("XTEST slave keeper could not be established"));
        }
    }
    if before != snapshot(conn, root, &keys, &buttons)? {
        return Err(unavailable("device route changed after keeper acquisition"));
    }
    let repeat = if keys.is_empty() {
        None
    } else {
        Some(RepeatGuard::suspend(conn, &before.devices)?)
    };
    if before != snapshot(conn, root, &keys, &buttons)? {
        return Err(unavailable("device route changed after repeat suppression"));
    }
    Ok(RoutingProof {
        before,
        keys,
        buttons,
        repeat,
        window,
        events,
        pointer_routes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passive_checks_use_modifiers_before_each_press_and_allow_unrelated_shortcuts() {
        let effects = BTreeMap::from([(38, 0), (50, 1), (37, 4)]);
        let batch = [
            Event::Key(50, true),
            Event::Key(38, true),
            Event::Key(38, false),
            Event::Key(50, false),
            Event::Key(37, true),
            Event::Key(38, true),
            Event::Key(38, false),
            Event::Key(37, false),
        ];
        let plan = tuples(&batch, &effects).unwrap();
        assert!(plan.contains(&Tuple {
            kind: Kind::Key,
            detail: 50,
            modifiers: 0
        }));
        assert!(plan.contains(&Tuple {
            kind: Kind::Key,
            detail: 38,
            modifiers: 1
        }));
        assert!(plan.contains(&Tuple {
            kind: Kind::Key,
            detail: 38,
            modifiers: 4
        }));
        assert!(!plan.contains(&Tuple {
            kind: Kind::Key,
            detail: 38,
            modifiers: 5
        }));
    }

    #[test]
    fn held_and_unmatched_inputs_refuse_before_delivery() {
        let effects = BTreeMap::from([(38, 0)]);
        for events in [
            &[Event::Key(38, true)][..],
            &[Event::Key(38, false)][..],
            &[Event::Button(1, true)][..],
            &[Event::Button(1, false)][..],
            &[
                Event::Key(38, true),
                Event::Key(38, true),
                Event::Key(38, false),
            ][..],
        ] {
            assert!(tuples(events, &effects).is_err());
        }
    }
}
