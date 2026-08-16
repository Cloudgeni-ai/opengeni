import {
  COMPANY_BRAIN_INSPECTOR_DEFAULT_LIMIT,
  COMPANY_BRAIN_INSPECTOR_MAX_LIMIT,
  COMPANY_BRAIN_PROPOSAL_CONTENT_MAX_BYTES,
  COMPANY_BRAIN_PROPOSAL_RESPONSE_MAX_BYTES,
  type CompanyBrainKnowledgeProposal,
  type CompanyBrainKnowledgeProposalPage,
} from "@opengeni/contracts";
import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";

import type { Database } from "./database";
import { withWorkspaceSubjectRls } from "./database";
import * as schema from "./schema";

export const COMPANY_BRAIN_PREFERENCE_MAX_COUNT = 100;
export const COMPANY_BRAIN_PREFERENCE_MAX_REVISIONS = 256;
export const COMPANY_BRAIN_PREFERENCE_MAX_CONTENT_BYTES = 2 * 1024 * 1024;

export type CompanyBrainPreferenceGuidanceRow = {
  preferenceId: string;
  stableKey: string;
  scope: string;
  status: string;
  supersededByPreferenceId: string | null;
  revisionId: string;
  revision: number;
  title: string;
  description: string;
  content: string;
  contentHash: string;
  provenanceSource: string;
  provenanceSourceId: string | null;
  trust: string;
  correctsRevisionId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  active: boolean;
};

export type CompanyBrainPreferenceGuidancePage = {
  rows: CompanyBrainPreferenceGuidanceRow[];
  preferenceCountTruncated: boolean;
  revisionCountTruncated: boolean;
  contentBytesTruncated: boolean;
};

function boundedUtf8Projection(
  value: string,
  maxBytes: number,
): {
  value: string;
  originalBytes: number;
  truncated: boolean;
} {
  const originalBytes = Buffer.byteLength(value, "utf8");
  if (originalBytes <= maxBytes) return { value, originalBytes, truncated: false };
  const marker = `\n[truncated; original UTF-8 bytes=${originalBytes}]`;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  let low = 0;
  let high = value.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, midpoint), "utf8") <= budget) low = midpoint;
    else high = midpoint - 1;
  }
  return { value: value.slice(0, low) + marker, originalBytes, truncated: true };
}

function proposalPageBytes(page: CompanyBrainKnowledgeProposalPage): number {
  return Buffer.byteLength(JSON.stringify(page), "utf8");
}

function finalizeProposalPage(
  proposals: CompanyBrainKnowledgeProposal[],
  truncatedForCount: boolean,
  truncatedForResponseBytes: boolean,
): CompanyBrainKnowledgeProposalPage {
  const page: CompanyBrainKnowledgeProposalPage = {
    proposals,
    truncatedForCount,
    truncatedForResponseBytes,
    responseBytes: 0,
  };
  for (let pass = 0; pass < 3; pass += 1) page.responseBytes = proposalPageBytes(page);
  return page;
}

/**
 * Read-only review projection over governed Knowledge change proposals. RLS
 * filters scope before rows enter this independent item/aggregate byte bound.
 */
