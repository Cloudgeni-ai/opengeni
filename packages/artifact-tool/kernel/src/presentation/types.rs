use core::fmt;

use crate::{Number, StableId};

pub const EMU_PER_CSS_PIXEL: i64 = 9_525;
pub const MAX_PRESENTATION_SLIDES: usize = 10_000;
pub const MAX_PRESENTATION_MASTERS: usize = 1_024;
pub const MAX_PRESENTATION_LAYOUTS: usize = 4_096;
pub const MAX_PRESENTATION_NODES: usize = 250_000;
pub const MAX_PRESENTATION_ROOTS: usize = 100_000;
pub const MAX_GROUP_CHILDREN: usize = 100_000;
pub const MAX_GROUP_DEPTH: usize = 32;
pub const MAX_TEXT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_TEXT_PARAGRAPHS: usize = 100_000;
pub const MAX_TEXT_RUNS: usize = 250_000;
pub const MAX_TABLE_ROWS: usize = 10_000;
pub const MAX_TABLE_COLUMNS: usize = 1_024;
pub const MAX_TABLE_CELLS: usize = 1_000_000;
pub const MAX_CHART_SERIES: usize = 16_384;
pub const MAX_CHART_POINTS: usize = 1_000_000;
pub const MAX_NAME_BYTES: usize = 1_024;
pub const MAX_MEDIA_TYPE_BYTES: usize = 255;
pub const MAX_PRESENTATION_COORDINATE: i64 = 9_525_000_000_000;
pub const MAX_VIEWPORT_RESULTS: usize = 16_384;

#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[repr(transparent)]
pub struct Emu(i64);

impl Emu {
    pub const ZERO: Self = Self(0);

