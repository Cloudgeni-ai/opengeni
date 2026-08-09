use std::sync::Arc;

use opengeni_artifact_kernel::text_layout::{
    decode_render_patch, decode_render_tile, encode_render_patch, encode_render_tile,
    BaseDirection, FontDescriptor, FontFeature, FontId, FontRegistry, FontStyle, GlyphDirection,
    LayoutConstraints, LayoutLimits, ParagraphLayout, ParagraphStyle, RetainedRenderLimits,
    RichTextParagraph, TextAlignment, TextLayoutEngine, TextPaint, TextSpan, TextStyle,
};
use sha2::{Digest, Sha256};

use crate::BindingError;

const FONT_MAGIC: [u8; 8] = *b"OGFNT001";
const REQUEST_MAGIC: [u8; 8] = *b"OGTLQ001";
const RESPONSE_MAGIC: [u8; 8] = *b"OGTLO001";
const HEADER_BYTES: usize = 16;
const CHECKSUM_BYTES: usize = 16;

pub const TEXT_LAYOUT_FONT_BUNDLE_VERSION: u16 = 1;
pub const TEXT_LAYOUT_REQUEST_VERSION: u16 = 1;
pub const TEXT_LAYOUT_RESPONSE_VERSION: u16 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TextLayoutProtocolLimits {
    pub layout: LayoutLimits,
    pub max_font_bundle_bytes: usize,
    pub max_request_bytes: usize,
    pub max_response_bytes: usize,
}

pub const NATIVE_TEXT_LAYOUT_LIMITS: TextLayoutProtocolLimits = TextLayoutProtocolLimits {
    layout: LayoutLimits {
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
    },
    max_font_bundle_bytes: 512 * 1024 * 1024,
    max_request_bytes: 8 * 1024 * 1024,
    max_response_bytes: 64 * 1024 * 1024,
};

