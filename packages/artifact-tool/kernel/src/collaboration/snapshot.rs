use core::fmt;

use super::{
    CausalDot, CausalFrontier, CollaborationCommand, CollaborationError, CollaborationOperation,
    CollaborationTransaction, CollaborativeWorkbook, KnownStatus, OperationId, ReplicaId,
    SheetGeneration, TransactionDisposition, TransactionId, MAX_CAUSAL_REPLICAS,
    MAX_CELLS_PER_TRANSACTION, MAX_OPERATIONS_PER_TRANSACTION, MAX_RETAINED_TRANSACTIONS,
};
use crate::{
    decode_snapshot, encode_snapshot, Cell, CellBlock, CellCoord, CellRange, CellValue, DateValue,
    FormulaError, Number, StableId, ValueError,
};

const MAGIC: [u8; 8] = *b"OGACRD01";
pub const COLLABORATION_SNAPSHOT_VERSION: u16 = 1;
const HEADER_BYTES: usize = 8 + 2 + 2 + 8;
const CHECKSUM_BYTES: usize = 8;
const MAX_SNAPSHOT_BYTES: usize = 512 * 1024 * 1024;
const MAX_STRING_BYTES: usize = 16 * 1024 * 1024;
const MIN_TRANSACTION_BYTES: usize = 1 + 16 + 8 + 8 + 4 + 4;
const MIN_OPERATION_BYTES: usize = 16 + 1 + 16;
const MIN_CELL_BYTES: usize = 2;

/// Exact number of bytes one retained transaction occupies in the v1 payload,
/// including its applied/deferred status byte. This intentionally runs the
/// canonical encoder in count-only mode: admission control and persistence can
/// therefore never drift onto subtly different size calculations.
pub(super) fn retained_transaction_wire_bytes(
    transaction: &CollaborationTransaction,
) -> Result<usize, CollaborationSnapshotError> {
    let mut encoder = Encoder::sizing();
    encoder.u8(0);
    encoder.transaction(transaction)?;
    if encoder.overflowed {
        Err(CollaborationSnapshotError::SizeLimit)
    } else {
        Ok(encoder.encoded_len)
    }
}

pub fn encode_collaboration_snapshot(
    workbook: &CollaborativeWorkbook,
) -> Result<Vec<u8>, CollaborationSnapshotError> {
    if workbook.retained_history_bytes > CollaborativeWorkbook::MAX_RETAINED_HISTORY_BYTES {
        return Err(CollaborationSnapshotError::SizeLimit);
    }
    let mut payload = Encoder::default();
    payload.u64(workbook.model_namespace);
    payload.frontier(&workbook.frontier)?;

    let materialized = encode_snapshot(&workbook.workbook)
        .map_err(|_| CollaborationSnapshotError::InvalidModel("materialized snapshot failed"))?;
    payload.bytes(&materialized)?;

    if workbook.dot_owners.len() > MAX_RETAINED_TRANSACTIONS {
        return Err(CollaborationSnapshotError::SizeLimit);
    }
    payload.count(workbook.dot_owners.len())?;
    let mut retained_history_bytes = 0usize;
    for (dot, transaction_id) in &workbook.dot_owners {
        let known = workbook.known_transactions.get(transaction_id).ok_or(
            CollaborationSnapshotError::InvalidModel("dot owner has no transaction"),
        )?;
        if known.transaction.dot() != *dot {
            return Err(CollaborationSnapshotError::InvalidModel(
                "dot owner does not match transaction",
            ));
        }
        let history_start = payload.encoded_len;
        payload.u8(match known.status {
            KnownStatus::Applied => 1,
            KnownStatus::Deferred => 0,
        });
        payload.transaction(&known.transaction)?;
        let encoded_bytes = payload.encoded_len.checked_sub(history_start).ok_or(
            CollaborationSnapshotError::InvalidModel("retained history byte accounting underflow"),
        )?;
        if encoded_bytes != known.retained_bytes {
            return Err(CollaborationSnapshotError::InvalidModel(
                "retained transaction byte accounting does not match",
            ));
        }
        retained_history_bytes = retained_history_bytes
            .checked_add(encoded_bytes)
            .ok_or(CollaborationSnapshotError::SizeLimit)?;
    }
    if retained_history_bytes != workbook.retained_history_bytes {
        return Err(CollaborationSnapshotError::InvalidModel(
            "retained history byte accounting does not match",
        ));
    }

    if payload.overflowed || payload.bytes.len() > MAX_SNAPSHOT_BYTES {
        return Err(CollaborationSnapshotError::SizeLimit);
    }
    let payload_len =
        u64::try_from(payload.bytes.len()).map_err(|_| CollaborationSnapshotError::SizeLimit)?;
    let checksum = checksum(&payload.bytes);
    let capacity = HEADER_BYTES
        .checked_add(payload.bytes.len())
        .and_then(|value| value.checked_add(CHECKSUM_BYTES))
        .ok_or(CollaborationSnapshotError::SizeLimit)?;
    let mut output = Vec::with_capacity(capacity);
    output.extend_from_slice(&MAGIC);
    output.extend_from_slice(&COLLABORATION_SNAPSHOT_VERSION.to_le_bytes());
    output.extend_from_slice(&0u16.to_le_bytes());
    output.extend_from_slice(&payload_len.to_le_bytes());
    output.extend_from_slice(&payload.bytes);
    output.extend_from_slice(&checksum.to_le_bytes());
    Ok(output)
}

