import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireLease,
  commitWarmingToWarm,
  createDb,
  createSession,
  ensureManagedAccessForUser,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { SandboxChannelAService, type ChannelASession } from "@opengeni/runtime/sandbox";
import { synchronousNativeOutputFixture } from "../../runtime/test/synchronous-output-fixture";
import { wrapChannelABoxWithRouting } from "../src/sandbox/routing";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-direct-agent-initiator");
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

// An agent calls the API with the worker's own signing identity, which owns no
// chat. A write it makes to a private chat's cloud home is the person's who
// started its turn (the request's machine authority), so the private-chat owner
// check passes for the owner and still refuses anyone else.
test("an agent's API-direct write to a private chat's cloud home is admitted for its initiating person", async () => {
  if (!shared || !client) return;
  const ownerUserId = `agent-initiator-${crypto.randomUUID()}`;
  const owner = `user:${ownerUserId}`;
  const stranger = `user:agent-initiator-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId: ownerUserId,
    email: `${ownerUserId}@example.test`,
    name: "Chat owner",
  });
  const grant = access.workspaceGrants.find(
    (candidate) => candidate.workspaceId === access.defaultWorkspaceId,
  );
  if (!grant) throw new Error("owner has no workspace grant");
  const account = { id: grant.accountId };
  const workspace = { id: grant.workspaceId };
  await shared.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${account.id}, 1, ${"3".repeat(64)}, ${"4".repeat(64)}, 'agent-initiator-test')`;
  await shared.admin`
    insert into organization_private_session_settings (
      account_id, enabled, version, updated_by_membership_id
    ) values (${account.id}, true, 1, null)
    on conflict (account_id) do update set enabled = true`;
  const [personal] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account.id}, 'Personal') returning id`;
  await shared.admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${account.id}, ${stranger}, 'member', 'active', ${personal!.id})`;

  // A private chat's singleton sandbox group takes the chat's own id.
  const sessionId = crypto.randomUUID();
  const sandboxGroupId = sessionId;
  await createSession(client.db, {
    requestedSessionId: sessionId,
    accountId: account.id,
    workspaceId: workspace.id,
    initialMessage: "Private chat on a cloud home",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "modal",
    createdBy: { kind: "subject", subjectId: owner },
    subjectId: owner,
    visibility: "user_private",
  } as never);
  const [row] = await shared.admin<{ visibility: string; owner: string | null }[]>`
    select visibility, owner_organization_membership_id as owner from sessions where id = ${sessionId}`;
  expect(row).toMatchObject({ visibility: "user_private" });
  expect(row?.owner).toBeTruthy();

  const firstRequestId = crypto.randomUUID();
  const initialLease = await acquireLease(client.db, {
    accountId: account.id,
    workspaceId: workspace.id,
    sandboxGroupId,
    kind: "direct",
    holderId: `direct:${firstRequestId}`,
    subjectId: sessionId,
    backend: "modal",
    leaseTtlMs: 45_000,
  });
  const committed = await commitWarmingToWarm(client.db, {
    accountId: account.id,
    workspaceId: workspace.id,
    sandboxGroupId,
    expectedEpoch: initialLease.lease.leaseEpoch,
    instanceId: "agent-initiator-box",
    resumeBackendId: "modal",
    resumeState: { backendId: "modal", sessionState: {} },
    leaseTtlMs: 45_000,
  });
  if (!committed.committed || !committed.lease) throw new Error("failed to publish lease");
  const leaseEpoch = committed.lease.leaseEpoch;

  const writes: string[] = [];
  const outputs = new Map<unknown, ReturnType<typeof synchronousNativeOutputFixture>>();
  const providerSession = {
    state: { manifest: { root: "/workspace" } },
    modal: {
      cpClient: { workspaceNameLookup: async () => ({ workspaceName: "agent-initiator" }) },
      profile: { serverUrl: "https://modal.test" },
      environmentName: () => "test",
    },
    supportsPty: () => false,
    writePlacementPrivate: async () => undefined,
    deletePlacementPrivate: async () => undefined,
    getSynchronousCommandOutput: (raw: unknown) =>
      outputs.get(raw)?.getSynchronousCommandOutput(raw) ?? null,
    execCommand: async (args: unknown) => {
      const command = (args as { cmd?: string }).cmd ?? "";
      if (command.includes("base64 -d")) writes.push(command);
      const marker = command.match(/__OPENGENI_FS_CONFINED_OK__/u)?.[0] ?? "";
      const output = synchronousNativeOutputFixture();
      const raw = `Chunk ID: ${crypto.randomUUID()}\nProcess exited with code 0\n\nOutput:\n${marker}`;
      output.record(raw, marker, "", 0);
      outputs.set(raw, output);
      return raw;
    },
    writeStdin: async () => {
      throw new Error("no command is left running");
    },
  } as unknown as ChannelASession;

  const settings = testSettings({ modalCommandSupervisionEnabled: false });
  const write = async (requestId: string, initiator: string | null) => {
    const holderId = `direct:${requestId}`;
    if (requestId !== firstRequestId) {
      await acquireLease(client!.db, {
        accountId: account.id,
        workspaceId: workspace.id,
        sandboxGroupId,
        kind: "direct",
        holderId,
        subjectId: sessionId,
        backend: "modal",
        leaseTtlMs: 45_000,
      });
    }
    const established = {
      client: {},
      session: providerSession,
      sessionState: {},
      instanceId: "agent-initiator-box",
      backendId: "modal",
    };
    const routed = wrapChannelABoxWithRouting(
      { db: client!.db, settings },
      {
        accountId: account.id,
        workspaceId: workspace.id,
        sessionId,
        resourceSubjectId: "worker:first-party-mcp",
        ...(initiator
          ? {
              machineAuthority: async () => ({
                subjectId: initiator,
                personalMachineAttempt: null,
              }),
            }
          : {}),
        homeLease: {
          sandboxGroupId,
          leaseEpoch,
          instanceId: "agent-initiator-box",
          backend: "modal",
        },
        directRequest: { requestId, holderId },
      },
      established,
    );
    await new SandboxChannelAService({
      session: routed.session as ChannelASession,
      workspaceRoot: "/workspace",
    }).fsWrite({ path: `recording-${requestId}.txt`, content: "payload", overwrite: true });
  };

  // The agent's own signing identity owns no chat: refused before any write.
  await expect(write(firstRequestId, null)).rejects.toThrow(/no longer owns this private session/u);
  // Another person cannot write through an agent either.
  await expect(write(crypto.randomUUID(), stranger)).rejects.toThrow(
    /no longer owns this private session/u,
  );
  expect(writes).toHaveLength(0);

  // The owner's agent can.
  await write(crypto.randomUUID(), owner);
  expect(writes).toHaveLength(1);
  const admissions = await shared.admin<{ initiator_subject_id: string }[]>`
    select initiator_subject_id from sandbox_workspace_mutation_admissions
    where workspace_id = ${workspace.id} and session_id = ${sessionId}`;
  expect(admissions.map((admission) => admission.initiator_subject_id)).toEqual([owner]);
}, 60_000);
