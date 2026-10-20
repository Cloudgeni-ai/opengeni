import { expect, test } from "bun:test";
import { act } from "react";
import type { SessionEvent } from "@opengeni/sdk";
import { createOpenGeniText } from "../src/messages/runtime";
import { buildTimeline } from "../src/timeline/projection";
import { toolRowPresentation } from "../src/timeline/tool-presentation";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();
const { defaultToolRegistry } = await import("../src/timeline");
const { ToolDetailsProvider } = await import("../src/timeline/tool-details");
const t = createOpenGeniText();
const output = [
  "[connected machine] the machine link blipped",
  "What happened: the machine did not respond in time (control code ERROR_CODE_TIMEOUT).",
  "Which layer: the machine link (transport) — not your command",
  "What was preserved: unknown — the command may or may not have run (its reply was lost).",
  "What to try: check whether it already took effect before re-running it.",
].join("\n");

function fixture(errorFlag: boolean) {
  const events = [
    {
      type: "agent.toolCall.created",
      payload: { id: "call", name: "exec_command", arguments: { cmd: "fixture command" } },
    },
    {
      type: "agent.toolCall.output",
      payload: { id: "call", output, ...(errorFlag ? { error: true } : {}) },
    },
  ].map((event, index) => ({
    ...event,
    id: `event-${index}`,
    sequence: index + 1,
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
    occurredAt: new Date(0).toISOString(),
  })) as SessionEvent[];
  const item = buildTimeline(t, events)[0]!;
  if (item.kind !== "tool-call") throw new Error("missing fixture tool call");
  return item;
}

test.each([false, true])(
  "historical/new uncertainty is failed in the timeline (explicit flag: %s)",
  (flag) => {
    const item = fixture(flag);
    expect(item.status).toBe("failed");
    for (const details of ["full", "plain"] as const) {
      const row = toolRowPresentation(t, item, { details });
      expect(row.failed).toBe(true);
      expect(row.chip).toEqual({ tone: "bad", text: "outcome unknown" });
      expect(row.preview).toEqual({ kind: "text", text: "It may have run" });
      if (details === "plain") {
        expect(row.body).toEqual({
          kind: "note",
          tone: "error",
          text: "It may have run. Check the result before trying again.",
        });
        expect(row.title).not.toBe("Ran a command");
        expect(JSON.stringify(row)).not.toContain("fixture command");
      } else {
        expect(JSON.stringify(row.body)).toContain("ERROR_CODE_TIMEOUT");
      }
    }
  },
);

test("actual plain production renderer displays uncertainty without command details", async () => {
  const item = fixture(false);
  const Renderer = defaultToolRegistry.resolve(item);
  const rendered = await renderComponent(
    <ToolDetailsProvider value="plain">
      <Renderer item={item} />
    </ToolDetailsProvider>,
  );
  await flush();
  expect(rendered.container.textContent).toContain("outcome unknown");
  const disclosure = rendered.container.querySelector<HTMLElement>('[role="button"]')!;
  expect(disclosure).not.toBeNull();
  await act(async () => disclosure.click());
  await flush();
  expect(rendered.container.textContent).toContain(
    "It may have run. Check the result before trying again.",
  );
  expect(rendered.container.textContent).not.toContain("fixture command");
  await rendered.unmount();
});
