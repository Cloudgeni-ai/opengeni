import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireLease,
  commitWarmingToWarm,
  createDb,
  createSession,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { SandboxChannelAService, type ChannelASession } from "@opengeni/runtime/sandbox";
import { wrapChannelABoxWithRouting } from "../src/sandbox/routing";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-direct-retained-command");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

function terminal(exitCode: number, output = ""): string {
  return `Process exited with code ${exitCode}\n\nOutput:\n${output}`;
}

test("API-direct synchronous and nested commands retain exact custody without false completion input", async () => {
  if (!shared || !client) return;

  const [account] = await shared.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('api-direct-retained-command-test') returning id`;
  if (!account) throw new Error("failed to seed API-direct test account");
  const [workspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account.id}, 'command lifecycle') returning id`;
  if (!workspace) throw new Error("failed to seed API-direct test workspace");
  await shared.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace.id}, ${account.id})`;

  const sandboxGroupId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  await createSession(client.db, {
    requestedSessionId: sessionId,
    accountId: account.id,
    workspaceId: workspace.id,
    initialMessage: "API-direct command lifecycle integration test",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "modal",
    sandboxGroupId,
  });

  const firstRequestId = crypto.randomUUID();
  const firstHolderId = `direct:${firstRequestId}`;
  const initialLease = await acquireLease(client.db, {
    accountId: account.id,
    workspaceId: workspace.id,
    sandboxGroupId,
    kind: "direct",
    holderId: firstHolderId,
    subjectId: sessionId,
    backend: "modal",
    leaseTtlMs: 45_000,
  });
  expect(initialLease.role).toBe("spawner");
  const committed = await commitWarmingToWarm(client.db, {
    accountId: account.id,
    workspaceId: workspace.id,
    sandboxGroupId,
    expectedEpoch: initialLease.lease.leaseEpoch,
    instanceId: "api-direct-retained-command-box",
    resumeBackendId: "modal",
    resumeState: { backendId: "modal", sessionState: {} },
    leaseTtlMs: 45_000,
  });
  if (!committed.committed || !committed.lease) {
    throw new Error("failed to publish API-direct test lease");
  }
  const leaseEpoch = committed.lease.leaseEpoch;

  const importMarkers = new Map<number, string>();
  const stdinPolls = new Map<number, number>();
  const providerSession: ChannelASession & {
    modal: {
      cpClient: { workspaceNameLookup: () => Promise<{ workspaceName: string }> };
      profile: { serverUrl: string };
      environmentName: () => string;
    };
  } = {
    state: { manifest: { root: "/workspace" } },
    modal: {
      cpClient: { workspaceNameLookup: async () => ({ workspaceName: "ope-701-test" }) },
      profile: { serverUrl: "https://modal.test" },
      environmentName: () => "test",
    },
    supportsPty: () => false,
    writePlacementPrivate: async () => undefined,
    deletePlacementPrivate: async () => undefined,
    execCommand: async (args) => {
      const command = (args as { cmd?: string }).cmd ?? "";
      if (command === "ordinary foreground") {
        return "Process running with session ID 82\n\nOutput:\nstarted";
      }
      const importMarker = command.match(/__OPENGENI_WORKSPACE_IMPORT_[a-f0-9]+_OK__/iu)?.[0];
      if (importMarker) {
        importMarkers.set(93, importMarker);
        return "Process running with session ID 93\n\nOutput:\n";
      }
      if (command.includes("base64 -d") && command.includes("inline.txt")) {
        return "Process running with session ID 51\n\nOutput:\n";
      }
      const confinementMarker = command.match(/__OPENGENI_FS_CONFINED_OK__/u)?.[0];
      if (confinementMarker) return terminal(0, confinementMarker);
      return terminal(0);
    },
    writeStdin: async ({ sessionId: providerSessionId }) => {
      const poll = (stdinPolls.get(providerSessionId) ?? 0) + 1;
      stdinPolls.set(providerSessionId, poll);
      if (providerSessionId === 93 && poll === 1) {
        throw new Error("temporary provider observation failure");
      }
      if (providerSessionId === 93) {
        return terminal(0, `${importMarkers.get(93)}\tcreated`);
      }
      return terminal(0, "completed");
    },
  };

  const settings = testSettings({ modalCommandSupervisionEnabled: false });
  const makeRouted = async (requestId: string, holderId: string) => {
    if (requestId !== firstRequestId) {
      const attached = await acquireLease(client!.db, {
        accountId: account.id,
        workspaceId: workspace.id,
        sandboxGroupId,
        kind: "direct",
        holderId,
        subjectId: sessionId,
        backend: "modal",
        leaseTtlMs: 45_000,
      });
      expect(attached.role).toBe("attached");
      expect(attached.lease.leaseEpoch).toBe(leaseEpoch);
    }
    const established = {
      client: {},
      session: providerSession,
      sessionState: {},
      instanceId: "api-direct-retained-command-box",
      backendId: "modal",
    };
    return wrapChannelABoxWithRouting(
      { db: client!.db, settings },
      {
        accountId: account.id,
        workspaceId: workspace.id,
        sessionId,
        resourceSubjectId: "subject-ope-701-test",
        homeLease: {
          sandboxGroupId,
          leaseEpoch,
          instanceId: established.instanceId,
          backend: "modal",
        },
        directRequest: { requestId, holderId },
      },
      established,
    );
  };

  const inlineService = new SandboxChannelAService({
    session: (await makeRouted(firstRequestId, firstHolderId)).session as ChannelASession,
    workspaceRoot: "/workspace",
  });
  await inlineService.fsWrite({
    path: "inline.txt",
    content: "payload",
    overwrite: true,
  });

  const [inlineProcess] = await shared.admin<
    { id: string; state: string; provider_session_id: number; parent_admission_id: string }[]
  >`
    select id, state, provider_session_id, parent_admission_id
    from sandbox_retained_processes
    where workspace_id = ${workspace.id} and session_id = ${sessionId}
      and provider_session_id = 51`;
  expect(inlineProcess).toMatchObject({ state: "exited", provider_session_id: 51 });
  const [inlineBackgroundCount] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from session_background_commands
    where workspace_id = ${workspace.id} and session_id = ${sessionId}`;
  const [inlineCompletionCount] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from session_system_updates
    where workspace_id = ${workspace.id} and session_id = ${sessionId}
      and kind = 'background_command_result'`;
  const [inlineFinishedEventCount] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from session_events
    where workspace_id = ${workspace.id} and session_id = ${sessionId}
      and type = 'session.command.finished'`;
  expect(inlineBackgroundCount?.count).toBe(0);
  expect(inlineCompletionCount?.count).toBe(0);
  expect(inlineFinishedEventCount?.count).toBe(0);

  const ordinaryRequestId = crypto.randomUUID();
  const ordinaryHolderId = `direct:${ordinaryRequestId}`;
  const ordinaryRoute = await makeRouted(ordinaryRequestId, ordinaryHolderId);
  const ordinaryStart = await (ordinaryRoute.session as ChannelASession).execCommand?.({
    cmd: "ordinary foreground",
  });
  expect(ordinaryStart).toContain("Process running with session ID 82");
  const [ordinaryCommand] = await shared.admin<{ id: string; retained_process_id: string }[]>`
    select id, retained_process_id from session_background_commands
    where workspace_id = ${workspace.id} and session_id = ${sessionId}`;
  expect(ordinaryCommand?.retained_process_id).toBeTruthy();
  expect(
    await (
      ordinaryRoute.session as ChannelASession & {
        writeStdinForProcessControl: (input: {
          sessionId: number;
          chars: string;
          yieldTimeMs: number;
        }) => Promise<string>;
      }
    ).writeStdinForProcessControl({ sessionId: 82, chars: "", yieldTimeMs: 1_000 }),
  ).toContain("Process exited with code 0");
  const [ordinaryCompletionCount] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from session_system_updates
    where workspace_id = ${workspace.id} and session_id = ${sessionId}
      and kind = 'background_command_result'`;
  const [ordinaryFinishedEventCount] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from session_events
    where workspace_id = ${workspace.id} and session_id = ${sessionId}
      and type = 'session.command.finished'`;
  expect(ordinaryCompletionCount?.count).toBe(1);
  expect(ordinaryFinishedEventCount?.count).toBe(1);

  const compositeRequestId = crypto.randomUUID();
  const compositeHolderId = `direct:${compositeRequestId}`;
  const compositeRoute = await makeRouted(compositeRequestId, compositeHolderId);
  const compositeService = new SandboxChannelAService({
    session: compositeRoute.session as ChannelASession,
    workspaceRoot: "/workspace",
  });
  await expect(
    compositeService.importWorkspaceFiles([
      {
        operationId: crypto.randomUUID(),
        destinationPath: "imported.txt",
        overwrite: false,
        mayReplaceExisting: false,
        sizeBytes: 1,
        sha256: "0".repeat(64),
        source: {
          url: "https://storage.invalid/signed-object",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    ]),
  ).rejects.toThrow(/unknown|pending|completion/i);

  const admissions = await shared.admin<
    { id: string; operation: string; provider_outcome: string | null; settled_at: Date | null }[]
  >`
    select id, operation, provider_outcome, settled_at
    from sandbox_workspace_mutation_admissions
    where workspace_id = ${workspace.id} and session_id = ${sessionId}
      and actor_kind = 'direct' and actor_id = ${compositeRequestId}
    order by workspace_generation`;
  expect(admissions.map(({ operation }) => operation)).toEqual(["importWorkspaceFiles", "exec"]);
  expect(admissions[0]).toMatchObject({ provider_outcome: "resolved" });
  expect(admissions[0]?.settled_at).toBeInstanceOf(Date);
  expect(admissions[1]).toMatchObject({ provider_outcome: "retained", settled_at: null });

  const [retainedChild] = await shared.admin<
    {
      id: string;
      parent_admission_id: string;
      holder_id: string;
      owner_actor_id: string;
      provider_backend: string;
      provider_instance_id: string;
      lease_epoch: number;
      provider_session_id: number;
      route_kind: string;
      route_target_id: string | null;
      route_epoch: number;
      state: string;
    }[]
  >`
    select id, parent_admission_id, holder_id, owner_actor_id, provider_backend,
      provider_instance_id, lease_epoch, provider_session_id, route_kind, route_target_id,
      route_epoch, state
    from sandbox_retained_processes
    where workspace_id = ${workspace.id} and session_id = ${sessionId}
      and provider_session_id = 93`;
  expect(retainedChild).toMatchObject({
    parent_admission_id: admissions[1]!.id,
    holder_id: "process:" + retainedChild?.id,
    owner_actor_id: compositeRequestId,
    provider_backend: "modal",
    provider_instance_id: "api-direct-retained-command-box",
    lease_epoch: leaseEpoch,
    provider_session_id: 93,
    route_kind: "active",
    route_target_id: null,
    route_epoch: 0,
    state: "active",
  });
  const [processHolderCount] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from sandbox_lease_holders
    where lease_id = (select lease_id from sandbox_retained_processes where id = ${retainedChild?.id})
      and kind = 'process' and holder_id = ${`process:${retainedChild?.id}`}`;
  expect(processHolderCount?.count).toBe(1);

  const [backgroundCountBeforeRecovery] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from session_background_commands
    where workspace_id = ${workspace.id} and session_id = ${sessionId}`;
  expect(backgroundCountBeforeRecovery?.count).toBe(1);

  const recovered = await (
    compositeRoute.session as ChannelASession & {
      writeStdinForProcessControl: (input: {
        sessionId: number;
        chars: string;
        yieldTimeMs: number;
      }) => Promise<string>;
    }
  ).writeStdinForProcessControl({ sessionId: 93, chars: "", yieldTimeMs: 1_000 });
  expect(recovered).toContain("Process exited with code 0");
  const [settledChild] = await shared.admin<
    { state: string; exit_code: number | null; settled_at: Date | null }[]
  >`
    select state, exit_code, settled_at from sandbox_retained_processes where id = ${retainedChild?.id}`;
  expect(settledChild).toMatchObject({ state: "exited", exit_code: 0 });
  expect(settledChild?.settled_at).toBeInstanceOf(Date);
  const [processHolderAfterSettlement] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from sandbox_lease_holders
    where kind = 'process' and holder_id = ${`process:${retainedChild?.id}`}`;
  expect(processHolderAfterSettlement?.count).toBe(0);
  const [backgroundCountAfterRecovery] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from session_background_commands
    where workspace_id = ${workspace.id} and session_id = ${sessionId}`;
  expect(backgroundCountAfterRecovery?.count).toBe(1);
}, 180_000);
