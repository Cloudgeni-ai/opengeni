/**
 * A rolling migration runs before the rollout, while the previous release's
 * binary still serves every request. That binary's readiness enforces its own
 * runtime posture (`packages/db/src/runtime-posture.ts`): a definer it declares
 * in `RUNTIME_DEFINER_ROUTINES` and has not deferred, a table in its
 * `RUNTIME_TABLE_PRIVILEGES` or USAGE on a schema it uses must stay in place.
 * Revoking, dropping or renaming any of them in a rolling migration takes the
 * old fleet unready the moment the migration commits (staging on 10 November
 * 2026: 1283 revoked EXECUTE on `list_uncompacted_recording_tracks_v1`, which
 * the release still serving required).
 *
 * This analyzer judges a migration against the posture declarations of the
 * previous release, read from that release's own source (the main merge base
 * and the pinned production baseline), not today's:
 *
 * - `previous-release-dependency`: the migration removes something one of those
 *   releases declares it needs. No annotation clears it. Change the binary
 *   first (defer the routine, stop using the table) and remove the object in a
 *   later release's migration, or make the migration maintenance-mode, which
 *   stops the old fleet before it runs.
 * - `unannotated-removal`: the migration revokes privileges on another routine
 *   the previous release knows, or drops or renames a routine, view, type,
 *   domain, sequence or schema that it did not create. Static analysis cannot
 *   tell whether old code still uses those, so the migration must say why with
 *   the reviewed `-- contract-step:` annotation, as for dropped columns.
 *
 * Removals the same migration undoes before it commits (a REVOKE followed by a
 * GRANT on the same object, a DROP followed by CREATE) are not removals.
 * Dynamic SQL in DO blocks is read too; a removal whose target is assembled at
 * run time cannot be resolved and needs the annotation.
 */
import { splitStatements, stripComments } from "../packages/db/src/migration-sql";
import { stripRoutineBodies } from "./migration-rls-backfills";
import {
  CONTRACT_STEP_KEY,
  MAINTENANCE_HEADER,
  headerValue,
  migrationOrdinal,
  placeholderReason,
  MIN_CONTRACT_STEP_CHARS,
} from "./migration-deployment-mode";

/**
 * First ordinal the `unannotated-removal` rule governs: one above the newest
 * migration on main when it landed. Shipped migrations are immutable. The
 * `previous-release-dependency` rule has no floor: it judges every migration a
 * change adds against the release before it.
 */
export const REMOVAL_GOVERNED_FROM_ORDINAL = 1359;

/** Schemas the runtime always needs USAGE on. */
const RUNTIME_SCHEMAS = ["public", "opengeni_private"] as const;

export type PreviousReleaseContract = {
  /** Where the declarations come from, for messages. */
  label: string;
  /** Routines whose runtime EXECUTE readiness requires: `name(arg types)`. */
  requiredRoutines: ReadonlySet<string>;
  /** Every routine signature the release's posture knows, any contract. */
  knownRoutines: ReadonlySet<string>;
  /** Tables with direct runtime privileges, and those privileges. */
  tablePrivileges: ReadonlyMap<string, ReadonlySet<string>>;
  /** Tables readiness lets be absent (`RETIRING_FEATURE_TABLES`): dropping them is the next step. */
  optionalTables: ReadonlySet<string>;
  /** Schemas the runtime needs USAGE on. */
  requiredSchemas: ReadonlySet<string>;
};

export type PreviousReleaseFindingKind = "previous-release-dependency" | "unannotated-removal";

export type PreviousReleaseFinding = {
  file: string;
  kind: PreviousReleaseFindingKind;
  detail: string;
};

// ---------------------------------------------------------------------------
// Names and signatures

const TYPE_ALIASES: Readonly<Record<string, string>> = {
  int: "integer",
  int4: "integer",
  int8: "bigint",
  int2: "smallint",
  bool: "boolean",
  varchar: "character varying",
  char: "character",
  float8: "double precision",
  float4: "real",
  decimal: "numeric",
  timestamptz: "timestamp with time zone",
  timestamp: "timestamp without time zone",
  timetz: "time with time zone",
  time: "time without time zone",
  varbit: "bit varying",
};
const MULTI_WORD_TYPE =
  /^(?:double precision|character varying|bit varying|(?:timestamp|time)(?: with(?:out)? time zone)?)$/;
