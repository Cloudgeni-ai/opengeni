import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getSession,
  listSessions,
  type DbClient,
} from "../src/index";

let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-title-control-token-read");
  if (!shared) return;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

describe("stored session titles with leaked model control tokens", () => {
  test("session reads drop the token from automatic titles and keep human titles", async () => {
    const database = shared;
    if (!database) return;

    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `title-token-account-${suffix}`,
      accountName: "Title tokens",
      workspaceExternalSource: "test",
      workspaceExternalId: `title-token-workspace-${suffix}`,
      workspaceName: "Title tokens",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const workspaceId = grant.workspaceId!;
    const newSession = (initialMessage: string) =>
      createSession(client.db, {
        accountId: grant.accountId,
        workspaceId,
        initialMessage,
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
      });
    const legacy = await newSession("phone testing");
    const human = await newSession("literal pipes");

    // Simulate a title written by a title generator before write-time
    // stripping existed; the current write path can no longer produce it.
    await database.admin`alter table sessions disable trigger sessions_automatic_title_policy_v1_fence`;
    try {
      await database.admin`
        update sessions
        set title = 'iPhone Testing<|fim_suffix|>', title_source = 'agent'
        where id = ${legacy.id}
      `;
      await database.admin`
        update sessions
        set title = 'Use a <|pipe|> literally', title_source = 'user'
        where id = ${human.id}
      `;
    } finally {
      await database.admin`alter table sessions enable trigger sessions_automatic_title_policy_v1_fence`;
    }

    expect(await getSession(client.db, workspaceId, legacy.id)).toMatchObject({
      title: "iPhone Testing",
      titleSource: "agent",
    });
    expect(await getSession(client.db, workspaceId, human.id)).toMatchObject({
      title: "Use a <|pipe|> literally",
      titleSource: "user",
    });
    const listed = await listSessions(client.db, workspaceId);
    expect(listed.find((session) => session.id === legacy.id)?.title).toBe("iPhone Testing");

    // Reads never rewrite the durable row.
    const [stored] = await database.admin<Array<{ title: string }>>`
      select title from sessions where id = ${legacy.id}
    `;
    expect(stored?.title).toBe("iPhone Testing<|fim_suffix|>");
  }, 180_000);
});