pub fn decode_collaboration_snapshot(
    bytes: &[u8],
) -> Result<CollaborativeWorkbook, CollaborationSnapshotError> {
    if bytes.len() < HEADER_BYTES + CHECKSUM_BYTES {
        return Err(CollaborationSnapshotError::Truncated);
    }
    if bytes.len() > MAX_SNAPSHOT_BYTES + HEADER_BYTES + CHECKSUM_BYTES {
        return Err(CollaborationSnapshotError::SizeLimit);
    }
    if bytes[..8] != MAGIC {
        return Err(CollaborationSnapshotError::BadMagic);
    }
    let version = u16::from_le_bytes([bytes[8], bytes[9]]);
    if version != COLLABORATION_SNAPSHOT_VERSION {
        return Err(CollaborationSnapshotError::UnsupportedVersion(version));
    }
    if u16::from_le_bytes([bytes[10], bytes[11]]) != 0 {
        return Err(CollaborationSnapshotError::NonCanonical(
            "reserved header bits are set",
        ));
    }
    let payload_len = u64::from_le_bytes(
        bytes[12..20]
            .try_into()
            .map_err(|_| CollaborationSnapshotError::Truncated)?,
    );
    let payload_len =
        usize::try_from(payload_len).map_err(|_| CollaborationSnapshotError::SizeLimit)?;
    if payload_len > MAX_SNAPSHOT_BYTES {
        return Err(CollaborationSnapshotError::SizeLimit);
    }
    let expected_len = HEADER_BYTES
        .checked_add(payload_len)
        .and_then(|value| value.checked_add(CHECKSUM_BYTES))
        .ok_or(CollaborationSnapshotError::SizeLimit)?;
    if bytes.len() != expected_len {
        return Err(if bytes.len() < expected_len {
            CollaborationSnapshotError::Truncated
        } else {
            CollaborationSnapshotError::TrailingBytes
        });
    }
    let payload_end = HEADER_BYTES + payload_len;
    let payload = &bytes[HEADER_BYTES..payload_end];
    let expected_checksum = u64::from_le_bytes(
        bytes[payload_end..]
            .try_into()
            .map_err(|_| CollaborationSnapshotError::Truncated)?,
    );
    if checksum(payload) != expected_checksum {
        return Err(CollaborationSnapshotError::ChecksumMismatch);
    }

    let mut decoder = Decoder::new(payload);
    let model_namespace = decoder.u64()?;
    let expected_frontier = decoder.frontier()?;
    let materialized_bytes = decoder.bytes(MAX_SNAPSHOT_BYTES)?;
    let expected_materialized = decode_snapshot(materialized_bytes).map_err(|_| {
        CollaborationSnapshotError::InvalidModel("embedded materialized snapshot is invalid")
    })?;
    let canonical_materialized = encode_snapshot(&expected_materialized).map_err(|_| {
        CollaborationSnapshotError::InvalidModel("embedded materialized snapshot failed to encode")
    })?;
    if canonical_materialized != materialized_bytes {
        return Err(CollaborationSnapshotError::NonCanonical(
            "embedded materialized snapshot is not canonical",
        ));
    }
    drop(canonical_materialized);
    drop(expected_materialized);
    let transaction_count = decoder.count(MAX_RETAINED_TRANSACTIONS)?;
    if transaction_count > decoder.remaining() / MIN_TRANSACTION_BYTES {
        return Err(CollaborationSnapshotError::Truncated);
    }
    let mut encoded = Vec::new();
    encoded
        .try_reserve_exact(transaction_count)
        .map_err(|_| CollaborationSnapshotError::SizeLimit)?;
    let mut previous_dot = None;
    for _ in 0..transaction_count {
        let expected_status = match decoder.u8()? {
            0 => KnownStatus::Deferred,
            1 => KnownStatus::Applied,
            value => return Err(CollaborationSnapshotError::InvalidTag(value)),
        };
        let transaction = decoder.transaction()?;
        if previous_dot.is_some_and(|previous| transaction.dot() <= previous) {
            return Err(CollaborationSnapshotError::NonCanonical(
                "transactions are not strictly dot-ordered",
            ));
        }
        previous_dot = Some(transaction.dot());
        encoded.push(Some((expected_status, transaction)));
    }
    if !decoder.is_empty() {
        return Err(CollaborationSnapshotError::TrailingBytes);
    }

    let workbook = restore_transactions(model_namespace, encoded)?;
    if workbook.frontier != expected_frontier {
        return Err(CollaborationSnapshotError::InvalidModel(
            "causal frontier does not reconstruct",
        ));
    }
    let actual_materialized = encode_snapshot(&workbook.workbook).map_err(|_| {
        CollaborationSnapshotError::InvalidModel("reconstructed materialized snapshot failed")
    })?;
    if actual_materialized != materialized_bytes {
        return Err(CollaborationSnapshotError::InvalidModel(
            "materialized model does not reconstruct",
        ));
    }
    Ok(workbook)
}

