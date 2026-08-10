//! Bounded, canonical read projections for interactive artifact workers.
//!
//! Queries never expose Rust object layouts and never return partial data. A
//! request that cannot fit its caller-provided limits (clamped to the hard ABI
//! caps below) fails with `ARTIFACT_LIMIT`; callers can then request a smaller
//! viewport. Stable sheet ids resolve the currently visible sheet. The
//! collaboration binding additionally returns that sheet's creation operation
//! id, which is its exact CRDT generation.

use opengeni_artifact_kernel::{
    Cell, CellCoord, CellRange, CellValue, DateValue, FormulaError, Number, StableId, Workbook,
};

use super::{checksum, read_u16, read_u32, read_u64, BindingError, MAX_STRING_BYTES};

pub const QUERY_SCHEMA_VERSION: u16 = 1;
pub const MAX_QUERY_ENVELOPE_BYTES: usize = 68;
pub const MAX_QUERY_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_VIEWPORT_AREA: usize = 1_048_576;
pub const MAX_VIEWPORT_CELLS: usize = 262_144;
pub const MAX_METADATA_SHEETS: usize = 10_000;
pub const MAX_METADATA_SCANNED_CELLS: usize = 4_000_000;

const QUERY_MAGIC: [u8; 8] = *b"OGAKQ001";
const RESPONSE_MAGIC: [u8; 8] = *b"OGAKV001";
const QUERY_HEADER_BYTES: usize = 8 + 2 + 2 + 1 + 3 + 4 + 4 + 4;
const RESPONSE_HEADER_BYTES: usize = 8 + 2 + 2 + 1 + 3 + 8 + 4 + 8;
const CHECKSUM_BYTES: usize = 8;
const VIEWPORT_QUERY_PAYLOAD_BYTES: usize = 16 + 4 + 4 + 4 + 4;
const VIEWPORT_RESPONSE_PREFIX_BYTES: usize = 16 + 16 + 4 + 4 + 4 + 4;
const METADATA_RESPONSE_PREFIX_BYTES: usize = 4;
const RESPONSE_FLAG_GENERATIONS: u16 = 1;

/// The query kind encoded in OGAKQ001 and echoed in OGAKV001.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum ArtifactQueryKind {
    Viewport = 0,
    WorkbookMetadata = 1,
}

/// A canonical sparse spreadsheet viewport request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ViewportQuery {
    pub sheet_id: StableId,
    pub start: CellCoord,
    pub rows: u32,
    pub columns: u32,
    pub max_cells: u32,
    pub max_bytes: u32,
}

/// A canonical ordered workbook-catalog request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WorkbookMetadataQuery {
    pub max_sheets: u32,
    pub max_bytes: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ArtifactQuery {
    Viewport(ViewportQuery),
    WorkbookMetadata(WorkbookMetadataQuery),
}

/// One non-empty cell returned by a sparse viewport projection.
#[derive(Clone, Debug, PartialEq)]
pub struct ViewportCell {
    pub relative_row: u32,
    pub relative_column: u32,
    pub cell: Cell,
}

/// A complete, non-truncated viewport response.
#[derive(Clone, Debug, PartialEq)]
pub struct ViewportResponse {
    pub revision: u64,
    pub sheet_id: StableId,
    /// The CRDT creation-operation id. `None` for non-collaborative sessions.
    pub generation: Option<StableId>,
    pub start: CellCoord,
    pub rows: u32,
    pub columns: u32,
    pub cells: Vec<ViewportCell>,
}

/// Authoritative metadata currently modeled by the workbook kernel.
#[derive(Clone, Debug, PartialEq)]
pub struct SheetMetadata {
    pub sheet_id: StableId,
    /// The CRDT creation-operation id. `None` for non-collaborative sessions.
    pub generation: Option<StableId>,
    pub name: String,
    /// Inclusive non-empty cell bounds, or `None` for an empty sheet.
    pub used_bounds: Option<CellRange>,
}

/// A complete, ordered workbook metadata response.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkbookMetadataResponse {
    pub revision: u64,
    /// Feature bits for modeled row/column dimensions, hidden state, and
    /// merges. Version 1 is zero because the kernel does not model them yet.
    pub modeled_features: u32,
    pub sheets: Vec<SheetMetadata>,
}

/// Strictly decoded OGAKV001 response.
#[derive(Clone, Debug, PartialEq)]
pub enum ArtifactQueryResponse {
    Viewport(ViewportResponse),
    WorkbookMetadata(WorkbookMetadataResponse),
}

/// Encodes an OGAKQ001 viewport request.
pub fn encode_viewport_query(query: ViewportQuery) -> Result<Vec<u8>, BindingError> {
    validate_viewport_query(query)?;
    let mut payload = Vec::with_capacity(VIEWPORT_QUERY_PAYLOAD_BYTES);
    payload.extend_from_slice(&query.sheet_id.to_le_bytes());
    payload.extend_from_slice(&query.start.row.to_le_bytes());
    payload.extend_from_slice(&query.start.column.to_le_bytes());
    payload.extend_from_slice(&query.rows.to_le_bytes());
    payload.extend_from_slice(&query.columns.to_le_bytes());
    encode_query(
        ArtifactQueryKind::Viewport,
        query.max_cells,
        query.max_bytes,
        &payload,
    )
}

