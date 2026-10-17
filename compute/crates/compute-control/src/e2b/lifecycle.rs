//! A sandbox's E2B lifecycle: the states the service records, and what
//! each request does in each of them
//! ([ADR 19](../../../../docs/adr/0019-e2b-compatible-front-door-and-guest-init.md)).
//!
//! E2B's running sandbox sleeps whenever idle, like any other, and wakes on
//! any request or traffic: that is the host's business and is not a state
//! here. E2B's pause and its timeout are different. They are recorded
//! states (`Pausing`, `Paused`, `Killing`) that traffic does not cancel: a
//! pause ends every stream through the front door, has the owner host save
//! the sandbox to at least Saved, and is complete only once the host
//! reports it there. Until then the sandbox is `Pausing` and refuses new
//! work. A paused sandbox wakes on connect, and on traffic only with
//! auto-resume. A sandbox's timeout is a time, set at create and moved only
//! by connect and set-timeout calls: traffic, keepalives and open streams
//! never move it.
//!
//! A call that may wake a sandbox (a connect to the guest, a hold, a
//! resume's wake) starts only while it is recorded running, but may reach
//! its host after a pause has completed, from a replica that has since
//! stopped too. So the record is not trusted alone: every replica checks,
//! at a fixed interval, that the hosts of paused sandboxes keep them
//! saved, and pauses again any it finds awake.
//!
//! Every decision here is a pure function of the record and the time, so
//! the API, the traffic router and the sweeper that finishes pauses, kills
//! and timeouts after a crash all decide alike.

use serde::{Deserialize, Serialize};

/// How long a create may take, from recording the sandbox to envd taking
/// its `/init`, before the sweeper gives it up and kills it.
pub const CREATE_WITHIN_MS: u64 = 10 * 60 * 1000;

/// The longest timeout a sandbox may have: a day, as on E2B.
pub const MAX_TIMEOUT_MS: u64 = 24 * 60 * 60 * 1000;

/// The timeout a create that names none gets: five minutes, as on E2B.
pub const DEFAULT_TIMEOUT_MS: u64 = 5 * 60 * 1000;

/// A recorded lifecycle state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// Recorded before its host is asked to create it; becomes `Running`
    /// once envd took the sandbox's `/init`.
    Creating,
    /// E2B's running: awake or asleep as the host decides.
    Running,
    /// Being paused: its streams are ended and the host saves it. Refuses
    /// new work until the host reports the save.
    Pausing,
    /// Saved, and woken only by connect, or by traffic with auto-resume.
    Paused,
    /// Being deleted. Gone to every caller.
    Killing,
}

/// What a sandbox's timeout does.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OnTimeout {
    #[default]
    Kill,
    Pause,
}

/// What the service keeps of a sandbox for its E2B lifecycle, besides the
/// fleet's row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    /// The E2B template it was created from.
    pub template: String,
    pub state: State,
    /// When it was created, in milliseconds since the Unix epoch.
    pub started_ms: u64,
    /// When its timeout passes, in milliseconds since the Unix epoch.
    pub end_ms: u64,
    /// The timeout it was created with, which an auto-resume gives it
    /// again.
    pub timeout_ms: u64,
    pub on_timeout: OnTimeout,
    /// Whether traffic wakes it from `Paused`.
    pub auto_resume: bool,
    /// envd's access token, which envd itself checks.
    pub envd_token: String,
    /// The token traffic to its other ports needs, when public traffic is
    /// off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub traffic_token: Option<String>,
    pub cpu_count: u32,
    pub memory_mb: u32,
    /// When the state last changed, in milliseconds since the Unix epoch.
    pub changed_ms: u64,
}

impl Record {
    /// When the sweeper must next look at it, in milliseconds since the
    /// Unix epoch: at once for a pause or kill under way (one cut short by
    /// a crash is finished there), at the create deadline, at the timeout,
    /// and never for a paused one.
    #[must_use]
    pub fn due_ms(&self) -> u64 {
        match self.state {
            State::Creating => self.changed_ms.saturating_add(CREATE_WITHIN_MS),
            State::Running => self.end_ms,
            State::Pausing | State::Killing => 0,
            State::Paused => u64::MAX,
        }
    }

    /// The E2B state callers see: `running` or `paused`; `None` for one
    /// that is gone to them.
    #[must_use]
    pub fn visible(&self) -> Option<&'static str> {
        match self.state {
            State::Creating | State::Running => Some("running"),
            State::Pausing | State::Paused => Some("paused"),
            State::Killing => None,
        }
    }

    /// Moves it to `state` at `now_ms`.
    pub fn set(&mut self, state: State, now_ms: u64) {
        self.state = state;
        self.changed_ms = now_ms;
    }
}

