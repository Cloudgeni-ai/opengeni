import { test, expect } from "bun:test";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  freePort,
} from "@opengeni/testing";
import {
  createDb,
  claimSessionWorkForAttempt,
  applySessionTurnSettlement,
  adoptConnectedMachineSessionBackgroundCommand,
  settleConnectedMachineSessionBackgroundCommand,
  waitForSessionInputWithEvent,
  settleSessionInputWait,
} from "@opengeni/db";
import { createApp } from "../src/app";

test("managed HTTP session retains personal authority across command and timeout successors", async () => {
  const shared = await acquireSharedTestDatabase("api-command-causal-authority");
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  const client = createDb(shared.appUrl);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const noop = async () => undefined;
  const app = createApp({
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    },
    settings: testSettings({
      databaseUrl: shared.appUrl,
      productAccessMode: "managed",
      publicBaseUrl: origin,
      betterAuthSecret: "command-authority-test-secret-32-bytes",
      environmentsEncryptionKey: Buffer.alloc(32, 41).toString("base64"),
    }),
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch });
  let cookie = "";
  const request = (path: string, body?: unknown) =>
    fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const email = `command-${crypto.randomUUID()}@example.test`,
      password = "test-password-only-1234";
    const signup = await request("/v1/auth/sign-up/email", {
      name: "Command owner",
      email,
      password,
    });
    expect(signup.status).toBeLessThan(300);
    await shared.admin`update auth_users set email_verified=true where email=${email}`;
    const signin = await request("/v1/auth/sign-in/email", { email, password, rememberMe: true });
    expect(signin.status).toBe(200);
    cookie = signin.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    expect(cookie.length).toBeGreaterThan(0);
    const onboard = await request("/v1/auth/organization-onboarding", {
      organizationName: "Command authority",
      operationId: crypto.randomUUID(),
    });
    expect(onboard.status).toBe(200);
    const access = await request("/v1/access/me");
    expect(access.status).toBe(200);
    const context = (await access.json()) as {
      defaultAccountId: string;
      defaultWorkspaceId: string;
    };
    await shared.admin`insert into session_tenancy_activations(account_id,activation_version,inventory_digest,parity_digest,activated_by)
      values (${context.defaultAccountId},1,${"a".repeat(64)},${"b".repeat(64)},'command-api-test') on conflict(account_id) do nothing`;
    const workspaceResponse = await request("/v1/workspaces", {
      accountId: context.defaultAccountId,
      name: "Shared command workspace",
    });
    expect(workspaceResponse.status).toBe(201);
    const workspace = (await workspaceResponse.json()) as { id: string };
    const personalSetResponse = await request(
      `/v1/workspaces/${context.defaultWorkspaceId}/variable-sets`,
      {
        scope: "user",
        name: "Personal command fixture",
        variables: [{ name: "FIXTURE_TOKEN", value: "test-only" }],
      },
    );
    expect(personalSetResponse.status).toBe(201);
    const variableSet = (await personalSetResponse.json()) as { id: string };
    const base = `/v1/workspaces/${workspace.id}`;
    for (const kind of ["command", "timeout"] as const) {
      const created = await request(base + "/sessions", {
        initialMessage: `Run ${kind} fixture`,
        sandboxBackend: "none",
        tools: [],
        resources: [],
        variableSetIds: [variableSet.id],
        personalResourceAttachment: {
          mode: "session",
          workspaceSharedAcknowledged: true,
          sharedOutputWarningVersion: 1,
        },
      });
      expect(created.status).toBe(202);
      const session = (await created.json()) as { id: string };
      const claim = async () => {
        const attemptId = crypto.randomUUID();
        const result = await claimSessionWorkForAttempt(client.db, workspace.id, {
          sessionId: session.id,
          workflowId: `session-${session.id}`,
          workflowRunId: crypto.randomUUID(),
          attemptId,
          dispatchId: crypto.randomUUID(),
          trigger: { kind: "next" },
        });
        if (result.action !== "claimed") throw new Error(`expected claim, got ${result.action}`);
        return { ...result, attemptId };
      };
      const initial = await claim();
      const command = {
        accountId: context.defaultAccountId,
        workspaceId: workspace.id,
        sessionId: session.id,
        turnId: initial.turn.id,
        attemptId: initial.attemptId,
        executionGeneration: initial.turn.executionGeneration,
      };
      const provider = {
        commandId: crypto.randomUUID(),
        controlWorkspaceId: workspace.id,
        enrollmentId: crypto.randomUUID(),
        connectionInstanceId: crypto.randomUUID(),
        opId: crypto.randomUUID(),
      };
      if (kind === "command") {
        await adoptConnectedMachineSessionBackgroundCommand(client.db, {
          ...command,
          ...provider,
          command: "printf done",
        });
      } else {
        await waitForSessionInputWithEvent(client.db, workspace.id, session.id, {
          reason: "waiting for command evidence",
          timeoutSeconds: 30,
          command: {
            accountId: context.defaultAccountId,
            operationKey: crypto.randomUUID(),
            actor: {
              type: "agent_attempt",
              sessionId: session.id,
              turnId: initial.turn.id,
              attemptId: initial.attemptId,
              executionGeneration: initial.turn.executionGeneration,
            },
          },
        });
      }
      await applySessionTurnSettlement(client.db, workspace.id, {
        sessionId: session.id,
        turnId: initial.turn.id,
        triggerEventId: initial.turn.triggerEventId,
        attemptId: initial.attemptId,
        turnStatus: "completed",
        sessionStatus: "idle",
        activeTurnId: null,
        events: [{ type: "turn.completed", payload: { reason: "fixture" } }],
      });
      if (kind === "command") {
        await settleConnectedMachineSessionBackgroundCommand(client.db, {
          ...command,
          ...provider,
          outcome: "exited",
          exitCode: 0,
          reason: "done",
        });
      } else {
        await shared.admin`update sessions set input_wait_until=now()-interval '1 second' where id=${session.id}`;
        await settleSessionInputWait(client.db, {
          accountId: context.defaultAccountId,
          workspaceId: workspace.id,
          sessionId: session.id,
          waitTurnId: initial.turn.id,
          disposition: "timeout",
        });
      }
      const successor = await claim();
      expect(successor.turn.initiatingHumanSubjectId).toBe(initial.turn.initiatingHumanSubjectId);
      const [receipt] =
        await shared.admin`select resource_count from session_attempt_personal_resource_admissions where attempt_id=${successor.attemptId}`;
      expect(receipt?.resource_count).toBe(1);
      const visible = await request(base + `/sessions/${session.id}`);
      expect(visible.status).toBe(200);
      expect(await visible.json()).toMatchObject({ id: session.id, status: "running" });
      const events = await request(base + `/sessions/${session.id}/events?limit=1000`);
      expect(events.status).toBe(200);
      const timeline = (await events.json()) as Array<{ type: string; payload: { kind?: string } }>;
      expect(
        timeline.some(
          (event) =>
            event.type === "system.update.pending" &&
            event.payload.kind ===
              (kind === "command" ? "background_command_result" : "session_wait_timeout"),
        ),
      ).toBe(true);
    }
  } finally {
    await server.stop(true);
    await client.close();
    await shared.release();
  }
}, 180_000);
