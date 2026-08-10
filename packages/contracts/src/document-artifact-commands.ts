/** Canonical identity-free OGADC001 structured-document commands. */

import {
  ArtifactBinaryReader,
  ArtifactBinaryWriter,
  decodeCountedEnvelope,
  encodeCountedEnvelope,
  equalBytes,
  strictUtf8,
} from "./editable-artifact-binary";

export const DOCUMENT_ARTIFACT_COMMAND_VERSION = 1 as const;
// The modality payload is nested inside OGATX001, whose public command budget
// is 4 MiB. Keep the leaf codec at that same ceiling so a locally accepted
// document edit can never become unsendable at the durable/live boundary.
export const DOCUMENT_ARTIFACT_COMMAND_MAX_BYTES = 4 * 1024 * 1024;
export const DOCUMENT_ARTIFACT_COMMAND_MAX_COMMANDS = 4_096;
export const DOCUMENT_ARTIFACT_COMMAND_MAX_STRING_BYTES = 4 * 1024 * 1024;
export const DOCUMENT_ARTIFACT_MAX_TEXT_UTF16 = 10_000_000;
export const DOCUMENT_ARTIFACT_MAX_TEXT_RUNS = 250_000;
export const DOCUMENT_ARTIFACT_MAX_TABLE_CELLS = 1_000_000;
export const DOCUMENT_ARTIFACT_MAX_STRUCTURAL_COUNTER = 2 ** 53 - 2;
export const DOCUMENT_ARTIFACT_QUERY_VERSION = 1 as const;
export const DOCUMENT_ARTIFACT_QUERY_RESPONSE_VERSION = 1 as const;
export const DOCUMENT_ARTIFACT_QUERY_MAX_BYTES = 256;
export const DOCUMENT_ARTIFACT_QUERY_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
export const DOCUMENT_ARTIFACT_QUERY_MAX_ITEMS = 4_096;
export const DOCUMENT_ARTIFACT_QUERY_MAX_TEXT_UTF16 = 1_000_000;
export const DOCUMENT_ARTIFACT_QUERY_MAX_TABLE_CELLS = 100_000;

const MAGIC = "OGADC001";
const QUERY_MAGIC = "OGADQ001";
const QUERY_RESPONSE_MAGIC = "OGADP001";
const QUERY_RESPONSE_EXTENSION_MARKER = 0xff;
const PAGE_EXTRAS_EXTENSION_VERSION = 1;

export type DocumentArtifactIdKind =
  | "paragraph"
  | "table"
  | "page-break"
  | "section"
  | "header"
  | "footer"
  | "comment"
  | "tracked-change";

export type DocumentArtifactId = string;

export type DocumentArtifactPageGeometry = Readonly<{
  widthPt: number;
  heightPt: number;
  marginTopPt: number;
  marginRightPt: number;
  marginBottomPt: number;
  marginLeftPt: number;
  headerPt?: number;
  footerPt?: number;
  gutterPt?: number;
}>;

export type DocumentArtifactTextStyle = Readonly<{
  fontFamily?: string;
  fontSizePt?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}>;

export type DocumentArtifactTextStylePatch = Readonly<{
  fontFamily?: string | null;
  fontSizePt?: number | null;
  color?: string | null;
  bold?: boolean | null;
  italic?: boolean | null;
  underline?: boolean | null;
  strike?: boolean | null;
}>;

export type DocumentArtifactTextRun = Readonly<{
  text: string;
  style: DocumentArtifactTextStyle;
}>;

export type DocumentArtifactParagraphStyle = Readonly<{
  headingLevel?: number;
  alignment?: "left" | "center" | "right" | "justify";
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  lineHeight?: number;
  keepNext?: boolean;
  pageBreakBefore?: boolean;
  list?: Readonly<{
    kind: "bullet" | "number";
    level: number | null;
    instanceId: string | null;
  }>;
}>;

export type DocumentArtifactTableStyle = Readonly<{
  widthPt?: number;
  columnWidthsPt?: readonly number[];
  headerRows?: number;
  cellPaddingPt?: number;
  borderColor?: string;
  headerFill?: string;
  allowRowSplit?: boolean;
}>;

export type DocumentArtifactStoryTarget =
  | Readonly<{ kind: "body" }>
  | Readonly<{
      kind: "section";
      sectionId: DocumentArtifactId;
      storyKind: "header" | "footer";
      variant: "default" | "first" | "even";
    }>;

export type DocumentArtifactTextRange = Readonly<{ start: number; end: number }>;
export type DocumentArtifactCommentReply = Readonly<{
  author: string;
  text: string;
  createdAt: string;
}>;

export type DocumentArtifactCommand =
  | Readonly<{
      kind: "document.flags.set";
      evenAndOddHeaders?: boolean | null;
      trackRevisions?: boolean | null;
    }>
  | Readonly<{
      kind: "paragraph.add";
      target: DocumentArtifactStoryTarget;
      id: DocumentArtifactId;
      runs: readonly DocumentArtifactTextRun[];
      style: DocumentArtifactParagraphStyle;
    }>
  | Readonly<{
      kind: "paragraph.edit";
      id: DocumentArtifactId;
      range: DocumentArtifactTextRange;
      replacement: string;
      style: DocumentArtifactTextStyle | null;
    }>
  | Readonly<{
      kind: "paragraph.format";
      id: DocumentArtifactId;
      range: DocumentArtifactTextRange;
      style: DocumentArtifactTextStylePatch;
    }>
  | Readonly<{
      kind: "paragraph.style.set";
      id: DocumentArtifactId;
      style: DocumentArtifactParagraphStyle;
    }>
  | Readonly<{
      kind: "table.add";
      target: DocumentArtifactStoryTarget;
      id: DocumentArtifactId;
      rows: readonly (readonly (readonly DocumentArtifactTextRun[])[])[];
      style: DocumentArtifactTableStyle;
    }>
  | Readonly<{ kind: "table.style.set"; id: DocumentArtifactId; style: DocumentArtifactTableStyle }>
  | Readonly<{ kind: "page-break.add"; id: DocumentArtifactId }>
  | Readonly<{
      kind: "section.add";
      ids: Readonly<{
        section: DocumentArtifactId;
        headerDefault: DocumentArtifactId;
        headerFirst: DocumentArtifactId;
        headerEven: DocumentArtifactId;
        footerDefault: DocumentArtifactId;
        footerFirst: DocumentArtifactId;
        footerEven: DocumentArtifactId;
      }>;
      page: DocumentArtifactPageGeometry;
      titlePage: boolean | null;
    }>
  | Readonly<{ kind: "section.title-page.set"; id: DocumentArtifactId; titlePage: boolean | null }>
  | Readonly<{
      kind: "section.page.set";
      id: DocumentArtifactId;
      page: DocumentArtifactPageGeometry;
    }>
  | Readonly<{
      kind: "comment.add";
      id: DocumentArtifactId;
      paragraphId: DocumentArtifactId;
      range: DocumentArtifactTextRange;
      resolved: boolean;
      root: DocumentArtifactCommentReply;
    }>
  | Readonly<{
      kind: "comment.reply.add";
      id: DocumentArtifactId;
      reply: DocumentArtifactCommentReply;
    }>
  | Readonly<{ kind: "comment.resolved.set"; id: DocumentArtifactId; resolved: boolean }>
  | Readonly<{
      kind: "tracked-change.add";
      id: DocumentArtifactId;
      paragraphId: DocumentArtifactId;
      range: DocumentArtifactTextRange;
      changeKind: "insert" | "delete";
      author: string;
      createdAt: string;
    }>;

export type DocumentArtifactCommandBatch = Readonly<{
  version: typeof DOCUMENT_ARTIFACT_COMMAND_VERSION;
  commands: readonly DocumentArtifactCommand[];
}>;

type CodecState = { runs: number; textUtf16: number; tableCells: number };

