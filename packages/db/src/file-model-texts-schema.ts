import { integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Migration 0975: the text a model is shown for a document attachment.
// Foreign keys to accounts and files live in the migration.

export const FILE_MODEL_TEXT_STATUSES = [
  "extracted",
  "unsupported",
  "encrypted",
  "malformed",
  "too_large",
  "failed",
  "timeout",
] as const;
export type FileModelTextStatus = (typeof FILE_MODEL_TEXT_STATUSES)[number];

export const fileModelTexts = pgTable(
  "file_model_texts",
  {
    accountId: uuid("account_id").notNull(),
    fileId: uuid("file_id").notNull(),
    extractor: text("extractor").notNull(),
    status: text("status").$type<FileModelTextStatus>().notNull(),
    format: text("format").$type<"markdown" | "text">().notNull(),
    text: text("text").notNull().default(""),
    totalChars: integer("total_chars").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.fileId] })],
);