/// The timeout a request asks for, in seconds, as milliseconds within the
/// limit; `None` asks for the default.
///
/// # Errors
///
/// When it is zero, which E2B's v2 API refuses too.
pub fn timeout_ms(seconds: Option<u64>) -> Result<u64, String> {
    match seconds {
        None => Ok(DEFAULT_TIMEOUT_MS),
        Some(0) => Err("timeout must be at least one second".into()),
        Some(seconds) => Ok(seconds.saturating_mul(1000).min(MAX_TIMEOUT_MS)),
    }
}

/// What the sweeper does with a record that is due at `now_ms`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Due {
    /// Nothing yet.
    Nothing,
    /// Begin or finish a pause.
    Pause,
    /// Begin or finish a kill.
    Kill,
}

/// What is due for `record` at `now_ms`.
#[must_use]
pub fn due(record: &Record, now_ms: u64) -> Due {
    if record.due_ms() > now_ms {
        return Due::Nothing;
    }
    match record.state {
        // A create that never finished: its caller gave up or the replica
        // that ran it stopped.
        State::Creating | State::Killing => Due::Kill,
        State::Running => match record.on_timeout {
            OnTimeout::Kill => Due::Kill,
            OnTimeout::Pause => Due::Pause,
        },
        State::Pausing => Due::Pause,
        State::Paused => Due::Nothing,
    }
}

/// What a pause request does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnPause {
    /// Record `Pausing`, then pause.
    Begin,
    /// A pause is under way: finish it with the one that began it.
    Join,
    /// It is paused already; E2B answers 409.
    AlreadyPaused,
    /// It is not ready yet; try again.
    NotYet,
    /// It is gone.
    Gone,
}

/// What a pause request does in `state`.
#[must_use]
pub fn on_pause(state: State) -> OnPause {
    match state {
        State::Running => OnPause::Begin,
        State::Pausing => OnPause::Join,
        State::Paused => OnPause::AlreadyPaused,
        State::Creating => OnPause::NotYet,
        State::Killing => OnPause::Gone,
    }
}

/// What a connect request (or a resume, or traffic allowed to resume)
/// does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnConnect {
    /// It runs: move its timeout later if the request asks for a later
    /// one, never earlier.
    Extend,
    /// Record `Running` with a fresh timeout, then wake it.
    Resume,
    /// Wait for the pause or create under way to finish, then decide
    /// again.
    Wait,
    /// It is gone.
    Gone,
}

/// What a connect does in `state`.
#[must_use]
pub fn on_connect(state: State) -> OnConnect {
    match state {
        State::Running => OnConnect::Extend,
        State::Paused => OnConnect::Resume,
        State::Pausing | State::Creating => OnConnect::Wait,
        State::Killing => OnConnect::Gone,
    }
}

/// What traffic to a sandbox does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnTraffic {
    /// Route it; the host wakes the sandbox if it sleeps.
    Route,
    /// Resume it first, as a connect would, then route.
    Resume,
    /// E2B's answer for a sandbox that is not there: a 502 saying it was
    /// not found, which the SDK reads as killed or timed out.
    NotFound,
    /// E2B's answer for a sandbox still changing state: try again soon.
    Transitioning,
}

/// What traffic does in `record`'s state.
#[must_use]
pub fn on_traffic(record: &Record) -> OnTraffic {
    match record.state {
        State::Running => OnTraffic::Route,
        State::Paused if record.auto_resume => OnTraffic::Resume,
        State::Paused | State::Killing => OnTraffic::NotFound,
        State::Pausing | State::Creating => OnTraffic::Transitioning,
    }
}

