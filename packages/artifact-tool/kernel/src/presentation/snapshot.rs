use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use crate::{IdGenerator, Number, StableId};

use super::model::PresentationSnapshotParts;
use super::{
    Chart, ChartSeries, ChartType, Color, Connector, ConnectorEndpoint, ConnectorKind, Emu, Fill,
    Group, HorizontalAlignment, Layout, LineDash, LineStyle, Master, MediaFit, MediaReference,
    NodeKind, Placeholder, Presentation, PresentationError, PresentationTextStyle, Rect, RichText,
    Scene, SceneNode, SceneOwner, Shape, ShapeGeometry, Slide, SlideSize, Table, TableCell,
    TextParagraph, TextRun, Transform, VerticalAlignment, MAX_CHART_POINTS, MAX_CHART_SERIES,
    MAX_GROUP_CHILDREN, MAX_MEDIA_TYPE_BYTES, MAX_NAME_BYTES, MAX_PRESENTATION_LAYOUTS,
    MAX_PRESENTATION_MASTERS, MAX_PRESENTATION_NODES, MAX_PRESENTATION_ROOTS,
    MAX_PRESENTATION_SLIDES, MAX_TABLE_CELLS, MAX_TABLE_COLUMNS, MAX_TABLE_ROWS, MAX_TEXT_BYTES,
    MAX_TEXT_PARAGRAPHS, MAX_TEXT_RUNS,
};

const MAGIC: [u8; 8] = *b"OGAPRS01";
const HEADER_BYTES: usize = 8 + 2 + 2 + 8;
const CHECKSUM_BYTES: usize = 32;
pub const PRESENTATION_SNAPSHOT_VERSION: u16 = 1;
pub const MAX_PRESENTATION_SNAPSHOT_BYTES: usize = 256 * 1024 * 1024;

/// Encodes one canonical, runtime-neutral presentation snapshot.
pub fn encode_presentation_snapshot(
    presentation: &Presentation,
) -> Result<Vec<u8>, PresentationError> {
    let mut payload = Encoder::new(MAX_PRESENTATION_SNAPSHOT_BYTES - HEADER_BYTES - CHECKSUM_BYTES);
    payload.id(presentation.id)?;
    payload.u64(presentation.revision)?;
    payload.u64(presentation.ids.namespace())?;
    payload.u64(presentation.ids.next_counter())?;
    payload.bool(presentation.ids.is_exhausted())?;
    payload.i64(presentation.slide_size.width.raw())?;
    payload.i64(presentation.slide_size.height.raw())?;

    payload.count(presentation.master_order.len(), MAX_PRESENTATION_MASTERS)?;
    for id in &presentation.master_order {
        let master = presentation
            .masters
            .get(id)
            .ok_or(PresentationError::InvalidSnapshot(
                "master order references a missing master",
            ))?;
        payload.id(master.id)?;
        payload.string(&master.name, MAX_NAME_BYTES)?;
        payload.fill(master.background)?;
        payload.scene(&master.scene)?;
    }

    payload.count(presentation.layout_order.len(), MAX_PRESENTATION_LAYOUTS)?;
    for id in &presentation.layout_order {
        let layout = presentation
            .layouts
            .get(id)
            .ok_or(PresentationError::InvalidSnapshot(
                "layout order references a missing layout",
            ))?;
        payload.id(layout.id)?;
        payload.string(&layout.name, MAX_NAME_BYTES)?;
        payload.optional_id(layout.master_id)?;
        payload.fill(layout.background)?;
        payload.scene(&layout.scene)?;
    }

    payload.count(presentation.slide_order.len(), MAX_PRESENTATION_SLIDES)?;
    for id in &presentation.slide_order {
        let slide = presentation
            .slides
            .get(id)
            .ok_or(PresentationError::InvalidSnapshot(
                "slide order references a missing slide",
            ))?;
        payload.id(slide.id)?;
        payload.string(&slide.title, MAX_NAME_BYTES)?;
        payload.optional_id(slide.layout_id)?;
        payload.fill(slide.background)?;
        payload.rich_text(&slide.notes)?;
        payload.scene(&slide.scene)?;
    }

    payload.count(presentation.nodes.len(), MAX_PRESENTATION_NODES)?;
    for (id, node) in &presentation.nodes {
        if id != &node.id {
            return Err(PresentationError::InvalidSnapshot(
                "node map key does not match node id",
            ));
        }
        payload.scene_node(node)?;
    }

    let payload = payload.finish();
    let payload_len = u64::try_from(payload.len())
        .map_err(|_| PresentationError::LimitExceeded("snapshot bytes"))?;
    let capacity = HEADER_BYTES
        .checked_add(payload.len())
        .and_then(|value| value.checked_add(CHECKSUM_BYTES))
        .ok_or(PresentationError::LimitExceeded("snapshot bytes"))?;
    if capacity > MAX_PRESENTATION_SNAPSHOT_BYTES {
        return Err(PresentationError::LimitExceeded("snapshot bytes"));
    }
    let mut output = Vec::with_capacity(capacity);
    output.extend_from_slice(&MAGIC);
    output.extend_from_slice(&PRESENTATION_SNAPSHOT_VERSION.to_le_bytes());
    output.extend_from_slice(&0u16.to_le_bytes());
    output.extend_from_slice(&payload_len.to_le_bytes());
    output.extend_from_slice(&payload);
    let checksum = Sha256::digest(&output);
    output.extend_from_slice(&checksum);
    Ok(output)
}

