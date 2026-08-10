/**
 * A dependency-free, browser-safe DOCX reader.
 *
 * This module deliberately returns a neutral DTO. The editable document model
 * can consume that DTO without making the ZIP/XML reader depend on it (or on a
 * Node-only OOXML library). Unsupported fidelity-bearing content fails closed.
 */

import {
  inflateBoundedZipEntry,
  parseBoundedZip,
  type BoundedZipEntry,
  type BoundedZipFailure,
} from "./bounded-zip";
import type {
  DocumentOpaqueContent,
  DocumentOpaqueContentType,
  DocumentOpaqueRelationship,
} from "./document-docx-api";

export type DocxImportLimits = {
  maxCompressedBytes: number;
  maxEntries: number;
  maxEntryCompressedBytes: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
  maxCompressionRatio: number;
  maxXmlBytes: number;
  maxTotalXmlBytes: number;
  maxRetainedXmlCharacters: number;
  maxXmlNodes: number;
  maxXmlDepth: number;
  maxXmlAttributesPerElement: number;
  maxRelationshipsPerPart: number;
  maxTotalRelationships: number;
  maxBlocks: number;
  maxTextCharacters: number;
  maxSections: number;
  maxProjectedStoryBlocks: number;
  maxProjectedStoryCharacters: number;
  maxStyles: number;
  maxStyleInheritanceDepth: number;
  maxNumberingDefinitions: number;
  maxComments: number;
  maxProjectedCommentWork: number;
};

export type DocxImportErrorCode =
  | "invalid_input"
  | "invalid_zip"
  | "limit_exceeded"
  | "invalid_xml"
  | "invalid_package"
  | "unsupported_feature"
  | "unsupported_platform";

export class DocxImportError extends Error {
  readonly name = "DocxImportError";
  constructor(
    readonly code: DocxImportErrorCode,
    message: string,
    readonly partName?: string,
  ) {
    super(partName ? `${message} (${partName})` : message);
  }
}

export type ImportedDocument = {
  format: "docx";
  schemaVersion: 1;
  evenAndOddHeaders: boolean;
  trackRevisions: boolean;
  blocks: ImportedBlock[];
  sections: ImportedSection[];
  styles: ImportedStyle[];
  lists: ImportedListDefinition[];
  headers: ImportedHeaderFooter[];
  footers: ImportedHeaderFooter[];
  comments: ImportedComment[];
  trackedChanges: ImportedTrackedChange[];
  opaqueContent: DocumentOpaqueContent;
};

export type ImportedBlock = ImportedParagraph | ImportedTable | ImportedPageBreak;

export type ImportedParagraph = {
  kind: "paragraph";
  id: string;
  styleId?: string;
  style: ImportedParagraphStyle;
  inlines: ImportedInline[];
  commentAnchors: ImportedCommentAnchor[];
};

export type ImportedInline = ImportedRun | ImportedPageBreak;

export type ImportedRun = {
  kind: "run";
  text: string;
  styleId?: string;
  style: ImportedRunStyle;
  changeId?: string;
};

export type ImportedPageBreak = { kind: "pageBreak" };

export type ImportedTable = {
  kind: "table";
  id: string;
  styleId?: string;
  width?: ImportedMeasure;
  indent?: ImportedMeasure;
  alignment?: string;
  layout?: "fixed" | "autofit";
  cellMargins?: ImportedBoxMeasures;
  borders?: ImportedTableBorders;
  gridColumnWidthsPt: number[];
  rows: ImportedTableRow[];
};

export type ImportedTableRow = {
  header: boolean;
  cannotSplit: boolean;
  heightPt?: number;
  heightRule?: "auto" | "atLeast" | "exact";
  cells: ImportedTableCell[];
};

export type ImportedTableCell = {
  width?: ImportedMeasure;
  margins?: ImportedBoxMeasures;
  columnSpan: number;
  verticalMerge?: "restart" | "continue";
  verticalAlignment?: string;
  fill?: string;
  blocks: ImportedBlock[];
};

export type ImportedMeasure = { value: number; unit: "pt" | "percent" | "auto" };

export type ImportedBoxMeasures = {
  top?: ImportedMeasure;
  right?: ImportedMeasure;
  bottom?: ImportedMeasure;
  left?: ImportedMeasure;
  start?: ImportedMeasure;
  end?: ImportedMeasure;
};

export type ImportedBorder = {
  style: string;
  color?: string;
  sizePt?: number;
  spacePt?: number;
  shadow?: boolean;
  frame?: boolean;
};

export type ImportedTableBorders = {
  top?: ImportedBorder;
  right?: ImportedBorder;
  bottom?: ImportedBorder;
  left?: ImportedBorder;
  insideHorizontal?: ImportedBorder;
  insideVertical?: ImportedBorder;
};

export type ImportedParagraphStyle = {
  alignment?: string;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  line?: number;
  lineRule?: string;
  indentLeftPt?: number;
  indentRightPt?: number;
  firstLinePt?: number;
  hangingPt?: number;
  keepNext?: boolean;
  keepLines?: boolean;
  pageBreakBefore?: boolean;
  outlineLevel?: number;
  bidirectional?: boolean;
  list?: { numId: string; level: number };
};

export type ImportedRunStyle = {
  fontFamily?: string;
  fontSizePt?: number;
  fontSizeComplexScriptPt?: number;
  color?: string;
  bold?: boolean;
  boldComplexScript?: boolean;
  italic?: boolean;
  italicComplexScript?: boolean;
  underline?: string;
  strike?: boolean;
  highlight?: string;
  verticalAlign?: string;
  language?: string;
};

export type ImportedStyle = {
  styleId: string;
  kind: string;
  name?: string;
  basedOn?: string;
  next?: string;
  isDefault: boolean;
  paragraph: ImportedParagraphStyle;
  run: ImportedRunStyle;
};

export type ImportedListLevel = {
  level: number;
  start: number;
  restart?: number;
  legal?: boolean;
  alignment?: string;
  format?: string;
  text?: string;
  suffix?: string;
  paragraphStyleId?: string;
  paragraph: ImportedParagraphStyle;
  run: ImportedRunStyle;
};

export type ImportedListDefinition = {
  numId: string;
  abstractNumId: string;
  levels: ImportedListLevel[];
  overrides: Array<{ level: number; start?: number; definition?: ImportedListLevel }>;
};

export type ImportedSection = {
  startBlockIndex: number;
  endBlockIndex: number;
  type?: string;
  titlePage: boolean;
  page: {
    widthPt: number;
    heightPt: number;
    orientation?: string;
    marginTopPt: number;
    marginRightPt: number;
    marginBottomPt: number;
    marginLeftPt: number;
    headerPt: number;
    footerPt: number;
    gutterPt: number;
  };
  headers: ImportedSectionReference[];
  footers: ImportedSectionReference[];
};

export type ImportedSectionReference = {
  kind: string;
  relationshipId: string;
  partName: string;
};

export type ImportedHeaderFooter = {
  kind: "header" | "footer";
  partName: string;
  blocks: ImportedBlock[];
};

export type ImportedCommentAnchor = {
  commentId: string;
  kind: "start" | "end" | "reference";
  textOffset: number;
};

export type ImportedComment = {
  id: string;
  parentId?: string;
  resolved?: boolean;
  author?: string;
  initials?: string;
  createdAt?: string;
  blocks: ImportedBlock[];
};

export type ImportedTrackedChange = {
  id: string;
  kind: "insert" | "delete";
  author?: string;
  createdAt?: string;
  blockId: string;
  startInlineIndex: number;
  endInlineIndex: number;
  startTextOffset: number;
  endTextOffset: number;
};

const DEFAULT_LIMITS: DocxImportLimits = {
  maxCompressedBytes: 32 * 1024 * 1024,
  maxEntries: 1_024,
  maxEntryCompressedBytes: 16 * 1024 * 1024,
  maxEntryUncompressedBytes: 24 * 1024 * 1024,
  maxTotalUncompressedBytes: 64 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxXmlBytes: 16 * 1024 * 1024,
  maxTotalXmlBytes: 32 * 1024 * 1024,
  maxRetainedXmlCharacters: 16_000_000,
  maxXmlNodes: 100_000,
  maxXmlDepth: 128,
  maxXmlAttributesPerElement: 256,
  maxRelationshipsPerPart: 10_000,
  maxTotalRelationships: 100_000,
  maxBlocks: 100_000,
  maxTextCharacters: 10_000_000,
  maxSections: 4_096,
  maxProjectedStoryBlocks: 200_000,
  maxProjectedStoryCharacters: 20_000_000,
  maxStyles: 10_000,
  maxStyleInheritanceDepth: 64,
  maxNumberingDefinitions: 20_000,
  maxComments: 10_000,
  maxProjectedCommentWork: 1_000_000,
};

const WORD_RELATIONSHIP_BASE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const PACKAGE_RELATIONSHIP_BASE =
  "http://schemas.openxmlformats.org/package/2006/relationships/metadata/";
const WORDPROCESSINGML_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";
const RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";
const COMMENTS_EXTENDED_NAMESPACE = "http://schemas.microsoft.com/office/word/2012/wordml";

type ZipEntry = BoundedZipEntry;

type XmlNode = XmlElement | XmlText;
type XmlElement = {
  type: "element";
  name: string;
  localName: string;
  attributes: ReadonlyMap<string, string>;
  children: XmlNode[];
};
type XmlText = { type: "text"; value: string };

type Relationship = {
  id: string;
  type: string;
  target: string;
  sourcePart: string;
  partName: string;
};

type ImportBudget = {
  limits: DocxImportLimits;
  xmlBytes: number;
  xmlRetainedCharacters: number;
  xmlNodes: number;
  blocks: number;
  textCharacters: number;
  nextBlockId: number;
};

type ParseContext = {
  budget: ImportBudget;
  trackedChanges: ImportedTrackedChange[];
  idPrefix: string;
};

/**
 * Imports the fidelity-bearing, editable WordprocessingML subset into a neutral
 * DTO. The function has no Node imports and is suitable for a browser worker.
 */
export async function importDocx(
  input: Blob | ArrayBuffer,
  options: Partial<DocxImportLimits> = {},
): Promise<ImportedDocument> {
  const limits = resolveLimits(options);
  const bytes = await readInput(input, limits.maxCompressedBytes);
  const entries = parseZipDirectory(bytes, limits);
  const opaqueParts = validatePartNames(entries);
  const entriesByName = new Map(
    entries.filter((entry) => !entry.directory).map((entry) => [entry.name, entry]),
  );
  const partNames = new Set(entriesByName.keys());
  validatePackageParts(partNames);

  const budget: ImportBudget = {
    limits,
    xmlBytes: 0,
    xmlRetainedCharacters: 0,
    xmlNodes: 0,
    blocks: 0,
    textCharacters: 0,
    nextBlockId: 1,
  };
  const parsedParts = new Set<string>();
  const readXml = async (partName: string): Promise<XmlElement> => {
    const entry = entriesByName.get(partName);
    if (!entry)
      throw new DocxImportError("invalid_package", "Required DOCX part is missing", partName);
    if (parsedParts.has(partName)) {
      throw new DocxImportError(
        "invalid_package",
        "DOCX part was consumed more than once",
        partName,
      );
    }
    parsedParts.add(partName);
    // Inflate and parse one part at a time. The expanded byte buffer and XML
    // source string become collectible as soon as this consumer returns; no
    // archive-wide expanded-parts or parsed-tree cache is retained.
    const value = await inflateBoundedZipEntry(
      bytes,
      entry,
      limits.maxEntryUncompressedBytes,
      docxZipFailure,
    );
    return parseXmlPart(value, partName, budget);
  };

  // Validate ignored metadata/theme/config one part at a time, without retaining
  // either its expanded bytes or parsed tree. Ignored semantics cannot become a
  // budget or entity-expansion bypass.
  for (const partName of partNames) {
    if (isSyntaxOnlyXmlPart(partName) || (opaqueParts.has(partName) && partName.endsWith(".xml")))
      await readXml(partName);
  }

  const contentTypes = await readXml("[Content_Types].xml");
  const contentTypeByPart = validateContentTypes(contentTypes, partNames);
  const opaqueContentTypes: DocumentOpaqueContentType[] = [];
  for (const partName of opaqueParts) {
    const contentType = contentTypeByPart.get(partName);
    if (!contentType || !isSafeOpaqueContentType(partName, contentType)) {
      throw new DocxImportError(
        "unsupported_feature",
        `Opaque DOCX part has an unsupported content type: ${contentType ?? "missing"}`,
        partName,
      );
    }
    opaqueContentTypes.push({ partName, contentType });
  }
  if (partNames.has("word/footnotes.xml"))
    validateEmptyNotePart(await readXml("word/footnotes.xml"), "footnote", "word/footnotes.xml");
  if (partNames.has("word/endnotes.xml"))
    validateEmptyNotePart(await readXml("word/endnotes.xml"), "endnote", "word/endnotes.xml");
  const settings = partNames.has("word/settings.xml")
    ? validateSettings(await readXml("word/settings.xml"))
    : { evenAndOddHeaders: false, trackRevisions: false };
  let totalRelationships = 0;
  const readRelationships = async (partName: string): Promise<Relationship[]> => {
    const parsed = parseRelationships(
      await readXml(partName),
      partName,
      limits.maxRelationshipsPerPart,
    );
    if (totalRelationships + parsed.length > limits.maxTotalRelationships) {
      throw limitError("DOCX exceeds maxTotalRelationships", partName);
    }
    totalRelationships += parsed.length;
    return parsed;
  };
  const rootRelationships = await readRelationships("_rels/.rels");
  const officeDocuments = rootRelationships.filter(
    (relationship) => relationship.type === `${WORD_RELATIONSHIP_BASE}officeDocument`,
  );
  const officeDocument = officeDocuments[0];
  if (
    officeDocuments.length !== 1 ||
    !officeDocument ||
    officeDocument.partName !== "word/document.xml"
  ) {
    throw new DocxImportError(
      "invalid_package",
      "DOCX officeDocument must target word/document.xml",
      "_rels/.rels",
    );
  }

  const documentRelationships = partNames.has("word/_rels/document.xml.rels")
    ? await readRelationships("word/_rels/document.xml.rels")
    : [];
  const auxiliaryRelationships: Relationship[] = [];
  for (const partName of partNames) {
    if (
      !partName.endsWith(".rels") ||
      partName === "_rels/.rels" ||
      partName === "word/_rels/document.xml.rels"
    )
      continue;
    for (const relationship of await readRelationships(partName))
      auxiliaryRelationships.push(relationship);
  }
  const allRelationships = [
    ...rootRelationships,
    ...documentRelationships,
    ...auxiliaryRelationships,
  ];
  const opaqueRelationships = validateRelationships(allRelationships, opaqueParts);
  for (const relationship of allRelationships) {
    if (!partNames.has(relationship.partName)) {
      throw new DocxImportError(
        "invalid_package",
        "Relationship targets a missing package part",
        relationship.partName,
      );
    }
  }
  validateRelationshipCoverage(partNames, allRelationships);
  const relationshipById = new Map(
    documentRelationships.map((relationship) => [relationship.id, relationship]),
  );

  const styles = partNames.has("word/styles.xml")
    ? parseStyles(await readXml("word/styles.xml"), limits)
    : [];
  const lists = partNames.has("word/numbering.xml")
    ? parseNumbering(await readXml("word/numbering.xml"), limits)
    : [];
  const trackedChanges: ImportedTrackedChange[] = [];
  const mainContext: ParseContext = { budget, trackedChanges, idPrefix: "body" };
  const main = parseMainDocument(await readXml("word/document.xml"), mainContext, relationshipById);
  resolveSectionStoryInheritance(main.sections);

  const headers: ImportedHeaderFooter[] = [];
  const footers: ImportedHeaderFooter[] = [];
  const parsedStoryParts = new Set<string>();
  for (const relationship of documentRelationships) {
    const kind =
      relationship.type === `${WORD_RELATIONSHIP_BASE}header`
        ? "header"
        : relationship.type === `${WORD_RELATIONSHIP_BASE}footer`
          ? "footer"
          : undefined;
    if (!kind) continue;
    if (parsedStoryParts.has(relationship.partName)) continue;
    parsedStoryParts.add(relationship.partName);
    const root = await readXml(relationship.partName);
    requireLocalName(root, kind === "header" ? "hdr" : "ftr", relationship.partName);
    requireWordNamespace(root, relationship.partName);
    const context: ParseContext = {
      budget,
      trackedChanges,
      idPrefix: `${kind}:${relationship.partName}`,
    };
    const blocks = parseBlockContainer(root, context);
    (kind === "header" ? headers : footers).push({ kind, partName: relationship.partName, blocks });
  }
  validateProjectedStories(
    main.sections,
    headers,
    footers,
    limits.maxProjectedStoryBlocks,
    limits.maxProjectedStoryCharacters,
  );

  const commentsExtended = partNames.has("word/commentsExtended.xml")
    ? parseCommentsExtended(await readXml("word/commentsExtended.xml"), limits.maxComments)
    : new Map<string, ExtendedComment>();
  const comments = partNames.has("word/comments.xml")
    ? parseComments(
        await readXml("word/comments.xml"),
        { budget, trackedChanges, idPrefix: "comment" },
        commentsExtended,
        limits.maxComments,
      )
    : [];
  if (commentsExtended.size > 0 && comments.length === 0) {
    throw new DocxImportError(
      "invalid_package",
      "commentsExtended.xml exists without comments.xml",
      "word/commentsExtended.xml",
    );
  }
  validateCommentReferences(main.blocks, headers, footers, comments);
  const rootCommentCount = comments.reduce(
    (count, comment) => count + Number(comment.parentId === undefined),
    0,
  );
  if (
    rootCommentCount > 0 &&
    rootCommentCount * (budget.blocks + comments.length) > limits.maxProjectedCommentWork
  ) {
    throw limitError("DOCX exceeds maxProjectedCommentWork", "word/comments.xml");
  }

  return {
    format: "docx",
    schemaVersion: 1,
    evenAndOddHeaders: settings.evenAndOddHeaders,
    trackRevisions: settings.trackRevisions,
    blocks: main.blocks,
    sections: main.sections,
    styles,
    lists,
    headers,
    footers,
    comments,
    trackedChanges,
    opaqueContent: {
      parts: [...opaqueParts].sort(compareStrings),
      relationships: opaqueRelationships
        .map(({ sourcePart, type, partName }) => ({ sourcePart, type, targetPart: partName }))
        .sort(compareOpaqueRelationships),
      contentTypes: opaqueContentTypes.sort(compareOpaqueContentTypes),
    },
  };
}

