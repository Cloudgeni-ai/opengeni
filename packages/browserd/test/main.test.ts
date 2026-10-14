import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { computerRuntimeConfig } from "../src/main";

test("desktop configuration selects CUA on Mac and Windows without changing the Linux host desktop", () => {
  expect(computerRuntimeConfig({}, "darwin")).toEqual({
    computerBackend: "cua",
    computerEnvironmentMode: "existing",
  });
  expect(computerRuntimeConfig({}, "linux")).toEqual({
    computerBackend: "native",
    computerEnvironmentMode: "existing",
  });
  expect(computerRuntimeConfig({}, "win32")).toEqual({
    computerBackend: "cua",
    computerEnvironmentMode: "existing",
  });
});

test("explicit desktop and backend choices remain authoritative", () => {
  expect(
    computerRuntimeConfig(
      { OPENGENI_BROWSERD_COMPUTER_ENVIRONMENT_MODE: "isolated_linux" },
      "linux",
    ),
  ).toEqual({ computerBackend: "cua", computerEnvironmentMode: "isolated_linux" });
  expect(
    computerRuntimeConfig({ OPENGENI_BROWSERD_COMPUTER_ENVIRONMENT_MODE: "existing" }, "linux"),
  ).toEqual({ computerBackend: "native", computerEnvironmentMode: "existing" });
  for (const platform of ["darwin", "linux", "win32"] as const) {
    expect(
      computerRuntimeConfig({ OPENGENI_BROWSERD_COMPUTER_BACKEND: "native" }, platform),
    ).toEqual({ computerBackend: "native", computerEnvironmentMode: "existing" });
  }
  expect(
    computerRuntimeConfig(
      {
        OPENGENI_BROWSERD_COMPUTER_BACKEND: "cua",
        OPENGENI_BROWSERD_COMPUTER_ENVIRONMENT_MODE: "existing",
      },
      "linux",
    ),
  ).toEqual({ computerBackend: "cua", computerEnvironmentMode: "existing" });
  expect(computerRuntimeConfig({ OPENGENI_BROWSERD_COMPUTER_BACKEND: "cua" }, "win32")).toEqual({
    computerBackend: "cua",
    computerEnvironmentMode: "existing",
  });
  expect(computerRuntimeConfig({ OPENGENI_BROWSERD_COMPUTER_BACKEND: "cua" }, "linux")).toEqual({
    computerBackend: "cua",
    computerEnvironmentMode: "existing",
  });
});

test("invalid desktop configuration is rejected instead of selecting a fallback", () => {
  expect(() =>
    computerRuntimeConfig({ OPENGENI_BROWSERD_COMPUTER_BACKEND: "invalid" }, "darwin"),
  ).toThrow("OPENGENI_BROWSERD_COMPUTER_BACKEND is invalid");
  expect(() =>
    computerRuntimeConfig({ OPENGENI_BROWSERD_COMPUTER_ENVIRONMENT_MODE: "invalid" }, "linux"),
  ).toThrow("OPENGENI_BROWSERD_COMPUTER_ENVIRONMENT_MODE is invalid");
});

test("browserd entrypoint reads an owner-only token, becomes healthy, and drains on SIGTERM", async () => {
  const directory = await mkdtemp("/tmp/ogb-main-");
  const tokenFile = join(directory, "admin-token");
  await writeFile(tokenFile, `admin.${"a".repeat(48)}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts")], {
    env: {
      ...process.env,
      OPENGENI_BROWSERD_COMPUTER_BACKEND: undefined,
      OPENGENI_BROWSERD_COMPUTER_ENVIRONMENT_MODE: undefined,
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

test("browserd with a parent lifeline drains when its parent's end of stdin closes", async () => {
  // Short paths: agent-browser sockets must fit the Unix socket path limit.
  const directory = await mkdtemp("/tmp/ogb-ml-");
  const tokenFile = join(directory, "admin-token");
  await writeFile(tokenFile, `admin.${"a".repeat(48)}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  const environment = {
    ...process.env,
    OPENGENI_BROWSERD_COMPUTER_BACKEND: undefined,
    OPENGENI_BROWSERD_COMPUTER_ENVIRONMENT_MODE: undefined,
    OPENGENI_BROWSERD_ROOT: join(directory, "state"),
    OPENGENI_BROWSERD_SOCKET_ROOT: join(directory, "s1"),
    OPENGENI_BROWSERD_ADMIN_TOKEN_FILE: tokenFile,
    OPENGENI_BROWSERD_HOSTNAME: "127.0.0.1",
    OPENGENI_BROWSERD_PORT: "0",
  };
  const entrypoint = join(import.meta.dir, "../src/main.ts");
  // Without the opt-in, a closed stdin (a service manager's /dev/null, a
  // detached container) must not stop the controller.
  const standalone = Bun.spawn([process.execPath, entrypoint], {
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const lifeline = Bun.spawn([process.execPath, entrypoint], {
    env: {
      ...environment,
      OPENGENI_BROWSERD_ROOT: join(directory, "state-lifeline"),
      OPENGENI_BROWSERD_SOCKET_ROOT: join(directory, "s2"),
      OPENGENI_BROWSERD_PARENT_LIFELINE: "stdin",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const standaloneReady = JSON.parse(await readLine(standalone.stdout)) as { port: number };
    const ready = JSON.parse(await readLine(lifeline.stdout)) as { port: number };
    expect((await fetch(`http://127.0.0.1:${ready.port}/healthz`)).status).toBe(200);
    // Bytes on the lifeline are ignored; only its end stops the controller.
    lifeline.stdin.write("ignored\n");
    await lifeline.stdin.flush();
    expect((await fetch(`http://127.0.0.1:${ready.port}/healthz`)).status).toBe(200);
    await lifeline.stdin.end();
    expect(await withTimeout(lifeline.exited, 3_000, "browserd outlived its parent")).toBe(0);
    expect(await new Response(lifeline.stderr).text()).toBe("");
    expect((await fetch(`http://127.0.0.1:${standaloneReady.port}/healthz`)).status).toBe(200);
    expect(standalone.exitCode).toBeNull();
  } finally {
    standalone.kill("SIGKILL");
    lifeline.kill("SIGKILL");
    await Promise.all([standalone.exited, lifeline.exited]);
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