fn restore_transactions(
    model_namespace: u64,
    mut encoded: Vec<Option<(KnownStatus, CollaborationTransaction)>>,
) -> Result<CollaborativeWorkbook, CollaborationSnapshotError> {
    let applied_count = encoded
        .iter()
        .filter(|entry| {
            entry
                .as_ref()
                .is_some_and(|(status, _)| *status == KnownStatus::Applied)
        })
        .count();
    let deferred_count = encoded.len().saturating_sub(applied_count);
    let mut deferred = Vec::new();
    deferred
        .try_reserve_exact(deferred_count)
        .map_err(|_| CollaborationSnapshotError::SizeLimit)?;
    let mut total_dependencies = 0usize;
    for (index, entry) in encoded.iter().enumerate() {
        let (status, transaction) =
            entry
                .as_ref()
                .ok_or(CollaborationSnapshotError::InvalidModel(
                    "decoded transaction slot is empty",
                ))?;
        match status {
            KnownStatus::Applied => {
                total_dependencies = total_dependencies
                    .checked_add(transaction.base().len())
                    .ok_or(CollaborationSnapshotError::SizeLimit)?;
            }
            KnownStatus::Deferred => deferred.push(index),
        }
    }

    let mut remaining_dependencies = Vec::new();
    remaining_dependencies
        .try_reserve_exact(encoded.len())
        .map_err(|_| CollaborationSnapshotError::SizeLimit)?;
    remaining_dependencies.resize(encoded.len(), 0u32);
    let mut first_waiter = Vec::new();
    first_waiter
        .try_reserve_exact(encoded.len())
        .map_err(|_| CollaborationSnapshotError::SizeLimit)?;
    first_waiter.resize(encoded.len(), None::<usize>);
    let mut waiter_edges = Vec::new();
    waiter_edges
        .try_reserve_exact(total_dependencies)
        .map_err(|_| CollaborationSnapshotError::SizeLimit)?;
    let mut ready = Vec::new();
    ready
        .try_reserve_exact(applied_count)
        .map_err(|_| CollaborationSnapshotError::SizeLimit)?;
    for index in 0..encoded.len() {
        let (status, transaction) =
            encoded[index]
                .as_ref()
                .ok_or(CollaborationSnapshotError::InvalidModel(
                    "decoded transaction slot is empty",
                ))?;
        if *status != KnownStatus::Applied {
            continue;
        }
        for (replica, counter) in transaction.base().iter() {
            let dependency = CausalDot::new(replica, counter)
                .map_err(CollaborationSnapshotError::Collaboration)?;
            let dependency_index = encoded
                .binary_search_by(|candidate| {
                    candidate
                        .as_ref()
                        .map_or(core::cmp::Ordering::Less, |(_, candidate)| {
                            candidate.dot().cmp(&dependency)
                        })
                })
                .map_err(|_| {
                    CollaborationSnapshotError::InvalidModel(
                        "applied transaction depends on absent work",
                    )
                })?;
            if encoded[dependency_index]
                .as_ref()
                .is_none_or(|(status, _)| *status != KnownStatus::Applied)
            {
                return Err(CollaborationSnapshotError::InvalidModel(
                    "applied transaction depends on absent or deferred work",
                ));
            }
            remaining_dependencies[index] = remaining_dependencies[index]
                .checked_add(1)
                .ok_or(CollaborationSnapshotError::SizeLimit)?;
            let edge_index = waiter_edges.len();
            waiter_edges.push((index, first_waiter[dependency_index]));
            first_waiter[dependency_index] = Some(edge_index);
        }
        if remaining_dependencies[index] == 0 {
            ready.push(index);
        }
    }

    let mut workbook = CollaborativeWorkbook::new(model_namespace)
        .map_err(CollaborationSnapshotError::Collaboration)?;
    let mut restored_applied = 0usize;
    let mut ready_cursor = 0usize;
    while let Some(index) = ready.get(ready_cursor).copied() {
        ready_cursor += 1;
        let (_, transaction) =
            encoded[index]
                .take()
                .ok_or(CollaborationSnapshotError::InvalidModel(
                    "applied transaction restored twice",
                ))?;
        let receipt = workbook
            .restore_transaction(transaction)
            .map_err(CollaborationSnapshotError::Collaboration)?;
        if receipt.disposition != TransactionDisposition::Applied
            || receipt.newly_applied.len() != 1
        {
            return Err(CollaborationSnapshotError::InvalidModel(
                "applied transaction did not restore directly",
            ));
        }
        restored_applied = restored_applied
            .checked_add(1)
            .ok_or(CollaborationSnapshotError::SizeLimit)?;
        let mut edge = first_waiter[index];
        while let Some(edge_index) = edge {
            let (waiter, next) = waiter_edges[edge_index];
            remaining_dependencies[waiter] = remaining_dependencies[waiter].checked_sub(1).ok_or(
                CollaborationSnapshotError::InvalidModel("causal restore dependency underflow"),
            )?;
            if remaining_dependencies[waiter] == 0 {
                ready.push(waiter);
            }
            edge = next;
        }
    }
    if restored_applied != applied_count {
        return Err(CollaborationSnapshotError::InvalidModel(
            "applied transaction graph is not causal",
        ));
    }

    for index in deferred {
        let (_, transaction) =
            encoded[index]
                .take()
                .ok_or(CollaborationSnapshotError::InvalidModel(
                    "deferred transaction disappeared",
                ))?;
        let receipt = workbook
            .restore_transaction(transaction)
            .map_err(CollaborationSnapshotError::Collaboration)?;
        if receipt.disposition != TransactionDisposition::Deferred
            || !receipt.newly_applied.is_empty()
            || !receipt.rejected_deferred.is_empty()
        {
            return Err(CollaborationSnapshotError::InvalidModel(
                "deferred transaction status does not reconstruct",
            ));
        }
    }
    workbook
        .finish_restore_materialization()
        .map_err(CollaborationSnapshotError::Collaboration)?;
    Ok(workbook)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CollaborationSnapshotError {
    BadMagic,
    UnsupportedVersion(u16),
    Truncated,
    TrailingBytes,
    ChecksumMismatch,
    SizeLimit,
    InvalidUtf8,
    InvalidTag(u8),
    InvalidNumber(ValueError),
    InvalidDate(ValueError),
    NonCanonical(&'static str),
    InvalidModel(&'static str),
    Collaboration(CollaborationError),
}

impl fmt::Display for CollaborationSnapshotError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadMagic => formatter.write_str("invalid collaboration snapshot magic"),
            Self::UnsupportedVersion(version) => {
                write!(
                    formatter,
                    "unsupported collaboration snapshot version {version}"
                )
            }
            Self::Truncated => formatter.write_str("collaboration snapshot is truncated"),
            Self::TrailingBytes => formatter.write_str("collaboration snapshot has trailing bytes"),
            Self::ChecksumMismatch => {
                formatter.write_str("collaboration snapshot checksum mismatch")
            }
            Self::SizeLimit => formatter.write_str("collaboration snapshot exceeds a safety bound"),
            Self::InvalidUtf8 => {
                formatter.write_str("collaboration snapshot contains invalid UTF-8")
            }
            Self::InvalidTag(tag) => {
                write!(formatter, "collaboration snapshot has invalid tag {tag}")
            }
            Self::InvalidNumber(error) => error.fmt(formatter),
            Self::InvalidDate(error) => error.fmt(formatter),
            Self::NonCanonical(message) => {
                write!(formatter, "non-canonical collaboration snapshot: {message}")
            }
            Self::InvalidModel(message) => {
                write!(formatter, "invalid collaboration model: {message}")
            }
            Self::Collaboration(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for CollaborationSnapshotError {}

struct Encoder {
    bytes: Vec<u8>,
    encoded_len: usize,
    materialize: bool,
    overflowed: bool,
}

impl Default for Encoder {
    fn default() -> Self {
        Self {
            bytes: Vec::new(),
            encoded_len: 0,
            materialize: true,
            overflowed: false,
        }
    }
}

impl Encoder {
    const fn sizing() -> Self {
        Self {
            bytes: Vec::new(),
            encoded_len: 0,
            materialize: false,
            overflowed: false,
        }
    }

    fn append(&mut self, value: &[u8]) {
        if self
            .encoded_len
            .checked_add(value.len())
            .is_some_and(|length| length <= MAX_SNAPSHOT_BYTES)
        {
            self.encoded_len += value.len();
            if self.materialize {
                self.bytes.extend_from_slice(value);
            }
        } else {
            self.overflowed = true;
        }
    }

    fn u8(&mut self, value: u8) {
        self.append(&[value]);
    }

    fn u32(&mut self, value: u32) {
        self.append(&value.to_le_bytes());
    }

    fn u64(&mut self, value: u64) {
        self.append(&value.to_le_bytes());
    }

    fn id(&mut self, value: StableId) {
        self.append(&value.to_le_bytes());
    }

    fn count(&mut self, value: usize) -> Result<(), CollaborationSnapshotError> {
        self.u32(u32::try_from(value).map_err(|_| CollaborationSnapshotError::SizeLimit)?);
        Ok(())
    }

    fn bytes(&mut self, value: &[u8]) -> Result<(), CollaborationSnapshotError> {
        self.count(value.len())?;
        self.append(value);
        if self.overflowed {
            Err(CollaborationSnapshotError::SizeLimit)
        } else {
            Ok(())
        }
    }

    fn string(&mut self, value: &str) -> Result<(), CollaborationSnapshotError> {
        if value.len() > MAX_STRING_BYTES {
            return Err(CollaborationSnapshotError::SizeLimit);
        }
        self.bytes(value.as_bytes())
    }

    fn frontier(&mut self, frontier: &CausalFrontier) -> Result<(), CollaborationSnapshotError> {
        self.count(frontier.iter().count())?;
        for (replica, counter) in frontier.iter() {
            self.u64(replica.get());
            self.u64(counter);
        }
        Ok(())
    }

    fn generation(&mut self, generation: SheetGeneration) {
        self.id(generation.sheet_id());
        self.id(generation.creation().stable_id());
    }

    fn transaction(
        &mut self,
        transaction: &CollaborationTransaction,
    ) -> Result<(), CollaborationSnapshotError> {
        self.id(transaction.id().stable_id());
        self.u64(transaction.dot().replica().get());
        self.u64(transaction.dot().counter());
        self.frontier(transaction.base())?;
        self.count(transaction.operations().len())?;
        for operation in transaction.operations() {
            self.id(operation.id().stable_id());
            match operation.command() {
                CollaborationCommand::CreateSheet {
                    sheet_id,
                    name,
                    after,
                } => {
                    self.u8(0);
                    self.id(*sheet_id);
                    self.string(name)?;
                    match after {
                        None => self.u8(0),
                        Some(generation) => {
                            self.u8(1);
                            self.generation(*generation);
                        }
                    }
                }
                CollaborationCommand::RenameSheet { sheet, name } => {
                    self.u8(1);
                    self.generation(*sheet);
                    self.string(name)?;
                }
                CollaborationCommand::DeleteSheet { sheet } => {
                    self.u8(2);
                    self.generation(*sheet);
                }
                CollaborationCommand::SetCells {
                    sheet,
                    anchor,
                    cells,
                } => {
                    self.u8(3);
                    self.generation(*sheet);
                    self.u32(anchor.row);
                    self.u32(anchor.column);
                    self.u32(cells.rows());
                    self.u32(cells.columns());
                    self.count(cells.cells().len())?;
                    for cell in cells.cells() {
                        self.cell(cell)?;
                    }
                }
                CollaborationCommand::ClearRange { sheet, range } => {
                    self.u8(4);
                    self.generation(*sheet);
                    self.u32(range.start.row);
                    self.u32(range.start.column);
                    self.u32(range.end.row);
                    self.u32(range.end.column);
                }
                CollaborationCommand::Undo { target } => {
                    self.u8(5);
                    self.id(target.stable_id());
                }
            }
        }
        Ok(())
    }

    fn cell(&mut self, cell: &Cell) -> Result<(), CollaborationSnapshotError> {
        match cell.formula_source() {
            None => self.u8(0),
            Some(formula) => {
                self.u8(1);
                self.string(formula)?;
            }
        }
        match cell.value() {
            CellValue::Empty => self.u8(0),
            CellValue::Boolean(false) => self.u8(1),
            CellValue::Boolean(true) => self.u8(2),
            CellValue::Number(number) => {
                self.u8(3);
                self.u64(number.get().to_bits());
            }
            CellValue::Date(value) => {
                self.u8(6);
                self.u64(value.milliseconds() as u64);
            }
            CellValue::Text(text) => {
                self.u8(4);
                self.string(text)?;
            }
            CellValue::Error(error) => {
                self.u8(5);
                self.formula_error(error)?;
            }
        }
        Ok(())
    }

    fn formula_error(&mut self, error: &FormulaError) -> Result<(), CollaborationSnapshotError> {
        let tag = match error {
            FormulaError::Null => 0,
            FormulaError::DivideByZero => 1,
            FormulaError::Value => 2,
            FormulaError::Reference => 3,
            FormulaError::Name => 4,
            FormulaError::Number => 5,
            FormulaError::NotAvailable => 6,
            FormulaError::Spill => 7,
            FormulaError::Calculation => 8,
            FormulaError::Custom(text) => {
                self.u8(9);
                self.string(text)?;
                return Ok(());
            }
        };
        self.u8(tag);
        Ok(())
    }
}

struct Decoder<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Decoder<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn is_empty(&self) -> bool {
        self.offset == self.bytes.len()
    }

    fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.offset)
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], CollaborationSnapshotError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(CollaborationSnapshotError::SizeLimit)?;
        let output = self
            .bytes
            .get(self.offset..end)
            .ok_or(CollaborationSnapshotError::Truncated)?;
        self.offset = end;
        Ok(output)
    }

    fn u8(&mut self) -> Result<u8, CollaborationSnapshotError> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, CollaborationSnapshotError> {
        Ok(u32::from_le_bytes(
            self.take(4)?
                .try_into()
                .map_err(|_| CollaborationSnapshotError::Truncated)?,
        ))
    }

    fn u64(&mut self) -> Result<u64, CollaborationSnapshotError> {
        Ok(u64::from_le_bytes(
            self.take(8)?
                .try_into()
                .map_err(|_| CollaborationSnapshotError::Truncated)?,
        ))
    }

    fn id(&mut self) -> Result<StableId, CollaborationSnapshotError> {
        let bytes: [u8; 16] = self
            .take(16)?
            .try_into()
            .map_err(|_| CollaborationSnapshotError::Truncated)?;
        Ok(StableId::from_le_bytes(bytes))
    }

    fn count(&mut self, maximum: usize) -> Result<usize, CollaborationSnapshotError> {
        let count = self.u32()? as usize;
        if count > maximum {
            return Err(CollaborationSnapshotError::SizeLimit);
        }
        Ok(count)
    }

    fn bytes(&mut self, maximum: usize) -> Result<&'a [u8], CollaborationSnapshotError> {
        let length = self.count(maximum)?;
        self.take(length)
    }

    fn string(&mut self) -> Result<String, CollaborationSnapshotError> {
        let bytes = self.bytes(MAX_STRING_BYTES)?;
        let value =
            std::str::from_utf8(bytes).map_err(|_| CollaborationSnapshotError::InvalidUtf8)?;
        let mut owned = String::new();
        owned
            .try_reserve_exact(value.len())
            .map_err(|_| CollaborationSnapshotError::SizeLimit)?;
        owned.push_str(value);
        Ok(owned)
    }

    fn frontier(&mut self) -> Result<CausalFrontier, CollaborationSnapshotError> {
        let count = self.count(MAX_CAUSAL_REPLICAS)?;
        if count > self.remaining() / 16 {
            return Err(CollaborationSnapshotError::Truncated);
        }
        let mut entries = Vec::new();
        entries
            .try_reserve_exact(count)
            .map_err(|_| CollaborationSnapshotError::SizeLimit)?;
        let mut previous = None;
        for _ in 0..count {
            let replica =
                ReplicaId::new(self.u64()?).map_err(CollaborationSnapshotError::Collaboration)?;
            if previous.is_some_and(|candidate| replica <= candidate) {
                return Err(CollaborationSnapshotError::NonCanonical(
                    "frontier replicas are not strictly ordered",
                ));
            }
            previous = Some(replica);
            let counter = self.u64()?;
            entries.push((replica, counter));
        }
        CausalFrontier::from_entries(entries).map_err(CollaborationSnapshotError::Collaboration)
    }

    fn generation(&mut self) -> Result<SheetGeneration, CollaborationSnapshotError> {
        let sheet_id = self.id()?;
        let operation_id = OperationId::from_stable_id(self.id()?);
        Ok(SheetGeneration::new(sheet_id, operation_id))
    }

    fn transaction(&mut self) -> Result<CollaborationTransaction, CollaborationSnapshotError> {
        let id = TransactionId::from_stable_id(self.id()?);
        let replica =
            ReplicaId::new(self.u64()?).map_err(CollaborationSnapshotError::Collaboration)?;
        let dot = CausalDot::new(replica, self.u64()?)
            .map_err(CollaborationSnapshotError::Collaboration)?;
        let base = self.frontier()?;
        let operation_count = self.count(MAX_OPERATIONS_PER_TRANSACTION)?;
        if operation_count > self.remaining() / MIN_OPERATION_BYTES {
            return Err(CollaborationSnapshotError::Truncated);
        }
        let mut operations = Vec::new();
        operations
            .try_reserve_exact(operation_count)
            .map_err(|_| CollaborationSnapshotError::SizeLimit)?;
        for _ in 0..operation_count {
            let operation_id = OperationId::from_stable_id(self.id()?);
            let command = match self.u8()? {
                0 => {
                    let sheet_id = self.id()?;
                    let name = self.string()?;
                    let after = match self.u8()? {
                        0 => None,
                        1 => Some(self.generation()?),
                        tag => return Err(CollaborationSnapshotError::InvalidTag(tag)),
                    };
                    CollaborationCommand::CreateSheet {
                        sheet_id,
                        name,
                        after,
                    }
                }
                1 => CollaborationCommand::RenameSheet {
                    sheet: self.generation()?,
                    name: self.string()?,
                },
                2 => CollaborationCommand::DeleteSheet {
                    sheet: self.generation()?,
                },
                3 => {
                    let sheet = self.generation()?;
                    let anchor = CellCoord::new(self.u32()?, self.u32()?);
                    let rows = self.u32()?;
                    let columns = self.u32()?;
                    let cell_count = self.count(MAX_CELLS_PER_TRANSACTION)?;
                    let expected = (rows as usize)
                        .checked_mul(columns as usize)
                        .ok_or(CollaborationSnapshotError::SizeLimit)?;
                    if cell_count != expected {
                        return Err(CollaborationSnapshotError::NonCanonical(
                            "cell block dimensions do not match its payload",
                        ));
                    }
                    if cell_count > self.remaining() / MIN_CELL_BYTES {
                        return Err(CollaborationSnapshotError::Truncated);
                    }
                    let mut cells = Vec::new();
                    cells
                        .try_reserve_exact(cell_count)
                        .map_err(|_| CollaborationSnapshotError::SizeLimit)?;
                    for _ in 0..cell_count {
                        cells.push(self.cell()?);
                    }
                    let cells = CellBlock::new(rows, columns, cells).map_err(|_| {
                        CollaborationSnapshotError::InvalidModel("invalid cell block")
                    })?;
                    CollaborationCommand::SetCells {
                        sheet,
                        anchor,
                        cells,
                    }
                }
                4 => {
                    let sheet = self.generation()?;
                    let first = CellCoord::new(self.u32()?, self.u32()?);
                    let second = CellCoord::new(self.u32()?, self.u32()?);
                    let range = CellRange::new(first, second);
                    if range.start != first || range.end != second {
                        return Err(CollaborationSnapshotError::NonCanonical(
                            "cell range is not normalized",
                        ));
                    }
                    CollaborationCommand::ClearRange { sheet, range }
                }
                5 => CollaborationCommand::Undo {
                    target: OperationId::from_stable_id(self.id()?),
                },
                tag => return Err(CollaborationSnapshotError::InvalidTag(tag)),
            };
            operations.push(CollaborationOperation::new(operation_id, command));
        }
        Ok(CollaborationTransaction::new(id, dot, base, operations))
    }

    fn cell(&mut self) -> Result<Cell, CollaborationSnapshotError> {
        let formula = match self.u8()? {
            0 => None,
            1 => {
                let source = self.string()?;
                if source.is_empty() {
                    return Err(CollaborationSnapshotError::NonCanonical(
                        "formula must not be empty",
                    ));
                }
                Some(source)
            }
            tag => return Err(CollaborationSnapshotError::InvalidTag(tag)),
        };
        let value = match self.u8()? {
            0 => CellValue::Empty,
            1 => CellValue::Boolean(false),
            2 => CellValue::Boolean(true),
            3 => {
                let bits = self.u64()?;
                if bits == (-0.0f64).to_bits() {
                    return Err(CollaborationSnapshotError::NonCanonical(
                        "number uses negative zero",
                    ));
                }
                CellValue::Number(
                    Number::from_snapshot_bits(bits)
                        .map_err(CollaborationSnapshotError::InvalidNumber)?,
                )
            }
            4 => CellValue::Text(self.string()?),
            5 => CellValue::Error(self.formula_error()?),
            6 => CellValue::Date(
                DateValue::new(self.u64()? as i64)
                    .map_err(CollaborationSnapshotError::InvalidDate)?,
            ),
            tag => return Err(CollaborationSnapshotError::InvalidTag(tag)),
        };
        Ok(Cell::from_snapshot(value, formula))
    }

    fn formula_error(&mut self) -> Result<FormulaError, CollaborationSnapshotError> {
        match self.u8()? {
            0 => Ok(FormulaError::Null),
            1 => Ok(FormulaError::DivideByZero),
            2 => Ok(FormulaError::Value),
            3 => Ok(FormulaError::Reference),
            4 => Ok(FormulaError::Name),
            5 => Ok(FormulaError::Number),
            6 => Ok(FormulaError::NotAvailable),
            7 => Ok(FormulaError::Spill),
            8 => Ok(FormulaError::Calculation),
            9 => Ok(FormulaError::Custom(self.string()?)),
            tag => Err(CollaborationSnapshotError::InvalidTag(tag)),
        }
    }
}

