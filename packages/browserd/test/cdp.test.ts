import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { CdpCommandTimeoutError, CdpConnection, CdpProtocolError } from "../src";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("CdpConnection", () => {
  test("detaching a target settles its event waits without cancelling sibling or browser events", async () => {
    let emit: (message: unknown) => void = () => {
      throw new Error("socket not ready");
    };
    const server = Bun.serve({
      port: 0,
      fetch(request, instance) {
        if (instance.upgrade(request)) return;
        return new Response(null, { status: 426 });
      },
      websocket: {
        open(socket) {
          emit = (message) => {
            socket.send(JSON.stringify(message));
          };
        },
        message() {},
      },
    });
    servers.push(server);
    const connection = await CdpConnection.connect(`ws://127.0.0.1:${server.port}/devtools`);
    const abort = new AbortController();
    const cleanup = spyOn(abort.signal, "removeEventListener");
    try {
      const closing = connection
        .waitForEvent("Page.fileChooserOpened", {
          sessionId: "closing-tab",
          signal: abort.signal,
          timeoutMs: 100,
        })
        .catch((error: unknown) => error);
      const sibling = connection.waitForEvent("Page.fileChooserOpened", {
        sessionId: "sibling-tab",
        timeoutMs: 1_000,
      });
      const browser = connection.waitForEvent("Browser.downloadWillBegin", { timeoutMs: 1_000 });
      emit({
        method: "Target.detachedFromTarget",
        sessionId: "parent",
        params: { sessionId: "closing-tab" },
      });
      const error = await closing;
      expect(error).toMatchObject({
        name: "CdpSessionDetachedError",
        method: "Page.fileChooserOpened",
      });
      expect(cleanup).toHaveBeenCalledTimes(1);
      emit({ method: "Page.fileChooserOpened", sessionId: "closing-tab", params: { late: true } });
      emit({ method: "Page.fileChooserOpened", sessionId: "sibling-tab", params: { node: 7 } });
      emit({ method: "Browser.downloadWillBegin", params: { guid: "download" } });
      expect((await sibling).params).toEqual({ node: 7 });
      expect((await browser).params).toEqual({ guid: "download" });
      abort.abort();
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      cleanup.mockRestore();
      connection.close();
    }
  });

  test("closing the connection settles event waits and refuses new waits", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request, instance) {
        if (instance.upgrade(request)) return;
        return new Response(null, { status: 426 });
      },
      websocket: { message() {} },
    });
    servers.push(server);
    const connection = await CdpConnection.connect(`ws://127.0.0.1:${server.port}/devtools`);
    const waiting = connection
      .waitForEvent("Page.fileChooserOpened", { sessionId: "tab", timeoutMs: 100 })
      .catch((error: unknown) => error);
    connection.close();
    expect(await waiting).toMatchObject({ message: "CDP connection closed by browserd" });
    expect(() => connection.waitForEvent("Page.fileChooserOpened", { timeoutMs: 100 })).toThrow(
      "CDP connection closed by browserd",
    );
  });

  test("detaching one target settles only its pending commands and preserves the browser connection", async () => {
    const requests: Array<{ id: number; sessionId?: string }> = [];
    let send: (message: unknown) => void = () => {
      throw new Error("socket not ready");
    };
    const server = Bun.serve({
      port: 0,
      fetch(request, instance) {
        if (instance.upgrade(request)) return;
        return new Response(null, { status: 426 });
      },
      websocket: {
        message(socket, raw) {
          requests.push(JSON.parse(String(raw)));
          send = (message) => {
            socket.send(JSON.stringify(message));
          };
        },
      },
    });
    servers.push(server);
    const connection = await CdpConnection.connect(`ws://127.0.0.1:${server.port}/devtools`);
    const abort = new AbortController();
    const cleanup = spyOn(abort.signal, "removeEventListener");
    let disconnected = false;
    const pending: Promise<unknown>[] = [];
    connection.onDisconnect(() => {
      disconnected = true;
    });
    try {
      const detached = connection
        .send(
          "Input.dispatchMouseEvent",
          {},
          {
            sessionId: "closing-tab",
            signal: abort.signal,
            timeoutMs: 1_000,
          },
        )
        .catch((error: unknown) => error);
      const sibling = connection.send("Page.getLayoutMetrics", {}, { sessionId: "other-tab" });
      const browser = connection.send("Browser.getVersion");
      pending.push(detached, sibling, browser);
      while (requests.length < 3) await Bun.sleep(1);
      // The event envelope belongs to its parent, not the detached child.
      send({
        method: "Target.detachedFromTarget",
        sessionId: "parent-session",
        params: { sessionId: "closing-tab" },
      });
      const error = await detached;
      expect(error).toMatchObject({
        name: "CdpSessionDetachedError",
        method: "Input.dispatchMouseEvent",
      });
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(disconnected).toBe(false);
      send({ id: requests[0]!.id, result: { late: true } });
      send({ id: requests[1]!.id, result: { sibling: true } });
      send({ id: requests[2]!.id, result: { browser: true } });
      expect(await sibling).toEqual({ sibling: true });
      expect(await browser).toEqual({ browser: true });
      abort.abort();
      expect(disconnected).toBe(false);
    } finally {
      cleanup.mockRestore();
      connection.close();
      await Promise.allSettled(pending);
    }
  });

  test("disconnect observers run once, unsubscribe, and observe an already closed connection", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request, instance) {
        if (instance.upgrade(request)) return;
        return new Response(null, { status: 426 });
      },
      websocket: { message() {} },
    });
    servers.push(server);
    const connection = await CdpConnection.connect(`ws://127.0.0.1:${server.port}/devtools`);
    let retained = 0;
    let removed = 0;
    connection.onDisconnect(() => {
      retained += 1;
    });
    const unsubscribe = connection.onDisconnect(() => {
      removed += 1;
    });
    unsubscribe();
    connection.close();
    connection.close();
    connection.onDisconnect(() => {
      retained += 1;
    });
    expect(retained).toBe(2);
    expect(removed).toBe(0);
  });

  test("cleans up a timed out command and ignores its late reply without closing the connection", async () => {
    let replyToExpired: (() => void) | undefined;
    const server = Bun.serve({
      port: 0,
      fetch(request, instance) {
        if (instance.upgrade(request)) return;
        return new Response(null, { status: 426 });
      },
      websocket: {
        message(socket, raw) {
          const message = JSON.parse(String(raw)) as { id: number; method: string };
          const reply = () =>
            socket.send(JSON.stringify({ id: message.id, result: { method: message.method } }));
          if (message.method === "Page.captureScreenshot") replyToExpired = reply;
          else reply();
        },
      },
    });
    servers.push(server);
    const connection = await CdpConnection.connect(`ws://127.0.0.1:${server.port}/devtools`);
    const controller = new AbortController();
    const cleanup = spyOn(controller.signal, "removeEventListener");
    try {
      const error = await connection
        .send(
          "Page.captureScreenshot",
          {},
          {
            timeoutMs: 20,
            signal: controller.signal,
          },
        )
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(CdpCommandTimeoutError);
      expect(error).toMatchObject({ method: "Page.captureScreenshot" });
      expect(cleanup).toHaveBeenCalledTimes(1);
      replyToExpired?.();
      const layout = await connection.send<{ method: string }>("Page.getLayoutMetrics");
      expect(layout).toEqual({ method: "Page.getLayoutMetrics" });
      controller.abort();
      const version = await connection.send<{ method: string }>("Browser.getVersion");
      expect(version).toEqual({ method: "Browser.getVersion" });
    } finally {
      cleanup.mockRestore();
      connection.close();
    }
  });

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
