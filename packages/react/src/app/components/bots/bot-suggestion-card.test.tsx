import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Session, SessionBotSuggestion } from "@opengeni/sdk";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

mock.module("../../lib/navigation", () => ({ useNavigate: () => () => undefined }));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppContext } = await import("../../app-context");
const { BotSuggestionCard } = await import("./bot-suggestion-card");
const { listenForBotTemplateDrafts } = await import("../../lib/bot-suggestions");

afterAll(() => GlobalRegistrator.unregister());

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  updateSessionProfile.mockClear();
  updateSessionRetention.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const session = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  avatar: null,
  description: null,
} as unknown as Session;

function suggestion(overrides: Partial<SessionBotSuggestion>): SessionBotSuggestion {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    kind: "create",
    sessionId: null,
    templateId: null,
    name: "Invoice checker",
    description: null,
    avatar: null,
    setupInstructions: null,
    reason: null,
    createdAt: "2026-11-02T10:00:00.000Z",
    ...overrides,
  };
}

const updateSessionProfile = mock(async () => session);
const updateSessionRetention = mock(async () => session);
const appContext = { updateSessionProfile, client: { updateSessionRetention } } as never;

async function accept(botSuggestion: SessionBotSuggestion) {
  const tree: ReactNode = (
    <AppContext.Provider value={appContext}>
      <BotSuggestionCard session={{ ...session, botSuggestion }} events={[]} />
    </AppContext.Provider>
  );
  await act(async () => root.render(tree));
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Make it a bot",
  )!;
  await act(async () => button.click());
}

test("accepting a name-only suggestion still makes the chat a bot", async () => {
  await accept(suggestion({}));
  const [workspaceId, sessionId, change] = updateSessionProfile.mock.calls[0] as unknown as [
    string,
    string,
    { title: string; description: string | null; avatar: { kind: string; icon: string } },
  ];
  expect([workspaceId, sessionId]).toEqual([session.workspaceId, session.id]);
  expect(change.title).toBe("Invoice checker");
  // A chat with an avatar or a description is a bot; this one gets an avatar.
  expect(change.avatar).toMatchObject({ kind: "icon", icon: "bot" });
  expect(updateSessionRetention).toHaveBeenCalledWith(session.workspaceId, session.id, {
    keepLive: true,
  });
});

test("accepting keeps the avatar and description the agent chose", async () => {
  const avatar = { kind: "emoji", emoji: "🧾", hue: 60 } as const;
  await accept(suggestion({ avatar, description: "Checks invoices" }));
  expect(updateSessionProfile.mock.calls[0]).toEqual([
    session.workspaceId,
    session.id,
    { title: "Invoice checker", description: "Checks invoices", avatar },
  ] as never);
});

test("saving the draft opens this chat's template dialog and hides the card once saved", async () => {
  const requests: unknown[] = [];
  let saved = () => {};
  const other = listenForBotTemplateDrafts(document, "another-chat", () => {
    throw new Error("another chat's header must not open");
  });
  const stop = listenForBotTemplateDrafts(document, session.id, (request) => {
    requests.push(request);
    saved = request.onSaved;
  });
  try {
    const avatar = { kind: "emoji", emoji: "🧾", hue: 60 } as const;
    const draft = suggestion({ avatar, setupInstructions: "Check each invoice." });
    await act(async () =>
      root.render(
        <AppContext.Provider value={appContext}>
          <BotSuggestionCard session={{ ...session, botSuggestion: draft }} events={[]} />
        </AppContext.Provider>,
      ),
    );
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Save as template…",
    )!;
    await act(async () => button.click());
    expect(requests).toEqual([
      expect.objectContaining({
        sessionId: session.id,
        name: "Invoice checker",
        avatar,
        setupInstructions: "Check each invoice.",
        visibility: "workspace",
      }),
    ]);
    expect(container.querySelector("[data-bot-suggestion]")).not.toBeNull();
    await act(async () => saved());
    expect(container.querySelector("[data-bot-suggestion]")).toBeNull();
  } finally {
    stop();
    other();
  }
});
