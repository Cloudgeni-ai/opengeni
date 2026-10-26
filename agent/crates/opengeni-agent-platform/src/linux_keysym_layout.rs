//! What a compositor that takes keysym input (GNOME Wayland remote desktop)
//! can type in a keyboard layout.
//!
//! Mutter resolves a keysym in the active layout group only: it takes the
//! first keycode, in keycode order, that carries the keysym at any shift level
//! of that group, presses Shift for the second level or ISO_Level3_Shift
//! (AltGr) for the third, and sends the key. It drops a keysym the group lacks
//! and sends a higher level unshifted, both while the call succeeds. This
//! module mirrors that choice on the XKB keymap of a display that shares the
//! compositor's layout (Xwayland), so text that would be lost or mistyped is
//! refused before anything is sent.

use x11rb::protocol::xkb::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{self, ConnectionExt as _};
use x11rb::rust_connection::RustConnection;

pub(super) const SHIFT_L: u32 = 0xffe1;
const ISO_LEVEL3_SHIFT: u32 = 0xfe03;
/// The core Lock modifier, which Caps Lock locks.
const LOCK_MASK: u8 = 0x02;

/// One key of a named key or chord, as a compositor that takes keysyms or
/// keycodes receives it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompositorKey {
    /// A keysym, which the compositor resolves in its active layout group.
    Keysym(u32),
    /// A Linux evdev keycode: a physical key, whatever the active group
    /// makes of it.
    Keycode(u32),
}

/// What the compositor reports about its keyboard layout, when it does.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CompositorLayout {
    /// The active layout group, the only one the compositor types from.
    pub active_group: Option<u32>,
    /// The locked modifiers (core modifier bits, such as Lock for Caps Lock),
    /// which change the level a key gives.
    pub locked_modifiers: Option<u32>,
    /// The names of the compositor's keymap, which the layout display must
    /// carry before its keymap can stand in for the compositor's.
    pub keymap: Option<KeymapNames>,
}

/// The names that identify a keymap: its symbols and its layout groups. A
/// display that mirrors the compositor's layout only does so once its keymap
/// carries the compositor's names; Xwayland starts with a default keymap and
/// takes the compositor's shortly after.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KeymapNames {
    symbols: String,
    groups: Vec<String>,
}

impl KeymapNames {
    /// The names in an XKB text keymap, as a compositor hands one to clients:
    /// the `xkb_symbols` name and its `name[N]` group names.
    #[must_use]
    pub fn from_keymap_text(text: &str) -> Self {
        let mut names = Self::default();
        let mut groups = Vec::new();
        let mut in_symbols = false;
        for line in text.lines().map(str::trim) {
            if let Some(rest) = line.strip_prefix("xkb_symbols") {
                in_symbols = true;
                names.symbols = quoted(rest).unwrap_or_default().to_string();
            } else if line.starts_with("xkb_") {
                in_symbols = false;
            } else if let (true, Some(rest)) = (in_symbols, line.strip_prefix("name[")) {
                let Some((index, value)) = rest.split_once(']') else {
                    continue;
                };
                let index: String = index.chars().filter(char::is_ascii_digit).collect();
                if let (Ok(index), Some(name)) = (index.parse::<usize>(), quoted(value)) {
                    groups.push((index, name.to_string()));
                }
            }
        }
        groups.sort_by_key(|(index, _)| *index);
        names.groups = groups.into_iter().map(|(_, name)| name).collect();
        names
    }

    /// Whether the names identify anything at all.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.symbols.is_empty() && self.groups.is_empty()
    }

    fn read(conn: &RustConnection) -> Option<Self> {
        let reply = conn
            .xkb_get_names(
                xkb::ID::USE_CORE_KBD.into(),
                xkb::NameDetail::SYMBOLS | xkb::NameDetail::GROUP_NAMES,
            )
            .ok()?
            .reply()
            .ok()?;
        let atom = |atom: u32| -> Option<String> {
            let name = conn.get_atom_name(atom).ok()?.reply().ok()?.name;
            Some(String::from_utf8_lossy(&name).into_owned())
        };
        let symbols = match reply.value_list.symbols_name {
            Some(0) | None => String::new(),
            Some(symbols) => atom(symbols)?,
        };
        let groups = reply
            .value_list
            .groups
            .unwrap_or_default()
            .into_iter()
            .filter(|&group| group != 0)
            .map(atom)
            .collect::<Option<_>>()?;
        Some(Self { symbols, groups })
    }
}

