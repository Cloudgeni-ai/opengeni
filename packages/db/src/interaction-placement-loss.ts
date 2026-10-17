import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { type Database, withRlsContext } from "./database";
import {
  advanceWorkspaceInteractionRevision,
  readWorkspaceInteractionRevision,
} from "./interaction-revisions";
import * as schema from "./schema";

export const SOURCE_PLACEMENT_CHANGED = "source_placement_changed";

const CONNECTED_PLACEMENT_LIVE_LIFECYCLES = [
  "starting",
  "active",
  "suspending",
  "restoring",
  "ending",
] as const;

export type TerminalizeStaleConnectedInteractionPlacementResult = {
  sourcePlacementChanged: boolean;
  changed: boolean;
  browserSessionIds: string[];
  computerSessionIds: string[];
  revision: number;
};

/** A browser or Desktop that its source task's move left `lost` while its
 * controller still holds a running generation on the former machine. */
export type LostConnectedInteractionController = {
  resource: "browser_session" | "computer_session";
  resourceId: string;
  connectedSandboxId: string;
  controllerGeneration: string;
  placementInstanceId: string;
};

/** List the resources a source task's move left `lost` on one Connected
 * Machine whose controller binding was never released, so their processes can
 * be ended there. */
export async function listLostConnectedInteractionControllers(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    connectedSandboxId: string;
    browserSessionIds: readonly string[];
    computerSessionIds: readonly string[];
  },
): Promise<LostConnectedInteractionController[]> {
  if (input.browserSessionIds.length === 0 && input.computerSessionIds.length === 0) return [];
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const controllers: LostConnectedInteractionController[] = [];
      if (input.browserSessionIds.length > 0) {
        const rows = await scopedDb
          .select({
            id: schema.browserSessions.id,
            controllerGeneration: schema.browserSessions.controllerGeneration,
            placementInstanceId: schema.browserSessions.placementInstanceId,
          })
          .from(schema.browserSessions)
          .where(
            and(
              eq(schema.browserSessions.accountId, input.accountId),
              eq(schema.browserSessions.workspaceId, input.workspaceId),
              inArray(schema.browserSessions.id, [...input.browserSessionIds]),
              eq(schema.browserSessions.placementKind, "connected_machine"),
              eq(schema.browserSessions.connectedSandboxId, input.connectedSandboxId),
              eq(schema.browserSessions.lifecycle, "lost"),
              eq(schema.browserSessions.failureCode, SOURCE_PLACEMENT_CHANGED),
              isNotNull(schema.browserSessions.controllerGeneration),
            ),
          );
        for (const row of rows) {
          if (!row.controllerGeneration) continue;
          controllers.push({
            resource: "browser_session",
            resourceId: row.id,
            connectedSandboxId: input.connectedSandboxId,
            controllerGeneration: row.controllerGeneration,
            placementInstanceId: row.placementInstanceId ?? input.connectedSandboxId,
          });
        }
      }
      if (input.computerSessionIds.length > 0) {
        const rows = await scopedDb
          .select({
            id: schema.computerSessions.id,
            controllerGeneration: schema.computerSessions.controllerGeneration,
            placementInstanceId: schema.computerSessions.placementInstanceId,
          })
          .from(schema.computerSessions)
          .where(
            and(
              eq(schema.computerSessions.accountId, input.accountId),
              eq(schema.computerSessions.workspaceId, input.workspaceId),
              inArray(schema.computerSessions.id, [...input.computerSessionIds]),
              eq(schema.computerSessions.placementKind, "connected_machine"),
              eq(schema.computerSessions.connectedSandboxId, input.connectedSandboxId),
              eq(schema.computerSessions.lifecycle, "lost"),
              eq(schema.computerSessions.failureCode, SOURCE_PLACEMENT_CHANGED),
              isNotNull(schema.computerSessions.controllerGeneration),
            ),
          );
        for (const row of rows) {
          if (!row.controllerGeneration) continue;
          controllers.push({
            resource: "computer_session",
            resourceId: row.id,
            connectedSandboxId: input.connectedSandboxId,
            controllerGeneration: row.controllerGeneration,
            placementInstanceId: row.placementInstanceId ?? input.connectedSandboxId,
          });
        }
      }
      return controllers;
    },
  );
}

