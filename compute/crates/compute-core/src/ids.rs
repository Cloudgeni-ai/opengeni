//! Identifiers. They are opaque to the core; callers choose their values.

/// A sandbox, unique across the whole fleet (a UUID fits).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SandboxId(pub u128);

/// One reason to keep a sandbox awake, such as a running command or an open
/// terminal. Unique per sandbox; reusing an id refreshes that hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct HoldId(pub u64);

/// One started step. The core assigns these and expects them back in
/// [`crate::Input::Finished`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OpId(pub u64);
