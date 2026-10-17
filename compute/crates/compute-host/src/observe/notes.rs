//! What a running step notes about itself for its event: its first error,
//! time per phase, bytes moved and alarms, kept in a task-local so no
//! function between the step and the note has to carry them.
//!
//! Notes outside a step (no scope) go nowhere.

use std::cell::RefCell;
use std::fmt::Display;
use std::future::Future;
use std::time::{Duration, Instant};

use super::metrics::Alarm;

/// Everything a step noted.
#[derive(Debug, Default)]
pub(crate) struct Notes {
    /// The first error the step met.
    pub error: Option<String>,
    /// Time per phase, in order.
    pub phases: Vec<(&'static str, Duration)>,
    /// Bytes moved, by what moved them.
    pub bytes: Vec<(&'static str, u64)>,
    /// Facts about how the step went, such as where a restore's memory
    /// came from.
    pub details: Vec<(&'static str, &'static str)>,
    /// Alarms raised, with what happened.
    pub alarms: Vec<(Alarm, String)>,
    /// When the current phase began.
    mark: Option<Instant>,
}

tokio::task_local! {
    static NOTES: RefCell<Notes>;
}

/// Runs `work` collecting its notes.
pub(crate) async fn scope<F: Future>(work: F) -> (F::Output, Notes) {
    let notes = Notes {
        mark: Some(Instant::now()),
        ..Notes::default()
    };
    NOTES
        .scope(RefCell::new(notes), async {
            let output = work.await;
            (output, NOTES.with(RefCell::take))
        })
        .await
}

fn with(note: impl FnOnce(&mut Notes)) {
    let _ = NOTES.try_with(|notes| note(&mut notes.borrow_mut()));
}

/// Keeps `error` as the step's error, unless it already met one.
pub(crate) fn error(error: &dyn Display) {
    with(|notes| {
        notes.error.get_or_insert_with(|| error.to_string());
    });
}

/// Ends the current phase as `name`: its time is from the end of the
/// previous phase, or the step's start, until now. A phase noted twice
/// adds up.
pub(crate) fn phase(name: &'static str) {
    with(|notes| {
        let now = Instant::now();
        let took = notes.mark.map_or(Duration::ZERO, |mark| now - mark);
        notes.mark = Some(now);
        match notes.phases.iter_mut().find(|(known, _)| *known == name) {
            Some((_, total)) => *total += took,
            None => notes.phases.push((name, took)),
        }
    });
}

/// Adds `count` bytes moved as `what`, such as `uploaded`.
pub(crate) fn bytes(what: &'static str, count: u64) {
    with(
        |notes| match notes.bytes.iter_mut().find(|(known, _)| *known == what) {
            Some((_, total)) => *total = total.saturating_add(count),
            None => notes.bytes.push((what, count)),
        },
    );
}

/// Notes `value` as the step's `key`, replacing an earlier one.
pub(crate) fn detail(key: &'static str, value: &'static str) {
    with(|notes| {
        notes.details.retain(|(known, _)| *known != key);
        notes.details.push((key, value));
    });
}

/// Raises `alarm` for the step's sandbox.
pub(crate) fn alarm(alarm: Alarm, what: &dyn Display) {
    with(|notes| notes.alarms.push((alarm, what.to_string())));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn notes_are_kept_inside_a_scope_and_dropped_outside() {
        error(&"outside");
        let ((), notes) = scope(async {
            phase("verify");
            tokio::task::yield_now().await;
            error(&"first");
            error(&"second");
            bytes("fetched", 3);
            bytes("fetched", 4);
            phase("load");
            phase("verify");
            alarm(Alarm::Quarantined, &"image 7");
        })
        .await;
        assert_eq!(notes.error.as_deref(), Some("first"));
        assert_eq!(notes.bytes, vec![("fetched", 7)]);
        let names: Vec<_> = notes.phases.iter().map(|(name, _)| *name).collect();
        assert_eq!(names, ["verify", "load"]);
        assert_eq!(
            notes.alarms,
            vec![(Alarm::Quarantined, "image 7".to_owned())]
        );
    }
}
