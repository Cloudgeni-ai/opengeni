import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ComposerCapabilitiesMenuBody } from "@/components/composer-capabilities-menu-body";
import { instructionSections } from "@/components/session/model-context-inspector";
import {
  capabilityAvailability,
  draftFromRequest,
  requestFromDraft,
  type AgentCapabilityDraft,
} from "@/lib/agent-capabilities";
import { AgentCapabilityPicker, AgentCapabilitySummary } from "./agent-capability-picker";

let container: HTMLDivElement;
let root: Root;
beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
afterAll(() => GlobalRegistrator.unregister());

const noWebSearch = capabilityAvailability({
  capabilities: [{ id: "webSearch", available: false, reason: "off" }],
});

test("the picker shows product words, disables what the server doesn't offer, and edits the draft", async () => {
  let draft: AgentCapabilityDraft = draftFromRequest("none");
  const change = mock((next: AgentCapabilityDraft) => {
    draft = next;
  });
  await act(async () =>
    root.render(
      <AgentCapabilityPicker draft={draft} onChange={change} availability={noWebSearch} />,
    ),
  );
  const text = container.textContent ?? "";
  expect(text).toContain("Everything this workspace offers");
  expect(text).toContain("Only what you choose");
  expect(text).not.toMatch(/goal_set|knowledge_search|web_search/);

  const webSearch = container.querySelector<HTMLInputElement>(
    '[data-capability="webSearch"] input[type=checkbox]',
  )!;
  expect(webSearch.disabled).toBe(true);
  expect(container.querySelector('[data-capability="webSearch"]')?.textContent).toContain(
    "Not enabled on this server",
  );

  const goals = container.querySelector<HTMLInputElement>(
    '[data-capability="goals"] input[type=checkbox]',
  )!;
  await act(async () => goals.click());
  expect(requestFromDraft(draft, noWebSearch)).toEqual({ from: "none", goals: true });
});

test("a read-only picker changes nothing", async () => {
  const change = mock();
  await act(async () =>
    root.render(
      <AgentCapabilityPicker
        draft={draftFromRequest("all")}
        onChange={change}
        availability={capabilityAvailability(null)}
        disabled
        disabledReason="Only workspace admins can change these."
      />,
    ),
  );
  for (const input of container.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) {
    expect(input.disabled).toBe(true);
  }
  expect(container.textContent).toContain("Only workspace admins can change these.");
});

test("the summary lists what is on, then what is off and what the server doesn't offer", async () => {
  await act(async () =>
    root.render(
      <AgentCapabilitySummary
        values={draftFromRequest({ from: "none", knowledge: true }).values}
        availability={noWebSearch}
      />,
    ),
  );
  const on = [...container.querySelectorAll("[data-capability]")].map((row) =>
    row.getAttribute("data-capability"),
  );
  expect(on).toEqual(["humanInput", "skills", "knowledge"]);
  expect(container.textContent).toContain("Reads installed Skills.");
  expect(container.textContent).toContain("Off: Images and video, Goals");
  expect(container.textContent).toContain("Not enabled on this server: Web search.");
});

test("composer capabilities: read-only until Customize for this chat, then toggles", async () => {
  const onCustomizedChange = mock();
  const onChange = mock();
  const render = (customized: boolean) =>
    root.render(
      <ComposerCapabilitiesMenuBody
        presentation="dialog"
        capabilities={{
          customized,
          draft: draftFromRequest({ from: "none", workspaceConnectors: true }),
          availability: capabilityAvailability(null),
          onCustomizedChange,
          onChange,
        }}
        connectorsSelected={2}
        connectorsTotal={3}
        onOpenConnectors={() => {}}
      />,
    );
  await act(async () => render(false));
  const customize = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Customize for this chat"]',
  )!;
  expect(customize.getAttribute("aria-checked")).toBe("false");
  expect(
    container.querySelector<HTMLButtonElement>('button[aria-label="Goals, off"]')?.disabled,
  ).toBe(true);
  expect(container.textContent).toContain("2 of 3 connected apps on");
  await act(async () => customize.click());
  expect(onCustomizedChange).toHaveBeenCalledWith(true);

  await act(async () => render(true));
  const goals = container.querySelector<HTMLButtonElement>('button[aria-label="Goals"]')!;
  expect(goals.getAttribute("role")).toBe("switch");
  await act(async () => goals.click());
  expect(requestFromDraft(onChange.mock.calls[0]![0])).toEqual({
    from: "none",
    goals: true,
    workspaceConnectors: true,
  });
});

test("inspector sections slice prompt modules out of the operational contract", () => {
  const content = "Base.\n\nRuntime.";
  const sections = instructionSections([
    { id: "identity", title: "Identity", content: "Me.", utf8Bytes: 3, estimatedTokens: 1 },
    {
      id: "operational_contract",
      title: "Operational contract",
      content,
      utf8Bytes: content.length,
      estimatedTokens: 4,
      modules: [
        { id: "base_behavior", chars: 5 },
        { id: "runtime_mechanics", chars: 8 },
      ],
    },
  ]);
  expect(sections.map((section) => [section.title, section.text, section.depth])).toEqual([
    ["Identity", "Me.", 0],
    ["Operational contract", content, 0],
    ["Base behavior", "Base.", 1],
    ["Runtime mechanics", "Runtime.", 1],
  ]);
  // Lengths that don't add up keep the layer whole.
  expect(
    instructionSections([
      {
        id: "operational_contract",
        title: "Operational contract",
        content,
        utf8Bytes: content.length,
        estimatedTokens: 4,
        modules: [{ id: "base_behavior", chars: 99 }],
      },
    ]),
  ).toHaveLength(1);
});
