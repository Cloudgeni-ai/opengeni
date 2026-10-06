import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ArtifactCatalogItem, ArtifactCatalogListResponse } from "@opengeni/sdk";
import { artifactRoute } from "@/lib/artifact-catalog";

let ArtifactBrowseControls: typeof import("./artifact-browse-controls").ArtifactBrowseControls;
let context: { client: ReturnType<typeof catalogClient>; accessKeyVersion: number };
mock.module("@/context", () => ({ useAppContext: () => context }));

let ownsDom = false;
let previousActEnvironment: PropertyDescriptor | undefined;
beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register({ url: "https://example.test" });
  previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  ({ ArtifactBrowseControls } = await import("./artifact-browse-controls"));
});
afterAll(async () => {
  if (ownsDom) await GlobalRegistrator.unregister();
  if (previousActEnvironment)
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

const workspaceId = "workspace";
const sessionId = "cf39f8d3-673f-43c0-9f98-c2787fdcf84e";
const libraryPath = `/workspaces/${workspaceId}/artifacts`;
const item = (id: string, kind: ArtifactCatalogItem["kind"] = "site"): ArtifactCatalogItem => ({
  id,
  kind,
  title: id,
  status: "active",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
});
const path = (entry: ArtifactCatalogItem) =>
  artifactRoute(entry.kind).replace("$workspaceId", workspaceId).replace("$artifactId", entry.id);
type Request = {
  workspaceId: string;
  options: { q?: string; kind?: string; sort?: string; status?: string; cursor?: string };
  resolve: (page: ArtifactCatalogListResponse) => void;
  reject: (error: unknown) => void;
};
function catalogClient(requests: Request[]) {
  return {
    listArtifactCatalog: (requestedWorkspace: string, options: Request["options"]) =>
      new Promise<ArtifactCatalogListResponse>((resolve, reject) =>
        requests.push({ workspaceId: requestedWorkspace, options, resolve, reject }),
      ),
  };
}

async function mount(entry = item("one"), query = "?browse=true") {
  const requests: Request[] = [];
  context = { client: catalogClient(requests), accessKeyVersion: 0 };
  const rootRoute = createRootRoute({ component: Outlet });
  const list = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workspaces/$workspaceId/artifacts",
    component: () => <h1>Artifacts</h1>,
  });
  function Detail() {
    const params = useParams({ strict: false }) as { workspaceId: string; artifactId: string };
    return (
      <ArtifactBrowseControls workspaceId={params.workspaceId} artifactId={params.artifactId} />
    );
  }
  const routes = ["site", "file", "document"].map((kind) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: artifactRoute(kind as ArtifactCatalogItem["kind"]),
      component: Detail,
    }),
  );
  const history = createMemoryHistory({
    initialEntries: [libraryPath, `${path(entry)}${query}`],
    initialIndex: 1,
  });
  const router = createRouter({ routeTree: rootRoute.addChildren([list, ...routes]), history });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let mounted = true;
  await act(async () => {
    await router.load();
    root.render(<RouterProvider router={router} />);
  });
  return {
    requests,
    router,
    history,
    container,
    control: (name: "Previous" | "Next") =>
      container.querySelector<HTMLElement>(`[aria-label="${name} artifact"]`)!,
    resolve: async (
      items: ArtifactCatalogItem[],
      nextCursor: string | null = null,
      request = requests.at(-1)!,
    ) => {
      await act(async () => request.resolve({ items, nextCursor }));
    },
    dispose: async () => {
      if (mounted) await act(async () => root.unmount());
      mounted = false;
      container.remove();
    },
  };
}

async function key(
  target: EventTarget,
  keyName = "ArrowRight",
  options: KeyboardEventInit = {},
  prevented = false,
) {
  const event = new KeyboardEvent("keydown", {
    key: keyName,
    bubbles: true,
    cancelable: true,
    composed: true,
    ...options,
  });
  if (prevented) event.preventDefault();
  await act(async () => target.dispatchEvent(event));
  return event;
}