export function encodeDocumentArtifactCommandBatch(
  input: DocumentArtifactCommandBatch,
): Uint8Array {
  if (input?.version !== DOCUMENT_ARTIFACT_COMMAND_VERSION || !Array.isArray(input.commands)) {
    throw new TypeError("document command batch is invalid");
  }
  if (input.commands.length > DOCUMENT_ARTIFACT_COMMAND_MAX_COMMANDS) {
    throw new RangeError("document command count exceeds its limit");
  }
  const payload = new ArtifactBinaryWriter(DOCUMENT_ARTIFACT_COMMAND_MAX_BYTES - 32);
  const state: CodecState = { runs: 0, textUtf16: 0, tableCells: 0 };
  for (const command of input.commands) encodeCommand(payload, command, state);
  return encodeCountedEnvelope(
    MAGIC,
    DOCUMENT_ARTIFACT_COMMAND_VERSION,
    input.commands.length,
    payload.finish(),
    DOCUMENT_ARTIFACT_COMMAND_MAX_BYTES,
  );
}

export function decodeDocumentArtifactCommandBatch(
  bytes: Uint8Array,
): DocumentArtifactCommandBatch {
  const { count, payload } = decodeCountedEnvelope(
    bytes,
    MAGIC,
    DOCUMENT_ARTIFACT_COMMAND_VERSION,
    DOCUMENT_ARTIFACT_COMMAND_MAX_BYTES,
    DOCUMENT_ARTIFACT_COMMAND_MAX_COMMANDS,
  );
  const reader = new ArtifactBinaryReader(payload);
  const state: CodecState = { runs: 0, textUtf16: 0, tableCells: 0 };
  const commands: DocumentArtifactCommand[] = [];
  for (let index = 0; index < count; index += 1) commands.push(decodeCommand(reader, state));
  reader.done("document command payload contains trailing bytes");
  return Object.freeze({
    version: DOCUMENT_ARTIFACT_COMMAND_VERSION,
    commands: Object.freeze(commands),
  });
}

export function assertCanonicalDocumentArtifactCommandBytes(bytes: Uint8Array): void {
  if (
    !equalBytes(
      bytes,
      encodeDocumentArtifactCommandBatch(decodeDocumentArtifactCommandBatch(bytes)),
    )
  ) {
    throw new TypeError("document command batch is not canonically encoded");
  }
}

function encodeCommand(
  writer: ArtifactBinaryWriter,
  command: DocumentArtifactCommand,
  state: CodecState,
): void {
  switch (command.kind) {
    case "document.flags.set":
      writer.u8(0);
      writePatchBool(writer, command.evenAndOddHeaders);
      writePatchBool(writer, command.trackRevisions);
      return;
    case "paragraph.add":
      writer.u8(1);
      writeTarget(writer, command.target);
      writeDocumentId(writer, command.id, "paragraph");
      writeRuns(writer, command.runs, state);
      writeParagraphStyle(writer, command.style);
      return;
    case "paragraph.edit":
      writer.u8(2);
      writeDocumentId(writer, command.id, "paragraph");
      writeRange(writer, command.range);
      writeDocumentString(writer, command.replacement, state, true);
      writer.bool(command.style !== null);
      if (command.style !== null) writeTextStyle(writer, command.style);
      return;
    case "paragraph.format":
      writer.u8(3);
      writeDocumentId(writer, command.id, "paragraph");
      writeRange(writer, command.range);
      writeTextStylePatch(writer, command.style);
      return;
    case "paragraph.style.set":
      writer.u8(4);
      writeDocumentId(writer, command.id, "paragraph");
      writeParagraphStyle(writer, command.style);
      return;
    case "table.add":
      writer.u8(5);
      writeTarget(writer, command.target);
      writeDocumentId(writer, command.id, "table");
      writeTableRows(writer, command.rows, state);
      writeTableStyle(writer, command.style);
      return;
    case "table.style.set":
      writer.u8(6);
      writeDocumentId(writer, command.id, "table");
      writeTableStyle(writer, command.style);
      return;
    case "page-break.add":
      writer.u8(7);
      writeDocumentId(writer, command.id, "page-break");
      return;
    case "section.add": {
      assertDefaultPageExtras(command.page);
      writer.u8(8);
      const ordered: readonly [DocumentArtifactId, DocumentArtifactIdKind][] = [
        [command.ids.section, "section"],
        [command.ids.headerDefault, "header"],
        [command.ids.headerFirst, "header"],
        [command.ids.headerEven, "header"],
        [command.ids.footerDefault, "footer"],
        [command.ids.footerFirst, "footer"],
        [command.ids.footerEven, "footer"],
      ];
      for (const [id, kind] of ordered) writeDocumentId(writer, id, kind);
      writePage(writer, command.page);
      writeOptionalBool(writer, command.titlePage);
      return;
    }
    case "section.title-page.set":
      writer.u8(9);
      writeDocumentId(writer, command.id, "section");
      writeOptionalBool(writer, command.titlePage);
      return;
    case "comment.add":
      writer.u8(10);
      writeDocumentId(writer, command.id, "comment");
      writeDocumentId(writer, command.paragraphId, "paragraph");
      writeRange(writer, command.range);
      writer.bool(command.resolved);
      writeCommentReply(writer, command.root, state);
      return;
    case "comment.reply.add":
      writer.u8(11);
      writeDocumentId(writer, command.id, "comment");
      writeCommentReply(writer, command.reply, state);
      return;
    case "comment.resolved.set":
      writer.u8(12);
      writeDocumentId(writer, command.id, "comment");
      writer.bool(command.resolved);
      return;
    case "tracked-change.add":
      writer.u8(13);
      writeDocumentId(writer, command.id, "tracked-change");
      writeDocumentId(writer, command.paragraphId, "paragraph");
      writeRange(writer, command.range);
      writer.u8(
        command.changeKind === "insert"
          ? 1
          : command.changeKind === "delete"
            ? 2
            : invalidTag("tracked change kind"),
      );
      writeDocumentString(writer, command.author, state, false);
      writeDocumentString(writer, command.createdAt, state, false);
      return;
    case "section.page.set":
      writer.u8(14);
      writeDocumentId(writer, command.id, "section");
      writePageWithExtras(writer, command.page);
      return;
    default:
      throw new TypeError("invalid document command kind");
  }
}

function decodeCommand(reader: ArtifactBinaryReader, state: CodecState): DocumentArtifactCommand {
  switch (reader.u8()) {
    case 0: {
      const evenAndOddHeaders = readPatchBool(reader);
      const trackRevisions = readPatchBool(reader);
      return freezeOptional(
        { kind: "document.flags.set" as const },
        { evenAndOddHeaders, trackRevisions },
      ) as DocumentArtifactCommand;
    }
    case 1:
      return Object.freeze({
        kind: "paragraph.add",
        target: readTarget(reader),
        id: readDocumentId(reader, "paragraph"),
        runs: readRuns(reader, state),
        style: readParagraphStyle(reader),
      });
    case 2:
      return Object.freeze({
        kind: "paragraph.edit",
        id: readDocumentId(reader, "paragraph"),
        range: readRange(reader),
        replacement: readDocumentString(reader, state, true),
        style: reader.bool("optional document text style") ? readTextStyle(reader) : null,
      });
    case 3:
      return Object.freeze({
        kind: "paragraph.format",
        id: readDocumentId(reader, "paragraph"),
        range: readRange(reader),
        style: readTextStylePatch(reader),
      });
    case 4:
      return Object.freeze({
        kind: "paragraph.style.set",
        id: readDocumentId(reader, "paragraph"),
        style: readParagraphStyle(reader),
      });
    case 5:
      return Object.freeze({
        kind: "table.add",
        target: readTarget(reader),
        id: readDocumentId(reader, "table"),
        rows: readTableRows(reader, state),
        style: readTableStyle(reader),
      });
    case 6:
      return Object.freeze({
        kind: "table.style.set",
        id: readDocumentId(reader, "table"),
        style: readTableStyle(reader),
      });
    case 7:
      return Object.freeze({ kind: "page-break.add", id: readDocumentId(reader, "page-break") });
    case 8:
      return Object.freeze({
        kind: "section.add",
        ids: Object.freeze({
          section: readDocumentId(reader, "section"),
          headerDefault: readDocumentId(reader, "header"),
          headerFirst: readDocumentId(reader, "header"),
          headerEven: readDocumentId(reader, "header"),
          footerDefault: readDocumentId(reader, "footer"),
          footerFirst: readDocumentId(reader, "footer"),
          footerEven: readDocumentId(reader, "footer"),
        }),
        page: readPage(reader),
        titlePage: readOptionalBool(reader),
      });
    case 9:
      return Object.freeze({
        kind: "section.title-page.set",
        id: readDocumentId(reader, "section"),
        titlePage: readOptionalBool(reader),
      });
    case 10:
      return Object.freeze({
        kind: "comment.add",
        id: readDocumentId(reader, "comment"),
        paragraphId: readDocumentId(reader, "paragraph"),
        range: readRange(reader),
        resolved: reader.bool("document boolean"),
        root: readCommentReply(reader, state),
      });
    case 11:
      return Object.freeze({
        kind: "comment.reply.add",
        id: readDocumentId(reader, "comment"),
        reply: readCommentReply(reader, state),
      });
    case 12:
      return Object.freeze({
        kind: "comment.resolved.set",
        id: readDocumentId(reader, "comment"),
        resolved: reader.bool("document boolean"),
      });
    case 13: {
      const id = readDocumentId(reader, "tracked-change");
      const paragraphId = readDocumentId(reader, "paragraph");
      const range = readRange(reader);
      const tag = reader.u8();
      if (tag !== 1 && tag !== 2) throw new TypeError("invalid tracked change kind");
      return Object.freeze({
        kind: "tracked-change.add",
        id,
        paragraphId,
        range,
        changeKind: tag === 1 ? "insert" : "delete",
        author: readDocumentString(reader, state, false),
        createdAt: readDocumentString(reader, state, false),
      });
    }
    case 14:
      return Object.freeze({
        kind: "section.page.set",
        id: readDocumentId(reader, "section"),
        page: readPageWithExtras(reader),
      });
    default:
      throw new TypeError("invalid document command tag");
  }
}