/** Record that the former machine ended this lost resource's exact controller
 * generation. The resource stays `lost` with its failure code; only the
 * binding to processes that no longer exist is released. Returns false when
 * the row no longer holds that generation. */
export async function releaseLostConnectedInteractionController(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    resource: LostConnectedInteractionController["resource"];
    resourceId: string;
    expectedControllerGeneration: string;
  },
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const now = new Date();
        const released =
          input.resource === "browser_session"
            ? await tx
                .update(schema.browserSessions)
                .set({
                  controllerId: null,
                  controllerGeneration: null,
                  placementInstanceId: null,
                  controllerHeartbeatAt: null,
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(schema.browserSessions.workspaceId, input.workspaceId),
                    eq(schema.browserSessions.id, input.resourceId),
                    eq(schema.browserSessions.lifecycle, "lost"),
                    eq(schema.browserSessions.failureCode, SOURCE_PLACEMENT_CHANGED),
                    eq(
                      schema.browserSessions.controllerGeneration,
                      input.expectedControllerGeneration,
                    ),
                  ),
                )
                .returning({ id: schema.browserSessions.id })
            : await tx
                .update(schema.computerSessions)
                .set({
                  controllerId: null,
                  controllerGeneration: null,
                  placementInstanceId: null,
                  controllerHeartbeatAt: null,
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(schema.computerSessions.workspaceId, input.workspaceId),
                    eq(schema.computerSessions.id, input.resourceId),
                    eq(schema.computerSessions.lifecycle, "lost"),
                    eq(schema.computerSessions.failureCode, SOURCE_PLACEMENT_CHANGED),
                    eq(
                      schema.computerSessions.controllerGeneration,
                      input.expectedControllerGeneration,
                    ),
                  ),
                )
                .returning({ id: schema.computerSessions.id });
        if (released.length === 0) return false;
        await advanceWorkspaceInteractionRevision(tx, input.accountId, input.workspaceId);
        return true;
      }),
  );
}

/**
 * Reconcile interaction resources after their source task moves away from a
 * Connected Machine. The source row is the race fence: a stale route lookup
 * may never retire resources while that machine is still the active placement.
 * Browser and Desktop resources are settled together because headed browsers
 * can share one physical controller with a linked Desktop.
 */
