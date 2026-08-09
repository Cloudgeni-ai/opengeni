import type {
  DocumentPageGeometry,
  DocumentParagraphFormat,
  DocumentParagraphStyle,
  DocumentTableStyle,
  DocumentTextStyle,
  SerializedDocument,
  SerializedDocumentBlock,
  SerializedDocumentComment,
  SerializedDocumentSection,
  SerializedParagraph,
  SerializedStory,
  SerializedTable,
  SerializedTextRun,
  SerializedTrackedChange,
} from "./document";
import {
  Presentation,
  PresentationChart,
  PresentationGroup,
  PresentationImage,
  PresentationShape,
  PresentationTable,
  presentationColorValue,
  type PresentationElement,
  type PresentationFill,
  type PresentationLine,
  type PresentationPosition,
  type PresentationTemplateElement,
  type PresentationText,
  type PresentationTextStyle,
} from "./presentation";
import { UnsupportedArtifactFeatureError } from "./errors";
import { decodeRasterBase64, inspectRasterImage } from "./raster-image";
import { sha256Bytes } from "./production-sha256";

const textEncoder = new TextEncoder();
const DOCUMENT_COMMAND_MAX_BYTES = 64 * 1024 * 1024;
const DOCUMENT_COMMAND_MAX_COUNT = 4_096;
const PRESENTATION_COMMAND_MAX_BYTES = 4 * 1024 * 1024;
const PRESENTATION_COMMAND_MAX_COUNT = 10_000;
const HEADER_BYTES = 24;
const CHECKSUM_BYTES = 8;
const EMU_PER_CSS_PIXEL = 9_525;
const PRESENTATION_MAX_COORDINATE_EMU = 9_525_000_000_000;

export function encodeDocumentProjectionCommands(snapshot: SerializedDocument): Uint8Array {
  const payload = new ByteWriter(DOCUMENT_COMMAND_MAX_BYTES - HEADER_BYTES - CHECKSUM_BYTES);
  let commandCount = 0;
  const command = (write: () => void): void => {
    commandCount += 1;
    if (commandCount > DOCUMENT_COMMAND_MAX_COUNT) {
      throw new RangeError("Document projection exceeds the native command-count limit");
    }
    write();
  };

  const firstSection = snapshot.sections[0];
  if (!firstSection || firstSection.startBlockIndex !== 0) {
    throw new Error("Document projection requires one initial section at body offset zero");
  }
  assertInitialDocumentSectionIds(firstSection, snapshot.idNamespace);

  if (snapshot.evenAndOddHeaders !== undefined || snapshot.trackRevisions !== undefined) {
    command(() => {
      payload.u8(0);
      payload.u8(optionalOptionalBool(snapshot.evenAndOddHeaders));
      payload.u8(optionalOptionalBool(snapshot.trackRevisions));
    });
  }
  if (firstSection.titlePage !== undefined) {
    command(() => {
      payload.u8(9);
      payload.documentId(firstSection.id, "sec");
      payload.u8(optionalBool(firstSection.titlePage));
    });
  }
  if (!isDefaultNativeDocumentPage(firstSection.page)) {
    command(() => {
      payload.u8(14);
      payload.documentId(firstSection.id, "sec");
      payload.pageWithExtras(firstSection.page);
    });
  }

  const laterSections = new Map<number, SerializedDocumentSection>();
  for (const section of snapshot.sections.slice(1)) {
    if (laterSections.has(section.startBlockIndex)) {
      throw new Error("Document projection contains adjacent sections without a body block");
    }
    laterSections.set(section.startBlockIndex, section);
  }
  for (let index = 0; index <= snapshot.blocks.length; index += 1) {
    const section = laterSections.get(index);
    if (section) {
      command(() => writeAddSection(payload, section));
      if (hasNonDefaultDocumentPageExtras(section.page)) {
        command(() => {
          payload.u8(14);
          payload.documentId(section.id, "sec");
          payload.pageWithExtras(section.page);
        });
      }
    }
    const block = snapshot.blocks[index];
    if (block) command(() => writeDocumentBlock(payload, block, { kind: "body" }));
  }
  if ([...laterSections.keys()].some((index) => index > snapshot.blocks.length)) {
    throw new Error("Document section starts beyond the body block list");
  }

  for (const section of snapshot.sections) {
    writeDocumentStoryCommands(
      payload,
      command,
      section,
      "header",
      "default",
      section.headers.default,
    );
    writeDocumentStoryCommands(payload, command, section, "header", "first", section.headers.first);
    writeDocumentStoryCommands(payload, command, section, "header", "even", section.headers.even);
    writeDocumentStoryCommands(
      payload,
      command,
      section,
      "footer",
      "default",
      section.footers.default,
    );
    writeDocumentStoryCommands(payload, command, section, "footer", "first", section.footers.first);
    writeDocumentStoryCommands(payload, command, section, "footer", "even", section.footers.even);
  }

  for (const thread of snapshot.comments) {
    const root = thread.replies[0];
    if (!root) throw new Error(`Document comment ${thread.id} has no root reply`);
    command(() => {
      payload.u8(10);
      payload.documentId(thread.id, "dc");
      payload.documentId(thread.blockId, "p");
      payload.u32(thread.start);
      payload.u32(thread.end);
      payload.bool(thread.resolved);
      payload.commentReply(root);
    });
    for (const reply of thread.replies.slice(1)) {
      command(() => {
        payload.u8(11);
        payload.documentId(thread.id, "dc");
        payload.commentReply(reply);
      });
    }
  }
  for (const change of snapshot.changes) {
    command(() => {
      payload.u8(13);
      payload.documentId(change.id, "chg");
      payload.documentId(change.blockId, "p");
      payload.u32(change.start);
      payload.u32(change.end);
      payload.u8(change.kind === "insert" ? 1 : 2);
      payload.string(change.author);
      payload.string(change.createdAt);
    });
  }

  return envelope("OGADC001", commandCount, payload.finish(), DOCUMENT_COMMAND_MAX_BYTES);
}

