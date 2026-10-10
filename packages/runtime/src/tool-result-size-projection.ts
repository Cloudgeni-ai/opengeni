import type {
  AttemptToolIdentity,
  AttemptToolResult as AttemptToolResultValue,
} from "@opengeni/contracts";

type JsonRecord = Record<string, unknown>;

/**
 * Experiment flag (default off). When `OPENGENI_EXPERIMENT_TOOL_RESULT_SIZE=1`
 * the model receives a smaller, content-preserving copy of first-party Opengeni
 * text results. Codemode, the API tool, REST, SDK and UI callers are unchanged.
 */
export const TOOL_RESULT_SIZE_EXPERIMENT_ENV = "OPENGENI_EXPERIMENT_TOOL_RESULT_SIZE";

export function toolResultSizeExperimentEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env[TOOL_RESULT_SIZE_EXPERIMENT_ENV] === "1";
}

/**
 * The model-visible copy of a first-party (`opengeni`) text result, under the
 * experiment flag. It runs at the per-caller seam
 * (`projectAttemptToolResultForCaller`), after the Knowledge projection, so
 * Codemode keeps the exact API contract.
 *
 * Only a result whose single plain text block is exactly the API's
 * `JSON.stringify(value, null, 2)` serialization is touched; the check proves
 * the text is that value and nothing else (no prose, no lossy numbers). Then:
 *
 * - every such result is re-serialized without indentation;
 * - `variable_set_list` / `environment_list` drop the deprecated alias key when
 *   it is a deep copy of the canonical one, and drop a variable's `createdAt`
 *   when it equals its `updatedAt` (a variable that was never rewritten);
 * - a `session_events` debug page states its single `sessionId`/`workspaceId`
 *   once at the top instead of on every event, and omits per-event
 *   `clientEventId`, `duplicateOfEventId` and `duplicateReason` when null.
 *
 * Nothing is truncated and no value is rewritten: every omitted field is either
 * a repeated value or a null. Errors, structured results and anything outside
 * the expected shape are returned unchanged (minified only when exact).
 */
export function projectFirstPartyToolResultSizeForModel(
  identity: AttemptToolIdentity,
  result: AttemptToolResultValue,
): AttemptToolResultValue {
  if (identity.serverId !== "opengeni") return result;
  if (result.isError === true || result.structuredContent !== undefined) return result;
  if (result.content.length !== 1) return result;
  const [content] = result.content;
  if (content?.type !== "text") return result;
  if (Object.keys(content).some((key) => key !== "type" && key !== "text")) return result;
  const value = parseExactPrettyJson(content.text);
  if (value === undefined) return result;
  const text = JSON.stringify(projectValue(identity.toolName, value));
  if (text.length >= content.text.length) return result;
  return { ...result, content: [{ type: "text", text }] };
}

function parseExactPrettyJson(text: string): unknown {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return JSON.stringify(value, null, 2) === text ? value : undefined;
}

function projectValue(toolName: string, value: unknown): unknown {
  switch (toolName) {
    case "variable_set_list":
      return compactVariableSetList(value, "variableSets", "environments");
    case "environment_list":
      return compactVariableSetList(value, "environments", "variableSets");
    case "session_events":
      return compactSessionEventDebugPage(value);
    default:
      return value;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compactVariableSetList(value: unknown, canonical: string, alias: string): unknown {
  if (!isRecord(value)) return value;
  const sets = value[canonical];
  if (!Array.isArray(sets) || !sets.every(isVariableSet)) return value;
  const kept: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === alias && jsonEqual(entry, sets)) continue;
    kept[key] = key === canonical ? sets.map(compactVariableSet) : entry;
  }
  return kept;
}

function isVariableSet(value: unknown): value is JsonRecord & { variables: JsonRecord[] } {
  return (
    isRecord(value) &&
    Array.isArray(value.variables) &&
    value.variables.every((variable) => isRecord(variable) && typeof variable.name === "string")
  );
}

function compactVariableSet(set: JsonRecord & { variables: JsonRecord[] }): JsonRecord {
  return {
    ...set,
    variables: set.variables.map((variable) => {
      if (typeof variable.createdAt !== "string" || variable.createdAt !== variable.updatedAt) {
        return variable;
      }
      const { createdAt: _createdAt, ...kept } = variable;
      return kept;
    }),
  };
}

const NULL_DEFAULT_EVENT_FIELDS = ["clientEventId", "duplicateOfEventId", "duplicateReason"];
const HOISTED_EVENT_FIELDS = ["sessionId", "workspaceId"] as const;

/** Debug/audit pages carry raw session events; content views have no such envelope. */
function compactSessionEventDebugPage(value: unknown): unknown {
  if (!isRecord(value) || typeof value.mode !== "string" || !Array.isArray(value.events)) {
    return value;
  }
  const events = value.events;
  if (events.length === 0 || !events.every(isRecord)) return value;
  const hoisted: JsonRecord = {};
  for (const field of HOISTED_EVENT_FIELDS) {
    if (field in value) continue;
    const first: unknown = events[0]![field];
    if (typeof first !== "string") continue;
    if (events.every((event) => event[field] === first)) hoisted[field] = first;
  }
  return {
    ...hoisted,
    ...value,
    events: events.map((event) => {
      const kept: JsonRecord = {};
      for (const [key, entry] of Object.entries(event)) {
        if (key in hoisted) continue;
        if (entry === null && NULL_DEFAULT_EVENT_FIELDS.includes(key)) continue;
        kept[key] = entry;
      }
      return kept;
    }),
  };
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
