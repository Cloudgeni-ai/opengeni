/** Canonical identity-free OGAPC001/OGAPQ001/OGAPV001 presentation ABI. */

import {
  ArtifactBinaryReader,
  ArtifactBinaryWriter,
  decodeCountedEnvelope,
  encodeCountedEnvelope,
  equalBytes,
  fnv1a64,
  strictUtf8,
} from "./editable-artifact-binary";

export const PRESENTATION_ARTIFACT_COMMAND_VERSION = 1 as const;
export const PRESENTATION_ARTIFACT_QUERY_VERSION = 1 as const;
export const PRESENTATION_ARTIFACT_QUERY_RESPONSE_VERSION = 1 as const;
export const PRESENTATION_ARTIFACT_COMMAND_MAX_BYTES = 4 * 1024 * 1024;
export const PRESENTATION_ARTIFACT_COMMAND_MAX_COMMANDS = 10_000;
export const PRESENTATION_ARTIFACT_QUERY_MAX_BYTES = 96;
export const PRESENTATION_ARTIFACT_QUERY_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
export const PRESENTATION_ARTIFACT_QUERY_MAX_NODES = 16_384;
export const PRESENTATION_ARTIFACT_QUERY_MAX_SLIDES = 10_000;
export const PRESENTATION_ARTIFACT_QUERY_MAX_TEXT_BYTES = 4 * 1024 * 1024;
export const PRESENTATION_ARTIFACT_MAX_COORDINATE = 9_525_000_000_000;
export const PRESENTATION_ARTIFACT_MAX_NAME_BYTES = 1_024;
export const PRESENTATION_ARTIFACT_MAX_TEXT_BYTES = 16 * 1024 * 1024;
export const PRESENTATION_ARTIFACT_MAX_TEXT_PARAGRAPHS = 100_000;
export const PRESENTATION_ARTIFACT_MAX_TEXT_RUNS = 250_000;
export const PRESENTATION_ARTIFACT_MAX_TABLE_ROWS = 10_000;
export const PRESENTATION_ARTIFACT_MAX_TABLE_COLUMNS = 1_024;
export const PRESENTATION_ARTIFACT_MAX_TABLE_CELLS = 1_000_000;
export const PRESENTATION_ARTIFACT_MAX_CHART_SERIES = 16_384;
export const PRESENTATION_ARTIFACT_MAX_CHART_POINTS = 1_000_000;
export const PRESENTATION_ARTIFACT_MAX_GROUP_CHILDREN = 100_000;

const COMMAND_MAGIC = "OGAPC001";
const QUERY_MAGIC = strictUtf8("OGAPQ001", "presentation query magic");
const RESPONSE_MAGIC = strictUtf8("OGAPV001", "presentation response magic");
const QUERY_HEADER_BYTES = 28;
const RESPONSE_HEADER_BYTES = 32;
const CHECKSUM_BYTES = 8;

export type PresentationArtifactStableId = string;
export type PresentationArtifactFill =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "solid"; color: number }>;
export type PresentationArtifactLine = Readonly<{
  fill: PresentationArtifactFill;
  width: number;
  dash: "solid" | "dash" | "dot";
}>;
export type PresentationArtifactRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;
export type PresentationArtifactTransform = Readonly<{
  rotation: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
}>;
export type PresentationArtifactOwner = Readonly<{
  kind: "master" | "layout" | "slide";
  id: PresentationArtifactStableId;
}>;
export type PresentationArtifactTextStyle = Readonly<{
  fontFamily: string;
  fontSizeCentipoints: number;
  color: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  language: string | null;
}>;
export type PresentationArtifactTextRun = Readonly<{
  text: string;
  style: PresentationArtifactTextStyle;
}>;
export type PresentationArtifactTextParagraph = Readonly<{
  runs: readonly PresentationArtifactTextRun[];
  alignment: "left" | "center" | "right" | "justify";
}>;
export type PresentationArtifactRichText = Readonly<{
  paragraphs: readonly PresentationArtifactTextParagraph[];
  verticalAlignment: "top" | "middle" | "bottom";
}>;
export type PresentationArtifactConnectorEndpoint = Readonly<{
  nodeId: PresentationArtifactStableId | null;
  x: number;
  y: number;
}>;
export type PresentationArtifactChartSeries = Readonly<{
  name: string;
  categories: readonly string[];
  values: readonly number[];
  xValues: readonly number[];
  bubbleSizes: readonly number[];
}>;
export type PresentationArtifactTableCell = Readonly<{
  text: PresentationArtifactRichText;
  fill: PresentationArtifactFill;
  rowSpan: number;
  columnSpan: number;
}>;
export type PresentationArtifactNodeKind =
  | Readonly<{
      kind: "shape";
      geometry:
        | "text-box"
        | "rectangle"
        | "rounded-rectangle"
        | "ellipse"
        | "triangle"
        | "right-arrow"
        | "line";
      fill: PresentationArtifactFill;
      line: PresentationArtifactLine;
      text: PresentationArtifactRichText | null;
      placeholder: Readonly<{ kind: string; index: number | null }> | null;
    }>
  | Readonly<{
      kind: "group";
      childOffsetX: number;
      childOffsetY: number;
      childExtentWidth: number;
      childExtentHeight: number;
      children: readonly PresentationArtifactStableId[];
    }>
  | Readonly<{
      kind: "connector";
      connectorKind: "straight" | "elbow" | "curved";
      start: PresentationArtifactConnectorEndpoint;
      end: PresentationArtifactConnectorEndpoint;
      line: PresentationArtifactLine;
    }>
  | Readonly<{
      kind: "chart";
      chartType: "bar" | "line" | "area" | "pie" | "doughnut" | "scatter" | "bubble" | "radar";
      title: PresentationArtifactRichText;
      series: readonly PresentationArtifactChartSeries[];
      hasLegend: boolean;
    }>
  | Readonly<{
      kind: "table";
      rows: readonly (readonly (PresentationArtifactTableCell | null)[])[];
      columnWidths: readonly number[];
      rowHeights: readonly number[];
      line: PresentationArtifactLine;
    }>
  | Readonly<{
      kind: "media";
      digest: Uint8Array;
      contentType: string;
      altText: string;
      fit: "contain" | "cover";
      intrinsicWidth: number;
      intrinsicHeight: number;
    }>;

export type PresentationArtifactNewNode = Readonly<{
  id: PresentationArtifactStableId;
  name: string;
  bounds: PresentationArtifactRect;
  transform: PresentationArtifactTransform;
  content: PresentationArtifactNodeKind;
}>;

export type PresentationArtifactCommand =
  | Readonly<{
      kind: "master.create";
      id: PresentationArtifactStableId;
      name: string;
      background: PresentationArtifactFill;
    }>
  | Readonly<{
      kind: "layout.create";
      id: PresentationArtifactStableId;
      name: string;
      masterId: PresentationArtifactStableId | null;
      background: PresentationArtifactFill;
    }>
  | Readonly<{
      kind: "slide.create";
      id: PresentationArtifactStableId;
      index: number;
      title: string;
      layoutId: PresentationArtifactStableId | null;
      background: PresentationArtifactFill;
    }>
  | Readonly<{ kind: "master.delete"; id: PresentationArtifactStableId }>
  | Readonly<{ kind: "layout.delete"; id: PresentationArtifactStableId }>
  | Readonly<{ kind: "slide.delete"; id: PresentationArtifactStableId }>
  | Readonly<{ kind: "slide.title.set"; id: PresentationArtifactStableId; title: string }>
  | Readonly<{
      kind: "slide.layout.set";
      id: PresentationArtifactStableId;
      layoutId: PresentationArtifactStableId | null;
    }>
  | Readonly<{
      kind: "slide.notes.set";
      id: PresentationArtifactStableId;
      notes: PresentationArtifactRichText;
    }>
  | Readonly<{
      kind: "node.insert";
      owner: PresentationArtifactOwner;
      parentId: PresentationArtifactStableId | null;
      index: number;
      node: PresentationArtifactNewNode;
    }>
  | Readonly<{ kind: "node.delete"; id: PresentationArtifactStableId }>
  | Readonly<{
      kind: "node.move";
      id: PresentationArtifactStableId;
      newParentId: PresentationArtifactStableId | null;
      index: number;
    }>
  | Readonly<{
      kind: "node.bounds.set";
      id: PresentationArtifactStableId;
      bounds: PresentationArtifactRect;
    }>
  | Readonly<{
      kind: "node.transform.set";
      id: PresentationArtifactStableId;
      transform: PresentationArtifactTransform;
    }>
  | Readonly<{
      kind: "node.content.set";
      id: PresentationArtifactStableId;
      content: PresentationArtifactNodeKind;
    }>
  | Readonly<{
      kind: "presentation.size.set";
      size: Readonly<{ width: number; height: number }>;
    }>;

export type PresentationArtifactCommandBatch = Readonly<{
  version: typeof PRESENTATION_ARTIFACT_COMMAND_VERSION;
  commands: readonly PresentationArtifactCommand[];
}>;

export function encodePresentationArtifactCommandBatch(
  input: PresentationArtifactCommandBatch,
): Uint8Array {
  if (input?.version !== 1 || !Array.isArray(input.commands))
    throw new TypeError("presentation command batch is invalid");
  if (input.commands.length > PRESENTATION_ARTIFACT_COMMAND_MAX_COMMANDS)
    throw new RangeError("presentation command count exceeds its limit");
  const payload = new ArtifactBinaryWriter(PRESENTATION_ARTIFACT_COMMAND_MAX_BYTES - 32);
  for (const command of input.commands) writeCommand(payload, command);
  return encodeCountedEnvelope(
    COMMAND_MAGIC,
    1,
    input.commands.length,
    payload.finish(),
    PRESENTATION_ARTIFACT_COMMAND_MAX_BYTES,
  );
}

