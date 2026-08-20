import { createHash } from "node:crypto";
import {
  COMPANY_BRAIN_INSPECTOR_CURSOR_MAX_CHARS,
  COMPANY_BRAIN_INSPECTOR_DEFAULT_LIMIT,
  COMPANY_BRAIN_INSPECTOR_MAX_LIMIT,
  CompanyBrainContextReceiptPage,
  CompanyBrainKnowledgeProposalPage,
  CompanyBrainOkfPackage,
  KnowledgeBrowseRequest,
  KnowledgeBrowseResponse,
  KnowledgeGetResponse,
  KnowledgeRecordId,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse,
  type WorkspaceInstructionPolicyRevision,
} from "@opengeni/contracts";
import { hasPermission, requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  getCurrentPreferenceRegistryGovernanceMetadata,
  getWorkspace,
  getWorkspaceInstructionPolicyRevision,
  inspectCompanyBrainContextReceipts,
  listActivatedCompanyBrainPolicyRevisionIds,
  listCompanyBrainKnowledgeProposals,
  listCompanyBrainPreferenceGuidance,
  listCompanyProfile,
  listWorkspaceInstructionPolicyRevisions,
  listWorkspaceStateMemoryRecords,
} from "@opengeni/db";
import {
  browseEffectiveKnowledge,
  getDocumentInventory,
  getEffectiveKnowledgeRecord,
  searchEffectiveKnowledge,
} from "@opengeni/documents";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { createCompanyBrainOkfPackage, serializeCompanyBrainOkf } from "../company-brain-okf";
import { projectWorkspaceState } from "../workspace-state-projection";

const BASE_LIMIT = 24;
const TOPIC_LIMIT = 24;
const TOPIC_MAX_CHARS = 96;

const inspectorQuery = z
  .object({
    attemptId: z.string().uuid().optional(),
    cursor: z.string().min(1).max(COMPANY_BRAIN_INSPECTOR_CURSOR_MAX_CHARS).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(COMPANY_BRAIN_INSPECTOR_MAX_LIMIT)
      .default(COMPANY_BRAIN_INSPECTOR_DEFAULT_LIMIT),
  })
  .strict()
  .refine((value) => !(value.attemptId && value.cursor), {
    message: "attemptId cannot be combined with cursor",
  });

type ReceiptCursor = { createdAt: string; id: string };

function receiptCursorScope(workspaceId: string, subjectId: string): string {
  return createHash("sha256")
    .update("opengeni:company-brain-context-receipts:v1\0")
    .update(workspaceId)
    .update("\0")
    .update(subjectId)
    .digest("hex");
}

function encodeReceiptCursor(
  workspaceId: string,
  subjectId: string,
  cursor: ReceiptCursor,
): string {
  return Buffer.from(
    JSON.stringify({ v: 1, s: receiptCursorScope(workspaceId, subjectId), ...cursor }),
    "utf8",
  ).toString("base64url");
}

function decodeReceiptCursor(value: string, workspaceId: string, subjectId: string): ReceiptCursor {
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("encoding");
    const decoded = z
      .object({
        v: z.literal(1),
        s: z.string().regex(/^[0-9a-f]{64}$/u),
        createdAt: z.string().datetime(),
        id: z.string().uuid(),
      })
      .strict()
      .parse(JSON.parse(bytes.toString("utf8")));
    if (decoded.s !== receiptCursorScope(workspaceId, subjectId)) {
      throw new HTTPException(409, { message: "context receipt cursor belongs to another scope" });
    }
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(400, { message: "context receipt cursor is invalid" });
  }
}

async function parsedJson<T>(
  context: { req: { json: () => Promise<unknown> } },
  schema: z.ZodType<T>,
) {
  const result = schema.safeParse(await context.req.json().catch(() => null));
  if (!result.success) throw new HTTPException(400, { message: "invalid Company Brain request" });
  return result.data;
}