fn quoted(text: &str) -> Option<&str> {
    let (_, rest) = text.split_once('"')?;
    rest.split_once('"').map(|(value, _)| value)
}

/// How a key with fewer groups than the active one picks its group.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutOfRange {
    Wrap,
    Clamp,
    Redirect(usize),
}

/// An XKB key type: which modifiers select which shift level.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct KeyKind {
    /// The modifiers the type looks at.
    mask: u8,
    /// Per map entry: the modifiers (within `mask`), the level they select,
    /// and the modifiers the entry preserves (does not consume).
    entries: Vec<(u8, usize, u8)>,
}

impl KeyKind {
    fn from_xkb(kind: &xkb::KeyType) -> Self {
        let mod_bits = |mask: xproto::ModMask| u16::from(mask).to_le_bytes()[0];
        let entries = kind
            .map
            .iter()
            .enumerate()
            .filter(|(_, entry)| entry.active)
            .map(|(index, entry)| {
                let preserved = kind
                    .preserve
                    .get(index)
                    .filter(|_| kind.has_preserve)
                    .map_or(0, |preserve| mod_bits(preserve.mask));
                (
                    mod_bits(entry.mods_mask),
                    usize::from(entry.level),
                    preserved,
                )
            })
            .collect();
        Self {
            mask: mod_bits(kind.mods_mask),
            entries,
        }
    }

