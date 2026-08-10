import { UnsupportedArtifactFeatureError } from "./errors";
import { FileBlob } from "./file-blob";
import { packDocxWithBoundedCompression } from "./document-docx-packer";
import {
  DOCX_MEDIA_TYPE,
  DocumentFidelityError,
  type DocumentDocxExportOptions,
  type DocumentDocxImportOptions,
  type DocumentFidelityIssue,
  type DocumentLossPreservationEnvelope,
  type DocumentOpaqueContent,
} from "./document-docx-api";
import {
  DOCUMENT_LOSS_PRESERVATION,
  documentFidelityReport,
  documentLossPreservationEnvelope,
} from "./document-docx-state";
import {
  DocxImportError,
  importDocx as importDocxDto,
  type ImportedBlock,
  type ImportedComment,
  type ImportedDocument,
  type ImportedHeaderFooter,
  type ImportedBorder,
  type ImportedBoxMeasures,
  type ImportedParagraph,
  type ImportedParagraphStyle,
  type ImportedRunStyle,
  type ImportedSection,
  type ImportedStyle,
  type ImportedTable,
} from "./document-docx-import";
import {
  Document,
  DocumentCommentThread,
  DocumentPageBreak,
  DocumentParagraph,
  DocumentTable,
  DocumentTextRun,
  TrackedChange,
  type DocumentBlock,
  type DocumentPageGeometry,
  type DocumentParagraphStyle,
  type DocumentSection,
  type DocumentSectionStories,
  type DocumentStory,
  type DocumentStoryBlock,
  type DocumentTableStyle,
  type DocumentTextStyle,
} from "./document";

export {
  DOCX_MEDIA_TYPE,
  DocumentFidelityError,
  type DocumentDocxExportOptions,
  type DocumentDocxImportOptions,
  type DocumentFidelityIssue,
  type DocumentLossPreservationEnvelope,
} from "./document-docx-api";
type ParagraphProjection = { source: ImportedParagraph; target: DocumentParagraph };
type ParagraphProjectionMap = Map<string, ParagraphProjection[]>;
type ResolvedImportedStyle = { paragraph: ImportedParagraphStyle; run: ImportedRunStyle };
const importedStyleCache = new WeakMap<object, Map<string, ResolvedImportedStyle>>();

export async function exportDocx(
  document: Document,
  options: DocumentDocxExportOptions = {},
): Promise<FileBlob> {
  validateExportOptions(options);
  document.toJSON();
  const envelope = DOCUMENT_LOSS_PRESERVATION.get(document);
  if (envelope && (await documentModelDigest(document)) === envelope.modelDigest) {
    return FileBlob.fromBytes(envelope.sourceBytes.slice(), {
      type: DOCX_MEDIA_TYPE,
      ...(options.fileName ? { name: options.fileName } : {}),
    });
  }
  const blockingIssues = documentFidelityReport(document).filter(
    (issue) => issue.severity === "error",
  );
  if (blockingIssues.length > 0 && options.unsupportedContent !== "discard") {
    throw new DocumentFidelityError(
      'DOCX export would discard opaque OOXML; export again with unsupportedContent: "discard" only after explicit user acknowledgement',
      blockingIssues,
    );
  }
  const docx = await import("docx");
  const context = buildDocxContext(document, docx);
  const evenAndOddHeaderAndFooters = document.evenAndOddHeaders;
  const sections = document.sections.items.map((section, index) => {
    const end = document.sections.items[index + 1]?.startBlockIndex ?? document.blocks.items.length;
    const blocks = document.blocks.items.slice(section.startBlockIndex, end);
    const landscape = section.page.widthPt > section.page.heightPt;
    return {
      properties: {
        page: {
          size: {
            width: ptToTwip(landscape ? section.page.heightPt : section.page.widthPt),
            height: ptToTwip(landscape ? section.page.widthPt : section.page.heightPt),
            orientation: landscape ? docx.PageOrientation.LANDSCAPE : docx.PageOrientation.PORTRAIT,
          },
          margin: {
            top: ptToTwip(section.page.marginTopPt),
            right: ptToTwip(section.page.marginRightPt),
            bottom: ptToTwip(section.page.marginBottomPt),
            left: ptToTwip(section.page.marginLeftPt),
            header: ptToTwip(section.page.headerPt ?? 36),
            footer: ptToTwip(section.page.footerPt ?? 36),
            gutter: ptToTwip(section.page.gutterPt ?? 0),
          },
        },
        titlePage: section.titlePage,
      },
      headers: buildDocxStories(section.headers, section.page, docx, context),
      footers: buildDocxStories(section.footers, section.page, docx, context),
      children: blocks.map((block) => toDocxBlock(block, section.page, docx, context)),
    };
  });
  const file = new docx.Document({
    sections,
    numbering: { config: numberingConfig(docx) },
    comments: { children: context.commentDefinitions },
    features: { trackRevisions: document.trackRevisions },
    evenAndOddHeaderAndFooters,
    creator: "OpenGeni",
    lastModifiedBy: "OpenGeni",
    revision: document.revision,
  });
  const bytes = await packDocxWithBoundedCompression(file, docx.Packer, [
    {
      path: "docProps/core.xml",
      data: deterministicCoreProperties(document.revision),
    },
  ]);
  return FileBlob.fromBytes(bytes, {
    type: DOCX_MEDIA_TYPE,
    ...(options.fileName ? { name: options.fileName } : {}),
  });
}

export async function importDocx(
  input: FileBlob | Blob | ArrayBuffer,
  options: DocumentDocxImportOptions = {},
): Promise<Document> {
  validateImportOptions(options);
  const sourceBytes = await ownedDocxBytes(input);
  const imported = await importDocxDto(ownedArrayBuffer(sourceBytes), options.limits);
  if (hasOpaqueContent(imported.opaqueContent) && options.unsupportedContent === "error") {
    throw new DocumentFidelityError(
      "The DOCX contains bounded inert OOXML outside the editable document model",
      [opaqueContentIssue(imported.opaqueContent, "error")],
    );
  }
  const document = documentFromImportedDocx(imported, await semanticNamespace(imported));
  if (hasOpaqueContent(imported.opaqueContent)) {
    DOCUMENT_LOSS_PRESERVATION.set(document, {
      sourceBytes,
      sourceDigest: await sha256Hex(sourceBytes),
      importedRevision: document.revision,
      opaqueContent: cloneOpaqueContent(imported.opaqueContent),
      modelDigest: await documentModelDigest(document),
    });
  }
  return document;
}

export function fidelityReport(document: Document): readonly DocumentFidelityIssue[] {
  document.toJSON();
  return documentFidelityReport(document);
}

export function lossPreservationEnvelope(
  document: Document,
): DocumentLossPreservationEnvelope | null {
  document.toJSON();
  return documentLossPreservationEnvelope(document);
}

export async function attachLossPreservationEnvelope(
  document: Document,
  envelope: DocumentLossPreservationEnvelope,
  options: Pick<DocumentDocxImportOptions, "limits"> = {},
): Promise<void> {
  document.toJSON();
  validateAttachOptions(options);
  const normalized = normalizeLossPreservationEnvelope(envelope);
  if (normalized.sourceDigest !== (await sha256Hex(normalized.sourceBytes))) {
    throw new DocxImportError(
      "invalid_package",
      "DOCX loss-preservation source digest does not match its bytes",
    );
  }
  const imported = await importDocxDto(ownedArrayBuffer(normalized.sourceBytes), options.limits);
  if (!sameOpaqueContent(imported.opaqueContent, normalized.opaqueContent)) {
    throw new DocxImportError(
      "invalid_package",
      "DOCX loss-preservation metadata does not match its source package",
    );
  }
  const projected = documentFromImportedDocx(imported, await semanticNamespace(imported));
  const projectedDigest = await documentModelDigest(projected);
  const documentDigest = await documentModelDigest(document);
  if (projectedDigest !== normalized.modelDigest || documentDigest !== normalized.modelDigest) {
    throw new DocxImportError(
      "invalid_package",
      "DOCX loss-preservation envelope belongs to a different document snapshot",
    );
  }
  DOCUMENT_LOSS_PRESERVATION.set(document, {
    sourceBytes: normalized.sourceBytes,
    sourceDigest: normalized.sourceDigest,
    importedRevision: document.revision,
    opaqueContent: normalized.opaqueContent,
    modelDigest: normalized.modelDigest,
  });
}