pub const WASM_TEXT_LAYOUT_LIMITS: TextLayoutProtocolLimits = TextLayoutProtocolLimits {
    layout: LayoutLimits {
        max_text_bytes: 2 * 1024 * 1024,
        max_graphemes: 1_000_000,
        max_spans: 8_192,
        max_glyphs: 1_000_000,
        max_lines: 50_000,
        max_shape_calls: 500_000,
        max_work_units: 64 * 1024 * 1024,
        max_font_families_per_style: 16,
        max_fallback_fonts_per_style: 32,
        max_features_per_style: 64,
        max_registered_fonts: 512,
        max_font_asset_bytes: 16 * 1024 * 1024,
        max_font_registry_bytes: 48 * 1024 * 1024,
        max_font_coverage_cache_entries_per_face: 32_768,
        max_layout_cache_entries: 256,
        max_layout_cache_bytes: 32 * 1024 * 1024,
    },
    max_font_bundle_bytes: 48 * 1024 * 1024,
    max_request_bytes: 4 * 1024 * 1024,
    max_response_bytes: 32 * 1024 * 1024,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TextLayoutFontAsset {
    pub bytes: Arc<[u8]>,
    pub face_index: u32,
    pub descriptor: FontDescriptor,
}

pub fn encode_text_layout_font_bundle(
    assets: &[TextLayoutFontAsset],
) -> Result<Vec<u8>, BindingError> {
    encode_text_layout_font_bundle_with_limits(assets, NATIVE_TEXT_LAYOUT_LIMITS)
}

fn encode_text_layout_font_bundle_with_limits(
    assets: &[TextLayoutFontAsset],
    limits: TextLayoutProtocolLimits,
) -> Result<Vec<u8>, BindingError> {
    if assets.len() > limits.layout.max_registered_fonts {
        return Err(BindingError::Limit("text layout fonts"));
    }
    let mut registry = FontRegistry::new(limits.layout);
    let mut registered = Vec::with_capacity(assets.len());
    for asset in assets {
        require_sorted_unique(&asset.descriptor.aliases, "font aliases")?;
        let metadata = registry
            .register(
                Arc::clone(&asset.bytes),
                asset.face_index,
                asset.descriptor.clone(),
            )
            .map_err(BindingError::TextLayout)?;
        registered.push((metadata, asset));
    }
    registered.sort_by_key(|(metadata, _)| metadata.id);
    if registered
        .windows(2)
        .any(|pair| pair[0].0.id >= pair[1].0.id)
    {
        return Err(BindingError::NonCanonical("duplicate font face"));
    }
    let mut payload = Writer::new(
        limits
            .max_font_bundle_bytes
            .saturating_sub(HEADER_BYTES + CHECKSUM_BYTES),
        "font bundle",
    );
    payload.u32(as_u32(registered.len(), "text layout fonts")?)?;
    for (metadata, asset) in registered {
        payload.bytes(metadata.id.as_bytes())?;
        payload.bytes(metadata.asset_hash.as_bytes())?;
        payload.u32(asset.face_index)?;
        payload.u16(asset.descriptor.weight)?;
        payload.u8(font_style_tag(asset.descriptor.style))?;
        payload.u8(0)?;
        payload.string_u16(&asset.descriptor.family, 256)?;
        payload.u16(as_u16(asset.descriptor.aliases.len(), "font aliases")?)?;
        payload.u32(as_u32(asset.bytes.len(), "font asset bytes")?)?;
        for alias in &asset.descriptor.aliases {
            payload.string_u16(alias, 256)?;
        }
        payload.bytes(&asset.bytes)?;
    }
    finish_envelope(
        FONT_MAGIC,
        TEXT_LAYOUT_FONT_BUNDLE_VERSION,
        payload.finish(),
        limits.max_font_bundle_bytes,
        "font bundle",
    )
}

pub fn encode_text_layout_request(
    paragraph: &RichTextParagraph,
    constraints: LayoutConstraints,
) -> Result<Vec<u8>, BindingError> {
    encode_text_layout_request_with_limits(paragraph, constraints, NATIVE_TEXT_LAYOUT_LIMITS)
}

fn encode_text_layout_request_with_limits(
    paragraph: &RichTextParagraph,
    constraints: LayoutConstraints,
    limits: TextLayoutProtocolLimits,
) -> Result<Vec<u8>, BindingError> {
    if paragraph.text.len() > limits.layout.max_text_bytes
        || paragraph.spans.len() > limits.layout.max_spans
    {
        return Err(BindingError::Limit("text layout request"));
    }
    if constraints.max_width.is_some_and(|value| value.raw() == 0) {
        return Err(BindingError::NonCanonical("zero maximum width"));
    }
    if paragraph
        .paragraph_style
        .line_height
        .is_some_and(|value| value.raw() == 0)
    {
        return Err(BindingError::NonCanonical("zero line height"));
    }
    let mut payload = Writer::new(
        limits
            .max_request_bytes
            .saturating_sub(HEADER_BYTES + CHECKSUM_BYTES),
        "text layout request",
    );
    payload.u32(as_u32(paragraph.text.len(), "paragraph text")?)?;
    payload.u32(as_u32(paragraph.spans.len(), "rich-text spans")?)?;
    payload.i32(constraints.max_width.map_or(0, |value| value.raw()))?;
    payload.u8(direction_tag(paragraph.paragraph_style.direction))?;
    payload.u8(alignment_tag(paragraph.paragraph_style.alignment))?;
    payload.u8(paragraph.paragraph_style.tab_width_spaces)?;
    payload.u8(0)?;
    payload.i32(
        paragraph
            .paragraph_style
            .line_height
            .map_or(0, |value| value.raw()),
    )?;
    encode_style(&mut payload, &paragraph.default_style, limits.layout)?;
    for span in &paragraph.spans {
        payload.u32(as_u32(span.range.start, "span offset")?)?;
        payload.u32(as_u32(span.range.end, "span offset")?)?;
        encode_style(&mut payload, &span.style, limits.layout)?;
    }
    payload.bytes(paragraph.text.as_bytes())?;
    finish_envelope(
        REQUEST_MAGIC,
        TEXT_LAYOUT_REQUEST_VERSION,
        payload.finish(),
        limits.max_request_bytes,
        "text layout request",
    )
}

pub fn decode_text_layout_request(
    bytes: &[u8],
) -> Result<(RichTextParagraph, LayoutConstraints), BindingError> {
    decode_text_layout_request_with_limits(bytes, NATIVE_TEXT_LAYOUT_LIMITS)
}

fn decode_text_layout_request_with_limits(
    bytes: &[u8],
    limits: TextLayoutProtocolLimits,
) -> Result<(RichTextParagraph, LayoutConstraints), BindingError> {
    let payload = decode_envelope(
        bytes,
        REQUEST_MAGIC,
        TEXT_LAYOUT_REQUEST_VERSION,
        limits.max_request_bytes,
        "text layout request",
    )?;
    let mut reader = Reader::new(payload, "text layout request");
    let text_len = as_usize(reader.u32()?, "paragraph text")?;
    let span_count = as_usize(reader.u32()?, "rich-text spans")?;
    if text_len > limits.layout.max_text_bytes || span_count > limits.layout.max_spans {
        return Err(BindingError::Limit("text layout request"));
    }
    let max_width = match reader.i32()? {
        0 => None,
        value => Some(opengeni_artifact_kernel::text_layout::LayoutUnit::from_raw(
            value,
        )),
    };
    let direction = decode_direction(reader.u8()?)?;
    let alignment = decode_alignment(reader.u8()?)?;
    let tab_width_spaces = reader.u8()?;
    if reader.u8()? != 0 {
        return Err(BindingError::NonCanonical("text layout request flags"));
    }
    let line_height = match reader.i32()? {
        0 => None,
        value => Some(opengeni_artifact_kernel::text_layout::LayoutUnit::from_raw(
            value,
        )),
    };
    let default_style = decode_style(&mut reader, limits.layout)?;
    let mut spans = Vec::new();
    spans
        .try_reserve_exact(span_count)
        .map_err(|_| BindingError::Limit("rich-text spans"))?;
    for _ in 0..span_count {
        let start = as_usize(reader.u32()?, "span offset")?;
        let end = as_usize(reader.u32()?, "span offset")?;
        spans.push(TextSpan {
            range: start..end,
            style: decode_style(&mut reader, limits.layout)?,
        });
    }
    let text = core::str::from_utf8(reader.take(text_len)?)
        .map_err(|_| BindingError::InvalidUtf8)?
        .to_owned();
    if !reader.is_empty() {
        return Err(BindingError::TrailingBytes);
    }
    let paragraph = RichTextParagraph {
        text,
        default_style,
        spans,
        paragraph_style: ParagraphStyle {
            direction,
            alignment,
            line_height,
            tab_width_spaces,
        },
    };
    let constraints = LayoutConstraints { max_width };
    if encode_text_layout_request_with_limits(&paragraph, constraints, limits)? != bytes {
        return Err(BindingError::NonCanonical("text layout request encoding"));
    }
    Ok((paragraph, constraints))
}

pub fn layout_text(font_bundle: &[u8], request: &[u8]) -> Result<Vec<u8>, BindingError> {
    let mut session = TextLayoutBindingSession::open(font_bundle)?;
    session.layout(request)
}

#[derive(Debug)]
pub struct TextLayoutBindingSession {
    engine: Option<TextLayoutEngine>,
    limits: TextLayoutProtocolLimits,
}

impl TextLayoutBindingSession {
    pub fn open(font_bundle: &[u8]) -> Result<Self, BindingError> {
        Self::open_with_limits(font_bundle, NATIVE_TEXT_LAYOUT_LIMITS)
    }

    pub fn open_with_limits(
        font_bundle: &[u8],
        limits: TextLayoutProtocolLimits,
    ) -> Result<Self, BindingError> {
        validate_protocol_limits(limits)?;
        let fonts = decode_font_bundle(font_bundle, limits)?;
        Ok(Self {
            engine: Some(TextLayoutEngine::new(fonts, limits.layout)),
            limits,
        })
    }

    pub fn layout(&mut self, request: &[u8]) -> Result<Vec<u8>, BindingError> {
        let (paragraph, constraints) =
            decode_text_layout_request_with_limits(request, self.limits)?;
        let layout = self
            .engine
            .as_mut()
            .ok_or(BindingError::Closed)?
            .layout(&paragraph, constraints)
            .map_err(BindingError::TextLayout)?;
        encode_layout_response(&layout, self.limits.max_response_bytes)
    }

    pub fn close(&mut self) {
        self.engine = None;
    }

    #[must_use]
    pub const fn is_closed(&self) -> bool {
        self.engine.is_none()
    }
}

pub fn canonicalize_render_tile(bytes: &[u8]) -> Result<Vec<u8>, BindingError> {
    let tile = decode_render_tile(bytes, RetainedRenderLimits::default())
        .map_err(BindingError::RenderScene)?;
    encode_render_tile(&tile, RetainedRenderLimits::default()).map_err(BindingError::RenderScene)
}

pub fn canonicalize_render_patch(bytes: &[u8]) -> Result<Vec<u8>, BindingError> {
    let patch = decode_render_patch(bytes, RetainedRenderLimits::default())
        .map_err(BindingError::RenderScene)?;
    encode_render_patch(&patch, RetainedRenderLimits::default()).map_err(BindingError::RenderScene)
}

fn decode_font_bundle(
    bytes: &[u8],
    limits: TextLayoutProtocolLimits,
) -> Result<FontRegistry, BindingError> {
    let payload = decode_envelope(
        bytes,
        FONT_MAGIC,
        TEXT_LAYOUT_FONT_BUNDLE_VERSION,
        limits.max_font_bundle_bytes,
        "font bundle",
    )?;
    let mut reader = Reader::new(payload, "font bundle");
    let count = as_usize(reader.u32()?, "text layout fonts")?;
    if count > limits.layout.max_registered_fonts {
        return Err(BindingError::Limit("text layout fonts"));
    }
    let mut registry = FontRegistry::new(limits.layout);
    let mut previous = None;
    let mut reconstructed = Vec::with_capacity(count);
    for _ in 0..count {
        let expected_id = FontId::from_bytes(reader.array()?);
        let expected_hash = reader.array::<32>()?;
        if previous.is_some_and(|value| value >= expected_id) {
            return Err(BindingError::NonCanonical(
                "font faces must be sorted and unique",
            ));
        }
        previous = Some(expected_id);
        let face_index = reader.u32()?;
        let weight = reader.u16()?;
        let style = decode_font_style(reader.u8()?)?;
        if reader.u8()? != 0 {
            return Err(BindingError::NonCanonical("font descriptor flags"));
        }
        let family = reader.string_u16(256)?;
        let alias_count = usize::from(reader.u16()?);
        if alias_count > 64 {
            return Err(BindingError::Limit("font aliases"));
        }
        let byte_count = as_usize(reader.u32()?, "font asset bytes")?;
        if byte_count > limits.layout.max_font_asset_bytes {
            return Err(BindingError::Limit("font asset bytes"));
        }
        let mut aliases = Vec::with_capacity(alias_count);
        for _ in 0..alias_count {
            aliases.push(reader.string_u16(256)?);
        }
        require_sorted_unique(&aliases, "font aliases")?;
        let asset_bytes: Arc<[u8]> = Arc::from(reader.take(byte_count)?);
        let descriptor = FontDescriptor {
            family,
            aliases,
            weight,
            style,
        };
        let registered = registry
            .register(Arc::clone(&asset_bytes), face_index, descriptor.clone())
            .map_err(BindingError::TextLayout)?;
        if registered.id != expected_id || registered.asset_hash.as_bytes() != &expected_hash {
            return Err(BindingError::StateMismatch("font identity"));
        }
        reconstructed.push(TextLayoutFontAsset {
            bytes: asset_bytes,
            face_index,
            descriptor,
        });
    }
    if !reader.is_empty() {
        return Err(BindingError::TrailingBytes);
    }
    if encode_text_layout_font_bundle_with_limits(&reconstructed, limits)? != bytes {
        return Err(BindingError::NonCanonical("font bundle encoding"));
    }
    Ok(registry)
}

fn encode_style(
    writer: &mut Writer,
    style: &TextStyle,
    limits: LayoutLimits,
) -> Result<(), BindingError> {
    if style.font_families.len() > limits.max_font_families_per_style
        || style.fallback_fonts.len() > limits.max_fallback_fonts_per_style
        || style.features.len() > limits.max_features_per_style
    {
        return Err(BindingError::Limit("text style"));
    }
    if style.language.as_deref() == Some("") {
        return Err(BindingError::NonCanonical("empty font language"));
    }
    writer.u16(as_u16(style.font_families.len(), "font families")?)?;
    writer.u16(as_u16(style.fallback_fonts.len(), "fallback fonts")?)?;
    writer.u16(as_u16(style.features.len(), "font features")?)?;
    writer.u8(style
        .language
        .as_ref()
        .map_or(Ok(0), |value| as_u8(value.len(), "font language"))?)?;
    writer.u8(u8::from(style.script.is_some()))?;
    writer.u16(style.weight)?;
    writer.u8(font_style_tag(style.font_style))?;
    writer.u8(u8::from(style.paint.underline) | (u8::from(style.paint.strike) << 1))?;
    writer.u16(0)?;
    writer.i32(style.font_size.raw())?;
    writer.i32(style.letter_spacing.raw())?;
    writer.u32(style.paint.rgba)?;
    for family in &style.font_families {
        writer.string_u16(family, 256)?;
    }
    for id in &style.fallback_fonts {
        writer.bytes(id.as_bytes())?;
    }
    for feature in &style.features {
        writer.bytes(&feature.tag)?;
        writer.u32(feature.value)?;
    }
    if let Some(language) = &style.language {
        writer.bytes(language.as_bytes())?;
    }
    if let Some(script) = style.script {
        writer.bytes(&script)?;
    }
    Ok(())
}

fn decode_style(reader: &mut Reader<'_>, limits: LayoutLimits) -> Result<TextStyle, BindingError> {
    let family_count = usize::from(reader.u16()?);
    let fallback_count = usize::from(reader.u16()?);
    let feature_count = usize::from(reader.u16()?);
    let language_len = usize::from(reader.u8()?);
    let has_script = match reader.u8()? {
        0 => false,
        1 => true,
        _ => return Err(BindingError::NonCanonical("font script flag")),
    };
    if family_count > limits.max_font_families_per_style
        || fallback_count > limits.max_fallback_fonts_per_style
        || feature_count > limits.max_features_per_style
        || language_len > 63
    {
        return Err(BindingError::Limit("text style"));
    }
    let weight = reader.u16()?;
    let font_style = decode_font_style(reader.u8()?)?;
    let paint_flags = reader.u8()?;
    if paint_flags & !0b11 != 0 || reader.u16()? != 0 {
        return Err(BindingError::NonCanonical("text style flags"));
    }
    let font_size = opengeni_artifact_kernel::text_layout::LayoutUnit::from_raw(reader.i32()?);
    let letter_spacing = opengeni_artifact_kernel::text_layout::LayoutUnit::from_raw(reader.i32()?);
    let rgba = reader.u32()?;
    let mut font_families = Vec::with_capacity(family_count);
    for _ in 0..family_count {
        font_families.push(reader.string_u16(256)?);
    }
    let mut fallback_fonts = Vec::with_capacity(fallback_count);
    for _ in 0..fallback_count {
        fallback_fonts.push(FontId::from_bytes(reader.array()?));
    }
    let mut features = Vec::with_capacity(feature_count);
    for _ in 0..feature_count {
        features.push(FontFeature {
            tag: reader.array()?,
            value: reader.u32()?,
        });
    }
    let language = if language_len == 0 {
        None
    } else {
        Some(
            core::str::from_utf8(reader.take(language_len)?)
                .map_err(|_| BindingError::InvalidUtf8)?
                .to_owned(),
        )
    };
    let script = if has_script {
        Some(reader.array()?)
    } else {
        None
    };
    Ok(TextStyle {
        font_families,
        fallback_fonts,
        weight,
        font_style,
        font_size,
        letter_spacing,
        features,
        language,
        script,
        paint: TextPaint {
            rgba,
            underline: paint_flags & 1 != 0,
            strike: paint_flags & 2 != 0,
        },
    })
}

fn encode_layout_response(
    layout: &ParagraphLayout,
    maximum: usize,
) -> Result<Vec<u8>, BindingError> {
    let mut payload = Writer::new(
        maximum.saturating_sub(HEADER_BYTES + CHECKSUM_BYTES),
        "text layout response",
    );
    payload.bytes(&layout.fingerprint)?;
    payload.i32(layout.width.raw())?;
    payload.i32(layout.height.raw())?;
    payload.u32(as_u32(layout.lines.len(), "layout lines")?)?;
    payload.u32(as_u32(layout.glyph_runs.len(), "glyph runs")?)?;
    payload.u32(as_u32(layout.diagnostics.len(), "font diagnostics")?)?;
    payload.u64(as_u64(layout.work.units, "layout work")?)?;
    payload.u64(as_u64(layout.work.shape_calls, "shape calls")?)?;
    payload.u64(as_u64(layout.work.graphemes, "text graphemes")?)?;
    for line in &layout.lines {
        payload.u64(as_u64(line.text_range.start, "text offset")?)?;
        payload.u64(as_u64(line.text_range.end, "text offset")?)?;
        payload.i32(line.top.raw())?;
        payload.i32(line.baseline.raw())?;
        payload.i32(line.ascent.raw())?;
        payload.i32(line.descent.raw())?;
        payload.i32(line.height.raw())?;
        payload.i32(line.advance.raw())?;
        payload.u32(as_u32(line.glyph_runs.start, "glyph run offset")?)?;
        payload.u32(as_u32(line.glyph_runs.end, "glyph run offset")?)?;
    }
    for run in &layout.glyph_runs {
        payload.bytes(run.font_id.as_bytes())?;
        payload.bytes(run.font_asset_hash.as_bytes())?;
        payload.u64(as_u64(run.text_range.start, "text offset")?)?;
        payload.u64(as_u64(run.text_range.end, "text offset")?)?;
        payload.u8(match run.direction {
            GlyphDirection::LeftToRight => 0,
            GlyphDirection::RightToLeft => 1,
        })?;
        payload.u8(u8::from(run.paint.underline) | (u8::from(run.paint.strike) << 1))?;
        payload.u16(0)?;
        payload.i32(run.font_size.raw())?;
        payload.u32(run.paint.rgba)?;
        payload.i32(run.advance.raw())?;
        payload.i32(run.ascent.raw())?;
        payload.i32(run.descent.raw())?;
        payload.u32(as_u32(run.glyphs.len(), "shaped glyphs")?)?;
        for glyph in &run.glyphs {
            payload.u32(glyph.glyph_id)?;
            payload.u32(glyph.cluster)?;
            payload.i32(glyph.x.raw())?;
            payload.i32(glyph.y.raw())?;
            payload.i32(glyph.advance.raw())?;
            payload.i32(glyph.ink_bounds.x_min.raw())?;
            payload.i32(glyph.ink_bounds.y_min.raw())?;
            payload.i32(glyph.ink_bounds.x_max.raw())?;
            payload.i32(glyph.ink_bounds.y_max.raw())?;
        }
    }
    for diagnostic in &layout.diagnostics {
        payload.u64(as_u64(diagnostic.text_range.start, "text offset")?)?;
        payload.u64(as_u64(diagnostic.text_range.end, "text offset")?)?;
        payload.bytes(diagnostic.resolved_font.as_bytes())?;
        payload.u8(diagnostic.reason as u8)?;
        payload.u8(0)?;
        payload.u16(as_u16(
            diagnostic.requested_families.len(),
            "diagnostic families",
        )?)?;
        for family in &diagnostic.requested_families {
            payload.string_u16(family, 256)?;
        }
    }
    finish_envelope(
        RESPONSE_MAGIC,
        TEXT_LAYOUT_RESPONSE_VERSION,
        payload.finish(),
        maximum,
        "text layout response",
    )
}

fn finish_envelope(
    magic: [u8; 8],
    version: u16,
    payload: Vec<u8>,
    maximum: usize,
    limit: &'static str,
) -> Result<Vec<u8>, BindingError> {
    let total = HEADER_BYTES
        .checked_add(payload.len())
        .and_then(|value| value.checked_add(CHECKSUM_BYTES))
        .ok_or(BindingError::Limit(limit))?;
    if total > maximum || total > u32::MAX as usize {
        return Err(BindingError::Limit(limit));
    }
    let mut output = Vec::with_capacity(total);
    output.extend_from_slice(&magic);
    output.extend_from_slice(&version.to_le_bytes());
    output.extend_from_slice(&0u16.to_le_bytes());
    output.extend_from_slice(&(total as u32).to_le_bytes());
    output.extend_from_slice(&payload);
    let checksum = Sha256::digest(&output);
    output.extend_from_slice(&checksum[..CHECKSUM_BYTES]);
    Ok(output)
}

fn decode_envelope<'a>(
    bytes: &'a [u8],
    magic: [u8; 8],
    version: u16,
    maximum: usize,
    label: &'static str,
) -> Result<&'a [u8], BindingError> {
    if bytes.len() > maximum {
        return Err(BindingError::Limit(label));
    }
    if bytes.len() < HEADER_BYTES + CHECKSUM_BYTES {
        return Err(BindingError::Truncated);
    }
    if bytes[..8] != magic {
        return Err(BindingError::BadMagic(label));
    }
    let actual_version = u16::from_le_bytes(bytes[8..10].try_into().expect("two bytes"));
    if actual_version != version {
        return Err(BindingError::UnsupportedVersion(actual_version));
    }
    if bytes[10..12] != [0, 0] {
        return Err(BindingError::NonCanonical("envelope flags"));
    }
    let declared = u32::from_le_bytes(bytes[12..16].try_into().expect("four bytes")) as usize;
    if declared != bytes.len() {
        return Err(if declared > bytes.len() {
            BindingError::Truncated
        } else {
            BindingError::TrailingBytes
        });
    }
    let payload_end = bytes.len() - CHECKSUM_BYTES;
    let checksum = Sha256::digest(&bytes[..payload_end]);
    if checksum[..CHECKSUM_BYTES] != bytes[payload_end..] {
        return Err(BindingError::ChecksumMismatch);
    }
    Ok(&bytes[HEADER_BYTES..payload_end])
}

