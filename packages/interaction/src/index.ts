import { createHash } from "node:crypto";
import {
  BrowserActionCommand,
  BrowserActionReceipt,
  BrowserObservation,
  BrowserProtectedAuthFillCommand,
  BrowserProtectedAuthFillReceipt,
  BrowserProtectedAuthObservation,
  BrowserTarget,
  ComputerActionCommand,
  ComputerActionReceipt,
  ComputerObservation,
  ComputerTarget,
  type BrowserActionCommand as BrowserActionCommandValue,
  type BrowserActionReceipt as BrowserActionReceiptValue,
  type BrowserObservation as BrowserObservationValue,
  type BrowserProtectedAuthFillCommand as BrowserProtectedAuthFillCommandValue,
  type BrowserProtectedAuthFillReceipt as BrowserProtectedAuthFillReceiptValue,
  type BrowserProtectedAuthObservation as BrowserProtectedAuthObservationValue,
  type BrowserTarget as BrowserTargetValue,
  type ComputerActionCommand as ComputerActionCommandValue,
  type ComputerActionReceipt as ComputerActionReceiptValue,
  type ComputerObservation as ComputerObservationValue,
  type ComputerTarget as ComputerTargetValue,
} from "@opengeni/contracts";
import {
  InteractionControllerCore,
  InteractionControllerError,
  InteractionDefiniteDriverError,
  recoverInteractionReceipt,
  type InteractionControllerErrorCode,
  type InteractionOperationJournalRecord,
} from "./controller-core";

export {
  InteractionControllerError,
  InteractionDefiniteDriverError,
  type InteractionControllerErrorCode,
};

export type BrowserInteractionDriver = {
  target(targetId: string): Promise<BrowserTargetValue | null>;
  observe(targetId: string): Promise<BrowserObservationValue>;
  validate?(command: BrowserActionCommandValue, target: BrowserTargetValue): Promise<void> | void;
  dispatch(command: BrowserActionCommandValue): Promise<BrowserObservationValue | null>;
};

export type BrowserInteractionAuthority = {
  authorizeDispatch(command: BrowserActionCommandValue): Promise<void> | void;
};

export type BrowserOperationJournalRecord =
  InteractionOperationJournalRecord<BrowserActionReceiptValue>;

export type BrowserInteractionControllerOptions = {
  browserSessionId: string;
  controllerGeneration: string;
  driver: BrowserInteractionDriver;
  authority?: BrowserInteractionAuthority;
  maxJournalEntries?: number;
  now?: () => Date;
  initialJournal?: readonly BrowserOperationJournalRecord[];
  onJournalRecord?: (record: BrowserOperationJournalRecord) => Promise<void> | void;
};

/** Placement-resident BrowserSession mutation authority. */
export class BrowserInteractionController {
  private readonly core: InteractionControllerCore<
    BrowserActionCommandValue,
    BrowserTargetValue,
    BrowserObservationValue,
    BrowserActionReceiptValue
  >;

  constructor(options: BrowserInteractionControllerOptions) {
    const { browserSessionId, controllerGeneration } = options;
    this.core = new InteractionControllerCore({
      driver: options.driver,
      ...(options.authority ? { authority: options.authority } : {}),
      ...(options.maxJournalEntries !== undefined
        ? { maxJournalEntries: options.maxJournalEntries }
        : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.initialJournal ? { initialJournal: options.initialJournal } : {}),
      ...(options.onJournalRecord ? { onJournalRecord: options.onJournalRecord } : {}),
      adapter: {
        resourceLabel: "browser",
        parseCommand: (value) => BrowserActionCommand.parse(value),
        parseTarget: (value) => BrowserTarget.parse(value),
        parseObservation: (value) => BrowserObservation.parse(value),
        parseReceipt: (value) => BrowserActionReceipt.parse(value),
        assertCommandAuthority(command) {
          if (command.browserSessionId !== browserSessionId) {
            throw new InteractionControllerError(
              "resource_not_found",
              "browser command targets another browser session",
            );
          }
          if (command.controllerGeneration !== controllerGeneration) {
            throw new InteractionControllerError(
              "controller_stale",
              "browser command targets a stale controller generation",
            );
          }
        },
        assertTargetAuthority(target) {
          if (
            target.browserSessionId !== browserSessionId ||
            target.controllerGeneration !== controllerGeneration
          ) {
            throw new InteractionControllerError(
              "controller_stale",
              "browser target belongs to a stale controller generation",
            );
          }
        },
        assertExpectedGenerations(command, target) {
          if (command.expectedTargetGeneration !== target.targetGeneration) {
            throw new InteractionControllerError(
              "target_stale",
              "browser target changed before the command could dispatch",
            );
          }
          if (command.expectedDocumentGeneration !== target.documentGeneration) {
            throw new InteractionControllerError(
              "document_stale",
              "browser document changed before the command could dispatch",
            );
          }
        },
        assertObservationAuthority(observation, targetId) {
          if (
            observation.browserSessionId !== browserSessionId ||
            observation.target.id !== targetId ||
            observation.target.browserSessionId !== browserSessionId ||
            observation.target.controllerGeneration !== controllerGeneration
          ) {
            throw new InteractionControllerError(
              "driver_failed",
              "browser driver returned an observation outside controller authority",
            );
          }
        },
        makeReceipt(input) {
          return BrowserActionReceipt.parse({
            protocolVersion: 1,
            operationId: input.command.operationId,
            browserSessionId,
            controllerGeneration,
            targetId: input.command.targetId,
            state: input.state,
            dispatchedAt: input.dispatchedAt,
            settledAt: input.settledAt,
            observation: input.observation,
            error: input.error,
          });
        },
        recoverReceipt(receipt, settledAt) {
          if (
            receipt.browserSessionId !== browserSessionId ||
            receipt.controllerGeneration !== controllerGeneration
          ) {
            throw new Error(
              `restored operation ${receipt.operationId} is outside controller authority`,
            );
          }
          return recoverInteractionReceipt(receipt, settledAt, "browser", (value) =>
            BrowserActionReceipt.parse(value),
          );
        },
      },
    });
  }