function documentFromImportedDocx(imported: ImportedDocument, idNamespace: string): Document {
  if (imported.schemaVersion !== 1 || imported.format !== "docx") {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "unknown imported DOCX schema",
      "DOCX import",
    );
  }
  const importedSections = [...imported.sections].sort(
    (left, right) => left.startBlockIndex - right.startBlockIndex,
  );
  validateImportedSections(imported, importedSections);
  const firstSection = importedSections[0];
  if (!firstSection || firstSection.startBlockIndex !== 0)
    throw new Error("Imported DOCX has no section starting at body block 0");
  const document = Document.create({
    page: importedPage(firstSection),
    idNamespace,
    titlePage: firstSection.titlePage,
    evenAndOddHeaders: imported.evenAndOddHeaders,
    trackRevisions: imported.trackRevisions,
  });
  const paragraphMap: ParagraphProjectionMap = new Map();
  const styleMap = new Map(imported.styles.map((style) => [style.styleId, style]));
  const listKinds = importedListKinds(imported.lists);
  let sectionIndex = 1;
  imported.blocks.forEach((block, blockIndex) => {
    while (importedSections[sectionIndex]?.startBlockIndex === blockIndex) {
      document.sections.add({
        page: importedPage(importedSections[sectionIndex]!),
        titlePage: importedSections[sectionIndex]!.titlePage,
      });
      sectionIndex += 1;
    }
    appendImportedBodyBlock(document, block, styleMap, listKinds, paragraphMap);
  });
  while (sectionIndex < importedSections.length) {
    const section = importedSections[sectionIndex]!;
    if (section.startBlockIndex !== imported.blocks.length)
      throw new Error("Imported DOCX section boundary does not align with body blocks");
    if (document.sections.items.at(-1)?.startBlockIndex === imported.blocks.length) {
      throw new UnsupportedArtifactFeatureError(
        "document",
        "multiple empty sections at the same boundary",
        "DOCX import",
      );
    }
    document.sections.add({ page: importedPage(section), titlePage: section.titlePage });
    sectionIndex += 1;
  }
  const headers = new Map(imported.headers.map((story) => [story.partName, story]));
  const footers = new Map(imported.footers.map((story) => [story.partName, story]));
  importedSections.forEach((source, index) => {
    const target = document.sections.items[index];
    if (!target) throw new Error("Imported DOCX section count changed during conversion");
    importSectionStories(
      document,
      source,
      target,
      headers,
      footers,
      styleMap,
      listKinds,
      paragraphMap,
    );
  });
  importComments(document, imported.comments, paragraphMap, styleMap);
  importTrackedChanges(document, imported, paragraphMap);
  validateImportedReviewProjection(document);
  document.toJSON();
  return document;
}

function appendImportedBodyBlock(
  document: Document,
  block: ImportedBlock,
  styles: ReadonlyMap<string, ImportedStyle>,
  listKinds: ReadonlyMap<string, ReadonlyMap<number, "bullet" | "number">>,
  paragraphs: ParagraphProjectionMap,
): void {
  if (block.kind === "pageBreak") {
    document.blocks.addPageBreak();
    return;
  }
  if (block.kind === "paragraph") {
    if (isOnlyPageBreak(block, styles)) {
      document.blocks.addPageBreak();
      return;
    }
    const projected = importedParagraph(block, styles, listKinds);
    const paragraph = document.blocks.addParagraph(projected.runs, projected.style);
    appendMap(paragraphs, block.id, { source: block, target: paragraph });
    return;
  }
  const projected = importedTable(
    block,
    styles,
    listKinds,
    document.sections.items.at(-1)?.page ?? document.page,
  );
  document.blocks.addTable(projected.rows, projected.style);
}

function appendImportedStoryBlock(
  story: DocumentStory,
  block: ImportedBlock,
  document: Document,
  styles: ReadonlyMap<string, ImportedStyle>,
  listKinds: ReadonlyMap<string, ReadonlyMap<number, "bullet" | "number">>,
  paragraphs: ParagraphProjectionMap,
  page: DocumentPageGeometry,
): void {
  if (
    block.kind === "pageBreak" ||
    (block.kind === "paragraph" && block.inlines.some((inline) => inline.kind === "pageBreak"))
  ) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "page breaks in headers or footers",
      "DOCX import",
    );
  }
  if (block.kind === "paragraph") {
    const projected = importedParagraph(block, styles, listKinds);
    const paragraph = story.addParagraph(projected.runs, projected.style);
    appendMap(paragraphs, block.id, { source: block, target: paragraph });
  } else {
    const projected = importedTable(block, styles, listKinds, page);
    story.addTable(projected.rows, projected.style);
  }
}

function importedParagraph(
  source: ImportedParagraph,
  styles: ReadonlyMap<string, ImportedStyle>,
  listKinds: ReadonlyMap<string, ReadonlyMap<number, "bullet" | "number">>,
): { runs: readonly DocumentTextRun[] | string; style: DocumentParagraphStyle } {
  if (source.inlines.some((inline) => inline.kind === "pageBreak")) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "inline page breaks mixed with paragraph text",
      "DOCX import",
    );
  }
  const inherited = resolveImportedStyle(source.styleId, styles, "paragraph");
  const paragraphStyle = mapImportedParagraphStyle(
    { ...inherited.paragraph, ...source.style },
    source.styleId,
    listKinds,
  );
  const runs = source.inlines.map((inline) => {
    if (inline.kind !== "run") throw new Error("Unexpected non-run in imported paragraph");
    const inheritedRun = resolveImportedStyle(inline.styleId, styles, "character").run;
    return new DocumentTextRun(
      inline.text,
      mapImportedRunStyle({ ...inherited.run, ...inheritedRun, ...inline.style }),
    );
  });
  return { runs: runs.length > 0 ? runs : "", style: paragraphStyle };
}

function importedTable(
  source: ImportedTable,
  styles: ReadonlyMap<string, ImportedStyle>,
  listKinds: ReadonlyMap<string, ReadonlyMap<number, "bullet" | "number">>,
  page: DocumentPageGeometry,
): {
  rows: ReadonlyArray<ReadonlyArray<readonly DocumentTextRun[]>>;
  style: DocumentTableStyle;
} {
  if (source.rows.length === 0 || source.rows.some((row) => row.cells.length === 0))
    throw new Error("Imported DOCX table is empty");
  if (source.styleId) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      `table style ${source.styleId}`,
      "DOCX import",
    );
  }
  const columnCount = source.rows[0]!.cells.length;
  if (source.rows.some((row) => row.cells.length !== columnCount)) {
    throw new UnsupportedArtifactFeatureError("document", "ragged DOCX tables", "DOCX import");
  }
  const headerRows = source.rows.findIndex((row) => !row.header);
  const normalizedHeaderRows = headerRows < 0 ? source.rows.length : headerRows;
  if (source.rows.slice(normalizedHeaderRows).some((row) => row.header)) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "non-contiguous repeating table headers",
      "DOCX import",
    );
  }
  const cannotSplit = source.rows[0]!.cannotSplit;
  if (source.rows.some((row) => row.cannotSplit !== cannotSplit)) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "mixed table row-splitting policies",
      "DOCX import",
    );
  }
  if (source.rows.some((row) => row.heightPt !== undefined || row.heightRule !== undefined)) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "explicit table row heights",
      "DOCX import",
    );
  }
  let headerFill: string | undefined;
  let filledHeaderCells = 0;
  let unfilledHeaderCells = 0;
  const rows = source.rows.map((row, rowIndex) =>
    row.cells.map((cell, columnIndex) => {
      if (cell.columnSpan !== 1 || cell.verticalMerge !== undefined) {
        throw new UnsupportedArtifactFeatureError(
          "document",
          "merged DOCX table cells",
          "DOCX import",
        );
      }
      if (cell.verticalAlignment !== "center") {
        throw new UnsupportedArtifactFeatureError(
          "document",
          `table cell vertical alignment ${cell.verticalAlignment ?? "default"}`,
          "DOCX import",
        );
      }
      if (cell.blocks.length !== 1 || cell.blocks[0]?.kind !== "paragraph") {
        throw new UnsupportedArtifactFeatureError(
          "document",
          "multi-paragraph or nested DOCX table cells",
          "DOCX import",
        );
      }
      const explicitFill =
        cell.fill && cell.fill.toLowerCase() !== "auto" ? normalizeHex(cell.fill) : undefined;
      if (explicitFill) {
        if (rowIndex >= normalizedHeaderRows) {
          throw new UnsupportedArtifactFeatureError("document", "body cell shading", "DOCX import");
        }
        if (headerFill && headerFill !== explicitFill) {
          throw new UnsupportedArtifactFeatureError(
            "document",
            "mixed table-header fills",
            "DOCX import",
          );
        }
        headerFill = explicitFill;
        filledHeaderCells += 1;
      } else if (rowIndex < normalizedHeaderRows) {
        unfilledHeaderCells += 1;
      }
      const paragraph = cell.blocks[0];
      if (
        paragraph.inlines.some((inline) => inline.kind === "pageBreak") ||
        paragraph.commentAnchors.length > 0
      ) {
        throw new UnsupportedArtifactFeatureError(
          "document",
          "page breaks or comments in table cells",
          "DOCX import",
        );
      }
      const inherited = resolveImportedStyle(paragraph.styleId, styles, "paragraph");
      assertRepresentableTableCellParagraph(
        { ...inherited.paragraph, ...paragraph.style },
        paragraph.styleId,
        listKinds,
      );
      if (cell.width) {
        const expected = source.gridColumnWidthsPt[columnIndex];
        if (
          cell.width.unit !== "pt" ||
          expected === undefined ||
          Math.abs(cell.width.value - expected) > 0.05
        ) {
          throw new UnsupportedArtifactFeatureError(
            "document",
            "table cell widths inconsistent with the fixed column grid",
            "DOCX import",
          );
        }
      }
      return paragraph.inlines.map((inline) => {
        if (inline.kind !== "run") throw new Error("Unexpected non-run in imported table cell");
        if (inline.changeId)
          throw new UnsupportedArtifactFeatureError(
            "document",
            "tracked changes in table cells",
            "DOCX import",
          );
        const runStyle = resolveImportedStyle(inline.styleId, styles, "character").run;
        return new DocumentTextRun(
          inline.text,
          mapImportedRunStyle({ ...inherited.run, ...runStyle, ...inline.style }),
        );
      });
    }),
  );
  if (filledHeaderCells > 0 && unfilledHeaderCells > 0) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "partially shaded table-header rows",
      "DOCX import",
    );
  }
  const usable = page.widthPt - page.marginLeftPt - page.marginRightPt;
  if (
    source.gridColumnWidthsPt.length > 0 &&
    (source.gridColumnWidthsPt.length !== columnCount ||
      source.gridColumnWidthsPt.some((width) => !Number.isFinite(width) || width <= 0))
  ) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "invalid or incomplete fixed table column grid",
      "DOCX import",
    );
  }
  const widths =
    source.gridColumnWidthsPt.length === columnCount ? source.gridColumnWidthsPt : undefined;
  const widthPt =
    source.width?.unit === "pt"
      ? source.width.value
      : (widths?.reduce((total, width) => total + width, 0) ?? usable);
  if (source.width && source.width.unit !== "pt" && source.width.unit !== "auto") {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "percentage-width DOCX tables",
      "DOCX import",
    );
  }
  if (
    source.width?.unit === "pt" &&
    widths &&
    Math.abs(source.width.value - widths.reduce((total, width) => total + width, 0)) > 0.05
  ) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "table width inconsistent with its fixed column grid",
      "DOCX import",
    );
  }
  if (source.alignment && source.alignment !== "left" && source.alignment !== "start") {
    throw new UnsupportedArtifactFeatureError(
      "document",
      `table alignment ${source.alignment}`,
      "DOCX import",
    );
  }
  if (source.layout !== "fixed") {
    throw new UnsupportedArtifactFeatureError("document", "autofit DOCX tables", "DOCX import");
  }
  const cellPaddingPt = importedUniformCellPadding(source);
  const borderColor = importedUniformTableBorder(source.borders);
  if (
    !source.indent ||
    source.indent.unit !== "pt" ||
    Math.abs(source.indent.value - cellPaddingPt) > 0.01
  ) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "table indent not equal to its leading cell padding",
      "DOCX import",
    );
  }
  return {
    rows,
    style: {
      widthPt,
      ...(widths ? { columnWidthsPt: [...widths] } : {}),
      headerRows: normalizedHeaderRows,
      cellPaddingPt,
      borderColor,
      ...(headerFill ? { headerFill } : {}),
      ...(!cannotSplit ? { allowRowSplit: true } : {}),
    },
  };
}