const ID_PREFIX: Record<DocumentArtifactIdKind, { prefix: string; tag: number }> = {
  paragraph: { prefix: "p", tag: 1 },
  table: { prefix: "dt", tag: 2 },
  "page-break": { prefix: "pb", tag: 3 },
  section: { prefix: "sec", tag: 4 },
  header: { prefix: "hdr", tag: 5 },
  footer: { prefix: "ftr", tag: 6 },
  comment: { prefix: "dc", tag: 7 },
  "tracked-change": { prefix: "chg", tag: 8 },
};

function writeDocumentId(
  writer: ArtifactBinaryWriter,
  id: DocumentArtifactId,
  kind: DocumentArtifactIdKind,
): void {
  const expected = ID_PREFIX[kind];
  const match = new RegExp(`^${expected.prefix}/([0-9a-f]{16})([0-9a-f]{16})$`, "u").exec(id);
  if (!match) throw new TypeError(`document ${kind} id is invalid`);
  const counter = BigInt(`0x${match[2]}`);
  if (counter === 0n || counter > BigInt(DOCUMENT_ARTIFACT_MAX_STRUCTURAL_COUNTER)) {
    throw new TypeError(`document ${kind} id counter is invalid`);
  }
  writer.u8(expected.tag);
  writer.u64(BigInt(`0x${match[1]}`));
  writer.u64(counter);
}

function readDocumentId(
  reader: ArtifactBinaryReader,
  kind: DocumentArtifactIdKind,
): DocumentArtifactId {
  const expected = ID_PREFIX[kind];
  if (reader.u8() !== expected.tag) throw new TypeError("document id kind mismatch");
  const namespace = reader.u64BigInt().toString(16).padStart(16, "0");
  const counterValue = reader.u64BigInt();
  if (counterValue === 0n || counterValue > BigInt(DOCUMENT_ARTIFACT_MAX_STRUCTURAL_COUNTER)) {
    throw new TypeError("document id counter is invalid");
  }
  return `${expected.prefix}/${namespace}${counterValue.toString(16).padStart(16, "0")}`;
}

function writeDocumentString(
  writer: ArtifactBinaryWriter,
  value: string,
  state: CodecState,
  content: boolean,
): void {
  const bytes = strictUtf8(value, "document string");
  const utf16 = value.length;
  if (
    bytes.byteLength > DOCUMENT_ARTIFACT_COMMAND_MAX_STRING_BYTES ||
    utf16 > DOCUMENT_ARTIFACT_MAX_TEXT_UTF16
  ) {
    throw new RangeError("document string exceeds its limit");
  }
  if (content) {
    state.textUtf16 += utf16;
    if (state.textUtf16 > DOCUMENT_ARTIFACT_MAX_TEXT_UTF16)
      throw new RangeError("document text exceeds its UTF-16 limit");
  }
  writer.u32(bytes.byteLength);
  writer.bytes(bytes);
}

function readDocumentString(
  reader: ArtifactBinaryReader,
  state: CodecState,
  content: boolean,
): string {
  const value = reader.string(DOCUMENT_ARTIFACT_COMMAND_MAX_STRING_BYTES, "document string");
  if (value.length > DOCUMENT_ARTIFACT_MAX_TEXT_UTF16)
    throw new RangeError("document string exceeds its UTF-16 limit");
  if (content) {
    state.textUtf16 += value.length;
    if (state.textUtf16 > DOCUMENT_ARTIFACT_MAX_TEXT_UTF16)
      throw new RangeError("document text exceeds its UTF-16 limit");
  }
  return value;
}

function writeRuns(
  writer: ArtifactBinaryWriter,
  runs: readonly DocumentArtifactTextRun[],
  state: CodecState,
): void {
  if (!Array.isArray(runs)) throw new TypeError("document runs must be an array");
  state.runs += runs.length;
  if (state.runs > DOCUMENT_ARTIFACT_MAX_TEXT_RUNS)
    throw new RangeError("document text runs exceed their limit");
  writer.count(runs.length, DOCUMENT_ARTIFACT_MAX_TEXT_RUNS, "document runs");
  for (const run of runs) {
    writeDocumentString(writer, run.text, state, true);
    writeTextStyle(writer, run.style);
  }
}

function readRuns(
  reader: ArtifactBinaryReader,
  state: CodecState,
): readonly DocumentArtifactTextRun[] {
  const count = reader.count(DOCUMENT_ARTIFACT_MAX_TEXT_RUNS, "document runs");
  state.runs += count;
  if (state.runs > DOCUMENT_ARTIFACT_MAX_TEXT_RUNS)
    throw new RangeError("document text runs exceed their limit");
  const runs: DocumentArtifactTextRun[] = [];
  for (let index = 0; index < count; index += 1)
    runs.push(
      Object.freeze({
        text: readDocumentString(reader, state, true),
        style: readTextStyle(reader),
      }),
    );
  return Object.freeze(runs);
}

function writeTextStyle(writer: ArtifactBinaryWriter, style: DocumentArtifactTextStyle): void {
  const mask =
    Number(style.fontFamily !== undefined) |
    (Number(style.fontSizePt !== undefined) << 1) |
    (Number(style.color !== undefined) << 2) |
    (Number(style.bold !== undefined) << 3) |
    (Number(style.italic !== undefined) << 4) |
    (Number(style.underline !== undefined) << 5) |
    (Number(style.strike !== undefined) << 6);
  writer.u8(mask);
  const dummy: CodecState = { runs: 0, textUtf16: 0, tableCells: 0 };
  if (style.fontFamily !== undefined) writeDocumentString(writer, style.fontFamily, dummy, false);
  if (style.fontSizePt !== undefined) writer.f64(style.fontSizePt, "document font size");
  if (style.color !== undefined) writeDocumentString(writer, style.color, dummy, false);
  for (const value of [style.bold, style.italic, style.underline, style.strike])
    if (value !== undefined) writer.bool(value);
}

function readTextStyle(reader: ArtifactBinaryReader): DocumentArtifactTextStyle {
  const mask = reader.u8();
  if ((mask & ~0x7f) !== 0) throw new TypeError("unknown document text-style bits");
  const state: CodecState = { runs: 0, textUtf16: 0, tableCells: 0 };
  return Object.freeze({
    ...(mask & 1 ? { fontFamily: readDocumentString(reader, state, false) } : {}),
    ...(mask & 2 ? { fontSizePt: reader.f64("document font size") } : {}),
    ...(mask & 4 ? { color: readDocumentString(reader, state, false) } : {}),
    ...(mask & 8 ? { bold: reader.bool("document boolean") } : {}),
    ...(mask & 16 ? { italic: reader.bool("document boolean") } : {}),
    ...(mask & 32 ? { underline: reader.bool("document boolean") } : {}),
    ...(mask & 64 ? { strike: reader.bool("document boolean") } : {}),
  });
}

