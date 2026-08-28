import { createHash, randomUUID } from "node:crypto";
import {
  SITE_SCHEMA_VERSION,
  SiteCapabilityManifest,
  type PublishSiteRequest,
  type ArchiveSiteRequest,
  type RollbackSiteRequest,
  type Site,
  type SiteDetailResponse,
  type SiteEvent,
  type SiteRelease,
  type SiteRuntimeSession,
  type SiteUsageResponse,
} from "@opengeni/contracts";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { Database } from "./database";
import { withWorkspaceRls } from "./database";
import * as schema from "./schema";

type SiteRow = typeof schema.workspaceSites.$inferSelect;
type ReleaseRow = typeof schema.workspaceSiteReleases.$inferSelect;
type EventRow = typeof schema.workspaceSiteEvents.$inferSelect;
type RuntimeRow = typeof schema.workspaceSiteRuntimeSessions.$inferSelect;

export class SiteNotFoundError extends Error {}
export class SiteConflictError extends Error {}
export class SiteIdempotencyError extends Error {}
export class SiteInvariantError extends Error {}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function site(row: SiteRow & { slug: string; title: string; description: string | null }): Site {
  return {
    schemaVersion: SITE_SCHEMA_VERSION,
    runtimeKind: "static_spa",
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    artifactId: row.artifactId,
    slug: row.slug,
    title: row.title,
    description: row.description,
    status: row.status,
    currentReleaseId: row.currentReleaseId,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function release(row: ReleaseRow): SiteRelease {
  return {
    schemaVersion: SITE_SCHEMA_VERSION,
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    siteId: row.siteId,
    artifactVersionId: row.artifactVersionId,
    revision: row.revision,
    manifestHash: row.manifestHash,
    manifest: SiteCapabilityManifest.parse(row.manifest),
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
  };
}

function event(row: EventRow): SiteEvent {
  return {
    schemaVersion: SITE_SCHEMA_VERSION,
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    siteId: row.siteId,
    releaseId: row.releaseId,
    type: row.type,
    actorSubjectId: row.actorSubjectId,
    facts: row.facts,
    createdAt: iso(row.createdAt),
  };
}

function runtime(row: RuntimeRow): SiteRuntimeSession {
  return {
    schemaVersion: SITE_SCHEMA_VERSION,
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    siteId: row.siteId,
    releaseId: row.releaseId,
    sessionId: row.sessionId,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
  };
}

const siteSelection = {
  id: schema.workspaceSites.id,
  accountId: schema.workspaceSites.accountId,
  workspaceId: schema.workspaceSites.workspaceId,
  artifactId: schema.workspaceSites.artifactId,
  status: schema.workspaceSites.status,
  currentReleaseId: schema.workspaceSites.currentReleaseId,
  createdBySubjectId: schema.workspaceSites.createdBySubjectId,
  createdAt: schema.workspaceSites.createdAt,
  updatedAt: schema.workspaceSites.updatedAt,
  slug: schema.workspaceArtifacts.slug,
  title: schema.workspaceArtifacts.title,
  description: schema.workspaceArtifacts.description,
};

export async function listSites(db: Database, workspaceId: string): Promise<Site[]> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) =>
    (
      await scoped
        .select(siteSelection)
        .from(schema.workspaceSites)
        .innerJoin(
          schema.workspaceArtifacts,
          and(
            eq(schema.workspaceArtifacts.workspaceId, schema.workspaceSites.workspaceId),
            eq(schema.workspaceArtifacts.id, schema.workspaceSites.artifactId),
          ),
        )
        .where(eq(schema.workspaceSites.workspaceId, workspaceId))
        .orderBy(desc(schema.workspaceSites.updatedAt), desc(schema.workspaceSites.id))
        .limit(101)
    )
      .slice(0, 100)
      .map(site),
  );
}

