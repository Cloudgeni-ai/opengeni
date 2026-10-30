//! Spare keycodes bound to glyphs and function keys the layout lacks.
//!
//! A binding stays for the whole desktop session. Restoring it after each
//! action is unsafe: an X client translates a queued key event with the keymap
//! it fetches when it reaches that event, which a busy client may do only after
//! the action returned. Neither a server round trip nor a fixed delay tells
//! when that happened. So a spare keycode, once used, keeps its meaning while
//! any session that bound or used it is alive, and is never rebound to another
//! glyph in the meantime.
//!
//! Every desktop handle on a display records its claims in a root window
//! property as (owner window, keycode, keysym) triples. The owner is an
//! unmapped window on a connection kept for the session, so the X server
//! destroys it with the process. A keycode is restored when its last live claim
//! is released. Claims whose owner no longer exists (a process that crashed or
//! was killed) are pruned, and their keycodes restored, when the next session
//! starts on that display; until then such a binding only types its own glyph
//! on a keycode no layout key uses.

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use x11rb::connection::Connection as _;
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ConnectionExt as _, CreateWindowAux, PropMode, Window, WindowClass,
};
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

use super::{keyboard_layout_not_ready, read_keymap_row, X11Display, X11ServerGuard};
use crate::error::{PlatformError, PlatformResult};

const CLAIMS_PROPERTY: &[u8] = b"_OPENGENI_KEY_BINDINGS";

/// The most claim words read back. Each display has at most 248 keycodes and
/// every live handle claims each at most once.
const MAX_CLAIM_WORDS: u32 = 1 << 16;

/// How long a binding outlives its last key event when the session ends. It
/// only matters for a session that ends right after typing.
const RELEASE_GRACE: Duration = Duration::from_secs(1);

/// One handle's use of a bound keycode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct Claim {
    pub(super) owner: u32,
    pub(super) keycode: u8,
    pub(super) keysym: u32,
}

pub(super) fn decode_claims(words: impl IntoIterator<Item = u32>) -> Vec<Claim> {
    let words: Vec<u32> = words.into_iter().collect();
    words
        .chunks_exact(3)
        .filter_map(|chunk| {
            Some(Claim {
                owner: chunk[0],
                keycode: u8::try_from(chunk[1]).ok()?,
                keysym: chunk[2],
            })
        })
        .collect()
}

pub(super) fn encode_claims(claims: &[Claim]) -> Vec<u32> {
    claims
        .iter()
        .flat_map(|claim| [claim.owner, u32::from(claim.keycode), claim.keysym])
        .collect()
}

/// Whether `row` gives `keysym` and nothing else, as a binding reads back.
pub(super) fn binds_only(row: &[u32], keysym: u32) -> bool {
    keysym != 0
        && row.first() == Some(&keysym)
        && row
            .iter()
            .all(|candidate| *candidate == 0 || *candidate == keysym)
}

/// The claims to keep, and the keycodes to restore, after the claims of owners
/// that are not `alive` are dropped. A claim whose keycode no longer binds its
/// keysym (for example after a layout switch) is dropped without restoring
/// anything. Any other keycode is restored once no kept claim remains on it.
pub(super) fn settle_claims(
    claims: &[Claim],
    mut alive: impl FnMut(u32) -> bool,
    mut row: impl FnMut(u8) -> Option<Vec<u32>>,
) -> (Vec<Claim>, Vec<u8>) {
    let mut kept = Vec::new();
    let mut released = Vec::new();
    let mut rows = BTreeMap::new();
    for claim in claims {
        let current = rows
            .entry(claim.keycode)
            .or_insert_with(|| row(claim.keycode));
        if !current
            .as_deref()
            .is_some_and(|current| binds_only(current, claim.keysym))
        {
            continue;
        }
        if alive(claim.owner) {
            kept.push(*claim);
        } else {
            released.push(claim.keycode);
        }
    }
    kept.sort_unstable();
    kept.dedup();
    released.sort_unstable();
    released.dedup();
    released.retain(|keycode| !kept.iter().any(|claim| claim.keycode == *keycode));
    (kept, released)
}

