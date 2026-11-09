import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";
import { SESSION_ID, WORKSPACE_ID } from "./helpers";

function recordingClient(): { client: OpenGeniClient; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    apiKey: "og_test_key",
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ routing: "accepted_for_steering" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  return { client, bodies };
}

describe("steerMessage delivery", () => {
  test("an explicit delivery is sent; the default body is unchanged", async () => {
    const { client, bodies } = recordingClient();
    await client.steerMessage(WORKSPACE_ID, SESSION_ID, "now");
    await client.steerMessage(
      WORKSPACE_ID,
      SESSION_ID,
      { text: "follow-up", clientEventId: "op-1" },
      { delivery: "steer_or_send" },
    );
    await client.steerMessage(WORKSPACE_ID, SESSION_ID, "again", { delivery: "steer" });
    expect(bodies).toEqual([
      { text: "now" },
      { text: "follow-up", clientEventId: "op-1", delivery: "steer_or_send" },
      { text: "again", delivery: "steer" },
    ]);
  });
});
