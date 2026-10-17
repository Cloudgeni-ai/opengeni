//! What the agent tells about its sandboxes ([`crate::observe`]): why each
//! step started, one event per step, the summary of a sandbox long awake,
//! and the gauges each sample sets.

use compute_core::{Durability, Level, OpId, Outcome, SandboxView, State, Step};
use compute_engine::{Engine, MemoryStats};
use tokio::time::Instant;

use crate::observe::{
    Cause, Event, Gauges, Severity, TraceContext, alarm_event, level_index, level_name,
    outcome_name,
};
use crate::protocol::{Id, step_name};
use crate::state::unix_ms_now;
use crate::step::Report;
use crate::store::Store;

use super::{HostAgent, Running};

/// Why a step runs, with the caller's trace when a request with one caused
/// it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Why {
    pub cause: Cause,
    pub trace: Option<TraceContext>,
}

impl Why {
    pub const fn plain(cause: Cause) -> Self {
        Self { cause, trace: None }
    }
}

/// Why `step` starts for a sandbox the core sees as `view`. `asked` is the
/// latest request for the sandbox since its last sleep step began, if any;
/// `recovering` whether the agent is still taking over its state root.
///
/// A wake is for the request that asked for it; without one, for memory if
/// the sandbox was paused for memory, for its holds if it is held, and
/// otherwise to put things right. A sleep step is for pressure when the
/// host demands that depth, for a request when one asked for it, and
/// otherwise for being idle.
pub(super) fn cause(
    step: Step,
    view: Option<&SandboxView>,
    asked: Option<Why>,
    recovering: bool,
) -> Why {
    let Some(view) = view.filter(|_| !recovering) else {
        return Why::plain(Cause::Recovery);
    };
    if step.wakes() {
        return match asked {
            Some(asked) => asked,
            None if view.paused_for_memory.is_some() => Why::plain(Cause::Pressure),
            None if view.wants_awake => Why::plain(Cause::Request),
            None => Why::plain(Cause::Recovery),
        };
    }
    if view.floor != Level::Running {
        Why::plain(Cause::Pressure)
    } else if view.requested != Level::Running {
        Why {
            cause: Cause::Request,
            trace: asked.and_then(|asked| asked.trace),
        }
    } else {
        Why::plain(Cause::Idle)
    }
}

/// What a VM went through since `mark`, an earlier reading: stall time,
/// `some` and `full`, and major faults. A reading of another incarnation
/// is of another process, whose counts started at zero. A count the host
/// cannot read is absent, never zero.
pub(super) fn pressure_since(
    mark: Option<(u64, MemoryStats)>,
    (incarnation, now): (u64, MemoryStats),
) -> [Option<u64>; 3] {
    let before = mark
        .filter(|(seen, _)| *seen == incarnation)
        .map(|(_, stats)| stats)
        .unwrap_or_default();
    let since = |now: Option<u64>, before: Option<u64>| {
        now.map(|now| now.saturating_sub(before.unwrap_or(0)))
    };
    [
        since(now.pressure_some_us, before.pressure_some_us),
        since(now.pressure_full_us, before.pressure_full_us),
        since(now.major_faults, before.major_faults),
    ]
}

/// Adds what [`pressure_since`] found to `event`.
fn with_pressure(event: Event, pressure: [Option<u64>; 3]) -> Event {
    let [some, full, faults] = pressure;
    event
        .with_some("compute.pressure.some_us", some)
        .with_some("compute.pressure.full_us", full)
        .with_some("compute.major_faults", faults)
}

fn durability_name(durability: Durability) -> &'static str {
    match durability {
        Durability::Volatile => "volatile",
        Durability::Local => "local",
        Durability::Remote => "remote",
    }
}

fn with_state(event: Event, when: &'static str, state: Option<State>) -> Event {
    let Some(state) = state else { return event };
    let (level, durability) = match when {
        "before" => ("compute.level.before", "compute.durability.before"),
        _ => ("compute.level.after", "compute.durability.after"),
    };
    event
        .with(level, level_name(state.level))
        .with(durability, durability_name(state.durability))
}

impl<E: Engine, S: Store> HostAgent<E, S> {
    /// Why `step` starts as `op` for `id` now. A sleep step consumes the
    /// request to wake that came before it, so the next wake needs a new
    /// reason, and a wake step the request to sleep.
    pub(super) fn why(&mut self, id: Id, op: OpId, step: Step) -> Why {
        let view = self.core.sandbox(id.0);
        let slot = self.slots.get_mut(&id.0);
        let asked = slot.as_ref().and_then(|slot| {
            if step.wakes() {
                slot.asked
            } else {
                slot.sleep_asked
            }
        });
        let why = cause(step, view.as_ref(), asked, self.recovering);
        if let Some(slot) = slot {
            if step.wakes() {
                slot.woke_by = Some(op);
                slot.sleep_asked = None;
            } else {
                slot.asked = None;
                slot.woke_by = None;
            }
        }
        why
    }

