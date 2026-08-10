use core::fmt;
use std::collections::{BTreeMap, BTreeSet};

use crate::id::IdGenerator;
use crate::sheet::Tile;
use crate::{
    Cell, CellValue, DateValue, FormulaError, Number, Sheet, StableId, TileCoord, ValueError,
    Workbook, WorkbookError,
};

const MAGIC: [u8; 8] = *b"OGARTK01";
pub const SNAPSHOT_VERSION: u16 = 1;
const HEADER_BYTES: usize = 8 + 2 + 2 + 8;
const CHECKSUM_BYTES: usize = 8;
const MAX_SNAPSHOT_BYTES: usize = 512 * 1024 * 1024;
const MAX_STRING_BYTES: usize = 16 * 1024 * 1024;
const MAX_SHEETS: usize = 1_000_000;
const MAX_TILES_PER_SHEET: usize = 16_000_000;
const MAX_CELLS_PER_TILE: usize = 65_536;
const MIN_SHEET_BYTES: usize = 16 + 4 + 4;
const MIN_TILE_BYTES: usize = 4 + 4 + 4;
const MIN_CELL_BYTES: usize = 2 + 1 + 1;

/// Canonically encodes a workbook. No hash maps, pointer identities, locale,
/// clock, or platform byte order can affect the result.
pub fn encode_snapshot(workbook: &Workbook) -> Result<Vec<u8>, SnapshotError> {
    let mut payload = Encoder::default();
    payload.id(workbook.id);
    payload.u64(workbook.revision);
    payload.u64(workbook.ids.namespace());
    payload.u64(workbook.ids.next_counter());
    payload.u8(u8::from(workbook.ids.is_exhausted()));
    payload.count(workbook.sheet_order.len())?;

    for sheet_id in &workbook.sheet_order {
        let sheet = workbook
            .sheets
            .get(sheet_id)
            .ok_or(SnapshotError::InvalidModel(
                "sheet order references a missing sheet",
            ))?;
        payload.id(sheet.id);
        payload.string(&sheet.name)?;
        payload.count(sheet.tiles.len())?;
        for (tile_coord, tile) in &sheet.tiles {
            payload.u32(tile_coord.row());
            payload.u32(tile_coord.column());
            payload.count(tile.cells().len())?;
            for (local_index, cell) in tile.cells() {
                payload.u16(*local_index);
                payload.cell(cell)?;
            }
        }
    }

    if payload.bytes.len() > MAX_SNAPSHOT_BYTES {
        return Err(SnapshotError::SizeLimit);
    }
    let payload_len = u64::try_from(payload.bytes.len()).map_err(|_| SnapshotError::SizeLimit)?;
    let checksum = checksum(&payload.bytes);
    let capacity = HEADER_BYTES
        .checked_add(payload.bytes.len())
        .and_then(|size| size.checked_add(CHECKSUM_BYTES))
        .ok_or(SnapshotError::SizeLimit)?;
    let mut output = Vec::with_capacity(capacity);
    output.extend_from_slice(&MAGIC);
    output.extend_from_slice(&SNAPSHOT_VERSION.to_le_bytes());
    output.extend_from_slice(&0u16.to_le_bytes());
    output.extend_from_slice(&payload_len.to_le_bytes());
    output.extend_from_slice(&payload.bytes);
    output.extend_from_slice(&checksum.to_le_bytes());
    Ok(output)
}