/// What one delivery binds and uses. Planning has no X11 side effect;
/// [`KeyBindings::claim`] performs it once every check passed.
#[derive(Debug, Default)]
pub(super) struct KeyBindingPlan {
    /// (keycode, keysym, original row) to bind, in binding order.
    pub(super) bindings: Vec<(u8, u32, Vec<u32>)>,
    spares: Option<Vec<u8>>,
    /// Keycodes the delivery presses that give a single keysym: possibly a
    /// binding another handle made, which this one then claims too.
    pub(super) used: BTreeMap<u8, u32>,
}

impl KeyBindingPlan {
    /// Returns the spare keycode bound to `keysym`, reusing a binding for a
    /// repeated keysym. `None` when no spare is left.
    pub(super) fn bind_keysym(
        &mut self,
        spare_keycodes: impl FnOnce() -> Vec<u8>,
        original_row: impl FnOnce(u8) -> Option<Vec<u32>>,
        keysym: u32,
    ) -> Option<u8> {
        if let Some((keycode, ..)) = self.bindings.iter().find(|binding| binding.1 == keysym) {
            return Some(*keycode);
        }
        let keycode = self.spares.get_or_insert_with(spare_keycodes).pop()?;
        self.bindings
            .push((keycode, keysym, original_row(keycode)?));
        Some(keycode)
    }

    /// Notes a pressed keycode whose current row gives only one keysym.
    pub(super) fn note_used(&mut self, keycode: u8, row: &[u32]) {
        if let Some(&keysym) = row.first() {
            if binds_only(row, keysym) {
                self.used.insert(keycode, keysym);
            }
        }
    }
}

struct Owner {
    conn: RustConnection,
    root: Window,
    window: Window,
    atom: Atom,
}

#[derive(Default)]
struct Claimed {
    /// keycode to keysym this handle bound or used.
    keycodes: BTreeMap<u8, u32>,
    last_use: Option<Instant>,
}

/// The bindings one desktop session made or uses on its display, released
/// when the last handle to the desktop drops.
pub(super) struct KeyBindings {
    display: X11Display,
    /// Created before the first delivery that may bind, never under a server
    /// guard: the guard would hold back this other connection.
    owner: Mutex<Option<Owner>>,
    /// (owner window, claims property atom) once `owner` exists.
    identity: OnceLock<(Window, Atom)>,
    /// Locked only while the delivery connection holds the server guard, so a
    /// thread that waits for the guard never holds it.
    claimed: Mutex<Claimed>,
}

impl std::fmt::Debug for KeyBindings {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("KeyBindings")
            .field("owner", &self.identity.get().map(|(window, _)| *window))
            .finish_non_exhaustive()
    }
}

impl KeyBindings {
    pub(super) fn new(display: X11Display) -> Self {
        Self {
            display,
            owner: Mutex::new(None),
            identity: OnceLock::new(),
            claimed: Mutex::new(Claimed::default()),
        }
    }

    /// Opens the session's owner window, once, and prunes claims left by owners
    /// that no longer exist. Call before taking the server guard. A failure
    /// only means that keys the layout lacks are refused.
    pub(super) fn prepare(&self) {
        let Ok(mut owner) = self.owner.lock() else {
            return;
        };
        if owner.is_some() {
            return;
        }
        match open_owner(&self.display) {
            Ok(opened) => {
                if let Err(error) = settle_on(&opened.conn, opened.root, opened.atom, None) {
                    tracing::warn!(error = %error, "X11 key bindings left by an ended session were not restored");
                }
                let _ = self.identity.set((opened.window, opened.atom));
                *owner = Some(opened);
            }
            Err(error) => {
                tracing::warn!(error = %error, "X11 key bindings are unavailable");
            }
        }
    }