for (const query of ["", "?browse=false", "?browse=%22true%22"]) {
  test(`direct links hide controls and never fetch a list (${query || "no search"})`, async () => {
    const view = await mount(item("one"), query);
    try {
      expect(view.container.textContent).toBe("");
      expect(view.requests).toHaveLength(0);
      expect((await key(document.body)).defaultPrevented).toBe(false);
    } finally {
      await view.dispose();
    }
  });
}

test("loading, first and last boundaries stay unavailable without wrapping", async () => {
  const view = await mount();
  try {
    expect(view.control("Previous").hasAttribute("disabled")).toBe(true);
    expect(view.control("Next").hasAttribute("disabled")).toBe(true);
    expect(view.container.textContent).toContain("Loading artifacts…");
    await view.resolve([item("one"), item("two")]);
    expect(view.control("Previous").title).toBe("First artifact in this list.");
    expect(view.container.textContent).toContain("1 of 2");
    expect((await key(document.body, "ArrowLeft")).defaultPrevented).toBe(false);
    await act(async () => view.control("Next").click());
    expect(view.router.state.location.pathname).toBe(path(item("two")));
    expect(view.control("Next").hasAttribute("disabled")).toBe(true);
    expect(view.control("Next").title).toBe("Last artifact in this list.");
    expect(view.container.textContent).toContain("2 of 2");
    expect((await key(document.body)).defaultPrevented).toBe(false);
    expect(view.requests).toHaveLength(1);
  } finally {
    await view.dispose();
  }
});

test("a single item disables both directions; absent items never invent a position", async () => {
  const view = await mount();
  try {
    await view.resolve([item("one")]);
    expect(view.control("Previous").hasAttribute("disabled")).toBe(true);
    expect(view.control("Next").hasAttribute("disabled")).toBe(true);
    expect(view.container.textContent).toContain("1 of 1");
    await act(async () =>
      view.router.navigate({
        to: artifactRoute("site"),
        params: { workspaceId, artifactId: "missing" },
        search: { browse: true } as never,
      }),
    );
    expect(view.container.textContent).toContain("Not in loaded list");
    expect(view.control("Previous").title).toBe("This artifact is not in the loaded list.");
    expect(view.control("Next").hasAttribute("disabled")).toBe(true);
    expect((await key(document.body)).defaultPrevented).toBe(false);
  } finally {
    await view.dispose();
  }
});

for (const [kind, position] of [
  ["site", 1],
  ["document", 2],
  ["file", 3],
] as const) {
  test(`${kind} uses pathname kind plus ID, not an ID-only match`, async () => {
    const view = await mount(item("same", kind));
    try {
      await view.resolve([item("same", "site"), item("same", "document"), item("same", "file")]);
      expect(view.container.textContent).toContain(`${position} of 3`);
      if (kind === "document") {
        expect(view.control("Previous").getAttribute("href")).toContain(path(item("same", "site")));
        expect(view.control("Next").getAttribute("href")).toContain(path(item("same", "file")));
      }
    } finally {
      await view.dispose();
    }
  });
}

test("filtered server order, search and session provenance survive siblings; Back returns to the list", async () => {
  const view = await mount(
    item("z", "document"),
    `?browse=true&kind=document&q=quarterly%20plan&sort=title&status=archived&fromSession=${sessionId}`,
  );
  try {
    expect(view.requests[0]!.workspaceId).toBe(workspaceId);
    expect(view.requests[0]!.options).toMatchObject({
      kind: "document",
      q: "quarterly plan",
      sort: "title",
      status: "archived",
    });
    await view.resolve([item("z", "document"), item("a", "document"), item("m", "document")]);
    const href = new URL(view.control("Next").getAttribute("href")!, "https://example.test");
    expect(href.pathname).toBe(path(item("a", "document")));
    expect(href.searchParams.get("fromSession")).toBe(sessionId);
    expect(href.searchParams.get("browse")).toBe("true");
    await act(async () => view.control("Next").click());
    expect(view.router.state.location.search).toEqual({
      browse: true,
      kind: "document",
      q: "quarterly plan",
      sort: "title",
      status: "archived",
      fromSession: sessionId,
    });
    await act(async () => view.control("Next").click());
    expect(view.router.state.location.pathname).toBe(path(item("m", "document")));
    expect(view.history.length).toBe(2);
    await act(async () => {
      view.history.back();
      await view.router.load();
    });
    expect(view.router.state.location.pathname).toBe(libraryPath);
  } finally {
    await view.dispose();
  }
});