fn validate_protocol_limits(limits: TextLayoutProtocolLimits) -> Result<(), BindingError> {
    if limits.max_font_bundle_bytes < HEADER_BYTES + CHECKSUM_BYTES
        || limits.max_request_bytes < HEADER_BYTES + CHECKSUM_BYTES
        || limits.max_response_bytes < HEADER_BYTES + CHECKSUM_BYTES
        || limits.layout.max_text_bytes == 0
        || limits.layout.max_registered_fonts == 0
        || limits.layout.max_work_units == 0
    {
        return Err(BindingError::Kernel(
            "invalid text layout limit profile".into(),
        ));
    }
    Ok(())
}

fn require_sorted_unique(values: &[String], label: &'static str) -> Result<(), BindingError> {
    if values.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(BindingError::NonCanonical(label));
    }
    Ok(())
}

const fn font_style_tag(style: FontStyle) -> u8 {
    match style {
        FontStyle::Normal => 0,
        FontStyle::Italic => 1,
        FontStyle::Oblique => 2,
    }
}

fn decode_font_style(tag: u8) -> Result<FontStyle, BindingError> {
    match tag {
        0 => Ok(FontStyle::Normal),
        1 => Ok(FontStyle::Italic),
        2 => Ok(FontStyle::Oblique),
        _ => Err(BindingError::InvalidTag(tag)),
    }
}