export async function listCompanyBrainKnowledgeProposals(
  db: Database,
  input: { workspaceId: string; subjectId: string; limit?: number },
): Promise<CompanyBrainKnowledgeProposalPage> {
  const limit = input.limit ?? COMPANY_BRAIN_INSPECTOR_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > COMPANY_BRAIN_INSPECTOR_MAX_LIMIT) {
    throw new Error("Company Brain proposal limit must be between 1 and 50");
  }
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.knowledgeChangeProposals)
      .where(eq(schema.knowledgeChangeProposals.status, "proposed"))
      .orderBy(
        desc(schema.knowledgeChangeProposals.createdAt),
        desc(schema.knowledgeChangeProposals.id),
      )
      .limit(limit + 1);
    const truncatedForCount = rows.length > limit;
    const selected: CompanyBrainKnowledgeProposal[] = [];
    let truncatedForResponseBytes = false;
    for (const row of rows.slice(0, limit)) {
      const content = boundedUtf8Projection(row.content, COMPANY_BRAIN_PROPOSAL_CONTENT_MAX_BYTES);
      const projected: CompanyBrainKnowledgeProposal = {
        id: row.id,
        authority: { kind: row.scopeKind as CompanyBrainKnowledgeProposal["authority"]["kind"] },
        targetKind: row.targetKind as CompanyBrainKnowledgeProposal["targetKind"],
        targetScope: row.targetScope,
        targetKey: row.targetKey,
        content: content.value,
        contentHash: row.contentHash,
        source: { claimId: row.claimId, evidenceId: row.evidenceId },
        status: "proposed",
        createdAt: row.createdAt.toISOString(),
        projection: {
          truncated: content.truncated,
          originalContentUtf8Bytes: content.originalBytes,
        },
      };
      const candidate = finalizeProposalPage(
        [...selected, projected],
        truncatedForCount,
        truncatedForResponseBytes,
      );
      if (candidate.responseBytes > COMPANY_BRAIN_PROPOSAL_RESPONSE_MAX_BYTES) {
        truncatedForResponseBytes = true;
        continue;
      }
      selected.push(projected);
    }
    const page = finalizeProposalPage(selected, truncatedForCount, truncatedForResponseBytes);
    if (page.responseBytes > COMPANY_BRAIN_PROPOSAL_RESPONSE_MAX_BYTES) {
      throw new Error("Company Brain proposal projection exceeded its response boundary");
    }
    return page;
  });
}

export async function listActivatedCompanyBrainPolicyRevisionIds(
  db: Database,
  input: { workspaceId: string; subjectId: string; revisionIds: string[] },
): Promise<string[]> {
  const revisionIds = [...new Set(input.revisionIds)].sort();
  if (revisionIds.length === 0) return [];
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const rows = await scopedDb
      .select({ revisionId: schema.workspaceInstructionPolicyActivationEvents.newRevisionId })
      .from(schema.workspaceInstructionPolicyActivationEvents)
      .where(
        and(
          eq(schema.workspaceInstructionPolicyActivationEvents.workspaceId, input.workspaceId),
          inArray(schema.workspaceInstructionPolicyActivationEvents.newRevisionId, revisionIds),
        ),
      );
    return [
      ...new Set(rows.map((row) => row.revisionId).filter((id): id is string => id !== null)),
    ].sort();
  });
}

/**
 * Read bounded full guidance only after applying the existing subject-aware
 * Preference Registry RLS context. Personal rows for another subject never
 * enter the candidate set, and relationship targets are filtered by the API
 * projection against this authorized page.
 */
