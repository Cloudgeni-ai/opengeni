import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  EVERYDAY_SESSION_STARTERS,
  NEW_SESSION_STARTERS,
  NewSessionStarters,
} from "./new-session-starters";

let priorActEnvironmentDescriptor: PropertyDescriptor | undefined;

beforeAll(() => {
  priorActEnvironmentDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT",
  );
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  try {
    GlobalRegistrator.unregister();
  } finally {
    if (priorActEnvironmentDescriptor) {
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", priorActEnvironmentDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    }
  }
});

test("six always-visible suggestions emit only editable prompt text on explicit click", async () => {
  const onSelect = mock((_prompt: string) => {});
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<NewSessionStarters onSelect={onSelect} />));
    expect(onSelect).not.toHaveBeenCalled();
    expect(container.querySelector("h2")?.textContent).toBe("Suggestions");
    expect(container.querySelectorAll("button")).toHaveLength(6);
    expect(container.querySelector("select, [role=combobox], details, a")).toBeNull();
    const buttons = [...container.querySelectorAll("button")];
    for (const [index, starter] of NEW_SESSION_STARTERS.entries()) {
      const button = buttons[index]!;
      expect(button.type).toBe("button");
      expect(button.textContent).toBe(starter.title + starter.description);
      expect(button.classList.contains("h-full")).toBe(true);
      await act(async () => button.click());
      expect(onSelect.mock.calls[index]).toEqual([starter.prompt]);
    }
    expect(onSelect).toHaveBeenCalledTimes(6);
    const marks = buttons.map((button) => button.querySelector("img, svg")!);
    expect(marks.slice(0, 3).every((mark) => mark.classList.contains("size-8"))).toBe(true);
    expect(marks.slice(3).every((mark) => mark.classList.contains("size-5"))).toBe(true);
    expect(marks.every((mark) => mark.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(marks[1]!.getAttribute("fill")).toBe("currentColor");
    expect(buttons[0]!.parentElement?.classList.contains("auto-rows-fr")).toBe(true);

    await act(async () => root.render(<NewSessionStarters onSelect={onSelect} disabled />));
    expect(container.querySelectorAll("button:disabled")).toHaveLength(6);
    await act(async () => container.querySelector("button")!.click());
    expect(onSelect).toHaveBeenCalledTimes(6);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("route keeps suggestions below recent sessions and uses the ordinary draft/send boundary", () => {
  const route = readFileSync(new URL("../routes/sessions-index.tsx", import.meta.url), "utf8");
  expect(route.indexOf("<NewSessionStarters")).toBeGreaterThan(route.indexOf("<RecentSessions"));
  expect(route).toContain('data-workspace-scroll-owner="self-managed"');
  expect(route).toContain("[&_textarea]:min-h-[calc(2lh+1rem)]");
  expect(route).toContain('querySelector("textarea")?.focus({ preventScroll: true })');
  expect(route).toContain("setMessage(prompt)");
  expect(route).toContain("value: message");
  expect(route).toContain("setValue: setMessage");
  // Visibility and where it runs are setup chips above the message, not "+"
  // drill-ins or controls under the composer.
  expect(route).toContain("<VisibilityMenuBody");
  expect(route).toContain("<RunsOnMenuBody");
  expect(route).toContain("<ComputeTargetControl");
  expect(route).toContain("runsOn={runsOnSetup}");
  expect(route).toContain("visibility={visibilitySetup}");
  expect(route).not.toMatch(/\n\s+runsOn: \{\n\s+summary: runsOnSummary/);
});

test("without the chat list, the new-chat page shows no recent chats or project picker", () => {
  const route = readFileSync(new URL("../routes/sessions-index.tsx", import.meta.url), "utf8");
  expect(route).toContain('const chatList = useSessionUiFeature("chatList");');
  expect(route).toContain("{chatList ? <RecentSessions workspaceId={workspaceId} /> : null}");
  // The strip still shows Runs on and Visibility; only the project chip goes.
  expect(route).toMatch(
    /chatList \|\| runsOnSetup \|\| visibilitySetup \? \(\s*<SessionSetupStrip/,
  );
  expect(route).toMatch(/project=\{\s*chatList\s*\?/);
});

test("the new-chat page's Add credits button follows the addCredits switch", () => {
  const route = readFileSync(new URL("../routes/sessions-index.tsx", import.meta.url), "utf8");
  expect(route).toContain('const addCredits = useSessionUiFeature("addCredits");');
  expect(route).toMatch(
    /const canTopUpCredits =\s*addCredits &&\s*context\.clientConfig\.billingMode === "stripe" &&/,
  );
  expect(route).toMatch(/\{canTopUpCredits && workspace\?\.accountId \? \(/);
});

test("help with everyday things gets six plain everyday asks, with no services to connect", async () => {
  const onSelect = mock((_prompt: string) => {});
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<NewSessionStarters set="everyday" workspaceId="ws-1" onSelect={onSelect} />),
    );
    expect(container.querySelector("h2")?.textContent).toBe("Suggestions");
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(
      EVERYDAY_SESSION_STARTERS.map((starter) => starter.title + starter.description),
    );
    // No product demo link, no service logos, none of the general starters.
    expect(container.querySelector("a, img")).toBeNull();
    const general = NEW_SESSION_STARTERS.map((starter) => starter.title);
    expect(general.some((title) => container.textContent?.includes(title))).toBe(false);
    expect(container.textContent).not.toMatch(/Slack|GitHub|Linear|agent|repository/i);
    for (const [index, starter] of EVERYDAY_SESSION_STARTERS.entries()) {
      expect(buttons[index]!.dataset.starter).toBe(starter.id);
      await act(async () => buttons[index]!.click());
      expect(onSelect.mock.calls[index]).toEqual([starter.prompt]);
    }

    await act(async () =>
      root.render(<NewSessionStarters set="everyday" onSelect={onSelect} disabled />),
    );
    expect(container.querySelectorAll("button:disabled")).toHaveLength(6);

    // Without uploads nothing promises a photo; with them, "Explain something" offers one.
    expect(EVERYDAY_SESSION_STARTERS.some((starter) => /photo/i.test(starter.prompt))).toBe(false);
    onSelect.mockClear();
    await act(async () =>
      root.render(<NewSessionStarters set="everyday" fileUploads onSelect={onSelect} />),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-starter="explain"]')!.click(),
    );
    expect(onSelect.mock.calls[0]?.[0]).toContain("attach a photo");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a host's own starters replace Opengeni's, whatever the signup answer", async () => {
  const onSelect = mock((_prompt: string) => {});
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const hostStarters = [
    {
      id: "chart",
      title: "Make a chart",
      description: "From the selected data.",
      prompt: "Make a chart from the selected data.",
      icon: <svg data-icon="chart" />,
    },
    { id: "formula", title: "Write a formula", prompt: "Help me write a formula." },
  ];
  try {
    for (const set of ["general", "everyday", "product"] as const) {
      await act(async () =>
        root.render(
          <NewSessionStarters
            set={set}
            workspaceId="w1"
            hostStarters={hostStarters}
            onSelect={onSelect}
          />,
        ),
      );
      const buttons = [...container.querySelectorAll("button")];
      expect(buttons.map((button) => button.dataset.starter)).toEqual(["chart", "formula"]);
      expect(container.querySelector("a")).toBeNull();
      expect(container.textContent).not.toMatch(/Slack|GitHub|Linear|Plan a trip/);
    }
    expect(container.querySelector('[data-icon="chart"]')?.closest("[aria-hidden]")).not.toBeNull();
    // A starter without a description shows just its title.
    expect(
      container.querySelector('[data-starter="formula"]')?.querySelectorAll("span span"),
    ).toHaveLength(1);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-starter="formula"]')!.click(),
    );
    expect(onSelect.mock.calls).toEqual([["Help me write a formula."]]);

    // An empty list shows no suggestions at all.
    await act(async () =>
      root.render(<NewSessionStarters hostStarters={[]} onSelect={onSelect} />),
    );
    expect(container.querySelector("section")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