function resolveLimits(options: Partial<DocxImportLimits>): DocxImportLimits {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.getPrototypeOf(options) !== Object.prototype ||
    Object.getOwnPropertySymbols(options).length > 0
  )
    throw new DocxImportError("invalid_input", "DOCX import limits must be a plain data object");
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(options))) {
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new DocxImportError(
        "invalid_input",
        "DOCX import limits must contain only enumerable data properties",
      );
    }
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_LIMITS, name)) {
      throw new DocxImportError("invalid_input", `Unknown DOCX import limit: ${name}`);
    }
  }
  const limits = { ...DEFAULT_LIMITS, ...options };
  for (const [name, value] of Object.entries(limits)) {
    if (
      !Number.isFinite(value) ||
      value <= 0 ||
      (name !== "maxCompressionRatio" && !Number.isInteger(value))
    ) {
      throw new DocxImportError("invalid_input", `Invalid DOCX import limit: ${name}`);
    }
  }
  // Limits are caller-tightenable, never caller-expandable. This keeps every
  // public invocation inside the browser-safe envelope audited here.
  for (const [name, cap] of Object.entries(DEFAULT_LIMITS) as Array<
    [keyof DocxImportLimits, number]
  >) {
    if (limits[name] > cap)
      throw new DocxImportError(
        "invalid_input",
        `${name} cannot exceed the hard safety cap of ${cap}`,
      );
  }
  return limits;
}

async function readInput(input: Blob | ArrayBuffer, maxBytes: number): Promise<Uint8Array> {
  if (input instanceof ArrayBuffer) {
    if (input.byteLength > maxBytes) throw limitError("Compressed DOCX exceeds maxCompressedBytes");
    return new Uint8Array(input);
  }
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    if (input.size > maxBytes) throw limitError("Compressed DOCX exceeds maxCompressedBytes");
    return new Uint8Array(await input.arrayBuffer());
  }
  throw new DocxImportError("invalid_input", "DOCX input must be a Blob or ArrayBuffer");
}

function parseZipDirectory(bytes: Uint8Array, limits: DocxImportLimits): ZipEntry[] {
  return parseBoundedZip(
    bytes,
    {
      entries: limits.maxEntries,
      compressedEntryBytes: limits.maxEntryCompressedBytes,
      expandedEntryBytes: limits.maxEntryUncompressedBytes,
      expandedBytes: limits.maxTotalUncompressedBytes,
      compressionRatio: limits.maxCompressionRatio,
    },
    docxZipFailure,
  );
}

function docxZipFailure(
  kind: Parameters<BoundedZipFailure>[0],
  message: string,
  partName?: string,
): never {
  const code: DocxImportErrorCode =
    kind === "limit"
      ? "limit_exceeded"
      : kind === "invalid"
        ? "invalid_zip"
        : kind === "platform"
          ? "unsupported_platform"
          : "unsupported_feature";
  throw new DocxImportError(code, message, partName);
}

function validatePartNames(parts: readonly ZipEntry[]): Set<string> {
  const opaqueParts = new Set<string>();
  for (const entry of parts) {
    if (entry.directory) continue;
    const name = entry.name;
    const supported =
      name === "[Content_Types].xml" ||
      name === "_rels/.rels" ||
      /^docProps\/(?:core|app|custom)\.xml$/.test(name) ||
      name === "word/document.xml" ||
      name === "word/styles.xml" ||
      name === "word/numbering.xml" ||
      name === "word/comments.xml" ||
      name === "word/commentsExtended.xml" ||
      name === "word/footnotes.xml" ||
      name === "word/endnotes.xml" ||
      name === "word/settings.xml" ||
      name === "word/webSettings.xml" ||
      name === "word/fontTable.xml" ||
      /^word\/theme\/theme\d+\.xml$/.test(name) ||
      /^word\/(?:header|footer)\d+\.xml$/.test(name) ||
      /^word\/_rels\/(?:document|header\d+|footer\d+|footnotes|endnotes|comments|fontTable)\.xml\.rels$/.test(
        name,
      );
    if (supported) {
      if (isSyntaxOnlyXmlPart(name)) opaqueParts.add(name);
      continue;
    }
    if (isSafeOpaquePartName(name)) {
      opaqueParts.add(name);
      continue;
    }
    const active =
      /(?:^|\/)(?:vbaProject|macros?|activeX|embeddings|oleObject|customUI|webExtensions?|signatures?|drm|encryptedPackage)(?:\/|\.|$)/i.test(
        name,
      );
    const media = /(?:^|\/)media(?:\/|$)|\.(?:png|jpe?g|gif|webp|svg|emf|wmf|tiff?|bmp|bin)$/i.test(
      name,
    );
    throw new DocxImportError(
      "unsupported_feature",
      active
        ? "Active, executable, embedded, encrypted, or signed DOCX content is unsupported"
        : media
          ? "DOCX media is not represented by the editable document model"
          : "DOCX part is neither represented nor in the inert opaque-part allowlist",
      name,
    );
  }
  return opaqueParts;
}

function isSafeOpaquePartName(partName: string): boolean {
  return (
    /^customXml\/item\d+\.xml$/.test(partName) ||
    /^customXml\/itemProps\d+\.xml$/.test(partName) ||
    /^customXml\/_rels\/item\d+\.xml\.rels$/.test(partName) ||
    partName === "word/glossary/document.xml" ||
    partName === "word/glossary/_rels/document.xml.rels"
  );
}

function validatePackageParts(parts: ReadonlySet<string>): void {
  for (const required of ["[Content_Types].xml", "_rels/.rels", "word/document.xml"]) {
    if (!parts.has(required))
      throw new DocxImportError("invalid_package", "Required DOCX part is missing", required);
  }
}

function isSyntaxOnlyXmlPart(partName: string): boolean {
  return (
    /^docProps\/(?:core|app|custom)\.xml$/.test(partName) ||
    partName === "word/webSettings.xml" ||
    partName === "word/fontTable.xml" ||
    /^word\/theme\/theme\d+\.xml$/.test(partName)
  );
}

function parseXmlPart(bytes: Uint8Array, partName: string, budget: ImportBudget): XmlElement {
  if (bytes.byteLength > budget.limits.maxXmlBytes)
    throw limitError("XML part exceeds maxXmlBytes", partName);
  budget.xmlBytes += bytes.byteLength;
  if (budget.xmlBytes > budget.limits.maxTotalXmlBytes)
    throw limitError("DOCX exceeds maxTotalXmlBytes", partName);
  const xml = decodeUtf8(bytes, "XML", partName);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new DocxImportError(
      "invalid_xml",
      "DOCTYPE and entity declarations are forbidden",
      partName,
    );
  }
  const parsed = parseXml(
    xml,
    partName,
    budget.limits.maxXmlDepth,
    budget.limits.maxXmlNodes - budget.xmlNodes,
    budget.limits.maxRetainedXmlCharacters - budget.xmlRetainedCharacters,
    budget.limits.maxXmlAttributesPerElement,
    partName.endsWith(".rels") ? budget.limits.maxRelationshipsPerPart : undefined,
  );
  validateNamespaceWellFormedness(parsed.root, partName);
  budget.xmlNodes += parsed.nodeCount;
  if (budget.xmlNodes > budget.limits.maxXmlNodes)
    throw limitError("DOCX exceeds maxXmlNodes", partName);
  budget.xmlRetainedCharacters += parsed.retainedCharacters;
  if (budget.xmlRetainedCharacters > budget.limits.maxRetainedXmlCharacters) {
    throw limitError("DOCX exceeds maxRetainedXmlCharacters", partName);
  }
  return parsed.root;
}

function parseXml(
  xml: string,
  partName: string,
  maxDepth: number,
  remainingNodes: number,
  remainingRetainedCharacters: number,
  maxAttributesPerElement: number,
  maxRootElementChildren: number | undefined,
): { root: XmlElement; nodeCount: number; retainedCharacters: number } {
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let cursor = 0;
  let nodeCount = 0;
  let retainedCharacters = 0;
  let sawXmlDeclaration = false;
  let rootElementChildren = 0;
  const addNode = (node: XmlNode): void => {
    nodeCount += 1;
    if (nodeCount > remainingNodes) throw limitError("DOCX exceeds maxXmlNodes", partName);
    retainedCharacters += retainedXmlCharacters(node);
    if (retainedCharacters > remainingRetainedCharacters) {
      throw limitError("DOCX exceeds maxRetainedXmlCharacters", partName);
    }
    const parent = stack.at(-1);
    if (parent) {
      if (parent === root && node.type === "element" && maxRootElementChildren !== undefined) {
        if (rootElementChildren >= maxRootElementChildren) {
          throw limitError("Relationships part exceeds maxRelationshipsPerPart", partName);
        }
        rootElementChildren += 1;
      }
      parent.children.push(node);
    } else if (node.type === "text" && isOnlyXmlWhitespace(node.value)) return;
    else if (node.type === "element" && !root) root = node;
    else
      throw new DocxImportError(
        "invalid_xml",
        "XML has multiple roots or text outside the root",
        partName,
      );
  };
  while (cursor < xml.length) {
    const opening = xml.indexOf("<", cursor);
    if (opening < 0) {
      const tail = xml.slice(cursor);
      if (tail.length > 0) addNode({ type: "text", value: decodeXmlEntities(tail, partName) });
      cursor = xml.length;
      break;
    }
    if (opening > cursor)
      addNode({ type: "text", value: decodeXmlEntities(xml.slice(cursor, opening), partName) });
    if (xml.startsWith("<!--", opening)) {
      const end = xml.indexOf("-->", opening + 4);
      const content = end < 0 ? "" : xml.slice(opening + 4, end);
      if (end < 0 || content.includes("--") || content.endsWith("-"))
        throw new DocxImportError("invalid_xml", "Malformed XML comment", partName);
      validateXmlCharacters(content, partName);
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", opening)) {
      const end = xml.indexOf("?>", opening + 2);
      if (end < 0)
        throw new DocxImportError("invalid_xml", "Malformed XML processing instruction", partName);
      const instruction = xml.slice(opening + 2, end);
      const validDeclaration =
        /^xml[\x20\t\r\n]+version=(?:"1\.[01]"|'1\.[01]')(?:[\x20\t\r\n]+encoding=(?:"[Uu][Tt][Ff]-8"|'[Uu][Tt][Ff]-8'))?(?:[\x20\t\r\n]+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?[\x20\t\r\n]*$/.test(
          instruction,
        );
      if (!validDeclaration || opening !== 0 || root || stack.length > 0 || sawXmlDeclaration) {
        throw new DocxImportError(
          "invalid_xml",
          "XML processing instructions are unsupported",
          partName,
        );
      }
      sawXmlDeclaration = true;
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith("<!", opening))
      throw new DocxImportError(
        "invalid_xml",
        "XML declarations and CDATA are unsupported",
        partName,
      );
    const end = findXmlTagEnd(xml, opening + 1, partName);
    const source = xml.slice(opening + 1, end);
    if (source.startsWith("/")) {
      const closing = /^\/([^\x20\t\r\n]+)[\x20\t\r\n]*$/.exec(source);
      const name = closing?.[1];
      if (!name || !XML_QNAME.test(name))
        throw new DocxImportError("invalid_xml", "Malformed XML closing tag", partName);
      const current = stack.pop();
      if (!current || current.name !== name)
        throw new DocxImportError("invalid_xml", "Mismatched XML closing tag", partName);
    } else {
      if (isXmlSpace(source[0]))
        throw new DocxImportError("invalid_xml", "XML start tag has leading whitespace", partName);
      const selfClosing = /\/[\x20\t\r\n]*$/.test(source);
      const element = parseXmlStartTag(
        selfClosing ? source.replace(/\/[\x20\t\r\n]*$/, "") : source,
        partName,
        maxAttributesPerElement,
      );
      addNode(element);
      if (!selfClosing) {
        stack.push(element);
        if (stack.length > maxDepth) throw limitError("XML exceeds maxXmlDepth", partName);
      }
    }
    cursor = end + 1;
  }
  if (stack.length > 0)
    throw new DocxImportError("invalid_xml", "XML document ended with unclosed elements", partName);
  if (!root) throw new DocxImportError("invalid_xml", "XML root element is missing", partName);
  return { root, nodeCount, retainedCharacters };
}

function retainedXmlCharacters(node: XmlNode): number {
  if (node.type === "text") return node.value.length;
  let characters = node.name.length + node.localName.length;
  for (const [name, value] of node.attributes) characters += name.length + value.length;
  return characters;
}

function findXmlTagEnd(xml: string, start: number, partName: string): number {
  let quote: string | undefined;
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index;
  }
  throw new DocxImportError("invalid_xml", "Unterminated XML tag", partName);
}

function parseXmlStartTag(source: string, partName: string, maxAttributes: number): XmlElement {
  let cursor = 0;
  const skipSpace = (): void => {
    while (cursor < source.length && isXmlSpace(source[cursor])) cursor += 1;
  };
  skipSpace();
  const nameStart = cursor;
  while (cursor < source.length && !isXmlSpace(source[cursor])) cursor += 1;
  const name = source.slice(nameStart, cursor);
  if (!XML_QNAME.test(name))
    throw new DocxImportError("invalid_xml", "Invalid XML element name", partName);
  const attributes = new Map<string, string>();
  const localAttributeNames = new Set<string>();
  while (cursor < source.length) {
    if (!isXmlSpace(source[cursor]))
      throw new DocxImportError(
        "invalid_xml",
        "XML attributes must be separated by whitespace",
        partName,
      );
    skipSpace();
    if (cursor >= source.length) break;
    const attributeStart = cursor;
    while (cursor < source.length && !isXmlSpace(source[cursor]) && source[cursor] !== "=")
      cursor += 1;
    const attributeName = source.slice(attributeStart, cursor);
    if (!XML_QNAME.test(attributeName))
      throw new DocxImportError("invalid_xml", "Invalid XML attribute name", partName);
    skipSpace();
    if (source[cursor] !== "=")
      throw new DocxImportError("invalid_xml", "XML attribute lacks a value", partName);
    cursor += 1;
    skipSpace();
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'")
      throw new DocxImportError("invalid_xml", "XML attribute value must be quoted", partName);
    cursor += 1;
    const valueStart = cursor;
    const valueEnd = source.indexOf(quote, valueStart);
    if (valueEnd < 0)
      throw new DocxImportError("invalid_xml", "Unterminated XML attribute value", partName);
    if (attributes.has(attributeName))
      throw new DocxImportError("invalid_xml", "Duplicate XML attribute", partName);
    if (attributes.size >= maxAttributes)
      throw limitError("XML element exceeds maxXmlAttributesPerElement", partName);
    const attributeLocalName = localName(attributeName);
    const namespaceDeclaration = attributeName === "xmlns" || attributeName.startsWith("xmlns:");
    if (!namespaceDeclaration && localAttributeNames.has(attributeLocalName)) {
      throw new DocxImportError(
        "invalid_xml",
        "Ambiguous namespace-local XML attributes",
        partName,
      );
    }
    localAttributeNames.add(attributeLocalName);
    const rawValue = source.slice(valueStart, valueEnd);
    if (rawValue.includes("<"))
      throw new DocxImportError(
        "invalid_xml",
        "XML attribute contains an unescaped less-than sign",
        partName,
      );
    attributes.set(attributeName, decodeXmlEntities(rawValue, partName));
    cursor = valueEnd + 1;
  }
  return { type: "element", name, localName: localName(name), attributes, children: [] };
}