export type DocumentProjectionTarget =
  | { kind: "body" }
  | {
      kind: "story";
      sectionId: string;
      storyKind: "header" | "footer";
      variant: "default" | "first" | "even";
    };

export type DocumentIncrementalCommand =
  | { kind: "block.add"; target: DocumentProjectionTarget; block: SerializedDocumentBlock }
  | {
      kind: "paragraph.edit";
      id: string;
      start: number;
      end: number;
      text: string;
      style?: DocumentTextStyle;
    }
  | { kind: "paragraph.format"; id: string; format: DocumentParagraphFormat }
  | { kind: "paragraph.style"; id: string; style: DocumentParagraphStyle }
  | { kind: "table.style"; id: string; style: DocumentTableStyle }
  | { kind: "document.flags"; evenAndOddHeaders?: boolean; trackRevisions?: boolean }
  | { kind: "section.add"; section: SerializedDocumentSection }
  | { kind: "section.title"; id: string; titlePage?: boolean }
  | { kind: "comment.add"; comment: SerializedDocumentComment }
  | { kind: "comment.reply"; id: string; reply: SerializedDocumentComment["replies"][number] }
  | { kind: "comment.resolved"; id: string; resolved: boolean }
  | { kind: "tracked.add"; change: SerializedTrackedChange };

/** Encodes only touched document nodes using the existing OGADC001 protocol. */
export function encodeDocumentIncrementalCommands(
  commands: readonly DocumentIncrementalCommand[],
): Uint8Array {
  const payload = new ByteWriter(DOCUMENT_COMMAND_MAX_BYTES - HEADER_BYTES - CHECKSUM_BYTES);
  if (commands.length === 0 || commands.length > DOCUMENT_COMMAND_MAX_COUNT) {
    throw new RangeError("Document incremental command count is outside its limit");
  }
  for (const command of commands) {
    switch (command.kind) {
      case "block.add":
        writeDocumentBlock(payload, command.block, command.target);
        break;
      case "paragraph.edit":
        payload.u8(2);
        payload.documentId(command.id, "p");
        payload.u32(command.start);
        payload.u32(command.end);
        payload.string(command.text);
        payload.bool(command.style !== undefined);
        if (command.style) payload.textStyle(command.style);
        break;
      case "paragraph.format":
        payload.u8(3);
        payload.documentId(command.id, "p");
        payload.u32(command.format.start);
        payload.u32(command.format.end);
        payload.textStylePatch(command.format.style);
        break;
      case "paragraph.style":
        payload.u8(4);
        payload.documentId(command.id, "p");
        payload.paragraphStyle(command.style);
        break;
      case "table.style":
        payload.u8(6);
        payload.documentId(command.id, "dt");
        payload.tableStyle(command.style);
        break;
      case "document.flags":
        payload.u8(0);
        payload.u8(optionalOptionalBool(command.evenAndOddHeaders));
        payload.u8(optionalOptionalBool(command.trackRevisions));
        break;
      case "section.add":
        writeAddSection(payload, command.section);
        if (hasNonDefaultDocumentPageExtras(command.section.page)) {
          payload.u8(14);
          payload.documentId(command.section.id, "sec");
          payload.pageWithExtras(command.section.page);
        }
        break;
      case "section.title":
        payload.u8(9);
        payload.documentId(command.id, "sec");
        payload.u8(optionalBool(command.titlePage));
        break;
      case "comment.add": {
        const root = command.comment.replies[0];
        if (!root) throw new Error(`Document comment ${command.comment.id} has no root reply`);
        payload.u8(10);
        payload.documentId(command.comment.id, "dc");
        payload.documentId(command.comment.blockId, "p");
        payload.u32(command.comment.start);
        payload.u32(command.comment.end);
        payload.bool(command.comment.resolved);
        payload.commentReply(root);
        break;
      }
      case "comment.reply":
        payload.u8(11);
        payload.documentId(command.id, "dc");
        payload.commentReply(command.reply);
        break;
      case "comment.resolved":
        payload.u8(12);
        payload.documentId(command.id, "dc");
        payload.bool(command.resolved);
        break;
      case "tracked.add":
        payload.u8(13);
        payload.documentId(command.change.id, "chg");
        payload.documentId(command.change.blockId, "p");
        payload.u32(command.change.start);
        payload.u32(command.change.end);
        payload.u8(command.change.kind === "insert" ? 1 : 2);
        payload.string(command.change.author);
        payload.string(command.change.createdAt);
        break;
    }
  }
  // Section page extras are a second command in the same atomic batch.
  const commandCount =
    commands.length +
    commands.filter(
      (command) =>
        command.kind === "section.add" && hasNonDefaultDocumentPageExtras(command.section.page),
    ).length;
  return envelope("OGADC001", commandCount, payload.finish(), DOCUMENT_COMMAND_MAX_BYTES);
}

