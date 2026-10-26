/**
 * Credential profiles at the exec boundary (docs/secrets.md, "Credential
 * profiles"): profile variables reach the command's process through the
 * secret carry, the command text and the tool arguments stay unchanged,
 * variables the command sets itself win, a failing entry is skipped with a
 * note, and the built-in git helper hands GH_TOKEN to git. Every value here
 * is fake.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Tool } from "@openai/agents";
import { Manifest, shell } from "@openai/agents/sandbox";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SecretReferenceError,
  type EffectiveCredentialProfile,
  type SecretResolver,
} from "@opengeni/contracts";
import { createStaticSecretResolver } from "@opengeni/vaults/testing";
import { testSettings } from "@opengeni/testing/settings";
import { createSandboxClientForBackend } from "../src/index";
import {
  createTurnToolCancellationController,
  wrapCapabilityToolsForTurnCancellation,
} from "../src/sandbox/turn-tool-cancellation";
import { RoutingSandboxSession } from "../src/sandbox/routing/routing-session";
import { parseExecResponseBanner } from "../src/sandbox/exec-banner";
import {
  CREDENTIAL_PROFILE_GIT_HELPER,
  createCredentialEnvironment,
  credentialProfileGitHelperEnvironment,
  credentialProfileNoteText,
  withCredentialProfileNotes,
} from "../src/sandbox/credential-profile-delivery";
import {
  SECRET_FILE_ROOT,
  bindSecretCarryToDispatch,
  prepareSecretExec,
  runWithSecretCarry,
  secretEnvFileContent,
  secretExecCarryFor,
  secretScopeFor,
} from "../src/sandbox/secret-delivery";

/** A secret reference, assembled so no tool on the way resolves it early. */
const ref = (path: string) => ["{", "{secret:", path, "}}"].join("");

const VALUES = {
  "cloud-auth/GITHUB_TOKEN/value": "ghp_fakeProfileToken0001",
  "cloud-auth/AZURE_CLIENT_SECRET/value": "fake-azure-secret 'quoted' $HOME `id`",
  Plain: "plain-profile-value",
};
const SHELL = { surface: "shell", toolName: "exec_command" } as const;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function profile(entries: Array<[string, string]>, gitHelper = false): EffectiveCredentialProfile {
  return {
    entries: entries.map(([name, reference]) => ({
      name,
      reference,
      source: { scope: "workspace" as const, sessionId: null },
    })),
    gitHelper,
  };
}

function environmentFor(
  value: EffectiveCredentialProfile | null,
  resolver: SecretResolver = createStaticSecretResolver(VALUES),
  extra: { onValuesDelivered?: (values: readonly string[]) => void } = {},
) {
  let loads = 0;
  const credentials = createCredentialEnvironment({
    resolver,
    load: async () => {
      loads += 1;
      return value;
    },
    ...extra,
  });
  return { credentials, loads: () => loads };
}

/** A resolver that asks for approval for one reference and resolves the rest. */
function approvalResolver(approvalRaw: string) {
  const inner = createStaticSecretResolver(VALUES);
  const calls: string[][] = [];
  const resolver: SecretResolver = {
    principal: inner.principal,
    enabled: true,
    async resolve(refs, use) {
      calls.push(refs.map((r) => r.raw));
      if (refs.some((r) => r.raw === approvalRaw)) {
        throw new SecretReferenceError([
          { raw: approvalRaw, code: "approval_required", message: "needs approval" },
        ]);
      }
      return await inner.resolve(refs, use);
    },
  };
  return { resolver, calls };
}

