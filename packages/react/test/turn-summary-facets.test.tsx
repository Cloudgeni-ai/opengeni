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
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

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

    const active = await renderComponent(<TurnSummary items={[]}>details</TurnSummary>);
    expect(active.container.querySelector(".animate-og-pulse")).not.toBeNull();
    await active.unmount();
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
