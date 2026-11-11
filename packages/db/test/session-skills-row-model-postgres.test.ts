import { afterAll, beforeAll, expect, test } from "bun:test";
import { getTableColumns } from "drizzle-orm";
import type postgres from "postgres";
import { SessionSkills } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getSession,
  getSessionForSubject,
  getSessionLineage,
  getSessionModelGate,
  listSessionsForSubject,
  withWorkspaceRls,
} from "../src/index";
import * as schema from "../src/schema";
import { lockSessionEventWriteRows } from "../src/session-control";

// A session's Skill folders are its largest value by far (hundreds of KB of
// Markdown when a host attaches its own), stored out of line in TOAST. Only
// readers that return them may detoast them: event-write locks and every
// internal row read select the row without them, and responses that never
// carry them (the compact chat projection) leave them unread.

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-skills-row-model");
  if (!acquired) throw new Error("Real PostgreSQL required");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 1 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

const skills = SessionSkills.parse(
  ["release-notes", "incident-review"].map((name) => ({
    files: [
      {
        path: "SKILL.md",
        content: `---\nname: ${name}\ndescription: Use for ${name}.\n---\n\n# ${name}\n\n${"Step. ".repeat(2_000)}`,
      },
    ],
  })),
);

async function fixture() {
  const id = crypto.randomUUID();
  const grant = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: id,
      accountName: "Skills row model",
      workspaceExternalSource: "test",
      workspaceExternalId: id,
      workspaceName: "Skills row model",
      subjectId: `test:${id}`,
    })
  ).workspaceGrants[0]!;
  const input = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "Skills row model",
    metadata: {},
    resources: [],
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
    skills,
    ownerSubjectId: grant.subjectId,
  };
  const parent = await createSession(client.db, input);
  const child = await createSession(client.db, { ...input, parentSessionId: parent.id });
  return { grant, parent, child };
}

/** Every statement the pool sends while `run` executes. */
async function capture<T>(run: () => Promise<T>): Promise<{ result: T; statements: string[] }> {
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  const prior = driver.options.debug;
  const statements: string[] = [];
  driver.options.debug = (_connection, query) => {
    statements.push(query.replace(/\s+/gu, " "));
  };
  try {
    return { result: await run(), statements };
  } finally {
    driver.options.debug = prior;
  }
}

/** A statement that reads the stored column, as opposed to an empty placeholder. */
const readsStoredSkills = (statement: string) =>
  /\bskills\b/u.test(statement.replace(/'\[\]'::jsonb/gu, ""));

test("the sessions row model has no Skill folders; only their own table object reads them", () => {
  expect(Object.keys(getTableColumns(schema.sessions))).not.toContain("skills");
  expect(getTableColumns(schema.sessionSkillSets).skills.name).toBe("skills");
});

test("creation stores the Skill folders and complete readers return them", async () => {
  const { grant, parent, child } = await fixture();
  expect(parent.skills).toEqual(skills);
  expect(child.skills).toEqual(skills);
  expect((await getSession(client.db, grant.workspaceId, child.id))?.skills).toEqual(skills);
  expect(
    (await getSessionForSubject(client.db, grant.workspaceId, child.id, grant.subjectId))?.skills,
  ).toEqual(skills);
  const page = await listSessionsForSubject(client.db, grant.workspaceId, {
    subjectId: grant.subjectId,
    parentSessionId: null,
  });
  expect(page.sessions.map((session) => session.skills)).toEqual([skills]);
  const lineage = await getSessionLineage(client.db, grant.workspaceId, parent.id);
  expect(lineage?.children.map((node) => node.session.skills)).toEqual([skills]);
});

test("event-write locks never read the Skill folders", async () => {
  const { grant, parent, child } = await fixture();
  const { result, statements } = await capture(() =>
    withWorkspaceRls(client.db, grant.workspaceId, (scopedDb) =>
      scopedDb.transaction(async (tx) =>
        lockSessionEventWriteRows(tx as never, {
          workspaceId: grant.workspaceId,
          controlLock: "none",
          sessionIds: [parent.id, child.id],
        }),
      ),
    ),
  );
  const lock = statements.filter((statement) => /for no key update/iu.test(statement));
  expect(lock.some((statement) => /from "sessions"/u.test(statement))).toBe(true);
  expect(statements.filter(readsStoredSkills)).toEqual([]);
  for (const row of result.sessions.values()) expect(row).not.toHaveProperty("skills");
});

test("the model admission read leaves the Skill folders unread", async () => {
  const { grant, child } = await fixture();
  const { result, statements } = await capture(() =>
    getSessionModelGate(client.db, grant.workspaceId, child.id),
  );
  expect(result?.model).toBe("scripted-model");
  expect(statements.filter(readsStoredSkills)).toEqual([]);
});

test("reads for responses without Skill folders leave them unread and change nothing else", async () => {
  const { grant, parent, child } = await fixture();
  const withoutSkills = <T extends { skills?: unknown }>(session: T) => {
    const { skills: _skills, ...rest } = session;
    return rest;
  };

  const complete = await capture(() =>
    getSessionForSubject(client.db, grant.workspaceId, child.id, grant.subjectId),
  );
  // The detector sees the stored column when a complete read selects it.
  expect(complete.statements.filter(readsStoredSkills)).toHaveLength(1);
  const full = complete.result;
  const single = await capture(() =>
    getSessionForSubject(client.db, grant.workspaceId, child.id, grant.subjectId, "root", "omit"),
  );
  expect(single.statements.filter(readsStoredSkills)).toEqual([]);
  expect(single.result).not.toHaveProperty("skills");
  expect(single.result).toEqual(withoutSkills(full!));

  const options = { subjectId: grant.subjectId, parentSessionId: parent.id };
  const completePage = await capture(() =>
    listSessionsForSubject(client.db, grant.workspaceId, options),
  );
  expect(completePage.statements.filter(readsStoredSkills).length).toBeGreaterThan(0);
  const fullPage = completePage.result;
  const page = await capture(() =>
    listSessionsForSubject(client.db, grant.workspaceId, options, "omit"),
  );
  expect(page.statements.filter(readsStoredSkills)).toEqual([]);
  expect(page.result.sessions.map((session) => session.id)).toEqual([child.id]);
  expect(page.result).toEqual({
    ...fullPage,
    pinned: fullPage.pinned.map(withoutSkills),
    sessions: fullPage.sessions.map(withoutSkills),
  });

  const completeLineage = await capture(() =>
    getSessionLineage(client.db, grant.workspaceId, child.id),
  );
  expect(completeLineage.statements.filter(readsStoredSkills)).toHaveLength(1);
  const fullLineage = completeLineage.result;
  const lineage = await capture(() =>
    getSessionLineage(client.db, grant.workspaceId, child.id, "omit"),
  );
  expect(lineage.statements.filter(readsStoredSkills)).toEqual([]);
  expect(lineage.result?.ancestors.map((session) => session.id)).toEqual([parent.id]);
  expect(lineage.result).toEqual({
    ...fullLineage!,
    ancestors: fullLineage!.ancestors.map(withoutSkills),
  });
});