    /// The level `mods` select and the modifiers that choice consumes.
    fn level(&self, mods: u8) -> (usize, u8) {
        let mods = mods & self.mask;
        self.entries
            .iter()
            .find(|(entry, ..)| *entry == mods)
            .map_or((0, self.mask), |&(_, level, preserved)| {
                (level, self.mask & !preserved)
            })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LayoutKey {
    keycode: u8,
    /// Per group, the keysym of each shift level the group's key type has.
    groups: Vec<Vec<u32>>,
    /// Per group, the index of its key type in [`LayoutKeymap::kinds`].
    kinds: Vec<usize>,
    /// The modifiers the key sets when pressed (its modifier map).
    mods: u8,
    out_of_range: OutOfRange,
}

impl LayoutKey {
    /// The group of this key that `layout` selects, as libxkbcommon resolves it.
    fn group(&self, layout: usize) -> Option<&[u32]> {
        self.group_index(layout)
            .and_then(|index| self.groups.get(index))
            .map(Vec::as_slice)
    }

    fn group_index(&self, layout: usize) -> Option<usize> {
        let count = self.groups.len();
        if count == 0 {
            return None;
        }
        Some(if layout < count {
            layout
        } else {
            match self.out_of_range {
                OutOfRange::Wrap => layout % count,
                OutOfRange::Clamp => count - 1,
                OutOfRange::Redirect(group) if group < count => group,
                OutOfRange::Redirect(_) => 0,
            }
        })
    }
}

/// A keyboard layout as a compositor resolving keysyms per group sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LayoutKeymap {
    keys: Vec<LayoutKey>,
    kinds: Vec<KeyKind>,
    /// The highest keycode, which Mutter's keycode scan leaves out.
    max_keycode: u8,
    names: KeymapNames,
}

impl LayoutKeymap {
    /// Reads the core keyboard's XKB keymap. `None` when XKB is unavailable.
    pub(super) fn read(conn: &RustConnection) -> Option<Self> {
        if !conn.xkb_use_extension(1, 0).ok()?.reply().ok()?.supported {
            return None;
        }
        let parts = xkb::MapPart::KEY_TYPES | xkb::MapPart::KEY_SYMS | xkb::MapPart::MODIFIER_MAP;
        let reply = conn
            .xkb_get_map(
                xkb::ID::USE_CORE_KBD.into(),
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
            .ok()?
            .reply()
            .ok()?;
        let types = reply.map.types_rtrn?;
        let levels: Vec<u8> = types.iter().map(|kind| kind.num_levels).collect();
        let kinds = types.iter().map(KeyKind::from_xkb).collect();
        let modmap = reply.map.modmap_rtrn.unwrap_or_default();
        let key_mods = |keycode: u8| {
            modmap
                .iter()
                .filter(|entry| entry.keycode == keycode)
                .fold(0, |mods, entry| {
                    mods | u16::from(entry.mods).to_le_bytes()[0]
                })
        };
        let keys = reply
            .map
            .syms_rtrn?
            .iter()
            .zip(reply.first_key_sym..=u8::MAX)
            .map(|(map, keycode)| LayoutKey::from_xkb(keycode, map, &levels, key_mods(keycode)))
            .collect();
        Some(Self {
            keys,
            kinds,
            max_keycode: reply.max_key_code,
            names: KeymapNames::read(conn).unwrap_or_default(),
        })
    }

    pub(super) fn names(&self) -> &KeymapNames {
        &self.names
    }

    /// The number of layout groups.
    fn layouts(&self) -> usize {
        self.keys
            .iter()
            .map(|key| key.groups.len())
            .max()
            .unwrap_or(0)
    }

    /// The shift level at which the compositor would send `keysym` in group
    /// `layout`, or `None` when it would drop it.
    fn level(&self, keysym: u32, layout: usize) -> Option<usize> {
        self.pick(keysym, layout).map(|(_, level)| level)
    }

    /// The key and level the compositor picks for `keysym` in group `layout`.
    fn pick(&self, keysym: u32, layout: usize) -> Option<(&LayoutKey, usize)> {
        self.keys
            .iter()
            .filter(|key| key.keycode < self.max_keycode)
            .find_map(|key| {
                let level = key
                    .group(layout)?
                    .iter()
                    .position(|&candidate| candidate == keysym)?;
                Some((key, level))
            })
    }

    /// Whether the compositor types `keysym` itself in group `layout`: at the
    /// base level, or at the Shift or AltGr level when the group has that
    /// modifier key to press.
    fn types_in(&self, keysym: u32, layout: usize) -> bool {
        keysym != 0
            && match self.level(keysym, layout) {
                Some(0) => true,
                Some(1) => self.level(SHIFT_L, layout).is_some(),
                Some(2) => self.level(ISO_LEVEL3_SHIFT, layout).is_some(),
                _ => false,
            }
    }

    /// Whether the compositor types `keysym` in the active group, or in
    /// every group when the active one is unknown.
    pub(super) fn types(&self, keysym: u32, active: Option<u32>) -> bool {
        let layouts = self.checked_layouts(active);
        !layouts.is_empty()
            && layouts
                .into_iter()
                .all(|layout| self.types_in(keysym, layout))
    }

    /// The active group when it is known and in range, otherwise every group.
    fn checked_layouts(&self, active: Option<u32>) -> Vec<usize> {
        let layouts = self.layouts();
        match active.and_then(|layout| usize::try_from(layout).ok()) {
            Some(layout) if layout < layouts => vec![layout],
            _ => (0..layouts).collect(),
        }
    }

    /// The keysym to send so that the compositor's keyboard types `character`
    /// in the active group (every group when that is unknown) while
    /// `locked` modifiers are locked, or `None` when no keysym does.
    ///
    /// Without locked modifiers that is a keysym of the character the group
    /// types. A locked modifier changes the level a key gives: Caps Lock
    /// turns the base level of a letter key into its capital, and an
    /// application capitalizes a letter whose key type leaves Lock unused.
    /// Then the keysym of another level of the same key may give the
    /// character instead, such as `A` for `a`, which the compositor sends
    /// with Shift, and Shift with Caps Lock gives the small letter.
    pub(super) fn text_keysym(
        &self,
        character: char,
        active: Option<u32>,
        locked: Option<u32>,
    ) -> Option<u32> {
        let locked = locked.map_or(0, low_byte);
        if locked == 0 {
            return super::keysyms::character_keysyms(character)
                .find(|&keysym| self.types(keysym, active));
        }
        let layouts = self.checked_layouts(active);
        if layouts.is_empty() {
            return None;
        }
        // The character's keysyms, then those of its small letter, which
        // applications capitalize under Caps Lock.
        let canonical: Vec<u32> = super::keysyms::character_keysyms(character)
            .chain(
                character
                    .to_lowercase()
                    .filter(|&small| small != character)
                    .flat_map(super::keysyms::character_keysyms),
            )
            .collect();
        // Other levels of the keys that carry them.
        let siblings = self.keys.iter().flat_map(|key| {
            key.groups
                .iter()
                .filter(|levels| levels.iter().any(|keysym| canonical.contains(keysym)))
                .flatten()
                .copied()
        });
        canonical.iter().copied().chain(siblings).find(|&keysym| {
            layouts
                .iter()
                .all(|&layout| self.sends(keysym, layout, locked, character))
        })
    }

    /// Whether sending `keysym` makes the compositor's keyboard type
    /// `character` in group `layout` while `locked` modifiers are locked: the
    /// compositor presses the key it picks with the modifier for its level,
    /// and the key's type turns those modifiers and the locked ones into the
    /// level the application reads.
    fn sends(&self, keysym: u32, layout: usize, locked: u8, character: char) -> bool {
        let Some((key, level)) = self.pick(keysym, layout).filter(|_| keysym != 0) else {
            return false;
        };
        let pressed = match level {
            0 => Some(0),
            1 => self.pick(SHIFT_L, layout).map(|(shift, _)| shift.mods),
            2 => self
                .pick(ISO_LEVEL3_SHIFT, layout)
                .map(|(level3, _)| level3.mods),
            _ => None,
        };
        pressed.is_some_and(|pressed| self.key_gives(key, layout, pressed | locked, character))
    }

    /// Whether pressing `keycode` with `pressed` modifiers held while `locked`
    /// ones are locked gives `character` in group `layout`.
    pub(super) fn keycode_gives(
        &self,
        keycode: u8,
        layout: usize,
        pressed: u8,
        locked: u8,
        character: char,
    ) -> bool {
        self.keys
            .iter()
            .find(|key| key.keycode == keycode)
            .is_some_and(|key| self.key_gives(key, layout, pressed | locked, character))
    }

    fn key_gives(&self, key: &LayoutKey, layout: usize, mods: u8, character: char) -> bool {
        let Some(index) = key.group_index(layout) else {
            return false;
        };
        let kind = key
            .kinds
            .get(index)
            .and_then(|&kind| self.kinds.get(kind))
            .cloned()
            .unwrap_or_default();
        let (level, consumed) = kind.level(mods);
        let Some(&keysym) = key.groups[index].get(level) else {
            return false;
        };
        // Applications capitalize a keysym when Lock is active and its key
        // type did not consume it (libxkbcommon and Xlib alike).
        let capitalized = mods & LOCK_MASK != 0 && consumed & LOCK_MASK == 0;
        gives(keysym, character, capitalized)
    }

    /// The lowest keycode that carries `keysym` at its base level in some
    /// group, or else at its Shift level, with that level. Pressing this key
    /// is how a person gives a shortcut whose key is in another group: the
    /// application matches the shortcut by keycode across groups.
    pub(super) fn physical_key(&self, keysym: u32) -> Option<(u8, usize)> {
        if keysym == 0 {
            return None;
        }
        (0..2).find_map(|level| {
            self.keys
                .iter()
                .filter(|key| {
                    key.groups
                        .iter()
                        .any(|levels| levels.get(level) == Some(&keysym))
                })
                .map(|key| key.keycode)
                .min()
                .map(|keycode| (keycode, level))
        })
    }
}

fn low_byte(mods: u32) -> u8 {
    mods.to_le_bytes()[0]
}

/// Whether a key that gives `keysym` types `character`, when applications
/// capitalize it or not.
pub(super) fn gives(keysym: u32, character: char, capitalized: bool) -> bool {
    let is = |character: char| super::keysyms::character_keysyms(character).any(|k| k == keysym);
    if !capitalized {
        return is(character);
    }
    // A capitalized letter is its single-character capital; a character
    // whose capital is several characters is not predictable.
    let upper = |character: char| {
        let mut upper = character.to_uppercase();
        match (upper.next(), upper.next()) {
            (Some(single), None) => Some(single),
            _ => None,
        }
    };
    let lower = |character: char| {
        let mut lower = character.to_lowercase();
        match (lower.next(), lower.next()) {
            (Some(single), None) => Some(single),
            _ => None,
        }
    };
    (is(character) && upper(character) == Some(character))
        || lower(character)
            .filter(|&small| small != character && is(small))
            .is_some_and(|small| upper(small) == Some(character))
}

impl LayoutKey {
    fn from_xkb(keycode: u8, map: &xkb::KeySymMap, levels: &[u8], mods: u8) -> Self {
        let width = usize::from(map.width);
        let count = usize::from(map.group_info & 0x0f).min(map.kt_index.len());
        let groups = (0..count)
            .map(|group| {
                let kind_levels = levels
                    .get(usize::from(map.kt_index[group]))
                    .map_or(0, |&levels| usize::from(levels));
                let start = group * width;
                let end = start + kind_levels.min(width);
                map.syms.get(start..end).unwrap_or_default().to_vec()
            })
            .collect();
        let kinds = map.kt_index[..count]
            .iter()
            .copied()
            .map(usize::from)
            .collect();
        let out_of_range = match map.group_info & 0xc0 {
            0x40 => OutOfRange::Clamp,
            0x80 => OutOfRange::Redirect(usize::from((map.group_info >> 4) & 0x03)),
            _ => OutOfRange::Wrap,
        };
        Self {
            keycode,
            groups,
            kinds,
            mods,
            out_of_range,
        }
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    const SHIFT: u8 = 0x01;
    const MOD5: u8 = 0x80;

    /// The key types of the standard XKB `complete` set a fixture uses.
    fn standard_kinds() -> Vec<KeyKind> {
        let kind = |mask: u8, entries: &[(u8, usize, u8)]| KeyKind {
            mask,
            entries: entries.to_vec(),
        };
        vec![
            // ONE_LEVEL
            kind(0, &[]),
            // TWO_LEVEL
            kind(SHIFT, &[(SHIFT, 1, 0)]),
            // ALPHABETIC
            kind(SHIFT | LOCK_MASK, &[(SHIFT, 1, 0), (LOCK_MASK, 1, 0)]),
            // FOUR_LEVEL
            kind(
                SHIFT | MOD5,
                &[(SHIFT, 1, 0), (MOD5, 2, 0), (SHIFT | MOD5, 3, 0)],
            ),
            // FOUR_LEVEL_SEMIALPHABETIC: Lock capitalizes the letter levels
            // and is preserved on the third, so the application capitalizes
            // that one itself.
            kind(
                SHIFT | LOCK_MASK | MOD5,
                &[
                    (SHIFT, 1, 0),
                    (LOCK_MASK, 1, 0),
                    (MOD5, 2, 0),
                    (SHIFT | MOD5, 3, 0),
                    (LOCK_MASK | MOD5, 2, LOCK_MASK),
                    (SHIFT | LOCK_MASK | MOD5, 3, LOCK_MASK),
                ],
            ),
        ]
    }

    /// A Latin or legacy Cyrillic small letter with its capital.
    fn letter_pair(levels: &[u32]) -> bool {
        match levels {
            [small, capital, ..] => {
                ((0x61..=0x7a).contains(small) && *capital == small - 0x20)
                    || ((0x6c0..=0x6df).contains(small) && *capital == small + 0x20)
            }
            _ => false,
        }
    }

    /// A keymap from rows of (keycode, per-group levels), wrapping groups,
    /// with the standard type each group's levels suggest and the usual
    /// modifier map.
    pub(in crate::linux) fn keymap(rows: &[(u8, &[&[u32]])]) -> LayoutKeymap {
        LayoutKeymap {
            keys: rows
                .iter()
                .map(|(keycode, groups)| LayoutKey {
                    keycode: *keycode,
                    groups: groups.iter().map(|levels| levels.to_vec()).collect(),
                    kinds: groups
                        .iter()
                        .map(|levels| match (levels.len(), letter_pair(levels)) {
                            (0 | 1, _) => 0,
                            (2, false) => 1,
                            (2, true) => 2,
                            (_, false) => 3,
                            (_, true) => 4,
                        })
                        .collect(),
                    mods: match groups.first().and_then(|levels| levels.first()) {
                        Some(&SHIFT_L) => SHIFT,
                        Some(&0xffe5) => LOCK_MASK,
                        Some(&ISO_LEVEL3_SHIFT) => MOD5,
                        _ => 0,
                    },
                    out_of_range: OutOfRange::Wrap,
                })
                .collect(),
            kinds: standard_kinds(),
            max_keycode: 255,
            names: KeymapNames::default(),
        }
    }

    #[test]
    fn reads_names_from_a_compositor_keymap() {
        let text = r#"xkb_keymap {
xkb_keycodes "evdev+aliases(qwerty)" {
	indicator 1 = "Caps Lock";
};
xkb_types "complete" {
	type "TWO_LEVEL" {
		level_name[1]= "Base";
		level_name[2]= "Shift";
	};
};
xkb_symbols "pc_ru_us_2_inet(evdev)" {
	name[1]="Russian";
	name[2]="English (US)";
	key <AD01> { [ Cyrillic_shorti, Cyrillic_SHORTI ], [ q, Q ] };
};
};"#;
        let names = KeymapNames::from_keymap_text(text);
        assert_eq!(names.symbols, "pc_ru_us_2_inet(evdev)");
        assert_eq!(names.groups, ["Russian", "English (US)"]);
        // The older text format names groups `Group1`.
        let older = "xkb_symbols \"pc+de\" {\n    name[Group2]=\"B\";\n    name[Group1]=\"A\";\n};";
        assert_eq!(
            KeymapNames::from_keymap_text(older),
            KeymapNames {
                symbols: "pc+de".into(),
                groups: vec!["A".into(), "B".into()],
            }
        );
    }