describe("createCredentialEnvironment", () => {
  test("resolves every entry into the command environment and reports the values", async () => {
    const delivered: string[] = [];
    const { credentials } = environmentFor(
      profile([
        ["GH_TOKEN", ref("cloud-auth/GITHUB_TOKEN/value")],
        ["AZURE_CLIENT_SECRET", ref("cloud-auth/AZURE_CLIENT_SECRET/value")],
      ]),
      undefined,
      { onValuesDelivered: (values) => delivered.push(...values) },
    );
    const result = await credentials.forCommand(SHELL);
    expect(result.notes).toEqual([]);
    expect(result.env).toEqual({
      GH_TOKEN: VALUES["cloud-auth/GITHUB_TOKEN/value"],
      AZURE_CLIENT_SECRET: VALUES["cloud-auth/AZURE_CLIENT_SECRET/value"],
      // The names (never values) the profile delivered, for the CLI wrappers.
      OPENGENI_CREDENTIAL_PROFILE_VARS: "GH_TOKEN,AZURE_CLIENT_SECRET",
    });
    // The known-value masking hook (part B) sees every delivered value.
    expect(delivered.sort()).toEqual(
      [
        VALUES["cloud-auth/GITHUB_TOKEN/value"],
        VALUES["cloud-auth/AZURE_CLIENT_SECRET/value"],
      ].sort(),
    );
  });

  test("a failing entry is skipped with a note; the others are still delivered", async () => {
    const resolver = createStaticSecretResolver(VALUES);
    const { credentials } = environmentFor(
      profile([
        ["GH_TOKEN", ref("cloud-auth/GITHUB_TOKEN/value")],
        ["AZURE_TENANT_ID", ref("cloud-auth/MISSING/value")],
        ["BROKEN", "not a reference"],
      ]),
      resolver,
    );
    const result = await credentials.forCommand(SHELL);
    expect(result.env).toEqual({
      GH_TOKEN: VALUES["cloud-auth/GITHUB_TOKEN/value"],
      OPENGENI_CREDENTIAL_PROFILE_VARS: "GH_TOKEN",
    });
    expect(result.notes).toEqual([
      "credential profile skipped BROKEN (invalid reference), AZURE_TENANT_ID (secret not found)",
    ]);
    // One batch, then one retry without the failed reference.
    expect(resolver.calls.map((call) => call.refs.length)).toEqual([2, 1]);
    expect(JSON.stringify(result.notes)).not.toContain("ghp_");
  });

  test("an approval request is asked once per attempt and its note is shown once", async () => {
    const approval = ref("cloud-auth/AZURE_CLIENT_SECRET/value");
    const { resolver, calls } = approvalResolver(approval);
    const { credentials } = environmentFor(
      profile([
        ["GH_TOKEN", ref("cloud-auth/GITHUB_TOKEN/value")],
        ["AZURE_CLIENT_SECRET", approval],
      ]),
      resolver,
    );
    const first = await credentials.forCommand(SHELL);
    const second = await credentials.forCommand(SHELL);
    for (const result of [first, second]) {
      expect(result.env.GH_TOKEN).toBe(VALUES["cloud-auth/GITHUB_TOKEN/value"]);
      expect(result.env.AZURE_CLIENT_SECRET).toBeUndefined();
    }
    expect(first.notes).toEqual([
      "credential profile skipped AZURE_CLIENT_SECRET (waiting for the person's approval)",
    ]);
    // The same note is not repeated on every later command of the attempt.
    expect(second.notes).toEqual([]);
    expect(calls.filter((call) => call.includes(approval))).toHaveLength(1);
  });

  test("never fails: no profile, secrets off, or a profile that cannot be read", async () => {
    expect(await environmentFor(null).credentials.forCommand(SHELL)).toEqual({
      env: {},
      notes: [],
    });
    // An agent with secrets turned off runs without the profile, silently.
    const off = environmentFor(
      profile([["GH_TOKEN", ref("Plain")]]),
      createStaticSecretResolver(VALUES, { enabled: false }),
    );
    expect(await off.credentials.forCommand(SHELL)).toEqual({ env: {}, notes: [] });
    // A profile that cannot be read changes nothing for the command.
    const broken = createCredentialEnvironment({
      resolver: createStaticSecretResolver(VALUES),
      load: async () => {
        throw new Error("database unavailable");
      },
    });
    expect(await broken.forCommand(SHELL)).toEqual({ env: {}, notes: [] });
    const throwing: SecretResolver = {
      principal: createStaticSecretResolver({}).principal,
      enabled: true,
      resolve: async () => {
        throw new Error("resolver down");
      },
    };
    const down = environmentFor(profile([["GH_TOKEN", ref("Plain")]]), throwing);
    expect(await down.credentials.forCommand(SHELL)).toEqual({
      env: {},
      notes: ["credential profile skipped GH_TOKEN (could not be resolved)"],
    });
  });

  test("a slow or failed profile read never stalls a command", async () => {
    let clock = 1_000;
    let mode: "ok" | "hang" | "fail" = "ok";
    const credentials = createCredentialEnvironment({
      resolver: createStaticSecretResolver(VALUES),
      load: async () => {
        if (mode === "hang") return await new Promise<never>(() => undefined);
        if (mode === "fail") throw new Error("pool exhausted");
        return profile([["GH_TOKEN", ref("Plain")]]);
      },
      profileTtlMs: 5_000,
      loadTimeoutMs: 50,
      now: () => clock,
    });
    // Nothing read yet and the database hangs: run without a profile, no note.
    mode = "hang";
    const started = Date.now();
    expect(await credentials.forCommand(SHELL)).toEqual({ env: {}, notes: [] });
    expect(Date.now() - started).toBeLessThan(2_000);
    // Once a profile was read, a hanging or failing read keeps using it.
    clock += 5_000;
    mode = "ok";
    expect((await credentials.forCommand(SHELL)).env.GH_TOKEN).toBe(VALUES.Plain);
    for (const next of ["hang", "fail"] as const) {
      clock += 5_000;
      mode = next;
      const result = await credentials.forCommand(SHELL);
      expect(result.env.GH_TOKEN).toBe(VALUES.Plain);
      expect(result.notes).toEqual([]);
    }
  });

  test("a password manager that does not answer skips the entries with a note", async () => {
    const hanging: SecretResolver = {
      principal: createStaticSecretResolver({}).principal,
      enabled: true,
      resolve: async () => await new Promise<never>(() => undefined),
    };
    const credentials = createCredentialEnvironment({
      resolver: hanging,
      load: async () => profile([["GH_TOKEN", ref("Plain")]]),
      resolveTimeoutMs: 50,
    });
    expect(await credentials.forCommand(SHELL)).toEqual({
      env: {},
      notes: ["credential profile skipped GH_TOKEN (password manager did not answer in time)"],
    });
    // Shown once per attempt.
    expect(await credentials.forCommand(SHELL)).toEqual({ env: {}, notes: [] });
  });

  test("the profile is read again only after its short cache window", async () => {
    let clock = 1_000;
    let loads = 0;
    const credentials = createCredentialEnvironment({
      resolver: createStaticSecretResolver(VALUES),
      load: async () => {
        loads += 1;
        return profile([["GH_TOKEN", ref("Plain")]]);
      },
      profileTtlMs: 5_000,
      now: () => clock,
    });
    await credentials.forCommand(SHELL);
    await credentials.forCommand(SHELL);
    expect(loads).toBe(1);
    clock += 5_000;
    await credentials.forCommand(SHELL);
    expect(loads).toBe(2);
  });

  test("the git helper adds per-command git config after the profile's own entries", async () => {
    const { credentials } = environmentFor(
      profile([["GH_TOKEN", ref("cloud-auth/GITHUB_TOKEN/value")]], true),
    );
    const { env, notes } = await credentials.forCommand(SHELL);
    expect(notes).toEqual([]);
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_1: CREDENTIAL_PROFILE_GIT_HELPER,
    });
    // The helper reads the variable at use time; the value is never in config.
    expect(JSON.stringify(env).split(VALUES["cloud-auth/GITHUB_TOKEN/value"])).toHaveLength(2);
    expect(credentialProfileGitHelperEnvironment({ GIT_CONFIG_COUNT: "1" })).toMatchObject({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
      GIT_CONFIG_KEY_2: "credential.https://github.com.helper",
    });
    const withoutToken = environmentFor(profile([["OTHER", ref("Plain")]], true));
    expect((await withoutToken.credentials.forCommand(SHELL)).notes).toEqual([
      "credential profile git helper not applied: GH_TOKEN is not set",
    ]);
    expect((await withoutToken.credentials.forCommand(SHELL)).notes).toEqual([]);
  });

  test("notes end the tool result and never replace it", () => {
    expect(credentialProfileNoteText([])).toBeNull();
    expect(withCredentialProfileNotes("out", ["a", "b"])).toBe("out\n[Note: a; b]");
    expect(withCredentialProfileNotes({ output: "x\n", exitCode: 0 }, ["a"])).toEqual({
      output: "x\n[Note: a]",
      exitCode: 0,
    });
    expect(withCredentialProfileNotes("out", undefined)).toBe("out");
  });
});

