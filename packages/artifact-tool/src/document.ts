import { FileBlob } from "./file-blob";
import type { HelpOptions, InspectOptions, InspectResult } from "./spreadsheet-types";

export type DocumentPageGeometry = {
  readonly widthPt: number;
  readonly heightPt: number;
  readonly marginTopPt: number;
  readonly marginRightPt: number;
  readonly marginBottomPt: number;
  readonly marginLeftPt: number;
  /** Distance from the page edge to the header baseline area. Defaults to 36pt. */
  readonly headerPt?: number;
  /** Distance from the page edge to the footer baseline area. Defaults to 36pt. */
  readonly footerPt?: number;
  /** Extra binding gutter added by the word processor. Defaults to 0pt. */
  readonly gutterPt?: number;
};

export type DocumentTextStyle = {
  readonly fontFamily?: string;
  readonly fontSizePt?: number;
  readonly color?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
};

export type DocumentParagraphStyle = {
  readonly headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  readonly alignment?: "left" | "center" | "right" | "justify";
  readonly spaceBeforePt?: number;
  readonly spaceAfterPt?: number;
  readonly lineHeight?: number;
  readonly keepNext?: boolean;
  readonly pageBreakBefore?: boolean;
  readonly list?: {
    readonly kind: "bullet" | "number";
    readonly level?: number;
    readonly instanceId?: string;
  };
};

export type DocumentTableStyle = {
  readonly widthPt?: number;
  readonly columnWidthsPt?: readonly number[];
  readonly headerRows?: number;
  readonly cellPaddingPt?: number;
  readonly borderColor?: string;
  readonly headerFill?: string;
  /** Defaults to false so a row is never split between pages unexpectedly. */
  readonly allowRowSplit?: boolean;
};

export type DocumentRenderOptions = {
  format?: "html" | "svg" | "png";
  scale?: number;
  background?: string;
};

export type DocumentParagraphEdit = {
  start: number;
  end: number;
  text: string;
  style?: DocumentTextStyle;
};

export type DocumentTextStylePatch = {
  fontFamily?: string | null;
  fontSizePt?: number | null;
  color?: string | null;
  bold?: boolean | null;
  italic?: boolean | null;
  underline?: boolean | null;
  strike?: boolean | null;
};

export type DocumentParagraphFormat = {
  start: number;
  end: number;
  style: DocumentTextStylePatch;
};

export type DocumentCreateOptions = {
  page?: Partial<DocumentPageGeometry>;
  /** Preserve/enable distinct first-page header and footer stories, even when empty. */
  titlePage?: boolean;
  /** Preserve/enable distinct even-page header and footer stories, even when empty. */
  evenAndOddHeaders?: boolean;
  /** Keep Word's track-revisions mode enabled even when no pending changes exist. */
  trackRevisions?: boolean;
  /** Primarily useful for deterministic fixtures. Must be 64 bits of lowercase hex. */
  idNamespace?: string;
  /** Injectable clock for deterministic comments and tracked changes. */
  now?: () => Date;
};

export type SerializedDocument = {
  version: 1;
  idNamespace: string;
  nextId: number;
  revision: number;
  evenAndOddHeaders?: boolean;
  trackRevisions?: boolean;
  page: DocumentPageGeometry;
  blocks: SerializedDocumentBlock[];
  sections: SerializedDocumentSection[];
  comments: SerializedDocumentComment[];
  changes: SerializedTrackedChange[];
};

export type SerializedTextRun = { text: string; style: DocumentTextStyle };
export type SerializedParagraph = {
  kind: "paragraph";
  id: string;
  runs: SerializedTextRun[];
  style: DocumentParagraphStyle;
};
export type SerializedTable = {
  kind: "table";
  id: string;
  rows: SerializedTextRun[][][];
  style: DocumentTableStyle;
};
export type SerializedPageBreak = { kind: "pageBreak"; id: string };
export type SerializedDocumentBlock = SerializedParagraph | SerializedTable | SerializedPageBreak;
export type SerializedStory = {
  id: string;
  blocks: Array<SerializedParagraph | SerializedTable>;
};
export type SerializedDocumentSection = {
  id: string;
  startBlockIndex: number;
  titlePage?: boolean;
  page: DocumentPageGeometry;
  headers: { default: SerializedStory; first: SerializedStory; even: SerializedStory };
  footers: { default: SerializedStory; first: SerializedStory; even: SerializedStory };
};
export type SerializedDocumentComment = {
  id: string;
  blockId: string;
  start: number;
  end: number;
  resolved: boolean;
  replies: Array<{ author: string; text: string; createdAt: string }>;
};
export type SerializedTrackedChange = {
  id: string;
  blockId: string;
  kind: "insert" | "delete";
  start: number;
  end: number;
  author: string;
  createdAt: string;
};

const DEFAULT_PAGE: DocumentPageGeometry = {
  widthPt: 612,
  heightPt: 792,
  marginTopPt: 72,
  marginRightPt: 72,
  marginBottomPt: 72,
  marginLeftPt: 72,
};
const MAX_DOCUMENT_BLOCKS = 100_000;
const MAX_TEXT_LENGTH = 10_000_000;
const MAX_TEXT_RUNS = 250_000;
const MAX_TABLE_CELLS = 1_000_000;
const MAX_STRUCTURAL_ID = Number.MAX_SAFE_INTEGER - 1;
const NAMESPACE_PATTERN = /^[0-9a-f]{16}$/;
const DOCUMENT_INTERNAL_ACCESS = Symbol("document-internal-access");
type DocumentInternalAccess = typeof DOCUMENT_INTERNAL_ACCESS;

function assertDocumentInternalAccess(access: DocumentInternalAccess): void {
  if (access !== DOCUMENT_INTERNAL_ACCESS) {
    throw new Error("Document internals are not part of the public mutation API");
  }
}

const DOCUMENT_HELP_ENTRIES: Array<
  Record<string, unknown> & {
    path: string;
    summary: string;
    examples: string[];
  }
> = [
  {
    path: "Document.create",
    summary: "Create an editable document with stable structural ids and an initial section.",
    examples: ["const document = Document.create()"],
  },
  {
    path: "document.blocks.addParagraph",
    summary:
      "Add styled text runs or plain text, then edit or format Unicode-safe ranges atomically.",
    examples: [
      'document.blocks.addParagraph("Body text")',
      'paragraph.edit({ start: 0, end: 4, text: "Updated" })',
      "paragraph.format({ start: 0, end: 7, style: { bold: true } })",
    ],
  },
  {
    path: "document.blocks.addHeading",
    summary: "Add a semantic heading level 1 through 6.",
    examples: ['document.blocks.addHeading("Overview", 1)'],
  },
  {
    path: "document.blocks.addTable",
    summary: "Add an editable rectangular table with explicit point geometry.",
    examples: [
      'document.blocks.addTable([["Name", "Value"]], { widthPt: 360, columnWidthsPt: [240, 120], headerRows: 1 })',
    ],
  },
  {
    path: "document.sections.add",
    summary:
      "Start a section and author its default, first-page, or even-page headers and footers.",
    examples: [
      "const section = document.sections.add({ page: { widthPt: 792, heightPt: 612 } })",
      'section.headers.default.addParagraph("Header")',
    ],
  },
  {
    path: "document.comments.addThread",
    summary: "Anchor a threaded, resolvable comment to a paragraph text range.",
    examples: [
      'const thread = document.comments.addThread({ block: paragraph, start: 0, end: 5 }, "Review")',
      'thread.addReply("Done")',
    ],
  },
  {
    path: "document.changes.add",
    summary: "Mark a non-overlapping paragraph range as an inserted or deleted tracked change.",
    examples: ['document.changes.add({ block: paragraph, start: 0, end: 5 }, "insert", "Author")'],
  },
  {
    path: "document.inspect",
    summary:
      "Return bounded NDJSON records for document, section, block, comment, and redline inspection.",
    examples: [
      'await document.inspect({ kind: "document,section,paragraph,table,comment,redline" })',
    ],
  },
  {
    path: "document.render",
    summary: "Render a safe HTML, SVG, or bounded PNG preview.",
    examples: ['await document.render({ format: "png", scale: 1 })'],
  },
  {
    path: "DocumentFile.exportDocx",
    summary:
      "Export editable WordprocessingML with sections, numbering, tables, comments, and redlines.",
    examples: ["const blob = await DocumentFile.exportDocx(document)"],
  },
  {
    path: "DocumentFile.importDocx",
    summary:
      "Safely import the bounded editable DOCX subset; unsupported fidelity-bearing features fail closed.",
    examples: ["const document = await DocumentFile.importDocx(blob)"],
  },
];

/**
 * Skill-compatible TypeScript reference document used by fixtures and codecs.
 * The package root projects this facade through the retained native document
 * session; production never selects this reference model as a fallback.
 */
export class Document {
  readonly blocks: DocumentBlockCollection;
  readonly comments: DocumentComments;
  readonly changes: TrackedChanges;
  readonly sections: DocumentSections;
  readonly idNamespace: string;
  private readonly objects = new Map<string, unknown>();
  private readonly nowProvider: () => Date;
  private nextIdValue = 1;
  private revisionValue = 0;
  private explicitEvenAndOddHeaders: boolean | undefined;
  private explicitTrackRevisions: boolean | undefined;
  private blockCountValue = 0;
  private cellCountValue = 0;
  private runCountValue = 0;
  private textLengthValue = 0;
  private replyCountValue = 0;

  private constructor(options: DocumentCreateOptions = {}, initializeDefaultSection = true) {
    this.idNamespace = options.idNamespace ?? createNamespace();
    if (!NAMESPACE_PATTERN.test(this.idNamespace)) {
      throw new Error("Document idNamespace must be 16 lowercase hexadecimal characters");
    }
    this.nowProvider = options.now ?? (() => new Date());
    if (options.evenAndOddHeaders !== undefined && typeof options.evenAndOddHeaders !== "boolean") {
      throw new Error("evenAndOddHeaders must be boolean");
    }
    if (options.titlePage !== undefined && typeof options.titlePage !== "boolean") {
      throw new Error("titlePage must be boolean");
    }
    this.explicitEvenAndOddHeaders = options.evenAndOddHeaders;
    if (options.trackRevisions !== undefined && typeof options.trackRevisions !== "boolean") {
      throw new Error("trackRevisions must be boolean");
    }
    this.explicitTrackRevisions = options.trackRevisions;
    this.blocks = new DocumentBlockCollection(this, DOCUMENT_INTERNAL_ACCESS);
    this.comments = new DocumentComments(this, DOCUMENT_INTERNAL_ACCESS);
    this.changes = new TrackedChanges(this, DOCUMENT_INTERNAL_ACCESS);
    this.sections = new DocumentSections(this, DOCUMENT_INTERNAL_ACCESS);
    if (initializeDefaultSection)
      this.sections.addRestored(
        0,
        { ...DEFAULT_PAGE, ...options.page },
        options.titlePage,
        DOCUMENT_INTERNAL_ACCESS,
      );
  }

  static create(options: DocumentCreateOptions = {}): Document {
    return new Document(options);
  }

  get page(): DocumentPageGeometry {
    const section = this.sections.items[0];
    if (!section) throw new Error("Document has no sections");
    return section.page;
  }

  get revision(): number {
    return this.revisionValue;
  }

  get evenAndOddHeaders(): boolean {
    return (
      this.explicitEvenAndOddHeaders ??
      this.sections.items.some(
        (section) => section.headers.even.items.length > 0 || section.footers.even.items.length > 0,
      )
    );
  }

  setEvenAndOddHeaders(enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new Error("evenAndOddHeaders must be boolean");
    if (this.explicitEvenAndOddHeaders === enabled) return;
    this.assertCanChange();
    this.explicitEvenAndOddHeaders = enabled;
    this.changed(DOCUMENT_INTERNAL_ACCESS);
  }

  get trackRevisions(): boolean {
    return this.explicitTrackRevisions ?? this.changes.items.length > 0;
  }

  setTrackRevisions(enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new Error("trackRevisions must be boolean");
    if (this.explicitTrackRevisions === enabled) return;
    this.assertCanChange();
    this.explicitTrackRevisions = enabled;
    this.changed(DOCUMENT_INTERNAL_ACCESS);
  }

  resolve(id: string): unknown {
    const object = this.objects.get(id);
    if (!object) throw new Error(`Unknown document object id: ${id}`);
    return object;
  }

  ownsObject(id: string, object: unknown): boolean {
    return this.objects.get(id) === object;
  }

