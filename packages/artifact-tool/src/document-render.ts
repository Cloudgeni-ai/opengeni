import { ArtifactLimitError } from "./errors";
import { FileBlob } from "./file-blob";
import {
  Document,
  DocumentPageBreak,
  DocumentParagraph,
  DocumentTable,
  type DocumentBlock,
  type DocumentCommentThread,
  type DocumentRenderOptions,
  type DocumentSection,
  type DocumentStory,
  type DocumentStoryBlock,
  type DocumentTableStyle,
  type DocumentTextRun,
  type DocumentTextStyle,
  type TrackedChange,
} from "./document";

const MAX_RASTER_DIMENSION = 32_768;
const MAX_RASTER_PIXELS = 128_000_000;
const MAX_RASTER_GLYPHS = 50_000;
const MAX_RASTER_TEXT_RUNS = 25_000;

export async function renderDocument(
  document: Document,
  options: DocumentRenderOptions = {},
): Promise<FileBlob> {
  if (!(document instanceof Document)) throw new Error("Document renderer requires a Document");
  validateRenderOptions(options);
  const format = options.format ?? "png";
  if (format === "html") return new FileBlob([renderHtml(document)], { type: "text/html" });
  if (format === "png") {
    validateRasterBudget(measureCanvas(document), options.scale ?? 1);
    validateRasterComplexity(document);
  }
  const svg = renderSvg(document, options);
  if (format === "svg") return new FileBlob([svg], { type: "image/svg+xml" });
  const moduleId = "@resvg/resvg-js";
  const { Resvg } = await import(/* @vite-ignore */ moduleId);
  return FileBlob.fromBytes(Uint8Array.from(new Resvg(svg).render().asPng()), {
    type: "image/png",
  });
}

type StoryVariant = "default" | "first" | "even";
type ProjectedPage = {
  section: DocumentSection;
  pageNumber: number;
  pageInSection: number;
  blocks: readonly (DocumentParagraph | DocumentTable)[];
  header: { variant: StoryVariant; story: DocumentStory };
  footer: { variant: StoryVariant; story: DocumentStory };
};

function projectPages(document: Document): ProjectedPage[] {
  const pages: ProjectedPage[] = [];
  let pageNumber = 1;
  for (let sectionIndex = 0; sectionIndex < document.sections.items.length; sectionIndex += 1) {
    const section = document.sections.items[sectionIndex]!;
    const end =
      document.sections.items[sectionIndex + 1]?.startBlockIndex ?? document.blocks.items.length;
    const chunks: Array<Array<DocumentParagraph | DocumentTable>> = [[]];
    for (const block of document.blocks.items.slice(section.startBlockIndex, end)) {
      if (block instanceof DocumentPageBreak) chunks.push([]);
      else {
        if (
          block instanceof DocumentParagraph &&
          block.style.pageBreakBefore &&
          chunks[chunks.length - 1]!.length > 0
        )
          chunks.push([]);
        chunks[chunks.length - 1]!.push(block);
      }
    }
    for (let pageInSection = 0; pageInSection < chunks.length; pageInSection += 1) {
      const variant: StoryVariant =
        pageInSection === 0 && section.titlePage
          ? "first"
          : document.evenAndOddHeaders && pageNumber % 2 === 0
            ? "even"
            : "default";
      pages.push({
        section,
        pageNumber,
        pageInSection,
        blocks: chunks[pageInSection]!,
        header: { variant, story: section.headers[variant] },
        footer: { variant, story: section.footers[variant] },
      });
      pageNumber += 1;
    }
  }
  return pages;
}

