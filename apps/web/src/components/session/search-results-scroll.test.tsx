import { expect, test } from "bun:test";
import { act } from "react";
import { SearchResultsView, SearchPreviewView } from "./search-results-view";
import {
  registerDom,
  renderComponent,
  flush,
} from "../../../../../packages/react/test/render-hook";

registerDom();

test("transient result and preview warnings preserve content and retry independently", async () => {
  let resultRetries = 0;
  let previewRetries = 0;
  let opened = 0;
  const view = await renderComponent(
    <>
      <SearchResultsView
        query="needle"
        results={[
          {
            sessionId: "s",
            title: "needle title",
            subtitle: "",
            snippet: "",
            matchingMessages: 0,
            titleMatch: true,
          },
        ]}
        selectedId="s"
        onSelect={() => {}}
        loading={false}
        error="Message search unavailable"
        onRetry={() => resultRetries++}
        hasMore={false}
        onMore={() => {}}
      />
      <SearchPreviewView
        title="needle title"
        query="needle"
        messages={[{ key: "e", role: "user", text: "saved needle passage", selected: true }]}
        loading
        error="Context unavailable"
        onRetry={() => previewRetries++}
        onOpen={() => opened++}
        onBack={() => {}}
        onPrevious={() => {}}
        onNext={() => {}}
        previousDisabled
        nextDisabled
        counter="1 of 1"
        titleOnly={false}
      />
    </>,
  );
  expect(view.container.querySelectorAll("[data-search-result]").length).toBe(1);
  expect(view.container.textContent).toContain("saved needle passage");
  expect(view.container.textContent).not.toContain("No matching sessions");
  expect(view.container.querySelectorAll('[role="alert"]').length).toBe(2);
  const click = async (text: string) =>
    act(async () =>
      [...view.container.querySelectorAll("button")]
        .find((button) => button.textContent?.includes(text))!
        .click(),
    );
  await click("Retry search");
  expect(resultRetries).toBe(1);
  expect(previewRetries).toBe(0);
  await click("Retry preview");
  expect(resultRetries).toBe(1);
  expect(previewRetries).toBe(1);
  await click("Open here");
  expect(opened).toBe(1);
  await view.unmount();
});

test("live result revisions cannot undo a DOM scroll before its event; query resets still restore", async () => {
  const position = { current: 0 };
  const render = (query = "harborlight") => (
    <SearchResultsView
      query={query}
      results={[
        {
          sessionId: "1",
          title: query,
          subtitle: "",
          snippet: "",
          matchingMessages: 0,
          titleMatch: true,
        },
      ]}
      selectedId="1"
      onSelect={() => {}}
      loading
      error={null}
      onRetry={() => {}}
      hasMore={false}
      onMore={() => {}}
      scrollPosition={position}
    />
  );
  const view = await renderComponent(render());
  const list = view.container.querySelector<HTMLDivElement>('[aria-label="Matching sessions"]')!;
  Object.defineProperties(list, { clientHeight: { value: 600 }, scrollHeight: { value: 2500 } });
  await view.rerender(render());
  // Native scroll delivery is asynchronous: a new partial batch may render
  // after the browser moved the pane but before React receives its event.
  list.scrollTop = 1109;
  await view.rerender(render());
  expect(list.scrollTop).toBe(1109);
  await act(async () => list.dispatchEvent(new Event("scroll", { bubbles: true })));
  expect(position.current).toBe(1109);
  await view.rerender(render());
  expect(list.scrollTop).toBe(1109);
  position.current = 0;
  await view.rerender(render("new query"));
  expect(list.scrollTop).toBe(0);
  list.scrollTop = 800;
  await act(async () => list.dispatchEvent(new Event("scroll", { bubbles: true })));
  position.current = 0; // An explicit page navigation also requests a reset.
  await view.rerender(render("new query"));
  expect(list.scrollTop).toBe(0);
  await view.unmount();
});

test("a pending restore retries on result revisions until the pane has enough layout", async () => {
  const position = { current: 1109 };
  const render = () => (
    <SearchResultsView
      query="harborlight"
      results={[
        {
          sessionId: "1",
          title: "harborlight",
          subtitle: "",
          snippet: "",
          matchingMessages: 0,
          titleMatch: true,
        },
      ]}
      selectedId="1"
      onSelect={() => {}}
      loading
      error={null}
      onRetry={() => {}}
      hasMore={false}
      onMore={() => {}}
      scrollPosition={position}
    />
  );
  const view = await renderComponent(render());
  const list = view.container.querySelector<HTMLDivElement>('[aria-label="Matching sessions"]')!;
  let totalHeight = 800;
  Object.defineProperties(list, {
    clientHeight: { value: 600 },
    scrollHeight: { get: () => totalHeight },
  });
  await view.rerender(render());
  expect(list.scrollTop).toBe(0);
  expect(position.current).toBe(1109);
  totalHeight = 2500;
  await view.rerender(render());
  expect(list.scrollTop).toBe(1109);
  await view.unmount();
});

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
