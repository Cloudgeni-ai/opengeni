/**
 * Activities of `orgAgentPublishMoveWorkflow`: move an organization agent's
 * chats to its newly published version (a publish with "move running chats").
 *
 * Chats are read in batches of `ORG_AGENT_PUBLISH_MOVE_BATCH_SIZE` per
 * workspace, in id order, and each is moved in its own transaction. A chat
 * with a running turn or one waiting on a person (an approval or a question)
 * is deferred: the workflow scans again with backoff until none remain or
 * its time runs out, then counts what is left as failed. A newer publish
 * stops the move (its own operation moves the chats).
 */
import { ORG_AGENT_PUBLISH_MOVE_BATCH_SIZE, type OrgAgentVersionConfig } from "@opengeni/contracts";
import { moveSessionToOrgAgentVersion, parseOrgAgentVersionConfig } from "@opengeni/core";
import {
  listOrgAgentMoveCandidates,
  listOrgAgentMoveWorkspaces,
  listOrgToolServersByKey,
  readOrgAgentPublishedVersion,
  readOrgAgentPublishOperation,
  readOrgAgentVersion,
  updateOrgAgentPublishOperation,
} from "@opengeni/db";
import { recordOrgAgentPublishMove } from "@opengeni/observability";
import type { ControlActivityServices } from "./types";

export type OrgAgentPublishMoveInput = {
  accountId: string;
  agentId: string;
  operationId: string;
};

export type OrgAgentPublishMoveStart =
  | { proceed: false }
  | { proceed: true; toVersion: number; moveRunningChats: boolean };

/** Where a scan continues: the workspace (by index) and the last chat id read there. */
export type OrgAgentPublishMoveCursor = {
  workspaceIndex: number;
  afterSessionId: string | null;
};

export type OrgAgentPublishMoveBatchResult = {
  /** The scan reached the last workspace. */
  done: boolean;
  cursor: OrgAgentPublishMoveCursor;
  moved: number;
  deferred: number;
  failed: number;
  /** A newer publish replaced this one: stop. */
  superseded: boolean;
};