  observe(targetId: string): Promise<BrowserObservationValue> {
    return this.core.observe(targetId);
  }

  run(command: BrowserActionCommandValue): Promise<BrowserActionReceiptValue> {
    return this.core.run(command);
  }

  receipt(operationId: string): BrowserActionReceiptValue | null {
    return this.core.receipt(operationId);
  }

  journalSnapshot(): BrowserOperationJournalRecord[] {
    return this.core.journalSnapshot();
  }

  waitForIdle(): Promise<void> {
    return this.core.waitForIdle();
  }
}

export function recoverBrowserOperationJournalRecord(
  record: BrowserOperationJournalRecord,
  settledAt: string,
): BrowserOperationJournalRecord {
  const receipt = BrowserActionReceipt.parse(record.receipt);
  return {
    ...record,
    receipt: recoverInteractionReceipt(receipt, settledAt, "browser", (value) =>
      BrowserActionReceipt.parse(value),
    ),
  };
}

export type BrowserProtectedAuthDriver = {
  target(targetId: string): Promise<BrowserTargetValue | null>;
  observe(targetId: string): Promise<BrowserProtectedAuthObservationValue>;
  validate?(
    command: BrowserProtectedAuthFillCommandValue,
    target: BrowserTargetValue,
  ): Promise<void> | void;
  dispatch(
    command: BrowserProtectedAuthFillCommandValue,
  ): Promise<BrowserProtectedAuthObservationValue>;
};

export type BrowserProtectedAuthAuthority = {
  authorizeDispatch(command: BrowserProtectedAuthFillCommandValue): Promise<void> | void;
};

export type BrowserProtectedAuthOperationJournalRecord =
  InteractionOperationJournalRecord<BrowserProtectedAuthFillReceiptValue>;

export type BrowserProtectedAuthControllerOptions = {
  browserSessionId: string;
  controllerGeneration: string;
  driver: BrowserProtectedAuthDriver;
  authority?: BrowserProtectedAuthAuthority;
  maxJournalEntries?: number;
  now?: () => Date;
  initialJournal?: readonly BrowserProtectedAuthOperationJournalRecord[];
  onJournalRecord?: (record: BrowserProtectedAuthOperationJournalRecord) => Promise<void> | void;
};

/** Secret-bearing commands are admitted only through this controller-private
 * authority. Its durable digest binds all semantics plus credential version,
 * but deliberately excludes ephemeral password/TOTP value bytes. */
export class BrowserProtectedAuthController {
  private readonly core: InteractionControllerCore<
    BrowserProtectedAuthFillCommandValue,
    BrowserTargetValue,
    BrowserProtectedAuthObservationValue,
    BrowserProtectedAuthFillReceiptValue
  >;