function importSectionStories(
  document: Document,
  source: ImportedSection,
  target: DocumentSection,
  headers: ReadonlyMap<string, ImportedHeaderFooter>,
  footers: ReadonlyMap<string, ImportedHeaderFooter>,
  styles: ReadonlyMap<string, ImportedStyle>,
  listKinds: ReadonlyMap<string, ReadonlyMap<number, "bullet" | "number">>,
  paragraphs: ParagraphProjectionMap,
): void {
  const apply = (
    references: ImportedSection["headers"],
    available: ReadonlyMap<string, ImportedHeaderFooter>,
    stories: DocumentSectionStories,
  ): void => {
    for (const reference of references) {
      const key =
        reference.kind === "default"
          ? "default"
          : reference.kind === "first"
            ? "first"
            : reference.kind === "even"
              ? "even"
              : undefined;
      if (!key)
        throw new UnsupportedArtifactFeatureError(
          "document",
          `header/footer variant ${reference.kind}`,
          "DOCX import",
        );
      const importedStory = available.get(reference.partName);
      if (!importedStory)
        throw new Error(`Imported DOCX references missing story ${reference.partName}`);
      const story = stories[key];
      if (story.items.length > 0)
        throw new Error(`Imported DOCX repeats ${key} header/footer for one section`);
      if (isEmptyStoryPlaceholder(importedStory)) continue;
      for (const block of importedStory.blocks)
        appendImportedStoryBlock(
          story,
          block,
          document,
          styles,
          listKinds,
          paragraphs,
          target.page,
        );
    }
  };
  apply(source.headers, headers, target.headers);
  apply(source.footers, footers, target.footers);
}

function isEmptyStoryPlaceholder(story: ImportedHeaderFooter): boolean {
  const block = story.blocks[0];
  return (
    story.blocks.length === 1 &&
    block?.kind === "paragraph" &&
    block.styleId === undefined &&
    Object.keys(block.style).length === 0 &&
    block.commentAnchors.length === 0 &&
    block.inlines.every(
      (inline) =>
        inline.kind === "run" &&
        inline.text.length === 0 &&
        inline.styleId === undefined &&
        Object.keys(inline.style).length === 0,
    )
  );
}

function importComments(
  document: Document,
  comments: readonly ImportedComment[],
  paragraphs: ReadonlyMap<string, readonly ParagraphProjection[]>,
  styles: ReadonlyMap<string, ImportedStyle>,
): void {
  type ExtendedComment = ImportedComment & { parentId?: string; resolved?: boolean };
  const byId = new Map(comments.map((comment) => [comment.id, comment as ExtendedComment]));
  const roots: ExtendedComment[] = [];
  const repliesByParent = new Map<string, ExtendedComment[]>();
  for (const raw of comments) {
    const comment = raw as ExtendedComment;
    if (comment.parentId === undefined) roots.push(comment);
    else appendMap(repliesByParent, comment.parentId, comment);
  }
  const anchorsByComment = new Map<
    string,
    Array<{
      source: ImportedParagraph;
      target: DocumentParagraph;
      start: number;
      end: number;
    }>
  >();
  // Build one review index. The previous root-by-paragraph scan was bounded,
  // but still quadratic for a large legitimate document with many comments.
  for (const projections of paragraphs.values()) {
    for (const { source, target } of projections) {
      const anchors = new Map<string, ImportedParagraph["commentAnchors"]>();
      for (const anchor of source.commentAnchors) appendMap(anchors, anchor.commentId, anchor);
      for (const [commentId, values] of anchors) {
        const start =
          values.find((anchor) => anchor.kind === "start")?.textOffset ??
          values.find((anchor) => anchor.kind === "reference")?.textOffset;
        const end = values.find((anchor) => anchor.kind === "end")?.textOffset ?? start;
        if (start === undefined || end === undefined) {
          throw new Error(`Imported comment ${commentId} has an incomplete anchor`);
        }
        appendMap(anchorsByComment, commentId, { source, target, start, end });
      }
    }
  }
  for (const root of roots) {
    const matches = anchorsByComment.get(root.id) ?? [];
    const sourceIds = new Set(matches.map((match) => match.source.id));
    if (matches.length === 0 || sourceIds.size !== 1)
      throw new Error(`Imported comment ${root.id} must have exactly one source text anchor`);
    if (matches.length > 1) {
      throw new UnsupportedArtifactFeatureError(
        "document",
        "comments in shared or inherited header/footer stories",
        "DOCX import",
      );
    }
    const rootText = importedCommentText(root, styles);
    assertRepresentableCommentInitials(root.author ?? "Unknown", root.initials);
    const replies = repliesByParent.get(root.id) ?? [];
    for (const match of matches) {
      const thread = document.comments.addThread(
        { block: match.target, start: match.start, end: match.end },
        rootText,
        {
          author: root.author ?? "Unknown",
          createdAt: normalizedImportedDate(root.createdAt),
          resolved: root.resolved ?? false,
        },
      );
      for (const reply of replies) {
        assertRepresentableCommentInitials(reply.author ?? "Unknown", reply.initials);
        thread.addReply(
          importedCommentText(reply, styles),
          reply.author ?? "Unknown",
          normalizedImportedDate(reply.createdAt),
        );
      }
    }
    byId.delete(root.id);
    for (const reply of replies) byId.delete(reply.id);
  }
  if (byId.size > 0)
    throw new Error(`Imported DOCX has orphaned comment replies: ${[...byId.keys()].join(", ")}`);
}

function importTrackedChanges(
  document: Document,
  imported: ImportedDocument,
  paragraphs: ReadonlyMap<string, readonly ParagraphProjection[]>,
): void {
  for (const source of imported.trackedChanges) {
    const projections = paragraphs.get(source.blockId);
    if (!projections || projections.length === 0)
      throw new UnsupportedArtifactFeatureError(
        "document",
        "tracked changes outside body/header/footer paragraphs",
        "DOCX import",
      );
    if (projections.length > 1) {
      throw new UnsupportedArtifactFeatureError(
        "document",
        "tracked changes in shared or inherited header/footer stories",
        "DOCX import",
      );
    }
    const extended = source as typeof source & { startTextOffset?: number; endTextOffset?: number };
    for (const paragraph of projections) {
      const start =
        extended.startTextOffset ??
        inlineIndexToTextOffset(paragraph.source, source.startInlineIndex);
      const end =
        extended.endTextOffset ?? inlineIndexToTextOffset(paragraph.source, source.endInlineIndex);
      document.changes.add(
        { block: paragraph.target, start, end },
        source.kind,
        source.author ?? "Unknown",
        normalizedImportedDate(source.createdAt),
      );
    }
  }
}

function validateImportedReviewProjection(document: Document): void {
  const commentsByBlock = new Map<string, DocumentCommentThread[]>();
  for (const comment of document.comments.items) {
    appendMap(commentsByBlock, comment.blockId, comment);
  }
  const changesByBlock = new Map<string, TrackedChange[]>();
  for (const change of document.changes.items) {
    appendMap(changesByBlock, change.blockId, change);
  }
  for (const block of document.allStoryBlocks()) {
    if (!(block instanceof DocumentParagraph)) continue;
    const comments = commentsByBlock.get(block.id) ?? [];
    const changes = changesByBlock.get(block.id) ?? [];
    validateNonCrossingComments(comments);
    validateNonOverlappingChanges(changes);
    validateReviewMarkupForDocx(block, comments, changes);
  }
}