const fn direction_tag(direction: BaseDirection) -> u8 {
    match direction {
        BaseDirection::Auto => 0,
        BaseDirection::LeftToRight => 1,
        BaseDirection::RightToLeft => 2,
    }
}

fn decode_direction(tag: u8) -> Result<BaseDirection, BindingError> {
    match tag {
        0 => Ok(BaseDirection::Auto),
        1 => Ok(BaseDirection::LeftToRight),
        2 => Ok(BaseDirection::RightToLeft),
        _ => Err(BindingError::InvalidTag(tag)),
    }
}

const fn alignment_tag(alignment: TextAlignment) -> u8 {
    match alignment {
        TextAlignment::Start => 0,
        TextAlignment::Center => 1,
        TextAlignment::End => 2,
        TextAlignment::Left => 3,
        TextAlignment::Right => 4,
    }
}

fn decode_alignment(tag: u8) -> Result<TextAlignment, BindingError> {
    match tag {
        0 => Ok(TextAlignment::Start),
        1 => Ok(TextAlignment::Center),
        2 => Ok(TextAlignment::End),
        3 => Ok(TextAlignment::Left),
        4 => Ok(TextAlignment::Right),
        _ => Err(BindingError::InvalidTag(tag)),
    }
}

fn as_u8(value: usize, label: &'static str) -> Result<u8, BindingError> {
    u8::try_from(value).map_err(|_| BindingError::Limit(label))
}

