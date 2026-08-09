use std::collections::BTreeSet;

use super::model::{
    apply_style_patch, merge_adjacent_runs, slice_runs, style_at, utf16_len, validate_author,
    validate_id, validate_non_crossing_comments, validate_non_overlapping_changes, validate_page,
    validate_paragraph_style, validate_range, validate_reply, validate_table, validate_table_style,
    validate_table_style_parts, validate_text, validate_text_style, CommentThread, Document,
    ModelTotals, Paragraph, Section, SectionStories, Story, Table, TrackedChange,
};
use super::types::{
    CommentReply, DocumentError, DocumentId, DocumentIdKind, PageGeometry, ParagraphStyle,
    StoryTarget, TableStyle, TextRange, TextRun, TextStyle, TextStylePatch, TrackedChangeKind,
    MAX_COMMENTS, MAX_COMMENT_REPLIES, MAX_DOCUMENT_BLOCKS, MAX_DOCUMENT_SECTIONS, MAX_TABLE_CELLS,
    MAX_TEXT_RUNS, MAX_TEXT_UTF16, MAX_TRACKED_CHANGES,
};
use super::BlockRef;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SectionIds {
    pub section: DocumentId,
    pub header_default: DocumentId,
    pub header_first: DocumentId,
    pub header_even: DocumentId,
    pub footer_default: DocumentId,
    pub footer_first: DocumentId,
    pub footer_even: DocumentId,
}

impl SectionIds {
    #[must_use]
    pub const fn all(self) -> [DocumentId; 7] {
        [
            self.section,
            self.header_default,
            self.header_first,
            self.header_even,
            self.footer_default,
            self.footer_first,
            self.footer_even,
        ]
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum DocumentCommand {
    SetDocumentFlags {
        even_and_odd_headers: Option<Option<bool>>,
        track_revisions: Option<Option<bool>>,
    },
    AddParagraph {
        target: StoryTarget,
        id: DocumentId,
        runs: Vec<TextRun>,
        style: ParagraphStyle,
    },
    EditParagraph {
        id: DocumentId,
        range: TextRange,
        replacement: String,
        style: Option<TextStyle>,
    },
    FormatParagraph {
        id: DocumentId,
        range: TextRange,
        style: TextStylePatch,
    },
    SetParagraphStyle {
        id: DocumentId,
        style: ParagraphStyle,
    },
    AddTable {
        target: StoryTarget,
        id: DocumentId,
        rows: Vec<Vec<Vec<TextRun>>>,
        style: TableStyle,
    },
    SetTableStyle {
        id: DocumentId,
        style: TableStyle,
    },
    AddPageBreak {
        id: DocumentId,
    },
    AddSection {
        ids: SectionIds,
        page: PageGeometry,
        title_page: Option<bool>,
    },
    SetSectionTitlePage {
        id: DocumentId,
        title_page: Option<bool>,
    },
    SetSectionPage {
        id: DocumentId,
        page: PageGeometry,
    },
    AddComment {
        id: DocumentId,
        paragraph_id: DocumentId,
        range: TextRange,
        resolved: bool,
        root: CommentReply,
    },
    AddCommentReply {
        id: DocumentId,
        reply: CommentReply,
    },
    SetCommentResolved {
        id: DocumentId,
        resolved: bool,
    },
    AddTrackedChange {
        id: DocumentId,
        paragraph_id: DocumentId,
        range: TextRange,
        kind: TrackedChangeKind,
        author: String,
        created_at: String,
    },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DocumentBatch {
    commands: Vec<DocumentCommand>,
}

impl DocumentBatch {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            commands: Vec::new(),
        }
    }

    #[must_use]
    pub fn from_commands(commands: Vec<DocumentCommand>) -> Self {
        Self { commands }
    }

    pub fn push(&mut self, command: DocumentCommand) -> &mut Self {
        self.commands.push(command);
        self
    }

    #[must_use]
    pub fn commands(&self) -> &[DocumentCommand] {
        &self.commands
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.commands.is_empty()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentBatchReceipt {
    pub revision: u64,
    pub command_count: usize,
    pub created_ids: Vec<DocumentId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentBatchError {
    pub command_index: usize,
    pub cause: DocumentError,
}

impl core::fmt::Display for DocumentBatchError {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(
            formatter,
            "document command {} failed: {}",
            self.command_index, self.cause
        )
    }
}

impl std::error::Error for DocumentBatchError {}

/// Auto-rollback guard for one fully validated document transaction.
///
/// Dropping the guard restores every touched node, review anchor, allocator
/// counter, accounting total, and the previous revision. This lets bindings
/// perform exact post-apply snapshot-size checks without cloning the model.
pub struct DocumentBatchTransaction<'a> {
    document: &'a mut Document,
    undo: Option<Vec<Undo>>,
    previous_next_id: u64,
    previous_totals: ModelTotals,
    previous_revision: u64,
    receipt: DocumentBatchReceipt,
}

impl DocumentBatchTransaction<'_> {
    #[must_use]
    pub fn document(&self) -> &Document {
        self.document
    }

    #[must_use]
    pub fn receipt(&self) -> &DocumentBatchReceipt {
        &self.receipt
    }

    pub fn commit(mut self) -> DocumentBatchReceipt {
        self.undo = None;
        self.receipt.clone()
    }
}

impl Drop for DocumentBatchTransaction<'_> {
    fn drop(&mut self) {
        if let Some(undo) = self.undo.take() {
            self.document.rollback(undo);
            self.document.next_id = self.previous_next_id;
            self.document.totals = self.previous_totals;
            self.document.revision = self.previous_revision;
        }
    }
}

