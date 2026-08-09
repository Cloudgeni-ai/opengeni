import {
  inflateBoundedZipEntry,
  parseBoundedZip,
  verifyBoundedZipEntry,
  type BoundedZipEntry,
  type BoundedZipFailure,
} from "./bounded-zip";
import { FileBlob } from "./file-blob";
import {
  Presentation,
  PresentationFidelityError,
  type PresentationChartConfig,
  type PresentationChartSeriesConfig,
  type PresentationChartType,
  type PresentationFill,
  type PresentationGroupChildConfig,
  type PresentationGroupConfig,
  type PresentationImageConfig,
  type PresentationLayout,
  type PresentationLine,
  type PresentationMaster,
  type PresentationPosition,
  type PresentationShapeConfig,
  type PresentationShapeGeometry,
  type PresentationTableCellInput,
  type PresentationTableConfig,
  type PresentationTemplateElement,
  type PresentationTextStyle,
} from "./presentation";
import {
  PPTX_MEDIA_TYPE,
  PresentationSecurityError,
  type PresentationFidelityIssue,
  type PresentationPptxImportLimits,
  type PresentationPptxImportOptions,
} from "./presentation-pptx-api";
import { setPresentationLossState } from "./presentation-pptx-state";
import {
  parsePptxXmlPart,
  pptxXmlAttribute,
  pptxXmlChild,
  pptxXmlChildren,
  pptxXmlDescendants,
  pptxXmlDirectText,
  pptxXmlQualifiedAttribute,
  pptxXmlText,
  type PptxXmlBudget,
  type PptxXmlElement,
} from "./presentation-pptx-xml";

const OFFICE_RELATIONSHIP_BASE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const PACKAGE_RELATIONSHIP_BASE = "http://schemas.openxmlformats.org/package/2006/relationships/";
const PRESENTATION_MAIN_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
const PRESENTATION_NAMESPACE = "http://schemas.openxmlformats.org/presentationml/2006/main";
const DRAWING_NAMESPACE = "http://schemas.openxmlformats.org/drawingml/2006/main";
const CHART_NAMESPACE = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";
const RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";
const TABLE_GRAPHIC_URI = "http://schemas.openxmlformats.org/drawingml/2006/table";
const CHART_GRAPHIC_URI = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const EMU_PER_PIXEL = 9_525;

export const DEFAULT_PPTX_IMPORT_LIMITS: PresentationPptxImportLimits = Object.freeze({
  compressedBytes: 128 * 1024 * 1024,
  expandedBytes: 256 * 1024 * 1024,
  entryBytes: 64 * 1024 * 1024,
  entries: 30_000,
  compressionRatio: 100,
  totalXmlBytes: 32 * 1024 * 1024,
  xmlBytes: 8 * 1024 * 1024,
  xmlDepth: 192,
  xmlNodes: 2_000_000,
  xmlAttributesPerElement: 512,
  relationshipsPerPart: 8_192,
  relationships: 50_000,
  slides: 10_000,
  elements: 1_000_000,
  textCharacters: 16_000_000,
  imageBytes: 128 * 1024 * 1024,
  chartPoints: 5_000_000,
  nestedPackageBytes: 32 * 1024 * 1024,
  nestedExpandedBytes: 64 * 1024 * 1024,
  nestedEntries: 20_000,
  retainedBytes: 256 * 1024 * 1024,
});

type Relationship = {
  id: string;
  type: string;
  target: string;
  sourcePart: string;
  partName: string;
};

type ImportContext = {
  bytes: Uint8Array;
  limits: PresentationPptxImportLimits;
  entries: ReadonlyMap<string, BoundedZipEntry>;
  xmlBudget: PptxXmlBudget;
  xmlCache: Map<string, PptxXmlElement>;
  bytesCache: Map<string, Uint8Array>;
  relationshipsCache: Map<string, readonly Relationship[]>;
  issues: PresentationFidelityIssue[];
  unsupportedParts: Set<string>;
  elements: number;
  textCharacters: number;
  imageBytes: number;
  chartPoints: number;
  relationships: number;
  nestedExpandedBytes: number;
  nestedEntries: number;
  retainedBytes: number;
  themeColors: ReadonlyMap<string, string>;
};

type Transform = {
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
};

type ParsedElement = PresentationGroupChildConfig & { placeholderType?: string };

export async function importPresentationPptx(
  input: FileBlob | Blob | ArrayBuffer | Uint8Array,
  options: PresentationPptxImportOptions = {},
): Promise<Presentation> {
  const limits = resolveLimits(options.limits);
  const bytes = await toBytes(input);
  if (bytes.byteLength === 0 || bytes.byteLength > limits.compressedBytes) {
    throw pptxSecurity(
      bytes.byteLength === 0 ? "PPTX input is empty" : "PPTX exceeds its compressed byte limit",
      bytes.byteLength === 0 ? "invalid-package" : "limit-exceeded",
    );
  }
  const directory = parseBoundedZip(
    bytes,
    {
      entries: limits.entries,
      compressedEntryBytes: limits.compressedBytes,
      expandedEntryBytes: limits.entryBytes,
      expandedBytes: limits.expandedBytes,
      compressionRatio: limits.compressionRatio,
      compressionRatioThreshold: 1_048_576,
    },
    pptxZipFailure,
  );
  const entries = new Map(directory.map((entry) => [entry.name, entry]));
  const context: ImportContext = {
    bytes,
    limits,
    entries,
    xmlBudget: { limits, totalBytes: 0, totalNodes: 0 },
    xmlCache: new Map(),
    bytesCache: new Map(),
    relationshipsCache: new Map(),
    issues: [],
    unsupportedParts: new Set(),
    elements: 0,
    textCharacters: 0,
    imageBytes: 0,
    chartPoints: 0,
    relationships: 0,
    nestedExpandedBytes: 0,
    nestedEntries: 0,
    retainedBytes: bytes.byteLength,
    themeColors: DEFAULT_THEME_COLORS,
  };

  await preflightPackage(context);
  const rootRelationships = relationshipsFor(context, "");
  const officeDocuments = rootRelationships.filter(
    (relationship) => relationship.type === `${OFFICE_RELATIONSHIP_BASE}officeDocument`,
  );
  if (officeDocuments.length !== 1 || officeDocuments[0]?.partName !== "ppt/presentation.xml") {
    throw pptxSecurity(
      "PPTX must contain exactly one canonical ppt/presentation.xml office document",
      "invalid-package",
      "_rels/.rels",
    );
  }
  const presentationRoot = readXml(context, "ppt/presentation.xml");
  requireRoot(presentationRoot, "presentation", PRESENTATION_NAMESPACE, "ppt/presentation.xml");
  const presentationRelationships = relationshipsFor(context, "ppt/presentation.xml");
  const presentationRelationshipById = byRelationshipId(presentationRelationships);
  const slideSize = parseSlideSize(presentationRoot);

  const themeRelationship = presentationRelationships.find(
    (relationship) => relationship.type === `${OFFICE_RELATIONSHIP_BASE}theme`,
  );
  if (themeRelationship) {
    context.themeColors = parseThemeColors(
      readXml(context, themeRelationship.partName),
      themeRelationship.partName,
    );
  }

  const presentation = Presentation.create({ slideSize });
  const masterByPart = new Map<string, PresentationMaster>();
  const layoutByPart = new Map<string, PresentationLayout>();
  importMastersAndLayouts(
    context,
    presentation,
    presentationRoot,
    presentationRelationshipById,
    masterByPart,
    layoutByPart,
  );
  importSlides(context, presentation, presentationRoot, presentationRelationshipById, layoutByPart);

  const deduplicatedIssues = deduplicateIssues(context.issues);
  if (options.unsupportedContent === "error" && deduplicatedIssues.length > 0) {
    throw new PresentationFidelityError(
      "PPTX contains inert content that the editable presentation model cannot regenerate exactly",
      deduplicatedIssues,
    );
  }
  const { presentationModelDigest, sha256Hex } = await import("./presentation-pptx-state-digest");
  setPresentationLossState(presentation, {
    version: 1,
    mediaType: PPTX_MEDIA_TYPE,
    sourceBytes: bytes,
    sourceDigest: await sha256Hex(bytes),
    unsupportedParts: [...context.unsupportedParts].sort(),
    modelDigest: await presentationModelDigest(presentation),
  });
  return presentation;
}

function resolveLimits(
  requested: Partial<PresentationPptxImportLimits> | undefined,
): PresentationPptxImportLimits {
  const limits = { ...DEFAULT_PPTX_IMPORT_LIMITS, ...requested };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw pptxSecurity(`Invalid PPTX import limit: ${name}`, "limit-exceeded");
    }
    const maximum = DEFAULT_PPTX_IMPORT_LIMITS[name as keyof PresentationPptxImportLimits];
    if (value > maximum) {
      throw pptxSecurity(
        `PPTX import limit ${name} may only tighten the production maximum`,
        "limit-exceeded",
      );
    }
  }
  return limits;
}

async function toBytes(input: FileBlob | Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input.slice();
  if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
  if (input instanceof Blob) return new Uint8Array(await input.arrayBuffer());
  throw pptxSecurity("PPTX input must be a Blob, ArrayBuffer, or Uint8Array", "invalid-package");
}