export async function getSite(
  db: Database,
  workspaceId: string,
  siteId: string,
): Promise<SiteDetailResponse> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const [siteRow] = await scoped
      .select(siteSelection)
      .from(schema.workspaceSites)
      .innerJoin(
        schema.workspaceArtifacts,
        and(
          eq(schema.workspaceArtifacts.workspaceId, schema.workspaceSites.workspaceId),
          eq(schema.workspaceArtifacts.id, schema.workspaceSites.artifactId),
        ),
      )
      .where(
        and(
          eq(schema.workspaceSites.workspaceId, workspaceId),
          eq(schema.workspaceSites.id, siteId),
        ),
      )
      .limit(1);
    if (!siteRow) throw new SiteNotFoundError("Site not found");
    const [releaseRows, eventRows] = await Promise.all([
      scoped
        .select()
        .from(schema.workspaceSiteReleases)
        .where(
          and(
            eq(schema.workspaceSiteReleases.workspaceId, workspaceId),
            eq(schema.workspaceSiteReleases.siteId, siteId),
          ),
        )
        .orderBy(desc(schema.workspaceSiteReleases.revision))
        .limit(100),
      scoped
        .select()
        .from(schema.workspaceSiteEvents)
        .where(
          and(
            eq(schema.workspaceSiteEvents.workspaceId, workspaceId),
            eq(schema.workspaceSiteEvents.siteId, siteId),
          ),
        )
        .orderBy(desc(schema.workspaceSiteEvents.createdAt))
        .limit(100),
    ]);
    const releases = releaseRows.map(release);
    return {
      site: site(siteRow),
      currentRelease:
        releases.find((candidate) => candidate.id === siteRow.currentReleaseId) ?? null,
      releases,
      events: eventRows.map(event),
    };
  });
}

async function publishInTransaction(
  tx: any,
  input: {
    workspaceId: string;
    actorSubjectId: string;
    request: PublishSiteRequest;
    eventType: "published" | "rolled_back";
  },
): Promise<{ siteId: string; releaseId: string }> {
  const requestHash = digest(input.request);
  const [artifactVersion] = await tx
    .select()
    .from(schema.workspaceArtifactVersions)
    .where(
      and(
        eq(schema.workspaceArtifactVersions.workspaceId, input.workspaceId),
        eq(schema.workspaceArtifactVersions.id, input.request.artifactVersionId),
      ),
    )
    .limit(1);
  if (!artifactVersion)
    throw new SiteInvariantError("Artifact version does not exist in this workspace");
  const siteId = artifactVersion.artifactId;
  const [artifactIdentity] = await tx
    .select()
    .from(schema.workspaceArtifacts)
    .where(
      and(
        eq(schema.workspaceArtifacts.workspaceId, input.workspaceId),
        eq(schema.workspaceArtifacts.id, siteId),
      ),
    )
    .limit(1);
  if (!artifactIdentity) throw new SiteInvariantError("Artifact does not exist in this workspace");
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-site:${input.workspaceId}:${siteId}`}, 0))`,
  );
  const [existing] = await tx
    .select()
    .from(schema.workspaceSites)
    .where(
      and(
        eq(schema.workspaceSites.workspaceId, input.workspaceId),
        eq(schema.workspaceSites.id, siteId),
      ),
    )
    .for("update")
    .limit(1);
  const [replayed] = await tx
    .select()
    .from(schema.workspaceSiteReleases)
    .where(
      and(
        eq(schema.workspaceSiteReleases.siteId, siteId),
        eq(schema.workspaceSiteReleases.operationId, input.request.operationId),
      ),
    )
    .limit(1);
  if (replayed) {
    if (replayed.requestHash !== requestHash)
      throw new SiteIdempotencyError("Site operation id was reused with a different request");
    return { siteId, releaseId: replayed.id };
  }
  const expected = input.request.expectedCurrentReleaseId;
  if ((existing?.currentReleaseId ?? null) !== expected)
    throw new SiteConflictError("Site release changed; reload before publishing");
  if (!existing) {
    await tx.insert(schema.workspaceSites).values({
      id: siteId,
      accountId: artifactIdentity.accountId,
      workspaceId: input.workspaceId,
      artifactId: siteId,
      createdBySubjectId: input.actorSubjectId,
    });
  } else if (existing.status === "archived") {
    throw new SiteInvariantError("Archived Sites cannot be published");
  }
  const [revisionRow] = await tx
    .select({ value: sql<number>`coalesce(max(${schema.workspaceSiteReleases.revision}), 0)::int` })
    .from(schema.workspaceSiteReleases)
    .where(eq(schema.workspaceSiteReleases.siteId, siteId));
  const revision = (revisionRow?.value ?? 0) + 1;
  const manifest = input.request.manifest;
  const [created] = await tx
    .insert(schema.workspaceSiteReleases)
    .values({
      accountId: artifactIdentity.accountId,
      workspaceId: input.workspaceId,
      siteId,
      artifactVersionId: artifactVersion.id,
      operationId: input.request.operationId,
      requestHash,
      revision,
      manifestHash: digest(manifest),
      manifest,
      createdBySubjectId: input.actorSubjectId,
    })
    .returning();
  if (!created) throw new SiteInvariantError("Site release was not created");
  await tx
    .update(schema.workspaceSites)
    .set({ currentReleaseId: created.id, updatedAt: new Date() })
    .where(eq(schema.workspaceSites.id, siteId));
  await tx.insert(schema.workspaceSiteEvents).values({
    accountId: artifactIdentity.accountId,
    workspaceId: input.workspaceId,
    siteId,
    releaseId: created.id,
    operationId: input.request.operationId,
    type: input.eventType,
    actorSubjectId: input.actorSubjectId,
    facts: {
      reason: input.request.reason,
      artifactVersionId: artifactVersion.id,
      manifestHash: created.manifestHash,
    },
  });
  return { siteId, releaseId: created.id };
}