/// The end time a running sandbox gets from a connect asking for
/// `timeout_ms` at `now_ms`: later than now plus that, never earlier than
/// it had.
#[must_use]
pub fn extended(end_ms: u64, now_ms: u64, timeout_ms: u64) -> u64 {
    end_ms.max(now_ms.saturating_add(timeout_ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(state: State) -> Record {
        Record {
            template: "base".into(),
            state,
            started_ms: 1_000,
            end_ms: 301_000,
            timeout_ms: 300_000,
            on_timeout: OnTimeout::Kill,
            auto_resume: false,
            envd_token: "t".into(),
            traffic_token: None,
            cpu_count: 2,
            memory_mb: 1024,
            changed_ms: 1_000,
        }
    }

    #[test]
    fn a_running_sandbox_is_due_at_its_timeout_and_does_what_it_was_told() {
        let mut running = record(State::Running);
        assert_eq!(due(&running, 300_999), Due::Nothing);
        assert_eq!(due(&running, 301_000), Due::Kill);
        running.on_timeout = OnTimeout::Pause;
        assert_eq!(due(&running, 301_000), Due::Pause);
    }

    #[test]
    fn pauses_and_kills_under_way_are_always_due_and_paused_ones_never() {
        assert_eq!(due(&record(State::Pausing), 0), Due::Pause);
        assert_eq!(due(&record(State::Killing), 0), Due::Kill);
        assert_eq!(due(&record(State::Paused), u64::MAX - 1), Due::Nothing);
        assert_eq!(record(State::Paused).due_ms(), u64::MAX);
    }

    #[test]
    fn a_create_that_never_finished_is_killed_after_its_deadline() {
        let creating = record(State::Creating);
        assert_eq!(due(&creating, 1_000 + CREATE_WITHIN_MS - 1), Due::Nothing);
        assert_eq!(due(&creating, 1_000 + CREATE_WITHIN_MS), Due::Kill);
    }

    #[test]
    fn pausing_is_paused_to_callers_and_killing_is_gone() {
        assert_eq!(record(State::Creating).visible(), Some("running"));
        assert_eq!(record(State::Running).visible(), Some("running"));
        assert_eq!(record(State::Pausing).visible(), Some("paused"));
        assert_eq!(record(State::Paused).visible(), Some("paused"));
        assert_eq!(record(State::Killing).visible(), None);
    }

    #[test]
    fn a_pause_begins_once_joins_one_under_way_and_reports_one_done() {
        assert_eq!(on_pause(State::Running), OnPause::Begin);
        assert_eq!(on_pause(State::Pausing), OnPause::Join);
        assert_eq!(on_pause(State::Paused), OnPause::AlreadyPaused);
        assert_eq!(on_pause(State::Creating), OnPause::NotYet);
        assert_eq!(on_pause(State::Killing), OnPause::Gone);
    }

    #[test]
    fn connect_resumes_a_paused_sandbox_and_waits_out_a_pause() {
        assert_eq!(on_connect(State::Running), OnConnect::Extend);
        assert_eq!(on_connect(State::Paused), OnConnect::Resume);
        assert_eq!(on_connect(State::Pausing), OnConnect::Wait);
        assert_eq!(on_connect(State::Creating), OnConnect::Wait);
        assert_eq!(on_connect(State::Killing), OnConnect::Gone);
    }

    #[test]
    fn traffic_resumes_a_paused_sandbox_only_with_auto_resume() {
        assert_eq!(on_traffic(&record(State::Running)), OnTraffic::Route);
        let mut paused = record(State::Paused);
        assert_eq!(on_traffic(&paused), OnTraffic::NotFound);
        paused.auto_resume = true;
        assert_eq!(on_traffic(&paused), OnTraffic::Resume);
        // Traffic never cancels a pause under way or a kill.
        let mut pausing = record(State::Pausing);
        pausing.auto_resume = true;
        assert_eq!(on_traffic(&pausing), OnTraffic::Transitioning);
        assert_eq!(on_traffic(&record(State::Killing)), OnTraffic::NotFound);
    }

    #[test]
    fn a_connect_only_ever_moves_the_timeout_later() {
        assert_eq!(extended(10_000, 5_000, 1_000), 10_000);
        assert_eq!(extended(10_000, 9_500, 1_000), 10_500);
        assert_eq!(extended(10_000, u64::MAX, 1_000), u64::MAX);
    }

    #[test]
    fn timeouts_are_seconds_within_a_day_and_never_zero() {
        assert_eq!(timeout_ms(None), Ok(DEFAULT_TIMEOUT_MS));
        assert_eq!(timeout_ms(Some(30)), Ok(30_000));
        assert_eq!(timeout_ms(Some(u64::MAX)), Ok(MAX_TIMEOUT_MS));
        assert!(timeout_ms(Some(0)).is_err());
    }

    #[test]
    fn a_record_round_trips_and_refuses_unknown_fields() {
        let mut paused = record(State::Paused);
        paused.traffic_token = Some("x".into());
        let text = serde_json::to_string(&paused).unwrap();
        assert_eq!(serde_json::from_str::<Record>(&text).unwrap(), paused);
        let mut value: serde_json::Value = serde_json::from_str(&text).unwrap();
        value["surprise"] = 1.into();
        assert!(serde_json::from_value::<Record>(value).is_err());
    }
}
