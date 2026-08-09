use core::fmt;
use std::collections::BTreeMap;

use crate::{CellBlock, CellCoord, CellRange, StableId};

pub const MAX_OPERATIONS_PER_TRANSACTION: usize = 4_096;
pub const MAX_CELLS_PER_TRANSACTION: usize = 1_000_000;
pub const MAX_TRANSACTION_TEXT_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_PENDING_TRANSACTIONS: usize = 100_000;
pub const MAX_CAUSAL_REPLICAS: usize = 100_000;
pub const MAX_PENDING_DEPENDENCIES: usize = 1_000_000;
pub const MAX_RETAINED_TRANSACTIONS: usize = 4_000_000;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ReplicaId(u64);

impl ReplicaId {
    pub fn new(value: u64) -> Result<Self, CollaborationError> {
        if value == 0 {
            return Err(CollaborationError::ZeroReplica);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct CausalDot {
    replica: ReplicaId,
    counter: u64,
}

impl CausalDot {
    pub fn new(replica: ReplicaId, counter: u64) -> Result<Self, CollaborationError> {
        if counter == 0 {
            return Err(CollaborationError::ZeroCounter);
        }
        Ok(Self { replica, counter })
    }

    #[must_use]
    pub const fn replica(self) -> ReplicaId {
        self.replica
    }

    #[must_use]
    pub const fn counter(self) -> u64 {
        self.counter
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CausalFrontier(BTreeMap<ReplicaId, u64>);

impl CausalFrontier {
    #[must_use]
    pub const fn new() -> Self {
        Self(BTreeMap::new())
    }

    pub fn from_entries(
        entries: impl IntoIterator<Item = (ReplicaId, u64)>,
    ) -> Result<Self, CollaborationError> {
        let mut frontier = Self::new();
        for (replica, counter) in entries {
            if counter == 0 {
                return Err(CollaborationError::ZeroCounter);
            }
            if frontier.0.insert(replica, counter).is_some() {
                return Err(CollaborationError::DuplicateFrontierReplica(replica));
            }
        }
        Ok(frontier)
    }

    #[must_use]
    pub fn counter(&self, replica: ReplicaId) -> u64 {
        self.0.get(&replica).copied().unwrap_or(0)
    }

    #[must_use]
    pub fn observes(&self, dot: CausalDot) -> bool {
        self.counter(dot.replica) >= dot.counter
    }

    #[must_use]
    pub fn dominates(&self, other: &Self) -> bool {
        other
            .0
            .iter()
            .all(|(replica, counter)| self.counter(*replica) >= *counter)
    }

    #[must_use]
    pub fn missing_from(&self, required: &Self) -> Self {
        Self(
            required
                .0
                .iter()
                .filter(|(replica, counter)| self.counter(**replica) < **counter)
                .map(|(replica, counter)| (*replica, *counter))
                .collect(),
        )
    }

    pub(crate) fn advance(&mut self, dot: CausalDot) -> Result<(), CollaborationError> {
        let expected = self
            .counter(dot.replica)
            .checked_add(1)
            .ok_or(CollaborationError::CounterExhausted(dot.replica))?;
        if dot.counter != expected {
            return Err(CollaborationError::CausalGap {
                replica: dot.replica,
                expected,
                actual: dot.counter,
            });
        }
        self.0.insert(dot.replica, dot.counter);
        Ok(())
    }

    pub fn iter(&self) -> impl Iterator<Item = (ReplicaId, u64)> + '_ {
        self.0.iter().map(|(replica, counter)| (*replica, *counter))
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct TransactionId(StableId);

impl TransactionId {
    #[must_use]
    pub const fn from_stable_id(value: StableId) -> Self {
        Self(value)
    }

    #[must_use]
    pub const fn stable_id(self) -> StableId {
        self.0
    }

    #[must_use]
    pub const fn is_zero(self) -> bool {
        self.0.is_zero()
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct OperationId(StableId);

impl OperationId {
    #[must_use]
    pub const fn from_stable_id(value: StableId) -> Self {
        Self(value)
    }

    #[must_use]
    pub const fn stable_id(self) -> StableId {
        self.0
    }

    #[must_use]
    pub const fn is_zero(self) -> bool {
        self.0.is_zero()
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct SheetGeneration {
    sheet_id: StableId,
    creation: OperationId,
}

impl SheetGeneration {
    #[must_use]
    pub const fn new(sheet_id: StableId, creation: OperationId) -> Self {
        Self { sheet_id, creation }
    }

    #[must_use]
    pub const fn sheet_id(self) -> StableId {
        self.sheet_id
    }

    #[must_use]
    pub const fn creation(self) -> OperationId {
        self.creation
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum CollaborationCommand {
    CreateSheet {
        sheet_id: StableId,
        name: String,
        after: Option<SheetGeneration>,
    },
    RenameSheet {
        sheet: SheetGeneration,
        name: String,
    },
    DeleteSheet {
        sheet: SheetGeneration,
    },
    SetCells {
        sheet: SheetGeneration,
        anchor: CellCoord,
        cells: CellBlock,
    },
    ClearRange {
        sheet: SheetGeneration,
        range: CellRange,
    },
    Undo {
        target: OperationId,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct CollaborationOperation {
    id: OperationId,
    command: CollaborationCommand,
}

impl CollaborationOperation {
    #[must_use]
    pub const fn new(id: OperationId, command: CollaborationCommand) -> Self {
        Self { id, command }
    }

    #[must_use]
    pub const fn id(&self) -> OperationId {
        self.id
    }

    #[must_use]
    pub const fn command(&self) -> &CollaborationCommand {
        &self.command
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CollaborationTransaction {
    id: TransactionId,
    dot: CausalDot,
    base: CausalFrontier,
    operations: Vec<CollaborationOperation>,
}

impl CollaborationTransaction {
    #[must_use]
    pub const fn new(
        id: TransactionId,
        dot: CausalDot,
        base: CausalFrontier,
        operations: Vec<CollaborationOperation>,
    ) -> Self {
        Self {
            id,
            dot,
            base,
            operations,
        }
    }

    #[must_use]
    pub const fn id(&self) -> TransactionId {
        self.id
    }

    #[must_use]
    pub const fn dot(&self) -> CausalDot {
        self.dot
    }

    #[must_use]
    pub const fn base(&self) -> &CausalFrontier {
        &self.base
    }

    #[must_use]
    pub fn operations(&self) -> &[CollaborationOperation] {
        &self.operations
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransactionDisposition {
    Applied,
    Deferred,
    DuplicateApplied,
    DuplicateDeferred,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollaborationReceipt {
    pub transaction_id: TransactionId,
    pub disposition: TransactionDisposition,
    pub newly_applied: Vec<TransactionId>,
    pub rejected_deferred: Vec<RejectedTransaction>,
    pub frontier: CausalFrontier,
    pub revision: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RejectedTransaction {
    pub transaction_id: TransactionId,
    pub error: CollaborationError,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CollaborationError {
    ZeroReplica,
    ZeroCounter,
    ZeroTransactionId,
    ZeroOperationId,
    DuplicateFrontierReplica(ReplicaId),
    CounterExhausted(ReplicaId),
    InvalidOwnPredecessor {
        expected: u64,
        actual: u64,
    },
    CausalGap {
        replica: ReplicaId,
        expected: u64,
        actual: u64,
    },
    CausalBaseNotClosed {
        dependency: CausalDot,
        missing: CausalDot,
    },
    CausalBaseTooComplex,
    EmptyTransaction,
    TooManyOperations,
    TooManyCells,
    TransactionTextLimit,
    PendingLimit,
    PendingDependencyLimit,
    CompactionRequired {
        retained_transactions: usize,
        retained_bytes: usize,
        incoming_bytes: usize,
        maximum_transactions: usize,
        maximum_bytes: usize,
    },
    TooManyCausalReplicas,
    RevisionExhausted,
    DuplicateOperationInTransaction(OperationId),
    TransactionIdConflict(TransactionId),
    DotConflict(CausalDot),
    OperationIdConflict(OperationId),
    InvalidSheetName(crate::WorkbookError),
    ZeroSheetId,
    InvalidEntityId(StableId),
    SheetIdCollision(StableId),
    UnknownSheetGeneration(SheetGeneration),
    SheetNotLiveAtBase(SheetGeneration),
    InvalidPredecessor(SheetGeneration),
    InvalidCellBlock(crate::CellBlockError),
    UnknownUndoTarget(OperationId),
    UndoTargetNotObserved(OperationId),
    CannotUndoUndo(OperationId),
    InternalInvariant(&'static str),
}

impl fmt::Display for CollaborationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZeroReplica => formatter.write_str("replica namespace must not be zero"),
            Self::ZeroCounter => formatter.write_str("causal counter must not be zero"),
            Self::ZeroTransactionId => {
                formatter.write_str("transaction id must have a nonzero namespace and counter")
            }
            Self::ZeroOperationId => {
                formatter.write_str("operation id must have a nonzero namespace and counter")
            }
            Self::DuplicateFrontierReplica(replica) => {
                write!(formatter, "duplicate causal frontier replica {}", replica.get())
            }
            Self::CounterExhausted(replica) => {
                write!(formatter, "causal counter exhausted for replica {}", replica.get())
            }
            Self::InvalidOwnPredecessor { expected, actual } => write!(
                formatter,
                "transaction dot must immediately follow its authored base: expected {expected}, got {actual}"
            ),
            Self::CausalGap {
                replica,
                expected,
                actual,
            } => write!(
                formatter,
                "causal gap for replica {}: expected {expected}, got {actual}",
                replica.get()
            ),
            Self::CausalBaseNotClosed {
                dependency,
                missing,
            } => write!(
                formatter,
                "causal base includes {}:{} without its dependency {}:{}",
                dependency.replica().get(),
                dependency.counter(),
                missing.replica().get(),
                missing.counter()
            ),
            Self::CausalBaseTooComplex => {
                formatter.write_str("causal base validation work limit exceeded")
            }
            Self::EmptyTransaction => formatter.write_str("transaction has no operations"),
            Self::TooManyOperations => formatter.write_str("transaction operation limit exceeded"),
            Self::TooManyCells => formatter.write_str("transaction cell-effect limit exceeded"),
            Self::TransactionTextLimit => formatter.write_str("transaction text limit exceeded"),
            Self::PendingLimit => formatter.write_str("pending transaction limit exceeded"),
            Self::PendingDependencyLimit => {
                formatter.write_str("pending causal dependency limit exceeded")
            }
            Self::CompactionRequired {
                retained_transactions,
                retained_bytes,
                incoming_bytes,
                maximum_transactions,
                maximum_bytes,
            } => write!(
                formatter,
                "collaboration history requires authority-directed compaction: {retained_transactions}/{maximum_transactions} transactions and {retained_bytes} retained bytes plus {incoming_bytes} incoming bytes exceed the {maximum_bytes}-byte snapshot history budget"
            ),
            Self::TooManyCausalReplicas => {
                formatter.write_str("causal frontier replica limit exceeded")
            }
            Self::RevisionExhausted => formatter.write_str("workbook revision is exhausted"),
            Self::DuplicateOperationInTransaction(id) => {
                write!(formatter, "duplicate operation id {} in transaction", id.stable_id())
            }
            Self::TransactionIdConflict(id) => {
                write!(formatter, "transaction id {} has different content", id.stable_id())
            }
            Self::DotConflict(dot) => write!(
                formatter,
                "causal dot {}:{} already belongs to another transaction",
                dot.replica().get(),
                dot.counter()
            ),
            Self::OperationIdConflict(id) => {
                write!(formatter, "operation id {} already exists", id.stable_id())
            }
            Self::InvalidSheetName(error) => error.fmt(formatter),
            Self::ZeroSheetId => {
                formatter.write_str("sheet id must have a nonzero namespace and counter")
            }
            Self::InvalidEntityId(id) => write!(formatter, "entity id {id} is invalid"),
            Self::SheetIdCollision(id) => write!(formatter, "sheet id {id} already exists"),
            Self::UnknownSheetGeneration(sheet) => write!(
                formatter,
                "unknown sheet generation {}:{}",
                sheet.sheet_id(),
                sheet.creation().stable_id()
            ),
            Self::SheetNotLiveAtBase(sheet) => write!(
                formatter,
                "sheet generation {}:{} was not live at the authored causal base",
                sheet.sheet_id(),
                sheet.creation().stable_id()
            ),
            Self::InvalidPredecessor(sheet) => write!(
                formatter,
                "sheet predecessor {}:{} was not visible to the insertion",
                sheet.sheet_id(),
                sheet.creation().stable_id()
            ),
            Self::InvalidCellBlock(error) => write!(formatter, "invalid cell block: {error:?}"),
            Self::UnknownUndoTarget(id) => {
                write!(formatter, "unknown undo target {}", id.stable_id())
            }
            Self::UndoTargetNotObserved(id) => write!(
                formatter,
                "undo target {} is not in the authored causal base",
                id.stable_id()
            ),
            Self::CannotUndoUndo(id) => {
                write!(formatter, "undo operation {} cannot target another undo", id.stable_id())
            }
            Self::InternalInvariant(message) => {
                write!(formatter, "collaboration invariant failed: {message}")
            }
        }
    }
}

impl std::error::Error for CollaborationError {}