async function mutateSite(
  db: Database,
  input: {
    workspaceId: string;
    actorSubjectId: string;
    request: PublishSiteRequest;
    eventType: "published" | "rolled_back";
  },
) {
  const result = await withWorkspaceRls(db, input.workspaceId, async (scoped) =>
    scoped.transaction((tx) => publishInTransaction(tx, input)),
  );
  const detail = await getSite(db, input.workspaceId, result.siteId);
  return {
    site: detail.site,
    release: detail.releases.find((candidate) => candidate.id === result.releaseId)!,
  };
}

export async function publishSite(
  db: Database,
  input: { workspaceId: string; actorSubjectId: string; request: PublishSiteRequest },
) {
  return await mutateSite(db, { ...input, eventType: "published" });
}

export async function rollbackSite(
  db: Database,
  input: {
    workspaceId: string;
    siteId: string;
    actorSubjectId: string;
    request: RollbackSiteRequest;
  },
) {
  const target = await getSite(db, input.workspaceId, input.siteId);
  const targetRelease = target.releases.find(
    (candidate) => candidate.id === input.request.releaseId,
  );
  if (!targetRelease) throw new SiteNotFoundError("Site release not found");
  return await mutateSite(db, {
    workspaceId: input.workspaceId,
    actorSubjectId: input.actorSubjectId,
    eventType: "rolled_back",
    request: {
      operationId: input.request.operationId,
      expectedCurrentReleaseId: input.request.expectedCurrentReleaseId,
      artifactVersionId: targetRelease.artifactVersionId,
      manifest: targetRelease.manifest,
      reason: input.request.reason,
    },
  });
}

export async function archiveSite(
  db: Database,
  input: {
    workspaceId: string;
    siteId: string;
    actorSubjectId: string;
    request: ArchiveSiteRequest;
  },
): Promise<SiteDetailResponse> {
  await withWorkspaceRls(db, input.workspaceId, async (scoped) =>
    scoped.transaction(async (tx) => {
      const [siteRow] = await tx
        .select()
        .from(schema.workspaceSites)
        .where(
          and(
            eq(schema.workspaceSites.workspaceId, input.workspaceId),
            eq(schema.workspaceSites.id, input.siteId),
          ),
        )
        .for("update")
        .limit(1);
      if (!siteRow) throw new SiteNotFoundError("Site not found");
      const [replayed] = await tx
        .select()
        .from(schema.workspaceSiteEvents)
        .where(
          and(
            eq(schema.workspaceSiteEvents.siteId, input.siteId),
            eq(schema.workspaceSiteEvents.operationId, input.request.operationId),
          ),
        )
        .limit(1);
      if (replayed) {
        if (
          replayed.type !== "archived" ||
          replayed.releaseId !== input.request.expectedCurrentReleaseId ||
          replayed.facts.reason !== input.request.reason
        ) {
          throw new SiteIdempotencyError("Site operation id was reused with a different request");
        }
        return;
      }
      if (siteRow.currentReleaseId !== input.request.expectedCurrentReleaseId) {
        throw new SiteConflictError("Site release changed; reload before archiving");
      }
      if (siteRow.status === "archived") {
        throw new SiteConflictError("Site is already archived");
      }
      await tx
        .update(schema.workspaceSites)
        .set({ status: "archived", updatedAt: new Date() })
        .where(eq(schema.workspaceSites.id, input.siteId));
      await tx.insert(schema.workspaceSiteEvents).values({
        accountId: siteRow.accountId,
        workspaceId: input.workspaceId,
        siteId: input.siteId,
        releaseId: siteRow.currentReleaseId,
        operationId: input.request.operationId,
        type: "archived",
        actorSubjectId: input.actorSubjectId,
        facts: { reason: input.request.reason },
      });
    }),
  );
  return await getSite(db, input.workspaceId, input.siteId);
}