export function decodePresentationArtifactCommandBatch(
  bytes: Uint8Array,
): PresentationArtifactCommandBatch {
  const envelope = decodeCountedEnvelope(
    bytes,
    COMMAND_MAGIC,
    1,
    PRESENTATION_ARTIFACT_COMMAND_MAX_BYTES,
    PRESENTATION_ARTIFACT_COMMAND_MAX_COMMANDS,
  );
  const reader = new ArtifactBinaryReader(envelope.payload);
  const commands: PresentationArtifactCommand[] = [];
  for (let index = 0; index < envelope.count; index += 1) commands.push(readCommand(reader));
  reader.done("presentation command payload contains trailing bytes");
  return Object.freeze({ version: 1, commands: Object.freeze(commands) });
}

export function assertCanonicalPresentationArtifactCommandBytes(bytes: Uint8Array): void {
  if (
    !equalBytes(
      bytes,
      encodePresentationArtifactCommandBatch(decodePresentationArtifactCommandBatch(bytes)),
    )
  ) {
    throw new TypeError("presentation command batch is not canonically encoded");
  }
}

function writeCommand(writer: ArtifactBinaryWriter, command: PresentationArtifactCommand): void {
  switch (command.kind) {
    case "master.create":
      writer.u8(0);
      writeId(writer, command.id);
      writeString(writer, command.name, PRESENTATION_ARTIFACT_MAX_NAME_BYTES);
      writeFill(writer, command.background);
      return;
    case "layout.create":
      writer.u8(1);
      writeId(writer, command.id);
      writeString(writer, command.name, PRESENTATION_ARTIFACT_MAX_NAME_BYTES);
      writeOptionalId(writer, command.masterId);
      writeFill(writer, command.background);
      return;
    case "slide.create":
      writer.u8(2);
      writeId(writer, command.id);
      writer.u32(command.index);
      writeString(writer, command.title, PRESENTATION_ARTIFACT_MAX_NAME_BYTES);
      writeOptionalId(writer, command.layoutId);
      writeFill(writer, command.background);
      return;
    case "master.delete":
      writer.u8(3);
      writeId(writer, command.id);
      return;
    case "layout.delete":
      writer.u8(4);
      writeId(writer, command.id);
      return;
    case "slide.delete":
      writer.u8(5);
      writeId(writer, command.id);
      return;
    case "slide.title.set":
      writer.u8(6);
      writeId(writer, command.id);
      writeString(writer, command.title, PRESENTATION_ARTIFACT_MAX_NAME_BYTES);
      return;
    case "slide.layout.set":
      writer.u8(7);
      writeId(writer, command.id);
      writeOptionalId(writer, command.layoutId);
      return;
    case "slide.notes.set":
      writer.u8(8);
      writeId(writer, command.id);
      writeRichText(writer, command.notes);
      return;
    case "node.insert":
      writer.u8(9);
      writeOwner(writer, command.owner);
      writeOptionalId(writer, command.parentId);
      writer.u32(command.index);
      writeNewNode(writer, command.node);
      return;
    case "node.delete":
      writer.u8(10);
      writeId(writer, command.id);
      return;
    case "node.move":
      writer.u8(11);
      writeId(writer, command.id);
      writeOptionalId(writer, command.newParentId);
      writer.u32(command.index);
      return;
    case "node.bounds.set":
      writer.u8(12);
      writeId(writer, command.id);
      writeRect(writer, command.bounds);
      return;
    case "node.transform.set":
      writer.u8(13);
      writeId(writer, command.id);
      writeTransform(writer, command.transform);
      return;
    case "node.content.set":
      writer.u8(14);
      writeId(writer, command.id);
      writeNodeKind(writer, command.content);
      return;
    case "presentation.size.set":
      writer.u8(15);
      writeSlideSize(writer, command.size);
      return;
    default:
      throw new TypeError("invalid presentation command kind");
  }
}

function readCommand(reader: ArtifactBinaryReader): PresentationArtifactCommand {
  switch (reader.u8()) {
    case 0:
      return Object.freeze({
        kind: "master.create",
        id: readId(reader),
        name: readString(reader, PRESENTATION_ARTIFACT_MAX_NAME_BYTES),
        background: readFill(reader),
      });
    case 1:
      return Object.freeze({
        kind: "layout.create",
        id: readId(reader),
        name: readString(reader, PRESENTATION_ARTIFACT_MAX_NAME_BYTES),
        masterId: readOptionalId(reader),
        background: readFill(reader),
      });
    case 2:
      return Object.freeze({
        kind: "slide.create",
        id: readId(reader),
        index: reader.u32(),
        title: readString(reader, PRESENTATION_ARTIFACT_MAX_NAME_BYTES),
        layoutId: readOptionalId(reader),
        background: readFill(reader),
      });
    case 3:
      return Object.freeze({ kind: "master.delete", id: readId(reader) });
    case 4:
      return Object.freeze({ kind: "layout.delete", id: readId(reader) });
    case 5:
      return Object.freeze({ kind: "slide.delete", id: readId(reader) });
    case 6:
      return Object.freeze({
        kind: "slide.title.set",
        id: readId(reader),
        title: readString(reader, PRESENTATION_ARTIFACT_MAX_NAME_BYTES),
      });
    case 7:
      return Object.freeze({
        kind: "slide.layout.set",
        id: readId(reader),
        layoutId: readOptionalId(reader),
      });
    case 8:
      return Object.freeze({
        kind: "slide.notes.set",
        id: readId(reader),
        notes: readRichText(reader),
      });
    case 9:
      return Object.freeze({
        kind: "node.insert",
        owner: readOwner(reader),
        parentId: readOptionalId(reader),
        index: reader.u32(),
        node: readNewNode(reader),
      });
    case 10:
      return Object.freeze({ kind: "node.delete", id: readId(reader) });
    case 11:
      return Object.freeze({
        kind: "node.move",
        id: readId(reader),
        newParentId: readOptionalId(reader),
        index: reader.u32(),
      });
    case 12:
      return Object.freeze({
        kind: "node.bounds.set",
        id: readId(reader),
        bounds: readRect(reader),
      });
    case 13:
      return Object.freeze({
        kind: "node.transform.set",
        id: readId(reader),
        transform: readTransform(reader),
      });
    case 14:
      return Object.freeze({
        kind: "node.content.set",
        id: readId(reader),
        content: readNodeKind(reader),
      });
    case 15:
      return Object.freeze({
        kind: "presentation.size.set",
        size: readSlideSize(reader),
      });
    default:
      throw new TypeError("invalid presentation command tag");
  }
}

function writeId(writer: ArtifactBinaryWriter, id: string): void {
  writer.stableId(id, "presentation id");
}
function readId(reader: ArtifactBinaryReader): string {
  return reader.stableId("presentation id");
}
function writeOptionalId(writer: ArtifactBinaryWriter, id: string | null): void {
  writer.bool(id !== null);
  if (id !== null) writeId(writer, id);
}
function readOptionalId(reader: ArtifactBinaryReader): string | null {
  return reader.bool("optional presentation id") ? readId(reader) : null;
}

function writeString(writer: ArtifactBinaryWriter, value: string, maximum: number): void {
  writer.string(value, maximum, "presentation string");
}
function readString(reader: ArtifactBinaryReader, maximum: number): string {
  return reader.string(maximum, "presentation string");
}

function writeOwner(writer: ArtifactBinaryWriter, owner: PresentationArtifactOwner): void {
  writer.u8(
    owner.kind === "master"
      ? 0
      : owner.kind === "layout"
        ? 1
        : owner.kind === "slide"
          ? 2
          : bad("presentation owner"),
  );
  writeId(writer, owner.id);
}
function readOwner(reader: ArtifactBinaryReader): PresentationArtifactOwner {
  const tag = reader.u8();
  const id = readId(reader);
  return Object.freeze({
    kind:
      tag === 0 ? "master" : tag === 1 ? "layout" : tag === 2 ? "slide" : bad("presentation owner"),
    id,
  });
}

function writeFill(writer: ArtifactBinaryWriter, fill: PresentationArtifactFill): void {
  if (fill.kind === "none") writer.u8(0);
  else if (fill.kind === "solid") {
    writer.u8(1);
    writer.u32(fill.color);
  } else bad("presentation fill");
}
function readFill(reader: ArtifactBinaryReader): PresentationArtifactFill {
  const tag = reader.u8();
  if (tag === 0) return Object.freeze({ kind: "none" });
  if (tag === 1) return Object.freeze({ kind: "solid", color: reader.u32() });
  return bad("presentation fill");
}

function writeLine(writer: ArtifactBinaryWriter, line: PresentationArtifactLine): void {
  writeFill(writer, line.fill);
  writer.i64(coordinate(line.width, "presentation line width"));
  writer.u8(
    line.dash === "solid"
      ? 0
      : line.dash === "dash"
        ? 1
        : line.dash === "dot"
          ? 2
          : bad("presentation line dash"),
  );
}
function readLine(reader: ArtifactBinaryReader): PresentationArtifactLine {
  const fill = readFill(reader);
  const width = readCoordinate(reader, "presentation line width");
  const tag = reader.u8();
  return Object.freeze({
    fill,
    width,
    dash:
      tag === 0 ? "solid" : tag === 1 ? "dash" : tag === 2 ? "dot" : bad("presentation line dash"),
  });
}

