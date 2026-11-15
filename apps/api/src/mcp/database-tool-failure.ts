import {
  TASK_NOTE_ACTIVE_RECORD_CAP,
  TASK_NOTE_LIST_MAX_LIMIT,
  TASK_NOTE_MAX_LIFETIME_DAYS,
  TASK_NOTE_REASON_MAX_BYTES,
  TASK_NOTE_TEXT_MAX_BYTES,
} from "@opengeni/contracts";
import {
  isDatabaseConnectionLoss,
  nestedPostgresSqlState,
  type TaskNoteOperation,
  type TaskNoteRefusedError,
} from "@opengeni/db";
import { readOnlySessionRefusal } from "../routes/session-history-imports";
import { markToolArgumentRejection } from "./tool-argument-error";

type ToolFailure = { code: string; message: string; retryable: boolean; sqlState?: string };

function toolFailureResult(failure: ToolFailure) {
  const envelope = { error: failure };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope,
    isError: true as const,
  };
}

const NOTE_KINDS = "finding, decision, blocker, ownership, artifact or handoff";

const NOT_DONE: Record<TaskNoteOperation, string> = {
  save: "Not saved",
  archive: "Not archived",
  replace: "Not replaced",
  list: "Notes were not listed",
};

const INVALID_INPUT: Record<TaskNoteOperation, string> = {
  save: `kind must be one of ${NOTE_KINDS}; text must be 1-${TASK_NOTE_TEXT_MAX_BYTES} UTF-8 bytes without leading or trailing whitespace; expiresInDays must be a whole number from 1 to ${TASK_NOTE_MAX_LIFETIME_DAYS}.`,
  archive: `expectedVersion must be 1, and reason must be 1-${TASK_NOTE_REASON_MAX_BYTES} UTF-8 bytes without leading or trailing whitespace.`,
  replace: `expectedReplacedVersion must be 1; replacementKind must be one of ${NOTE_KINDS}; replacementText must be 1-${TASK_NOTE_TEXT_MAX_BYTES} and reason 1-${TASK_NOTE_REASON_MAX_BYTES} UTF-8 bytes, both without leading or trailing whitespace; replacementExpiresInDays must be a whole number from 1 to ${TASK_NOTE_MAX_LIFETIME_DAYS}.`,
  list: `limit must be a whole number from 1 to ${TASK_NOTE_LIST_MAX_LIMIT}.`,
};

/**
 * What a refused task-note call means, in words the agent can act on. Built
 * only from the refusal's classification, never from the driver error, so no
 * SQL, parameter or note text reaches the caller.
 */
export function taskNoteRefusalResult(refusal: TaskNoteRefusedError) {
  const { operation, reason } = refusal;
  const notDone = NOT_DONE[operation];
  switch (reason) {
    case "active_note_limit":
      return toolFailureResult({
        code: "task_note_active_limit_reached",
        message: `${notDone}: this task tree already has ${TASK_NOTE_ACTIVE_RECORD_CAP} active notes, the most it can hold. Archive notes that are done with task_note_archive (task_notes_list shows them), then save again. Expired notes stop counting on their own.`,
        retryable: false,
      });
    case "invalid_input":
      return markToolArgumentRejection(
        toolFailureResult({
          code: "task_note_invalid_input",
          message: `${notDone}: the input was rejected. ${INVALID_INPUT[operation]}`,
          retryable: false,
        }),
      );
    case "operation_conflict":
      return markToolArgumentRejection(
        toolFailureResult({
          code: "task_note_operation_id_conflict",
          message: `${notDone}: this operationId was already used for a different task-note change (other input, or another turn or attempt). Use a fresh operationId; reuse one only to retry exactly the same call.`,
          retryable: false,
        }),
      );
    case "note_not_found":
      return markToolArgumentRejection(
        toolFailureResult({
          code: "task_note_not_found",
          message: `${notDone}: no note with that ID exists in this task tree. Use a note ID from task_notes_list.`,
          retryable: false,
        }),
      );
    case "note_not_active":
      return toolFailureResult({
        code: "task_note_not_active",
        message: `${notDone}: that note is no longer active; it was already archived or replaced, or it expired. task_notes_list with includeArchived: true shows its current state.`,
        retryable: false,
      });
    case "attempt_not_authorized":
      return toolFailureResult({
        code: "task_note_not_authorized",
        message: `${notDone}: task notes can only be used from this session's current turn and attempt within a task tree visible to it, and this call could not confirm that (the turn may have been superseded, or the session is no longer available). Repeating the call from this attempt will be refused the same way.`,
        retryable: false,
      });
    case "transient":
      return toolFailureResult({
        code: "task_note_temporarily_unavailable",
        message:
          operation === "list"
            ? "Notes were not listed: the task-note store was briefly unavailable. Retry shortly."
            : "The task-note store was briefly unavailable, so this change may not have completed. Retry the exact same call with the same operationId: if it already went through, the retry returns the original result instead of applying it twice.",
        retryable: true,
      });
  }
}

const DATABASE_ERROR_NAMES = new Set(["DrizzleQueryError", "PostgresError", "DatabaseError"]);
// Drizzle's wrapper message is `Failed query: <sql>\nparams: <values>`; this
// also finds it when another error copied it into its own message.
const QUERY_ECHO = /Failed query/u;

/**
 * Whether the message the MCP SDK would put in the error result is a raw
 * database error. The SDK returns a thrown error's message verbatim, and a
 * Drizzle failure's message is the query plus every parameter, which can hold
 * the caller's own content. Errors that wrap a database failure under their
 * own message keep that message.
 */
function echoesDatabaseError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; message?: unknown; query?: unknown };
  if (typeof record.name === "string" && DATABASE_ERROR_NAMES.has(record.name)) return true;
  if (typeof record.query === "string") return true;
  return typeof record.message === "string" && QUERY_ECHO.test(record.message);
}

const TRANSIENT_SQLSTATES = new Set(["40001", "40P01", "55P03"]);

/**
 * The tool result for a first-party tool that failed with a raw database
 * error, or null when the error's own message is safe to show. It says what
 * kind of failure happened (read-only session, brief outage, refusal with its
 * SQLSTATE) and never repeats the query, its parameters or the driver message.
 */
export function databaseToolFailureResult(toolName: string, error: unknown) {
  if (!echoesDatabaseError(error)) return null;
  const readOnly = readOnlySessionRefusal(error);
  if (readOnly) {
    return toolFailureResult({
      code: `${toolName}_session_read_only`,
      message: readOnly.message,
      retryable: false,
    });
  }
  const sqlState = nestedPostgresSqlState(error);
  if (isDatabaseConnectionLoss(error) || (sqlState !== null && TRANSIENT_SQLSTATES.has(sqlState))) {
    return toolFailureResult({
      code: `${toolName}_temporarily_unavailable`,
      message:
        "The workspace database was briefly unavailable, so this call may not have completed. Retry it; if the tool takes an operationId or idempotency key, reuse the same one so a change that already went through is not applied twice.",
      retryable: true,
      ...(sqlState ? { sqlState } : {}),
    });
  }
  return toolFailureResult({
    code: `${toolName}_failed`,
    message: `The workspace database refused this call${sqlState ? ` (SQLSTATE ${sqlState})` : ""}, so the tool failed. Retrying the identical call is unlikely to help.`,
    retryable: false,
    ...(sqlState ? { sqlState } : {}),
  });
}