function writeTextStylePatch(
  writer: ArtifactBinaryWriter,
  patch: DocumentArtifactTextStylePatch,
): void {
  writePatchString(writer, patch.fontFamily);
  writePatchNumber(writer, patch.fontSizePt);
  writePatchString(writer, patch.color);
  writePatchBool(writer, patch.bold);
  writePatchBool(writer, patch.italic);
  writePatchBool(writer, patch.underline);
  writePatchBool(writer, patch.strike);
}

function readTextStylePatch(reader: ArtifactBinaryReader): DocumentArtifactTextStylePatch {
  const fontFamily = readPatchString(reader);
  const fontSizePt = readPatchNumber(reader);
  const color = readPatchString(reader);
  const bold = readPatchBool(reader);
  const italic = readPatchBool(reader);
  const underline = readPatchBool(reader);
  const strike = readPatchBool(reader);
  return freezeOptional(
    {},
    { fontFamily, fontSizePt, color, bold, italic, underline, strike },
  ) as DocumentArtifactTextStylePatch;
}

function writePatchString(writer: ArtifactBinaryWriter, value: string | null | undefined): void {
  if (value === undefined) writer.u8(0);
  else if (value === null) writer.u8(1);
  else {
    writer.u8(2);
    writeDocumentString(writer, value, { runs: 0, textUtf16: 0, tableCells: 0 }, false);
  }
}

function readPatchString(reader: ArtifactBinaryReader): string | null | undefined {
  const tag = reader.u8();
  if (tag === 0) return undefined;
  if (tag === 1) return null;
  if (tag === 2) return readDocumentString(reader, { runs: 0, textUtf16: 0, tableCells: 0 }, false);
  throw new TypeError("invalid document string patch");
}

function writePatchNumber(writer: ArtifactBinaryWriter, value: number | null | undefined): void {
  if (value === undefined) writer.u8(0);
  else if (value === null) writer.u8(1);
  else {
    writer.u8(2);
    writer.f64(value, "document number patch");
  }
}

function readPatchNumber(reader: ArtifactBinaryReader): number | null | undefined {
  const tag = reader.u8();
  if (tag === 0) return undefined;
  if (tag === 1) return null;
  if (tag === 2) return reader.f64("document number patch");
  throw new TypeError("invalid document number patch");
}

function writePatchBool(writer: ArtifactBinaryWriter, value: boolean | null | undefined): void {
  writer.u8(value === undefined ? 0 : value === null ? 1 : value ? 3 : 2);
}

function readPatchBool(reader: ArtifactBinaryReader): boolean | null | undefined {
  const tag = reader.u8();
  if (tag === 0) return undefined;
  if (tag === 1) return null;
  if (tag === 2) return false;
  if (tag === 3) return true;
  throw new TypeError("invalid document boolean patch");
}

function writeOptionalBool(writer: ArtifactBinaryWriter, value: boolean | null): void {
  writer.u8(value === null ? 0 : value ? 2 : 1);
}

function readOptionalBool(reader: ArtifactBinaryReader): boolean | null {
  const tag = reader.u8();
  if (tag === 0) return null;
  if (tag === 1) return false;
  if (tag === 2) return true;
  throw new TypeError("invalid optional document boolean");
}

function writeParagraphStyle(
  writer: ArtifactBinaryWriter,
  style: DocumentArtifactParagraphStyle,
): void {
  const mask =
    Number(style.headingLevel !== undefined) |
    (Number(style.alignment !== undefined) << 1) |
    (Number(style.spaceBeforePt !== undefined) << 2) |
    (Number(style.spaceAfterPt !== undefined) << 3) |
    (Number(style.lineHeight !== undefined) << 4) |
    (Number(style.keepNext !== undefined) << 5) |
    (Number(style.pageBreakBefore !== undefined) << 6) |
    (Number(style.list !== undefined) << 7);
  writer.u16(mask);
  if (style.headingLevel !== undefined) writer.u8(style.headingLevel);
  if (style.alignment !== undefined)
    writer.u8(
      ({ left: 1, center: 2, right: 3, justify: 4 } as const)[style.alignment] ??
        invalidTag("paragraph alignment"),
    );
  if (style.spaceBeforePt !== undefined)
    writer.f64(style.spaceBeforePt, "document paragraph spacing");
  if (style.spaceAfterPt !== undefined)
    writer.f64(style.spaceAfterPt, "document paragraph spacing");
  if (style.lineHeight !== undefined) writer.f64(style.lineHeight, "document line height");
  if (style.keepNext !== undefined) writer.bool(style.keepNext);
  if (style.pageBreakBefore !== undefined) writer.bool(style.pageBreakBefore);
  if (style.list !== undefined) {
    writer.u8(
      style.list.kind === "bullet" ? 1 : style.list.kind === "number" ? 2 : invalidTag("list kind"),
    );
    writer.bool(style.list.level !== null);
    if (style.list.level !== null) writer.u8(style.list.level);
    writer.bool(style.list.instanceId !== null);
    if (style.list.instanceId !== null)
      writeDocumentString(
        writer,
        style.list.instanceId,
        { runs: 0, textUtf16: 0, tableCells: 0 },
        false,
      );
  }
}

function readParagraphStyle(reader: ArtifactBinaryReader): DocumentArtifactParagraphStyle {
  const mask = reader.u16();
  if ((mask & ~0xff) !== 0) throw new TypeError("unknown paragraph-style bits");
  const headingLevel = mask & 1 ? reader.u8() : undefined;
  let alignment: DocumentArtifactParagraphStyle["alignment"];
  if (mask & 2) {
    const tag = reader.u8();
    alignment =
      tag === 1
        ? "left"
        : tag === 2
          ? "center"
          : tag === 3
            ? "right"
            : tag === 4
              ? "justify"
              : invalidTag("paragraph alignment");
  }
  const spaceBeforePt = mask & 4 ? reader.f64("document paragraph spacing") : undefined;
  const spaceAfterPt = mask & 8 ? reader.f64("document paragraph spacing") : undefined;
  const lineHeight = mask & 16 ? reader.f64("document line height") : undefined;
  const keepNext = mask & 32 ? reader.bool("document boolean") : undefined;
  const pageBreakBefore = mask & 64 ? reader.bool("document boolean") : undefined;
  let list: DocumentArtifactParagraphStyle["list"];
  if (mask & 128) {
    const tag = reader.u8();
    const kind = tag === 1 ? "bullet" : tag === 2 ? "number" : invalidTag("list kind");
    list = Object.freeze({
      kind,
      level: reader.bool("document list level presence") ? reader.u8() : null,
      instanceId: reader.bool("optional document string")
        ? readDocumentString(reader, { runs: 0, textUtf16: 0, tableCells: 0 }, false)
        : null,
    });
  }
  return Object.freeze({
    ...(headingLevel !== undefined ? { headingLevel } : {}),
    ...(alignment !== undefined ? { alignment } : {}),
    ...(spaceBeforePt !== undefined ? { spaceBeforePt } : {}),
    ...(spaceAfterPt !== undefined ? { spaceAfterPt } : {}),
    ...(lineHeight !== undefined ? { lineHeight } : {}),
    ...(keepNext !== undefined ? { keepNext } : {}),
    ...(pageBreakBefore !== undefined ? { pageBreakBefore } : {}),
    ...(list !== undefined ? { list } : {}),
  });
}

