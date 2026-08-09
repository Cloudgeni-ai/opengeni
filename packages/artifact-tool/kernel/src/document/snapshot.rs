use std::collections::{BTreeMap, BTreeSet};

use sha2::{Digest, Sha256};

use super::model::{
    BlockRef, CommentThread, Document, Paragraph, Section, SectionStories, Story, Table,
    TrackedChange,
};
use super::types::{
    CommentReply, DocumentError, DocumentId, DocumentIdKind, ListKind, ListStyle, PageGeometry,
    ParagraphAlignment, ParagraphStyle, TableStyle, TextRange, TextRun, TextStyle,
    TrackedChangeKind, MAX_COMMENTS, MAX_COMMENT_REPLIES, MAX_DOCUMENT_BLOCKS,
    MAX_DOCUMENT_SECTIONS, MAX_TABLE_CELLS, MAX_TEXT_RUNS, MAX_TEXT_UTF16, MAX_TRACKED_CHANGES,
};

const MAGIC: [u8; 8] = *b"OGADOC01";
pub const DOCUMENT_SNAPSHOT_VERSION: u16 = 1;
const SNAPSHOT_FLAG_PAGE_EXTRAS: u16 = 1;
const SNAPSHOT_SUPPORTED_FLAGS: u16 = SNAPSHOT_FLAG_PAGE_EXTRAS;
const HEADER_BYTES: usize = 8 + 2 + 2 + 8;
const CHECKSUM_BYTES: usize = 32;
const MAX_SNAPSHOT_PAYLOAD_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_DOCUMENT_SNAPSHOT_BYTES: usize =
    HEADER_BYTES + MAX_SNAPSHOT_PAYLOAD_BYTES + CHECKSUM_BYTES;
const MAX_STRING_BYTES: usize = 64 * 1024 * 1024;

pub fn encode_document_snapshot(document: &Document) -> Result<Vec<u8>, DocumentError> {
    document.validate()?;
    let has_page_extras = document
        .sections
        .iter()
        .any(|section| has_non_default_page_extras(section.page));
    let mut encoder = Encoder::default();
    encoder.u64(document.id_namespace);
    encoder.u64(document.next_id);
    encoder.u64(document.revision);
    encoder.optional_bool(document.explicit_even_and_odd_headers);
    encoder.optional_bool(document.explicit_track_revisions);
    encode_blocks(&mut encoder, document, &document.body)?;
    encoder.count(document.sections.len())?;
    for section in &document.sections {
        encoder.id(section.id);
        encoder.count(section.start_block_index)?;
        encoder.optional_bool(section.title_page);
        encoder.page(section.page);
        encode_story_group(&mut encoder, document, &section.headers)?;
        encode_story_group(&mut encoder, document, &section.footers)?;
    }
    encoder.count(document.comment_order.len())?;
    for id in &document.comment_order {
        let comment = document
            .comments
            .get(id)
            .ok_or(DocumentError::InvalidSnapshot("missing ordered comment"))?;
        encoder.id(comment.id);
        encoder.id(comment.block_id);
        encoder.u32(comment.range.start);
        encoder.u32(comment.range.end);
        encoder.bool(comment.resolved);
        encoder.count(comment.replies.len())?;
        for reply in &comment.replies {
            encoder.string(&reply.author)?;
            encoder.string(&reply.text)?;
            encoder.string(&reply.created_at)?;
        }
    }
    encoder.count(document.change_order.len())?;
    for id in &document.change_order {
        let change = document
            .changes
            .get(id)
            .ok_or(DocumentError::InvalidSnapshot(
                "missing ordered tracked change",
            ))?;
        encoder.id(change.id);
        encoder.id(change.block_id);
        encoder.u8(match change.kind {
            TrackedChangeKind::Insert => 1,
            TrackedChangeKind::Delete => 2,
        });
        encoder.u32(change.range.start);
        encoder.u32(change.range.end);
        encoder.string(&change.author)?;
        encoder.string(&change.created_at)?;
    }
    if has_page_extras {
        encoder.count(
            document
                .sections
                .iter()
                .filter(|section| has_non_default_page_extras(section.page))
                .count(),
        )?;
        for (index, section) in document.sections.iter().enumerate() {
            if !has_non_default_page_extras(section.page) {
                continue;
            }
            encoder.count(index)?;
            encoder.f64(section.page.header_pt);
            encoder.f64(section.page.footer_pt);
            encoder.f64(section.page.gutter_pt);
        }
    }
    if encoder.bytes.len() > MAX_SNAPSHOT_PAYLOAD_BYTES {
        return Err(DocumentError::LimitExceeded("document snapshot bytes"));
    }
    let payload_len = u64::try_from(encoder.bytes.len())
        .map_err(|_| DocumentError::LimitExceeded("document snapshot bytes"))?;
    let checksum = Sha256::digest(&encoder.bytes);
    let capacity = HEADER_BYTES
        .checked_add(encoder.bytes.len())
        .and_then(|value| value.checked_add(CHECKSUM_BYTES))
        .ok_or(DocumentError::LimitExceeded("document snapshot bytes"))?;
    let mut output = Vec::with_capacity(capacity);
    output.extend_from_slice(&MAGIC);
    output.extend_from_slice(&DOCUMENT_SNAPSHOT_VERSION.to_le_bytes());
    output.extend_from_slice(
        &(if has_page_extras {
            SNAPSHOT_FLAG_PAGE_EXTRAS
        } else {
            0
        })
        .to_le_bytes(),
    );
    output.extend_from_slice(&payload_len.to_le_bytes());
    output.extend_from_slice(&encoder.bytes);
    output.extend_from_slice(&checksum);
    Ok(output)
}