test("default filters are omitted and modified clicks retain real hrefs", async () => {
  const view = await mount();
  try {
    await view.resolve([item("one"), item("two", "file")]);
    expect(view.control("Next").getAttribute("href")).toBe(
      `${path(item("two", "file"))}?browse=true`,
    );
    for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"] as const) {
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        [modifier]: true,
      });
      await act(async () => view.control("Next").dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      expect(view.router.state.location.pathname).toBe(path(item("one")));
    }
  } finally {
    await view.dispose();
  }
});

test("arrows navigate from body, page title and the controls' own focus", async () => {
  const view = await mount();
  const title = document.createElement("h1");
  title.dataset.slot = "detail-page-title";
  title.tabIndex = -1;
  document.body.append(title);
  try {
    await view.resolve([item("one"), item("two"), item("three")]);
    expect((await key(document.body)).defaultPrevented).toBe(true);
    expect(view.router.state.location.pathname).toBe(path(item("two")));
    view.control("Next").focus();
    expect((await key(view.control("Next"))).defaultPrevented).toBe(true);
    expect(view.router.state.location.pathname).toBe(path(item("three")));
    title.focus();
    expect((await key(title, "ArrowLeft")).defaultPrevented).toBe(true);
    expect(view.router.state.location.pathname).toBe(path(item("two")));
  } finally {
    title.remove();
    await view.dispose();
  }
});

test("modifiers, repeats, composition and prevented events are untouched", async () => {
  const view = await mount();
  try {
    await view.resolve([item("one"), item("two")]);
    for (const options of [
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { shiftKey: true },
      { repeat: true },
      { isComposing: true },
      { keyCode: 229 },
    ]) {
      expect((await key(document.body, "ArrowRight", options)).defaultPrevented).toBe(false);
      expect(view.router.state.location.pathname).toBe(path(item("one")));
    }
    await key(document.body, "ArrowRight", {}, true);
    expect(view.router.state.location.pathname).toBe(path(item("one")));
    expect((await key(document.body, "ArrowDown")).defaultPrevented).toBe(false);
  } finally {
    await view.dispose();
  }
});

test("typing, editors, ARIA widgets, unrelated controls and embedded content keep their arrows", async () => {
  const view = await mount();
  try {
    await view.resolve([item("one"), item("two")]);
    for (const tag of [
      "input",
      "textarea",
      "select",
      "button",
      "a",
      "iframe",
      "object",
      "embed",
      "video",
    ]) {
      const element = document.createElement(tag);
      element.tabIndex = 0;
      document.body.append(element);
      try {
        element.focus();
        expect((await key(element)).defaultPrevented).toBe(false);
        expect((await key(window)).defaultPrevented).toBe(false);
        expect(view.router.state.location.pathname).toBe(path(item("one")));
      } finally {
        element.remove();
      }
    }
    for (const role of [
      "textbox",
      "slider",
      "spinbutton",
      "grid",
      "treegrid",
      "tablist",
      "menu",
      "menubar",
      "listbox",
      "combobox",
    ]) {
      const widget = document.createElement("div");
      widget.setAttribute("role", role);
      view.container.prepend(widget);
      const controls = view.container.querySelector("nav")!;
      widget.append(controls);
      view.control("Next").focus();
      expect((await key(view.control("Next"))).defaultPrevented).toBe(false);
      view.container.append(controls);
      widget.remove();
    }
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.tabIndex = 0;
    document.body.append(editor);
    editor.focus();
    expect((await key(editor)).defaultPrevented).toBe(false);
    editor.remove();
    expect(view.router.state.location.pathname).toBe(path(item("one")));
  } finally {
    await view.dispose();
  }
});

