import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

GlobalRegistrator.register({ url: "https://example.test" });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ContentSwap, useHeldWhileLoading } = await import("./content-swap");

afterAll(() => GlobalRegistrator.unregister());

function List({ items, filter }: { items: string[] | undefined; filter: string }) {
  const held = useHeldWhileLoading(items, filter);
  if (!held.value) return <p data-skeleton="">Loading</p>;
  return (
    <ContentSwap swapKey={held.key} stale={held.stale}>
      <ul data-list={held.key}>
        {held.value.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </ContentSwap>
  );
}

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const render = async (items: string[] | undefined, filter: string) => {
  await act(async () => root.render(<List items={items} filter={filter} />));
  const swap = host.querySelector("[data-content-swap]");
  return {
    skeleton: host.querySelector("[data-skeleton]") !== null,
    list: host.querySelector("[data-list]")?.getAttribute("data-list") ?? null,
    text: host.querySelector("ul")?.textContent ?? null,
    stale: swap?.hasAttribute("data-stale") ?? false,
    busy: swap?.getAttribute("aria-busy") ?? null,
    reducedMotion: swap?.innerHTML.includes("motion-reduce:animate-none") ?? false,
  };
};

describe("ContentSwap", () => {
  test("the first load shows its skeleton; a switch keeps the old list, dimmed, until the new one is ready", async () => {
    expect((await render(undefined, "all")).skeleton).toBe(true);
    expect(await render(["a", "b"], "all")).toMatchObject({ list: "all", stale: false });
    // Switched to Yours, still loading: the old list stays, marked busy.
    expect(await render(undefined, "yours")).toMatchObject({
      skeleton: false,
      list: "all",
      text: "ab",
      stale: true,
      busy: "true",
    });
    // Loaded: the new list replaces it and fades in (not under reduced motion).
    expect(await render(["b"], "yours")).toMatchObject({
      list: "yours",
      text: "b",
      stale: false,
      busy: null,
      reducedMotion: true,
    });
  });
});
