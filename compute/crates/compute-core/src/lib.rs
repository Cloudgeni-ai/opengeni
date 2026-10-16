//! The pure decision core of an Opengeni compute host.
//!
//! A host runs many sandboxes. Each one pauses as soon as it is idle, gets a
//! saved copy on disk and in object storage while it stays paused in memory,
//! gives up its memory only when the host needs it, and wakes the moment it
//! is needed. Its [`State`] combines where it lives (its [`Level`]) with how
//! well its current state is protected (its [`Durability`]).
//!
//! This crate decides what should happen and when: which [`Step`] to start
//! for which sandbox, what to cancel, and what to report. It performs no I/O
//! and reads no clock. The host agent feeds it [`Input`]s stamped with the
//! current time and executes the [`Action`]s it returns, so every decision is
//! deterministic and tests can replay many interleavings quickly.
//!
//! ```
//! use compute_core::{
//!     Action, At, Host, HostPolicy, Input, SandboxId, SleepPolicy, SleepRules, State, Step,
//! };
//!
//! let mut host = Host::new(HostPolicy::default()).unwrap();
//! let policy = SleepPolicy::new(SleepRules::RECOMMENDED).unwrap();
//! let sandbox = SandboxId(1);
//! let mut actions = Vec::new();
//! let last_activity = At::ZERO;
//! host.handle(At::ZERO, Input::Add { sandbox, state: State::RUNNING, policy, last_activity }, &mut actions);
//! // Ten idle seconds later, it pauses.
//! assert_eq!(host.next_deadline(), Some(At::from_millis(10_000)));
//! host.handle(At::from_millis(10_000), Input::Tick, &mut actions);
//! assert!(matches!(actions[..], [Action::Start { step: Step::Pause, .. }]));
//! ```

mod host;
mod ids;
mod level;
mod policy;
mod sandbox;
mod time;

pub use host::{Action, Failure, Host, Input, Notice, Outcome, SandboxView};
pub use ids::{HoldId, OpId, SandboxId};
pub use level::{Durability, Level, Priority, State, Step};
pub use policy::{
    Backoff, HostPolicy, MemoryPolicy, PolicyError, Rule, SleepPolicy, SleepRules, StepLimits,
};
pub use time::At;