// Deliberately ASCII: OOXML uses ASCII QNames, and accepting the full XML
// Unicode Name production would add a large parser surface for no fidelity.
// A QName has at most one colon and non-empty NCName components.
const XML_QNAME = /^(?:[A-Za-z_][A-Za-z0-9_.-]*:)?[A-Za-z_][A-Za-z0-9_.-]*$/;

function isXmlSpace(value: string | undefined): boolean {
  return value === " " || value === "\t" || value === "\r" || value === "\n";
}

function isOnlyXmlWhitespace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) if (!isXmlSpace(value[index])) return false;
  return true;
}

function decodeXmlEntities(value: string, partName: string): string {
  validateXmlCharacters(value, partName);
  if (value.includes("]]>"))
    throw new DocxImportError("invalid_xml", "XML contains malformed character data", partName);
  let ampersand = value.indexOf("&");
  if (ampersand < 0) return value;
  const output: string[] = [];
  let cursor = 0;
  let referenceCount = 0;
  while (ampersand >= 0) {
    referenceCount += 1;
    if (referenceCount > 65_536)
      throw limitError("XML text node exceeds the entity-reference safety cap", partName);
    output.push(value.slice(cursor, ampersand));
    const semicolon = value.indexOf(";", ampersand + 1);
    const nestedAmpersand = value.indexOf("&", ampersand + 1);
    if (semicolon < 0 || (nestedAmpersand >= 0 && nestedAmpersand < semicolon)) {
      throw new DocxImportError(
        "invalid_xml",
        "XML contains an unterminated entity reference",
        partName,
      );
    }
    const entity = value.slice(ampersand + 1, semicolon);
    if (entity.length === 0 || entity.length > 16) {
      throw new DocxImportError(
        "invalid_xml",
        "XML contains a malformed entity reference",
        partName,
      );
    }
    output.push(decodeXmlEntity(entity, partName));
    cursor = semicolon + 1;
    ampersand = value.indexOf("&", cursor);
  }
  output.push(value.slice(cursor));
  return output.join("");
}

function decodeXmlEntity(entity: string, partName: string): string {
  if (entity === "amp") return "&";
  if (entity === "lt") return "<";
  if (entity === "gt") return ">";
  if (entity === "quot") return '"';
  if (entity === "apos") return "'";
  const decimal = /^#([0-9]+)$/.exec(entity);
  const hex = /^#x([0-9a-f]+)$/i.exec(entity);
  const codePoint = decimal ? Number(decimal[1]) : hex ? Number.parseInt(hex[1] ?? "", 16) : NaN;
  if (!Number.isInteger(codePoint) || !isValidXmlCodePoint(codePoint)) {
    throw new DocxImportError(
      "invalid_xml",
      `Unsupported or invalid XML entity: &${entity};`,
      partName,
    );
  }
  return String.fromCodePoint(codePoint);
}

function validateXmlCharacters(value: string, partName: string): void {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (!isValidXmlCodePoint(codePoint)) {
      throw new DocxImportError("invalid_xml", "XML contains a forbidden character", partName);
    }
  }
}

function isValidXmlCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

function validateContentTypes(root: XmlElement, parts: ReadonlySet<string>): Map<string, string> {
  requireLocalName(root, "Types", "[Content_Types].xml");
  requireDefaultNamespaceTree(root, CONTENT_TYPES_NAMESPACE, "[Content_Types].xml");
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const entry of elementChildren(root)) {
    if ((entry.name !== "Default" && entry.name !== "Override") || entry.localName !== entry.name) {
      throw new DocxImportError(
        "invalid_package",
        "Unknown content-type declaration",
        "[Content_Types].xml",
      );
    }
    assertExactAttributes(
      entry,
      entry.name === "Default"
        ? new Set(["Extension", "ContentType"])
        : new Set(["PartName", "ContentType"]),
      "[Content_Types].xml",
    );
    requireLeafElement(entry, "[Content_Types].xml");
    const contentType = exactAttribute(entry, "ContentType") ?? "";
    if (contentType.length === 0)
      throw new DocxImportError(
        "invalid_package",
        "Content-type declaration lacks ContentType",
        "[Content_Types].xml",
      );
    // A Default image MIME declaration is emitted even by some generators
    // that contain no image part. Actual binary/media parts are rejected by
    // validatePartNames; declarations alone carry no discarded content.
    if (
      /(?:macroEnabled|vbaProject|activeX|oleObject|encryptedPackage|digital-signature|customUI|webExtension)/i.test(
        contentType,
      )
    ) {
      throw new DocxImportError(
        "unsupported_feature",
        `Unsupported DOCX content type: ${contentType}`,
        "[Content_Types].xml",
      );
    }
    if (entry.localName === "Default") {
      const extension = requiredExactAttribute(
        entry,
        "Extension",
        "[Content_Types].xml",
      ).toLowerCase();
      if (!/^[a-z0-9]+$/.test(extension) || defaults.has(extension)) {
        throw new DocxImportError(
          "invalid_package",
          "Invalid or duplicate default content type",
          "[Content_Types].xml",
        );
      }
      defaults.set(extension, contentType);
    } else {
      const declared = requiredExactAttribute(entry, "PartName", "[Content_Types].xml");
      if (declared.length > 1_025)
        throw limitError("Override PartName exceeds its safety cap", "[Content_Types].xml");
      if (!declared.startsWith("/") || declared.includes("\\") || /%(?:2e|2f|5c)/i.test(declared)) {
        throw new DocxImportError(
          "invalid_package",
          "Unsafe override PartName",
          "[Content_Types].xml",
        );
      }
      const partName = declared.slice(1);
      let segmentCount = 1;
      for (let index = 0; index < partName.length; index += 1) {
        if (partName.charCodeAt(index) === 47 && ++segmentCount > 256) {
          throw limitError(
            "Override PartName exceeds its path-segment safety cap",
            "[Content_Types].xml",
          );
        }
      }
      const segments = partName.split("/");
      if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        throw new DocxImportError(
          "invalid_package",
          "Unsafe override PartName",
          "[Content_Types].xml",
        );
      }
      const key = partName.toLowerCase();
      if (overrides.has(key))
        throw new DocxImportError(
          "invalid_package",
          "Duplicate override content type",
          "[Content_Types].xml",
        );
      if (!parts.has(partName))
        throw new DocxImportError(
          "invalid_package",
          "Content-type override targets a missing part",
          partName,
        );
      overrides.set(key, contentType);
    }
  }
  const contentTypeByPart = new Map<string, string>();
  for (const partName of parts.keys()) {
    if (partName === "[Content_Types].xml") continue;
    const extensionIndex = partName.lastIndexOf(".");
    const extension = extensionIndex < 0 ? "" : partName.slice(extensionIndex + 1).toLowerCase();
    const contentType = overrides.get(partName.toLowerCase()) ?? defaults.get(extension);
    if (!contentType) {
      throw new DocxImportError(
        "invalid_package",
        "Package part has no declared content type",
        partName,
      );
    }
    contentTypeByPart.set(partName, contentType);
  }
  const documentType = overrides.get("word/document.xml");
  if (
    documentType !==
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
  ) {
    throw new DocxImportError(
      "invalid_package",
      "word/document.xml has the wrong content type",
      "[Content_Types].xml",
    );
  }
  return contentTypeByPart;
}

