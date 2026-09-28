import { describe, expect, test } from "bun:test";
import {
  MessageTimeline,
  TurnSummary,
  type TimelineItem,
  type ToolCallItem,
  type TurnSummaryFacet,
  type TurnSummaryFacetConfiguration,
} from "../src";
import type { MemoryItem } from "../src/timeline";
import { formatElapsed } from "../src/timeline/turn-summary";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

test("only the expanded outer work header is sticky; nested folds remain in flow", async () => {
  const view = await renderComponent(
    <TurnSummary items={[]} defaultOpen>
      <TurnSummary items={[]} defaultOpen bare>
        <p>Nested detail</p>
      </TurnSummary>
    </TurnSummary>,
  );
  try {
    const outer = view.container.querySelector('[data-og-work-header="outer"]')!;
    const nested = view.container.querySelector('[data-og-work-header="nested"]')!;
    expect(outer.classList.contains("sticky")).toBe(true);
    expect(nested.classList.contains("sticky")).toBe(false);
    expect(view.container.querySelectorAll("[data-og-work-section]")).toHaveLength(1);
    expect(outer.parentElement).toBe(view.container.querySelector("[data-og-work-section]"));
  } finally {
    await view.unmount();
  }
});

function toolCall(
  id: string,
  name: string,
  status: ToolCallItem["status"] = "complete",
): ToolCallItem {
  return {
    kind: "tool-call",
    id,
    turnId: "turn-1",
    callId: `call-${id}`,
    name,
    arguments: { id },
    output: { id, status },
    raw: undefined,
    status,
    occurredAt: new Date(Number(id) * 1000).toISOString(),
  };
}

function memory(id: string): MemoryItem {
  return {
    kind: "memory",
    id,
    turnId: "turn-1",
    variant: "saved",
    memoryKind: "semantic",
    preview: "A durable fact",
    memoryId: `memory-${id}`,
    occurredAt: new Date(Number(id) * 1000).toISOString(),
  };
}

function summaryText(container: HTMLElement): string {
  const value = container.querySelector("button .min-w-0");
  return value?.textContent ?? "";
}

function customFacet(id: string, content: string, ariaLabel?: string): TurnSummaryFacet {
  return {
    id,
    summarize: () => (ariaLabel ? { content, ariaLabel } : { content }),
  };
}

describe("TurnSummary facets", () => {
  test("keeps successful summaries quiet while preserving exceptional state indicators", async () => {
    const successful = await renderComponent(
      <TurnSummary items={[]} outcome="complete">
        details
      </TurnSummary>,
    );
    expect(successful.container.querySelector("svg.lucide-check")).toBeNull();
    expect(successful.container.querySelectorAll("svg")).toHaveLength(1);
    await successful.unmount();

    const failed = await renderComponent(
      <TurnSummary items={[]} outcome="failed">
        details
      </TurnSummary>,
    );
    expect(failed.container.querySelector("svg.lucide-triangle-alert")).not.toBeNull();
    await failed.unmount();

    const cancelled = await renderComponent(
      <TurnSummary items={[]} outcome="cancelled">
        details
      </TurnSummary>,
    );
    expect(cancelled.container.querySelector("svg.lucide-circle-slash")).not.toBeNull();
    await cancelled.unmount();

    const active = await renderComponent(
      <TurnSummary items={[toolCall("1", "exec_command", "running")]}>details</TurnSummary>,
    );
    expect(active.container.querySelector(".animate-og-pulse")).not.toBeNull();
    await active.unmount();

    const settled = await renderComponent(
      <TurnSummary items={[toolCall("1", "exec_command")]}>details</TurnSummary>,
    );
    expect(settled.container.querySelector(".animate-og-pulse")).toBeNull();
    expect(summaryText(settled.container)).toContain("1 step");
    await settled.unmount();
  });

  test("omitted configuration preserves the exact built-in summary", async () => {
    const items = [toolCall("1", "exec_command"), memory("2")];
    const rendered = await renderComponent(
      <TurnSummary items={items} outcome="complete" durationMs={5_000}>
        details
      </TurnSummary>,
    );

    expect(summaryText(rendered.container)).toBe("2 steps · 1 command · 1 memory saved · 5s");
    await rendered.unmount();
  });

  test("add appends custom facets without changing defaults", async () => {
    const rendered = await renderComponent(
      <TurnSummary
        items={[toolCall("1", "exec_command")]}
        outcome="complete"
        facets={{ add: [customFacet("records", "2 records")] }}
      >
        details
      </TurnSummary>,
    );

    expect(summaryText(rendered.container)).toBe("1 step · 1 command · 2 records");
    await rendered.unmount();
  });

  test("remove omits only the selected built-in facet", async () => {
    const rendered = await renderComponent(
      <TurnSummary
        items={[toolCall("1", "exec_command"), memory("2")]}
        outcome="complete"
        facets={{ remove: ["memories"] }}
      >
        details
      </TurnSummary>,
    );

    expect(summaryText(rendered.container)).toBe("2 steps · 1 command");
    await rendered.unmount();
  });

  test("replace renders only custom facets in supplied order", async () => {
    const rendered = await renderComponent(
      <TurnSummary
        items={[toolCall("1", "exec_command")]}
        outcome="complete"
        facets={{
          replace: [customFacet("records", "3 records"), customFacet("tasks", "1 task")],
        }}
      >
        details
      </TurnSummary>,
    );

    expect(summaryText(rendered.container)).toBe("3 records · 1 task");
    await rendered.unmount();
  });

  test("null, empty, duplicate, and throwing facets are isolated", async () => {
    const rendered = await renderComponent(
      <TurnSummary
        items={[toolCall("1", "exec_command")]}
        outcome="complete"
        facets={{
          replace: [
            { id: "null", summarize: () => null },
            { id: "empty", summarize: () => ({ content: "" }) },
            customFacet("kept", "kept"),
            customFacet("kept", "duplicate"),
            {
              id: "broken",
              summarize: () => {
                throw new Error("host facet failed");
              },
            },
          ],
        }}
      >
        details
      </TurnSummary>,
    );

    expect(summaryText(rendered.container)).toBe("kept");
    await rendered.unmount();
  });

  test("a facet aggregates normalized tool calls and sees incomplete state", async () => {
    let observedStatuses: ToolCallItem["status"][] = [];
    const aggregate: TurnSummaryFacet = {
      id: "aggregate",
      summarize: (context) => {
        observedStatuses = context.toolCalls.map((call) => call.status);
        return {
          content: `${context.toolCalls.length} calls, ${context.settled ? "settled" : "working"}`,
        };
      },
    };
    const rendered = await renderComponent(
      <TurnSummary
        items={[toolCall("1", "tasks.create"), toolCall("2", "records.update", "running")]}
        facets={{ replace: [aggregate] }}
      >
        details
      </TurnSummary>,
    );

    expect(observedStatuses).toEqual(["complete", "running"]);
    expect(summaryText(rendered.container)).toBe("2 calls, working");
    await rendered.unmount();
  });

  test("accessible labels and titles are applied to the facet", async () => {
    const rendered = await renderComponent(
      <TurnSummary
        items={[]}
        outcome="complete"
        facets={{
          replace: [
            {
              id: "records",
              summarize: () => ({
                content: "2 records",
                ariaLabel: "Two records updated",
                title: "Updated records",
              }),
            },
          ],
        }}
      >
        details
      </TurnSummary>,
    );

    const facet = rendered.container.querySelector('[aria-label="Two records updated"]');
    expect(facet?.getAttribute("title")).toBe("Updated records");
    await rendered.unmount();
  });

  test("MessageTimeline forwards one configuration to its collapsed turns", async () => {
    const items: TimelineItem[] = [
      toolCall("1", "exec_command"),
      {
        kind: "turn-end",
        id: "end-1",
        turnId: "turn-1",
        outcome: "complete",
        failureText: null,
        occurredAt: new Date(1_500).toISOString(),
      },
    ];
    const rendered = await renderComponent(
      <MessageTimeline items={items} turnSummary={{ facets: { remove: ["commands"] } }} />,
    );
    await flush();

    expect(summaryText(rendered.container)).toBe("1 step");
    await rendered.unmount();
  });
});

