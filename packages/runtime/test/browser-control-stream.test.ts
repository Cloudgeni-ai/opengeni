import { expect, test } from "bun:test";
import {
  controllerStreamRequest,
  parseControllerStreamResponse,
} from "../src/sandbox/browser-control-stream";
import {
  BrowserControlClient,
  BrowserControlTransportError,
} from "../src/sandbox/browser-control-client";

const token = "synthetic." + "x".repeat(48);
const frame = (headers: string, body: Uint8Array, exit = "0", marker = "end") =>
  Buffer.concat([Buffer.from(headers), body, Buffer.from(`\n${marker}${exit}`)]).toString("base64");

test("stream transport preserves binary bytes, skips informational headers, and takes the final trailer", () => {
  const body = Buffer.concat([
    Buffer.from([0, 255, 128]),
    Buffer.from("\nend0\r\nHTTP/1.1 201 Fake\r\n\r\n"),
  ]);
  const result = parseControllerStreamResponse(
    frame("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nX-Test: exact\r\n\r\n", body),
    "end",
    100,
  );
  expect(result.status).toBe(200);
  expect(result.headers.get("x-test")).toBe("exact");
  expect(result.data).toEqual(body);
});

test.each([
  ["invalid base64", "not base64"],
  ["missing exit trailer", Buffer.from("HTTP/1.1 200 OK\r\n\r\n{}").toString("base64")],
  ["curl failure", frame("HTTP/1.1 200 OK\r\n\r\n", Buffer.from("partial"), "18")],
  ["invalid status", frame("HTTP/1.1 999 Invalid\r\n\r\n", Buffer.from("{}"))],
  ["missing headers", frame("HTTP/1.1 200 OK\r\n", Buffer.from("{}"))],
  ["body overflow", frame("HTTP/1.1 200 OK\r\n\r\n", Buffer.alloc(101))],
] as const)("refuses %s", (_name, value) => {
  expect(() => parseControllerStreamResponse(value, "end", 100)).toThrow();
});

test("large binary output stays bounded without a recursive base64 matcher", () => {
  const body = Buffer.alloc(2 * 1024 * 1024, 0xff);
  expect(
    parseControllerStreamResponse(frame("HTTP/1.1 200 OK\r\n\r\n", body), "end", body.length).data,
  ).toEqual(body);
});

test("authority and JSON body use stdin only, with literal curl config escaping", async () => {
  const payload = { text: 'a\n"\\$(echo no)`no`', unicode: "æøå" };
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests++;
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(await request.json()).toEqual(payload);
      return Response.json({ protocolVersion: 1, ok: true, data: payload });
    },
  });
  let commands = 0,
    finalized = 0;
  const client = new BrowserControlClient(
    {
      async ensureBrowserControl() {
        return { port: server.port };
      },
      async execWithInput(args) {
        commands++;
        expect(args.cmd).not.toContain(token);
        expect(args.cmd).not.toContain("unicode");
        const proc = Bun.spawn([args.shell, "-c", args.cmd], {
          cwd: args.workdir,
          stdin: args.stdin,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { stdout, stderr, exitCode };
      },
      async finalizeOpStreamOps() {
        finalized++;
      },
      async readFile() {
        throw new Error("unexpected file read");
      },
      async writeFile() {
        throw new Error("unexpected file write");
      },
    },
    { adminToken: token, port: server.port },
  );
  try {
    expect(
      await client.requestForSession({ method: "POST", path: "/fixture", token, body: payload }),
    ).toEqual(payload);
    expect({ commands, requests, finalized }).toEqual({ commands: 1, requests: 1, finalized: 1 });
  } finally {
    server.stop(true);
  }
});