fn as_u16(value: usize, label: &'static str) -> Result<u16, BindingError> {
    u16::try_from(value).map_err(|_| BindingError::Limit(label))
}

fn as_u32(value: usize, label: &'static str) -> Result<u32, BindingError> {
    u32::try_from(value).map_err(|_| BindingError::Limit(label))
}

fn as_u64(value: usize, label: &'static str) -> Result<u64, BindingError> {
    u64::try_from(value).map_err(|_| BindingError::Limit(label))
}

fn as_usize(value: u32, label: &'static str) -> Result<usize, BindingError> {
    usize::try_from(value).map_err(|_| BindingError::Limit(label))
}

struct Writer {
    bytes: Vec<u8>,
    maximum: usize,
    label: &'static str,
}

impl Writer {
    fn new(maximum: usize, label: &'static str) -> Self {
        Self {
            bytes: Vec::new(),
            maximum,
            label,
        }
    }

    fn bytes(&mut self, value: &[u8]) -> Result<(), BindingError> {
        if self
            .bytes
            .len()
            .checked_add(value.len())
            .is_none_or(|length| length > self.maximum)
        {
            return Err(BindingError::Limit(self.label));
        }
        self.bytes.extend_from_slice(value);
        Ok(())
    }

    fn u8(&mut self, value: u8) -> Result<(), BindingError> {
        self.bytes(&[value])
    }

