import { afterAll, beforeAll, expect, test } from "bun:test";
import { withCodexCatalogProvider } from "@opengeni/config";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  createDb,
  createSession,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  connectSubscriptionCoreCodexConnection,
  encryptEnvironmentValue,
  getSpendableCreditBalance,
  withSessionRlsActorContext,
  type DbClient,
} from "@opengeni/db";
import { checkLimit } from "../src/billing/limits";

const real = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient;
beforeAll(async () => {
  if (!real) return;
  shared = await acquireSharedTestDatabase("codex-accepted-funding");
  if (!shared) throw new Error("real PostgreSQL required");
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

test.skipIf(!real)(
  "private shared-workspace accepted personal v2 funds work with zero deployment credits",
  async () => {
    const user = `funding-${crypto.randomUUID()}`;
    const subject = `user:${user}`;
    const access = await ensureManagedAccessForUser(client.db, {
      userId: user,
      email: `${user}@example.test`,
      name: "Funding fixture",
    });
    const accountId = access.workspaceGrants[0]!.accountId;
    const [membership] = await shared!
      .admin`select id, personal_workspace_id from organization_memberships
    where account_id = ${accountId}::uuid and subject_id = ${subject}`;
    const [workspace] = await shared!.admin`insert into workspaces(account_id, name)
    values (${accountId}::uuid, 'Funding shared') returning id`;
    const workspaceId = workspace!.id as string;
    await shared!
      .admin`insert into workspace_memberships(account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${workspaceId}::uuid, ${subject}, 'owner')`;
    await shared!.admin`insert into workspace_inference_controls(account_id, workspace_id)
    values (${accountId}::uuid, ${workspaceId}::uuid)`;
    const connected = await connectSubscriptionCoreCodexConnection(client.db, {
      accountId,
      workspaceId: membership!.personal_workspace_id,
      subjectId: subject,
      providerAccountId: `team-${user}`,
      providerSubjectId: `person-${user}`,
      credentialEncrypted: encryptEnvironmentValue(
        Buffer.alloc(32, 33),
        JSON.stringify({ access_token: "fixture", refresh_token: "fixture", id_token: "fixture" }),
      ),
      accountEmail: null,
      label: null,
      planType: "pro",
      isFedramp: false,
      expiresAt: new Date(Date.now() + 3600_000),
      lastRefreshAt: new Date(),
      connectedBySubjectId: subject,
    });
    expect(connected.kind).toBe("connected");
    await shared!.admin`update subscription_settings set personal_fallback_allowed = true
    where account_id = ${accountId}::uuid and workspace_id is null`;
    await shared!
      .admin`insert into subscription_person_preferences(account_id, organization_membership_id, personal_fallback_opt_in)
    values (${accountId}::uuid, ${membership!.id}::uuid, true)`;
    const model = "codex/gpt-5.5";
    const settings = withCodexCatalogProvider(
      testSettings({
        codexSubscriptionEnabled: true,
        billingMode: "stripe",
        usageLimitsMode: "managed",
      }),
    );
    expect((await getSpendableCreditBalance(client.db, accountId, model)).balanceMicros).toBe(0);
    const accept = async (initiator: { kind: "subject" | "service"; subjectId: string }) =>
      withSessionRlsActorContext({ subjectId: subject }, async () => {
        const session = await createSession(client.db, {
          accountId,
          workspaceId,
          subjectId: subject,
          initialMessage: "funded",
          resources: [],
          metadata: {},
          model,
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          visibility: "user_private",
          createdBy: { kind: "subject", subjectId: subject },
          createdByContext: {},
        });
        const turn = await enqueueSessionTurn(client.db, {
          accountId,
          workspaceId,
          sessionId: session.id,
          triggerEventId: crypto.randomUUID(),
          temporalWorkflowId: `session-${session.id}`,
          source: "user",
          prompt: "funded",
          resources: [],
          tools: [],
          model,
          reasoningEffort: "medium",
          sandboxBackend: "none",
          metadata: {},
          initiator,
        });
        return { sessionId: session.id, turnId: turn.id };
      });
    const input = {
      accountId,
      workspaceId,
      action: "agent_run:create" as const,
      model,
      quantity: 1,
    };
    expect((await checkLimit({ db: client.db, settings }, input)).allowed).toBe(false);
    const owner = await accept({ kind: "subject", subjectId: subject });
    expect(
      await checkLimit(
        { db: client.db, settings },
        { ...input, acceptedTurn: owner, initiatingHumanSubjectId: subject },
      ),
    ).toEqual({ allowed: true });
    const service = await accept({ kind: "service", subjectId: "service:fixture" });
    expect(
      (await checkLimit({ db: client.db, settings }, { ...input, acceptedTurn: service })).allowed,
    ).toBe(false);
    // A nonowner cannot even insert work into this owner's private session.
    await expect(accept({ kind: "subject", subjectId: "user:not-the-owner" })).rejects.toThrow(
      "Session not found",
    );
  },
  180_000,
);
