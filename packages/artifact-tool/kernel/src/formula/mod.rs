//! Deterministic, incremental spreadsheet formula calculation.
//!
//! Formula text is parsed once into an interned arena. Stable cell keys compile
//! to compact node identifiers, while forward and reverse dependency edges make
//! recalculation proportional to the affected graph rather than workbook size.

mod arena;
mod eval;
mod parser;

use core::fmt;
use core::hash::{Hash, Hasher};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

use crate::{Cell, CellCoord, CellRange, CellValue, FormulaError, Number, StableId, Workbook};

use arena::{
    BinaryOperator, CompiledRange, ConstantError, ConstantValue, ExprArena, ExprId, ExprNode,
    RangeArena, StringId, StringInterner, UnaryOperator,
};
use parser::{
    parse_formula, rewrite_deleted_sheet_references, rewrite_sheet_references,
    ParsedBinaryOperator, ParsedError, ParsedExpr, ParsedReference, ParsedUnaryOperator,
    ParsedValue,
};

pub const DEFAULT_MAX_FORMULA_BYTES: usize = 8_192;
pub const DEFAULT_MAX_FORMULA_TOKENS: usize = 4_096;
pub const DEFAULT_MAX_FORMULA_NESTING_DEPTH: usize = 64;
pub const DEFAULT_MAX_FORMULA_ARGUMENTS: usize = 255;
pub const DEFAULT_MAX_FORMULA_RANGE_CELLS: usize = 100_000;
pub const DEFAULT_MAX_FORMULA_CELL_READS: usize = 100_000;
pub const DEFAULT_MAX_FORMULA_OPERATIONS: usize = 100_000;
pub const DEFAULT_MAX_FORMULA_DEPENDENCY_DEPTH: usize = 256;
pub const DEFAULT_MAX_FORMULA_RESULT_UTF16_UNITS: usize = 32_767;
pub const DEFAULT_MAX_RECALCULATION_CELL_READS: usize = 5_000_000;
pub const DEFAULT_MAX_RECALCULATION_OPERATIONS: usize = 10_000_000;
pub const DEFAULT_MAX_FORMULA_ENGINE_CELLS: usize = 4_000_000;
pub const DEFAULT_MAX_FORMULAS: usize = 1_000_000;
pub const DEFAULT_MAX_FORMULA_GRAPH_EDGES: usize = 16_000_000;
pub const DEFAULT_MAX_INTERNED_AST_NODES: usize = 8_000_000;
pub const DEFAULT_MAX_COMPILED_RANGES: usize = 1_000_000;
pub const DEFAULT_MAX_CELL_TEXT_BYTES: usize = 1_048_576;
pub const DEFAULT_MAX_ENGINE_VALUE_BYTES: usize = 256 * 1024 * 1024;
pub const DEFAULT_MAX_INTERNED_STRING_BYTES: usize = 256 * 1024 * 1024;

/// Hard resource ceilings. A caller may tighten, never relax, these values.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FormulaLimits {
    pub max_formula_bytes: usize,
    pub max_tokens: usize,
    pub max_nesting_depth: usize,
    pub max_function_arguments: usize,
    pub max_range_cells: usize,
    pub max_cell_reads: usize,
    pub max_operations: usize,
    pub max_dependency_depth: usize,
    pub max_result_utf16_units: usize,
    pub max_recalculation_cell_reads: usize,
    pub max_recalculation_operations: usize,
    pub max_engine_cells: usize,
    pub max_formulas: usize,
    pub max_graph_edges: usize,
    pub max_interned_ast_nodes: usize,
    pub max_compiled_ranges: usize,
    pub max_cell_text_bytes: usize,
    pub max_engine_value_bytes: usize,
    pub max_interned_string_bytes: usize,
}

impl Default for FormulaLimits {
    fn default() -> Self {
        Self {
            max_formula_bytes: DEFAULT_MAX_FORMULA_BYTES,
            max_tokens: DEFAULT_MAX_FORMULA_TOKENS,
            max_nesting_depth: DEFAULT_MAX_FORMULA_NESTING_DEPTH,
            max_function_arguments: DEFAULT_MAX_FORMULA_ARGUMENTS,
            max_range_cells: DEFAULT_MAX_FORMULA_RANGE_CELLS,
            max_cell_reads: DEFAULT_MAX_FORMULA_CELL_READS,
            max_operations: DEFAULT_MAX_FORMULA_OPERATIONS,
            max_dependency_depth: DEFAULT_MAX_FORMULA_DEPENDENCY_DEPTH,
            max_result_utf16_units: DEFAULT_MAX_FORMULA_RESULT_UTF16_UNITS,
            max_recalculation_cell_reads: DEFAULT_MAX_RECALCULATION_CELL_READS,
            max_recalculation_operations: DEFAULT_MAX_RECALCULATION_OPERATIONS,
            max_engine_cells: DEFAULT_MAX_FORMULA_ENGINE_CELLS,
            max_formulas: DEFAULT_MAX_FORMULAS,
            max_graph_edges: DEFAULT_MAX_FORMULA_GRAPH_EDGES,
            max_interned_ast_nodes: DEFAULT_MAX_INTERNED_AST_NODES,
            max_compiled_ranges: DEFAULT_MAX_COMPILED_RANGES,
            max_cell_text_bytes: DEFAULT_MAX_CELL_TEXT_BYTES,
            max_engine_value_bytes: DEFAULT_MAX_ENGINE_VALUE_BYTES,
            max_interned_string_bytes: DEFAULT_MAX_INTERNED_STRING_BYTES,
        }
    }
}

