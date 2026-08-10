//! Canonical collaboration ABI shared by N-API and WebAssembly.
//!
//! The browser mapper remains responsible for lowering public modality
//! commands. This module owns causal metadata, deterministic identities,
//! generation pinning, CRDT application, replay, and canonical state hashes.

use std::str::FromStr;

use opengeni_artifact_kernel::{
    decode_collaboration_snapshot, encode_collaboration_snapshot, CausalDot, CausalFrontier, Cell,
    CellBlock, CellCoord, CellRange, CellValue, CollaborationCommand, CollaborationOperation,
    CollaborationTransaction, CollaborativeWorkbook, DateValue, FormulaError, Number, OperationId,
    ReplicaId, SheetGeneration, StableId, TransactionDisposition, TransactionId,
    MAX_CAUSAL_REPLICAS, MAX_CELLS_PER_TRANSACTION, MAX_OPERATIONS_PER_TRANSACTION,
};
use sha2::{Digest, Sha256};

use super::spreadsheet_commands::{
    decode_spreadsheet_commands, SheetPrecondition, SpreadsheetCommand, SpreadsheetCommandBatch,
    SPREADSHEET_COMMAND_VERSION,
};
use super::{
    check_snapshot_bound, decode_namespace, validate_spreadsheet_projection, BindingError,
    BindingLimits, NATIVE_LIMITS,
};

pub const EDITABLE_ARTIFACT_INTENT_VERSION: u16 = 1;
pub const COLLABORATION_OPERATION_VERSION: u16 = 1;
pub const MAX_COMMITTED_TRANSACTION_BYTES: usize = 8 * 1024 * 1024;

const INTENT_MAGIC: [u8; 8] = *b"OGATX001";
const FRONTIER_MAGIC: [u8; 8] = *b"OGACF001";
const OPERATION_MAGIC: [u8; 8] = *b"OGACO001";
pub const MAX_INTENT_BYTES: usize = 5 * 1024 * 1024;
const MAX_INTENT_COMMAND_BYTES: usize = 4 * 1024 * 1024;
const MAX_INTENT_CAUSAL_ACTORS: usize = 1_024;
const MAX_INTENT_UNDO_TARGETS: usize = 10_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_PORTABLE_ID_BYTES: usize = 200;
const MAX_OPERATION_STRING_BYTES: usize = 4 * 1024 * 1024;
const CHECKSUM_BYTES: usize = 8;
const ENVELOPE_HEADER_BYTES: usize = 8 + 2 + 2 + 4 + 8;
const TX_DOMAIN: &[u8] = b"opengeni:artifact:tx:v1\0";
const OP_DOMAIN: &[u8] = b"opengeni:artifact:op:v1\0";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DerivedIntentIdentities {
    pub request_hash: String,
    pub transaction_id: StableId,
    pub operation_ids: Vec<StableId>,
}

#[derive(Debug)]
struct DecodedIntent<'a> {
    digest: [u8; 32],
    replica: ReplicaId,
    counter: u64,
    causal_base: CausalFrontier,
    undo_targets: Vec<OperationId>,
    command_bytes: &'a [u8],
}

#[derive(Debug)]
struct CommittedOperation {
    transaction: CollaborationTransaction,
    prior_state_hash: [u8; 32],
    resulting_frontier: CausalFrontier,
    resulting_state_hash: [u8; 32],
}

/// Derives collision-resistant CRDT identities solely from exact canonical
/// OGATX001 bytes and the pure OGASC001 command batch nested inside them.
pub fn derive_intent_identities(
    intent_bytes: &[u8],
) -> Result<DerivedIntentIdentities, BindingError> {
    let intent = decode_intent(intent_bytes)?;
    let commands = decode_spreadsheet_commands(intent.command_bytes)?;
    let operation_count = intent
        .undo_targets
        .len()
        .checked_add(commands.commands.len())
        .ok_or(BindingError::Limit("collaboration operation count"))?;
    if operation_count == 0 || operation_count > MAX_OPERATIONS_PER_TRANSACTION {
        return Err(BindingError::Limit("collaboration operation count"));
    }
    let transaction_id = derive_id(TX_DOMAIN, &intent.digest, None)?;
    let mut operation_ids = Vec::new();
    operation_ids
        .try_reserve_exact(operation_count)
        .map_err(|_| BindingError::Limit("collaboration operation identities"))?;
    for index in 0..operation_count {
        let index = u32::try_from(index)
            .map_err(|_| BindingError::Limit("collaboration operation count"))?;
        operation_ids.push(derive_id(OP_DOMAIN, &intent.digest, Some(index))?);
    }
    Ok(DerivedIntentIdentities {
        request_hash: sha256_text(&intent.digest),
        transaction_id,
        operation_ids,
    })
}

pub fn encode_causal_frontier(frontier: &CausalFrontier) -> Result<Vec<u8>, BindingError> {
    if frontier.len() > MAX_INTENT_CAUSAL_ACTORS {
        return Err(BindingError::Limit("causal frontier"));
    }
    let payload_len = 4usize
        .checked_add(
            frontier
                .len()
                .checked_mul(16)
                .ok_or(BindingError::Limit("causal frontier"))?,
        )
        .ok_or(BindingError::Limit("causal frontier"))?;
    let mut output = Vec::with_capacity(
        8usize
            .checked_add(2 + 2 + payload_len + CHECKSUM_BYTES)
            .ok_or(BindingError::Limit("causal frontier"))?,
    );
    output.extend_from_slice(&FRONTIER_MAGIC);
    output.extend_from_slice(&COLLABORATION_OPERATION_VERSION.to_le_bytes());
    output.extend_from_slice(&0u16.to_le_bytes());
    output.extend_from_slice(
        &u32::try_from(frontier.len())
            .map_err(|_| BindingError::Limit("causal frontier"))?
            .to_le_bytes(),
    );
    for (replica, counter) in frontier.iter() {
        output.extend_from_slice(&replica.get().to_le_bytes());
        output.extend_from_slice(&counter.to_le_bytes());
    }
    output.extend_from_slice(&checksum(&output).to_le_bytes());
    Ok(output)
}

pub fn decode_causal_frontier(bytes: &[u8]) -> Result<CausalFrontier, BindingError> {
    if bytes.len() < 8 + 2 + 2 + 4 + CHECKSUM_BYTES {
        return Err(BindingError::Truncated);
    }
    if bytes[..8] != FRONTIER_MAGIC {
        return Err(BindingError::BadMagic("causal frontier"));
    }
    if read_u16(&bytes[8..10])? != COLLABORATION_OPERATION_VERSION {
        return Err(BindingError::UnsupportedVersion(read_u16(&bytes[8..10])?));
    }
    if read_u16(&bytes[10..12])? != 0 {
        return Err(BindingError::NonCanonical(
            "reserved causal frontier bits are set",
        ));
    }
    let count = usize::try_from(read_u32(&bytes[12..16])?)
        .map_err(|_| BindingError::Limit("causal frontier"))?;
    if count > MAX_INTENT_CAUSAL_ACTORS || count > MAX_CAUSAL_REPLICAS {
        return Err(BindingError::Limit("causal frontier"));
    }
    let expected = 16usize
        .checked_add(
            count
                .checked_mul(16)
                .ok_or(BindingError::Limit("causal frontier"))?,
        )
        .and_then(|value| value.checked_add(CHECKSUM_BYTES))
        .ok_or(BindingError::Limit("causal frontier"))?;
    if bytes.len() != expected {
        return Err(if bytes.len() < expected {
            BindingError::Truncated
        } else {
            BindingError::TrailingBytes
        });
    }
    if checksum(&bytes[..expected - CHECKSUM_BYTES])
        != read_u64(&bytes[expected - CHECKSUM_BYTES..])?
    {
        return Err(BindingError::ChecksumMismatch);
    }
    let mut entries = Vec::new();
    entries
        .try_reserve_exact(count)
        .map_err(|_| BindingError::Limit("causal frontier"))?;
    let mut offset = 16;
    let mut previous = 0;
    for _ in 0..count {
        let replica_value = read_u64(&bytes[offset..offset + 8])?;
        let counter = read_u64(&bytes[offset + 8..offset + 16])?;
        offset += 16;
        if replica_value == 0 || replica_value <= previous || counter == 0 {
            return Err(BindingError::NonCanonical(
                "causal frontier entries must be nonzero and strictly ordered",
            ));
        }
        previous = replica_value;
        entries.push((
            ReplicaId::new(replica_value).map_err(BindingError::Collaboration)?,
            counter,
        ));
    }
    CausalFrontier::from_entries(entries).map_err(BindingError::Collaboration)
}