  async inspect(options: InspectOptions): Promise<InspectResult> {
    validateDocument(this);
    const kinds = new Set(options.kind.split(",").map((kind) => kind.trim()));
    const search = options.search?.toLowerCase();
    const records: Record<string, unknown>[] = [];
    if (kinds.has("document")) {
      records.push({
        kind: "document",
        idNamespace: this.idNamespace,
        revision: this.revision,
        blockCount: this.blocks.items.length,
        sectionCount: this.sections.items.length,
        commentCount: this.comments.items.length,
        trackedChangeCount: this.changes.items.length,
        page: this.page,
      });
    }
    if (kinds.has("section")) {
      for (const section of this.sections.items) records.push(section.inspectRecord());
    }
    for (const block of this.allStoryBlocks()) {
      const record = block.inspectRecord();
      if (search && !JSON.stringify(record).toLowerCase().includes(search)) continue;
      if (kinds.has(block.kind) || kinds.has("block") || kinds.has("text")) records.push(record);
    }
    if (kinds.has("thread") || kinds.has("comment")) {
      for (const thread of this.comments.items) records.push(thread.inspectRecord());
    }
    if (kinds.has("change") || kinds.has("redline")) {
      for (const change of this.changes.items) records.push(change.inspectRecord());
    }
    return boundedInspect(records, inspectCharacterLimit(options.maxChars, 20_000));
  }

  help(query: string, options: HelpOptions = {}): InspectResult {
    const normalized = query.trim().toLowerCase();
    const entries = DOCUMENT_HELP_ENTRIES.filter((entry) => {
      const content = `${entry.path} ${entry.summary} ${entry.examples.join(" ")}`.toLowerCase();
      const matchesQuery = normalized === "*" || content.includes(normalized);
      if (!matchesQuery || !options.search) return matchesQuery;
      try {
        return new RegExp(options.search, "iu").test(content);
      } catch {
        return content.includes(options.search.toLowerCase());
      }
    });
    return boundedInspect(entries, inspectCharacterLimit(options.maxChars, 6_000));
  }

  async render(options: DocumentRenderOptions = {}): Promise<FileBlob> {
    validateDocument(this);
    const renderer = await import("@opengeni/artifact-tool/document/render");
    return renderer.renderDocument(this, options);
  }

  toJSON(): SerializedDocument {
    validateDocument(this);
    return {
      version: 1,
      idNamespace: this.idNamespace,
      nextId: this.nextIdValue,
      revision: this.revision,
      ...(this.explicitEvenAndOddHeaders !== undefined
        ? { evenAndOddHeaders: this.explicitEvenAndOddHeaders }
        : {}),
      ...(this.explicitTrackRevisions !== undefined
        ? { trackRevisions: this.explicitTrackRevisions }
        : {}),
      page: { ...this.page },
      blocks: this.blocks.items.map((block) => block.serialize()),
      sections: this.sections.items.map((section) => section.serialize()),
      comments: this.comments.items.map((comment) => comment.serialize()),
      changes: this.changes.items.map((change) => change.serialize()),
    };
  }

  static fromJSON(value: unknown): Document {
    validateSerializedDocumentEnvelope(value);
    const snapshot = structuredClone(value) as SerializedDocument;
    const document = new Document(
      {
        idNamespace: snapshot.idNamespace,
        ...(snapshot.evenAndOddHeaders !== undefined
          ? { evenAndOddHeaders: snapshot.evenAndOddHeaders }
          : {}),
        ...(snapshot.trackRevisions !== undefined
          ? { trackRevisions: snapshot.trackRevisions }
          : {}),
      },
      false,
    );
    if (Array.isArray(snapshot.sections) && snapshot.sections.length > 0) {
      for (const section of snapshot.sections) {
        document.sections.restore(section, DOCUMENT_INTERNAL_ACCESS);
      }
    } else {
      document.sections.addRestored(
        0,
        snapshot.page ?? DEFAULT_PAGE,
        undefined,
        DOCUMENT_INTERNAL_ACCESS,
      );
    }
    for (const block of snapshot.blocks) {
      document.blocks.restore(block, DOCUMENT_INTERNAL_ACCESS);
    }
    for (const comment of snapshot.comments ?? []) {
      document.comments.restore(comment, DOCUMENT_INTERNAL_ACCESS);
    }
    for (const change of snapshot.changes ?? []) {
      document.changes.restore(change, DOCUMENT_INTERNAL_ACCESS);
    }
    if (snapshot.nextId < document.nextIdValue) {
      throw new Error("Serialized document nextId precedes an allocated structural id");
    }
    document.nextIdValue = snapshot.nextId;
    document.revisionValue = snapshot.revision;
    validateDocument(document);
    return document;
  }

  allocateId(
    prefix: string,
    object: unknown,
    existingId: string | undefined,
    access: DocumentInternalAccess,
  ): string {
    assertDocumentInternalAccess(access);
    if (!/^[a-z]{1,8}$/.test(prefix)) throw new Error(`Invalid document id prefix: ${prefix}`);
    if (this.nextIdValue > MAX_STRUCTURAL_ID)
      throw new Error("Document structural id space exhausted");
    const id =
      existingId ??
      `${prefix}/${this.idNamespace}${this.nextIdValue.toString(16).padStart(16, "0")}`;
    const expectedPattern = new RegExp(`^${prefix}/${this.idNamespace}[0-9a-f]{16}$`, "u");
    if (!expectedPattern.test(id)) {
      throw new Error(`Invalid document object id: ${id}`);
    }
    const counter = Number.parseInt(id.slice(-16), 16);
    if (!Number.isSafeInteger(counter) || counter < 1 || counter > MAX_STRUCTURAL_ID) {
      throw new Error(`Document object id counter is invalid: ${id}`);
    }
    if (this.objects.has(id)) throw new Error(`Duplicate document object id: ${id}`);
    this.objects.set(id, object);
    this.nextIdValue = Math.max(this.nextIdValue, counter + 1);
    return id;
  }

  assertTextLengthDelta(delta: number): void {
    const next = this.textLengthValue + delta;
    if (!Number.isSafeInteger(next) || next < 0 || next > MAX_TEXT_LENGTH) {
      throw new Error(`document text exceeds ${MAX_TEXT_LENGTH} UTF-16 code units`);
    }
  }

  commitTextLengthDelta(delta: number, access: DocumentInternalAccess): void {
    assertDocumentInternalAccess(access);
    this.textLengthValue += delta;
  }

  get trackedTextLength(): number {
    return this.textLengthValue;
  }

  assertBlockDelta(delta: number): void {
    const next = this.blockCountValue + delta;
    if (!Number.isSafeInteger(next) || next < 0 || next > MAX_DOCUMENT_BLOCKS) {
      throw new Error(`all document story blocks exceeds limit ${MAX_DOCUMENT_BLOCKS}`);
    }
  }

  commitBlockDelta(delta: number, access: DocumentInternalAccess): void {
    assertDocumentInternalAccess(access);
    this.blockCountValue += delta;
  }

  get trackedBlockCount(): number {
    return this.blockCountValue;
  }

  assertCellDelta(delta: number): void {
    const next = this.cellCountValue + delta;
    if (!Number.isSafeInteger(next) || next < 0 || next > MAX_TABLE_CELLS) {
      throw new Error(`document table cells exceeds limit ${MAX_TABLE_CELLS}`);
    }
  }

  commitCellDelta(delta: number, access: DocumentInternalAccess): void {
    assertDocumentInternalAccess(access);
    this.cellCountValue += delta;
  }

  get trackedCellCount(): number {
    return this.cellCountValue;
  }

  assertRunDelta(delta: number): void {
    const next = this.runCountValue + delta;
    if (!Number.isSafeInteger(next) || next < 0 || next > MAX_TEXT_RUNS) {
      throw new Error(`document text runs exceeds limit ${MAX_TEXT_RUNS}`);
    }
  }

  commitRunDelta(delta: number, access: DocumentInternalAccess): void {
    assertDocumentInternalAccess(access);
    this.runCountValue += delta;
  }

  get trackedRunCount(): number {
    return this.runCountValue;
  }

  assertReplyDelta(delta: number): void {
    const next = this.replyCountValue + delta;
    if (!Number.isSafeInteger(next) || next < 0 || next > 100_000) {
      throw new Error("document comment replies exceed 100000");
    }
  }

  commitReplyDelta(delta: number, access: DocumentInternalAccess): void {
    assertDocumentInternalAccess(access);
    this.replyCountValue += delta;
  }

  get trackedReplyCount(): number {
    return this.replyCountValue;
  }

  now(): string {
    const value = this.nowProvider();
    if (!Number.isFinite(value.getTime()))
      throw new Error("Document clock returned an invalid date");
    return value.toISOString();
  }

  changed(access: DocumentInternalAccess): void {
    assertDocumentInternalAccess(access);
    this.assertCanChange();
    this.revisionValue += 1;
  }

  assertCanChange(): void {
    if (this.revisionValue >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Document revision space exhausted");
    }
  }

  rebaseParagraphAnchors(
    blockId: string,
    editStart: number,
    editEnd: number,
    insertedLength: number,
    access: DocumentInternalAccess,
  ): void {
    assertDocumentInternalAccess(access);
    const delta = insertedLength - (editEnd - editStart);
    const mapStart = (offset: number): number => {
      if (offset <= editStart) return offset;
      if (offset >= editEnd) return offset + delta;
      return editStart;
    };
    const mapEnd = (offset: number): number => {
      if (offset <= editStart) return offset;
      if (offset >= editEnd) return offset + delta;
      return editStart + insertedLength;
    };
    for (const comment of this.comments.forBlock(blockId, DOCUMENT_INTERNAL_ACCESS)) {
      const wasPoint = comment.start === comment.end;
      const start = mapStart(comment.start);
      comment.rebaseTo(
        start,
        wasPoint ? start : Math.max(start, mapEnd(comment.end)),
        DOCUMENT_INTERNAL_ACCESS,
      );
    }
    for (const change of [...this.changes.forBlock(blockId, DOCUMENT_INTERNAL_ACCESS)]) {
      const start = mapStart(change.start);
      const end = Math.max(start, mapEnd(change.end));
      change.rebaseTo(start, end, DOCUMENT_INTERNAL_ACCESS);
      if (start === end) this.changes.remove(change, DOCUMENT_INTERNAL_ACCESS);
    }
  }

  allStoryBlocks(): Array<DocumentParagraph | DocumentTable | DocumentPageBreak> {
    const result: Array<DocumentParagraph | DocumentTable | DocumentPageBreak> = [
      ...this.blocks.items,
    ];
    for (const section of this.sections.items) {
      for (const story of section.allStories()) result.push(...story.items);
    }
    return result;
  }
}

export class DocumentBlockCollection {
  private readonly itemStorage: DocumentBlock[] = [];
  readonly items: readonly DocumentBlock[];
  constructor(
    private readonly document: Document,
    access: DocumentInternalAccess,
  ) {
    assertDocumentInternalAccess(access);
    this.items = readonlyArrayView(this.itemStorage, "document blocks");
  }

  addParagraph(
    text: string | readonly DocumentTextRun[] = "",
    style: DocumentParagraphStyle = {},
  ): DocumentParagraph {
    ensureCapacity(this.items.length + 1, MAX_DOCUMENT_BLOCKS, "document blocks");
    this.document.assertCanChange();
    const paragraph = new DocumentParagraph(
      this.document,
      text,
      style,
      undefined,
      DOCUMENT_INTERNAL_ACCESS,
    );
    this.itemStorage.push(paragraph);
    this.document.changed(DOCUMENT_INTERNAL_ACCESS);
    return paragraph;
  }

  addHeading(text: string, level: 1 | 2 | 3 | 4 | 5 | 6 = 1): DocumentParagraph {
    return this.addParagraph(text, { headingLevel: level, keepNext: true });
  }

  addTable(
    rows: ReadonlyArray<ReadonlyArray<string | readonly DocumentTextRun[]>>,
    style: DocumentTableStyle = {},
  ): DocumentTable {
    ensureCapacity(this.items.length + 1, MAX_DOCUMENT_BLOCKS, "document blocks");
    this.document.assertCanChange();
    const table = new DocumentTable(
      this.document,
      rows,
      style,
      undefined,
      undefined,
      DOCUMENT_INTERNAL_ACCESS,
    );
    this.itemStorage.push(table);
    this.document.changed(DOCUMENT_INTERNAL_ACCESS);
    return table;
  }

