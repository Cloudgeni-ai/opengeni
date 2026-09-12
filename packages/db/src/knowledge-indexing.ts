import { namedSubjectPersonalWorkspaceId } from "./slack-routing-personal-workspace";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { StoredKnowledgeEntryContent } from "@opengeni/contracts";
import { rawRows, withRlsContext, type Database } from "./database";
import { fromPostgresLosslessJson, toPostgresLosslessText } from "./lossless-json";

const Claim = z.object({
  accountId: z.uuid(),
  entryId: z.uuid(),
  revisionId: z.uuid(),
  leaseId: z.uuid(),
  model: z.string().min(1).max(512),
  dimensions: z.number().int().min(1).max(4096),
  generation: z.number().int().positive(),
  nextIndex: z.number().int().nonnegative(),
});
export type KnowledgeIndexClaim = z.infer<typeof Claim>;

/** Internal projection dispatcher. No HTTP, MCP or agent tool exposes this capability. */
export async function claimKnowledgeIndexJobs(
  db: Database,
  input: { model: string; dimensions: number; limit?: number },
) {
  const request = z
    .object({
      model: Claim.shape.model,
      dimensions: Claim.shape.dimensions,
      limit: z.number().int().min(1).max(20).default(5),
    })
    .parse(input);
  const [row] = await rawRows<{ claims: unknown }>(
    db,
    sql`SELECT knowledge_index_claim(${request.model},${request.dimensions},${request.limit}) AS claims`,
  );
  return z.array(Claim).parse(row?.claims);
}
async function work(db: Database, raw: KnowledgeIndexClaim, request: Record<string, unknown>) {
  const claim = Claim.parse(raw);
  return withRlsContext(db, { accountId: claim.accountId }, async (tx) => {
    const [row] = await rawRows<{ result: unknown }>(
      tx,
      sql`SELECT knowledge_index_work(${claim.accountId}::uuid,
      ${claim.revisionId}::uuid,${claim.leaseId}::uuid,${JSON.stringify(request)}::jsonb) AS result`,
    );
    return z
      .object({
        status: z.enum(["running", "pending", "obsolete", "ready"]),
        nextIndex: z.number().int().optional(),
      })
      .passthrough()
      .parse(row?.result);
  });
}
export async function readKnowledgeIndexSource(db: Database, claim: KnowledgeIndexClaim) {
  const result = await work(db, claim, { operation: "read" });
  if (result.status !== "running") return null;
  const scope = z.enum(["workspace", "personal", "organization"]).parse(result.scope);
  const subjectId = z.string().nullable().parse(result.subjectId);
  const originWorkspaceId = z.uuid().parse(result.originWorkspaceId);
  // The lease authorizes this lookup for accounting only. Its canonical owner
  // tuple is not an authenticated human, access grant, or publication authority.
  // Personal retained content survives deletion of its originating workspace.
  const billingWorkspaceId =
    scope === "personal" && subjectId
      ? ((await namedSubjectPersonalWorkspaceId(db, { accountId: claim.accountId, subjectId })) ??
        originWorkspaceId)
      : originWorkspaceId;
  return {
    billingWorkspaceId,
    entry: StoredKnowledgeEntryContent.parse(
      fromPostgresLosslessJson(result.body, result.codecVersion as number | null),
    ),
    nextIndex: z.number().int().nonnegative().parse(result.nextIndex),
    originWorkspaceId: z.uuid().parse(result.originWorkspaceId),
    scope: z.enum(["workspace", "personal", "organization"]).parse(result.scope),
  };
}
export type KnowledgeIndexProjectionChunk = {
  index: number;
  field: "content" | "title";
  start: number;
  end: number;
  text: string;
  embedding: number[];
};
export async function appendKnowledgeIndexChunks(
  db: Database,
  claim: KnowledgeIndexClaim,
  expectedNextIndex: number,
  chunks: KnowledgeIndexProjectionChunk[],
) {
  const input = z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        field: z.enum(["content", "title"]),
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        text: z.string(),
        embedding: z.array(z.number().finite()).length(claim.dimensions),
      }),
    )
    .min(1)
    .max(64)
    .parse(chunks);
  return work(db, claim, {
    operation: "append",
    expectedNextIndex,
    chunks: input.map((chunk) => ({ ...chunk, text: toPostgresLosslessText(chunk.text) })),
  });
}
export async function completeKnowledgeIndexJob(
  db: Database,
  claim: KnowledgeIndexClaim,
  expectedNextIndex: number,
) {
  return work(db, claim, { operation: "complete", expectedNextIndex });
}
export async function deferKnowledgeIndexJob(db: Database, claim: KnowledgeIndexClaim) {
  return work(db, claim, { operation: "fail" });
}

export async function continueKnowledgeIndexJob(db: Database, claim: KnowledgeIndexClaim) {
  return work(db, claim, { operation: "continue" });
}