pub fn canonicalize_collaboration_snapshot(snapshot: &[u8]) -> Result<Vec<u8>, BindingError> {
    canonicalize_collaboration_snapshot_with_limits(snapshot, NATIVE_LIMITS)
}

pub fn canonicalize_collaboration_snapshot_with_limits(
    snapshot: &[u8],
    limits: BindingLimits,
) -> Result<Vec<u8>, BindingError> {
    check_snapshot_bound(snapshot, limits.max_snapshot_bytes)?;
    let state =
        decode_collaboration_snapshot(snapshot).map_err(BindingError::CollaborationSnapshot)?;
    validate_spreadsheet_projection(state.workbook(), None)?;
    let canonical =
        encode_collaboration_snapshot(&state).map_err(BindingError::CollaborationSnapshot)?;
    check_snapshot_bound(&canonical, limits.max_snapshot_bytes)?;
    Ok(canonical)
}

/// Stateful CRDT model. All mutation candidates are applied to an in-memory
/// fork first, then promoted only after canonical snapshot/hash verification.
#[derive(Debug)]
pub struct CollaborationBindingSession {
    state: Option<CollaborativeWorkbook>,
    limits: BindingLimits,
}

impl CollaborationBindingSession {
    pub fn create(namespace_envelope: &[u8]) -> Result<Self, BindingError> {
        Self::create_with_limits(namespace_envelope, NATIVE_LIMITS)
    }

    pub fn create_with_limits(
        namespace_envelope: &[u8],
        limits: BindingLimits,
    ) -> Result<Self, BindingError> {
        let namespace = decode_namespace(namespace_envelope)?;
        let state = CollaborativeWorkbook::new(namespace).map_err(BindingError::Collaboration)?;
        Ok(Self {
            state: Some(state),
            limits,
        })
    }

    pub fn open(snapshot: &[u8]) -> Result<Self, BindingError> {
        Self::open_with_limits(snapshot, NATIVE_LIMITS)
    }

    pub fn open_with_limits(snapshot: &[u8], limits: BindingLimits) -> Result<Self, BindingError> {
        check_snapshot_bound(snapshot, limits.max_snapshot_bytes)?;
        let state =
            decode_collaboration_snapshot(snapshot).map_err(BindingError::CollaborationSnapshot)?;
        validate_spreadsheet_projection(state.workbook(), None)?;
        Ok(Self {
            state: Some(state),
            limits,
        })
    }

    /// Authors and atomically applies one canonical one-dot CRDT transaction.
    /// `intent_bytes` are exact OGATX001 bytes. The pure OGASC001 commands
    /// nested inside are the only mutation input; no second lowering envelope
    /// or caller-supplied operation count exists. `resolved_base` is an
    /// OGACF001 authority-resolved frontier that must dominate the authored
    /// base.
    pub fn author_transaction(
        &mut self,
        intent_bytes: &[u8],
        resolved_base: &[u8],
    ) -> Result<Vec<u8>, BindingError> {
        self.ensure_open()?;
        let intent = decode_intent(intent_bytes)?;
        let commands = decode_spreadsheet_commands(intent.command_bytes)?;
        if commands.cell_count
            > self
                .limits
                .max_cells_per_batch
                .min(MAX_CELLS_PER_TRANSACTION)
        {
            return Err(BindingError::Limit("OGASC001 cells"));
        }
        let resolved_base = decode_causal_frontier(resolved_base)?;
        if !resolved_base.dominates(&intent.causal_base) {
            return Err(BindingError::InvalidIntent(
                "resolved causal base does not dominate the authored base".into(),
            ));
        }
        let expected_own_predecessor = intent.counter - 1;
        if resolved_base.counter(intent.replica) != expected_own_predecessor {
            return Err(BindingError::InvalidIntent(
                "resolved causal base does not contain the exact own predecessor".into(),
            ));
        }
        let identities = derive_from_decoded_intent(&intent, commands.commands.len())?;
        let state = self.state.as_ref().ok_or(BindingError::Closed)?;
        let transaction = lower_transaction(
            intent,
            resolved_base,
            &commands,
            identities.transaction_id,
            &identities.operation_ids,
        )?;

        let prior_snapshot =
            encode_collaboration_snapshot(state).map_err(BindingError::CollaborationSnapshot)?;
        check_snapshot_bound(&prior_snapshot, self.limits.max_snapshot_bytes)?;
        let prior_state_hash = sha256_bytes(&prior_snapshot);
        let mut candidate = state.clone();
        let receipt = candidate
            .apply_transaction(transaction.clone())
            .map_err(BindingError::Collaboration)?;
        if receipt.disposition != TransactionDisposition::Applied {
            return Err(BindingError::StateMismatch(
                "authored transaction was not immediately applicable",
            ));
        }
        validate_spreadsheet_projection(candidate.workbook(), None)?;
        let snapshot = encode_collaboration_snapshot(&candidate)
            .map_err(BindingError::CollaborationSnapshot)?;
        check_snapshot_bound(&snapshot, self.limits.max_snapshot_bytes)?;
        let resulting_hash = sha256_bytes(&snapshot);
        let committed = CommittedOperation {
            transaction,
            prior_state_hash,
            resulting_frontier: candidate.frontier().clone(),
            resulting_state_hash: resulting_hash,
        };
        let encoded = encode_committed_operation(
            &committed,
            self.limits
                .max_command_bytes
                .min(MAX_COMMITTED_TRANSACTION_BYTES),
        )?;
        self.state = Some(candidate);
        Ok(encoded)
    }

    /// Replays exact canonical committed bytes without any host-side operation
    /// interpretation. A mismatched advertised frontier/hash cannot mutate the
    /// live session.
    pub fn apply_committed(&mut self, operation_envelope: &[u8]) -> Result<(), BindingError> {
        self.ensure_open()?;
        let maximum = self
            .limits
            .max_command_bytes
            .min(MAX_COMMITTED_TRANSACTION_BYTES);
        if operation_envelope.len() > maximum {
            return Err(BindingError::Limit("committed operation envelope"));
        }
        let committed = decode_committed_operation(
            operation_envelope,
            maximum,
            self.limits.max_cells_per_batch,
        )?;
        let state = self.state.as_ref().ok_or(BindingError::Closed)?;
        let current_snapshot =
            encode_collaboration_snapshot(state).map_err(BindingError::CollaborationSnapshot)?;
        check_snapshot_bound(&current_snapshot, self.limits.max_snapshot_bytes)?;
        let current_state_hash = sha256_bytes(&current_snapshot);
        let mut candidate = state.clone();
        let receipt = candidate
            .apply_transaction(committed.transaction.clone())
            .map_err(BindingError::Collaboration)?;
        match receipt.disposition {
            TransactionDisposition::Applied => {
                if current_state_hash != committed.prior_state_hash {
                    return Err(BindingError::StateMismatch(
                        "committed transaction prior state hash does not match",
                    ));
                }
            }
            TransactionDisposition::DuplicateApplied => {
                if current_state_hash == committed.resulting_state_hash
                    && state.frontier() == &committed.resulting_frontier
                {
                    return Ok(());
                }
                return Err(BindingError::StateMismatch(
                    "duplicate committed transaction does not describe current state",
                ));
            }
            TransactionDisposition::Deferred | TransactionDisposition::DuplicateDeferred => {
                return Err(BindingError::StateMismatch(
                    "committed transaction has unresolved causal dependencies",
                ));
            }
        }
        if candidate.frontier() != &committed.resulting_frontier {
            return Err(BindingError::StateMismatch(
                "committed operation resulting frontier does not match",
            ));
        }
        validate_spreadsheet_projection(candidate.workbook(), None)?;
        let snapshot = encode_collaboration_snapshot(&candidate)
            .map_err(BindingError::CollaborationSnapshot)?;
        check_snapshot_bound(&snapshot, self.limits.max_snapshot_bytes)?;
        if sha256_bytes(&snapshot) != committed.resulting_state_hash {
            return Err(BindingError::StateMismatch(
                "committed operation resulting state hash does not match",
            ));
        }
        self.state = Some(candidate);
        Ok(())
    }

