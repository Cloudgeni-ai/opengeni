use core::fmt;

use super::model::{utf16_len, BlockRef, CommentThread, Document, Paragraph, Table, TrackedChange};
use super::types::{DocumentId, PageGeometry, StoryKind, StoryTarget, StoryVariant};

pub const MAX_QUERY_ITEMS: usize = 4_096;
pub const MAX_QUERY_TEXT_UTF16: usize = 1_000_000;
pub const MAX_QUERY_TABLE_CELLS: usize = 100_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DocumentQueryLimits {
    pub max_items: usize,
    pub max_text_utf16: usize,
    pub max_table_cells: usize,
}

impl Default for DocumentQueryLimits {
    fn default() -> Self {
        Self {
            max_items: 256,
            max_text_utf16: 100_000,
            max_table_cells: 10_000,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DocumentQuery {
    Summary,
    Body {
        start_block: usize,
        limits: DocumentQueryLimits,
    },
    Story {
        section_id: DocumentId,
        kind: StoryKind,
        variant: StoryVariant,
        start_block: usize,
        limits: DocumentQueryLimits,
    },
    Sections {
        start_section: usize,
        limits: DocumentQueryLimits,
    },
    Review {
        start_item: usize,
        limits: DocumentQueryLimits,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentSummaryProjection {
    pub id_namespace: u64,
    pub revision: u64,
    pub next_id_counter: u64,
    pub block_count: usize,
    pub section_count: usize,
    pub comment_count: usize,
    pub tracked_change_count: usize,
    pub even_and_odd_headers: bool,
    pub track_revisions: bool,
    pub page: PageGeometryProjection,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PageGeometryProjection {
    pub width_millipoints: i64,
    pub height_millipoints: i64,
    pub margin_top_millipoints: i64,
    pub margin_right_millipoints: i64,
    pub margin_bottom_millipoints: i64,
    pub margin_left_millipoints: i64,
    pub header_millipoints: i64,
    pub footer_millipoints: i64,
    pub gutter_millipoints: i64,
}

impl From<PageGeometry> for PageGeometryProjection {
    fn from(page: PageGeometry) -> Self {
        let fixed = |value: f64| (value * 1_000.0).round() as i64;
        Self {
            width_millipoints: fixed(page.width_pt),
            height_millipoints: fixed(page.height_pt),
            margin_top_millipoints: fixed(page.margin_top_pt),
            margin_right_millipoints: fixed(page.margin_right_pt),
            margin_bottom_millipoints: fixed(page.margin_bottom_pt),
            margin_left_millipoints: fixed(page.margin_left_pt),
            header_millipoints: fixed(page.header_pt),
            footer_millipoints: fixed(page.footer_pt),
            gutter_millipoints: fixed(page.gutter_pt),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SectionProjection {
    pub id: DocumentId,
    pub start_block_index: usize,
    pub title_page: bool,
    pub page: PageGeometryProjection,
    pub header_block_counts: [usize; 3],
    pub footer_block_counts: [usize; 3],
}

#[derive(Clone, Debug, PartialEq)]
pub enum ReviewItem {
    Comment(CommentThread),
    TrackedChange(TrackedChange),
}

#[derive(Clone, Debug, PartialEq)]
pub enum DocumentProjectionItem {
    Summary(DocumentSummaryProjection),
    Section(SectionProjection),
    Paragraph(Paragraph),
    Table(Table),
    PageBreak(DocumentId),
    Review(ReviewItem),
}

#[derive(Clone, Debug, PartialEq)]
pub struct DocumentProjection {
    pub revision: u64,
    pub items: Vec<DocumentProjectionItem>,
    pub next_cursor: Option<usize>,
    pub truncated: bool,
    pub projected_text_utf16: usize,
    pub projected_table_cells: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DocumentQueryError {
    InvalidLimits,
    UnknownSection(DocumentId),
    CursorOutOfBounds,
    FirstItemExceedsLimits,
    InconsistentModel,
}

impl fmt::Display for DocumentQueryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidLimits => formatter.write_str("invalid document query limits"),
            Self::UnknownSection(id) => write!(formatter, "unknown document section {id}"),
            Self::CursorOutOfBounds => {
                formatter.write_str("document query cursor is out of bounds")
            }
            Self::FirstItemExceedsLimits => {
                formatter.write_str("first complete document item exceeds query limits")
            }
            Self::InconsistentModel => {
                formatter.write_str("document query found inconsistent model state")
            }
        }
    }
}

impl std::error::Error for DocumentQueryError {}

impl Document {
    pub fn query(&self, query: DocumentQuery) -> Result<DocumentProjection, DocumentQueryError> {
        match query {
            DocumentQuery::Summary => Ok(DocumentProjection {
                revision: self.revision,
                items: vec![DocumentProjectionItem::Summary(DocumentSummaryProjection {
                    id_namespace: self.id_namespace,
                    revision: self.revision,
                    next_id_counter: self.next_id,
                    block_count: self.totals.blocks,
                    section_count: self.sections.len(),
                    comment_count: self.comments.len(),
                    tracked_change_count: self.changes.len(),
                    even_and_odd_headers: self.even_and_odd_headers(),
                    track_revisions: self.track_revisions(),
                    page: self.page().into(),
                })],
                next_cursor: None,
                truncated: false,
                projected_text_utf16: 0,
                projected_table_cells: 0,
            }),
            DocumentQuery::Body {
                start_block,
                limits,
            } => {
                validate_limits(limits)?;
                self.project_blocks(&self.body, start_block, limits)
            }
            DocumentQuery::Story {
                section_id,
                kind,
                variant,
                start_block,
                limits,
            } => {
                validate_limits(limits)?;
                let blocks = self
                    .target_blocks(StoryTarget::Section {
                        section_id,
                        kind,
                        variant,
                    })
                    .map_err(|_| DocumentQueryError::UnknownSection(section_id))?;
                self.project_blocks(blocks, start_block, limits)
            }
            DocumentQuery::Sections {
                start_section,
                limits,
            } => {
                validate_limits(limits)?;
                if start_section > self.sections.len() {
                    return Err(DocumentQueryError::CursorOutOfBounds);
                }
                let end = self
                    .sections
                    .len()
                    .min(start_section.saturating_add(limits.max_items));
                let items = self.sections[start_section..end]
                    .iter()
                    .map(|section| {
                        DocumentProjectionItem::Section(SectionProjection {
                            id: section.id,
                            start_block_index: section.start_block_index,
                            title_page: section.effective_title_page(),
                            page: section.page.into(),
                            header_block_counts: [
                                section.headers.default.blocks.len(),
                                section.headers.first.blocks.len(),
                                section.headers.even.blocks.len(),
                            ],
                            footer_block_counts: [
                                section.footers.default.blocks.len(),
                                section.footers.first.blocks.len(),
                                section.footers.even.blocks.len(),
                            ],
                        })
                    })
                    .collect();
                Ok(projection(
                    self.revision,
                    items,
                    end,
                    self.sections.len(),
                    0,
                    0,
                ))
            }
            DocumentQuery::Review { start_item, limits } => {
                validate_limits(limits)?;
                let total = self.comment_order.len() + self.change_order.len();
                if start_item > total {
                    return Err(DocumentQueryError::CursorOutOfBounds);
                }
                let mut items = Vec::new();
                let mut text = 0_usize;
                let mut cursor = start_item;
                while cursor < total && items.len() < limits.max_items {
                    let item = if cursor < self.comment_order.len() {
                        let id = self.comment_order[cursor];
                        let comment = self
                            .comments
                            .get(&id)
                            .ok_or(DocumentQueryError::InconsistentModel)?;
                        let item_text = comment
                            .replies
                            .iter()
                            .map(|reply| {
                                utf16_len(&reply.author)
                                    + utf16_len(&reply.text)
                                    + utf16_len(&reply.created_at)
                            })
                            .sum::<usize>();
                        if text.saturating_add(item_text) > limits.max_text_utf16 {
                            if items.is_empty() {
                                return Err(DocumentQueryError::FirstItemExceedsLimits);
                            }
                            break;
                        }
                        text += item_text;
                        ReviewItem::Comment(comment.clone())
                    } else {
                        let id = self.change_order[cursor - self.comment_order.len()];
                        let change = self
                            .changes
                            .get(&id)
                            .ok_or(DocumentQueryError::InconsistentModel)?;
                        let item_text = utf16_len(&change.author) + utf16_len(&change.created_at);
                        if text.saturating_add(item_text) > limits.max_text_utf16 {
                            if items.is_empty() {
                                return Err(DocumentQueryError::FirstItemExceedsLimits);
                            }
                            break;
                        }
                        text += item_text;
                        ReviewItem::TrackedChange(change.clone())
                    };
                    items.push(DocumentProjectionItem::Review(item));
                    cursor += 1;
                }
                Ok(projection(self.revision, items, cursor, total, text, 0))
            }
        }
    }

    fn project_blocks(
        &self,
        blocks: &[BlockRef],
        start: usize,
        limits: DocumentQueryLimits,
    ) -> Result<DocumentProjection, DocumentQueryError> {
        if start > blocks.len() {
            return Err(DocumentQueryError::CursorOutOfBounds);
        }
        let mut items = Vec::new();
        let mut text = 0_usize;
        let mut cells = 0_usize;
        let mut cursor = start;
        while cursor < blocks.len() && items.len() < limits.max_items {
            let (item, item_text, item_cells) = match blocks[cursor] {
                BlockRef::Paragraph(id) => {
                    let paragraph = self
                        .paragraphs
                        .get(&id)
                        .ok_or(DocumentQueryError::InconsistentModel)?;
                    (
                        DocumentProjectionItem::Paragraph(paragraph.clone()),
                        paragraph.text_utf16_len(),
                        0,
                    )
                }
                BlockRef::Table(id) => {
                    let table = self
                        .tables
                        .get(&id)
                        .ok_or(DocumentQueryError::InconsistentModel)?;
                    let item_text = table
                        .rows
                        .iter()
                        .flat_map(|row| row.iter())
                        .flat_map(|cell| cell.iter())
                        .map(|run| utf16_len(&run.text))
                        .sum();
                    let item_cells = table.rows.iter().map(Vec::len).sum();
                    (
                        DocumentProjectionItem::Table(table.clone()),
                        item_text,
                        item_cells,
                    )
                }
                BlockRef::PageBreak(id) => (DocumentProjectionItem::PageBreak(id), 0, 0),
            };
            if text.saturating_add(item_text) > limits.max_text_utf16
                || cells.saturating_add(item_cells) > limits.max_table_cells
            {
                if items.is_empty() {
                    return Err(DocumentQueryError::FirstItemExceedsLimits);
                }
                break;
            }
            text += item_text;
            cells += item_cells;
            items.push(item);
            cursor += 1;
        }
        Ok(projection(
            self.revision,
            items,
            cursor,
            blocks.len(),
            text,
            cells,
        ))
    }
}

fn validate_limits(limits: DocumentQueryLimits) -> Result<(), DocumentQueryError> {
    if limits.max_items == 0
        || limits.max_items > MAX_QUERY_ITEMS
        || limits.max_text_utf16 == 0
        || limits.max_text_utf16 > MAX_QUERY_TEXT_UTF16
        || limits.max_table_cells == 0
        || limits.max_table_cells > MAX_QUERY_TABLE_CELLS
    {
        return Err(DocumentQueryError::InvalidLimits);
    }
    Ok(())
}

fn projection(
    revision: u64,
    items: Vec<DocumentProjectionItem>,
    cursor: usize,
    total: usize,
    text: usize,
    cells: usize,
) -> DocumentProjection {
    let truncated = cursor < total;
    DocumentProjection {
        revision,
        items,
        next_cursor: truncated.then_some(cursor),
        truncated,
        projected_text_utf16: text,
        projected_table_cells: cells,
    }
}