function isSafeOpaqueContentType(partName: string, contentType: string): boolean {
  if (
    /(?:macroEnabled|vbaProject|activeX|oleObject|encryptedPackage|digital-signature|customUI|webExtension)/i.test(
      contentType,
    )
  ) {
    return false;
  }
  if (partName.endsWith(".rels")) {
    return contentType === "application/vnd.openxmlformats-package.relationships+xml";
  }
  return (
    /^(?:application|text)\/xml$/i.test(contentType) ||
    /^(?:application|text)\/[A-Za-z0-9!#$&^_.+-]+\+xml$/i.test(contentType)
  );
}

function parseRelationships(
  root: XmlElement,
  relationshipsPart: string,
  maxRelationships: number,
): Relationship[] {
  requireLocalName(root, "Relationships", relationshipsPart);
  requireDefaultNamespaceTree(root, RELATIONSHIPS_NAMESPACE, relationshipsPart);
  const sourcePart = relationshipSourcePart(relationshipsPart);
  const relationships: Relationship[] = [];
  const ids = new Set<string>();
  for (const child of elementChildren(root)) {
    if (relationships.length >= maxRelationships)
      throw limitError("Relationships part exceeds maxRelationshipsPerPart", relationshipsPart);
    if (child.name !== "Relationship")
      throw new DocxImportError(
        "invalid_package",
        "Unknown relationship element",
        relationshipsPart,
      );
    requireLeafElement(child, relationshipsPart);
    assertExactAttributes(
      child,
      new Set(["Id", "Type", "Target", "TargetMode"]),
      relationshipsPart,
    );
    const id = requiredExactAttribute(child, "Id", relationshipsPart);
    const type = requiredExactAttribute(child, "Type", relationshipsPart);
    const target = requiredExactAttribute(child, "Target", relationshipsPart);
    if (id.length > 512 || type.length > 2_048 || target.length > 4_096) {
      throw limitError(
        "Relationship Id, Type, or Target exceeds its safety cap",
        relationshipsPart,
      );
    }
    if (ids.has(id))
      throw new DocxImportError("invalid_package", "Duplicate relationship id", relationshipsPart);
    ids.add(id);
    if ((exactAttribute(child, "TargetMode") ?? "Internal") !== "Internal") {
      throw new DocxImportError(
        "unsupported_feature",
        "External DOCX relationships are unsupported",
        relationshipsPart,
      );
    }
    relationships.push({
      id,
      type,
      target,
      sourcePart,
      partName: resolvePartTarget(sourcePart, target, relationshipsPart),
    });
  }
  return relationships;
}

function validateRelationships(
  relationships: readonly Relationship[],
  opaqueParts: ReadonlySet<string>,
): Relationship[] {
  const allowed = new Set([
    `${WORD_RELATIONSHIP_BASE}officeDocument`,
    `${WORD_RELATIONSHIP_BASE}styles`,
    `${WORD_RELATIONSHIP_BASE}settings`,
    `${WORD_RELATIONSHIP_BASE}webSettings`,
    `${WORD_RELATIONSHIP_BASE}theme`,
    `${WORD_RELATIONSHIP_BASE}fontTable`,
    `${WORD_RELATIONSHIP_BASE}numbering`,
    `${WORD_RELATIONSHIP_BASE}header`,
    `${WORD_RELATIONSHIP_BASE}footer`,
    `${WORD_RELATIONSHIP_BASE}comments`,
    "http://schemas.microsoft.com/office/2011/relationships/commentsExtended",
    `${WORD_RELATIONSHIP_BASE}footnotes`,
    `${WORD_RELATIONSHIP_BASE}endnotes`,
    `${PACKAGE_RELATIONSHIP_BASE}core-properties`,
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties",
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties",
  ]);
  const opaqueRelationships: Relationship[] = [];
  for (const relationship of relationships) {
    if (allowed.has(relationship.type)) {
      validateRelationshipRoute(relationship);
      if (opaqueParts.has(relationship.partName)) opaqueRelationships.push(relationship);
      continue;
    }
    if (!isSafeOpaqueRelationship(relationship) || !opaqueParts.has(relationship.partName)) {
      throw new DocxImportError(
        "unsupported_feature",
        `Unsupported DOCX relationship: ${relationship.type}`,
        relationship.partName,
      );
    }
    opaqueRelationships.push(relationship);
  }
  const singletonTypes = new Set(
    [
      "styles",
      "settings",
      "webSettings",
      "theme",
      "fontTable",
      "numbering",
      "comments",
      "footnotes",
      "endnotes",
    ]
      .map((suffix) => `${WORD_RELATIONSHIP_BASE}${suffix}`)
      .concat(["http://schemas.microsoft.com/office/2011/relationships/commentsExtended"]),
  );
  const seenSingletons = new Set<string>();
  for (const relationship of relationships) {
    if (relationship.sourcePart !== "word/document.xml" || !singletonTypes.has(relationship.type))
      continue;
    if (seenSingletons.has(relationship.type)) {
      throw new DocxImportError(
        "invalid_package",
        "Document contains duplicate singleton relationships",
        relationship.partName,
      );
    }
    seenSingletons.add(relationship.type);
  }
  return opaqueRelationships;
}

function isSafeOpaqueRelationship(relationship: Relationship): boolean {
  const { sourcePart, type, partName } = relationship;
  if (type === `${WORD_RELATIONSHIP_BASE}customXml`) {
    return sourcePart === "word/document.xml" && /^customXml\/item\d+\.xml$/.test(partName);
  }
  if (type === `${WORD_RELATIONSHIP_BASE}customXmlProps`) {
    return (
      /^customXml\/item\d+\.xml$/.test(sourcePart) &&
      /^customXml\/itemProps\d+\.xml$/.test(partName)
    );
  }
  if (type === `${WORD_RELATIONSHIP_BASE}glossaryDocument`) {
    return sourcePart === "word/document.xml" && partName === "word/glossary/document.xml";
  }
  return false;
}

function validateRelationshipRoute(relationship: Relationship): void {
  const { sourcePart, type, partName } = relationship;
  if (sourcePart === "") {
    const expected = new Map<string, string>([
      [`${WORD_RELATIONSHIP_BASE}officeDocument`, "word/document.xml"],
      [`${PACKAGE_RELATIONSHIP_BASE}core-properties`, "docProps/core.xml"],
      [
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties",
        "docProps/app.xml",
      ],
      [
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties",
        "docProps/custom.xml",
      ],
    ]).get(type);
    if (!expected || partName !== expected) {
      throw new DocxImportError(
        "invalid_package",
        "Package-root relationship has an invalid type or target",
        partName,
      );
    }
    return;
  }
  if (sourcePart !== "word/document.xml") {
    // For the currently supported fidelity subset, generator-created story,
    // comment, note, and font relationship parts are empty. Any auxiliary
    // relationship necessarily points at content the DTO cannot represent.
    throw new DocxImportError(
      "unsupported_feature",
      "Relationships from auxiliary Word parts are not yet supported",
      sourcePart,
    );
  }
  const fixedTargets = new Map<string, string>([
    [`${WORD_RELATIONSHIP_BASE}styles`, "word/styles.xml"],
    [`${WORD_RELATIONSHIP_BASE}settings`, "word/settings.xml"],
    [`${WORD_RELATIONSHIP_BASE}webSettings`, "word/webSettings.xml"],
    [`${WORD_RELATIONSHIP_BASE}fontTable`, "word/fontTable.xml"],
    [`${WORD_RELATIONSHIP_BASE}numbering`, "word/numbering.xml"],
    [`${WORD_RELATIONSHIP_BASE}comments`, "word/comments.xml"],
    [`${WORD_RELATIONSHIP_BASE}footnotes`, "word/footnotes.xml"],
    [`${WORD_RELATIONSHIP_BASE}endnotes`, "word/endnotes.xml"],
    [
      "http://schemas.microsoft.com/office/2011/relationships/commentsExtended",
      "word/commentsExtended.xml",
    ],
  ]);
  const fixed = fixedTargets.get(type);
  const valid =
    fixed !== undefined
      ? partName === fixed
      : type === `${WORD_RELATIONSHIP_BASE}theme`
        ? /^word\/theme\/theme\d+\.xml$/.test(partName)
        : type === `${WORD_RELATIONSHIP_BASE}header`
          ? /^word\/header\d+\.xml$/.test(partName)
          : type === `${WORD_RELATIONSHIP_BASE}footer` && /^word\/footer\d+\.xml$/.test(partName);
  if (!valid)
    throw new DocxImportError(
      "invalid_package",
      "Document relationship has an invalid type or target",
      partName,
    );
}

function validateRelationshipCoverage(
  parts: ReadonlySet<string>,
  relationships: readonly Relationship[],
): void {
  const targets = new Set(relationships.map((relationship) => relationship.partName));
  for (const partName of parts.keys()) {
    if (partName === "[Content_Types].xml" || partName.endsWith(".rels")) continue;
    if (!targets.has(partName))
      throw new DocxImportError(
        "invalid_package",
        "Package contains an orphaned content part",
        partName,
      );
  }
  for (const partName of parts.keys()) {
    if (!partName.endsWith(".rels") || partName === "_rels/.rels") continue;
    const sourcePart = relationshipSourcePart(partName);
    if (!parts.has(sourcePart))
      throw new DocxImportError(
        "invalid_package",
        "Relationships part has no source part",
        partName,
      );
  }
}

function validateEmptyNotePart(
  root: XmlElement,
  itemName: "footnote" | "endnote",
  partName: string,
): void {
  requireLocalName(root, `${itemName}s`, partName);
  requireWordNamespace(root, partName);
  for (const item of elementChildren(root)) {
    if (item.localName !== itemName)
      throw new DocxImportError("invalid_package", `Unknown ${itemName} element`, partName);
    const id = Number(requiredAttribute(item, "id", partName));
    const type = attribute(item, "type");
    // Word generators commonly include separator and continuation-separator
    // records (the latter is often id 0). Their explicit type makes them
    // pagination metadata; any ordinary note must not be silently dropped.
    if (!Number.isInteger(id) || (type !== "separator" && type !== "continuationSeparator")) {
      throw new DocxImportError(
        "unsupported_feature",
        `DOCX ${itemName}s are not yet supported`,
        partName,
      );
    }
  }
}

function validateSettings(root: XmlElement): {
  evenAndOddHeaders: boolean;
  trackRevisions: boolean;
} {
  requireLocalName(root, "settings", "word/settings.xml");
  requireWordNamespace(root, "word/settings.xml");
  assertAllowedContentChildren(
    root,
    new Set([
      "displayBackgroundShape",
      "evenAndOddHeaders",
      "trackRevisions",
      "compat",
      "documentProtection",
      "writeProtection",
    ]),
    "document settings",
  );
  for (const protectedFeature of ["documentProtection", "writeProtection"] as const) {
    if (firstChild(root, protectedFeature)) {
      throw new DocxImportError(
        "unsupported_feature",
        `DOCX ${protectedFeature} is not preserved by import`,
        "word/settings.xml",
      );
    }
  }
  const background = singletonChild(root, "displayBackgroundShape", "document settings");
  const evenAndOdd = singletonChild(root, "evenAndOddHeaders", "document settings");
  const trackRevisions = singletonChild(root, "trackRevisions", "document settings");
  const compat = singletonChild(root, "compat", "document settings");
  assertAllowedAttributes(background, new Set(["val"]), "display-background-shape setting");
  assertAllowedAttributes(evenAndOdd, new Set(["val"]), "even-and-odd-headers setting");
  assertAllowedAttributes(trackRevisions, new Set(["val"]), "track-revisions setting");
  assertAllowedAttributes(compat, new Set(), "compatibility settings");
  assertAllowedContentChildren(background, new Set(), "display-background-shape setting");
  assertAllowedContentChildren(evenAndOdd, new Set(), "even-and-odd-headers setting");
  assertAllowedContentChildren(trackRevisions, new Set(), "track-revisions setting");
  const tracksRevisions = booleanValue(trackRevisions, false);
  assertAllowedContentChildren(compat, new Set(["compatSetting"]), "compatibility settings");
  const seenCompat = new Set<string>();
  for (const setting of children(compat, "compatSetting")) {
    assertAllowedAttributes(setting, new Set(["name", "uri", "val"]), "compatibility setting");
    assertAllowedContentChildren(setting, new Set(), "compatibility setting");
    const name = attribute(setting, "name");
    const uri = attribute(setting, "uri");
    const value = attribute(setting, "val");
    const key = `${uri ?? ""}\u0000${name ?? ""}`;
    if (seenCompat.has(key))
      throw new DocxImportError(
        "invalid_package",
        "Duplicate compatibility setting",
        "word/settings.xml",
      );
    seenCompat.add(key);
    if (
      name !== "compatibilityMode" ||
      uri !== "http://schemas.microsoft.com/office/word" ||
      value !== "15"
    ) {
      throw new DocxImportError(
        "unsupported_feature",
        "Document compatibility setting is not represented",
        "word/settings.xml",
      );
    }
  }
  return { evenAndOddHeaders: booleanValue(evenAndOdd, false), trackRevisions: tracksRevisions };
}

function parseMainDocument(
  root: XmlElement,
  context: ParseContext,
  relationships: ReadonlyMap<string, Relationship>,
): { blocks: ImportedBlock[]; sections: ImportedSection[] } {
  requireLocalName(root, "document", "word/document.xml");
  rejectUnsupportedContent(root, "word/document.xml");
  requireWordNamespace(root, "word/document.xml");
  const body = onlyElement(root, "body", "word/document.xml");
  const blocks: ImportedBlock[] = [];
  const sections: ImportedSection[] = [];
  let sectionStart = 0;
  const addSection = (section: ImportedSection): void => {
    if (sections.length >= context.budget.limits.maxSections) {
      throw limitError("DOCX exceeds maxSections", "word/document.xml");
    }
    sections.push(section);
  };
  for (const child of elementChildren(body)) {
    if (child.localName === "p") {
      const sectionProperties = firstChild(firstChild(child, "pPr"), "sectPr");
      if (!sectionProperties || !isPureSectionBoundaryParagraph(child)) {
        blocks.push(parseParagraph(child, context));
      }
      if (sectionProperties) {
        addSection(parseSection(sectionProperties, sectionStart, blocks.length, relationships));
        sectionStart = blocks.length;
      }
    } else if (child.localName === "tbl") blocks.push(parseTable(child, context));
    else if (child.localName === "sectPr") {
      addSection(parseSection(child, sectionStart, blocks.length, relationships));
      sectionStart = blocks.length;
    } else if (!NON_CONTENT_MARKERS.has(child.localName)) {
      throw unsupportedElement(child, "word/document.xml");
    }
  }
  if (sections.length === 0 || sectionStart < blocks.length) {
    addSection(defaultSection(sectionStart, blocks.length));
  }
  return { blocks, sections };
}

function parseBlockContainer(root: XmlElement, context: ParseContext): ImportedBlock[] {
  rejectUnsupportedContent(root, context.idPrefix);
  const blocks: ImportedBlock[] = [];
  for (const child of elementChildren(root)) {
    if (child.localName === "p") blocks.push(parseParagraph(child, context));
    else if (child.localName === "tbl") blocks.push(parseTable(child, context));
    else if (!NON_CONTENT_MARKERS.has(child.localName))
      throw unsupportedElement(child, context.idPrefix);
  }
  return blocks;
}

function parseParagraph(element: XmlElement, context: ParseContext): ImportedParagraph {
  consumeBlock(context.budget);
  const id = `${context.idPrefix}:p${context.budget.nextBlockId++}`;
  const properties = singletonChild(element, "pPr", "paragraph");
  const styleId = valueOf(firstChild(properties, "pStyle"));
  const paragraph: ImportedParagraph = {
    kind: "paragraph",
    id,
    ...(styleId !== undefined ? { styleId } : {}),
    style: parseParagraphProperties(properties),
    inlines: [],
    commentAnchors: [],
  };
  const firstTrackedChange = context.trackedChanges.length;
  let textOffset = 0;
  const addRun = (run: ImportedRun | ImportedPageBreak): void => {
    paragraph.inlines.push(run);
    if (run.kind === "run") {
      textOffset += run.text.length;
      consumeText(context.budget, run.text.length);
    }
  };
  const parseChildren = (parent: XmlElement, change?: ChangeMetadata): void => {
    for (const child of elementChildren(parent)) {
      if (child.localName === "pPr") continue;
      if (child.localName === "r") {
        const paragraphOffset = textOffset;
        const parsed = parseRun(child, change, (commentId, runOffset) => {
          paragraph.commentAnchors.push({
            commentId,
            kind: "reference",
            textOffset: paragraphOffset + runOffset,
          });
        });
        for (const inline of parsed) addRun(inline);
      } else if (child.localName === "ins" || child.localName === "del") {
        if (change)
          throw new DocxImportError(
            "invalid_package",
            "Tracked changes cannot be nested",
            context.idPrefix,
          );
        const changeStart = paragraph.inlines.length;
        const changeTextStart = textOffset;
        const author = attribute(child, "author");
        const createdAt = attribute(child, "date");
        const metadata: ChangeMetadata = {
          id: requiredAttribute(child, "id", context.idPrefix),
          kind: child.localName === "ins" ? "insert" : "delete",
          ...(author !== undefined ? { author } : {}),
          ...(createdAt !== undefined ? { createdAt } : {}),
        };
        parseChildren(child, metadata);
        context.trackedChanges.push({
          id: metadata.id,
          kind: metadata.kind,
          ...(metadata.author !== undefined ? { author: metadata.author } : {}),
          ...(metadata.createdAt !== undefined ? { createdAt: metadata.createdAt } : {}),
          blockId: id,
          startInlineIndex: changeStart,
          endInlineIndex: paragraph.inlines.length,
          startTextOffset: changeTextStart,
          endTextOffset: textOffset,
        });
      } else if (child.localName === "commentRangeStart" || child.localName === "commentRangeEnd") {
        paragraph.commentAnchors.push({
          commentId: requiredAttribute(child, "id", context.idPrefix),
          kind: child.localName === "commentRangeStart" ? "start" : "end",
          textOffset,
        });
      } else if (child.localName === "commentReference") {
        paragraph.commentAnchors.push({
          commentId: requiredAttribute(child, "id", context.idPrefix),
          kind: "reference",
          textOffset,
        });
      } else if (!NON_CONTENT_MARKERS.has(child.localName))
        throw unsupportedElement(child, context.idPrefix);
    }
  };
  parseChildren(element);
  validateScalarBoundaries(paragraph, context.trackedChanges, firstTrackedChange, context.idPrefix);
  return stripUndefined(paragraph);
}

function isPureSectionBoundaryParagraph(element: XmlElement): boolean {
  const paragraphChildren = elementChildren(element);
  if (paragraphChildren.length !== 1 || paragraphChildren[0]?.localName !== "pPr") return false;
  const propertyChildren = elementChildren(paragraphChildren[0]);
  return propertyChildren.length === 1 && propertyChildren[0]?.localName === "sectPr";
}

function validateScalarBoundaries(
  paragraph: ImportedParagraph,
  trackedChanges: readonly ImportedTrackedChange[],
  firstTrackedChange: number,
  partName: string,
): void {
  const chunks: string[] = [];
  for (const inline of paragraph.inlines) if (inline.kind === "run") chunks.push(inline.text);
  const text = chunks.join("");
  const validate = (offset: number, label: string): void => {
    if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
      throw new DocxImportError("invalid_package", `${label} is outside its paragraph`, partName);
    }
    const before = offset > 0 ? text.charCodeAt(offset - 1) : 0;
    const after = offset < text.length ? text.charCodeAt(offset) : 0;
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
      throw new DocxImportError(
        "invalid_package",
        `${label} splits a Unicode scalar value`,
        partName,
      );
    }
  };
  for (const anchor of paragraph.commentAnchors) validate(anchor.textOffset, "Comment anchor");
  for (let index = firstTrackedChange; index < trackedChanges.length; index += 1) {
    const change = trackedChanges[index];
    if (!change || change.blockId !== paragraph.id) continue;
    validate(change.startTextOffset, "Tracked-change start");
    validate(change.endTextOffset, "Tracked-change end");
  }
}

type ChangeMetadata = {
  id: string;
  kind: "insert" | "delete";
  author?: string;
  createdAt?: string;
};

function parseRun(
  element: XmlElement,
  change?: ChangeMetadata,
  onCommentReference?: (commentId: string, textOffset: number) => void,
): ImportedInline[] {
  const properties = singletonChild(element, "rPr", "run");
  const styleId = valueOf(firstChild(properties, "rStyle"));
  const style = parseRunProperties(properties);
  const styled = styleId !== undefined || Object.keys(style).length > 0;
  const inlines: ImportedInline[] = [];
  let text = "";
  let emittedTextLength = 0;
  let hasCommentReference = false;
  const flush = (): void => {
    if (text.length === 0) return;
    inlines.push(
      stripUndefined({
        kind: "run" as const,
        text,
        styleId,
        style,
        changeId: change?.id,
      }),
    );
    emittedTextLength += text.length;
    text = "";
  };
  for (const child of elementChildren(element)) {
    if (child.localName === "rPr") continue;
    if (child.localName === "t" || child.localName === "delText") text += textContent(child);
    else if (child.localName === "tab") text += "\t";
    else if (child.localName === "cr") text += "\n";
    else if (child.localName === "noBreakHyphen") text += "\u2011";
    else if (child.localName === "softHyphen") text += "\u00ad";
    else if (child.localName === "br") {
      assertAllowedAttributes(child, new Set(["type"]), "run break");
      assertAllowedContentChildren(child, new Set(), "run break");
      const type = attribute(child, "type") ?? "textWrapping";
      if (type === "page") {
        flush();
        inlines.push({ kind: "pageBreak" });
      } else if (type === "textWrapping") text += "\n";
      else throw new DocxImportError("unsupported_feature", `Unsupported break type: ${type}`);
    } else if (child.localName === "commentReference") {
      hasCommentReference = true;
      const commentId = requiredAttribute(child, "id", "word/document.xml");
      onCommentReference?.(commentId, emittedTextLength + text.length);
    } else if (
      child.localName !== "lastRenderedPageBreak" &&
      !NON_CONTENT_MARKERS.has(child.localName)
    ) {
      throw unsupportedElement(child, "word/document.xml");
    }
  }
  flush();
  if (emittedTextLength === 0 && styled && (hasCommentReference || inlines.length > 0)) {
    throw new DocxImportError(
      "unsupported_feature",
      "Formatting on a non-text run cannot be represented without changing marker behavior",
      "word/document.xml",
    );
  }
  // Empty text runs are meaningful insertion-point style carriers in Word and
  // are represented exactly by DocumentTextRun. Keep one inline rather than
  // flattening the style or silently changing where subsequent typing lands.
  if (emittedTextLength === 0 && inlines.length === 0 && !hasCommentReference) {
    inlines.push(
      stripUndefined({
        kind: "run" as const,
        text: "",
        styleId,
        style,
        changeId: change?.id,
      }),
    );
  }
  return inlines;
}

