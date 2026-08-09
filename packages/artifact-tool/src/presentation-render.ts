import { FileBlob } from "./file-blob";
import { rasterizeSvgToPng } from "./native-raster";
import {
  assertPresentationRenderPixelBudget,
  InvalidPresentationInputError,
  presentationColorValue,
  truncatePresentationText,
  UnsupportedPresentationFeatureError,
  type Presentation,
  type PresentationChart,
  type PresentationExportOptions,
  type PresentationImage,
  type PresentationLine,
  type PresentationPosition,
  type PresentationGroup,
  type PresentationShape,
  type PresentationTable,
  type PresentationText,
  type Slide,
} from "./presentation";

const colorValue = presentationColorValue;
const truncate = truncatePresentationText;

type MontageDimensions = {
  columns: number;
  rows: number;
  gap: number;
  width: number;
  height: number;
};

export type PresentationRenderJob =
  | {
      kind: "slide";
      slide: Slide;
      format: Exclude<PresentationExportOptions["format"], "layout">;
      scale: number;
      name: string;
      dimensions: { width: number; height: number };
    }
  | {
      kind: "montage";
      presentation: Presentation;
      format: Exclude<PresentationExportOptions["format"], "layout">;
      scale: number;
      name: string;
      dimensions: MontageDimensions;
    };

export async function executePresentationRender(job: PresentationRenderJob): Promise<FileBlob> {
  const svg =
    job.kind === "slide"
      ? renderSlideSvg(job.slide)
      : renderMontageSvg(job.presentation, job.dimensions);
  return await imageBlob(svg, job.format, job.scale, job.name, job.dimensions);
}

function renderSlideSvg(slide: Slide): string {
  const { width, height } = slide.presentation.slideSize;
  const defs: string[] = [];
  const elements: string[] = [];
  for (const element of slide.elements) {
    if ("geometry" in element && "text" in element) elements.push(renderShapeSvg(element));
    else if ("series" in element) elements.push(renderChartSvg(element));
    else if ("sourceForSvg" in element) elements.push(renderImageSvg(element, defs));
    else if ("rows" in element) elements.push(renderTableSvg(element));
    else if ("children" in element) elements.push(renderGroupSvg(element, defs));
  }
  return svgDocument(
    width,
    height,
    colorValue(slide.background.fill),
    defs.join(""),
    elements.join(""),
  );
}

function renderGroupSvg(group: PresentationGroup, defs: string[]): string {
  const children = group.children.map((child) => {
    if ("geometry" in child && "text" in child) return renderShapeSvg(child);
    if ("series" in child) return renderChartSvg(child);
    if ("sourceForSvg" in child) return renderImageSvg(child, defs);
    if ("rows" in child) return renderTableSvg(child);
    if ("children" in child) return renderGroupSvg(child, defs);
    return "";
  });
  const sx = group.position.width / group.childExtent.width;
  const sy = group.position.height / group.childExtent.height;
  const translatedX = group.position.left - group.childOffset.left * sx;
  const translatedY = group.position.top - group.childOffset.top * sy;
  const centerX = group.position.left + group.position.width / 2;
  const centerY = group.position.top + group.position.height / 2;
  const outer = [
    `translate(${centerX} ${centerY})`,
    group.rotation === 0 ? "" : `rotate(${group.rotation})`,
    `scale(${group.flipHorizontal ? -1 : 1} ${group.flipVertical ? -1 : 1})`,
    `translate(${-centerX} ${-centerY})`,
  ]
    .filter(Boolean)
    .join(" ");
  return `<g data-presentation-group="${escapeXml(group.id)}" transform="${outer}"><g transform="translate(${translatedX} ${translatedY}) scale(${sx} ${sy})">${children.join("")}</g></g>`;
}

function renderTableSvg(table: PresentationTable): string {
  const position = table.position;
  const rowCount = table.rows.length;
  const columnCount = table.rows[0]?.length ?? 0;
  if (rowCount === 0 || columnCount === 0) return "";
  const columnWidths = normalizeTracks(table.columnWidths, columnCount, position.width);
  const rowHeights = normalizeTracks(table.rowHeights, rowCount, position.height);
  const fragments: string[] = [];
  let y = position.top;
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    let x = position.left;
    const row = table.rows[rowIndex]!;
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const cell = row[columnIndex]!;
      const width = columnWidths[columnIndex]!;
      const height = rowHeights[rowIndex]!;
      if (cell === null) {
        x += width;
        continue;
      }
      const cellPosition = {
        left: x + 4,
        top: y + 2,
        width: Math.max(1, width - 8),
        height: Math.max(1, height - 4),
      };
      fragments.push(
        `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${colorValue(cell.fill)}" ${lineSvgAttributes(table.line)}/>${renderTextSvg(cell.text, cellPosition)}`,
      );
      x += width;
    }
    y += rowHeights[rowIndex]!;
  }
  return `<g data-presentation-table="${escapeXml(table.id)}">${fragments.join("")}</g>`;
}

