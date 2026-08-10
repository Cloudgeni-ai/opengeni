use core::fmt;
use std::collections::BTreeSet;
use std::ops::Range;
use std::sync::Arc;

use crate::text_layout::{
    FontStyle, LayoutConstraints, LayoutError, LayoutUnit, ParagraphLayout,
    ParagraphStyle as LayoutParagraphStyle, RichTextParagraph, TextAlignment, TextLayoutEngine,
    TextPaint, TextSpan, TextStyle as LayoutTextStyle,
};

use super::{
    BlockRef, Document, DocumentError, DocumentId, PageGeometry, Paragraph, ParagraphAlignment,
    Section, TextRange, TextStyle,
};

#[derive(Clone, Debug, PartialEq)]
pub struct DocumentTextDefaults {
    pub font_family: String,
    pub font_size_pt: f64,
    pub rgba: u32,
}

impl Default for DocumentTextDefaults {
    fn default() -> Self {
        Self {
            font_family: "Arial".to_owned(),
            font_size_pt: 11.0,
            rgba: 0x0000_00ff,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DocumentPaginationLimits {
    pub max_pages: usize,
    pub max_fragments: usize,
    pub max_retained_layout_bytes: usize,
}

impl Default for DocumentPaginationLimits {
    fn default() -> Self {
        Self {
            max_pages: 100_000,
            max_fragments: 1_000_000,
            max_retained_layout_bytes: 256 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LayoutPageGeometry {
    pub width: LayoutUnit,
    pub height: LayoutUnit,
    pub margin_top: LayoutUnit,
    pub margin_right: LayoutUnit,
    pub margin_bottom: LayoutUnit,
    pub margin_left: LayoutUnit,
}

impl LayoutPageGeometry {
    fn from_points(value: PageGeometry) -> Result<Self, DocumentTextLayoutError> {
        Ok(Self {
            width: points_to_layout(value.width_pt)?,
            height: points_to_layout(value.height_pt)?,
            margin_top: points_to_layout(value.margin_top_pt)?,
            margin_right: points_to_layout(value.margin_right_pt)?,
            margin_bottom: points_to_layout(value.margin_bottom_pt)?,
            margin_left: points_to_layout(value.margin_left_pt)?,
        })
    }

    fn content_width(self) -> Result<LayoutUnit, DocumentTextLayoutError> {
        self.width
            .checked_sub(self.margin_left)?
            .checked_sub(self.margin_right)
            .map_err(Into::into)
    }

    fn content_bottom(self) -> Result<LayoutUnit, DocumentTextLayoutError> {
        self.height
            .checked_sub(self.margin_bottom)
            .map_err(Into::into)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentParagraphFragment {
    pub paragraph_id: DocumentId,
    pub line_range: Range<usize>,
    pub text_bytes: Range<usize>,
    pub text_utf16: TextRange,
    pub x: LayoutUnit,
    pub y: LayoutUnit,
    /// Translate the paragraph layout by `y - source_top` before painting this
    /// fragment. This preserves the shared layout's exact baselines.
    pub source_top: LayoutUnit,
    pub width: LayoutUnit,
    pub height: LayoutUnit,
    pub space_after: LayoutUnit,
    pub layout: Arc<ParagraphLayout>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentPageLayout {
    pub page_index: usize,
    pub section_id: DocumentId,
    pub geometry: LayoutPageGeometry,
    pub fragments: Vec<DocumentParagraphFragment>,
    /// True only when a single shaped line is taller than the usable page.
    pub overflowed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentPagination {
    pub document_revision: u64,
    pub pages: Vec<DocumentPageLayout>,
    pub line_count: usize,
    pub retained_layout_bytes: usize,
}

impl Document {
    /// Shapes and paginates body paragraphs using the shared deterministic
    /// engine. Tables, list markers and justification fail closed until their
    /// layout algorithms exist; no approximate geometry is presented as final.
    pub fn paginate_text(
        &self,
        engine: &mut TextLayoutEngine,
        defaults: &DocumentTextDefaults,
        limits: DocumentPaginationLimits,
    ) -> Result<DocumentPagination, DocumentTextLayoutError> {
        validate_defaults(defaults)?;
        if limits.max_pages == 0
            || limits.max_fragments == 0
            || limits.max_retained_layout_bytes == 0
        {
            return Err(DocumentTextLayoutError::LimitExceeded(
                "pagination limits must be positive",
            ));
        }
        let mut prepared = Vec::with_capacity(self.body().len());
        let mut retained_layout_bytes = 0usize;
        let mut retained_layouts = BTreeSet::new();
        for (index, block) in self.body().iter().copied().enumerate() {
            let section = self.section_for_body_index(index);
            match block {
                BlockRef::Paragraph(id) => {
                    let paragraph = self.paragraph(id).ok_or(DocumentTextLayoutError::Document(
                        DocumentError::UnknownId(id),
                    ))?;
                    let prepared_paragraph =
                        prepare_paragraph(paragraph, section, engine, defaults)?;
                    retained_layout_bytes = retained_layout_bytes
                        .checked_add(prepared_paragraph.text.len())
                        .ok_or(DocumentTextLayoutError::LimitExceeded(
                            "retained pagination layout bytes",
                        ))?;
                    if retained_layouts.insert(prepared_paragraph.layout.fingerprint) {
                        retained_layout_bytes = retained_layout_bytes
                            .checked_add(prepared_paragraph.layout.estimated_bytes())
                            .ok_or(DocumentTextLayoutError::LimitExceeded(
                                "retained pagination layout bytes",
                            ))?;
                    }
                    if retained_layout_bytes > limits.max_retained_layout_bytes {
                        return Err(DocumentTextLayoutError::LimitExceeded(
                            "retained pagination layout bytes",
                        ));
                    }
                    prepared.push(PreparedBlock::Paragraph(prepared_paragraph));
                }
                BlockRef::PageBreak(_) => prepared.push(PreparedBlock::PageBreak {
                    section_id: section.id,
                    geometry: LayoutPageGeometry::from_points(section.page)?,
                }),
                BlockRef::Table(_) => {
                    return Err(DocumentTextLayoutError::Unsupported("table pagination"));
                }
            }
        }

        if prepared.is_empty() {
            let section = &self.sections()[0];
            return Ok(DocumentPagination {
                document_revision: self.revision(),
                pages: vec![new_page(section.id, section.page, 0)?],
                line_count: 0,
                retained_layout_bytes: 0,
            });
        }

        let mut pages = Vec::new();
        let mut line_count = 0usize;
        let mut fragment_count = 0usize;
        for (block_index, block) in prepared.iter().enumerate() {
            match block {
                PreparedBlock::PageBreak {
                    section_id,
                    geometry,
                } => {
                    ensure_page(&mut pages, *section_id, *geometry, limits)?;
                    push_page(&mut pages, *section_id, *geometry, limits)?;
                }
                PreparedBlock::Paragraph(paragraph) => {
                    ensure_page(&mut pages, paragraph.section_id, paragraph.geometry, limits)?;
                    if pages.last().is_some_and(|page| {
                        page.section_id != paragraph.section_id || paragraph.page_break_before
                    }) {
                        push_page(&mut pages, paragraph.section_id, paragraph.geometry, limits)?;
                    }

                    if paragraph.keep_next {
                        if let Some(PreparedBlock::Paragraph(next)) = prepared.get(block_index + 1)
                        {
                            if next.section_id == paragraph.section_id {
                                let needed = paragraph
                                    .space_before
                                    .checked_add(paragraph.layout.height)?
                                    .checked_add(paragraph.space_after)?
                                    .checked_add(next.space_before)?
                                    .checked_add(
                                        next.layout
                                            .lines
                                            .first()
                                            .map_or(LayoutUnit::ZERO, |line| line.height),
                                    )?;
                                let page = pages.last().expect("page ensured");
                                if !page.fragments.is_empty()
                                    && needed.raw() <= page_usable_height(page)?.raw()
                                    && needed.raw() > page_remaining_height(page)?.raw()
                                {
                                    push_page(
                                        &mut pages,
                                        paragraph.section_id,
                                        paragraph.geometry,
                                        limits,
                                    )?;
                                }
                            }
                        }
                    }
                    paginate_paragraph(
                        paragraph,
                        &mut pages,
                        &mut line_count,
                        &mut fragment_count,
                        limits,
                    )?;
                }
            }
        }
        Ok(DocumentPagination {
            document_revision: self.revision(),
            pages,
            line_count,
            retained_layout_bytes,
        })
    }
}

#[derive(Clone, Debug)]
enum PreparedBlock {
    Paragraph(PreparedParagraph),
    PageBreak {
        section_id: DocumentId,
        geometry: LayoutPageGeometry,
    },
}

#[derive(Clone, Debug)]
struct PreparedParagraph {
    id: DocumentId,
    section_id: DocumentId,
    geometry: LayoutPageGeometry,
    text: String,
    layout: Arc<ParagraphLayout>,
    space_before: LayoutUnit,
    space_after: LayoutUnit,
    keep_next: bool,
    page_break_before: bool,
}

fn prepare_paragraph(
    paragraph: &Paragraph,
    section: &Section,
    engine: &mut TextLayoutEngine,
    defaults: &DocumentTextDefaults,
) -> Result<PreparedParagraph, DocumentTextLayoutError> {
    if paragraph.style.list.is_some() {
        return Err(DocumentTextLayoutError::Unsupported("list marker layout"));
    }
    let geometry = LayoutPageGeometry::from_points(section.page)?;
    let input = paragraph_to_layout(paragraph, defaults)?;
    let layout = engine.layout(
        &input,
        LayoutConstraints {
            max_width: Some(geometry.content_width()?),
        },
    )?;
    Ok(PreparedParagraph {
        id: paragraph.id,
        section_id: section.id,
        geometry,
        text: input.text,
        layout,
        space_before: points_to_layout(paragraph.style.space_before_pt.unwrap_or(0.0))?,
        space_after: points_to_layout(paragraph.style.space_after_pt.unwrap_or(0.0))?,
        keep_next: paragraph.style.keep_next.unwrap_or(false),
        page_break_before: paragraph.style.page_break_before.unwrap_or(false),
    })
}

fn paragraph_to_layout(
    paragraph: &Paragraph,
    defaults: &DocumentTextDefaults,
) -> Result<RichTextParagraph, DocumentTextLayoutError> {
    let default_style = document_style_to_layout(&TextStyle::default(), defaults)?;
    let mut text = String::new();
    let mut spans = Vec::new();
    let mut largest_font = default_style.font_size;
    for run in &paragraph.runs {
        let start = text.len();
        text.push_str(&run.text);
        let end = text.len();
        let style = document_style_to_layout(&run.style, defaults)?;
        largest_font = largest_font.max(style.font_size);
        if start != end && style != default_style {
            spans.push(TextSpan {
                range: start..end,
                style,
            });
        }
    }
    let alignment = match paragraph
        .style
        .alignment
        .unwrap_or(ParagraphAlignment::Left)
    {
        ParagraphAlignment::Left => TextAlignment::Left,
        ParagraphAlignment::Center => TextAlignment::Center,
        ParagraphAlignment::Right => TextAlignment::Right,
        ParagraphAlignment::Justify => {
            return Err(DocumentTextLayoutError::Unsupported(
                "justified document text",
            ));
        }
    };
    let line_height = paragraph
        .style
        .line_height
        .map(|multiplier| scale_layout(largest_font, multiplier))
        .transpose()?;
    Ok(RichTextParagraph {
        text,
        default_style,
        spans,
        paragraph_style: LayoutParagraphStyle {
            alignment,
            line_height,
            ..LayoutParagraphStyle::default()
        },
    })
}

fn document_style_to_layout(
    style: &TextStyle,
    defaults: &DocumentTextDefaults,
) -> Result<LayoutTextStyle, DocumentTextLayoutError> {
    let font_size = points_to_layout(style.font_size_pt.unwrap_or(defaults.font_size_pt))?;
    let mut output = LayoutTextStyle::new(
        style
            .font_family
            .as_deref()
            .unwrap_or(&defaults.font_family),
        font_size,
    );
    output.weight = if style.bold.unwrap_or(false) {
        700
    } else {
        400
    };
    output.font_style = if style.italic.unwrap_or(false) {
        FontStyle::Italic
    } else {
        FontStyle::Normal
    };
    output.paint = TextPaint {
        rgba: style
            .color
            .as_deref()
            .map(parse_rgba)
            .transpose()?
            .unwrap_or(defaults.rgba),
        underline: style.underline.unwrap_or(false),
        strike: style.strike.unwrap_or(false),
    };
    Ok(output)
}

fn paginate_paragraph(
    paragraph: &PreparedParagraph,
    pages: &mut Vec<DocumentPageLayout>,
    line_count: &mut usize,
    fragment_count: &mut usize,
    limits: DocumentPaginationLimits,
) -> Result<(), DocumentTextLayoutError> {
    let mut next_line = 0usize;
    let utf16_index = Utf16Index::new(&paragraph.text);
    while next_line < paragraph.layout.lines.len() {
        let page = pages.last_mut().expect("page ensured");
        let at_paragraph_start = next_line == 0;
        let spacing = if at_paragraph_start {
            paragraph.space_before
        } else {
            LayoutUnit::ZERO
        };
        let first_height = paragraph.layout.lines[next_line].height;
        if !page.fragments.is_empty()
            && spacing.checked_add(first_height)?.raw() > page_remaining_height(page)?.raw()
        {
            push_page(pages, paragraph.section_id, paragraph.geometry, limits)?;
            continue;
        }
        let page = pages.last_mut().expect("page created");
        let y = page_cursor(page)?.checked_add(spacing)?;
        let start_line = next_line;
        let mut fragment_height = LayoutUnit::ZERO;
        while next_line < paragraph.layout.lines.len() {
            let line = &paragraph.layout.lines[next_line];
            let bottom = y.checked_add(fragment_height)?.checked_add(line.height)?;
            if next_line > start_line && bottom.raw() > page.geometry.content_bottom()?.raw() {
                break;
            }
            if next_line == start_line && bottom.raw() > page.geometry.content_bottom()?.raw() {
                page.overflowed = true;
            }
            fragment_height = fragment_height.checked_add(line.height)?;
            next_line += 1;
            if bottom.raw() >= page.geometry.content_bottom()?.raw() {
                break;
            }
        }
        let lines = &paragraph.layout.lines[start_line..next_line];
        let text_start = lines.first().expect("non-empty fragment").text_range.start;
        let text_end = lines.last().expect("non-empty fragment").text_range.end;
        let source_top = lines.first().expect("non-empty fragment").top;
        *fragment_count = fragment_count
            .checked_add(1)
            .ok_or(DocumentTextLayoutError::LimitExceeded("page fragments"))?;
        if *fragment_count > limits.max_fragments {
            return Err(DocumentTextLayoutError::LimitExceeded("page fragments"));
        }
        *line_count = line_count
            .checked_add(next_line - start_line)
            .ok_or(DocumentTextLayoutError::LimitExceeded("paginated lines"))?;
        page.fragments.push(DocumentParagraphFragment {
            paragraph_id: paragraph.id,
            line_range: start_line..next_line,
            text_bytes: text_start..text_end,
            text_utf16: TextRange::new(utf16_index.at(text_start)?, utf16_index.at(text_end)?)?,
            x: page.geometry.margin_left,
            y,
            source_top,
            width: paragraph.layout.width,
            height: fragment_height,
            space_after: if next_line == paragraph.layout.lines.len() {
                paragraph.space_after
            } else {
                LayoutUnit::ZERO
            },
            layout: Arc::clone(&paragraph.layout),
        });
        if next_line != paragraph.layout.lines.len() {
            push_page(pages, paragraph.section_id, paragraph.geometry, limits)?;
        }
    }
    Ok(())
}

fn ensure_page(
    pages: &mut Vec<DocumentPageLayout>,
    section_id: DocumentId,
    geometry: LayoutPageGeometry,
    limits: DocumentPaginationLimits,
) -> Result<(), DocumentTextLayoutError> {
    if pages.is_empty() {
        push_page(pages, section_id, geometry, limits)?;
    }
    Ok(())
}

fn push_page(
    pages: &mut Vec<DocumentPageLayout>,
    section_id: DocumentId,
    geometry: LayoutPageGeometry,
    limits: DocumentPaginationLimits,
) -> Result<(), DocumentTextLayoutError> {
    if pages.len() >= limits.max_pages {
        return Err(DocumentTextLayoutError::LimitExceeded("document pages"));
    }
    pages.push(DocumentPageLayout {
        page_index: pages.len(),
        section_id,
        geometry,
        fragments: Vec::new(),
        overflowed: false,
    });
    Ok(())
}

fn new_page(
    section_id: DocumentId,
    page: PageGeometry,
    page_index: usize,
) -> Result<DocumentPageLayout, DocumentTextLayoutError> {
    Ok(DocumentPageLayout {
        page_index,
        section_id,
        geometry: LayoutPageGeometry::from_points(page)?,
        fragments: Vec::new(),
        overflowed: false,
    })
}

fn page_cursor(page: &DocumentPageLayout) -> Result<LayoutUnit, DocumentTextLayoutError> {
    page.fragments
        .last()
        .map_or(Ok(page.geometry.margin_top), |fragment| {
            fragment
                .y
                .checked_add(fragment.height)?
                .checked_add(fragment.space_after)
                .map_err(Into::into)
        })
}

fn page_remaining_height(page: &DocumentPageLayout) -> Result<LayoutUnit, DocumentTextLayoutError> {
    page.geometry
        .content_bottom()?
        .checked_sub(page_cursor(page)?)
        .map_err(Into::into)
}

fn page_usable_height(page: &DocumentPageLayout) -> Result<LayoutUnit, DocumentTextLayoutError> {
    page.geometry
        .content_bottom()?
        .checked_sub(page.geometry.margin_top)
        .map_err(Into::into)
}

struct Utf16Index(Vec<(usize, u32)>);

impl Utf16Index {
    fn new(text: &str) -> Self {
        let mut values = Vec::with_capacity(text.chars().count() + 1);
        let mut utf16 = 0u32;
        values.push((0, 0));
        for (offset, character) in text.char_indices() {
            utf16 += character.len_utf16() as u32;
            values.push((offset + character.len_utf8(), utf16));
        }
        Self(values)
    }

    fn at(&self, byte: usize) -> Result<u32, DocumentTextLayoutError> {
        self.0
            .binary_search_by_key(&byte, |(offset, _)| *offset)
            .ok()
            .map(|index| self.0[index].1)
            .ok_or(DocumentTextLayoutError::InvalidAnchor)
    }
}

fn points_to_layout(points: f64) -> Result<LayoutUnit, DocumentTextLayoutError> {
    if !points.is_finite() || points < 0.0 {
        return Err(DocumentTextLayoutError::InvalidGeometry);
    }
    let raw = (points * 256.0 / 3.0).round();
    if raw > f64::from(i32::MAX) {
        return Err(DocumentTextLayoutError::InvalidGeometry);
    }
    Ok(LayoutUnit::from_raw(raw as i32))
}

fn scale_layout(value: LayoutUnit, multiplier: f64) -> Result<LayoutUnit, DocumentTextLayoutError> {
    if !multiplier.is_finite() || multiplier <= 0.0 {
        return Err(DocumentTextLayoutError::InvalidGeometry);
    }
    let raw = (f64::from(value.raw()) * multiplier).round();
    if raw <= 0.0 || raw > f64::from(i32::MAX) {
        return Err(DocumentTextLayoutError::InvalidGeometry);
    }
    Ok(LayoutUnit::from_raw(raw as i32))
}

fn parse_rgba(value: &str) -> Result<u32, DocumentTextLayoutError> {
    let digits = value.strip_prefix('#').unwrap_or(value);
    match digits.len() {
        6 => u32::from_str_radix(digits, 16)
            .map(|rgb| (rgb << 8) | 0xff)
            .map_err(|_| DocumentTextLayoutError::InvalidColor),
        8 => u32::from_str_radix(digits, 16).map_err(|_| DocumentTextLayoutError::InvalidColor),
        _ => Err(DocumentTextLayoutError::InvalidColor),
    }
}

fn validate_defaults(defaults: &DocumentTextDefaults) -> Result<(), DocumentTextLayoutError> {
    if defaults.font_family.trim().is_empty() || defaults.font_family.len() > 256 {
        return Err(DocumentTextLayoutError::InvalidDefaults);
    }
    if points_to_layout(defaults.font_size_pt)?.raw() <= 0 {
        return Err(DocumentTextLayoutError::InvalidDefaults);
    }
    Ok(())
}

#[derive(Debug)]
pub enum DocumentTextLayoutError {
    Unsupported(&'static str),
    LimitExceeded(&'static str),
    InvalidDefaults,
    InvalidGeometry,
    InvalidColor,
    InvalidAnchor,
    Document(DocumentError),
    Layout(LayoutError),
}

impl fmt::Display for DocumentTextLayoutError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported(value) => write!(formatter, "unsupported document layout: {value}"),
            Self::LimitExceeded(value) => write!(formatter, "document layout limit: {value}"),
            Self::InvalidDefaults => formatter.write_str("invalid document text defaults"),
            Self::InvalidGeometry => formatter.write_str("invalid document layout geometry"),
            Self::InvalidColor => formatter.write_str("invalid document text color"),
            Self::InvalidAnchor => formatter.write_str("invalid document text anchor"),
            Self::Document(error) => error.fmt(formatter),
            Self::Layout(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for DocumentTextLayoutError {}

impl From<DocumentError> for DocumentTextLayoutError {
    fn from(value: DocumentError) -> Self {
        Self::Document(value)
    }
}

impl From<LayoutError> for DocumentTextLayoutError {
    fn from(value: LayoutError) -> Self {
        Self::Layout(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::{
        DocumentBatch, DocumentCommand, DocumentIdKind, ParagraphStyle, StoryTarget, TextRun,
    };
    use crate::text_layout::{tests::test_font, FontDescriptor, FontRegistry, LayoutLimits};

    const NS: u64 = 0x0102_0304_0506_0708;

    #[test]
    fn pagination_splits_only_at_lines_and_keeps_utf16_anchors() {
        let mut document = Document::new(NS).expect("document");
        let paragraph_id = DocumentId::new(DocumentIdKind::Paragraph, NS, 8).expect("id");
        let text = format!("{}👩‍🚀 end", "a ".repeat(3_000));
        document
            .apply_batch(&DocumentBatch::from_commands(vec![
                DocumentCommand::AddParagraph {
                    target: StoryTarget::Body,
                    id: paragraph_id,
                    runs: vec![TextRun::plain(text.clone())],
                    style: ParagraphStyle::default(),
                },
            ]))
            .expect("paragraph");

        let limits = LayoutLimits::default();
        let mut fonts = FontRegistry::new(limits);
        fonts
            .register(
                test_font("a 👩🚀end", 600),
                0,
                FontDescriptor::new("Fixture"),
            )
            .expect("font");
        let mut engine = TextLayoutEngine::new(fonts, limits);
        let pagination = document
            .paginate_text(
                &mut engine,
                &DocumentTextDefaults {
                    font_family: "Fixture".into(),
                    ..DocumentTextDefaults::default()
                },
                DocumentPaginationLimits::default(),
            )
            .expect("pagination");
        assert!(pagination.pages.len() >= 2);
        assert!(pagination.retained_layout_bytes > 0);
        let fragments = pagination
            .pages
            .iter()
            .flat_map(|page| &page.fragments)
            .collect::<Vec<_>>();
        assert_eq!(fragments.first().expect("first").text_bytes.start, 0);
        assert_eq!(fragments.last().expect("last").text_bytes.end, text.len());
        assert_eq!(
            fragments.last().expect("last").text_utf16.end as usize,
            text.encode_utf16().count()
        );
        for pair in fragments.windows(2) {
            assert_eq!(pair[0].text_bytes.end, pair[1].text_bytes.start);
            assert_eq!(pair[0].text_utf16.end, pair[1].text_utf16.start);
        }
        assert!(matches!(
            document.paginate_text(
                &mut engine,
                &DocumentTextDefaults {
                    font_family: "Fixture".into(),
                    ..DocumentTextDefaults::default()
                },
                DocumentPaginationLimits {
                    max_retained_layout_bytes: pagination.retained_layout_bytes - 1,
                    ..DocumentPaginationLimits::default()
                },
            ),
            Err(DocumentTextLayoutError::LimitExceeded(
                "retained pagination layout bytes"
            ))
        ));
    }

    #[test]
    fn unsupported_structures_fail_closed() {
        let mut document = Document::new(NS).expect("document");
        let table_id = DocumentId::new(DocumentIdKind::Table, NS, 8).expect("id");
        document
            .apply_batch(&DocumentBatch::from_commands(vec![
                DocumentCommand::AddTable {
                    target: StoryTarget::Body,
                    id: table_id,
                    rows: vec![vec![vec![TextRun::plain("cell")]]],
                    style: Default::default(),
                },
            ]))
            .expect("table");
        let limits = LayoutLimits::default();
        let mut engine = TextLayoutEngine::new(FontRegistry::new(limits), limits);
        assert!(matches!(
            document.paginate_text(
                &mut engine,
                &DocumentTextDefaults::default(),
                DocumentPaginationLimits::default(),
            ),
            Err(DocumentTextLayoutError::Unsupported("table pagination"))
        ));
    }
}