pub fn decode_document_snapshot(bytes: &[u8]) -> Result<Document, DocumentError> {
    if bytes.len() < HEADER_BYTES + CHECKSUM_BYTES {
        return Err(DocumentError::SnapshotTruncated);
    }
    if bytes.len() > MAX_DOCUMENT_SNAPSHOT_BYTES {
        return Err(DocumentError::LimitExceeded("document snapshot bytes"));
    }
    if bytes[..8] != MAGIC {
        return Err(DocumentError::BadSnapshotMagic);
    }
    let version = u16::from_le_bytes([bytes[8], bytes[9]]);
    if version != DOCUMENT_SNAPSHOT_VERSION {
        return Err(DocumentError::UnsupportedSnapshotVersion(version));
    }
    let snapshot_flags = u16::from_le_bytes([bytes[10], bytes[11]]);
    if snapshot_flags & !SNAPSHOT_SUPPORTED_FLAGS != 0 {
        return Err(DocumentError::NonCanonicalSnapshot(
            "unknown document snapshot flags are set",
        ));
    }
    let payload_len = u64::from_le_bytes(
        bytes[12..20]
            .try_into()
            .map_err(|_| DocumentError::SnapshotTruncated)?,
    );
    let payload_len = usize::try_from(payload_len)
        .map_err(|_| DocumentError::LimitExceeded("document snapshot bytes"))?;
    if payload_len > MAX_SNAPSHOT_PAYLOAD_BYTES {
        return Err(DocumentError::LimitExceeded("document snapshot bytes"));
    }
    let expected = HEADER_BYTES
        .checked_add(payload_len)
        .and_then(|value| value.checked_add(CHECKSUM_BYTES))
        .ok_or(DocumentError::LimitExceeded("document snapshot bytes"))?;
    if bytes.len() != expected {
        return Err(if bytes.len() < expected {
            DocumentError::SnapshotTruncated
        } else {
            DocumentError::SnapshotTrailingBytes
        });
    }
    let payload_end = HEADER_BYTES + payload_len;
    let payload = &bytes[HEADER_BYTES..payload_end];
    if Sha256::digest(payload).as_slice() != &bytes[payload_end..] {
        return Err(DocumentError::SnapshotChecksumMismatch);
    }
    let mut decoder = Decoder::new(payload);
    let id_namespace = decoder.u64()?;
    let next_id = decoder.u64()?;
    let revision = decoder.u64()?;
    let explicit_even_and_odd_headers = decoder.optional_bool()?;
    let explicit_track_revisions = decoder.optional_bool()?;
    let mut paragraphs = BTreeMap::new();
    let mut tables = BTreeMap::new();
    let mut page_breaks = BTreeSet::new();
    let body = decode_blocks(
        &mut decoder,
        id_namespace,
        true,
        &mut paragraphs,
        &mut tables,
        &mut page_breaks,
    )?;
    let section_count = decoder.count(MAX_DOCUMENT_SECTIONS)?;
    if section_count == 0 {
        return Err(DocumentError::InvalidSection);
    }
    let mut sections = Vec::new();
    sections
        .try_reserve_exact(section_count)
        .map_err(|_| DocumentError::LimitExceeded("document sections"))?;
    for _ in 0..section_count {
        let id = decoder.id(DocumentIdKind::Section, id_namespace)?;
        let start_block_index = decoder.count(MAX_DOCUMENT_BLOCKS)?;
        let title_page = decoder.optional_bool()?;
        let page = decoder.page()?;
        let headers = decode_story_group(
            &mut decoder,
            id_namespace,
            DocumentIdKind::Header,
            &mut paragraphs,
            &mut tables,
            &mut page_breaks,
        )?;
        let footers = decode_story_group(
            &mut decoder,
            id_namespace,
            DocumentIdKind::Footer,
            &mut paragraphs,
            &mut tables,
            &mut page_breaks,
        )?;
        sections.push(Section {
            id,
            start_block_index,
            title_page,
            page,
            headers,
            footers,
        });
    }
    let comment_count = decoder.count(MAX_COMMENTS)?;
    let mut comment_order = Vec::new();
    let mut comments = BTreeMap::new();
    comment_order
        .try_reserve_exact(comment_count)
        .map_err(|_| DocumentError::LimitExceeded("document comments"))?;
    for _ in 0..comment_count {
        let id = decoder.id(DocumentIdKind::Comment, id_namespace)?;
        let block_id = decoder.id(DocumentIdKind::Paragraph, id_namespace)?;
        let range = TextRange {
            start: decoder.u32()?,
            end: decoder.u32()?,
        };
        let resolved = decoder.bool()?;
        let reply_count = decoder.count(MAX_COMMENT_REPLIES)?;
        if reply_count == 0 {
            return Err(DocumentError::InvalidComment);
        }
        decoder.claim_replies(reply_count)?;
        let mut replies = Vec::new();
        replies
            .try_reserve_exact(reply_count)
            .map_err(|_| DocumentError::LimitExceeded("document comment replies"))?;
        for _ in 0..reply_count {
            let author = decoder.string()?;
            let text = decoder.string()?;
            decoder.claim_text_utf16(text.encode_utf16().count())?;
            let created_at = decoder.string()?;
            replies.push(CommentReply {
                author,
                text,
                created_at,
            });
        }
        if comments
            .insert(
                id,
                CommentThread {
                    id,
                    block_id,
                    range,
                    resolved,
                    replies,
                },
            )
            .is_some()
        {
            return Err(DocumentError::DuplicateId(id));
        }
        comment_order.push(id);
    }
    let change_count = decoder.count(MAX_TRACKED_CHANGES)?;
    let mut change_order = Vec::new();
    let mut changes = BTreeMap::new();
    change_order
        .try_reserve_exact(change_count)
        .map_err(|_| DocumentError::LimitExceeded("document tracked changes"))?;
    for _ in 0..change_count {
        let id = decoder.id(DocumentIdKind::TrackedChange, id_namespace)?;
        let block_id = decoder.id(DocumentIdKind::Paragraph, id_namespace)?;
        let kind = match decoder.u8()? {
            1 => TrackedChangeKind::Insert,
            2 => TrackedChangeKind::Delete,
            _ => {
                return Err(DocumentError::NonCanonicalSnapshot(
                    "unknown tracked-change kind",
                ))
            }
        };
        let range = TextRange {
            start: decoder.u32()?,
            end: decoder.u32()?,
        };
        let author = decoder.string()?;
        let created_at = decoder.string()?;
        if changes
            .insert(
                id,
                TrackedChange {
                    id,
                    block_id,
                    kind,
                    range,
                    author,
                    created_at,
                },
            )
            .is_some()
        {
            return Err(DocumentError::DuplicateId(id));
        }
        change_order.push(id);
    }
    if snapshot_flags & SNAPSHOT_FLAG_PAGE_EXTRAS != 0 {
        let extras_count = decoder.count(section_count)?;
        if extras_count == 0 {
            return Err(DocumentError::NonCanonicalSnapshot(
                "empty document page extras",
            ));
        }
        let mut previous_index = None;
        for _ in 0..extras_count {
            let index = decoder.count(section_count - 1)?;
            if previous_index.is_some_and(|previous| index <= previous) {
                return Err(DocumentError::NonCanonicalSnapshot(
                    "document page extras are not strictly ordered",
                ));
            }
            previous_index = Some(index);
            let page = &mut sections[index].page;
            page.header_pt = decoder.f64()?;
            page.footer_pt = decoder.f64()?;
            page.gutter_pt = decoder.f64()?;
            if !has_non_default_page_extras(*page) {
                return Err(DocumentError::NonCanonicalSnapshot(
                    "redundant document page extras",
                ));
            }
        }
    }
    if !decoder.is_empty() {
        return Err(DocumentError::SnapshotTrailingBytes);
    }
    let mut document = Document {
        id_namespace,
        next_id,
        revision,
        explicit_even_and_odd_headers,
        explicit_track_revisions,
        body,
        sections,
        paragraphs,
        tables,
        page_breaks,
        comment_order,
        comments,
        change_order,
        changes,
        totals: Default::default(),
    };
    document.totals = document.recompute_totals()?;
    document.validate()?;
    // Strict canonical decode: every accepted snapshot must re-encode byte-for-byte.
    if encode_document_snapshot(&document)?.as_slice() != bytes {
        return Err(DocumentError::NonCanonicalSnapshot(
            "document snapshot has a non-canonical representation",
        ));
    }
    Ok(document)
}

