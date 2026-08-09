import { describe, expect, test } from "bun:test";
import { fnv1a64 } from "../src/editable-artifact-binary";

import {
  assertCanonicalDocumentArtifactCommandBytes,
  assertCanonicalDocumentArtifactQueryBytes,
  assertCanonicalDocumentArtifactQueryResponseBytes,
  decodeDocumentArtifactCommandBatch,
  decodeDocumentArtifactQuery,
  decodeDocumentArtifactQueryResponse,
  encodeDocumentArtifactCommandBatch,
  encodeDocumentArtifactQuery,
  encodeDocumentArtifactQueryResponse,
} from "../src/document-artifact-commands";
import {
  assertCanonicalPresentationArtifactCommandBytes,
  assertCanonicalPresentationArtifactQueryBytes,
  assertCanonicalPresentationArtifactQueryResponseBytes,
  decodePresentationArtifactCommandBatch,
  decodePresentationArtifactQuery,
  decodePresentationArtifactQueryResponse,
  encodePresentationArtifactCommandBatch,
  encodePresentationArtifactQuery,
  encodePresentationArtifactQueryResponse,
} from "../src/presentation-artifact-commands";
import fixture from "./fixtures/editable-artifact-modalities-v1.json";

const bytes = (hex: string): Uint8Array => Uint8Array.fromHex(hex);

