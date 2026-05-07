import { getSettings } from "@infra-agents/config";
import { createDb } from "@infra-agents/db";
import { createNatsEventBus } from "@infra-agents/events";
import { Connection, Client as TemporalClient } from "@temporalio/client";
import { createApp, type SessionWorkflowClient } from "./app";

export async function createTemporalWorkflowClient(settings: ReturnType<typeof getSettings>): Promise<{
  client: SessionWorkflowClient;
  close: () => Promise<void>;
}> {
  const connection = await Connection.connect({ address: settings.temporalHost });
  const temporal = new TemporalClient({
    connection,
    namespace: settings.temporalNamespace,
  });
  const client: SessionWorkflowClient = {
    startSessionWorkflow: async ({ sessionId, initialEventId, workflowId }) => {
      await temporal.workflow.start("sessionWorkflow", {
        taskQueue: settings.temporalTaskQueue,
        workflowId,
        args: [{ sessionId, initialEventId }],
      });
    },
    signalUserMessage: async ({ eventId, workflowId }) => {
      await temporal.workflow.getHandle(workflowId).signal("userMessage", eventId);
    },
    signalApprovalDecision: async ({ eventId, workflowId }) => {
      await temporal.workflow.getHandle(workflowId).signal("approvalDecision", eventId);
    },
    signalInterrupt: async ({ eventId, workflowId }) => {
      await temporal.workflow.getHandle(workflowId).signal("interrupt", eventId);
    },
  };
  return {
    client,
    close: async () => {
      await connection.close();
    },
  };
}

export async function startApi() {
  const settings = getSettings();
  const dbClient = createDb(settings.databaseUrl);
  const bus = await createNatsEventBus(settings.natsUrl);
  const workflowClient = await createTemporalWorkflowClient(settings);
  const app = createApp({
    settings,
    db: dbClient.db,
    bus,
    workflowClient: workflowClient.client,
  });
  const server = Bun.serve({
    hostname: settings.apiHost,
    port: settings.apiPort,
    fetch: app.fetch,
  });
  console.log(`Infra Agents API listening on http://${settings.apiHost}:${settings.apiPort}`);
  return {
    server,
    close: async () => {
      server.stop(true);
      await Promise.allSettled([
        bus.close(),
        workflowClient.close(),
        dbClient.close(),
      ]);
    },
  };
}

if (import.meta.main) {
  await startApi();
}
