import { describe, expect, mock, test } from "bun:test";
import { Manifest } from "@openai/agents/sandbox";

// The E2B SDK is replaced by a recorder: these tests check what the adapter
// hands the SDK when Opengeni points it at an E2B-compatible API.
type Call = { kind: "create" | "connect"; args: unknown[] };
const calls: Call[] = [];

class RecordingSandbox {
  readonly files = { makeDir: async () => true };
  readonly commands = { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
  constructor(readonly sandboxId: string) {}
  async kill() {
    return true;
  }
  async pause() {
    return true;
  }
  static async create(...args: unknown[]) {
    calls.push({ kind: "create", args });
    return new RecordingSandbox("sbx-created");
  }
  static async connect(...args: unknown[]) {
    calls.push({ kind: "connect", args });
    return new RecordingSandbox(String(args[0]));
  }
}

mock.module("e2b", () => ({ Sandbox: RecordingSandbox }));

const { E2BSandboxClient } = await import("@openai/agents-extensions/sandbox/e2b");

const connection = {
  apiKey: "key-1",
  domain: "sandboxes.example.com",
  apiUrl: "https://api.sandboxes.example.com",
};

function takeCalls(): Call[] {
  return calls.splice(0, calls.length);
}

describe("E2B adapter connection options", () => {
  test("create hands the key, domain and API address to the SDK", async () => {
    takeCalls();
    const client = new E2BSandboxClient({ template: "base", timeout: 60, connection });
    const session = await client.create(new Manifest({ root: "/workspace" }));
    const [create] = takeCalls();
    expect(create?.kind).toBe("create");
    expect(create?.args[0]).toBe("base");
    expect(create?.args[1]).toMatchObject({
      apiKey: "key-1",
      domain: "sandboxes.example.com",
      apiUrl: "https://api.sandboxes.example.com",
      timeoutMs: 60_000,
    });
    // An unset field is left to the SDK's own default.
    expect(Object.keys(create?.args[1] as object)).not.toContain("sandboxUrl");

    // The connection, the key above all, never reaches saved session state.
    const saved = JSON.stringify(await client.serializeSessionState(session.state));
    expect(saved).not.toContain("key-1");
    expect(saved).not.toContain("sandboxes.example.com");
  });

  test("exact resume connects with the same connection", async () => {
    takeCalls();
    const client = new E2BSandboxClient({ timeout: 30, connection });
    const created = await client.create(new Manifest({ root: "/workspace" }));
    takeCalls();
    const state = await client.deserializeSessionState(
      await client.serializeSessionState(created.state),
    );
    const resumed = await client.resumeExact(state);
    const [connect] = takeCalls();
    expect(connect?.kind).toBe("connect");
    expect(connect?.args[0]).toBe("sbx-created");
    expect(connect?.args[1]).toMatchObject({
      apiKey: "key-1",
      domain: "sandboxes.example.com",
      apiUrl: "https://api.sandboxes.example.com",
      timeoutMs: 30_000,
    });
    expect(resumed.state.sandboxId).toBe("sbx-created");
  });

  test("without a connection the SDK gets exactly what it got before", async () => {
    takeCalls();
    const client = new E2BSandboxClient({});
    await client.create(new Manifest({ root: "/workspace" }));
    const [create] = takeCalls();
    expect(create?.kind).toBe("create");
    expect(create?.args).toEqual([undefined]);
  });
});