/// Strictly decodes one complete canonical snapshot.
pub fn decode_snapshot(bytes: &[u8]) -> Result<Workbook, SnapshotError> {
    if bytes.len() < HEADER_BYTES + CHECKSUM_BYTES {
        return Err(SnapshotError::Truncated);
    }
    if bytes.len() > MAX_SNAPSHOT_BYTES + HEADER_BYTES + CHECKSUM_BYTES {
        return Err(SnapshotError::SizeLimit);
    }
    if bytes[..8] != MAGIC {
        return Err(SnapshotError::BadMagic);
    }
    let version = u16::from_le_bytes([bytes[8], bytes[9]]);
    if version != SNAPSHOT_VERSION {
        return Err(SnapshotError::UnsupportedVersion(version));
    }
    if u16::from_le_bytes([bytes[10], bytes[11]]) != 0 {
        return Err(SnapshotError::NonCanonical("reserved header bits are set"));
    }
    let payload_len = u64::from_le_bytes(
        bytes[12..20]
            .try_into()
            .map_err(|_| SnapshotError::Truncated)?,
    );
    let payload_len = usize::try_from(payload_len).map_err(|_| SnapshotError::SizeLimit)?;
    if payload_len > MAX_SNAPSHOT_BYTES {
        return Err(SnapshotError::SizeLimit);
    }
    let expected_len = HEADER_BYTES
        .checked_add(payload_len)
        .and_then(|size| size.checked_add(CHECKSUM_BYTES))
        .ok_or(SnapshotError::SizeLimit)?;
    if bytes.len() != expected_len {
        return Err(if bytes.len() < expected_len {
            SnapshotError::Truncated
        } else {
            SnapshotError::TrailingBytes
        });
    }
    let payload_end = HEADER_BYTES + payload_len;
    let payload = &bytes[HEADER_BYTES..payload_end];
    let expected_checksum = u64::from_le_bytes(
        bytes[payload_end..]
            .try_into()
            .map_err(|_| SnapshotError::Truncated)?,
    );
    if checksum(payload) != expected_checksum {
        return Err(SnapshotError::ChecksumMismatch);
    }

    let mut decoder = Decoder::new(payload);
    let workbook_id = decoder.id()?;
    let revision = decoder.u64()?;
    let namespace = decoder.u64()?;
    let next_counter = decoder.u64()?;
    let exhausted = match decoder.u8()? {
        0 => false,
        1 => true,
        _ => return Err(SnapshotError::NonCanonical("invalid boolean")),
    };
    if next_counter == 0 {
        return Err(SnapshotError::InvalidModel("id counter must not be zero"));
    }
    if exhausted && next_counter != u64::MAX {
        return Err(SnapshotError::NonCanonical(
            "exhausted id generator must be at the maximum counter",
        ));
    }
    let ids = IdGenerator::from_snapshot(namespace, next_counter, exhausted);
    let sheet_count = decoder.count(MAX_SHEETS)?;
    if sheet_count > decoder.remaining() / MIN_SHEET_BYTES {
        return Err(SnapshotError::Truncated);
    }
    let mut sheet_order = Vec::new();
    sheet_order
        .try_reserve_exact(sheet_count)
        .map_err(|_| SnapshotError::SizeLimit)?;
    let mut sheets = BTreeMap::new();
    let mut names = BTreeSet::new();

    for _ in 0..sheet_count {
        let id = decoder.id()?;
        if id.is_zero() {
            return Err(SnapshotError::InvalidModel("sheet id must not be zero"));
        }
        let name = decoder.string()?;
        Workbook::validate_sheet_name(&name).map_err(SnapshotError::Workbook)?;
        if !names.insert(name.clone()) {
            return Err(SnapshotError::InvalidModel("duplicate sheet name"));
        }
        let tile_count = decoder.count(MAX_TILES_PER_SHEET)?;
        if tile_count > decoder.remaining() / MIN_TILE_BYTES {
            return Err(SnapshotError::Truncated);
        }
        let mut tiles = BTreeMap::new();
        let mut previous_tile = None;
        for _ in 0..tile_count {
            let tile_row = decoder.u32()?;
            let tile_column = decoder.u32()?;
            let tile_coord = TileCoord::new(tile_row, tile_column)
                .map_err(|_| SnapshotError::InvalidModel("tile coordinate is out of bounds"))?;
            if previous_tile.is_some_and(|previous| tile_coord <= previous) {
                return Err(SnapshotError::NonCanonical(
                    "tiles are not strictly ordered",
                ));
            }
            previous_tile = Some(tile_coord);
            let cell_count = decoder.count(MAX_CELLS_PER_TILE)?;
            if cell_count == 0 {
                return Err(SnapshotError::NonCanonical("empty tiles must be omitted"));
            }
            if cell_count > decoder.remaining() / MIN_CELL_BYTES {
                return Err(SnapshotError::Truncated);
            }
            let mut cells = Vec::new();
            cells
                .try_reserve_exact(cell_count)
                .map_err(|_| SnapshotError::SizeLimit)?;
            let mut previous_local_index = None;
            for _ in 0..cell_count {
                let local_index = decoder.u16()?;
                if previous_local_index.is_some_and(|previous| local_index <= previous) {
                    return Err(SnapshotError::NonCanonical(
                        "cells are not strictly ordered",
                    ));
                }
                previous_local_index = Some(local_index);
                let cell = decoder.cell()?;
                if cell.is_empty() {
                    return Err(SnapshotError::NonCanonical("empty cells must be omitted"));
                }
                cells.push((local_index, cell));
            }
            tiles.insert(tile_coord, Tile::from_cells(cells));
        }
        sheet_order.push(id);
        if sheets.insert(id, Sheet { id, name, tiles }).is_some() {
            return Err(SnapshotError::InvalidModel("duplicate sheet id"));
        }
    }
    if !decoder.is_empty() {
        return Err(SnapshotError::TrailingBytes);
    }

    Workbook::from_snapshot_parts(workbook_id, revision, ids, sheet_order, sheets)
        .map_err(SnapshotError::Workbook)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SnapshotError {
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
    Workbook(WorkbookError),
    InvalidModel(&'static str),
    NonCanonical(&'static str),
}

impl fmt::Display for SnapshotError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadMagic => formatter.write_str("invalid artifact snapshot magic"),
            Self::UnsupportedVersion(version) => {
                write!(formatter, "unsupported artifact snapshot version {version}")
            }
            Self::Truncated => formatter.write_str("artifact snapshot is truncated"),
            Self::TrailingBytes => formatter.write_str("artifact snapshot has trailing bytes"),
            Self::ChecksumMismatch => formatter.write_str("artifact snapshot checksum mismatch"),
            Self::SizeLimit => formatter.write_str("artifact snapshot exceeds a safety bound"),
            Self::InvalidUtf8 => formatter.write_str("artifact snapshot contains invalid UTF-8"),
            Self::InvalidTag(tag) => {
                write!(formatter, "artifact snapshot contains invalid tag {tag}")
            }
            Self::InvalidNumber(error) => error.fmt(formatter),
            Self::InvalidDate(error) => error.fmt(formatter),
            Self::Workbook(error) => error.fmt(formatter),
            Self::InvalidModel(message) => write!(formatter, "invalid artifact model: {message}"),
            Self::NonCanonical(message) => {
                write!(formatter, "non-canonical artifact snapshot: {message}")
            }
        }
    }
}

