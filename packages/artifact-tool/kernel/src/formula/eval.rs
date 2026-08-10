use std::cmp::Ordering;

use crate::{CellValue, DateValue, FormulaError, Number};

use super::arena::{BinaryOperator, ExprId, ExprNode, RangeId, UnaryOperator};
use super::{
    constant_to_value, value_utf8_bytes, FormulaEngine, FormulaEngineError, FormulaFunction,
    NodeId, RecalculationReceipt,
};

#[derive(Clone, Copy, Debug)]
enum EvaluatedValue {
    Scalar,
    Reference,
    Range(RangeId),
}

#[derive(Debug)]
struct Evaluation {
    kind: EvaluatedValue,
    scalar: CellValue,
}

impl Evaluation {
    fn scalar(value: CellValue) -> Self {
        Self {
            kind: EvaluatedValue::Scalar,
            scalar: value,
        }
    }

    fn reference(value: CellValue) -> Self {
        Self {
            kind: EvaluatedValue::Reference,
            scalar: value,
        }
    }
}

#[derive(Debug)]
struct RecalculationBudget {
    local_operations: usize,
    local_cell_reads: usize,
    operations: usize,
    cell_reads: usize,
    pending_value_bytes: usize,
}

impl RecalculationBudget {
    fn new(retained_value_bytes: usize) -> Self {
        Self {
            local_operations: 0,
            local_cell_reads: 0,
            operations: 0,
            cell_reads: 0,
            pending_value_bytes: retained_value_bytes,
        }
    }

    fn begin_formula(&mut self) {
        self.local_operations = 0;
        self.local_cell_reads = 0;
    }

    fn consume_operations(
        &mut self,
        count: usize,
        engine: &FormulaEngine,
    ) -> Result<(), FormulaEngineError> {
        self.local_operations = checked_add(
            "formula operations",
            self.local_operations,
            count,
            engine.limits.max_operations,
        )?;
        self.operations = checked_add(
            "recalculation operations",
            self.operations,
            count,
            engine.limits.max_recalculation_operations,
        )?;
        Ok(())
    }

    fn consume_cell_reads(
        &mut self,
        count: usize,
        engine: &FormulaEngine,
    ) -> Result<(), FormulaEngineError> {
        self.local_cell_reads = checked_add(
            "formula cell reads",
            self.local_cell_reads,
            count,
            engine.limits.max_cell_reads,
        )?;
        self.cell_reads = checked_add(
            "recalculation cell reads",
            self.cell_reads,
            count,
            engine.limits.max_recalculation_cell_reads,
        )?;
        Ok(())
    }

    fn consume_value(
        &mut self,
        value: &CellValue,
        engine: &FormulaEngine,
    ) -> Result<(), FormulaEngineError> {
        self.pending_value_bytes = checked_add(
            "formula engine value bytes",
            self.pending_value_bytes,
            value_utf8_bytes(value),
            engine.limits.max_engine_value_bytes,
        )?;
        Ok(())
    }
}

