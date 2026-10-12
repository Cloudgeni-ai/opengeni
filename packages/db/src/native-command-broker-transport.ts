import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  canonicalModalCheckpointProviderBinding,
  ModalBrokerProviderCommand,
} from "@opengeni/contracts";
import { rawRows, withRlsContext, isTransactionHandle, type Database } from "./database";
import { encryptEnvironmentValue, decryptEnvironmentValue } from "./environment-crypto";

const uuid = z.uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z
  .object({
    version: z.literal(1),
    brokerId: uuid,
    accountId: uuid,
    workspaceId: uuid,
    leaseId: uuid,
    sandboxGroupId: uuid,
    createOperationId: z.string().min(1).max(200),
    createEpoch: z.number().int().nonnegative().safe(),
    sandboxId: z.string().regex(/^sb-[A-Za-z0-9_-]{1,200}$/),
    taskId: z.string().min(1).max(200),
    providerBindingKey: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => {
        try {
          return canonicalModalCheckpointProviderBinding(JSON.parse(value))?.key === value;
        } catch {
          return false;
        }
      }),
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    artifactSha256: digest,
    bootstrapEvidenceSha256: digest,
  })
  .strict();
export type NativeBrokerTransportBinding = z.infer<typeof bindingSchema>;
export type NativeBrokerEntryKind =
  | "request"
  | "frame"
  | "page"
  | "eof"
  | "control_reply"
  | "request_reply"
  | "stdin_reservation";
export type NativeBrokerStoredEntry = {
  kind: NativeBrokerEntryKind;
  key: string;
  sequence: number | null;
  sha256: string;
  value: string;
};
export type NativeBrokerWriter = { id: string | null; epoch: number; live: boolean };
export type NativeBrokerTransportTransaction = {
  state: unknown;
  writer: NativeBrokerWriter;
  /** Only a physical-identity fact, never user command/release authority. */
  currentInstance: boolean;
  read(kind: NativeBrokerEntryKind, key: string): Promise<NativeBrokerStoredEntry | null>;
  framesAfter(sequence: number, limit: number): Promise<NativeBrokerStoredEntry[]>;
  insert(entry: Omit<NativeBrokerStoredEntry, "sha256">): Promise<NativeBrokerStoredEntry>;
  /** The callback must apply the corresponding pure writer-epoch transition. */
  claimWriter(id: string): NativeBrokerWriter;
  requireWriter(id: string, epoch: number): void;
  save(state: unknown): void;
};
export type NativeBrokerTransportStore = {
  transaction<T>(operation: (tx: NativeBrokerTransportTransaction) => Promise<T>): Promise<T>;
  retainedInputTransaction<T>(
    input: NativeBrokerRetainedInput,
    operation: (
      tx: NativeBrokerTransportTransaction & {
        inputOffset: number;
        reserveInput(byteLength: number): Promise<number>;
      },
    ) => Promise<T>,
  ): Promise<T>;
};
const retainedInputSchema = z
  .object({
    sessionId: uuid,
    processId: uuid,
    admissionId: uuid,
    commandId: uuid,
  })
  .strict();
export type NativeBrokerRetainedInput = z.infer<typeof retainedInputSchema>;
const TTL_SECONDS = 30;
const MAX_VALUE_BYTES = 2 * 1024 * 1024;