impl std::error::Error for SnapshotError {}

#[derive(Default)]
struct Encoder {
    bytes: Vec<u8>,
}

impl Encoder {
    fn u8(&mut self, value: u8) {
        self.bytes.push(value);
    }

    fn u16(&mut self, value: u16) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn u32(&mut self, value: u32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn u64(&mut self, value: u64) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn id(&mut self, value: StableId) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn count(&mut self, value: usize) -> Result<(), SnapshotError> {
        self.u32(u32::try_from(value).map_err(|_| SnapshotError::SizeLimit)?);
        Ok(())
    }

    fn string(&mut self, value: &str) -> Result<(), SnapshotError> {
        if value.len() > MAX_STRING_BYTES {
            return Err(SnapshotError::SizeLimit);
        }
        self.count(value.len())?;
        self.bytes.extend_from_slice(value.as_bytes());
        Ok(())
    }

    fn cell(&mut self, cell: &Cell) -> Result<(), SnapshotError> {
        match cell.formula_source() {
            Some(formula) => {
                self.u8(1);
                self.string(formula)?;
            }
            None => self.u8(0),
        }
        self.value(cell.value())
    }

    fn value(&mut self, value: &CellValue) -> Result<(), SnapshotError> {
        match value {
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

    fn formula_error(&mut self, error: &FormulaError) -> Result<(), SnapshotError> {
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
        self.bytes.len() - self.offset
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], SnapshotError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(SnapshotError::SizeLimit)?;
        let output = self
            .bytes
            .get(self.offset..end)
            .ok_or(SnapshotError::Truncated)?;
        self.offset = end;
        Ok(output)
    }

    fn u8(&mut self) -> Result<u8, SnapshotError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, SnapshotError> {
        Ok(u16::from_le_bytes(
            self.take(2)?
                .try_into()
                .map_err(|_| SnapshotError::Truncated)?,
        ))
    }

    fn u32(&mut self) -> Result<u32, SnapshotError> {
        Ok(u32::from_le_bytes(
            self.take(4)?
                .try_into()
                .map_err(|_| SnapshotError::Truncated)?,
        ))
    }

    fn u64(&mut self) -> Result<u64, SnapshotError> {
        Ok(u64::from_le_bytes(
            self.take(8)?
                .try_into()
                .map_err(|_| SnapshotError::Truncated)?,
        ))
    }

    fn id(&mut self) -> Result<StableId, SnapshotError> {
        let bytes: [u8; 16] = self
            .take(16)?
            .try_into()
            .map_err(|_| SnapshotError::Truncated)?;
        Ok(StableId::from_le_bytes(bytes))
    }

    fn count(&mut self, maximum: usize) -> Result<usize, SnapshotError> {
        let value = self.u32()? as usize;
        if value > maximum {
            return Err(SnapshotError::SizeLimit);
        }
        Ok(value)
    }

    fn string(&mut self) -> Result<String, SnapshotError> {
        let length = self.count(MAX_STRING_BYTES)?;
        let bytes = self.take(length)?;
        let text = std::str::from_utf8(bytes).map_err(|_| SnapshotError::InvalidUtf8)?;
        Ok(text.to_owned())
    }

    fn cell(&mut self) -> Result<Cell, SnapshotError> {
        let formula = match self.u8()? {
            0 => None,
            1 => {
                let formula = self.string()?;
                if formula.is_empty() {
                    return Err(SnapshotError::NonCanonical("formula must not be empty"));
                }
                Some(formula)
            }
            tag => return Err(SnapshotError::InvalidTag(tag)),
        };
        let value = self.value()?;
        Ok(Cell::from_snapshot(value, formula))
    }

    fn value(&mut self) -> Result<CellValue, SnapshotError> {
        match self.u8()? {
            0 => Ok(CellValue::Empty),
            1 => Ok(CellValue::Boolean(false)),
            2 => Ok(CellValue::Boolean(true)),
            3 => {
                let bits = self.u64()?;
                if bits == (-0.0f64).to_bits() {
                    return Err(SnapshotError::NonCanonical("number uses negative zero"));
                }
                Number::from_snapshot_bits(bits)
                    .map(CellValue::Number)
                    .map_err(SnapshotError::InvalidNumber)
            }
            4 => self.string().map(CellValue::Text),
            5 => self.formula_error().map(CellValue::Error),
            6 => DateValue::new(self.u64()? as i64)
                .map(CellValue::Date)
                .map_err(SnapshotError::InvalidDate),
            tag => Err(SnapshotError::InvalidTag(tag)),
        }
    }

    fn formula_error(&mut self) -> Result<FormulaError, SnapshotError> {
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
            tag => Err(SnapshotError::InvalidTag(tag)),
        }
    }
}

// FNV-1a is an inexpensive corruption detector, not an authenticity boundary.
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
    use crate::{
        decode_snapshot, encode_snapshot, AtomicBatch, Cell, CellBlock, CellCoord, CellValue,
        Command, DateValue, FormulaError, Number, StableId, Workbook,
    };

