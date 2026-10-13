/**
 * DL-9 (W1): `run_on` exec splices references in the target machine's dialect
 * and delivers values only in ExecRequest.env; write resolves its content;
 * read resolves nothing. A Windows machine gets a PowerShell splice.
 */
import { describe, expect, test } from "bun:test";
import { type ControlRequest, type ControlResponse, type ExecRequest } from "@opengeni/agent-proto";
import {
  FakeOpRunner,
  InMemoryOpStreamTransport,
  type ControlRpc,
} from "@opengeni/runtime/sandbox";
import { createStaticSecretResolver } from "@opengeni/vaults/testing";
import { executeRunOnSelfhostedMachine, type RunOnOp } from "../src/sandbox/fleet";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const CONNECTION_INSTANCE = "connection-run-on-secrets";
const CANARY = "OGCANARY-run-on 'q' $HOME";
const decoder = new TextDecoder();

class CapturingMachine implements ControlRpc {
  readonly execs: ExecRequest[] = [];
  readonly writes: Array<{ path: string; content: string; mode: number }> = [];
  readonly reads: string[] = [];
  readonly removes: Array<{ path: string; recursive: boolean }> = [];
  readonly transport = new InMemoryOpStreamTransport();
  readonly opStream = { transport: this.transport };
  private readonly runner: FakeOpRunner;

  constructor(readonly workspaceRoot: string) {
    this.runner = new FakeOpRunner({
      transport: this.transport,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: CONNECTION_INSTANCE,
      workspaceRoot,
      defaultScript: (exec) => {
        this.execs.push(exec);
        return {
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

async function runOn(machine: CapturingMachine, op: RunOnOp, enabled = true) {
  return await executeRunOnSelfhostedMachine(
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
      secretResolver: createStaticSecretResolver({ Canary: CANARY }, { enabled }),
    },
    "target",
    op,
  );
}

describe("run_on secret delivery (DL-9)", () => {
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

  test("secretfile: written 0600 privately, path delivered by name, removed after the one-off", async () => {
    const machine = new CapturingMachine("/home/user/project");
    const result = await runOn(machine, { kind: "exec", cmd: "wc -c {{secretfile:Canary}}" });
    expect(result.ok).toBe(true);
    const file = machine.writes.find((write) => write.path.includes("/opengeni-private/secrets/"));
    expect(file?.content).toBe(CANARY);
    expect(file?.mode).toBe(0o600);
    expect(machine.execs[0]!.command.join(" ")).not.toContain("OGCANARY");
    expect(machine.execs[0]!.env).toMatchObject({ OPENGENI_SECRET_0: file!.path });
    // Cleanup is the filesystem op on the scope directory, never a shell command.
    expect(machine.execs).toHaveLength(1);
    expect(machine.removes).toHaveLength(1);
    expect(machine.removes[0]!.recursive).toBe(true);
    expect(file!.path.startsWith(`${machine.removes[0]!.path}/`)).toBe(true);
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
    const failed = await runOn(machine, { kind: "exec", cmd: "echo {{secret:Missing}}" });
    expect(failed.ok).toBe(false);
    expect(machine.execs).toHaveLength(0);
    const off = await runOn(machine, { kind: "exec", cmd: "echo {{secret:Canary}}" }, false);
    expect(off.ok).toBe(true);
    expect(machine.execs[0]!.env).not.toHaveProperty("OPENGENI_SECRET_0");
  });
});