async function preflightPackage(context: ImportContext): Promise<void> {
  if (!context.entries.has("[Content_Types].xml") || !context.entries.has("_rels/.rels")) {
    throw pptxSecurity("PPTX is missing required OPC package parts", "invalid-package");
  }
  for (const entry of context.entries.values()) rejectActiveEntry(entry.name, entry.directory);
  for (const entry of context.entries.values()) {
    if (entry.directory) continue;
    if (isXmlPart(entry.name)) {
      const xmlBytes = await inflateBoundedZipEntry(
        context.bytes,
        entry,
        context.limits.entryBytes,
        pptxZipFailure,
      );
      reserveRetained(context, xmlBytes.byteLength * 3, entry.name);
      context.bytesCache.set(entry.name, xmlBytes);
      readXml(context, entry.name);
    } else if (isRasterMediaPart(entry.name)) {
      const imageBytes = await inflateBoundedZipEntry(
        context.bytes,
        entry,
        context.limits.entryBytes,
        pptxZipFailure,
      );
      reserveRetained(context, imageBytes.byteLength, entry.name);
      context.bytesCache.set(entry.name, imageBytes);
    } else if (/^ppt\/embeddings\/.*\.xlsx$/i.test(entry.name)) {
      const nestedBytes = await inflateBoundedZipEntry(
        context.bytes,
        entry,
        context.limits.nestedPackageBytes,
        pptxZipFailure,
      );
      await preflightEmbeddedXlsx(context, entry, nestedBytes);
    } else {
      await verifyBoundedZipEntry(context.bytes, entry, context.limits.entryBytes, pptxZipFailure);
    }
  }
  validateContentTypes(context);
  for (const entry of context.entries.values()) {
    if (!entry.name.endsWith(".rels")) continue;
    relationshipsForPart(context, entry.name);
  }
  validateRelationshipTargets(context);
  classifySourceOnlyParts(context);
}

function isXmlPart(name: string): boolean {
  return name === "[Content_Types].xml" || /(?:\.xml|\.rels)$/i.test(name);
}

function readXml(context: ImportContext, partName: string): PptxXmlElement {
  const cached = context.xmlCache.get(partName);
  if (cached) return cached;
  const bytes = readPartBytes(context, partName);
  const parsed = parsePptxXmlPart(bytes, partName, context.xmlBudget);
  context.xmlCache.set(partName, parsed);
  context.bytesCache.delete(partName);
  return parsed;
}

function readPartBytes(context: ImportContext, partName: string): Uint8Array {
  const cached = context.bytesCache.get(partName);
  if (cached) return cached;
  const entry = context.entries.get(partName);
  if (!entry || entry.directory) {
    throw pptxSecurity("Required PPTX part is missing", "invalid-package", partName);
  }
  // XML is inflated synchronously by preflight before projection; cached access is sync.
  throw pptxSecurity(
    "PPTX part was not inflated during bounded preflight",
    "invalid-package",
    partName,
  );
}

function validateContentTypes(context: ImportContext): void {
  const root = readXml(context, "[Content_Types].xml");
  requireRoot(root, "Types", CONTENT_TYPES_NAMESPACE, "[Content_Types].xml");
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const child of pptxXmlChildren(root)) {
    if (child.localName === "Default") {
      const extension = requiredAttribute(child, "Extension", "[Content_Types].xml").toLowerCase();
      const contentType = requiredAttribute(child, "ContentType", "[Content_Types].xml");
      if (defaults.has(extension)) {
        throw pptxSecurity(
          "Duplicate OPC content-type extension",
          "invalid-package",
          "[Content_Types].xml",
        );
      }
      defaults.set(extension, contentType);
      if (!KNOWN_DEFAULT_CONTENT_TYPES.has(`${extension}\0${contentType}`)) {
        markSourceOnly(context, ["[Content_Types].xml"]);
      }
    } else if (child.localName === "Override") {
      const name = requiredAttribute(child, "PartName", "[Content_Types].xml");
      if (!name.startsWith("/") || name.includes("\\") || name.includes("..")) {
        throw pptxSecurity(
          "Unsafe OPC content-type part name",
          "invalid-package",
          "[Content_Types].xml",
        );
      }
      const normalized = name.slice(1);
      const contentType = requiredAttribute(child, "ContentType", "[Content_Types].xml");
      if (overrides.has(normalized.toLowerCase())) {
        throw pptxSecurity("Duplicate OPC content-type override", "invalid-package", normalized);
      }
      overrides.set(normalized.toLowerCase(), contentType);
      if (!isKnownPptxPart(normalized)) {
        markSourceOnly(context, ["[Content_Types].xml", normalized]);
      }
    } else {
      throw pptxSecurity(
        "Unknown OPC content-type declaration",
        "invalid-package",
        "[Content_Types].xml",
      );
    }
  }
  const presentationType = overrides.get("ppt/presentation.xml");
  if (presentationType !== PRESENTATION_MAIN_TYPE) {
    throw pptxSecurity(
      presentationType?.includes("macroEnabled")
        ? "Macro-enabled presentations are forbidden"
        : "ppt/presentation.xml has the wrong content type",
      presentationType?.includes("macroEnabled") ? "active-content" : "invalid-package",
      "[Content_Types].xml",
    );
  }
  for (const entry of context.entries.values()) {
    if (entry.directory || entry.name === "[Content_Types].xml") continue;
    const extension = entry.name.includes(".")
      ? entry.name.slice(entry.name.lastIndexOf(".") + 1).toLowerCase()
      : "";
    const contentType = overrides.get(entry.name.toLowerCase()) ?? defaults.get(extension);
    if (!contentType) {
      throw pptxSecurity("OPC package part lacks a content type", "invalid-package", entry.name);
    }
    if (isActiveContentType(contentType)) {
      throw pptxSecurity("Active OPC content type is forbidden", "active-content", entry.name);
    }
  }
}

function relationshipsFor(context: ImportContext, sourcePart: string): readonly Relationship[] {
  return relationshipsForPart(context, relationshipPartName(sourcePart));
}

function relationshipsForPart(
  context: ImportContext,
  relationshipsPart: string,
): readonly Relationship[] {
  const cached = context.relationshipsCache.get(relationshipsPart);
  if (cached) return cached;
  if (!context.entries.has(relationshipsPart)) {
    if (relationshipsPart === "_rels/.rels") {
      throw pptxSecurity(
        "OPC root relationships are missing",
        "invalid-package",
        relationshipsPart,
      );
    }
    context.relationshipsCache.set(relationshipsPart, []);
    return [];
  }
  const root = readXml(context, relationshipsPart);
  requireRoot(root, "Relationships", RELATIONSHIPS_NAMESPACE, relationshipsPart);
  const sourcePart = relationshipSourcePart(relationshipsPart);
  const relationships: Relationship[] = [];
  const ids = new Set<string>();
  for (const child of pptxXmlChildren(root)) {
    if (child.localName !== "Relationship" || pptxXmlChildren(child).length > 0) {
      throw pptxSecurity("Invalid OPC relationship element", "invalid-package", relationshipsPart);
    }
    if (relationships.length >= context.limits.relationshipsPerPart) {
      throw pptxSecurity(
        "Relationship part exceeds its relationship limit",
        "limit-exceeded",
        relationshipsPart,
      );
    }
    const id = requiredAttribute(child, "Id", relationshipsPart);
    const type = requiredAttribute(child, "Type", relationshipsPart);
    const target = requiredAttribute(child, "Target", relationshipsPart);
    if (id.length > 512 || type.length > 2_048 || target.length > 4_096 || ids.has(id)) {
      throw pptxSecurity(
        "Duplicate or oversized OPC relationship",
        "invalid-package",
        relationshipsPart,
      );
    }
    ids.add(id);
    const targetMode = pptxXmlAttribute(child, "TargetMode") ?? "Internal";
    if (targetMode !== "Internal") {
      throw pptxSecurity(
        "External OPC relationships are forbidden",
        "external-relationship",
        relationshipsPart,
      );
    }
    if (/^(?:https?|ftp|file|data|javascript):/i.test(target)) {
      throw pptxSecurity(
        "External OPC relationship target is forbidden",
        "external-relationship",
        relationshipsPart,
      );
    }
    const partName = resolvePartTarget(sourcePart, target, relationshipsPart);
    const relationship = { id, type, target, sourcePart, partName };
    validateRelationshipKind(context, relationship, relationshipsPart);
    relationships.push(relationship);
  }
  context.relationships += relationships.length;
  if (context.relationships > context.limits.relationships) {
    throw pptxSecurity(
      "PPTX exceeds its total relationship limit",
      "limit-exceeded",
      relationshipsPart,
    );
  }
  context.relationshipsCache.set(relationshipsPart, relationships);
  return relationships;
}

function validateRelationshipKind(
  context: ImportContext,
  relationship: Relationship,
  relationshipsPart: string,
): void {
  const suffix = relationship.type.slice(relationship.type.lastIndexOf("/") + 1);
  const standardOfficeRelationship = relationship.type === `${OFFICE_RELATIONSHIP_BASE}${suffix}`;
  const standardPackageRelationship = relationship.type === `${PACKAGE_RELATIONSHIP_BASE}${suffix}`;
  if (
    !standardOfficeRelationship &&
    !standardPackageRelationship &&
    !ALLOWED_EXACT_RELATIONSHIPS.has(relationship.type)
  ) {
    throw pptxSecurity(
      `Unsupported or non-standard presentation relationship type: ${relationship.type}`,
      "invalid-package",
      relationshipsPart,
    );
  }
  if (ACTIVE_RELATIONSHIP_SUFFIX.test(suffix)) {
    throw pptxSecurity(
      "Active or remote presentation relationship is forbidden",
      "active-content",
      relationshipsPart,
    );
  }
  if (!KNOWN_RELATIONSHIP_SUFFIXES.has(suffix)) {
    markSourceOnly(context, [relationshipsPart, relationship.partName]);
  }
  if (suffix === "package") {
    const safeChartWorkbook =
      /^ppt\/charts\/chart\d+\.xml$/i.test(relationship.sourcePart) &&
      /^ppt\/embeddings\/[^/]+\.xlsx$/i.test(relationship.partName);
    if (!safeChartWorkbook) {
      throw pptxSecurity(
        "Embedded packages are forbidden outside chart data workbooks",
        "active-content",
        relationshipsPart,
      );
    }
  }
  if (suffix === "hyperlink") {
    context.unsupportedParts.add(relationshipsPart);
    context.issues.push(fidelityIssue("hyperlink", [relationshipsPart]));
  }
  if (SOURCE_ONLY_RELATIONSHIP_SUFFIXES.has(suffix)) {
    context.unsupportedParts.add(relationshipsPart);
    context.issues.push(fidelityIssue("theme", [relationshipsPart, relationship.partName]));
  }
}