#[derive(Debug)]
enum Undo {
    Noop,
    Flags {
        even_and_odd_headers: Option<bool>,
        track_revisions: Option<bool>,
    },
    AddedBlock {
        target: StoryTarget,
        block: BlockRef,
    },
    EditedParagraph {
        id: DocumentId,
        runs: Vec<TextRun>,
        comment_ranges: Vec<(DocumentId, TextRange)>,
        changes: Vec<(usize, TrackedChange)>,
    },
    ParagraphRuns {
        id: DocumentId,
        runs: Vec<TextRun>,
    },
    ParagraphStyle {
        id: DocumentId,
        style: ParagraphStyle,
    },
    TableStyle {
        id: DocumentId,
        style: TableStyle,
    },
    AddedSection {
        id: DocumentId,
    },
    SectionTitlePage {
        id: DocumentId,
        title_page: Option<bool>,
    },
    SectionPage {
        id: DocumentId,
        page: PageGeometry,
    },
    AddedComment {
        id: DocumentId,
    },
    AddedCommentReply {
        id: DocumentId,
    },
    CommentResolved {
        id: DocumentId,
        resolved: bool,
    },
    AddedTrackedChange {
        id: DocumentId,
    },
}

impl Document {
    /// Applies every command atomically without cloning the complete document.
    ///
    /// Validation precedes each local mutation and the undo journal retains only
    /// touched nodes. On any error the exact revision, allocator, accounting,
    /// review anchors, and ordered state are restored.
    pub fn apply_batch(
        &mut self,
        batch: &DocumentBatch,
    ) -> Result<DocumentBatchReceipt, DocumentBatchError> {
        self.begin_batch(batch)
            .map(DocumentBatchTransaction::commit)
    }

