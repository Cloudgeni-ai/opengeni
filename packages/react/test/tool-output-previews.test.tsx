import { describe, expect, test } from "bun:test";
import {
  SESSION_EVENT_STEP_TYPES,
  type SessionEvent,
  type SessionEventListOptions,
} from "@opengeni/sdk";
import { actRun, flush, registerDom, renderComponent, renderHook } from "./render-hook";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { useSessionEvents } from "../src/hooks/use-session-events";
import { toolOutputPreviewFact } from "../src/hooks/tool-output-reads";
import type { ToolCallItem, ToolOutputPreview, TimelineItem, TurnStepsItem } from "../src/timeline";
import { presentsToolOutputPreview } from "../src/timeline/tool-presentation";

/* ----------------------------------------------------------------------------
   Tool outputs in a turn's steps arrive as bounded previews. A row reads its
   exact output once, when the reader expands it or its renderer needs it, and
   never shows a preview's body as if it were the whole output.
   -------------------------------------------------------------------------- */

registerDom();

const { ActivityRail, createDefaultToolRegistry } = await import("../src/timeline");

const STEP_TYPES = new Set<string>(SESSION_EVENT_STEP_TYPES);
const LONG_OUTPUT = Array.from(
  { length: 2000 },
  (_, index) => `line ${index}: ${"x".repeat(20)}`,
).join("\n");
const PUBLISH_RECEIPT = JSON.stringify({
  artifactId: "a".repeat(32),
  filename: "report.txt",
  contentType: "text/plain",
  padding: "p".repeat(6000),
});