function parseTable(element: XmlElement, context: ParseContext): ImportedTable {
  consumeBlock(context.budget);
  assertAllowedContentChildren(element, new Set(["tblPr", "tblGrid", "tr"]), "table");
  const id = `${context.idPrefix}:tbl${context.budget.nextBlockId++}`;
  const properties = singletonChild(element, "tblPr", "table");
  assertAllowedPropertyChildren(
    properties,
    new Set(["tblStyle", "tblW", "tblInd", "jc", "tblLayout", "tblCellMar", "tblBorders"]),
    "table properties",
  );
  assertUniqueChildNames(properties, "table properties");
  assertAllowedAttributes(firstChild(properties, "tblStyle"), new Set(["val"]), "table style");
  assertAllowedAttributes(firstChild(properties, "jc"), new Set(["val"]), "table alignment");
  const grid = singletonChild(element, "tblGrid", "table");
  assertAllowedContentChildren(grid, new Set(["gridCol"]), "table grid");
  assertAllowedAttributes(grid, new Set(), "table grid");
  for (const column of children(grid, "gridCol")) {
    assertAllowedAttributes(column, new Set(["w"]), "table grid column");
    assertAllowedContentChildren(column, new Set(), "table grid column");
  }
  const rows: ImportedTableRow[] = [];
  for (const rowElement of children(element, "tr")) {
    assertAllowedContentChildren(rowElement, new Set(["trPr", "tc"]), "table row");
    const rowProperties = singletonChild(rowElement, "trPr", "table row");
    assertAllowedPropertyChildren(
      rowProperties,
      new Set(["tblHeader", "cantSplit", "trHeight"]),
      "table row properties",
    );
    assertUniqueChildNames(rowProperties, "table row properties");
    assertAllowedAttributes(rowProperties, new Set(), "table row properties");
    assertAllowedAttributes(
      firstChild(rowProperties, "tblHeader"),
      new Set(["val"]),
      "table header-row setting",
    );
    assertAllowedAttributes(
      firstChild(rowProperties, "cantSplit"),
      new Set(["val"]),
      "table row-splitting setting",
    );
    assertAllowedAttributes(
      firstChild(rowProperties, "trHeight"),
      new Set(["val", "hRule"]),
      "table row height",
    );
    const cells: ImportedTableCell[] = [];
    for (const cellElement of children(rowElement, "tc")) {
      assertAllowedContentChildren(cellElement, new Set(["tcPr", "p", "tbl"]), "table cell");
      const cellProperties = singletonChild(cellElement, "tcPr", "table cell");
      assertAllowedPropertyChildren(
        cellProperties,
        new Set(["tcW", "tcMar", "gridSpan", "vMerge", "vAlign", "shd"]),
        "table cell properties",
      );
      assertUniqueChildNames(cellProperties, "table cell properties");
      assertAllowedAttributes(cellProperties, new Set(), "table cell properties");
      for (const name of ["gridSpan", "vMerge", "vAlign"] as const) {
        assertAllowedAttributes(
          firstChild(cellProperties, name),
          new Set(["val"]),
          `table cell ${name}`,
        );
      }
      const verticalMergeElement = firstChild(cellProperties, "vMerge");
      const verticalMergeValue = verticalMergeElement
        ? (valueOf(verticalMergeElement) ?? "continue")
        : undefined;
      if (
        verticalMergeValue !== undefined &&
        verticalMergeValue !== "restart" &&
        verticalMergeValue !== "continue"
      ) {
        throw new DocxImportError(
          "invalid_package",
          `Invalid vertical merge value: ${verticalMergeValue}`,
          context.idPrefix,
        );
      }
      const columnSpan = integerValue(firstChild(cellProperties, "gridSpan"), 1);
      if (columnSpan < 1)
        throw new DocxImportError(
          "invalid_package",
          "Table gridSpan must be positive",
          context.idPrefix,
        );
      const blocks: ImportedBlock[] = [];
      for (const block of elementChildren(cellElement)) {
        if (block.localName === "tcPr") continue;
        if (block.localName === "p") blocks.push(parseParagraph(block, context));
        else if (block.localName === "tbl") blocks.push(parseTable(block, context));
        else if (!NON_CONTENT_MARKERS.has(block.localName))
          throw unsupportedElement(block, context.idPrefix);
      }
      const shading = firstChild(cellProperties, "shd");
      validateShading(shading, context.idPrefix);
      cells.push(
        stripUndefined({
          width: parseMeasure(firstChild(cellProperties, "tcW")),
          margins: parseBoxMeasures(firstChild(cellProperties, "tcMar"), "table cell margins"),
          columnSpan,
          verticalMerge:
            verticalMergeValue === undefined
              ? undefined
              : verticalMergeValue === "restart"
                ? ("restart" as const)
                : ("continue" as const),
          verticalAlignment: valueOf(firstChild(cellProperties, "vAlign")),
          fill: attribute(shading, "fill"),
          blocks,
        }),
      );
    }
    const height = firstChild(rowProperties, "trHeight");
    const heightRule = attribute(height, "hRule");
    if (
      heightRule !== undefined &&
      heightRule !== "auto" &&
      heightRule !== "atLeast" &&
      heightRule !== "exact"
    ) {
      throw new DocxImportError(
        "invalid_package",
        `Invalid table row height rule: ${heightRule}`,
        context.idPrefix,
      );
    }
    rows.push(
      stripUndefined({
        header: booleanValue(firstChild(rowProperties, "tblHeader"), false),
        cannotSplit: booleanValue(firstChild(rowProperties, "cantSplit"), false),
        heightPt: numberAttribute(height, "val", twipsToPt),
        heightRule,
        cells,
      }),
    );
  }
  return stripUndefined({
    kind: "table" as const,
    id,
    styleId: valueOf(firstChild(properties, "tblStyle")),
    width: parseMeasure(firstChild(properties, "tblW")),
    indent: parseMeasure(firstChild(properties, "tblInd")),
    alignment: valueOf(firstChild(properties, "jc")),
    layout: parseTableLayout(firstChild(properties, "tblLayout")),
    cellMargins: parseBoxMeasures(firstChild(properties, "tblCellMar"), "table cell margins"),
    borders: parseTableBorders(firstChild(properties, "tblBorders"), context.idPrefix),
    gridColumnWidthsPt: children(grid, "gridCol").map(
      (column) => numberAttribute(column, "w", twipsToPt) ?? 0,
    ),
    rows,
  });
}