function renderHtml(document: Document): string {
  const markers = buildListMarkers(document);
  const reviews = indexReviews(document);
  const pages = projectPages(document)
    .map((page) => {
      const body = page.blocks.map((block) => htmlBlock(block, markers, reviews)).join("\n");
      const header = page.header.story.items
        .map((block) => htmlBlock(block, markers, reviews))
        .join("\n");
      const footer = page.footer.story.items
        .map((block) => htmlBlock(block, markers, reviews))
        .join("\n");
      const geometry = page.section.page;
      return `<section data-section-id="${escapeAttribute(page.section.id)}" data-page-number="${page.pageNumber}" data-section-page="${page.pageInSection + 1}" data-header-variant="${page.header.variant}" data-footer-variant="${page.footer.variant}" style="width:${geometry.widthPt}pt;min-height:${geometry.heightPt}pt;padding:${geometry.marginTopPt}pt ${geometry.marginRightPt}pt ${geometry.marginBottomPt}pt ${geometry.marginLeftPt}pt"><header data-story-id="${escapeAttribute(page.header.story.id)}" data-story-variant="${page.header.variant}">${header}</header><main>${body}</main><footer data-story-id="${escapeAttribute(page.footer.story.id)}" data-story-variant="${page.footer.variant}">${footer}</footer></section>`;
    })
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><style>html{background:#e5e7eb}body{margin:0;color:#111827;font-family:Arial,sans-serif}section{box-sizing:border-box;display:flex;flex-direction:column;margin:16px auto;background:white}main{flex:1}table{border-collapse:collapse;table-layout:fixed}th,td{box-sizing:border-box;vertical-align:middle;text-align:left}p,h1,h2,h3,h4,h5,h6,th,td{white-space:pre-wrap;tab-size:4}p{line-height:1.35}header,footer{color:#4b5563}ins{text-decoration-color:#16a34a;text-decoration-thickness:2px}del{text-decoration-color:#dc2626;text-decoration-thickness:2px}mark[data-comment-ids]{background:#fef3c7;border-bottom:1px solid #d97706}.document-list-marker{display:inline-block;min-width:1.5em;color:#4b5563}</style></head><body>${pages}</body></html>`;
}

function htmlBlock(
  block: DocumentBlock | DocumentStoryBlock,
  markers: ReadonlyMap<string, string>,
  reviews: ReviewIndex,
): string {
  if (block instanceof DocumentPageBreak) return "";
  if (block instanceof DocumentTable) {
    const border = color(block.style.borderColor ?? "#D1D5DB");
    const padding = block.style.cellPaddingPt ?? 6;
    const columns = block.style.columnWidthsPt
      ? `<colgroup>${block.style.columnWidthsPt.map((width) => `<col style="width:${width}pt">`).join("")}</colgroup>`
      : "";
    const rows = block.rows
      .map((row, rowIndex) => {
        const header = rowIndex < (block.style.headerRows ?? 0);
        const tag = header ? "th" : "td";
        return `<tr>${row
          .map((cell) => {
            const style = [
              `border:1px solid ${border}`,
              `padding:${padding}pt`,
              header && block.style.headerFill ? `background:${color(block.style.headerFill)}` : "",
            ]
              .filter(Boolean)
              .join(";");
            const content = cell
              .map(
                (run) =>
                  `<span style="${escapeAttribute(runCss(run.style))}">${escapeText(run.text)}</span>`,
              )
              .join("");
            return `<${tag} style="${escapeAttribute(style)}">${content}</${tag}>`;
          })
          .join("")}</tr>`;
      })
      .join("");
    return `<table style="${escapeAttribute(tableCss(block.style))}">${columns}${rows}</table>`;
  }
  const tag = block.style.headingLevel ? `h${block.style.headingLevel}` : "p";
  const marker = block.style.list
    ? `<span class="document-list-marker" aria-hidden="true">${escapeText(markers.get(block.id) ?? "")}</span>`
    : "";
  return `<${tag} data-block-id="${escapeAttribute(block.id)}" style="${escapeAttribute(paragraphCss(block.style))}">${marker}${reviewedParagraphHtml(block, reviews)}</${tag}>`;
}

type ReviewIndex = {
  comments: ReadonlyMap<string, readonly DocumentCommentThread[]>;
  changes: ReadonlyMap<string, readonly TrackedChange[]>;
};

function indexReviews(document: Document): ReviewIndex {
  const comments = new Map<string, DocumentCommentThread[]>();
  const changes = new Map<string, TrackedChange[]>();
  for (const item of document.comments.items) append(comments, item.blockId, item);
  for (const item of document.changes.items) append(changes, item.blockId, item);
  return { comments, changes };
}

function reviewedParagraphHtml(block: DocumentParagraph, reviews: ReviewIndex): string {
  const comments = reviews.comments.get(block.id) ?? [];
  const changes = reviews.changes.get(block.id) ?? [];
  const boundaries = new Set<number>([0, block.text.length]);
  const spans: Array<{ start: number; end: number; run: DocumentTextRun }> = [];
  const points = new Map<number, DocumentCommentThread[]>();
  const commentStarts = new Map<number, DocumentCommentThread[]>();
  const commentEnds = new Map<number, DocumentCommentThread[]>();
  const changeStarts = new Map<number, TrackedChange[]>();
  const changeEnds = new Map<number, TrackedChange[]>();
  let offset = 0;
  for (const run of block.runs) {
    const start = offset;
    offset += run.text.length;
    spans.push({ start, end: offset, run });
    boundaries.add(start);
    boundaries.add(offset);
  }
  for (const comment of comments) {
    boundaries.add(comment.start);
    boundaries.add(comment.end);
    if (comment.start === comment.end) append(points, comment.start, comment);
    else {
      append(commentStarts, comment.start, comment);
      append(commentEnds, comment.end, comment);
    }
  }
  for (const change of changes) {
    boundaries.add(change.start);
    boundaries.add(change.end);
    append(changeStarts, change.start, change);
    append(changeEnds, change.end, change);
  }
  const ordered = [...boundaries].sort((left, right) => left - right);
  const html: string[] = [];
  const activeComments = new Set<DocumentCommentThread>();
  const activeChanges = new Set<TrackedChange>();
  let spanIndex = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const start = ordered[index]!;
    for (const item of commentEnds.get(start) ?? []) activeComments.delete(item);
    for (const item of changeEnds.get(start) ?? []) activeChanges.delete(item);
    for (const item of commentStarts.get(start) ?? []) activeComments.add(item);
    for (const item of changeStarts.get(start) ?? []) activeChanges.add(item);
    for (const item of points.get(start) ?? []) {
      html.push(
        `<span data-comment-anchor="${escapeAttribute(item.id)}" aria-label="Comment anchor"></span>`,
      );
    }
    if (index === ordered.length - 1) break;
    const end = ordered[index + 1]!;
    while (spans[spanIndex] && spans[spanIndex]!.end <= start) spanIndex += 1;
    const span = spans[spanIndex];
    if (!span) throw new Error(`Document paragraph ${block.id} has a discontinuous run map`);
    if (activeChanges.size > 1)
      throw new Error(`Document paragraph ${block.id} has overlapping tracked changes`);
    let segment = `<span style="${escapeAttribute(runCss(span.run.style))}">${escapeText(span.run.text.slice(start - span.start, end - span.start))}</span>`;
    const change = activeChanges.values().next().value as TrackedChange | undefined;
    if (change) {
      const tag = change.kind === "insert" ? "ins" : "del";
      segment = `<${tag} data-change-id="${escapeAttribute(change.id)}">${segment}</${tag}>`;
    }
    if (activeComments.size > 0) {
      const ids = [...activeComments].map((item) => item.id).join(" ");
      segment = `<mark data-comment-ids="${escapeAttribute(ids)}">${segment}</mark>`;
    }
    html.push(segment);
  }
  return html.join("");
}

