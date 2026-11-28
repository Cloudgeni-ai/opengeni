/**
 * The picture an artifact card shows for a document, presentation or
 * spreadsheet: its first page, slide or sheet, drawn as a small SVG from the
 * same bounded kernel projections agents inspect. It is a likeness, not a
 * faithful render: text is wrapped by estimate in the reader's sans-serif
 * font, images are flat tiles and charts are simple bars. Every string is
 * XML-escaped and every color reduced to a hex value, and the SVG holds
 * nothing but shapes and text (no scripts, links, styles or external
 * references), so it is safe to show as an image anywhere.
 */
import type {
  DocumentArtifactProjection,
  DocumentArtifactProjectionItem,
  DocumentArtifactTextRun,
  PresentationArtifactEditorSceneNode,
  PresentationArtifactFill,
  PresentationArtifactLine,
  PresentationArtifactQueryResponse,
  PresentationArtifactRichText,
  SpreadsheetArtifactProjectedCell,
  SpreadsheetArtifactSheetMetadata,
  SpreadsheetArtifactViewportProjection,
} from "@opengeni/contracts/editable-artifacts";

/** Bounded queries for a preview: enough for the first screenful, never the whole artifact. */
export const EDITABLE_ARTIFACT_PREVIEW_LIMITS = Object.freeze({
  documentBlocks: 48,
  documentTextUtf16: 6_000,
  documentTableCells: 120,
  presentationNodes: 256,
  presentationTextBytes: 16_384,
  presentationResponseBytes: 512 * 1024,
  spreadsheetSheets: 256,
  spreadsheetMetadataBytes: 256 * 1024,
  spreadsheetRows: 24,
  spreadsheetColumns: 12,
  spreadsheetResponseBytes: 256 * 1024,
});

const FONT = "Inter, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MAX_TEXT_ELEMENTS = 400;

/** XML 1.0 text: escaped, without characters XML cannot carry. */
export function xmlText(value: string, maxLength = 400): string {
  let text = "";
  for (const char of value) {
    if (text.length >= maxLength) break;
    const code = char.codePointAt(0)!;
    if (
      code === 0x9 ||
      code === 0xa ||
      code === 0xd ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff)
    )
      text += char === "\t" || char === "\n" || char === "\r" ? " " : char;
  }
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A document color (`#RRGGBB` or `RRGGBB`) as hex, or the fallback. */
function hexColor(value: string | undefined, fallback: string): string {
  const match = value ? /^#?([0-9a-f]{6})$/i.exec(value.trim()) : null;
  return match ? `#${match[1]!.toLowerCase()}` : fallback;
}

/** A presentation color (0xRRGGBBAA) as hex and opacity. */
function rgba(value: number): { hex: string; opacity: number } {
  const unsigned = value >>> 0;
  const hex = `#${(unsigned >>> 8).toString(16).padStart(6, "0")}`;
  return { hex, opacity: Math.round(((unsigned & 0xff) / 255) * 100) / 100 };
}

function fillAttributes(fill: PresentationArtifactFill): string {
  if (fill.kind !== "solid") return `fill="none"`;
  const { hex, opacity } = rgba(fill.color);
  return opacity < 1 ? `fill="${hex}" fill-opacity="${opacity}"` : `fill="${hex}"`;
}

function strokeAttributes(line: PresentationArtifactLine, scale: number): string {
  if (line.fill.kind !== "solid" || line.width <= 0) return `stroke="none"`;
  const { hex, opacity } = rgba(line.fill.color);
  const width = Math.max(1, num(line.width * scale));
  const dash =
    line.dash === "dash"
      ? ` stroke-dasharray="${width * 4} ${width * 3}"`
      : line.dash === "dot"
        ? ` stroke-dasharray="${width} ${width * 2}"`
        : "";
  return `stroke="${hex}" stroke-width="${width}"${opacity < 1 ? ` stroke-opacity="${opacity}"` : ""}${dash}`;
}