    fn populated_workbook() -> Workbook {
        let mut workbook = Workbook::new(55).expect("workbook");
        let sheet_id = StableId::from_parts(55, 100);
        let formula = Cell::formula(
            "=SUM(A1:A2)",
            CellValue::Number(Number::new(3.0).expect("number")),
        )
        .expect("formula");
        workbook
            .apply_batch(&AtomicBatch::from_commands(vec![
                Command::CreateSheet {
                    id: sheet_id,
                    name: "Data".into(),
                },
                Command::SetCells {
                    sheet_id,
                    anchor: CellCoord::new(255, 255),
                    cells: CellBlock::new(
                        2,
                        3,
                        vec![
                            Cell::from(true),
                            Cell::from("text"),
                            formula,
                            Cell::from_value(CellValue::Error(FormulaError::Reference)),
                            Cell::from_value(CellValue::Date(
                                DateValue::new(1_754_739_296_789).expect("date"),
                            )),
                            Cell::empty(),
                        ],
                    )
                    .expect("block"),
                },
            ]))
            .expect("batch");
        workbook
    }

    fn envelope_from_payload(payload: &[u8]) -> Vec<u8> {
        let mut bytes =
            Vec::with_capacity(super::HEADER_BYTES + payload.len() + super::CHECKSUM_BYTES);
        bytes.extend_from_slice(&super::MAGIC);
        bytes.extend_from_slice(&super::SNAPSHOT_VERSION.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&(payload.len() as u64).to_le_bytes());
        bytes.extend_from_slice(payload);
        bytes.extend_from_slice(&super::checksum(payload).to_le_bytes());
        bytes
    }

    fn minimal_workbook_prefix(sheet_count: u32) -> Vec<u8> {
        let mut payload = Vec::new();
        payload.extend_from_slice(&StableId::from_parts(1, 1).to_le_bytes());
        payload.extend_from_slice(&0u64.to_le_bytes());
        payload.extend_from_slice(&1u64.to_le_bytes());
        payload.extend_from_slice(&2u64.to_le_bytes());
        payload.push(0);
        payload.extend_from_slice(&sheet_count.to_le_bytes());
        payload
    }