function writeRect(writer: ArtifactBinaryWriter, rect: PresentationArtifactRect): void {
  const x = coordinate(rect.x, "presentation x");
  const y = coordinate(rect.y, "presentation y");
  const width = coordinate(rect.width, "presentation width");
  const height = coordinate(rect.height, "presentation height");
  if (
    width <= 0 ||
    height <= 0 ||
    Math.abs(x + width) > PRESENTATION_ARTIFACT_MAX_COORDINATE ||
    Math.abs(y + height) > PRESENTATION_ARTIFACT_MAX_COORDINATE
  )
    bad("presentation rectangle");
  writer.i64(x);
  writer.i64(y);
  writer.i64(width);
  writer.i64(height);
}
function writeSlideSize(
  writer: ArtifactBinaryWriter,
  size: Readonly<{ width: number; height: number }>,
): void {
  const width = coordinate(size.width, "presentation slide width");
  const height = coordinate(size.height, "presentation slide height");
  if (width <= 0 || height <= 0) throw new TypeError("invalid presentation slide size");
  writer.i64(width);
  writer.i64(height);
}
function readSlideSize(reader: ArtifactBinaryReader): Readonly<{ width: number; height: number }> {
  const size = Object.freeze({
    width: readCoordinate(reader, "presentation slide width"),
    height: readCoordinate(reader, "presentation slide height"),
  });
  if (size.width <= 0 || size.height <= 0) throw new TypeError("invalid presentation slide size");
  return size;
}
function readRect(reader: ArtifactBinaryReader): PresentationArtifactRect {
  const rect = Object.freeze({
    x: readCoordinate(reader, "presentation x"),
    y: readCoordinate(reader, "presentation y"),
    width: readCoordinate(reader, "presentation width"),
    height: readCoordinate(reader, "presentation height"),
  });
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    Math.abs(rect.x + rect.width) > PRESENTATION_ARTIFACT_MAX_COORDINATE ||
    Math.abs(rect.y + rect.height) > PRESENTATION_ARTIFACT_MAX_COORDINATE
  )
    bad("presentation rectangle");
  return rect;
}

function writeTransform(
  writer: ArtifactBinaryWriter,
  transform: PresentationArtifactTransform,
): void {
  if (
    !Number.isInteger(transform.rotation) ||
    transform.rotation < -21_600_000 ||
    transform.rotation > 21_600_000
  )
    bad("presentation rotation");
  writer.i32(transform.rotation);
  writer.bool(transform.flipHorizontal);
  writer.bool(transform.flipVertical);
}
function readTransform(reader: ArtifactBinaryReader): PresentationArtifactTransform {
  const rotation = reader.i32();
  if (rotation < -21_600_000 || rotation > 21_600_000) bad("presentation rotation");
  return Object.freeze({
    rotation,
    flipHorizontal: reader.bool("presentation boolean"),
    flipVertical: reader.bool("presentation boolean"),
  });
}

function writeRichText(writer: ArtifactBinaryWriter, text: PresentationArtifactRichText): void {
  writer.u8(
    text.verticalAlignment === "top"
      ? 0
      : text.verticalAlignment === "middle"
        ? 1
        : text.verticalAlignment === "bottom"
          ? 2
          : bad("vertical alignment"),
  );
  writer.count(
    text.paragraphs.length,
    PRESENTATION_ARTIFACT_MAX_TEXT_PARAGRAPHS,
    "presentation paragraphs",
  );
  let totalRuns = 0;
  let totalBytes = 0;
  for (const paragraph of text.paragraphs) {
    writer.u8(
      paragraph.alignment === "left"
        ? 0
        : paragraph.alignment === "center"
          ? 1
          : paragraph.alignment === "right"
            ? 2
            : paragraph.alignment === "justify"
              ? 3
              : bad("horizontal alignment"),
    );
    totalRuns += paragraph.runs.length;
    if (totalRuns > PRESENTATION_ARTIFACT_MAX_TEXT_RUNS)
      throw new RangeError("presentation text runs exceed their limit");
    writer.count(
      paragraph.runs.length,
      PRESENTATION_ARTIFACT_MAX_TEXT_RUNS,
      "presentation text runs",
    );
    for (const run of paragraph.runs) {
      const bytes = strictUtf8(run.text, "presentation text");
      totalBytes += bytes.byteLength;
      if (totalBytes > PRESENTATION_ARTIFACT_MAX_TEXT_BYTES)
        throw new RangeError("presentation text exceeds its byte limit");
      writer.u32(bytes.byteLength);
      writer.bytes(bytes);
      writeTextStyle(writer, run.style);
    }
  }
}

function readRichText(reader: ArtifactBinaryReader): PresentationArtifactRichText {
  const verticalTag = reader.u8();
  const verticalAlignment =
    verticalTag === 0
      ? "top"
      : verticalTag === 1
        ? "middle"
        : verticalTag === 2
          ? "bottom"
          : bad("vertical alignment");
  const count = reader.count(PRESENTATION_ARTIFACT_MAX_TEXT_PARAGRAPHS, "presentation paragraphs");
  const paragraphs: PresentationArtifactTextParagraph[] = [];
  let totalRuns = 0;
  let totalBytes = 0;
  for (let index = 0; index < count; index += 1) {
    const alignmentTag = reader.u8();
    const alignment =
      alignmentTag === 0
        ? "left"
        : alignmentTag === 1
          ? "center"
          : alignmentTag === 2
            ? "right"
            : alignmentTag === 3
              ? "justify"
              : bad("horizontal alignment");
    const runCount = reader.count(PRESENTATION_ARTIFACT_MAX_TEXT_RUNS, "presentation text runs");
    totalRuns += runCount;
    if (totalRuns > PRESENTATION_ARTIFACT_MAX_TEXT_RUNS)
      throw new RangeError("presentation text runs exceed their limit");
    const runs: PresentationArtifactTextRun[] = [];
    for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
      const text = readString(reader, PRESENTATION_ARTIFACT_MAX_TEXT_BYTES);
      totalBytes += strictUtf8(text, "presentation text").byteLength;
      if (totalBytes > PRESENTATION_ARTIFACT_MAX_TEXT_BYTES)
        throw new RangeError("presentation text exceeds its byte limit");
      runs.push(Object.freeze({ text, style: readTextStyle(reader) }));
    }
    paragraphs.push(Object.freeze({ runs: Object.freeze(runs), alignment }));
  }
  return Object.freeze({ paragraphs: Object.freeze(paragraphs), verticalAlignment });
}

function writeTextStyle(writer: ArtifactBinaryWriter, style: PresentationArtifactTextStyle): void {
  writeString(writer, style.fontFamily, PRESENTATION_ARTIFACT_MAX_NAME_BYTES);
  writer.u32(style.fontSizeCentipoints);
  writer.u32(style.color);
  writer.bool(style.bold);
  writer.bool(style.italic);
  writer.bool(style.underline);
  writer.bool(style.language !== null);
  if (style.language !== null) writeString(writer, style.language, 128);
}
function readTextStyle(reader: ArtifactBinaryReader): PresentationArtifactTextStyle {
  return Object.freeze({
    fontFamily: readString(reader, PRESENTATION_ARTIFACT_MAX_NAME_BYTES),
    fontSizeCentipoints: reader.u32(),
    color: reader.u32(),
    bold: reader.bool("presentation boolean"),
    italic: reader.bool("presentation boolean"),
    underline: reader.bool("presentation boolean"),
    language: reader.bool("optional presentation language") ? readString(reader, 128) : null,
  });
}

function writeNewNode(writer: ArtifactBinaryWriter, node: PresentationArtifactNewNode): void {
  writeId(writer, node.id);
  writeString(writer, node.name, PRESENTATION_ARTIFACT_MAX_NAME_BYTES);
  writeRect(writer, node.bounds);
  writeTransform(writer, node.transform);
  writeNodeKind(writer, node.content);
}
function readNewNode(reader: ArtifactBinaryReader): PresentationArtifactNewNode {
  return Object.freeze({
    id: readId(reader),
    name: readString(reader, PRESENTATION_ARTIFACT_MAX_NAME_BYTES),
    bounds: readRect(reader),
    transform: readTransform(reader),
    content: readNodeKind(reader),
  });
}