function writeTableStyle(writer: ArtifactBinaryWriter, style: DocumentArtifactTableStyle): void {
  const mask =
    Number(style.widthPt !== undefined) |
    (Number(style.columnWidthsPt !== undefined) << 1) |
    (Number(style.headerRows !== undefined) << 2) |
    (Number(style.cellPaddingPt !== undefined) << 3) |
    (Number(style.borderColor !== undefined) << 4) |
    (Number(style.headerFill !== undefined) << 5) |
    (Number(style.allowRowSplit !== undefined) << 6);
  writer.u8(mask);
  if (style.widthPt !== undefined) writer.f64(style.widthPt, "document table width");
  if (style.columnWidthsPt !== undefined) {
    writer.count(
      style.columnWidthsPt.length,
      DOCUMENT_ARTIFACT_MAX_TABLE_CELLS,
      "document table widths",
    );
    for (const width of style.columnWidthsPt) writer.f64(width, "document column width");
  }
  if (style.headerRows !== undefined) writer.u32(style.headerRows);
  if (style.cellPaddingPt !== undefined) writer.f64(style.cellPaddingPt, "document cell padding");
  if (style.borderColor !== undefined)
    writeDocumentString(writer, style.borderColor, { runs: 0, textUtf16: 0, tableCells: 0 }, false);
  if (style.headerFill !== undefined)
    writeDocumentString(writer, style.headerFill, { runs: 0, textUtf16: 0, tableCells: 0 }, false);
  if (style.allowRowSplit !== undefined) writer.bool(style.allowRowSplit);
}

function readTableStyle(reader: ArtifactBinaryReader): DocumentArtifactTableStyle {
  const mask = reader.u8();
  if ((mask & ~0x7f) !== 0) throw new TypeError("unknown document table-style bits");
  const widthPt = mask & 1 ? reader.f64("document table width") : undefined;
  let columnWidthsPt: readonly number[] | undefined;
  if (mask & 2) {
    const count = reader.count(DOCUMENT_ARTIFACT_MAX_TABLE_CELLS, "document table widths");
    const widths: number[] = [];
    for (let index = 0; index < count; index += 1) widths.push(reader.f64("document column width"));
    columnWidthsPt = Object.freeze(widths);
  }
  const headerRows = mask & 4 ? reader.u32() : undefined;
  const cellPaddingPt = mask & 8 ? reader.f64("document cell padding") : undefined;
  const state: CodecState = { runs: 0, textUtf16: 0, tableCells: 0 };
  const borderColor = mask & 16 ? readDocumentString(reader, state, false) : undefined;
  const headerFill = mask & 32 ? readDocumentString(reader, state, false) : undefined;
  const allowRowSplit = mask & 64 ? reader.bool("document boolean") : undefined;
  return Object.freeze({
    ...(widthPt !== undefined ? { widthPt } : {}),
    ...(columnWidthsPt ? { columnWidthsPt } : {}),
    ...(headerRows !== undefined ? { headerRows } : {}),
    ...(cellPaddingPt !== undefined ? { cellPaddingPt } : {}),
    ...(borderColor !== undefined ? { borderColor } : {}),
    ...(headerFill !== undefined ? { headerFill } : {}),
    ...(allowRowSplit !== undefined ? { allowRowSplit } : {}),
  });
}

function writeTableRows(
  writer: ArtifactBinaryWriter,
  rows: readonly (readonly (readonly DocumentArtifactTextRun[])[])[],
  state: CodecState,
): void {
  writer.count(rows.length, DOCUMENT_ARTIFACT_MAX_TABLE_CELLS, "document table rows");
  for (const row of rows) {
    state.tableCells += row.length;
    if (state.tableCells > DOCUMENT_ARTIFACT_MAX_TABLE_CELLS)
      throw new RangeError("document table cells exceed their limit");
    writer.count(row.length, DOCUMENT_ARTIFACT_MAX_TABLE_CELLS, "document table cells");
    for (const cell of row) writeRuns(writer, cell, state);
  }
}

function readTableRows(
  reader: ArtifactBinaryReader,
  state: CodecState,
): readonly (readonly (readonly DocumentArtifactTextRun[])[])[] {
  const rowCount = reader.count(DOCUMENT_ARTIFACT_MAX_TABLE_CELLS, "document table rows");
  const rows: (readonly (readonly DocumentArtifactTextRun[])[])[] = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const columnCount = reader.count(DOCUMENT_ARTIFACT_MAX_TABLE_CELLS, "document table cells");
    state.tableCells += columnCount;
    if (state.tableCells > DOCUMENT_ARTIFACT_MAX_TABLE_CELLS)
      throw new RangeError("document table cells exceed their limit");
    const row: (readonly DocumentArtifactTextRun[])[] = [];
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1)
      row.push(readRuns(reader, state));
    rows.push(Object.freeze(row));
  }
  return Object.freeze(rows);
}

function writeTarget(writer: ArtifactBinaryWriter, target: DocumentArtifactStoryTarget): void {
  if (target.kind === "body") {
    writer.u8(0);
    return;
  }
  if (target.kind !== "section") throw new TypeError("invalid document story target");
  writer.u8(1);
  writeDocumentId(writer, target.sectionId, "section");
  writer.u8(
    target.storyKind === "header"
      ? 1
      : target.storyKind === "footer"
        ? 2
        : invalidTag("story kind"),
  );
  writer.u8(
    target.variant === "default"
      ? 1
      : target.variant === "first"
        ? 2
        : target.variant === "even"
          ? 3
          : invalidTag("story variant"),
  );
}

function readTarget(reader: ArtifactBinaryReader): DocumentArtifactStoryTarget {
  const tag = reader.u8();
  if (tag === 0) return Object.freeze({ kind: "body" });
  if (tag !== 1) throw new TypeError("invalid document story target");
  const sectionId = readDocumentId(reader, "section");
  const kindTag = reader.u8();
  const storyKind = kindTag === 1 ? "header" : kindTag === 2 ? "footer" : invalidTag("story kind");
  const variantTag = reader.u8();
  const variant =
    variantTag === 1
      ? "default"
      : variantTag === 2
        ? "first"
        : variantTag === 3
          ? "even"
          : invalidTag("story variant");
  return Object.freeze({ kind: "section", sectionId, storyKind, variant });
}

function writeRange(writer: ArtifactBinaryWriter, range: DocumentArtifactTextRange): void {
  if (range.end < range.start) throw new TypeError("document text range is invalid");
  writer.u32(range.start);
  writer.u32(range.end);
}

function readRange(reader: ArtifactBinaryReader): DocumentArtifactTextRange {
  const start = reader.u32();
  const end = reader.u32();
  if (end < start) throw new TypeError("document text range is invalid");
  return Object.freeze({ start, end });
}

function writePage(writer: ArtifactBinaryWriter, page: DocumentArtifactPageGeometry): void {
  for (const [value, label] of [
    [page.widthPt, "width"],
    [page.heightPt, "height"],
    [page.marginTopPt, "top margin"],
    [page.marginRightPt, "right margin"],
    [page.marginBottomPt, "bottom margin"],
    [page.marginLeftPt, "left margin"],
  ] as const)
    writer.f64(value, `document ${label}`);
}

function writePageWithExtras(
  writer: ArtifactBinaryWriter,
  page: DocumentArtifactPageGeometry,
): void {
  writePage(writer, page);
  writer.f64(page.headerPt ?? 36, "document header distance");
  writer.f64(page.footerPt ?? 36, "document footer distance");
  writer.f64(page.gutterPt ?? 0, "document gutter");
}

function assertDefaultPageExtras(page: DocumentArtifactPageGeometry): void {
  if ((page.headerPt ?? 36) !== 36 || (page.footerPt ?? 36) !== 36 || (page.gutterPt ?? 0) !== 0) {
    throw new TypeError("section.add page extras require section.page.set");
  }
}

function readPage(reader: ArtifactBinaryReader): DocumentArtifactPageGeometry {
  return Object.freeze({
    widthPt: reader.f64("document width"),
    heightPt: reader.f64("document height"),
    marginTopPt: reader.f64("document top margin"),
    marginRightPt: reader.f64("document right margin"),
    marginBottomPt: reader.f64("document bottom margin"),
    marginLeftPt: reader.f64("document left margin"),
  });
}

function readPageWithExtras(reader: ArtifactBinaryReader): DocumentArtifactPageGeometry {
  return Object.freeze({
    ...readPage(reader),
    headerPt: reader.f64("document header distance"),
    footerPt: reader.f64("document footer distance"),
    gutterPt: reader.f64("document gutter"),
  });
}

function writeCommentReply(
  writer: ArtifactBinaryWriter,
  reply: DocumentArtifactCommentReply,
  state: CodecState,
): void {
  writeDocumentString(writer, reply.author, state, false);
  writeDocumentString(writer, reply.text, state, true);
  writeDocumentString(writer, reply.createdAt, state, false);
}

