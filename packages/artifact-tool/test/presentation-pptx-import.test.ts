import { describe, expect, test } from "bun:test";

import {
  inflateBoundedZipEntry,
  parseBoundedZip,
  zipCrc32,
  type BoundedZipFailure,
} from "../src/bounded-zip";
import {
  Presentation,
  PresentationFile,
  PresentationFidelityError,
  PresentationSecurityError,
} from "../src/presentation";
import { exportPresentationPptx } from "../src/presentation-pptx";

const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function bytesOf(presentation: Presentation): Promise<Uint8Array> {
  return new Uint8Array(await (await PresentationFile.exportPptx(presentation)).arrayBuffer());
}

async function rewriteZipText(
  source: Uint8Array,
  partName: string,
  rewrite: (xml: string) => string,
): Promise<Uint8Array> {
  return await rewriteFixtureZip(
    source,
    new Map([
      [
        partName,
        (bytes: Uint8Array) => new TextEncoder().encode(rewrite(new TextDecoder().decode(bytes))),
      ],
    ]),
  );
}

async function rewriteFixtureZip(
  source: Uint8Array,
  rewrites: ReadonlyMap<string, (bytes: Uint8Array) => Uint8Array>,
  additions: ReadonlyMap<string, Uint8Array> = new Map(),
): Promise<Uint8Array> {
  const fail: BoundedZipFailure = (_kind, message, entryName): never => {
    throw new Error(`${message}${entryName ? `: ${entryName}` : ""}`);
  };
  const directory = parseBoundedZip(
    source,
    {
      entries: 10_000,
      compressedEntryBytes: 64 * 1024 * 1024,
      expandedEntryBytes: 64 * 1024 * 1024,
      expandedBytes: 128 * 1024 * 1024,
      compressionRatio: 1_000,
    },
    fail,
  );
  const files: Array<{ name: string; bytes: Uint8Array; directory: boolean }> = [];
  const found = new Set<string>();
  for (const entry of directory) {
    const bytes = await inflateBoundedZipEntry(source, entry, 64 * 1024 * 1024, fail);
    const rewrite = rewrites.get(entry.name);
    files.push({
      name: entry.name,
      bytes: rewrite ? rewrite(bytes) : bytes,
      directory: entry.directory,
    });
    if (rewrite) found.add(entry.name);
  }
  for (const name of rewrites.keys()) {
    if (!found.has(name)) throw new Error(`Fixture part missing: ${name}`);
  }
  for (const [name, bytes] of additions) files.push({ name, bytes, directory: name.endsWith("/") });
  return storedFixtureZip(files);
}