describe("TurnSummary status line", () => {
  test("formats elapsed wall time with seconds below an hour", () => {
    expect(formatElapsed(900)).toBe("0s");
    expect(formatElapsed(14_000)).toBe("14s");
    expect(formatElapsed(120_000)).toBe("2m");
    expect(formatElapsed(134_000)).toBe("2m 14s");
    expect(formatElapsed(3_900_000)).toBe("1h 05m");
  });

  test("a settled exchange states its span once and reads as a separator", async () => {
    const r = await renderComponent(
      <TurnSummary
        items={[toolCall("1", "exec_command"), toolCall("2", "exec_command")]}
        outcome="complete"
        durationMs={250_000}
        status={{ kind: "worked", durationMs: 250_000 }}
      >
        details
      </TurnSummary>,
    );
    expect(summaryText(r.container)).toBe("Worked for 4m 10s · 2 steps · 2 commands");
    expect(r.container.querySelector("button .h-px")).not.toBeNull();
    await r.unmount();
  });

  test("a sub-second settled span shows only the facets", async () => {
    const r = await renderComponent(
      <TurnSummary
        items={[toolCall("1", "exec_command")]}
        outcome="complete"
        status={{ kind: "worked", durationMs: 400 }}
      >
        details
      </TurnSummary>,
    );
    expect(summaryText(r.container)).toBe("1 step · 1 command");
    await r.unmount();
  });

  test("live work keeps one short line and previews only its current step", async () => {
    const r = await renderComponent(
      <TurnSummary
        items={[toolCall("1", "exec_command"), toolCall("2", "exec_command", "running")]}
        status={{
          kind: "working",
          since: new Date(Date.now() - 134_000).toISOString(),
          preview: <span>Checking the second file.</span>,
        }}
      >
        details
      </TurnSummary>,
    );
    expect(summaryText(r.container)).toMatch(/^Working · 2m 1[3-5]s · 2 steps$/);
    expect(r.container.querySelector("[data-og-exchange-preview]")?.textContent).toBe(
      "Checking the second file.",
    );
    expect(r.container.querySelector("[data-og-exchange-note]")).toBeNull();
    await r.unmount();
  });
});

const validModification: TurnSummaryFacetConfiguration = {
  add: [customFacet("records", "records")],
  remove: ["memories"],
};
const validReplacement: TurnSummaryFacetConfiguration = {
  replace: [customFacet("records", "records")],
};
// @ts-expect-error replacement is deliberately mutually exclusive with modification.
const invalidMixedConfiguration: TurnSummaryFacetConfiguration = {
  replace: [customFacet("records", "records")],
  add: [customFacet("tasks", "tasks")],
};
void validModification;
void validReplacement;
void invalidMixedConfiguration;