fn encode_story_group(
    encoder: &mut Encoder,
    document: &Document,
    stories: &SectionStories,
) -> Result<(), DocumentError> {
    for story in [&stories.default, &stories.first, &stories.even] {
        encoder.id(story.id);
        encode_blocks(encoder, document, &story.blocks)?;
    }
    Ok(())
}

fn decode_story_group(
    decoder: &mut Decoder<'_>,
    namespace: u64,
    kind: DocumentIdKind,
    paragraphs: &mut BTreeMap<DocumentId, Paragraph>,
    tables: &mut BTreeMap<DocumentId, Table>,
    page_breaks: &mut BTreeSet<DocumentId>,
) -> Result<SectionStories, DocumentError> {
    let mut decode_story = || -> Result<Story, DocumentError> {
        let id = decoder.id(kind, namespace)?;
        let blocks = decode_blocks(decoder, namespace, false, paragraphs, tables, page_breaks)?;
        Ok(Story { id, blocks })
    };
    Ok(SectionStories {
        default: decode_story()?,
        first: decode_story()?,
        even: decode_story()?,
    })
}

fn encode_blocks(
    encoder: &mut Encoder,
    document: &Document,
    blocks: &[BlockRef],
) -> Result<(), DocumentError> {
    encoder.count(blocks.len())?;
    for block in blocks {
        match block {
            BlockRef::Paragraph(id) => {
                encoder.u8(1);
                let paragraph = document
                    .paragraphs
                    .get(id)
                    .ok_or(DocumentError::UnknownId(*id))?;
                encoder.id(paragraph.id);
                encode_runs(encoder, &paragraph.runs)?;
                encoder.paragraph_style(&paragraph.style)?;
            }
            BlockRef::Table(id) => {
                encoder.u8(2);
                let table = document
                    .tables
                    .get(id)
                    .ok_or(DocumentError::UnknownId(*id))?;
                encoder.id(table.id);
                encoder.count(table.rows.len())?;
                for row in &table.rows {
                    encoder.count(row.len())?;
                    for cell in row {
                        encode_runs(encoder, cell)?;
                    }
                }
                encoder.table_style(&table.style)?;
            }
            BlockRef::PageBreak(id) => {
                encoder.u8(3);
                encoder.id(*id);
            }
        }
    }
    Ok(())
}

