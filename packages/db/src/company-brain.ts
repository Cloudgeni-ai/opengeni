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
    return [...new Set(rows.map((row) => row.revisionId))].sort();
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