impl FormulaLimits {
    pub fn validate(&self) -> Result<(), FormulaEngineError> {
        let hard = Self::default();
        for (resource, value, maximum) in [
            (
                "formula bytes",
                self.max_formula_bytes,
                hard.max_formula_bytes,
            ),
            ("formula tokens", self.max_tokens, hard.max_tokens),
            (
                "formula nesting depth",
                self.max_nesting_depth,
                hard.max_nesting_depth,
            ),
            (
                "formula function arguments",
                self.max_function_arguments,
                hard.max_function_arguments,
            ),
            (
                "formula range cells",
                self.max_range_cells,
                hard.max_range_cells,
            ),
            (
                "formula cell reads",
                self.max_cell_reads,
                hard.max_cell_reads,
            ),
            (
                "formula operations",
                self.max_operations,
                hard.max_operations,
            ),
            (
                "formula dependency depth",
                self.max_dependency_depth,
                hard.max_dependency_depth,
            ),
            (
                "formula result UTF-16 units",
                self.max_result_utf16_units,
                hard.max_result_utf16_units,
            ),
            (
                "recalculation cell reads",
                self.max_recalculation_cell_reads,
                hard.max_recalculation_cell_reads,
            ),
            (
                "recalculation operations",
                self.max_recalculation_operations,
                hard.max_recalculation_operations,
            ),
            (
                "formula engine cells",
                self.max_engine_cells,
                hard.max_engine_cells,
            ),
            ("formula cells", self.max_formulas, hard.max_formulas),
            (
                "formula graph edges",
                self.max_graph_edges,
                hard.max_graph_edges,
            ),
            (
                "formula AST nodes",
                self.max_interned_ast_nodes,
                hard.max_interned_ast_nodes,
            ),
            (
                "compiled formula ranges",
                self.max_compiled_ranges,
                hard.max_compiled_ranges,
            ),
            (
                "cell text bytes",
                self.max_cell_text_bytes,
                hard.max_cell_text_bytes,
            ),
            (
                "formula engine value bytes",
                self.max_engine_value_bytes,
                hard.max_engine_value_bytes,
            ),
            (
                "formula interned UTF-8 bytes",
                self.max_interned_string_bytes,
                hard.max_interned_string_bytes,
            ),
        ] {
            if value == 0 || value > maximum {
                return Err(FormulaEngineError::InvalidLimit {
                    resource,
                    value,
                    maximum,
                });
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct FormulaCellKey {
    pub sheet_id: StableId,
    pub coordinate: CellCoord,
}

impl Hash for FormulaCellKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.sheet_id.hash(state);
        self.coordinate.row.hash(state);
        self.coordinate.column.hash(state);
    }
}

impl FormulaCellKey {
    #[must_use]
    pub const fn new(sheet_id: StableId, coordinate: CellCoord) -> Self {
        Self {
            sheet_id,
            coordinate,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
struct NodeId(u32);

impl NodeId {
    fn index(self) -> usize {
        self.0 as usize
    }
}

/// Most spreadsheet formulas have zero or one precedent. Keeping that edge
/// inline avoids one heap allocation per ordinary copied formula while still
/// allowing high-fan-in ranges and high-fan-out inputs to use contiguous
/// storage.
#[derive(Clone, Debug, Default)]
enum NodeIdList {
    #[default]
    Empty,
    One(NodeId),
    Many(Vec<NodeId>),
}

impl NodeIdList {
    fn from_sorted(values: Vec<NodeId>) -> Self {
        match values.len() {
            0 => Self::Empty,
            1 => Self::One(values[0]),
            _ => Self::Many(values),
        }
    }

    fn as_slice(&self) -> &[NodeId] {
        match self {
            Self::Empty => &[],
            Self::One(value) => core::slice::from_ref(value),
            Self::Many(values) => values,
        }
    }

    fn len(&self) -> usize {
        self.as_slice().len()
    }

    fn iter(&self) -> core::slice::Iter<'_, NodeId> {
        self.as_slice().iter()
    }

    fn get(&self, index: usize) -> Option<NodeId> {
        self.as_slice().get(index).copied()
    }

    fn heap_capacity(&self) -> usize {
        match self {
            Self::Many(values) => values.capacity(),
            Self::Empty | Self::One(_) => 0,
        }
    }

    fn insert_sorted_unique(&mut self, value: NodeId) {
        match self {
            Self::Empty => *self = Self::One(value),
            Self::One(existing) if *existing == value => {}
            Self::One(existing) => {
                let (first, second) = if *existing < value {
                    (*existing, value)
                } else {
                    (value, *existing)
                };
                *self = Self::Many(vec![first, second]);
            }
            Self::Many(values) => {
                if let Err(index) = values.binary_search(&value) {
                    values.insert(index, value);
                }
            }
        }
    }

    fn remove_sorted(&mut self, value: NodeId) {
        match self {
            Self::Empty => {}
            Self::One(existing) if *existing == value => *self = Self::Empty,
            Self::One(_) => {}
            Self::Many(values) => {
                if let Ok(index) = values.binary_search(&value) {
                    values.remove(index);
                }
                if values.len() == 1 {
                    *self = Self::One(values[0]);
                } else if values.is_empty() {
                    *self = Self::Empty;
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum FormulaFunction {
    Sum,
    Average,
    Min,
    Max,
    Count,
    CountA,
    If,
    IfError,
    And,
    Or,
    Not,
    Abs,
    Round,
    RoundUp,
    RoundDown,
    Power,
    Sqrt,
    Len,
    Lower,
    Upper,
    Trim,
    Left,
    Right,
    Mid,
    Concat,
    Date,
    Year,
    Month,
    Day,
    Index,
    Match,
    XLookup,
    Unknown(StringId),
}

#[derive(Clone, Debug)]
struct CompiledFormula {
    source: StringId,
    root: ExprId,
}

#[derive(Clone, Debug)]
struct CellNode {
    key: FormulaCellKey,
    value: CellValue,
    input_hydrated: bool,
    pending_value: Option<CellValue>,
    formula: Option<CompiledFormula>,
    dependencies: NodeIdList,
    dependents: NodeIdList,
    dirty: bool,
    calculation_indegree: u32,
}

impl CellNode {
    fn new(key: FormulaCellKey) -> Self {
        Self {
            key,
            value: CellValue::Empty,
            input_hydrated: false,
            pending_value: None,
            formula: None,
            dependencies: NodeIdList::Empty,
            dependents: NodeIdList::Empty,
            dirty: false,
            calculation_indegree: 0,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FormulaUpdateReceipt {
    pub created_cell: bool,
    pub content_changed: bool,
    pub dirty_formula_cells: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecalculationReceipt {
    pub evaluated_cells: usize,
    pub changed_cells: Vec<FormulaCellKey>,
    /// Width of every deterministic topological level.
    pub partition_widths: Vec<usize>,
    pub cyclic_or_blocked_cells: usize,
    pub cell_reads: usize,
    pub operations: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FormulaEngineStats {
    pub tracked_cells: usize,
    pub formula_cells: usize,
    pub graph_edges: usize,
    pub dirty_formula_cells: usize,
    pub interned_ast_nodes: usize,
    pub compiled_ranges: usize,
    pub interned_strings: usize,
}

/// Exact structural counts and owned-container capacities. These facts are
/// platform-neutral and deliberately avoid pretending allocator overhead or
/// process RSS can be inferred from Rust container lengths.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FormulaEngineAllocationFacts {
    pub node_slots: usize,
    pub node_capacity: usize,
    pub node_index_capacity: usize,
    pub sheet_node_index_slots: usize,
    pub dependency_edge_slots: usize,
    pub dependency_heap_capacity: usize,
    pub dependent_edge_slots: usize,
    pub dependent_heap_capacity: usize,
    pub dirty_queue_slots: usize,
    pub dirty_queue_capacity: usize,
    pub hydration_queue_slots: usize,
    pub hydration_queue_capacity: usize,
    pub ast_slots: usize,
    pub ast_capacity: usize,
    pub ast_index_capacity: usize,
    pub call_argument_slots: usize,
    pub sequence_operand_slots: usize,
    pub range_slots: usize,
    pub range_capacity: usize,
    pub range_index_capacity: usize,
    pub range_cell_slots: usize,
    pub string_slots: usize,
    pub string_capacity: usize,
    pub string_index_capacity: usize,
    pub interned_utf8_bytes: usize,
    pub cached_value_utf8_bytes: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FormulaTraceNode {
    pub key: FormulaCellKey,
    pub depth: usize,
    pub formula: Option<String>,
    pub value: CellValue,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FormulaTrace {
    pub root: FormulaCellKey,
    pub nodes: Vec<FormulaTraceNode>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FormulaEngineError {
    Limit {
        resource: &'static str,
        actual: usize,
        maximum: usize,
    },
    InvalidLimit {
        resource: &'static str,
        value: usize,
        maximum: usize,
    },
    InvalidSheetId,
    InvalidSheetName,
    DuplicateSheetId,
    DuplicateSheetName,
    UnknownSheet(StableId),
    FormulaSyntax {
        error: &'static str,
    },
}

impl fmt::Display for FormulaEngineError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Limit {
                resource,
                actual,
                maximum,
            } => write!(formatter, "{resource} exceeded: {actual} > {maximum}"),
            Self::InvalidLimit {
                resource,
                value,
                maximum,
            } => write!(
                formatter,
                "invalid {resource} limit: {value}; expected 1..={maximum}"
            ),
            Self::InvalidSheetId => formatter.write_str("formula sheet id must be nonzero"),
            Self::InvalidSheetName => formatter.write_str("invalid formula sheet name"),
            Self::DuplicateSheetId => formatter.write_str("formula sheet id already registered"),
            Self::DuplicateSheetName => {
                formatter.write_str("formula sheet name already registered")
            }
            Self::UnknownSheet(id) => write!(formatter, "unknown formula sheet {id}"),
            Self::FormulaSyntax { error } => write!(formatter, "formula syntax fault: {error}"),
        }
    }
}

impl std::error::Error for FormulaEngineError {}

/// Incremental formula state. It intentionally owns no I/O, clock, network, or
/// process hooks and is safe to run identically in native and WASM adapters.
#[derive(Clone, Debug)]
pub struct FormulaEngine {
    limits: FormulaLimits,
    sheets: BTreeMap<StableId, String>,
    sheet_ids_by_name: BTreeMap<String, StableId>,
    retired_sheets: BTreeSet<StableId>,
    nodes: Vec<CellNode>,
    node_ids: HashMap<FormulaCellKey, NodeId>,
    node_ids_by_sheet: BTreeMap<StableId, BTreeMap<CellCoord, NodeId>>,
    dirty_nodes: Vec<NodeId>,
    unhydrated_nodes: Vec<NodeId>,
    dirty_formula_count: usize,
    formula_count: usize,
    graph_edges: usize,
    cached_value_bytes: usize,
    strings: StringInterner,
    expressions: ExprArena,
    ranges: RangeArena,
}

impl FormulaEngine {
    pub fn new() -> Self {
        Self::with_limits(FormulaLimits::default()).expect("default formula limits are valid")
    }

    pub fn with_limits(limits: FormulaLimits) -> Result<Self, FormulaEngineError> {
        limits.validate()?;
        Ok(Self {
            limits,
            sheets: BTreeMap::new(),
            sheet_ids_by_name: BTreeMap::new(),
            retired_sheets: BTreeSet::new(),
            nodes: Vec::new(),
            node_ids: HashMap::new(),
            node_ids_by_sheet: BTreeMap::new(),
            dirty_nodes: Vec::new(),
            unhydrated_nodes: Vec::new(),
            dirty_formula_count: 0,
            formula_count: 0,
            graph_edges: 0,
            cached_value_bytes: 0,
            strings: StringInterner::default(),
            expressions: ExprArena::default(),
            ranges: RangeArena::default(),
        })
    }

    pub fn register_sheet(
        &mut self,
        sheet_id: StableId,
        name: impl Into<String>,
    ) -> Result<(), FormulaEngineError> {
        if sheet_id.is_zero() || sheet_id.namespace() == 0 || sheet_id.counter() == 0 {
            return Err(FormulaEngineError::InvalidSheetId);
        }
        let name = name.into();
        if name.is_empty() || name.len() > 1_024 || name.as_bytes().contains(&0) {
            return Err(FormulaEngineError::InvalidSheetName);
        }
        if self.sheets.contains_key(&sheet_id) || self.retired_sheets.contains(&sheet_id) {
            return Err(FormulaEngineError::DuplicateSheetId);
        }
        let normalized = normalize_sheet_name(&name);
        if self.sheet_ids_by_name.contains_key(&normalized) {
            return Err(FormulaEngineError::DuplicateSheetName);
        }
        self.sheets.insert(sheet_id, name);
        self.sheet_ids_by_name.insert(normalized, sheet_id);
        Ok(())
    }

    /// Removes a sheet without reusing its stable identity. Existing formulas
    /// retain their dependency nodes, which become deterministic `#REF!`
    /// tombstones and dirty only the reachable reverse-dependency closure.
    pub fn delete_sheet(&mut self, sheet_id: StableId) -> Result<(), FormulaEngineError> {
        self.delete_sheet_with_rewrites(sheet_id).map(drop)
    }

    pub(crate) fn delete_sheet_with_rewrites(
        &mut self,
        sheet_id: StableId,
    ) -> Result<Vec<FormulaCellKey>, FormulaEngineError> {
        let name = self
            .sheets
            .get(&sheet_id)
            .cloned()
            .ok_or(FormulaEngineError::UnknownSheet(sheet_id))?;
        let string_checkpoint = self.strings.checkpoint();
        let mut rewritten = Vec::new();
        for (index, node) in self.nodes.iter().enumerate() {
            if node.key.sheet_id == sheet_id {
                continue;
            }
            let Some(formula) = &node.formula else {
                continue;
            };
            let source = self.strings.resolve(formula.source);
            let Some(source) = rewrite_deleted_sheet_references(source, &name) else {
                continue;
            };
            match self
                .strings
                .intern(&source, self.limits.max_interned_string_bytes)
            {
                Ok(source_id) => rewritten.push((index, source_id)),
                Err(error) => {
                    self.strings.rollback(string_checkpoint);
                    return Err(error);
                }
            }
        }

        self.sheets.remove(&sheet_id);
        self.node_ids_by_sheet.remove(&sheet_id);
        self.sheet_ids_by_name.remove(&normalize_sheet_name(&name));
        self.retired_sheets.insert(sheet_id);

        let deleted_nodes: Vec<NodeId> = self
            .nodes
            .iter()
            .enumerate()
            .filter_map(|(index, node)| {
                (node.key.sheet_id == sheet_id).then_some(NodeId(index as u32))
            })
            .collect();
        for node_id in &deleted_nodes {
            if self.nodes[node_id.index()].formula.take().is_some() {
                self.formula_count = self.formula_count.saturating_sub(1);
                self.detach_dependencies(*node_id);
            }
            if self.nodes[node_id.index()].dirty {
                self.dirty_formula_count = self.dirty_formula_count.saturating_sub(1);
            }
            let node = &mut self.nodes[node_id.index()];
            self.cached_value_bytes = self
                .cached_value_bytes
                .saturating_sub(value_utf8_bytes(&node.value));
            node.value = CellValue::Error(FormulaError::Reference);
            node.pending_value = None;
            node.dirty = false;
        }
        for node_id in deleted_nodes {
            self.mark_dependents_dirty(node_id);
        }
        let mut rewritten_keys = Vec::with_capacity(rewritten.len());
        for (index, source) in rewritten {
            self.nodes[index]
                .formula
                .as_mut()
                .expect("rewritten formula")
                .source = source;
            rewritten_keys.push(self.nodes[index].key);
        }
        rewritten_keys.sort_unstable();
        Ok(rewritten_keys)
    }

    pub fn rename_sheet(
        &mut self,
        sheet_id: StableId,
        name: impl Into<String>,
    ) -> Result<(), FormulaEngineError> {
        self.rename_sheet_with_rewrites(sheet_id, name).map(drop)
    }

    pub(crate) fn rename_sheet_with_rewrites(
        &mut self,
        sheet_id: StableId,
        name: impl Into<String>,
    ) -> Result<Vec<FormulaCellKey>, FormulaEngineError> {
        let name = name.into();
        if name.is_empty() || name.len() > 1_024 || name.as_bytes().contains(&0) {
            return Err(FormulaEngineError::InvalidSheetName);
        }
        let previous = self
            .sheets
            .get(&sheet_id)
            .ok_or(FormulaEngineError::UnknownSheet(sheet_id))?
            .clone();
        let previous_normalized = normalize_sheet_name(&previous);
        let normalized = normalize_sheet_name(&name);
        if self
            .sheet_ids_by_name
            .get(&normalized)
            .is_some_and(|candidate| *candidate != sheet_id)
        {
            return Err(FormulaEngineError::DuplicateSheetName);
        }
        if previous == name {
            return Ok(Vec::new());
        }

        let mut rewritten_sources = Vec::new();
        for (index, node) in self.nodes.iter().enumerate() {
            let Some(formula) = &node.formula else {
                continue;
            };
            let source = self.strings.resolve(formula.source);
            let Some(rewritten) = rewrite_sheet_references(source, &previous, &name) else {
                continue;
            };
            if rewritten.len() > self.limits.max_formula_bytes {
                return Err(FormulaEngineError::Limit {
                    resource: "formula bytes",
                    actual: rewritten.len(),
                    maximum: self.limits.max_formula_bytes,
                });
            }
            rewritten_sources.push((index, rewritten));
        }
        let string_checkpoint = self.strings.checkpoint();
        let mut source_ids = Vec::with_capacity(rewritten_sources.len());
        for (index, source) in rewritten_sources {
            match self
                .strings
                .intern(&source, self.limits.max_interned_string_bytes)
            {
                Ok(source_id) => source_ids.push((index, source_id)),
                Err(error) => {
                    self.strings.rollback(string_checkpoint);
                    return Err(error);
                }
            }
        }

        self.sheet_ids_by_name.remove(&previous_normalized);
        self.sheet_ids_by_name.insert(normalized, sheet_id);
        self.sheets.insert(sheet_id, name);
        let mut rewritten_keys = Vec::with_capacity(source_ids.len());
        for (index, source) in source_ids {
            self.nodes[index]
                .formula
                .as_mut()
                .expect("rewritten formula")
                .source = source;
            rewritten_keys.push(self.nodes[index].key);
        }
        rewritten_keys.sort_unstable();
        Ok(rewritten_keys)
    }

    pub fn set_value(
        &mut self,
        key: FormulaCellKey,
        value: CellValue,
    ) -> Result<FormulaUpdateReceipt, FormulaEngineError> {
        self.compact_if_needed()?;
        self.validate_key(key)?;
        validate_input_value(&value, self.limits.max_cell_text_bytes)?;
        let created = !self.node_ids.contains_key(&key);
        let previous_value_bytes = self
            .node_ids
            .get(&key)
            .map_or(0, |id| value_utf8_bytes(&self.nodes[id.index()].value));
        let next_value_bytes = self
            .cached_value_bytes
            .saturating_sub(previous_value_bytes)
            .saturating_add(value_utf8_bytes(&value));
        if next_value_bytes > self.limits.max_engine_value_bytes {
            return Err(FormulaEngineError::Limit {
                resource: "formula engine value bytes",
                actual: next_value_bytes,
                maximum: self.limits.max_engine_value_bytes,
            });
        }
        if created && self.nodes.len() >= self.limits.max_engine_cells {
            return Err(FormulaEngineError::Limit {
                resource: "formula engine cells",
                actual: self.nodes.len().saturating_add(1),
                maximum: self.limits.max_engine_cells,
            });
        }
        let node_id = self.ensure_node(key)?;
        let index = node_id.index();
        let content_changed =
            self.nodes[index].formula.is_some() || self.nodes[index].value != value;
        if !content_changed {
            self.nodes[index].input_hydrated = true;
            return Ok(FormulaUpdateReceipt {
                created_cell: created,
                content_changed: false,
                dirty_formula_cells: self.dirty_formula_count(),
            });
        }

        if self.nodes[index].formula.take().is_some() {
            self.formula_count -= 1;
            self.detach_dependencies(node_id);
        }
        if self.nodes[index].dirty {
            self.dirty_formula_count = self.dirty_formula_count.saturating_sub(1);
        }
        self.nodes[index].dirty = false;
        self.nodes[index].pending_value = None;
        self.nodes[index].value = value;
        self.nodes[index].input_hydrated = true;
        self.cached_value_bytes = next_value_bytes;
        self.mark_dependents_dirty(node_id);
        Ok(FormulaUpdateReceipt {
            created_cell: created,
            content_changed: true,
            dirty_formula_cells: self.dirty_formula_count(),
        })
    }

    /// Updates an authored value only when the cell already participates in
    /// the formula graph. Ordinary workbook cells deliberately stay outside
    /// this engine until a formula references them.
    pub(crate) fn set_value_if_tracked(
        &mut self,
        key: FormulaCellKey,
        value: CellValue,
    ) -> Result<Option<FormulaUpdateReceipt>, FormulaEngineError> {
        if !self.node_ids.contains_key(&key) {
            return Ok(None);
        }
        self.set_value(key, value).map(Some)
    }

    pub fn clear_cell(
        &mut self,
        key: FormulaCellKey,
    ) -> Result<FormulaUpdateReceipt, FormulaEngineError> {
        self.set_value(key, CellValue::Empty)
    }

    /// Clears every tracked value/formula inside one rectangular region.
    /// The deterministic scan is over live engine nodes, never over the full
    /// spreadsheet coordinate space.
    pub(crate) fn clear_range(
        &mut self,
        sheet_id: StableId,
        range: CellRange,
    ) -> Result<(), FormulaEngineError> {
        if !self.sheets.contains_key(&sheet_id) {
            return Err(FormulaEngineError::UnknownSheet(sheet_id));
        }
        let keys: Vec<_> = self
            .node_ids_by_sheet
            .get(&sheet_id)
            .into_iter()
            .flat_map(|nodes| nodes.keys().copied())
            .filter(|coordinate| range.contains(*coordinate))
            .map(|coordinate| FormulaCellKey::new(sheet_id, coordinate))
            .collect();
        for key in keys {
            self.clear_cell(key)?;
        }
        Ok(())
    }

    pub(crate) fn has_tracked_cell_in_range(&self, sheet_id: StableId, range: CellRange) -> bool {
        self.node_ids_by_sheet
            .get(&sheet_id)
            .is_some_and(|nodes| nodes.keys().any(|coordinate| range.contains(*coordinate)))
    }

    pub fn set_formula(
        &mut self,
        key: FormulaCellKey,
        source: &str,
    ) -> Result<FormulaUpdateReceipt, FormulaEngineError> {
        self.compact_if_needed()?;
        self.validate_key(key)?;
        if source.is_empty() {
            return Err(FormulaEngineError::FormulaSyntax { error: "#VALUE!" });
        }
        if let Some(node_id) = self.node_ids.get(&key).copied() {
            if let Some(formula) = &self.nodes[node_id.index()].formula {
                if self.strings.resolve(formula.source) == source {
                    return Ok(FormulaUpdateReceipt {
                        created_cell: false,
                        content_changed: false,
                        dirty_formula_cells: self.dirty_formula_count(),
                    });
                }
            }
        }

        let parsed = parse_formula(source, &self.limits)?;
        let mut referenced_keys = BTreeSet::new();
        let mut referenced_cell_reads = 0usize;
        self.collect_reference_keys(
            &parsed,
            key.sheet_id,
            &mut referenced_keys,
            &mut referenced_cell_reads,
        )?;
        self.validate_prospective_dependency_depth(key, &referenced_keys)?;
        let prospective_edges = referenced_keys.len();
        let mut required_keys = referenced_keys.clone();
        required_keys.insert(key);
        let newly_referenced_inputs: Vec<_> = referenced_keys
            .iter()
            .filter(|candidate| **candidate != key && !self.node_ids.contains_key(candidate))
            .copied()
            .collect();
        let missing = required_keys
            .iter()
            .filter(|candidate| !self.node_ids.contains_key(candidate))
            .count();
        let next_cells = self.nodes.len().saturating_add(missing);
        if next_cells > self.limits.max_engine_cells {
            return Err(FormulaEngineError::Limit {
                resource: "formula engine cells",
                actual: next_cells,
                maximum: self.limits.max_engine_cells,
            });
        }

        let old_id = self.node_ids.get(&key).copied();
        let old_edges = old_id
            .map(|id| self.nodes[id.index()].dependencies.len())
            .unwrap_or(0);
        let next_edges = self
            .graph_edges
            .saturating_sub(old_edges)
            .saturating_add(prospective_edges);
        if next_edges > self.limits.max_graph_edges {
            return Err(FormulaEngineError::Limit {
                resource: "formula graph edges",
                actual: next_edges,
                maximum: self.limits.max_graph_edges,
            });
        }
        let creating_formula = old_id.is_none_or(|id| self.nodes[id.index()].formula.is_none());
        if creating_formula && self.formula_count >= self.limits.max_formulas {
            return Err(FormulaEngineError::Limit {
                resource: "formula cells",
                actual: self.formula_count.saturating_add(1),
                maximum: self.limits.max_formulas,
            });
        }

        let node_checkpoint = self.nodes.len();
        let string_checkpoint = self.strings.checkpoint();
        let expression_checkpoint = self.expressions.checkpoint();
        let range_checkpoint = self.ranges.checkpoint();
        let prepared = (|| {
            for reference in &required_keys {
                self.ensure_node(*reference)?;
            }
            let node_id = self.node_ids[&key];
            let mut dependencies = Vec::with_capacity(prospective_edges);
            let root = self.compile_expression(&parsed, key.sheet_id, &mut dependencies)?;
            dependencies.sort_unstable();
            dependencies.dedup();
            let source = self
                .strings
                .intern(source, self.limits.max_interned_string_bytes)?;
            Ok::<_, FormulaEngineError>((node_id, dependencies, root, source))
        })();
        let (node_id, dependencies, root, source) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                self.rollback_nodes(node_checkpoint);
                self.strings.rollback(string_checkpoint);
                self.expressions.rollback(expression_checkpoint);
                self.ranges.rollback(range_checkpoint);
                return Err(error);
            }
        };

        if self.nodes[node_id.index()].formula.is_some() {
            self.detach_dependencies(node_id);
        } else {
            self.formula_count += 1;
        }
        self.graph_edges = self.graph_edges.saturating_add(dependencies.len());
        for dependency in &dependencies {
            self.nodes[dependency.index()]
                .dependents
                .insert_sorted_unique(node_id);
        }
        let node = &mut self.nodes[node_id.index()];
        node.dependencies = NodeIdList::from_sorted(dependencies);
        node.formula = Some(CompiledFormula { source, root });
        node.input_hydrated = true;
        for referenced in newly_referenced_inputs {
            self.unhydrated_nodes.push(self.node_ids[&referenced]);
        }
        self.mark_formula_dirty(node_id);

        Ok(FormulaUpdateReceipt {
            created_cell: old_id.is_none(),
            content_changed: true,
            dirty_formula_cells: self.dirty_formula_count(),
        })
    }

    #[must_use]
    pub fn value(&self, key: FormulaCellKey) -> Option<&CellValue> {
        if !self.sheets.contains_key(&key.sheet_id) {
            return None;
        }
        self.node_ids
            .get(&key)
            .map(|id| &self.nodes[id.index()].value)
    }

    #[must_use]
    pub fn formula_source(&self, key: FormulaCellKey) -> Option<&str> {
        if !self.sheets.contains_key(&key.sheet_id) {
            return None;
        }
        let formula = self
            .nodes
            .get(self.node_ids.get(&key)?.index())?
            .formula
            .as_ref()?;
        Some(self.strings.resolve(formula.source))
    }

    /// Rebuilds the derived formula graph from canonical workbook cells.
    /// Formula source is authoritative; persisted cached values are ignored
    /// and recalculated deterministically before the engine is returned.
    pub fn from_workbook(workbook: &Workbook) -> Result<Self, FormulaEngineError> {
        Self::from_workbook_with_limits(workbook, FormulaLimits::default())
    }

    pub fn from_workbook_with_limits(
        workbook: &Workbook,
        limits: FormulaLimits,
    ) -> Result<Self, FormulaEngineError> {
        let mut engine = Self::with_limits(limits)?;
        let mut formulas = Vec::new();
        for sheet in workbook.sheets() {
            engine.register_sheet(sheet.id(), sheet.name())?;
            for (coordinate, cell) in sheet.cells() {
                if let Some(source) = cell.formula_source() {
                    formulas.push((
                        FormulaCellKey::new(sheet.id(), coordinate),
                        source.to_owned(),
                    ));
                }
            }
        }
        for (key, source) in formulas {
            engine.set_formula(key, &source)?;
        }

        // Formula compilation creates nodes for referenced precedents. Hydrate
        // only those sparse inputs; unrelated dense workbook cells never enter
        // the graph or consume formula-engine limits/memory.
        let precedents: Vec<_> = engine
            .take_unhydrated_input_keys()
            .into_iter()
            .map(|key| {
                let value = workbook
                    .sheet(key.sheet_id)
                    .and_then(|sheet| sheet.cell(key.coordinate))
                    .filter(|cell| cell.formula_source().is_none())
                    .map_or(CellValue::Empty, |cell| cell.value().clone());
                (key, value)
            })
            .collect();
        for (key, value) in precedents {
            engine.set_value(key, value)?;
        }
        engine.recalculate()?;
        Ok(engine)
    }

    pub(crate) fn take_unhydrated_input_keys(&mut self) -> Vec<FormulaCellKey> {
        let queued = core::mem::take(&mut self.unhydrated_nodes);
        queued
            .into_iter()
            .filter_map(|node_id| {
                let node = &self.nodes[node_id.index()];
                (node.formula.is_none()
                    && !node.input_hydrated
                    && self.sheets.contains_key(&node.key.sheet_id))
                .then_some(node.key)
            })
            .collect()
    }

    pub(crate) fn formula_keys(&self) -> Vec<FormulaCellKey> {
        let mut keys: Vec<_> = self
            .nodes
            .iter()
            .filter_map(|node| node.formula.as_ref().map(|_| node.key))
            .filter(|key| self.sheets.contains_key(&key.sheet_id))
            .collect();
        keys.sort_unstable();
        keys
    }

    /// Returns the canonical workbook cell represented by one engine node.
    /// Dependency-only empty nodes project to `None` and deleted-sheet
    /// tombstones are never exposed as workbook cells.
    #[must_use]
    pub fn projected_cell(&self, key: FormulaCellKey) -> Option<Cell> {
        if !self.sheets.contains_key(&key.sheet_id) {
            return None;
        }
        let node_id = self.node_ids.get(&key)?;
        let node = &self.nodes[node_id.index()];
        if let Some(formula) = &node.formula {
            return Some(
                Cell::formula(self.strings.resolve(formula.source), node.value.clone())
                    .expect("formula engine sources are nonempty"),
            );
        }
        (!matches!(node.value, CellValue::Empty)).then(|| Cell::from_value(node.value.clone()))
    }

    #[must_use]
    pub fn stats(&self) -> FormulaEngineStats {
        FormulaEngineStats {
            tracked_cells: self.nodes.len(),
            formula_cells: self.formula_count,
            graph_edges: self.graph_edges,
            dirty_formula_cells: self.dirty_formula_count(),
            interned_ast_nodes: self.expressions.len(),
            compiled_ranges: self.ranges.len(),
            interned_strings: self.strings.len(),
        }
    }

    #[must_use]
    pub fn allocation_facts(&self) -> FormulaEngineAllocationFacts {
        let (ast_capacity, ast_index_capacity, call_argument_slots, sequence_operand_slots) =
            self.expressions.allocation_facts();
        let (range_capacity, range_index_capacity, range_cell_slots) =
            self.ranges.allocation_facts();
        let (string_capacity, string_index_capacity, interned_utf8_bytes) =
            self.strings.allocation_facts();
        FormulaEngineAllocationFacts {
            node_slots: self.nodes.len(),
            node_capacity: self.nodes.capacity(),
            node_index_capacity: self.node_ids.capacity(),
            sheet_node_index_slots: self.node_ids_by_sheet.values().map(BTreeMap::len).sum(),
            dependency_edge_slots: self.nodes.iter().map(|node| node.dependencies.len()).sum(),
            dependency_heap_capacity: self
                .nodes
                .iter()
                .map(|node| node.dependencies.heap_capacity())
                .sum(),
            dependent_edge_slots: self.nodes.iter().map(|node| node.dependents.len()).sum(),
            dependent_heap_capacity: self
                .nodes
                .iter()
                .map(|node| node.dependents.heap_capacity())
                .sum(),
            dirty_queue_slots: self.dirty_nodes.len(),
            dirty_queue_capacity: self.dirty_nodes.capacity(),
            hydration_queue_slots: self.unhydrated_nodes.len(),
            hydration_queue_capacity: self.unhydrated_nodes.capacity(),
            ast_slots: self.expressions.len(),
            ast_capacity,
            ast_index_capacity,
            call_argument_slots,
            sequence_operand_slots,
            range_slots: self.ranges.len(),
            range_capacity,
            range_index_capacity,
            range_cell_slots,
            string_slots: self.strings.len(),
            string_capacity,
            string_index_capacity,
            interned_utf8_bytes,
            cached_value_utf8_bytes: self.cached_value_bytes,
        }
    }

    pub fn trace(
        &self,
        root: FormulaCellKey,
        maximum_nodes: usize,
    ) -> Result<FormulaTrace, FormulaEngineError> {
        if maximum_nodes == 0 || maximum_nodes > self.limits.max_cell_reads {
            return Err(FormulaEngineError::InvalidLimit {
                resource: "formula trace nodes",
                value: maximum_nodes,
                maximum: self.limits.max_cell_reads,
            });
        }
        let Some(root_id) = self.node_ids.get(&root).copied() else {
            return Ok(FormulaTrace {
                root,
                nodes: vec![FormulaTraceNode {
                    key: root,
                    depth: 0,
                    formula: None,
                    value: CellValue::Empty,
                }],
            });
        };
        let mut output = Vec::new();
        let mut visited = BTreeSet::new();
        let mut stack = vec![(root_id, 0usize)];
        while let Some((node_id, depth)) = stack.pop() {
            if !visited.insert(node_id) {
                continue;
            }
            if output.len() >= maximum_nodes {
                return Err(FormulaEngineError::Limit {
                    resource: "formula trace nodes",
                    actual: output.len().saturating_add(1),
                    maximum: maximum_nodes,
                });
            }
            if depth > self.limits.max_dependency_depth {
                return Err(FormulaEngineError::Limit {
                    resource: "formula dependency depth",
                    actual: depth,
                    maximum: self.limits.max_dependency_depth,
                });
            }
            let node = &self.nodes[node_id.index()];
            output.push(FormulaTraceNode {
                key: node.key,
                depth,
                formula: node
                    .formula
                    .as_ref()
                    .map(|formula| self.strings.resolve(formula.source).to_owned()),
                value: node.value.clone(),
            });
            for dependency in node.dependencies.iter().rev() {
                stack.push((*dependency, depth + 1));
            }
        }
        Ok(FormulaTrace {
            root,
            nodes: output,
        })
    }

    /// Rebuilds interned arenas and graph indexes from live cells only. This
    /// makes long-running sessions history-bounded without changing formula
    /// source, values, sheet identities, or deterministic recalculation.
    pub fn compact(&mut self) -> Result<(), FormulaEngineError> {
        if self.dirty_formula_count != 0 {
            self.recalculate()?;
        }
        let mut replacement = Self::with_limits(self.limits.clone())?;
        for (sheet_id, name) in &self.sheets {
            replacement.register_sheet(*sheet_id, name.clone())?;
        }
        let retired_sheets = self.retired_sheets.clone();
        let mut formulas = Vec::with_capacity(self.formula_count);
        for node in &self.nodes {
            if !self.sheets.contains_key(&node.key.sheet_id) {
                continue;
            }
            if let Some(formula) = &node.formula {
                formulas.push((node.key, self.strings.resolve(formula.source).to_owned()));
            } else if !matches!(node.value, CellValue::Empty)
                || !node.dependents.as_slice().is_empty()
            {
                replacement.set_value(node.key, node.value.clone())?;
            }
        }
        for (key, source) in formulas {
            replacement.set_formula(key, &source)?;
        }
        // Every live non-formula precedent was explicitly restored above;
        // remaining queued entries can only be forward-referenced formulas.
        replacement.unhydrated_nodes.clear();
        replacement.recalculate()?;
        replacement.retired_sheets = retired_sheets;
        *self = replacement;
        Ok(())
    }

    fn validate_key(&self, key: FormulaCellKey) -> Result<(), FormulaEngineError> {
        if !self.sheets.contains_key(&key.sheet_id) {
            return Err(FormulaEngineError::UnknownSheet(key.sheet_id));
        }
        if key.coordinate.row >= 1_048_576 {
            return Err(FormulaEngineError::Limit {
                resource: "formula cell row",
                actual: key.coordinate.row as usize + 1,
                maximum: 1_048_576,
            });
        }
        if key.coordinate.column >= 16_384 {
            return Err(FormulaEngineError::Limit {
                resource: "formula cell column",
                actual: key.coordinate.column as usize + 1,
                maximum: 16_384,
            });
        }
        Ok(())
    }

    fn ensure_node(&mut self, key: FormulaCellKey) -> Result<NodeId, FormulaEngineError> {
        if let Some(id) = self.node_ids.get(&key) {
            return Ok(*id);
        }
        let actual = self.nodes.len().saturating_add(1);
        if actual > self.limits.max_engine_cells || actual > u32::MAX as usize {
            return Err(FormulaEngineError::Limit {
                resource: "formula engine cells",
                actual,
                maximum: self.limits.max_engine_cells.min(u32::MAX as usize),
            });
        }
        let id = NodeId(self.nodes.len() as u32);
        self.nodes.push(CellNode::new(key));
        self.node_ids.insert(key, id);
        self.node_ids_by_sheet
            .entry(key.sheet_id)
            .or_default()
            .insert(key.coordinate, id);
        Ok(id)
    }

    fn rollback_nodes(&mut self, checkpoint: usize) {
        while self.nodes.len() > checkpoint {
            let node = self.nodes.pop().expect("formula node checkpoint");
            self.node_ids.remove(&node.key);
            if let Some(nodes) = self.node_ids_by_sheet.get_mut(&node.key.sheet_id) {
                nodes.remove(&node.key.coordinate);
                if nodes.is_empty() {
                    self.node_ids_by_sheet.remove(&node.key.sheet_id);
                }
            }
        }
    }

    fn collect_reference_keys(
        &self,
        expression: &ParsedExpr,
        current_sheet: StableId,
        output: &mut BTreeSet<FormulaCellKey>,
        referenced_cell_reads: &mut usize,
    ) -> Result<(), FormulaEngineError> {
        match expression {
            ParsedExpr::Reference(reference) | ParsedExpr::Range(reference) => {
                let Some(sheet_id) = self.resolve_reference_sheet(reference, current_sheet) else {
                    return Ok(());
                };
                let rows = (reference.end.row - reference.start.row + 1) as usize;
                let columns = (reference.end.column - reference.start.column + 1) as usize;
                let cells = rows.saturating_mul(columns);
                *referenced_cell_reads = referenced_cell_reads.saturating_add(cells);
                if *referenced_cell_reads > self.limits.max_cell_reads {
                    return Err(FormulaEngineError::Limit {
                        resource: "formula cell reads",
                        actual: *referenced_cell_reads,
                        maximum: self.limits.max_cell_reads,
                    });
                }
                for row in reference.start.row..=reference.end.row {
                    for column in reference.start.column..=reference.end.column {
                        output.insert(FormulaCellKey::new(sheet_id, CellCoord::new(row, column)));
                    }
                }
            }
            ParsedExpr::Unary { operand, .. } => {
                self.collect_reference_keys(operand, current_sheet, output, referenced_cell_reads)?;
            }
            ParsedExpr::Binary { left, right, .. } => {
                self.collect_reference_keys(left, current_sheet, output, referenced_cell_reads)?;
                self.collect_reference_keys(right, current_sheet, output, referenced_cell_reads)?;
            }
            ParsedExpr::Sequence { first, rest } => {
                self.collect_reference_keys(first, current_sheet, output, referenced_cell_reads)?;
                for (_, expression) in rest {
                    self.collect_reference_keys(
                        expression,
                        current_sheet,
                        output,
                        referenced_cell_reads,
                    )?;
                }
            }
            ParsedExpr::Call { arguments, .. } => {
                for argument in arguments {
                    self.collect_reference_keys(
                        argument,
                        current_sheet,
                        output,
                        referenced_cell_reads,
                    )?;
                }
            }
            ParsedExpr::Constant(_) => {}
        }
        Ok(())
    }

    fn compile_expression(
        &mut self,
        expression: &ParsedExpr,
        current_sheet: StableId,
        dependencies: &mut Vec<NodeId>,
    ) -> Result<ExprId, FormulaEngineError> {
        let node = match expression {
            ParsedExpr::Constant(value) => ExprNode::Constant(self.compile_constant(value)?),
            ParsedExpr::Reference(reference) => {
                let Some(sheet_id) = self.resolve_reference_sheet(reference, current_sheet) else {
                    return self.intern_error(ConstantError::Reference);
                };
                let key = FormulaCellKey::new(sheet_id, reference.start);
                let node_id = self.node_ids[&key];
                dependencies.push(node_id);
                ExprNode::Reference(node_id)
            }
            ParsedExpr::Range(reference) => {
                let Some(sheet_id) = self.resolve_reference_sheet(reference, current_sheet) else {
                    return self.intern_error(ConstantError::Reference);
                };
                let rows = reference.end.row - reference.start.row + 1;
                let columns = reference.end.column - reference.start.column + 1;
                let mut nodes = Vec::with_capacity(rows as usize * columns as usize);
                for row in reference.start.row..=reference.end.row {
                    for column in reference.start.column..=reference.end.column {
                        let node_id = self.node_ids
                            [&FormulaCellKey::new(sheet_id, CellCoord::new(row, column))];
                        dependencies.push(node_id);
                        nodes.push(node_id);
                    }
                }
                let range = self.ranges.intern(
                    CompiledRange {
                        rows,
                        columns,
                        nodes: nodes.into_boxed_slice(),
                    },
                    self.limits.max_compiled_ranges,
                )?;
                ExprNode::Range(range)
            }
            ParsedExpr::Unary { operator, operand } => {
                let operand = self.compile_expression(operand, current_sheet, dependencies)?;
                ExprNode::Unary {
                    operator: match operator {
                        ParsedUnaryOperator::Plus => UnaryOperator::Plus,
                        ParsedUnaryOperator::Minus => UnaryOperator::Minus,
                        ParsedUnaryOperator::Percent => UnaryOperator::Percent,
                    },
                    operand,
                }
            }
            ParsedExpr::Binary {
                operator,
                left,
                right,
            } => {
                let left = self.compile_expression(left, current_sheet, dependencies)?;
                let right = self.compile_expression(right, current_sheet, dependencies)?;
                ExprNode::Binary {
                    operator: match operator {
                        ParsedBinaryOperator::Add => BinaryOperator::Add,
                        ParsedBinaryOperator::Subtract => BinaryOperator::Subtract,
                        ParsedBinaryOperator::Multiply => BinaryOperator::Multiply,
                        ParsedBinaryOperator::Divide => BinaryOperator::Divide,
                        ParsedBinaryOperator::Power => BinaryOperator::Power,
                        ParsedBinaryOperator::Concatenate => BinaryOperator::Concatenate,
                        ParsedBinaryOperator::Equal => BinaryOperator::Equal,
                        ParsedBinaryOperator::NotEqual => BinaryOperator::NotEqual,
                        ParsedBinaryOperator::Less => BinaryOperator::Less,
                        ParsedBinaryOperator::Greater => BinaryOperator::Greater,
                        ParsedBinaryOperator::LessOrEqual => BinaryOperator::LessOrEqual,
                        ParsedBinaryOperator::GreaterOrEqual => BinaryOperator::GreaterOrEqual,
                    },
                    left,
                    right,
                }
            }
            ParsedExpr::Sequence { first, rest } => {
                let first = self.compile_expression(first, current_sheet, dependencies)?;
                let mut compiled = Vec::with_capacity(rest.len());
                for (operator, expression) in rest {
                    let expression =
                        self.compile_expression(expression, current_sheet, dependencies)?;
                    let operator = match operator {
                        ParsedBinaryOperator::Add => BinaryOperator::Add,
                        ParsedBinaryOperator::Subtract => BinaryOperator::Subtract,
                        ParsedBinaryOperator::Multiply => BinaryOperator::Multiply,
                        ParsedBinaryOperator::Divide => BinaryOperator::Divide,
                        ParsedBinaryOperator::Power => BinaryOperator::Power,
                        ParsedBinaryOperator::Concatenate => BinaryOperator::Concatenate,
                        ParsedBinaryOperator::Equal => BinaryOperator::Equal,
                        ParsedBinaryOperator::NotEqual => BinaryOperator::NotEqual,
                        ParsedBinaryOperator::Less => BinaryOperator::Less,
                        ParsedBinaryOperator::Greater => BinaryOperator::Greater,
                        ParsedBinaryOperator::LessOrEqual => BinaryOperator::LessOrEqual,
                        ParsedBinaryOperator::GreaterOrEqual => BinaryOperator::GreaterOrEqual,
                    };
                    compiled.push((operator, expression));
                }
                ExprNode::Sequence {
                    first,
                    rest: compiled.into_boxed_slice(),
                }
            }
            ParsedExpr::Call { name, arguments } => {
                let function = self.compile_function(name)?;
                let mut compiled = Vec::with_capacity(arguments.len());
                for argument in arguments {
                    compiled.push(self.compile_expression(
                        argument,
                        current_sheet,
                        dependencies,
                    )?);
                }
                ExprNode::Call {
                    function,
                    arguments: compiled.into_boxed_slice(),
                }
            }
        };
        self.expressions
            .intern(node, self.limits.max_interned_ast_nodes)
    }

    fn compile_constant(
        &mut self,
        value: &ParsedValue,
    ) -> Result<ConstantValue, FormulaEngineError> {
        Ok(match value {
            ParsedValue::Boolean(value) => ConstantValue::Boolean(*value),
            ParsedValue::Number(value) if value.is_finite() => {
                ConstantValue::Number(if *value == 0.0 { 0 } else { value.to_bits() })
            }
            ParsedValue::Number(_) => ConstantValue::Error(ConstantError::Number),
            ParsedValue::Text(value) => ConstantValue::Text(
                self.strings
                    .intern(value, self.limits.max_interned_string_bytes)?,
            ),
            ParsedValue::Error(error) => ConstantValue::Error(match error {
                ParsedError::DivideByZero => ConstantError::DivideByZero,
                ParsedError::Value => ConstantError::Value,
                ParsedError::Reference => ConstantError::Reference,
                ParsedError::Name => ConstantError::Name,
                ParsedError::Number => ConstantError::Number,
                ParsedError::NotAvailable => ConstantError::NotAvailable,
                ParsedError::Cycle => ConstantError::Custom(
                    self.strings
                        .intern("#CYCLE!", self.limits.max_interned_string_bytes)?,
                ),
            }),
        })
    }

    fn compile_function(&mut self, name: &str) -> Result<FormulaFunction, FormulaEngineError> {
        Ok(match name.to_ascii_uppercase().as_str() {
            "SUM" => FormulaFunction::Sum,
            "AVERAGE" => FormulaFunction::Average,
            "MIN" => FormulaFunction::Min,
            "MAX" => FormulaFunction::Max,
            "COUNT" => FormulaFunction::Count,
            "COUNTA" => FormulaFunction::CountA,
            "IF" => FormulaFunction::If,
            "IFERROR" => FormulaFunction::IfError,
            "AND" => FormulaFunction::And,
            "OR" => FormulaFunction::Or,
            "NOT" => FormulaFunction::Not,
            "ABS" => FormulaFunction::Abs,
            "ROUND" => FormulaFunction::Round,
            "ROUNDUP" => FormulaFunction::RoundUp,
            "ROUNDDOWN" => FormulaFunction::RoundDown,
            "POWER" => FormulaFunction::Power,
            "SQRT" => FormulaFunction::Sqrt,
            "LEN" => FormulaFunction::Len,
            "LOWER" => FormulaFunction::Lower,
            "UPPER" => FormulaFunction::Upper,
            "TRIM" => FormulaFunction::Trim,
            "LEFT" => FormulaFunction::Left,
            "RIGHT" => FormulaFunction::Right,
            "MID" => FormulaFunction::Mid,
            "CONCAT" => FormulaFunction::Concat,
            "DATE" => FormulaFunction::Date,
            "YEAR" => FormulaFunction::Year,
            "MONTH" => FormulaFunction::Month,
            "DAY" => FormulaFunction::Day,
            "INDEX" => FormulaFunction::Index,
            "MATCH" => FormulaFunction::Match,
            "XLOOKUP" => FormulaFunction::XLookup,
            _ => FormulaFunction::Unknown(self.strings.intern(
                &name.to_ascii_uppercase(),
                self.limits.max_interned_string_bytes,
            )?),
        })
    }

    fn intern_error(&mut self, error: ConstantError) -> Result<ExprId, FormulaEngineError> {
        self.expressions.intern(
            ExprNode::Constant(ConstantValue::Error(error)),
            self.limits.max_interned_ast_nodes,
        )
    }

    fn resolve_reference_sheet(
        &self,
        reference: &ParsedReference,
        current_sheet: StableId,
    ) -> Option<StableId> {
        reference
            .sheet_name
            .as_ref()
            .map_or(Some(current_sheet), |name| {
                self.sheet_ids_by_name
                    .get(&normalize_sheet_name(name))
                    .copied()
            })
    }

    fn detach_dependencies(&mut self, node_id: NodeId) {
        let dependencies = core::mem::take(&mut self.nodes[node_id.index()].dependencies);
        self.graph_edges = self.graph_edges.saturating_sub(dependencies.len());
        for dependency in dependencies.iter().copied() {
            self.nodes[dependency.index()]
                .dependents
                .remove_sorted(node_id);
        }
    }

    fn validate_prospective_dependency_depth(
        &self,
        key: FormulaCellKey,
        referenced_keys: &BTreeSet<FormulaCellKey>,
    ) -> Result<(), FormulaEngineError> {
        let excluded = self.node_ids.get(&key).copied();
        let mut operations = 0usize;
        let mut upstream = 0usize;
        for dependency in referenced_keys
            .iter()
            .filter_map(|dependency| self.node_ids.get(dependency).copied())
        {
            let mut visiting = BTreeSet::new();
            upstream = upstream.max(self.formula_path_depth(
                dependency,
                excluded,
                true,
                &mut visiting,
                &mut operations,
            )?);
        }
        let downstream = if let Some(node_id) = excluded {
            let mut maximum = 0usize;
            for dependent in self.nodes[node_id.index()].dependents.iter().copied() {
                let mut visiting = BTreeSet::new();
                maximum = maximum.max(self.formula_path_depth(
                    dependent,
                    excluded,
                    false,
                    &mut visiting,
                    &mut operations,
                )?);
            }
            maximum
        } else {
            0
        };
        let depth = upstream.saturating_add(1).saturating_add(downstream);
        if depth > self.limits.max_dependency_depth {
            return Err(FormulaEngineError::Limit {
                resource: "formula dependency depth",
                actual: depth,
                maximum: self.limits.max_dependency_depth,
            });
        }
        Ok(())
    }

    fn formula_path_depth(
        &self,
        node_id: NodeId,
        excluded: Option<NodeId>,
        upstream: bool,
        visiting: &mut BTreeSet<NodeId>,
        operations: &mut usize,
    ) -> Result<usize, FormulaEngineError> {
        if Some(node_id) == excluded || self.nodes[node_id.index()].formula.is_none() {
            return Ok(0);
        }
        if !visiting.insert(node_id) {
            return Ok(0);
        }
        *operations = operations.saturating_add(1);
        if *operations > self.limits.max_operations {
            return Err(FormulaEngineError::Limit {
                resource: "formula graph validation operations",
                actual: *operations,
                maximum: self.limits.max_operations,
            });
        }
        let adjacent = if upstream {
            &self.nodes[node_id.index()].dependencies
        } else {
            &self.nodes[node_id.index()].dependents
        };
        let mut depth = 1usize;
        for adjacent in adjacent.iter().copied() {
            depth = depth.max(1usize.saturating_add(
                self.formula_path_depth(adjacent, excluded, upstream, visiting, operations)?,
            ));
            if depth > self.limits.max_dependency_depth {
                break;
            }
        }
        visiting.remove(&node_id);
        Ok(depth)
    }

    fn mark_formula_dirty(&mut self, root: NodeId) {
        self.compact_dirty_nodes_if_needed();
        if self.nodes[root.index()].formula.is_some() && !self.nodes[root.index()].dirty {
            self.nodes[root.index()].dirty = true;
            self.dirty_nodes.push(root);
            self.dirty_formula_count += 1;
        }
        self.mark_dependents_dirty(root);
    }

    fn mark_dependents_dirty(&mut self, root: NodeId) {
        self.compact_dirty_nodes_if_needed();
        let mut queue = VecDeque::from([root]);
        while let Some(node_id) = queue.pop_front() {
            let dependent_count = self.nodes[node_id.index()].dependents.len();
            for index in 0..dependent_count {
                let dependent = self.nodes[node_id.index()]
                    .dependents
                    .get(index)
                    .expect("dependent index");
                let cell = &mut self.nodes[dependent.index()];
                if cell.formula.is_some() && !cell.dirty {
                    cell.dirty = true;
                    self.dirty_nodes.push(dependent);
                    self.dirty_formula_count += 1;
                    queue.push_back(dependent);
                }
            }
        }
    }

    fn dirty_formula_count(&self) -> usize {
        self.dirty_formula_count
    }

    fn compact_dirty_nodes_if_needed(&mut self) {
        let retained_bound = self
            .dirty_formula_count
            .saturating_mul(2)
            .saturating_add(1_024);
        if self.dirty_nodes.len() <= retained_bound {
            return;
        }
        let nodes = &self.nodes;
        self.dirty_nodes
            .retain(|node_id| nodes[node_id.index()].dirty);
    }

    fn compact_if_needed(&mut self) -> Result<(), FormulaEngineError> {
        if self.dirty_formula_count != 0 {
            return Ok(());
        }
        let live_nodes = self
            .nodes
            .iter()
            .filter(|node| {
                self.sheets.contains_key(&node.key.sheet_id)
                    && (node.formula.is_some()
                        || !matches!(node.value, CellValue::Empty)
                        || !node.dependents.as_slice().is_empty())
            })
            .count();
        let stale_nodes = self.nodes.len() > live_nodes.saturating_mul(2).saturating_add(1_024);
        let stale_expressions =
            self.expressions.len() > self.formula_count.saturating_mul(8).saturating_add(1_024);
        let stale_ranges =
            self.ranges.len() > self.formula_count.saturating_mul(2).saturating_add(1_024);
        let stale_strings = self.strings.len()
            > self
                .formula_count
                .saturating_mul(4)
                .saturating_add(self.sheets.len().saturating_mul(2))
                .saturating_add(1_024);
        if stale_nodes || stale_expressions || stale_ranges || stale_strings {
            self.compact()?;
        }
        Ok(())
    }
}

impl Default for FormulaEngine {
    fn default() -> Self {
        Self::new()
    }
}

fn normalize_sheet_name(name: &str) -> String {
    name.chars().flat_map(char::to_lowercase).collect()
}

fn validate_input_value(value: &CellValue, maximum: usize) -> Result<(), FormulaEngineError> {
    let length = value_utf8_bytes(value);
    if length > maximum {
        return Err(FormulaEngineError::Limit {
            resource: "cell text bytes",
            actual: length,
            maximum,
        });
    }
    Ok(())
}

fn value_utf8_bytes(value: &CellValue) -> usize {
    match value {
        CellValue::Text(value) | CellValue::Error(FormulaError::Custom(value)) => value.len(),
        _ => 0,
    }
}

fn constant_to_value(value: ConstantValue, strings: &StringInterner) -> CellValue {
    match value {
        ConstantValue::Boolean(value) => CellValue::Boolean(value),
        ConstantValue::Number(bits) => Number::new(f64::from_bits(bits))
            .map(CellValue::Number)
            .unwrap_or(CellValue::Error(FormulaError::Number)),
        ConstantValue::Text(id) => CellValue::Text(strings.resolve(id).to_owned()),
        ConstantValue::Error(error) => CellValue::Error(match error {
            ConstantError::DivideByZero => FormulaError::DivideByZero,
            ConstantError::Value => FormulaError::Value,
            ConstantError::Reference => FormulaError::Reference,
            ConstantError::Name => FormulaError::Name,
            ConstantError::Number => FormulaError::Number,
            ConstantError::NotAvailable => FormulaError::NotAvailable,
            ConstantError::Custom(id) => FormulaError::Custom(strings.resolve(id).to_owned()),
        }),
    }
}

#[cfg(test)]
mod tests;
