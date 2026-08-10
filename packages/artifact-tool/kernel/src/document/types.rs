use core::fmt;

pub const MAX_DOCUMENT_BLOCKS: usize = 100_000;
pub const MAX_DOCUMENT_SECTIONS: usize = 10_000;
pub const MAX_TEXT_UTF16: usize = 10_000_000;
pub const MAX_TEXT_RUNS: usize = 250_000;
pub const MAX_TABLE_CELLS: usize = 1_000_000;
pub const MAX_COMMENTS: usize = 100_000;
pub const MAX_COMMENT_REPLIES: usize = 100_000;
pub const MAX_TRACKED_CHANGES: usize = 100_000;
pub const MAX_STRUCTURAL_COUNTER: u64 = (1_u64 << 53) - 2;
pub const MAX_DOCUMENT_REVISION: u64 = (1_u64 << 53) - 1;

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum DocumentIdKind {
    Paragraph,
    Table,
    PageBreak,
    Section,
    Header,
    Footer,
    Comment,
    TrackedChange,
}

impl DocumentIdKind {
    #[must_use]
    pub const fn prefix(self) -> &'static str {
        match self {
            Self::Paragraph => "p",
            Self::Table => "dt",
            Self::PageBreak => "pb",
            Self::Section => "sec",
            Self::Header => "hdr",
            Self::Footer => "ftr",
            Self::Comment => "dc",
            Self::TrackedChange => "chg",
        }
    }

    pub(crate) const fn tag(self) -> u8 {
        match self {
            Self::Paragraph => 1,
            Self::Table => 2,
            Self::PageBreak => 3,
            Self::Section => 4,
            Self::Header => 5,
            Self::Footer => 6,
            Self::Comment => 7,
            Self::TrackedChange => 8,
        }
    }

    pub(crate) fn from_tag(tag: u8) -> Result<Self, DocumentError> {
        match tag {
            1 => Ok(Self::Paragraph),
            2 => Ok(Self::Table),
            3 => Ok(Self::PageBreak),
            4 => Ok(Self::Section),
            5 => Ok(Self::Header),
            6 => Ok(Self::Footer),
            7 => Ok(Self::Comment),
            8 => Ok(Self::TrackedChange),
            _ => Err(DocumentError::InvalidSnapshot("unknown document id kind")),
        }
    }
}

/// Stable structural identity matching the TypeScript `prefix/<namespace><counter>` form.
///
/// A zero namespace is intentionally allowed because `SerializedDocument` v1 permits it.
/// Counter zero is always reserved.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct DocumentId {
    kind: DocumentIdKind,
    namespace: u64,
    counter: u64,
}

impl DocumentId {
    pub fn new(kind: DocumentIdKind, namespace: u64, counter: u64) -> Result<Self, DocumentError> {
        if counter == 0 || counter > MAX_STRUCTURAL_COUNTER {
            return Err(DocumentError::InvalidId);
        }
        Ok(Self {
            kind,
            namespace,
            counter,
        })
    }

    #[must_use]
    pub const fn kind(self) -> DocumentIdKind {
        self.kind
    }

    #[must_use]
    pub const fn namespace(self) -> u64 {
        self.namespace
    }

    #[must_use]
    pub const fn counter(self) -> u64 {
        self.counter
    }

    #[must_use]
    pub fn as_typescript_id(self) -> String {
        format!(
            "{}/{:016x}{:016x}",
            self.kind.prefix(),
            self.namespace,
            self.counter
        )
    }
}

impl fmt::Display for DocumentId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.as_typescript_id())
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PageGeometry {
    pub width_pt: f64,
    pub height_pt: f64,
    pub margin_top_pt: f64,
    pub margin_right_pt: f64,
    pub margin_bottom_pt: f64,
    pub margin_left_pt: f64,
    pub header_pt: f64,
    pub footer_pt: f64,
    pub gutter_pt: f64,
}