function resolveImportedStyle(
  styleId: string | undefined,
  styles: ReadonlyMap<string, ImportedStyle>,
  expectedKind: "paragraph" | "character",
  seen = new Set<string>(),
  applyDefault = true,
): ResolvedImportedStyle {
  const cacheKey = `${expectedKind}:${applyDefault ? "default" : "direct"}:${styleId ?? ""}`;
  const cache =
    importedStyleCache.get(styles as object) ?? new Map<string, ResolvedImportedStyle>();
  if (!importedStyleCache.has(styles as object)) importedStyleCache.set(styles as object, cache);
  if (seen.size === 0) {
    const cached = cache.get(cacheKey);
    if (cached) return cached;
  }
  if (!styleId) {
    if (!applyDefault) {
      const empty = { paragraph: {}, run: {} };
      if (seen.size === 0) cache.set(cacheKey, empty);
      return empty;
    }
    const defaults = [...styles.values()].filter(
      (style) => style.isDefault && style.kind === expectedKind,
    );
    if (defaults.length > 1) {
      throw new Error(`Imported DOCX defines multiple default ${expectedKind} styles`);
    }
    const defaultStyle = defaults[0];
    const resolved = defaultStyle
      ? resolveImportedStyle(defaultStyle.styleId, styles, expectedKind, seen, false)
      : { paragraph: {}, run: {} };
    if (seen.size === 0) cache.set(cacheKey, resolved);
    return resolved;
  }
  if (seen.has(styleId)) throw new Error(`Imported DOCX style cycle at ${styleId}`);
  const style = styles.get(styleId);
  if (!style) {
    if (["Normal", "DefaultParagraphFont", "ListParagraph"].includes(styleId)) {
      return { paragraph: {}, run: {} };
    }
    throw new Error(`Imported DOCX references missing style ${styleId}`);
  }
  if (style.kind !== expectedKind) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      `${expectedKind} content using ${style.kind} style ${styleId}`,
      "DOCX import",
    );
  }
  const canonical =
    expectedKind === "paragraph"
      ? styleId === "Normal" ||
        styleId === "ListParagraph" ||
        /^(?:Heading\s*)[1-6]$/iu.test(styleId)
      : styleId === "DefaultParagraphFont";
  if (!canonical) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      `custom named ${expectedKind} style ${styleId}`,
      "DOCX import",
    );
  }
  seen.add(styleId);
  const parent = resolveImportedStyle(style.basedOn, styles, expectedKind, seen, false);
  seen.delete(styleId);
  const resolved = {
    paragraph: { ...parent.paragraph, ...style.paragraph },
    run: { ...parent.run, ...style.run },
  };
  if (seen.size === 0) cache.set(cacheKey, resolved);
  return resolved;
}

function mapImportedParagraphStyle(
  style: ImportedParagraphStyle,
  styleId: string | undefined,
  listKinds: ReadonlyMap<string, ReadonlyMap<number, "bullet" | "number">>,
): DocumentParagraphStyle {
  if (style.bidirectional)
    throw new UnsupportedArtifactFeatureError(
      "document",
      "bidirectional paragraphs",
      "DOCX import",
    );
  if (
    (style.indentLeftPt ?? 0) !== 0 ||
    (style.indentRightPt ?? 0) !== 0 ||
    (style.firstLinePt ?? 0) !== 0 ||
    (style.hangingPt ?? 0) !== 0
  ) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "direct paragraph indentation",
      "DOCX import",
    );
  }
  if (style.keepLines)
    throw new UnsupportedArtifactFeatureError(
      "document",
      "keep-lines paragraph pagination",
      "DOCX import",
    );
  if (style.lineRule && style.lineRule !== "auto")
    throw new UnsupportedArtifactFeatureError(
      "document",
      `paragraph line rule ${style.lineRule}`,
      "DOCX import",
    );
  const headingMatch = /(?:^|\s)heading\s*([1-6])$/iu.exec(styleId ?? "");
  const importedHeadingLevel = headingMatch
    ? (Number(headingMatch[1]) as 1 | 2 | 3 | 4 | 5 | 6)
    : undefined;
  if (
    style.outlineLevel !== undefined &&
    (style.outlineLevel < 0 ||
      style.outlineLevel > 5 ||
      importedHeadingLevel === undefined ||
      style.outlineLevel + 1 !== importedHeadingLevel)
  ) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      `outline level ${style.outlineLevel} without the matching supported heading style`,
      "DOCX import",
    );
  }
  const alignmentValue =
    style.alignment === "both"
      ? "justify"
      : style.alignment === "center"
        ? "center"
        : style.alignment === "right" || style.alignment === "end"
          ? "right"
          : style.alignment === "left" || style.alignment === "start"
            ? "left"
            : undefined;
  if (style.alignment && !alignmentValue)
    throw new UnsupportedArtifactFeatureError(
      "document",
      `paragraph alignment ${style.alignment}`,
      "DOCX import",
    );
  const list = style.list;
  const listKind = list ? listKinds.get(list.numId)?.get(list.level) : undefined;
  if (list && !listKind)
    throw new Error(`Imported paragraph references missing numbering ${list.numId}/${list.level}`);
  return {
    ...(importedHeadingLevel ? { headingLevel: importedHeadingLevel } : {}),
    ...(alignmentValue ? { alignment: alignmentValue } : {}),
    ...(style.spaceBeforePt !== undefined ? { spaceBeforePt: style.spaceBeforePt } : {}),
    ...(style.spaceAfterPt !== undefined ? { spaceAfterPt: style.spaceAfterPt } : {}),
    ...(style.line !== undefined ? { lineHeight: style.line / 240 } : {}),
    ...(style.keepNext !== undefined ? { keepNext: style.keepNext } : {}),
    ...(style.pageBreakBefore !== undefined ? { pageBreakBefore: style.pageBreakBefore } : {}),
    ...(list && listKind
      ? { list: { kind: listKind, level: list.level, instanceId: list.numId } }
      : {}),
  };
}

function mapImportedRunStyle(style: ImportedRunStyle): DocumentTextStyle {
  if (style.highlight && style.highlight !== "none")
    throw new UnsupportedArtifactFeatureError("document", "text highlighting", "DOCX import");
  if (style.verticalAlign && style.verticalAlign !== "baseline")
    throw new UnsupportedArtifactFeatureError(
      "document",
      `text vertical alignment ${style.verticalAlign}`,
      "DOCX import",
    );
  if (
    style.fontSizeComplexScriptPt !== undefined &&
    style.fontSizeComplexScriptPt !== style.fontSizePt
  ) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "script-specific font sizing",
      "DOCX import",
    );
  }
  if ((style.boldComplexScript ?? false) !== (style.bold ?? false)) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "script-specific bold formatting",
      "DOCX import",
    );
  }
  if ((style.italicComplexScript ?? false) !== (style.italic ?? false)) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "script-specific italic formatting",
      "DOCX import",
    );
  }
  if (style.language) {
    throw new UnsupportedArtifactFeatureError("document", "run language metadata", "DOCX import");
  }
  return {
    ...(style.fontFamily ? { fontFamily: style.fontFamily } : {}),
    ...(style.fontSizePt !== undefined ? { fontSizePt: style.fontSizePt } : {}),
    ...(style.color && style.color !== "auto" ? { color: normalizeHex(style.color) } : {}),
    ...(style.bold !== undefined ? { bold: style.bold } : {}),
    ...(style.italic !== undefined ? { italic: style.italic } : {}),
    ...(style.underline !== undefined ? { underline: style.underline !== "none" } : {}),
    ...(style.strike !== undefined ? { strike: style.strike } : {}),
  };
}

function importedPage(section: ImportedSection): DocumentPageGeometry {
  return {
    widthPt: section.page.widthPt,
    heightPt: section.page.heightPt,
    marginTopPt: section.page.marginTopPt,
    marginRightPt: section.page.marginRightPt,
    marginBottomPt: section.page.marginBottomPt,
    marginLeftPt: section.page.marginLeftPt,
    headerPt: section.page.headerPt,
    footerPt: section.page.footerPt,
    gutterPt: section.page.gutterPt,
  };
}

function validateImportedSections(
  imported: ImportedDocument,
  sections: readonly ImportedSection[],
): void {
  if (sections.length === 0) throw new Error("Imported DOCX has no sections");
  const storyReferences = new Set<string>();
  let expectedStart = 0;
  for (const section of sections) {
    for (const reference of [...section.headers, ...section.footers]) {
      if (storyReferences.has(reference.partName)) {
        throw new UnsupportedArtifactFeatureError(
          "document",
          "linked or inherited header/footer stories",
          "DOCX import",
        );
      }
      storyReferences.add(reference.partName);
    }
    if (
      section.startBlockIndex !== expectedStart ||
      !Number.isSafeInteger(section.endBlockIndex) ||
      section.endBlockIndex < section.startBlockIndex ||
      section.endBlockIndex > imported.blocks.length
    ) {
      throw new Error("Imported DOCX sections do not form a contiguous body partition");
    }
    expectedStart = section.endBlockIndex;
    if (section.type !== undefined && section.type !== "nextPage") {
      throw new UnsupportedArtifactFeatureError(
        "document",
        `section break type ${section.type}`,
        "DOCX import",
      );
    }
    const orientation = section.page.orientation;
    if (orientation !== undefined && orientation !== "portrait" && orientation !== "landscape") {
      throw new UnsupportedArtifactFeatureError(
        "document",
        `page orientation ${orientation}`,
        "DOCX import",
      );
    }
    if (
      (orientation === "landscape" && section.page.widthPt < section.page.heightPt) ||
      (orientation === "portrait" && section.page.widthPt > section.page.heightPt)
    ) {
      throw new UnsupportedArtifactFeatureError(
        "document",
        "page dimensions inconsistent with page orientation",
        "DOCX import",
      );
    }
    const hasFirstStory = [...section.headers, ...section.footers].some(
      (reference) => reference.kind === "first",
    );
    if (section.titlePage && !hasFirstStory) {
      throw new UnsupportedArtifactFeatureError(
        "document",
        "first-page header/footer mode without a representable first-page story",
        "DOCX import",
      );
    }
  }
  if (expectedStart !== imported.blocks.length) {
    throw new Error("Imported DOCX sections do not cover the full body");
  }
  const hasEvenStory = sections.some((section) =>
    [...section.headers, ...section.footers].some((reference) => reference.kind === "even"),
  );
  if (imported.evenAndOddHeaders && !hasEvenStory) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "even-page header/footer mode without a representable even-page story",
      "DOCX import",
    );
  }
}