  constructor(options: BrowserProtectedAuthControllerOptions) {
    const { browserSessionId, controllerGeneration } = options;
    this.core = new InteractionControllerCore({
      driver: options.driver,
      ...(options.authority ? { authority: options.authority } : {}),
      ...(options.maxJournalEntries !== undefined
        ? { maxJournalEntries: options.maxJournalEntries }
        : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.initialJournal ? { initialJournal: options.initialJournal } : {}),
      ...(options.onJournalRecord ? { onJournalRecord: options.onJournalRecord } : {}),
      commandDigest: protectedAuthCommandDigest,
      adapter: {
        resourceLabel: "browser protected fill",
        parseCommand: (value) => BrowserProtectedAuthFillCommand.parse(value),
        parseTarget: (value) => BrowserTarget.parse(value),
        parseObservation: (value) => BrowserProtectedAuthObservation.parse(value),
        parseReceipt: (value) => BrowserProtectedAuthFillReceipt.parse(value),
        assertCommandAuthority(command) {
          if (command.browserSessionId !== browserSessionId) {
            throw new InteractionControllerError(
              "resource_not_found",
              "protected fill targets another browser session",
            );
          }
          if (command.controllerGeneration !== controllerGeneration) {
            throw new InteractionControllerError(
              "controller_stale",
              "protected fill targets a stale browser controller",
            );
          }
        },
        assertTargetAuthority(target) {
          if (
            target.browserSessionId !== browserSessionId ||
            target.controllerGeneration !== controllerGeneration
          ) {
            throw new InteractionControllerError(
              "controller_stale",
              "protected-fill target belongs to a stale browser controller",
            );
          }
        },
        assertExpectedGenerations(command, target) {
          if (command.expectedTargetGeneration !== target.targetGeneration) {
            throw new InteractionControllerError(
              "target_stale",
              "browser target changed before protected fill",
            );
          }
          if (command.expectedDocumentGeneration !== target.documentGeneration) {
            throw new InteractionControllerError(
              "document_stale",
              "browser document changed before protected fill",
            );
          }
        },
        assertObservationAuthority(observation, targetId) {
          if (
            observation.target.id !== targetId ||
            observation.target.browserSessionId !== browserSessionId ||
            observation.target.controllerGeneration !== controllerGeneration
          ) {
            throw new InteractionControllerError(
              "driver_failed",
              "protected-fill driver returned a result outside controller authority",
            );
          }
        },
        makeReceipt(input) {
          return BrowserProtectedAuthFillReceipt.parse({
            protocolVersion: 1,
            operationId: input.command.operationId,
            browserSessionId,
            controllerGeneration,
            targetId: input.command.targetId,
            state: input.state,
            dispatchedAt: input.dispatchedAt,
            settledAt: input.settledAt,
            observation: input.observation,
            error: input.error,
          });
        },
        recoverReceipt(receipt, settledAt) {
          if (
            receipt.browserSessionId !== browserSessionId ||
            receipt.controllerGeneration !== controllerGeneration
          ) {
            throw new Error(
              `restored protected-fill operation ${receipt.operationId} is outside controller authority`,
            );
          }
          return recoverInteractionReceipt(receipt, settledAt, "browser protected fill", (value) =>
            BrowserProtectedAuthFillReceipt.parse(value),
          );
        },
      },
    });
  }

  run(
    command: BrowserProtectedAuthFillCommandValue,
  ): Promise<BrowserProtectedAuthFillReceiptValue> {
    return this.core.run(command);
  }

  receipt(operationId: string): BrowserProtectedAuthFillReceiptValue | null {
    return this.core.receipt(operationId);
  }

  journalSnapshot(): BrowserProtectedAuthOperationJournalRecord[] {
    return this.core.journalSnapshot();
  }

  waitForIdle(): Promise<void> {
    return this.core.waitForIdle();
  }
}

export function recoverBrowserProtectedAuthOperationJournalRecord(
  record: BrowserProtectedAuthOperationJournalRecord,
  settledAt: string,
): BrowserProtectedAuthOperationJournalRecord {
  const receipt = BrowserProtectedAuthFillReceipt.parse(record.receipt);
  return {
    ...record,
    receipt: recoverInteractionReceipt(receipt, settledAt, "browser protected fill", (value) =>
      BrowserProtectedAuthFillReceipt.parse(value),
    ),
  };
}

function protectedAuthCommandDigest(command: BrowserProtectedAuthFillCommandValue): string {
  const { fields, ...metadata } = command;
  const secretFree = {
    ...metadata,
    fields: fields.map(({ value: _value, ...field }) => field),
  };
  return createHash("sha256").update(canonicalJson(secretFree), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    );
  }
  return value;
}

export type ComputerInteractionDriver = {
  target(targetId: string): Promise<ComputerTargetValue | null>;
  observe(targetId: string): Promise<ComputerObservationValue>;
  validate?(command: ComputerActionCommandValue, target: ComputerTargetValue): Promise<void> | void;
  dispatch(command: ComputerActionCommandValue): Promise<ComputerObservationValue>;
};

export type ComputerInteractionAuthority = {
  authorizeDispatch(command: ComputerActionCommandValue): Promise<void> | void;
};

export type ComputerOperationJournalRecord =
  InteractionOperationJournalRecord<ComputerActionReceiptValue>;

