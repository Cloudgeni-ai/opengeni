import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppContext } = await import("../../app-context");
const { ChatAvatar } = await import("./chat-avatar");

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

function Provide(props: { value: never; children: React.ReactNode }) {
  return <AppContext.Provider value={props.value}>{props.children}</AppContext.Provider>;
}

async function render(node: React.ReactNode, client: object) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <Provide value={{ client, accessContext: { subjectId: "user:me" } } as never}>
        {node}
      </Provide>,
    ),
  );
  for (let index = 0; index < 3; index += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("an agent chat shows its agent's icon, read once for every row of that agent", async () => {
  let reads = 0;
  const client = {
    getAgent: async () => {
      reads += 1;
      return { name: "Meeting preparation", avatar: { kind: "icon", icon: "search", hue: 320 } };
    },
  };
  const chat = (id: string) => ({ id, workspaceId: WORKSPACE, avatar: null, agentId: AGENT });
  const view = await render(
    <>
      <ChatAvatar chat={chat("a")} name="Meeting Preparation Test" />
      <ChatAvatar chat={chat("b")} name="Robotics Meeting Preparation" />
    </>,
    client,
  );
  try {
    const marks = view.container.querySelectorAll(`[data-chat-agent-avatar="${AGENT}"]`);
    expect(marks).toHaveLength(2);
    expect(marks[0]?.getAttribute("title")).toBe("Meeting preparation");
    expect(reads).toBe(1);
  } finally {
    await view.unmount();
  }
});

test("a chat's own avatar wins, and an ordinary chat gets the fallback", async () => {
  let reads = 0;
  const client = {
    getAgent: async () => {
      reads += 1;
      return { name: "Other", avatar: null };
    },
  };
  const view = await render(
    <>
      <ChatAvatar
        chat={{
          id: "own",
          workspaceId: WORKSPACE,
          avatar: { kind: "emoji", emoji: "🦊", hue: 20 },
          agentId: "33333333-3333-4333-8333-333333333333",
        }}
        name="Fox"
      />
      <ChatAvatar
        chat={{ id: "plain", workspaceId: WORKSPACE, avatar: null, agentId: null }}
        name="Plain"
        fallback={<i data-fallback="" />}
      />
    </>,
    client,
  );
  try {
    expect(view.container.textContent).toContain("🦊");
    expect(view.container.querySelector("[data-chat-agent-avatar]")).toBeNull();
    expect(view.container.querySelectorAll("[data-fallback]")).toHaveLength(1);
    expect(reads).toBe(0);
  } finally {
    await view.unmount();
  }
});
