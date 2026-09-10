import { SkillActor, type SkillActor as SkillActorType } from "@opengeni/contracts";
import {
  requireResolvedAccessGrantAuthorization,
  type AccessGrantAuthorization,
} from "@opengeni/core";
import { HTTPException } from "hono/http-exception";

/** Use authenticated request provenance, never a caller-supplied actor or subject alone. */
export function skillInstallerActor(access: AccessGrantAuthorization): SkillActorType {
  const grant = requireResolvedAccessGrantAuthorization(access, access.grant.workspaceId);
  const metadata = grant.metadata ?? {};
  const hasAttempt = ["sessionId", "turnId", "attemptId", "executionGeneration"].some(
    (key) => metadata[key] !== undefined,
  );
  if (hasAttempt || grant.principalKind === "agent_attempt") {
    const parsed = SkillActor.safeParse({
      kind: "agent",
      sessionId: metadata.sessionId,
      turnId: metadata.turnId,
      attemptId: metadata.attemptId,
      executionGeneration: metadata.executionGeneration,
    });
    if (!parsed.success)
      throw new HTTPException(403, {
        message: "Skill installation requires complete signed attempt authority.",
      });
    return parsed.data;
  }
  if (
    grant.principalKind === "human_session" &&
    !grant.serviceInitiator &&
    !grant.serviceInitiatorContext &&
    !grant.subjectId.startsWith("api_key:")
  ) {
    return { kind: "human", principalKind: "human_session", subjectId: grant.subjectId };
  }
  if (
    grant.principalKind === "service" ||
    grant.principalKind === "api_key" ||
    grant.principalKind === "configured_key"
  ) {
    return { kind: "service", principalKind: grant.principalKind, subjectId: grant.subjectId };
  }
  throw new HTTPException(403, {
    message:
      "Skill installation requires authenticated human, service, or complete live-attempt authority.",
  });
}

/** Non-Skill component removals remain available to their existing callers. */
export function skillRemovalActor(access: AccessGrantAuthorization): SkillActorType | undefined {
  const grant = requireResolvedAccessGrantAuthorization(access, access.grant.workspaceId);
  if (
    grant.principalKind !== "human_session" ||
    grant.serviceInitiator ||
    grant.serviceInitiatorContext ||
    grant.subjectId.startsWith("api_key:") ||
    ["sessionId", "turnId", "attemptId", "executionGeneration"].some(
      (key) => grant.metadata?.[key] !== undefined,
    )
  )
    return undefined;
  return skillInstallerActor(access);
}
