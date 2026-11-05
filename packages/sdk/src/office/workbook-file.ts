// The open workbook as an .xlsx file, and files brought into agent code.
import { office, type OfficeAsyncResult } from "./host";

/** Office hands the file over in slices of at most 4 MB. */
const SLICE_BYTES = 4 * 1024 * 1024;

export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** A chat file handed to agent code (`files[i]` in `excel_run`). */
export type OfficeRunFile = {
  artifactId: string;
  name: string;
  contentType: string;
  /** The file's bytes, base64, as Excel.createWorkbook and insertWorksheetsFromBase64 take them. */
  base64: string;
};

function settle<T>(start: (callback: (result: OfficeAsyncResult<T>) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) =>
    start((result) =>
      result.status === "succeeded"
        ? resolve(result.value)
        : reject(new Error(result.error?.message ?? "Office could not read the workbook file.")),
    ),
  );
}

/**
 * The whole workbook as an .xlsx file, as it is now, including changes not
 * saved yet. Works whether or not the workbook was ever saved.
 */
export async function readWorkbookFile(): Promise<Uint8Array> {
  const document = office().context.document;
  const getFileAsync = document?.getFileAsync;
  if (!document || !getFileAsync) {
    throw new Error("This version of Excel can't hand over the workbook as a file.");
  }
  const file = await settle<OfficeFile>((callback) =>
    getFileAsync.call(document, "compressed", { sliceSize: SLICE_BYTES }, callback),
  );
  try {
    const slices: ArrayLike<number>[] = [];
    for (let index = 0; index < file.sliceCount; index += 1) {
      const slice = await settle<{ data: ArrayLike<number> }>((callback) =>
        file.getSliceAsync(index, callback),
      );
      slices.push(slice.data);
    }
    return joinSlices(slices);
  } finally {
    // Office allows only a couple of open file handles per document.
    await settle<void>((callback) => file.closeAsync(callback)).catch(() => undefined);
  }
}

type OfficeFile = {
  size: number;
  sliceCount: number;
  getSliceAsync(
    index: number,
    callback: (result: OfficeAsyncResult<{ data: ArrayLike<number> }>) => void,
  ): void;
  closeAsync(callback: (result: OfficeAsyncResult<void>) => void): void;
};

/** Office's slices (plain arrays of byte values on Mac and Windows) as one buffer. */
export function joinSlices(slices: readonly ArrayLike<number>[]): Uint8Array {
  let total = 0;
  for (const slice of slices) total += slice.length;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const slice of slices) {
    bytes.set(slice, offset);
    offset += slice.length;
  }
  return bytes;
}

/** The name a copy of `workbookName` is saved under: always ending in .xlsx. */
export function workbookCopyFilename(requested: string): string {
  const cleaned = requested
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 180);
  const stem = (cleaned || "Workbook").replace(/\.(xlsx|xlsm|xlsb|xls|csv)$/iu, "").trim();
  return `${stem || "Workbook"}.xlsx`;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