describe("document artifact v1 byte ABI", () => {
  test("round-trips every immutable Rust vector byte-for-byte", () => {
    const commands = bytes(fixture.documentCommandsHex);
    expect(
      encodeDocumentArtifactCommandBatch(decodeDocumentArtifactCommandBatch(commands)).toHex(),
    ).toBe(fixture.documentCommandsHex);
    assertCanonicalDocumentArtifactCommandBytes(commands);

    const sectionPage = bytes(fixture.documentSectionPageCommandHex);
    expect(decodeDocumentArtifactCommandBatch(sectionPage)).toEqual({
      version: 1,
      commands: [
        {
          kind: "section.page.set",
          id: "sec/0123456789abcdef0000000000000001",
          page: {
            widthPt: 792,
            heightPt: 612,
            marginTopPt: 36,
            marginRightPt: 42,
            marginBottomPt: 48,
            marginLeftPt: 54,
            headerPt: 27.5,
            footerPt: 31.25,
            gutterPt: 9.5,
          },
        },
      ],
    });
    expect(
      encodeDocumentArtifactCommandBatch(decodeDocumentArtifactCommandBatch(sectionPage)).toHex(),
    ).toBe(fixture.documentSectionPageCommandHex);
    assertCanonicalDocumentArtifactCommandBytes(sectionPage);

    for (const value of [fixture.documentSummaryQueryHex, fixture.documentBodyQueryHex]) {
      const encoded = bytes(value);
      expect(encodeDocumentArtifactQuery(decodeDocumentArtifactQuery(encoded)).toHex()).toBe(value);
      assertCanonicalDocumentArtifactQueryBytes(encoded);
    }
    for (const value of [fixture.documentSummaryResponseHex, fixture.documentBodyResponseHex]) {
      const encoded = bytes(value);
      expect(
        encodeDocumentArtifactQueryResponse(decodeDocumentArtifactQueryResponse(encoded)).toHex(),
      ).toBe(value);
      assertCanonicalDocumentArtifactQueryResponseBytes(encoded);
    }
  });

  test("rejects malformed envelopes and noncanonical numbers", () => {
    const valid = bytes(fixture.documentCommandsHex);
    for (const invalid of [
      valid.subarray(0, -1),
      Uint8Array.from([...valid, 0]),
      Uint8Array.from(valid, (value, index) => (index === 10 ? 1 : value)),
      Uint8Array.from(valid, (value, index) => (index === valid.length - 1 ? value ^ 1 : value)),
    ])
      expect(() => decodeDocumentArtifactCommandBatch(invalid)).toThrow();

    expect(() =>
      encodeDocumentArtifactCommandBatch({
        version: 1,
        commands: [
          {
            kind: "paragraph.add",
            target: { kind: "body" },
            id: "p/0123456789abcdef0000000000000008",
            runs: [{ text: "x", style: { fontSizePt: -0 } }],
            style: {},
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      encodeDocumentArtifactCommandBatch({
        version: 1,
        commands: [
          {
            kind: "section.page.set",
            id: "sec/0123456789abcdef0000000000000001",
            page: {
              widthPt: 792,
              heightPt: 612,
              marginTopPt: 54,
              marginRightPt: 54,
              marginBottomPt: 54,
              marginLeftPt: -0,
            },
          },
        ],
      }),
    ).toThrow();
  });
});

describe("presentation artifact v1 byte ABI", () => {
  test("round-trips every immutable Rust vector byte-for-byte", () => {
    const commands = bytes(fixture.presentationCommandsHex);
    expect(
      encodePresentationArtifactCommandBatch(
        decodePresentationArtifactCommandBatch(commands),
      ).toHex(),
    ).toBe(fixture.presentationCommandsHex);
    assertCanonicalPresentationArtifactCommandBytes(commands);

    const sizeCommand = bytes(fixture.presentationSizeCommandHex);
    expect(decodePresentationArtifactCommandBatch(sizeCommand)).toEqual({
      version: 1,
      commands: [
        {
          kind: "presentation.size.set",
          size: { width: 9_144_000, height: 5_143_500 },
        },
      ],
    });
    expect(
      encodePresentationArtifactCommandBatch(
        decodePresentationArtifactCommandBatch(sizeCommand),
      ).toHex(),
    ).toBe(fixture.presentationSizeCommandHex);
    assertCanonicalPresentationArtifactCommandBytes(sizeCommand);

    for (const value of [
      fixture.presentationMetadataQueryHex,
      fixture.presentationViewportQueryHex,
      fixture.presentationSlideCatalogQueryHex,
      fixture.presentationEditorSlideQueryHex,
    ]) {
      const encoded = bytes(value);
      expect(
        encodePresentationArtifactQuery(decodePresentationArtifactQuery(encoded)).toHex(),
      ).toBe(value);
      assertCanonicalPresentationArtifactQueryBytes(encoded);
    }
    for (const value of [
      fixture.presentationMetadataResponseHex,
      fixture.presentationViewportResponseHex,
      fixture.presentationSlideCatalogResponseHex,
      fixture.presentationEditorSlideResponseHex,
      fixture.presentationEditorAllNodesResponseHex,
    ]) {
      const encoded = bytes(value);
      const decoded = decodePresentationArtifactQueryResponse(encoded);
      expect(encodePresentationArtifactQueryResponse(decoded, encoded.length).toHex()).toBe(value);
      assertCanonicalPresentationArtifactQueryResponseBytes(encoded);
    }

    expect(
      decodePresentationArtifactQueryResponse(bytes(fixture.presentationSlideCatalogResponseHex)),
    ).toMatchObject({
      kind: "slide-catalog",
      startSlide: 0,
      nextSlide: null,
      projectedTextBytes: 17,
      slides: [
        {
          index: 0,
          id: "0123456789abcdef0000000000000067",
          title: "Fixture ✓",
          layout: {
            id: "0123456789abcdef0000000000000066",
            name: "Layout",
            masterId: "0123456789abcdef0000000000000065",
          },
        },
      ],
      truncated: false,
    });
    expect(
      decodePresentationArtifactQueryResponse(bytes(fixture.presentationEditorSlideResponseHex)),
    ).toMatchObject({
      kind: "editor-slide",
      slide: { id: "0123456789abcdef0000000000000067" },
      projectedTextBytes: 37,
      nodes: [
        {
          id: "0123456789abcdef0000000000000068",
          source: { kind: "slide", id: "0123456789abcdef0000000000000067" },
          inherited: false,
          parentId: null,
          order: 0,
          name: "Title",
          content: { kind: "shape", geometry: "text-box" },
        },
      ],
      truncated: false,
    });
    const allNodes = decodePresentationArtifactQueryResponse(
      bytes(fixture.presentationEditorAllNodesResponseHex),
    );
    expect(allNodes.kind).toBe("editor-slide");
    if (allNodes.kind !== "editor-slide") throw new Error("expected editor slide fixture");
    expect(allNodes.nodes.map((node) => node.content.kind)).toEqual([
      "shape",
      "group",
      "shape",
      "connector",
      "chart",
      "table",
      "media",
    ]);
    expect(allNodes.nodes[2]).toMatchObject({
      parentId: "0123456789abcdef0000000000000069",
      order: 0,
    });
    expect(allNodes.nodes[3]?.content).toMatchObject({
      kind: "connector",
      connectorKind: "curved",
      start: { nodeId: "0123456789abcdef0000000000000068" },
    });
    expect(allNodes.nodes[4]?.content).toMatchObject({
      kind: "chart",
      chartType: "line",
      series: [{ name: "Series", categories: ["A", "B"], values: [1, 2] }],
    });
    expect(allNodes.nodes[5]?.content).toMatchObject({
      kind: "table",
      rows: [[{ rowSpan: 1, columnSpan: 1 }]],
    });
    expect(allNodes.nodes[6]?.content).toMatchObject({
      kind: "media",
      digest: new Uint8Array(32).fill(7),
      contentType: "image/webp",
      altText: "Diagram",
      fit: "cover",
      intrinsicWidth: 1_920,
      intrinsicHeight: 1_080,
    });
  });

  test("rejects malformed envelopes, invalid UTF-8, and negative zero", () => {
    const valid = bytes(fixture.presentationCommandsHex);
    for (const invalid of [
      valid.subarray(0, -1),
      Uint8Array.from([...valid, 0]),
      Uint8Array.from(valid, (value, index) => (index === 10 ? 1 : value)),
      Uint8Array.from(valid, (value, index) => (index === valid.length - 1 ? value ^ 1 : value)),
    ])
      expect(() => decodePresentationArtifactCommandBatch(invalid)).toThrow();

    expect(() =>
      encodePresentationArtifactCommandBatch({
        version: 1,
        commands: [
          {
            kind: "node.content.set",
            id: "0123456789abcdef0000000000000001",
            content: {
              kind: "chart",
              chartType: "line",
              title: { paragraphs: [], verticalAlignment: "top" },
              series: [{ name: "x", categories: [], values: [-0], xValues: [], bubbleSizes: [] }],
              hasLegend: false,
            },
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      encodePresentationArtifactQuery({
        kind: "slide-catalog",
        startSlide: 0,
        maxSlides: 10_001,
        maxTextBytes: 1,
        maxBytes: 1_024,
      }),
    ).toThrow();
    expect(() =>
      encodePresentationArtifactQuery({
        kind: "editor-slide",
        slideId: "0123456789abcdef0000000000000067",
        maxNodes: 1,
        maxTextBytes: 0,
        maxBytes: 1_024,
      }),
    ).toThrow();

    const itemBomb = bytes(fixture.presentationSlideCatalogResponseHex);
    new DataView(itemBomb.buffer, itemBomb.byteOffset, itemBomb.byteLength).setUint32(
      24,
      10_001,
      true,
    );
    new DataView(itemBomb.buffer, itemBomb.byteOffset, itemBomb.byteLength).setBigUint64(
      itemBomb.byteLength - 8,
      fnv1a64(itemBomb.subarray(0, -8)),
      true,
    );
    expect(() => decodePresentationArtifactQueryResponse(itemBomb)).toThrow();

    const falseTextAccounting = bytes(fixture.presentationSlideCatalogResponseHex);
    new DataView(
      falseTextAccounting.buffer,
      falseTextAccounting.byteOffset,
      falseTextAccounting.byteLength,
    ).setUint32(37, 0, true);
    new DataView(
      falseTextAccounting.buffer,
      falseTextAccounting.byteOffset,
      falseTextAccounting.byteLength,
    ).setBigUint64(
      falseTextAccounting.byteLength - 8,
      fnv1a64(falseTextAccounting.subarray(0, -8)),
      true,
    );
    expect(() => decodePresentationArtifactQueryResponse(falseTextAccounting)).toThrow();
  });
});
