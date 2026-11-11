/**
 * Any E2B-compatible service through the E2B JavaScript SDK (2.56.0): E2B's
 * own cloud when `E2B_API_KEY` is set, or Opengeni compute's front door when
 * `domain` or `apiUrl` points at it. Commands stream their output, so the
 * first byte is timed when the SDK hands over the first stdout chunk.
 */
import type { CreateKind, RunResult, Sandbox, System } from "./system.ts";

export interface E2bOptions {
  apiKey: string;
  /** The service's base domain; E2B's own when unset. */
  domain?: string;
  apiUrl?: string;
  sandboxUrl?: string;
  template?: string;
  name?: string;
  timeoutMs?: number;
}

// The SDK's own types stay out of the rest of the harness; this is the part we use.
interface SdkSandbox {
  sandboxId: string;
  commands: {
    run(
      command: string,
      opts: { onStdout: (data: string) => void; timeoutMs?: number },
    ): Promise<{ stdout: string; exitCode: number }>;
  };
  pause(): Promise<boolean>;
  kill(): Promise<boolean>;
}

interface SdkClass {
  create(template: string, opts: object): Promise<SdkSandbox>;
  connect(sandboxId: string, opts: object): Promise<SdkSandbox>;
  list(opts: object): { hasNext: boolean; nextItems(): Promise<{ sandboxId: string }[]> };
}

export interface E2bSandbox extends Sandbox {
  handle: SdkSandbox;
  paused: boolean;
}

export class E2b implements System<E2bSandbox> {
  readonly name: string;
  readonly restLevels = ["running", "paused"] as const;
  private sdk?: SdkClass;
  private readonly connection: object;
  private readonly template: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: E2bOptions) {
    this.name = options.name ?? "e2b";
    this.template = options.template ?? "base";
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.connection = {
      apiKey: options.apiKey,
      ...(options.domain ? { domain: options.domain } : {}),
      ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
      ...(options.sandboxUrl ? { sandboxUrl: options.sandboxUrl } : {}),
      requestTimeoutMs: this.timeoutMs,
    };
  }

  private async load(): Promise<SdkClass> {
    this.sdk ??= ((await import("e2b")) as unknown as { Sandbox: SdkClass }).Sandbox;
    return this.sdk;
  }

  /** E2B creates every sandbox from its template's snapshot, so `kind` only labels the run. */
  async create(_kind: CreateKind, script: string, started: number) {
    const sdk = await this.load();
    const handle = await sdk.create(this.template, { ...this.connection, timeoutMs: 3_600_000 });
    const createdMs = performance.now() - started;
    const sandbox: E2bSandbox = { id: handle.sandboxId, handle, paused: false };
    try {
      const run = await this.command(sandbox, script, started);
      run.phases.created_ms = createdMs;
      return { sandbox, run };
    } catch (error) {
      // The caller never learns the sandbox, so it cannot remove it.
      await this.remove(sandbox).catch(() => undefined);
      throw error;
    }
  }

  async run(sandbox: E2bSandbox, script: string, started: number): Promise<RunResult> {
    let resumedMs: number | undefined;
    if (sandbox.paused) {
      const sdk = await this.load();
      sandbox.handle = await sdk.connect(sandbox.id, { ...this.connection, timeoutMs: 3_600_000 });
      sandbox.paused = false;
      resumedMs = performance.now() - started;
    }
    const run = await this.command(sandbox, script, started);
    if (resumedMs !== undefined) run.phases.resumed_ms = resumedMs;
    return run;
  }

  private async command(sandbox: E2bSandbox, script: string, started: number): Promise<RunResult> {
    let firstByteMs: number | undefined;
    const result = await sandbox.handle.commands.run(script, {
      onStdout: () => {
        firstByteMs ??= performance.now() - started;
      },
      timeoutMs: this.timeoutMs,
    });
    const doneMs = performance.now() - started;
    return {
      firstByteMs: firstByteMs ?? doneMs,
      doneMs,
      output: result.stdout,
      status: result.exitCode,
      phases: {},
    };
  }

  async rest(sandbox: E2bSandbox, level: string): Promise<void> {
    if (level === "running") return;
    if (level !== "paused") throw new Error(`unknown level ${level}`);
    if (!sandbox.paused) {
      await sandbox.handle.pause();
      sandbox.paused = true;
    }
  }

  async remove(sandbox: E2bSandbox): Promise<void> {
    if (sandbox.paused) {
      const sdk = await this.load();
      sandbox.handle = await sdk.connect(sandbox.id, this.connection);
    }
    await sandbox.handle.kill();
  }

  async list(): Promise<string[]> {
    const sdk = await this.load();
    const pages = sdk.list(this.connection);
    const ids: string[] = [];
    while (pages.hasNext) ids.push(...(await pages.nextItems()).map((item) => item.sandboxId));
    return ids;
  }

  async describe(): Promise<Record<string, unknown>> {
    return {
      system: this.name,
      sdk: "e2b 2.56.0",
      template: this.template,
      domain: this.options.domain ?? "default",
    };
  }

  async close(): Promise<void> {}
}
