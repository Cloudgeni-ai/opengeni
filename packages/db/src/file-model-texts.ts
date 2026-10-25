/**
 * The text a model is shown for a document attachment (0975). The first
 * stored result for a file is final, so a message renders the same text on
 * every request. Rows grant no access: read them only for files the
 * file-authority lookup already returned.
 */
import { and, eq, inArray } from "drizzle-orm";
import { withAccountRls, type Database } from "./database";
import type { FileModelTextStatus } from "./file-model-texts-schema";
import * as schema from "./schema";

export { FILE_MODEL_TEXT_STATUSES, type FileModelTextStatus } from "./file-model-texts-schema";

export type FileModelText = {
  fileId: string;
  extractor: string;
  status: FileModelTextStatus;
  format: "markdown" | "text";
  /** The start of the extracted text, empty unless status is "extracted". */
  text: string;
  /** Length of the whole extracted text; `text` holds at most its start. */
  totalChars: number;
};

/** Longest text stored for one file, above any message's inline budget. */
export const FILE_MODEL_TEXT_MAX_STORED_CHARS = 200_000;

function rowToText(row: typeof schema.fileModelTexts.$inferSelect): FileModelText {
  return {
    fileId: row.fileId,
    extractor: row.extractor,
    status: row.status,
    format: row.format,
    text: row.text,
    totalChars: row.totalChars,
  };
}

export async function getFileModelTexts(
  db: Database,
  input: { accountId: string; fileIds: readonly string[] },
): Promise<FileModelText[]> {
  const ids = [...new Set(input.fileIds)];
  if (ids.length === 0) return [];
  const rows = await withAccountRls(db, input.accountId, async (scoped) =>
    scoped
      .select()
      .from(schema.fileModelTexts)
      .where(
        and(
          eq(schema.fileModelTexts.accountId, input.accountId),
          inArray(schema.fileModelTexts.fileId, ids),
        ),
      ),
  );
  return rows.map(rowToText);
}

/**
 * Store a file's extraction unless one is already stored, and return the
 * stored one. Concurrent writers converge on the first row.
 */
export async function recordFileModelText(
  db: Database,
  input: { accountId: string } & FileModelText,
): Promise<FileModelText> {
  if (input.text.length > FILE_MODEL_TEXT_MAX_STORED_CHARS) {
    throw new Error("file model text exceeds the stored length limit");
  }
  return await withAccountRls(db, input.accountId, async (scoped) => {
    await scoped
      .insert(schema.fileModelTexts)
      .values({
        accountId: input.accountId,
        fileId: input.fileId,
        extractor: input.extractor,
        status: input.status,
        format: input.format,
        text: input.text,
        totalChars: input.totalChars,
      })
      .onConflictDoNothing();
    const [row] = await scoped
      .select()
      .from(schema.fileModelTexts)
      .where(
        and(
          eq(schema.fileModelTexts.accountId, input.accountId),
          eq(schema.fileModelTexts.fileId, input.fileId),
        ),
      )
      .limit(1);
    if (!row) throw new Error("file model text was not stored");
    return rowToText(row);
  });
}
