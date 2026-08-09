//! Bounded byte ABI for the native structured-document kernel.
//!
//! These envelopes are modality-specific and deliberately do not alter the
//! frozen spreadsheet OGAKC/OGAKQ or collaboration OGATX/OGACO bytes.

use std::collections::BTreeMap;

use opengeni_artifact_kernel::document::{
    decode_document_snapshot, encode_document_snapshot, CommentReply, CommentThread, Document,
    DocumentBatch, DocumentBatchError, DocumentBatchReceipt, DocumentCommand, DocumentError,
    DocumentId, DocumentIdKind, DocumentProjection, DocumentProjectionItem, DocumentQuery,
    DocumentQueryError, DocumentQueryLimits, DocumentSummaryProjection, ListKind, ListStyle,
    PageGeometry, PageGeometryProjection, Paragraph, ParagraphAlignment, ParagraphStyle,
    ReviewItem, SectionIds, SectionProjection, StoryKind, StoryTarget, StoryVariant, Table,
    TableStyle, TextRange, TextRun, TextStyle, TextStylePatch, TrackedChange, TrackedChangeKind,
    MAX_COMMENT_REPLIES, MAX_DOCUMENT_BLOCKS, MAX_DOCUMENT_SECTIONS, MAX_TABLE_CELLS,
    MAX_TEXT_RUNS, MAX_TEXT_UTF16,
};
use sha2::{Digest, Sha256};

use super::{
    checksum, decode_namespace, validate_limits, BindingError, BindingLimits, NATIVE_LIMITS,
};

pub const DOCUMENT_COMMAND_VERSION: u16 = 1;
pub const DOCUMENT_QUERY_VERSION: u16 = 1;
pub const DOCUMENT_QUERY_RESPONSE_VERSION: u16 = 1;
pub const DOCUMENT_RECEIPT_VERSION: u16 = 1;
pub const MAX_DOCUMENT_COMMANDS: usize = 4_096;
pub const MAX_DOCUMENT_COMMAND_STRING_BYTES: usize = 40 * 1024 * 1024;
pub const MAX_DOCUMENT_QUERY_BYTES: usize = 256;
pub const MAX_DOCUMENT_QUERY_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

const COMMAND_MAGIC: [u8; 8] = *b"OGADC001";
const QUERY_MAGIC: [u8; 8] = *b"OGADQ001";
const QUERY_RESPONSE_MAGIC: [u8; 8] = *b"OGADP001";
const RECEIPT_MAGIC: [u8; 8] = *b"OGADR001";
const HEADER_BYTES: usize = 8 + 2 + 2 + 4 + 8;
const CHECKSUM_BYTES: usize = 8;
const QUERY_RESPONSE_EXTENSION_MARKER: u8 = 0xff;
const PAGE_EXTRAS_EXTENSION_VERSION: u8 = 1;
const MAX_CREATED_IDS_PER_COMMAND: usize = 7;
const ENCODED_DOCUMENT_ID_BYTES: usize = 17;
const MAX_DOCUMENT_RECEIPT_BYTES: usize = HEADER_BYTES
    + 8
    + 4
    + 4
    + MAX_DOCUMENT_COMMANDS * MAX_CREATED_IDS_PER_COMMAND * ENCODED_DOCUMENT_ID_BYTES
    + CHECKSUM_BYTES;

pub fn create_document(namespace_envelope: &[u8]) -> Result<Vec<u8>, BindingError> {
    create_document_with_limits(namespace_envelope, NATIVE_LIMITS)
}

pub fn create_document_with_limits(
    namespace_envelope: &[u8],
    limits: BindingLimits,
) -> Result<Vec<u8>, BindingError> {
    DocumentBindingSession::create_with_limits(namespace_envelope, limits)?.snapshot()
}

pub fn apply_document_commands(
    snapshot: &[u8],
    command_envelope: &[u8],
) -> Result<Vec<u8>, BindingError> {
    apply_document_commands_with_limits(snapshot, command_envelope, NATIVE_LIMITS)
}

pub fn apply_document_commands_with_limits(
    snapshot: &[u8],
    command_envelope: &[u8],
    limits: BindingLimits,
) -> Result<Vec<u8>, BindingError> {
    let mut session = DocumentBindingSession::open_with_limits(snapshot, limits)?;
    session.apply_commands(command_envelope)?;
    session.snapshot()
}

pub fn canonicalize_document_snapshot(snapshot: &[u8]) -> Result<Vec<u8>, BindingError> {
    canonicalize_document_snapshot_with_limits(snapshot, NATIVE_LIMITS)
}

pub fn canonicalize_document_snapshot_with_limits(
    snapshot: &[u8],
    limits: BindingLimits,
) -> Result<Vec<u8>, BindingError> {
    DocumentBindingSession::open_with_limits(snapshot, limits)?.snapshot()
}

pub fn query_document(snapshot: &[u8], query_envelope: &[u8]) -> Result<Vec<u8>, BindingError> {
    query_document_with_limits(snapshot, query_envelope, NATIVE_LIMITS)
}

pub fn query_document_with_limits(
    snapshot: &[u8],
    query_envelope: &[u8],
    limits: BindingLimits,
) -> Result<Vec<u8>, BindingError> {
    DocumentBindingSession::open_with_limits(snapshot, limits)?.query(query_envelope)
}

#[derive(Clone, Debug)]
pub struct DocumentBindingSession {
    document: Option<Document>,
    snapshot_size_upper_bound: usize,
    limits: BindingLimits,
}

impl DocumentBindingSession {
    pub fn create(namespace_envelope: &[u8]) -> Result<Self, BindingError> {
        Self::create_with_limits(namespace_envelope, NATIVE_LIMITS)
    }

    pub fn create_with_limits(
        namespace_envelope: &[u8],
        limits: BindingLimits,
    ) -> Result<Self, BindingError> {
        validate_limits(limits)?;
        let namespace = decode_namespace(namespace_envelope)?;
        let document = Document::new(namespace).map_err(map_document_error)?;
        let size = encode_document_snapshot(&document)
            .map_err(map_document_error)?
            .len();
        check_snapshot_bound(size, limits)?;
        Ok(Self {
            document: Some(document),
            snapshot_size_upper_bound: size,
            limits,
        })
    }

    pub fn open(snapshot: &[u8]) -> Result<Self, BindingError> {
        Self::open_with_limits(snapshot, NATIVE_LIMITS)
    }

    pub fn open_with_limits(snapshot: &[u8], limits: BindingLimits) -> Result<Self, BindingError> {
        validate_limits(limits)?;
        check_snapshot_bound(snapshot.len(), limits)?;
        let document = decode_document_snapshot(snapshot).map_err(map_document_error)?;
        Ok(Self {
            document: Some(document),
            snapshot_size_upper_bound: snapshot.len(),
            limits,
        })
    }

    pub fn apply_commands(&mut self, envelope: &[u8]) -> Result<Vec<u8>, BindingError> {
        self.ensure_open()?;
        if envelope.len() > self.limits.max_command_bytes {
            return Err(BindingError::Limit("document command envelope"));
        }
        let batch =
            decode_document_command_batch_with_limit(envelope, self.limits.max_command_bytes)?;
        let dynamic_growth = document_dynamic_growth_bound(
            self.document.as_ref().ok_or(BindingError::Closed)?,
            &batch,
        )?;
        let growth_bound = envelope
            .len()
            .checked_mul(2)
            .and_then(|value| value.checked_add(batch.commands().len().saturating_mul(64)))
            .and_then(|value| value.checked_add(dynamic_growth))
            .ok_or(BindingError::Limit("document snapshot growth"))?;
        if self
            .snapshot_size_upper_bound
            .checked_add(growth_bound)
            .is_none_or(|size| size > self.limits.max_snapshot_bytes)
        {
            self.snapshot_size_upper_bound = self.snapshot()?.len();
        }
        let needs_probe = self
            .snapshot_size_upper_bound
            .checked_add(growth_bound)
            .is_none_or(|size| size > self.limits.max_snapshot_bytes);
        if needs_probe && !self.limits.allow_boundary_probe {
            return Err(BindingError::Limit("document snapshot growth"));
        }
        let transaction = self
            .document
            .as_mut()
            .ok_or(BindingError::Closed)?
            .begin_batch(&batch)
            .map_err(map_document_batch_error)?;
        let exact_snapshot_size = if needs_probe {
            let snapshot =
                encode_document_snapshot(transaction.document()).map_err(map_document_error)?;
            check_snapshot_bound(snapshot.len(), self.limits)?;
            Some(snapshot.len())
        } else {
            None
        };
        let encoded_receipt = encode_document_receipt(transaction.receipt())?;
        transaction.commit();
        if let Some(exact_snapshot_size) = exact_snapshot_size {
            self.snapshot_size_upper_bound = exact_snapshot_size;
        } else {
            self.snapshot_size_upper_bound = self
                .snapshot_size_upper_bound
                .checked_add(growth_bound)
                .ok_or(BindingError::Limit("document snapshot growth"))?;
        }
        Ok(encoded_receipt)
    }

    pub fn snapshot(&self) -> Result<Vec<u8>, BindingError> {
        let snapshot =
            encode_document_snapshot(self.document.as_ref().ok_or(BindingError::Closed)?)
                .map_err(map_document_error)?;
        check_snapshot_bound(snapshot.len(), self.limits)?;
        Ok(snapshot)
    }

    pub fn revision(&self) -> Result<u64, BindingError> {
        Ok(self
            .document
            .as_ref()
            .ok_or(BindingError::Closed)?
            .revision())
    }

    pub fn query(&self, envelope: &[u8]) -> Result<Vec<u8>, BindingError> {
        self.ensure_open()?;
        if envelope.len() > self.limits.max_command_bytes.min(MAX_DOCUMENT_QUERY_BYTES) {
            return Err(BindingError::Limit("document query envelope"));
        }
        let query = decode_document_query(envelope)?;
        let projection = self
            .document
            .as_ref()
            .ok_or(BindingError::Closed)?
            .query(query)
            .map_err(map_document_query_error)?;
        encode_document_query_response(&projection)
    }

    pub fn fork(&self) -> Result<Self, BindingError> {
        Ok(Self {
            document: Some(self.document.as_ref().ok_or(BindingError::Closed)?.clone()),
            snapshot_size_upper_bound: self.snapshot_size_upper_bound,
            limits: self.limits,
        })
    }

    pub fn state_hash(&self) -> Result<String, BindingError> {
        let digest = Sha256::digest(self.snapshot()?);
        Ok(format!("sha256:{digest:x}"))
    }

    pub fn close(&mut self) {
        self.document = None;
        self.snapshot_size_upper_bound = 0;
    }

    #[must_use]
    pub const fn is_closed(&self) -> bool {
        self.document.is_none()
    }

