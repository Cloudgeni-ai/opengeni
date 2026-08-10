use core::fmt;
use std::collections::{BTreeMap, BTreeSet};

use crate::formula::{FormulaEngine, FormulaEngineError};
use crate::{IdError, IdGenerator, Sheet, StableId};

pub const MAX_SHEET_NAME_BYTES: usize = 1_024;

#[derive(Clone, Debug)]
pub struct Workbook {
    pub(crate) id: StableId,
    pub(crate) revision: u64,
    pub(crate) ids: IdGenerator,
    pub(crate) sheet_order: Vec<StableId>,
    pub(crate) sheets: BTreeMap<StableId, Sheet>,
    pub(crate) formula_engine: FormulaEngine,
}

impl PartialEq for Workbook {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
            && self.revision == other.revision
            && self.ids == other.ids
            && self.sheet_order == other.sheet_order
            && self.sheets == other.sheets
    }
}

impl Workbook {
    pub fn new(namespace: u64) -> Result<Self, IdError> {
        let mut ids = IdGenerator::new(namespace);
        let id = ids.next_id()?;
        Ok(Self {
            id,
            revision: 0,
            ids,
            sheet_order: Vec::new(),
            sheets: BTreeMap::new(),
            formula_engine: FormulaEngine::new(),
        })
    }

    #[must_use]
    pub const fn id(&self) -> StableId {
        self.id
    }

    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }

    pub fn allocate_id(&mut self) -> Result<StableId, IdError> {
        self.ids.next_id()
    }

    #[must_use]
    pub fn sheet(&self, id: StableId) -> Option<&Sheet> {
        self.sheets.get(&id)
    }

    #[must_use]
    pub fn sheet_by_name(&self, name: &str) -> Option<&Sheet> {
        self.sheets.values().find(|sheet| sheet.name == name)
    }

    pub fn sheets(&self) -> impl Iterator<Item = &Sheet> {
        self.sheet_order.iter().filter_map(|id| self.sheets.get(id))
    }

    #[must_use]
    pub fn sheet_count(&self) -> usize {
        self.sheets.len()
    }

    pub(crate) fn validate_sheet_name(name: &str) -> Result<(), WorkbookError> {
        if name.is_empty() {
            return Err(WorkbookError::EmptySheetName);
        }
        if name.len() > MAX_SHEET_NAME_BYTES {
            return Err(WorkbookError::SheetNameTooLong);
        }
        if name.as_bytes().contains(&0) {
            return Err(WorkbookError::SheetNameContainsNull);
        }
        Ok(())
    }

    pub(crate) fn from_snapshot_parts(
        id: StableId,
        revision: u64,
        ids: IdGenerator,
        sheet_order: Vec<StableId>,
        sheets: BTreeMap<StableId, Sheet>,
    ) -> Result<Self, WorkbookError> {
        if id.is_zero() {
            return Err(WorkbookError::ZeroId);
        }
        if id.namespace() == 0
            || ids.namespace() == 0
            || id.namespace() != ids.namespace()
            || id.counter() == 0
        {
            return Err(WorkbookError::InvalidIdAllocator);
        }
        if sheet_order.len() != sheets.len() {
            return Err(WorkbookError::InvalidSheetOrder);
        }
        let mut ordered_ids = BTreeSet::new();
        let mut names = BTreeSet::new();
        let mut maximum_local_counter = id.counter();
        for sheet_id in &sheet_order {
            if !ordered_ids.insert(*sheet_id) || !sheets.contains_key(sheet_id) {
                return Err(WorkbookError::InvalidSheetOrder);
            }
            if sheet_id.namespace() == 0 || sheet_id.counter() == 0 {
                return Err(WorkbookError::InvalidEntityId);
            }
            if sheet_id.namespace() == ids.namespace() {
                maximum_local_counter = maximum_local_counter.max(sheet_id.counter());
            }
            let sheet = &sheets[sheet_id];
            Self::validate_sheet_name(&sheet.name)?;
            if !names.insert(normalize_sheet_name(sheet.name())) {
                return Err(WorkbookError::DuplicateSheetName);
            }
        }
        if (ids.is_exhausted() && maximum_local_counter != u64::MAX)
            || (!ids.is_exhausted() && maximum_local_counter >= ids.next_counter())
        {
            return Err(WorkbookError::InvalidIdAllocator);
        }
        let mut workbook = Self {
            id,
            revision,
            ids,
            sheet_order,
            sheets,
            formula_engine: FormulaEngine::new(),
        };
        workbook
            .rebuild_formula_engine()
            .map_err(WorkbookError::Formula)?;
        Ok(workbook)
    }

    /// Rebuilds all derived formula state from authored workbook cells and
    /// projects the deterministic results back without changing the authored
    /// revision. Formula source is authoritative; incoming cached values are
    /// never trusted.
    pub(crate) fn rebuild_formula_engine(&mut self) -> Result<(), FormulaEngineError> {
        let engine = FormulaEngine::from_workbook(self)?;
        let keys = engine.formula_keys();
        for key in keys {
            let cell = engine
                .projected_cell(key)
                .expect("live formula key must project a formula cell");
            self.sheets
                .get_mut(&key.sheet_id)
                .ok_or(FormulaEngineError::UnknownSheet(key.sheet_id))?
                .set_cell(key.coordinate, cell);
        }
        self.formula_engine = engine;
        Ok(())
    }
}

fn normalize_sheet_name(name: &str) -> String {
    name.chars().flat_map(char::to_lowercase).collect()
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkbookError {
    ZeroId,
    EmptySheetName,
    SheetNameTooLong,
    SheetNameContainsNull,
    DuplicateSheetName,
    InvalidSheetOrder,
    InvalidEntityId,
    InvalidIdAllocator,
    Formula(FormulaEngineError),
}

impl fmt::Display for WorkbookError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZeroId => formatter.write_str("entity id must not be zero"),
            Self::EmptySheetName => formatter.write_str("sheet name must not be empty"),
            Self::SheetNameTooLong => formatter.write_str("sheet name exceeds kernel bound"),
            Self::SheetNameContainsNull => formatter.write_str("sheet name contains a null byte"),
            Self::DuplicateSheetName => formatter.write_str("sheet name already exists"),
            Self::InvalidSheetOrder => {
                formatter.write_str("sheet order does not match sheet catalog")
            }
            Self::InvalidEntityId => {
                formatter.write_str("entity id has a zero namespace or counter")
            }
            Self::InvalidIdAllocator => {
                formatter.write_str("id allocator can collide with persisted entity ids")
            }
            Self::Formula(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for WorkbookError {}