/// Encodes an OGAKQ001 workbook metadata request.
pub fn encode_workbook_metadata_query(
    query: WorkbookMetadataQuery,
) -> Result<Vec<u8>, BindingError> {
    validate_output_limits(
        query.max_sheets,
        query.max_bytes,
        minimum_metadata_response_bytes(),
    )?;
    encode_query(
        ArtifactQueryKind::WorkbookMetadata,
        query.max_sheets,
        query.max_bytes,
        &[],
    )
}

fn encode_query(
    kind: ArtifactQueryKind,
    max_items: u32,
    max_bytes: u32,
    payload: &[u8],
) -> Result<Vec<u8>, BindingError> {
    let payload_len = u32::try_from(payload.len()).map_err(|_| BindingError::Limit("query"))?;
    let capacity = QUERY_HEADER_BYTES
        .checked_add(payload.len())
        .and_then(|value| value.checked_add(CHECKSUM_BYTES))
        .ok_or(BindingError::Limit("query envelope"))?;
    if capacity > MAX_QUERY_ENVELOPE_BYTES {
        return Err(BindingError::Limit("query envelope"));
    }
    let mut output = Vec::with_capacity(capacity);
    output.extend_from_slice(&QUERY_MAGIC);
    output.extend_from_slice(&QUERY_SCHEMA_VERSION.to_le_bytes());
    output.extend_from_slice(&0u16.to_le_bytes());
    output.push(kind as u8);
    output.extend_from_slice(&[0; 3]);
    output.extend_from_slice(&max_items.to_le_bytes());
    output.extend_from_slice(&max_bytes.to_le_bytes());
    output.extend_from_slice(&payload_len.to_le_bytes());
    output.extend_from_slice(payload);
    output.extend_from_slice(&checksum(&output).to_le_bytes());
    Ok(output)
}

fn decode_query(bytes: &[u8]) -> Result<ArtifactQuery, BindingError> {
    if bytes.len() > MAX_QUERY_ENVELOPE_BYTES {
        return Err(BindingError::Limit("query envelope"));
    }
    if bytes.len() < QUERY_HEADER_BYTES + CHECKSUM_BYTES {
        return Err(BindingError::Truncated);
    }
    if bytes[..8] != QUERY_MAGIC {
        return Err(BindingError::BadMagic("query"));
    }
    let version = read_u16(&bytes[8..10])?;
    if version != QUERY_SCHEMA_VERSION {
        return Err(BindingError::UnsupportedVersion(version));
    }
    if read_u16(&bytes[10..12])? != 0 || bytes[13..16] != [0; 3] {
        return Err(BindingError::NonCanonical(
            "reserved query header bits are set",
        ));
    }
    let kind = match bytes[12] {
        0 => ArtifactQueryKind::Viewport,
        1 => ArtifactQueryKind::WorkbookMetadata,
        tag => return Err(BindingError::InvalidTag(tag)),
    };
    let max_items = read_u32(&bytes[16..20])?;
    let max_bytes = read_u32(&bytes[20..24])?;
    let payload_len = usize::try_from(read_u32(&bytes[24..28])?)
        .map_err(|_| BindingError::Limit("query payload"))?;
    let payload_end = QUERY_HEADER_BYTES
        .checked_add(payload_len)
        .ok_or(BindingError::Limit("query payload"))?;
    let expected = payload_end
        .checked_add(CHECKSUM_BYTES)
        .ok_or(BindingError::Limit("query envelope"))?;
    if bytes.len() != expected {
        return Err(if bytes.len() < expected {
            BindingError::Truncated
        } else {
            BindingError::TrailingBytes
        });
    }
    if checksum(&bytes[..payload_end]) != read_u64(&bytes[payload_end..expected])? {
        return Err(BindingError::ChecksumMismatch);
    }
    let payload = &bytes[QUERY_HEADER_BYTES..payload_end];
    match kind {
        ArtifactQueryKind::Viewport => {
            if payload.len() != VIEWPORT_QUERY_PAYLOAD_BYTES {
                return Err(if payload.len() < VIEWPORT_QUERY_PAYLOAD_BYTES {
                    BindingError::Truncated
                } else {
                    BindingError::TrailingBytes
                });
            }
            let query = ViewportQuery {
                sheet_id: read_id(&payload[..16])?,
                start: CellCoord::new(read_u32(&payload[16..20])?, read_u32(&payload[20..24])?),
                rows: read_u32(&payload[24..28])?,
                columns: read_u32(&payload[28..32])?,
                max_cells: max_items,
                max_bytes,
            };
            validate_viewport_query(query)?;
            Ok(ArtifactQuery::Viewport(query))
        }
        ArtifactQueryKind::WorkbookMetadata => {
            if !payload.is_empty() {
                return Err(BindingError::TrailingBytes);
            }
            validate_output_limits(max_items, max_bytes, minimum_metadata_response_bytes())?;
            Ok(ArtifactQuery::WorkbookMetadata(WorkbookMetadataQuery {
                max_sheets: max_items,
                max_bytes,
            }))
        }
    }
}