  addPageBreak(): DocumentPageBreak {
    ensureCapacity(this.items.length + 1, MAX_DOCUMENT_BLOCKS, "document blocks");
    this.document.assertCanChange();
    const pageBreak = new DocumentPageBreak(this.document, undefined, DOCUMENT_INTERNAL_ACCESS);
    this.itemStorage.push(pageBreak);
    this.document.changed(DOCUMENT_INTERNAL_ACCESS);
    return pageBreak;
  }

  restore(block: SerializedDocumentBlock, access: DocumentInternalAccess): void {
    assertDocumentInternalAccess(access);
    ensureCapacity(this.items.length + 1, MAX_DOCUMENT_BLOCKS, "document blocks");
    let restored: DocumentBlock;
    if (block.kind === "paragraph") {
      restored = DocumentParagraph.restore(this.document, block, DOCUMENT_INTERNAL_ACCESS);
    } else if (block.kind === "table") {
      restored = DocumentTable.restore(this.document, block, undefined, DOCUMENT_INTERNAL_ACCESS);
    } else {
      restored = new DocumentPageBreak(this.document, block.id, DOCUMENT_INTERNAL_ACCESS);
    }
    this.itemStorage.push(restored);
  }
}

export type DocumentBlock = DocumentParagraph | DocumentTable | DocumentPageBreak;
export type DocumentStoryBlock = DocumentParagraph | DocumentTable;

export class DocumentStory {
  readonly id: string;
  private readonly itemStorage: DocumentStoryBlock[] = [];
  readonly items: readonly DocumentStoryBlock[];

  constructor(
    private readonly document: Document,
    readonly kind: "header" | "footer",
    existingId?: string,
    private readonly pageForTables?: DocumentPageGeometry,
    access?: DocumentInternalAccess,
  ) {
    assertDocumentInternalAccess(access as DocumentInternalAccess);
    this.id = document.allocateId(
      kind === "header" ? "hdr" : "ftr",
      this,
      existingId,
      DOCUMENT_INTERNAL_ACCESS,
    );
    this.items = readonlyArrayView(this.itemStorage, `${kind} story blocks`);
  }

  addParagraph(
    text: string | readonly DocumentTextRun[] = "",
    style: DocumentParagraphStyle = {},
  ): DocumentParagraph {
    this.document.assertCanChange();
    const paragraph = new DocumentParagraph(
      this.document,
      text,
      style,
      undefined,
      DOCUMENT_INTERNAL_ACCESS,
    );
    this.itemStorage.push(paragraph);
    this.document.changed(DOCUMENT_INTERNAL_ACCESS);
    return paragraph;
  }

  addTable(
    rows: ReadonlyArray<ReadonlyArray<string | readonly DocumentTextRun[]>>,
    style: DocumentTableStyle = {},
  ): DocumentTable {
    this.document.assertCanChange();
    const table = new DocumentTable(
      this.document,
      rows,
      style,
      undefined,
      this.pageForTables,
      DOCUMENT_INTERNAL_ACCESS,
    );
    this.itemStorage.push(table);
    this.document.changed(DOCUMENT_INTERNAL_ACCESS);
    return table;
  }

  serialize(): SerializedStory {
    return { id: this.id, blocks: this.items.map((block) => block.serialize()) };
  }

  restore(block: SerializedParagraph | SerializedTable, access: DocumentInternalAccess): void {
    assertDocumentInternalAccess(access);
    this.itemStorage.push(
      block.kind === "paragraph"
        ? DocumentParagraph.restore(this.document, block, DOCUMENT_INTERNAL_ACCESS)
        : DocumentTable.restore(this.document, block, this.pageForTables, DOCUMENT_INTERNAL_ACCESS),
    );
  }
}

export class DocumentSectionStories {
  readonly default: DocumentStory;
  readonly first: DocumentStory;
  readonly even: DocumentStory;

  constructor(
    document: Document,
    kind: "header" | "footer",
    restored?: { default: SerializedStory; first: SerializedStory; even: SerializedStory },
    pageForTables?: DocumentPageGeometry,
    access?: DocumentInternalAccess,
  ) {
    assertDocumentInternalAccess(access as DocumentInternalAccess);
    this.default = restoreStory(
      document,
      kind,
      restored?.default,
      pageForTables,
      DOCUMENT_INTERNAL_ACCESS,
    );
    this.first = restoreStory(
      document,
      kind,
      restored?.first,
      pageForTables,
      DOCUMENT_INTERNAL_ACCESS,
    );
    this.even = restoreStory(
      document,
      kind,
      restored?.even,
      pageForTables,
      DOCUMENT_INTERNAL_ACCESS,
    );
  }

  all(): readonly DocumentStory[] {
    return [this.default, this.first, this.even];
  }

  serialize(): { default: SerializedStory; first: SerializedStory; even: SerializedStory } {
    return {
      default: this.default.serialize(),
      first: this.first.serialize(),
      even: this.even.serialize(),
    };
  }
}

export class DocumentSection {
  readonly id: string;
  readonly page: DocumentPageGeometry;
  readonly headers: DocumentSectionStories;
  readonly footers: DocumentSectionStories;

  constructor(
    private readonly document: Document,
    readonly startBlockIndex: number,
    page: DocumentPageGeometry,
    restored?: SerializedDocumentSection,
    private explicitTitlePage: boolean | undefined = restored?.titlePage,
    access?: DocumentInternalAccess,
  ) {
    assertDocumentInternalAccess(access as DocumentInternalAccess);
    this.page = Object.freeze({ ...page });
    this.id = document.allocateId("sec", this, restored?.id, DOCUMENT_INTERNAL_ACCESS);
    this.headers = new DocumentSectionStories(
      document,
      "header",
      restored?.headers,
      this.page,
      DOCUMENT_INTERNAL_ACCESS,
    );
    this.footers = new DocumentSectionStories(
      document,
      "footer",
      restored?.footers,
      this.page,
      DOCUMENT_INTERNAL_ACCESS,
    );
  }

  get titlePage(): boolean {
    return (
      this.explicitTitlePage ??
      (this.headers.first.items.length > 0 || this.footers.first.items.length > 0)
    );
  }

  setTitlePage(enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new Error("titlePage must be boolean");
    if (this.explicitTitlePage === enabled) return;
    this.document.assertCanChange();
    this.explicitTitlePage = enabled;
    this.document.changed(DOCUMENT_INTERNAL_ACCESS);
  }

  allStories(): readonly DocumentStory[] {
    return [...this.headers.all(), ...this.footers.all()];
  }

  inspectRecord(): Record<string, unknown> {
    return {
      kind: "section",
      id: this.id,
      startBlockIndex: this.startBlockIndex,
      titlePage: this.titlePage,
      page: this.page,
      headers: storyCounts(this.headers),
      footers: storyCounts(this.footers),
    };
  }

  serialize(): SerializedDocumentSection {
    return {
      id: this.id,
      startBlockIndex: this.startBlockIndex,
      ...(this.explicitTitlePage !== undefined ? { titlePage: this.explicitTitlePage } : {}),
      page: { ...this.page },
      headers: this.headers.serialize(),
      footers: this.footers.serialize(),
    };
  }
}

export class DocumentSections {
  private readonly itemStorage: DocumentSection[] = [];
  readonly items: readonly DocumentSection[];
  constructor(
    private readonly document: Document,
    access: DocumentInternalAccess,
  ) {
    assertDocumentInternalAccess(access);
    this.items = readonlyArrayView(this.itemStorage, "document sections");
  }

  add(
    options: { page?: Partial<DocumentPageGeometry>; titlePage?: boolean } = {},
  ): DocumentSection {
    ensureCapacity(this.items.length + 1, 10_000, "document sections");
    const startBlockIndex = this.document.blocks.items.length;
    if (this.items.at(-1)?.startBlockIndex === startBlockIndex) {
      throw new Error(
        "A document section must contain at least one body block before another section starts",
      );
    }
    const page = { ...(this.items.at(-1)?.page ?? DEFAULT_PAGE), ...options.page };
    validatePage(page);
    if (options.titlePage !== undefined && typeof options.titlePage !== "boolean") {
      throw new Error("titlePage must be boolean");
    }
    this.document.assertCanChange();
    const section = new DocumentSection(
      this.document,
      startBlockIndex,
      page,
      undefined,
      options.titlePage,
      DOCUMENT_INTERNAL_ACCESS,
    );
    this.itemStorage.push(section);
    this.document.changed(DOCUMENT_INTERNAL_ACCESS);
    return section;
  }

  addRestored(
    startBlockIndex: number,
    page: DocumentPageGeometry,
    titlePage?: boolean,
    access?: DocumentInternalAccess,
  ): DocumentSection {
    assertDocumentInternalAccess(access as DocumentInternalAccess);
    ensureCapacity(this.items.length + 1, 10_000, "document sections");
    const section = new DocumentSection(
      this.document,
      startBlockIndex,
      { ...page },
      undefined,
      titlePage,
      DOCUMENT_INTERNAL_ACCESS,
    );
    this.itemStorage.push(section);
    return section;
  }

  restore(value: SerializedDocumentSection, access: DocumentInternalAccess): void {
    assertDocumentInternalAccess(access);
    ensureCapacity(this.items.length + 1, 10_000, "document sections");
    const section = new DocumentSection(
      this.document,
      value.startBlockIndex,
      { ...value.page },
      value,
      value.titlePage,
      DOCUMENT_INTERNAL_ACCESS,
    );
    this.itemStorage.push(section);
  }
}

export class DocumentTextRun {
  readonly text: string;
  readonly style: DocumentTextStyle;
  constructor(text: string, style: DocumentTextStyle = {}) {
    validateText(text, "document text run");
    validateTextStyle(style);
    this.text = text;
    this.style = Object.freeze({ ...style });
    Object.freeze(this);
  }
  serialize(): SerializedTextRun {
    return { text: this.text, style: { ...this.style } };
  }
  static restore(value: SerializedTextRun): DocumentTextRun {
    return new DocumentTextRun(value.text, { ...value.style });
  }
}

export class DocumentParagraph {
  readonly kind = "paragraph" as const;
  readonly id: string;
  private readonly runStorage: DocumentTextRun[];
  readonly runs: readonly DocumentTextRun[];
  private styleValue: DocumentParagraphStyle;

  constructor(
    private readonly document: Document,
    text: string | readonly DocumentTextRun[],
    style: DocumentParagraphStyle = {},
    existingId?: string,
    access?: DocumentInternalAccess,
  ) {
    assertDocumentInternalAccess(access as DocumentInternalAccess);
    this.runStorage =
      typeof text === "string"
        ? [new DocumentTextRun(text)]
        : text.length > 0
          ? text.map((run) => new DocumentTextRun(run.text, { ...run.style }))
          : [new DocumentTextRun("")];
    const runCount = this.runStorage.length;
    document.assertRunDelta(runCount);
    this.runs = readonlyArrayView(this.runStorage, "document paragraph runs");
    this.styleValue = freezeParagraphStyle(style);
    validateParagraphStyle(this.styleValue);
    const textLength = this.text.length;
    document.assertBlockDelta(1);
    document.assertTextLengthDelta(textLength);
    this.id = document.allocateId("p", this, existingId, DOCUMENT_INTERNAL_ACCESS);
    document.commitBlockDelta(1, DOCUMENT_INTERNAL_ACCESS);
    document.commitRunDelta(runCount, DOCUMENT_INTERNAL_ACCESS);
    document.commitTextLengthDelta(textLength, DOCUMENT_INTERNAL_ACCESS);
  }