function writeNodeKind(writer: ArtifactBinaryWriter, node: PresentationArtifactNodeKind): void {
  if (node.kind === "shape") {
    writer.u8(0);
    writer.u8(
      (
        {
          "text-box": 0,
          rectangle: 1,
          "rounded-rectangle": 2,
          ellipse: 3,
          triangle: 4,
          "right-arrow": 5,
          line: 6,
        } as const
      )[node.geometry] ?? bad("shape geometry"),
    );
    writeFill(writer, node.fill);
    writeLine(writer, node.line);
    writer.bool(node.text !== null);
    if (node.text !== null) writeRichText(writer, node.text);
    writer.bool(node.placeholder !== null);
    if (node.placeholder !== null) {
      writeString(writer, node.placeholder.kind, PRESENTATION_ARTIFACT_MAX_NAME_BYTES);
      writer.bool(node.placeholder.index !== null);
      if (node.placeholder.index !== null) writer.u32(node.placeholder.index);
    }
    return;
  }
  if (node.kind === "group") {
    writer.u8(1);
    for (const value of [
      node.childOffsetX,
      node.childOffsetY,
      node.childExtentWidth,
      node.childExtentHeight,
    ])
      writer.i64(coordinate(value, "presentation group coordinate"));
    writer.count(
      node.children.length,
      PRESENTATION_ARTIFACT_MAX_GROUP_CHILDREN,
      "presentation group children",
    );
    for (const id of node.children) writeId(writer, id);
    return;
  }
  if (node.kind === "connector") {
    writer.u8(2);
    writer.u8(
      node.connectorKind === "straight"
        ? 0
        : node.connectorKind === "elbow"
          ? 1
          : node.connectorKind === "curved"
            ? 2
            : bad("connector kind"),
    );
    writeEndpoint(writer, node.start);
    writeEndpoint(writer, node.end);
    writeLine(writer, node.line);
    return;
  }
  if (node.kind === "chart") {
    writer.u8(3);
    writer.u8(
      ({ bar: 0, line: 1, area: 2, pie: 3, doughnut: 4, scatter: 5, bubble: 6, radar: 7 } as const)[
        node.chartType
      ] ?? bad("chart type"),
    );
    writeRichText(writer, node.title);
    writer.count(
      node.series.length,
      PRESENTATION_ARTIFACT_MAX_CHART_SERIES,
      "presentation chart series",
    );
    let points = 0;
    for (const series of node.series) {
      writeString(writer, series.name, PRESENTATION_ARTIFACT_MAX_NAME_BYTES);
      points +=
        series.categories.length +
        series.values.length +
        series.xValues.length +
        series.bubbleSizes.length;
      if (points > PRESENTATION_ARTIFACT_MAX_CHART_POINTS)
        throw new RangeError("presentation chart points exceed their limit");
      writeStringVector(writer, series.categories);
      writeNumberVector(writer, series.values);
      writeNumberVector(writer, series.xValues);
      writeNumberVector(writer, series.bubbleSizes);
    }
    writer.bool(node.hasLegend);
    return;
  }
  if (node.kind === "table") {
    writer.u8(4);
    const columns = node.rows[0]?.length ?? 0;
    const cells = node.rows.length * columns;
    if (
      node.rows.length === 0 ||
      columns === 0 ||
      node.rows.length > PRESENTATION_ARTIFACT_MAX_TABLE_ROWS ||
      columns > PRESENTATION_ARTIFACT_MAX_TABLE_COLUMNS ||
      cells > PRESENTATION_ARTIFACT_MAX_TABLE_CELLS ||
      node.rows.some((row) => row.length !== columns)
    )
      throw new RangeError("presentation table dimensions are invalid");
    writer.u32(node.rows.length);
    writer.u32(columns);
    for (const row of node.rows)
      for (const cell of row) {
        writer.bool(cell !== null);
        if (cell !== null) {
          writeRichText(writer, cell.text);
          writeFill(writer, cell.fill);
          writer.u16(cell.rowSpan);
          writer.u16(cell.columnSpan);
        }
      }
    writer.count(
      node.columnWidths.length,
      PRESENTATION_ARTIFACT_MAX_TABLE_COLUMNS,
      "presentation table widths",
    );
    for (const width of node.columnWidths)
      writer.i64(coordinate(width, "presentation table width"));
    writer.count(
      node.rowHeights.length,
      PRESENTATION_ARTIFACT_MAX_TABLE_ROWS,
      "presentation table heights",
    );
    for (const height of node.rowHeights)
      writer.i64(coordinate(height, "presentation table height"));
    writeLine(writer, node.line);
    return;
  }
  if (node.kind === "media") {
    if (!(node.digest instanceof Uint8Array) || node.digest.byteLength !== 32)
      throw new TypeError("presentation media digest must be 32 bytes");
    writer.u8(5);
    writer.bytes(node.digest);
    writeString(writer, node.contentType, 255);
    writeString(writer, node.altText, PRESENTATION_ARTIFACT_MAX_TEXT_BYTES);
    writer.u8(node.fit === "contain" ? 0 : node.fit === "cover" ? 1 : bad("media fit"));
    writer.u32(node.intrinsicWidth);
    writer.u32(node.intrinsicHeight);
    return;
  }
  return bad("presentation node kind");
}

function readNodeKind(reader: ArtifactBinaryReader): PresentationArtifactNodeKind {
  const tag = reader.u8();
  if (tag === 0) {
    const geometryTag = reader.u8();
    const geometries = [
      "text-box",
      "rectangle",
      "rounded-rectangle",
      "ellipse",
      "triangle",
      "right-arrow",
      "line",
    ] as const;
    const geometry = geometries[geometryTag];
    if (!geometry) return bad("shape geometry");
    const fill = readFill(reader);
    const line = readLine(reader);
    const text = reader.bool("optional presentation text") ? readRichText(reader) : null;
    const placeholder = reader.bool("optional presentation placeholder")
      ? Object.freeze({
          kind: readString(reader, PRESENTATION_ARTIFACT_MAX_NAME_BYTES),
          index: reader.bool("optional placeholder index") ? reader.u32() : null,
        })
      : null;
    return Object.freeze({ kind: "shape", geometry, fill, line, text, placeholder });
  }
  if (tag === 1) {
    const childOffsetX = readCoordinate(reader, "presentation group coordinate");
    const childOffsetY = readCoordinate(reader, "presentation group coordinate");
    const childExtentWidth = readCoordinate(reader, "presentation group coordinate");
    const childExtentHeight = readCoordinate(reader, "presentation group coordinate");
    const count = reader.count(
      PRESENTATION_ARTIFACT_MAX_GROUP_CHILDREN,
      "presentation group children",
      16,
    );
    const children: string[] = [];
    for (let index = 0; index < count; index += 1) children.push(readId(reader));
    return Object.freeze({
      kind: "group",
      childOffsetX,
      childOffsetY,
      childExtentWidth,
      childExtentHeight,
      children: Object.freeze(children),
    });
  }
  if (tag === 2) {
    const kindTag = reader.u8();
    return Object.freeze({
      kind: "connector",
      connectorKind:
        kindTag === 0
          ? "straight"
          : kindTag === 1
            ? "elbow"
            : kindTag === 2
              ? "curved"
              : bad("connector kind"),
      start: readEndpoint(reader),
      end: readEndpoint(reader),
      line: readLine(reader),
    });
  }
  if (tag === 3) {
    const chartTag = reader.u8();
    const types = ["bar", "line", "area", "pie", "doughnut", "scatter", "bubble", "radar"] as const;
    const chartType = types[chartTag];
    if (!chartType) return bad("chart type");
    const title = readRichText(reader);
    const count = reader.count(PRESENTATION_ARTIFACT_MAX_CHART_SERIES, "presentation chart series");
    const series: PresentationArtifactChartSeries[] = [];
    let points = 0;
    for (let index = 0; index < count; index += 1) {
      const item = Object.freeze({
        name: readString(reader, PRESENTATION_ARTIFACT_MAX_NAME_BYTES),
        categories: readStringVector(reader),
        values: readNumberVector(reader),
        xValues: readNumberVector(reader),
        bubbleSizes: readNumberVector(reader),
      });
      points +=
        item.categories.length + item.values.length + item.xValues.length + item.bubbleSizes.length;
      if (points > PRESENTATION_ARTIFACT_MAX_CHART_POINTS)
        throw new RangeError("presentation chart points exceed their limit");
      series.push(item);
    }
    return Object.freeze({
      kind: "chart",
      chartType,
      title,
      series: Object.freeze(series),
      hasLegend: reader.bool("presentation boolean"),
    });
  }
  if (tag === 4) {
    const rowCount = reader.count(PRESENTATION_ARTIFACT_MAX_TABLE_ROWS, "presentation table rows");
    const columnCount = reader.count(
      PRESENTATION_ARTIFACT_MAX_TABLE_COLUMNS,
      "presentation table columns",
    );
    const cells = rowCount * columnCount;
    if (rowCount === 0 || columnCount === 0 || cells > PRESENTATION_ARTIFACT_MAX_TABLE_CELLS)
      throw new RangeError("presentation table dimensions are invalid");
    const rows: (readonly (PresentationArtifactTableCell | null)[])[] = [];
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const row: (PresentationArtifactTableCell | null)[] = [];
      for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1)
        row.push(
          reader.bool("optional table cell")
            ? Object.freeze({
                text: readRichText(reader),
                fill: readFill(reader),
                rowSpan: reader.u16(),
                columnSpan: reader.u16(),
              })
            : null,
        );
      rows.push(Object.freeze(row));
    }
    const widthCount = reader.count(
      PRESENTATION_ARTIFACT_MAX_TABLE_COLUMNS,
      "presentation table widths",
      8,
    );
    const columnWidths: number[] = [];
    for (let index = 0; index < widthCount; index += 1)
      columnWidths.push(readCoordinate(reader, "presentation table width"));
    const heightCount = reader.count(
      PRESENTATION_ARTIFACT_MAX_TABLE_ROWS,
      "presentation table heights",
      8,
    );
    const rowHeights: number[] = [];
    for (let index = 0; index < heightCount; index += 1)
      rowHeights.push(readCoordinate(reader, "presentation table height"));
    return Object.freeze({
      kind: "table",
      rows: Object.freeze(rows),
      columnWidths: Object.freeze(columnWidths),
      rowHeights: Object.freeze(rowHeights),
      line: readLine(reader),
    });
  }
  if (tag === 5) {
    const digest = reader.bytes(32).slice();
    const contentType = readString(reader, 255);
    const altText = readString(reader, PRESENTATION_ARTIFACT_MAX_TEXT_BYTES);
    const fitTag = reader.u8();
    return Object.freeze({
      kind: "media",
      digest,
      contentType,
      altText,
      fit: fitTag === 0 ? "contain" : fitTag === 1 ? "cover" : bad("media fit"),
      intrinsicWidth: reader.u32(),
      intrinsicHeight: reader.u32(),
    });
  }
  return bad("presentation node kind");
}

