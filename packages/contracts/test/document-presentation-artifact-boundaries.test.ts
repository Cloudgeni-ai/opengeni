import { describe, expect, test } from "bun:test";

import {
  DOCUMENT_ARTIFACT_COMMAND_MAX_COMMANDS,
  DOCUMENT_ARTIFACT_MAX_TEXT_UTF16,
  decodeDocumentArtifactCommandBatch,
  decodeDocumentArtifactQuery,
  decodeDocumentArtifactQueryResponse,
  encodeDocumentArtifactCommandBatch,
  encodeDocumentArtifactQuery,
  encodeDocumentArtifactQueryResponse,
  type DocumentArtifactCommand,
  type DocumentArtifactProjection,
} from "../src/document-artifact-commands";
import {
  PRESENTATION_ARTIFACT_COMMAND_MAX_COMMANDS,
  decodePresentationArtifactCommandBatch,
  decodePresentationArtifactQuery,
  decodePresentationArtifactQueryResponse,
  encodePresentationArtifactCommandBatch,
  encodePresentationArtifactQuery,
  encodePresentationArtifactQueryResponse,
  type PresentationArtifactCommand,
  type PresentationArtifactNodeKind,
  type PresentationArtifactQueryResponse,
  type PresentationArtifactRichText,
} from "../src/presentation-artifact-commands";
import fixture from "./fixtures/editable-artifact-modalities-v1.json";

const namespace = "0123456789abcdef";
const id = (prefix: string, counter: number): string =>
  `${prefix}/${namespace}${counter.toString(16).padStart(16, "0")}`;
const stableId = (counter: number): string =>
  `${namespace}${counter.toString(16).padStart(16, "0")}`;