  get text(): string {
    return this.runs.map((run) => run.text).join("");
  }
  get style(): DocumentParagraphStyle {
    return this.styleValue;
  }
  setStyle(style: DocumentParagraphStyle): void {
    const next = freezeParagraphStyle(style);
    validateParagraphStyle(next);
    this.document.assertCanChange();
    this.styleValue = next;
    this.document.changed(DOCUMENT_INTERNAL_ACCESS);
  }
  set text(value: string) {
    validateText(value, "document paragraph");
    const edit = minimalTextEdit(this.text, value);
    this.edit({ start: edit.start, end: edit.end, text: edit.replacement });
  }
  append(text: string, style: DocumentTextStyle = {}): DocumentTextRun {
    const run = this.edit({ start: this.text.length, end: this.text.length, text, style });
    if (!run) throw new Error("Appending empty text does not create a text run");
    return run;
  }
  replace(search: string | RegExp, replacement: string): void {
    validateText(replacement, "document replacement");
    const current = this.text;
    const edits = collectReplacementEdits(current, search, replacement).filter(
      (edit) => current.slice(edit.start, edit.end) !== edit.text,
    );
    if (edits.length === 0) return;
    let textDelta = 0;
    for (const edit of edits) {
      if (!isUnicodeBoundary(current, edit.start) || !isUnicodeBoundary(current, edit.end)) {
        throw new Error("Paragraph replacements must not split a Unicode surrogate pair");
      }
      textDelta += edit.text.length - (edit.end - edit.start);
    }
    const nextRuns = buildReplacementRuns(this.runs, current.length, edits);
    const runDelta = nextRuns.length - this.runs.length;
    this.document.assertTextLengthDelta(textDelta);
    this.document.assertRunDelta(runDelta);
    this.document.assertCanChange();
    this.runStorage.length = 0;
    this.runStorage.push(...nextRuns);
    this.document.commitTextLengthDelta(textDelta, DOCUMENT_INTERNAL_ACCESS);
    this.document.commitRunDelta(runDelta, DOCUMENT_INTERNAL_ACCESS);
    for (let index = edits.length - 1; index >= 0; index -= 1) {
      const edit = edits[index]!;
      this.document.rebaseParagraphAnchors(
        this.id,
        edit.start,
        edit.end,
        edit.text.length,
        DOCUMENT_INTERNAL_ACCESS,
      );
    }
    this.document.changed(DOCUMENT_INTERNAL_ACCESS);
  }
  edit(edit: DocumentParagraphEdit): DocumentTextRun | undefined;
  edit(
    start: number,
    end: number,
    replacement: string,
    style?: DocumentTextStyle,
  ): DocumentTextRun | undefined;
  edit(
    editOrStart: DocumentParagraphEdit | number,
    legacyEnd?: number,
    legacyReplacement?: string,
    legacyStyle?: DocumentTextStyle,
  ): DocumentTextRun | undefined {
    const {
      start,
      end,
      text: replacement,
      style,
    } = typeof editOrStart === "number"
      ? { start: editOrStart, end: legacyEnd, text: legacyReplacement, style: legacyStyle }
      : editOrStart;
    if (end === undefined || replacement === undefined)
      throw new Error("Paragraph edit requires start, end, and text");
    return this.applyEdit(
      { start, end, text: replacement, ...(style !== undefined ? { style } : {}) },
      true,
    );
  }
  private applyEdit(
    edit: DocumentParagraphEdit,
    markChanged: boolean,
  ): DocumentTextRun | undefined {
    const { start, end, text: replacement, style } = edit;
    validateText(replacement, "document replacement");
    const current = this.text;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > current.length
    )
      throw new Error("Invalid paragraph edit range");
    if (!isUnicodeBoundary(current, start) || !isUnicodeBoundary(current, end))
      throw new Error("Paragraph edits must not split a Unicode surrogate pair");
    if (style !== undefined) validateTextStyle(style);
    if (start === end && replacement.length === 0) return undefined;
    const before = sliceTextRuns(this.runs, 0, start);
    const after = sliceTextRuns(this.runs, end, current.length);
    const inheritedStyle = style ?? textStyleAt(this.runs, start, current.length);
    const inserted =
      replacement.length > 0 ? new DocumentTextRun(replacement, { ...inheritedStyle }) : undefined;
    const nextRuns = mergeAdjacentTextRuns([...before, ...(inserted ? [inserted] : []), ...after]);
    if (nextRuns.length === 0) nextRuns.push(new DocumentTextRun(""));
    const textDelta = replacement.length - (end - start);
    const runDelta = nextRuns.length - this.runs.length;
    this.document.assertTextLengthDelta(textDelta);
    this.document.assertRunDelta(runDelta);
    if (markChanged) this.document.assertCanChange();
    this.runStorage.length = 0;
    this.runStorage.push(...nextRuns);
    this.document.commitTextLengthDelta(textDelta, DOCUMENT_INTERNAL_ACCESS);
    this.document.commitRunDelta(runDelta, DOCUMENT_INTERNAL_ACCESS);
    this.document.rebaseParagraphAnchors(
      this.id,
      start,
      end,
      replacement.length,
      DOCUMENT_INTERNAL_ACCESS,
    );
    if (markChanged) this.document.changed(DOCUMENT_INTERNAL_ACCESS);
    return inserted;
  }
  format(format: DocumentParagraphFormat): void {
    const { start, end, style } = format;
    const current = this.text;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > current.length
    )
      throw new Error("Invalid paragraph format range");
    if (!isUnicodeBoundary(current, start) || !isUnicodeBoundary(current, end))
      throw new Error("Paragraph formatting must not split a Unicode surrogate pair");
    validateTextStylePatch(style);
    if (start === end || Object.keys(style).length === 0) return;
    const before = sliceTextRuns(this.runs, 0, start);
    const selected = sliceTextRuns(this.runs, start, end).map(
      (run) => new DocumentTextRun(run.text, applyTextStylePatch(run.style, style)),
    );
    const after = sliceTextRuns(this.runs, end, current.length);
    const nextRuns = mergeAdjacentTextRuns([...before, ...selected, ...after]);
    if (nextRuns.length === 0) nextRuns.push(new DocumentTextRun(""));
    const runDelta = nextRuns.length - this.runs.length;
    this.document.assertRunDelta(runDelta);
    this.document.assertCanChange();
    this.runStorage.length = 0;
    this.runStorage.push(...nextRuns);
    this.document.commitRunDelta(runDelta, DOCUMENT_INTERNAL_ACCESS);
    this.document.changed(DOCUMENT_INTERNAL_ACCESS);
  }
  inspectRecord(): Record<string, unknown> {
    return {
      kind: this.kind,
      id: this.id,
      text: this.text,
      runs: this.runs.map((run) => run.serialize()),
      style: this.style,
    };
  }
  serialize(): SerializedParagraph {
    return {
      kind: this.kind,
      id: this.id,
      runs: this.runs.map((run) => run.serialize()),
      style: cloneParagraphStyle(this.style),
    };
  }
  static restore(
    document: Document,
    value: SerializedParagraph,
    access: DocumentInternalAccess,
  ): DocumentParagraph {
    assertDocumentInternalAccess(access);
    return new DocumentParagraph(
      document,
      value.runs.map(DocumentTextRun.restore),
      value.style,
      value.id,
      DOCUMENT_INTERNAL_ACCESS,
    );
  }
}

export class DocumentTable {
  readonly kind = "table" as const;
  readonly id: string;
  readonly rows: readonly (readonly (readonly DocumentTextRun[])[])[];
  private styleValue: DocumentTableStyle;
  private readonly validationPage: DocumentPageGeometry;

  constructor(
    private readonly document: Document,
    rows: ReadonlyArray<ReadonlyArray<string | readonly DocumentTextRun[]>>,
    style: DocumentTableStyle = {},
    existingId?: string,
    pageForValidation?: DocumentPageGeometry,
    access?: DocumentInternalAccess,
  ) {
    assertDocumentInternalAccess(access as DocumentInternalAccess);
    const width = rows[0]?.length ?? 0;
    if (width === 0 || rows.some((row) => row.length !== width)) {
      throw new Error("Document table must be a non-empty rectangle");
    }
    const cellCount = rows.length * width;
    ensureCapacity(cellCount, MAX_TABLE_CELLS, "document table cells");
    const runCount = rows.reduce(
      (tableTotal, row) =>
        tableTotal +
        row.reduce((rowTotal, cell) => rowTotal + (typeof cell === "string" ? 1 : cell.length), 0),
      0,
    );
    document.assertRunDelta(runCount);
    const materializedRows = rows.map((row) =>
      row.map((cell) =>
        typeof cell === "string"
          ? [new DocumentTextRun(cell)]
          : cell.map((run) => new DocumentTextRun(run.text, { ...run.style })),
      ),
    );
    this.rows = freezeTableRows(materializedRows);
    this.validationPage = Object.freeze({
      ...(pageForValidation ?? document.sections.items.at(-1)?.page ?? DEFAULT_PAGE),
    });
    this.styleValue = freezeTableStyle(style);
    validateTableStyle(this.styleValue, width, rows.length, this.validationPage);
    const textLength = this.rows.reduce(
      (tableTotal, row) =>
        tableTotal +
        row.reduce(
          (rowTotal, cell) =>
            rowTotal + cell.reduce((cellTotal, run) => cellTotal + run.text.length, 0),
          0,
        ),
      0,
    );
    document.assertBlockDelta(1);
    document.assertCellDelta(cellCount);
    document.assertTextLengthDelta(textLength);
    this.id = document.allocateId("dt", this, existingId, DOCUMENT_INTERNAL_ACCESS);
    document.commitBlockDelta(1, DOCUMENT_INTERNAL_ACCESS);
    document.commitCellDelta(cellCount, DOCUMENT_INTERNAL_ACCESS);
    document.commitRunDelta(runCount, DOCUMENT_INTERNAL_ACCESS);
    document.commitTextLengthDelta(textLength, DOCUMENT_INTERNAL_ACCESS);
  }

  get style(): DocumentTableStyle {
    return this.styleValue;
  }
  setStyle(style: DocumentTableStyle): void {
    const next = freezeTableStyle(style);
    validateTableStyle(next, this.rows[0]?.length ?? 0, this.rows.length, this.validationPage);
    this.document.assertCanChange();
    this.styleValue = next;
    this.document.changed(DOCUMENT_INTERNAL_ACCESS);
  }

  inspectRecord(): Record<string, unknown> {
    return {
      kind: this.kind,
      id: this.id,
      rowCount: this.rows.length,
      colCount: this.rows[0]?.length ?? 0,
      values: this.rows.map((row) => row.map((cell) => cell.map((run) => run.text).join(""))),
      style: this.style,
    };
  }
  serialize(): SerializedTable {
    return {
      kind: this.kind,
      id: this.id,
      rows: this.rows.map((row) => row.map((cell) => cell.map((run) => run.serialize()))),
      style: cloneTableStyle(this.style),
    };
  }
  static restore(
    document: Document,
    value: SerializedTable,
    pageForValidation?: DocumentPageGeometry,
    access?: DocumentInternalAccess,
  ): DocumentTable {
    assertDocumentInternalAccess(access as DocumentInternalAccess);
    return new DocumentTable(
      document,
      value.rows.map((row) => row.map((cell) => cell.map(DocumentTextRun.restore))),
      value.style,
      value.id,
      pageForValidation,
      DOCUMENT_INTERNAL_ACCESS,
    );
  }
}

export class DocumentPageBreak {
  readonly kind = "pageBreak" as const;
  readonly id: string;
  constructor(document: Document, existingId?: string, access?: DocumentInternalAccess) {
    assertDocumentInternalAccess(access as DocumentInternalAccess);
    document.assertBlockDelta(1);
    this.id = document.allocateId("pb", this, existingId, DOCUMENT_INTERNAL_ACCESS);
    document.commitBlockDelta(1, DOCUMENT_INTERNAL_ACCESS);
  }
  inspectRecord(): Record<string, unknown> {
    return { kind: this.kind, id: this.id };
  }
  serialize(): SerializedPageBreak {
    return { kind: this.kind, id: this.id };
  }
}

export class DocumentComments {
  private readonly itemStorage: DocumentCommentThread[] = [];
  private readonly byBlock = new Map<string, DocumentCommentThread[]>();
  readonly items: readonly DocumentCommentThread[];
  private author = "User";
  constructor(
    private readonly document: Document,
    access: DocumentInternalAccess,
  ) {
    assertDocumentInternalAccess(access);
    this.items = readonlyArrayView(this.itemStorage, "document comments");
  }
  setSelf(value: { displayName: string }): void {
    const author = value.displayName.trim();
    validateAuthor(author);
    this.author = author;
  }
  addThread(
    anchor: { block: DocumentParagraph; start: number; end: number },
    text: string,
    options: { author?: string; createdAt?: string; resolved?: boolean } = {},
  ): DocumentCommentThread {
    ensureCapacity(this.items.length + 1, 100_000, "document comments");
    if (!this.document.ownsObject(anchor.block.id, anchor.block)) {
      throw new Error("Comment anchor paragraph belongs to another document");
    }
    validateAnchor(anchor.block, anchor.start, anchor.end, true);
    validateText(text, "document comment");
    assertNonCrossingCommentRanges([
      ...(this.byBlock.get(anchor.block.id) ?? []),
      { start: anchor.start, end: anchor.end },
    ]);
    this.document.assertCanChange();
    const author = options.author ?? this.author;
    validateAuthor(author);
    if (options.resolved !== undefined && typeof options.resolved !== "boolean") {
      throw new Error("Comment resolved state must be boolean");
    }
    const thread = new DocumentCommentThread(
      this.document,
      anchor.block.id,
      anchor.start,
      anchor.end,
      author,
      text,
      undefined,
      options.createdAt,
      DOCUMENT_INTERNAL_ACCESS,
    );
    if (options.resolved) {
      thread.setImportedResolved(true, DOCUMENT_INTERNAL_ACCESS);
    }
    this.itemStorage.push(thread);
    appendRangeObject(this.byBlock, thread.blockId, thread);
    this.document.changed(DOCUMENT_INTERNAL_ACCESS);
    return thread;
  }
  forBlock(blockId: string, access: DocumentInternalAccess): readonly DocumentCommentThread[] {
    assertDocumentInternalAccess(access);
    return this.byBlock.get(blockId) ?? [];
  }
  restore(value: SerializedDocumentComment, access: DocumentInternalAccess): void {
    assertDocumentInternalAccess(access);
    ensureCapacity(this.items.length + 1, 100_000, "document comments");
    const thread = DocumentCommentThread.restore(this.document, value, DOCUMENT_INTERNAL_ACCESS);
    this.itemStorage.push(thread);
    appendRangeObject(this.byBlock, thread.blockId, thread);
  }
}

