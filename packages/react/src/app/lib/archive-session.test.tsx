import { beforeEach, expect, mock, test } from "bun:test";

type Shown = {
  kind: "plain" | "success";
  title: string;
  options?:
    | {
        toasterId?: string;
        duration?: number;
        description?: string;
        action?: { label: string; onClick: () => void };
      }
    | undefined;
};
// Every notice shown, with the options it was shown with.
const shown: Shown[] = [];
mock.module("sonner", () => ({
  toast: Object.assign(
    (title: string, options: Shown["options"]) => {
      shown.push({ kind: "plain", title, options });
      return shown.length;
    },
    {
      success: (title: string, options: Shown["options"]) => {
        shown.push({ kind: "success", title, options });
        return shown.length;
      },
      dismiss: () => {},
    },
  ),
}));

const { ARCHIVE_UNDO_MS, archiveActionLabel, quotedChatName, requestSessionArchive } =
  await import("./archive-session");

const requests: Array<{ sessionId: string; body: unknown }> = [];
function appContext(permissions: string[] = ["sessions:control"]) {
  return {
    accessContext: {
      workspaceGrants: [{ workspaceId: "ws", permissions, permissionMode: "explicit" }],
    },
    captureWorkspaceInvocation: () => 1,
    ownsWorkspaceInvocation: () => true,
    client: {
      updateSessionArchive: async (_workspaceId: string, sessionId: string, body: unknown) => {
        requests.push({ sessionId, body });
        return {
          id: sessionId,
          workspaceId: "ws",
          archived: (body as { archived: boolean }).archived,
        };
      },
    },
  } as unknown as Parameters<typeof requestSessionArchive>[0];
}

beforeEach(() => {
  shown.length = 0;
  requests.length = 0;
});

test("Archive is offered only to people who can control a chat that is not archived yet", () => {
  const chat = { workspaceId: "ws", archived: false };
  expect(archiveActionLabel(appContext(), chat)).toBe("Archive");
  expect(archiveActionLabel(appContext(), { ...chat, archived: true })).toBeNull();
  expect(archiveActionLabel(appContext(["sessions:read"]), chat)).toBeNull();
});

test("archiving shows Undo for a few seconds, says it becomes final, and Undo is the caller's", async () => {
  let undone = 0;
  const updated = await requestSessionArchive(
    appContext(),
    { id: "chat", workspaceId: "ws" },
    true,
    "Quarterly plan",
    () => (undone += 1),
  );
  expect(updated).toMatchObject({ archived: true });
  expect(requests).toEqual([{ sessionId: "chat", body: { archived: true } }]);
  expect(shown).toHaveLength(1);
  expect(shown[0]!.title).toBe("Archived “Quarterly plan”");
  expect(shown[0]!.options?.duration).toBe(ARCHIVE_UNDO_MS);
  expect(shown[0]!.options?.description).toContain("can't be restored");
  expect(shown[0]!.options?.action?.label).toBe("Undo");
  shown[0]!.options!.action!.onClick();
  expect(undone).toBe(1);
});

test("undoing sends archived false and confirms it", async () => {
  await requestSessionArchive(appContext(), { id: "chat", workspaceId: "ws" }, false, "Plan");
  expect(requests).toEqual([{ sessionId: "chat", body: { archived: false } }]);
  expect(shown.map((notice) => [notice.kind, notice.title])).toEqual([
    ["success", "Archive undone."],
  ]);
});

test("a long chat name is shortened without breaking a character", () => {
  const title = `${"a".repeat(58)}😀 and more`;
  expect(quotedChatName(title)).toBe(`“${"a".repeat(58)}😀…”`);
});