impl FormulaEngine {
    /// Recalculates only the dirty reverse-dependency closure. Derived values
    /// are committed together; a resource failure leaves every cached formula
    /// value unchanged and the affected graph dirty for a later retry.
    pub fn recalculate(&mut self) -> Result<RecalculationReceipt, FormulaEngineError> {
        let mut dirty = core::mem::take(&mut self.dirty_nodes);
        dirty.retain(|node_id| {
            let node = &self.nodes[node_id.index()];
            node.dirty && node.formula.is_some()
        });
        dirty.sort_unstable();
        dirty.dedup();
        if dirty.is_empty() {
            self.dirty_nodes = dirty;
            self.dirty_formula_count = 0;
            return Ok(RecalculationReceipt {
                evaluated_cells: 0,
                changed_cells: Vec::new(),
                partition_widths: Vec::new(),
                cyclic_or_blocked_cells: 0,
                cell_reads: 0,
                operations: 0,
            });
        }

        for node_id in &dirty {
            let indegree = self.nodes[node_id.index()]
                .dependencies
                .iter()
                .filter(|dependency| {
                    let node = &self.nodes[dependency.index()];
                    node.dirty && node.formula.is_some()
                })
                .count();
            self.nodes[node_id.index()].calculation_indegree =
                u32::try_from(indegree).map_err(|_| FormulaEngineError::Limit {
                    resource: "formula dependency fan-in",
                    actual: indegree,
                    maximum: u32::MAX as usize,
                })?;
            self.nodes[node_id.index()].pending_value = None;
        }

        let mut ready: Vec<NodeId> = dirty
            .iter()
            .copied()
            .filter(|node_id| self.nodes[node_id.index()].calculation_indegree == 0)
            .collect();
        let mut partition_widths = Vec::new();
        let mut processed = 0usize;
        let dirty_cached_value_bytes: usize = dirty
            .iter()
            .map(|node_id| value_utf8_bytes(&self.nodes[node_id.index()].value))
            .sum();
        let retained_value_bytes = self
            .cached_value_bytes
            .saturating_sub(dirty_cached_value_bytes);
        let mut budget = RecalculationBudget::new(retained_value_bytes);
        let calculation = (|| -> Result<usize, FormulaEngineError> {
            while !ready.is_empty() {
                let depth = partition_widths.len().saturating_add(1);
                if depth > self.limits.max_dependency_depth {
                    return Err(FormulaEngineError::Limit {
                        resource: "formula dependency depth",
                        actual: depth,
                        maximum: self.limits.max_dependency_depth,
                    });
                }
                ready.sort_unstable();
                ready.dedup();
                partition_widths.push(ready.len());
                let current = core::mem::take(&mut ready);
                let mut next = Vec::new();
                for node_id in current {
                    budget.begin_formula();
                    let root = self.nodes[node_id.index()]
                        .formula
                        .as_ref()
                        .expect("dirty formula node")
                        .root;
                    let result = self.evaluate_expression(root, &mut budget)?.scalar;
                    budget.consume_value(&result, self)?;
                    self.nodes[node_id.index()].pending_value = Some(result);
                    processed += 1;

                    let dependent_count = self.nodes[node_id.index()].dependents.len();
                    for index in 0..dependent_count {
                        let dependent = self.nodes[node_id.index()]
                            .dependents
                            .get(index)
                            .expect("dependent index");
                        let dependent_node = &mut self.nodes[dependent.index()];
                        if !dependent_node.dirty || dependent_node.formula.is_none() {
                            continue;
                        }
                        debug_assert!(dependent_node.calculation_indegree > 0);
                        dependent_node.calculation_indegree -= 1;
                        if dependent_node.calculation_indegree == 0 {
                            next.push(dependent);
                        }
                    }
                }
                ready = next;
            }
            // Kahn's remainder is either a cycle or transitively blocked by
            // one. Bound every derived error before staging it.
            let mut cyclic_or_blocked = 0usize;
            if processed != dirty.len() {
                for node_id in &dirty {
                    if self.nodes[node_id.index()].pending_value.is_none() {
                        let value = CellValue::Error(FormulaError::Custom("#CYCLE!".to_owned()));
                        budget.consume_value(&value, self)?;
                        self.nodes[node_id.index()].pending_value = Some(value);
                        cyclic_or_blocked += 1;
                    }
                }
            }
            Ok(cyclic_or_blocked)
        })();

        let cyclic_or_blocked = match calculation {
            Ok(value) => value,
            Err(error) => {
                for node_id in &dirty {
                    self.nodes[node_id.index()].pending_value = None;
                    self.nodes[node_id.index()].calculation_indegree = 0;
                }
                self.dirty_nodes = dirty;
                return Err(error);
            }
        };

        let mut changed_cells = Vec::new();
        for node_id in &dirty {
            let node = &mut self.nodes[node_id.index()];
            let value = node
                .pending_value
                .take()
                .expect("every dirty formula has a pending result");
            if node.value != value {
                node.value = value;
                changed_cells.push(node.key);
            }
            node.dirty = false;
            node.calculation_indegree = 0;
        }
        let evaluated_cells = dirty.len();
        dirty.clear();
        self.dirty_nodes = dirty;
        self.dirty_formula_count = 0;
        self.cached_value_bytes = budget.pending_value_bytes;
        changed_cells.sort_unstable();
        Ok(RecalculationReceipt {
            evaluated_cells,
            changed_cells,
            partition_widths,
            cyclic_or_blocked_cells: cyclic_or_blocked,
            cell_reads: budget.cell_reads,
            operations: budget.operations,
        })
    }

    fn evaluate_expression(
        &self,
        expression: ExprId,
        budget: &mut RecalculationBudget,
    ) -> Result<Evaluation, FormulaEngineError> {
        budget.consume_operations(1, self)?;
        match self.expressions.get(expression) {
            ExprNode::Constant(value) => {
                Ok(Evaluation::scalar(constant_to_value(*value, &self.strings)))
            }
            ExprNode::Reference(node_id) => {
                budget.consume_cell_reads(1, self)?;
                let value = self.calculated_value(*node_id).clone();
                self.bound_formula_value(&value)?;
                Ok(Evaluation::reference(value))
            }
            ExprNode::Range(range_id) => {
                let range = self.ranges.get(*range_id);
                budget.consume_cell_reads(range.nodes.len(), self)?;
                for node_id in &range.nodes {
                    self.bound_formula_value(self.calculated_value(*node_id))?;
                }
                let scalar = range
                    .nodes
                    .first()
                    .map(|node_id| self.calculated_value(*node_id).clone())
                    .unwrap_or(CellValue::Empty);
                Ok(Evaluation {
                    kind: EvaluatedValue::Range(*range_id),
                    scalar,
                })
            }
            ExprNode::Unary { operator, operand } => {
                let operand = self.evaluate_expression(*operand, budget)?;
                Ok(Evaluation::scalar(
                    self.evaluate_unary(*operator, operand.scalar),
                ))
            }
            ExprNode::Binary {
                operator,
                left,
                right,
            } => {
                let left = self.evaluate_expression(*left, budget)?;
                let right = self.evaluate_expression(*right, budget)?;
                self.evaluate_binary(*operator, left.scalar, right.scalar)
            }
            ExprNode::Sequence { first, rest } => {
                budget.consume_operations(rest.len().saturating_sub(1), self)?;
                let mut value = self.evaluate_expression(*first, budget)?;
                for (operator, expression) in rest.iter().copied() {
                    let right = self.evaluate_expression(expression, budget)?;
                    value = self.evaluate_binary(operator, value.scalar, right.scalar)?;
                }
                Ok(value)
            }
            ExprNode::Call {
                function,
                arguments,
            } => self.evaluate_call(*function, arguments, budget),
        }
    }

