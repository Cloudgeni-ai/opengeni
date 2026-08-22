import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  activateCompanyProfileRevision,
  bootstrapWorkspace,
  CompanyProfileOperationReuseError,
  createDb,
  listCompanyProfile,
  proposeCompanyProfile,
  updateCompanyProfile,
  type DbClient,
} from "../src";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("company-profile-agent-proposals");
  if (!shared && requireRealDatabase) {
    throw new Error(
      "[company-profile-agent-proposals] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
  if (!shared) return;
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

const PROPOSAL = {
  identity: "CloudGeni builds OpenGeni, the durable autonomous work platform.",
  mission: "Make long-running agent work dependable for every team.",
  products: [{ key: "opengeni", content: "Autonomous work platform for teams." }],
  customers: [{ key: "platform-teams", content: "Platform teams running agents for days." }],
  goals: [{ key: "simple-brain", content: "Make the agent brain simple and useful." }],
  constraints: [{ key: "no-secrets-in-history", content: "Never rewrite accepted content." }],
};

describe("company profile agent proposals", () => {
  test("records an inactive proposal, replays idempotently, and activates only through an admin", async () => {
    if (!shared || !client) return;
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `company-profile-proposal-${crypto.randomUUID()}`,
      accountName: "Company profile proposal account",
      workspaceExternalSource: "test",
      workspaceExternalId: `company-profile-proposal-workspace-${crypto.randomUUID()}`,
      workspaceName: "Company profile proposal workspace",
      subjectId: "human:profile-admin",
    });
    const grant = access.workspaceGrants[0]!;
    const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId };

    const initial = await updateCompanyProfile(client.db, {
      ...scope,
      profile: {
        identity: "CloudGeni builds OpenGeni.",
        mission: null,
        products: [],
        customers: [],
        goals: [],
        constraints: [],
      },
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      actorSubjectId: "human:profile-admin",
      principalKind: "human_session",
      reason: "Initial profile",
    });
    const initialHead = initial.head!;

    const attemptId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const proposal = await proposeCompanyProfile(client.db, {
      operationId,
      ...scope,
      profile: PROPOSAL,
      actorSubjectId: "worker:agent-attempt",
      sourceId: `agent-attempt:${attemptId}`,
    });
    expect(proposal.outcome).toBe("proposed");
    expect(proposal.revision.intent).toBe("proposal");
    expect(proposal.revision.operationId).toBe(operationId);
    expect(proposal.revision.provenance).toEqual({
      source: "durable_learning",
      sourceId: `agent-attempt:${attemptId}`,
    });
    expect(proposal.revision.supersedesRevisionId).toBe(initialHead.revisionId);
    expect(proposal.revision.createdBySubjectId).toBe("worker:agent-attempt");
    expect(proposal.revision.profile).toEqual(PROPOSAL);

    const afterProposal = await listCompanyProfile(client.db, { ...scope, limit: 50 });
    expect(afterProposal.current).toEqual(initialHead);
    expect(afterProposal.activeRevision?.id).toBe(initialHead.revisionId);
    expect(afterProposal.activationEvents).toHaveLength(1);
    const listed = afterProposal.revisions.find((revision) => revision.id === proposal.revision.id);
    expect(listed?.intent).toBe("proposal");
    expect(listed?.profile).toEqual(PROPOSAL);

    const replay = await proposeCompanyProfile(client.db, {
      operationId,
      ...scope,
      profile: PROPOSAL,
      actorSubjectId: "worker:agent-attempt",
      sourceId: `agent-attempt:${attemptId}`,
    });
    expect(replay.revision.id).toBe(proposal.revision.id);
    expect(
      (await listCompanyProfile(client.db, { ...scope, limit: 50 })).revisions.filter(
        (revision) => revision.intent === "proposal",
      ),
    ).toHaveLength(1);

    await expect(
      proposeCompanyProfile(client.db, {
        operationId,
        ...scope,
        profile: { ...PROPOSAL, mission: "A different mission." },
        actorSubjectId: "worker:agent-attempt",
        sourceId: `agent-attempt:${attemptId}`,
      }),
    ).rejects.toBeInstanceOf(CompanyProfileOperationReuseError);

    const activated = await activateCompanyProfileRevision(client.db, {
      ...scope,
      revisionId: proposal.revision.id,
      expectedCurrentRevisionId: initialHead.revisionId,
      expectedActivationVersion: initialHead.activationVersion,
      actorSubjectId: "human:profile-admin",
      principalKind: "human_session",
      reason: "Activate reviewed agent proposal",
    });
    expect(activated.head?.revisionId).toBe(proposal.revision.id);
    expect(activated.event?.newRevision?.id).toBe(proposal.revision.id);

    const afterActivation = await listCompanyProfile(client.db, { ...scope, limit: 50 });
    expect(afterActivation.current?.revisionId).toBe(proposal.revision.id);
    expect(afterActivation.activeRevision?.profile).toEqual(PROPOSAL);
  });

  test("proposes a first profile when no head exists", async () => {
    if (!shared || !client) return;
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `company-profile-first-proposal-${crypto.randomUUID()}`,
      accountName: "Company profile first proposal account",
      workspaceExternalSource: "test",
      workspaceExternalId: `company-profile-first-proposal-workspace-${crypto.randomUUID()}`,
      workspaceName: "Company profile first proposal workspace",
      subjectId: "human:profile-admin",
    });
    const grant = access.workspaceGrants[0]!;
    const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId };
    const proposal = await proposeCompanyProfile(client.db, {
      operationId: crypto.randomUUID(),
      ...scope,
      profile: PROPOSAL,
      actorSubjectId: "worker:agent-attempt",
      sourceId: `agent-attempt:${crypto.randomUUID()}`,
    });
    expect(proposal.revision.supersedesRevisionId).toBeNull();
    const inventory = await listCompanyProfile(client.db, { ...scope, limit: 50 });
    expect(inventory.current).toBeNull();
    expect(inventory.activeRevision).toBeNull();
    expect(inventory.revisions.map((revision) => revision.intent)).toEqual(["proposal"]);
  });
});
