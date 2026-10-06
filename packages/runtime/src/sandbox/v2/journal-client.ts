import type { SandboxMachineInstance } from "@opengeni/contracts";
import { z } from "zod";
import {
  JOURNAL_PAGE_BYTES,
  JournalCapabilities,
  JournalCommand,
  JournalInputAction,
  JournalInputReply,
  JournalObservation,
  JournalStartRequest,
  journalSpecificationDigest,
} from "./journal-protocol";

export type JournalAction = "start" | "read" | "input" | "cancel";
export interface JournalAuthority {
  /** Atomically retain before dispatch; identical retries return the same binding.
   * The authority is supplied by the worker, never accepted from tool arguments. */
  reserve(command: JournalCommand): Promise<JournalCommand>;
  /** Recheck the exact active attempt or adopted command owner on every call. */
  assert(command: JournalCommand, action: JournalAction): Promise<void>;
}
export interface MachineExecTransport {
  /** Ordinary provider exec, pinned to this physical instance. Never silently
   * create, resume, redirect or retry a different command/instance on failure. */
  exec(input: {
    instanceId: string;
    argv: string[];
    stdin?: Uint8Array;
    signal?: AbortSignal;
  }): Promise<{ exitCode: number; stdout: Uint8Array }>;
}
export class JournalUnavailableError extends Error {
  readonly code = "SANDBOX_V2_COMMAND_UNAVAILABLE";
  constructor(readonly command: JournalCommand | null) {
    super("Exact journal operation is unavailable; retain its dispatch identity");
  }
}
export class JournalBindingError extends Error {
  readonly code = "SANDBOX_V2_COMMAND_BINDING";
}

/** Validate before assigning durable sequence numbers. Invalid actions must not
 * leave a gap that prevents every later input from being accepted. */
export function validateJournalInputAction(
  input: JournalCommand,
  action: JournalInputAction,
): JournalInputAction {
  const command = JournalCommand.parse(input);
  const payload = JournalInputAction.parse(structuredClone(action));
  if (
    !command.stdin ||
    (payload.kind === "resize" && !command.pty) ||
    (payload.kind === "close" && command.pty)
  )
    throw new JournalBindingError("Input action is not supported by this command mode");
  return payload;
}

/** Provider-independent journal transport. Reconnection repeats exactly the same
 * immutable operation or input sequence. Recovery with only a retained locator
 * can read/cancel it; it cannot reconstruct a Start with new credentials. */
export class MachineJournalClient {
  private readonly prefix: string[];
  constructor(
    private readonly binding: { machineId: string; instance: SandboxMachineInstance },
    private readonly transport: MachineExecTransport,
    private readonly authority: JournalAuthority,
    options: { binary?: string; root?: string; supervisor?: string; attempts?: number } = {},
  ) {
    this.binding = structuredClone(binding);
    this.attempts = options.attempts ?? 2;
    if (!Number.isSafeInteger(this.attempts) || this.attempts < 1 || this.attempts > 5)
      throw new JournalBindingError("Invalid journal observation retry count");
    const paths = [
      options.binary ?? "/usr/local/bin/opengeni-run",
      options.root ?? "/var/lib/opengeni-run",
      options.supervisor ?? "/usr/local/bin/opengeni-command-supervisor",
    ];
    if (paths.some((path) => !path.startsWith("/") || path.includes("\0")))
      throw new JournalBindingError("Journal paths must be absolute");
    this.prefix = [paths[0]!, "--root", paths[1]!, "--supervisor", paths[2]!];
  }
  private readonly attempts: number;

  private bound(input: JournalCommand): JournalCommand {
    const command = JournalCommand.parse(input);
    if (command.machineId !== this.binding.machineId)
      throw new JournalBindingError("Journal command belongs to a different machine");
    return command;
  }

