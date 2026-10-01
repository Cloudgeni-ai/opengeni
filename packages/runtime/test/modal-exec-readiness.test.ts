import { afterAll, beforeAll, expect, test } from "bun:test";
import { Server, ServerCredentials, status, type ServiceDefinition } from "@grpc/grpc-js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Sandbox } from "modal";
import { Manifest } from "@openai/agents/sandbox";
import { ModalSandboxSession } from "@openai/agents-extensions/sandbox/modal";
import { verifySandboxExecReadiness, SandboxExecReadinessError } from "../src/sandbox";
import { ModalCommandControl } from "../src/sandbox/providers/modal-command-control";
import { installModalCommandSession } from "../src/sandbox/providers/modal-command-session";
import {
  ModalCommandRouterWire,
  ModalCommandStartRejectedError,
  modalRouterWire,
} from "../src/sandbox/providers/modal-command-router-wire";
import {
  waitForSandboxExecReadiness,
  SandboxExecReadinessTimeoutError,
} from "../../../apps/worker/src/sandbox-resume";

const service = "/modal.task_command_router.TaskCommandRouter/";
const definition = (method: string, input: string, output: string, streaming = false) => ({
  path: service + method,
  requestStream: false,
  responseStream: streaming,
  requestSerialize: (value: object) =>
    Buffer.from(modalRouterWire.lookupType(input).encode(value).finish()),
  requestDeserialize: (bytes: Buffer) => modalRouterWire.lookupType(input).decode(bytes),
  responseSerialize: (value: object) =>
    Buffer.from(modalRouterWire.lookupType(output).encode(value).finish()),
  responseDeserialize: (bytes: Buffer) => modalRouterWire.lookupType(output).decode(bytes),
});
const server = new Server();
let directory: string, endpoint: string, certificate: Buffer;
type Mode =
  | "success"
  | "lost-start"
  | "unknown-start"
  | "internal-start"
  | "lost-read"
  | "unobservable"
  | "rejected"
  | "nonzero";
let mode: Mode = "success";
let starts: Array<{ execId: string; commandArgs: string[]; workdir: string; env: object }> = [];
let observations: string[] = [];
let failedRead = false;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "opengeni-readiness-"));
  const key = join(directory, "server.key"),
    cert = join(directory, "server.pem");
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "pipe" },
  );
  if (generated.status !== 0) throw new Error("Test TLS certificate generation failed");
  certificate = readFileSync(cert);
  server.addService(
    {
      start: definition("TaskExecStart", "Start", "Empty"),
      read: definition("TaskExecStdioRead", "Read", "Data", true),
      poll: definition("TaskExecPoll", "Identity", "Poll"),
    } as ServiceDefinition,
    {
      start(call: any, callback: any) {
        expect(call.metadata.get("authorization")).toEqual(["Bearer test-token"]);
        starts.push(call.request);
        callback(
          mode === "rejected"
            ? { code: status.NOT_FOUND, details: "executable unavailable" }
            : mode === "unknown-start" || mode === "internal-start"
              ? {
                  code: mode === "unknown-start" ? status.UNKNOWN : status.INTERNAL,
                  details: "accepted probe, lost response",
                }
              : mode === "lost-start" || mode === "unobservable"
                ? {
                    code: status.UNAVAILABLE,
                    details: "Name resolution failed for target dns:task-spoof.w.modal.host:443",
                  }
                : null,
          {},
        );
      },
      read(call: any) {
        observations.push(call.request.execId);
        if (mode === "unobservable" || (mode === "lost-read" && !failedRead)) {
          failedRead = true;
          call.emit("error", { code: status.UNAVAILABLE, details: "read connection dropped" });
        } else call.end();
      },
      poll(call: any, callback: any) {
        observations.push(call.request.execId);
        callback(null, { code: mode === "nonzero" ? 127 : 0 });
      },
    },
  );
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      ServerCredentials.createSsl(null, [
        { private_key: readFileSync(key), cert_chain: certificate },
      ]),
      (error, boundPort) => (error ? reject(error) : resolve(boundPort)),
    ),
  );
  endpoint = `https://localhost:${port}`;
});
afterAll(() => {
  server.forceShutdown();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function fixture(selected: Mode = "success", url = endpoint) {
  mode = selected;
  starts = [];
  observations = [];
  failedRead = false;
  let sdkStarts = 0;
  const sandbox = new Sandbox(
    {
      profile: { serverUrl: "http://localhost" },
      logger: { debug() {}, warn() {} },
      cpClient: {
        taskGetCommandRouterAccess: async () => ({
          url: "https://task-readiness.invalid",
          jwt: "test-token",
        }),
      },
    } as never,
    "sb-readiness",
    { taskId: "task-readiness" },
  );
  const original = sandbox.exec.bind(sandbox);
  sandbox.exec = async (...args) => {
    sdkStarts++;
    return await original(...args);
  };
  const session = new ModalSandboxSession({
    state: {
      sandboxId: "sb-readiness",
      manifest: new Manifest({ root: "/workspace" }),
      environment: { BASH_ENV: "/workspace/user-startup" },
      workspacePersistence: "tar",
    },
    sandbox,
    modal: { version: () => "0.9.0" },
    app: {},
  } as never);
  const control = ModalCommandControl.forSandbox(
    {
      version: () => "0.9.0",
      cpClient: { sandboxGetTaskId: async () => ({ taskId: "task-readiness" }) },
    } as never,
    "sb-readiness",
    "/workspace",
  );
  const wire = new ModalCommandRouterWire({ url, jwt: "test-token" }, certificate);
  Object.defineProperty(control, "withRouter", {
    value: async (
      _task: string,
      signal: AbortSignal,
      run: (router: ModalCommandRouterWire) => Promise<unknown>,
    ) => {
      signal.throwIfAborted();
      return await run(wire);
    },
  });
  installModalCommandSession(session, control);
  const established = {
    backendId: "modal",
    instanceId: "sb-readiness",
    session,
    client: {},
    sessionState: {},
  };
  return {
    established,
    session,
    wire,
    sdkStarts: () => sdkStarts,
    close: async () => {
      wire.close();
      sandbox.detach();
      await control.close();
    },
  };
}

test("worker readiness uses native pre-dispatch proof instead of the pinned SDK DNS failure", async () => {
  const f = fixture();
  const client = (f.wire as any).client;
  const ready = client.waitForReady.bind(client);
  let gates = 0;
  client.waitForReady = (deadline: number, callback: (error?: Error) => void) => {
    if (++gates === 1) callback(new Error("local DNS resolver unavailable before dispatch"));
    else ready(deadline, callback);
  };
  try {
    await waitForSandboxExecReadiness(f.established, 2_000);
    expect(gates).toBe(2);
    expect(f.sdkStarts()).toBe(0);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ commandArgs: ["/bin/true"], workdir: "/tmp", env: {} });
    expect(new Set(observations)).toEqual(new Set([starts[0]!.execId]));
  } finally {
    await f.close();
  }
});

