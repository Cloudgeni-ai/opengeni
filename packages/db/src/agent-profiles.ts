import type {
  AgentAvatar,
  AgentProfile,
  AgentProfileConfig,
  AgentProfileProposal,
  AgentProfileSessionSummary,
  AgentProfileStatus,
  AgentProfileVersion,
  SessionAgentProfile,
  SessionAgentProfileSuggestion,
} from "@opengeni/contracts";
import { AGENT_PROFILES_PER_WORKSPACE_MAX } from "@opengeni/contracts";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  type Database,
  withRlsContext,
  withWorkspaceRls,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectRls,
} from "./database";
import { nestedPostgresSqlState, safeDatabaseErrorFacts } from "./persistence-errors";
import * as schema from "./schema";

// Agent profiles (migration 0997): named, workspace-shared agent presets.
// Rows hold a configuration preset and display metadata only. Every content
// change appends an immutable version row in the same transaction, so
// `agent_profiles.version` always names the newest `agent_profile_versions` row.

export class AgentProfileNameConflictError extends Error {
  constructor(name: string) {
    super(
      name
        ? `an active agent profile is already named ${name}`
        : "an active agent profile already uses this name",
    );
    this.name = "AgentProfileNameConflictError";
  }
}

export class AgentProfileVersionConflictError extends Error {
  readonly currentVersion: number;
  constructor(currentVersion: number) {
    super(`agent profile changed; current version is ${currentVersion}`);
    this.name = "AgentProfileVersionConflictError";
    this.currentVersion = currentVersion;
  }
}

export class AgentProfileArchivedError extends Error {
  constructor(profileId: string) {
    super(`agent profile is archived: ${profileId}`);
    this.name = "AgentProfileArchivedError";
  }
}

export class AgentProfileLimitError extends Error {
  constructor() {
    super(`a workspace can hold at most ${AGENT_PROFILES_PER_WORKSPACE_MAX} agent profiles`);
    this.name = "AgentProfileLimitError";
  }
}

function isActiveNameUniqueViolation(error: unknown): boolean {
  return (
    nestedPostgresSqlState(error) === "23505" &&
    safeDatabaseErrorFacts(error).constraint === "agent_profiles_workspace_active_name_idx"
  );
}

function mapAgentProfile(row: typeof schema.agentProfiles.$inferSelect): AgentProfile {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    name: row.name,
    role: row.role ?? null,
    avatar: row.avatar,
    config: row.config ?? {},
    version: row.version,
    status: row.status,
    createdBy: row.createdBy ?? null,
    updatedBy: row.updatedBy ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
    homeSessionId: row.homeSessionId ?? null,
  };
}

function mapAgentProfileVersion(
  row: typeof schema.agentProfileVersions.$inferSelect,
): AgentProfileVersion {
  return {
    profileId: row.profileId,
    version: row.version,
    name: row.name,
    role: row.role ?? null,
    avatar: row.avatar,
    config: row.config ?? {},
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The display snapshot a chat wears when it uses this profile version. */
export function sessionAgentProfileFromProfile(
  profile: Pick<AgentProfile, "id" | "version" | "name" | "role" | "avatar">,
): SessionAgentProfile {
  return {
    profileId: profile.id,
    profileVersion: profile.version,
    name: profile.name,
    role: profile.role,
    avatar: profile.avatar,
  };
}

function profileScope(workspaceId: string, profileId: string) {
  return and(
    eq(schema.agentProfiles.workspaceId, workspaceId),
    eq(schema.agentProfiles.id, profileId),
  );
}

export async function listAgentProfiles(
  db: Database,
  workspaceId: string,
  options: { status?: AgentProfileStatus | "all" } = {},
): Promise<AgentProfile[]> {
  const status = options.status ?? "active";
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.agentProfiles)
      .where(
        status === "all"
          ? eq(schema.agentProfiles.workspaceId, workspaceId)
          : and(
              eq(schema.agentProfiles.workspaceId, workspaceId),
              eq(schema.agentProfiles.status, status),
            ),
      )
      .orderBy(asc(sql`lower(${schema.agentProfiles.name})`), asc(schema.agentProfiles.id));
    return rows.map(mapAgentProfile);
  });
}

