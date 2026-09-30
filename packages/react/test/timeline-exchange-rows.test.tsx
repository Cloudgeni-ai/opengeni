import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { act } from "react";
import { MessageTimeline } from "../src";
import recordedAnswerExchange from "./fixtures/exchange-answer-before-machine-turns.json";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

test("Latest question explains a pending queue destination when the host provides no queue focus", async () => {
  const reason = new Error("Queued");
  reason.name = "LatestQuestionQueuedError";
  const view = await renderComponent(
    <MessageTimeline
      events={[]}
      turnSummary={{ rolling: true }}
      hasNewer
      onJumpToLatestQuestion={async () => {
        throw reason;
      }}
    />,
  );
  try {
    await flush(50);
    const button = view.container.querySelector<HTMLButtonElement>("[data-og-jump-to-question]");
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    await flush(30);
    expect(view.container.querySelector('[role="status"]')?.textContent).toContain(
      "The latest question is in the prompt queue.",
    );
    expect(button?.disabled).toBe(false);
  } finally {
    await view.unmount();
  }
});

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

describe("readable per-turn rows", () => {
  test("a text-only live work row keeps its disclosure when the first tool arrives", async () => {
    sequence = 0;
    const progress = event("agent.message.completed", {
      text: "Checking the ledger.",
      messageId: "start",
      phase: "commentary",
    });
    const r = await renderComponent(
      <MessageTimeline events={[progress]} turnSummary={{ rolling: true }} />,
    );
    try {
      const trigger = statusTrigger(r.container);
      await act(async () => trigger.click());
      await r.rerender(
        <MessageTimeline
          events={[progress, ...tool("read", "exec_command")]}
          turnSummary={{ rolling: true }}
        />,
      );
      expect(statusTrigger(r.container)).toBe(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
    } finally {
      await r.unmount();
    }
  });

  test("late primary media reveals untouched work without replacing reader-owned controls", async () => {
    for (const choice of [undefined, true, false]) {
      sequence = 0;
      const events = [...tool("read", "exec_command")];
      const r = await renderComponent(
        <MessageTimeline events={events} turnSummary={{ rolling: true }} />,
      );
      try {
        const trigger = statusTrigger(r.container);
        if (choice !== undefined) {
          await act(async () => trigger.click());
          if (!choice) await act(async () => trigger.click());
        }
        const toolNode = r.container.querySelector("[data-og-item]");
        await r.rerender(
          <MessageTimeline
            events={[...events, ...tool("image", "generate_image")]}
            turnSummary={{ rolling: true }}
          />,
        );
        await flush();
        expect(statusTrigger(r.container)).toBe(trigger);
        expect(trigger.getAttribute("aria-expanded")).toBe(choice === false ? "false" : "true");
        if (choice === true) expect(r.container.querySelector("[data-og-item]")).toBe(toolNode);
      } finally {
        await r.unmount();
      }
    }
  });

  test("settled details interleave full Markdown progress and tools while the final stays primary", async () => {
    sequence = 0;
    const events = [
      event("agent.message.delta", { messageId: "first", text: "First **progress**" }),
      ...tool("read", "exec_command"),
      event("agent.message.delta", {
        messageId: "second",
        text: "Second [progress](https://example.com)",
      }),
      ...tool("verify", "exec_command"),
      event("agent.message.delta", {
        messageId: "final",
        phase: "final_answer",
        text: "Final response",
      }),
      event("turn.completed", {}),
    ];
    const r = await renderComponent(
      <MessageTimeline events={events} turnSummary={{ rolling: true }} />,
    );
    try {
      await flush();
      expect(topLevelMessages(r.container)).toEqual(["Final response"]);
      const trigger = statusTrigger(r.container);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(trigger.textContent).toContain("2 steps");
      await act(async () => trigger.click());
      const details = r.container.querySelector("[data-og-fold-content]")!;
      expect(details.querySelector("strong")?.textContent).toBe("progress");
      expect(details.querySelector("a")?.textContent).toBe("progress");
      expect(
        Array.from(details.querySelectorAll("[data-og-item], [data-og-wide-table-message]")).map(
          (item) => item.textContent,
        ),
      ).toEqual([
        expect.stringContaining("First progress"),
        expect.stringContaining("read"),
        expect.stringContaining("Second progress"),
        expect.stringContaining("verify"),
      ]);
      expect(topLevelMessages(r.container)).toEqual(["Final response"]);
    } finally {
      await r.unmount();
    }
  });

  test("progress keeps Markdown and distinct message rows while completed tools do not spin", async () => {
    const { first } = exchange();
    const r = await renderComponent(
      <MessageTimeline events={first.slice(0, 8)} turnSummary={{ rolling: true }} />,
    );
    try {
      await flush();
      expect(statusTrigger(r.container).textContent).toMatch(/^Working · /);
      expect(topLevelMessages(r.container)).toEqual([
        "Starting a worker for the count.",
        "The worker is still running.",
      ]);
      expect(r.container.querySelector("[data-og-wide-table-message] strong")?.textContent).toBe(
        "worker",
      );
      expect(r.container.querySelector("[data-og-exchange-note]")).toBeNull();
      expect(
        r.container.querySelector(".og-rolling-status")?.getAttribute("data-running"),
      ).not.toBe("true");
      expect(statusTrigger(r.container).textContent).not.toContain("commands");
      expect(statusTrigger(r.container).textContent).not.toContain("show steps");
    } finally {
      await r.unmount();
    }
  });

  test("waiting count and historical duration remain visible beside separate resumed turns", async () => {
    const { first, resumed, answer } = exchange();
    const timeline = (events: SessionEvent[]) => (
      <MessageTimeline events={events} turnSummary={{ rolling: true }} />
    );
    const r = await renderComponent(timeline(first));
    try {
      await flush();
      expect(
        r.container.querySelector('[data-og-recorded-outcome="wait"] summary')?.textContent,
      ).toMatch(/^Waiting for 1 agent/);
      await r.rerender(timeline([...first, ...resumed, ...answer]));
      await flush();
      expect(r.container.querySelectorAll("[data-og-exchange-status]")).toHaveLength(2);
      expect(
        r.container.querySelector('[data-og-recorded-outcome="wait"] summary')?.textContent,
      ).toMatch(/^Waited for 1 agent · \d+s/);
      expect(topLevelMessages(r.container)).toEqual([
        "The worker is still running.",
        "312 users signed up.",
      ]);
      await act(async () => statusTrigger(r.container).click());
      expect(r.container.querySelector("[data-og-fold-content]")?.textContent).toContain(
        "Starting a worker for the count.",
      );
    } finally {
      await r.unmount();
    }
  });

  test("an expanded work row keeps its element and state through settlement and later turns", async () => {
    const { first, resumed, answer } = exchange();
    const timeline = (events: SessionEvent[]) => (
      <MessageTimeline events={events} turnSummary={{ rolling: true }} />
    );
    const r = await renderComponent(timeline(first.slice(0, 8)));
    try {
      await flush();
      const trigger = statusTrigger(r.container);
      await act(async () => trigger.click());
      for (const events of [first, [...first, ...resumed], [...first, ...resumed, ...answer]]) {
        await r.rerender(timeline(events));
        await flush();
        expect(statusTrigger(r.container)).toBe(trigger);
        expect(trigger.getAttribute("aria-expanded")).toBe("true");
      }
    } finally {
      await r.unmount();
    }
  });

  test("approval pauses overall activity; approved work resumes the same row", async () => {
    sequence = 0;
    const waiting = [
      event("turn.started", {}),
      ...tool("plan", "exec_command"),
      event("session.requiresAction", {}),
      event("session.status.changed", { status: "requires_action" }),
    ];
    const r = await renderComponent(
      <MessageTimeline events={waiting} turnSummary={{ rolling: true }} />,
    );
    try {
      await flush();
      expect(statusTrigger(r.container).textContent).toMatch(/^Waiting for you/);
      await r.rerender(
        <MessageTimeline
          events={[
            ...waiting,
            event("session.status.changed", { status: "running" }),
            ...tool("apply", "exec_command"),
          ]}
          turnSummary={{ rolling: true }}
        />,
      );
      await flush();
      expect(statusTrigger(r.container).textContent).toMatch(/^Working/);
      expect(r.container.querySelectorAll("[data-og-exchange-status]")).toHaveLength(1);
    } finally {
      await r.unmount();
    }
  });

  test("same-tool approval resumption clears live waiting without hiding historical approval", async () => {
    sequence = 0;
    const waiting = [
      event("turn.started", {}),
      event("agent.toolCall.created", { id: "same", name: "exec_command", arguments: {} }),
      event("session.requiresAction", {}),
      event("session.status.changed", { status: "requires_action" }, null),
    ];
    const r = await renderComponent(
      <MessageTimeline events={waiting} turnSummary={{ rolling: true }} />,
    );
    try {
      await flush();
      const trigger = statusTrigger(r.container);
      expect(trigger.textContent).toMatch(/^Waiting for you/);
      await r.rerender(
        <MessageTimeline
          events={[
            ...waiting,
            event("session.status.changed", { status: "running" }, null),
            event("agent.toolCall.output", { id: "same", output: "approved result" }),
            event("agent.message.delta", {
              text: "Continuing the approved work.",
              phase: "commentary",
            }),
          ]}
          turnSummary={{ rolling: true }}
        />,
      );
      await flush();
      expect(statusTrigger(r.container)).toBe(trigger);
      expect(trigger.textContent).toMatch(/^Working/);
      expect(r.container.textContent).toContain("Approval was needed.");
      expect(r.container.textContent).not.toContain("waiting on you");
      expect(r.container.textContent).not.toContain("the turn is paused");
      expect(topLevelMessages(r.container)).toEqual(["Continuing the approved work."]);
      expect(r.container.querySelectorAll("[data-og-exchange-status]")).toHaveLength(1);
    } finally {
      await r.unmount();
    }
  });

  test("completed standalone compaction remains visible without an eternal Working header", async () => {
    sequence = 0;
    const r = await renderComponent(
      <MessageTimeline
        events={[
          event("turn.started", {}, "maintenance"),
          event("session.context.compaction.started", { trigger: "operator" }, "maintenance"),
          event("session.context.compacted", { trigger: "operator" }, "maintenance"),
          event("turn.completed", { maintenance: "context_compaction" }, "maintenance"),
          event("session.status.changed", { status: "idle" }, "maintenance"),
        ]}
        turnSummary={{ rolling: true }}
      />,
    );
    try {
      await flush();
      expect(r.container.querySelector("[data-og-exchange-status]")).toBeNull();
      expect(r.container.textContent).toContain("Conversation history compacted");
      expect(r.container.querySelector("[data-og-fold-content]")).toBeNull();
    } finally {
      await r.unmount();
    }
  });

  test("Working continues through final streaming and trailing work, then settles to the full duration", async () => {
    sequence = 0;
    const working = [
      event("turn.started", {}),
      ...tool("read", "exec_command"),
      ...tool("query", "exec_command"),
      event("agent.message.delta", { text: "Answer", messageId: "a", phase: "final_answer" }),
    ];
    const r = await renderComponent(
      <MessageTimeline events={working} turnSummary={{ rolling: true }} />,
    );
    try {
      await flush();
      expect(statusTrigger(r.container).textContent).toStartWith("Working");
      const trailing = [...working, ...tool("verify-after-answer", "exec_command")];
      await r.rerender(<MessageTimeline events={trailing} turnSummary={{ rolling: true }} />);
      await flush();
      expect(statusTrigger(r.container).textContent).toStartWith("Working");
      await r.rerender(
        <MessageTimeline
          events={[
            ...trailing,
            event("agent.message.completed", { text: "Answer", phase: "final_answer" }),
            event("turn.completed", {}),
          ]}
          turnSummary={{ rolling: true }}
        />,
      );
      await flush();
      expect(r.container.querySelector("[data-og-exchange-status]")?.textContent).toBe(
        "Worked for 40s",
      );
    } finally {
      await r.unmount();
    }
  });

  test("recorded answer, including its image and approval question, survives a machine turn", async () => {
    const events = recordedAnswerExchange as SessionEvent[];
    const r = await renderComponent(
      <MessageTimeline events={events} turnSummary={{ rolling: true }} />,
    );
    try {
      await flush();
      expect(
        topLevelMessages(r.container).some((text) =>
          text.includes("Do you approve this four-at-a-time layout?"),
        ),
      ).toBe(true);
      expect(r.container.querySelectorAll("[data-og-exchange-status]").length).toBeGreaterThan(1);
    } finally {
      await r.unmount();
    }
  });

  test("classic grouping remains available without rolling presentation", async () => {
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
