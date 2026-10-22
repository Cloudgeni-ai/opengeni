import { describe, expect, test } from "bun:test";
import {
  FIRST_PARTY_ATTEMPT_TOOL_FAMILY_NAMES,
  FIRST_PARTY_FUNCTION_TOOL_FAMILY_NAMES,
  FIRST_PARTY_MCP_TOOL_NAMES,
} from "@opengeni/contracts";
import { englishMessages } from "../src/messages/en";
import { createOpenGeniText } from "../src/messages/runtime";
import type { ToolCallItem } from "../src/timeline";
import { toolDisplayName } from "../src/timeline/tool-display-name";
import { genericToolIconKind, toolRowPresentation } from "../src/timeline/tool-presentation";
import { toolIcon } from "../src/timeline/tool-icon";
import {
  BUILT_IN_TOOL_STEP_NAMES,
  builtInToolStep,
  TOOL_STEP_IDS,
} from "../src/timeline/tool-steps";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const { defaultToolRegistry } = await import("../src/timeline");
const { ToolDetailsProvider } = await import("../src/timeline/tool-details");

const t = createOpenGeniText();

function toolItem(overrides: Partial<ToolCallItem>): ToolCallItem {
  return {
    kind: "tool-call",
    id: "tc-1",
    turnId: "turn-1",
    callId: "call-1",
    name: "exec_command",
    arguments: {},
    output: undefined,
    truncation: null,
    raw: undefined,
    status: "complete",
    occurredAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("built-in tool steps", () => {
  test("every built-in tool draws its own icon instead of the generic wrench", () => {
    const wrench = toolIcon("wrench");
    for (const name of BUILT_IN_TOOL_STEP_NAMES) {
      const kind = genericToolIconKind(name);
      expect({ name, kind }).not.toEqual({ name, kind: "wrench" });
      expect(toolIcon(kind)).not.toBe(wrench);
    }
  });

  test("a row's icon matches its words, with or without the server prefix", () => {
    const icon = (name: string) => toolRowPresentation(t, toolItem({ name })).icon;
    expect(icon("interaction__browser_open")).toBe("browser");
    expect(icon("browser_act")).toBe("browser");
    expect(icon("interaction__computer_act")).toBe("screen");
    expect(icon("opengeni__excel_run")).toBe("spreadsheet");
    expect(icon("web_search_call")).toBe("search");
    expect(icon("some_custom_tool")).toBe("wrench");
  });

  test("every built-in tool reads as a plain step", () => {
    const builtIn = [
      ...FIRST_PARTY_MCP_TOOL_NAMES,
      ...FIRST_PARTY_ATTEMPT_TOOL_FAMILY_NAMES,
      ...FIRST_PARTY_FUNCTION_TOOL_FAMILY_NAMES,
    ];
    expect(builtIn.filter((name) => builtInToolStep(name) === null)).toEqual([]);
  });

  test("every step has running and done words, and every step is used", () => {
    const catalog = englishMessages as Record<string, string>;
    for (const step of TOOL_STEP_IDS) {
      expect(catalog[`timeline.toolStep.${step}.running`]).toBeString();
      expect(catalog[`timeline.toolStep.${step}.done`]).toBeString();
    }
    const used = new Set(BUILT_IN_TOOL_STEP_NAMES.map((name) => builtInToolStep(name)));
    expect(TOOL_STEP_IDS.filter((step) => !used.has(step))).toEqual([]);
  });

  test("names follow the call's phase, with or without the server prefix", () => {
    expect(toolDisplayName(t, "opengeni__notify_user", undefined, "running")).toBe("Notifying you");
    expect(toolDisplayName(t, "notify_user")).toBe("Notified you");
    expect(toolDisplayName(t, "some_server__list_issues")).toBe("List issues");
  });

  test("a failed or erroring call keeps the ongoing form beside its chip", () => {
    const failed = toolRowPresentation(t, toolItem({ name: "notify_user", status: "failed" }));
    expect(failed.title).toBe("Notifying you");
    const erroring = toolRowPresentation(
      t,
      toolItem({
        name: "opengeni__goal_set",
        output: { content: [{ type: "text", text: "nope" }], isError: true },
      }),
    );
    expect(erroring.title).toBe("Setting a goal");
    expect(toolRowPresentation(t, toolItem({ name: "goal_set" })).title).toBe("Set a goal");
  });
});

describe("plain tool details", () => {
  const exec = toolItem({
    arguments: { cmd: "cat secrets.json | jq .token" },
    output: 'Process exited with code 1\nOutput:\n{"token":"x"}',
  });

  test("a command reads as a plain step with no command, output or exit code", () => {
    const row = toolRowPresentation(t, exec, {
      details: "plain",
      computeLabel: "Studio Mac",
    });
    expect(row.title).toBe("Running a command");
    expect(row.titleMono).toBeUndefined();
    expect(row.preview).toEqual({ kind: "text", text: "Studio Mac" });
    expect(row.chip).toEqual({ tone: "bad", text: t("timeline.chip.failed") });
    expect(row.body).toEqual({ kind: "none" });
    const done = toolRowPresentation(t, toolItem({ arguments: { cmd: "ls" }, output: "a\nb" }), {
      details: "plain",
    });
    expect(done.title).toBe("Ran a command");
    expect(done.preview).toBeUndefined();
    expect(done.chip).toBeUndefined();
  });

  test("arguments, results and error payloads are left out", () => {
    const row = toolRowPresentation(
      t,
      toolItem({
        name: "opengeni__scheduled_tasks_create",
        arguments: { cron: "0 9 * * 1" },
        output: {
          content: [{ type: "text", text: '{"error":"bad cron"}' }],
          isError: true,
        },
      }),
      { details: "plain" },
    );
    expect(row.title).toBe("Setting up a scheduled task");
    expect(row.preview).toBeUndefined();
    expect(row.body).toEqual({ kind: "none" });
    expect(JSON.stringify(row)).not.toContain("cron");
  });

  test("rendered rows never show raw detail and do not expand", async () => {
    const Full = defaultToolRegistry.resolve(exec);
    const full = await renderComponent(<Full item={exec} />);
    await flush();
    expect(full.container.textContent).toContain("$ cat secrets.json");
    expect(full.container.querySelector("[aria-expanded]")).not.toBeNull();
    await full.unmount();
    for (const item of [
      exec,
      toolItem({
        name: "opengeni__goal_set",
        arguments: { objective: "x" },
        output: '{"ok":1}',
      }),
      toolItem({
        name: "tool_search",
        arguments: { query: "slack" },
        output: "[]",
      }),
      toolItem({
        name: "variable_set_set_variable",
        arguments: { name: "API_TOKEN", value: "v" },
        output: "ok",
      }),
    ]) {
      const Renderer = defaultToolRegistry.resolve(item);
      const r = await renderComponent(
        <ToolDetailsProvider value="plain">
          <Renderer item={item} />
        </ToolDetailsProvider>,
      );
      await flush();
      const text = r.container.textContent ?? "";
      expect(text).not.toContain("{");
      expect(text).not.toContain("$ ");
      expect(text).not.toContain("API_TOKEN");
      expect(text).not.toContain("_");
      expect(r.container.querySelector("[aria-expanded]")).toBeNull();
      await r.unmount();
    }
  });
});
