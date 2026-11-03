/**
 * One-off data fix for stored tool names a model provider rejects (docs/
 * model-providers.md, "Tool names in history"). Explicit online maintenance;
 * never imported by API/worker startup.
 *
 * Earlier releases stored some tool names that fail `^[a-zA-Z0-9_-]{1,64}$`:
 * known-value secret masking replaced a value that happened to occur inside a
 * tool name with a reference or marker, and a model could write a published
 * `server.tool` name. One such item fails every later request of its chat
 * with a 400. Those releases repaired history on every request; this release
 * names a call once when it is received and never rewrites history, so the
 * stored items are fixed here, once.
 *
 * Each invalid name gets one valid name per session, the same in every item
 * and in the session's saved run states: the one tool of the session it
 * denotes (a dotted name, or a masked name whose markers stand for the hidden
 * characters), else a stable alias. Only tool-name positions change: a call's
 * name and namespace and stored tool definitions, never arguments, outputs or
 * message text. Without --apply it only counts.
 *
 *   OPENGENI_MAINTENANCE_DATABASE_URL=... bun scripts/operator/repair-invalid-tool-names.ts [--apply]
 */
import { parseArgs } from "node:util";
import postgres, { type Sql } from "postgres";
import {
  isProviderToolName,
  knownToolNameFor,
  providerToolNameAlias,
} from "../../packages/runtime/src/provider-tool-names";

/** Labels secret masking and redaction wrote in place of a value. */
const MASKING_LABEL =
  /\{\{secret:[^{}]*\}\}|\[opengeni credential:[^\]]*\]|\[masked [^\]]*\]|\[redacted:[^\]]*\]|\[secret\]/g;
/** The shortest value masking replaced. */
const MASKED_VALUE_MIN_CHARS = 8;
const VALID_NAME_PART = /^[a-zA-Z0-9_-]*$/;
const NAMED_CALL_TYPES = new Set(["function_call", "function_call_result", "custom_tool_call"]);
const TOOL_DISCLOSURE_KEY_PREFIX = "opengeni.tool_disclosure";
/** Stored text the lossless codec encoded; never rewritten here. */
const ENCODED_TEXT_MARKERS = ["opengeni_lossless_text_v2_c4100a62:", "opengeni-canonical-text-v1:"];

type Position = "flat" | "scoped";
type Visitor = (name: string, position: Position) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteNamed(record: unknown, visit: Visitor, scoped: boolean): unknown {
  if (!isRecord(record)) return record;
  const isNamespace = record.type === "namespace";
  const hasNamespace = typeof record.namespace === "string" && record.namespace.length > 0;
  let next: Record<string, unknown> | null = null;
  if (typeof record.name === "string") {
    const name = visit(record.name, scoped || isNamespace || hasNamespace ? "scoped" : "flat");
    if (name !== record.name) next = { ...record, name };
  }
  if (typeof record.namespace === "string") {
    const namespace = visit(record.namespace, "scoped");
    if (namespace !== record.namespace) next = { ...(next ?? record), namespace };
  }
  if (Array.isArray(record.tools)) {
    const tools = rewriteDefinitions(record.tools, visit, scoped || isNamespace);
    if (tools !== record.tools) next = { ...(next ?? record), tools };
  }
  return next ?? record;
}

/** Definitions with valid names; one that repeats an earlier name is dropped. */
function rewriteDefinitions(tools: unknown[], visit: Visitor, scoped: boolean): unknown[] {
  let changed = false;
  const rewritten = tools.map((tool) => {
    const next = rewriteNamed(tool, visit, scoped);
    if (next !== tool) changed = true;
    return next;
  });
  if (!changed) return tools;
  const seen = new Set<string>();
  return rewritten.filter((tool) => {
    if (!isRecord(tool) || typeof tool.name !== "string") return true;
    if (seen.has(tool.name)) return false;
    seen.add(tool.name);
    return true;
  });
}

function withTools(record: Record<string, unknown>, visit: Visitor): Record<string, unknown> {
  if (!Array.isArray(record.tools)) return record;
  const tools = rewriteDefinitions(record.tools, visit, false);
  return tools === record.tools ? record : { ...record, tools };
}