export async function recordSiteRuntimeSession(
  db: Database,
  input: {
    workspaceId: string;
    siteId: string;
    releaseId: string;
    sessionId: string;
    operationId: string;
    request: unknown;
    actorSubjectId: string;
  },
): Promise<SiteRuntimeSession> {
  return await withWorkspaceRls(db, input.workspaceId, async (scoped) =>
    scoped.transaction(async (tx) => {
      const requestHash = digest(input.request);
      const [existing] = await tx
        .select()
        .from(schema.workspaceSiteRuntimeSessions)
        .where(
          and(
            eq(schema.workspaceSiteRuntimeSessions.siteId, input.siteId),
            eq(schema.workspaceSiteRuntimeSessions.operationId, input.operationId),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.requestHash !== requestHash || existing.sessionId !== input.sessionId)
          throw new SiteIdempotencyError(
            "Runtime operation id was reused with a different request",
          );
        return runtime(existing);
      }
      const [siteRow] = await tx
        .select()
        .from(schema.workspaceSites)
        .where(
          and(
            eq(schema.workspaceSites.workspaceId, input.workspaceId),
            eq(schema.workspaceSites.id, input.siteId),
          ),
        )
        .for("update")
        .limit(1);
      if (!siteRow) throw new SiteNotFoundError("Site not found");
      if (siteRow.status !== "active" || siteRow.currentReleaseId !== input.releaseId)
        throw new SiteConflictError("Site release changed before runtime session admission");
      const [created] = await tx
        .insert(schema.workspaceSiteRuntimeSessions)
        .values({
          accountId: siteRow.accountId,
          workspaceId: input.workspaceId,
          siteId: input.siteId,
          releaseId: input.releaseId,
          sessionId: input.sessionId,
          operationId: input.operationId,
          requestHash,
          createdBySubjectId: input.actorSubjectId,
        })
        .returning();
      if (!created) throw new SiteInvariantError("Runtime session was not recorded");
      await tx.insert(schema.workspaceSiteEvents).values({
        accountId: siteRow.accountId,
        workspaceId: input.workspaceId,
        siteId: input.siteId,
        releaseId: input.releaseId,
        operationId: randomUUID(),
        type: "runtime_session_started",
        actorSubjectId: input.actorSubjectId,
        facts: { runtimeSessionId: created.id, sessionId: input.sessionId },
      });
      return runtime(created);
    }),
  );
}

export async function requireSiteRuntimeSession(
  db: Database,
  workspaceId: string,
  siteId: string,
  runtimeSessionId: string,
): Promise<SiteRuntimeSession> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const [row] = await scoped
      .select()
      .from(schema.workspaceSiteRuntimeSessions)
      .where(
        and(
          eq(schema.workspaceSiteRuntimeSessions.workspaceId, workspaceId),
          eq(schema.workspaceSiteRuntimeSessions.siteId, siteId),
          eq(schema.workspaceSiteRuntimeSessions.id, runtimeSessionId),
        ),
      )
      .limit(1);
    if (!row) throw new SiteNotFoundError("Site runtime session not found");
    return runtime(row);
  });
}

export async function getSiteUsage(
  db: Database,
  workspaceId: string,
  siteId: string,
): Promise<SiteUsageResponse> {
  const detail = await getSite(db, workspaceId, siteId);
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const [row] = await scoped
      .select({
        modelCalls: sql<number>`count(${schema.modelCallFacts.id})::int`,
        totalTokens: sql<number>`coalesce(sum(${schema.modelCallFacts.totalTokens}), 0)::bigint`,
        costMicros: sql<number>`coalesce(sum(greatest(${schema.modelCallFacts.pricedCostMicros}, coalesce(${schema.modelCallFacts.estimatedProviderCostMicros}, 0))), 0)::bigint`,
      })
      .from(schema.workspaceSiteRuntimeSessions)
      .leftJoin(
        schema.modelCallFacts,
        and(
          eq(schema.modelCallFacts.workspaceId, schema.workspaceSiteRuntimeSessions.workspaceId),
          eq(schema.modelCallFacts.sessionId, schema.workspaceSiteRuntimeSessions.sessionId),
          gte(schema.modelCallFacts.occurredAt, periodStart),
          lt(schema.modelCallFacts.occurredAt, periodEnd),
        ),
      )
      .where(
        and(
          eq(schema.workspaceSiteRuntimeSessions.workspaceId, workspaceId),
          eq(schema.workspaceSiteRuntimeSessions.siteId, siteId),
        ),
      );
    return {
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      modelCalls: Number(row?.modelCalls ?? 0),
      totalTokens: Number(row?.totalTokens ?? 0),
      costMicros: Number(row?.costMicros ?? 0),
      budgetMicros: detail.currentRelease?.manifest.ai.monthlyBudgetMicros ?? null,
    };
  });
}
