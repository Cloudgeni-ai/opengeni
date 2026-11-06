import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allAccountPermissions,
  allWorkspacePermissions,
  createDb,
  createOrganizationApiKey,
} from "@opengeni/db";
import { createNatsEventBus } from "@opengeni/events";
import { createObjectStorage } from "@opengeni/storage";
import { createProductionAgentRuntime } from "@opengeni/runtime";
import { startTestServices } from "@opengeni/testing/compose";
import { testSettings } from "@opengeni/testing/settings";
import { ScriptedModel, functionCall } from "@opengeni/testing/scripted-model";
import { startTestMcpServer } from "@opengeni/testing/mcp";
import { runCommand } from "@opengeni/testing/process";
import { createApp, type SessionWorkflowClient } from "../../apps/api/src/app";
import { createActivityTestHarness } from "../../apps/worker/src/activities";
import { drainWorkspaceWebhookDeliveries } from "../../apps/api/src/workspace-webhook-dispatch";
import matrix from "./sdk-compatibility/versions.json";

const consumer = new URL("./sdk-compatibility/consumer.ts", import.meta.url);
const noWorkflow = {
  signalUserMessage: async () => {},
  wakeSessionWorkflow: async () => {},
  requestSessionWorkflowWakeDispatch: async () => {},
  signalApprovalDecision: async () => {},
} as SessionWorkflowClient;

