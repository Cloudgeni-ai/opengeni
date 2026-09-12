import { FileAsset, KnowledgeEntryWriteReceipt } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { knowledgeOriginalFileAsset } from "./knowledge-entries";
import { rawRows, withWorkspaceRls, type Database } from "./database";
import { toPostgresLosslessJson, toPostgresLosslessText } from "./lossless-json";

const Identity = z.object({
  accountId: z.uuid(),
  workspaceId: z.uuid(),
  documentId: z.uuid(),
  fileId: z.uuid(),
});
const Claim = z.object({
  status: z.literal("prepare"),
  entryId: z.uuid(),
  leaseId: z.uuid(),
  fileId: z.uuid(),
  file: FileAsset,
});
const Completed = z.discriminatedUnion("status", [
  z.object({ status: z.literal("retained"), receipt: KnowledgeEntryWriteReceipt }),
  z.object({ status: z.literal("unchanged"), entryId: z.uuid(), revisionId: z.uuid() }),
]);

async function prepare(
  db: Database,
  input: z.infer<typeof Identity>,
  request: Record<string, unknown>,
) {
  const identity = Identity.parse(input);
  return withWorkspaceRls(db, identity.workspaceId, async (tx) => {
    const [row] = await rawRows<{ result: unknown }>(
      tx,
      sql`SELECT knowledge_document_prepare(
      ${identity.accountId}::uuid,${identity.workspaceId}::uuid,${identity.documentId}::uuid,
      ${JSON.stringify({ ...request, fileId: identity.fileId })}::jsonb) AS result`,
    );
    return row?.result;
  });
}

/** Internal adapter for an existing, authorized Document indexing obligation.
 * No public tool receives the lease or can construct this processing actor. */
export async function claimKnowledgeDocumentPreparation(
  db: Database,
  input: z.infer<typeof Identity>,
) {
  const raw = z
    .record(z.string(), z.unknown())
    .parse(await prepare(db, input, { operation: "claim" }));
  return z.union([Claim, z.object({ status: z.literal("disabled"), fileId: z.uuid() })]).parse(
    raw.status === "prepare"
      ? {
          ...raw,
          file: knowledgeOriginalFileAsset(z.record(z.string(), z.unknown()).parse(raw.file)),
        }
      : raw,
  );
}

export async function completeKnowledgeDocumentPreparation(
  db: Database,
  input: z.infer<typeof Identity> & {
    leaseId: string;
    title: string;
    content: string;
    sourceVersion: string;
  },
) {
  const text = z
    .string()
    .refine((value) => Boolean(value.trim()), "No source text was extracted")
    .parse(input.content);
  return Completed.parse(
    await prepare(db, input, {
      operation: "complete",
      leaseId: z.uuid().parse(input.leaseId),
      sourceVersion: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(input.sourceVersion),
      title: toPostgresLosslessJson(z.string().min(1).parse(input.title)),
      content: toPostgresLosslessJson(text),
      preview: toPostgresLosslessText(text.slice(0, 512)),
      searchText: toPostgresLosslessText(`${input.title}\n${text}`),
      codecVersion: 1,
    }),
  );
}
