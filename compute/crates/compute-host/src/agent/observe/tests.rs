use compute_core::{At, Durability, Level, SandboxView, State, Step};
use compute_engine::MemoryStats;

use super::{Why, cause, pressure_since};
use crate::observe::{Cause, TraceContext};

fn view() -> SandboxView {
    SandboxView {
        state: State::new(Level::Saved, Durability::Local, true),
        step: None,
        wants_awake: false,
        holds: 0,
        last_activity: At::ZERO,
        floor: Level::Running,
        requested: Level::Running,
        unsavable: false,
        broken: false,
        paused_for_memory: None,
        balloon: 0,
    }
}

fn trace() -> Option<TraceContext> {
    "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
        .parse()
        .ok()
}

#[test]
fn a_wake_is_for_the_request_that_asked_for_it() {
    let asked = Why {
        cause: Cause::Request,
        trace: trace(),
    };
    assert!(asked.trace.is_some());
    for step in [Step::Resume, Step::Restore, Step::Boot, Step::Fetch] {
        assert_eq!(cause(step, Some(&view()), Some(asked), false), asked);
        // Even one paused for memory: a caller is waiting for it.
        let paused = SandboxView {
            paused_for_memory: Some(1 << 30),
            ..view()
        };
        assert_eq!(cause(step, Some(&paused), Some(asked), false), asked);
    }
}

#[test]
fn a_wake_nobody_asked_for_is_for_memory_holds_or_recovery() {
    let step = Step::Restore;
    let paused = SandboxView {
        paused_for_memory: Some(1 << 30),
        wants_awake: true,
        ..view()
    };
    assert_eq!(
        cause(step, Some(&paused), None, false).cause,
        Cause::Pressure
    );
    let held = SandboxView {
        wants_awake: true,
        ..view()
    };
    assert_eq!(cause(step, Some(&held), None, false).cause, Cause::Request);
    assert_eq!(
        cause(step, Some(&view()), None, false).cause,
        Cause::Recovery
    );
    // A VM that ended on its own leaves recovery as the reason.
    let lost = Why::plain(Cause::Recovery);
    assert_eq!(cause(step, Some(&held), Some(lost), false), lost);
}

#[test]
fn sleep_steps_are_for_pressure_then_a_request_then_idleness() {
    let running = SandboxView {
        state: State::RUNNING,
        ..view()
    };
    let asked = Why {
        cause: Cause::Request,
        trace: trace(),
    };
    for step in [
        Step::Pause,
        Step::Compress,
        Step::Save,
        Step::Drop,
        Step::Archive,
        Step::Evict,
        Step::Forget,
    ] {
        // A request to stay awake says nothing about why it sleeps.
        assert_eq!(
            cause(step, Some(&running), Some(asked), false),
            Why::plain(Cause::Idle)
        );
        let requested = SandboxView {
            requested: Level::Saved,
            ..running
        };
        assert_eq!(cause(step, Some(&requested), Some(asked), false), asked);
        assert_eq!(
            cause(step, Some(&requested), None, false),
            Why::plain(Cause::Request)
        );
        let pressed = SandboxView {
            floor: Level::Saved,
            ..requested
        };
        assert_eq!(
            cause(step, Some(&pressed), Some(asked), false),
            Why::plain(Cause::Pressure)
        );
    }
}

#[test]
fn everything_while_the_agent_takes_over_is_recovery() {
    let asked = Why {
        cause: Cause::Request,
        trace: trace(),
    };
    for step in Step::ALL {
        assert_eq!(
            cause(step, Some(&view()), Some(asked), true),
            Why::plain(Cause::Recovery)
        );
        assert_eq!(cause(step, None, None, false), Why::plain(Cause::Recovery));
    }
}

#[test]
fn pressure_is_counted_since_the_last_reading_of_the_same_process() {
    let stats = |some, full, faults| MemoryStats {
        pressure_some_us: Some(some),
        pressure_full_us: Some(full),
        major_faults: Some(faults),
        ..MemoryStats::default()
    };
    // First reading of a process: everything since it started.
    assert_eq!(
        pressure_since(None, (3, stats(500, 100, 7))),
        [Some(500), Some(100), Some(7)]
    );
    // The same process: only what is new.
    assert_eq!(
        pressure_since(Some((3, stats(500, 100, 7))), (3, stats(800, 100, 9))),
        [Some(300), Some(0), Some(2)]
    );
    // A new process started its counts again.
    assert_eq!(
        pressure_since(Some((3, stats(800, 100, 9))), (4, stats(20, 5, 1))),
        [Some(20), Some(5), Some(1)]
    );
    // Without pressure stall information: absent, never zero.
    let blind = MemoryStats {
        major_faults: Some(4),
        ..MemoryStats::default()
    };
    assert_eq!(pressure_since(None, (1, blind)), [None, None, Some(4)]);
}
