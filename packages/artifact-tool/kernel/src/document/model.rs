use std::collections::{BTreeMap, BTreeSet};

use super::types::{
    CommentReply, DocumentError, DocumentId, DocumentIdKind, ListStyle, PageGeometry,
    ParagraphStyle, StoryKind, StoryTarget, StoryVariant, TableStyle, TextRange, TextRun,
    TextStyle, TrackedChangeKind, MAX_COMMENTS, MAX_COMMENT_REPLIES, MAX_DOCUMENT_BLOCKS,
    MAX_DOCUMENT_SECTIONS, MAX_STRUCTURAL_COUNTER, MAX_TABLE_CELLS, MAX_TEXT_RUNS, MAX_TEXT_UTF16,
    MAX_TRACKED_CHANGES,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BlockRef {
    Paragraph(DocumentId),
    Table(DocumentId),
    PageBreak(DocumentId),
}

impl BlockRef {
    #[must_use]
    pub const fn id(self) -> DocumentId {
        match self {
            Self::Paragraph(id) | Self::Table(id) | Self::PageBreak(id) => id,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Paragraph {
    pub id: DocumentId,
    pub runs: Vec<TextRun>,
    pub style: ParagraphStyle,
}

impl Paragraph {
    #[must_use]
    pub fn text(&self) -> String {
        let mut text = String::with_capacity(self.runs.iter().map(|run| run.text.len()).sum());
        for run in &self.runs {
            text.push_str(&run.text);
        }
        text
    }

    #[must_use]
    pub fn text_utf16_len(&self) -> usize {
        self.runs.iter().map(|run| utf16_len(&run.text)).sum()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Table {
    pub id: DocumentId,
    pub rows: Vec<Vec<Vec<TextRun>>>,
    pub style: TableStyle,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Story {
    pub id: DocumentId,
    pub blocks: Vec<BlockRef>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SectionStories {
    pub default: Story,
    pub first: Story,
    pub even: Story,
}

impl SectionStories {
    pub(crate) fn get(&self, variant: StoryVariant) -> &Story {
        match variant {
            StoryVariant::Default => &self.default,
            StoryVariant::First => &self.first,
            StoryVariant::Even => &self.even,
        }
    }

    pub(crate) fn get_mut(&mut self, variant: StoryVariant) -> &mut Story {
        match variant {
            StoryVariant::Default => &mut self.default,
            StoryVariant::First => &mut self.first,
            StoryVariant::Even => &mut self.even,
        }
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = &Story> {
        [&self.default, &self.first, &self.even].into_iter()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Section {
    pub id: DocumentId,
    pub start_block_index: usize,
    pub title_page: Option<bool>,
    pub page: PageGeometry,
    pub headers: SectionStories,
    pub footers: SectionStories,
}

impl Section {
    #[must_use]
    pub fn effective_title_page(&self) -> bool {
        self.title_page.unwrap_or(
            !self.headers.first.blocks.is_empty() || !self.footers.first.blocks.is_empty(),
        )
    }

    pub(crate) fn story(&self, kind: StoryKind, variant: StoryVariant) -> &Story {
        match kind {
            StoryKind::Header => self.headers.get(variant),
            StoryKind::Footer => self.footers.get(variant),
        }
    }

    pub(crate) fn story_mut(&mut self, kind: StoryKind, variant: StoryVariant) -> &mut Story {
        match kind {
            StoryKind::Header => self.headers.get_mut(variant),
            StoryKind::Footer => self.footers.get_mut(variant),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CommentThread {
    pub id: DocumentId,
    pub block_id: DocumentId,
    pub range: TextRange,
    pub resolved: bool,
    pub replies: Vec<CommentReply>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TrackedChange {
    pub id: DocumentId,
    pub block_id: DocumentId,
    pub kind: TrackedChangeKind,
    pub range: TextRange,
    pub author: String,
    pub created_at: String,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct ModelTotals {
    pub blocks: usize,
    pub runs: usize,
    pub text_utf16: usize,
    pub table_cells: usize,
    pub replies: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Document {
    pub(crate) id_namespace: u64,
    pub(crate) next_id: u64,
    pub(crate) revision: u64,
    pub(crate) explicit_even_and_odd_headers: Option<bool>,
    pub(crate) explicit_track_revisions: Option<bool>,
    pub(crate) body: Vec<BlockRef>,
    pub(crate) sections: Vec<Section>,
    pub(crate) paragraphs: BTreeMap<DocumentId, Paragraph>,
    pub(crate) tables: BTreeMap<DocumentId, Table>,
    pub(crate) page_breaks: BTreeSet<DocumentId>,
    pub(crate) comment_order: Vec<DocumentId>,
    pub(crate) comments: BTreeMap<DocumentId, CommentThread>,
    pub(crate) change_order: Vec<DocumentId>,
    pub(crate) changes: BTreeMap<DocumentId, TrackedChange>,
    pub(crate) totals: ModelTotals,
}

impl Document {
    pub fn new(id_namespace: u64) -> Result<Self, DocumentError> {
        let section_id = DocumentId::new(DocumentIdKind::Section, id_namespace, 1)?;
        let headers = SectionStories {
            default: Story {
                id: DocumentId::new(DocumentIdKind::Header, id_namespace, 2)?,
                blocks: Vec::new(),
            },
            first: Story {
                id: DocumentId::new(DocumentIdKind::Header, id_namespace, 3)?,
                blocks: Vec::new(),
            },
            even: Story {
                id: DocumentId::new(DocumentIdKind::Header, id_namespace, 4)?,
                blocks: Vec::new(),
            },
        };
        let footers = SectionStories {
            default: Story {
                id: DocumentId::new(DocumentIdKind::Footer, id_namespace, 5)?,
                blocks: Vec::new(),
            },
            first: Story {
                id: DocumentId::new(DocumentIdKind::Footer, id_namespace, 6)?,
                blocks: Vec::new(),
            },
            even: Story {
                id: DocumentId::new(DocumentIdKind::Footer, id_namespace, 7)?,
                blocks: Vec::new(),
            },
        };
        Ok(Self {
            id_namespace,
            next_id: 8,
            revision: 0,
            explicit_even_and_odd_headers: None,
            explicit_track_revisions: None,
            body: Vec::new(),
            sections: vec![Section {
                id: section_id,
                start_block_index: 0,
                title_page: None,
                page: PageGeometry::default(),
                headers,
                footers,
            }],
            paragraphs: BTreeMap::new(),
            tables: BTreeMap::new(),
            page_breaks: BTreeSet::new(),
            comment_order: Vec::new(),
            comments: BTreeMap::new(),
            change_order: Vec::new(),
            changes: BTreeMap::new(),
            totals: ModelTotals::default(),
        })
    }

    #[must_use]
    pub const fn id_namespace(&self) -> u64 {
        self.id_namespace
    }

    #[must_use]
    pub const fn next_id_counter(&self) -> u64 {
        self.next_id
    }

    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }

    #[must_use]
    pub fn page(&self) -> PageGeometry {
        self.sections[0].page
    }

    #[must_use]
    pub fn body(&self) -> &[BlockRef] {
        &self.body
    }

    #[must_use]
    pub fn sections(&self) -> &[Section] {
        &self.sections
    }

    pub fn comments(&self) -> impl Iterator<Item = &CommentThread> {
        self.comment_order
            .iter()
            .filter_map(|id| self.comments.get(id))
    }

    pub fn tracked_changes(&self) -> impl Iterator<Item = &TrackedChange> {
        self.change_order
            .iter()
            .filter_map(|id| self.changes.get(id))
    }

    #[must_use]
    pub fn paragraph(&self, id: DocumentId) -> Option<&Paragraph> {
        self.paragraphs.get(&id)
    }

    #[must_use]
    pub fn table(&self, id: DocumentId) -> Option<&Table> {
        self.tables.get(&id)
    }

    #[must_use]
    pub fn comment(&self, id: DocumentId) -> Option<&CommentThread> {
        self.comments.get(&id)
    }

    #[must_use]
    pub fn tracked_change(&self, id: DocumentId) -> Option<&TrackedChange> {
        self.changes.get(&id)
    }

    #[must_use]
    pub fn even_and_odd_headers(&self) -> bool {
        self.explicit_even_and_odd_headers.unwrap_or_else(|| {
            self.sections.iter().any(|section| {
                !section.headers.even.blocks.is_empty() || !section.footers.even.blocks.is_empty()
            })
        })
    }

    #[must_use]
    pub fn track_revisions(&self) -> bool {
        self.explicit_track_revisions
            .unwrap_or(!self.changes.is_empty())
    }

    pub fn expected_id(
        &self,
        kind: DocumentIdKind,
        counter_offset: u64,
    ) -> Result<DocumentId, DocumentError> {
        let counter = self
            .next_id
            .checked_add(counter_offset)
            .ok_or(DocumentError::StructuralIdExhausted)?;
        DocumentId::new(kind, self.id_namespace, counter)
    }

    pub(crate) fn observe_new_id(&mut self, id: DocumentId) -> Result<(), DocumentError> {
        if id.namespace() != self.id_namespace {
            return Err(DocumentError::IdNamespaceMismatch);
        }
        if self.contains_id(id) {
            return Err(DocumentError::DuplicateId(id));
        }
        if id.counter() >= self.next_id {
            self.next_id = id
                .counter()
                .checked_add(1)
                .ok_or(DocumentError::StructuralIdExhausted)?;
            if self.next_id > MAX_STRUCTURAL_COUNTER + 1 {
                return Err(DocumentError::StructuralIdExhausted);
            }
        }
        Ok(())
    }

    #[must_use]
    pub(crate) fn contains_id(&self, id: DocumentId) -> bool {
        self.paragraphs.contains_key(&id)
            || self.tables.contains_key(&id)
            || self.page_breaks.contains(&id)
            || self.sections.iter().any(|section| {
                section.id == id
                    || section.headers.iter().any(|story| story.id == id)
                    || section.footers.iter().any(|story| story.id == id)
            })
            || self.comments.contains_key(&id)
            || self.changes.contains_key(&id)
    }

    pub(crate) fn target_blocks(&self, target: StoryTarget) -> Result<&[BlockRef], DocumentError> {
        match target {
            StoryTarget::Body => Ok(&self.body),
            StoryTarget::Section {
                section_id,
                kind,
                variant,
            } => self
                .sections
                .iter()
                .find(|section| section.id == section_id)
                .map(|section| section.story(kind, variant).blocks.as_slice())
                .ok_or(DocumentError::UnknownId(section_id)),
        }
    }

    pub(crate) fn target_blocks_mut(
        &mut self,
        target: StoryTarget,
    ) -> Result<&mut Vec<BlockRef>, DocumentError> {
        match target {
            StoryTarget::Body => Ok(&mut self.body),
            StoryTarget::Section {
                section_id,
                kind,
                variant,
            } => self
                .sections
                .iter_mut()
                .find(|section| section.id == section_id)
                .map(|section| &mut section.story_mut(kind, variant).blocks)
                .ok_or(DocumentError::UnknownId(section_id)),
        }
    }

    pub(crate) fn section_for_body_index(&self, index: usize) -> &Section {
        self.sections
            .iter()
            .rev()
            .find(|section| section.start_block_index <= index)
            .unwrap_or(&self.sections[0])
    }

    pub(crate) fn page_for_target(
        &self,
        target: StoryTarget,
    ) -> Result<PageGeometry, DocumentError> {
        match target {
            StoryTarget::Body => Ok(self
                .sections
                .last()
                .ok_or(DocumentError::InvalidSection)?
                .page),
            StoryTarget::Section { section_id, .. } => self
                .sections
                .iter()
                .find(|section| section.id == section_id)
                .map(|section| section.page)
                .ok_or(DocumentError::UnknownId(section_id)),
        }
    }

    pub fn validate(&self) -> Result<(), DocumentError> {
        if self.revision > super::types::MAX_DOCUMENT_REVISION {
            return Err(DocumentError::InvalidSnapshot("invalid document revision"));
        }
        if self.next_id == 0 || self.next_id > MAX_STRUCTURAL_COUNTER + 1 {
            return Err(DocumentError::InvalidSnapshot("invalid next structural id"));
        }
        if self.sections.is_empty() || self.sections.len() > MAX_DOCUMENT_SECTIONS {
            return Err(DocumentError::InvalidSection);
        }
        if self.sections[0].start_block_index != 0 {
            return Err(DocumentError::InvalidSection);
        }
        let mut previous_start = None;
        let mut ids = BTreeSet::new();
        let mut max_counter = 0_u64;
        let mut totals = ModelTotals::default();
        for section in &self.sections {
            validate_id(section.id, DocumentIdKind::Section, self.id_namespace)?;
            register_id(section.id, &mut ids, &mut max_counter)?;
            validate_page(section.page)?;
            if section.start_block_index > self.body.len()
                || previous_start.is_some_and(|previous| section.start_block_index <= previous)
            {
                return Err(DocumentError::InvalidSection);
            }
            previous_start = Some(section.start_block_index);
            for story in section.headers.iter() {
                validate_id(story.id, DocumentIdKind::Header, self.id_namespace)?;
                register_id(story.id, &mut ids, &mut max_counter)?;
            }
            for story in section.footers.iter() {
                validate_id(story.id, DocumentIdKind::Footer, self.id_namespace)?;
                register_id(story.id, &mut ids, &mut max_counter)?;
            }
        }
        let mut referenced_blocks = BTreeSet::new();
        self.validate_block_sequence(
            &self.body,
            &mut referenced_blocks,
            &mut ids,
            &mut max_counter,
            &mut totals,
        )?;
        for section in &self.sections {
            for story in section.headers.iter().chain(section.footers.iter()) {
                self.validate_block_sequence(
                    &story.blocks,
                    &mut referenced_blocks,
                    &mut ids,
                    &mut max_counter,
                    &mut totals,
                )?;
            }
        }
        if referenced_blocks.len()
            != self.paragraphs.len() + self.tables.len() + self.page_breaks.len()
        {
            return Err(DocumentError::InvalidSnapshot(
                "unreferenced document block",
            ));
        }
        if totals.blocks > MAX_DOCUMENT_BLOCKS
            || totals.runs > MAX_TEXT_RUNS
            || totals.text_utf16 > MAX_TEXT_UTF16
            || totals.table_cells > MAX_TABLE_CELLS
        {
            return Err(DocumentError::LimitExceeded("document content"));
        }
        for section_index in 0..self.sections.len() {
            let section = &self.sections[section_index];
            let end = self
                .sections
                .get(section_index + 1)
                .map_or(self.body.len(), |next| next.start_block_index);
            for block in &self.body[section.start_block_index..end] {
                if let BlockRef::Table(id) = block {
                    validate_table_style(&self.tables[id], section.page)?;
                }
            }
            for story in section.headers.iter().chain(section.footers.iter()) {
                for block in &story.blocks {
                    if let BlockRef::Table(id) = block {
                        validate_table_style(&self.tables[id], section.page)?;
                    }
                }
            }
        }
        if self.comment_order.len() != self.comments.len()
            || self.comments.len() > MAX_COMMENTS
            || self.change_order.len() != self.changes.len()
            || self.changes.len() > MAX_TRACKED_CHANGES
        {
            return Err(DocumentError::InvalidSnapshot(
                "invalid review object order",
            ));
        }
        let mut comment_seen = BTreeSet::new();
        let mut comments_by_block: BTreeMap<DocumentId, Vec<TextRange>> = BTreeMap::new();
        for id in &self.comment_order {
            if !comment_seen.insert(*id) {
                return Err(DocumentError::DuplicateId(*id));
            }
            let comment = self.comments.get(id).ok_or(DocumentError::UnknownId(*id))?;
            validate_id(comment.id, DocumentIdKind::Comment, self.id_namespace)?;
            register_id(comment.id, &mut ids, &mut max_counter)?;
            let paragraph = self
                .paragraphs
                .get(&comment.block_id)
                .ok_or(DocumentError::UnknownId(comment.block_id))?;
            validate_range(paragraph, comment.range, true)?;
            if comment.replies.is_empty() {
                return Err(DocumentError::InvalidComment);
            }
            for reply in &comment.replies {
                validate_reply(reply)?;
                totals.replies = checked_add(totals.replies, 1, "comment replies")?;
                totals.text_utf16 =
                    checked_add(totals.text_utf16, utf16_len(&reply.text), "document text")?;
            }
            comments_by_block
                .entry(comment.block_id)
                .or_default()
                .push(comment.range);
        }
        if totals.replies > MAX_COMMENT_REPLIES || totals.text_utf16 > MAX_TEXT_UTF16 {
            return Err(DocumentError::LimitExceeded("document review text"));
        }
        for ranges in comments_by_block.values() {
            validate_non_crossing_comments(ranges)?;
        }
        let mut change_seen = BTreeSet::new();
        let mut changes_by_block: BTreeMap<DocumentId, Vec<TextRange>> = BTreeMap::new();
        for id in &self.change_order {
            if !change_seen.insert(*id) {
                return Err(DocumentError::DuplicateId(*id));
            }
            let change = self.changes.get(id).ok_or(DocumentError::UnknownId(*id))?;
            validate_id(change.id, DocumentIdKind::TrackedChange, self.id_namespace)?;
            register_id(change.id, &mut ids, &mut max_counter)?;
            let paragraph = self
                .paragraphs
                .get(&change.block_id)
                .ok_or(DocumentError::UnknownId(change.block_id))?;
            validate_range(paragraph, change.range, false)?;
            validate_author(&change.author)?;
            validate_timestamp(&change.created_at)?;
            changes_by_block
                .entry(change.block_id)
                .or_default()
                .push(change.range);
        }
        for ranges in changes_by_block.values() {
            validate_non_overlapping_changes(ranges)?;
        }
        if max_counter >= self.next_id {
            return Err(DocumentError::InvalidSnapshot(
                "next structural id precedes an allocated id",
            ));
        }
        if totals != self.totals {
            return Err(DocumentError::InvalidSnapshot(
                "document accounting does not match model content",
            ));
        }
        Ok(())
    }

    pub(crate) fn recompute_totals(&self) -> Result<ModelTotals, DocumentError> {
        let mut totals = ModelTotals::default();
        for paragraph in self.paragraphs.values() {
            validate_paragraph(paragraph, &mut totals)?;
        }
        for table in self.tables.values() {
            validate_table(table, &mut totals)?;
        }
        totals.blocks = self
            .body
            .len()
            .checked_add(
                self.sections
                    .iter()
                    .flat_map(|section| section.headers.iter().chain(section.footers.iter()))
                    .map(|story| story.blocks.len())
                    .sum(),
            )
            .ok_or(DocumentError::LimitExceeded("document blocks"))?;
        for comment in self.comments.values() {
            for reply in &comment.replies {
                validate_reply(reply)?;
                totals.replies = checked_add(totals.replies, 1, "comment replies")?;
                totals.text_utf16 =
                    checked_add(totals.text_utf16, utf16_len(&reply.text), "document text")?;
            }
        }
        if totals.blocks > MAX_DOCUMENT_BLOCKS
            || totals.runs > MAX_TEXT_RUNS
            || totals.text_utf16 > MAX_TEXT_UTF16
            || totals.table_cells > MAX_TABLE_CELLS
            || totals.replies > MAX_COMMENT_REPLIES
        {
            return Err(DocumentError::LimitExceeded("document content"));
        }
        Ok(totals)
    }

    fn validate_block_sequence(
        &self,
        blocks: &[BlockRef],
        referenced_blocks: &mut BTreeSet<DocumentId>,
        ids: &mut BTreeSet<DocumentId>,
        max_counter: &mut u64,
        totals: &mut ModelTotals,
    ) -> Result<(), DocumentError> {
        for block in blocks {
            let id = block.id();
            if !referenced_blocks.insert(id) {
                return Err(DocumentError::InvalidSnapshot(
                    "a document block is referenced more than once",
                ));
            }
            register_id(id, ids, max_counter)?;
            totals.blocks = checked_add(totals.blocks, 1, "document blocks")?;
            match block {
                BlockRef::Paragraph(id) => {
                    validate_id(*id, DocumentIdKind::Paragraph, self.id_namespace)?;
                    let paragraph = self
                        .paragraphs
                        .get(id)
                        .ok_or(DocumentError::UnknownId(*id))?;
                    validate_paragraph(paragraph, totals)?;
                }
                BlockRef::Table(id) => {
                    validate_id(*id, DocumentIdKind::Table, self.id_namespace)?;
                    let table = self.tables.get(id).ok_or(DocumentError::UnknownId(*id))?;
                    validate_table(table, totals)?;
                }
                BlockRef::PageBreak(id) => {
                    validate_id(*id, DocumentIdKind::PageBreak, self.id_namespace)?;
                    if !self.page_breaks.contains(id) {
                        return Err(DocumentError::UnknownId(*id));
                    }
                }
            }
        }
        Ok(())
    }
}

pub(crate) fn validate_id(
    id: DocumentId,
    expected: DocumentIdKind,
    namespace: u64,
) -> Result<(), DocumentError> {
    if id.kind() != expected {
        return Err(DocumentError::WrongIdKind { id, expected });
    }
    if id.namespace() != namespace {
        return Err(DocumentError::IdNamespaceMismatch);
    }
    Ok(())
}

fn register_id(
    id: DocumentId,
    ids: &mut BTreeSet<DocumentId>,
    max_counter: &mut u64,
) -> Result<(), DocumentError> {
    if !ids.insert(id) {
        return Err(DocumentError::DuplicateId(id));
    }
    *max_counter = (*max_counter).max(id.counter());
    Ok(())
}

pub(crate) fn validate_page(page: PageGeometry) -> Result<(), DocumentError> {
    if !in_range(page.width_pt, 72.0, 14_400.0)
        || !in_range(page.height_pt, 72.0, 14_400.0)
        || !in_range(page.margin_top_pt, 0.0, 2_880.0)
        || !in_range(page.margin_right_pt, 0.0, 2_880.0)
        || !in_range(page.margin_bottom_pt, 0.0, 2_880.0)
        || !in_range(page.margin_left_pt, 0.0, 2_880.0)
        || !in_range(page.header_pt, 0.0, 2_880.0)
        || !in_range(page.footer_pt, 0.0, 2_880.0)
        || !in_range(page.gutter_pt, 0.0, 2_880.0)
        || page.margin_left_pt + page.margin_right_pt >= page.width_pt
        || page.margin_top_pt + page.margin_bottom_pt >= page.height_pt
    {
        return Err(DocumentError::InvalidPageGeometry);
    }
    Ok(())
}

pub(crate) fn validate_text(text: &str) -> Result<(), DocumentError> {
    if utf16_len(text) > MAX_TEXT_UTF16 {
        return Err(DocumentError::LimitExceeded("document text"));
    }
    if text.contains('\r') {
        return Err(DocumentError::InvalidText("CR line break"));
    }
    if text.chars().any(|character| {
        let code = u32::from(character);
        (code <= 0x08)
            || (0x0b..=0x0c).contains(&code)
            || (0x0e..=0x1f).contains(&code)
            || code == 0xfffe
            || code == 0xffff
    }) {
        return Err(DocumentError::InvalidText("XML-forbidden character"));
    }
    Ok(())
}

pub(crate) fn validate_text_style(style: &TextStyle) -> Result<(), DocumentError> {
    if let Some(family) = &style.font_family {
        let length = utf16_len(family);
        if length == 0
            || length > 128
            || !family.chars().all(|character| {
                character.is_alphanumeric()
                    || matches!(character, ' ' | '.' | ',' | '_' | '\'' | '-')
            })
        {
            return Err(DocumentError::InvalidTextStyle);
        }
    }
    if style
        .font_size_pt
        .is_some_and(|value| !in_range(value, 1.0, 1_000.0))
        || style
            .color
            .as_deref()
            .is_some_and(|value| !valid_color(value))
    {
        return Err(DocumentError::InvalidTextStyle);
    }
    Ok(())
}

pub(crate) fn validate_paragraph_style(style: &ParagraphStyle) -> Result<(), DocumentError> {
    if style
        .heading_level
        .is_some_and(|level| !(1..=6).contains(&level))
        || style
            .space_before_pt
            .is_some_and(|value| !in_range(value, 0.0, 2_880.0))
        || style
            .space_after_pt
            .is_some_and(|value| !in_range(value, 0.0, 2_880.0))
        || style
            .line_height
            .is_some_and(|value| !in_range(value, 0.5, 10.0))
    {
        return Err(DocumentError::InvalidParagraphStyle);
    }
    if let Some(ListStyle {
        level, instance_id, ..
    }) = &style.list
    {
        if level.is_some_and(|level| level > 8)
            || instance_id.as_deref().is_some_and(|id| {
                id.is_empty()
                    || utf16_len(id) > 128
                    || !id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b":_-".contains(&byte))
            })
        {
            return Err(DocumentError::InvalidParagraphStyle);
        }
    }
    Ok(())
}

fn validate_paragraph(
    paragraph: &Paragraph,
    totals: &mut ModelTotals,
) -> Result<(), DocumentError> {
    validate_paragraph_style(&paragraph.style)?;
    for run in &paragraph.runs {
        validate_text(&run.text)?;
        validate_text_style(&run.style)?;
        totals.runs = checked_add(totals.runs, 1, "document text runs")?;
        totals.text_utf16 = checked_add(totals.text_utf16, utf16_len(&run.text), "document text")?;
    }
    Ok(())
}

pub(crate) fn validate_table(table: &Table, totals: &mut ModelTotals) -> Result<(), DocumentError> {
    let columns = table.rows.first().map_or(0, Vec::len);
    if columns == 0 || table.rows.iter().any(|row| row.len() != columns) {
        return Err(DocumentError::InvalidTable);
    }
    totals.table_cells = checked_add(
        totals.table_cells,
        table.rows.len().saturating_mul(columns),
        "document table cells",
    )?;
    for row in &table.rows {
        for cell in row {
            for run in cell {
                validate_text(&run.text)?;
                validate_text_style(&run.style)?;
                totals.runs = checked_add(totals.runs, 1, "document text runs")?;
                totals.text_utf16 =
                    checked_add(totals.text_utf16, utf16_len(&run.text), "document text")?;
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_table_style(table: &Table, page: PageGeometry) -> Result<(), DocumentError> {
    let row_count = table.rows.len();
    let column_count = table.rows.first().map_or(0, Vec::len);
    validate_table_style_parts(&table.style, row_count, column_count, page)
}

pub(crate) fn validate_table_style_parts(
    style: &TableStyle,
    row_count: usize,
    column_count: usize,
    page: PageGeometry,
) -> Result<(), DocumentError> {
    let usable_width = page.width_pt - page.margin_left_pt - page.margin_right_pt;
    if style
        .width_pt
        .is_some_and(|value| !in_range(value, 1.0, usable_width))
        || style
            .header_rows
            .is_some_and(|rows| usize::try_from(rows).map_or(true, |rows| rows > row_count))
        || style
            .cell_padding_pt
            .is_some_and(|value| !in_range(value, 0.0, 144.0))
        || style
            .border_color
            .as_deref()
            .is_some_and(|value| !valid_color(value))
        || style
            .header_fill
            .as_deref()
            .is_some_and(|value| !valid_color(value))
    {
        return Err(DocumentError::InvalidTableStyle);
    }
    if let Some(widths) = &style.column_widths_pt {
        if widths.len() != column_count
            || widths
                .iter()
                .any(|width| !in_range(*width, 1.0, usable_width))
        {
            return Err(DocumentError::InvalidTableStyle);
        }
        let sum: f64 = widths.iter().sum();
        if sum > usable_width + 0.01
            || style
                .width_pt
                .is_some_and(|width| (sum - width).abs() > 0.01)
        {
            return Err(DocumentError::InvalidTableStyle);
        }
    }
    Ok(())
}

pub(crate) fn validate_range(
    paragraph: &Paragraph,
    range: TextRange,
    allow_point: bool,
) -> Result<(), DocumentError> {
    let length = paragraph.text_utf16_len();
    let start = usize::try_from(range.start).map_err(|_| DocumentError::InvalidTextRange)?;
    let end = usize::try_from(range.end).map_err(|_| DocumentError::InvalidTextRange)?;
    if end < start || end > length || (!allow_point && start == end) {
        return Err(DocumentError::InvalidTextRange);
    }
    // Every scalar boundary is a UTF-16 boundary in Rust. Verify by mapping it;
    // this specifically rejects offsets between a surrogate pair.
    let text = paragraph.text();
    utf16_to_byte(&text, start)?;
    utf16_to_byte(&text, end)?;
    Ok(())
}

pub(crate) fn validate_reply(reply: &CommentReply) -> Result<(), DocumentError> {
    validate_author(&reply.author)?;
    validate_text(&reply.text)?;
    validate_timestamp(&reply.created_at)
}

pub(crate) fn validate_author(author: &str) -> Result<(), DocumentError> {
    validate_text(author)?;
    if author.trim().is_empty() || utf16_len(author) > 255 {
        return Err(DocumentError::InvalidText("author"));
    }
    Ok(())
}

/// Accepts the canonical `Date.prototype.toISOString()` forms used by the TS model.
pub(crate) fn validate_timestamp(value: &str) -> Result<(), DocumentError> {
    let bytes = value.as_bytes();
    let (year_start, date_start) = match bytes {
        [sign @ (b'+' | b'-'), _, _, _, _, _, _, b'-', ..] => {
            let _ = sign;
            (1, 7)
        }
        [_, _, _, _, b'-', ..] => (0, 4),
        _ => return Err(DocumentError::InvalidText("ISO timestamp")),
    };
    let year_digits = date_start - year_start;
    if (year_digits != 4 && year_digits != 6)
        || bytes.len() != if year_digits == 4 { 24 } else { 27 }
    {
        return Err(DocumentError::InvalidText("ISO timestamp"));
    }
    let digit =
        |range: core::ops::Range<usize>| -> Option<u32> { value.get(range)?.parse::<u32>().ok() };
    let base = date_start;
    if bytes.get(base) != Some(&b'-')
        || bytes.get(base + 3) != Some(&b'-')
        || bytes.get(base + 6) != Some(&b'T')
        || bytes.get(base + 9) != Some(&b':')
        || bytes.get(base + 12) != Some(&b':')
        || bytes.get(base + 15) != Some(&b'.')
        || bytes.get(base + 19) != Some(&b'Z')
    {
        return Err(DocumentError::InvalidText("ISO timestamp"));
    }
    let year = digit(year_start..date_start).ok_or(DocumentError::InvalidText("ISO timestamp"))?;
    let month = digit(base + 1..base + 3).ok_or(DocumentError::InvalidText("ISO timestamp"))?;
    let day = digit(base + 4..base + 6).ok_or(DocumentError::InvalidText("ISO timestamp"))?;
    let hour = digit(base + 7..base + 9).ok_or(DocumentError::InvalidText("ISO timestamp"))?;
    let minute = digit(base + 10..base + 12).ok_or(DocumentError::InvalidText("ISO timestamp"))?;
    let second = digit(base + 13..base + 15).ok_or(DocumentError::InvalidText("ISO timestamp"))?;
    let millis = digit(base + 16..base + 19).ok_or(DocumentError::InvalidText("ISO timestamp"))?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    if day == 0 || day > month_days || hour > 23 || minute > 59 || second > 59 || millis > 999 {
        return Err(DocumentError::InvalidText("ISO timestamp"));
    }
    Ok(())
}

pub(crate) fn validate_non_crossing_comments(ranges: &[TextRange]) -> Result<(), DocumentError> {
    let mut sorted = ranges.to_vec();
    sorted.sort_by_key(|range| (range.start, core::cmp::Reverse(range.end)));
    let mut active_ends = Vec::new();
    for range in sorted {
        while active_ends.last().is_some_and(|end| range.start >= *end) {
            active_ends.pop();
        }
        if active_ends.last().is_some_and(|end| range.end > *end) {
            return Err(DocumentError::CrossingCommentRanges);
        }
        if !range.is_empty() {
            active_ends.push(range.end);
        }
    }
    Ok(())
}

pub(crate) fn validate_non_overlapping_changes(ranges: &[TextRange]) -> Result<(), DocumentError> {
    let mut sorted = ranges.to_vec();
    sorted.sort_by_key(|range| (range.start, range.end));
    for pair in sorted.windows(2) {
        if pair[1].start < pair[0].end {
            return Err(DocumentError::OverlappingTrackedChanges);
        }
    }
    Ok(())
}

pub(crate) fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

pub(crate) fn utf16_to_byte(value: &str, offset: usize) -> Result<usize, DocumentError> {
    if offset == 0 {
        return Ok(0);
    }
    let mut current = 0_usize;
    for (byte, character) in value.char_indices() {
        if current == offset {
            return Ok(byte);
        }
        let next = current + character.len_utf16();
        if offset < next {
            return Err(DocumentError::InvalidTextRange);
        }
        current = next;
    }
    if current == offset {
        Ok(value.len())
    } else {
        Err(DocumentError::InvalidTextRange)
    }
}

pub(crate) fn slice_runs(
    runs: &[TextRun],
    start: usize,
    end: usize,
) -> Result<Vec<TextRun>, DocumentError> {
    let mut result = Vec::new();
    let mut offset = 0_usize;
    for run in runs {
        let length = utf16_len(&run.text);
        let run_start = offset;
        let run_end = offset + length;
        offset = run_end;
        let slice_start = start.max(run_start);
        let slice_end = end.min(run_end);
        if slice_end <= slice_start {
            continue;
        }
        let start_byte = utf16_to_byte(&run.text, slice_start - run_start)?;
        let end_byte = utf16_to_byte(&run.text, slice_end - run_start)?;
        result.push(TextRun {
            text: run.text[start_byte..end_byte].to_owned(),
            style: run.style.clone(),
        });
    }
    Ok(result)
}

pub(crate) fn merge_adjacent_runs(runs: Vec<TextRun>) -> Vec<TextRun> {
    let mut result: Vec<TextRun> = Vec::with_capacity(runs.len());
    for run in runs {
        if let Some(previous) = result.last_mut() {
            if previous.style == run.style {
                previous.text.push_str(&run.text);
                continue;
            }
        }
        result.push(run);
    }
    result
}

pub(crate) fn style_at(runs: &[TextRun], offset: usize, total: usize) -> TextStyle {
    if runs.is_empty() {
        return TextStyle::default();
    }
    if offset == total {
        return runs
            .last()
            .map_or_else(TextStyle::default, |run| run.style.clone());
    }
    let mut cursor = 0_usize;
    for run in runs {
        cursor += utf16_len(&run.text);
        if offset < cursor || (offset == cursor && offset < total) {
            return run.style.clone();
        }
    }
    TextStyle::default()
}

pub(crate) fn apply_style_patch(
    style: &TextStyle,
    patch: &super::types::TextStylePatch,
) -> TextStyle {
    TextStyle {
        font_family: patch
            .font_family
            .clone()
            .unwrap_or_else(|| style.font_family.clone()),
        font_size_pt: patch.font_size_pt.unwrap_or(style.font_size_pt),
        color: patch.color.clone().unwrap_or_else(|| style.color.clone()),
        bold: patch.bold.unwrap_or(style.bold),
        italic: patch.italic.unwrap_or(style.italic),
        underline: patch.underline.unwrap_or(style.underline),
        strike: patch.strike.unwrap_or(style.strike),
    }
}

fn checked_add(value: usize, addition: usize, limit: &'static str) -> Result<usize, DocumentError> {
    value
        .checked_add(addition)
        .ok_or(DocumentError::LimitExceeded(limit))
}

fn valid_color(value: &str) -> bool {
    let digits = value.strip_prefix('#').unwrap_or(value);
    digits.len() == 6 && digits.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn in_range(value: f64, minimum: f64, maximum: f64) -> bool {
    value.is_finite()
        && (value != 0.0 || !value.is_sign_negative())
        && value >= minimum
        && value <= maximum
}
