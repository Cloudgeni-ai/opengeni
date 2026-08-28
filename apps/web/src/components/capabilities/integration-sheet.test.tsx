import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { IntegrationRow } from "./integration-row";
import { Sheet } from "@/components/ui/sheet";
import { IntegrationSheetBody, integrationDisclosureElementId } from "./integration-sheet";
import { INTEGRATION_LOCKED_SENTENCE, type IntegrationViewModel } from "./integration-view-model";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function model(overrides: Partial<IntegrationViewModel> = {}): IntegrationViewModel {
  return {
    id: "slack",
    name: "Slack",
    description: "Chat with OpenGeni and start work from Slack.",
    mark: { monogram: "S" },
    chip: { label: "Connected", tone: "ok" },
    connection: [
      { label: "Slack workspace", value: "Acme HQ" },
      { label: "Installed", value: "12 Aug 2026" },
    ],
    access: {
      title: "What OpenGeni can see",
      items: [
        { name: "All public channels", meta: "searchable without joining" },
        { name: "#engineering", meta: "invited" },
      ],
    },
    options: [
      {
        kind: "toggle",
        id: "reaction",
        label: "Start work with a reaction",
        description: "React with :genie: on any message OpenGeni can see.",
        checked: true,
        onChange: () => {},
      },
    ],
    footer: { kind: "connected", onReconnect: () => {}, onDisconnect: () => {} },
    ...overrides,
  };
}

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("IntegrationRow", () => {
  test("uses provider logos when available and the shared monogram fallback otherwise", async () => {
    const rendered = await render(
      <>
        <IntegrationRow
          model={model({
            id: "github",
            name: "GitHub",
            mark: { logoSrc: "https://example.test/github.svg", monogram: "G" },
          })}
          onOpen={() => {}}
        />
        <IntegrationRow
          model={model({ id: "outlook-mail", name: "Outlook Mail", mark: { monogram: "OM" } })}
          onOpen={() => {}}
        />
      </>,
    );
    try {
      const rows = [...rendered.container.querySelectorAll("[data-integration-row]")];
      expect(rows[0]!.className).toContain("hover:bg-accent");
      expect(rows[0]!.querySelector("button")!.className).not.toContain("hover:bg-");
      const logo = rows[0]!.querySelector("img");
      expect(logo?.getAttribute("src")).toBe("https://example.test/github.svg");
      expect(rows[1]!.querySelector("img")).toBeNull();
      expect(rows[1]!.textContent).toContain("OM");

      await act(async () => logo!.dispatchEvent(new Event("error")));
      expect(rows[0]!.querySelector("img")).toBeNull();
      expect(rows[0]!.textContent).toContain("G");
    } finally {
      await rendered.unmount();
    }
  });

  test("renders every integration through the same two-button row shape", async () => {
    const onOpen = mock(() => {});
    const rendered = await render(
      <>
        <IntegrationRow model={model()} onOpen={onOpen} />
        <IntegrationRow
          model={model({
            id: "github",
            name: "GitHub",
            description: "Read code and open pull requests.",
            mark: { logoSrc: "https://example.test/github.svg", monogram: "G" },
            chip: { label: "Not connected", tone: "idle" },
          })}
          onOpen={onOpen}
        />
        <IntegrationRow
          model={model({
            id: "google-drive",
            name: "Google Drive",
            chip: { label: "Set up by an admin", tone: "plain" },
          })}
          onOpen={onOpen}
        />
      </>,
    );
    try {
      const rowContainers = [...rendered.container.querySelectorAll("[data-integration-row]")];
      expect(rowContainers).toHaveLength(3);
      // Every row's body-open button is a real sibling of the state indicator,
      // never nested inside it - one clean click target per row. Its accessible
      // name carries the connection state, so the state is never colour-only.
      for (const row of rowContainers) {
        expect(row.tagName).not.toBe("BUTTON");
        const openButton = row.querySelector("button");
        expect(openButton).not.toBeNull();
        expect(openButton?.querySelector("button")).toBeNull();
      }
      expect(rowContainers[0]?.querySelector("button")?.getAttribute("aria-label")).toBe(
        "Slack. Connected",
      );
      expect(rowContainers[1]?.querySelector("button")?.getAttribute("aria-label")).toBe(
        "GitHub. Not connected",
      );
      expect(rowContainers[2]?.querySelector("button")?.getAttribute("aria-label")).toBe(
        "Google Drive. Set up by an admin",
      );
      // The indicator itself is decorative, so each row still exposes its state
      // as text for assistive tech and forced-colours users.
      expect(rowContainers[0]?.textContent).toContain("Connected");
      expect(rowContainers[2]?.textContent).toContain("Set up by an admin");
      for (const row of rowContainers) {
        expect(row.textContent).not.toContain("scope");
      }
      const openButtons = rowContainers.map(
        (row) => row.querySelector("button") as HTMLButtonElement,
      );
      await act(async () => openButtons[1]!.click());
      expect(onOpen).toHaveBeenCalledTimes(1);
    } finally {
      await rendered.unmount();
    }
  });

  // The row's aria-label replaces its contents, so a caller with a fact that
  // must be heard supplies it as one opaque string; the row branches on nothing.
  test("an optional accessible detail is spoken between the name and the state", async () => {
    const rendered = await render(
      <>
        <IntegrationRow
          model={model({
            id: "pack:infra-ops",
            name: "Infrastructure operations",
            chip: { label: "Not installed", tone: "idle" },
            accessibleDetail: "Pack, curated by OpenGeni",
          })}
          onOpen={() => {}}
        />
        <IntegrationRow
          model={model({ id: "blank-detail", accessibleDetail: "   " })}
          onOpen={() => {}}
        />
      </>,
    );
    try {
      expect(
        rendered.container
          .querySelector('[data-integration-row="pack:infra-ops"] > button')
          ?.getAttribute("aria-label"),
      ).toBe("Infrastructure operations. Pack, curated by OpenGeni. Not installed");
      // Nothing meaningful to add: the name reads exactly as it did before.
      expect(
        rendered.container
          .querySelector('[data-integration-row="blank-detail"] > button')
          ?.getAttribute("aria-label"),
      ).toBe("Slack. Connected");
    } finally {
      await rendered.unmount();
    }
  });

  test("only the not-connected state renders an interactive quick-connect icon", async () => {
    const onOpen = mock(() => {});
    const onQuickConnect = mock(() => {});
    const rendered = await render(
      <>
        <IntegrationRow model={model()} onOpen={onOpen} />
        <IntegrationRow
          model={model({
            id: "github",
            chip: { label: "Not connected", tone: "idle" },
          })}
          onOpen={onOpen}
          onQuickConnect={onQuickConnect}
        />
      </>,
    );
    try {
      const rows = [...rendered.container.querySelectorAll("[data-integration-row]")];
      // Connected: the indicator is decorative, not a button.
      const connectedButtons = [...rows[0]!.querySelectorAll("button")];
      expect(connectedButtons).toHaveLength(1);
      // Not connected with a quick-connect handler: a second, real button.
      const idleButtons = [...rows[1]!.querySelectorAll("button")];
      expect(idleButtons).toHaveLength(2);
      await act(async () => idleButtons[1]!.click());
      expect(onQuickConnect).toHaveBeenCalledTimes(1);
      expect(onOpen).not.toHaveBeenCalled();
    } finally {
      await rendered.unmount();
    }
  });

  test("omits the quick-connect icon entirely when no fast path exists, even if not connected", async () => {
    const rendered = await render(
      <IntegrationRow
        model={model({ chip: { label: "Not connected", tone: "idle" } })}
        onOpen={() => {}}
      />,
    );
    try {
      const row = rendered.container.querySelector("[data-integration-row]")!;
      expect([...row.querySelectorAll("button")]).toHaveLength(1);
    } finally {
      await rendered.unmount();
    }
  });
});

