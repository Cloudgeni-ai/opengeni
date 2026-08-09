/**
 * Narrow adapter around the pinned `docx` compiler.
 *
 * `docx`'s public Packer hard-codes DEFLATE, which can make valid repetitive
 * text exceed our secure importer's 100:1 ceiling. Its pinned compiler already
 * produces a JSZip-compatible archive, so generate those exact OOXML parts as
 * STORE. If that controlled runtime contract changes, fail closed instead of
 * silently shipping a second ZIP implementation or masking the incompatibility.
 */

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type GeneratedDocxZip = {
  forEach(callback: (relativePath: string, entry: { date: Date }) => void): void;
  generateAsync(options: {
    type: "uint8array";
    mimeType: string;
    compression: "STORE";
  }): Promise<Uint8Array>;
};

type DocxCompilerAdapter = {
  compile(
    file: unknown,
    prettify?: undefined,
    overrides?: readonly DocxXmlOverride[],
  ): GeneratedDocxZip;
};

export type DocxXmlOverride = { path: string; data: string };

export class DocxExportCompatibilityError extends Error {
  readonly name = "DocxExportCompatibilityError";
  readonly code = "incompatible_docx_runtime" as const;
}

export async function packDocxWithBoundedCompression(
  file: unknown,
  packer: unknown,
  overrides: readonly DocxXmlOverride[] = [],
): Promise<Uint8Array> {
  if ((typeof packer !== "object" && typeof packer !== "function") || packer === null) {
    throw incompatibleRuntime();
  }
  const compiler = Reflect.get(packer, "compiler") as Partial<DocxCompilerAdapter> | undefined;
  if (!compiler || typeof compiler.compile !== "function") throw incompatibleRuntime();
  const archive = compiler.compile(file, undefined, overrides);
  if (
    !archive ||
    typeof archive.generateAsync !== "function" ||
    typeof archive.forEach !== "function"
  )
    throw incompatibleRuntime();
  archive.forEach((_path, entry) => {
    // ZIP stores local wall-clock fields. Local 1980-01-01 is the portable DOS
    // epoch and therefore encodes identically regardless of host timezone.
    entry.date = new Date(1980, 0, 1, 0, 0, 0, 0);
  });
  const bytes = await archive.generateAsync({
    type: "uint8array",
    mimeType: DOCX_MIME_TYPE,
    compression: "STORE",
  });
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw incompatibleRuntime();
  return bytes;
}

function incompatibleRuntime(): DocxExportCompatibilityError {
  return new DocxExportCompatibilityError(
    "The pinned DOCX runtime no longer exposes the verified bounded-compression compiler adapter",
  );
}