function num(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

/** Words broken into lines of at most `width` units for a font of `size` (an estimate). */
function wrap(text: string, size: number, width: number, maxLines: number): string[] {
  const perLine = Math.max(4, Math.floor(width / (size * 0.52)));
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (lines.length >= maxLines) break;
    const pieces =
      word.length > perLine ? (word.match(new RegExp(`.{1,${perLine}}`, "gu")) ?? [word]) : [word];
    for (const piece of pieces) {
      const next = line ? `${line} ${piece}` : piece;
      if (next.length <= perLine) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      line = piece;
      if (lines.length >= maxLines) break;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

/** A picture fills its card from the top: centred, or from the left for a sheet. */
function svg(
  width: number,
  height: number,
  background: string,
  body: string[],
  align: "xMidYMin" | "xMinYMin" = "xMidYMin",
): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(width)} ${num(height)}" ` +
    `width="${num(width)}" height="${num(height)}" preserveAspectRatio="${align} slice">` +
    `<rect width="${num(width)}" height="${num(height)}" fill="${background}"/>` +
    body.join("") +
    `</svg>`
  );
}

function textElement(input: {
  x: number;
  y: number;
  size: number;
  text: string;
  color?: string | undefined;
  weight?: number | undefined;
  italic?: boolean | undefined;
  anchor?: "start" | "middle" | "end" | undefined;
  opacity?: number | undefined;
}): string {
  return (
    `<text x="${num(input.x)}" y="${num(input.y)}" font-family="${FONT}" font-size="${num(input.size)}"` +
    (input.weight && input.weight !== 400 ? ` font-weight="${input.weight}"` : "") +
    (input.italic ? ` font-style="italic"` : "") +
    (input.anchor && input.anchor !== "start" ? ` text-anchor="${input.anchor}"` : "") +
    (input.opacity !== undefined && input.opacity < 1 ? ` fill-opacity="${input.opacity}"` : "") +
    ` fill="${input.color ?? "#1f1f1f"}">${xmlText(input.text)}</text>`
  );
}

// ---------------------------------------------------------------------------
// Document: the top of the first page.
// ---------------------------------------------------------------------------

const HEADING_SIZE: Record<number, number> = { 1: 22, 2: 17, 3: 14, 4: 12, 5: 11, 6: 11 };

function runsText(runs: readonly DocumentArtifactTextRun[]): string {
  return runs.map((run) => run.text).join("");
}

