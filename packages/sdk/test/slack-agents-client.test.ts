import { expect, test } from "bun:test";
import { OpenGeniClient } from "../src/artifact-client";
import { OpenGeniApiError } from "../src/errors";
import { WORKSPACE_ID } from "./helpers";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONNECTION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function recording(responder: () => Response = () => Response.json({})) {
  const requests: { url: string; method: string; body: string | null }[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    apiKey: "og_test_key",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input instanceof Request ? input : String(input), init);
      requests.push({
        url: request.url,
        method: request.method,
        body: request.body ? await request.text() : null,
      });
      return responder();
    }) as typeof fetch,
  });
  return { client, requests };
}

test("Slack agent methods call the agent routes of the given workspace", async () => {
  const { client, requests } = recording();
  const base = `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/integrations/slack/agents`;
  await client.listOpenGeniSlackAgents(WORKSPACE_ID);
  await client.createOpenGeniSlackAgent(WORKSPACE_ID, {
    connectionId: CONNECTION_ID,
    name: "Data team",
    description: "Answers data questions.",
    avatar: { kind: "icon", icon: "database", hue: 215 },
    instructions: "",
  });
  await client.updateOpenGeniSlackAgent(WORKSPACE_ID, AGENT_ID, {
    expectedVersion: 2,
    name: "Data",
  });
  await client.deleteOpenGeniSlackAgent(WORKSPACE_ID, AGENT_ID);
  await client.listOpenGeniSlackAgentChannels(WORKSPACE_ID, AGENT_ID);
  await client.listOpenGeniSlackAgentChannels(WORKSPACE_ID, AGENT_ID, "next page");
  await client.postOpenGeniSlackAgentIntro(WORKSPACE_ID, AGENT_ID, { channelIds: ["C1"] });
  expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
    `GET ${base}`,
    `POST ${base}`,
    `PATCH ${base}/${AGENT_ID}`,
    `DELETE ${base}/${AGENT_ID}`,
    `GET ${base}/${AGENT_ID}/channels`,
    `GET ${base}/${AGENT_ID}/channels?cursor=next+page`,
    `POST ${base}/${AGENT_ID}/intro`,
  ]);
  expect(JSON.parse(requests[1]!.body!)).toMatchObject({ name: "Data team" });
  expect(JSON.parse(requests[2]!.body!)).toEqual({ expectedVersion: 2, name: "Data" });
  expect(JSON.parse(requests[6]!.body!)).toEqual({ channelIds: ["C1"] });
});

test("a refused create exposes the reason code in the error details", async () => {
  const { client } = recording(() =>
    Response.json(
      {
        error: {
          code: "conflict",
          message: "The Opengeni bot is not available in this workspace.",
          details: { code: "slack_bot_unavailable" },
        },
      },
      { status: 409 },
    ),
  );
  const failure = await client
    .createOpenGeniSlackAgent(WORKSPACE_ID, {
      connectionId: CONNECTION_ID,
      name: "Data team",
      description: "Answers data questions.",
      avatar: { kind: "icon", icon: "database", hue: 215 },
    })
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(OpenGeniApiError);
  expect((failure as OpenGeniApiError).status).toBe(409);
  expect((failure as OpenGeniApiError).details?.code).toBe("slack_bot_unavailable");
});
