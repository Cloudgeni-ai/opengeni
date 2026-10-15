import { connect } from "node:net";
import { randomUUID } from "node:crypto";

/** Separates actual command completion from transport shutdown/EOF latency. */
export function measuredExec(vsock: string, script: string, timeoutMs = 120000, closeAtCompletion = false) {
  return new Promise<{ out: string; ms: number; firstByteMs: number; doneMs: number; lastByteMs: number; status: number }>((resolve, reject) => {
    const started = performance.now();
    const marker = `wake-done-${randomUUID()}`;
    const markerPattern = new RegExp(`${marker}:(\\d+)\\n`);
    const socket = connect(vsock);
    let handshake = "";
    let connected = false;
    let out = "";
    let firstByteMs = 0;
    let lastByteMs = 0;
    let doneMs = 0;
    let status = -1;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`measured exec timed out: firstByteMs=${firstByteMs}, doneMs=${doneMs}, bytes=${out.length}`)); }, timeoutMs);
    socket.on("connect", () => socket.write("CONNECT 52\n"));
    socket.on("data", (chunk: Buffer) => {
      let text = chunk.toString();
      if (!connected) {
        handshake += text;
        const newline = handshake.indexOf("\n");
        if (newline < 0) return;
        if (!handshake.startsWith("OK")) { socket.destroy(); reject(new Error("vsock handshake failed")); return; }
        connected = true;
        text = handshake.slice(newline + 1);
        socket.write(`${script}\nprintf '\\n${marker}:%s\\n' "$?"\nexit\n`);
      }
      if (text.length) {
        lastByteMs = performance.now() - started;
        if (!firstByteMs) firstByteMs = lastByteMs;
        out += text;
        const done = markerPattern.exec(out);
        if (done && !doneMs) {
          doneMs = lastByteMs; status = Number(done[1]);
          if (closeAtCompletion) socket.destroy();
        }
      }
    });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    socket.on("close", () => {
      clearTimeout(timer);
      if (!doneMs) { reject(new Error("guest closed before command completion marker")); return; }
      resolve({ out, ms: performance.now() - started, firstByteMs, doneMs, lastByteMs, status });
    });
  });
}
