use core::fmt;
use std::collections::{BTreeMap, BTreeSet};

use crate::{
    formula::{FormulaCellKey, FormulaEngine, FormulaEngineError},
    Cell, CellBlock, CellBlockError, CellCoord, CellRange, IdGenerator, Sheet, StableId, Workbook,
};

#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    CreateSheet {
        id: StableId,
        name: String,
    },
    RenameSheet {
        id: StableId,
        name: String,
    },
    DeleteSheet {
        id: StableId,
    },
    SetCells {
        sheet_id: StableId,
        anchor: CellCoord,
        cells: CellBlock,
    },
    ClearRange {
        sheet_id: StableId,
        range: CellRange,
    },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AtomicBatch {
    commands: Vec<Command>,
}

impl AtomicBatch {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            commands: Vec::new(),
        }
    }

    #[must_use]
    pub fn from_commands(commands: Vec<Command>) -> Self {
        Self { commands }
    }

    pub fn push(&mut self, command: Command) -> &mut Self {
        self.commands.push(command);
        self
    }

    #[must_use]
    pub fn commands(&self) -> &[Command] {
        &self.commands
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.commands.is_empty()
    }
}

impl Workbook {
    /// Applies the complete command list or leaves all workbook content and its
    /// revision unchanged. Validation models catalog changes sequentially, so a
    /// sheet can be created and populated in one batch.
    pub fn apply_batch(&mut self, batch: &AtomicBatch) -> Result<BatchReceipt, BatchError> {
        if batch.is_empty() {
            return Ok(BatchReceipt::empty(self.revision));
        }
        let plan = self.prepare_batch(batch)?;
        let formula_projection = self.prepare_formula_projection(batch)?;
        Ok(self.apply_prepared_batch(batch, plan, &formula_projection.keys))
    }