function readCommentReply(
  reader: ArtifactBinaryReader,
  state: CodecState,
): DocumentArtifactCommentReply {
  return Object.freeze({
    author: readDocumentString(reader, state, false),
    text: readDocumentString(reader, state, true),
    createdAt: readDocumentString(reader, state, false),
  });
}

export type DocumentArtifactQueryLimits = Readonly<{
  maxItems: number;
  maxTextUtf16: number;
  maxTableCells: number;
}>;

export type DocumentArtifactQuery =
  | Readonly<{ kind: "summary" }>
  | Readonly<{ kind: "body"; startBlock: number; limits: DocumentArtifactQueryLimits }>
  | Readonly<{
      kind: "story";
      sectionId: DocumentArtifactId;
      storyKind: "header" | "footer";
      variant: "default" | "first" | "even";
      startBlock: number;
      limits: DocumentArtifactQueryLimits;
    }>
  | Readonly<{ kind: "sections"; startSection: number; limits: DocumentArtifactQueryLimits }>
  | Readonly<{ kind: "review"; startItem: number; limits: DocumentArtifactQueryLimits }>;

export type DocumentArtifactPageGeometryProjection = Readonly<{
  widthMillipoints: bigint;
  heightMillipoints: bigint;
  marginTopMillipoints: bigint;
  marginRightMillipoints: bigint;
  marginBottomMillipoints: bigint;
  marginLeftMillipoints: bigint;
  headerMillipoints: bigint;
  footerMillipoints: bigint;
  gutterMillipoints: bigint;
}>;

export type DocumentArtifactProjectionItem =
  | Readonly<{
      kind: "summary";
      idNamespace: bigint;
      revision: bigint;
      nextIdCounter: bigint;
      blockCount: number;
      sectionCount: number;
      commentCount: number;
      trackedChangeCount: number;
      evenAndOddHeaders: boolean;
      trackRevisions: boolean;
      page: DocumentArtifactPageGeometryProjection;
    }>
  | Readonly<{
      kind: "section";
      id: DocumentArtifactId;
      startBlockIndex: number;
      titlePage: boolean;
      page: DocumentArtifactPageGeometryProjection;
      headerBlockCounts: readonly [number, number, number];
      footerBlockCounts: readonly [number, number, number];
    }>
  | Readonly<{
      kind: "paragraph";
      id: DocumentArtifactId;
      runs: readonly DocumentArtifactTextRun[];
      style: DocumentArtifactParagraphStyle;
    }>
  | Readonly<{
      kind: "table";
      id: DocumentArtifactId;
      rows: readonly (readonly (readonly DocumentArtifactTextRun[])[])[];
      style: DocumentArtifactTableStyle;
    }>
  | Readonly<{ kind: "page-break"; id: DocumentArtifactId }>
  | Readonly<{
      kind: "comment";
      id: DocumentArtifactId;
      paragraphId: DocumentArtifactId;
      range: DocumentArtifactTextRange;
      resolved: boolean;
      replies: readonly DocumentArtifactCommentReply[];
    }>
  | Readonly<{
      kind: "tracked-change";
      id: DocumentArtifactId;
      paragraphId: DocumentArtifactId;
      changeKind: "insert" | "delete";
      range: DocumentArtifactTextRange;
      author: string;
      createdAt: string;
    }>;

export type DocumentArtifactProjection = Readonly<{
  revision: bigint;
  items: readonly DocumentArtifactProjectionItem[];
  nextCursor: number | null;
  truncated: boolean;
  projectedTextUtf16: number;
  projectedTableCells: number;
}>;

export function encodeDocumentArtifactQuery(query: DocumentArtifactQuery): Uint8Array {
  const payload = new ArtifactBinaryWriter(DOCUMENT_ARTIFACT_QUERY_MAX_BYTES - 32);
  switch (query.kind) {
    case "summary":
      payload.u8(0);
      break;
    case "body":
      validateDocumentQueryLimits(query.limits);
      payload.u8(1);
      payload.u64(query.startBlock);
      writeQueryLimits(payload, query.limits);
      break;
    case "story":
      validateDocumentQueryLimits(query.limits);
      payload.u8(2);
      writeDocumentId(payload, query.sectionId, "section");
      payload.u8(
        query.storyKind === "header"
          ? 1
          : query.storyKind === "footer"
            ? 2
            : invalidTag("story kind"),
      );
      payload.u8(
        query.variant === "default"
          ? 1
          : query.variant === "first"
            ? 2
            : query.variant === "even"
              ? 3
              : invalidTag("story variant"),
      );
      payload.u64(query.startBlock);
      writeQueryLimits(payload, query.limits);
      break;
    case "sections":
      validateDocumentQueryLimits(query.limits);
      payload.u8(3);
      payload.u64(query.startSection);
      writeQueryLimits(payload, query.limits);
      break;
    case "review":
      validateDocumentQueryLimits(query.limits);
      payload.u8(4);
      payload.u64(query.startItem);
      writeQueryLimits(payload, query.limits);
      break;
    default:
      throw new TypeError("invalid document query kind");
  }
  return encodeCountedEnvelope(
    QUERY_MAGIC,
    DOCUMENT_ARTIFACT_QUERY_VERSION,
    1,
    payload.finish(),
    DOCUMENT_ARTIFACT_QUERY_MAX_BYTES,
  );
}

export function decodeDocumentArtifactQuery(bytes: Uint8Array): DocumentArtifactQuery {
  const { count, payload } = decodeCountedEnvelope(
    bytes,
    QUERY_MAGIC,
    DOCUMENT_ARTIFACT_QUERY_VERSION,
    DOCUMENT_ARTIFACT_QUERY_MAX_BYTES,
    1,
  );
  if (count !== 1) throw new TypeError("document query envelope must contain exactly one query");
  const reader = new ArtifactBinaryReader(payload);
  const tag = reader.u8();
  let query: DocumentArtifactQuery;
  if (tag === 0) query = Object.freeze({ kind: "summary" });
  else if (tag === 1)
    query = Object.freeze({
      kind: "body",
      startBlock: reader.u64Safe("document body cursor"),
      limits: readQueryLimits(reader),
    });
  else if (tag === 2) {
    const sectionId = readDocumentId(reader, "section");
    const storyKindTag = reader.u8();
    const variantTag = reader.u8();
    query = Object.freeze({
      kind: "story",
      sectionId,
      storyKind:
        storyKindTag === 1 ? "header" : storyKindTag === 2 ? "footer" : invalidTag("story kind"),
      variant:
        variantTag === 1
          ? "default"
          : variantTag === 2
            ? "first"
            : variantTag === 3
              ? "even"
              : invalidTag("story variant"),
      startBlock: reader.u64Safe("document story cursor"),
      limits: readQueryLimits(reader),
    });
  } else if (tag === 3)
    query = Object.freeze({
      kind: "sections",
      startSection: reader.u64Safe("document section cursor"),
      limits: readQueryLimits(reader),
    });
  else if (tag === 4)
    query = Object.freeze({
      kind: "review",
      startItem: reader.u64Safe("document review cursor"),
      limits: readQueryLimits(reader),
    });
  else throw new TypeError("invalid document query tag");
  reader.done("document query contains trailing bytes");
  return query;
}

export function assertCanonicalDocumentArtifactQueryBytes(bytes: Uint8Array): void {
  if (!equalBytes(bytes, encodeDocumentArtifactQuery(decodeDocumentArtifactQuery(bytes)))) {
    throw new TypeError("document query is not canonically encoded");
  }
}