describe("the profile carry", () => {
  test("a command without references gets a profile-only carry and keeps its text", async () => {
    const { credentials } = environmentFor(profile([["GH_TOKEN", ref("Plain")]]));
    const prepared = await prepareSecretExec("gh pr list", {
      resolver: createStaticSecretResolver(VALUES),
      dialect: "posix",
      use: SHELL,
      credentials,
    });
    expect(prepared?.text).toBe("gh pr list");
    expect(prepared?.carry?.profileOnly).toBe(true);
    expect(prepared?.carry?.profileEnv).toEqual({
      GH_TOKEN: VALUES.Plain,
      OPENGENI_CREDENTIAL_PROFILE_VARS: "GH_TOKEN",
    });
    const carry = bindSecretCarryToDispatch(prepared!.carry, "wrapped -- gh pr list -- marker");
    // Only the exact dispatch gets the profile, never a helper command.
    runWithSecretCarry(carry, () => {
      expect(secretExecCarryFor("wrapped -- gh pr list -- marker")).toBe(carry);
      expect(secretExecCarryFor("gh pr list")).toBe(carry);
      expect(secretExecCarryFor("cat /tmp/marker")).toBeNull();
    });
    // Without a wrapper (a Connected Machine), only the exact command matches.
    const exact = bindSecretCarryToDispatch(prepared!.carry, "gh pr list");
    runWithSecretCarry(exact, () => {
      expect(secretExecCarryFor("gh pr list")).toBe(exact);
      expect(secretExecCarryFor("sh -c 'gh pr list'")).toBeNull();
    });
  });

  test("a command with references keeps the reference splice and adds the profile", async () => {
    const { credentials } = environmentFor(profile([["GH_TOKEN", ref("Plain")]]));
    const command = `echo ${ref("cloud-auth/AZURE_CLIENT_SECRET/value")}`;
    const prepared = await prepareSecretExec(command, {
      resolver: createStaticSecretResolver(VALUES),
      dialect: "posix",
      use: SHELL,
      credentials,
    });
    expect(prepared?.text).toBe('echo "${OPENGENI_SECRET_0}"');
    expect(prepared?.carry?.profileOnly).toBeUndefined();
    expect(prepared?.carry?.profileEnv).toEqual({
      GH_TOKEN: VALUES.Plain,
      OPENGENI_CREDENTIAL_PROFILE_VARS: "GH_TOKEN",
    });
  });

  test("a reference failure still fails before the profile is read", async () => {
    const { credentials, loads } = environmentFor(profile([["GH_TOKEN", ref("Plain")]]));
    await expect(
      prepareSecretExec(`echo ${ref("Missing")}`, {
        resolver: createStaticSecretResolver(VALUES),
        dialect: "posix",
        use: SHELL,
        credentials,
      }),
    ).rejects.toBeInstanceOf(SecretReferenceError);
    expect(loads()).toBe(0);
  });

  test("the env file exports profile variables first and rejects reserved names", () => {
    const content = secretEnvFileContent(
      { OPENGENI_SECRET_0: "ref-value" },
      { GH_TOKEN: "it's fake" },
    );
    expect(content).toBe(
      "export GH_TOKEN='it'\"'\"'s fake'\nexport OPENGENI_SECRET_0='ref-value'\n",
    );
    expect(() => secretEnvFileContent({}, { OPENGENI_SECRET_1: "x" })).toThrow();
    expect(() => secretEnvFileContent({}, { "BAD NAME": "x" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Connected Machine path through the turn's exec_command wrapper.
// ---------------------------------------------------------------------------

function execTool(
  invoke: Extract<Tool<unknown>, { type: "function" }>["invoke"],
): Extract<Tool<unknown>, { type: "function" }> {
  return {
    type: "function",
    name: "exec_command",
    description: "exec_command",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: true },
    strict: false,
    needsApproval: async () => false,
    invoke,
  };
}

const exitedOutput = (output: string) =>
  [
    "Chunk ID: abc123",
    "Wall time: 0.0100 seconds",
    "Process exited with code 0",
    "Output:",
    output,
  ].join("\n");

describe("credential profiles on a Connected Machine (exec_command wrapper)", () => {
  async function connectedExec(
    value: EffectiveCredentialProfile,
    result: (cmd: string) => unknown = () => exitedOutput("ok\n"),
  ) {
    const resolver = createStaticSecretResolver(VALUES);
    const { credentials } = environmentFor(value, resolver);
    const controller = createTurnToolCancellationController(undefined, {
      secretResolver: resolver,
      credentials,
    });
    const seen: Array<{ cmd: string; env: Record<string, string> | undefined }> = [];
    const [exec] = controller.wrapTools(
      [
        execTool(async (_context, raw) => {
          const cmd = (JSON.parse(raw as string) as { cmd: string }).cmd;
          const carry = secretExecCarryFor(cmd);
          // A helper command in the same call never gets the profile.
          seen.push({ cmd, env: carry?.profileEnv ? { ...carry.profileEnv } : undefined });
          expect(secretExecCarryFor(`sh -c '${cmd}'`)).toBeNull();
          return result(cmd) as never;
        }),
      ],
      { commandCancellationTransport: async () => "remote_operation" as const },
    ) as Array<Extract<Tool<unknown>, { type: "function" }>>;
    const run = async (cmd: string) =>
      await exec!.invoke({} as never, JSON.stringify({ cmd }), {
        toolCall: { callId: `call_${crypto.randomUUID()}` },
      } as never);
    return { run, seen };
  }

  test("the exact command receives the variables; its text is unchanged", async () => {
    const h = await connectedExec(profile([["GH_TOKEN", ref("cloud-auth/GITHUB_TOKEN/value")]]));
    const output = await h.run("gh pr list");
    expect(output).toContain("ok");
    expect(output).not.toContain("[Note:");
    expect(h.seen).toEqual([
      {
        cmd: "gh pr list",
        env: {
          GH_TOKEN: VALUES["cloud-auth/GITHUB_TOKEN/value"],
          OPENGENI_CREDENTIAL_PROFILE_VARS: "GH_TOKEN",
        },
      },
    ]);
  });

  test("notes end string and structured results once per attempt", async () => {
    const value = profile([
      ["GH_TOKEN", ref("cloud-auth/GITHUB_TOKEN/value")],
      ["AZURE_TENANT_ID", ref("cloud-auth/NOT_SAVED/value")],
    ]);
    const note = "[Note: credential profile skipped AZURE_TENANT_ID (secret not found)]";
    const text = await connectedExec(value);
    expect(await text.run("az account show")).toContain(note);
    expect(await text.run("az account show")).not.toContain("[Note:");
    const structured = await connectedExec(value, () => ({ output: "ok\n", exitCode: 0 }));
    expect(await structured.run("az account show")).toEqual({
      output: `ok\n${note}`,
      exitCode: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Managed sandbox path: a real local sandbox, delivered through the env file.
// ---------------------------------------------------------------------------

type LocalSession = {
  close(): Promise<void>;
  execCommand(args: { cmd: string } & Record<string, unknown>): Promise<string>;
};

const sessions: LocalSession[] = [];
const tempRoot = mkdtempSync(join(tmpdir(), "opengeni-credential-profile-test-"));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(async (session) => await session.close()));
  rmSync(`${SECRET_FILE_ROOT}/${secretScopeFor(createStaticSecretResolver({}))}`, {
    recursive: true,
    force: true,
  });
});

async function localHarness(
  value: EffectiveCredentialProfile,
  options: { kind?: "local" | "opensandbox" } = {},
) {
  const settings = testSettings({ sandboxBackend: "local", webSearchEnabled: false });
  const client = createSandboxClientForBackend("local", settings) as {
    create(manifest?: unknown): Promise<LocalSession>;
  };
  const local = await client.create(
    new Manifest({
      environment: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: tempRoot },
    }),
  );
  sessions.push(local);
  const provider: string[] = [];
  const rawExecCommand = local.execCommand.bind(local);
  local.execCommand = async (args) => {
    provider.push(args.cmd);
    return await rawExecCommand(args);
  };
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
    adoptProcessAsBackgroundCommand: async () => undefined,
  });
  await routing.prime();
  const resolver = createStaticSecretResolver(VALUES);
  const { credentials } = environmentFor(value, resolver);
  const controller = createTurnToolCancellationController(undefined, {
    secretResolver: resolver,
    credentials,
  });
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
  const inputs: string[] = [];
  async function run(cmd: string, yieldMs = 2_000): Promise<string> {
    const input = JSON.stringify({ cmd, tty: false, yield_time_ms: yieldMs });
    inputs.push(input);
    let current = (await exec.invoke({} as never, input, {
      toolCall: { callId: `call_${crypto.randomUUID()}` },
    } as never)) as string;
    let output = current;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const banner = parseExecResponseBanner(current);
      if (banner.kind !== "running") break;
      current = (await write.invoke(
        {} as never,
        JSON.stringify({ session_id: banner.sessionId, chars: "", yield_time_ms: 250 }),
      )) as string;
      output += `\n${current}`;
    }
    return output;
  }
  return { run, provider, inputs, resolver };
}

describe("credential profiles on a managed sandbox (env-file path)", () => {
  const token = VALUES["cloud-auth/GITHUB_TOKEN/value"];

  test("the variable reaches the process; command text and arguments are unchanged", async () => {
    const h = await localHarness(profile([["GH_TOKEN", ref("cloud-auth/GITHUB_TOKEN/value")]]));
    const command = 'printf %s "$GH_TOKEN" | sha256sum';
    const output = await h.run(command);
    expect(output).toContain(sha256(token));
    expect(output).not.toContain("[Note:");
    // The tool arguments the model sent (and the journal stores) are exact.
    expect(JSON.parse(h.inputs[0]!).cmd).toBe(command);
    const main = h.provider.filter((cmd) => cmd.includes("sha256sum"));
    expect(main).toHaveLength(1);
    expect(main[0]).toContain(command);
    for (const cmd of h.provider) expect(cmd).not.toContain(token);
  }, 60_000);

  test("a variable the command sets itself wins", async () => {
    const h = await localHarness(profile([["GH_TOKEN", ref("cloud-auth/GITHUB_TOKEN/value")]]));
    const output = await h.run(`GH_TOKEN=command-own sh -c 'printf "<%s>" "$GH_TOKEN"'`);
    expect(output).toContain("<command-own>");
    const exported = await h.run(`export GH_TOKEN=exported-own; printf "<%s>" "$GH_TOKEN"`);
    expect(exported).toContain("<exported-own>");
  }, 60_000);

  test("a failing entry is skipped with a note and the command still runs", async () => {
    const h = await localHarness(
      profile([
        ["GH_TOKEN", ref("cloud-auth/GITHUB_TOKEN/value")],
        ["AZURE_CLIENT_ID", ref("cloud-auth/NOT_SAVED/value")],
      ]),
    );
    const output = await h.run('printf "<%s|%s>" "${AZURE_CLIENT_ID-unset}" "${#GH_TOKEN}"');
    expect(output).toContain(`<unset|${token.length}>`);
    expect(output).toContain(
      "[Note: credential profile skipped AZURE_CLIENT_ID (secret not found)]",
    );
  }, 60_000);

  test("a sandbox that cannot receive the profile runs the command without it, with one note", async () => {
    // OpenSandbox has no private file writes, so the env file cannot be written.
    const h = await localHarness(profile([["GH_TOKEN", ref("cloud-auth/GITHUB_TOKEN/value")]]), {
      kind: "opensandbox",
    });
    const first = await h.run('printf "<%s>" "${GH_TOKEN-unset}"');
    expect(first).toContain("<unset>");
    expect(first).toContain(
      "[Note: credential profile not applied: this sandbox could not receive it]",
    );
    const second = await h.run('printf "<%s>" "${GH_TOKEN-unset}"');
    expect(second).toContain("<unset>");
    expect(second).not.toContain("[Note:");
    for (const cmd of h.provider) expect(cmd).not.toContain(token);
  }, 60_000);

  test("helper commands in the same call never receive the profile", async () => {
    const h = await localHarness(profile([["GH_TOKEN", ref("cloud-auth/GITHUB_TOKEN/value")]]));
    await h.run('printf %s "$GH_TOKEN" | sha256sum');
    // Only the one dispatched command is prefixed with the env file; the
    // marker, kill and cleanup commands around it are not.
    const sourced = h.provider.filter((cmd) => cmd.includes(`if . '${SECRET_FILE_ROOT}/`));
    expect(sourced).toHaveLength(1);
    expect(sourced[0]).toContain("sha256sum");
  }, 60_000);

  test("a command that keeps running in the background has the variable", async () => {
    const h = await localHarness(profile([["GH_TOKEN", ref("cloud-auth/GITHUB_TOKEN/value")]]));
    const output = await h.run('sleep 1; printf %s "$GH_TOKEN" | sha256sum', 200);
    expect(output).toContain(sha256(token));
  }, 60_000);

  test("the git helper answers git for github.com with GH_TOKEN, over a machine helper", async () => {
    const h = await localHarness(
      profile([["GH_TOKEN", ref("cloud-auth/GITHUB_TOKEN/value")]], true),
    );
    // A HOME whose git config has its own (stale) helper for every host.
    const gitHome = mkdtempSync(join(tempRoot, "git-home-"));
    writeFileSync(
      join(gitHome, ".gitconfig"),
      '[credential]\n\thelper = "!f() { echo username=stale; echo password=stale-token; }; f"\n',
    );
    const fill = (host: string) =>
      `printf 'protocol=https\\nhost=${host}\\n\\n' | HOME='${gitHome}' GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 git credential fill`;
    const github = await h.run(fill("github.com"));
    expect(github).toContain("username=x-access-token");
    expect(github).toContain(`password=${token}`);
    expect(github).not.toContain("stale-token");
    // Other hosts keep the machine's own configuration.
    const other = await h.run(fill("example.com"));
    expect(other).toContain("password=stale-token");
    expect(other).not.toContain(token);
    // Nothing was written: the machine's git config is unchanged.
    const config = spawnSync("git", ["config", "--file", join(gitHome, ".gitconfig"), "--list"], {
      encoding: "utf8",
    });
    expect(config.stdout).not.toContain(token);
    expect(config.stdout).not.toContain("github.com");
  }, 60_000);
});