    #[test]
    fn reads_groups_and_levels_from_the_xkb_map() {
        // Two groups of width 4: a two-level type in group 1 and a
        // four-level type in group 2. Levels beyond a type are not keys.
        let map = xkb::KeySymMap {
            kt_index: [0, 1, 0, 0],
            group_info: 0x02,
            width: 4,
            syms: vec![0x71, 0x51, 0, 0x7d9, 0x6ca, 0x6ea, 0x40, 0],
        };
        let key = LayoutKey::from_xkb(24, &map, &[2, 4], 0);
        assert_eq!(
            key.groups,
            vec![vec![0x71, 0x51], vec![0x6ca, 0x6ea, 0x40, 0]]
        );
        assert_eq!(key.kinds, vec![0, 1]);
        assert_eq!(key.out_of_range, OutOfRange::Wrap);
        let clamp = xkb::KeySymMap {
            group_info: 0x41,
            ..map.clone()
        };
        assert_eq!(
            LayoutKey::from_xkb(24, &clamp, &[2, 4], 0).out_of_range,
            OutOfRange::Clamp
        );
        let redirect = xkb::KeySymMap {
            group_info: 0x91,
            ..map
        };
        assert_eq!(
            LayoutKey::from_xkb(24, &redirect, &[2, 4], 0).out_of_range,
            OutOfRange::Redirect(1)
        );
    }