function parseBoxMeasures(
  element: XmlElement | undefined,
  label: string,
): ImportedBoxMeasures | undefined {
  if (!element) return undefined;
  assertAllowedAttributes(element, new Set(), label);
  const allowed = new Set(["top", "right", "bottom", "left", "start", "end"]);
  assertAllowedPropertyChildren(element, allowed, label);
  assertUniqueChildNames(element, label);
  if (
    (firstChild(element, "left") && firstChild(element, "start")) ||
    (firstChild(element, "right") && firstChild(element, "end"))
  ) {
    throw new DocxImportError(
      "unsupported_feature",
      `${label} mixes physical and logical side aliases`,
      label,
    );
  }
  const result = stripUndefined<ImportedBoxMeasures>({
    top: parseMeasure(firstChild(element, "top")),
    right: parseMeasure(firstChild(element, "right")),
    bottom: parseMeasure(firstChild(element, "bottom")),
    left: parseMeasure(firstChild(element, "left")),
    start: parseMeasure(firstChild(element, "start")),
    end: parseMeasure(firstChild(element, "end")),
  });
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseTableBorders(
  element: XmlElement | undefined,
  partName: string,
): ImportedTableBorders | undefined {
  if (!element) return undefined;
  assertAllowedAttributes(element, new Set(), "table borders");
  assertAllowedPropertyChildren(
    element,
    new Set(["top", "right", "bottom", "left", "insideH", "insideV"]),
    "table borders",
  );
  assertUniqueChildNames(element, "table borders");
  const parse = (name: string): ImportedBorder | undefined => {
    const border = firstChild(element, name);
    if (!border) return undefined;
    assertAllowedAttributes(
      border,
      new Set(["val", "color", "sz", "space", "shadow", "frame"]),
      "table border",
    );
    const style = valueOf(border);
    if (!style)
      throw new DocxImportError("invalid_package", "Table border lacks a style", partName);
    return stripUndefined({
      style,
      color: attribute(border, "color"),
      sizePt: numberAttribute(border, "sz", (value) => value / 8),
      spacePt: numberAttribute(border, "space"),
      shadow: optionalBooleanAttribute(border, "shadow"),
      frame: optionalBooleanAttribute(border, "frame"),
    });
  };
  const result = stripUndefined<ImportedTableBorders>({
    top: parse("top"),
    right: parse("right"),
    bottom: parse("bottom"),
    left: parse("left"),
    insideHorizontal: parse("insideH"),
    insideVertical: parse("insideV"),
  });
  return Object.keys(result).length > 0 ? result : undefined;
}

function validateShading(element: XmlElement | undefined, partName: string): void {
  if (!element) return;
  assertAllowedAttributes(element, new Set(["val", "color", "fill"]), "table cell shading");
  const pattern = valueOf(element);
  const foreground = attribute(element, "color");
  if (pattern !== undefined && pattern !== "clear" && pattern !== "solid") {
    throw new DocxImportError(
      "unsupported_feature",
      `Table shading pattern ${pattern} is not represented`,
      partName,
    );
  }
  if (foreground !== undefined && foreground.toLowerCase() !== "auto") {
    throw new DocxImportError(
      "unsupported_feature",
      "Patterned table foreground colors are not represented",
      partName,
    );
  }
}

function parseTableLayout(element: XmlElement | undefined): "fixed" | "autofit" | undefined {
  if (!element) return undefined;
  assertAllowedAttributes(element, new Set(["type"]), "table layout");
  const value = attribute(element, "type");
  if (value === "fixed") return "fixed";
  if (value === "autofit") return "autofit";
  throw new DocxImportError(
    "invalid_package",
    `Invalid table layout type: ${String(value)}`,
    "table layout",
  );
}

function parseMeasure(element: XmlElement | undefined): ImportedMeasure | undefined {
  if (!element) return undefined;
  assertAllowedAttributes(element, new Set(["w", "type"]), "OOXML measure");
  const width = attribute(element, "w");
  if (width === undefined)
    throw new DocxImportError("invalid_package", "OOXML measure lacks a width");
  const raw = Number(width);
  if (!Number.isFinite(raw))
    throw new DocxImportError("invalid_package", "OOXML measure width is invalid");
  const type = attribute(element, "type") ?? "dxa";
  if (type === "dxa") return { value: twipsToPt(raw), unit: "pt" };
  if (type === "pct") return { value: raw / 50, unit: "percent" };
  if (type === "auto" || type === "nil") return { value: raw, unit: "auto" };
  throw new DocxImportError("unsupported_feature", `Unsupported OOXML measure type: ${type}`);
}

function parseStyles(root: XmlElement, limits: DocxImportLimits): ImportedStyle[] {
  requireLocalName(root, "styles", "word/styles.xml");
  requireWordNamespace(root, "word/styles.xml");
  rejectUnsupportedContent(root, "word/styles.xml");
  assertAllowedContentChildren(
    root,
    new Set(["docDefaults", "latentStyles", "style"]),
    "styles root",
  );
  const defaults = children(root, "docDefaults");
  if (defaults.length > 1)
    throw new DocxImportError("invalid_package", "Styles repeats docDefaults", "word/styles.xml");
  if (defaults[0]) validateEmptyStyleDefaults(defaults[0]);
  const styles: ImportedStyle[] = [];
  const styleIds = new Set<string>();
  for (const element of children(root, "style")) {
    if (styles.length >= limits.maxStyles)
      throw limitError("DOCX exceeds maxStyles", "word/styles.xml");
    const styleId = requiredAttribute(element, "styleId", "word/styles.xml");
    if (styleIds.has(styleId))
      throw new DocxImportError("invalid_package", "Duplicate style id", "word/styles.xml");
    styleIds.add(styleId);
    const kind = attribute(element, "type") ?? "paragraph";
    if (kind !== "paragraph" && kind !== "character") {
      throw new DocxImportError(
        "unsupported_feature",
        `Style type ${kind} is not represented`,
        "word/styles.xml",
      );
    }
    assertAllowedAttributes(
      element,
      new Set(["styleId", "type", "default", "customStyle"]),
      "style",
    );
    assertAllowedPropertyChildren(
      element,
      new Set([
        "name",
        "aliases",
        "basedOn",
        "next",
        "link",
        "uiPriority",
        "semiHidden",
        "unhideWhenUsed",
        "qFormat",
        "locked",
        "personal",
        "personalCompose",
        "personalReply",
        "rsid",
        "pPr",
        "rPr",
      ]),
      "style definition",
    );
    styles.push(
      stripUndefined({
        styleId,
        kind,
        name: valueOf(firstChild(element, "name")),
        basedOn: valueOf(firstChild(element, "basedOn")),
        next: valueOf(firstChild(element, "next")),
        isDefault: booleanAttribute(element, "default", false),
        paragraph: parseParagraphProperties(singletonChild(element, "pPr", "style definition")),
        run: parseRunProperties(singletonChild(element, "rPr", "style definition")),
      }),
    );
  }
  const styleById = new Map(styles.map((style) => [style.styleId, style]));
  for (const style of styles) {
    const seen = new Set<string>();
    let current: ImportedStyle | undefined = style;
    let depth = 0;
    while (current?.basedOn !== undefined) {
      if (!seen.add(current.styleId)) {
        throw new DocxImportError(
          "invalid_package",
          "Style inheritance contains a cycle",
          "word/styles.xml",
        );
      }
      depth += 1;
      if (depth > limits.maxStyleInheritanceDepth) {
        throw limitError("DOCX exceeds maxStyleInheritanceDepth", "word/styles.xml");
      }
      current = styleById.get(current.basedOn);
    }
  }
  return styles;
}

function validateEmptyStyleDefaults(defaults: XmlElement): void {
  assertAllowedPropertyChildren(defaults, new Set(["pPrDefault", "rPrDefault"]), "style defaults");
  for (const [wrapperName, propertyName, parse] of [
    ["pPrDefault", "pPr", parseParagraphProperties],
    ["rPrDefault", "rPr", parseRunProperties],
  ] as const) {
    const wrappers = children(defaults, wrapperName);
    if (wrappers.length > 1)
      throw new DocxImportError(
        "invalid_package",
        `Styles repeats ${wrapperName}`,
        "word/styles.xml",
      );
    const wrapper = wrappers[0];
    assertAllowedPropertyChildren(wrapper, new Set([propertyName]), "style defaults");
    const properties = singletonChild(wrapper, propertyName, "style defaults");
    if (properties && Object.keys(parse(properties)).length > 0) {
      throw new DocxImportError(
        "unsupported_feature",
        "Non-empty document style defaults are not yet represented",
        "word/styles.xml",
      );
    }
  }
}

function parseNumbering(root: XmlElement, limits: DocxImportLimits): ImportedListDefinition[] {
  requireLocalName(root, "numbering", "word/numbering.xml");
  requireWordNamespace(root, "word/numbering.xml");
  rejectUnsupportedContent(root, "word/numbering.xml");
  assertAllowedContentChildren(
    root,
    new Set(["numPicBullet", "abstractNum", "num"]),
    "numbering root",
  );
  if (children(root, "numPicBullet").length > 0) {
    throw new DocxImportError(
      "unsupported_feature",
      "Picture bullets are not yet supported",
      "word/numbering.xml",
    );
  }
  const abstract = new Map<string, ImportedListLevel[]>();
  for (const definition of children(root, "abstractNum")) {
    if (abstract.size >= limits.maxNumberingDefinitions) {
      throw limitError("DOCX exceeds maxNumberingDefinitions", "word/numbering.xml");
    }
    const id = requiredAttribute(definition, "abstractNumId", "word/numbering.xml");
    assertAllowedAttributes(
      definition,
      new Set(["abstractNumId", "w15:restartNumberingAfterBreak"]),
      "abstract numbering definition",
    );
    const restartAfterBreak = prefixedAttribute(definition, "w15", "restartNumberingAfterBreak");
    if (restartAfterBreak !== undefined && parseBooleanLexical(restartAfterBreak)) {
      throw new DocxImportError(
        "unsupported_feature",
        "Restarting numbering after section breaks is not represented",
        "word/numbering.xml",
      );
    }
    assertAllowedPropertyChildren(
      definition,
      new Set(["nsid", "multiLevelType", "tmpl", "name", "lvl"]),
      "abstract numbering definition",
    );
    if (abstract.has(id))
      throw new DocxImportError(
        "invalid_package",
        "Duplicate abstract numbering id",
        "word/numbering.xml",
      );
    const levels = children(definition, "lvl").map(parseListLevel);
    validateListLevels(levels, "abstract numbering definition");
    abstract.set(id, levels);
  }
  const numIds = new Set<string>();
  const nums = children(root, "num");
  if (nums.length > limits.maxNumberingDefinitions) {
    throw limitError("DOCX exceeds maxNumberingDefinitions", "word/numbering.xml");
  }
  return nums.map((numbering): ImportedListDefinition => {
    assertAllowedAttributes(numbering, new Set(["numId"]), "numbering definition");
    assertAllowedPropertyChildren(
      numbering,
      new Set(["abstractNumId", "lvlOverride"]),
      "numbering definition",
    );
    const numId = requiredAttribute(numbering, "numId", "word/numbering.xml");
    if (numIds.has(numId))
      throw new DocxImportError("invalid_package", "Duplicate numbering id", "word/numbering.xml");
    numIds.add(numId);
    const abstractNumId = valueOf(firstChild(numbering, "abstractNumId"));
    if (!abstractNumId || !abstract.has(abstractNumId))
      throw new DocxImportError(
        "invalid_package",
        "Numbering references a missing abstract definition",
        "word/numbering.xml",
      );
    const overrides = children(numbering, "lvlOverride").map((override) => {
      assertAllowedAttributes(override, new Set(["ilvl"]), "numbering override");
      assertAllowedPropertyChildren(
        override,
        new Set(["startOverride", "lvl"]),
        "numbering override",
      );
      return stripUndefined<{
        level: number;
        start?: number;
        definition?: ImportedListLevel;
      }>({
        level: parseLevelIndex(override),
        start: numberValue(firstChild(override, "startOverride")),
        definition: firstChild(override, "lvl")
          ? parseListLevel(firstChild(override, "lvl") as XmlElement)
          : undefined,
      });
    });
    validateOverrideLevels(overrides);
    return {
      numId,
      abstractNumId,
      levels: (abstract.get(abstractNumId) ?? []).map((level) => ({ ...level })),
      overrides,
    };
  });
}

function parseListLevel(level: XmlElement): ImportedListLevel {
  assertAllowedAttributes(level, new Set(["ilvl", "tplc", "w15:tentative"]), "numbering level");
  assertAllowedPropertyChildren(
    level,
    new Set([
      "start",
      "numFmt",
      "lvlRestart",
      "pStyle",
      "isLgl",
      "suff",
      "lvlText",
      "lvlJc",
      "pPr",
      "rPr",
    ]),
    "numbering level",
  );
  assertUniqueChildNames(level, "numbering level");
  for (const name of [
    "start",
    "numFmt",
    "lvlRestart",
    "pStyle",
    "isLgl",
    "suff",
    "lvlText",
    "lvlJc",
  ] as const) {
    assertAllowedAttributes(firstChild(level, name), new Set(["val"]), `numbering level ${name}`);
  }
  const restartElement = firstChild(level, "lvlRestart");
  const restart = restartElement ? integerValue(restartElement, 0) : undefined;
  if (restart !== undefined && (restart < 0 || restart > 9)) {
    throw new DocxImportError(
      "invalid_package",
      "Numbering restart level must be from 0 through 9",
      "word/numbering.xml",
    );
  }
  return stripUndefined({
    level: parseLevelIndex(level),
    start: integerValue(firstChild(level, "start"), 1),
    restart,
    legal: optionalBoolean(firstChild(level, "isLgl")),
    alignment: valueOf(firstChild(level, "lvlJc")),
    format: valueOf(firstChild(level, "numFmt")),
    text: valueOf(firstChild(level, "lvlText")),
    suffix: valueOf(firstChild(level, "suff")),
    paragraphStyleId: valueOf(firstChild(level, "pStyle")),
    paragraph: parseParagraphProperties(singletonChild(level, "pPr", "numbering level")),
    run: parseRunProperties(singletonChild(level, "rPr", "numbering level")),
  });
}

function parseLevelIndex(element: XmlElement): number {
  const raw = requiredAttribute(element, "ilvl", "word/numbering.xml");
  const level = Number(raw);
  if (!Number.isInteger(level) || level < 0 || level > 8) {
    throw new DocxImportError(
      "invalid_package",
      "Numbering level must be an integer from 0 through 8",
      "word/numbering.xml",
    );
  }
  return level;
}

function validateListLevels(levels: readonly ImportedListLevel[], label: string): void {
  if (levels.length > 9)
    throw new DocxImportError(
      "invalid_package",
      `${label} has more than nine levels`,
      "word/numbering.xml",
    );
  const seen = new Set<number>();
  for (const level of levels) {
    if (seen.has(level.level))
      throw new DocxImportError(
        "invalid_package",
        `${label} repeats a level`,
        "word/numbering.xml",
      );
    seen.add(level.level);
  }
}

function validateOverrideLevels(
  overrides: ReadonlyArray<{ level: number; start?: number; definition?: ImportedListLevel }>,
): void {
  if (overrides.length > 9)
    throw new DocxImportError(
      "invalid_package",
      "Numbering definition has more than nine overrides",
      "word/numbering.xml",
    );
  const seen = new Set<number>();
  for (const override of overrides) {
    if (seen.has(override.level))
      throw new DocxImportError(
        "invalid_package",
        "Numbering definition repeats an override",
        "word/numbering.xml",
      );
    seen.add(override.level);
    if (override.definition && override.definition.level !== override.level) {
      throw new DocxImportError(
        "invalid_package",
        "Numbering override level disagrees with its definition",
        "word/numbering.xml",
      );
    }
  }
}

function parseParagraphProperties(element: XmlElement | undefined): ImportedParagraphStyle {
  assertAllowedPropertyChildren(
    element,
    new Set([
      "pStyle",
      "jc",
      "spacing",
      "ind",
      "keepNext",
      "keepLines",
      "pageBreakBefore",
      "outlineLvl",
      "bidi",
      "numPr",
      "sectPr",
    ]),
    "paragraph properties",
  );
  assertUniqueChildNames(element, "paragraph properties");
  const spacing = firstChild(element, "spacing");
  const indent = firstChild(element, "ind");
  const numProperties = firstChild(element, "numPr");
  assertAllowedPropertyChildren(
    numProperties,
    new Set(["numId", "ilvl"]),
    "paragraph numbering properties",
  );
  assertUniqueChildNames(numProperties, "paragraph numbering properties");
  for (const name of [
    "pStyle",
    "jc",
    "keepNext",
    "keepLines",
    "pageBreakBefore",
    "outlineLvl",
    "bidi",
  ] as const) {
    assertAllowedAttributes(firstChild(element, name), new Set(["val"]), `paragraph ${name}`);
  }
  assertAllowedAttributes(
    spacing,
    new Set(["before", "after", "line", "lineRule"]),
    "paragraph spacing",
  );
  assertAllowedAttributes(
    indent,
    new Set(["left", "right", "firstLine", "hanging"]),
    "paragraph indentation",
  );
  assertAllowedAttributes(numProperties, new Set(), "paragraph numbering properties");
  assertAllowedAttributes(
    firstChild(numProperties, "numId"),
    new Set(["val"]),
    "paragraph numbering id",
  );
  assertAllowedAttributes(
    firstChild(numProperties, "ilvl"),
    new Set(["val"]),
    "paragraph numbering level",
  );
  if (attribute(indent, "firstLine") !== undefined && attribute(indent, "hanging") !== undefined) {
    throw new DocxImportError(
      "invalid_package",
      "Paragraph indentation cannot specify both firstLine and hanging",
      "paragraph indentation",
    );
  }
  const lineRule = attribute(spacing, "lineRule");
  if (
    lineRule !== undefined &&
    lineRule !== "auto" &&
    lineRule !== "exact" &&
    lineRule !== "atLeast"
  ) {
    throw new DocxImportError(
      "invalid_package",
      "Paragraph line rule is invalid",
      "paragraph spacing",
    );
  }
  const numId = valueOf(firstChild(numProperties, "numId"));
  return stripUndefined({
    alignment: valueOf(firstChild(element, "jc")),
    spaceBeforePt: numberAttribute(spacing, "before", twipsToPt),
    spaceAfterPt: numberAttribute(spacing, "after", twipsToPt),
    line: numberAttribute(spacing, "line"),
    lineRule,
    indentLeftPt: numberAttribute(indent, "left", twipsToPt),
    indentRightPt: numberAttribute(indent, "right", twipsToPt),
    firstLinePt: numberAttribute(indent, "firstLine", twipsToPt),
    hangingPt: numberAttribute(indent, "hanging", twipsToPt),
    keepNext: optionalBoolean(firstChild(element, "keepNext")),
    keepLines: optionalBoolean(firstChild(element, "keepLines")),
    pageBreakBefore: optionalBoolean(firstChild(element, "pageBreakBefore")),
    outlineLevel: numberValue(firstChild(element, "outlineLvl")),
    bidirectional: optionalBoolean(firstChild(element, "bidi")),
    list:
      numId === undefined
        ? undefined
        : { numId, level: integerValue(firstChild(numProperties, "ilvl"), 0) },
  });
}

function parseRunProperties(element: XmlElement | undefined): ImportedRunStyle {
  assertAllowedPropertyChildren(
    element,
    new Set([
      "rStyle",
      "rFonts",
      "sz",
      "szCs",
      "color",
      "b",
      "bCs",
      "i",
      "iCs",
      "u",
      "strike",
      "highlight",
      "vertAlign",
      "lang",
    ]),
    "run properties",
  );
  assertUniqueChildNames(element, "run properties");
  const fonts = firstChild(element, "rFonts");
  const color = firstChild(element, "color");
  if (
    ["asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme"].some(
      (name) => attribute(fonts, name) !== undefined,
    )
  ) {
    throw new DocxImportError(
      "unsupported_feature",
      "Theme font references are not represented by the document model",
      "run properties",
    );
  }
  if (
    ["themeColor", "themeTint", "themeShade"].some((name) => attribute(color, name) !== undefined)
  ) {
    throw new DocxImportError(
      "unsupported_feature",
      "Theme colors are not represented by the document model",
      "run properties",
    );
  }
  assertAllowedAttributes(fonts, new Set(["ascii", "hAnsi", "eastAsia", "cs"]), "run fonts");
  assertAllowedAttributes(color, new Set(["val"]), "run color");
  const underlineElement = firstChild(element, "u");
  assertAllowedAttributes(underlineElement, new Set(["val"]), "run underline");
  for (const name of [
    "rStyle",
    "sz",
    "szCs",
    "b",
    "bCs",
    "i",
    "iCs",
    "strike",
    "highlight",
    "vertAlign",
    "lang",
  ] as const) {
    assertAllowedAttributes(firstChild(element, name), new Set(["val"]), `run ${name}`);
  }
  const underline = valueOf(underlineElement);
  if (underline !== undefined && underline !== "single" && underline !== "none") {
    throw new DocxImportError(
      "unsupported_feature",
      `Underline style ${underline} is not represented by the document model`,
      "run properties",
    );
  }
  const directFonts = ["ascii", "hAnsi", "eastAsia", "cs"]
    .map((name) => attribute(fonts, name))
    .filter((value): value is string => value !== undefined);
  if (new Set(directFonts).size > 1) {
    throw new DocxImportError(
      "unsupported_feature",
      "Script-specific font families are not represented by the document model",
      "run properties",
    );
  }
  const colorValue = valueOf(color);
  if (colorValue?.toLowerCase() === "auto") {
    throw new DocxImportError(
      "unsupported_feature",
      "Automatic run colors are not represented by the document model",
      "run properties",
    );
  }
  return stripUndefined({
    fontFamily: directFonts[0],
    fontSizePt: numberValue(firstChild(element, "sz"), (value) => value / 2),
    fontSizeComplexScriptPt: numberValue(firstChild(element, "szCs"), (value) => value / 2),
    color: colorValue,
    bold: optionalBoolean(firstChild(element, "b")),
    boldComplexScript: optionalBoolean(firstChild(element, "bCs")),
    italic: optionalBoolean(firstChild(element, "i")),
    italicComplexScript: optionalBoolean(firstChild(element, "iCs")),
    underline,
    strike: optionalBoolean(firstChild(element, "strike")),
    highlight: valueOf(firstChild(element, "highlight")),
    verticalAlign: valueOf(firstChild(element, "vertAlign")),
    language: attribute(firstChild(element, "lang"), "val"),
  });
}

function assertAllowedPropertyChildren(
  element: XmlElement | undefined,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const child of elementChildren(element)) {
    if (!allowed.has(child.localName)) {
      throw new DocxImportError(
        "unsupported_feature",
        `Unsupported ${label}: ${child.name}`,
        label,
      );
    }
  }
}

function assertAllowedContentChildren(
  element: XmlElement | undefined,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const child of elementChildren(element)) {
    if (!allowed.has(child.localName) && !NON_CONTENT_MARKERS.has(child.localName)) {
      throw new DocxImportError(
        "unsupported_feature",
        `Unsupported ${label} content: ${child.name}`,
        label,
      );
    }
  }
}

function assertAllowedAttributes(
  element: XmlElement | undefined,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  if (!element) return;
  for (const name of element.attributes.keys()) {
    if (name === "xmlns" || name.startsWith("xmlns:")) continue;
    const permitted = allowed.has(name) || (name.startsWith("w:") && allowed.has(name.slice(2)));
    if (!permitted) {
      throw new DocxImportError(
        "unsupported_feature",
        `Unsupported ${label} attribute: ${name}`,
        label,
      );
    }
  }
}

function parseSection(
  element: XmlElement,
  startBlockIndex: number,
  endBlockIndex: number,
  relationships: ReadonlyMap<string, Relationship>,
): ImportedSection {
  assertAllowedAttributes(element, new Set(["rsidR", "rsidRPr", "rsidSect"]), "section properties");
  assertAllowedPropertyChildren(
    element,
    new Set([
      "headerReference",
      "footerReference",
      "type",
      "pgSz",
      "pgMar",
      "pgNumType",
      "titlePg",
      "docGrid",
    ]),
    "section properties",
  );
  for (const singleton of ["type", "pgSz", "pgMar", "pgNumType", "titlePg", "docGrid"] as const) {
    if (children(element, singleton).length > 1) {
      throw new DocxImportError(
        "invalid_package",
        `Section repeats ${singleton}`,
        "word/document.xml",
      );
    }
  }
  const pageSize = firstChild(element, "pgSz");
  const margins = firstChild(element, "pgMar");
  assertAllowedAttributes(pageSize, new Set(["w", "h", "orient", "code"]), "section page size");
  assertAllowedAttributes(
    margins,
    new Set(["top", "right", "bottom", "left", "header", "footer", "gutter"]),
    "section page margins",
  );
  assertAllowedContentChildren(pageSize, new Set(), "section page size");
  assertAllowedContentChildren(margins, new Set(), "section page margins");
  if (
    pageSize &&
    (attribute(pageSize, "w") === undefined || attribute(pageSize, "h") === undefined)
  ) {
    throw new DocxImportError(
      "invalid_package",
      "Section page size is incomplete",
      "word/document.xml",
    );
  }
  if (
    margins &&
    ["top", "right", "bottom", "left", "header", "footer", "gutter"].some(
      (name) => attribute(margins, name) === undefined,
    )
  ) {
    throw new DocxImportError(
      "invalid_package",
      "Section page margins are incomplete",
      "word/document.xml",
    );
  }
  const pageNumbering = firstChild(element, "pgNumType");
  assertAllowedAttributes(pageNumbering, new Set(), "section page numbering");
  assertAllowedContentChildren(pageNumbering, new Set(), "section page numbering");
  const documentGrid = firstChild(element, "docGrid");
  assertAllowedAttributes(
    documentGrid,
    new Set(["type", "linePitch", "charSpace"]),
    "section document grid",
  );
  assertAllowedContentChildren(documentGrid, new Set(), "section document grid");
  const gridType = attribute(documentGrid, "type");
  if (gridType !== undefined && gridType !== "default") {
    throw new DocxImportError(
      "unsupported_feature",
      `Document grid type ${gridType} is not represented`,
      "word/document.xml",
    );
  }
  numberAttribute(documentGrid, "linePitch");
  numberAttribute(documentGrid, "charSpace");
  const sectionTypeElement = firstChild(element, "type");
  const titlePageElement = firstChild(element, "titlePg");
  assertAllowedAttributes(sectionTypeElement, new Set(["val"]), "section break type");
  assertAllowedAttributes(titlePageElement, new Set(["val"]), "section title-page setting");
  assertAllowedContentChildren(sectionTypeElement, new Set(), "section break type");
  assertAllowedContentChildren(titlePageElement, new Set(), "section title-page setting");
  const orientation = attribute(pageSize, "orient");
  if (orientation !== undefined && orientation !== "portrait" && orientation !== "landscape") {
    throw new DocxImportError(
      "invalid_package",
      "Section page orientation is invalid",
      "word/document.xml",
    );
  }
  const sectionType = valueOf(sectionTypeElement);
  if (
    sectionType !== undefined &&
    !new Set(["nextPage", "nextColumn", "continuous", "evenPage", "oddPage"]).has(sectionType)
  ) {
    throw new DocxImportError(
      "invalid_package",
      "Section break type is invalid",
      "word/document.xml",
    );
  }
  const references = (kind: "header" | "footer"): ImportedSectionReference[] =>
    children(element, `${kind}Reference`).map((reference) => {
      assertAllowedAttributes(reference, new Set(["r:id", "type"]), `${kind} reference`);
      assertAllowedContentChildren(reference, new Set(), `${kind} reference`);
      const relationshipId = requiredPrefixedAttribute(reference, "r", "id", "word/document.xml");
      const relationship = relationships.get(relationshipId);
      if (!relationship || relationship.type !== `${WORD_RELATIONSHIP_BASE}${kind}`) {
        throw new DocxImportError(
          "invalid_package",
          `Section references a missing ${kind}`,
          "word/document.xml",
        );
      }
      const referenceKind = attribute(reference, "type") ?? "default";
      if (referenceKind !== "default" && referenceKind !== "first" && referenceKind !== "even") {
        throw new DocxImportError(
          "invalid_package",
          `Invalid ${kind} reference kind`,
          "word/document.xml",
        );
      }
      return {
        kind: referenceKind,
        relationshipId,
        partName: relationship.partName,
      };
    });
  const headers = references("header");
  const footers = references("footer");
  for (const storyReferences of [headers, footers]) {
    const kinds = new Set<string>();
    for (const reference of storyReferences) {
      if (kinds.has(reference.kind))
        throw new DocxImportError(
          "invalid_package",
          "Section repeats a header/footer reference kind",
          "word/document.xml",
        );
      kinds.add(reference.kind);
    }
  }
  return stripUndefined({
    startBlockIndex,
    endBlockIndex,
    type: sectionType,
    titlePage: booleanValue(titlePageElement, false),
    page: {
      widthPt: numberAttribute(pageSize, "w", twipsToPt) ?? 612,
      heightPt: numberAttribute(pageSize, "h", twipsToPt) ?? 792,
      ...(orientation !== undefined ? { orientation } : {}),
      marginTopPt: numberAttribute(margins, "top", twipsToPt) ?? 72,
      marginRightPt: numberAttribute(margins, "right", twipsToPt) ?? 72,
      marginBottomPt: numberAttribute(margins, "bottom", twipsToPt) ?? 72,
      marginLeftPt: numberAttribute(margins, "left", twipsToPt) ?? 72,
      headerPt: numberAttribute(margins, "header", twipsToPt) ?? 36,
      footerPt: numberAttribute(margins, "footer", twipsToPt) ?? 36,
      gutterPt: numberAttribute(margins, "gutter", twipsToPt) ?? 0,
    },
    headers,
    footers,
  });
}

