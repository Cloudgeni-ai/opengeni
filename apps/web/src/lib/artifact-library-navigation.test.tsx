import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router";
import {
  artifactLibraryFilters,
  artifactLibraryPositionKey,
  artifactLibrarySearch,
  readArtifactLibraryPosition,
  rememberArtifactLibraryPosition,
  useArtifactLibraryPosition,
} from "./artifact-library-navigation";
import { defaultArtifactFilters } from "./artifact-catalog";
import { artifactReturnSearch } from "./routes";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

test("filters round-trip with viewer and session context without adding defaults", () => {
  expect(artifactLibrarySearch(defaultArtifactFilters)).toEqual({});
  const filters = {
    q: "annual report",
    kind: "document",
    sort: "title",
    status: "archived",
  } as const;
  const search = artifactLibrarySearch(filters, "33333333-3333-4333-8333-333333333333", true);
  expect(artifactLibraryFilters(artifactReturnSearch(search))).toEqual(filters);
  expect(search.browse).toBe(true);
  expect(
    artifactLibrarySearch(artifactLibraryFilters(search), search.fromSession).browse,
  ).toBeUndefined();
});

test("invalid raw search is stripped, bounded and never activated as browsing context", () => {
  const search = artifactReturnSearch({
    fromSession: "//evil.test",
    kind: ["image"],
    q: 12,
    sort: "random",
    status: "deleted",
    browse: "true",
  });
  expect(artifactLibraryFilters(search)).toEqual(defaultArtifactFilters);
  expect(search.fromSession).toBeUndefined();
  expect(search.browse).toBeUndefined();
  expect(artifactReturnSearch({ q: "x".repeat(1000) }).q).toHaveLength(500);
});

test("real link serialization preserves JSON-like title searches", () => {
  for (const q of ["123", "true", "null", '"quoted"', "annual & report"]) {
    const filters = { ...defaultArtifactFilters, q, kind: "image" as const };
    const hrefSearch = defaultStringifySearch(artifactLibrarySearch(filters, undefined, true));
    const parsed = artifactReturnSearch(defaultParseSearch(hrefSearch));
    expect(artifactLibraryFilters(parsed)).toEqual(filters);
    expect(parsed.browse).toBe(true);
  }
});

test("positions and loaded pages are bounded and isolated by query, client, workspace and authority", () => {
  const client = {};
  const key = artifactLibraryPositionKey("a", 1, defaultArtifactFilters);
  rememberArtifactLibraryPosition(client, key, { top: 550, pages: 3 });
  expect(readArtifactLibraryPosition(client, key)).toEqual({ top: 550, pages: 3 });
  for (const other of [
    artifactLibraryPositionKey("b", 1, defaultArtifactFilters),
    artifactLibraryPositionKey("a", 2, defaultArtifactFilters),
    artifactLibraryPositionKey("a", 1, { ...defaultArtifactFilters, kind: "image" }),
  ])
    expect(readArtifactLibraryPosition(client, other)).toEqual({ top: 0, pages: 1 });
  expect(readArtifactLibraryPosition({}, key)).toEqual({ top: 0, pages: 1 });
  for (let i = 0; i < 40; i++)
    rememberArtifactLibraryPosition(client, String(i), { top: i, pages: 1 });
  expect(readArtifactLibraryPosition(client, key).top).toBe(0);
});

test("restoration waits for rows, happens once per query and retains pagination", async () => {
  const client = {};
  const key = "images";
  rememberArtifactLibraryPosition(client, key, { top: 550, pages: 3 });
  function View({
    loading,
    count,
    pages,
    query = key,
  }: {
    loading: boolean;
    count: number;
    pages: number;
    query?: string;
  }) {
    const position = useArtifactLibraryPosition(client, query, loading, count, pages);
    return <div {...position} />;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<View loading count={0} pages={0} />));
    expect(host.firstElementChild!.scrollTop).toBe(0);
    expect(readArtifactLibraryPosition(client, key).top).toBe(550);
    await act(async () => root.render(<View loading={false} count={180} pages={3} />));
    const scroller = host.firstElementChild as HTMLElement;
    expect(scroller.scrollTop).toBe(550);
    scroller.scrollTop = 720;
    await act(async () => scroller.dispatchEvent(new Event("scroll")));
    await act(async () => root.render(<View loading={false} count={240} pages={4} />));
    expect(scroller.scrollTop).toBe(720);
    expect(readArtifactLibraryPosition(client, key)).toEqual({ top: 720, pages: 4 });
    await act(async () => root.render(<View loading={false} count={2} pages={1} query="other" />));
    expect(scroller.scrollTop).toBe(0);
    await act(async () => root.render(<View loading={false} count={240} pages={4} />));
    expect(scroller.scrollTop).toBe(720);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("restoration does not consume the saved position while retained pages are loading", async () => {
  const client = {};
  const key = "partial-cache";
  rememberArtifactLibraryPosition(client, key, { top: 2550, pages: 3 });
  function View({ loading, pages }: { loading: boolean; pages: number }) {
    return <div {...useArtifactLibraryPosition(client, key, loading, pages * 60, pages)} />;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<View loading pages={1} />));
    expect(host.firstElementChild!.scrollTop).toBe(0);
    expect(readArtifactLibraryPosition(client, key)).toEqual({ top: 2550, pages: 3 });
    await act(async () => root.render(<View loading={false} pages={3} />));
    expect(host.firstElementChild!.scrollTop).toBe(2550);
    expect(readArtifactLibraryPosition(client, key)).toEqual({ top: 2550, pages: 3 });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("changing clients resets restoration even with the same workspace and credential generation", async () => {
  const firstClient = {};
  const secondClient = {};
  const key = artifactLibraryPositionKey("same-workspace", 0, defaultArtifactFilters);
  rememberArtifactLibraryPosition(firstClient, key, { top: 550, pages: 3 });
  function View({ client }: { client: object }) {
    return <div {...useArtifactLibraryPosition(client, key, false, 180, 3)} />;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<View client={firstClient} />));
    expect(host.firstElementChild!.scrollTop).toBe(550);
    await act(async () => root.render(<View client={secondClient} />));
    expect(host.firstElementChild!.scrollTop).toBe(0);
    expect(readArtifactLibraryPosition(secondClient, key).top).toBe(0);
    expect(readArtifactLibraryPosition(firstClient, key).top).toBe(550);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("an error view preserves saved position and pages until retry succeeds", async () => {
  const client = {};
  const key = "failed-return";
  rememberArtifactLibraryPosition(client, key, { top: 1550, pages: 3 });
  function View({ error }: { error: boolean }) {
    return (
      <div {...useArtifactLibraryPosition(client, key, error, error ? 0 : 180, error ? 0 : 3)} />
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<View error />));
    await act(async () => host.firstElementChild!.dispatchEvent(new Event("scroll")));
    expect(readArtifactLibraryPosition(client, key)).toEqual({ top: 1550, pages: 3 });
    await act(async () => root.render(<View error={false} />));
    expect(host.firstElementChild!.scrollTop).toBe(1550);
    await act(async () => root.render(<View error />));
    expect(readArtifactLibraryPosition(client, key)).toEqual({ top: 1550, pages: 3 });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