    #[test]
    fn group_index_follows_out_of_range_rules() {
        let mut key = LayoutKey {
            keycode: 9,
            groups: vec![vec![1], vec![2]],
            kinds: vec![0, 0],
            mods: 0,
            out_of_range: OutOfRange::Wrap,
        };
        assert_eq!(key.group_index(3), Some(1));
        key.out_of_range = OutOfRange::Clamp;
        assert_eq!(key.group_index(5), Some(1));
    }

    #[test]
    fn reads_key_types_with_their_preserved_modifiers() {
        let entry = |mods: u16, level: u8| xkb::KTMapEntry {
            active: true,
            mods_mask: mods.into(),
            level,
            mods_mods: mods.into(),
            mods_vmods: 0_u16.into(),
        };
        let preserve = |mods: u16| xkb::ModDef {
            mask: mods.into(),
            real_mods: mods.into(),
            vmods: 0_u16.into(),
        };
        let mut inactive = entry(0x04, 3);
        inactive.active = false;
        let kind = KeyKind::from_xkb(&xkb::KeyType {
            mods_mask: 0x83_u16.into(),
            mods_mods: 0x83_u16.into(),
            mods_vmods: 0_u16.into(),
            num_levels: 4,
            has_preserve: true,
            map: vec![entry(0x01, 1), inactive, entry(0x82, 2)],
            preserve: vec![preserve(0), preserve(0), preserve(0x02)],
        });
        assert_eq!(
            kind,
            KeyKind {
                mask: 0x83,
                entries: vec![(0x01, 1, 0), (0x82, 2, 0x02)],
            }
        );
        // Unmapped modifiers select the base level and consume the mask.
        assert_eq!(kind.level(0x10), (0, 0x83));
        assert_eq!(kind.level(0x01 | 0x10), (1, 0x83));
        assert_eq!(kind.level(0x82), (2, 0x81));
    }