function fenced(): never {
  throw new Error("Native broker transport binding, writer or receipt is fenced");
}
function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function validateValue(value: string): void {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_VALUE_BYTES) fenced();
}
function serialize(state: unknown): string {
  const value = JSON.stringify(state);
  validateValue(value);
  return value;
}
function seal(
  key: Uint8Array,
  binding: NativeBrokerTransportBinding,
  purpose: string,
  value: string,
) {
  validateValue(value);
  // The encrypted envelope binds ciphertext to the complete physical scope;
  // copying ciphertext between brokers or receipt keys is not a valid replay.
  return encryptEnvironmentValue(key, JSON.stringify({ binding, purpose, value }));
}
function unseal(
  key: Uint8Array,
  binding: NativeBrokerTransportBinding,
  purpose: string,
  value: string,
): string {
  const decoded = JSON.parse(decryptEnvironmentValue(key, value));
  if (!isDeepStrictEqual(decoded.binding, binding) || decoded.purpose !== purpose) fenced();
  validateValue(decoded.value);
  return decoded.value;
}
function scoped(binding: NativeBrokerTransportBinding) {
  return sql`account_id = ${binding.accountId}::uuid AND workspace_id = ${binding.workspaceId}::uuid`;
}
async function lockLease(db: Database, binding: NativeBrokerTransportBinding) {
  const rows = (await rawRows(
    db,
    sql`SELECT instance_id, liveness, lease_epoch,
    provider_create_attempt FROM sandbox_leases WHERE id = ${binding.leaseId}::uuid
    AND ${scoped(binding)} AND sandbox_group_id = ${binding.sandboxGroupId}::uuid
    AND backend = 'modal' FOR SHARE`,
  )) as {
    instance_id: string | null;
    liveness: string;
    lease_epoch: number;
    provider_create_attempt: {
      operationId?: string;
      leaseEpoch?: number;
      instanceId?: string;
      providerBindingKey?: string;
    } | null;
  }[];
  if (rows.length !== 1) fenced();
  return rows[0]!;
}

/** Internal transport storage, not a public API or an admission capability.
 * The trusted caller first authenticates the initial-process bootstrap against
 * its independently selected artifact. Registration checks exact attributed
 * creation, but does not certify that bootstrap evidence or enroll the group.
 */
export async function registerNativeBrokerTransport(
  db: Database,
  encryptionKey: Uint8Array,
  input: NativeBrokerTransportBinding,
  initialState: unknown,
): Promise<void> {
  if (isTransactionHandle(db))
    throw new Error("Native broker transport requires an outer commit boundary");
  const binding = bindingSchema.parse(input);
  const plaintext = serialize(initialState);
  const encrypted = seal(encryptionKey, binding, "state", plaintext);
  await withRlsContext(db, binding, async (tx) => {
    const lease = await lockLease(tx, binding);
    const existing = (await rawRows(
      tx,
      sql`SELECT binding, initial_state_sha256 FROM native_command_broker_transports
      WHERE id = ${binding.brokerId}::uuid AND ${scoped(binding)} FOR UPDATE`,
    )) as { binding: unknown; initial_state_sha256: string }[];
    if (existing.length) {
      // Replay after an unknown registration must not rewind progressed state.
      if (
        !isDeepStrictEqual(existing[0]!.binding, binding) ||
        existing[0]!.initial_state_sha256 !== sha(plaintext)
      )
        fenced();
      return;
    }
    if (
      lease.instance_id !== binding.sandboxId ||
      lease.liveness !== "warming" ||
      lease.lease_epoch !== binding.createEpoch ||
      lease.provider_create_attempt?.operationId !== binding.createOperationId ||
      lease.provider_create_attempt?.leaseEpoch !== binding.createEpoch ||
      lease.provider_create_attempt?.providerBindingKey !== binding.providerBindingKey ||
      lease.provider_create_attempt?.instanceId !== binding.sandboxId
    )
      fenced();
    await tx.execute(sql`INSERT INTO native_command_broker_transports
      (id,account_id,workspace_id,lease_id,sandbox_group_id,binding,initial_state_sha256,state_encrypted)
      VALUES (${binding.brokerId}::uuid,${binding.accountId}::uuid,${binding.workspaceId}::uuid,
        ${binding.leaseId}::uuid,${binding.sandboxGroupId}::uuid,${JSON.stringify(binding)}::jsonb,${sha(plaintext)},${encrypted})
      ON CONFLICT DO NOTHING`);
    const committed = await rawRows(
      tx,
      sql`SELECT binding, initial_state_sha256 FROM native_command_broker_transports
      WHERE id = ${binding.brokerId}::uuid AND ${scoped(binding)}`,
    );
    if (
      committed.length !== 1 ||
      !isDeepStrictEqual(committed[0]!.binding, binding) ||
      committed[0]!.initial_state_sha256 !== sha(plaintext)
    )
      fenced();
  });
}

/** All callbacks are DB-only. Never perform provider I/O while holding this
 * transaction. A returned dispatch value is usable only AFTER this promise
 * commits. Expired writer leases never settle commands or discard requests.
 */
