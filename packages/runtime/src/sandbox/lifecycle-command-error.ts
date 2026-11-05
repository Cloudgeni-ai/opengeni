/**
 * A platform lifecycle command (a setup hook's shell command) that ran and
 * exited non-zero. The command started, so the box can run programs; its
 * output says why it failed. Setup reads the exit code and output from this
 * type, never from message text, so an unrelated error that happens to say
 * "failed with exit code" is not mistaken for one.
 */
export class SandboxLifecycleCommandExitError extends Error {
  readonly exitCode: number;
  /** The command's bounded output, possibly empty. */
  readonly output: string;

  constructor(message: string, exitCode: number, output: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SandboxLifecycleCommandExitError";
    this.exitCode = exitCode;
    this.output = output;
  }
}

export function isSandboxLifecycleCommandExitError(
  error: unknown,
): error is SandboxLifecycleCommandExitError {
  return (
    error instanceof SandboxLifecycleCommandExitError ||
    (error instanceof Error &&
      error.name === "SandboxLifecycleCommandExitError" &&
      typeof (error as { exitCode?: unknown }).exitCode === "number")
  );
}
