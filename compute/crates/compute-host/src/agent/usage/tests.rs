use std::time::Duration;

use tokio::time::Instant;

use super::{BusyRule, Usage};
use crate::step::Reading;

const RULE: BusyRule = BusyRule::DEFAULT;

/// A reading of VM process `incarnation`, `secs` after `start`, with
/// `cpu_ms` of processor time and `io` bytes of traffic so far.
fn reading(start: Instant, secs: u64, incarnation: u64, cpu_ms: u64, io: u64) -> Reading {
    Reading {
        incarnation,
        at: start + Duration::from_secs(secs),
        cpu: Some(Duration::from_millis(cpu_ms)),
        io: Some(io),
        last_before_pause: false,
    }
}

/// A guest using half a processor and moving nothing, read at `secs`.
fn busy_at(start: Instant, secs: u64) -> Reading {
    reading(start, secs, 1, secs * 500, 0)
}

/// A guest using a hundredth of a processor and moving nothing.
fn quiet_at(start: Instant, secs: u64) -> Reading {
    reading(start, secs, 1, secs * 10, 0)
}

#[test]
fn a_quiet_guest_is_never_busy() {
    let start = Instant::now();
    let mut usage = Usage::default();
    for secs in 0..60 {
        assert!(
            !usage.sample(Some(quiet_at(start, secs)), RULE),
            "at {secs} s"
        );
    }
    assert!(!usage.unseen());
}

#[test]
fn a_busy_guest_counts_once_a_full_window_passed() {
    let start = Instant::now();
    let mut usage = Usage::default();
    let busy: Vec<u64> = (0..=10)
        .filter(|&secs| usage.sample(Some(busy_at(start, secs)), RULE))
        .collect();
    // Windows of five seconds: judged at 5 and 10.
    assert_eq!(busy, [5, 10]);
}

/// The regression the review found: a lazily woken guest's checkpoint
/// waits for its hydration before capturing, and the agent cannot read the
/// VM meanwhile. The step lends its readings from the start, so a guest
/// working through that wait stays busy instead of falling asleep after
/// the checkpoint.
#[test]
fn a_guest_working_while_a_checkpoint_waits_to_capture_stays_busy() {
    let start = Instant::now();
    let mut usage = Usage::default();
    assert!(!usage.sample(Some(busy_at(start, 0)), RULE));
    usage.step_started(true);
    let mut busy = Vec::new();
    for secs in 1..=30 {
        assert!(!usage.lend(busy_at(start, secs), Some(RULE)));
        if usage.sample(None, RULE) {
            busy.push(secs);
        }
    }
    assert_eq!(busy, [5, 10, 15, 20, 25, 30]);
}

#[test]
fn until_a_checkpoint_lends_a_reading_the_window_goes_on() {
    let start = Instant::now();
    let mut usage = Usage::default();
    assert!(!usage.sample(Some(busy_at(start, 0)), RULE));
    usage.step_started(true);
    for _ in 0..3 {
        assert!(!usage.sample(None, RULE));
    }
    assert!(usage.window.is_some(), "the window was dropped");
    // The first reading lent is judged against the window open before the
    // step.
    assert!(!usage.lend(busy_at(start, 6), Some(RULE)));
    assert!(usage.sample(None, RULE));
}

#[test]
fn the_last_reading_before_the_pause_is_judged_at_once_and_ends_the_window() {
    let start = Instant::now();
    let mut usage = Usage::default();
    assert!(!usage.sample(Some(busy_at(start, 0)), RULE));
    usage.step_started(true);
    // Two seconds into the window: early, but a rate shows in part of one.
    assert!(usage.lend(busy_at(start, 2).before_pause(), Some(RULE)));
    assert!(usage.window.is_none());
    assert!(usage.lent.is_none());
    // A quiet guest's last reading is judged too, and is not busy.
    let mut quiet = Usage::default();
    assert!(!quiet.sample(Some(quiet_at(start, 0)), RULE));
    quiet.step_started(true);
    assert!(!quiet.lend(quiet_at(start, 3).before_pause(), Some(RULE)));
    assert!(quiet.window.is_none());
    // Without a busy rule nothing is judged, but the window still ends.
    let mut unruled = Usage::default();
    assert!(!unruled.sample(Some(busy_at(start, 0)), RULE));
    assert!(!unruled.lend(busy_at(start, 2).before_pause(), None));
    assert!(unruled.window.is_none());
}