function at(sequence: number, type: SessionEvent["type"], payload: unknown, turnId: string | null) {
  return {
    id: `evt-${sequence}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type,
    payload,
    occurredAt: new Date(1_750_000_000_000 + sequence * 1000).toISOString(),
    clientEventId: null,
    turnId,
  } satisfies SessionEvent;
}

/** The server's preview: the head and tail of a long output, with its fact. */
function serverPreview(event: SessionEvent): SessionEvent {
  if (event.type !== "agent.toolCall.output") return event;
  const payload = event.payload as Record<string, unknown>;
  const bytes = JSON.stringify(payload).length;
  if (bytes <= 4096 || typeof payload.output !== "string") return event;
  const text = payload.output;
  const output = `${text.slice(0, 1024)}\n…[${text.length - 1536} characters omitted from this preview]…\n${text.slice(-512)}`;
  return {
    ...event,
    payload: {
      ...payload,
      output,
      outputPreview: {
        truncated: true,
        reason: "tool_output_preview",
        shape: "structured",
        originalBytes: bytes,
        previewBytes: output.length,
      },
    },
  };
}

/** A turn with a long exec output and a long published-file receipt. */
function store(): SessionEvent[] {
  return [
    at(1, "user.message", { text: "go", routing: "accepted_for_execution" }, null),
    at(2, "turn.started", { turnId: "T1" }, "T1"),
    at(
      3,
      "agent.toolCall.created",
      { id: "call-exec", name: "exec_command", arguments: { cmd: "seq" } },
      "T1",
    ),
    at(4, "agent.toolCall.output", { id: "call-exec", output: LONG_OUTPUT }, "T1"),
    at(
      5,
      "agent.toolCall.created",
      { id: "call-publish", name: "sandbox_file_publish", arguments: { path: "report.txt" } },
      "T1",
    ),
    at(6, "agent.toolCall.output", { id: "call-publish", output: PUBLISH_RECEIPT }, "T1"),
    at(7, "agent.message.completed", { text: "done" }, "T1"),
    at(8, "turn.completed", { turnId: "T1" }, "T1"),
  ];
}

/** Filters like the server, and previews outputs only when asked to. */
function previewClient(events: readonly SessionEvent[], fail?: () => boolean) {
  const reads: SessionEventListOptions[] = [];
  const read = (options: SessionEventListOptions) => {
    const after = options.after ?? 0;
    const before = options.before ?? Number.MAX_SAFE_INTEGER;
    const include = options.includeTypes ? new Set<string>(options.includeTypes) : null;
    const exclude = new Set<string>(options.excludeTypes ?? []);
    const rows = events.filter((event) => {
      if (event.sequence <= after || event.sequence >= before) return false;
      if (include && !include.has(event.type)) return false;
      if (!exclude.has(event.type)) return true;
      const name = (event.payload as { name?: unknown }).name;
      return (
        options.presentedToolCalls === "include" &&
        event.type === "agent.toolCall.created" &&
        name === "sandbox_file_publish"
      );
    });
    const limit = options.limit ?? 500;
    const page = options.direction === "before" ? rows.slice(-limit) : rows.slice(0, limit);
    return {
      events: options.toolOutputs === "preview" ? page.map(serverPreview) : page,
      hasMore: rows.length > page.length,
    };
  };
  const client = fakeClient({
    getSession: async () => ({ lastSequence: 8, activeTurnId: null }) as never,
    listEvents: async (_workspaceId, _sessionId, options = {}) => {
      reads.push(options);
      return read(options).events;
    },
    ...{
      listEventPage: async (
        _workspaceId: string,
        _sessionId: string,
        options: SessionEventListOptions = {},
      ) => {
        reads.push(options);
        if (options.limit === 1 && fail?.()) throw new Error("offline");
        return read(options) as never;
      },
    },
    streamEvents: (_workspaceId, _sessionId, options = {}) =>
      (async function* () {
        options.onOpen?.();
        // Nothing streams live: the test reads history only.
        for (const event of [] as SessionEvent[]) yield event;
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) return resolve();
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      })(),
  });
  return { client, reads };
}

function toolCall(timeline: readonly TimelineItem[], callId: string): ToolCallItem {
  return timeline.find(
    (item): item is ToolCallItem => item.kind === "tool-call" && item.callId === callId,
  )!;
}

function marker(timeline: readonly TimelineItem[]): TurnStepsItem {
  return timeline.find((item): item is TurnStepsItem => item.kind === "turn-steps")!;
}

async function settle(ms = 30) {
  await flush(ms);
  await flush(ms);
}

describe("tool output previews in a turn's steps", () => {
  test("a step read asks for previews, and loading a row reads its exact output once", async () => {
    const { client, reads } = previewClient(store());
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await settle();
      reads.length = 0;
      await actRun(() => marker(hook.result.current.timeline).load());
      await settle();
      expect(reads).toHaveLength(1);
      expect(reads[0]).toMatchObject({
        includeTypes: [...SESSION_EVENT_STEP_TYPES],
        payloadMode: "full",
        toolOutputs: "preview",
      });

      let exec = toolCall(hook.result.current.timeline, "call-exec");
      expect(exec.outputPreview).toMatchObject({ shape: "structured", state: "preview" });
      expect(typeof exec.outputPreview?.load).toBe("function");
      expect(String(exec.output)).toContain("characters omitted from this preview");
      // Annotations anchor in exact text only.
      expect(exec.annotationSource).toBeUndefined();

      reads.length = 0;
      const load = exec.outputPreview!.load!;
      await actRun(() => {
        load();
        load();
      });
      await settle();
      // One exact read of that one output event.
      expect(reads).toEqual([
        {
          includeTypes: ["agent.toolCall.output"],
          after: 3,
          before: 5,
          direction: "after",
          limit: 1,
          payloadMode: "full",
        },
      ]);
      exec = toolCall(hook.result.current.timeline, "call-exec");
      expect(exec.outputPreview ?? null).toBeNull();
      expect(exec.output).toBe(LONG_OUTPUT);
      expect(exec.annotationSource).toMatchObject({ kind: "tool_output", eventId: "evt-4" });

      // Asking again, even through the old loader, reads nothing.
      await actRun(() => load());
      await settle();
      expect(reads).toHaveLength(1);
      const events = hook.result.current.events.filter((event) => STEP_TYPES.has(event.type));
      expect(events.filter((event) => event.id === "evt-4")).toHaveLength(1);
    } finally {
      await hook.unmount();
    }
  });

  test("a presented result stays exact when the step page holds its preview", async () => {
    const { client, reads } = previewClient(store());
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await settle();
      // The presented result is read whole, without previews.
      const presented = reads.find(
        (options) =>
          options.includeTypes?.length === 1 && options.includeTypes[0] === "agent.toolCall.output",
      );
      expect(presented).toBeDefined();
      expect(presented?.toolOutputs).toBeUndefined();
      await actRun(() => marker(hook.result.current.timeline).load());
      await settle();
      const publish = toolCall(hook.result.current.timeline, "call-publish");
      expect(publish.outputPreview ?? null).toBeNull();
      expect(publish.output).toBe(PUBLISH_RECEIPT);
      const outputs = hook.result.current.events.filter((event) => event.id === "evt-6");
      expect(outputs).toHaveLength(1);
      expect(toolOutputPreviewFact(outputs[0]!.payload)).toBeNull();
    } finally {
      await hook.unmount();
    }
  });

  test("a failed exact read is an error the row can retry", async () => {
    let failing = true;
    const { client, reads } = previewClient(store(), () => failing);
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await settle();
      await actRun(() => marker(hook.result.current.timeline).load());
      await settle();
      await actRun(() =>
        toolCall(hook.result.current.timeline, "call-exec").outputPreview!.load!(),
      );
      await settle();
      let exec = toolCall(hook.result.current.timeline, "call-exec");
      expect(exec.outputPreview?.state).toBe("error");
      failing = false;
      reads.length = 0;
      await actRun(() => exec.outputPreview!.load!());
      await settle();
      expect(reads).toHaveLength(1);
      exec = toolCall(hook.result.current.timeline, "call-exec");
      expect(exec.outputPreview ?? null).toBeNull();
      expect(exec.output).toBe(LONG_OUTPUT);
    } finally {
      await hook.unmount();
    }
  });
});

/* ---- renderers ------------------------------------------------------------- */

function previewItem(
  overrides: Partial<ToolCallItem>,
  preview: Partial<ToolOutputPreview> = {},
): { item: ToolCallItem; loads: () => number } {
  let count = 0;
  const item = {
    kind: "tool-call",
    id: "tool-1",
    callId: "call-1",
    name: "exec_command",
    status: "complete",
    arguments: { cmd: "seq 1 2000" },
    output: `${LONG_OUTPUT.slice(0, 1024)}\n…[40000 characters omitted from this preview]…\n${LONG_OUTPUT.slice(-512)}`,
    ...overrides,
    outputPreview: {
      shape: "structured",
      originalBytes: 52_000,
      previewBytes: 1_700,
      state: "preview",
      load: () => {
        count += 1;
      },
      ...preview,
    },
  } as ToolCallItem;
  return { item, loads: () => count };
}

function rowButton(container: HTMLElement): HTMLElement {
  return container.querySelector('[role="button"][aria-expanded]') as HTMLElement;
}

describe("tool rows with an output preview", () => {
  test("expanding a command row loads the full output once and waits for it", async () => {
    const { item, loads } = previewItem({});
    const r = await renderComponent(<ActivityRail items={[item]} bare />);
    try {
      await flush();
      // Collapsed: the row reads from the preview, nothing is fetched.
      expect(loads()).toBe(0);
      expect(r.container.querySelector("[data-og-tool-output-loading]")).toBeNull();
      await actRun(() => rowButton(r.container).click());
      await flush();
      expect(loads()).toBe(1);
      // The preview's body is never shown as the whole output.
      expect(r.container.textContent).toContain("Loading the full output…");
      expect(r.container.textContent).not.toContain("omitted from this preview");

      // The read is in flight: closing and reopening asks nothing more.
      const loading = { ...item, outputPreview: { ...item.outputPreview!, state: "loading" } };
      await r.rerender(<ActivityRail items={[loading as ToolCallItem]} bare />);
      await actRun(() => rowButton(r.container).click());
      await actRun(() => rowButton(r.container).click());
      await flush();
      expect(loads()).toBe(1);
      expect(r.container.textContent).toContain("Loading the full output…");

      // The exact output lands: the open body shows it.
      const exact = { ...item, output: LONG_OUTPUT, outputPreview: null } as ToolCallItem;
      await r.rerender(<ActivityRail items={[exact]} bare />);
      await flush();
      expect(r.container.textContent).not.toContain("Loading the full output…");
      expect(r.container.textContent).toContain("line 1999");
      expect(loads()).toBe(1);
    } finally {
      await r.unmount();
    }
  });

  test("a failed read says the body is a preview and retries on request", async () => {
    const { item, loads } = previewItem({}, { state: "error" });
    const r = await renderComponent(<ActivityRail items={[item]} bare />);
    try {
      await actRun(() => rowButton(r.container).click());
      await flush();
      // No automatic retry loop.
      expect(loads()).toBe(0);
      const notice = r.container.querySelector("[data-og-tool-output-preview]");
      expect(notice?.textContent).toContain("Showing a preview. The full output didn't load.");
      await actRun(() => (notice!.querySelector("button") as HTMLButtonElement).click());
      expect(loads()).toBe(1);
    } finally {
      await r.unmount();
    }
  });

  test("renderers that need the exact output load it before rendering", async () => {
    const cases: Partial<ToolCallItem>[] = [
      // Screenshots and other media.
      {
        name: "computer",
        raw: { type: "computer_call" },
        arguments: { action: { type: "screenshot" } },
      },
      { name: "view_image", arguments: { path: "/tmp/shot.png" } },
      // Receipts and cards that parse their result.
      { name: "knowledge_save", arguments: { title: "Note" } },
      { name: "web_search_call", arguments: { query: "opengeni" } },
      { name: "tool_search", arguments: { query: "files" } },
      // A generic result that is a JSON document: a cut one would not parse.
      { name: "mcp__issues__list", output: '{"issues": [{"id": 1, "title": "…' },
    ];
    for (const overrides of cases) {
      const { item, loads } = previewItem(overrides);
      const r = await renderComponent(<ActivityRail items={[item]} bare />);
      try {
        await flush();
        expect([overrides.name, loads()]).toEqual([overrides.name, 1]);
        expect(r.container.querySelector("[data-og-tool-output-loading]")).not.toBeNull();
        expect(r.container.textContent).toContain("Loading output…");
        expect(r.container.textContent).not.toContain("omitted from this preview");
      } finally {
        await r.unmount();
      }
    }
  });

  test("only command, patch and plain generic presentations read from a preview", () => {
    expect(presentsToolOutputPreview(previewItem({}).item)).toBe(true);
    expect(presentsToolOutputPreview(previewItem({ name: "mcp__issues__list" }).item)).toBe(true);
    expect(presentsToolOutputPreview(previewItem({ name: "web_search_call" }).item)).toBe(false);
    expect(
      presentsToolOutputPreview(
        previewItem({ name: "mcp__issues__list", output: '[{"id": 1' }).item,
      ),
    ).toBe(false);
    // A preview's retained screenshots draw from the exact result.
    expect(
      presentsToolOutputPreview(
        previewItem({
          name: "mcp__browser__shot",
          output: {
            content: [
              {
                artifactId: "b".repeat(32),
                available: true,
                kind: "browser_screenshot",
                contentType: "image/png",
                originalBytes: 120_000,
                sha256: "c".repeat(64),
                dimensions: { width: 1280, height: 800 },
                retention: { policy: "session_screenshot" },
              },
            ],
          },
        }).item,
      ),
    ).toBe(false);
  });

  test("a text-shaped preview of a command loads before rendering", async () => {
    const { item, loads } = previewItem({}, { shape: "text" });
    expect(presentsToolOutputPreview(item)).toBe(false);
    const r = await renderComponent(<ActivityRail items={[item]} bare />);
    try {
      await flush();
      expect(loads()).toBe(1);
      expect(r.container.textContent).toContain("Loading output…");
    } finally {
      await r.unmount();
    }
  });

  test("a consumer renderer gets the exact output, never the preview", async () => {
    const { item, loads } = previewItem({ name: "custom_tool" });
    const seen: unknown[] = [];
    const registry = createDefaultToolRegistry({
      entries: [
        {
          match: "name",
          name: "custom_tool",
          render: ({ item: shown }) => {
            seen.push(shown.output);
            return <div>custom</div>;
          },
        },
      ],
    });
    const r = await renderComponent(<ActivityRail items={[item]} bare toolRegistry={registry} />);
    try {
      await flush();
      expect(loads()).toBe(1);
      expect(seen).toEqual([]);
      const exact = { ...item, output: LONG_OUTPUT, outputPreview: null } as ToolCallItem;
      await r.rerender(<ActivityRail items={[exact]} bare toolRegistry={registry} />);
      await flush();
      expect(seen.at(-1)).toBe(LONG_OUTPUT);
    } finally {
      await r.unmount();
    }
  });

  test("a renderer whose exact read failed falls back to a row that says it is a preview", async () => {
    const { item } = previewItem({ name: "knowledge_save" }, { state: "error" });
    const r = await renderComponent(<ActivityRail items={[item]} bare />);
    try {
      await actRun(() => rowButton(r.container).click());
      await flush();
      expect(r.container.querySelector("[data-og-tool-output-preview]")).not.toBeNull();
    } finally {
      await r.unmount();
    }
  });
});
