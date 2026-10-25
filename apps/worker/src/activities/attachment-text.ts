import { createHash } from "node:crypto";
import { extname } from "node:path";
import { MAX_INLINE_MODEL_ATTACHMENT_BYTES, type FileAsset } from "@opengeni/contracts";
import {
  FILE_MODEL_TEXT_MAX_STORED_CHARS,
  getFileModelTexts,
  recordFileModelText,
  type Database,
  type FileModelText,
} from "@opengeni/db";
import { RetainedAttachmentUnavailableError, textHead } from "./run-input";

/**
 * Text extraction for document attachments, so a model can answer about a
 * normal-sized document in one step instead of first reading a Skill and
 * running a parser in the sandbox. Extraction runs in-process the first time a
 * message carrying the file is rendered for a model (a few milliseconds for
 * ordinary documents) and its result, success or failure, is stored once, so
 * every later request renders the same bytes. Every eligible file gets a
 * stored result on its first render, even when nothing could be extracted.
 */

/** Must match the pinned `@firecrawl/anydoc` dependency of this package. */
export const ANYDOC_EXTRACTOR = "anydoc@0.1.8";
export const UTF8_EXTRACTOR = "utf8";

/** Longest an extraction may take while a turn waits for it. */
export const ATTACHMENT_TEXT_EXTRACTION_TIMEOUT_MS = 10_000;

// Formats AnyDoc converts to Markdown (its supported inputs).
const DOCUMENT_EXTENSIONS = new Set([
  ".doc",
  ".docx",
  ".docm",
  ".odt",
  ".rtf",
  ".epub",
  ".pdf",
  ".ppt",
  ".pps",
  ".pot",
  ".pptx",
  ".pptm",
  ".ppsx",
  ".ppsm",
  ".odp",
  ".xls",
  ".xlsx",
  ".xlsm",
  ".xlsb",
  ".ods",
]);
const DOCUMENT_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/rtf",
  "application/epub+zip",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.text",
  "text/rtf",
]);
const DOCUMENT_CONTENT_TYPE_PREFIXES = [
  "application/vnd.openxmlformats-officedocument.",
  "application/vnd.ms-excel.",
  "application/vnd.ms-powerpoint.",
  "application/vnd.ms-word.",
];

// Shown as they are: raw CSV is exact and uses fewer tokens than a Markdown table.
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".text",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".ndjson",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".xml",
  ".html",
  ".htm",
  ".log",
  ".sql",
]);
const TEXT_CONTENT_TYPES = new Set([
  "application/json",
  "application/x-ndjson",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/sql",
]);

export type AttachmentTextKind = "document" | "text";

/** Whether a file's contents can be shown to a model as text, and how. */
export function attachmentTextKind(
  file: Pick<FileAsset, "contentType" | "filename">,
): AttachmentTextKind | null {
  const contentType = file.contentType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (/^(image|audio|video)\//.test(contentType)) return null;
  const extension = extname(file.filename).toLowerCase();
  if (
    DOCUMENT_CONTENT_TYPES.has(contentType) ||
    DOCUMENT_CONTENT_TYPE_PREFIXES.some((prefix) => contentType.startsWith(prefix)) ||
    DOCUMENT_EXTENSIONS.has(extension)
  ) {
    return "document";
  }
  if (
    contentType.startsWith("text/") ||
    TEXT_CONTENT_TYPES.has(contentType) ||
    TEXT_EXTENSIONS.has(extension)
  ) {
    return "text";
  }
  return null;
}

/** Files whose text a message may show: ready, pinned by a digest, inline-sized. */
export function attachmentTextEligible(file: FileAsset): boolean {
  return (
    file.status === "ready" &&
    file.sizeBytes <= MAX_INLINE_MODEL_ATTACHMENT_BYTES &&
    /^[a-f0-9]{64}$/i.test(file.sha256?.trim() ?? "") &&
    attachmentTextKind(file) !== null
  );
}

export type ExtractedAttachmentText = Omit<FileModelText, "fileId">;

type AnyDocModule = {
  formatFromBytes(bytes: Uint8Array): string | null;
  formatFromPath(path: string): string | null;
  toMarkdownBytes(bytes: Uint8Array, format?: string | null): Promise<string>;
};

let anyDocModule: Promise<AnyDocModule> | undefined;

async function loadAnyDoc(): Promise<AnyDocModule> {
  anyDocModule ??= import("@firecrawl/anydoc").then(
    (module) => module as unknown as AnyDocModule,
    (error: unknown) => {
      anyDocModule = undefined;
      throw error;
    },
  );
  return await anyDocModule;
}

function extracted(
  extractor: string,
  format: FileModelText["format"],
  raw: string,
): ExtractedAttachmentText {
  // Postgres text cannot hold NUL, and it never carries meaning in a document.
  const text = raw.replaceAll("\u0000", "");
  if (text.trim().length === 0) {
    return { extractor, status: "unsupported", format, text: "", totalChars: 0 };
  }
  return {
    extractor,
    status: "extracted",
    format,
    text: textHead(text, FILE_MODEL_TEXT_MAX_STORED_CHARS),
    totalChars: text.length,
  };
}

function failure(
  extractor: string,
  format: FileModelText["format"],
  status: Exclude<FileModelText["status"], "extracted">,
): ExtractedAttachmentText {
  return { extractor, status, format, text: "", totalChars: 0 };
}

function anyDocFailureStatus(error: unknown): Exclude<FileModelText["status"], "extracted"> {
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case "unsupported":
      return "unsupported";
    case "encrypted":
      return "encrypted";
    case "malformed":
    case "missingPart":
      return "malformed";
    case "resourceLimit":
      return "too_large";
    default:
      return "failed";
  }
}

