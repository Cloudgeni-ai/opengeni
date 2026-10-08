import type { DaytonaCommandProcess } from "./daytona-command-binding";
import { daytonaCommandFrames } from "./daytona-command-frames";

function data(value: unknown, field: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function id(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\x00-\x20]/u.test(value)
  );
}

/** One owned native session, one original command Start. Status/log recovery
 * can observe only this original command; neither deletion nor session absence
 * is completion. The existing controller's marker/PGID owns physical cancel. */
export class DaytonaFramedCommand {
  readonly sessionId = `fs-${crypto.randomUUID()}`;
  readonly frames: ReturnType<typeof daytonaCommandFrames>;
  private commandId: string | undefined;
  private started = false;
  private raw = "";
  private terminal: ReturnType<ReturnType<typeof daytonaCommandFrames>["decode"]> = null;
  private startError: unknown;
  private cleaned = false;
  private cleanupAttempt: Promise<void> | undefined;

  constructor(
    private readonly process: DaytonaCommandProcess,
    command: string,
    nonce: string,
    cwd?: string,
    env?: Record<string, string>,
  ) {
    this.frames = daytonaCommandFrames(command, nonce, cwd, env);
  }

  async start(timeout?: number): Promise<void> {
    if (this.started) throw new Error("Original native command cannot be started again");
    this.started = true;
    try {
      await this.process.createSession(this.sessionId);
      const result = await this.process.executeSessionCommand(
        this.sessionId,
        {
          command: this.frames.command,
          runAsync: true,
          suppressInputEcho: true,
        },
        timeout,
      );
      const commandId = data(result, "cmdId");
      if (!id(commandId)) throw new Error("Native command Start returned no exact identity");
      this.commandId = commandId;
    } catch (error) {
      // Even a lost reply can represent the original Start. Keep this exact
      // session/source identity; reads may recover it, never Start it again.
      this.startError = error;
    }
  }

  async read() {
    if (this.terminal) return this.terminal;
    if (!this.started) throw new Error("Original native command was not dispatched");
    if (!this.commandId) {
      const session = await this.process.getSession(this.sessionId);
      const commands = data(session, "commands");
      if (data(session, "sessionId") !== this.sessionId || !Array.isArray(commands))
        throw new Error("Native command recovery session identity mismatch", {
          cause: this.startError,
        });
      const matching = commands.filter(
        (command) => data(command, "command") === this.frames.command,
      );
      const recovered = matching.length === 1 ? data(matching[0], "id") : undefined;
      if (!id(recovered))
        throw new Error("Original native command identity remains unknown", {
          cause: this.startError,
        });
      this.commandId = recovered;
    }
    const status = await this.process.getSessionCommand(this.sessionId, this.commandId);
    if (data(status, "id") !== this.commandId || data(status, "command") !== this.frames.command)
      throw new Error("Original native command status identity mismatch");
    const exit = data(status, "exitCode");
    if (
      exit !== undefined &&
      exit !== null &&
      (!Number.isSafeInteger(exit) || Number(exit) < 0 || Number(exit) > 255)
    )
      throw new Error("Invalid original native command exit status");
    const logs = await this.process.getSessionCommandLogs(this.sessionId, this.commandId);
    const output = data(logs, "output");
    if (output !== undefined && typeof output !== "string")
      throw new Error("Invalid original native command raw log snapshot");
    const raw = (output as string | undefined) ?? "";
    if (!raw.startsWith(this.raw)) throw new Error("Original native command logs lost continuity");
    const terminal = this.frames.decode(raw, (exit as number | null | undefined) ?? null);
    this.raw = raw;
    this.terminal = terminal;
    return this.terminal;
  }

  async cleanup(): Promise<void> {
    if (!this.terminal)
      throw new Error("Native command output and physical completion remain unknown");
    // Native deletion can suppress termination errors and purge active logs.
    // It is only resource cleanup AFTER independent original exit+both EOF;
    // callers must also have consumed/settled output custody before invoking.
    if (this.cleaned) return;
    const attempt = (this.cleanupAttempt ??= this.deleteNamespace());
    try {
      await attempt;
    } catch (error) {
      if (this.cleanupAttempt === attempt) this.cleanupAttempt = undefined;
      throw error;
    }
  }

  private async deleteNamespace() {
    try {
      await this.process.deleteSession(this.sessionId);
    } catch (error) {
      const { DaytonaNotFoundError } = await import("@daytonaio/sdk");
      // A lost delete reply can be retried after independent framed terminal
      // proof. Typed exact-route 404 proves only namespace cleanup, never exit.
      if (!(error instanceof DaytonaNotFoundError)) throw error;
    }
    this.cleaned = true;
  }
}