    fn u16(&mut self, value: u16) -> Result<(), BindingError> {
        self.bytes(&value.to_le_bytes())
    }

    fn u32(&mut self, value: u32) -> Result<(), BindingError> {
        self.bytes(&value.to_le_bytes())
    }

    fn i32(&mut self, value: i32) -> Result<(), BindingError> {
        self.bytes(&value.to_le_bytes())
    }

    fn u64(&mut self, value: u64) -> Result<(), BindingError> {
        self.bytes(&value.to_le_bytes())
    }

    fn string_u16(&mut self, value: &str, maximum: usize) -> Result<(), BindingError> {
        if value.len() > maximum {
            return Err(BindingError::Limit(self.label));
        }
        self.u16(as_u16(value.len(), self.label)?)?;
        self.bytes(value.as_bytes())
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
    label: &'static str,
}

impl<'a> Reader<'a> {
    const fn new(bytes: &'a [u8], label: &'static str) -> Self {
        Self {
            bytes,
            offset: 0,
            label,
        }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], BindingError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(BindingError::Limit(self.label))?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or(BindingError::Truncated)?;
        self.offset = end;
        Ok(value)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], BindingError> {
        self.take(N)?
            .try_into()
            .map_err(|_| BindingError::Truncated)
    }

    fn u8(&mut self) -> Result<u8, BindingError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, BindingError> {
        Ok(u16::from_le_bytes(self.array()?))
    }

    fn u32(&mut self) -> Result<u32, BindingError> {
        Ok(u32::from_le_bytes(self.array()?))
    }

    fn i32(&mut self) -> Result<i32, BindingError> {
        Ok(i32::from_le_bytes(self.array()?))
    }

    fn string_u16(&mut self, maximum: usize) -> Result<String, BindingError> {
        let length = usize::from(self.u16()?);
        if length > maximum {
            return Err(BindingError::Limit(self.label));
        }
        core::str::from_utf8(self.take(length)?)
            .map(str::to_owned)
            .map_err(|_| BindingError::InvalidUtf8)
    }