export function nativeBrokerTransportStore(
  db: Database,
  encryptionKey: Uint8Array,
  input: NativeBrokerTransportBinding,
): NativeBrokerTransportStore {
  if (isTransactionHandle(db))
    throw new Error("Native broker transport requires an outer commit boundary");
  const binding = bindingSchema.parse(input);
  const transaction = async <T>(
    operation: (
      tx: NativeBrokerTransportTransaction & {
        inputOffset: number;
        reserveInput(byteLength: number): Promise<number>;
      },
    ) => Promise<T>,
    retainedInput?: NativeBrokerRetainedInput,
  ): Promise<T> =>
    withRlsContext(db, binding, async (dbtx) => {
      // Retained input follows settlement's process -> admission -> lease
      // order. Ordinary journal transactions never acquire process locks.
      const retained = retainedInput
        ? await lockRetainedInput(dbtx, binding, retainedInput)
        : {
            inputOffset: -1,
            reserveInput: async (_byteLength: number): Promise<number> => fenced(),
          };
      // Consistent order: scoped workspace fence -> lease -> broker. Late output
      // remains capturable after physical replacement, but no input is allowed.
      const lease = await lockLease(dbtx, binding);
      const rows = (await rawRows(
        dbtx,
        sql`SELECT binding, revision::text, writer_id,
      writer_epoch::text, writer_until > clock_timestamp() AS writer_live, state_encrypted
      FROM native_command_broker_transports WHERE id = ${binding.brokerId}::uuid
      AND ${scoped(binding)} FOR UPDATE`,
      )) as {
        binding: unknown;
        revision: string;
        writer_id: string | null;
        writer_epoch: string;
        writer_live: boolean | null;
        state_encrypted: string;
      }[];
      const row = rows[0];
      if (rows.length !== 1 || !row || !isDeepStrictEqual(row.binding, binding)) fenced();
      const revision = Number(row.revision),
        epoch = Number(row.writer_epoch);
      if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(epoch)) fenced();
      let state = JSON.parse(unseal(encryptionKey, binding, "state", row.state_encrypted));
      const writer = { id: row.writer_id, epoch, live: row.writer_live === true };
      let changed = false,
        renew = false,
        requireLiveAtCommit = false;
      const currentInstance =
        lease.instance_id === binding.sandboxId &&
        ["warming", "warm", "draining"].includes(lease.liveness);
      const tx: NativeBrokerTransportTransaction & {
        inputOffset: number;
        reserveInput(byteLength: number): Promise<number>;
      } = {
        ...retained,
        state,
        writer: { ...writer },
        currentInstance,
        async read(kind, key) {
          validateEntryIdentity(kind, key, null, false);
          const found = (await rawRows(
            dbtx,
            sql`SELECT sequence::text, sha256, value_encrypted
          FROM native_command_broker_entries WHERE broker_id = ${binding.brokerId}::uuid
          AND ${scoped(binding)} AND kind = ${kind} AND entry_key = ${key}`,
          )) as {
            sequence: string | null;
            sha256: string;
            value_encrypted: string;
          }[];
          if (!found.length) return null;
          const value = unseal(encryptionKey, binding, `${kind}:${key}`, found[0]!.value_encrypted);
          if (sha(value) !== found[0]!.sha256) fenced();
          return {
            kind,
            key,
            sequence: found[0]!.sequence === null ? null : Number(found[0]!.sequence),
            sha256: found[0]!.sha256,
            value,
          };
        },
        async insert(entry) {
          validateEntryIdentity(entry.kind, entry.key, entry.sequence, true);
          validateValue(entry.value);
          const old = await tx.read(entry.kind, entry.key);
          const complete = { ...entry, sha256: sha(entry.value) };
          if (old) {
            if (!isDeepStrictEqual(old, complete)) fenced();
            return old;
          }
          await dbtx.execute(sql`INSERT INTO native_command_broker_entries
          (broker_id,account_id,workspace_id,kind,entry_key,sequence,sha256,value_encrypted)
          VALUES (${binding.brokerId}::uuid,${binding.accountId}::uuid,${binding.workspaceId}::uuid,
            ${entry.kind},${entry.key},${entry.sequence},${complete.sha256},
            ${seal(encryptionKey, binding, `${entry.kind}:${entry.key}`, entry.value)})`);
          return complete;
        },
        async framesAfter(sequence, limit) {
          if (
            !Number.isSafeInteger(sequence) ||
            sequence < 0 ||
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 128
          )
            fenced();
          const found = await rawRows(
            dbtx,
            sql`SELECT entry_key, sequence::text, sha256, value_encrypted
              FROM native_command_broker_entries
              WHERE broker_id = ${binding.brokerId}::uuid AND ${scoped(binding)}
                AND kind = 'frame' AND sequence > ${sequence}
              ORDER BY native_command_broker_entries.sequence LIMIT ${limit}`,
          );
          return found.map((entryRow) => {
            const entrySequence = Number(entryRow.sequence);
            const entryKey = String(entryRow.entry_key);
            validateEntryIdentity("frame", entryKey, entrySequence, true);
            const value = unseal(
              encryptionKey,
              binding,
              `frame:${entryKey}`,
              String(entryRow.value_encrypted),
            );
            if (sha(value) !== entryRow.sha256) fenced();
            return {
              kind: "frame",
              key: entryKey,
              sequence: entrySequence,
              sha256: String(entryRow.sha256),
              value,
            };
          });
        },
        claimWriter(id) {
          if (!uuid.safeParse(id).success || !currentInstance || (writer.live && writer.id !== id))
            fenced();
          if (writer.live) requireLiveAtCommit = true;
          if (writer.id !== null && !writer.live) {
            if (writer.epoch === Number.MAX_SAFE_INTEGER) fenced();
            writer.epoch += 1;
          }
          writer.id = id;
          writer.live = true;
          changed = renew = true;
          return { ...writer };
        },
        requireWriter(id, expectedEpoch) {
          if (
            !currentInstance ||
            !writer.live ||
            writer.id !== id ||
            writer.epoch !== expectedEpoch
          )
            fenced();
          // A writer first claimed in this transaction has no persisted deadline
          // yet. Existing claims must also be live at commit, not just at read.
          if (row.writer_live === true) requireLiveAtCommit = true;
        },
        save(next) {
          serialize(next);
          state = next;
          changed = true;
        },
      };
      const result = await operation(tx);
      if (requireLiveAtCommit) {
        const live = await rawRows(
          dbtx,
          sql`SELECT id FROM native_command_broker_transports
        WHERE id = ${binding.brokerId}::uuid AND ${scoped(binding)} AND writer_until > clock_timestamp()`,
        );
        if (live.length !== 1) fenced();
      }
      if (changed) {
        if (revision === Number.MAX_SAFE_INTEGER) fenced();
        const updated = await rawRows(
          dbtx,
          sql`UPDATE native_command_broker_transports SET
        revision = revision + 1, writer_id = ${writer.id}::uuid, writer_epoch = ${writer.epoch},
        writer_until = CASE WHEN ${renew} THEN clock_timestamp() + ${TTL_SECONDS} * interval '1 second' ELSE writer_until END,
        state_encrypted = ${seal(encryptionKey, binding, "state", serialize(state))}
        WHERE id = ${binding.brokerId}::uuid AND ${scoped(binding)} AND revision = ${revision}
        RETURNING id`,
        );
        if (updated.length !== 1) fenced();
      }
      return result;
    });
  return {
    transaction: (operation) => transaction(operation),
    retainedInputTransaction: (scope, operation) =>
      transaction(operation, retainedInputSchema.parse(scope)),
  };
}

