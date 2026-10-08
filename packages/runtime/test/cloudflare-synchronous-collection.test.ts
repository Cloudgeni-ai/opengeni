import { expect, test } from "bun:test";
import { Manifest } from "@openai/agents/sandbox";
import { CloudflareSandboxSession } from "@openai/agents-extensions/sandbox/cloudflare";
import { collectCloudflareCommandOutput } from "../src/sandbox/cloudflare-command-output";
import { executeSynchronousCommand } from "../src/sandbox/synchronous-command";
import type { ChannelASession } from "../src/sandbox/channel-a";

const encoder = new TextEncoder();
const exit = 'event: exit\ndata: {"exit_code":0}\n\n';
const output = (stream: "stdout" | "stderr", bytes: Uint8Array) =>
  `event: ${stream}\ndata: ${Buffer.from(bytes).toString("base64")}\n\n`;

function nativeResponse(bytes: Uint8Array, lost = false) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        if (lost) queueMicrotask(() => controller.error(new Error("native response lost")));
        else controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

async function fixture(reply: (source: string) => Response | Promise<Response>) {
  const requests: { path: string; method: string; argv: string[]; timeout_ms?: number }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (!path.endsWith("/exec")) return Response.json({});
      const body = (await request.json()) as { argv: string[]; timeout_ms?: number };
      const { argv } = body;
      requests.push({ path, method: request.method, ...body });
      return await reply(argv[2]!);
    },
  });
  const session = new CloudflareSandboxSession({
    state: {
      sandboxId: "sb-stream",
      workerUrl: server.url.origin,
      manifest: new Manifest({ root: "/workspace" }),
      environment: { ORIGINAL_ENV: "same" },
    },
  });
  return {
    session,
    requests,
    close: async () => {
      await session.close();
      server.stop(true);
    },
  };
}

test.each(["data", "getter"] as const)(
  "the pinned Cloudflare %s request override fails before dispatch",
  async (mode) => {
    const source = await fixture(() => nativeResponse(encoder.encode(exit)));
    let overrides = 0;
    const unexpected = () => {
      overrides++;
      throw new Error("must not invoke unexpected binding");
    };
    Object.defineProperty(
      source.session,
      "fetch",
      mode === "getter"
        ? { configurable: true, get: unexpected }
        : { configurable: true, value: unexpected },
    );
    try {
      await expect(
        executeSynchronousCommand(source.session, { cmd: "printf original" }),
      ).rejects.toMatchObject({ code: "synchronous_command_outcome_unknown" });
      expect(overrides).toBe(0);
      expect(source.requests).toHaveLength(0);
    } finally {
      Reflect.deleteProperty(source.session, "fetch");
      await source.close();
    }
  },
);

test("a replaced installed Cloudflare request binding cannot start another filesystem invocation", async () => {
  const source = await fixture(() => nativeResponse(encoder.encode(exit)));
  try {
    await executeSynchronousCommand(source.session, { cmd: ":" });
    const installed = Object.getOwnPropertyDescriptor(source.session, "fetch")!;
    let overrides = 0;
    Object.defineProperty(source.session, "fetch", {
      configurable: true,
      value: () => {
        overrides++;
        throw new Error("unexpected binding");
      },
    });
    try {
      await expect(
        executeSynchronousCommand(source.session, { cmd: "printf second" }),
      ).rejects.toMatchObject({ code: "synchronous_command_outcome_unknown" });
      expect(source.requests).toHaveLength(1);
      expect(overrides).toBe(0);
    } finally {
      Object.defineProperty(source.session, "fetch", installed);
    }
  } finally {
    await source.close();
  }
});

test("the native Worker protocol preserves multiline CRLF frames and UTF8 split across events and transport chunks", async () => {
  const stdout = Buffer.from("🙂 original\n");
  const stderr = Buffer.from("  diagnostic\n\n");
  const base64 = stderr.toString("base64");
  const frames =
    output("stdout", stdout.subarray(0, 2)) +
    output("stdout", stdout.subarray(2)) +
    `event: stderr\r\ndata: ${base64.slice(0, 8)}\r\ndata: ${base64.slice(8)}\r\n\r\n` +
    exit;
  const bytes = encoder.encode(frames);
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    }),
  );
  expect(await collectCloudflareCommandOutput(response)).toEqual({
    stdout: stdout.toString(),
    stderr: stderr.toString(),
    exitCode: 0,
  });
});