    fn evaluate_call(
        &self,
        function: FormulaFunction,
        arguments: &[ExprId],
        budget: &mut RecalculationBudget,
    ) -> Result<Evaluation, FormulaEngineError> {
        if matches!(function, FormulaFunction::Unknown(_)) {
            return Ok(Evaluation::scalar(CellValue::Error(FormulaError::Name)));
        }
        if !valid_argument_count(function, arguments.len()) {
            return Ok(Evaluation::scalar(CellValue::Error(FormulaError::Value)));
        }

        // IF and IFERROR are special forms: evaluating every argument first can
        // surface an error or consume range-read fuel from a branch that the
        // worksheet never selected.
        match function {
            FormulaFunction::If => {
                let condition = self.evaluate_expression(arguments[0], budget)?.scalar;
                let selected = match truthy(&condition) {
                    Ok(true) => self.evaluate_expression(arguments[1], budget)?.scalar,
                    Ok(false) => match arguments.get(2) {
                        Some(argument) => self.evaluate_expression(*argument, budget)?.scalar,
                        None => CellValue::Boolean(false),
                    },
                    Err(error) => CellValue::Error(error),
                };
                self.bound_formula_value(&selected)?;
                return Ok(Evaluation::scalar(selected));
            }
            FormulaFunction::IfError => {
                let value = self.evaluate_expression(arguments[0], budget)?.scalar;
                let selected = if matches!(value, CellValue::Error(_)) {
                    self.evaluate_expression(arguments[1], budget)?.scalar
                } else {
                    value
                };
                self.bound_formula_value(&selected)?;
                return Ok(Evaluation::scalar(selected));
            }
            _ => {}
        }

        let mut evaluated = Vec::with_capacity(arguments.len());
        for argument in arguments.iter().copied() {
            evaluated.push(self.evaluate_expression(argument, budget)?);
        }
        self.evaluate_function(function, &evaluated)
    }

    fn calculated_value(&self, node_id: NodeId) -> &CellValue {
        let node = &self.nodes[node_id.index()];
        node.pending_value.as_ref().unwrap_or(&node.value)
    }

    fn bound_formula_value(&self, value: &CellValue) -> Result<(), FormulaEngineError> {
        if let CellValue::Text(value) = value {
            let actual = value.encode_utf16().count();
            if actual > self.limits.max_result_utf16_units {
                return Err(FormulaEngineError::Limit {
                    resource: "formula result UTF-16 units",
                    actual,
                    maximum: self.limits.max_result_utf16_units,
                });
            }
        }
        Ok(())
    }

    fn evaluate_unary(&self, operator: UnaryOperator, value: CellValue) -> CellValue {
        if matches!(value, CellValue::Error(_)) {
            return value;
        }
        let number = match numeric(&value) {
            Ok(value) => value,
            Err(error) => return CellValue::Error(error),
        };
        match operator {
            UnaryOperator::Plus => finite_number(number),
            UnaryOperator::Minus => finite_number(-number),
            UnaryOperator::Percent => finite_number(number / 100.0),
        }
    }

    fn evaluate_binary(
        &self,
        operator: BinaryOperator,
        left: CellValue,
        right: CellValue,
    ) -> Result<Evaluation, FormulaEngineError> {
        if let CellValue::Error(_) = left {
            return Ok(Evaluation::scalar(left));
        }
        if let CellValue::Error(_) = right {
            return Ok(Evaluation::scalar(right));
        }
        let value = match operator {
            BinaryOperator::Add
            | BinaryOperator::Subtract
            | BinaryOperator::Multiply
            | BinaryOperator::Divide
            | BinaryOperator::Power => {
                let left = match numeric(&left) {
                    Ok(value) => value,
                    Err(error) => return Ok(Evaluation::scalar(CellValue::Error(error))),
                };
                let right = match numeric(&right) {
                    Ok(value) => value,
                    Err(error) => return Ok(Evaluation::scalar(CellValue::Error(error))),
                };
                match operator {
                    BinaryOperator::Add => finite_number(left + right),
                    BinaryOperator::Subtract => finite_number(left - right),
                    BinaryOperator::Multiply => finite_number(left * right),
                    BinaryOperator::Divide if right == 0.0 => {
                        CellValue::Error(FormulaError::DivideByZero)
                    }
                    BinaryOperator::Divide => finite_number(left / right),
                    BinaryOperator::Power => finite_number(left.powf(right)),
                    _ => unreachable!(),
                }
            }
            BinaryOperator::Concatenate => {
                let left = match text(&left) {
                    Ok(value) => value,
                    Err(error) => return Ok(Evaluation::scalar(CellValue::Error(error))),
                };
                let right = match text(&right) {
                    Ok(value) => value,
                    Err(error) => return Ok(Evaluation::scalar(CellValue::Error(error))),
                };
                let actual = left
                    .encode_utf16()
                    .count()
                    .saturating_add(right.encode_utf16().count());
                if actual > self.limits.max_result_utf16_units {
                    return Err(FormulaEngineError::Limit {
                        resource: "formula result UTF-16 units",
                        actual,
                        maximum: self.limits.max_result_utf16_units,
                    });
                }
                CellValue::Text(left + &right)
            }
            BinaryOperator::Equal
            | BinaryOperator::NotEqual
            | BinaryOperator::Less
            | BinaryOperator::Greater
            | BinaryOperator::LessOrEqual
            | BinaryOperator::GreaterOrEqual => match compare_values(&left, &right, operator) {
                Ok(value) => CellValue::Boolean(value),
                Err(error) => CellValue::Error(error),
            },
        };
        Ok(Evaluation::scalar(value))
    }