function knowledgeHttpError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("belongs to a different scope")) {
    throw new HTTPException(409, { message });
  }
  if (message.includes("invalid knowledge") || message.includes("knowledge browse")) {
    throw new HTTPException(400, { message });
  }
  throw error;
}

async function readCompanyBrainPackage(
  deps: ApiRouteDeps,
  input: {
    workspaceId: string;
    accountId: string;
    subjectId: string;
    canInspectKnowledge: boolean;
  },
) {
  const generatedAt = new Date().toISOString();
  const [
    workspace,
    instructionPolicies,
    companyProfile,
    preferences,
    currentPreferences,
    knowledge,
  ] = await Promise.all([
    getWorkspace(deps.db, input.workspaceId),
    listWorkspaceInstructionPolicyRevisions(deps.db, input.workspaceId, { limit: 100 }),
    listCompanyProfile(deps.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      limit: 100,
    }),
    listCompanyBrainPreferenceGuidance(deps.db, {
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
    }),
    getCurrentPreferenceRegistryGovernanceMetadata(deps.db, {
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
    }),
    input.canInspectKnowledge
      ? Promise.all([
          getDocumentInventory(deps.db, input.workspaceId, {
            baseLimit: BASE_LIMIT,
            topicLimit: TOPIC_LIMIT,
            topicMaxChars: TOPIC_MAX_CHARS,
            access: { viewerSubjectId: input.subjectId },
          }),
          listWorkspaceStateMemoryRecords(deps.db, input.workspaceId),
        ]).then(([documents, memories]) => ({ documents, memories }))
      : Promise.resolve(null),
  ]);
  if (!workspace) throw new HTTPException(404, { message: "workspace not found" });

  const listedRevisionIds = new Set(instructionPolicies.revisions.map((revision) => revision.id));
  const missingActiveIds = instructionPolicies.activeHeads
    .map((head) => head.revisionId)
    .filter((revisionId) => !listedRevisionIds.has(revisionId));
  const activeInstructionPolicyRevisions: WorkspaceInstructionPolicyRevision[] = [
    ...instructionPolicies.revisions.filter((revision) =>
      instructionPolicies.activeHeads.some((head) => head.revisionId === revision.id),
    ),
    ...(await Promise.all(
      missingActiveIds.map((revisionId) =>
        getWorkspaceInstructionPolicyRevision(deps.db, input.workspaceId, revisionId),
      ),
    )),
  ];
  const activatedInstructionPolicyRevisionIds = await listActivatedCompanyBrainPolicyRevisionIds(
    deps.db,
    {
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      revisionIds: [...instructionPolicies.revisions, ...activeInstructionPolicyRevisions].map(
        (revision) => revision.id,
      ),
    },
  );

  const state = projectWorkspaceState({
    workspaceId: input.workspaceId,
    generatedAt,
    workspaceAgentInstructions: workspace.agentInstructions,
    policies: instructionPolicies,
    preferences: currentPreferences,
    knowledge,
    attemptGovernance: null,
  });
  return createCompanyBrainOkfPackage({
    workspaceId: input.workspaceId,
    generatedAt,
    companyProfile,
    instructionPolicies,
    activeInstructionPolicyRevisions,
    activatedInstructionPolicyRevisionIds,
    preferences,
    knowledge: state.knowledge,
  });
}

