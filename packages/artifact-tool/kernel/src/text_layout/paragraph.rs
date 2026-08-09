use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;
use std::sync::Arc;

use rustybuzz::{ttf_parser, Direction, Feature, UnicodeBuffer};
use sha2::{Digest, Sha256};
use unicode_bidi::{BidiInfo, Level, ParagraphInfo};
use unicode_linebreak::{linebreaks, BreakOpportunity};
use unicode_segmentation::UnicodeSegmentation;

use super::cache::LayoutCacheKey;
use super::{
    BaseDirection, FontId, FontSubstitutionDiagnostic, FontSubstitutionReason, GlyphDirection,
    GlyphRun, LayoutConstraints, LayoutError, LayoutLine, LayoutUnit, LayoutWork, ParagraphLayout,
    RichTextParagraph, TextAlignment, TextLayoutEngine, TextStyle,
};

const LAYOUT_KEY_DOMAIN: &[u8] = b"opengeni:artifact:text-layout:v1\0";

pub(super) fn layout(
    engine: &mut TextLayoutEngine,
    paragraph: &RichTextParagraph,
    constraints: LayoutConstraints,
) -> Result<Arc<ParagraphLayout>, LayoutError> {
    validate(engine, paragraph, constraints)?;
    let key = cache_key(engine, paragraph, constraints);
    if let Some(cached) = engine.cache.get(&key) {
        return Ok(cached);
    }
    let uncached = layout_uncached(engine, paragraph, constraints, key)?;
    // Coverage and layout LRU state become visible together only after all
    // shaping, line breaking and output construction has succeeded.
    engine.fonts.commit_coverage(uncached.coverage)?;
    let layout = Arc::new(uncached.layout);
    engine.cache.insert(key, Arc::clone(&layout));
    Ok(layout)
}

fn validate(
    engine: &TextLayoutEngine,
    paragraph: &RichTextParagraph,
    constraints: LayoutConstraints,
) -> Result<(), LayoutError> {
    if paragraph.text.len() > engine.limits.max_text_bytes {
        return Err(LayoutError::LimitExceeded("paragraph text bytes"));
    }
    if paragraph.spans.len() > engine.limits.max_spans {
        return Err(LayoutError::LimitExceeded("rich-text spans"));
    }
    if let Some(width) = constraints.max_width {
        if width.raw() <= 0 {
            return Err(LayoutError::InvalidConstraint(
                "maximum width must be positive",
            ));
        }
    }
    if paragraph
        .paragraph_style
        .line_height
        .is_some_and(|height| height.raw() <= 0)
    {
        return Err(LayoutError::InvalidConstraint(
            "line height must be positive",
        ));
    }
    if paragraph.paragraph_style.tab_width_spaces == 0
        || paragraph.paragraph_style.tab_width_spaces > 32
    {
        return Err(LayoutError::InvalidConstraint(
            "tab width must be in 1..=32 spaces",
        ));
    }
    validate_style(engine, &paragraph.default_style)?;
    let mut previous_end = 0;
    for span in &paragraph.spans {
        if span.range.start >= span.range.end {
            return Err(LayoutError::InvalidSpan("span must be non-empty"));
        }
        if span.range.end > paragraph.text.len()
            || !paragraph.text.is_char_boundary(span.range.start)
            || !paragraph.text.is_char_boundary(span.range.end)
        {
            return Err(LayoutError::InvalidSpan(
                "span must use in-bounds UTF-8 byte boundaries",
            ));
        }
        if span.range.start < previous_end {
            return Err(LayoutError::InvalidSpan(
                "spans must be sorted and non-overlapping",
            ));
        }
        previous_end = span.range.end;
        validate_style(engine, &span.style)?;
    }
    Ok(())
}

fn validate_style(engine: &TextLayoutEngine, style: &TextStyle) -> Result<(), LayoutError> {
    if style.font_size.raw() <= 0 {
        return Err(LayoutError::InvalidTextStyle("font size must be positive"));
    }
    if !(1..=1_000).contains(&style.weight) {
        return Err(LayoutError::InvalidTextStyle("weight must be 1..=1000"));
    }
    if style.font_families.len() > engine.limits.max_font_families_per_style {
        return Err(LayoutError::LimitExceeded("font families per style"));
    }
    if style.fallback_fonts.len() > engine.limits.max_fallback_fonts_per_style {
        return Err(LayoutError::LimitExceeded("fallback fonts per style"));
    }
    if style.features.len() > engine.limits.max_features_per_style {
        return Err(LayoutError::LimitExceeded("font features per style"));
    }
    if style.font_families.is_empty() && style.fallback_fonts.is_empty() {
        return Err(LayoutError::InvalidTextStyle(
            "at least one explicit family or font id is required",
        ));
    }
    for family in &style.font_families {
        super::font::canonical_family(family)?;
    }
    if let Some(language) = &style.language {
        if language.is_empty()
            || language.len() > 63
            || !language
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || language.parse::<rustybuzz::Language>().is_err()
        {
            return Err(LayoutError::InvalidTextStyle(
                "language must be a bounded ASCII BCP-47/OpenType tag",
            ));
        }
    }
    if let Some(script) = style.script {
        if rustybuzz::Script::from_iso15924_tag(ttf_parser::Tag::from_bytes(&script)).is_none() {
            return Err(LayoutError::InvalidTextStyle(
                "script must be a valid ISO-15924 tag",
            ));
        }
    }
    let mut previous = None;
    for feature in &style.features {
        if feature.tag.iter().any(|byte| !(0x20..=0x7e).contains(byte)) {
            return Err(LayoutError::InvalidTextStyle(
                "OpenType feature tags must be printable ASCII",
            ));
        }
        if previous.is_some_and(|tag| tag >= feature.tag) {
            return Err(LayoutError::InvalidTextStyle(
                "OpenType features must be sorted and unique",
            ));
        }
        previous = Some(feature.tag);
    }
    Ok(())
}