    /// Binds the planned keycodes and records this handle's claims on them and
    /// on any binding of another handle it presses. `guarded` says whether
    /// `conn` already holds the server guard; otherwise it is taken here
    /// whenever the delivery binds something or presses a single-keysym key
    /// this handle holds no claim on.
    ///
    /// # Errors
    ///
    /// A retryable failure when a planned spare keycode was taken, or a pressed
    /// key no longer gives the keysym it was planned with (another session
    /// released or rebound it since the keymap was read); nothing stays bound
    /// then.
    pub(super) fn claim(
        &self,
        conn: &RustConnection,
        root: Window,
        plan: &KeyBindingPlan,
        guarded: bool,
    ) -> PlatformResult<()> {
        if plan.bindings.is_empty() && plan.used.is_empty() {
            return Ok(());
        }
        let unclaimed: Vec<(u8, u32)> = {
            let mut claimed = self.claimed.lock().map_err(|_| poisoned())?;
            let unclaimed: Vec<(u8, u32)> = plan
                .used
                .iter()
                .filter(|(keycode, keysym)| claimed.keycodes.get(keycode) != Some(keysym))
                .map(|(keycode, keysym)| (*keycode, *keysym))
                .collect();
            if plan.bindings.is_empty() && unclaimed.is_empty() {
                claimed.last_use = Some(Instant::now());
                return Ok(());
            }
            unclaimed
        };
        let Some(&(owner, atom)) = self.identity.get() else {
            // Without an owner window this handle may only press layout keys.
            return if plan.bindings.is_empty() {
                Ok(())
            } else {
                Err(PlatformError::os("X11 key bindings are unavailable"))
            };
        };
        // Keys this handle holds no claim on are checked against the claims
        // under the guard: read without it, another session could release or
        // rebind one between that read and the key press.
        let guard = if guarded {
            None
        } else {
            Some(X11ServerGuard::acquire(conn)?)
        };
        let result = self.claim_guarded(conn, root, owner, atom, plan, &unclaimed);
        if let Some(guard) = guard {
            guard.release()?;
        }
        result
    }

    fn claim_guarded(
        &self,
        conn: &RustConnection,
        root: Window,
        owner: Window,
        atom: Atom,
        plan: &KeyBindingPlan,
        unclaimed: &[(u8, u32)],
    ) -> PlatformResult<()> {
        let mut claimed = self.claimed.lock().map_err(|_| poisoned())?;
        let mut claims = read_claims(conn, root, atom)?;
        let shared = shared_bindings(conn, &claims, unclaimed)?;
        if plan.bindings.is_empty() && shared.is_empty() {
            // Only layout keys, which no session binds or restores.
            return Ok(());
        }
        let mut bound: Vec<(u8, &[u32])> = Vec::with_capacity(plan.bindings.len());
        let applied = (|| {
            for (keycode, keysym, original) in &plan.bindings {
                if read_keymap_row(conn, *keycode)? != *original {
                    return Err(keyboard_layout_not_ready());
                }
                bound.push((*keycode, original));
                conn.change_keyboard_mapping(1, *keycode, 2, &[*keysym, *keysym])
                    .map_err(|error| PlatformError::os(format!("X11 keymap binding: {error}")))?
                    .check()
                    .map_err(|error| {
                        PlatformError::os(format!("X11 keymap binding result: {error}"))
                    })?;
                if !binds_only(&read_keymap_row(conn, *keycode)?, *keysym) {
                    return Err(PlatformError::os("X11 keymap binding did not read back"));
                }
            }
            claims.extend(
                plan.bindings
                    .iter()
                    .map(|(keycode, keysym, _)| (*keycode, *keysym))
                    .chain(shared.iter().copied())
                    .map(|(keycode, keysym)| Claim {
                        owner,
                        keycode,
                        keysym,
                    }),
            );
            claims.sort_unstable();
            claims.dedup();
            write_claims(conn, root, atom, &claims)
        })();
        if let Err(error) = applied {
            // Nothing was typed yet: undo what this call bound.
            for (keycode, original) in bound {
                if let Err(restore) = restore_row(conn, keycode, original) {
                    tracing::warn!(error = %restore, "X11 keymap binding rollback failed");
                }
            }
            return Err(error);
        }
        for (keycode, keysym, _) in &plan.bindings {
            claimed.keycodes.insert(*keycode, *keysym);
        }
        claimed.keycodes.extend(shared);
        claimed.last_use = Some(Instant::now());
        Ok(())
    }
}

