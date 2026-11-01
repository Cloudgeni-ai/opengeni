//! The pointers to a fleet's stored copies, kept by the service (ADR 25):
//! each replaced only on condition of the version its writer read, with
//! versions from a sequence, so no two writes ever share one.

use compute_fleet::Stamp;

/// A pointer as the store keeps it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PointerRow {
    /// Its owner stamp, which every write replacing it is checked against.
    pub owner: Stamp,
    /// What it holds: empty for the pointer an archive in flight keeps and
    /// for a tombstone.
    pub pointer: Vec<u8>,
    /// The version it is kept as, which a write replacing it names.
    pub version: i64,
}

/// A pointer read from the object store a fleet kept them in before, to
/// import.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    pub name: String,
    pub owner: Stamp,
    pub pointer: Vec<u8>,
}

/// When a fleet's pointers were moved into the store, and from where.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Imported {
    pub at_ms: u64,
    /// The object store they were read from, as the service named it.
    pub from: String,
}

/// What an import did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Import {
    /// The pointers are in the store: imported now or before.
    Done(Imported),
    /// Nothing, while these live or draining hosts keep their pointers in
    /// the object store themselves: what they wrote after the import
    /// would never be seen.
    Waiting(Vec<String>),
}
