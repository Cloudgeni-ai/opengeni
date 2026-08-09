//! Runtime-neutral binary ABI shared by the native and browser bindings.
//!
//! The ABI intentionally exposes owned bytes rather than Rust object layouts.
//! Every input is length-bounded before decoding and every successful mutation
//! is atomic. Stateful sessions return compact receipts and materialize the
//! kernel's canonical snapshot bytes only when explicitly requested.

#![forbid(unsafe_code)]

mod collaboration;
mod document;
mod presentation;
mod query;
mod spreadsheet_commands;
mod text_layout;

use core::fmt;
use std::collections::{BTreeMap, BTreeSet};

use opengeni_artifact_kernel::{
    decode_snapshot, encode_snapshot, AtomicBatch, BatchError, BatchReceipt, Cell, CellBlock,
    CellCoord, CellRange, CellValue, Command, DateValue, FormulaError, Number, SnapshotError,
    StableId, ValueError, Workbook, WorkbookError, TILE_EDGE,
};
use sha2::{Digest, Sha256};

pub use collaboration::{
    canonicalize_collaboration_snapshot, canonicalize_collaboration_snapshot_with_limits,
    decode_causal_frontier, derive_intent_identities, encode_causal_frontier,
    CollaborationBindingSession, DerivedIntentIdentities, COLLABORATION_OPERATION_VERSION,
    EDITABLE_ARTIFACT_INTENT_VERSION, MAX_COMMITTED_TRANSACTION_BYTES, MAX_INTENT_BYTES,
};
pub use document::{
    apply_document_commands, apply_document_commands_with_limits, canonicalize_document_snapshot,
    canonicalize_document_snapshot_with_limits, create_document, create_document_with_limits,
    decode_document_command_batch, decode_document_query, decode_document_query_response,
    decode_document_receipt, encode_document_command_batch, encode_document_query,
    encode_document_query_response, query_document, query_document_with_limits,
    DocumentBindingReceipt, DocumentBindingSession, DOCUMENT_COMMAND_VERSION,
    DOCUMENT_QUERY_RESPONSE_VERSION, DOCUMENT_QUERY_VERSION, DOCUMENT_RECEIPT_VERSION,
    MAX_DOCUMENT_COMMANDS, MAX_DOCUMENT_COMMAND_STRING_BYTES, MAX_DOCUMENT_QUERY_BYTES,
    MAX_DOCUMENT_QUERY_RESPONSE_BYTES,
};
pub use presentation::{
    apply_presentation_commands, canonicalize_presentation_snapshot, create_presentation,
    decode_presentation_command_batch, decode_presentation_query_response,
    decode_presentation_receipt, encode_presentation_command_batch,
    encode_presentation_editor_slide_query, encode_presentation_hit_test_query,
    encode_presentation_metadata_query, encode_presentation_slide_catalog_query,
    encode_presentation_viewport_query, encode_resolved_slide_query, query_presentation_snapshot,
    PresentationBindingSession, PresentationEditorSceneNode, PresentationEditorSlideQuery,
    PresentationEditorSlideResponse, PresentationHitTestQuery, PresentationMetadataQuery,
    PresentationMetadataResponse, PresentationQueryKind, PresentationQueryResponse,
    PresentationSlideCatalogItem, PresentationSlideCatalogQuery, PresentationSlideCatalogResponse,
    PresentationSlideLayoutFacts, PresentationViewportQuery, ResolvedSlideQuery,
    ResolvedSlideResponse, MAX_PRESENTATION_COMMANDS, MAX_PRESENTATION_COMMAND_BYTES,
    MAX_PRESENTATION_QUERY_BYTES, MAX_PRESENTATION_QUERY_TEXT_BYTES,
    MAX_PRESENTATION_RESPONSE_BYTES, MAX_PRESENTATION_SLIDES, PRESENTATION_COMMAND_VERSION,
    PRESENTATION_QUERY_VERSION, PRESENTATION_RESPONSE_VERSION,
};
pub use query::{
    decode_query_response, encode_viewport_query, encode_workbook_metadata_query,
    ArtifactQueryKind, ArtifactQueryResponse, SheetMetadata, ViewportCell, ViewportQuery,
    ViewportResponse, WorkbookMetadataQuery, WorkbookMetadataResponse, MAX_METADATA_SCANNED_CELLS,
    MAX_METADATA_SHEETS, MAX_QUERY_ENVELOPE_BYTES, MAX_QUERY_RESPONSE_BYTES, MAX_VIEWPORT_AREA,
    MAX_VIEWPORT_CELLS, QUERY_SCHEMA_VERSION,
};
pub use spreadsheet_commands::{
    MAX_SPREADSHEET_COMMANDS, MAX_SPREADSHEET_COMMAND_BYTES, MAX_SPREADSHEET_COMMAND_CELLS,
    MAX_SPREADSHEET_COMMAND_STRING_BYTES, SPREADSHEET_COMMAND_VERSION,
};
pub use text_layout::{
    canonicalize_render_patch, canonicalize_render_tile, decode_text_layout_request,
    encode_text_layout_font_bundle, encode_text_layout_request, layout_text,
    TextLayoutBindingSession, TextLayoutFontAsset, TextLayoutProtocolLimits,
    NATIVE_TEXT_LAYOUT_LIMITS, TEXT_LAYOUT_FONT_BUNDLE_VERSION, TEXT_LAYOUT_REQUEST_VERSION,
    TEXT_LAYOUT_RESPONSE_VERSION, WASM_TEXT_LAYOUT_LIMITS,
};

pub const ABI_VERSION: u16 = 1;
pub const COMMAND_SCHEMA_VERSION: u16 = 1;
pub const MAX_COMMAND_ENVELOPE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_SNAPSHOT_ENVELOPE_BYTES: usize = 512 * 1024 * 1024 + 28;
pub const MAX_COMMANDS: usize = 10_000;
pub const MAX_CELLS_PER_BATCH: usize = 4_000_000;
pub const MAX_STRING_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BindingLimits {
    pub max_command_bytes: usize,
    pub max_snapshot_bytes: usize,
    pub max_cells_per_batch: usize,
    /// Permits an exact snapshot-size probe when the conservative growth bound
    /// cannot prove the post-transaction snapshot fits. The probe is guarded by
    /// a touched-data journal; it never clones the complete workbook.
    pub allow_boundary_probe: bool,
}

pub const NATIVE_LIMITS: BindingLimits = BindingLimits {
    max_command_bytes: MAX_COMMAND_ENVELOPE_BYTES,
    max_snapshot_bytes: MAX_SNAPSHOT_ENVELOPE_BYTES,
    max_cells_per_batch: MAX_CELLS_PER_BATCH,
    allow_boundary_probe: true,
};

/// WebAssembly uses a deliberately smaller working-set contract. The JS input
/// copy, decoded model, and returned Uint8Array coexist inside a 32-bit Wasm
/// process; accepting the native 512 MiB boundary would make valid input able
/// to trap the runtime before Rust could return a typed error.
pub const WASM_LIMITS: BindingLimits = BindingLimits {
    max_command_bytes: 8 * 1024 * 1024,
    max_snapshot_bytes: 64 * 1024 * 1024,
    max_cells_per_batch: 500_000,
    allow_boundary_probe: false,
};

const COMMAND_MAGIC: [u8; 8] = *b"OGAKC001";
const NAMESPACE_MAGIC: [u8; 8] = *b"OGAKN001";
const RECEIPT_MAGIC: [u8; 8] = *b"OGAKR001";
const HEADER_BYTES: usize = 8 + 2 + 2 + 4 + 8;
const CHECKSUM_BYTES: usize = 8;
const NAMESPACE_BYTES: usize = 8 + 2 + 2 + 8 + CHECKSUM_BYTES;