function normalizeTracks(values: readonly number[], count: number, total: number): number[] {
  if (values.length !== count) return Array.from({ length: count }, () => total / count);
  const sum = values.reduce((value, next) => value + next, 0);
  return values.map((value) => (value / sum) * total);
}

function renderShapeSvg(shape: PresentationShape): string {
  const p = shape.position;
  const fill = colorValue(shape.fill);
  const stroke = lineSvgAttributes(shape.line);
  const transform =
    shape.rotation === 0
      ? ""
      : ` transform="rotate(${shape.rotation} ${p.left + p.width / 2} ${p.top + p.height / 2})"`;
  let geometry: string;
  switch (shape.geometry) {
    case "textbox":
      geometry = "";
      break;
    case "rect":
      geometry = `<rect x="${p.left}" y="${p.top}" width="${p.width}" height="${p.height}" fill="${fill}" ${stroke}/>`;
      break;
    case "roundRect": {
      const radius = resolveRadius(shape.borderRadius, p);
      geometry = `<rect x="${p.left}" y="${p.top}" width="${p.width}" height="${p.height}" rx="${radius}" fill="${fill}" ${stroke}/>`;
      break;
    }
    case "ellipse":
      geometry = `<ellipse cx="${p.left + p.width / 2}" cy="${p.top + p.height / 2}" rx="${p.width / 2}" ry="${p.height / 2}" fill="${fill}" ${stroke}/>`;
      break;
    case "triangle":
      geometry = `<path d="M ${p.left + p.width / 2} ${p.top} L ${p.left + p.width} ${p.top + p.height} L ${p.left} ${p.top + p.height} Z" fill="${fill}" ${stroke}/>`;
      break;
    case "rightArrow": {
      const shaft = p.width * 0.62;
      geometry = `<path d="M ${p.left} ${p.top + p.height * 0.25} H ${p.left + shaft} V ${p.top} L ${p.left + p.width} ${p.top + p.height / 2} L ${p.left + shaft} ${p.top + p.height} V ${p.top + p.height * 0.75} H ${p.left} Z" fill="${fill}" ${stroke}/>`;
      break;
    }
    case "line":
      geometry = `<line x1="${p.left}" y1="${p.top}" x2="${p.left + p.width}" y2="${p.top + p.height}" ${stroke}/>`;
      break;
    default:
      throw new UnsupportedPresentationFeatureError(`SVG shape geometry ${String(shape.geometry)}`);
  }
  const text = renderTextSvg(shape.text, p);
  return `<g${transform}>${geometry}${text}</g>`;
}

