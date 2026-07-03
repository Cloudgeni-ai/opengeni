import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { act } from "react";
import { registerDom, renderComponent, flush } from "./render-hook";
import { defaultToolRegistry, ActivityRail } from "../src/timeline";
import type { ToolCallItem, SandboxItem } from "../src/timeline";
import { MessageTimeline } from "../src";

/* ----------------------------------------------------------------------------
   Renderer integration tests for Issue-2 (multi-file apply_patch count) and
   Issue-3 (exec failure NUL-storage vs generic failure distinction).

   These render real `ActivityDisclosure` trees via happy-dom so the assertions
   touch actual DOM text — the only reliable way to confirm the renderer emits
   the right words given the dispatch logic lives in JSX.
   -------------------------------------------------------------------------- */

registerDom();

let timelineSequence = 0;

function timelineEvent(type: string, payload: unknown, turnId: string | null = "turn-1"): SessionEvent {
  timelineSequence += 1;
  return {
    id: `timeline-evt-${timelineSequence}`,
    workspaceId: "ws-1",
    sessionId: "session-1",
    sequence: timelineSequence,
    type,
    payload,
    occurredAt: new Date(1718000000000 + timelineSequence * 1000).toISOString(),
    turnId,
  };
}

function resetTimelineEvents(): void {
  timelineSequence = 0;
}

function timelineEventAt(type: string, payload: unknown, occurredAt: string, turnId: string | null = "turn-1"): SessionEvent {
  timelineSequence += 1;
  return {
    id: `timeline-evt-${timelineSequence}`,
    workspaceId: "ws-1",
    sessionId: "session-1",
    sequence: timelineSequence,
    type,
    payload,
    occurredAt,
    turnId,
  };
}

function turnSummaryTriggers(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button")).filter((button) => /\d+ steps?/.test(button.textContent ?? ""));
}

function turnSummaryTrigger(container: HTMLElement): HTMLButtonElement | null {
  return turnSummaryTriggers(container)[0] ?? null;
}