function storedFixtureZip(
  files: readonly { name: string; bytes: Uint8Array; directory: boolean }[],
): Uint8Array {
  const encoder = new TextEncoder();
  const localRecords: Uint8Array[] = [];
  const centralRecords: Uint8Array[] = [];
  let localOffset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const checksum = zipCrc32(file.bytes);
    const local = new Uint8Array(30 + name.byteLength + file.bytes.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, file.bytes.byteLength, true);
    localView.setUint32(22, file.bytes.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(file.bytes, 30 + name.byteLength);
    localRecords.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, file.bytes.byteLength, true);
    centralView.setUint32(24, file.bytes.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(38, file.directory ? 0x10 : 0, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);
    centralRecords.push(central);
    localOffset += local.byteLength;
  }
  const centralSize = centralRecords.reduce((sum, record) => sum + record.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  const output = new Uint8Array(localOffset + centralSize + end.byteLength);
  let offset = 0;
  for (const record of [...localRecords, ...centralRecords, end]) {
    output.set(record, offset);
    offset += record.byteLength;
  }
  return output;
}

const FIXTURE_ZIP_LIMITS = {
  entries: 10_000,
  compressedEntryBytes: 64 * 1024 * 1024,
  expandedEntryBytes: 64 * 1024 * 1024,
  expandedBytes: 128 * 1024 * 1024,
  compressionRatio: 1_000,
} as const;

function fixtureZipFailure(
  _kind: Parameters<BoundedZipFailure>[0],
  message: string,
  entryName?: string,
): never {
  throw new Error(`${message}${entryName ? `: ${entryName}` : ""}`);
}

async function fixtureZipPart(source: Uint8Array, partName: string): Promise<Uint8Array> {
  const entry = parseBoundedZip(source, FIXTURE_ZIP_LIMITS, fixtureZipFailure).find(
    (candidate) => candidate.name === partName,
  );
  if (!entry) throw new Error(`Fixture part missing: ${partName}`);
  return await inflateBoundedZipEntry(
    source,
    entry,
    FIXTURE_ZIP_LIMITS.expandedEntryBytes,
    fixtureZipFailure,
  );
}

function declaredSizeBomb(source: Uint8Array, partName: string): Uint8Array {
  const output = source.slice();
  const view = new DataView(output.buffer);
  const decoder = new TextDecoder();
  for (let offset = 0; offset + 46 <= output.byteLength; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(offset + 28, true);
    if (offset + 46 + nameLength > output.byteLength) continue;
    const name = decoder.decode(output.subarray(offset + 46, offset + 46 + nameLength));
    if (name !== partName) continue;
    view.setUint32(offset + 24, 0x7fff_ffff, true);
    return output;
  }
  throw new Error(`Fixture central entry missing: ${partName}`);
}

function mixedPresentation(): Presentation {
  const presentation = Presentation.create({ slideSize: { width: 960, height: 540 } });
  const slide = presentation.slides.add();
  slide.shapes.add({
    geometry: "textbox",
    name: "first-shape",
    text: "Quarterly review",
    textStyle: { fontSize: 32, bold: true, color: "#112233" },
    position: { left: 40, top: 30, width: 380, height: 60 },
  });
  slide.images.add({
    dataUrl: TINY_PNG_DATA_URL,
    name: "second-image",
    alt: "One transparent pixel",
    position: { left: 430, top: 30, width: 80, height: 80 },
  });
  slide.tables.add({
    name: "third-table",
    position: { left: 40, top: 120, width: 360, height: 130 },
    columnWidths: [180, 180],
    rowHeights: [60, 70],
    rows: [
      [{ text: "Merged", colSpan: 2, fill: "#ddeeff" }, null],
      ["North", "South"],
    ],
  });
  slide.charts.add("bar", {
    name: "fourth-chart",
    title: "Revenue",
    position: { left: 430, top: 120, width: 460, height: 300 },
    categories: ["Q1", "Q2"],
    series: [{ name: "ARR", values: [12, 18] }],
    hasLegend: false,
  });
  slide.notes.set("Discuss the regional variance.");
  return presentation;
}

describe("bounded PPTX import and regeneration", () => {
  test("imports editable geometry, text, images, tables, charts, notes, and canonical z-order", async () => {
    const imported = await PresentationFile.importPptx(await bytesOf(mixedPresentation()));
    const slide = imported.slides.items[0]!;

    expect(imported.slideSize).toEqual({ width: 960, height: 540 });
    expect(imported.masters.items).toHaveLength(1);
    expect(imported.layouts.items).toHaveLength(1);
    expect(slide.layout?.id).toBe(imported.layouts.items[0]?.id);
    expect(
      slide.elements.map((element) =>
        "geometry" in element && "text" in element
          ? "shape"
          : "sourceForPptx" in element
            ? "image"
            : "rows" in element
              ? "table"
              : "series" in element
                ? "chart"
                : "group",
      ),
    ).toEqual(["shape", "image", "table", "chart"]);
    expect(slide.elements.slice(0, 3).map((element) => element.name)).toEqual([
      "first-shape",
      "second-image",
      "third-table",
    ]);
    expect(slide.shapes.items[0]?.text.toString()).toBe("Quarterly review");
    expect(slide.images.items[0]?.alt).toBe("One transparent pixel");
    expect(slide.tables.items[0]?.rows[0]?.[0]?.text.toString()).toBe("Merged");
    expect(slide.tables.items[0]?.rows[0]?.[0]?.colSpan).toBe(2);
    expect(slide.tables.items[0]?.rows[0]?.[1]).toBeNull();
    expect(slide.charts.items[0]?.series.items[0]?.values).toEqual([12, 18]);
    expect(slide.notes.toString()).toBe("Discuss the regional variance.");
  });

  test("returns the exact original package while the editable model is unchanged", async () => {
    const source = await bytesOf(mixedPresentation());
    const imported = await PresentationFile.importPptx(source);
    const exported = new Uint8Array(
      await (await PresentationFile.exportPptx(imported)).arrayBuffer(),
    );

    expect(Array.from(exported)).toEqual(Array.from(source));
    expect(
      Array.from(PresentationFile.lossPreservationEnvelope(imported)?.sourceBytes ?? []),
    ).toEqual(Array.from(source));
    const direct = new Uint8Array(await (await exportPresentationPptx(imported)).arrayBuffer());
    expect(Array.from(direct)).toEqual(Array.from(source));
  });

  test("preserves safe unknown parts and relationships exactly, then requires explicit loss", async () => {
    const source = await bytesOf(mixedPresentation());
    const customPart = "ppt/custom/safe-metadata.bin";
    const withUnknownContentType = await rewriteFixtureZip(
      source,
      new Map([
        [
          "[Content_Types].xml",
          (bytes: Uint8Array) =>
            new TextEncoder().encode(
              new TextDecoder()
                .decode(bytes)
                .replace(
                  "</Types>",
                  `<Override PartName="/${customPart}" ContentType="application/vnd.example.safe-metadata"/></Types>`,
                ),
            ),
        ],
        [
          "ppt/slides/_rels/slide1.xml.rels",
          (bytes: Uint8Array) =>
            new TextEncoder().encode(
              new TextDecoder()
                .decode(bytes)
                .replace(
                  "</Relationships>",
                  '<Relationship Id="rIdSafeMetadata" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vendorMetadata" Target="../custom/safe-metadata.bin"/></Relationships>',
                ),
            ),
        ],
      ]),
      new Map([[customPart, new TextEncoder().encode("opaque but inert")]]),
    );
    const imported = await PresentationFile.importPptx(withUnknownContentType);
    expect(PresentationFile.lossPreservationEnvelope(imported)?.unsupportedParts).toContain(
      customPart,
    );
    const unchanged = new Uint8Array(
      await (await PresentationFile.exportPptx(imported)).arrayBuffer(),
    );
    expect(Array.from(unchanged)).toEqual(Array.from(withUnknownContentType));

    imported.slides.items[0]!.shapes.items[0]!.text.set("Edited");
    await expect(PresentationFile.exportPptx(imported)).rejects.toBeInstanceOf(
      PresentationFidelityError,
    );
    const discarded = await PresentationFile.exportPptx(imported, {
      unsupportedContent: "discard",
    });
    const reimported = await PresentationFile.importPptx(
      new Uint8Array(await discarded.arrayBuffer()),
    );
    expect(reimported.slides.items[0]?.shapes.items[0]?.text.toString()).toBe("Edited");
    expect(PresentationFile.lossPreservationEnvelope(reimported)?.unsupportedParts).not.toContain(
      customPart,
    );
  });

  test("keeps source-preservation state internal and immutable to callers", async () => {
    const imported = await PresentationFile.importPptx(await bytesOf(mixedPresentation()));
    const envelope = PresentationFile.lossPreservationEnvelope(imported)!;
    envelope.sourceBytes[0] = envelope.sourceBytes[0]! ^ 0xff;
    (envelope.unsupportedParts as string[]).length = 0;
    (imported as unknown as { pptxProvenance?: unknown }).pptxProvenance = envelope;

    const exported = new Uint8Array(
      await (await PresentationFile.exportPptx(imported)).arrayBuffer(),
    );
    const original = PresentationFile.lossPreservationEnvelope(imported)!.sourceBytes;
    expect(Array.from(exported)).toEqual(Array.from(original));
    expect(original[0]).toBe(0x50);
  });

  test("regenerates a simple edited deck and preserves the semantic edit", async () => {
    const source = Presentation.create({ slideSize: { width: 800, height: 450 } });
    source.slides.add().shapes.add({
      geometry: "textbox",
      name: "editable",
      text: "Before",
      position: { left: 30, top: 30, width: 300, height: 60 },
    });
    const imported = await PresentationFile.importPptx(await bytesOf(source));
    imported.slides.items[0]!.shapes.items[0]!.text.set("After");

    const regenerated = await PresentationFile.exportPptx(imported);
    const reimported = await PresentationFile.importPptx(
      new Uint8Array(await regenerated.arrayBuffer()),
    );
    expect(reimported.slides.items[0]?.shapes.items[0]?.text.toString()).toBe("After");

    reimported.slides.items[0]!.shapes.items[0]!.text.set("After again");
    const second = await PresentationFile.exportPptx(reimported);
    const repeated = await PresentationFile.importPptx(new Uint8Array(await second.arrayBuffer()));
    expect(repeated.slides.items[0]?.shapes.items[0]?.text.toString()).toBe("After again");
  });

  test("authors deterministic bytes for the same model", async () => {
    const presentation = mixedPresentation();
    expect(Array.from(await bytesOf(presentation))).toEqual(
      Array.from(await bytesOf(presentation)),
    );
  });

  test("round-trips shared-X scatter charts and rejects silent per-series X loss", async () => {
    const shared = Presentation.create();
    shared.slides.add().charts.add("scatter", {
      series: [
        { name: "A", xValues: [1, 2, 3], values: [4, 5, 6] },
        { name: "B", xValues: [1, 2, 3], values: [7, 8, 9] },
      ],
    });
    const imported = await PresentationFile.importPptx(await bytesOf(shared));
    expect(imported.slides.items[0]?.charts.items[0]?.series.items).toMatchObject([
      { name: "A", xValues: [1, 2, 3], values: [4, 5, 6] },
      { name: "B", xValues: [1, 2, 3], values: [7, 8, 9] },
    ]);

    const incompatible = Presentation.create();
    incompatible.slides.add().charts.add("scatter", {
      series: [
        { name: "A", xValues: [1, 2], values: [3, 4] },
        { name: "B", xValues: [10, 20], values: [30, 40] },
      ],
    });
    await expect(PresentationFile.exportPptx(incompatible)).rejects.toBeInstanceOf(
      PresentationFidelityError,
    );
  });

  test("rejects unsafe XML and encoded external relationships without network access", async () => {
    const source = await bytesOf(mixedPresentation());
    const withDoctype = await rewriteZipText(source, "ppt/presentation.xml", (xml) =>
      xml.replace(
        /<\?xml[^>]*>/,
        '$&<!DOCTYPE p:presentation [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>',
      ),
    );
    await expect(PresentationFile.importPptx(withDoctype)).rejects.toMatchObject({
      name: "PresentationSecurityError",
      code: "unsafe-xml",
    });

    const withExternalRelationship = await rewriteZipText(
      source,
      "ppt/slides/_rels/slide1.xml.rels",
      (xml) =>
        xml.replace(
          "</Relationships>",
          '<Relationship Id="rIdExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://attacker.invalid/pixel.png" TargetMode="Ext&#101;rnal"/></Relationships>',
        ),
    );
    let fetches = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("network access attempted");
    }) as unknown as typeof fetch;
    try {
      await expect(PresentationFile.importPptx(withExternalRelationship)).rejects.toMatchObject({
        name: "PresentationSecurityError",
        code: "external-relationship",
      });
      expect(fetches).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects active package entries and caller attempts to expand safety ceilings", async () => {
    const source = await bytesOf(mixedPresentation());
    const active = await rewriteFixtureZip(
      source,
      new Map(),
      new Map([["ppt/vbaProject.bin", new Uint8Array([1, 2, 3])]]),
    );
    await expect(PresentationFile.importPptx(active)).rejects.toMatchObject({
      name: "PresentationSecurityError",
      code: "active-content",
    });

    await expect(
      PresentationFile.importPptx(source, { limits: { compressedBytes: 128 * 1024 * 1024 + 1 } }),
    ).rejects.toBeInstanceOf(PresentationSecurityError);
  });

  test("rejects corrupt payloads, declared-size bombs, and nested workbook formulas", async () => {
    const source = await bytesOf(mixedPresentation());
    const directory = parseBoundedZip(source, FIXTURE_ZIP_LIMITS, fixtureZipFailure);
    const slideEntry = directory.find((entry) => entry.name === "ppt/slides/slide1.xml")!;
    const corrupt = source.slice();
    corrupt[slideEntry.dataStart] = corrupt[slideEntry.dataStart]! ^ 0xff;
    await expect(PresentationFile.importPptx(corrupt)).rejects.toMatchObject({
      name: "PresentationSecurityError",
      code: "invalid-package",
    });

    await expect(
      PresentationFile.importPptx(declaredSizeBomb(source, "ppt/slides/slide1.xml")),
    ).rejects.toMatchObject({ name: "PresentationSecurityError", code: "limit-exceeded" });

    const embedding = directory.find((entry) =>
      /^ppt\/embeddings\/[^/]+\.xlsx$/i.test(entry.name),
    )!;
    const nested = await fixtureZipPart(source, embedding.name);
    const formulaWorkbook = await rewriteFixtureZip(
      nested,
      new Map(),
      new Map([
        [
          "xl/worksheets/opengeni-formula-probe.xml",
          new TextEncoder().encode(
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c><f>WEBSERVICE(&quot;https://attacker.invalid&quot;)</f></c></row></sheetData></worksheet>',
          ),
        ],
      ]),
    );
    const withFormula = await rewriteFixtureZip(
      source,
      new Map([[embedding.name, () => formulaWorkbook]]),
    );
    await expect(PresentationFile.importPptx(withFormula)).rejects.toMatchObject({
      name: "PresentationSecurityError",
      code: "active-content",
    });
  });

  test("rejects namespace-spoofed package roots", async () => {
    const source = await bytesOf(mixedPresentation());
    const spoofed = await rewriteZipText(source, "ppt/presentation.xml", (xml) =>
      xml.replace(
        "http://schemas.openxmlformats.org/presentationml/2006/main",
        "https://attacker.invalid/fake-presentationml",
      ),
    );
    await expect(PresentationFile.importPptx(spoofed)).rejects.toMatchObject({
      name: "PresentationSecurityError",
      code: "unsafe-xml",
    });
  });
});
