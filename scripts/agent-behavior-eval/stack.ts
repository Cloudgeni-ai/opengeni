import { randomBytes } from "node:crypto";

import { getSettings, type Settings } from "@opengeni/config";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import type { SessionWorkflowClient } from "@opengeni/core";
import { bootstrapWorkspace, createDb, type Database, type DbClient } from "@opengeni/db";
import { createNatsEventBus, type EventBus } from "@opengeni/events";
import { freePort, startTestServices, type TestServices } from "@opengeni/testing";

import { createApp } from "../../apps/api/src/app";
import { createActivityTestHarness } from "../../apps/worker/src/activities";
import type { ModelEnv } from "./env";

/**
 * The eval stack is the production agent-turn path with a REAL model:
 *
 * - throwaway Postgres + NATS (+ S3-compatible object storage) via
 *   `startTestServices` (Docker), migrated exactly like integration tests;
 * - the real Hono API in-process (session create, events, human input, and the
 *   first-party OpenGeni MCP endpoint the worker's tools call back into);
 * - the real worker activity graph (`runAgentTurn`, `maybeContinueGoal`) with the
 *   production runtime and the configured model provider.
 *
 * Temporal is replaced by `driveSession` (see session.ts): the API's workflow
 * client only records wake/approval signals, and the harness runs the same
 * activities the session workflow would, in order.
 */
export type EvalStack = {
  settings: Settings;
  /** Model-provider env (credentials) — reused by the judge; never logged. */
  modelEnv: ModelEnv;
  db: Database;
  apiBaseUrl: string;
  activities: ReturnType<typeof createActivityTestHarness>;
  approvalSignals: Map<string, string[]>;
  newWorkspace: (label: string) => Promise<EvalWorkspace>;
  close: () => Promise<void>;
};

export type EvalWorkspace = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  authorization: string;
};

const HUMAN_PERMISSIONS: Permission[] = ["workspace:admin"];

export async function startEvalStack(input: {
  modelEnv: ModelEnv;
  model: string;
  reasoningEffort: string;
  log: (line: string) => void;
}): Promise<EvalStack> {
  const started = performance.now();
  const services: TestServices = await startTestServices({ temporal: false, objectStorage: true });
  let dbClient: DbClient | null = null;
  let bus: EventBus | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  try {
    await services.migrate();
    input.log(`stack: services ready in ${Math.round(performance.now() - started)} ms`);
    const apiPort = await freePort();
    const delegationSecret = randomBytes(32).toString("hex");
    const settings = getSettings({
      ...input.modelEnv,
      OPENGENI_ENVIRONMENT: "eval",
      OPENGENI_SERVICE_NAME: "opengeni-behavior-eval",
      OPENGENI_DATABASE_URL: services.databaseUrl,
      OPENGENI_RUNTIME_DATABASE_ROLE: "opengeni_app",
      OPENGENI_NATS_URL: services.natsUrl,
      OPENGENI_API_HOST: "127.0.0.1",
      OPENGENI_API_PORT: String(apiPort),
      OPENGENI_PUBLIC_BASE_URL: `http://127.0.0.1:${apiPort}`,
      OPENGENI_PRODUCT_ACCESS_MODE: "local",
      OPENGENI_DELEGATION_SECRET: delegationSecret,
      OPENGENI_STREAM_TOKEN_SECRET: randomBytes(32).toString("hex"),
      OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      OPENGENI_SANDBOX_BACKEND: "local",
      OPENGENI_SANDBOX_PREPARATION_PROFILES: "none",
      // Production-like sandbox lifecycle (see values.preview-managed.example.yaml):
      // an owned, lazily provisioned box that stays warm across turns.
      OPENGENI_SANDBOX_OWNERSHIP_ENABLED: "true",
      OPENGENI_SANDBOX_LAZY_PROVISION: "true",
      // The fake product MCP servers listen on loopback.
      OPENGENI_INTEGRATIONS_ALLOW_PRIVATE_NETWORK_TARGETS: "true",
      OPENGENI_OPENAI_MODEL: input.model,
      OPENGENI_OPENAI_REASONING_EFFORT: input.reasoningEffort,
      OPENGENI_OBSERVABILITY_METRICS_ENABLED: "false",
      // Variants may send `agent` (legacy sends none, so this does not change it).
      OPENGENI_AGENT_CONFIG_ADMISSION_ENABLED: "true",
      ...(services.objectStorageEndpoint
        ? {
            OPENGENI_OBJECT_STORAGE_BACKEND: "s3-compatible",
            OPENGENI_OBJECT_STORAGE_ENDPOINT: services.objectStorageEndpoint,
            OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT: services.objectStorageEndpoint,
            OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: services.objectStorageAccessKeyId ?? "",
            OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY: services.objectStorageSecretAccessKey ?? "",
          }
        : {}),
    });
    const db = createDb(settings.databaseUrl);
    dbClient = db;
    const eventBus = await createNatsEventBus(settings.natsUrl);
    bus = eventBus;
    const approvalSignals = new Map<string, string[]>();
    const workflowClient: SessionWorkflowClient = {
      signalUserMessage: async () => undefined,
      wakeSessionWorkflow: async () => undefined,
      requestSessionWorkflowWakeDispatch: async () => undefined,
      signalApprovalDecision: async ({ sessionId, eventId }) => {
        const list = approvalSignals.get(sessionId) ?? [];
        list.push(eventId);
        approvalSignals.set(sessionId, list);
      },
      syncScheduledTask: async () => undefined,
      deleteScheduledTaskSchedule: async () => undefined,
      triggerScheduledTask: async () => undefined,
      startRigVerification: async () => undefined,
    };
    const app = createApp({ settings, db: db.db, bus: eventBus, workflowClient });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: apiPort,
      idleTimeout: 255,
      fetch: app.fetch,
    });
    const activities = createActivityTestHarness({ settings, db: db.db, bus: eventBus });
    const activeServer = server;
    const activeDb = db;
    return {
      settings,
      modelEnv: input.modelEnv,
      db: db.db,
      apiBaseUrl: `http://127.0.0.1:${apiPort}`,
      activities,
      approvalSignals,
      newWorkspace: async (label) => {
        const id = crypto.randomUUID();
        const context = await bootstrapWorkspace(db.db, {
          accountExternalSource: "opengeni:behavior-eval",
          accountExternalId: `account:${id}`,
          accountName: `Behavior eval ${label}`,
          workspaceExternalSource: "opengeni:behavior-eval",
          workspaceExternalId: `workspace:${id}`,
          workspaceName: `Behavior eval ${label}`,
          subjectId: `user:eval-${id}`,
          subjectLabel: "Eval user",
        });
        const grant = context.workspaceGrants[0];
        if (!grant) throw new Error("bootstrapWorkspace returned no workspace grant");
        const token = await signDelegatedAccessToken(delegationSecret, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          subjectId: grant.subjectId,
          permissions: HUMAN_PERMISSIONS,
          principalKind: "human_session",
          exp: Math.floor(Date.now() / 1000) + 24 * 3600,
        });
        return {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          subjectId: grant.subjectId,
          authorization: `Bearer ${token}`,
        };
      },
      close: async () => {
        activeServer.stop(true);
        await eventBus.close();
        await activeDb.close();
        await services.down();
      },
    };
  } catch (error) {
    server?.stop(true);
    await bus?.close().catch(() => undefined);
    await dbClient?.close().catch(() => undefined);
    await services.down().catch(() => undefined);
    throw error;
  }
}