/// Of the pressed keys this handle holds no claim on, those that are another
/// handle's binding, which this one must claim too; the rest are layout keys.
/// Call under the server guard with `claims` read under it.
///
/// # Errors
///
/// The retryable not-ready failure when a key no longer gives only the keysym
/// the delivery was planned with, or another glyph's claim holds it.
fn shared_bindings(
    conn: &RustConnection,
    claims: &[Claim],
    unclaimed: &[(u8, u32)],
) -> PlatformResult<Vec<(u8, u32)>> {
    let mut shared = Vec::new();
    for &(keycode, keysym) in unclaimed {
        if !binds_only(&read_keymap_row(conn, keycode)?, keysym) {
            return Err(keyboard_layout_not_ready());
        }
        let mut held = claims
            .iter()
            .filter(|claim| claim.keycode == keycode)
            .peekable();
        if held.peek().is_none() {
            continue;
        }
        if !held.any(|claim| claim.keysym == keysym) {
            return Err(keyboard_layout_not_ready());
        }
        shared.push((keycode, keysym));
    }
    Ok(shared)
}

impl Drop for KeyBindings {
    fn drop(&mut self) {
        let Some(owner) = self.owner.get_mut().ok().and_then(Option::take) else {
            return;
        };
        let claimed = self.claimed.get_mut().map_or((true, None), |claimed| {
            (claimed.keycodes.is_empty(), claimed.last_use)
        });
        if let (false, last_use) = claimed {
            if let Some(last_use) = last_use {
                std::thread::sleep(RELEASE_GRACE.saturating_sub(last_use.elapsed()));
            }
            if let Err(error) = settle_on(&owner.conn, owner.root, owner.atom, Some(owner.window)) {
                tracing::warn!(error = %error, "X11 key bindings were not restored");
            }
        }
        // Closing the owner connection destroys the owner window.
    }
}

fn poisoned() -> PlatformError {
    PlatformError::os("X11 key binding state is poisoned")
}

fn open_owner(display: &X11Display) -> PlatformResult<Owner> {
    let (conn, screen) = display.connect().map_err(|error| {
        PlatformError::os(format!("connect X display {}: {error}", display.name))
    })?;
    let root = conn.setup().roots[screen].root;
    let atom = conn
        .intern_atom(false, CLAIMS_PROPERTY)
        .map_err(|error| PlatformError::os(format!("X11 key binding atom: {error}")))?
        .reply()
        .map_err(|error| PlatformError::os(format!("X11 key binding atom result: {error}")))?
        .atom;
    let window = conn
        .generate_id()
        .map_err(|error| PlatformError::os(format!("X11 key binding owner id: {error}")))?;
    conn.create_window(
        0,
        window,
        root,
        -1,
        -1,
        1,
        1,
        0,
        WindowClass::INPUT_ONLY,
        0,
        &CreateWindowAux::new(),
    )
    .map_err(|error| PlatformError::os(format!("X11 key binding owner: {error}")))?
    .check()
    .map_err(|error| PlatformError::os(format!("X11 key binding owner result: {error}")))?;
    Ok(Owner {
        conn,
        root,
        window,
        atom,
    })
}

/// Restores the bindings of sessions on the display that ended without
/// releasing them (a crash or a kill). Called when a desktop opens; does
/// nothing, and takes no guard, while no claim exists.
pub(super) fn prune_ended_sessions(conn: &RustConnection, root: Window) {
    let atom = conn
        .intern_atom(true, CLAIMS_PROPERTY)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .map_or(x11rb::NONE, |reply| reply.atom);
    if atom == x11rb::NONE {
        return;
    }
    if let Err(error) = settle_on(conn, root, atom, None) {
        tracing::warn!(error = %error, "X11 key bindings left by an ended session were not restored");
    }
}