    /// Applies a validated batch behind an auto-rollback guard.
    ///
    /// This path is intended for callers that must perform an exact post-apply
    /// check (for example, an encoded snapshot-size boundary) before accepting
    /// the mutation. The journal retains only overwritten/cleared cell values
    /// and moves deleted sheets into the journal; it never clones the workbook
    /// or an untouched tile. Dropping the guard restores the byte-identical
    /// pre-transaction model. Call [`BatchTransaction::commit`] only after all
    /// post-apply checks succeed.
    pub fn begin_batch<'a>(
        &'a mut self,
        batch: &AtomicBatch,
    ) -> Result<BatchTransaction<'a>, BatchError> {
        if batch.is_empty() {
            let revision = self.revision;
            return Ok(BatchTransaction {
                workbook: self,
                receipt: BatchReceipt::empty(revision),
                journal: None,
            });
        }

        let plan = self.prepare_batch(batch)?;
        let formula_projection = self.prepare_formula_projection(batch)?;
        let mut transaction = BatchTransaction {
            receipt: BatchReceipt {
                revision: plan.next_revision,
                command_count: batch.commands().len(),
                written_cells: 0,
                cleared_cells: 0,
            },
            journal: Some(BatchJournal::new(
                self,
                batch.commands().len(),
                formula_projection.engine_changed,
            )),
            workbook: self,
        };
        transaction.apply(batch, plan, &formula_projection.keys);
        Ok(transaction)
    }

    /// Applies a completely validated plan. Every operation in this phase is
    /// infallible; therefore the common commit path needs no rollback storage.
    fn apply_prepared_batch(
        &mut self,
        batch: &AtomicBatch,
        plan: BatchPlan,
        formula_projection: &BTreeSet<FormulaCellKey>,
    ) -> BatchReceipt {
        let mut written_cells = 0usize;
        let mut cleared_cells = 0usize;
        for command in batch.commands() {
            match command {
                Command::CreateSheet { id, name } => {
                    self.sheet_order.push(*id);
                    self.sheets.insert(*id, Sheet::new(*id, name.clone()));
                }
                Command::RenameSheet { id, name } => {
                    self.sheets
                        .get_mut(id)
                        .expect("prepared rename sheet must exist")
                        .name
                        .clone_from(name);
                }
                Command::DeleteSheet { id } => {
                    self.sheets
                        .remove(id)
                        .expect("prepared delete sheet must exist");
                    let order_index = self
                        .sheet_order
                        .iter()
                        .position(|candidate| candidate == id)
                        .expect("prepared delete sheet must be ordered");
                    self.sheet_order.remove(order_index);
                }
                Command::SetCells {
                    sheet_id,
                    anchor,
                    cells,
                } => {
                    self.sheets
                        .get_mut(sheet_id)
                        .expect("prepared write sheet must exist")
                        .set_block(*anchor, cells);
                    written_cells += cells.cells().len();
                }
                Command::ClearRange { sheet_id, range } => {
                    cleared_cells += self
                        .sheets
                        .get_mut(sheet_id)
                        .expect("prepared clear sheet must exist")
                        .clear_range(*range);
                }
            }
        }
        self.ids = plan.next_ids;
        self.revision = plan.next_revision;
        self.project_formula_cells(formula_projection);
        BatchReceipt {
            revision: plan.next_revision,
            command_count: batch.commands().len(),
            written_cells,
            cleared_cells,
        }
    }

    fn prepare_formula_projection(
        &mut self,
        batch: &AtomicBatch,
    ) -> Result<FormulaProjection, BatchError> {
        let result = apply_formula_commands(&mut self.formula_engine, &self.sheets, batch);
        match result {
            Ok(keys) => Ok(keys),
            Err(error) => {
                // The authored workbook is still untouched. Rebuilding only
                // on the rejected path restores the exact derived state while
                // keeping successful edits allocation-light.
                self.formula_engine = FormulaEngine::from_workbook(self)
                    .expect("committed workbook formula state must rebuild");
                Err(error)
            }
        }
    }

    fn project_formula_cells(&mut self, keys: &BTreeSet<FormulaCellKey>) {
        let projected: Vec<_> = keys
            .iter()
            .filter_map(|key| {
                self.formula_engine
                    .projected_cell(*key)
                    .map(|cell| (*key, cell))
            })
            .collect();
        for (key, cell) in projected {
            self.sheets
                .get_mut(&key.sheet_id)
                .expect("formula catalog and workbook catalog must agree")
                .set_cell(key.coordinate, cell);
        }
    }

    fn prepare_batch<'a>(&'a self, batch: &'a AtomicBatch) -> Result<BatchPlan, BatchError> {
        let next_revision = self.revision.checked_add(1).ok_or(BatchError {
            command_index: 0,
            kind: CommandErrorKind::RevisionExhausted,
        })?;

        // The catalog simulator borrows names from the live model and command
        // buffer. Preflight cost is independent of sheet contents: no cells,
        // tiles, strings, or complete model are cloned.
        let mut catalog: BTreeMap<StableId, &'a str> = self
            .sheets
            .iter()
            .map(|(id, sheet)| (*id, sheet.name.as_str()))
            .collect();
        let mut names: BTreeSet<&'a str> = catalog.values().copied().collect();
        let mut ids = self.ids.clone();

        for (command_index, command) in batch.commands().iter().enumerate() {
            let fail = |kind| BatchError {
                command_index,
                kind,
            };
            match command {
                Command::CreateSheet { id, name } => {
                    if id.is_zero() {
                        return Err(fail(CommandErrorKind::ZeroId));
                    }
                    ids.observe(*id)
                        .map_err(|_| fail(CommandErrorKind::InvalidEntityId(*id)))?;
                    Self::validate_sheet_name(name)
                        .map_err(|error| fail(CommandErrorKind::InvalidSheetName(error)))?;
                    if catalog.contains_key(id) {
                        return Err(fail(CommandErrorKind::DuplicateSheetId(*id)));
                    }
                    if !names.insert(name.as_str()) {
                        return Err(fail(CommandErrorKind::DuplicateSheetName(name.clone())));
                    }
                    catalog.insert(*id, name.as_str());
                }
                Command::RenameSheet { id, name } => {
                    Self::validate_sheet_name(name)
                        .map_err(|error| fail(CommandErrorKind::InvalidSheetName(error)))?;
                    let previous = *catalog
                        .get(id)
                        .ok_or_else(|| fail(CommandErrorKind::UnknownSheet(*id)))?;
                    if previous != name && names.contains(name.as_str()) {
                        return Err(fail(CommandErrorKind::DuplicateSheetName(name.clone())));
                    }
                    names.remove(previous);
                    names.insert(name.as_str());
                    catalog.insert(*id, name.as_str());
                }
                Command::DeleteSheet { id } => {
                    let previous = catalog
                        .remove(id)
                        .ok_or_else(|| fail(CommandErrorKind::UnknownSheet(*id)))?;
                    names.remove(previous);
                }
                Command::SetCells {
                    sheet_id,
                    anchor,
                    cells,
                } => {
                    if !catalog.contains_key(sheet_id) {
                        return Err(fail(CommandErrorKind::UnknownSheet(*sheet_id)));
                    }
                    cells
                        .validate_anchor(*anchor)
                        .map_err(|error| fail(CommandErrorKind::InvalidCellBlock(error)))?;
                }
                Command::ClearRange { sheet_id, .. } => {
                    if !catalog.contains_key(sheet_id) {
                        return Err(fail(CommandErrorKind::UnknownSheet(*sheet_id)));
                    }
                }
            }
        }
        Ok(BatchPlan {
            next_revision,
            next_ids: ids,
        })
    }
}

