import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import { describe, expect, test } from "bun:test";
import {
  AttachedBrowserBridgeClient,
  defaultBrowserBridgeAuthorityFile,
} from "../src/attached-bridge";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const GENERATION = "extension-generation-1";

describe("AttachedBrowserBridgeClient", () => {
  test("resolves the same XDG authority path as the connected agent", () => {
    expect(defaultBrowserBridgeAuthorityFile({ XDG_CONFIG_HOME: "/tmp/opengeni-xdg" })).toBe(
      "/tmp/opengeni-xdg/opengeni/agent/browser-bridge-authority.json",
    );
    expect(
      defaultBrowserBridgeAuthorityFile({
        XDG_CONFIG_HOME: "/tmp/ignored",
        OPENGENI_CONFIG_DIR: "/tmp/opengeni-config",
      }),
    ).toBe("/tmp/opengeni-config/browser-bridge-authority.json");
  });

  test("authenticates and multiplexes fenced command responses", async () => {
    const fixture = await bridgeFixture((socket, messages) => {
      const request = messages.find((message) => message.type === "request");
      if (!request) return;
      writeFrame(socket, {
        type: "response",
        protocolVersion: 1,
        requestId: request.requestId,
        deviceId: request.deviceId,
        connectionGeneration: GENERATION,
        ok: true,
        payload: { pong: true },
      });
    });
    try {
      const client = await AttachedBrowserBridgeClient.connect({
        deviceId: DEVICE_ID,
        connectionGeneration: GENERATION,
        authorityFile: fixture.authorityFile,
      });
      await expect(client.request({ type: "ping" })).resolves.toEqual({ pong: true });
      expect(fixture.messages[0]).toMatchObject({
        type: "authenticate",
        role: "controller",
        token: fixture.token,
      });
      expect(fixture.messages[1]).toMatchObject({
        type: "request",
        deviceId: DEVICE_ID,
        expectedConnectionGeneration: GENERATION,
        payload: { type: "ping" },
      });
      client.close();
    } finally {
      await fixture.close();
    }
  });

  test("surfaces a bridge generation fence as retryable", async () => {
    const fixture = await bridgeFixture((socket, messages) => {
      const request = messages.find((message) => message.type === "request");
      if (!request) return;
      writeFrame(socket, {
        type: "response",
        protocolVersion: 1,
        requestId: request.requestId,
        deviceId: request.deviceId,
        connectionGeneration: GENERATION,
        ok: false,
        error: {
          code: "fenced",
          message: "attached browser connection changed",
          retryable: true,
        },
      });
    });
    try {
      const client = await AttachedBrowserBridgeClient.connect({
        deviceId: DEVICE_ID,
        connectionGeneration: GENERATION,
        authorityFile: fixture.authorityFile,
      });
      await expect(client.request({ type: "ping" })).rejects.toMatchObject({
        code: "fenced",
        retryable: true,
      });
      client.close();
    } finally {
      await fixture.close();
    }
  });

  test("accepts screenshot-sized responses above the command envelope", async () => {
    const data = "A".repeat(2 * 1024 * 1024);
    const fixture = await bridgeFixture((socket, messages) => {
      const request = messages.find((message) => message.type === "request");
      if (!request) return;
      writeFrame(socket, {
        type: "response",
        protocolVersion: 1,
        requestId: request.requestId,
        deviceId: request.deviceId,
        connectionGeneration: GENERATION,
        ok: true,
        payload: { data },
      });
    });
    try {
      const client = await AttachedBrowserBridgeClient.connect({
        deviceId: DEVICE_ID,
        connectionGeneration: GENERATION,
        authorityFile: fixture.authorityFile,
      });
      await expect(client.request<{ data: string }>({ type: "screenshot" })).resolves.toEqual({
        data,
      });
      client.close();
    } finally {
      await fixture.close();
    }
  });
});

type JsonRecord = Record<string, unknown>;

async function bridgeFixture(
  onMessages: (socket: Socket, messages: JsonRecord[]) => void,
): Promise<{
  authorityFile: string;
  token: string;
  messages: JsonRecord[];
  close: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "opengeni-attached-bridge-"));
  const token = "A".repeat(43);
  const messages: JsonRecord[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) return;
        messages.push(JSON.parse(buffer.subarray(4, length + 4).toString("utf8")) as JsonRecord);
        buffer = buffer.subarray(length + 4);
        onMessages(socket, messages);
      }
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
  const authorityFile = join(directory, "browser-bridge-authority.json");
  await writeFile(
    authorityFile,
    JSON.stringify({ protocolVersion: 1, port: address.port, token, pid: process.pid }),
    { mode: 0o600 },
  );
  return {
    authorityFile,
    token,
    messages,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function writeFrame(socket: Socket, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  socket.write(frame);
}
