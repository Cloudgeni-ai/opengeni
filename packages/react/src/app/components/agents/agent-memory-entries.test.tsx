import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Agent } from "@opengeni/sdk";
import type { Root } from "react-dom/client";

// Register the DOM before React DOM loads (see agent-can-use.test.tsx).
GlobalRegistrator.register({ url: "https://example.test" });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const workspaceId = "22222222-2222-4222-8222-222222222222";
const collectionId = "44444444-4444-4444-8444-444444444444";
let stored = 0;
let nextCursor: string | null = null;
const context = {
  client: {
    listKnowledgeEntries: async () => ({
      entries: Array.from({ length: stored }, (_, index) => ({
        id: `entry-${index}`,
        version: 1,
        revision: { title: `Memory ${index}`, preview: `Remembered ${index}` },
      })),
      nextCursor,
    }),
  },
};
mock.module("../../app-context", () => ({ useAppContext: () => context }));
mock.module("../../lib/navigation", () => ({ useNavigate: () => () => undefined }));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AgentMemoryEntries, AGENT_MEMORY_PREVIEW } = await import("./agent-setup-sections");

afterAll(() => GlobalRegistrator.unregister());

const agent = {
  id: "33333333-3333-4333-8333-333333333333",
  memory: { enabled: true, collectionId, reviewFirst: false },
  viewer: { canEdit: true },
} as unknown as Agent;

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  nextCursor = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render() {
  await act(async () => {
    root.render(<AgentMemoryEntries agent={agent} workspaceId={workspaceId} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  const links = [...host.querySelectorAll("[data-agent-memory]")];
  return {
    rows: host.querySelectorAll("[aria-label^='Remove Memory']").length,
    links: links.map((link) => link.textContent),
    href: links[0]?.getAttribute("href") ?? null,
  };
}

describe("AgentMemoryEntries", () => {
  test("shows only the newest few, and one link to see all of them in Knowledge", async () => {
    stored = 12;
    const shown = await render();
    expect(shown.rows).toBe(AGENT_MEMORY_PREVIEW);
    expect(shown.links).toEqual(["See all 12 in Knowledge"]);
    expect(shown.href).toContain(`entry=${collectionId}`);
  });

  test("says there are more when the first page doesn't hold them all", async () => {
    stored = 50;
    nextCursor = "next";
    expect((await render()).links).toEqual(["See all 50+ in Knowledge"]);
  });

  test("a short list shows every entry and keeps the plain link", async () => {
    stored = 3;
    const shown = await render();
    expect(shown.rows).toBe(3);
    expect(shown.links).toEqual(["Open in Knowledge"]);
  });
});