    fn ensure_open(&self) -> Result<(), BindingError> {
        if self.is_closed() {
            Err(BindingError::Closed)
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentBindingReceipt {
    pub revision: u64,
    pub command_count: u32,
    pub created_ids: Vec<DocumentId>,
}

pub fn encode_document_command_batch(batch: &DocumentBatch) -> Result<Vec<u8>, BindingError> {
    if batch.commands().len() > MAX_DOCUMENT_COMMANDS {
        return Err(BindingError::Limit("document command count"));
    }
    let mut payload =
        Encoder::new(super::MAX_COMMAND_ENVELOPE_BYTES - HEADER_BYTES - CHECKSUM_BYTES);
    for command in batch.commands() {
        encode_command(&mut payload, command)?;
    }
    encode_envelope(
        COMMAND_MAGIC,
        DOCUMENT_COMMAND_VERSION,
        batch.commands().len(),
        payload.finish(),
        super::MAX_COMMAND_ENVELOPE_BYTES,
    )
}

pub fn decode_document_command_batch(bytes: &[u8]) -> Result<DocumentBatch, BindingError> {
    decode_document_command_batch_with_limit(bytes, super::MAX_COMMAND_ENVELOPE_BYTES)
}

fn decode_document_command_batch_with_limit(
    bytes: &[u8],
    maximum: usize,
) -> Result<DocumentBatch, BindingError> {
    let (count, payload) = decode_envelope(
        bytes,
        COMMAND_MAGIC,
        DOCUMENT_COMMAND_VERSION,
        maximum,
        MAX_DOCUMENT_COMMANDS,
    )?;
    let mut decoder = Decoder::new(payload);
    let mut commands = Vec::new();
    commands
        .try_reserve_exact(count)
        .map_err(|_| BindingError::Limit("document command count"))?;
    for _ in 0..count {
        commands.push(decode_command(&mut decoder)?);
    }
    if !decoder.is_empty() {
        return Err(BindingError::TrailingBytes);
    }
    Ok(DocumentBatch::from_commands(commands))
}

pub fn decode_document_receipt(bytes: &[u8]) -> Result<DocumentBindingReceipt, BindingError> {
    let (count, payload) = decode_envelope(
        bytes,
        RECEIPT_MAGIC,
        DOCUMENT_RECEIPT_VERSION,
        MAX_DOCUMENT_RECEIPT_BYTES,
        MAX_DOCUMENT_COMMANDS,
    )?;
    let mut decoder = Decoder::new(payload);
    let revision = decoder.u64()?;
    if revision > opengeni_artifact_kernel::document::MAX_DOCUMENT_REVISION {
        return Err(BindingError::NonCanonical(
            "document receipt revision exceeds the JavaScript-safe bound",
        ));
    }
    let command_count = decoder.u32()?;
    if usize::try_from(command_count).map_err(|_| BindingError::Limit("document command count"))?
        != count
    {
        return Err(BindingError::NonCanonical(
            "document receipt command count mismatch",
        ));
    }
    let created_count = decoder.count(MAX_DOCUMENT_COMMANDS.saturating_mul(7))?;
    if created_count > count.saturating_mul(MAX_CREATED_IDS_PER_COMMAND) {
        return Err(BindingError::NonCanonical(
            "document receipt contains too many created ids",
        ));
    }
    let mut created_ids = Vec::new();
    created_ids
        .try_reserve_exact(created_count)
        .map_err(|_| BindingError::Limit("document receipt ids"))?;
    for _ in 0..created_count {
        created_ids.push(decoder.document_id()?);
    }
    if !decoder.is_empty() {
        return Err(BindingError::TrailingBytes);
    }
    Ok(DocumentBindingReceipt {
        revision,
        command_count,
        created_ids,
    })
}

fn encode_document_receipt(receipt: &DocumentBatchReceipt) -> Result<Vec<u8>, BindingError> {
    if receipt.command_count > MAX_DOCUMENT_COMMANDS
        || receipt.created_ids.len()
            > MAX_DOCUMENT_COMMANDS.saturating_mul(MAX_CREATED_IDS_PER_COMMAND)
    {
        return Err(BindingError::Limit("document receipt"));
    }
    let mut payload = Encoder::new(MAX_DOCUMENT_RECEIPT_BYTES - HEADER_BYTES - CHECKSUM_BYTES);
    payload.u64(receipt.revision)?;
    payload.u32(
        u32::try_from(receipt.command_count)
            .map_err(|_| BindingError::Limit("document command count"))?,
    )?;
    payload.count(receipt.created_ids.len())?;
    for id in &receipt.created_ids {
        payload.document_id(*id)?;
    }
    encode_envelope(
        RECEIPT_MAGIC,
        DOCUMENT_RECEIPT_VERSION,
        receipt.command_count,
        payload.finish(),
        MAX_DOCUMENT_RECEIPT_BYTES,
    )
}

pub fn encode_document_query(query: DocumentQuery) -> Result<Vec<u8>, BindingError> {
    let mut payload = Encoder::new(MAX_DOCUMENT_QUERY_BYTES - HEADER_BYTES - CHECKSUM_BYTES);
    match query {
        DocumentQuery::Summary => payload.u8(0)?,
        DocumentQuery::Body {
            start_block,
            limits,
        } => {
            validate_document_query_limits(limits)?;
            payload.u8(1)?;
            payload.usize(start_block)?;
            payload.query_limits(limits)?;
        }
        DocumentQuery::Story {
            section_id,
            kind,
            variant,
            start_block,
            limits,
        } => {
            validate_document_query_limits(limits)?;
            if section_id.kind() != DocumentIdKind::Section {
                return Err(BindingError::NonCanonical(
                    "document story query section id kind mismatch",
                ));
            }
            payload.u8(2)?;
            payload.document_id(section_id)?;
            payload.u8(story_kind_tag(kind))?;
            payload.u8(story_variant_tag(variant))?;
            payload.usize(start_block)?;
            payload.query_limits(limits)?;
        }
        DocumentQuery::Sections {
            start_section,
            limits,
        } => {
            validate_document_query_limits(limits)?;
            payload.u8(3)?;
            payload.usize(start_section)?;
            payload.query_limits(limits)?;
        }
        DocumentQuery::Review { start_item, limits } => {
            validate_document_query_limits(limits)?;
            payload.u8(4)?;
            payload.usize(start_item)?;
            payload.query_limits(limits)?;
        }
    }
    encode_envelope(
        QUERY_MAGIC,
        DOCUMENT_QUERY_VERSION,
        1,
        payload.finish(),
        MAX_DOCUMENT_QUERY_BYTES,
    )
}

pub fn decode_document_query(bytes: &[u8]) -> Result<DocumentQuery, BindingError> {
    let (count, payload) = decode_envelope(
        bytes,
        QUERY_MAGIC,
        DOCUMENT_QUERY_VERSION,
        MAX_DOCUMENT_QUERY_BYTES,
        1,
    )?;
    if count != 1 {
        return Err(BindingError::NonCanonical(
            "document query envelope must contain exactly one query",
        ));
    }
    let mut decoder = Decoder::new(payload);
    let query = match decoder.u8()? {
        0 => DocumentQuery::Summary,
        1 => DocumentQuery::Body {
            start_block: decoder.usize()?,
            limits: decoder.query_limits()?,
        },
        2 => DocumentQuery::Story {
            section_id: decoder.document_id_of_kind(DocumentIdKind::Section)?,
            kind: decoder.story_kind()?,
            variant: decoder.story_variant()?,
            start_block: decoder.usize()?,
            limits: decoder.query_limits()?,
        },
        3 => DocumentQuery::Sections {
            start_section: decoder.usize()?,
            limits: decoder.query_limits()?,
        },
        4 => DocumentQuery::Review {
            start_item: decoder.usize()?,
            limits: decoder.query_limits()?,
        },
        tag => return Err(BindingError::InvalidTag(tag)),
    };
    if !decoder.is_empty() {
        return Err(BindingError::TrailingBytes);
    }
    Ok(query)
}

pub fn encode_document_query_response(
    projection: &DocumentProjection,
) -> Result<Vec<u8>, BindingError> {
    if projection.items.len() > opengeni_artifact_kernel::document::MAX_QUERY_ITEMS
        || projection.projected_text_utf16
            > opengeni_artifact_kernel::document::MAX_QUERY_TEXT_UTF16
        || projection.projected_table_cells
            > opengeni_artifact_kernel::document::MAX_QUERY_TABLE_CELLS
        || projection.truncated != projection.next_cursor.is_some()
    {
        return Err(BindingError::Limit("document query response"));
    }
    let (actual_text, actual_cells) = document_projection_metrics(&projection.items)?;
    if actual_text != projection.projected_text_utf16
        || actual_cells != projection.projected_table_cells
    {
        return Err(BindingError::NonCanonical(
            "document query response metrics do not match its items",
        ));
    }
    let mut payload =
        Encoder::new(MAX_DOCUMENT_QUERY_RESPONSE_BYTES - HEADER_BYTES - CHECKSUM_BYTES);
    payload.u64(projection.revision)?;
    payload.optional_usize(projection.next_cursor)?;
    payload.bool(projection.truncated)?;
    payload.usize(projection.projected_text_utf16)?;
    payload.usize(projection.projected_table_cells)?;
    for item in &projection.items {
        encode_projection_item(&mut payload, item)?;
    }
    let page_extras_count = projection
        .items
        .iter()
        .filter_map(projection_page)
        .filter(|page| has_non_default_projection_page_extras(**page))
        .count();
    if page_extras_count > 0 {
        payload.u8(QUERY_RESPONSE_EXTENSION_MARKER)?;
        payload.u8(PAGE_EXTRAS_EXTENSION_VERSION)?;
        payload.count(page_extras_count)?;
        for (index, item) in projection.items.iter().enumerate() {
            let Some(page) = projection_page(item) else {
                continue;
            };
            if !has_non_default_projection_page_extras(*page) {
                continue;
            }
            payload.count(index)?;
            payload.i64(page.header_millipoints)?;
            payload.i64(page.footer_millipoints)?;
            payload.i64(page.gutter_millipoints)?;
        }
    }
    encode_envelope(
        QUERY_RESPONSE_MAGIC,
        DOCUMENT_QUERY_RESPONSE_VERSION,
        projection.items.len(),
        payload.finish(),
        MAX_DOCUMENT_QUERY_RESPONSE_BYTES,
    )
}

pub fn decode_document_query_response(bytes: &[u8]) -> Result<DocumentProjection, BindingError> {
    let (count, payload) = decode_envelope(
        bytes,
        QUERY_RESPONSE_MAGIC,
        DOCUMENT_QUERY_RESPONSE_VERSION,
        MAX_DOCUMENT_QUERY_RESPONSE_BYTES,
        opengeni_artifact_kernel::document::MAX_QUERY_ITEMS,
    )?;
    let mut decoder = Decoder::new(payload);
    let revision = decoder.u64()?;
    let next_cursor = decoder.optional_usize()?;
    let truncated = decoder.bool()?;
    if truncated != next_cursor.is_some() {
        return Err(BindingError::NonCanonical(
            "document query cursor and truncation flag disagree",
        ));
    }
    let projected_text_utf16 = decoder.usize_bounded(
        opengeni_artifact_kernel::document::MAX_QUERY_TEXT_UTF16,
        "document projected text",
    )?;
    let projected_table_cells = decoder.usize_bounded(
        opengeni_artifact_kernel::document::MAX_QUERY_TABLE_CELLS,
        "document projected table cells",
    )?;
    let mut items = Vec::new();
    items
        .try_reserve_exact(count)
        .map_err(|_| BindingError::Limit("document query items"))?;
    for _ in 0..count {
        items.push(decode_projection_item(&mut decoder)?);
    }
    if !decoder.is_empty() {
        decode_projection_page_extras(&mut decoder, &mut items)?;
    }
    if !decoder.is_empty() {
        return Err(BindingError::TrailingBytes);
    }
    let projection = DocumentProjection {
        revision,
        items,
        next_cursor,
        truncated,
        projected_text_utf16,
        projected_table_cells,
    };
    if encode_document_query_response(&projection)? != bytes {
        return Err(BindingError::NonCanonical(
            "document query response is not canonically encoded",
        ));
    }
    Ok(projection)
}

fn projection_page(item: &DocumentProjectionItem) -> Option<&PageGeometryProjection> {
    match item {
        DocumentProjectionItem::Summary(summary) => Some(&summary.page),
        DocumentProjectionItem::Section(section) => Some(&section.page),
        _ => None,
    }
}

fn projection_page_mut(item: &mut DocumentProjectionItem) -> Option<&mut PageGeometryProjection> {
    match item {
        DocumentProjectionItem::Summary(summary) => Some(&mut summary.page),
        DocumentProjectionItem::Section(section) => Some(&mut section.page),
        _ => None,
    }
}

fn has_non_default_projection_page_extras(page: PageGeometryProjection) -> bool {
    page.header_millipoints != 36_000
        || page.footer_millipoints != 36_000
        || page.gutter_millipoints != 0
}

fn decode_projection_page_extras(
    decoder: &mut Decoder<'_>,
    items: &mut [DocumentProjectionItem],
) -> Result<(), BindingError> {
    if items.is_empty() {
        return Err(BindingError::NonCanonical(
            "document page extras require a page item",
        ));
    }
    if decoder.u8()? != QUERY_RESPONSE_EXTENSION_MARKER {
        return Err(BindingError::NonCanonical(
            "unknown document query response extension",
        ));
    }
    let extension_version = decoder.u8()?;
    if extension_version != PAGE_EXTRAS_EXTENSION_VERSION {
        return Err(BindingError::UnsupportedVersion(u16::from(
            extension_version,
        )));
    }
    let extras_count = decoder.count(items.len())?;
    if extras_count == 0 {
        return Err(BindingError::NonCanonical(
            "empty document page extras extension",
        ));
    }
    let mut previous_index = None;
    for _ in 0..extras_count {
        let index = decoder.count(items.len().saturating_sub(1))?;
        if previous_index.is_some_and(|previous| index <= previous) {
            return Err(BindingError::NonCanonical(
                "document page extras are not strictly ordered",
            ));
        }
        previous_index = Some(index);
        let page = projection_page_mut(&mut items[index]).ok_or(BindingError::NonCanonical(
            "document page extras reference a non-page item",
        ))?;
        page.header_millipoints = decoder.i64()?;
        page.footer_millipoints = decoder.i64()?;
        page.gutter_millipoints = decoder.i64()?;
        if !has_non_default_projection_page_extras(*page) {
            return Err(BindingError::NonCanonical("redundant document page extras"));
        }
    }
    Ok(())
}

fn validate_document_query_limits(limits: DocumentQueryLimits) -> Result<(), BindingError> {
    if limits.max_items == 0
        || limits.max_items > opengeni_artifact_kernel::document::MAX_QUERY_ITEMS
        || limits.max_text_utf16 == 0
        || limits.max_text_utf16 > opengeni_artifact_kernel::document::MAX_QUERY_TEXT_UTF16
        || limits.max_table_cells == 0
        || limits.max_table_cells > opengeni_artifact_kernel::document::MAX_QUERY_TABLE_CELLS
    {
        return Err(BindingError::InvalidQuery("invalid document query limits"));
    }
    Ok(())
}

fn document_projection_metrics(
    items: &[DocumentProjectionItem],
) -> Result<(usize, usize), BindingError> {
    let mut text = 0_usize;
    let mut cells = 0_usize;
    for item in items {
        match item {
            DocumentProjectionItem::Summary(_)
            | DocumentProjectionItem::Section(_)
            | DocumentProjectionItem::PageBreak(_) => {}
            DocumentProjectionItem::Paragraph(paragraph) => {
                for run in &paragraph.runs {
                    text = text
                        .checked_add(run.text.encode_utf16().count())
                        .ok_or(BindingError::Limit("document projected text"))?;
                }
            }
            DocumentProjectionItem::Table(table) => {
                for row in &table.rows {
                    cells = cells
                        .checked_add(row.len())
                        .ok_or(BindingError::Limit("document projected table cells"))?;
                    for cell in row {
                        for run in cell {
                            text = text
                                .checked_add(run.text.encode_utf16().count())
                                .ok_or(BindingError::Limit("document projected text"))?;
                        }
                    }
                }
            }
            DocumentProjectionItem::Review(ReviewItem::Comment(comment)) => {
                for reply in &comment.replies {
                    for value in [&reply.author, &reply.text, &reply.created_at] {
                        text = text
                            .checked_add(value.encode_utf16().count())
                            .ok_or(BindingError::Limit("document projected text"))?;
                    }
                }
            }
            DocumentProjectionItem::Review(ReviewItem::TrackedChange(change)) => {
                text = text
                    .checked_add(change.author.encode_utf16().count())
                    .and_then(|value| value.checked_add(change.created_at.encode_utf16().count()))
                    .ok_or(BindingError::Limit("document projected text"))?;
            }
        }
    }
    if text > opengeni_artifact_kernel::document::MAX_QUERY_TEXT_UTF16
        || cells > opengeni_artifact_kernel::document::MAX_QUERY_TABLE_CELLS
    {
        return Err(BindingError::Limit("document query response"));
    }
    Ok((text, cells))
}

fn encode_projection_item(
    encoder: &mut Encoder,
    item: &DocumentProjectionItem,
) -> Result<(), BindingError> {
    match item {
        DocumentProjectionItem::Summary(summary) => {
            encoder.u8(0)?;
            encoder.u64(summary.id_namespace)?;
            encoder.u64(summary.revision)?;
            encoder.u64(summary.next_id_counter)?;
            encoder.usize(summary.block_count)?;
            encoder.usize(summary.section_count)?;
            encoder.usize(summary.comment_count)?;
            encoder.usize(summary.tracked_change_count)?;
            encoder.bool(summary.even_and_odd_headers)?;
            encoder.bool(summary.track_revisions)?;
            encoder.page_projection(summary.page)
        }
        DocumentProjectionItem::Section(section) => {
            ensure_document_id_kind(section.id, DocumentIdKind::Section)?;
            encoder.u8(1)?;
            encoder.document_id(section.id)?;
            encoder.usize(section.start_block_index)?;
            encoder.bool(section.title_page)?;
            encoder.page_projection(section.page)?;
            for count in section.header_block_counts {
                encoder.usize(count)?;
            }
            for count in section.footer_block_counts {
                encoder.usize(count)?;
            }
            Ok(())
        }
        DocumentProjectionItem::Paragraph(paragraph) => {
            ensure_document_id_kind(paragraph.id, DocumentIdKind::Paragraph)?;
            encoder.u8(2)?;
            encoder.document_id(paragraph.id)?;
            encoder.runs(&paragraph.runs)?;
            encoder.paragraph_style(&paragraph.style)
        }
        DocumentProjectionItem::Table(table) => {
            ensure_document_id_kind(table.id, DocumentIdKind::Table)?;
            encoder.u8(3)?;
            encoder.document_id(table.id)?;
            encoder.table_rows(&table.rows)?;
            encoder.table_style(&table.style)
        }
        DocumentProjectionItem::PageBreak(id) => {
            ensure_document_id_kind(*id, DocumentIdKind::PageBreak)?;
            encoder.u8(4)?;
            encoder.document_id(*id)
        }
        DocumentProjectionItem::Review(ReviewItem::Comment(comment)) => {
            ensure_document_id_kind(comment.id, DocumentIdKind::Comment)?;
            ensure_document_id_kind(comment.block_id, DocumentIdKind::Paragraph)?;
            encoder.u8(5)?;
            encoder.document_id(comment.id)?;
            encoder.document_id(comment.block_id)?;
            encoder.text_range(comment.range)?;
            encoder.bool(comment.resolved)?;
            encoder.count(comment.replies.len())?;
            for reply in &comment.replies {
                encoder.comment_reply(reply)?;
            }
            Ok(())
        }
        DocumentProjectionItem::Review(ReviewItem::TrackedChange(change)) => {
            ensure_document_id_kind(change.id, DocumentIdKind::TrackedChange)?;
            ensure_document_id_kind(change.block_id, DocumentIdKind::Paragraph)?;
            encoder.u8(6)?;
            encoder.document_id(change.id)?;
            encoder.document_id(change.block_id)?;
            encoder.u8(match change.kind {
                TrackedChangeKind::Insert => 1,
                TrackedChangeKind::Delete => 2,
            })?;
            encoder.text_range(change.range)?;
            encoder.string(&change.author)?;
            encoder.string(&change.created_at)
        }
    }
}

fn decode_projection_item(
    decoder: &mut Decoder<'_>,
) -> Result<DocumentProjectionItem, BindingError> {
    match decoder.u8()? {
        0 => Ok(DocumentProjectionItem::Summary(DocumentSummaryProjection {
            id_namespace: decoder.u64()?,
            revision: decoder.u64()?,
            next_id_counter: decoder.u64()?,
            block_count: decoder.usize_bounded(MAX_DOCUMENT_BLOCKS, "document block count")?,
            section_count: decoder
                .usize_bounded(MAX_DOCUMENT_SECTIONS, "document section count")?,
            comment_count: decoder.usize_bounded(
                opengeni_artifact_kernel::document::MAX_COMMENTS,
                "document comment count",
            )?,
            tracked_change_count: decoder.usize_bounded(
                opengeni_artifact_kernel::document::MAX_TRACKED_CHANGES,
                "document tracked-change count",
            )?,
            even_and_odd_headers: decoder.bool()?,
            track_revisions: decoder.bool()?,
            page: decoder.page_projection()?,
        })),
        1 => Ok(DocumentProjectionItem::Section(SectionProjection {
            id: decoder.document_id_of_kind(DocumentIdKind::Section)?,
            start_block_index: decoder
                .usize_bounded(MAX_DOCUMENT_BLOCKS, "document section block index")?,
            title_page: decoder.bool()?,
            page: decoder.page_projection()?,
            header_block_counts: [
                decoder.usize_bounded(MAX_DOCUMENT_BLOCKS, "document header blocks")?,
                decoder.usize_bounded(MAX_DOCUMENT_BLOCKS, "document header blocks")?,
                decoder.usize_bounded(MAX_DOCUMENT_BLOCKS, "document header blocks")?,
            ],
            footer_block_counts: [
                decoder.usize_bounded(MAX_DOCUMENT_BLOCKS, "document footer blocks")?,
                decoder.usize_bounded(MAX_DOCUMENT_BLOCKS, "document footer blocks")?,
                decoder.usize_bounded(MAX_DOCUMENT_BLOCKS, "document footer blocks")?,
            ],
        })),
        2 => Ok(DocumentProjectionItem::Paragraph(Paragraph {
            id: decoder.document_id_of_kind(DocumentIdKind::Paragraph)?,
            runs: decoder.runs()?,
            style: decoder.paragraph_style()?,
        })),
        3 => Ok(DocumentProjectionItem::Table(Table {
            id: decoder.document_id_of_kind(DocumentIdKind::Table)?,
            rows: decoder.table_rows()?,
            style: decoder.table_style()?,
        })),
        4 => Ok(DocumentProjectionItem::PageBreak(
            decoder.document_id_of_kind(DocumentIdKind::PageBreak)?,
        )),
        5 => {
            let id = decoder.document_id_of_kind(DocumentIdKind::Comment)?;
            let block_id = decoder.document_id_of_kind(DocumentIdKind::Paragraph)?;
            let range = decoder.text_range()?;
            let resolved = decoder.bool()?;
            let count = decoder.count(MAX_COMMENT_REPLIES)?;
            let mut replies = Vec::new();
            replies
                .try_reserve_exact(count)
                .map_err(|_| BindingError::Limit("document comment replies"))?;
            for _ in 0..count {
                replies.push(decoder.comment_reply()?);
            }
            Ok(DocumentProjectionItem::Review(ReviewItem::Comment(
                CommentThread {
                    id,
                    block_id,
                    range,
                    resolved,
                    replies,
                },
            )))
        }
        6 => Ok(DocumentProjectionItem::Review(ReviewItem::TrackedChange(
            TrackedChange {
                id: decoder.document_id_of_kind(DocumentIdKind::TrackedChange)?,
                block_id: decoder.document_id_of_kind(DocumentIdKind::Paragraph)?,
                kind: match decoder.u8()? {
                    1 => TrackedChangeKind::Insert,
                    2 => TrackedChangeKind::Delete,
                    tag => return Err(BindingError::InvalidTag(tag)),
                },
                range: decoder.text_range()?,
                author: decoder.string()?,
                created_at: decoder.string()?,
            },
        ))),
        tag => Err(BindingError::InvalidTag(tag)),
    }
}

fn check_snapshot_bound(size: usize, limits: BindingLimits) -> Result<(), BindingError> {
    if size > limits.max_snapshot_bytes {
        Err(BindingError::Limit("document snapshot envelope"))
    } else {
        Ok(())
    }
}

fn map_document_error(error: DocumentError) -> BindingError {
    BindingError::Kernel(format!("document: {error}"))
}

fn map_document_batch_error(error: DocumentBatchError) -> BindingError {
    BindingError::Kernel(format!("document batch: {error}"))
}

fn map_document_query_error(error: DocumentQueryError) -> BindingError {
    let message = match error {
        DocumentQueryError::InvalidLimits => "invalid document query limits",
        DocumentQueryError::UnknownSection(_) => "document query references an unknown section",
        DocumentQueryError::CursorOutOfBounds => "document query cursor is out of bounds",
        DocumentQueryError::FirstItemExceedsLimits => {
            "first complete document query item exceeds limits"
        }
        DocumentQueryError::InconsistentModel => "document query found inconsistent model state",
    };
    BindingError::InvalidQuery(message)
}

#[derive(Clone, Copy, Debug, Default)]
struct ParagraphGrowth {
    run_count: usize,
    maximum_style_bytes: usize,
}

fn document_dynamic_growth_bound(
    document: &Document,
    batch: &DocumentBatch,
) -> Result<usize, BindingError> {
    let mut paragraphs = BTreeMap::<DocumentId, ParagraphGrowth>::new();
    let mut growth = 0_usize;
    for command in batch.commands() {
        match command {
            DocumentCommand::AddParagraph { id, runs, .. } => {
                paragraphs.insert(*id, paragraph_growth(runs));
            }
            DocumentCommand::EditParagraph { id, style, .. } => {
                let info = paragraph_growth_for(document, &mut paragraphs, *id);
                let inserted_style = style.as_ref().map_or(0, text_style_encoded_size);
                let maximum_style_bytes = info.maximum_style_bytes.max(inserted_style);
                let split_growth = maximum_style_bytes
                    .checked_mul(2)
                    .ok_or(BindingError::Limit("document snapshot growth"))?;
                growth = growth
                    .checked_add(split_growth)
                    .ok_or(BindingError::Limit("document snapshot growth"))?;
                paragraphs.insert(
                    *id,
                    ParagraphGrowth {
                        run_count: info.run_count.saturating_add(2).min(MAX_TEXT_RUNS),
                        maximum_style_bytes,
                    },
                );
            }
            DocumentCommand::FormatParagraph { id, style, .. } => {
                let info = paragraph_growth_for(document, &mut paragraphs, *id);
                let patch_growth = text_style_patch_maximum_growth(style);
                let repeated = info
                    .run_count
                    .checked_mul(patch_growth)
                    .ok_or(BindingError::Limit("document snapshot growth"))?;
                let boundary = info
                    .maximum_style_bytes
                    .checked_add(patch_growth)
                    .and_then(|value| value.checked_mul(2))
                    .ok_or(BindingError::Limit("document snapshot growth"))?;
                growth = growth
                    .checked_add(repeated)
                    .and_then(|value| value.checked_add(boundary))
                    .ok_or(BindingError::Limit("document snapshot growth"))?;
                paragraphs.insert(
                    *id,
                    ParagraphGrowth {
                        run_count: info.run_count.saturating_add(2).min(MAX_TEXT_RUNS),
                        maximum_style_bytes: info
                            .maximum_style_bytes
                            .checked_add(patch_growth)
                            .ok_or(BindingError::Limit("document snapshot growth"))?,
                    },
                );
            }
            _ => {}
        }
    }
    Ok(growth)
}

fn paragraph_growth_for(
    document: &Document,
    cache: &mut BTreeMap<DocumentId, ParagraphGrowth>,
    id: DocumentId,
) -> ParagraphGrowth {
    if let Some(info) = cache.get(&id) {
        return *info;
    }
    let info = document
        .paragraph(id)
        .map_or_else(ParagraphGrowth::default, |paragraph| {
            paragraph_growth(&paragraph.runs)
        });
    cache.insert(id, info);
    info
}

fn paragraph_growth(runs: &[TextRun]) -> ParagraphGrowth {
    ParagraphGrowth {
        run_count: runs.len(),
        maximum_style_bytes: runs
            .iter()
            .map(|run| text_style_encoded_size(&run.style))
            .max()
            .unwrap_or(1),
    }
}

fn text_style_encoded_size(style: &TextStyle) -> usize {
    1 + style
        .font_family
        .as_ref()
        .map_or(0, |value| 4_usize.saturating_add(value.len()))
        + style.font_size_pt.map_or(0, |_| 8)
        + style
            .color
            .as_ref()
            .map_or(0, |value| 4_usize.saturating_add(value.len()))
        + [style.bold, style.italic, style.underline, style.strike]
            .into_iter()
            .flatten()
            .count()
}

fn text_style_patch_maximum_growth(patch: &TextStylePatch) -> usize {
    patch
        .font_family
        .as_ref()
        .and_then(Option::as_ref)
        .map_or(0, |value| 4_usize.saturating_add(value.len()))
        + patch.font_size_pt.flatten().map_or(0, |_| 8)
        + patch
            .color
            .as_ref()
            .and_then(Option::as_ref)
            .map_or(0, |value| 4_usize.saturating_add(value.len()))
        + [patch.bold, patch.italic, patch.underline, patch.strike]
            .into_iter()
            .filter(|value| value.is_some_and(|inner| inner.is_some()))
            .count()
}

fn encode_command(encoder: &mut Encoder, command: &DocumentCommand) -> Result<(), BindingError> {
    match command {
        DocumentCommand::SetDocumentFlags {
            even_and_odd_headers,
            track_revisions,
        } => {
            encoder.u8(0)?;
            encoder.optional_optional_bool(*even_and_odd_headers)?;
            encoder.optional_optional_bool(*track_revisions)
        }
        DocumentCommand::AddParagraph {
            target,
            id,
            runs,
            style,
        } => {
            ensure_document_id_kind(*id, DocumentIdKind::Paragraph)?;
            encoder.u8(1)?;
            encoder.story_target(*target)?;
            encoder.document_id(*id)?;
            encoder.runs(runs)?;
            encoder.paragraph_style(style)
        }
        DocumentCommand::EditParagraph {
            id,
            range,
            replacement,
            style,
        } => {
            ensure_document_id_kind(*id, DocumentIdKind::Paragraph)?;
            encoder.u8(2)?;
            encoder.document_id(*id)?;
            encoder.text_range(*range)?;
            encoder.content_string(replacement)?;
            encoder.optional_text_style(style.as_ref())
        }
        DocumentCommand::FormatParagraph { id, range, style } => {
            ensure_document_id_kind(*id, DocumentIdKind::Paragraph)?;
            encoder.u8(3)?;
            encoder.document_id(*id)?;
            encoder.text_range(*range)?;
            encoder.text_style_patch(style)
        }
        DocumentCommand::SetParagraphStyle { id, style } => {
            ensure_document_id_kind(*id, DocumentIdKind::Paragraph)?;
            encoder.u8(4)?;
            encoder.document_id(*id)?;
            encoder.paragraph_style(style)
        }
        DocumentCommand::AddTable {
            target,
            id,
            rows,
            style,
        } => {
            ensure_document_id_kind(*id, DocumentIdKind::Table)?;
            encoder.u8(5)?;
            encoder.story_target(*target)?;
            encoder.document_id(*id)?;
            encoder.table_rows(rows)?;
            encoder.table_style(style)
        }
        DocumentCommand::SetTableStyle { id, style } => {
            ensure_document_id_kind(*id, DocumentIdKind::Table)?;
            encoder.u8(6)?;
            encoder.document_id(*id)?;
            encoder.table_style(style)
        }
        DocumentCommand::AddPageBreak { id } => {
            ensure_document_id_kind(*id, DocumentIdKind::PageBreak)?;
            encoder.u8(7)?;
            encoder.document_id(*id)
        }
        DocumentCommand::AddSection {
            ids,
            page,
            title_page,
        } => {
            ensure_default_page_extras(*page)?;
            for (id, kind) in ids.all().into_iter().zip([
                DocumentIdKind::Section,
                DocumentIdKind::Header,
                DocumentIdKind::Header,
                DocumentIdKind::Header,
                DocumentIdKind::Footer,
                DocumentIdKind::Footer,
                DocumentIdKind::Footer,
            ]) {
                ensure_document_id_kind(id, kind)?;
            }
            encoder.u8(8)?;
            for id in ids.all() {
                encoder.document_id(id)?;
            }
            encoder.page(*page)?;
            encoder.optional_bool(*title_page)
        }
        DocumentCommand::SetSectionTitlePage { id, title_page } => {
            ensure_document_id_kind(*id, DocumentIdKind::Section)?;
            encoder.u8(9)?;
            encoder.document_id(*id)?;
            encoder.optional_bool(*title_page)
        }
        DocumentCommand::AddComment {
            id,
            paragraph_id,
            range,
            resolved,
            root,
        } => {
            ensure_document_id_kind(*id, DocumentIdKind::Comment)?;
            ensure_document_id_kind(*paragraph_id, DocumentIdKind::Paragraph)?;
            encoder.u8(10)?;
            encoder.document_id(*id)?;
            encoder.document_id(*paragraph_id)?;
            encoder.text_range(*range)?;
            encoder.bool(*resolved)?;
            encoder.comment_reply(root)
        }
        DocumentCommand::AddCommentReply { id, reply } => {
            ensure_document_id_kind(*id, DocumentIdKind::Comment)?;
            encoder.u8(11)?;
            encoder.document_id(*id)?;
            encoder.comment_reply(reply)
        }
        DocumentCommand::SetCommentResolved { id, resolved } => {
            ensure_document_id_kind(*id, DocumentIdKind::Comment)?;
            encoder.u8(12)?;
            encoder.document_id(*id)?;
            encoder.bool(*resolved)
        }
        DocumentCommand::AddTrackedChange {
            id,
            paragraph_id,
            range,
            kind,
            author,
            created_at,
        } => {
            ensure_document_id_kind(*id, DocumentIdKind::TrackedChange)?;
            ensure_document_id_kind(*paragraph_id, DocumentIdKind::Paragraph)?;
            encoder.u8(13)?;
            encoder.document_id(*id)?;
            encoder.document_id(*paragraph_id)?;
            encoder.text_range(*range)?;
            encoder.u8(match kind {
                TrackedChangeKind::Insert => 1,
                TrackedChangeKind::Delete => 2,
            })?;
            encoder.string(author)?;
            encoder.string(created_at)
        }
        DocumentCommand::SetSectionPage { id, page } => {
            ensure_document_id_kind(*id, DocumentIdKind::Section)?;
            encoder.u8(14)?;
            encoder.document_id(*id)?;
            encoder.page_with_extras(*page)
        }
    }
}

fn ensure_default_page_extras(page: PageGeometry) -> Result<(), BindingError> {
    if page.header_pt != 36.0 || page.footer_pt != 36.0 || page.gutter_pt != 0.0 {
        return Err(BindingError::NonCanonical(
            "section.add page extras require section.page.set",
        ));
    }
    Ok(())
}

fn ensure_document_id_kind(id: DocumentId, expected: DocumentIdKind) -> Result<(), BindingError> {
    if id.kind() != expected {
        return Err(BindingError::NonCanonical("document id kind mismatch"));
    }
    Ok(())
}

fn decode_command(decoder: &mut Decoder<'_>) -> Result<DocumentCommand, BindingError> {
    match decoder.u8()? {
        0 => Ok(DocumentCommand::SetDocumentFlags {
            even_and_odd_headers: decoder.optional_optional_bool()?,
            track_revisions: decoder.optional_optional_bool()?,
        }),
        1 => Ok(DocumentCommand::AddParagraph {
            target: decoder.story_target()?,
            id: decoder.document_id_of_kind(DocumentIdKind::Paragraph)?,
            runs: decoder.runs()?,
            style: decoder.paragraph_style()?,
        }),
        2 => Ok(DocumentCommand::EditParagraph {
            id: decoder.document_id_of_kind(DocumentIdKind::Paragraph)?,
            range: decoder.text_range()?,
            replacement: decoder.content_string()?,
            style: decoder.optional_text_style()?,
        }),
        3 => Ok(DocumentCommand::FormatParagraph {
            id: decoder.document_id_of_kind(DocumentIdKind::Paragraph)?,
            range: decoder.text_range()?,
            style: decoder.text_style_patch()?,
        }),
        4 => Ok(DocumentCommand::SetParagraphStyle {
            id: decoder.document_id_of_kind(DocumentIdKind::Paragraph)?,
            style: decoder.paragraph_style()?,
        }),
        5 => Ok(DocumentCommand::AddTable {
            target: decoder.story_target()?,
            id: decoder.document_id_of_kind(DocumentIdKind::Table)?,
            rows: decoder.table_rows()?,
            style: decoder.table_style()?,
        }),
        6 => Ok(DocumentCommand::SetTableStyle {
            id: decoder.document_id_of_kind(DocumentIdKind::Table)?,
            style: decoder.table_style()?,
        }),
        7 => Ok(DocumentCommand::AddPageBreak {
            id: decoder.document_id_of_kind(DocumentIdKind::PageBreak)?,
        }),
        8 => Ok(DocumentCommand::AddSection {
            ids: SectionIds {
                section: decoder.document_id_of_kind(DocumentIdKind::Section)?,
                header_default: decoder.document_id_of_kind(DocumentIdKind::Header)?,
                header_first: decoder.document_id_of_kind(DocumentIdKind::Header)?,
                header_even: decoder.document_id_of_kind(DocumentIdKind::Header)?,
                footer_default: decoder.document_id_of_kind(DocumentIdKind::Footer)?,
                footer_first: decoder.document_id_of_kind(DocumentIdKind::Footer)?,
                footer_even: decoder.document_id_of_kind(DocumentIdKind::Footer)?,
            },
            page: decoder.page()?,
            title_page: decoder.optional_bool()?,
        }),
        9 => Ok(DocumentCommand::SetSectionTitlePage {
            id: decoder.document_id_of_kind(DocumentIdKind::Section)?,
            title_page: decoder.optional_bool()?,
        }),
        10 => Ok(DocumentCommand::AddComment {
            id: decoder.document_id_of_kind(DocumentIdKind::Comment)?,
            paragraph_id: decoder.document_id_of_kind(DocumentIdKind::Paragraph)?,
            range: decoder.text_range()?,
            resolved: decoder.bool()?,
            root: decoder.comment_reply()?,
        }),
        11 => Ok(DocumentCommand::AddCommentReply {
            id: decoder.document_id_of_kind(DocumentIdKind::Comment)?,
            reply: decoder.comment_reply()?,
        }),
        12 => Ok(DocumentCommand::SetCommentResolved {
            id: decoder.document_id_of_kind(DocumentIdKind::Comment)?,
            resolved: decoder.bool()?,
        }),
        13 => Ok(DocumentCommand::AddTrackedChange {
            id: decoder.document_id_of_kind(DocumentIdKind::TrackedChange)?,
            paragraph_id: decoder.document_id_of_kind(DocumentIdKind::Paragraph)?,
            range: decoder.text_range()?,
            kind: match decoder.u8()? {
                1 => TrackedChangeKind::Insert,
                2 => TrackedChangeKind::Delete,
                tag => return Err(BindingError::InvalidTag(tag)),
            },
            author: decoder.string()?,
            created_at: decoder.string()?,
        }),
        14 => Ok(DocumentCommand::SetSectionPage {
            id: decoder.document_id_of_kind(DocumentIdKind::Section)?,
            page: decoder.page_with_extras()?,
        }),
        tag => Err(BindingError::InvalidTag(tag)),
    }
}

fn document_id_kind_tag(kind: DocumentIdKind) -> u8 {
    match kind {
        DocumentIdKind::Paragraph => 1,
        DocumentIdKind::Table => 2,
        DocumentIdKind::PageBreak => 3,
        DocumentIdKind::Section => 4,
        DocumentIdKind::Header => 5,
        DocumentIdKind::Footer => 6,
        DocumentIdKind::Comment => 7,
        DocumentIdKind::TrackedChange => 8,
    }
}

fn document_id_kind_from_tag(tag: u8) -> Result<DocumentIdKind, BindingError> {
    match tag {
        1 => Ok(DocumentIdKind::Paragraph),
        2 => Ok(DocumentIdKind::Table),
        3 => Ok(DocumentIdKind::PageBreak),
        4 => Ok(DocumentIdKind::Section),
        5 => Ok(DocumentIdKind::Header),
        6 => Ok(DocumentIdKind::Footer),
        7 => Ok(DocumentIdKind::Comment),
        8 => Ok(DocumentIdKind::TrackedChange),
        tag => Err(BindingError::InvalidTag(tag)),
    }
}

fn story_kind_tag(kind: StoryKind) -> u8 {
    match kind {
        StoryKind::Header => 1,
        StoryKind::Footer => 2,
    }
}

fn story_variant_tag(variant: StoryVariant) -> u8 {
    match variant {
        StoryVariant::Default => 1,
        StoryVariant::First => 2,
        StoryVariant::Even => 3,
    }
}

fn paragraph_alignment_tag(alignment: ParagraphAlignment) -> u8 {
    match alignment {
        ParagraphAlignment::Left => 1,
        ParagraphAlignment::Center => 2,
        ParagraphAlignment::Right => 3,
        ParagraphAlignment::Justify => 4,
    }
}

struct Encoder {
    bytes: Vec<u8>,
    maximum: usize,
    total_runs: usize,
    total_text_utf16: usize,
    total_table_cells: usize,
}

impl Encoder {
    fn new(maximum: usize) -> Self {
        Self {
            bytes: Vec::new(),
            maximum,
            total_runs: 0,
            total_text_utf16: 0,
            total_table_cells: 0,
        }
    }

    fn reserve(&mut self, additional: usize) -> Result<(), BindingError> {
        let next = self
            .bytes
            .len()
            .checked_add(additional)
            .ok_or(BindingError::Limit("document payload"))?;
        if next > self.maximum {
            return Err(BindingError::Limit("document payload"));
        }
        self.bytes
            .try_reserve(additional)
            .map_err(|_| BindingError::Limit("document payload"))?;
        Ok(())
    }

    fn bytes(&mut self, bytes: &[u8]) -> Result<(), BindingError> {
        self.reserve(bytes.len())?;
        self.bytes.extend_from_slice(bytes);
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

    fn u64(&mut self, value: u64) -> Result<(), BindingError> {
        self.bytes(&value.to_le_bytes())
    }

    fn usize(&mut self, value: usize) -> Result<(), BindingError> {
        self.u64(u64::try_from(value).map_err(|_| BindingError::Limit("document count"))?)
    }

    fn optional_usize(&mut self, value: Option<usize>) -> Result<(), BindingError> {
        match value {
            None => self.u8(0),
            Some(value) => {
                self.u8(1)?;
                self.usize(value)
            }
        }
    }

    fn i64(&mut self, value: i64) -> Result<(), BindingError> {
        self.bytes(&value.to_le_bytes())
    }

    fn f64(&mut self, value: f64) -> Result<(), BindingError> {
        if !value.is_finite() || (value == 0.0 && value.is_sign_negative()) {
            return Err(BindingError::NonCanonical(
                "document numbers must be finite and encode zero with a positive sign",
            ));
        }
        self.u64(value.to_bits())
    }

    fn bool(&mut self, value: bool) -> Result<(), BindingError> {
        self.u8(u8::from(value))
    }

    fn optional_bool(&mut self, value: Option<bool>) -> Result<(), BindingError> {
        self.u8(match value {
            None => 0,
            Some(false) => 1,
            Some(true) => 2,
        })
    }

    fn optional_optional_bool(&mut self, value: Option<Option<bool>>) -> Result<(), BindingError> {
        self.u8(match value {
            None => 0,
            Some(None) => 1,
            Some(Some(false)) => 2,
            Some(Some(true)) => 3,
        })
    }

    fn count(&mut self, value: usize) -> Result<(), BindingError> {
        self.u32(u32::try_from(value).map_err(|_| BindingError::Limit("document count"))?)
    }

    fn query_limits(&mut self, limits: DocumentQueryLimits) -> Result<(), BindingError> {
        validate_document_query_limits(limits)?;
        self.u32(
            u32::try_from(limits.max_items)
                .map_err(|_| BindingError::Limit("document query items"))?,
        )?;
        self.u32(
            u32::try_from(limits.max_text_utf16)
                .map_err(|_| BindingError::Limit("document query text"))?,
        )?;
        self.u32(
            u32::try_from(limits.max_table_cells)
                .map_err(|_| BindingError::Limit("document query table cells"))?,
        )
    }

    fn string(&mut self, value: &str) -> Result<(), BindingError> {
        if value.len() > MAX_DOCUMENT_COMMAND_STRING_BYTES
            || value.encode_utf16().count() > MAX_TEXT_UTF16
        {
            return Err(BindingError::Limit("document string"));
        }
        self.count(value.len())?;
        self.bytes(value.as_bytes())
    }

    fn content_string(&mut self, value: &str) -> Result<(), BindingError> {
        self.total_text_utf16 = self
            .total_text_utf16
            .checked_add(value.encode_utf16().count())
            .ok_or(BindingError::Limit("document text"))?;
        if self.total_text_utf16 > MAX_TEXT_UTF16 {
            return Err(BindingError::Limit("document text"));
        }
        self.string(value)
    }

    fn optional_string(&mut self, value: Option<&str>) -> Result<(), BindingError> {
        match value {
            None => self.u8(0),
            Some(value) => {
                self.u8(1)?;
                self.string(value)
            }
        }
    }

    fn document_id(&mut self, id: DocumentId) -> Result<(), BindingError> {
        self.u8(document_id_kind_tag(id.kind()))?;
        self.u64(id.namespace())?;
        self.u64(id.counter())
    }

    fn text_range(&mut self, range: TextRange) -> Result<(), BindingError> {
        self.u32(range.start)?;
        self.u32(range.end)
    }

    fn story_target(&mut self, target: StoryTarget) -> Result<(), BindingError> {
        match target {
            StoryTarget::Body => self.u8(0),
            StoryTarget::Section {
                section_id,
                kind,
                variant,
            } => {
                ensure_document_id_kind(section_id, DocumentIdKind::Section)?;
                self.u8(1)?;
                self.document_id(section_id)?;
                self.u8(story_kind_tag(kind))?;
                self.u8(story_variant_tag(variant))
            }
        }
    }

    fn page(&mut self, page: PageGeometry) -> Result<(), BindingError> {
        self.f64(page.width_pt)?;
        self.f64(page.height_pt)?;
        self.f64(page.margin_top_pt)?;
        self.f64(page.margin_right_pt)?;
        self.f64(page.margin_bottom_pt)?;
        self.f64(page.margin_left_pt)
    }

    fn page_with_extras(&mut self, page: PageGeometry) -> Result<(), BindingError> {
        self.page(page)?;
        self.f64(page.header_pt)?;
        self.f64(page.footer_pt)?;
        self.f64(page.gutter_pt)
    }

    fn page_projection(&mut self, page: PageGeometryProjection) -> Result<(), BindingError> {
        self.i64(page.width_millipoints)?;
        self.i64(page.height_millipoints)?;
        self.i64(page.margin_top_millipoints)?;
        self.i64(page.margin_right_millipoints)?;
        self.i64(page.margin_bottom_millipoints)?;
        self.i64(page.margin_left_millipoints)
    }

    fn runs(&mut self, runs: &[TextRun]) -> Result<(), BindingError> {
        self.total_runs = self
            .total_runs
            .checked_add(runs.len())
            .ok_or(BindingError::Limit("document text runs"))?;
        if self.total_runs > MAX_TEXT_RUNS {
            return Err(BindingError::Limit("document text runs"));
        }
        self.count(runs.len())?;
        for run in runs {
            self.content_string(&run.text)?;
            self.text_style(&run.style)?;
        }
        Ok(())
    }

    fn text_style(&mut self, style: &TextStyle) -> Result<(), BindingError> {
        let mask = u8::from(style.font_family.is_some())
            | (u8::from(style.font_size_pt.is_some()) << 1)
            | (u8::from(style.color.is_some()) << 2)
            | (u8::from(style.bold.is_some()) << 3)
            | (u8::from(style.italic.is_some()) << 4)
            | (u8::from(style.underline.is_some()) << 5)
            | (u8::from(style.strike.is_some()) << 6);
        self.u8(mask)?;
        if let Some(value) = &style.font_family {
            self.string(value)?;
        }
        if let Some(value) = style.font_size_pt {
            self.f64(value)?;
        }
        if let Some(value) = &style.color {
            self.string(value)?;
        }
        for value in [style.bold, style.italic, style.underline, style.strike]
            .into_iter()
            .flatten()
        {
            self.bool(value)?;
        }
        Ok(())
    }

    fn optional_text_style(&mut self, style: Option<&TextStyle>) -> Result<(), BindingError> {
        match style {
            None => self.u8(0),
            Some(style) => {
                self.u8(1)?;
                self.text_style(style)
            }
        }
    }

    fn text_style_patch(&mut self, patch: &TextStylePatch) -> Result<(), BindingError> {
        self.patch_string(patch.font_family.as_ref())?;
        self.patch_f64(patch.font_size_pt)?;
        self.patch_string(patch.color.as_ref())?;
        self.patch_bool(patch.bold)?;
        self.patch_bool(patch.italic)?;
        self.patch_bool(patch.underline)?;
        self.patch_bool(patch.strike)
    }

    fn patch_string(&mut self, value: Option<&Option<String>>) -> Result<(), BindingError> {
        match value {
            None => self.u8(0),
            Some(None) => self.u8(1),
            Some(Some(value)) => {
                self.u8(2)?;
                self.string(value)
            }
        }
    }

    fn patch_f64(&mut self, value: Option<Option<f64>>) -> Result<(), BindingError> {
        match value {
            None => self.u8(0),
            Some(None) => self.u8(1),
            Some(Some(value)) => {
                self.u8(2)?;
                self.f64(value)
            }
        }
    }

    fn patch_bool(&mut self, value: Option<Option<bool>>) -> Result<(), BindingError> {
        self.u8(match value {
            None => 0,
            Some(None) => 1,
            Some(Some(false)) => 2,
            Some(Some(true)) => 3,
        })
    }

    fn paragraph_style(&mut self, style: &ParagraphStyle) -> Result<(), BindingError> {
        let mask = u16::from(style.heading_level.is_some())
            | (u16::from(style.alignment.is_some()) << 1)
            | (u16::from(style.space_before_pt.is_some()) << 2)
            | (u16::from(style.space_after_pt.is_some()) << 3)
            | (u16::from(style.line_height.is_some()) << 4)
            | (u16::from(style.keep_next.is_some()) << 5)
            | (u16::from(style.page_break_before.is_some()) << 6)
            | (u16::from(style.list.is_some()) << 7);
        self.u16(mask)?;
        if let Some(value) = style.heading_level {
            self.u8(value)?;
        }
        if let Some(value) = style.alignment {
            self.u8(paragraph_alignment_tag(value))?;
        }
        for value in [
            style.space_before_pt,
            style.space_after_pt,
            style.line_height,
        ]
        .into_iter()
        .flatten()
        {
            self.f64(value)?;
        }
        for value in [style.keep_next, style.page_break_before]
            .into_iter()
            .flatten()
        {
            self.bool(value)?;
        }
        if let Some(list) = &style.list {
            self.u8(match list.kind {
                ListKind::Bullet => 1,
                ListKind::Number => 2,
            })?;
            match list.level {
                None => self.u8(0)?,
                Some(level) => {
                    self.u8(1)?;
                    self.u8(level)?;
                }
            }
            self.optional_string(list.instance_id.as_deref())?;
        }
        Ok(())
    }

    fn table_style(&mut self, style: &TableStyle) -> Result<(), BindingError> {
        let mask = u8::from(style.width_pt.is_some())
            | (u8::from(style.column_widths_pt.is_some()) << 1)
            | (u8::from(style.header_rows.is_some()) << 2)
            | (u8::from(style.cell_padding_pt.is_some()) << 3)
            | (u8::from(style.border_color.is_some()) << 4)
            | (u8::from(style.header_fill.is_some()) << 5)
            | (u8::from(style.allow_row_split.is_some()) << 6);
        self.u8(mask)?;
        if let Some(value) = style.width_pt {
            self.f64(value)?;
        }
        if let Some(widths) = &style.column_widths_pt {
            self.count(widths.len())?;
            for width in widths {
                self.f64(*width)?;
            }
        }
        if let Some(value) = style.header_rows {
            self.u32(value)?;
        }
        if let Some(value) = style.cell_padding_pt {
            self.f64(value)?;
        }
        if let Some(value) = &style.border_color {
            self.string(value)?;
        }
        if let Some(value) = &style.header_fill {
            self.string(value)?;
        }
        if let Some(value) = style.allow_row_split {
            self.bool(value)?;
        }
        Ok(())
    }

    fn table_rows(&mut self, rows: &[Vec<Vec<TextRun>>]) -> Result<(), BindingError> {
        self.count(rows.len())?;
        for row in rows {
            self.total_table_cells = self
                .total_table_cells
                .checked_add(row.len())
                .ok_or(BindingError::Limit("document table cells"))?;
            if self.total_table_cells > MAX_TABLE_CELLS {
                return Err(BindingError::Limit("document table cells"));
            }
            self.count(row.len())?;
            for cell in row {
                self.runs(cell)?;
            }
        }
        Ok(())
    }

    fn comment_reply(&mut self, reply: &CommentReply) -> Result<(), BindingError> {
        self.string(&reply.author)?;
        self.content_string(&reply.text)?;
        self.string(&reply.created_at)
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

struct Decoder<'a> {
    bytes: &'a [u8],
    offset: usize,
    total_runs: usize,
    total_text_utf16: usize,
    total_table_cells: usize,
}

impl<'a> Decoder<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            offset: 0,
            total_runs: 0,
            total_text_utf16: 0,
            total_table_cells: 0,
        }
    }

    fn is_empty(&self) -> bool {
        self.offset == self.bytes.len()
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], BindingError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(BindingError::Limit("document payload"))?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or(BindingError::Truncated)?;
        self.offset = end;
        Ok(value)
    }

    fn u8(&mut self) -> Result<u8, BindingError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, BindingError> {
        Ok(u16::from_le_bytes(
            self.take(2)?
                .try_into()
                .map_err(|_| BindingError::Truncated)?,
        ))
    }

    fn u32(&mut self) -> Result<u32, BindingError> {
        Ok(u32::from_le_bytes(
            self.take(4)?
                .try_into()
                .map_err(|_| BindingError::Truncated)?,
        ))
    }

    fn u64(&mut self) -> Result<u64, BindingError> {
        Ok(u64::from_le_bytes(
            self.take(8)?
                .try_into()
                .map_err(|_| BindingError::Truncated)?,
        ))
    }

    fn usize(&mut self) -> Result<usize, BindingError> {
        usize::try_from(self.u64()?).map_err(|_| BindingError::Limit("document count"))
    }

    fn usize_bounded(
        &mut self,
        maximum: usize,
        target: &'static str,
    ) -> Result<usize, BindingError> {
        let value = self.usize()?;
        if value > maximum {
            return Err(BindingError::Limit(target));
        }
        Ok(value)
    }

    fn optional_usize(&mut self) -> Result<Option<usize>, BindingError> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some(self.usize()?)),
            _ => Err(BindingError::NonCanonical(
                "invalid optional document cursor",
            )),
        }
    }

    fn i64(&mut self) -> Result<i64, BindingError> {
        Ok(i64::from_le_bytes(
            self.take(8)?
                .try_into()
                .map_err(|_| BindingError::Truncated)?,
        ))
    }

    fn f64(&mut self) -> Result<f64, BindingError> {
        let value = f64::from_bits(self.u64()?);
        if !value.is_finite() || (value == 0.0 && value.is_sign_negative()) {
            return Err(BindingError::NonCanonical(
                "document numbers must be finite and encode zero with a positive sign",
            ));
        }
        Ok(value)
    }

    fn bool(&mut self) -> Result<bool, BindingError> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(BindingError::NonCanonical("invalid document boolean")),
        }
    }

    fn optional_bool(&mut self) -> Result<Option<bool>, BindingError> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some(false)),
            2 => Ok(Some(true)),
            _ => Err(BindingError::NonCanonical(
                "invalid optional document boolean",
            )),
        }
    }

    fn optional_optional_bool(&mut self) -> Result<Option<Option<bool>>, BindingError> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some(None)),
            2 => Ok(Some(Some(false))),
            3 => Ok(Some(Some(true))),
            _ => Err(BindingError::NonCanonical("invalid document flag patch")),
        }
    }

    fn count(&mut self, maximum: usize) -> Result<usize, BindingError> {
        let value =
            usize::try_from(self.u32()?).map_err(|_| BindingError::Limit("document count"))?;
        if value > maximum {
            return Err(BindingError::Limit("document count"));
        }
        Ok(value)
    }

    fn query_limits(&mut self) -> Result<DocumentQueryLimits, BindingError> {
        let limits = DocumentQueryLimits {
            max_items: usize::try_from(self.u32()?)
                .map_err(|_| BindingError::Limit("document query items"))?,
            max_text_utf16: usize::try_from(self.u32()?)
                .map_err(|_| BindingError::Limit("document query text"))?,
            max_table_cells: usize::try_from(self.u32()?)
                .map_err(|_| BindingError::Limit("document query table cells"))?,
        };
        validate_document_query_limits(limits)?;
        Ok(limits)
    }

    fn string(&mut self) -> Result<String, BindingError> {
        let length = self.count(MAX_DOCUMENT_COMMAND_STRING_BYTES)?;
        let value =
            core::str::from_utf8(self.take(length)?).map_err(|_| BindingError::InvalidUtf8)?;
        if value.encode_utf16().count() > MAX_TEXT_UTF16 {
            return Err(BindingError::Limit("document string"));
        }
        Ok(value.to_owned())
    }

    fn content_string(&mut self) -> Result<String, BindingError> {
        let value = self.string()?;
        self.total_text_utf16 = self
            .total_text_utf16
            .checked_add(value.encode_utf16().count())
            .ok_or(BindingError::Limit("document text"))?;
        if self.total_text_utf16 > MAX_TEXT_UTF16 {
            return Err(BindingError::Limit("document text"));
        }
        Ok(value)
    }

    fn optional_string(&mut self) -> Result<Option<String>, BindingError> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some(self.string()?)),
            _ => Err(BindingError::NonCanonical(
                "invalid optional document string",
            )),
        }
    }

    fn document_id(&mut self) -> Result<DocumentId, BindingError> {
        let kind = document_id_kind_from_tag(self.u8()?)?;
        let namespace = self.u64()?;
        let counter = self.u64()?;
        DocumentId::new(kind, namespace, counter).map_err(map_document_error)
    }

    fn document_id_of_kind(
        &mut self,
        expected: DocumentIdKind,
    ) -> Result<DocumentId, BindingError> {
        let id = self.document_id()?;
        if id.kind() != expected {
            return Err(BindingError::NonCanonical("document id kind mismatch"));
        }
        Ok(id)
    }

    fn text_range(&mut self) -> Result<TextRange, BindingError> {
        TextRange::new(self.u32()?, self.u32()?).map_err(map_document_error)
    }

    fn story_target(&mut self) -> Result<StoryTarget, BindingError> {
        match self.u8()? {
            0 => Ok(StoryTarget::Body),
            1 => Ok(StoryTarget::Section {
                section_id: self.document_id_of_kind(DocumentIdKind::Section)?,
                kind: match self.u8()? {
                    1 => StoryKind::Header,
                    2 => StoryKind::Footer,
                    tag => return Err(BindingError::InvalidTag(tag)),
                },
                variant: match self.u8()? {
                    1 => StoryVariant::Default,
                    2 => StoryVariant::First,
                    3 => StoryVariant::Even,
                    tag => return Err(BindingError::InvalidTag(tag)),
                },
            }),
            tag => Err(BindingError::InvalidTag(tag)),
        }
    }

    fn story_kind(&mut self) -> Result<StoryKind, BindingError> {
        match self.u8()? {
            1 => Ok(StoryKind::Header),
            2 => Ok(StoryKind::Footer),
            tag => Err(BindingError::InvalidTag(tag)),
        }
    }

    fn story_variant(&mut self) -> Result<StoryVariant, BindingError> {
        match self.u8()? {
            1 => Ok(StoryVariant::Default),
            2 => Ok(StoryVariant::First),
            3 => Ok(StoryVariant::Even),
            tag => Err(BindingError::InvalidTag(tag)),
        }
    }

    fn page(&mut self) -> Result<PageGeometry, BindingError> {
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

    fn page_with_extras(&mut self) -> Result<PageGeometry, BindingError> {
        let mut page = self.page()?;
        page.header_pt = self.f64()?;
        page.footer_pt = self.f64()?;
        page.gutter_pt = self.f64()?;
        Ok(page)
    }

    fn page_projection(&mut self) -> Result<PageGeometryProjection, BindingError> {
        Ok(PageGeometryProjection {
            width_millipoints: self.i64()?,
            height_millipoints: self.i64()?,
            margin_top_millipoints: self.i64()?,
            margin_right_millipoints: self.i64()?,
            margin_bottom_millipoints: self.i64()?,
            margin_left_millipoints: self.i64()?,
            header_millipoints: 36_000,
            footer_millipoints: 36_000,
            gutter_millipoints: 0,
        })
    }

    fn runs(&mut self) -> Result<Vec<TextRun>, BindingError> {
        let count = self.count(MAX_TEXT_RUNS)?;
        self.total_runs = self
            .total_runs
            .checked_add(count)
            .ok_or(BindingError::Limit("document text runs"))?;
        if self.total_runs > MAX_TEXT_RUNS {
            return Err(BindingError::Limit("document text runs"));
        }
        let mut runs = Vec::new();
        runs.try_reserve_exact(count)
            .map_err(|_| BindingError::Limit("document text runs"))?;
        for _ in 0..count {
            runs.push(TextRun {
                text: self.content_string()?,
                style: self.text_style()?,
            });
        }
        Ok(runs)
    }

    fn text_style(&mut self) -> Result<TextStyle, BindingError> {
        let mask = self.u8()?;
        if mask & !0x7f != 0 {
            return Err(BindingError::NonCanonical(
                "unknown document text-style bits",
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

    fn optional_text_style(&mut self) -> Result<Option<TextStyle>, BindingError> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some(self.text_style()?)),
            _ => Err(BindingError::NonCanonical(
                "invalid optional document text style",
            )),
        }
    }

    fn text_style_patch(&mut self) -> Result<TextStylePatch, BindingError> {
        Ok(TextStylePatch {
            font_family: self.patch_string()?,
            font_size_pt: self.patch_f64()?,
            color: self.patch_string()?,
            bold: self.patch_bool()?,
            italic: self.patch_bool()?,
            underline: self.patch_bool()?,
            strike: self.patch_bool()?,
        })
    }

    fn patch_string(&mut self) -> Result<Option<Option<String>>, BindingError> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some(None)),
            2 => Ok(Some(Some(self.string()?))),
            _ => Err(BindingError::NonCanonical("invalid document string patch")),
        }
    }

    fn patch_f64(&mut self) -> Result<Option<Option<f64>>, BindingError> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some(None)),
            2 => Ok(Some(Some(self.f64()?))),
            _ => Err(BindingError::NonCanonical("invalid document number patch")),
        }
    }

    fn patch_bool(&mut self) -> Result<Option<Option<bool>>, BindingError> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some(None)),
            2 => Ok(Some(Some(false))),
            3 => Ok(Some(Some(true))),
            _ => Err(BindingError::NonCanonical("invalid document boolean patch")),
        }
    }

    fn paragraph_style(&mut self) -> Result<ParagraphStyle, BindingError> {
        let mask = self.u16()?;
        if mask & !0xff != 0 {
            return Err(BindingError::NonCanonical("unknown paragraph-style bits"));
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
                tag => return Err(BindingError::InvalidTag(tag)),
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
            Some(ListStyle {
                kind: match self.u8()? {
                    1 => ListKind::Bullet,
                    2 => ListKind::Number,
                    tag => return Err(BindingError::InvalidTag(tag)),
                },
                level: match self.u8()? {
                    0 => None,
                    1 => Some(self.u8()?),
                    _ => return Err(BindingError::NonCanonical("invalid document list level")),
                },
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

    fn table_style(&mut self) -> Result<TableStyle, BindingError> {
        let mask = self.u8()?;
        if mask & !0x7f != 0 {
            return Err(BindingError::NonCanonical(
                "unknown document table-style bits",
            ));
        }
        let width_pt = if mask & 1 != 0 {
            Some(self.f64()?)
        } else {
            None
        };
        let column_widths_pt = if mask & 2 != 0 {
            let count = self.count(MAX_TABLE_CELLS)?;
            let mut widths = Vec::new();
            widths
                .try_reserve_exact(count)
                .map_err(|_| BindingError::Limit("document table widths"))?;
            for _ in 0..count {
                widths.push(self.f64()?);
            }
            Some(widths)
        } else {
            None
        };
        Ok(TableStyle {
            width_pt,
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

    fn table_rows(&mut self) -> Result<Vec<Vec<Vec<TextRun>>>, BindingError> {
        let row_count = self.count(MAX_TABLE_CELLS)?;
        let mut rows = Vec::new();
        rows.try_reserve_exact(row_count)
            .map_err(|_| BindingError::Limit("document table rows"))?;
        let mut cells = 0_usize;
        for _ in 0..row_count {
            let column_count = self.count(MAX_TABLE_CELLS)?;
            cells = cells
                .checked_add(column_count)
                .ok_or(BindingError::Limit("document table cells"))?;
            if cells > MAX_TABLE_CELLS {
                return Err(BindingError::Limit("document table cells"));
            }
            self.total_table_cells = self
                .total_table_cells
                .checked_add(column_count)
                .ok_or(BindingError::Limit("document table cells"))?;
            if self.total_table_cells > MAX_TABLE_CELLS {
                return Err(BindingError::Limit("document table cells"));
            }
            let mut row = Vec::new();
            row.try_reserve_exact(column_count)
                .map_err(|_| BindingError::Limit("document table cells"))?;
            for _ in 0..column_count {
                row.push(self.runs()?);
            }
            rows.push(row);
        }
        Ok(rows)
    }

    fn comment_reply(&mut self) -> Result<CommentReply, BindingError> {
        Ok(CommentReply {
            author: self.string()?,
            text: self.content_string()?,
            created_at: self.string()?,
        })
    }
}

fn encode_envelope(
    magic: [u8; 8],
    version: u16,
    count: usize,
    payload: Vec<u8>,
    maximum: usize,
) -> Result<Vec<u8>, BindingError> {
    let count = u32::try_from(count).map_err(|_| BindingError::Limit("document envelope count"))?;
    let payload_len =
        u64::try_from(payload.len()).map_err(|_| BindingError::Limit("document payload"))?;
    let total = HEADER_BYTES
        .checked_add(payload.len())
        .and_then(|value| value.checked_add(CHECKSUM_BYTES))
        .ok_or(BindingError::Limit("document envelope"))?;
    if total > maximum {
        return Err(BindingError::Limit("document envelope"));
    }
    let mut output = Vec::with_capacity(total);
    output.extend_from_slice(&magic);
    output.extend_from_slice(&version.to_le_bytes());
    output.extend_from_slice(&0_u16.to_le_bytes());
    output.extend_from_slice(&count.to_le_bytes());
    output.extend_from_slice(&payload_len.to_le_bytes());
    output.extend_from_slice(&payload);
    output.extend_from_slice(&checksum(&output).to_le_bytes());
    Ok(output)
}

fn decode_envelope(
    bytes: &[u8],
    magic: [u8; 8],
    version: u16,
    maximum: usize,
    max_count: usize,
) -> Result<(usize, &[u8]), BindingError> {
    if bytes.len() > maximum {
        return Err(BindingError::Limit("document envelope"));
    }
    if bytes.len() < HEADER_BYTES + CHECKSUM_BYTES {
        return Err(BindingError::Truncated);
    }
    if bytes[..8] != magic {
        return Err(BindingError::BadMagic("document"));
    }
    let actual_version = u16::from_le_bytes([bytes[8], bytes[9]]);
    if actual_version != version {
        return Err(BindingError::UnsupportedVersion(actual_version));
    }
    if u16::from_le_bytes([bytes[10], bytes[11]]) != 0 {
        return Err(BindingError::NonCanonical(
            "reserved document envelope bits are set",
        ));
    }
    let count = usize::try_from(u32::from_le_bytes(
        bytes[12..16]
            .try_into()
            .map_err(|_| BindingError::Truncated)?,
    ))
    .map_err(|_| BindingError::Limit("document envelope count"))?;
    if count > max_count {
        return Err(BindingError::Limit("document envelope count"));
    }
    let payload_len = usize::try_from(u64::from_le_bytes(
        bytes[16..24]
            .try_into()
            .map_err(|_| BindingError::Truncated)?,
    ))
    .map_err(|_| BindingError::Limit("document payload"))?;
    let payload_end = HEADER_BYTES
        .checked_add(payload_len)
        .ok_or(BindingError::Limit("document payload"))?;
    let expected = payload_end
        .checked_add(CHECKSUM_BYTES)
        .ok_or(BindingError::Limit("document envelope"))?;
    if bytes.len() != expected {
        return Err(if bytes.len() < expected {
            BindingError::Truncated
        } else {
            BindingError::TrailingBytes
        });
    }
    let expected_checksum = u64::from_le_bytes(
        bytes[payload_end..expected]
            .try_into()
            .map_err(|_| BindingError::Truncated)?,
    );
    if checksum(&bytes[..payload_end]) != expected_checksum {
        return Err(BindingError::ChecksumMismatch);
    }
    Ok((count, &bytes[HEADER_BYTES..payload_end]))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NS: u64 = 0x444f_4355_4d45_4e54;
    const NOW: &str = "2026-01-02T03:04:05.000Z";

    fn id(kind: DocumentIdKind, counter: u64) -> DocumentId {
        DocumentId::new(kind, NS, counter).expect("document id")
    }

    fn full_style() -> TextStyle {
        TextStyle {
            font_family: Some("Inter".into()),
            font_size_pt: Some(11.5),
            color: Some("#102030".into()),
            bold: Some(true),
            italic: Some(false),
            underline: Some(true),
            strike: Some(false),
        }
    }

    fn paragraph_style() -> ParagraphStyle {
        ParagraphStyle {
            heading_level: Some(2),
            alignment: Some(ParagraphAlignment::Justify),
            space_before_pt: Some(4.5),
            space_after_pt: Some(8.0),
            line_height: Some(1.25),
            keep_next: Some(true),
            page_break_before: Some(false),
            list: Some(ListStyle {
                kind: ListKind::Number,
                level: Some(2),
                instance_id: Some("list-a".into()),
            }),
        }
    }

    fn table_style() -> TableStyle {
        TableStyle {
            width_pt: Some(420.0),
            column_widths_pt: Some(vec![120.0, 300.0]),
            header_rows: Some(1),
            cell_padding_pt: Some(4.0),
            border_color: Some("#111827".into()),
            header_fill: Some("#e5e7eb".into()),
            allow_row_split: Some(false),
        }
    }

    fn every_command_shape() -> DocumentBatch {
        DocumentBatch::from_commands(vec![
            DocumentCommand::SetDocumentFlags {
                even_and_odd_headers: Some(Some(true)),
                track_revisions: Some(None),
            },
            DocumentCommand::AddParagraph {
                target: StoryTarget::Section {
                    section_id: id(DocumentIdKind::Section, 1),
                    kind: StoryKind::Header,
                    variant: StoryVariant::Even,
                },
                id: id(DocumentIdKind::Paragraph, 8),
                runs: vec![TextRun {
                    text: "Hello 🌍".into(),
                    style: full_style(),
                }],
                style: paragraph_style(),
            },
            DocumentCommand::EditParagraph {
                id: id(DocumentIdKind::Paragraph, 8),
                range: TextRange { start: 1, end: 3 },
                replacement: "x".into(),
                style: Some(full_style()),
            },
            DocumentCommand::FormatParagraph {
                id: id(DocumentIdKind::Paragraph, 8),
                range: TextRange { start: 0, end: 1 },
                style: TextStylePatch {
                    font_family: Some(Some("Aptos".into())),
                    font_size_pt: Some(None),
                    color: None,
                    bold: Some(Some(false)),
                    italic: Some(None),
                    underline: Some(Some(true)),
                    strike: None,
                },
            },
            DocumentCommand::SetParagraphStyle {
                id: id(DocumentIdKind::Paragraph, 8),
                style: paragraph_style(),
            },
            DocumentCommand::AddTable {
                target: StoryTarget::Body,
                id: id(DocumentIdKind::Table, 9),
                rows: vec![
                    vec![vec![TextRun::plain("A")], vec![TextRun::plain("B")]],
                    vec![vec![TextRun::plain("1")], vec![TextRun::plain("2")]],
                ],
                style: table_style(),
            },
            DocumentCommand::SetTableStyle {
                id: id(DocumentIdKind::Table, 9),
                style: table_style(),
            },
            DocumentCommand::AddPageBreak {
                id: id(DocumentIdKind::PageBreak, 10),
            },
            DocumentCommand::AddSection {
                ids: SectionIds {
                    section: id(DocumentIdKind::Section, 11),
                    header_default: id(DocumentIdKind::Header, 12),
                    header_first: id(DocumentIdKind::Header, 13),
                    header_even: id(DocumentIdKind::Header, 14),
                    footer_default: id(DocumentIdKind::Footer, 15),
                    footer_first: id(DocumentIdKind::Footer, 16),
                    footer_even: id(DocumentIdKind::Footer, 17),
                },
                page: PageGeometry {
                    width_pt: 792.0,
                    height_pt: 612.0,
                    margin_top_pt: 36.0,
                    margin_right_pt: 42.0,
                    margin_bottom_pt: 48.0,
                    margin_left_pt: 54.0,
                    ..PageGeometry::default()
                },
                title_page: Some(true),
            },
            DocumentCommand::SetSectionTitlePage {
                id: id(DocumentIdKind::Section, 11),
                title_page: None,
            },
            DocumentCommand::SetSectionPage {
                id: id(DocumentIdKind::Section, 11),
                page: PageGeometry {
                    width_pt: 612.0,
                    height_pt: 792.0,
                    margin_top_pt: 72.0,
                    margin_right_pt: 72.0,
                    margin_bottom_pt: 72.0,
                    margin_left_pt: 72.0,
                    header_pt: 27.5,
                    footer_pt: 31.25,
                    gutter_pt: 9.5,
                },
            },
            DocumentCommand::AddComment {
                id: id(DocumentIdKind::Comment, 18),
                paragraph_id: id(DocumentIdKind::Paragraph, 8),
                range: TextRange { start: 0, end: 1 },
                resolved: false,
                root: CommentReply {
                    author: "Reviewer".into(),
                    text: "Check".into(),
                    created_at: NOW.into(),
                },
            },
            DocumentCommand::AddCommentReply {
                id: id(DocumentIdKind::Comment, 18),
                reply: CommentReply {
                    author: "Author".into(),
                    text: "Done".into(),
                    created_at: NOW.into(),
                },
            },
            DocumentCommand::SetCommentResolved {
                id: id(DocumentIdKind::Comment, 18),
                resolved: true,
            },
            DocumentCommand::AddTrackedChange {
                id: id(DocumentIdKind::TrackedChange, 19),
                paragraph_id: id(DocumentIdKind::Paragraph, 8),
                range: TextRange { start: 0, end: 1 },
                kind: TrackedChangeKind::Delete,
                author: "Author".into(),
                created_at: NOW.into(),
            },
        ])
    }

    fn paragraph_command(text_bytes: usize) -> Vec<u8> {
        encode_document_command_batch(&DocumentBatch::from_commands(vec![
            DocumentCommand::AddParagraph {
                target: StoryTarget::Body,
                id: id(DocumentIdKind::Paragraph, 8),
                runs: vec![TextRun::plain("x".repeat(text_bytes))],
                style: ParagraphStyle::default(),
            },
        ]))
        .expect("paragraph command")
    }

    fn rewrite_checksum(bytes: &mut [u8]) {
        let checksum_offset = bytes.len() - CHECKSUM_BYTES;
        let value = checksum(&bytes[..checksum_offset]);
        bytes[checksum_offset..].copy_from_slice(&value.to_le_bytes());
    }

    #[test]
    fn document_command_codec_round_trips_every_variant_canonically() {
        let batch = every_command_shape();
        let bytes = encode_document_command_batch(&batch).expect("encode");
        let decoded = decode_document_command_batch(&bytes).expect("decode");
        assert_eq!(decoded, batch);
        assert_eq!(
            encode_document_command_batch(&decoded).expect("re-encode"),
            bytes
        );

        let mut add_section = batch
            .commands()
            .iter()
            .find(|command| matches!(command, DocumentCommand::AddSection { .. }))
            .expect("section command")
            .clone();
        let DocumentCommand::AddSection { page, .. } = &mut add_section else {
            unreachable!("filtered section command")
        };
        page.header_pt = 27.5;
        assert!(matches!(
            encode_document_command_batch(&DocumentBatch::from_commands(vec![add_section])),
            Err(BindingError::NonCanonical(
                "section.add page extras require section.page.set"
            ))
        ));
    }

    #[test]
    fn section_page_command_applies_queries_and_rolls_back_atomically() {
        let namespace = super::super::encode_namespace(NS);
        let mut session = DocumentBindingSession::create(&namespace).expect("session");
        let section_id = id(DocumentIdKind::Section, 1);
        let landscape = PageGeometry {
            width_pt: 792.0,
            height_pt: 612.0,
            margin_top_pt: 36.0,
            margin_right_pt: 42.0,
            margin_bottom_pt: 48.0,
            margin_left_pt: 54.0,
            header_pt: 27.5,
            footer_pt: 31.25,
            gutter_pt: 9.5,
        };
        let set_landscape = encode_document_command_batch(&DocumentBatch::from_commands(vec![
            DocumentCommand::SetSectionPage {
                id: section_id,
                page: landscape,
            },
        ]))
        .expect("section page command");
        let receipt = decode_document_receipt(
            &session
                .apply_commands(&set_landscape)
                .expect("apply section page"),
        )
        .expect("receipt");
        assert_eq!(receipt.revision, 1);
        assert_eq!(receipt.command_count, 1);
        assert!(receipt.created_ids.is_empty());

        let sections_response = session
            .query(
                &encode_document_query(DocumentQuery::Sections {
                    start_section: 0,
                    limits: DocumentQueryLimits::default(),
                })
                .expect("sections query"),
            )
            .expect("sections response");
        let sections =
            decode_document_query_response(&sections_response).expect("decode sections response");
        assert!(matches!(
            sections.items.as_slice(),
            [DocumentProjectionItem::Section(section)]
                if section.id == section_id
                    && section.page == PageGeometryProjection::from(landscape)
        ));
        let mut unknown_extension = sections_response;
        let extension_offset = unknown_extension.len() - CHECKSUM_BYTES - (1 + 1 + 4 + 4 + 24);
        unknown_extension[extension_offset] = 0xfe;
        rewrite_checksum(&mut unknown_extension);
        assert!(matches!(
            decode_document_query_response(&unknown_extension),
            Err(BindingError::NonCanonical(
                "unknown document query response extension"
            ))
        ));
        let summary = decode_document_query_response(
            &session
                .query(&encode_document_query(DocumentQuery::Summary).expect("summary query"))
                .expect("summary response"),
        )
        .expect("decode summary response");
        assert!(matches!(
            summary.items.as_slice(),
            [DocumentProjectionItem::Summary(item)]
                if item.page == PageGeometryProjection::from(landscape)
                    && item.page.header_millipoints == 27_500
                    && item.page.footer_millipoints == 31_250
                    && item.page.gutter_millipoints == 9_500
        ));

        let before = session.snapshot().expect("before failed transaction");
        assert_eq!(u16::from_le_bytes([before[10], before[11]]), 1);
        let hydrated = DocumentBindingSession::open(&before).expect("hydrate page extras");
        assert_eq!(hydrated.snapshot().expect("hydrated snapshot"), before);
        assert_eq!(
            hydrated.state_hash().expect("hydrated hash"),
            session.state_hash().expect("hash")
        );
        let invalid_transaction =
            encode_document_command_batch(&DocumentBatch::from_commands(vec![
                DocumentCommand::SetSectionPage {
                    id: section_id,
                    page: PageGeometry::default(),
                },
                DocumentCommand::SetSectionPage {
                    id: section_id,
                    page: PageGeometry {
                        width_pt: 100.0,
                        height_pt: 612.0,
                        margin_top_pt: 36.0,
                        margin_right_pt: 54.0,
                        margin_bottom_pt: 48.0,
                        margin_left_pt: 54.0,
                        ..PageGeometry::default()
                    },
                },
            ]))
            .expect("encodable invalid transaction");
        assert!(session.apply_commands(&invalid_transaction).is_err());
        assert_eq!(session.snapshot().expect("exact rollback"), before);
        assert_eq!(session.revision().expect("rollback revision"), 1);
    }

    #[test]
    fn document_commands_are_not_accidentally_capped_at_query_size() {
        let command = paragraph_command(240);
        assert!(command.len() > MAX_DOCUMENT_QUERY_BYTES);
        let namespace = super::super::encode_namespace(NS);
        let mut session = DocumentBindingSession::create(&namespace).expect("session");
        session
            .apply_commands(&command)
            .expect("large valid command");
        assert_eq!(session.revision().expect("revision"), 1);

        let max_command_bytes = 512;
        let exact_max_plus_one = paragraph_command(451);
        assert_eq!(exact_max_plus_one.len(), max_command_bytes + 1);
        let limits = BindingLimits {
            max_command_bytes,
            ..NATIVE_LIMITS
        };
        let initial = create_document(&namespace).expect("initial");
        let mut bounded =
            DocumentBindingSession::open_with_limits(&initial, limits).expect("bounded");
        assert!(matches!(
            bounded.apply_commands(&exact_max_plus_one),
            Err(BindingError::Limit("document command envelope"))
        ));
        assert_eq!(bounded.snapshot().expect("unchanged"), initial);
    }

    #[test]
    fn document_session_and_stateless_paths_are_identical_and_atomic() {
        let namespace = super::super::encode_namespace(NS);
        let initial = create_document(&namespace).expect("initial");
        let seed = paragraph_command(16);
        let expected = apply_document_commands(&initial, &seed).expect("stateless");
        let mut session = DocumentBindingSession::open(&initial).expect("session");
        let receipt =
            decode_document_receipt(&session.apply_commands(&seed).expect("session transaction"))
                .expect("receipt");
        assert_eq!(receipt.revision, 1);
        assert_eq!(receipt.command_count, 1);
        assert_eq!(receipt.created_ids, vec![id(DocumentIdKind::Paragraph, 8)]);
        assert_eq!(session.snapshot().expect("session snapshot"), expected);

        let before = session.snapshot().expect("before failed batch");
        let invalid = encode_document_command_batch(&DocumentBatch::from_commands(vec![
            DocumentCommand::AddPageBreak {
                id: id(DocumentIdKind::PageBreak, 9),
            },
            DocumentCommand::EditParagraph {
                id: id(DocumentIdKind::Paragraph, 999),
                range: TextRange { start: 0, end: 0 },
                replacement: "never".into(),
                style: None,
            },
        ]))
        .expect("invalid semantic batch");
        assert!(session.apply_commands(&invalid).is_err());
        assert_eq!(session.snapshot().expect("exact rollback"), before);
        assert_eq!(session.revision().expect("revision"), 1);
    }

    #[test]
    fn exact_snapshot_boundary_probe_rolls_back_without_a_clone() {
        let namespace = super::super::encode_namespace(NS);
        let initial = create_document(&namespace).expect("initial");
        let limits = BindingLimits {
            max_snapshot_bytes: initial.len(),
            allow_boundary_probe: true,
            ..NATIVE_LIMITS
        };
        let mut session =
            DocumentBindingSession::open_with_limits(&initial, limits).expect("session");
        assert!(matches!(
            session.apply_commands(&paragraph_command(1)),
            Err(BindingError::Limit("document snapshot envelope"))
        ));
        assert_eq!(session.snapshot().expect("rollback snapshot"), initial);
        assert_eq!(session.revision().expect("rollback revision"), 0);
    }

    #[test]
    fn repeated_style_growth_is_bounded_before_commit() {
        let namespace = super::super::encode_namespace(NS);
        let runs = (0..1_024)
            .map(|index| TextRun {
                text: "x".into(),
                style: TextStyle {
                    bold: Some(index % 2 == 0),
                    ..TextStyle::default()
                },
            })
            .collect();
        let seed = encode_document_command_batch(&DocumentBatch::from_commands(vec![
            DocumentCommand::AddParagraph {
                target: StoryTarget::Body,
                id: id(DocumentIdKind::Paragraph, 8),
                runs,
                style: ParagraphStyle::default(),
            },
        ]))
        .expect("seed");
        let seeded = apply_document_commands(&create_document(&namespace).expect("initial"), &seed)
            .expect("seeded");
        let format = encode_document_command_batch(&DocumentBatch::from_commands(vec![
            DocumentCommand::FormatParagraph {
                id: id(DocumentIdKind::Paragraph, 8),
                range: TextRange {
                    start: 0,
                    end: 1_024,
                },
                style: TextStylePatch {
                    font_family: Some(Some("LongRepeatedFamily".into())),
                    ..TextStylePatch::default()
                },
            },
        ]))
        .expect("format");
        let maximum = seeded.len() + 100;
        for allow_boundary_probe in [true, false] {
            let limits = BindingLimits {
                max_snapshot_bytes: maximum,
                allow_boundary_probe,
                ..if allow_boundary_probe {
                    NATIVE_LIMITS
                } else {
                    super::super::WASM_LIMITS
                }
            };
            let mut session =
                DocumentBindingSession::open_with_limits(&seeded, limits).expect("session");
            assert!(matches!(
                session.apply_commands(&format),
                Err(BindingError::Limit(_))
            ));
            assert_eq!(session.snapshot().expect("unchanged"), seeded);
            assert_eq!(session.revision().expect("revision"), 1);
        }
    }

    #[test]
    fn every_document_query_and_response_round_trips_exact_bytes() {
        let namespace = super::super::encode_namespace(NS);
        let mut session = DocumentBindingSession::create(&namespace).expect("session");
        session
            .apply_commands(&paragraph_command(12))
            .expect("paragraph");
        let section = id(DocumentIdKind::Section, 1);
        let queries = [
            DocumentQuery::Summary,
            DocumentQuery::Body {
                start_block: 0,
                limits: DocumentQueryLimits::default(),
            },
            DocumentQuery::Story {
                section_id: section,
                kind: StoryKind::Header,
                variant: StoryVariant::Default,
                start_block: 0,
                limits: DocumentQueryLimits::default(),
            },
            DocumentQuery::Sections {
                start_section: 0,
                limits: DocumentQueryLimits::default(),
            },
            DocumentQuery::Review {
                start_item: 0,
                limits: DocumentQueryLimits::default(),
            },
        ];
        for query in queries {
            let request = encode_document_query(query).expect("encode query");
            assert_eq!(
                decode_document_query(&request).expect("decode query"),
                query
            );
            assert_eq!(
                encode_document_query(decode_document_query(&request).expect("decode"))
                    .expect("re-encode"),
                request
            );
            let response = session.query(&request).expect("query response");
            let decoded = decode_document_query_response(&response).expect("decode response");
            assert_eq!(
                encode_document_query_response(&decoded).expect("re-encode response"),
                response
            );
        }
    }

    #[test]
    fn malformed_document_envelopes_fail_closed_before_mutation() {
        let namespace = super::super::encode_namespace(NS);
        let initial = create_document(&namespace).expect("initial");
        let valid = paragraph_command(8);

        let mut reserved = valid.clone();
        reserved[10] = 1;
        rewrite_checksum(&mut reserved);
        assert!(matches!(
            apply_document_commands(&initial, &reserved),
            Err(BindingError::NonCanonical(_))
        ));

        let mut invalid_tag = valid.clone();
        invalid_tag[HEADER_BYTES] = u8::MAX;
        rewrite_checksum(&mut invalid_tag);
        assert!(matches!(
            apply_document_commands(&initial, &invalid_tag),
            Err(BindingError::InvalidTag(u8::MAX))
        ));

        let mut wrong_kind = valid.clone();
        wrong_kind[HEADER_BYTES + 2] = document_id_kind_tag(DocumentIdKind::Table);
        rewrite_checksum(&mut wrong_kind);
        assert!(matches!(
            apply_document_commands(&initial, &wrong_kind),
            Err(BindingError::NonCanonical("document id kind mismatch"))
        ));

        let mut excessive_count = valid.clone();
        excessive_count[12..16]
            .copy_from_slice(&((MAX_DOCUMENT_COMMANDS as u32) + 1).to_le_bytes());
        rewrite_checksum(&mut excessive_count);
        assert!(matches!(
            apply_document_commands(&initial, &excessive_count),
            Err(BindingError::Limit("document envelope count"))
        ));

        let mut trailing = valid.clone();
        trailing.push(0);
        assert!(matches!(
            apply_document_commands(&initial, &trailing),
            Err(BindingError::TrailingBytes)
        ));
        assert!(matches!(
            apply_document_commands(&initial, &valid[..valid.len() - 1]),
            Err(BindingError::Truncated)
        ));

        let mut query = encode_document_query(DocumentQuery::Summary).expect("query");
        query[HEADER_BYTES] = u8::MAX;
        rewrite_checksum(&mut query);
        assert!(matches!(
            query_document(&initial, &query),
            Err(BindingError::InvalidTag(u8::MAX))
        ));

        let summary = DocumentBindingSession::open(&initial)
            .expect("session")
            .query(&encode_document_query(DocumentQuery::Summary).expect("summary query"))
            .expect("summary response");
        let mut false_metrics = summary;
        false_metrics[34..42].copy_from_slice(&1_u64.to_le_bytes());
        rewrite_checksum(&mut false_metrics);
        assert!(matches!(
            decode_document_query_response(&false_metrics),
            Err(BindingError::NonCanonical(_))
        ));

        let negative_zero =
            DocumentBatch::from_commands(vec![DocumentCommand::SetParagraphStyle {
                id: id(DocumentIdKind::Paragraph, 8),
                style: ParagraphStyle {
                    space_before_pt: Some(-0.0),
                    ..ParagraphStyle::default()
                },
            }]);
        assert!(matches!(
            encode_document_command_batch(&negative_zero),
            Err(BindingError::NonCanonical(_))
        ));

        let section_id = id(DocumentIdKind::Section, 1);
        let section_page = encode_document_command_batch(&DocumentBatch::from_commands(vec![
            DocumentCommand::SetSectionPage {
                id: section_id,
                page: PageGeometry::default(),
            },
        ]))
        .expect("section page command");
        assert_eq!(section_page[HEADER_BYTES], 14);
        let mut malformed_section_page = section_page;
        let page_width_offset = HEADER_BYTES + 1 + ENCODED_DOCUMENT_ID_BYTES;
        malformed_section_page[page_width_offset..page_width_offset + 8]
            .copy_from_slice(&(-0.0_f64).to_bits().to_le_bytes());
        rewrite_checksum(&mut malformed_section_page);
        let mut session = DocumentBindingSession::open(&initial).expect("session");
        assert!(matches!(
            session.apply_commands(&malformed_section_page),
            Err(BindingError::NonCanonical(_))
        ));
        assert_eq!(session.snapshot().expect("malformed rollback"), initial);
        assert_eq!(session.revision().expect("malformed revision"), 0);

        assert_eq!(
            canonicalize_document_snapshot(&initial).expect("unchanged"),
            initial
        );
    }

    #[test]
    fn aggregate_decode_budget_rejects_run_amplification() {
        let commands: Vec<_> = (0..65_u64)
            .map(|index| DocumentCommand::AddParagraph {
                target: StoryTarget::Body,
                id: id(DocumentIdKind::Paragraph, 8 + index),
                runs: (0..4_096).map(|_| TextRun::plain("")).collect(),
                style: ParagraphStyle::default(),
            })
            .collect();
        assert!(matches!(
            encode_document_command_batch(&DocumentBatch::from_commands(commands)),
            Err(BindingError::Limit("document text runs"))
        ));

        let one = encode_document_command_batch(&DocumentBatch::from_commands(vec![
            DocumentCommand::AddParagraph {
                target: StoryTarget::Body,
                id: id(DocumentIdKind::Paragraph, 8),
                runs: (0..4_096).map(|_| TextRun::plain("")).collect(),
                style: ParagraphStyle::default(),
            },
        ]))
        .expect("one bounded command");
        let command_payload = &one[HEADER_BYTES..one.len() - CHECKSUM_BYTES];
        let mut amplified = Vec::with_capacity(command_payload.len() * 65);
        for _ in 0..65 {
            amplified.extend_from_slice(command_payload);
        }
        let bytes = encode_envelope(
            COMMAND_MAGIC,
            DOCUMENT_COMMAND_VERSION,
            65,
            amplified,
            super::super::MAX_COMMAND_ENVELOPE_BYTES,
        )
        .expect("synthetic decode bomb");
        assert!(matches!(
            decode_document_command_batch(&bytes),
            Err(BindingError::Limit("document text runs"))
        ));
    }

    #[test]
    fn generated_document_transactions_are_deterministic_across_profiles() {
        for seed in 1_u64..=64 {
            let namespace_value = NS ^ seed;
            let namespace = super::super::encode_namespace(namespace_value);
            let paragraph_id = DocumentId::new(DocumentIdKind::Paragraph, namespace_value, 8)
                .expect("paragraph id");
            let text = format!("seed-{seed}-{}", "x".repeat((seed % 31) as usize));
            let commands = encode_document_command_batch(&DocumentBatch::from_commands(vec![
                DocumentCommand::AddParagraph {
                    target: StoryTarget::Body,
                    id: paragraph_id,
                    runs: vec![TextRun::plain(text.clone())],
                    style: ParagraphStyle::default(),
                },
                DocumentCommand::EditParagraph {
                    id: paragraph_id,
                    range: TextRange { start: 0, end: 0 },
                    replacement: "✓".into(),
                    style: None,
                },
            ]))
            .expect("generated commands");
            let initial = create_document(&namespace).expect("initial");
            let native = apply_document_commands(&initial, &commands).expect("native");
            let wasm =
                apply_document_commands_with_limits(&initial, &commands, super::super::WASM_LIMITS)
                    .expect("wasm profile");
            assert_eq!(native, wasm);
            assert_eq!(
                canonicalize_document_snapshot(&native).expect("canonical"),
                native
            );
        }
    }

    #[test]
    fn capabilities_negotiate_document_and_presentation_profiles_exactly() {
        assert_eq!(
            super::super::capabilities_for(NATIVE_LIMITS),
            super::super::capabilities()
        );
        let native: serde_json::Value =
            serde_json::from_slice(super::super::capabilities()).expect("native capabilities");
        let wasm: serde_json::Value =
            serde_json::from_slice(&super::super::capabilities_for(super::super::WASM_LIMITS))
                .expect("wasm capabilities");
        assert_eq!(native["document"], true);
        assert_eq!(native["documentSnapshotVersion"], 1);
        assert_eq!(native["documentCommandVersion"], DOCUMENT_COMMAND_VERSION);
        assert_eq!(native["documentQueryVersion"], DOCUMENT_QUERY_VERSION);
        assert_eq!(native["maxDocumentCommandBytes"], 67_108_864);
        assert_eq!(native["maxDocumentSnapshotBytes"], 268_435_508_u64);
        assert_eq!(wasm["maxDocumentCommandBytes"], 8_388_608);
        assert_eq!(wasm["maxDocumentSnapshotBytes"], 67_108_864);
        assert_eq!(native["presentation"], true);
        assert_eq!(native["presentationSnapshotVersion"], 1);
        assert_eq!(native["maxPresentationCommandBytes"], 4_194_304);
        assert_eq!(wasm["maxPresentationResponseBytes"], 8_388_608);
        let identity = core::str::from_utf8(super::super::build_identity()).expect("identity");
        assert!(identity.contains(";document-snapshot=1;document-command=1;document-query=1"));
        assert!(identity
            .contains(";presentation-snapshot=1;presentation-command=1;presentation-query=1"));
    }
}
