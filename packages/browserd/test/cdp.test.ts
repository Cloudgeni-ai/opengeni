import { afterEach, describe, expect, test } from "bun:test";
import { CdpConnection, CdpProtocolError } from "../src";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("CdpConnection", () => {
  test("multiplexes commands, target sessions, and events over one local socket", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request, instance) {
        if (instance.upgrade(request)) return;
        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        message(socket, raw) {
          const message = JSON.parse(String(raw)) as {
            id: number;
            method: string;
            sessionId?: string;
          };
          socket.send(
            JSON.stringify({
              id: message.id,
              ...(message.sessionId ? { sessionId: message.sessionId } : {}),
              result: { echoedMethod: message.method },
            }),
          );
          socket.send(
            JSON.stringify({
              method: "Runtime.consoleAPICalled",
              sessionId: message.sessionId,
              params: { type: "log" },
            }),
          );
        },
      },
    });
    servers.push(server);
    const connection = await CdpConnection.connect(`ws://127.0.0.1:${server.port}/devtools`);
    const events: string[] = [];
    connection.on(
      "Runtime.consoleAPICalled",
      (event) => events.push(String(event.params.type)),
      "target-session",
    );

    const response = await connection.send<{ echoedMethod: string }>(
      "Runtime.enable",
      {},
      { sessionId: "target-session" },
    );
    await Bun.sleep(1);

    expect(response).toEqual({ echoedMethod: "Runtime.enable" });
    expect(events).toEqual(["log"]);
    connection.close();
  });

  test("returns bounded typed protocol failures", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request, instance) {
        if (instance.upgrade(request)) return;
        return new Response(null, { status: 426 });
      },
      websocket: {
        message(socket, raw) {
          const message = JSON.parse(String(raw)) as { id: number };
          socket.send(
            JSON.stringify({
              id: message.id,
              error: {
                code: -32_600,
                message: "Unknown method\nwith noisy details",
              },
            }),
          );
        },
      },
    });
    servers.push(server);
    const connection = await CdpConnection.connect(`ws://127.0.0.1:${server.port}/devtools`);

    const error = await connection.send("Unknown.method").catch((value) => value);
    expect(error).toBeInstanceOf(CdpProtocolError);
    expect(error).toMatchObject({
      method: "Unknown.method",
      code: -32_600,
      message: "Unknown method with noisy details",
    });
    connection.close();
  });

  test("delivers a root event to each listener exactly once", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request, instance) {
        if (instance.upgrade(request)) return;
        return new Response(null, { status: 426 });
      },
      websocket: {
        message(socket, raw) {
          const message = JSON.parse(String(raw)) as { id: number };
          socket.send(JSON.stringify({ method: "Browser.downloadWillBegin", params: {} }));
          socket.send(JSON.stringify({ id: message.id, result: {} }));
        },
      },
    });
    servers.push(server);
    const connection = await CdpConnection.connect(`ws://127.0.0.1:${server.port}/devtools`);
    let calls = 0;
    connection.on("Browser.downloadWillBegin", () => {
      calls += 1;
    });
    await connection.send("Browser.enable");
    expect(calls).toBe(1);
    connection.close();
  });

  test("rejects ambient remote CDP endpoints", () => {
    expect(() => CdpConnection.connect("ws://example.com/devtools")).toThrow(
      "local placement bridge",
    );
  });
});