export function registerCompanyBrainRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/workspaces/:workspaceId/company-brain";

  app.get(base, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const result = await readCompanyBrainPackage(deps, {
      workspaceId,
      accountId: grant.accountId,
      subjectId: grant.subjectId,
      canInspectKnowledge: hasPermission(grant.permissions, "documents:search"),
    });
    context.header("cache-control", "private, no-store");
    return context.json(CompanyBrainOkfPackage.parse(result));
  });

  app.get(`${base}/export`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const result = await readCompanyBrainPackage(deps, {
      workspaceId,
      accountId: grant.accountId,
      subjectId: grant.subjectId,
      canInspectKnowledge: hasPermission(grant.permissions, "documents:search"),
    });
    context.header("cache-control", "private, no-store");
    context.header("content-type", "text/markdown; charset=utf-8");
    context.header(
      "content-disposition",
      `attachment; filename="company-brain-${workspaceId}.okf.md"`,
    );
    return context.body(serializeCompanyBrainOkf(result));
  });

  app.post(`${base}/knowledge/search`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "documents:search");
    const request = await parsedJson(context, KnowledgeSearchRequest);
    try {
      const response = await searchEffectiveKnowledge(
        deps.db,
        {
          accountId: grant.accountId,
          workspaceId,
          initiatingSubjectId: grant.subjectId,
          surface: "human",
          ...request,
        },
        deps.getDocumentServices(),
      );
      context.header("cache-control", "private, no-store");
      return context.json(KnowledgeSearchResponse.parse(response));
    } catch (error) {
      return knowledgeHttpError(error);
    }
  });

  app.get(`${base}/knowledge/record`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "documents:search");
    const parsedId = KnowledgeRecordId.safeParse(context.req.query("id"));
    if (!parsedId.success)
      throw new HTTPException(400, { message: "knowledge record id is invalid" });
    const record = await getEffectiveKnowledgeRecord(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      initiatingSubjectId: grant.subjectId,
      surface: "human",
      id: parsedId.data,
    });
    if (!record) throw new HTTPException(404, { message: "knowledge record not found" });
    context.header("cache-control", "private, no-store");
    return context.json(KnowledgeGetResponse.parse({ record }));
  });

  app.post(`${base}/knowledge/browse`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "documents:search");
    const request = await parsedJson(context, KnowledgeBrowseRequest);
    try {
      const response = await browseEffectiveKnowledge(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        initiatingSubjectId: grant.subjectId,
        surface: "human",
        ...request,
      });
      context.header("cache-control", "private, no-store");
      return context.json(KnowledgeBrowseResponse.parse(response));
    } catch (error) {
      return knowledgeHttpError(error);
    }
  });

  app.get(`${base}/context-receipts`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const parsed = inspectorQuery.safeParse(context.req.query());
    if (!parsed.success) throw new HTTPException(400, { message: "invalid context receipt query" });
    const before = parsed.data.cursor
      ? decodeReceiptCursor(parsed.data.cursor, workspaceId, grant.subjectId)
      : undefined;
    const rows = await inspectCompanyBrainContextReceipts(deps.db, {
      workspaceId,
      subjectId: grant.subjectId,
      ...(parsed.data.attemptId ? { attemptId: parsed.data.attemptId } : {}),
      ...(before ? { before } : {}),
      limit: parsed.data.attemptId ? 1 : parsed.data.limit + 1,
    });
    const hasMore = !parsed.data.attemptId && rows.length > parsed.data.limit;
    const receipts = rows.slice(0, parsed.data.limit);
    const tail = receipts.at(-1);
    const response = CompanyBrainContextReceiptPage.parse({
      receipts,
      hasMore,
      nextCursor:
        hasMore && tail
          ? encodeReceiptCursor(workspaceId, grant.subjectId, {
              createdAt: tail.createdAt,
              id: tail.id,
            })
          : null,
    });
    context.header("cache-control", "private, no-store");
    return context.json(response);
  });

  app.get(`${base}/knowledge-proposals`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "documents:search");
    const parsed = z.coerce
      .number()
      .int()
      .positive()
      .max(COMPANY_BRAIN_INSPECTOR_MAX_LIMIT)
      .default(COMPANY_BRAIN_INSPECTOR_DEFAULT_LIMIT)
      .safeParse(context.req.query("limit"));
    if (!parsed.success) throw new HTTPException(400, { message: "invalid proposal limit" });
    const response = await listCompanyBrainKnowledgeProposals(deps.db, {
      workspaceId,
      subjectId: grant.subjectId,
      limit: parsed.data,
    });
    context.header("cache-control", "private, no-store");
    return context.json(CompanyBrainKnowledgeProposalPage.parse(response));
  });
}
