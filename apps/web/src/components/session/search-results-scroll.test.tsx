import { expect, test } from "bun:test";
import { act } from "react";
import { SearchResultsView } from "./search-results-view";
import {
  registerDom,
  renderComponent,
  flush,
} from "../../../../../packages/react/test/render-hook";

registerDom();

test("result rows show match metadata once and omit title-only duplicate snippets", async () => {
  const view = await renderComponent(
    <SearchResultsView
      query="harborlight"
      results={[
        {
          sessionId: "1",
          title: "harborlight",
          subtitle: "Message match",
          snippet: "A distinct passage",
          matchingMessages: 2,
          titleMatch: false,
        },
        {
          sessionId: "2",
          title: "harborlight dock",
          subtitle: "September 17",
          snippet: " harborlight dock ",
          matchingMessages: 0,
          titleMatch: true,
        },
      ]}
      selectedId="1"
      onSelect={() => {}}
      loading={false}
      error={null}
      onRetry={() => {}}
      hasMore={false}
      onMore={() => {}}
    />,
  );
  const rows = view.container.querySelectorAll("[data-search-result]");
  expect(rows[0]!.textContent!.match(/Message match/g)?.length).toBe(1);
  expect(rows[0]!.querySelector("p")?.textContent).toBe("A distinct passage");
  expect(rows[1]!.querySelector("p")).toBeNull();
  expect(rows[1]!.textContent).toContain("September 17");
  await view.unmount();
});

test("populated loading lists save real scrolling, while hidden and empty loading lists preserve it", async () => {
  const position = { current: 1109 };
  const results = [
    {
      sessionId: "1",
      title: "harborlight",
      subtitle: "",
      snippet: "",
      matchingMessages: 0,
      titleMatch: true,
    },
  ];
  const render = (active: boolean, loading: boolean, populated = true) => (
    <SearchResultsView
      query="harborlight"
      results={populated ? results : []}
      selectedId="1"
      onSelect={() => {}}
      loading={loading}
      error={null}
      onRetry={() => {}}
      hasMore={false}
      onMore={() => {}}
      scrollPosition={position}
      active={active}
    />
  );
  const view = await renderComponent(render(false, false));
  const list = view.container.querySelector<HTMLDivElement>('[aria-label="Matching sessions"]')!;
  let height = 0;
  Object.defineProperties(list, {
    clientHeight: { get: () => height },
    scrollHeight: { get: () => 2500 },
  });
  await act(async () => list.dispatchEvent(new Event("scroll", { bubbles: true })));
  expect(position.current).toBe(1109);
  await view.rerender(render(true, true));
  await act(async () => list.dispatchEvent(new Event("scroll", { bubbles: true })));
  expect(position.current).toBe(1109);
  await view.rerender(render(false, true));
  height = 600;
  await view.rerender(render(true, true));
  await flush(25);
  expect(list.scrollTop).toBe(1109);
  list.scrollTop = 1200;
  await act(async () => list.dispatchEvent(new Event("scroll", { bubbles: true })));
  expect(position.current).toBe(1200);
  // The title list is usable while the independent message scan is loading.
  // A temporary empty loading state cannot replace its saved reading position.
  await view.rerender(render(true, true, false));
  list.scrollTop = 0;
  await act(async () => list.dispatchEvent(new Event("scroll", { bubbles: true })));
  expect(position.current).toBe(1200);
  await view.rerender(render(false, false));
  height = 0;
  list.scrollTop = 0;
  await act(async () => list.dispatchEvent(new Event("scroll", { bubbles: true })));
  expect(position.current).toBe(1200);
  height = 600;
  await view.rerender(render(true, true));
  expect(list.scrollTop).toBe(1200);
  await view.unmount();
});