const malformed = [
  ["invalid stdout UTF8", output("stdout", new Uint8Array([0xff])) + exit],
  ["incomplete stderr UTF8", output("stderr", new Uint8Array([0xf0, 0x9f])) + exit],
  ["invalid base64", "event: stdout\ndata: !!invalid!!\n\n" + exit],
  ["unterminated output frame", exit + "event: stdout\ndata: eA=="],
  ["unsafe exit", 'event: exit\ndata: {"exit_code":9007199254740992}\n\n'],
  ["unknown event", "event: unexplained\ndata: lost\n\n" + exit],
] as const;

test.each(malformed)(
  "the actual Cloudflare SDK rejects %s without replay",
  async (_name, frames) => {
    const source = await fixture(() => nativeResponse(encoder.encode(frames)));
    try {
      await expect(
        executeSynchronousCommand(source.session, { cmd: "original", maxOutputTokens: 1 }),
      ).rejects.toMatchObject({ code: "synchronous_command_outcome_unknown" });
      expect(source.requests).toHaveLength(1);
    } finally {
      await source.close();
    }
  },
);

test.each(["protocol UTF8", "response loss"] as const)(
  "native Worker %s cannot prove output EOF",
  async (mode) => {
    const bytes =
      mode === "protocol UTF8"
        ? new Uint8Array([0xff])
        : encoder.encode(output("stdout", encoder.encode("original")) + exit);
    // Use the response transport directly so a broken stream is not repaired by
    // the local HTTP server. The same collector sees this original tee contract.
    expect(
      await collectCloudflareCommandOutput(nativeResponse(bytes, mode === "response loss")),
    ).toBeNull();
  },
);

test("concurrent filesystem and ordinary Cloudflare requests keep their original invocation and presentation", async () => {
  const source = await fixture(async (command) => {
    const child = Bun.spawn(["/bin/sh", "-c", command], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).arrayBuffer(),
      child.exited,
    ]);
    return nativeResponse(
      encoder.encode(
        output("stdout", new Uint8Array(stdout)) +
          output("stderr", new Uint8Array(stderr)) +
          `event: exit\ndata: {"exit_code":${code}}\n\n`,
      ),
    );
  });
  try {
    const [first, ordinary, second] = await Promise.all([
      executeSynchronousCommand(source.session, {
        cmd: "sleep 0.03; printf first; printf one >&2",
        maxOutputTokens: 1,
      }),
      source.session.execCommand({
        cmd: "printf ordinary; printf diagnostic >&2",
        maxOutputTokens: 1,
      }),
      executeSynchronousCommand(source.session, {
        cmd: "printf second; printf two >&2",
        maxOutputTokens: 1,
      }),
    ]);
    expect(first).toMatchObject({ stdout: "first", stderr: "one", exitCode: 0 });
    expect(second).toMatchObject({ stdout: "second", stderr: "two", exitCode: 0 });
    expect(ordinary).not.toStartWith("Native output receipt:");
    expect((source.session as ChannelASession).getSynchronousCommandOutput!(ordinary)).toBeNull();
    expect(source.requests).toHaveLength(3);
    for (const request of source.requests) {
      expect(request.path).toBe("/v1/sandbox/sb-stream/exec");
      expect(request.method).toBe("POST");
      expect(request.argv.slice(0, 2)).toEqual(["/bin/sh", "-lc"]);
      expect(request.argv[2]).toContain("ORIGINAL_ENV='same'");
    }
  } finally {
    await source.close();
  }
});

test("original Cloudflare request errors remain the cause of unknown completion and are not retried", async () => {
  const source = await fixture(() => new Response("native request failed", { status: 503 }));
  try {
    const error = await executeSynchronousCommand(source.session, { cmd: "original" }).catch(
      (cause) => cause,
    );
    expect(error).toMatchObject({
      code: "synchronous_command_outcome_unknown",
      cause: { name: "SandboxProviderError" },
    });
    expect(source.requests).toHaveLength(1);
  } finally {
    await source.close();
  }
});

test("the original Cloudflare request timeout aborts the one request and preserves command timeout arguments", async () => {
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const source = await fixture(async () => {
    entered.resolve();
    await release.promise;
    return nativeResponse(encoder.encode(exit));
  });
  source.session.state.timeouts = { requestTimeoutMs: 50, execTimeoutMs: 1234 };
  try {
    const pending = executeSynchronousCommand(source.session, { cmd: "original" }).catch(
      (error) => error,
    );
    await entered.promise;
    const error = await pending;
    expect(error).toMatchObject({
      code: "synchronous_command_outcome_unknown",
      cause: { name: "SandboxProviderError" },
    });
    expect(source.requests).toHaveLength(1);
    expect(source.requests[0]?.timeout_ms).toBe(1234);
  } finally {
    release.resolve();
    await source.close();
  }
});