export function documentPreviewSvg(
  summary: DocumentArtifactProjection,
  body: DocumentArtifactProjection,
): string {
  const geometry = summary.items.find(
    (item): item is Extract<DocumentArtifactProjectionItem, { kind: "summary" }> =>
      item.kind === "summary",
  )?.page;
  const points = (value: bigint | undefined, fallback: number) => {
    const parsed = value === undefined ? Number.NaN : Number(value) / 1000;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const width = Math.min(2_000, points(geometry?.widthMillipoints, 612));
  const height = Math.min(3_000, points(geometry?.heightMillipoints, 792));
  const left = Math.min(width / 3, points(geometry?.marginLeftMillipoints, 72));
  const right = Math.min(width / 3, points(geometry?.marginRightMillipoints, 72));
  const top = Math.min(height / 3, points(geometry?.marginTopMillipoints, 72));
  const content = Math.max(40, width - left - right);
  const out: string[] = [];
  let y = top;
  let listNumber = 0;
  const limit = height - 24;
  for (const item of body.items) {
    if (y >= limit || out.length >= MAX_TEXT_ELEMENTS) break;
    if (item.kind === "page-break") break;
    if (item.kind === "paragraph") {
      if (item.style.pageBreakBefore && y > top) break;
      const text = runsText(item.runs).trim();
      const first = item.runs.find((run) => run.text.trim())?.style ?? {};
      const level = item.style.headingLevel;
      const size = level ? (HEADING_SIZE[level] ?? 11) : Math.min(36, first.fontSizePt ?? 11);
      const weight = level || first.bold ? 650 : 400;
      const color = hexColor(first.color, level ? "#111111" : "#2a2a2a");
      const list = item.style.list;
      listNumber = list?.kind === "number" ? listNumber + 1 : 0;
      const indent = list ? 18 + (list.level ?? 0) * 18 : 0;
      y += item.style.spaceBeforePt ?? (level ? size * 0.6 : 0);
      if (!text) {
        y += size * 1.2;
        continue;
      }
      const lines = wrap(text, size, content - indent, Math.ceil((limit - y) / (size * 1.35)));
      const anchor =
        item.style.alignment === "center"
          ? "middle"
          : item.style.alignment === "right"
            ? "end"
            : "start";
      const x =
        anchor === "middle"
          ? left + content / 2
          : anchor === "end"
            ? left + content
            : left + indent;
      lines.forEach((line, index) => {
        y += size * (index === 0 ? 1 : 1.35);
        if (index === 0 && list)
          out.push(
            textElement({
              x: left + indent - 12,
              y,
              size,
              text: list.kind === "bullet" ? "•" : `${listNumber}.`,
              color,
              anchor: "end",
            }),
          );
        out.push(
          textElement({ x, y, size, text: line, color, weight, italic: first.italic, anchor }),
        );
      });
      y += item.style.spaceAfterPt ?? size * (level ? 0.5 : 0.7);
    } else if (item.kind === "table") {
      listNumber = 0;
      const columns = Math.max(1, Math.min(8, Math.max(...item.rows.map((row) => row.length), 1)));
      const cellWidth = content / columns;
      const rowHeight = 20;
      y += 6;
      for (const [rowIndex, row] of item.rows.entries()) {
        if (y + rowHeight > limit) break;
        const header = rowIndex < (item.style.headerRows ?? 1);
        if (header)
          out.push(
            `<rect x="${num(left)}" y="${num(y)}" width="${num(content)}" height="${rowHeight}" fill="${hexColor(item.style.headerFill, "#f1f1f1")}"/>`,
          );
        row.slice(0, columns).forEach((cell, column) => {
          const text = wrap(runsText(cell), 9, cellWidth - 8, 1)[0];
          if (text)
            out.push(
              textElement({
                x: left + column * cellWidth + 4,
                y: y + 13.5,
                size: 9,
                text,
                weight: header ? 600 : 400,
              }),
            );
        });
        y += rowHeight;
        out.push(
          `<line x1="${num(left)}" y1="${num(y)}" x2="${num(left + content)}" y2="${num(y)}" stroke="${hexColor(item.style.borderColor, "#d6d6d6")}" stroke-width="0.75"/>`,
        );
      }
      y += 10;
    }
  }
  return svg(width, height, "#ffffff", out);
}

// ---------------------------------------------------------------------------
// Presentation: the first slide.
// ---------------------------------------------------------------------------

/** Slide coordinates are EMU; the picture uses CSS pixels (9525 EMU each). */
const EMU_PER_PIXEL = 9_525;
/** Points to CSS pixels. */
const PIXELS_PER_POINT = 4 / 3;

function richText(
  text: PresentationArtifactRichText,
  box: { x: number; y: number; width: number; height: number },
  out: string[],
): void {
  const inset = 7;
  const width = Math.max(8, box.width - inset * 2);
  const laid: {
    line: string;
    size: number;
    color: string;
    opacity: number;
    weight: number;
    italic: boolean;
    anchor: "start" | "middle" | "end";
  }[] = [];
  let total = 0;
  for (const paragraph of text.paragraphs) {
    const style = paragraph.runs.find((run) => run.text.trim())?.style ?? paragraph.runs[0]?.style;
    const size = Math.max(
      6,
      Math.min(160, ((style?.fontSizeCentipoints ?? 1800) / 100) * PIXELS_PER_POINT),
    );
    const value = paragraph.runs.map((run) => run.text).join("");
    const color = style ? rgba(style.color) : { hex: "#1f1f1f", opacity: 1 };
    const anchor =
      paragraph.alignment === "center"
        ? "middle"
        : paragraph.alignment === "right"
          ? "end"
          : "start";
    const lines = value.trim() ? wrap(value, size, width, 12) : [""];
    for (const line of lines) {
      if (total + size * 1.2 > box.height + size * 0.5 || laid.length >= 40) break;
      laid.push({
        line,
        size,
        color: color.hex,
        opacity: color.opacity,
        weight: style?.bold ? 700 : 400,
        italic: style?.italic ?? false,
        anchor,
      });
      total += size * 1.2;
    }
  }
  let y =
    text.verticalAlignment === "middle"
      ? box.y + (box.height - total) / 2
      : text.verticalAlignment === "bottom"
        ? box.y + box.height - total - inset
        : box.y + inset;
  for (const entry of laid) {
    y += entry.size * 1.2;
    if (!entry.line) continue;
    const x =
      entry.anchor === "middle"
        ? box.x + box.width / 2
        : entry.anchor === "end"
          ? box.x + box.width - inset
          : box.x + inset;
    out.push(
      textElement({
        x,
        y: y - entry.size * 0.25,
        size: entry.size,
        text: entry.line,
        color: entry.color,
        opacity: entry.opacity,
        weight: entry.weight,
        italic: entry.italic,
        anchor: entry.anchor,
      }),
    );
  }
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * A node's box on the slide, in pixels. A group's children are placed in the
 * group's own child space (offset and extent), mapped onto the group's box.
 */
function slideBox(
  node: PresentationArtifactEditorSceneNode,
  byId: ReadonlyMap<string, PresentationArtifactEditorSceneNode>,
  depth = 0,
): Box {
  const own = node.bounds;
  const parent = node.parentId ? byId.get(node.parentId) : undefined;
  if (!parent || parent.content.kind !== "group" || depth > 16)
    return {
      x: own.x / EMU_PER_PIXEL,
      y: own.y / EMU_PER_PIXEL,
      width: own.width / EMU_PER_PIXEL,
      height: own.height / EMU_PER_PIXEL,
    };
  const group = parent.content;
  const outer = slideBox(parent, byId, depth + 1);
  const sx =
    group.childExtentWidth > 0 ? outer.width / (group.childExtentWidth / EMU_PER_PIXEL) : 1;
  const sy =
    group.childExtentHeight > 0 ? outer.height / (group.childExtentHeight / EMU_PER_PIXEL) : 1;
  return {
    x: outer.x + ((own.x - group.childOffsetX) / EMU_PER_PIXEL) * sx,
    y: outer.y + ((own.y - group.childOffsetY) / EMU_PER_PIXEL) * sy,
    width: (own.width / EMU_PER_PIXEL) * sx,
    height: (own.height / EMU_PER_PIXEL) * sy,
  };
}

function presentationNode(
  node: PresentationArtifactEditorSceneNode,
  box: Box,
  out: string[],
): void {
  const parts: string[] = [];
  const content = node.content;
  const rect = `x="${num(box.x)}" y="${num(box.y)}" width="${num(Math.max(0, box.width))}" height="${num(Math.max(0, box.height))}"`;
  if (content.kind === "shape") {
    const paint = `${fillAttributes(content.fill)} ${strokeAttributes(content.line, 1 / EMU_PER_PIXEL)}`;
    const { x, y, width, height } = box;
    switch (content.geometry) {
      case "rectangle":
      case "text-box":
        if (
          content.geometry === "rectangle" ||
          content.fill.kind === "solid" ||
          content.line.fill.kind === "solid"
        )
          parts.push(`<rect ${rect} ${paint}/>`);
        break;
      case "rounded-rectangle":
        parts.push(`<rect ${rect} rx="${num(Math.min(width, height) * 0.16)}" ${paint}/>`);
        break;
      case "ellipse":
        parts.push(
          `<ellipse cx="${num(x + width / 2)}" cy="${num(y + height / 2)}" rx="${num(width / 2)}" ry="${num(height / 2)}" ${paint}/>`,
        );
        break;
      case "triangle":
        parts.push(
          `<polygon points="${num(x + width / 2)},${num(y)} ${num(x + width)},${num(y + height)} ${num(x)},${num(y + height)}" ${paint}/>`,
        );
        break;
      case "right-arrow": {
        const shaft = height * 0.25;
        const head = Math.min(width * 0.4, height);
        parts.push(
          `<polygon points="${num(x)},${num(y + shaft)} ${num(x + width - head)},${num(y + shaft)} ${num(x + width - head)},${num(y)} ${num(x + width)},${num(y + height / 2)} ${num(x + width - head)},${num(y + height)} ${num(x + width - head)},${num(y + height - shaft)} ${num(x)},${num(y + height - shaft)}" ${paint}/>`,
        );
        break;
      }
      case "line":
        parts.push(
          `<line x1="${num(x)}" y1="${num(y)}" x2="${num(x + width)}" y2="${num(y + height)}" ${strokeAttributes(content.line, 1 / EMU_PER_PIXEL)}/>`,
        );
        break;
    }
    if (content.text) richText(content.text, box, parts);
  } else if (content.kind === "connector") {
    parts.push(
      `<line x1="${num(content.start.x / EMU_PER_PIXEL)}" y1="${num(content.start.y / EMU_PER_PIXEL)}" x2="${num(content.end.x / EMU_PER_PIXEL)}" y2="${num(content.end.y / EMU_PER_PIXEL)}" ${strokeAttributes(content.line, 1 / EMU_PER_PIXEL)}/>`,
    );
  } else if (content.kind === "media") {
    parts.push(`<rect ${rect} fill="#e4e7eb"/>`);
  } else if (content.kind === "table") {
    const rows = content.rows.slice(0, 20);
    const columns = Math.max(1, ...rows.map((row) => row.length));
    const rowHeight = box.height / Math.max(1, content.rows.length);
    const columnWidth = box.width / columns;
    rows.forEach((row, rowIndex) => {
      row.slice(0, 12).forEach((cell, column) => {
        if (!cell) return;
        const cellBox = {
          x: box.x + column * columnWidth,
          y: box.y + rowIndex * rowHeight,
          width: columnWidth * Math.max(1, cell.columnSpan),
          height: rowHeight * Math.max(1, cell.rowSpan),
        };
        parts.push(
          `<rect x="${num(cellBox.x)}" y="${num(cellBox.y)}" width="${num(cellBox.width)}" height="${num(cellBox.height)}" ${cell.fill.kind === "solid" ? fillAttributes(cell.fill) : `fill="none"`} stroke="#c8c8c8" stroke-width="1"/>`,
        );
        richText(cell.text, cellBox, parts);
      });
    });
  } else if (content.kind === "chart") {
    const values = content.series[0]?.values.slice(0, 24) ?? [];
    const max = Math.max(
      1,
      ...values.map((value) => (Number.isFinite(value) ? Math.abs(value) : 0)),
    );
    const gap = box.width / Math.max(1, values.length);
    values.forEach((value, index) => {
      const barHeight = (Math.abs(Number.isFinite(value) ? value : 0) / max) * box.height * 0.85;
      parts.push(
        `<rect x="${num(box.x + index * gap + gap * 0.15)}" y="${num(box.y + box.height - barHeight)}" width="${num(gap * 0.7)}" height="${num(barHeight)}" fill="#4f7bd9"/>`,
      );
    });
  }
  if (parts.length === 0) return;
  const { flipHorizontal, flipVertical } = node.transform;
  // Rotation is in 60,000ths of a degree.
  const rotation = node.transform.rotation / 60_000;
  const cx = num(box.x + box.width / 2);
  const cy = num(box.y + box.height / 2);
  const transforms: string[] = [];
  if (Number.isFinite(rotation) && rotation % 360 !== 0)
    transforms.push(`rotate(${num(rotation)} ${cx} ${cy})`);
  if (flipHorizontal || flipVertical)
    transforms.push(
      `translate(${cx} ${cy}) scale(${flipHorizontal ? -1 : 1} ${flipVertical ? -1 : 1}) translate(${-cx} ${-cy})`,
    );
  out.push(
    transforms.length
      ? `<g transform="${transforms.join(" ")}">${parts.join("")}</g>`
      : parts.join(""),
  );
}

export function presentationPreviewSvg(
  slideSize: Readonly<{ width: number; height: number }>,
  slide: Extract<PresentationArtifactQueryResponse, { kind: "editor-slide" }> | null,
): string {
  const width = Math.max(64, Math.min(8_000, slideSize.width / EMU_PER_PIXEL || 1280));
  const height = Math.max(36, Math.min(8_000, slideSize.height / EMU_PER_PIXEL || 720));
  const fill =
    slide?.slide.background.kind === "solid"
      ? slide.slide.background
      : slide?.slide.layout?.background;
  const background = fill?.kind === "solid" ? rgba(fill.color).hex : "#ffffff";
  const out: string[] = [];
  // Master, then layout, then slide; each tree in order, a group's children
  // right after it (groups themselves draw nothing).
  const nodes = slide?.nodes ?? [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string | null, PresentationArtifactEditorSceneNode[]>();
  for (const node of nodes) {
    const parent = node.parentId && byId.has(node.parentId) ? node.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), node]);
  }
  const rank = { master: 0, layout: 1, slide: 2 } as const;
  const ordered = (parent: string | null) =>
    [...(children.get(parent) ?? [])].sort(
      (a, b) => rank[a.source.kind] - rank[b.source.kind] || a.order - b.order,
    );
  const drawn = new Set<string>();
  const draw = (node: PresentationArtifactEditorSceneNode) => {
    if (drawn.has(node.id) || out.length >= MAX_TEXT_ELEMENTS) return;
    drawn.add(node.id);
    presentationNode(node, slideBox(node, byId), out);
    for (const child of ordered(node.id)) draw(child);
  };
  for (const node of ordered(null)) draw(node);
  return svg(width, height, background, out);
}