fn apply_formula_commands(
    engine: &mut FormulaEngine,
    sheets: &BTreeMap<StableId, Sheet>,
    batch: &AtomicBatch,
) -> Result<FormulaProjection, BatchError> {
    let mut projection = BTreeSet::new();
    let mut engine_changed = false;
    for (command_index, command) in batch.commands().iter().enumerate() {
        let result = match command {
            Command::CreateSheet { id, name } => {
                engine.register_sheet(*id, name.clone()).map(|()| {
                    engine_changed = true;
                })
            }
            Command::RenameSheet { id, name } => engine
                .rename_sheet_with_rewrites(*id, name.clone())
                .map(|rewritten| {
                    engine_changed = true;
                    projection.extend(rewritten);
                }),
            Command::DeleteSheet { id } => {
                engine.delete_sheet_with_rewrites(*id).map(|rewritten| {
                    engine_changed = true;
                    projection.extend(rewritten);
                })
            }
            Command::SetCells {
                sheet_id,
                anchor,
                cells,
            } => {
                let mut result = Ok(());
                for row in 0..cells.rows() {
                    for column in 0..cells.columns() {
                        if result.is_err() {
                            break;
                        }
                        let index = row as usize * cells.columns() as usize + column as usize;
                        let key = FormulaCellKey::new(
                            *sheet_id,
                            CellCoord::new(anchor.row + row, anchor.column + column),
                        );
                        let cell = &cells.cells()[index];
                        result = if let Some(source) = cell.formula_source() {
                            projection.insert(key);
                            engine.set_formula(key, source).map(|receipt| {
                                engine_changed |= receipt.content_changed;
                            })
                        } else {
                            engine
                                .set_value_if_tracked(key, cell.value().clone())
                                .map(|receipt| {
                                    engine_changed |=
                                        receipt.is_some_and(|receipt| receipt.content_changed);
                                })
                        };
                    }
                }
                result
            }
            Command::ClearRange { sheet_id, range } => {
                let touched = engine.has_tracked_cell_in_range(*sheet_id, *range);
                engine.clear_range(*sheet_id, *range).map(|()| {
                    engine_changed |= touched;
                })
            }
        };
        result.map_err(|error| BatchError {
            command_index,
            kind: CommandErrorKind::Formula(error),
        })?;
    }

    // A formula authored later in the batch can introduce a precedent that an
    // earlier value write could not yet see. Resolve only those still-empty
    // sparse inputs against the committed workbook plus the ordered batch.
    for (key, value) in final_values_for_keys(sheets, batch, engine.take_unhydrated_input_keys()) {
        if let Some(receipt) =
            engine
                .set_value_if_tracked(key, value)
                .map_err(|error| BatchError {
                    command_index: batch.commands().len().saturating_sub(1),
                    kind: CommandErrorKind::Formula(error),
                })?
        {
            engine_changed |= receipt.content_changed;
        }
    }
    let recalculation = engine.recalculate().map_err(|error| BatchError {
        command_index: batch.commands().len().saturating_sub(1),
        kind: CommandErrorKind::Formula(error),
    })?;
    projection.extend(recalculation.changed_cells);
    Ok(FormulaProjection {
        keys: projection,
        engine_changed,
    })
}

fn final_values_for_keys(
    sheets: &BTreeMap<StableId, Sheet>,
    batch: &AtomicBatch,
    keys: Vec<FormulaCellKey>,
) -> Vec<(FormulaCellKey, crate::CellValue)> {
    let mut values: BTreeMap<StableId, BTreeMap<CellCoord, crate::CellValue>> = BTreeMap::new();
    for key in keys {
        let value = sheets
            .get(&key.sheet_id)
            .and_then(|sheet| sheet.cell(key.coordinate))
            .filter(|cell| cell.formula_source().is_none())
            .map_or(crate::CellValue::Empty, |cell| cell.value().clone());
        values
            .entry(key.sheet_id)
            .or_default()
            .insert(key.coordinate, value);
    }

    for command in batch.commands() {
        match command {
            Command::CreateSheet { id, .. } => {
                if let Some(sheet_values) = values.get_mut(id) {
                    for value in sheet_values.values_mut() {
                        *value = crate::CellValue::Empty;
                    }
                }
            }
            Command::RenameSheet { .. } | Command::DeleteSheet { .. } => {}
            Command::SetCells {
                sheet_id,
                anchor,
                cells,
            } => {
                let Some(sheet_values) = values.get_mut(sheet_id) else {
                    continue;
                };
                let end_row = anchor.row + cells.rows() - 1;
                let end_column = anchor.column + cells.columns() - 1;
                let affected: Vec<_> = sheet_values
                    .range(CellCoord::new(anchor.row, 0)..=CellCoord::new(end_row, u32::MAX))
                    .map(|(coordinate, _)| *coordinate)
                    .filter(|coordinate| {
                        coordinate.column >= anchor.column && coordinate.column <= end_column
                    })
                    .collect();
                for coordinate in affected {
                    let row = (coordinate.row - anchor.row) as usize;
                    let column = (coordinate.column - anchor.column) as usize;
                    let index = row * cells.columns() as usize + column;
                    let cell = &cells.cells()[index];
                    let value = if cell.formula_source().is_some() {
                        crate::CellValue::Empty
                    } else {
                        cell.value().clone()
                    };
                    sheet_values.insert(coordinate, value);
                }
            }
            Command::ClearRange { sheet_id, range } => {
                let Some(sheet_values) = values.get_mut(sheet_id) else {
                    continue;
                };
                let affected: Vec<_> = sheet_values
                    .range(
                        CellCoord::new(range.start.row, 0)
                            ..=CellCoord::new(range.end.row, u32::MAX),
                    )
                    .map(|(coordinate, _)| *coordinate)
                    .filter(|coordinate| range.contains(*coordinate))
                    .collect();
                for coordinate in affected {
                    sheet_values.insert(coordinate, crate::CellValue::Empty);
                }
            }
        }
    }

    values
        .into_iter()
        .flat_map(|(sheet_id, values)| {
            values
                .into_iter()
                .map(move |(coordinate, value)| (FormulaCellKey::new(sheet_id, coordinate), value))
        })
        .collect()
}

