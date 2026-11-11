import { afterAll, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Session } from "@opengeni/react/app/types";

mock.module("@opengeni/react/app/app-context", () => ({ useAppContext: () => ({}) }));
mock.module("sonner", () => ({ toast: Object.assign(() => 0, { success: () => 0 }) }));
const { ReadOnlySessionNotice, sessionReadOnlyArchive } =
  await import("@opengeni/react/app/components/session/session-retention");
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
  // Archived by a person and waiting to be stored: already read-only.
  expect(
    sessionReadOnlyArchive({
      ...session({ keepLive: false, archive: null }),
      archived: true,
    })?.state,
  ).toBe("archiving");
});

test("the notice says the chat is archived and offers to continue in a new chat", () => {
  const archived = renderToStaticMarkup(
    <ReadOnlySessionNotice
      session={session({
        keepLive: false,
        archive: { state: "archived", archivedAt: "2026-01-01T00:00:00.000Z" },
      })}
      onContinue={() => undefined}
    />,
  );
  expect(archived).toContain("This chat is archived");
  expect(archived).toContain("It moved to long-term storage");
  expect(archived).toContain("You can read the whole conversation, but not continue it here.");
  expect(archived).toContain("Continue in a new chat");

  const moving = renderToStaticMarkup(
    <ReadOnlySessionNotice
      session={session({ keepLive: false, archive: { state: "archiving", archivedAt: null } })}
      onContinue={() => undefined}
    />,
  );
  expect(moving).toContain("is moving to long-term storage");

  expect(
    renderToStaticMarkup(
      <ReadOnlySessionNotice
        session={session({ keepLive: false, archive: null })}
        onContinue={() => undefined}
      />,
    ),
  ).toBe("");
});

test("a chat this person can restore offers Restore, and a restore in progress says so", () => {
  const archived = { state: "archived" as const, archivedAt: "2026-01-01T00:00:00.000Z" };
  const restorable = renderToStaticMarkup(
    <ReadOnlySessionNotice
      session={session({ keepLive: false, archive: archived })}
      onContinue={() => undefined}
      onRestore={async () => true}
    />,
  );
  expect(restorable).toContain("Restore chat");
  expect(restorable).toContain("Restore it to continue here.");
  expect(restorable).not.toContain("but not continue it here");

  const restoring = renderToStaticMarkup(
    <ReadOnlySessionNotice
      session={session({ keepLive: false, archive: { ...archived, restoring: true } })}
      onContinue={() => undefined}
      onRestore={async () => true}
    />,
  );
  expect(restoring).toContain("Restoring this chat");
  expect(restoring).toContain("Restoring…");
  expect(restoring).toContain('data-read-only-session="restoring"');
  expect(restoring).toContain("coming back from long-term storage");

  // Without the option (no permission, or a sub-chat) there is no Restore.
  expect(
    renderToStaticMarkup(
      <ReadOnlySessionNotice
        session={session({ keepLive: false, archive: archived })}
        onContinue={() => undefined}
      />,
    ),
  ).not.toContain("Restore chat");
});

test("the Archived page names the deployment's idle period", () => {
  expect(readOnlyChatsDescription(1)).toContain("no activity for 1 day are archived too");
  expect(readOnlyChatsDescription(30)).toContain("no activity for 30 days are archived too");
  expect(readOnlyChatsDescription(undefined)).not.toContain("no activity");
});
