import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { act } from "react";
import { MessageTimeline } from "../src";
import recordedAnswerExchange from "./fixtures/exchange-answer-before-machine-turns.json";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const WORKER = "0d4f6a8b-2c3e-4f5a-8b9c-1d2e3f4a5b6c";
let sequence = 0;
// Anchored in the past so live clocks read a realistic elapsed time.
const START = Date.now() - 10 * 60_000;

function event(type: string, payload: unknown, turnId: string | null = "turn-1"): SessionEvent {
  sequence += 1;
  return {
    id: `row-evt-${sequence}`,
    workspaceId: "ws-1",
    sessionId: "session-1",
    sequence,
    type,
    payload,
    occurredAt: new Date(START + sequence * 5_000).toISOString(),
    turnId,
  };
}

function tool(id: string, name: string, turnId = "turn-1", output: unknown = "ok") {
  return [
    event("agent.toolCall.created", { id, name, arguments: { cmd: id } }, turnId),
    event("agent.toolCall.output", { id, output }, turnId),
  ];
}

function exchange() {
  sequence = 0;
  const first = [
    event("user.message", { text: "Count new users" }, null),
    event("turn.started", {}),
    event("agent.message.delta", { text: "Starting a worker for the count." }),
    ...tool("skill", "skill_read"),
    event("agent.toolCall.created", {
      id: "spawn",
      name: "opengeni__session_create",
      arguments: { initialMessage: "Count" },
    }),
    event("agent.toolCall.output", { id: "spawn", output: { sessionId: WORKER } }),
    event("agent.message.delta", { text: "The **worker** is still running." }),
    event("agent.toolCall.created", { id: "park", name: "wait_for_input", arguments: {} }),
    event("session.wait.started", {
      actor: "agent",
      reason: "Worker running.",
      waitTurnId: "turn-1",
    }),
    event("agent.toolCall.output", { id: "park", output: { status: "waiting_for_input" } }),
    event("turn.completed", { output: "" }),
  ];
  const resumed = [
    event(
      "system.update.delivered",
      {
        members: [
          {
            id: "result",
            kind: "child_terminal_result",
            classification: "success",
            sourceId: WORKER,
            summary: "A worker session you spawned has COMPLETED its goal.",
          },
        ],
      },
      "turn-2",
    ),
    event("turn.started", {}, "turn-2"),
    ...tool("events", "exec_command", "turn-2"),
  ];
  const answer = [
    event("agent.message.delta", { text: "312 users signed up." }, "turn-2"),
    event(
      "agent.message.completed",
      { text: "312 users signed up.", phase: "final_answer" },
      "turn-2",
    ),
    event("turn.completed", {}, "turn-2"),
  ];
  return { first, resumed, answer };
}

function statusTrigger(container: HTMLElement): HTMLButtonElement {
  const trigger = container
    .querySelector("[data-og-exchange-status]")
    ?.closest("button") as HTMLButtonElement | null;
  if (!trigger) throw new Error("expected an exchange status row");
  return trigger;
}

function topLevelMessages(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-og-group-key]")).flatMap((group) => {
    const message = group.querySelector(":scope [data-og-wide-table-message]");
    return message && !message.closest("[data-og-fold-content]") ? [message.textContent ?? ""] : [];
  });
}