export function encodePresentationProjectionCommands(
  presentation: Presentation,
  namespace: bigint,
): Uint8Array {
  const hasCustomSlideSize =
    presentation.slideSize.width !== 1_280 || presentation.slideSize.height !== 720;
  if (hasCustomSlideSize) {
    assertFinitePositive(presentation.slideSize.width, "presentation slide width");
    assertFinitePositive(presentation.slideSize.height, "presentation slide height");
  }
  const payload = new ByteWriter(PRESENTATION_COMMAND_MAX_BYTES - HEADER_BYTES - CHECKSUM_BYTES);
  let commandCount = 0;
  const command = (write: () => void): void => {
    commandCount += 1;
    if (commandCount > PRESENTATION_COMMAND_MAX_COUNT) {
      throw new RangeError("Presentation projection exceeds the native command-count limit");
    }
    write();
  };
  if (hasCustomSlideSize) {
    command(() => {
      payload.u8(15);
      payload.i64(presentationSizeEmu(presentation.slideSize.width, "presentation slide width"));
      payload.i64(presentationSizeEmu(presentation.slideSize.height, "presentation slide height"));
    });
  }
  let templateElementCounter = 0xffff_ffff_ffff_ffffn;
  const nextTemplateElementId = (): string => {
    if (templateElementCounter === 0n) {
      throw new RangeError("Presentation template element id space is exhausted");
    }
    return `sh/${templateElementCounter--}`;
  };

  for (const master of presentation.masters.items) {
    command(() => {
      payload.u8(0);
      payload.presentationId(master.id, namespace);
      payload.string(master.name);
      payload.fill(master.background);
    });
    for (const [index, template] of master.elements.entries()) {
      const element = materializeTemplateElement(template);
      writePresentationElement(
        payload,
        command,
        element,
        namespace,
        { tag: 0, id: master.id },
        undefined,
        index,
        nextTemplateElementId(),
      );
    }
  }
  for (const layout of presentation.layouts.items) {
    command(() => {
      payload.u8(1);
      payload.presentationId(layout.id, namespace);
      payload.string(layout.name);
      payload.optionalPresentationId(layout.masterId, namespace);
      payload.fill(layout.background);
    });
    for (const [index, template] of layout.elements.entries()) {
      const element = materializeTemplateElement(template);
      writePresentationElement(
        payload,
        command,
        element,
        namespace,
        { tag: 1, id: layout.id },
        undefined,
        index,
        nextTemplateElementId(),
      );
    }
  }
  for (const [slideIndex, slide] of presentation.slides.items.entries()) {
    command(() => {
      payload.u8(2);
      payload.presentationId(slide.id, namespace);
      payload.u32(slideIndex);
      payload.string(slide.title);
      payload.optionalPresentationId(slide.layout?.id, namespace);
      payload.fill(slide.background.fill);
    });
    if (slide.notes.toString().length > 0) {
      command(() => {
        payload.u8(8);
        payload.presentationId(slide.id, namespace);
        payload.richText(slide.notes);
      });
    }
    for (const [index, element] of slide.elements.entries()) {
      writePresentationElement(
        payload,
        command,
        element,
        namespace,
        { tag: 2, id: slide.id },
        undefined,
        index,
      );
    }
  }
  return envelope("OGAPC001", commandCount, payload.finish(), PRESENTATION_COMMAND_MAX_BYTES);
}

export type PresentationIncrementalCommand =
  | { kind: "slide.create"; slide: Presentation["slides"]["items"][number]; index: number }
  | { kind: "slide.title"; id: string; title: string }
  | { kind: "slide.layout"; id: string; layoutId?: string }
  | { kind: "slide.notes"; id: string; notes: PresentationText }
  | { kind: "node.insert"; slideId: string; index: number; element: PresentationElement }
  | { kind: "node.update"; element: PresentationElement }
  | { kind: "presentation.size"; width: number; height: number };