function importedListKinds(
  lists: readonly ImportedDocument["lists"][number][],
): Map<string, Map<number, "bullet" | "number">> {
  const result = new Map<string, Map<number, "bullet" | "number">>();
  for (const list of lists) {
    let instanceSupported = true;
    for (const override of list.overrides) {
      if (override.definition || (override.start !== undefined && override.start !== 1)) {
        instanceSupported = false;
      }
    }
    const levels = new Map<number, "bullet" | "number">();
    let definitionSupported = true;
    for (const level of list.levels) {
      if (
        level.start !== 1 ||
        level.restart !== undefined ||
        level.legal !== undefined ||
        (level.format !== "bullet" && level.format !== "decimal")
      ) {
        definitionSupported = false;
        continue;
      }
      const runtimeLevel = level as typeof level & { alignment?: string };
      const expectedText = level.format === "decimal" ? `%${level.level + 1}.` : undefined;
      const supportedBullet =
        level.format === "bullet" && level.text === ["•", "◦", "▪"][level.level % 3];
      const paragraphEntries = Object.entries(level.paragraph);
      const hasExpectedIndent =
        level.paragraph.indentLeftPt !== undefined &&
        Math.abs(level.paragraph.indentLeftPt - 36 * (level.level + 1)) <= 0.01 &&
        level.paragraph.hangingPt !== undefined &&
        Math.abs(level.paragraph.hangingPt - 18) <= 0.01;
      const onlyExpectedIndent = paragraphEntries.every(
        ([key]) => key === "indentLeftPt" || key === "hangingPt",
      );
      if (
        (level.format === "decimal" && level.text !== expectedText) ||
        (level.format === "bullet" && !supportedBullet) ||
        (level.suffix !== undefined && level.suffix !== "tab") ||
        level.paragraphStyleId !== undefined ||
        (runtimeLevel.alignment !== undefined && runtimeLevel.alignment !== "left") ||
        !hasExpectedIndent ||
        !onlyExpectedIndent ||
        Object.keys(level.run).length > 0
      ) {
        definitionSupported = false;
        continue;
      }
      levels.set(level.level, level.format === "bullet" ? "bullet" : "number");
    }
    result.set(list.numId, instanceSupported && definitionSupported ? levels : new Map());
  }
  return result;
}

function assertRepresentableTableCellParagraph(
  style: ImportedParagraphStyle,
  styleId: string | undefined,
  listKinds: ReadonlyMap<string, ReadonlyMap<number, "bullet" | "number">>,
): void {
  const projected = mapImportedParagraphStyle(style, styleId, listKinds);
  const remaining = Object.entries(projected).filter(
    ([key, value]) =>
      !(
        (key === "alignment" && value === "left") ||
        (key === "spaceBeforePt" && value === 0) ||
        (key === "spaceAfterPt" && value === 0)
      ),
  );
  if (remaining.length > 0) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "paragraph formatting inside table cells",
      "DOCX import",
    );
  }
}

function importedUniformCellPadding(source: ImportedTable): number {
  const hasExplicitMargins =
    source.cellMargins !== undefined ||
    source.rows.some((row) => row.cells.some((cell) => cell.margins !== undefined));
  if (!hasExplicitMargins) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "table cell padding inherited from an unrepresented style",
      "DOCX import",
    );
  }
  const values: number[] = [];
  for (const row of source.rows) {
    for (const cell of row.cells) {
      for (const side of ["top", "right", "bottom", "left"] as const) {
        const measure = boxMeasure(cell.margins, side) ?? boxMeasure(source.cellMargins, side);
        if (!measure || measure.unit !== "pt" || !Number.isFinite(measure.value)) {
          throw new UnsupportedArtifactFeatureError(
            "document",
            "asymmetric or non-point table cell margins",
            "DOCX import",
          );
        }
        values.push(measure.value);
      }
    }
  }
  const first = values[0];
  if (first === undefined || values.some((value) => Math.abs(value - first) > 0.01)) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "non-uniform table cell padding",
      "DOCX import",
    );
  }
  return first;
}

function boxMeasure(
  box: ImportedBoxMeasures | undefined,
  side: "top" | "right" | "bottom" | "left",
): { value: number; unit: "pt" | "percent" | "auto" } | undefined {
  if (!box) return undefined;
  if (side === "left") return box.left ?? box.start;
  if (side === "right") return box.right ?? box.end;
  return box[side];
}

function importedUniformTableBorder(borders: ImportedTable["borders"]): string {
  if (!borders) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "table borders inherited from an unrepresented style",
      "DOCX import",
    );
  }
  const edges: Array<ImportedBorder | undefined> = [
    borders.top,
    borders.right,
    borders.bottom,
    borders.left,
    borders.insideHorizontal,
    borders.insideVertical,
  ];
  if (edges.some((edge) => edge === undefined)) {
    throw new UnsupportedArtifactFeatureError("document", "partial table borders", "DOCX import");
  }
  const colors = edges.map((edge) => {
    if (
      edge?.style !== "single" ||
      edge.sizePt === undefined ||
      Math.abs(edge.sizePt - 0.5) > 0.01 ||
      (edge.spacePt ?? 0) !== 0 ||
      edge.shadow === true ||
      edge.frame === true ||
      !edge.color ||
      edge.color.toLowerCase() === "auto"
    ) {
      throw new UnsupportedArtifactFeatureError(
        "document",
        "non-uniform or decorated table borders",
        "DOCX import",
      );
    }
    return normalizeHex(edge.color);
  });
  const first = colors[0]!;
  if (colors.some((color) => color !== first)) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "mixed table border colors",
      "DOCX import",
    );
  }
  return first;
}

function isOnlyPageBreak(
  paragraph: ImportedParagraph,
  styles: ReadonlyMap<string, ImportedStyle>,
): boolean {
  const inherited = resolveImportedStyle(paragraph.styleId, styles, "paragraph");
  return (
    paragraph.inlines.length === 1 &&
    paragraph.inlines[0]?.kind === "pageBreak" &&
    paragraph.commentAnchors.length === 0 &&
    Object.keys({ ...inherited.paragraph, ...paragraph.style }).length === 0 &&
    Object.keys(inherited.run).length === 0
  );
}

function importedCommentText(
  comment: ImportedComment,
  styles: ReadonlyMap<string, ImportedStyle>,
): string {
  const paragraph = comment.blocks[0];
  if (
    comment.blocks.length !== 1 ||
    paragraph?.kind !== "paragraph" ||
    paragraph.styleId !== undefined ||
    Object.keys(paragraph.style).length > 0 ||
    paragraph.inlines.some(
      (inline) =>
        inline.kind !== "run" ||
        inline.styleId !== undefined ||
        Object.keys(inline.style).length > 0,
    ) ||
    paragraph.commentAnchors.length > 0
  ) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "multi-paragraph or formatted content inside comments",
      "DOCX import",
    );
  }
  // Resolve defaults solely to detect a formatted default that would otherwise
  // be silently flattened from this deliberately plain comment subset.
  const defaults = resolveImportedStyle(undefined, styles, "paragraph");
  if (Object.keys(defaults.paragraph).length > 0 || Object.keys(defaults.run).length > 0) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "formatted default style inside comments",
      "DOCX import",
    );
  }
  return paragraph.inlines.map((inline) => (inline.kind === "run" ? inline.text : "")).join("");
}

function inlineIndexToTextOffset(paragraph: ImportedParagraph, index: number): number {
  if (!Number.isInteger(index) || index < 0 || index > paragraph.inlines.length)
    throw new Error("Imported tracked-change inline index is invalid");
  return paragraph.inlines
    .slice(0, index)
    .reduce((total, inline) => total + (inline.kind === "run" ? inline.text.length : 0), 0);
}

