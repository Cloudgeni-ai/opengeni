import { expect } from "bun:test";
import { Daytona, DaytonaNotFoundError, Process as NativeProcess } from "@daytonaio/sdk";
import { Manifest } from "@openai/agents/sandbox";
import type { DaytonaSandboxClient, DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { daytonaProvider } from "../../src/sandbox/providers/daytona";

type Command = {
  sessionId: string;
  id: string;
  source: string;
  raw: string;
  exitCode?: number;
  done: Promise<void>;
};
type Fault = {
  read?: () => void | Promise<void>;
  logs?: (raw: string) => string;
  status?: (status: { id: string; command: string; exitCode?: number }) => object;
  cleanup?: () => void;
  afterCleanup?: () => void;
  ordinary?: boolean;
  execute?: (source: string) => void;
};
export async function withDaytonaNativeCommand<T>(
  root: string,
  environment: Record<string, string>,
  run: (fixture: {
    session: DaytonaSandboxSession;
    client: DaytonaSandboxClient;
    commands: Command[];
    reads: { sessionId: string; commandId: string }[];
    deleted: string[];
    ordinary: string[];
    pty: string[];
    fault: Fault;
    creates: () => number;
    gets: () => number;
  }) => Promise<T>,
) {
  const commands: Command[] = [];
  const sessions = new Map<string, Command | null>();
  const reads: { sessionId: string; commandId: string }[] = [];
  const deleted: string[] = [];
  const ordinary: string[] = [];
  const pty: string[] = [];
  const fault: Fault = {};
  const command = (sessionId: string, id?: string) => {
    const value = sessions.get(sessionId);
    if (!value) throw new DaytonaNotFoundError("Native session missing");
    if (id !== undefined) expect(value.id).toBe(id);
    reads.push({ sessionId, commandId: value.id });
    return value;
  };
  const native = new NativeProcess(
    { basePath: "https://original-native.invalid" } as ConstructorParameters<typeof NativeProcess>[0],
    {} as ConstructorParameters<typeof NativeProcess>[1],
    {
      executeCommand: async ({ command: source }: { command: string }) => {
        ordinary.push(source);
        fault.execute?.(source);
        // SDK setup is not a user-command replay. Keep filesystem setup inside
        // the owned fixture root; ordinary presentation probes use real pipes.
        if (!fault.ordinary && !source.includes("printf ordinary")) return { data: { exitCode: 0, result: "" } };
        const child = Bun.spawn(["/bin/sh", "-c", source], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return { data: { exitCode, result: stdout + stderr } };
      },
      createSession: async ({ sessionId }: { sessionId: string }) => {
        expect(sessions.has(sessionId)).toBe(false);
        sessions.set(sessionId, null);
        return { data: {} };
      },
      sessionExecuteCommand: async (sessionId: string, request: { command: string; runAsync: boolean; suppressInputEcho: boolean }) => {
        expect(sessions.has(sessionId)).toBe(true);
        expect(sessions.get(sessionId)).toBeNull();
        expect(request.runAsync).toBe(true);
        expect(request.suppressInputEcho).toBe(true);
        const value: Command = { sessionId, id: crypto.randomUUID(), source: request.command, raw: "", done: Promise.resolve() };
        sessions.set(sessionId, value);
        commands.push(value);
        const child = Bun.spawn(["/bin/sh", "-c", request.command], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        const label = async (input: ReadableStream<Uint8Array>, byte: string) => {
          let pending = "";
          const decoder = new TextDecoder("utf-8", { fatal: true });
          for await (const chunk of input) {
            pending += decoder.decode(chunk, { stream: true });
            let newline = pending.indexOf("\n");
            while (newline !== -1) {
              value.raw += byte.repeat(3) + pending.slice(0, newline + 1);
              pending = pending.slice(newline + 1);
              newline = pending.indexOf("\n");
            }
          }
          pending += decoder.decode();
          if (pending) value.raw += byte.repeat(3) + pending + "\n";
        };
        value.done = Promise.all([
          label(child.stdout, "\x01"), label(child.stderr, "\x02"),
          child.exited.then((exitCode) => { value.exitCode = exitCode; }),
        ]).then(() => {});
        return { data: { cmdId: value.id } };
      },
      getSession: async (sessionId: string) => {
        const value = command(sessionId);
        return { data: { sessionId, commands: [{ id: value.id, command: value.source, exitCode: value.exitCode }] } };
      },
      getSessionCommand: async (sessionId: string, id: string) => {
        await fault.read?.();
        const value = command(sessionId, id);
        const status = { id, command: value.source, exitCode: value.exitCode };
        return { data: fault.status ? fault.status(status) : status };
      },
      getSessionCommandLogs: async (sessionId: string, id: string) => {
        const value = command(sessionId, id);
        return { data: fault.logs ? fault.logs(value.raw) : value.raw };
      },
      deleteSession: async (sessionId: string) => {
        fault.cleanup?.();
        const value = command(sessionId);
        expect(value.exitCode).toBeNumber();
        // Never used as termination proof: the fixture deliberately does not
        // kill or join a process merely because delete succeeds.
        deleted.push(sessionId);
        sessions.delete(sessionId);
        fault.afterCleanup?.();
        return { data: {} };
      },
    } as unknown as ConstructorParameters<typeof NativeProcess>[2],
    async () => { throw new Error("no new transport authentication"); },
  );
  Object.defineProperty(native, "createPty", { value: async (options: { id: string; onData: (data: Uint8Array) => void }) => {
    let complete!: (value: { exitCode: number }) => void;
    const done = new Promise<{ exitCode: number }>((resolve) => { complete = resolve; });
    return {
      sessionId: options.id,
      waitForConnection: async () => {},
      sendInput: async (source: string) => { pty.push(source); options.onData(Buffer.from("ordinary-pty\n")); complete({ exitCode: 0 }); },
      wait: () => done,
      disconnect: async () => {}, kill: async () => { complete({ exitCode: 143 }); },
    };
  } });
  const sandbox = {
    id: "sb-original-native",
    target: "original-target",
    process: native,
    start: async () => {}, stop: async () => {}, delete: async () => {},
    fs: { createFolder: async () => {}, uploadFile: async () => {}, downloadFile: async () => Buffer.alloc(0), deleteFile: async () => {} },
  };
  const descriptors = {
    create: Object.getOwnPropertyDescriptor(Daytona.prototype, "create")!,
    get: Object.getOwnPropertyDescriptor(Daytona.prototype, "get")!,
  };
  let creates = 0;
  let gets = 0;
  const principal = (client: object) => {
    for (const [key, value] of Object.entries({ apiKey: "frozen-native-fixture", apiUrl: "https://original-native.invalid", target: "original-target" }))
      expect(Object.getOwnPropertyDescriptor(client, key)?.value).toBe(value);
  };
  Object.defineProperty(Daytona.prototype, "create", { ...descriptors.create, value: async function (this: object, args: { image: string }) { principal(this); expect(args.image).toBe("debian:12.9"); creates++; return sandbox; } });
  Object.defineProperty(Daytona.prototype, "get", { ...descriptors.get, value: async function (this: object, id: string) { principal(this); expect(id).toBe(sandbox.id); gets++; return sandbox; } });
  let session: DaytonaSandboxSession | undefined;
  try {
    const client = daytonaProvider.build({
      settings: { daytonaApiKey: "frozen-native-fixture", daytonaApiUrl: "https://original-native.invalid", daytonaTarget: "original-target" } as unknown as Parameters<typeof daytonaProvider.build>[0]["settings"],
      environment, exposedPorts: [],
    }) as DaytonaSandboxClient;
    session = await client.create(new Manifest({ root }));
    return await run({ session, client, commands, reads, deleted, ordinary, pty, fault, creates: () => creates, gets: () => gets });
  } finally {
    await session?.close();
    await Promise.all(commands.map((value) => value.done));
    Object.defineProperty(Daytona.prototype, "create", descriptors.create);
    Object.defineProperty(Daytona.prototype, "get", descriptors.get);
  }
}