    fn evaluate_function(
        &self,
        function: FormulaFunction,
        arguments: &[Evaluation],
    ) -> Result<Evaluation, FormulaEngineError> {
        let scalar = |index: usize, fallback: CellValue| {
            arguments
                .get(index)
                .map_or(fallback, |argument| argument.scalar.clone())
        };
        let value = match function {
            FormulaFunction::Sum
            | FormulaFunction::Average
            | FormulaFunction::Min
            | FormulaFunction::Max
            | FormulaFunction::Count => {
                let mut values = Vec::new();
                let mut fault = None;
                for argument in arguments {
                    if fault.is_some() {
                        break;
                    }
                    let mut consume = |value: &CellValue, direct: bool| {
                        if fault.is_some() {
                            return;
                        }
                        let numeric = if direct {
                            numeric(value).map(Some)
                        } else {
                            numeric_for_aggregate(value)
                        };
                        match numeric {
                            Ok(Some(value)) => values.push(value),
                            Ok(None) => {}
                            Err(error) => fault = Some(error),
                        }
                    };
                    match argument.kind {
                        EvaluatedValue::Scalar => consume(&argument.scalar, true),
                        EvaluatedValue::Reference => consume(&argument.scalar, false),
                        EvaluatedValue::Range(range_id) => {
                            for node_id in &self.ranges.get(range_id).nodes {
                                consume(self.calculated_value(*node_id), false);
                            }
                        }
                    }
                }
                if let Some(error) = fault {
                    CellValue::Error(error)
                } else {
                    match function {
                        FormulaFunction::Sum => finite_number(values.iter().copied().sum::<f64>()),
                        FormulaFunction::Average if values.is_empty() => {
                            CellValue::Error(FormulaError::DivideByZero)
                        }
                        FormulaFunction::Average => {
                            finite_number(values.iter().copied().sum::<f64>() / values.len() as f64)
                        }
                        FormulaFunction::Min => values
                            .into_iter()
                            .reduce(f64::min)
                            .map_or_else(|| finite_number(0.0), finite_number),
                        FormulaFunction::Max => values
                            .into_iter()
                            .reduce(f64::max)
                            .map_or_else(|| finite_number(0.0), finite_number),
                        FormulaFunction::Count => finite_number(values.len() as f64),
                        _ => unreachable!(),
                    }
                }
            }
            FormulaFunction::CountA => {
                let mut count = 0usize;
                self.visit_scalars(arguments, |value| {
                    if !matches!(value, CellValue::Empty) {
                        count += 1;
                    }
                });
                finite_number(count as f64)
            }
            FormulaFunction::If | FormulaFunction::IfError => {
                unreachable!("lazy functions are evaluated before eager arguments")
            }
            FormulaFunction::And | FormulaFunction::Or => {
                let mut values = Vec::with_capacity(arguments.len());
                let mut fault = None;
                self.visit_scalars(arguments, |value| {
                    if fault.is_some() {
                        return;
                    }
                    match truthy(value) {
                        Ok(value) => values.push(value),
                        Err(error) => fault = Some(error),
                    }
                });
                fault.map_or_else(
                    || {
                        CellValue::Boolean(if function == FormulaFunction::And {
                            values.into_iter().all(core::convert::identity)
                        } else {
                            values.into_iter().any(core::convert::identity)
                        })
                    },
                    CellValue::Error,
                )
            }
            FormulaFunction::Not => match truthy(&scalar(0, CellValue::Boolean(false))) {
                Ok(value) => CellValue::Boolean(!value),
                Err(error) => CellValue::Error(error),
            },
            FormulaFunction::Abs => unary_numeric(&scalar(0, finite_number(0.0)), f64::abs),
            FormulaFunction::Round | FormulaFunction::RoundUp | FormulaFunction::RoundDown => {
                let value = match numeric(&scalar(0, finite_number(0.0))) {
                    Ok(value) => value,
                    Err(error) => return Ok(Evaluation::scalar(CellValue::Error(error))),
                };
                let digits = match numeric(&scalar(1, finite_number(0.0))) {
                    Ok(value) => value,
                    Err(error) => return Ok(Evaluation::scalar(CellValue::Error(error))),
                };
                let factor = 10f64.powf(digits);
                if !factor.is_finite() || factor == 0.0 {
                    CellValue::Error(FormulaError::Number)
                } else {
                    let scaled = value * factor;
                    let rounded = match function {
                        FormulaFunction::Round => scaled.signum() * scaled.abs().round(),
                        FormulaFunction::RoundUp => scaled.signum() * scaled.abs().ceil(),
                        FormulaFunction::RoundDown => scaled.signum() * scaled.abs().floor(),
                        _ => unreachable!(),
                    };
                    finite_number(rounded / factor)
                }
            }
            FormulaFunction::Power => binary_numeric(
                &scalar(0, finite_number(0.0)),
                &scalar(1, finite_number(0.0)),
                f64::powf,
            ),
            FormulaFunction::Sqrt => {
                let value = match numeric(&scalar(0, finite_number(0.0))) {
                    Ok(value) => value,
                    Err(error) => return Ok(Evaluation::scalar(CellValue::Error(error))),
                };
                if value < 0.0 {
                    CellValue::Error(FormulaError::Number)
                } else {
                    finite_number(value.sqrt())
                }
            }
            FormulaFunction::Len => match text(&scalar(0, CellValue::Empty)) {
                Ok(value) => finite_number(value.encode_utf16().count() as f64),
                Err(error) => CellValue::Error(error),
            },
            FormulaFunction::Lower | FormulaFunction::Upper | FormulaFunction::Trim => {
                match text(&scalar(0, CellValue::Empty)) {
                    Ok(value) => {
                        let value = match function {
                            FormulaFunction::Lower => value.to_lowercase(),
                            FormulaFunction::Upper => value.to_uppercase(),
                            FormulaFunction::Trim => {
                                value.split_whitespace().collect::<Vec<_>>().join(" ")
                            }
                            _ => unreachable!(),
                        };
                        self.bounded_text(value)?
                    }
                    Err(error) => CellValue::Error(error),
                }
            }
            FormulaFunction::Left | FormulaFunction::Right | FormulaFunction::Mid => {
                let source = match text(&scalar(0, CellValue::Empty)) {
                    Ok(value) => value,
                    Err(error) => return Ok(Evaluation::scalar(CellValue::Error(error))),
                };
                let characters: Vec<char> = source.chars().collect();
                let value = match function {
                    FormulaFunction::Left => {
                        let count = match numeric_integer(&scalar(1, finite_number(1.0))) {
                            Ok(value) => value,
                            Err(error) => return Ok(Evaluation::scalar(CellValue::Error(error))),
                        };
                        if count < 0 {
                            return Ok(Evaluation::scalar(CellValue::Error(FormulaError::Value)));
                        }
                        characters
                            .iter()
                            .take(usize::try_from(count).unwrap_or(usize::MAX))
                            .collect()
                    }
                    FormulaFunction::Right => {
                        let count = match numeric_integer(&scalar(1, finite_number(1.0))) {
                            Ok(value) => value,
                            Err(error) => return Ok(Evaluation::scalar(CellValue::Error(error))),
                        };
                        if count < 0 {
                            return Ok(Evaluation::scalar(CellValue::Error(FormulaError::Value)));
                        }
                        let count = usize::try_from(count).unwrap_or(usize::MAX);
                        characters[characters.len().saturating_sub(count)..]
                            .iter()
                            .collect()
                    }
                    FormulaFunction::Mid => {
                        let start = match numeric_integer(&scalar(1, finite_number(1.0))) {
                            Ok(value) => value,
                            Err(error) => return Ok(Evaluation::scalar(CellValue::Error(error))),
                        };
                        let count = match numeric_integer(&scalar(2, finite_number(0.0))) {
                            Ok(value) => value,
                            Err(error) => return Ok(Evaluation::scalar(CellValue::Error(error))),
                        };
                        if start < 1 || count < 0 {
                            return Ok(Evaluation::scalar(CellValue::Error(FormulaError::Value)));
                        }
                        characters
                            .iter()
                            .skip(usize::try_from(start - 1).unwrap_or(usize::MAX))
                            .take(usize::try_from(count).unwrap_or(usize::MAX))
                            .collect()
                    }
                    _ => unreachable!(),
                };
                self.bounded_text(value)?
            }
            FormulaFunction::Concat => {
                let mut output = String::new();
                let mut units = 0usize;
                let mut fault = None;
                self.visit_scalars(arguments, |value| {
                    if fault.is_some() {
                        return;
                    }
                    match text(value) {
                        Ok(value) => {
                            units = units.saturating_add(value.encode_utf16().count());
                            if units > self.limits.max_result_utf16_units {
                                fault = Some(FormulaError::Calculation);
                            } else {
                                output.push_str(&value);
                            }
                        }
                        Err(error) => fault = Some(error),
                    }
                });
                if units > self.limits.max_result_utf16_units {
                    return Err(FormulaEngineError::Limit {
                        resource: "formula result UTF-16 units",
                        actual: units,
                        maximum: self.limits.max_result_utf16_units,
                    });
                }
                fault.map_or(CellValue::Text(output), CellValue::Error)
            }
            FormulaFunction::Date => {
                let year = numeric_integer(&scalar(0, finite_number(1900.0)));
                let month = numeric_integer(&scalar(1, finite_number(1.0)));
                let day = numeric_integer(&scalar(2, finite_number(1.0)));
                match (year, month, day) {
                    (Ok(year), Ok(month), Ok(day)) => date_value(year, month, day)
                        .map_or(CellValue::Error(FormulaError::Number), CellValue::Date),
                    (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => {
                        CellValue::Error(error)
                    }
                }
            }
            FormulaFunction::Year | FormulaFunction::Month | FormulaFunction::Day => {
                let input = scalar(0, CellValue::Empty);
                let (year, month, day) = if let CellValue::Date(value) = &input {
                    value.utc_date()
                } else {
                    let serial = match numeric(&input) {
                        Ok(value) => value,
                        Err(error) => return Ok(Evaluation::scalar(CellValue::Error(error))),
                    };
                    let days = serial.floor() - 25_569.0;
                    if !days.is_finite() || days.abs() > 365_242_500.0 {
                        return Ok(Evaluation::scalar(CellValue::Error(FormulaError::Number)));
                    }
                    civil_from_days(days as i64)
                };
                finite_number(match function {
                    FormulaFunction::Year => year as f64,
                    FormulaFunction::Month => month as f64,
                    FormulaFunction::Day => day as f64,
                    _ => unreachable!(),
                })
            }
            FormulaFunction::Index => {
                let row = numeric_integer(&scalar(1, finite_number(1.0)));
                let column = numeric_integer(&scalar(2, finite_number(1.0)));
                match (arguments.first(), row, column) {
                    (Some(argument), Ok(row), Ok(column)) if row >= 1 && column >= 1 => {
                        let row = usize::try_from(row - 1);
                        let column = usize::try_from(column - 1);
                        match (row, column) {
                            (Ok(row), Ok(column)) => self
                                .matrix_value(argument, row, column)
                                .unwrap_or(CellValue::Error(FormulaError::Reference)),
                            _ => CellValue::Error(FormulaError::Reference),
                        }
                    }
                    (_, Err(error), _) | (_, _, Err(error)) => CellValue::Error(error),
                    _ => CellValue::Error(FormulaError::Reference),
                }
            }
            FormulaFunction::Match => {
                let wanted = scalar(0, CellValue::Empty);
                if let CellValue::Error(error) = wanted {
                    return Ok(Evaluation::scalar(CellValue::Error(error)));
                }
                if let Some(mode) = arguments.get(2) {
                    let mode = match numeric_integer(&mode.scalar) {
                        Ok(mode) => mode,
                        Err(error) => return Ok(Evaluation::scalar(CellValue::Error(error))),
                    };
                    if mode != 0 {
                        return Ok(Evaluation::scalar(CellValue::Error(
                            FormulaError::NotAvailable,
                        )));
                    }
                }
                let Some(haystack) = arguments.get(1) else {
                    return Ok(Evaluation::scalar(CellValue::Error(
                        FormulaError::NotAvailable,
                    )));
                };
                let mut found = None;
                let mut fault = None;
                self.visit_scalar(haystack, |index, value| {
                    if found.is_some() || fault.is_some() {
                        return;
                    }
                    match lookup_equal(value, &wanted) {
                        Ok(true) => found = Some(index + 1),
                        Ok(false) => {}
                        Err(error) => fault = Some(error),
                    }
                });
                fault.map_or_else(
                    || {
                        found.map_or(CellValue::Error(FormulaError::NotAvailable), |index| {
                            finite_number(index as f64)
                        })
                    },
                    CellValue::Error,
                )
            }
            FormulaFunction::XLookup => {
                let wanted = scalar(0, CellValue::Empty);
                if let CellValue::Error(error) = wanted {
                    return Ok(Evaluation::scalar(CellValue::Error(error)));
                }
                if let Some(mode) = arguments.get(4) {
                    let mode = match numeric_integer(&mode.scalar) {
                        Ok(mode) => mode,
                        Err(error) => return Ok(Evaluation::scalar(CellValue::Error(error))),
                    };
                    if mode != 0 {
                        return Ok(Evaluation::scalar(CellValue::Error(
                            FormulaError::NotAvailable,
                        )));
                    }
                }
                if let Some(mode) = arguments.get(5) {
                    let mode = match numeric_integer(&mode.scalar) {
                        Ok(mode) => mode,
                        Err(error) => return Ok(Evaluation::scalar(CellValue::Error(error))),
                    };
                    if mode != 1 {
                        return Ok(Evaluation::scalar(CellValue::Error(FormulaError::Value)));
                    }
                }
                let Some(keys) = arguments.get(1) else {
                    return Ok(Evaluation::scalar(scalar(
                        3,
                        CellValue::Error(FormulaError::NotAvailable),
                    )));
                };
                let values = arguments.get(2);
                let mut found = None;
                let mut fault = None;
                self.visit_scalar(keys, |index, value| {
                    if found.is_some() || fault.is_some() {
                        return;
                    }
                    match lookup_equal(value, &wanted) {
                        Ok(true) => found = Some(index),
                        Ok(false) => {}
                        Err(error) => fault = Some(error),
                    }
                });
                if let Some(error) = fault {
                    CellValue::Error(error)
                } else {
                    found
                        .and_then(|index| values.and_then(|values| self.flat_value(values, index)))
                        .unwrap_or_else(|| scalar(3, CellValue::Error(FormulaError::NotAvailable)))
                }
            }
            FormulaFunction::Unknown(_) => CellValue::Error(FormulaError::Name),
        };
        self.bound_formula_value(&value)?;
        Ok(Evaluation::scalar(value))
    }

    fn visit_scalars(&self, arguments: &[Evaluation], mut visitor: impl FnMut(&CellValue)) {
        for argument in arguments {
            self.visit_scalar(argument, |_index, value| visitor(value));
        }
    }

    fn visit_scalar(&self, value: &Evaluation, mut visitor: impl FnMut(usize, &CellValue)) {
        match value.kind {
            EvaluatedValue::Scalar | EvaluatedValue::Reference => visitor(0, &value.scalar),
            EvaluatedValue::Range(range_id) => {
                for (index, node_id) in self.ranges.get(range_id).nodes.iter().enumerate() {
                    visitor(index, self.calculated_value(*node_id));
                }
            }
        }
    }

    fn flat_value(&self, value: &Evaluation, index: usize) -> Option<CellValue> {
        match value.kind {
            EvaluatedValue::Scalar | EvaluatedValue::Reference if index == 0 => {
                Some(value.scalar.clone())
            }
            EvaluatedValue::Scalar | EvaluatedValue::Reference => None,
            EvaluatedValue::Range(range_id) => self
                .ranges
                .get(range_id)
                .nodes
                .get(index)
                .map(|node_id| self.calculated_value(*node_id).clone()),
        }
    }

    fn matrix_value(&self, value: &Evaluation, row: usize, column: usize) -> Option<CellValue> {
        match value.kind {
            EvaluatedValue::Scalar | EvaluatedValue::Reference if row == 0 && column == 0 => {
                Some(value.scalar.clone())
            }
            EvaluatedValue::Scalar | EvaluatedValue::Reference => None,
            EvaluatedValue::Range(range_id) => {
                let range = self.ranges.get(range_id);
                if row >= range.rows as usize || column >= range.columns as usize {
                    return None;
                }
                let index = row * range.columns as usize + column;
                range
                    .nodes
                    .get(index)
                    .map(|node_id| self.calculated_value(*node_id).clone())
            }
        }
    }

    fn bounded_text(&self, value: String) -> Result<CellValue, FormulaEngineError> {
        let actual = value.encode_utf16().count();
        if actual > self.limits.max_result_utf16_units {
            return Err(FormulaEngineError::Limit {
                resource: "formula result UTF-16 units",
                actual,
                maximum: self.limits.max_result_utf16_units,
            });
        }
        Ok(CellValue::Text(value))
    }
}

fn checked_add(
    resource: &'static str,
    current: usize,
    count: usize,
    maximum: usize,
) -> Result<usize, FormulaEngineError> {
    let actual = current.saturating_add(count);
    if actual > maximum {
        return Err(FormulaEngineError::Limit {
            resource,
            actual,
            maximum,
        });
    }
    Ok(actual)
}

fn finite_number(value: f64) -> CellValue {
    Number::new(value)
        .map(CellValue::Number)
        .unwrap_or(CellValue::Error(FormulaError::Number))
}

fn numeric(value: &CellValue) -> Result<f64, FormulaError> {
    match value {
        CellValue::Empty => Ok(0.0),
        CellValue::Boolean(false) => Ok(0.0),
        CellValue::Boolean(true) => Ok(1.0),
        CellValue::Number(value) => Ok(value.get()),
        CellValue::Date(value) => Ok(value.excel_serial()),
        CellValue::Text(value) => {
            let value = value.trim();
            if value.is_empty() {
                return Ok(0.0);
            }
            value
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite())
                .ok_or(FormulaError::Value)
        }
        CellValue::Error(error) => Err(error.clone()),
    }
}

