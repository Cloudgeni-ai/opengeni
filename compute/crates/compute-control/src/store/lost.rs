//! Copies of sandboxes lost with their hosts.
//!
//! A host the service gives up on keeps owning its sandboxes: it may come
//! back with copies newer than the store's, so they wait for it. Only once
//! its copies are known gone, or an operator declares them so, does each
//! sandbox go on from its newest stored copy, which may be older than what
//! ran last. The row then notes the loss ([`LostCopy`]), so whoever uses
//! the sandbox is told what point in time it went back to; and should the
//! host come back after all, it sets its copies aside rather than dropping
//! them, so nothing newer is ever deleted unseen.

use std::fmt::Write as _;

use serde::{Deserialize, Serialize};

/// Why a host's copies were given up for gone.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Gone {
    /// An operator declared the host gone for good.
    Declared,
    /// Its machine was found deleted, disks and all.
    Deleted,
}

/// A sandbox's copy on a host given up for gone, as the sandbox's row
/// notes it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LostCopy {
    /// The host it was on, by name.
    pub host: String,
    pub why: Gone,
    /// When, in milliseconds since the Unix epoch.
    pub at_ms: u64,
    /// The owner epoch the loss raised the sandbox to: a copy the host
    /// lists under an earlier one is set aside, never dropped.
    pub epoch: u64,
    /// When its newest stored copy, which it goes on from, was saved, in
    /// milliseconds since the Unix epoch, if known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_ms: Option<u64>,
    /// When the host came back after all and set its copy aside, if it did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub set_aside_ms: Option<u64>,
}

/// A sandbox that went on from its stored copy as its host was given up
/// for gone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Forsaken {
    pub id: compute_protocol::host::Id,
    /// When its newest stored copy was saved, if known.
    pub saved_ms: Option<u64>,
}

/// What the people using a sandbox are told of a loss, in plain words.
#[must_use]
pub fn notice(lost: &LostCopy) -> String {
    let saved = lost.saved_ms.map_or_else(
        || "its newest stored copy".to_owned(),
        |saved| format!("its stored copy saved at {}", rfc3339(saved)),
    );
    let why = match lost.why {
        Gone::Declared => "was declared gone by an operator",
        Gone::Deleted => "was found deleted",
    };
    let mut notice = format!(
        "Its host {} {why} at {}, so the sandbox went back to {saved}; anything written after that \
         save, and every program it was running, was lost with the host.",
        lost.host,
        rfc3339(lost.at_ms)
    );
    if let Some(aside) = lost.set_aside_ms {
        let _ = write!(
            notice,
            " The host came back at {} and set its own copy aside on its disk, untouched.",
            rfc3339(aside)
        );
    }
    notice
}

/// `ms` since the Unix epoch as an RFC 3339 time in UTC, to the second.
#[must_use]
pub fn rfc3339(ms: u64) -> String {
    let secs = ms / 1000;
    let (days, rest) = (secs / 86_400, secs % 86_400);
    let (hour, minute, second) = (rest / 3600, rest % 3600 / 60, rest % 60);
    // Days to a civil date (Howard Hinnant's algorithm).
    let z = i64::try_from(days).unwrap_or(i64::MAX / 2) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_read_as_utc() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_793_920_980_000), "2026-11-05T23:23:00Z");
        assert_eq!(rfc3339(951_782_400_000), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn a_notice_says_what_it_went_back_to() {
        let mut lost = LostCopy {
            host: "host-a".into(),
            why: Gone::Declared,
            at_ms: 1_793_925_000_000,
            epoch: 4,
            saved_ms: Some(1_793_920_980_000),
            set_aside_ms: None,
        };
        let told = notice(&lost);
        assert!(told.contains("host-a was declared gone"), "{told}");
        assert!(told.contains("saved at 2026-11-05T23:23:00Z"), "{told}");
        lost.set_aside_ms = Some(1_793_926_000_000);
        assert!(notice(&lost).contains("set its own copy aside"));
    }
}