function classifySourceOnlyParts(context: ImportContext): void {
  for (const entry of context.entries.values()) {
    if (!entry.directory && !isKnownPptxPart(entry.name)) {
      markSourceOnly(context, [entry.name, "[Content_Types].xml"]);
    }
  }
}

function markSourceOnly(context: ImportContext, parts: readonly string[]): void {
  for (const part of parts) context.unsupportedParts.add(part);
  context.issues.push(fidelityIssue("source-only", parts));
}

function isKnownPptxPart(name: string): boolean {
  return KNOWN_PPTX_PART_PATTERNS.some((pattern) => pattern.test(name));
}

function isActiveContentType(contentType: string): boolean {
  return /(?:macroEnabled|vbaProject|activeX|oleObject|javascript|ecmascript|x-msdownload|executable|powershell|shellscript|text\/html)/i.test(
    contentType,
  );
}

function validateRelationshipTargets(context: ImportContext): void {
  for (const relationships of context.relationshipsCache.values()) {
    for (const relationship of relationships) {
      const suffix = relationship.type.slice(relationship.type.lastIndexOf("/") + 1);
      if (suffix === "hyperlink") continue;
      if (!context.entries.has(relationship.partName)) {
        throw pptxSecurity(
          "OPC relationship targets a missing package part",
          "invalid-package",
          relationship.partName,
        );
      }
    }
  }
}

async function preflightEmbeddedXlsx(
  context: ImportContext,
  entry: BoundedZipEntry,
  bytes: Uint8Array,
): Promise<void> {
  if (entry.expandedSize > context.limits.nestedPackageBytes) {
    throw pptxSecurity(
      "Embedded chart workbook exceeds its byte limit",
      "limit-exceeded",
      entry.name,
    );
  }
  const nested = parseBoundedZip(
    bytes,
    {
      entries: Math.min(context.limits.entries, 10_000),
      compressedEntryBytes: context.limits.nestedPackageBytes,
      expandedEntryBytes: context.limits.nestedPackageBytes,
      expandedBytes: context.limits.nestedPackageBytes,
      compressionRatio: context.limits.compressionRatio,
      compressionRatioThreshold: 1_048_576,
    },
    pptxZipFailure,
  );
  context.nestedEntries += nested.length;
  context.nestedExpandedBytes += nested.reduce((sum, part) => sum + part.expandedSize, 0);
  if (
    context.nestedEntries > context.limits.nestedEntries ||
    context.nestedExpandedBytes > context.limits.nestedExpandedBytes
  ) {
    throw pptxSecurity(
      "Embedded chart workbooks exceed the global nested archive budget",
      "limit-exceeded",
      entry.name,
    );
  }
  for (const nestedEntry of nested) {
    rejectNestedWorkbookEntry(nestedEntry.name, entry.name);
    if (nestedEntry.directory) continue;
    if (isXmlPart(nestedEntry.name)) {
      const xmlBytes = await inflateBoundedZipEntry(
        bytes,
        nestedEntry,
        context.limits.nestedPackageBytes,
        pptxZipFailure,
      );
      const root = parsePptxXmlPart(
        xmlBytes,
        `${entry.name}!/${nestedEntry.name}`,
        context.xmlBudget,
      );
      if (nestedEntry.name.endsWith(".rels")) {
        for (const relationship of pptxXmlChildren(root)) {
          if (relationship.localName !== "Relationship") {
            throw pptxSecurity(
              "Embedded workbook relationship XML is invalid",
              "invalid-package",
              entry.name,
            );
          }
          const targetMode = pptxXmlAttribute(relationship, "TargetMode") ?? "Internal";
          const target = requiredAttribute(
            relationship,
            "Target",
            `${entry.name}!/${nestedEntry.name}`,
          );
          if (
            targetMode !== "Internal" ||
            /^(?:https?|ftp|file|data|javascript):/i.test(target) ||
            target.includes("\\") ||
            /%(?:2e|2f|5c)/i.test(target)
          ) {
            throw pptxSecurity(
              "Embedded chart workbook contains an external relationship",
              "external-relationship",
              entry.name,
            );
          }
        }
      }
      if (pptxXmlDescendants(root, "f").length > 0) {
        throw pptxSecurity(
          "Formula-bearing embedded chart workbooks are not retained",
          "active-content",
          entry.name,
        );
      }
    } else {
      await verifyBoundedZipEntry(
        bytes,
        nestedEntry,
        context.limits.nestedPackageBytes,
        pptxZipFailure,
      );
    }
  }
}

function rejectNestedWorkbookEntry(name: string, container: string): void {
  if (
    /(?:^|\/)(?:vbaProject|vbaData)\.bin$/i.test(name) ||
    /(?:^|\/)(?:activeX|embeddings|externalLinks|connections|queryTables|webextensions)(?:\/|$)/i.test(
      name,
    ) ||
    /\.(?:exe|dll|com|msi|js|vbs|bat|cmd|ps1|sh|scr|jar)$/i.test(name)
  ) {
    throw pptxSecurity(
      `Embedded chart workbook contains active content: ${name}`,
      "active-content",
      container,
    );
  }
}

