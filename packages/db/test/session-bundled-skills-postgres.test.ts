import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createDb,
  createSessionWithIdempotencyKeyResult,
  getSession,
  type DbClient,
  type SessionCreateInput,
} from "../src/index";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const reservedKey = "_opengeni_bundled_skill_ids_v1";

beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_SESSION_BUNDLES_TEST_ADMIN_URL;
  if (adminUrl) {
    await migrate(adminUrl);
    const password = crypto.randomUUID();
    await provisionRoles(adminUrl, { appPassword: password });
    const parsed = new URL(adminUrl);
    const admin = postgres(adminUrl, { max: 2 });
    shared = {
      adminUrl,
      appUrl: `postgres://opengeni_app:${password}@127.0.0.1:${parsed.port || "5432"}${parsed.pathname}`,
      admin,
      release: async () => {
        await admin.end();
      },
    };
  } else shared = await acquireSharedTestDatabase("session-bundled-skills");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1")
    throw new Error("PostgreSQL required");
  if (shared) client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function input(): Promise<SessionCreateInput & { createIdempotencyKey: string }> {
  const id = crypto.randomUUID();
  const grant = (
    await bootstrapWorkspace(client!.db, {
      accountExternalSource: "test",
      accountExternalId: id,
      accountName: "Bundle selection test",
      workspaceExternalSource: "test",
      workspaceExternalId: id,
      workspaceName: "Bundle selection test",
      subjectId: `user:bundle-${id}`,
    })
  ).workspaceGrants[0]!;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    createIdempotencyKey: id,
    initialMessage: "Bundle selection fixture",
    resources: [],
    metadata: {},
    model: "test",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  };
}

describe("bundled Skill selection real PostgreSQL create identity", () => {
  test("roundtrips explicit none, replays exactly, and conflicts on omitted or changed selection", async () => {
    if (!client) return;
    const request = { ...(await input()), bundledSkillIds: [] };
    const first = await createSessionWithIdempotencyKeyResult(client.db, request);
    if (first.denied) throw new Error("Unexpected admission denial");
    expect(first.created).toBe(true);
    expect(first.session.bundledSkillIds).toEqual([]);
    expect(
      (await getSession(client.db, request.workspaceId, first.session.id))!.bundledSkillIds,
    ).toEqual([]);
    const retry = await createSessionWithIdempotencyKeyResult(client.db, request);
    if (retry.denied) throw new Error("Unexpected retry denial");
    expect(retry.created).toBe(false);
    expect(retry.session.id).toBe(first.session.id);
    expect(retry.session.bundledSkillIds).toEqual([]);
    for (const bundledSkillIds of [undefined, ["builtin:opengeni-sites"] as const]) {
      await expect(
        createSessionWithIdempotencyKeyResult(client.db, {
          ...request,
          bundledSkillIds: bundledSkillIds ? [...bundledSkillIds] : undefined,
        }),
      ).rejects.toThrow("Session create idempotency key was reused with a different request");
    }
    const [count] = await shared!
      .admin`SELECT count(*)::int AS count FROM sessions WHERE workspace_id=${request.workspaceId}`;
    expect(count!.count).toBe(1);
  });

  test("typed empty selection replaces spoofed metadata and omitted selection strips it", async () => {
    if (!client) return;
    for (const selection of ["none", "omitted"] as const) {
      const request = {
        ...(await input()),
        ...(selection === "none" ? { bundledSkillIds: [] } : {}),
        metadata: { keep: "ordinary metadata", [reservedKey]: ["builtin:opengeni-sites"] },
      };
      const result = await createSessionWithIdempotencyKeyResult(client.db, request);
      if (result.denied) throw new Error("Unexpected admission denial");
      const expected = selection === "none" ? [] : undefined;
      expect(result.session.bundledSkillIds).toEqual(expected);
      expect(
        (await getSession(client.db, request.workspaceId, result.session.id))!.bundledSkillIds,
      ).toEqual(expected);
      const [row] = await shared!
        .admin`SELECT metadata FROM sessions WHERE id=${result.session.id}`;
      expect(row!.metadata.keep).toBe("ordinary metadata");
      expect(row!.metadata[reservedKey]).toEqual(expected);
      const replay = await createSessionWithIdempotencyKeyResult(client.db, {
        ...request,
        metadata: { [reservedKey]: "invalid spoof" },
      });
      if (replay.denied) throw new Error("Unexpected retry denial");
      expect(replay.created).toBe(false);
      expect(replay.session.bundledSkillIds).toEqual(expected);
      if (selection === "omitted")
        await expect(
          createSessionWithIdempotencyKeyResult(client.db, { ...request, bundledSkillIds: [] }),
        ).rejects.toThrow("Session create idempotency key was reused with a different request");
    }
  });
});