#[derive(Debug)]
struct FormulaProjection {
    keys: BTreeSet<FormulaCellKey>,
    engine_changed: bool,
}

#[derive(Debug)]
struct BatchPlan {
    next_revision: u64,
    next_ids: IdGenerator,
}

#[derive(Debug)]
enum UndoEntry {
    CreatedSheet {
        id: StableId,
        order_index: usize,
    },
    RenamedSheet {
        id: StableId,
        previous_name: String,
    },
    DeletedSheet {
        sheet: Sheet,
        order_index: usize,
    },
    ReplacedCells {
        sheet_id: StableId,
        cells: Vec<(CellCoord, Option<Cell>)>,
    },
    ClearedCells {
        sheet_id: StableId,
        cells: Vec<(CellCoord, Cell)>,
    },
}

#[derive(Debug)]
struct BatchJournal {
    previous_revision: u64,
    previous_ids: IdGenerator,
    formula_state_changed: bool,
    undo: Vec<UndoEntry>,
}

impl BatchJournal {
    fn new(workbook: &Workbook, command_count: usize, formula_state_changed: bool) -> Self {
        Self {
            previous_revision: workbook.revision,
            previous_ids: workbook.ids.clone(),
            formula_state_changed,
            undo: Vec::with_capacity(command_count),
        }
    }

    fn rollback(self, workbook: &mut Workbook) {
        for undo in self.undo.into_iter().rev() {
            match undo {
                UndoEntry::CreatedSheet { id, order_index } => {
                    let removed = workbook.sheets.remove(&id);
                    debug_assert!(removed.is_some());
                    if workbook.sheet_order.get(order_index) == Some(&id) {
                        workbook.sheet_order.remove(order_index);
                    } else {
                        debug_assert!(false, "created sheet order changed during transaction");
                        workbook.sheet_order.retain(|candidate| *candidate != id);
                    }
                }
                UndoEntry::RenamedSheet { id, previous_name } => {
                    if let Some(sheet) = workbook.sheets.get_mut(&id) {
                        sheet.name = previous_name;
                    } else {
                        debug_assert!(false, "renamed sheet disappeared during transaction");
                    }
                }
                UndoEntry::DeletedSheet { sheet, order_index } => {
                    let id = sheet.id;
                    let previous = workbook.sheets.insert(id, sheet);
                    debug_assert!(previous.is_none());
                    workbook.sheet_order.insert(order_index, id);
                }
                UndoEntry::ReplacedCells { sheet_id, cells } => {
                    if let Some(sheet) = workbook.sheets.get_mut(&sheet_id) {
                        for (coord, previous) in cells {
                            sheet.set_cell(coord, previous.unwrap_or_else(Cell::empty));
                        }
                    } else {
                        debug_assert!(false, "written sheet disappeared during transaction");
                    }
                }
                UndoEntry::ClearedCells { sheet_id, cells } => {
                    if let Some(sheet) = workbook.sheets.get_mut(&sheet_id) {
                        for (coord, cell) in cells {
                            sheet.set_cell(coord, cell);
                        }
                    } else {
                        debug_assert!(false, "cleared sheet disappeared during transaction");
                    }
                }
            }
        }
        workbook.ids = self.previous_ids;
        workbook.revision = self.previous_revision;
        if self.formula_state_changed {
            workbook
                .rebuild_formula_engine()
                .expect("rolled-back committed formula state must rebuild");
        }
    }

    #[cfg(test)]
    fn retained_cell_count(&self) -> usize {
        self.undo
            .iter()
            .map(|entry| match entry {
                UndoEntry::ReplacedCells { cells, .. } => cells.len(),
                UndoEntry::ClearedCells { cells, .. } => cells.len(),
                _ => 0,
            })
            .sum()
    }
}