describe("document artifact codec boundaries", () => {
  test("round-trips every command and projection item variant", () => {
    const commands: DocumentArtifactCommand[] = [
      { kind: "document.flags.set", evenAndOddHeaders: null, trackRevisions: false },
      {
        kind: "paragraph.add",
        target: {
          kind: "section",
          sectionId: id("sec", 12),
          storyKind: "header",
          variant: "even",
        },
        id: id("p", 8),
        runs: [
          {
            text: "A😀",
            style: {
              fontFamily: "Inter",
              fontSizePt: 11.5,
              color: "#abcdef",
              bold: true,
              italic: false,
              underline: true,
              strike: false,
            },
          },
        ],
        style: {
          headingLevel: 2,
          alignment: "justify",
          spaceBeforePt: 1,
          spaceAfterPt: 2,
          lineHeight: 1.2,
          keepNext: true,
          pageBreakBefore: false,
          list: { kind: "number", level: 3, instanceId: "list-a" },
        },
      },
      {
        kind: "paragraph.edit",
        id: id("p", 8),
        range: { start: 0, end: 1 },
        replacement: "B",
        style: { bold: false },
      },
      {
        kind: "paragraph.format",
        id: id("p", 8),
        range: { start: 0, end: 1 },
        style: { fontFamily: null, fontSizePt: 9, bold: true },
      },
      { kind: "paragraph.style.set", id: id("p", 8), style: { alignment: "center" } },
      {
        kind: "table.add",
        target: { kind: "body" },
        id: id("dt", 9),
        rows: [[[{ text: "C", style: {} }]]],
        style: {
          widthPt: 100,
          columnWidthsPt: [100],
          headerRows: 1,
          cellPaddingPt: 3,
          borderColor: "#000",
          headerFill: "#fff",
          allowRowSplit: false,
        },
      },
      { kind: "table.style.set", id: id("dt", 9), style: {} },
      { kind: "page-break.add", id: id("pb", 10) },
      {
        kind: "section.add",
        ids: {
          section: id("sec", 12),
          headerDefault: id("hdr", 13),
          headerFirst: id("hdr", 14),
          headerEven: id("hdr", 15),
          footerDefault: id("ftr", 16),
          footerFirst: id("ftr", 17),
          footerEven: id("ftr", 18),
        },
        page: {
          widthPt: 612,
          heightPt: 792,
          marginTopPt: 72,
          marginRightPt: 72,
          marginBottomPt: 72,
          marginLeftPt: 72,
        },
        titlePage: true,
      },
      { kind: "section.title-page.set", id: id("sec", 12), titlePage: null },
      {
        kind: "section.page.set",
        id: id("sec", 12),
        page: {
          widthPt: 792,
          heightPt: 612,
          marginTopPt: 54,
          marginRightPt: 54,
          marginBottomPt: 54,
          marginLeftPt: 54,
          headerPt: 27.5,
          footerPt: 31.25,
          gutterPt: 9.5,
        },
      },
      {
        kind: "comment.add",
        id: id("dc", 19),
        paragraphId: id("p", 8),
        range: { start: 0, end: 1 },
        resolved: false,
        root: { author: "a", text: "c", createdAt: "d" },
      },
      {
        kind: "comment.reply.add",
        id: id("dc", 19),
        reply: { author: "e", text: "f", createdAt: "g" },
      },
      { kind: "comment.resolved.set", id: id("dc", 19), resolved: true },
      {
        kind: "tracked-change.add",
        id: id("chg", 20),
        paragraphId: id("p", 8),
        range: { start: 0, end: 1 },
        changeKind: "delete",
        author: "h",
        createdAt: "i",
      },
    ];
    const encoded = encodeDocumentArtifactCommandBatch({ version: 1, commands });
    expect(encodeDocumentArtifactCommandBatch(decodeDocumentArtifactCommandBatch(encoded))).toEqual(
      encoded,
    );

    const projection: DocumentArtifactProjection = {
      revision: 7n,
      nextCursor: 9,
      truncated: true,
      projectedTextUtf16: 9,
      projectedTableCells: 1,
      items: [
        {
          kind: "section",
          id: id("sec", 12),
          startBlockIndex: 0,
          titlePage: true,
          page: {
            widthMillipoints: 612000n,
            heightMillipoints: 792000n,
            marginTopMillipoints: 72000n,
            marginRightMillipoints: 72000n,
            marginBottomMillipoints: 72000n,
            marginLeftMillipoints: 72000n,
            headerMillipoints: 27500n,
            footerMillipoints: 31250n,
            gutterMillipoints: 9500n,
          },
          headerBlockCounts: [1, 2, 3],
          footerBlockCounts: [4, 5, 6],
        },
        { kind: "paragraph", id: id("p", 8), runs: [{ text: "A😀", style: {} }], style: {} },
        { kind: "table", id: id("dt", 9), rows: [[[{ text: "B", style: {} }]]], style: {} },
        { kind: "page-break", id: id("pb", 10) },
        {
          kind: "comment",
          id: id("dc", 19),
          paragraphId: id("p", 8),
          range: { start: 0, end: 1 },
          resolved: false,
          replies: [{ author: "a", text: "c", createdAt: "d" }],
        },
        {
          kind: "tracked-change",
          id: id("chg", 20),
          paragraphId: id("p", 8),
          changeKind: "insert",
          range: { start: 0, end: 1 },
          author: "e",
          createdAt: "f",
        },
      ],
    };
    const response = encodeDocumentArtifactQueryResponse(projection);
    const decodedProjection = decodeDocumentArtifactQueryResponse(response);
    expect(decodedProjection).toEqual(projection);
    expect(encodeDocumentArtifactQueryResponse(decodedProjection)).toEqual(response);

    const unknownExtension = response.slice();
    unknownExtension[unknownExtension.byteLength - 8 - 34] = 0xfe;
    writeChecksum(unknownExtension);
    expect(() => decodeDocumentArtifactQueryResponse(unknownExtension)).toThrow(
      "unknown document query response extension",
    );
  });

  test("checks UTF-8, UTF-16, command, query, and checksum boundaries", () => {
    const rust = Uint8Array.fromHex(fixture.documentCommandsHex);
    expect(() => decodeDocumentArtifactCommandBatch(corruptUtf8(rust, "Hello"))).toThrow(/UTF-8/u);
    expect(() =>
      encodeDocumentArtifactCommandBatch({
        version: 1,
        commands: new Array(DOCUMENT_ARTIFACT_COMMAND_MAX_COMMANDS + 1).fill({
          kind: "page-break.add",
          id: id("pb", 10),
        }),
      }),
    ).toThrow();
    expect(() =>
      encodeDocumentArtifactCommandBatch({
        version: 1,
        commands: [
          {
            kind: "section.add",
            ids: {
              section: id("sec", 12),
              headerDefault: id("hdr", 13),
              headerFirst: id("hdr", 14),
              headerEven: id("hdr", 15),
              footerDefault: id("ftr", 16),
              footerFirst: id("ftr", 17),
              footerEven: id("ftr", 18),
            },
            page: {
              widthPt: 612,
              heightPt: 792,
              marginTopPt: 72,
              marginRightPt: 72,
              marginBottomPt: 72,
              marginLeftPt: 72,
              headerPt: 27.5,
            },
            titlePage: null,
          },
        ],
      }),
    ).toThrow("section.add page extras require section.page.set");
    expect(() =>
      encodeDocumentArtifactCommandBatch({
        version: 1,
        commands: [
          {
            kind: "paragraph.edit",
            id: id("p", 8),
            range: { start: 0, end: 0 },
            replacement: "x".repeat(DOCUMENT_ARTIFACT_MAX_TEXT_UTF16 + 1),
            style: null,
          },
        ],
      }),
    ).toThrow();
    for (const query of [
      { kind: "body", startBlock: 0, limits: { maxItems: 0, maxTextUtf16: 1, maxTableCells: 1 } },
      { kind: "review", startItem: 0, limits: { maxItems: 1, maxTextUtf16: 0, maxTableCells: 1 } },
    ] as const)
      expect(() => encodeDocumentArtifactQuery(query)).toThrow();
  });

  test("property-round-trips deterministic command and query samples", () => {
    for (let index = 1; index <= 64; index += 1) {
      const command: DocumentArtifactCommand =
        index % 2 === 0
          ? {
              kind: "paragraph.edit",
              id: id("p", 8),
              range: { start: index, end: index },
              replacement: `value-${index}-😀`,
              style: index % 4 === 0 ? { italic: true } : null,
            }
          : { kind: "comment.resolved.set", id: id("dc", 19), resolved: index % 3 === 0 };
      const encoded = encodeDocumentArtifactCommandBatch({ version: 1, commands: [command] });
      expect(
        encodeDocumentArtifactCommandBatch(decodeDocumentArtifactCommandBatch(encoded)),
      ).toEqual(encoded);
      const query = {
        kind: "body",
        startBlock: index,
        limits: { maxItems: index, maxTextUtf16: index * 10, maxTableCells: index },
      } as const;
      const queryBytes = encodeDocumentArtifactQuery(query);
      expect(encodeDocumentArtifactQuery(decodeDocumentArtifactQuery(queryBytes))).toEqual(
        queryBytes,
      );
    }
  });
});

