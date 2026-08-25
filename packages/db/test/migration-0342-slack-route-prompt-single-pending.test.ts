// Migration 0342 keeps one pending Slack route picker per person per
// conversation. The key includes the Slack user on purpose: a shared channel has
// many people in it, and asking one of them must not swallow another's request.
//
// Expiry is deliberately NOT in the predicate, because `now()` is not immutable
// and a partial index cannot call it. A timed-out row is settled `expired` by
// the writer instead, which is what these assertions pin.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { migrate } from "../src/migrate";

const migrationUrl = new URL(
  "../drizzle/0342_slack_route_prompt_single_pending.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

const ACCOUNT = "aaaaaaaa-0342-4342-8342-aaaaaaaaaaaa";
const WORKSPACE = "11111111-0342-4342-8342-111111111111";
const CONNECTION = "33333333-0342-4342-8342-333333333333";

let owned: OwnerMigratedTestDatabase | null = null;

async function insertPrompt(
  database: OwnerMigratedTestDatabase,
  input: { channelId: string; userId: string; status?: string; expiresIn?: string },
): Promise<string | null> {
  const id = crypto.randomUUID();
  try {
    await database.admin.unsafe(`
      insert into slack_route_prompts
        (id, account_id, workspace_id, connection_id, inbox_id, slack_team_id, slack_user_id,
         slack_channel_id, slack_message_ts, provider_event_id, trigger_kind, request_text,
         has_files, message_operation_id, status, expires_at)
      values ('${id}', '${ACCOUNT}', '${WORKSPACE}', '${CONNECTION}', gen_random_uuid(),
              'T0342', '${input.userId}', '${input.channelId}', '1.0',
              '${crypto.randomUUID()}', 'app_mention', 'decide please', false,
              gen_random_uuid(), '${input.status ?? "pending"}',
              now() + interval '${input.expiresIn ?? "1 hour"}')`);
    return id;
  } catch {
    return null;
  }
}

describe("migration 0342 one pending Slack route picker per person", () => {
  beforeAll(async () => {
    owned = await acquireOwnerMigratedTestDatabase("slack-route-pending");
    if (!owned) {
      if (requireRealDatabase) {
        throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but no owner-migrated database was available");
      }
      return;
    }
    await migrate(owned.ownerUrl);
    await owned.admin.unsafe(`
      insert into managed_accounts (id, name) values ('${ACCOUNT}', 'prompts');
      insert into workspaces (id, account_id, name) values
        ('${WORKSPACE}', '${ACCOUNT}', 'Home');
      insert into connections
        (id, account_id, workspace_id, provider_domain, kind, status, credential_encrypted)
        values ('${CONNECTION}', '${ACCOUNT}', '${WORKSPACE}', 'slack.com', 'app_install',
                'active', '\\x00'::bytea);
    `);
  }, 900_000);

  afterAll(async () => {
    await owned?.release();
  });

  test("declares a rolling additive index and says why expiry is not in the predicate", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.startsWith("-- deployment-mode: rolling")).toBe(true);
    expect(source).toContain("slack_route_prompts_pending_conversation_uq");
    expect(source).toContain('"slack_user_id"');
    expect(source).not.toMatch(/DROP\s+(INDEX|TABLE|CONSTRAINT)/u);
  });

  test("asks one person once, and does not swallow another person in the same channel", async () => {
    if (!owned) return;
    expect(await insertPrompt(owned, { channelId: "C-SHARED", userId: "U-ONE" })).toBeTruthy();
    // A second pending card for the SAME person in the same channel is refused.
    expect(await insertPrompt(owned, { channelId: "C-SHARED", userId: "U-ONE" })).toBeNull();
    // A different person in the same channel is asked their own question.
    expect(await insertPrompt(owned, { channelId: "C-SHARED", userId: "U-TWO" })).toBeTruthy();
    // The same person in a different channel is asked there too.
    expect(await insertPrompt(owned, { channelId: "C-OTHER", userId: "U-ONE" })).toBeTruthy();
  }, 120_000);

  test("frees the slot once the card is settled, whatever settled it", async () => {
    if (!owned) return;
    for (const status of ["answered", "expired", "cancelled"] as const) {
      const channelId = `C-SETTLE-${status}`;
      const first = await insertPrompt(owned, { channelId, userId: "U-SETTLE" });
      expect(first).toBeTruthy();
      expect(await insertPrompt(owned, { channelId, userId: "U-SETTLE" })).toBeNull();
      await owned.admin.unsafe(`
        update slack_route_prompts
        set status = '${status}',
            answered_target_account_id = ${status === "answered" ? `'${ACCOUNT}'` : "null"},
            answered_target_workspace_id = ${status === "answered" ? `'${WORKSPACE}'` : "null"},
            answered_at = ${status === "answered" ? "now()" : "null"}
        where id = '${first}'`);
      expect(await insertPrompt(owned, { channelId, userId: "U-SETTLE" })).toBeTruthy();
    }
  }, 120_000);

  test("an aged-out card still holds the slot until a writer settles it", async () => {
    if (!owned) return;
    // This is the reason `expired` needs a writer: the index cannot exclude an
    // aged-out row by itself.
    const stale = await insertPrompt(owned, {
      channelId: "C-STALE",
      userId: "U-STALE",
      expiresIn: "-1 minute",
    });
    expect(stale).toBeTruthy();
    expect(await insertPrompt(owned, { channelId: "C-STALE", userId: "U-STALE" })).toBeNull();
    await owned.admin.unsafe(
      `update slack_route_prompts set status = 'expired' where id = '${stale}'`,
    );
    expect(await insertPrompt(owned, { channelId: "C-STALE", userId: "U-STALE" })).toBeTruthy();
  }, 120_000);
});