function rejectActiveEntry(name: string, directory = false): void {
  const safeChartWorkbook = /^ppt\/embeddings\/[^/]+\.xlsx$/i.test(name);
  if (
    /(?:^|\/)(?:vbaProject|vbaData)\.bin$/i.test(name) ||
    /(?:^|\/)(?:activeX|oleObject|externalLinks|connections|webextensions)(?:\/|$)/i.test(name) ||
    /^ppt\/(?:audio|video)\//i.test(name) ||
    (/^ppt\/embeddings\//i.test(name) && !directory && !safeChartWorkbook) ||
    (!directory && /\.(?:zip|docx|dotx|xlsx|xltx|pptx|ppsx)$/i.test(name) && !safeChartWorkbook) ||
    /\.(?:exe|dll|com|msi|js|vbs|vbe|bat|cmd|ps1|sh|scr|jar|ppam|pptm|svg|svgz|html?|mhtml)$/i.test(
      name,
    )
  ) {
    throw pptxSecurity("Active presentation content is forbidden", "active-content", name);
  }
}

function isRasterMediaPart(name: string): boolean {
  return /^ppt\/media\/[^/]+\.(?:png|jpe?g|gif|webp)$/i.test(name);
}

function reserveRetained(context: ImportContext, bytes: number, partName: string): void {
  context.retainedBytes += bytes;
  if (context.retainedBytes > context.limits.retainedBytes) {
    throw pptxSecurity("PPTX exceeds its retained-memory budget", "limit-exceeded", partName);
  }
}

function importMastersAndLayouts(
  context: ImportContext,
  presentation: Presentation,
  presentationRoot: PptxXmlElement,
  presentationRelationships: ReadonlyMap<string, Relationship>,
  masterByPart: Map<string, PresentationMaster>,
  layoutByPart: Map<string, PresentationLayout>,
): void {
  const masterIds = pptxXmlChildren(pptxXmlChild(presentationRoot, "sldMasterIdLst"));
  for (const masterId of masterIds) {
    const relationshipId = requiredRelationshipId(masterId, "ppt/presentation.xml");
    const relationship = presentationRelationships.get(relationshipId);
    if (!relationship || relationship.type !== `${OFFICE_RELATIONSHIP_BASE}slideMaster`) {
      throw pptxSecurity(
        "Slide master id references the wrong relationship",
        "invalid-package",
        "ppt/presentation.xml",
      );
    }
    const masterRoot = readXml(context, relationship.partName);
    requireRoot(masterRoot, "sldMaster", PRESENTATION_NAMESPACE, relationship.partName);
    const common = requiredChild(masterRoot, "cSld", relationship.partName);
    const masterRelationships = byRelationshipId(relationshipsFor(context, relationship.partName));
    const elements = parseTemplateTree(
      context,
      requiredChild(common, "spTree", relationship.partName),
      masterRelationships,
      relationship.partName,
    );
    const master = presentation.masters.add({
      name: pptxXmlAttribute(common, "name") ?? `Master ${presentation.masters.items.length + 1}`,
      background: parseBackground(context, common),
      elements,
    });
    masterByPart.set(relationship.partName, master);

    for (const layoutId of pptxXmlChildren(pptxXmlChild(masterRoot, "sldLayoutIdLst"))) {
      const layoutRelationshipId = requiredRelationshipId(layoutId, relationship.partName);
      const layoutRelationship = masterRelationships.get(layoutRelationshipId);
      if (
        !layoutRelationship ||
        layoutRelationship.type !== `${OFFICE_RELATIONSHIP_BASE}slideLayout`
      ) {
        throw pptxSecurity(
          "Slide layout id references the wrong relationship",
          "invalid-package",
          relationship.partName,
        );
      }
      if (layoutByPart.has(layoutRelationship.partName)) continue;
      const layoutRoot = readXml(context, layoutRelationship.partName);
      requireRoot(layoutRoot, "sldLayout", PRESENTATION_NAMESPACE, layoutRelationship.partName);
      const layoutCommon = requiredChild(layoutRoot, "cSld", layoutRelationship.partName);
      const layoutRelationships = byRelationshipId(
        relationshipsFor(context, layoutRelationship.partName),
      );
      const parent = [...layoutRelationships.values()].find(
        (candidate) => candidate.type === `${OFFICE_RELATIONSHIP_BASE}slideMaster`,
      );
      if (!parent || parent.partName !== relationship.partName) {
        throw pptxSecurity(
          "Slide layout does not link back to its master",
          "invalid-package",
          layoutRelationship.partName,
        );
      }
      const layout = presentation.layouts.add({
        name:
          pptxXmlAttribute(layoutCommon, "name") ??
          `Layout ${presentation.layouts.items.length + 1}`,
        masterId: master.id,
        background: parseBackground(context, layoutCommon),
        elements: parseTemplateTree(
          context,
          requiredChild(layoutCommon, "spTree", layoutRelationship.partName),
          layoutRelationships,
          layoutRelationship.partName,
        ),
      });
      layoutByPart.set(layoutRelationship.partName, layout);
    }
  }
}

function importSlides(
  context: ImportContext,
  presentation: Presentation,
  presentationRoot: PptxXmlElement,
  presentationRelationships: ReadonlyMap<string, Relationship>,
  layoutByPart: ReadonlyMap<string, PresentationLayout>,
): void {
  const slideIds = pptxXmlChildren(pptxXmlChild(presentationRoot, "sldIdLst"));
  if (slideIds.length > context.limits.slides) {
    throw pptxSecurity("PPTX exceeds its slide limit", "limit-exceeded", "ppt/presentation.xml");
  }
  const seenParts = new Set<string>();
  for (const slideId of slideIds) {
    const relationshipId = requiredRelationshipId(slideId, "ppt/presentation.xml");
    const relationship = presentationRelationships.get(relationshipId);
    if (
      !relationship ||
      relationship.type !== `${OFFICE_RELATIONSHIP_BASE}slide` ||
      seenParts.has(relationship.partName)
    ) {
      throw pptxSecurity(
        "Slide id references an invalid or duplicate slide",
        "invalid-package",
        "ppt/presentation.xml",
      );
    }
    seenParts.add(relationship.partName);
    const root = readXml(context, relationship.partName);
    requireRoot(root, "sld", PRESENTATION_NAMESPACE, relationship.partName);
    const common = requiredChild(root, "cSld", relationship.partName);
    const relationships = relationshipsFor(context, relationship.partName);
    const relationshipById = byRelationshipId(relationships);
    const slide = presentation.slides.add();
    slide.title = pptxXmlAttribute(common, "name") ?? "";
    slide.background.fill = parseBackground(context, common);
    const layoutRelationship = relationships.find(
      (candidate) => candidate.type === `${OFFICE_RELATIONSHIP_BASE}slideLayout`,
    );
    if (!layoutRelationship) {
      throw pptxSecurity(
        "Slide lacks a slide-layout relationship",
        "invalid-package",
        relationship.partName,
      );
    }
    const layout = layoutByPart.get(layoutRelationship.partName);
    if (!layout) {
      throw pptxSecurity(
        "Slide references an unknown slide layout",
        "invalid-package",
        relationship.partName,
      );
    }
    slide.setLayout(layout);
    const parsed = parseSceneTree(
      context,
      requiredChild(common, "spTree", relationship.partName),
      relationshipById,
      relationship.partName,
    );
    let derivedTitle: string | undefined;
    for (const element of parsed) {
      switch (element.kind) {
        case "shape": {
          const shape = slide.shapes.add(element.config);
          if (
            !derivedTitle &&
            (shape.placeholder?.type === "title" || shape.placeholder?.type === "ctrTitle") &&
            shape.text.toString().length > 0
          )
            derivedTitle = shape.text.toString();
          break;
        }
        case "chart":
          slide.charts.add(element.type, element.config ?? {});
          break;
        case "image":
          slide.images.add(element.config);
          break;
        case "table":
          slide.tables.add(element.config);
          break;
        case "group":
          slide.groups.add(element.config);
          break;
      }
    }
    if (derivedTitle) slide.title = derivedTitle;
    const notesRelationship = relationships.find(
      (candidate) => candidate.type === `${OFFICE_RELATIONSHIP_BASE}notesSlide`,
    );
    if (notesRelationship) slide.notes.set(parseNotes(context, notesRelationship.partName));
    if (pptxXmlChild(root, "transition"))
      addUnsupported(context, "transition", relationship.partName);
    if (pptxXmlChild(root, "timing")) addUnsupported(context, "animation", relationship.partName);
  }
}

function parseTemplateTree(
  context: ImportContext,
  tree: PptxXmlElement,
  relationships: ReadonlyMap<string, Relationship>,
  partName: string,
): PresentationTemplateElement[] {
  const output: PresentationTemplateElement[] = [];
  for (const element of parseSceneTree(context, tree, relationships, partName)) {
    if (element.kind === "group") {
      // The model keeps true groups on slides; template groups remain source-preserved
      // until the package-native writer supports inherited nested group transforms.
      addUnsupported(context, "group", partName);
    } else output.push(element);
  }
  return output;
}

function parseSceneTree(
  context: ImportContext,
  tree: PptxXmlElement,
  relationships: ReadonlyMap<string, Relationship>,
  partName: string,
  transform: Transform = IDENTITY_TRANSFORM,
  depth = 0,
): ParsedElement[] {
  if (depth > 32)
    throw pptxSecurity("Presentation group nesting exceeds its limit", "limit-exceeded", partName);
  const output: ParsedElement[] = [];
  for (const element of pptxXmlChildren(tree)) {
    if (element.localName === "nvGrpSpPr" || element.localName === "grpSpPr") continue;
    consumeElement(context, partName);
    switch (element.localName) {
      case "sp":
      case "cxnSp":
        if (element.localName === "cxnSp") {
          addUnsupported(context, "connector", partName, "style-approximated");
        }
        output.push({ kind: "shape", config: parseShape(context, element, partName, transform) });
        break;
      case "pic":
        {
          const image = parseImage(context, element, relationships, partName, transform);
          if (image) output.push({ kind: "image", config: image });
        }
        break;
      case "graphicFrame": {
        const graphicData = pptxXmlDescendants(element, "graphicData")[0];
        const uri = pptxXmlAttribute(graphicData, "uri");
        if (uri === TABLE_GRAPHIC_URI) {
          output.push({ kind: "table", config: parseTable(context, element, partName, transform) });
        } else if (uri === CHART_GRAPHIC_URI) {
          const chartRef = pptxXmlDescendants(graphicData, "chart")[0];
          const relationshipId = requiredRelationshipId(chartRef, partName);
          const relationship = relationships.get(relationshipId);
          if (!relationship || relationship.type !== `${OFFICE_RELATIONSHIP_BASE}chart`) {
            throw pptxSecurity(
              "Chart frame references the wrong relationship",
              "invalid-package",
              partName,
            );
          }
          const parsed = parseChart(context, relationship.partName);
          if (parsed) {
            const frameName = nonVisualName(element);
            if (frameName) parsed.config.name = frameName;
            parsed.config.position = parseFramePosition(element, partName, transform);
            output.push({ kind: "chart", ...parsed });
          }
        } else {
          addUnsupported(context, "smart-art", partName);
        }
        break;
      }
      case "grpSp": {
        const group = parseGroup(context, element, relationships, partName, transform, depth + 1);
        output.push({ kind: "group", config: group });
        break;
      }
      case "contentPart":
      case "alternateContent":
      case "extLst":
        addUnsupported(context, "custom-geometry", partName);
        break;
      default:
        addUnsupported(context, "custom-geometry", partName);
    }
  }
  return output;
}

function parseGroup(
  context: ImportContext,
  group: PptxXmlElement,
  relationships: ReadonlyMap<string, Relationship>,
  partName: string,
  parentTransform: Transform,
  depth: number,
): PresentationGroupConfig {
  const properties = requiredChild(group, "grpSpPr", partName);
  const xfrm = requiredChild(properties, "xfrm", partName);
  const rawPosition = rawPositionFromXfrm(xfrm, partName);
  const childOffsetElement = requiredChild(xfrm, "chOff", partName);
  const childExtentElement = requiredChild(xfrm, "chExt", partName);
  const childOffset = {
    left: emuNumber(requiredAttribute(childOffsetElement, "x", partName), partName),
    top: emuNumber(requiredAttribute(childOffsetElement, "y", partName), partName),
  };
  const childExtent = {
    width: positiveEmu(requiredAttribute(childExtentElement, "cx", partName), partName),
    height: positiveEmu(requiredAttribute(childExtentElement, "cy", partName), partName),
  };
  const position = applyTransform(rawPosition, parentTransform);
  const name = nonVisualName(group) ?? `Group ${context.elements}`;
  return {
    name,
    position,
    childOffset,
    childExtent,
    rotation: rotationFromXfrm(xfrm, partName),
    flipHorizontal: booleanAttribute(xfrm, "flipH"),
    flipVertical: booleanAttribute(xfrm, "flipV"),
    children: parseSceneTree(context, group, relationships, partName, IDENTITY_TRANSFORM, depth),
  };
}

function parseShape(
  context: ImportContext,
  element: PptxXmlElement,
  partName: string,
  transform: Transform,
): PresentationShapeConfig {
  const properties = pptxXmlChild(element, "spPr");
  const xfrm = pptxXmlChild(properties, "xfrm");
  const position = xfrm
    ? applyTransform(rawPositionFromXfrm(xfrm, partName), transform)
    : applyTransform({ left: 0, top: 0, width: 1, height: 1 }, transform);
  const preset =
    pptxXmlAttribute(pptxXmlChild(properties, "prstGeom"), "prst") ??
    (element.localName === "cxnSp" ? "line" : "rect");
  const geometry = mapGeometry(context, preset, partName);
  const text = parseTextBody(context, pptxXmlChild(element, "txBody"), partName);
  const placeholderElement = pptxXmlDescendants(
    pptxXmlChild(element, element.localName === "cxnSp" ? "nvCxnSpPr" : "nvSpPr"),
    "ph",
  )[0];
  const placeholderType = pptxXmlAttribute(placeholderElement, "type");
  const placeholderIndex = optionalInteger(pptxXmlAttribute(placeholderElement, "idx"), partName);
  return {
    geometry,
    name: nonVisualName(element) ?? `Shape ${context.elements}`,
    position,
    fill: parseFill(context, properties, "white") ?? "white",
    line: parseLine(context, pptxXmlChild(properties, "ln"), partName),
    text: text.value,
    textStyle: text.style,
    rotation: xfrm ? rotationFromXfrm(xfrm, partName) : 0,
    ...(placeholderType
      ? {
          placeholder: {
            type: placeholderType,
            ...(placeholderIndex === undefined ? {} : { index: placeholderIndex }),
          },
        }
      : {}),
  };
}

function parseImage(
  context: ImportContext,
  element: PptxXmlElement,
  relationships: ReadonlyMap<string, Relationship>,
  partName: string,
  transform: Transform,
): PresentationImageConfig | undefined {
  const blip = pptxXmlDescendants(element, "blip")[0];
  const relationshipId = requiredRelationshipId(blip, partName, "embed");
  const relationship = relationships.get(relationshipId);
  if (!relationship || relationship.type !== `${OFFICE_RELATIONSHIP_BASE}image`) {
    throw pptxSecurity("Picture references the wrong relationship", "invalid-package", partName);
  }
  if (!isRasterMediaPart(relationship.partName)) {
    addUnsupported(context, "media", relationship.partName);
    return undefined;
  }
  const bytes = readPartBytes(context, relationship.partName);
  context.imageBytes += bytes.byteLength;
  if (context.imageBytes > context.limits.imageBytes) {
    throw pptxSecurity(
      "PPTX exceeds its decoded image byte limit",
      "limit-exceeded",
      relationship.partName,
    );
  }
  const properties = requiredChild(element, "spPr", partName);
  const xfrm = requiredChild(properties, "xfrm", partName);
  const cropElement = pptxXmlDescendants(pptxXmlChild(element, "blipFill"), "srcRect")[0];
  const crop = cropElement
    ? {
        left: cropPercent(pptxXmlAttribute(cropElement, "l"), partName),
        top: cropPercent(pptxXmlAttribute(cropElement, "t"), partName),
        right: cropPercent(pptxXmlAttribute(cropElement, "r"), partName),
        bottom: cropPercent(pptxXmlAttribute(cropElement, "b"), partName),
      }
    : undefined;
  const geometry = mapImageGeometry(
    pptxXmlAttribute(pptxXmlChild(properties, "prstGeom"), "prst") ?? "rect",
  );
  const name = nonVisualName(element) ?? `Image ${context.elements}`;
  const description = nonVisualDescription(element) ?? "";
  const imageConfig: PresentationImageConfig = {
    blob: bytes.slice(),
    contentType: rasterContentType(relationship.partName),
    name,
    alt: description,
    position: applyTransform(rawPositionFromXfrm(xfrm, partName), transform),
    fit: crop ? "cover" : "contain",
    geometry,
    rotation: rotationFromXfrm(xfrm, partName),
    flipHorizontal: booleanAttribute(xfrm, "flipH"),
    flipVertical: booleanAttribute(xfrm, "flipV"),
    lockAspectRatio: booleanAttribute(pptxXmlDescendants(element, "picLocks")[0], "noChangeAspect"),
    ...(crop ? { crop } : {}),
  };
  return imageConfig;
}

function parseTable(
  context: ImportContext,
  frame: PptxXmlElement,
  partName: string,
  transform: Transform,
): PresentationTableConfig {
  const table = pptxXmlDescendants(frame, "tbl")[0];
  if (!table) throw pptxSecurity("Table frame lacks table data", "invalid-package", partName);
  const grid = requiredChild(table, "tblGrid", partName);
  const columnWidths = pptxXmlChildren(grid).map((column) =>
    positiveEmu(requiredAttribute(column, "w", partName), partName),
  );
  if (columnWidths.length === 0) {
    throw pptxSecurity("Presentation table has no columns", "invalid-package", partName);
  }
  const rowElements = pptxXmlChildren(table).filter((child) => child.localName === "tr");
  const rows: PresentationTableCellInput[][] = [];
  const rowHeights: number[] = [];
  const occupied = Array.from(
    { length: rowElements.length },
    () => new Uint8Array(columnWidths.length),
  );
  for (const [rowIndex, rowElement] of rowElements.entries()) {
    rowHeights.push(positiveEmu(requiredAttribute(rowElement, "h", partName), partName));
    const row: PresentationTableCellInput[] = Array.from(
      { length: columnWidths.length },
      () => null,
    );
    let column = 0;
    for (const cellElement of pptxXmlChildren(rowElement).filter(
      (child) => child.localName === "tc",
    )) {
      if (column >= columnWidths.length) {
        throw pptxSecurity("Presentation table row exceeds its grid", "invalid-package", partName);
      }
      const properties = pptxXmlChild(cellElement, "tcPr");
      const horizontalMerge =
        booleanAttribute(cellElement, "hMerge") || booleanAttribute(properties, "hMerge");
      const verticalMerge =
        booleanAttribute(cellElement, "vMerge") || booleanAttribute(properties, "vMerge");
      if (horizontalMerge || verticalMerge) {
        // Covered continuation slots are represented as null. The anchor's span
        // attributes carry semantic occupancy.
        if (occupied[rowIndex]![column] === 0) {
          throw pptxSecurity(
            "Presentation table merge continuation has no spanning anchor",
            "invalid-package",
            partName,
          );
        }
        column += 1;
        continue;
      }
      if (occupied[rowIndex]![column] !== 0) {
        throw pptxSecurity("Presentation table spans overlap", "invalid-package", partName);
      }
      const colSpan =
        optionalPositiveInteger(
          pptxXmlAttribute(cellElement, "gridSpan") ?? pptxXmlAttribute(properties, "gridSpan"),
          partName,
        ) ?? 1;
      const rowSpan =
        optionalPositiveInteger(
          pptxXmlAttribute(cellElement, "rowSpan") ?? pptxXmlAttribute(properties, "rowSpan"),
          partName,
        ) ?? 1;
      if (column + colSpan > columnWidths.length || rowIndex + rowSpan > rowElements.length) {
        throw pptxSecurity(
          "Presentation table cell span exceeds its grid",
          "invalid-package",
          partName,
        );
      }
      const text = parseTextBody(context, pptxXmlChild(cellElement, "txBody"), partName);
      row[column] = {
        text: text.value,
        textStyle: text.style,
        fill: parseFill(context, properties, "white") ?? "white",
        colSpan,
        rowSpan,
      };
      for (let occupiedRow = rowIndex; occupiedRow < rowIndex + rowSpan; occupiedRow += 1) {
        for (let occupiedColumn = column; occupiedColumn < column + colSpan; occupiedColumn += 1) {
          if (occupiedRow === rowIndex && occupiedColumn === column) continue;
          if (occupied[occupiedRow]![occupiedColumn] !== 0) {
            throw pptxSecurity("Presentation table spans overlap", "invalid-package", partName);
          }
          occupied[occupiedRow]![occupiedColumn] = 1;
        }
      }
      // DrawingML retains one physical <a:tc> per grid slot. A spanning anchor
      // is followed by hMerge/vMerge continuation cells, so advance by one
      // physical slot rather than by the semantic span.
      column += 1;
    }
    if (column !== columnWidths.length) {
      throw pptxSecurity(
        "Presentation table row does not cover its grid",
        "invalid-package",
        partName,
      );
    }
    rows.push(row);
  }
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < columnWidths.length; column += 1) {
      if (rows[row]![column] === null && occupied[row]![column] === 0) {
        throw pptxSecurity(
          "Presentation table has an uncovered grid slot",
          "invalid-package",
          partName,
        );
      }
    }
  }
  if (pptxXmlChild(table, "tblPr")) {
    const styleId = pptxXmlText(pptxXmlChild(pptxXmlChild(table, "tblPr"), "tableStyleId"));
    if (styleId) addUnsupported(context, "table-style", partName);
  }
  return {
    name: nonVisualName(frame) ?? `Table ${context.elements}`,
    position: parseFramePosition(frame, partName, transform),
    rows,
    columnWidths,
    rowHeights,
  };
}