function writeEndpoint(
  writer: ArtifactBinaryWriter,
  endpoint: PresentationArtifactConnectorEndpoint,
): void {
  writeOptionalId(writer, endpoint.nodeId);
  writer.i64(coordinate(endpoint.x, "connector x"));
  writer.i64(coordinate(endpoint.y, "connector y"));
}
function readEndpoint(reader: ArtifactBinaryReader): PresentationArtifactConnectorEndpoint {
  return Object.freeze({
    nodeId: readOptionalId(reader),
    x: readCoordinate(reader, "connector x"),
    y: readCoordinate(reader, "connector y"),
  });
}
function writeStringVector(writer: ArtifactBinaryWriter, values: readonly string[]): void {
  writer.count(values.length, PRESENTATION_ARTIFACT_MAX_CHART_POINTS, "presentation chart points");
  for (const value of values) writeString(writer, value, PRESENTATION_ARTIFACT_MAX_NAME_BYTES);
}
function readStringVector(reader: ArtifactBinaryReader): readonly string[] {
  const count = reader.count(PRESENTATION_ARTIFACT_MAX_CHART_POINTS, "presentation chart points");
  const values: string[] = [];
  for (let index = 0; index < count; index += 1)
    values.push(readString(reader, PRESENTATION_ARTIFACT_MAX_NAME_BYTES));
  return Object.freeze(values);
}
function writeNumberVector(writer: ArtifactBinaryWriter, values: readonly number[]): void {
  writer.count(values.length, PRESENTATION_ARTIFACT_MAX_CHART_POINTS, "presentation chart points");
  for (const value of values) writer.f64(value, "presentation chart value");
}
function readNumberVector(reader: ArtifactBinaryReader): readonly number[] {
  const count = reader.count(
    PRESENTATION_ARTIFACT_MAX_CHART_POINTS,
    "presentation chart points",
    8,
  );
  const values: number[] = [];
  for (let index = 0; index < count; index += 1)
    values.push(reader.f64("presentation chart value"));
  return Object.freeze(values);
}
function coordinate(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || Math.abs(value) > PRESENTATION_ARTIFACT_MAX_COORDINATE)
    throw new RangeError(`${label} exceeds its bound`);
  return value;
}
function readCoordinate(reader: ArtifactBinaryReader, label: string): number {
  return coordinate(reader.i64Safe(label), label);
}

export type PresentationArtifactQuery =
  | Readonly<{
      kind: "viewport";
      owner: PresentationArtifactOwner;
      viewport: PresentationArtifactRect;
      maxNodes: number;
      maxBytes: number;
    }>
  | Readonly<{
      kind: "hit-test";
      owner: PresentationArtifactOwner;
      x: number;
      y: number;
      maxNodes: number;
      maxBytes: number;
    }>
  | Readonly<{
      kind: "resolved-slide";
      slideId: PresentationArtifactStableId;
      maxNodes: number;
      maxBytes: number;
    }>
  | Readonly<{ kind: "metadata"; maxBytes: number }>
  | Readonly<{
      kind: "slide-catalog";
      startSlide: number;
      maxSlides: number;
      maxTextBytes: number;
      maxBytes: number;
    }>
  | Readonly<{
      kind: "editor-slide";
      slideId: PresentationArtifactStableId;
      maxNodes: number;
      maxTextBytes: number;
      maxBytes: number;
    }>;

export function encodePresentationArtifactQuery(query: PresentationArtifactQuery): Uint8Array {
  const payload = new ArtifactBinaryWriter(PRESENTATION_ARTIFACT_QUERY_MAX_BYTES);
  let tag: number;
  let maxItems = 0;
  if (query.kind === "viewport") {
    tag = 0;
    maxItems = query.maxNodes;
    validateQueryLimits(maxItems, query.maxBytes, 49);
    writeOwner(payload, query.owner);
    writeRect(payload, query.viewport);
  } else if (query.kind === "hit-test") {
    tag = 1;
    maxItems = query.maxNodes;
    validateQueryLimits(maxItems, query.maxBytes, 49);
    writeOwner(payload, query.owner);
    payload.i64(coordinate(query.x, "presentation hit-test x"));
    payload.i64(coordinate(query.y, "presentation hit-test y"));
  } else if (query.kind === "resolved-slide") {
    tag = 2;
    maxItems = query.maxNodes;
    validateQueryLimits(maxItems, query.maxBytes, 16);
    writeId(payload, query.slideId);
  } else if (query.kind === "metadata") {
    tag = 3;
    validateResponseBytes(query.maxBytes, 44);
  } else if (query.kind === "slide-catalog") {
    tag = 4;
    maxItems = query.maxSlides;
    validateCatalogQueryLimits(maxItems, query.maxTextBytes, query.maxBytes);
    validateResponseBytes(query.maxBytes, 13);
    payload.u32(query.startSlide);
    payload.u32(query.maxTextBytes);
  } else if (query.kind === "editor-slide") {
    tag = 5;
    maxItems = query.maxNodes;
    validateQueryLimits(maxItems, query.maxBytes, 35);
    validateQueryTextBytes(query.maxTextBytes);
    writeId(payload, query.slideId);
    payload.u32(query.maxTextBytes);
  } else return bad("presentation query kind");
  const maxBytes = query.maxBytes;
  const writer = new ArtifactBinaryWriter(PRESENTATION_ARTIFACT_QUERY_MAX_BYTES);
  writer.bytes(QUERY_MAGIC);
  writer.u16(1);
  writer.u16(0);
  writer.u8(tag);
  writer.bytes(new Uint8Array(3));
  writer.u32(maxItems);
  writer.u32(maxBytes);
  writer.u32(payload.length);
  writer.bytes(payload.finish());
  writer.u64(fnv1a64(writer.view()));
  return writer.finish();
}

export function decodePresentationArtifactQuery(bytes: Uint8Array): PresentationArtifactQuery {
  const envelope = decodePresentationQueryEnvelope(bytes);
  const reader = new ArtifactBinaryReader(envelope.payload);
  let query: PresentationArtifactQuery;
  if (envelope.tag === 0) {
    validateQueryLimits(envelope.maxItems, envelope.maxBytes, 49);
    query = Object.freeze({
      kind: "viewport",
      owner: readOwner(reader),
      viewport: readRect(reader),
      maxNodes: envelope.maxItems,
      maxBytes: envelope.maxBytes,
    });
  } else if (envelope.tag === 1) {
    validateQueryLimits(envelope.maxItems, envelope.maxBytes, 49);
    query = Object.freeze({
      kind: "hit-test",
      owner: readOwner(reader),
      x: readCoordinate(reader, "presentation hit-test x"),
      y: readCoordinate(reader, "presentation hit-test y"),
      maxNodes: envelope.maxItems,
      maxBytes: envelope.maxBytes,
    });
  } else if (envelope.tag === 2) {
    validateQueryLimits(envelope.maxItems, envelope.maxBytes, 16);
    query = Object.freeze({
      kind: "resolved-slide",
      slideId: readId(reader),
      maxNodes: envelope.maxItems,
      maxBytes: envelope.maxBytes,
    });
  } else if (envelope.tag === 3) {
    if (envelope.maxItems !== 0)
      throw new TypeError("presentation metadata max items must be zero");
    validateResponseBytes(envelope.maxBytes, 44);
    query = Object.freeze({ kind: "metadata", maxBytes: envelope.maxBytes });
  } else if (envelope.tag === 4) {
    const startSlide = reader.u32();
    const maxTextBytes = reader.u32();
    validateCatalogQueryLimits(envelope.maxItems, maxTextBytes, envelope.maxBytes);
    validateResponseBytes(envelope.maxBytes, 13);
    query = Object.freeze({
      kind: "slide-catalog",
      startSlide,
      maxSlides: envelope.maxItems,
      maxTextBytes,
      maxBytes: envelope.maxBytes,
    });
  } else {
    validateQueryLimits(envelope.maxItems, envelope.maxBytes, 35);
    const slideId = readId(reader);
    const maxTextBytes = reader.u32();
    validateQueryTextBytes(maxTextBytes);
    query = Object.freeze({
      kind: "editor-slide",
      slideId,
      maxNodes: envelope.maxItems,
      maxTextBytes,
      maxBytes: envelope.maxBytes,
    });
  }
  reader.done("presentation query contains trailing bytes");
  return query;
}

export function assertCanonicalPresentationArtifactQueryBytes(bytes: Uint8Array): void {
  if (!equalBytes(bytes, encodePresentationArtifactQuery(decodePresentationArtifactQuery(bytes))))
    throw new TypeError("presentation query is not canonically encoded");
}

function decodePresentationQueryEnvelope(bytes: Uint8Array): {
  tag: number;
  maxItems: number;
  maxBytes: number;
  payload: Uint8Array;
} {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length > PRESENTATION_ARTIFACT_QUERY_MAX_BYTES ||
    bytes.length < QUERY_HEADER_BYTES + CHECKSUM_BYTES
  )
    throw new TypeError("invalid presentation query envelope");
  const reader = new ArtifactBinaryReader(bytes);
  if (!equalBytes(reader.bytes(8), QUERY_MAGIC))
    throw new TypeError("invalid presentation query magic");
  if (reader.u16() !== 1) throw new TypeError("unsupported presentation query version");
  if (reader.u16() !== 0) throw new TypeError("reserved presentation query flags must be zero");
  const tag = reader.u8();
  if (tag > 5) throw new TypeError("invalid presentation query tag");
  if (!reader.bytes(3).every((value) => value === 0))
    throw new TypeError("reserved presentation query bytes must be zero");
  const maxItems = reader.u32();
  const maxBytes = reader.u32();
  const payloadLength = reader.u32();
  const expected = QUERY_HEADER_BYTES + payloadLength + CHECKSUM_BYTES;
  if (bytes.length !== expected)
    throw new TypeError(
      bytes.length < expected
        ? "truncated presentation query"
        : "presentation query contains trailing bytes",
    );
  const payload = reader.bytes(payloadLength);
  const checksum = reader.u64BigInt();
  if (checksum !== fnv1a64(bytes.subarray(0, -8)))
    throw new TypeError("presentation query checksum does not match");
  return { tag, maxItems, maxBytes, payload };
}

