import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measuredExec } from "./wake-exec";

async function withServer(handler: (socket: Socket) => void, run: (path: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "wake-protocol-"));
  const path = join(directory, "v.sock");
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  try { await run(path); }
  finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true });
  }
}

function successfulGuest(socket: Socket) {
  let command = "";
  let handshake = false;
  socket.on("data", (data) => {
    if (!handshake) {
      expect(data.toString()).toBe("CONNECT 52\n");
      handshake = true;
      socket.write("O");
      setTimeout(() => socket.write("K 52\n"), 5);
      return;
    }
    command += data.toString();
    const marker = /wake-done-[a-f0-9-]+/.exec(command)?.[0];
    if (!marker) return;
    socket.write(`function\n\n${marker}:`);
    setTimeout(() => socket.write("0\n"), 5);
    setTimeout(() => socket.end(), 80);
  });
}

test("command marker and delayed EOF are distinct, even with fragmented frames", async () => {
  await withServer(successfulGuest, async (path) => {
    const result = await measuredExec(path, "true", 2000);
    expect(result.status).toBe(0);
    expect(result.doneMs).toBeGreaterThanOrEqual(result.firstByteMs);
    expect(result.ms - result.doneMs).toBeGreaterThan(30);
  });
});

test("admission can close at the marker without waiting for peer EOF", async () => {
  await withServer(successfulGuest, async (path) => {
    const result = await measuredExec(path, "true", 2000, true);
    expect(result.status).toBe(0);
    expect(result.ms - result.doneMs).toBeLessThan(30);
  });
});

test("a socket closing without a command marker fails the measurement", async () => {
  await withServer((socket) => socket.once("data", () => socket.end("OK 52\n")), async (path) => {
    await expect(measuredExec(path, "true", 2000)).rejects.toThrow("completion marker");
  });
});
