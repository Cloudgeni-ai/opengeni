use core::fmt;
use std::collections::{BTreeMap, BTreeSet};

use sha2::{Digest, Sha256};

use super::{
    FontAssetHash, FontId, GlyphDirection, LayoutError, LayoutUnit, ParagraphLayout,
    PositionedGlyph, TextPaint,
};

const TILE_MAGIC: [u8; 8] = *b"OGRTI001";
const PATCH_MAGIC: [u8; 8] = *b"OGRPA001";
const TILE_CHECKSUM_BYTES: usize = 16;
const TILE_HEADER_BYTES: usize = 8 + 2 + 2 + 4 + 8 + 4 + 4 + 4 + 4;
const PATCH_HEADER_BYTES: usize = 8 + 2 + 2 + 4 + 8 + 8 + 4 + 4 + 4;
const COMMAND_ID_DOMAIN: &[u8] = b"opengeni:artifact:render-command:v1\0";

pub const RENDER_TILE_PROTOCOL_VERSION: u16 = 1;
pub const RENDER_PATCH_PROTOCOL_VERSION: u16 = 1;

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct RenderSceneId([u8; 16]);

impl RenderSceneId {
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct RenderCommandId(u64);

impl RenderCommandId {
    pub fn new(value: u64) -> Result<Self, RenderSceneError> {
        if value == 0 {
            Err(RenderSceneError::Invalid("command id must be non-zero"))
        } else {
            Ok(Self(value))
        }
    }

    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct RenderTileKey {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RenderRect {
    pub x: LayoutUnit,
    pub y: LayoutUnit,
    pub width: LayoutUnit,
    pub height: LayoutUnit,
}

impl RenderRect {
    pub fn new(
        x: LayoutUnit,
        y: LayoutUnit,
        width: LayoutUnit,
        height: LayoutUnit,
    ) -> Result<Self, RenderSceneError> {
        if width.raw() < 0 || height.raw() < 0 {
            return Err(RenderSceneError::Invalid(
                "render rectangle dimensions must be non-negative",
            ));
        }
        x.raw()
            .checked_add(width.raw())
            .and_then(|_| y.raw().checked_add(height.raw()))
            .ok_or(RenderSceneError::CoordinateOverflow)?;
        Ok(Self {
            x,
            y,
            width,
            height,
        })
    }

    fn tile_keys(
        self,
        edge: LayoutUnit,
        max_memberships: usize,
    ) -> Result<Vec<RenderTileKey>, RenderSceneError> {
        if edge.raw() <= 0 {
            return Err(RenderSceneError::Invalid("tile edge must be positive"));
        }
        if self.width.raw() == 0 || self.height.raw() == 0 {
            return Ok(Vec::new());
        }
        let right = self
            .x
            .raw()
            .checked_add(self.width.raw())
            .and_then(|value| value.checked_sub(1))
            .ok_or(RenderSceneError::CoordinateOverflow)?;
        let bottom = self
            .y
            .raw()
            .checked_add(self.height.raw())
            .and_then(|value| value.checked_sub(1))
            .ok_or(RenderSceneError::CoordinateOverflow)?;
        let min_x = self.x.raw().div_euclid(edge.raw());
        let max_x = right.div_euclid(edge.raw());
        let min_y = self.y.raw().div_euclid(edge.raw());
        let max_y = bottom.div_euclid(edge.raw());
        let width = i64::from(max_x) - i64::from(min_x) + 1;
        let height = i64::from(max_y) - i64::from(min_y) + 1;
        let count = width
            .checked_mul(height)
            .and_then(|value| usize::try_from(value).ok())
            .ok_or(RenderSceneError::LimitExceeded("tile memberships"))?;
        if count > max_memberships {
            return Err(RenderSceneError::LimitExceeded("tile memberships"));
        }
        let mut keys = Vec::with_capacity(count);
        for y in min_y..=max_y {
            for x in min_x..=max_x {
                keys.push(RenderTileKey { x, y });
            }
        }
        Ok(keys)
    }

    fn intersects(self, other: Self) -> Result<bool, RenderSceneError> {
        let self_right = self
            .x
            .raw()
            .checked_add(self.width.raw())
            .ok_or(RenderSceneError::CoordinateOverflow)?;
        let self_bottom = self
            .y
            .raw()
            .checked_add(self.height.raw())
            .ok_or(RenderSceneError::CoordinateOverflow)?;
        let other_right = other
            .x
            .raw()
            .checked_add(other.width.raw())
            .ok_or(RenderSceneError::CoordinateOverflow)?;
        let other_bottom = other
            .y
            .raw()
            .checked_add(other.height.raw())
            .ok_or(RenderSceneError::CoordinateOverflow)?;
        Ok(self.width.raw() > 0
            && self.height.raw() > 0
            && other.width.raw() > 0
            && other.height.raw() > 0
            && self.x.raw() < other_right
            && other.x.raw() < self_right
            && self.y.raw() < other_bottom
            && other.y.raw() < self_bottom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RenderCommand {
    FillRect {
        id: RenderCommandId,
        bounds: RenderRect,
        rgba: u32,
    },
    GlyphRun {
        id: RenderCommandId,
        bounds: RenderRect,
        font_id: FontId,
        font_asset_hash: FontAssetHash,
        font_size: LayoutUnit,
        paint: TextPaint,
        direction: GlyphDirection,
        text_start: u64,
        text_end: u64,
        glyphs: Vec<PositionedGlyph>,
    },
}

impl RenderCommand {
    #[must_use]
    pub const fn id(&self) -> RenderCommandId {
        match self {
            Self::FillRect { id, .. } | Self::GlyphRun { id, .. } => *id,
        }
    }

    #[must_use]
    pub const fn bounds(&self) -> RenderRect {
        match self {
            Self::FillRect { bounds, .. } | Self::GlyphRun { bounds, .. } => *bounds,
        }
    }

    #[must_use]
    pub fn glyph_count(&self) -> usize {
        match self {
            Self::FillRect { .. } => 0,
            Self::GlyphRun { glyphs, .. } => glyphs.len(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RenderTile {
    pub revision: u64,
    pub key: RenderTileKey,
    pub tile_edge: LayoutUnit,
    pub commands: Vec<RenderCommand>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RenderPatch {
    pub base_revision: u64,
    pub revision: u64,
    pub removed: Vec<RenderCommandId>,
    pub upserted: Vec<RenderCommand>,
    pub invalidated_tiles: Vec<RenderTileKey>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RetainedRenderLimits {
    pub max_commands: usize,
    pub max_glyphs: usize,
    pub max_tile_memberships: usize,
    pub max_commands_per_tile: usize,
    pub max_encoded_tile_bytes: usize,
    pub max_encoded_patch_bytes: usize,
}

impl Default for RetainedRenderLimits {
    fn default() -> Self {
        Self {
            max_commands: 100_000,
            max_glyphs: 4_000_000,
            max_tile_memberships: 1_000_000,
            max_commands_per_tile: 16_384,
            max_encoded_tile_bytes: 64 * 1024 * 1024,
            max_encoded_patch_bytes: 64 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RenderSceneError {
    LimitExceeded(&'static str),
    Invalid(&'static str),
    CoordinateOverflow,
    CommandIdCollision(RenderCommandId),
    Truncated,
    ChecksumMismatch,
    LengthMismatch,
    UnsupportedVersion(u16),
    NonCanonical(&'static str),
    Layout(LayoutError),
}

impl fmt::Display for RenderSceneError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LimitExceeded(limit) => write!(formatter, "render limit exceeded: {limit}"),
            Self::Invalid(reason) => write!(formatter, "invalid render scene: {reason}"),
            Self::CoordinateOverflow => formatter.write_str("render coordinate overflow"),
            Self::CommandIdCollision(id) => {
                write!(formatter, "render command id collision: {id:?}")
            }
            Self::Truncated => formatter.write_str("truncated retained-render envelope"),
            Self::ChecksumMismatch => {
                formatter.write_str("retained-render envelope checksum mismatch")
            }
            Self::LengthMismatch => formatter.write_str("retained-render envelope length mismatch"),
            Self::UnsupportedVersion(version) => {
                write!(formatter, "unsupported retained-render version {version}")
            }
            Self::NonCanonical(reason) => {
                write!(
                    formatter,
                    "non-canonical retained-render envelope: {reason}"
                )
            }
            Self::Layout(error) => write!(formatter, "layout error: {error}"),
        }
    }
}

impl std::error::Error for RenderSceneError {}

impl From<LayoutError> for RenderSceneError {
    fn from(value: LayoutError) -> Self {
        Self::Layout(value)
    }
}

/// Retained command map plus sparse tile index. Scene updates never rasterize;
/// native hosts, browser Canvas/WebGPU and sandbox renderers consume the same
/// immutable command protocol and choose their own glyph atlas implementation.
#[derive(Clone, Debug)]
pub struct RetainedRenderScene {
    scene_id: RenderSceneId,
    revision: u64,
    tile_edge: LayoutUnit,
    commands: BTreeMap<RenderCommandId, RenderCommand>,
    tiles: BTreeMap<RenderTileKey, Vec<RenderCommandId>>,
    limits: RetainedRenderLimits,
}

impl RetainedRenderScene {
    pub fn from_paragraph(
        scene_id: RenderSceneId,
        revision: u64,
        origin_x: LayoutUnit,
        origin_y: LayoutUnit,
        layout: &ParagraphLayout,
        tile_edge: LayoutUnit,
        limits: RetainedRenderLimits,
    ) -> Result<Self, RenderSceneError> {
        if tile_edge.raw() <= 0 {
            return Err(RenderSceneError::Invalid("tile edge must be positive"));
        }
        if layout.glyph_runs.len() > limits.max_commands {
            return Err(RenderSceneError::LimitExceeded("render commands"));
        }
        let glyph_count = layout
            .glyph_runs
            .iter()
            .map(|run| run.glyphs.len())
            .try_fold(0usize, usize::checked_add)
            .ok_or(RenderSceneError::LimitExceeded("render glyphs"))?;
        if glyph_count > limits.max_glyphs {
            return Err(RenderSceneError::LimitExceeded("render glyphs"));
        }

        let mut commands = BTreeMap::new();
        let mut tiles: BTreeMap<RenderTileKey, Vec<RenderCommandId>> = BTreeMap::new();
        let mut membership_count = 0usize;
        for run in &layout.glyph_runs {
            if run.glyphs.is_empty() {
                continue;
            }
            let id = derive_command_id(scene_id, run);
            let (min_x, min_y, max_x, max_y) = glyph_run_ink_bounds(&run.glyphs)?;
            let bounds = RenderRect::new(
                origin_x.checked_add(LayoutUnit::from_raw(min_x))?,
                origin_y.checked_add(LayoutUnit::from_raw(min_y))?,
                LayoutUnit::from_raw(
                    max_x
                        .checked_sub(min_x)
                        .ok_or(RenderSceneError::CoordinateOverflow)?,
                ),
                LayoutUnit::from_raw(
                    max_y
                        .checked_sub(min_y)
                        .ok_or(RenderSceneError::CoordinateOverflow)?,
                ),
            )?;
            let mut glyphs = run.glyphs.clone();
            for glyph in &mut glyphs {
                glyph.x = glyph.x.checked_add(origin_x)?;
                glyph.y = glyph.y.checked_add(origin_y)?;
            }
            let command = RenderCommand::GlyphRun {
                id,
                bounds,
                font_id: run.font_id,
                font_asset_hash: run.font_asset_hash,
                font_size: run.font_size,
                paint: run.paint,
                direction: run.direction,
                text_start: u64::try_from(run.text_range.start)
                    .map_err(|_| RenderSceneError::LimitExceeded("text offset"))?,
                text_end: u64::try_from(run.text_range.end)
                    .map_err(|_| RenderSceneError::LimitExceeded("text offset"))?,
                glyphs,
            };
            validate_render_command(&command)?;
            if commands.insert(id, command).is_some() {
                return Err(RenderSceneError::CommandIdCollision(id));
            }
            let memberships = bounds.tile_keys(tile_edge, limits.max_tile_memberships)?;
            membership_count = membership_count
                .checked_add(memberships.len())
                .ok_or(RenderSceneError::LimitExceeded("tile memberships"))?;
            if membership_count > limits.max_tile_memberships {
                return Err(RenderSceneError::LimitExceeded("tile memberships"));
            }
            for key in memberships {
                let ids = tiles.entry(key).or_default();
                if ids.len() >= limits.max_commands_per_tile {
                    return Err(RenderSceneError::LimitExceeded("commands per tile"));
                }
                ids.push(id);
            }
        }
        for ids in tiles.values_mut() {
            ids.sort_unstable();
        }
        Ok(Self {
            scene_id,
            revision,
            tile_edge,
            commands,
            tiles,
            limits,
        })
    }

    #[must_use]
    pub const fn scene_id(&self) -> RenderSceneId {
        self.scene_id
    }

    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }

    #[must_use]
    pub fn command_count(&self) -> usize {
        self.commands.len()
    }

    #[must_use]
    pub fn tile_count(&self) -> usize {
        self.tiles.len()
    }

    pub fn tile(&self, key: RenderTileKey) -> Result<RenderTile, RenderSceneError> {
        let ids = self.tiles.get(&key).map(Vec::as_slice).unwrap_or_default();
        if ids.len() > self.limits.max_commands_per_tile {
            return Err(RenderSceneError::LimitExceeded("commands per tile"));
        }
        let commands = ids
            .iter()
            .map(|id| {
                self.commands
                    .get(id)
                    .cloned()
                    .ok_or(RenderSceneError::Invalid(
                        "tile references a missing command",
                    ))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(RenderTile {
            revision: self.revision,
            key,
            tile_edge: self.tile_edge,
            commands,
        })
    }

    pub fn diff(&self, next: &Self) -> Result<RenderPatch, RenderSceneError> {
        if self.scene_id != next.scene_id {
            return Err(RenderSceneError::Invalid(
                "cannot diff different retained scenes",
            ));
        }
        if next.revision <= self.revision {
            return Err(RenderSceneError::Invalid(
                "render scene revision must advance",
            ));
        }
        let removed = self
            .commands
            .keys()
            .filter(|id| !next.commands.contains_key(id))
            .copied()
            .collect::<Vec<_>>();
        let upserted = next
            .commands
            .iter()
            .filter(|(id, command)| self.commands.get(id) != Some(*command))
            .map(|(_, command)| command.clone())
            .collect::<Vec<_>>();
        let changed_ids = removed
            .iter()
            .copied()
            .chain(upserted.iter().map(RenderCommand::id))
            .collect::<BTreeSet<_>>();
        let mut invalidated_tiles = BTreeSet::new();
        for (key, ids) in &self.tiles {
            if next.tiles.get(key) != Some(ids) || ids.iter().any(|id| changed_ids.contains(id)) {
                invalidated_tiles.insert(*key);
            }
        }
        for (key, ids) in &next.tiles {
            if self.tiles.get(key) != Some(ids) || ids.iter().any(|id| changed_ids.contains(id)) {
                invalidated_tiles.insert(*key);
            }
        }
        Ok(RenderPatch {
            base_revision: self.revision,
            revision: next.revision,
            removed,
            upserted,
            invalidated_tiles: invalidated_tiles.into_iter().collect(),
        })
    }
}

pub fn encode_render_tile(
    tile: &RenderTile,
    limits: RetainedRenderLimits,
) -> Result<Vec<u8>, RenderSceneError> {
    validate_tile(tile, limits)?;
    let total = encoded_tile_size(tile)?;
    let mut output = Vec::with_capacity(total);
    output.extend_from_slice(&TILE_MAGIC);
    push_u16(&mut output, RENDER_TILE_PROTOCOL_VERSION);
    push_u16(&mut output, 0);
    push_u32(&mut output, 0);
    push_u64(&mut output, tile.revision);
    push_i32(&mut output, tile.key.x);
    push_i32(&mut output, tile.key.y);
    push_i32(&mut output, tile.tile_edge.raw());
    push_u32(
        &mut output,
        u32::try_from(tile.commands.len())
            .map_err(|_| RenderSceneError::LimitExceeded("commands per tile"))?,
    );
    for command in &tile.commands {
        encode_render_command(&mut output, command)?;
    }
    output[12..16].copy_from_slice(&(total as u32).to_le_bytes());
    let checksum = Sha256::digest(&output);
    output.extend_from_slice(&checksum[..TILE_CHECKSUM_BYTES]);
    Ok(output)
}

pub fn decode_render_tile(
    bytes: &[u8],
    limits: RetainedRenderLimits,
) -> Result<RenderTile, RenderSceneError> {
    if bytes.len() < TILE_HEADER_BYTES + TILE_CHECKSUM_BYTES {
        return Err(RenderSceneError::Truncated);
    }
    if bytes.len() > limits.max_encoded_tile_bytes {
        return Err(RenderSceneError::LimitExceeded("encoded tile bytes"));
    }
    let payload_end = bytes.len() - TILE_CHECKSUM_BYTES;
    let expected = Sha256::digest(&bytes[..payload_end]);
    if expected[..TILE_CHECKSUM_BYTES] != bytes[payload_end..] {
        return Err(RenderSceneError::ChecksumMismatch);
    }
    let mut reader = Reader::new(&bytes[..payload_end]);
    if reader.take(8)? != TILE_MAGIC {
        return Err(RenderSceneError::Invalid("render tile magic"));
    }
    let version = reader.u16()?;
    if version != RENDER_TILE_PROTOCOL_VERSION {
        return Err(RenderSceneError::UnsupportedVersion(version));
    }
    if reader.u16()? != 0 {
        return Err(RenderSceneError::NonCanonical("header flags"));
    }
    if usize::try_from(reader.u32()?).ok() != Some(bytes.len()) {
        return Err(RenderSceneError::LengthMismatch);
    }
    let revision = reader.u64()?;
    let key = RenderTileKey {
        x: reader.i32()?,
        y: reader.i32()?,
    };
    let tile_edge = LayoutUnit::from_raw(reader.i32()?);
    let command_count = reader.u32()? as usize;
    if command_count > limits.max_commands_per_tile {
        return Err(RenderSceneError::LimitExceeded("commands per tile"));
    }
    let mut commands = Vec::with_capacity(command_count);
    let mut glyph_count = 0usize;
    let mut previous_id = None;
    for _ in 0..command_count {
        let command = decode_render_command(&mut reader, &mut glyph_count, limits)?;
        let id = command.id();
        if previous_id.is_some_and(|previous| previous >= id) {
            return Err(RenderSceneError::NonCanonical(
                "commands must be sorted by unique id",
            ));
        }
        previous_id = Some(id);
        commands.push(command);
    }
    if reader.remaining() != 0 {
        return Err(RenderSceneError::NonCanonical("trailing payload bytes"));
    }
    let tile = RenderTile {
        revision,
        key,
        tile_edge,
        commands,
    };
    validate_tile(&tile, limits)?;
    // Decode accepts only the single canonical representation.
    if encode_render_tile(&tile, limits)? != bytes {
        return Err(RenderSceneError::NonCanonical("render tile encoding"));
    }
    Ok(tile)
}

/// Encodes one retained-scene delta. Removed ids, upserts and invalidated tile
/// keys are strictly ordered, making the envelope content-addressable and
/// byte-identical in native and Wasm builds.
pub fn encode_render_patch(
    patch: &RenderPatch,
    limits: RetainedRenderLimits,
) -> Result<Vec<u8>, RenderSceneError> {
    validate_patch(patch, limits)?;
    let total = encoded_patch_size(patch)?;
    let mut output = Vec::with_capacity(total);
    output.extend_from_slice(&PATCH_MAGIC);
    push_u16(&mut output, RENDER_PATCH_PROTOCOL_VERSION);
    push_u16(&mut output, 0);
    push_u32(&mut output, 0);
    push_u64(&mut output, patch.base_revision);
    push_u64(&mut output, patch.revision);
    push_u32(
        &mut output,
        u32::try_from(patch.removed.len())
            .map_err(|_| RenderSceneError::LimitExceeded("render commands"))?,
    );
    push_u32(
        &mut output,
        u32::try_from(patch.upserted.len())
            .map_err(|_| RenderSceneError::LimitExceeded("render commands"))?,
    );
    push_u32(
        &mut output,
        u32::try_from(patch.invalidated_tiles.len())
            .map_err(|_| RenderSceneError::LimitExceeded("tile memberships"))?,
    );
    for id in &patch.removed {
        push_u64(&mut output, id.get());
    }
    for command in &patch.upserted {
        encode_render_command(&mut output, command)?;
    }
    for key in &patch.invalidated_tiles {
        push_i32(&mut output, key.x);
        push_i32(&mut output, key.y);
    }
    finish_envelope(
        output,
        limits.max_encoded_patch_bytes,
        "encoded patch bytes",
    )
}

/// Decodes only the canonical retained-scene delta representation. All counts
/// are bounded before allocation and malformed commands fail closed.
pub fn decode_render_patch(
    bytes: &[u8],
    limits: RetainedRenderLimits,
) -> Result<RenderPatch, RenderSceneError> {
    let payload_end = validate_envelope(
        bytes,
        PATCH_HEADER_BYTES,
        limits.max_encoded_patch_bytes,
        "encoded patch bytes",
    )?;
    let mut reader = Reader::new(&bytes[..payload_end]);
    if reader.take(8)? != PATCH_MAGIC {
        return Err(RenderSceneError::Invalid("render patch magic"));
    }
    let version = reader.u16()?;
    if version != RENDER_PATCH_PROTOCOL_VERSION {
        return Err(RenderSceneError::UnsupportedVersion(version));
    }
    if reader.u16()? != 0 {
        return Err(RenderSceneError::NonCanonical("header flags"));
    }
    if usize::try_from(reader.u32()?).ok() != Some(bytes.len()) {
        return Err(RenderSceneError::LengthMismatch);
    }
    let base_revision = reader.u64()?;
    let revision = reader.u64()?;
    let removed_count = reader.u32()? as usize;
    let upserted_count = reader.u32()? as usize;
    let invalidated_count = reader.u32()? as usize;
    if removed_count
        .checked_add(upserted_count)
        .is_none_or(|count| count > limits.max_commands)
    {
        return Err(RenderSceneError::LimitExceeded("render commands"));
    }
    if invalidated_count > limits.max_tile_memberships {
        return Err(RenderSceneError::LimitExceeded("tile memberships"));
    }
    let minimum_remaining = removed_count
        .checked_mul(8)
        .and_then(|value| value.checked_add(invalidated_count.saturating_mul(8)))
        .ok_or(RenderSceneError::LimitExceeded("encoded patch bytes"))?;
    if reader.remaining() < minimum_remaining {
        return Err(RenderSceneError::Truncated);
    }

    let mut removed = Vec::with_capacity(removed_count);
    let mut previous_removed = None;
    for _ in 0..removed_count {
        let id = RenderCommandId::new(reader.u64()?)?;
        if previous_removed.is_some_and(|previous| previous >= id) {
            return Err(RenderSceneError::NonCanonical(
                "removed commands must be sorted and unique",
            ));
        }
        previous_removed = Some(id);
        removed.push(id);
    }
    let mut upserted = Vec::with_capacity(upserted_count);
    let mut previous_upserted = None;
    let mut glyph_count = 0usize;
    for _ in 0..upserted_count {
        let command = decode_render_command(&mut reader, &mut glyph_count, limits)?;
        if previous_upserted.is_some_and(|previous| previous >= command.id()) {
            return Err(RenderSceneError::NonCanonical(
                "upserted commands must be sorted and unique",
            ));
        }
        previous_upserted = Some(command.id());
        upserted.push(command);
    }
    let mut invalidated_tiles = Vec::with_capacity(invalidated_count);
    let mut previous_tile = None;
    for _ in 0..invalidated_count {
        let key = RenderTileKey {
            x: reader.i32()?,
            y: reader.i32()?,
        };
        if previous_tile.is_some_and(|previous| previous >= key) {
            return Err(RenderSceneError::NonCanonical(
                "invalidated tiles must be sorted and unique",
            ));
        }
        previous_tile = Some(key);
        invalidated_tiles.push(key);
    }
    if reader.remaining() != 0 {
        return Err(RenderSceneError::NonCanonical("trailing payload bytes"));
    }
    let patch = RenderPatch {
        base_revision,
        revision,
        removed,
        upserted,
        invalidated_tiles,
    };
    validate_patch(&patch, limits)?;
    if encode_render_patch(&patch, limits)? != bytes {
        return Err(RenderSceneError::NonCanonical("render patch encoding"));
    }
    Ok(patch)
}

fn encode_render_command(
    output: &mut Vec<u8>,
    command: &RenderCommand,
) -> Result<(), RenderSceneError> {
    match command {
        RenderCommand::FillRect { id, bounds, rgba } => {
            output.push(1);
            encode_command_prefix(output, *id, *bounds);
            push_u32(output, *rgba);
        }
        RenderCommand::GlyphRun {
            id,
            bounds,
            font_id,
            font_asset_hash,
            font_size,
            paint,
            direction,
            text_start,
            text_end,
            glyphs,
        } => {
            output.push(2);
            encode_command_prefix(output, *id, *bounds);
            output.extend_from_slice(font_id.as_bytes());
            output.extend_from_slice(font_asset_hash.as_bytes());
            push_i32(output, font_size.raw());
            push_u32(output, paint.rgba);
            output.push(u8::from(paint.underline) | (u8::from(paint.strike) << 1));
            output.push(match direction {
                GlyphDirection::LeftToRight => 0,
                GlyphDirection::RightToLeft => 1,
            });
            push_u16(output, 0);
            push_u64(output, *text_start);
            push_u64(output, *text_end);
            push_u32(
                output,
                u32::try_from(glyphs.len())
                    .map_err(|_| RenderSceneError::LimitExceeded("render glyphs"))?,
            );
            for glyph in glyphs {
                push_u32(output, glyph.glyph_id);
                push_u32(output, glyph.cluster);
                push_i32(output, glyph.x.raw());
                push_i32(output, glyph.y.raw());
                push_i32(output, glyph.advance.raw());
                push_i32(output, glyph.ink_bounds.x_min.raw());
                push_i32(output, glyph.ink_bounds.y_min.raw());
                push_i32(output, glyph.ink_bounds.x_max.raw());
                push_i32(output, glyph.ink_bounds.y_max.raw());
            }
        }
    }
    Ok(())
}

fn decode_render_command(
    reader: &mut Reader<'_>,
    glyph_count: &mut usize,
    limits: RetainedRenderLimits,
) -> Result<RenderCommand, RenderSceneError> {
    let tag = reader.u8()?;
    let id = RenderCommandId::new(reader.u64()?)?;
    let bounds = RenderRect::new(
        LayoutUnit::from_raw(reader.i32()?),
        LayoutUnit::from_raw(reader.i32()?),
        LayoutUnit::from_raw(reader.i32()?),
        LayoutUnit::from_raw(reader.i32()?),
    )?;
    match tag {
        1 => Ok(RenderCommand::FillRect {
            id,
            bounds,
            rgba: reader.u32()?,
        }),
        2 => {
            let mut font_id = [0u8; 16];
            font_id.copy_from_slice(reader.take(16)?);
            let mut asset_hash = [0u8; 32];
            asset_hash.copy_from_slice(reader.take(32)?);
            let font_size = LayoutUnit::from_raw(reader.i32()?);
            let rgba = reader.u32()?;
            let paint_flags = reader.u8()?;
            if paint_flags & !0b11 != 0 {
                return Err(RenderSceneError::NonCanonical("text paint flags"));
            }
            let direction = match reader.u8()? {
                0 => GlyphDirection::LeftToRight,
                1 => GlyphDirection::RightToLeft,
                _ => return Err(RenderSceneError::NonCanonical("glyph direction")),
            };
            if reader.u16()? != 0 {
                return Err(RenderSceneError::NonCanonical("glyph run reserved bits"));
            }
            let text_start = reader.u64()?;
            let text_end = reader.u64()?;
            let run_glyphs = reader.u32()? as usize;
            *glyph_count = glyph_count
                .checked_add(run_glyphs)
                .ok_or(RenderSceneError::LimitExceeded("render glyphs"))?;
            if *glyph_count > limits.max_glyphs {
                return Err(RenderSceneError::LimitExceeded("render glyphs"));
            }
            let required = run_glyphs
                .checked_mul(36)
                .ok_or(RenderSceneError::LimitExceeded("render glyphs"))?;
            if reader.remaining() < required {
                return Err(RenderSceneError::Truncated);
            }
            let mut glyphs = Vec::with_capacity(run_glyphs);
            for _ in 0..run_glyphs {
                glyphs.push(PositionedGlyph {
                    glyph_id: reader.u32()?,
                    cluster: reader.u32()?,
                    x: LayoutUnit::from_raw(reader.i32()?),
                    y: LayoutUnit::from_raw(reader.i32()?),
                    advance: LayoutUnit::from_raw(reader.i32()?),
                    ink_bounds: super::GlyphInkBounds {
                        x_min: LayoutUnit::from_raw(reader.i32()?),
                        y_min: LayoutUnit::from_raw(reader.i32()?),
                        x_max: LayoutUnit::from_raw(reader.i32()?),
                        y_max: LayoutUnit::from_raw(reader.i32()?),
                    },
                });
            }
            Ok(RenderCommand::GlyphRun {
                id,
                bounds,
                font_id: FontId::from_bytes(font_id),
                font_asset_hash: font_asset_hash_from_bytes(asset_hash),
                font_size,
                paint: TextPaint {
                    rgba,
                    underline: paint_flags & 1 != 0,
                    strike: paint_flags & 2 != 0,
                },
                direction,
                text_start,
                text_end,
                glyphs,
            })
        }
        _ => Err(RenderSceneError::NonCanonical("render command tag")),
    }
}

fn validate_patch(
    patch: &RenderPatch,
    limits: RetainedRenderLimits,
) -> Result<(), RenderSceneError> {
    if patch.revision <= patch.base_revision {
        return Err(RenderSceneError::Invalid(
            "render patch revision must advance",
        ));
    }
    if patch
        .removed
        .len()
        .checked_add(patch.upserted.len())
        .is_none_or(|count| count > limits.max_commands)
    {
        return Err(RenderSceneError::LimitExceeded("render commands"));
    }
    if patch.invalidated_tiles.len() > limits.max_tile_memberships {
        return Err(RenderSceneError::LimitExceeded("tile memberships"));
    }
    if !strictly_sorted(&patch.removed)
        || !strictly_sorted_by_key(&patch.upserted, RenderCommand::id)
        || !strictly_sorted(&patch.invalidated_tiles)
    {
        return Err(RenderSceneError::NonCanonical(
            "render patch collections must be sorted and unique",
        ));
    }
    if patch
        .upserted
        .iter()
        .any(|command| patch.removed.binary_search(&command.id()).is_ok())
    {
        return Err(RenderSceneError::Invalid(
            "render command cannot be removed and upserted",
        ));
    }
    let mut glyphs = 0usize;
    for command in &patch.upserted {
        validate_render_command(command)?;
        glyphs = glyphs
            .checked_add(command.glyph_count())
            .ok_or(RenderSceneError::LimitExceeded("render glyphs"))?;
        if glyphs > limits.max_glyphs {
            return Err(RenderSceneError::LimitExceeded("render glyphs"));
        }
    }
    let encoded = encoded_patch_size(patch)?;
    if encoded > limits.max_encoded_patch_bytes || encoded > u32::MAX as usize {
        return Err(RenderSceneError::LimitExceeded("encoded patch bytes"));
    }
    Ok(())
}

fn strictly_sorted<T: Ord>(values: &[T]) -> bool {
    values.windows(2).all(|pair| pair[0] < pair[1])
}

fn strictly_sorted_by_key<T, K: Ord + Copy>(values: &[T], key: impl Fn(&T) -> K) -> bool {
    values.windows(2).all(|pair| key(&pair[0]) < key(&pair[1]))
}

fn validate_tile(tile: &RenderTile, limits: RetainedRenderLimits) -> Result<(), RenderSceneError> {
    if tile.tile_edge.raw() <= 0 {
        return Err(RenderSceneError::Invalid("tile edge must be positive"));
    }
    if tile.commands.len() > limits.max_commands_per_tile {
        return Err(RenderSceneError::LimitExceeded("commands per tile"));
    }
    let tile_x = tile
        .key
        .x
        .checked_mul(tile.tile_edge.raw())
        .ok_or(RenderSceneError::CoordinateOverflow)?;
    let tile_y = tile
        .key
        .y
        .checked_mul(tile.tile_edge.raw())
        .ok_or(RenderSceneError::CoordinateOverflow)?;
    let tile_bounds = RenderRect::new(
        LayoutUnit::from_raw(tile_x),
        LayoutUnit::from_raw(tile_y),
        tile.tile_edge,
        tile.tile_edge,
    )?;
    let mut previous = None;
    let mut glyph_count = 0usize;
    for command in &tile.commands {
        if previous.is_some_and(|id| id >= command.id()) {
            return Err(RenderSceneError::NonCanonical(
                "commands must be sorted by unique id",
            ));
        }
        previous = Some(command.id());
        validate_render_command(command)?;
        if !command.bounds().intersects(tile_bounds)? {
            return Err(RenderSceneError::NonCanonical(
                "command does not intersect its tile",
            ));
        }
        glyph_count = glyph_count
            .checked_add(command.glyph_count())
            .ok_or(RenderSceneError::LimitExceeded("render glyphs"))?;
        if glyph_count > limits.max_glyphs {
            return Err(RenderSceneError::LimitExceeded("render glyphs"));
        }
    }
    let encoded = encoded_tile_size(tile)?;
    if encoded > limits.max_encoded_tile_bytes || encoded > u32::MAX as usize {
        return Err(RenderSceneError::LimitExceeded("encoded tile bytes"));
    }
    Ok(())
}

fn encoded_tile_size(tile: &RenderTile) -> Result<usize, RenderSceneError> {
    tile.commands
        .iter()
        .try_fold(TILE_HEADER_BYTES + TILE_CHECKSUM_BYTES, |total, command| {
            total
                .checked_add(encoded_command_size(command)?)
                .ok_or(RenderSceneError::LimitExceeded("encoded tile bytes"))
        })
}

fn encoded_patch_size(patch: &RenderPatch) -> Result<usize, RenderSceneError> {
    let fixed = PATCH_HEADER_BYTES
        .checked_add(TILE_CHECKSUM_BYTES)
        .and_then(|value| value.checked_add(patch.removed.len().checked_mul(8)?))
        .and_then(|value| value.checked_add(patch.invalidated_tiles.len().checked_mul(8)?))
        .ok_or(RenderSceneError::LimitExceeded("encoded patch bytes"))?;
    patch.upserted.iter().try_fold(fixed, |total, command| {
        total
            .checked_add(encoded_command_size(command)?)
            .ok_or(RenderSceneError::LimitExceeded("encoded patch bytes"))
    })
}

fn encoded_command_size(command: &RenderCommand) -> Result<usize, RenderSceneError> {
    match command {
        RenderCommand::FillRect { .. } => Ok(29),
        RenderCommand::GlyphRun { glyphs, .. } => glyphs
            .len()
            .checked_mul(36)
            .and_then(|bytes| bytes.checked_add(105))
            .ok_or(RenderSceneError::LimitExceeded("render glyphs")),
    }
}

fn validate_render_command(command: &RenderCommand) -> Result<(), RenderSceneError> {
    let bounds = RenderRect::new(
        command.bounds().x,
        command.bounds().y,
        command.bounds().width,
        command.bounds().height,
    )?;
    if let RenderCommand::GlyphRun {
        font_id,
        font_size,
        text_start,
        text_end,
        glyphs,
        ..
    } = command
    {
        if font_id.is_zero() {
            return Err(RenderSceneError::Invalid("font id must be non-zero"));
        }
        if font_size.raw() <= 0 {
            return Err(RenderSceneError::Invalid("font size must be positive"));
        }
        if text_start > text_end || glyphs.is_empty() {
            return Err(RenderSceneError::Invalid("glyph run range or glyphs"));
        }
        let bounds_right = bounds
            .x
            .raw()
            .checked_add(bounds.width.raw())
            .ok_or(RenderSceneError::CoordinateOverflow)?;
        let bounds_bottom = bounds
            .y
            .raw()
            .checked_add(bounds.height.raw())
            .ok_or(RenderSceneError::CoordinateOverflow)?;
        for glyph in glyphs {
            if u16::try_from(glyph.glyph_id).is_err()
                || glyph.advance.raw() < 0
                || glyph.ink_bounds.x_min.raw() > glyph.ink_bounds.x_max.raw()
                || glyph.ink_bounds.y_min.raw() > glyph.ink_bounds.y_max.raw()
                || u64::from(glyph.cluster) < *text_start
                || u64::from(glyph.cluster) >= *text_end
            {
                return Err(RenderSceneError::Invalid("glyph metrics or cluster range"));
            }
            let ink_left = glyph
                .x
                .raw()
                .checked_add(glyph.ink_bounds.x_min.raw())
                .ok_or(RenderSceneError::CoordinateOverflow)?;
            let ink_right = glyph
                .x
                .raw()
                .checked_add(glyph.ink_bounds.x_max.raw())
                .ok_or(RenderSceneError::CoordinateOverflow)?;
            let ink_top = glyph
                .y
                .raw()
                .checked_add(glyph.ink_bounds.y_min.raw())
                .ok_or(RenderSceneError::CoordinateOverflow)?;
            let ink_bottom = glyph
                .y
                .raw()
                .checked_add(glyph.ink_bounds.y_max.raw())
                .ok_or(RenderSceneError::CoordinateOverflow)?;
            if ink_left < bounds.x.raw()
                || ink_right > bounds_right
                || ink_top < bounds.y.raw()
                || ink_bottom > bounds_bottom
            {
                return Err(RenderSceneError::Invalid(
                    "glyph ink escapes command bounds",
                ));
            }
        }
    }
    Ok(())
}

fn glyph_run_ink_bounds(
    glyphs: &[PositionedGlyph],
) -> Result<(i32, i32, i32, i32), RenderSceneError> {
    let mut bounds: Option<(i32, i32, i32, i32)> = None;
    for glyph in glyphs {
        if glyph.ink_bounds.x_min.raw() > glyph.ink_bounds.x_max.raw()
            || glyph.ink_bounds.y_min.raw() > glyph.ink_bounds.y_max.raw()
        {
            return Err(RenderSceneError::Invalid("glyph ink bounds"));
        }
        let left = glyph
            .x
            .raw()
            .checked_add(glyph.ink_bounds.x_min.raw())
            .ok_or(RenderSceneError::CoordinateOverflow)?;
        let right = glyph
            .x
            .raw()
            .checked_add(glyph.ink_bounds.x_max.raw())
            .ok_or(RenderSceneError::CoordinateOverflow)?;
        let top = glyph
            .y
            .raw()
            .checked_add(glyph.ink_bounds.y_min.raw())
            .ok_or(RenderSceneError::CoordinateOverflow)?;
        let bottom = glyph
            .y
            .raw()
            .checked_add(glyph.ink_bounds.y_max.raw())
            .ok_or(RenderSceneError::CoordinateOverflow)?;
        bounds = Some(match bounds {
            Some((min_x, min_y, max_x, max_y)) => (
                min_x.min(left),
                min_y.min(top),
                max_x.max(right),
                max_y.max(bottom),
            ),
            None => (left, top, right, bottom),
        });
    }
    bounds.ok_or(RenderSceneError::Invalid("empty glyph run"))
}

fn derive_command_id(scene_id: RenderSceneId, run: &super::GlyphRun) -> RenderCommandId {
    let mut hash = Sha256::new();
    hash.update(COMMAND_ID_DOMAIN);
    hash.update(scene_id.as_bytes());
    hash.update(
        u64::try_from(run.text_range.start)
            .unwrap_or(u64::MAX)
            .to_le_bytes(),
    );
    hash.update(
        u64::try_from(run.text_range.end)
            .unwrap_or(u64::MAX)
            .to_le_bytes(),
    );
    hash.update(run.font_id.as_bytes());
    hash.update(run.font_size.raw().to_le_bytes());
    hash.update(run.paint.rgba.to_le_bytes());
    hash.update([run.direction as u8]);
    let digest = hash.finalize();
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&digest[..8]);
    RenderCommandId(u64::from_le_bytes(bytes).max(1))
}

fn encode_command_prefix(output: &mut Vec<u8>, id: RenderCommandId, bounds: RenderRect) {
    push_u64(output, id.get());
    push_i32(output, bounds.x.raw());
    push_i32(output, bounds.y.raw());
    push_i32(output, bounds.width.raw());
    push_i32(output, bounds.height.raw());
}

fn finish_envelope(
    mut output: Vec<u8>,
    maximum: usize,
    limit_name: &'static str,
) -> Result<Vec<u8>, RenderSceneError> {
    let total = output
        .len()
        .checked_add(TILE_CHECKSUM_BYTES)
        .ok_or(RenderSceneError::LimitExceeded(limit_name))?;
    if total > maximum || total > u32::MAX as usize {
        return Err(RenderSceneError::LimitExceeded(limit_name));
    }
    output[12..16].copy_from_slice(&(total as u32).to_le_bytes());
    let checksum = Sha256::digest(&output);
    output.extend_from_slice(&checksum[..TILE_CHECKSUM_BYTES]);
    Ok(output)
}

fn validate_envelope(
    bytes: &[u8],
    header_bytes: usize,
    maximum: usize,
    limit_name: &'static str,
) -> Result<usize, RenderSceneError> {
    if bytes.len() < header_bytes + TILE_CHECKSUM_BYTES {
        return Err(RenderSceneError::Truncated);
    }
    if bytes.len() > maximum {
        return Err(RenderSceneError::LimitExceeded(limit_name));
    }
    let payload_end = bytes.len() - TILE_CHECKSUM_BYTES;
    let expected = Sha256::digest(&bytes[..payload_end]);
    if expected[..TILE_CHECKSUM_BYTES] != bytes[payload_end..] {
        return Err(RenderSceneError::ChecksumMismatch);
    }
    Ok(payload_end)
}

fn font_asset_hash_from_bytes(bytes: [u8; 32]) -> FontAssetHash {
    // Construction remains centralized here because the protocol has already
    // authenticated the exact digest bytes; it does not claim they hash a
    // locally registered asset until the renderer resolves the FontId.
    super::font::font_asset_hash_from_protocol(bytes)
}

fn push_u16(output: &mut Vec<u8>, value: u16) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn push_i32(output: &mut Vec<u8>, value: i32) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn push_u64(output: &mut Vec<u8>, value: u64) {
    output.extend_from_slice(&value.to_le_bytes());
}

struct Reader<'a> {
    bytes: &'a [u8],
    cursor: usize,
}

impl<'a> Reader<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, cursor: 0 }
    }

    fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.cursor)
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], RenderSceneError> {
        let end = self
            .cursor
            .checked_add(length)
            .ok_or(RenderSceneError::Truncated)?;
        let value = self
            .bytes
            .get(self.cursor..end)
            .ok_or(RenderSceneError::Truncated)?;
        self.cursor = end;
        Ok(value)
    }

    fn u8(&mut self) -> Result<u8, RenderSceneError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, RenderSceneError> {
        let mut bytes = [0u8; 2];
        bytes.copy_from_slice(self.take(2)?);
        Ok(u16::from_le_bytes(bytes))
    }

    fn u32(&mut self) -> Result<u32, RenderSceneError> {
        let mut bytes = [0u8; 4];
        bytes.copy_from_slice(self.take(4)?);
        Ok(u32::from_le_bytes(bytes))
    }

    fn i32(&mut self) -> Result<i32, RenderSceneError> {
        let mut bytes = [0u8; 4];
        bytes.copy_from_slice(self.take(4)?);
        Ok(i32::from_le_bytes(bytes))
    }

    fn u64(&mut self) -> Result<u64, RenderSceneError> {
        let mut bytes = [0u8; 8];
        bytes.copy_from_slice(self.take(8)?);
        Ok(u64::from_le_bytes(bytes))
    }
}