describe("compact exchange rows", () => {
  test("a working exchange is one status row with its latest note and current step", async () => {
    const { first } = exchange();
    // Through the spawn and the second note's follow-up tool call.
    const live = first.slice(0, 11);
    const r = await renderComponent(
      <MessageTimeline events={live} turnSummary={{ rolling: true }} />,
    );
    try {
      await flush();
      const trigger = statusTrigger(r.container);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      // Notes narrate steps and are not counted as steps.
      expect(trigger.textContent).toMatch(/^Working · \d+m( \d+s)? · 3 steps/);
      const note = r.container.querySelector("[data-og-exchange-note]");
      // The latest note, as plain text for the two-line clamp.
      expect(note?.textContent).toBe("The worker is still running.");
      expect(
        r.container.querySelector("[data-og-exchange-preview] .og-rolling-status"),
      ).not.toBeNull();
      // No progress note renders as its own message row.
      expect(topLevelMessages(r.container)).toEqual([]);

      await act(async () => trigger.click());
      await flush();
      const notes = Array.from(r.container.querySelectorAll("[data-og-activity-note]")).map(
        (row) => row.textContent,
      );
      expect(notes).toEqual(["Starting a worker for the count.", "The worker is still running."]);
      // The open row keeps its status line and drops the collapsed preview.
      expect(r.container.querySelector("[data-og-exchange-preview]")).toBeNull();
    } finally {
      await r.unmount();
    }
  });

  test("a parked exchange says how many agents it is waiting for", async () => {
    const { first } = exchange();
    const r = await renderComponent(
      <MessageTimeline events={first} turnSummary={{ rolling: true }} />,
    );
    try {
      await flush();
      expect(statusTrigger(r.container).textContent).toMatch(/^Waiting for 1 agent · /);
      expect(r.container.querySelector("[data-og-exchange-note]")?.textContent).toBe(
        "The worker is still running.",
      );
      expect(r.container.textContent).not.toContain("Wait recorded");
      expect(topLevelMessages(r.container)).toEqual([]);
    } finally {
      await r.unmount();
    }
  });

  test("a resumed exchange keeps one live row and the answer sits below a separator", async () => {
    const { first, resumed, answer } = exchange();
    const r = await renderComponent(
      <MessageTimeline events={[...first, ...resumed]} turnSummary={{ rolling: true }} />,
    );
    try {
      await flush();
      expect(statusTrigger(r.container).textContent).toMatch(/^Working · /);
      expect(r.container.querySelectorAll("[data-og-exchange-status]")).toHaveLength(1);

      await r.rerender(
        <MessageTimeline
          events={[...first, ...resumed, ...answer]}
          turnSummary={{ rolling: true }}
        />,
      );
      await flush();
      const trigger = statusTrigger(r.container);
      expect(trigger.textContent).toMatch(/^Worked for \d+m( \d+s)? · 4 steps/);
      expect(r.container.querySelectorAll("[data-og-exchange-status]")).toHaveLength(1);
      expect(r.container.querySelector("[data-og-exchange-preview]")).toBeNull();
      expect(topLevelMessages(r.container)).toEqual(["312 users signed up."]);

      // Everything else stays one click away, including the recorded wait.
      await act(async () => trigger.click());
      await flush();
      const wait = r.container.querySelector('[data-og-recorded-outcome="wait"] summary');
      expect(wait?.textContent).toMatch(/^Waited for 1 agent · \d+s$/);
      expect(r.container.textContent).toContain("Agent result received");
    } finally {
      await r.unmount();
    }
  });

  test("an opened row stays the same open row as turns start and end", async () => {
    const { first, resumed, answer } = exchange();
    const timeline = (events: SessionEvent[]) => (
      <MessageTimeline events={events} turnSummary={{ rolling: true }} />
    );
    const r = await renderComponent(timeline(first));
    try {
      await flush();
      const trigger = statusTrigger(r.container);
      await act(async () => trigger.click());
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      for (const events of [
        [...first, ...resumed],
        [...first, ...resumed, ...answer],
      ]) {
        await r.rerender(timeline(events));
        await flush();
        // Same element: the row never remounts between its live and settled forms.
        expect(statusTrigger(r.container)).toBe(trigger);
        expect(trigger.getAttribute("aria-expanded")).toBe("true");
      }
    } finally {
      await r.unmount();
    }
  });

  test("a settled turn that grows into an exchange keeps its row through the next turn", async () => {
    sequence = 0;
    const answered = [
      event("user.message", { text: "Build and report" }, null),
      event("turn.started", {}),
      ...tool("build", "exec_command"),
      event("agent.message.completed", { text: "The build is running in the background." }),
      event("turn.completed", {}),
    ];
    const result = event(
      "system.update.delivered",
      {
        members: [
          {
            id: "command",
            kind: "background_command_result",
            classification: "success",
            sourceId: "command-1",
            summary: "execCommand: completed successfully.",
          },
        ],
      },
      "turn-2",
    );
    const next = [event("turn.started", {}, "turn-2"), ...tool("report", "exec_command", "turn-2")];
    const timeline = (events: SessionEvent[]) => (
      <MessageTimeline events={events} turnSummary={{ rolling: true }} />
    );
    const r = await renderComponent(timeline(answered));
    try {
      await flush();
      await r.rerender(timeline([...answered, result]));
      await flush();
      const trigger = statusTrigger(r.container);
      await act(async () => trigger.click());
      await r.rerender(timeline([...answered, result, ...next]));
      await flush();
      expect(statusTrigger(r.container)).toBe(trigger);
      expect(trigger.textContent).toMatch(/^Working · /);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
    } finally {
      await r.unmount();
    }
  });

  test("an approval wait says so, and the approved turn settles back into one row", async () => {
    sequence = 0;
    const waiting = [
      event("user.message", { text: "Deploy it" }, null),
      event("turn.started", {}),
      ...tool("plan", "exec_command"),
      event("session.requiresAction", {}),
      event("session.status.changed", { status: "requires_action" }),
    ];
    const approved = [
      event("session.status.changed", { status: "running" }),
      ...tool("apply", "exec_command"),
    ];
    const done = [
      event("agent.message.completed", { text: "Deployed.", phase: "final_answer" }),
      event("turn.completed", {}),
    ];
    const timeline = (events: SessionEvent[]) => (
      <MessageTimeline events={events} turnSummary={{ rolling: true }} />
    );
    const r = await renderComponent(timeline(waiting));
    try {
      await flush();
      expect(statusTrigger(r.container).textContent).toMatch(/^Waiting for you · /);
      await r.rerender(timeline([...waiting, ...approved]));
      await flush();
      const statuses = Array.from(r.container.querySelectorAll("[data-og-exchange-status]")).map(
        (status) => status.getAttribute("data-og-exchange-status"),
      );
      // The approved work continues in a live row; the earlier part is behind it.
      expect(statuses).toEqual(["worked", "working"]);
      await r.rerender(timeline([...waiting, ...approved, ...done]));
      await flush();
      expect(r.container.querySelectorAll("[data-og-exchange-status]")).toHaveLength(1);
      expect(topLevelMessages(r.container)).toEqual(["Deployed."]);
    } finally {
      await r.unmount();
    }
  });

  test("a note streaming as recorded today keeps the row working", async () => {
    sequence = 0;
    const working = [
      event("user.message", { text: "Check the config" }, null),
      event("turn.started", {}),
      ...tool("read", "exec_command"),
      // Identified deltas without a phase, exactly as the runtime records them.
      event("agent.message.delta", {
        text: "Checking `OPENGENI_SANDBOX_BACKEND` ",
        messageId: "n1",
      }),
      event("agent.message.delta", {
        text: "in user_accounts_table and **the** _env_.",
        messageId: "n1",
      }),
    ];
    const r = await renderComponent(
      <MessageTimeline events={working} turnSummary={{ rolling: true }} />,
    );
    try {
      await flush();
      expect(statusTrigger(r.container).textContent).toMatch(/^Working · /);
      expect(
        r.container
          .querySelector("[data-og-exchange-status]")
          ?.getAttribute("data-og-exchange-status"),
      ).toBe("working");
      expect(r.container.querySelector("[data-og-exchange-note]")?.textContent).toBe(
        "Checking OPENGENI_SANDBOX_BACKEND in user_accounts_table and the env.",
      );
      expect(topLevelMessages(r.container)).toEqual([]);
    } finally {
      await r.unmount();
    }
  });

  test("the worked time stays the same when the streaming answer completes", async () => {
    sequence = 0;
    const long = "Signups come from three sources that need reconciling. ".repeat(24);
    const streaming = [
      event("user.message", { text: "Explain the signups" }, null),
      event("turn.started", {}),
      ...tool("read", "exec_command"),
      ...tool("query", "exec_command"),
      event("agent.message.delta", { text: long, messageId: "a1" }),
    ];
    const done = [
      event("agent.message.completed", { text: long }),
      event("turn.completed", { output: long }),
    ];
    const timeline = (events: SessionEvent[]) => (
      <MessageTimeline events={events} turnSummary={{ rolling: true }} />
    );
    const r = await renderComponent(timeline(streaming));
    try {
      await flush();
      const live = statusTrigger(r.container).textContent ?? "";
      expect(live).toMatch(/^Worked for 20s · 2 steps/);
      await r.rerender(timeline([...streaming, ...done]));
      await flush();
      expect(statusTrigger(r.container).textContent).toMatch(/^Worked for 20s · 2 steps/);
    } finally {
      await r.unmount();
    }
  });

  test("an answer stays a visible message when a machine-triggered turn follows it", async () => {
    // Anonymized replay of a recorded exchange: the answer (bullets, an image,
    // and a question) settles, then an agent message starts one more short
    // turn that ends without prose.
    const r = await renderComponent(
      <MessageTimeline
        events={recordedAnswerExchange as SessionEvent[]}
        turnSummary={{ rolling: true }}
      />,
    );
    try {
      await flush();
      const question = "Do you approve this four-at-a-time layout?";
      // The answer is not demoted to the row's muted two-line preview.
      for (const note of r.container.querySelectorAll("[data-og-exchange-note]")) {
        expect(note.textContent).not.toContain(question);
      }
      expect(topLevelMessages(r.container).some((text) => text.includes(question))).toBe(true);
    } finally {
      await r.unmount();
    }
  });

  test("the classic grouping keeps every note and wait as its own row", async () => {
    const { first, resumed, answer } = exchange();
    const r = await renderComponent(<MessageTimeline events={[...first, ...resumed, ...answer]} />);
    try {
      await flush();
      expect(r.container.querySelector("[data-og-exchange-status]")).toBeNull();
      expect(topLevelMessages(r.container)).toContain("312 users signed up.");
      expect(r.container.querySelector('[data-og-recorded-outcome="wait"]')).not.toBeNull();
    } finally {
      await r.unmount();
    }
  });
});