// ---------------------------------------------------------------------------
// Spreadsheet: the top-left of the first sheet.
// ---------------------------------------------------------------------------

function columnName(index: number): string {
  let name = "";
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function cellText(cell: SpreadsheetArtifactProjectedCell): { text: string; numeric: boolean } {
  const value = cell.value;
  switch (value.kind) {
    case "empty":
      return { text: "", numeric: false };
    case "boolean":
      return { text: value.value ? "TRUE" : "FALSE", numeric: false };
    case "number":
      return {
        text: Number.isInteger(value.value)
          ? value.value.toLocaleString("en-US")
          : value.value.toLocaleString("en-US", { maximumFractionDigits: 2 }),
        numeric: true,
      };
    case "date":
      return { text: value.value.slice(0, 10), numeric: true };
    case "text":
      return { text: value.value, numeric: false };
    case "error":
      return { text: "#ERROR", numeric: false };
  }
}

function sizes(
  start: number,
  count: number,
  fallback: number,
  explicit: readonly (readonly [number, number])[] | undefined,
): number[] {
  const known = new Map(explicit ?? []);
  return Array.from({ length: count }, (_, index) => {
    const size = known.get(start + index) ?? fallback;
    return Math.max(8, Math.min(400, Number.isFinite(size) ? size : fallback));
  });
}

export function spreadsheetPreviewSvg(
  sheet: SpreadsheetArtifactSheetMetadata | null,
  viewport: SpreadsheetArtifactViewportProjection | null,
): string {
  const rows = viewport?.rowCount ?? EDITABLE_ARTIFACT_PREVIEW_LIMITS.spreadsheetRows;
  const columns = viewport?.columnCount ?? EDITABLE_ARTIFACT_PREVIEW_LIMITS.spreadsheetColumns;
  const startRow = viewport?.startRow ?? 0;
  const startColumn = viewport?.startColumn ?? 0;
  const heights = sizes(
    startRow,
    rows,
    viewport?.defaultRowHeight ?? sheet?.defaultRowHeight ?? 24,
    viewport?.rowHeights ?? sheet?.rowHeights,
  );
  const widths = sizes(
    startColumn,
    columns,
    viewport?.defaultColumnWidth ?? sheet?.defaultColumnWidth ?? 96,
    viewport?.columnWidths ?? sheet?.columnWidths,
  );
  const gutter = 36;
  const header = 22;
  const xs = [gutter];
  for (const width of widths) xs.push(xs[xs.length - 1]! + width);
  const ys = [header];
  for (const height of heights) ys.push(ys[ys.length - 1]! + height);
  const width = Math.min(xs[xs.length - 1]!, 2_400);
  const height = Math.min(ys[ys.length - 1]!, 1_600);
  const out: string[] = [
    `<rect width="${num(width)}" height="${header}" fill="#f3f3f3"/>`,
    `<rect width="${gutter}" height="${num(height)}" fill="#f3f3f3"/>`,
  ];
  const grid: string[] = [];
  for (const x of xs) grid.push(`M${num(x)} 0V${num(height)}`);
  for (const y of ys) grid.push(`M0 ${num(y)}H${num(width)}`);
  out.push(`<path d="${grid.join("")}" stroke="#dcdcdc" stroke-width="1" fill="none"/>`);
  widths.forEach((columnWidth, index) =>
    out.push(
      textElement({
        x: xs[index]! + columnWidth / 2,
        y: 15,
        size: 11,
        text: columnName(startColumn + index),
        color: "#6b6b6b",
        anchor: "middle",
      }),
    ),
  );
  heights.forEach((rowHeight, index) =>
    out.push(
      textElement({
        x: gutter / 2,
        y: ys[index]! + rowHeight / 2 + 4,
        size: 11,
        text: String(startRow + index + 1),
        color: "#6b6b6b",
        anchor: "middle",
      }),
    ),
  );
  for (const cell of viewport?.cells ?? []) {
    if (out.length >= MAX_TEXT_ELEMENTS) break;
    const row = cell.row - startRow;
    const column = cell.column - startColumn;
    if (row < 0 || column < 0 || row >= rows || column >= columns) continue;
    const { text, numeric } = cellText(cell);
    if (!text) continue;
    const columnWidth = widths[column]!;
    // Text is clipped to its column; a number is never shown cut short.
    const fitted = numeric ? text : text.slice(0, Math.max(1, Math.floor((columnWidth - 8) / 6.4)));
    out.push(
      textElement({
        x: numeric ? xs[column]! + columnWidth - 5 : xs[column]! + 5,
        y: ys[row]! + heights[row]! / 2 + 4.5,
        size: 12,
        text: fitted,
        anchor: numeric ? "end" : "start",
        weight: row === 0 && !numeric ? 600 : 400,
      }),
    );
  }
  return svg(width, height, "#ffffff", out, "xMinYMin");
}
