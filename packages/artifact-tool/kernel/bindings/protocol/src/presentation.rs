//! Isolated bounded byte ABI for the native presentation kernel.
//!
//! `OGAPC001` contains pure presentation commands only. Artifact identity,
//! actor identity, transaction identity, and causality remain exclusively in
//! the outer collaboration protocol.

use std::collections::BTreeSet;

use opengeni_artifact_kernel::presentation::{
    decode_presentation_snapshot, encode_presentation_snapshot, presentation_state_hash, Chart,
    ChartSeries, ChartType, Color, Connector, ConnectorEndpoint, ConnectorKind, Emu, Fill, Group,
    HorizontalAlignment, LineDash, LineStyle, MediaFit, MediaReference, NewSceneNode, NodeKind,
    NodeKindTag, Placeholder, Presentation, PresentationBatch, PresentationBatchError,
    PresentationCommand, PresentationError, PresentationTextStyle, ProjectedSceneNode, Rect,
    ResolvedSceneNode, RichText, SceneOwner, Shape, ShapeGeometry, Slide, SlideSize, Table,
    TableCell, TextParagraph, TextRun, Transform, VerticalAlignment, ViewportProjection,
    MAX_CHART_POINTS, MAX_CHART_SERIES, MAX_GROUP_CHILDREN, MAX_MEDIA_TYPE_BYTES, MAX_NAME_BYTES,
    MAX_TABLE_CELLS, MAX_TABLE_COLUMNS, MAX_TABLE_ROWS, MAX_TEXT_BYTES, MAX_TEXT_PARAGRAPHS,
    MAX_TEXT_RUNS, MAX_VIEWPORT_RESULTS,
};
use opengeni_artifact_kernel::{Number, StableId};

use super::{
    checksum, decode_namespace, read_u16, read_u32, read_u64, validate_limits, BindingError,
    BindingLimits, NATIVE_LIMITS,
};

pub const PRESENTATION_COMMAND_VERSION: u16 = 1;
pub const PRESENTATION_QUERY_VERSION: u16 = 1;
pub const PRESENTATION_RESPONSE_VERSION: u16 = 1;
pub const MAX_PRESENTATION_COMMAND_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_PRESENTATION_COMMANDS: usize = 10_000;
pub const MAX_PRESENTATION_QUERY_BYTES: usize = 96;
pub const MAX_PRESENTATION_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_PRESENTATION_QUERY_TEXT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_PRESENTATION_SLIDES: usize = 10_000;

