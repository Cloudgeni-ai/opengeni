// Knowledge bank: versioned workspace charter (purpose + goals + knowledge-map
// narrative) plus the dirty-state sweep plumbing. Charter history is
// append-only — every writer inserts the next version; provenance lives in
// updated_by/model. The structural knowledge map is derived live from
// bases/documents/memories so it can never drift from the data; only the
// narrative layer (overview, base blurbs, gaps) comes from synthesis.
import type {
  KnowledgeBankState,
  KnowledgeMap,
  KnowledgeMapBase,
  WorkspaceCharter,
  WorkspaceCharterBaseNote,
} from "@opengeni/contracts";
import { resolveWorkspaceKnowledgeBankEnabled } from "@opengeni/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./index";
import { withWorkspaceRls } from "./index";
import { estimateMemoryTokens, sanitizeMemoryText } from "./memory-domain";
import * as schema from "./schema";

export const CHARTER_PURPOSE_MAX_CHARS = 2000;
export const CHARTER_GOAL_MAX_CHARS = 300;
export const CHARTER_MAX_GOALS = 12;
export const CHARTER_MAX_GAPS = 8;
export const CHARTER_MAX_BASE_NOTES = 24;
// The injected knowledge-bank block is deliberately small next to the 2500-token
// workspace-memory budget: purpose + goals + gaps, never the whole narrative.
export const KNOWLEDGE_BANK_BLOCK_TOKEN_BUDGET = 600;
export const KNOWLEDGE_BANK_BLOCK_HEADER =
  "## Workspace knowledge bank\n" +
  "The workspace's living charter — its purpose, current goals, and known knowledge gaps. " +
  "Keep your work aligned with it; propose an update via charter_propose_update when reality moves on.";

export type WorkspaceCharterRow = typeof schema.workspaceCharters.$inferSelect;
export type KnowledgeBankStateRow = typeof schema.knowledgeBankState.$inferSelect;

export type SaveWorkspaceCharterInput = {
  accountId: string;
  workspaceId: string;
  purpose: string;
  goals: string[];
  overview?: string | null | undefined;
  baseNotes?: WorkspaceCharterBaseNote[] | undefined;
  gaps?: string[] | undefined;
  changelog?: string | null | undefined;
  updatedBy: string;
  model?: string | null | undefined;
};