fn decode_blocks(
    decoder: &mut Decoder<'_>,
    namespace: u64,
    allow_page_break: bool,
    paragraphs: &mut BTreeMap<DocumentId, Paragraph>,
    tables: &mut BTreeMap<DocumentId, Table>,
    page_breaks: &mut BTreeSet<DocumentId>,
) -> Result<Vec<BlockRef>, DocumentError> {
    let count = decoder.count(MAX_DOCUMENT_BLOCKS)?;
    decoder.claim_blocks(count)?;
    let mut blocks = Vec::new();
    blocks
        .try_reserve_exact(count)
        .map_err(|_| DocumentError::LimitExceeded("document blocks"))?;
    for _ in 0..count {
        match decoder.u8()? {
            1 => {
                let id = decoder.id(DocumentIdKind::Paragraph, namespace)?;
                let paragraph = Paragraph {
                    id,
                    runs: decode_runs(decoder)?,
                    style: decoder.paragraph_style()?,
                };
                if paragraphs.insert(id, paragraph).is_some() {
                    return Err(DocumentError::DuplicateId(id));
                }
                blocks.push(BlockRef::Paragraph(id));
            }
            2 => {
                let id = decoder.id(DocumentIdKind::Table, namespace)?;
                let row_count = decoder.count(MAX_TABLE_CELLS)?;
                if row_count == 0 {
                    return Err(DocumentError::InvalidTable);
                }
                let mut rows = Vec::new();
                rows.try_reserve_exact(row_count)
                    .map_err(|_| DocumentError::LimitExceeded("document table rows"))?;
                let mut cells = 0_usize;
                for _ in 0..row_count {
                    let column_count = decoder.count(MAX_TABLE_CELLS)?;
                    if column_count == 0 {
                        return Err(DocumentError::InvalidTable);
                    }
                    cells = cells
                        .checked_add(column_count)
                        .ok_or(DocumentError::LimitExceeded("document table cells"))?;
                    if cells > MAX_TABLE_CELLS {
                        return Err(DocumentError::LimitExceeded("document table cells"));
                    }
                    decoder.claim_table_cells(column_count)?;
                    let mut row = Vec::new();
                    row.try_reserve_exact(column_count)
                        .map_err(|_| DocumentError::LimitExceeded("document table cells"))?;
                    for _ in 0..column_count {
                        row.push(decode_runs(decoder)?);
                    }
                    rows.push(row);
                }
                let table = Table {
                    id,
                    rows,
                    style: decoder.table_style()?,
                };
                if tables.insert(id, table).is_some() {
                    return Err(DocumentError::DuplicateId(id));
                }
                blocks.push(BlockRef::Table(id));
            }
            3 if allow_page_break => {
                let id = decoder.id(DocumentIdKind::PageBreak, namespace)?;
                if !page_breaks.insert(id) {
                    return Err(DocumentError::DuplicateId(id));
                }
                blocks.push(BlockRef::PageBreak(id));
            }
            3 => {
                return Err(DocumentError::InvalidSnapshot(
                    "headers and footers cannot contain page breaks",
                ))
            }
            _ => {
                return Err(DocumentError::NonCanonicalSnapshot(
                    "unknown document block kind",
                ))
            }
        }
    }
    Ok(blocks)
}

fn encode_runs(encoder: &mut Encoder, runs: &[TextRun]) -> Result<(), DocumentError> {
    encoder.count(runs.len())?;
    for run in runs {
        encoder.string(&run.text)?;
        encoder.text_style(&run.style)?;
    }
    Ok(())
}