function toolItem(overrides: Partial<ToolCallItem>): ToolCallItem {
  return {
    kind: "tool-call",
    id: "tc-1",
    turnId: "turn-1",
    callId: "call-1",
    name: "exec_command",
    arguments: {},
    output: undefined,
    raw: undefined,
    status: "complete",
    occurredAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("MessageTimeline — settled turn folding", () => {
  test("settled turn renders one top-level chip, final answer, and folded narration", async () => {
    resetTimelineEvents();
    const events = [
      timelineEvent("user.message", { text: "Run the checks" }),
      timelineEvent("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "bun test" } }),
      timelineEvent("agent.toolCall.output", { id: "call-1", output: "first pass failed" }),
      timelineEvent("agent.message.completed", { text: "Narration: one fixture needs a quick patch." }),
      timelineEvent("agent.toolCall.created", { id: "call-2", name: "exec_command", arguments: { cmd: "bun test --watch=false" } }),
      timelineEvent("agent.toolCall.output", { id: "call-2", output: "ok" }),
      timelineEvent("agent.message.completed", { text: "Final answer: checks are green." }),
      timelineEvent("turn.completed", {}),
    ];
    const r = await renderComponent(<MessageTimeline events={events} />);
    await flush();

    expect(turnSummaryTriggers(r.container)).toHaveLength(1);
    expect(r.container.textContent).toContain("Final answer: checks are green.");
    expect(r.container.textContent).not.toContain("Narration: one fixture needs a quick patch.");

    const trigger = turnSummaryTrigger(r.container);
    expect(trigger?.textContent).toContain("2 steps");
    expect(trigger?.textContent).toContain("2 commands");
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(r.container.textContent).toContain("Narration: one fixture needs a quick patch.");
    expect(turnSummaryTriggers(r.container).length).toBeGreaterThan(1);

    await r.unmount();
  });

  test("live turn activity renders the rail directly without a TurnSummary trigger", async () => {
    resetTimelineEvents();
    const events = [
      timelineEvent("user.message", { text: "Run the checks" }),
      timelineEvent("agent.reasoning.delta", { text: "Checking the suite." }),
      timelineEvent("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "bun test" } }),
    ];
    const r = await renderComponent(<MessageTimeline events={events} status="running" />);
    await flush();

    expect(turnSummaryTrigger(r.container)).toBeNull();
    expect(r.container.textContent).toContain("Checking the suite.");

    await r.unmount();
  });

  test("pending queued user messages show the quiet queued hint only while pending", async () => {
    resetTimelineEvents();
    const pendingEvents = [
      timelineEvent("user.message", { text: "Follow up after this turn" }, null),
      timelineEvent("turn.queued", { turnId: "turn-b", triggerEventId: "timeline-evt-1", source: "user" }, "turn-b"),
    ];
    const pending = await renderComponent(<MessageTimeline events={pendingEvents} />);
    await flush();

    expect(pending.container.textContent).toContain("Follow up after this turn");
    expect(pending.container.textContent).toContain("queued");
    await pending.unmount();

    resetTimelineEvents();
    const anchoredEvents = [
      timelineEvent("user.message", { text: "Follow up after this turn" }, null),
      timelineEvent("turn.queued", { turnId: "turn-b", triggerEventId: "timeline-evt-1", source: "user" }, "turn-b"),
      timelineEvent("turn.started", { triggerEventId: "timeline-evt-1" }, "turn-b"),
    ];
    const anchored = await renderComponent(<MessageTimeline events={anchoredEvents} />);
    await flush();

    expect(anchored.container.textContent).toContain("Follow up after this turn");
    expect(anchored.container.textContent).not.toContain("queued");
    await anchored.unmount();
  });

  test("duration facet renders when the settled turn lasts at least one second", async () => {
    resetTimelineEvents();
    const start = Date.UTC(2024, 5, 10, 12, 0, 0);
    const events = [
      timelineEventAt("user.message", { text: "Run the checks" }, new Date(start).toISOString(), null),
      timelineEventAt("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "bun test" } }, new Date(start + 1000).toISOString()),
      timelineEventAt("agent.toolCall.output", { id: "call-1", output: "ok" }, new Date(start + 2000).toISOString()),
      timelineEventAt("agent.message.completed", { text: "Done." }, new Date(start + 290000).toISOString()),
      timelineEventAt("turn.completed", {}, new Date(start + 301000).toISOString()),
    ];
    const r = await renderComponent(<MessageTimeline events={events} />);
    await flush();

    expect(turnSummaryTrigger(r.container)?.textContent).toContain("5m");

    await r.unmount();
  });

  test("duration facet stays hidden below one second", async () => {
    resetTimelineEvents();
    const start = Date.UTC(2024, 5, 10, 12, 0, 0);
    const events = [
      timelineEventAt("user.message", { text: "Run the checks" }, new Date(start).toISOString(), null),
      timelineEventAt("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "bun test" } }, new Date(start + 100).toISOString()),
      timelineEventAt("agent.toolCall.output", { id: "call-1", output: "ok" }, new Date(start + 200).toISOString()),
      timelineEventAt("turn.completed", {}, new Date(start + 999).toISOString()),
    ];
    const r = await renderComponent(<MessageTimeline events={events} />);
    await flush();

    expect(turnSummaryTrigger(r.container)?.textContent).not.toContain("1s");

    await r.unmount();
  });

  test("failed turns start expanded and show the failure text on the summary chip", async () => {
    resetTimelineEvents();
    const events = [
      timelineEvent("user.message", { text: "Deploy preview" }),
      timelineEvent("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "helm upgrade preview ./chart" } }),
      timelineEvent("turn.failed", { error: "provider down" }),
    ];
    const r = await renderComponent(<MessageTimeline events={events} />);
    await flush();

    const trigger = turnSummaryTrigger(r.container);
    expect(trigger?.getAttribute("data-state")).toBe("open");
    expect(trigger?.textContent).toContain("provider down");

    await r.unmount();
  });

  test("completed clusters of a RUNNING turn fold behind neutral chips; the live tail stays bare", async () => {
    resetTimelineEvents();
    const events = [
      timelineEvent("user.message", { text: "Do a long job" }),
      timelineEvent("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "step one" } }),
      timelineEvent("agent.toolCall.output", { id: "call-1", output: "ok" }),
      timelineEvent("agent.message.delta", { text: "Step one done, moving on." }),
      timelineEvent("agent.message.completed", { text: "Step one done, moving on." }),
      timelineEvent("agent.toolCall.created", { id: "call-2", name: "exec_command", arguments: { cmd: "step two" } }),
    ];
    const r = await renderComponent(<MessageTimeline events={events} status="running" />);
    await flush();

    const triggers = turnSummaryTriggers(r.container);
    // Exactly ONE chip: the completed first cluster. It is NEUTRAL — no verdict
    // glyph (chevron is the only svg; the slot holds the pulse dot span).
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.querySelectorAll("svg")).toHaveLength(1);
    expect(triggers[0]?.querySelector(".animate-og-pulse")).not.toBeNull();
    // The live tail cluster renders bare: its command is visible without expanding.
    expect(r.container.textContent).toContain("step two");
    // The folded cluster's contents are NOT in the DOM until expanded.
    expect(r.container.textContent).not.toContain("step one");

    await r.unmount();
  });

  test("a cluster paused for approval does NOT fold — the reader needs the context in view", async () => {
    resetTimelineEvents();
    const events = [
      timelineEvent("user.message", { text: "Deploy it" }),
      timelineEvent("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "terraform apply" } }),
      timelineEvent("session.requiresAction", {}),
    ];
    const r = await renderComponent(<MessageTimeline events={events} status="requires_action" />);
    await flush();

    // The waiting notice follows the cluster, but a notice is not agent
    // PROGRESS — the paused work stays expanded next to the approval ask.
    expect(turnSummaryTriggers(r.container)).toHaveLength(0);
    expect(r.container.textContent).toContain("terraform apply");
    expect(r.container.textContent).toContain("Approval needed");

    await r.unmount();
  });

  test("a STREAMING cluster never folds, even when a pending queued message sits after it", async () => {
    resetTimelineEvents();
    const events = [
      timelineEvent("user.message", { text: "Do a long job" }),
      timelineEvent("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "step one" } }),
      timelineEvent("agent.toolCall.output", { id: "call-1", output: "ok" }),
      timelineEvent("agent.message.delta", { text: "Step one done, moving on." }),
      timelineEvent("agent.message.completed", { text: "Step one done, moving on." }),
      // The ACTIVE cluster: tool call still running (no output yet).
      timelineEvent("agent.toolCall.created", { id: "call-2", name: "exec_command", arguments: { cmd: "step two running" } }),
      // A queued follow-up renders at the tail (#197 pending anchoring) —
      // making the running cluster second-to-last. It must STILL not fold.
      timelineEvent("user.message", { text: "queued follow-up" }, null),
      timelineEvent("turn.queued", { turnId: "turn-b", triggerEventId: "timeline-evt-7", source: "user" }, "turn-b"),
    ];
    const r = await renderComponent(<MessageTimeline events={events} status="running" />);
    await flush();

    // The settled first cluster folds; the RUNNING second cluster stays bare.
    const triggers = turnSummaryTriggers(r.container);
    expect(triggers).toHaveLength(1);
    expect(r.container.textContent).toContain("step two running");
    expect(r.container.textContent).toContain("queued follow-up");

    await r.unmount();
  });

  test("when the running turn settles, live-cluster chips give way to the single turn fold", async () => {
    resetTimelineEvents();
    const events = [
      timelineEvent("user.message", { text: "Do a long job" }),
      timelineEvent("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "step one" } }),
      timelineEvent("agent.toolCall.output", { id: "call-1", output: "ok" }),
      timelineEvent("agent.message.delta", { text: "Step one done, moving on." }),
      timelineEvent("agent.message.completed", { text: "Step one done, moving on." }),
      timelineEvent("agent.toolCall.created", { id: "call-2", name: "exec_command", arguments: { cmd: "step two" } }),
      timelineEvent("agent.toolCall.output", { id: "call-2", output: "ok" }),
      timelineEvent("agent.message.completed", { text: "All finished." }),
      timelineEvent("turn.completed", {}),
    ];
    const r = await renderComponent(<MessageTimeline events={events} />);
    await flush();

    const triggers = turnSummaryTriggers(r.container);
    // One settled OUTER chip (check glyph present: chevron + check = 2 svgs);
    // the final answer sits outside it.
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.querySelectorAll("svg")).toHaveLength(2);
    expect(r.container.textContent).toContain("All finished.");

    await r.unmount();
  });

  test("nested chips inside a failed turn stay quiet — the outer chip owns the failure", async () => {
    resetTimelineEvents();
    const events = [
      timelineEvent("user.message", { text: "Deploy preview" }),
      timelineEvent("agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: { cmd: "helm dep update" } }),
      timelineEvent("agent.toolCall.output", { id: "call-1", output: "ok" }),
      timelineEvent("agent.message.delta", { text: "Dependencies ready, deploying now." }),
      timelineEvent("agent.message.completed", { text: "Dependencies ready, deploying now." }),
      timelineEvent("agent.toolCall.created", { id: "call-2", name: "exec_command", arguments: { cmd: "helm upgrade preview ./chart" } }),
      timelineEvent("turn.failed", { error: "provider down" }),
    ];
    const r = await renderComponent(<MessageTimeline events={events} />);
    await flush();

    const triggers = turnSummaryTriggers(r.container);
    // The open outer chip is the one loud failure surface; nested cluster chips
    // are closed and never repeat the failure text.
    const withFailure = triggers.filter((t) => (t.textContent ?? "").includes("provider down"));
    expect(withFailure).toHaveLength(1);
    expect(withFailure[0]?.getAttribute("data-state")).toBe("open");
    const nested = triggers.filter((t) => t !== withFailure[0]);
    expect(nested.length).toBeGreaterThan(0);
    for (const chip of nested) {
      expect(chip.getAttribute("data-state")).toBe("closed");
    }

    await r.unmount();
  });
});

/* ---- Issue 2: multi-file apply_patch count ------------------------------ */

describe("ApplyPatchRenderer — multi-file with one malformed op", () => {
  // Build a raw apply_patch_call with two ops: one valid update and one that
  // will throw in v4aToGitFileDiff (content with no @@ anchor on an update).
  const raw = {
    type: "apply_patch_call",
    operations: [
      // Valid: has a proper @@ anchor.
      { type: "update_file", path: "src/good.ts", diff: "@@ -1,2 +1,2 @@\n context\n-old\n+new" },
      // Malformed: update_file with non-empty content but no @@ anchor → v4aToGitFileDiff throws.
      { type: "update_file", path: "src/bad.ts", diff: "this has no hunk anchor at all" },
    ],
  };

  test("title and preview show ops.length (2), not the parsed-only count (1)", async () => {
    const item = toolItem({
      name: "apply_patch_call",
      raw,
      status: "complete",
      output: "ok",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    // The title "Edited 2 files" must be present — not "Edited 1 files".
    const titleText = r.container.textContent ?? "";
    expect(titleText).toContain("2 files");
    expect(titleText).not.toContain("Edited 1 files");

    await r.unmount();
  });

  test("the malformed op renders a raw fallback, not silent omission", async () => {
    const item = toolItem({
      name: "apply_patch_call",
      raw,
      status: "complete",
      output: "ok",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    // Expand the disclosure to see the body content.
    const trigger = r.container.querySelector('[role="button"]') as HTMLElement | null;
    trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const bodyText = r.container.textContent ?? "";
    // The raw patch fallback label must appear for the malformed op.
    expect(bodyText.toLowerCase()).toContain("raw patch");

    await r.unmount();
  });
});

/* ---- Issue 3: exec failure NUL-storage vs generic failure --------------- */

describe("ExecRenderer — failed+empty-output distinction", () => {
  const execArgs = JSON.stringify({ cmd: "npm test" });

  test("output===undefined (no output event) → NUL-storage explanation", async () => {
    // output stays undefined: projection never received agent.toolCall.output for this call.
    const item = toolItem({
      name: "exec_command",
      arguments: execArgs,
      output: undefined,
      status: "failed",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    const text = r.container.textContent ?? "";
    // Must mention NUL / NUL byte — the specific storage-failure explanation.
    expect(text.toLowerCase()).toContain("nul");

    await r.unmount();
  });

  test("output===null (output event arrived, empty) → generic failure, NOT NUL explanation", async () => {
    // output is null: an output event arrived (e.g. MCP isError) but with null payload.
    const item = toolItem({
      name: "exec_command",
      arguments: execArgs,
      output: null,
      status: "failed",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    const text = r.container.textContent ?? "";
    // Must NOT claim NUL byte caused this failure.
    expect(text.toLowerCase()).not.toContain("nul");
    // Must surface a general failure signal.
    expect(text.toLowerCase()).toContain("fail");

    await r.unmount();
  });

  test("output==='' (output event arrived, empty string) → generic failure, NOT NUL explanation", async () => {
    // output is empty string: an output event arrived with error:true and empty output.
    const item = toolItem({
      name: "exec_command",
      arguments: execArgs,
      output: "",
      status: "failed",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    const text = r.container.textContent ?? "";
    expect(text.toLowerCase()).not.toContain("nul");
    expect(text.toLowerCase()).toContain("fail");

    await r.unmount();
  });
});

/* ---- Finding A: WebSearchRenderer — null entry in results array --------- */

describe("WebSearchRenderer — null/undefined entries in results array", () => {
  test("renders without throwing when results contains a null entry", async () => {
    // Simulate a host-enriched output where one entry is null (untrusted data).
    const item = toolItem({
      name: "web_search_call",
      arguments: JSON.stringify({ query: "safe null test" }),
      raw: { providerData: { action: { query: "safe null test" } } },
      output: {
        results: [
          null,
          { title: "Good Result", domain: "example.com", snippet: "A real result." },
          undefined,
          { title: "Another Good", domain: "other.com", snippet: "Also real." },
        ],
      },
      status: "complete",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    // Must not throw during render.
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    // Expand the disclosure to see the body.
    const trigger = r.container.querySelector('[role="button"]') as HTMLElement | null;
    trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const text = r.container.textContent ?? "";
    // The two valid entries should appear; the nulls are silently dropped.
    expect(text).toContain("Good Result");
    expect(text).toContain("Another Good");

    await r.unmount();
  });

  test("all-null results array renders the fallback note, not a crash", async () => {
    const item = toolItem({
      name: "web_search_call",
      arguments: JSON.stringify({ query: "all null" }),
      raw: { providerData: { action: { query: "all null" } } },
      output: { results: [null, null] },
      status: "complete",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    // Expand.
    const trigger = r.container.querySelector('[role="button"]') as HTMLElement | null;
    trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const text = r.container.textContent ?? "";
    // No valid results → fallback note.
    expect(text.toLowerCase()).toContain("no list available");

    await r.unmount();
  });
});

/* ---- Finding B: failed tool WITH non-empty output shows failure affordance */

describe("ExecRenderer — failed status with non-empty output", () => {
  const execArgs = JSON.stringify({ cmd: "make build" });

  test("failed status with non-empty output carries the failure affordance", async () => {
    // Simulate a tool that returned output but the SDK marked the call failed
    // (e.g. MCP isError:true with a non-empty error message in output).
    const item = toolItem({
      name: "exec_command",
      arguments: execArgs,
      output: "make: *** [build] Error 2\nsome build output here",
      status: "failed",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    const text = r.container.textContent ?? "";
    // The failure affordance must be present — either the "failed" chip text
    // or the exit-code chip. We look for "fail" to cover both cases.
    expect(text.toLowerCase()).toContain("fail");

    await r.unmount();
  });

  test("failed status with non-empty output still shows the output on expand", async () => {
    const item = toolItem({
      name: "exec_command",
      arguments: execArgs,
      output: "unique-output-marker-xyz",
      status: "failed",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    // Expand.
    const trigger = r.container.querySelector('[role="button"]') as HTMLElement | null;
    trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const text = r.container.textContent ?? "";
    // Output still visible after expand.
    expect(text).toContain("unique-output-marker-xyz");

    await r.unmount();
  });
});

/* ---- Running-state: apply_patch_call -------------------------------------- */

describe("ApplyPatchRenderer — running state (in-flight affordance)", () => {
  const rawSingleOp = {
    type: "apply_patch_call",
    operations: [{ type: "update_file", path: "src/foo.ts", diff: "@@ -1,2 +1,2 @@\n context\n-old\n+new" }],
  };
  const rawMultiOp = {
    type: "apply_patch_call",
    operations: [
      { type: "update_file", path: "src/a.ts", diff: "@@ -1,2 +1,2 @@\n context\n-old\n+new" },
      { type: "update_file", path: "src/b.ts", diff: "@@ -1,2 +1,2 @@\n ctx\n-x\n+y" },
    ],
  };

  test("running single-op: row shimmers (running class) and shows in-flight copy, not 'Edited'", async () => {
    const item = toolItem({
      name: "apply_patch_call",
      raw: rawSingleOp,
      status: "running",
      output: undefined,
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    const text = r.container.textContent ?? "";
    // Must show "Applying" verb, not the settled "Edited" verb.
    expect(text).toContain("Applying");
    expect(text).not.toContain("Edited");
    // The shimmer class must be present on the title element.
    const shimmer = r.container.querySelector(".og-shimmer-text");
    expect(shimmer).not.toBeNull();

    await r.unmount();
  });

  test("running multi-op: row shimmers and shows file count as in-flight, not settled count", async () => {
    const item = toolItem({
      name: "apply_patch_call",
      raw: rawMultiOp,
      status: "running",
      output: undefined,
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    const text = r.container.textContent ?? "";
    // Title must say "Applying 2 files" (not "Edited 2 files").
    expect(text).toContain("Applying");
    expect(text).toContain("2");
    expect(text).not.toContain("Edited");
    const shimmer = r.container.querySelector(".og-shimmer-text");
    expect(shimmer).not.toBeNull();

    await r.unmount();
  });

  test("settled apply_patch still shows 'Edited' (regression guard)", async () => {
    const item = toolItem({
      name: "apply_patch_call",
      raw: rawSingleOp,
      status: "complete",
      output: "ok",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    const text = r.container.textContent ?? "";
    expect(text).toContain("Edited");
    expect(text).not.toContain("Applying");

    await r.unmount();
  });
});

/* ---- Running-state: write_stdin ------------------------------------------- */

describe("WriteStdinRenderer — running state (in-flight affordance)", () => {
  test("running write_stdin: row shimmers and shows 'sending…', not settled 'sent'", async () => {
    const item = toolItem({
      name: "write_stdin",
      arguments: JSON.stringify({ session_id: "sess-42", chars: "ls\n" }),
      status: "running",
      output: undefined,
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    const text = r.container.textContent ?? "";
    // Must show in-flight copy.
    expect(text.toLowerCase()).toContain("sending");
    // Must NOT show the settled "sent" copy.
    expect(text).not.toContain("sent");
    // Shimmer class must be on the title.
    const shimmer = r.container.querySelector(".og-shimmer-text");
    expect(shimmer).not.toBeNull();

    await r.unmount();
  });

  test("settled write_stdin shows 'sent' copy (regression guard)", async () => {
    const item = toolItem({
      name: "write_stdin",
      arguments: JSON.stringify({ session_id: "sess-42", chars: "ls\n" }),
      status: "complete",
      output: "",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    const text = r.container.textContent ?? "";
    expect(text.toLowerCase()).toContain("sent");

    await r.unmount();
  });
});

/* ---- Running-state: view_image -------------------------------------------- */

describe("ViewImageRenderer — running state (in-flight affordance)", () => {
  test("running view_image: row shimmers (not settled); body shows 'reading' copy on expand", async () => {
    const item = toolItem({
      name: "view_image",
      arguments: JSON.stringify({ path: "/tmp/screenshot.png" }),
      status: "running",
      output: undefined,
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    // Shimmer class must be present on the title — this is the in-flight signal.
    const shimmer = r.container.querySelector(".og-shimmer-text");
    expect(shimmer).not.toBeNull();

    // Expand the row to see the body note.
    const trigger = r.container.querySelector('[role="button"]') as HTMLElement | null;
    trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const text = r.container.textContent ?? "";
    expect(text.toLowerCase()).toContain("reading");

    await r.unmount();
  });
});

/* ---- Running-state: environment_set_variable ------------------------------ */

describe("SecretSetRenderer — running state (in-flight affordance)", () => {
  test("running environment_set_variable: row shimmers and shows 'setting…'", async () => {
    const item = toolItem({
      name: "environment_set_variable",
      arguments: JSON.stringify({ name: "MY_SECRET", value: "hunter2" }),
      status: "running",
      output: undefined,
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    const text = r.container.textContent ?? "";
    expect(text.toLowerCase()).toContain("setting");
    // Settled copy "write-only · never returned" must NOT appear during in-flight.
    expect(text).not.toContain("write-only");
    const shimmer = r.container.querySelector(".og-shimmer-text");
    expect(shimmer).not.toBeNull();

    await r.unmount();
  });

  test("settled environment_set_variable shows write-only copy (regression guard)", async () => {
    const item = toolItem({
      name: "environment_set_variable",
      arguments: JSON.stringify({ name: "MY_SECRET", value: "hunter2" }),
      status: "complete",
      output: "ok",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    const text = r.container.textContent ?? "";
    expect(text.toLowerCase()).toContain("write-only");

    await r.unmount();
  });

  // Fix 2: failed environment_set_variable must show failure affordance, NOT success copy
  test("failed environment_set_variable shows failed affordance, NOT write-only success copy", async () => {
    const item = toolItem({
      name: "environment_set_variable",
      arguments: JSON.stringify({ name: "MY_SECRET", value: "hunter2" }),
      status: "failed",
      output: "permission denied",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    const text = r.container.textContent ?? "";
    // Must surface the failure affordance.
    expect(text.toLowerCase()).toContain("fail");
    // Must NOT show the success "write-only" copy.
    expect(text.toLowerCase()).not.toContain("write-only");
    // The error output must be accessible.
    expect(text).toContain("permission denied");

    await r.unmount();
  });

  test("failed environment_set_variable with no output shows generic failure, NOT write-only copy", async () => {
    const item = toolItem({
      name: "environment_set_variable",
      arguments: JSON.stringify({ name: "MY_SECRET", value: "hunter2" }),
      status: "failed",
      output: undefined,
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    const text = r.container.textContent ?? "";
    expect(text.toLowerCase()).toContain("fail");
    expect(text.toLowerCase()).not.toContain("write-only");

    await r.unmount();
  });
});

/* ---- Fix 1: SandboxRow — failed chip ---------------------------------------- */

function sandboxItem(overrides: Partial<SandboxItem>): SandboxItem {
  return {
    kind: "sandbox",
    id: "sb-1",
    turnId: "turn-1",
    name: "exec",
    command: "terraform apply",
    output: "",
    status: "complete",
    occurredAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("SandboxRow — failed chip", () => {
  test("a failed sandbox item shows the failed chip (not just the red icon tone)", async () => {
    const item = sandboxItem({ status: "failed", output: "connection refused" });
    const r = await renderComponent(<ActivityRail items={[item]} />);
    await flush();

    const text = r.container.textContent ?? "";
    // The "failed" chip text must appear in the collapsed row.
    expect(text.toLowerCase()).toContain("failed");

    await r.unmount();
  });

  test("a complete sandbox item does NOT show a failed chip (regression guard)", async () => {
    const item = sandboxItem({ status: "complete" });
    const r = await renderComponent(<ActivityRail items={[item]} />);
    await flush();

    const text = r.container.textContent ?? "";
    // No failure chip for a successful op.
    expect(text.toLowerCase()).not.toContain("failed");

    await r.unmount();
  });
});