export function mapWorkspaceCharter(row: WorkspaceCharterRow): WorkspaceCharter {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    version: row.version,
    purpose: row.purpose,
    goals: cleanCharterStrings(row.goals, CHARTER_MAX_GOALS, CHARTER_GOAL_MAX_CHARS),
    overview: row.overview,
    baseNotes: Array.isArray(row.baseNotes) ? row.baseNotes : [],
    gaps: cleanCharterStrings(row.gaps, CHARTER_MAX_GAPS, CHARTER_GOAL_MAX_CHARS),
    changelog: row.changelog,
    updatedBy: row.updatedBy,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapKnowledgeBankState(row: KnowledgeBankStateRow): KnowledgeBankState {
  return {
    dirtyAt: row.dirtyAt?.toISOString() ?? null,
    lastSweptAt: row.lastSweptAt?.toISOString() ?? null,
    lastError: row.lastError,
    locked: row.locked,
  };
}

/** Sanitize + clamp a charter text field through the shared secret-redaction gate. */
export function sanitizeCharterText(raw: string, maxChars: number): string {
  return sanitizeMemoryText(raw).text.slice(0, maxChars).trim();
}

function cleanCharterStrings(values: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map((value) => value.slice(0, maxChars));
}

export async function getLatestWorkspaceCharter(
  db: Database,
  workspaceId: string,
): Promise<WorkspaceCharter | null> {
  const [row] = await withWorkspaceRls(
    db,
    workspaceId,
    async (scopedDb) =>
      await scopedDb
        .select()
        .from(schema.workspaceCharters)
        .where(eq(schema.workspaceCharters.workspaceId, workspaceId))
        .orderBy(desc(schema.workspaceCharters.version))
        .limit(1),
  );
  return row ? mapWorkspaceCharter(row) : null;
}

export async function listWorkspaceCharterVersions(
  db: Database,
  workspaceId: string,
  limit = 20,
): Promise<WorkspaceCharter[]> {
  const bounded = Math.min(Math.max(limit, 1), 100);
  const rows = await withWorkspaceRls(
    db,
    workspaceId,
    async (scopedDb) =>
      await scopedDb
        .select()
        .from(schema.workspaceCharters)
        .where(eq(schema.workspaceCharters.workspaceId, workspaceId))
        .orderBy(desc(schema.workspaceCharters.version))
        .limit(bounded),
  );
  return rows.map(mapWorkspaceCharter);
}

/**
 * Append the next charter version. Text fields pass the shared sanitize/redact
 * gate; a concurrent writer losing the (workspace, version) unique race retries
 * once with the fresh max.
 */
export async function saveWorkspaceCharterVersion(
  db: Database,
  input: SaveWorkspaceCharterInput,
): Promise<WorkspaceCharter> {
  const purpose = sanitizeCharterText(input.purpose, CHARTER_PURPOSE_MAX_CHARS);
  if (!purpose) {
    throw new Error("charter purpose is empty after sanitization");
  }
  const goals = input.goals
    .map((goal) => sanitizeCharterText(goal, CHARTER_GOAL_MAX_CHARS))
    .filter(Boolean)
    .slice(0, CHARTER_MAX_GOALS);
  const gaps = (input.gaps ?? [])
    .map((gap) => sanitizeCharterText(gap, CHARTER_GOAL_MAX_CHARS))
    .filter(Boolean)
    .slice(0, CHARTER_MAX_GAPS);
  const baseNotes = (input.baseNotes ?? []).slice(0, CHARTER_MAX_BASE_NOTES).map((note) => ({
    baseId: note.baseId,
    name: note.name.slice(0, 200),
    blurb: sanitizeCharterText(note.blurb, 500),
  }));
  const overview = input.overview ? sanitizeCharterText(input.overview, 4000) : null;
  const changelog = input.changelog ? sanitizeCharterText(input.changelog, 500) : null;

  const insertOnce = async (): Promise<WorkspaceCharterRow | undefined> =>
    await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
      const [latest] = await scopedDb
        .select({ version: schema.workspaceCharters.version })
        .from(schema.workspaceCharters)
        .where(eq(schema.workspaceCharters.workspaceId, input.workspaceId))
        .orderBy(desc(schema.workspaceCharters.version))
        .limit(1);
      const [inserted] = await scopedDb
        .insert(schema.workspaceCharters)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          version: (latest?.version ?? 0) + 1,
          purpose,
          goals,
          overview,
          baseNotes,
          gaps,
          changelog,
          updatedBy: input.updatedBy,
          model: input.model ?? null,
        })
        .returning();
      return inserted;
    });

  let inserted: WorkspaceCharterRow | undefined;
  try {
    inserted = await insertOnce();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    inserted = await insertOnce();
  }
  if (!inserted) throw new Error("Failed to save workspace charter version");
  return mapWorkspaceCharter(inserted);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as { code?: string }).code === "23505" ||
      ((error as { cause?: { code?: string } }).cause?.code ?? "") === "23505")
  );
}

export async function getKnowledgeBankState(
  db: Database,
  workspaceId: string,
): Promise<KnowledgeBankState | null> {
  const [row] = await withWorkspaceRls(
    db,
    workspaceId,
    async (scopedDb) =>
      await scopedDb
        .select()
        .from(schema.knowledgeBankState)
        .where(eq(schema.knowledgeBankState.workspaceId, workspaceId))
        .limit(1),
  );
  return row ? mapKnowledgeBankState(row) : null;
}

/**
 * Mark the workspace's bank dirty so the background sweep re-synthesizes it.
 * Callable inside an RLS-scoped executor (pass the scoped handle) or with the
 * plain db; upsert keeps it idempotent under concurrency.
 */
export async function markKnowledgeBankDirty(
  executor: Pick<Database, "insert">,
  input: { accountId: string; workspaceId: string },
): Promise<void> {
  await executor
    .insert(schema.knowledgeBankState)
    .values({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      dirtyAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.knowledgeBankState.workspaceId,
      set: { dirtyAt: new Date(), updatedAt: new Date() },
    });
}

/** RLS-scoped convenience wrapper for API callers. */
export async function markKnowledgeBankDirtyScoped(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<void> {
  await withWorkspaceRls(db, input.workspaceId, async (scopedDb) =>
    markKnowledgeBankDirty(scopedDb, input),
  );
}

export async function setKnowledgeBankLocked(
  db: Database,
  input: { accountId: string; workspaceId: string; locked: boolean },
): Promise<KnowledgeBankState> {
  const [row] = await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scopedDb) =>
      await scopedDb
        .insert(schema.knowledgeBankState)
        .values({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          locked: input.locked,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.knowledgeBankState.workspaceId,
          set: { locked: input.locked, updatedAt: new Date() },
        })
        .returning(),
  );
  if (!row) throw new Error("Failed to update knowledge bank lock");
  return mapKnowledgeBankState(row);
}

