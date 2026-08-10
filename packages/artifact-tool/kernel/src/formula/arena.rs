use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::Arc;

use super::{FormulaEngineError, FormulaFunction, NodeId};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(super) struct ExprId(pub(super) u32);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(super) struct RangeId(pub(super) u32);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(super) struct StringId(pub(super) u32);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(super) enum ConstantError {
    DivideByZero,
    Value,
    Reference,
    Name,
    Number,
    NotAvailable,
    Custom(StringId),
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(super) enum ConstantValue {
    Boolean(bool),
    Number(u64),
    Text(StringId),
    Error(ConstantError),
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(super) enum UnaryOperator {
    Plus,
    Minus,
    Percent,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(super) enum BinaryOperator {
    Add,
    Subtract,
    Multiply,
    Divide,
    Power,
    Concatenate,
    Equal,
    NotEqual,
    Less,
    Greater,
    LessOrEqual,
    GreaterOrEqual,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(super) enum ExprNode {
    Constant(ConstantValue),
    Reference(NodeId),
    Range(RangeId),
    Unary {
        operator: UnaryOperator,
        operand: ExprId,
    },
    Binary {
        operator: BinaryOperator,
        left: ExprId,
        right: ExprId,
    },
    Sequence {
        first: ExprId,
        rest: Box<[(BinaryOperator, ExprId)]>,
    },
    Call {
        function: FormulaFunction,
        arguments: Box<[ExprId]>,
    },
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(super) struct CompiledRange {
    pub(super) rows: u32,
    pub(super) columns: u32,
    pub(super) nodes: Box<[NodeId]>,
}

#[derive(Clone, Debug, Default)]
pub(super) struct StringInterner {
    values: Vec<Arc<str>>,
    ids: HashMap<Arc<str>, StringId>,
    utf8_bytes: usize,
}

impl StringInterner {
    pub(super) fn intern(
        &mut self,
        value: &str,
        maximum_utf8_bytes: usize,
    ) -> Result<StringId, FormulaEngineError> {
        if let Some(id) = self.ids.get(value) {
            return Ok(*id);
        };
        let actual = self.utf8_bytes.saturating_add(value.len());
        if actual > maximum_utf8_bytes {
            return Err(FormulaEngineError::Limit {
                resource: "formula interned UTF-8 bytes",
                actual,
                maximum: maximum_utf8_bytes,
            });
        }
        let id =
            StringId(
                u32::try_from(self.values.len()).map_err(|_| FormulaEngineError::Limit {
                    resource: "formula interned strings",
                    actual: self.values.len().saturating_add(1),
                    maximum: u32::MAX as usize,
                })?,
            );
        let value: Arc<str> = Arc::from(value);
        self.utf8_bytes = actual;
        self.values.push(value.clone());
        self.ids.insert(value, id);
        Ok(id)
    }

    pub(super) fn resolve(&self, id: StringId) -> &str {
        &self.values[id.0 as usize]
    }

    pub(super) fn len(&self) -> usize {
        self.values.len()
    }

    pub(super) fn allocation_facts(&self) -> (usize, usize, usize) {
        (self.values.capacity(), self.ids.capacity(), self.utf8_bytes)
    }

    pub(super) fn checkpoint(&self) -> usize {
        self.values.len()
    }

    pub(super) fn rollback(&mut self, checkpoint: usize) {
        while self.values.len() > checkpoint {
            let value = self.values.pop().expect("string checkpoint");
            self.utf8_bytes = self.utf8_bytes.saturating_sub(value.len());
            self.ids.remove(&value);
        }
    }
}

#[derive(Clone, Debug, Default)]
pub(super) struct ExprArena {
    nodes: Vec<ExprNode>,
    ids: HashMap<u64, ExprId>,
}

impl ExprArena {
    pub(super) fn intern(
        &mut self,
        node: ExprNode,
        maximum: usize,
    ) -> Result<ExprId, FormulaEngineError> {
        let mut probe = 0u64;
        let fingerprint = loop {
            let fingerprint = fingerprint(&node, probe);
            match self.ids.get(&fingerprint).copied() {
                Some(id) if self.nodes[id.0 as usize] == node => return Ok(id),
                Some(_) => probe = probe.saturating_add(1),
                None => break fingerprint,
            }
        };
        let actual = self.nodes.len().saturating_add(1);
        if actual > maximum || actual > u32::MAX as usize {
            return Err(FormulaEngineError::Limit {
                resource: "formula AST nodes",
                actual,
                maximum: maximum.min(u32::MAX as usize),
            });
        }
        let id = ExprId(self.nodes.len() as u32);
        self.nodes.push(node);
        self.ids.insert(fingerprint, id);
        Ok(id)
    }

    pub(super) fn get(&self, id: ExprId) -> &ExprNode {
        &self.nodes[id.0 as usize]
    }

    pub(super) fn len(&self) -> usize {
        self.nodes.len()
    }

    pub(super) fn allocation_facts(&self) -> (usize, usize, usize, usize) {
        let call_argument_slots = self
            .nodes
            .iter()
            .map(|node| match node {
                ExprNode::Call { arguments, .. } => arguments.len(),
                _ => 0,
            })
            .sum();
        let sequence_operand_slots = self
            .nodes
            .iter()
            .map(|node| match node {
                ExprNode::Sequence { rest, .. } => rest.len(),
                _ => 0,
            })
            .sum();
        (
            self.nodes.capacity(),
            self.ids.capacity(),
            call_argument_slots,
            sequence_operand_slots,
        )
    }

    pub(super) fn checkpoint(&self) -> usize {
        self.nodes.len()
    }

    pub(super) fn rollback(&mut self, checkpoint: usize) {
        while self.nodes.len() > checkpoint {
            let node = self.nodes.pop().expect("expression checkpoint");
            let mut probe = 0u64;
            loop {
                let fingerprint = fingerprint(&node, probe);
                match self.ids.get(&fingerprint).copied() {
                    Some(id) if id.0 as usize == self.nodes.len() => {
                        self.ids.remove(&fingerprint);
                        break;
                    }
                    Some(_) => probe = probe.saturating_add(1),
                    None => break,
                }
            }
        }
    }
}

#[derive(Clone, Debug, Default)]
pub(super) struct RangeArena {
    ranges: Vec<CompiledRange>,
    ids: HashMap<u64, RangeId>,
}

impl RangeArena {
    pub(super) fn intern(
        &mut self,
        range: CompiledRange,
        maximum: usize,
    ) -> Result<RangeId, FormulaEngineError> {
        let mut probe = 0u64;
        let fingerprint = loop {
            let fingerprint = fingerprint(&range, probe);
            match self.ids.get(&fingerprint).copied() {
                Some(id) if self.ranges[id.0 as usize] == range => return Ok(id),
                Some(_) => probe = probe.saturating_add(1),
                None => break fingerprint,
            }
        };
        let actual = self.ranges.len().saturating_add(1);
        if actual > maximum || actual > u32::MAX as usize {
            return Err(FormulaEngineError::Limit {
                resource: "compiled formula ranges",
                actual,
                maximum: maximum.min(u32::MAX as usize),
            });
        }
        let id = RangeId(self.ranges.len() as u32);
        self.ranges.push(range);
        self.ids.insert(fingerprint, id);
        Ok(id)
    }

    pub(super) fn get(&self, id: RangeId) -> &CompiledRange {
        &self.ranges[id.0 as usize]
    }

    pub(super) fn len(&self) -> usize {
        self.ranges.len()
    }

    pub(super) fn allocation_facts(&self) -> (usize, usize, usize) {
        (
            self.ranges.capacity(),
            self.ids.capacity(),
            self.ranges.iter().map(|range| range.nodes.len()).sum(),
        )
    }

    pub(super) fn checkpoint(&self) -> usize {
        self.ranges.len()
    }

    pub(super) fn rollback(&mut self, checkpoint: usize) {
        while self.ranges.len() > checkpoint {
            let range = self.ranges.pop().expect("range checkpoint");
            let mut probe = 0u64;
            loop {
                let fingerprint = fingerprint(&range, probe);
                match self.ids.get(&fingerprint).copied() {
                    Some(id) if id.0 as usize == self.ranges.len() => {
                        self.ids.remove(&fingerprint);
                        break;
                    }
                    Some(_) => probe = probe.saturating_add(1),
                    None => break,
                }
            }
        }
    }
}

fn fingerprint(value: &impl Hash, probe: u64) -> u64 {
    let mut hasher = DefaultHasher::new();
    probe.hash(&mut hasher);
    value.hash(&mut hasher);
    hasher.finish()
}