fn numeric_integer(value: &CellValue) -> Result<i64, FormulaError> {
    let value = numeric(value)?;
    if !value.is_finite() || value < i64::MIN as f64 || value > i64::MAX as f64 {
        return Err(FormulaError::Number);
    }
    Ok(value.trunc() as i64)
}

fn numeric_for_aggregate(value: &CellValue) -> Result<Option<f64>, FormulaError> {
    match value {
        CellValue::Empty | CellValue::Boolean(_) => Ok(None),
        CellValue::Number(value) => Ok(Some(value.get())),
        CellValue::Date(value) => Ok(Some(value.excel_serial())),
        CellValue::Text(value) => Ok(value
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite())),
        CellValue::Error(error) => Err(error.clone()),
    }
}

fn text(value: &CellValue) -> Result<String, FormulaError> {
    match value {
        CellValue::Empty => Ok(String::new()),
        CellValue::Boolean(value) => Ok(if *value { "true" } else { "false" }.to_owned()),
        CellValue::Number(value) => Ok(value.get().to_string()),
        CellValue::Date(value) => Ok(value.to_iso_string()),
        CellValue::Text(value) => Ok(value.clone()),
        CellValue::Error(error) => Err(error.clone()),
    }
}

fn truthy(value: &CellValue) -> Result<bool, FormulaError> {
    match value {
        CellValue::Empty => Ok(false),
        CellValue::Boolean(value) => Ok(*value),
        CellValue::Number(value) => Ok(value.get() != 0.0),
        CellValue::Date(_) => Ok(true),
        CellValue::Text(value) => Ok(!value.is_empty()),
        CellValue::Error(error) => Err(error.clone()),
    }
}

