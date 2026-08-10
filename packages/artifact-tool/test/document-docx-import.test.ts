import { describe, expect, test } from "bun:test";
import {
  CommentRangeEnd,
  CommentRangeStart,
  CommentReference,
  Document as DocxDocument,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  PageBreak,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from "docx";
import { DocxImportError, importDocx } from "../src/document-docx-import";

describe("bounded DOCX importer", () => {
  test("imports generated compressed DOCX structure without Node-only ZIP dependencies", async () => {
    const source = new DocxDocument({
      comments: {
        children: [
          { id: 0, author: "Reviewer", resolved: true, children: [new Paragraph("Check growth.")] },
          { id: 1, parentId: 0, author: "Author", children: [new Paragraph("Verified.")] },
        ],
      },
      sections: [
        {
          properties: {
            page: {
              size: { width: 12_240, height: 15_840 },
              margin: { top: 1_440, right: 1_200, bottom: 1_440, left: 1_200 },
            },
          },
          headers: { default: new Header({ children: [new Paragraph("Confidential")] }) },
          footers: { default: new Footer({ children: [new Paragraph("OpenGeni")] }) },
          children: [
            new Paragraph({
              heading: HeadingLevel.HEADING_1,
              children: [new TextRun("Quarterly review")],
            }),
            new Paragraph({
              children: [
                new CommentRangeStart(0),
                new TextRun("Revenue "),
                new TextRun({ text: "grew", bold: true, color: "2563EB" }),
                new CommentRangeEnd(0),
                new CommentReference(0),
              ],
            }),
            new Table({
              rows: [
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph("Metric")] }),
                    new TableCell({ children: [new Paragraph("Value")] }),
                  ],
                }),
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph("Revenue")] }),
                    new TableCell({ children: [new Paragraph("120")] }),
                  ],
                }),
              ],
            }),
            new Paragraph({ children: [new PageBreak()] }),
          ],
        },
      ],
    });
    const packed = await Packer.toBuffer(source);
    const imported = await importDocx(asArrayBuffer(packed));

    expect(imported.format).toBe("docx");
    expect(imported.trackRevisions).toBe(false);
    expect(imported.blocks).toHaveLength(4);
    expect(imported.blocks[0]?.kind).toBe("paragraph");
    expect(imported.blocks[1]).toMatchObject({
      kind: "paragraph",
      inlines: [
        { kind: "run", text: "Revenue " },
        { kind: "run", text: "grew", style: { bold: true, color: "2563EB" } },
      ],
    });
    expect(imported.blocks[2]).toMatchObject({
      kind: "table",
      rows: [{ cells: [{}, {}] }, { cells: [{}, {}] }],
    });
    expect(imported.blocks[3]).toMatchObject({
      kind: "paragraph",
      inlines: [{ kind: "pageBreak" }],
    });
    expect(imported.sections[0]?.page).toMatchObject({
      widthPt: 612,
      heightPt: 792,
      marginTopPt: 72,
      marginLeftPt: 60,
    });
    expect(imported.headers[0]?.blocks[0]).toMatchObject({
      kind: "paragraph",
      inlines: [{ text: "Confidential" }],
    });
    expect(imported.footers[0]?.blocks[0]).toMatchObject({
      kind: "paragraph",
      inlines: [{ text: "OpenGeni" }],
    });
    expect(imported.comments).toMatchObject([
      { id: "0", resolved: true },
      { id: "1", parentId: "0" },
    ]);
  });

  test("retains the bounded Node inflate fallback when raw DecompressionStream is unavailable", async () => {
    const packed = await Packer.toBuffer(
      new DocxDocument({
        sections: [{ children: [new Paragraph("Node fallback")] }],
      }),
    );
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "DecompressionStream");
    Object.defineProperty(globalThis, "DecompressionStream", {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      writable: true,
      value: undefined,
    });
    try {
      const imported = await importDocx(asArrayBuffer(packed));
      expect(imported.blocks[0]).toMatchObject({
        kind: "paragraph",
        inlines: [{ kind: "run", text: "Node fallback" }],
      });
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "DecompressionStream", descriptor);
      else Reflect.deleteProperty(globalThis, "DecompressionStream");
    }
  });

  test("retains only allowlisted inert custom XML and rejects active variants", async () => {
    const customRelationship =
      '<Relationship Id="rIdCustom" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="../customXml/item1.xml"/>';
    const customPropsRelationship =
      '<Relationship Id="rIdProps" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps" Target="itemProps1.xml"/>';
    const contentTypeXml =
      xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      <Override PartName="/customXml/itemProps1.xml" ContentType="application/vnd.openxmlformats-officedocument.customXmlProperties+xml"/>
    </Types>`);
    const documentXml = xml(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>`,
    );
    const archive = (customXml: string, documentRelationship = customRelationship): ArrayBuffer =>
      buildZip([
        ["[Content_Types].xml", contentTypeXml],
        ["_rels/.rels", rootRelationships()],
        ["word/_rels/document.xml.rels", relationships(documentRelationship)],
        ["word/document.xml", documentXml],
        ["customXml/item1.xml", customXml],
        ["customXml/itemProps1.xml", xml(`<properties xmlns="urn:opengeni:test"/>`)],
        ["customXml/_rels/item1.xml.rels", relationships(customPropsRelationship)],
      ]);

    const imported = await importDocx(
      archive(xml(`<fixture xmlns="urn:opengeni:test">safe</fixture>`)),
    );
    expect(imported.opaqueContent).toEqual({
      parts: ["customXml/_rels/item1.xml.rels", "customXml/item1.xml", "customXml/itemProps1.xml"],
      relationships: [
        {
          sourcePart: "customXml/item1.xml",
          type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps",
          targetPart: "customXml/itemProps1.xml",
        },
        {
          sourcePart: "word/document.xml",
          type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml",
          targetPart: "customXml/item1.xml",
        },
      ],
      contentTypes: [
        {
          partName: "customXml/_rels/item1.xml.rels",
          contentType: "application/vnd.openxmlformats-package.relationships+xml",
        },
        { partName: "customXml/item1.xml", contentType: "application/xml" },
        {
          partName: "customXml/itemProps1.xml",
          contentType: "application/vnd.openxmlformats-officedocument.customXmlProperties+xml",
        },
      ],
    });

    await expect(
      importDocx(archive('<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///etc/passwd">]><x>&leak;</x>')),
    ).rejects.toMatchObject({ code: "invalid_xml", partName: "customXml/item1.xml" });
    await expect(
      importDocx(
        archive(
          xml(`<fixture xmlns="urn:opengeni:test"/>`),
          '<Relationship Id="rIdCustom" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="https://attacker.invalid/item.xml" TargetMode="External"/>',
        ),
      ),
    ).rejects.toMatchObject({ code: "unsupported_feature" });
    await expect(
      importDocx(
        buildZip([
          [
            "[Content_Types].xml",
            contentTypeXml.replace("application/xml", "application/vnd.ms-office.vbaProject"),
          ],
          ["_rels/.rels", rootRelationships()],
          ["word/document.xml", documentXml],
        ]),
      ),
    ).rejects.toMatchObject({ code: "unsupported_feature" });
  });

  test("preserves comments and tracked insertions/deletions", async () => {
    const imported = await importDocx(
      buildZip([
        ["[Content_Types].xml", contentTypes(true)],
        ["_rels/.rels", rootRelationships()],
        [
          "word/_rels/document.xml.rels",
          relationships(`
        <Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>
        <Relationship Id="rIdCommentsEx" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/>
      `),
        ],
        [
          "word/document.xml",
          xml(`
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <w:body>
            <w:p>
              <w:commentRangeStart w:id="0"/>
              <w:ins w:id="4" w:author="Ada" w:date="2026-08-08T08:00:00Z"><w:r><w:t>Hi&#x1F600;</w:t></w:r></w:ins>
              <w:commentRangeEnd w:id="0"/>
              <w:r><w:commentReference w:id="0"/></w:r>
            </w:p>
            <w:p><w:del w:id="5" w:author="Grace"><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>
            <w:p><w:r><w:t>point</w:t><w:commentReference w:id="2"/></w:r></w:p>
            <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
          </w:body>
        </w:document>
      `),
        ],
        [
          "word/comments.xml",
          xml(`
        <w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
          <w:comment w:id="0" w:author="Reviewer" w:initials="R"><w:p w14:paraId="AAA00000"><w:r><w:t>Context.</w:t></w:r></w:p><w:p w14:paraId="AAA00001"><w:r><w:t>Check this.</w:t></w:r></w:p></w:comment>
          <w:comment w:id="1" w:author="Author" w:initials="A"><w:p w14:paraId="AAA00002"><w:r><w:t>Done.</w:t></w:r></w:p></w:comment>
          <w:comment w:id="2" w:author="Reviewer"><w:p w14:paraId="AAA00003"><w:r><w:t>Point note.</w:t></w:r></w:p></w:comment>
        </w:comments>
      `),
        ],
        [
          "word/commentsExtended.xml",
          xml(`
        <w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">
          <w15:commentEx w15:paraId="AAA00001" w15:done="1"/>
          <w15:commentEx w15:paraId="AAA00002" w15:paraIdParent="AAA00001"/>
        </w15:commentsEx>
      `),
        ],
      ]),
    );

    expect(imported.comments).toMatchObject([
      {
        id: "0",
        author: "Reviewer",
        resolved: true,
        blocks: [{ kind: "paragraph" }, { kind: "paragraph" }],
      },
      { id: "1", author: "Author", parentId: "0", blocks: [{ kind: "paragraph" }] },
      { id: "2", author: "Reviewer" },
    ]);
    expect(imported.trackedChanges).toMatchObject([
      {
        id: "4",
        kind: "insert",
        author: "Ada",
        startInlineIndex: 0,
        endInlineIndex: 1,
        startTextOffset: 0,
        endTextOffset: 4,
      },
      {
        id: "5",
        kind: "delete",
        author: "Grace",
        startInlineIndex: 0,
        endInlineIndex: 1,
        startTextOffset: 0,
        endTextOffset: 4,
      },
    ]);
    expect(imported.blocks[0]).toMatchObject({
      kind: "paragraph",
      commentAnchors: [
        { commentId: "0", kind: "start", textOffset: 0 },
        { commentId: "0", kind: "end", textOffset: 4 },
        { commentId: "0", kind: "reference", textOffset: 4 },
      ],
      inlines: [{ text: "Hi😀", changeId: "4" }],
    });
    expect(imported.blocks[1]).toMatchObject({
      kind: "paragraph",
      inlines: [{ text: "gone", changeId: "5" }],
    });
    expect(imported.blocks[2]).toMatchObject({
      kind: "paragraph",
      commentAnchors: [{ commentId: "2", kind: "reference", textOffset: 5 }],
    });
  });

  test("preserves section story inheritance without creating blank body blocks", async () => {
    const archive = buildZip([
      ["[Content_Types].xml", contentTypes(false)],
      ["_rels/.rels", rootRelationships()],
      [
        "word/_rels/document.xml.rels",
        relationships(`
        <Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
        <Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
      `),
      ],
      [
        "word/document.xml",
        xml(`
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>
          <w:p><w:r><w:t>one</w:t></w:r></w:p>
          <w:p><w:pPr><w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:titlePg/></w:sectPr></w:pPr></w:p>
          <w:p><w:r><w:t>two</w:t></w:r></w:p>
          <w:sectPr/>
        </w:body></w:document>
      `),
      ],
      [
        "word/header1.xml",
        xml(
          `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Inherited</w:t></w:r></w:p></w:hdr>`,
        ),
      ],
      [
        "word/settings.xml",
        xml(
          `<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:evenAndOddHeaders/></w:settings>`,
        ),
      ],
    ]);
    const imported = await importDocx(archive);
    expect(imported.blocks).toHaveLength(2);
    expect(imported.evenAndOddHeaders).toBe(true);
    expect(imported.sections).toMatchObject([
      {
        startBlockIndex: 0,
        endBlockIndex: 1,
        titlePage: true,
        headers: [{ partName: "word/header1.xml" }],
      },
      {
        startBlockIndex: 1,
        endBlockIndex: 2,
        titlePage: false,
        headers: [{ partName: "word/header1.xml" }],
      },
    ]);
    await expect(importDocx(archive, { maxProjectedStoryBlocks: 1 })).rejects.toMatchObject({
      code: "limit_exceeded",
      message: expect.stringContaining("maxProjectedStoryBlocks"),
    });
    await expect(importDocx(archive, { maxProjectedStoryCharacters: 17 })).rejects.toMatchObject({
      code: "limit_exceeded",
      message: expect.stringContaining("maxProjectedStoryCharacters"),
    });
    await expect(importDocx(archive, { maxSections: 1 })).rejects.toMatchObject({
      code: "limit_exceeded",
      message: expect.stringContaining("maxSections"),
    });

    const invalidKind = buildZip([
      ["[Content_Types].xml", contentTypes(false)],
      ["_rels/.rels", rootRelationships()],
      [
        "word/_rels/document.xml.rels",
        relationships(
          `<Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>`,
        ),
      ],
      [
        "word/document.xml",
        xml(
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:sectPr><w:headerReference w:type="invented" r:id="rIdHeader"/></w:sectPr></w:body></w:document>`,
        ),
      ],
      [
        "word/header1.xml",
        xml(`<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`),
      ],
    ]);
    await expect(importDocx(invalidKind)).rejects.toMatchObject({ code: "invalid_package" });
  });

  test("fails closed for traversal, declarations, media, and configured limits", async () => {
    await expect(importDocx(buildZip([["../escape.xml", "x"]]))).rejects.toMatchObject({
      name: "DocxImportError",
      code: "invalid_zip",
    });
    await expect(
      importDocx(
        buildZip([
          ["same.xml", "a"],
          ["SAME.xml", "b"],
        ]),
      ),
    ).rejects.toMatchObject({
      code: "invalid_zip",
    });

    const encrypted = buildZip([["safe.xml", "x"]]);
    const encryptedView = new DataView(encrypted);
    const encryptedCentral = encryptedView.getUint32(encrypted.byteLength - 22 + 16, true);
    encryptedView.setUint16(6, encryptedView.getUint16(6, true) | 1, true);
    encryptedView.setUint16(
      encryptedCentral + 8,
      encryptedView.getUint16(encryptedCentral + 8, true) | 1,
      true,
    );
    await expect(importDocx(encrypted)).rejects.toMatchObject({ code: "unsupported_feature" });

    const zip64 = buildZip([["safe.xml", "x"]]);
    const zip64View = new DataView(zip64);
    zip64View.setUint16(zip64.byteLength - 22 + 8, 0xffff, true);
    zip64View.setUint16(zip64.byteLength - 22 + 10, 0xffff, true);
    await expect(importDocx(zip64)).rejects.toMatchObject({ code: "unsupported_feature" });

    await expect(importDocx(overlappingDeflatedEntries())).rejects.toMatchObject({
      code: "invalid_zip",
      message: expect.stringContaining("overlap"),
    });

    await expect(
      importDocx(
        buildZip([
          ["[Content_Types].xml", contentTypes(false)],
          ["_rels/.rels", rootRelationships()],
          [
            "word/document.xml",
            `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY leak "x">]><w:document xmlns:w="w"><w:body/></w:document>`,
          ],
        ]),
      ),
    ).rejects.toMatchObject({ code: "invalid_xml" });

    await expect(
      importDocx(
        buildZip([
          ["[Content_Types].xml", contentTypes(false)],
          ["_rels/.rels", rootRelationships()],
          ["word/document.xml", xml(`<w:document xmlns:w="w"><w:body/></w:document>`)],
          ["word/media/image1.png", new Uint8Array([1, 2, 3])],
        ]),
      ),
    ).rejects.toMatchObject({ code: "unsupported_feature" });

    const valid = buildZip([
      ["[Content_Types].xml", contentTypes(false)],
      ["_rels/.rels", rootRelationships()],
      [
        "word/document.xml",
        xml(
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>bounded</w:t></w:r></w:p></w:body></w:document>`,
        ),
      ],
    ]);
    await expect(importDocx(valid, { maxXmlNodes: 3 })).rejects.toBeInstanceOf(DocxImportError);
    await expect(importDocx(valid, { maxTextCharacters: 3 })).rejects.toMatchObject({
      code: "limit_exceeded",
    });
    await expect(importDocx(valid, { maxXmlDepth: 129 })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(importDocx(valid, { maxCompressionRatio: 100.01 })).rejects.toMatchObject({
      code: "invalid_input",
    });

    const largeCommentOnlyHeaders = Array.from({ length: 48 }, (_, index) => {
      const number = index + 1;
      return [
        `word/header${number}.xml`,
        xml(
          `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><!--${String.fromCharCode(65 + (index % 26)).repeat(32 * 1024)}--></w:hdr>`,
        ),
      ] as const;
    });
    const headerRelationships = largeCommentOnlyHeaders
      .map(
        (_, index) =>
          `<Relationship Id="rIdHeader${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header${index + 1}.xml"/>`,
      )
      .join("");
    const manyIgnoredParts = buildZip([
      ["[Content_Types].xml", contentTypes(false)],
      ["_rels/.rels", rootRelationships()],
      ["word/_rels/document.xml.rels", relationships(headerRelationships)],
      [
        "word/document.xml",
        xml(
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>`,
        ),
      ],
      ...largeCommentOnlyHeaders,
    ]);
    const importedManyIgnoredParts = await importDocx(manyIgnoredParts, {
      maxRetainedXmlCharacters: 128 * 1024,
    });
    expect(importedManyIgnoredParts).toMatchObject({ format: "docx", blocks: [] });

    const retainedTheme = buildZip([
      ["[Content_Types].xml", contentTypes(false)],
      ["_rels/.rels", rootRelationships()],
      [
        "word/_rels/document.xml.rels",
        relationships(
          `<Relationship Id="rIdTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>`,
        ),
      ],
      [
        "word/document.xml",
        xml(
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>`,
        ),
      ],
      ["word/theme/theme1.xml", xml(`<theme>${"x".repeat(256 * 1024)}</theme>`)],
    ]);
    await expect(
      importDocx(retainedTheme, { maxRetainedXmlCharacters: 128 * 1024 }),
    ).rejects.toMatchObject({
      code: "limit_exceeded",
      message: expect.stringContaining("maxRetainedXmlCharacters"),
    });

    const malformedQName = buildZip([
      ["[Content_Types].xml", contentTypes(false)],
      ["_rels/.rels", rootRelationships()],
      [
        "word/document.xml",
        xml(
          `<w:evil:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:evil:document>`,
        ),
      ],
    ]);
    await expect(importDocx(malformedQName)).rejects.toMatchObject({ code: "invalid_xml" });
    await expect(
      importDocx(
        buildZip([
          ["[Content_Types].xml", contentTypes(false)],
          ["_rels/.rels", rootRelationships()],
          [
            "word/document.xml",
            `<?XML potato?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>`,
          ],
        ]),
      ),
    ).rejects.toMatchObject({ code: "invalid_xml" });

    const invalidSection = (properties: string): ArrayBuffer =>
      buildZip([
        ["[Content_Types].xml", contentTypes(false)],
        ["_rels/.rels", rootRelationships()],
        [
          "word/document.xml",
          xml(
            `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:sectPr>${properties}</w:sectPr></w:body></w:document>`,
          ),
        ],
      ]);
    await expect(importDocx(invalidSection(`<w:cols w:num="2"/>`))).rejects.toMatchObject({
      code: "unsupported_feature",
    });
    await expect(
      importDocx(invalidSection(`<w:pgSz w:w="bad" w:h="15840"/>`)),
    ).rejects.toMatchObject({ code: "invalid_package" });
  });

  test("preserves represented empty-run formatting and named-style references", async () => {
    const withRun = (run: string): ArrayBuffer =>
      buildZip([
        ["[Content_Types].xml", contentTypes(false)],
        ["_rels/.rels", rootRelationships()],
        [
          "word/document.xml",
          xml(
            `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>${run}</w:p></w:body></w:document>`,
          ),
        ],
      ]);
    const plain = await importDocx(withRun(`<w:r/>`));
    expect(plain.blocks[0]).toMatchObject({
      kind: "paragraph",
      inlines: [{ kind: "run", text: "", style: {} }],
    });
    const bold = await importDocx(withRun(`<w:r><w:rPr><w:b/></w:rPr><w:t/></w:r>`));
    expect(bold.blocks[0]).toMatchObject({
      kind: "paragraph",
      inlines: [{ kind: "run", text: "", style: { bold: true } }],
    });
    const named = await importDocx(
      withRun(`<w:r><w:rPr><w:rStyle w:val="Emphasis"/></w:rPr></w:r>`),
    );
    expect(named.blocks[0]).toMatchObject({
      kind: "paragraph",
      inlines: [{ kind: "run", text: "", styleId: "Emphasis", style: {} }],
    });
  });

  test("bounds hostile XML attribute and relationship fan-out before collection growth", async () => {
    const attributes = Array.from({ length: 256 }, (_, index) => ` a${index}="x"`).join("");
    const attributeBomb = buildZip([
      ["[Content_Types].xml", contentTypes(false)],
      ["_rels/.rels", rootRelationships()],
      [
        "word/document.xml",
        xml(
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"${attributes}><w:body/></w:document>`,
        ),
      ],
    ]);
    await expect(importDocx(attributeBomb)).rejects.toMatchObject({
      code: "limit_exceeded",
      message: expect.stringContaining("maxXmlAttributesPerElement"),
    });

    const relationshipFanout = buildZip([
      ["[Content_Types].xml", contentTypes(false)],
      ["_rels/.rels", rootRelationships()],
      [
        "word/document.xml",
        xml(
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>`,
        ),
      ],
      [
        "word/_rels/document.xml.rels",
        relationships(
          Array.from(
            { length: 3 },
            (_, index) =>
              `<Relationship Id="rId${index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
          ).join(""),
        ),
      ],
    ]);
    await expect(
      importDocx(relationshipFanout, { maxRelationshipsPerPart: 2 }),
    ).rejects.toMatchObject({
      code: "limit_exceeded",
      message: expect.stringContaining("maxRelationshipsPerPart"),
    });
    await expect(
      importDocx(relationshipFanout, { maxTotalRelationships: 2 }),
    ).rejects.toMatchObject({
      code: "limit_exceeded",
      message: expect.stringContaining("maxTotalRelationships"),
    });
    await expect(
      importDocx(attributeBomb, { maxXmlAttributesPerElement: 257 }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });

    const tooManyListLevels = buildZip([
      ["[Content_Types].xml", contentTypes(false)],
      ["_rels/.rels", rootRelationships()],
      [
        "word/_rels/document.xml.rels",
        relationships(
          `<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>`,
        ),
      ],
      [
        "word/document.xml",
        xml(
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>`,
        ),
      ],
      [
        "word/numbering.xml",
        xml(
          `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0">${Array.from({ length: 10 }, (_, index) => `<w:lvl w:ilvl="${index}"><w:start w:val="1"/></w:lvl>`).join("")}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
        ),
      ],
    ]);
    await expect(importDocx(tooManyListLevels)).rejects.toMatchObject({ code: "invalid_package" });
  });

  test("projects represented table geometry and rejects unrepresented formatting", async () => {
    const tableDocx = buildZip([
      ["[Content_Types].xml", contentTypes(false)],
      ["_rels/.rels", rootRelationships()],
      [
        "word/document.xml",
        xml(`
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
          <w:tbl>
            <w:tblPr>
              <w:tblW w:type="dxa" w:w="7200"/><w:tblInd w:type="dxa" w:w="140"/>
              <w:tblBorders><w:top w:val="single" w:color="64748B" w:sz="4"/><w:bottom w:val="single" w:color="64748B" w:sz="4"/></w:tblBorders>
              <w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:type="dxa" w:w="140"/><w:left w:type="dxa" w:w="140"/></w:tblCellMar>
            </w:tblPr>
            <w:tblGrid><w:gridCol w:w="7200"/></w:tblGrid>
            <w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="480" w:hRule="exact"/></w:trPr>
              <w:tc><w:tcPr><w:tcW w:type="dxa" w:w="7200"/><w:vAlign w:val="center"/></w:tcPr><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc>
            </w:tr>
          </w:tbl>
        </w:body></w:document>
      `),
      ],
    ]);
    const table = (await importDocx(tableDocx)).blocks[0];
    expect(table).toMatchObject({
      kind: "table",
      width: { value: 360, unit: "pt" },
      indent: { value: 7, unit: "pt" },
      cellMargins: { top: { value: 7, unit: "pt" }, left: { value: 7, unit: "pt" } },
      borders: { top: { style: "single", color: "64748B", sizePt: 0.5 } },
      layout: "fixed",
      rows: [{ heightPt: 24, heightRule: "exact" }],
    });

    const unsupported = (properties: string): ArrayBuffer =>
      buildZip([
        ["[Content_Types].xml", contentTypes(false)],
        ["_rels/.rels", rootRelationships()],
        [
          "word/document.xml",
          xml(
            `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>${properties}<w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>`,
          ),
        ],
      ]);
    await expect(importDocx(unsupported(`<w:pPr><w:pBdr/></w:pPr>`))).rejects.toMatchObject({
      code: "unsupported_feature",
    });
    await expect(
      importDocx(unsupported(`<w:pPr><w:pPrChange w:id="1"/></w:pPr>`)),
    ).rejects.toMatchObject({ code: "unsupported_feature" });
    await expect(
      importDocx(
        unsupported(`<w:r><w:rPr><w:rFonts w:asciiTheme="minorHAnsi"/></w:rPr><w:t>x</w:t></w:r>`),
      ),
    ).rejects.toMatchObject({ code: "unsupported_feature" });
    await expect(importDocx(unsupported(`<w:r><w:t>&#xD83D;</w:t></w:r>`))).rejects.toMatchObject({
      code: "invalid_xml",
    });
  });

  test("rejects repeated property containers, unsupported page settings, and wrong-namespace attributes", async () => {
    const documentArchive = (body: string, extraNamespaces = ""): ArrayBuffer =>
      buildZip([
        ["[Content_Types].xml", contentTypes(false)],
        ["_rels/.rels", rootRelationships()],
        [
          "word/document.xml",
          xml(
            `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ${extraNamespaces}><w:body>${body}</w:body></w:document>`,
          ),
        ],
      ]);
    const paragraph = `<w:p><w:r><w:t>x</w:t></w:r></w:p>`;
    const cell = (properties: string): string => `<w:tc>${properties}${paragraph}</w:tc>`;
    const row = (properties: string, cellProperties = `<w:tcPr/>`): string =>
      `<w:tr>${properties}${cell(cellProperties)}</w:tr>`;
    const table = (
      properties: string,
      grid: string,
      rowProperties = `<w:trPr/>`,
      cellProperties = `<w:tcPr/>`,
    ): string => `<w:tbl>${properties}${grid}${row(rowProperties, cellProperties)}</w:tbl>`;

    const repeatedContainers = [
      `<w:p><w:pPr/><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>x</w:t></w:r></w:p>`,
      `<w:p><w:r><w:rPr/><w:rPr><w:b/></w:rPr><w:t>x</w:t></w:r></w:p>`,
      table(`<w:tblPr/><w:tblPr/>`, `<w:tblGrid><w:gridCol w:w="100"/></w:tblGrid>`),
      table(`<w:tblPr/>`, `<w:tblGrid/><w:tblGrid><w:gridCol w:w="100"/></w:tblGrid>`),
      table(`<w:tblPr/>`, `<w:tblGrid><w:gridCol w:w="100"/></w:tblGrid>`, `<w:trPr/><w:trPr/>`),
      table(
        `<w:tblPr/>`,
        `<w:tblGrid><w:gridCol w:w="100"/></w:tblGrid>`,
        `<w:trPr/>`,
        `<w:tcPr/><w:tcPr/>`,
      ),
    ];
    for (const body of repeatedContainers) {
      await expect(importDocx(documentArchive(body))).rejects.toMatchObject({
        code: "invalid_package",
      });
    }

    await expect(
      importDocx(
        documentArchive(
          `<w:p><w:r><w:rPr><w:b r:val="0"/></w:rPr><w:t>x</w:t></w:r></w:p>`,
          `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`,
        ),
      ),
    ).rejects.toMatchObject({ code: "unsupported_feature" });

    const mirroredMargins = buildZip([
      ["[Content_Types].xml", contentTypes(false)],
      ["_rels/.rels", rootRelationships()],
      [
        "word/_rels/document.xml.rels",
        relationships(
          `<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>`,
        ),
      ],
      [
        "word/document.xml",
        xml(
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>`,
        ),
      ],
      [
        "word/settings.xml",
        xml(
          `<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:mirrorMargins/></w:settings>`,
        ),
      ],
    ]);
    await expect(importDocx(mirroredMargins)).rejects.toMatchObject({
      code: "unsupported_feature",
    });
  });

  test("projects only exact break, layout-property, revision, and numbering semantics", async () => {
    const documentArchive = (body: string): ArrayBuffer =>
      buildZip([
        ["[Content_Types].xml", contentTypes(false)],
        ["_rels/.rels", rootRelationships()],
        [
          "word/document.xml",
          xml(
            `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
          ),
        ],
      ]);
    const softBreak = await importDocx(
      documentArchive(
        `<w:p><w:r><w:t>a</w:t><w:br w:type="textWrapping"/><w:t>b</w:t></w:r></w:p>`,
      ),
    );
    expect(softBreak.blocks[0]).toMatchObject({ inlines: [{ text: "a\nb" }] });
    await expect(
      importDocx(documentArchive(`<w:p><w:r><w:br w:type="column"/></w:r></w:p>`)),
    ).rejects.toMatchObject({ code: "unsupported_feature" });
    await expect(
      importDocx(documentArchive(`<w:p><w:r><w:br w:clear="all"/></w:r></w:p>`)),
    ).rejects.toMatchObject({ code: "unsupported_feature" });
    await expect(
      importDocx(documentArchive(`<w:p><w:pPr><w:spacing w:beforeLines="100"/></w:pPr></w:p>`)),
    ).rejects.toMatchObject({ code: "unsupported_feature" });
    await expect(
      importDocx(documentArchive(`<w:p><w:pPr><w:ind w:start="100"/></w:pPr></w:p>`)),
    ).rejects.toMatchObject({ code: "unsupported_feature" });

    const ambiguousMargins = `<w:tbl><w:tblPr><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:start w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="100"/></w:tblGrid><w:tr><w:tc><w:tcPr/><w:p/></w:tc></w:tr></w:tbl>`;
    await expect(importDocx(documentArchive(ambiguousMargins))).rejects.toMatchObject({
      code: "unsupported_feature",
    });

    const settingsArchive = buildZip([
      ["[Content_Types].xml", contentTypes(false)],
      ["_rels/.rels", rootRelationships()],
      [
        "word/_rels/document.xml.rels",
        relationships(
          `<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>`,
        ),
      ],
      [
        "word/document.xml",
        xml(
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>`,
        ),
      ],
      [
        "word/settings.xml",
        xml(
          `<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:trackRevisions w:val="true"/></w:settings>`,
        ),
      ],
    ]);
    expect((await importDocx(settingsArchive)).trackRevisions).toBe(true);

    const numberingArchive = buildZip([
      ["[Content_Types].xml", contentTypes(false)],
      ["_rels/.rels", rootRelationships()],
      [
        "word/_rels/document.xml.rels",
        relationships(
          `<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>`,
        ),
      ],
      [
        "word/document.xml",
        xml(
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>`,
        ),
      ],
      [
        "word/numbering.xml",
        xml(
          `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:lvlRestart w:val="0"/><w:isLgl w:val="true"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
        ),
      ],
    ]);
    expect((await importDocx(numberingArchive)).lists[0]?.levels[0]).toMatchObject({
      restart: 0,
      legal: true,
    });
  });
});

function xml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
}

function contentTypes(comments: boolean): string {
  return xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>
    <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    ${
      comments
        ? `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
    <Override PartName="/word/commentsExtended.xml" ContentType="application/vnd.ms-word.commentsExtended+xml"/>`
        : ""
    }
  </Types>`);
}

function rootRelationships(): string {
  return relationships(
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>`,
  );
}

function relationships(body: string): string {
  return xml(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`,
  );
}

type ZipContent = string | Uint8Array;

function buildZip(entries: ReadonlyArray<readonly [string, ZipContent]>): ArrayBuffer {
  const encoder = new TextEncoder();
  const localRecords: Uint8Array[] = [];
  const centralRecords: Uint8Array[] = [];
  let localOffset = 0;
  for (const [name, content] of entries) {
    const nameBytes = encoder.encode(name);
    const data = typeof content === "string" ? encoder.encode(content) : content;
    const crc = testCrc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    localRecords.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, localOffset, true);
    central.set(nameBytes, 46);
    centralRecords.push(central);
    localOffset += local.length;
  }
  const centralSize = centralRecords.reduce((sum, value) => sum + value.length, 0);
  const output = new Uint8Array(localOffset + centralSize + 22);
  let offset = 0;
  for (const local of localRecords) {
    output.set(local, offset);
    offset += local.length;
  }
  for (const central of centralRecords) {
    output.set(central, offset);
    offset += central.length;
  }
  const eocd = new DataView(output.buffer);
  eocd.setUint32(offset, 0x06054b50, true);
  eocd.setUint16(offset + 8, entries.length, true);
  eocd.setUint16(offset + 10, entries.length, true);
  eocd.setUint32(offset + 12, centralSize, true);
  eocd.setUint32(offset + 16, localOffset, true);
  return output.buffer;
}

function testCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

function overlappingDeflatedEntries(): ArrayBuffer {
  const archive = buildZip([
    ["word/settings.xml", "a"],
    ["word/webSettings.xml", "b"],
  ]);
  const bytes = new Uint8Array(archive);
  const view = new DataView(archive);
  const firstNameLength = view.getUint16(26, true);
  const firstDataOffset = 30 + firstNameLength;
  const secondLocalOffset = firstDataOffset + 1;
  const secondNameLength = view.getUint16(secondLocalOffset + 26, true);
  const secondDataLength = view.getUint32(secondLocalOffset + 18, true);
  const secondRecordEnd = secondLocalOffset + 30 + secondNameLength + secondDataLength;
  const overlappingSize = secondRecordEnd - firstDataOffset;
  const eocdOffset = bytes.byteLength - 22;
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  view.setUint16(8, 8, true);
  view.setUint32(18, overlappingSize, true);
  view.setUint32(22, overlappingSize, true);
  view.setUint16(centralOffset + 10, 8, true);
  view.setUint32(centralOffset + 20, overlappingSize, true);
  view.setUint32(centralOffset + 24, overlappingSize, true);
  return archive;
}
