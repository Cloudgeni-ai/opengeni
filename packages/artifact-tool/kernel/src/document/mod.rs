//! Native, runtime-neutral structured document model.
//!
//! The module mirrors `SerializedDocument` v1 semantics while keeping its own
//! private canonical snapshot. Transaction identity and causal authority are
//! deliberately outside this module and are supplied by the shared kernel
//! protocol layer.

mod command;
mod model;
mod query;
mod snapshot;
mod text_layout_adapter;
mod types;

pub use command::{
    DocumentBatch, DocumentBatchError, DocumentBatchReceipt, DocumentBatchTransaction,
    DocumentCommand, SectionIds,
};
pub use model::{
    BlockRef, CommentThread, Document, Paragraph, Section, SectionStories, Story, Table,
    TrackedChange,
};
pub use query::{
    DocumentProjection, DocumentProjectionItem, DocumentQuery, DocumentQueryError,
    DocumentQueryLimits, DocumentSummaryProjection, PageGeometryProjection, ReviewItem,
    SectionProjection, MAX_QUERY_ITEMS, MAX_QUERY_TABLE_CELLS, MAX_QUERY_TEXT_UTF16,
};
pub use snapshot::{
    decode_document_snapshot, encode_document_snapshot, DOCUMENT_SNAPSHOT_VERSION,
    MAX_DOCUMENT_SNAPSHOT_BYTES,
};
pub use text_layout_adapter::{
    DocumentPageLayout, DocumentPagination, DocumentPaginationLimits, DocumentParagraphFragment,
    DocumentTextDefaults, DocumentTextLayoutError, LayoutPageGeometry,
};
pub use types::{
    CommentReply, DocumentError, DocumentId, DocumentIdKind, ListKind, ListStyle, PageGeometry,
    ParagraphAlignment, ParagraphStyle, StoryKind, StoryTarget, StoryVariant, TableStyle,
    TextRange, TextRun, TextStyle, TextStylePatch, TrackedChangeKind, MAX_COMMENTS,
    MAX_COMMENT_REPLIES, MAX_DOCUMENT_BLOCKS, MAX_DOCUMENT_REVISION, MAX_DOCUMENT_SECTIONS,
    MAX_TABLE_CELLS, MAX_TEXT_RUNS, MAX_TEXT_UTF16, MAX_TRACKED_CHANGES,
};

#[cfg(test)]
mod tests;