/// Decodes one complete canonical presentation snapshot with bounded allocation.
pub fn decode_presentation_snapshot(bytes: &[u8]) -> Result<Presentation, PresentationError> {
    if bytes.len() < HEADER_BYTES + CHECKSUM_BYTES {
        return Err(PresentationError::SnapshotTruncated);
    }
    if bytes.len() > MAX_PRESENTATION_SNAPSHOT_BYTES {
        return Err(PresentationError::LimitExceeded("snapshot bytes"));
    }
    if bytes[..8] != MAGIC {
        return Err(PresentationError::BadSnapshotMagic);
    }
    let version = read_u16(&bytes[8..10])?;
    if version != PRESENTATION_SNAPSHOT_VERSION {
        return Err(PresentationError::UnsupportedSnapshotVersion(version));
    }
    if read_u16(&bytes[10..12])? != 0 {
        return Err(PresentationError::NonCanonicalSnapshot(
            "reserved header bits are set",
        ));
    }
    let payload_len = usize::try_from(read_u64(&bytes[12..20])?)
        .map_err(|_| PresentationError::LimitExceeded("snapshot bytes"))?;
    let payload_end = HEADER_BYTES
        .checked_add(payload_len)
        .ok_or(PresentationError::LimitExceeded("snapshot bytes"))?;
    let expected_len = payload_end
        .checked_add(CHECKSUM_BYTES)
        .ok_or(PresentationError::LimitExceeded("snapshot bytes"))?;
    if bytes.len() != expected_len {
        return Err(if bytes.len() < expected_len {
            PresentationError::SnapshotTruncated
        } else {
            PresentationError::SnapshotTrailingBytes
        });
    }
    let expected_checksum = &bytes[payload_end..];
    if Sha256::digest(&bytes[..payload_end]).as_slice() != expected_checksum {
        return Err(PresentationError::SnapshotChecksumMismatch);
    }

    let mut decoder = Decoder::new(&bytes[HEADER_BYTES..payload_end]);
    let id = decoder.id()?;
    let revision = decoder.u64()?;
    let namespace = decoder.u64()?;
    let next_counter = decoder.u64()?;
    let exhausted = decoder.bool()?;
    if namespace == 0 || next_counter == 0 || (exhausted && next_counter != u64::MAX) {
        return Err(PresentationError::InvalidSnapshot("invalid id allocator"));
    }
    let ids = IdGenerator::from_snapshot(namespace, next_counter, exhausted);
    let slide_size = SlideSize::new(decoder.i64()?, decoder.i64()?)?;

    let master_count = decoder.count(MAX_PRESENTATION_MASTERS, 22)?;
    let mut master_order = reserve(master_count, "masters")?;
    let mut masters = BTreeMap::new();
    for _ in 0..master_count {
        let master_id = decoder.id()?;
        let master = Master {
            id: master_id,
            name: decoder.string(MAX_NAME_BYTES)?,
            background: decoder.fill()?,
            scene: decoder.scene()?,
        };
        if masters.insert(master_id, master).is_some() {
            return Err(PresentationError::DuplicateId(master_id));
        }
        master_order.push(master_id);
    }

    let layout_count = decoder.count(MAX_PRESENTATION_LAYOUTS, 23)?;
    let mut layout_order = reserve(layout_count, "layouts")?;
    let mut layouts = BTreeMap::new();
    for _ in 0..layout_count {
        let layout_id = decoder.id()?;
        let layout = Layout {
            id: layout_id,
            name: decoder.string(MAX_NAME_BYTES)?,
            master_id: decoder.optional_id()?,
            background: decoder.fill()?,
            scene: decoder.scene()?,
        };
        if layouts.insert(layout_id, layout).is_some() {
            return Err(PresentationError::DuplicateId(layout_id));
        }
        layout_order.push(layout_id);
    }

    let slide_count = decoder.count(MAX_PRESENTATION_SLIDES, 24)?;
    let mut slide_order = reserve(slide_count, "slides")?;
    let mut slides = BTreeMap::new();
    for _ in 0..slide_count {
        let slide_id = decoder.id()?;
        let slide = Slide {
            id: slide_id,
            title: decoder.string(MAX_NAME_BYTES)?,
            layout_id: decoder.optional_id()?,
            background: decoder.fill()?,
            notes: decoder.rich_text()?,
            scene: decoder.scene()?,
        };
        if slides.insert(slide_id, slide).is_some() {
            return Err(PresentationError::DuplicateId(slide_id));
        }
        slide_order.push(slide_id);
    }

    let node_count = decoder.count(MAX_PRESENTATION_NODES, 75)?;
    let mut nodes = BTreeMap::new();
    let mut previous_id = None;
    for _ in 0..node_count {
        let node = decoder.scene_node()?;
        if previous_id.is_some_and(|previous| node.id <= previous) {
            return Err(PresentationError::NonCanonicalSnapshot(
                "nodes are not strictly ordered by id",
            ));
        }
        previous_id = Some(node.id);
        if nodes.insert(node.id, node).is_some() {
            return Err(PresentationError::InvalidSnapshot("duplicate node id"));
        }
    }
    if !decoder.is_empty() {
        return Err(PresentationError::SnapshotTrailingBytes);
    }

    let presentation = Presentation::from_snapshot_parts(PresentationSnapshotParts {
        id,
        revision,
        ids,
        slide_size,
        master_order,
        masters,
        layout_order,
        layouts,
        slide_order,
        slides,
        nodes,
    })?;
    let canonical = encode_presentation_snapshot(&presentation)?;
    if canonical != bytes {
        return Err(PresentationError::NonCanonicalSnapshot(
            "snapshot does not use canonical encoding",
        ));
    }
    Ok(presentation)
}