/** One history item with every tool-name position visited. */
export function rewriteItemToolNames(item: unknown, visit: Visitor): unknown {
  if (!isRecord(item)) return item;
  const type = typeof item.type === "string" ? item.type : "";
  if (NAMED_CALL_TYPES.has(type)) return rewriteNamed(item, visit, false);
  let next = type === "tool_search_output" ? withTools(item, visit) : item;
  if (isRecord(next.providerData)) {
    const providerData = next.providerData;
    let data =
      providerData.type === "additional_tools" || providerData.type === "tool_search_output"
        ? withTools(providerData, visit)
        : providerData;
    for (const [key, value] of Object.entries(providerData)) {
      if (!key.startsWith(TOOL_DISCLOSURE_KEY_PREFIX) || !isRecord(value)) continue;
      const rewritten = withTools(value, visit);
      if (rewritten !== value) data = { ...data, [key]: rewritten };
    }
    if (data !== providerData) next = { ...next, providerData: data };
  }
  return next;
}

/**
 * A saved run state with every history item it holds visited, wherever the
 * SDK keeps it (original input, generated items, model responses). A call
 * item is visited as a history item and not descended into, so its arguments
 * and output are never touched.
 */
export function rewriteRunStateToolNames(value: unknown, visit: Visitor): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const rewritten = rewriteRunStateToolNames(entry, visit);
      if (rewritten !== entry) changed = true;
      return rewritten;
    });
    return changed ? next : value;
  }
  if (!isRecord(value)) return value;
  const type = typeof value.type === "string" ? value.type : "";
  if (NAMED_CALL_TYPES.has(type) || type === "tool_search_output")
    return rewriteItemToolNames(value, visit);
  let next = rewriteItemToolNames(value, visit) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(next)) {
    if (key === "providerData") continue;
    const rewritten = rewriteRunStateToolNames(entry, visit);
    if (rewritten !== entry) next = { ...next, [key]: rewritten };
  }
  return next;
}

/** Invalid names in the visited positions, and the valid flat names seen there. */
export function collectToolNames(
  values: readonly unknown[],
  walk: (value: unknown, visit: Visitor) => unknown = rewriteItemToolNames,
) {
  const invalid = new Map<string, Position>();
  const valid = new Set<string>();
  const visit: Visitor = (name, position) => {
    if (isProviderToolName(name)) {
      if (position === "flat") valid.add(name);
    } else if (invalid.get(name) !== "flat") invalid.set(name, position);
    return name;
  };
  for (const value of values) walk(value, visit);
  return { invalid, valid };
}

/** The one known name a masked name denotes: each marker stands for hidden characters. */
function unmaskedToolNameFor(name: string, known: readonly string[]): string | null {
  if (!name.match(MASKING_LABEL)) return null;
  const parts = name.split(MASKING_LABEL);
  if (!parts.every((part) => VALID_NAME_PART.test(part))) return null;
  if (parts.every((part) => part.length === 0)) return null;
  const pattern = new RegExp(
    `^${parts.map(escapeRegExp).join(`[a-zA-Z0-9_-]{${MASKED_VALUE_MIN_CHARS},}`)}$`,
  );
  const matches = known.filter((candidate) => pattern.test(candidate));
  return matches.length === 1 ? matches[0]! : null;
}

/** One valid name for each invalid name of a session. */
export function toolNameMapping(
  invalid: ReadonlyMap<string, Position>,
  known: Iterable<string>,
): Map<string, string> {
  const names = [...known].filter(isProviderToolName);
  const mapping = new Map<string, string>();
  for (const [name, position] of invalid) {
    const denoted =
      position === "flat"
        ? (knownToolNameFor(name, names) ?? unmaskedToolNameFor(name, names))
        : null;
    mapping.set(name, denoted ?? providerToolNameAlias(name));
  }
  return mapping;
}

export function mappedVisitor(mapping: ReadonlyMap<string, string>): Visitor {
  return (name) => (isProviderToolName(name) ? name : (mapping.get(name) ?? name));
}

export type RepairCounts = {
  sessions: number;
  historyItems: number;
  runStates: number;
  skippedEncodedRunStates: number;
  failedSessions: string[];
  names: Record<string, string>;
};

const VALID_NAME_SQL = "^[a-zA-Z0-9_-]{1,64}$";

/** Sessions with a history item whose tool-name position may be invalid. */
async function candidateSessions(sql: Sql): Promise<string[]> {
  const rows = await sql<Array<{ session_id: string }>>`
    select distinct session_id from session_history_items
    where (item->>'type' in ('function_call', 'function_call_result', 'custom_tool_call')
        and (item->>'name' !~ ${VALID_NAME_SQL} or coalesce(item->>'namespace', 'x') !~ ${VALID_NAME_SQL}))
      or item->>'type' = 'tool_search_output'
      or (jsonb_typeof(item->'providerData') = 'object' and (
        item->'providerData'->>'type' in ('additional_tools', 'tool_search_output')
        or exists (select 1 from jsonb_object_keys(item->'providerData') key
                   where key like ${`${TOOL_DISCLOSURE_KEY_PREFIX}%`})))`;
  return rows.map((row) => row.session_id);
}