    const CAPS: Option<u32> = Some(LOCK_MASK as u32);

    #[test]
    fn caps_lock_text_is_sent_as_the_keysym_that_arrives_as_requested() {
        let us = keymap(&[
            (38, &[&[0x61, 0x41]]), // a A: ALPHABETIC
            (10, &[&[0x31, 0x21]]), // 1 !: TWO_LEVEL
            (47, &[&[0x3b, 0x3a]]), // ; :
            (50, &[&[SHIFT_L]]),
        ]);
        // Caps Lock gives the capital at the base level, so `a` is sent as `A`
        // (with Shift, which Caps Lock turns back into the small letter), and
        // `A` as `a`. Keys Lock does not affect are sent as they are.
        assert_eq!(us.text_keysym('a', Some(0), CAPS), Some(0x41));
        assert_eq!(us.text_keysym('A', Some(0), CAPS), Some(0x61));
        assert_eq!(us.text_keysym('1', Some(0), CAPS), Some(0x31));
        assert_eq!(us.text_keysym('!', Some(0), CAPS), Some(0x21));
        // Without a lock, or another lock (NumLock is Mod2), nothing changes.
        for locked in [None, Some(0), Some(0x10)] {
            assert_eq!(us.text_keysym('a', Some(0), locked), Some(0x61));
            assert_eq!(us.text_keysym('A', Some(0), locked), Some(0x41));
        }
        // Shift Lock (Caps Lock locking Shift) shifts every key, so neither
        // `1` nor `a` can be typed.
        let shift_lock = Some(u32::from(SHIFT));
        assert_eq!(us.text_keysym('1', Some(0), shift_lock), None);
        assert_eq!(us.text_keysym('!', Some(0), shift_lock), Some(0x21));
        assert_eq!(us.text_keysym('a', Some(0), shift_lock), None);
        assert_eq!(us.text_keysym('A', Some(0), shift_lock), Some(0x41));
    }