/// Under the server guard, drops `released`'s claims and those of owners that
/// no longer exist, and restores keycodes no live claim holds any more.
fn settle_on(
    conn: &RustConnection,
    root: Window,
    atom: Atom,
    released: Option<Window>,
) -> PlatformResult<()> {
    if read_claims(conn, root, atom)?.is_empty() {
        return Ok(());
    }
    let guard = X11ServerGuard::acquire(conn)?;
    let settled = (|| {
        let claims = read_claims(conn, root, atom)?;
        if claims.is_empty() {
            return Ok(());
        }
        let (kept, restore) = settle_claims(
            &claims,
            |owner| Some(owner) != released && window_exists(conn, owner),
            |keycode| read_keymap_row(conn, keycode).ok(),
        );
        for keycode in restore {
            let width = read_keymap_row(conn, keycode)?.len().max(1);
            restore_row(conn, keycode, &vec![0; width])?;
        }
        if kept != claims {
            write_claims(conn, root, atom, &kept)?;
        }
        Ok(())
    })();
    guard.release()?;
    settled
}

fn window_exists(conn: &RustConnection, window: Window) -> bool {
    conn.get_window_attributes(window)
        .is_ok_and(|cookie| cookie.reply().is_ok())
}

fn read_claims(conn: &RustConnection, root: Window, atom: Atom) -> PlatformResult<Vec<Claim>> {
    let reply = conn
        .get_property(false, root, atom, AtomEnum::CARDINAL, 0, MAX_CLAIM_WORDS)
        .map_err(|error| PlatformError::os(format!("X11 key binding claims read: {error}")))?
        .reply()
        .map_err(|error| {
            PlatformError::os(format!("X11 key binding claims read result: {error}"))
        })?;
    Ok(reply.value32().map(decode_claims).unwrap_or_default())
}

fn write_claims(
    conn: &RustConnection,
    root: Window,
    atom: Atom,
    claims: &[Claim],
) -> PlatformResult<()> {
    let written = if claims.is_empty() {
        conn.delete_property(root, atom)
            .map_err(|error| PlatformError::os(format!("X11 key binding claims write: {error}")))?
            .check()
    } else {
        conn.change_property32(
            PropMode::REPLACE,
            root,
            atom,
            AtomEnum::CARDINAL,
            &encode_claims(claims),
        )
        .map_err(|error| PlatformError::os(format!("X11 key binding claims write: {error}")))?
        .check()
    };
    written
        .map_err(|error| PlatformError::os(format!("X11 key binding claims write result: {error}")))
}