export function createOrgAgentPublishMoveActivities(
  services: () => Promise<ControlActivityServices>,
  options: { batchSize?: number } = {},
) {
  const batchSize = options.batchSize ?? ORG_AGENT_PUBLISH_MOVE_BATCH_SIZE;
  return {
    /** Mark the operation running; nothing to do when it is gone or finished. */
    async beginOrgAgentPublishMove(
      input: OrgAgentPublishMoveInput,
    ): Promise<OrgAgentPublishMoveStart> {
      const { db } = await services();
      const operation = await readOrgAgentPublishOperation(db, input);
      if (
        !operation ||
        operation.agentId !== input.agentId ||
        operation.status === "succeeded" ||
        operation.status === "failed"
      ) {
        return { proceed: false };
      }
      await updateOrgAgentPublishOperation(db, {
        accountId: input.accountId,
        operationId: input.operationId,
        status: "running",
      });
      return {
        proceed: true,
        toVersion: operation.toVersion,
        moveRunningChats: operation.moveRunningChats,
      };
    },

    /** Move one batch of chats (at most `batchSize` read) and return where to continue. */
    async moveOrgAgentChatsBatch(
      input: OrgAgentPublishMoveInput & { toVersion: number; cursor: OrgAgentPublishMoveCursor },
    ): Promise<OrgAgentPublishMoveBatchResult> {
      const { db, bus, observability } = await services();
      const result: OrgAgentPublishMoveBatchResult = {
        done: false,
        cursor: input.cursor,
        moved: 0,
        deferred: 0,
        failed: 0,
        superseded: false,
      };
      const published = await readOrgAgentPublishedVersion(db, input);
      if (published !== input.toVersion) {
        return { ...result, done: true, superseded: true };
      }
      const workspaces = await listOrgAgentMoveWorkspaces(db, input);
      const workspaceId = workspaces[input.cursor.workspaceIndex];
      if (!workspaceId) return { ...result, done: true };
      const to = await readOrgAgentVersion(db, {
        accountId: input.accountId,
        workspaceId: null,
        agentId: input.agentId,
        version: input.toVersion,
      });
      if (!to) return { ...result, done: true, superseded: true };
      const toConfig = parseOrgAgentVersionConfig(to.config);
      const fromConfigs = new Map<number, OrgAgentVersionConfig | null>();
      const fromConfig = async (version: number) => {
        if (!fromConfigs.has(version)) {
          const row = await readOrgAgentVersion(db, {
            accountId: input.accountId,
            workspaceId: null,
            agentId: input.agentId,
            version,
          });
          let config: OrgAgentVersionConfig | null = null;
          try {
            config = row ? parseOrgAgentVersionConfig(row.config) : null;
          } catch {
            config = null;
          }
          fromConfigs.set(version, config);
        }
        return fromConfigs.get(version) ?? null;
      };
      const toolServers = await listOrgToolServersByKey(db, {
        accountId: input.accountId,
        workspaceId: null,
        keys: toConfig.toolServers.map((server) => server.server),
      });
      const candidates = await listOrgAgentMoveCandidates(db, {
        accountId: input.accountId,
        workspaceId,
        agentId: input.agentId,
        toVersion: input.toVersion,
        afterSessionId: input.cursor.afterSessionId,
        limit: batchSize,
      });
      for (const candidate of candidates) {
        if (candidate.busy) {
          result.deferred += 1;
          continue;
        }
        try {
          const outcome = await moveSessionToOrgAgentVersion(
            { db, bus },
            {
              workspaceId,
              sessionId: candidate.sessionId,
              agentId: input.agentId,
              to: { version: input.toVersion, config: toConfig, toolCatalog: to.toolCatalog },
              fromConfig,
              toolServers,
            },
          );
          if (outcome === "moved") result.moved += 1;
          else if (outcome === "deferred") result.deferred += 1;
        } catch (error) {
          result.failed += 1;
          observability.warn("Organization agent chat move failed", {
            sessionId: candidate.sessionId,
            workspaceId,
            error: error instanceof Error ? error.name : "unknown",
          });
        }
      }
      recordOrgAgentPublishMove(observability, "moved", result.moved);
      recordOrgAgentPublishMove(observability, "deferred", result.deferred);
      recordOrgAgentPublishMove(observability, "failed", result.failed);
      if (result.moved > 0 || result.failed > 0) {
        await updateOrgAgentPublishOperation(db, {
          accountId: input.accountId,
          operationId: input.operationId,
          moved: result.moved,
          failed: result.failed,
        });
      }
      const last = candidates[candidates.length - 1];
      result.cursor =
        candidates.length < batchSize || !last
          ? { workspaceIndex: input.cursor.workspaceIndex + 1, afterSessionId: null }
          : { workspaceIndex: input.cursor.workspaceIndex, afterSessionId: last.sessionId };
      result.done = result.cursor.workspaceIndex >= workspaces.length;
      return result;
    },

    /** Finish the operation; chats still deferred when time ran out count as failed. */
    async finishOrgAgentPublishMove(
      input: OrgAgentPublishMoveInput & {
        status: "succeeded" | "failed";
        remainingDeferred: number;
        /** Set when a newer publish took over before this move finished. */
        failureReason?: "superseded";
      },
    ): Promise<void> {
      const { db, observability } = await services();
      await updateOrgAgentPublishOperation(db, {
        accountId: input.accountId,
        operationId: input.operationId,
        status: input.status,
        failed: input.remainingDeferred,
        ...(input.failureReason ? { failureReason: input.failureReason } : {}),
      });
      recordOrgAgentPublishMove(observability, "failed", input.remainingDeferred);
      recordOrgAgentPublishMove(
        observability,
        input.status === "succeeded" ? "operation_succeeded" : "operation_failed",
      );
    },
  };
}