export type ComputerInteractionControllerOptions = {
  computerSessionId: string;
  controllerGeneration: string;
  driver: ComputerInteractionDriver;
  authority?: ComputerInteractionAuthority;
  maxJournalEntries?: number;
  now?: () => Date;
  initialJournal?: readonly ComputerOperationJournalRecord[];
  onJournalRecord?: (record: ComputerOperationJournalRecord) => Promise<void> | void;
};

/** Placement-resident ComputerSession mutation authority. Linux AT-SPI/X11,
 * macOS AX/ScreenCaptureKit, and later UIA adapters share this exact core. */
export class ComputerInteractionController {
  private readonly core: InteractionControllerCore<
    ComputerActionCommandValue,
    ComputerTargetValue,
    ComputerObservationValue,
    ComputerActionReceiptValue
  >;

  constructor(options: ComputerInteractionControllerOptions) {
    const { computerSessionId, controllerGeneration } = options;
    this.core = new InteractionControllerCore({
      driver: options.driver,
      ...(options.authority ? { authority: options.authority } : {}),
      ...(options.maxJournalEntries !== undefined
        ? { maxJournalEntries: options.maxJournalEntries }
        : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.initialJournal ? { initialJournal: options.initialJournal } : {}),
      ...(options.onJournalRecord ? { onJournalRecord: options.onJournalRecord } : {}),
      adapter: {
        resourceLabel: "computer",
        parseCommand: (value) => ComputerActionCommand.parse(value),
        parseTarget: (value) => ComputerTarget.parse(value),
        parseObservation: (value) => ComputerObservation.parse(value),
        parseReceipt: (value) => ComputerActionReceipt.parse(value),
        assertCommandAuthority(command) {
          if (command.computerSessionId !== computerSessionId) {
            throw new InteractionControllerError(
              "resource_not_found",
              "computer command targets another computer session",
            );
          }
          if (command.controllerGeneration !== controllerGeneration) {
            throw new InteractionControllerError(
              "controller_stale",
              "computer command targets a stale controller generation",
            );
          }
        },
        assertTargetAuthority(target) {
          if (
            target.computerSessionId !== computerSessionId ||
            target.controllerGeneration !== controllerGeneration
          ) {
            throw new InteractionControllerError(
              "controller_stale",
              "computer target belongs to a stale controller generation",
            );
          }
        },
        assertExpectedGenerations(command, target) {
          if (command.expectedTargetGeneration !== target.targetGeneration) {
            throw new InteractionControllerError(
              "target_stale",
              "computer target changed before the command could dispatch",
            );
          }
        },
        assertObservationAuthority(observation, targetId) {
          if (
            observation.computerSessionId !== computerSessionId ||
            observation.target.id !== targetId ||
            observation.target.computerSessionId !== computerSessionId ||
            observation.target.controllerGeneration !== controllerGeneration
          ) {
            throw new InteractionControllerError(
              "driver_failed",
              "computer driver returned an observation outside controller authority",
            );
          }
        },
        makeReceipt(input) {
          return ComputerActionReceipt.parse({
            protocolVersion: 1,
            operationId: input.command.operationId,
            computerSessionId,
            controllerGeneration,
            targetId: input.command.targetId,
            state: input.state,
            dispatchedAt: input.dispatchedAt,
            settledAt: input.settledAt,
            observation: input.observation,
            error: input.error,
          });
        },
        recoverReceipt(receipt, settledAt) {
          if (
            receipt.computerSessionId !== computerSessionId ||
            receipt.controllerGeneration !== controllerGeneration
          ) {
            throw new Error(
              `restored operation ${receipt.operationId} is outside controller authority`,
            );
          }
          return recoverInteractionReceipt(receipt, settledAt, "computer", (value) =>
            ComputerActionReceipt.parse(value),
          );
        },
      },
    });
  }

  observe(targetId: string): Promise<ComputerObservationValue> {
    return this.core.observe(targetId);
  }

  run(command: ComputerActionCommandValue): Promise<ComputerActionReceiptValue> {
    return this.core.run(command);
  }

  receipt(operationId: string): ComputerActionReceiptValue | null {
    return this.core.receipt(operationId);
  }

  journalSnapshot(): ComputerOperationJournalRecord[] {
    return this.core.journalSnapshot();
  }

  waitForIdle(): Promise<void> {
    return this.core.waitForIdle();
  }
}

export function recoverComputerOperationJournalRecord(
  record: ComputerOperationJournalRecord,
  settledAt: string,
): ComputerOperationJournalRecord {
  const receipt = ComputerActionReceipt.parse(record.receipt);
  return {
    ...record,
    receipt: recoverInteractionReceipt(receipt, settledAt, "computer", (value) =>
      ComputerActionReceipt.parse(value),
    ),
  };
}
