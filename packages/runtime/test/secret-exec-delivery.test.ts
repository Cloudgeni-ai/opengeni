/**
 * W1 delivery on a real `local` sandbox (dossier §13.3 DL-1, DL-4..8, PF-1,
 * SEC-4): the model-facing `exec_command` / `write_stdin` / `apply_patch` /
 * `view_image` wrappers resolve references through a SecretResolver, the
 * routing session delivers values through a sourced-then-deleted env file,
 * and every provider-visible command text holds only `${OPENGENI_SECRET_n}`
 * names. Values: the stub resolver (F2's hosted resolver is a drop-in).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Tool } from "@openai/agents";
import { shell } from "@openai/agents/sandbox";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createStaticSecretResolver } from "@opengeni/vaults/testing";
import { testSettings } from "@opengeni/testing";
import { createSandboxClientForBackend } from "../src/index";
import {
  cancellableShellCommand,
  createTurnToolCancellationController,
  wrapCapabilityToolsForTurnCancellation,
} from "../src/sandbox/turn-tool-cancellation";
import { RoutingSandboxSession } from "../src/sandbox/routing/routing-session";
import { parseExecResponseBanner } from "../src/sandbox/exec-banner";
import {
  SECRET_FILE_ROOT,
  prepareSecretExec,
  secretScopeFor,
} from "../src/sandbox/secret-delivery";

const runContext = {} as never;
const CANARY = "OGCANARY-w1-7f3a 'single' \"double\" $HOME `id` $(id) \\ * {a,b}\nsecond line ";
const VALUES = {
  Canary: CANARY,
  Plain: "plain-w1-value",
  Big: "x".repeat(101 * 1024),
  Mid: "y".repeat(90 * 1024),
  Mid2: "z".repeat(90 * 1024),
  Mid3: "w".repeat(90 * 1024),
  Nul: "a\u0000b",
};

type LocalSession = {
  close(): Promise<void>;
  state: { workspaceRootPath: string };
  execCommand(args: { cmd: string } & Record<string, unknown>): Promise<string>;
  exec?(args: { cmd: string } & Record<string, unknown>): Promise<unknown>;
  writeStdin(
    args: { sessionId: number; chars?: string } & Record<string, unknown>,
  ): Promise<string>;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const sessions: LocalSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(async (session) => await session.close()));
});

async function harness(options: { enabled?: boolean; kind?: string } = {}) {
  const settings = testSettings({ sandboxBackend: "local", webSearchEnabled: false });
  const client = createSandboxClientForBackend("local", settings) as {
    create(manifest?: unknown): Promise<LocalSession>;
  };
  const local = await client.create({});
  sessions.push(local);
  // Spy on everything the provider receives.
  const provider: { commands: string[]; stdin: string[] } = { commands: [], stdin: [] };
  // The local session's execCommand delegates to exec: spy on exec only.
  const rawExec = local.exec!.bind(local);
  local.exec = async (args) => {
    provider.commands.push(args.cmd);
    return await rawExec(args);
  };
  const writeStdin = local.writeStdin.bind(local);
  local.writeStdin = async (args) => {
    provider.stdin.push(args.chars ?? "");
    return await writeStdin(args);
  };
  const adopted: Array<string | undefined> = [];
  const routing = new RoutingSandboxSession({
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => ({
      session: local as never,
      sandboxId: null,
      kind: options.kind ?? "local",
      leaseEpoch: 1,
      providerInstanceId: "instance",
      activeEpoch: 0,
    }),
    beforeMutation: async () => ({}),
    afterMutation: async () => undefined,
    adoptProcessAsBackgroundCommand: async (input) => {
      adopted.push(input.command);
    },
  });
  await routing.prime();
  const resolver = createStaticSecretResolver(VALUES, { enabled: options.enabled ?? true });
  const controller = createTurnToolCancellationController(undefined, { secretResolver: resolver });
  const capability = shell();
  wrapCapabilityToolsForTurnCancellation(capability as never, controller);
  const tools = capability
    .clone()
    .bind(routing as never)
    .tools() as Tool<unknown>[];
  const fn = (name: string) =>
    tools.find(
      (tool): tool is Extract<Tool<unknown>, { type: "function" }> =>
        tool.type === "function" && tool.name === name,
    )!;
  const exec = fn("exec_command");
  const write = fn("write_stdin");
  async function run(cmd: string, extra: Record<string, unknown> = {}): Promise<string> {
    let current = (await exec.invoke(
      runContext,
      JSON.stringify({ cmd, tty: false, yield_time_ms: 2_000, ...extra }),
      { toolCall: { callId: `call_${crypto.randomUUID()}` } } as never,
    )) as string;
    let output = current;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const banner = parseExecResponseBanner(current);
      if (banner.kind !== "running") break;
      current = (await write.invoke(
        runContext,
        JSON.stringify({ session_id: banner.sessionId, chars: "", yield_time_ms: 250 }),
      )) as string;
      output += `\n${current}`;
    }
    return output;
  }
  const scopeDir = `${SECRET_FILE_ROOT}/${secretScopeFor(resolver)}`;
  return { local, routing, resolver, controller, provider, adopted, run, exec, write, scopeDir };
}

function expectNoCanary(texts: readonly string[]): void {
  for (const text of texts) {
    expect(text.includes("OGCANARY")).toBe(false);
    expect(text.includes(VALUES.Plain)).toBe(false);
  }
}

describe("secret exec delivery on the local backend", () => {
  test("DL-1: the value reaches the command; the provider text holds only names", async () => {
    const h = await harness();
    const output = await h.run('printf %s "{{secret:Canary}}" | sha256sum');
    expect(output).toContain(sha256(CANARY));
    const main = h.provider.commands.filter((cmd) => cmd.includes("sha256sum"));
    expect(main).toHaveLength(1);
    expect(main[0]).toContain('printf %s "${OPENGENI_SECRET_0}" | sha256sum');
    expect(main[0]).toContain(`${h.scopeDir}/env-`);
    expectNoCanary(h.provider.commands);
    // The env file travelled over stdin (base64), never as command text.
    expect(h.provider.stdin.join("")).not.toContain("OGCANARY");
    expect(h.resolver.calls).toEqual([
      { refs: ["{{secret:Canary}}"], use: expect.objectContaining({ surface: "shell" }) },
    ]);
  }, 60_000);

  test("every quoting context delivers the exact bytes (bash on the box)", async () => {
    const h = await harness();
    const output = await h.run(
      [
        "a={{secret:Canary}}",
        "b='{{secret:Canary}}'",
        'c="pre-{{secret:Plain}}-post"',
        "cat > /tmp/w1-hd-$$ <<'EOF'\n{{secret:Canary}} $HOME\nEOF",
        "d=$(cat /tmp/w1-hd-$$); rm -f /tmp/w1-hd-$$",
        'printf "%s|%s|%s|%s" "$a" "$b" "$c" "$d" | sha256sum',
      ].join("\n"),
    );
    expect(output).toContain(
      sha256(`${CANARY}|${CANARY}|pre-${VALUES.Plain}-post|${CANARY} $HOME`.replace(/\n+$/, "")),
    );
    expectNoCanary(h.provider.commands);
  }, 60_000);

  test("DL-7 / SEC-4: env file is 0600 in a 0700 directory and gone after success and failure", async () => {
    const h = await harness();
    const exec = h.local.exec!;
    const observed: Array<{ file: string; mode: string; dirMode: string }> = [];
    h.local.exec = async (args) => {
      const match = /\. '([^']+\/env-[0-9a-f-]+)'/.exec(args.cmd);
      if (match) {
        observed.push({
          file: match[1]!,
          mode: (statSync(match[1]!).mode & 0o777).toString(8),
          dirMode: (statSync(h.scopeDir).mode & 0o777).toString(8),
        });
      }
      return await exec(args);
    };
    await h.run("true {{secret:Plain}}");
    await h.run("printf %s {{secret:Plain}} >/dev/null; false");
    expect(observed).toHaveLength(2);
    for (const entry of observed) {
      expect(entry.mode).toBe("600");
      expect(entry.dirMode).toBe("700");
      expect(existsSync(entry.file)).toBe(false);
    }
    await h.routing.clearSecretFilesForAttempt();
    expect(existsSync(h.scopeDir)).toBe(false);
  }, 60_000);

  test("DL-4: caps and binary values fail before dispatch with a secretfile hint", async () => {
    const h = await harness();
    for (const [cmd, code] of [
      ["printf %s {{secret:Big}}", "too_large"],
      ["printf %s {{secret:Mid}}{{secret:Mid2}}{{secret:Mid3}}", "too_large"],
      ["printf %s {{secret:Nul}}", "binary_value"],
      ["printf %s {{secret:Missing}}", "not_found"],
      ["printf %s {{secret:}}", "invalid_reference"],
    ] as const) {
      const output = await h.run(cmd);
      const parsed = JSON.parse(output) as {
        error: string;
        failures: Array<{ code: string; message: string }>;
      };
      expect(parsed.error).toBe("secret_reference_error");
      expect(parsed.failures[0]?.code).toBe(code);
      if (code === "too_large" || code === "binary_value")
        expect(parsed.failures[0]?.message).toContain("secretfile");
    }
    expect(h.provider.commands).toEqual([]);
    expect(h.provider.stdin).toEqual([]);
  }, 60_000);

  test("DL-8 / PF-1: a command without references is byte-identical and the fast path is cheap", async () => {
    const h = await harness();
    const command = "printf '%s' 'no references here' {{notasecret}}";
    await h.run(command);
    expect(h.provider.commands).toHaveLength(1);
    const marker = /\/tmp\/opengeni-turn-shell\/[0-9a-f-]{36}/.exec(h.provider.commands[0]!)?.[0];
    expect(marker).toBeDefined();
    expect(h.provider.commands[0]).toBe(cancellableShellCommand(command, marker!));
    expect(h.resolver.calls).toEqual([]);
    const samples: number[] = [];
    for (let index = 0; index < 20_000; index += 1) {
      const started = performance.now();
      await prepareSecretExec(command, {
        resolver: h.resolver,
        dialect: "posix",
        use: { surface: "shell", toolName: "exec_command" },
      });
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    console.log(`PF-1 no-reference wrapper overhead p95=${(p95 * 1000).toFixed(2)}us`);
    expect(p95).toBeLessThan(1);
  }, 60_000);

  test("capability off: references pass through literally (Q-35)", async () => {
    const h = await harness({ enabled: false });
    const output = await h.run("printf %s '{{secret:Canary}}'");
    expect(output).toContain("{{secret:Canary}}");
    expect(h.resolver.calls).toEqual([]);
  }, 60_000);

  test("escaped references reach the command as literal text", async () => {
    const h = await harness();
    const output = await h.run("printf %s '\\{{secret:Canary}}'");
    expect(output).toContain("{{secret:Canary}}");
    expect(h.resolver.calls).toEqual([]);
  }, 60_000);

  test("DL-5: secretfile is a 0600 file in the 0700 attempt directory, removed at attempt end", async () => {
    const h = await harness();
    const output = await h.run(
      'f={{secretfile:Canary}}; stat -c "mode=%a" "$f"; stat -c "dir=%a" "$(dirname "$f")"; sha256sum < "$f"; echo "path=$f"',
    );
    expect(output).toContain("mode=600");
    expect(output).toContain("dir=700");
    expect(output).toContain(sha256(CANARY));
    const path = /path=(\S+)/.exec(output)?.[1];
    expect(path?.startsWith(`${h.scopeDir}/`)).toBe(true);
    expect(readFileSync(path!, "utf8")).toBe(CANARY);
    expectNoCanary(h.provider.commands);
    // Attempt end: worker finalization calls the controller after the drain.
    await h.controller.waitForQuiescence();
    await h.controller.clearSecretFiles!();
    expect(existsSync(path!)).toBe(false);
    expect(existsSync(h.scopeDir)).toBe(false);
  }, 60_000);

  test("DL-5: write_stdin substitutes values at the provider call only", async () => {
    const h = await harness();
    const started = (await h.exec.invoke(
      runContext,
      JSON.stringify({
        cmd: 'IFS= read -r v; printf %s "$v" | sha256sum',
        tty: false,
        yield_time_ms: 300,
      }),
    )) as string;
    const banner = parseExecResponseBanner(started);
    expect(banner.kind).toBe("running");
    if (banner.kind !== "running") return;
    let output = (await h.write.invoke(
      runContext,
      JSON.stringify({
        session_id: banner.sessionId,
        chars: "{{secret:Plain}}\n",
        yield_time_ms: 2_000,
      }),
    )) as string;
    for (
      let attempt = 0;
      attempt < 20 && parseExecResponseBanner(output).kind === "running";
      attempt++
    ) {
      output += (await h.write.invoke(
        runContext,
        JSON.stringify({ session_id: banner.sessionId, chars: "", yield_time_ms: 250 }),
      )) as string;
    }
    expect(output).toContain(sha256(VALUES.Plain));
    expect(h.provider.stdin).toContain(`${VALUES.Plain}\n`);
    expect(h.resolver.calls.map((call) => call.use.surface)).toEqual(["stdin"]);
    expectNoCanary(h.provider.commands);
  }, 60_000);

  test("DL-6: a background command records references while the process gets values", async () => {
    const h = await harness({ kind: "modal" });
    const out = `${h.local.state.workspaceRootPath}/w1-bg-${crypto.randomUUID()}`;
    const command = `sleep 2; printf %s "{{secret:Canary}}" > '${out}'`;
    const first = (await h.exec.invoke(
      runContext,
      JSON.stringify({ cmd: command, tty: false, yield_time_ms: 300 }),
      { toolCall: { callId: "call_bg" } } as never,
    )) as string;
    expect(first).toContain("session ID");
    expect(h.adopted).toEqual([command]);
    for (let attempt = 0; attempt < 50 && !existsSync(out); attempt += 1) await Bun.sleep(100);
    await Bun.sleep(200);
    expect(readFileSync(out, "utf8")).toBe(CANARY);
    expectNoCanary(h.provider.commands);
  }, 60_000);
});

describe("apply_patch and view_image wrappers", () => {
  function fakeTools(names: string[]) {
    const seen: Record<string, string[]> = {};
    const tools = names.map((name) => ({
      type: "function" as const,
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      strict: false,
      invoke: async (_context: unknown, input: string) => {
        (seen[name] ??= []).push(input);
        return "ok";
      },
    }));
    return { tools, seen };
  }

  test("DL-5: apply_patch resolves content lines, never header paths", async () => {
    const resolver = createStaticSecretResolver(VALUES);
    const files: Array<{ scope: string; paths: string[] }> = [];
    const session = {
      writeSecretFiles: async (scope: string, list: ReadonlyArray<{ path: string }>) => {
        files.push({ scope, paths: list.map((file) => file.path) });
      },
    };
    const controller = createTurnToolCancellationController(undefined, {
      secretResolver: resolver,
    });
    const { tools, seen } = fakeTools(["apply_patch", "view_image"]);
    const wrapped = controller.wrapTools(tools, session as never) as typeof tools;
    const patch = [
      "*** Begin Patch",
      "*** Add File: cfg/{{secret:Plain}}.env",
      "+TOKEN={{secret:Plain}}",
      "+KEYFILE={{secretfile:Canary}}",
      "+LITERAL=\\{{secret:Plain}}",
      "*** End Patch",
    ].join("\n");
    const modelInput = JSON.stringify({ patch });
    expect(await wrapped[0]!.invoke(runContext, modelInput, undefined as never)).toBe("ok");
    const sent = JSON.parse(seen.apply_patch![0]!) as { patch: string };
    expect(sent.patch).toContain("*** Add File: cfg/{{secret:Plain}}.env");
    expect(sent.patch).toContain(`+TOKEN=${VALUES.Plain}`);
    expect(sent.patch).toContain(`+KEYFILE=${SECRET_FILE_ROOT}/`);
    expect(sent.patch).toContain("+LITERAL={{secret:Plain}}");
    expect(files).toHaveLength(1);
    // The model-facing input object is untouched.
    expect(modelInput).toContain("+TOKEN={{secret:Plain}}");

    expect(
      await wrapped[1]!.invoke(
        runContext,
        JSON.stringify({ path: "{{secretfile:Canary}}" }),
        undefined as never,
      ),
    ).toBe("ok");
    expect(
      (JSON.parse(seen.view_image![0]!) as { path: string }).path.startsWith(SECRET_FILE_ROOT),
    ).toBe(true);
    const refused = (await wrapped[1]!.invoke(
      runContext,
      JSON.stringify({ path: "{{secret:Canary}}" }),
      undefined as never,
    )) as string;
    expect(JSON.parse(refused).failures[0].code).toBe("invalid_reference");
    expect(seen.view_image).toHaveLength(1);
  });

  test("hosted apply_patch editor operations resolve the diff only", async () => {
    const resolver = createStaticSecretResolver(VALUES);
    const controller = createTurnToolCancellationController(undefined, {
      secretResolver: resolver,
    });
    const operations: unknown[] = [];
    const editor = {
      createFile: async (operation: unknown) => {
        operations.push(operation);
      },
      updateFile: async (operation: unknown) => {
        operations.push(operation);
      },
      deleteFile: async (operation: unknown) => {
        operations.push(operation);
      },
    };
    const [tool] = controller.wrapTools([
      { type: "apply_patch", name: "apply_patch", editor },
    ]) as Array<{ editor: typeof editor }>;
    await tool!.editor.createFile({
      type: "create_file",
      path: "{{secret:Plain}}",
      diff: "+v={{secret:Plain}}\n",
    });
    expect(operations).toEqual([
      { type: "create_file", path: "{{secret:Plain}}", diff: `+v=${VALUES.Plain}\n` },
    ]);
  });
});