function renderTextSvg(text: PresentationText, position: PresentationPosition): string {
  const value = text.toString();
  if (!value) return "";
  const style = text.style;
  const fontSize = style.fontSize ?? 18;
  const lineHeight = fontSize * 1.2;
  const lines = wrapText(value, position.width, fontSize);
  const anchor =
    style.alignment === "center" ? "middle" : style.alignment === "right" ? "end" : "start";
  const x =
    style.alignment === "center"
      ? position.left + position.width / 2
      : style.alignment === "right"
        ? position.left + position.width
        : position.left;
  const textHeight = Math.max(lineHeight, lines.length * lineHeight);
  const top =
    style.verticalAlignment === "middle"
      ? position.top + (position.height - textHeight) / 2
      : style.verticalAlignment === "bottom"
        ? position.top + position.height - textHeight
        : position.top;
  const spans = lines
    .map(
      (line, index) =>
        `<tspan x="${x}" y="${top + fontSize + index * lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("");
  return `<text font-family="${escapeXml(style.fontFamily ?? "Arial")}" font-size="${fontSize}" font-weight="${style.bold ? 700 : 400}" font-style="${style.italic ? "italic" : "normal"}" text-decoration="${style.underline ? "underline" : "none"}" text-anchor="${anchor}" fill="${colorValue(style.color ?? "slate-950")}">${spans}</text>`;
}

function renderChartSvg(chart: PresentationChart): string {
  const p = chart.position;
  const pad = { left: 52, right: 20, top: chart.title ? 46 : 24, bottom: 40 };
  const plot = {
    left: p.left + pad.left,
    top: p.top + pad.top,
    width: Math.max(1, p.width - pad.left - pad.right),
    height: Math.max(1, p.height - pad.top - pad.bottom),
  };
  const values = chart.series.items.flatMap((series) => series.values).filter(Number.isFinite);
  const min = Math.min(0, chart.yAxis?.min ?? Math.min(...values, 0));
  const max = Math.max(1, chart.yAxis?.max ?? Math.max(...values, 1));
  const palette = ["#2563eb", "#0f766e", "#f59e0b", "#dc2626", "#7c3aed"];
  const title = chart.title
    ? `<text x="${p.left + p.width / 2}" y="${p.top + 24}" text-anchor="middle" font-family="Arial" font-size="18" font-weight="700" fill="#0f172a">${escapeXml(chart.title)}</text>`
    : "";
  const frame = `<rect x="${p.left}" y="${p.top}" width="${p.width}" height="${p.height}" fill="#ffffff" stroke="#e2e8f0"/>`;
  const axes = `<line x1="${plot.left}" y1="${plot.top + plot.height}" x2="${plot.left + plot.width}" y2="${plot.top + plot.height}" stroke="#94a3b8"/><line x1="${plot.left}" y1="${plot.top}" x2="${plot.left}" y2="${plot.top + plot.height}" stroke="#94a3b8"/>`;
  let marks: string;
  switch (chart.type) {
    case "bar":
      marks = renderBarMarks(chart, plot, min, max, palette);
      break;
    case "line":
    case "area":
      marks = renderLineMarks(chart, plot, min, max, palette, chart.type === "area");
      break;
    case "pie":
    case "doughnut":
      marks = renderPieMarks(chart, plot, palette, chart.type === "doughnut");
      break;
    case "scatter":
    case "bubble":
      marks = renderScatterMarks(chart, plot, palette, chart.type === "bubble");
      break;
    case "radar":
      throw new UnsupportedPresentationFeatureError(
        "SVG radar chart export",
        `Chart ${chart.id} remains editable and exportable to PPTX`,
      );
    default:
      throw new UnsupportedPresentationFeatureError(`SVG chart type ${String(chart.type)}`);
  }
  return `<g>${frame}${title}${chart.type === "pie" || chart.type === "doughnut" ? "" : axes}${marks}</g>`;
}

function renderBarMarks(
  chart: PresentationChart,
  plot: PresentationPosition,
  min: number,
  max: number,
  palette: string[],
): string {
  const count = Math.max(1, ...chart.series.items.map((series) => series.values.length));
  const groupWidth = plot.width / count;
  const barWidth = Math.max(2, (groupWidth * 0.72) / Math.max(1, chart.series.items.length));
  return chart.series.items
    .flatMap((series, seriesIndex) =>
      series.values.map((value, valueIndex) => {
        const height = Math.max(0, ((value - min) / (max - min)) * plot.height);
        const x = plot.left + valueIndex * groupWidth + groupWidth * 0.14 + seriesIndex * barWidth;
        const y = plot.top + plot.height - height;
        const label = chart.dataLabels?.showValue
          ? `<text x="${x + barWidth / 2}" y="${Math.max(plot.top + 12, y - 4)}" text-anchor="middle" font-family="Arial" font-size="12" fill="#334155">${value}</text>`
          : "";
        return `<rect x="${x}" y="${y}" width="${barWidth}" height="${height}" fill="${colorValue(series.fill ?? palette[seriesIndex % palette.length]!)}"/>${label}`;
      }),
    )
    .join("");
}

function renderLineMarks(
  chart: PresentationChart,
  plot: PresentationPosition,
  min: number,
  max: number,
  palette: string[],
  area: boolean,
): string {
  return chart.series.items
    .map((series, seriesIndex) => {
      const divisor = Math.max(1, series.values.length - 1);
      const points = series.values.map((value, index) => ({
        x: plot.left + (index / divisor) * plot.width,
        y: plot.top + plot.height - ((value - min) / (max - min)) * plot.height,
      }));
      if (points.length === 0) return "";
      const polyline = points.map((point) => `${point.x},${point.y}`).join(" ");
      const color = colorValue(
        series.line?.fill ?? series.fill ?? palette[seriesIndex % palette.length]!,
      );
      const fill = area
        ? `<path d="M ${plot.left} ${plot.top + plot.height} L ${polyline.replaceAll(",", " ")} L ${plot.left + plot.width} ${plot.top + plot.height} Z" fill="${color}" opacity="0.22"/>`
        : "";
      const dots = points
        .map((point) => `<circle cx="${point.x}" cy="${point.y}" r="3" fill="${color}"/>`)
        .join("");
      return `${fill}<polyline points="${polyline}" fill="none" stroke="${color}" stroke-width="${series.line?.width ?? 3}"/>${dots}`;
    })
    .join("");
}

function renderPieMarks(
  chart: PresentationChart,
  plot: PresentationPosition,
  palette: string[],
  doughnut: boolean,
): string {
  const values = chart.series.items[0]?.values ?? [];
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) return "";
  const radius = Math.min(plot.width, plot.height) * 0.42;
  const cx = plot.left + plot.width / 2;
  const cy = plot.top + plot.height / 2;
  let angle = -Math.PI / 2;
  const slices = values
    .map((value, index) => {
      const next = angle + (Math.max(0, value) / total) * Math.PI * 2;
      const large = next - angle > Math.PI ? 1 : 0;
      const x1 = cx + radius * Math.cos(angle);
      const y1 = cy + radius * Math.sin(angle);
      const x2 = cx + radius * Math.cos(next);
      const y2 = cy + radius * Math.sin(next);
      const path = `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z" fill="${palette[index % palette.length]}"/>`;
      angle = next;
      return path;
    })
    .join("");
  const hole = doughnut
    ? `<circle cx="${cx}" cy="${cy}" r="${radius * 0.55}" fill="#ffffff"/>`
    : "";
  return `${slices}${hole}`;
}

