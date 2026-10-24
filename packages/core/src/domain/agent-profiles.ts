import { randomUUID } from "node:crypto";
import type {
  AccessGrant,
  AgentProfile,
  AgentProfileConfig,
  ApplySessionAgentProfileRequest,
  Session,
  SessionAgentProfile,
  UpdateSessionAgentIdentityRequest,
} from "@opengeni/contracts";
import {
  getAgentProfile,
  getSessionForSubject,
  sessionAgentProfileFromProfile,
  setSessionAgentProfile,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { requirePermission } from "../access";
import type { ApiRouteDeps } from "../dependencies";
import { setSessionModel, updateSessionAgent } from "./sessions";

// Agent profiles: a saved profile is only a preset. Every path here applies it
// through the ordinary session create/update code, so the caller's own grant
// and the session's ceilings still decide what actually takes effect.

export const AGENT_PROFILES_DISABLED_MESSAGE = "agent profiles are not enabled on this server";

export function requireAgentProfilesEnabled(
  settings: Pick<ApiRouteDeps["settings"], "agentProfilesEnabled">,
  status: 404 | 422 = 404,
): void {
  if (!settings.agentProfilesEnabled) {
    // 404 keeps the profile routes invisible while the feature is off.
    throw new HTTPException(status, {
      message: status === 404 ? "not found" : AGENT_PROFILES_DISABLED_MESSAGE,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Fields a profile contributes to a create request the caller left unset.
 * Explicit request fields always win. A request that sets its own `agent`
 * replaces the profile's agent configuration entirely; a request-level
 * `instructions` keeps precedence over the profile's instructions alias.
 */
export function agentProfileCreateDefaults(
  raw: Record<string, unknown>,
  config: AgentProfileConfig,
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  if (config.agent && raw["agent"] === undefined) {
    const { instructions, ...agent } = config.agent;
    defaults["agent"] = {
      ...agent,
      ...(instructions !== undefined && raw["instructions"] === undefined ? { instructions } : {}),
    };
  }
  if (config.model !== undefined && raw["model"] === undefined) {
    defaults["model"] = config.model;
    // An effort belongs to its model; only carry it with the profile's model.
    if (config.reasoningEffort !== undefined && raw["reasoningEffort"] === undefined) {
      defaults["reasoningEffort"] = config.reasoningEffort;
    }
  }
  if (config.installedSkillIds !== undefined && raw["installedSkillIds"] === undefined) {
    defaults["installedSkillIds"] = config.installedSkillIds;
  }
  if (config.tools !== undefined && raw["tools"] === undefined) {
    defaults["tools"] = config.tools;
  }
  return defaults;
}

/**
 * Expands `agentProfileId` on a raw create payload into the profile's current
 * version before the request is parsed, so profile-supplied fields behave
 * exactly as if the caller had sent them. Returns the identity snapshot the
 * new session wears, or null when no profile was named.
 */
export async function expandCreateSessionPayloadWithAgentProfile(
  deps: Pick<ApiRouteDeps, "db" | "settings">,
  workspaceId: string,
  rawPayload: unknown,
): Promise<{ rawPayload: unknown; agentProfile: SessionAgentProfile | null }> {
  if (!isRecord(rawPayload) || rawPayload["agentProfileId"] === undefined) {
    return { rawPayload, agentProfile: null };
  }
  requireAgentProfilesEnabled(deps.settings, 422);
  const profileId = rawPayload["agentProfileId"];
  if (typeof profileId !== "string" || !/^[\da-f-]{36}$/i.test(profileId)) {
    // Leave shape errors to the contract parser.
    return { rawPayload, agentProfile: null };
  }
  const profile = await getAgentProfile(deps.db, workspaceId, profileId);
  if (!profile || profile.status !== "active") {
    throw new HTTPException(422, { message: `unknown agentProfileId: ${profileId}` });
  }
  return {
    rawPayload: { ...agentProfileCreateDefaults(rawPayload, profile.config), ...rawPayload },
    agentProfile: sessionAgentProfileFromProfile(profile),
  };
}

async function readSession(
  deps: Pick<ApiRouteDeps, "db">,
  grant: AccessGrant,
  sessionId: string,
): Promise<Session> {
  const session = await getSessionForSubject(
    deps.db,
    grant.workspaceId,
    sessionId,
    grant.subjectId,
  );
  if (!session) throw new HTTPException(404, { message: "session not found" });
  return session;
}

/**
 * Names only this chat's agent (Level 1), or clears its identity. Display
 * metadata; the caller's route has already authorized a control write.
 */
export async function updateSessionAgentIdentity(
  deps: Pick<ApiRouteDeps, "db" | "settings">,
  grant: AccessGrant,
  sessionId: string,
  request: UpdateSessionAgentIdentityRequest,
): Promise<Session> {
  requireAgentProfilesEnabled(deps.settings);
  requirePermission(grant, "sessions:control");
  const identity = request.identity;
  const updated = await setSessionAgentProfile(deps.db, {
    workspaceId: grant.workspaceId,
    sessionId,
    agentProfile: identity
      ? {
          profileId: null,
          profileVersion: null,
          name: identity.name,
          role: identity.role ?? null,
          avatar: identity.avatar,
        }
      : null,
  });
  if (!updated) throw new HTTPException(404, { message: "session not found" });
  return await readSession(deps, grant, sessionId);
}

/**
 * Switches a running chat to a saved profile from its next message. The
 * profile's agent configuration goes through `updateSessionAgent` (the same
 * CAS, ceilings and narrowing rules as `PUT .../agent`) and its model through
 * `setSessionModel`; only then does the chat wear the profile's identity.
 * Skills and connector selections stay as the chat has them: they apply when
 * a new chat starts from the profile.
 */
export async function applyAgentProfileToSession(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
  request: ApplySessionAgentProfileRequest,
): Promise<Session> {
  requireAgentProfilesEnabled(deps.settings);
  requirePermission(grant, "sessions:control");
  const profile: AgentProfile | null = await getAgentProfile(
    deps.db,
    grant.workspaceId,
    request.agentProfileId,
  );
  if (!profile || profile.status !== "active") {
    throw new HTTPException(422, { message: `unknown agentProfileId: ${request.agentProfileId}` });
  }
  let session = await readSession(deps, grant, sessionId);
  const agent = profile.config.agent;
  if (agent && Object.keys(agent).length > 0) {
    session = await updateSessionAgent(deps, grant, sessionId, {
      agent,
      expectedVersion: request.expectedVersion,
    });
  } else if ((session.toolPolicyVersion ?? 1) !== request.expectedVersion) {
    throw new HTTPException(409, { message: "session settings changed; refresh and try again" });
  }
  if (profile.config.model !== undefined) {
    const reasoningEffort = profile.config.reasoningEffort ?? session.reasoningEffort ?? "medium";
    if (profile.config.model !== session.model || reasoningEffort !== session.reasoningEffort) {
      await setSessionModel(deps, grant, sessionId, {
        model: profile.config.model,
        reasoningEffort,
        idempotencyKey: randomUUID(),
      });
    }
  }
  const updated = await setSessionAgentProfile(deps.db, {
    workspaceId: grant.workspaceId,
    sessionId,
    agentProfile: sessionAgentProfileFromProfile(profile),
  });
  if (!updated) throw new HTTPException(404, { message: "session not found" });
  return await readSession(deps, grant, sessionId);
}