fn decode_runs(decoder: &mut Decoder<'_>) -> Result<Vec<TextRun>, DocumentError> {
    let count = decoder.count(MAX_TEXT_RUNS)?;
    decoder.claim_runs(count)?;
    let mut runs = Vec::new();
    runs.try_reserve_exact(count)
        .map_err(|_| DocumentError::LimitExceeded("document text runs"))?;
    for _ in 0..count {
        let text = decoder.string()?;
        decoder.claim_text_utf16(text.encode_utf16().count())?;
        runs.push(TextRun {
            text,
            style: decoder.text_style()?,
        });
    }
    Ok(runs)
}

#[derive(Default)]
struct Encoder {
    bytes: Vec<u8>,
}

impl Encoder {
    fn u8(&mut self, value: u8) {
        self.bytes.push(value);
    }

    fn u16(&mut self, value: u16) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn u32(&mut self, value: u32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn u64(&mut self, value: u64) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn f64(&mut self, value: f64) {
        self.bytes.extend_from_slice(&value.to_bits().to_le_bytes());
    }

    fn bool(&mut self, value: bool) {
        self.u8(u8::from(value));
    }

    fn optional_bool(&mut self, value: Option<bool>) {
        self.u8(match value {
            None => 0,
            Some(false) => 1,
            Some(true) => 2,
        });
    }

    fn optional_u8(&mut self, value: Option<u8>) {
        match value {
            None => self.u8(0),
            Some(value) => {
                self.u8(1);
                self.u8(value);
            }
        }
    }

    fn count(&mut self, value: usize) -> Result<(), DocumentError> {
        self.u32(
            u32::try_from(value)
                .map_err(|_| DocumentError::LimitExceeded("document snapshot count"))?,
        );
        Ok(())
    }

    fn string(&mut self, value: &str) -> Result<(), DocumentError> {
        if value.len() > MAX_STRING_BYTES || value.encode_utf16().count() > MAX_TEXT_UTF16 {
            return Err(DocumentError::LimitExceeded("document snapshot string"));
        }
        self.count(value.len())?;
        self.bytes.extend_from_slice(value.as_bytes());
        Ok(())
    }

    fn optional_string(&mut self, value: Option<&str>) -> Result<(), DocumentError> {
        match value {
            None => self.u8(0),
            Some(value) => {
                self.u8(1);
                self.string(value)?;
            }
        }
        Ok(())
    }

    fn optional_f64(&mut self, value: Option<f64>) {
        match value {
            None => self.u8(0),
            Some(value) => {
                self.u8(1);
                self.f64(value);
            }
        }
    }

    fn id(&mut self, id: DocumentId) {
        self.u8(id.kind().tag());
        self.u64(id.namespace());
        self.u64(id.counter());
    }

    fn page(&mut self, page: PageGeometry) {
        self.f64(page.width_pt);
        self.f64(page.height_pt);
        self.f64(page.margin_top_pt);
        self.f64(page.margin_right_pt);
        self.f64(page.margin_bottom_pt);
        self.f64(page.margin_left_pt);
    }

    fn text_style(&mut self, style: &TextStyle) -> Result<(), DocumentError> {
        let mut mask = 0_u8;
        mask |= u8::from(style.font_family.is_some());
        mask |= u8::from(style.font_size_pt.is_some()) << 1;
        mask |= u8::from(style.color.is_some()) << 2;
        mask |= u8::from(style.bold.is_some()) << 3;
        mask |= u8::from(style.italic.is_some()) << 4;
        mask |= u8::from(style.underline.is_some()) << 5;
        mask |= u8::from(style.strike.is_some()) << 6;
        self.u8(mask);
        if let Some(value) = &style.font_family {
            self.string(value)?;
        }
        if let Some(value) = style.font_size_pt {
            self.f64(value);
        }
        if let Some(value) = &style.color {
            self.string(value)?;
        }
        if let Some(value) = style.bold {
            self.bool(value);
        }
        if let Some(value) = style.italic {
            self.bool(value);
        }
        if let Some(value) = style.underline {
            self.bool(value);
        }
        if let Some(value) = style.strike {
            self.bool(value);
        }
        Ok(())
    }

    fn paragraph_style(&mut self, style: &ParagraphStyle) -> Result<(), DocumentError> {
        let mut mask = 0_u16;
        mask |= u16::from(style.heading_level.is_some());
        mask |= u16::from(style.alignment.is_some()) << 1;
        mask |= u16::from(style.space_before_pt.is_some()) << 2;
        mask |= u16::from(style.space_after_pt.is_some()) << 3;
        mask |= u16::from(style.line_height.is_some()) << 4;
        mask |= u16::from(style.keep_next.is_some()) << 5;
        mask |= u16::from(style.page_break_before.is_some()) << 6;
        mask |= u16::from(style.list.is_some()) << 7;
        self.u16(mask);
        if let Some(value) = style.heading_level {
            self.u8(value);
        }
        if let Some(value) = style.alignment {
            self.u8(match value {
                ParagraphAlignment::Left => 1,
                ParagraphAlignment::Center => 2,
                ParagraphAlignment::Right => 3,
                ParagraphAlignment::Justify => 4,
            });
        }
        if let Some(value) = style.space_before_pt {
            self.f64(value);
        }
        if let Some(value) = style.space_after_pt {
            self.f64(value);
        }
        if let Some(value) = style.line_height {
            self.f64(value);
        }
        if let Some(value) = style.keep_next {
            self.bool(value);
        }
        if let Some(value) = style.page_break_before {
            self.bool(value);
        }
        if let Some(value) = &style.list {
            self.u8(match value.kind {
                ListKind::Bullet => 1,
                ListKind::Number => 2,
            });
            self.optional_u8(value.level);
            self.optional_string(value.instance_id.as_deref())?;
        }
        Ok(())
    }

    fn table_style(&mut self, style: &TableStyle) -> Result<(), DocumentError> {
        let mut mask = 0_u8;
        mask |= u8::from(style.width_pt.is_some());
        mask |= u8::from(style.column_widths_pt.is_some()) << 1;
        mask |= u8::from(style.header_rows.is_some()) << 2;
        mask |= u8::from(style.cell_padding_pt.is_some()) << 3;
        mask |= u8::from(style.border_color.is_some()) << 4;
        mask |= u8::from(style.header_fill.is_some()) << 5;
        mask |= u8::from(style.allow_row_split.is_some()) << 6;
        self.u8(mask);
        self.optional_f64(style.width_pt);
        if let Some(widths) = &style.column_widths_pt {
            self.count(widths.len())?;
            for width in widths {
                self.f64(*width);
            }
        }
        if let Some(value) = style.header_rows {
            self.u32(value);
        }
        if let Some(value) = style.cell_padding_pt {
            self.f64(value);
        }
        if let Some(value) = &style.border_color {
            self.string(value)?;
        }
        if let Some(value) = &style.header_fill {
            self.string(value)?;
        }
        if let Some(value) = style.allow_row_split {
            self.bool(value);
        }
        Ok(())
    }
}

struct Decoder<'a> {
    bytes: &'a [u8],
    offset: usize,
    total_blocks: usize,
    total_runs: usize,
    total_text_utf16: usize,
    total_table_cells: usize,
    total_replies: usize,
}