/** Locks only existing authority, never creates an admission. Reconciliation
 * may read the original request after cancellation/settlement; only a NEW byte
 * reservation requires an active process and its exact unsettled admission.
 * Both the byte counter and encrypted request commit in the enclosing journal
 * transaction. Busy/fenced/failed reservations therefore consume neither. */
async function lockRetainedInput(
  db: Database,
  binding: NativeBrokerTransportBinding,
  scope: NativeBrokerRetainedInput,
): Promise<{ inputOffset: number; reserveInput(byteLength: number): Promise<number> }> {
  const rows = await rawRows(
    db,
    sql`SELECT provider_command, provider_command_input_index,
    state, cancellation_requested_at, supervision_receipt, lease_epoch
    FROM sandbox_retained_processes WHERE id = ${scope.processId}::uuid
    AND ${scoped(binding)} AND session_id = ${scope.sessionId}::uuid
    AND lease_id = ${binding.leaseId}::uuid AND sandbox_group_id = ${binding.sandboxGroupId}::uuid
    AND provider_backend = 'modal' AND provider_instance_id = ${binding.sandboxId}
    AND provider_binding_key = ${binding.providerBindingKey} FOR UPDATE`,
  );
  const row = rows[0];
  if (rows.length !== 1 || !row) fenced();
  const command = ModalBrokerProviderCommand.parse(row.provider_command);
  if (
    command.execId !== scope.commandId ||
    command.supervision.brokerId !== binding.brokerId ||
    command.sandboxId !== binding.sandboxId ||
    command.taskId !== binding.taskId
  )
    fenced();
  const admissions = await rawRows(
    db,
    sql`SELECT settled_at FROM sandbox_workspace_mutation_admissions
    WHERE id = ${scope.admissionId}::uuid AND ${scoped(binding)}
    AND session_id = ${scope.sessionId}::uuid AND actor_kind = 'process' AND actor_id = ${scope.processId}::uuid
    AND holder_kind = 'process' AND holder_id = ${`process:${scope.processId}`}
    AND lease_id = ${binding.leaseId}::uuid AND sandbox_group_id = ${binding.sandboxGroupId}::uuid
    AND lease_epoch = ${row.lease_epoch} AND provider_backend = 'modal'
    AND provider_instance_id = ${binding.sandboxId} AND operation = 'writeStdin' FOR UPDATE`,
  );
  if (admissions.length !== 1) fenced();
  const offset = Number(row.provider_command_input_index);
  if (!Number.isSafeInteger(offset) || offset < 0) fenced();
  let used = false;
  return {
    inputOffset: offset,
    reserveInput: async (byteLength) => {
      if (
        used ||
        row.state !== "active" ||
        row.cancellation_requested_at ||
        row.supervision_receipt ||
        admissions[0]!.settled_at ||
        !Number.isSafeInteger(byteLength) ||
        byteLength <= 0
      )
        fenced();
      if (!Number.isSafeInteger(offset + byteLength)) fenced();
      used = true;
      const updated = await rawRows(
        db,
        sql`UPDATE sandbox_retained_processes
      SET provider_command_input_index = ${offset + byteLength}
      WHERE id = ${scope.processId}::uuid AND ${scoped(binding)}
      AND session_id = ${scope.sessionId}::uuid AND provider_command_input_index = ${offset}
      RETURNING id`,
      );
      if (updated.length !== 1) fenced();
      return offset;
    },
  };
}