export class DocumentCommentThread {
  readonly id: string;
  private resolvedValue = false;
  private startValue: number;
  private endValue: number;
  private readonly replyStorage: Array<{ author: string; text: string; createdAt: string }> = [];
  readonly replies: ReadonlyArray<{
    readonly author: string;
    readonly text: string;
    readonly createdAt: string;
  }>;
  constructor(
    private readonly document: Document,
    readonly blockId: string,
    start: number,
    end: number,
    author: string,
    text: string,
    existingId?: string,
    createdAt?: string,
    access?: DocumentInternalAccess,
  ) {
    assertDocumentInternalAccess(access as DocumentInternalAccess);
    this.startValue = start;
    this.endValue = end;
    this.replies = readonlyArrayView(this.replyStorage, "document comment replies");
    validateAuthor(author);
    validateText(text, "document comment");
    document.assertTextLengthDelta(text.length);
    document.assertReplyDelta(1);
    const validatedCreatedAt = validateIsoDate(createdAt ?? document.now());
    this.id = document.allocateId("dc", this, existingId, DOCUMENT_INTERNAL_ACCESS);
    this.replyStorage.push(Object.freeze({ author, text, createdAt: validatedCreatedAt }));
    document.commitTextLengthDelta(text.length, DOCUMENT_INTERNAL_ACCESS);
    document.commitReplyDelta(1, DOCUMENT_INTERNAL_ACCESS);
  }
  get start(): number {
    return this.startValue;
  }
  get end(): number {
    return this.endValue;
  }
  get resolved(): boolean {
    return this.resolvedValue;
  }
  rebaseTo(start: number, end: number, access: DocumentInternalAccess): void {
    assertDocumentInternalAccess(access);
    this.startValue = start;
    this.endValue = end;
  }
  setImportedResolved(resolved: boolean, access: DocumentInternalAccess): void {
    assertDocumentInternalAccess(access);
    this.resolvedValue = resolved;
  }
  addReply(text: string, author = "User", createdAt?: string): void {
    validateText(text, "document comment reply");
    validateAuthor(author);
    this.document.assertTextLengthDelta(text.length);
    this.document.assertReplyDelta(1);
    this.document.assertCanChange();
    this.replyStorage.push(
      Object.freeze({
        author,
        text,
        createdAt: validateIsoDate(createdAt ?? this.document.now()),
      }),
    );
    this.document.commitTextLengthDelta(text.length, DOCUMENT_INTERNAL_ACCESS);
    this.document.commitReplyDelta(1, DOCUMENT_INTERNAL_ACCESS);
    this.document.changed(DOCUMENT_INTERNAL_ACCESS);
  }
  appendImportedReply(
    reply: { author: string; text: string; createdAt: string },
    access: DocumentInternalAccess,
  ): void {
    assertDocumentInternalAccess(access);
    validateAuthor(reply.author);
    validateText(reply.text, "document comment reply");
    validateIsoDate(reply.createdAt);
    this.document.assertTextLengthDelta(reply.text.length);
    this.document.assertReplyDelta(1);
    this.replyStorage.push(Object.freeze({ ...reply }));
    this.document.commitTextLengthDelta(reply.text.length, DOCUMENT_INTERNAL_ACCESS);
    this.document.commitReplyDelta(1, DOCUMENT_INTERNAL_ACCESS);
  }
  resolve(): void {
    if (this.resolvedValue) return;
    this.document.assertCanChange();
    this.resolvedValue = true;
    this.document.changed(DOCUMENT_INTERNAL_ACCESS);
  }
  reopen(): void {
    if (!this.resolvedValue) return;
    this.document.assertCanChange();
    this.resolvedValue = false;
    this.document.changed(DOCUMENT_INTERNAL_ACCESS);
  }
  inspectRecord(): Record<string, unknown> {
    return {
      kind: "comment",
      id: this.id,
      blockId: this.blockId,
      start: this.start,
      end: this.end,
      resolved: this.resolved,
      replies: this.replies,
    };
  }
  serialize(): SerializedDocumentComment {
    return {
      id: this.id,
      blockId: this.blockId,
      start: this.start,
      end: this.end,
      resolved: this.resolved,
      replies: this.replies.map((reply) => ({ ...reply })),
    };
  }
  static restore(
    document: Document,
    value: SerializedDocumentComment,
    access: DocumentInternalAccess,
  ): DocumentCommentThread {
    assertDocumentInternalAccess(access);
    const first = value.replies[0] ?? {
      author: "User",
      text: "",
      createdAt: new Date(0).toISOString(),
    };
    const thread = new DocumentCommentThread(
      document,
      value.blockId,
      value.start,
      value.end,
      first.author,
      first.text,
      value.id,
      first.createdAt,
      DOCUMENT_INTERNAL_ACCESS,
    );
    thread.replyStorage.length = 0;
    thread.replyStorage.push(
      Object.freeze({
        author: validateAuthor(first.author),
        text: validateAndReturnText(first.text, "document comment reply"),
        createdAt: validateIsoDate(first.createdAt),
      }),
    );
    for (const reply of value.replies.slice(1)) {
      thread.appendImportedReply(
        {
          author: validateAuthor(reply.author),
          text: validateAndReturnText(reply.text, "document comment reply"),
          createdAt: validateIsoDate(reply.createdAt),
        },
        DOCUMENT_INTERNAL_ACCESS,
      );
    }
    thread.resolvedValue = value.resolved;
    return thread;
  }
}

export class TrackedChanges {
  private readonly itemStorage: TrackedChange[] = [];
  private readonly byBlock = new Map<string, TrackedChange[]>();
  readonly items: readonly TrackedChange[];
  constructor(
    private readonly document: Document,
    access: DocumentInternalAccess,
  ) {
    assertDocumentInternalAccess(access);
    this.items = readonlyArrayView(this.itemStorage, "document tracked changes");
  }
  add(
    anchor: { block: DocumentParagraph; start: number; end: number },
    kind: "insert" | "delete",
    author = "User",
    createdAt?: string,
  ): TrackedChange {
    ensureCapacity(this.items.length + 1, 100_000, "document tracked changes");
    if (!this.document.ownsObject(anchor.block.id, anchor.block)) {
      throw new Error("Tracked-change anchor paragraph belongs to another document");
    }
    validateAnchor(anchor.block, anchor.start, anchor.end, false);
    validateAuthor(author);
    assertNonOverlappingTrackedChangeRanges([
      ...(this.byBlock.get(anchor.block.id) ?? []),
      { start: anchor.start, end: anchor.end },
    ]);
    this.document.assertCanChange();
    const change = new TrackedChange(
      this.document,
      anchor.block.id,
      kind,
      anchor.start,
      anchor.end,
      author,
      undefined,
      createdAt,
      DOCUMENT_INTERNAL_ACCESS,
    );
    this.itemStorage.push(change);
    appendRangeObject(this.byBlock, change.blockId, change);
    this.document.changed(DOCUMENT_INTERNAL_ACCESS);
    return change;
  }
  forBlock(blockId: string, access: DocumentInternalAccess): readonly TrackedChange[] {
    assertDocumentInternalAccess(access);
    return this.byBlock.get(blockId) ?? [];
  }
  restore(value: SerializedTrackedChange, access: DocumentInternalAccess): void {
    assertDocumentInternalAccess(access);
    ensureCapacity(this.items.length + 1, 100_000, "document tracked changes");
    const change = TrackedChange.restore(this.document, value, DOCUMENT_INTERNAL_ACCESS);
    this.itemStorage.push(change);
    appendRangeObject(this.byBlock, change.blockId, change);
  }

  remove(change: TrackedChange, access: DocumentInternalAccess): void {
    assertDocumentInternalAccess(access);
    const index = this.itemStorage.indexOf(change);
    if (index < 0) throw new Error(`Unknown tracked change: ${change.id}`);
    this.itemStorage.splice(index, 1);
    const blockChanges = this.byBlock.get(change.blockId);
    const blockIndex = blockChanges?.indexOf(change) ?? -1;
    if (!blockChanges || blockIndex < 0) throw new Error("Tracked-change index is inconsistent");
    blockChanges.splice(blockIndex, 1);
    if (blockChanges.length === 0) this.byBlock.delete(change.blockId);
  }
}

export class TrackedChange {
  readonly id: string;
  readonly createdAt: string;
  private startValue: number;
  private endValue: number;
  constructor(
    private readonly document: Document,
    readonly blockId: string,
    readonly kind: "insert" | "delete",
    start: number,
    end: number,
    readonly author: string,
    existingId?: string,
    createdAt?: string,
    access?: DocumentInternalAccess,
  ) {
    assertDocumentInternalAccess(access as DocumentInternalAccess);
    this.startValue = start;
    this.endValue = end;
    validateAuthor(author);
    const validatedCreatedAt = validateIsoDate(createdAt ?? document.now());
    this.id = document.allocateId("chg", this, existingId, DOCUMENT_INTERNAL_ACCESS);
    this.createdAt = validatedCreatedAt;
  }
  get start(): number {
    return this.startValue;
  }
  get end(): number {
    return this.endValue;
  }
  rebaseTo(start: number, end: number, access: DocumentInternalAccess): void {
    assertDocumentInternalAccess(access);
    this.startValue = start;
    this.endValue = end;
  }
  inspectRecord(): Record<string, unknown> {
    return {
      kind: "change",
      id: this.id,
      blockId: this.blockId,
      changeKind: this.kind,
      start: this.start,
      end: this.end,
      author: this.author,
      createdAt: this.createdAt,
    };
  }
  serialize(): SerializedTrackedChange {
    return {
      id: this.id,
      blockId: this.blockId,
      kind: this.kind,
      start: this.start,
      end: this.end,
      author: this.author,
      createdAt: this.createdAt,
    };
  }
  static restore(
    document: Document,
    value: SerializedTrackedChange,
    access: DocumentInternalAccess,
  ): TrackedChange {
    assertDocumentInternalAccess(access);
    return new TrackedChange(
      document,
      value.blockId,
      value.kind,
      value.start,
      value.end,
      value.author,
      value.id,
      value.createdAt,
      DOCUMENT_INTERNAL_ACCESS,
    );
  }
}

// oxlint-disable-next-line typescript/no-extraneous-class -- skill compatibility exposes this namespace-style class.
export class DocumentFile {
  static async exportDocx(document: Document): Promise<FileBlob> {
    const codec = await import("@opengeni/artifact-tool/document/docx");
    return codec.exportDocx(document);
  }

  static async importDocx(input: FileBlob | Blob | ArrayBuffer): Promise<Document> {
    const codec = await import("@opengeni/artifact-tool/document/docx");
    return codec.importDocx(input);
  }
}