function renderSvg(document: Document, options: DocumentRenderOptions): string {
  const scale = options.scale ?? 1;
  const background = color(options.background ?? "#FFFFFF");
  const pages = projectPages(document);
  const width = Math.max(...pages.map((page) => page.section.page.widthPt * (4 / 3)));
  const markers = buildListMarkers(document);
  const gap = 24;
  const elements: string[] = [];
  let canvasY = 0;
  for (const page of pages) {
    const geometry = page.section.page;
    const pageWidth = geometry.widthPt * (4 / 3);
    const pageHeight = pageCanvasHeight(page);
    const left = (width - pageWidth) / 2;
    const contentX = left + geometry.marginLeftPt * (4 / 3);
    const usableWidth = pageWidth - (geometry.marginLeftPt + geometry.marginRightPt) * (4 / 3);
    elements.push(
      `<g data-section-id="${escapeAttribute(page.section.id)}" data-page-number="${page.pageNumber}" data-section-page="${page.pageInSection + 1}"><rect x="${left}" y="${canvasY}" width="${pageWidth}" height="${pageHeight}" fill="${escapeAttribute(background)}"/>`,
    );
    const header = svgBlocks(
      page.header.story.items,
      contentX,
      canvasY + 8,
      usableWidth,
      markers,
      "#4B5563",
    );
    elements.push(
      `<g data-story-id="${escapeAttribute(page.header.story.id)}" data-story-variant="${page.header.variant}">${header.elements.join("")}</g>`,
    );
    const body = svgBlocks(
      page.blocks,
      contentX,
      canvasY + geometry.marginTopPt * (4 / 3),
      usableWidth,
      markers,
      "#111827",
    );
    elements.push(`<g data-document-body="true">${body.elements.join("")}</g>`);
    const footerHeight = estimateBlocks(page.footer.story.items);
    const footer = svgBlocks(
      page.footer.story.items,
      contentX,
      canvasY + pageHeight - geometry.marginBottomPt * (4 / 3) - footerHeight,
      usableWidth,
      markers,
      "#4B5563",
    );
    elements.push(
      `<g data-story-id="${escapeAttribute(page.footer.story.id)}" data-story-variant="${page.footer.variant}">${footer.elements.join("")}</g></g>`,
    );
    canvasY += pageHeight + gap;
  }
  const height = Math.max(1, canvasY - gap);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${height * scale}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${escapeAttribute(background)}"/>${elements.join("")}</svg>`;
}

