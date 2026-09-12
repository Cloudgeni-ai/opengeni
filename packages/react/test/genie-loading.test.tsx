import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ActivityRail } from "../src/timeline/activity-rail";
import { GenieLoading, GenieLoadingOptionsContext } from "../src/timeline/genie-loading";
import { MessageTimeline } from "../src/components/message-timeline";
import { StartupTimings } from "../src/timeline/startup-timings";
import { setStartupDetails } from "../src/timeline/startup-preference";
import type { StartupPhaseItem } from "../src/timeline/types";
import { registerDom, renderComponent, flush } from "./render-hook";
registerDom();
const messages = {
  status: "Préparation en cours",
  slowStatus: "La préparation prend plus de temps",
  slowText: "Encore un instant…",
  showDetails: "Afficher les détails",
  hideDetails: "Masquer les détails",
};
const options = { phrases: ["Préparation…"], messages };
test("native messages localize normal, slow, and expanded states without replacing rendering", async () => {
  for (const age of [0, 16_000, 31_000]) {
    for (const detailsOpen of [false, true]) {
      let clicks = 0;
      const r = await renderComponent(
        <GenieLoadingOptionsContext.Provider value={options}>
          <GenieLoading
            startedAt={new Date(Date.now() - age).toISOString()}
            detailsOpen={detailsOpen}
            onShowDetails={() => clicks++}
          />
        </GenieLoadingOptionsContext.Provider>,
      );
      expect(r.container.querySelector('[role="status"]')?.textContent).toBe(
        age >= 30_000 ? messages.slowStatus : messages.status,
      );
      expect(r.container.querySelector(".og-genie-phrase")?.textContent).toBe(
        age >= 30_000 ? messages.slowText : "Préparation…",
      );
      const button = r.container.querySelector("button");
      if (age >= 15_000 || detailsOpen) {
        expect(button?.textContent).toContain(
          detailsOpen ? messages.hideDetails : messages.showDetails,
        );
        await act(async () => button!.click());
        expect(clicks).toBe(1);
      } else expect(button).toBeNull();
      await r.unmount();
    }
  }
});
afterEach(() => setStartupDetails(false));
function phase(overrides: Partial<StartupPhaseItem> = {}): StartupPhaseItem {
  return {
    kind: "startup-phase",
    id: "start",
    turnId: "turn",
    phase: "sandbox",
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    durationMs: null,
    outcome: null,
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}
test("normal preparation has one accessible status and hides all timing rows", async () => {
  const r = await renderComponent(
    <ActivityRail items={[phase(), phase({ id: "tools", phase: "tools" })]} />,
  );
  expect(r.container.querySelectorAll('[role="status"]').length).toBe(1);
  expect(r.container.textContent).not.toContain("Starting sandbox");
  expect(r.container.textContent).not.toContain("Connecting tools");
  expect(r.container.querySelector("button")).toBeNull();
  await r.unmount();
});
test("details appear after 15 seconds without replacing playful copy", async () => {
  const r = await renderComponent(
    <ActivityRail items={[phase({ startedAt: new Date(Date.now() - 15_001).toISOString() })]} />,
  );
  expect(r.container.textContent).toContain("Behind the magic");
  expect(r.container.textContent).not.toContain("A little longer than usual");
  await act(async () => r.container.querySelector("button")!.click());
  for (let i = 0; i < 20 && !r.container.textContent?.includes("Starting sandbox"); i++)
    await flush(10);
  expect(r.container.textContent).toContain("Starting sandbox");
  expect(r.container.textContent).toContain("Hide details");
  await r.unmount();
});
test("historical startup is quiet but recorded timings remain inspectable", async () => {
  const item = phase({ status: "complete", durationMs: 1234 });
  const r = await renderComponent(<ActivityRail items={[item]} />);
  expect(r.container.textContent).toBe("");
  await act(async () => setStartupDetails(true));
  await flush();
  expect(r.container.textContent).toContain("1.2s");
  await act(async () => setStartupDetails(false));
  expect(r.container.textContent).toBe("");
  await r.unmount();
  const table = await renderComponent(<StartupTimings phases={[item]} />);
  expect(table.container.textContent).toContain("1.2 s");
  expect(table.container.textContent).toContain("not additive");
  await table.unmount();
});
test("long waits replace playful text with an honest status", async () => {
  const r = await renderComponent(
    <ActivityRail items={[phase({ startedAt: new Date(Date.now() - 31_000).toISOString() })]} />,
  );
  expect(r.container.textContent).toContain("A little longer than usual");
  expect(r.container.textContent).toContain("Behind the magic");
  await r.unmount();
});
test("failures and cancellation stop the wisp and stay visible", async () => {
  for (const status of ["failed", "cancelled"] as const) {
    const r = await renderComponent(
      <ActivityRail items={[phase({ status }), phase({ id: "other", phase: "tools" })]} />,
    );
    await flush();
    expect(r.container.querySelector(".og-genie-loading")).toBeNull();
    expect(r.container.textContent).toContain(
      status === "failed" ? "Sandbox didn’t start" : "Sandbox startup interrupted",
    );
    await r.unmount();
  }
});
test("real work replaces loading even if a startup receipt is still running", async () => {
  const r = await renderComponent(
    <ActivityRail
      items={[
        phase(),
        {
          kind: "reasoning",
          id: "thought",
          turnId: "turn",
          text: "Considering the design",
          streaming: true,
          occurredAt: new Date().toISOString(),
        },
      ]}
    />,
  );
  await flush();
  expect(r.container.querySelector(".og-genie-loading")).toBeNull();
  expect(r.container.textContent).toContain("Thinking");
  await r.unmount();
});
test("startup-only timeline groups have no verbose step-count shell", async () => {
  const r = await renderComponent(<MessageTimeline items={[phase()]} />);
  expect(r.container.textContent).not.toContain("steps");
  expect(r.container.querySelector(".og-genie-loading")).not.toBeNull();
  await r.unmount();
});

test("the same orb survives gaps between startup phases", async () => {
  const first = phase();
  const r = await renderComponent(<MessageTimeline items={[first]} />);
  const canvas = r.container.querySelector("canvas");
  expect(canvas).not.toBeNull();
  const complete = { ...first, status: "complete" as const, durationMs: 100 };
  await r.rerender(<MessageTimeline items={[complete]} />);
  expect(r.container.querySelector("canvas")).toBe(canvas);
  await r.rerender(<MessageTimeline items={[complete, phase({ id: "tools", phase: "tools" })]} />);
  expect(r.container.querySelector("canvas")).toBe(canvas);
  await r.unmount();
});

test("provider first byte does not remove the orb before visible response text", async () => {
  const first = phase();
  const r = await renderComponent(<MessageTimeline items={[first]} />);
  const canvas = r.container.querySelector("canvas");
  const ready = [
    { ...first, status: "complete" as const },
    phase({ id: "first-byte", phase: "provider_first_byte", status: "complete", durationMs: 100 }),
  ];
  await r.rerender(<MessageTimeline items={ready} />);
  expect(r.container.querySelector("canvas")).toBe(canvas);
  const message = {
    kind: "agent-message" as const,
    id: "answer",
    turnId: "turn",
    text: "",
    streaming: true,
    occurredAt: new Date().toISOString(),
  };
  await r.rerender(<MessageTimeline items={[...ready, message]} />);
  expect(r.container.querySelector("canvas")).toBe(canvas);
  await r.rerender(<MessageTimeline items={[...ready, { ...message, text: "Hello" }]} />);
  expect(r.container.textContent).toContain("Hello");
  await r.unmount();
});

test("empty reasoning keeps the orb until visible reasoning arrives", async () => {
  const first = phase();
  const thought = {
    kind: "reasoning" as const,
    id: "thought",
    turnId: "turn",
    text: " ",
    streaming: true,
    occurredAt: first.occurredAt,
  };
  const r = await renderComponent(<ActivityRail items={[first]} startupActive />);
  const canvas = r.container.querySelector("canvas");
  await r.rerender(<ActivityRail items={[first, thought]} startupActive />);
  expect(r.container.querySelector("canvas")).toBe(canvas);
  expect(r.container.textContent).not.toContain("Thinking");
  await r.rerender(
    <ActivityRail items={[first, { ...thought, text: "Considering options" }]} startupActive />,
  );
  await flush();
  expect(r.container.textContent).toContain("Thinking");
  await r.unmount();
});

test("late preparation cannot restart loading after output in the same turn", async () => {
  const r = await renderComponent(
    <MessageTimeline
      items={[
        {
          kind: "agent-message",
          id: "reply",
          turnId: "turn",
          text: "Starting research",
          streaming: true,
          occurredAt: new Date().toISOString(),
        },
        phase({ id: "late-start" }),
      ]}
    />,
  );
  expect(r.container.querySelector(".og-genie-loading")).toBeNull();
  expect(r.container.textContent).toContain("Starting research");
  await r.unmount();
});

test("work mixed with startup receipts uses the normal Steps disclosure", async () => {
  const r = await renderComponent(
    <MessageTimeline
      items={[
        phase(),
        {
          kind: "reasoning",
          id: "thinking",
          turnId: "turn",
          text: "Considering options",
          streaming: true,
          occurredAt: new Date().toISOString(),
        },
      ]}
    />,
  );
  expect(r.container.querySelector(".og-genie-loading")).toBeNull();
  expect(r.container.querySelector("button[aria-expanded]")).not.toBeNull();
  await r.unmount();
});

test("hosts can replace loading with an arbitrary component", async () => {
  const r = await renderComponent(
    <MessageTimeline
      items={[phase()]}
      genieLoading={{
        render: ({ startedAt }) => <div data-start={startedAt}>Custom preparation</div>,
      }}
    />,
  );
  expect(r.container.textContent).toContain("Custom preparation");
  expect(r.container.querySelector("canvas")).toBeNull();
  await r.unmount();
});

test("hosts can customize phrases and orb dimensions", async () => {
  const r = await renderComponent(
    <MessageTimeline
      items={[phase()]}
      genieLoading={{ phrases: ["Custom wish"], orb: { size: 20 } }}
    />,
  );
  expect(r.container.textContent).toContain("Custom wish");
  expect((r.container.querySelector(".og-genie-orb") as HTMLElement).style.width).toBe("20px");
  await r.unmount();
});

test("rolling steps start closed and preserve explicit expansion", async () => {
  const item = {
    kind: "tool-call" as const,
    id: "tool1",
    callId: "call1",
    turnId: "turn",
    name: "exec_command",
    raw: undefined,
    arguments: { cmd: "bun test" },
    output: "secret detail",
    status: "running" as const,
    occurredAt: new Date().toISOString(),
  };
  const r = await renderComponent(
    <MessageTimeline items={[item]} turnSummary={{ rolling: true }} />,
  );
  expect(r.container.querySelector(".og-rolling-status")).toBeNull();
  await r.rerender(
    <MessageTimeline
      items={[item, { ...item, id: "tool2", callId: "call2", arguments: { cmd: "bun run build" } }]}
      turnSummary={{ rolling: true }}
    />,
  );
  const trigger = r.container.querySelector("button[aria-expanded]") as HTMLButtonElement;
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(r.container.querySelector(".og-rolling-status")).not.toBeNull();
  expect(r.container.textContent).toContain("+1 earlier");
  expect(r.container.textContent).toContain("bun test");
  expect(r.container.textContent).toContain("bun run build");
  // Both faces exist during the first standalone-to-reel transition.
  expect(r.container.querySelectorAll(".og-rolling-face").length).toBe(2);
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await r.rerender(
    <MessageTimeline
      items={[
        item,
        { ...item, id: "tool2", callId: "call2", arguments: { cmd: "bun run typecheck" } },
      ]}
      turnSummary={{ rolling: true }}
    />,
  );
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await r.unmount();
});

test("reasoning previews render emphasis instead of raw Markdown markers", async () => {
  const r = await renderComponent(
    <ActivityRail
      items={[
        {
          kind: "reasoning",
          id: "markdown-thought",
          turnId: "turn",
          text: "**Checking the repository** before continuing.",
          streaming: false,
          occurredAt: new Date().toISOString(),
        },
      ]}
    />,
  );
  await flush();
  expect(r.container.textContent).toContain("Checking the repository");
  expect(r.container.textContent).not.toContain("**");
  expect(r.container.querySelector(".og-reasoning-preview strong")?.textContent).toBe(
    "Checking the repository",
  );
  await r.unmount();
});

test("rolling reasoning keeps its live Markdown preview", async () => {
  const items = [
    phase(),
    {
      kind: "reasoning" as const,
      id: "r1",
      turnId: "turn",
      text: "**First thought**",
      streaming: false,
      occurredAt: new Date().toISOString(),
    },
    {
      kind: "reasoning" as const,
      id: "r2",
      turnId: "turn",
      text: "**Current thought**",
      streaming: true,
      occurredAt: new Date().toISOString(),
    },
  ];
  const r = await renderComponent(
    <MessageTimeline items={items} turnSummary={{ rolling: true }} />,
  );
  await flush();
  expect(r.container.querySelector(".og-reel-title")?.textContent).toBe("Thinking");
  expect(r.container.querySelector(".og-reel-preview")?.textContent).toContain("Current thought");
  await r.unmount();
});

test("rolling sandbox and worker steps reuse descriptive compact rows", async () => {
  const { RollingActivity } = await import("../src/timeline/rolling-activity");
  const shared = {
    turnId: "turn",
    status: "running" as const,
    occurredAt: new Date().toISOString(),
  };
  const r = await renderComponent(
    <RollingActivity
      items={[
        {
          ...shared,
          kind: "sandbox",
          id: "sandbox",
          name: "exec",
          command: "sleep 20",
          output: "",
        },
      ]}
    />,
  );
  await flush();
  expect(r.container.textContent).toContain("sleep 20");
  expect(
    r.container.querySelector('.og-rolling-status[data-running="true"] .og-command-reel'),
  ).not.toBeNull();
  await r.rerender(
    <RollingActivity
      items={[
        {
          ...shared,
          kind: "worker",
          id: "worker",
          callId: "call",
          action: "spawn",
          prompt: "Inspect the repository",
          workerSessionId: null,
          failure: null,
        },
      ]}
    />,
  );
  expect(r.container.textContent).toContain("Spawning worker");
  expect(r.container.textContent).toContain("Inspect the repository");
  await r.unmount();
});