const ARG_MODES = new Set(["in", "out", "inout", "variadic"]);

function unquoteIdentifier(part: string): string {
  const trimmed = part.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2
    ? trimmed.slice(1, -1).replaceAll('""', '"')
    : trimmed.toLowerCase();
}

/** Split on commas outside parentheses and double quotes. */
function splitTopLevel(text: string, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === "(") depth += 1;
    else if (!quoted && char === ")") depth -= 1;
    if (!quoted && depth === 0 && char === separator) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() !== "") parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

function normalizeType(raw: string): string {
  let type = raw
    .replace(/"/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*\[\s*\d*\s*\]/g, "[]")
    .replace(/\s*\([^)]*\)/g, "")
    .trim();
  const array = type.endsWith("[]") ? "[]" : "";
  if (array) type = type.slice(0, -2).trim();
  type = type.replace(/^pg_catalog\./, "").replace(/^public\./, "");
  return `${TYPE_ALIASES[type] ?? type}${array}`;
}

/** The identity type of one argument declaration, or null for an OUT argument. */
function argumentType(raw: string): string | null {
  const declaration = raw.replace(/\s+(?:DEFAULT\b|=)[\s\S]*$/i, "").trim();
  const tokens = declaration.split(/\s+/);
  const mode = tokens[0]?.toLowerCase();
  if (mode && ARG_MODES.has(mode) && tokens.length > 1) {
    tokens.shift();
    if (mode === "out") return null;
  }
  if (tokens.length >= 2) {
    const whole = normalizeType(tokens.join(" "));
    if (!MULTI_WORD_TYPE.test(whole.replace(/\[\]$/, ""))) tokens.shift();
  }
  return normalizeType(tokens.join(" "));
}

/**
 * `schema.name(args)` or `name(args)` as `name(type, type)` (schema dropped,
 * argument names, modes, defaults and type modifiers removed, aliases
 * resolved), or bare `name` when the text has no argument list.
 */
export function normalizeRoutineSignature(text: string): string {
  const open = text.indexOf("(");
  const namePart = open === -1 ? text : text.slice(0, open);
  const parts = splitTopLevel(namePart.trim(), ".");
  const name = unquoteIdentifier(parts[parts.length - 1] ?? "");
  if (open === -1) return name;
  const close = text.lastIndexOf(")");
  const args = splitTopLevel(text.slice(open + 1, close === -1 ? undefined : close))
    .map(argumentType)
    .filter((type): type is string => type !== null);
  return `${name}(${args.join(", ")})`;
}

/** `public.t` and `t` are the same table; other schemas stay qualified. */
export function normalizeRelationName(text: string): string {
  const parts = splitTopLevel(text.trim(), ".").map(unquoteIdentifier);
  if (parts.length === 2 && (parts[0] === "public" || parts[0] === "pg_temp")) return parts[1]!;
  return parts.join(".");
}

function routineName(signature: string): string {
  const open = signature.indexOf("(");
  return open === -1 ? signature : signature.slice(0, open);
}

function routineSchema(text: string): string | null {
  const open = text.indexOf("(");
  const parts = splitTopLevel((open === -1 ? text : text.slice(0, open)).trim(), ".");
  return parts.length >= 2 ? unquoteIdentifier(parts[0]!) : null;
}

// ---------------------------------------------------------------------------
// Building a contract from a posture module

const ROUTINE_SIGNATURE = /^[a-z_][a-z0-9_$]*\([^()]*\)$/;