export type PresentationArtifactProjectedNode = Readonly<{
  id: string;
  owner: PresentationArtifactOwner;
  parentId: string | null;
  nodeKind: PresentationArtifactNodeKind["kind"];
  bounds: PresentationArtifactRect;
  paintOrder: number;
}>;
export type PresentationArtifactResolvedNode = Readonly<{
  id: string;
  source: PresentationArtifactOwner;
  inherited: boolean;
}>;
export type PresentationArtifactSlideLayoutFacts = Readonly<{
  id: PresentationArtifactStableId;
  name: string;
  masterId: PresentationArtifactStableId | null;
  background: PresentationArtifactFill;
}>;
export type PresentationArtifactSlideCatalogItem = Readonly<{
  index: number;
  id: PresentationArtifactStableId;
  title: string;
  background: PresentationArtifactFill;
  layout: PresentationArtifactSlideLayoutFacts | null;
}>;
export type PresentationArtifactEditorSceneNode = Readonly<{
  id: PresentationArtifactStableId;
  source: PresentationArtifactOwner;
  inherited: boolean;
  parentId: PresentationArtifactStableId | null;
  order: number;
  name: string;
  bounds: PresentationArtifactRect;
  transform: PresentationArtifactTransform;
  content: PresentationArtifactNodeKind;
}>;
export type PresentationArtifactQueryResponse =
  | Readonly<{
      kind: "viewport";
      revision: bigint;
      owner: PresentationArtifactOwner;
      viewport: PresentationArtifactRect;
      nodes: readonly PresentationArtifactProjectedNode[];
      truncated: boolean;
    }>
  | Readonly<{
      kind: "hit-test";
      revision: bigint;
      owner: PresentationArtifactOwner;
      viewport: PresentationArtifactRect;
      nodes: readonly PresentationArtifactProjectedNode[];
      truncated: boolean;
    }>
  | Readonly<{
      kind: "resolved-slide";
      revision: bigint;
      slideId: string;
      nodes: readonly PresentationArtifactResolvedNode[];
      truncated: boolean;
    }>
  | Readonly<{
      kind: "metadata";
      revision: bigint;
      presentationId: string;
      slideSize: Readonly<{ width: number; height: number }>;
      masters: number;
      layouts: number;
      slides: number;
    }>
  | Readonly<{
      kind: "slide-catalog";
      revision: bigint;
      startSlide: number;
      nextSlide: number | null;
      projectedTextBytes: number;
      slides: readonly PresentationArtifactSlideCatalogItem[];
      truncated: boolean;
    }>
  | Readonly<{
      kind: "editor-slide";
      revision: bigint;
      slide: PresentationArtifactSlideCatalogItem;
      notes: PresentationArtifactRichText | null;
      projectedTextBytes: number;
      nodes: readonly PresentationArtifactEditorSceneNode[];
      truncated: boolean;
    }>;
export type PresentationArtifactSlideCatalogResponse = Extract<
  PresentationArtifactQueryResponse,
  { kind: "slide-catalog" }
>;
export type PresentationArtifactEditorSlideResponse = Extract<
  PresentationArtifactQueryResponse,
  { kind: "editor-slide" }
>;

export function encodePresentationArtifactQueryResponse(
  response: PresentationArtifactQueryResponse,
  maximumBytes = PRESENTATION_ARTIFACT_QUERY_RESPONSE_MAX_BYTES,
): Uint8Array {
  validateResponseBytes(maximumBytes, 0);
  const payload = new ArtifactBinaryWriter(maximumBytes - RESPONSE_HEADER_BYTES - CHECKSUM_BYTES);
  let tag: number;
  let itemCount: number;
  let truncated = false;
  if (response.kind === "viewport" || response.kind === "hit-test") {
    tag = response.kind === "viewport" ? 0 : 1;
    itemCount = response.nodes.length;
    truncated = response.truncated;
    validateProjectedResponse(response);
    writeOwner(payload, response.owner);
    writeRect(payload, response.viewport);
    for (const node of response.nodes) {
      writeId(payload, node.id);
      writeOwner(payload, node.owner);
      writeOptionalId(payload, node.parentId);
      payload.u8(nodeKindTag(node.nodeKind));
      writeRect(payload, node.bounds);
      payload.u32(node.paintOrder);
    }
  } else if (response.kind === "resolved-slide") {
    tag = 2;
    itemCount = response.nodes.length;
    truncated = response.truncated;
    validateResolvedResponse(response);
    writeId(payload, response.slideId);
    for (const node of response.nodes) {
      writeId(payload, node.id);
      writeOwner(payload, node.source);
      payload.bool(node.inherited);
    }
  } else if (response.kind === "metadata") {
    tag = 3;
    itemCount = 1;
    assertAllocatedId(response.presentationId, "presentation metadata id");
    if (response.slideSize.width <= 0 || response.slideSize.height <= 0)
      throw new TypeError("invalid presentation slide size");
    writeId(payload, response.presentationId);
    payload.i64(coordinate(response.slideSize.width, "presentation slide width"));
    payload.i64(coordinate(response.slideSize.height, "presentation slide height"));
    payload.u32(response.masters);
    payload.u32(response.layouts);
    payload.u32(response.slides);
  } else if (response.kind === "slide-catalog") {
    tag = 4;
    itemCount = response.slides.length;
    truncated = response.truncated;
    validateSlideCatalogResponse(response);
    payload.u32(response.startSlide);
    payload.bool(response.nextSlide !== null);
    if (response.nextSlide !== null) payload.u32(response.nextSlide);
    payload.u32(response.projectedTextBytes);
    for (const slide of response.slides) writeSlideCatalogItem(payload, slide);
  } else if (response.kind === "editor-slide") {
    tag = 5;
    itemCount = response.nodes.length;
    truncated = response.truncated;
    validateEditorSlideResponse(response);
    writeSlideCatalogItem(payload, response.slide);
    payload.bool(response.notes !== null);
    if (response.notes !== null) writeRichText(payload, response.notes);
    payload.u32(response.projectedTextBytes);
    for (const node of response.nodes) writeEditorSceneNode(payload, node);
  } else return bad("presentation response kind");
  const writer = new ArtifactBinaryWriter(maximumBytes);
  writer.bytes(RESPONSE_MAGIC);
  writer.u16(1);
  writer.u16(truncated ? 1 : 0);
  writer.u8(tag);
  writer.bytes(new Uint8Array(3));
  writer.u64(response.revision);
  writer.u32(itemCount);
  writer.u32(payload.length);
  writer.bytes(payload.finish());
  writer.u64(fnv1a64(writer.view()));
  return writer.finish();
}