    const fn is_empty(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use opengeni_artifact_kernel::text_layout::{LayoutUnit, TextSpan};

    use super::*;

    #[test]
    fn native_and_wasm_profiles_emit_the_exact_same_layout_vector() {
        let assets = vec![TextLayoutFontAsset {
            bytes: Arc::from(test_font("OpenGeni אבג 漢字 👩🚀- ", 600)),
            face_index: 0,
            descriptor: FontDescriptor::new("Fixture"),
        }];
        let bundle = encode_text_layout_font_bundle(&assets).expect("font bundle");
        let text = "OpenGeni\tאבג 漢\u{00ad}字 👩‍🚀";
        let mut base = TextStyle::new("Fixture", LayoutUnit::from_raw(1_024));
        base.language = Some("en".into());
        let mut emphasized = base.clone();
        emphasized.paint.rgba = 0x1256_9aff;
        emphasized.paint.underline = true;
        let paragraph = RichTextParagraph {
            text: text.into(),
            default_style: base,
            spans: vec![TextSpan {
                range: 9..15,
                style: emphasized,
            }],
            paragraph_style: ParagraphStyle {
                tab_width_spaces: 4,
                ..ParagraphStyle::default()
            },
        };
        let request = encode_text_layout_request(
            &paragraph,
            LayoutConstraints {
                max_width: Some(LayoutUnit::from_raw(5_000)),
            },
        )
        .expect("request");
        assert_eq!(
            decode_text_layout_request(&request).expect("decode"),
            (
                paragraph.clone(),
                LayoutConstraints {
                    max_width: Some(LayoutUnit::from_raw(5_000))
                }
            )
        );

        let mut native =
            TextLayoutBindingSession::open_with_limits(&bundle, NATIVE_TEXT_LAYOUT_LIMITS)
                .expect("native");
        let mut wasm = TextLayoutBindingSession::open_with_limits(&bundle, WASM_TEXT_LAYOUT_LIMITS)
            .expect("wasm");
        let native_bytes = native.layout(&request).expect("native layout");
        let wasm_bytes = wasm.layout(&request).expect("wasm layout");
        assert_eq!(native_bytes, wasm_bytes);
        assert_eq!(&native_bytes[..8], b"OGTLO001");
        assert_eq!(
            native.layout(&request).expect("cached layout"),
            native_bytes,
            "a cache hit must not change semantic response bytes"
        );
        assert_eq!(
            format!("{:x}", Sha256::digest(&native_bytes)),
            "da81305eaeedac8e490427eb28b56614d1cf28c29080f8484b5f06c2964a437e"
        );

        native.close();
        native.close();
        assert!(native.is_closed());
        assert!(matches!(native.layout(&request), Err(BindingError::Closed)));
    }

    #[test]
    fn font_and_request_envelopes_reject_corruption_and_trailing_bytes() {
        let assets = vec![TextLayoutFontAsset {
            bytes: Arc::from(test_font("abc ", 600)),
            face_index: 0,
            descriptor: FontDescriptor::new("Fixture"),
        }];
        let mut bundle = encode_text_layout_font_bundle(&assets).expect("bundle");
        bundle[20] ^= 1;
        assert!(matches!(
            TextLayoutBindingSession::open(&bundle),
            Err(BindingError::ChecksumMismatch)
        ));

        let paragraph = RichTextParagraph::plain(
            "abc",
            TextStyle::new("Fixture", LayoutUnit::from_raw(1_024)),
        );
        let mut request =
            encode_text_layout_request(&paragraph, LayoutConstraints::UNBOUNDED).expect("request");
        request.push(0);
        assert!(matches!(
            decode_text_layout_request(&request),
            Err(BindingError::TrailingBytes)
        ));
    }

    #[test]
    fn protocol_limits_are_exact_and_ambiguous_empty_language_is_rejected() {
        let assets = vec![TextLayoutFontAsset {
            bytes: Arc::from(test_font("abcd ", 600)),
            face_index: 0,
            descriptor: FontDescriptor::new("Fixture"),
        }];
        let bundle = encode_text_layout_font_bundle(&assets).expect("bundle");
        let exact_bundle_limits = TextLayoutProtocolLimits {
            max_font_bundle_bytes: bundle.len(),
            ..NATIVE_TEXT_LAYOUT_LIMITS
        };
        assert_eq!(
            encode_text_layout_font_bundle_with_limits(&assets, exact_bundle_limits)
                .expect("exact bundle limit"),
            bundle
        );
        assert!(matches!(
            encode_text_layout_font_bundle_with_limits(
                &assets,
                TextLayoutProtocolLimits {
                    max_font_bundle_bytes: bundle.len() - 1,
                    ..NATIVE_TEXT_LAYOUT_LIMITS
                }
            ),
            Err(BindingError::Limit("font bundle"))
        ));

        let paragraph = RichTextParagraph::plain(
            "abc",
            TextStyle::new("Fixture", LayoutUnit::from_raw(1_024)),
        );
        let request =
            encode_text_layout_request(&paragraph, LayoutConstraints::UNBOUNDED).expect("request");
        let exact_request_limits = TextLayoutProtocolLimits {
            max_request_bytes: request.len(),
            ..NATIVE_TEXT_LAYOUT_LIMITS
        };
        assert_eq!(
            encode_text_layout_request_with_limits(
                &paragraph,
                LayoutConstraints::UNBOUNDED,
                exact_request_limits,
            )
            .expect("exact request limit"),
            request
        );
        assert!(matches!(
            encode_text_layout_request_with_limits(
                &paragraph,
                LayoutConstraints::UNBOUNDED,
                TextLayoutProtocolLimits {
                    max_request_bytes: request.len() - 1,
                    ..NATIVE_TEXT_LAYOUT_LIMITS
                },
            ),
            Err(BindingError::Limit("text layout request"))
        ));

        let at_text_limit = TextLayoutProtocolLimits {
            layout: LayoutLimits {
                max_text_bytes: 3,
                ..NATIVE_TEXT_LAYOUT_LIMITS.layout
            },
            ..NATIVE_TEXT_LAYOUT_LIMITS
        };
        encode_text_layout_request_with_limits(
            &paragraph,
            LayoutConstraints::UNBOUNDED,
            at_text_limit,
        )
        .expect("text max");
        assert!(matches!(
            encode_text_layout_request_with_limits(
                &RichTextParagraph::plain(
                    "abcd",
                    TextStyle::new("Fixture", LayoutUnit::from_raw(1_024)),
                ),
                LayoutConstraints::UNBOUNDED,
                at_text_limit,
            ),
            Err(BindingError::Limit("text layout request"))
        ));

        let response = layout_text(&bundle, &request).expect("baseline response");
        let mut exact_response = TextLayoutBindingSession::open_with_limits(
            &bundle,
            TextLayoutProtocolLimits {
                max_response_bytes: response.len(),
                ..NATIVE_TEXT_LAYOUT_LIMITS
            },
        )
        .expect("exact response session");
        assert_eq!(
            exact_response
                .layout(&request)
                .expect("exact response limit"),
            response
        );
        let mut short_response = TextLayoutBindingSession::open_with_limits(
            &bundle,
            TextLayoutProtocolLimits {
                max_response_bytes: response.len() - 1,
                ..NATIVE_TEXT_LAYOUT_LIMITS
            },
        )
        .expect("short response session");
        assert!(matches!(
            short_response.layout(&request),
            Err(BindingError::Limit("text layout response"))
        ));

        let mut empty_language = paragraph;
        empty_language.default_style.language = Some(String::new());
        assert!(matches!(
            encode_text_layout_request(&empty_language, LayoutConstraints::UNBOUNDED),
            Err(BindingError::NonCanonical("empty font language"))
        ));
        empty_language.default_style.language = None;
        assert!(matches!(
            encode_text_layout_request(
                &empty_language,
                LayoutConstraints {
                    max_width: Some(LayoutUnit::ZERO),
                },
            ),
            Err(BindingError::NonCanonical("zero maximum width"))
        ));
        empty_language.paragraph_style.line_height = Some(LayoutUnit::ZERO);
        assert!(matches!(
            encode_text_layout_request(&empty_language, LayoutConstraints::UNBOUNDED),
            Err(BindingError::NonCanonical("zero line height"))
        ));
    }

    #[test]
    fn capabilities_publish_native_and_wasm_text_layout_bounds() {
        let native: serde_json::Value =
            serde_json::from_slice(crate::capabilities()).expect("native capabilities");
        let wasm: serde_json::Value =
            serde_json::from_slice(&crate::capabilities_for(crate::WASM_LIMITS))
                .expect("wasm capabilities");
        assert_eq!(native["textLayout"], true);
        assert_eq!(native["textLayoutStatefulSessions"], true);
        assert_eq!(native["retainedRenderPatchVersion"], 1);
        assert_eq!(
            native["maxTextLayoutFontBundleBytes"],
            NATIVE_TEXT_LAYOUT_LIMITS.max_font_bundle_bytes
        );
        assert_eq!(
            wasm["maxTextLayoutFontBundleBytes"],
            WASM_TEXT_LAYOUT_LIMITS.max_font_bundle_bytes
        );
        assert_eq!(
            wasm["maxTextLayoutResponseBytes"],
            WASM_TEXT_LAYOUT_LIMITS.max_response_bytes
        );
    }

    fn test_font(characters: &str, advance: u16) -> Vec<u8> {
        let codepoints = characters
            .chars()
            .filter(|character| !matches!(character, '\n' | '\r' | '\u{200d}'))
            .map(u32::from)
            .collect::<BTreeSet<_>>();
        let glyph_count = u16::try_from(codepoints.len() + 1).expect("fixture glyph count");

        let mut cmap = Vec::new();
        be_u16(&mut cmap, 0);
        be_u16(&mut cmap, 1);
        be_u16(&mut cmap, 3);
        be_u16(&mut cmap, 10);
        be_u32(&mut cmap, 12);
        be_u16(&mut cmap, 12);
        be_u16(&mut cmap, 0);
        let cmap_length = 16 + codepoints.len() * 12;
        be_u32(&mut cmap, cmap_length as u32);
        be_u32(&mut cmap, 0);
        be_u32(&mut cmap, codepoints.len() as u32);
        for (index, codepoint) in codepoints.iter().copied().enumerate() {
            be_u32(&mut cmap, codepoint);
            be_u32(&mut cmap, codepoint);
            be_u32(&mut cmap, (index + 1) as u32);
        }

        let mut head = vec![0u8; 54];
        put_u32(&mut head, 0, 0x0001_0000);
        put_u32(&mut head, 4, 0x0001_0000);
        put_u32(&mut head, 12, 0x5f0f_3cf5);
        put_u16(&mut head, 18, 1_000);
        put_i16(&mut head, 36, 0);
        put_i16(&mut head, 38, -200);
        put_i16(&mut head, 40, advance as i16);
        put_i16(&mut head, 42, 800);
        put_u16(&mut head, 46, 8);
        put_i16(&mut head, 48, 2);

        let mut hhea = vec![0u8; 36];
        put_u32(&mut hhea, 0, 0x0001_0000);
        put_i16(&mut hhea, 4, 800);
        put_i16(&mut hhea, 6, -200);
        put_i16(&mut hhea, 8, 200);
        put_u16(&mut hhea, 10, advance);
        put_i16(&mut hhea, 16, advance as i16);
        put_i16(&mut hhea, 18, 1);
        put_u16(&mut hhea, 34, glyph_count);

        let mut hmtx = Vec::with_capacity(glyph_count as usize * 4);
        for _ in 0..glyph_count {
            be_u16(&mut hmtx, advance);
            be_i16(&mut hmtx, 0);
        }
        let mut maxp = Vec::with_capacity(6);
        be_u32(&mut maxp, 0x0000_5000);
        be_u16(&mut maxp, glyph_count);

        let tables = vec![
            (*b"cmap", cmap),
            (*b"head", head),
            (*b"hhea", hhea),
            (*b"hmtx", hmtx),
            (*b"maxp", maxp),
        ];
        let table_count = tables.len() as u16;
        let mut font = Vec::new();
        be_u32(&mut font, 0x0001_0000);
        be_u16(&mut font, table_count);
        be_u16(&mut font, 64);
        be_u16(&mut font, 2);
        be_u16(&mut font, table_count * 16 - 64);
        let directory_start = font.len();
        font.resize(directory_start + tables.len() * 16, 0);
        let mut offset = font.len();
        for (index, (tag, table)) in tables.into_iter().enumerate() {
            while offset % 4 != 0 {
                font.push(0);
                offset += 1;
            }
            let entry = directory_start + index * 16;
            font[entry..entry + 4].copy_from_slice(&tag);
            put_u32(&mut font, entry + 4, font_checksum(&table));
            put_u32(&mut font, entry + 8, offset as u32);
            put_u32(&mut font, entry + 12, table.len() as u32);
            font.extend_from_slice(&table);
            offset += table.len();
        }
        font
    }

    fn font_checksum(bytes: &[u8]) -> u32 {
        bytes.chunks(4).fold(0u32, |sum, chunk| {
            let mut word = [0u8; 4];
            word[..chunk.len()].copy_from_slice(chunk);
            sum.wrapping_add(u32::from_be_bytes(word))
        })
    }

    fn be_u16(output: &mut Vec<u8>, value: u16) {
        output.extend_from_slice(&value.to_be_bytes());
    }

    fn be_i16(output: &mut Vec<u8>, value: i16) {
        output.extend_from_slice(&value.to_be_bytes());
    }

    fn be_u32(output: &mut Vec<u8>, value: u32) {
        output.extend_from_slice(&value.to_be_bytes());
    }

    fn put_u16(output: &mut [u8], offset: usize, value: u16) {
        output[offset..offset + 2].copy_from_slice(&value.to_be_bytes());
    }

    fn put_i16(output: &mut [u8], offset: usize, value: i16) {
        output[offset..offset + 2].copy_from_slice(&value.to_be_bytes());
    }

    fn put_u32(output: &mut [u8], offset: usize, value: u32) {
        output[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
    }
}