test("an open dialog/lightbox blocks page shortcuts; a hidden dialog does not", async () => {
  const view = await mount();
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  document.body.append(dialog);
  try {
    await view.resolve([item("one"), item("two")]);
    expect((await key(document.body)).defaultPrevented).toBe(false);
    expect(view.router.state.location.pathname).toBe(path(item("one")));
    dialog.hidden = true;
    expect((await key(document.body)).defaultPrevented).toBe(true);
    expect(view.router.state.location.pathname).toBe(path(item("two")));
  } finally {
    dialog.remove();
    await view.dispose();
  }
});

test("Next at the loaded boundary fetches once, disables safely and opens the first appended item", async () => {
  const view = await mount(item("two"));
  try {
    await view.resolve([item("one"), item("two")], "page-2");
    expect(view.container.textContent).toContain("2 of 2 loaded");
    expect(view.control("Next").hasAttribute("disabled")).toBe(false);
    expect((await key(document.body)).defaultPrevented).toBe(true);
    expect(view.requests).toHaveLength(2);
    expect(view.requests[1]!.options.cursor).toBe("page-2");
    expect(view.control("Next").hasAttribute("disabled")).toBe(true);
    expect(view.control("Previous").hasAttribute("disabled")).toBe(true);
    expect(view.container.querySelector("nav")!.getAttribute("aria-busy")).toBe("true");
    expect((await key(document.body)).defaultPrevented).toBe(false);
    expect(view.router.state.location.pathname).toBe(path(item("two")));
    await view.resolve([item("three", "document"), item("four")], "page-3");
    expect(view.router.state.location.pathname).toBe(path(item("three", "document")));
    expect(view.router.state.location.search).toEqual({ browse: true });
    expect(view.container.textContent).toContain("3 of 4 loaded");
    expect(view.history.length).toBe(2);
    expect(view.requests).toHaveLength(2);
  } finally {
    await view.dispose();
  }
});

test("pagination errors and duplicate-only pages never strand or wrap navigation", async () => {
  const view = await mount();
  try {
    await view.resolve([item("one")], "page-2");
    await act(async () => view.control("Next").click());
    await act(async () => view.requests[1]!.reject(new TypeError("Offline")));
    expect(view.control("Next").hasAttribute("disabled")).toBe(false);
    expect(view.control("Next").title).toContain("Try again");
    await act(async () => view.control("Next").click());
    await view.resolve([item("one")]);
    expect(view.router.state.location.pathname).toBe(path(item("one")));
    expect(view.control("Next").hasAttribute("disabled")).toBe(true);
    expect(view.control("Next").title).toBe("Last artifact in this list.");
  } finally {
    await view.dispose();
  }
});

test("Next follows empty and duplicate-only cursor pages until a sibling arrives", async () => {
  const view = await mount();
  try {
    await view.resolve([item("one")], "page-2");
    await act(async () => view.control("Next").click());
    await view.resolve([], "page-3");
    expect(view.requests).toHaveLength(3);
    expect(view.requests[2]!.options.cursor).toBe("page-3");
    expect(view.control("Next").hasAttribute("disabled")).toBe(true);
    expect(view.container.textContent).toContain("1 of 1 loaded");
    await view.resolve([item("one")], "page-4");
    expect(view.requests).toHaveLength(4);
    expect(view.requests[3]!.options.cursor).toBe("page-4");
    expect(view.router.state.location.pathname).toBe(path(item("one")));
    await view.resolve([item("two", "file")], "page-5");
    expect(view.router.state.location.pathname).toBe(path(item("two", "file")));
    expect(view.container.textContent).toContain("2 of 2 loaded");
    expect(view.history.length).toBe(2);
    expect(view.requests).toHaveLength(4);
  } finally {
    await view.dispose();
  }
});