struct UncachedLayout {
    layout: ParagraphLayout,
    coverage: BTreeMap<FontId, BTreeMap<char, bool>>,
}

#[derive(Debug)]
struct WorkMeter {
    units: usize,
    shape_calls: usize,
    graphemes: usize,
    max_units: usize,
    max_shape_calls: usize,
}

impl WorkMeter {
    fn new(
        text_bytes: usize,
        span_count: usize,
        graphemes: usize,
        engine: &TextLayoutEngine,
    ) -> Result<Self, LayoutError> {
        if graphemes > engine.limits.max_graphemes {
            return Err(LayoutError::LimitExceeded("text graphemes"));
        }
        let units = text_bytes
            .checked_add(graphemes.saturating_mul(2))
            .and_then(|value| value.checked_add(span_count.saturating_mul(8)))
            .ok_or(LayoutError::LimitExceeded("layout work units"))?;
        if units > engine.limits.max_work_units {
            return Err(LayoutError::LimitExceeded("layout work units"));
        }
        Ok(Self {
            units,
            shape_calls: 0,
            graphemes,
            max_units: engine.limits.max_work_units,
            max_shape_calls: engine.limits.max_shape_calls,
        })
    }

    fn shape(&mut self, text_bytes: usize) -> Result<(), LayoutError> {
        self.shape_calls = self
            .shape_calls
            .checked_add(1)
            .ok_or(LayoutError::LimitExceeded("shape calls"))?;
        if self.shape_calls > self.max_shape_calls {
            return Err(LayoutError::LimitExceeded("shape calls"));
        }
        self.consume(text_bytes.saturating_add(16))
    }

    fn glyphs(&mut self, count: usize) -> Result<(), LayoutError> {
        self.consume(count.saturating_mul(4))
    }

    fn consume(&mut self, units: usize) -> Result<(), LayoutError> {
        self.units = self
            .units
            .checked_add(units)
            .ok_or(LayoutError::LimitExceeded("layout work units"))?;
        if self.units > self.max_units {
            return Err(LayoutError::LimitExceeded("layout work units"));
        }
        Ok(())
    }

    const fn report(&self) -> LayoutWork {
        LayoutWork {
            units: self.units,
            shape_calls: self.shape_calls,
            graphemes: self.graphemes,
        }
    }
}