type SessionRepair = Omit<RepairCounts, "sessions" | "failedSessions">;

/** Count, and with `apply` fix, one session's invalid tool names. */
export async function repairSessionToolNames(
  sql: Sql,
  sessionId: string,
  apply: boolean,
): Promise<SessionRepair | null> {
  const counts: SessionRepair = {
    historyItems: 0,
    runStates: 0,
    skippedEncodedRunStates: 0,
    names: {},
  };
  let found = false;
  await sql.begin(async (tx) => {
    await tx`select set_config('opengeni.lossless_content_writer', '1', true)`;
    // An imported or archived session admits content-only history edits under
    // the scrub's marker (1091); this edit changes only item content.
    await tx`select set_config('opengeni.session_secret_redaction', 'v1', true)`;
    const items = await tx<Array<{ id: string; item: unknown }>>`
      select id, item_ordered as item from session_history_items
      where session_id = ${sessionId} order by position for update`;
    const states = await tx<Array<{ id: string; state: string }>>`
      select id, serialized_run_state as state from agent_run_states
      where session_id = ${sessionId} for update`;
    const parsedStates = states.flatMap((row) => {
      if (ENCODED_TEXT_MARKERS.some((marker) => row.state.includes(marker))) {
        counts.skippedEncodedRunStates += 1;
        return [];
      }
      try {
        return [{ id: row.id, value: JSON.parse(row.state) as unknown }];
      } catch {
        return [];
      }
    });
    const history = collectToolNames(items.map((row) => row.item));
    const saved = collectToolNames(
      parsedStates.map((row) => row.value),
      rewriteRunStateToolNames,
    );
    const invalid = new Map(history.invalid);
    for (const [name, position] of saved.invalid)
      if (invalid.get(name) !== "flat") invalid.set(name, position);
    if (invalid.size === 0) return;
    found = true;
    const mapping = toolNameMapping(invalid, [...history.valid, ...saved.valid]);
    const visit = mappedVisitor(mapping);
    for (const [from, to] of mapping) counts.names[from] = to;
    for (const row of items) {
      const next = rewriteItemToolNames(row.item, visit);
      if (next === row.item) continue;
      counts.historyItems += 1;
      if (apply)
        await tx`update session_history_items set item_ordered = ${tx.json(next as never)}
          where id = ${row.id}`;
    }
    for (const row of parsedStates) {
      const next = rewriteRunStateToolNames(row.value, visit);
      if (next === row.value) continue;
      counts.runStates += 1;
      if (apply)
        await tx`update agent_run_states set serialized_run_state = ${JSON.stringify(next)}
          where id = ${row.id}`;
    }
  });
  return found ? counts : null;
}

export async function repairInvalidToolNames(sql: Sql, apply: boolean): Promise<RepairCounts> {
  const [role] =
    await sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
  if (!role || !(role.rolsuper || role.rolbypassrls))
    throw Error("Maintenance requires an existing superuser or BYPASSRLS operator connection");
  const counts: RepairCounts = {
    sessions: 0,
    historyItems: 0,
    runStates: 0,
    skippedEncodedRunStates: 0,
    failedSessions: [],
    names: {},
  };
  for (const sessionId of await candidateSessions(sql)) {
    try {
      const repaired = await repairSessionToolNames(sql, sessionId, apply);
      if (!repaired) continue;
      counts.sessions += 1;
      counts.historyItems += repaired.historyItems;
      counts.runStates += repaired.runStates;
      counts.skippedEncodedRunStates += repaired.skippedEncodedRunStates;
      Object.assign(counts.names, repaired.names);
    } catch (error) {
      // Rolled back whole; reported so an operator can look at it.
      counts.failedSessions.push(sessionId);
      console.error(JSON.stringify({ event: "session_failed", sessionId, error: String(error) }));
    }
  }
  return counts;
}

export async function runRepairInvalidToolNames(argv: string[], env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: { apply: { type: "boolean", default: false } },
    strict: true,
  });
  if (!env.OPENGENI_MAINTENANCE_DATABASE_URL)
    throw Error("OPENGENI_MAINTENANCE_DATABASE_URL is required");
  const sql = postgres(env.OPENGENI_MAINTENANCE_DATABASE_URL, { max: 1 });
  try {
    const counts = await repairInvalidToolNames(sql, values.apply);
    console.log(JSON.stringify({ event: values.apply ? "applied" : "dry_run", ...counts }));
    return counts;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) await runRepairInvalidToolNames(process.argv.slice(2));