describe("published SDK compatibility against the current API", () => {
  let services: Awaited<ReturnType<typeof startTestServices>>;
  let db: ReturnType<typeof createDb>;
  let admin: ReturnType<typeof createDb>;
  let bus: Awaited<ReturnType<typeof createNatsEventBus>>;
  let api: ReturnType<typeof Bun.serve>;
  let settings: ReturnType<typeof testSettings>;

  beforeAll(async () => {
    services = await startTestServices({ temporal: false, objectStorage: true });
    await services.migrate();
    db = createDb(services.runtimeDatabaseUrl, { max: 4, rlsStrategy: "force" });
    admin = createDb(services.databaseUrl, { max: 1 });
    bus = await createNatsEventBus(services.natsUrl);
    settings = testSettings({
      productAccessMode: "managed",
      databaseUrl: services.runtimeDatabaseUrl,
      natsUrl: services.natsUrl,
      sandboxBackend: "docker",
      sandboxOwnershipEnabled: true,
      sandboxLazyProvisionEnabled: true,
      observabilityMetricsEnabled: false,
      environmentsEncryptionKey: Buffer.alloc(32, 19).toString("base64"),
      objectStorageEndpoint: services.objectStorageEndpoint,
      objectStorageAccessKeyId: services.objectStorageAccessKeyId,
      objectStorageSecretAccessKey: services.objectStorageSecretAccessKey,
    });
    const app = createApp({
      settings,
      db: db.db,
      bus,
      workflowClient: noWorkflow,
      managedAuth: null,
      objectStorage: createObjectStorage(settings),
    });
    api = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, fetch: app.fetch });
  }, 240_000);

  afterAll(async () => {
    api?.stop(true);
    await bus?.close();
    await db?.close();
    await admin?.close();
    await services?.down();
  }, 120_000);

  for (const version of ["current", ...matrix.versions.map((entry) => entry.version)]) {
    test(`${version}: tenant, session, stream, approval, callback, files, keys and errors`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "opengeni-sdk-compatibility-"));
      let closeMcp = () => {};
      let closeControl = () => {};
      try {
        const mcpToken = `Bearer compatibility-${crypto.randomUUID()}`;
        const mcp = startTestMcpServer({ requiredAuthorization: mcpToken });
        closeMcp = mcp.close;
        const token = crypto.randomUUID();
        const controlToken = crypto.randomUUID();
        const { sql } = await import("drizzle-orm");
        const accounts = await admin.db.execute(
          sql`insert into managed_accounts (name) values ('SDK compatibility') returning id`,
        );
        const accountId = String(accounts[0]!.id);
        await createOrganizationApiKey(db.db, {
          accountId,
          name: "SDK compatibility",
          prefix: "test",
          keyHash: createHash("sha256").update(token).digest("hex"),
          permissions: [...allAccountPermissions, ...allWorkspacePermissions],
        });
        const model = new ScriptedModel([
          {
            output: [
              functionCall(
                "crm__search_documents",
                { query: "compatibility" },
                "compatibility-approval",
              ),
            ],
          },
          { outputText: "Customer callback completed." },
          { outputText: "Follow-up completed." },
        ]);
        const runtime = createProductionAgentRuntime({ model });
        // Public configuration requires HTTPS. Keep that exact URL in every
        // authority/approval snapshot and substitute only its physical transport.
        const prepareTools = runtime.prepareTools;
        runtime.prepareTools = (runSettings, tools, options) =>
          prepareTools(runSettings, tools, {
            ...options,
            mcpFetchImpl: (input, init) => {
              const request = new Request(input, init);
              if (request.url !== mcp.url.replace("http:", "https:"))
                throw new Error("Unexpected external MCP request");
              return fetch(new Request(mcp.url, request));
            },
          });
        runtime.generateSessionTitle = async () => ({ title: null, usage: null });
        const activities = createActivityTestHarness({ settings, db: db.db, bus, runtime });
        // Only Temporal scheduling is replaced: HTTP admission and the actual
        // production worker activity, persisted approval and tool callback run.
        const control = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          idleTimeout: 120,
          async fetch(request) {
            if (request.headers.get("authorization") !== `Bearer ${controlToken}`)
              return new Response(null, { status: 401 });
            const input = await request.json();
            const result = await activities.runAgentTurn({
              accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              attemptId: crypto.randomUUID(),
              workflowId: crypto.randomUUID(),
              workflowRunId: crypto.randomUUID(),
              trigger: input.eventId
                ? { kind: "approval", triggerEventId: input.eventId }
                : { kind: "next" },
            });
            const webhooks = await drainWorkspaceWebhookDeliveries({ db: db.db, settings });
            return Response.json({ status: result.status, calls: mcp.calls.length, webhooks });
          },
        });
        closeControl = () => control.stop(true);
        await copyFile(consumer, join(directory, "consumer.ts"));
        if (version !== "current") {
          await writeFile(
            join(directory, "package.json"),
            JSON.stringify({
              private: true,
              type: "module",
              dependencies: { "@opengeni/sdk": version },
            }),
          );
          const install = await runCommand(
            [process.execPath, "install", "--ignore-scripts", "--registry", matrix.registry],
            { cwd: directory, timeoutMs: 60_000 },
          );
          expect(
            install.exitCode,
            `[sdk ${version}] npm install: ${install.stdout}\n${install.stderr}`,
          ).toBe(0);
          expect(install.timedOut).toBe(false);
        }
        const result = await runCommand(
          [process.execPath, "--no-env-file", join(directory, "consumer.ts")],
          {
            cwd: directory,
            timeoutMs: 110_000,
            env: {
              ...process.env,
              SDK_COMPATIBILITY_VERSION: version,
              SDK_COMPATIBILITY_MODULE: undefined,
              ...(version === "current"
                ? {
                    SDK_COMPATIBILITY_MODULE: new URL(
                      "../../packages/sdk/src/index.ts",
                      import.meta.url,
                    ).pathname,
                  }
                : {}),
              SDK_COMPATIBILITY_FIXTURE: JSON.stringify({
                baseUrl: api.url.origin,
                token,
                controlUrl: control.url.origin,
                controlToken,
                mcpUrl: mcp.url.replace("http:", "https:"),
                mcpToken,
                permissions: allWorkspacePermissions,
              }),
            },
          },
        );
        console.log(result.stdout);
        expect(result.exitCode, `[sdk ${version}] ${result.stderr}`).toBe(0);
        expect(result.timedOut).toBe(false);
        expect(model.calls).toBe(3);
        expect(mcp.calls).toEqual([{ tool: "search_documents", args: { query: "compatibility" } }]);
      } finally {
        closeControl();
        closeMcp();
        await rm(directory, { recursive: true, force: true });
      }
    }, 180_000);
  }
});