/// A tentatively applied workbook batch.
///
/// The guard exposes an immutable post-apply model for exact validation. It
/// rolls back automatically unless explicitly committed, including during
/// unwinding. It deliberately has no mutable workbook accessor: every mutation
/// represented by the guard must remain covered by its inverse journal.
#[must_use = "dropping a batch transaction rolls it back; call commit to accept it"]
pub struct BatchTransaction<'a> {
    workbook: &'a mut Workbook,
    receipt: BatchReceipt,
    journal: Option<BatchJournal>,
}

impl BatchTransaction<'_> {
    fn apply(
        &mut self,
        batch: &AtomicBatch,
        plan: BatchPlan,
        formula_projection: &BTreeSet<FormulaCellKey>,
    ) {
        let journal = self
            .journal
            .as_mut()
            .expect("non-empty batch transaction must have a journal");

        for command in batch.commands() {
            match command {
                Command::CreateSheet { id, name } => {
                    let order_index = self.workbook.sheet_order.len();
                    self.workbook.sheet_order.push(*id);
                    let previous = self
                        .workbook
                        .sheets
                        .insert(*id, Sheet::new(*id, name.clone()));
                    debug_assert!(previous.is_none());
                    journal.undo.push(UndoEntry::CreatedSheet {
                        id: *id,
                        order_index,
                    });
                }
                Command::RenameSheet { id, name } => {
                    let sheet = self
                        .workbook
                        .sheets
                        .get_mut(id)
                        .expect("prepared rename sheet must exist");
                    let previous_name = core::mem::replace(&mut sheet.name, name.clone());
                    journal.undo.push(UndoEntry::RenamedSheet {
                        id: *id,
                        previous_name,
                    });
                }
                Command::DeleteSheet { id } => {
                    let sheet = self
                        .workbook
                        .sheets
                        .remove(id)
                        .expect("prepared delete sheet must exist");
                    let order_index = self
                        .workbook
                        .sheet_order
                        .iter()
                        .position(|candidate| candidate == id)
                        .expect("prepared delete sheet must be ordered");
                    self.workbook.sheet_order.remove(order_index);
                    journal
                        .undo
                        .push(UndoEntry::DeletedSheet { sheet, order_index });
                }
                Command::SetCells {
                    sheet_id,
                    anchor,
                    cells,
                } => {
                    let mut previous_cells = Vec::with_capacity(cells.cells().len());
                    let sheet = self
                        .workbook
                        .sheets
                        .get_mut(sheet_id)
                        .expect("prepared write sheet must exist");
                    for row in 0..cells.rows() {
                        for column in 0..cells.columns() {
                            let index = row as usize * cells.columns() as usize + column as usize;
                            let coord = CellCoord::new(anchor.row + row, anchor.column + column);
                            let previous = sheet.replace_cell(coord, cells.cells()[index].clone());
                            previous_cells.push((coord, previous));
                        }
                    }
                    self.receipt.written_cells += cells.cells().len();
                    journal.undo.push(UndoEntry::ReplacedCells {
                        sheet_id: *sheet_id,
                        cells: previous_cells,
                    });
                }
                Command::ClearRange { sheet_id, range } => {
                    let removed = self
                        .workbook
                        .sheets
                        .get_mut(sheet_id)
                        .expect("prepared clear sheet must exist")
                        .take_range(*range);
                    self.receipt.cleared_cells += removed.len();
                    journal.undo.push(UndoEntry::ClearedCells {
                        sheet_id: *sheet_id,
                        cells: removed,
                    });
                }
            }
        }
        self.workbook.ids = plan.next_ids;
        self.workbook.revision = plan.next_revision;

        // Derived cells outside the authored command are journaled as ordinary
        // replacements so dropping this transaction restores authored and
        // calculated state together.
        let projected: Vec<_> = formula_projection
            .iter()
            .filter_map(|key| {
                self.workbook
                    .formula_engine
                    .projected_cell(*key)
                    .map(|cell| (*key, cell))
            })
            .collect();
        let mut by_sheet: BTreeMap<StableId, Vec<(CellCoord, Option<Cell>)>> = BTreeMap::new();
        for (key, cell) in projected {
            let previous = self
                .workbook
                .sheets
                .get_mut(&key.sheet_id)
                .expect("formula catalog and workbook catalog must agree")
                .replace_cell(key.coordinate, cell);
            by_sheet
                .entry(key.sheet_id)
                .or_default()
                .push((key.coordinate, previous));
        }
        for (sheet_id, cells) in by_sheet {
            journal
                .undo
                .push(UndoEntry::ReplacedCells { sheet_id, cells });
        }
    }

    /// Returns the tentatively mutated workbook for immutable post-apply
    /// validation.
    #[must_use]
    pub fn workbook(&self) -> &Workbook {
        self.workbook
    }

    #[must_use]
    pub const fn receipt(&self) -> BatchReceipt {
        self.receipt
    }

    /// Permanently accepts the transaction and discards its inverse journal.
    #[must_use]
    pub fn commit(mut self) -> BatchReceipt {
        self.journal = None;
        self.receipt
    }

    /// Explicitly restores the pre-transaction workbook. Dropping the guard
    /// provides the same behavior.
    pub fn rollback(mut self) {
        if let Some(journal) = self.journal.take() {
            journal.rollback(self.workbook);
        }
    }
}