export async function getAgentProfile(
  db: Database,
  workspaceId: string,
  profileId: string,
): Promise<AgentProfile | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.agentProfiles)
      .where(profileScope(workspaceId, profileId))
      .limit(1);
    return row ? mapAgentProfile(row) : null;
  });
}

export async function listAgentProfileVersions(
  db: Database,
  workspaceId: string,
  profileId: string,
): Promise<AgentProfileVersion[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.agentProfileVersions)
      .where(
        and(
          eq(schema.agentProfileVersions.workspaceId, workspaceId),
          eq(schema.agentProfileVersions.profileId, profileId),
        ),
      )
      .orderBy(desc(schema.agentProfileVersions.version));
    return rows.map(mapAgentProfileVersion);
  });
}

export async function createAgentProfile(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    name: string;
    role?: string | null;
    avatar: AgentAvatar;
    config: AgentProfileConfig;
    createdBy?: string | null;
  },
): Promise<AgentProfile> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      // Serialize creates per workspace so the soft cap cannot be raced past.
      await scopedDb.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`agent-profiles:${input.workspaceId}`}, 0))`,
      );
      const [counted] = await scopedDb
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.agentProfiles)
        .where(eq(schema.agentProfiles.workspaceId, input.workspaceId));
      if ((counted?.count ?? 0) >= AGENT_PROFILES_PER_WORKSPACE_MAX) {
        throw new AgentProfileLimitError();
      }
      try {
        const [row] = await scopedDb
          .insert(schema.agentProfiles)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            name: input.name,
            role: input.role ?? null,
            avatar: input.avatar,
            config: input.config,
            createdBy: input.createdBy ?? null,
            updatedBy: input.createdBy ?? null,
          })
          .returning();
        if (!row) throw new Error("Failed to create agent profile");
        await scopedDb.insert(schema.agentProfileVersions).values({
          profileId: row.id,
          version: row.version,
          accountId: row.accountId,
          workspaceId: row.workspaceId,
          name: row.name,
          role: row.role,
          avatar: row.avatar,
          config: row.config,
          createdBy: input.createdBy ?? null,
        });
        return mapAgentProfile(row);
      } catch (error) {
        if (isActiveNameUniqueViolation(error)) {
          throw new AgentProfileNameConflictError(input.name);
        }
        throw error;
      }
    },
  );
}

/**
 * Replaces the supplied fields under an optimistic version check and appends
 * the new version. An update that changes nothing returns the current profile
 * without a new version. Returns null when the profile does not exist.
 */
export async function updateAgentProfile(
  db: Database,
  input: {
    workspaceId: string;
    profileId: string;
    expectedVersion: number;
    name?: string | undefined;
    role?: string | null | undefined;
    avatar?: AgentAvatar | undefined;
    config?: AgentProfileConfig | undefined;
    updatedBy?: string | null;
  },
): Promise<AgentProfile | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const [current] = await scopedDb
      .select()
      .from(schema.agentProfiles)
      .where(profileScope(input.workspaceId, input.profileId))
      .for("update")
      .limit(1);
    if (!current) return null;
    if (current.status !== "active") throw new AgentProfileArchivedError(input.profileId);
    if (current.version !== input.expectedVersion) {
      throw new AgentProfileVersionConflictError(current.version);
    }
    const next = {
      name: input.name ?? current.name,
      role: input.role !== undefined ? input.role : current.role,
      avatar: input.avatar ?? current.avatar,
      config: input.config ?? current.config,
    };
    const unchanged =
      next.name === current.name &&
      next.role === current.role &&
      stableJson(next.avatar) === stableJson(current.avatar) &&
      stableJson(next.config) === stableJson(current.config);
    if (unchanged) return mapAgentProfile(current);
    try {
      const [row] = await scopedDb
        .update(schema.agentProfiles)
        .set({
          ...next,
          version: current.version + 1,
          updatedBy: input.updatedBy ?? null,
          updatedAt: new Date(),
        })
        .where(profileScope(input.workspaceId, input.profileId))
        .returning();
      if (!row) throw new Error("Failed to update agent profile");
      await scopedDb.insert(schema.agentProfileVersions).values({
        profileId: row.id,
        version: row.version,
        accountId: row.accountId,
        workspaceId: row.workspaceId,
        name: row.name,
        role: row.role,
        avatar: row.avatar,
        config: row.config,
        createdBy: input.updatedBy ?? null,
      });
      return mapAgentProfile(row);
    } catch (error) {
      if (isActiveNameUniqueViolation(error)) {
        throw new AgentProfileNameConflictError(next.name);
      }
      throw error;
    }
  });
}

/**
 * Archives or restores a profile. Archiving hides it from pickers and frees
 * its name; chats that already use it keep their frozen identity. Restoring
 * fails with a name conflict when another active profile took the name.
 */
export async function setAgentProfileStatus(
  db: Database,
  input: {
    workspaceId: string;
    profileId: string;
    status: AgentProfileStatus;
    updatedBy?: string | null;
  },
): Promise<AgentProfile | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    try {
      const [row] = await scopedDb
        .update(schema.agentProfiles)
        .set({
          status: input.status,
          archivedAt:
            input.status === "archived"
              ? sql`coalesce(${schema.agentProfiles.archivedAt}, now())`
              : null,
          updatedBy: input.updatedBy ?? null,
          updatedAt: new Date(),
        })
        .where(profileScope(input.workspaceId, input.profileId))
        .returning();
      return row ? mapAgentProfile(row) : null;
    } catch (error) {
      if (isActiveNameUniqueViolation(error)) {
        throw new AgentProfileNameConflictError("");
      }
      throw error;
    }
  });
}

/**
 * Sets (or clears) the identity a chat's agent wears. Display metadata only:
 * it never changes the session's execution settings.
 */
export async function setSessionAgentProfile(
  db: Database,
  input: { workspaceId: string; sessionId: string; agentProfile: SessionAgentProfile | null },
): Promise<boolean> {
  // Session-row writers require the activity-gated handle (migration 0214's
  // commit gate), exactly like re-filing a session into a channel.
  return await withWorkspaceSessionActivityRls(db, input.workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .update(schema.sessions)
      // Naming updatedAt in the SET list enrolls this row in the commit gate;
      // the self-assignment deliberately preserves the activity sort time.
      .set({ agentProfile: input.agentProfile, updatedAt: sql`${schema.sessions.updatedAt}` })
      .where(
        and(
          eq(schema.sessions.workspaceId, input.workspaceId),
          eq(schema.sessions.id, input.sessionId),
        ),
      )
      .returning({ id: schema.sessions.id });
    return rows.length > 0;
  });
}

/** Records the newest agent-profile suggestion in a chat (display state only). */
export async function setSessionAgentProfileSuggestion(
  db: Database,
  input: {
    workspaceId: string;
    sessionId: string;
    suggestion: SessionAgentProfileSuggestion | null;
  },
): Promise<boolean> {
  return await withWorkspaceSessionActivityRls(db, input.workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .update(schema.sessions)
      .set({
        agentProfileSuggestion: input.suggestion,
        updatedAt: sql`${schema.sessions.updatedAt}`,
      })
      .where(
        and(
          eq(schema.sessions.workspaceId, input.workspaceId),
          eq(schema.sessions.id, input.sessionId),
        ),
      )
      .returning({ id: schema.sessions.id });
    return rows.length > 0;
  });
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
}

// --- Home chat and the agent's chats (migration 0999) ---------------------

export class AgentProfileHomeSessionError extends Error {
  constructor() {
    super("the home chat must be a chat that uses this agent");
    this.name = "AgentProfileHomeSessionError";
  }
}

/**
 * Sets (or clears) an agent's home chat. The chat must already wear this
 * saved agent; the caller has checked that the person can see it.
 */
export async function setAgentProfileHome(
  db: Database,
  input: {
    workspaceId: string;
    profileId: string;
    sessionId: string | null;
    updatedBy?: string | null;
  },
): Promise<AgentProfile | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    if (input.sessionId !== null) {
      const [wearing] = await scopedDb
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.workspaceId, input.workspaceId),
            eq(schema.sessions.id, input.sessionId),
            sql`${schema.sessions.agentProfile} ->> 'profileId' = ${input.profileId}`,
          ),
        )
        .limit(1);
      if (!wearing) throw new AgentProfileHomeSessionError();
    }
    const [row] = await scopedDb
      .update(schema.agentProfiles)
      .set({ homeSessionId: input.sessionId, updatedBy: input.updatedBy ?? null })
      .where(profileScope(input.workspaceId, input.profileId))
      .returning();
    return row ? mapAgentProfile(row) : null;
  });
}

/** Chats that wear this saved agent and that `subjectId` can see, newest first. */
export async function listAgentProfileSessions(
  db: Database,
  input: { workspaceId: string; subjectId: string; profileId: string; limit?: number },
): Promise<AgentProfileSessionSummary[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const rows = await scopedDb
      .select({
        id: schema.sessions.id,
        title: schema.sessions.title,
        status: schema.sessions.status,
        parentSessionId: schema.sessions.parentSessionId,
        agentProfile: schema.sessions.agentProfile,
        createdAt: schema.sessions.createdAt,
        updatedAt: schema.sessions.updatedAt,
      })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, input.workspaceId),
          sql`${schema.sessions.agentProfile} IS NOT NULL`,
          sql`${schema.sessions.agentProfile} ->> 'profileId' = ${input.profileId}`,
        ),
      )
      .orderBy(desc(schema.sessions.updatedAt), asc(schema.sessions.id))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      title: row.title ?? null,
      status: String(row.status),
      parentSessionId: row.parentSessionId ?? null,
      profileVersion: row.agentProfile?.profileVersion ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  });
}

// --- Proposed instruction updates (migration 0999) ------------------------

/** Pending proposals per chat stay bounded: a newer one replaces older ones. */
const PROPOSAL_SUPERSEDED_BY = "superseded";

function mapProposal(row: typeof schema.agentProfileProposals.$inferSelect): AgentProfileProposal {
  return {
    id: row.id,
    profileId: row.profileId,
    baseVersion: row.baseVersion,
    sessionId: row.sessionId,
    proposedBy: row.proposedBy ?? null,
    instructions: row.instructions,
    reason: row.reason,
    status: row.status,
    acceptedVersion: row.acceptedVersion ?? null,
    decidedBy: row.decidedBy ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class AgentProfileProposalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentProfileProposalStateError";
  }
}

/**
 * Records a proposed instruction update from a chat that wears the profile.
 * Any earlier pending proposal from the same chat is dismissed as superseded.
 */
export async function createAgentProfileProposal(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    profileId: string;
    baseVersion: number;
    sessionId: string;
    proposedBy?: string | null;
    instructions: string;
    reason: string;
  },
): Promise<AgentProfileProposal> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await scopedDb
        .update(schema.agentProfileProposals)
        .set({ status: "dismissed", decidedAt: new Date(), decidedBy: PROPOSAL_SUPERSEDED_BY })
        .where(
          and(
            eq(schema.agentProfileProposals.workspaceId, input.workspaceId),
            eq(schema.agentProfileProposals.profileId, input.profileId),
            eq(schema.agentProfileProposals.sessionId, input.sessionId),
            eq(schema.agentProfileProposals.status, "pending"),
          ),
        );
      const [row] = await scopedDb
        .insert(schema.agentProfileProposals)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          profileId: input.profileId,
          baseVersion: input.baseVersion,
          sessionId: input.sessionId,
          proposedBy: input.proposedBy ?? null,
          instructions: input.instructions,
          reason: input.reason,
        })
        .returning();
      if (!row) throw new Error("Failed to record the agent profile proposal");
      return mapProposal(row);
    },
  );
}

/** Proposals for one agent (or one chat) that `subjectId` can see, newest first. */
export async function listAgentProfileProposals(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    profileId: string;
    status?: AgentProfileProposal["status"] | "all";
    sessionId?: string | undefined;
  },
): Promise<AgentProfileProposal[]> {
  const status = input.status ?? "pending";
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.agentProfileProposals)
      .where(
        and(
          eq(schema.agentProfileProposals.workspaceId, input.workspaceId),
          eq(schema.agentProfileProposals.profileId, input.profileId),
          ...(status === "all" ? [] : [eq(schema.agentProfileProposals.status, status)]),
          ...(input.sessionId ? [eq(schema.agentProfileProposals.sessionId, input.sessionId)] : []),
        ),
      )
      .orderBy(desc(schema.agentProfileProposals.createdAt))
      .limit(100);
    return rows.map(mapProposal);
  });
}

/**
 * Accepts a pending proposal: the profile's instructions become the proposed
 * text as a new version, in one transaction with the proposal's decision.
 * `expectedVersion` is the version the person reviewed; a newer profile
 * raises AgentProfileVersionConflictError so nothing is silently overwritten.
 */
export async function acceptAgentProfileProposal(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    profileId: string;
    proposalId: string;
    expectedVersion: number;
    decidedBy?: string | null;
  },
): Promise<{ profile: AgentProfile; proposal: AgentProfileProposal } | null> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const [proposal] = await scopedDb
      .select()
      .from(schema.agentProfileProposals)
      .where(
        and(
          eq(schema.agentProfileProposals.workspaceId, input.workspaceId),
          eq(schema.agentProfileProposals.profileId, input.profileId),
          eq(schema.agentProfileProposals.id, input.proposalId),
        ),
      )
      .for("update")
      .limit(1);
    if (!proposal) return null;
    if (proposal.status !== "pending") {
      throw new AgentProfileProposalStateError(`this proposal was already ${proposal.status}`);
    }
    const [current] = await scopedDb
      .select()
      .from(schema.agentProfiles)
      .where(profileScope(input.workspaceId, input.profileId))
      .for("update")
      .limit(1);
    if (!current) return null;
    if (current.status !== "active") throw new AgentProfileArchivedError(input.profileId);
    if (current.version !== input.expectedVersion) {
      throw new AgentProfileVersionConflictError(current.version);
    }
    const config: AgentProfileConfig = {
      ...current.config,
      agent: { ...current.config.agent, instructions: proposal.instructions },
    };
    const [row] = await scopedDb
      .update(schema.agentProfiles)
      .set({
        config,
        version: current.version + 1,
        updatedBy: input.decidedBy ?? null,
        updatedAt: new Date(),
      })
      .where(profileScope(input.workspaceId, input.profileId))
      .returning();
    if (!row) throw new Error("Failed to update agent profile");
    await scopedDb.insert(schema.agentProfileVersions).values({
      profileId: row.id,
      version: row.version,
      accountId: row.accountId,
      workspaceId: row.workspaceId,
      name: row.name,
      role: row.role,
      avatar: row.avatar,
      config: row.config,
      createdBy: input.decidedBy ?? null,
    });
    const [decided] = await scopedDb
      .update(schema.agentProfileProposals)
      .set({
        status: "accepted",
        acceptedVersion: row.version,
        decidedBy: input.decidedBy ?? null,
        decidedAt: new Date(),
      })
      .where(eq(schema.agentProfileProposals.id, proposal.id))
      .returning();
    return { profile: mapAgentProfile(row), proposal: mapProposal(decided!) };
  });
}

/** Dismisses a pending proposal. Returns null when it does not exist; throws when already decided. */
export async function dismissAgentProfileProposal(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    profileId: string;
    proposalId: string;
    decidedBy?: string | null;
  },
): Promise<AgentProfileProposal | null> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const [row] = await scopedDb
      .update(schema.agentProfileProposals)
      .set({ status: "dismissed", decidedBy: input.decidedBy ?? null, decidedAt: new Date() })
      .where(
        and(
          eq(schema.agentProfileProposals.workspaceId, input.workspaceId),
          eq(schema.agentProfileProposals.profileId, input.profileId),
          eq(schema.agentProfileProposals.id, input.proposalId),
          eq(schema.agentProfileProposals.status, "pending"),
        ),
      )
      .returning();
    if (row) return mapProposal(row);
    const [existing] = await scopedDb
      .select({ status: schema.agentProfileProposals.status })
      .from(schema.agentProfileProposals)
      .where(
        and(
          eq(schema.agentProfileProposals.workspaceId, input.workspaceId),
          eq(schema.agentProfileProposals.profileId, input.profileId),
          eq(schema.agentProfileProposals.id, input.proposalId),
        ),
      )
      .limit(1);
    if (existing) {
      throw new AgentProfileProposalStateError(`this proposal was already ${existing.status}`);
    }
    return null;
  });
}
