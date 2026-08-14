import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

test("browserd entrypoint reads an owner-only token, becomes healthy, and drains on SIGTERM", async () => {
  const directory = await mkdtemp("/tmp/ogb-main-");
  const tokenFile = join(directory, "admin-token");
  await writeFile(tokenFile, `admin.${"a".repeat(48)}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts")], {
    env: {
      ...process.env,
      OPENGENI_BROWSERD_ROOT: join(directory, "state"),
      OPENGENI_BROWSERD_SOCKET_ROOT: join(directory, "sockets"),
      OPENGENI_BROWSERD_ADMIN_TOKEN_FILE: tokenFile,
      OPENGENI_BROWSERD_HOSTNAME: "127.0.0.1",
      OPENGENI_BROWSERD_PORT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const ready = JSON.parse(await readLine(child.stdout)) as {
      service: string;
      status: string;
      port: number;
    };
    expect(ready).toMatchObject({ service: "opengeni-browserd", status: "ready" });
    const health = await fetch(`http://127.0.0.1:${ready.port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
    child.kill("SIGTERM");
    expect(await withTimeout(child.exited, 3_000, "browserd did not stop")).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "browserd entrypoint rejects an admin token readable by other users",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-main-mode-");
    const tokenFile = join(directory, "admin-token");
    await writeFile(tokenFile, `admin.${"a".repeat(48)}\n`, { mode: 0o644 });
    await chmod(tokenFile, 0o644);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts")], {
      env: {
        ...process.env,
        OPENGENI_BROWSERD_ROOT: join(directory, "state"),
        OPENGENI_BROWSERD_ADMIN_TOKEN_FILE: tokenFile,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      expect(await withTimeout(child.exited, 3_000, "invalid browserd did not exit")).toBe(1);
      expect(await new Response(child.stdout).text()).toBe("");
      expect(await new Response(child.stderr).text()).toBe(
        "opengeni-browserd failed: Error: browserd admin token file must be owner-only\n",
      );
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
);

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes <= 8_192) {
      const next = await withTimeout(reader.read(), 3_000, "browserd emitted no ready line");
      if (next.done) break;
      chunks.push(next.value);
      bytes += next.value.byteLength;
      const text = Buffer.concat(chunks).toString("utf8");
      const newline = text.indexOf("\n");
      if (newline >= 0) return text.slice(0, newline);
    }
    throw new Error("browserd ready line is missing or too large");
  } finally {
    reader.releaseLock();
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