const CAPABILITIES: &[u8] = br#"{"abiVersion":1,"buildIdentityFormat":"utf8","canonicalStateHash":"sha256:canonical-snapshot","collaboration":true,"collaborationSnapshotVersion":1,"commandSchemaVersion":1,"committedTransactionVersion":1,"document":true,"documentCommandVersion":1,"documentQueryResponseVersion":1,"documentQueryVersion":1,"documentReceiptVersion":1,"documentSnapshotVersion":1,"documentStatefulSessions":true,"editableArtifactIntentVersion":1,"kernelSnapshotVersion":1,"maxCellsPerBatch":4000000,"maxCommandBytes":67108864,"maxCommands":10000,"maxCommittedTransactionBytes":8388608,"maxDocumentCommandBytes":67108864,"maxDocumentCommands":4096,"maxDocumentQueryBytes":256,"maxDocumentQueryResponseBytes":8388608,"maxDocumentSnapshotBytes":268435508,"maxIntentBytes":5242880,"maxMetadataScannedCells":4000000,"maxMetadataSheets":10000,"maxPresentationCommandBytes":4194304,"maxPresentationQueryBytes":96,"maxPresentationResponseBytes":8388608,"maxPresentationSnapshotBytes":268435456,"maxQueryBytes":68,"maxQueryResponseBytes":8388608,"maxSnapshotBytes":536870940,"maxSpreadsheetCommandBytes":4194304,"maxTextLayoutFontBundleBytes":536870912,"maxTextLayoutRequestBytes":8388608,"maxTextLayoutResponseBytes":67108864,"maxViewportArea":1048576,"maxViewportCells":262144,"presentation":true,"presentationCommandVersion":1,"presentationQueryResponseVersion":1,"presentationQueryVersion":1,"presentationSnapshotVersion":1,"presentationStatefulSessions":true,"queryResponseVersion":1,"queryVersion":1,"receiptSchemaVersion":1,"retainedRenderPatchVersion":1,"retainedRenderTileVersion":1,"safeRust":true,"sessionForks":true,"spreadsheetCommandVersion":1,"statefulSessions":true,"textLayout":true,"textLayoutFontBundleVersion":1,"textLayoutRequestVersion":1,"textLayoutResponseVersion":1,"textLayoutStatefulSessions":true,"transport":"bounded-uint8array","workbookMetadataQueries":true}"#;
const BUILD_IDENTITY: &[u8] = concat!(
    "opengeni-artifact-kernel/",
    env!("CARGO_PKG_VERSION"),
    ";abi=1;command=1;query=1;snapshot=1;document-snapshot=1;document-command=1;document-query=1;presentation-snapshot=1;presentation-command=1;presentation-query=1;text-layout-fonts=1;text-layout-request=1;text-layout-response=1;render-tile=1;render-patch=1;source=",
    env!("OPENGENI_ARTIFACT_KERNEL_SOURCE_ID"),
    ";toolchain=",
    env!("OPENGENI_ARTIFACT_KERNEL_TOOLCHAIN_ID"),
)
.as_bytes();

#[must_use]
pub const fn capabilities() -> &'static [u8] {
    CAPABILITIES
}

/// Compile-time binding surface represented by one capability envelope.
///
/// Native bindings expose the full surface. Browser packages may split the
/// same kernel into modality-specific modules so an editor downloads only the
/// code it can execute; absent modalities remain explicit `false` capability
/// fields rather than disappearing from the versioned envelope.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BindingFeatures {
    /// Spreadsheet collaboration/session ABI.
    pub spreadsheet: bool,
    /// Structured-document ABI.
    pub document: bool,
    /// Presentation ABI.
    pub presentation: bool,
    /// Font shaping and retained-render ABI.
    pub text_layout: bool,
}

/// Complete feature set used by native and backwards-compatible bindings.
pub const ALL_BINDING_FEATURES: BindingFeatures = BindingFeatures {
    spreadsheet: true,
    document: true,
    presentation: true,
    text_layout: true,
};

#[must_use]
pub fn capabilities_for(limits: BindingLimits) -> Vec<u8> {
    capabilities_for_features(limits, ALL_BINDING_FEATURES)
}

/// Returns canonical capabilities for an exact compiled binding surface.
#[must_use]
pub fn capabilities_for_features(limits: BindingLimits, features: BindingFeatures) -> Vec<u8> {
    let max_document_command_bytes = limits.max_command_bytes.min(MAX_COMMAND_ENVELOPE_BYTES);
    let max_document_snapshot_bytes = limits
        .max_snapshot_bytes
        .min(opengeni_artifact_kernel::document::MAX_DOCUMENT_SNAPSHOT_BYTES);
    let max_presentation_command_bytes =
        limits.max_command_bytes.min(MAX_PRESENTATION_COMMAND_BYTES);
    let max_presentation_response_bytes = limits
        .max_command_bytes
        .min(MAX_PRESENTATION_RESPONSE_BYTES);
    let max_presentation_snapshot_bytes = limits
        .max_snapshot_bytes
        .min(opengeni_artifact_kernel::presentation::MAX_PRESENTATION_SNAPSHOT_BYTES);
    let text_limits = if limits == WASM_LIMITS {
        WASM_TEXT_LAYOUT_LIMITS
    } else {
        NATIVE_TEXT_LAYOUT_LIMITS
    };
    format!(
        "{{\"abiVersion\":1,\"buildIdentityFormat\":\"utf8\",\"canonicalStateHash\":\"sha256:canonical-snapshot\",\"collaboration\":{},\"collaborationSnapshotVersion\":1,\"commandSchemaVersion\":1,\"committedTransactionVersion\":1,\"document\":{},\"documentCommandVersion\":1,\"documentQueryResponseVersion\":1,\"documentQueryVersion\":1,\"documentReceiptVersion\":1,\"documentSnapshotVersion\":1,\"documentStatefulSessions\":{},\"editableArtifactIntentVersion\":1,\"kernelSnapshotVersion\":1,\"maxCellsPerBatch\":{},\"maxCommandBytes\":{},\"maxCommands\":10000,\"maxCommittedTransactionBytes\":8388608,\"maxDocumentCommandBytes\":{},\"maxDocumentCommands\":4096,\"maxDocumentQueryBytes\":256,\"maxDocumentQueryResponseBytes\":8388608,\"maxDocumentSnapshotBytes\":{},\"maxIntentBytes\":5242880,\"maxMetadataScannedCells\":4000000,\"maxMetadataSheets\":10000,\"maxPresentationCommandBytes\":{},\"maxPresentationQueryBytes\":96,\"maxPresentationResponseBytes\":{},\"maxPresentationSnapshotBytes\":{},\"maxQueryBytes\":68,\"maxQueryResponseBytes\":8388608,\"maxSnapshotBytes\":{},\"maxSpreadsheetCommandBytes\":4194304,\"maxTextLayoutFontBundleBytes\":{},\"maxTextLayoutRequestBytes\":{},\"maxTextLayoutResponseBytes\":{},\"maxViewportArea\":1048576,\"maxViewportCells\":262144,\"presentation\":{},\"presentationCommandVersion\":1,\"presentationQueryResponseVersion\":1,\"presentationQueryVersion\":1,\"presentationSnapshotVersion\":1,\"presentationStatefulSessions\":{},\"queryResponseVersion\":1,\"queryVersion\":1,\"receiptSchemaVersion\":1,\"retainedRenderPatchVersion\":1,\"retainedRenderTileVersion\":1,\"safeRust\":true,\"sessionForks\":{},\"spreadsheetCommandVersion\":1,\"statefulSessions\":{},\"textLayout\":{},\"textLayoutFontBundleVersion\":1,\"textLayoutRequestVersion\":1,\"textLayoutResponseVersion\":1,\"textLayoutStatefulSessions\":{},\"transport\":\"bounded-uint8array\",\"workbookMetadataQueries\":{}}}",
        features.spreadsheet,
        features.document,
        features.document,
        limits.max_cells_per_batch,
        limits.max_command_bytes,
        max_document_command_bytes,
        max_document_snapshot_bytes,
        max_presentation_command_bytes,
        max_presentation_response_bytes,
        max_presentation_snapshot_bytes,
        limits.max_snapshot_bytes,
        text_limits.max_font_bundle_bytes,
        text_limits.max_request_bytes,
        text_limits.max_response_bytes,
        features.presentation,
        features.presentation,
        features.spreadsheet || features.document || features.presentation || features.text_layout,
        features.spreadsheet || features.document || features.presentation || features.text_layout,
        features.text_layout,
        features.text_layout,
        features.spreadsheet,
    )
    .into_bytes()
}

#[must_use]
pub const fn build_identity() -> &'static [u8] {
    BUILD_IDENTITY
}

/// Encodes a host-generated, persisted 64-bit replica namespace. Bindings do
/// not generate entropy themselves, which keeps identity policy at the host.
#[must_use]
pub fn encode_namespace(namespace: u64) -> Vec<u8> {
    let mut output = Vec::with_capacity(NAMESPACE_BYTES);
    output.extend_from_slice(&NAMESPACE_MAGIC);
    output.extend_from_slice(&ABI_VERSION.to_le_bytes());
    output.extend_from_slice(&0u16.to_le_bytes());
    output.extend_from_slice(&namespace.to_le_bytes());
    output.extend_from_slice(&checksum(&output).to_le_bytes());
    output
}