function defaultSection(startBlockIndex: number, endBlockIndex: number): ImportedSection {
  return {
    startBlockIndex,
    endBlockIndex,
    titlePage: false,
    page: {
      widthPt: 612,
      heightPt: 792,
      marginTopPt: 72,
      marginRightPt: 72,
      marginBottomPt: 72,
      marginLeftPt: 72,
      headerPt: 36,
      footerPt: 36,
      gutterPt: 0,
    },
    headers: [],
    footers: [],
  };
}

function resolveSectionStoryInheritance(sections: ImportedSection[]): void {
  for (let index = 1; index < sections.length; index += 1) {
    const previous = sections[index - 1];
    const current = sections[index];
    if (!previous || !current) continue;
    for (const key of ["headers", "footers"] as const) {
      const present = new Set(current[key].map((reference) => reference.kind));
      for (const inherited of previous[key]) {
        if (!present.has(inherited.kind)) current[key].push({ ...inherited });
      }
    }
  }
}

function validateProjectedStories(
  sections: readonly ImportedSection[],
  headers: readonly ImportedHeaderFooter[],
  footers: readonly ImportedHeaderFooter[],
  maximumBlocks: number,
  maximumCharacters: number,
): void {
  const costByPart = new Map<string, { blocks: number; characters: number }>();
  for (const story of [...headers, ...footers]) {
    costByPart.set(story.partName, measureBlockTree(story.blocks));
  }
  let projectedBlocks = 0;
  let projectedCharacters = 0;
  for (const section of sections) {
    for (const reference of [...section.headers, ...section.footers]) {
      const storyCost = costByPart.get(reference.partName);
      if (storyCost === undefined) {
        throw new DocxImportError(
          "invalid_package",
          "Section references an unparsed header or footer",
          reference.partName,
        );
      }
      projectedBlocks += storyCost.blocks;
      projectedCharacters += storyCost.characters;
      if (projectedBlocks > maximumBlocks)
        throw limitError("DOCX exceeds maxProjectedStoryBlocks", reference.partName);
      if (projectedCharacters > maximumCharacters) {
        throw limitError("DOCX exceeds maxProjectedStoryCharacters", reference.partName);
      }
    }
  }
}

function measureBlockTree(blocks: readonly ImportedBlock[]): {
  blocks: number;
  characters: number;
} {
  let count = 0;
  let characters = 0;
  const stack = [...blocks];
  while (stack.length > 0) {
    const block = stack.pop();
    if (!block) continue;
    count += 1;
    if (block.kind === "paragraph") {
      for (const inline of block.inlines)
        if (inline.kind === "run") characters += inline.text.length;
    } else if (block.kind === "table") {
      for (const row of block.rows)
        for (const cell of row.cells) {
          for (const child of cell.blocks) stack.push(child);
        }
    }
  }
  return { blocks: count, characters };
}

type ExtendedComment = { parentParagraphId?: string; resolved?: boolean };

function parseCommentsExtended(root: XmlElement, maximum: number): Map<string, ExtendedComment> {
  requireLocalName(root, "commentsEx", "word/commentsExtended.xml");
  requirePrefixedNamespaceTree(
    root,
    "w15",
    COMMENTS_EXTENDED_NAMESPACE,
    "word/commentsExtended.xml",
  );
  const result = new Map<string, ExtendedComment>();
  for (const comment of elementChildren(root)) {
    if (comment.localName !== "commentEx")
      throw unsupportedElement(comment, "word/commentsExtended.xml");
    if (result.size >= maximum)
      throw limitError("DOCX exceeds maxComments", "word/commentsExtended.xml");
    const paragraphId = requiredPrefixedAttribute(
      comment,
      "w15",
      "paraId",
      "word/commentsExtended.xml",
    );
    if (result.has(paragraphId))
      throw new DocxImportError(
        "invalid_package",
        "Duplicate extended comment paragraph id",
        "word/commentsExtended.xml",
      );
    const parentParagraphId = prefixedAttribute(comment, "w15", "paraIdParent");
    const done = prefixedAttribute(comment, "w15", "done");
    result.set(paragraphId, {
      ...(parentParagraphId !== undefined ? { parentParagraphId } : {}),
      ...(done !== undefined ? { resolved: !FALSE_VALUES.has(done.toLowerCase()) } : {}),
    });
  }
  return result;
}

function parseComments(
  root: XmlElement,
  context: ParseContext,
  extended: ReadonlyMap<string, ExtendedComment>,
  maximum: number,
): ImportedComment[] {
  requireLocalName(root, "comments", "word/comments.xml");
  rejectUnsupportedContent(root, "word/comments.xml");
  requireWordNamespace(root, "word/comments.xml");
  const drafts: Array<{ paragraphId?: string; comment: ImportedComment }> = [];
  for (const comment of elementChildren(root)) {
    if (comment.localName !== "comment") throw unsupportedElement(comment, "word/comments.xml");
    if (drafts.length >= maximum) throw limitError("DOCX exceeds maxComments", "word/comments.xml");
    const lastParagraph = lastDescendant(comment, "p");
    const paragraphId = prefixedAttribute(lastParagraph, "w14", "paraId");
    drafts.push({
      // commentsExtended keys a comment by the paraId of its final paragraph.
      ...(paragraphId !== undefined ? { paragraphId } : {}),
      comment: stripUndefined<ImportedComment>({
        id: requiredAttribute(comment, "id", "word/comments.xml"),
        author: attribute(comment, "author"),
        initials: attribute(comment, "initials"),
        createdAt: attribute(comment, "date"),
        blocks: parseBlockContainer(comment, context),
      }),
    });
  }
  const commentIdByParagraphId = new Map<string, string>();
  const commentIds = new Set<string>();
  for (const draft of drafts) {
    if (commentIds.has(draft.comment.id))
      throw new DocxImportError("invalid_package", "Duplicate comment id", "word/comments.xml");
    commentIds.add(draft.comment.id);
    if (!draft.paragraphId) continue;
    if (commentIdByParagraphId.has(draft.paragraphId)) {
      throw new DocxImportError(
        "invalid_package",
        "Duplicate comment paragraph id",
        "word/comments.xml",
      );
    }
    commentIdByParagraphId.set(draft.paragraphId, draft.comment.id);
  }
  for (const draft of drafts) {
    if (!draft.paragraphId) continue;
    const metadata = extended.get(draft.paragraphId);
    if (!metadata) continue;
    if (metadata.resolved !== undefined) draft.comment.resolved = metadata.resolved;
    if (metadata.parentParagraphId !== undefined) {
      const parentId = commentIdByParagraphId.get(metadata.parentParagraphId);
      if (!parentId)
        throw new DocxImportError(
          "invalid_package",
          "Comment reply references a missing parent",
          "word/commentsExtended.xml",
        );
      draft.comment.parentId = parentId;
    }
  }
  for (const paragraphId of extended.keys()) {
    if (!commentIdByParagraphId.has(paragraphId)) {
      throw new DocxImportError(
        "invalid_package",
        "Extended comment references a missing comment paragraph",
        "word/commentsExtended.xml",
      );
    }
  }
  return drafts.map((draft) => draft.comment);
}

function validateCommentReferences(
  blocks: readonly ImportedBlock[],
  headers: readonly ImportedHeaderFooter[],
  footers: readonly ImportedHeaderFooter[],
  comments: readonly ImportedComment[],
): void {
  const ids = new Set(comments.map((comment) => comment.id));
  const commentById = new Map(comments.map((comment) => [comment.id, comment]));
  const roots = new Set(
    comments.filter((comment) => comment.parentId === undefined).map((comment) => comment.id),
  );
  for (const comment of comments) {
    if (comment.parentId !== undefined && !ids.has(comment.parentId)) {
      throw new DocxImportError(
        "invalid_package",
        "Comment reply references a missing parent",
        "word/commentsExtended.xml",
      );
    }
  }
  const visitState = new Map<string, 1 | 2>();
  for (const comment of comments) {
    if (visitState.get(comment.id) === 2) continue;
    const path: string[] = [];
    let current: ImportedComment | undefined = comment;
    while (current && visitState.get(current.id) === undefined) {
      visitState.set(current.id, 1);
      path.push(current.id);
      current = current.parentId === undefined ? undefined : commentById.get(current.parentId);
    }
    if (current && visitState.get(current.id) === 1) {
      throw new DocxImportError(
        "invalid_package",
        "Comment reply graph contains a cycle",
        "word/commentsExtended.xml",
      );
    }
    for (const id of path) visitState.set(id, 2);
  }
  type Counts = { start: number; end: number; reference: number };
  const storyCountsByComment = new Map<string, Counts[]>();
  const countStory = (items: readonly ImportedBlock[]): void => {
    const counts = new Map<string, Counts>();
    const walk = (nested: readonly ImportedBlock[]): void => {
      for (const block of nested) {
        if (block.kind === "paragraph") {
          for (const anchor of block.commentAnchors) {
            if (!ids.has(anchor.commentId))
              throw new DocxImportError(
                "invalid_package",
                "Document references a missing comment",
                "word/comments.xml",
              );
            if (!roots.has(anchor.commentId))
              throw new DocxImportError(
                "invalid_package",
                "Document anchors a comment reply instead of its root",
                "word/comments.xml",
              );
            const count = counts.get(anchor.commentId) ?? { start: 0, end: 0, reference: 0 };
            count[anchor.kind] += 1;
            counts.set(anchor.commentId, count);
          }
        } else if (block.kind === "table") {
          for (const row of block.rows) for (const cell of row.cells) walk(cell.blocks);
        }
      }
    };
    walk(items);
    for (const [commentId, count] of counts) {
      const stories = storyCountsByComment.get(commentId);
      if (stories) stories.push(count);
      else storyCountsByComment.set(commentId, [count]);
    }
  };
  countStory(blocks);
  for (const item of [...headers, ...footers]) countStory(item.blocks);
  for (const comment of comments) {
    const anchoredStories = storyCountsByComment.get(comment.id) ?? [];
    if (comment.parentId === undefined) {
      if (anchoredStories.length !== 1) {
        throw new DocxImportError(
          "invalid_package",
          "Root comment must be anchored in exactly one document story",
          "word/document.xml",
        );
      }
      const count = anchoredStories[0] as Counts;
      // OOXML permits point comments with either or both range markers absent;
      // the commentReference remains the authoritative anchor.
      if (count.reference !== 1 || count.start > 1 || count.end > 1) {
        throw new DocxImportError(
          "invalid_package",
          "Comment story has duplicate or missing reference anchors",
          "word/document.xml",
        );
      }
    } else if (anchoredStories.length > 0) {
      throw new DocxImportError(
        "invalid_package",
        "Comment replies must not have document anchors",
        "word/document.xml",
      );
    }
  }
}

const UNSUPPORTED_CONTENT = new Map<string, string>([
  ["drawing", "drawings and images"],
  ["pict", "VML drawings and images"],
  ["object", "embedded objects"],
  ["oleObject", "OLE objects"],
  ["altChunk", "altChunk content"],
  ["hyperlink", "hyperlinks"],
  ["fldSimple", "fields"],
  ["fldChar", "fields"],
  ["instrText", "fields"],
  ["footnoteReference", "footnotes"],
  ["endnoteReference", "endnotes"],
  ["sdt", "content controls"],
  ["customXml", "custom XML content"],
  ["smartTag", "smart tags"],
  ["oMath", "equations"],
  ["oMathPara", "equations"],
  ["sym", "symbol-font characters"],
  ["ruby", "ruby annotations"],
  ["subDoc", "subdocuments"],
  ["txbxContent", "text boxes"],
  ["AlternateContent", "alternate content"],
  ["moveFrom", "tracked moves"],
  ["moveTo", "tracked moves"],
  ["pPrChange", "paragraph-property revisions"],
  ["rPrChange", "run-property revisions"],
  ["tblPrChange", "table-property revisions"],
  ["tblGridChange", "table-grid revisions"],
  ["trPrChange", "table-row-property revisions"],
  ["tcPrChange", "table-cell-property revisions"],
  ["sectPrChange", "section-property revisions"],
  ["numberingChange", "numbering-property revisions"],
  ["cellIns", "table-cell insertion revisions"],
  ["cellDel", "table-cell deletion revisions"],
  ["cellMerge", "table-cell merge revisions"],
  ["background", "document backgrounds"],
]);

function rejectUnsupportedContent(root: XmlElement, partName: string): void {
  const stack = [root];
  while (stack.length > 0) {
    const element = stack.pop();
    if (!element) break;
    const feature = UNSUPPORTED_CONTENT.get(element.localName);
    if (feature)
      throw new DocxImportError(
        "unsupported_feature",
        `DOCX ${feature} are not yet supported`,
        partName,
      );
    for (const child of elementChildren(element)) stack.push(child);
  }
}

const NON_CONTENT_MARKERS = new Set([
  "bookmarkStart",
  "bookmarkEnd",
  "proofErr",
  "permStart",
  "permEnd",
  "commentReference",
  "lastRenderedPageBreak",
]);

function unsupportedElement(element: XmlElement, partName: string): DocxImportError {
  return new DocxImportError(
    "unsupported_feature",
    `Unsupported content element: ${element.name}`,
    partName,
  );
}

function relationshipSourcePart(relationshipPart: string): string {
  if (relationshipPart === "_rels/.rels") return "";
  const match = /^(.*\/)?_rels\/([^/]+)\.rels$/.exec(relationshipPart);
  if (!match)
    throw new DocxImportError(
      "invalid_package",
      "Invalid relationships part name",
      relationshipPart,
    );
  return `${match[1] ?? ""}${match[2] ?? ""}`;
}