    pub fn begin_batch<'a>(
        &'a mut self,
        batch: &DocumentBatch,
    ) -> Result<DocumentBatchTransaction<'a>, DocumentBatchError> {
        if batch.is_empty() {
            return Ok(DocumentBatchTransaction {
                previous_next_id: self.next_id,
                previous_totals: self.totals,
                previous_revision: self.revision,
                receipt: DocumentBatchReceipt {
                    revision: self.revision,
                    command_count: 0,
                    created_ids: Vec::new(),
                },
                document: self,
                undo: Some(Vec::new()),
            });
        }
        let previous_revision = self.revision;
        let previous_next_id = self.next_id;
        let previous_totals = self.totals;
        let mut undo = Vec::with_capacity(batch.commands.len());
        let mut created_ids = Vec::new();
        let mut changed = false;
        for (command_index, command) in batch.commands.iter().enumerate() {
            match self.apply_command(command, &mut created_ids) {
                Ok(entry) => {
                    changed |= !matches!(entry, Undo::Noop);
                    undo.push(entry);
                }
                Err(cause) => {
                    self.rollback(undo);
                    self.next_id = previous_next_id;
                    self.totals = previous_totals;
                    return Err(DocumentBatchError {
                        command_index,
                        cause,
                    });
                }
            }
        }
        if changed {
            let Some(next_revision) = self
                .revision
                .checked_add(1)
                .filter(|revision| *revision <= super::types::MAX_DOCUMENT_REVISION)
            else {
                self.rollback(undo);
                self.next_id = previous_next_id;
                self.totals = previous_totals;
                return Err(DocumentBatchError {
                    command_index: 0,
                    cause: DocumentError::RevisionExhausted,
                });
            };
            self.revision = next_revision;
        }
        let receipt = DocumentBatchReceipt {
            revision: self.revision,
            command_count: batch.commands.len(),
            created_ids,
        };
        Ok(DocumentBatchTransaction {
            document: self,
            undo: Some(undo),
            previous_next_id,
            previous_totals,
            previous_revision,
            receipt,
        })
    }

    fn apply_command(
        &mut self,
        command: &DocumentCommand,
        created_ids: &mut Vec<DocumentId>,
    ) -> Result<Undo, DocumentError> {
        match command {
            DocumentCommand::SetDocumentFlags {
                even_and_odd_headers,
                track_revisions,
            } => {
                let next_even = even_and_odd_headers
                    .as_ref()
                    .copied()
                    .unwrap_or(self.explicit_even_and_odd_headers);
                let next_track = track_revisions
                    .as_ref()
                    .copied()
                    .unwrap_or(self.explicit_track_revisions);
                if next_even == self.explicit_even_and_odd_headers
                    && next_track == self.explicit_track_revisions
                {
                    return Ok(Undo::Noop);
                }
                let undo = Undo::Flags {
                    even_and_odd_headers: self.explicit_even_and_odd_headers,
                    track_revisions: self.explicit_track_revisions,
                };
                if let Some(value) = even_and_odd_headers {
                    self.explicit_even_and_odd_headers = *value;
                }
                if let Some(value) = track_revisions {
                    self.explicit_track_revisions = *value;
                }
                Ok(undo)
            }
            DocumentCommand::AddParagraph {
                target,
                id,
                runs,
                style,
            } => {
                validate_id(*id, DocumentIdKind::Paragraph, self.id_namespace)?;
                validate_paragraph_style(style)?;
                let paragraph = Paragraph {
                    id: *id,
                    runs: runs.clone(),
                    style: style.clone(),
                };
                let mut added = ModelTotals::default();
                validate_paragraph_for_command(&paragraph, &mut added)?;
                self.ensure_added_totals(1, added.runs, added.text_utf16, 0, 0)?;
                self.target_blocks(*target)?;
                self.observe_new_id(*id)?;
                self.paragraphs.insert(*id, paragraph);
                self.target_blocks_mut(*target)?
                    .push(BlockRef::Paragraph(*id));
                self.add_totals(1, added.runs, added.text_utf16, 0, 0);
                created_ids.push(*id);
                Ok(Undo::AddedBlock {
                    target: *target,
                    block: BlockRef::Paragraph(*id),
                })
            }
            DocumentCommand::EditParagraph {
                id,
                range,
                replacement,
                style,
            } => {
                validate_text(replacement)?;
                if let Some(style) = style {
                    validate_text_style(style)?;
                }
                let paragraph = self
                    .paragraphs
                    .get(id)
                    .ok_or(DocumentError::UnknownId(*id))?;
                validate_range(paragraph, *range, true)?;
                if range.is_empty() && replacement.is_empty() {
                    return Ok(Undo::Noop);
                }
                let total = paragraph.text_utf16_len();
                let start = range.start as usize;
                let end = range.end as usize;
                let before = slice_runs(&paragraph.runs, 0, start)?;
                let after = slice_runs(&paragraph.runs, end, total)?;
                let inserted_style = style
                    .clone()
                    .unwrap_or_else(|| style_at(&paragraph.runs, start, total));
                let mut materialized = before;
                if !replacement.is_empty() {
                    materialized.push(TextRun {
                        text: replacement.clone(),
                        style: inserted_style,
                    });
                }
                materialized.extend(after);
                let mut next_runs = merge_adjacent_runs(materialized);
                if next_runs.is_empty() {
                    next_runs.push(TextRun::plain(""));
                }
                let old_runs = paragraph.runs.clone();
                let old_run_count = old_runs.len();
                let old_text = total;
                let next_run_count = next_runs.len();
                let next_text: usize = next_runs.iter().map(|run| utf16_len(&run.text)).sum();
                self.ensure_replaced_totals(old_run_count, next_run_count, old_text, next_text)?;
                let comment_ranges = self
                    .comments
                    .values()
                    .filter(|comment| comment.block_id == *id)
                    .map(|comment| (comment.id, comment.range))
                    .collect();
                let changes = self
                    .change_order
                    .iter()
                    .enumerate()
                    .filter_map(|(index, change_id)| {
                        self.changes
                            .get(change_id)
                            .filter(|change| change.block_id == *id)
                            .cloned()
                            .map(|change| (index, change))
                    })
                    .collect();
                self.paragraphs.get_mut(id).expect("paragraph exists").runs = next_runs;
                self.rebase_anchors(*id, *range, utf16_len(replacement));
                self.replace_run_text_totals(old_run_count, next_run_count, old_text, next_text);
                Ok(Undo::EditedParagraph {
                    id: *id,
                    runs: old_runs,
                    comment_ranges,
                    changes,
                })
            }
            DocumentCommand::FormatParagraph { id, range, style } => {
                let paragraph = self
                    .paragraphs
                    .get(id)
                    .ok_or(DocumentError::UnknownId(*id))?;
                validate_range(paragraph, *range, true)?;
                if range.is_empty() || style_patch_is_empty(style) {
                    return Ok(Undo::Noop);
                }
                let total = paragraph.text_utf16_len();
                let start = range.start as usize;
                let end = range.end as usize;
                let before = slice_runs(&paragraph.runs, 0, start)?;
                let selected = slice_runs(&paragraph.runs, start, end)?
                    .into_iter()
                    .map(|run| TextRun {
                        text: run.text,
                        style: apply_style_patch(&run.style, style),
                    })
                    .collect::<Vec<_>>();
                for run in &selected {
                    validate_text_style(&run.style)?;
                }
                let after = slice_runs(&paragraph.runs, end, total)?;
                let next_runs =
                    merge_adjacent_runs(before.into_iter().chain(selected).chain(after).collect());
                let old_runs = paragraph.runs.clone();
                self.ensure_replaced_totals(old_runs.len(), next_runs.len(), total, total)?;
                self.paragraphs.get_mut(id).expect("paragraph exists").runs = next_runs;
                self.replace_run_text_totals(
                    old_runs.len(),
                    self.paragraphs[id].runs.len(),
                    total,
                    total,
                );
                Ok(Undo::ParagraphRuns {
                    id: *id,
                    runs: old_runs,
                })
            }
            DocumentCommand::SetParagraphStyle { id, style } => {
                validate_paragraph_style(style)?;
                let paragraph = self
                    .paragraphs
                    .get_mut(id)
                    .ok_or(DocumentError::UnknownId(*id))?;
                if paragraph.style == *style {
                    return Ok(Undo::Noop);
                }
                let old = core::mem::replace(&mut paragraph.style, style.clone());
                Ok(Undo::ParagraphStyle {
                    id: *id,
                    style: old,
                })
            }
            DocumentCommand::AddTable {
                target,
                id,
                rows,
                style,
            } => {
                validate_id(*id, DocumentIdKind::Table, self.id_namespace)?;
                self.target_blocks(*target)?;
                let table = Table {
                    id: *id,
                    rows: rows.clone(),
                    style: style.clone(),
                };
                let mut added = ModelTotals::default();
                validate_table(&table, &mut added)?;
                validate_table_style(&table, self.page_for_target(*target)?)?;
                self.ensure_added_totals(1, added.runs, added.text_utf16, added.table_cells, 0)?;
                self.observe_new_id(*id)?;
                self.tables.insert(*id, table);
                self.target_blocks_mut(*target)?.push(BlockRef::Table(*id));
                self.add_totals(1, added.runs, added.text_utf16, added.table_cells, 0);
                created_ids.push(*id);
                Ok(Undo::AddedBlock {
                    target: *target,
                    block: BlockRef::Table(*id),
                })
            }
            DocumentCommand::SetTableStyle { id, style } => {
                let table = self.tables.get(id).ok_or(DocumentError::UnknownId(*id))?;
                if table.style == *style {
                    return Ok(Undo::Noop);
                }
                let page = self.page_for_block(*id)?;
                validate_table_style_parts(
                    style,
                    table.rows.len(),
                    table.rows.first().map_or(0, Vec::len),
                    page,
                )?;
                let old = core::mem::replace(
                    &mut self.tables.get_mut(id).expect("table exists").style,
                    style.clone(),
                );
                Ok(Undo::TableStyle {
                    id: *id,
                    style: old,
                })
            }
            DocumentCommand::AddPageBreak { id } => {
                validate_id(*id, DocumentIdKind::PageBreak, self.id_namespace)?;
                self.ensure_added_totals(1, 0, 0, 0, 0)?;
                self.observe_new_id(*id)?;
                self.page_breaks.insert(*id);
                self.body.push(BlockRef::PageBreak(*id));
                self.add_totals(1, 0, 0, 0, 0);
                created_ids.push(*id);
                Ok(Undo::AddedBlock {
                    target: StoryTarget::Body,
                    block: BlockRef::PageBreak(*id),
                })
            }
            DocumentCommand::AddSection {
                ids,
                page,
                title_page,
            } => {
                if self.sections.len() >= MAX_DOCUMENT_SECTIONS
                    || self
                        .sections
                        .last()
                        .is_some_and(|last| last.start_block_index == self.body.len())
                {
                    return Err(DocumentError::InvalidSection);
                }
                validate_page(*page)?;
                validate_section_ids(self, *ids)?;
                for id in ids.all() {
                    self.observe_new_id(id)?;
                    created_ids.push(id);
                }
                let section = Section {
                    id: ids.section,
                    start_block_index: self.body.len(),
                    title_page: *title_page,
                    page: *page,
                    headers: SectionStories {
                        default: Story {
                            id: ids.header_default,
                            blocks: Vec::new(),
                        },
                        first: Story {
                            id: ids.header_first,
                            blocks: Vec::new(),
                        },
                        even: Story {
                            id: ids.header_even,
                            blocks: Vec::new(),
                        },
                    },
                    footers: SectionStories {
                        default: Story {
                            id: ids.footer_default,
                            blocks: Vec::new(),
                        },
                        first: Story {
                            id: ids.footer_first,
                            blocks: Vec::new(),
                        },
                        even: Story {
                            id: ids.footer_even,
                            blocks: Vec::new(),
                        },
                    },
                };
                self.sections.push(section);
                Ok(Undo::AddedSection { id: ids.section })
            }
            DocumentCommand::SetSectionTitlePage { id, title_page } => {
                let section = self
                    .sections
                    .iter_mut()
                    .find(|section| section.id == *id)
                    .ok_or(DocumentError::UnknownId(*id))?;
                if section.title_page == *title_page {
                    return Ok(Undo::Noop);
                }
                let old = core::mem::replace(&mut section.title_page, *title_page);
                Ok(Undo::SectionTitlePage {
                    id: *id,
                    title_page: old,
                })
            }
            DocumentCommand::SetSectionPage { id, page } => {
                validate_page(*page)?;
                let section_index = self
                    .sections
                    .iter()
                    .position(|section| section.id == *id)
                    .ok_or(DocumentError::UnknownId(*id))?;
                if self.sections[section_index].page == *page {
                    return Ok(Undo::Noop);
                }
                self.validate_tables_for_section_page(section_index, *page)?;
                let old = core::mem::replace(&mut self.sections[section_index].page, *page);
                Ok(Undo::SectionPage { id: *id, page: old })
            }
            DocumentCommand::AddComment {
                id,
                paragraph_id,
                range,
                resolved,
                root,
            } => {
                if self.comments.len() >= MAX_COMMENTS {
                    return Err(DocumentError::LimitExceeded("document comments"));
                }
                validate_id(*id, DocumentIdKind::Comment, self.id_namespace)?;
                validate_reply(root)?;
                let paragraph = self
                    .paragraphs
                    .get(paragraph_id)
                    .ok_or(DocumentError::UnknownId(*paragraph_id))?;
                validate_range(paragraph, *range, true)?;
                let mut ranges = self
                    .comments
                    .values()
                    .filter(|comment| comment.block_id == *paragraph_id)
                    .map(|comment| comment.range)
                    .collect::<Vec<_>>();
                ranges.push(*range);
                validate_non_crossing_comments(&ranges)?;
                self.ensure_added_totals(0, 0, utf16_len(&root.text), 0, 1)?;
                self.observe_new_id(*id)?;
                self.comments.insert(
                    *id,
                    CommentThread {
                        id: *id,
                        block_id: *paragraph_id,
                        range: *range,
                        resolved: *resolved,
                        replies: vec![root.clone()],
                    },
                );
                self.comment_order.push(*id);
                self.add_totals(0, 0, utf16_len(&root.text), 0, 1);
                created_ids.push(*id);
                Ok(Undo::AddedComment { id: *id })
            }
            DocumentCommand::AddCommentReply { id, reply } => {
                validate_reply(reply)?;
                self.ensure_added_totals(0, 0, utf16_len(&reply.text), 0, 1)?;
                self.comments
                    .get_mut(id)
                    .ok_or(DocumentError::UnknownId(*id))?
                    .replies
                    .push(reply.clone());
                self.add_totals(0, 0, utf16_len(&reply.text), 0, 1);
                Ok(Undo::AddedCommentReply { id: *id })
            }
            DocumentCommand::SetCommentResolved { id, resolved } => {
                let comment = self
                    .comments
                    .get_mut(id)
                    .ok_or(DocumentError::UnknownId(*id))?;
                if comment.resolved == *resolved {
                    return Ok(Undo::Noop);
                }
                let old = core::mem::replace(&mut comment.resolved, *resolved);
                Ok(Undo::CommentResolved {
                    id: *id,
                    resolved: old,
                })
            }
            DocumentCommand::AddTrackedChange {
                id,
                paragraph_id,
                range,
                kind,
                author,
                created_at,
            } => {
                if self.changes.len() >= MAX_TRACKED_CHANGES {
                    return Err(DocumentError::LimitExceeded("document tracked changes"));
                }
                validate_id(*id, DocumentIdKind::TrackedChange, self.id_namespace)?;
                validate_author(author)?;
                super::model::validate_timestamp(created_at)?;
                let paragraph = self
                    .paragraphs
                    .get(paragraph_id)
                    .ok_or(DocumentError::UnknownId(*paragraph_id))?;
                validate_range(paragraph, *range, false)?;
                let mut ranges = self
                    .changes
                    .values()
                    .filter(|change| change.block_id == *paragraph_id)
                    .map(|change| change.range)
                    .collect::<Vec<_>>();
                ranges.push(*range);
                validate_non_overlapping_changes(&ranges)?;
                self.observe_new_id(*id)?;
                self.changes.insert(
                    *id,
                    TrackedChange {
                        id: *id,
                        block_id: *paragraph_id,
                        range: *range,
                        kind: *kind,
                        author: author.clone(),
                        created_at: created_at.clone(),
                    },
                );
                self.change_order.push(*id);
                created_ids.push(*id);
                Ok(Undo::AddedTrackedChange { id: *id })
            }
        }
    }

    fn rollback(&mut self, undo: Vec<Undo>) {
        for entry in undo.into_iter().rev() {
            match entry {
                Undo::Noop => {}
                Undo::Flags {
                    even_and_odd_headers,
                    track_revisions,
                } => {
                    self.explicit_even_and_odd_headers = even_and_odd_headers;
                    self.explicit_track_revisions = track_revisions;
                }
                Undo::AddedBlock { target, block } => {
                    let blocks = self
                        .target_blocks_mut(target)
                        .expect("rollback target exists");
                    let popped = blocks.pop();
                    debug_assert_eq!(popped, Some(block));
                    match block {
                        BlockRef::Paragraph(id) => {
                            self.paragraphs.remove(&id);
                        }
                        BlockRef::Table(id) => {
                            self.tables.remove(&id);
                        }
                        BlockRef::PageBreak(id) => {
                            self.page_breaks.remove(&id);
                        }
                    }
                }
                Undo::EditedParagraph {
                    id,
                    runs,
                    comment_ranges,
                    changes,
                } => {
                    self.paragraphs
                        .get_mut(&id)
                        .expect("rollback paragraph exists")
                        .runs = runs;
                    for (comment_id, range) in comment_ranges {
                        self.comments
                            .get_mut(&comment_id)
                            .expect("rollback comment exists")
                            .range = range;
                    }
                    let affected: BTreeSet<_> =
                        changes.iter().map(|(_, change)| change.id).collect();
                    self.change_order
                        .retain(|change_id| !affected.contains(change_id));
                    for change_id in &affected {
                        self.changes.remove(change_id);
                    }
                    for (index, change) in changes {
                        self.changes.insert(change.id, change.clone());
                        self.change_order.insert(index, change.id);
                    }
                }
                Undo::ParagraphRuns { id, runs } => {
                    self.paragraphs
                        .get_mut(&id)
                        .expect("rollback paragraph exists")
                        .runs = runs;
                }
                Undo::ParagraphStyle { id, style } => {
                    self.paragraphs
                        .get_mut(&id)
                        .expect("rollback paragraph exists")
                        .style = style;
                }
                Undo::TableStyle { id, style } => {
                    self.tables
                        .get_mut(&id)
                        .expect("rollback table exists")
                        .style = style;
                }
                Undo::AddedSection { id } => {
                    let section = self.sections.pop();
                    debug_assert_eq!(section.as_ref().map(|section| section.id), Some(id));
                }
                Undo::SectionTitlePage { id, title_page } => {
                    self.sections
                        .iter_mut()
                        .find(|section| section.id == id)
                        .expect("rollback section exists")
                        .title_page = title_page;
                }
                Undo::SectionPage { id, page } => {
                    self.sections
                        .iter_mut()
                        .find(|section| section.id == id)
                        .expect("rollback section exists")
                        .page = page;
                }
                Undo::AddedComment { id } => {
                    self.comments.remove(&id);
                    let popped = self.comment_order.pop();
                    debug_assert_eq!(popped, Some(id));
                }
                Undo::AddedCommentReply { id } => {
                    self.comments
                        .get_mut(&id)
                        .expect("rollback comment exists")
                        .replies
                        .pop();
                }
                Undo::CommentResolved { id, resolved } => {
                    self.comments
                        .get_mut(&id)
                        .expect("rollback comment exists")
                        .resolved = resolved;
                }
                Undo::AddedTrackedChange { id } => {
                    self.changes.remove(&id);
                    let popped = self.change_order.pop();
                    debug_assert_eq!(popped, Some(id));
                }
            }
        }
    }

    fn rebase_anchors(&mut self, paragraph_id: DocumentId, edit: TextRange, inserted: usize) {
        let start = i64::from(edit.start);
        let end = i64::from(edit.end);
        let inserted = i64::try_from(inserted).expect("bounded text length fits i64");
        let delta = inserted - (end - start);
        let map_start = |offset: u32| -> u32 {
            let offset = i64::from(offset);
            let mapped = if offset <= start {
                offset
            } else if offset >= end {
                offset + delta
            } else {
                start
            };
            u32::try_from(mapped).expect("rebased bounded anchor fits u32")
        };
        let map_end = |offset: u32| -> u32 {
            let offset = i64::from(offset);
            let mapped = if offset <= start {
                offset
            } else if offset >= end {
                offset + delta
            } else {
                start + inserted
            };
            u32::try_from(mapped).expect("rebased bounded anchor fits u32")
        };
        for comment in self
            .comments
            .values_mut()
            .filter(|comment| comment.block_id == paragraph_id)
        {
            let was_point = comment.range.is_empty();
            let next_start = map_start(comment.range.start);
            comment.range = TextRange {
                start: next_start,
                end: if was_point {
                    next_start
                } else {
                    map_end(comment.range.end).max(next_start)
                },
            };
        }
        let mut removed = BTreeSet::new();
        for change in self
            .changes
            .values_mut()
            .filter(|change| change.block_id == paragraph_id)
        {
            let next_start = map_start(change.range.start);
            change.range = TextRange {
                start: next_start,
                end: map_end(change.range.end).max(next_start),
            };
            if change.range.is_empty() {
                removed.insert(change.id);
            }
        }
        for id in &removed {
            self.changes.remove(id);
        }
        self.change_order.retain(|id| !removed.contains(id));
    }

    fn validate_tables_for_section_page(
        &self,
        section_index: usize,
        page: PageGeometry,
    ) -> Result<(), DocumentError> {
        let section = self
            .sections
            .get(section_index)
            .ok_or(DocumentError::InvalidSection)?;
        let body_end = self
            .sections
            .get(section_index + 1)
            .map_or(self.body.len(), |next| next.start_block_index);
        for block in &self.body[section.start_block_index..body_end] {
            if let BlockRef::Table(id) = block {
                validate_table_style(&self.tables[id], page)?;
            }
        }
        for story in section.headers.iter().chain(section.footers.iter()) {
            for block in &story.blocks {
                if let BlockRef::Table(id) = block {
                    validate_table_style(&self.tables[id], page)?;
                }
            }
        }
        Ok(())
    }

    fn page_for_block(&self, id: DocumentId) -> Result<PageGeometry, DocumentError> {
        if let Some(index) = self.body.iter().position(|block| block.id() == id) {
            return Ok(self.section_for_body_index(index).page);
        }
        for section in &self.sections {
            if section
                .headers
                .iter()
                .chain(section.footers.iter())
                .any(|story| story.blocks.iter().any(|block| block.id() == id))
            {
                return Ok(section.page);
            }
        }
        Err(DocumentError::UnknownId(id))
    }

    fn ensure_added_totals(
        &self,
        blocks: usize,
        runs: usize,
        text: usize,
        cells: usize,
        replies: usize,
    ) -> Result<(), DocumentError> {
        ensure_sum(
            self.totals.blocks,
            blocks,
            MAX_DOCUMENT_BLOCKS,
            "document blocks",
        )?;
        ensure_sum(self.totals.runs, runs, MAX_TEXT_RUNS, "document text runs")?;
        ensure_sum(
            self.totals.text_utf16,
            text,
            MAX_TEXT_UTF16,
            "document text",
        )?;
        ensure_sum(
            self.totals.table_cells,
            cells,
            MAX_TABLE_CELLS,
            "document table cells",
        )?;
        ensure_sum(
            self.totals.replies,
            replies,
            MAX_COMMENT_REPLIES,
            "document comment replies",
        )?;
        Ok(())
    }

    fn add_totals(
        &mut self,
        blocks: usize,
        runs: usize,
        text: usize,
        cells: usize,
        replies: usize,
    ) {
        self.totals.blocks += blocks;
        self.totals.runs += runs;
        self.totals.text_utf16 += text;
        self.totals.table_cells += cells;
        self.totals.replies += replies;
    }

    fn ensure_replaced_totals(
        &self,
        old_runs: usize,
        next_runs: usize,
        old_text: usize,
        next_text: usize,
    ) -> Result<(), DocumentError> {
        let runs = self.totals.runs - old_runs;
        let text = self.totals.text_utf16 - old_text;
        ensure_sum(runs, next_runs, MAX_TEXT_RUNS, "document text runs")?;
        ensure_sum(text, next_text, MAX_TEXT_UTF16, "document text")?;
        Ok(())
    }

    fn replace_run_text_totals(
        &mut self,
        old_runs: usize,
        next_runs: usize,
        old_text: usize,
        next_text: usize,
    ) {
        self.totals.runs = self.totals.runs - old_runs + next_runs;
        self.totals.text_utf16 = self.totals.text_utf16 - old_text + next_text;
    }
}

