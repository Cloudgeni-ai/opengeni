//! The pure decision core of an Opengeni compute fleet.
//!
//! A fleet is many hosts, each running sandboxes under a host agent, and a
//! service that knows which host owns each sandbox. Ownership is a lease:
//! a host keeps running its sandboxes only while it renews its lease, and
//! the service hands them to other hosts only once that lease has run out
//! with a margin to spare. Every change of hands raises the sandbox's owner
//! epoch, which fences writes from a former owner, both in the service's
//! store and in object storage.
//!
//! This crate decides; it performs no I/O and reads no clock, so the same
//! code runs in the service, in the host agent and in a seeded simulation
//! of the whole protocol (`tests/protocol.rs`):
//!
//! - [`LeaseTerms`] and [`HostLease`]: how long a lease lasts, when a host
//!   must stop its VMs, and when the service may treat it as lost.
//! - [`Ownership`] and its [`Change`]s: who owns a sandbox at which epoch,
//!   as compare-and-set updates a store applies.
//! - [`reconcile`]: what a host that registers keeps, gets back and drops.
//! - [`fence`]: whether a host may publish an archive over the pointer it
//!   found, by the pointer's [`Stamp`].
//! - [`Fleet`]: the capacity view placement reads, and [`Fleet::place`].
//! - [`ScalePolicy`]: how many hosts a host group should have.

mod fence;
mod guard;
mod ids;
mod lease;
mod own;
mod place;
mod rng;
mod scale;

pub use compute_core::{At, SandboxId};
pub use fence::{Fence, Stamp, fence};
pub use guard::{Guard, GuardAction, GuardStep, Observed, Vms};
pub use ids::{ClassId, HostEpoch, HostId, OwnerEpoch, ShapeKey, ZoneId};
pub use lease::{Expiry, HostLease, LeaseError, LeaseRecord, LeaseTerms, Renewal};
pub use own::{Change, Listed, Ownership, Verdict, reconcile};
pub use place::{Capacity, Demand, Fleet, HostInfo, HostState, Placement};
pub use rng::Rng;
pub use scale::{GroupView, ScaleDecision, ScalePolicy};
