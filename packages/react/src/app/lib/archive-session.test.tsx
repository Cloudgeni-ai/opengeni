import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());

type Shown = {
  title: string;
  options: {
    toasterId?: string;
    action?: { label: string; onClick: () => void };
    onDismiss?: () => void;
  };
};
// Every notice shown, with the options it was shown with.
const shown: Shown[] = [];
mock.module("sonner", () => ({
  toast: Object.assign(
    (title: string, options: Shown["options"]) => {
      shown.push({ title, options });
      return shown.length;
    },
    { dismiss: () => {} },
  ),
}));
mock.module("./app-host", () => ({ useAppHost: () => ({}) }));

const { ArchiveConfirmationProvider, quotedChatName, useArchiveConfirmation } =
  await import("./archive-session");
const { retainEmbeddedToaster } = await import("./toast");

function confirmation() {
  let captured!: ReturnType<typeof useArchiveConfirmation>;
  function Capture() {
    captured = useArchiveConfirmation();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() =>
    root.render(
      <ArchiveConfirmationProvider>
        <Capture />
      </ArchiveConfirmationProvider>,
    ),
  );
  return captured;
}

// An answer that comes back after the person moved to another page.
const lateQuestion = (page: number) => ({
  title: "Pause and archive “Busy chat”?",
  description: "This chat has active work.",
  confirmLabel: "Pause and archive",
  page: page - 1,
  late: { title: "“Busy chat” wasn't archived", description: "It has active work." },
});

beforeEach(() => {
  shown.length = 0;
});

test("in an embed, a late answer asks in the embed's own notices, and its action archives", async () => {
  const release = retainEmbeddedToaster(Symbol("embed"));
  const archive = confirmation();
  const answer = archive.confirm(lateQuestion(archive.page()));
  release();
  expect(shown).toHaveLength(1);
  expect(shown[0]!.title).toBe("“Busy chat” wasn't archived");
  // Inside an embed only the embed's toaster shows Opengeni notices.
  expect(shown[0]!.options.toasterId).toBe("opengeni");
  expect(shown[0]!.options.action?.label).toBe("Pause and archive");
  shown[0]!.options.action!.onClick();
  expect(await answer).toBe(true);
});

test("dismissing a late notice leaves the chat as it was", async () => {
  const archive = confirmation();
  const answer = archive.confirm(lateQuestion(archive.page()));
  shown[0]!.options.onDismiss!();
  shown[0]!.options.action!.onClick();
  expect(await answer).toBe(false);
});

test("a long chat name is shortened without breaking a character", () => {
  const title = `${"a".repeat(58)}😀 and more`;
  expect(quotedChatName(title)).toBe(`“${"a".repeat(58)}😀…”`);
});
