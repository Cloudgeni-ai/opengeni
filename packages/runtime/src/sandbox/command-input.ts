/** Stdin is a mutation capability, separate from read-only command observation.
 * The caller must resolve and authorize the command's owning session first. */
export type CommandInputSession = {
  commandCancellationTransport?(): Promise<"remote_operation" | "shell_session">;
  supportsCommandInput?(providerSessionId: number): boolean;
  writeStdinForProcessMutation?(args: CommandInputArgs & { yieldTimeMs: number }): Promise<string>;
  writeStdin?(args: CommandInputArgs & { yieldTimeMs: number }): Promise<string>;
};

type CommandInputArgs = { sessionId: number; chars: string };

export async function sendCommandInput(
  session: CommandInputSession,
  input: { providerSessionId: number; chars: string },
): Promise<{ supported: true; result: string } | { supported: false; reason: string }> {
  if (!Number.isSafeInteger(input.providerSessionId) || input.providerSessionId < 0) {
    throw new Error("Command input requires a valid provider session locator");
  }
  if (typeof input.chars !== "string" || input.chars.length === 0) {
    throw new Error("Command input requires nonempty chars; use command_read for observation");
  }
  if (
    !session.supportsCommandInput &&
    (await session.commandCancellationTransport?.()) === "remote_operation"
  ) {
    return {
      supported: false,
      reason: "Connected Machine commands do not support stdin transport",
    };
  }
  if (session.supportsCommandInput?.(input.providerSessionId) === false) {
    return {
      supported: false,
      reason: "This provider does not support stdin for the retained command",
    };
  }
  const write = session.writeStdinForProcessMutation ?? session.writeStdin;
  if (!write) return { supported: false, reason: "This provider has no command stdin capability" };
  return {
    supported: true,
    result: await write.call(session, {
      sessionId: input.providerSessionId,
      chars: input.chars,
      yieldTimeMs: 0,
    }),
  };
}