fn validate_viewport_query(query: ViewportQuery) -> Result<(), BindingError> {
    validate_id(query.sheet_id, "viewport sheet id")?;
    if query.rows == 0 || query.columns == 0 {
        return Err(BindingError::NonCanonical(
            "viewport extents must be nonzero",
        ));
    }
    query
        .start
        .row
        .checked_add(query.rows - 1)
        .ok_or(BindingError::NonCanonical(
            "viewport row extent exceeds uint32 coordinates",
        ))?;
    query
        .start
        .column
        .checked_add(query.columns - 1)
        .ok_or(BindingError::NonCanonical(
            "viewport column extent exceeds uint32 coordinates",
        ))?;
    let area = viewport_area(query.rows, query.columns)?;
    if area > MAX_VIEWPORT_AREA {
        return Err(BindingError::Limit("viewport area"));
    }
    validate_output_limits(
        query.max_cells,
        query.max_bytes,
        minimum_viewport_response_bytes(),
    )
}

fn validate_output_limits(
    max_items: u32,
    max_bytes: u32,
    minimum_bytes: usize,
) -> Result<(), BindingError> {
    if max_items == 0 {
        return Err(BindingError::NonCanonical(
            "query item limit must be nonzero",
        ));
    }
    if usize::try_from(max_bytes).unwrap_or(0) < minimum_bytes {
        return Err(BindingError::NonCanonical(
            "query byte limit cannot fit an empty response",
        ));
    }
    Ok(())
}

pub(crate) fn query_workbook(
    workbook: &Workbook,
    query_envelope: &[u8],
    include_generations: bool,
    mut generation_for: impl FnMut(StableId) -> Option<StableId>,
) -> Result<Vec<u8>, BindingError> {
    match decode_query(query_envelope)? {
        ArtifactQuery::Viewport(query) => {
            let sheet = workbook
                .sheet(query.sheet_id)
                .ok_or(BindingError::InvalidQuery(
                    "viewport targets an unknown live worksheet",
                ))?;
            let generation = if include_generations {
                Some(
                    generation_for(query.sheet_id).ok_or(BindingError::StateMismatch(
                        "live worksheet is missing its collaboration generation",
                    ))?,
                )
            } else {
                None
            };
            let max_cells = usize::try_from(query.max_cells)
                .unwrap_or(usize::MAX)
                .min(MAX_VIEWPORT_CELLS);
            let cells = collect_viewport_cells(sheet, query, max_cells)?;
            encode_response(
                ArtifactQueryResponse::Viewport(ViewportResponse {
                    revision: workbook.revision(),
                    sheet_id: query.sheet_id,
                    generation,
                    start: query.start,
                    rows: query.rows,
                    columns: query.columns,
                    cells,
                }),
                effective_max_bytes(query.max_bytes),
            )
        }
        ArtifactQuery::WorkbookMetadata(query) => {
            let maximum = usize::try_from(query.max_sheets)
                .unwrap_or(usize::MAX)
                .min(MAX_METADATA_SHEETS);
            if workbook.sheet_count() > maximum {
                return Err(BindingError::Limit("workbook metadata sheet count"));
            }
            let mut sheets = Vec::new();
            sheets
                .try_reserve_exact(workbook.sheet_count())
                .map_err(|_| BindingError::Limit("workbook metadata"))?;
            let mut scanned_cells = 0usize;
            for sheet in workbook.sheets() {
                let generation = if include_generations {
                    Some(
                        generation_for(sheet.id()).ok_or(BindingError::StateMismatch(
                            "live worksheet is missing its collaboration generation",
                        ))?,
                    )
                } else {
                    None
                };
                let mut minimum: Option<CellCoord> = None;
                let mut maximum: Option<CellCoord> = None;
                for (coord, _) in sheet.cells() {
                    scanned_cells = scanned_cells
                        .checked_add(1)
                        .ok_or(BindingError::Limit("workbook metadata cell scan"))?;
                    if scanned_cells > MAX_METADATA_SCANNED_CELLS {
                        return Err(BindingError::Limit("workbook metadata cell scan"));
                    }
                    minimum = Some(match minimum {
                        Some(value) => {
                            CellCoord::new(value.row.min(coord.row), value.column.min(coord.column))
                        }
                        None => coord,
                    });
                    maximum = Some(match maximum {
                        Some(value) => {
                            CellCoord::new(value.row.max(coord.row), value.column.max(coord.column))
                        }
                        None => coord,
                    });
                }
                sheets.push(SheetMetadata {
                    sheet_id: sheet.id(),
                    generation,
                    name: sheet.name().to_owned(),
                    used_bounds: minimum
                        .zip(maximum)
                        .map(|(start, end)| CellRange { start, end }),
                });
            }
            encode_response(
                ArtifactQueryResponse::WorkbookMetadata(WorkbookMetadataResponse {
                    revision: workbook.revision(),
                    modeled_features: 0,
                    sheets,
                }),
                effective_max_bytes(query.max_bytes),
            )
        }
    }
}

