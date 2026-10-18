//! Restore notices from the host agent, as `compute-host`'s
//! `restore_notice` module sends them:
//!
//! ```text
//! restored <unix time in nanoseconds> sandbox=<sandbox id> seed=<hex> order=<generation>.<revision>
//! ```
//!
//! The guest applies notices one at a time and ignores one whose order is
//! below the latest it applied ([`Orders`]); a retry of the same notice is
//! applied again. The host's `activity` question is answered with the
//! count Opengeni's agent registers (see [`crate::agent`]); any other line
//! is not answered.

use crate::cmdline::valid_sandbox;

/// Where a notice stands among those sent to one sandbox: the record's
/// generation, then its revision.
pub type Order = (u64, u64);

/// A parsed `restored` line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    /// The host's time, in nanoseconds since the Unix epoch.
    pub nanos: u64,
    /// The sandbox the guest now is, if the notice names a valid one.
    pub sandbox: Option<String>,
    /// The seed as the host sent it, in hex, if it is valid hex.
    pub seed_hex: Option<String>,
    pub order: Order,
}

/// The longest line a guest reads.
pub const MAX_LINE: usize = 512;

impl Notice {
    /// Parses one line, without its newline. `None` for any line the guest
    /// must not act on: another word, no time, or no valid order.
    #[must_use]
    pub fn parse(line: &str) -> Option<Self> {
        let mut words = line.split_whitespace();
        if words.next()? != "restored" {
            return None;
        }
        let nanos = words.next()?.parse().ok()?;
        let (mut sandbox, mut seed_hex, mut order) = (None, None, None);
        for field in words {
            let (key, value) = field.split_once('=').unwrap_or((field, ""));
            match key {
                "sandbox" => sandbox = valid_sandbox(value).then(|| value.to_owned()),
                "seed" => seed_hex = decode_hex(value).is_some().then(|| value.to_owned()),
                "order" => order = parse_order(value),
                _ => {}
            }
        }
        Some(Self {
            nanos,
            sandbox,
            seed_hex,
            order: order?,
        })
    }

    /// The seed's bytes.
    #[must_use]
    pub fn seed(&self) -> Option<Vec<u8>> {
        self.seed_hex.as_deref().and_then(decode_hex)
    }
}

fn parse_order(value: &str) -> Option<Order> {
    let (generation, revision) = value.split_once('.')?;
    Some((generation.parse().ok()?, revision.parse().ok()?))
}

/// Decodes non-empty hex of even length.
#[must_use]
pub fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    if hex.is_empty() || !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect()
}

/// The guest's answer once it applied a notice.
#[must_use]
pub fn answer(seeded: bool) -> &'static [u8] {
    if seeded { b"ok seeded\n" } else { b"ok\n" }
}

/// The latest order applied; notices below it are stale.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Orders {
    latest: Option<Order>,
}

impl Orders {
    /// Whether a notice at `order` may be applied: not below the latest.
    #[must_use]
    pub fn admits(&self, order: Order) -> bool {
        self.latest.is_none_or(|latest| order >= latest)
    }

    /// Records that the notice at `order` was applied.
    pub fn applied(&mut self, order: Order) {
        if self.admits(order) {
            self.latest = Some(order);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_hosts_line() {
        let notice = Notice::parse(
            "restored 1760000000123456789 sandbox=abc seed=00ff10 order=3.17 later=field",
        )
        .unwrap();
        assert_eq!(
            notice,
            Notice {
                nanos: 1_760_000_000_123_456_789,
                sandbox: Some("abc".into()),
                seed_hex: Some("00ff10".into()),
                order: (3, 17),
            }
        );
        assert_eq!(notice.seed(), Some(vec![0x00, 0xff, 0x10]));
    }

    #[test]
    fn refuses_lines_it_must_not_act_on() {
        for line in [
            "",
            "activity",
            "restore 1 order=1.1",
            "restored order=1.1",
            "restored x order=1.1",
            "restored 1",
            "restored 1 order=1",
            "restored 1 order=1.x",
            "restored -1 order=1.1",
        ] {
            assert_eq!(Notice::parse(line), None, "{line:?}");
        }
    }

    #[test]
    fn drops_fields_it_cannot_use() {
        let notice = Notice::parse("restored 5 sandbox=a/b seed=0g order=1.2 seed").unwrap();
        assert_eq!(notice.sandbox, None);
        assert_eq!(notice.seed_hex, None);
        assert_eq!(notice.seed(), None);
        assert_eq!(
            Notice::parse("restored 5 seed=abc order=0.0")
                .unwrap()
                .seed_hex,
            None
        );
    }

    #[test]
    fn answers_say_whether_it_seeded() {
        assert_eq!(answer(true), b"ok seeded\n");
        assert_eq!(answer(false), b"ok\n");
    }

    #[test]
    fn notices_below_the_latest_are_stale_and_retries_apply_again() {
        let mut orders = Orders::default();
        assert!(orders.admits((0, 0)));
        orders.applied((2, 5));
        assert!(orders.admits((2, 5)), "a retry of the same notice");
        assert!(orders.admits((2, 6)));
        assert!(orders.admits((3, 0)), "generation before revision");
        assert!(!orders.admits((2, 4)));
        assert!(!orders.admits((1, 99)));
        orders.applied((1, 99));
        assert!(!orders.admits((2, 4)), "a stale one never lowers it");
        orders.applied((3, 0));
        assert!(!orders.admits((2, 99)));
    }
}
