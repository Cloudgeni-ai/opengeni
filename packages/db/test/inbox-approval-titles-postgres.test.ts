import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { bootstrapWorkspace, createDb, createSession } from "../src";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(30_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("inbox-approval-titles");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function titleOf(approval: unknown) {
  const [row] = await shared.admin<Array<{ title: string; source: string }>>`
    select opengeni_private.inbox_approval_title_v1(${shared.admin.json(approval as never)}::jsonb) as title,
      opengeni_private.inbox_approval_source_v1(${shared.admin.json(approval as never)}::jsonb) as source`;
  return row!;
}

test("an approval reads as what it does, never as the raw tool name", async () => {
  expect(
    await titleOf({
      id: "call-1",
      name: "mcp_gmail__batch_modify_messages",
      display: {
        toolName: "batch_modify_messages",
        title: "Update 3 messages",
        connector: "Gmail",
      },
    }),
  ).toEqual({ title: "Update 3 messages", source: "Gmail" });
  // Without a display title, a readable form of the tool's own name.
  expect(
    await titleOf({
      id: "call-2",
      name: "mcp_gmail__batch_modify_messages",
      display: {
        toolName: "batch_modify_messages",
        connector: "Gmail",
        accountLabel: "work",
      },
    }),
  ).toEqual({ title: "Modify messages", source: "Gmail · work" });
  expect(await titleOf({ id: "call-3", name: "mcp_linear__createIssue" })).toEqual({
    title: "Create issue",
    source: "",
  });
  expect((await titleOf({ id: "call-4", name: "a".repeat(64) })).title).toBe("A tool call");
  expect((await titleOf({ id: "call-5" })).title).toBe("A tool call");
});

test("the inbox item opens with the plain title and keeps it through a later pause", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "inbox-approval-titles",
    accountExternalId: `account-${suffix}`,
    accountName: "Inbox approval titles",
    workspaceExternalSource: "inbox-approval-titles",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Inbox approval titles",
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    createdBy: { kind: "subject" as const, subjectId: grant.subjectId },
    initialMessage: "Tidy my inbox",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  const pause = async (approvals: unknown[]) => {
    const [last] = await shared.admin<Array<{ sequence: number | null }>>`
      select max(sequence) as sequence from session_events where session_id = ${session.id}::uuid`;
    await shared.admin`insert into session_events(account_id, workspace_id, session_id, sequence, type, payload, payload_codec_version)
      values (${grant.accountId}, ${workspaceId}, ${session.id}, ${(last?.sequence ?? 0) + 1},
        'session.requiresAction', ${shared.admin.json({ approvals } as never)}::jsonb, null)`;
  };
  const items = async () =>
    [
      ...(await shared.admin<Array<{ source_key: string; title: string; body: string }>>`
      select source_key, title, body from opengeni_private.inbox_items
      where session_id = ${session.id}::uuid and kind = 'approval' order by source_key`),
    ].map((row) => ({ id: row.source_key, title: row.title, body: row.body }));

  await pause([
    {
      id: "call-a",
      name: "mcp_gmail__batch_modify_messages",
      arguments: { messageIds: ["1", "2", "3"], addLabelIds: ["TRASH"] },
      display: {
        toolName: "batch_modify_messages",
        title: "Move 3 messages to Trash",
        connector: "Gmail",
      },
    },
    {
      id: "call-b",
      name: "mcp_gmail__create_label",
      arguments: { name: "Receipts" },
      display: { toolName: "create_label", connector: "Gmail" },
    },
  ]);
  expect(await items()).toEqual([
    { id: "call-a", title: "Move 3 messages to Trash", body: "Gmail" },
    { id: "call-b", title: "Create label", body: "Gmail" },
  ]);

  // After one decision, the turn pauses again on the rest, named without
  // display details. The open item keeps what it said.
  await pause([{ id: "call-a", name: "mcp_gmail__batch_modify_messages", arguments: {} }]);
  expect((await items())[0]).toEqual({
    id: "call-a",
    title: "Move 3 messages to Trash",
    body: "Gmail",
  });
});