describe("IntegrationSheet", () => {
  test("renders the four blocks in order and omits empty ones", async () => {
    const rendered = await render(
      <Sheet open>
        <IntegrationSheetBody model={model()} />
      </Sheet>,
    );
    try {
      const sheet = document.querySelector('[data-integration-sheet="slack"]')!;
      expect(sheet).not.toBeNull();
      const headings = [...sheet.querySelectorAll("h3")].map((node) => node.textContent);
      expect(headings).toEqual(["Connection", "What OpenGeni can see", "Options"]);
      expect(sheet.querySelector("h2, [data-slot=sheet-title]")?.textContent).toBe("Slack");
      const toggle = sheet.querySelector('[role="switch"]');
      expect(toggle?.getAttribute("aria-checked")).toBe("true");
      const buttons = [...sheet.querySelectorAll("button")].map((node) => node.textContent?.trim());
      expect(buttons).toContain("Reconnect");
      expect(buttons).toContain("Disconnect");
      expect(sheet.textContent).not.toContain("Set up");
    } finally {
      await rendered.unmount();
    }
  });

  test("renders the closed footer set for setup and locked states", async () => {
    const onSetup = mock(() => {});
    const setup = await render(
      <Sheet open>
        <IntegrationSheetBody
          model={model({
            id: "atlassian",
            name: "Jira & Confluence",
            chip: { label: "Not connected", tone: "idle" },
            connection: [],
            access: undefined,
            options: [],
            footer: { kind: "setup", onSetup },
          })}
        />
      </Sheet>,
    );
    try {
      const sheet = document.querySelector('[data-integration-sheet="atlassian"]')!;
      expect([...sheet.querySelectorAll("h3")]).toHaveLength(0);
      const setupButton = [...sheet.querySelectorAll("button")].find(
        (node) => node.textContent?.trim() === "Set up",
      );
      expect(setupButton).toBeDefined();
      await act(async () => setupButton!.click());
      expect(onSetup).toHaveBeenCalledTimes(1);
    } finally {
      await setup.unmount();
    }

    const locked = await render(
      <Sheet open>
        <IntegrationSheetBody
          model={model({
            id: "github",
            name: "GitHub",
            chip: { label: "Set up by an admin", tone: "plain" },
            options: [],
            footer: { kind: "locked" },
          })}
        />
      </Sheet>,
    );
    try {
      const sheet = document.querySelector('[data-integration-sheet="github"]')!;
      expect(sheet.textContent).toContain(INTEGRATION_LOCKED_SENTENCE);
      expect(
        [...sheet.querySelectorAll("button")].map((node) => node.textContent?.trim()),
      ).not.toContain("Disconnect");
    } finally {
      await locked.unmount();
    }
  });

  // The Bundle footer: a surface whose real verbs are not connect/disconnect.
  test("renders the actions footer a Bundle needs, with its unavailability reason", async () => {
    const onUpdate = mock(() => {});
    const onRemove = mock(() => {});
    const rendered = await render(
      <Sheet open>
        <IntegrationSheetBody
          model={model({
            id: "bundle-skill-release-operator",
            name: "release-operator",
            chip: { label: "Installed", tone: "ok" },
            access: undefined,
            options: [],
            footer: {
              kind: "actions",
              primary: { label: "Check for update", onClick: onUpdate },
              secondary: { label: "Remove", onClick: onRemove, destructive: true },
            },
          })}
        />
      </Sheet>,
    );
    try {
      const sheet = document.querySelector(
        '[data-integration-sheet="bundle-skill-release-operator"]',
      )!;
      // Neither of the connection verbs appears: a Bundle is not connected.
      const labels = [...sheet.querySelectorAll("button")].map((node) => node.textContent?.trim());
      expect(labels).toContain("Check for update");
      expect(labels).toContain("Remove");
      expect(labels).not.toContain("Reconnect");
      expect(labels).not.toContain("Disconnect");
      expect(labels).not.toContain("Set up");

      const update = [...sheet.querySelectorAll("button")].find(
        (node) => node.textContent?.trim() === "Check for update",
      )!;
      const remove = [...sheet.querySelectorAll("button")].find(
        (node) => node.textContent?.trim() === "Remove",
      )!;
      await act(async () => update.click());
      await act(async () => remove.click());
      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(onRemove).toHaveBeenCalledTimes(1);
    } finally {
      await rendered.unmount();
    }

    // A Plugin that never retained a source URL: the button stays visible and
    // says why it cannot run, rather than silently doing nothing.
    const unavailable = await render(
      <Sheet open>
        <IntegrationSheetBody
          model={model({
            id: "bundle-plugin-research",
            name: "Research suite",
            chip: { label: "Installed", tone: "ok" },
            access: undefined,
            options: [],
            footer: {
              kind: "actions",
              primary: {
                label: "Review update",
                onClick: onUpdate,
                disabled: true,
                unavailableReason: "This installed Plugin did not retain a source URL.",
              },
              secondary: { label: "Remove", onClick: onRemove, destructive: true },
            },
          })}
        />
      </Sheet>,
    );
    try {
      const sheet = document.querySelector('[data-integration-sheet="bundle-plugin-research"]')!;
      const review = [...sheet.querySelectorAll("button")].find(
        (node) => node.textContent?.trim() === "Review update",
      )! as HTMLButtonElement;
      expect(review.disabled).toBe(true);
      expect(review.title).toBe("This installed Plugin did not retain a source URL.");
      await act(async () => review.click());
      expect(onUpdate).toHaveBeenCalledTimes(1);
    } finally {
      await unavailable.unmount();
    }
  });

  test("a busy actions footer disables both of its verbs", async () => {
    const onUpdate = mock(() => {});
    const onRemove = mock(() => {});
    const rendered = await render(
      <Sheet open>
        <IntegrationSheetBody
          model={model({
            id: "bundle-busy",
            access: undefined,
            options: [],
            footer: {
              kind: "actions",
              primary: { label: "Check for update", onClick: onUpdate },
              secondary: { label: "Remove", onClick: onRemove, destructive: true },
              busy: true,
            },
          })}
        />
      </Sheet>,
    );
    try {
      const sheet = document.querySelector('[data-integration-sheet="bundle-busy"]')!;
      for (const label of ["Check for update", "Remove"]) {
        const node = [...sheet.querySelectorAll("button")].find(
          (candidate) => candidate.textContent?.trim() === label,
        )! as HTMLButtonElement;
        expect(node.disabled).toBe(true);
      }
      expect(onUpdate).not.toHaveBeenCalled();
      expect(onRemove).not.toHaveBeenCalled();
    } finally {
      await rendered.unmount();
    }
  });

  test("locked footers render the adapter-supplied sentence when given", async () => {
    const rendered = await render(
      <Sheet open>
        <IntegrationSheetBody
          model={model({
            options: [],
            footer: { kind: "locked", message: "Connection management permission is required." },
          })}
        />
      </Sheet>,
    );
    try {
      const sheet = document.querySelector('[data-integration-sheet="slack"]')!;
      expect(sheet.textContent).toContain("Connection management permission is required.");
      expect(sheet.textContent).not.toContain(INTEGRATION_LOCKED_SENTENCE);
    } finally {
      await rendered.unmount();
    }
  });

  test("disclosures render in a fixed place and affordances point at them", async () => {
    const rendered = await render(
      <Sheet open>
        <IntegrationSheetBody
          model={model({
            options: [
              {
                kind: "toggle",
                id: "publish",
                label: "Publish finished documents",
                checked: false,
                disclosureId: "example-publishing",
                onChange: () => {},
              },
            ],
            footer: {
              kind: "setup",
              onSetup: () => {},
              disclosureId: "example-access",
            },
            disclosures: [
              { id: "example-access", text: "Read-only access limited-use disclosure." },
              { id: "example-publishing", text: "Publishing consent disclosure." },
            ],
          })}
        />
      </Sheet>,
    );
    try {
      const sheet = document.querySelector('[data-integration-sheet="slack"]')!;
      const access = sheet.querySelector(`#${integrationDisclosureElementId("example-access")}`);
      const publishing = sheet.querySelector(
        `#${integrationDisclosureElementId("example-publishing")}`,
      );
      expect(access?.textContent).toBe("Read-only access limited-use disclosure.");
      expect(publishing?.textContent).toBe("Publishing consent disclosure.");
      const setupButton = [...sheet.querySelectorAll("button")].find(
        (node) => node.textContent?.trim() === "Set up",
      )!;
      expect(setupButton.getAttribute("aria-describedby")).toBe(
        integrationDisclosureElementId("example-access"),
      );
      const toggle = sheet.querySelector('[role="switch"]')!;
      expect(toggle.getAttribute("aria-describedby")).toBe(
        integrationDisclosureElementId("example-publishing"),
      );
    } finally {
      await rendered.unmount();
    }
  });

  test("link options render one action per row", async () => {
    const first = mock(() => {});
    const second = mock(() => {});
    const rendered = await render(
      <Sheet open>
        <IntegrationSheetBody
          model={model({
            options: [
              {
                kind: "link",
                id: "install-a",
                label: "acme-org",
                action: { label: "Change repositories", onClick: first },
              },
              {
                kind: "link",
                id: "install-b",
                label: "second-org",
                action: { label: "Change repositories", onClick: second },
              },
            ],
          })}
        />
      </Sheet>,
    );
    try {
      const sheet = document.querySelector('[data-integration-sheet="slack"]')!;
      const actions = [...sheet.querySelectorAll("button")].filter(
        (node) => node.textContent?.trim() === "Change repositories",
      );
      expect(actions).toHaveLength(2);
      expect(sheet.querySelector('[role="switch"]')).toBeNull();
      await act(async () => actions[1]!.click());
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    } finally {
      await rendered.unmount();
    }
  });

  test("Connected accounts items render a status dot and an inline per-item action", async () => {
    const onReconnect = mock(() => {});
    const onEdit = mock(() => {});
    const rendered = await render(
      <Sheet open>
        <IntegrationSheetBody
          model={model({
            id: "outlook-mail",
            name: "Outlook Mail",
            access: {
              title: "Connected accounts",
              editLabel: "+ Add account",
              onEdit,
              items: [
                { name: "ana@acme.com", status: "ok" },
                {
                  name: "ben@acme.com",
                  status: "warn",
                  meta: "Needs attention",
                  actions: [{ label: "Reconnect", onClick: onReconnect }],
                },
              ],
            },
          })}
        />
      </Sheet>,
    );
    try {
      const sheet = document.querySelector('[data-integration-sheet="outlook-mail"]')!;
      const items = [...sheet.querySelectorAll("li")];
      expect(items).toHaveLength(2);
      expect(items[0]?.textContent).toContain("ana@acme.com");
      expect(items[0]?.querySelector("button")).toBeNull();
      const reconnect = items[1]?.querySelector("button");
      expect(reconnect?.textContent?.trim()).toBe("Reconnect");
      await act(async () => reconnect!.click());
      expect(onReconnect).toHaveBeenCalledTimes(1);
      const addAccount = [...sheet.querySelectorAll("button")].find(
        (node) => node.textContent?.trim() === "+ Add account",
      )!;
      await act(async () => addAccount.click());
      expect(onEdit).toHaveBeenCalledTimes(1);
    } finally {
      await rendered.unmount();
    }
  });

  test("Tools renders a flat informational chip grid and is omitted when empty", async () => {
    const withTools = await render(
      <Sheet open>
        <IntegrationSheetBody
          model={model({ tools: { tools: ["mail.read", "mail.send", "mail.read"] } })}
        />
      </Sheet>,
    );
    try {
      const sheet = document.querySelector('[data-integration-sheet="slack"]')!;
      const heading = [...sheet.querySelectorAll("h3")].find(
        (node) => node.textContent === "Tools",
      );
      expect(heading).toBeDefined();
      const chips = heading!.closest("section")!.querySelectorAll("span");
      expect([...chips].map((node) => node.textContent)).toEqual([
        "mail.read",
        "mail.send",
        "mail.read",
      ]);
      // Purely informational: no button/toggle inside a tool chip.
      expect(heading!.closest("section")!.querySelector("button")).toBeNull();
    } finally {
      await withTools.unmount();
    }

    const withoutTools = await render(
      <Sheet open>
        <IntegrationSheetBody model={model({ tools: { tools: [] } })} />
      </Sheet>,
    );
    try {
      const sheet = document.querySelector('[data-integration-sheet="slack"]')!;
      expect([...sheet.querySelectorAll("h3")].some((node) => node.textContent === "Tools")).toBe(
        false,
      );
    } finally {
      await withoutTools.unmount();
    }
  });

  test("toggle options are switches that report the next value", async () => {
    const onChange = mock((_checked: boolean) => {});
    const rendered = await render(
      <Sheet open>
        <IntegrationSheetBody
          model={model({
            options: [
              {
                kind: "toggle",
                id: "sync",
                label: "Keep folders in sync",
                checked: false,
                onChange,
              },
            ],
          })}
        />
      </Sheet>,
    );
    try {
      const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!;
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      await act(async () => toggle.click());
      expect(onChange).toHaveBeenCalledWith(true);
    } finally {
      await rendered.unmount();
    }
  });
});