function parseChart(
  context: ImportContext,
  partName: string,
): { type: PresentationChartType; config: PresentationChartConfig } | undefined {
  const root = readXml(context, partName);
  requireRoot(root, "chartSpace", CHART_NAMESPACE, partName);
  const chart = requiredChild(root, "chart", partName);
  const plot = requiredChild(chart, "plotArea", partName);
  const chartElement = pptxXmlChildren(plot).find((candidate) =>
    CHART_ELEMENT_TYPES.has(candidate.localName),
  );
  if (!chartElement) {
    addUnsupported(context, "unsupported-chart", partName);
    return undefined;
  }
  const type = CHART_ELEMENT_TYPES.get(chartElement.localName)!;
  if (chartElement.localName.includes("3D")) {
    addUnsupported(context, "unsupported-chart", partName, "style-approximated");
  }
  const series: PresentationChartSeriesConfig[] = [];
  for (const seriesElement of pptxXmlChildren(chartElement).filter(
    (candidate) => candidate.localName === "ser",
  )) {
    const name =
      parseChartString(pptxXmlChild(seriesElement, "tx")) || `Series ${series.length + 1}`;
    const categories = parseChartCategories(pptxXmlChild(seriesElement, "cat"));
    const values = parseChartNumbers(
      pptxXmlChild(seriesElement, type === "scatter" || type === "bubble" ? "yVal" : "val"),
      context,
      partName,
    );
    const xValues = parseChartNumbers(pptxXmlChild(seriesElement, "xVal"), context, partName);
    const bubbleSizes = parseChartNumbers(
      pptxXmlChild(seriesElement, "bubbleSize"),
      context,
      partName,
    );
    const fill = parseFill(context, pptxXmlChild(seriesElement, "spPr"), undefined);
    series.push({
      name,
      categories,
      values,
      ...(xValues.length > 0 ? { xValues } : {}),
      ...(bubbleSizes.length > 0 ? { bubbleSizes } : {}),
      ...(fill ? { fill } : {}),
    });
  }
  const categories =
    series.find((candidate) => (candidate.categories?.length ?? 0) > 0)?.categories ?? [];
  const legend = pptxXmlChild(chart, "legend");
  const labels = pptxXmlChild(chartElement, "dLbls");
  const axes = pptxXmlChildren(plot).filter((candidate) => candidate.localName.endsWith("Ax"));
  const categoryAxis = axes.find(
    (axis) => axis.localName === "catAx" || axis.localName === "dateAx",
  );
  const valueAxis = axes.find((axis) => axis.localName === "valAx");
  return {
    type,
    config: {
      name: `Chart ${context.elements}`,
      title: parseChartString(pptxXmlChild(chart, "title")),
      categories,
      series,
      hasLegend: Boolean(legend) && !booleanAttribute(pptxXmlChild(legend, "delete"), "val"),
      ...(legend
        ? {
            legend: {
              position: chartLegendPosition(
                pptxXmlAttribute(pptxXmlChild(legend, "legendPos"), "val"),
              ),
            },
          }
        : {}),
      ...(parseChartAxis(categoryAxis) ? { xAxis: parseChartAxis(categoryAxis)! } : {}),
      ...(parseChartAxis(valueAxis) ? { yAxis: parseChartAxis(valueAxis)! } : {}),
      dataLabels: {
        showValue: booleanAttribute(pptxXmlChild(labels, "showVal"), "val"),
        showSeriesName: booleanAttribute(pptxXmlChild(labels, "showSerName"), "val"),
        showCategoryName: booleanAttribute(pptxXmlChild(labels, "showCatName"), "val"),
        showPercent: booleanAttribute(pptxXmlChild(labels, "showPercent"), "val"),
      },
    },
  };
}