fn restore_row(conn: &RustConnection, keycode: u8, original: &[u32]) -> PlatformResult<()> {
    conn.change_keyboard_mapping(
        1,
        keycode,
        u8::try_from(original.len())
            .map_err(|_| PlatformError::os("X11 keymap row is too wide"))?,
        original,
    )
    .map_err(|error| PlatformError::os(format!("X11 keymap restore: {error}")))?
    .check()
    .map_err(|error| PlatformError::os(format!("X11 keymap restore result: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: u32 = 0x0100_5bc6;
    const B: u32 = 0xc6;

    fn claim(owner: u32, keycode: u8, keysym: u32) -> Claim {
        Claim {
            owner,
            keycode,
            keysym,
        }
    }

    #[test]
    fn claims_round_trip_and_ignore_a_partial_or_invalid_triple() {
        let claims = [claim(7, 255, A), claim(9, 254, B)];
        assert_eq!(decode_claims(encode_claims(&claims)), claims);
        assert_eq!(decode_claims([7, 300, A, 9, 254, B, 1]), [claim(9, 254, B)]);
    }

    #[test]
    fn a_binding_reads_back_as_its_keysym_alone() {
        assert!(binds_only(&[A, A, 0, 0], A));
        assert!(binds_only(&[A, 0, A], A));
        assert!(!binds_only(&[0, 0], 0));
        assert!(!binds_only(&[0x61, 0x41], 0x61));
        assert!(!binds_only(&[B, A], A));
    }

    #[test]
    fn a_keycode_is_restored_only_after_its_last_live_claim() {
        let rows = |keycode: u8| match keycode {
            255 => Some(vec![A, A, 0]),
            254 => Some(vec![B, B, 0]),
            // 253 was bound to A, but a layout switch replaced it.
            253 => Some(vec![0x61, 0x41, 0]),
            _ => None,
        };
        let claims = [
            claim(1, 255, A),
            claim(2, 255, A),
            claim(1, 254, B),
            claim(3, 253, A),
        ];
        // Owner 1 ends: 255 is still used by owner 2, 254 is released.
        let (kept, restore) = settle_claims(&claims, |owner| owner != 1, rows);
        assert_eq!(kept, [claim(2, 255, A)]);
        assert_eq!(restore, [254]);
        // Then owner 2 ends too.
        let (kept, restore) = settle_claims(&kept, |_| false, rows);
        assert!(kept.is_empty(), "{kept:?}");
        assert_eq!(restore, [255]);
        // A crashed owner's claim is pruned and its keycode restored by the
        // next session's start, which releases nothing of its own.
        let (kept, restore) = settle_claims(
            &[claim(4, 254, B), claim(5, 255, A)],
            |owner| owner == 5,
            rows,
        );
        assert_eq!(kept, [claim(5, 255, A)]);
        assert_eq!(restore, [254]);
    }

    #[test]
    fn a_plan_binds_each_keysym_once_and_notes_single_keysym_rows() {
        let mut plan = KeyBindingPlan::default();
        let spares = || vec![250, 251];
        let original = |_| Some(vec![0, 0]);
        assert_eq!(plan.bind_keysym(spares, original, A), Some(251));
        assert_eq!(plan.bind_keysym(spares, original, B), Some(250));
        assert_eq!(plan.bind_keysym(spares, original, A), Some(251));
        assert_eq!(plan.bind_keysym(spares, original, 0xffca), None);
        assert_eq!(plan.bindings.len(), 2);
        plan.note_used(38, &[0x61, 0x41]);
        plan.note_used(255, &[A, A, 0]);
        plan.note_used(9, &[0, 0]);
        assert_eq!(plan.used, BTreeMap::from([(255, A)]));
    }

    struct Server(std::process::Child);

    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    /// A private Xvfb display, or `None` without OPENGENI_XVFB.
    fn start_server() -> Option<(Server, String)> {
        use std::io::BufRead as _;
        let binary = std::env::var_os("OPENGENI_XVFB")?;
        let mut child = std::process::Command::new(binary)
            .args(["-displayfd", "1", "-noreset", "-nolisten", "tcp"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("configured Xvfb must run");
        let stdout = child.stdout.take().expect("Xvfb stdout");
        let server = Server(child);
        let mut number = String::new();
        std::io::BufReader::new(stdout)
            .read_line(&mut number)
            .expect("Xvfb display number");
        Some((server, format!(":{}", number.trim())))
    }

    /// Another session's handle: a connection with an owner window and a
    /// claim on `keycode`, bound to `keysym`.
    fn bind_as_other_session(display: &str, keycode: u8, keysym: u32) -> (RustConnection, Window) {
        let owner = open_owner(&X11Display::named(display)).expect("owner window");
        owner
            .conn
            .change_keyboard_mapping(1, keycode, 2, &[keysym, keysym])
            .unwrap()
            .check()
            .unwrap();
        let mut claims = read_claims(&owner.conn, owner.root, owner.atom).unwrap();
        claims.push(claim(owner.window, keycode, keysym));
        write_claims(&owner.conn, owner.root, owner.atom, &claims).unwrap();
        (owner.conn, owner.window)
    }

    fn plan_text(conn: &RustConnection, text: &str) -> KeyBindingPlan {
        let input = opengeni_agent_proto::v1::DesktopInput {
            channel_id: String::new(),
            event: Some(opengeni_agent_proto::v1::desktop_input::Event::Key(
                opengeni_agent_proto::v1::KeyEvent {
                    key: text.into(),
                    is_text: true,
                    action: opengeni_agent_proto::v1::KeyAction::Press.into(),
                },
            )),
        };
        super::super::prepare_inputs(conn, &[input]).unwrap().1
    }

    fn wait_until_gone(conn: &RustConnection, window: Window) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while window_exists(conn, window) {
            assert!(Instant::now() < deadline, "ended session's window remains");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// A key planned as another session's binding is re-checked when it is
    /// claimed: if that session ended and the key was restored, or rebound to
    /// another glyph, by a session that started meanwhile, the delivery
    /// refuses before any input instead of typing the wrong glyph or nothing.
    #[test]
    fn a_binding_released_or_rebound_after_planning_refuses_before_input() {
        const O_SLASH: u32 = 0xf8;
        let Some((_server, display)) = start_server() else {
            eprintln!("SKIP: set OPENGENI_XVFB");
            return;
        };
        for rebind in [Some(A), None] {
            let (conn, screen) = X11Display::named(&display).connect().unwrap();
            let root = conn.setup().roots[screen].root;
            let keycode = *super::super::keyboard_mapping(&conn)
                .unwrap()
                .spare_keycodes()
                .last()
                .expect("a spare keycode");
            let (ended, ended_window) = bind_as_other_session(&display, keycode, O_SLASH);
            let bindings = KeyBindings::new(X11Display::named(&display));
            bindings.prepare();
            let plan = plan_text(&conn, "ø");
            assert!(plan.bindings.is_empty(), "{:?}", plan.bindings);
            assert_eq!(plan.used, BTreeMap::from([(keycode, O_SLASH)]));

            // That session is killed, and a session starting meanwhile
            // restores its key and, in the first round, binds it to 密.
            drop(ended);
            wait_until_gone(&conn, ended_window);
            prune_ended_sessions(&conn, root);
            let restored = read_keymap_row(&conn, keycode).unwrap();
            assert!(restored.iter().all(|keysym| *keysym == 0));
            let rebound = rebind.map(|keysym| bind_as_other_session(&display, keycode, keysym));

            assert!(matches!(
                bindings.claim(&conn, root, &plan, false),
                Err(PlatformError::Timeout(_))
            ));
            // Planned again, ø gets a spare of its own.
            let plan = plan_text(&conn, "ø");
            assert_eq!(plan.bindings.len(), 1);
            assert_ne!(plan.bindings[0].0, keycode);
            bindings.claim(&conn, root, &plan, false).unwrap();
            drop(bindings);
            drop(rebound);
        }
    }

    /// While the session that bound a key is alive, another one pressing it
    /// claims it too, so it stays bound after the first one ends.
    #[test]
    fn a_live_binding_pressed_by_another_session_is_claimed_by_it() {
        const O_SLASH: u32 = 0xf8;
        let Some((_server, display)) = start_server() else {
            eprintln!("SKIP: set OPENGENI_XVFB");
            return;
        };
        let (conn, screen) = X11Display::named(&display).connect().unwrap();
        let root = conn.setup().roots[screen].root;
        let keycode = *super::super::keyboard_mapping(&conn)
            .unwrap()
            .spare_keycodes()
            .last()
            .expect("a spare keycode");
        let (first, first_window) = bind_as_other_session(&display, keycode, O_SLASH);
        let bindings = KeyBindings::new(X11Display::named(&display));
        bindings.prepare();
        let plan = plan_text(&conn, "ø plain");
        bindings.claim(&conn, root, &plan, false).unwrap();
        let (own, atom) = *bindings.identity.get().unwrap();
        assert!(read_claims(&conn, root, atom)
            .unwrap()
            .contains(&claim(own, keycode, O_SLASH)));
        drop(first);
        wait_until_gone(&conn, first_window);
        prune_ended_sessions(&conn, root);
        assert!(binds_only(
            &read_keymap_row(&conn, keycode).unwrap(),
            O_SLASH
        ));
        assert_eq!(
            read_claims(&conn, root, atom).unwrap(),
            [claim(own, keycode, O_SLASH)]
        );
    }
}
