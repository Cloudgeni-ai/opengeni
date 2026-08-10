import { createHash } from "node:crypto";
import type { InteractionError, InteractionOperationState } from "@opengeni/contracts";

export type InteractionControllerErrorCode = InteractionError["code"] | "journal_full";

/** A safe, typed rejection known not to have dispatched a side effect. */
export class InteractionControllerError extends Error {
  constructor(
    readonly code: InteractionControllerErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "InteractionControllerError";
  }
}

/** Driver proof that a dispatched command definitively failed without an ambiguous outcome. */
export class InteractionDefiniteDriverError extends Error {
  constructor(
    readonly code: InteractionError["code"],
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "InteractionDefiniteDriverError";
  }
}

export type InteractionCoreCommand = {
  operationId: string;
  controllerGeneration: string;
  targetId: string;
};

export type InteractionCoreTarget = {
  id: string;
  controllerGeneration: string;
};

export type InteractionCoreObservation<TTarget extends InteractionCoreTarget> = {
  target: TTarget;
};

export type InteractionCoreReceipt<TObservation> = {
  operationId: string;
  controllerGeneration: string;
  targetId: string;
  state: InteractionOperationState;
  dispatchedAt: string | null;
  settledAt: string | null;
  observation: TObservation | null;
  error: InteractionError | null;
};

export type InteractionOperationJournalRecord<TReceipt> = {
  operationId: string;
  commandDigest: string;
  receipt: TReceipt;
};

type InteractionDriver<
  TCommand extends InteractionCoreCommand,
  TTarget extends InteractionCoreTarget,
  TObservation extends InteractionCoreObservation<TTarget>,
> = {
  target(targetId: string): Promise<TTarget | null>;
  observe(targetId: string): Promise<TObservation>;
  validate?(command: TCommand, target: TTarget): Promise<void> | void;
  dispatch(command: TCommand): Promise<TObservation>;
};

type InteractionCoreAdapter<
  TCommand extends InteractionCoreCommand,
  TTarget extends InteractionCoreTarget,
  TObservation extends InteractionCoreObservation<TTarget>,
  TReceipt extends InteractionCoreReceipt<TObservation>,
> = {
  resourceLabel: string;
  parseCommand(value: unknown): TCommand;
  parseTarget(value: unknown): TTarget;
  parseObservation(value: unknown): TObservation;
  parseReceipt(value: unknown): TReceipt;
  assertCommandAuthority(command: TCommand): void;
  assertTargetAuthority(target: TTarget): void;
  assertExpectedGenerations(command: TCommand, target: TTarget): void;
  assertObservationAuthority(observation: TObservation, targetId: string): void;
  makeReceipt(input: {
    command: TCommand;
    state: InteractionOperationState;
    dispatchedAt: string | null;
    settledAt: string | null;
    observation: TObservation | null;
    error: InteractionError | null;
  }): TReceipt;
  recoverReceipt(receipt: TReceipt, settledAt: string): TReceipt;
};

type InteractionCoreAuthority<TCommand> = {
  authorizeDispatch(command: TCommand): Promise<void> | void;
};

export type InteractionControllerCoreOptions<
  TCommand extends InteractionCoreCommand,
  TTarget extends InteractionCoreTarget,
  TObservation extends InteractionCoreObservation<TTarget>,
  TReceipt extends InteractionCoreReceipt<TObservation>,
> = {
  driver: InteractionDriver<TCommand, TTarget, TObservation>;
  adapter: InteractionCoreAdapter<TCommand, TTarget, TObservation, TReceipt>;
  authority?: InteractionCoreAuthority<TCommand>;
  maxJournalEntries?: number;
  now?: () => Date;
  initialJournal?: readonly InteractionOperationJournalRecord<TReceipt>[];
  onJournalRecord?: (record: InteractionOperationJournalRecord<TReceipt>) => Promise<void> | void;
};

type JournalEntry<TReceipt> = InteractionOperationJournalRecord<TReceipt> & {
  completion: Promise<TReceipt>;
  preparationPersisted: Promise<boolean>;
};

const terminalStates = new Set<InteractionOperationState>([
  "completed",
  "failed",
  "outcome_unknown",
]);

/**
 * Resource-neutral placement mutation authority. Public Browser and Computer
 * controllers supply only their schemas and generation semantics; journaling,
 * idempotency, target-local serialization, and crash policy stay identical.
 */
export class InteractionControllerCore<
  TCommand extends InteractionCoreCommand,
  TTarget extends InteractionCoreTarget,
  TObservation extends InteractionCoreObservation<TTarget>,
  TReceipt extends InteractionCoreReceipt<TObservation>,
