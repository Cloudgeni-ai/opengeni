import { resolveAgentConfig, type SessionToolPolicy, type ToolRef } from "@opengeni/contracts";
import { agentConfigDeploymentPolicy, resolveFirstPartyMcpToolPolicy } from "@opengeni/config";
import { siteSessionOriginFromMetadata, type ApiRouteDeps } from "@opengeni/core";
import { appendSessionEventsWithLockedSessionUpdate, getSiteSqlDatabase } from "@opengeni/db";
import { publishDurableSessionEvents } from "@opengeni/events";
import {
  resolveSiteAgentDataContext,
  SITE_AGENT_DATA_TOOL_PERMISSIONS,
  siteAgentDataToolNames,
  siteAgentInstructions,
} from "./agent-data-tools";
import type { SiteRuntimeHost } from "./runtime";
import type { SiteRuntimeViewer } from "./viewer";
import { sitePublishingError } from "./service";
import { siteSqlOffered } from "../site-sql/gateway";

export const SITE_AGENT_DEFAULTS_VERSION = 1;

/**
 * Before admitting more work, converge pre-redesign published-host sessions to
 * the same Site-local tools as a new conversation. This is a trusted host
 * upgrade, not a caller-controlled tool-policy edit. The route has already
 * checked ownership, current audience, models and the retained connector set;
 * each data-tool execution still resolves the live viewer independently.
 *
 * The session writer lock makes the config, permissions, sandbox, instructions,
 * audit event and completion marker atomic. Failed writes remain retryable.
 * Existing attempts keep their accepted execution policy; no turn is rewritten.
 */
export async function normalizeSiteAgentSession(
  deps: Pick<ApiRouteDeps, "db" | "settings" | "bus" | "objectStorage">,
  host: SiteRuntimeHost,
  viewer: SiteRuntimeViewer,
  sessionId: string,
  retainedToolIds: readonly string[],
): Promise<void> {
  const data = await resolveSiteAgentDataContext(deps, host.scope, sessionId);
  if (
    data.kind !== "site" ||
    data.siteId !== host.site.id ||
    data.viewer.principal !== viewer.principal
  )
    throw sitePublishingError(
      403,
      "forbidden",
      "site_conversation_unavailable",
      "This conversation is not available",
    );
  // Do not turn a transient SQL-metadata read failure into a permanently
  // completed upgrade missing SQL tools. No marker commits on a failed read.
  const sqlEnabled = siteSqlOffered(deps.settings)
    ? (await getSiteSqlDatabase(deps.db, { ...host.scope, siteId: host.site.id }))?.enabled === true
    : false;
  const dataTools = siteAgentDataToolNames({
    viewerKind: viewer.kind,
    siteSql: sqlEnabled,
    allowed: resolveFirstPartyMcpToolPolicy(deps.settings).allowed,
  });
  const config = resolveAgentConfig({
    creator: "api",
    request: {
      capabilities: {
        from: "none",
        humanInput: false,
        skills: false,
        ...(dataTools.length ? { artifacts: true } : {}),
      },
    },
    workspace: { defaults: null, humanInputEnabled: false },
    deployment: agentConfigDeploymentPolicy(deps.settings),
    goal: false,
  }).config;
  const instructions = siteAgentInstructions(
    host,
    viewer,
    dataTools,
    host.publication.agent.instructions,
  );
  const events = await appendSessionEventsWithLockedSessionUpdate(
    deps.db,
    host.scope.workspaceId,
    sessionId,
    (session) => {
      if (
        session.parentSessionId ||
        (session.createdBy.subjectId !== `site:${host.site.id}` &&
          !(viewer.kind === "member" && session.createdBy.kind === "subject" &&
            session.createdBy.subjectId === viewer.subjectId)) ||
        siteSessionOriginFromMetadata(session.metadata)?.siteId !== host.site.id
      )
        throw sitePublishingError(
          403,
          "forbidden",
          "site_conversation_unavailable",
          "This conversation is not available",
        );
      const raw = session.metadata.opengeniPublishedSite;
      const stamp =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      if (stamp.agentDefaultsVersion === SITE_AGENT_DEFAULTS_VERSION) return { events: [] };
      // Never restore workspace defaults or add a newly declared connector to
      // an old conversation. Preserve only its still-authorized exact refs.
      const allowed = new Set(["opengeni", ...retainedToolIds]);
      const tools: ToolRef[] = session.tools.filter((tool) => allowed.has(tool.id));
      const toolPolicy: SessionToolPolicy = {
        mode: "explicit",
        firstPartyMode: "explicit",
        inheritedFromSessionId: null,
      };
      const version = session.toolPolicyVersion + 1;
      return {
        events: [
          {
            type: "session.agent.updated",
            payload: {
              before: session.agent,
              after: config,
              instructionsChanged: session.instructions !== instructions,
              version,
              effectiveFrom: "next_attempt",
              reason: "site_agent_defaults",
              firstPartyMcpTools: dataTools,
              sandboxBackend: "none",
            },
          },
        ],
        update: {
          firstPartyMcpTools: dataTools,
          firstPartyMcpPermissions: [...SITE_AGENT_DATA_TOOL_PERMISSIONS],
          agentConfig: config,
          instructions,
          tools,
          toolPolicy,
          sandboxBackend: "none",
          toolPolicyVersion: version,
          expectedToolPolicyVersion: session.toolPolicyVersion,
          metadata: {
            ...session.metadata,
            opengeniPublishedSite: { ...stamp, agentDefaultsVersion: SITE_AGENT_DEFAULTS_VERSION },
          },
        },
      };
    },
    { activity: "semantic" },
  );
  if (events.length)
    await publishDurableSessionEvents(deps.bus, host.scope.workspaceId, sessionId, events);
}