    #[test]
    fn caps_lock_capitalizes_letters_whose_key_type_ignores_lock() {
        // é alone on a two-level key that is not a letter pair: Lock is not
        // consumed, so applications capitalize it and only `É` can be typed.
        let keymap = keymap(&[
            (20, &[&[0xe9, 0x32]]),
            (21, &[&[0xc9]]),
            (50, &[&[SHIFT_L]]),
        ]);
        assert_eq!(keymap.text_keysym('é', Some(0), CAPS), None);
        assert_eq!(keymap.text_keysym('É', Some(0), CAPS), Some(0xc9));
        assert_eq!(keymap.text_keysym('2', Some(0), CAPS), Some(0x32));
        assert_eq!(keymap.text_keysym('é', Some(0), None), Some(0xe9));
        // Without a key of its own, `É` is the capitalized `é`.
        let keymap = self::keymap(&[(20, &[&[0xe9, 0x32]]), (50, &[&[SHIFT_L]])]);
        assert_eq!(keymap.text_keysym('É', Some(0), CAPS), Some(0xe9));
        assert_eq!(keymap.text_keysym('É', Some(0), None), None);
    }

    #[test]
    fn caps_lock_follows_the_active_group_and_altgr_levels() {
        // ru,us letter keys, and de's q key with `@` on the AltGr level.
        let ru_us = keymap(&[(54, &[&[0x6d3, 0x6f3], &[0x63, 0x43]]), (50, &[&[SHIFT_L]])]);
        assert_eq!(ru_us.text_keysym('с', Some(0), CAPS), Some(0x6f3));
        assert_eq!(ru_us.text_keysym('С', Some(0), CAPS), Some(0x6d3));
        assert_eq!(ru_us.text_keysym('c', Some(1), CAPS), Some(0x43));
        assert_eq!(ru_us.text_keysym('c', Some(0), CAPS), None);
        let de = keymap(&[
            (24, &[&[0x71, 0x51, 0x40, 0x7d9]]),
            (50, &[&[SHIFT_L]]),
            (92, &[&[ISO_LEVEL3_SHIFT]]),
        ]);
        assert_eq!(de.text_keysym('q', Some(0), CAPS), Some(0x51));
        // AltGr with Caps Lock still gives `@`; Lock is preserved there and
        // `@` has no capital.
        assert_eq!(de.text_keysym('@', Some(0), CAPS), Some(0x40));
    }

