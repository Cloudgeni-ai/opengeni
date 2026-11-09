import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Session, SessionAgentSuggestion } from "@opengeni/sdk";
import type { Root } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const navigate = mock((_target: unknown) => undefined);
mock.module("../../lib/navigation", () => ({ useNavigate: () => navigate }));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AgentSuggestionCard } = await import("./agent-suggestion-card");
const { dismissAgentSuggestion } = await import("../../lib/agent-suggestion-dismissal");

afterAll(() => GlobalRegistrator.unregister());

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  navigate.mockClear();
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

function suggestion(overrides: Partial<SessionAgentSuggestion>): SessionAgentSuggestion {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    kind: "create",
    agentId: null,
    name: "Invoice checker",
    description: "Checks invoices",
    avatar: { kind: "emoji", emoji: "🧾", hue: 60 },
    instructions: "Check each invoice.",
    firstMessage: null,
    reason: "Three checks so far.",
    createdAt: "2026-11-02T10:00:00.000Z",
    ...overrides,
  };
}

async function render(chat: Session) {
  await act(async () =>
    root.render(<AgentSuggestionCard session={chat} suggestion={chat.agentSuggestion ?? null} />),
  );
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

const card = () => container.querySelector("[data-agent-suggestion]");

test("a create card opens Make this an agent with the draft and stays until it is made", async () => {
  const draft = suggestion({});
  await render({ ...session, agentSuggestion: draft });
  expect(card()?.textContent).toContain("Make an agent from this chat: Invoice checker");
  await act(async () => button("Make this an agent…").click());
  expect(navigate).toHaveBeenCalledWith({
    to: "/workspaces/$workspaceId/agents/new",
    params: { workspaceId: session.workspaceId },
    search: { sourceSessionId: session.id, suggestion: draft.id },
  });
  expect(card()).not.toBeNull();
  // The form dismisses it once the agent exists.
  dismissAgentSuggestion(session.id, draft.id);
  await render({ ...session, agentSuggestion: { ...draft } });
  expect(card()).toBeNull();
});

test("a reuse card starts a chat with the agent", async () => {
  const agentId = "44444444-4444-4444-8444-444444444444";
  await render({
    ...session,
    agentSuggestion: suggestion({ kind: "reuse", agentId, name: "SRE agent", instructions: null }),
  });
  expect(card()?.textContent).toContain("SRE agent already does this");
  await act(async () => button("Chat with SRE agent").click());
  expect(navigate).toHaveBeenCalledWith({
    to: "/workspaces/$workspaceId/sessions",
    params: { workspaceId: session.workspaceId },
    search: { agent: agentId },
  });
  expect(card()).toBeNull();
});

test("Not now hides the card, and a chat with an agent never shows one", async () => {
  await render({ ...session, agentSuggestion: suggestion({}) });
  await act(async () => button("Not now").click());
  expect(card()).toBeNull();
  localStorage.clear();
  await render({
    ...session,
    agentId: "55555555-5555-4555-8555-555555555555",
    agentSuggestion: suggestion({ id: "66666666-6666-4666-8666-666666666666" }),
  } as Session);
  expect(card()).toBeNull();
});
