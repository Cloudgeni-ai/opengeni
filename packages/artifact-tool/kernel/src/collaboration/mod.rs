mod register;
mod snapshot;
mod types;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use register::{CausalRegister, RegisterContribution};

use crate::workbook::MAX_SHEET_NAME_BYTES;
use crate::{
    AtomicBatch, Cell, CellBlock, CellCoord, CellValue, Command, Sheet, StableId, Workbook,
};

pub use snapshot::{
    decode_collaboration_snapshot, encode_collaboration_snapshot, CollaborationSnapshotError,
    COLLABORATION_SNAPSHOT_VERSION,
};
pub use types::{
    CausalDot, CausalFrontier, CollaborationCommand, CollaborationError, CollaborationOperation,
    CollaborationReceipt, CollaborationTransaction, OperationId, RejectedTransaction, ReplicaId,
    SheetGeneration, TransactionDisposition, TransactionId, MAX_CAUSAL_REPLICAS,
    MAX_CELLS_PER_TRANSACTION, MAX_OPERATIONS_PER_TRANSACTION, MAX_PENDING_DEPENDENCIES,
    MAX_PENDING_TRANSACTIONS, MAX_RETAINED_TRANSACTIONS, MAX_TRANSACTION_TEXT_BYTES,
};

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct CellKey {
    sheet_id: StableId,
    coord: CellCoord,
}

#[derive(Clone, Debug, PartialEq)]
struct SheetCreation {
    operation_id: OperationId,
    dot: CausalDot,
    operation_index: u32,
    base: Arc<CausalFrontier>,
    after: Option<SheetGeneration>,
}

#[derive(Clone, Debug, PartialEq)]
struct StructuralContribution {
    operation_id: OperationId,
    dot: CausalDot,
    operation_index: u32,
    base: Arc<CausalFrontier>,
}

#[derive(Clone, Debug, PartialEq)]
struct SheetHistory {
    creation: SheetCreation,
    names: CausalRegister<String>,
    deletions: BTreeMap<OperationId, StructuralContribution>,
}