#[test]
fn the_capture_does_not_count_as_a_quiet_guest_s_work() {
    let start = Instant::now();
    let mut usage = Usage::default();
    assert!(!usage.sample(Some(quiet_at(start, 0)), RULE));
    usage.step_started(true);
    assert!(!usage.sample(None, RULE));
    assert!(!usage.lend(quiet_at(start, 2).before_pause(), Some(RULE)));
    // The VM's processor time jumps by four seconds while it is paused and
    // captured, which a window spanning the pause would count.
    let jump = 4_000;
    let after = |secs: u64| reading(start, secs, 1, secs * 10 + jump, 0);
    let mut busy = Vec::new();
    for secs in 3..=20 {
        assert!(!usage.lend(after(secs), Some(RULE)));
        if usage.sample(None, RULE) {
            busy.push(secs);
        }
    }
    assert!(busy.is_empty(), "busy at {busy:?}");
    // The checkpoint ends: its last window is quiet too.
    assert!(!usage.judge_now(&after(21), RULE));
}

#[test]
fn a_short_window_at_a_checkpoint_s_end_is_judged_at_once() {
    let start = Instant::now();
    let mut usage = Usage::default();
    usage.step_started(true);
    assert!(!usage.lend(busy_at(start, 10), Some(RULE)));
    assert!(!usage.sample(None, RULE));
    // A second after the resume, well short of a window.
    assert!(usage.judge_now(&busy_at(start, 11), RULE));
    assert!(!usage.judge_now(&reading(start, 11, 1, 10 * 500 + 10, 0), RULE));
    // Judging leaves the window open.
    assert!(usage.window.is_some());
}

#[test]
fn readings_of_another_vm_process_are_not_compared() {
    let start = Instant::now();
    let mut usage = Usage::default();
    assert!(!usage.sample(Some(reading(start, 0, 1, 0, 0)), RULE));
    // A new process starts its counters over; a far larger total from it
    // means nothing against the old one's.
    let other = reading(start, 6, 2, 60_000, 1 << 30);
    assert!(!usage.judge_now(&other, RULE));
    assert!(!usage.sample(Some(other), RULE));
    // Its window starts there.
    assert!(usage.sample(Some(reading(start, 12, 2, 60_000 + 6_000, 1 << 30)), RULE));
}

#[test]
fn a_guest_nothing_can_be_read_of_counts_as_busy_and_unseen() {
    let start = Instant::now();
    let mut usage = Usage::default();
    let blind = Reading {
        cpu: None,
        io: None,
        ..quiet_at(start, 0)
    };
    assert!(usage.sample(Some(blind), RULE));
    assert!(usage.unseen());
    // Readable again: a window starts and the sandbox is seen.
    assert!(!usage.sample(Some(quiet_at(start, 1)), RULE));
    assert!(!usage.unseen());
}

#[test]
fn one_signal_that_cannot_be_read_leaves_the_other_to_judge() {
    let start = Instant::now();
    let mut usage = Usage::default();
    let no_cpu = |secs: u64, io: u64| Reading {
        cpu: None,
        ..reading(start, secs, 1, 0, io)
    };
    assert!(!usage.sample(Some(no_cpu(0, 0)), RULE));
    // 40 KiB over five seconds is twice the rule's traffic bar.
    assert!(usage.sample(Some(no_cpu(5, 40 << 10)), RULE));
    assert!(!usage.unseen());
    assert!(!usage.sample(Some(no_cpu(10, 40 << 10)), RULE));
}

#[test]
fn a_step_that_stops_the_guest_ends_the_window() {
    let start = Instant::now();
    let mut usage = Usage::default();
    assert!(!usage.sample(Some(quiet_at(start, 0)), RULE));
    usage.step_started(false);
    assert!(usage.window.is_none());
    // A pause and resume between two readings: the jump is the steps'
    // work, and the window starts over after it.
    assert!(!usage.sample(Some(reading(start, 6, 1, 8_000, 0)), RULE));
    assert!(!usage.sample(Some(reading(start, 11, 1, 8_050, 0)), RULE));
    usage.stopped();
    assert!(usage.window.is_none());
}

#[test]
fn a_rule_that_ignores_a_signal_does_not_read_it() {
    let start = Instant::now();
    let cpu_only = BusyRule {
        io_bytes_per_second: 0,
        ..RULE
    };
    let mut usage = Usage::default();
    assert!(!usage.sample(Some(reading(start, 0, 1, 0, 0)), cpu_only));
    // A great deal of traffic and no processor use.
    assert!(!usage.sample(Some(reading(start, 5, 1, 0, 1 << 30)), cpu_only));
    // Unreadable traffic does not make the guest unseen under this rule.
    let no_io = Reading {
        io: None,
        ..reading(start, 10, 1, 0, 0)
    };
    assert!(!usage.sample(Some(no_io), cpu_only));
    assert!(!usage.unseen());
}