export function decodePresentationArtifactQueryResponse(
  bytes: Uint8Array,
): PresentationArtifactQueryResponse {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length > PRESENTATION_ARTIFACT_QUERY_RESPONSE_MAX_BYTES ||
    bytes.length < RESPONSE_HEADER_BYTES + CHECKSUM_BYTES
  )
    throw new TypeError("invalid presentation response envelope");
  const header = new ArtifactBinaryReader(bytes);
  if (!equalBytes(header.bytes(8), RESPONSE_MAGIC))
    throw new TypeError("invalid presentation response magic");
  if (header.u16() !== 1) throw new TypeError("unsupported presentation response version");
  const flags = header.u16();
  if ((flags & ~1) !== 0) throw new TypeError("reserved presentation response flags are set");
  const tag = header.u8();
  if (tag > 5) throw new TypeError("invalid presentation response tag");
  if (!header.bytes(3).every((value) => value === 0))
    throw new TypeError("reserved presentation response bytes are set");
  const revision = header.u64BigInt();
  const itemCount = header.u32();
  const payloadLength = header.u32();
  const expected = RESPONSE_HEADER_BYTES + payloadLength + CHECKSUM_BYTES;
  if (bytes.length !== expected)
    throw new TypeError(
      bytes.length < expected
        ? "truncated presentation response"
        : "presentation response contains trailing bytes",
    );
  const reader = new ArtifactBinaryReader(header.bytes(payloadLength));
  const checksum = header.u64BigInt();
  if (checksum !== fnv1a64(bytes.subarray(0, -8)))
    throw new TypeError("presentation response checksum does not match");
  const truncated = (flags & 1) !== 0;
  let response: PresentationArtifactQueryResponse;
  if (tag === 0 || tag === 1) {
    if (itemCount > PRESENTATION_ARTIFACT_QUERY_MAX_NODES)
      throw new RangeError("presentation response has too many nodes");
    const owner = readOwner(reader);
    assertAllocatedId(owner.id, "presentation response owner");
    const viewport = readRect(reader);
    const nodes: PresentationArtifactProjectedNode[] = [];
    const ids = new Set<string>();
    let previous: number | null = null;
    for (let index = 0; index < itemCount; index += 1) {
      const id = readId(reader);
      const nodeOwner = readOwner(reader);
      const parentId = readOptionalId(reader);
      const kindTag = reader.u8();
      const nodeKind = readNodeKindTag(kindTag);
      const bounds = readRect(reader);
      const paintOrder = reader.u32();
      assertAllocatedId(id, "presentation response node");
      if (
        nodeOwner.kind !== owner.kind ||
        nodeOwner.id !== owner.id ||
        ids.has(id) ||
        parentId === id ||
        (parentId !== null && !isAllocatedId(parentId)) ||
        (previous !== null && (tag === 0 ? paintOrder <= previous : paintOrder >= previous))
      )
        throw new TypeError("invalid presentation projection node");
      ids.add(id);
      previous = paintOrder;
      nodes.push(Object.freeze({ id, owner: nodeOwner, parentId, nodeKind, bounds, paintOrder }));
    }
    response = Object.freeze({
      kind: tag === 0 ? "viewport" : "hit-test",
      revision,
      owner,
      viewport,
      nodes: Object.freeze(nodes),
      truncated,
    });
  } else if (tag === 2) {
    if (itemCount > PRESENTATION_ARTIFACT_QUERY_MAX_NODES)
      throw new RangeError("presentation response has too many nodes");
    const slideId = readId(reader);
    assertAllocatedId(slideId, "resolved presentation slide");
    const ids = new Set<string>();
    const nodes: PresentationArtifactResolvedNode[] = [];
    for (let index = 0; index < itemCount; index += 1) {
      const id = readId(reader);
      const source = readOwner(reader);
      const inherited = reader.bool("presentation inherited flag");
      assertAllocatedId(id, "resolved presentation node");
      assertAllocatedId(source.id, "resolved presentation owner");
      if (
        ids.has(id) ||
        (source.kind === "slide" && source.id !== slideId) ||
        inherited !== !(source.kind === "slide" && source.id === slideId)
      )
        throw new TypeError("invalid resolved presentation node");
      ids.add(id);
      nodes.push(Object.freeze({ id, source, inherited }));
    }
    response = Object.freeze({
      kind: "resolved-slide",
      revision,
      slideId,
      nodes: Object.freeze(nodes),
      truncated,
    });
  } else if (tag === 3) {
    if (itemCount !== 1 || truncated) throw new TypeError("invalid presentation metadata response");
    const presentationId = readId(reader);
    assertAllocatedId(presentationId, "presentation metadata id");
    const width = readCoordinate(reader, "presentation slide width");
    const height = readCoordinate(reader, "presentation slide height");
    if (width <= 0 || height <= 0) throw new TypeError("invalid presentation slide size");
    response = Object.freeze({
      kind: "metadata",
      revision,
      presentationId,
      slideSize: Object.freeze({ width, height }),
      masters: reader.u32(),
      layouts: reader.u32(),
      slides: reader.u32(),
    });
  } else if (tag === 4) {
    if (itemCount > PRESENTATION_ARTIFACT_QUERY_MAX_SLIDES)
      throw new RangeError("presentation slide catalog has too many slides");
    const startSlide = reader.u32();
    const nextSlide = reader.bool("optional next presentation slide") ? reader.u32() : null;
    const projectedTextBytes = reader.u32();
    validateProjectedTextBytes(projectedTextBytes);
    const slides: PresentationArtifactSlideCatalogItem[] = [];
    const ids = new Set<string>();
    for (let offset = 0; offset < itemCount; offset += 1) {
      const slide = readSlideCatalogItem(reader);
      if (slide.index !== startSlide + offset || ids.has(slide.id))
        throw new TypeError("invalid presentation slide catalog order");
      ids.add(slide.id);
      slides.push(slide);
    }
    const expectedNext = startSlide + itemCount;
    if (
      expectedNext > 0xffff_ffff ||
      truncated !== (nextSlide !== null) ||
      (nextSlide !== null && nextSlide !== expectedNext)
    )
      throw new TypeError("invalid presentation slide catalog boundary");
    response = Object.freeze({
      kind: "slide-catalog",
      revision,
      startSlide,
      nextSlide,
      projectedTextBytes,
      slides: Object.freeze(slides),
      truncated,
    });
    validateSlideCatalogResponse(response);
  } else {
    if (itemCount > PRESENTATION_ARTIFACT_QUERY_MAX_NODES)
      throw new RangeError("presentation editor scene has too many nodes");
    const slide = readSlideCatalogItem(reader);
    const notes = reader.bool("optional presentation notes") ? readRichText(reader) : null;
    if (notes === null && !truncated)
      throw new TypeError("omitted presentation notes require truncation");
    const projectedTextBytes = reader.u32();
    validateProjectedTextBytes(projectedTextBytes);
    const nodes: PresentationArtifactEditorSceneNode[] = [];
    for (let index = 0; index < itemCount; index += 1) nodes.push(readEditorSceneNode(reader));
    response = Object.freeze({
      kind: "editor-slide",
      revision,
      slide,
      notes,
      projectedTextBytes,
      nodes: Object.freeze(nodes),
      truncated,
    });
    validateEditorSlideResponse(response);
  }
  reader.done("presentation response contains trailing bytes");
  return response;
}

export function assertCanonicalPresentationArtifactQueryResponseBytes(bytes: Uint8Array): void {
  const response = decodePresentationArtifactQueryResponse(bytes);
  if (!equalBytes(bytes, encodePresentationArtifactQueryResponse(response, bytes.length)))
    throw new TypeError("presentation response is not canonically encoded");
}