export function encodeDocumentArtifactQueryResponse(
  projection: DocumentArtifactProjection,
): Uint8Array {
  if (projection.items.length > DOCUMENT_ARTIFACT_QUERY_MAX_ITEMS)
    throw new RangeError("document query response has too many items");
  if (projection.truncated !== (projection.nextCursor !== null))
    throw new TypeError("document query cursor and truncation flag disagree");
  const metrics = measureProjection(projection.items);
  if (
    metrics.text !== projection.projectedTextUtf16 ||
    metrics.cells !== projection.projectedTableCells
  ) {
    throw new TypeError("document query response metrics do not match its items");
  }
  const payload = new ArtifactBinaryWriter(DOCUMENT_ARTIFACT_QUERY_RESPONSE_MAX_BYTES - 32);
  payload.u64(projection.revision);
  payload.bool(projection.nextCursor !== null);
  if (projection.nextCursor !== null) payload.u64(projection.nextCursor);
  payload.bool(projection.truncated);
  payload.u64(projection.projectedTextUtf16);
  payload.u64(projection.projectedTableCells);
  const state: CodecState = { runs: 0, textUtf16: 0, tableCells: 0 };
  for (const item of projection.items) writeProjectionItem(payload, item, state);
  const pageExtras = projection.items
    .map((item, index) => ({ index, page: projectionPage(item) }))
    .filter(
      (entry): entry is { index: number; page: DocumentArtifactPageGeometryProjection } =>
        entry.page !== null && hasNonDefaultProjectionPageExtras(entry.page),
    );
  if (pageExtras.length > 0) {
    payload.u8(QUERY_RESPONSE_EXTENSION_MARKER);
    payload.u8(PAGE_EXTRAS_EXTENSION_VERSION);
    payload.count(pageExtras.length, DOCUMENT_ARTIFACT_QUERY_MAX_ITEMS, "document page extras");
    for (const { index, page } of pageExtras) {
      payload.count(index, DOCUMENT_ARTIFACT_QUERY_MAX_ITEMS - 1, "document page item index");
      payload.i64(page.headerMillipoints);
      payload.i64(page.footerMillipoints);
      payload.i64(page.gutterMillipoints);
    }
  }
  return encodeCountedEnvelope(
    QUERY_RESPONSE_MAGIC,
    DOCUMENT_ARTIFACT_QUERY_RESPONSE_VERSION,
    projection.items.length,
    payload.finish(),
    DOCUMENT_ARTIFACT_QUERY_RESPONSE_MAX_BYTES,
  );
}

export function decodeDocumentArtifactQueryResponse(bytes: Uint8Array): DocumentArtifactProjection {
  const { count, payload } = decodeCountedEnvelope(
    bytes,
    QUERY_RESPONSE_MAGIC,
    DOCUMENT_ARTIFACT_QUERY_RESPONSE_VERSION,
    DOCUMENT_ARTIFACT_QUERY_RESPONSE_MAX_BYTES,
    DOCUMENT_ARTIFACT_QUERY_MAX_ITEMS,
  );
  const reader = new ArtifactBinaryReader(payload);
  const revision = reader.u64BigInt();
  const nextCursor = reader.bool("optional document cursor")
    ? reader.u64Safe("document query cursor")
    : null;
  const truncated = reader.bool("document truncation flag");
  if (truncated !== (nextCursor !== null))
    throw new TypeError("document query cursor and truncation flag disagree");
  const projectedTextUtf16 = reader.u64Safe("document projected text");
  const projectedTableCells = reader.u64Safe("document projected table cells");
  if (
    projectedTextUtf16 > DOCUMENT_ARTIFACT_QUERY_MAX_TEXT_UTF16 ||
    projectedTableCells > DOCUMENT_ARTIFACT_QUERY_MAX_TABLE_CELLS
  ) {
    throw new RangeError("document query response metrics exceed their limits");
  }
  const state: CodecState = { runs: 0, textUtf16: 0, tableCells: 0 };
  let items: DocumentArtifactProjectionItem[] = [];
  for (let index = 0; index < count; index += 1) items.push(readProjectionItem(reader, state));
  if (reader.remaining > 0) items = readProjectionPageExtras(reader, items);
  reader.done("document query response contains trailing bytes");
  const measured = measureProjection(items);
  if (measured.text !== projectedTextUtf16 || measured.cells !== projectedTableCells) {
    throw new TypeError("document query response metrics do not match its items");
  }
  const projection = Object.freeze({
    revision,
    items: Object.freeze(items),
    nextCursor,
    truncated,
    projectedTextUtf16,
    projectedTableCells,
  });
  if (!equalBytes(bytes, encodeDocumentArtifactQueryResponse(projection))) {
    throw new TypeError("document query response is not canonically encoded");
  }
  return projection;
}

export function assertCanonicalDocumentArtifactQueryResponseBytes(bytes: Uint8Array): void {
  decodeDocumentArtifactQueryResponse(bytes);
}

function writeQueryLimits(writer: ArtifactBinaryWriter, limits: DocumentArtifactQueryLimits): void {
  validateDocumentQueryLimits(limits);
  writer.u32(limits.maxItems);
  writer.u32(limits.maxTextUtf16);
  writer.u32(limits.maxTableCells);
}

function readQueryLimits(reader: ArtifactBinaryReader): DocumentArtifactQueryLimits {
  const limits = Object.freeze({
    maxItems: reader.u32(),
    maxTextUtf16: reader.u32(),
    maxTableCells: reader.u32(),
  });
  validateDocumentQueryLimits(limits);
  return limits;
}

function validateDocumentQueryLimits(limits: DocumentArtifactQueryLimits): void {
  if (
    !Number.isInteger(limits.maxItems) ||
    limits.maxItems < 1 ||
    limits.maxItems > DOCUMENT_ARTIFACT_QUERY_MAX_ITEMS ||
    !Number.isInteger(limits.maxTextUtf16) ||
    limits.maxTextUtf16 < 1 ||
    limits.maxTextUtf16 > DOCUMENT_ARTIFACT_QUERY_MAX_TEXT_UTF16 ||
    !Number.isInteger(limits.maxTableCells) ||
    limits.maxTableCells < 1 ||
    limits.maxTableCells > DOCUMENT_ARTIFACT_QUERY_MAX_TABLE_CELLS
  ) {
    throw new RangeError("invalid document query limits");
  }
}

function writePageProjection(
  writer: ArtifactBinaryWriter,
  page: DocumentArtifactPageGeometryProjection,
): void {
  writer.i64(page.widthMillipoints);
  writer.i64(page.heightMillipoints);
  writer.i64(page.marginTopMillipoints);
  writer.i64(page.marginRightMillipoints);
  writer.i64(page.marginBottomMillipoints);
  writer.i64(page.marginLeftMillipoints);
}

function projectionPage(
  item: DocumentArtifactProjectionItem,
): DocumentArtifactPageGeometryProjection | null {
  return item.kind === "summary" || item.kind === "section" ? item.page : null;
}

function hasNonDefaultProjectionPageExtras(page: DocumentArtifactPageGeometryProjection): boolean {
  return (
    page.headerMillipoints !== 36_000n ||
    page.footerMillipoints !== 36_000n ||
    page.gutterMillipoints !== 0n
  );
}

function readPageProjection(reader: ArtifactBinaryReader): DocumentArtifactPageGeometryProjection {
  return Object.freeze({
    widthMillipoints: reader.i64BigInt(),
    heightMillipoints: reader.i64BigInt(),
    marginTopMillipoints: reader.i64BigInt(),
    marginRightMillipoints: reader.i64BigInt(),
    marginBottomMillipoints: reader.i64BigInt(),
    marginLeftMillipoints: reader.i64BigInt(),
    headerMillipoints: 36_000n,
    footerMillipoints: 36_000n,
    gutterMillipoints: 0n,
  });
}

function readProjectionPageExtras(
  reader: ArtifactBinaryReader,
  source: readonly DocumentArtifactProjectionItem[],
): DocumentArtifactProjectionItem[] {
  if (source.length === 0) throw new TypeError("document page extras require a page item");
  if (reader.u8() !== QUERY_RESPONSE_EXTENSION_MARKER) {
    throw new TypeError("unknown document query response extension");
  }
  if (reader.u8() !== PAGE_EXTRAS_EXTENSION_VERSION) {
    throw new TypeError("unsupported document page extras extension version");
  }
  const count = reader.count(source.length, "document page extras", 28);
  if (count === 0) throw new TypeError("empty document page extras extension");
  const items = [...source];
  let previousIndex = -1;
  for (let offset = 0; offset < count; offset += 1) {
    const index = reader.count(source.length - 1, "document page item index", 24);
    if (index <= previousIndex)
      throw new TypeError("document page extras are not strictly ordered");
    previousIndex = index;
    const item = items[index];
    if (!item || (item.kind !== "summary" && item.kind !== "section")) {
      throw new TypeError("document page extras reference a non-page item");
    }
    const page = Object.freeze({
      ...item.page,
      headerMillipoints: reader.i64BigInt(),
      footerMillipoints: reader.i64BigInt(),
      gutterMillipoints: reader.i64BigInt(),
    });
    if (!hasNonDefaultProjectionPageExtras(page)) {
      throw new TypeError("redundant document page extras");
    }
    items[index] = Object.freeze({ ...item, page });
  }
  return items;
}

