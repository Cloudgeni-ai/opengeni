import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { IntegrationRow } from "./integration-row";
import { Sheet } from "@/components/ui/sheet";
import { IntegrationSheetBody } from "./integration-sheet";
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

/** Structural fingerprint: tag names and roles, ignoring text and ids. */
function shape(element: Element): string {
  const parts: string[] = [element.tagName.toLowerCase()];
  const role = element.getAttribute("role");
  if (role) parts.push(`[role=${role}]`);
  const children = [...element.children].map(shape).join(",");
  return children ? `${parts.join("")}(${children})` : parts.join("");
}

describe("IntegrationRow", () => {
  test("renders every integration through the same row shape", async () => {
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
      const rows = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")];
      expect(rows).toHaveLength(3);
      expect(rows[0]?.getAttribute("aria-label")).toBe("Slack. Connected");
      expect(rows[1]?.getAttribute("aria-label")).toBe("GitHub. Not connected");
      // Apart from the mark (logo vs monogram) and the chip dot, the DOM shape is identical.
      const shapes = rows.map((row) => shape(row).replace(/span\(img\)|span/g, "mark"));
      expect(new Set(shapes.map((entry) => entry.replace(/mark\(mark\)/g, "mark"))).size).toBe(1);
      for (const row of rows) {
        expect(row.querySelector("[data-integration-chip]")).not.toBeNull();
        expect(row.textContent).not.toContain("scope");
      }
      await act(async () => rows[1]!.click());
      expect(onOpen).toHaveBeenCalledTimes(1);
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
