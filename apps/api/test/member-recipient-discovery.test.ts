import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";

const realDb = { ...(await import("@opengeni/db")) };
const workspaceId = "00000000-0000-4000-8000-000000000001";
const fakeDb = {} as ApiRouteDeps["db"];
const deps = { db: fakeDb } as ApiRouteDeps;
type Members = Awaited<ReturnType<typeof realDb.listWorkspaceMembers>>;
const member = (subjectId: string, subjectLabel: string | null): Members[number] => ({
  subjectId,
  subjectLabel,
  role: "member",
  permissions: [],
  createdAt: "2026-01-01T00:00:00.000Z",
});
let members: Members = [];
let authorized = true;
let owner: { subjectId: string } | null = { subjectId: "user:ada" };
const lookups: string[] = [];
const notificationRecipients: string[] = [];
const callRecipients: string[] = [];

mock.module("@opengeni/db", () => ({
  ...realDb,
  listWorkspaceMembers: async (db: typeof fakeDb, scope: string) => {
    if (db !== fakeDb) return realDb.listWorkspaceMembers(db, scope);
    lookups.push(scope);
    return scope === workspaceId ? members : [member("user:outsider", "Other workspace")];
  },
  getManagedUserByEmail: async (db: typeof fakeDb, email: string) => {
    if (db !== fakeDb) return realDb.getManagedUserByEmail(db, email);
    return email.toLowerCase() === "bea.account@example.test" ? "bea" : null;
  },
  getSessionInboxRecipient: async (...args: Parameters<typeof realDb.getSessionInboxRecipient>) => {
    if (args[0] !== fakeDb) return realDb.getSessionInboxRecipient(...args);
    return owner;
  },
  getMemberNotificationsAllowed: async (
    ...args: Parameters<typeof realDb.getMemberNotificationsAllowed>
  ) => {
    if (args[0] !== fakeDb) return realDb.getMemberNotificationsAllowed(...args);
    notificationRecipients.push(args[1].subjectId);
    return false;
  },
  getSessionTitles: async (...args: Parameters<typeof realDb.getSessionTitles>) => {
    if (args[0] !== fakeDb) return realDb.getSessionTitles(...args);
    return new Map();
  },
  placeAgentCall: async (...args: Parameters<typeof realDb.placeAgentCall>) => {
    if (args[0] !== fakeDb) return realDb.placeAgentCall(...args);
    callRecipients.push(args[1].calleeSubjectId);
    return { placed: false, refusal: "no_phone" };
  },
}));

const { registerNotificationTools, requireMember, resolveMember } =
  await import("../src/mcp/notification-tools");
const { registerAgentCallTools } = await import("../src/mcp/agent-call-tools");

afterAll(() => mock.restore());
beforeEach(() => {
  members = [member("user:ada", "Ada"), member("user:bea", "bea.account@example.test")];
  authorized = true;
  owner = { subjectId: "user:ada" };
  lookups.length = 0;
  notificationRecipients.length = 0;
  callRecipients.length = 0;
});

type Handler = (input: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<unknown>;
function tools() {
  const handlers = new Map<string, Handler>();
  const input = {
    server: {
      registerTool: (name: string, _config: unknown, handler: Handler) => {
        handlers.set(name, handler);
      },
    } as never,
    deps,
    grant: { workspaceId, permissions: ["sessions:control"], permissionMode: "explicit" } as never,
    sessionId: "00000000-0000-4000-8000-000000000002",
    authorize: async () => {
      if (!authorized) throw new Error("Unauthorized");
    },
    attempt: () => ({
      callerTurnId: "turn",
      callerExecutionGeneration: 1,
      callerAttemptId: "attempt",
    }),
    json: (value: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify(value) }],
    }),
  };
  registerNotificationTools(input);
  registerAgentCallTools(input);
  return (name: string, recipient: string) =>
    handlers.get(name)!(
      { title: "Review ready", reason: "Review needed", message: "", urgency: "normal", recipient },
      { signal: new AbortController().signal },
    );
}