/** Encodes touched presentation nodes using the existing OGAPC001 protocol. */
export function encodePresentationIncrementalCommands(
  commands: readonly PresentationIncrementalCommand[],
  namespace: bigint,
): Uint8Array {
  const payload = new ByteWriter(PRESENTATION_COMMAND_MAX_BYTES - HEADER_BYTES - CHECKSUM_BYTES);
  let commandCount = 0;
  const command = (write: () => void): void => {
    commandCount += 1;
    if (commandCount > PRESENTATION_COMMAND_MAX_COUNT) {
      throw new RangeError("Presentation incremental command count is outside its limit");
    }
    write();
  };
  for (const entry of commands) {
    switch (entry.kind) {
      case "slide.create":
        command(() => {
          payload.u8(2);
          payload.presentationId(entry.slide.id, namespace);
          payload.u32(entry.index);
          payload.string(entry.slide.title);
          payload.optionalPresentationId(entry.slide.layout?.id, namespace);
          payload.fill(entry.slide.background.fill);
        });
        break;
      case "slide.title":
        command(() => {
          payload.u8(6);
          payload.presentationId(entry.id, namespace);
          payload.string(entry.title);
        });
        break;
      case "slide.layout":
        command(() => {
          payload.u8(7);
          payload.presentationId(entry.id, namespace);
          payload.optionalPresentationId(entry.layoutId, namespace);
        });
        break;
      case "slide.notes":
        command(() => {
          payload.u8(8);
          payload.presentationId(entry.id, namespace);
          payload.richText(entry.notes);
        });
        break;
      case "node.insert":
        writePresentationElement(
          payload,
          command,
          entry.element,
          namespace,
          { tag: 2, id: entry.slideId },
          undefined,
          entry.index,
        );
        break;
      case "node.update":
        command(() => {
          payload.u8(12);
          payload.presentationId(entry.element.id, namespace);
          payload.presentationRect(entry.element.position);
        });
        command(() => {
          payload.u8(13);
          payload.presentationId(entry.element.id, namespace);
          payload.presentationTransform(
            "rotation" in entry.element ? entry.element.rotation : 0,
            "flipHorizontal" in entry.element ? entry.element.flipHorizontal : false,
            "flipVertical" in entry.element ? entry.element.flipVertical : false,
          );
        });
        command(() => {
          payload.u8(14);
          payload.presentationId(entry.element.id, namespace);
          payload.presentationNode(entry.element);
        });
        break;
      case "presentation.size":
        command(() => {
          payload.u8(15);
          payload.i64(presentationSizeEmu(entry.width, "presentation slide width"));
          payload.i64(presentationSizeEmu(entry.height, "presentation slide height"));
        });
        break;
    }
  }
  if (commandCount === 0) throw new RangeError("Presentation incremental command batch is empty");
  return envelope("OGAPC001", commandCount, payload.finish(), PRESENTATION_COMMAND_MAX_BYTES);
}

type NativePresentationSceneOwner = Readonly<{ tag: 0 | 1 | 2; id: string }>;

/**
 * Template configs intentionally are not scene objects in the public model.
 * Materialize them through the same constructors used by ordinary slides so
 * native projection receives the exact same validation and normalization.
 */
function materializeTemplateElement(template: PresentationTemplateElement): PresentationElement {
  const scratch = Presentation.create();
  const slide = scratch.slides.add();
  switch (template.kind) {
    case "shape":
      return slide.shapes.add(template.config);
    case "chart":
      return slide.charts.add(template.type, template.config);
    case "image":
      return slide.images.add(template.config);
    case "table":
      return slide.tables.add(template.config);
  }
}

function writeDocumentStoryCommands(
  writer: ByteWriter,
  command: (write: () => void) => void,
  section: SerializedDocumentSection,
  kind: "header" | "footer",
  variant: "default" | "first" | "even",
  story: SerializedStory,
): void {
  const expectedPrefix = kind === "header" ? "hdr" : "ftr";
  writer.assertDocumentId(story.id, expectedPrefix);
  for (const block of story.blocks) {
    command(() =>
      writeDocumentBlock(writer, block, {
        kind: "story",
        sectionId: section.id,
        storyKind: kind,
        variant,
      }),
    );
  }
}

type DocumentTarget = DocumentProjectionTarget;

function writeDocumentBlock(
  writer: ByteWriter,
  block: SerializedDocumentBlock | SerializedParagraph | SerializedTable,
  target: DocumentTarget,
): void {
  if (block.kind === "paragraph") {
    writer.u8(1);
    writer.documentTarget(target);
    writer.documentId(block.id, "p");
    writer.textRuns(block.runs);
    writer.paragraphStyle(block.style);
    return;
  }
  if (block.kind === "table") {
    writer.u8(5);
    writer.documentTarget(target);
    writer.documentId(block.id, "dt");
    writer.u32(block.rows.length);
    for (const row of block.rows) {
      writer.u32(row.length);
      for (const cell of row) writer.textRuns(cell);
    }
    writer.tableStyle(block.style);
    return;
  }
  if (target.kind !== "body") {
    throw new Error("Document story cannot contain a page break");
  }
  writer.u8(7);
  writer.documentId(block.id, "pb");
}