describe("presentation artifact codec boundaries", () => {
  const text: PresentationArtifactRichText = {
    verticalAlignment: "middle",
    paragraphs: [
      {
        alignment: "center",
        runs: [
          {
            text: "Hello 😀",
            style: {
              fontFamily: "Inter",
              fontSizeCentipoints: 1200,
              color: 0x112233ff,
              bold: true,
              italic: false,
              underline: true,
              language: "en",
            },
          },
        ],
      },
    ],
  };
  const line = {
    fill: { kind: "solid" as const, color: 0x000000ff },
    width: 9525,
    dash: "dash" as const,
  };
  const nodes: PresentationArtifactNodeKind[] = [
    {
      kind: "shape",
      geometry: "rounded-rectangle",
      fill: { kind: "none" },
      line,
      text,
      placeholder: { kind: "title", index: 1 },
    },
    {
      kind: "group",
      childOffsetX: 0,
      childOffsetY: 0,
      childExtentWidth: 100,
      childExtentHeight: 100,
      children: [stableId(50)],
    },
    {
      kind: "connector",
      connectorKind: "curved",
      start: { nodeId: stableId(50), x: 1, y: 2 },
      end: { nodeId: null, x: 3, y: 4 },
      line,
    },
    {
      kind: "chart",
      chartType: "bubble",
      title: text,
      series: [{ name: "s", categories: ["a"], values: [1.5], xValues: [2.5], bubbleSizes: [3.5] }],
      hasLegend: true,
    },
    {
      kind: "table",
      rows: [[{ text, fill: { kind: "none" }, rowSpan: 1, columnSpan: 1 }]],
      columnWidths: [100],
      rowHeights: [50],
      line,
    },
    {
      kind: "media",
      digest: new Uint8Array(32).fill(7),
      contentType: "image/png",
      altText: "alt",
      fit: "cover",
      intrinsicWidth: 10,
      intrinsicHeight: 20,
    },
  ];

  test("round-trips every command, node, query, and response variant", () => {
    const commands: PresentationArtifactCommand[] = [
      { kind: "master.create", id: stableId(1), name: "m", background: { kind: "none" } },
      {
        kind: "layout.create",
        id: stableId(2),
        name: "l",
        masterId: stableId(1),
        background: { kind: "solid", color: 0xffffffff },
      },
      {
        kind: "slide.create",
        id: stableId(3),
        index: 0,
        title: "s",
        layoutId: stableId(2),
        background: { kind: "none" },
      },
      { kind: "master.delete", id: stableId(1) },
      { kind: "layout.delete", id: stableId(2) },
      { kind: "slide.delete", id: stableId(3) },
      { kind: "slide.title.set", id: stableId(3), title: "new" },
      { kind: "slide.layout.set", id: stableId(3), layoutId: null },
      { kind: "slide.notes.set", id: stableId(3), notes: text },
      {
        kind: "node.insert",
        owner: { kind: "slide", id: stableId(3) },
        parentId: null,
        index: 0,
        node: {
          id: stableId(50),
          name: "node",
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          transform: { rotation: 0, flipHorizontal: false, flipVertical: true },
          content: nodes[0]!,
        },
      },
      { kind: "node.delete", id: stableId(50) },
      { kind: "node.move", id: stableId(50), newParentId: stableId(51), index: 2 },
      {
        kind: "node.bounds.set",
        id: stableId(50),
        bounds: { x: -10, y: -20, width: 100, height: 200 },
      },
      {
        kind: "node.transform.set",
        id: stableId(50),
        transform: { rotation: 60000, flipHorizontal: true, flipVertical: false },
      },
      ...nodes.map((content) => ({ kind: "node.content.set" as const, id: stableId(50), content })),
      {
        kind: "presentation.size.set",
        size: { width: 9_144_000, height: 5_143_500 },
      },
    ];
    const encoded = encodePresentationArtifactCommandBatch({ version: 1, commands });
    expect(
      encodePresentationArtifactCommandBatch(decodePresentationArtifactCommandBatch(encoded)),
    ).toEqual(encoded);

    for (const query of [
      {
        kind: "hit-test",
        owner: { kind: "slide", id: stableId(3) },
        x: 4,
        y: 5,
        maxNodes: 8,
        maxBytes: 1024,
      },
      { kind: "resolved-slide", slideId: stableId(3), maxNodes: 8, maxBytes: 1024 },
      {
        kind: "slide-catalog",
        startSlide: 0,
        maxSlides: 8,
        maxTextBytes: 1_024,
        maxBytes: 4_096,
      },
      {
        kind: "editor-slide",
        slideId: stableId(3),
        maxNodes: 8,
        maxTextBytes: 4_096,
        maxBytes: 16_384,
      },
    ] as const) {
      const queryBytes = encodePresentationArtifactQuery(query);
      expect(encodePresentationArtifactQuery(decodePresentationArtifactQuery(queryBytes))).toEqual(
        queryBytes,
      );
    }

    const responses: PresentationArtifactQueryResponse[] = [
      {
        kind: "hit-test",
        revision: 1n,
        owner: { kind: "slide", id: stableId(3) },
        viewport: { x: 0, y: 0, width: 100, height: 100 },
        truncated: false,
        nodes: [2, 1].map((paintOrder, index) => ({
          id: stableId(60 + index),
          owner: { kind: "slide", id: stableId(3) },
          parentId: null,
          nodeKind: "shape",
          bounds: { x: 0, y: 0, width: 10, height: 10 },
          paintOrder,
        })),
      },
      {
        kind: "resolved-slide",
        revision: 2n,
        slideId: stableId(3),
        truncated: false,
        nodes: [
          { id: stableId(70), source: { kind: "master", id: stableId(1) }, inherited: true },
          { id: stableId(71), source: { kind: "slide", id: stableId(3) }, inherited: false },
        ],
      },
      {
        kind: "metadata",
        revision: 3n,
        presentationId: stableId(1),
        slideSize: { width: 9_144_000, height: 5_143_500 },
        masters: 1,
        layouts: 1,
        slides: 1,
      },
      {
        kind: "slide-catalog",
        revision: 4n,
        startSlide: 0,
        nextSlide: null,
        projectedTextBytes: 2,
        slides: [
          {
            index: 0,
            id: stableId(3),
            title: "s",
            background: { kind: "none" },
            layout: {
              id: stableId(2),
              name: "l",
              masterId: stableId(1),
              background: { kind: "solid", color: 0xffffffff },
            },
          },
        ],
        truncated: false,
      },
      {
        kind: "editor-slide",
        revision: 5n,
        slide: {
          index: 0,
          id: stableId(3),
          title: "s",
          background: { kind: "none" },
          layout: {
            id: stableId(2),
            name: "l",
            masterId: stableId(1),
            background: { kind: "solid", color: 0xffffffff },
          },
        },
        notes: { paragraphs: [], verticalAlignment: "top" },
        projectedTextBytes: 28,
        nodes: [
          {
            id: stableId(60),
            source: { kind: "slide", id: stableId(3) },
            inherited: false,
            parentId: null,
            order: 0,
            name: "node",
            bounds: { x: 0, y: 0, width: 100, height: 100 },
            transform: { rotation: 0, flipHorizontal: false, flipVertical: false },
            content: nodes[0]!,
          },
        ],
        truncated: false,
      },
    ];
    for (const response of responses) {
      const responseBytes = encodePresentationArtifactQueryResponse(response);
      expect(
        encodePresentationArtifactQueryResponse(
          decodePresentationArtifactQueryResponse(responseBytes),
          responseBytes.length,
        ),
      ).toEqual(responseBytes);
    }
  });

  test("checks UTF-8, command, geometry, query, and ordering boundaries", () => {
    expect(() =>
      decodePresentationArtifactCommandBatch(
        corruptUtf8(Uint8Array.fromHex(fixture.presentationCommandsHex), "Master"),
      ),
    ).toThrow(/UTF-8/u);
    expect(() =>
      encodePresentationArtifactCommandBatch({
        version: 1,
        commands: new Array(PRESENTATION_ARTIFACT_COMMAND_MAX_COMMANDS + 1).fill({
          kind: "slide.delete",
          id: stableId(3),
        }),
      }),
    ).toThrow();
    expect(() =>
      encodePresentationArtifactCommandBatch({
        version: 1,
        commands: [{ kind: "presentation.size.set", size: { width: 0, height: 5_143_500 } }],
      }),
    ).toThrow("invalid presentation slide size");
    const malformedSize = encodePresentationArtifactCommandBatch({
      version: 1,
      commands: [
        {
          kind: "presentation.size.set",
          size: { width: 9_144_000, height: 5_143_500 },
        },
      ],
    });
    new DataView(
      malformedSize.buffer,
      malformedSize.byteOffset,
      malformedSize.byteLength,
    ).setBigInt64(25, 0n, true);
    writeChecksum(malformedSize);
    expect(() => decodePresentationArtifactCommandBatch(malformedSize)).toThrow(
      "invalid presentation slide size",
    );
    expect(() =>
      encodePresentationArtifactCommandBatch({
        version: 1,
        commands: [
          {
            kind: "node.bounds.set",
            id: stableId(50),
            bounds: { x: 0, y: 0, width: 0, height: 1 },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      encodePresentationArtifactQuery({
        kind: "viewport",
        owner: { kind: "slide", id: stableId(3) },
        viewport: { x: 0, y: 0, width: 1, height: 1 },
        maxNodes: 0,
        maxBytes: 1024,
      }),
    ).toThrow();
    expect(() => encodePresentationArtifactQuery({ kind: "metadata", maxBytes: 83 })).toThrow();
    expect(() =>
      encodePresentationArtifactQueryResponse({
        kind: "slide-catalog",
        revision: 1n,
        startSlide: 4,
        nextSlide: 4,
        projectedTextBytes: 0,
        slides: [],
        truncated: true,
      }),
    ).toThrow();
    expect(() =>
      encodePresentationArtifactQueryResponse({
        kind: "viewport",
        revision: 1n,
        owner: { kind: "slide", id: stableId(3) },
        viewport: { x: 0, y: 0, width: 10, height: 10 },
        truncated: false,
        nodes: [
          {
            id: stableId(60),
            owner: { kind: "slide", id: stableId(3) },
            parentId: null,
            nodeKind: "shape",
            bounds: { x: 0, y: 0, width: 1, height: 1 },
            paintOrder: 2,
          },
          {
            id: stableId(61),
            owner: { kind: "slide", id: stableId(3) },
            parentId: null,
            nodeKind: "shape",
            bounds: { x: 0, y: 0, width: 1, height: 1 },
            paintOrder: 1,
          },
        ],
      }),
    ).toThrow();
  });

  test("property-round-trips deterministic command samples", () => {
    for (let index = 1; index <= 64; index += 1) {
      const encoded = encodePresentationArtifactCommandBatch({
        version: 1,
        commands: [{ kind: "slide.title.set", id: stableId(index), title: `slide-${index}-😀` }],
      });
      expect(
        encodePresentationArtifactCommandBatch(decodePresentationArtifactCommandBatch(encoded)),
      ).toEqual(encoded);
    }
  });
});

function corruptUtf8(source: Uint8Array, needle: string): Uint8Array {
  const output = source.slice();
  const target = new TextEncoder().encode(needle);
  let offset = -1;
  outer: for (let index = 0; index <= output.length - target.length; index += 1) {
    for (let inner = 0; inner < target.length; inner += 1)
      if (output[index + inner] !== target[inner]) continue outer;
    offset = index;
    break;
  }
  if (offset < 0) throw new Error("fixture text not found");
  output[offset] = 0xff;
  writeChecksum(output);
  return output;
}

function writeChecksum(bytes: Uint8Array): void {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes.subarray(0, -8)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(
    bytes.length - 8,
    hash,
    true,
  );
}
