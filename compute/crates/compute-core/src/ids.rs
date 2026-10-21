//! Identifiers. They are opaque to the core; callers choose their values.

/// A sandbox, unique across the whole fleet (a UUID fits).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SandboxId(pub u128);

/// One reason to keep a sandbox awake, such as a running command or an open
/// terminal. Unique per sandbox; reusing an id refreshes that hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct HoldId(pub u64);

/// Work outside any sandbox, such as building a template, that borrows a
/// place under a step kind's limit (see [`crate::Input::Borrow`]). Callers
/// choose these; each is used for one loan.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LoanId(pub u64);

/// One started step. The core assigns these and expects them back in
/// [`crate::Input::Finished`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OpId(pub u64);

/// One balloon setting asked of a VM. The core assigns these, unique
/// across the host, and expects them back in [`crate::Input::BalloonSet`]
/// or [`crate::Input::BalloonFailed`]: a reply to any other request, such
/// as one made of an earlier VM of the same sandbox, changes nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BalloonRequest(pub u64);
