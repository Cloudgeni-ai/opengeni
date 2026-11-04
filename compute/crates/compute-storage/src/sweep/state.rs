//! The record a sweep keeps of what it did, for the next: which periods
//! are still to list, and what the pointers it kept held. It only picks
//! what the next sweep looks at, never what it may delete.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::time::SystemTime;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use bytes::Bytes;
use serde::{Deserialize, Serialize};

use super::{AUDIT_EVERY, tried};
use crate::Result;
use crate::fresh::{CLOCK_SKEW, day_of, period_of, sweepable};
use crate::store::ChunkStore;

/// Where, below the sweep's records, it is kept.
const KEY: &str = "v1/state.json";

const VERSION: u32 = 1;

/// The most hours a sweep adds to list one by one; a store unswept for
/// longer (over a month) is listed whole again instead.
const MOST_HOURS: u32 = 31 * 24;

/// What a sweep lists in one go: a period, or the old layout.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Piece {
    Period(u32),
    Legacy,
}

impl fmt::Display for Piece {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Period(period) => write!(f, "period {period}"),
            Self::Legacy => f.write_str("the old layout"),
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub(super) struct State {
    version: u32,
    /// When the last sweep that began listing every period again began,
    /// in milliseconds since 1970.
    audited_ms: u64,
    /// The last hour and day up to which every period a sweep may delete
    /// from was found: listed, or among those still to list.
    hours_through: u32,
    days_through: u32,
    /// The periods still to list.
    unsettled: BTreeSet<u32>,
    /// Whether the old layout is still to list.
    legacy: bool,
    /// What each pointer that named something held when the last sweep
    /// kept it (base64), by name.
    pointers: BTreeMap<String, String>,
    /// Earlier pointers (base64) not every object of which could be read
    /// to find what they named, so the next sweep tries again.
    retired: BTreeSet<String>,
    /// Keys a delete of which failed.
    pub pending: BTreeSet<String>,
}

impl State {
    /// The record the last sweep kept; `None` if there is none, or none
    /// this build reads, so this sweep lists everything.
    pub async fn load(store: &ChunkStore) -> Result<Option<Self>> {
        let Some(bytes) = tried("reading the sweep's record", || store.get_record(KEY)).await?
        else {
            return Ok(None);
        };
        match serde_json::from_slice::<Self>(&bytes) {
            Ok(state) if state.version == VERSION => Ok(Some(state)),
            Ok(_) | Err(_) => {
                tracing::warn!("sweep: a record this build does not read; listing every period");
                Ok(None)
            }
        }
    }

    /// Keeps it for the next sweep; a failure only costs that sweep work.
    pub async fn save(&mut self, store: &ChunkStore) {
        self.version = VERSION;
        let saved = match serde_json::to_vec(self) {
            Ok(bytes) => store.put_record(KEY, Bytes::from(bytes)).await,
            Err(error) => Err(error.into()),
        };
        if let Err(error) = saved {
            tracing::warn!(%error, "sweep: could not keep its record; the next sweep does more");
        }
    }

    /// Whether a sweep beginning at `began` lists every period again: none
    /// did, or it was a day ago, or a sweep was last a month ago.
    pub fn due(state: Option<&Self>, began: SystemTime) -> bool {
        state.is_none_or(|state| {
            millis(began) >= state.audited_ms.saturating_add(millis_of(AUDIT_EVERY))
                || last_hour(began).saturating_sub(state.hours_through) > MOST_HOURS
        })
    }

    /// Begins listing every period again: those of `found` a sweep
    /// beginning at `began` may delete from, and the old layout.
    pub fn audit(&mut self, found: impl IntoIterator<Item = u32>, began: SystemTime) {
        self.unsettled
            .extend(found.into_iter().filter(|&period| sweepable(period, began)));
        self.legacy = true;
        self.audited_ms = millis(began);
        // Every period stored was found, so later ones are new.
        self.hours_through = self.hours_through.max(last_hour(began));
        self.days_through = self.days_through.max(last_day(began));
    }

