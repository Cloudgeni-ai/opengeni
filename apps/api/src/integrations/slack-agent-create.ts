/**
 * Creating a Slack agent: the one implementation behind the admin API
 * (`POST /v1/workspaces/:workspaceId/integrations/slack/agents`) and the
 * Create button on a card a chat posted in Slack.
 *
 * Callers decide who may create (a current `workspace:admin` of the target
 * workspace) and pass that person's live grant; everything else is here: the
 * name rules (through the request schema), shared workspaces only, the Slack
 * app being available in the target workspace (`slack_bot_unavailable`), the
 * unique name per installation, and the agent's Memory collection.
 */
import { createHash } from "node:crypto";

import { CreateSlackAgentRequest, slackAgentNameKey, type AccessGrant } from "@opengeni/contracts";
import {
  availableSlackBotConnectionMetadata,
  getSlackAgent,
  getWorkspace,
  insertSlackAgent,
  listSlackInstallationBindings,
  saveKnowledgeEntry,
  setSlackAgentKnowledgeCollection,
  type KnowledgeContext,
  type SlackAgentRecord,
} from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";
import type { z } from "zod";
import { z as zod } from "zod";

import { withAccessGrantSessionRlsContext } from "../access-grant-rls";

export function slackAgentDeterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type SlackInstallationBinding = Awaited<ReturnType<typeof listSlackInstallationBindings>>[number];

export type SlackAgentInstallation = {
  home: { accountId: string; workspaceId: string };
  binding: SlackInstallationBinding;
};

/** The Slack installation a connection is, as seen from a workspace it is available in. */
export async function slackAgentInstallationFor(
  deps: Pick<ApiRouteDeps, "db">,
  scope: { accountId: string; workspaceId: string },
  connectionId: string,
): Promise<SlackAgentInstallation | null> {
  const available = await availableSlackBotConnectionMetadata(deps.db, scope);
  const connection = available.find(
    (candidate) => candidate.id === connectionId && candidate.status === "active",
  );
  if (!connection) return null;
  const home = { accountId: scope.accountId, workspaceId: connection.workspaceId };
  const binding = (await listSlackInstallationBindings(deps.db, home)).find(
    (candidate) => candidate.connectionId === connectionId && candidate.state === "active",
  );
  return binding ? { home, binding } : null;
}

export type CreateSlackAgentOutcome =
  | {
      kind: "created";
      agent: SlackAgentRecord;
      installation: SlackAgentInstallation;
      targetWorkspaceName: string;
    }
  | { kind: "workspace_not_found" }
  | { kind: "personal_workspace" }
  | { kind: "slack_bot_unavailable" }
  | { kind: "name_taken" };

/**
 * Create an agent that works in `grant.workspaceId`.
 *
 * `agentId` makes the create idempotent: a retry finds the agent it already
 * made (and finishes its Memory) instead of failing on the name. The Memory
 * collection is best effort, as before: a failure leaves the agent without
 * Memory rather than failing the create.
 */
export async function createSlackAgent(
  deps: Pick<ApiRouteDeps, "db">,
  input: {
    /** The creator's live grant in the target workspace. */
    grant: AccessGrant;
    request: z.output<typeof CreateSlackAgentRequest>;
    agentId?: string;
    /** The Knowledge context the Memory collection is saved under. */
    memoryContext: () => Promise<KnowledgeContext>;
  },
): Promise<CreateSlackAgentOutcome> {
  const { grant, request } = input;
  const target = await getWorkspace(deps.db, grant.workspaceId);
  if (!target || target.accountId !== grant.accountId) return { kind: "workspace_not_found" };
  if (target.kind === "personal") return { kind: "personal_workspace" };
  const installation = await slackAgentInstallationFor(
    deps,
    { accountId: grant.accountId, workspaceId: grant.workspaceId },
    request.connectionId,
  );
  if (!installation) return { kind: "slack_bot_unavailable" };

  const existing = input.agentId
    ? await getSlackAgent(deps.db, { accountId: grant.accountId, agentId: input.agentId })
    : null;
  let created: SlackAgentRecord;
  if (
    existing &&
    existing.connectionId === request.connectionId &&
    existing.targetWorkspaceId === grant.workspaceId
  ) {
    created = existing;
  } else {
    const inserted = await insertSlackAgent(deps.db, installation.home, {
      ...(input.agentId ? { id: input.agentId } : {}),
      connectionId: request.connectionId,
      slackTeamId: installation.binding.slackTeamId,
      targetAccountId: grant.accountId,
      targetWorkspaceId: grant.workspaceId,
      name: request.name,
      nameKey: slackAgentNameKey(request.name),
      description: request.description,
      avatar: request.avatar,
      instructions: request.instructions,
      createdBySubjectId: grant.subjectId,
    });
    if (inserted === "name_taken") {
      // A second, concurrent create of the same agent id (two clicks on one
      // card) collides on the id, not the name: that agent is this one.
      const raced = input.agentId
        ? await getSlackAgent(deps.db, { accountId: grant.accountId, agentId: input.agentId })
        : null;
      if (
        !raced ||
        raced.connectionId !== request.connectionId ||
        raced.targetWorkspaceId !== grant.workspaceId
      ) {
        return { kind: "name_taken" };
      }
      created = raced;
    } else {
      created = inserted;
    }
  }

  // The agent's Memory: a Knowledge collection in its workspace, named after
  // it. The operation id is fixed per agent, so a retry replays the receipt.
  let agent = created;
  if (!created.knowledgeCollectionId) {
    try {
      const operationId = slackAgentDeterministicUuid(`slack-agent-memory:${created.id}`);
      const receipt = await withAccessGrantSessionRlsContext(deps, grant, async () =>
        saveKnowledgeEntry(deps.db, await input.memoryContext(), {
          operationId,
          expectedVersion: 0,
          scope: "workspace",
          entry: {
            title: created.name,
            kind: "group",
            content: `Memory of the Slack agent ${created.name}: lasting facts, decisions and preferences people shared with it.`,
          },
        }),
      );
      const entryId = zod.object({ entryId: zod.string().uuid() }).safeParse(receipt);
      if (entryId.success) {
        agent =
          (await setSlackAgentKnowledgeCollection(deps.db, installation.home, {
            agentId: created.id,
            knowledgeCollectionId: entryId.data.entryId,
          })) ?? created;
      }
    } catch {
      // Reported by the missing Memory on the agent, not by failing the create.
    }
  }
  return { kind: "created", agent, installation, targetWorkspaceName: target.name };
}