#[derive(Clone, Debug, PartialEq)]
struct RangeClearRecord {
    operation_id: OperationId,
    dot: CausalDot,
    operation_index: u32,
    base: Arc<CausalFrontier>,
    sheet: SheetGeneration,
    range: crate::CellRange,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum OperationKind {
    CreateSheet,
    RenameSheet,
    DeleteSheet,
    SetCells,
    ClearRange,
    Undo { target: OperationId },
}

#[derive(Clone, Debug, PartialEq)]
enum OperationEffect {
    Sheet(StableId),
    Cells(Vec<CellKey>),
    Range {
        sheet_id: StableId,
        range: crate::CellRange,
    },
    Undo(OperationId),
}

#[derive(Clone, Debug, PartialEq)]
struct OperationRecord {
    dot: CausalDot,
    operation_index: u32,
    kind: OperationKind,
    effect: OperationEffect,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum KnownStatus {
    Applied,
    Deferred,
}

#[derive(Clone, Debug, PartialEq)]
struct KnownTransaction {
    transaction: CollaborationTransaction,
    status: KnownStatus,
    retained_bytes: usize,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RetentionMetadata {
    pub frontier: CausalFrontier,
    pub retained_history_bytes: usize,
    pub maximum_retained_history_bytes: usize,
    pub maximum_retained_transactions: usize,
    pub oldest_retained_by_replica: BTreeMap<ReplicaId, u64>,
    pub pending_bases: Vec<CausalFrontier>,
    pub tombstones: Vec<TombstoneRetention>,
    pub undo_links: Vec<UndoRetention>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TombstoneRetention {
    pub operation_id: OperationId,
    pub dot: CausalDot,
    pub kind: TombstoneKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TombstoneKind {
    CellClear,
    RangeClear,
    SheetDelete,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UndoRetention {
    pub undo_operation_id: OperationId,
    pub undo_dot: CausalDot,
    pub target_operation_id: OperationId,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CollaborativeWorkbook {
    model_namespace: u64,
    workbook: Workbook,
    frontier: CausalFrontier,
    known_transactions: BTreeMap<TransactionId, KnownTransaction>,
    retained_history_bytes: usize,
    dot_owners: BTreeMap<CausalDot, TransactionId>,
    known_replicas: BTreeSet<ReplicaId>,
    operation_owners: BTreeMap<OperationId, TransactionId>,
    pending: BTreeMap<CausalDot, TransactionId>,
    pending_waits: BTreeMap<CausalDot, BTreeSet<CausalDot>>,
    dependency_waiters: BTreeMap<CausalDot, BTreeSet<CausalDot>>,
    ready: BTreeSet<CausalDot>,
    pending_dependency_edges: usize,
    sheets: BTreeMap<StableId, SheetHistory>,
    cells: BTreeMap<CellKey, CausalRegister<Cell>>,
    range_clears: BTreeMap<OperationId, RangeClearRecord>,
    operations: BTreeMap<OperationId, OperationRecord>,
    undone: BTreeSet<OperationId>,
    undo_links: BTreeMap<OperationId, OperationId>,
}

impl CollaborativeWorkbook {
    /// Retained v1 transaction bytes are bounded below the full snapshot limit,
    /// leaving deterministic headroom for the materialized workbook and causal
    /// metadata. Crossing this boundary requires an authority-directed
    /// checkpoint/compaction; the kernel never guesses a safe GC frontier.
    pub const MAX_RETAINED_HISTORY_BYTES: usize = 256 * 1024 * 1024;

    pub fn new(model_namespace: u64) -> Result<Self, CollaborationError> {
        ReplicaId::new(model_namespace)?;
        let workbook = Workbook::new(model_namespace)
            .map_err(|_| CollaborationError::InternalInvariant("workbook id allocation failed"))?;
        Ok(Self {
            model_namespace,
            workbook,
            frontier: CausalFrontier::new(),
            known_transactions: BTreeMap::new(),
            retained_history_bytes: 0,
            dot_owners: BTreeMap::new(),
            known_replicas: BTreeSet::new(),
            operation_owners: BTreeMap::new(),
            pending: BTreeMap::new(),
            pending_waits: BTreeMap::new(),
            dependency_waiters: BTreeMap::new(),
            ready: BTreeSet::new(),
            pending_dependency_edges: 0,
            sheets: BTreeMap::new(),
            cells: BTreeMap::new(),
            range_clears: BTreeMap::new(),
            operations: BTreeMap::new(),
            undone: BTreeSet::new(),
            undo_links: BTreeMap::new(),
        })
    }

    #[must_use]
    pub const fn workbook(&self) -> &Workbook {
        &self.workbook
    }

    #[must_use]
    pub const fn frontier(&self) -> &CausalFrontier {
        &self.frontier
    }

    /// Returns the currently visible creation generation for a materialized
    /// sheet. Bindings use this to turn a user-facing stable sheet id into the
    /// generation-pinned command required by the collaboration model.
    #[must_use]
    pub fn sheet_generation(&self, sheet_id: StableId) -> Option<SheetGeneration> {
        self.workbook.sheet(sheet_id)?;
        self.sheets
            .get(&sheet_id)
            .map(|history| SheetGeneration::new(sheet_id, history.creation.operation_id))
    }

    #[must_use]
    pub fn pending_transaction_count(&self) -> usize {
        self.pending.len()
    }

    #[must_use]
    pub fn retained_transaction_count(&self) -> usize {
        self.known_transactions.len()
    }

    #[must_use]
    pub const fn retained_history_bytes(&self) -> usize {
        self.retained_history_bytes
    }

    #[must_use]
    pub fn causal_cell_count(&self) -> usize {
        self.cells.len()
    }

    pub fn apply_transaction(
        &mut self,
        transaction: CollaborationTransaction,
    ) -> Result<CollaborationReceipt, CollaborationError> {
        self.apply_transaction_with_materialization(transaction, true)
    }

    pub(crate) fn restore_transaction(
        &mut self,
        transaction: CollaborationTransaction,
    ) -> Result<CollaborationReceipt, CollaborationError> {
        self.apply_transaction_with_materialization(transaction, false)
    }

    pub(crate) fn finish_restore_materialization(&mut self) -> Result<(), CollaborationError> {
        self.rebuild_materialized(self.workbook.revision(), self.workbook.ids.clone())
    }

    fn apply_transaction_with_materialization(
        &mut self,
        transaction: CollaborationTransaction,
        materialize: bool,
    ) -> Result<CollaborationReceipt, CollaborationError> {
        self.apply_transaction_with_limits(
            transaction,
            materialize,
            MAX_RETAINED_TRANSACTIONS,
            Self::MAX_RETAINED_HISTORY_BYTES,
        )
    }

    fn apply_transaction_with_limits(
        &mut self,
        transaction: CollaborationTransaction,
        materialize: bool,
        maximum_transactions: usize,
        maximum_bytes: usize,
    ) -> Result<CollaborationReceipt, CollaborationError> {
        if let Some(known) = self.known_transactions.get(&transaction.id()) {
            if known.transaction != transaction {
                return Err(CollaborationError::TransactionIdConflict(transaction.id()));
            }
            let disposition = match known.status {
                KnownStatus::Applied => TransactionDisposition::DuplicateApplied,
                KnownStatus::Deferred => TransactionDisposition::DuplicateDeferred,
            };
            return Ok(self.receipt(transaction.id(), disposition, DrainOutcome::default()));
        }

        self.validate_envelope(&transaction)?;
        if let Some(owner) = self.dot_owners.get(&transaction.dot()) {
            if *owner != transaction.id() {
                return Err(CollaborationError::DotConflict(transaction.dot()));
            }
        }
        let observed_own_counter = self.frontier.counter(transaction.dot().replica());
        if observed_own_counter >= transaction.dot().counter() {
            return Err(CollaborationError::CausalGap {
                replica: transaction.dot().replica(),
                expected: observed_own_counter.saturating_add(1),
                actual: transaction.dot().counter(),
            });
        }
        for operation in transaction.operations() {
            if self.operation_owners.contains_key(&operation.id()) {
                return Err(CollaborationError::OperationIdConflict(operation.id()));
            }
        }
        let incoming_bytes =
            snapshot::retained_transaction_wire_bytes(&transaction).map_err(|_| {
                CollaborationError::InternalInvariant("transaction wire size is not representable")
            })?;
        let next_retained_bytes = self
            .retained_history_bytes
            .checked_add(incoming_bytes)
            .ok_or_else(|| {
                self.compaction_required_error(incoming_bytes, maximum_transactions, maximum_bytes)
            })?;
        if self.known_transactions.len() >= maximum_transactions
            || next_retained_bytes > maximum_bytes
        {
            return Err(self.compaction_required_error(
                incoming_bytes,
                maximum_transactions,
                maximum_bytes,
            ));
        }
        if !self.known_replicas.contains(&transaction.dot().replica())
            && self.known_replicas.len() >= MAX_CAUSAL_REPLICAS
        {
            return Err(CollaborationError::TooManyCausalReplicas);
        }
        let missing_dependencies = self.missing_dependencies(transaction.base())?;
        // A ready transaction can be validated completely before reserving any
        // identity, preserving the fail-without-mutation contract. Retain the
        // preparation so the hot path never clones or re-walks its payload.
        let initially_prepared = if missing_dependencies.is_empty() {
            Some((transaction.id(), self.prepare_ready(&transaction)?))
        } else {
            None
        };
        if self.pending.len() >= MAX_PENDING_TRANSACTIONS && !missing_dependencies.is_empty() {
            return Err(CollaborationError::PendingLimit);
        }
        let next_pending_edges = self
            .pending_dependency_edges
            .checked_add(missing_dependencies.len())
            .ok_or(CollaborationError::PendingDependencyLimit)?;
        if next_pending_edges > MAX_PENDING_DEPENDENCIES {
            return Err(CollaborationError::PendingDependencyLimit);
        }

        let id = transaction.id();
        let dot = transaction.dot();
        self.dot_owners.insert(dot, id);
        self.known_replicas.insert(dot.replica());
        for operation in transaction.operations() {
            self.operation_owners.insert(operation.id(), id);
        }
        self.pending.insert(dot, id);
        if missing_dependencies.is_empty() {
            self.ready.insert(dot);
        } else {
            for dependency in &missing_dependencies {
                self.dependency_waiters
                    .entry(*dependency)
                    .or_default()
                    .insert(dot);
            }
        }
        self.pending_dependency_edges = next_pending_edges;
        self.pending_waits.insert(dot, missing_dependencies);
        self.known_transactions.insert(
            id,
            KnownTransaction {
                transaction,
                status: KnownStatus::Deferred,
                retained_bytes: incoming_bytes,
            },
        );
        self.retained_history_bytes = next_retained_bytes;

        let drain = self.drain_ready(initially_prepared, materialize)?;
        let disposition = if drain.applied.contains(&id) {
            TransactionDisposition::Applied
        } else {
            TransactionDisposition::Deferred
        };
        Ok(self.receipt(id, disposition, drain))
    }

    fn compaction_required_error(
        &self,
        incoming_bytes: usize,
        maximum_transactions: usize,
        maximum_bytes: usize,
    ) -> CollaborationError {
        CollaborationError::CompactionRequired {
            retained_transactions: self.known_transactions.len(),
            retained_bytes: self.retained_history_bytes,
            incoming_bytes,
            maximum_transactions,
            maximum_bytes,
        }
    }

    #[must_use]
    pub fn retention_metadata(&self) -> RetentionMetadata {
        let mut oldest_retained_by_replica = BTreeMap::new();
        for known in self.known_transactions.values() {
            let dot = known.transaction.dot();
            oldest_retained_by_replica
                .entry(dot.replica())
                .and_modify(|counter: &mut u64| *counter = (*counter).min(dot.counter()))
                .or_insert(dot.counter());
        }

        let mut tombstones = Vec::new();
        for (operation_id, record) in &self.operations {
            let kind = match record.kind {
                OperationKind::DeleteSheet => Some(TombstoneKind::SheetDelete),
                OperationKind::ClearRange => Some(TombstoneKind::RangeClear),
                OperationKind::SetCells => match &record.effect {
                    OperationEffect::Cells(keys)
                        if keys.iter().any(|key| {
                            self.cells.get(key).is_some_and(|register| {
                                register.contributions().any(|contribution| {
                                    contribution.operation_id == *operation_id
                                        && contribution.value.is_empty()
                                })
                            })
                        }) =>
                    {
                        Some(TombstoneKind::CellClear)
                    }
                    _ => None,
                },
                _ => None,
            };
            if let Some(kind) = kind {
                tombstones.push(TombstoneRetention {
                    operation_id: *operation_id,
                    dot: record.dot,
                    kind,
                });
            }
        }
        let undo_links = self
            .undo_links
            .iter()
            .filter_map(|(undo_operation_id, target_operation_id)| {
                self.operations
                    .get(undo_operation_id)
                    .map(|record| UndoRetention {
                        undo_operation_id: *undo_operation_id,
                        undo_dot: record.dot,
                        target_operation_id: *target_operation_id,
                    })
            })
            .collect();

        RetentionMetadata {
            frontier: self.frontier.clone(),
            retained_history_bytes: self.retained_history_bytes,
            maximum_retained_history_bytes: Self::MAX_RETAINED_HISTORY_BYTES,
            maximum_retained_transactions: MAX_RETAINED_TRANSACTIONS,
            oldest_retained_by_replica,
            pending_bases: self
                .pending
                .values()
                .filter_map(|id| self.known_transactions.get(id))
                .map(|known| known.transaction.base().clone())
                .collect(),
            tombstones,
            undo_links,
        }
    }

    fn receipt(
        &self,
        transaction_id: TransactionId,
        disposition: TransactionDisposition,
        drain: DrainOutcome,
    ) -> CollaborationReceipt {
        CollaborationReceipt {
            transaction_id,
            disposition,
            newly_applied: drain.applied,
            rejected_deferred: drain.rejected,
            frontier: self.frontier.clone(),
            revision: self.workbook.revision(),
        }
    }

    fn validate_envelope(
        &self,
        transaction: &CollaborationTransaction,
    ) -> Result<(), CollaborationError> {
        if !valid_generic_stable_id(transaction.id().stable_id()) {
            return Err(CollaborationError::ZeroTransactionId);
        }
        if transaction.operations().is_empty() {
            return Err(CollaborationError::EmptyTransaction);
        }
        if transaction.operations().len() > MAX_OPERATIONS_PER_TRANSACTION {
            return Err(CollaborationError::TooManyOperations);
        }
        if transaction.base().iter().count() > MAX_CAUSAL_REPLICAS {
            return Err(CollaborationError::TooManyCausalReplicas);
        }
        let expected_own_predecessor = transaction.dot().counter() - 1;
        let actual_own_predecessor = transaction.base().counter(transaction.dot().replica());
        if actual_own_predecessor != expected_own_predecessor {
            return Err(CollaborationError::InvalidOwnPredecessor {
                expected: expected_own_predecessor,
                actual: actual_own_predecessor,
            });
        }

        let mut ids = BTreeSet::new();
        let mut cell_effects = 0usize;
        let mut text_bytes = 0usize;
        for operation in transaction.operations() {
            if !valid_generic_stable_id(operation.id().stable_id()) {
                return Err(CollaborationError::ZeroOperationId);
            }
            if !ids.insert(operation.id()) {
                return Err(CollaborationError::DuplicateOperationInTransaction(
                    operation.id(),
                ));
            }
            match operation.command() {
                CollaborationCommand::CreateSheet { sheet_id, name, .. } => {
                    validate_sheet_id(*sheet_id)?;
                    Workbook::validate_sheet_name(name)
                        .map_err(CollaborationError::InvalidSheetName)?;
                    text_bytes = checked_text_bytes(text_bytes, name.len())?;
                }
                CollaborationCommand::RenameSheet { name, .. } => {
                    Workbook::validate_sheet_name(name)
                        .map_err(CollaborationError::InvalidSheetName)?;
                    text_bytes = checked_text_bytes(text_bytes, name.len())?;
                }
                CollaborationCommand::SetCells { anchor, cells, .. } => {
                    cells
                        .validate_anchor(*anchor)
                        .map_err(CollaborationError::InvalidCellBlock)?;
                    cell_effects = cell_effects
                        .checked_add(cells.cells().len())
                        .ok_or(CollaborationError::TooManyCells)?;
                    if cell_effects > MAX_CELLS_PER_TRANSACTION {
                        return Err(CollaborationError::TooManyCells);
                    }
                    for cell in cells.cells() {
                        text_bytes = checked_text_bytes(text_bytes, cell_text_bytes(cell)?)?;
                    }
                }
                CollaborationCommand::DeleteSheet { .. }
                | CollaborationCommand::ClearRange { .. }
                | CollaborationCommand::Undo { .. } => {}
            }
        }
        Ok(())
    }

    fn drain_ready(
        &mut self,
        mut initially_prepared: Option<(TransactionId, PreparedTransaction)>,
        materialize: bool,
    ) -> Result<DrainOutcome, CollaborationError> {
        let mut outcome = DrainOutcome::default();
        while let Some(dot) = self.ready.iter().next().copied() {
            self.ready.remove(&dot);
            let id = *self
                .pending
                .get(&dot)
                .ok_or(CollaborationError::InternalInvariant(
                    "ready transaction is absent",
                ))?;
            let mut known = self.known_transactions.remove(&id).ok_or(
                CollaborationError::InternalInvariant("pending transaction is absent"),
            )?;
            let prepared = match initially_prepared.take() {
                Some((prepared_id, prepared)) if prepared_id == id => Ok(prepared),
                Some(cached) => {
                    initially_prepared = Some(cached);
                    self.prepare_ready(&known.transaction)
                }
                None => self.prepare_ready(&known.transaction),
            };
            let prepared = match prepared {
                Ok(prepared) => prepared,
                Err(error) => {
                    self.pending.remove(&dot);
                    self.pending_waits.remove(&dot);
                    self.dot_owners.remove(&dot);
                    self.retained_history_bytes = self
                        .retained_history_bytes
                        .checked_sub(known.retained_bytes)
                        .ok_or(CollaborationError::InternalInvariant(
                            "retained history byte accounting underflow",
                        ))?;
                    if !self
                        .dot_owners
                        .keys()
                        .any(|candidate| candidate.replica() == dot.replica())
                    {
                        self.known_replicas.remove(&dot.replica());
                    }
                    for operation in known.transaction.operations() {
                        self.operation_owners.remove(&operation.id());
                    }
                    outcome.rejected.push(RejectedTransaction {
                        transaction_id: id,
                        error,
                    });
                    continue;
                }
            };
            self.apply_ready(&known.transaction, prepared, materialize)?;
            self.frontier.advance(dot)?;
            self.pending.remove(&dot);
            self.pending_waits.remove(&dot);
            self.satisfy_dependency(dot);
            known.status = KnownStatus::Applied;
            self.known_transactions.insert(id, known);
            outcome.applied.push(id);
        }
        Ok(outcome)
    }

    fn missing_dependencies(
        &self,
        base: &CausalFrontier,
    ) -> Result<BTreeSet<CausalDot>, CollaborationError> {
        base.iter()
            .filter(|(replica, counter)| self.frontier.counter(*replica) < *counter)
            .map(|(replica, counter)| CausalDot::new(replica, counter))
            .collect()
    }

    fn satisfy_dependency(&mut self, dependency: CausalDot) {
        let Some(waiters) = self.dependency_waiters.remove(&dependency) else {
            return;
        };
        for pending_dot in waiters {
            let Some(waits) = self.pending_waits.get_mut(&pending_dot) else {
                continue;
            };
            if waits.remove(&dependency) {
                self.pending_dependency_edges = self.pending_dependency_edges.saturating_sub(1);
            }
            if waits.is_empty() {
                self.ready.insert(pending_dot);
            }
        }
    }

    fn prepare_ready(
        &self,
        transaction: &CollaborationTransaction,
    ) -> Result<PreparedTransaction, CollaborationError> {
        self.validate_causal_base(transaction.base())?;
        let mut prepared = Vec::with_capacity(transaction.operations().len());
        let mut next_ids = self.workbook.ids.clone();
        let mut created_in_transaction = BTreeMap::new();
        let mut deleted_in_transaction = BTreeSet::new();
        let mut introduced_cells = BTreeSet::new();
        let mut introduced_range_clears: Vec<(SheetGeneration, crate::CellRange)> = Vec::new();
        let mut total_cell_effects = 0usize;

        for (operation_index, operation) in transaction.operations().iter().enumerate() {
            match operation.command() {
                CollaborationCommand::CreateSheet {
                    sheet_id, after, ..
                } => {
                    next_ids
                        .observe(*sheet_id)
                        .map_err(|_| CollaborationError::InvalidEntityId(*sheet_id))?;
                    if *sheet_id == self.workbook.id()
                        || self.sheets.contains_key(sheet_id)
                        || created_in_transaction.contains_key(sheet_id)
                    {
                        return Err(CollaborationError::SheetIdCollision(*sheet_id));
                    }
                    if let Some(predecessor) = after {
                        self.validate_predecessor(
                            *predecessor,
                            transaction.base(),
                            &created_in_transaction,
                            operation_index,
                        )?;
                    }
                    created_in_transaction.insert(*sheet_id, (operation.id(), operation_index));
                    prepared.push(PreparedOperation::Plain);
                }
                CollaborationCommand::RenameSheet { sheet, .. }
                | CollaborationCommand::DeleteSheet { sheet } => {
                    self.validate_sheet_live(
                        *sheet,
                        transaction.base(),
                        &created_in_transaction,
                        &deleted_in_transaction,
                        operation_index,
                    )?;
                    if matches!(
                        operation.command(),
                        CollaborationCommand::DeleteSheet { .. }
                    ) {
                        deleted_in_transaction.insert(*sheet);
                    }
                    prepared.push(PreparedOperation::Plain);
                }
                CollaborationCommand::SetCells {
                    sheet,
                    anchor,
                    cells,
                } => {
                    self.validate_sheet_live(
                        *sheet,
                        transaction.base(),
                        &created_in_transaction,
                        &deleted_in_transaction,
                        operation_index,
                    )?;
                    let mut keys = Vec::with_capacity(cells.cells().len());
                    for row in 0..cells.rows() {
                        for column in 0..cells.columns() {
                            let key = CellKey {
                                sheet_id: sheet.sheet_id(),
                                coord: CellCoord::new(anchor.row + row, anchor.column + column),
                            };
                            introduced_cells.insert(key);
                            keys.push(key);
                            total_cell_effects = total_cell_effects
                                .checked_add(1)
                                .ok_or(CollaborationError::TooManyCells)?;
                            let matching_clears = self
                                .range_clears
                                .values()
                                .filter(|clear| {
                                    clear.sheet == *sheet && clear.range.contains(key.coord)
                                })
                                .count()
                                + introduced_range_clears
                                    .iter()
                                    .filter(|clear| {
                                        clear.0 == *sheet && clear.1.contains(key.coord)
                                    })
                                    .count();
                            total_cell_effects = total_cell_effects
                                .checked_add(matching_clears)
                                .ok_or(CollaborationError::TooManyCells)?;
                        }
                    }
                    if total_cell_effects > MAX_CELLS_PER_TRANSACTION {
                        return Err(CollaborationError::TooManyCells);
                    }
                    prepared.push(PreparedOperation::Cells(keys));
                }
                CollaborationCommand::ClearRange { sheet, range } => {
                    self.validate_sheet_live(
                        *sheet,
                        transaction.base(),
                        &created_in_transaction,
                        &deleted_in_transaction,
                        operation_index,
                    )?;
                    let mut keys: BTreeSet<CellKey> = self
                        .cells
                        .keys()
                        .filter(|key| key.sheet_id == sheet.sheet_id() && range.contains(key.coord))
                        .copied()
                        .collect();
                    keys.extend(introduced_cells.iter().filter(|key| {
                        key.sheet_id == sheet.sheet_id() && range.contains(key.coord)
                    }));
                    total_cell_effects = total_cell_effects
                        .checked_add(keys.len())
                        .ok_or(CollaborationError::TooManyCells)?;
                    if total_cell_effects > MAX_CELLS_PER_TRANSACTION {
                        return Err(CollaborationError::TooManyCells);
                    }
                    prepared.push(PreparedOperation::Cells(keys.into_iter().collect()));
                    introduced_range_clears.push((*sheet, *range));
                }
                CollaborationCommand::Undo { target } => {
                    let target_record = self
                        .operations
                        .get(target)
                        .ok_or(CollaborationError::UnknownUndoTarget(*target))?;
                    if !transaction.base().observes(target_record.dot) {
                        return Err(CollaborationError::UndoTargetNotObserved(*target));
                    }
                    if matches!(target_record.kind, OperationKind::Undo { .. }) {
                        return Err(CollaborationError::CannotUndoUndo(*target));
                    }
                    let effect_count = match &target_record.effect {
                        OperationEffect::Cells(keys) => keys.len(),
                        OperationEffect::Range { sheet_id, range } => self
                            .cells
                            .keys()
                            .filter(|key| key.sheet_id == *sheet_id && range.contains(key.coord))
                            .count(),
                        _ => 0,
                    };
                    total_cell_effects = total_cell_effects
                        .checked_add(effect_count)
                        .ok_or(CollaborationError::TooManyCells)?;
                    if total_cell_effects > MAX_CELLS_PER_TRANSACTION {
                        return Err(CollaborationError::TooManyCells);
                    }
                    prepared.push(PreparedOperation::Plain);
                }
            }
        }
        Ok(PreparedTransaction {
            operations: prepared,
            next_ids,
        })
    }

    fn validate_causal_base(&self, base: &CausalFrontier) -> Result<(), CollaborationError> {
        let mut comparisons = 0usize;
        for (replica, counter) in base.iter() {
            let dependency = CausalDot::new(replica, counter)?;
            let owner =
                self.dot_owners
                    .get(&dependency)
                    .ok_or(CollaborationError::InternalInvariant(
                        "ready causal dependency is absent",
                    ))?;
            let known =
                self.known_transactions
                    .get(owner)
                    .ok_or(CollaborationError::InternalInvariant(
                        "causal dependency owner is absent",
                    ))?;
            for (required_replica, required_counter) in known.transaction.base().iter() {
                comparisons = comparisons
                    .checked_add(1)
                    .ok_or(CollaborationError::CausalBaseTooComplex)?;
                if comparisons > MAX_PENDING_DEPENDENCIES {
                    return Err(CollaborationError::CausalBaseTooComplex);
                }
                if base.counter(required_replica) < required_counter {
                    return Err(CollaborationError::CausalBaseNotClosed {
                        dependency,
                        missing: CausalDot::new(required_replica, required_counter)?,
                    });
                }
            }
        }
        Ok(())
    }

    fn validate_predecessor(
        &self,
        predecessor: SheetGeneration,
        base: &CausalFrontier,
        created_in_transaction: &BTreeMap<StableId, (OperationId, usize)>,
        operation_index: usize,
    ) -> Result<(), CollaborationError> {
        if let Some((creation, index)) = created_in_transaction.get(&predecessor.sheet_id()) {
            if *creation == predecessor.creation() && *index < operation_index {
                return Ok(());
            }
        }
        let history = self
            .sheets
            .get(&predecessor.sheet_id())
            .ok_or(CollaborationError::InvalidPredecessor(predecessor))?;
        if history.creation.operation_id != predecessor.creation()
            || !base.observes(history.creation.dot)
        {
            return Err(CollaborationError::InvalidPredecessor(predecessor));
        }
        // A tombstoned predecessor remains a valid sequence anchor. This is
        // what makes offline insertion stable when the predecessor is deleted.
        Ok(())
    }

    fn validate_sheet_live(
        &self,
        sheet: SheetGeneration,
        base: &CausalFrontier,
        created_in_transaction: &BTreeMap<StableId, (OperationId, usize)>,
        deleted_in_transaction: &BTreeSet<SheetGeneration>,
        operation_index: usize,
    ) -> Result<(), CollaborationError> {
        if let Some((creation, index)) = created_in_transaction.get(&sheet.sheet_id()) {
            if *creation == sheet.creation()
                && *index < operation_index
                && !deleted_in_transaction.contains(&sheet)
            {
                return Ok(());
            }
        }
        let history = self
            .sheets
            .get(&sheet.sheet_id())
            .ok_or(CollaborationError::UnknownSheetGeneration(sheet))?;
        if history.creation.operation_id != sheet.creation() || !base.observes(history.creation.dot)
        {
            return Err(CollaborationError::UnknownSheetGeneration(sheet));
        }
        if !self.sheet_live_at(history, base) || deleted_in_transaction.contains(&sheet) {
            return Err(CollaborationError::SheetNotLiveAtBase(sheet));
        }
        Ok(())
    }

    fn sheet_live_at(&self, history: &SheetHistory, base: &CausalFrontier) -> bool {
        if self.operation_undone_at(history.creation.operation_id, base) {
            return false;
        }
        !history.deletions.values().any(|deletion| {
            base.observes(deletion.dot) && !self.operation_undone_at(deletion.operation_id, base)
        })
    }

    fn operation_undone_at(&self, target: OperationId, base: &CausalFrontier) -> bool {
        self.undo_links.iter().any(|(undo_id, candidate_target)| {
            *candidate_target == target
                && self
                    .operations
                    .get(undo_id)
                    .is_some_and(|undo| base.observes(undo.dot))
        })
    }

    fn apply_ready(
        &mut self,
        transaction: &CollaborationTransaction,
        prepared: PreparedTransaction,
        materialize: bool,
    ) -> Result<(), CollaborationError> {
        let next_revision = self
            .workbook
            .revision()
            .checked_add(1)
            .ok_or(CollaborationError::RevisionExhausted)?;
        let shared_base = Arc::new(transaction.base().clone());
        let mut affected_cells = BTreeSet::new();
        let mut structural_change = false;

        for (operation_index, (operation, prepared)) in transaction
            .operations()
            .iter()
            .zip(prepared.operations)
            .enumerate()
        {
            let operation_index = u32::try_from(operation_index)
                .map_err(|_| CollaborationError::TooManyOperations)?;
            let (kind, effect) = match operation.command() {
                CollaborationCommand::CreateSheet {
                    sheet_id,
                    name,
                    after,
                } => {
                    let creation = SheetCreation {
                        operation_id: operation.id(),
                        dot: transaction.dot(),
                        operation_index,
                        base: Arc::clone(&shared_base),
                        after: *after,
                    };
                    let mut names = CausalRegister::default();
                    names.insert(
                        RegisterContribution {
                            operation_id: operation.id(),
                            dot: transaction.dot(),
                            operation_index,
                            base: Arc::clone(&shared_base),
                            value: name.clone(),
                        },
                        &self.undone,
                    );
                    self.sheets.insert(
                        *sheet_id,
                        SheetHistory {
                            creation,
                            names,
                            deletions: BTreeMap::new(),
                        },
                    );
                    structural_change = true;
                    (
                        OperationKind::CreateSheet,
                        OperationEffect::Sheet(*sheet_id),
                    )
                }
                CollaborationCommand::RenameSheet { sheet, name } => {
                    self.sheets
                        .get_mut(&sheet.sheet_id())
                        .ok_or(CollaborationError::InternalInvariant(
                            "validated sheet disappeared",
                        ))?
                        .names
                        .insert(
                            RegisterContribution {
                                operation_id: operation.id(),
                                dot: transaction.dot(),
                                operation_index,
                                base: Arc::clone(&shared_base),
                                value: name.clone(),
                            },
                            &self.undone,
                        );
                    structural_change = true;
                    (
                        OperationKind::RenameSheet,
                        OperationEffect::Sheet(sheet.sheet_id()),
                    )
                }
                CollaborationCommand::DeleteSheet { sheet } => {
                    self.sheets
                        .get_mut(&sheet.sheet_id())
                        .ok_or(CollaborationError::InternalInvariant(
                            "validated sheet disappeared",
                        ))?
                        .deletions
                        .insert(
                            operation.id(),
                            StructuralContribution {
                                operation_id: operation.id(),
                                dot: transaction.dot(),
                                operation_index,
                                base: Arc::clone(&shared_base),
                            },
                        );
                    structural_change = true;
                    (
                        OperationKind::DeleteSheet,
                        OperationEffect::Sheet(sheet.sheet_id()),
                    )
                }
                CollaborationCommand::SetCells { sheet, cells, .. } => {
                    let PreparedOperation::Cells(keys) = prepared else {
                        return Err(CollaborationError::InternalInvariant(
                            "set-cells preparation is missing",
                        ));
                    };
                    for (key, cell) in keys.iter().copied().zip(cells.cells()) {
                        let register = self.cells.entry(key).or_default();
                        register.insert(
                            RegisterContribution {
                                operation_id: operation.id(),
                                dot: transaction.dot(),
                                operation_index,
                                base: Arc::clone(&shared_base),
                                value: cell.clone(),
                            },
                            &self.undone,
                        );
                        for clear in self.range_clears.values().filter(|clear| {
                            clear.sheet == *sheet && clear.range.contains(key.coord)
                        }) {
                            register.insert(
                                RegisterContribution {
                                    operation_id: clear.operation_id,
                                    dot: clear.dot,
                                    operation_index: clear.operation_index,
                                    base: Arc::clone(&clear.base),
                                    value: Cell::empty(),
                                },
                                &self.undone,
                            );
                        }
                        affected_cells.insert(key);
                    }
                    (OperationKind::SetCells, OperationEffect::Cells(keys))
                }
                CollaborationCommand::ClearRange { sheet, range } => {
                    let PreparedOperation::Cells(keys) = prepared else {
                        return Err(CollaborationError::InternalInvariant(
                            "clear-range preparation is missing",
                        ));
                    };
                    let clear = RangeClearRecord {
                        operation_id: operation.id(),
                        dot: transaction.dot(),
                        operation_index,
                        base: Arc::clone(&shared_base),
                        sheet: *sheet,
                        range: *range,
                    };
                    for key in &keys {
                        self.cells.entry(*key).or_default().insert(
                            RegisterContribution {
                                operation_id: operation.id(),
                                dot: transaction.dot(),
                                operation_index,
                                base: Arc::clone(&shared_base),
                                value: Cell::empty(),
                            },
                            &self.undone,
                        );
                        affected_cells.insert(*key);
                    }
                    self.range_clears.insert(operation.id(), clear);
                    (
                        OperationKind::ClearRange,
                        OperationEffect::Range {
                            sheet_id: sheet.sheet_id(),
                            range: *range,
                        },
                    )
                }
                CollaborationCommand::Undo { target } => {
                    self.undone.insert(*target);
                    self.undo_links.insert(operation.id(), *target);
                    let target_record = self.operations.get(target).ok_or(
                        CollaborationError::InternalInvariant("validated undo target disappeared"),
                    )?;
                    let target_kind = target_record.kind.clone();
                    let target_effect = target_record.effect.clone();
                    match target_effect {
                        OperationEffect::Sheet(sheet_id) => {
                            if matches!(target_kind, OperationKind::RenameSheet) {
                                if let Some(history) = self.sheets.get_mut(&sheet_id) {
                                    history.names.recompute_maximal(&self.undone);
                                }
                            }
                            structural_change = true;
                        }
                        OperationEffect::Cells(keys) => {
                            for key in keys {
                                if let Some(register) = self.cells.get_mut(&key) {
                                    register.recompute_maximal(&self.undone);
                                }
                                affected_cells.insert(key);
                            }
                        }
                        OperationEffect::Range { sheet_id, range } => {
                            let keys: Vec<_> = self
                                .cells
                                .keys()
                                .filter(|key| key.sheet_id == sheet_id && range.contains(key.coord))
                                .copied()
                                .collect();
                            for key in keys {
                                if let Some(register) = self.cells.get_mut(&key) {
                                    register.recompute_maximal(&self.undone);
                                }
                                affected_cells.insert(key);
                            }
                        }
                        OperationEffect::Undo(_) => {
                            return Err(CollaborationError::InternalInvariant(
                                "undo-of-undo passed validation",
                            ));
                        }
                    }
                    (
                        OperationKind::Undo { target: *target },
                        OperationEffect::Undo(*target),
                    )
                }
            };
            self.operations.insert(
                operation.id(),
                OperationRecord {
                    dot: transaction.dot(),
                    operation_index,
                    kind,
                    effect,
                },
            );
        }

        if materialize {
            if structural_change {
                self.rebuild_materialized(next_revision, prepared.next_ids.clone())?;
            } else {
                self.refresh_materialized_cells(&affected_cells, next_revision)?;
                self.workbook.ids = prepared.next_ids;
            }
        } else {
            self.workbook.revision = next_revision;
            self.workbook.ids = prepared.next_ids;
        }
        Ok(())
    }

    fn refresh_materialized_cells(
        &mut self,
        keys: &BTreeSet<CellKey>,
        revision: u64,
    ) -> Result<(), CollaborationError> {
        let mut commands = Vec::with_capacity(keys.len());
        for key in keys {
            let visible = self
                .cells
                .get(key)
                .and_then(CausalRegister::visible)
                .map(|contribution| contribution.value.clone())
                .unwrap_or_else(Cell::empty);
            if self.workbook.sheets.contains_key(&key.sheet_id) {
                commands.push(Command::SetCells {
                    sheet_id: key.sheet_id,
                    anchor: key.coord,
                    cells: CellBlock::new(1, 1, vec![visible]).map_err(|_| {
                        CollaborationError::InternalInvariant(
                            "single-cell materialization block is invalid",
                        )
                    })?,
                });
            }
        }
        if commands.is_empty() {
            self.workbook.revision = revision;
            return Ok(());
        }
        let receipt = self
            .workbook
            .apply_batch(&AtomicBatch::from_commands(commands))
            .map_err(|_| {
                CollaborationError::InternalInvariant(
                    "formula-aware cell materialization was rejected",
                )
            })?;
        if receipt.revision != revision {
            return Err(CollaborationError::InternalInvariant(
                "materialized workbook revision diverged",
            ));
        }
        Ok(())
    }

    fn rebuild_materialized(
        &mut self,
        revision: u64,
        ids: crate::IdGenerator,
    ) -> Result<(), CollaborationError> {
        let all_order = self.ordered_sheet_ids();
        let mut sheet_order = Vec::new();
        let mut sheets = BTreeMap::new();
        let mut used_names = BTreeSet::new();
        for sheet_id in all_order {
            let Some(history) = self.sheets.get(&sheet_id) else {
                continue;
            };
            if !self.sheet_live_current(history) {
                continue;
            }
            let desired_name = history
                .names
                .visible()
                .map(|name| name.value.as_str())
                .unwrap_or("Sheet");
            let name = unique_sheet_name(desired_name, sheet_id, &mut used_names);
            sheet_order.push(sheet_id);
            sheets.insert(sheet_id, Sheet::new(sheet_id, name));
        }
        for (key, register) in &self.cells {
            if let Some(sheet) = sheets.get_mut(&key.sheet_id) {
                if let Some(visible) = register.visible() {
                    sheet.set_cell(key.coord, visible.value.clone());
                }
            }
        }
        self.workbook =
            Workbook::from_snapshot_parts(self.workbook.id, revision, ids, sheet_order, sheets)
                .map_err(|_| {
                    CollaborationError::InternalInvariant(
                        "formula-aware structural materialization was rejected",
                    )
                })?;
        Ok(())
    }

    fn sheet_live_current(&self, history: &SheetHistory) -> bool {
        !self.undone.contains(&history.creation.operation_id)
            && !history
                .deletions
                .keys()
                .any(|operation_id| !self.undone.contains(operation_id))
    }

    fn ordered_sheet_ids(&self) -> Vec<StableId> {
        let mut children: BTreeMap<Option<StableId>, Vec<(OperationId, StableId)>> =
            BTreeMap::new();
        for (sheet_id, history) in &self.sheets {
            children
                .entry(history.creation.after.map(SheetGeneration::sheet_id))
                .or_default()
                .push((history.creation.operation_id, *sheet_id));
        }
        for siblings in children.values_mut() {
            siblings.sort_unstable();
        }
        let mut ordered = Vec::with_capacity(self.sheets.len());
        let mut visited = BTreeSet::new();
        append_sequence_children(None, &children, &mut visited, &mut ordered);
        // Valid operations are acyclic and reachable. Keeping this deterministic
        // fallback makes corrupted in-memory state fail visible rather than loop.
        for sheet_id in self.sheets.keys() {
            if visited.insert(*sheet_id) {
                ordered.push(*sheet_id);
                append_sequence_children(Some(*sheet_id), &children, &mut visited, &mut ordered);
            }
        }
        ordered
    }
}

#[derive(Clone, Debug, PartialEq)]
enum PreparedOperation {
    Plain,
    Cells(Vec<CellKey>),
}

#[derive(Clone, Debug, PartialEq)]
struct PreparedTransaction {
    operations: Vec<PreparedOperation>,
    next_ids: crate::IdGenerator,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct DrainOutcome {
    applied: Vec<TransactionId>,
    rejected: Vec<RejectedTransaction>,
}

fn append_sequence_children(
    parent: Option<StableId>,
    children: &BTreeMap<Option<StableId>, Vec<(OperationId, StableId)>>,
    visited: &mut BTreeSet<StableId>,
    output: &mut Vec<StableId>,
) {
    let mut stack = Vec::new();
    if let Some(siblings) = children.get(&parent) {
        stack.extend(siblings.iter().rev().map(|(_, sheet_id)| *sheet_id));
    }
    while let Some(sheet_id) = stack.pop() {
        if visited.insert(sheet_id) {
            output.push(sheet_id);
            if let Some(descendants) = children.get(&Some(sheet_id)) {
                stack.extend(descendants.iter().rev().map(|(_, descendant)| *descendant));
            }
        }
    }
}

fn validate_sheet_id(sheet_id: StableId) -> Result<(), CollaborationError> {
    if sheet_id.namespace() == 0 || sheet_id.counter() == 0 {
        return Err(CollaborationError::ZeroSheetId);
    }
    Ok(())
}

const fn valid_generic_stable_id(id: StableId) -> bool {
    !id.is_zero()
}

fn checked_text_bytes(current: usize, additional: usize) -> Result<usize, CollaborationError> {
    let total = current
        .checked_add(additional)
        .ok_or(CollaborationError::TransactionTextLimit)?;
    if total > MAX_TRANSACTION_TEXT_BYTES {
        return Err(CollaborationError::TransactionTextLimit);
    }
    Ok(total)
}

fn cell_text_bytes(cell: &Cell) -> Result<usize, CollaborationError> {
    let formula = cell.formula_source().map_or(0, str::len);
    if formula > 8 * 1024 {
        return Err(CollaborationError::TransactionTextLimit);
    }
    let value = match cell.value() {
        CellValue::Text(text) => {
            if text.len() > 16 * 1024 * 1024 {
                return Err(CollaborationError::TransactionTextLimit);
            }
            text.len()
        }
        CellValue::Error(crate::FormulaError::Custom(text)) => {
            if text.len() > 16 * 1024 * 1024 {
                return Err(CollaborationError::TransactionTextLimit);
            }
            text.len()
        }
        _ => 0,
    };
    formula
        .checked_add(value)
        .ok_or(CollaborationError::TransactionTextLimit)
}

fn unique_sheet_name(desired: &str, sheet_id: StableId, used: &mut BTreeSet<String>) -> String {
    if used.insert(desired.to_owned()) {
        return desired.to_owned();
    }
    let suffix = format!("~{:08x}", sheet_id.counter() as u32);
    let maximum_prefix = MAX_SHEET_NAME_BYTES.saturating_sub(suffix.len());
    let mut boundary = desired.len().min(maximum_prefix);
    while !desired.is_char_boundary(boundary) {
        boundary -= 1;
    }
    let candidate = format!("{}{}", &desired[..boundary], suffix);
    if used.insert(candidate.clone()) {
        return candidate;
    }
    // An authored name can imitate a derived suffix. The full stable id plus
    // a deterministic ordinal makes uniqueness total without arrival order.
    let mut ordinal = 0u64;
    loop {
        let suffix = if ordinal == 0 {
            format!("~{sheet_id}")
        } else {
            format!("~{sheet_id}-{ordinal}")
        };
        let maximum_prefix = MAX_SHEET_NAME_BYTES.saturating_sub(suffix.len());
        let mut boundary = desired.len().min(maximum_prefix);
        while !desired.is_char_boundary(boundary) {
            boundary -= 1;
        }
        let candidate = format!("{}{}", &desired[..boundary], suffix);
        if used.insert(candidate.clone()) {
            return candidate;
        }
        ordinal = ordinal.saturating_add(1);
    }
}

#[cfg(test)]
mod tests;
