import { expect, test } from "bun:test";
import { act } from "react";
import { SearchResultsView } from "./search-results-view";
import {
  registerDom,
  renderComponent,
  flush,
} from "../../../../../packages/react/test/render-hook";

registerDom();

test("closed and loading lists cannot erase the saved visible scroll position", async () => {
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
  const render = (active: boolean, loading: boolean) => (
    <SearchResultsView
      query="harborlight"
      results={results}
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
  height = 600;
  await view.rerender(render(true, false));
  await flush(25);
  expect(list.scrollTop).toBe(1109);
  list.scrollTop = 1200;
  await act(async () => list.dispatchEvent(new Event("scroll", { bubbles: true })));
  expect(position.current).toBe(1200);
  await view.rerender(render(false, false));
  height = 0;
  list.scrollTop = 0;
  await act(async () => list.dispatchEvent(new Event("scroll", { bubbles: true })));
  expect(position.current).toBe(1200);
  height = 600;
  await view.rerender(render(true, false));
  expect(list.scrollTop).toBe(1200);
  await view.unmount();
});