function writeAddSection(writer: ByteWriter, section: SerializedDocumentSection): void {
  writer.u8(8);
  writer.documentId(section.id, "sec");
  writer.documentId(section.headers.default.id, "hdr");
  writer.documentId(section.headers.first.id, "hdr");
  writer.documentId(section.headers.even.id, "hdr");
  writer.documentId(section.footers.default.id, "ftr");
  writer.documentId(section.footers.first.id, "ftr");
  writer.documentId(section.footers.even.id, "ftr");
  writer.page(section.page);
  writer.u8(optionalBool(section.titlePage));
}

function assertInitialDocumentSectionIds(
  section: SerializedDocumentSection,
  namespace: string,
): void {
  const expected = [
    [section.id, "sec", 1n],
    [section.headers.default.id, "hdr", 2n],
    [section.headers.first.id, "hdr", 3n],
    [section.headers.even.id, "hdr", 4n],
    [section.footers.default.id, "ftr", 5n],
    [section.footers.first.id, "ftr", 6n],
    [section.footers.even.id, "ftr", 7n],
  ] as const;
  for (const [id, prefix, counter] of expected) {
    const parsed = parseDocumentId(id, prefix);
    if (parsed.namespace !== BigInt(`0x${namespace}`) || parsed.counter !== counter) {
      throw new Error("Initial document structural ids do not match the native document allocator");
    }
  }
}

function isDefaultNativeDocumentPage(page: DocumentPageGeometry): boolean {
  return (
    page.widthPt === 612 &&
    page.heightPt === 792 &&
    page.marginTopPt === 72 &&
    page.marginRightPt === 72 &&
    page.marginBottomPt === 72 &&
    page.marginLeftPt === 72 &&
    !hasNonDefaultDocumentPageExtras(page)
  );
}

function hasNonDefaultDocumentPageExtras(page: DocumentPageGeometry): boolean {
  return (page.headerPt ?? 36) !== 36 || (page.footerPt ?? 36) !== 36 || (page.gutterPt ?? 0) !== 0;
}

function writePresentationElement(
  writer: ByteWriter,
  command: (write: () => void) => void,
  element: PresentationElement,
  namespace: bigint,
  owner: NativePresentationSceneOwner,
  parentId: string | undefined,
  index: number,
  idOverride?: string,
): void {
  const elementId = idOverride ?? element.id;
  command(() => {
    writer.u8(9);
    writer.u8(owner.tag);
    writer.presentationId(owner.id, namespace);
    writer.optionalPresentationId(parentId, namespace);
    writer.u32(index);
    writer.presentationId(elementId, namespace);
    writer.string(element.name);
    writer.presentationRect(element.position);
    writer.presentationTransform(
      "rotation" in element ? element.rotation : 0,
      "flipHorizontal" in element ? element.flipHorizontal : false,
      "flipVertical" in element ? element.flipVertical : false,
    );
    writer.presentationNode(element);
  });
  if (element instanceof PresentationGroup) {
    for (const [childIndex, child] of element.children.entries()) {
      writePresentationElement(writer, command, child, namespace, owner, elementId, childIndex);
    }
  }
}

function unsupportedPresentation(feature: string): never {
  throw new UnsupportedArtifactFeatureError("presentation", feature, "native Rust projection");
}

class ByteWriter {
  readonly #bytes: number[] = [];
  constructor(private readonly maximum: number) {}