test("an empty cursor chain reaching EOF leaves Next truthfully unavailable", async () => {
  const view = await mount();
  try {
    await view.resolve([item("one")], "page-2");
    await act(async () => view.control("Next").click());
    await view.resolve([], "page-3");
    expect(view.requests).toHaveLength(3);
    await view.resolve([]);
    expect(view.router.state.location.pathname).toBe(path(item("one")));
    expect(view.control("Next").hasAttribute("disabled")).toBe(true);
    expect(view.control("Next").title).toBe("Last artifact in this list.");
    expect(view.container.querySelector("nav")!.getAttribute("aria-busy")).toBe("false");
  } finally {
    await view.dispose();
  }
});

test("a repeated empty cursor never starts an automatic fetch loop", async () => {
  const view = await mount();
  try {
    await view.resolve([item("one")], "page-2");
    await act(async () => view.control("Next").click());
    await view.resolve([], "page-2");
    expect(view.requests).toHaveLength(2);
    expect(view.router.state.location.pathname).toBe(path(item("one")));
    expect(view.container.querySelector("nav")!.getAttribute("aria-busy")).toBe("false");
  } finally {
    await view.dispose();
  }
});

test("a delayed page cannot navigate after unmount", async () => {
  const view = await mount();
  try {
    await view.resolve([item("one")], "page-2");
    await act(async () => view.control("Next").click());
    await view.resolve([], "page-3");
    expect(view.requests).toHaveLength(3);
    const delayed = view.requests[2]!;
    await view.dispose();
    await view.resolve([item("two")], null, delayed);
    expect(view.router.state.location.pathname).toBe(path(item("one")));
    expect((await key(document.body)).defaultPrevented).toBe(false);
  } finally {
    await view.dispose();
  }
});

test("an access denial clears the list and disables navigation truthfully", async () => {
  const view = await mount();
  try {
    await view.resolve([item("one")], "page-2");
    await act(async () => view.control("Next").click());
    await act(async () =>
      view.requests[1]!.reject(Object.assign(new Error("Access denied"), { status: 403 })),
    );
    expect(view.container.textContent).toContain("List unavailable");
    expect(view.control("Previous").hasAttribute("disabled")).toBe(true);
    expect(view.control("Next").hasAttribute("disabled")).toBe(true);
    expect(view.control("Next").title).toContain("Return to Artifacts to retry");
    expect((await key(document.body)).defaultPrevented).toBe(false);
    expect(view.router.state.location.pathname).toBe(path(item("one")));
  } finally {
    await view.dispose();
  }
});

test("a delayed page cannot redirect an artifact opened while pagination was pending", async () => {
  const view = await mount(item("two"));
  try {
    await view.resolve([item("one"), item("two")], "page-2");
    await act(async () => view.control("Next").click());
    const delayed = view.requests[1]!;
    await act(async () =>
      view.router.navigate({
        to: artifactRoute("site"),
        params: { workspaceId, artifactId: "one" },
        search: { browse: true } as never,
      }),
    );
    await view.resolve([item("three")], null, delayed);
    expect(view.router.state.location.pathname).toBe(path(item("one")));
    expect(view.container.textContent).toContain("1 of 3");
  } finally {
    await view.dispose();
  }
});

test("a delayed page cannot navigate after changing filters", async () => {
  const view = await mount();
  try {
    await view.resolve([item("one")], "page-2");
    await act(async () => view.control("Next").click());
    const delayed = view.requests[1]!;
    await act(async () =>
      view.router.navigate({
        to: artifactRoute("site"),
        params: { workspaceId, artifactId: "one" },
        search: { browse: true, q: "new" } as never,
      }),
    );
    expect(view.requests).toHaveLength(3);
    await view.resolve([item("old-next")], null, delayed);
    await view.resolve([item("one"), item("new-next")]);
    expect(view.router.state.location.pathname).toBe(path(item("one")));
    expect(view.router.state.location.search).toEqual({ browse: true, q: "new" });
  } finally {
    await view.dispose();
  }
});
