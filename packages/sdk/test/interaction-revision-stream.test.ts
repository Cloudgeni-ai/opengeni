import { describe, expect, test } from "bun:test";
import type { WorkspaceInteractionRevisionEvent } from "../src/interaction";
import { streamWorkspaceInteractionRevisions } from "../src/interaction-revision-stream";
import { OpenGeniClient } from "../src/client";

function event(sequence: number): WorkspaceInteractionRevisionEvent {
  return {
    workspaceId: "00000000-0000-4000-8000-000000000002",
    sequence,
    revision: sequence,
    type: "workspace.interaction.changed",
    occurredAt: "2026-08-10T00:00:00.000Z",
  };
}

function streamOf(...values: WorkspaceInteractionRevisionEvent[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const value of values) {
        controller.enqueue(
          new TextEncoder().encode(
            `id: ${value.sequence}\nevent: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`,
          ),
        );
      }
      controller.close();
    },
  });
}

describe("streamWorkspaceInteractionRevisions", () => {
  test("the SDK opens the canonical workspace stream with its resume cursor", async () => {
    const requests: Request[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      apiKey: "test-key",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return new Response(streamOf(event(12)), {
          headers: {
            "Content-Type": "text/event-stream",
            "X-OpenGeni-Api-Contract": request.headers.get("X-OpenGeni-Api-Contract") ?? "",
          },
        });
      },
    });
    const values: number[] = [];
    for await (const value of client.streamWorkspaceInteractionRevisions(
      "00000000-0000-4000-8000-000000000002",
      { after: 9, reconnect: false },
    )) {
      values.push(value.sequence);
    }
    expect(values).toEqual([12]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      "https://api.example.test/v1/workspaces/00000000-0000-4000-8000-000000000002/interaction-events/stream?after=9",
    );
    expect(requests[0]!.headers.get("accept")).toBe("text/event-stream");
  });

  test("accepts sparse latest-wins revisions and resumes from the latest cursor", async () => {
    const openedAfter: number[] = [];
    const values: WorkspaceInteractionRevisionEvent[] = [];
    for await (const value of streamWorkspaceInteractionRevisions(
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

  test("drops malformed and already-seen revision frames", async () => {
    const good = event(9);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ ...good, sequence: 8 })}\n\n` +
              `data: ${JSON.stringify(event(7))}\n\n` +
              `data: ${JSON.stringify(good)}\n\n`,
          ),
        );
        controller.close();
      },
    });
    const values: number[] = [];
    for await (const value of streamWorkspaceInteractionRevisions(
      { openStream: async () => body },
      { after: 7, reconnect: false },
    )) {
      values.push(value.sequence);
    }
    expect(values).toEqual([9]);
  });
});