describe("member recipient discovery", () => {
  for (const name of ["notify_user", "call_user"]) {
    test(`${name} lists exact recipients after failed guesses and allows a retry`, async () => {
      const call = tools();
      for (const recipient of ["Bea", "bea.work@example.test", "guessed@example.test"]) {
        await expect(call(name, recipient)).rejects.toThrow(
          'Workspace members:\n- "Ada": recipient="user:ada"\n' +
            '- "bea.account@example.test": recipient="user:bea"',
        );
      }
      expect(lookups.every((scope) => scope === workspaceId)).toBe(true);
      expect(notificationRecipients).toEqual([]);
      expect(callRecipients).toEqual([]);
      // Discovery does not bypass opt-in: the correct ID reaches the existing
      // permission/device check, rather than another recipient-resolution error.
      if (name === "notify_user") {
        await expect(call(name, "user:bea")).rejects.toThrow("hasn't allowed");
        expect(notificationRecipients).toEqual(["user:bea"]);
      } else {
        expect(await call(name, "user:bea")).toMatchObject({
          content: [{ text: expect.stringContaining('"refusal":"no_phone"') }],
        });
        expect(callRecipients).toEqual(["user:bea"]);
      }
    });

    test(`${name} lists both duplicate labels with distinct retry IDs`, async () => {
      members = [member("user:bea", "Bea Smith"), member("user:other-bea", "Bea Smith")];
      await expect(tools()(name, "bea smith")).rejects.toThrow(
        'Workspace members:\n- "Bea Smith": recipient="user:bea"\n' +
          '- "Bea Smith": recipient="user:other-bea"',
      );
      for (const each of members) {
        expect(await requireMember(deps, workspaceId, each.subjectId)).toEqual({
          subjectId: each.subjectId,
          label: "Bea Smith",
        });
      }
    });

    test(`${name} does not list members before authorization or without a person`, async () => {
      const call = tools();
      authorized = false;
      await expect(call(name, "Nobody")).rejects.toThrow("Unauthorized");
      expect(lookups).toEqual([]);
      authorized = true;
      owner = null;
      await expect(call(name, "Nobody")).rejects.toThrow("works for no person");
      expect(lookups).toEqual([]);
    });
  }

  test("preserves exact ID, case-insensitive full label and account email matching", async () => {
    members[1] = member("user:bea", "Bea Smith");
    for (const recipient of [" user:bea ", " BEA SMITH ", "BEA.ACCOUNT@example.test"]) {
      expect(await requireMember(deps, workspaceId, recipient)).toEqual({
        subjectId: "user:bea",
        label: "Bea Smith",
      });
    }
    expect(await resolveMember(deps, workspaceId, "Bea")).toBeNull();
    expect(await resolveMember(deps, workspaceId, "Bea Smit")).toBeNull();
    expect(lookups).toHaveLength(5); // Successful resolution needs no discovery query.
  });

  test("handles missing labels and escapes labels without inventing list entries", async () => {
    members = [
      member("user:one", null),
      member("user:two", " "),
      member("external:three", 'A\n"B"'),
    ];
    await expect(requireMember(deps, workspaceId, "Nobody")).rejects.toThrow(
      'Workspace members:\n- "user:one": recipient="user:one"\n' +
        '- "user:two": recipient="user:two"\n- "A\\n\\"B\\"": recipient="external:three"',
    );
    expect(await requireMember(deps, workspaceId, "external:three")).toMatchObject({
      subjectId: "external:three",
    });
  });

  test("an empty workspace gives an explicit empty result", async () => {
    members = [];
    await expect(requireMember(deps, workspaceId, "Nobody")).rejects.toThrow(
      "No workspace members are available.",
    );
  });

  test("lists every member, including the last member of a large workspace", async () => {
    members = Array.from({ length: 500 }, (_, index) => member(`user:${index}`, `Member ${index}`));
    await expect(requireMember(deps, workspaceId, "Nobody")).rejects.toThrow(
      '- "Member 499": recipient="user:499"',
    );
  });
});