    pub fn snapshot(&self) -> Result<Vec<u8>, BindingError> {
        let snapshot =
            encode_collaboration_snapshot(self.state.as_ref().ok_or(BindingError::Closed)?)
                .map_err(BindingError::CollaborationSnapshot)?;
        check_snapshot_bound(&snapshot, self.limits.max_snapshot_bytes)?;
        Ok(snapshot)
    }

    pub fn frontier(&self) -> Result<Vec<u8>, BindingError> {
        encode_causal_frontier(self.state.as_ref().ok_or(BindingError::Closed)?.frontier())
    }

    pub fn state_hash(&self) -> Result<String, BindingError> {
        Ok(sha256_text(&sha256_bytes(&self.snapshot()?)))
    }

    pub fn revision(&self) -> Result<u64, BindingError> {
        Ok(self
            .state
            .as_ref()
            .ok_or(BindingError::Closed)?
            .workbook()
            .revision())
    }

    /// Executes one bounded read against the current materialized workbook.
    /// Responses include the visible CRDT creation-operation id for every
    /// returned sheet, pinning the projection to its exact generation.
    pub fn query(&self, query_envelope: &[u8]) -> Result<Vec<u8>, BindingError> {
        let state = self.state.as_ref().ok_or(BindingError::Closed)?;
        super::query::query_workbook(state.workbook(), query_envelope, true, |sheet_id| {
            state
                .sheet_generation(sheet_id)
                .map(|generation| generation.creation().stable_id())
        })
    }

    pub fn fork(&self) -> Result<Self, BindingError> {
        Ok(Self {
            state: Some(self.state.as_ref().ok_or(BindingError::Closed)?.clone()),
            limits: self.limits,
        })
    }

    pub fn close(&mut self) {
        self.state = None;
    }

    #[must_use]
    pub const fn is_closed(&self) -> bool {
        self.state.is_none()
    }

    fn ensure_open(&self) -> Result<(), BindingError> {
        if self.is_closed() {
            Err(BindingError::Closed)
        } else {
            Ok(())
        }
    }
}

fn lower_transaction(
    intent: DecodedIntent<'_>,
    resolved_base: CausalFrontier,
    batch: &SpreadsheetCommandBatch,
    transaction_id: StableId,
    operation_ids: &[StableId],
) -> Result<CollaborationTransaction, BindingError> {
    let expected_count = intent
        .undo_targets
        .len()
        .checked_add(batch.commands.len())
        .ok_or(BindingError::Limit("collaboration operation count"))?;
    if operation_ids.len() != expected_count {
        return Err(BindingError::StateMismatch(
            "derived operation identity count does not match commands",
        ));
    }
    let mut operations = Vec::new();
    operations
        .try_reserve_exact(expected_count)
        .map_err(|_| BindingError::Limit("collaboration operations"))?;
    for (index, target) in intent.undo_targets.into_iter().enumerate() {
        operations.push(CollaborationOperation::new(
            OperationId::from_stable_id(operation_ids[index]),
            CollaborationCommand::Undo { target },
        ));
    }
    let command_offset = operations.len();
    for (index, command) in batch.commands.iter().enumerate() {
        let operation_id = OperationId::from_stable_id(operation_ids[command_offset + index]);
        let command = match command {
            SpreadsheetCommand::CreateSheet {
                sheet_id,
                name,
                after,
            } => CollaborationCommand::CreateSheet {
                sheet_id: *sheet_id,
                name: name.clone(),
                after: after
                    .map(|target| {
                        resolve_precondition(target, &batch.commands, operation_ids, command_offset)
                    })
                    .transpose()?,
            },
            SpreadsheetCommand::RenameSheet { sheet, name } => CollaborationCommand::RenameSheet {
                sheet: resolve_precondition(
                    *sheet,
                    &batch.commands,
                    operation_ids,
                    command_offset,
                )?,
                name: name.clone(),
            },
            SpreadsheetCommand::DeleteSheet { sheet } => CollaborationCommand::DeleteSheet {
                sheet: resolve_precondition(
                    *sheet,
                    &batch.commands,
                    operation_ids,
                    command_offset,
                )?,
            },
            SpreadsheetCommand::SetCells {
                sheet,
                anchor,
                cells,
            } => CollaborationCommand::SetCells {
                sheet: resolve_precondition(
                    *sheet,
                    &batch.commands,
                    operation_ids,
                    command_offset,
                )?,
                anchor: *anchor,
                cells: cells.clone(),
            },
            SpreadsheetCommand::ClearRange { sheet, range } => CollaborationCommand::ClearRange {
                sheet: resolve_precondition(
                    *sheet,
                    &batch.commands,
                    operation_ids,
                    command_offset,
                )?,
                range: *range,
            },
        };
        operations.push(CollaborationOperation::new(operation_id, command));
    }
    Ok(CollaborationTransaction::new(
        TransactionId::from_stable_id(transaction_id),
        CausalDot::new(intent.replica, intent.counter).map_err(BindingError::Collaboration)?,
        resolved_base,
        operations,
    ))
}

fn resolve_precondition(
    precondition: SheetPrecondition,
    commands: &[SpreadsheetCommand],
    operation_ids: &[StableId],
    command_offset: usize,
) -> Result<SheetGeneration, BindingError> {
    match precondition {
        SheetPrecondition::Generation(generation) => Ok(generation),
        SheetPrecondition::CreatedInBatch {
            sheet_id,
            create_command_index,
        } => {
            let index = usize::try_from(create_command_index)
                .map_err(|_| BindingError::Limit("OGASC001 prior-create index"))?;
            if !matches!(
                commands.get(index),
                Some(SpreadsheetCommand::CreateSheet {
                    sheet_id: created_id,
                    ..
                }) if *created_id == sheet_id
            ) {
                return Err(BindingError::InvalidIntent(
                    "OGASC001 prior-create reference does not match its create command".into(),
                ));
            }
            let operation_id = operation_ids.get(command_offset + index).copied().ok_or(
                BindingError::StateMismatch(
                    "derived operation identity count does not match commands",
                ),
            )?;
            Ok(SheetGeneration::new(
                sheet_id,
                OperationId::from_stable_id(operation_id),
            ))
        }
    }
}

