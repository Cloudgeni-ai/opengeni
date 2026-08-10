use std::collections::BTreeMap;

use crate::{Cell, StableId};

pub const TILE_EDGE: u32 = 256;
pub const TILE_CELL_COUNT: u32 = TILE_EDGE * TILE_EDGE;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct CellCoord {
    pub row: u32,
    pub column: u32,
}

impl CellCoord {
    #[must_use]
    pub const fn new(row: u32, column: u32) -> Self {
        Self { row, column }
    }

    #[must_use]
    pub const fn tile(self) -> TileCoord {
        TileCoord {
            row: self.row / TILE_EDGE,
            column: self.column / TILE_EDGE,
        }
    }

    #[must_use]
    pub const fn local_index(self) -> u16 {
        let row = self.row % TILE_EDGE;
        let column = self.column % TILE_EDGE;
        (row * TILE_EDGE + column) as u16
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct TileCoord {
    row: u32,
    column: u32,
}

impl TileCoord {
    pub const MAX_AXIS: u32 = u32::MAX / TILE_EDGE;

    pub fn new(row: u32, column: u32) -> Result<Self, CellBlockError> {
        if row > Self::MAX_AXIS || column > Self::MAX_AXIS {
            return Err(CellBlockError::CoordinateOverflow);
        }
        Ok(Self { row, column })
    }

    #[must_use]
    pub const fn row(self) -> u32 {
        self.row
    }

    #[must_use]
    pub const fn column(self) -> u32 {
        self.column
    }

    #[must_use]
    pub const fn cell_coord(self, local_index: u16) -> CellCoord {
        let local_index = local_index as u32;
        CellCoord {
            row: self.row * TILE_EDGE + local_index / TILE_EDGE,
            column: self.column * TILE_EDGE + local_index % TILE_EDGE,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CellRange {
    pub start: CellCoord,
    pub end: CellCoord,
}

impl CellRange {
    #[must_use]
    pub const fn new(first: CellCoord, second: CellCoord) -> Self {
        Self {
            start: CellCoord {
                row: if first.row < second.row {
                    first.row
                } else {
                    second.row
                },
                column: if first.column < second.column {
                    first.column
                } else {
                    second.column
                },
            },
            end: CellCoord {
                row: if first.row > second.row {
                    first.row
                } else {
                    second.row
                },
                column: if first.column > second.column {
                    first.column
                } else {
                    second.column
                },
            },
        }
    }

    pub fn from_anchor_size(
        anchor: CellCoord,
        rows: u32,
        columns: u32,
    ) -> Result<Self, CellBlockError> {
        if rows == 0 || columns == 0 {
            return Err(CellBlockError::EmptyDimensions);
        }
        let end_row = anchor
            .row
            .checked_add(rows - 1)
            .ok_or(CellBlockError::CoordinateOverflow)?;
        let end_column = anchor
            .column
            .checked_add(columns - 1)
            .ok_or(CellBlockError::CoordinateOverflow)?;
        Ok(Self::new(anchor, CellCoord::new(end_row, end_column)))
    }

    #[must_use]
    pub const fn contains(self, coord: CellCoord) -> bool {
        coord.row >= self.start.row
            && coord.row <= self.end.row
            && coord.column >= self.start.column
            && coord.column <= self.end.column
    }
}

/// A compact, row-major rectangular cell payload used at command boundaries.
#[derive(Clone, Debug, PartialEq)]
pub struct CellBlock {
    rows: u32,
    columns: u32,
    cells: Vec<Cell>,
}

impl CellBlock {
    pub fn new(rows: u32, columns: u32, cells: Vec<Cell>) -> Result<Self, CellBlockError> {
        if rows == 0 || columns == 0 {
            return Err(CellBlockError::EmptyDimensions);
        }
        let expected = (rows as usize)
            .checked_mul(columns as usize)
            .ok_or(CellBlockError::DimensionOverflow)?;
        if expected != cells.len() {
            return Err(CellBlockError::LengthMismatch {
                expected,
                actual: cells.len(),
            });
        }
        Ok(Self {
            rows,
            columns,
            cells,
        })
    }

    #[must_use]
    pub const fn rows(&self) -> u32 {
        self.rows
    }

    #[must_use]
    pub const fn columns(&self) -> u32 {
        self.columns
    }

    #[must_use]
    pub fn cells(&self) -> &[Cell] {
        &self.cells
    }

    pub(crate) fn validate_anchor(&self, anchor: CellCoord) -> Result<(), CellBlockError> {
        CellRange::from_anchor_size(anchor, self.rows, self.columns).map(|_| ())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CellBlockError {
    EmptyDimensions,
    DimensionOverflow,
    CoordinateOverflow,
    LengthMismatch { expected: usize, actual: usize },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Tile {
    // Sorted contiguous storage keeps sparse tiles compact and cache-friendly.
    // Rectangle writes arrive in local-index order and therefore append in the
    // common path; point reads remain logarithmic.
    cells: Vec<(u16, Cell)>,
}

impl Tile {
    fn get(&self, local_index: u16) -> Option<&Cell> {
        self.cells
            .binary_search_by_key(&local_index, |(index, _)| *index)
            .ok()
            .map(|position| &self.cells[position].1)
    }

    fn set(&mut self, local_index: u16, cell: Cell) {
        match self
            .cells
            .binary_search_by_key(&local_index, |(index, _)| *index)
        {
            Ok(position) if cell.is_empty() => {
                self.cells.remove(position);
            }
            Ok(position) => self.cells[position].1 = cell,
            Err(_) if cell.is_empty() => {}
            Err(position) => self.cells.insert(position, (local_index, cell)),
        }
    }

    /// Replaces one sparse entry and returns the previous non-empty value.
    ///
    /// Unlike `set`, this moves the old value out of the tile. Transaction
    /// journals use that property to retain only overwritten cells without
    /// cloning either the tile or the sheet that owns it.
    fn replace(&mut self, local_index: u16, cell: Cell) -> Option<Cell> {
        match self
            .cells
            .binary_search_by_key(&local_index, |(index, _)| *index)
        {
            Ok(position) if cell.is_empty() => Some(self.cells.remove(position).1),
            Ok(position) => Some(core::mem::replace(&mut self.cells[position].1, cell)),
            Err(_) if cell.is_empty() => None,
            Err(position) => {
                self.cells.insert(position, (local_index, cell));
                None
            }
        }
    }

    fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }

    pub(crate) fn cells(&self) -> &[(u16, Cell)] {
        &self.cells
    }

    pub(crate) fn from_cells(cells: Vec<(u16, Cell)>) -> Self {
        Self { cells }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Sheet {
    pub(crate) id: StableId,
    pub(crate) name: String,
    pub(crate) tiles: BTreeMap<TileCoord, Tile>,
}

impl Sheet {
    pub(crate) fn new(id: StableId, name: String) -> Self {
        Self {
            id,
            name,
            tiles: BTreeMap::new(),
        }
    }

    #[must_use]
    pub const fn id(&self) -> StableId {
        self.id
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    #[must_use]
    pub fn cell(&self, coord: CellCoord) -> Option<&Cell> {
        self.tiles
            .get(&coord.tile())
            .and_then(|tile| tile.get(coord.local_index()))
    }

    #[must_use]
    pub fn tile_count(&self) -> usize {
        self.tiles.len()
    }

    #[must_use]
    pub fn non_empty_cell_count(&self) -> usize {
        self.tiles.values().map(|tile| tile.cells.len()).sum()
    }

    pub fn cells(&self) -> impl Iterator<Item = (CellCoord, &Cell)> {
        self.tiles.iter().flat_map(|(tile_coord, tile)| {
            tile.cells
                .iter()
                .map(move |(local_index, cell)| (tile_coord.cell_coord(*local_index), cell))
        })
    }

    pub(crate) fn set_cell(&mut self, coord: CellCoord, cell: Cell) {
        let tile_coord = coord.tile();
        let local_index = coord.local_index();
        if cell.is_empty() {
            if let Some(tile) = self.tiles.get_mut(&tile_coord) {
                tile.set(local_index, cell);
                if tile.is_empty() {
                    self.tiles.remove(&tile_coord);
                }
            }
            return;
        }

        self.tiles
            .entry(tile_coord)
            .or_default()
            .set(local_index, cell);
    }

    /// Replaces a cell while moving the previous value to the caller.
    ///
    /// This is the primitive used by the reversible transaction path. Empty
    /// tiles are removed eagerly, preserving the same canonical sparse model
    /// as `set_cell`.
    pub(crate) fn replace_cell(&mut self, coord: CellCoord, cell: Cell) -> Option<Cell> {
        let tile_coord = coord.tile();
        let local_index = coord.local_index();
        if cell.is_empty() {
            let (previous, remove_tile) = {
                let tile = self.tiles.get_mut(&tile_coord)?;
                let previous = tile.replace(local_index, cell);
                (previous, tile.is_empty())
            };
            if remove_tile {
                self.tiles.remove(&tile_coord);
            }
            return previous;
        }

        self.tiles
            .entry(tile_coord)
            .or_default()
            .replace(local_index, cell)
    }

    pub(crate) fn set_block(&mut self, anchor: CellCoord, block: &CellBlock) {
        for row in 0..block.rows {
            for column in 0..block.columns {
                let index = row as usize * block.columns as usize + column as usize;
                let coord = CellCoord::new(anchor.row + row, anchor.column + column);
                self.set_cell(coord, block.cells[index].clone());
            }
        }
    }

    pub(crate) fn clear_range(&mut self, range: CellRange) -> usize {
        let mut removed = 0usize;
        self.tiles.retain(|tile_coord, tile| {
            if !tile_intersects_range(*tile_coord, range) {
                return true;
            }
            if range_contains_tile(range, *tile_coord) {
                removed += tile.cells.len();
                return false;
            }
            tile.cells.retain(|(local_index, _)| {
                let keep = !range.contains(tile_coord.cell_coord(*local_index));
                if !keep {
                    removed += 1;
                }
                keep
            });
            !tile.is_empty()
        });
        removed
    }

    /// Removes and returns all cells in a range in canonical coordinate order.
    ///
    /// Values are moved, not cloned. This lets a rollback journal own exactly
    /// the cells cleared by a transaction while leaving unrelated tiles alone.
    pub(crate) fn take_range(&mut self, range: CellRange) -> Vec<(CellCoord, Cell)> {
        let mut removed = Vec::new();
        self.tiles.retain(|tile_coord, tile| {
            if !tile_intersects_range(*tile_coord, range) {
                return true;
            }
            if range_contains_tile(range, *tile_coord) {
                removed.extend(
                    core::mem::take(&mut tile.cells)
                        .into_iter()
                        .map(|(local_index, cell)| (tile_coord.cell_coord(local_index), cell)),
                );
                return false;
            }
            let mut retained = Vec::with_capacity(tile.cells.len());
            for (local_index, cell) in core::mem::take(&mut tile.cells) {
                let coord = tile_coord.cell_coord(local_index);
                if range.contains(coord) {
                    removed.push((coord, cell));
                } else {
                    retained.push((local_index, cell));
                }
            }
            tile.cells = retained;
            !tile.is_empty()
        });
        removed
    }
}

fn tile_intersects_range(tile: TileCoord, range: CellRange) -> bool {
    let start = range.start.tile();
    let end = range.end.tile();
    tile.row >= start.row
        && tile.row <= end.row
        && tile.column >= start.column
        && tile.column <= end.column
}

fn range_contains_tile(range: CellRange, tile: TileCoord) -> bool {
    let start = tile.cell_coord(0);
    let end = tile.cell_coord(u16::MAX);
    range.start.row <= start.row
        && range.start.column <= start.column
        && range.end.row >= end.row
        && range.end.column >= end.column
}

#[cfg(test)]
mod tests {
    use super::{CellBlock, CellCoord, CellRange, Sheet, TileCoord};
    use crate::{Cell, StableId};

    #[test]
    fn tile_boundaries_are_exact() {
        let mut sheet = Sheet::new(StableId::from_parts(1, 1), "Sheet".into());
        for coord in [
            CellCoord::new(255, 255),
            CellCoord::new(256, 255),
            CellCoord::new(255, 256),
            CellCoord::new(256, 256),
        ] {
            sheet.set_cell(coord, Cell::from("x"));
        }
        assert_eq!(sheet.tile_count(), 4);
        assert_eq!(sheet.non_empty_cell_count(), 4);
    }

    #[test]
    fn tile_coordinates_cannot_overflow_cell_coordinates() {
        let maximum = TileCoord::new(TileCoord::MAX_AXIS, TileCoord::MAX_AXIS)
            .expect("maximum tile coordinate");
        assert_eq!(
            maximum.cell_coord(u16::MAX),
            CellCoord::new(u32::MAX, u32::MAX)
        );
        assert!(TileCoord::new(TileCoord::MAX_AXIS + 1, 0).is_err());
    }

    #[test]
    fn empty_cells_deallocate_tiles() {
        let mut sheet = Sheet::new(StableId::from_parts(1, 1), "Sheet".into());
        let coord = CellCoord::new(10, 20);
        sheet.set_cell(coord, Cell::from("x"));
        sheet.set_cell(coord, Cell::empty());
        assert_eq!(sheet.tile_count(), 0);
    }

    #[test]
    fn block_is_row_major_and_range_clear_is_sparse() {
        let mut sheet = Sheet::new(StableId::from_parts(1, 1), "Sheet".into());
        let block = CellBlock::new(
            2,
            2,
            vec![
                Cell::from("a"),
                Cell::from("b"),
                Cell::from("c"),
                Cell::from("d"),
            ],
        )
        .expect("valid block");
        sheet.set_block(CellCoord::new(255, 255), &block);
        assert_eq!(sheet.tile_count(), 4);
        assert_eq!(sheet.cell(CellCoord::new(256, 256)), Some(&Cell::from("d")));
        assert_eq!(
            sheet.clear_range(CellRange::new(
                CellCoord::new(255, 256),
                CellCoord::new(256, 256)
            )),
            2
        );
        assert_eq!(sheet.non_empty_cell_count(), 2);
    }
}