fn layout_uncached(
    engine: &mut TextLayoutEngine,
    paragraph: &RichTextParagraph,
    constraints: LayoutConstraints,
    fingerprint: LayoutCacheKey,
) -> Result<UncachedLayout, LayoutError> {
    let graphemes = paragraph
        .text
        .graphemes(true)
        .take(engine.limits.max_graphemes.saturating_add(1))
        .count();
    let work = WorkMeter::new(
        paragraph.text.len(),
        paragraph.spans.len(),
        graphemes,
        engine,
    )?;
    let default_level = match paragraph.paragraph_style.direction {
        BaseDirection::Auto => None,
        BaseDirection::LeftToRight => Some(Level::ltr()),
        BaseDirection::RightToLeft => Some(Level::rtl()),
    };
    let bidi = BidiInfo::new(&paragraph.text, default_level);
    let mut context = ShapingContext {
        engine,
        paragraph,
        bidi,
        candidates: BTreeMap::new(),
        diagnostics: Vec::new(),
        glyph_count: 0,
        coverage: BTreeMap::new(),
        work,
    };
    let line_ranges = build_line_ranges(&mut context, constraints.max_width)?;
    if line_ranges.len() > context.engine.limits.max_lines {
        return Err(LayoutError::LimitExceeded("layout lines"));
    }

    let mut lines = Vec::with_capacity(line_ranges.len());
    let mut glyph_runs = Vec::new();
    let mut y = LayoutUnit::ZERO;
    let mut content_width = LayoutUnit::ZERO;
    let available_width = constraints.max_width;

    for line_range in line_ranges {
        let range = line_range.range;
        let mut shaped =
            context.shape_visual(range.clone(), true, line_range.show_terminal_soft_hyphen)?;
        let natural_height = shaped
            .ascent
            .checked_add(shaped.descent)?
            .checked_add(shaped.line_gap)?;
        let line_height = paragraph
            .paragraph_style
            .line_height
            .unwrap_or(natural_height);
        let extra_leading = line_height
            .raw()
            .saturating_sub(shaped.ascent.raw().saturating_add(shaped.descent.raw()));
        let baseline = y
            .checked_add(LayoutUnit::from_raw(extra_leading / 2))?
            .checked_add(shaped.ascent)?;
        let line_direction = context.direction_for_range(&range);
        let alignment_offset = alignment_offset(
            paragraph.paragraph_style.alignment,
            line_direction,
            available_width.unwrap_or(shaped.advance),
            shaped.advance,
        )?;
        for run in &mut shaped.runs {
            for glyph in &mut run.glyphs {
                glyph.x = glyph.x.checked_add(alignment_offset)?;
                glyph.y = glyph.y.checked_add(baseline)?;
            }
        }
        let run_start = glyph_runs.len();
        glyph_runs.extend(shaped.runs);
        let run_end = glyph_runs.len();
        content_width = content_width.max(shaped.advance);
        lines.push(LayoutLine {
            text_range: range,
            top: y,
            baseline,
            ascent: shaped.ascent,
            descent: shaped.descent,
            height: line_height,
            advance: shaped.advance,
            glyph_runs: run_start..run_end,
        });
        y = y.checked_add(line_height)?;
    }

    let width = available_width.unwrap_or(content_width);
    let work = context.work.report();
    Ok(UncachedLayout {
        layout: ParagraphLayout {
            fingerprint,
            width,
            height: y,
            lines,
            glyph_runs,
            diagnostics: coalesce_diagnostics(context.diagnostics),
            work,
        },
        coverage: context.coverage,
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct LineRange {
    range: Range<usize>,
    show_terminal_soft_hyphen: bool,
}

fn build_line_ranges(
    context: &mut ShapingContext<'_>,
    max_width: Option<LayoutUnit>,
) -> Result<Vec<LineRange>, LayoutError> {
    if context.paragraph.text.is_empty() {
        let mut output = Vec::new();
        push_line_range(
            context,
            &mut output,
            LineRange {
                range: 0..0,
                show_terminal_soft_hyphen: false,
            },
        )?;
        return Ok(output);
    }
    let mut output = Vec::new();
    let mut hard_start = 0;
    let mut allowed = Vec::new();
    let mut ended_with_hard_break = false;
    for (end, opportunity) in linebreaks(&context.paragraph.text) {
        match opportunity {
            BreakOpportunity::Allowed => allowed.push(end),
            BreakOpportunity::Mandatory => {
                let content_end = trim_hard_break(&context.paragraph.text, hard_start, end);
                ended_with_hard_break = content_end < end;
                wrap_hard_line(
                    context,
                    hard_start,
                    content_end,
                    &allowed,
                    max_width,
                    &mut output,
                )?;
                hard_start = end;
                allowed.clear();
            }
        }
    }
    if hard_start < context.paragraph.text.len() {
        wrap_hard_line(
            context,
            hard_start,
            context.paragraph.text.len(),
            &allowed,
            max_width,
            &mut output,
        )?;
    } else if ended_with_hard_break {
        push_line_range(
            context,
            &mut output,
            LineRange {
                range: hard_start..hard_start,
                show_terminal_soft_hyphen: false,
            },
        )?;
    }
    if output.is_empty() {
        push_line_range(
            context,
            &mut output,
            LineRange {
                range: 0..0,
                show_terminal_soft_hyphen: false,
            },
        )?;
    }
    Ok(output)
}

fn wrap_hard_line(
    context: &mut ShapingContext<'_>,
    start: usize,
    end: usize,
    allowed: &[usize],
    max_width: Option<LayoutUnit>,
    output: &mut Vec<LineRange>,
) -> Result<(), LayoutError> {
    if start == end {
        push_line_range(
            context,
            output,
            LineRange {
                range: start..end,
                show_terminal_soft_hyphen: false,
            },
        )?;
        return Ok(());
    }
    let Some(max_width) = max_width else {
        push_line_range(
            context,
            output,
            LineRange {
                range: start..end,
                show_terminal_soft_hyphen: false,
            },
        )?;
        return Ok(());
    };
    let measurements = context.measure_index(start..end)?;
    let mut boundaries = allowed
        .iter()
        .copied()
        .filter(|boundary| *boundary > start && *boundary < end)
        .collect::<Vec<_>>();
    boundaries.push(end);

    let mut line_start = start;
    while line_start < end {
        let mut best = None;
        for boundary in boundaries
            .iter()
            .copied()
            .filter(|value| *value > line_start)
        {
            let width = measurements.width(line_start, boundary)?;
            if width.raw() <= max_width.raw() {
                best = Some(boundary);
                continue;
            }
            break;
        }
        if let Some(line_end) = best {
            let mut verified_end = line_end;
            while context
                .shape_visual(
                    line_start..verified_end,
                    false,
                    is_soft_hyphen_break(&context.paragraph.text, verified_end, end),
                )?
                .advance
                .raw()
                > max_width.raw()
            {
                let Some(previous) = boundaries
                    .iter()
                    .copied()
                    .rfind(|boundary| *boundary > line_start && *boundary < verified_end)
                else {
                    verified_end =
                        emergency_break(context, &measurements, line_start, end, max_width)?;
                    break;
                };
                verified_end = previous;
            }
            push_line_range(
                context,
                output,
                LineRange {
                    range: line_start..verified_end,
                    show_terminal_soft_hyphen: is_soft_hyphen_break(
                        &context.paragraph.text,
                        verified_end,
                        end,
                    ),
                },
            )?;
            line_start = verified_end;
            continue;
        }
        let emergency = emergency_break(context, &measurements, line_start, end, max_width)?;
        push_line_range(
            context,
            output,
            LineRange {
                range: line_start..emergency,
                show_terminal_soft_hyphen: is_soft_hyphen_break(
                    &context.paragraph.text,
                    emergency,
                    end,
                ),
            },
        )?;
        line_start = emergency;
    }
    Ok(())
}

fn push_line_range(
    context: &ShapingContext<'_>,
    output: &mut Vec<LineRange>,
    line: LineRange,
) -> Result<(), LayoutError> {
    if output.len() >= context.engine.limits.max_lines {
        return Err(LayoutError::LimitExceeded("layout lines"));
    }
    output.push(line);
    Ok(())
}

fn emergency_break(
    context: &mut ShapingContext<'_>,
    measurements: &AdvanceIndex,
    start: usize,
    end: usize,
    max_width: LayoutUnit,
) -> Result<usize, LayoutError> {
    let slice = &context.paragraph.text[start..end];
    let mut best = None;
    for (offset, grapheme) in slice.grapheme_indices(true) {
        let candidate = start + offset + grapheme.len();
        let approximate_width = measurements.width(start, candidate)?;
        let width = if approximate_width.raw() <= max_width.raw() || best.is_none() {
            context
                .shape_visual(
                    start..candidate,
                    false,
                    is_soft_hyphen_break(&context.paragraph.text, candidate, end),
                )?
                .advance
        } else {
            approximate_width
        };
        if width.raw() <= max_width.raw() || best.is_none() {
            best = Some(candidate);
        } else {
            break;
        }
    }
    best.ok_or(LayoutError::InvalidSpan(
        "failed to find a UTF-8 grapheme boundary",
    ))
}

fn is_soft_hyphen_break(text: &str, line_end: usize, hard_end: usize) -> bool {
    line_end < hard_end && text[..line_end].ends_with('\u{00ad}')
}

fn trim_hard_break(text: &str, start: usize, end: usize) -> usize {
    let slice = &text[start..end];
    if slice.ends_with("\r\n") {
        end - 2
    } else if slice.ends_with(['\n', '\r', '\u{0085}', '\u{2028}', '\u{2029}']) {
        end - slice.chars().next_back().map(char::len_utf8).unwrap_or(0)
    } else {
        end
    }
}

#[derive(Clone, Debug)]
struct CandidateResolution {
    ids: Vec<FontId>,
    missing_requested_family: bool,
    style_substitution: bool,
}

#[derive(Clone, Debug)]
struct ShapeGroup {
    range: Range<usize>,
    font_id: FontId,
    style: TextStyle,
    direction: GlyphDirection,
    reason: Option<FontSubstitutionReason>,
    /// Formatting replacements stay isolated so a terminal soft hyphen never
    /// makes an earlier soft hyphen in the same run visible.
    mergeable: bool,
}

#[derive(Debug)]
struct ShapedLine {
    runs: Vec<GlyphRun>,
    advance: LayoutUnit,
    ascent: LayoutUnit,
    descent: LayoutUnit,
    line_gap: LayoutUnit,
}

#[derive(Debug)]
struct AdvanceIndex {
    boundaries: Vec<usize>,
    prefix: Vec<i64>,
}

impl AdvanceIndex {
    fn width(&self, start: usize, end: usize) -> Result<LayoutUnit, LayoutError> {
        let start_index = self
            .boundaries
            .binary_search(&start)
            .map_err(|_| LayoutError::InvalidSpan("line start is not a grapheme boundary"))?;
        let end_index = self
            .boundaries
            .binary_search(&end)
            .map_err(|_| LayoutError::InvalidSpan("line end is not a grapheme boundary"))?;
        let width = self.prefix[end_index]
            .checked_sub(self.prefix[start_index])
            .ok_or(LayoutError::CoordinateOverflow)?;
        i32::try_from(width)
            .map(LayoutUnit::from_raw)
            .map_err(|_| LayoutError::CoordinateOverflow)
    }
}

struct ShapingContext<'a> {
    engine: &'a mut TextLayoutEngine,
    paragraph: &'a RichTextParagraph,
    bidi: BidiInfo<'a>,
    candidates: BTreeMap<TextStyle, CandidateResolution>,
    diagnostics: Vec<FontSubstitutionDiagnostic>,
    glyph_count: usize,
    coverage: BTreeMap<FontId, BTreeMap<char, bool>>,
    work: WorkMeter,
}

impl ShapingContext<'_> {
    fn measure_index(&mut self, range: Range<usize>) -> Result<AdvanceIndex, LayoutError> {
        let groups = self.logical_groups_for(range.clone())?;
        let mut cluster_advances = BTreeMap::<usize, i64>::new();
        for group in groups {
            self.shape_group(&group, false, Some(&mut cluster_advances), false)?;
        }
        let mut boundaries = Vec::new();
        boundaries.push(range.start);
        for (relative, grapheme) in self.paragraph.text[range.clone()].grapheme_indices(true) {
            boundaries.push(range.start + relative + grapheme.len());
        }
        let mut prefix = Vec::with_capacity(boundaries.len());
        prefix.push(0i64);
        let mut running = 0i64;
        for window in boundaries.windows(2) {
            let advance = cluster_advances
                .range(window[0]..window[1])
                .try_fold(0i64, |sum, (_, value)| sum.checked_add(*value))
                .ok_or(LayoutError::CoordinateOverflow)?;
            running = running
                .checked_add(advance)
                .ok_or(LayoutError::CoordinateOverflow)?;
            prefix.push(running);
        }
        Ok(AdvanceIndex { boundaries, prefix })
    }

    fn shape_visual(
        &mut self,
        range: Range<usize>,
        retain_glyphs: bool,
        show_terminal_soft_hyphen: bool,
    ) -> Result<ShapedLine, LayoutError> {
        if range.start == range.end {
            return self.empty_line(range.start, retain_glyphs);
        }
        let paragraph_info = self.paragraph_for(&range)?;
        let (levels, visual_ranges) = self.bidi.visual_runs(paragraph_info, range.clone());
        let mut groups = Vec::new();
        for visual_range in visual_ranges {
            let direction = if levels[visual_range.start].is_rtl() {
                GlyphDirection::RightToLeft
            } else {
                GlyphDirection::LeftToRight
            };
            let mut run_groups =
                self.groups_for(visual_range, direction, show_terminal_soft_hyphen)?;
            if direction == GlyphDirection::RightToLeft {
                run_groups.reverse();
            }
            groups.extend(run_groups);
        }

        let mut runs = Vec::with_capacity(groups.len());
        let mut cursor = LayoutUnit::ZERO;
        let mut ascent = LayoutUnit::ZERO;
        let mut descent = LayoutUnit::ZERO;
        let mut line_gap = LayoutUnit::ZERO;
        for group in groups {
            let show_soft_hyphen = show_terminal_soft_hyphen && group.range.end == range.end;
            let mut run = self.shape_group(&group, retain_glyphs, None, show_soft_hyphen)?;
            for glyph in &mut run.glyphs {
                glyph.x = glyph.x.checked_add(cursor)?;
            }
            cursor = cursor.checked_add(run.advance)?;
            ascent = ascent.max(run.ascent);
            descent = descent.max(run.descent);
            let metadata = self
                .engine
                .fonts
                .get(group.font_id)
                .ok_or(LayoutError::UnknownFont(group.font_id))?;
            line_gap = line_gap.max(scale_metric(
                i32::from(metadata.line_gap).max(0),
                group.style.font_size,
                metadata.units_per_em,
            )?);
            if retain_glyphs {
                if let Some(reason) = group.reason {
                    self.diagnostics.push(FontSubstitutionDiagnostic {
                        text_range: group.range.clone(),
                        requested_families: group.style.font_families.clone(),
                        resolved_font: group.font_id,
                        reason,
                    });
                }
                runs.push(run);
            }
        }
        Ok(ShapedLine {
            runs,
            advance: cursor,
            ascent,
            descent,
            line_gap,
        })
    }

    fn empty_line(
        &mut self,
        offset: usize,
        retain_glyphs: bool,
    ) -> Result<ShapedLine, LayoutError> {
        let style = self.style_at(offset).clone();
        let resolution = self.resolve_candidates(&style)?.clone();
        let font_id = *resolution
            .ids
            .first()
            .ok_or_else(|| LayoutError::NoFontAvailable {
                requested_families: style.font_families.clone(),
            })?;
        let metadata = self
            .engine
            .fonts
            .get(font_id)
            .ok_or(LayoutError::UnknownFont(font_id))?;
        let ascent = scale_metric(
            i32::from(metadata.ascender).max(0),
            style.font_size,
            metadata.units_per_em,
        )?;
        let descent = scale_metric(
            i32::from(metadata.descender).saturating_neg().max(0),
            style.font_size,
            metadata.units_per_em,
        )?;
        let line_gap = scale_metric(
            i32::from(metadata.line_gap).max(0),
            style.font_size,
            metadata.units_per_em,
        )?;
        if retain_glyphs && resolution.missing_requested_family {
            self.diagnostics.push(FontSubstitutionDiagnostic {
                text_range: offset..offset,
                requested_families: style.font_families,
                resolved_font: font_id,
                reason: FontSubstitutionReason::RequestedFamilyUnavailable,
            });
        }
        Ok(ShapedLine {
            runs: Vec::new(),
            advance: LayoutUnit::ZERO,
            ascent,
            descent,
            line_gap,
        })
    }

    fn groups_for(
        &mut self,
        range: Range<usize>,
        direction: GlyphDirection,
        show_terminal_soft_hyphen: bool,
    ) -> Result<Vec<ShapeGroup>, LayoutError> {
        let slice = &self.paragraph.text[range.clone()];
        let mut groups: Vec<ShapeGroup> = Vec::new();
        for (relative, grapheme) in slice.grapheme_indices(true) {
            let mut segment_start = range.start + relative;
            let grapheme_end = segment_start + grapheme.len();
            let replacement = match grapheme {
                "\t" => Some(" "),
                "\u{00ad}" if show_terminal_soft_hyphen && grapheme_end == range.end => Some("-"),
                "\u{00ad}" | "\u{200b}" => Some(""),
                _ => None,
            };
            while segment_start < grapheme_end {
                let segment_end = self.next_style_boundary(segment_start, grapheme_end);
                let coverage_text =
                    replacement.unwrap_or(&self.paragraph.text[segment_start..segment_end]);
                let group = self.select_shape_group(
                    segment_start..segment_end,
                    direction,
                    coverage_text,
                    replacement.is_none(),
                )?;
                push_shape_group(&mut groups, group);
                segment_start = segment_end;
            }
        }
        Ok(groups)
    }

    fn logical_groups_for(&mut self, range: Range<usize>) -> Result<Vec<ShapeGroup>, LayoutError> {
        let slice = &self.paragraph.text[range.clone()];
        let mut groups: Vec<ShapeGroup> = Vec::new();
        for (relative, grapheme) in slice.grapheme_indices(true) {
            let mut segment_start = range.start + relative;
            let grapheme_end = segment_start + grapheme.len();
            let replacement = match grapheme {
                "\t" => Some(" "),
                "\u{00ad}" | "\u{200b}" => Some(""),
                _ => None,
            };
            while segment_start < grapheme_end {
                let segment_end = self.next_style_boundary(segment_start, grapheme_end);
                let direction = if self
                    .bidi
                    .levels
                    .get(segment_start)
                    .is_some_and(unicode_bidi::Level::is_rtl)
                {
                    GlyphDirection::RightToLeft
                } else {
                    GlyphDirection::LeftToRight
                };
                let coverage_text =
                    replacement.unwrap_or(&self.paragraph.text[segment_start..segment_end]);
                let group = self.select_shape_group(
                    segment_start..segment_end,
                    direction,
                    coverage_text,
                    replacement.is_none(),
                )?;
                push_shape_group(&mut groups, group);
                segment_start = segment_end;
            }
        }
        Ok(groups)
    }

    fn select_shape_group(
        &mut self,
        range: Range<usize>,
        direction: GlyphDirection,
        coverage_text: &str,
        mergeable: bool,
    ) -> Result<ShapeGroup, LayoutError> {
        let style = self.style_at(range.start).clone();
        let resolution = self.resolve_candidates(&style)?.clone();
        let mut selected = None;
        for (index, id) in resolution.ids.iter().copied().enumerate() {
            if self
                .engine
                .fonts
                .supports_grapheme_staged(id, coverage_text, &mut self.coverage)?
            {
                selected = Some((id, index));
                break;
            }
        }
        let (font_id, candidate_index, missing_glyph) = match selected {
            Some((id, index)) => (id, index, false),
            None => (
                *resolution
                    .ids
                    .first()
                    .ok_or_else(|| LayoutError::NoFontAvailable {
                        requested_families: style.font_families.clone(),
                    })?,
                0,
                true,
            ),
        };
        let reason = if missing_glyph {
            Some(FontSubstitutionReason::MissingGlyph)
        } else if candidate_index > 0 {
            Some(FontSubstitutionReason::GlyphCoverageFallback)
        } else if resolution.missing_requested_family {
            Some(FontSubstitutionReason::RequestedFamilyUnavailable)
        } else if resolution.style_substitution {
            Some(FontSubstitutionReason::RequestedStyleUnavailable)
        } else {
            None
        };
        Ok(ShapeGroup {
            range,
            font_id,
            style,
            direction,
            reason,
            mergeable,
        })
    }

    fn next_style_boundary(&self, offset: usize, limit: usize) -> usize {
        let index = self
            .paragraph
            .spans
            .partition_point(|span| span.range.start <= offset);
        let mut boundary = limit;
        if index > 0 {
            let previous = &self.paragraph.spans[index - 1];
            if previous.range.contains(&offset) {
                boundary = boundary.min(previous.range.end);
            }
        }
        if index < self.paragraph.spans.len() {
            boundary = boundary.min(self.paragraph.spans[index].range.start);
        }
        // The caller always advances inside a non-empty grapheme. This guard
        // protects against future span-validation regressions.
        if boundary > offset {
            boundary
        } else {
            limit
        }
    }

    fn shape_group(
        &mut self,
        group: &ShapeGroup,
        retain_glyphs: bool,
        mut cluster_advances: Option<&mut BTreeMap<usize, i64>>,
        show_terminal_soft_hyphen: bool,
    ) -> Result<GlyphRun, LayoutError> {
        self.work.shape(group.range.len())?;
        let face = self.engine.fonts.face(group.font_id)?;
        let mut buffer = UnicodeBuffer::new();
        for (relative, character) in self.paragraph.text[group.range.clone()].char_indices() {
            let cluster = u32::try_from(group.range.start + relative)
                .map_err(|_| LayoutError::GlyphClusterOverflow)?;
            match character {
                '\t' => {
                    for _ in 0..self.paragraph.paragraph_style.tab_width_spaces {
                        buffer.add(' ', cluster);
                    }
                }
                '\u{00ad}' if show_terminal_soft_hyphen => buffer.add('-', cluster),
                '\u{00ad}' | '\u{200b}' => {}
                _ => buffer.add(character, cluster),
            }
        }
        buffer.set_direction(match group.direction {
            GlyphDirection::LeftToRight => Direction::LeftToRight,
            GlyphDirection::RightToLeft => Direction::RightToLeft,
        });
        if let Some(script) = group.style.script {
            let script = rustybuzz::Script::from_iso15924_tag(ttf_parser::Tag::from_bytes(&script))
                .ok_or(LayoutError::InvalidTextStyle(
                    "script must be a valid ISO-15924 tag",
                ))?;
            buffer.set_script(script);
        }
        if let Some(language) = &group.style.language {
            buffer.set_language(language.parse().map_err(|_| {
                LayoutError::InvalidTextStyle("language must be a valid OpenType tag")
            })?);
        }
        buffer.guess_segment_properties();
        let features = group
            .style
            .features
            .iter()
            .map(|feature| {
                Feature::new(ttf_parser::Tag::from_bytes(&feature.tag), feature.value, ..)
            })
            .collect::<Vec<_>>();
        let glyph_buffer = rustybuzz::shape(&face, &features, buffer);
        let count = glyph_buffer.glyph_infos().len();
        self.work.glyphs(count)?;
        if count > self.engine.limits.max_glyphs
            || (retain_glyphs
                && self
                    .glyph_count
                    .checked_add(count)
                    .is_none_or(|value| value > self.engine.limits.max_glyphs))
        {
            return Err(LayoutError::LimitExceeded("shaped glyphs"));
        }
        let metadata = self
            .engine
            .fonts
            .get(group.font_id)
            .ok_or(LayoutError::UnknownFont(group.font_id))?;
        let mut glyphs = if retain_glyphs {
            Vec::with_capacity(count)
        } else {
            Vec::new()
        };
        let ascent = scale_metric(
            i32::from(metadata.ascender).max(0),
            group.style.font_size,
            metadata.units_per_em,
        )?;
        let descent = scale_metric(
            i32::from(metadata.descender).saturating_neg().max(0),
            group.style.font_size,
            metadata.units_per_em,
        )?;
        let mut cursor = LayoutUnit::ZERO;
        for (info, position) in glyph_buffer
            .glyph_infos()
            .iter()
            .zip(glyph_buffer.glyph_positions())
        {
            let mut advance = scale_metric(
                position.x_advance.saturating_abs(),
                group.style.font_size,
                metadata.units_per_em,
            )?;
            advance = advance.checked_add(group.style.letter_spacing)?;
            if advance.raw() < 0 {
                advance = LayoutUnit::ZERO;
            }
            if retain_glyphs {
                let x_offset = scale_metric(
                    position.x_offset,
                    group.style.font_size,
                    metadata.units_per_em,
                )?;
                let y_offset = scale_metric(
                    position.y_offset.saturating_neg(),
                    group.style.font_size,
                    metadata.units_per_em,
                )?;
                let ink_bounds = if let Some(bounds) = face.glyph_bounding_box(ttf_parser::GlyphId(
                    u16::try_from(info.glyph_id)
                        .map_err(|_| LayoutError::InvalidFont("glyph id exceeds u16"))?,
                )) {
                    super::GlyphInkBounds {
                        x_min: scale_metric(
                            i32::from(bounds.x_min),
                            group.style.font_size,
                            metadata.units_per_em,
                        )?,
                        y_min: scale_metric(
                            i32::from(bounds.y_max).saturating_neg(),
                            group.style.font_size,
                            metadata.units_per_em,
                        )?,
                        x_max: scale_metric(
                            i32::from(bounds.x_max),
                            group.style.font_size,
                            metadata.units_per_em,
                        )?,
                        y_max: scale_metric(
                            i32::from(bounds.y_min).saturating_neg(),
                            group.style.font_size,
                            metadata.units_per_em,
                        )?,
                    }
                } else {
                    super::GlyphInkBounds {
                        x_min: LayoutUnit::ZERO,
                        y_min: LayoutUnit::from_raw(ascent.raw().saturating_neg()),
                        x_max: advance,
                        y_max: descent,
                    }
                };
                glyphs.push(super::PositionedGlyph {
                    glyph_id: info.glyph_id,
                    cluster: info.cluster,
                    x: cursor.checked_add(x_offset)?,
                    y: y_offset,
                    advance,
                    ink_bounds,
                });
            }
            if let Some(advances) = cluster_advances.as_deref_mut() {
                let cluster =
                    usize::try_from(info.cluster).map_err(|_| LayoutError::GlyphClusterOverflow)?;
                let entry = advances.entry(cluster).or_default();
                *entry = entry
                    .checked_add(i64::from(advance.raw()))
                    .ok_or(LayoutError::CoordinateOverflow)?;
            }
            cursor = cursor.checked_add(advance)?;
        }
        if retain_glyphs {
            self.glyph_count += count;
        }
        Ok(GlyphRun {
            font_id: group.font_id,
            font_asset_hash: metadata.asset_hash,
            text_range: group.range.clone(),
            direction: group.direction,
            font_size: group.style.font_size,
            paint: group.style.paint,
            glyphs,
            advance: cursor,
            ascent,
            descent,
        })
    }

    fn resolve_candidates(
        &mut self,
        style: &TextStyle,
    ) -> Result<&CandidateResolution, LayoutError> {
        if !self.candidates.contains_key(style) {
            let mut ids = Vec::new();
            let mut seen = BTreeSet::new();
            let mut missing_requested_family = false;
            let mut style_substitution = false;
            for family in &style.font_families {
                let family_candidates = self.engine.fonts.candidates_for_family(
                    family,
                    style.weight,
                    style.font_style,
                )?;
                if family_candidates.is_empty() {
                    if ids.is_empty() {
                        missing_requested_family = true;
                    }
                } else if ids.is_empty() {
                    if let Some(metadata) = family_candidates
                        .first()
                        .and_then(|id| self.engine.fonts.get(*id))
                    {
                        style_substitution = metadata.descriptor.style != style.font_style
                            || metadata.descriptor.weight != style.weight;
                    }
                }
                for id in family_candidates {
                    if seen.insert(id) {
                        ids.push(id);
                    }
                }
            }
            for id in &style.fallback_fonts {
                if self.engine.fonts.get(*id).is_none() {
                    return Err(LayoutError::UnknownFont(*id));
                }
                if seen.insert(*id) {
                    ids.push(*id);
                }
            }
            if ids.is_empty() {
                return Err(LayoutError::NoFontAvailable {
                    requested_families: style.font_families.clone(),
                });
            }
            self.candidates.insert(
                style.clone(),
                CandidateResolution {
                    ids,
                    missing_requested_family,
                    style_substitution,
                },
            );
        }
        Ok(self
            .candidates
            .get(style)
            .expect("candidate inserted or already present"))
    }

    fn style_at(&self, offset: usize) -> &TextStyle {
        let index = self
            .paragraph
            .spans
            .partition_point(|span| span.range.start <= offset);
        if index > 0 {
            let span = &self.paragraph.spans[index - 1];
            if span.range.contains(&offset) {
                return &span.style;
            }
        }
        &self.paragraph.default_style
    }

    fn paragraph_for(&self, range: &Range<usize>) -> Result<&ParagraphInfo, LayoutError> {
        self.bidi
            .paragraphs
            .iter()
            .find(|paragraph| {
                paragraph.range.start <= range.start && range.end <= paragraph.range.end
            })
            .ok_or(LayoutError::InvalidSpan(
                "line range crosses a Unicode paragraph boundary",
            ))
    }

    fn direction_for_range(&self, range: &Range<usize>) -> GlyphDirection {
        let level = if range.start < self.bidi.levels.len() {
            self.bidi.levels[range.start]
        } else {
            self.bidi
                .paragraphs
                .last()
                .map(|paragraph| paragraph.level)
                .unwrap_or_else(Level::ltr)
        };
        if level.is_rtl() {
            GlyphDirection::RightToLeft
        } else {
            GlyphDirection::LeftToRight
        }
    }
}

fn push_shape_group(groups: &mut Vec<ShapeGroup>, group: ShapeGroup) {
    if let Some(previous) = groups.last_mut() {
        if previous.mergeable
            && group.mergeable
            && previous.range.end == group.range.start
            && previous.font_id == group.font_id
            && previous.style == group.style
            && previous.direction == group.direction
            && previous.reason == group.reason
        {
            previous.range.end = group.range.end;
            return;
        }
    }
    groups.push(group);
}

fn scale_metric(
    value: i32,
    font_size: LayoutUnit,
    units_per_em: u16,
) -> Result<LayoutUnit, LayoutError> {
    let denominator = i64::from(units_per_em);
    if denominator == 0 {
        return Err(LayoutError::InvalidFont("units-per-em must be positive"));
    }
    let product = i64::from(value)
        .checked_mul(i64::from(font_size.raw()))
        .ok_or(LayoutError::CoordinateOverflow)?;
    let rounded = if product >= 0 {
        (product + denominator / 2) / denominator
    } else {
        (product - denominator / 2) / denominator
    };
    i32::try_from(rounded)
        .map(LayoutUnit::from_raw)
        .map_err(|_| LayoutError::CoordinateOverflow)
}

fn alignment_offset(
    alignment: TextAlignment,
    direction: GlyphDirection,
    available: LayoutUnit,
    advance: LayoutUnit,
) -> Result<LayoutUnit, LayoutError> {
    let remaining = available.checked_sub(advance)?;
    let remaining = LayoutUnit::from_raw(remaining.raw().max(0));
    match alignment {
        TextAlignment::Left => Ok(LayoutUnit::ZERO),
        TextAlignment::Right => Ok(remaining),
        TextAlignment::Center => Ok(LayoutUnit::from_raw(remaining.raw() / 2)),
        TextAlignment::Start => Ok(if direction == GlyphDirection::RightToLeft {
            remaining
        } else {
            LayoutUnit::ZERO
        }),
        TextAlignment::End => Ok(if direction == GlyphDirection::RightToLeft {
            LayoutUnit::ZERO
        } else {
            remaining
        }),
    }
}

fn coalesce_diagnostics(
    mut diagnostics: Vec<FontSubstitutionDiagnostic>,
) -> Vec<FontSubstitutionDiagnostic> {
    diagnostics.sort_by(|left, right| {
        (
            left.text_range.start,
            left.text_range.end,
            &left.requested_families,
            left.resolved_font,
            left.reason,
        )
            .cmp(&(
                right.text_range.start,
                right.text_range.end,
                &right.requested_families,
                right.resolved_font,
                right.reason,
            ))
    });
    let mut output: Vec<FontSubstitutionDiagnostic> = Vec::new();
    for diagnostic in diagnostics {
        if let Some(previous) = output.last_mut() {
            if previous.text_range.end == diagnostic.text_range.start
                && previous.requested_families == diagnostic.requested_families
                && previous.resolved_font == diagnostic.resolved_font
                && previous.reason == diagnostic.reason
            {
                previous.text_range.end = diagnostic.text_range.end;
                continue;
            }
        }
        output.push(diagnostic);
    }
    output
}

fn cache_key(
    engine: &TextLayoutEngine,
    paragraph: &RichTextParagraph,
    constraints: LayoutConstraints,
) -> LayoutCacheKey {
    let mut hash = Sha256::new();
    hash.update(LAYOUT_KEY_DOMAIN);
    hash.update(engine.fonts.generation().to_le_bytes());
    hash.update(
        constraints
            .max_width
            .map(LayoutUnit::raw)
            .unwrap_or(i32::MIN)
            .to_le_bytes(),
    );
    hash.update([paragraph.paragraph_style.direction as u8]);
    hash.update([paragraph.paragraph_style.alignment as u8]);
    hash.update([paragraph.paragraph_style.tab_width_spaces]);
    hash.update(
        paragraph
            .paragraph_style
            .line_height
            .map(LayoutUnit::raw)
            .unwrap_or(i32::MIN)
            .to_le_bytes(),
    );
    hash_len(&mut hash, paragraph.text.len());
    hash.update(paragraph.text.as_bytes());
    hash_style(&mut hash, &paragraph.default_style);
    hash_len(&mut hash, paragraph.spans.len());
    for span in &paragraph.spans {
        hash_len(&mut hash, span.range.start);
        hash_len(&mut hash, span.range.end);
        hash_style(&mut hash, &span.style);
    }
    hash.finalize().into()
}

fn hash_style(hash: &mut Sha256, style: &TextStyle) {
    hash_len(hash, style.font_families.len());
    for family in &style.font_families {
        hash_len(hash, family.len());
        hash.update(family.as_bytes());
    }
    hash_len(hash, style.fallback_fonts.len());
    for font in &style.fallback_fonts {
        hash.update(font.as_bytes());
    }
    hash.update(style.weight.to_le_bytes());
    hash.update([style.font_style as u8]);
    hash.update(style.font_size.raw().to_le_bytes());
    hash.update(style.letter_spacing.raw().to_le_bytes());
    hash_len(hash, style.features.len());
    for feature in &style.features {
        hash.update(feature.tag);
        hash.update(feature.value.to_le_bytes());
    }
    match &style.language {
        Some(language) => {
            hash.update([1]);
            hash_len(hash, language.len());
            hash.update(language.as_bytes());
        }
        None => hash.update([0]),
    }
    match style.script {
        Some(script) => {
            hash.update([1]);
            hash.update(script);
        }
        None => hash.update([0]),
    }
    hash.update(style.paint.rgba.to_le_bytes());
    hash.update([
        u8::from(style.paint.underline),
        u8::from(style.paint.strike),
    ]);
}

fn hash_len(hash: &mut Sha256, value: usize) {
    hash.update(u64::try_from(value).unwrap_or(u64::MAX).to_le_bytes());
}
