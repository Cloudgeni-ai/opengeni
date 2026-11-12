import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { LEARNING_REFUSAL_MESSAGES } from "../src/learning-refusals";

// Every SQLSTATE 42501 refusal a Knowledge, workspace instruction or Skill
// write can raise must be classified on purpose in learning-refusals.ts: a
// correction the agent can make, a fence on a stale attempt, or a genuine
// refusal shown to the person. An unlisted message would be shown to the
// person as "this chat isn't allowed", even when it is a fixable choice of
// evidence, source or scope. This reads the migrated schema, walks every
// routine and trigger reachable from the write routines the hosts call, and
// fails on any 42501 message missing from the registry.

/** The routines the Knowledge, instruction and Skill write paths call. */
const WRITE_ROUTINES = [
  "knowledge_entry_apply",
  "knowledge_entry_prepare_file",
  "knowledge_entry_confirm_legacy",
  "knowledge_instruction_confirm_legacy",
  "agent_instruction_apply",
  "skill_apply_lifecycle",
];

let shared: SharedTestDatabase | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("learning-refusal-audit");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1")
    throw new Error("PostgreSQL required");
}, 180_000);
afterAll(async () => {
  await shared?.release();
}, 60_000);

/** Source split into statements, without comments; string literals kept. */
function statements(source: string): string[] {
  const out: string[] = [];
  let current = "";
  for (let i = 0; i < source.length;) {
    const rest = source.slice(i, i + 64);
    if (rest.startsWith("--")) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/u.exec(rest)?.[0];
    if (dollar) {
      const end = source.indexOf(dollar, i + dollar.length);
      const stop = end < 0 ? source.length : end + dollar.length;
      current += source.slice(i, stop);
      i = stop;
      continue;
    }
    if (source[i] === "'") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "'" && source[j + 1] === "'") j += 2;
        else if (source[j] === "'") break;
        else j += 1;
      }
      current += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (source[i] === ";") {
      out.push(current);
      current = "";
    } else current += source[i];
    i += 1;
  }
  if (current.trim()) out.push(current);
  return out;
}

/** The literal message of each 42501 RAISE, or the statement when it is not a literal. */
function authorityRaises(source: string): Array<{ message: string } | { dynamic: string }> {
  const raises: Array<{ message: string } | { dynamic: string }> = [];
  for (const statement of statements(source)) {
    // A RAISE may follow THEN, ELSE or a label on the same statement.
    const at = statement.search(/\braise\b/iu);
    if (at < 0) continue;
    const text = statement.slice(at).trim();
    if (!/'42501'|\binsufficient_privilege\b/iu.test(text)) continue;
    const literal =
      /^raise\s+(?:exception\s+)?'((?:[^']|'')*)'/iu.exec(text)?.[1] ??
      /\bmessage\s*=\s*'((?:[^']|'')*)'/iu.exec(text)?.[1];
    if (literal === undefined || literal.includes("%"))
      raises.push({ dynamic: text.replace(/\s+/gu, " ").slice(0, 240) });
    else raises.push({ message: literal.replaceAll("''", "'") });
  }
  return raises;
}

describe("learning write refusals", () => {
  test("every 42501 a learning write can raise is classified", async () => {
    if (!shared) return;
    const routines = await shared.admin<{ name: string; source: string }[]>`
      SELECT p.proname AS name, string_agg(p.prosrc, E'\n;\n') AS source
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND l.lanname IN ('plpgsql', 'sql')
      GROUP BY p.proname`;
    const triggers = await shared.admin<{ tableName: string; routine: string }[]>`
      SELECT c.relname AS "tableName", p.proname AS routine
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal`;
    const sources = new Map(routines.map((routine) => [routine.name, routine.source]));
    const triggersOn = new Map<string, string[]>();
    for (const trigger of triggers)
      triggersOn.set(trigger.tableName, [
        ...(triggersOn.get(trigger.tableName) ?? []),
        trigger.routine,
      ]);
    for (const root of WRITE_ROUTINES) expect(sources.has(root), root).toBe(true);

    // Calls by name (including dynamic SQL text) and the triggers of every
    // table a routine writes: a deliberate over-approximation.
    const reached = new Set<string>(WRITE_ROUTINES);
    const queue = [...WRITE_ROUTINES];
    while (queue.length > 0) {
      const source = statements(sources.get(queue.shift()!) ?? "").join(";");
      const next = new Set<string>();
      for (const match of source.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/giu))
        next.add(match[1]!.toLowerCase());
      for (const match of source.matchAll(
        /\b(?:insert\s+into|update|delete\s+from)\s+(?:only\s+)?(?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)/giu,
      ))
        for (const routine of triggersOn.get(match[1]!.toLowerCase()) ?? []) next.add(routine);
      for (const name of next) {
        if (reached.has(name) || !sources.has(name)) continue;
        reached.add(name);
        queue.push(name);
      }
    }

    const raised = new Map<string, Set<string>>();
    const dynamic: string[] = [];
    for (const name of reached) {
      for (const raise of authorityRaises(sources.get(name)!)) {
        if ("dynamic" in raise) dynamic.push(`${name}: ${raise.dynamic}`);
        else raised.set(raise.message, (raised.get(raise.message) ?? new Set()).add(name));
      }
    }
    // A computed message cannot be classified by its text.
    expect(dynamic).toEqual([]);
    expect(raised.size).toBeGreaterThan(50);
    const unclassified = [...raised]
      .filter(([message]) => !LEARNING_REFUSAL_MESSAGES.has(message))
      .map(([message, where]) => `${message} (${[...where].join(", ")})`);
    // Add each to LEARNING_REFUSAL_MESSAGES as a correction, fence or refusal.
    expect(unclassified).toEqual([]);
    // And the registry names only messages these routines still raise.
    expect([...LEARNING_REFUSAL_MESSAGES.keys()].filter((message) => !raised.has(message))).toEqual(
      [],
    );
    // The real case this guards: a private file cited as a shared source.
    expect(raised.get("File source requires its authorized scope")).toEqual(
      new Set(["knowledge_validate_source"]),
    );
  }, 120_000);
});