fn validate_paragraph_for_command(
    paragraph: &Paragraph,
    totals: &mut ModelTotals,
) -> Result<(), DocumentError> {
    validate_paragraph_style(&paragraph.style)?;
    for run in &paragraph.runs {
        validate_text(&run.text)?;
        validate_text_style(&run.style)?;
        totals.runs += 1;
        totals.text_utf16 += utf16_len(&run.text);
    }
    Ok(())
}

fn validate_section_ids(document: &Document, ids: SectionIds) -> Result<(), DocumentError> {
    let expected = [
        (ids.section, DocumentIdKind::Section),
        (ids.header_default, DocumentIdKind::Header),
        (ids.header_first, DocumentIdKind::Header),
        (ids.header_even, DocumentIdKind::Header),
        (ids.footer_default, DocumentIdKind::Footer),
        (ids.footer_first, DocumentIdKind::Footer),
        (ids.footer_even, DocumentIdKind::Footer),
    ];
    let mut unique = BTreeSet::new();
    for (id, kind) in expected {
        validate_id(id, kind, document.id_namespace)?;
        if document.contains_id(id) || !unique.insert(id) {
            return Err(DocumentError::DuplicateId(id));
        }
    }
    Ok(())
}

fn style_patch_is_empty(style: &TextStylePatch) -> bool {
    style.font_family.is_none()
        && style.font_size_pt.is_none()
        && style.color.is_none()
        && style.bold.is_none()
        && style.italic.is_none()
        && style.underline.is_none()
        && style.strike.is_none()
}

fn ensure_sum(
    current: usize,
    addition: usize,
    maximum: usize,
    label: &'static str,
) -> Result<(), DocumentError> {
    if current
        .checked_add(addition)
        .is_none_or(|next| next > maximum)
    {
        Err(DocumentError::LimitExceeded(label))
    } else {
        Ok(())
    }
}