/** Settle one sweep: success clears dirty; failure records the error and leaves dirty. */
export async function recordKnowledgeBankSweepResult(
  db: Database,
  input: { accountId: string; workspaceId: string; error?: string | null | undefined },
): Promise<void> {
  await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    await scopedDb
      .insert(schema.knowledgeBankState)
      .values({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        dirtyAt: input.error ? new Date() : null,
        lastSweptAt: new Date(),
        lastError: input.error ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.knowledgeBankState.workspaceId,
        set: {
          dirtyAt: input.error ? new Date() : null,
          lastSweptAt: new Date(),
          lastError: input.error ?? null,
          updatedAt: new Date(),
        },
      });
  });
}

/**
 * Cross-workspace dirty claim for the background sweep, through the sanctioned
 * SECURITY DEFINER seam (opengeni_private.claim_dirty_knowledge_banks —
 * migration 0132). Claiming stamps dirty_at forward by reclaimMs so a crashed
 * sweep re-claims later; only recordKnowledgeBankSweepResult clears it.
 */
export async function claimDirtyKnowledgeBanks(
  db: Database,
  input: { reclaimMs: number; limit: number },
): Promise<Array<{ workspaceId: string; accountId: string }>> {
  const result = await db.execute<{ workspace_id: string; account_id: string }>(
    sql`
      select workspace_id, account_id
      from opengeni_private.claim_dirty_knowledge_banks(${input.reclaimMs}, ${input.limit})
    `,
  );
  const rows = Array.isArray(result)
    ? (result as unknown as Array<{ workspace_id: string; account_id: string }>)
    : ((result as unknown as { rows?: Array<{ workspace_id: string; account_id: string }> }).rows ??
      []);
  return rows.map((row) => ({ workspaceId: row.workspace_id, accountId: row.account_id }));
}

/**
 * Derive the structural knowledge map live from bases/documents/memories.
 * Deliberately non-LLM: counts, merged topic sets, and freshness can never
 * drift from the data they describe.
 */
export async function aggregateKnowledgeMap(
  db: Database,
  workspaceId: string,
): Promise<KnowledgeMap> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const bases = await scopedDb
      .select({
        id: schema.documentBases.id,
        name: schema.documentBases.name,
        description: schema.documentBases.description,
      })
      .from(schema.documentBases)
      .where(eq(schema.documentBases.workspaceId, workspaceId));
    const documents = await scopedDb
      .select({
        baseId: schema.documents.baseId,
        status: schema.documents.status,
        topics: schema.documents.topics,
        updatedAt: schema.documents.updatedAt,
      })
      .from(schema.documents)
      .where(eq(schema.documents.workspaceId, workspaceId));
    const memoryRows = await scopedDb
      .select({
        kind: schema.knowledgeMemories.kind,
        count: sql<number>`count(*)`,
      })
      .from(schema.knowledgeMemories)
      .where(
        and(
          eq(schema.knowledgeMemories.workspaceId, workspaceId),
          sql`${schema.knowledgeMemories.status} in ('active', 'approved')`,
        ),
      )
      .groupBy(schema.knowledgeMemories.kind);

    const byBase = new Map<
      string,
      {
        documentCount: number;
        readyCount: number;
        topics: Set<string>;
        lastDocumentAt: Date | null;
      }
    >();
    const topicCounts = new Map<string, number>();
    let totalReady = 0;
    for (const document of documents) {
      const entry = byBase.get(document.baseId) ?? {
        documentCount: 0,
        readyCount: 0,
        topics: new Set<string>(),
        lastDocumentAt: null,
      };
      entry.documentCount += 1;
      if (document.status === "ready") {
        entry.readyCount += 1;
        totalReady += 1;
      }
      if (!entry.lastDocumentAt || document.updatedAt > entry.lastDocumentAt) {
        entry.lastDocumentAt = document.updatedAt;
      }
      for (const topic of Array.isArray(document.topics) ? document.topics : []) {
        if (typeof topic !== "string" || !topic.trim()) continue;
        const normalized = topic.trim().toLowerCase();
        entry.topics.add(normalized);
        topicCounts.set(normalized, (topicCounts.get(normalized) ?? 0) + 1);
      }
      byBase.set(document.baseId, entry);
    }

    const mapBases: KnowledgeMapBase[] = bases
      .map((base) => {
        const entry = byBase.get(base.id);
        return {
          id: base.id,
          name: base.name,
          description: base.description,
          documentCount: entry?.documentCount ?? 0,
          readyCount: entry?.readyCount ?? 0,
          topics: [...(entry?.topics ?? [])].sort(),
          lastDocumentAt: entry?.lastDocumentAt?.toISOString() ?? null,
        };
      })
      .sort((left, right) => right.documentCount - left.documentCount);

    const memoriesByKind: Record<string, number> = {};
    let totalMemories = 0;
    for (const row of memoryRows) {
      memoriesByKind[row.kind] = Number(row.count);
      totalMemories += Number(row.count);
    }

    return {
      bases: mapBases,
      totalDocuments: documents.length,
      totalReadyDocuments: totalReady,
      totalMemories,
      memoriesByKind,
      topics: [...topicCounts.entries()]
        .map(([topic, count]) => ({ topic, count }))
        .sort((left, right) => right.count - left.count)
        .slice(0, 40),
    };
  });
}