    /// Adds the periods a sweep beginning at `began` may delete from that
    /// no earlier sweep could.
    pub fn extend(&mut self, began: SystemTime) {
        let (hours, days) = (last_hour(began), last_day(began));
        if hours > self.hours_through && hours - self.hours_through <= MOST_HOURS {
            self.unsettled.extend(self.hours_through + 1..=hours);
            self.hours_through = hours;
        }
        // Days stopped once writers named hours, so these are listed only
        // in case a writer of an earlier release is still live: one
        // listing of nothing a day.
        if days > self.days_through && days - self.days_through <= MOST_HOURS / 24 {
            self.unsettled.extend(self.days_through + 1..=days);
            self.days_through = days;
        }
    }

    /// What is still to list: the newest periods first, where what a
    /// replaced copy alone named is, then the old layout.
    pub fn pieces(&self) -> Vec<Piece> {
        let periods = self
            .unsettled
            .iter()
            .rev()
            .map(|&period| Piece::Period(period));
        periods
            .chain(self.legacy.then_some(Piece::Legacy))
            .collect()
    }

    pub fn settle(&mut self, piece: Piece) {
        match piece {
            Piece::Period(period) => {
                self.unsettled.remove(&period);
            }
            Piece::Legacy => self.legacy = false,
        }
    }

    pub fn left(&self) -> usize {
        self.unsettled.len() + usize::from(self.legacy)
    }

    /// What each pointer held at the last sweep, by name, and the earlier
    /// pointers whose names are still to read.
    pub fn held(&self) -> (BTreeMap<String, Vec<u8>>, Vec<Vec<u8>>) {
        let held = self
            .pointers
            .iter()
            .filter_map(|(name, bytes)| Some((name.clone(), STANDARD.decode(bytes).ok()?)))
            .collect();
        let retired = self
            .retired
            .iter()
            .filter_map(|bytes| STANDARD.decode(bytes).ok())
            .collect();
        (held, retired)
    }

    /// Keeps what each pointer holds now, and the earlier pointers whose
    /// names are still to read.
    pub fn hold(&mut self, held: &BTreeMap<String, Vec<u8>>, retired: &[Vec<u8>]) {
        self.pointers = held
            .iter()
            .map(|(name, bytes)| (name.clone(), STANDARD.encode(bytes)))
            .collect();
        self.retired = retired.iter().map(|bytes| STANDARD.encode(bytes)).collect();
    }
}

/// The last hour, and day, a sweep beginning at `began` may delete from.
fn last_hour(began: SystemTime) -> u32 {
    last(began, period_of)
}

fn last_day(began: SystemTime) -> u32 {
    last(began, day_of)
}

fn last(began: SystemTime, period: fn(SystemTime) -> u32) -> u32 {
    let Some(at) = began.checked_sub(CLOCK_SKEW) else {
        return 0;
    };
    let period = period(at);
    if sweepable(period, began) {
        period
    } else {
        period.saturating_sub(1)
    }
}

fn millis(at: SystemTime) -> u64 {
    at.duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, millis_of)
}

fn millis_of(duration: std::time::Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::fresh::FIRST_HOUR;

    #[test]
    fn the_last_period_a_sweep_may_delete_from_ended_the_skew_before() {
        let began = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        let hour = last_hour(began);
        assert!(hour >= FIRST_HOUR);
        assert!(sweepable(hour, began) && !sweepable(hour + 1, began));
        let day = last_day(began);
        assert!(day < FIRST_HOUR);
        assert!(sweepable(day, began) && !sweepable(day + 1, began));
    }

    #[test]
    fn new_hours_are_added_once_and_a_month_unswept_lists_everything_again() {
        let began = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        let mut state = State::default();
        assert!(State::due(None, began));
        state.audit([last_hour(began) + 1, last_hour(began), 7], began);
        assert_eq!(
            state.left(),
            3,
            "the hour stored too recently waits; the day and the old layout"
        );
        assert!(!State::due(Some(&state), began));
        let later = began + Duration::from_secs(3 * 3_600);
        state.extend(later);
        assert_eq!(state.left(), 6, "three more hours");
        state.extend(later);
        assert_eq!(state.left(), 6, "added once");
        assert!(State::due(Some(&state), began + AUDIT_EVERY));
        let month = began + Duration::from_secs(40 * 86_400);
        assert!(State::due(Some(&state), month));
        state.extend(month);
        assert_eq!(state.left(), 6, "over a month's are not added one by one");
    }
}
