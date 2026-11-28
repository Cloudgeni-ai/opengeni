import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

GlobalRegistrator.register({ url: "https://example.test" });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// Each workspace's list answers only when the test says so.
const pending = new Map<string, (agents: unknown[]) => void>();
const context = {
  client: {
    listAgents: (workspaceId: string, options: { filter: string }) =>
      new Promise((resolve) => pending.set(`${workspaceId}:${options.filter}`, resolve)),
  },
};
mock.module("../app-context", () => ({ useAppContext: () => context }));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useAgents } = await import("./agents");
const { ContentSwap, useHeldWhileLoading } = await import("../../ui/content-swap");

afterAll(() => GlobalRegistrator.unregister());

// The Agents page's composition: the real list hook feeding the held list.
function Agents({ workspaceId, filter }: { workspaceId: string; filter: "all" | "yours" }) {
  const state = useAgents(workspaceId, { filter });
  const listed = useHeldWhileLoading(state.agents, filter, workspaceId);
  if (!listed.value) return <p data-skeleton="">Loading</p>;
  return (
    <ContentSwap swapKey={listed.key} stale={listed.stale}>
      <ul data-key={listed.key}>{listed.value.map((agent) => agent.name).join(",")}</ul>
    </ContentSwap>
  );
}

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  pending.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const show = async (workspaceId: string, filter: "all" | "yours") =>
  act(async () => root.render(<Agents workspaceId={workspaceId} filter={filter} />));
const answer = async (key: string, names: string[]) =>
  act(async () => pending.get(key)!(names.map((name) => ({ id: name, name }))));

describe("the Agents list while another one loads", () => {
  test("another workspace never shows the previous workspace's agents", async () => {
    await show("a", "all");
    await answer("a:all", ["agent-a"]);
    expect(host.querySelector("ul")?.textContent).toBe("agent-a");
    await show("b", "all");
    expect(host.querySelector("[data-skeleton]")).not.toBeNull();
    expect(host.textContent).not.toContain("agent-a");
    await answer("b:all", ["agent-b"]);
    expect(host.querySelector("ul")?.textContent).toBe("agent-b");
  });

  test("All → Yours keeps All, dimmed and under All, until Yours is in", async () => {
    await show("a", "all");
    await answer("a:all", ["mine", "theirs"]);
    await show("a", "yours");
    const held = host.querySelector("ul")!;
    expect(held.getAttribute("data-key")).toBe("all");
    expect(held.closest("[data-content-swap]")?.hasAttribute("data-stale")).toBe(true);
    await answer("a:yours", ["mine"]);
    expect(host.querySelector("ul")?.getAttribute("data-key")).toBe("yours");
    expect(host.querySelector("[data-stale]")).toBeNull();
  });
});