/** Inputs the sweep feeds the synthesizer, gathered under workspace RLS. */
export async function gatherCharterSynthesisSignals(
  db: Database,
  workspaceId: string,
): Promise<{
  recentDocuments: Array<{ title: string; summary: string | null; topics: string[] }>;
  recentMemories: Array<{ kind: string; text: string }>;
}> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const recentDocuments = await scopedDb
      .select({
        title: schema.documents.title,
        summary: schema.documents.summary,
        topics: schema.documents.topics,
      })
      .from(schema.documents)
      .where(
        and(eq(schema.documents.workspaceId, workspaceId), eq(schema.documents.status, "ready")),
      )
      .orderBy(desc(schema.documents.updatedAt))
      .limit(20);
    const recentMemories = await scopedDb
      .select({
        kind: schema.knowledgeMemories.kind,
        text: schema.knowledgeMemories.text,
      })
      .from(schema.knowledgeMemories)
      .where(
        and(
          eq(schema.knowledgeMemories.workspaceId, workspaceId),
          sql`${schema.knowledgeMemories.status} in ('active', 'approved')`,
        ),
      )
      .orderBy(desc(schema.knowledgeMemories.updatedAt))
      .limit(20);
    return {
      recentDocuments: recentDocuments.map((document) => ({
        title: document.title,
        summary: document.summary,
        topics: Array.isArray(document.topics) ? document.topics : [],
      })),
      recentMemories,
    };
  });
}

/**
 * Render the injected knowledge-bank block: purpose + goals + gaps under a hard
 * token budget. Returns null with no charter. Gated by
 * settings.knowledgeBankEnabled — agent surfaces only, like workspace memory.
 */
export async function resolveWorkspaceKnowledgeBankBlock(
  db: Database,
  workspaceId: string,
): Promise<string | null> {
  const [workspace] = await db
    .select({ settings: schema.workspaces.settings })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  if (!workspace || !resolveWorkspaceKnowledgeBankEnabled(workspace.settings)) {
    return null;
  }
  const charter = await getLatestWorkspaceCharter(db, workspaceId);
  if (!charter) return null;
  return renderKnowledgeBankBlock(charter);
}

export function renderKnowledgeBankBlock(
  charter: Pick<WorkspaceCharter, "purpose" | "goals" | "gaps">,
): string | null {
  const lines: string[] = [];
  const push = (line: string): boolean => {
    const candidate = [...lines, line].join("\n");
    if (
      estimateMemoryTokens(candidate) + estimateMemoryTokens(KNOWLEDGE_BANK_BLOCK_HEADER) >
      KNOWLEDGE_BANK_BLOCK_TOKEN_BUDGET
    ) {
      return false;
    }
    lines.push(line);
    return true;
  };
  if (!push(`Purpose: ${charter.purpose}`)) {
    lines.push(`Purpose: ${charter.purpose.slice(0, 800)}`);
  }
  if (charter.goals.length > 0 && push("Current goals:")) {
    for (const goal of charter.goals) {
      if (!push(`- ${goal}`)) break;
    }
  }
  if (charter.gaps.length > 0 && push("Known knowledge gaps:")) {
    for (const gap of charter.gaps) {
      if (!push(`- ${gap}`)) break;
    }
  }
  if (lines.length === 0) return null;
  return `${KNOWLEDGE_BANK_BLOCK_HEADER}\n${lines.join("\n")}`;
}