function svgBlocks(
  blocks: readonly (DocumentParagraph | DocumentTable)[],
  x: number,
  initialY: number,
  usableWidth: number,
  markers: ReadonlyMap<string, string>,
  fallbackColor: string,
): { elements: string[]; bottom: number } {
  const elements: string[] = [];
  let y = initialY;
  for (const block of blocks) {
    if (block instanceof DocumentTable) {
      const columns = block.rows[0]?.length ?? 1;
      const totalWidth =
        block.style.widthPt !== undefined ? block.style.widthPt * (4 / 3) : usableWidth;
      const widths =
        block.style.columnWidthsPt?.map((value) => value * (4 / 3)) ??
        Array.from({ length: columns }, () => totalWidth / columns);
      const padding = (block.style.cellPaddingPt ?? 6) * (4 / 3);
      block.rows.forEach((row, rowIndex) => {
        const rowHeight = svgTableRowHeight(row, padding);
        const maximumFontSize = row.reduce(
          (maximum, cell) =>
            cell.reduce(
              (cellMaximum, run) => Math.max(cellMaximum, (run.style.fontSizePt ?? 10.5) * (4 / 3)),
              maximum,
            ),
          14,
        );
        let cellX = x;
        row.forEach((cell, columnIndex) => {
          const cellWidth = widths[columnIndex] ?? totalWidth / columns;
          const header = rowIndex < (block.style.headerRows ?? 0);
          const fill = header && block.style.headerFill ? color(block.style.headerFill) : "#FFFFFF";
          const content = cell
            .map((run) => {
              const decoration = [
                run.style.underline ? "underline" : "",
                run.style.strike ? "line-through" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return `<tspan font-family="${escapeAttribute(run.style.fontFamily ?? "Arial")}" font-size="${(run.style.fontSizePt ?? 10.5) * (4 / 3)}" font-weight="${run.style.bold || header ? 700 : 400}" font-style="${run.style.italic ? "italic" : "normal"}"${decoration ? ` text-decoration="${decoration}"` : ""} fill="${escapeAttribute(color(run.style.color ?? fallbackColor))}">${escapeText(run.text.replaceAll("\t", "    ").replaceAll("\n", " "))}</tspan>`;
            })
            .join("");
          const baseline = y + (rowHeight - maximumFontSize) / 2 + maximumFontSize;
          elements.push(
            `<rect x="${cellX}" y="${y}" width="${cellWidth}" height="${rowHeight}" fill="${escapeAttribute(fill)}" stroke="${escapeAttribute(color(block.style.borderColor ?? "#D1D5DB"))}"/><text x="${cellX + padding}" y="${baseline}">${content}</text>`,
          );
          cellX += cellWidth;
        });
        y += rowHeight;
      });
      y += 16;
      continue;
    }
    const baseSize = block.style.headingLevel
      ? Math.max(18, 34 - block.style.headingLevel * 3)
      : 14;
    const lines = svgLines(block, markers.get(block.id));
    const maxSize = block.runs.reduce(
      (maximum, run) => Math.max(maximum, (run.style.fontSizePt ?? baseSize * 0.75) * (4 / 3)),
      baseSize,
    );
    const lineHeight = maxSize * (block.style.lineHeight ?? 1.35);
    const textX =
      block.style.alignment === "center"
        ? x + usableWidth / 2
        : block.style.alignment === "right"
          ? x + usableWidth
          : x;
    const textAnchor =
      block.style.alignment === "center"
        ? "middle"
        : block.style.alignment === "right"
          ? "end"
          : "start";
    y += block.style.spaceBeforePt ?? 4;
    for (const line of lines) {
      y += maxSize;
      const content = line
        .map(({ text, style }) => {
          const size = (style.fontSizePt ?? baseSize * 0.75) * (4 / 3);
          const decoration = [
            style.underline ? "underline" : "",
            style.strike ? "line-through" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return `<tspan font-family="${escapeAttribute(style.fontFamily ?? "Arial")}" font-size="${size}" font-weight="${style.bold || block.style.headingLevel ? 700 : 400}" font-style="${style.italic ? "italic" : "normal"}"${decoration ? ` text-decoration="${decoration}"` : ""} fill="${escapeAttribute(color(style.color ?? fallbackColor))}">${escapeText(text)}</tspan>`;
        })
        .join("");
      elements.push(`<text x="${textX}" y="${y}" text-anchor="${textAnchor}">${content}</text>`);
      y += Math.max(0, lineHeight - maxSize);
    }
    y += block.style.spaceAfterPt ?? 8;
  }
  return { elements, bottom: y };
}

function svgLines(
  block: DocumentParagraph,
  marker: string | undefined,
): Array<Array<{ text: string; style: DocumentTextStyle }>> {
  const lines: Array<Array<{ text: string; style: DocumentTextStyle }>> = [[]];
  if (marker) lines[0]!.push({ text: `${marker} `, style: {} });
  for (const run of block.runs) {
    run.text.split("\n").forEach((chunk, index) => {
      if (index > 0) lines.push([]);
      if (chunk.length > 0)
        lines.at(-1)!.push({ text: chunk.replaceAll("\t", "    "), style: run.style });
    });
  }
  return lines;
}

function buildListMarkers(document: Document): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (blocks: readonly (DocumentBlock | DocumentStoryBlock)[]): void => {
    let activeKind: "bullet" | "number" | undefined;
    const implicit = Array.from({ length: 9 }, () => 0);
    const explicit = new Map<string, number[]>();
    for (const block of blocks) {
      if (!(block instanceof DocumentParagraph) || !block.style.list) {
        activeKind = undefined;
        implicit.fill(0);
        continue;
      }
      const level = block.style.list.level ?? 0;
      const id = block.style.list.instanceId;
      let counters: number[];
      if (id) {
        const key = `${block.style.list.kind}:${id}`;
        counters = explicit.get(key) ?? Array.from({ length: 9 }, () => 0);
        explicit.set(key, counters);
        activeKind = undefined;
      } else {
        if (activeKind !== block.style.list.kind) implicit.fill(0);
        activeKind = block.style.list.kind;
        counters = implicit;
      }
      if (block.style.list.kind === "number") {
        counters[level] = (counters[level] ?? 0) + 1;
        for (let deeper = level + 1; deeper < counters.length; deeper += 1) counters[deeper] = 0;
        result.set(block.id, `${counters[level]}.`);
      } else result.set(block.id, ["•", "◦", "▪"][level % 3]!);
    }
  };
  visit(document.blocks.items);
  for (const section of document.sections.items)
    for (const story of section.allStories()) visit(story.items);
  return result;
}

function estimateBlocks(blocks: readonly (DocumentParagraph | DocumentTable)[]): number {
  let height = 0;
  for (const block of blocks) {
    if (block instanceof DocumentTable) {
      const padding = (block.style.cellPaddingPt ?? 6) * (4 / 3);
      height += block.rows.reduce((sum, row) => sum + svgTableRowHeight(row, padding), 0) + 16;
      continue;
    }
    const base = block.style.headingLevel ? Math.max(18, 34 - block.style.headingLevel * 3) : 14;
    const size = block.runs.reduce(
      (maximum, run) => Math.max(maximum, (run.style.fontSizePt ?? base * 0.75) * (4 / 3)),
      base,
    );
    height +=
      (block.style.spaceBeforePt ?? 4) +
      size * (block.style.lineHeight ?? 1.35) * Math.max(1, block.text.split("\n").length) +
      (block.style.spaceAfterPt ?? 8);
  }
  return height;
}

function svgTableRowHeight(row: readonly (readonly DocumentTextRun[])[], padding: number): number {
  const maximumFontSize = row.reduce(
    (maximum, cell) =>
      cell.reduce(
        (cellMaximum, run) => Math.max(cellMaximum, (run.style.fontSizePt ?? 10.5) * (4 / 3)),
        maximum,
      ),
    14,
  );
  return Math.max(32, maximumFontSize * 1.2 + padding * 2);
}

function pageCanvasHeight(page: ProjectedPage): number {
  const physical = page.section.page.heightPt * (4 / 3);
  const content =
    (page.section.page.marginTopPt + page.section.page.marginBottomPt) * (4 / 3) +
    estimateBlocks(page.blocks);
  return Math.max(physical, content);
}

function measureCanvas(document: Document): { width: number; height: number } {
  const pages = projectPages(document);
  return {
    width: Math.max(...pages.map((page) => page.section.page.widthPt * (4 / 3))),
    height: Math.max(1, pages.reduce((sum, page) => sum + pageCanvasHeight(page) + 24, 0) - 24),
  };
}

function validateRasterBudget(dimensions: { width: number; height: number }, scale: number): void {
  const width = Math.ceil(dimensions.width * scale);
  const height = Math.ceil(dimensions.height * scale);
  const dimension = Math.max(width, height);
  if (dimension > MAX_RASTER_DIMENSION) {
    throw new ArtifactLimitError("document raster dimension", dimension, MAX_RASTER_DIMENSION);
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_RASTER_PIXELS) {
    throw new ArtifactLimitError("document raster pixels", pixels, MAX_RASTER_PIXELS);
  }
}

function validateRasterComplexity(document: Document): void {
  let glyphs = 0;
  let runs = 0;
  for (const block of document.allStoryBlocks()) {
    if (block instanceof DocumentPageBreak) continue;
    if (block instanceof DocumentParagraph) {
      glyphs += block.text.length;
      runs += block.runs.length;
    } else
      for (const row of block.rows)
        for (const cell of row)
          for (const run of cell) {
            glyphs += run.text.length;
            runs += 1;
          }
    if (glyphs > MAX_RASTER_GLYPHS)
      throw new ArtifactLimitError("document raster glyphs", glyphs, MAX_RASTER_GLYPHS);
    if (runs > MAX_RASTER_TEXT_RUNS)
      throw new ArtifactLimitError("document raster text runs", runs, MAX_RASTER_TEXT_RUNS);
  }
}

function paragraphCss(style: DocumentParagraph["style"]): string {
  return [
    style.alignment ? `text-align:${style.alignment}` : "",
    style.spaceBeforePt !== undefined ? `margin-top:${style.spaceBeforePt}pt` : "",
    style.spaceAfterPt !== undefined ? `margin-bottom:${style.spaceAfterPt}pt` : "",
    style.lineHeight !== undefined ? `line-height:${style.lineHeight}` : "",
    style.keepNext ? "break-after:avoid" : "",
    style.pageBreakBefore ? "break-before:page" : "",
  ]
    .filter(Boolean)
    .join(";");
}

function tableCss(style: DocumentTableStyle): string {
  return [
    style.widthPt !== undefined ? `width:${style.widthPt}pt` : "width:100%",
    "table-layout:fixed",
    style.allowRowSplit !== true ? "break-inside:avoid" : "",
  ]
    .filter(Boolean)
    .join(";");
}

function runCss(style: DocumentTextStyle): string {
  const decoration = [style.underline ? "underline" : "", style.strike ? "line-through" : ""]
    .filter(Boolean)
    .join(" ");
  return [
    `font-family:${style.fontFamily ?? "Arial"}`,
    `font-size:${style.fontSizePt ?? 11}pt`,
    `color:${color(style.color ?? "#111827")}`,
    style.bold ? "font-weight:700" : "",
    style.italic ? "font-style:italic" : "",
    decoration ? `text-decoration:${decoration}` : "",
  ]
    .filter(Boolean)
    .join(";");
}

function validateRenderOptions(options: DocumentRenderOptions): void {
  if (typeof options !== "object" || options === null || Array.isArray(options))
    throw new Error("Document render options must be an object");
  for (const key of Object.keys(options)) {
    if (!["format", "scale", "background"].includes(key))
      throw new Error(`Unknown document render options property: ${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor || !("value" in descriptor))
      throw new Error("Document render options must contain plain data properties");
  }
  if (options.format !== undefined && !["html", "svg", "png"].includes(options.format))
    throw new Error(`Unsupported document render format: ${String(options.format)}`);
  if (
    options.scale !== undefined &&
    (!Number.isFinite(options.scale) || options.scale < 0.1 || options.scale > 8)
  )
    throw new Error("document render scale must be between 0.1 and 8");
  if (options.background !== undefined) color(options.background);
}

function append<K, T>(map: Map<K, T[]>, key: K, value: T): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function color(value: string): string {
  if (!/^#?[0-9A-Fa-f]{6}$/.test(value)) throw new Error(`Invalid or unsafe color: ${value}`);
  return `#${value.replace(/^#/, "").toUpperCase()}`;
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