fn collect_viewport_cells(
    sheet: &opengeni_artifact_kernel::Sheet,
    query: ViewportQuery,
    maximum: usize,
) -> Result<Vec<ViewportCell>, BindingError> {
    let area = viewport_area(query.rows, query.columns)?;
    let populated = sheet.non_empty_cell_count();
    let mut cells = Vec::new();
    cells
        .try_reserve(area.min(populated).min(maximum))
        .map_err(|_| BindingError::Limit("viewport cells"))?;
    if area <= populated {
        for relative_row in 0..query.rows {
            for relative_column in 0..query.columns {
                let coord = CellCoord::new(
                    query.start.row + relative_row,
                    query.start.column + relative_column,
                );
                if let Some(cell) = sheet.cell(coord) {
                    push_viewport_cell(&mut cells, maximum, relative_row, relative_column, cell)?;
                }
            }
        }
    } else {
        let end_row = query.start.row + query.rows - 1;
        let end_column = query.start.column + query.columns - 1;
        for (coord, cell) in sheet.cells() {
            if coord.row >= query.start.row
                && coord.row <= end_row
                && coord.column >= query.start.column
                && coord.column <= end_column
            {
                push_viewport_cell(
                    &mut cells,
                    maximum,
                    coord.row - query.start.row,
                    coord.column - query.start.column,
                    cell,
                )?;
            }
        }
        cells.sort_unstable_by_key(|cell| (cell.relative_row, cell.relative_column));
    }
    Ok(cells)
}

fn push_viewport_cell(
    cells: &mut Vec<ViewportCell>,
    maximum: usize,
    relative_row: u32,
    relative_column: u32,
    cell: &Cell,
) -> Result<(), BindingError> {
    if cells.len() >= maximum {
        return Err(BindingError::Limit("viewport cell count"));
    }
    cells.push(ViewportCell {
        relative_row,
        relative_column,
        cell: cell.clone(),
    });
    Ok(())
}

fn encode_response(
    response: ArtifactQueryResponse,
    maximum: usize,
) -> Result<Vec<u8>, BindingError> {
    let (kind, revision, flags, item_count, payload) = match response {
        ArtifactQueryResponse::Viewport(response) => {
            let flags = if response.generation.is_some() {
                RESPONSE_FLAG_GENERATIONS
            } else {
                0
            };
            let mut writer =
                Writer::new(maximum.saturating_sub(RESPONSE_HEADER_BYTES + CHECKSUM_BYTES));
            writer.id(response.sheet_id)?;
            writer.optional_generation(response.generation)?;
            writer.u32(response.start.row)?;
            writer.u32(response.start.column)?;
            writer.u32(response.rows)?;
            writer.u32(response.columns)?;
            for cell in &response.cells {
                writer.u32(cell.relative_row)?;
                writer.u32(cell.relative_column)?;
                writer.cell(&cell.cell)?;
            }
            let count = u32::try_from(response.cells.len())
                .map_err(|_| BindingError::Limit("viewport cell count"))?;
            (
                ArtifactQueryKind::Viewport,
                response.revision,
                flags,
                count,
                writer.finish(),
            )
        }
        ArtifactQueryResponse::WorkbookMetadata(response) => {
            if response.modeled_features != 0 {
                return Err(BindingError::NonCanonical(
                    "unknown workbook metadata feature bits are set",
                ));
            }
            let has_generations = response
                .sheets
                .first()
                .and_then(|sheet| sheet.generation)
                .is_some();
            if response
                .sheets
                .iter()
                .any(|sheet| sheet.generation.is_some() != has_generations)
            {
                return Err(BindingError::NonCanonical(
                    "workbook metadata generations must be uniformly present",
                ));
            }
            let flags = if has_generations {
                RESPONSE_FLAG_GENERATIONS
            } else {
                0
            };
            let mut writer =
                Writer::new(maximum.saturating_sub(RESPONSE_HEADER_BYTES + CHECKSUM_BYTES));
            writer.u32(response.modeled_features)?;
            for sheet in &response.sheets {
                writer.id(sheet.sheet_id)?;
                writer.optional_generation(sheet.generation)?;
                writer.string(&sheet.name)?;
                match sheet.used_bounds {
                    Some(bounds) => {
                        writer.u8(1)?;
                        writer.u32(bounds.start.row)?;
                        writer.u32(bounds.start.column)?;
                        writer.u32(bounds.end.row)?;
                        writer.u32(bounds.end.column)?;
                    }
                    None => writer.u8(0)?,
                }
            }
            let count = u32::try_from(response.sheets.len())
                .map_err(|_| BindingError::Limit("workbook metadata sheet count"))?;
            (
                ArtifactQueryKind::WorkbookMetadata,
                response.revision,
                flags,
                count,
                writer.finish(),
            )
        }
    };
    let payload_len =
        u64::try_from(payload.len()).map_err(|_| BindingError::Limit("query response payload"))?;
    let capacity = RESPONSE_HEADER_BYTES
        .checked_add(payload.len())
        .and_then(|value| value.checked_add(CHECKSUM_BYTES))
        .ok_or(BindingError::Limit("query response"))?;
    if capacity > maximum || capacity > MAX_QUERY_RESPONSE_BYTES {
        return Err(BindingError::Limit("query response"));
    }
    let mut output = Vec::with_capacity(capacity);
    output.extend_from_slice(&RESPONSE_MAGIC);
    output.extend_from_slice(&QUERY_SCHEMA_VERSION.to_le_bytes());
    output.extend_from_slice(&flags.to_le_bytes());
    output.push(kind as u8);
    output.extend_from_slice(&[0; 3]);
    output.extend_from_slice(&revision.to_le_bytes());
    output.extend_from_slice(&item_count.to_le_bytes());
    output.extend_from_slice(&payload_len.to_le_bytes());
    output.extend_from_slice(&payload);
    output.extend_from_slice(&checksum(&output).to_le_bytes());
    Ok(output)
}