  private async call<T>(
    action: string[],
    schema: z.ZodType<T>,
    command: JournalCommand | null,
    authorityAction: JournalAction | null,
    body: Uint8Array | undefined,
    signal?: AbortSignal,
  ): Promise<T> {
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      signal?.throwIfAborted();
      // Authorization errors are never swallowed as transient provider failures.
      if (command && authorityAction) await this.authority.assert(command, authorityAction);
      try {
        const result = await this.transport.exec({
          instanceId: this.binding.instance.id,
          argv: [...this.prefix, ...action],
          ...(body ? { stdin: body.slice() } : {}),
          ...(signal ? { signal } : {}),
        });
        if (result.exitCode !== 0 || result.stdout.byteLength > 3 * JOURNAL_PAGE_BYTES) continue;
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
        return schema.parse(JSON.parse(decoded));
      } catch {
        signal?.throwIfAborted();
        // A bad reply supplies no launch, acceptance or terminal authority. Retry
        // only the same already-bound journal action, including after exit 125.
      }
    }
    throw new JournalUnavailableError(command);
  }

  async capabilities(signal?: AbortSignal): Promise<z.infer<typeof JournalCapabilities>> {
    const capability = await this.call(
      ["capabilities"],
      JournalCapabilities,
      null,
      null,
      undefined,
      signal,
    );
    if (capability.bootId !== this.binding.instance.bootId)
      throw new JournalBindingError("Physical machine changed before journal dispatch");
    return capability;
  }

  async start(
    input: JournalStartRequest,
    signal?: AbortSignal,
  ): Promise<{
    command: JournalCommand;
    observation: JournalObservation;
  }> {
    const request = JournalStartRequest.parse(structuredClone(input));
    if (
      request.bootId !== this.binding.instance.bootId ||
      request.diskLineage !== this.binding.instance.diskLineage
    )
      throw new JournalBindingError("Cannot launch a command on a replacement incarnation");
    const proposed = JournalCommand.parse({
      kind: "machine-journal-v1",
      machineId: this.binding.machineId,
      operationId: request.operationId,
      bootId: request.bootId,
      diskLineage: request.diskLineage,
      specificationDigest: journalSpecificationDigest(request),
      stdin: request.stdin,
      pty: request.pty !== null,
    });
    const command = this.bound(await this.authority.reserve(structuredClone(proposed)));
    if (JSON.stringify(command) !== JSON.stringify(proposed))
      throw new JournalBindingError("Retained command specification conflicts with this launch");
    // Encode once: a caller mutation or credential refresh cannot change a retry.
    const body = Buffer.from(JSON.stringify(request));
    const observation = this.validateObservation(
      command,
      await this.call(["start"], JournalObservation, command, "start", body, signal),
      0,
      0,
    );
    return { command, observation };
  }

  private validateObservation(
    command: JournalCommand,
    observation: JournalObservation,
    stdout: number,
    stderr: number,
    bytes = JOURNAL_PAGE_BYTES,
  ): JournalObservation {
    if (
      observation.operationId !== command.operationId ||
      (observation.specificationDigest !== null &&
        observation.specificationDigest !== command.specificationDigest) ||
      observation.stdout.offset !== stdout ||
      observation.stderr.offset !== stderr ||
      [observation.stdout, observation.stderr].some(
        (page) => page.nextOffset - page.offset > bytes,
      ) ||
      (observation.receipt !== null &&
        ((observation.receipt.acceptedInputSequence !== undefined) !== command.stdin ||
          (observation.receipt.incompleteInputSequence !== undefined && !command.pty)))
    )
      throw new JournalBindingError(
        "Journal response does not match the retained operation or cursor",
      );
    // A retained dispatch may have reached an older disk. Absence supplies no
    // replay permission; a new incarnation's empty cancel tombstone cannot prove
    // that the original invocation never ran or had no external effects.
    if (
      observation.state === "not_found" ||
      (observation.state === "cancelled" &&
        (command.bootId !== this.binding.instance.bootId ||
          command.diskLineage !== this.binding.instance.diskLineage))
    ) {
      return {
        ...observation,
        state: "unknown",
        stdout: { ...observation.stdout, eof: false },
        stderr: { ...observation.stderr, eof: false },
      };
    }
    return observation;
  }

  async read(
    input: JournalCommand,
    cursor: { stdout: number; stderr: number; bytes?: number },
    signal?: AbortSignal,
  ): Promise<JournalObservation> {
    const command = this.bound(input);
    const position = z
      .object({
        stdout: z.number().int().nonnegative().safe(),
        stderr: z.number().int().nonnegative().safe(),
        bytes: z.number().int().min(1).max(JOURNAL_PAGE_BYTES).default(JOURNAL_PAGE_BYTES),
      })
      .strict()
      .parse(cursor);
    const observation = await this.call(
      [
        "read",
        "--operation",
        command.operationId,
        "--stdout",
        String(position.stdout),
        "--stderr",
        String(position.stderr),
        "--bytes",
        String(position.bytes),
        "--boot-id",
        command.bootId,
        "--disk-lineage",
        command.diskLineage,
      ],
      JournalObservation,
      command,
      "read",
      undefined,
      signal,
    );
    return this.validateObservation(
      command,
      observation,
      position.stdout,
      position.stderr,
      position.bytes,
    );
  }

  async input(
    input: JournalCommand,
    sequence: number,
    action: JournalInputAction,
    signal?: AbortSignal,
  ): Promise<JournalInputReply> {
    const command = this.bound(input);
    z.number().int().min(1).safe().parse(sequence);
    const payload = validateJournalInputAction(command, action);
    const body = Buffer.from(
      JSON.stringify({ operationId: command.operationId, sequence, input: payload }),
    );
    const reply = await this.call(["input"], JournalInputReply, command, "input", body, signal);
    if (reply.operationId !== command.operationId || reply.sequence !== sequence)
      throw new JournalBindingError(
        "Input acknowledgement belongs to another operation or sequence",
      );
    return reply;
  }

  async cancel(input: JournalCommand, signal?: AbortSignal): Promise<JournalObservation> {
    const command = this.bound(input);
    const observation = await this.call(
      [
        "cancel",
        "--operation",
        command.operationId,
        "--boot-id",
        command.bootId,
        "--disk-lineage",
        command.diskLineage,
      ],
      JournalObservation,
      command,
      "cancel",
      undefined,
      signal,
    );
    return this.validateObservation(command, observation, 0, 0);
  }
}