fn decode_intent(bytes: &[u8]) -> Result<DecodedIntent<'_>, BindingError> {
    if bytes.len() > MAX_INTENT_BYTES {
        return Err(BindingError::Limit("OGATX001 intent"));
    }
    let digest = sha256_bytes(bytes);
    let mut reader = Reader::new(bytes);
    if reader.take(8)? != INTENT_MAGIC {
        return Err(BindingError::BadMagic("OGATX001 intent"));
    }
    if reader.u16()? != EDITABLE_ARTIFACT_INTENT_VERSION {
        return Err(BindingError::UnsupportedVersion(read_u16(&bytes[8..10])?));
    }
    for label in ["protocol", "model schema"] {
        if reader.u16()? != 1 {
            return Err(BindingError::InvalidIntent(format!(
                "OGATX001 {label} version must be 1"
            )));
        }
    }
    if reader.u16()? != SPREADSHEET_COMMAND_VERSION {
        return Err(BindingError::InvalidIntent(format!(
            "OGATX001 command protocol version must be {SPREADSHEET_COMMAND_VERSION}"
        )));
    }
    let artifact_id = reader.string()?;
    validate_stable_id_text(artifact_id, "artifact id")?;
    validate_portable_id(reader.string()?, "client transaction id")?;
    let replica_text = reader.string()?;
    let replica_value = validate_replica_text(replica_text)?;
    let replica = ReplicaId::new(replica_value).map_err(BindingError::Collaboration)?;
    let counter = reader.safe_u64(true, "replica counter")?;
    match reader.u8()? {
        0 => {}
        1 => validate_portable_id(reader.string()?, "previous local transaction id")?,
        _ => {
            return Err(BindingError::NonCanonical(
                "OGATX001 predecessor presence flag is invalid",
            ));
        }
    }
    reader.safe_u64(false, "observed head sequence")?;
    let causal_count = usize::from(reader.u16()?);
    if causal_count > MAX_INTENT_CAUSAL_ACTORS {
        return Err(BindingError::Limit("OGATX001 causal base"));
    }
    let mut causal_entries = Vec::new();
    causal_entries
        .try_reserve_exact(causal_count)
        .map_err(|_| BindingError::Limit("OGATX001 causal base"))?;
    let mut previous_replica = 0;
    for _ in 0..causal_count {
        let value = validate_replica_text(reader.string()?)?;
        if value <= previous_replica {
            return Err(BindingError::NonCanonical(
                "OGATX001 causal replicas are not strictly ordered",
            ));
        }
        previous_replica = value;
        let causal_replica = ReplicaId::new(value).map_err(BindingError::Collaboration)?;
        let causal_counter = reader.safe_u64(true, "causal counter")?;
        causal_entries.push((causal_replica, causal_counter));
    }
    let causal_base =
        CausalFrontier::from_entries(causal_entries).map_err(BindingError::Collaboration)?;
    let undo_count = usize::from(reader.u16()?);
    if undo_count > MAX_INTENT_UNDO_TARGETS {
        return Err(BindingError::Limit("OGATX001 undo targets"));
    }
    let mut undo_targets = Vec::new();
    undo_targets
        .try_reserve_exact(undo_count)
        .map_err(|_| BindingError::Limit("OGATX001 undo targets"))?;
    let mut previous_undo = None;
    for _ in 0..undo_count {
        let text = reader.string()?;
        let id = validate_stable_id_text(text, "undo operation id")?;
        if previous_undo.is_some_and(|candidate| id <= candidate) {
            return Err(BindingError::NonCanonical(
                "OGATX001 undo operation ids are not strictly ordered",
            ));
        }
        previous_undo = Some(id);
        undo_targets.push(OperationId::from_stable_id(id));
    }
    let command_length = usize::try_from(reader.u32()?)
        .map_err(|_| BindingError::Limit("OGATX001 command bytes"))?;
    if command_length == 0 || command_length > MAX_INTENT_COMMAND_BYTES {
        return Err(BindingError::Limit("OGATX001 command bytes"));
    }
    let command_bytes = reader.take(command_length)?;
    reader.done()?;
    Ok(DecodedIntent {
        digest,
        replica,
        counter,
        causal_base,
        undo_targets,
        command_bytes,
    })
}

fn derive_from_decoded_intent(
    intent: &DecodedIntent<'_>,
    command_operation_count: usize,
) -> Result<DerivedIntentIdentities, BindingError> {
    let operation_count = intent
        .undo_targets
        .len()
        .checked_add(command_operation_count)
        .ok_or(BindingError::Limit("collaboration operation count"))?;
    if operation_count == 0 || operation_count > MAX_OPERATIONS_PER_TRANSACTION {
        return Err(BindingError::Limit("collaboration operation count"));
    }
    let transaction_id = derive_id(TX_DOMAIN, &intent.digest, None)?;
    let mut operation_ids = Vec::new();
    operation_ids
        .try_reserve_exact(operation_count)
        .map_err(|_| BindingError::Limit("collaboration operation identities"))?;
    for index in 0..operation_count {
        operation_ids.push(derive_id(
            OP_DOMAIN,
            &intent.digest,
            Some(
                u32::try_from(index)
                    .map_err(|_| BindingError::Limit("collaboration operation count"))?,
            ),
        )?);
    }
    Ok(DerivedIntentIdentities {
        request_hash: sha256_text(&intent.digest),
        transaction_id,
        operation_ids,
    })
}

fn derive_id(
    domain: &[u8],
    intent_digest: &[u8; 32],
    index: Option<u32>,
) -> Result<StableId, BindingError> {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(intent_digest);
    if let Some(index) = index {
        hasher.update(index.to_le_bytes());
    }
    let digest = hasher.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    let id = StableId::from_u128(u128::from_be_bytes(bytes));
    if id.is_zero() {
        return Err(BindingError::InvalidIntent(
            "derived collaboration identity is reserved".into(),
        ));
    }
    Ok(id)
}

fn encode_committed_operation(
    committed: &CommittedOperation,
    maximum: usize,
) -> Result<Vec<u8>, BindingError> {
    let mut payload = Writer::new(maximum.saturating_sub(ENVELOPE_HEADER_BYTES + CHECKSUM_BYTES));
    payload.id(committed.transaction.id().stable_id())?;
    payload.u64(committed.transaction.dot().replica().get())?;
    payload.u64(committed.transaction.dot().counter())?;
    payload.frontier(committed.transaction.base())?;
    payload.bytes(&committed.prior_state_hash)?;
    for operation in committed.transaction.operations() {
        payload.id(operation.id().stable_id())?;
        payload.command(operation.command())?;
    }
    payload.frontier(&committed.resulting_frontier)?;
    payload.bytes(&committed.resulting_state_hash)?;
    let payload = payload.finish();
    let mut output = Vec::with_capacity(
        ENVELOPE_HEADER_BYTES
            .checked_add(payload.len())
            .and_then(|value| value.checked_add(CHECKSUM_BYTES))
            .ok_or(BindingError::Limit("committed operation envelope"))?,
    );
    output.extend_from_slice(&OPERATION_MAGIC);
    output.extend_from_slice(&COLLABORATION_OPERATION_VERSION.to_le_bytes());
    output.extend_from_slice(&0u16.to_le_bytes());
    output.extend_from_slice(
        &u32::try_from(committed.transaction.operations().len())
            .map_err(|_| BindingError::Limit("collaboration operation count"))?
            .to_le_bytes(),
    );
    output.extend_from_slice(
        &u64::try_from(payload.len())
            .map_err(|_| BindingError::Limit("committed operation payload"))?
            .to_le_bytes(),
    );
    output.extend_from_slice(&payload);
    output.extend_from_slice(&checksum(&output).to_le_bytes());
    if output.len() > maximum {
        return Err(BindingError::Limit("committed operation envelope"));
    }
    Ok(output)
}