test("real unresolved DNS remains within the worker readiness budget and sends no Start", async () => {
  const f = fixture("success", "https://task-readiness.invalid");
  const begun = performance.now();
  try {
    await expect(waitForSandboxExecReadiness(f.established, 200)).rejects.toBeInstanceOf(
      SandboxExecReadinessTimeoutError,
    );
    expect(performance.now() - begun).toBeLessThan(2_000);
    expect(starts).toHaveLength(0);
    expect(f.sdkStarts()).toBe(0);
  } finally {
    await f.close();
  }
});

test("an accepted Start with DNS-shaped lost reply is observed once without replay", async () => {
  const f = fixture("lost-start");
  try {
    await waitForSandboxExecReadiness(f.established, 2_000);
    expect(starts).toHaveLength(1);
    expect(new Set(observations)).toEqual(new Set([starts[0]!.execId]));
    expect(f.sdkStarts()).toBe(0);
  } finally {
    await f.close();
  }
});

test("UNKNOWN and INTERNAL Start replies observe the accepted invocation without replay", async () => {
  for (const selected of ["unknown-start", "internal-start"] as const) {
    const f = fixture(selected);
    try {
      await waitForSandboxExecReadiness(f.established, 2_000);
      expect(starts).toHaveLength(1);
      expect(new Set(observations)).toEqual(new Set([starts[0]!.execId]));
    } finally {
      await f.close();
    }
  }
});

test("transient output observation retries only the exact probe", async () => {
  const f = fixture("lost-read");
  try {
    await waitForSandboxExecReadiness(f.established, 2_000);
    expect(failedRead).toBe(true);
    expect(starts).toHaveLength(1);
    expect(new Set(observations)).toEqual(new Set([starts[0]!.execId]));
  } finally {
    await f.close();
  }
});

test("persistent uncertainty times out without another Start or fallback to SDK", async () => {
  const f = fixture("unobservable");
  try {
    await expect(waitForSandboxExecReadiness(f.established, 300)).rejects.toBeInstanceOf(
      SandboxExecReadinessTimeoutError,
    );
    expect(starts).toHaveLength(1);
    expect(f.sdkStarts()).toBe(0);
  } finally {
    await f.close();
  }
});

test("definitive rejection and failed exit remain failures", async () => {
  for (const selected of ["rejected", "nonzero"] as const) {
    const f = fixture(selected);
    try {
      const error = await waitForSandboxExecReadiness(f.established, 2_000).catch(
        (caught) => caught,
      );
      expect(error).toBeInstanceOf(
        selected === "rejected" ? ModalCommandStartRejectedError : SandboxExecReadinessError,
      );
      if (selected === "nonzero") expect(error.exitCode).toBe(127);
      expect(starts).toHaveLength(1);
    } finally {
      await f.close();
    }
  }
});

test("attempt cancellation stops readiness before dispatch and does not become retry authority", async () => {
  const f = fixture();
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  (f.wire as any).client.waitForReady = () => {
    enter();
  };
  try {
    const result = verifySandboxExecReadiness(f.established, 2_000).catch((error) => error);
    await entered;
    await (f.session as any).cancelPendingExecCommand();
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SandboxExecReadinessError);
    expect(starts).toHaveLength(0);
    expect(f.sdkStarts()).toBe(0);
  } finally {
    await f.close();
  }
});

test("the worker owning signal cancels readiness and fences a late channel-ready callback", async () => {
  const f = fixture();
  const owner = new AbortController();
  const reason = new Error("owning attempt cancelled");
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let ready!: (error?: Error) => void;
  (f.wire as any).client.waitForReady = (_deadline: number, callback: typeof ready) => {
    ready = callback;
    enter();
  };
  try {
    const result = waitForSandboxExecReadiness(f.established, 60_000, {}, owner.signal).catch(
      (caught) => caught,
    );
    await entered;
    owner.abort(reason);
    expect(await result).toBe(reason);
    ready();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(starts).toHaveLength(0);
    expect(f.sdkStarts()).toBe(0);
  } finally {
    await f.close();
  }
});