const COMMAND_MAGIC: [u8; 8] = *b"OGAPC001";
const RECEIPT_MAGIC: [u8; 8] = *b"OGAPR001";
const QUERY_MAGIC: [u8; 8] = *b"OGAPQ001";
const RESPONSE_MAGIC: [u8; 8] = *b"OGAPV001";
const COMMAND_HEADER_BYTES: usize = 8 + 2 + 2 + 4 + 8;
const QUERY_HEADER_BYTES: usize = 8 + 2 + 2 + 1 + 3 + 4 + 4 + 4;
const RESPONSE_HEADER_BYTES: usize = 8 + 2 + 2 + 1 + 3 + 8 + 4 + 4;
const CHECKSUM_BYTES: usize = 8;
const RESPONSE_FLAG_TRUNCATED: u16 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum PresentationQueryKind {
    Viewport = 0,
    HitTest = 1,
    ResolvedSlide = 2,
    Metadata = 3,
    SlideCatalog = 4,
    EditorSlide = 5,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PresentationViewportQuery {
    pub owner: SceneOwner,
    pub viewport: Rect,
    pub max_nodes: u32,
    pub max_bytes: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PresentationHitTestQuery {
    pub owner: SceneOwner,
    pub x: Emu,
    pub y: Emu,
    pub max_nodes: u32,
    pub max_bytes: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ResolvedSlideQuery {
    pub slide_id: StableId,
    pub max_nodes: u32,
    pub max_bytes: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PresentationMetadataQuery {
    pub max_bytes: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PresentationSlideCatalogQuery {
    pub start_slide: u32,
    pub max_slides: u32,
    pub max_text_bytes: u32,
    pub max_bytes: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PresentationEditorSlideQuery {
    pub slide_id: StableId,
    pub max_nodes: u32,
    pub max_text_bytes: u32,
    pub max_bytes: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PresentationSlideLayoutFacts {
    pub id: StableId,
    pub name: String,
    pub master_id: Option<StableId>,
    pub background: Fill,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PresentationSlideCatalogItem {
    pub index: u32,
    pub id: StableId,
    pub title: String,
    pub background: Fill,
    pub layout: Option<PresentationSlideLayoutFacts>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PresentationSlideCatalogResponse {
    pub revision: u64,
    pub start_slide: u32,
    pub next_slide: Option<u32>,
    pub projected_text_bytes: u32,
    pub slides: Vec<PresentationSlideCatalogItem>,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PresentationEditorSceneNode {
    pub id: StableId,
    pub source: SceneOwner,
    pub inherited: bool,
    pub parent: Option<StableId>,
    pub order: u32,
    pub name: String,
    pub bounds: Rect,
    pub transform: Transform,
    pub kind: NodeKind,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PresentationEditorSlideResponse {
    pub revision: u64,
    pub slide: PresentationSlideCatalogItem,
    /// `None` means notes were omitted by a caller-provided text/byte bound.
    pub notes: Option<RichText>,
    pub projected_text_bytes: u32,
    pub nodes: Vec<PresentationEditorSceneNode>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PresentationMetadataResponse {
    pub revision: u64,
    pub presentation_id: StableId,
    pub slide_size: SlideSize,
    pub masters: u32,
    pub layouts: u32,
    pub slides: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedSlideResponse {
    pub revision: u64,
    pub slide_id: StableId,
    pub nodes: Vec<ResolvedSceneNode>,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PresentationQueryResponse {
    Viewport(ViewportProjection),
    HitTest(ViewportProjection),
    ResolvedSlide(ResolvedSlideResponse),
    Metadata(PresentationMetadataResponse),
    SlideCatalog(PresentationSlideCatalogResponse),
    EditorSlide(PresentationEditorSlideResponse),
}

#[derive(Debug)]
pub struct PresentationBindingSession {
    presentation: Option<Presentation>,
    snapshot_size_upper_bound: usize,
    limits: BindingLimits,
}

impl PresentationBindingSession {
    pub fn create(namespace_envelope: &[u8]) -> Result<Self, BindingError> {
        Self::create_with_limits(namespace_envelope, NATIVE_LIMITS)
    }

    pub fn create_with_limits(
        namespace_envelope: &[u8],
        limits: BindingLimits,
    ) -> Result<Self, BindingError> {
        validate_limits(limits)?;
        let namespace = decode_namespace(namespace_envelope)?;
        let presentation = Presentation::new(namespace, SlideSize::widescreen())
            .map_err(map_presentation_error)?;
        let snapshot_size_upper_bound = encode_presentation_snapshot(&presentation)
            .map_err(map_presentation_error)?
            .len();
        if snapshot_size_upper_bound > limits.max_snapshot_bytes {
            return Err(BindingError::Limit("presentation snapshot"));
        }
        Ok(Self {
            presentation: Some(presentation),
            snapshot_size_upper_bound,
            limits,
        })
    }

    pub fn open(snapshot: &[u8]) -> Result<Self, BindingError> {
        Self::open_with_limits(snapshot, NATIVE_LIMITS)
    }

    pub fn open_with_limits(snapshot: &[u8], limits: BindingLimits) -> Result<Self, BindingError> {
        validate_limits(limits)?;
        if snapshot.len() > limits.max_snapshot_bytes {
            return Err(BindingError::Limit("presentation snapshot"));
        }
        let presentation =
            decode_presentation_snapshot(snapshot).map_err(map_presentation_error)?;
        Ok(Self {
            presentation: Some(presentation),
            snapshot_size_upper_bound: snapshot.len(),
            limits,
        })
    }

    pub fn apply_commands(&mut self, command_envelope: &[u8]) -> Result<Vec<u8>, BindingError> {
        self.ensure_open()?;
        let command_limit = self
            .limits
            .max_command_bytes
            .min(MAX_PRESENTATION_COMMAND_BYTES);
        if command_envelope.len() > command_limit {
            return Err(BindingError::Limit("presentation command envelope"));
        }
        let batch = decode_presentation_command_batch_with_limit(command_envelope, command_limit)?;
        let growth_bound = command_envelope
            .len()
            .checked_mul(2)
            .and_then(|value| value.checked_add(batch.commands().len().saturating_mul(256)))
            .ok_or(BindingError::Limit("presentation snapshot growth"))?;
        let needs_boundary_probe = self
            .snapshot_size_upper_bound
            .checked_add(growth_bound)
            .is_none_or(|size| size > self.limits.max_snapshot_bytes);
        let receipt = if needs_boundary_probe {
            if !self.limits.allow_boundary_probe {
                return Err(BindingError::Limit("presentation snapshot growth"));
            }
            let transaction = self
                .presentation
                .as_mut()
                .ok_or(BindingError::Closed)?
                .begin_batch(&batch)
                .map_err(map_presentation_batch_error)?;
            let exact = encode_presentation_snapshot(transaction.presentation())
                .map_err(map_presentation_error)?;
            if exact.len() > self.limits.max_snapshot_bytes {
                return Err(BindingError::Limit("presentation snapshot"));
            }
            self.snapshot_size_upper_bound = exact.len();
            transaction.commit()
        } else {
            let receipt = self
                .presentation
                .as_mut()
                .ok_or(BindingError::Closed)?
                .apply_batch(&batch)
                .map_err(map_presentation_batch_error)?;
            self.snapshot_size_upper_bound = self
                .snapshot_size_upper_bound
                .checked_add(growth_bound)
                .ok_or(BindingError::Limit("presentation snapshot growth"))?;
            receipt
        };
        Ok(encode_presentation_receipt(
            receipt.revision,
            receipt.command_count,
        ))
    }

    pub fn snapshot(&self) -> Result<Vec<u8>, BindingError> {
        let snapshot =
            encode_presentation_snapshot(self.presentation.as_ref().ok_or(BindingError::Closed)?)
                .map_err(map_presentation_error)?;
        if snapshot.len() > self.limits.max_snapshot_bytes {
            return Err(BindingError::Limit("presentation snapshot"));
        }
        Ok(snapshot)
    }

    pub fn revision(&self) -> Result<u64, BindingError> {
        Ok(self
            .presentation
            .as_ref()
            .ok_or(BindingError::Closed)?
            .revision())
    }

    pub fn state_hash(&self) -> Result<String, BindingError> {
        let hash = presentation_state_hash(self.presentation.as_ref().ok_or(BindingError::Closed)?)
            .map_err(map_presentation_error)?;
        Ok(format_hash(hash))
    }

    pub fn query(&self, query_envelope: &[u8]) -> Result<Vec<u8>, BindingError> {
        query_presentation(
            self.presentation.as_ref().ok_or(BindingError::Closed)?,
            query_envelope,
            self.limits
                .max_command_bytes
                .min(MAX_PRESENTATION_RESPONSE_BYTES),
        )
    }

    pub fn fork(&self) -> Result<Self, BindingError> {
        Ok(Self {
            presentation: Some(
                self.presentation
                    .as_ref()
                    .ok_or(BindingError::Closed)?
                    .clone(),
            ),
            snapshot_size_upper_bound: self.snapshot_size_upper_bound,
            limits: self.limits,
        })
    }

    pub fn close(&mut self) {
        self.presentation = None;
        self.snapshot_size_upper_bound = 0;
    }

    #[must_use]
    pub const fn is_closed(&self) -> bool {
        self.presentation.is_none()
    }

    fn ensure_open(&self) -> Result<(), BindingError> {
        if self.is_closed() {
            Err(BindingError::Closed)
        } else {
            Ok(())
        }
    }
}

pub fn create_presentation(namespace_envelope: &[u8]) -> Result<Vec<u8>, BindingError> {
    PresentationBindingSession::create(namespace_envelope)?.snapshot()
}

pub fn canonicalize_presentation_snapshot(snapshot: &[u8]) -> Result<Vec<u8>, BindingError> {
    PresentationBindingSession::open(snapshot)?.snapshot()
}

pub fn apply_presentation_commands(
    snapshot: &[u8],
    command_envelope: &[u8],
) -> Result<Vec<u8>, BindingError> {
    let mut session = PresentationBindingSession::open(snapshot)?;
    session.apply_commands(command_envelope)?;
    session.snapshot()
}

pub fn query_presentation_snapshot(
    snapshot: &[u8],
    query_envelope: &[u8],
) -> Result<Vec<u8>, BindingError> {
    PresentationBindingSession::open(snapshot)?.query(query_envelope)
}

pub fn encode_presentation_command_batch(
    batch: &PresentationBatch,
) -> Result<Vec<u8>, BindingError> {
    encode_command_batch_with_limit(batch, MAX_PRESENTATION_COMMAND_BYTES)
}

pub fn decode_presentation_command_batch(bytes: &[u8]) -> Result<PresentationBatch, BindingError> {
    decode_presentation_command_batch_with_limit(bytes, MAX_PRESENTATION_COMMAND_BYTES)
}

fn encode_command_batch_with_limit(
    batch: &PresentationBatch,
    maximum: usize,
) -> Result<Vec<u8>, BindingError> {
    if batch.commands().len() > MAX_PRESENTATION_COMMANDS {
        return Err(BindingError::Limit("presentation command count"));
    }
    let mut encoder = WireEncoder::new(maximum - COMMAND_HEADER_BYTES - CHECKSUM_BYTES);
    for command in batch.commands() {
        encoder.command(command)?;
    }
    let payload = encoder.finish();
    let mut output = Vec::with_capacity(COMMAND_HEADER_BYTES + payload.len() + CHECKSUM_BYTES);
    output.extend_from_slice(&COMMAND_MAGIC);
    output.extend_from_slice(&PRESENTATION_COMMAND_VERSION.to_le_bytes());
    output.extend_from_slice(&0u16.to_le_bytes());
    output.extend_from_slice(
        &u32::try_from(batch.commands().len())
            .map_err(|_| BindingError::Limit("presentation command count"))?
            .to_le_bytes(),
    );
    output.extend_from_slice(
        &u64::try_from(payload.len())
            .map_err(|_| BindingError::Limit("presentation command payload"))?
            .to_le_bytes(),
    );
    output.extend_from_slice(&payload);
    output.extend_from_slice(&checksum(&output).to_le_bytes());
    if output.len() > maximum {
        return Err(BindingError::Limit("presentation command envelope"));
    }
    Ok(output)
}

fn decode_presentation_command_batch_with_limit(
    bytes: &[u8],
    maximum: usize,
) -> Result<PresentationBatch, BindingError> {
    let (command_count, payload) = decode_envelope(
        bytes,
        maximum,
        COMMAND_MAGIC,
        PRESENTATION_COMMAND_VERSION,
        "presentation command",
    )?;
    if command_count > MAX_PRESENTATION_COMMANDS {
        return Err(BindingError::Limit("presentation command count"));
    }
    let mut decoder = WireDecoder::new(payload);
    let mut commands = Vec::new();
    commands
        .try_reserve_exact(command_count)
        .map_err(|_| BindingError::Limit("presentation command count"))?;
    for _ in 0..command_count {
        commands.push(decoder.command()?);
    }
    if !decoder.is_empty() {
        return Err(BindingError::TrailingBytes);
    }
    Ok(PresentationBatch::from_commands(commands))
}

fn decode_envelope<'a>(
    bytes: &'a [u8],
    maximum: usize,
    magic: [u8; 8],
    version: u16,
    label: &'static str,
) -> Result<(usize, &'a [u8]), BindingError> {
    if bytes.len() > maximum {
        return Err(BindingError::Limit(label));
    }
    if bytes.len() < COMMAND_HEADER_BYTES + CHECKSUM_BYTES {
        return Err(BindingError::Truncated);
    }
    if bytes[..8] != magic {
        return Err(BindingError::BadMagic(label));
    }
    let encoded_version = read_u16(&bytes[8..10])?;
    if encoded_version != version {
        return Err(BindingError::UnsupportedVersion(encoded_version));
    }
    if read_u16(&bytes[10..12])? != 0 {
        return Err(BindingError::NonCanonical(
            "reserved presentation header bits",
        ));
    }
    let count =
        usize::try_from(read_u32(&bytes[12..16])?).map_err(|_| BindingError::Limit(label))?;
    let payload_len =
        usize::try_from(read_u64(&bytes[16..24])?).map_err(|_| BindingError::Limit(label))?;
    let payload_end = COMMAND_HEADER_BYTES
        .checked_add(payload_len)
        .ok_or(BindingError::Limit(label))?;
    let expected = payload_end
        .checked_add(CHECKSUM_BYTES)
        .ok_or(BindingError::Limit(label))?;
    if bytes.len() != expected {
        return Err(if bytes.len() < expected {
            BindingError::Truncated
        } else {
            BindingError::TrailingBytes
        });
    }
    if checksum(&bytes[..payload_end]) != read_u64(&bytes[payload_end..])? {
        return Err(BindingError::ChecksumMismatch);
    }
    Ok((count, &bytes[COMMAND_HEADER_BYTES..payload_end]))
}

struct WireEncoder {
    bytes: Vec<u8>,
    maximum: usize,
}

impl WireEncoder {
    fn new(maximum: usize) -> Self {
        Self {
            bytes: Vec::new(),
            maximum,
        }
    }
    fn finish(self) -> Vec<u8> {
        self.bytes
    }
    fn len(&self) -> usize {
        self.bytes.len()
    }
    fn append(&mut self, bytes: &[u8]) -> Result<(), BindingError> {
        let next = self
            .bytes
            .len()
            .checked_add(bytes.len())
            .ok_or(BindingError::Limit("presentation command payload"))?;
        if next > self.maximum {
            return Err(BindingError::Limit("presentation command payload"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }
    fn u8(&mut self, value: u8) -> Result<(), BindingError> {
        self.append(&[value])
    }
    fn bool(&mut self, value: bool) -> Result<(), BindingError> {
        self.u8(u8::from(value))
    }
    fn u16(&mut self, value: u16) -> Result<(), BindingError> {
        self.append(&value.to_le_bytes())
    }
    fn u32(&mut self, value: u32) -> Result<(), BindingError> {
        self.append(&value.to_le_bytes())
    }
    fn i32(&mut self, value: i32) -> Result<(), BindingError> {
        self.append(&value.to_le_bytes())
    }
    fn u64(&mut self, value: u64) -> Result<(), BindingError> {
        self.append(&value.to_le_bytes())
    }
    fn i64(&mut self, value: i64) -> Result<(), BindingError> {
        self.append(&value.to_le_bytes())
    }
    fn id(&mut self, value: StableId) -> Result<(), BindingError> {
        self.append(&value.to_le_bytes())
    }
    fn count(&mut self, value: usize, maximum: usize) -> Result<(), BindingError> {
        if value > maximum {
            return Err(BindingError::Limit("presentation collection"));
        }
        self.u32(u32::try_from(value).map_err(|_| BindingError::Limit("presentation collection"))?)
    }
    fn index(&mut self, value: usize) -> Result<(), BindingError> {
        self.u32(u32::try_from(value).map_err(|_| BindingError::Limit("presentation index"))?)
    }
    fn string(&mut self, value: &str, maximum: usize) -> Result<(), BindingError> {
        if value.len() > maximum {
            return Err(BindingError::Limit("presentation string"));
        }
        self.count(value.len(), maximum)?;
        self.append(value.as_bytes())
    }
    fn optional_id(&mut self, value: Option<StableId>) -> Result<(), BindingError> {
        self.bool(value.is_some())?;
        if let Some(id) = value {
            self.id(id)?;
        }
        Ok(())
    }
    fn owner(&mut self, owner: SceneOwner) -> Result<(), BindingError> {
        match owner {
            SceneOwner::Master(id) => {
                self.u8(0)?;
                self.id(id)
            }
            SceneOwner::Layout(id) => {
                self.u8(1)?;
                self.id(id)
            }
            SceneOwner::Slide(id) => {
                self.u8(2)?;
                self.id(id)
            }
        }
    }
    fn fill(&mut self, fill: Fill) -> Result<(), BindingError> {
        match fill {
            Fill::None => self.u8(0),
            Fill::Solid(color) => {
                self.u8(1)?;
                self.u32(color.0)
            }
        }
    }
    fn line(&mut self, line: LineStyle) -> Result<(), BindingError> {
        self.fill(line.fill)?;
        self.i64(line.width.raw())?;
        self.u8(match line.dash {
            LineDash::Solid => 0,
            LineDash::Dash => 1,
            LineDash::Dot => 2,
        })
    }
    fn rect(&mut self, rect: Rect) -> Result<(), BindingError> {
        self.i64(rect.x.raw())?;
        self.i64(rect.y.raw())?;
        self.i64(rect.width.raw())?;
        self.i64(rect.height.raw())
    }
    fn transform(&mut self, transform: Transform) -> Result<(), BindingError> {
        self.i32(transform.rotation)?;
        self.bool(transform.flip_horizontal)?;
        self.bool(transform.flip_vertical)
    }
    fn rich_text(&mut self, text: &RichText) -> Result<(), BindingError> {
        self.u8(match text.vertical_alignment {
            VerticalAlignment::Top => 0,
            VerticalAlignment::Middle => 1,
            VerticalAlignment::Bottom => 2,
        })?;
        self.count(text.paragraphs.len(), MAX_TEXT_PARAGRAPHS)?;
        let mut total_runs = 0usize;
        let mut total_bytes = 0usize;
        for paragraph in &text.paragraphs {
            self.u8(match paragraph.alignment {
                HorizontalAlignment::Left => 0,
                HorizontalAlignment::Center => 1,
                HorizontalAlignment::Right => 2,
                HorizontalAlignment::Justify => 3,
            })?;
            total_runs = total_runs
                .checked_add(paragraph.runs.len())
                .ok_or(BindingError::Limit("presentation text runs"))?;
            if total_runs > MAX_TEXT_RUNS {
                return Err(BindingError::Limit("presentation text runs"));
            }
            self.count(paragraph.runs.len(), MAX_TEXT_RUNS)?;
            for run in &paragraph.runs {
                total_bytes = total_bytes
                    .checked_add(run.text.len())
                    .ok_or(BindingError::Limit("presentation text bytes"))?;
                if total_bytes > MAX_TEXT_BYTES {
                    return Err(BindingError::Limit("presentation text bytes"));
                }
                self.string(&run.text, MAX_TEXT_BYTES)?;
                self.text_style(&run.style)?;
            }
        }
        Ok(())
    }
    fn text_style(&mut self, style: &PresentationTextStyle) -> Result<(), BindingError> {
        self.string(&style.font_family, MAX_NAME_BYTES)?;
        self.u32(style.font_size_centipoints)?;
        self.u32(style.color.0)?;
        self.bool(style.bold)?;
        self.bool(style.italic)?;
        self.bool(style.underline)?;
        self.bool(style.language.is_some())?;
        if let Some(language) = &style.language {
            self.string(language, 128)?;
        }
        Ok(())
    }
    fn command(&mut self, command: &PresentationCommand) -> Result<(), BindingError> {
        match command {
            PresentationCommand::CreateMaster {
                id,
                name,
                background,
            } => {
                self.u8(0)?;
                self.id(*id)?;
                self.string(name, MAX_NAME_BYTES)?;
                self.fill(*background)
            }
            PresentationCommand::CreateLayout {
                id,
                name,
                master_id,
                background,
            } => {
                self.u8(1)?;
                self.id(*id)?;
                self.string(name, MAX_NAME_BYTES)?;
                self.optional_id(*master_id)?;
                self.fill(*background)
            }
            PresentationCommand::CreateSlide {
                id,
                index,
                title,
                layout_id,
                background,
            } => {
                self.u8(2)?;
                self.id(*id)?;
                self.index(*index)?;
                self.string(title, MAX_NAME_BYTES)?;
                self.optional_id(*layout_id)?;
                self.fill(*background)
            }
            PresentationCommand::DeleteMaster { id } => {
                self.u8(3)?;
                self.id(*id)
            }
            PresentationCommand::DeleteLayout { id } => {
                self.u8(4)?;
                self.id(*id)
            }
            PresentationCommand::DeleteSlide { id } => {
                self.u8(5)?;
                self.id(*id)
            }
            PresentationCommand::SetSlideTitle { id, title } => {
                self.u8(6)?;
                self.id(*id)?;
                self.string(title, MAX_NAME_BYTES)
            }
            PresentationCommand::SetSlideLayout { id, layout_id } => {
                self.u8(7)?;
                self.id(*id)?;
                self.optional_id(*layout_id)
            }
            PresentationCommand::SetSlideNotes { id, notes } => {
                self.u8(8)?;
                self.id(*id)?;
                self.rich_text(notes)
            }
            PresentationCommand::InsertNode {
                owner,
                parent,
                index,
                node,
            } => {
                self.u8(9)?;
                self.owner(*owner)?;
                self.optional_id(*parent)?;
                self.index(*index)?;
                self.new_node(node)
            }
            PresentationCommand::DeleteNode { id } => {
                self.u8(10)?;
                self.id(*id)
            }
            PresentationCommand::MoveNode {
                id,
                new_parent,
                index,
            } => {
                self.u8(11)?;
                self.id(*id)?;
                self.optional_id(*new_parent)?;
                self.index(*index)
            }
            PresentationCommand::SetNodeBounds { id, bounds } => {
                self.u8(12)?;
                self.id(*id)?;
                self.rect(*bounds)
            }
            PresentationCommand::SetNodeTransform { id, transform } => {
                self.u8(13)?;
                self.id(*id)?;
                self.transform(*transform)
            }
            PresentationCommand::SetNodeContent { id, kind } => {
                self.u8(14)?;
                self.id(*id)?;
                self.node_kind(kind)
            }
            PresentationCommand::SetPresentationSize { size } => {
                self.u8(15)?;
                self.i64(size.width.raw())?;
                self.i64(size.height.raw())
            }
            PresentationCommand::Unsupported { .. } => Err(BindingError::NonCanonical(
                "unsupported commands are not encodable",
            )),
        }
    }
    fn new_node(&mut self, node: &NewSceneNode) -> Result<(), BindingError> {
        self.id(node.id)?;
        self.string(&node.name, MAX_NAME_BYTES)?;
        self.rect(node.bounds)?;
        self.transform(node.transform)?;
        self.node_kind(&node.kind)
    }
    fn node_kind(&mut self, kind: &NodeKind) -> Result<(), BindingError> {
        match kind {
            NodeKind::Shape(shape) => {
                self.u8(0)?;
                self.u8(match shape.geometry {
                    ShapeGeometry::TextBox => 0,
                    ShapeGeometry::Rectangle => 1,
                    ShapeGeometry::RoundedRectangle => 2,
                    ShapeGeometry::Ellipse => 3,
                    ShapeGeometry::Triangle => 4,
                    ShapeGeometry::RightArrow => 5,
                    ShapeGeometry::Line => 6,
                })?;
                self.fill(shape.fill)?;
                self.line(shape.line)?;
                self.bool(shape.text.is_some())?;
                if let Some(text) = &shape.text {
                    self.rich_text(text)?;
                }
                self.bool(shape.placeholder.is_some())?;
                if let Some(placeholder) = &shape.placeholder {
                    self.string(&placeholder.kind, MAX_NAME_BYTES)?;
                    self.bool(placeholder.index.is_some())?;
                    if let Some(index) = placeholder.index {
                        self.u32(index)?;
                    }
                }
                Ok(())
            }
            NodeKind::Group(group) => {
                self.u8(1)?;
                self.i64(group.child_offset_x.raw())?;
                self.i64(group.child_offset_y.raw())?;
                self.i64(group.child_extent_width.raw())?;
                self.i64(group.child_extent_height.raw())?;
                self.count(group.children.len(), MAX_GROUP_CHILDREN)?;
                for id in &group.children {
                    self.id(*id)?;
                }
                Ok(())
            }
            NodeKind::Connector(connector) => {
                self.u8(2)?;
                self.u8(match connector.kind {
                    ConnectorKind::Straight => 0,
                    ConnectorKind::Elbow => 1,
                    ConnectorKind::Curved => 2,
                })?;
                self.connector_endpoint(connector.start)?;
                self.connector_endpoint(connector.end)?;
                self.line(connector.line)
            }
            NodeKind::Chart(chart) => {
                self.u8(3)?;
                self.u8(match chart.chart_type {
                    ChartType::Bar => 0,
                    ChartType::Line => 1,
                    ChartType::Area => 2,
                    ChartType::Pie => 3,
                    ChartType::Doughnut => 4,
                    ChartType::Scatter => 5,
                    ChartType::Bubble => 6,
                    ChartType::Radar => 7,
                })?;
                self.rich_text(&chart.title)?;
                self.count(chart.series.len(), MAX_CHART_SERIES)?;
                let mut points = 0usize;
                for series in &chart.series {
                    self.string(&series.name, MAX_NAME_BYTES)?;
                    points = points
                        .checked_add(series.categories.len())
                        .and_then(|value| value.checked_add(series.values.len()))
                        .and_then(|value| value.checked_add(series.x_values.len()))
                        .and_then(|value| value.checked_add(series.bubble_sizes.len()))
                        .ok_or(BindingError::Limit("presentation chart points"))?;
                    if points > MAX_CHART_POINTS {
                        return Err(BindingError::Limit("presentation chart points"));
                    }
                    self.string_vec(&series.categories)?;
                    self.number_vec(&series.values)?;
                    self.number_vec(&series.x_values)?;
                    self.number_vec(&series.bubble_sizes)?;
                }
                self.bool(chart.has_legend)
            }
            NodeKind::Table(table) => {
                self.u8(4)?;
                let columns = table.rows.first().map_or(0, Vec::len);
                self.count(table.rows.len(), MAX_TABLE_ROWS)?;
                self.count(columns, MAX_TABLE_COLUMNS)?;
                for row in &table.rows {
                    for cell in row {
                        self.bool(cell.is_some())?;
                        if let Some(cell) = cell {
                            self.rich_text(&cell.text)?;
                            self.fill(cell.fill)?;
                            self.u16(cell.row_span)?;
                            self.u16(cell.column_span)?;
                        }
                    }
                }
                self.count(table.column_widths.len(), MAX_TABLE_COLUMNS)?;
                for width in &table.column_widths {
                    self.i64(width.raw())?;
                }
                self.count(table.row_heights.len(), MAX_TABLE_ROWS)?;
                for height in &table.row_heights {
                    self.i64(height.raw())?;
                }
                self.line(table.line)
            }
            NodeKind::Media(media) => {
                self.u8(5)?;
                self.append(&media.digest)?;
                self.string(&media.content_type, MAX_MEDIA_TYPE_BYTES)?;
                self.string(&media.alt_text, MAX_TEXT_BYTES)?;
                self.u8(match media.fit {
                    MediaFit::Contain => 0,
                    MediaFit::Cover => 1,
                })?;
                self.u32(media.intrinsic_width)?;
                self.u32(media.intrinsic_height)
            }
        }
    }
    fn connector_endpoint(&mut self, endpoint: ConnectorEndpoint) -> Result<(), BindingError> {
        self.optional_id(endpoint.node_id)?;
        self.i64(endpoint.x.raw())?;
        self.i64(endpoint.y.raw())
    }
    fn string_vec(&mut self, values: &[String]) -> Result<(), BindingError> {
        self.count(values.len(), MAX_CHART_POINTS)?;
        for value in values {
            self.string(value, MAX_NAME_BYTES)?;
        }
        Ok(())
    }
    fn number_vec(&mut self, values: &[Number]) -> Result<(), BindingError> {
        self.count(values.len(), MAX_CHART_POINTS)?;
        for value in values {
            self.u64(value.get().to_bits())?;
        }
        Ok(())
    }
}

struct WireDecoder<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> WireDecoder<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }
    fn is_empty(&self) -> bool {
        self.offset == self.bytes.len()
    }
    fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.offset)
    }
    fn take(&mut self, count: usize) -> Result<&'a [u8], BindingError> {
        let end = self
            .offset
            .checked_add(count)
            .ok_or(BindingError::Limit("presentation payload offset"))?;
        let output = self
            .bytes
            .get(self.offset..end)
            .ok_or(BindingError::Truncated)?;
        self.offset = end;
        Ok(output)
    }
    fn u8(&mut self) -> Result<u8, BindingError> {
        Ok(self.take(1)?[0])
    }
    fn bool(&mut self) -> Result<bool, BindingError> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(BindingError::NonCanonical("invalid presentation boolean")),
        }
    }
    fn u16(&mut self) -> Result<u16, BindingError> {
        read_u16(self.take(2)?)
    }
    fn u32(&mut self) -> Result<u32, BindingError> {
        read_u32(self.take(4)?)
    }
    fn i32(&mut self) -> Result<i32, BindingError> {
        Ok(i32::from_le_bytes(
            self.take(4)?
                .try_into()
                .map_err(|_| BindingError::Truncated)?,
        ))
    }
    fn u64(&mut self) -> Result<u64, BindingError> {
        read_u64(self.take(8)?)
    }
    fn i64(&mut self) -> Result<i64, BindingError> {
        Ok(i64::from_le_bytes(
            self.take(8)?
                .try_into()
                .map_err(|_| BindingError::Truncated)?,
        ))
    }
    fn id(&mut self) -> Result<StableId, BindingError> {
        Ok(StableId::from_le_bytes(
            self.take(16)?
                .try_into()
                .map_err(|_| BindingError::Truncated)?,
        ))
    }
    fn count(&mut self, maximum: usize, minimum_bytes: usize) -> Result<usize, BindingError> {
        let count = usize::try_from(self.u32()?)
            .map_err(|_| BindingError::Limit("presentation collection"))?;
        if count > maximum {
            return Err(BindingError::Limit("presentation collection"));
        }
        if minimum_bytes > 0 && count > self.remaining() / minimum_bytes {
            return Err(BindingError::Truncated);
        }
        Ok(count)
    }
    fn index(&mut self) -> Result<usize, BindingError> {
        usize::try_from(self.u32()?).map_err(|_| BindingError::Limit("presentation index"))
    }
    fn string(&mut self, maximum: usize) -> Result<String, BindingError> {
        let length = self.count(maximum, 1)?;
        let value =
            core::str::from_utf8(self.take(length)?).map_err(|_| BindingError::InvalidUtf8)?;
        Ok(value.to_owned())
    }
    fn optional_id(&mut self) -> Result<Option<StableId>, BindingError> {
        if self.bool()? {
            Ok(Some(self.id()?))
        } else {
            Ok(None)
        }
    }
    fn owner(&mut self) -> Result<SceneOwner, BindingError> {
        let tag = self.u8()?;
        let id = self.id()?;
        match tag {
            0 => Ok(SceneOwner::Master(id)),
            1 => Ok(SceneOwner::Layout(id)),
            2 => Ok(SceneOwner::Slide(id)),
            _ => Err(BindingError::InvalidTag(tag)),
        }
    }
    fn fill(&mut self) -> Result<Fill, BindingError> {
        match self.u8()? {
            0 => Ok(Fill::None),
            1 => Ok(Fill::Solid(Color(self.u32()?))),
            tag => Err(BindingError::InvalidTag(tag)),
        }
    }
    fn line(&mut self) -> Result<LineStyle, BindingError> {
        let fill = self.fill()?;
        let width = Emu::new(self.i64()?).map_err(map_presentation_error)?;
        let dash = match self.u8()? {
            0 => LineDash::Solid,
            1 => LineDash::Dash,
            2 => LineDash::Dot,
            tag => return Err(BindingError::InvalidTag(tag)),
        };
        Ok(LineStyle { fill, width, dash })
    }
    fn rect(&mut self) -> Result<Rect, BindingError> {
        Rect::new(self.i64()?, self.i64()?, self.i64()?, self.i64()?)
            .map_err(map_presentation_error)
    }
    fn transform(&mut self) -> Result<Transform, BindingError> {
        let transform = Transform {
            rotation: self.i32()?,
            flip_horizontal: self.bool()?,
            flip_vertical: self.bool()?,
        };
        transform.validate().map_err(map_presentation_error)?;
        Ok(transform)
    }
    fn text_style(&mut self) -> Result<PresentationTextStyle, BindingError> {
        Ok(PresentationTextStyle {
            font_family: self.string(MAX_NAME_BYTES)?,
            font_size_centipoints: self.u32()?,
            color: Color(self.u32()?),
            bold: self.bool()?,
            italic: self.bool()?,
            underline: self.bool()?,
            language: if self.bool()? {
                Some(self.string(128)?)
            } else {
                None
            },
        })
    }
    fn rich_text(&mut self) -> Result<RichText, BindingError> {
        let vertical_alignment = match self.u8()? {
            0 => VerticalAlignment::Top,
            1 => VerticalAlignment::Middle,
            2 => VerticalAlignment::Bottom,
            tag => return Err(BindingError::InvalidTag(tag)),
        };
        let paragraph_count = self.count(MAX_TEXT_PARAGRAPHS, 5)?;
        let mut paragraphs = reserve(paragraph_count, "presentation text paragraphs")?;
        let mut total_runs = 0usize;
        let mut total_bytes = 0usize;
        for _ in 0..paragraph_count {
            let alignment = match self.u8()? {
                0 => HorizontalAlignment::Left,
                1 => HorizontalAlignment::Center,
                2 => HorizontalAlignment::Right,
                3 => HorizontalAlignment::Justify,
                tag => return Err(BindingError::InvalidTag(tag)),
            };
            let run_count = self.count(MAX_TEXT_RUNS, 21)?;
            total_runs = total_runs
                .checked_add(run_count)
                .ok_or(BindingError::Limit("presentation text runs"))?;
            if total_runs > MAX_TEXT_RUNS {
                return Err(BindingError::Limit("presentation text runs"));
            }
            let mut runs = reserve(run_count, "presentation text runs")?;
            for _ in 0..run_count {
                let text = self.string(MAX_TEXT_BYTES)?;
                total_bytes = total_bytes
                    .checked_add(text.len())
                    .ok_or(BindingError::Limit("presentation text bytes"))?;
                if total_bytes > MAX_TEXT_BYTES {
                    return Err(BindingError::Limit("presentation text bytes"));
                }
                runs.push(TextRun {
                    text,
                    style: self.text_style()?,
                });
            }
            paragraphs.push(TextParagraph { runs, alignment });
        }
        Ok(RichText {
            paragraphs,
            vertical_alignment,
        })
    }
    fn command(&mut self) -> Result<PresentationCommand, BindingError> {
        match self.u8()? {
            0 => Ok(PresentationCommand::CreateMaster {
                id: self.id()?,
                name: self.string(MAX_NAME_BYTES)?,
                background: self.fill()?,
            }),
            1 => Ok(PresentationCommand::CreateLayout {
                id: self.id()?,
                name: self.string(MAX_NAME_BYTES)?,
                master_id: self.optional_id()?,
                background: self.fill()?,
            }),
            2 => Ok(PresentationCommand::CreateSlide {
                id: self.id()?,
                index: self.index()?,
                title: self.string(MAX_NAME_BYTES)?,
                layout_id: self.optional_id()?,
                background: self.fill()?,
            }),
            3 => Ok(PresentationCommand::DeleteMaster { id: self.id()? }),
            4 => Ok(PresentationCommand::DeleteLayout { id: self.id()? }),
            5 => Ok(PresentationCommand::DeleteSlide { id: self.id()? }),
            6 => Ok(PresentationCommand::SetSlideTitle {
                id: self.id()?,
                title: self.string(MAX_NAME_BYTES)?,
            }),
            7 => Ok(PresentationCommand::SetSlideLayout {
                id: self.id()?,
                layout_id: self.optional_id()?,
            }),
            8 => Ok(PresentationCommand::SetSlideNotes {
                id: self.id()?,
                notes: self.rich_text()?,
            }),
            9 => Ok(PresentationCommand::InsertNode {
                owner: self.owner()?,
                parent: self.optional_id()?,
                index: self.index()?,
                node: self.new_node()?,
            }),
            10 => Ok(PresentationCommand::DeleteNode { id: self.id()? }),
            11 => Ok(PresentationCommand::MoveNode {
                id: self.id()?,
                new_parent: self.optional_id()?,
                index: self.index()?,
            }),
            12 => Ok(PresentationCommand::SetNodeBounds {
                id: self.id()?,
                bounds: self.rect()?,
            }),
            13 => Ok(PresentationCommand::SetNodeTransform {
                id: self.id()?,
                transform: self.transform()?,
            }),
            14 => Ok(PresentationCommand::SetNodeContent {
                id: self.id()?,
                kind: self.node_kind()?,
            }),
            15 => Ok(PresentationCommand::SetPresentationSize {
                size: SlideSize::new(self.i64()?, self.i64()?).map_err(map_presentation_error)?,
            }),
            tag => Err(BindingError::InvalidTag(tag)),
        }
    }
    fn new_node(&mut self) -> Result<NewSceneNode, BindingError> {
        Ok(NewSceneNode {
            id: self.id()?,
            name: self.string(MAX_NAME_BYTES)?,
            bounds: self.rect()?,
            transform: self.transform()?,
            kind: self.node_kind()?,
        })
    }
    fn node_kind(&mut self) -> Result<NodeKind, BindingError> {
        match self.u8()? {
            0 => {
                let geometry = match self.u8()? {
                    0 => ShapeGeometry::TextBox,
                    1 => ShapeGeometry::Rectangle,
                    2 => ShapeGeometry::RoundedRectangle,
                    3 => ShapeGeometry::Ellipse,
                    4 => ShapeGeometry::Triangle,
                    5 => ShapeGeometry::RightArrow,
                    6 => ShapeGeometry::Line,
                    tag => return Err(BindingError::InvalidTag(tag)),
                };
                let fill = self.fill()?;
                let line = self.line()?;
                let text = if self.bool()? {
                    Some(self.rich_text()?)
                } else {
                    None
                };
                let placeholder = if self.bool()? {
                    Some(Placeholder {
                        kind: self.string(MAX_NAME_BYTES)?,
                        index: if self.bool()? {
                            Some(self.u32()?)
                        } else {
                            None
                        },
                    })
                } else {
                    None
                };
                Ok(NodeKind::Shape(Shape {
                    geometry,
                    fill,
                    line,
                    text,
                    placeholder,
                }))
            }
            1 => {
                let child_offset_x = Emu::new(self.i64()?).map_err(map_presentation_error)?;
                let child_offset_y = Emu::new(self.i64()?).map_err(map_presentation_error)?;
                let child_extent_width = Emu::new(self.i64()?).map_err(map_presentation_error)?;
                let child_extent_height = Emu::new(self.i64()?).map_err(map_presentation_error)?;
                let count = self.count(MAX_GROUP_CHILDREN, 16)?;
                let mut children = reserve(count, "presentation group children")?;
                for _ in 0..count {
                    children.push(self.id()?);
                }
                Ok(NodeKind::Group(Group {
                    child_offset_x,
                    child_offset_y,
                    child_extent_width,
                    child_extent_height,
                    children,
                }))
            }
            2 => {
                let kind = match self.u8()? {
                    0 => ConnectorKind::Straight,
                    1 => ConnectorKind::Elbow,
                    2 => ConnectorKind::Curved,
                    tag => return Err(BindingError::InvalidTag(tag)),
                };
                Ok(NodeKind::Connector(Connector {
                    kind,
                    start: self.connector_endpoint()?,
                    end: self.connector_endpoint()?,
                    line: self.line()?,
                }))
            }
            3 => {
                let chart_type = match self.u8()? {
                    0 => ChartType::Bar,
                    1 => ChartType::Line,
                    2 => ChartType::Area,
                    3 => ChartType::Pie,
                    4 => ChartType::Doughnut,
                    5 => ChartType::Scatter,
                    6 => ChartType::Bubble,
                    7 => ChartType::Radar,
                    tag => return Err(BindingError::InvalidTag(tag)),
                };
                let title = self.rich_text()?;
                let count = self.count(MAX_CHART_SERIES, 21)?;
                let mut series = reserve(count, "presentation chart series")?;
                let mut points = 0usize;
                for _ in 0..count {
                    let item = ChartSeries {
                        name: self.string(MAX_NAME_BYTES)?,
                        categories: self.string_vec()?,
                        values: self.number_vec()?,
                        x_values: self.number_vec()?,
                        bubble_sizes: self.number_vec()?,
                    };
                    points = points
                        .checked_add(item.categories.len())
                        .and_then(|value| value.checked_add(item.values.len()))
                        .and_then(|value| value.checked_add(item.x_values.len()))
                        .and_then(|value| value.checked_add(item.bubble_sizes.len()))
                        .ok_or(BindingError::Limit("presentation chart points"))?;
                    if points > MAX_CHART_POINTS {
                        return Err(BindingError::Limit("presentation chart points"));
                    }
                    series.push(item);
                }
                Ok(NodeKind::Chart(Chart {
                    chart_type,
                    title,
                    series,
                    has_legend: self.bool()?,
                }))
            }
            4 => {
                let rows_count = self.count(MAX_TABLE_ROWS, 0)?;
                let columns_count = self.count(MAX_TABLE_COLUMNS, 0)?;
                let cells = rows_count
                    .checked_mul(columns_count)
                    .ok_or(BindingError::Limit("presentation table cells"))?;
                if rows_count == 0 || columns_count == 0 || cells > MAX_TABLE_CELLS {
                    return Err(BindingError::Limit("presentation table cells"));
                }
                if cells > self.remaining() {
                    return Err(BindingError::Truncated);
                }
                let mut rows = reserve(rows_count, "presentation table rows")?;
                for _ in 0..rows_count {
                    let mut row = reserve(columns_count, "presentation table columns")?;
                    for _ in 0..columns_count {
                        row.push(if self.bool()? {
                            Some(TableCell {
                                text: self.rich_text()?,
                                fill: self.fill()?,
                                row_span: self.u16()?,
                                column_span: self.u16()?,
                            })
                        } else {
                            None
                        });
                    }
                    rows.push(row);
                }
                let width_count = self.count(MAX_TABLE_COLUMNS, 8)?;
                let mut column_widths = reserve(width_count, "presentation table widths")?;
                for _ in 0..width_count {
                    column_widths.push(Emu::new(self.i64()?).map_err(map_presentation_error)?);
                }
                let height_count = self.count(MAX_TABLE_ROWS, 8)?;
                let mut row_heights = reserve(height_count, "presentation table heights")?;
                for _ in 0..height_count {
                    row_heights.push(Emu::new(self.i64()?).map_err(map_presentation_error)?);
                }
                Ok(NodeKind::Table(Table {
                    rows,
                    column_widths,
                    row_heights,
                    line: self.line()?,
                }))
            }
            5 => Ok(NodeKind::Media(MediaReference {
                digest: self
                    .take(32)?
                    .try_into()
                    .map_err(|_| BindingError::Truncated)?,
                content_type: self.string(MAX_MEDIA_TYPE_BYTES)?,
                alt_text: self.string(MAX_TEXT_BYTES)?,
                fit: match self.u8()? {
                    0 => MediaFit::Contain,
                    1 => MediaFit::Cover,
                    tag => return Err(BindingError::InvalidTag(tag)),
                },
                intrinsic_width: self.u32()?,
                intrinsic_height: self.u32()?,
            })),
            tag => Err(BindingError::InvalidTag(tag)),
        }
    }
    fn connector_endpoint(&mut self) -> Result<ConnectorEndpoint, BindingError> {
        Ok(ConnectorEndpoint {
            node_id: self.optional_id()?,
            x: Emu::new(self.i64()?).map_err(map_presentation_error)?,
            y: Emu::new(self.i64()?).map_err(map_presentation_error)?,
        })
    }
    fn string_vec(&mut self) -> Result<Vec<String>, BindingError> {
        let count = self.count(MAX_CHART_POINTS, 4)?;
        let mut values = reserve(count, "presentation chart categories")?;
        for _ in 0..count {
            values.push(self.string(MAX_NAME_BYTES)?);
        }
        Ok(values)
    }
    fn number_vec(&mut self) -> Result<Vec<Number>, BindingError> {
        let count = self.count(MAX_CHART_POINTS, 8)?;
        let mut values = reserve(count, "presentation chart values")?;
        for _ in 0..count {
            let bits = self.u64()?;
            let value = f64::from_bits(bits);
            if value == 0.0 && bits != 0 {
                return Err(BindingError::NonCanonical(
                    "negative zero presentation chart value",
                ));
            }
            values.push(
                Number::new(value)
                    .map_err(|_| BindingError::NonCanonical("non-finite chart value"))?,
            );
        }
        Ok(values)
    }
}

fn reserve<T>(count: usize, label: &'static str) -> Result<Vec<T>, BindingError> {
    let mut output = Vec::new();
    output
        .try_reserve_exact(count)
        .map_err(|_| BindingError::Limit(label))?;
    Ok(output)
}

#[derive(Clone, Copy, Debug)]
enum PresentationQuery {
    Viewport(PresentationViewportQuery),
    HitTest(PresentationHitTestQuery),
    ResolvedSlide(ResolvedSlideQuery),
    Metadata(PresentationMetadataQuery),
    SlideCatalog(PresentationSlideCatalogQuery),
    EditorSlide(PresentationEditorSlideQuery),
}

pub fn encode_presentation_viewport_query(
    query: PresentationViewportQuery,
) -> Result<Vec<u8>, BindingError> {
    validate_query_limits(query.max_nodes, query.max_bytes)?;
    validate_minimum_response_bytes(query.max_bytes, 17 + 32)?;
    let mut payload = WireEncoder::new(MAX_PRESENTATION_QUERY_BYTES);
    payload.owner(query.owner)?;
    payload.rect(query.viewport)?;
    encode_query_envelope(
        PresentationQueryKind::Viewport,
        query.max_nodes,
        query.max_bytes,
        &payload.finish(),
    )
}

pub fn encode_presentation_hit_test_query(
    query: PresentationHitTestQuery,
) -> Result<Vec<u8>, BindingError> {
    validate_query_limits(query.max_nodes, query.max_bytes)?;
    validate_minimum_response_bytes(query.max_bytes, 17 + 32)?;
    let mut payload = WireEncoder::new(MAX_PRESENTATION_QUERY_BYTES);
    payload.owner(query.owner)?;
    payload.i64(query.x.raw())?;
    payload.i64(query.y.raw())?;
    encode_query_envelope(
        PresentationQueryKind::HitTest,
        query.max_nodes,
        query.max_bytes,
        &payload.finish(),
    )
}

pub fn encode_resolved_slide_query(query: ResolvedSlideQuery) -> Result<Vec<u8>, BindingError> {
    validate_query_limits(query.max_nodes, query.max_bytes)?;
    validate_minimum_response_bytes(query.max_bytes, 16)?;
    encode_query_envelope(
        PresentationQueryKind::ResolvedSlide,
        query.max_nodes,
        query.max_bytes,
        &query.slide_id.to_le_bytes(),
    )
}

pub fn encode_presentation_metadata_query(
    query: PresentationMetadataQuery,
) -> Result<Vec<u8>, BindingError> {
    validate_response_bytes(query.max_bytes)?;
    validate_minimum_response_bytes(query.max_bytes, 16 + 16 + 12)?;
    encode_query_envelope(PresentationQueryKind::Metadata, 0, query.max_bytes, &[])
}

pub fn encode_presentation_slide_catalog_query(
    query: PresentationSlideCatalogQuery,
) -> Result<Vec<u8>, BindingError> {
    validate_catalog_query_limits(query.max_slides, query.max_text_bytes, query.max_bytes)?;
    validate_minimum_response_bytes(query.max_bytes, 13)?;
    let mut payload = WireEncoder::new(MAX_PRESENTATION_QUERY_BYTES);
    payload.u32(query.start_slide)?;
    payload.u32(query.max_text_bytes)?;
    encode_query_envelope(
        PresentationQueryKind::SlideCatalog,
        query.max_slides,
        query.max_bytes,
        &payload.finish(),
    )
}

pub fn encode_presentation_editor_slide_query(
    query: PresentationEditorSlideQuery,
) -> Result<Vec<u8>, BindingError> {
    validate_query_limits(query.max_nodes, query.max_bytes)?;
    validate_query_text_bytes(query.max_text_bytes)?;
    validate_minimum_response_bytes(query.max_bytes, 35)?;
    let mut payload = WireEncoder::new(MAX_PRESENTATION_QUERY_BYTES);
    payload.id(query.slide_id)?;
    payload.u32(query.max_text_bytes)?;
    encode_query_envelope(
        PresentationQueryKind::EditorSlide,
        query.max_nodes,
        query.max_bytes,
        &payload.finish(),
    )
}

fn encode_query_envelope(
    kind: PresentationQueryKind,
    max_items: u32,
    max_bytes: u32,
    payload: &[u8],
) -> Result<Vec<u8>, BindingError> {
    let mut output = Vec::with_capacity(QUERY_HEADER_BYTES + payload.len() + CHECKSUM_BYTES);
    output.extend_from_slice(&QUERY_MAGIC);
    output.extend_from_slice(&PRESENTATION_QUERY_VERSION.to_le_bytes());
    output.extend_from_slice(&0u16.to_le_bytes());
    output.push(kind as u8);
    output.extend_from_slice(&[0; 3]);
    output.extend_from_slice(&max_items.to_le_bytes());
    output.extend_from_slice(&max_bytes.to_le_bytes());
    output.extend_from_slice(
        &u32::try_from(payload.len())
            .map_err(|_| BindingError::Limit("presentation query"))?
            .to_le_bytes(),
    );
    output.extend_from_slice(payload);
    output.extend_from_slice(&checksum(&output).to_le_bytes());
    if output.len() > MAX_PRESENTATION_QUERY_BYTES {
        return Err(BindingError::Limit("presentation query"));
    }
    Ok(output)
}

fn decode_query_envelope(bytes: &[u8]) -> Result<PresentationQuery, BindingError> {
    if bytes.len() > MAX_PRESENTATION_QUERY_BYTES {
        return Err(BindingError::Limit("presentation query"));
    }
    if bytes.len() < QUERY_HEADER_BYTES + CHECKSUM_BYTES {
        return Err(BindingError::Truncated);
    }
    if bytes[..8] != QUERY_MAGIC {
        return Err(BindingError::BadMagic("presentation query"));
    }
    let version = read_u16(&bytes[8..10])?;
    if version != PRESENTATION_QUERY_VERSION {
        return Err(BindingError::UnsupportedVersion(version));
    }
    if read_u16(&bytes[10..12])? != 0 || bytes[13..16] != [0; 3] {
        return Err(BindingError::NonCanonical(
            "reserved presentation query bits",
        ));
    }
    let kind = match bytes[12] {
        0 => PresentationQueryKind::Viewport,
        1 => PresentationQueryKind::HitTest,
        2 => PresentationQueryKind::ResolvedSlide,
        3 => PresentationQueryKind::Metadata,
        4 => PresentationQueryKind::SlideCatalog,
        5 => PresentationQueryKind::EditorSlide,
        tag => return Err(BindingError::InvalidTag(tag)),
    };
    let max_items = read_u32(&bytes[16..20])?;
    let max_bytes = read_u32(&bytes[20..24])?;
    let payload_len = usize::try_from(read_u32(&bytes[24..28])?)
        .map_err(|_| BindingError::Limit("presentation query"))?;
    let payload_end = QUERY_HEADER_BYTES
        .checked_add(payload_len)
        .ok_or(BindingError::Limit("presentation query"))?;
    let expected = payload_end
        .checked_add(CHECKSUM_BYTES)
        .ok_or(BindingError::Limit("presentation query"))?;
    if bytes.len() != expected {
        return Err(if bytes.len() < expected {
            BindingError::Truncated
        } else {
            BindingError::TrailingBytes
        });
    }
    if checksum(&bytes[..payload_end]) != read_u64(&bytes[payload_end..])? {
        return Err(BindingError::ChecksumMismatch);
    }
    validate_response_bytes(max_bytes)?;
    let payload = &bytes[QUERY_HEADER_BYTES..payload_end];
    let mut decoder = WireDecoder::new(payload);
    let query = match kind {
        PresentationQueryKind::Viewport => {
            validate_query_limits(max_items, max_bytes)?;
            validate_minimum_response_bytes(max_bytes, 17 + 32)?;
            PresentationQuery::Viewport(PresentationViewportQuery {
                owner: decoder.owner()?,
                viewport: decoder.rect()?,
                max_nodes: max_items,
                max_bytes,
            })
        }
        PresentationQueryKind::HitTest => {
            validate_query_limits(max_items, max_bytes)?;
            validate_minimum_response_bytes(max_bytes, 17 + 32)?;
            PresentationQuery::HitTest(PresentationHitTestQuery {
                owner: decoder.owner()?,
                x: Emu::new(decoder.i64()?).map_err(map_presentation_error)?,
                y: Emu::new(decoder.i64()?).map_err(map_presentation_error)?,
                max_nodes: max_items,
                max_bytes,
            })
        }
        PresentationQueryKind::ResolvedSlide => {
            validate_query_limits(max_items, max_bytes)?;
            validate_minimum_response_bytes(max_bytes, 16)?;
            PresentationQuery::ResolvedSlide(ResolvedSlideQuery {
                slide_id: decoder.id()?,
                max_nodes: max_items,
                max_bytes,
            })
        }
        PresentationQueryKind::Metadata => {
            if max_items != 0 {
                return Err(BindingError::NonCanonical(
                    "metadata max items must be zero",
                ));
            }
            validate_minimum_response_bytes(max_bytes, 16 + 16 + 12)?;
            PresentationQuery::Metadata(PresentationMetadataQuery { max_bytes })
        }
        PresentationQueryKind::SlideCatalog => {
            let start_slide = decoder.u32()?;
            let max_text_bytes = decoder.u32()?;
            validate_catalog_query_limits(max_items, max_text_bytes, max_bytes)?;
            validate_minimum_response_bytes(max_bytes, 13)?;
            PresentationQuery::SlideCatalog(PresentationSlideCatalogQuery {
                start_slide,
                max_slides: max_items,
                max_text_bytes,
                max_bytes,
            })
        }
        PresentationQueryKind::EditorSlide => {
            validate_query_limits(max_items, max_bytes)?;
            validate_minimum_response_bytes(max_bytes, 35)?;
            let slide_id = decoder.id()?;
            let max_text_bytes = decoder.u32()?;
            validate_query_text_bytes(max_text_bytes)?;
            PresentationQuery::EditorSlide(PresentationEditorSlideQuery {
                slide_id,
                max_nodes: max_items,
                max_text_bytes,
                max_bytes,
            })
        }
    };
    if !decoder.is_empty() {
        return Err(BindingError::TrailingBytes);
    }
    Ok(query)
}

fn query_presentation(
    presentation: &Presentation,
    query_envelope: &[u8],
    maximum_response_bytes: usize,
) -> Result<Vec<u8>, BindingError> {
    let query = decode_query_envelope(query_envelope)?;
    let requested_bytes = match query {
        PresentationQuery::Viewport(query) => query.max_bytes,
        PresentationQuery::HitTest(query) => query.max_bytes,
        PresentationQuery::ResolvedSlide(query) => query.max_bytes,
        PresentationQuery::Metadata(query) => query.max_bytes,
        PresentationQuery::SlideCatalog(query) => query.max_bytes,
        PresentationQuery::EditorSlide(query) => query.max_bytes,
    };
    if usize::try_from(requested_bytes).map_or(true, |value| value > maximum_response_bytes) {
        return Err(BindingError::Limit("presentation response"));
    }
    match query {
        PresentationQuery::Viewport(query) => {
            let projection = presentation
                .viewport_projection(
                    query.owner,
                    query.viewport,
                    usize::try_from(query.max_nodes)
                        .map_err(|_| BindingError::Limit("presentation query nodes"))?,
                )
                .map_err(map_presentation_error)?;
            encode_projection_response(
                PresentationQueryKind::Viewport,
                &projection,
                query.max_bytes,
            )
        }
        PresentationQuery::HitTest(query) => {
            let projection = presentation
                .hit_test_projection(
                    query.owner,
                    query.x,
                    query.y,
                    usize::try_from(query.max_nodes)
                        .map_err(|_| BindingError::Limit("presentation query nodes"))?,
                )
                .map_err(map_presentation_error)?;
            encode_projection_response(PresentationQueryKind::HitTest, &projection, query.max_bytes)
        }
        PresentationQuery::ResolvedSlide(query) => {
            let resolved = presentation
                .resolved_slide_scene(query.slide_id)
                .map_err(map_presentation_error)?;
            let maximum = usize::try_from(query.max_nodes)
                .map_err(|_| BindingError::Limit("presentation query nodes"))?;
            let truncated = resolved.nodes.len() > maximum;
            encode_resolved_response(
                presentation.revision(),
                query.slide_id,
                &resolved.nodes[..resolved.nodes.len().min(maximum)],
                truncated,
                query.max_bytes,
            )
        }
        PresentationQuery::Metadata(query) => {
            let response = PresentationMetadataResponse {
                revision: presentation.revision(),
                presentation_id: presentation.id(),
                slide_size: presentation.slide_size(),
                masters: u32::try_from(presentation.masters().count())
                    .map_err(|_| BindingError::Limit("presentation masters"))?,
                layouts: u32::try_from(presentation.layouts().count())
                    .map_err(|_| BindingError::Limit("presentation layouts"))?,
                slides: u32::try_from(presentation.slides().count())
                    .map_err(|_| BindingError::Limit("presentation slides"))?,
            };
            encode_metadata_response(&response, query.max_bytes)
        }
        PresentationQuery::SlideCatalog(query) => {
            encode_slide_catalog_response(presentation, query)
        }
        PresentationQuery::EditorSlide(query) => encode_editor_slide_response(presentation, query),
    }
}

fn encode_projection_response(
    kind: PresentationQueryKind,
    projection: &ViewportProjection,
    max_bytes: u32,
) -> Result<Vec<u8>, BindingError> {
    let payload_budget = response_payload_budget(max_bytes)?;
    let mut payload = WireEncoder::new(payload_budget);
    payload.owner(projection.owner)?;
    payload.rect(projection.viewport)?;
    let mut item_count = 0usize;
    let mut truncated = projection.truncated;
    for node in &projection.nodes {
        let encoded_len = 16 + 17 + 1 + usize::from(node.parent.is_some()) * 16 + 1 + 32 + 4;
        if payload
            .len()
            .checked_add(encoded_len)
            .is_none_or(|next| next > payload_budget)
        {
            truncated = true;
            break;
        }
        encode_projected_node(&mut payload, node)?;
        item_count += 1;
    }
    encode_response_envelope(
        kind,
        projection.revision,
        item_count,
        truncated,
        &payload.finish(),
        max_bytes,
    )
}

fn encode_projected_node(
    payload: &mut WireEncoder,
    node: &ProjectedSceneNode,
) -> Result<(), BindingError> {
    payload.id(node.id)?;
    payload.owner(node.owner)?;
    payload.optional_id(node.parent)?;
    payload.u8(node_kind_tag(node.kind))?;
    payload.rect(node.bounds)?;
    payload.u32(node.paint_order)
}

fn encode_resolved_response(
    revision: u64,
    slide_id: StableId,
    nodes: &[ResolvedSceneNode],
    truncated: bool,
    max_bytes: u32,
) -> Result<Vec<u8>, BindingError> {
    let payload_budget = response_payload_budget(max_bytes)?;
    let mut payload = WireEncoder::new(payload_budget);
    payload.id(slide_id)?;
    let mut item_count = 0usize;
    let mut truncated = truncated;
    for node in nodes {
        if payload
            .len()
            .checked_add(16 + 17 + 1)
            .is_none_or(|next| next > payload_budget)
        {
            truncated = true;
            break;
        }
        payload.id(node.id)?;
        payload.owner(node.source)?;
        payload.bool(node.inherited)?;
        item_count += 1;
    }
    encode_response_envelope(
        PresentationQueryKind::ResolvedSlide,
        revision,
        item_count,
        truncated,
        &payload.finish(),
        max_bytes,
    )
}

fn response_payload_budget(max_bytes: u32) -> Result<usize, BindingError> {
    let maximum = usize::try_from(max_bytes)
        .map_err(|_| BindingError::Limit("presentation response"))?
        .min(MAX_PRESENTATION_RESPONSE_BYTES);
    maximum
        .checked_sub(RESPONSE_HEADER_BYTES + CHECKSUM_BYTES)
        .ok_or(BindingError::Limit("presentation response"))
}

fn encode_metadata_response(
    response: &PresentationMetadataResponse,
    max_bytes: u32,
) -> Result<Vec<u8>, BindingError> {
    let mut payload = WireEncoder::new(MAX_PRESENTATION_RESPONSE_BYTES);
    payload.id(response.presentation_id)?;
    payload.i64(response.slide_size.width.raw())?;
    payload.i64(response.slide_size.height.raw())?;
    payload.u32(response.masters)?;
    payload.u32(response.layouts)?;
    payload.u32(response.slides)?;
    encode_response_envelope(
        PresentationQueryKind::Metadata,
        response.revision,
        1,
        false,
        &payload.finish(),
        max_bytes,
    )
}

fn encode_slide_catalog_response(
    presentation: &Presentation,
    query: PresentationSlideCatalogQuery,
) -> Result<Vec<u8>, BindingError> {
    let payload_budget = response_payload_budget(query.max_bytes)?;
    const PREFIX_BYTES: usize = 4 + 1 + 4 + 4;
    let item_budget = payload_budget
        .checked_sub(PREFIX_BYTES)
        .ok_or(BindingError::Limit("presentation slide catalog response"))?;
    let start = usize::try_from(query.start_slide)
        .map_err(|_| BindingError::Limit("presentation slide catalog start"))?;
    let maximum = usize::try_from(query.max_slides)
        .map_err(|_| BindingError::Limit("presentation slide catalog count"))?;
    let total = presentation.slides().count();
    let mut encoded_items = WireEncoder::new(item_budget);
    let mut projected_text_bytes = 0usize;
    let mut item_count = 0usize;
    for (index, slide) in presentation.slides().enumerate().skip(start).take(maximum) {
        let item = slide_catalog_item(presentation, index, slide)?;
        let item_text = slide_catalog_item_text_bytes(&item)?;
        if projected_text_bytes
            .checked_add(item_text)
            .is_none_or(|value| value > query.max_text_bytes as usize)
        {
            break;
        }
        let remaining = item_budget.saturating_sub(encoded_items.len());
        let mut candidate = WireEncoder::new(remaining);
        match encode_slide_catalog_item(&mut candidate, &item) {
            Ok(()) => {}
            Err(BindingError::Limit(_)) => break,
            Err(error) => return Err(error),
        }
        encoded_items.append(&candidate.finish())?;
        projected_text_bytes += item_text;
        item_count += 1;
    }
    if start < total && item_count == 0 {
        return Err(BindingError::Limit("presentation slide catalog first item"));
    }
    let consumed = start.saturating_add(item_count).min(total);
    let next_slide = (consumed < total)
        .then(|| {
            u32::try_from(consumed).map_err(|_| BindingError::Limit("presentation slide cursor"))
        })
        .transpose()?;
    let truncated = next_slide.is_some();
    let mut payload = WireEncoder::new(payload_budget);
    payload.u32(query.start_slide)?;
    payload.bool(next_slide.is_some())?;
    if let Some(next) = next_slide {
        payload.u32(next)?;
    }
    payload.u32(
        u32::try_from(projected_text_bytes)
            .map_err(|_| BindingError::Limit("presentation projected text"))?,
    )?;
    payload.append(&encoded_items.finish())?;
    encode_response_envelope(
        PresentationQueryKind::SlideCatalog,
        presentation.revision(),
        item_count,
        truncated,
        &payload.finish(),
        query.max_bytes,
    )
}

fn encode_editor_slide_response(
    presentation: &Presentation,
    query: PresentationEditorSlideQuery,
) -> Result<Vec<u8>, BindingError> {
    let slide = presentation
        .slide(query.slide_id)
        .ok_or_else(|| map_presentation_error(PresentationError::UnknownSlide(query.slide_id)))?;
    let index = presentation
        .slides()
        .position(|candidate| candidate.id == query.slide_id)
        .ok_or(BindingError::NonCanonical("presentation slide order"))?;
    let slide_item = slide_catalog_item(presentation, index, slide)?;
    let payload_budget = response_payload_budget(query.max_bytes)?;
    let mut prefix = WireEncoder::new(
        payload_budget
            .checked_sub(4)
            .ok_or(BindingError::Limit("presentation editor response"))?,
    );
    encode_slide_catalog_item(&mut prefix, &slide_item)?;
    let mut projected_text_bytes = slide_catalog_item_text_bytes(&slide_item)?;
    if projected_text_bytes > query.max_text_bytes as usize {
        return Err(BindingError::Limit("presentation editor slide text"));
    }
    let notes_text = rich_text_projection_bytes(&slide.notes)?;
    let notes_budget = prefix.maximum.saturating_sub(prefix.len() + 1);
    let mut notes = WireEncoder::new(notes_budget);
    let notes_encoded = match notes.rich_text(&slide.notes) {
        Ok(()) => true,
        Err(BindingError::Limit(_)) => false,
        Err(error) => return Err(error),
    };
    let include_notes = projected_text_bytes
        .checked_add(notes_text)
        .is_some_and(|value| value <= query.max_text_bytes as usize)
        && notes_encoded;
    prefix.bool(include_notes)?;
    let mut truncated = !include_notes;
    if include_notes {
        prefix.append(&notes.finish())?;
        projected_text_bytes += notes_text;
    }

    let resolved = presentation
        .resolved_slide_scene(query.slide_id)
        .map_err(map_presentation_error)?;
    let maximum_nodes = usize::try_from(query.max_nodes)
        .map_err(|_| BindingError::Limit("presentation editor nodes"))?;
    let node_budget = payload_budget.saturating_sub(prefix.len() + 4);
    let mut encoded_nodes = WireEncoder::new(node_budget);
    let mut item_count = 0usize;
    for resolved_node in resolved.nodes.iter().take(maximum_nodes) {
        let source = presentation.node(resolved_node.id).ok_or_else(|| {
            map_presentation_error(PresentationError::UnknownNode(resolved_node.id))
        })?;
        if source.owner != resolved_node.source {
            return Err(BindingError::NonCanonical(
                "resolved presentation node source",
            ));
        }
        let node = PresentationEditorSceneNode {
            id: source.id,
            source: resolved_node.source,
            inherited: resolved_node.inherited,
            parent: source.parent,
            order: u32::try_from(
                presentation
                    .node_sibling_order(source.id)
                    .map_err(map_presentation_error)?,
            )
            .map_err(|_| BindingError::Limit("presentation node order"))?,
            name: source.name.clone(),
            bounds: source.bounds,
            transform: source.transform,
            kind: source.kind.clone(),
        };
        let node_text = editor_scene_node_text_bytes(&node)?;
        if projected_text_bytes
            .checked_add(node_text)
            .is_none_or(|value| value > query.max_text_bytes as usize)
        {
            truncated = true;
            break;
        }
        let remaining = node_budget.saturating_sub(encoded_nodes.len());
        let mut candidate = WireEncoder::new(remaining);
        match encode_editor_scene_node(&mut candidate, &node) {
            Ok(()) => {}
            Err(BindingError::Limit(_)) => {
                truncated = true;
                break;
            }
            Err(error) => return Err(error),
        }
        encoded_nodes.append(&candidate.finish())?;
        projected_text_bytes += node_text;
        item_count += 1;
    }
    if item_count < resolved.nodes.len() {
        truncated = true;
    }
    let mut payload = WireEncoder::new(payload_budget);
    payload.append(&prefix.finish())?;
    payload.u32(
        u32::try_from(projected_text_bytes)
            .map_err(|_| BindingError::Limit("presentation projected text"))?,
    )?;
    payload.append(&encoded_nodes.finish())?;
    encode_response_envelope(
        PresentationQueryKind::EditorSlide,
        presentation.revision(),
        item_count,
        truncated,
        &payload.finish(),
        query.max_bytes,
    )
}

fn slide_catalog_item(
    presentation: &Presentation,
    index: usize,
    slide: &Slide,
) -> Result<PresentationSlideCatalogItem, BindingError> {
    let layout = slide
        .layout_id
        .map(|id| {
            let layout = presentation
                .layout(id)
                .ok_or_else(|| map_presentation_error(PresentationError::UnknownLayout(id)))?;
            Ok(PresentationSlideLayoutFacts {
                id: layout.id,
                name: layout.name.clone(),
                master_id: layout.master_id,
                background: layout.background,
            })
        })
        .transpose()?;
    Ok(PresentationSlideCatalogItem {
        index: u32::try_from(index).map_err(|_| BindingError::Limit("presentation slide index"))?,
        id: slide.id,
        title: slide.title.clone(),
        background: slide.background,
        layout,
    })
}

fn encode_slide_catalog_item(
    payload: &mut WireEncoder,
    item: &PresentationSlideCatalogItem,
) -> Result<(), BindingError> {
    payload.u32(item.index)?;
    payload.id(item.id)?;
    payload.string(&item.title, MAX_NAME_BYTES)?;
    payload.fill(item.background)?;
    payload.bool(item.layout.is_some())?;
    if let Some(layout) = &item.layout {
        payload.id(layout.id)?;
        payload.string(&layout.name, MAX_NAME_BYTES)?;
        payload.optional_id(layout.master_id)?;
        payload.fill(layout.background)?;
    }
    Ok(())
}

fn encode_editor_scene_node(
    payload: &mut WireEncoder,
    node: &PresentationEditorSceneNode,
) -> Result<(), BindingError> {
    payload.id(node.id)?;
    payload.owner(node.source)?;
    payload.bool(node.inherited)?;
    payload.optional_id(node.parent)?;
    payload.u32(node.order)?;
    payload.string(&node.name, MAX_NAME_BYTES)?;
    payload.rect(node.bounds)?;
    payload.transform(node.transform)?;
    payload.node_kind(&node.kind)
}

fn decode_slide_catalog_item(
    decoder: &mut WireDecoder<'_>,
) -> Result<PresentationSlideCatalogItem, BindingError> {
    let index = decoder.u32()?;
    let id = decoder.id()?;
    let title = decoder.string(MAX_NAME_BYTES)?;
    let background = decoder.fill()?;
    let layout = if decoder.bool()? {
        Some(PresentationSlideLayoutFacts {
            id: decoder.id()?,
            name: decoder.string(MAX_NAME_BYTES)?,
            master_id: decoder.optional_id()?,
            background: decoder.fill()?,
        })
    } else {
        None
    };
    if !valid_presentation_id(id)
        || layout.as_ref().is_some_and(|layout| {
            !valid_presentation_id(layout.id)
                || layout
                    .master_id
                    .is_some_and(|id| !valid_presentation_id(id))
        })
    {
        return Err(BindingError::NonCanonical(
            "invalid presentation slide catalog item",
        ));
    }
    Ok(PresentationSlideCatalogItem {
        index,
        id,
        title,
        background,
        layout,
    })
}

fn decode_editor_scene_node(
    decoder: &mut WireDecoder<'_>,
) -> Result<PresentationEditorSceneNode, BindingError> {
    Ok(PresentationEditorSceneNode {
        id: decoder.id()?,
        source: decoder.owner()?,
        inherited: decoder.bool()?,
        parent: decoder.optional_id()?,
        order: decoder.u32()?,
        name: decoder.string(MAX_NAME_BYTES)?,
        bounds: decoder.rect()?,
        transform: decoder.transform()?,
        kind: decoder.node_kind()?,
    })
}

fn validate_editor_node_references(node: &PresentationEditorSceneNode) -> Result<(), BindingError> {
    match &node.kind {
        NodeKind::Group(group) => {
            let mut ids = BTreeSet::new();
            if group
                .children
                .iter()
                .any(|id| !valid_presentation_id(*id) || *id == node.id || !ids.insert(*id))
            {
                return Err(BindingError::NonCanonical(
                    "invalid presentation editor group children",
                ));
            }
        }
        NodeKind::Connector(connector) => {
            for endpoint in [connector.start, connector.end] {
                if endpoint
                    .node_id
                    .is_some_and(|id| !valid_presentation_id(id) || id == node.id)
                {
                    return Err(BindingError::NonCanonical(
                        "invalid presentation editor connector endpoint",
                    ));
                }
            }
        }
        NodeKind::Shape(_) | NodeKind::Chart(_) | NodeKind::Table(_) | NodeKind::Media(_) => {}
    }
    Ok(())
}

fn slide_catalog_item_text_bytes(
    item: &PresentationSlideCatalogItem,
) -> Result<usize, BindingError> {
    let mut total = item.title.len();
    if let Some(layout) = &item.layout {
        total = checked_text_add(total, layout.name.len())?;
    }
    Ok(total)
}

fn editor_scene_node_text_bytes(node: &PresentationEditorSceneNode) -> Result<usize, BindingError> {
    checked_text_add(node.name.len(), node_kind_projection_bytes(&node.kind)?)
}

fn node_kind_projection_bytes(kind: &NodeKind) -> Result<usize, BindingError> {
    match kind {
        NodeKind::Shape(shape) => {
            let mut total = 0usize;
            if let Some(text) = &shape.text {
                total = rich_text_projection_bytes(text)?;
            }
            if let Some(placeholder) = &shape.placeholder {
                total = checked_text_add(total, placeholder.kind.len())?;
            }
            Ok(total)
        }
        NodeKind::Group(_) | NodeKind::Connector(_) => Ok(0),
        NodeKind::Chart(chart) => {
            let mut total = rich_text_projection_bytes(&chart.title)?;
            for series in &chart.series {
                total = checked_text_add(total, series.name.len())?;
                for category in &series.categories {
                    total = checked_text_add(total, category.len())?;
                }
            }
            Ok(total)
        }
        NodeKind::Table(table) => {
            let mut total = 0usize;
            for cell in table.rows.iter().flatten().flatten() {
                total = checked_text_add(total, rich_text_projection_bytes(&cell.text)?)?;
            }
            Ok(total)
        }
        NodeKind::Media(media) => checked_text_add(media.content_type.len(), media.alt_text.len()),
    }
}

fn rich_text_projection_bytes(text: &RichText) -> Result<usize, BindingError> {
    let mut total = 0usize;
    for run in text.paragraphs.iter().flat_map(|paragraph| &paragraph.runs) {
        total = checked_text_add(total, run.text.len())?;
        total = checked_text_add(total, run.style.font_family.len())?;
        if let Some(language) = &run.style.language {
            total = checked_text_add(total, language.len())?;
        }
    }
    Ok(total)
}

fn checked_text_add(left: usize, right: usize) -> Result<usize, BindingError> {
    left.checked_add(right)
        .ok_or(BindingError::Limit("presentation projected text"))
}

fn encode_response_envelope(
    kind: PresentationQueryKind,
    revision: u64,
    item_count: usize,
    truncated: bool,
    payload: &[u8],
    max_bytes: u32,
) -> Result<Vec<u8>, BindingError> {
    let maximum = usize::try_from(max_bytes)
        .map_err(|_| BindingError::Limit("presentation response"))?
        .min(MAX_PRESENTATION_RESPONSE_BYTES);
    let mut output = Vec::with_capacity(RESPONSE_HEADER_BYTES + payload.len() + CHECKSUM_BYTES);
    output.extend_from_slice(&RESPONSE_MAGIC);
    output.extend_from_slice(&PRESENTATION_RESPONSE_VERSION.to_le_bytes());
    output.extend_from_slice(
        &(if truncated {
            RESPONSE_FLAG_TRUNCATED
        } else {
            0
        })
        .to_le_bytes(),
    );
    output.push(kind as u8);
    output.extend_from_slice(&[0; 3]);
    output.extend_from_slice(&revision.to_le_bytes());
    output.extend_from_slice(
        &u32::try_from(item_count)
            .map_err(|_| BindingError::Limit("presentation response items"))?
            .to_le_bytes(),
    );
    output.extend_from_slice(
        &u32::try_from(payload.len())
            .map_err(|_| BindingError::Limit("presentation response"))?
            .to_le_bytes(),
    );
    output.extend_from_slice(payload);
    output.extend_from_slice(&checksum(&output).to_le_bytes());
    if output.len() > maximum {
        return Err(BindingError::Limit("presentation response"));
    }
    Ok(output)
}

pub fn decode_presentation_query_response(
    bytes: &[u8],
) -> Result<PresentationQueryResponse, BindingError> {
    if bytes.len() > MAX_PRESENTATION_RESPONSE_BYTES {
        return Err(BindingError::Limit("presentation response"));
    }
    if bytes.len() < RESPONSE_HEADER_BYTES + CHECKSUM_BYTES {
        return Err(BindingError::Truncated);
    }
    if bytes[..8] != RESPONSE_MAGIC {
        return Err(BindingError::BadMagic("presentation response"));
    }
    let version = read_u16(&bytes[8..10])?;
    if version != PRESENTATION_RESPONSE_VERSION {
        return Err(BindingError::UnsupportedVersion(version));
    }
    let flags = read_u16(&bytes[10..12])?;
    if flags & !RESPONSE_FLAG_TRUNCATED != 0 || bytes[13..16] != [0; 3] {
        return Err(BindingError::NonCanonical(
            "reserved presentation response bits",
        ));
    }
    let kind = match bytes[12] {
        0 => PresentationQueryKind::Viewport,
        1 => PresentationQueryKind::HitTest,
        2 => PresentationQueryKind::ResolvedSlide,
        3 => PresentationQueryKind::Metadata,
        4 => PresentationQueryKind::SlideCatalog,
        5 => PresentationQueryKind::EditorSlide,
        tag => return Err(BindingError::InvalidTag(tag)),
    };
    let revision = read_u64(&bytes[16..24])?;
    let item_count = usize::try_from(read_u32(&bytes[24..28])?)
        .map_err(|_| BindingError::Limit("presentation response items"))?;
    let payload_len = usize::try_from(read_u32(&bytes[28..32])?)
        .map_err(|_| BindingError::Limit("presentation response"))?;
    let payload_end = RESPONSE_HEADER_BYTES
        .checked_add(payload_len)
        .ok_or(BindingError::Limit("presentation response"))?;
    let expected = payload_end
        .checked_add(CHECKSUM_BYTES)
        .ok_or(BindingError::Limit("presentation response"))?;
    if bytes.len() != expected {
        return Err(if bytes.len() < expected {
            BindingError::Truncated
        } else {
            BindingError::TrailingBytes
        });
    }
    if checksum(&bytes[..payload_end]) != read_u64(&bytes[payload_end..])? {
        return Err(BindingError::ChecksumMismatch);
    }
    let mut decoder = WireDecoder::new(&bytes[RESPONSE_HEADER_BYTES..payload_end]);
    let truncated = flags & RESPONSE_FLAG_TRUNCATED != 0;
    let response = match kind {
        PresentationQueryKind::Viewport | PresentationQueryKind::HitTest => {
            if item_count > MAX_VIEWPORT_RESULTS {
                return Err(BindingError::Limit("presentation response items"));
            }
            let owner = decoder.owner()?;
            validate_response_owner(owner)?;
            let viewport = decoder.rect()?;
            let mut nodes = reserve(item_count, "presentation response nodes")?;
            let mut ids = BTreeSet::new();
            let mut previous_paint_order = None;
            for _ in 0..item_count {
                let node = ProjectedSceneNode {
                    id: decoder.id()?,
                    owner: decoder.owner()?,
                    parent: decoder.optional_id()?,
                    kind: decode_node_kind_tag(decoder.u8()?)?,
                    bounds: decoder.rect()?,
                    paint_order: decoder.u32()?,
                };
                if !valid_presentation_id(node.id)
                    || node.owner != owner
                    || node
                        .parent
                        .is_some_and(|parent| !valid_presentation_id(parent) || parent == node.id)
                    || !ids.insert(node.id)
                {
                    return Err(BindingError::NonCanonical(
                        "invalid presentation projection node",
                    ));
                }
                if previous_paint_order.is_some_and(|previous| match kind {
                    PresentationQueryKind::Viewport => node.paint_order <= previous,
                    PresentationQueryKind::HitTest => node.paint_order >= previous,
                    _ => false,
                }) {
                    return Err(BindingError::NonCanonical(
                        "presentation projection is not in paint order",
                    ));
                }
                previous_paint_order = Some(node.paint_order);
                nodes.push(node);
            }
            let projection = ViewportProjection {
                owner,
                revision,
                viewport,
                nodes,
                truncated,
            };
            if kind == PresentationQueryKind::Viewport {
                PresentationQueryResponse::Viewport(projection)
            } else {
                PresentationQueryResponse::HitTest(projection)
            }
        }
        PresentationQueryKind::ResolvedSlide => {
            if item_count > MAX_VIEWPORT_RESULTS {
                return Err(BindingError::Limit("presentation response items"));
            }
            let slide_id = decoder.id()?;
            if !valid_presentation_id(slide_id) {
                return Err(BindingError::NonCanonical(
                    "invalid resolved presentation slide",
                ));
            }
            let mut nodes = reserve(item_count, "presentation response nodes")?;
            let mut ids = BTreeSet::new();
            for _ in 0..item_count {
                let node = ResolvedSceneNode {
                    id: decoder.id()?,
                    source: decoder.owner()?,
                    inherited: decoder.bool()?,
                };
                let expected_inherited = node.source != SceneOwner::Slide(slide_id);
                if !valid_presentation_id(node.id)
                    || !ids.insert(node.id)
                    || validate_response_owner(node.source).is_err()
                    || matches!(node.source, SceneOwner::Slide(source) if source != slide_id)
                    || node.inherited != expected_inherited
                {
                    return Err(BindingError::NonCanonical(
                        "invalid resolved presentation node",
                    ));
                }
                nodes.push(node);
            }
            PresentationQueryResponse::ResolvedSlide(ResolvedSlideResponse {
                revision,
                slide_id,
                nodes,
                truncated,
            })
        }
        PresentationQueryKind::Metadata => {
            if item_count != 1 || truncated {
                return Err(BindingError::NonCanonical(
                    "invalid presentation metadata response",
                ));
            }
            let presentation_id = decoder.id()?;
            if !valid_presentation_id(presentation_id) {
                return Err(BindingError::NonCanonical(
                    "invalid presentation metadata id",
                ));
            }
            PresentationQueryResponse::Metadata(PresentationMetadataResponse {
                revision,
                presentation_id,
                slide_size: SlideSize::new(decoder.i64()?, decoder.i64()?)
                    .map_err(map_presentation_error)?,
                masters: decoder.u32()?,
                layouts: decoder.u32()?,
                slides: decoder.u32()?,
            })
        }
        PresentationQueryKind::SlideCatalog => {
            if item_count > MAX_PRESENTATION_SLIDES {
                return Err(BindingError::Limit("presentation slide catalog items"));
            }
            let start_slide = decoder.u32()?;
            let next_slide = if decoder.bool()? {
                Some(decoder.u32()?)
            } else {
                None
            };
            let projected_text_bytes = decoder.u32()?;
            validate_projected_text_bytes(projected_text_bytes)?;
            let mut slides = reserve(item_count, "presentation slide catalog items")?;
            let mut ids = BTreeSet::new();
            let mut measured_text = 0usize;
            for offset in 0..item_count {
                let item = decode_slide_catalog_item(&mut decoder)?;
                let expected_index = usize::try_from(start_slide)
                    .ok()
                    .and_then(|start| start.checked_add(offset))
                    .and_then(|value| u32::try_from(value).ok());
                if Some(item.index) != expected_index || !ids.insert(item.id) {
                    return Err(BindingError::NonCanonical(
                        "invalid presentation slide catalog order",
                    ));
                }
                measured_text =
                    checked_text_add(measured_text, slide_catalog_item_text_bytes(&item)?)?;
                slides.push(item);
            }
            let expected_next = start_slide
                .checked_add(
                    u32::try_from(item_count)
                        .map_err(|_| BindingError::Limit("presentation slide catalog items"))?,
                )
                .ok_or(BindingError::NonCanonical(
                    "presentation slide catalog cursor overflow",
                ))?;
            if truncated != next_slide.is_some()
                || next_slide.is_some_and(|next| next != expected_next)
                || (next_slide.is_some() && item_count == 0)
                || measured_text != projected_text_bytes as usize
            {
                return Err(BindingError::NonCanonical(
                    "invalid presentation slide catalog boundary",
                ));
            }
            PresentationQueryResponse::SlideCatalog(PresentationSlideCatalogResponse {
                revision,
                start_slide,
                next_slide,
                projected_text_bytes,
                slides,
                truncated,
            })
        }
        PresentationQueryKind::EditorSlide => {
            if item_count > MAX_VIEWPORT_RESULTS {
                return Err(BindingError::Limit("presentation editor scene nodes"));
            }
            let slide = decode_slide_catalog_item(&mut decoder)?;
            let notes = if decoder.bool()? {
                Some(decoder.rich_text()?)
            } else {
                None
            };
            if notes.is_none() && !truncated {
                return Err(BindingError::NonCanonical(
                    "omitted presentation notes require truncation",
                ));
            }
            let projected_text_bytes = decoder.u32()?;
            validate_projected_text_bytes(projected_text_bytes)?;
            let mut measured_text = slide_catalog_item_text_bytes(&slide)?;
            if let Some(notes) = &notes {
                measured_text =
                    checked_text_add(measured_text, rich_text_projection_bytes(notes)?)?;
            }
            let mut nodes = reserve(item_count, "presentation editor scene nodes")?;
            let mut ids = BTreeSet::new();
            let mut sources = std::collections::BTreeMap::new();
            let mut positions = BTreeSet::new();
            for _ in 0..item_count {
                let node = decode_editor_scene_node(&mut decoder)?;
                let expected_inherited = node.source != SceneOwner::Slide(slide.id);
                if !valid_presentation_id(node.id)
                    || !ids.insert(node.id)
                    || validate_response_owner(node.source).is_err()
                    || matches!(node.source, SceneOwner::Slide(source) if source != slide.id)
                    || node.inherited != expected_inherited
                    || node.parent.is_some_and(|parent| {
                        !valid_presentation_id(parent)
                            || parent == node.id
                            || sources.get(&parent).copied() != Some(node.source)
                    })
                    || !positions.insert((node.source, node.parent, node.order))
                    || validate_editor_node_references(&node).is_err()
                {
                    return Err(BindingError::NonCanonical(
                        "invalid presentation editor scene node",
                    ));
                }
                measured_text =
                    checked_text_add(measured_text, editor_scene_node_text_bytes(&node)?)?;
                sources.insert(node.id, node.source);
                nodes.push(node);
            }
            if measured_text != projected_text_bytes as usize {
                return Err(BindingError::NonCanonical(
                    "presentation editor projected text mismatch",
                ));
            }
            PresentationQueryResponse::EditorSlide(PresentationEditorSlideResponse {
                revision,
                slide,
                notes,
                projected_text_bytes,
                nodes,
                truncated,
            })
        }
    };
    if !decoder.is_empty() {
        return Err(BindingError::TrailingBytes);
    }
    Ok(response)
}

fn valid_presentation_id(id: StableId) -> bool {
    id.namespace() != 0 && id.counter() != 0
}

fn validate_response_owner(owner: SceneOwner) -> Result<(), BindingError> {
    if valid_presentation_id(owner.id()) {
        Ok(())
    } else {
        Err(BindingError::NonCanonical(
            "invalid presentation scene owner",
        ))
    }
}

fn validate_query_limits(max_nodes: u32, max_bytes: u32) -> Result<(), BindingError> {
    if max_nodes == 0
        || usize::try_from(max_nodes).map_or(true, |value| value > MAX_VIEWPORT_RESULTS)
    {
        return Err(BindingError::Limit("presentation query nodes"));
    }
    validate_response_bytes(max_bytes)
}

fn validate_catalog_query_limits(
    max_slides: u32,
    max_text_bytes: u32,
    max_bytes: u32,
) -> Result<(), BindingError> {
    if max_slides == 0
        || usize::try_from(max_slides).map_or(true, |value| value > MAX_PRESENTATION_SLIDES)
    {
        return Err(BindingError::Limit("presentation slide catalog count"));
    }
    validate_query_text_bytes(max_text_bytes)?;
    validate_response_bytes(max_bytes)
}

fn validate_query_text_bytes(max_text_bytes: u32) -> Result<(), BindingError> {
    if max_text_bytes == 0
        || usize::try_from(max_text_bytes)
            .map_or(true, |value| value > MAX_PRESENTATION_QUERY_TEXT_BYTES)
    {
        return Err(BindingError::Limit("presentation query text"));
    }
    Ok(())
}

fn validate_projected_text_bytes(projected_text_bytes: u32) -> Result<(), BindingError> {
    if usize::try_from(projected_text_bytes)
        .map_or(true, |value| value > MAX_PRESENTATION_QUERY_TEXT_BYTES)
    {
        return Err(BindingError::Limit("presentation projected text"));
    }
    Ok(())
}

fn validate_response_bytes(max_bytes: u32) -> Result<(), BindingError> {
    let maximum =
        usize::try_from(max_bytes).map_err(|_| BindingError::Limit("presentation response"))?;
    if !(RESPONSE_HEADER_BYTES + CHECKSUM_BYTES..=MAX_PRESENTATION_RESPONSE_BYTES)
        .contains(&maximum)
    {
        return Err(BindingError::Limit("presentation response"));
    }
    Ok(())
}

fn validate_minimum_response_bytes(
    max_bytes: u32,
    mandatory_payload_bytes: usize,
) -> Result<(), BindingError> {
    let maximum =
        usize::try_from(max_bytes).map_err(|_| BindingError::Limit("presentation response"))?;
    let minimum = RESPONSE_HEADER_BYTES
        .checked_add(CHECKSUM_BYTES)
        .and_then(|value| value.checked_add(mandatory_payload_bytes))
        .ok_or(BindingError::Limit("presentation response"))?;
    if maximum < minimum {
        return Err(BindingError::Limit("presentation response"));
    }
    Ok(())
}

fn node_kind_tag(kind: NodeKindTag) -> u8 {
    match kind {
        NodeKindTag::Shape => 0,
        NodeKindTag::Group => 1,
        NodeKindTag::Connector => 2,
        NodeKindTag::Chart => 3,
        NodeKindTag::Table => 4,
        NodeKindTag::Media => 5,
    }
}

fn decode_node_kind_tag(tag: u8) -> Result<NodeKindTag, BindingError> {
    match tag {
        0 => Ok(NodeKindTag::Shape),
        1 => Ok(NodeKindTag::Group),
        2 => Ok(NodeKindTag::Connector),
        3 => Ok(NodeKindTag::Chart),
        4 => Ok(NodeKindTag::Table),
        5 => Ok(NodeKindTag::Media),
        _ => Err(BindingError::InvalidTag(tag)),
    }
}

fn encode_presentation_receipt(revision: u64, command_count: usize) -> Vec<u8> {
    let mut output = Vec::with_capacity(32);
    output.extend_from_slice(&RECEIPT_MAGIC);
    output.extend_from_slice(&PRESENTATION_COMMAND_VERSION.to_le_bytes());
    output.extend_from_slice(&0u16.to_le_bytes());
    output.extend_from_slice(&revision.to_le_bytes());
    output.extend_from_slice(&(command_count as u32).to_le_bytes());
    output.extend_from_slice(&checksum(&output).to_le_bytes());
    output
}

pub fn decode_presentation_receipt(bytes: &[u8]) -> Result<(u64, u32), BindingError> {
    if bytes.len() != 32 {
        return Err(if bytes.len() < 32 {
            BindingError::Truncated
        } else {
            BindingError::TrailingBytes
        });
    }
    if bytes[..8] != RECEIPT_MAGIC {
        return Err(BindingError::BadMagic("presentation receipt"));
    }
    let version = read_u16(&bytes[8..10])?;
    if version != PRESENTATION_COMMAND_VERSION {
        return Err(BindingError::UnsupportedVersion(version));
    }
    if read_u16(&bytes[10..12])? != 0 {
        return Err(BindingError::NonCanonical(
            "reserved presentation receipt bits",
        ));
    }
    if checksum(&bytes[..24]) != read_u64(&bytes[24..32])? {
        return Err(BindingError::ChecksumMismatch);
    }
    Ok((read_u64(&bytes[12..20])?, read_u32(&bytes[20..24])?))
}

fn map_presentation_error(error: PresentationError) -> BindingError {
    BindingError::Presentation(error)
}

fn map_presentation_batch_error(error: PresentationBatchError) -> BindingError {
    BindingError::PresentationBatch(error)
}

fn format_hash(hash: [u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(71);
    output.push_str("sha256:");
    for byte in hash {
        output.push(char::from(HEX[(byte >> 4) as usize]));
        output.push(char::from(HEX[(byte & 0x0f) as usize]));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{encode_namespace, MAX_CELLS_PER_BATCH, MAX_COMMAND_ENVELOPE_BYTES};
    use opengeni_artifact_kernel::presentation::{
        Color, Fill, LineStyle, PresentationTextStyle, TextParagraph, TextRun, EMU_PER_CSS_PIXEL,
    };

    const NAMESPACE: u64 = 77;

    fn id(counter: u64) -> StableId {
        StableId::from_parts(NAMESPACE, counter)
    }

    fn rect(x: i64, y: i64, width: i64, height: i64) -> Rect {
        Rect::new(
            x * EMU_PER_CSS_PIXEL,
            y * EMU_PER_CSS_PIXEL,
            width * EMU_PER_CSS_PIXEL,
            height * EMU_PER_CSS_PIXEL,
        )
        .expect("rect")
    }

    fn shape(node_id: StableId, text: &str) -> NewSceneNode {
        NewSceneNode {
            id: node_id,
            name: format!("Shape {}", node_id.counter()),
            bounds: rect(10, 10, 100, 40),
            transform: Transform::default(),
            kind: NodeKind::Shape(Shape {
                geometry: ShapeGeometry::TextBox,
                fill: Fill::None,
                line: LineStyle::default(),
                text: Some(RichText::plain(text)),
                placeholder: None,
            }),
        }
    }

    fn initial_batch() -> PresentationBatch {
        PresentationBatch::from_commands(vec![
            PresentationCommand::CreateMaster {
                id: id(2),
                name: "Master".to_owned(),
                background: Fill::Solid(Color::WHITE),
            },
            PresentationCommand::CreateLayout {
                id: id(3),
                name: "Layout".to_owned(),
                master_id: Some(id(2)),
                background: Fill::Solid(Color::WHITE),
            },
            PresentationCommand::CreateSlide {
                id: id(4),
                index: 0,
                title: "Slide".to_owned(),
                layout_id: Some(id(3)),
                background: Fill::Solid(Color::WHITE),
            },
            PresentationCommand::InsertNode {
                owner: SceneOwner::Slide(id(4)),
                parent: None,
                index: 0,
                node: shape(id(5), "Hello"),
            },
            PresentationCommand::SetSlideNotes {
                id: id(4),
                notes: RichText {
                    paragraphs: vec![TextParagraph {
                        runs: vec![TextRun {
                            text: "Speaker notes".to_owned(),
                            style: PresentationTextStyle::default(),
                        }],
                        alignment: HorizontalAlignment::Left,
                    }],
                    vertical_alignment: VerticalAlignment::Top,
                },
            },
        ])
    }

    fn populated_session() -> PresentationBindingSession {
        let mut session =
            PresentationBindingSession::create(&encode_namespace(NAMESPACE)).expect("create");
        session
            .apply_commands(&encode_presentation_command_batch(&initial_batch()).expect("encode"))
            .expect("apply");
        session
    }

    #[test]
    fn command_codec_and_stateful_session_round_trip() {
        let batch = initial_batch();
        let bytes = encode_presentation_command_batch(&batch).expect("encode");
        assert_eq!(
            decode_presentation_command_batch(&bytes).expect("decode"),
            batch
        );
        let mut session = populated_session();
        assert_eq!(session.revision().expect("revision"), 1);
        let snapshot = session.snapshot().expect("snapshot");
        assert_eq!(
            canonicalize_presentation_snapshot(&snapshot).expect("canonical"),
            snapshot
        );
        let reopened = PresentationBindingSession::open(&snapshot).expect("reopen");
        assert_eq!(
            session.state_hash().expect("hash"),
            reopened.state_hash().expect("hash")
        );
        let fork_hash = session
            .fork()
            .expect("fork")
            .state_hash()
            .expect("fork hash");
        assert_eq!(fork_hash, session.state_hash().expect("session hash"));
        session.close();
        assert_eq!(
            session.snapshot().unwrap_err().code(),
            "ARTIFACT_SESSION_CLOSED"
        );
    }

    #[test]
    fn presentation_size_is_authoritative_queryable_and_atomic() {
        let mut session = PresentationBindingSession::create(&encode_namespace(NAMESPACE))
            .expect("create presentation");
        let custom_size =
            SlideSize::new(960 * EMU_PER_CSS_PIXEL, 540 * EMU_PER_CSS_PIXEL).expect("custom size");
        let command = encode_presentation_command_batch(&PresentationBatch::from_commands(vec![
            PresentationCommand::SetPresentationSize { size: custom_size },
        ]))
        .expect("size command");
        assert_eq!(command[COMMAND_HEADER_BYTES], 15);
        session.apply_commands(&command).expect("apply size");

        let metadata_query =
            encode_presentation_metadata_query(PresentationMetadataQuery { max_bytes: 1_024 })
                .expect("metadata query");
        let PresentationQueryResponse::Metadata(metadata) = decode_presentation_query_response(
            &session.query(&metadata_query).expect("metadata response"),
        )
        .expect("decode metadata") else {
            panic!("metadata response")
        };
        assert_eq!(metadata.slide_size, custom_size);

        let authoritative = session.snapshot().expect("custom snapshot");
        let authoritative_hash = session.state_hash().expect("custom hash");
        let reopened =
            PresentationBindingSession::open(&authoritative).expect("reopen custom size");
        assert_eq!(
            reopened.snapshot().expect("reopened snapshot"),
            authoritative
        );
        assert_eq!(
            reopened.state_hash().expect("reopened hash"),
            authoritative_hash
        );

        let rollback = encode_presentation_command_batch(&PresentationBatch::from_commands(vec![
            PresentationCommand::SetPresentationSize {
                size: SlideSize::widescreen(),
            },
            PresentationCommand::SetSlideTitle {
                id: id(999),
                title: "invalid".to_owned(),
            },
        ]))
        .expect("rollback command");
        assert!(session.apply_commands(&rollback).is_err());
        assert_eq!(
            session.snapshot().expect("rollback snapshot"),
            authoritative
        );
        assert_eq!(
            session.state_hash().expect("rollback hash"),
            authoritative_hash
        );

        let mut malformed = command;
        malformed[COMMAND_HEADER_BYTES + 1..COMMAND_HEADER_BYTES + 9]
            .copy_from_slice(&0_i64.to_le_bytes());
        let checksum_offset = malformed.len() - CHECKSUM_BYTES;
        let corrected_checksum = checksum(&malformed[..checksum_offset]);
        malformed[checksum_offset..].copy_from_slice(&corrected_checksum.to_le_bytes());
        assert!(session.apply_commands(&malformed).is_err());
        assert_eq!(
            session.snapshot().expect("malformed snapshot"),
            authoritative
        );
        assert_eq!(
            session.state_hash().expect("malformed hash"),
            authoritative_hash
        );
    }

    #[test]
    fn command_codec_covers_every_command_and_scene_node_variant() {
        let styled_text = RichText {
            paragraphs: [
                HorizontalAlignment::Left,
                HorizontalAlignment::Center,
                HorizontalAlignment::Right,
                HorizontalAlignment::Justify,
            ]
            .into_iter()
            .enumerate()
            .map(|(index, alignment)| TextParagraph {
                runs: vec![TextRun {
                    text: if index == 0 {
                        String::new()
                    } else {
                        format!("paragraph {index}")
                    },
                    style: PresentationTextStyle {
                        font_family: "Inter".to_owned(),
                        font_size_centipoints: 2_125,
                        color: Color(0x1234_56ff),
                        bold: index == 1,
                        italic: index == 2,
                        underline: index == 3,
                        language: Some("en-US".to_owned()),
                    },
                }],
                alignment,
            })
            .collect(),
            vertical_alignment: VerticalAlignment::Bottom,
        };
        let line = LineStyle {
            fill: Fill::Solid(Color::BLACK),
            width: Emu::new(2 * EMU_PER_CSS_PIXEL).expect("line width"),
            dash: LineDash::Dot,
        };
        let mut commands = vec![
            PresentationCommand::CreateMaster {
                id: id(10),
                name: "Codec master".to_owned(),
                background: Fill::None,
            },
            PresentationCommand::CreateLayout {
                id: id(11),
                name: "Codec layout".to_owned(),
                master_id: Some(id(10)),
                background: Fill::Solid(Color::WHITE),
            },
            PresentationCommand::CreateSlide {
                id: id(12),
                index: 7,
                title: String::new(),
                layout_id: Some(id(11)),
                background: Fill::None,
            },
            PresentationCommand::DeleteMaster { id: id(10) },
            PresentationCommand::DeleteLayout { id: id(11) },
            PresentationCommand::DeleteSlide { id: id(12) },
            PresentationCommand::SetSlideTitle {
                id: id(12),
                title: "Renamed".to_owned(),
            },
            PresentationCommand::SetSlideLayout {
                id: id(12),
                layout_id: None,
            },
            PresentationCommand::SetSlideNotes {
                id: id(12),
                notes: styled_text.clone(),
            },
            PresentationCommand::DeleteNode { id: id(20) },
            PresentationCommand::MoveNode {
                id: id(20),
                new_parent: Some(id(21)),
                index: 3,
            },
            PresentationCommand::SetNodeBounds {
                id: id(20),
                bounds: rect(-2, 3, 40, 50),
            },
            PresentationCommand::SetNodeTransform {
                id: id(20),
                transform: Transform {
                    rotation: -90 * 60_000,
                    flip_horizontal: true,
                    flip_vertical: true,
                },
            },
            PresentationCommand::SetNodeContent {
                id: id(20),
                kind: NodeKind::Shape(Shape {
                    geometry: ShapeGeometry::RoundedRectangle,
                    fill: Fill::Solid(Color(0xabcd_efff)),
                    line,
                    text: Some(styled_text.clone()),
                    placeholder: Some(Placeholder {
                        kind: "body".to_owned(),
                        index: Some(2),
                    }),
                }),
            },
            PresentationCommand::SetPresentationSize {
                size: SlideSize::new(960 * EMU_PER_CSS_PIXEL, 540 * EMU_PER_CSS_PIXEL)
                    .expect("custom slide size"),
            },
        ];
        let mut next_id = 30u64;
        for geometry in [
            ShapeGeometry::TextBox,
            ShapeGeometry::Rectangle,
            ShapeGeometry::RoundedRectangle,
            ShapeGeometry::Ellipse,
            ShapeGeometry::Triangle,
            ShapeGeometry::RightArrow,
            ShapeGeometry::Line,
        ] {
            commands.push(PresentationCommand::InsertNode {
                owner: SceneOwner::Master(id(10)),
                parent: None,
                index: 0,
                node: NewSceneNode {
                    id: id(next_id),
                    name: format!("Shape {next_id}"),
                    bounds: rect(1, 2, 30, 40),
                    transform: Transform::default(),
                    kind: NodeKind::Shape(Shape {
                        geometry,
                        fill: Fill::None,
                        line,
                        text: Some(styled_text.clone()),
                        placeholder: None,
                    }),
                },
            });
            next_id += 1;
        }
        commands.push(PresentationCommand::InsertNode {
            owner: SceneOwner::Layout(id(11)),
            parent: None,
            index: 0,
            node: NewSceneNode {
                id: id(next_id),
                name: "Group".to_owned(),
                bounds: rect(0, 0, 100, 100),
                transform: Transform::default(),
                kind: NodeKind::Group(Group {
                    child_offset_x: Emu::new(-EMU_PER_CSS_PIXEL).expect("offset"),
                    child_offset_y: Emu::new(EMU_PER_CSS_PIXEL).expect("offset"),
                    child_extent_width: Emu::new(100 * EMU_PER_CSS_PIXEL).expect("extent"),
                    child_extent_height: Emu::new(50 * EMU_PER_CSS_PIXEL).expect("extent"),
                    children: vec![id(next_id + 1)],
                }),
            },
        });
        next_id += 2;
        for kind in [
            ConnectorKind::Straight,
            ConnectorKind::Elbow,
            ConnectorKind::Curved,
        ] {
            commands.push(PresentationCommand::InsertNode {
                owner: SceneOwner::Slide(id(12)),
                parent: None,
                index: 0,
                node: NewSceneNode {
                    id: id(next_id),
                    name: format!("Connector {next_id}"),
                    bounds: rect(0, 0, 100, 1),
                    transform: Transform::default(),
                    kind: NodeKind::Connector(Connector {
                        kind,
                        start: ConnectorEndpoint {
                            node_id: Some(id(30)),
                            x: Emu::new(-EMU_PER_CSS_PIXEL).expect("x"),
                            y: Emu::ZERO,
                        },
                        end: ConnectorEndpoint {
                            node_id: None,
                            x: Emu::new(100 * EMU_PER_CSS_PIXEL).expect("x"),
                            y: Emu::new(EMU_PER_CSS_PIXEL).expect("y"),
                        },
                        line,
                    }),
                },
            });
            next_id += 1;
        }
        for chart_type in [
            ChartType::Bar,
            ChartType::Line,
            ChartType::Area,
            ChartType::Pie,
            ChartType::Doughnut,
            ChartType::Scatter,
            ChartType::Bubble,
            ChartType::Radar,
        ] {
            commands.push(PresentationCommand::InsertNode {
                owner: SceneOwner::Slide(id(12)),
                parent: None,
                index: 0,
                node: NewSceneNode {
                    id: id(next_id),
                    name: format!("Chart {next_id}"),
                    bounds: rect(0, 0, 100, 80),
                    transform: Transform::default(),
                    kind: NodeKind::Chart(Chart {
                        chart_type,
                        title: styled_text.clone(),
                        series: vec![ChartSeries {
                            name: "Series".to_owned(),
                            categories: vec!["A".to_owned(), "B".to_owned()],
                            values: vec![Number::new(1.25).unwrap(), Number::new(-2.5).unwrap()],
                            x_values: vec![Number::new(3.0).unwrap()],
                            bubble_sizes: vec![Number::new(4.0).unwrap()],
                        }],
                        has_legend: true,
                    }),
                },
            });
            next_id += 1;
        }
        commands.push(PresentationCommand::InsertNode {
            owner: SceneOwner::Slide(id(12)),
            parent: None,
            index: 0,
            node: NewSceneNode {
                id: id(next_id),
                name: "Table".to_owned(),
                bounds: rect(0, 0, 100, 80),
                transform: Transform::default(),
                kind: NodeKind::Table(Table {
                    rows: vec![
                        vec![
                            Some(TableCell {
                                text: styled_text.clone(),
                                fill: Fill::Solid(Color::WHITE),
                                row_span: 1,
                                column_span: 2,
                            }),
                            None,
                        ],
                        vec![
                            Some(TableCell {
                                text: RichText::plain("A"),
                                fill: Fill::None,
                                row_span: 1,
                                column_span: 1,
                            }),
                            Some(TableCell {
                                text: RichText::plain("B"),
                                fill: Fill::None,
                                row_span: 1,
                                column_span: 1,
                            }),
                        ],
                    ],
                    column_widths: vec![
                        Emu::new(50 * EMU_PER_CSS_PIXEL).unwrap(),
                        Emu::new(50 * EMU_PER_CSS_PIXEL).unwrap(),
                    ],
                    row_heights: vec![
                        Emu::new(40 * EMU_PER_CSS_PIXEL).unwrap(),
                        Emu::new(40 * EMU_PER_CSS_PIXEL).unwrap(),
                    ],
                    line: LineStyle {
                        dash: LineDash::Dash,
                        ..line
                    },
                }),
            },
        });
        next_id += 1;
        for fit in [MediaFit::Contain, MediaFit::Cover] {
            commands.push(PresentationCommand::InsertNode {
                owner: SceneOwner::Slide(id(12)),
                parent: None,
                index: 0,
                node: NewSceneNode {
                    id: id(next_id),
                    name: format!("Media {next_id}"),
                    bounds: rect(0, 0, 100, 80),
                    transform: Transform::default(),
                    kind: NodeKind::Media(MediaReference {
                        digest: [u8::from(fit == MediaFit::Cover) + 1; 32],
                        content_type: "image/png".to_owned(),
                        alt_text: "Accessible image".to_owned(),
                        fit,
                        intrinsic_width: 1_920,
                        intrinsic_height: 1_080,
                    }),
                },
            });
            next_id += 1;
        }

        let batch = PresentationBatch::from_commands(commands);
        let bytes = encode_presentation_command_batch(&batch).expect("encode all variants");
        let decoded = decode_presentation_command_batch(&bytes).expect("decode all variants");
        assert_eq!(decoded, batch);
        assert_eq!(
            encode_presentation_command_batch(&decoded).expect("canonical re-encode"),
            bytes
        );
        assert_eq!(
            encode_presentation_command_batch(&PresentationBatch::from_commands(vec![
                PresentationCommand::Unsupported {
                    feature: "animation"
                },
            ]))
            .unwrap_err()
            .code(),
            "ARTIFACT_NON_CANONICAL"
        );
    }

    #[test]
    fn editor_projection_preserves_complete_scene_content_and_bounds() {
        let styled_text = RichText {
            paragraphs: vec![TextParagraph {
                runs: vec![TextRun {
                    text: "Styled 🦀".to_owned(),
                    style: PresentationTextStyle {
                        font_family: "Inter".to_owned(),
                        font_size_centipoints: 1_800,
                        color: Color(0x1234_56ff),
                        bold: true,
                        italic: true,
                        underline: false,
                        language: Some("en-US".to_owned()),
                    },
                }],
                alignment: HorizontalAlignment::Center,
            }],
            vertical_alignment: VerticalAlignment::Middle,
        };
        let chart = NodeKind::Chart(Chart {
            chart_type: ChartType::Line,
            title: styled_text.clone(),
            series: vec![ChartSeries {
                name: "Revenue".to_owned(),
                categories: vec!["Q1".to_owned(), "Q2".to_owned()],
                values: vec![Number::new(1.5).unwrap(), Number::new(2.5).unwrap()],
                x_values: vec![],
                bubble_sizes: vec![],
            }],
            has_legend: true,
        });
        let table = NodeKind::Table(Table {
            rows: vec![vec![Some(TableCell {
                text: styled_text.clone(),
                fill: Fill::Solid(Color::WHITE),
                row_span: 1,
                column_span: 1,
            })]],
            column_widths: vec![Emu::new(100 * EMU_PER_CSS_PIXEL).unwrap()],
            row_heights: vec![Emu::new(40 * EMU_PER_CSS_PIXEL).unwrap()],
            line: LineStyle::default(),
        });
        let media = NodeKind::Media(MediaReference {
            digest: [7; 32],
            content_type: "image/webp".to_owned(),
            alt_text: "Diagram".to_owned(),
            fit: MediaFit::Cover,
            intrinsic_width: 1_920,
            intrinsic_height: 1_080,
        });
        let connector = NodeKind::Connector(Connector {
            kind: ConnectorKind::Curved,
            start: ConnectorEndpoint {
                node_id: Some(id(106)),
                x: Emu::ZERO,
                y: Emu::ZERO,
            },
            end: ConnectorEndpoint {
                node_id: None,
                x: Emu::new(100 * EMU_PER_CSS_PIXEL).unwrap(),
                y: Emu::new(40 * EMU_PER_CSS_PIXEL).unwrap(),
            },
            line: LineStyle::default(),
        });
        let group = NodeKind::Group(Group {
            child_offset_x: Emu::ZERO,
            child_offset_y: Emu::ZERO,
            child_extent_width: Emu::new(100 * EMU_PER_CSS_PIXEL).unwrap(),
            child_extent_height: Emu::new(50 * EMU_PER_CSS_PIXEL).unwrap(),
            children: vec![],
        });
        let mut commands = vec![
            PresentationCommand::CreateMaster {
                id: id(100),
                name: "Projection master".to_owned(),
                background: Fill::None,
            },
            PresentationCommand::InsertNode {
                owner: SceneOwner::Master(id(100)),
                parent: None,
                index: 0,
                node: shape(id(101), "Master content"),
            },
            PresentationCommand::CreateLayout {
                id: id(102),
                name: "Projection layout".to_owned(),
                master_id: Some(id(100)),
                background: Fill::Solid(Color::WHITE),
            },
            PresentationCommand::InsertNode {
                owner: SceneOwner::Layout(id(102)),
                parent: None,
                index: 0,
                node: NewSceneNode {
                    id: id(103),
                    name: "Inherited group".to_owned(),
                    bounds: rect(0, 0, 100, 50),
                    transform: Transform::default(),
                    kind: group,
                },
            },
            PresentationCommand::InsertNode {
                owner: SceneOwner::Layout(id(102)),
                parent: Some(id(103)),
                index: 0,
                node: shape(id(104), "Group child"),
            },
            PresentationCommand::CreateSlide {
                id: id(105),
                index: 0,
                title: "Projection slide".to_owned(),
                layout_id: Some(id(102)),
                background: Fill::None,
            },
            PresentationCommand::SetSlideNotes {
                id: id(105),
                notes: styled_text.clone(),
            },
            PresentationCommand::InsertNode {
                owner: SceneOwner::Slide(id(105)),
                parent: None,
                index: 0,
                node: shape(id(106), "Anchor"),
            },
        ];
        for (index, (node_id, name, kind)) in [
            (id(107), "Connector", connector.clone()),
            (id(108), "Chart", chart.clone()),
            (id(109), "Table", table.clone()),
            (id(110), "Media", media.clone()),
        ]
        .into_iter()
        .enumerate()
        {
            commands.push(PresentationCommand::InsertNode {
                owner: SceneOwner::Slide(id(105)),
                parent: None,
                index: index + 1,
                node: NewSceneNode {
                    id: node_id,
                    name: name.to_owned(),
                    bounds: rect(10, 10, 100, 50),
                    transform: Transform {
                        rotation: 60_000,
                        flip_horizontal: index == 3,
                        flip_vertical: false,
                    },
                    kind,
                },
            });
        }
        commands.push(PresentationCommand::CreateSlide {
            id: id(111),
            index: 1,
            title: "Second".to_owned(),
            layout_id: None,
            background: Fill::None,
        });
        let mut session = PresentationBindingSession::create(&encode_namespace(NAMESPACE)).unwrap();
        session
            .apply_commands(
                &encode_presentation_command_batch(&PresentationBatch::from_commands(commands))
                    .unwrap(),
            )
            .unwrap();

        let catalog_query =
            encode_presentation_slide_catalog_query(PresentationSlideCatalogQuery {
                start_slide: 0,
                max_slides: 1,
                max_text_bytes: 1_024,
                max_bytes: 4_096,
            })
            .unwrap();
        let PresentationQueryResponse::SlideCatalog(first_page) =
            decode_presentation_query_response(&session.query(&catalog_query).unwrap()).unwrap()
        else {
            panic!("slide catalog")
        };
        assert_eq!(first_page.slides[0].id, id(105));
        assert_eq!(first_page.next_slide, Some(1));
        assert!(first_page.truncated);

        let editor_query = encode_presentation_editor_slide_query(PresentationEditorSlideQuery {
            slide_id: id(105),
            max_nodes: 32,
            max_text_bytes: 32_768,
            max_bytes: 64 * 1024,
        })
        .unwrap();
        let encoded = session.query(&editor_query).unwrap();
        let PresentationQueryResponse::EditorSlide(editor) =
            decode_presentation_query_response(&encoded).unwrap()
        else {
            panic!("editor slide")
        };
        assert_eq!(editor.nodes.len(), 8);
        assert_eq!(editor.notes, Some(styled_text));
        let inherited_group = editor.nodes.iter().find(|node| node.id == id(103)).unwrap();
        assert_eq!(inherited_group.source, SceneOwner::Layout(id(102)));
        assert!(inherited_group.inherited);
        let child = editor.nodes.iter().find(|node| node.id == id(104)).unwrap();
        assert_eq!(child.parent, Some(id(103)));
        assert_eq!(child.order, 0);
        assert_eq!(
            editor
                .nodes
                .iter()
                .find(|node| node.id == id(107))
                .unwrap()
                .kind,
            connector
        );
        assert_eq!(
            editor
                .nodes
                .iter()
                .find(|node| node.id == id(108))
                .unwrap()
                .kind,
            chart
        );
        assert_eq!(
            editor
                .nodes
                .iter()
                .find(|node| node.id == id(109))
                .unwrap()
                .kind,
            table
        );
        assert_eq!(
            editor
                .nodes
                .iter()
                .find(|node| node.id == id(110))
                .unwrap()
                .kind,
            media
        );
        assert_eq!(
            decode_presentation_query_response(&encoded).unwrap(),
            PresentationQueryResponse::EditorSlide(editor)
        );

        let bounded_query = encode_presentation_editor_slide_query(PresentationEditorSlideQuery {
            slide_id: id(105),
            max_nodes: 1,
            max_text_bytes: 32_768,
            max_bytes: 64 * 1024,
        })
        .unwrap();
        let PresentationQueryResponse::EditorSlide(bounded) =
            decode_presentation_query_response(&session.query(&bounded_query).unwrap()).unwrap()
        else {
            panic!("bounded editor slide")
        };
        assert_eq!(bounded.nodes.len(), 1);
        assert!(bounded.truncated);
    }

    #[test]
    fn viewport_hit_resolved_and_metadata_queries_are_canonical() {
        let mut session = populated_session();
        session
            .apply_commands(
                &encode_presentation_command_batch(&PresentationBatch::from_commands(vec![
                    PresentationCommand::InsertNode {
                        owner: SceneOwner::Slide(id(4)),
                        parent: None,
                        index: 1,
                        node: shape(id(6), "Front"),
                    },
                ]))
                .expect("front shape command"),
            )
            .expect("front shape");
        let viewport_query = encode_presentation_viewport_query(PresentationViewportQuery {
            owner: SceneOwner::Slide(id(4)),
            viewport: rect(0, 0, 200, 100),
            max_nodes: 16,
            max_bytes: 16_384,
        })
        .expect("viewport query");
        let viewport = decode_presentation_query_response(
            &session.query(&viewport_query).expect("viewport response"),
        )
        .expect("decode viewport");
        let PresentationQueryResponse::Viewport(viewport) = viewport else {
            panic!("viewport response")
        };
        assert_eq!(viewport.nodes[0].id, id(5));

        let byte_bounded_viewport = encode_presentation_viewport_query(PresentationViewportQuery {
            owner: SceneOwner::Slide(id(4)),
            viewport: rect(0, 0, 200, 100),
            max_nodes: 16,
            max_bytes: 160,
        })
        .expect("byte-bounded viewport query");
        let PresentationQueryResponse::Viewport(byte_bounded_viewport) =
            decode_presentation_query_response(
                &session
                    .query(&byte_bounded_viewport)
                    .expect("byte-bounded viewport response"),
            )
            .expect("decode byte-bounded viewport")
        else {
            panic!("viewport response")
        };
        assert_eq!(byte_bounded_viewport.nodes.len(), 1);
        assert_eq!(byte_bounded_viewport.nodes[0].id, id(5));
        assert!(byte_bounded_viewport.truncated);

        let hit_query = encode_presentation_hit_test_query(PresentationHitTestQuery {
            owner: SceneOwner::Slide(id(4)),
            x: Emu::new(20 * EMU_PER_CSS_PIXEL).unwrap(),
            y: Emu::new(20 * EMU_PER_CSS_PIXEL).unwrap(),
            max_nodes: 16,
            max_bytes: 16_384,
        })
        .expect("hit query");
        assert!(matches!(
            decode_presentation_query_response(&session.query(&hit_query).expect("hit response")),
            Ok(PresentationQueryResponse::HitTest(_))
        ));

        let bounded_hit_query = encode_presentation_hit_test_query(PresentationHitTestQuery {
            owner: SceneOwner::Slide(id(4)),
            x: Emu::new(20 * EMU_PER_CSS_PIXEL).unwrap(),
            y: Emu::new(20 * EMU_PER_CSS_PIXEL).unwrap(),
            max_nodes: 1,
            max_bytes: 16_384,
        })
        .expect("bounded hit query");
        let PresentationQueryResponse::HitTest(bounded_hit) = decode_presentation_query_response(
            &session
                .query(&bounded_hit_query)
                .expect("bounded hit response"),
        )
        .expect("decode bounded hit") else {
            panic!("hit response")
        };
        assert_eq!(bounded_hit.nodes.len(), 1);
        assert_eq!(bounded_hit.nodes[0].id, id(6));
        assert!(bounded_hit.truncated);

        let resolved_query = encode_resolved_slide_query(ResolvedSlideQuery {
            slide_id: id(4),
            max_nodes: 16,
            max_bytes: 16_384,
        })
        .expect("resolved query");
        let resolved = decode_presentation_query_response(
            &session.query(&resolved_query).expect("resolved response"),
        )
        .expect("decode resolved");
        assert!(matches!(
            resolved,
            PresentationQueryResponse::ResolvedSlide(_)
        ));

        let byte_bounded_resolved = encode_resolved_slide_query(ResolvedSlideQuery {
            slide_id: id(4),
            max_nodes: 16,
            max_bytes: 90,
        })
        .expect("byte-bounded resolved query");
        let PresentationQueryResponse::ResolvedSlide(byte_bounded_resolved) =
            decode_presentation_query_response(
                &session
                    .query(&byte_bounded_resolved)
                    .expect("byte-bounded resolved response"),
            )
            .expect("decode byte-bounded resolved")
        else {
            panic!("resolved response")
        };
        assert_eq!(byte_bounded_resolved.nodes.len(), 1);
        assert!(byte_bounded_resolved.truncated);

        let metadata_query =
            encode_presentation_metadata_query(PresentationMetadataQuery { max_bytes: 1_024 })
                .expect("metadata query");
        let metadata = decode_presentation_query_response(
            &session.query(&metadata_query).expect("metadata response"),
        )
        .expect("decode metadata");
        let PresentationQueryResponse::Metadata(metadata) = metadata else {
            panic!("metadata")
        };
        assert_eq!(
            (metadata.masters, metadata.layouts, metadata.slides),
            (1, 1, 1)
        );

        let catalog_query =
            encode_presentation_slide_catalog_query(PresentationSlideCatalogQuery {
                start_slide: 0,
                max_slides: 8,
                max_text_bytes: 1_024,
                max_bytes: 16_384,
            })
            .expect("slide catalog query");
        let PresentationQueryResponse::SlideCatalog(catalog) = decode_presentation_query_response(
            &session
                .query(&catalog_query)
                .expect("slide catalog response"),
        )
        .expect("decode slide catalog") else {
            panic!("slide catalog response")
        };
        assert_eq!(catalog.slides.len(), 1);
        assert_eq!(catalog.slides[0].id, id(4));
        assert_eq!(catalog.slides[0].title, "Slide");
        assert_eq!(catalog.slides[0].layout.as_ref().unwrap().id, id(3));
        assert_eq!(catalog.next_slide, None);
        assert!(!catalog.truncated);

        let editor_query = encode_presentation_editor_slide_query(PresentationEditorSlideQuery {
            slide_id: id(4),
            max_nodes: 16,
            max_text_bytes: 4_096,
            max_bytes: 16_384,
        })
        .expect("editor slide query");
        let PresentationQueryResponse::EditorSlide(editor) = decode_presentation_query_response(
            &session.query(&editor_query).expect("editor slide response"),
        )
        .expect("decode editor slide") else {
            panic!("editor slide response")
        };
        assert_eq!(editor.slide.id, id(4));
        assert_eq!(
            editor.notes.as_ref().unwrap().paragraphs[0].runs[0].text,
            "Speaker notes"
        );
        assert_eq!(editor.nodes.len(), 2);
        assert_eq!(editor.nodes[0].id, id(5));
        assert_eq!(editor.nodes[0].order, 0);
        assert!(!editor.nodes[0].inherited);
        assert_eq!(editor.nodes[1].id, id(6));
        assert!(!editor.truncated);
    }

    #[test]
    fn malformed_command_and_query_envelopes_fail_closed() {
        let command = encode_presentation_command_batch(&initial_batch()).expect("command");
        let mut corrupt = command.clone();
        corrupt[COMMAND_HEADER_BYTES] ^= 1;
        assert_eq!(
            decode_presentation_command_batch(&corrupt)
                .unwrap_err()
                .code(),
            "ARTIFACT_CHECKSUM_MISMATCH"
        );
        let mut trailing = command;
        trailing.push(0);
        assert_eq!(
            decode_presentation_command_batch(&trailing)
                .unwrap_err()
                .code(),
            "ARTIFACT_TRAILING_BYTES"
        );
        let mut query =
            encode_presentation_metadata_query(PresentationMetadataQuery { max_bytes: 1_024 })
                .expect("query");
        query[13] = 1;
        assert_eq!(
            decode_query_envelope(&query).unwrap_err().code(),
            "ARTIFACT_NON_CANONICAL"
        );
        assert_eq!(
            encode_presentation_viewport_query(PresentationViewportQuery {
                owner: SceneOwner::Slide(id(4)),
                viewport: rect(0, 0, 10, 10),
                max_nodes: 1,
                max_bytes: 88,
            })
            .unwrap_err()
            .code(),
            "ARTIFACT_LIMIT"
        );
        assert_eq!(
            encode_resolved_slide_query(ResolvedSlideQuery {
                slide_id: id(4),
                max_nodes: 1,
                max_bytes: 55,
            })
            .unwrap_err()
            .code(),
            "ARTIFACT_LIMIT"
        );
        assert_eq!(
            encode_presentation_metadata_query(PresentationMetadataQuery { max_bytes: 83 })
                .unwrap_err()
                .code(),
            "ARTIFACT_LIMIT"
        );
        assert_eq!(
            encode_presentation_slide_catalog_query(PresentationSlideCatalogQuery {
                start_slide: 0,
                max_slides: (MAX_PRESENTATION_SLIDES + 1) as u32,
                max_text_bytes: 1,
                max_bytes: 1_024,
            })
            .unwrap_err()
            .code(),
            "ARTIFACT_LIMIT"
        );
        assert_eq!(
            encode_presentation_editor_slide_query(PresentationEditorSlideQuery {
                slide_id: id(4),
                max_nodes: 1,
                max_text_bytes: 0,
                max_bytes: 1_024,
            })
            .unwrap_err()
            .code(),
            "ARTIFACT_LIMIT"
        );

        let session = populated_session();
        let no_progress_query =
            encode_presentation_slide_catalog_query(PresentationSlideCatalogQuery {
                start_slide: 0,
                max_slides: 8,
                max_text_bytes: 1,
                max_bytes: 4_096,
            })
            .unwrap();
        assert_eq!(
            session.query(&no_progress_query).unwrap_err().code(),
            "ARTIFACT_LIMIT"
        );
        let catalog_query =
            encode_presentation_slide_catalog_query(PresentationSlideCatalogQuery {
                start_slide: 0,
                max_slides: 8,
                max_text_bytes: 1_024,
                max_bytes: 4_096,
            })
            .unwrap();
        let response = session.query(&catalog_query).unwrap();
        let mut item_bomb = response.clone();
        item_bomb[24..28].copy_from_slice(&((MAX_PRESENTATION_SLIDES + 1) as u32).to_le_bytes());
        let checksum_offset = item_bomb.len() - CHECKSUM_BYTES;
        let corrected_checksum = checksum(&item_bomb[..checksum_offset]);
        item_bomb[checksum_offset..].copy_from_slice(&corrected_checksum.to_le_bytes());
        assert_eq!(
            decode_presentation_query_response(&item_bomb)
                .unwrap_err()
                .code(),
            "ARTIFACT_LIMIT"
        );

        let mut false_text_accounting = response;
        false_text_accounting[37..41].copy_from_slice(&0_u32.to_le_bytes());
        let checksum_offset = false_text_accounting.len() - CHECKSUM_BYTES;
        let corrected_checksum = checksum(&false_text_accounting[..checksum_offset]);
        false_text_accounting[checksum_offset..].copy_from_slice(&corrected_checksum.to_le_bytes());
        assert_eq!(
            decode_presentation_query_response(&false_text_accounting)
                .unwrap_err()
                .code(),
            "ARTIFACT_NON_CANONICAL"
        );
    }

    #[test]
    fn exact_boundary_probe_prevents_drift_and_rolls_back_oversize_edit() {
        let session = populated_session();
        let snapshot = session.snapshot().expect("snapshot");
        let limits = BindingLimits {
            max_command_bytes: MAX_COMMAND_ENVELOPE_BYTES,
            max_snapshot_bytes: snapshot.len(),
            max_cells_per_batch: MAX_CELLS_PER_BATCH,
            allow_boundary_probe: true,
        };
        let mut bounded =
            PresentationBindingSession::open_with_limits(&snapshot, limits).expect("bounded open");
        let same_size = encode_presentation_command_batch(&PresentationBatch::from_commands(vec![
            PresentationCommand::SetSlideTitle {
                id: id(4),
                title: "Slide".to_owned(),
            },
        ]))
        .expect("same-size command");
        for _ in 0..128 {
            bounded
                .apply_commands(&same_size)
                .expect("exact probe succeeds");
        }
        assert_eq!(
            bounded.snapshot().expect("bounded snapshot").len(),
            snapshot.len()
        );
        let before_hash = bounded.state_hash().expect("before hash");
        let before_revision = bounded.revision().expect("before revision");
        let oversize = encode_presentation_command_batch(&PresentationBatch::from_commands(vec![
            PresentationCommand::SetSlideTitle {
                id: id(4),
                title: "A title that grows the exact snapshot".to_owned(),
            },
        ]))
        .expect("oversize command");
        assert_eq!(
            bounded.apply_commands(&oversize).unwrap_err().code(),
            "ARTIFACT_LIMIT"
        );
        assert_eq!(bounded.state_hash().expect("after hash"), before_hash);
        assert_eq!(bounded.revision().expect("after revision"), before_revision);
    }

    #[test]
    fn presentation_snapshot_limit_is_negotiated_per_runtime_profile() {
        let native: serde_json::Value =
            serde_json::from_slice(crate::capabilities()).expect("native capabilities");
        let wasm: serde_json::Value =
            serde_json::from_slice(&crate::capabilities_for(crate::WASM_LIMITS))
                .expect("wasm capabilities");
        assert_eq!(native["maxPresentationSnapshotBytes"], 268_435_456_u64);
        assert_eq!(wasm["maxPresentationSnapshotBytes"], 67_108_864_u64);
    }
}