function validateSerializedDocumentEnvelope(value: unknown): asserts value is SerializedDocument {
  if (!isRecord(value)) throw new Error("Serialized document must be an object");
  assertOnlyKeys(
    value,
    [
      "version",
      "idNamespace",
      "nextId",
      "revision",
      "evenAndOddHeaders",
      "trackRevisions",
      "page",
      "blocks",
      "sections",
      "comments",
      "changes",
    ],
    "serialized document",
  );
  if (value.version !== 1)
    throw new Error(`Unsupported document model version: ${String(value.version)}`);
  if (typeof value.idNamespace !== "string" || !NAMESPACE_PATTERN.test(value.idNamespace)) {
    throw new Error("Serialized document idNamespace is invalid");
  }
  if (
    !Number.isSafeInteger(value.nextId) ||
    (value.nextId as number) < 1 ||
    (value.nextId as number) > MAX_STRUCTURAL_ID + 1
  ) {
    throw new Error("Serialized document nextId is invalid");
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0)
    throw new Error("Serialized document revision is invalid");
  if (value.evenAndOddHeaders !== undefined && typeof value.evenAndOddHeaders !== "boolean") {
    throw new Error("Serialized document evenAndOddHeaders is invalid");
  }
  if (value.trackRevisions !== undefined && typeof value.trackRevisions !== "boolean") {
    throw new Error("Serialized document trackRevisions is invalid");
  }
  if (!isRecord(value.page)) throw new Error("Serialized document page is invalid");
  validatePage(value.page as DocumentPageGeometry);
  const body = boundedArray(value.blocks, MAX_DOCUMENT_BLOCKS, "serialized document blocks");
  const sections = boundedArray(value.sections, 10_000, "serialized document sections");
  const comments = boundedArray(value.comments, 100_000, "serialized document comments");
  const changes = boundedArray(value.changes, 100_000, "serialized document changes");
  let totalBlocks = body.length;
  let totalCells = 0;
  let totalText = 0;
  let totalRuns = 0;
  const inspectBlock = (candidate: unknown, allowPageBreak: boolean): void => {
    if (
      !isRecord(candidate) ||
      typeof candidate.kind !== "string" ||
      typeof candidate.id !== "string"
    )
      throw new Error("Serialized document block is invalid");
    if (candidate.kind === "pageBreak") {
      if (!allowPageBreak) throw new Error("Headers and footers cannot contain page breaks");
      assertOnlyKeys(candidate, ["kind", "id"], "serialized page break");
      return;
    }
    if (candidate.kind === "paragraph") {
      assertOnlyKeys(candidate, ["kind", "id", "runs", "style"], "serialized paragraph");
      const runs = boundedArray(candidate.runs, 1_000_000, "serialized paragraph runs");
      totalRuns += runs.length;
      ensureCapacity(totalRuns, MAX_TEXT_RUNS, "serialized document text runs");
      if (!isRecord(candidate.style)) throw new Error("Serialized paragraph style is invalid");
      validateParagraphStyle(candidate.style as DocumentParagraphStyle);
      for (const run of runs) {
        if (!isRecord(run) || typeof run.text !== "string" || !isRecord(run.style))
          throw new Error("Serialized text run is invalid");
        assertOnlyKeys(run, ["text", "style"], "serialized text run");
        validateText(run.text, "serialized document text");
        validateTextStyle(run.style as DocumentTextStyle);
        totalText += run.text.length;
        ensureCapacity(totalText, MAX_TEXT_LENGTH, "serialized document text");
      }
      return;
    }
    if (candidate.kind !== "table")
      throw new Error(`Unknown serialized document block kind: ${candidate.kind}`);
    assertOnlyKeys(candidate, ["kind", "id", "rows", "style"], "serialized table");
    const rows = boundedArray(candidate.rows, MAX_TABLE_CELLS, "serialized table rows");
    if (rows.length === 0 || !isRecord(candidate.style))
      throw new Error("Serialized table is invalid");
    let columnCount: number | undefined;
    for (const row of rows) {
      const cells = boundedArray(row, MAX_TABLE_CELLS, "serialized table cells");
      if (columnCount === undefined) columnCount = cells.length;
      if (cells.length === 0 || cells.length !== columnCount)
        throw new Error("Serialized table must be a non-empty rectangle");
      totalCells += cells.length;
      ensureCapacity(totalCells, MAX_TABLE_CELLS, "serialized table cells");
      for (const cell of cells) {
        const runs = boundedArray(cell, 1_000_000, "serialized table cell runs");
        totalRuns += runs.length;
        ensureCapacity(totalRuns, MAX_TEXT_RUNS, "serialized document text runs");
        for (const run of runs) {
          if (!isRecord(run) || typeof run.text !== "string" || !isRecord(run.style))
            throw new Error("Serialized table text run is invalid");
          assertOnlyKeys(run, ["text", "style"], "serialized table text run");
          validateText(run.text, "serialized table text");
          validateTextStyle(run.style as DocumentTextStyle);
          totalText += run.text.length;
          ensureCapacity(totalText, MAX_TEXT_LENGTH, "serialized document text");
        }
      }
    }
  };
  for (const block of body) inspectBlock(block, true);
  for (const section of sections) {
    if (
      !isRecord(section) ||
      typeof section.id !== "string" ||
      !Number.isSafeInteger(section.startBlockIndex) ||
      !isRecord(section.page)
    ) {
      throw new Error("Serialized document section is invalid");
    }
    assertOnlyKeys(
      section,
      ["id", "startBlockIndex", "titlePage", "page", "headers", "footers"],
      "serialized section",
    );
    if (section.titlePage !== undefined && typeof section.titlePage !== "boolean") {
      throw new Error("Serialized section titlePage is invalid");
    }
    validatePage(section.page as DocumentPageGeometry);
    for (const groupName of ["headers", "footers"] as const) {
      const group = section[groupName];
      if (!isRecord(group)) throw new Error(`Serialized section ${groupName} are invalid`);
      assertOnlyKeys(group, ["default", "first", "even"], `serialized section ${groupName}`);
      for (const variant of ["default", "first", "even"] as const) {
        const story = group[variant];
        if (!isRecord(story) || typeof story.id !== "string")
          throw new Error(`Serialized section ${groupName}.${variant} is invalid`);
        assertOnlyKeys(story, ["id", "blocks"], `serialized section ${groupName}.${variant}`);
        const storyBlocks = boundedArray(
          story.blocks,
          MAX_DOCUMENT_BLOCKS,
          "serialized header/footer blocks",
        );
        totalBlocks += storyBlocks.length;
        ensureCapacity(totalBlocks, MAX_DOCUMENT_BLOCKS, "all serialized document story blocks");
        for (const block of storyBlocks) inspectBlock(block, false);
      }
    }
  }
  let replyCount = 0;
  for (const comment of comments) {
    if (
      !isRecord(comment) ||
      typeof comment.id !== "string" ||
      typeof comment.blockId !== "string" ||
      !Number.isSafeInteger(comment.start) ||
      !Number.isSafeInteger(comment.end) ||
      typeof comment.resolved !== "boolean"
    ) {
      throw new Error("Serialized document comment is invalid");
    }
    assertOnlyKeys(
      comment,
      ["id", "blockId", "start", "end", "resolved", "replies"],
      "serialized comment",
    );
    const replies = boundedArray(comment.replies, 100_000, "serialized comment replies");
    if (replies.length === 0) throw new Error("Serialized comment must contain a root reply");
    replyCount += replies.length;
    ensureCapacity(replyCount, 100_000, "serialized comment replies");
    for (const reply of replies) {
      if (
        !isRecord(reply) ||
        typeof reply.author !== "string" ||
        typeof reply.text !== "string" ||
        typeof reply.createdAt !== "string"
      )
        throw new Error("Serialized document comment reply is invalid");
      assertOnlyKeys(reply, ["author", "text", "createdAt"], "serialized comment reply");
      validateAuthor(reply.author);
      validateText(reply.text, "serialized comment reply");
      validateIsoDate(reply.createdAt);
      totalText += reply.text.length;
      ensureCapacity(totalText, MAX_TEXT_LENGTH, "serialized document text");
    }
  }
  for (const change of changes) {
    if (
      !isRecord(change) ||
      typeof change.id !== "string" ||
      typeof change.blockId !== "string" ||
      (change.kind !== "insert" && change.kind !== "delete") ||
      !Number.isSafeInteger(change.start) ||
      !Number.isSafeInteger(change.end) ||
      typeof change.author !== "string" ||
      typeof change.createdAt !== "string"
    ) {
      throw new Error("Serialized tracked change is invalid");
    }
    assertOnlyKeys(
      change,
      ["id", "blockId", "kind", "start", "end", "author", "createdAt"],
      "serialized tracked change",
    );
  }
  const firstPage = (sections[0] as { page?: unknown } | undefined)?.page;
  if (
    !isRecord(firstPage) ||
    !samePageGeometry(firstPage as DocumentPageGeometry, value.page as DocumentPageGeometry)
  ) {
    throw new Error("Serialized document page must equal its first section page");
  }
}

function samePageGeometry(left: DocumentPageGeometry, right: DocumentPageGeometry): boolean {
  return (
    left.widthPt === right.widthPt &&
    left.heightPt === right.heightPt &&
    left.marginTopPt === right.marginTopPt &&
    left.marginRightPt === right.marginRightPt &&
    left.marginBottomPt === right.marginBottomPt &&
    left.marginLeftPt === right.marginLeftPt &&
    (left.headerPt ?? 36) === (right.headerPt ?? 36) &&
    (left.footerPt ?? 36) === (right.footerPt ?? 36) &&
    (left.gutterPt ?? 0) === (right.gutterPt ?? 0)
  );
}

function validateDocument(document: Document): void {
  if (typeof document.evenAndOddHeaders !== "boolean")
    throw new Error("Document evenAndOddHeaders is invalid");
  if (typeof document.trackRevisions !== "boolean")
    throw new Error("Document trackRevisions is invalid");
  ensureCapacity(document.sections.items.length, 10_000, "document sections");
  if (document.sections.items.length === 0)
    throw new Error("Document must have at least one section");
  if (document.sections.items[0]?.startBlockIndex !== 0)
    throw new Error("The first document section must start at block 0");
  let previousStart = -1;
  for (const section of document.sections.items) {
    if (
      !Number.isSafeInteger(section.startBlockIndex) ||
      section.startBlockIndex <= previousStart ||
      section.startBlockIndex > document.blocks.items.length
    ) {
      throw new Error(`Invalid section boundary at body block ${section.startBlockIndex}`);
    }
    previousStart = section.startBlockIndex;
    if (typeof section.titlePage !== "boolean") throw new Error("Section titlePage is invalid");
    validatePage(section.page);
  }
  const allStoryBlocks = document.allStoryBlocks();
  ensureCapacity(document.blocks.items.length, MAX_DOCUMENT_BLOCKS, "document blocks");
  ensureCapacity(allStoryBlocks.length, MAX_DOCUMENT_BLOCKS, "all document story blocks");
  let cells = 0;
  let textLength = 0;
  let runCount = 0;
  let replyCount = 0;
  for (const block of allStoryBlocks) {
    if (block instanceof DocumentParagraph) {
      validateParagraphStyle(block.style);
      validateText(block.text, "document paragraph");
      for (const run of block.runs) {
        runCount += 1;
        ensureCapacity(runCount, MAX_TEXT_RUNS, "document text runs");
        validateTextStyle(run.style);
        textLength += run.text.length;
        ensureCapacity(textLength, MAX_TEXT_LENGTH, "document text");
      }
    } else if (block instanceof DocumentTable) {
      const width = block.rows[0]?.length ?? 0;
      if (width === 0 || block.rows.some((row) => row.length !== width))
        throw new Error(`Document table ${block.id} is not rectangular`);
      cells += block.rows.length * width;
      ensureCapacity(cells, MAX_TABLE_CELLS, "document table cells");
      for (const row of block.rows)
        for (const cell of row)
          for (const run of cell) {
            runCount += 1;
            ensureCapacity(runCount, MAX_TEXT_RUNS, "document text runs");
            validateText(run.text, "document table text");
            validateTextStyle(run.style);
            textLength += run.text.length;
            ensureCapacity(textLength, MAX_TEXT_LENGTH, "document text");
          }
    }
  }
  const blockCount = allStoryBlocks.length;
  if (blockCount !== document.trackedBlockCount) {
    throw new Error("Document blocks were mutated outside the authoritative edit API");
  }
  if (cells !== document.trackedCellCount) {
    throw new Error("Document table cells were mutated outside the authoritative edit API");
  }
  if (runCount !== document.trackedRunCount) {
    throw new Error("Document text runs were mutated outside the authoritative edit API");
  }
  for (let sectionIndex = 0; sectionIndex < document.sections.items.length; sectionIndex++) {
    const section = document.sections.items[sectionIndex]!;
    const end =
      document.sections.items[sectionIndex + 1]?.startBlockIndex ?? document.blocks.items.length;
    for (const block of document.blocks.items.slice(section.startBlockIndex, end)) {
      if (block instanceof DocumentTable)
        validateTableStyle(
          block.style,
          block.rows[0]?.length ?? 0,
          block.rows.length,
          section.page,
        );
    }
    for (const story of section.allStories()) {
      for (const block of story.items) {
        if (block instanceof DocumentTable)
          validateTableStyle(
            block.style,
            block.rows[0]?.length ?? 0,
            block.rows.length,
            section.page,
          );
      }
    }
  }
  const paragraphIds = new Map(
    allStoryBlocks
      .filter((block): block is DocumentParagraph => block instanceof DocumentParagraph)
      .map((block) => [block.id, block]),
  );
  ensureCapacity(document.comments.items.length, 100_000, "document comments");
  ensureCapacity(document.changes.items.length, 100_000, "document tracked changes");
  const commentRangesByBlock = new Map<string, Array<{ start: number; end: number }>>();
  const changeRangesByBlock = new Map<string, Array<{ start: number; end: number }>>();
  for (const comment of document.comments.items) {
    const block = paragraphIds.get(comment.blockId);
    if (!block) throw new Error(`Comment ${comment.id} references a missing paragraph`);
    validateAnchor(block, comment.start, comment.end, true);
    if (comment.replies.length === 0)
      throw new Error(`Comment ${comment.id} must contain a root reply`);
    appendRange(commentRangesByBlock, comment.blockId, comment);
    for (const reply of comment.replies) {
      validateAuthor(reply.author);
      validateText(reply.text, "document comment reply");
      validateIsoDate(reply.createdAt);
      textLength += reply.text.length;
      ensureCapacity(textLength, MAX_TEXT_LENGTH, "document text");
      replyCount += 1;
      ensureCapacity(replyCount, 100_000, "document comment replies");
    }
  }
  if (replyCount !== document.trackedReplyCount) {
    throw new Error("Document comment replies were mutated outside the authoritative edit API");
  }
  if (textLength !== document.trackedTextLength) {
    throw new Error("Document text was mutated outside the authoritative edit API");
  }
  for (const change of document.changes.items) {
    const block = paragraphIds.get(change.blockId);
    if (!block) throw new Error(`Tracked change ${change.id} references a missing paragraph`);
    validateAnchor(block, change.start, change.end, false);
    validateAuthor(change.author);
    validateIsoDate(change.createdAt);
    appendRange(changeRangesByBlock, change.blockId, change);
  }
  for (const ranges of commentRangesByBlock.values()) assertNonCrossingCommentRanges(ranges);
  for (const ranges of changeRangesByBlock.values())
    assertNonOverlappingTrackedChangeRanges(ranges);
}

