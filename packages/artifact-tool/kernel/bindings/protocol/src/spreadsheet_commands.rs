//! Pure spreadsheet commands nested inside the authoritative OGATX001 intent.
//!
//! This envelope deliberately contains only typed modality mutations and
//! structural generation preconditions. Artifact, actor, transaction, causal,
//! and delivery identity belong exclusively to OGATX001.

use std::collections::{BTreeMap, BTreeSet};

use opengeni_artifact_kernel::{
    Cell, CellBlock, CellCoord, CellRange, DateValue, FormulaError, Number, OperationId,
    SheetGeneration, StableId, MAX_CELLS_PER_TRANSACTION, MAX_OPERATIONS_PER_TRANSACTION,
};

use super::{checksum, read_u16, read_u32, read_u64, BindingError};

pub const SPREADSHEET_COMMAND_VERSION: u16 = 1;
pub const MAX_SPREADSHEET_COMMAND_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_SPREADSHEET_COMMANDS: usize = MAX_OPERATIONS_PER_TRANSACTION;
pub const MAX_SPREADSHEET_COMMAND_CELLS: usize = MAX_CELLS_PER_TRANSACTION;
pub const MAX_SPREADSHEET_COMMAND_STRING_BYTES: usize = 1024 * 1024;

const MAGIC: [u8; 8] = *b"OGASC001";
const HEADER_BYTES: usize = 8 + 2 + 2 + 4 + 8;
const CHECKSUM_BYTES: usize = 8;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SheetPrecondition {
    Generation(SheetGeneration),
    CreatedInBatch {
        sheet_id: StableId,
        create_command_index: u32,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum SpreadsheetCommand {
    CreateSheet {
        sheet_id: StableId,
        name: String,
        after: Option<SheetPrecondition>,
    },
    RenameSheet {
        sheet: SheetPrecondition,
        name: String,
    },
    DeleteSheet {
        sheet: SheetPrecondition,
    },
    SetCells {
        sheet: SheetPrecondition,
        anchor: CellCoord,
        cells: CellBlock,
    },
    ClearRange {
        sheet: SheetPrecondition,
        range: CellRange,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SpreadsheetCommandBatch {
    pub(crate) commands: Vec<SpreadsheetCommand>,
    pub(crate) cell_count: usize,
}

pub(crate) fn decode_spreadsheet_commands(
    bytes: &[u8],
) -> Result<SpreadsheetCommandBatch, BindingError> {
    if bytes.len() > MAX_SPREADSHEET_COMMAND_BYTES {
        return Err(BindingError::Limit("OGASC001 spreadsheet commands"));
    }
    if bytes.len() < HEADER_BYTES + CHECKSUM_BYTES {
        return Err(BindingError::Truncated);
    }
    if bytes[..8] != MAGIC {
        return Err(BindingError::BadMagic("OGASC001 spreadsheet command"));
    }
    let version = read_u16(&bytes[8..10])?;
    if version != SPREADSHEET_COMMAND_VERSION {
        return Err(BindingError::UnsupportedVersion(version));
    }
    if read_u16(&bytes[10..12])? != 0 {
        return Err(BindingError::NonCanonical(
            "reserved OGASC001 header bits are set",
        ));
    }
    let command_count = usize::try_from(read_u32(&bytes[12..16])?)
        .map_err(|_| BindingError::Limit("OGASC001 command count"))?;
    if command_count == 0 || command_count > MAX_SPREADSHEET_COMMANDS {
        return Err(BindingError::Limit("OGASC001 command count"));
    }
    let payload_len = usize::try_from(read_u64(&bytes[16..24])?)
        .map_err(|_| BindingError::Limit("OGASC001 payload"))?;
    let payload_end = HEADER_BYTES
        .checked_add(payload_len)
        .ok_or(BindingError::Limit("OGASC001 payload"))?;
    let expected = payload_end
        .checked_add(CHECKSUM_BYTES)
        .ok_or(BindingError::Limit("OGASC001 envelope"))?;
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

    let mut reader = Reader::new(&bytes[HEADER_BYTES..payload_end]);
    // The shortest command is delete + concrete ref: tag + ref tag + 32 bytes.
    if command_count > reader.remaining() / 22 {
        return Err(BindingError::Truncated);
    }
    let mut commands = Vec::new();
    commands
        .try_reserve_exact(command_count)
        .map_err(|_| BindingError::Limit("OGASC001 command count"))?;
    let mut created = BTreeMap::new();
    let mut created_sheet_ids = BTreeSet::new();
    let mut total_cells = 0usize;
    for command_index in 0..command_count {
        let command = match reader.u8()? {
            0 => {
                let sheet_id = reader.sheet_id()?;
                let name = reader.sheet_name(command_index)?;
                let after = match reader.u8()? {
                    0 => None,
                    1 => Some(reader.precondition(command_index, &created)?),
                    tag => return Err(BindingError::InvalidTag(tag)),
                };
                if created.insert(command_index, sheet_id).is_some()
                    || !created_sheet_ids.insert(sheet_id)
                {
                    return Err(BindingError::NonCanonical(
                        "OGASC001 creates a sheet id more than once",
                    ));
                }
                SpreadsheetCommand::CreateSheet {
                    sheet_id,
                    name,
                    after,
                }
            }
            1 => SpreadsheetCommand::RenameSheet {
                sheet: reader.precondition(command_index, &created)?,
                name: reader.sheet_name(command_index)?,
            },
            2 => SpreadsheetCommand::DeleteSheet {
                sheet: reader.precondition(command_index, &created)?,
            },
            3 => {
                let sheet = reader.precondition(command_index, &created)?;
                let anchor = CellCoord::new(reader.u32()?, reader.u32()?);
                let rows = reader.u32()?;
                let columns = reader.u32()?;
                let count = usize::try_from(rows)
                    .ok()
                    .and_then(|rows| {
                        usize::try_from(columns)
                            .ok()
                            .and_then(|columns| rows.checked_mul(columns))
                    })
                    .ok_or(BindingError::Limit("OGASC001 cell block"))?;
                total_cells = total_cells
                    .checked_add(count)
                    .ok_or(BindingError::Limit("OGASC001 cells"))?;
                if count == 0 || total_cells > MAX_SPREADSHEET_COMMAND_CELLS {
                    return Err(BindingError::Limit("OGASC001 cells"));
                }
                if anchor.row.checked_add(rows - 1).is_none()
                    || anchor.column.checked_add(columns - 1).is_none()
                {
                    return Err(BindingError::NonCanonical(
                        "OGASC001 cell block extent exceeds uint32 coordinates",
                    ));
                }
                if count > reader.remaining() / 2 {
                    return Err(BindingError::Truncated);
                }
                let mut cells = Vec::new();
                cells
                    .try_reserve_exact(count)
                    .map_err(|_| BindingError::Limit("OGASC001 cells"))?;
                for _ in 0..count {
                    cells.push(reader.cell()?);
                }
                SpreadsheetCommand::SetCells {
                    sheet,
                    anchor,
                    cells: CellBlock::new(rows, columns, cells).map_err(|error| {
                        BindingError::Kernel(format!("invalid OGASC001 cell block: {error:?}"))
                    })?,
                }
            }
            4 => {
                let sheet = reader.precondition(command_index, &created)?;
                let start = CellCoord::new(reader.u32()?, reader.u32()?);
                let end = CellCoord::new(reader.u32()?, reader.u32()?);
                if start.row > end.row || start.column > end.column {
                    return Err(BindingError::NonCanonical(
                        "OGASC001 clear range endpoints are not ordered",
                    ));
                }
                SpreadsheetCommand::ClearRange {
                    sheet,
                    range: CellRange::new(start, end),
                }
            }
            tag => return Err(BindingError::InvalidTag(tag)),
        };
        commands.push(command);
    }
    reader.done()?;
    Ok(SpreadsheetCommandBatch {
        commands,
        cell_count: total_cells,
    })
}

#[cfg(test)]
pub(crate) fn encode_spreadsheet_commands(
    commands: &[SpreadsheetCommand],
) -> Result<Vec<u8>, BindingError> {
    let mut payload = Writer::new(MAX_SPREADSHEET_COMMAND_BYTES - HEADER_BYTES - CHECKSUM_BYTES);
    for command in commands {
        payload.command(command)?;
    }
    let payload = payload.finish();
    let mut output = Vec::with_capacity(HEADER_BYTES + payload.len() + CHECKSUM_BYTES);
    output.extend_from_slice(&MAGIC);
    output.extend_from_slice(&SPREADSHEET_COMMAND_VERSION.to_le_bytes());
    output.extend_from_slice(&0u16.to_le_bytes());
    output.extend_from_slice(
        &u32::try_from(commands.len())
            .map_err(|_| BindingError::Limit("OGASC001 command count"))?
            .to_le_bytes(),
    );
    output.extend_from_slice(
        &u64::try_from(payload.len())
            .map_err(|_| BindingError::Limit("OGASC001 payload"))?
            .to_le_bytes(),
    );
    output.extend_from_slice(&payload);
    output.extend_from_slice(&checksum(&output).to_le_bytes());
    if commands.is_empty()
        || commands.len() > MAX_SPREADSHEET_COMMANDS
        || output.len() > MAX_SPREADSHEET_COMMAND_BYTES
    {
        return Err(BindingError::Limit("OGASC001 envelope"));
    }
    Ok(output)
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn remaining(&self) -> usize {
        self.bytes.len() - self.offset
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], BindingError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(BindingError::Limit("OGASC001 payload"))?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or(BindingError::Truncated)?;
        self.offset = end;
        Ok(value)
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

    fn generic_id(&mut self) -> Result<StableId, BindingError> {
        let id = StableId::from_le_bytes(
            self.take(16)?
                .try_into()
                .map_err(|_| BindingError::Truncated)?,
        );
        if id.is_zero() {
            return Err(BindingError::NonCanonical("OGASC001 stable id is all-zero"));
        }
        Ok(id)
    }

    fn sheet_id(&mut self) -> Result<StableId, BindingError> {
        let id = self.generic_id()?;
        if id.namespace() == 0 || id.counter() == 0 {
            return Err(BindingError::NonCanonical(
                "OGASC001 sheet id requires nonzero namespace and counter",
            ));
        }
        Ok(id)
    }

    fn string(&mut self) -> Result<String, BindingError> {
        let length =
            usize::try_from(self.u32()?).map_err(|_| BindingError::Limit("OGASC001 string"))?;
        if length > MAX_SPREADSHEET_COMMAND_STRING_BYTES {
            return Err(BindingError::Limit("OGASC001 string"));
        }
        let value =
            std::str::from_utf8(self.take(length)?).map_err(|_| BindingError::InvalidUtf8)?;
        Ok(value.to_owned())
    }

    fn sheet_name(&mut self, command_index: usize) -> Result<String, BindingError> {
        let value = self.string()?;
        let utf16_units = value.encode_utf16().count();
        if value.is_empty()
            || value.trim() != value
            || utf16_units > 31
            || value.chars().any(|character| {
                matches!(character, '\\' | '/' | '?' | '*' | '[' | ']' | ':' | '\0')
            })
        {
            return Err(BindingError::InvalidIntent(format!(
                "OGASC001 command {command_index} sheet name does not match the public spreadsheet model"
            )));
        }
        Ok(value)
    }

    fn precondition(
        &mut self,
        command_index: usize,
        created: &BTreeMap<usize, StableId>,
    ) -> Result<SheetPrecondition, BindingError> {
        match self.u8()? {
            0 => Ok(SheetPrecondition::Generation(SheetGeneration::new(
                self.sheet_id()?,
                OperationId::from_stable_id(self.generic_id()?),
            ))),
            1 => {
                let sheet_id = self.sheet_id()?;
                let create_command_index = self.u32()?;
                let prior_index = usize::try_from(create_command_index)
                    .map_err(|_| BindingError::Limit("OGASC001 prior-create index"))?;
                if prior_index >= command_index || created.get(&prior_index) != Some(&sheet_id) {
                    return Err(BindingError::NonCanonical(
                        "OGASC001 prior-create reference is not an earlier matching create",
                    ));
                }
                Ok(SheetPrecondition::CreatedInBatch {
                    sheet_id,
                    create_command_index,
                })
            }
            tag => Err(BindingError::InvalidTag(tag)),
        }
    }

    fn cell(&mut self) -> Result<Cell, BindingError> {
        let formula = match self.u8()? {
            0 => None,
            1 => {
                let value = self.string()?;
                if value.is_empty() {
                    return Err(BindingError::NonCanonical(
                        "OGASC001 formula source is empty",
                    ));
                }
                Some(value)
            }
            tag => return Err(BindingError::InvalidTag(tag)),
        };
        let value = match self.u8()? {
            0 => opengeni_artifact_kernel::CellValue::Empty,
            1 => opengeni_artifact_kernel::CellValue::Boolean(false),
            2 => opengeni_artifact_kernel::CellValue::Boolean(true),
            3 => {
                let bits = self.u64()?;
                if bits == (-0.0f64).to_bits() {
                    return Err(BindingError::NonCanonical(
                        "OGASC001 cell number uses negative zero",
                    ));
                }
                opengeni_artifact_kernel::CellValue::Number(
                    Number::new(f64::from_bits(bits)).map_err(BindingError::InvalidCellValue)?,
                )
            }
            4 => opengeni_artifact_kernel::CellValue::Text(self.string()?),
            5 => opengeni_artifact_kernel::CellValue::Error(self.formula_error()?),
            6 => opengeni_artifact_kernel::CellValue::Date(
                DateValue::new(self.u64()? as i64).map_err(BindingError::InvalidCellValue)?,
            ),
            tag => return Err(BindingError::InvalidTag(tag)),
        };
        match formula {
            Some(source) => Cell::formula(source, value).map_err(BindingError::InvalidCellValue),
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
            9 => Ok(FormulaError::Custom(self.string()?)),
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

#[cfg(test)]
struct Writer {
    bytes: Vec<u8>,
    maximum: usize,
}

#[cfg(test)]
impl Writer {
    fn new(maximum: usize) -> Self {
        Self {
            bytes: Vec::new(),
            maximum,
        }
    }

    fn bytes(&mut self, value: &[u8]) -> Result<(), BindingError> {
        if value.len() > self.maximum.saturating_sub(self.bytes.len()) {
            return Err(BindingError::Limit("OGASC001 payload"));
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
        if value.len() > MAX_SPREADSHEET_COMMAND_STRING_BYTES {
            return Err(BindingError::Limit("OGASC001 string"));
        }
        self.u32(u32::try_from(value.len()).map_err(|_| BindingError::Limit("OGASC001 string"))?)?;
        self.bytes(value.as_bytes())
    }

    fn precondition(&mut self, value: SheetPrecondition) -> Result<(), BindingError> {
        match value {
            SheetPrecondition::Generation(generation) => {
                self.u8(0)?;
                self.id(generation.sheet_id())?;
                self.id(generation.creation().stable_id())
            }
            SheetPrecondition::CreatedInBatch {
                sheet_id,
                create_command_index,
            } => {
                self.u8(1)?;
                self.id(sheet_id)?;
                self.u32(create_command_index)
            }
        }
    }

    fn command(&mut self, command: &SpreadsheetCommand) -> Result<(), BindingError> {
        match command {
            SpreadsheetCommand::CreateSheet {
                sheet_id,
                name,
                after,
            } => {
                self.u8(0)?;
                self.id(*sheet_id)?;
                self.string(name)?;
                match after {
                    None => self.u8(0),
                    Some(after) => {
                        self.u8(1)?;
                        self.precondition(*after)
                    }
                }
            }
            SpreadsheetCommand::RenameSheet { sheet, name } => {
                self.u8(1)?;
                self.precondition(*sheet)?;
                self.string(name)
            }
            SpreadsheetCommand::DeleteSheet { sheet } => {
                self.u8(2)?;
                self.precondition(*sheet)
            }
            SpreadsheetCommand::SetCells {
                sheet,
                anchor,
                cells,
            } => {
                self.u8(3)?;
                self.precondition(*sheet)?;
                self.u32(anchor.row)?;
                self.u32(anchor.column)?;
                self.u32(cells.rows())?;
                self.u32(cells.columns())?;
                for cell in cells.cells() {
                    self.cell(cell)?;
                }
                Ok(())
            }
            SpreadsheetCommand::ClearRange { sheet, range } => {
                self.u8(4)?;
                self.precondition(*sheet)?;
                self.u32(range.start.row)?;
                self.u32(range.start.column)?;
                self.u32(range.end.row)?;
                self.u32(range.end.column)
            }
        }
    }

    fn cell(&mut self, cell: &Cell) -> Result<(), BindingError> {
        match cell.formula_source() {
            None => self.u8(0)?,
            Some(source) => {
                self.u8(1)?;
                self.string(source)?;
            }
        }
        match cell.value() {
            opengeni_artifact_kernel::CellValue::Empty => self.u8(0),
            opengeni_artifact_kernel::CellValue::Boolean(false) => self.u8(1),
            opengeni_artifact_kernel::CellValue::Boolean(true) => self.u8(2),
            opengeni_artifact_kernel::CellValue::Number(value) => {
                self.u8(3)?;
                self.u64(value.get().to_bits())
            }
            opengeni_artifact_kernel::CellValue::Date(value) => {
                self.u8(6)?;
                self.u64(value.milliseconds() as u64)
            }
            opengeni_artifact_kernel::CellValue::Text(value) => {
                self.u8(4)?;
                self.string(value)
            }
            opengeni_artifact_kernel::CellValue::Error(error) => {
                self.u8(5)?;
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
                    FormulaError::Custom(value) => {
                        self.u8(9)?;
                        return self.string(value);
                    }
                };
                self.u8(tag)
            }
        }
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
}