  finish(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
  bytes(value: Uint8Array): void {
    if (this.#bytes.length + value.byteLength > this.maximum) {
      throw new RangeError("Native projection command envelope exceeds its byte limit");
    }
    this.#bytes.push(...value);
  }
  u8(value: number): void {
    this.bytes(Uint8Array.of(value));
  }
  bool(value: boolean): void {
    this.u8(value ? 1 : 0);
  }
  u16(value: number): void {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value, true);
    this.bytes(bytes);
  }
  u32(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new RangeError("Native projection integer is outside u32");
    }
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    this.bytes(bytes);
  }
  i32(value: number): void {
    if (!Number.isSafeInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
      throw new RangeError("Native projection integer is outside i32");
    }
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setInt32(0, value, true);
    this.bytes(bytes);
  }
  u64(value: bigint): void {
    if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
      throw new RangeError("Native projection integer is outside u64");
    }
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    this.bytes(bytes);
  }
  i64(value: bigint): void {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigInt64(0, value, true);
    this.bytes(bytes);
  }
  f64(value: number): void {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError("Native projection numbers must be finite canonical doubles");
    }
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    this.bytes(bytes);
  }
  string(value: string): void {
    const encoded = textEncoder.encode(value);
    this.u32(encoded.byteLength);
    this.bytes(encoded);
  }
  optionalString(value: string | undefined): void {
    this.bool(value !== undefined);
    if (value !== undefined) this.string(value);
  }
  assertDocumentId(id: string, expectedPrefix: string): void {
    parseDocumentId(id, expectedPrefix);
  }
  documentId(id: string, expectedPrefix: string): void {
    const parsed = parseDocumentId(id, expectedPrefix);
    this.u8(documentKindTag(expectedPrefix));
    this.u64(parsed.namespace);
    this.u64(parsed.counter);
  }
  documentTarget(target: DocumentTarget): void {
    if (target.kind === "body") {
      this.u8(0);
      return;
    }
    this.u8(1);
    this.documentId(target.sectionId, "sec");
    this.u8(target.storyKind === "header" ? 1 : 2);
    this.u8(target.variant === "default" ? 1 : target.variant === "first" ? 2 : 3);
  }
  page(page: DocumentPageGeometry): void {
    this.f64(page.widthPt);
    this.f64(page.heightPt);
    this.f64(page.marginTopPt);
    this.f64(page.marginRightPt);
    this.f64(page.marginBottomPt);
    this.f64(page.marginLeftPt);
  }
  pageWithExtras(page: DocumentPageGeometry): void {
    this.page(page);
    this.f64(page.headerPt ?? 36);
    this.f64(page.footerPt ?? 36);
    this.f64(page.gutterPt ?? 0);
  }
  textRuns(runs: readonly SerializedTextRun[]): void {
    this.u32(runs.length);
    for (const run of runs) {
      this.string(run.text);
      this.textStyle(run.style);
    }
  }
  textStyle(style: DocumentTextStyle): void {
    const mask =
      Number(style.fontFamily !== undefined) |
      (Number(style.fontSizePt !== undefined) << 1) |
      (Number(style.color !== undefined) << 2) |
      (Number(style.bold !== undefined) << 3) |
      (Number(style.italic !== undefined) << 4) |
      (Number(style.underline !== undefined) << 5) |
      (Number(style.strike !== undefined) << 6);
    this.u8(mask);
    if (style.fontFamily !== undefined) this.string(style.fontFamily);
    if (style.fontSizePt !== undefined) this.f64(style.fontSizePt);
    if (style.color !== undefined) this.string(style.color);
    for (const value of [style.bold, style.italic, style.underline, style.strike]) {
      if (value !== undefined) this.bool(value);
    }
  }
  textStylePatch(style: DocumentParagraphFormat["style"]): void {
    this.patchString(style.fontFamily);
    this.patchF64(style.fontSizePt);
    this.patchString(style.color);
    this.patchBool(style.bold);
    this.patchBool(style.italic);
    this.patchBool(style.underline);
    this.patchBool(style.strike);
  }
  private patchString(value: string | null | undefined): void {
    this.u8(value === undefined ? 0 : value === null ? 1 : 2);
    if (typeof value === "string") this.string(value);
  }
  private patchF64(value: number | null | undefined): void {
    this.u8(value === undefined ? 0 : value === null ? 1 : 2);
    if (typeof value === "number") this.f64(value);
  }
  private patchBool(value: boolean | null | undefined): void {
    this.u8(value === undefined ? 0 : value === null ? 1 : value ? 3 : 2);
  }
  paragraphStyle(style: DocumentParagraphStyle): void {
    const mask =
      Number(style.headingLevel !== undefined) |
      (Number(style.alignment !== undefined) << 1) |
      (Number(style.spaceBeforePt !== undefined) << 2) |
      (Number(style.spaceAfterPt !== undefined) << 3) |
      (Number(style.lineHeight !== undefined) << 4) |
      (Number(style.keepNext !== undefined) << 5) |
      (Number(style.pageBreakBefore !== undefined) << 6) |
      (Number(style.list !== undefined) << 7);
    this.u16(mask);
    if (style.headingLevel !== undefined) this.u8(style.headingLevel);
    if (style.alignment !== undefined) {
      this.u8({ left: 1, center: 2, right: 3, justify: 4 }[style.alignment]);
    }
    for (const value of [style.spaceBeforePt, style.spaceAfterPt, style.lineHeight]) {
      if (value !== undefined) this.f64(value);
    }
    for (const value of [style.keepNext, style.pageBreakBefore]) {
      if (value !== undefined) this.bool(value);
    }
    if (style.list) {
      this.u8(style.list.kind === "bullet" ? 1 : 2);
      this.bool(style.list.level !== undefined);
      if (style.list.level !== undefined) this.u8(style.list.level);
      this.optionalString(style.list.instanceId);
    }
  }
  tableStyle(style: DocumentTableStyle): void {
    const mask =
      Number(style.widthPt !== undefined) |
      (Number(style.columnWidthsPt !== undefined) << 1) |
      (Number(style.headerRows !== undefined) << 2) |
      (Number(style.cellPaddingPt !== undefined) << 3) |
      (Number(style.borderColor !== undefined) << 4) |
      (Number(style.headerFill !== undefined) << 5) |
      (Number(style.allowRowSplit !== undefined) << 6);
    this.u8(mask);
    if (style.widthPt !== undefined) this.f64(style.widthPt);
    if (style.columnWidthsPt !== undefined) {
      this.u32(style.columnWidthsPt.length);
      for (const width of style.columnWidthsPt) this.f64(width);
    }
    if (style.headerRows !== undefined) this.u32(style.headerRows);
    if (style.cellPaddingPt !== undefined) this.f64(style.cellPaddingPt);
    if (style.borderColor !== undefined) this.string(style.borderColor);
    if (style.headerFill !== undefined) this.string(style.headerFill);
    if (style.allowRowSplit !== undefined) this.bool(style.allowRowSplit);
  }
  commentReply(reply: { author: string; text: string; createdAt: string }): void {
    this.string(reply.author);
    this.string(reply.text);
    this.string(reply.createdAt);
  }
  presentationId(id: string, namespace: bigint): void {
    const counter = presentationCounter(id);
    this.u64(counter);
    this.u64(namespace);
  }
  optionalPresentationId(id: string | undefined, namespace: bigint): void {
    this.bool(id !== undefined);
    if (id !== undefined) this.presentationId(id, namespace);
  }
  fill(fill: PresentationFill): void {
    const value = presentationColorValue(fill);
    if (value === "none") {
      this.u8(0);
      return;
    }
    this.u8(1);
    const rgb = Number.parseInt(value.slice(1), 16);
    this.u32((rgb * 256 + 0xff) >>> 0);
  }
  line(line: PresentationLine): void {
    this.fill(line.fill ?? "black");
    this.i64(cssPixels(line.width ?? 1));
    this.u8(line.style === "dash" ? 1 : line.style === "dot" ? 2 : 0);
  }
  presentationRect(position: PresentationPosition): void {
    this.i64(cssPixels(position.left));
    this.i64(cssPixels(position.top));
    this.i64(cssPixels(position.width));
    this.i64(cssPixels(position.height));
  }
  presentationTransform(rotation: number, flipHorizontal: boolean, flipVertical: boolean): void {
    this.i32(Math.round(rotation * 60_000));
    this.bool(flipHorizontal);
    this.bool(flipVertical);
  }
  richText(text: PresentationText, fallbackStyle: PresentationTextStyle = {}): void {
    const style = { ...fallbackStyle, ...text.style };
    this.u8(
      style.verticalAlignment === "middle" ? 1 : style.verticalAlignment === "bottom" ? 2 : 0,
    );
    this.u32(1);
    this.u8(
      style.alignment === "center"
        ? 1
        : style.alignment === "right"
          ? 2
          : style.alignment === "justify"
            ? 3
            : 0,
    );
    this.u32(1);
    this.string(text.toString());
    this.presentationTextStyle(style);
  }
  plainRichText(value: string, style: PresentationTextStyle = {}): void {
    this.u8(
      style.verticalAlignment === "middle" ? 1 : style.verticalAlignment === "bottom" ? 2 : 0,
    );
    this.u32(1);
    this.u8(
      style.alignment === "center"
        ? 1
        : style.alignment === "right"
          ? 2
          : style.alignment === "justify"
            ? 3
            : 0,
    );
    this.u32(1);
    this.string(value);
    this.presentationTextStyle(style);
  }
  presentationTextStyle(style: PresentationTextStyle): void {
    this.string(style.fontFamily ?? "Arial");
    this.u32(Math.round((style.fontSize ?? 18) * 100));
    const color = presentationColorValue(style.color ?? "black");
    const rgb = color === "none" ? 0 : Number.parseInt(color.slice(1), 16);
    this.u32((rgb * 256 + (color === "none" ? 0 : 0xff)) >>> 0);
    this.bool(style.bold ?? false);
    this.bool(style.italic ?? false);
    this.bool(style.underline ?? false);
    this.bool(false);
  }
  presentationNode(element: PresentationElement): void {
    if (element instanceof PresentationShape) {
      this.u8(0);
      this.u8(
        { textbox: 0, rect: 1, roundRect: 2, ellipse: 3, triangle: 4, rightArrow: 5, line: 6 }[
          element.geometry
        ],
      );
      this.fill(element.fill);
      this.line(element.line);
      const hasText = element.text.toString().length > 0;
      this.bool(hasText);
      if (hasText) this.richText(element.text);
      this.bool(element.placeholder !== undefined);
      if (element.placeholder) {
        this.string(element.placeholder.type);
        this.bool(element.placeholder.index !== undefined);
        if (element.placeholder.index !== undefined) this.u32(element.placeholder.index);
      }
      return;
    }
    if (element instanceof PresentationGroup) {
      this.u8(1);
      this.i64(cssPixels(element.childOffset.left));
      this.i64(cssPixels(element.childOffset.top));
      this.i64(cssPixels(element.childExtent.width));
      this.i64(cssPixels(element.childExtent.height));
      this.u32(0);
      return;
    }
    if (element instanceof PresentationChart) {
      this.u8(3);
      this.u8(
        { bar: 0, line: 1, area: 2, pie: 3, doughnut: 4, scatter: 5, bubble: 6, radar: 7 }[
          element.type
        ],
      );
      this.plainRichText(element.title);
      this.u32(element.series.items.length);
      for (const series of element.series.items) {
        this.string(series.name);
        this.stringVector(series.categories.length > 0 ? series.categories : element.categories);
        this.numberVector(series.values);
        this.numberVector(series.xValues);
        this.numberVector(series.bubbleSizes);
      }
      this.bool(element.hasLegend);
      return;
    }
    if (element instanceof PresentationTable) {
      this.u8(4);
      this.u32(element.rows.length);
      this.u32(element.rows[0]?.length ?? 0);
      for (const row of element.rows) {
        for (const cell of row) {
          this.bool(cell !== null);
          if (cell) {
            this.richText(cell.text, element.textStyle);
            this.fill(cell.fill);
            this.u16(cell.rowSpan);
            this.u16(cell.colSpan);
          }
        }
      }
      this.u32(element.columnWidths.length);
      for (const width of element.columnWidths) this.i64(cssPixels(width));
      this.u32(element.rowHeights.length);
      for (const height of element.rowHeights) this.i64(cssPixels(height));
      this.line(element.line);
      return;
    }
    if (element instanceof PresentationImage) {
      const source = element.sourceForSvg();
      if (!source) {
        unsupportedPresentation("prompt-only raster image scene nodes");
      }
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(source);
      if (!match) throw new Error(`Presentation image ${element.id} has a non-canonical source`);
      const bytes = decodeRasterBase64(match[2]!);
      const metadata = inspectRasterImage(bytes);
      if (metadata.contentType !== match[1] || metadata.contentType !== element.contentType) {
        throw new Error(`Presentation image ${element.id} MIME metadata diverged`);
      }
      this.u8(5);
      this.bytes(sha256Bytes(bytes));
      this.string(metadata.contentType);
      this.string(element.alt);
      this.u8(element.fit === "contain" ? 0 : 1);
      this.u32(metadata.width);
      this.u32(metadata.height);
      return;
    }
    unsupportedPresentation("unknown scene node");
  }
  stringVector(values: readonly string[]): void {
    this.u32(values.length);
    for (const value of values) this.string(value);
  }
  numberVector(values: readonly number[]): void {
    this.u32(values.length);
    for (const value of values) this.f64(value);
  }
}