function parseNotes(context: ImportContext, partName: string): string {
  const root = readXml(context, partName);
  requireRoot(root, "notes", PRESENTATION_NAMESPACE, partName);
  const common = requiredChild(root, "cSld", partName);
  const tree = requiredChild(common, "spTree", partName);
  const paragraphs: string[] = [];
  for (const shape of pptxXmlChildren(tree).filter((child) => child.localName === "sp")) {
    const placeholder = pptxXmlDescendants(shape, "ph")[0];
    const type = pptxXmlAttribute(placeholder, "type");
    if (type !== "body") continue;
    const text = parseTextBody(context, pptxXmlChild(shape, "txBody"), partName).value;
    if (text.length > 0) paragraphs.push(text);
  }
  return paragraphs.join("\n");
}

function parseTextBody(
  context: ImportContext,
  body: PptxXmlElement | undefined,
  partName: string,
): { value: string; style: PresentationTextStyle } {
  if (!body) return { value: "", style: {} };
  const paragraphs: string[] = [];
  const styles: PresentationTextStyle[] = [];
  let paragraphAlignment: PresentationTextStyle["alignment"];
  for (const paragraph of pptxXmlChildren(body).filter((child) => child.localName === "p")) {
    const parts: string[] = [];
    const paragraphProperties = pptxXmlChild(paragraph, "pPr");
    const alignment = mapTextAlignment(pptxXmlAttribute(paragraphProperties, "algn"));
    if (alignment && !paragraphAlignment) paragraphAlignment = alignment;
    for (const child of pptxXmlChildren(paragraph)) {
      if (child.localName === "r" || child.localName === "fld") {
        const text = pptxXmlDirectText(pptxXmlChild(child, "t"));
        consumeText(context, text.length, partName);
        parts.push(text);
        const properties = pptxXmlChild(child, "rPr");
        if (properties) styles.push(parseTextStyle(context, properties, body));
      } else if (child.localName === "br") parts.push("\n");
    }
    paragraphs.push(parts.join(""));
  }
  const value = paragraphs.join("\n");
  const firstStyle = styles[0] ?? {};
  if (styles.some((style) => JSON.stringify(style) !== JSON.stringify(firstStyle))) {
    addUnsupported(context, "theme", partName, "style-approximated");
  }
  const verticalAlignment = mapVerticalAlignment(
    pptxXmlAttribute(pptxXmlChild(body, "bodyPr"), "anchor"),
  );
  return {
    value,
    style: {
      ...firstStyle,
      ...(paragraphAlignment ? { alignment: paragraphAlignment } : {}),
      ...(verticalAlignment ? { verticalAlignment } : {}),
    },
  };
}

function parseTextStyle(
  context: ImportContext,
  properties: PptxXmlElement,
  body: PptxXmlElement,
): PresentationTextStyle {
  const size = optionalNumber(pptxXmlAttribute(properties, "sz"));
  const font = pptxXmlAttribute(pptxXmlChild(properties, "latin"), "typeface");
  const fill = parseFill(context, properties, undefined);
  const underline = pptxXmlAttribute(properties, "u");
  const verticalAlignment = mapVerticalAlignment(
    pptxXmlAttribute(pptxXmlChild(body, "bodyPr"), "anchor"),
  );
  return {
    ...(font && !font.startsWith("+") ? { fontFamily: font } : {}),
    ...(size !== undefined ? { fontSize: size / 75 } : {}),
    bold: booleanAttribute(properties, "b"),
    italic: booleanAttribute(properties, "i"),
    underline: underline !== undefined && underline !== "none",
    ...(fill && fill !== "none" ? { color: typeof fill === "string" ? fill : fill.color } : {}),
    ...(verticalAlignment ? { verticalAlignment } : {}),
  };
}

function parseBackground(context: ImportContext, common: PptxXmlElement): PresentationFill {
  const background = pptxXmlChild(common, "bg");
  if (!background) return "white";
  const properties = pptxXmlChild(background, "bgPr");
  if (properties) return parseFill(context, properties, "white") ?? "white";
  const reference = pptxXmlChild(background, "bgRef");
  const scheme = pptxXmlAttribute(pptxXmlChild(reference, "schemeClr"), "val");
  return scheme ? (context.themeColors.get(scheme) ?? "white") : "white";
}

function parseFill(
  context: ImportContext,
  parent: PptxXmlElement | undefined,
  fallback: PresentationFill | undefined,
): PresentationFill | undefined {
  if (!parent) return fallback;
  if (pptxXmlChild(parent, "noFill")) return "none";
  const solid = pptxXmlChild(parent, "solidFill");
  if (!solid) return fallback;
  const srgb = pptxXmlChild(solid, "srgbClr");
  const scheme = pptxXmlChild(solid, "schemeClr");
  const system = pptxXmlChild(solid, "sysClr");
  const alpha = optionalNumber(
    pptxXmlAttribute(pptxXmlChild(srgb ?? scheme ?? system, "alpha"), "val"),
  );
  if (alpha === 0) return "none";
  const srgbValue = pptxXmlAttribute(srgb, "val");
  if (srgbValue && /^[0-9A-Fa-f]{6}$/.test(srgbValue)) return `#${srgbValue.toLowerCase()}`;
  const schemeValue = pptxXmlAttribute(scheme, "val");
  if (schemeValue) return context.themeColors.get(schemeValue) ?? fallback ?? "#000000";
  const systemValue = pptxXmlAttribute(system, "lastClr");
  if (systemValue && /^[0-9A-Fa-f]{6}$/.test(systemValue)) return `#${systemValue.toLowerCase()}`;
  return fallback;
}

function parseLine(
  context: ImportContext,
  line: PptxXmlElement | undefined,
  partName: string,
): PresentationLine {
  if (!line) return { style: "none", fill: "none", width: 0 };
  const width = optionalNumber(pptxXmlAttribute(line, "w"));
  const dash = pptxXmlAttribute(pptxXmlChild(line, "prstDash"), "val");
  const style =
    dash === "dot" || dash === "sysDot" ? "dot" : dash && dash !== "solid" ? "dash" : "solid";
  if (dash && !["solid", "dot", "sysDot", "dash", "sysDash", "lgDash"].includes(dash)) {
    addUnsupported(context, "theme", partName, "style-approximated");
  }
  const fill = parseFill(context, line, "#000000") ?? "#000000";
  return fill === "none"
    ? { style: "none", fill: "none", width: 0 }
    : { style, fill, width: width === undefined ? 1 : width / EMU_PER_PIXEL };
}

function parseFramePosition(
  frame: PptxXmlElement,
  partName: string,
  transform: Transform,
): PresentationPosition {
  const xfrm = requiredChild(frame, "xfrm", partName);
  return applyTransform(rawPositionFromXfrm(xfrm, partName), transform);
}