test("unknown mutation transport outcome is never retried or sent to a fallback", async () => {
  let calls = 0;
  const client = new BrowserControlClient(
    {
      async execWithInput() {
        calls++;
        throw new Error("synthetic disconnect after dispatch");
      },
      async exec() {
        throw new Error("unexpected fallback");
      },
      async ensureBrowserControl() {
        return { port: 12345 };
      },
    },
    { adminToken: token, nativeAuthority: { scopeId: "synthetic", scopeGeneration: "generation" } },
  );
  await expect(
    client.requestForSession({ method: "POST", path: "/fixture", token, body: {} }),
  ).rejects.toBeInstanceOf(BrowserControlTransportError);
  expect(calls).toBe(1);
});

test("oversized request is rejected before command execution", () => {
  expect(() =>
    controllerStreamRequest({
      method: "POST",
      url: "http://127.0.0.1:1234/fixture",
      token,
      body: "x".repeat(128 * 1024),
      timeoutMs: 1000,
      maxBytes: 100,
    }),
  ).toThrow("input is too large");
});

test("reconstructed transport accepts the original command's retained output", () => {
  const input = {
    method: "GET",
    url: "http://127.0.0.1:1234/fixture",
    token,
    timeoutMs: 1000,
    maxBytes: 100,
  };
  const first = controllerStreamRequest(input);
  const recovered = controllerStreamRequest(input);
  expect(recovered.cmd).toBe(first.cmd);
  const originalOutput = frame("HTTP/1.1 200 OK\r\n\r\n", Buffer.from("{}"), "0", first.marker);
  expect(parseControllerStreamResponse(originalOutput, recovered.marker, 100).status).toBe(200);
});

test.each([false, true])(
  "streamed image preserves bytes and validates original controller binding (foreign=%s)",
  async (foreign) => {
    const browserSessionId = crypto.randomUUID();
    const metadata = {
      frameId: "frame",
      browserSessionId,
      controllerGeneration: foreign ? "other" : "controller",
      targetId: "tab",
      targetGeneration: "target",
      documentGeneration: "document",
      sequence: 0,
      mediaType: "image/jpeg",
      width: 1,
      height: 1,
      deviceScaleFactor: 1,
      scrollX: 0,
      scrollY: 0,
      capturedAt: "2026-01-01T00:00:00.000Z",
    };
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    let calls = 0;
    const client = new BrowserControlClient(
      {
        async execWithInput(args) {
          calls++;
          const marker = /OPENGENI_CONTROLLER_END_V1/u.exec(args.cmd)![0];
          return {
            exitCode: 0,
            stdout: frame(
              `HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nx-opengeni-browser-frame: ${Buffer.from(JSON.stringify(metadata)).toString("base64url")}\r\n\r\n`,
              bytes,
              "0",
              marker,
            ),
          };
        },
      },
      { adminToken: token },
    );
    const browser = client.sessionClient({
      reference: { browserSessionId, controllerGeneration: "controller" },
      controlToken: token,
      viewToken: token,
    });
    const pending = browser.capture("tab");
    if (foreign) await expect(pending).rejects.toThrow();
    else expect((await pending).data).toEqual(bytes);
    expect(calls).toBe(1);
  },
);

test("only GET may re-resolve a stale native endpoint, once", async () => {
  let ensures = 0,
    calls = 0;
  const client = new BrowserControlClient(
    {
      async ensureBrowserControl() {
        ensures++;
        return { port: 12340 + ensures };
      },
      async execWithInput(args) {
        calls++;
        if (calls === 1) throw new Error("synthetic stale endpoint");
        expect(new TextDecoder().decode(args.stdin)).toContain("127.0.0.1:12342");
        return {
          exitCode: 0,
          stdout: frame(
            "HTTP/1.1 200 OK\r\n\r\n",
            Buffer.from(JSON.stringify({ protocolVersion: 1, ok: true, data: "read" })),
            "0",
            "OPENGENI_CONTROLLER_END_V1",
          ),
        };
      },
    },
    {
      adminToken: token,
      nativeAuthority: { scopeId: "synthetic-read", scopeGeneration: "generation" },
    },
  );
  expect(await client.requestForSession({ method: "GET", path: "/fixture", token })).toBe("read");
  expect({ ensures, calls }).toEqual({ ensures: 2, calls: 2 });
});
