import { createHash } from "node:crypto";
import {
  classifyLearningRefusal,
  nestedAuthorityRefusalMessage,
  saveKnowledgeEntry,
  setAgentMemoryCollection,
  type AgentRecord,
  type Database,
  type KnowledgeContext,
} from "@opengeni/db";
import { z } from "zod";

type Home = { accountId: string; workspaceId: string };

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The agent's Memory collection, named after it: workspace scope, or personal for Only me. */
export function agentMemoryOperationId(
  agent: Pick<AgentRecord, "id" | "visibility" | "ownerSubjectId">,
): string {
  // A shared agent reuses the id Slack agents always used, so a retry (or an
  // older release) finds the same collection.
  return agent.visibility === "private"
    ? deterministicUuid(`agent-memory:personal:${agent.id}:${agent.ownerSubjectId ?? ""}`)
    : deterministicUuid(`slack-agent-memory:${agent.id}`);
}

/**
 * What happened to an agent's Memory collection: `ready` (it has one),
 * `pending_review` (it waits for review under Review-first), `learning_off`
 * (Agent learning is Off, so none was saved), `not_saved` (the save failed or
 * was refused) or `off` (Memory is off).
 */
export type AgentMemoryStatus = "ready" | "pending_review" | "learning_off" | "not_saved" | "off";

/**
 * Create the agent's Memory collection when Memory is on and it has none.
 * Best effort, like a Slack agent's: a failure leaves Memory without a
 * collection rather than failing the save, and the status says so. Under
 * Review-first the collection itself may wait for review; its id is kept
 * either way.
 *
 * `withKnowledge` runs the save as the caller (a person's request or an
 * agent's chat), with that caller's Knowledge context and row-level security.
 */
export async function ensureAgentMemoryCollection(
  db: Database,
  home: Home,
  agent: AgentRecord,
  withKnowledge: <T>(save: (context: KnowledgeContext) => Promise<T>) => Promise<T>,
): Promise<{ agent: AgentRecord; memory: AgentMemoryStatus }> {
  if (!agent.memoryEnabled) return { agent, memory: "off" };
  if (agent.memoryCollectionId) return { agent, memory: "ready" };
  try {
    const receipt = await withKnowledge((context) =>
      saveKnowledgeEntry(db, context, {
        operationId: agentMemoryOperationId(agent),
        expectedVersion: 0,
        scope: agent.visibility === "private" ? "personal" : "workspace",
        entry: {
          title: agent.name,
          kind: "group",
          content: `Memory of the agent ${agent.name}: lasting facts, decisions and preferences people shared with it.`,
        },
      }),
    );
    const saved = z
      .object({ entryId: z.string().uuid(), outcome: z.string().optional() })
      .safeParse(receipt);
    if (!saved.success) return { agent, memory: "not_saved" };
    if (saved.data.outcome === "rejected" || saved.data.outcome === "archived") {
      return { agent, memory: "not_saved" };
    }
    const updated =
      (await setAgentMemoryCollection(db, home, {
        agentId: agent.id,
        collectionId: saved.data.entryId,
      })) ?? agent;
    return {
      agent: updated,
      memory: saved.data.outcome === "pending" ? "pending_review" : "ready",
    };
  } catch (error) {
    const message = nestedAuthorityRefusalMessage(error);
    const refusal = message ? classifyLearningRefusal({ destination: "knowledge", message }) : null;
    return { agent, memory: refusal?.reason === "learning_off" ? "learning_off" : "not_saved" };
  }
}
