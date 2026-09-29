import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { KnowledgeEntryRecord } from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReviewItem, ReviewQueue } from "./knowledge-review";

/* The review flow: one row per change, each change on its own page, and
   Approve and next moving on until the list is done. */

const workspaceId = "00000000-0000-4000-8000-000000000001";
const batchId = "00000000-0000-4000-8000-000000000005";
const createdAt = "2026-09-28T00:00:00.000Z";
const ids = ["00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000012"];

function record(id: string, index: number): KnowledgeEntryRecord {
  const revision = `00000000-0000-4000-8000-00000000002${index}`;
  return {
    id,
    scope: "workspace",
    version: 1,
    publishedRevisionId: null,
    latestRevisionId: revision,
    archived: false,
    createdAt,
    updatedAt: createdAt,
    revision: {
      id: revision,
      entryId: id,
      number: 1,
      previousRevisionId: null,
      restoredFromRevisionId: null,
      createdAt,
      createdBySessionId: null,
      reviewBatchId: batchId,
      outcome: "pending",
      change: "upsert",
      entry: {
        title: `Proposal ${index + 1}`,
        kind: "fact",
        content: `What proposal ${index + 1} says`,
        evidence: [],
        groupIds: [],
        relationships: [],
      },
    },
  };
}

const records = ids.map(record);

function queue(): ReviewQueue {
  const items: ReviewItem[] = records.map((each) => {
    const { entry, ...revision } = each.revision;
    return {
      kind: "knowledge",
      key: `knowledge:${each.id}`,
      title: entry.title,
      createdAt,
      origin: { kind: "chat", name: "Migrate billing", sessionId: "s1" },
      batch: {
        id: batchId,
        sessionId: "s1",
        scheduledTaskId: null,
        scheduledTaskRunId: null,
        title: "Migrate billing",
        scope: "workspace",
        pendingCount: 2,
        createdAt,
      },
      entry: {
        ...each,
        excerpts: [],
        revision: {
          ...revision,
          kind: entry.kind,
          title: entry.title,
          preview: entry.content,
          groupIds: entry.groupIds,
          sourceKind: null,
        },
      },
    };
  });
  return {
    items,
    groups: [{ key: "batch", origin: items[0]!.origin, items }],
    count: items.length,
    partial: false,
    loading: false,
    error: null,
    reload() {},
  };
}

const decisions: { entryId: string; decision: string; content?: string }[] = [];
const client = {
  async getKnowledgeEntry(_workspace: string, id: string) {
    return records.find((each) => each.id === id)!;
  },
  async reviewKnowledgeEntry(
    _workspace: string,
    request: { entryId: string; decision: string; entry?: { content: string } },
  ) {
    decisions.push({
      entryId: request.entryId,
      decision: request.decision,
      ...(request.entry ? { content: request.entry.content } : {}),
    });
    return {};
  },
};
mock.module("@/context", () => ({ useAppContext: () => ({ client }) }));
const { ReviewTab } = await import("./knowledge-review");

beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

async function settle() {
  for (let index = 0; index < 3; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function button(container: HTMLElement, label: string) {
  return [...container.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === label,
  );
}

test("approve and next, edit before approving, and reject walk the list to its end", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const value = queue();
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <ReviewTab
          workspaceId={workspaceId}
          queue={value}
          emptyDescription="Changes wait here."
          onOpenEntry={() => {}}
          onChanged={() => {}}
        />
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  try {
    await act(async () => {
      await router.load();
      root.render(<RouterProvider router={router} />);
    });
    await settle();
    // A flat list: one row per change, its type and where it came from.
    const rows = [...container.querySelectorAll("[data-slot=list-row]")];
    expect(rows.map((row) => row.querySelector("[data-row-action]")?.textContent)).toEqual([
      "Proposal 1",
      "Proposal 2",
    ]);
    expect(rows[0]!.textContent).toContain("Fact");
    expect(rows[0]!.textContent).toContain("From chat Migrate billing");

    await act(async () =>
      container.querySelector<HTMLElement>("[data-slot=list-row] [data-row-action]")!.click(),
    );
    await settle();
    expect(container.querySelector("h1")?.textContent).toBe("Proposal 1");
    expect(container.textContent).toContain("What proposal 1 says");
    // More than one change waits, so approving moves on.
    expect(button(container, "Approve and next")).toBeDefined();
    // Approve all from the same chat lives in the ⋯ menu, not beside the actions.
    expect(button(container, "Approve all 2 from this chat")).toBeUndefined();

    // Edit first: the form replaces the text; the header actions step aside.
    await act(async () => button(container, "Edit")!.click());
    await settle();
    expect(button(container, "Approve and next")).toBeUndefined();
    const content = container.querySelector("textarea")!;
    await act(async () => {
      content.value = "Edited before approving";
      // happy-dom doesn't drive React's change tracking; call the handler as React would.
      const propsKey = Object.keys(content).find((key) => key.startsWith("__reactProps$"))!;
      (content as unknown as Record<string, { onChange: (event: { target: unknown }) => void }>)[
        propsKey
      ]!.onChange({ target: content });
    });
    await act(async () => button(container, "Save and approve")!.click());
    await settle();
    expect(decisions.at(-1)).toEqual({
      entryId: ids[0]!,
      decision: "approve",
      content: "Edited before approving",
    });

    // The next change opens by itself; it is the last, so the button says Approve.
    expect(container.querySelector("h1")?.textContent).toBe("Proposal 2");
    expect(button(container, "Approve")).toBeDefined();
    await act(async () => button(container, "Reject")!.click());
    await settle();
    expect(decisions.at(-1)).toEqual({ entryId: ids[1]!, decision: "reject" });

    // Done: back on the list, which says so.
    expect(container.textContent).toContain("You're all caught up");
    expect(container.querySelectorAll("[data-slot=list-row]")).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
