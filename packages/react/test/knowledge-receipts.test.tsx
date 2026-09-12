import { describe, expect, test } from "bun:test";
import { act } from "react";
import type { SessionEvent } from "@opengeni/sdk";
import {
  ActivityRail,
  buildTimeline,
  defaultToolRegistry,
  type KnowledgeItem,
  type ToolCallItem,
} from "../src/timeline";
import { KnowledgeActivityProvider } from "../src/timeline/knowledge-receipt";
import { registerDom, renderComponent } from "./render-hook";
registerDom();
const entryId = crypto.randomUUID();
const fileId = crypto.randomUUID();
const receipt = {
  entryId,
  revisionId: crypto.randomUUID(),
  operationId: crypto.randomUUID(),
  version: 1,
  outcome: "pending",
  reviewBatchId: crypto.randomUUID(),
  replayed: false,
};
const event: SessionEvent = {
  id: "event",
  workspaceId: "workspace",
  sessionId: "session",
  turnId: "turn",
  sequence: 1,
  type: "knowledge.source.prepared",
  occurredAt: new Date().toISOString(),
  payload: { status: "retained", fileId, filename: "Acme.pdf", receipt },
};
async function expand(container: HTMLElement) {
  const disclosure = container.querySelector<HTMLElement>('[role="button"][aria-expanded]');
  if (disclosure?.getAttribute("aria-expanded") === "false")
    await act(async () => {
      disclosure.click();
    });
}

describe("nonblocking Knowledge receipts", () => {
  test("pending source is an ordinary activity with a working link to the exact entry", async () => {
    const items = buildTimeline([event]);
    expect(items[0]).toMatchObject({
      kind: "knowledge",
      status: "complete",
      outcome: "pending",
      entryId,
      filename: "Acme.pdf",
    });
    let opened: string | undefined;
    const rendered = await renderComponent(
      <KnowledgeActivityProvider
        onInspect={(id) => {
          opened = id;
        }}
      >
        <ActivityRail items={items as KnowledgeItem[]} />
      </KnowledgeActivityProvider>,
    );
    try {
      expect(rendered.container.textContent).toContain("Knowledge saved for review");
      await expand(rendered.container);
      expect(rendered.container.textContent).toContain("This task continues");
      const button = [...rendered.container.querySelectorAll("button")].find((candidate) =>
        candidate.textContent?.includes("Review in Knowledge"),
      );
      expect(button).toBeDefined();
      await act(async () => {
        button!.click();
      });
      expect(opened).toBe(entryId);
      expect(rendered.container.querySelector("form")).toBeNull();
    } finally {
      await rendered.unmount();
    }
  });
  test("a failed preparation exposes a retry without claiming that text was retained", async () => {
    const items = buildTimeline([
      {
        ...event,
        type: "knowledge.source.failed",
        payload: { status: "failed", fileId, message: "Retry preparation" },
      },
    ]);
    let retried: string | undefined;
    const rendered = await renderComponent(
      <KnowledgeActivityProvider
        onRetryFile={async (id) => {
          retried = id;
          return true;
        }}
      >
        <ActivityRail items={items as KnowledgeItem[]} />
      </KnowledgeActivityProvider>,
    );
    try {
      await expand(rendered.container);
      expect(rendered.container.textContent).toContain("Searchable text has not been retained");
      const button = [...rendered.container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Retry preparation",
      );
      expect(button).toBeDefined();
      await act(async () => {
        button!.click();
      });
      expect(retried).toBe(fileId);
      expect(rendered.container.textContent).toContain("Retry requested");
    } finally {
      await rendered.unmount();
    }
  });
  test("the first-party save receipt uses the same presentation and an unrelated MCP cannot impersonate it", async () => {
    const item: ToolCallItem = {
      kind: "tool-call",
      id: "tool",
      turnId: "turn",
      callId: "call",
      name: "opengeni__knowledge_save",
      arguments: { entry: { title: "Acme renewal" } },
      output: { content: [{ type: "text", text: JSON.stringify(receipt) }] },
      raw: undefined,
      status: "complete",
      occurredAt: event.occurredAt,
    };
    const Renderer = defaultToolRegistry.resolve(item);
    expect(defaultToolRegistry.resolve({ ...item, name: "untrusted__knowledge_save" })).toBe(
      defaultToolRegistry.fallback,
    );
    const rendered = await renderComponent(<Renderer item={item} />);
    try {
      expect(rendered.container.textContent).toContain("Knowledge saved for review");
      expect(rendered.container.textContent).toContain("Acme renewal");
    } finally {
      await rendered.unmount();
    }
  });
});
