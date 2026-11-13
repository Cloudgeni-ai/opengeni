// First-message cleanup (1419 to 1422): on a database the previous release
// left, every revision's older First message is joined to its Instructions
// exactly as that release showed them (agentInstructionsWithFirstMessage),
// even past the 20,000-character limit a person can send, and emptied; run as
// the NOSUPERUSER migration owner through FORCE row level security.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentInstructionsWithFirstMessage } from "@opengeni/contracts";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { migrate } from "../src/migrate";

const firstMigration = "1419_agent_revisions_content_bounds_check.sql";
const realDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let owned: OwnerMigratedTestDatabase | null = null;
let prefix: string | null = null;

beforeAll(async () => {
  if (!realDatabase) return;
  owned = await acquireOwnerMigratedTestDatabase("agents-first-message");
  if (!owned) throw new Error("Real PostgreSQL is required for the agents migrations");
  prefix = await mkdtemp(join(tmpdir(), "opengeni-before-first-message-"));
  const source = join(import.meta.dir, "../drizzle");
  for (const name of await readdir(source)) {
    if (name.endsWith(".sql") && name < firstMigration) {
      await copyFile(join(source, name), join(prefix, name));
    }
  }
  await migrate(owned.ownerUrl, undefined, { migrationsDirectory: prefix });
}, 600_000);

afterAll(async () => {
  await owned?.release();
  if (prefix) await rm(prefix, { recursive: true, force: true });
}, 180_000);

describe.skipIf(!realDatabase)("1419 to 1422 agents First-message cleanup", () => {
  test("each older First message joins its Instructions as the previous release showed them", async () => {
    const admin = owned!.admin;
    const accountId = crypto.randomUUID();
    const home = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    await admin`insert into managed_accounts (id, name) values (${accountId}, 'First')`;
    await admin`insert into workspaces (id, account_id, name) values (${home}, ${accountId}, 'W')`;
    const cases: [string, string][] = [
      ["Be brief.", "  Ask which release.\n"],
      ["", " Plan it. "],
      ["Be brief. Ask.", "Ask."],
      ["Line one\n", "Line two"],
      ["Only Instructions.", ""],
      ["Blank first.", " \n\t"],
      // Kept apart by the previous release because joined they pass 20,000.
      ["x".repeat(20_000), "y".repeat(20_000)],
    ];
    await admin`insert into agents (id, account_id, workspace_id, visibility, name, name_key,
        origin, current_revision)
      values (${agentId}, ${accountId}, ${home}, 'workspace', 'Helper', 'helper', 'app',
        ${cases.length})`;
    for (const [index, [instructions, firstMessage]] of cases.entries()) {
      await admin`insert into agent_revisions (agent_id, account_id, workspace_id, revision, name,
          instructions, first_message)
        values (${agentId}, ${accountId}, ${home}, ${index + 1}, 'Helper', ${instructions},
          ${firstMessage})`;
    }

    await migrate(owned!.ownerUrl);

    const rows = await admin<{ revision: number; instructions: string; first_message: string }[]>`
      select revision, instructions, first_message from agent_revisions
      where agent_id = ${agentId} order by revision`;
    expect(rows.map((row) => row.first_message)).toEqual(cases.map(() => ""));
    expect(rows.map((row) => row.instructions)).toEqual(
      cases.map(([instructions, firstMessage]) =>
        agentInstructionsWithFirstMessage(instructions, firstMessage),
      ),
    );
    expect(rows.at(-1)!.instructions.length).toBe(40_022);

    // Only the new bounds remain, validated; they still refuse what neither
    // release can write. FORCE RLS is back.
    const checks = await admin<{ name: string; validated: boolean }[]>`
      select conname as name, convalidated as validated from pg_constraint
      where conrelid = 'agent_revisions'::regclass and contype = 'c' order by conname`;
    expect([...checks]).toEqual([
      { name: "agent_revisions_content_bounds_check", validated: true },
    ]);
    await expect(
      admin`insert into agent_revisions (agent_id, account_id, workspace_id, revision, name,
          instructions)
        values (${agentId}, ${accountId}, ${home}, 99, 'Helper', ${"z".repeat(40_023)})`,
    ).rejects.toThrow(/agent_revisions_content_bounds_check/);
    const unforced = await admin<{ name: string }[]>`
      select relname as name from pg_class
      where relname = 'agent_revisions' and not relforcerowsecurity`;
    expect([...unforced]).toEqual([]);
  }, 600_000);
});