    pub fn new(value: i64) -> Result<Self, PresentationError> {
        if value.unsigned_abs() > MAX_PRESENTATION_COORDINATE as u64 {
            return Err(PresentationError::InvalidGeometry(
                "coordinate exceeds bound",
            ));
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn raw(self) -> i64 {
        self.0
    }

    pub fn checked_add(self, other: Self) -> Result<Self, PresentationError> {
        let value = self
            .0
            .checked_add(other.0)
            .ok_or(PresentationError::InvalidGeometry("coordinate overflow"))?;
        Self::new(value)
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct Rect {
    pub x: Emu,
    pub y: Emu,
    pub width: Emu,
    pub height: Emu,
}

impl Rect {
    pub fn new(x: i64, y: i64, width: i64, height: i64) -> Result<Self, PresentationError> {
        if width <= 0 || height <= 0 {
            return Err(PresentationError::InvalidGeometry(
                "width and height must be positive",
            ));
        }
        let rect = Self {
            x: Emu::new(x)?,
            y: Emu::new(y)?,
            width: Emu::new(width)?,
            height: Emu::new(height)?,
        };
        rect.right()?;
        rect.bottom()?;
        Ok(rect)
    }

    pub fn right(self) -> Result<Emu, PresentationError> {
        self.x.checked_add(self.width)
    }

    pub fn bottom(self) -> Result<Emu, PresentationError> {
        self.y.checked_add(self.height)
    }

    pub fn intersects(self, other: Self) -> bool {
        let Ok(right) = self.right() else {
            return false;
        };
        let Ok(bottom) = self.bottom() else {
            return false;
        };
        let Ok(other_right) = other.right() else {
            return false;
        };
        let Ok(other_bottom) = other.bottom() else {
            return false;
        };
        self.x < other_right && other.x < right && self.y < other_bottom && other.y < bottom
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum SceneOwner {
    Master(StableId),
    Layout(StableId),
    Slide(StableId),
}

impl SceneOwner {
    #[must_use]
    pub const fn id(self) -> StableId {
        match self {
            Self::Master(id) | Self::Layout(id) | Self::Slide(id) => id,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct Color(pub u32);

impl Color {
    pub const TRANSPARENT: Self = Self(0);
    pub const WHITE: Self = Self(0xffff_ffff);
    pub const BLACK: Self = Self(0x0000_00ff);
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Fill {
    None,
    Solid(Color),
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum LineDash {
    Solid,
    Dash,
    Dot,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct LineStyle {
    pub fill: Fill,
    pub width: Emu,
    pub dash: LineDash,
}

impl Default for LineStyle {
    fn default() -> Self {
        Self {
            fill: Fill::Solid(Color::BLACK),
            width: Emu(EMU_PER_CSS_PIXEL),
            dash: LineDash::Solid,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub struct Transform {
    /// Rotation in 1/60,000 degree units, matching OOXML without floating point.
    pub rotation: i32,
    pub flip_horizontal: bool,
    pub flip_vertical: bool,
}

impl Transform {
    pub fn validate(self) -> Result<(), PresentationError> {
        const FULL_ROTATION: i32 = 360 * 60_000;
        if !(-FULL_ROTATION..=FULL_ROTATION).contains(&self.rotation) {
            return Err(PresentationError::InvalidGeometry(
                "rotation exceeds one turn",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum HorizontalAlignment {
    Left,
    Center,
    Right,
    Justify,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum VerticalAlignment {
    Top,
    Middle,
    Bottom,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PresentationTextStyle {
    pub font_family: String,
    /// Hundredths of a point. Kept integral for deterministic snapshots.
    pub font_size_centipoints: u32,
    pub color: Color,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub language: Option<String>,
}

impl Default for PresentationTextStyle {
    fn default() -> Self {
        Self {
            font_family: "Arial".to_owned(),
            font_size_centipoints: 1_800,
            color: Color::BLACK,
            bold: false,
            italic: false,
            underline: false,
            language: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TextRun {
    pub text: String,
    pub style: PresentationTextStyle,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TextParagraph {
    pub runs: Vec<TextRun>,
    pub alignment: HorizontalAlignment,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RichText {
    pub paragraphs: Vec<TextParagraph>,
    pub vertical_alignment: VerticalAlignment,
}

impl RichText {
    #[must_use]
    pub fn plain(value: impl Into<String>) -> Self {
        Self {
            paragraphs: vec![TextParagraph {
                runs: vec![TextRun {
                    text: value.into(),
                    style: PresentationTextStyle::default(),
                }],
                alignment: HorizontalAlignment::Left,
            }],
            vertical_alignment: VerticalAlignment::Top,
        }
    }

    #[must_use]
    pub fn text(&self) -> String {
        self.paragraphs
            .iter()
            .map(|paragraph| {
                paragraph
                    .runs
                    .iter()
                    .map(|run| run.text.as_str())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ShapeGeometry {
    TextBox,
    Rectangle,
    RoundedRectangle,
    Ellipse,
    Triangle,
    RightArrow,
    Line,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Shape {
    pub geometry: ShapeGeometry,
    pub fill: Fill,
    pub line: LineStyle,
    pub text: Option<RichText>,
    pub placeholder: Option<Placeholder>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Placeholder {
    pub kind: String,
    pub index: Option<u32>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Group {
    pub child_offset_x: Emu,
    pub child_offset_y: Emu,
    pub child_extent_width: Emu,
    pub child_extent_height: Emu,
    pub children: Vec<StableId>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ConnectorKind {
    Straight,
    Elbow,
    Curved,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ConnectorEndpoint {
    /// Optional stable scene-node attachment. `None` is an absolute free endpoint.
    pub node_id: Option<StableId>,
    pub x: Emu,
    pub y: Emu,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Connector {
    pub kind: ConnectorKind,
    pub start: ConnectorEndpoint,
    pub end: ConnectorEndpoint,
    pub line: LineStyle,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ChartType {
    Bar,
    Line,
    Area,
    Pie,
    Doughnut,
    Scatter,
    Bubble,
    Radar,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ChartSeries {
    pub name: String,
    pub categories: Vec<String>,
    pub values: Vec<Number>,
    pub x_values: Vec<Number>,
    pub bubble_sizes: Vec<Number>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Chart {
    pub chart_type: ChartType,
    pub title: RichText,
    pub series: Vec<ChartSeries>,
    pub has_legend: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TableCell {
    pub text: RichText,
    pub fill: Fill,
    pub row_span: u16,
    pub column_span: u16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Table {
    /// `None` is valid only for a grid position covered by an earlier span anchor.
    pub rows: Vec<Vec<Option<TableCell>>>,
    pub column_widths: Vec<Emu>,
    pub row_heights: Vec<Emu>,
    pub line: LineStyle,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum MediaFit {
    Contain,
    Cover,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MediaReference {
    /// SHA-256 of immutable media bytes. Media payloads never live in snapshots.
    pub digest: [u8; 32],
    pub content_type: String,
    pub alt_text: String,
    pub fit: MediaFit,
    pub intrinsic_width: u32,
    pub intrinsic_height: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub enum NodeKind {
    Shape(Shape),
    Group(Group),
    Connector(Connector),
    Chart(Chart),
    Table(Table),
    Media(MediaReference),
}

impl NodeKind {
    #[must_use]
    pub const fn tag(&self) -> NodeKindTag {
        match self {
            Self::Shape(_) => NodeKindTag::Shape,
            Self::Group(_) => NodeKindTag::Group,
            Self::Connector(_) => NodeKindTag::Connector,
            Self::Chart(_) => NodeKindTag::Chart,
            Self::Table(_) => NodeKindTag::Table,
            Self::Media(_) => NodeKindTag::Media,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum NodeKindTag {
    Shape,
    Group,
    Connector,
    Chart,
    Table,
    Media,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SceneNode {
    pub id: StableId,
    pub owner: SceneOwner,
    pub parent: Option<StableId>,
    pub name: String,
    pub bounds: Rect,
    pub transform: Transform,
    pub kind: NodeKind,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Scene {
    pub(crate) roots: Vec<StableId>,
}

impl Scene {
    #[must_use]
    pub const fn new() -> Self {
        Self { roots: Vec::new() }
    }

    #[must_use]
    pub fn roots(&self) -> &[StableId] {
        &self.roots
    }
}

impl Default for Scene {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Master {
    pub id: StableId,
    pub name: String,
    pub background: Fill,
    pub scene: Scene,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Layout {
    pub id: StableId,
    pub name: String,
    pub master_id: Option<StableId>,
    pub background: Fill,
    pub scene: Scene,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Slide {
    pub id: StableId,
    pub title: String,
    pub layout_id: Option<StableId>,
    pub background: Fill,
    pub notes: RichText,
    pub scene: Scene,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NewSceneNode {
    pub id: StableId,
    pub name: String,
    pub bounds: Rect,
    pub transform: Transform,
    pub kind: NodeKind,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PresentationCommand {
    CreateMaster {
        id: StableId,
        name: String,
        background: Fill,
    },
    CreateLayout {
        id: StableId,
        name: String,
        master_id: Option<StableId>,
        background: Fill,
    },
    CreateSlide {
        id: StableId,
        index: usize,
        title: String,
        layout_id: Option<StableId>,
        background: Fill,
    },
    DeleteMaster {
        id: StableId,
    },
    DeleteLayout {
        id: StableId,
    },
    DeleteSlide {
        id: StableId,
    },
    SetSlideTitle {
        id: StableId,
        title: String,
    },
    SetSlideLayout {
        id: StableId,
        layout_id: Option<StableId>,
    },
    SetSlideNotes {
        id: StableId,
        notes: RichText,
    },
    InsertNode {
        owner: SceneOwner,
        parent: Option<StableId>,
        index: usize,
        node: NewSceneNode,
    },
    DeleteNode {
        id: StableId,
    },
    MoveNode {
        id: StableId,
        new_parent: Option<StableId>,
        index: usize,
    },
    SetNodeBounds {
        id: StableId,
        bounds: Rect,
    },
    SetNodeTransform {
        id: StableId,
        transform: Transform,
    },
    SetNodeContent {
        id: StableId,
        kind: NodeKind,
    },
    SetPresentationSize {
        size: super::model::SlideSize,
    },
    /// Explicit fail-closed representation used by decoders for known but unimplemented features.
    Unsupported {
        feature: &'static str,
    },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PresentationBatch {
    commands: Vec<PresentationCommand>,
}

impl PresentationBatch {
    #[must_use]
    pub fn from_commands(commands: Vec<PresentationCommand>) -> Self {
        Self { commands }
    }

    #[must_use]
    pub fn commands(&self) -> &[PresentationCommand] {
        &self.commands
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.commands.is_empty()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PresentationBatchReceipt {
    pub revision: u64,
    pub command_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PresentationBatchError {
    pub command_index: usize,
    pub kind: PresentationError,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PresentationError {
    InvalidId,
    IdExhausted,
    RevisionExhausted,
    DuplicateId(StableId),
    UnknownMaster(StableId),
    UnknownLayout(StableId),
    UnknownSlide(StableId),
    UnknownNode(StableId),
    InvalidOwner,
    InvalidParent,
    ParentCycle,
    NonEmptyScene,
    ReferencedObject,
    InvalidOrderIndex,
    InvalidGeometry(&'static str),
    InvalidText(&'static str),
    InvalidStyle(&'static str),
    InvalidTable(&'static str),
    InvalidChart(&'static str),
    InvalidMedia(&'static str),
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

impl fmt::Display for PresentationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidId => formatter.write_str("invalid presentation object id"),
            Self::IdExhausted => formatter.write_str("presentation id namespace exhausted"),
            Self::RevisionExhausted => formatter.write_str("presentation revision exhausted"),
            Self::DuplicateId(id) => write!(formatter, "duplicate presentation object id {id}"),
            Self::UnknownMaster(id) => write!(formatter, "unknown presentation master {id}"),
            Self::UnknownLayout(id) => write!(formatter, "unknown presentation layout {id}"),
            Self::UnknownSlide(id) => write!(formatter, "unknown presentation slide {id}"),
            Self::UnknownNode(id) => write!(formatter, "unknown presentation scene node {id}"),
            Self::InvalidOwner => formatter.write_str("invalid presentation scene owner"),
            Self::InvalidParent => formatter.write_str("invalid presentation node parent"),
            Self::ParentCycle => formatter.write_str("presentation group parent cycle"),
            Self::NonEmptyScene => formatter.write_str("presentation scene is not empty"),
            Self::ReferencedObject => {
                formatter.write_str("presentation object is still referenced")
            }
            Self::InvalidOrderIndex => {
                formatter.write_str("presentation order index is out of bounds")
            }
            Self::InvalidGeometry(reason) => {
                write!(formatter, "invalid presentation geometry: {reason}")
            }
            Self::InvalidText(reason) => write!(formatter, "invalid presentation text: {reason}"),
            Self::InvalidStyle(reason) => write!(formatter, "invalid presentation style: {reason}"),
            Self::InvalidTable(reason) => write!(formatter, "invalid presentation table: {reason}"),
            Self::InvalidChart(reason) => write!(formatter, "invalid presentation chart: {reason}"),
            Self::InvalidMedia(reason) => write!(formatter, "invalid presentation media: {reason}"),
            Self::LimitExceeded(reason) => {
                write!(formatter, "presentation limit exceeded: {reason}")
            }
            Self::Unsupported(feature) => {
                write!(formatter, "unsupported presentation feature: {feature}")
            }
            Self::InvalidSnapshot(reason) => {
                write!(formatter, "invalid presentation snapshot: {reason}")
            }
            Self::BadSnapshotMagic => formatter.write_str("invalid presentation snapshot magic"),
            Self::UnsupportedSnapshotVersion(version) => write!(
                formatter,
                "unsupported presentation snapshot version {version}"
            ),
            Self::SnapshotTruncated => formatter.write_str("presentation snapshot is truncated"),
            Self::SnapshotTrailingBytes => {
                formatter.write_str("presentation snapshot has trailing bytes")
            }
            Self::SnapshotChecksumMismatch => {
                formatter.write_str("presentation snapshot checksum mismatch")
            }
            Self::NonCanonicalSnapshot(reason) => {
                write!(formatter, "non-canonical presentation snapshot: {reason}")
            }
        }
    }
}

impl std::error::Error for PresentationError {}
