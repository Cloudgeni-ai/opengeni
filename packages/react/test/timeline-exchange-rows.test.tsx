import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { act } from "react";
import { MessageTimeline } from "../src";
import recordedAnswerExchange from "./fixtures/exchange-answer-before-machine-turns.json";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

test("the legacy global resolver cannot create navigation without a mounted prompt", async () => {
  let calls = 0;
  const view = await renderComponent(
    <MessageTimeline
      events={[]}
      turnSummary={{ rolling: true }}
      hasNewer
      onJumpToLatestQuestion={async () => {
        calls++;
        return 1;
      }}
    />,
  );
  try {
    await flush(50);
    const button = view.container.querySelector<HTMLButtonElement>("[data-og-jump-to-question]");
    expect(button).toBeNull();
    expect(calls).toBe(0);
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
      // One live waiting status: the header, not also a "waiting on you" divider.
      expect(r.container.textContent).not.toContain("waiting on you");
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
      expect(r.container.textContent).toContain("You responded to this approval.");
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

describe("capacity limit rows", () => {
  // The Oct 10 incident shape: a turn queued, started, then parked on Codex
  // capacity for hours before it resumed and answered.
  const OLD_COPY =
    "No Codex subscription has capacity for this turn right now. It continues automatically when an account is available.";
  const T0 = Date.now() - 5 * 3600_000;
  const at = (
    seconds: number,
    type: string,
    payload: unknown,
    turnId: string | null = "turn-1",
  ) => {
    sequence += 1;
    return {
      ...event(type, payload, turnId),
      occurredAt: new Date(T0 + seconds * 1000).toISOString(),
    } satisfies SessionEvent;
  };
  function blocked(
    options: {
      work?: boolean;
      startupRunning?: boolean;
      wait?: { type: string; payload: Record<string, unknown> };
    } = {},
  ): SessionEvent[] {
    sequence = 0;
    const wait = options.wait ?? {
      type: "codex.capacity.waiting",
      payload: {
        code: "subscription_capacity_unavailable",
        waitReason: "no_eligible_capacity",
        error: OLD_COPY,
      },
    };
    return [
      at(0, "user.message", { text: "Cool thanks" }, null),
      at(0, "turn.queued", { turnId: "turn-1" }),
      at(1, "session.status.changed", { status: "running" }),
      at(1, "turn.started", {}),
      ...(options.startupRunning
        ? [at(1, "turn.startup.phase.started", { phase: "model_preparation" })]
        : []),
      ...(options.work
        ? [
            at(1, "agent.toolCall.created", {
              id: "ls",
              name: "exec_command",
              arguments: { cmd: "ls" },
            }),
            at(1, "agent.toolCall.output", { id: "ls", output: "ok" }),
          ]
        : []),
      at(2, wait.type, wait.payload),
      at(2, "session.status.changed", { status: "waiting_capacity" }),
    ];
  }

  const GUIDANCE = "Try again after your quota resets, or switch to another model or provider.";
  const statusRow = (container: HTMLElement) => {
    const status = container.querySelector("[data-og-exchange-status]");
    const header = status?.closest<HTMLElement>("[data-og-work-header]");
    if (!status || !header) throw new Error("expected an exchange status row");
    return { status, header };
  };

  test("a blocked turn says Usage limit reached once, with no clock and no empty disclosure", async () => {
    const r = await renderComponent(
      <MessageTimeline events={blocked()} turnSummary={{ rolling: true }} />,
    );
    try {
      await flush();
      const { status, header } = statusRow(r.container);
      // Five hours parked on a limit: no elapsed time is counted.
      expect(status.textContent).toBe("Usage limit reached");
      expect(header.textContent).toBe("Usage limit reached");
      expect(r.container.querySelector("[data-og-exchange-wait-detail]")?.textContent).toBe(
        GUIDANCE,
      );
      expect(r.container.textContent).not.toMatch(/automatic|continues/i);
      expect(r.container.textContent).not.toContain("No Codex subscription");
      expect(r.container.textContent?.split(/limit reached/i).length).toBe(2);
      expect(r.container.querySelector("[role=status]")).toBeNull();
      // Nothing to reveal: no chevron, no toggle, no fold content.
      expect(header.tagName).not.toBe("BUTTON");
      expect(header.closest("button")).toBeNull();
      expect(header.querySelector(".lucide-chevron-right")).toBeNull();
      expect(r.container.querySelector("[data-og-fold-content]")).toBeNull();
      await act(async () => header.click());
      expect(r.container.querySelector("[data-og-fold-content]")).toBeNull();
      const section = header.closest("[data-og-work-section]");
      expect(section?.querySelector("button, [aria-expanded]")).toBeNull();
    } finally {
      await r.unmount();
    }
  });

  test("a limit during a still-running startup phase offers no empty disclosure", async () => {
    // The row's rail hides running phases, so they are not details to reveal.
    const r = await renderComponent(
      <MessageTimeline
        events={blocked({ startupRunning: true })}
        turnSummary={{ rolling: true }}
      />,
    );
    try {
      await flush();
      const { status, header } = statusRow(r.container);
      expect(status.textContent).toBe("Usage limit reached");
      expect(r.container.querySelector("[data-og-exchange-wait-detail]")?.textContent).toBe(
        GUIDANCE,
      );
      expect(header.closest("button")).toBeNull();
      expect(header.querySelector(".lucide-chevron-right")).toBeNull();
      await act(async () => header.click());
      expect(r.container.querySelector("[data-og-fold-content]")).toBeNull();
      const section = header.closest("[data-og-work-section]");
      expect(section?.querySelector("button, [aria-expanded]")).toBeNull();
    } finally {
      await r.unmount();
    }
  });

  test("a limit after real work keeps its guidance visible when the work is expanded", async () => {
    // Work before the limit: the parked row has real details to reveal.
    const events = blocked({ work: true });
    const r = await renderComponent(
      <MessageTimeline events={events} turnSummary={{ rolling: true }} />,
    );
    try {
      await flush();
      const trigger = statusTrigger(r.container);
      expect(trigger.textContent).toStartWith("Usage limit reached");
      expect(trigger.textContent).not.toMatch(/\d+[smh]\b/);
      expect(trigger.querySelector(".lucide-chevron-right")).not.toBeNull();
      const guidance = () =>
        r.container.querySelector("[data-og-exchange-wait-detail]")?.textContent;
      expect(guidance()).toBe(GUIDANCE);
      await act(async () => trigger.click());
      await flush();
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(r.container.querySelector("[data-og-fold-content]")?.textContent).toContain("ls");
      expect(guidance()).toBe(GUIDANCE);
      expect(trigger.textContent).not.toMatch(/\d+[smh]\b/);
    } finally {
      await r.unmount();
    }
  });

  test("a reconnect wait keeps its actionable reason and is not labelled a limit", async () => {
    const events = blocked({
      wait: {
        type: "turn.capacity_waiting",
        payload: {
          provider: "claude",
          code: "claude_relogin_required",
          error: "The serving Claude account requires reconnection",
          detail: "the same accepted turn is waiting for another eligible account",
        },
      },
    });
    const r = await renderComponent(
      <MessageTimeline events={events} turnSummary={{ rolling: true }} />,
    );
    try {
      await flush();
      const { status } = statusRow(r.container);
      expect(status.textContent).toBe("Waiting");
      expect(r.container.querySelector("[data-og-exchange-wait-detail]")?.textContent).toBe(
        "The serving Claude account requires reconnection",
      );
      expect(r.container.textContent).not.toMatch(/limit reached|quota/i);
    } finally {
      await r.unmount();
    }
  });

  test("approval waits and working rows keep their live clocks", async () => {
    sequence = 0;
    const approval = [
      event("turn.started", {}),
      ...tool("plan", "exec_command"),
      event("session.requiresAction", {}),
      event("session.status.changed", { status: "requires_action" }),
    ];
    const r = await renderComponent(
      <MessageTimeline events={approval} turnSummary={{ rolling: true }} />,
    );
    try {
      await flush();
      expect(statusTrigger(r.container).textContent).toMatch(/^Waiting for you · \d+m/);
      await r.rerender(
        <MessageTimeline
          events={[...approval, event("session.status.changed", { status: "running" })]}
          turnSummary={{ rolling: true }}
        />,
      );
      await flush();
      expect(statusTrigger(r.container).textContent).toMatch(/^Working · \d+m/);
    } finally {
      await r.unmount();
    }
  });

  test("after recovery the warning is gone and worked time excludes the wait", async () => {
    const hours = 4 * 3600;
    const events = [
      ...blocked(),
      at(hours, "codex.capacity.resumed", {}),
      at(hours, "session.status.changed", { status: "recovering" }),
      at(hours + 1, "session.status.changed", { status: "running" }),
      at(hours + 1, "turn.started", {}),
      at(hours + 10, "agent.toolCall.created", { id: "t", name: "exec_command", arguments: {} }),
      at(hours + 20, "agent.toolCall.output", { id: "t", output: "ok" }),
      at(hours + 30, "agent.message.completed", {
        text: "You're welcome!",
        phase: "final_answer",
      }),
      at(hours + 31, "turn.completed", {}),
      at(hours + 31, "session.status.changed", { status: "idle" }),
    ];
    const r = await renderComponent(
      <MessageTimeline events={events} turnSummary={{ rolling: true }} />,
    );
    try {
      await flush();
      expect(r.container.textContent).not.toMatch(/limit reached/i);
      expect(r.container.textContent).not.toContain("No Codex subscription");
      expect(r.container.textContent).toContain("You're welcome!");
      // 4h 00m 31s wall time minus the 3h 59m 58s wait.
      expect(r.container.querySelector("[data-og-exchange-status]")?.textContent).toBe(
        "Worked for 33s",
      );
    } finally {
      await r.unmount();
    }
  });
});