> {
  private readonly driver: InteractionDriver<TCommand, TTarget, TObservation>;
  private readonly adapter: InteractionCoreAdapter<TCommand, TTarget, TObservation, TReceipt>;
  private readonly authority: InteractionCoreAuthority<TCommand> | undefined;
  private readonly maxJournalEntries: number;
  private readonly now: () => Date;
  private readonly onJournalRecord:
    | ((record: InteractionOperationJournalRecord<TReceipt>) => Promise<void> | void)
    | undefined;
  private readonly journal = new Map<string, JournalEntry<TReceipt>>();
  private readonly targetTails = new Map<string, Promise<void>>();

  constructor(
    options: InteractionControllerCoreOptions<TCommand, TTarget, TObservation, TReceipt>,
  ) {
    this.driver = options.driver;
    this.adapter = options.adapter;
    this.authority = options.authority;
    this.maxJournalEntries = options.maxJournalEntries ?? 10_000;
    this.now = options.now ?? (() => new Date());
    this.onJournalRecord = options.onJournalRecord;
    if (!Number.isSafeInteger(this.maxJournalEntries) || this.maxJournalEntries < 1) {
      throw new Error("maxJournalEntries must be a positive safe integer");
    }
    for (const record of options.initialJournal ?? []) this.restoreJournalRecord(record);
  }

  async observe(targetId: string): Promise<TObservation> {
    const target = await this.requireCurrentTarget(targetId);
    const observed = this.adapter.parseObservation(await this.driver.observe(target.id));
    this.adapter.assertObservationAuthority(observed, target.id);
    return observed;
  }

  run(commandInput: TCommand): Promise<TReceipt> {
    const command = this.adapter.parseCommand(commandInput);
    this.adapter.assertCommandAuthority(command);
    const commandDigest = digestJson(command);
    const existing = this.journal.get(command.operationId);
    if (existing) {
      if (existing.commandDigest !== commandDigest) {
        throw new InteractionControllerError(
          "operation_conflict",
          `operation id is already bound to a different ${this.adapter.resourceLabel} command`,
        );
      }
      return existing.completion;
    }

    this.makeJournalSpace();
    const prepared = this.makeReceipt(command, "prepared", null, null, null, null);
    const entry: JournalEntry<TReceipt> = {
      operationId: command.operationId,
      commandDigest,
      receipt: prepared,
      completion: Promise.resolve(prepared),
      preparationPersisted: this.publish(command.operationId, commandDigest, prepared).then(
        () => true,
        () => false,
      ),
    };
    this.journal.set(command.operationId, entry);

    const previous = this.targetTails.get(command.targetId) ?? Promise.resolve();
    entry.completion = previous.then(async () => await this.execute(entry, command));
    const tail = entry.completion.then(
      () => undefined,
      () => undefined,
    );
    this.targetTails.set(command.targetId, tail);
    void tail.finally(() => {
      if (this.targetTails.get(command.targetId) === tail)
        this.targetTails.delete(command.targetId);
    });
    return entry.completion;
  }

  receipt(operationId: string): TReceipt | null {
    return this.journal.get(operationId)?.receipt ?? null;
  }

  journalSnapshot(): InteractionOperationJournalRecord<TReceipt>[] {
    return [...this.journal.values()].map(({ operationId, commandDigest, receipt }) => ({
      operationId,
      commandDigest,
      receipt,
    }));
  }

  /** Wait until every command already admitted to a target queue settles.
   * Callers must fence new dispatch through `authority` before awaiting this. */
  async waitForIdle(): Promise<void> {
    while (this.targetTails.size > 0) await Promise.all([...this.targetTails.values()]);
  }

  private async execute(entry: JournalEntry<TReceipt>, command: TCommand): Promise<TReceipt> {
    if (!(await entry.preparationPersisted)) {
      return await this.failBeforeDispatch(
        entry,
        command,
        `${this.adapter.resourceLabel} operation journal rejected the command before dispatch`,
      );
    }

    try {
      await this.authority?.authorizeDispatch(command);
      const target = await this.requireCurrentTarget(command.targetId);
      this.adapter.assertExpectedGenerations(command, target);
      await this.driver.validate?.(command, target);
    } catch (error) {
      return await this.settle(
        entry,
        this.makeReceipt(
          command,
          "failed",
          null,
          this.timestamp(),
          null,
          safePredispatchError(error, this.adapter.resourceLabel),
        ),
      );
    }

    const dispatchedAt = this.timestamp();
    const dispatched = this.makeReceipt(command, "dispatched", dispatchedAt, null, null, null);
    try {
      await this.publish(entry.operationId, entry.commandDigest, dispatched);
      entry.receipt = dispatched;
    } catch {
      return await this.failBeforeDispatch(
        entry,
        command,
        `${this.adapter.resourceLabel} operation journal became unavailable before dispatch`,
      );
    }

    try {
      const observation = this.adapter.parseObservation(await this.driver.dispatch(command));
      this.adapter.assertObservationAuthority(observation, command.targetId);
      const completed = this.makeReceipt(
        command,
        "completed",
        dispatchedAt,
        this.timestamp(),
        observation,
        null,
      );
      try {
        await this.publish(entry.operationId, entry.commandDigest, completed);
        entry.receipt = completed;
        return completed;
      } catch {
        return await this.settle(
          entry,
          this.makeReceipt(command, "outcome_unknown", dispatchedAt, this.timestamp(), null, {
            code: "controller_lost",
            message: `${this.adapter.resourceLabel} command completed but its durable outcome could not be recorded`,
            retryable: false,
          }),
        );
      }
    } catch (error) {
      if (error instanceof InteractionDefiniteDriverError) {
        return await this.settle(
          entry,
          this.makeReceipt(command, "failed", dispatchedAt, this.timestamp(), null, {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
          }),
        );
      }
      return await this.settle(
        entry,
        this.makeReceipt(command, "outcome_unknown", dispatchedAt, this.timestamp(), null, {
          code: "controller_lost",
          message: `${this.adapter.resourceLabel} command outcome is unknown after dispatch`,
          retryable: false,
        }),
      );
    }
  }

  private async requireCurrentTarget(targetId: string): Promise<TTarget> {
    const target = await this.driver.target(targetId);
    if (!target) {
      throw new InteractionControllerError(
        "target_not_found",
        `${this.adapter.resourceLabel} target does not exist`,
      );
    }
    const parsed = this.adapter.parseTarget(target);
    this.adapter.assertTargetAuthority(parsed);
    return parsed;
  }

  private makeReceipt(
    command: TCommand,
    state: InteractionOperationState,
    dispatchedAt: string | null,
    settledAt: string | null,
    observation: TObservation | null,
    error: InteractionError | null,
  ): TReceipt {
    return this.adapter.makeReceipt({
      command,
      state,
      dispatchedAt,
      settledAt,
      observation,
      error,
    });
  }

  private async settle(entry: JournalEntry<TReceipt>, receipt: TReceipt): Promise<TReceipt> {
    entry.receipt = receipt;
    try {
      await this.publish(entry.operationId, entry.commandDigest, receipt);
    } catch {
      // Controller-lifetime terminal truth remains authoritative. A restored
      // dispatched receipt is always recovered as outcome_unknown, never replayed.
    }
    return receipt;
  }

  private async failBeforeDispatch(
    entry: JournalEntry<TReceipt>,
    command: TCommand,
    message: string,
  ): Promise<TReceipt> {
    return await this.settle(
      entry,
      this.makeReceipt(command, "failed", null, this.timestamp(), null, {
        code: "driver_failed",
        message,
        retryable: true,
      }),
    );
  }

  private async publish(
    operationId: string,
    commandDigest: string,
    receipt: TReceipt,
  ): Promise<void> {
    await this.onJournalRecord?.({ operationId, commandDigest, receipt });
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private makeJournalSpace(): void {
    while (this.journal.size >= this.maxJournalEntries) {
      const terminal = [...this.journal.entries()].find(([, entry]) =>
        terminalStates.has(entry.receipt.state),
      );
      if (!terminal) {
        throw new InteractionControllerError(
          "journal_full",
          `${this.adapter.resourceLabel} operation journal has no safely evictable terminal entry`,
          true,
        );
      }
      this.journal.delete(terminal[0]);
    }
  }

  private restoreJournalRecord(record: InteractionOperationJournalRecord<TReceipt>): void {
    if (this.journal.has(record.operationId)) {
      throw new Error(`duplicate restored operation id: ${record.operationId}`);
    }
    const parsed = this.adapter.parseReceipt(record.receipt);
    if (parsed.operationId !== record.operationId) {
      throw new Error(`restored operation ${record.operationId} has another receipt id`);
    }
    const receipt = this.adapter.recoverReceipt(parsed, this.timestamp());
    const entry: JournalEntry<TReceipt> = {
      operationId: record.operationId,
      commandDigest: record.commandDigest,
      receipt,
      completion: Promise.resolve(receipt),
      preparationPersisted: Promise.resolve(true),
    };
    this.journal.set(record.operationId, entry);
  }
}

export function recoverInteractionReceipt<TReceipt extends InteractionCoreReceipt<unknown>>(
  receipt: TReceipt,
  settledAt: string,
  resourceLabel: string,
  parse: (value: unknown) => TReceipt,
): TReceipt {
  if (terminalStates.has(receipt.state)) return receipt;
  return parse({
    ...receipt,
    state: receipt.state === "dispatched" ? "outcome_unknown" : "failed",
    settledAt,
    observation: null,
    error:
      receipt.state === "dispatched"
        ? {
            code: "controller_lost",
            message: `${resourceLabel} controller restarted after command dispatch`,
            retryable: false,
          }
        : {
            code: "controller_lost",
            message: `${resourceLabel} controller restarted before command dispatch`,
            retryable: true,
          },
  });
}

function safePredispatchError(error: unknown, resourceLabel: string): InteractionError {
  if (error instanceof InteractionControllerError && error.code !== "journal_full") {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: "driver_failed",
    message: `${resourceLabel} command failed before dispatch`,
    retryable: false,
  };
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    );
  }
  return value;
}
