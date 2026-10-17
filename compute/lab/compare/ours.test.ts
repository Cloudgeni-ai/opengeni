import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { framed, Ours, parseAddress, scan } from "./ours.ts";

test("addresses", () => {
  expect(parseAddress("/run/compute-host.sock")).toEqual({ path: "/run/compute-host.sock" });
  expect(parseAddress("unix:/x.sock")).toEqual({ path: "/x.sock" });
  expect(parseAddress("tcp:10.0.0.4:7000")).toEqual({ host: "10.0.0.4", port: 7000 });
  expect(() => parseAddress("tcp:10.0.0.4")).toThrow();
});

test("framing matches the host agent's bench", () => {
  expect(framed("echo 'hi'")).toBe(`bash -c 'echo '\\''hi'\\''' </dev/null\nprintf '\\036compute-bench-done %d\\036' "$?"\nexit\n`);
});

test("the scan holds back a tail that may start the record", () => {
  expect(scan(Buffer.from("hello\n"))).toEqual({ done: false, output: 6 });
  expect(scan(Buffer.from("hello\n\x1ecompute-b"))).toEqual({ done: false, output: 6 });
  expect(scan(Buffer.from("hello\n\x1ecompute-bench-done 1"))).toEqual({ done: false, output: 6 });
  expect(scan(Buffer.from("hello\n\x1ecompute-bench-done 3\x1e"))).toEqual({ done: true, output: 6, status: 3 });
  expect(scan(Buffer.from("\x1ecompute-bench-done 0\x1e"))).toEqual({ done: true, output: 0, status: 0 });
});

let server: Server | undefined;
let dir: string | undefined;
afterEach(() => {
  server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A fake host agent: answers each JSON line, and plays a guest shell after `connect`. */
function fakeAgent(onRequest: (request: Record<string, unknown>, socket: Socket) => void): string {
  dir = mkdtempSync(join(tmpdir(), "compare-"));
  const path = join(dir, "agent.sock");
  server = createServer((socket) => {
    let line = "";
    const onData = (chunk: Buffer) => {
      line += chunk.toString();
      const newline = line.indexOf("\n");
      if (newline < 0) return;
      socket.off("data", onData);
      onRequest(JSON.parse(line.slice(0, newline)), socket);
    };
    socket.on("data", onData);
  });
  server.listen(path);
  return path;
}

test("a run times the first byte and the completion record, even when the reply and output share a packet", async () => {
  const levels = new Map<string, string>();
  const path = fakeAgent((request, socket) => {
    switch (request.op) {
      case "create":
        levels.set(String(request.id), "running");
        socket.end(`${JSON.stringify({ result: "done" })}\n`);
        return;
      case "connect": {
        socket.once("data", () => {
          // Output, then the record split across two writes.
          setTimeout(() => socket.write("compare-ok\n\x1ecompute-bench"), 20);
          setTimeout(() => socket.end("-done 0\x1e"), 40);
        });
        // The reply line and nothing else yet.
        socket.write(`${JSON.stringify({ result: "connected", waited_us: 1500, connect_us: 300, generation: 1 })}\n`);
        return;
      }
      case "status":
        socket.end(`${JSON.stringify({ result: "status", sandboxes: [...levels].map(([id, level]) => ({ id, level, step: null, holds: 0, broken: false })) })}\n`);
        return;
      case "sleep":
        levels.set(String(request.id), String(request.level));
        socket.end(`${JSON.stringify({ result: "done" })}\n`);
        return;
      default:
        socket.end(`${JSON.stringify({ result: "error", message: "nope", code: "invalid" })}\n`);
    }
  });
  const ours = new Ours({ address: path });
  const started = performance.now();
  const { sandbox, run } = await ours.create("pool", "echo compare-ok", started);
  expect(sandbox.id).toMatch(/^[0-9a-f]{32}$/);
  expect(run.output).toBe("compare-ok\n");
  expect(run.status).toBe(0);
  expect(run.firstByteMs).toBeGreaterThanOrEqual(15);
  expect(run.doneMs).toBeGreaterThanOrEqual(run.firstByteMs + 10);
  expect(run.phases.host_wake_ms).toBe(1.5);
  await ours.rest(sandbox, "saved");
  expect(levels.get(sandbox.id)).toBe("saved");
  expect(await ours.list()).toEqual([sandbox.id]);
  await expect(ours.remove(sandbox)).rejects.toThrow("invalid: nope");
});

test("an agent error on connect is reported with its code", async () => {
  const path = fakeAgent((_request, socket) => {
    socket.end(`${JSON.stringify({ result: "error", message: "the host is full", code: "host_full" })}\n`);
  });
  const ours = new Ours({ address: path });
  await expect(ours.run({ id: "0".repeat(32) }, "echo", performance.now())).rejects.toThrow("host_full: the host is full");
});
