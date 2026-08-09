//! Deterministic document/presentation text layout shared by native and Wasm.
//!
//! Fonts are explicit content-addressed assets. Unicode bidi resolution,
//! line-breaking and OpenType shaping run in safe Rust with fixed-point output;
//! the module never discovers platform fonts or performs network I/O.

mod cache;
mod font;
mod paragraph;
mod render;

#[cfg(test)]
pub(crate) mod tests;

use core::fmt;
use std::ops::Range;
use std::sync::Arc;

pub use cache::LayoutCacheStats;
pub use font::{FontAssetHash, FontDescriptor, FontId, FontRegistry, RegisteredFont};
pub use render::{
    decode_render_patch, decode_render_tile, encode_render_patch, encode_render_tile,
    RenderCommand, RenderCommandId, RenderPatch, RenderRect, RenderSceneError, RenderSceneId,
    RenderTile, RenderTileKey, RetainedRenderLimits, RetainedRenderScene,
    RENDER_PATCH_PROTOCOL_VERSION, RENDER_TILE_PROTOCOL_VERSION,
};

/// Number of fixed-point layout units in one CSS pixel.
pub const LAYOUT_UNITS_PER_CSS_PIXEL: i32 = 64;
pub const TEXT_LAYOUT_ENGINE_VERSION: u16 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TextLayoutCapabilities {
    pub engine_version: u16,
    pub bidi_unicode_version: (u64, u64, u64),
    pub line_break_unicode_version: (u8, u8, u8),
    pub fixed_point_units_per_css_pixel: i32,
    pub implicit_platform_fonts: bool,
    pub network_font_loading: bool,
    pub retained_tile_protocol_version: u16,
    pub retained_patch_protocol_version: u16,
}

pub const TEXT_LAYOUT_CAPABILITIES: TextLayoutCapabilities = TextLayoutCapabilities {
    engine_version: TEXT_LAYOUT_ENGINE_VERSION,
    bidi_unicode_version: unicode_bidi::UNICODE_VERSION,
    line_break_unicode_version: unicode_linebreak::UNICODE_VERSION,
    fixed_point_units_per_css_pixel: LAYOUT_UNITS_PER_CSS_PIXEL,
    implicit_platform_fonts: false,
    network_font_loading: false,
    retained_tile_protocol_version: RENDER_TILE_PROTOCOL_VERSION,
    retained_patch_protocol_version: RENDER_PATCH_PROTOCOL_VERSION,
};

#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct LayoutUnit(i32);

impl LayoutUnit {
    pub const ZERO: Self = Self(0);

    #[must_use]
    pub const fn from_raw(raw: i32) -> Self {
        Self(raw)
    }

    pub fn from_css_pixels(pixels: i32) -> Result<Self, LayoutError> {
        pixels
            .checked_mul(LAYOUT_UNITS_PER_CSS_PIXEL)
            .map(Self)
            .ok_or(LayoutError::CoordinateOverflow)
    }

    #[must_use]
    pub const fn raw(self) -> i32 {
        self.0
    }

    pub fn checked_add(self, other: Self) -> Result<Self, LayoutError> {
        self.0
            .checked_add(other.0)
            .map(Self)
            .ok_or(LayoutError::CoordinateOverflow)
    }

