import { afterAll, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Session } from "@/types";

mock.module("@/context", () => ({ useAppContext: () => ({}) }));
mock.module("sonner", () => ({ toast: Object.assign(() => 0, { success: () => 0 }) }));
const { ReadOnlySessionNotice, sessionReadOnlyArchive } = await import("./session-retention");
const { readOnlyChatsDescription } = await import("@/routes/read-only-chats");
afterAll(() => mock.restore());

function session(retention: Session["retention"]): Session {
  return { id: "s", workspaceId: "w", retention } as unknown as Session;
}

test("only an archived or archiving chat is read-only", () => {
  expect(sessionReadOnlyArchive(session(undefined))).toBeNull();
  expect(sessionReadOnlyArchive(session({ keepLive: true, archive: null }))).toBeNull();
  expect(
    sessionReadOnlyArchive(
      session({ keepLive: false, archive: { state: "archiving", archivedAt: null } }),
    )?.state,
  ).toBe("archiving");
});

test("the notice says why the chat is read-only and offers a new chat", () => {
  const archived = renderToStaticMarkup(
    <ReadOnlySessionNotice
      session={session({
        keepLive: false,
        archive: { state: "archived", archivedAt: "2026-01-01T00:00:00.000Z" },
      })}
      idleDays={30}
      onNewSession={() => undefined}
    />,
  );
  expect(archived).toContain("This chat is read-only");
  expect(archived).toContain("after 30 days without activity");
  expect(archived).toContain("You can read the whole conversation, but not continue it.");
  expect(archived).toContain("New chat");

  const moving = renderToStaticMarkup(
    <ReadOnlySessionNotice
      session={session({ keepLive: false, archive: { state: "archiving", archivedAt: null } })}
      onNewSession={() => undefined}
    />,
  );
  expect(moving).toContain("is moving to long-term storage");
  expect(moving).toContain("a long time");

  expect(
    renderToStaticMarkup(
      <ReadOnlySessionNotice
        session={session({ keepLive: false, archive: null })}
        onNewSession={() => undefined}
      />,
    ),
  ).toBe("");
});

test("the read-only chats page names the deployment's idle period", () => {
  expect(readOnlyChatsDescription(1)).toContain("no activity for 1 day move");
  expect(readOnlyChatsDescription(30)).toContain("no activity for 30 days move");
  expect(readOnlyChatsDescription(undefined)).toContain("a long time");
});
