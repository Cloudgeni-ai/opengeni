/**
 * DL-9 (W1): `run_on` exec splices references in the target machine's dialect
 * and delivers values only in ExecRequest.env; write resolves its content;
 * read resolves nothing. A Windows machine gets a PowerShell splice.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  SecretReferenceError,
  type SecretResolver,
  type SecretUseApprovalAsk,
} from "@opengeni/contracts";
import { type ControlRequest, type ControlResponse, type ExecRequest } from "@opengeni/agent-proto";
import {
  FakeOpRunner,
  InMemoryOpStreamTransport,
  type ControlRpc,
} from "@opengeni/runtime/sandbox";
import { createStaticSecretResolver } from "@opengeni/vaults/testing";
import { createSecretArgumentResolver } from "@opengeni/runtime/workspace-tool-gateway";
import { createWorkspaceToolGateway } from "@opengeni/tool-gateway";
import {
  executeRunOnSelfhostedMachine,
  type RunOnOp,
  type RunOnResult,
} from "../src/sandbox/fleet";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const CONNECTION_INSTANCE = "connection-run-on-secrets";
const CANARY = "OGCANARY-run-on 'single' \"double\" $HOME `id` $(id) \\ * ; & |\nsecond line ";
const decoder = new TextDecoder();

class CapturingMachine implements ControlRpc {
  readonly execs: ExecRequest[] = [];
  readonly writes: Array<{ path: string; content: string; mode: number }> = [];
  readonly reads: string[] = [];
  readonly removes: Array<{ path: string; recursive: boolean }> = [];
  readonly transport = new InMemoryOpStreamTransport();
  readonly opStream = { transport: this.transport };
  private readonly runner: FakeOpRunner;

  constructor(
    readonly workspaceRoot: string,
    live = false,
  ) {
    this.runner = new FakeOpRunner({
      transport: this.transport,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: CONNECTION_INSTANCE,
      workspaceRoot,
      defaultScript: (exec) => {
        this.execs.push(exec);
        return {
          ...(live ? { live: true, holdUntilCancel: true } : {}),
          frames: [{ channel: "stdout", bytes: "ok" }],
          exit: { exitCode: 0, timedOut: false, durationMs: "1" },
        };
      },
    });
  }

  async request(
    subject: string,
    req: ControlRequest,
    opts: { timeoutMs: number },
  ): Promise<ControlResponse> {
    const op = req.op;
    if (op?.$case === "fsWrite") {
      this.writes.push({
        path: op.fsWrite.path,
        content: decoder.decode(op.fsWrite.content),
        mode: op.fsWrite.mode,
      });
      return {
        requestId: req.requestId,
        result: {
          $case: "fsWrite",
          fsWrite: { bytesWritten: String(op.fsWrite.content.byteLength) },
        },
      };
    }
    if (op?.$case === "fsRemove") {
      this.removes.push({ path: op.fsRemove.path, recursive: op.fsRemove.recursive });
      return { requestId: req.requestId, result: { $case: "fsRemove", fsRemove: {} } };
    }
    if (op?.$case === "fsRead") {
      this.reads.push(op.fsRead.path);
      const content = new TextEncoder().encode("left {{secret:Canary}} as written");
      return {
        requestId: req.requestId,
        result: { $case: "fsRead", fsRead: { content, totalSize: String(content.length) } },
      };
    }
    return await this.runner.request(subject, req, opts);
  }
}

async function runOn(
  machine: CapturingMachine,
  op: RunOnOp,
  enabled = true,
  caller: "model" | "codemode" | "http" = "model",
  resolver: SecretResolver = createStaticSecretResolver({ Canary: CANARY }, { enabled }),
) {
  const resolveArguments = createSecretArgumentResolver({ resolver });
  let result: RunOnResult | undefined;
  const args = { target: "target", op };
  // Exercise the real gateway hook BEFORE fleet execution. Calling fleet
  // directly misses premature literal substitution and secretfile rejection.
  const { catalog, gateway } = createWorkspaceToolGateway({
    accountId: WORKSPACE,
    workspaceId: WORKSPACE,
    generation: 1,
    ...(resolveArguments ? { resolveArguments } : {}),
    definitions: [
      {
        identity: { serverId: "opengeni", toolName: "run_on" },
        source: "opengeni",
        modelName: "opengeni__run_on",
        description: "Run a one-off machine operation",
        approval: "none",
        inputSchema: {
          type: "object",
          properties: { target: { type: "string" }, op: { type: "object" } },
          required: ["target", "op"],
        },
        execute: async (resolved) => {
          result = await executeRunOnSelfhostedMachine(
            {
              workspaceId: WORKSPACE,
              agentId: AGENT,
              connectionInstanceId: CONNECTION_INSTANCE,
              workspaceRoot: machine.workspaceRoot,
              controlRpc: machine,
              opStream: machine.opStream,
              relay: { host: "relay.test", tls: true },
              controlTimeoutMs: 30_000,
              execTimeoutMs: 120_000,
              secretResolver: resolver,
            },
            resolved.target as string,
            resolved.op as RunOnOp,
          );
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        },
      },
    ],
  });
  const prepared = await gateway.prepareCall({
    operationId: crypto.randomUUID(),
    catalogDigest: catalog.digest,
    identity: catalog.entries[0]!.identity,
    arguments: args,
    caller: { kind: caller, subjectId: "subject" },
  });
  await prepared.execute();
  expect(prepared.call.arguments).toEqual(args);
  return result!;
}

describe("run_on secret delivery (DL-9)", () => {
  test.each(["model", "codemode", "http"] as const)(
    "%s gateway preserves references until the target exec boundary",
    async (caller) => {
      const machine = new CapturingMachine("/home/user/project");
      const reference = "{{secret:Canary}}";
      const result = await runOn(
        machine,
        { kind: "exec", cmd: `R=${reference}; printf '%s' "$R"` },
        true,
        caller,
      );
      expect(result.ok).toBe(true);
      const exec = machine.execs[0]!;
      expect(exec.shell).toBe(false);
      expect(exec.command[0]).toBe("/bin/sh");
      expect(exec.command.join(" ")).not.toContain("OGCANARY");
      expect(exec.env).toEqual({ OPENGENI_SECRET_0: CANARY });
      expect(JSON.stringify(result)).not.toContain(CANARY);
    },
  );

  for (const defaultShell of ["sh", "zsh"]) {
    const shellPath = Bun.which(defaultShell);
    test.skipIf(process.platform !== "linux" || !shellPath)(
      `${defaultShell}-default target: exact bytes and no value in /proc argv`,
      async () => {
        const machine = new CapturingMachine("/home/user/project");
        const reference = "{{secret:Canary}}";
        await runOn(machine, {
          kind: "exec",
          cmd: `R=${reference}; cat /proc/$$/cmdline; printf '\\n'; printf '%s' "$R" | sha256sum`,
        });
        const exec = machine.execs[0]!;
        // The runner uses the login shell only for shell=true. A target whose
        // default is zsh must instead receive explicit /bin/sh argv for secrets.
        expect(exec.shell).toBe(false);
        expect(exec.command.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
        const child = Bun.spawnSync(
          [shellPath!, "-f", "-c", 'exec "$@"', "target", ...exec.command],
          {
            env: { PATH: process.env.PATH, SHELL: shellPath!, ...exec.env },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        expect(child.exitCode).toBe(0);
        expect(decoder.decode(child.stderr)).toBe("");
        const output = decoder.decode(child.stdout);
        expect(output).toContain("OPENGENI_SECRET_0");
        expect(output).not.toContain("OGCANARY");
        expect(output).toContain(createHash("sha256").update(CANARY).digest("hex"));
      },
    );
  }

  test("escaped references are unescaped exactly once, at the machine boundary", async () => {
    const machine = new CapturingMachine("/home/user/project");
    const reference = "{{secret:Missing}}";
    const result = await runOn(machine, { kind: "exec", cmd: `printf '%s' '\\${reference}'` });
    expect(result.ok).toBe(true);
    expect(machine.execs[0]!.command).toEqual([`printf '%s' '${reference}'`]);
    expect(machine.execs[0]!.env).toEqual({});
  });

  test("write content unescapes a literal reference only once", async () => {
    const machine = new CapturingMachine("/home/user/project");
    const reference = "{{secret:Missing}}";
    const result = await runOn(machine, {
      kind: "write",
      path: "out.txt",
      content: `\\${reference}`,
    });
    expect(result.ok).toBe(true);
    expect(machine.writes.at(-1)?.content).toBe(reference);
  });

  test.each(["exec", "write"] as const)(
    "%s resolves and audits once, preserving mixed escaped references",
    async (kind) => {
      const machine = new CapturingMachine("/home/user/project");
      const resolver = createStaticSecretResolver({ Canary: CANARY });
      const content = "{{secret:Canary}} \\{{secret:Missing}} {{secret:Canary}}";
      const op: RunOnOp =
        kind === "exec"
          ? { kind, cmd: `printf '%s' '${content}'` }
          : { kind, path: "out.txt", content };
      const result = await runOn(machine, op, true, "model", resolver);
      expect(result.ok).toBe(true);
      expect(resolver.calls).toEqual([
        {
          refs: ["{{secret:Canary}}"],
          use: {
            surface: kind === "exec" ? "run_on" : "file_write",
            toolName: "run_on",
            destination: "target",
          },
        },
      ]);
      if (kind === "exec") {
        expect(machine.execs[0]!.command.at(-1)).toContain("{{secret:Missing}}");
        expect(machine.execs[0]!.command.at(-1)).not.toContain("\\{{secret:Missing}}");
        expect(machine.execs[0]!.env).toEqual({ OPENGENI_SECRET_0: CANARY });
      } else {
        expect(machine.writes.at(-1)?.content).toBe(`${CANARY} {{secret:Missing}} ${CANARY}`);
      }
    },
  );

  for (const fieldName of ["", "password"]) {
    for (const kind of ["exec", "write"] as const) {
      test(`${kind}: ${fieldName || "whole-item"} approval failure preserves the approval and dispatches nothing`, async () => {
        const machine = new CapturingMachine("/home/user/project");
        const approval: SecretUseApprovalAsk = {
          approvalId: "33333333-3333-4333-8333-333333333333",
          asked: true,
        };
        const reference = fieldName ? "{{secret:Canary/password}}" : "{{secret:Canary}}";
        const failure = new SecretReferenceError(
          [{ raw: reference, code: "approval_required", message: "This use needs approval" }],
          null,
          approval,
        );
        const resolver: SecretResolver = {
          ...createStaticSecretResolver({}),
          resolve: async () => {
            throw failure;
          },
        };
        const content = `{{secretfile:Canary}} ${reference}`;
        const error = await runOn(
          machine,
          kind === "exec"
            ? { kind, cmd: `cat ${content}` }
            : { kind, path: "out.txt", content: reference },
          true,
          "model",
          resolver,
        ).catch((caught) => caught);
        // The API boundary, rather than a fleet result envelope, must render
        // this same error with the approval Opengeni already asked for intact.
        expect(error).toBe(failure);
        expect(error.approval).toEqual(approval);
        expect(machine.execs).toHaveLength(0);
        expect(machine.writes).toHaveLength(0);
      });
    }
  }

  test("a yielded command retains its secret files instead of deleting them on HTTP return", async () => {
    const machine = new CapturingMachine("/home/user/project", true);
    const result = await executeRunOnSelfhostedMachine(
      {
        workspaceId: WORKSPACE,
        agentId: AGENT,
        connectionInstanceId: CONNECTION_INSTANCE,
        workspaceRoot: machine.workspaceRoot,
        controlRpc: machine,
        opStream: machine.opStream,
        relay: { host: "relay.test" },
        controlTimeoutMs: 2_000,
        execTimeoutMs: 0,
        yieldTimeMs: 1,
        secretResolver: createStaticSecretResolver({ Canary: CANARY }),
        backgroundCommands: {
          adoptBackgroundCommand: async () => ({ commandId: "retained-command" }),
        },
      },
      "target",
      { kind: "exec", cmd: "use {{secretfile:Canary}}" },
    );
    expect(result).toMatchObject({
      state: "running",
      commandId: "retained-command",
      deadlineMs: 0,
    });
    expect(machine.writes).toHaveLength(1);
    expect(machine.removes).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });
  test("POSIX exec: spliced names in argv, the value only in ExecRequest.env", async () => {
    const machine = new CapturingMachine("/home/user/project");
    const result = await runOn(machine, { kind: "exec", cmd: 'printf %s "{{secret:Canary}}"' });
    expect(result.ok).toBe(true);
    const exec = machine.execs[0]!;
    expect(exec.command[0]).toBe("/bin/sh");
    expect(exec.command.join(" ")).toContain("OPENGENI_SECRET_0");
    expect(exec.command.join(" ")).not.toContain("OGCANARY");
    expect(exec.env).toMatchObject({ OPENGENI_SECRET_0: CANARY });
  });

  test("Windows exec: PowerShell splice", async () => {
    const machine = new CapturingMachine("C:/Users/user/project");
    const result = await runOn(machine, { kind: "exec", cmd: 'Write-Output "{{secret:Canary}}"' });
    expect(result.ok).toBe(true);
    const exec = machine.execs[0]!;
    expect(exec.command[0]).toBe("powershell");
    expect(exec.command.join(" ")).toContain("${env:OPENGENI_SECRET_0}");
    expect(exec.command.join(" ")).not.toContain("OGCANARY");
    expect(exec.env).toMatchObject({ OPENGENI_SECRET_0: CANARY });
  });

  const powerShellImage = "mcr.microsoft.com/powershell:latest";
  const hasPowerShellImage =
    Bun.which("docker") !== null &&
    Bun.spawnSync(["docker", "image", "inspect", powerShellImage], {
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode === 0;
  test.skipIf(!hasPowerShellImage)(
    "PowerShell executes the gateway splice as data, absent from argv",
    async () => {
      const machine = new CapturingMachine("C:/Users/user/project");
      await runOn(machine, {
        kind: "exec",
        cmd:
          "$R = {{secret:Canary}}; [Console]::WriteLine([Environment]::CommandLine); " +
          "[Console]::WriteLine(([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($R)) | ForEach-Object { $_.ToString('x2') }) -join '')",
      });
      const exec = machine.execs[0]!;
      expect(exec.shell).toBe(false);
      expect(exec.command.slice(0, 5)).toEqual([
        "powershell",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
      ]);
      // Pass the fake value through the test process environment, never Docker
      // argv. The disposable pwsh parses the exact script intended for Windows.
      const child = Bun.spawnSync(
        [
          "docker",
          "run",
          "--rm",
          "--network=none",
          "-e",
          "OPENGENI_SECRET_0",
          powerShellImage,
          "pwsh",
          ...exec.command.slice(1),
        ],
        { env: { ...process.env, ...exec.env }, stdout: "pipe", stderr: "pipe" },
      );
      expect(child.exitCode).toBe(0);
      expect(decoder.decode(child.stderr)).toBe("");
      const output = decoder.decode(child.stdout);
      expect(output).toContain("OPENGENI_SECRET_0");
      expect(output).not.toContain("OGCANARY");
      expect(output).toContain(createHash("sha256").update(CANARY).digest("hex"));
    },
    60_000,
  );

  test.each(["/home/user/project", "C:/Users/user/project"])(
    "secretfile on %s: written 0600 privately, path delivered by name, removed after the one-off",
    async (root) => {
      const machine = new CapturingMachine(root);
      const result = await runOn(machine, { kind: "exec", cmd: "wc -c {{secretfile:Canary}}" });
      expect(result.ok).toBe(true);
      const file = machine.writes.find((write) =>
        write.path.includes("/opengeni-private/secrets/"),
      );
      expect(file?.content).toBe(CANARY);
      expect(file?.mode).toBe(0o600);
      expect(machine.execs[0]!.command.join(" ")).not.toContain("OGCANARY");
      expect(machine.execs[0]!.env).toMatchObject({ OPENGENI_SECRET_0: file!.path });
      // Cleanup is the filesystem op on the scope directory, never a shell command.
      expect(machine.execs).toHaveLength(1);
      expect(machine.removes).toHaveLength(1);
      expect(machine.removes[0]!.recursive).toBe(true);
      expect(file!.path.startsWith(`${machine.removes[0]!.path}/`)).toBe(true);
    },
  );

  test("read paths are not secret-resolution surfaces", async () => {
    const machine = new CapturingMachine("/home/user/project");
    const path = "literal-{{secret:Missing}}.txt";
    const result = await runOn(machine, { kind: "read", path });
    expect(result.ok).toBe(true);
    expect(machine.reads).toEqual([`${machine.workspaceRoot}/${path}`]);
  });

  test("write paths and exec workdirs remain literal; commands without references stay unchanged", async () => {
    const machine = new CapturingMachine("/home/user/project");
    const resolver = createStaticSecretResolver({});
    const path = "literal-{{secret:Missing}}";
    const written = await runOn(
      machine,
      { kind: "write", path, content: "plain" },
      true,
      "model",
      resolver,
    );
    const executed = await runOn(
      machine,
      { kind: "exec", cmd: "printf plain", workdir: path },
      true,
      "model",
      resolver,
    );
    expect(written.ok).toBe(true);
    expect(executed.ok).toBe(true);
    expect(machine.writes[0]!.path).toBe(`${machine.workspaceRoot}/${path}`);
    expect(machine.execs[0]!).toMatchObject({
      cwd: `${machine.workspaceRoot}/${path}`,
      command: ["printf plain"],
      shell: true,
      env: {},
    });
    expect(resolver.calls).toHaveLength(0);
  });

  test("write resolves its content; read resolves nothing", async () => {
    const machine = new CapturingMachine("/home/user/project");
    const written = await runOn(machine, {
      kind: "write",
      path: "out.env",
      content: "TOKEN={{secret:Canary}}\n",
    });
    expect(written.ok).toBe(true);
    expect(machine.writes.at(-1)?.content).toBe(`TOKEN=${CANARY}\n`);
    const read = await runOn(machine, { kind: "read", path: "in.txt" });
    expect(read.content).toBe("left {{secret:Canary}} as written");
  });

  test("an unknown reference fails before dispatch; capability off passes text literally", async () => {
    const machine = new CapturingMachine("/home/user/project");
    const failed = await runOn(machine, { kind: "exec", cmd: "echo {{secret:Missing}}" }).catch(
      (caught) => caught,
    );
    expect(failed).toBeInstanceOf(SecretReferenceError);
    expect(failed.code).toBe("secret_reference_error");
    expect(failed.askCard).not.toBeNull();
    expect(failed.failures?.[0]?.code).toBe("not_found");
    expect(machine.execs).toHaveLength(0);
    const off = await runOn(machine, { kind: "exec", cmd: "echo {{secret:Canary}}" }, false);
    expect(off.ok).toBe(true);
    expect(machine.execs[0]!.env).not.toHaveProperty("OPENGENI_SECRET_0");
  });
});