/// Strictly decodes a bounded OGAKV001 response.
pub fn decode_query_response(bytes: &[u8]) -> Result<ArtifactQueryResponse, BindingError> {
    if bytes.len() > MAX_QUERY_RESPONSE_BYTES {
        return Err(BindingError::Limit("query response"));
    }
    if bytes.len() < RESPONSE_HEADER_BYTES + CHECKSUM_BYTES {
        return Err(BindingError::Truncated);
    }
    if bytes[..8] != RESPONSE_MAGIC {
        return Err(BindingError::BadMagic("query response"));
    }
    let version = read_u16(&bytes[8..10])?;
    if version != QUERY_SCHEMA_VERSION {
        return Err(BindingError::UnsupportedVersion(version));
    }
    let flags = read_u16(&bytes[10..12])?;
    if flags & !RESPONSE_FLAG_GENERATIONS != 0 || bytes[13..16] != [0; 3] {
        return Err(BindingError::NonCanonical(
            "unknown query response flags are set",
        ));
    }
    let kind = match bytes[12] {
        0 => ArtifactQueryKind::Viewport,
        1 => ArtifactQueryKind::WorkbookMetadata,
        tag => return Err(BindingError::InvalidTag(tag)),
    };
    let revision = read_u64(&bytes[16..24])?;
    let item_count = usize::try_from(read_u32(&bytes[24..28])?)
        .map_err(|_| BindingError::Limit("query response items"))?;
    let payload_len = usize::try_from(read_u64(&bytes[28..36])?)
        .map_err(|_| BindingError::Limit("query response payload"))?;
    let payload_end = RESPONSE_HEADER_BYTES
        .checked_add(payload_len)
        .ok_or(BindingError::Limit("query response payload"))?;
    let expected = payload_end
        .checked_add(CHECKSUM_BYTES)
        .ok_or(BindingError::Limit("query response"))?;
    if bytes.len() != expected {
        return Err(if bytes.len() < expected {
            BindingError::Truncated
        } else {
            BindingError::TrailingBytes
        });
    }
    if checksum(&bytes[..payload_end]) != read_u64(&bytes[payload_end..expected])? {
        return Err(BindingError::ChecksumMismatch);
    }
    let has_generations = flags & RESPONSE_FLAG_GENERATIONS != 0;
    let mut reader = Reader::new(&bytes[RESPONSE_HEADER_BYTES..payload_end]);
    let response = match kind {
        ArtifactQueryKind::Viewport => {
            if item_count > MAX_VIEWPORT_CELLS {
                return Err(BindingError::Limit("viewport cell count"));
            }
            if item_count
                > reader
                    .bytes
                    .len()
                    .saturating_sub(VIEWPORT_RESPONSE_PREFIX_BYTES)
                    / 10
            {
                return Err(BindingError::Truncated);
            }
            let sheet_id = reader.id()?;
            let generation = reader.optional_generation(has_generations)?;
            let start = CellCoord::new(reader.u32()?, reader.u32()?);
            let rows = reader.u32()?;
            let columns = reader.u32()?;
            validate_viewport_query(ViewportQuery {
                sheet_id,
                start,
                rows,
                columns,
                max_cells: u32::try_from(item_count.max(1)).unwrap_or(u32::MAX),
                max_bytes: u32::try_from(bytes.len()).unwrap_or(u32::MAX),
            })?;
            let mut cells = Vec::new();
            cells
                .try_reserve_exact(item_count)
                .map_err(|_| BindingError::Limit("viewport cells"))?;
            let mut previous = None;
            for _ in 0..item_count {
                let relative_row = reader.u32()?;
                let relative_column = reader.u32()?;
                if relative_row >= rows || relative_column >= columns {
                    return Err(BindingError::NonCanonical(
                        "viewport cell lies outside the response extent",
                    ));
                }
                let position = (relative_row, relative_column);
                if previous.is_some_and(|candidate| position <= candidate) {
                    return Err(BindingError::NonCanonical(
                        "viewport cells are not strictly row-major",
                    ));
                }
                previous = Some(position);
                let cell = reader.cell()?;
                if cell.is_empty() {
                    return Err(BindingError::NonCanonical(
                        "sparse viewport contains an empty cell",
                    ));
                }
                cells.push(ViewportCell {
                    relative_row,
                    relative_column,
                    cell,
                });
            }
            ArtifactQueryResponse::Viewport(ViewportResponse {
                revision,
                sheet_id,
                generation,
                start,
                rows,
                columns,
                cells,
            })
        }
        ArtifactQueryKind::WorkbookMetadata => {
            if item_count > MAX_METADATA_SHEETS {
                return Err(BindingError::Limit("workbook metadata sheet count"));
            }
            if item_count == 0 && has_generations {
                return Err(BindingError::NonCanonical(
                    "empty workbook metadata cannot carry a generation flag",
                ));
            }
            if item_count
                > reader
                    .bytes
                    .len()
                    .saturating_sub(METADATA_RESPONSE_PREFIX_BYTES)
                    / 37
            {
                return Err(BindingError::Truncated);
            }
            let modeled_features = reader.u32()?;
            if modeled_features != 0 {
                return Err(BindingError::NonCanonical(
                    "unknown workbook metadata feature bits are set",
                ));
            }
            let mut sheets = Vec::new();
            sheets
                .try_reserve_exact(item_count)
                .map_err(|_| BindingError::Limit("workbook metadata"))?;
            let mut ids = std::collections::BTreeSet::new();
            let mut names = std::collections::BTreeSet::new();
            for _ in 0..item_count {
                let sheet_id = reader.id()?;
                if !ids.insert(sheet_id) {
                    return Err(BindingError::NonCanonical(
                        "workbook metadata contains a duplicate sheet id",
                    ));
                }
                let generation = reader.optional_generation(has_generations)?;
                let name = reader.string()?;
                super::validate_projection_sheet_name(&name)?;
                if !names.insert(name.to_lowercase()) {
                    return Err(BindingError::Projection(
                        "worksheet names must be unique without regard to case".into(),
                    ));
                }
                let used_bounds = match reader.u8()? {
                    0 => None,
                    1 => {
                        let start = CellCoord::new(reader.u32()?, reader.u32()?);
                        let end = CellCoord::new(reader.u32()?, reader.u32()?);
                        if start.row > end.row || start.column > end.column {
                            return Err(BindingError::NonCanonical(
                                "workbook metadata used bounds are not ordered",
                            ));
                        }
                        Some(CellRange { start, end })
                    }
                    tag => return Err(BindingError::InvalidTag(tag)),
                };
                sheets.push(SheetMetadata {
                    sheet_id,
                    generation,
                    name,
                    used_bounds,
                });
            }
            ArtifactQueryResponse::WorkbookMetadata(WorkbookMetadataResponse {
                revision,
                modeled_features,
                sheets,
            })
        }
    };
    if !reader.is_empty() {
        return Err(BindingError::TrailingBytes);
    }
    Ok(response)
}

