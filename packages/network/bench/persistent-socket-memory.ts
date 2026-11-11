// Run each mode in a fresh Bun process; no provider credentials or network required.
import { nodeWebSocketFactory } from "../src/responses-websocket";
import { spawn } from "node:child_process";

const mode = process.argv[2] ?? "js";
const count = Number(process.env.SOCKETS ?? 32);
const bytes = Number(process.env.FRAME_BYTES ?? 4 * 1024 * 1024);
if (mode === "server") {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, listener) {
      if (listener.upgrade(req)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(socket) {
        socket.send("done");
      },
    },
  });
  console.log(server.port);
  process.on("SIGTERM", () => {
    server.stop(true);
    process.exit(0);
  });
  await new Promise(() => {});
}
const serverProcess = spawn(process.execPath, [import.meta.path, "server"], {
  stdio: ["ignore", "pipe", "inherit"],
});
const sockets: ReturnType<ReturnType<typeof nodeWebSocketFactory>>[] = [];
try {
  const port = await new Promise<number>((resolve, reject) => {
    serverProcess.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim())));
    serverProcess.once("error", reject);
    serverProcess.once("exit", () => reject(new Error("Local server exited before listening")));
  });
  const create = mode === "native" ? (url: string) => new WebSocket(url) : nodeWebSocketFactory();
  Bun.gc(true);
  const before = process.memoryUsage();
  for (let index = 0; index < count; index++) {
    const socket = create(`ws://127.0.0.1:${port}`, {});
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => socket.send("x".repeat(bytes));
      socket.onmessage = () => resolve();
      socket.onerror = () => reject(new Error("Local socket failed"));
    });
    socket.onopen = null;
    socket.onmessage = null;
  }
  await Bun.sleep(100);
  Bun.gc(true);
  await Bun.sleep(100);
  Bun.gc(true);
  const after = process.memoryUsage();
  console.log(
    JSON.stringify({
      mode,
      count,
      bytes,
      before,
      after,
      rssDelta: after.rss - before.rss,
      externalDelta: after.external - before.external,
    }),
  );
} finally {
  for (const socket of sockets) socket.close();
  serverProcess.kill("SIGTERM");
}
