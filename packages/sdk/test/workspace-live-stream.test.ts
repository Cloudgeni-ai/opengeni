import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";
import type { WorkspaceInteractionRevisionEvent } from "../src/interaction";
import type { WorkspaceControlEvent } from "../src/types";
import { streamWorkspaceLiveEvents, type WorkspaceLiveEvent } from "../src/workspace-live-stream";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";

function control(sequence: number): WorkspaceControlEvent {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    workspaceId: WORKSPACE_ID,
    sequence,
    revision: sequence,
    type: "workspace.control.changed",
    scope: "workspace",
    rootSessionId: null,
    action: "pause",
    automatic: false,
    reason: null,
    actor: "operator",
    occurredAt: "2026-08-13T00:00:00.000Z",
  };
}

function interaction(sequence: number): WorkspaceInteractionRevisionEvent {
  return {
    workspaceId: WORKSPACE_ID,
    sequence,
    revision: sequence,
    type: "workspace.interaction.changed",
    occurredAt: "2026-08-13T00:00:00.000Z",
  };
}

function streamOf(...events: WorkspaceLiveEvent[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          new TextEncoder().encode(
            `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          ),
        );
      }
      controller.close();
    },
  });
}

describe("streamWorkspaceLiveEvents", () => {
  test("the client uses one route with both resume cursors", async () => {
    const requests: Request[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      apiKey: "test-key",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return new Response(streamOf(control(12), interaction(31)), {
          headers: {
            "Content-Type": "text/event-stream",
            "X-OpenGeni-Api-Contract": request.headers.get("X-OpenGeni-Api-Contract") ?? "",
          },
        });
      },
    });
    const values: string[] = [];
    for await (const event of client.streamWorkspaceLiveEvents(WORKSPACE_ID, {
      controlAfter: 9,
      interactionAfter: 27,
      reconnect: false,
    })) {
      values.push(`${event.type}:${event.sequence}`);
    }
    expect(values).toEqual(["workspace.control.changed:12", "workspace.interaction.changed:31"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/live-events/stream?controlAfter=9&interactionAfter=27`,
    );
  });

  test("reconnects with independent cursors and drops a duplicate in only its domain", async () => {
    const opens: Array<[number, number]> = [];
    let attempt = 0;
    const values: string[] = [];
    for await (const event of streamWorkspaceLiveEvents(
      {
        openStream: async (controlAfter, interactionAfter) => {
          opens.push([controlAfter, interactionAfter]);
          attempt += 1;
          return attempt === 1
            ? streamOf(control(5), interaction(7))
            : streamOf(interaction(7), control(6), interaction(8));
        },
      },
      { controlAfter: 3, interactionAfter: 4, reconnectDelayMs: 0 },
    )) {
      values.push(`${event.type}:${event.sequence}`);
      if (values.length === 4) break;
    }
    expect(opens.slice(0, 2)).toEqual([
      [3, 4],
      [5, 7],
    ]);
    expect(values).toEqual([
      "workspace.control.changed:5",
      "workspace.interaction.changed:7",
      "workspace.control.changed:6",
      "workspace.interaction.changed:8",
    ]);
  });
});