pub fn create_workbook(namespace_envelope: &[u8]) -> Result<Vec<u8>, BindingError> {
    create_workbook_with_limits(namespace_envelope, NATIVE_LIMITS)
}

pub fn create_workbook_with_limits(
    namespace_envelope: &[u8],
    limits: BindingLimits,
) -> Result<Vec<u8>, BindingError> {
    BindingSession::create_with_limits(namespace_envelope, limits)?.snapshot()
}

/// Applies one complete batch transactionally and returns canonical snapshot
/// bytes. Invalid input or any failed command leaves the input bytes untouched.
pub fn apply_commands(snapshot: &[u8], command_envelope: &[u8]) -> Result<Vec<u8>, BindingError> {
    apply_commands_with_limits(snapshot, command_envelope, NATIVE_LIMITS)
}

pub fn apply_commands_with_limits(
    snapshot: &[u8],
    command_envelope: &[u8],
    limits: BindingLimits,
) -> Result<Vec<u8>, BindingError> {
    let mut session = BindingSession::open_with_limits(snapshot, limits)?;
    session.apply_commands(command_envelope)?;
    session.snapshot()
}

/// Strictly validates and re-encodes a snapshot. This is useful at trust
/// boundaries and guarantees callers receive canonical bytes.
pub fn canonicalize_snapshot(snapshot: &[u8]) -> Result<Vec<u8>, BindingError> {
    canonicalize_snapshot_with_limits(snapshot, NATIVE_LIMITS)
}

pub fn canonicalize_snapshot_with_limits(
    snapshot: &[u8],
    limits: BindingLimits,
) -> Result<Vec<u8>, BindingError> {
    BindingSession::open_with_limits(snapshot, limits)?.snapshot()
}

/// Executes one bounded OGAKQ001 read against a canonical snapshot.
pub fn query(snapshot: &[u8], query_envelope: &[u8]) -> Result<Vec<u8>, BindingError> {
    query_with_limits(snapshot, query_envelope, NATIVE_LIMITS)
}

pub fn query_with_limits(
    snapshot: &[u8],
    query_envelope: &[u8],
    limits: BindingLimits,
) -> Result<Vec<u8>, BindingError> {
    BindingSession::open_with_limits(snapshot, limits)?.query(query_envelope)
}

/// A hot-path workbook handle. It decodes a snapshot once, applies many
/// bounded command envelopes in place, and materializes canonical bytes only
/// when requested. The stateless functions remain the authoritative
/// trust-boundary primitive for server transactions.
#[derive(Debug)]
pub struct BindingSession {
    workbook: Option<Workbook>,
    snapshot_size_upper_bound: usize,
    limits: BindingLimits,
}

impl BindingSession {
    pub fn create(namespace_envelope: &[u8]) -> Result<Self, BindingError> {
        Self::create_with_limits(namespace_envelope, NATIVE_LIMITS)
    }

    pub fn create_with_limits(
        namespace_envelope: &[u8],
        limits: BindingLimits,
    ) -> Result<Self, BindingError> {
        validate_limits(limits)?;
        let namespace = decode_namespace(namespace_envelope)?;
        let workbook =
            Workbook::new(namespace).map_err(|error| BindingError::Kernel(error.to_string()))?;
        let snapshot_size_upper_bound = encode_snapshot(&workbook)
            .map_err(BindingError::Snapshot)?
            .len();
        if snapshot_size_upper_bound > limits.max_snapshot_bytes {
            return Err(BindingError::Limit("snapshot envelope"));
        }
        Ok(Self {
            workbook: Some(workbook),
            snapshot_size_upper_bound,
            limits,
        })
    }

    pub fn open(snapshot: &[u8]) -> Result<Self, BindingError> {
        Self::open_with_limits(snapshot, NATIVE_LIMITS)
    }

    pub fn open_with_limits(snapshot: &[u8], limits: BindingLimits) -> Result<Self, BindingError> {
        validate_limits(limits)?;
        check_snapshot_bound(snapshot, limits.max_snapshot_bytes)?;
        let workbook = decode_snapshot(snapshot).map_err(map_snapshot_error)?;
        validate_replica_namespace(snapshot, &workbook)?;
        validate_spreadsheet_projection(&workbook, None)?;
        Ok(Self {
            workbook: Some(workbook),
            snapshot_size_upper_bound: snapshot.len(),
            limits,
        })
    }

    pub fn apply_commands(&mut self, command_envelope: &[u8]) -> Result<Vec<u8>, BindingError> {
        self.ensure_open()?;
        if command_envelope.len() > self.limits.max_command_bytes {
            return Err(BindingError::Limit("command envelope"));
        }
        let decoded =
            decode_command_batch_with_stats(command_envelope, self.limits.max_cells_per_batch)?;
        validate_spreadsheet_projection(
            self.workbook.as_ref().ok_or(BindingError::Closed)?,
            Some(&decoded.batch),
        )?;
        let growth_bound = command_envelope
            .len()
            .checked_add(
                decoded
                    .cell_count
                    .checked_mul(14)
                    .ok_or(BindingError::Limit("snapshot growth"))?,
            )
            .and_then(|value| value.checked_add(decoded.batch.commands().len() * 4))
            .ok_or(BindingError::Limit("snapshot growth"))?;

        if self
            .snapshot_size_upper_bound
            .checked_add(growth_bound)
            .is_none_or(|size| size > self.limits.max_snapshot_bytes)
        {
            self.snapshot_size_upper_bound = self.snapshot()?.len();
        }

        let needs_boundary_probe = self
            .snapshot_size_upper_bound
            .checked_add(growth_bound)
            .is_none_or(|size| size > self.limits.max_snapshot_bytes);
        if needs_boundary_probe && !self.limits.allow_boundary_probe {
            return Err(BindingError::Limit("snapshot growth"));
        }
        let receipt = if needs_boundary_probe {
            let transaction = self
                .workbook
                .as_mut()
                .ok_or(BindingError::Closed)?
                .begin_batch(&decoded.batch)
                .map_err(BindingError::Batch)?;
            let snapshot =
                encode_snapshot(transaction.workbook()).map_err(BindingError::Snapshot)?;
            check_snapshot_bound(&snapshot, self.limits.max_snapshot_bytes)?;
            self.snapshot_size_upper_bound = snapshot.len();
            transaction.commit()
        } else {
            let receipt = self
                .workbook
                .as_mut()
                .ok_or(BindingError::Closed)?
                .apply_batch(&decoded.batch)
                .map_err(BindingError::Batch)?;
            self.snapshot_size_upper_bound = self
                .snapshot_size_upper_bound
                .checked_add(growth_bound)
                .ok_or(BindingError::Limit("snapshot growth"))?;
            receipt
        };
        Ok(encode_receipt(receipt))
    }

    pub fn snapshot(&self) -> Result<Vec<u8>, BindingError> {
        let snapshot = encode_snapshot(self.workbook.as_ref().ok_or(BindingError::Closed)?)
            .map_err(BindingError::Snapshot)?;
        check_snapshot_bound(&snapshot, self.limits.max_snapshot_bytes)?;
        Ok(snapshot)
    }

    pub fn revision(&self) -> Result<u64, BindingError> {
        Ok(self
            .workbook
            .as_ref()
            .ok_or(BindingError::Closed)?
            .revision())
    }

    /// Executes one bounded viewport or workbook-metadata read without
    /// serializing the in-memory model.
    pub fn query(&self, query_envelope: &[u8]) -> Result<Vec<u8>, BindingError> {
        query::query_workbook(
            self.workbook.as_ref().ok_or(BindingError::Closed)?,
            query_envelope,
            false,
            |_| None,
        )
    }

    /// Creates an independent in-memory branch without serializing or decoding
    /// a snapshot. Mutations to either session cannot affect the other.
    pub fn fork(&self) -> Result<Self, BindingError> {
        Ok(Self {
            workbook: Some(self.workbook.as_ref().ok_or(BindingError::Closed)?.clone()),
            snapshot_size_upper_bound: self.snapshot_size_upper_bound,
            limits: self.limits,
        })
    }

    /// Hashes the exact canonical snapshot without copying it across the host
    /// boundary. Collaboration frontier metadata is intentionally separate.
    pub fn state_hash(&self) -> Result<String, BindingError> {
        let snapshot = self.snapshot()?;
        let digest = Sha256::digest(snapshot);
        let mut output = String::with_capacity(7 + 64);
        output.push_str("sha256:");
        const HEX: &[u8; 16] = b"0123456789abcdef";
        for byte in digest {
            output.push(char::from(HEX[(byte >> 4) as usize]));
            output.push(char::from(HEX[(byte & 0x0f) as usize]));
        }
        Ok(output)
    }

