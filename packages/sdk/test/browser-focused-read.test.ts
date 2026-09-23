import { expect, test } from "bun:test";
import { OpenGeniClient, type BrowserDomReadRequest } from "../src";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const browserSessionId = "00000000-0000-4000-8000-000000000002";
const targetId = "tab-1";
const state = {
  browserSessionId,
  controllerGeneration: "controller-1",
  targetId,
  targetGeneration: "target-1",
  documentGeneration: "document-1",
  frameId: "frame-1",
};
const request: BrowserDomReadRequest = {
  kind: "element",
  locator: { kind: "css", selector: "#card-number" },
  expectedTargetGeneration: state.targetGeneration,
  expectedDocumentGeneration: state.documentGeneration,
  expectedFrameId: state.frameId,
};

test("browser focused reads use dedicated routes and preserve redaction", async () => {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const sdk = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json(
        url.pathname.endsWith("/state")
          ? state
          : {
              ...state,
              kind: "element",
              count: 1,
              text: null,
              value: null,
              attributes: {},
              redacted: "payment",
              truncated: false,
            },
      );
    },
  });
  const browser = sdk.interaction.browsers.session(workspaceId, browserSessionId);
  expect(await browser.targetState(targetId)).toEqual(state);
  expect(await browser.readDom(targetId, request)).toMatchObject({
    redacted: "payment",
    text: null,
    value: null,
    attributes: {},
  });
  expect(calls).toEqual([
    {
      method: "GET",
      path: `/v1/workspaces/${workspaceId}/browser-sessions/${browserSessionId}/targets/${targetId}/state`,
      body: null,
    },
    {
      method: "POST",
      path: `/v1/workspaces/${workspaceId}/browser-sessions/${browserSessionId}/targets/${targetId}/dom-read`,
      body: request,
    },
  ]);
});

test("browser focused reads reject foreign sessions and changed fences", async () => {
  let result: Record<string, unknown> = { ...state, browserSessionId: workspaceId };
  const sdk = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    fetch: async () => Response.json(result),
  });
  await expect(sdk.getBrowserTargetState(workspaceId, browserSessionId, targetId)).rejects.toThrow(
    "another binding",
  );
  result = { ...state, kind: "element", count: 0, truncated: false, targetGeneration: "target-2" };
  await expect(
    sdk.readBrowserDom(workspaceId, browserSessionId, targetId, request),
  ).rejects.toThrow("another binding");
});