fn decode_committed_operation(
    bytes: &[u8],
    maximum: usize,
    maximum_cells: usize,
) -> Result<CommittedOperation, BindingError> {
    if bytes.len() > maximum {
        return Err(BindingError::Limit("committed operation envelope"));
    }
    if bytes.len() < ENVELOPE_HEADER_BYTES + CHECKSUM_BYTES {
        return Err(BindingError::Truncated);
    }
    if bytes[..8] != OPERATION_MAGIC {
        return Err(BindingError::BadMagic("committed operation"));
    }
    let version = read_u16(&bytes[8..10])?;
    if version != COLLABORATION_OPERATION_VERSION {
        return Err(BindingError::UnsupportedVersion(version));
    }
    if read_u16(&bytes[10..12])? != 0 {
        return Err(BindingError::NonCanonical(
            "reserved committed operation bits are set",
        ));
    }
    let operation_count = usize::try_from(read_u32(&bytes[12..16])?)
        .map_err(|_| BindingError::Limit("collaboration operation count"))?;
    if operation_count == 0 || operation_count > MAX_OPERATIONS_PER_TRANSACTION {
        return Err(BindingError::Limit("collaboration operation count"));
    }
    let payload_len = usize::try_from(read_u64(&bytes[16..24])?)
        .map_err(|_| BindingError::Limit("committed operation payload"))?;
    let payload_end = ENVELOPE_HEADER_BYTES
        .checked_add(payload_len)
        .ok_or(BindingError::Limit("committed operation payload"))?;
    let expected = payload_end
        .checked_add(CHECKSUM_BYTES)
        .ok_or(BindingError::Limit("committed operation envelope"))?;
    if bytes.len() != expected {
        return Err(if bytes.len() < expected {
            BindingError::Truncated
        } else {
            BindingError::TrailingBytes
        });
    }
    if checksum(&bytes[..payload_end]) != read_u64(&bytes[payload_end..])? {
        return Err(BindingError::ChecksumMismatch);
    }
    let mut reader = Reader::new(&bytes[ENVELOPE_HEADER_BYTES..payload_end]);
    let transaction_id = TransactionId::from_stable_id(reader.id()?);
    let replica = ReplicaId::new(reader.u64()?).map_err(BindingError::Collaboration)?;
    let dot = CausalDot::new(replica, reader.u64()?).map_err(BindingError::Collaboration)?;
    let base = reader.frontier(MAX_CAUSAL_REPLICAS)?;
    let prior_state_hash = reader
        .take(32)?
        .try_into()
        .map_err(|_| BindingError::Truncated)?;
    let mut operations = Vec::new();
    operations
        .try_reserve_exact(operation_count)
        .map_err(|_| BindingError::Limit("collaboration operations"))?;
    let mut total_cells = 0usize;
    for _ in 0..operation_count {
        let id = OperationId::from_stable_id(reader.id()?);
        let command = reader.command(&mut total_cells, maximum_cells)?;
        operations.push(CollaborationOperation::new(id, command));
    }
    let resulting_frontier = reader.frontier(MAX_CAUSAL_REPLICAS)?;
    let resulting_state_hash = reader
        .take(32)?
        .try_into()
        .map_err(|_| BindingError::Truncated)?;
    reader.done()?;
    let committed = CommittedOperation {
        transaction: CollaborationTransaction::new(transaction_id, dot, base, operations),
        prior_state_hash,
        resulting_frontier,
        resulting_state_hash,
    };
    if encode_committed_operation(&committed, maximum)? != bytes {
        return Err(BindingError::NonCanonical(
            "committed operation does not use its canonical encoding",
        ));
    }
    Ok(committed)
}

struct Writer {
    bytes: Vec<u8>,
    maximum: usize,
}

impl Writer {
    fn new(maximum: usize) -> Self {
        Self {
            bytes: Vec::new(),
            maximum,
        }
    }

    fn bytes(&mut self, value: &[u8]) -> Result<(), BindingError> {
        let next = self
            .bytes
            .len()
            .checked_add(value.len())
            .ok_or(BindingError::Limit("committed operation payload"))?;
        if next > self.maximum {
            return Err(BindingError::Limit("committed operation payload"));
        }
        self.bytes.extend_from_slice(value);
        Ok(())
    }

    fn u8(&mut self, value: u8) -> Result<(), BindingError> {
        self.bytes(&[value])
    }

    fn u32(&mut self, value: u32) -> Result<(), BindingError> {
        self.bytes(&value.to_le_bytes())
    }

    fn u64(&mut self, value: u64) -> Result<(), BindingError> {
        self.bytes(&value.to_le_bytes())
    }

    fn id(&mut self, id: StableId) -> Result<(), BindingError> {
        self.bytes(&id.to_le_bytes())
    }

    fn string(&mut self, value: &str) -> Result<(), BindingError> {
        if value.len() > MAX_OPERATION_STRING_BYTES {
            return Err(BindingError::Limit("committed operation string"));
        }
        self.u32(
            u32::try_from(value.len())
                .map_err(|_| BindingError::Limit("committed operation string"))?,
        )?;
        self.bytes(value.as_bytes())
    }

    fn generation(&mut self, generation: SheetGeneration) -> Result<(), BindingError> {
        self.id(generation.sheet_id())?;
        self.id(generation.creation().stable_id())
    }

    fn frontier(&mut self, frontier: &CausalFrontier) -> Result<(), BindingError> {
        self.u32(
            u32::try_from(frontier.len()).map_err(|_| BindingError::Limit("causal frontier"))?,
        )?;
        for (replica, counter) in frontier.iter() {
            self.u64(replica.get())?;
            self.u64(counter)?;
        }
        Ok(())
    }

    fn command(&mut self, command: &CollaborationCommand) -> Result<(), BindingError> {
        match command {
            CollaborationCommand::CreateSheet {
                sheet_id,
                name,
                after,
            } => {
                self.u8(0)?;
                self.id(*sheet_id)?;
                self.string(name)?;
                match after {
                    None => self.u8(0),
                    Some(generation) => {
                        self.u8(1)?;
                        self.generation(*generation)
                    }
                }
            }
            CollaborationCommand::RenameSheet { sheet, name } => {
                self.u8(1)?;
                self.generation(*sheet)?;
                self.string(name)
            }
            CollaborationCommand::DeleteSheet { sheet } => {
                self.u8(2)?;
                self.generation(*sheet)
            }
            CollaborationCommand::SetCells {
                sheet,
                anchor,
                cells,
            } => {
                self.u8(3)?;
                self.generation(*sheet)?;
                self.u32(anchor.row)?;
                self.u32(anchor.column)?;
                self.u32(cells.rows())?;
                self.u32(cells.columns())?;
                for cell in cells.cells() {
                    self.cell(cell)?;
                }
                Ok(())
            }
            CollaborationCommand::ClearRange { sheet, range } => {
                self.u8(4)?;
                self.generation(*sheet)?;
                self.u32(range.start.row)?;
                self.u32(range.start.column)?;
                self.u32(range.end.row)?;
                self.u32(range.end.column)
            }
            CollaborationCommand::Undo { target } => {
                self.u8(5)?;
                self.id(target.stable_id())
            }
        }
    }

    fn cell(&mut self, cell: &Cell) -> Result<(), BindingError> {
        match cell.formula_source() {
            None => self.u8(0)?,
            Some(formula) => {
                self.u8(1)?;
                self.string(formula)?;
            }
        }
        match cell.value() {
            CellValue::Empty => self.u8(0),
            CellValue::Boolean(false) => self.u8(1),
            CellValue::Boolean(true) => self.u8(2),
            CellValue::Number(number) => {
                self.u8(3)?;
                self.u64(number.get().to_bits())
            }
            CellValue::Date(value) => {
                self.u8(6)?;
                self.u64(value.milliseconds() as u64)
            }
            CellValue::Text(text) => {
                self.u8(4)?;
                self.string(text)
            }
            CellValue::Error(error) => {
                self.u8(5)?;
                self.formula_error(error)
            }
        }
    }