function envelope(magic: string, count: number, payload: Uint8Array, maximum: number): Uint8Array {
  const output = new Uint8Array(HEADER_BYTES + payload.byteLength + CHECKSUM_BYTES);
  if (output.byteLength > maximum) throw new RangeError(`${magic} envelope exceeds its byte limit`);
  output.set(textEncoder.encode(magic), 0);
  const view = new DataView(output.buffer);
  view.setUint16(8, 1, true);
  view.setUint32(12, count, true);
  view.setBigUint64(16, BigInt(payload.byteLength), true);
  output.set(payload, HEADER_BYTES);
  view.setBigUint64(HEADER_BYTES + payload.byteLength, fnv1a64(output.subarray(0, -8)), true);
  return output;
}

function parseDocumentId(
  id: string,
  expectedPrefix: string,
): { namespace: bigint; counter: bigint } {
  const match = /^([a-z]{1,8})\/([0-9a-f]{16})([0-9a-f]{16})$/u.exec(id);
  if (!match || match[1] !== expectedPrefix) {
    throw new Error(`Document id ${id} is not a canonical ${expectedPrefix} id`);
  }
  const counter = BigInt(`0x${match[3]}`);
  if (counter === 0n) throw new Error(`Document id ${id} uses the reserved zero counter`);
  return { namespace: BigInt(`0x${match[2]}`), counter };
}

