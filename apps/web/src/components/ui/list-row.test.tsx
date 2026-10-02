import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { ListRow, RowList, type RowListSort } from "./list-row";
import { LogoTile } from "./logo-tile";
import { RelativeTime } from "./relative-time";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

async function mount(node: React.ReactNode): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return { container, root };
}

const NOW = new Date("2026-09-26T11:48:00Z");

describe("ListRow", () => {
  test("the whole row is one button named by the title and the state in words", async () => {
    const onOpen = mock(() => {});
    const { container, root } = await mount(
      <RowList label="Connections">
        <ListRow
          title="Linear"
          description="Sign in again to keep using Linear."
          indicator={{ kind: "attention", label: "Needs reconnect" }}
          onOpen={onOpen}
        />
      </RowList>,
    );
    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    const button = buttons[0]!;
    const name = (button.getAttribute("aria-labelledby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join(" ");
    expect(name).toBe("Linear Needs reconnect");
    const description = document.getElementById(button.getAttribute("aria-describedby")!);
    expect(description?.textContent).toBe("Sign in again to keep using Linear.");
    await act(async () => button.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    container.remove();
  });

  test("a link row keeps its router click handler, so a plain click never loads the page", async () => {
    // Regression: /schedules rows passed `href` and `linkProps.onClick` (the
    // router) but no `onOpen`, and the absent `onOpen` replaced the handler.
    const go = mock(() => {});
    const { container, root } = await mount(
      <RowList label="Schedules">
        <ListRow
          title="Morning digest"
          href="/workspaces/ws-1/schedules?taskId=task-1"
          linkProps={{
            onClick: (event) => {
              event.preventDefault();
              go();
            },
          }}
        />
      </RowList>,
    );
    const link = container.querySelector<HTMLAnchorElement>("a[data-row-action]")!;
    expect(link.getAttribute("href")).toBe("/workspaces/ws-1/schedules?taskId=task-1");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    await act(async () => {
      link.dispatchEvent(click);
    });
    expect(go).toHaveBeenCalledTimes(1);
    expect(click.defaultPrevented).toBe(true);
    await act(async () => root.unmount());
    container.remove();
  });

  test("a link row runs onOpen first and skips linkProps once onOpen handled the click", async () => {
    const onOpen = mock((event: React.MouseEvent<HTMLElement>) => event.preventDefault());
    const linkClick = mock(() => {});
    const { container, root } = await mount(
      <RowList label="Used by">
        <ListRow title="Chat" href="/x" onOpen={onOpen} linkProps={{ onClick: linkClick }} />
      </RowList>,
    );
    const link = container.querySelector<HTMLAnchorElement>("a[data-row-action]")!;
    await act(async () => link.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(linkClick).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    container.remove();
  });

  test("a click on a time inside the row still opens it", async () => {
    const onOpen = mock(() => {});
    const { container, root } = await mount(
      <RowList label="Variable sets">
        <ListRow
          title="AWS production"
          meta={[<RelativeTime key="t" date="2026-09-23T09:12:00Z" now={NOW} prefix="Updated" />]}
          onOpen={onOpen}
        />
      </RowList>,
    );
    const time = container.querySelector("time")!;
    // Rows are the tab stop: times inside them are not.
    expect(time.hasAttribute("tabindex")).toBe(false);
    await act(async () => time.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    container.remove();
  });

  test("a disabled row says why and is not a button", () => {
    const html = renderToStaticMarkup(
      <RowList label="Connections">
        <ListRow
          title="GitHub"
          description="Work on repositories, issues, and pull requests."
          disabled
          disabledReason="GitHub isn't available on this Opengeni server yet. An admin needs to add the GitHub App."
          indicator={{ kind: "unavailable", label: "Unavailable" }}
          onOpen={() => {}}
        />
      </RowList>,
    );
    expect(html).not.toContain("<button");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("An admin needs to add the GitHub App.");
    expect(html).not.toContain("Work on repositories");
  });

  test("the ⋯ menu is its own labelled button, separate from the row target", () => {
    const html = renderToStaticMarkup(
      <RowList label="Schedules">
        <ListRow title="Check AWS cost anomalies" menu={<span>Run now</span>} onOpen={() => {}} />
      </RowList>,
    );
    expect(html).toContain('aria-label="More actions for Check AWS cost anomalies"');
    expect(html.match(/<button/g)).toHaveLength(2);
  });

  test("expand in place announces its state and controls its panel", async () => {
    function Expanding() {
      const [open, setOpen] = useState(false);
      return (
        <RowList label="Variable sets">
          <ListRow
            title="AWS production"
            indicator="expand"
            expanded={open}
            panel={<p>4 variables</p>}
            onOpen={() => setOpen((value) => !value)}
          />
        </RowList>
      );
    }
    const { container, root } = await mount(<Expanding />);
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("4 variables");
    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(button.getAttribute("aria-controls")!);
    expect(panel?.textContent).toBe("4 variables");
    await act(async () => root.unmount());
    container.remove();
  });

  test("meta separators and the narrow copy of the state stay out of the accessible text", () => {
    const html = renderToStaticMarkup(
      <RowList label="Connections" columns={[{ id: "by", label: "Made by", hideLabel: true }]}>
        <ListRow
          title="Linear"
          meta={["2 tools", "Workspace"]}
          cells={{ by: "By Linear" }}
          indicator={{ kind: "attention", label: "Needs reconnect" }}
          onOpen={() => {}}
        />
      </RowList>,
    );
    const container = document.createElement("div");
    container.innerHTML = html;
    // Every part of the one secondary line (two facts, the folded column and
    // the narrow copy of the state) leads with one hidden dot.
    const dots = [...container.querySelectorAll('[aria-hidden="true"]')].filter(
      (node) => node.textContent === "·",
    );
    expect(dots).toHaveLength(4);
    // "Needs reconnect" is announced once, through the row's name.
    const visibleCopies = [...container.querySelectorAll("*")].filter(
      (node) =>
        node.children.length === 0 &&
        node.textContent === "Needs reconnect" &&
        !node.closest('[aria-hidden="true"]'),
    );
    expect(visibleCopies).toHaveLength(1);
  });

  test("the list sizes the leading tile: 40 in catalogs, 32 in resource rows, 24 in tables", () => {
    const sizes = (["catalog", "resource", "table"] as const).map((variant) => {
      const html = renderToStaticMarkup(
        <RowList variant={variant} label="Variable sets">
          <ListRow leading={<LogoTile name="AWS production" />} title="AWS production" />
        </RowList>,
      );
      return html.match(/data-size="(\w+)"/)?.[1];
    });
    expect(sizes).toEqual(["lg", "md", "sm"]);
  });
});

describe("RowList table", () => {
  test("sortable headers expose aria-sort and flip the direction", async () => {
    const changes: RowListSort[] = [];
    function Sortable() {
      const [sort, setSort] = useState<RowListSort>({ column: "name", direction: "asc" });
      return (
        <RowList
          variant="table"
          label="API keys"
          nameSortable
          columns={[{ id: "lastUsed", label: "Last used", sortable: true }]}
          sort={sort}
          onSortChange={(next) => {
            changes.push(next);
            setSort(next);
          }}
        >
          <ListRow title="CI pipeline" cells={{ lastUsed: "2 hours ago" }} />
        </RowList>
      );
    }
    const { container, root } = await mount(<Sortable />);
    const headers = [...container.querySelectorAll('[role="columnheader"]')];
    const name = headers.find((header) => header.textContent === "Name")!;
    const lastUsed = headers.find((header) => header.textContent === "Last used")!;
    expect(name.getAttribute("aria-sort")).toBe("ascending");
    expect(lastUsed.getAttribute("aria-sort")).toBeNull();

    await act(async () => name.querySelector("button")!.click());
    expect(name.getAttribute("aria-sort")).toBe("descending");

    await act(async () => lastUsed.querySelector("button")!.click());
    expect(changes).toEqual([
      { column: "name", direction: "desc" },
      { column: "lastUsed", direction: "asc" },
    ]);
    expect(lastUsed.getAttribute("aria-sort")).toBe("ascending");
    expect(container.querySelectorAll('[role="rowheader"]')).toHaveLength(1);
    await act(async () => root.unmount());
    container.remove();
  });
});
