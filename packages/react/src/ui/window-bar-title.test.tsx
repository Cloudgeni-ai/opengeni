import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

// Which header the macOS window bar shows when a page opens in front of a
// page that stays mounted, hidden (the Capabilities catalog under Slack).
let ownsDom = false;
let previousActEnvironment: PropertyDescriptor | undefined;
let React: typeof import("react");
let ReactDomClient: typeof import("react-dom/client");
let titles: typeof import("./window-bar-title");
let windowBar: typeof import("../app/components/window-bar");
beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register({ url: "https://example.test" });
  previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ReactDomClient = await import("react-dom/client");
  titles = await import("./window-bar-title");
  windowBar = await import("../app/components/window-bar");
});
afterAll(async () => {
  if (ownsDom) await GlobalRegistrator.unregister();
  if (previousActEnvironment)
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

function Header({ title }: { title: string }) {
  const inBar = titles.useWindowBarTitle(title);
  return <h1 className={inBar ? "sr-only" : undefined}>{title}</h1>;
}

/** The catalog stays mounted and hidden while a page is open in front of it. */
function Catalog({
  pageOpen,
  boundary,
  page = "Slack",
}: {
  pageOpen: boolean;
  boundary: boolean;
  /** The open page's header; null for a page without one (loading, errors). */
  page?: string | null;
}) {
  const header = <Header title="Capabilities" />;
  return (
    <windowBar.WindowBarPageTitle enabled>
      {pageOpen && page ? <Header key={page} title={page} /> : null}
      <div hidden={pageOpen}>
        {boundary ? (
          <titles.WindowBarTitleBoundary fallback>{header}</titles.WindowBarTitleBoundary>
        ) : (
          header
        )}
      </div>
    </windowBar.WindowBarPageTitle>
  );
}

async function mount(node: ReactNode, check: (view: View) => Promise<void>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = ReactDomClient.createRoot(host);
  try {
    await React.act(async () => root.render(node));
    await check({
      bar: () => host.querySelector("[data-window-bar-title]")?.textContent ?? null,
      render: (next: ReactNode) => React.act(async () => root.render(next)),
    });
  } finally {
    await React.act(async () => root.unmount());
    host.remove();
  }
}

type View = { bar(): string | null; render(next: ReactNode): Promise<void> };

test("a page opened in front of a hidden, mounted page takes the window bar", async () => {
  await mount(<Catalog pageOpen={false} boundary />, async (view) => {
    expect(view.bar()).toBe("Capabilities");
    await view.render(<Catalog pageOpen boundary />);
    expect(view.bar()).toBe("Slack");
    // A page that replaces the open one (the Slack agent form) takes the bar too.
    await view.render(<Catalog pageOpen boundary page="New Slack agent" />);
    expect(view.bar()).toBe("New Slack agent");
    await view.render(<Catalog pageOpen={false} boundary />);
    expect(view.bar()).toBe("Capabilities");
    await view.render(<Catalog pageOpen boundary />);
    expect(view.bar()).toBe("Slack");
  });
});

test("a page without a header (loading, errors) leaves the hidden page's title", async () => {
  await mount(<Catalog pageOpen={false} boundary />, async (view) => {
    await view.render(<Catalog pageOpen boundary page={null} />);
    expect(view.bar()).toBe("Capabilities");
    // The page's header arrives once it has loaded.
    await view.render(<Catalog pageOpen boundary page="Slack" />);
    expect(view.bar()).toBe("Slack");
  });
});

test("claims go in mount order, so a hidden header mounted first keeps the bar", async () => {
  // Documents the rule the boundary works around, not a desired outcome.
  await mount(<Catalog pageOpen={false} boundary={false} />, async (view) => {
    await view.render(<Catalog pageOpen boundary={false} />);
    expect(view.bar()).toBe("Capabilities");
  });
});

test("a boundary without `fallback` always keeps headers out of the bar", async () => {
  await mount(
    <windowBar.WindowBarPageTitle enabled fallbackTitle="Fallback">
      <titles.WindowBarTitleBoundary>
        <Header title="In a dialog" />
      </titles.WindowBarTitleBoundary>
    </windowBar.WindowBarPageTitle>,
    async (view) => {
      expect(view.bar()).toBe("Fallback");
    },
  );
});

test("inside the hidden page, dialogs never take the bar and pages outside the boundary do", async () => {
  // Skill, plugin and bundle pages render inside the catalog's tree (portaled
  // out), outside the header's boundary; its dialogs have a boundary of their own.
  const Tree = ({ dialog, page }: { dialog: boolean; page: string | null }) => (
    <windowBar.WindowBarPageTitle enabled>
      <div hidden={page !== null}>
        <titles.WindowBarTitleBoundary fallback>
          <Header title="Capabilities" />
          {dialog ? (
            <titles.WindowBarTitleBoundary>
              <Header title="A dialog" />
            </titles.WindowBarTitleBoundary>
          ) : null}
        </titles.WindowBarTitleBoundary>
        {page ? <Header key={page} title={page} /> : null}
      </div>
    </windowBar.WindowBarPageTitle>
  );
  await mount(<Tree dialog page={null} />, async (view) => {
    expect(view.bar()).toBe("Capabilities");
    await view.render(<Tree dialog page="A skill" />);
    expect(view.bar()).toBe("A skill");
    await view.render(<Tree dialog={false} page={null} />);
    expect(view.bar()).toBe("Capabilities");
  });
});