fn viewport_area(rows: u32, columns: u32) -> Result<usize, BindingError> {
    usize::try_from(rows)
        .ok()
        .and_then(|rows| {
            usize::try_from(columns)
                .ok()
                .and_then(|columns| rows.checked_mul(columns))
        })
        .ok_or(BindingError::Limit("viewport area"))
}

fn effective_max_bytes(maximum: u32) -> usize {
    usize::try_from(maximum)
        .unwrap_or(usize::MAX)
        .min(MAX_QUERY_RESPONSE_BYTES)
}

const fn minimum_viewport_response_bytes() -> usize {
    RESPONSE_HEADER_BYTES + VIEWPORT_RESPONSE_PREFIX_BYTES + CHECKSUM_BYTES
}

const fn minimum_metadata_response_bytes() -> usize {
    RESPONSE_HEADER_BYTES + METADATA_RESPONSE_PREFIX_BYTES + CHECKSUM_BYTES
}

fn validate_id(id: StableId, target: &'static str) -> Result<(), BindingError> {
    if id.namespace() == 0 || id.counter() == 0 {
        return Err(BindingError::InvalidQuery(target));
    }
    Ok(())
}

fn read_id(bytes: &[u8]) -> Result<StableId, BindingError> {
    let bytes: [u8; 16] = bytes.try_into().map_err(|_| BindingError::Truncated)?;
    let id = StableId::from_le_bytes(bytes);
    validate_id(id, "query contains a reserved id")?;
    Ok(id)
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
            .ok_or(BindingError::Limit("query response"))?;
        if next > self.maximum {
            return Err(BindingError::Limit("query response"));
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

    fn id(&mut self, value: StableId) -> Result<(), BindingError> {
        validate_id(value, "query response contains a reserved id")?;
        self.bytes(&value.to_le_bytes())
    }

    fn optional_generation(&mut self, value: Option<StableId>) -> Result<(), BindingError> {
        match value {
            Some(value) => self.id(value),
            None => self.bytes(&[0; 16]),
        }
    }

    fn string(&mut self, value: &str) -> Result<(), BindingError> {
        if value.len() > MAX_STRING_BYTES {
            return Err(BindingError::Limit("query response string"));
        }
        self.u32(
            u32::try_from(value.len()).map_err(|_| BindingError::Limit("query response string"))?,
        )?;
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

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn is_empty(&self) -> bool {
        self.offset == self.bytes.len()
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], BindingError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(BindingError::Limit("query response payload"))?;
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
        read_id(self.take(16)?)
    }

    fn optional_generation(&mut self, present: bool) -> Result<Option<StableId>, BindingError> {
        let bytes = self.take(16)?;
        if present {
            Ok(Some(read_id(bytes)?))
        } else if bytes.iter().any(|byte| *byte != 0) {
            Err(BindingError::NonCanonical(
                "query response has a generation without its flag",
            ))
        } else {
            Ok(None)
        }
    }

    fn string(&mut self) -> Result<String, BindingError> {
        let length = usize::try_from(self.u32()?)
            .map_err(|_| BindingError::Limit("query response string"))?;
        if length > MAX_STRING_BYTES {
            return Err(BindingError::Limit("query response string"));
        }
        let value =
            core::str::from_utf8(self.take(length)?).map_err(|_| BindingError::InvalidUtf8)?;
        Ok(value.to_owned())
    }

    fn cell(&mut self) -> Result<Cell, BindingError> {
        let formula = match self.u8()? {
            0 => None,
            1 => Some(self.string()?),
            tag => return Err(BindingError::InvalidTag(tag)),
        };
        let value = self.value()?;
        match formula {
            Some(source) => Cell::formula(source, value).map_err(BindingError::InvalidCellValue),
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

#[cfg(test)]
mod tests {
    use super::*;
    use opengeni_artifact_kernel::{AtomicBatch, CellBlock, Command};
    use serde_json::Value;

    fn shared_fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../../../contracts/test/fixtures/spreadsheet-artifact-query-v1.json"
        ))
        .expect("shared OGAKQ/OGAKV fixture")
    }

    fn fixture_str<'a>(fixture: &'a Value, key: &str) -> &'a str {
        fixture[key]
            .as_str()
            .unwrap_or_else(|| panic!("fixture field {key}"))
    }

    fn seeded_workbook() -> (Workbook, StableId) {
        let namespace = 0x5151;
        let sheet_id = StableId::from_parts(namespace, 9);
        let mut workbook = Workbook::new(namespace).expect("workbook");
        workbook
            .apply_batch(&AtomicBatch::from_commands(vec![
                Command::CreateSheet {
                    id: sheet_id,
                    name: "Data".into(),
                },
                Command::SetCells {
                    sheet_id,
                    anchor: CellCoord::new(9, 19),
                    cells: CellBlock::new(
                        2,
                        3,
                        vec![
                            Cell::from("a"),
                            Cell::empty(),
                            Cell::from(true),
                            Cell::from_value(CellValue::Number(Number::new(2.5).unwrap())),
                            Cell::formula("=A1", CellValue::Text("cached".into())).unwrap(),
                            Cell::from_value(CellValue::Date(
                                DateValue::new(1_754_739_296_789).unwrap(),
                            )),
                        ],
                    )
                    .unwrap(),
                },
            ]))
            .expect("seed");
        (workbook, sheet_id)
    }

    #[test]
    fn viewport_is_sparse_row_major_and_round_trips() {
        let (workbook, sheet_id) = seeded_workbook();
        let query = encode_viewport_query(ViewportQuery {
            sheet_id,
            start: CellCoord::new(9, 19),
            rows: 2,
            columns: 3,
            max_cells: u32::MAX,
            max_bytes: u32::MAX,
        })
        .unwrap();
        let bytes = query_workbook(&workbook, &query, false, |_| None).unwrap();
        let ArtifactQueryResponse::Viewport(response) = decode_query_response(&bytes).unwrap()
        else {
            panic!("viewport response")
        };
        assert_eq!(response.revision, 1);
        assert_eq!(response.sheet_id, sheet_id);
        assert_eq!(response.generation, None);
        assert_eq!(
            response
                .cells
                .iter()
                .map(|cell| (cell.relative_row, cell.relative_column))
                .collect::<Vec<_>>(),
            vec![(0, 0), (0, 2), (1, 0), (1, 1), (1, 2)]
        );
        assert_eq!(
            response.cells.last().map(|cell| cell.cell.value()),
            Some(&CellValue::Date(DateValue::new(1_754_739_296_789).unwrap()))
        );
    }

    #[test]
    fn metadata_is_ordered_exact_and_does_not_invent_unmodeled_state() {
        let (workbook, sheet_id) = seeded_workbook();
        let query = encode_workbook_metadata_query(WorkbookMetadataQuery {
            max_sheets: u32::MAX,
            max_bytes: u32::MAX,
        })
        .unwrap();
        let generation = StableId::from_parts(0x9999, 1);
        let bytes = query_workbook(&workbook, &query, true, |_| Some(generation)).unwrap();
        let ArtifactQueryResponse::WorkbookMetadata(response) =
            decode_query_response(&bytes).unwrap()
        else {
            panic!("metadata response")
        };
        assert_eq!(response.modeled_features, 0);
        assert_eq!(response.sheets.len(), 1);
        assert_eq!(response.sheets[0].sheet_id, sheet_id);
        assert_eq!(response.sheets[0].generation, Some(generation));
        assert_eq!(response.sheets[0].name, "Data");
        assert_eq!(
            response.sheets[0].used_bounds,
            Some(CellRange {
                start: CellCoord::new(9, 19),
                end: CellCoord::new(10, 21),
            })
        );
    }

    #[test]
    fn query_limits_reject_instead_of_truncating() {
        let (workbook, sheet_id) = seeded_workbook();
        let too_few = encode_viewport_query(ViewportQuery {
            sheet_id,
            start: CellCoord::new(9, 19),
            rows: 2,
            columns: 3,
            max_cells: 3,
            max_bytes: u32::MAX,
        })
        .unwrap();
        assert!(matches!(
            query_workbook(&workbook, &too_few, false, |_| None),
            Err(BindingError::Limit("viewport cell count"))
        ));

        let too_small = encode_viewport_query(ViewportQuery {
            sheet_id,
            start: CellCoord::new(9, 19),
            rows: 2,
            columns: 3,
            max_cells: u32::MAX,
            max_bytes: minimum_viewport_response_bytes() as u32,
        })
        .unwrap();
        assert!(matches!(
            query_workbook(&workbook, &too_small, false, |_| None),
            Err(BindingError::Limit("query response"))
        ));
    }

    #[test]
    fn malformed_and_bomb_queries_fail_before_model_walk() {
        let (workbook, sheet_id) = seeded_workbook();
        let mut query = encode_viewport_query(ViewportQuery {
            sheet_id,
            start: CellCoord::new(0, 0),
            rows: 1,
            columns: 1,
            max_cells: 1,
            max_bytes: 1024,
        })
        .unwrap();
        query[13] = 1;
        rewrite_checksum(&mut query);
        assert!(matches!(
            query_workbook(&workbook, &query, false, |_| None),
            Err(BindingError::NonCanonical(_))
        ));

        let bomb = encode_viewport_query(ViewportQuery {
            sheet_id,
            start: CellCoord::new(0, 0),
            rows: 1025,
            columns: 1024,
            max_cells: u32::MAX,
            max_bytes: u32::MAX,
        });
        assert!(matches!(bomb, Err(BindingError::Limit("viewport area"))));

        let mut corrupt = encode_workbook_metadata_query(WorkbookMetadataQuery {
            max_sheets: 1,
            max_bytes: 1024,
        })
        .unwrap();
        corrupt[20] ^= 1;
        assert!(matches!(
            query_workbook(&workbook, &corrupt, false, |_| None),
            Err(BindingError::ChecksumMismatch)
        ));
    }

    #[test]
    fn malformed_and_bomb_responses_fail_before_large_allocation() {
        let (workbook, sheet_id) = seeded_workbook();
        let request = encode_viewport_query(ViewportQuery {
            sheet_id,
            start: CellCoord::new(9, 19),
            rows: 2,
            columns: 3,
            max_cells: u32::MAX,
            max_bytes: u32::MAX,
        })
        .unwrap();
        let response = query_workbook(&workbook, &request, false, |_| None).unwrap();

        let mut reserved = response.clone();
        reserved[13] = 1;
        rewrite_checksum(&mut reserved);
        assert!(matches!(
            decode_query_response(&reserved),
            Err(BindingError::NonCanonical(_))
        ));

        let mut item_bomb = response.clone();
        item_bomb[24..28].copy_from_slice(&u32::MAX.to_le_bytes());
        rewrite_checksum(&mut item_bomb);
        assert!(matches!(
            decode_query_response(&item_bomb),
            Err(BindingError::Limit("viewport cell count"))
        ));

        let mut empty_sparse_cell = response;
        // Common header + viewport prefix + relative coordinates + formula tag.
        empty_sparse_cell[RESPONSE_HEADER_BYTES + VIEWPORT_RESPONSE_PREFIX_BYTES + 9] = 0;
        rewrite_checksum(&mut empty_sparse_cell);
        assert!(matches!(
            decode_query_response(&empty_sparse_cell),
            Err(BindingError::NonCanonical(
                "sparse viewport contains an empty cell"
            ))
        ));

        let metadata_request = encode_workbook_metadata_query(WorkbookMetadataQuery {
            max_sheets: u32::MAX,
            max_bytes: u32::MAX,
        })
        .unwrap();
        let mut metadata = query_workbook(&workbook, &metadata_request, false, |_| None).unwrap();
        let name = metadata
            .windows(4)
            .position(|bytes| bytes == b"Data")
            .expect("name bytes");
        metadata[name] = b'/';
        rewrite_checksum(&mut metadata);
        assert!(matches!(
            decode_query_response(&metadata),
            Err(BindingError::Projection(_))
        ));
    }

    #[test]
    fn golden_vectors_are_stable() {
        let fixture = shared_fixture();
        let sheet_id = StableId::from_parts(0x0102_0304_0506_0708, 0x1112_1314_1516_1718);
        let viewport = encode_viewport_query(ViewportQuery {
            sheet_id,
            start: CellCoord::new(2, 3),
            rows: 4,
            columns: 5,
            max_cells: 6,
            max_bytes: 1024,
        })
        .unwrap();
        let metadata = encode_workbook_metadata_query(WorkbookMetadataQuery {
            max_sheets: 7,
            max_bytes: 2048,
        })
        .unwrap();
        let mut workbook = Workbook::new(0x0102_0304_0506_0708).unwrap();
        workbook
            .apply_batch(&AtomicBatch::from_commands(vec![
                Command::CreateSheet {
                    id: sheet_id,
                    name: "Data ✓".into(),
                },
                Command::SetCells {
                    sheet_id,
                    anchor: CellCoord::new(2, 3),
                    cells: CellBlock::new(1, 2, vec![Cell::from(true), Cell::from("x")]).unwrap(),
                },
            ]))
            .unwrap();
        let generation = StableId::from_parts(0x2122_2324_2526_2728, 0x3132_3334_3536_3738);
        let viewport_response =
            query_workbook(&workbook, &viewport, true, |_| Some(generation)).unwrap();
        let metadata_response =
            query_workbook(&workbook, &metadata, true, |_| Some(generation)).unwrap();
        assert_eq!(hex(&viewport), fixture_str(&fixture, "viewportQueryHex"));
        assert_eq!(hex(&metadata), fixture_str(&fixture, "metadataQueryHex"));
        assert_eq!(
            hex(&viewport_response),
            fixture_str(&fixture, "viewportProjectionHex")
        );
        assert_eq!(
            hex(&metadata_response),
            fixture_str(&fixture, "metadataProjectionHex")
        );
    }

    fn rewrite_checksum(bytes: &mut [u8]) {
        let offset = bytes.len() - CHECKSUM_BYTES;
        let value = checksum(&bytes[..offset]);
        bytes[offset..].copy_from_slice(&value.to_le_bytes());
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}
