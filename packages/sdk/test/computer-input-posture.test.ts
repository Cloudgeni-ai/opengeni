import { expect, test } from "bun:test";
import { ComputerSessionResource, OpenGeniClient, type BrowserInteractionTransport } from "../src";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const computerSessionId = "44444444-4444-4444-8444-444444444444";

test("computer input posture performs a fresh bounded GET through the resource facade", async () => {
  const requests: { url: string; method: string; signal: AbortSignal | null }[] = [];
  const controller = new AbortController();
  const client = new OpenGeniClient({
    baseUrl: "https://computer.example.test",
    fetch: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        signal: init?.signal ?? null,
      });
      return Response.json({
        computerSessionId,
        controllerGeneration: "controller-1",
        inputAllowed: requests.length > 1,
      });
    },
  });
  const resource = client.interaction.computers.session(workspaceId, computerSessionId);
  expect(
    (await resource.inputPosture({ signal: controller.signal, timeoutMs: 15_000 })).inputAllowed,
  ).toBe(false);
  expect((await resource.inputPosture()).inputAllowed).toBe(true);
  expect(requests.map(({ url, method }) => ({ url, method }))).toEqual(
    Array.from({ length: 2 }, () => ({
      url: `https://computer.example.test/v1/workspaces/${workspaceId}/computer-sessions/${computerSessionId}/input-posture`,
      method: "GET",
    })),
  );
  expect(requests[0]!.signal).toBeInstanceOf(AbortSignal);
});

test("an older custom transport cannot manufacture an app input posture", async () => {
  const resource = new ComputerSessionResource(
    {} as BrowserInteractionTransport,
    workspaceId,
    computerSessionId,
  );
  await expect(resource.inputPosture()).rejects.toThrow("input posture");
});