export async function terminalizeStaleConnectedInteractionPlacement(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sourceSessionId: string;
    connectedSandboxId: string;
  },
): Promise<TerminalizeStaleConnectedInteractionPlacementResult> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const [source] = await tx
          .select({ activeSandboxId: schema.sessions.activeSandboxId })
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.accountId, input.accountId),
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sourceSessionId),
            ),
          )
          .for("update")
          .limit(1);

        const sourcePlacementChanged =
          source !== undefined && source.activeSandboxId !== input.connectedSandboxId;
        if (!sourcePlacementChanged) {
          return {
            sourcePlacementChanged: false,
            changed: false,
            browserSessionIds: [],
            computerSessionIds: [],
            revision: await readWorkspaceInteractionRevision(tx, input.workspaceId),
          };
        }

        const browserRows = await tx
          .select({ id: schema.browserSessions.id })
          .from(schema.browserSessions)
          .innerJoin(
            schema.browserSessionAssociations,
            and(
              eq(schema.browserSessionAssociations.browserSessionId, schema.browserSessions.id),
              eq(schema.browserSessionAssociations.workspaceId, input.workspaceId),
              eq(schema.browserSessionAssociations.sessionId, input.sourceSessionId),
              eq(schema.browserSessionAssociations.relationship, "created"),
            ),
          )
          .where(
            and(
              eq(schema.browserSessions.accountId, input.accountId),
              eq(schema.browserSessions.workspaceId, input.workspaceId),
              eq(schema.browserSessions.placementKind, "connected_machine"),
              eq(schema.browserSessions.connectedSandboxId, input.connectedSandboxId),
              inArray(schema.browserSessions.lifecycle, [...CONNECTED_PLACEMENT_LIVE_LIFECYCLES]),
            ),
          );
        const computerRows = await tx
          .select({ id: schema.computerSessions.id })
          .from(schema.computerSessions)
          .innerJoin(
            schema.computerSessionAssociations,
            and(
              eq(schema.computerSessionAssociations.computerSessionId, schema.computerSessions.id),
              eq(schema.computerSessionAssociations.workspaceId, input.workspaceId),
              eq(schema.computerSessionAssociations.sessionId, input.sourceSessionId),
              eq(schema.computerSessionAssociations.relationship, "created"),
            ),
          )
          .where(
            and(
              eq(schema.computerSessions.accountId, input.accountId),
              eq(schema.computerSessions.workspaceId, input.workspaceId),
              eq(schema.computerSessions.placementKind, "connected_machine"),
              eq(schema.computerSessions.connectedSandboxId, input.connectedSandboxId),
              inArray(schema.computerSessions.lifecycle, [...CONNECTED_PLACEMENT_LIVE_LIFECYCLES]),
            ),
          );

        const browserSessionIds = [...new Set(browserRows.map((row) => row.id))].sort();
        const computerSessionIds = [...new Set(computerRows.map((row) => row.id))].sort();
        const resourceIds = [...browserSessionIds, ...computerSessionIds];
        if (resourceIds.length === 0) {
          return {
            sourcePlacementChanged: true,
            changed: false,
            browserSessionIds,
            computerSessionIds,
            revision: await readWorkspaceInteractionRevision(tx, input.workspaceId),
          };
        }

        const operationRows = await tx
          .select({ operationId: schema.interactionOperations.operationId })
          .from(schema.interactionOperations)
          .where(
            and(
              eq(schema.interactionOperations.accountId, input.accountId),
              eq(schema.interactionOperations.workspaceId, input.workspaceId),
              inArray(schema.interactionOperations.resourceId, resourceIds),
              inArray(schema.interactionOperations.state, ["prepared", "dispatched"]),
            ),
          );
        const operationIds = operationRows.map((row) => row.operationId).sort();

        // Stable lock order matches the attached-device generation-loss path.
        for (const operationId of operationIds) {
          await tx.execute(sql`
            select operation_id from interaction_operations
            where workspace_id = ${input.workspaceId} and operation_id = ${operationId}
            for update
          `);
        }
        for (const browserSessionId of browserSessionIds) {
          await tx.execute(sql`
            select id from browser_sessions
            where workspace_id = ${input.workspaceId} and id = ${browserSessionId}
            for update
          `);
        }
        for (const computerSessionId of computerSessionIds) {
          await tx.execute(sql`
            select id from computer_sessions
            where workspace_id = ${input.workspaceId} and id = ${computerSessionId}
            for update
          `);
        }

        const now = new Date();
        if (operationIds.length > 0) {
          await tx
            .update(schema.interactionOperations)
            .set({
              state: "outcome_unknown",
              errorCode: "outcome_unknown",
              errorMessage: "The source task moved to another placement",
              errorRetryable: false,
              errorDetails: { reason: SOURCE_PLACEMENT_CHANGED },
              settledAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.interactionOperations.workspaceId, input.workspaceId),
                inArray(schema.interactionOperations.operationId, operationIds),
                inArray(schema.interactionOperations.state, ["prepared", "dispatched"]),
              ),
            );
        }
        if (browserSessionIds.length > 0) {
          await tx
            .update(schema.browserSessions)
            .set({
              lifecycle: "lost",
              failureCode: SOURCE_PLACEMENT_CHANGED,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.browserSessions.workspaceId, input.workspaceId),
                inArray(schema.browserSessions.id, browserSessionIds),
                inArray(schema.browserSessions.lifecycle, [...CONNECTED_PLACEMENT_LIVE_LIFECYCLES]),
              ),
            );
        }
        if (computerSessionIds.length > 0) {
          await tx
            .update(schema.computerSessions)
            .set({
              lifecycle: "lost",
              failureCode: SOURCE_PLACEMENT_CHANGED,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.computerSessions.workspaceId, input.workspaceId),
                inArray(schema.computerSessions.id, computerSessionIds),
                inArray(schema.computerSessions.lifecycle, [
                  ...CONNECTED_PLACEMENT_LIVE_LIFECYCLES,
                ]),
              ),
            );
        }
        const revision = await advanceWorkspaceInteractionRevision(
          tx,
          input.accountId,
          input.workspaceId,
        );
        return {
          sourcePlacementChanged: true,
          changed: true,
          browserSessionIds,
          computerSessionIds,
          revision,
        };
      }),
  );
}