function resolvePartTarget(sourcePart: string, target: string, relationshipsPart: string): string {
  if (
    /[\u0000-\u001f\u007f]/.test(target) ||
    target.includes("\\") ||
    target.startsWith("//") ||
    /%(?:2e|2f|5c)/i.test(target)
  ) {
    throw new DocxImportError("invalid_package", "Unsafe relationship target", relationshipsPart);
  }
  const packageAbsolute = target.startsWith("/");
  const relativeTarget = packageAbsolute ? target.slice(1) : target;
  const base =
    !packageAbsolute && sourcePart.includes("/")
      ? sourcePart.slice(0, sourcePart.lastIndexOf("/") + 1)
      : "";
  const combined = `${base}${relativeTarget}`;
  if (combined.includes("//"))
    throw new DocxImportError(
      "invalid_package",
      "Relationship target contains an empty path segment",
      relationshipsPart,
    );
  let segmentCount = 1;
  for (let index = 0; index < combined.length; index += 1) {
    if (combined.charCodeAt(index) === 47) {
      segmentCount += 1;
      if (segmentCount > 256)
        throw limitError(
          "Relationship target exceeds its path-segment safety cap",
          relationshipsPart,
        );
    }
  }
  const output: string[] = [];
  for (const segment of combined.split("/")) {
    if (segment === "")
      throw new DocxImportError(
        "invalid_package",
        "Relationship target contains an empty path segment",
        relationshipsPart,
      );
    if (segment === ".") continue;
    if (segment === "..") {
      if (output.length === 0)
        throw new DocxImportError(
          "invalid_package",
          "Relationship target escapes the package root",
          relationshipsPart,
        );
      output.pop();
    } else output.push(segment);
  }
  return output.join("/");
}

function consumeBlock(budget: ImportBudget): void {
  budget.blocks += 1;
  if (budget.blocks > budget.limits.maxBlocks) throw limitError("DOCX exceeds maxBlocks");
}

function consumeText(budget: ImportBudget, characters: number): void {
  budget.textCharacters += characters;
  if (budget.textCharacters > budget.limits.maxTextCharacters)
    throw limitError("DOCX exceeds maxTextCharacters");
}

function elementChildren(element: XmlElement | undefined): XmlElement[] {
  return element?.children.filter((child): child is XmlElement => child.type === "element") ?? [];
}

function children(element: XmlElement | undefined, name: string): XmlElement[] {
  return elementChildren(element).filter((child) => child.localName === name);
}

function firstChild(element: XmlElement | undefined, name: string): XmlElement | undefined {
  return elementChildren(element).find((child) => child.localName === name);
}

function singletonChild(
  element: XmlElement | undefined,
  name: string,
  label: string,
): XmlElement | undefined {
  let match: XmlElement | undefined;
  for (const child of elementChildren(element)) {
    if (child.localName !== name) continue;
    if (match) throw new DocxImportError("invalid_package", `${label} repeats ${name}`);
    match = child;
  }
  return match;
}

function assertUniqueChildNames(element: XmlElement | undefined, label: string): void {
  const seen = new Set<string>();
  for (const child of elementChildren(element)) {
    if (seen.has(child.localName)) {
      throw new DocxImportError("invalid_package", `${label} repeats ${child.localName}`);
    }
    seen.add(child.localName);
  }
}

function lastDescendant(element: XmlElement, name: string): XmlElement | undefined {
  let match: XmlElement | undefined;
  const stack = [element];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current.localName === name) match = current;
    const nested = elementChildren(current);
    for (let index = nested.length - 1; index >= 0; index -= 1) {
      const child = nested[index];
      if (child) stack.push(child);
    }
  }
  return match;
}

function onlyElement(element: XmlElement, name: string, partName: string): XmlElement {
  const matches = children(element, name);
  if (matches.length !== 1)
    throw new DocxImportError("invalid_package", `Expected exactly one ${name} element`, partName);
  return matches[0] as XmlElement;
}

function attribute(element: XmlElement | undefined, name: string): string | undefined {
  return prefixedAttribute(element, "w", name);
}

function requiredAttribute(element: XmlElement, name: string, partName: string): string {
  const value = attribute(element, name);
  if (value === undefined || value === "")
    throw new DocxImportError("invalid_package", `Missing required ${name} attribute`, partName);
  return value;
}

function prefixedAttribute(
  element: XmlElement | undefined,
  prefix: string,
  name: string,
): string | undefined {
  return element?.attributes.get(`${prefix}:${name}`);
}

function requiredPrefixedAttribute(
  element: XmlElement,
  prefix: string,
  name: string,
  partName: string,
): string {
  const value = prefixedAttribute(element, prefix, name);
  if (value === undefined || value === "") {
    throw new DocxImportError(
      "invalid_package",
      `Missing required ${prefix}:${name} attribute`,
      partName,
    );
  }
  return value;
}

function exactAttribute(element: XmlElement | undefined, name: string): string | undefined {
  return element?.attributes.get(name);
}

function requiredExactAttribute(element: XmlElement, name: string, partName: string): string {
  const value = exactAttribute(element, name);
  if (value === undefined || value === "")
    throw new DocxImportError("invalid_package", `Missing required ${name} attribute`, partName);
  return value;
}

function assertExactAttributes(
  element: XmlElement,
  allowed: ReadonlySet<string>,
  partName: string,
): void {
  for (const name of element.attributes.keys()) {
    if (name === "xmlns" || name.startsWith("xmlns:")) continue;
    if (!allowed.has(name))
      throw new DocxImportError("invalid_package", `Unexpected attribute: ${name}`, partName);
  }
}

function requireLeafElement(element: XmlElement, partName: string): void {
  for (const child of element.children) {
    if (child.type === "element" || !isOnlyXmlWhitespace(child.value)) {
      throw new DocxImportError(
        "invalid_package",
        "Package declaration element must be empty",
        partName,
      );
    }
  }
}

function textContent(element: XmlElement): string {
  let output = "";
  const stack: XmlNode[] = [...element.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) break;
    if (node.type === "text") output += node.value;
    else {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        const child = node.children[index];
        if (child) stack.push(child);
      }
    }
  }
  return output;
}

function requireLocalName(element: XmlElement, expected: string, partName: string): void {
  if (element.localName !== expected)
    throw new DocxImportError("invalid_package", `Expected ${expected} root element`, partName);
}

function requireDefaultNamespace(element: XmlElement, expected: string, partName: string): void {
  if (element.attributes.get("xmlns") !== expected) {
    throw new DocxImportError(
      "invalid_package",
      "Unexpected or missing XML default namespace",
      partName,
    );
  }
}

function requireDefaultNamespaceTree(root: XmlElement, expected: string, partName: string): void {
  requireDefaultNamespace(root, expected, partName);
  const stack = [root];
  while (stack.length > 0) {
    const element = stack.pop();
    if (!element) break;
    if (element.name.includes(":"))
      throw new DocxImportError(
        "invalid_package",
        `Prefixed element is forbidden in this package part: ${element.name}`,
        partName,
      );
    const rebound = element.attributes.get("xmlns");
    if (rebound !== undefined && rebound !== expected)
      throw new DocxImportError("invalid_package", "Default XML namespace is rebound", partName);
    for (const child of elementChildren(element)) stack.push(child);
  }
}

function requirePrefixedNamespace(
  element: XmlElement,
  prefix: string,
  expected: string,
  partName: string,
): void {
  if (element.attributes.get(`xmlns:${prefix}`) !== expected) {
    throw new DocxImportError(
      "unsupported_feature",
      `Unsupported ${prefix} XML namespace`,
      partName,
    );
  }
}

function requireWordNamespace(root: XmlElement, partName: string): void {
  requirePrefixedNamespaceTree(root, "w", WORDPROCESSINGML_NAMESPACE, partName);
}

function requirePrefixedNamespaceTree(
  root: XmlElement,
  prefix: string,
  expected: string,
  partName: string,
): void {
  requirePrefixedNamespace(root, prefix, expected, partName);
  validateKnownNamespaceBindings(root, partName);
  const stack = [root];
  while (stack.length > 0) {
    const element = stack.pop();
    if (!element) break;
    if (!element.name.startsWith(`${prefix}:`)) {
      throw new DocxImportError(
        "unsupported_feature",
        `Unsupported namespaced Word content: ${element.name}`,
        partName,
      );
    }
    const rebound = element.attributes.get(`xmlns:${prefix}`);
    if (rebound !== undefined && rebound !== expected) {
      throw new DocxImportError("invalid_package", `${prefix} XML namespace is rebound`, partName);
    }
    for (const child of elementChildren(element)) stack.push(child);
  }
}

const KNOWN_XML_NAMESPACES = new Map<string, string>([
  ["xml", "http://www.w3.org/XML/1998/namespace"],
  ["w", WORDPROCESSINGML_NAMESPACE],
  ["r", "http://schemas.openxmlformats.org/officeDocument/2006/relationships"],
  ["w14", "http://schemas.microsoft.com/office/word/2010/wordml"],
  ["w15", COMMENTS_EXTENDED_NAMESPACE],
]);

function validateNamespaceWellFormedness(root: XmlElement, partName: string): void {
  const xmlNamespace = KNOWN_XML_NAMESPACES.get("xml") as string;
  const bindings = new Map<string, string>([["xml", xmlNamespace]]);
  const visit = (element: XmlElement): void => {
    const changes: Array<{ prefix: string; previous?: string }> = [];
    const defaultNamespace = element.attributes.get("xmlns");
    if (defaultNamespace === xmlNamespace || defaultNamespace === "http://www.w3.org/2000/xmlns/") {
      throw new DocxImportError(
        "invalid_xml",
        "Default namespace uses a reserved XML namespace",
        partName,
      );
    }
    for (const [name, value] of element.attributes) {
      if (!name.startsWith("xmlns:")) continue;
      const prefix = name.slice(6);
      if (prefix === "xmlns" || value.length === 0 || value === "http://www.w3.org/2000/xmlns/") {
        throw new DocxImportError("invalid_xml", "Invalid XML namespace declaration", partName);
      }
      if ((prefix === "xml") !== (value === xmlNamespace)) {
        throw new DocxImportError("invalid_xml", "The xml namespace is reserved", partName);
      }
      const previous = bindings.get(prefix);
      changes.push(stripUndefined({ prefix, previous }));
      bindings.set(prefix, value);
    }
    const elementSeparator = element.name.indexOf(":");
    if (elementSeparator >= 0 && !bindings.has(element.name.slice(0, elementSeparator))) {
      throw new DocxImportError(
        "invalid_xml",
        "Element uses an undeclared namespace prefix",
        partName,
      );
    }
    for (const name of element.attributes.keys()) {
      if (name === "xmlns" || name.startsWith("xmlns:")) continue;
      const separator = name.indexOf(":");
      if (separator >= 0 && !bindings.has(name.slice(0, separator))) {
        throw new DocxImportError(
          "invalid_xml",
          "Attribute uses an undeclared namespace prefix",
          partName,
        );
      }
    }
    for (const child of elementChildren(element)) visit(child);
    for (let index = changes.length - 1; index >= 0; index -= 1) {
      const change = changes[index];
      if (!change) continue;
      if (change.previous === undefined) bindings.delete(change.prefix);
      else bindings.set(change.prefix, change.previous);
    }
  };
  visit(root);
}

function validateKnownNamespaceBindings(root: XmlElement, partName: string): void {
  const bindings = new Map<string, string>([["xml", KNOWN_XML_NAMESPACES.get("xml") as string]]);
  const visit = (element: XmlElement): void => {
    const changes: Array<{ prefix: string; previous?: string }> = [];
    for (const [name, value] of element.attributes) {
      if (!name.startsWith("xmlns:")) continue;
      const declaredPrefix = name.slice(6);
      const previous = bindings.get(declaredPrefix);
      changes.push(stripUndefined({ prefix: declaredPrefix, previous }));
      const expected = KNOWN_XML_NAMESPACES.get(declaredPrefix);
      if (expected !== undefined && value !== expected) {
        throw new DocxImportError(
          "invalid_package",
          `Known namespace ${declaredPrefix} is rebound`,
          partName,
        );
      }
      bindings.set(declaredPrefix, value);
    }
    for (const name of element.attributes.keys()) {
      if (name === "xmlns" || name.startsWith("xmlns:")) continue;
      const separator = name.indexOf(":");
      if (separator < 0) continue;
      const attributePrefix = name.slice(0, separator);
      const expected = KNOWN_XML_NAMESPACES.get(attributePrefix);
      if (!bindings.has(attributePrefix)) {
        throw new DocxImportError(
          "invalid_package",
          `Attribute uses an unbound ${attributePrefix} namespace`,
          partName,
        );
      }
      if (expected !== undefined && bindings.get(attributePrefix) !== expected) {
        throw new DocxImportError(
          "invalid_package",
          `Attribute uses an unbound ${attributePrefix} namespace`,
          partName,
        );
      }
    }
    for (const child of elementChildren(element)) visit(child);
    for (let index = changes.length - 1; index >= 0; index -= 1) {
      const change = changes[index];
      if (!change) continue;
      if (change.previous === undefined) bindings.delete(change.prefix);
      else bindings.set(change.prefix, change.previous);
    }
  };
  visit(root);
}

function valueOf(element: XmlElement | undefined): string | undefined {
  return attribute(element, "val");
}

function numberValue(
  element: XmlElement | undefined,
  transform: (value: number) => number = (value) => value,
): number | undefined {
  const value = valueOf(element);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number))
    throw new DocxImportError("invalid_package", "OOXML numeric value is invalid");
  const transformed = transform(number);
  if (!Number.isFinite(transformed))
    throw new DocxImportError("invalid_package", "OOXML numeric value is out of range");
  return transformed;
}

function integerValue(element: XmlElement | undefined, fallback: number): number {
  if (valueOf(element) === undefined) return fallback;
  const value = numberValue(element);
  if (value === undefined || !Number.isInteger(value)) {
    throw new DocxImportError("invalid_package", "OOXML integer value is invalid");
  }
  return value;
}

function numberAttribute(
  element: XmlElement | undefined,
  name: string,
  transform: (value: number) => number = (value) => value,
): number | undefined {
  const raw = attribute(element, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value))
    throw new DocxImportError("invalid_package", "OOXML numeric attribute is invalid");
  const transformed = transform(value);
  if (!Number.isFinite(transformed))
    throw new DocxImportError("invalid_package", "OOXML numeric attribute is out of range");
  return transformed;
}

function booleanAttribute(element: XmlElement, name: string, fallback: boolean): boolean {
  const value = attribute(element, name);
  return value === undefined ? fallback : parseBooleanLexical(value);
}

function optionalBooleanAttribute(element: XmlElement, name: string): boolean | undefined {
  const value = attribute(element, name);
  return value === undefined ? undefined : parseBooleanLexical(value);
}

function optionalBoolean(element: XmlElement | undefined): boolean | undefined {
  if (!element) return undefined;
  return booleanValue(element, true);
}

function booleanValue(element: XmlElement | undefined, fallback: boolean): boolean {
  if (!element) return fallback;
  const value = valueOf(element);
  return value === undefined ? true : parseBooleanLexical(value);
}

const FALSE_VALUES = new Set(["0", "false", "off", "no"]);
const TRUE_VALUES = new Set(["1", "true", "on", "yes"]);

function parseBooleanLexical(value: string): boolean {
  const normalized = value.toLowerCase();
  if (FALSE_VALUES.has(normalized)) return false;
  if (TRUE_VALUES.has(normalized)) return true;
  throw new DocxImportError("invalid_package", "OOXML boolean value is invalid");
}

function localName(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1);
}

function twipsToPt(value: number): number {
  return value / 20;
}

function stripUndefined<T extends object>(value: object): T {
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
  return value as T;
}

function decodeUtf8(bytes: Uint8Array, description: string, partName?: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DocxImportError(
      partName ? "invalid_xml" : "invalid_zip",
      `${description} is not valid UTF-8`,
      partName,
    );
  }
}

function limitError(message: string, partName?: string): DocxImportError {
  return new DocxImportError("limit_exceeded", message, partName);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOpaqueRelationships(
  left: DocumentOpaqueRelationship,
  right: DocumentOpaqueRelationship,
): number {
  return (
    compareStrings(left.sourcePart, right.sourcePart) ||
    compareStrings(left.type, right.type) ||
    compareStrings(left.targetPart, right.targetPart)
  );
}

function compareOpaqueContentTypes(
  left: DocumentOpaqueContentType,
  right: DocumentOpaqueContentType,
): number {
  return (
    compareStrings(left.partName, right.partName) ||
    compareStrings(left.contentType, right.contentType)
  );
}