function writeProjectionItem(
  writer: ArtifactBinaryWriter,
  item: DocumentArtifactProjectionItem,
  state: CodecState,
): void {
  switch (item.kind) {
    case "summary":
      writer.u8(0);
      writer.u64(item.idNamespace);
      writer.u64(item.revision);
      writer.u64(item.nextIdCounter);
      writer.u64(item.blockCount);
      writer.u64(item.sectionCount);
      writer.u64(item.commentCount);
      writer.u64(item.trackedChangeCount);
      writer.bool(item.evenAndOddHeaders);
      writer.bool(item.trackRevisions);
      writePageProjection(writer, item.page);
      return;
    case "section":
      writer.u8(1);
      writeDocumentId(writer, item.id, "section");
      writer.u64(item.startBlockIndex);
      writer.bool(item.titlePage);
      writePageProjection(writer, item.page);
      for (const count of item.headerBlockCounts) writer.u64(count);
      for (const count of item.footerBlockCounts) writer.u64(count);
      return;
    case "paragraph":
      writer.u8(2);
      writeDocumentId(writer, item.id, "paragraph");
      writeRuns(writer, item.runs, state);
      writeParagraphStyle(writer, item.style);
      return;
    case "table":
      writer.u8(3);
      writeDocumentId(writer, item.id, "table");
      writeTableRows(writer, item.rows, state);
      writeTableStyle(writer, item.style);
      return;
    case "page-break":
      writer.u8(4);
      writeDocumentId(writer, item.id, "page-break");
      return;
    case "comment":
      writer.u8(5);
      writeDocumentId(writer, item.id, "comment");
      writeDocumentId(writer, item.paragraphId, "paragraph");
      writeRange(writer, item.range);
      writer.bool(item.resolved);
      writer.count(item.replies.length, 100_000, "document comment replies");
      for (const reply of item.replies) writeCommentReply(writer, reply, state);
      return;
    case "tracked-change":
      writer.u8(6);
      writeDocumentId(writer, item.id, "tracked-change");
      writeDocumentId(writer, item.paragraphId, "paragraph");
      writer.u8(
        item.changeKind === "insert"
          ? 1
          : item.changeKind === "delete"
            ? 2
            : invalidTag("tracked change kind"),
      );
      writeRange(writer, item.range);
      writeDocumentString(writer, item.author, state, false);
      writeDocumentString(writer, item.createdAt, state, false);
      return;
    default:
      throw new TypeError("invalid document projection item kind");
  }
}

function readProjectionItem(
  reader: ArtifactBinaryReader,
  state: CodecState,
): DocumentArtifactProjectionItem {
  const tag = reader.u8();
  if (tag === 0) {
    const item = Object.freeze({
      kind: "summary" as const,
      idNamespace: reader.u64BigInt(),
      revision: reader.u64BigInt(),
      nextIdCounter: reader.u64BigInt(),
      blockCount: boundedProjectionCount(reader, 100_000, "document block count"),
      sectionCount: boundedProjectionCount(reader, 10_000, "document section count"),
      commentCount: boundedProjectionCount(reader, 100_000, "document comment count"),
      trackedChangeCount: boundedProjectionCount(reader, 100_000, "document tracked-change count"),
      evenAndOddHeaders: reader.bool("document boolean"),
      trackRevisions: reader.bool("document boolean"),
      page: readPageProjection(reader),
    });
    return item;
  }
  if (tag === 1) {
    const id = readDocumentId(reader, "section");
    const startBlockIndex = boundedProjectionCount(reader, 100_000, "document section block index");
    const titlePage = reader.bool("document boolean");
    const page = readPageProjection(reader);
    const headerBlockCounts = Object.freeze([
      boundedProjectionCount(reader, 100_000, "document header blocks"),
      boundedProjectionCount(reader, 100_000, "document header blocks"),
      boundedProjectionCount(reader, 100_000, "document header blocks"),
    ]) as readonly [number, number, number];
    const footerBlockCounts = Object.freeze([
      boundedProjectionCount(reader, 100_000, "document footer blocks"),
      boundedProjectionCount(reader, 100_000, "document footer blocks"),
      boundedProjectionCount(reader, 100_000, "document footer blocks"),
    ]) as readonly [number, number, number];
    return Object.freeze({
      kind: "section",
      id,
      startBlockIndex,
      titlePage,
      page,
      headerBlockCounts,
      footerBlockCounts,
    });
  }
  if (tag === 2)
    return Object.freeze({
      kind: "paragraph",
      id: readDocumentId(reader, "paragraph"),
      runs: readRuns(reader, state),
      style: readParagraphStyle(reader),
    });
  if (tag === 3)
    return Object.freeze({
      kind: "table",
      id: readDocumentId(reader, "table"),
      rows: readTableRows(reader, state),
      style: readTableStyle(reader),
    });
  if (tag === 4)
    return Object.freeze({ kind: "page-break", id: readDocumentId(reader, "page-break") });
  if (tag === 5) {
    const id = readDocumentId(reader, "comment");
    const paragraphId = readDocumentId(reader, "paragraph");
    const range = readRange(reader);
    const resolved = reader.bool("document boolean");
    const count = reader.count(100_000, "document comment replies");
    const replies: DocumentArtifactCommentReply[] = [];
    for (let index = 0; index < count; index += 1) replies.push(readCommentReply(reader, state));
    return Object.freeze({
      kind: "comment",
      id,
      paragraphId,
      range,
      resolved,
      replies: Object.freeze(replies),
    });
  }
  if (tag === 6) {
    const id = readDocumentId(reader, "tracked-change");
    const paragraphId = readDocumentId(reader, "paragraph");
    const kindTag = reader.u8();
    if (kindTag !== 1 && kindTag !== 2) throw new TypeError("invalid tracked change kind");
    return Object.freeze({
      kind: "tracked-change",
      id,
      paragraphId,
      changeKind: kindTag === 1 ? "insert" : "delete",
      range: readRange(reader),
      author: readDocumentString(reader, state, false),
      createdAt: readDocumentString(reader, state, false),
    });
  }
  throw new TypeError("invalid document projection item tag");
}

function boundedProjectionCount(
  reader: ArtifactBinaryReader,
  maximum: number,
  label: string,
): number {
  const value = reader.u64Safe(label);
  if (value > maximum) throw new RangeError(`${label} exceeds its limit`);
  return value;
}

function measureProjection(items: readonly DocumentArtifactProjectionItem[]): {
  text: number;
  cells: number;
} {
  let text = 0;
  let cells = 0;
  const add = (value: string): void => {
    text += value.length;
  };
  for (const item of items) {
    if (item.kind === "paragraph") for (const run of item.runs) add(run.text);
    else if (item.kind === "table")
      for (const row of item.rows) {
        cells += row.length;
        for (const cell of row) for (const run of cell) add(run.text);
      }
    else if (item.kind === "comment")
      for (const reply of item.replies) {
        add(reply.author);
        add(reply.text);
        add(reply.createdAt);
      }
    else if (item.kind === "tracked-change") {
      add(item.author);
      add(item.createdAt);
    }
    if (
      text > DOCUMENT_ARTIFACT_QUERY_MAX_TEXT_UTF16 ||
      cells > DOCUMENT_ARTIFACT_QUERY_MAX_TABLE_CELLS
    )
      throw new RangeError("document query response metrics exceed their limits");
  }
  return { text, cells };
}

function freezeOptional<T extends object, V extends Record<string, unknown>>(
  base: T,
  values: V,
): Readonly<Record<string, unknown>> {
  const output: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(values)) if (value !== undefined) output[key] = value;
  return Object.freeze(output);
}

function invalidTag(label: string): never {
  throw new TypeError(`invalid ${label}`);
}