    fn formula_error(&mut self, error: &FormulaError) -> Result<(), BindingError> {
        match error {
            FormulaError::Null => self.u8(0),
            FormulaError::DivideByZero => self.u8(1),
            FormulaError::Value => self.u8(2),
            FormulaError::Reference => self.u8(3),
            FormulaError::Name => self.u8(4),
            FormulaError::Number => self.u8(5),
            FormulaError::NotAvailable => self.u8(6),
            FormulaError::Spill => self.u8(7),
            FormulaError::Calculation => self.u8(8),
            FormulaError::Custom(value) => {
                self.u8(9)?;
                self.string(value)
            }
        }
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], BindingError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(BindingError::Limit("binary envelope"))?;
        let result = self
            .bytes
            .get(self.offset..end)
            .ok_or(BindingError::Truncated)?;
        self.offset = end;
        Ok(result)
    }

    fn u8(&mut self) -> Result<u8, BindingError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, BindingError> {
        read_u16(self.take(2)?)
    }

    fn u32(&mut self) -> Result<u32, BindingError> {
        read_u32(self.take(4)?)
    }

    fn u64(&mut self) -> Result<u64, BindingError> {
        read_u64(self.take(8)?)
    }

    fn safe_u64(&mut self, positive: bool, label: &str) -> Result<u64, BindingError> {
        let value = self.u64()?;
        if value > MAX_SAFE_INTEGER || (positive && value == 0) {
            return Err(BindingError::InvalidIntent(format!(
                "OGATX001 {label} is not a safe {}integer",
                if positive { "positive " } else { "" }
            )));
        }
        Ok(value)
    }

    fn id(&mut self) -> Result<StableId, BindingError> {
        let bytes: [u8; 16] = self
            .take(16)?
            .try_into()
            .map_err(|_| BindingError::Truncated)?;
        let id = StableId::from_le_bytes(bytes);
        if id.is_zero() {
            return Err(BindingError::NonCanonical(
                "stable ids reserve the all-zero value",
            ));
        }
        Ok(id)
    }

    fn sheet_id(&mut self) -> Result<StableId, BindingError> {
        let id = self.id()?;
        if id.namespace() == 0 || id.counter() == 0 {
            return Err(BindingError::NonCanonical(
                "sheet ids require nonzero namespace and counter",
            ));
        }
        Ok(id)
    }

    fn string(&mut self) -> Result<&'a str, BindingError> {
        let length = usize::from(self.u16()?);
        std::str::from_utf8(self.take(length)?).map_err(|_| BindingError::InvalidUtf8)
    }

    fn operation_string(&mut self) -> Result<String, BindingError> {
        let length = usize::try_from(self.u32()?)
            .map_err(|_| BindingError::Limit("committed operation string"))?;
        if length > MAX_OPERATION_STRING_BYTES {
            return Err(BindingError::Limit("committed operation string"));
        }
        let value =
            std::str::from_utf8(self.take(length)?).map_err(|_| BindingError::InvalidUtf8)?;
        Ok(value.to_owned())
    }

    fn generation(&mut self) -> Result<SheetGeneration, BindingError> {
        Ok(SheetGeneration::new(
            self.sheet_id()?,
            OperationId::from_stable_id(self.id()?),
        ))
    }

    fn frontier(&mut self, maximum: usize) -> Result<CausalFrontier, BindingError> {
        let count =
            usize::try_from(self.u32()?).map_err(|_| BindingError::Limit("causal frontier"))?;
        if count > maximum {
            return Err(BindingError::Limit("causal frontier"));
        }
        let mut entries = Vec::new();
        entries
            .try_reserve_exact(count)
            .map_err(|_| BindingError::Limit("causal frontier"))?;
        let mut previous = 0;
        for _ in 0..count {
            let replica_value = self.u64()?;
            let counter = self.u64()?;
            if replica_value == 0 || replica_value <= previous || counter == 0 {
                return Err(BindingError::NonCanonical(
                    "causal frontier entries must be nonzero and strictly ordered",
                ));
            }
            previous = replica_value;
            entries.push((
                ReplicaId::new(replica_value).map_err(BindingError::Collaboration)?,
                counter,
            ));
        }
        CausalFrontier::from_entries(entries).map_err(BindingError::Collaboration)
    }

    fn command(
        &mut self,
        total_cells: &mut usize,
        maximum_cells: usize,
    ) -> Result<CollaborationCommand, BindingError> {
        match self.u8()? {
            0 => {
                let sheet_id = self.sheet_id()?;
                let name = self.operation_string()?;
                let after = match self.u8()? {
                    0 => None,
                    1 => Some(self.generation()?),
                    tag => return Err(BindingError::InvalidTag(tag)),
                };
                Ok(CollaborationCommand::CreateSheet {
                    sheet_id,
                    name,
                    after,
                })
            }
            1 => Ok(CollaborationCommand::RenameSheet {
                sheet: self.generation()?,
                name: self.operation_string()?,
            }),
            2 => Ok(CollaborationCommand::DeleteSheet {
                sheet: self.generation()?,
            }),
            3 => {
                let sheet = self.generation()?;
                let anchor = CellCoord::new(self.u32()?, self.u32()?);
                let rows = self.u32()?;
                let columns = self.u32()?;
                let count = usize::try_from(rows)
                    .ok()
                    .and_then(|rows| {
                        usize::try_from(columns)
                            .ok()
                            .and_then(|columns| rows.checked_mul(columns))
                    })
                    .ok_or(BindingError::Limit("collaboration cell block"))?;
                if count == 0
                    || anchor.row.checked_add(rows - 1).is_none()
                    || anchor.column.checked_add(columns - 1).is_none()
                {
                    return Err(BindingError::NonCanonical(
                        "collaboration cell block dimensions are invalid",
                    ));
                }
                *total_cells = total_cells
                    .checked_add(count)
                    .ok_or(BindingError::Limit("collaboration cells"))?;
                if *total_cells > maximum_cells || *total_cells > MAX_CELLS_PER_TRANSACTION {
                    return Err(BindingError::Limit("collaboration cells"));
                }
                let mut cells = Vec::new();
                cells
                    .try_reserve_exact(count)
                    .map_err(|_| BindingError::Limit("collaboration cells"))?;
                for _ in 0..count {
                    cells.push(self.cell()?);
                }
                Ok(CollaborationCommand::SetCells {
                    sheet,
                    anchor,
                    cells: CellBlock::new(rows, columns, cells).map_err(|error| {
                        BindingError::Kernel(format!("invalid cell block: {error:?}"))
                    })?,
                })
            }
            4 => {
                let sheet = self.generation()?;
                let first = CellCoord::new(self.u32()?, self.u32()?);
                let second = CellCoord::new(self.u32()?, self.u32()?);
                if first.row > second.row || first.column > second.column {
                    return Err(BindingError::NonCanonical(
                        "collaboration clear range is not normalized",
                    ));
                }
                Ok(CollaborationCommand::ClearRange {
                    sheet,
                    range: CellRange::new(first, second),
                })
            }
            5 => Ok(CollaborationCommand::Undo {
                target: OperationId::from_stable_id(self.id()?),
            }),
            tag => Err(BindingError::InvalidTag(tag)),
        }
    }

    fn cell(&mut self) -> Result<Cell, BindingError> {
        let formula = match self.u8()? {
            0 => None,
            1 => {
                let formula = self.operation_string()?;
                if formula.is_empty() {
                    return Err(BindingError::NonCanonical("formula must not be empty"));
                }
                Some(formula)
            }
            tag => return Err(BindingError::InvalidTag(tag)),
        };
        let value = match self.u8()? {
            0 => CellValue::Empty,
            1 => CellValue::Boolean(false),
            2 => CellValue::Boolean(true),
            3 => {
                let bits = self.u64()?;
                if bits == (-0.0f64).to_bits() {
                    return Err(BindingError::NonCanonical(
                        "cell numbers must encode zero with a positive sign",
                    ));
                }
                CellValue::Number(
                    Number::new(f64::from_bits(bits)).map_err(BindingError::InvalidCellValue)?,
                )
            }
            4 => CellValue::Text(self.operation_string()?),
            5 => CellValue::Error(self.formula_error()?),
            6 => CellValue::Date(
                DateValue::new(self.u64()? as i64).map_err(BindingError::InvalidCellValue)?,
            ),
            tag => return Err(BindingError::InvalidTag(tag)),
        };
        match formula {
            Some(formula) => Cell::formula(formula, value).map_err(BindingError::InvalidCellValue),
            None => Ok(Cell::from_value(value)),
        }
    }

    fn formula_error(&mut self) -> Result<FormulaError, BindingError> {
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
            9 => Ok(FormulaError::Custom(self.operation_string()?)),
            tag => Err(BindingError::InvalidTag(tag)),
        }
    }

    fn done(&self) -> Result<(), BindingError> {
        if self.offset == self.bytes.len() {
            Ok(())
        } else {
            Err(BindingError::TrailingBytes)
        }
    }
}