fn unary_numeric(value: &CellValue, operation: fn(f64) -> f64) -> CellValue {
    numeric(value)
        .map(operation)
        .map_or_else(CellValue::Error, finite_number)
}

fn binary_numeric(
    left: &CellValue,
    right: &CellValue,
    operation: fn(f64, f64) -> f64,
) -> CellValue {
    match (numeric(left), numeric(right)) {
        (Ok(left), Ok(right)) => finite_number(operation(left, right)),
        (Err(error), _) | (_, Err(error)) => CellValue::Error(error),
    }
}

fn valid_argument_count(function: FormulaFunction, count: usize) -> bool {
    match function {
        FormulaFunction::Sum
        | FormulaFunction::Average
        | FormulaFunction::Min
        | FormulaFunction::Max
        | FormulaFunction::Count
        | FormulaFunction::CountA
        | FormulaFunction::And
        | FormulaFunction::Or
        | FormulaFunction::Concat => true,
        FormulaFunction::If => (2..=3).contains(&count),
        FormulaFunction::IfError | FormulaFunction::Power => count == 2,
        FormulaFunction::Not
        | FormulaFunction::Abs
        | FormulaFunction::Sqrt
        | FormulaFunction::Len
        | FormulaFunction::Lower
        | FormulaFunction::Upper
        | FormulaFunction::Trim
        | FormulaFunction::Year
        | FormulaFunction::Month
        | FormulaFunction::Day => count == 1,
        FormulaFunction::Round | FormulaFunction::RoundUp | FormulaFunction::RoundDown => {
            (1..=2).contains(&count)
        }
        FormulaFunction::Left | FormulaFunction::Right => (1..=2).contains(&count),
        FormulaFunction::Mid => (2..=3).contains(&count),
        FormulaFunction::Date => count == 3,
        FormulaFunction::Index | FormulaFunction::Match => (2..=3).contains(&count),
        FormulaFunction::XLookup => (3..=6).contains(&count),
        FormulaFunction::Unknown(_) => false,
    }
}