function documentKindTag(prefix: string): number {
  const tag = { p: 1, dt: 2, pb: 3, sec: 4, hdr: 5, ftr: 6, dc: 7, chg: 8 }[prefix];
  if (!tag) throw new Error(`Unknown document id prefix: ${prefix}`);
  return tag;
}

function presentationCounter(id: string): bigint {
  const match = /^[a-z]{2}\/([1-9][0-9]*)$/u.exec(id);
  if (!match) throw new Error(`Presentation object id is not canonical: ${id}`);
  const counter = BigInt(match[1]!);
  if (counter > 0xffff_ffff_ffff_ffffn) throw new RangeError("Presentation object id is exhausted");
  return counter;
}

function optionalBool(value: boolean | undefined): number {
  return value === undefined ? 0 : value ? 2 : 1;
}

function optionalOptionalBool(value: boolean | undefined): number {
  return value === undefined ? 0 : value ? 3 : 2;
}

function cssPixels(value: number): bigint {
  if (!Number.isFinite(value) || Object.is(value, -0)) {
    throw new TypeError("Presentation geometry must contain finite canonical numbers");
  }
  return BigInt(Math.round(value * EMU_PER_CSS_PIXEL));
}

function assertFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0)
    throw new TypeError(`${label} must be positive and finite`);
}

function presentationSizeEmu(value: number, label: string): bigint {
  assertFinitePositive(value, label);
  const rounded = Math.round(value * EMU_PER_CSS_PIXEL);
  if (!Number.isSafeInteger(rounded) || rounded <= 0 || rounded > PRESENTATION_MAX_COORDINATE_EMU) {
    throw new RangeError(`${label} exceeds the native presentation-coordinate bound`);
  }
  return BigInt(rounded);
}

function fnv1a64(bytes: Uint8Array): bigint {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
}