impl fmt::Debug for BatchTransaction<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BatchTransaction")
            .field("receipt", &self.receipt)
            .field(
                "journal_entries",
                &self.journal.as_ref().map(|journal| journal.undo.len()),
            )
            .finish_non_exhaustive()
    }
}

impl Drop for BatchTransaction<'_> {
    fn drop(&mut self) {
        if let Some(journal) = self.journal.take() {
            journal.rollback(self.workbook);
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BatchReceipt {
    pub revision: u64,
    pub command_count: usize,
    pub written_cells: usize,
    pub cleared_cells: usize,
}

impl BatchReceipt {
    const fn empty(revision: u64) -> Self {
        Self {
            revision,
            command_count: 0,
            written_cells: 0,
            cleared_cells: 0,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchError {
    pub command_index: usize,
    pub kind: CommandErrorKind,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandErrorKind {
    RevisionExhausted,
    ZeroId,
    InvalidEntityId(StableId),
    UnknownSheet(StableId),
    DuplicateSheetId(StableId),
    DuplicateSheetName(String),
    InvalidSheetName(crate::WorkbookError),
    InvalidCellBlock(CellBlockError),
    Formula(FormulaEngineError),
}

impl fmt::Display for BatchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "command {} failed: {}",
            self.command_index, self.kind
        )
    }
}

impl fmt::Display for CommandErrorKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RevisionExhausted => formatter.write_str("workbook revision is exhausted"),
            Self::ZeroId => formatter.write_str("sheet id must not be zero"),
            Self::InvalidEntityId(id) => write!(formatter, "invalid sheet entity id {id}"),
            Self::UnknownSheet(id) => write!(formatter, "unknown sheet {id}"),
            Self::DuplicateSheetId(id) => write!(formatter, "duplicate sheet id {id}"),
            Self::DuplicateSheetName(name) => write!(formatter, "duplicate sheet name {name:?}"),
            Self::InvalidSheetName(error) => error.fmt(formatter),
            Self::InvalidCellBlock(error) => write!(formatter, "invalid cell block: {error:?}"),
            Self::Formula(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for BatchError {}

#[cfg(test)]
mod tests {
    use std::panic::{catch_unwind, AssertUnwindSafe};

    use crate::{
        encode_snapshot, AtomicBatch, Cell, CellBlock, CellCoord, CellRange, CellValue, Command,
        Number, StableId, Workbook,
    };

    #[test]
    fn batch_can_create_and_populate_a_sheet() {
        let mut workbook = Workbook::new(7).expect("workbook");
        let sheet_id = StableId::from_parts(7, 100);
        let batch = AtomicBatch::from_commands(vec![
            Command::CreateSheet {
                id: sheet_id,
                name: "Summary".into(),
            },
            Command::SetCells {
                sheet_id,
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(1, 2, vec![Cell::from("A"), Cell::from("B")]).expect("block"),
            },
        ]);
        let receipt = workbook.apply_batch(&batch).expect("apply");
        assert_eq!(receipt.revision, 1);
        assert_eq!(receipt.command_count, 2);
        assert_eq!(receipt.written_cells, 2);
        assert_eq!(workbook.sheet(sheet_id).expect("sheet").tile_count(), 1);
    }

    #[test]
    fn invalid_late_command_leaves_workbook_byte_identical() {
        let mut workbook = Workbook::new(9).expect("workbook");
        let before = encode_snapshot(&workbook).expect("snapshot");
        let sheet_id = StableId::from_parts(9, 10);
        let missing_id = StableId::from_parts(9, 11);
        let batch = AtomicBatch::from_commands(vec![
            Command::CreateSheet {
                id: sheet_id,
                name: "Will not exist".into(),
            },
            Command::DeleteSheet { id: missing_id },
        ]);
        let error = workbook.apply_batch(&batch).expect_err("must reject");
        assert_eq!(error.command_index, 1);
        assert_eq!(encode_snapshot(&workbook).expect("snapshot"), before);
    }

    #[test]
    fn explicit_ids_fence_only_the_local_allocator_and_validation_is_atomic() {
        let mut workbook = Workbook::new(9).expect("workbook");
        let local = StableId::from_parts(9, 50);
        workbook
            .apply_batch(&AtomicBatch::from_commands(vec![Command::CreateSheet {
                id: local,
                name: "Local".into(),
            }]))
            .expect("local create");
        assert_eq!(workbook.allocate_id().expect("after local").counter(), 51);

        let foreign = StableId::from_parts(77, 10_000);
        workbook
            .apply_batch(&AtomicBatch::from_commands(vec![Command::CreateSheet {
                id: foreign,
                name: "Foreign".into(),
            }]))
            .expect("foreign create");
        assert_eq!(workbook.allocate_id().expect("after foreign").counter(), 52);

        let before = encode_snapshot(&workbook).expect("before invalid");
        let rejected = AtomicBatch::from_commands(vec![
            Command::CreateSheet {
                id: StableId::from_parts(9, 1_000),
                name: "Never committed".into(),
            },
            Command::DeleteSheet {
                id: StableId::from_parts(88, 1),
            },
        ]);
        assert!(workbook.apply_batch(&rejected).is_err());
        assert_eq!(encode_snapshot(&workbook).expect("after invalid"), before);
        assert_eq!(
            workbook.allocate_id().expect("after rejection").counter(),
            53
        );
    }

    #[test]
    fn entity_ids_require_nonzero_namespace_and_counter() {
        let mut workbook = Workbook::new(9).expect("workbook");
        for id in [StableId::from_parts(0, 1), StableId::from_parts(9, 0)] {
            let error = workbook
                .apply_batch(&AtomicBatch::from_commands(vec![Command::CreateSheet {
                    id,
                    name: format!("Invalid {id}"),
                }]))
                .expect_err("invalid id");
            assert_eq!(error.kind, super::CommandErrorKind::InvalidEntityId(id));
        }
    }

    #[test]
    fn reversible_batch_rolls_back_every_command_kind_byte_identically() {
        let mut workbook = Workbook::new(11).expect("workbook");
        let retained_sheet = StableId::from_parts(11, 10);
        let deleted_sheet = StableId::from_parts(11, 11);
        workbook
            .apply_batch(&AtomicBatch::from_commands(vec![
                Command::CreateSheet {
                    id: retained_sheet,
                    name: "Retained".into(),
                },
                Command::CreateSheet {
                    id: deleted_sheet,
                    name: "Deleted".into(),
                },
                Command::SetCells {
                    sheet_id: retained_sheet,
                    anchor: CellCoord::new(0, 0),
                    cells: CellBlock::new(
                        1,
                        3,
                        vec![Cell::from("old"), Cell::from("removed"), Cell::from("kept")],
                    )
                    .expect("seed block"),
                },
                Command::SetCells {
                    sheet_id: deleted_sheet,
                    anchor: CellCoord::new(7, 7),
                    cells: CellBlock::new(1, 1, vec![Cell::from("moved, not cloned")])
                        .expect("deleted block"),
                },
            ]))
            .expect("seed workbook");

        let created_sheet = StableId::from_parts(11, 100);
        let before = encode_snapshot(&workbook).expect("before");
        let batch = AtomicBatch::from_commands(vec![
            Command::RenameSheet {
                id: retained_sheet,
                name: "Renamed".into(),
            },
            Command::SetCells {
                sheet_id: retained_sheet,
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(1, 2, vec![Cell::from("new"), Cell::empty()])
                    .expect("replacement block"),
            },
            Command::ClearRange {
                sheet_id: retained_sheet,
                range: CellRange::new(CellCoord::new(0, 2), CellCoord::new(0, 2)),
            },
            Command::DeleteSheet { id: deleted_sheet },
            Command::CreateSheet {
                id: created_sheet,
                name: "Created".into(),
            },
            Command::SetCells {
                sheet_id: created_sheet,
                anchor: CellCoord::new(100, 100),
                cells: CellBlock::new(1, 1, vec![Cell::from("temporary")])
                    .expect("temporary block"),
            },
        ]);

        {
            let transaction = workbook.begin_batch(&batch).expect("begin");
            assert_eq!(transaction.receipt().written_cells, 3);
            assert_eq!(transaction.receipt().cleared_cells, 1);
            assert_eq!(
                transaction
                    .journal
                    .as_ref()
                    .expect("journal")
                    .retained_cell_count(),
                4,
                "the journal tracks touched slots, never all workbook cells"
            );
            assert_eq!(
                transaction
                    .workbook()
                    .sheet(retained_sheet)
                    .expect("retained sheet")
                    .name(),
                "Renamed"
            );
            assert!(transaction.workbook().sheet(deleted_sheet).is_none());
            assert!(transaction.workbook().sheet(created_sheet).is_some());
        }

        assert_eq!(encode_snapshot(&workbook).expect("after rollback"), before);
    }

    #[test]
    fn reversible_commit_matches_the_allocation_light_fast_path() {
        let mut fast = Workbook::new(12).expect("workbook");
        let sheet_id = StableId::from_parts(12, 10);
        fast.apply_batch(&AtomicBatch::from_commands(vec![Command::CreateSheet {
            id: sheet_id,
            name: "Sheet".into(),
        }]))
        .expect("create");
        let mut reversible = fast.clone();
        let batch = AtomicBatch::from_commands(vec![Command::SetCells {
            sheet_id,
            anchor: CellCoord::new(255, 255),
            cells: CellBlock::new(
                2,
                2,
                vec![
                    Cell::from("a"),
                    Cell::from("b"),
                    Cell::from("c"),
                    Cell::from("d"),
                ],
            )
            .expect("block"),
        }]);

        let fast_receipt = fast.apply_batch(&batch).expect("fast apply");
        let reversible_receipt = reversible.begin_batch(&batch).expect("begin").commit();
        assert_eq!(reversible_receipt, fast_receipt);
        assert_eq!(reversible, fast);
    }

    #[test]
    fn reversible_guard_rolls_back_during_unwinding() {
        let mut workbook = Workbook::new(13).expect("workbook");
        let sheet_id = StableId::from_parts(13, 10);
        workbook
            .apply_batch(&AtomicBatch::from_commands(vec![Command::CreateSheet {
                id: sheet_id,
                name: "Sheet".into(),
            }]))
            .expect("create");
        let before = encode_snapshot(&workbook).expect("before");
        let batch = AtomicBatch::from_commands(vec![Command::SetCells {
            sheet_id,
            anchor: CellCoord::new(4, 5),
            cells: CellBlock::new(1, 1, vec![Cell::from("tentative")]).expect("block"),
        }]);

        let result = catch_unwind(AssertUnwindSafe(|| {
            let transaction = workbook.begin_batch(&batch).expect("begin");
            assert!(transaction
                .workbook()
                .sheet(sheet_id)
                .expect("sheet")
                .cell(CellCoord::new(4, 5))
                .is_some());
            panic!("simulated post-apply validation panic");
        }));
        assert!(result.is_err());
        assert_eq!(encode_snapshot(&workbook).expect("after panic"), before);
    }

    #[test]
    fn tiny_reversible_edit_on_large_model_journals_one_cell() {
        const CELL_COUNT: usize = 100_000;
        let mut workbook = Workbook::new(14).expect("workbook");
        let sheet_id = StableId::from_parts(14, 10);
        let cells = (0..CELL_COUNT)
            .map(|index| Cell::from(index.to_string()))
            .collect();
        workbook
            .apply_batch(&AtomicBatch::from_commands(vec![
                Command::CreateSheet {
                    id: sheet_id,
                    name: "Large".into(),
                },
                Command::SetCells {
                    sheet_id,
                    anchor: CellCoord::new(0, 0),
                    cells: CellBlock::new(1_000, 100, cells).expect("large block"),
                },
            ]))
            .expect("seed large workbook");
        let before = encode_snapshot(&workbook).expect("before");
        let edit = AtomicBatch::from_commands(vec![Command::SetCells {
            sheet_id,
            anchor: CellCoord::new(500, 50),
            cells: CellBlock::new(1, 1, vec![Cell::from("one edit")]).expect("edit"),
        }]);

        let transaction = workbook.begin_batch(&edit).expect("begin");
        assert_eq!(
            transaction
                .journal
                .as_ref()
                .expect("journal")
                .retained_cell_count(),
            1
        );
        transaction.rollback();
        assert_eq!(encode_snapshot(&workbook).expect("after rollback"), before);
    }

    #[test]
    fn reversible_formula_edit_rolls_back_authored_and_derived_state() {
        let mut workbook = Workbook::new(15).expect("workbook");
        let sheet_id = StableId::from_parts(15, 10);
        let number = |value| CellValue::Number(Number::new(value).expect("finite test number"));
        workbook
            .apply_batch(&AtomicBatch::from_commands(vec![
                Command::CreateSheet {
                    id: sheet_id,
                    name: "Formula".into(),
                },
                Command::SetCells {
                    sheet_id,
                    anchor: CellCoord::new(0, 0),
                    cells: CellBlock::new(
                        1,
                        2,
                        vec![
                            Cell::from_value(number(2.0)),
                            Cell::formula("=A1*2", number(999.0)).expect("formula"),
                        ],
                    )
                    .expect("cells"),
                },
            ]))
            .expect("seed");
        let before = encode_snapshot(&workbook).expect("before");
        let edit = |value| {
            AtomicBatch::from_commands(vec![Command::SetCells {
                sheet_id,
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(1, 1, vec![Cell::from_value(number(value))]).expect("edit"),
            }])
        };
        {
            let transaction = workbook.begin_batch(&edit(5.0)).expect("begin");
            assert_eq!(
                transaction
                    .workbook()
                    .sheet(sheet_id)
                    .and_then(|sheet| sheet.cell(CellCoord::new(0, 1)))
                    .map(Cell::value),
                Some(&number(10.0))
            );
        }
        assert_eq!(encode_snapshot(&workbook).expect("rollback"), before);
        workbook
            .apply_batch(&edit(3.0))
            .expect("post-rollback edit");
        assert_eq!(
            workbook
                .sheet(sheet_id)
                .and_then(|sheet| sheet.cell(CellCoord::new(0, 1)))
                .map(Cell::value),
            Some(&number(6.0))
        );
    }
}