    /// Counts the step `running` of `id` that ended with `outcome`, and
    /// emits its event and the alarms it raised.
    pub(super) fn step_event(
        &mut self,
        id: Id,
        running: &Running,
        outcome: Outcome,
        report: &mut Report,
    ) {
        let took = running.started.elapsed();
        let observer = self.observer.clone();
        observer
            .metrics()
            .step(running.step, running.why.cause, outcome, took);
        let failed = matches!(outcome, Outcome::Failed(_));
        let sandbox = id.to_string();
        let mut event = Event::new(
            "compute.step",
            if failed {
                Severity::Warn
            } else {
                Severity::Info
            },
        )
        .with("compute.sandbox.id", sandbox.clone())
        .with("compute.op.id", running.op.0)
        .with("compute.step", step_name(running.step))
        .with("compute.cause", running.why.cause.name())
        .with("compute.outcome", outcome_name(outcome))
        .with("compute.duration_us", took)
        .with("compute.launches", report.launches)
        .with_some("compute.error", report.notes.error.clone())
        .traced(running.why.trace);
        event = with_state(event, "before", running.before);
        event = with_state(
            event,
            "after",
            self.core.sandbox(id.0).map(|view| view.state),
        );
        for (phase, took) in &report.notes.phases {
            event = event.with(format!("compute.phase.{phase}_us"), *took);
        }
        for (what, bytes) in &report.notes.bytes {
            event = event.with(format!("compute.bytes.{what}"), *bytes);
        }
        for (key, value) in &report.notes.details {
            event = event.with(*key, *value);
        }
        if let (Some(reading), Some(slot)) = (report.reading, self.slots.get_mut(&id.0)) {
            event = with_pressure(event, pressure_since(slot.reported, reading));
            slot.reported = Some(reading);
        }
        observer.emit(event);
        for (alarm, what) in report.notes.alarms.drain(..) {
            let event = alarm_event(what)
                .with("compute.sandbox.id", sandbox.clone())
                .with("compute.op.id", running.op.0)
                .with("compute.step", step_name(running.step))
                .traced(running.why.trace);
            observer.alarm(alarm, event);
        }
    }

    /// Emits the summary of every sandbox awake for `summary_every` since
    /// its last step or summary: what it went through meanwhile, from the
    /// reading the sampler just took.
    pub(super) fn summarize(&mut self) {
        let now = Instant::now();
        for (id, slot) in &mut self.slots {
            let Some(reading) = slot.stats else { continue };
            if now.duration_since(slot.summarized) < self.summary_every {
                continue;
            }
            let period = now.duration_since(slot.summarized);
            slot.summarized = now;
            let event = Event::new("compute.sandbox.summary", Severity::Info)
                .with("compute.sandbox.id", Id(*id).to_string())
                .with("compute.level", level_name(Level::Running))
                .with("compute.duration_us", period)
                .with("compute.zswap.in", reading.1.zswpin);
            let event = with_pressure(event, pressure_since(slot.reported, reading));
            slot.reported = Some(reading);
            self.observer.emit(event);
        }
    }

    /// The gauges as this sample finds them; `resident` holds the memory
    /// each VM held when sampled.
    pub(super) fn gauges(&self, resident: impl Iterator<Item = (Level, u64)>) -> Gauges {
        let mut gauges = Gauges {
            sampled_unix_ms: unix_ms_now(),
            available: self.available_memory,
            ..Gauges::default()
        };
        for (level, bytes) in resident {
            gauges.memory[level_index(level)] += bytes;
        }
        let now = Instant::now();
        for (id, slot) in &self.slots {
            let Some(view) = self.core.sandbox(*id) else {
                continue;
            };
            gauges.sandboxes[level_index(view.state.level)] += 1;
            gauges.broken += u64::from(view.broken);
            gauges.unsavable += u64::from(view.unsavable);
            if let Some(running) = &slot.op {
                let index = running.step.index();
                gauges.in_flight[index] += 1;
                let age = u64::try_from(now.duration_since(running.started).as_millis())
                    .unwrap_or(u64::MAX);
                gauges.oldest_ms[index] = gauges.oldest_ms[index].max(age);
            }
        }
        gauges.blocked = self.blocked.len() as u64;
        let host = crate::host_memory::host_gauges();
        gauges.zswap_stored = host.zswap_stored;
        gauges.zswap_original = host.zswap_original;
        gauges.huge_pages_free = host.huge_pages_free;
        gauges.pressure = host.pressure;
        if let Some((_, lanes)) = self.store.chunks() {
            let (foreground, background) = lanes.counts();
            gauges.transfers_foreground = Some(foreground);
            gauges.transfers_background = Some(background);
        }
        gauges
    }
}

#[cfg(test)]
mod tests;