fn validate_stable_id_text(value: &str, label: &str) -> Result<StableId, BindingError> {
    if value.len() != 32
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(BindingError::InvalidIntent(format!(
            "OGATX001 {label} is not canonical stable-id text"
        )));
    }
    let id = StableId::from_str(value)
        .map_err(|_| BindingError::InvalidIntent(format!("OGATX001 {label} is not a stable id")))?;
    if id.is_zero() {
        return Err(BindingError::InvalidIntent(format!(
            "OGATX001 {label} is reserved"
        )));
    }
    Ok(id)
}

fn validate_replica_text(value: &str) -> Result<u64, BindingError> {
    if value.len() != 16
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(BindingError::InvalidIntent(
            "OGATX001 replica id is not canonical hexadecimal text".into(),
        ));
    }
    let replica = u64::from_str_radix(value, 16)
        .map_err(|_| BindingError::InvalidIntent("OGATX001 replica id is invalid".into()))?;
    if replica == 0 {
        return Err(BindingError::InvalidIntent(
            "OGATX001 replica id is reserved".into(),
        ));
    }
    Ok(replica)
}

fn validate_portable_id(value: &str, label: &str) -> Result<(), BindingError> {
    if value.is_empty()
        || value.len() > MAX_PORTABLE_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(BindingError::InvalidIntent(format!(
            "OGATX001 {label} is not a portable identifier"
        )));
    }
    Ok(())
}