function collectSignatures(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 4 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (ROUTINE_SIGNATURE.test(value)) into.add(normalizeRoutineSignature(value));
    return;
  }
  if (value instanceof Set || Array.isArray(value)) {
    for (const item of value) collectSignatures(item, into, depth + 1);
    return;
  }
  if (value instanceof Map) {
    for (const [key, item] of value) {
      collectSignatures(key, into, depth + 1);
      collectSignatures(item, into, depth + 1);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      collectSignatures(key, into, depth + 1);
      collectSignatures(item, into, depth + 1);
    }
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * The dependencies one release declares, read from its runtime-posture module
 * (and its frozen legacy routine inventory, when it has one). Reads only
 * long-standing exports, so it works for any pinned release.
 */
export function previousReleaseContract(
  label: string,
  posture: Record<string, unknown>,
  legacyRoutines?: { target?: unknown; private?: unknown } | null,
): PreviousReleaseContract {
  const deferred = new Set(
    stringList(posture.DEFERRED_RUNTIME_PRIVATE_ROUTINES).map(normalizeRoutineSignature),
  );
  const requiredRoutines = new Set(
    stringList(posture.RUNTIME_DEFINER_ROUTINES)
      .map(normalizeRoutineSignature)
      .filter((signature) => !deferred.has(signature)),
  );
  const knownRoutines = new Set<string>();
  collectSignatures(Object.values(posture), knownRoutines);
  collectSignatures(legacyRoutines?.target, knownRoutines);
  collectSignatures(legacyRoutines?.private, knownRoutines);
  const tablePrivileges = new Map<string, ReadonlySet<string>>();
  const declared = posture.RUNTIME_TABLE_PRIVILEGES;
  if (declared && typeof declared === "object") {
    for (const [table, privileges] of Object.entries(declared)) {
      tablePrivileges.set(
        normalizeRelationName(table),
        new Set(stringList(privileges).map((privilege) => privilege.toUpperCase())),
      );
    }
  }
  const retiring = posture.RETIRING_FEATURE_TABLES;
  const optionalTables = new Set(
    (retiring && typeof retiring === "object" ? Object.values(retiring) : [])
      .flatMap(stringList)
      .map(normalizeRelationName),
  );
  return {
    label,
    requiredRoutines,
    knownRoutines,
    tablePrivileges,
    optionalTables,
    requiredSchemas: new Set(RUNTIME_SCHEMAS),
  };
}

// ---------------------------------------------------------------------------
// Reading removals out of migration SQL

type ObjectKind =
  | "routine"
  | "table"
  | "view"
  | "type"
  | "domain"
  | "sequence"
  | "schema"
  | "all-in-schema"
  | "dynamic";

type ObjectRef = {
  kind: ObjectKind;
  /** Routine signature, relation name, schema name, or the schema of an ALL ... IN SCHEMA. */
  name: string;
  /** For routines: the schema written in the SQL, if any. */
  schema?: string | null;
  /** For ALL ... IN SCHEMA: which object class. */
  allOf?: "tables" | "routines" | "sequences";
  /** Text as written, for messages. */
  text: string;
};

type Operation =
  | {
      op: "revoke";
      target: ObjectRef;
      privileges: ReadonlySet<string>;
      /** Every grantee is PUBLIC. */
      publicOnly: boolean;
      sql: string;
    }
  | { op: "grant"; target: ObjectRef; privileges: ReadonlySet<string> }
  | { op: "drop"; target: ObjectRef; sql: string }
  | { op: "rename"; target: ObjectRef; sql: string }
  | { op: "create"; target: ObjectRef; replace: boolean };

const PLACEHOLDER = /%[a-z]|\$\d|^\s*$/i;

/**
 * Executable fragments of one statement: comments and CREATE FUNCTION bodies
 * (which run later, not during the migration) removed, then split at `;`,
 * single quotes and dollar-quote tags, so SQL inside a DO block or an EXECUTE
 * string is read as its own fragment.
 */
export function executableFragments(statement: string): string[] {
  const text = stripComments(stripRoutineBodies(statement));
  return text
    .split(/;|'|\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/)
    .map((fragment) => fragment.replace(/\s+/g, " ").trim())
    .filter((fragment) => fragment !== "");
}

function routineRefs(list: string): ObjectRef[] {
  return splitTopLevel(list).map((text) =>
    PLACEHOLDER.test(text)
      ? { kind: "dynamic", name: text, text }
      : {
          kind: "routine",
          name: normalizeRoutineSignature(text),
          schema: routineSchema(text),
          text,
        },
  );
}

function relationRefs(kind: ObjectKind, list: string): ObjectRef[] {
  return splitTopLevel(list).map((text) =>
    PLACEHOLDER.test(text)
      ? { kind: "dynamic", name: text, text }
      : { kind, name: normalizeRelationName(text.split(/\s+/)[0]!), text },
  );
}

/** The objects of a GRANT/REVOKE `ON ...` clause. */
function privilegeTargets(spec: string): ObjectRef[] {
  const all = /^ALL\s+(TABLES|FUNCTIONS|PROCEDURES|ROUTINES|SEQUENCES)\s+IN\s+SCHEMA\s+(.+)$/i.exec(
    spec,
  );
  if (all) {
    const allOf = /TABLES/i.test(all[1]!)
      ? "tables"
      : /SEQUENCES/i.test(all[1]!)
        ? "sequences"
        : "routines";
    return relationRefs("all-in-schema", all[2]!).map((ref) =>
      ref.kind === "dynamic" ? ref : { ...ref, allOf },
    );
  }
  const routine = /^(?:FUNCTION|PROCEDURE|ROUTINE)\s+(.+)$/i.exec(spec);
  if (routine) return routineRefs(routine[1]!);
  const schema = /^SCHEMA\s+(.+)$/i.exec(spec);
  if (schema) return relationRefs("schema", schema[1]!);
  const sequence = /^SEQUENCE\s+(.+)$/i.exec(spec);
  if (sequence) return relationRefs("sequence", sequence[1]!);
  if (/^(?:DATABASE|DOMAIN|FOREIGN|LANGUAGE|LARGE|PARAMETER|TABLESPACE|TYPE)\b/i.test(spec))
    return [];
  return relationRefs("table", spec.replace(/^TABLE\s+/i, ""));
}

function privilegeSet(text: string): Set<string> {
  const privileges = new Set<string>();
  for (const part of splitTopLevel(text)) {
    const word = part.replace(/\(.*$/, "").trim().toUpperCase();
    privileges.add(/^ALL\b/.test(word) ? "ALL" : word);
  }
  return privileges;
}

const DROP_KINDS: Readonly<Record<string, ObjectKind>> = {
  FUNCTION: "routine",
  PROCEDURE: "routine",
  ROUTINE: "routine",
  TABLE: "table",
  VIEW: "view",
  "MATERIALIZED VIEW": "view",
  TYPE: "type",
  DOMAIN: "domain",
  SEQUENCE: "sequence",
  SCHEMA: "schema",
};
const OBJECT_KEYWORD = String.raw`(FUNCTION|PROCEDURE|ROUTINE|TABLE|MATERIALIZED\s+VIEW|VIEW|TYPE|DOMAIN|SEQUENCE|SCHEMA)`;
const DROP_OBJECT = new RegExp(
  String.raw`^DROP\s+${OBJECT_KEYWORD}\s+(?:IF\s+EXISTS\s+)?(.+?)(?:\s+(?:CASCADE|RESTRICT))?$`,
  "i",
);
const ALTER_OBJECT = new RegExp(
  String.raw`^ALTER\s+${OBJECT_KEYWORD}\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(.+?)\s+(RENAME\s+TO|SET\s+SCHEMA|RENAME\s+(?:VALUE|ATTRIBUTE)|DROP\s+ATTRIBUTE)\b`,
  "i",
);
const CREATE_OBJECT = new RegExp(
  String.raw`^CREATE\s+(OR\s+REPLACE\s+)?(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?(?:RECURSIVE\s+)?${OBJECT_KEYWORD}\s+(IF\s+NOT\s+EXISTS\s+)?((?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*))?(?:\s*\([^)]*\))?)`,
  "i",
);

function kindOf(keyword: string): ObjectKind {
  return DROP_KINDS[keyword.replace(/\s+/g, " ").toUpperCase()] ?? "table";
}

function refsFor(kind: ObjectKind, list: string): ObjectRef[] {
  return kind === "routine" ? routineRefs(list) : relationRefs(kind, list);
}

/** Every privilege, drop, rename and create one fragment performs. */
function fragmentOperations(fragment: string): Operation[] {
  const operations: Operation[] = [];
  // A statement may sit after other text in its fragment (e.g. `BEGIN REVOKE`).
  const start = /\b(REVOKE|GRANT|DROP|ALTER|CREATE)\b/i.exec(fragment);
  if (!start) return operations;
  if (/\bALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(fragment)) return operations;
  const text = fragment.slice(start.index);
  const revoke = /^REVOKE\s+(GRANT\s+OPTION\s+FOR\s+)?(.+?)\s+ON\s+(.+?)\s+FROM\s+(.+)$/i.exec(
    text,
  );
  if (revoke) {
    if (revoke[1]) return operations;
    const privileges = privilegeSet(revoke[2]!);
    const grantees = splitTopLevel(revoke[4]!.replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, ""));
    const publicOnly =
      grantees.length > 0 && grantees.every((grantee) => /^PUBLIC$/i.test(grantee));
    for (const target of privilegeTargets(revoke[3]!.trim()))
      operations.push({ op: "revoke", target, privileges, publicOnly, sql: text });
    return operations;
  }
  const grant = /^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+(.+)$/i.exec(text);
  if (grant) {
    const privileges = privilegeSet(grant[1]!);
    for (const target of privilegeTargets(grant[2]!.trim()))
      operations.push({ op: "grant", target, privileges });
    return operations;
  }
  const drop = DROP_OBJECT.exec(text);
  if (drop) {
    for (const target of refsFor(kindOf(drop[1]!), drop[2]!))
      operations.push({ op: "drop", target, sql: text });
    return operations;
  }
  const alter = ALTER_OBJECT.exec(text);
  if (alter) {
    const kind = kindOf(alter[1]!);
    // RENAME VALUE/ATTRIBUTE and DROP ATTRIBUTE only exist on types.
    if (!/^RENAME\s+TO|^SET\s+SCHEMA/i.test(alter[3]!) && kind !== "type") return operations;
    for (const target of refsFor(kind, alter[2]!))
      operations.push({ op: "rename", target, sql: text });
    return operations;
  }
  const create = CREATE_OBJECT.exec(text);
  if (create) {
    const kind = kindOf(create[2]!);
    const replace = Boolean(create[1]) || Boolean(create[3]);
    for (const target of refsFor(kind, create[4]!))
      operations.push({ op: "create", target, replace });
  }
  return operations;
}

/** Operations in file order, read from top-level SQL and dynamic SQL alike. */
export function migrationOperations(sql: string): Operation[] {
  const operations: Operation[] = [];
  for (const statement of splitStatements(sql.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n"))) {
    for (const fragment of executableFragments(statement))
      operations.push(...fragmentOperations(fragment));
  }
  return operations;
}

// ---------------------------------------------------------------------------
// Judging removals

function sameObject(a: ObjectRef, b: ObjectRef): boolean {
  if (a.kind === "dynamic" || b.kind === "dynamic") return false;
  if (a.kind === "routine" && b.kind === "routine") {
    if (a.name === b.name) return true;
    // A routine named without arguments may be any overload.
    const bare = !a.name.includes("(") || !b.name.includes("(");
    return bare && routineName(a.name) === routineName(b.name);
  }
  const relation = (kind: ObjectKind) => (kind === "view" ? "table" : kind);
  return relation(a.kind) === relation(b.kind) && a.name === b.name;
}

/** Does a later GRANT cover this object? */
function grantCovers(grant: ObjectRef, target: ObjectRef): boolean {
  if (grant.kind === "all-in-schema") {
    if (target.kind === "routine")
      return grant.allOf === "routines" && (target.schema ?? "public") === grant.name;
    if (target.kind === "table" || target.kind === "view") {
      const schema = target.name.includes(".") ? target.name.split(".")[0] : "public";
      return grant.allOf === "tables" && schema === grant.name;
    }
    return false;
  }
  return sameObject(grant, target);
}

function routineMatches(set: ReadonlySet<string>, signature: string): string[] {
  if (set.has(signature)) return [signature];
  if (signature.includes("(")) return [];
  return [...set].filter((known) => routineName(known) === signature);
}

type Removal = {
  operation: Extract<Operation, { op: "revoke" | "drop" | "rename" }>;
  /** Previous-release dependencies it breaks, as messages. */
  dependencies: string[];
  /** Why it needs a contract-step annotation otherwise, or null. */
  annotationReason: string | null;
};

function describe(operation: Removal["operation"]): string {
  return operation.sql.length > 160 ? `${operation.sql.slice(0, 157)}...` : operation.sql;
}

function judgeRemoval(
  operation: Removal["operation"],
  contracts: readonly PreviousReleaseContract[],
  regranted: ReadonlySet<string>,
): Removal {
  const target = operation.target;
  const dependencies: string[] = [];
  /** Does the runtime end the migration without this privilege? */
  const loses = (privilege: string) =>
    operation.op !== "revoke" ||
    ((operation.privileges.has("ALL") || operation.privileges.has(privilege)) &&
      !regranted.has("ALL") &&
      !regranted.has(privilege));
  const verb =
    operation.op === "revoke"
      ? "revokes privileges on"
      : operation.op === "drop"
        ? "drops"
        : "renames";
  for (const contract of contracts) {
    if (target.kind === "routine") {
      for (const routine of routineMatches(contract.requiredRoutines, target.name)) {
        if (!loses("EXECUTE")) continue;
        dependencies.push(
          `${verb} routine ${routine}, whose runtime EXECUTE ${contract.label} requires (RUNTIME_DEFINER_ROUTINES, not deferred)`,
        );
      }
    } else if (target.kind === "all-in-schema") {
      const required =
        target.allOf === "routines"
          ? target.name === "opengeni_private"
            ? [...contract.requiredRoutines]
            : []
          : target.allOf === "tables"
            ? [...contract.tablePrivileges.keys()].filter((table) =>
                target.name === "public"
                  ? !table.includes(".")
                  : table.startsWith(`${target.name}.`),
              )
            : [];
      const lost =
        target.allOf === "routines"
          ? loses("EXECUTE")
          : ["SELECT", "INSERT", "UPDATE", "DELETE"].some(loses);
      if (required.length > 0 && operation.op === "revoke" && lost)
        dependencies.push(
          `revokes privileges on every ${target.allOf === "routines" ? "routine" : "table"} in schema ${target.name}, including ${required.slice(0, 3).join(", ")}${required.length > 3 ? ", ..." : ""}, which ${contract.label} requires`,
        );
    } else if (target.kind === "table" || target.kind === "view") {
      const required = contract.tablePrivileges.get(target.name);
      if (!required || required.size === 0) continue;
      if (operation.op === "revoke") {
        const lost = [...required].filter(loses);
        if (lost.length === 0) continue;
        dependencies.push(
          `revokes ${lost.join(", ")} on table ${target.name}, which ${contract.label} requires (RUNTIME_TABLE_PRIVILEGES)`,
        );
      } else if (!contract.optionalTables.has(target.name)) {
        dependencies.push(
          `${verb} table ${target.name}, which ${contract.label} uses (RUNTIME_TABLE_PRIVILEGES)`,
        );
      }
    } else if (target.kind === "schema" && contract.requiredSchemas.has(target.name)) {
      if (!loses("USAGE")) continue;
      dependencies.push(`${verb} schema ${target.name}, which ${contract.label} needs USAGE on`);
    }
  }
  let annotationReason: string | null = null;
  if (dependencies.length === 0) {
    if (target.kind === "dynamic") {
      annotationReason = `${verb.replace("privileges on", "privileges on an object")} whose name is built at run time (${describe(operation)})`;
    } else if (operation.op === "revoke") {
      if (regranted.size > 0) return { operation, dependencies, annotationReason: null };
      const known =
        target.kind === "routine" &&
        contracts.some(
          (contract) => routineMatches(contract.knownRoutines, target.name).length > 0,
        );
      if (known)
        annotationReason = `revokes privileges on routine ${target.name}, which the previous release's posture declares`;
    } else if (target.kind !== "table") {
      // Tables are the deployment-mode guard's (DROP TABLE, RENAME TO).
      annotationReason = `${verb} ${target.kind} ${target.name}`;
    }
  }
  return { operation, dependencies: [...new Set(dependencies)], annotationReason };
}

/**
 * The removals a migration performs that it does not undo itself, in file
 * order. An object created (not merely replaced) earlier in the same file is
 * new, so no earlier binary uses it.
 */
export function migrationRemovals(
  sql: string,
  contracts: readonly PreviousReleaseContract[],
): Removal[] {
  const operations = migrationOperations(sql);
  const removals: Removal[] = [];
  for (const [index, operation] of operations.entries()) {
    if (operation.op !== "revoke" && operation.op !== "drop" && operation.op !== "rename") continue;
    const target = operation.target;
    // The runtime holds explicit grants on its definers and tables; PUBLIC must
    // not, so revoking from PUBLIC alone enforces that posture. Schema USAGE
    // can come through PUBLIC, so it still counts there.
    if (operation.op === "revoke" && operation.publicOnly && target.kind !== "schema") continue;
    const earlier = operations.slice(0, index);
    const later = operations.slice(index + 1);
    if (
      earlier.some(
        (other) => other.op === "create" && !other.replace && sameObject(other.target, target),
      )
    )
      continue;
    const regranted = new Set(
      later.flatMap((other) =>
        other.op === "grant" && grantCovers(other.target, target) ? [...other.privileges] : [],
      ),
    );
    const recreated = later.some(
      (other) => other.op === "create" && sameObject(other.target, target),
    );
    const removal = judgeRemoval(operation, contracts, regranted);
    if (operation.op === "drop" && recreated) {
      // Recreated in the same transaction: the old binary sees the object, but
      // a dependency on its privileges must be granted again too.
      if (removal.dependencies.length === 0 || regranted.size > 0) continue;
    }
    if (removal.dependencies.length > 0 || removal.annotationReason) removals.push(removal);
  }
  return removals;
}

function contractStepProblem(value: { full: string }): string | null {
  const placeholder = placeholderReason(value.full);
  if (placeholder) return `the ${CONTRACT_STEP_KEY} annotation ${placeholder}`;
  if (value.full.length < MIN_CONTRACT_STEP_CHARS)
    return `the ${CONTRACT_STEP_KEY} annotation is too short (${value.full.length} characters, need at least ${MIN_CONTRACT_STEP_CHARS})`;
  return null;
}

/**
 * Check one migration a change adds against the releases that may still be
 * serving while it runs. Maintenance migrations run with the fleet stopped.
 */
export function analyzeMigrationPreviousRelease(
  file: string,
  sql: string,
  contracts: readonly PreviousReleaseContract[],
  removalGovernedFrom = REMOVAL_GOVERNED_FROM_ORDINAL,
): PreviousReleaseFinding[] {
  const text = sql.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  if ((text.split("\n", 1)[0] ?? "").trim() === MAINTENANCE_HEADER) return [];
  const removals = migrationRemovals(text, contracts);
  const findings: PreviousReleaseFinding[] = [];
  const dependencies = [...new Set(removals.flatMap((removal) => removal.dependencies))];
  if (dependencies.length > 0) {
    findings.push({
      file,
      kind: "previous-release-dependency",
      detail: `rolling migration runs while the previous release still serves, but it ${dependencies.join("; it ")}. Ship the binary that no longer needs it first and remove it in a later release's migration (contract phase), or make this a maintenance migration`,
    });
  }
  const ordinal = migrationOrdinal(file);
  if (ordinal === null || ordinal < removalGovernedFrom) return findings;
  const reasons = [
    ...new Set(
      removals
        .filter((removal) => removal.dependencies.length === 0 && removal.annotationReason)
        .map((removal) => removal.annotationReason!),
    ),
  ];
  if (reasons.length === 0) return findings;
  const contractStep = headerValue(text, CONTRACT_STEP_KEY);
  if (!contractStep) {
    findings.push({
      file,
      kind: "unannotated-removal",
      detail: `rolling migration ${reasons.join("; ")} without \`-- ${CONTRACT_STEP_KEY}: <the release after which nothing uses it, or why the previous release is unaffected>\` in the leading comment block`,
    });
    return findings;
  }
  const problem = contractStepProblem(contractStep);
  if (problem) findings.push({ file, kind: "unannotated-removal", detail: problem });
  return findings;
}