function rawPositionFromXfrm(xfrm: PptxXmlElement, partName: string): PresentationPosition {
  const offset = requiredChild(xfrm, "off", partName);
  const extent = requiredChild(xfrm, "ext", partName);
  return {
    left: emuNumber(requiredAttribute(offset, "x", partName), partName),
    top: emuNumber(requiredAttribute(offset, "y", partName), partName),
    width: positiveEmu(requiredAttribute(extent, "cx", partName), partName),
    height: positiveEmu(requiredAttribute(extent, "cy", partName), partName),
  };
}

function applyTransform(
  position: PresentationPosition,
  transform: Transform,
): PresentationPosition {
  return {
    left: transform.offsetX + position.left * transform.scaleX,
    top: transform.offsetY + position.top * transform.scaleY,
    width: position.width * transform.scaleX,
    height: position.height * transform.scaleY,
  };
}

function rotationFromXfrm(xfrm: PptxXmlElement, partName: string): number {
  const raw = pptxXmlAttribute(xfrm, "rot");
  if (raw === undefined) return 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || Math.abs(value) > 21_600_000) {
    throw pptxSecurity("Shape rotation is invalid", "invalid-package", partName);
  }
  return value / 60_000;
}

function mapGeometry(
  context: ImportContext,
  preset: string,
  partName: string,
): PresentationShapeGeometry {
  const mapped = GEOMETRY_MAP.get(preset);
  if (mapped) return mapped;
  addUnsupported(context, "custom-geometry", partName);
  return "rect";
}

function mapImageGeometry(value: string): "rect" | "roundRect" | "ellipse" {
  return value === "ellipse" ? "ellipse" : value === "roundRect" ? "roundRect" : "rect";
}

function parseChartString(element: PptxXmlElement | undefined): string {
  if (!element) return "";
  const points = pptxXmlDescendants(element, "pt")
    .map((point) => ({
      index: optionalInteger(pptxXmlAttribute(point, "idx"), "chart") ?? 0,
      value: pptxXmlText(pptxXmlChild(point, "v")),
    }))
    .sort((left, right) => left.index - right.index);
  if (points.length > 0) return points.map((point) => point.value).join("");
  return pptxXmlDescendants(element, "t").map(pptxXmlText).join("");
}

function parseChartCategories(element: PptxXmlElement | undefined): string[] {
  if (!element) return [];
  return pptxXmlDescendants(element, "pt")
    .map((point) => ({
      index: optionalInteger(pptxXmlAttribute(point, "idx"), "chart") ?? 0,
      value: pptxXmlText(pptxXmlChild(point, "v")),
    }))
    .sort((left, right) => left.index - right.index)
    .map((point) => point.value);
}

function parseChartNumbers(
  element: PptxXmlElement | undefined,
  context: ImportContext,
  partName: string,
): number[] {
  if (!element) return [];
  const points = pptxXmlDescendants(element, "pt")
    .map((point) => {
      const index = optionalInteger(pptxXmlAttribute(point, "idx"), partName) ?? 0;
      const raw = pptxXmlText(pptxXmlChild(point, "v"));
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw pptxSecurity("Chart cache contains a non-finite number", "invalid-package", partName);
      }
      return { index, value };
    })
    .sort((left, right) => left.index - right.index);
  context.chartPoints += points.length;
  if (context.chartPoints > context.limits.chartPoints) {
    throw pptxSecurity("PPTX exceeds its chart point limit", "limit-exceeded", partName);
  }
  return points.map((point) => point.value);
}

function parseChartAxis(axis: PptxXmlElement | undefined): PresentationChartConfig["xAxis"] {
  if (!axis) return undefined;
  const scaling = pptxXmlChild(axis, "scaling");
  const minimum = optionalNumber(pptxXmlAttribute(pptxXmlChild(scaling, "min"), "val"));
  const maximum = optionalNumber(pptxXmlAttribute(pptxXmlChild(scaling, "max"), "val"));
  return {
    visible: !booleanAttribute(pptxXmlChild(axis, "delete"), "val"),
    title: parseChartString(pptxXmlChild(axis, "title")),
    ...(minimum === undefined ? {} : { min: minimum }),
    ...(maximum === undefined ? {} : { max: maximum }),
  };
}

function chartLegendPosition(
  value: string | undefined,
): "left" | "top" | "topRight" | "right" | "bottom" {
  switch (value) {
    case "l":
      return "left";
    case "t":
      return "top";
    case "tr":
      return "topRight";
    case "r":
      return "right";
    default:
      return "bottom";
  }
}

function parseThemeColors(root: PptxXmlElement, partName: string): ReadonlyMap<string, string> {
  requireRoot(root, "theme", DRAWING_NAMESPACE, partName);
  const colors = new Map(DEFAULT_THEME_COLORS);
  const scheme = pptxXmlDescendants(root, "clrScheme")[0];
  for (const entry of pptxXmlChildren(scheme)) {
    const color = pptxXmlChildren(entry)[0];
    const value = pptxXmlAttribute(color, color?.localName === "sysClr" ? "lastClr" : "val");
    if (value && /^[0-9A-Fa-f]{6}$/.test(value))
      colors.set(entry.localName, `#${value.toLowerCase()}`);
  }
  return colors;
}

function parseSlideSize(root: PptxXmlElement): { width: number; height: number } {
  const size = requiredChild(root, "sldSz", "ppt/presentation.xml");
  return {
    width: positiveEmu(
      requiredAttribute(size, "cx", "ppt/presentation.xml"),
      "ppt/presentation.xml",
    ),
    height: positiveEmu(
      requiredAttribute(size, "cy", "ppt/presentation.xml"),
      "ppt/presentation.xml",
    ),
  };
}

function mapTextAlignment(value: string | undefined): PresentationTextStyle["alignment"] {
  if (value === "ctr") return "center";
  if (value === "r") return "right";
  if (value === "just" || value === "justLow" || value === "dist") return "justify";
  return value === "l" ? "left" : undefined;
}

function mapVerticalAlignment(
  value: string | undefined,
): PresentationTextStyle["verticalAlignment"] {
  if (value === "ctr") return "middle";
  if (value === "b") return "bottom";
  return value === "t" ? "top" : undefined;
}

function rasterContentType(
  partName: string,
): "image/png" | "image/jpeg" | "image/gif" | "image/webp" {
  const extension = partName.slice(partName.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  return "image/webp";
}

function cropPercent(value: string | undefined, partName: string): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100_000) {
    throw pptxSecurity("Picture crop percentage is invalid", "invalid-package", partName);
  }
  return parsed / 1_000;
}

function nonVisualName(element: PptxXmlElement): string | undefined {
  return pptxXmlAttribute(pptxXmlDescendants(element, "cNvPr")[0], "name");
}

function nonVisualDescription(element: PptxXmlElement): string | undefined {
  return pptxXmlAttribute(pptxXmlDescendants(element, "cNvPr")[0], "descr");
}

function requiredRelationshipId(
  element: PptxXmlElement | undefined,
  partName: string,
  localName: "id" | "embed" = "id",
): string {
  if (!element)
    throw pptxSecurity("Relationship reference is missing", "invalid-package", partName);
  const direct = pptxXmlQualifiedAttribute(element, `r:${localName}`);
  if (direct) return direct;
  const candidates = [...element.attributes].filter(
    ([name]) =>
      name.includes(":") &&
      name.slice(name.indexOf(":") + 1) === localName &&
      element.attributeNamespaces?.get(name) === OFFICE_RELATIONSHIP_BASE.slice(0, -1),
  );
  if (candidates.length !== 1 || !candidates[0]?.[1]) {
    throw pptxSecurity(
      "Relationship reference is missing or ambiguous",
      "invalid-package",
      partName,
    );
  }
  return candidates[0][1];
}

function requiredChild(
  parent: PptxXmlElement | undefined,
  localName: string,
  partName: string,
): PptxXmlElement {
  const candidates = pptxXmlChildren(parent).filter((child) => child.localName === localName);
  if (candidates.length !== 1 || !candidates[0]) {
    throw pptxSecurity(
      `Required ${localName} element is missing or duplicated`,
      "invalid-package",
      partName,
    );
  }
  return candidates[0];
}

function requireRoot(
  element: PptxXmlElement,
  localName: string,
  namespaceUri: string,
  partName: string,
): void {
  if (element.localName !== localName || element.namespaceUri !== namespaceUri) {
    throw pptxSecurity(
      `OOXML root must be ${localName} in ${namespaceUri}`,
      "invalid-package",
      partName,
    );
  }
}

function requiredAttribute(
  element: PptxXmlElement | undefined,
  localName: string,
  partName: string,
): string {
  const value = pptxXmlAttribute(element, localName);
  if (value === undefined || value.length === 0) {
    throw pptxSecurity(`Required ${localName} attribute is missing`, "invalid-package", partName);
  }
  return value;
}

function byRelationshipId(
  relationships: readonly Relationship[],
): ReadonlyMap<string, Relationship> {
  return new Map(relationships.map((relationship) => [relationship.id, relationship]));
}

function relationshipPartName(sourcePart: string): string {
  if (sourcePart === "") return "_rels/.rels";
  const slash = sourcePart.lastIndexOf("/");
  const directory = slash < 0 ? "" : sourcePart.slice(0, slash + 1);
  const file = slash < 0 ? sourcePart : sourcePart.slice(slash + 1);
  return `${directory}_rels/${file}.rels`;
}

function relationshipSourcePart(relationshipPart: string): string {
  if (relationshipPart === "_rels/.rels") return "";
  const match = /^(.*\/)?_rels\/([^/]+)\.rels$/.exec(relationshipPart);
  if (!match) {
    throw pptxSecurity("Invalid relationships part path", "invalid-package", relationshipPart);
  }
  return `${match[1] ?? ""}${match[2] ?? ""}`;
}