fn sha256_bytes(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn sha256_text(digest: &[u8; 32]) -> String {
    let mut output = String::with_capacity(71);
    output.push_str("sha256:");
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in digest {
        output.push(char::from(HEX[(byte >> 4) as usize]));
        output.push(char::from(HEX[(byte & 0x0f) as usize]));
    }
    output
}

fn read_u16(bytes: &[u8]) -> Result<u16, BindingError> {
    Ok(u16::from_le_bytes(
        bytes.try_into().map_err(|_| BindingError::Truncated)?,
    ))
}

fn read_u32(bytes: &[u8]) -> Result<u32, BindingError> {
    Ok(u32::from_le_bytes(
        bytes.try_into().map_err(|_| BindingError::Truncated)?,
    ))
}

fn read_u64(bytes: &[u8]) -> Result<u64, BindingError> {
    Ok(u64::from_le_bytes(
        bytes.try_into().map_err(|_| BindingError::Truncated)?,
    ))
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
    use super::*;
    use crate::encode_namespace;
    use crate::spreadsheet_commands::encode_spreadsheet_commands;
    use serde_json::Value;

    fn intent(command_bytes: &[u8], replica_counter: u64, base_counter: u64) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"OGATX001");
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        intent_string(&mut bytes, "11111111111111111111111111111111");
        intent_string(&mut bytes, &format!("offline.{replica_counter}"));
        intent_string(&mut bytes, "2222222222222222");
        bytes.extend_from_slice(&replica_counter.to_le_bytes());
        bytes.push(0);
        bytes.extend_from_slice(&0u64.to_le_bytes());
        bytes.extend_from_slice(&u16::from(base_counter > 0).to_le_bytes());
        if base_counter > 0 {
            intent_string(&mut bytes, "2222222222222222");
            bytes.extend_from_slice(&base_counter.to_le_bytes());
        }
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&(command_bytes.len() as u32).to_le_bytes());
        bytes.extend_from_slice(command_bytes);
        bytes
    }

    fn intent_string(output: &mut Vec<u8>, value: &str) {
        output.extend_from_slice(&(value.len() as u16).to_le_bytes());
        output.extend_from_slice(value.as_bytes());
    }

    fn hex_bytes(value: &str) -> Vec<u8> {
        assert_eq!(value.len() % 2, 0, "fixture hex must contain byte pairs");
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let pair = std::str::from_utf8(pair).expect("ASCII fixture hex");
                u8::from_str_radix(pair, 16).expect("lowercase fixture hex")
            })
            .collect()
    }

    fn lowercase_hex(bytes: &[u8]) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut output = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            output.push(char::from(HEX[(byte >> 4) as usize]));
            output.push(char::from(HEX[(byte & 0x0f) as usize]));
        }
        output
    }

    fn shared_fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../../../contracts/test/fixtures/editable-artifact-spreadsheet-v1.json"
        ))
        .expect("shared OGASC/OGATX/OGACO fixture")
    }

    fn fixture_str<'a>(fixture: &'a Value, key: &str) -> &'a str {
        fixture[key]
            .as_str()
            .unwrap_or_else(|| panic!("fixture field {key}"))
    }

    fn fixture_id(value: &str) -> StableId {
        StableId::from_str(value).expect("fixture stable id")
    }

    fn fixture_replica(value: &str) -> ReplicaId {
        ReplicaId::new(u64::from_str_radix(value, 16).expect("fixture replica"))
            .expect("nonzero fixture replica")
    }

    fn seed_transaction(
        state: &mut CollaborativeWorkbook,
        transaction_id: StableId,
        replica: ReplicaId,
        counter: u64,
        base: CausalFrontier,
        operation_id: StableId,
        command: CollaborationCommand,
    ) {
        let receipt = state
            .apply_transaction(CollaborationTransaction::new(
                TransactionId::from_stable_id(transaction_id),
                CausalDot::new(replica, counter).expect("seed dot"),
                base,
                vec![CollaborationOperation::new(
                    OperationId::from_stable_id(operation_id),
                    command,
                )],
            ))
            .expect("valid fixture seed transaction");
        assert_eq!(receipt.disposition, TransactionDisposition::Applied);
    }

    fn seeded_fixture_state(fixture: &Value) -> CollaborativeWorkbook {
        let own = fixture_replica(fixture_str(fixture, "namespaceHex"));
        let peer = fixture_replica("1111111111111111");
        let existing_sheet = fixture_id("fedcba98765432100000000000000002");
        let creation = OperationId::from_stable_id(fixture_id("0000000000000000aaaaaaaaaaaaaaaa"));
        let generation = SheetGeneration::new(existing_sheet, creation);
        let mut state = CollaborativeWorkbook::new(own.get()).expect("fixture workbook");

        seed_transaction(
            &mut state,
            StableId::from_parts(0, 0x101),
            own,
            1,
            CausalFrontier::new(),
            creation.stable_id(),
            CollaborationCommand::CreateSheet {
                sheet_id: existing_sheet,
                name: "Seed".into(),
                after: None,
            },
        );
        seed_transaction(
            &mut state,
            StableId::from_parts(0, 0x102),
            own,
            2,
            CausalFrontier::from_entries([(own, 1)]).expect("own base"),
            fixture_id("00000000000000002222222222222222"),
            CollaborationCommand::RenameSheet {
                sheet: generation,
                name: "Own rename".into(),
            },
        );
        for counter in 1..=7 {
            let mut entries = vec![(own, 2)];
            if counter > 1 {
                entries.push((peer, counter - 1));
            }
            seed_transaction(
                &mut state,
                StableId::from_parts(0x4444, counter),
                peer,
                counter,
                CausalFrontier::from_entries(entries).expect("peer base"),
                StableId::from_parts(0x3333, counter),
                CollaborationCommand::RenameSheet {
                    sheet: generation,
                    name: format!("Peer rename {counter}"),
                },
            );
        }
        state
    }

    #[test]
    fn identity_derivation_uses_nested_command_count() {
        let commands = encode_spreadsheet_commands(&[SpreadsheetCommand::CreateSheet {
            sheet_id: StableId::from_parts(7, 1),
            name: "Data".into(),
            after: None,
        }])
        .expect("commands");
        let intent = intent(&commands, 1, 0);
        let identities = derive_intent_identities(&intent).expect("identities");
        assert_eq!(identities.operation_ids.len(), 1);
        assert_eq!(identities.request_hash, sha256_text(&sha256_bytes(&intent)));
    }

    #[test]
    fn shared_typescript_rust_fixture_covers_exact_atomic_commit() {
        let fixture = shared_fixture();
        let command_bytes = hex_bytes(fixture_str(&fixture, "commandHex"));
        let decoded_commands = decode_spreadsheet_commands(&command_bytes).expect("OGASC fixture");
        assert_eq!(
            encode_spreadsheet_commands(&decoded_commands.commands).expect("canonical OGASC"),
            command_bytes
        );

        let intent_bytes = hex_bytes(fixture_str(&fixture, "intentHex"));
        let identities = derive_intent_identities(&intent_bytes).expect("OGATX fixture");
        assert_eq!(
            identities.request_hash,
            fixture_str(&fixture, "expectedRequestHash")
        );
        assert_eq!(
            identities.transaction_id.to_string(),
            fixture_str(&fixture, "expectedTransactionId")
        );
        let expected_operation_ids = fixture["expectedOperationIds"]
            .as_array()
            .expect("fixture operation ids")
            .iter()
            .map(|value| value.as_str().expect("operation id"))
            .collect::<Vec<_>>();
        assert_eq!(
            identities
                .operation_ids
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>(),
            expected_operation_ids
        );

        let state = seeded_fixture_state(&fixture);
        let prior_snapshot = encode_collaboration_snapshot(&state).expect("prior snapshot");
        let prior_state_hash = sha256_text(&sha256_bytes(&prior_snapshot));
        let resolved_base = encode_causal_frontier(state.frontier()).expect("resolved base");
        let mut author = CollaborationBindingSession {
            state: Some(state),
            limits: NATIVE_LIMITS,
        };
        let committed = author
            .author_transaction(&intent_bytes, &resolved_base)
            .expect("author shared fixture");
        let resulting_state_hash = author.state_hash().expect("resulting hash");
        let resulting_frontier = author.frontier().expect("resulting frontier");

        assert_eq!(prior_state_hash, fixture_str(&fixture, "priorStateHash"));
        assert_eq!(
            lowercase_hex(&committed),
            fixture_str(&fixture, "committedHex")
        );
        assert_eq!(
            resulting_state_hash,
            fixture_str(&fixture, "resultingStateHash")
        );
        assert_eq!(
            lowercase_hex(&resolved_base),
            fixture_str(&fixture, "resolvedFrontierHex")
        );
        assert_eq!(
            lowercase_hex(&resulting_frontier),
            fixture_str(&fixture, "resultingFrontierHex")
        );

        let decoded_committed = decode_committed_operation(
            &committed,
            MAX_COMMITTED_TRANSACTION_BYTES,
            MAX_CELLS_PER_TRANSACTION,
        )
        .expect("decode canonical committed fixture");
        assert_eq!(
            decoded_committed.transaction.id().stable_id(),
            identities.transaction_id
        );
        assert_eq!(
            decoded_committed.transaction.base(),
            &decode_causal_frontier(&resolved_base).expect("decode base")
        );
        assert_eq!(
            decoded_committed.prior_state_hash,
            sha256_bytes(&prior_snapshot)
        );
        assert_eq!(
            decoded_committed.resulting_state_hash,
            sha256_bytes(&author.snapshot().expect("result snapshot"))
        );

        let mut replay = CollaborationBindingSession {
            state: Some(seeded_fixture_state(&fixture)),
            limits: NATIVE_LIMITS,
        };
        replay
            .apply_committed(&committed)
            .expect("replay shared fixture");
        assert_eq!(
            replay.snapshot().expect("replay snapshot"),
            author.snapshot().expect("author snapshot")
        );
        assert_eq!(
            replay.frontier().expect("replay frontier"),
            resulting_frontier
        );
        assert_eq!(
            replay.state_hash().expect("replay hash"),
            resulting_state_hash
        );
    }

    #[test]
    fn author_replay_snapshot_and_fork_are_identical() {
        let namespace = 0x1111_2222_3333_4444;
        let sheet_id = StableId::from_parts(namespace, 50);
        let commands = encode_spreadsheet_commands(&[SpreadsheetCommand::CreateSheet {
            sheet_id,
            name: "Data".into(),
            after: None,
        }])
        .expect("commands");
        let intent = intent(&commands, 1, 0);
        let empty_frontier = encode_causal_frontier(&CausalFrontier::new()).expect("frontier");
        let namespace_bytes = encode_namespace(namespace);
        let mut author = CollaborationBindingSession::create(&namespace_bytes).expect("author");
        let mut replay = author.fork().expect("fork");
        let committed = author
            .author_transaction(&intent, &empty_frontier)
            .expect("author transaction");
        replay.apply_committed(&committed).expect("replay");
        assert_eq!(
            author.snapshot().expect("author snapshot"),
            replay.snapshot().expect("replay snapshot")
        );
        assert_eq!(
            author.state_hash().expect("author hash"),
            replay.state_hash().expect("replay hash")
        );
        assert_eq!(
            author.frontier().expect("author frontier"),
            replay.frontier().expect("replay frontier")
        );
        assert_eq!(author.revision().expect("revision"), 1);
        assert_eq!(
            author
                .state
                .as_ref()
                .expect("state")
                .workbook()
                .sheet(sheet_id)
                .expect("sheet")
                .name(),
            "Data"
        );
    }

    #[test]
    fn invalid_result_hash_cannot_mutate_replay() {
        let namespace = 99;
        let sheet_id = StableId::from_parts(namespace, 50);
        let commands = encode_spreadsheet_commands(&[SpreadsheetCommand::CreateSheet {
            sheet_id,
            name: "Data".into(),
            after: None,
        }])
        .expect("commands");
        let intent = intent(&commands, 1, 0);
        let base = encode_causal_frontier(&CausalFrontier::new()).expect("base");
        let namespace_bytes = encode_namespace(namespace);
        let mut author = CollaborationBindingSession::create(&namespace_bytes).expect("author");
        let mut committed = author
            .author_transaction(&intent, &base)
            .expect("committed");
        let payload_end = committed.len() - CHECKSUM_BYTES;
        committed[payload_end - 1] ^= 1;
        let checksum = checksum(&committed[..payload_end]);
        committed[payload_end..].copy_from_slice(&checksum.to_le_bytes());
        let mut replay = CollaborationBindingSession::create(&namespace_bytes).expect("replay");
        let before = replay.snapshot().expect("before");
        assert!(matches!(
            replay.apply_committed(&committed),
            Err(BindingError::StateMismatch(_))
        ));
        assert_eq!(replay.snapshot().expect("after"), before);
    }
}