function normalizedImportedDate(value: string | undefined): string {
  if (!value) {
    throw new UnsupportedArtifactFeatureError(
      "document",
      "comment or tracked-change timestamp omitted",
      "DOCX import",
    );
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new Error(`Imported DOCX contains an invalid timestamp: ${value}`);
  return date.toISOString();
}

type DocxModule = typeof import("docx");
type DocxBlock = import("docx").Paragraph | import("docx").Table;
type DocxParagraphChild = import("docx").ParagraphChild;
type DocxContext = {
  readonly commentsByBlock: Map<
    string,
    Array<{ thread: DocumentCommentThread; numericId: number }>
  >;
  readonly changesByBlock: Map<string, Array<{ change: TrackedChange; numericId: number }>>;
  readonly commentDefinitions: import("docx").ICommentOptions[];
  readonly listInstances: Map<string, number>;
};

function buildDocxContext(document: Document, docx: DocxModule): DocxContext {
  const commentsByBlock = new Map<
    string,
    Array<{ thread: DocumentCommentThread; numericId: number }>
  >();
  const commentDefinitions: import("docx").ICommentOptions[] = [];
  let commentId = 0;
  for (const thread of document.comments.items) {
    const rootId = commentId++;
    appendMap(commentsByBlock, thread.blockId, { thread, numericId: rootId });
    thread.replies.forEach((reply, index) => {
      const id = index === 0 ? rootId : commentId++;
      commentDefinitions.push({
        id,
        ...(index > 0 ? { parentId: rootId } : {}),
        author: reply.author,
        initials: initials(reply.author),
        date: new Date(reply.createdAt),
        ...(index === 0 ? { resolved: thread.resolved } : {}),
        children: [
          new docx.Paragraph({
            children: [new docx.TextRun(docxTextRunOptions(reply.text, {}, docx))],
          }),
        ],
      });
    });
  }
  const changesByBlock = new Map<string, Array<{ change: TrackedChange; numericId: number }>>();
  document.changes.items.forEach((change, numericId) =>
    appendMap(changesByBlock, change.blockId, { change, numericId }),
  );
  return {
    commentsByBlock,
    changesByBlock,
    commentDefinitions,
    listInstances: buildListInstances(document),
  };
}

function buildDocxStories(
  stories: DocumentSectionStories,
  page: DocumentPageGeometry,
  docx: DocxModule,
  context: DocxContext,
): {
  default?: import("docx").Header | import("docx").Footer;
  first?: import("docx").Header | import("docx").Footer;
  even?: import("docx").Header | import("docx").Footer;
} {
  const make = (
    story: DocumentStory,
    emitEmpty: boolean,
  ): import("docx").Header | import("docx").Footer | undefined => {
    if (story.items.length === 0 && !emitEmpty) return undefined;
    const children =
      story.items.length > 0
        ? story.items.map((block) => toDocxBlock(block, page, docx, context))
        : [new docx.Paragraph({ children: [] })];
    return story.kind === "header" ? new docx.Header({ children }) : new docx.Footer({ children });
  };
  const result: {
    default?: import("docx").Header | import("docx").Footer;
    first?: import("docx").Header | import("docx").Footer;
    even?: import("docx").Header | import("docx").Footer;
  } = {};
  // Emit explicit empty variants as well as authored ones. Omitting a part
  // means "inherit from the prior section" in Word, which is not equivalent
  // to this model's intentionally empty editable story.
  const defaultStory = make(stories.default, true);
  const firstStory = make(stories.first, true);
  const evenStory = make(stories.even, true);
  if (defaultStory) result.default = defaultStory;
  if (firstStory) result.first = firstStory;
  if (evenStory) result.even = evenStory;
  return result;
}

function toDocxBlock(
  block: DocumentBlock | DocumentStoryBlock,
  page: DocumentPageGeometry,
  docx: DocxModule,
  context: DocxContext,
): DocxBlock {
  if (block instanceof DocumentPageBreak) {
    return new docx.Paragraph({ children: [new docx.PageBreak()] });
  }
  if (block instanceof DocumentTable) return toDocxTable(block, page, docx);
  const heading = headingLevel(block.style.headingLevel, docx);
  const paragraphAlignment = alignment(block.style.alignment, docx);
  const spacing = {
    ...(block.style.spaceBeforePt !== undefined
      ? { before: ptToTwip(block.style.spaceBeforePt) }
      : {}),
    ...(block.style.spaceAfterPt !== undefined
      ? { after: ptToTwip(block.style.spaceAfterPt) }
      : {}),
    ...(block.style.lineHeight !== undefined
      ? { line: Math.round(block.style.lineHeight * 240) }
      : {}),
  };
  const list = block.style.list;
  return new docx.Paragraph({
    ...(heading ? { heading } : {}),
    ...(paragraphAlignment ? { alignment: paragraphAlignment } : {}),
    ...(Object.keys(spacing).length > 0 ? { spacing } : {}),
    ...(block.style.keepNext !== undefined ? { keepNext: block.style.keepNext } : {}),
    ...(block.style.pageBreakBefore !== undefined
      ? { pageBreakBefore: block.style.pageBreakBefore }
      : {}),
    ...(list
      ? {
          numbering: {
            reference: list.kind === "bullet" ? "opengeni-bullet" : "opengeni-number",
            level: list.level ?? 0,
            ...(context.listInstances.has(block.id)
              ? { instance: context.listInstances.get(block.id)! }
              : {}),
          },
        }
      : {}),
    children: toDocxParagraphChildren(block, docx, context),
  });
}

function toDocxTable(
  block: DocumentTable,
  page: DocumentPageGeometry,
  docx: DocxModule,
): import("docx").Table {
  const columnCount = block.rows[0]?.length ?? 0;
  const usableWidth = page.widthPt - page.marginLeftPt - page.marginRightPt;
  const totalWidth =
    block.style.widthPt ??
    block.style.columnWidthsPt?.reduce((total, width) => total + width, 0) ??
    usableWidth;
  const columnWidths =
    block.style.columnWidthsPt ??
    Array.from({ length: columnCount }, () => totalWidth / columnCount);
  const columnWidthsTwip = columnWidths.map(ptToTwip);
  // Derive tblW from the exact serialized grid. Rounding the model width and
  // each grid column independently can otherwise make our own DOCX fail the
  // strict fixed-grid consistency check on import.
  const tableWidthTwip = columnWidthsTwip.reduce((sum, width) => sum + width, 0);
  const padding = ptToTwip(block.style.cellPaddingPt ?? 6);
  const borderColor = normalizeHex(block.style.borderColor ?? "#D1D5DB").slice(1);
  const border = { style: docx.BorderStyle.SINGLE, size: 4, color: borderColor };
  return new docx.Table({
    width: { size: tableWidthTwip, type: docx.WidthType.DXA },
    columnWidths: columnWidthsTwip,
    indent: { size: padding, type: docx.WidthType.DXA },
    layout: docx.TableLayoutType.FIXED,
    margins: { top: padding, bottom: padding, left: padding, right: padding },
    borders: {
      top: border,
      bottom: border,
      left: border,
      right: border,
      insideHorizontal: border,
      insideVertical: border,
    },
    rows: block.rows.map(
      (row, rowIndex) =>
        new docx.TableRow({
          tableHeader: rowIndex < (block.style.headerRows ?? 0),
          cantSplit: !(block.style.allowRowSplit ?? false),
          children: row.map(
            (cell, columnIndex) =>
              new docx.TableCell({
                width: {
                  size: columnWidthsTwip[columnIndex] ?? ptToTwip(72),
                  type: docx.WidthType.DXA,
                },
                verticalAlign: docx.VerticalAlign.CENTER,
                margins: { top: padding, bottom: padding, left: padding, right: padding },
                ...(rowIndex < (block.style.headerRows ?? 0) && block.style.headerFill
                  ? { shading: { fill: normalizeHex(block.style.headerFill).slice(1) } }
                  : {}),
                children: [
                  new docx.Paragraph({ children: cell.map((run) => toDocxTextRun(run, docx)) }),
                ],
              }),
          ),
        }),
    ),
  });
}

function toDocxParagraphChildren(
  block: DocumentParagraph,
  docx: DocxModule,
  context: DocxContext,
): DocxParagraphChild[] {
  const comments = context.commentsByBlock.get(block.id) ?? [];
  const changes = context.changesByBlock.get(block.id) ?? [];
  const paragraphText = block.text;
  validateNonCrossingComments(comments.map(({ thread }) => thread));
  validateNonOverlappingChanges(changes.map(({ change }) => change));
  validateReviewMarkupForDocx(
    block,
    comments.map(({ thread }) => thread),
    changes.map(({ change }) => change),
  );
  const boundaries = new Set<number>([0, paragraphText.length]);
  const runSpans: Array<{ start: number; end: number; run: DocumentTextRun }> = [];
  const pointComments = new Map<number, typeof comments>();
  const openingComments = new Map<number, typeof comments>();
  const closingComments = new Map<number, typeof comments>();
  let offset = 0;
  for (const run of block.runs) {
    const start = offset;
    offset += run.text.length;
    runSpans.push({ start, end: offset, run });
    boundaries.add(start);
    boundaries.add(offset);
  }
  for (const { thread } of comments) {
    boundaries.add(thread.start);
    boundaries.add(thread.end);
  }
  for (const comment of comments) {
    if (comment.thread.start === comment.thread.end) {
      appendMap(pointComments, comment.thread.start, comment);
    } else {
      appendMap(openingComments, comment.thread.start, comment);
      appendMap(closingComments, comment.thread.end, comment);
    }
  }
  for (const values of openingComments.values()) {
    values.sort((left, right) => right.thread.end - left.thread.end);
  }
  for (const values of closingComments.values()) {
    values.sort((left, right) => right.thread.start - left.thread.start);
  }
  for (const { change } of changes) {
    boundaries.add(change.start);
    boundaries.add(change.end);
  }
  const points = [...boundaries].sort((a, b) => a - b);
  const sortedChanges = [...changes].sort(
    (left, right) => left.change.start - right.change.start || left.change.end - right.change.end,
  );
  const children: DocxParagraphChild[] = [];
  if (paragraphText.length === 0) {
    for (const { numericId } of pointComments.get(0) ?? []) {
      children.push(
        new docx.CommentRangeStart(numericId),
        new docx.CommentRangeEnd(numericId),
        commentReferenceRun(numericId, docx),
      );
    }
    children.push(...block.runs.map((run) => toDocxTextRun(run, docx)));
    return children;
  }
  let runIndex = 0;
  let changeIndex = 0;
  for (let index = 0; index < points.length; index++) {
    const point = points[index]!;
    for (const { numericId } of pointComments.get(point) ?? []) {
      children.push(
        new docx.CommentRangeStart(numericId),
        new docx.CommentRangeEnd(numericId),
        commentReferenceRun(numericId, docx),
      );
    }
    for (const { numericId } of openingComments.get(point) ?? []) {
      children.push(new docx.CommentRangeStart(numericId));
    }
    const next = points[index + 1];
    if (next !== undefined && next > point) {
      while (runSpans[runIndex] && runSpans[runIndex]!.end <= point) runIndex += 1;
      const span = runSpans[runIndex];
      if (!span) throw new Error(`Document paragraph ${block.id} has a discontinuous run map`);
      if (span.start > point || span.end < next)
        throw new Error(`Document paragraph ${block.id} has a discontinuous run map`);
      const text = span.run.text.slice(point - span.start, next - span.start);
      while (
        sortedChanges[changeIndex]?.change.end !== undefined &&
        sortedChanges[changeIndex]!.change.end <= point
      ) {
        changeIndex += 1;
      }
      const candidate = sortedChanges[changeIndex];
      const active =
        candidate && candidate.change.start <= point && candidate.change.end >= next
          ? candidate
          : undefined;
      if (!active || point === active.change.start) {
        children.push(
          active
            ? toDocxChangedTextRun(
                paragraphText.slice(active.change.start, active.change.end),
                span.run.style,
                active,
                docx,
              )
            : toDocxChangedTextRun(text, span.run.style, undefined, docx),
        );
      }
    }
    if (next !== undefined) {
      for (const { numericId } of closingComments.get(next) ?? []) {
        children.push(new docx.CommentRangeEnd(numericId));
        children.push(commentReferenceRun(numericId, docx));
      }
    }
  }
  return children;
}

function commentReferenceRun(numericId: number, docx: DocxModule): import("docx").TextRun {
  return new docx.TextRun({ children: [new docx.CommentReference(numericId)] });
}

function toDocxChangedTextRun(
  text: string,
  style: DocumentTextStyle,
  active: { change: TrackedChange; numericId: number } | undefined,
  docx: DocxModule,
): DocxParagraphChild {
  const options = docxTextRunOptions(text, style, docx);
  if (!active) return materializedTextRun(text, options, docx);
  const changeOptions = {
    ...options,
    id: active.numericId,
    author: active.change.author,
    date: active.change.createdAt,
  };
  return active.change.kind === "insert"
    ? new docx.InsertedTextRun(changeOptions)
    : new docx.DeletedTextRun(changeOptions);
}

function toDocxTextRun(run: DocumentTextRun, docx: DocxModule): import("docx").TextRun {
  return materializedTextRun(run.text, docxTextRunOptions(run.text, run.style, docx), docx);
}

function materializedTextRun(
  text: string,
  options: import("docx").IRunOptions,
  docx: DocxModule,
): import("docx").TextRun {
  if (text.length > 0) return new docx.TextRun(options);
  // `docx` elides an empty TextRun entirely, including its run properties.
  // An explicit empty w:t keeps insertion-point formatting without adding a
  // Unicode sentinel that would alter the document's text semantics.
  const { text: _text, children: _children, ...properties } = options;
  return new docx.Run({
    ...properties,
    children: [new docx.EmptyElement("w:t")],
  }) as import("docx").TextRun;
}

function docxTextRunOptions(
  text: string,
  style: DocumentTextStyle,
  docx: DocxModule,
): import("docx").IRunOptions {
  return {
    ...(text.includes("\t") || text.includes("\n")
      ? { children: docxTextChildren(text, docx) }
      : { text }),
    ...(style.fontFamily ? { font: style.fontFamily } : {}),
    ...(style.fontSizePt !== undefined ? { size: Math.round(style.fontSizePt * 2) } : {}),
    ...(style.color ? { color: normalizeHex(style.color).slice(1) } : {}),
    ...(style.bold !== undefined ? { bold: style.bold } : {}),
    ...(style.italic !== undefined ? { italics: style.italic } : {}),
    ...(style.underline !== undefined
      ? {
          underline: {
            type: style.underline ? docx.UnderlineType.SINGLE : docx.UnderlineType.NONE,
          },
        }
      : {}),
    ...(style.strike !== undefined ? { strike: style.strike } : {}),
  };
}

function docxTextChildren(
  text: string,
  docx: DocxModule,
): Array<string | import("docx").Tab | import("docx").CarriageReturn> {
  const children: Array<string | import("docx").Tab | import("docx").CarriageReturn> = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== "\t" && character !== "\n") continue;
    if (index > start) children.push(text.slice(start, index));
    children.push(character === "\t" ? new docx.Tab() : new docx.CarriageReturn());
    start = index + 1;
  }
  if (start < text.length) children.push(text.slice(start));
  return children;
}