    #[test]
    fn snapshot_is_deterministic_and_round_trips() {
        let workbook = populated_workbook();
        let first = encode_snapshot(&workbook).expect("encode");
        let second = encode_snapshot(&workbook).expect("encode");
        assert_eq!(first, second);
        let decoded = decode_snapshot(&first).expect("decode");
        assert_eq!(decoded, workbook);
        assert_eq!(encode_snapshot(&decoded).expect("re-encode"), first);
    }

    #[test]
    fn checksum_detects_mutation() {
        let mut bytes = encode_snapshot(&populated_workbook()).expect("encode");
        bytes[30] ^= 0x01;
        assert!(matches!(
            decode_snapshot(&bytes),
            Err(super::SnapshotError::ChecksumMismatch)
        ));
    }

    #[test]
    fn trailing_bytes_are_rejected() {
        let mut bytes = encode_snapshot(&populated_workbook()).expect("encode");
        bytes.push(0);
        assert!(matches!(
            decode_snapshot(&bytes),
            Err(super::SnapshotError::TrailingBytes)
        ));
    }

    #[test]
    fn impossible_sheet_count_fails_before_reserving() {
        let bytes = envelope_from_payload(&minimal_workbook_prefix(1_000_000));
        assert_eq!(
            decode_snapshot(&bytes),
            Err(super::SnapshotError::Truncated)
        );
    }

    #[test]
    fn impossible_tile_and_cell_counts_fail_before_reserving() {
        let mut impossible_tiles = minimal_workbook_prefix(1);
        impossible_tiles.extend_from_slice(&StableId::from_parts(1, 2).to_le_bytes());
        impossible_tiles.extend_from_slice(&4u32.to_le_bytes());
        impossible_tiles.extend_from_slice(b"Data");
        impossible_tiles.extend_from_slice(&16_000_000u32.to_le_bytes());
        assert_eq!(
            decode_snapshot(&envelope_from_payload(&impossible_tiles)),
            Err(super::SnapshotError::Truncated)
        );

        let mut impossible_cells = minimal_workbook_prefix(1);
        impossible_cells.extend_from_slice(&StableId::from_parts(1, 2).to_le_bytes());
        impossible_cells.extend_from_slice(&4u32.to_le_bytes());
        impossible_cells.extend_from_slice(b"Data");
        impossible_cells.extend_from_slice(&1u32.to_le_bytes());
        impossible_cells.extend_from_slice(&0u32.to_le_bytes());
        impossible_cells.extend_from_slice(&0u32.to_le_bytes());
        impossible_cells.extend_from_slice(&65_536u32.to_le_bytes());
        assert_eq!(
            decode_snapshot(&envelope_from_payload(&impossible_cells)),
            Err(super::SnapshotError::Truncated)
        );
    }

    #[test]
    fn negative_zero_number_bits_are_noncanonical() {
        let mut workbook = Workbook::new(73).expect("workbook");
        let sheet_id = StableId::from_parts(73, 100);
        let marker = 12_345.678_901_234_5_f64;
        workbook
            .apply_batch(&AtomicBatch::from_commands(vec![
                Command::CreateSheet {
                    id: sheet_id,
                    name: "Data".into(),
                },
                Command::SetCells {
                    sheet_id,
                    anchor: CellCoord::new(0, 0),
                    cells: CellBlock::new(
                        1,
                        1,
                        vec![Cell::from_value(CellValue::Number(
                            Number::new(marker).expect("finite marker"),
                        ))],
                    )
                    .expect("block"),
                },
            ]))
            .expect("batch");
        let mut bytes = encode_snapshot(&workbook).expect("encode");
        let marker_bytes = marker.to_bits().to_le_bytes();
        let payload_end = bytes.len() - super::CHECKSUM_BYTES;
        let positions = bytes[super::HEADER_BYTES..payload_end]
            .windows(marker_bytes.len())
            .enumerate()
            .filter_map(|(offset, candidate)| (candidate == marker_bytes).then_some(offset))
            .collect::<Vec<_>>();
        assert_eq!(positions.len(), 1, "fixture marker must be unique");
        let number_offset = super::HEADER_BYTES + positions[0];
        bytes[number_offset..number_offset + 8].copy_from_slice(&(-0.0f64).to_bits().to_le_bytes());
        let checksum = super::checksum(&bytes[super::HEADER_BYTES..payload_end]);
        bytes[payload_end..].copy_from_slice(&checksum.to_le_bytes());

        assert_eq!(
            decode_snapshot(&bytes),
            Err(super::SnapshotError::NonCanonical(
                "number uses negative zero"
            ))
        );
    }
}
