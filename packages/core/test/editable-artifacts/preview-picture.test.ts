import { describe, expect, test } from "bun:test";

import {
  documentPreviewSvg,
  presentationPreviewSvg,
  spreadsheetPreviewSvg,
  xmlText,
} from "../../src/domain/editable-artifacts/preview-picture";

type DocumentArgs = Parameters<typeof documentPreviewSvg>;
type PresentationArgs = Parameters<typeof presentationPreviewSvg>;
type SpreadsheetArgs = Parameters<typeof spreadsheetPreviewSvg>;

const HOSTILE = `</text><script>alert(1)</script><a href="javascript:x">&'"`;

/** Nothing that can run, link out or load: shapes and text only. */
function expectInert(svg: string) {
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  expect(svg.endsWith("</svg>")).toBe(true);
  const markup = svg.replace(/(<text[^>]*>)[^<]*<\/text>/g, "$1</text>");
  expect(markup).not.toMatch(
    /<script|<a[\s>]|<foreignObject|<image|<use|<style|href=|\son[a-z]+=|url\(/i,
  );
  const tags = new Set([...markup.matchAll(/<([a-zA-Z]+)/g)].map((match) => match[1]));
  for (const tag of tags)
    expect(["svg", "rect", "text", "line", "path", "ellipse", "polygon", "g"]).toContain(tag!);
}

const texts = (svg: string) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

const run = (text: string, style: Record<string, unknown> = {}) => ({ text, style });
const paragraph = (text: string, style: Record<string, unknown> = {}, runStyle = {}) => ({
  kind: "paragraph",
  id: text,
  runs: [run(text, runStyle)],
  style,
});

function documentPicture(items: unknown[], page?: Record<string, bigint>) {
  const summary = {
    items: [
      {
        kind: "summary",
        page: page ?? {
          widthMillipoints: 612_000n,
          heightMillipoints: 792_000n,
          marginLeftMillipoints: 72_000n,
          marginRightMillipoints: 72_000n,
          marginTopMillipoints: 72_000n,
        },
      },
    ],
  } as unknown as DocumentArgs[0];
  return documentPreviewSvg(summary, { items } as unknown as DocumentArgs[1]);
}

describe("artifact card pictures", () => {
  test("escapes text and drops characters XML cannot carry", () => {
    expect(xmlText(`a<b>&"c'\u0000\u0007\ud800d\te`)).toBe("a&lt;b&gt;&amp;&quot;c&#39;d e");
    expect(xmlText("x".repeat(900)).length).toBe(400);
  });

  test("a document shows its first page: headings, paragraphs, lists and tables", () => {
    const svg = documentPicture([
      paragraph("Q3 launch plan", { headingLevel: 1 }),
      paragraph("We ship the new onboarding in three phases."),
      paragraph("Private beta", { list: { kind: "number", level: 0 } }),
      paragraph("General availability", { list: { kind: "number", level: 0 } }),
      {
        kind: "table",
        id: "t",
        rows: [
          [[run("Milestone")], [run("Owner")]],
          [[run("Beta")], [run("Ana")]],
        ],
        style: { headerRows: 1 },
      },
      { kind: "page-break", id: "pb" },
      paragraph("Second page text"),
    ]);
    expectInert(svg);
    expect(svg).toContain('viewBox="0 0 612 792"');
    const shown = texts(svg);
    expect(shown).toEqual(
      expect.arrayContaining([
        "Q3 launch plan",
        "1.",
        "Private beta",
        "2.",
        "General availability",
        "Milestone",
        "Ana",
      ]),
    );
    expect(shown).not.toContain("Second page text");
    // The heading is larger and bolder than body text.
    expect(svg).toMatch(/font-size="22" font-weight="650"[^>]*>Q3 launch plan</);
  });

  test("a document's hostile text stays text, and its colors are reduced to hex", () => {
    const svg = documentPicture([
      paragraph(HOSTILE, {}, { color: '"/><script>' }),
      paragraph("Blue", {}, { color: "#3366FF" }),
    ]);
    expectInert(svg);
    expect(svg).toContain("&lt;/text&gt;&lt;script&gt;");
    expect(svg).toContain('fill="#3366ff">Blue<');
  });

  test("a document with absurd geometry still draws a bounded page", () => {
    const svg = documentPicture([paragraph("Hello")], {
      widthMillipoints: 10n ** 15n,
      heightMillipoints: 0n,
    });
    expectInert(svg);
    expect(svg).toContain('viewBox="0 0 2000 792"');
  });

  test("a slide shows its background, shapes and text in slide units", () => {
    const emu = (pixels: number) => pixels * 9_525;
    const node = (id: string, content: unknown, extra: Record<string, unknown> = {}) => ({
      id,
      source: { kind: "slide", id: "s1" },
      inherited: false,
      parentId: null,
      order: 0,
      name: id,
      bounds: { x: emu(40), y: emu(40), width: emu(800), height: emu(120) },
      transform: { rotation: 0, flipHorizontal: false, flipVertical: false },
      content,
      ...extra,
    });
    const solid = (color: number) => ({ kind: "solid", color });
    const noLine = { fill: { kind: "none" }, width: 0, dash: "solid" };
    const slide = {
      kind: "editor-slide",
      slide: { background: solid(0x0b1f3aff), layout: null },
      nodes: [
        node("title", {
          kind: "shape",
          geometry: "text-box",
          fill: { kind: "none" },
          line: noLine,
          text: {
            verticalAlignment: "top",
            paragraphs: [
              {
                alignment: "left",
                runs: [
                  {
                    text: "Quarterly review",
                    style: {
                      fontSizeCentipoints: 4_000,
                      color: 0xffffffff,
                      bold: true,
                      italic: false,
                    },
                  },
                ],
              },
            ],
          },
        }),
        node(
          "badge",
          { kind: "shape", geometry: "ellipse", fill: solid(0xff663380), line: noLine, text: null },
          {
            order: 1,
            transform: { rotation: 2_700_000, flipHorizontal: false, flipVertical: false },
          },
        ),
      ],
    } as unknown as PresentationArgs[1];
    const svg = presentationPreviewSvg({ width: emu(1280), height: emu(720) }, slide);
    expectInert(svg);
    expect(svg).toContain('viewBox="0 0 1280 720"');
    expect(svg).toContain('fill="#0b1f3a"');
    expect(texts(svg)).toEqual(["Quarterly review"]);
    // 40pt is 53.33px; white, bold.
    expect(svg).toMatch(/font-size="53.33" font-weight="700"[^>]*fill="#ffffff">Quarterly review</);
    // Half-transparent orange, rotated 45 degrees (rotation is in 60,000ths).
    expect(svg).toContain('fill="#ff6633" fill-opacity="0.5"');
    expect(svg).toContain("rotate(45 440 100)");
  });

  test("an empty deck draws a blank white slide", () => {
    const svg = presentationPreviewSvg({ width: 0, height: 0 }, null);
    expectInert(svg);
    expect(svg).toContain('viewBox="0 0 1280 720"');
  });

  test("a sheet shows its grid, headers and first cells", () => {
    const sheet = {
      defaultRowHeight: 20,
      defaultColumnWidth: 80,
      rowHeights: [],
      columnWidths: [[0, 140]],
    } as unknown as SpreadsheetArgs[0];
    const cell = (row: number, column: number, value: unknown) => ({
      row,
      column,
      formula: null,
      value,
    });
    const viewport = {
      startRow: 0,
      startColumn: 0,
      rowCount: 3,
      columnCount: 2,
      defaultRowHeight: 20,
      defaultColumnWidth: 80,
      rowHeights: [],
      columnWidths: [[0, 140]],
      cells: [
        cell(0, 0, { kind: "text", value: "Region" }),
        cell(0, 1, { kind: "text", value: "Revenue" }),
        cell(1, 0, { kind: "text", value: HOSTILE }),
        cell(1, 1, { kind: "number", value: 1_234_567.891 }),
        cell(2, 1, { kind: "error", code: "div0" }),
        cell(9, 9, { kind: "text", value: "outside" }),
      ],
    } as unknown as SpreadsheetArgs[1];
    const svg = spreadsheetPreviewSvg(sheet, viewport);
    expectInert(svg);
    // Gutter 36 + 140 + 80 wide, header 22 + 3 rows of 20 high.
    expect(svg).toContain('viewBox="0 0 256 82"');
    const shown = texts(svg);
    expect(shown).toEqual(
      expect.arrayContaining([
        "A",
        "B",
        "1",
        "2",
        "3",
        "Region",
        "Revenue",
        "1,234,567.89",
        "#ERROR",
      ]),
    );
    expect(shown).not.toContain("outside");
    expect(svg).toMatch(/text-anchor="end"[^>]*>1,234,567.89</);
  });
});