function resolvePartTarget(sourcePart: string, target: string, relationshipPart: string): string {
  if (
    /[\u0000-\u001f\u007f]/.test(target) ||
    target.includes("\\") ||
    target.startsWith("//") ||
    /%(?:2e|2f|5c)/i.test(target)
  ) {
    throw pptxSecurity("Unsafe OPC relationship target", "invalid-package", relationshipPart);
  }
  const packageAbsolute = target.startsWith("/");
  const relative = packageAbsolute ? target.slice(1) : target;
  const base =
    !packageAbsolute && sourcePart.includes("/")
      ? sourcePart.slice(0, sourcePart.lastIndexOf("/") + 1)
      : "";
  const combined = `${base}${relative}`;
  if (combined.length === 0 || combined.length > 4_096 || combined.includes("//")) {
    throw pptxSecurity("Invalid OPC relationship target", "invalid-package", relationshipPart);
  }
  const output: string[] = [];
  for (const segment of combined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (output.length === 0) {
        throw pptxSecurity(
          "OPC relationship escapes the package root",
          "invalid-package",
          relationshipPart,
        );
      }
      output.pop();
    } else output.push(segment);
    if (output.length > 256) {
      throw pptxSecurity("OPC relationship path is too deep", "limit-exceeded", relationshipPart);
    }
  }
  return output.join("/");
}

function emuNumber(value: string, partName: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || Math.abs(parsed) > 9_525_000_000) {
    throw pptxSecurity(
      "Presentation geometry is outside supported bounds",
      "invalid-package",
      partName,
    );
  }
  return parsed / EMU_PER_PIXEL;
}

function positiveEmu(value: string, partName: string): number {
  const parsed = emuNumber(value, partName);
  if (parsed <= 0) {
    throw pptxSecurity("Presentation extent must be positive", "invalid-package", partName);
  }
  return parsed;
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalInteger(value: string | undefined, partName: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw pptxSecurity("OOXML integer is invalid", "invalid-package", partName);
  }
  return parsed;
}

function optionalPositiveInteger(value: string | undefined, partName: string): number | undefined {
  const parsed = optionalInteger(value, partName);
  if (parsed === undefined) return undefined;
  if (parsed <= 0 || parsed > 1_024) {
    throw pptxSecurity("OOXML span is outside supported bounds", "invalid-package", partName);
  }
  return parsed;
}

function booleanAttribute(element: PptxXmlElement | undefined, name: string): boolean {
  const value = pptxXmlAttribute(element, name);
  return value === "1" || value === "true" || value === "on";
}

function consumeElement(context: ImportContext, partName: string): void {
  context.elements += 1;
  if (context.elements > context.limits.elements) {
    throw pptxSecurity("PPTX exceeds its element limit", "limit-exceeded", partName);
  }
}

function consumeText(context: ImportContext, characters: number, partName: string): void {
  context.textCharacters += characters;
  if (context.textCharacters > context.limits.textCharacters) {
    throw pptxSecurity("PPTX exceeds its text character limit", "limit-exceeded", partName);
  }
}

function addUnsupported(
  context: ImportContext,
  feature: PresentationFidelityIssue["feature"],
  partName: string,
  code: PresentationFidelityIssue["code"] = "content-preserved-in-source",
): void {
  context.unsupportedParts.add(partName);
  context.issues.push({
    code,
    severity: code === "content-will-be-discarded" ? "error" : "warning",
    feature,
    message:
      code === "style-approximated"
        ? `${feature} styling is represented by the closest editable model style`
        : `${feature} content is retained in the validated source package but is not editable`,
    parts: [partName],
  });
}

function fidelityIssue(
  feature: PresentationFidelityIssue["feature"],
  parts: readonly string[],
): PresentationFidelityIssue {
  return {
    code: "content-preserved-in-source",
    severity: "warning",
    feature,
    message: `${feature} content is retained in the validated source package but is not editable`,
    parts,
  };
}

function deduplicateIssues(
  issues: readonly PresentationFidelityIssue[],
): PresentationFidelityIssue[] {
  const result = new Map<string, PresentationFidelityIssue>();
  for (const issue of issues) {
    const key = `${issue.code}\0${issue.feature}\0${(issue.parts ?? []).join("\0")}`;
    result.set(key, issue);
  }
  return [...result.values()];
}

function pptxSecurity(
  message: string,
  code: PresentationSecurityError["code"],
  entryName?: string,
): PresentationSecurityError {
  return new PresentationSecurityError(
    entryName ? `${message}: ${entryName}` : message,
    code,
    entryName,
  );
}

function pptxZipFailure(
  kind: Parameters<BoundedZipFailure>[0],
  message: string,
  entryName?: string,
): never {
  throw pptxSecurity(
    message,
    kind === "limit"
      ? "limit-exceeded"
      : kind === "encrypted"
        ? "encrypted-content"
        : "invalid-package",
    entryName,
  );
}

const IDENTITY_TRANSFORM: Transform = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };

const GEOMETRY_MAP = new Map<string, PresentationShapeGeometry>([
  ["rect", "rect"],
  ["roundRect", "roundRect"],
  ["ellipse", "ellipse"],
  ["triangle", "triangle"],
  ["rtTriangle", "triangle"],
  ["rightArrow", "rightArrow"],
  ["line", "line"],
]);

const CHART_ELEMENT_TYPES = new Map<string, PresentationChartType>([
  ["barChart", "bar"],
  ["bar3DChart", "bar"],
  ["lineChart", "line"],
  ["line3DChart", "line"],
  ["areaChart", "area"],
  ["area3DChart", "area"],
  ["pieChart", "pie"],
  ["pie3DChart", "pie"],
  ["doughnutChart", "doughnut"],
  ["scatterChart", "scatter"],
  ["bubbleChart", "bubble"],
  ["radarChart", "radar"],
]);

const DEFAULT_THEME_COLORS = new Map<string, string>([
  ["dk1", "#000000"],
  ["lt1", "#ffffff"],
  ["dk2", "#1f497d"],
  ["lt2", "#eeeceed"],
  ["accent1", "#4472c4"],
  ["accent2", "#ed7d31"],
  ["accent3", "#a5a5a5"],
  ["accent4", "#ffc000"],
  ["accent5", "#5b9bd5"],
  ["accent6", "#70ad47"],
  ["hlink", "#0563c1"],
  ["folHlink", "#954f72"],
  ["tx1", "#000000"],
  ["bg1", "#ffffff"],
  ["tx2", "#1f497d"],
  ["bg2", "#eeeceed"],
]);

const KNOWN_RELATIONSHIP_SUFFIXES = new Set([
  "officeDocument",
  "core-properties",
  "extended-properties",
  "custom-properties",
  "slideMaster",
  "slideLayout",
  "slide",
  "notesMaster",
  "notesSlide",
  "theme",
  "presProps",
  "viewProps",
  "tableStyles",
  "chart",
  "image",
  "package",
  "hyperlink",
  "handoutMaster",
  "font",
  "tags",
  "customXml",
  "comments",
  "commentAuthors",
  "diagramData",
  "diagramLayout",
  "diagramColors",
  "diagramQuickStyle",
]);

const ACTIVE_RELATIONSHIP_SUFFIX =
  /^(?:vbaProject|activeX|oleObject|audio|video|media|externalLink|attachedTemplate|control|webVideo|linkedData|externalData)$/i;

const SOURCE_ONLY_RELATIONSHIP_SUFFIXES = new Set([
  "handoutMaster",
  "font",
  "tags",
  "customXml",
  "comments",
  "commentAuthors",
  "diagramData",
  "diagramLayout",
  "diagramColors",
  "diagramQuickStyle",
]);

const ALLOWED_EXACT_RELATIONSHIPS = new Set([
  "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties",
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties",
]);

const KNOWN_DEFAULT_CONTENT_TYPES = new Set([
  "rels\0application/vnd.openxmlformats-package.relationships+xml",
  "xml\0application/xml",
  "png\0image/png",
  "jpg\0image/jpeg",
  "jpeg\0image/jpeg",
  "jpg\0image/jpg",
  "gif\0image/gif",
  "webp\0image/webp",
  "svg\0image/svg+xml",
  "m4v\0video/mp4",
  "mp4\0video/mp4",
  "vml\0application/vnd.openxmlformats-officedocument.vmlDrawing",
  "xlsx\0application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const KNOWN_PPTX_PART_PATTERNS: readonly RegExp[] = [
  /^\[Content_Types\]\.xml$/,
  /^_rels\/\.rels$/,
  /^docProps\/(?:app|core|custom)\.xml$/,
  /^ppt\/presentation\.xml$/,
  /^ppt\/(?:presProps|viewProps|tableStyles)\.xml$/,
  /^ppt\/(?:_rels\/presentation\.xml|slides\/_rels\/slide\d+\.xml|slideMasters\/_rels\/slideMaster\d+\.xml|slideLayouts\/_rels\/slideLayout\d+\.xml|notesSlides\/_rels\/notesSlide\d+\.xml|notesMasters\/_rels\/notesMaster\d+\.xml|charts\/_rels\/chart\d+\.xml)\.rels$/,
  /^ppt\/(?:slides\/slide\d+|slideMasters\/slideMaster\d+|slideLayouts\/slideLayout\d+|notesSlides\/notesSlide\d+|notesMasters\/notesMaster\d+|charts\/chart\d+|theme\/theme\d+)\.xml$/,
  /^ppt\/media\/[^/]+\.(?:png|jpe?g|gif|webp)$/i,
  /^ppt\/embeddings\/[^/]+\.xlsx$/i,
];