/// SHA-256 state identity over the exact complete canonical snapshot.
pub fn presentation_state_hash(presentation: &Presentation) -> Result<[u8; 32], PresentationError> {
    let snapshot = encode_presentation_snapshot(presentation)?;
    Ok(Sha256::digest(snapshot).into())
}

struct Encoder {
    bytes: Vec<u8>,
    limit: usize,
}

impl Encoder {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            limit,
        }
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }

    fn append(&mut self, bytes: &[u8]) -> Result<(), PresentationError> {
        let next = self
            .bytes
            .len()
            .checked_add(bytes.len())
            .ok_or(PresentationError::LimitExceeded("snapshot bytes"))?;
        if next > self.limit {
            return Err(PresentationError::LimitExceeded("snapshot bytes"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }

    fn u8(&mut self, value: u8) -> Result<(), PresentationError> {
        self.append(&[value])
    }
    fn bool(&mut self, value: bool) -> Result<(), PresentationError> {
        self.u8(u8::from(value))
    }
    fn u16(&mut self, value: u16) -> Result<(), PresentationError> {
        self.append(&value.to_le_bytes())
    }
    fn u32(&mut self, value: u32) -> Result<(), PresentationError> {
        self.append(&value.to_le_bytes())
    }
    fn i32(&mut self, value: i32) -> Result<(), PresentationError> {
        self.append(&value.to_le_bytes())
    }
    fn u64(&mut self, value: u64) -> Result<(), PresentationError> {
        self.append(&value.to_le_bytes())
    }
    fn i64(&mut self, value: i64) -> Result<(), PresentationError> {
        self.append(&value.to_le_bytes())
    }
    fn id(&mut self, id: StableId) -> Result<(), PresentationError> {
        self.append(&id.to_le_bytes())
    }
    fn count(&mut self, count: usize, maximum: usize) -> Result<(), PresentationError> {
        if count > maximum {
            return Err(PresentationError::LimitExceeded("snapshot collection"));
        }
        self.u32(
            u32::try_from(count)
                .map_err(|_| PresentationError::LimitExceeded("snapshot collection"))?,
        )
    }
    fn string(&mut self, value: &str, maximum: usize) -> Result<(), PresentationError> {
        if value.len() > maximum {
            return Err(PresentationError::LimitExceeded("snapshot string"));
        }
        self.count(value.len(), maximum)?;
        self.append(value.as_bytes())
    }
    fn optional_id(&mut self, value: Option<StableId>) -> Result<(), PresentationError> {
        self.bool(value.is_some())?;
        if let Some(id) = value {
            self.id(id)?;
        }
        Ok(())
    }
    fn fill(&mut self, fill: Fill) -> Result<(), PresentationError> {
        match fill {
            Fill::None => self.u8(0),
            Fill::Solid(color) => {
                self.u8(1)?;
                self.u32(color.0)
            }
        }
    }
    fn line(&mut self, line: LineStyle) -> Result<(), PresentationError> {
        self.fill(line.fill)?;
        self.i64(line.width.raw())?;
        self.u8(match line.dash {
            LineDash::Solid => 0,
            LineDash::Dash => 1,
            LineDash::Dot => 2,
        })
    }
    fn scene(&mut self, scene: &Scene) -> Result<(), PresentationError> {
        self.count(scene.roots.len(), MAX_PRESENTATION_ROOTS)?;
        for id in &scene.roots {
            self.id(*id)?;
        }
        Ok(())
    }
    fn scene_owner(&mut self, owner: SceneOwner) -> Result<(), PresentationError> {
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
    fn rect(&mut self, rect: Rect) -> Result<(), PresentationError> {
        self.i64(rect.x.raw())?;
        self.i64(rect.y.raw())?;
        self.i64(rect.width.raw())?;
        self.i64(rect.height.raw())
    }
    fn transform(&mut self, transform: Transform) -> Result<(), PresentationError> {
        self.i32(transform.rotation)?;
        self.bool(transform.flip_horizontal)?;
        self.bool(transform.flip_vertical)
    }
    fn text_style(&mut self, style: &PresentationTextStyle) -> Result<(), PresentationError> {
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
    fn rich_text(&mut self, text: &RichText) -> Result<(), PresentationError> {
        self.u8(match text.vertical_alignment {
            VerticalAlignment::Top => 0,
            VerticalAlignment::Middle => 1,
            VerticalAlignment::Bottom => 2,
        })?;
        self.count(text.paragraphs.len(), MAX_TEXT_PARAGRAPHS)?;
        let mut run_count = 0usize;
        let mut text_bytes = 0usize;
        for paragraph in &text.paragraphs {
            self.u8(match paragraph.alignment {
                HorizontalAlignment::Left => 0,
                HorizontalAlignment::Center => 1,
                HorizontalAlignment::Right => 2,
                HorizontalAlignment::Justify => 3,
            })?;
            run_count = run_count
                .checked_add(paragraph.runs.len())
                .ok_or(PresentationError::LimitExceeded("text runs"))?;
            if run_count > MAX_TEXT_RUNS {
                return Err(PresentationError::LimitExceeded("text runs"));
            }
            self.u32(
                u32::try_from(paragraph.runs.len())
                    .map_err(|_| PresentationError::LimitExceeded("text runs"))?,
            )?;
            for run in &paragraph.runs {
                text_bytes = text_bytes
                    .checked_add(run.text.len())
                    .ok_or(PresentationError::LimitExceeded("text bytes"))?;
                if text_bytes > MAX_TEXT_BYTES {
                    return Err(PresentationError::LimitExceeded("text bytes"));
                }
                self.string(&run.text, MAX_TEXT_BYTES)?;
                self.text_style(&run.style)?;
            }
        }
        Ok(())
    }
    fn number_vec(&mut self, values: &[Number]) -> Result<(), PresentationError> {
        self.count(values.len(), MAX_CHART_POINTS)?;
        for value in values {
            self.u64(value.get().to_bits())?;
        }
        Ok(())
    }
    fn string_vec(&mut self, values: &[String]) -> Result<(), PresentationError> {
        self.count(values.len(), MAX_CHART_POINTS)?;
        for value in values {
            self.string(value, MAX_NAME_BYTES)?;
        }
        Ok(())
    }
    fn scene_node(&mut self, node: &SceneNode) -> Result<(), PresentationError> {
        self.id(node.id)?;
        self.scene_owner(node.owner)?;
        self.optional_id(node.parent)?;
        self.string(&node.name, MAX_NAME_BYTES)?;
        self.rect(node.bounds)?;
        self.transform(node.transform)?;
        self.node_kind(&node.kind)
    }
    fn node_kind(&mut self, kind: &NodeKind) -> Result<(), PresentationError> {
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
                let mut total_points = 0usize;
                for series in &chart.series {
                    self.string(&series.name, MAX_NAME_BYTES)?;
                    total_points = total_points
                        .checked_add(series.categories.len())
                        .and_then(|value| value.checked_add(series.values.len()))
                        .and_then(|value| value.checked_add(series.x_values.len()))
                        .and_then(|value| value.checked_add(series.bubble_sizes.len()))
                        .ok_or(PresentationError::LimitExceeded("chart points"))?;
                    if total_points > MAX_CHART_POINTS {
                        return Err(PresentationError::LimitExceeded("chart points"));
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
                let rows = table.rows.len();
                let columns = table.rows.first().map_or(0, Vec::len);
                self.count(rows, MAX_TABLE_ROWS)?;
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

    fn connector_endpoint(&mut self, endpoint: ConnectorEndpoint) -> Result<(), PresentationError> {
        self.optional_id(endpoint.node_id)?;
        self.i64(endpoint.x.raw())?;
        self.i64(endpoint.y.raw())
    }
}

struct Decoder<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Decoder<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }
    fn is_empty(&self) -> bool {
        self.offset == self.bytes.len()
    }
    fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.offset)
    }
    fn take(&mut self, count: usize) -> Result<&'a [u8], PresentationError> {
        let end = self
            .offset
            .checked_add(count)
            .ok_or(PresentationError::LimitExceeded("snapshot offset"))?;
        let bytes = self
            .bytes
            .get(self.offset..end)
            .ok_or(PresentationError::SnapshotTruncated)?;
        self.offset = end;
        Ok(bytes)
    }
    fn u8(&mut self) -> Result<u8, PresentationError> {
        Ok(self.take(1)?[0])
    }
    fn bool(&mut self) -> Result<bool, PresentationError> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(PresentationError::NonCanonicalSnapshot("invalid boolean")),
        }
    }
    fn u16(&mut self) -> Result<u16, PresentationError> {
        read_u16(self.take(2)?)
    }
    fn u32(&mut self) -> Result<u32, PresentationError> {
        read_u32(self.take(4)?)
    }
    fn i32(&mut self) -> Result<i32, PresentationError> {
        Ok(i32::from_le_bytes(
            self.take(4)?
                .try_into()
                .map_err(|_| PresentationError::SnapshotTruncated)?,
        ))
    }
    fn u64(&mut self) -> Result<u64, PresentationError> {
        read_u64(self.take(8)?)
    }
    fn i64(&mut self) -> Result<i64, PresentationError> {
        Ok(i64::from_le_bytes(
            self.take(8)?
                .try_into()
                .map_err(|_| PresentationError::SnapshotTruncated)?,
        ))
    }
    fn id(&mut self) -> Result<StableId, PresentationError> {
        Ok(StableId::from_le_bytes(
            self.take(16)?
                .try_into()
                .map_err(|_| PresentationError::SnapshotTruncated)?,
        ))
    }
    fn count(&mut self, maximum: usize, minimum_bytes: usize) -> Result<usize, PresentationError> {
        let count = usize::try_from(self.u32()?)
            .map_err(|_| PresentationError::LimitExceeded("snapshot collection"))?;
        if count > maximum {
            return Err(PresentationError::LimitExceeded("snapshot collection"));
        }
        if minimum_bytes > 0 && count > self.remaining() / minimum_bytes {
            return Err(PresentationError::SnapshotTruncated);
        }
        Ok(count)
    }
    fn string(&mut self, maximum: usize) -> Result<String, PresentationError> {
        let length = self.count(maximum, 1)?;
        let value = core::str::from_utf8(self.take(length)?)
            .map_err(|_| PresentationError::InvalidSnapshot("invalid UTF-8"))?;
        Ok(value.to_owned())
    }
    fn optional_id(&mut self) -> Result<Option<StableId>, PresentationError> {
        if self.bool()? {
            Ok(Some(self.id()?))
        } else {
            Ok(None)
        }
    }
    fn fill(&mut self) -> Result<Fill, PresentationError> {
        match self.u8()? {
            0 => Ok(Fill::None),
            1 => Ok(Fill::Solid(Color(self.u32()?))),
            _ => Err(PresentationError::InvalidSnapshot("invalid fill tag")),
        }
    }
    fn line(&mut self) -> Result<LineStyle, PresentationError> {
        let fill = self.fill()?;
        let width = Emu::new(self.i64()?)?;
        let dash = match self.u8()? {
            0 => LineDash::Solid,
            1 => LineDash::Dash,
            2 => LineDash::Dot,
            _ => return Err(PresentationError::InvalidSnapshot("invalid line dash tag")),
        };
        Ok(LineStyle { fill, width, dash })
    }
    fn scene(&mut self) -> Result<Scene, PresentationError> {
        let count = self.count(MAX_PRESENTATION_ROOTS, 16)?;
        let mut roots = reserve(count, "scene roots")?;
        for _ in 0..count {
            roots.push(self.id()?);
        }
        Ok(Scene { roots })
    }
    fn scene_owner(&mut self) -> Result<SceneOwner, PresentationError> {
        let tag = self.u8()?;
        let id = self.id()?;
        match tag {
            0 => Ok(SceneOwner::Master(id)),
            1 => Ok(SceneOwner::Layout(id)),
            2 => Ok(SceneOwner::Slide(id)),
            _ => Err(PresentationError::InvalidSnapshot(
                "invalid scene owner tag",
            )),
        }
    }
    fn rect(&mut self) -> Result<Rect, PresentationError> {
        Rect::new(self.i64()?, self.i64()?, self.i64()?, self.i64()?)
    }
    fn transform(&mut self) -> Result<Transform, PresentationError> {
        let transform = Transform {
            rotation: self.i32()?,
            flip_horizontal: self.bool()?,
            flip_vertical: self.bool()?,
        };
        transform.validate()?;
        Ok(transform)
    }
    fn text_style(&mut self) -> Result<PresentationTextStyle, PresentationError> {
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
    fn rich_text(&mut self) -> Result<RichText, PresentationError> {
        let vertical_alignment = match self.u8()? {
            0 => VerticalAlignment::Top,
            1 => VerticalAlignment::Middle,
            2 => VerticalAlignment::Bottom,
            _ => {
                return Err(PresentationError::InvalidSnapshot(
                    "invalid vertical alignment tag",
                ))
            }
        };
        let paragraph_count = self.count(MAX_TEXT_PARAGRAPHS, 5)?;
        let mut paragraphs = reserve(paragraph_count, "text paragraphs")?;
        let mut total_runs = 0usize;
        let mut total_bytes = 0usize;
        for _ in 0..paragraph_count {
            let alignment = match self.u8()? {
                0 => HorizontalAlignment::Left,
                1 => HorizontalAlignment::Center,
                2 => HorizontalAlignment::Right,
                3 => HorizontalAlignment::Justify,
                _ => {
                    return Err(PresentationError::InvalidSnapshot(
                        "invalid horizontal alignment tag",
                    ))
                }
            };
            // Empty run text is valid. The minimum canonical run is its four-byte
            // string length plus a one-byte font family and the 17-byte style.
            let run_count = self.count(MAX_TEXT_RUNS, 21)?;
            total_runs = total_runs
                .checked_add(run_count)
                .ok_or(PresentationError::LimitExceeded("text runs"))?;
            if total_runs > MAX_TEXT_RUNS {
                return Err(PresentationError::LimitExceeded("text runs"));
            }
            let mut runs = reserve(run_count, "text runs")?;
            for _ in 0..run_count {
                let text = self.string(MAX_TEXT_BYTES)?;
                total_bytes = total_bytes
                    .checked_add(text.len())
                    .ok_or(PresentationError::LimitExceeded("text bytes"))?;
                if total_bytes > MAX_TEXT_BYTES {
                    return Err(PresentationError::LimitExceeded("text bytes"));
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
    fn number_vec(&mut self) -> Result<Vec<Number>, PresentationError> {
        let count = self.count(MAX_CHART_POINTS, 8)?;
        let mut values = reserve(count, "chart values")?;
        for _ in 0..count {
            let bits = self.u64()?;
            let value = f64::from_bits(bits);
            if value == 0.0 && bits != 0 {
                return Err(PresentationError::NonCanonicalSnapshot(
                    "negative zero chart value",
                ));
            }
            values.push(
                Number::new(value)
                    .map_err(|_| PresentationError::InvalidChart("non-finite value"))?,
            );
        }
        Ok(values)
    }
    fn string_vec(&mut self) -> Result<Vec<String>, PresentationError> {
        let count = self.count(MAX_CHART_POINTS, 4)?;
        let mut values = reserve(count, "chart categories")?;
        for _ in 0..count {
            values.push(self.string(MAX_NAME_BYTES)?);
        }
        Ok(values)
    }
    fn scene_node(&mut self) -> Result<SceneNode, PresentationError> {
        Ok(SceneNode {
            id: self.id()?,
            owner: self.scene_owner()?,
            parent: self.optional_id()?,
            name: self.string(MAX_NAME_BYTES)?,
            bounds: self.rect()?,
            transform: self.transform()?,
            kind: self.node_kind()?,
        })
    }
    fn node_kind(&mut self) -> Result<NodeKind, PresentationError> {
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
                    _ => {
                        return Err(PresentationError::InvalidSnapshot(
                            "invalid shape geometry tag",
                        ))
                    }
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
                let child_offset_x = Emu::new(self.i64()?)?;
                let child_offset_y = Emu::new(self.i64()?)?;
                let child_extent_width = Emu::new(self.i64()?)?;
                let child_extent_height = Emu::new(self.i64()?)?;
                let child_count = self.count(MAX_GROUP_CHILDREN, 16)?;
                let mut children = reserve(child_count, "group children")?;
                for _ in 0..child_count {
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
                    _ => {
                        return Err(PresentationError::InvalidSnapshot(
                            "invalid connector kind tag",
                        ))
                    }
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
                    _ => return Err(PresentationError::InvalidSnapshot("invalid chart type tag")),
                };
                let title = self.rich_text()?;
                let series_count = self.count(MAX_CHART_SERIES, 21)?;
                let mut series = reserve(series_count, "chart series")?;
                let mut total_points = 0usize;
                for _ in 0..series_count {
                    let item = ChartSeries {
                        name: self.string(MAX_NAME_BYTES)?,
                        categories: self.string_vec()?,
                        values: self.number_vec()?,
                        x_values: self.number_vec()?,
                        bubble_sizes: self.number_vec()?,
                    };
                    total_points = total_points
                        .checked_add(item.categories.len())
                        .and_then(|value| value.checked_add(item.values.len()))
                        .and_then(|value| value.checked_add(item.x_values.len()))
                        .and_then(|value| value.checked_add(item.bubble_sizes.len()))
                        .ok_or(PresentationError::LimitExceeded("chart points"))?;
                    if total_points > MAX_CHART_POINTS {
                        return Err(PresentationError::LimitExceeded("chart points"));
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
                let row_count = self.count(MAX_TABLE_ROWS, 0)?;
                let column_count = self.count(MAX_TABLE_COLUMNS, 0)?;
                let cell_count = row_count
                    .checked_mul(column_count)
                    .ok_or(PresentationError::LimitExceeded("table cells"))?;
                if row_count == 0 || column_count == 0 || cell_count > MAX_TABLE_CELLS {
                    return Err(PresentationError::LimitExceeded("table cells"));
                }
                if cell_count > self.remaining() {
                    return Err(PresentationError::SnapshotTruncated);
                }
                let mut rows = reserve(row_count, "table rows")?;
                for _ in 0..row_count {
                    let mut row = reserve(column_count, "table columns")?;
                    for _ in 0..column_count {
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
                let mut column_widths = reserve(width_count, "table column widths")?;
                for _ in 0..width_count {
                    column_widths.push(Emu::new(self.i64()?)?);
                }
                let height_count = self.count(MAX_TABLE_ROWS, 8)?;
                let mut row_heights = reserve(height_count, "table row heights")?;
                for _ in 0..height_count {
                    row_heights.push(Emu::new(self.i64()?)?);
                }
                Ok(NodeKind::Table(Table {
                    rows,
                    column_widths,
                    row_heights,
                    line: self.line()?,
                }))
            }
            5 => {
                let digest = self
                    .take(32)?
                    .try_into()
                    .map_err(|_| PresentationError::SnapshotTruncated)?;
                let content_type = self.string(MAX_MEDIA_TYPE_BYTES)?;
                let alt_text = self.string(MAX_TEXT_BYTES)?;
                let fit = match self.u8()? {
                    0 => MediaFit::Contain,
                    1 => MediaFit::Cover,
                    _ => return Err(PresentationError::InvalidSnapshot("invalid media fit tag")),
                };
                Ok(NodeKind::Media(MediaReference {
                    digest,
                    content_type,
                    alt_text,
                    fit,
                    intrinsic_width: self.u32()?,
                    intrinsic_height: self.u32()?,
                }))
            }
            _ => Err(PresentationError::InvalidSnapshot("invalid node kind tag")),
        }
    }

    fn connector_endpoint(&mut self) -> Result<ConnectorEndpoint, PresentationError> {
        Ok(ConnectorEndpoint {
            node_id: self.optional_id()?,
            x: Emu::new(self.i64()?)?,
            y: Emu::new(self.i64()?)?,
        })
    }
}

fn reserve<T>(count: usize, label: &'static str) -> Result<Vec<T>, PresentationError> {
    let mut values = Vec::new();
    values
        .try_reserve_exact(count)
        .map_err(|_| PresentationError::LimitExceeded(label))?;
    Ok(values)
}

fn read_u16(bytes: &[u8]) -> Result<u16, PresentationError> {
    Ok(u16::from_le_bytes(
        bytes
            .try_into()
            .map_err(|_| PresentationError::SnapshotTruncated)?,
    ))
}

fn read_u32(bytes: &[u8]) -> Result<u32, PresentationError> {
    Ok(u32::from_le_bytes(
        bytes
            .try_into()
            .map_err(|_| PresentationError::SnapshotTruncated)?,
    ))
}

fn read_u64(bytes: &[u8]) -> Result<u64, PresentationError> {
    Ok(u64::from_le_bytes(
        bytes
            .try_into()
            .map_err(|_| PresentationError::SnapshotTruncated)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::presentation::{
        Color, Fill, LineStyle, NewSceneNode, PresentationBatch, PresentationCommand, SceneOwner,
        Shape, ShapeGeometry, Transform, EMU_PER_CSS_PIXEL,
    };

    fn fixture() -> Presentation {
        let mut presentation =
            Presentation::new(99, SlideSize::widescreen()).expect("presentation");
        let slide_id = StableId::from_parts(99, 2);
        let shape_id = StableId::from_parts(99, 3);
        presentation
            .apply_batch(&PresentationBatch::from_commands(vec![
                PresentationCommand::CreateSlide {
                    id: slide_id,
                    index: 0,
                    title: "Canonical".to_owned(),
                    layout_id: None,
                    background: Fill::Solid(Color::WHITE),
                },
                PresentationCommand::InsertNode {
                    owner: SceneOwner::Slide(slide_id),
                    parent: None,
                    index: 0,
                    node: NewSceneNode {
                        id: shape_id,
                        name: "Title".to_owned(),
                        bounds: Rect::new(
                            10 * EMU_PER_CSS_PIXEL,
                            20 * EMU_PER_CSS_PIXEL,
                            300 * EMU_PER_CSS_PIXEL,
                            80 * EMU_PER_CSS_PIXEL,
                        )
                        .expect("rect"),
                        transform: Transform::default(),
                        kind: NodeKind::Shape(Shape {
                            geometry: ShapeGeometry::TextBox,
                            fill: Fill::None,
                            line: LineStyle::default(),
                            text: Some(RichText::plain("Hello 🌍")),
                            placeholder: Some(Placeholder {
                                kind: "title".to_owned(),
                                index: Some(0),
                            }),
                        }),
                    },
                },
            ]))
            .expect("commands");
        presentation
    }

    #[test]
    fn snapshot_round_trip_is_byte_stable() {
        let presentation = fixture();
        let first = encode_presentation_snapshot(&presentation).expect("encode");
        let decoded = decode_presentation_snapshot(&first).expect("decode");
        let second = encode_presentation_snapshot(&decoded).expect("re-encode");
        assert_eq!(first, second);
        assert_eq!(presentation, decoded);
        assert_eq!(
            presentation_state_hash(&presentation).expect("hash"),
            presentation_state_hash(&decoded).expect("decoded hash")
        );
        assert_eq!(
            presentation_state_hash(&presentation).expect("state hash"),
            Sha256::digest(&first).as_slice()
        );
    }

    #[test]
    fn empty_shape_text_round_trips_without_decoder_lookahead() {
        let mut presentation = fixture();
        let shape_id = StableId::from_parts(99, 3);
        let mut kind = presentation.node(shape_id).expect("shape").kind.clone();
        let NodeKind::Shape(shape) = &mut kind else {
            panic!("shape")
        };
        shape.text = Some(RichText::plain(""));
        shape.placeholder = None;
        presentation
            .apply_batch(&PresentationBatch::from_commands(vec![
                PresentationCommand::SetNodeContent { id: shape_id, kind },
            ]))
            .expect("empty text");
        let snapshot = encode_presentation_snapshot(&presentation).expect("encode");
        assert_eq!(
            decode_presentation_snapshot(&snapshot).expect("decode"),
            presentation
        );
    }

    #[test]
    fn snapshot_rejects_corruption_trailing_and_noncanonical_flags() {
        let bytes = encode_presentation_snapshot(&fixture()).expect("encode");
        let mut corrupt = bytes.clone();
        corrupt[HEADER_BYTES + 1] ^= 0x80;
        assert_eq!(
            decode_presentation_snapshot(&corrupt),
            Err(PresentationError::SnapshotChecksumMismatch)
        );
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert_eq!(
            decode_presentation_snapshot(&trailing),
            Err(PresentationError::SnapshotTrailingBytes)
        );
        let mut reserved = bytes;
        reserved[10] = 1;
        assert!(matches!(
            decode_presentation_snapshot(&reserved),
            Err(PresentationError::NonCanonicalSnapshot(_))
        ));
    }

    #[test]
    fn truncated_length_is_rejected_before_payload_allocation() {
        let mut bytes = vec![0u8; HEADER_BYTES + CHECKSUM_BYTES];
        bytes[..8].copy_from_slice(&MAGIC);
        bytes[8..10].copy_from_slice(&PRESENTATION_SNAPSHOT_VERSION.to_le_bytes());
        bytes[12..20].copy_from_slice(&u64::MAX.to_le_bytes());
        assert!(matches!(
            decode_presentation_snapshot(&bytes),
            Err(PresentationError::LimitExceeded(_)) | Err(PresentationError::SnapshotTruncated)
        ));
    }
}
