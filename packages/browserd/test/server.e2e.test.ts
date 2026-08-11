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
  decodeBrowserFrameMetadataHeader,
} from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

e2e(
  "drives the real pinned browser through authenticated HTTP and websocket protocol",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-server-e2e-");
    const socketDirectory = await mkdtemp("/tmp/ogs-");
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
        headed: false,
        initialUrl: fixture(),
      });
      expect(created.status).toBe(201);
      const observation = ((await created.json()) as { data: { observation: BrowserObservation } })
        .data.observation;
      const button = flatten(
        observation.semantic?.kind === "snapshot" ? observation.semantic.roots : [],
      ).find((node) => node.role === "button");
      if (!button) throw new Error("fixture button missing");
      const acted = await request(
        server,
        `/v1/browser-sessions/${reference.browserSessionId}/actions`,
        controlToken,
        command(observation, button.ref),
      );
      expect(acted.status).toBe(200);
      const receipt = (await acted.json()) as { data: { observation: BrowserObservation } };
      expect(names(receipt.data.observation)).toContain("Clicked through browserd");

      const screenshot = await fetch(
        `${server.url}/v1/browser-sessions/${reference.browserSessionId}/targets/${encodeURIComponent(observation.target.id)}/screenshot`,
        { headers: { authorization: `Bearer ${viewToken}` } },
      );
      expect(screenshot.status).toBe(200);
      expect(
        decodeBrowserFrameMetadataHeader(screenshot.headers.get("x-opengeni-browser-frame")!),
      ).toMatchObject({ browserSessionId: reference.browserSessionId });
      expect((await screenshot.arrayBuffer()).byteLength).toBeGreaterThan(100);

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
      await rm(directory, { recursive: true, force: true });
      await rm(socketDirectory, { recursive: true, force: true });
    }
  },
);

function fixture(): string {
  return `data:text/html,${encodeURIComponent(`<!doctype html><html><head><title>Wire fixture</title></head><body><button onclick="this.textContent='Clicked through browserd'">Click me</button></body></html>`)}`;
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
    actor: { kind: "system", subjectId: "wire-e2e" },
    action: { type: "click", locator: { kind: "ref", ref } },
  };
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

function names(observation: BrowserObservation): string[] {
  return flatten(observation.semantic?.kind === "snapshot" ? observation.semantic.roots : [])
    .map((node) => node.name)
    .filter((name): name is string => typeof name === "string");
}

function flatten(nodes: readonly InteractionSemanticNodeValue[]): InteractionSemanticNodeValue[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

async function websocketMessage(websocket: WebSocket): Promise<ArrayBuffer> {
  return await new Promise<ArrayBuffer>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket message timeout")), 5_000);
    websocket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        if (event.data instanceof ArrayBuffer) resolve(event.data);
        else reject(new Error("expected binary websocket message"));
      },
      { once: true },
    );
    websocket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("websocket failed"));
      },
      { once: true },
    );
    websocket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timer);
        reject(new Error(`websocket closed before a frame: ${event.code} ${event.reason}`));
      },
      { once: true },
    );
  });
}

async function websocketClosed(websocket: WebSocket): Promise<void> {
  if (websocket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket close timeout")), 2_000);
    websocket.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
