import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserActionCommand,
  BrowserObservation,
  InteractionSemanticNodeValue,
} from "@opengeni/contracts";
import {
  BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX,
  BROWSER_CONTROL_WEBSOCKET_PROTOCOL,
  BrowserControlServer,
  BrowserSupervisor,
  decodeBrowserFrameMessage,
} from "../src";

const e2e = process.env.OPENGENI_ATTACHED_CHROME_E2E === "1" ? test : test.skip;

e2e(
  "drives an exact connected Chrome profile through the native bridge",
  async () => {
    const deviceId = requiredEnvironment("OPENGENI_ATTACHED_BROWSER_DEVICE_ID");
    const connectionGeneration = requiredEnvironment(
      "OPENGENI_ATTACHED_BROWSER_CONNECTION_GENERATION",
    );
    const directory = await mkdtemp("/tmp/ogb-attached-e2e-");
    const socketDirectory = await mkdtemp("/tmp/ogs-attached-");
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          "<!doctype html><html><head><title>Attached fixture</title></head>" +
            "<body><button onclick=\"this.textContent='Clicked connected Chrome'\">Continue</button></body></html>",
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    });
    const supervisor = await BrowserSupervisor.open({
      rootDirectory: join(directory, "state"),
      socketRootDirectory: socketDirectory,
    });
    const adminToken = `admin.${"a".repeat(48)}`;
    const controlToken = `control.${"c".repeat(48)}`;
    const viewToken = `view.${"v".repeat(48)}`;
    const reference = {
      browserSessionId: randomUUID(),
      controllerGeneration: `controller-${randomUUID()}`,
    };
    const server = BrowserControlServer.start({ supervisor, adminToken, port: 0 });
    let websocket: WebSocket | null = null;
    try {
      const created = await request(server, "/v1/browser-sessions", adminToken, {
        ...reference,
        tokenGeneration: 1,
        controlToken,
        viewToken,
        headed: true,
        initialUrl: fixture.url.href,
        transport: {
          kind: "attached_chrome",
          deviceId,
          connectionGeneration,
          browserName: process.env.OPENGENI_ATTACHED_BROWSER_NAME ?? "Chrome",
          browserVersion: process.env.OPENGENI_ATTACHED_BROWSER_VERSION ?? "unknown",
        },
      });
      const createdPayload = (await created.json()) as {
        data?: { observation: BrowserObservation };
        error?: unknown;
      };
      if (created.status !== 201 || !createdPayload.data) {
        throw new Error(
          `connected Chrome create failed (${created.status}): ${JSON.stringify(createdPayload)}`,
        );
      }
      const observation = createdPayload.data.observation;
      expect(observation.target.url).toStartWith(fixture.url.href);
      const button = flatten(
        observation.semantic?.kind === "snapshot" ? observation.semantic.roots : [],
      ).find((node) => node.role === "button");
      if (!button) throw new Error("connected Chrome fixture button is missing");

      const acted = await request(
        server,
        `/v1/browser-sessions/${reference.browserSessionId}/actions`,
        controlToken,
        command(observation, button.ref),
      );
      expect(acted.status).toBe(200);
      const receipt = (await acted.json()) as { data: { observation: BrowserObservation } };
      expect(names(receipt.data.observation)).toContain("Clicked connected Chrome");

      websocket = new WebSocket(
        `${server.url.replace("http:", "ws:")}/v1/browser-sessions/${reference.browserSessionId}/targets/${encodeURIComponent(observation.target.id)}/frames?maxWidth=640&maxHeight=480`,
        [
          BROWSER_CONTROL_WEBSOCKET_PROTOCOL,
          `${BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX}${viewToken}`,
        ],
      );
      websocket.binaryType = "arraybuffer";
      const frame = decodeBrowserFrameMessage(new Uint8Array(await websocketMessage(websocket)));
      expect(frame).toMatchObject({
        browserSessionId: reference.browserSessionId,
        targetId: observation.target.id,
        mediaType: "image/jpeg",
      });
      expect(frame.data.byteLength).toBeGreaterThan(100);
      websocket.close(1000, "done");
      await websocketClosed(websocket);
      websocket = null;

      const ended = await request(
        server,
        `/v1/browser-sessions/${reference.browserSessionId}/end`,
        adminToken,
        { controllerGeneration: reference.controllerGeneration, removeState: true },
      );
      expect(ended.status).toBe(200);
    } finally {
      websocket?.close();
      await server.stop();
      fixture.stop(true);
      await rm(directory, { recursive: true, force: true });
      await rm(socketDirectory, { recursive: true, force: true });
    }
  },
  30_000,
);

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function command(observation: BrowserObservation, ref: string): BrowserActionCommand {
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    browserSessionId: observation.browserSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedDocumentGeneration: observation.target.documentGeneration,
    expectedFrameId: observation.frameId,
    actor: { kind: "system", subjectId: "connected-chrome-e2e" },
    action: { type: "click", locator: { kind: "ref", ref } },
  };
}

function names(observation: BrowserObservation): string[] {
  return flatten(observation.semantic?.kind === "snapshot" ? observation.semantic.roots : [])
    .map((node) => node.name)
    .filter((name): name is string => typeof name === "string");
}

function flatten(nodes: readonly InteractionSemanticNodeValue[]): InteractionSemanticNodeValue[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

async function request(
  server: BrowserControlServer,
  path: string,
  token: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function websocketMessage(websocket: WebSocket): Promise<ArrayBuffer> {
  return await new Promise<ArrayBuffer>((resolveMessage, rejectMessage) => {
    const timer = setTimeout(() => rejectMessage(new Error("websocket message timeout")), 5_000);
    websocket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        if (event.data instanceof ArrayBuffer) resolveMessage(event.data);
        else rejectMessage(new Error("expected binary websocket message"));
      },
      { once: true },
    );
    websocket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        rejectMessage(new Error("websocket failed"));
      },
      { once: true },
    );
  });
}

async function websocketClosed(websocket: WebSocket): Promise<void> {
  if (websocket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolveClosed, rejectClosed) => {
    const timer = setTimeout(() => rejectClosed(new Error("websocket close timeout")), 2_000);
    websocket.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolveClosed();
      },
      { once: true },
    );
  });
}