function numberingConfig(docx: DocxModule): import("docx").INumberingOptions["config"] {
  const makeLevels = (kind: "bullet" | "number"): import("docx").ILevelsOptions[] =>
    Array.from({ length: 9 }, (_, level) => ({
      level,
      format: kind === "bullet" ? docx.LevelFormat.BULLET : docx.LevelFormat.DECIMAL,
      text: kind === "bullet" ? ["•", "◦", "▪"][level % 3]! : `%${level + 1}.`,
      alignment: docx.AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
    }));
  return [
    { reference: "opengeni-bullet", levels: makeLevels("bullet") },
    { reference: "opengeni-number", levels: makeLevels("number") },
  ];
}

function buildListInstances(document: Document): Map<string, number> {
  const instances = new Map<string, number>();
  const explicitInstances = new Map<string, number>();
  let instance = 0;
  const visit = (blocks: readonly (DocumentBlock | DocumentStoryBlock)[]): void => {
    let activeKind: "bullet" | "number" | undefined;
    for (const block of blocks) {
      if (!(block instanceof DocumentParagraph) || !block.style.list) {
        activeKind = undefined;
        continue;
      }
      const explicitId = block.style.list.instanceId;
      if (explicitId) {
        const key = `${block.style.list.kind}:${explicitId}`;
        let explicitInstance = explicitInstances.get(key);
        if (explicitInstance === undefined) {
          explicitInstance = ++instance;
          explicitInstances.set(key, explicitInstance);
        }
        instances.set(block.id, explicitInstance);
        activeKind = undefined;
        continue;
      }
      if (activeKind !== block.style.list.kind) instance += 1;
      activeKind = block.style.list.kind;
      instances.set(block.id, instance);
    }
  };
  visit(document.blocks.items);
  for (const section of document.sections.items)
    for (const story of section.allStories()) visit(story.items);
  return instances;
}

function headingLevel(
  level: DocumentParagraphStyle["headingLevel"],
  docx: DocxModule,
): (typeof import("docx").HeadingLevel)[keyof typeof import("docx").HeadingLevel] | undefined {
  if (!level) return undefined;
  return [
    docx.HeadingLevel.HEADING_1,
    docx.HeadingLevel.HEADING_2,
    docx.HeadingLevel.HEADING_3,
    docx.HeadingLevel.HEADING_4,
    docx.HeadingLevel.HEADING_5,
    docx.HeadingLevel.HEADING_6,
  ][level - 1];
}

function alignment(
  value: DocumentParagraphStyle["alignment"],
  docx: DocxModule,
): (typeof import("docx").AlignmentType)[keyof typeof import("docx").AlignmentType] | undefined {
  if (!value) return undefined;
  return {
    left: docx.AlignmentType.LEFT,
    center: docx.AlignmentType.CENTER,
    right: docx.AlignmentType.RIGHT,
    justify: docx.AlignmentType.JUSTIFIED,
  }[value];
}

function validateNonOverlappingChanges(changes: readonly TrackedChange[]): void {
  const sorted = [...changes].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index]!.start < sorted[index - 1]!.end) {
      throw new UnsupportedArtifactFeatureError(
        "document",
        "overlapping tracked changes",
        "DOCX export",
      );
    }
  }
}

function validateNonCrossingComments(comments: readonly DocumentCommentThread[]): void {
  const sorted = [...comments].sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  const activeEnds: number[] = [];
  for (const comment of sorted) {
    while (activeEnds.length > 0 && comment.start >= activeEnds[activeEnds.length - 1]!) {
      activeEnds.pop();
    }
    const enclosingEnd = activeEnds[activeEnds.length - 1];
    if (enclosingEnd !== undefined && comment.end > enclosingEnd) {
      throw new UnsupportedArtifactFeatureError(
        "document",
        "crossing comment ranges",
        "DOCX export",
      );
    }
    if (comment.end > comment.start) activeEnds.push(comment.end);
  }
}

function validateReviewMarkupForDocx(
  paragraph: DocumentParagraph,
  comments: readonly DocumentCommentThread[],
  changes: readonly TrackedChange[],
): void {
  const runSlices = paragraphRunSlices(paragraph);
  const sortedChanges = [...changes].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let runIndex = 0;
  for (const change of sortedChanges) {
    while (runSlices[runIndex] && runSlices[runIndex]!.end <= change.start) runIndex += 1;
    let scanIndex = runIndex;
    let firstStyle: DocumentTextStyle | undefined;
    while (runSlices[scanIndex] && runSlices[scanIndex]!.start < change.end) {
      const style = runSlices[scanIndex]!.run.style;
      firstStyle ??= style;
      if (!sameTextStyle(style, firstStyle)) {
        throw new UnsupportedArtifactFeatureError(
          "document",
          "one tracked change spanning multiple text styles",
          "DOCX export",
        );
      }
      scanIndex += 1;
    }
  }
  const sortedComments = [...comments].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let changeIndex = 0;
  for (const comment of sortedComments) {
    while (sortedChanges[changeIndex] && sortedChanges[changeIndex]!.end <= comment.start) {
      changeIndex += 1;
    }
    const change = sortedChanges[changeIndex];
    if (!change) continue;
    const pointInside =
      comment.start === comment.end && comment.start > change.start && comment.start < change.end;
    const rangesOverlap = comment.start < change.end && comment.end > change.start;
    const aligned = comment.start === change.start && comment.end === change.end;
    if (pointInside || (rangesOverlap && !aligned)) {
      throw new UnsupportedArtifactFeatureError(
        "document",
        "interleaved comments and tracked changes",
        "DOCX export",
      );
    }
  }
}