    pub fn checked_sub(self, other: Self) -> Result<Self, LayoutError> {
        self.0
            .checked_sub(other.0)
            .map(Self)
            .ok_or(LayoutError::CoordinateOverflow)
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum FontStyle {
    Normal,
    Italic,
    Oblique,
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct FontFeature {
    pub tag: [u8; 4],
    pub value: u32,
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct TextPaint {
    /// Unpremultiplied RGBA in network display order (`0xRRGGBBAA`).
    pub rgba: u32,
    pub underline: bool,
    pub strike: bool,
}

impl Default for TextPaint {
    fn default() -> Self {
        Self {
            rgba: 0x0000_00ff,
            underline: false,
            strike: false,
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct TextStyle {
    /// Ordered explicit family requests. No CSS generic or OS lookup occurs.
    pub font_families: Vec<String>,
    /// Ordered explicit content-addressed fallback faces.
    pub fallback_fonts: Vec<FontId>,
    pub weight: u16,
    pub font_style: FontStyle,
    pub font_size: LayoutUnit,
    pub letter_spacing: LayoutUnit,
    pub features: Vec<FontFeature>,
    /// Optional BCP-47/OpenType language tag. Script is otherwise guessed from
    /// the Unicode text deterministically by the shared shaper.
    pub language: Option<String>,
    /// Optional ISO-15924 script tag such as `Arab` or `Hani`.
    pub script: Option<[u8; 4]>,
    pub paint: TextPaint,
}

impl TextStyle {
    #[must_use]
    pub fn new(font_family: impl Into<String>, font_size: LayoutUnit) -> Self {
        Self {
            font_families: vec![font_family.into()],
            fallback_fonts: Vec::new(),
            weight: 400,
            font_style: FontStyle::Normal,
            font_size,
            letter_spacing: LayoutUnit::ZERO,
            features: Vec::new(),
            language: None,
            script: None,
            paint: TextPaint::default(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TextSpan {
    pub range: Range<usize>,
    pub style: TextStyle,
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum BaseDirection {
    Auto,
    LeftToRight,
    RightToLeft,
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum TextAlignment {
    Start,
    Center,
    End,
    Left,
    Right,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParagraphStyle {
    pub direction: BaseDirection,
    pub alignment: TextAlignment,
    /// Exact line box height. `None` uses the maximum shaped face metrics.
    pub line_height: Option<LayoutUnit>,
    /// A tab is shaped as this many ordinary space characters using the
    /// surrounding style. This is deliberately explicit and platform-neutral;
    /// no browser or OS tab-stop defaults participate in layout.
    pub tab_width_spaces: u8,
}

impl Default for ParagraphStyle {
    fn default() -> Self {
        Self {
            direction: BaseDirection::Auto,
            alignment: TextAlignment::Start,
            line_height: None,
            tab_width_spaces: 4,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RichTextParagraph {
    pub text: String,
    pub default_style: TextStyle,
    /// Ordered, non-overlapping overrides. Gaps use `default_style`.
    pub spans: Vec<TextSpan>,
    pub paragraph_style: ParagraphStyle,
}

impl RichTextParagraph {
    #[must_use]
    pub fn plain(text: impl Into<String>, style: TextStyle) -> Self {
        Self {
            text: text.into(),
            default_style: style,
            spans: Vec::new(),
            paragraph_style: ParagraphStyle::default(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LayoutConstraints {
    pub max_width: Option<LayoutUnit>,
}

impl LayoutConstraints {
    pub const UNBOUNDED: Self = Self { max_width: None };
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum GlyphDirection {
    LeftToRight,
    RightToLeft,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PositionedGlyph {
    pub glyph_id: u32,
    pub cluster: u32,
    pub x: LayoutUnit,
    pub y: LayoutUnit,
    pub advance: LayoutUnit,
    /// Ink bounds relative to `(x, y)` in screen coordinates (positive Y down).
    pub ink_bounds: GlyphInkBounds,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GlyphInkBounds {
    pub x_min: LayoutUnit,
    pub y_min: LayoutUnit,
    pub x_max: LayoutUnit,
    pub y_max: LayoutUnit,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GlyphRun {
    pub font_id: FontId,
    pub font_asset_hash: FontAssetHash,
    pub text_range: Range<usize>,
    pub direction: GlyphDirection,
    pub font_size: LayoutUnit,
    pub paint: TextPaint,
    pub glyphs: Vec<PositionedGlyph>,
    pub advance: LayoutUnit,
    pub ascent: LayoutUnit,
    pub descent: LayoutUnit,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LayoutLine {
    pub text_range: Range<usize>,
    pub top: LayoutUnit,
    pub baseline: LayoutUnit,
    pub ascent: LayoutUnit,
    pub descent: LayoutUnit,
    pub height: LayoutUnit,
    pub advance: LayoutUnit,
    pub glyph_runs: Range<usize>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum FontSubstitutionReason {
    RequestedFamilyUnavailable,
    RequestedStyleUnavailable,
    GlyphCoverageFallback,
    MissingGlyph,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct FontSubstitutionDiagnostic {
    pub text_range: Range<usize>,
    pub requested_families: Vec<String>,
    pub resolved_font: FontId,
    pub reason: FontSubstitutionReason,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParagraphLayout {
    pub fingerprint: [u8; 32],
    pub width: LayoutUnit,
    pub height: LayoutUnit,
    pub lines: Vec<LayoutLine>,
    pub glyph_runs: Vec<GlyphRun>,
    pub diagnostics: Vec<FontSubstitutionDiagnostic>,
    pub work: LayoutWork,
}

/// Deterministic work accounting for one uncached layout. This is input/work
/// based rather than wall-clock based, so native and Wasm reject at the same
/// boundary regardless of machine speed.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct LayoutWork {
    pub units: usize,
    pub shape_calls: usize,
    pub graphemes: usize,
}

impl ParagraphLayout {
    #[must_use]
    pub fn estimated_bytes(&self) -> usize {
        core::mem::size_of::<Self>()
            .saturating_add(self.lines.capacity() * core::mem::size_of::<LayoutLine>())
            .saturating_add(self.glyph_runs.capacity() * core::mem::size_of::<GlyphRun>())
            .saturating_add(
                self.glyph_runs
                    .iter()
                    .map(|run| run.glyphs.capacity() * core::mem::size_of::<PositionedGlyph>())
                    .sum::<usize>(),
            )
            .saturating_add(
                self.diagnostics.capacity() * core::mem::size_of::<FontSubstitutionDiagnostic>(),
            )
            .saturating_add(
                self.diagnostics
                    .iter()
                    .map(|diagnostic| {
                        diagnostic.requested_families.capacity() * core::mem::size_of::<String>()
                            + diagnostic
                                .requested_families
                                .iter()
                                .map(String::capacity)
                                .sum::<usize>()
                    })
                    .sum::<usize>(),
            )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LayoutLimits {
    pub max_text_bytes: usize,
    pub max_graphemes: usize,
    pub max_spans: usize,
    pub max_glyphs: usize,
    pub max_lines: usize,
    pub max_shape_calls: usize,
    pub max_work_units: usize,
    pub max_font_families_per_style: usize,
    pub max_fallback_fonts_per_style: usize,
    pub max_features_per_style: usize,
    pub max_registered_fonts: usize,
    pub max_font_asset_bytes: usize,
    pub max_font_registry_bytes: usize,
    pub max_font_coverage_cache_entries_per_face: usize,
    pub max_layout_cache_entries: usize,
    pub max_layout_cache_bytes: usize,
}

impl Default for LayoutLimits {
    fn default() -> Self {
        Self {
            max_text_bytes: 4 * 1024 * 1024,
            max_graphemes: 2_000_000,
            max_spans: 16_384,
            max_glyphs: 4_000_000,
            max_lines: 100_000,
            max_shape_calls: 1_000_000,
            max_work_units: 128 * 1024 * 1024,
            max_font_families_per_style: 16,
            max_fallback_fonts_per_style: 32,
            max_features_per_style: 64,
            max_registered_fonts: 4_096,
            max_font_asset_bytes: 64 * 1024 * 1024,
            max_font_registry_bytes: 512 * 1024 * 1024,
            max_font_coverage_cache_entries_per_face: 65_536,
            max_layout_cache_entries: 1_024,
            max_layout_cache_bytes: 128 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LayoutError {
    LimitExceeded(&'static str),
    InvalidFont(&'static str),
    InvalidFontDescriptor(&'static str),
    FontIdentityConflict(FontId),
    FontAssetMismatch(FontId),
    UnknownFont(FontId),
    NoFontAvailable { requested_families: Vec<String> },
    InvalidTextStyle(&'static str),
    InvalidSpan(&'static str),
    InvalidConstraint(&'static str),
    CoordinateOverflow,
    GlyphClusterOverflow,
}

impl fmt::Display for LayoutError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LimitExceeded(limit) => write!(formatter, "layout limit exceeded: {limit}"),
            Self::InvalidFont(reason) => write!(formatter, "invalid font: {reason}"),
            Self::InvalidFontDescriptor(reason) => {
                write!(formatter, "invalid font descriptor: {reason}")
            }
            Self::FontIdentityConflict(id) => {
                write!(
                    formatter,
                    "font {id:?} was registered with conflicting metadata"
                )
            }
            Self::FontAssetMismatch(id) => {
                write!(
                    formatter,
                    "font {id:?} does not match the retained asset hash"
                )
            }
            Self::UnknownFont(id) => write!(formatter, "font {id:?} is not registered"),
            Self::NoFontAvailable { requested_families } => write!(
                formatter,
                "no explicit font is available for {}",
                requested_families.join(", ")
            ),
            Self::InvalidTextStyle(reason) => write!(formatter, "invalid text style: {reason}"),
            Self::InvalidSpan(reason) => write!(formatter, "invalid rich-text span: {reason}"),
            Self::InvalidConstraint(reason) => write!(formatter, "invalid constraint: {reason}"),
            Self::CoordinateOverflow => formatter.write_str("fixed-point coordinate overflow"),
            Self::GlyphClusterOverflow => formatter.write_str("glyph cluster exceeds u32"),
        }
    }
}

impl std::error::Error for LayoutError {}

#[derive(Debug)]
pub struct TextLayoutEngine {
    fonts: FontRegistry,
    cache: cache::LayoutCache,
    limits: LayoutLimits,
}

impl TextLayoutEngine {
    #[must_use]
    pub fn new(fonts: FontRegistry, limits: LayoutLimits) -> Self {
        Self {
            fonts,
            cache: cache::LayoutCache::new(
                limits.max_layout_cache_entries,
                limits.max_layout_cache_bytes,
            ),
            limits,
        }
    }

    #[must_use]
    pub const fn fonts(&self) -> &FontRegistry {
        &self.fonts
    }

    /// Font mutations advance the registry generation, which is part of every
    /// layout key. Old cache entries become unreachable and remain bounded by
    /// the ordinary LRU budget.
    pub fn fonts_mut(&mut self) -> &mut FontRegistry {
        &mut self.fonts
    }

    pub fn layout(
        &mut self,
        paragraph: &RichTextParagraph,
        constraints: LayoutConstraints,
    ) -> Result<Arc<ParagraphLayout>, LayoutError> {
        paragraph::layout(self, paragraph, constraints)
    }

    #[must_use]
    pub fn cache_stats(&self) -> LayoutCacheStats {
        self.cache.stats()
    }

    pub fn clear_cache(&mut self) {
        self.cache.clear();
    }
}
