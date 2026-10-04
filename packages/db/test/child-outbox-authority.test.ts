import { expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database } from "../src/database";
import { parentOutboxAuthorityTx } from "../src/child-outbox-authority";
import type {
  McpPersonalConnectionDelegation,
  McpConnectionAccountBinding,
} from "@opengeni/contracts";
import * as schema from "../src/schema";

const accountId = "10000000-0000-4000-8000-000000000001";
const workspaceId = "10000000-0000-4000-8000-000000000002";
const parentSessionId = "10000000-0000-4000-8000-000000000003";
const parentTurnId = "10000000-0000-4000-8000-000000000004";
const session = {
  id: "10000000-0000-4000-8000-000000000005",
  accountId,
  parentSessionId,
  parentTurnId,
};
const connectionId = "10000000-0000-4000-8000-000000000006";
const personal: McpPersonalConnectionDelegation[] = [
  {
    serverId: "mail",
    connectionId,
    ownerSubjectId: "user:parent",
    providerDomain: "mail.test",
    kind: "oauth2",
    connectionType: "mcp",
  },
];
const bindings: McpConnectionAccountBinding[] = [
  {
    serverId: `account-${"a".repeat(64)}`,
    canonicalServerId: "mail",
    connectionId,
    originWorkspaceId: workspaceId,
    subjectScope: "subject",
    ownerSubjectId: "user:parent",
    accountLabel: "Accepted account",
    providerDomain: "mail.test",
    kind: "oauth2",
    connectionRef: {
      connectionId,
      subjectScope: "subject",
      providerDomain: "mail.test",
      kind: "oauth2",
    },
    connectionAuthorityGeneration: 3,
  },
];
function turn(overrides: Record<string, unknown> = {}) {
  return {
    id: parentTurnId,
    personalConnectionDelegations: personal,
    mcpAccountBindings: bindings,
    initiatingHumanSubjectId: "user:parent",
    initiatorKind: "subject",
    initiatorSubjectId: "user:parent",
    xaiProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
    claudeProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
    ...overrides,
  };
}

// Only the read-only query boundary is injected: execute the real helper and
// compile its real Drizzle predicate. This is not a runtime RLS/database proof.
function fixture(rows: Record<string, unknown>[]) {
  const queries: ReturnType<PgDialect["sqlToQuery"]>[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => {
        expect(table).toBe(schema.sessionTurns);
        return {
          where: (predicate: SQL) => {
            queries.push(new PgDialect().sqlToQuery(predicate));
            return {
              limit: async (limit: number) => {
                expect(limit).toBe(1);
                return rows;
              },
            };
          },
        };
      },
    }),
  } as unknown as Database;
  return { db, queries };
}

test("child notices preserve accepted binding identity, labels and both snapshots under all parent fences", async () => {
  const original = turn();
  const { db, queries } = fixture([original]);
  const authority = await parentOutboxAuthorityTx(db, workspaceId, session);
  expect(authority.personalConnectionDelegations).toEqual(personal);
  expect(authority.mcpAccountBindings).toEqual(bindings);
  expect(authority.lineage).toMatchObject({
    childSessionId: session.id,
    parentSessionId,
    parentTurnId,
    connectionAuthoritySubjectId: "user:parent",
  });
  expect(queries).toHaveLength(1);
  expect(queries[0]!.params).toEqual([accountId, workspaceId, parentSessionId, parentTurnId]);
  for (const column of ["account_id", "workspace_id", "session_id", "id"])
    expect(queries[0]!.sql).toContain(`"${column}"`);
  authority.mcpAccountBindings![0]!.accountLabel = "Changed output";
  expect(bindings[0]!.accountLabel).toBe("Accepted account");
});

test.each<{ value: McpConnectionAccountBinding[] | null }>([{ value: null }, { value: [] }])(
  "accepted bindings %p remain distinct from each other",
  async ({ value }) => {
    const { db } = fixture([turn({ mcpAccountBindings: value })]);
    expect((await parentOutboxAuthorityTx(db, workspaceId, session)).mcpAccountBindings).toEqual(
      value,
    );
  },
);

test("missing or foreign accepted parent never falls back to session defaults", async () => {
  const { db, queries } = fixture([]);
  await expect(parentOutboxAuthorityTx(db, workspaceId, session)).rejects.toThrow(
    "parent turn is unavailable",
  );
  const foreignAccount = "20000000-0000-4000-8000-000000000001";
  await expect(
    parentOutboxAuthorityTx(db, workspaceId, { ...session, accountId: foreignAccount }),
  ).rejects.toThrow("parent turn is unavailable");
  expect(queries[1]!.params).toEqual([foreignAccount, workspaceId, parentSessionId, parentTurnId]);
});

test.each([
  { personalConnectionDelegations: [false] },
  { mcpAccountBindings: [{}] },
  { initiatingHumanSubjectId: null, initiatorKind: "service", initiatorSubjectId: null },
])("invalid or unowned accepted authority is refused: %j", async (invalid) => {
  const { db } = fixture([turn(invalid)]);
  await expect(parentOutboxAuthorityTx(db, workspaceId, session)).rejects.toThrow();
});

test("a notice without a parent turn has explicit empty historical authority and performs no lookup", async () => {
  const { db, queries } = fixture([]);
  const authority = await parentOutboxAuthorityTx(db, workspaceId, {
    ...session,
    parentTurnId: null,
  });
  expect(authority.personalConnectionDelegations).toEqual([]);
  expect(authority.mcpAccountBindings).toBeNull();
  expect(authority.lineage).not.toHaveProperty("parentTurnId");
  expect(queries).toEqual([]);
});