function validateQueryLimits(maxNodes: number, maxBytes: number, mandatory: number): void {
  if (
    !Number.isInteger(maxNodes) ||
    maxNodes < 1 ||
    maxNodes > PRESENTATION_ARTIFACT_QUERY_MAX_NODES
  )
    throw new RangeError("presentation query node limit is invalid");
  validateResponseBytes(maxBytes, mandatory);
}
function validateResponseBytes(maxBytes: number, mandatory: number): void {
  const minimum = RESPONSE_HEADER_BYTES + CHECKSUM_BYTES + mandatory;
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < minimum ||
    maxBytes > PRESENTATION_ARTIFACT_QUERY_RESPONSE_MAX_BYTES
  )
    throw new RangeError("presentation response byte limit is invalid");
}
function validateCatalogQueryLimits(
  maxSlides: number,
  maxTextBytes: number,
  maxBytes: number,
): void {
  if (
    !Number.isInteger(maxSlides) ||
    maxSlides < 1 ||
    maxSlides > PRESENTATION_ARTIFACT_QUERY_MAX_SLIDES
  )
    throw new RangeError("presentation slide catalog limit is invalid");
  validateQueryTextBytes(maxTextBytes);
  validateResponseBytes(maxBytes, 13);
}
function validateQueryTextBytes(maxTextBytes: number): void {
  if (
    !Number.isInteger(maxTextBytes) ||
    maxTextBytes < 1 ||
    maxTextBytes > PRESENTATION_ARTIFACT_QUERY_MAX_TEXT_BYTES
  )
    throw new RangeError("presentation query text limit is invalid");
}
function validateProjectedTextBytes(projectedTextBytes: number): void {
  if (
    !Number.isInteger(projectedTextBytes) ||
    projectedTextBytes < 0 ||
    projectedTextBytes > PRESENTATION_ARTIFACT_QUERY_MAX_TEXT_BYTES
  )
    throw new RangeError("presentation projected text limit is invalid");
}
function writeSlideCatalogItem(
  writer: ArtifactBinaryWriter,
  item: PresentationArtifactSlideCatalogItem,
): void {
  validateSlideCatalogItem(item);
  writer.u32(item.index);
  writeId(writer, item.id);
  writeString(writer, item.title, PRESENTATION_ARTIFACT_MAX_NAME_BYTES);
  writeFill(writer, item.background);
  writer.bool(item.layout !== null);
  if (item.layout !== null) {
    writeId(writer, item.layout.id);
    writeString(writer, item.layout.name, PRESENTATION_ARTIFACT_MAX_NAME_BYTES);
    writeOptionalId(writer, item.layout.masterId);
    writeFill(writer, item.layout.background);
  }
}
function readSlideCatalogItem(reader: ArtifactBinaryReader): PresentationArtifactSlideCatalogItem {
  const index = reader.u32();
  const id = readId(reader);
  const title = readString(reader, PRESENTATION_ARTIFACT_MAX_NAME_BYTES);
  const background = readFill(reader);
  const layout = reader.bool("optional presentation layout")
    ? Object.freeze({
        id: readId(reader),
        name: readString(reader, PRESENTATION_ARTIFACT_MAX_NAME_BYTES),
        masterId: readOptionalId(reader),
        background: readFill(reader),
      })
    : null;
  const item = Object.freeze({ index, id, title, background, layout });
  validateSlideCatalogItem(item);
  return item;
}
function validateSlideCatalogItem(item: PresentationArtifactSlideCatalogItem): void {
  assertAllocatedId(item.id, "presentation slide catalog id");
  if (item.layout !== null) {
    assertAllocatedId(item.layout.id, "presentation slide layout id");
    if (item.layout.masterId !== null)
      assertAllocatedId(item.layout.masterId, "presentation slide master id");
  }
}
function writeEditorSceneNode(
  writer: ArtifactBinaryWriter,
  node: PresentationArtifactEditorSceneNode,
): void {
  writeId(writer, node.id);
  writeOwner(writer, node.source);
  writer.bool(node.inherited);
  writeOptionalId(writer, node.parentId);
  writer.u32(node.order);
  writeString(writer, node.name, PRESENTATION_ARTIFACT_MAX_NAME_BYTES);
  writeRect(writer, node.bounds);
  writeTransform(writer, node.transform);
  writeNodeKind(writer, node.content);
}
function readEditorSceneNode(reader: ArtifactBinaryReader): PresentationArtifactEditorSceneNode {
  return Object.freeze({
    id: readId(reader),
    source: readOwner(reader),
    inherited: reader.bool("presentation inherited flag"),
    parentId: readOptionalId(reader),
    order: reader.u32(),
    name: readString(reader, PRESENTATION_ARTIFACT_MAX_NAME_BYTES),
    bounds: readRect(reader),
    transform: readTransform(reader),
    content: readNodeKind(reader),
  });
}
function validateSlideCatalogResponse(
  response: Extract<PresentationArtifactQueryResponse, { kind: "slide-catalog" }>,
): void {
  if (response.slides.length > PRESENTATION_ARTIFACT_QUERY_MAX_SLIDES)
    throw new RangeError("presentation slide catalog has too many slides");
  validateProjectedTextBytes(response.projectedTextBytes);
  const ids = new Set<string>();
  let measured = 0;
  for (let offset = 0; offset < response.slides.length; offset += 1) {
    const slide = response.slides[offset]!;
    validateSlideCatalogItem(slide);
    if (slide.index !== response.startSlide + offset || ids.has(slide.id))
      throw new TypeError("invalid presentation slide catalog order");
    ids.add(slide.id);
    measured = addProjectedText(measured, slideCatalogItemTextBytes(slide));
  }
  const expectedNext = response.startSlide + response.slides.length;
  if (
    !Number.isInteger(response.startSlide) ||
    response.startSlide < 0 ||
    expectedNext > 0xffff_ffff ||
    response.truncated !== (response.nextSlide !== null) ||
    (response.nextSlide !== null && response.nextSlide !== expectedNext) ||
    (response.nextSlide !== null && response.slides.length === 0) ||
    measured !== response.projectedTextBytes
  )
    throw new TypeError("invalid presentation slide catalog boundary");
}
function validateEditorSlideResponse(
  response: Extract<PresentationArtifactQueryResponse, { kind: "editor-slide" }>,
): void {
  if (response.nodes.length > PRESENTATION_ARTIFACT_QUERY_MAX_NODES)
    throw new RangeError("presentation editor scene has too many nodes");
  if (response.notes === null && !response.truncated)
    throw new TypeError("omitted presentation notes require truncation");
  validateSlideCatalogItem(response.slide);
  validateProjectedTextBytes(response.projectedTextBytes);
  let measured = slideCatalogItemTextBytes(response.slide);
  if (response.notes !== null)
    measured = addProjectedText(measured, richTextProjectionBytes(response.notes));
  const ids = new Set<string>();
  const sources = new Map<string, string>();
  const positions = new Set<string>();
  for (const node of response.nodes) {
    assertAllocatedId(node.id, "presentation editor node id");
    assertAllocatedId(node.source.id, "presentation editor node owner");
    const sourceKey = `${node.source.kind}:${node.source.id}`;
    const expectedInherited = !(
      node.source.kind === "slide" && node.source.id === response.slide.id
    );
    const position = `${sourceKey}:${node.parentId ?? "root"}:${node.order}`;
    if (
      ids.has(node.id) ||
      (node.source.kind === "slide" && node.source.id !== response.slide.id) ||
      node.inherited !== expectedInherited ||
      node.parentId === node.id ||
      (node.parentId !== null &&
        (!isAllocatedId(node.parentId) || sources.get(node.parentId) !== sourceKey)) ||
      positions.has(position)
    )
      throw new TypeError("invalid presentation editor scene node");
    validateEditorNodeReferences(node);
    ids.add(node.id);
    sources.set(node.id, sourceKey);
    positions.add(position);
    measured = addProjectedText(measured, editorSceneNodeTextBytes(node));
  }
  if (measured !== response.projectedTextBytes)
    throw new TypeError("presentation editor projected text mismatch");
}
function validateEditorNodeReferences(node: PresentationArtifactEditorSceneNode): void {
  if (node.content.kind === "group") {
    const children = new Set<string>();
    for (const id of node.content.children) {
      if (!isAllocatedId(id) || id === node.id || children.has(id))
        throw new TypeError("invalid presentation editor group children");
      children.add(id);
    }
  } else if (node.content.kind === "connector") {
    for (const endpoint of [node.content.start, node.content.end])
      if (
        endpoint.nodeId !== null &&
        (!isAllocatedId(endpoint.nodeId) || endpoint.nodeId === node.id)
      )
        throw new TypeError("invalid presentation editor connector endpoint");
  }
}
function slideCatalogItemTextBytes(item: PresentationArtifactSlideCatalogItem): number {
  let total = textProjectionBytes(item.title);
  if (item.layout !== null) total = addProjectedText(total, textProjectionBytes(item.layout.name));
  return total;
}
function editorSceneNodeTextBytes(node: PresentationArtifactEditorSceneNode): number {
  return addProjectedText(textProjectionBytes(node.name), nodeKindProjectionBytes(node.content));
}
function nodeKindProjectionBytes(content: PresentationArtifactNodeKind): number {
  if (content.kind === "shape") {
    let total = content.text === null ? 0 : richTextProjectionBytes(content.text);
    if (content.placeholder !== null)
      total = addProjectedText(total, textProjectionBytes(content.placeholder.kind));
    return total;
  }
  if (content.kind === "group" || content.kind === "connector") return 0;
  if (content.kind === "chart") {
    let total = richTextProjectionBytes(content.title);
    for (const series of content.series) {
      total = addProjectedText(total, textProjectionBytes(series.name));
      for (const category of series.categories)
        total = addProjectedText(total, textProjectionBytes(category));
    }
    return total;
  }
  if (content.kind === "table") {
    let total = 0;
    for (const row of content.rows)
      for (const cell of row)
        if (cell !== null) total = addProjectedText(total, richTextProjectionBytes(cell.text));
    return total;
  }
  return addProjectedText(
    textProjectionBytes(content.contentType),
    textProjectionBytes(content.altText),
  );
}
function richTextProjectionBytes(text: PresentationArtifactRichText): number {
  let total = 0;
  for (const paragraph of text.paragraphs)
    for (const run of paragraph.runs) {
      total = addProjectedText(total, textProjectionBytes(run.text));
      total = addProjectedText(total, textProjectionBytes(run.style.fontFamily));
      if (run.style.language !== null)
        total = addProjectedText(total, textProjectionBytes(run.style.language));
    }
  return total;
}
function textProjectionBytes(value: string): number {
  return strictUtf8(value, "presentation projected text").byteLength;
}
function addProjectedText(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new RangeError("presentation projected text is invalid");
  return total;
}
function nodeKindTag(kind: PresentationArtifactNodeKind["kind"]): number {
  return kind === "shape"
    ? 0
    : kind === "group"
      ? 1
      : kind === "connector"
        ? 2
        : kind === "chart"
          ? 3
          : kind === "table"
            ? 4
            : kind === "media"
              ? 5
              : bad("presentation node kind");
}
function readNodeKindTag(tag: number): PresentationArtifactNodeKind["kind"] {
  return tag === 0
    ? "shape"
    : tag === 1
      ? "group"
      : tag === 2
        ? "connector"
        : tag === 3
          ? "chart"
          : tag === 4
            ? "table"
            : tag === 5
              ? "media"
              : bad("presentation node kind");
}
function isAllocatedId(id: string): boolean {
  return (
    /^[0-9a-f]{32}$/u.test(id) &&
    id.slice(0, 16) !== "0000000000000000" &&
    id.slice(16) !== "0000000000000000"
  );
}
function assertAllocatedId(id: string, label: string): void {
  if (!isAllocatedId(id)) throw new TypeError(`${label} is invalid`);
}
function validateProjectedResponse(
  response: Extract<PresentationArtifactQueryResponse, { kind: "viewport" | "hit-test" }>,
): void {
  if (response.nodes.length > PRESENTATION_ARTIFACT_QUERY_MAX_NODES)
    throw new RangeError("presentation response has too many nodes");
  assertAllocatedId(response.owner.id, "presentation response owner");
  const ids = new Set<string>();
  let previous: number | null = null;
  for (const node of response.nodes) {
    assertAllocatedId(node.id, "presentation response node");
    if (
      node.owner.kind !== response.owner.kind ||
      node.owner.id !== response.owner.id ||
      ids.has(node.id) ||
      node.parentId === node.id ||
      (node.parentId !== null && !isAllocatedId(node.parentId)) ||
      (previous !== null &&
        (response.kind === "viewport" ? node.paintOrder <= previous : node.paintOrder >= previous))
    ) {
      throw new TypeError("invalid presentation projection node");
    }
    ids.add(node.id);
    previous = node.paintOrder;
  }
}
function validateResolvedResponse(
  response: Extract<PresentationArtifactQueryResponse, { kind: "resolved-slide" }>,
): void {
  if (response.nodes.length > PRESENTATION_ARTIFACT_QUERY_MAX_NODES)
    throw new RangeError("presentation response has too many nodes");
  assertAllocatedId(response.slideId, "resolved presentation slide");
  const ids = new Set<string>();
  for (const node of response.nodes) {
    assertAllocatedId(node.id, "resolved presentation node");
    assertAllocatedId(node.source.id, "resolved presentation owner");
    if (
      ids.has(node.id) ||
      (node.source.kind === "slide" && node.source.id !== response.slideId) ||
      node.inherited !== !(node.source.kind === "slide" && node.source.id === response.slideId)
    )
      throw new TypeError("invalid resolved presentation node");
    ids.add(node.id);
  }
}
function bad(label: string): never {
  throw new TypeError(`invalid ${label}`);
}