    pub fn close(&mut self) {
        self.workbook = None;
        self.snapshot_size_upper_bound = 0;
    }

    #[must_use]
    pub const fn is_closed(&self) -> bool {
        self.workbook.is_none()
    }

    fn ensure_open(&self) -> Result<(), BindingError> {
        if self.is_closed() {
            Err(BindingError::Closed)
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BindingReceipt {
    pub revision: u64,
    pub command_count: u32,
    pub written_cells: u64,
    pub cleared_cells: u64,
}

pub fn decode_receipt(bytes: &[u8]) -> Result<BindingReceipt, BindingError> {
    const RECEIPT_BYTES: usize = 8 + 2 + 2 + 8 + 4 + 8 + 8 + CHECKSUM_BYTES;
    if bytes.len() != RECEIPT_BYTES {
        return Err(if bytes.len() < RECEIPT_BYTES {
            BindingError::Truncated
        } else {
            BindingError::TrailingBytes
        });
    }
    if bytes[..8] != RECEIPT_MAGIC {
        return Err(BindingError::BadMagic("receipt"));
    }
    let version = read_u16(&bytes[8..10])?;
    if version != ABI_VERSION {
        return Err(BindingError::UnsupportedVersion(version));
    }
    if read_u16(&bytes[10..12])? != 0 {
        return Err(BindingError::NonCanonical("reserved receipt bits are set"));
    }
    let expected_checksum = read_u64(&bytes[40..48])?;
    if checksum(&bytes[..40]) != expected_checksum {
        return Err(BindingError::ChecksumMismatch);
    }
    Ok(BindingReceipt {
        revision: read_u64(&bytes[12..20])?,
        command_count: read_u32(&bytes[20..24])?,
        written_cells: read_u64(&bytes[24..32])?,
        cleared_cells: read_u64(&bytes[32..40])?,
    })
}

pub fn encode_command_batch(batch: &AtomicBatch) -> Result<Vec<u8>, BindingError> {
    if batch.commands().len() > MAX_COMMANDS {
        return Err(BindingError::Limit("command count"));
    }
    let mut payload = Encoder::new(MAX_COMMAND_ENVELOPE_BYTES - HEADER_BYTES - CHECKSUM_BYTES);
    let mut cell_count = 0usize;
    for command in batch.commands() {
        match command {
            Command::CreateSheet { id, name } => {
                payload.u8(0)?;
                payload.id(*id)?;
                payload.string(name)?;
            }
            Command::RenameSheet { id, name } => {
                payload.u8(1)?;
                payload.id(*id)?;
                payload.string(name)?;
            }
            Command::DeleteSheet { id } => {
                payload.u8(2)?;
                payload.id(*id)?;
            }
            Command::SetCells {
                sheet_id,
                anchor,
                cells,
            } => {
                cell_count = cell_count
                    .checked_add(cells.cells().len())
                    .ok_or(BindingError::Limit("cell count"))?;
                if cell_count > MAX_CELLS_PER_BATCH {
                    return Err(BindingError::Limit("cell count"));
                }
                payload.u8(3)?;
                payload.id(*sheet_id)?;
                payload.u32(anchor.row)?;
                payload.u32(anchor.column)?;
                payload.u32(cells.rows())?;
                payload.u32(cells.columns())?;
                for cell in cells.cells() {
                    payload.cell(cell)?;
                }
            }
            Command::ClearRange { sheet_id, range } => {
                payload.u8(4)?;
                payload.id(*sheet_id)?;
                payload.u32(range.start.row)?;
                payload.u32(range.start.column)?;
                payload.u32(range.end.row)?;
                payload.u32(range.end.column)?;
            }
        }
    }

    let command_count =
        u32::try_from(batch.commands().len()).map_err(|_| BindingError::Limit("command count"))?;
    let payload = payload.finish();
    let payload_len = u64::try_from(payload.len()).map_err(|_| BindingError::Limit("payload"))?;
    let capacity = HEADER_BYTES
        .checked_add(payload.len())
        .and_then(|value| value.checked_add(CHECKSUM_BYTES))
        .ok_or(BindingError::Limit("command envelope"))?;
    if capacity > MAX_COMMAND_ENVELOPE_BYTES {
        return Err(BindingError::Limit("command envelope"));
    }
    let mut output = Vec::with_capacity(capacity);
    output.extend_from_slice(&COMMAND_MAGIC);
    output.extend_from_slice(&COMMAND_SCHEMA_VERSION.to_le_bytes());
    output.extend_from_slice(&0u16.to_le_bytes());
    output.extend_from_slice(&command_count.to_le_bytes());
    output.extend_from_slice(&payload_len.to_le_bytes());
    output.extend_from_slice(&payload);
    output.extend_from_slice(&checksum(&output).to_le_bytes());
    Ok(output)
}

pub fn decode_command_batch(bytes: &[u8]) -> Result<AtomicBatch, BindingError> {
    decode_command_batch_with_stats(bytes, MAX_CELLS_PER_BATCH).map(|decoded| decoded.batch)
}

struct DecodedBatch {
    batch: AtomicBatch,
    cell_count: usize,
}

fn decode_command_batch_with_stats(
    bytes: &[u8],
    max_cells: usize,
) -> Result<DecodedBatch, BindingError> {
    if bytes.len() > MAX_COMMAND_ENVELOPE_BYTES {
        return Err(BindingError::Limit("command envelope"));
    }
    if bytes.len() < HEADER_BYTES + CHECKSUM_BYTES {
        return Err(BindingError::Truncated);
    }
    if bytes[..8] != COMMAND_MAGIC {
        return Err(BindingError::BadMagic("command"));
    }
    let version = read_u16(&bytes[8..10])?;
    if version != COMMAND_SCHEMA_VERSION {
        return Err(BindingError::UnsupportedVersion(version));
    }
    if read_u16(&bytes[10..12])? != 0 {
        return Err(BindingError::NonCanonical(
            "reserved command header bits are set",
        ));
    }
    let command_count = usize::try_from(read_u32(&bytes[12..16])?)
        .map_err(|_| BindingError::Limit("command count"))?;
    if command_count > MAX_COMMANDS {
        return Err(BindingError::Limit("command count"));
    }
    let payload_len = usize::try_from(read_u64(&bytes[16..24])?)
        .map_err(|_| BindingError::Limit("command payload"))?;
    let payload_end = HEADER_BYTES
        .checked_add(payload_len)
        .ok_or(BindingError::Limit("command payload"))?;
    let expected_len = payload_end
        .checked_add(CHECKSUM_BYTES)
        .ok_or(BindingError::Limit("command envelope"))?;
    if bytes.len() != expected_len {
        return Err(if bytes.len() < expected_len {
            BindingError::Truncated
        } else {
            BindingError::TrailingBytes
        });
    }
    let expected_checksum = read_u64(&bytes[payload_end..expected_len])?;
    if checksum(&bytes[..payload_end]) != expected_checksum {
        return Err(BindingError::ChecksumMismatch);
    }

    let mut decoder = Decoder::new(&bytes[HEADER_BYTES..payload_end]);
    // The shortest command is a one-byte delete tag plus one StableId.
    if command_count > decoder.remaining() / 17 {
        return Err(BindingError::Truncated);
    }
    let mut commands = Vec::new();
    commands
        .try_reserve_exact(command_count)
        .map_err(|_| BindingError::Limit("command count"))?;
    let mut cell_count = 0usize;
    for _ in 0..command_count {
        let command = match decoder.u8()? {
            0 => Command::CreateSheet {
                id: decoder.id()?,
                name: decoder.string()?,
            },
            1 => Command::RenameSheet {
                id: decoder.id()?,
                name: decoder.string()?,
            },
            2 => Command::DeleteSheet { id: decoder.id()? },
            3 => {
                let sheet_id = decoder.id()?;
                let anchor = CellCoord::new(decoder.u32()?, decoder.u32()?);
                let rows = decoder.u32()?;
                let columns = decoder.u32()?;
                let expected = usize::try_from(rows)
                    .ok()
                    .and_then(|rows| {
                        usize::try_from(columns)
                            .ok()
                            .and_then(|columns| rows.checked_mul(columns))
                    })
                    .ok_or(BindingError::Limit("cell block dimensions"))?;
                cell_count = cell_count
                    .checked_add(expected)
                    .ok_or(BindingError::Limit("cell count"))?;
                if expected == 0 || cell_count > max_cells {
                    return Err(BindingError::Limit("cell count"));
                }
                if anchor.row.checked_add(rows - 1).is_none()
                    || anchor.column.checked_add(columns - 1).is_none()
                {
                    return Err(BindingError::NonCanonical(
                        "cell block extent exceeds uint32 coordinates",
                    ));
                }
                // Every encoded cell needs at least a formula tag and value tag.
                if expected > decoder.remaining() / 2 {
                    return Err(BindingError::Truncated);
                }
                let mut cells = Vec::new();
                cells
                    .try_reserve_exact(expected)
                    .map_err(|_| BindingError::Limit("cell count"))?;
                for _ in 0..expected {
                    cells.push(decoder.cell()?);
                }
                Command::SetCells {
                    sheet_id,
                    anchor,
                    cells: CellBlock::new(rows, columns, cells).map_err(|error| {
                        BindingError::Kernel(format!("invalid cell block: {error:?}"))
                    })?,
                }
            }
            4 => {
                let sheet_id = decoder.id()?;
                let first = CellCoord::new(decoder.u32()?, decoder.u32()?);
                let second = CellCoord::new(decoder.u32()?, decoder.u32()?);
                if first.row > second.row || first.column > second.column {
                    return Err(BindingError::NonCanonical(
                        "clear-range endpoints are not ordered",
                    ));
                }
                Command::ClearRange {
                    sheet_id,
                    range: CellRange::new(first, second),
                }
            }
            tag => return Err(BindingError::InvalidTag(tag)),
        };
        commands.push(command);
    }
    if !decoder.is_empty() {
        return Err(BindingError::TrailingBytes);
    }
    Ok(DecodedBatch {
        batch: AtomicBatch::from_commands(commands),
        cell_count,
    })
}

fn decode_namespace(bytes: &[u8]) -> Result<u64, BindingError> {
    if bytes.len() != NAMESPACE_BYTES {
        return Err(if bytes.len() < NAMESPACE_BYTES {
            BindingError::Truncated
        } else {
            BindingError::TrailingBytes
        });
    }
    if bytes[..8] != NAMESPACE_MAGIC {
        return Err(BindingError::BadMagic("namespace"));
    }
    let version = read_u16(&bytes[8..10])?;
    if version != ABI_VERSION {
        return Err(BindingError::UnsupportedVersion(version));
    }
    if read_u16(&bytes[10..12])? != 0 {
        return Err(BindingError::NonCanonical(
            "reserved namespace bits are set",
        ));
    }
    let expected_checksum = read_u64(&bytes[20..28])?;
    if checksum(&bytes[..20]) != expected_checksum {
        return Err(BindingError::ChecksumMismatch);
    }
    let namespace = read_u64(&bytes[12..20])?;
    if namespace == 0 {
        return Err(BindingError::InvalidNamespace);
    }
    Ok(namespace)
}

fn validate_replica_namespace(snapshot: &[u8], workbook: &Workbook) -> Result<(), BindingError> {
    // Snapshot v1 starts with a 20-byte header, then the little-endian root id,
    // revision, and persisted allocator namespace. The kernel decoder has
    // already validated the complete envelope before this invariant check.
    let root_namespace = read_u64(snapshot.get(28..36).ok_or(BindingError::Truncated)?)?;
    let allocator_namespace = read_u64(snapshot.get(44..52).ok_or(BindingError::Truncated)?)?;
    if root_namespace == 0
        || allocator_namespace == 0
        || root_namespace != allocator_namespace
        || root_namespace != workbook.id().namespace()
    {
        return Err(BindingError::InvalidNamespace);
    }
    Ok(())
}

fn map_snapshot_error(error: SnapshotError) -> BindingError {
    if matches!(
        error,
        SnapshotError::Workbook(WorkbookError::InvalidIdAllocator)
    ) {
        BindingError::InvalidNamespace
    } else {
        BindingError::Snapshot(error)
    }
}

const MAX_MODEL_SHEETS: usize = 1_000_000;
const MAX_MODEL_TILES_PER_SHEET: usize = 16_000_000;

fn validate_spreadsheet_projection(
    workbook: &Workbook,
    batch: Option<&AtomicBatch>,
) -> Result<(), BindingError> {
    let mut catalog = BTreeMap::new();
    let mut names = BTreeSet::new();
    for sheet in workbook.sheets() {
        validate_projection_sheet_name(sheet.name())?;
        let normalized = sheet.name().to_lowercase();
        if !names.insert(normalized) {
            return Err(BindingError::Projection(
                "worksheet names must be unique without regard to case".into(),
            ));
        }
        catalog.insert(sheet.id(), (sheet.name().to_owned(), sheet.tile_count()));
    }
    if catalog.len() > MAX_MODEL_SHEETS {
        return Err(BindingError::Projection(
            "worksheet count exceeds snapshot decoder bound".into(),
        ));
    }

    let Some(batch) = batch else {
        return Ok(());
    };
    for command in batch.commands() {
        match command {
            Command::CreateSheet { id, name } => {
                validate_projection_sheet_name(name)?;
                if catalog.contains_key(id) {
                    continue;
                }
                let normalized = name.to_lowercase();
                if !names.insert(normalized) {
                    return Err(BindingError::Projection(
                        "worksheet names must be unique without regard to case".into(),
                    ));
                }
                catalog.insert(*id, (name.clone(), 0));
                if catalog.len() > MAX_MODEL_SHEETS {
                    return Err(BindingError::Projection(
                        "worksheet count exceeds snapshot decoder bound".into(),
                    ));
                }
            }
            Command::RenameSheet { id, name } => {
                validate_projection_sheet_name(name)?;
                let Some((previous, tiles)) = catalog.get(id).cloned() else {
                    continue;
                };
                names.remove(&previous.to_lowercase());
                let normalized = name.to_lowercase();
                if !names.insert(normalized) {
                    return Err(BindingError::Projection(
                        "worksheet names must be unique without regard to case".into(),
                    ));
                }
                catalog.insert(*id, (name.clone(), tiles));
            }
            Command::DeleteSheet { id } => {
                if let Some((name, _)) = catalog.remove(id) {
                    names.remove(&name.to_lowercase());
                }
            }
            Command::SetCells {
                sheet_id,
                anchor,
                cells,
            } => {
                let Some((_, tile_upper_bound)) = catalog.get_mut(sheet_id) else {
                    continue;
                };
                let end_row = anchor
                    .row
                    .checked_add(cells.rows().saturating_sub(1))
                    .ok_or_else(|| BindingError::Projection("cell block row overflow".into()))?;
                let end_column = anchor
                    .column
                    .checked_add(cells.columns().saturating_sub(1))
                    .ok_or_else(|| BindingError::Projection("cell block column overflow".into()))?;
                let tile_rows = u64::from(end_row / TILE_EDGE - anchor.row / TILE_EDGE + 1);
                let tile_columns =
                    u64::from(end_column / TILE_EDGE - anchor.column / TILE_EDGE + 1);
                let touched = usize::try_from(
                    tile_rows
                        .checked_mul(tile_columns)
                        .ok_or_else(|| BindingError::Projection("tile span overflow".into()))?,
                )
                .map_err(|_| BindingError::Projection("tile span overflow".into()))?;
                *tile_upper_bound = tile_upper_bound
                    .checked_add(touched)
                    .ok_or_else(|| BindingError::Projection("tile count overflow".into()))?;
                if *tile_upper_bound > MAX_MODEL_TILES_PER_SHEET {
                    return Err(BindingError::Projection(
                        "worksheet tile count exceeds snapshot decoder bound".into(),
                    ));
                }
            }
            Command::ClearRange { .. } => {}
        }
    }
    Ok(())
}

fn validate_projection_sheet_name(name: &str) -> Result<(), BindingError> {
    let forbidden = name
        .chars()
        .any(|character| matches!(character, '\\' | '/' | '?' | '*' | '[' | ']' | ':' | '\0'));
    if name.is_empty() || name.trim() != name || name.encode_utf16().count() > 31 || forbidden {
        return Err(BindingError::Projection(
            "worksheet name does not match the public spreadsheet model".into(),
        ));
    }
    Ok(())
}

fn encode_receipt(receipt: BatchReceipt) -> Vec<u8> {
    let mut output = Vec::with_capacity(48);
    output.extend_from_slice(&RECEIPT_MAGIC);
    output.extend_from_slice(&ABI_VERSION.to_le_bytes());
    output.extend_from_slice(&0u16.to_le_bytes());
    output.extend_from_slice(&receipt.revision.to_le_bytes());
    output.extend_from_slice(&(receipt.command_count as u32).to_le_bytes());
    output.extend_from_slice(&(receipt.written_cells as u64).to_le_bytes());
    output.extend_from_slice(&(receipt.cleared_cells as u64).to_le_bytes());
    output.extend_from_slice(&checksum(&output).to_le_bytes());
    output
}

fn check_snapshot_bound(snapshot: &[u8], maximum: usize) -> Result<(), BindingError> {
    if snapshot.len() > maximum {
        return Err(BindingError::Limit("snapshot envelope"));
    }
    Ok(())
}

fn validate_limits(limits: BindingLimits) -> Result<(), BindingError> {
    if limits.max_command_bytes == 0
        || limits.max_command_bytes > MAX_COMMAND_ENVELOPE_BYTES
        || limits.max_snapshot_bytes == 0
        || limits.max_snapshot_bytes > MAX_SNAPSHOT_ENVELOPE_BYTES
        || limits.max_cells_per_batch == 0
        || limits.max_cells_per_batch > MAX_CELLS_PER_BATCH
    {
        return Err(BindingError::Kernel("invalid binding limit profile".into()));
    }
    Ok(())
}

#[derive(Debug)]
pub enum BindingError {
    Limit(&'static str),
    BadMagic(&'static str),
    UnsupportedVersion(u16),
    Truncated,
    TrailingBytes,
    ChecksumMismatch,
    InvalidUtf8,
    InvalidTag(u8),
    InvalidCellValue(ValueError),
    InvalidNamespace,
    InvalidQuery(&'static str),
    Projection(String),
    NonCanonical(&'static str),
    Snapshot(SnapshotError),
    CollaborationSnapshot(opengeni_artifact_kernel::CollaborationSnapshotError),
    Collaboration(opengeni_artifact_kernel::CollaborationError),
    InvalidIntent(String),
    StateMismatch(&'static str),
    Batch(BatchError),
    Presentation(opengeni_artifact_kernel::presentation::PresentationError),
    PresentationBatch(opengeni_artifact_kernel::presentation::PresentationBatchError),
    TextLayout(opengeni_artifact_kernel::text_layout::LayoutError),
    RenderScene(opengeni_artifact_kernel::text_layout::RenderSceneError),
    Kernel(String),
    Closed,
}

impl BindingError {
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Limit(_) => "ARTIFACT_LIMIT",
            Self::BadMagic(_) => "ARTIFACT_BAD_MAGIC",
            Self::UnsupportedVersion(_) => "ARTIFACT_UNSUPPORTED_VERSION",
            Self::Truncated => "ARTIFACT_TRUNCATED",
            Self::TrailingBytes => "ARTIFACT_TRAILING_BYTES",
            Self::ChecksumMismatch => "ARTIFACT_CHECKSUM_MISMATCH",
            Self::InvalidUtf8 => "ARTIFACT_INVALID_UTF8",
            Self::InvalidTag(_) => "ARTIFACT_INVALID_TAG",
            Self::InvalidCellValue(_) => "ARTIFACT_INVALID_CELL_VALUE",
            Self::InvalidNamespace => "ARTIFACT_INVALID_NAMESPACE",
            Self::InvalidQuery(_) => "ARTIFACT_INVALID_QUERY",
            Self::Projection(_) => "ARTIFACT_PROJECTION_REJECTED",
            Self::NonCanonical(_) => "ARTIFACT_NON_CANONICAL",
            Self::Snapshot(_) => "ARTIFACT_INVALID_SNAPSHOT",
            Self::CollaborationSnapshot(_) => "ARTIFACT_INVALID_COLLABORATION_SNAPSHOT",
            Self::Collaboration(_) => "ARTIFACT_COLLABORATION_REJECTED",
            Self::InvalidIntent(_) => "ARTIFACT_INVALID_INTENT",
            Self::StateMismatch(_) => "ARTIFACT_STATE_MISMATCH",
            Self::Batch(_) => "ARTIFACT_BATCH_REJECTED",
            Self::Presentation(_) => "ARTIFACT_INVALID_PRESENTATION",
            Self::PresentationBatch(_) => "ARTIFACT_PRESENTATION_BATCH_REJECTED",
            Self::TextLayout(_) => "ARTIFACT_TEXT_LAYOUT_REJECTED",
            Self::RenderScene(_) => "ARTIFACT_RENDER_SCENE_REJECTED",
            Self::Kernel(_) => "ARTIFACT_KERNEL_ERROR",
            Self::Closed => "ARTIFACT_SESSION_CLOSED",
        }
    }
}

impl fmt::Display for BindingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Limit(target) => write!(formatter, "{target} exceeds a safety bound"),
            Self::BadMagic(target) => write!(formatter, "invalid {target} envelope magic"),
            Self::UnsupportedVersion(version) => {
                write!(formatter, "unsupported ABI version {version}")
            }
            Self::Truncated => formatter.write_str("input envelope is truncated"),
            Self::TrailingBytes => formatter.write_str("input envelope has trailing bytes"),
            Self::ChecksumMismatch => formatter.write_str("input envelope checksum mismatch"),
            Self::InvalidUtf8 => formatter.write_str("input envelope contains invalid UTF-8"),
            Self::InvalidTag(tag) => write!(formatter, "input envelope contains invalid tag {tag}"),
            Self::InvalidCellValue(error) => error.fmt(formatter),
            Self::InvalidNamespace => formatter
                .write_str("replica namespace must be a cryptographically random nonzero u64"),
            Self::InvalidQuery(message) => formatter.write_str(message),
            Self::Projection(message) => formatter.write_str(message),
            Self::NonCanonical(message) => {
                write!(formatter, "non-canonical input envelope: {message}")
            }
            Self::Snapshot(error) => error.fmt(formatter),
            Self::CollaborationSnapshot(error) => error.fmt(formatter),
            Self::Collaboration(error) => error.fmt(formatter),
            Self::InvalidIntent(message) => formatter.write_str(message),
            Self::StateMismatch(message) => formatter.write_str(message),
            Self::Batch(error) => error.fmt(formatter),
            Self::Presentation(error) => error.fmt(formatter),
            Self::PresentationBatch(error) => error.kind.fmt(formatter),
            Self::TextLayout(error) => error.fmt(formatter),
            Self::RenderScene(error) => error.fmt(formatter),
            Self::Kernel(message) => formatter.write_str(message),
            Self::Closed => formatter.write_str("artifact kernel session is closed"),
        }
    }
}

impl std::error::Error for BindingError {}

struct Encoder {
    bytes: Vec<u8>,
    maximum: usize,
}

impl Encoder {
    fn new(maximum: usize) -> Self {
        Self {
            bytes: Vec::new(),
            maximum,
        }
    }

    fn reserve(&mut self, additional: usize) -> Result<(), BindingError> {
        let next = self
            .bytes
            .len()
            .checked_add(additional)
            .ok_or(BindingError::Limit("command payload"))?;
        if next > self.maximum {
            return Err(BindingError::Limit("command payload"));
        }
        self.bytes.reserve(additional);
        Ok(())
    }

    fn bytes(&mut self, value: &[u8]) -> Result<(), BindingError> {
        self.reserve(value.len())?;
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

    fn id(&mut self, value: StableId) -> Result<(), BindingError> {
        self.bytes(&value.to_le_bytes())
    }

    fn string(&mut self, value: &str) -> Result<(), BindingError> {
        if value.len() > MAX_STRING_BYTES {
            return Err(BindingError::Limit("string"));
        }
        let length = u32::try_from(value.len()).map_err(|_| BindingError::Limit("string"))?;
        self.u32(length)?;
        self.bytes(value.as_bytes())
    }

    fn cell(&mut self, cell: &Cell) -> Result<(), BindingError> {
        match cell.formula_source() {
            Some(formula) => {
                self.u8(1)?;
                self.string(formula)?;
            }
            None => self.u8(0)?,
        }
        self.value(cell.value())
    }

    fn value(&mut self, value: &CellValue) -> Result<(), BindingError> {
        match value {
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
            FormulaError::Custom(text) => {
                self.u8(9)?;
                self.string(text)
            }
        }
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
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
        self.bytes.len() - self.offset
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], BindingError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(BindingError::Limit("command payload"))?;
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

    fn u32(&mut self) -> Result<u32, BindingError> {
        read_u32(self.take(4)?)
    }

    fn u64(&mut self) -> Result<u64, BindingError> {
        read_u64(self.take(8)?)
    }

    fn id(&mut self) -> Result<StableId, BindingError> {
        let bytes: [u8; 16] = self
            .take(16)?
            .try_into()
            .map_err(|_| BindingError::Truncated)?;
        Ok(StableId::from_le_bytes(bytes))
    }

    fn string(&mut self) -> Result<String, BindingError> {
        let length = usize::try_from(self.u32()?).map_err(|_| BindingError::Limit("string"))?;
        if length > MAX_STRING_BYTES {
            return Err(BindingError::Limit("string"));
        }
        let text =
            core::str::from_utf8(self.take(length)?).map_err(|_| BindingError::InvalidUtf8)?;
        Ok(text.to_owned())
    }

    fn cell(&mut self) -> Result<Cell, BindingError> {
        let formula = match self.u8()? {
            0 => None,
            1 => Some(self.string()?),
            tag => return Err(BindingError::InvalidTag(tag)),
        };
        let value = self.value()?;
        match formula {
            Some(formula) => Cell::formula(formula, value).map_err(BindingError::InvalidCellValue),
            None => Ok(Cell::from_value(value)),
        }
    }

    fn value(&mut self) -> Result<CellValue, BindingError> {
        match self.u8()? {
            0 => Ok(CellValue::Empty),
            1 => Ok(CellValue::Boolean(false)),
            2 => Ok(CellValue::Boolean(true)),
            3 => {
                let bits = self.u64()?;
                if bits == (-0.0_f64).to_bits() {
                    return Err(BindingError::NonCanonical(
                        "cell numbers must encode zero with a positive sign",
                    ));
                }
                Number::new(f64::from_bits(bits))
                    .map(CellValue::Number)
                    .map_err(BindingError::InvalidCellValue)
            }
            4 => self.string().map(CellValue::Text),
            5 => self.formula_error().map(CellValue::Error),
            6 => DateValue::new(self.u64()? as i64)
                .map(CellValue::Date)
                .map_err(BindingError::InvalidCellValue),
            tag => Err(BindingError::InvalidTag(tag)),
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
            9 => self.string().map(FormulaError::Custom),
            tag => Err(BindingError::InvalidTag(tag)),
        }
    }
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

// FNV-1a is an inexpensive deterministic corruption check. Authentication is
// deliberately an outer transport concern.
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
        apply_commands, canonicalize_snapshot, create_workbook, decode_command_batch,
        decode_receipt, encode_command_batch, encode_namespace, encode_viewport_query,
        encode_workbook_metadata_query, BindingError, BindingLimits, BindingSession, ViewportQuery,
        WorkbookMetadataQuery, MAX_CELLS_PER_BATCH, MAX_COMMANDS, MAX_COMMAND_ENVELOPE_BYTES,
        MAX_SNAPSHOT_ENVELOPE_BYTES, WASM_LIMITS,
    };
    use opengeni_artifact_kernel::{
        decode_snapshot, encode_snapshot, AtomicBatch, Cell, CellBlock, CellCoord, CellValue,
        Command, DateValue, Number, StableId, Workbook,
    };

    fn example_batch(namespace: u64) -> AtomicBatch {
        let sheet_id = StableId::from_parts(namespace, 50);
        AtomicBatch::from_commands(vec![
            Command::CreateSheet {
                id: sheet_id,
                name: "Summary".into(),
            },
            Command::SetCells {
                sheet_id,
                anchor: CellCoord::new(255, 255),
                cells: CellBlock::new(
                    2,
                    2,
                    vec![
                        Cell::from("Revenue"),
                        Cell::from_value(CellValue::Number(Number::new(12.5).expect("number"))),
                        Cell::from(true),
                        Cell::formula(
                            "=B1*2",
                            CellValue::Number(Number::new(25.0).expect("number")),
                        )
                        .expect("formula"),
                    ],
                )
                .expect("block"),
            },
        ])
    }

    #[test]
    fn binding_path_is_byte_identical_to_direct_kernel() {
        let namespace = 0x1234_5678_9abc_def0;
        let batch = example_batch(namespace);
        let snapshot = create_workbook(&encode_namespace(namespace)).expect("new snapshot");
        let actual = apply_commands(
            &snapshot,
            &encode_command_batch(&batch).expect("command envelope"),
        )
        .expect("apply");

        let mut direct = Workbook::new(namespace).expect("direct workbook");
        direct.apply_batch(&batch).expect("direct apply");
        let expected = encode_snapshot(&direct).expect("direct snapshot");
        assert_eq!(actual, expected);
        assert_eq!(canonicalize_snapshot(&actual).expect("canonical"), expected);
        assert_eq!(decode_snapshot(&actual).expect("decode").revision(), 1);
    }

    #[test]
    fn stateful_hot_path_matches_stateless_snapshot_boundary() {
        let namespace = 0xfedc_ba98_7654_3210;
        let command = encode_command_batch(&example_batch(namespace)).expect("command envelope");
        let initial = create_workbook(&encode_namespace(namespace)).expect("initial");
        let expected = apply_commands(&initial, &command).expect("stateless apply");

        let mut session = BindingSession::open(&initial).expect("open");
        let receipt = decode_receipt(&session.apply_commands(&command).expect("stateful apply"))
            .expect("receipt");
        assert_eq!(receipt.revision, 1);
        assert_eq!(receipt.command_count, 2);
        assert_eq!(receipt.written_cells, 4);
        assert_eq!(receipt.cleared_cells, 0);
        assert_eq!(session.revision().expect("revision"), 1);
        assert_eq!(session.snapshot().expect("snapshot"), expected);

        session.close();
        assert!(session.is_closed());
        assert!(matches!(session.snapshot(), Err(BindingError::Closed)));
        assert!(matches!(session.revision(), Err(BindingError::Closed)));
        assert!(matches!(
            session.apply_commands(&command),
            Err(BindingError::Closed)
        ));
    }

    #[test]
    fn command_codec_round_trips_every_current_command_shape() {
        let namespace = 7;
        let sheet_id = StableId::from_parts(namespace, 10);
        let batch = AtomicBatch::from_commands(vec![
            Command::CreateSheet {
                id: sheet_id,
                name: "Before".into(),
            },
            Command::RenameSheet {
                id: sheet_id,
                name: "After".into(),
            },
            Command::SetCells {
                sheet_id,
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(
                    1,
                    2,
                    vec![
                        Cell::from("value"),
                        Cell::from_value(CellValue::Date(
                            DateValue::new(1_754_739_296_789).expect("date"),
                        )),
                    ],
                )
                .expect("block"),
            },
            Command::ClearRange {
                sheet_id,
                range: opengeni_artifact_kernel::CellRange::new(
                    CellCoord::new(2, 3),
                    CellCoord::new(0, 1),
                ),
            },
            Command::DeleteSheet { id: sheet_id },
        ]);
        let encoded = encode_command_batch(&batch).expect("encode");
        assert_eq!(decode_command_batch(&encoded).expect("decode"), batch);
    }

    #[test]
    fn all_external_envelopes_are_strict_and_bounded() {
        assert!(matches!(
            create_workbook(&encode_namespace(0)),
            Err(BindingError::InvalidNamespace)
        ));
        assert!(Workbook::new(0).is_err());

        let namespace = encode_namespace(88);
        let mut corrupt_namespace = namespace.clone();
        corrupt_namespace[12] ^= 1;
        assert!(matches!(
            create_workbook(&corrupt_namespace),
            Err(BindingError::ChecksumMismatch)
        ));

        let oversized = vec![0; MAX_COMMAND_ENVELOPE_BYTES + 1];
        assert!(matches!(
            decode_command_batch(&oversized),
            Err(BindingError::Limit("command envelope"))
        ));

        let mut command = encode_command_batch(&AtomicBatch::new()).expect("empty command");
        command.push(0);
        assert!(matches!(
            decode_command_batch(&command),
            Err(BindingError::TrailingBytes)
        ));

        let mut impossible_count = encode_command_batch(&AtomicBatch::new()).expect("empty");
        impossible_count[12..16].copy_from_slice(&(MAX_COMMANDS as u32).to_le_bytes());
        rewrite_command_checksum(&mut impossible_count);
        assert!(matches!(
            decode_command_batch(&impossible_count),
            Err(BindingError::Truncated)
        ));
    }

    #[test]
    fn session_forks_are_independent_and_hash_exact_canonical_state() {
        use sha2::{Digest, Sha256};

        let namespace = 5150;
        let command = encode_command_batch(&example_batch(namespace)).expect("command");
        let source = BindingSession::create(&encode_namespace(namespace)).expect("source");
        let mut branch = source.fork().expect("fork");
        assert_eq!(
            source.state_hash().expect("source hash"),
            branch.state_hash().expect("branch hash")
        );
        branch.apply_commands(&command).expect("branch mutation");
        assert_eq!(source.revision().expect("source revision"), 0);
        assert_eq!(branch.revision().expect("branch revision"), 1);
        assert_ne!(
            source.state_hash().expect("source hash"),
            branch.state_hash().expect("branch hash")
        );

        let expected = format!(
            "sha256:{:x}",
            Sha256::digest(source.snapshot().expect("snapshot"))
        );
        assert_eq!(source.state_hash().expect("state hash"), expected);
    }

    #[test]
    fn conservative_browser_growth_rejection_preserves_state() {
        let namespace = 700;
        let initial = create_workbook(&encode_namespace(namespace)).expect("initial");
        let limits = BindingLimits {
            max_command_bytes: MAX_COMMAND_ENVELOPE_BYTES,
            max_snapshot_bytes: initial.len(),
            max_cells_per_batch: MAX_CELLS_PER_BATCH,
            allow_boundary_probe: false,
        };
        let mut session = BindingSession::open_with_limits(&initial, limits).expect("session");
        let command = encode_command_batch(&example_batch(namespace)).expect("command");
        assert!(matches!(
            session.apply_commands(&command),
            Err(BindingError::Limit("snapshot growth"))
        ));
        assert_eq!(session.revision().expect("revision"), 0);
        assert_eq!(session.snapshot().expect("snapshot"), initial);
    }

    #[test]
    fn runtime_cell_limit_rejects_before_model_mutation() {
        let namespace = 701;
        let initial = create_workbook(&encode_namespace(namespace)).expect("initial");
        let limits = BindingLimits {
            max_command_bytes: MAX_COMMAND_ENVELOPE_BYTES,
            max_snapshot_bytes: MAX_SNAPSHOT_ENVELOPE_BYTES,
            max_cells_per_batch: 1,
            allow_boundary_probe: false,
        };
        let sheet_id = StableId::from_parts(namespace, 2);
        let command = encode_command_batch(&AtomicBatch::from_commands(vec![
            Command::CreateSheet {
                id: sheet_id,
                name: "Data".into(),
            },
            Command::SetCells {
                sheet_id,
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(1, 2, vec![Cell::from(true), Cell::from(false)])
                    .expect("cells"),
            },
        ]))
        .expect("command");
        let mut session = BindingSession::open_with_limits(&initial, limits).expect("session");
        assert!(matches!(
            session.apply_commands(&command),
            Err(BindingError::Limit("cell count"))
        ));
        assert_eq!(session.snapshot().expect("snapshot"), initial);
    }

    #[test]
    fn invalid_allocator_namespace_is_rejected_after_checksum_validation() {
        let mut snapshot = create_workbook(&encode_namespace(900)).expect("snapshot");
        snapshot[44..52].copy_from_slice(&0_u64.to_le_bytes());
        let checksum_offset = snapshot.len() - 8;
        let digest = super::checksum(&snapshot[20..checksum_offset]);
        snapshot[checksum_offset..].copy_from_slice(&digest.to_le_bytes());
        assert!(matches!(
            BindingSession::open(&snapshot),
            Err(BindingError::InvalidNamespace)
        ));
    }

    #[test]
    fn noncanonical_ranges_and_negative_zero_are_rejected() {
        let namespace = 901;
        let sheet_id = StableId::from_parts(namespace, 2);
        let mut range =
            encode_command_batch(&AtomicBatch::from_commands(vec![Command::ClearRange {
                sheet_id,
                range: opengeni_artifact_kernel::CellRange::new(
                    CellCoord::new(0, 0),
                    CellCoord::new(1, 1),
                ),
            }]))
            .expect("range");
        range[41..45].copy_from_slice(&2_u32.to_le_bytes());
        rewrite_command_checksum(&mut range);
        assert!(matches!(
            decode_command_batch(&range),
            Err(BindingError::NonCanonical(
                "clear-range endpoints are not ordered"
            ))
        ));

        let mut number =
            encode_command_batch(&AtomicBatch::from_commands(vec![Command::SetCells {
                sheet_id,
                anchor: CellCoord::new(0, 0),
                cells: CellBlock::new(
                    1,
                    1,
                    vec![Cell::from_value(CellValue::Number(
                        Number::new(0.0).expect("number"),
                    ))],
                )
                .expect("cell"),
            }]))
            .expect("number");
        number[59..67].copy_from_slice(&(-0.0_f64).to_bits().to_le_bytes());
        rewrite_command_checksum(&mut number);
        assert!(matches!(
            decode_command_batch(&number),
            Err(BindingError::NonCanonical(
                "cell numbers must encode zero with a positive sign"
            ))
        ));

        let overflowing_block =
            encode_command_batch(&AtomicBatch::from_commands(vec![Command::SetCells {
                sheet_id,
                anchor: CellCoord::new(u32::MAX, 0),
                cells: CellBlock::new(2, 1, vec![Cell::from(true), Cell::from(false)])
                    .expect("cells"),
            }]))
            .expect("overflowing block");
        assert!(matches!(
            decode_command_batch(&overflowing_block),
            Err(BindingError::NonCanonical(
                "cell block extent exceeds uint32 coordinates"
            ))
        ));
    }

    #[test]
    fn public_spreadsheet_projection_is_enforced_before_mutation() {
        let namespace = 902;
        let initial = create_workbook(&encode_namespace(namespace)).expect("initial");
        let duplicate_case = encode_command_batch(&AtomicBatch::from_commands(vec![
            Command::CreateSheet {
                id: StableId::from_parts(namespace, 2),
                name: "Data".into(),
            },
            Command::CreateSheet {
                id: StableId::from_parts(namespace, 3),
                name: "data".into(),
            },
        ]))
        .expect("commands");
        assert!(matches!(
            apply_commands(&initial, &duplicate_case),
            Err(BindingError::Projection(_))
        ));

        let invalid_name =
            encode_command_batch(&AtomicBatch::from_commands(vec![Command::CreateSheet {
                id: StableId::from_parts(namespace, 2),
                name: "bad/name".into(),
            }]))
            .expect("commands");
        assert!(matches!(
            apply_commands(&initial, &invalid_name),
            Err(BindingError::Projection(_))
        ));
        assert_eq!(
            BindingSession::open_with_limits(
                &initial,
                BindingLimits {
                    max_command_bytes: MAX_COMMAND_ENVELOPE_BYTES,
                    max_snapshot_bytes: MAX_SNAPSHOT_ENVELOPE_BYTES,
                    max_cells_per_batch: MAX_CELLS_PER_BATCH,
                    allow_boundary_probe: true,
                },
            )
            .expect("unchanged")
            .revision()
            .expect("revision"),
            0
        );
    }

    #[test]
    fn native_and_wasm_profiles_return_identical_query_bytes() {
        let namespace = 0x9090;
        let sheet_id = StableId::from_parts(namespace, 50);
        let initial = create_workbook(&encode_namespace(namespace)).expect("initial");
        let populated = apply_commands(
            &initial,
            &encode_command_batch(&example_batch(namespace)).expect("commands"),
        )
        .expect("populated");
        let native = BindingSession::open(&populated).expect("native session");
        let wasm = BindingSession::open_with_limits(&populated, WASM_LIMITS)
            .expect("wasm-profile session");
        let viewport = encode_viewport_query(ViewportQuery {
            sheet_id,
            start: CellCoord::new(255, 255),
            rows: 2,
            columns: 2,
            max_cells: u32::MAX,
            max_bytes: u32::MAX,
        })
        .expect("viewport");
        let metadata = encode_workbook_metadata_query(WorkbookMetadataQuery {
            max_sheets: u32::MAX,
            max_bytes: u32::MAX,
        })
        .expect("metadata");
        assert_eq!(
            native.query(&viewport).expect("native viewport"),
            wasm.query(&viewport).expect("wasm viewport")
        );
        assert_eq!(
            native.query(&metadata).expect("native metadata"),
            wasm.query(&metadata).expect("wasm metadata")
        );
    }

    fn rewrite_command_checksum(command: &mut [u8]) {
        let checksum_offset = command.len() - 8;
        let digest = super::checksum(&command[..checksum_offset]);
        command[checksum_offset..].copy_from_slice(&digest.to_le_bytes());
    }
}