impl Default for PageGeometry {
    fn default() -> Self {
        Self {
            width_pt: 612.0,
            height_pt: 792.0,
            margin_top_pt: 72.0,
            margin_right_pt: 72.0,
            margin_bottom_pt: 72.0,
            margin_left_pt: 72.0,
            header_pt: 36.0,
            footer_pt: 36.0,
            gutter_pt: 0.0,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TextStyle {
    pub font_family: Option<String>,
    pub font_size_pt: Option<f64>,
    pub color: Option<String>,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub underline: Option<bool>,
    pub strike: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TextStylePatch {
    pub font_family: Option<Option<String>>,
    pub font_size_pt: Option<Option<f64>>,
    pub color: Option<Option<String>>,
    pub bold: Option<Option<bool>>,
    pub italic: Option<Option<bool>>,
    pub underline: Option<Option<bool>>,
    pub strike: Option<Option<bool>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TextRun {
    pub text: String,
    pub style: TextStyle,
}

impl TextRun {
    #[must_use]
    pub fn plain(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            style: TextStyle::default(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ParagraphAlignment {
    Left,
    Center,
    Right,
    Justify,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ListKind {
    Bullet,
    Number,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ListStyle {
    pub kind: ListKind,
    pub level: Option<u8>,
    pub instance_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ParagraphStyle {
    pub heading_level: Option<u8>,
    pub alignment: Option<ParagraphAlignment>,
    pub space_before_pt: Option<f64>,
    pub space_after_pt: Option<f64>,
    pub line_height: Option<f64>,
    pub keep_next: Option<bool>,
    pub page_break_before: Option<bool>,
    pub list: Option<ListStyle>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TableStyle {
    pub width_pt: Option<f64>,
    pub column_widths_pt: Option<Vec<f64>>,
    pub header_rows: Option<u32>,
    pub cell_padding_pt: Option<f64>,
    pub border_color: Option<String>,
    pub header_fill: Option<String>,
    pub allow_row_split: Option<bool>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StoryKind {
    Header,
    Footer,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StoryVariant {
    Default,
    First,
    Even,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StoryTarget {
    Body,
    Section {
        section_id: DocumentId,
        kind: StoryKind,
        variant: StoryVariant,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TextRange {
    /// UTF-16 code-unit offset, matching the TypeScript reference model.
    pub start: u32,
    /// UTF-16 code-unit offset, matching the TypeScript reference model.
    pub end: u32,
}

impl TextRange {
    pub fn new(start: u32, end: u32) -> Result<Self, DocumentError> {
        if end < start {
            return Err(DocumentError::InvalidTextRange);
        }
        Ok(Self { start, end })
    }

    #[must_use]
    pub const fn is_empty(self) -> bool {
        self.start == self.end
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CommentReply {
    pub author: String,
    pub text: String,
    pub created_at: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrackedChangeKind {
    Insert,
    Delete,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DocumentError {
    InvalidId,
    IdNamespaceMismatch,
    DuplicateId(DocumentId),
    UnknownId(DocumentId),
    WrongIdKind {
        id: DocumentId,
        expected: DocumentIdKind,
    },
    RevisionExhausted,
    StructuralIdExhausted,
    InvalidPageGeometry,
    InvalidText(&'static str),
    InvalidTextRange,
    InvalidTextStyle,
    InvalidParagraphStyle,
    InvalidTable,
    InvalidTableStyle,
    InvalidSection,
    InvalidComment,
    InvalidTrackedChange,
    CrossingCommentRanges,
    OverlappingTrackedChanges,
    LimitExceeded(&'static str),
    Unsupported(&'static str),
    InvalidSnapshot(&'static str),
    BadSnapshotMagic,
    UnsupportedSnapshotVersion(u16),
    SnapshotTruncated,
    SnapshotTrailingBytes,
    SnapshotChecksumMismatch,
    NonCanonicalSnapshot(&'static str),
}

impl fmt::Display for DocumentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidId => formatter.write_str("invalid document structural id"),
            Self::IdNamespaceMismatch => {
                formatter.write_str("document structural id belongs to another namespace")
            }
            Self::DuplicateId(id) => write!(formatter, "duplicate document structural id {id}"),
            Self::UnknownId(id) => write!(formatter, "unknown document structural id {id}"),
            Self::WrongIdKind { id, expected } => write!(
                formatter,
                "document id {id} has the wrong kind; expected {}",
                expected.prefix()
            ),
            Self::RevisionExhausted => formatter.write_str("document revision space exhausted"),
            Self::StructuralIdExhausted => {
                formatter.write_str("document structural id space exhausted")
            }
            Self::InvalidPageGeometry => formatter.write_str("invalid document page geometry"),
            Self::InvalidText(label) => write!(formatter, "invalid document text: {label}"),
            Self::InvalidTextRange => formatter.write_str("invalid document UTF-16 text range"),
            Self::InvalidTextStyle => formatter.write_str("invalid document text style"),
            Self::InvalidParagraphStyle => formatter.write_str("invalid document paragraph style"),
            Self::InvalidTable => formatter.write_str("invalid document table"),
            Self::InvalidTableStyle => formatter.write_str("invalid document table style"),
            Self::InvalidSection => formatter.write_str("invalid document section"),
            Self::InvalidComment => formatter.write_str("invalid document comment"),
            Self::InvalidTrackedChange => formatter.write_str("invalid document tracked change"),
            Self::CrossingCommentRanges => {
                formatter.write_str("comment ranges must be nested or disjoint")
            }
            Self::OverlappingTrackedChanges => {
                formatter.write_str("tracked changes must not overlap")
            }
            Self::LimitExceeded(limit) => write!(formatter, "document limit exceeded: {limit}"),
            Self::Unsupported(feature) => {
                write!(formatter, "unsupported document feature: {feature}")
            }
            Self::InvalidSnapshot(reason) => {
                write!(formatter, "invalid document snapshot: {reason}")
            }
            Self::BadSnapshotMagic => formatter.write_str("invalid document snapshot magic"),
            Self::UnsupportedSnapshotVersion(version) => {
                write!(formatter, "unsupported document snapshot version {version}")
            }
            Self::SnapshotTruncated => formatter.write_str("document snapshot is truncated"),
            Self::SnapshotTrailingBytes => {
                formatter.write_str("document snapshot has trailing bytes")
            }
            Self::SnapshotChecksumMismatch => {
                formatter.write_str("document snapshot checksum mismatch")
            }
            Self::NonCanonicalSnapshot(reason) => {
                write!(formatter, "non-canonical document snapshot: {reason}")
            }
        }
    }
}

impl std::error::Error for DocumentError {}
