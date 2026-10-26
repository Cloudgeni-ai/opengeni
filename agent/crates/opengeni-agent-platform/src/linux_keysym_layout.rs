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
use x11rb::protocol::xproto::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;

const SHIFT_L: u32 = 0xffe1;
const ISO_LEVEL3_SHIFT: u32 = 0xfe03;

/// What the compositor reports about its keyboard layout, when it does.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CompositorLayout {
    /// The active layout group, the only one the compositor types from.
    pub active_group: Option<u32>,
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct LayoutKey {
    keycode: u8,
    /// Per group, the keysym of each shift level the group's key type has.
    groups: Vec<Vec<u32>>,
    out_of_range: OutOfRange,
}

impl LayoutKey {
    /// The group of this key that `layout` selects, as libxkbcommon resolves it.
    fn group(&self, layout: usize) -> Option<&[u32]> {
        let count = self.groups.len();
        if count == 0 {
            return None;
        }
        let index = if layout < count {
            layout
        } else {
            match self.out_of_range {
                OutOfRange::Wrap => layout % count,
                OutOfRange::Clamp => count - 1,
                OutOfRange::Redirect(group) if group < count => group,
                OutOfRange::Redirect(_) => 0,
            }
        };
        self.groups.get(index).map(Vec::as_slice)
    }
}

/// A keyboard layout as a compositor resolving keysyms per group sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LayoutKeymap {
    keys: Vec<LayoutKey>,
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
        let parts = xkb::MapPart::KEY_TYPES | xkb::MapPart::KEY_SYMS;
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
        let levels: Vec<u8> = reply
            .map
            .types_rtrn?
            .iter()
            .map(|kind| kind.num_levels)
            .collect();
        let keys = reply
            .map
            .syms_rtrn?
            .iter()
            .zip(reply.first_key_sym..=u8::MAX)
            .map(|(map, keycode)| LayoutKey::from_xkb(keycode, map, &levels))
            .collect();
        Some(Self {
            keys,
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
        self.keys
            .iter()
            .filter(|key| key.keycode < self.max_keycode)
            .filter_map(|key| key.group(layout))
            .find_map(|levels| levels.iter().position(|&candidate| candidate == keysym))
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
        let layouts = self.layouts();
        match active.and_then(|layout| usize::try_from(layout).ok()) {
            Some(layout) if layout < layouts => self.types_in(keysym, layout),
            _ => layouts > 0 && (0..layouts).all(|layout| self.types_in(keysym, layout)),
        }
    }
}

impl LayoutKey {
    fn from_xkb(keycode: u8, map: &xkb::KeySymMap, levels: &[u8]) -> Self {
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
        let out_of_range = match map.group_info & 0xc0 {
            0x40 => OutOfRange::Clamp,
            0x80 => OutOfRange::Redirect(usize::from((map.group_info >> 4) & 0x03)),
            _ => OutOfRange::Wrap,
        };
        Self {
            keycode,
            groups,
            out_of_range,
        }
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    /// A keymap from rows of (keycode, per-group levels), wrapping groups.
    pub(in crate::linux) fn keymap(rows: &[(u8, &[&[u32]])]) -> LayoutKeymap {
        LayoutKeymap {
            keys: rows
                .iter()
                .map(|(keycode, groups)| LayoutKey {
                    keycode: *keycode,
                    groups: groups.iter().map(|levels| levels.to_vec()).collect(),
                    out_of_range: OutOfRange::Wrap,
                })
                .collect(),
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
        let key = LayoutKey::from_xkb(24, &map, &[2, 4]);
        assert_eq!(
            key.groups,
            vec![vec![0x71, 0x51], vec![0x6ca, 0x6ea, 0x40, 0]]
        );
        assert_eq!(key.out_of_range, OutOfRange::Wrap);
        let clamp = xkb::KeySymMap {
            group_info: 0x41,
            ..map.clone()
        };
        assert_eq!(
            LayoutKey::from_xkb(24, &clamp, &[2, 4]).out_of_range,
            OutOfRange::Clamp
        );
        let redirect = xkb::KeySymMap {
            group_info: 0x91,
            ..map
        };
        assert_eq!(
            LayoutKey::from_xkb(24, &redirect, &[2, 4]).out_of_range,
            OutOfRange::Redirect(1)
        );
    }

    #[test]
    fn a_key_with_fewer_groups_resolves_like_libxkbcommon() {
        let mut key = LayoutKey {
            keycode: 9,
            groups: vec![vec![1], vec![2]],
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