function renderScatterMarks(
  chart: PresentationChart,
  plot: PresentationPosition,
  palette: string[],
  bubble: boolean,
): string {
  const allX = chart.series.items.flatMap((series) => series.xValues);
  const allY = chart.series.items.flatMap((series) => series.values);
  const minX = Math.min(...allX, 0);
  const maxX = Math.max(...allX, 1);
  const minY = Math.min(...allY, 0);
  const maxY = Math.max(...allY, 1);
  return chart.series.items
    .map((series, seriesIndex) =>
      series.values
        .map((value, index) => {
          const xValue = series.xValues[index] ?? index;
          const x = plot.left + ((xValue - minX) / (maxX - minX)) * plot.width;
          const y = plot.top + plot.height - ((value - minY) / (maxY - minY)) * plot.height;
          const radius = bubble
            ? Math.max(3, Math.sqrt(Math.max(0, series.bubbleSizes[index] ?? 9)))
            : 4;
          return `<circle cx="${x}" cy="${y}" r="${radius}" fill="${colorValue(series.fill ?? palette[seriesIndex % palette.length]!)}" opacity="0.8"/>`;
        })
        .join(""),
    )
    .join("");
}

function renderImageSvg(image: PresentationImage, defs: string[]): string {
  const p = image.position;
  const source = image.sourceForSvg();
  if (!source) {
    return `<g><rect x="${p.left}" y="${p.top}" width="${p.width}" height="${p.height}" fill="#f1f5f9" stroke="#94a3b8" stroke-dasharray="8 6"/><text x="${p.left + 16}" y="${p.top + 28}" font-family="Arial" font-size="14" fill="#475569">Image prompt: ${escapeXml(truncate(image.prompt ?? "", 100))}</text></g>`;
  }
  const clipId = `clip-${image.id.replace("/", "-")}`;
  const radius = resolveRadius(image.borderRadius, p);
  const clipShape =
    image.geometry === "ellipse"
      ? `<ellipse cx="${p.left + p.width / 2}" cy="${p.top + p.height / 2}" rx="${p.width / 2}" ry="${p.height / 2}"/>`
      : `<rect x="${p.left}" y="${p.top}" width="${p.width}" height="${p.height}" rx="${image.geometry === "roundRect" ? radius : 0}"/>`;
  defs.push(`<clipPath id="${clipId}">${clipShape}</clipPath>`);
  const preserve = image.fit === "cover" ? "xMidYMid slice" : "xMidYMid meet";
  const transform = [
    image.flipHorizontal ? `translate(${2 * p.left + p.width} 0) scale(-1 1)` : "",
    image.flipVertical ? `translate(0 ${2 * p.top + p.height}) scale(1 -1)` : "",
    image.rotation
      ? `rotate(${image.rotation} ${p.left + p.width / 2} ${p.top + p.height / 2})`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<image href="${escapeXml(source)}" x="${p.left}" y="${p.top}" width="${p.width}" height="${p.height}" preserveAspectRatio="${preserve}" clip-path="url(#${clipId})"${transform ? ` transform="${transform}"` : ""}/>`;
}

function renderMontageSvg(presentation: Presentation, dimensions: MontageDimensions): string {
  const { columns, gap, width, height } = dimensions;
  const slides = presentation.slides.items
    .map((slide, index) => {
      const x = gap + (index % columns) * (presentation.slideSize.width + gap);
      const y = gap + Math.floor(index / columns) * (presentation.slideSize.height + gap);
      const inner = renderSlideSvg(slide)
        .replace(/^<svg[^>]*>/, "")
        .replace(/<\/svg>$/, "");
      return `<g transform="translate(${x} ${y})">${inner}</g>`;
    })
    .join("");
  return svgDocument(width, height, "#cbd5e1", "", slides);
}

async function imageBlob(
  svg: string,
  format: "svg" | "png" | "webp",
  scale = 1,
  name: string,
  dimensions: { width: number; height: number },
): Promise<FileBlob> {
  if (!Number.isFinite(scale) || scale <= 0 || scale > 8) {
    throw new InvalidPresentationInputError("export scale", "must be greater than 0 and at most 8");
  }
  if (format === "svg") return new FileBlob([svg], { name, type: "image/svg+xml" });
  assertPresentationRenderPixelBudget(dimensions.width, dimensions.height, scale);
  const png = await rasterizeSvgToPng(svg, { zoom: scale });
  if (format === "png") return FileBlob.fromBytes(png, { name, type: "image/png" });
  const { default: sharp } = await importNativeRuntime<SharpModuleRuntime>("sharp");
  const webp = await sharp(png).webp({ quality: 90, smartSubsample: true }).toBuffer();
  return FileBlob.fromBytes(webp, { name, type: "image/webp" });
}

function svgDocument(
  width: number,
  height: number,
  background: string,
  defs: string,
  body: string,
): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${defs}</defs><rect width="${width}" height="${height}" fill="${background}"/>${body}</svg>`;
}
function lineSvgAttributes(line: PresentationLine): string {
  if (
    line.style === "none" ||
    colorValue(line.fill ?? "none") === "none" ||
    (line.width ?? 1) === 0
  ) {
    return 'stroke="none"';
  }
  const dash =
    line.style === "dash"
      ? ' stroke-dasharray="8 5"'
      : line.style === "dot"
        ? ' stroke-dasharray="2 4"'
        : "";
  return `stroke="${colorValue(line.fill ?? "slate-900")}" stroke-width="${line.width ?? 1}"${dash}`;
}

function resolveRadius(
  radius: number | string | undefined,
  position: PresentationPosition,
): number {
  if (typeof radius === "number") return Math.max(0, radius);
  const token = radius ?? "rounded-xl";
  if (token === "rounded-full") return Math.min(position.width, position.height) / 2;
  const resolved = BORDER_RADIUS_TOKENS[token];
  if (resolved === undefined) {
    throw new InvalidPresentationInputError("borderRadius", "uses an unsupported radius token");
  }
  return resolved;
}

function wrapText(value: string, width: number, fontSize: number): string[] {
  const maxCharacters = Math.max(1, Math.floor(width / Math.max(1, fontSize * 0.56)));
  const lines: string[] = [];
  for (const hardLine of value.split("\n")) {
    const words = hardLine.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      if (!current || current.length + 1 + word.length <= maxCharacters) {
        current = current ? `${current} ${word}` : word;
      } else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines;
}
function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const BORDER_RADIUS_TOKENS: Readonly<Record<string, number>> = {
  rounded: 4,
  "rounded-lg": 8,
  "rounded-xl": 12,
  "rounded-2xl": 16,
  "rounded-3xl": 24,
};

type SharpModuleRuntime = {
  default: (input: Uint8Array) => {
    webp(options: { quality: number; smartSubsample: boolean }): {
      toBuffer(): Promise<Uint8Array>;
    };
  };
};

async function importNativeRuntime<T>(specifier: string): Promise<T> {
  return (await import(/* @vite-ignore */ specifier)) as T;
}