function validateEntryIdentity(
  kind: NativeBrokerEntryKind,
  key: string,
  sequence: number | null,
  write: boolean,
) {
  if (
    ![
      "request",
      "frame",
      "page",
      "eof",
      "control_reply",
      "request_reply",
      "stdin_reservation",
    ].includes(kind) ||
    typeof key !== "string" ||
    Buffer.byteLength(key) < 1 ||
    Buffer.byteLength(key) > 200
  )
    fenced();
  if (
    (kind === "request" || kind === "control_reply" || kind === "request_reply") &&
    !uuid.safeParse(key).success
  )
    fenced();
  if (kind === "stdin_reservation") {
    const parts = key.split(":");
    if (
      parts.length !== 2 ||
      !uuid.safeParse(parts[0]).success ||
      !/^[1-9][0-9]*$/.test(parts[1]!) ||
      !Number.isSafeInteger(Number(parts[1]))
    )
      fenced();
  }
  if (kind === "frame" && !/^[1-9][0-9]*$/.test(key)) fenced();
  if (!write) return;
  if (
    kind === "request" ||
    kind === "frame" ||
    kind === "control_reply" ||
    kind === "request_reply" ||
    kind === "stdin_reservation"
  ) {
    if (
      sequence === null ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      (kind === "request" && sequence > 0xffffffff) ||
      (kind === "frame" && String(sequence) !== key)
    )
      fenced();
  } else if (sequence !== null) fenced();
}