fn compare_values(
    left: &CellValue,
    right: &CellValue,
    operator: BinaryOperator,
) -> Result<bool, FormulaError> {
    if let CellValue::Error(error) = left {
        return Err(error.clone());
    }
    if let CellValue::Error(error) = right {
        return Err(error.clone());
    }
    if operator == BinaryOperator::Equal || operator == BinaryOperator::NotEqual {
        let equal = match (left, right) {
            (CellValue::Empty, CellValue::Empty) => true,
            (CellValue::Boolean(left), CellValue::Boolean(right)) => left == right,
            (CellValue::Number(left), CellValue::Number(right)) => left == right,
            (CellValue::Date(left), CellValue::Date(right)) => left == right,
            (CellValue::Text(left), CellValue::Text(right)) => left
                .chars()
                .flat_map(char::to_lowercase)
                .eq(right.chars().flat_map(char::to_lowercase)),
            (CellValue::Error(left), CellValue::Error(right)) => left == right,
            _ => false,
        };
        return Ok(if operator == BinaryOperator::Equal {
            equal
        } else {
            !equal
        });
    }

    let ordering = match (left, right) {
        (CellValue::Text(left), CellValue::Text(right)) => left
            .chars()
            .flat_map(char::to_lowercase)
            .cmp(right.chars().flat_map(char::to_lowercase)),
        _ => numeric(left)?
            .partial_cmp(&numeric(right)?)
            .unwrap_or(Ordering::Equal),
    };
    Ok(match operator {
        BinaryOperator::Less => ordering == Ordering::Less,
        BinaryOperator::Greater => ordering == Ordering::Greater,
        BinaryOperator::LessOrEqual => ordering != Ordering::Greater,
        BinaryOperator::GreaterOrEqual => ordering != Ordering::Less,
        _ => false,
    })
}