/** One extraction, for logs and metrics. */
export type AttachmentTextExtractionEvent = {
  kind: AttachmentTextKind;
  status: FileModelText["status"];
  durationMs: number;
  /**
   * "result" is the outcome the turn stored. "after_timeout" reports how a
   * conversion that timed out eventually ended, which shows whether the
   * timeout is too short; it never changes what was stored.
   */
  phase: "result" | "after_timeout";
};

/**
 * Extract the text a model is shown for one file's verified bytes. Every call
 * returns a result to store, including when the extractor itself cannot run
 * on this worker: whatever a message shows the first time it is rendered is
 * what it shows forever, so a later worker that can extract must not add text
 * to a message a model has already seen without it.
 */
export async function extractAttachmentText(
  file: Pick<FileAsset, "id" | "contentType" | "filename" | "sizeBytes">,
  bytes: Uint8Array,
  options: {
    timeoutMs?: number;
    loadExtractor?: () => Promise<AnyDocModule>;
    observe?: ((event: AttachmentTextExtractionEvent) => void) | undefined;
  } = {},
): Promise<ExtractedAttachmentText> {
  const startedAt = performance.now();
  const kind = attachmentTextKind(file);
  const finish = (result: ExtractedAttachmentText): ExtractedAttachmentText => {
    if (kind !== null) {
      options.observe?.({
        kind,
        status: result.status,
        durationMs: performance.now() - startedAt,
        phase: "result",
      });
    }
    return result;
  };
  if (kind === null) return failure(UTF8_EXTRACTOR, "text", "unsupported");
  if (kind === "text") {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\u0000")) return finish(failure(UTF8_EXTRACTOR, "text", "unsupported"));
      return finish(extracted(UTF8_EXTRACTOR, "text", text));
    } catch {
      return finish(failure(UTF8_EXTRACTOR, "text", "unsupported"));
    }
  }
  let anyDoc: AnyDocModule;
  try {
    anyDoc = await (options.loadExtractor ?? loadAnyDoc)();
  } catch (error) {
    console.error("document text extractor is unavailable on this worker", {
      fileId: file.id,
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return finish(failure(ANYDOC_EXTRACTOR, "markdown", "unavailable"));
  }
  const format = anyDoc.formatFromBytes(bytes) ?? anyDoc.formatFromPath(file.filename);
  if (!format) return finish(failure(ANYDOC_EXTRACTOR, "markdown", "unsupported"));
  const timeoutMs = options.timeoutMs ?? ATTACHMENT_TEXT_EXTRACTION_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  // The conversion runs on the native thread pool and cannot be cancelled;
  // AnyDoc's own decompression, nesting and node limits bound it.
  const conversion = anyDoc.toMarkdownBytes(bytes, format);
  try {
    const result = await Promise.race([conversion, timeout]);
    if (result === "timeout") {
      console.warn("document text extraction timed out", {
        fileId: file.id,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        timeoutMs,
      });
      // A timeout is final for the file, so its text stays the same on every
      // request. Report how long the conversion really took.
      conversion.then(
        () => reportAfterTimeout("extracted"),
        (error: unknown) => reportAfterTimeout(anyDocFailureStatus(error)),
      );
      return finish(failure(ANYDOC_EXTRACTOR, "markdown", "timeout"));
    }
    return finish(extracted(ANYDOC_EXTRACTOR, "markdown", result));
  } catch (error) {
    return finish(failure(ANYDOC_EXTRACTOR, "markdown", anyDocFailureStatus(error)));
  } finally {
    clearTimeout(timer);
  }

  function reportAfterTimeout(status: FileModelText["status"]): void {
    const durationMs = performance.now() - startedAt;
    console.warn("document text extraction finished after its timeout", {
      fileId: file.id,
      status,
      durationMs: Math.round(durationMs),
      timeoutMs,
    });
    options.observe?.({ kind: "document", status, durationMs, phase: "after_timeout" });
  }
}

export type AttachmentTextLoader = (
  files: readonly FileAsset[],
) => Promise<ReadonlyMap<string, FileModelText>>;

/**
 * Load the stored text of already-authorized files, extracting and storing it
 * for eligible files that have none yet. Stored rows win over a concurrent
 * extraction, so every caller renders the same text. Bytes that cannot be read
 * right now fail the projection for a retry, like retained images; bytes that
 * do not match the file's digest are never extracted.
 */
export function createAttachmentTextLoader(deps: {
  db: Database;
  accountId: string;
  readFileBytes?: ((file: FileAsset) => Promise<Uint8Array>) | undefined;
  extract?: typeof extractAttachmentText;
  observe?: (event: AttachmentTextExtractionEvent) => void;
}): AttachmentTextLoader {
  const extract = deps.extract ?? extractAttachmentText;
  const store = async (file: FileAsset, result: ExtractedAttachmentText) =>
    await recordFileModelText(deps.db, { accountId: deps.accountId, fileId: file.id, ...result });
  return async (files) => {
    const eligible = files.filter(attachmentTextEligible);
    const texts = new Map<string, FileModelText>();
    if (eligible.length === 0) return texts;
    for (const row of await getFileModelTexts(deps.db, {
      accountId: deps.accountId,
      fileIds: eligible.map((file) => file.id),
    })) {
      texts.set(row.fileId, row);
    }
    const readFileBytes = deps.readFileBytes;
    const missing = eligible.filter((file) => !texts.has(file.id));
    if (missing.length === 0) return texts;
    if (!readFileBytes) {
      // Without file storage there is nothing to extract, now or later.
      for (const file of missing) {
        const unavailable =
          attachmentTextKind(file) === "text"
            ? failure(UTF8_EXTRACTOR, "text", "unavailable")
            : failure(ANYDOC_EXTRACTOR, "markdown", "unavailable");
        texts.set(file.id, await store(file, unavailable));
      }
      return texts;
    }
    const unavailable: string[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < missing.length) {
        const file = missing[cursor++]!;
        let bytes: Uint8Array;
        try {
          bytes = await readFileBytes(file);
        } catch (error) {
          console.error("attachment text source bytes are unavailable", {
            fileId: file.id,
            errorType: error instanceof Error ? error.name : typeof error,
          });
          unavailable.push(file.id);
          continue;
        }
        if (
          bytes.byteLength !== file.sizeBytes ||
          createHash("sha256").update(bytes).digest("hex") !== file.sha256?.trim().toLowerCase()
        ) {
          throw new Error(`Retained attachment bytes unavailable or invalid: ${file.id}`);
        }
        texts.set(
          file.id,
          await store(file, await extract(file, bytes, { observe: deps.observe })),
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, missing.length) }, worker));
    if (unavailable.length > 0) throw new RetainedAttachmentUnavailableError(unavailable);
    return texts;
  };
}