function paragraphRunSlices(
  paragraph: DocumentParagraph,
): Array<{ start: number; end: number; run: DocumentTextRun }> {
  const result: Array<{ start: number; end: number; run: DocumentTextRun }> = [];
  let offset = 0;
  for (const run of paragraph.runs) {
    const start = offset;
    offset += run.text.length;
    result.push({ start, end: offset, run });
  }
  return result;
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

const MAX_DOCX_SOURCE_BYTES = 32 * 1024 * 1024;

function validateImportOptions(options: DocumentDocxImportOptions): void {
  assertPlainDataRecord(options, new Set(["unsupportedContent", "limits"]), "DOCX import options");
  if (
    options.unsupportedContent !== undefined &&
    options.unsupportedContent !== "preserve" &&
    options.unsupportedContent !== "error"
  )
    throw new TypeError("DOCX unsupportedContent import policy is invalid");
  if (options.limits !== undefined) {
    assertPlainDataRecord(options.limits, undefined, "DOCX import limits");
  }
}

function validateExportOptions(options: DocumentDocxExportOptions): void {
  assertPlainDataRecord(
    options,
    new Set(["fileName", "unsupportedContent"]),
    "DOCX export options",
  );
  if (
    options.unsupportedContent !== undefined &&
    options.unsupportedContent !== "error" &&
    options.unsupportedContent !== "discard"
  )
    throw new TypeError("DOCX unsupportedContent export policy is invalid");
  if (
    options.fileName !== undefined &&
    (typeof options.fileName !== "string" ||
      options.fileName.length === 0 ||
      options.fileName.length > 255)
  )
    throw new TypeError("DOCX export fileName must contain 1 through 255 characters");
}

function validateAttachOptions(options: Pick<DocumentDocxImportOptions, "limits">): void {
  assertPlainDataRecord(options, new Set(["limits"]), "DOCX envelope attach options");
  if (options.limits !== undefined) {
    assertPlainDataRecord(options.limits, undefined, "DOCX import limits");
  }
}

function assertPlainDataRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string> | undefined,
  label: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new TypeError(`${label} must be a plain data object`);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} must not contain symbol properties`);
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} must contain only enumerable data properties`);
    }
    if (allowedKeys && !allowedKeys.has(key))
      throw new TypeError(`${label} contains unknown property ${key}`);
  }
}

async function ownedDocxBytes(input: FileBlob | Blob | ArrayBuffer): Promise<Uint8Array> {
  if (input instanceof ArrayBuffer) {
    if (input.byteLength > MAX_DOCX_SOURCE_BYTES) {
      throw new DocxImportError("limit_exceeded", "Compressed DOCX exceeds maxCompressedBytes");
    }
    return new Uint8Array(input.slice(0));
  }
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    const size = Object.getOwnPropertyDescriptor(Blob.prototype, "size")?.get?.call(input);
    if (typeof size !== "number" || size > MAX_DOCX_SOURCE_BYTES) {
      throw new DocxImportError("limit_exceeded", "Compressed DOCX exceeds maxCompressedBytes");
    }
    return new Uint8Array(await Blob.prototype.arrayBuffer.call(input));
  }
  throw new DocxImportError("invalid_input", "DOCX input must be a Blob or ArrayBuffer");
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function deterministicCoreProperties(revision: number): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    "<dc:creator>OpenGeni</dc:creator><cp:lastModifiedBy>OpenGeni</cp:lastModifiedBy>" +
    `<cp:revision>${revision}</cp:revision></cp:coreProperties>`
  );
}

function hasOpaqueContent(content: DocumentOpaqueContent): boolean {
  return (
    content.parts.length > 0 || content.relationships.length > 0 || content.contentTypes.length > 0
  );
}

function opaqueContentIssue(
  content: DocumentOpaqueContent,
  severity: DocumentFidelityIssue["severity"],
): DocumentFidelityIssue {
  return {
    code: severity === "warning" ? "content-preserved-in-source" : "content-will-be-discarded",
    severity,
    feature: "opaque-ooxml",
    message:
      severity === "warning"
        ? "The DOCX contains bounded inert OOXML outside the editable model; unchanged export preserves the package byte-for-byte"
        : "The DOCX contains bounded inert OOXML outside the editable model and cannot be imported under the requested strict fidelity policy",
    ...cloneOpaqueContent(content),
  };
}

function cloneOpaqueContent(content: DocumentOpaqueContent): DocumentOpaqueContent {
  return {
    parts: [...content.parts],
    relationships: content.relationships.map((relationship) => ({ ...relationship })),
    contentTypes: content.contentTypes.map((contentType) => ({ ...contentType })),
  };
}

function sameOpaqueContent(left: DocumentOpaqueContent, right: DocumentOpaqueContent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeLossPreservationEnvelope(value: unknown): DocumentLossPreservationEnvelope {
  assertPlainDataRecord(
    value,
    new Set([
      "version",
      "mediaType",
      "sourceBytes",
      "sourceDigest",
      "opaqueContent",
      "modelDigest",
    ]),
    "DOCX loss-preservation envelope",
  );
  if (value.version !== 1 || value.mediaType !== DOCX_MEDIA_TYPE) {
    throw new TypeError("DOCX loss-preservation envelope version or media type is invalid");
  }
  if (
    !(value.sourceBytes instanceof Uint8Array) ||
    Object.getPrototypeOf(value.sourceBytes) !== Uint8Array.prototype ||
    value.sourceBytes.byteLength > MAX_DOCX_SOURCE_BYTES
  )
    throw new TypeError("DOCX loss-preservation sourceBytes must be a bounded Uint8Array");
  if (typeof value.sourceDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.sourceDigest)) {
    throw new TypeError("DOCX loss-preservation sourceDigest must be canonical SHA-256");
  }
  if (typeof value.modelDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.modelDigest)) {
    throw new TypeError("DOCX loss-preservation modelDigest must be canonical SHA-256");
  }
  const opaqueContent = normalizeOpaqueContent(value.opaqueContent);
  if (!hasOpaqueContent(opaqueContent)) {
    throw new TypeError("DOCX loss-preservation envelope contains no opaque content");
  }
  return {
    version: 1,
    mediaType: DOCX_MEDIA_TYPE,
    sourceBytes: value.sourceBytes.slice(),
    sourceDigest: value.sourceDigest,
    opaqueContent,
    modelDigest: value.modelDigest,
  };
}

function normalizeOpaqueContent(value: unknown): DocumentOpaqueContent {
  assertPlainDataRecord(
    value,
    new Set(["parts", "relationships", "contentTypes"]),
    "DOCX opaque-content metadata",
  );
  const parts = denseDataArray(value.parts, 1_024, "DOCX opaque part list").map((part) => {
    if (typeof part !== "string" || part.length === 0 || part.length > 1_025) {
      throw new TypeError("DOCX opaque part name is invalid");
    }
    return part;
  });
  const relationships = denseDataArray(
    value.relationships,
    100_000,
    "DOCX opaque relationship list",
  ).map((relationship) => {
    assertPlainDataRecord(
      relationship,
      new Set(["sourcePart", "type", "targetPart"]),
      "DOCX opaque relationship",
    );
    const { sourcePart, type, targetPart } = relationship;
    if (
      typeof sourcePart !== "string" ||
      sourcePart.length > 1_025 ||
      typeof type !== "string" ||
      type.length === 0 ||
      type.length > 2_048 ||
      typeof targetPart !== "string" ||
      targetPart.length === 0 ||
      targetPart.length > 1_025
    )
      throw new TypeError("DOCX opaque relationship metadata is invalid");
    return { sourcePart, type, targetPart };
  });
  const contentTypes = denseDataArray(
    value.contentTypes,
    1_024,
    "DOCX opaque content-type list",
  ).map((contentType) => {
    assertPlainDataRecord(
      contentType,
      new Set(["partName", "contentType"]),
      "DOCX opaque content type",
    );
    if (
      typeof contentType.partName !== "string" ||
      contentType.partName.length === 0 ||
      contentType.partName.length > 1_025 ||
      typeof contentType.contentType !== "string" ||
      contentType.contentType.length === 0 ||
      contentType.contentType.length > 2_048
    )
      throw new TypeError("DOCX opaque content-type metadata is invalid");
    return { partName: contentType.partName, contentType: contentType.contentType };
  });
  return { parts, relationships, contentTypes };
}

function denseDataArray(value: unknown, maximum: number, label: string): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) {
    throw new TypeError(`${label} must be a bounded ordinary array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} must contain only dense data elements`);
    }
  }
  for (const key of Object.keys(descriptors)) {
    if (key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key)) {
      throw new TypeError(`${label} contains an unknown property`);
    }
  }
  return value.slice();
}

async function documentModelDigest(document: Document): Promise<string> {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(document.toJSON())));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const ownedBytes = new Uint8Array(bytes.byteLength);
  ownedBytes.set(bytes);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", ownedBytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function semanticNamespace(value: ImportedDocument): Promise<string> {
  const { opaqueContent: _opaqueContent, ...semanticValue } = value;
  const canonicalBytes = new TextEncoder().encode(JSON.stringify(semanticValue));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", canonicalBytes));
  return [...digest.subarray(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function appendMap<K, T>(map: Map<K, T[]>, key: K, value: T): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function initials(author: string): string {
  const value = author
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => Array.from(part)[0]?.toUpperCase() ?? "")
    .join("");
  return Array.from(value).slice(0, 8).join("") || "U";
}

function assertRepresentableCommentInitials(author: string, value: string | undefined): void {
  if (value !== undefined && value !== initials(author)) {
    throw new UnsupportedArtifactFeatureError("document", "custom comment initials", "DOCX import");
  }
}

function ptToTwip(value: number): number {
  return Math.round(value * 20);
}

function normalizeHex(value: string): string {
  if (!/^#?[0-9A-Fa-f]{6}$/.test(value)) throw new Error(`Invalid or unsafe color: ${value}`);
  return `#${value.replace(/^#/, "").toUpperCase()}`;
}