fn lookup_equal(left: &CellValue, right: &CellValue) -> Result<bool, FormulaError> {
    compare_values(left, right, BinaryOperator::Equal)
}

fn date_value(year: i64, month: i64, day: i64) -> Option<DateValue> {
    // Match JavaScript Date.UTC normalization used by the TypeScript reference
    // engine while keeping the calculation deterministic and clock-free.
    let year = if (0..=99).contains(&year) {
        year.checked_add(1_900)?
    } else {
        year
    };
    let month_zero_based = month.checked_sub(1)?;
    let normalized_year = year.checked_add(month_zero_based.div_euclid(12))?;
    // JavaScript Date (the TypeScript reference) is bounded to +/-100M days.
    // This tighter civil-year check also makes every integer operation below
    // provably safe on debug, release, native, and wasm32 builds.
    if !(-271_821..=275_760).contains(&normalized_year) {
        return None;
    }
    let normalized_month = month_zero_based.rem_euclid(12).checked_add(1)?;
    let first = days_from_civil(normalized_year, normalized_month, 1);
    let days = first.checked_add(day.checked_sub(1)?)?;
    DateValue::from_unix_days(days).ok()
}

// Howard Hinnant's proleptic Gregorian algorithms, with Unix epoch day zero.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    (year + i64::from(month <= 2), month, day)
}