    #[test]
    fn capitalization_is_predicted_only_for_single_character_capitals() {
        assert!(gives(0x61, 'a', false));
        assert!(!gives(0x61, 'a', true));
        assert!(gives(0x61, 'A', true));
        assert!(gives(0x41, 'A', true));
        assert!(gives(0x31, '1', true));
        // ß capitalizes to two letters; what an application does is unknown.
        assert!(!gives(0xdf, 'ß', true));
    }

    #[test]
    fn a_key_with_fewer_groups_resolves_like_libxkbcommon() {
        let mut key = LayoutKey {
            keycode: 9,
            groups: vec![vec![1], vec![2]],
            kinds: vec![0, 0],
            mods: 0,
            out_of_range: OutOfRange::Wrap,
        };
        assert_eq!(key.group(2), Some(&[1][..]));
        assert_eq!(key.group(3), Some(&[2][..]));
        key.out_of_range = OutOfRange::Clamp;
        assert_eq!(key.group(3), Some(&[2][..]));
        key.out_of_range = OutOfRange::Redirect(1);
        assert_eq!(key.group(2), Some(&[2][..]));
        key.out_of_range = OutOfRange::Redirect(3);
        assert_eq!(key.group(2), Some(&[1][..]));
        key.groups.clear();
        assert_eq!(key.group(0), None);
    }

    #[test]
    fn mirrors_the_first_keycode_and_level_the_compositor_picks() {
        // The keysym on a lower keycode's fourth level wins over a later
        // keycode's base level, and the compositor sends that level unshifted.
        let shadowed = keymap(&[
            (10, &[&[0x31, 0x21, 0xb9, 0x40]]),
            (11, &[&[0x40, 0x40]]),
            (50, &[&[SHIFT_L]]),
            (92, &[&[ISO_LEVEL3_SHIFT]]),
        ]);
        assert_eq!(shadowed.level(0x40, 0), Some(3));
        assert!(!shadowed.types(0x40, Some(0)));
        // The highest keycode is outside the scan.
        let last = LayoutKeymap {
            max_keycode: 11,
            ..keymap(&[(11, &[&[0x40]])])
        };
        assert!(!last.types(0x40, Some(0)));
    }
}