function appendRange(
  map: Map<string, Array<{ start: number; end: number }>>,
  blockId: string,
  range: { start: number; end: number },
): void {
  const ranges = map.get(blockId);
  if (ranges) ranges.push(range);
  else map.set(blockId, [range]);
}

function appendRangeObject<T>(map: Map<string, T[]>, blockId: string, value: T): void {
  const values = map.get(blockId);
  if (values) values.push(value);
  else map.set(blockId, [value]);
}

function assertNonOverlappingTrackedChangeRanges(
  ranges: readonly { start: number; end: number }[],
): void {
  const sorted = [...ranges].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]!.start < sorted[index - 1]!.end) {
      throw new Error("Tracked changes must not overlap");
    }
  }
}

function assertNonCrossingCommentRanges(ranges: readonly { start: number; end: number }[]): void {
  const sorted = [...ranges].sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  const activeEnds: number[] = [];
  for (const range of sorted) {
    while (activeEnds.length > 0 && range.start >= activeEnds[activeEnds.length - 1]!) {
      activeEnds.pop();
    }
    const enclosingEnd = activeEnds[activeEnds.length - 1];
    if (enclosingEnd !== undefined && range.end > enclosingEnd) {
      throw new Error("Comment ranges must be nested or disjoint, not crossing");
    }
    if (range.end > range.start) activeEnds.push(range.end);
  }
}

function validatePage(page: DocumentPageGeometry): void {
  if (!isRecord(page)) throw new Error("Document page geometry must be an object");
  assertOnlyKeys(
    page,
    [
      "widthPt",
      "heightPt",
      "marginTopPt",
      "marginRightPt",
      "marginBottomPt",
      "marginLeftPt",
      "headerPt",
      "footerPt",
      "gutterPt",
    ],
    "document page geometry",
  );
  finiteInRange(page.widthPt, 72, 14_400, "page width");
  finiteInRange(page.heightPt, 72, 14_400, "page height");
  for (const [name, value] of Object.entries({
    top: page.marginTopPt,
    right: page.marginRightPt,
    bottom: page.marginBottomPt,
    left: page.marginLeftPt,
  })) {
    finiteInRange(value, 0, 2_880, `${name} page margin`);
  }
  finiteInRange(page.headerPt ?? 36, 0, 2_880, "header page margin");
  finiteInRange(page.footerPt ?? 36, 0, 2_880, "footer page margin");
  finiteInRange(page.gutterPt ?? 0, 0, 2_880, "page gutter");
  if (page.marginLeftPt + page.marginRightPt >= page.widthPt)
    throw new Error("Horizontal page margins consume the full page width");
  if (page.marginTopPt + page.marginBottomPt >= page.heightPt)
    throw new Error("Vertical page margins consume the full page height");
}

function validateTextStyle(style: DocumentTextStyle): void {
  if (!isRecord(style)) throw new Error("Document text style must be an object");
  assertOnlyKeys(
    style,
    ["fontFamily", "fontSizePt", "color", "bold", "italic", "underline", "strike"],
    "document text style",
  );
  if (style.fontFamily !== undefined && !/^[\p{L}\p{N} .,_'-]{1,128}$/u.test(style.fontFamily)) {
    throw new Error(`Unsafe or invalid document font family: ${style.fontFamily}`);
  }
  if (style.fontSizePt !== undefined) finiteInRange(style.fontSizePt, 1, 1_000, "font size");
  if (style.color !== undefined) normalizeHex(style.color);
  for (const key of ["bold", "italic", "underline", "strike"] as const) {
    if (style[key] !== undefined && typeof style[key] !== "boolean")
      throw new Error(`Document text style ${key} must be boolean`);
  }
}

function validateTextStylePatch(style: DocumentTextStylePatch): void {
  if (!isRecord(style)) throw new Error("Document text style patch must be an object");
  const allowed = new Set([
    "fontFamily",
    "fontSizePt",
    "color",
    "bold",
    "italic",
    "underline",
    "strike",
  ]);
  for (const key of Object.keys(style))
    if (!allowed.has(key)) throw new Error(`Unknown document text style property: ${key}`);
  const materialized: {
    -readonly [Key in keyof DocumentTextStyle]: DocumentTextStyle[Key];
  } = {};
  if (style.fontFamily !== undefined && style.fontFamily !== null)
    materialized.fontFamily = style.fontFamily;
  if (style.fontSizePt !== undefined && style.fontSizePt !== null)
    materialized.fontSizePt = style.fontSizePt;
  if (style.color !== undefined && style.color !== null) materialized.color = style.color;
  for (const key of ["bold", "italic", "underline", "strike"] as const) {
    const value = style[key];
    if (value !== undefined && value !== null) materialized[key] = value;
  }
  validateTextStyle(materialized);
}

function validateParagraphStyle(style: DocumentParagraphStyle): void {
  if (!isRecord(style)) throw new Error("Document paragraph style must be an object");
  assertOnlyKeys(
    style,
    [
      "headingLevel",
      "alignment",
      "spaceBeforePt",
      "spaceAfterPt",
      "lineHeight",
      "keepNext",
      "pageBreakBefore",
      "list",
    ],
    "document paragraph style",
  );
  if (
    style.headingLevel !== undefined &&
    (!Number.isInteger(style.headingLevel) || style.headingLevel < 1 || style.headingLevel > 6)
  )
    throw new Error("Heading level must be 1-6");
  if (
    style.alignment !== undefined &&
    !["left", "center", "right", "justify"].includes(style.alignment)
  )
    throw new Error(`Invalid paragraph alignment: ${String(style.alignment)}`);
  if (style.spaceBeforePt !== undefined)
    finiteInRange(style.spaceBeforePt, 0, 2_880, "paragraph space before");
  if (style.spaceAfterPt !== undefined)
    finiteInRange(style.spaceAfterPt, 0, 2_880, "paragraph space after");
  if (style.lineHeight !== undefined)
    finiteInRange(style.lineHeight, 0.5, 10, "paragraph line height");
  for (const key of ["keepNext", "pageBreakBefore"] as const) {
    if (style[key] !== undefined && typeof style[key] !== "boolean")
      throw new Error(`Document paragraph style ${key} must be boolean`);
  }
  if (style.list !== undefined) {
    if (!isRecord(style.list) || (style.list.kind !== "bullet" && style.list.kind !== "number"))
      throw new Error("Document list kind must be bullet or number");
    assertOnlyKeys(style.list, ["kind", "level", "instanceId"], "document list style");
    if (
      style.list.level !== undefined &&
      (!Number.isInteger(style.list.level) || style.list.level < 0 || style.list.level > 8)
    )
      throw new Error("List level must be 0-8");
    if (
      style.list.instanceId !== undefined &&
      !/^[A-Za-z0-9:_-]{1,128}$/u.test(style.list.instanceId)
    ) {
      throw new Error("List instanceId must contain 1-128 safe identifier characters");
    }
  }
}

function validateTableStyle(
  style: DocumentTableStyle,
  columnCount: number,
  rowCount: number,
  page: DocumentPageGeometry,
): void {
  if (!isRecord(style)) throw new Error("Document table style must be an object");
  assertOnlyKeys(
    style,
    [
      "widthPt",
      "columnWidthsPt",
      "headerRows",
      "cellPaddingPt",
      "borderColor",
      "headerFill",
      "allowRowSplit",
    ],
    "document table style",
  );
  const usableWidth = page.widthPt - page.marginLeftPt - page.marginRightPt;
  if (style.widthPt !== undefined) finiteInRange(style.widthPt, 1, usableWidth, "table width");
  if (style.columnWidthsPt !== undefined) {
    if (style.columnWidthsPt.length !== columnCount)
      throw new Error("Table columnWidthsPt must match the table column count");
    for (const width of style.columnWidthsPt)
      finiteInRange(width, 1, usableWidth, "table column width");
    const sum = style.columnWidthsPt.reduce((total, width) => total + width, 0);
    if (sum > usableWidth + 0.01)
      throw new Error("Table column widths exceed the usable page width");
    if (style.widthPt !== undefined && Math.abs(sum - style.widthPt) > 0.01) {
      throw new Error("Table widthPt must exactly equal the sum of columnWidthsPt");
    }
  }
  if (
    style.headerRows !== undefined &&
    (!Number.isInteger(style.headerRows) || style.headerRows < 0 || style.headerRows > rowCount)
  )
    throw new Error("Table headerRows must fit within the table row count");
  if (style.cellPaddingPt !== undefined)
    finiteInRange(style.cellPaddingPt, 0, 144, "table cell padding");
  if (style.borderColor !== undefined) normalizeHex(style.borderColor);
  if (style.headerFill !== undefined) normalizeHex(style.headerFill);
  if (style.allowRowSplit !== undefined && typeof style.allowRowSplit !== "boolean") {
    throw new Error("Table allowRowSplit must be boolean");
  }
}

function validateAnchor(
  block: DocumentParagraph,
  start: number,
  end: number,
  allowPoint: boolean,
): void {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > block.text.length ||
    (!allowPoint && start === end)
  ) {
    throw new Error("Invalid document text anchor");
  }
  if (!isUnicodeBoundary(block.text, start) || !isUnicodeBoundary(block.text, end)) {
    throw new Error("Document text anchors must not split a Unicode surrogate pair");
  }
}

function sameTextStyle(left: DocumentTextStyle, right: DocumentTextStyle): boolean {
  return (
    left.fontFamily === right.fontFamily &&
    left.fontSizePt === right.fontSizePt &&
    left.color === right.color &&
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.underline === right.underline &&
    left.strike === right.strike
  );
}

function validateAuthor(value: string): string {
  validateText(value, "document author");
  if (value.trim().length === 0 || value.length > 255)
    throw new Error("Document author must contain 1-255 characters");
  return value;
}

function validateText(value: string, label: string): void {
  if (value.length > MAX_TEXT_LENGTH)
    throw new Error(`${label} exceeds ${MAX_TEXT_LENGTH} UTF-16 code units`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(value))
    throw new Error(`${label} contains XML-forbidden control characters`);
  if (value.includes("\r")) throw new Error(`${label} must use LF rather than CR line breaks`);
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new Error(`${label} contains an unpaired surrogate`);
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${label} contains an unpaired surrogate`);
    }
  }
}

function validateAndReturnText(value: string, label: string): string {
  validateText(value, label);
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`Unknown ${label} property: ${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new Error(`${label} must contain plain data properties`);
    }
  }
}
function boundedArray(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  ensureCapacity(value.length, maximum, label);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) {
      throw new Error(`${label} must be a dense plain-data array`);
    }
  }
  return value;
}
function isUnicodeBoundary(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) return true;
  const previous = value.charCodeAt(offset - 1);
  const next = value.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}
function validateIsoDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value)
    throw new Error(`Invalid ISO timestamp: ${value}`);
  return value;
}
function normalizeHex(value: string): string {
  if (!/^#?[0-9A-Fa-f]{6}$/.test(value)) throw new Error(`Invalid or unsafe color: ${value}`);
  return `#${value.replace(/^#/, "").toUpperCase()}`;
}
function finiteInRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(`${label} must be between ${min} and ${max}`);
}
function ensureCapacity(value: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value > max) throw new Error(`${label} exceeds limit ${max}`);
}
function readonlyArrayView<T>(storage: T[], label: string): readonly T[] {
  return new Proxy(storage, {
    set(): boolean {
      throw new Error(`${label} are read-only; use the authoritative mutation API`);
    },
    deleteProperty(): boolean {
      throw new Error(`${label} are read-only; use the authoritative mutation API`);
    },
    defineProperty(): boolean {
      throw new Error(`${label} are read-only; use the authoritative mutation API`);
    },
    preventExtensions(): boolean {
      throw new Error(`${label} are read-only; use the authoritative mutation API`);
    },
    setPrototypeOf(): boolean {
      throw new Error(`${label} are read-only; use the authoritative mutation API`);
    },
  });
}
function cloneParagraphStyle(style: DocumentParagraphStyle): DocumentParagraphStyle {
  return { ...style, ...(style.list ? { list: { ...style.list } } : {}) };
}
function freezeParagraphStyle(style: DocumentParagraphStyle): DocumentParagraphStyle {
  const clone = cloneParagraphStyle(style);
  if (clone.list) Object.freeze(clone.list);
  return Object.freeze(clone);
}
function cloneTableStyle(style: DocumentTableStyle): DocumentTableStyle {
  return {
    ...style,
    ...(style.columnWidthsPt ? { columnWidthsPt: [...style.columnWidthsPt] } : {}),
  };
}
function freezeTableStyle(style: DocumentTableStyle): DocumentTableStyle {
  const clone = cloneTableStyle(style);
  if (clone.columnWidthsPt) Object.freeze(clone.columnWidthsPt);
  return Object.freeze(clone);
}
function freezeTableRows(
  rows: DocumentTextRun[][][],
): readonly (readonly (readonly DocumentTextRun[])[])[] {
  for (const row of rows) {
    for (const cell of row) Object.freeze(cell);
    Object.freeze(row);
  }
  return Object.freeze(rows) as readonly (readonly (readonly DocumentTextRun[])[])[];
}
function applyTextStylePatch(
  style: DocumentTextStyle,
  patch: DocumentTextStylePatch,
): DocumentTextStyle {
  const result: DocumentTextStyle = { ...style };
  for (const key of [
    "fontFamily",
    "fontSizePt",
    "color",
    "bold",
    "italic",
    "underline",
    "strike",
  ] as const) {
    if (!Object.hasOwn(patch, key)) continue;
    const value = patch[key];
    if (value === null || value === undefined) delete result[key];
    else Object.assign(result, { [key]: value });
  }
  return result;
}
function mergeAdjacentTextRuns(runs: readonly DocumentTextRun[]): DocumentTextRun[] {
  const result: DocumentTextRun[] = [];
  for (const run of runs) {
    const previous = result.at(-1);
    if (previous && sameTextStyle(previous.style, run.style)) {
      result[result.length - 1] = new DocumentTextRun(previous.text + run.text, previous.style);
    } else result.push(run);
  }
  return result;
}
function minimalTextEdit(
  previous: string,
  next: string,
): { start: number; end: number; replacement: string } {
  let start = 0;
  const maximumPrefix = Math.min(previous.length, next.length);
  while (start < maximumPrefix && previous.charCodeAt(start) === next.charCodeAt(start)) start += 1;
  while (start > 0 && (!isUnicodeBoundary(previous, start) || !isUnicodeBoundary(next, start)))
    start -= 1;
  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (
    previousEnd > start &&
    nextEnd > start &&
    previous.charCodeAt(previousEnd - 1) === next.charCodeAt(nextEnd - 1)
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }
  while (
    previousEnd < previous.length &&
    (!isUnicodeBoundary(previous, previousEnd) || !isUnicodeBoundary(next, nextEnd))
  ) {
    previousEnd += 1;
    nextEnd += 1;
  }
  return { start, end: previousEnd, replacement: next.slice(start, nextEnd) };
}
function collectReplacementEdits(
  value: string,
  search: string | RegExp,
  replacement: string,
): DocumentParagraphEdit[] {
  const edits: DocumentParagraphEdit[] = [];
  if (typeof search === "string") {
    const start = value.indexOf(search);
    if (start < 0) return edits;
    edits.push({
      start,
      end: start + search.length,
      text: expandReplacement(replacement, search, [], start, value),
    });
    return edits;
  }
  const expression = new RegExp(search.source, search.flags);
  let projectedLength = value.length;
  while (true) {
    const result = expression.exec(value);
    if (!result) break;
    const match = result[0];
    const offset = result.index;
    const captures = result
      .slice(1)
      .map((capture) => (capture === undefined ? undefined : String(capture)));
    const expanded = expandReplacement(replacement, match, captures, offset, value, result.groups);
    projectedLength += expanded.length - match.length;
    ensureCapacity(projectedLength, MAX_TEXT_LENGTH, "document replacement result");
    edits.push({
      start: offset,
      end: offset + match.length,
      text: expanded,
    });
    if (!expression.global) break;
    if (match.length === 0) {
      const unicodeSets = (expression as RegExp & { readonly unicodeSets?: boolean }).unicodeSets;
      expression.lastIndex = advanceStringIndex(
        value,
        expression.lastIndex,
        expression.unicode || unicodeSets === true,
      );
    }
  }
  return edits;
}

function advanceStringIndex(value: string, index: number, unicode: boolean): number {
  if (!unicode || index >= value.length) return index + 1;
  const first = value.charCodeAt(index);
  if (first < 0xd800 || first > 0xdbff || index + 1 >= value.length) return index + 1;
  const second = value.charCodeAt(index + 1);
  return second >= 0xdc00 && second <= 0xdfff ? index + 2 : index + 1;
}
function expandReplacement(
  replacement: string,
  match: string,
  captures: readonly (string | undefined)[],
  offset: number,
  source: string,
  groups?: Readonly<Record<string, string | undefined>>,
): string {
  let result = "";
  for (let index = 0; index < replacement.length; index += 1) {
    const character = replacement[index]!;
    if (character !== "$" || index + 1 >= replacement.length) {
      result += character;
      continue;
    }
    const next = replacement[index + 1]!;
    if (next === "$") {
      result += "$";
      index += 1;
    } else if (next === "&") {
      result += match;
      index += 1;
    } else if (next === "`") {
      result += source.slice(0, offset);
      index += 1;
    } else if (next === "'") {
      result += source.slice(offset + match.length);
      index += 1;
    } else if (next === "<" && groups) {
      const close = replacement.indexOf(">", index + 2);
      if (close < 0) {
        result += "$";
      } else {
        result += groups[replacement.slice(index + 2, close)] ?? "";
        index = close;
      }
    } else if (next >= "1" && next <= "9") {
      const first = Number(next);
      const secondCharacter = replacement[index + 2];
      const twoDigit =
        secondCharacter !== undefined && secondCharacter >= "0" && secondCharacter <= "9"
          ? first * 10 + Number(secondCharacter)
          : 0;
      const captureNumber =
        twoDigit > 0 && twoDigit <= captures.length
          ? twoDigit
          : first <= captures.length
            ? first
            : 0;
      if (captureNumber === 0) {
        result += "$";
      } else {
        result += captures[captureNumber - 1] ?? "";
        index += captureNumber === twoDigit ? 2 : 1;
      }
    } else {
      result += "$";
    }
  }
  return result;
}
function sliceTextRuns(
  runs: readonly DocumentTextRun[],
  start: number,
  end: number,
): DocumentTextRun[] {
  const result: DocumentTextRun[] = [];
  let offset = 0;
  for (const run of runs) {
    const runStart = offset;
    const runEnd = offset + run.text.length;
    offset = runEnd;
    const sliceStart = Math.max(start, runStart);
    const sliceEnd = Math.min(end, runEnd);
    if (sliceEnd <= sliceStart) continue;
    result.push(
      new DocumentTextRun(run.text.slice(sliceStart - runStart, sliceEnd - runStart), {
        ...run.style,
      }),
    );
  }
  return result;
}

function buildReplacementRuns(
  runs: readonly DocumentTextRun[],
  textLength: number,
  edits: readonly DocumentParagraphEdit[],
): DocumentTextRun[] {
  const result: DocumentTextRun[] = [];
  let runIndex = 0;
  let runStart = 0;
  let sourceOffset = 0;
  let lastStyle: DocumentTextStyle | undefined;
  const append = (text: string, style: DocumentTextStyle): void => {
    if (text.length === 0) return;
    const previous = result.at(-1);
    if (previous && sameTextStyle(previous.style, style)) {
      result[result.length - 1] = new DocumentTextRun(previous.text + text, previous.style);
    } else result.push(new DocumentTextRun(text, { ...style }));
  };
  const consumeUntil = (target: number, emit: boolean): void => {
    while (sourceOffset < target) {
      const run = runs[runIndex];
      if (!run) throw new Error("Paragraph replacement encountered a discontinuous run map");
      const runEnd = runStart + run.text.length;
      if (runEnd <= sourceOffset) {
        runStart = runEnd;
        runIndex += 1;
        continue;
      }
      const end = Math.min(target, runEnd);
      if (emit) append(run.text.slice(sourceOffset - runStart, end - runStart), run.style);
      if (end > sourceOffset) lastStyle = run.style;
      sourceOffset = end;
      if (sourceOffset === runEnd) {
        runStart = runEnd;
        runIndex += 1;
      }
    }
  };
  for (const edit of edits) {
    consumeUntil(edit.start, true);
    const insertionStyle = lastStyle ?? runs[runIndex]?.style ?? runs.at(-1)?.style ?? {};
    consumeUntil(edit.end, false);
    append(edit.text, insertionStyle);
  }
  consumeUntil(textLength, true);
  if (result.length === 0) result.push(new DocumentTextRun(""));
  return result;
}
function textStyleAt(
  runs: readonly DocumentTextRun[],
  offset: number,
  textLength: number,
): DocumentTextStyle {
  let cursor = 0;
  for (const run of runs) {
    const end = cursor + run.text.length;
    if (offset < end || (offset === end && offset < textLength)) return { ...run.style };
    cursor = end;
  }
  return { ...(runs.at(-1)?.style ?? {}) };
}
function createNamespace(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function restoreStory(
  document: Document,
  kind: "header" | "footer",
  value?: SerializedStory,
  pageForTables?: DocumentPageGeometry,
  access?: DocumentInternalAccess,
): DocumentStory {
  assertDocumentInternalAccess(access as DocumentInternalAccess);
  const story = new DocumentStory(
    document,
    kind,
    value?.id,
    pageForTables,
    DOCUMENT_INTERNAL_ACCESS,
  );
  for (const block of value?.blocks ?? []) {
    story.restore(block, DOCUMENT_INTERNAL_ACCESS);
  }
  return story;
}
function storyCounts(stories: DocumentSectionStories): Record<string, number> {
  return {
    default: stories.default.items.length,
    first: stories.first.items.length,
    even: stories.even.items.length,
  };
}
function boundedInspect(records: Record<string, unknown>[], maxChars: number): InspectResult {
  const accepted: Record<string, unknown>[] = [];
  const lines: string[] = [];
  let chars = 0;
  let truncated = false;
  for (const record of records) {
    const line = JSON.stringify(record);
    if (chars + line.length + (lines.length ? 1 : 0) > maxChars) {
      truncated = true;
      break;
    }
    accepted.push(record);
    lines.push(line);
    chars += line.length + (lines.length > 1 ? 1 : 0);
  }
  return { records: accepted, ndjson: lines.join("\n"), truncated };
}
function inspectCharacterLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) {
    throw new Error("Document inspection maxChars must be an integer between 1 and 1000000");
  }
  return limit;
}
