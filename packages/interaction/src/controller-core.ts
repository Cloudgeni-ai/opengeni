import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
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

/** Driver proof that dispatch occurred but the exact native outcome could not
 * be confirmed. Unlike an arbitrary transport exception, this preserves the
 * adapter's bounded, user-actionable diagnosis without pretending certainty. */
export class InteractionOutcomeUnknownDriverError extends Error {
  constructor(
    readonly code: InteractionError["code"],
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "InteractionOutcomeUnknownDriverError";
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
  dispatch(command: TCommand): Promise<TObservation | null>;
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
  initialJournal?: Iterable<InteractionOperationJournalRecord<TReceipt>>;
  onJournalRecord?: (record: InteractionOperationJournalRecord<TReceipt>) => Promise<void> | void;
  /** Read the same durable journal used by onJournalRecord. Terminal receipts
   * may leave RAM only after that writer succeeds. Missing/corrupt reads fail
   * closed and never cause a command to dispatch again. */
  loadJournalRecord?: (operationId: string) => InteractionOperationJournalRecord<TReceipt> | null;
  /** Override only when a private command contains ephemeral secret material.
   * The callback must bind every non-secret semantic input while excluding the
   * value bytes themselves and return lowercase SHA-256. */
  commandDigest?: (command: TCommand) => string;
};

type JournalEntry<TReceipt> = InteractionOperationJournalRecord<TReceipt> & {
  kind: "materialized";
  completion: Promise<TReceipt>;
  preparationPersisted: Promise<boolean>;
  terminalPersisted: boolean;
};

type PersistedJournalEntry = {
  kind: "persisted";
  operationId: string;
  commandDigest: string;
  state: InteractionOperationState;
  receiptDigest: string;
};

type CompactJournalEntry = {
  kind: "compact";
  operationId: string;
  commandDigest: string;
  state: InteractionOperationState;
  receiptBytes: number;
  compressedReceipt: Uint8Array;
};

// Keep small receipts and all in-flight promises untouched. Large settled AX
// trees otherwise remain live as thousands of JS objects per past operation.
const COMPACT_RECEIPT_MIN_BYTES = 16 * 1024;

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
  private readonly commandDigest: (command: TCommand) => string;
  private readonly loadJournalRecord:
    | ((operationId: string) => InteractionOperationJournalRecord<TReceipt> | null)
    | undefined;
  private readonly journal = new Map<
    string,
    JournalEntry<TReceipt> | CompactJournalEntry | PersistedJournalEntry
  >();
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
    this.loadJournalRecord = options.loadJournalRecord;
    this.commandDigest = options.commandDigest ?? digestJson;
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
    const commandDigest = this.commandDigest(command);
    if (!/^[0-9a-f]{64}$/u.test(commandDigest)) {
      throw new Error(`${this.adapter.resourceLabel} command digest must be lowercase SHA-256`);
    }
    const existing = this.journal.get(command.operationId);
    if (existing) {
      if (existing.commandDigest !== commandDigest) {
        throw new InteractionControllerError(
          "operation_conflict",
          `operation id is already bound to a different ${this.adapter.resourceLabel} command`,
        );
      }
      return existing.kind === "materialized"
        ? existing.completion
        : Promise.resolve(this.readReceipt(existing));
    }

    this.makeJournalSpace();
    const prepared = this.makeReceipt(command, "prepared", null, null, null, null);
    const entry: JournalEntry<TReceipt> = {
      kind: "materialized",
      operationId: command.operationId,
      commandDigest,
      receipt: prepared,
      terminalPersisted: false,
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
      this.compactJournalEntry(entry);
    });
    return entry.completion;
  }

  receipt(operationId: string): TReceipt | null {
    const entry = this.journal.get(operationId);
    return entry ? this.readReceipt(entry) : null;
  }

  journalSnapshot(): InteractionOperationJournalRecord<TReceipt>[] {
    return [...this.journal.values()].map((entry) => ({
      operationId: entry.operationId,
      commandDigest: entry.commandDigest,
      receipt: this.readReceipt(entry),
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
      const dispatchedObservation = await this.driver.dispatch(command);
      const observation =
        dispatchedObservation === null
          ? null
          : this.adapter.parseObservation(dispatchedObservation);
      if (observation) this.adapter.assertObservationAuthority(observation, command.targetId);
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
        entry.terminalPersisted = this.onJournalRecord !== undefined;
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
      if (error instanceof InteractionOutcomeUnknownDriverError) {
        return await this.settle(
          entry,
          this.makeReceipt(command, "outcome_unknown", dispatchedAt, this.timestamp(), null, {
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
      entry.terminalPersisted = this.onJournalRecord !== undefined;
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
        terminalStates.has(entry.kind === "materialized" ? entry.receipt.state : entry.state),
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
      kind: "materialized",
      operationId: record.operationId,
      commandDigest: record.commandDigest,
      receipt,
      terminalPersisted: terminalStates.has(parsed.state),
      completion: Promise.resolve(receipt),
      preparationPersisted: Promise.resolve(true),
    };
    this.journal.set(record.operationId, entry);
    this.compactJournalEntry(entry);
  }

  private readReceipt(
    entry: JournalEntry<TReceipt> | CompactJournalEntry | PersistedJournalEntry,
  ): TReceipt {
    if (entry.kind === "materialized") return entry.receipt;
    if (entry.kind === "persisted") {
      const record = this.loadJournalRecord?.(entry.operationId);
      if (
        !record ||
        record.operationId !== entry.operationId ||
        record.commandDigest !== entry.commandDigest
      ) {
        throw new Error(`${this.adapter.resourceLabel} durable operation receipt is unavailable`);
      }
      const receipt = this.adapter.parseReceipt(record.receipt);
      if (digestJson(receipt) !== entry.receiptDigest) {
        throw new Error(`${this.adapter.resourceLabel} durable operation receipt changed`);
      }
      return receipt;
    }
    const json = inflateRawSync(entry.compressedReceipt, {
      maxOutputLength: entry.receiptBytes,
    });
    return this.adapter.parseReceipt(JSON.parse(json.toString("utf8")));
  }

  private compactJournalEntry(entry: JournalEntry<TReceipt>): void {
    if (this.journal.get(entry.operationId) !== entry || !terminalStates.has(entry.receipt.state))
      return;
    try {
      if (entry.terminalPersisted && this.loadJournalRecord) {
        this.journal.set(entry.operationId, {
          kind: "persisted",
          operationId: entry.operationId,
          commandDigest: entry.commandDigest,
          state: entry.receipt.state,
          receiptDigest: digestJson(entry.receipt),
        });
        return;
      }
      const json = JSON.stringify(entry.receipt);
      const receiptBytes = Buffer.byteLength(json);
      if (receiptBytes < COMPACT_RECEIPT_MIN_BYTES) return;
      const compressedReceipt = deflateRawSync(json, { level: 1 });
      this.journal.set(entry.operationId, {
        kind: "compact",
        operationId: entry.operationId,
        commandDigest: entry.commandDigest,
        state: entry.receipt.state,
        receiptBytes,
        compressedReceipt,
      });
    } catch {
      // Cache optimization must never change a settled mutation's outcome.
      // Retain the original receipt if serialization/compression is unavailable.
    }
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