fn checksum(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::{
        checksum, decode_collaboration_snapshot, encode_collaboration_snapshot,
        retained_transaction_wire_bytes, CollaborationSnapshotError, Decoder, Encoder,
        CHECKSUM_BYTES, HEADER_BYTES, MAX_CAUSAL_REPLICAS,
    };
    use crate::collaboration::{
        CausalDot, CausalFrontier, CollaborationCommand, CollaborationError,
        CollaborationOperation, CollaborationTransaction, CollaborativeWorkbook, OperationId,
        ReplicaId, SheetGeneration, TransactionId,
    };
    use crate::{encode_snapshot, StableId};

    fn replica(value: u64) -> ReplicaId {
        ReplicaId::new(value).expect("replica")
    }

    fn dot(replica_id: u64, counter: u64) -> CausalDot {
        CausalDot::new(replica(replica_id), counter).expect("dot")
    }

    fn frontier(entries: &[(u64, u64)]) -> CausalFrontier {
        CausalFrontier::from_entries(
            entries
                .iter()
                .map(|(replica_id, counter)| (replica(*replica_id), *counter)),
        )
        .expect("frontier")
    }

    fn operation_id(value: u64) -> OperationId {
        OperationId::from_stable_id(StableId::from_parts(91, value))
    }

    fn transaction(
        value: u64,
        replica_id: u64,
        base: CausalFrontier,
        command: CollaborationCommand,
    ) -> CollaborationTransaction {
        CollaborationTransaction::new(
            TransactionId::from_stable_id(StableId::from_parts(90, value)),
            dot(replica_id, 1),
            base,
            vec![CollaborationOperation::new(operation_id(value), command)],
        )
    }

    fn finish_payload(payload: Encoder) -> Vec<u8> {
        assert!(!payload.overflowed);
        let mut output = Vec::new();
        output.extend_from_slice(b"OGACRD01");
        output.extend_from_slice(&1u16.to_le_bytes());
        output.extend_from_slice(&0u16.to_le_bytes());
        output.extend_from_slice(&(payload.bytes.len() as u64).to_le_bytes());
        output.extend_from_slice(&payload.bytes);
        output.extend_from_slice(&checksum(&payload.bytes).to_le_bytes());
        output
    }

    fn rewrite_checksum(bytes: &mut [u8]) {
        let payload_end = bytes.len() - CHECKSUM_BYTES;
        let replacement = checksum(&bytes[HEADER_BYTES..payload_end]).to_le_bytes();
        bytes[payload_end..].copy_from_slice(&replacement);
    }

    fn decode_hex(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let digit = |byte: u8| match byte {
                    b'0'..=b'9' => byte - b'0',
                    b'a'..=b'f' => byte - b'a' + 10,
                    _ => panic!("invalid fixture hex"),
                };
                (digit(pair[0]) << 4) | digit(pair[1])
            })
            .collect()
    }

    #[test]
    fn transaction_cells_reject_noncanonical_negative_zero() {
        let mut bytes = vec![0, 3];
        bytes.extend_from_slice(&(-0.0f64).to_bits().to_le_bytes());
        let mut decoder = Decoder::new(&bytes);
        assert_eq!(
            decoder.cell(),
            Err(CollaborationSnapshotError::NonCanonical(
                "number uses negative zero"
            ))
        );
    }

    #[test]
    fn impossible_frontier_count_fails_before_reserving() {
        let bytes = u32::try_from(MAX_CAUSAL_REPLICAS)
            .expect("bounded count")
            .to_le_bytes();
        let mut decoder = Decoder::new(&bytes);
        assert_eq!(
            decoder.frontier(),
            Err(CollaborationSnapshotError::Truncated)
        );
    }

    #[test]
    fn retained_size_preflight_is_the_exact_v1_encoder_size() {
        let sheet_id = StableId::from_parts(77, 10);
        let transaction = transaction(
            1,
            1,
            CausalFrontier::new(),
            CollaborationCommand::CreateSheet {
                sheet_id,
                name: "Exact byte accounting 🚀".into(),
                after: None,
            },
        );
        let mut encoder = Encoder::default();
        let start = encoder.encoded_len;
        encoder.u8(1);
        encoder.transaction(&transaction).expect("encode");
        assert_eq!(
            retained_transaction_wire_bytes(&transaction).expect("size"),
            encoder.encoded_len - start
        );
    }

    #[test]
    fn pre_budget_v1_empty_snapshot_fixture_remains_byte_compatible() {
        // Produced by the original OGACRD01 v1 layout before retained-byte
        // admission accounting existed. Accounting is derived state and must
        // never leak into or perturb the persisted v1 representation.
        let fixture = decode_hex(concat!(
            "4f47414352443031010000005d00000000000000010000000000000000000000",
            "490000004f474152544b3031010000002d000000000000000100000000000000",
            "0100000000000000000000000000000001000000000000000200000000000000",
            "0000000000b284ef8e6ba5686900000000af725e74dae1bffa"
        ));
        let workbook = decode_collaboration_snapshot(&fixture).expect("legacy v1 fixture");
        assert_eq!(workbook.retained_history_bytes(), 0);
        assert_eq!(
            encode_collaboration_snapshot(&workbook).expect("re-encode"),
            fixture
        );
    }

    #[test]
    fn tampered_applied_disposition_cannot_be_restored_as_deferred() {
        let sheet_id = StableId::from_parts(77, 10);
        let create = transaction(
            1,
            1,
            CausalFrontier::new(),
            CollaborationCommand::CreateSheet {
                sheet_id,
                name: "Data".into(),
                after: None,
            },
        );
        let mut workbook = CollaborativeWorkbook::new(77).expect("workbook");
        workbook.apply_transaction(create).expect("create");
        let mut bytes = encode_collaboration_snapshot(&workbook).expect("snapshot");

        let payload_end = bytes.len() - CHECKSUM_BYTES;
        let mut decoder = Decoder::new(&bytes[HEADER_BYTES..payload_end]);
        decoder.u64().expect("namespace");
        decoder.frontier().expect("frontier");
        decoder.bytes(super::MAX_SNAPSHOT_BYTES).expect("model");
        assert_eq!(decoder.u32().expect("transaction count"), 1);
        let status_offset = HEADER_BYTES + decoder.offset;
        assert_eq!(bytes[status_offset], 1);
        bytes[status_offset] = 0;
        rewrite_checksum(&mut bytes);

        assert_eq!(
            decode_collaboration_snapshot(&bytes),
            Err(CollaborationSnapshotError::InvalidModel(
                "deferred transaction status does not reconstruct"
            ))
        );
    }

    #[test]
    fn causally_unclosed_applied_history_is_rejected() {
        let sheet_id = StableId::from_parts(77, 10);
        let create = transaction(
            1,
            1,
            CausalFrontier::new(),
            CollaborationCommand::CreateSheet {
                sheet_id,
                name: "Data".into(),
                after: None,
            },
        );
        let generation = SheetGeneration::new(sheet_id, operation_id(1));
        let rename = transaction(
            2,
            2,
            frontier(&[(1, 1)]),
            CollaborationCommand::RenameSheet {
                sheet: generation,
                name: "Observed root".into(),
            },
        );
        // This observes the rename but maliciously omits the create that the
        // rename observed. The graph is topologically connected, but the
        // authored version vector is not causally closed.
        let invalid = transaction(
            3,
            3,
            frontier(&[(2, 1)]),
            CollaborationCommand::RenameSheet {
                sheet: generation,
                name: "Impossible cut".into(),
            },
        );

        let empty = CollaborativeWorkbook::new(77).expect("empty workbook");
        let materialized = encode_snapshot(empty.workbook()).expect("materialized");
        let mut payload = Encoder::default();
        payload.u64(77);
        payload
            .frontier(&frontier(&[(1, 1), (2, 1), (3, 1)]))
            .expect("frontier");
        payload.bytes(&materialized).expect("model");
        payload.count(3).expect("count");
        for transaction in [&create, &rename, &invalid] {
            payload.u8(1);
            payload.transaction(transaction).expect("transaction");
        }
        let bytes = finish_payload(payload);

        assert_eq!(
            decode_collaboration_snapshot(&bytes),
            Err(CollaborationSnapshotError::Collaboration(
                CollaborationError::CausalBaseNotClosed {
                    dependency: dot(2, 1),
                    missing: dot(1, 1),
                }
            ))
        );
    }
}