impl<'a> Decoder<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            offset: 0,
            total_blocks: 0,
            total_runs: 0,
            total_text_utf16: 0,
            total_table_cells: 0,
            total_replies: 0,
        }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], DocumentError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(DocumentError::SnapshotTruncated)?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or(DocumentError::SnapshotTruncated)?;
        self.offset = end;
        Ok(value)
    }

    fn u8(&mut self) -> Result<u8, DocumentError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, DocumentError> {
        Ok(u16::from_le_bytes(
            self.take(2)?
                .try_into()
                .map_err(|_| DocumentError::SnapshotTruncated)?,
        ))
    }

    fn u32(&mut self) -> Result<u32, DocumentError> {
        Ok(u32::from_le_bytes(
            self.take(4)?
                .try_into()
                .map_err(|_| DocumentError::SnapshotTruncated)?,
        ))
    }

    fn u64(&mut self) -> Result<u64, DocumentError> {
        Ok(u64::from_le_bytes(
            self.take(8)?
                .try_into()
                .map_err(|_| DocumentError::SnapshotTruncated)?,
        ))
    }

    fn f64(&mut self) -> Result<f64, DocumentError> {
        let value = f64::from_bits(self.u64()?);
        if !value.is_finite() || (value == 0.0 && value.is_sign_negative()) {
            return Err(DocumentError::NonCanonicalSnapshot(
                "document numbers must be finite and encode zero with a positive sign",
            ));
        }
        Ok(value)
    }

    fn bool(&mut self) -> Result<bool, DocumentError> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(DocumentError::NonCanonicalSnapshot("invalid boolean")),
        }
    }

    fn optional_bool(&mut self) -> Result<Option<bool>, DocumentError> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some(false)),
            2 => Ok(Some(true)),
            _ => Err(DocumentError::NonCanonicalSnapshot(
                "invalid optional boolean",
            )),
        }
    }

    fn optional_u8(&mut self) -> Result<Option<u8>, DocumentError> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some(self.u8()?)),
            _ => Err(DocumentError::NonCanonicalSnapshot("invalid optional u8")),
        }
    }

    fn count(&mut self, maximum: usize) -> Result<usize, DocumentError> {
        let value = usize::try_from(self.u32()?)
            .map_err(|_| DocumentError::LimitExceeded("document snapshot count"))?;
        if value > maximum {
            return Err(DocumentError::LimitExceeded("document snapshot count"));
        }
        Ok(value)
    }

    fn claim_blocks(&mut self, count: usize) -> Result<(), DocumentError> {
        self.total_blocks = self
            .total_blocks
            .checked_add(count)
            .ok_or(DocumentError::LimitExceeded("document blocks"))?;
        if self.total_blocks > MAX_DOCUMENT_BLOCKS {
            return Err(DocumentError::LimitExceeded("document blocks"));
        }
        Ok(())
    }

    fn claim_runs(&mut self, count: usize) -> Result<(), DocumentError> {
        self.total_runs = self
            .total_runs
            .checked_add(count)
            .ok_or(DocumentError::LimitExceeded("document text runs"))?;
        if self.total_runs > MAX_TEXT_RUNS {
            return Err(DocumentError::LimitExceeded("document text runs"));
        }
        Ok(())
    }

    fn claim_text_utf16(&mut self, count: usize) -> Result<(), DocumentError> {
        self.total_text_utf16 = self
            .total_text_utf16
            .checked_add(count)
            .ok_or(DocumentError::LimitExceeded("document text"))?;
        if self.total_text_utf16 > MAX_TEXT_UTF16 {
            return Err(DocumentError::LimitExceeded("document text"));
        }
        Ok(())
    }

    fn claim_table_cells(&mut self, count: usize) -> Result<(), DocumentError> {
        self.total_table_cells = self
            .total_table_cells
            .checked_add(count)
            .ok_or(DocumentError::LimitExceeded("document table cells"))?;
        if self.total_table_cells > MAX_TABLE_CELLS {
            return Err(DocumentError::LimitExceeded("document table cells"));
        }
        Ok(())
    }

    fn claim_replies(&mut self, count: usize) -> Result<(), DocumentError> {
        self.total_replies = self
            .total_replies
            .checked_add(count)
            .ok_or(DocumentError::LimitExceeded("document comment replies"))?;
        if self.total_replies > MAX_COMMENT_REPLIES {
            return Err(DocumentError::LimitExceeded("document comment replies"));
        }
        Ok(())
    }

    fn string(&mut self) -> Result<String, DocumentError> {
        let length = self.count(MAX_STRING_BYTES)?;
        let bytes = self.take(length)?;
        let value = core::str::from_utf8(bytes)
            .map_err(|_| DocumentError::InvalidSnapshot("invalid UTF-8"))?;
        if value.encode_utf16().count() > MAX_TEXT_UTF16 {
            return Err(DocumentError::LimitExceeded("document snapshot string"));
        }
        Ok(value.to_owned())
    }

    fn optional_string(&mut self) -> Result<Option<String>, DocumentError> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some(self.string()?)),
            _ => Err(DocumentError::NonCanonicalSnapshot(
                "invalid optional string",
            )),
        }
    }

    fn optional_f64(&mut self) -> Result<Option<f64>, DocumentError> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some(self.f64()?)),
            _ => Err(DocumentError::NonCanonicalSnapshot(
                "invalid optional number",
            )),
        }
    }

    fn id(
        &mut self,
        expected_kind: DocumentIdKind,
        expected_namespace: u64,
    ) -> Result<DocumentId, DocumentError> {
        let kind = DocumentIdKind::from_tag(self.u8()?)?;
        let namespace = self.u64()?;
        let counter = self.u64()?;
        let id = DocumentId::new(kind, namespace, counter)?;
        if kind != expected_kind {
            return Err(DocumentError::WrongIdKind {
                id,
                expected: expected_kind,
            });
        }
        if namespace != expected_namespace {
            return Err(DocumentError::IdNamespaceMismatch);
        }
        Ok(id)
    }

    fn page(&mut self) -> Result<PageGeometry, DocumentError> {
        Ok(PageGeometry {
            width_pt: self.f64()?,
            height_pt: self.f64()?,
            margin_top_pt: self.f64()?,
            margin_right_pt: self.f64()?,
            margin_bottom_pt: self.f64()?,
            margin_left_pt: self.f64()?,
            ..PageGeometry::default()
        })
    }

    fn text_style(&mut self) -> Result<TextStyle, DocumentError> {
        let mask = self.u8()?;
        if mask & !0x7f != 0 {
            return Err(DocumentError::NonCanonicalSnapshot(
                "unknown text-style bits",
            ));
        }
        Ok(TextStyle {
            font_family: if mask & 1 != 0 {
                Some(self.string()?)
            } else {
                None
            },
            font_size_pt: if mask & 2 != 0 {
                Some(self.f64()?)
            } else {
                None
            },
            color: if mask & 4 != 0 {
                Some(self.string()?)
            } else {
                None
            },
            bold: if mask & 8 != 0 {
                Some(self.bool()?)
            } else {
                None
            },
            italic: if mask & 16 != 0 {
                Some(self.bool()?)
            } else {
                None
            },
            underline: if mask & 32 != 0 {
                Some(self.bool()?)
            } else {
                None
            },
            strike: if mask & 64 != 0 {
                Some(self.bool()?)
            } else {
                None
            },
        })
    }

    fn paragraph_style(&mut self) -> Result<ParagraphStyle, DocumentError> {
        let mask = self.u16()?;
        if mask & !0x00ff != 0 {
            return Err(DocumentError::NonCanonicalSnapshot(
                "unknown paragraph-style bits",
            ));
        }
        let heading_level = if mask & 1 != 0 {
            Some(self.u8()?)
        } else {
            None
        };
        let alignment = if mask & 2 != 0 {
            Some(match self.u8()? {
                1 => ParagraphAlignment::Left,
                2 => ParagraphAlignment::Center,
                3 => ParagraphAlignment::Right,
                4 => ParagraphAlignment::Justify,
                _ => {
                    return Err(DocumentError::NonCanonicalSnapshot(
                        "unknown paragraph alignment",
                    ))
                }
            })
        } else {
            None
        };
        let space_before_pt = if mask & 4 != 0 {
            Some(self.f64()?)
        } else {
            None
        };
        let space_after_pt = if mask & 8 != 0 {
            Some(self.f64()?)
        } else {
            None
        };
        let line_height = if mask & 16 != 0 {
            Some(self.f64()?)
        } else {
            None
        };
        let keep_next = if mask & 32 != 0 {
            Some(self.bool()?)
        } else {
            None
        };
        let page_break_before = if mask & 64 != 0 {
            Some(self.bool()?)
        } else {
            None
        };
        let list = if mask & 128 != 0 {
            let kind = match self.u8()? {
                1 => ListKind::Bullet,
                2 => ListKind::Number,
                _ => {
                    return Err(DocumentError::NonCanonicalSnapshot(
                        "unknown paragraph list kind",
                    ))
                }
            };
            Some(ListStyle {
                kind,
                level: self.optional_u8()?,
                instance_id: self.optional_string()?,
            })
        } else {
            None
        };
        Ok(ParagraphStyle {
            heading_level,
            alignment,
            space_before_pt,
            space_after_pt,
            line_height,
            keep_next,
            page_break_before,
            list,
        })
    }

    fn table_style(&mut self) -> Result<TableStyle, DocumentError> {
        let mask = self.u8()?;
        if mask & !0x7f != 0 {
            return Err(DocumentError::NonCanonicalSnapshot(
                "unknown table-style bits",
            ));
        }
        let encoded_width = self.optional_f64()?;
        if encoded_width.is_some() != (mask & 1 != 0) {
            return Err(DocumentError::NonCanonicalSnapshot(
                "table width mask mismatch",
            ));
        }
        let column_widths_pt = if mask & 2 != 0 {
            let count = self.count(MAX_TABLE_CELLS)?;
            let mut widths = Vec::new();
            widths
                .try_reserve_exact(count)
                .map_err(|_| DocumentError::LimitExceeded("table column widths"))?;
            for _ in 0..count {
                widths.push(self.f64()?);
            }
            Some(widths)
        } else {
            None
        };
        Ok(TableStyle {
            width_pt: encoded_width,
            column_widths_pt,
            header_rows: if mask & 4 != 0 {
                Some(self.u32()?)
            } else {
                None
            },
            cell_padding_pt: if mask & 8 != 0 {
                Some(self.f64()?)
            } else {
                None
            },
            border_color: if mask & 16 != 0 {
                Some(self.string()?)
            } else {
                None
            },
            header_fill: if mask & 32 != 0 {
                Some(self.string()?)
            } else {
                None
            },
            allow_row_split: if mask & 64 != 0 {
                Some(self.bool()?)
            } else {
                None
            },
        })
    }

    fn is_empty(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

fn has_non_default_page_extras(page: PageGeometry) -> bool {
    page.header_pt != 36.0 || page.footer_pt != 36.0 || page.gutter_pt != 0.0
}

#[cfg(test)]
mod decoder_budget_tests {
    use super::*;

    #[test]
    fn aggregate_snapshot_budgets_fail_before_additional_allocation() {
        let mut decoder = Decoder::new(&[]);
        decoder.claim_blocks(MAX_DOCUMENT_BLOCKS).expect("blocks");
        assert!(matches!(
            decoder.claim_blocks(1),
            Err(DocumentError::LimitExceeded("document blocks"))
        ));

        let mut decoder = Decoder::new(&[]);
        decoder.claim_runs(MAX_TEXT_RUNS).expect("runs");
        assert!(matches!(
            decoder.claim_runs(1),
            Err(DocumentError::LimitExceeded("document text runs"))
        ));

        let mut decoder = Decoder::new(&[]);
        decoder
            .claim_text_utf16(MAX_TEXT_UTF16)
            .expect("document text");
        assert!(matches!(
            decoder.claim_text_utf16(1),
            Err(DocumentError::LimitExceeded("document text"))
        ));

        let mut decoder = Decoder::new(&[]);
        decoder
            .claim_table_cells(MAX_TABLE_CELLS)
            .expect("table cells");
        assert!(matches!(
            decoder.claim_table_cells(1),
            Err(DocumentError::LimitExceeded("document table cells"))
        ));

        let mut decoder = Decoder::new(&[]);
        decoder.claim_replies(MAX_COMMENT_REPLIES).expect("replies");
        assert!(matches!(
            decoder.claim_replies(1),
            Err(DocumentError::LimitExceeded("document comment replies"))
        ));
    }
}