export async function listCompanyBrainPreferenceGuidance(
  db: Database,
  input: { workspaceId: string; subjectId: string },
): Promise<CompanyBrainPreferenceGuidancePage> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const preferences = await scopedDb
      .select()
      .from(schema.preferenceRegistryPreferences)
      .orderBy(
        asc(schema.preferenceRegistryPreferences.scope),
        asc(schema.preferenceRegistryPreferences.stableKey),
        asc(schema.preferenceRegistryPreferences.id),
      )
      .limit(COMPANY_BRAIN_PREFERENCE_MAX_COUNT + 1);

    const preferenceCountTruncated = preferences.length > COMPANY_BRAIN_PREFERENCE_MAX_COUNT;
    const boundedPreferences = preferences.slice(0, COMPANY_BRAIN_PREFERENCE_MAX_COUNT);
    if (boundedPreferences.length === 0) {
      return {
        rows: [],
        preferenceCountTruncated,
        revisionCountTruncated: false,
        contentBytesTruncated: false,
      };
    }

    const preferenceById = new Map(
      boundedPreferences.map((preference) => [preference.id, preference] as const),
    );
    const preferenceIds = boundedPreferences.map((preference) => preference.id);
    const activeRevisionIds = [
      ...new Set(
        boundedPreferences.flatMap((preference) =>
          preference.activeRevisionId ? [preference.activeRevisionId] : [],
        ),
      ),
    ].sort();
    const activeRevisions =
      activeRevisionIds.length === 0
        ? []
        : await scopedDb
            .select()
            .from(schema.preferenceRegistryRevisions)
            .where(inArray(schema.preferenceRegistryRevisions.id, activeRevisionIds))
            .orderBy(
              asc(schema.preferenceRegistryRevisions.preferenceId),
              desc(schema.preferenceRegistryRevisions.revision),
              asc(schema.preferenceRegistryRevisions.id),
            );
    const historicalLimit = Math.max(
      0,
      COMPANY_BRAIN_PREFERENCE_MAX_REVISIONS - activeRevisions.length,
    );
    const historicalRevisions = await scopedDb
      .select()
      .from(schema.preferenceRegistryRevisions)
      .where(
        and(
          inArray(schema.preferenceRegistryRevisions.preferenceId, preferenceIds),
          activeRevisionIds.length > 0
            ? notInArray(schema.preferenceRegistryRevisions.id, activeRevisionIds)
            : undefined,
        ),
      )
      .orderBy(
        asc(schema.preferenceRegistryRevisions.preferenceId),
        desc(schema.preferenceRegistryRevisions.revision),
        asc(schema.preferenceRegistryRevisions.id),
      )
      .limit(historicalLimit + 1);
    const revisionCountTruncated = historicalRevisions.length > historicalLimit;
    const revisions = [...activeRevisions, ...historicalRevisions.slice(0, historicalLimit)];

    // Active bodies are the most important portable truth. Put them first,
    // then retain newest authorized history under independent count/byte caps.
    const ordered = [...revisions].sort((left, right) => {
      const leftPreference = preferenceById.get(left.preferenceId)!;
      const rightPreference = preferenceById.get(right.preferenceId)!;
      const leftActive = left.id === leftPreference.activeRevisionId ? 0 : 1;
      const rightActive = right.id === rightPreference.activeRevisionId ? 0 : 1;
      if (leftActive !== rightActive) return leftActive - rightActive;
      const preferenceOrder = left.preferenceId.localeCompare(right.preferenceId);
      if (preferenceOrder !== 0) return preferenceOrder;
      if (left.revision !== right.revision) return right.revision - left.revision;
      return left.id.localeCompare(right.id);
    });

    const rows: CompanyBrainPreferenceGuidanceRow[] = [];
    let contentBytes = 0;
    let contentBytesTruncated = false;
    for (const revision of ordered) {
      const nextBytes = new TextEncoder().encode(revision.content).byteLength;
      if (contentBytes + nextBytes > COMPANY_BRAIN_PREFERENCE_MAX_CONTENT_BYTES) {
        contentBytesTruncated = true;
        continue;
      }
      const preference = preferenceById.get(revision.preferenceId);
      if (!preference) continue;
      rows.push({
        preferenceId: preference.id,
        stableKey: preference.stableKey,
        scope: preference.scope,
        status: preference.status,
        supersededByPreferenceId: preference.supersededByPreferenceId,
        revisionId: revision.id,
        revision: revision.revision,
        title: revision.title,
        description: revision.description,
        content: revision.content,
        contentHash: revision.contentHash,
        provenanceSource: revision.provenanceSource,
        provenanceSourceId: revision.provenanceSourceId,
        trust: revision.trust,
        correctsRevisionId: revision.correctsRevisionId,
        expiresAt: revision.expiresAt,
        createdAt: revision.createdAt,
        active: revision.id === preference.activeRevisionId,
      });
      contentBytes += nextBytes;
    }

    if (rows.length < ordered.length) {
      contentBytesTruncated = true;
    }
    return {
      rows,
      preferenceCountTruncated,
      revisionCountTruncated,
      contentBytesTruncated,
    };
  });
}
