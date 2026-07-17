import { describe, expect, test } from "bun:test";
import { streamWorkspaceControlEvents } from "../src/workspace-control-stream";
import type { WorkspaceControlEvent } from "../src/types";

function event(sequence: number): WorkspaceControlEvent {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-000000000002",
    sequence,
    revision: sequence,
    type: "workspace.control.changed",
    scope: "workspace",
    rootSessionId: null,
    action: "pause",
    automatic: false,
    reason: null,
    actor: "operator",
    occurredAt: "2026-07-16T00:00:00.000Z",
  };
}

function streamOf(value: WorkspaceControlEvent): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `id: ${value.sequence}\nevent: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`,
        ),
      );
      controller.close();
    },
  });
}

describe("streamWorkspaceControlEvents", () => {
  test("accepts a sparse post-migration revision and resumes from the supplied cursor", async () => {
    const openedAfter: number[] = [];
    const values: WorkspaceControlEvent[] = [];
    for await (const value of streamWorkspaceControlEvents(
      {
        openStream: async (after) => {
          openedAfter.push(after);
          return streamOf(event(41));
        },
      },
      { after: 27, reconnect: false },
    )) {
      values.push(value);
    }
    expect(openedAfter).toEqual([27]);
    expect(values.map((value) => value.sequence)).toEqual([41]);
  });

  test("does not expose Live or deliver an event before reconciliation settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const states: string[] = [];
    const generator = streamWorkspaceControlEvents(
      { openStream: async () => streamOf(event(2)) },
      {
        reconnect: false,
        beforeLive: async () => await gate,
        onStateChange: (state) => states.push(state),
      },
    );
    const pending = generator.next();
    await Bun.sleep(5);
    expect(states).toEqual(["connecting"]);
    release();
    expect((await pending).value?.sequence).toBe(2);
    expect(states).toEqual(["connecting", "live"]);
  });
});
