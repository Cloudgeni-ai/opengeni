//! The pure decision core of an Opengeni compute host.
//!
//! A host runs many sandboxes. Each one sleeps through a ladder of
//! [`Level`]s while idle and wakes when it is needed. This crate decides what
//! should happen and when: which [`Step`] to start for which sandbox, what to
//! cancel, and what to report. It performs no I/O and reads no clock. The
//! host agent feeds it [`Input`]s stamped with the current time and executes
//! the [`Action`]s it returns, so every decision is deterministic and tests
//! can replay many interleavings quickly.
//!
//! ```
//! use std::time::Duration;
//! use compute_core::{Action, At, Host, HostPolicy, Input, Level, SandboxId, SleepPolicy, Step};
//!
//! let mut host = Host::new(HostPolicy::default()).unwrap();
//! let policy = SleepPolicy::new([(Level::Paused, Duration::from_secs(30))]).unwrap();
//! let sandbox = SandboxId(1);
//! let mut actions = Vec::new();
//! host.handle(
//!     At::ZERO,
//!     Input::Add { sandbox, level: Level::Running, memory_saved: false, policy },
//!     &mut actions,
//! );
//! assert_eq!(host.next_deadline(), Some(At::from_millis(30_000)));
//! host.handle(At::from_millis(30_000), Input::Tick, &mut actions);
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
pub use level::{Level, Priority, Step};
pub use policy::{Backoff, HostPolicy, MemoryPolicy, PolicyError, SleepPolicy, StepLimits};
pub use time::At;
