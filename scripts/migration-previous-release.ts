/**
 * A rolling migration runs before the rollout, while a release built from an
 * earlier commit still serves every request. That binary's readiness enforces
 * its own runtime posture (`packages/db/src/runtime-posture.ts`). Revoking,
 * dropping or renaming something it declares it needs takes the old fleet
 * unready the moment the migration commits. On 10 November 2026, staging went
 * down this way: 1283 revoked EXECUTE on
 * `list_uncompacted_recording_tracks_v1`, which the release still serving
 * required.
 *
 * This analyzer judges a migration against the posture declarations of every
 * release that may still be serving. The CLI reads them from their own
 * source, never from today's.
 *
 * - `previous-release-dependency`: the migration removes something one of
 *   those releases declares it needs (see `previousReleaseContract`). No
 *   annotation clears it. Change the binary first (defer the routine, stop
 *   using the table), and remove the object in a later release's migration.
 *   Otherwise make the migration maintenance-mode, which stops the old fleet
 *   before it runs.
 * - `unannotated-removal`: static analysis cannot tell whether old code still
 *   uses the object. This covers revoking privileges on another routine the
 *   previous release knows, and dropping or renaming a routine, view, type,
 *   domain, sequence or schema the migration did not create. It also covers
 *   any removal whose target is assembled at run time. The migration must say
 *   why with the reviewed `-- contract-step:` annotation, as for dropped
 *   columns.
 *
 * A removal the same migration undoes before it commits is not a removal: a
 * REVOKE followed by a GRANT of the same privileges to the same grantee, or a
 * DROP followed by a CREATE and the grants the release requires. SQL in DO
 * blocks, in EXECUTE strings, and in helper routines the migration creates
 * and calls is read too.
 */
import { splitStatements, stripComments } from "../packages/db/src/migration-sql";
import { stripRoutineBodies } from "./migration-rls-backfills";
import {
  CONTRACT_STEP_KEY,
  MAINTENANCE_HEADER,
  contractStepProblem,
  headerValue,
  migrationOrdinal,
} from "./migration-deployment-mode";

/**
 * First ordinal the `unannotated-removal` rule governs: one above the newest
 * migration on main when it landed. Shipped migrations are immutable. The
 * `previous-release-dependency` rule has no floor: it judges every migration a
 * change adds against the releases before it.
 */
export const REMOVAL_GOVERNED_FROM_ORDINAL = 1359;

/** The application data schema. Migrations run with it first on the search path. */
const TARGET_SCHEMA = "public";
const PRIVATE_SCHEMA = "opengeni_private";
/** The runtime role's default name (`inspectRuntimePosture`'s `expectedRole`). */
const DEFAULT_RUNTIME_ROLE = "opengeni_app";

export type PreviousReleaseContract = {
  /** Where the declarations come from, for messages. */
  label: string;
  /** Routines whose runtime EXECUTE readiness requires: `name(arg types)` → schema. */
  requiredRoutines: ReadonlyMap<string, string>;
  /**
   * Routines whose runtime EXECUTE readiness requires while they exist, but
   * which may be dropped (`DECLARED_PRIVATE_ROUTINES`): only a revoke breaks it.
   */
  revokeRequiredRoutines: ReadonlyMap<string, string>;
  /** Routines readiness requires PUBLIC to be able to execute. */
  publicRoutines: ReadonlySet<string>;
  /** Every routine signature the release's posture knows, under any contract. */
  knownRoutines: ReadonlySet<string>;
  /** Tables with direct runtime privileges, and those privileges. */
  tablePrivileges: ReadonlyMap<string, ReadonlySet<string>>;
  /** Tables readiness lets be absent (`RETIRING_FEATURE_TABLES`): dropping them is the next step. */
  optionalTables: ReadonlySet<string>;
  /**
   * Routines readiness lets be absent once every table of their retiring
   * feature is gone: signature → that feature's tables.
   */
  retiringRoutines: ReadonlyMap<string, readonly string[]>;
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
  bpchar: "character",
  float: "double precision",
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
const PLACEHOLDER = /%[a-z]|\$\d/i;

function unquoteIdentifier(part: string): string {
  const trimmed = part.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2
    ? trimmed.slice(1, -1).replaceAll('""', '"')
    : trimmed.toLowerCase();
}

/** Split on a separator outside parentheses and double quotes. */
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
  // The quoted single-byte "char" type is not character(1).
  if (/^"char"\s*(\[\s*\])?$/.test(raw.trim())) return `"char"${raw.includes("[") ? "[]" : ""}`;
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

/**
 * A relation as the posture names it: target-schema tables bare, others
 * schema-qualified. A schema written as a format placeholder (`%I.t`) is the
 * data schema the migration is passed.
 */
export function normalizeRelationName(text: string): string {
  const parts = splitTopLevel(text.trim(), ".").map(unquoteIdentifier);
  if (parts.length === 2 && (parts[0] === TARGET_SCHEMA || PLACEHOLDER.test(parts[0]!)))
    return parts[1]!;
  return parts.join(".");
}

function routineName(signature: string): string {
  const open = signature.indexOf("(");
  return open === -1 ? signature : signature.slice(0, open);
}

/** The schema written before a routine name, or null when unqualified or a placeholder. */
function routineSchema(text: string): string | null {
  const open = text.indexOf("(");
  const parts = splitTopLevel((open === -1 ? text : text.slice(0, open)).trim(), ".");
  if (parts.length < 2 || PLACEHOLDER.test(parts[0]!)) return null;
  return unquoteIdentifier(parts[0]!);
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

function signatureList(posture: Record<string, unknown>, name: string, label: string): string[] {
  const value = posture[name];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !ROUTINE_SIGNATURE.test(item))
  ) {
    throw new Error(
      `${label}: runtime posture export ${name} is missing or no longer a list of routine signatures; update scripts/migration-previous-release.ts to read its replacement`,
    );
  }
  return value as string[];
}

/**
 * Exports whose routines readiness requires the runtime to EXECUTE, by naming
 * convention: `*_RUNTIME_ROUTINES` (private capabilities such as sandbox file
 * publication) and `*_CAPABILITY_ROUTINES` (target-schema capabilities).
 */
const RUNTIME_ROUTINE_EXPORT = /^(?:[A-Z0-9_]+_RUNTIME_ROUTINES|[A-Z0-9_]+_CAPABILITY_ROUTINES)$/;

/**
 * The dependencies one release declares, read from its runtime-posture module
 * (and its frozen legacy routine inventory, when it has one). It reads only
 * long-standing exports and throws when one is missing or reshaped, so an
 * unreadable release fails the guard instead of passing it.
 */
export function previousReleaseContract(
  label: string,
  posture: Record<string, unknown>,
  legacyRoutines?: { target?: unknown; private?: unknown } | null,
  postureSource?: string,
): PreviousReleaseContract {
  const deferred = new Set(
    signatureList(posture, "DEFERRED_RUNTIME_PRIVATE_ROUTINES", label).map(
      normalizeRoutineSignature,
    ),
  );
  const requiredRoutines = new Map<string, string>();
  for (const routine of signatureList(posture, "RUNTIME_DEFINER_ROUTINES", label)) {
    const signature = normalizeRoutineSignature(routine);
    if (!deferred.has(signature)) requiredRoutines.set(signature, PRIVATE_SCHEMA);
  }
  for (const routine of signatureList(posture, "RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES", label))
    requiredRoutines.set(normalizeRoutineSignature(routine), TARGET_SCHEMA);
  for (const name of Object.keys(posture).filter((key) => RUNTIME_ROUTINE_EXPORT.test(key))) {
    if (name === "RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES") continue;
    for (const routine of signatureList(posture, name, label)) {
      const signature = normalizeRoutineSignature(routine);
      if (!requiredRoutines.has(signature) && !deferred.has(signature))
        requiredRoutines.set(
          signature,
          name.endsWith("_RUNTIME_ROUTINES") ? PRIVATE_SCHEMA : TARGET_SCHEMA,
        );
    }
  }
  // Lists of the same convention the module does not export, from its source.
  // Some are owner-internal (triggers and workers the owner runs), which
  // readiness requires the runtime not to hold.
  const ownerInternal = new Set(
    (postureSource
      ? (sourceList(postureSource, posture, "OWNER_INTERNAL_PRIVATE_ROUTINES")?.items ?? [])
      : []
    ).map(normalizeRoutineSignature),
  );
  for (const name of postureSource
    ? sourceListNames(postureSource, RUNTIME_ROUTINE_EXPORT).filter(
        (candidate) => !(candidate in posture),
      )
    : [])
    for (const routine of sourceList(postureSource!, posture, name)?.items ?? []) {
      if (!ROUTINE_SIGNATURE.test(routine)) continue;
      const signature = normalizeRoutineSignature(routine);
      if (
        !requiredRoutines.has(signature) &&
        !deferred.has(signature) &&
        !ownerInternal.has(signature)
      )
        requiredRoutines.set(
          signature,
          name.endsWith("_RUNTIME_ROUTINES") ? PRIVATE_SCHEMA : TARGET_SCHEMA,
        );
    }
  const revokeRequiredRoutines = postureSource
    ? declaredPrivateRoutines(label, posture, postureSource, legacyRoutines?.private, deferred)
    : new Map<string, string>();
  for (const signature of requiredRoutines.keys()) revokeRequiredRoutines.delete(signature);
  const publicRoutines = new Set(
    signatureList(posture, "RUNTIME_TARGET_SCHEMA_PUBLIC_POLICY_PREDICATE_ROUTINES", label).map(
      normalizeRoutineSignature,
    ),
  );
  const knownRoutines = new Set<string>();
  collectSignatures(Object.values(posture), knownRoutines);
  collectSignatures(legacyRoutines?.target, knownRoutines);
  collectSignatures(legacyRoutines?.private, knownRoutines);
  const declared = posture.RUNTIME_TABLE_PRIVILEGES;
  if (!declared || typeof declared !== "object" || Object.keys(declared).length === 0)
    throw new Error(
      `${label}: runtime posture export RUNTIME_TABLE_PRIVILEGES is missing or empty`,
    );
  const tablePrivileges = new Map<string, ReadonlySet<string>>();
  for (const [table, privileges] of Object.entries(declared)) {
    if (!Array.isArray(privileges) || privileges.some((item) => typeof item !== "string"))
      throw new Error(`${label}: RUNTIME_TABLE_PRIVILEGES.${table} is not a privilege list`);
    tablePrivileges.set(
      normalizeRelationName(table),
      new Set(privileges.map((privilege: string) => privilege.toUpperCase())),
    );
  }
  const retiring = posture.RETIRING_FEATURE_TABLES;
  const featureTables = new Map(
    Object.entries(retiring && typeof retiring === "object" ? retiring : {}).map(
      ([feature, tables]) => [
        feature,
        (Array.isArray(tables) ? tables : [])
          .filter((table): table is string => typeof table === "string")
          .map(normalizeRelationName),
      ],
    ),
  );
  const optionalTables = new Set([...featureTables.values()].flat());
  return {
    label,
    requiredRoutines,
    revokeRequiredRoutines,
    publicRoutines,
    knownRoutines,
    tablePrivileges,
    optionalTables,
    retiringRoutines: postureSource
      ? retiringRoutinesFromSource(postureSource, posture, featureTables)
      : new Map(),
    requiredSchemas: new Set([TARGET_SCHEMA, PRIVATE_SCHEMA]),
  };
}

/** The source text from an opening `[` to its matching `]`, outside strings and comments. */
function bracketBody(source: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
    } else if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
    } else if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 1;
    } else if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "[") depth += 1;
    else if (char === "]" && --depth === 0) return source.slice(open + 1, index);
  }
  return null;
}

type SourceList = {
  items: string[];
  complete: boolean;
  /** Items that are neither string literals nor spreads of readable lists. */
  unreadable: string[];
};

/**
 * The string items of a list declared in a release's posture source, as
 * `const NAME = [...]` or `const NAME = new Set([...])`, expanding `...OTHER`
 * spreads of other lists. Exports are taken from the module itself.
 * `complete` is false when an item could not be read.
 */
export function sourceList(
  source: string,
  posture: Record<string, unknown>,
  name: string,
  depth = 0,
): SourceList | null {
  const exported = posture[name];
  if (Array.isArray(exported) || exported instanceof Set) {
    const values = [...exported];
    const items = values.filter((value): value is string => typeof value === "string");
    return {
      items,
      complete: items.length === values.length,
      unreadable: values.filter((value) => typeof value !== "string").map(String),
    };
  }
  const declaration = new RegExp(
    String.raw`\bconst ${name}\b[^=;]*=\s*(?:new\s+Set\s*(?:<[^>()]*>)?\s*\(\s*)?\[`,
  ).exec(source);
  if (!declaration || depth > 4) return null;
  const body = bracketBody(source, declaration.index + declaration[0].length - 1);
  if (body === null) return null;
  const result: SourceList = { items: [], complete: true, unreadable: [] };
  const uncommented = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const item of splitTopLevel(uncommented)) {
    const text = item.trim();
    if (text === "") continue;
    const literal = /^"([^"\\]*)"$/.exec(text);
    const spread = /^\.\.\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(text);
    const nested = spread ? sourceList(source, posture, spread[1]!, depth + 1) : null;
    if (literal) result.items.push(literal[1]!);
    else if (nested) {
      result.items.push(...nested.items);
      result.unreadable.push(...nested.unreadable);
      result.complete &&= nested.complete;
    } else {
      result.complete = false;
      result.unreadable.push(text);
    }
  }
  return result;
}

/** Names of the lists a release's source declares whose name matches. */
function sourceListNames(source: string, pattern: RegExp): string[] {
  return [
    ...new Set(
      [...source.matchAll(/\bconst ([A-Z][A-Z0-9_]*)\b/g)]
        .map((match) => match[1]!)
        .filter((name) => pattern.test(name)),
    ),
  ];
}

/**
 * The release's internal `RETIRING_*_ROUTINES` sets, read from its source:
 * readiness skips a missing routine in one of them once every table of the
 * matching `RETIRING_FEATURE_TABLES` feature is gone. A set that cannot be read
 * or matched to exactly one feature is left out, which keeps its routines
 * required.
 */
export function retiringRoutinesFromSource(
  source: string,
  posture: Record<string, unknown>,
  featureTables: ReadonlyMap<string, readonly string[]>,
): Map<string, readonly string[]> {
  const routines = new Map<string, readonly string[]>();
  for (const name of sourceListNames(source, /^RETIRING_[A-Z0-9_]+_ROUTINES$/)) {
    const subject = name.slice("RETIRING_".length, -"_ROUTINES".length);
    const features = [...featureTables].filter(([feature]) => {
      const token = feature.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
      return subject.startsWith(token) || token.startsWith(subject);
    });
    const list = sourceList(source, posture, name);
    if (features.length !== 1 || features[0]![1].length === 0 || !list) continue;
    for (const routine of list.items)
      if (ROUTINE_SIGNATURE.test(routine))
        routines.set(normalizeRoutineSignature(routine), features[0]![1]);
  }
  return routines;
}

/**
 * Private routines readiness requires the runtime to EXECUTE whenever they
 * exist (`DECLARED_PRIVATE_ROUTINES`): the frozen legacy inventory, less the
 * owner-internal, retired and deferred routines. It throws when the
 * owner-internal list cannot be read in full, so the guard fails instead of
 * silently treating every legacy routine as revocable.
 */
function declaredPrivateRoutines(
  label: string,
  posture: Record<string, unknown>,
  source: string,
  legacyPrivate: unknown,
  deferred: ReadonlySet<string>,
): Map<string, string> {
  const routines = new Map<string, string>();
  const ownerInternal = sourceList(source, posture, "OWNER_INTERNAL_PRIVATE_ROUTINES");
  // A release that imports the frozen inventory must supply it.
  if (source.includes("runtime-posture-legacy-routines.json")) {
    if (!Array.isArray(legacyPrivate) || legacyPrivate.length === 0)
      throw new Error(
        `${label}: its runtime posture imports runtime-posture-legacy-routines.json, but no private routine inventory was read from it`,
      );
  } else if (!Array.isArray(legacyPrivate) || legacyPrivate.length === 0) return routines;
  if (!ownerInternal?.complete)
    throw new Error(
      `${label}: cannot read runtime posture list OWNER_INTERNAL_PRIVATE_ROUTINES${ownerInternal ? ` (unreadable item ${ownerInternal.unreadable[0] ?? "?"})` : ""}; update scripts/migration-previous-release.ts to read it`,
    );
  const excluded = new Set([...ownerInternal.items, ...deferred].map(normalizeRoutineSignature));
  for (const [name, field] of [
    ["SUBSCRIPTION_RETIRED_ROUTINES", "signature"],
    ["SUBSCRIPTION_RENAMED_ROUTINES", "from"],
  ] as const) {
    const entries = posture[name];
    for (const entry of Array.isArray(entries) ? entries : []) {
      const value = (entry as Record<string, unknown> | null)?.[field];
      if (typeof value === "string" && ROUTINE_SIGNATURE.test(value))
        excluded.add(normalizeRoutineSignature(value));
    }
  }
  for (const routine of legacyPrivate)
    if (typeof routine === "string" && ROUTINE_SIGNATURE.test(routine)) {
      const signature = normalizeRoutineSignature(routine);
      if (!excluded.has(signature)) routines.set(signature, PRIVATE_SCHEMA);
    }
  return routines;
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
};

export type Operation =
  | {
      op: "revoke";
      target: ObjectRef;
      privileges: ReadonlySet<string>;
      grantees: readonly string[];
      sql: string;
    }
  | { op: "grant"; target: ObjectRef; privileges: ReadonlySet<string>; grantees: readonly string[] }
  | { op: "drop"; target: ObjectRef; sql: string }
  | { op: "rename"; target: ObjectRef; sql: string }
  | { op: "create"; target: ObjectRef; replace: boolean; topLevel: boolean };

type Fragment = {
  text: string;
  topLevel: boolean;
  /** The text after a dynamic SQL string: its `format()` arguments, if any. */
  args?: string;
};

const ROUTINE_HEAD =
  /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+((?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*))?)/i;

/**
 * Executable fragments of one statement, comments removed and split at `;`,
 * single quotes and dollar-quote tags, so SQL inside a DO block or an EXECUTE
 * string is read as its own fragment. Adjacent literals joined with `||` are
 * read as one. Routine bodies run later, not during the migration, so they
 * are dropped unless `keepBodies` (a helper the migration calls).
 */
export function executableFragments(statement: string, keepBodies = false): Fragment[] {
  const text = stripComments(keepBodies ? statement : stripRoutineBodies(statement)).replace(
    /'\s*\|\|\s*'/g,
    "",
  );
  return text
    .split(/;|'|\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/)
    .map((fragment, index) => ({
      text: fragment.replace(/\s+/g, " ").trim(),
      topLevel: index === 0,
    }))
    .filter((fragment) => fragment.text !== "");
}

function routineRefs(list: string): ObjectRef[] {
  return splitTopLevel(list).flatMap((text): ObjectRef[] => {
    const open = text.indexOf("(");
    const name = open === -1 ? text : text.slice(0, open);
    if (name.trim() === "" || PLACEHOLDER.test(splitTopLevel(name, ".").pop() ?? name))
      return [{ kind: "dynamic", name: text }];
    // Session-local temporary routines are new to this migration.
    if (/^\s*pg_temp\s*\./i.test(name)) return [];
    return [
      { kind: "routine", name: normalizeRoutineSignature(text), schema: routineSchema(text) },
    ];
  });
}

function relationRefs(kind: ObjectKind, list: string): ObjectRef[] {
  return splitTopLevel(list).flatMap((text): ObjectRef[] => {
    const name = text.split(/\s+/)[0] ?? "";
    if (name === "" || PLACEHOLDER.test(splitTopLevel(name, ".").pop() ?? name))
      return [{ kind: "dynamic", name: text }];
    // Session-local temporary objects are new to this migration.
    if (/^pg_temp\s*\./i.test(name)) return [];
    return [{ kind, name: normalizeRelationName(name) }];
  });
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
    return splitTopLevel(all[2]!).map((schema) =>
      PLACEHOLDER.test(schema)
        ? { kind: "all-in-schema", name: TARGET_SCHEMA, allOf }
        : { kind: "all-in-schema", name: unquoteIdentifier(schema), allOf },
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

/**
 * Table- or object-level privileges. A column list (`UPDATE (c)`) grants or
 * revokes only column privileges, which never satisfy or remove a table-level
 * one, so it is left out.
 */
function privilegeSet(text: string): Set<string> {
  const privileges = new Set<string>();
  for (const part of splitTopLevel(text)) {
    if (part.includes("(")) continue;
    const word = part.trim().toUpperCase();
    privileges.add(/^ALL\b/.test(word) ? "ALL" : word);
  }
  return privileges;
}

/**
 * Grantee names, lowercased unless quoted. A placeholder (`%I`) is only the
 * same role as another placeholder with the same `format()` arguments.
 */
function granteeList(text: string, args = ""): string[] {
  return splitTopLevel(text.replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, ""))
    .map((grantee) =>
      grantee
        .replace(/\s+(?:WITH\s+GRANT\s+OPTION|GRANTED\s+BY\s+.*)$/i, "")
        .replace(/^GROUP\s+/i, "")
        .trim(),
    )
    .map((grantee) =>
      PLACEHOLDER.test(grantee)
        ? `${grantee.toLowerCase()}@${args.toLowerCase()}`
        : unquoteIdentifier(grantee),
    )
    .filter((grantee) => grantee !== "");
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
  String.raw`^DROP\s+${OBJECT_KEYWORD}\s+(?:IF\s+EXISTS\s+)?(.*?)(?:\s+(?:CASCADE|RESTRICT))?$`,
  "i",
);
const ALTER_OBJECT = new RegExp(
  String.raw`^ALTER\s+${OBJECT_KEYWORD}\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(.+?)\s+(RENAME\s+TO|SET\s+SCHEMA|RENAME\s+(?:VALUE|ATTRIBUTE)|DROP\s+ATTRIBUTE)\b`,
  "i",
);
/** `ALTER <kind> ... RENAME TO` or `SET SCHEMA` whose target could not be read. */
const ALTER_REMOVAL = new RegExp(
  String.raw`^ALTER\s+${OBJECT_KEYWORD}\b.*\b(?:RENAME\s+TO|SET\s+SCHEMA)\b`,
  "i",
);
const CREATE_OBJECT = new RegExp(
  String.raw`^CREATE\s+(OR\s+REPLACE\s+)?(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?(?:RECURSIVE\s+)?${OBJECT_KEYWORD}\s+(IF\s+NOT\s+EXISTS\s+)?((?:"(?:[^"]|"")+"|[A-Za-z_%][A-Za-z0-9_$]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*))?(?:\s*\([^)]*\))?)`,
  "i",
);

function kindOf(keyword: string): ObjectKind {
  return DROP_KINDS[keyword.replace(/\s+/g, " ").toUpperCase()] ?? "table";
}

function refsFor(kind: ObjectKind, list: string): ObjectRef[] {
  return kind === "routine" ? routineRefs(list) : relationRefs(kind, list);
}

const DYNAMIC: ObjectRef = { kind: "dynamic", name: "<unreadable>" };

/** Every privilege, drop, rename and create one fragment performs. */
function fragmentOperations(fragment: Fragment): Operation[] {
  const operations: Operation[] = [];
  // A statement may sit after other text in its fragment (e.g. `BEGIN REVOKE`).
  const start = /\b(REVOKE|GRANT|DROP|ALTER|CREATE)\b/i.exec(fragment.text);
  if (!start) return operations;
  if (/\bALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(fragment.text)) return operations;
  const text = fragment.text.slice(start.index);
  const topLevel = fragment.topLevel && start.index === 0;
  if (/^REVOKE\b/i.test(text)) {
    const revoke = /^REVOKE\s+(GRANT\s+OPTION\s+FOR\s+)?(.+?)\s+ON\s+(.+?)\s+FROM\s+(.+)$/i.exec(
      text,
    );
    if (revoke?.[1]) return operations;
    if (!revoke) {
      // A role-membership revoke has no ON clause; anything else is unreadable.
      if (/\bON\b/i.test(text) || !/\bFROM\b/i.test(text))
        operations.push({
          op: "revoke",
          target: DYNAMIC,
          privileges: new Set(["ALL"]),
          grantees: [],
          sql: text,
        });
      return operations;
    }
    const privileges = privilegeSet(revoke[2]!);
    if (privileges.size === 0) return operations;
    const grantees = granteeList(revoke[4]!, fragment.args);
    for (const target of privilegeTargets(revoke[3]!.trim()))
      operations.push({ op: "revoke", target, privileges, grantees, sql: text });
    return operations;
  }
  const grant = /^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+(.+)$/i.exec(text);
  if (grant) {
    const privileges = privilegeSet(grant[1]!);
    const grantees = granteeList(grant[3]!, fragment.args);
    for (const target of privilegeTargets(grant[2]!.trim()))
      operations.push({ op: "grant", target, privileges, grantees });
    return operations;
  }
  const drop = DROP_OBJECT.exec(text);
  if (drop) {
    const targets = drop[2]!.trim() === "" ? [DYNAMIC] : refsFor(kindOf(drop[1]!), drop[2]!);
    for (const target of targets) operations.push({ op: "drop", target, sql: text });
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
  if (ALTER_REMOVAL.test(text)) {
    operations.push({ op: "rename", target: DYNAMIC, sql: text });
    return operations;
  }
  const create = CREATE_OBJECT.exec(text);
  if (create) {
    const kind = kindOf(create[2]!);
    const replace = Boolean(create[1]) || Boolean(create[3]);
    for (const target of refsFor(kind, create[4]!))
      operations.push({ op: "create", target, replace, topLevel });
  }
  return operations;
}

/**
 * Bodies of routines the migration creates and then calls while it runs (for
 * example a `pg_temp` helper): those run at migration time.
 */
function calledHelperBodies(statements: readonly string[]): Map<number, true> {
  const created = new Map<string, number>();
  for (const [index, statement] of statements.entries()) {
    const head = ROUTINE_HEAD.exec(stripComments(statement).trim());
    if (head) created.set(normalizeRoutineSignature(head[1]!), index);
  }
  const called = new Map<number, true>();
  for (const [name, index] of created) {
    const call = new RegExp(
      String.raw`(?:^|[^A-Za-z0-9_$."])(?:[A-Za-z_][A-Za-z0-9_$]*\s*\.\s*)?${name.replace(/\$/g, "\\$")}\s*\(`,
      "i",
    );
    if (
      statements.some(
        (statement, other) =>
          other !== index &&
          !/^\s*DROP\b/i.test(stripComments(statement)) &&
          call.test(stripComments(statement).replace(/"/g, "")),
      )
    )
      called.set(index, true);
  }
  return called;
}

/** Operations in file order, read from top-level SQL and dynamic SQL alike. */
export function migrationOperations(sql: string): Operation[] {
  const statements = splitStatements(sql.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n"));
  const helpers = calledHelperBodies(statements);
  const operations: Operation[] = [];
  for (const [index, statement] of statements.entries()) {
    const fragments = executableFragments(statement, helpers.has(index));
    for (const [position, fragment] of fragments.entries())
      operations.push(
        ...fragmentOperations({ ...fragment, args: fragments[position + 1]?.text ?? "" }),
      );
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

function relationSchema(name: string): string {
  return name.includes(".") ? name.split(".")[0]! : TARGET_SCHEMA;
}

/** Does a GRANT target cover this object? */
function grantCovers(grant: ObjectRef, target: ObjectRef): boolean {
  if (grant.kind === "all-in-schema") {
    if (target.kind === "routine")
      return grant.allOf === "routines" && (target.schema ?? TARGET_SCHEMA) === grant.name;
    if (target.kind === "table" || target.kind === "view")
      return grant.allOf === "tables" && relationSchema(target.name) === grant.name;
    return false;
  }
  return sameObject(grant, target);
}

function routineMatches<T>(
  set: ReadonlyMap<string, T> | ReadonlySet<string>,
  signature: string,
): string[] {
  if (set.has(signature)) return [signature];
  if (signature.includes("(")) return [];
  return [...set.keys()].filter((known) => routineName(known) === signature);
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

/** Stands for the releases that need something, filled in once per message. */
const RELEASE = "\u0000release\u0000";

function judgeRemoval(
  operation: Removal["operation"],
  contracts: readonly PreviousReleaseContract[],
  restored: ReadonlySet<string>,
  restoredToPublic: ReadonlySet<string>,
  recreated: boolean,
  droppedTables: ReadonlySet<string>,
): Removal {
  const target = operation.target;
  const needed = new Map<string, string[]>();
  /** A retiring feature's routine dropped with the feature's last tables: judged safe. */
  let retiredWithFeature = false;
  const verb =
    operation.op === "revoke"
      ? "revokes privileges on"
      : operation.op === "drop"
        ? "drops"
        : "renames";
  const publicOnly =
    operation.op === "revoke" &&
    operation.grantees.length > 0 &&
    operation.grantees.every((grantee) => grantee === "public");
  /** Does the runtime (or, for `toPublic`, PUBLIC) end the migration without this privilege? */
  const loses = (privilege: string, back: ReadonlySet<string> = restored) =>
    (operation.op !== "revoke" ||
      operation.privileges.has("ALL") ||
      operation.privileges.has(privilege)) &&
    !back.has("ALL") &&
    !back.has(privilege);
  // Which grantees the operation takes privileges from: a drop or rename
  // takes them from everyone.
  const fromRuntime = operation.op !== "revoke" || !publicOnly;
  const fromPublic = operation.op === "revoke" ? operation.grantees.includes("public") : !recreated;
  for (const contract of contracts) {
    const need = (message: string) =>
      needed.set(message, [...(needed.get(message) ?? []), contract.label]);
    if (target.kind === "routine") {
      // The runtime holds explicit grants on the routines it needs; PUBLIC
      // must not, except for the shared policy predicates (and a recreated
      // function is PUBLIC-executable again by default).
      // Readiness skips a retiring feature's routine once the feature's
      // tables are gone; this migration removing both is that step.
      const retired = (routine: string) =>
        operation.op !== "revoke" &&
        !recreated &&
        (contract.retiringRoutines.get(routine)?.every((table) => droppedTables.has(table)) ??
          false);
      if (fromRuntime && loses("EXECUTE"))
        for (const routine of routineMatches(contract.requiredRoutines, target.name).filter(
          (candidate) => {
            if (!retired(candidate)) return true;
            retiredWithFeature = true;
            return false;
          },
        ))
          need(
            `${verb} routine ${routine}${recreated ? " without granting EXECUTE back" : ""}, whose runtime EXECUTE ${RELEASE} requires`,
          );
      if (operation.op === "revoke" && fromRuntime && loses("EXECUTE"))
        for (const routine of routineMatches(contract.revokeRequiredRoutines, target.name))
          need(
            `revokes privileges on routine ${routine}, whose runtime EXECUTE ${RELEASE} requires while it exists (DECLARED_PRIVATE_ROUTINES)`,
          );
      if (fromPublic && loses("EXECUTE", restoredToPublic))
        for (const routine of routineMatches(contract.publicRoutines, target.name))
          need(
            `${verb === "revokes privileges on" ? "revokes PUBLIC's EXECUTE on" : verb} routine ${routine}, which ${RELEASE} requires PUBLIC to execute (RUNTIME_TARGET_SCHEMA_PUBLIC_POLICY_PREDICATE_ROUTINES)`,
          );
    } else if (target.kind === "all-in-schema") {
      if (operation.op !== "revoke") continue;
      if (target.allOf === "routines" && fromPublic && loses("EXECUTE", restoredToPublic)) {
        const predicates = [...contract.publicRoutines].filter(
          (routine) => (contract.requiredRoutines.get(routine) ?? TARGET_SCHEMA) === target.name,
        );
        if (predicates.length > 0)
          need(
            `revokes PUBLIC's EXECUTE on every routine in schema ${target.name}, including ${predicates.slice(0, 3).join(", ")}${predicates.length > 3 ? ", ..." : ""}, which ${RELEASE} requires PUBLIC to execute (RUNTIME_TARGET_SCHEMA_PUBLIC_POLICY_PREDICATE_ROUTINES)`,
          );
      }
      if (publicOnly) continue;
      const required =
        target.allOf === "routines"
          ? loses("EXECUTE")
            ? [...contract.requiredRoutines, ...contract.revokeRequiredRoutines]
                .filter(([, schema]) => schema === target.name)
                .map(([routine]) => routine)
            : []
          : target.allOf === "tables"
            ? [...contract.tablePrivileges]
                .filter(
                  ([table, privileges]) =>
                    relationSchema(table) === target.name &&
                    [...privileges].some((privilege) => loses(privilege)),
                )
                .map(([table]) => table)
            : [];
      if (required.length > 0)
        need(
          `revokes privileges on every ${target.allOf === "routines" ? "routine" : "table"} in schema ${target.name}, including ${required.slice(0, 3).join(", ")}${required.length > 3 ? ", ..." : ""}, which ${RELEASE} requires`,
        );
    } else if (target.kind === "table" || target.kind === "view") {
      const required = contract.tablePrivileges.get(target.name);
      if (!required || required.size === 0 || publicOnly) continue;
      if (operation.op === "drop" && !recreated && contract.optionalTables.has(target.name))
        continue;
      if (operation.op === "rename" && contract.optionalTables.has(target.name)) continue;
      const missing =
        operation.op === "rename"
          ? [...required]
          : [...required].filter((privilege) => loses(privilege));
      if (missing.length === 0) continue;
      need(
        operation.op === "revoke" || recreated
          ? `${operation.op === "revoke" ? "revokes" : "drops and recreates without granting back"} ${missing.join(", ")} on table ${target.name}, which ${RELEASE} requires (RUNTIME_TABLE_PRIVILEGES)`
          : `${verb} table ${target.name}, which ${RELEASE} uses (RUNTIME_TABLE_PRIVILEGES)`,
      );
    } else if (target.kind === "schema" && contract.requiredSchemas.has(target.name)) {
      // USAGE on the data schema can come through PUBLIC, so PUBLIC counts here.
      if (!loses("USAGE")) continue;
      need(`${verb} schema ${target.name}, which ${RELEASE} needs USAGE on`);
    }
  }
  const dependencies = [...needed].map(([message, labels]) => {
    const releases =
      labels.length <= 2
        ? labels.join(" and ")
        : `${labels[0]} and ${labels.length - 1} other releases that may still serve`;
    return labels.length === 1
      ? message.replaceAll(RELEASE, releases)
      : message.replace(
          new RegExp(`${RELEASE} (requires|uses|needs)\\b`, "g"),
          (_, singular: string) => `${releases} ${singular.slice(0, -1)}`,
        );
  });
  let annotationReason: string | null = null;
  if (dependencies.length === 0 && !(operation.op === "drop" && recreated) && !retiredWithFeature) {
    if (target.kind === "dynamic") {
      if (!publicOnly)
        annotationReason = `${verb} an object it names at run time or that the guard cannot read (${describe(operation)})`;
    } else if (operation.op === "revoke") {
      const known =
        target.kind === "routine" &&
        !publicOnly &&
        restored.size === 0 &&
        contracts.some(
          (contract) => routineMatches(contract.knownRoutines, target.name).length > 0,
        );
      if (known)
        annotationReason = `revokes privileges on routine ${target.name}, which the previous release's posture declares`;
    } else if (target.kind !== "table" && target.kind !== "all-in-schema") {
      // Tables are the deployment-mode guard's (DROP TABLE, RENAME TO).
      annotationReason = `${verb} ${target.kind} ${target.name}`;
    }
  }
  return { operation, dependencies: [...new Set(dependencies)], annotationReason };
}

/**
 * Tables a migration leaves dropped when it commits (it applies atomically):
 * dropped and not created again by a top-level statement.
 */
export function migrationDroppedTables(
  sqlOrOperations: string | readonly Operation[],
): Set<string> {
  const operations =
    typeof sqlOrOperations === "string" ? migrationOperations(sqlOrOperations) : sqlOrOperations;
  return new Set(
    operations
      .filter(
        (operation) =>
          operation.op === "drop" &&
          operation.target.kind === "table" &&
          !operations.some(
            (other) =>
              other.op === "create" && other.topLevel && sameObject(other.target, operation.target),
          ),
      )
      .map((operation) => operation.target.name),
  );
}

/**
 * The removals a migration performs that it does not undo itself, in file
 * order. An object created (not merely replaced) by an unconditional
 * top-level statement earlier in the same file is new, so no earlier binary
 * uses it.
 */
export function migrationRemovals(
  sql: string,
  contracts: readonly PreviousReleaseContract[],
  priorDroppedTables: ReadonlySet<string> = new Set(),
): Removal[] {
  const operations = migrationOperations(sql);
  const removals: Removal[] = [];
  const droppedTables = new Set([...priorDroppedTables, ...migrationDroppedTables(operations)]);
  for (const [index, operation] of operations.entries()) {
    if (operation.op !== "revoke" && operation.op !== "drop" && operation.op !== "rename") continue;
    const target = operation.target;
    const earlier = operations.slice(0, index);
    const later = operations.slice(index + 1);
    if (
      earlier.some(
        (other) =>
          other.op === "create" &&
          !other.replace &&
          other.topLevel &&
          sameObject(other.target, target),
      )
    )
      continue;
    const recreatedAt = later.findIndex(
      (other) => other.op === "create" && other.topLevel && sameObject(other.target, target),
    );
    const recreated = operation.op === "drop" && recreatedAt !== -1;
    // A grant restores a revoke only for the grantees it revoked (PUBLIC
    // reaches everyone). After a drop and create, only grants to PUBLIC or
    // to the runtime role (by its default name or a placeholder) count.
    const restoring = (grantees: readonly string[]) =>
      grantees.includes("public") ||
      (operation.op === "revoke"
        ? operation.grantees
            .filter((grantee) => grantee !== "public")
            .every((grantee) => grantees.includes(grantee))
        : grantees.some(
            (grantee) => grantee === DEFAULT_RUNTIME_ROLE || PLACEHOLDER.test(grantee),
          ));
    const grantsAfter = (
      recreated ? later.slice(recreatedAt) : operation.op === "revoke" ? later : []
    )
      .filter((other) => other.op === "grant" && grantCovers(other.target, target))
      .map((other) => other as Extract<Operation, { op: "grant" }>);
    const restored = new Set(
      grantsAfter.flatMap((grant) => (restoring(grant.grantees) ? [...grant.privileges] : [])),
    );
    const restoredToPublic = new Set(
      grantsAfter.flatMap((grant) =>
        grant.grantees.includes("public") ? [...grant.privileges] : [],
      ),
    );
    const removal = judgeRemoval(
      operation,
      contracts,
      restored,
      restoredToPublic,
      recreated,
      droppedTables,
    );
    if (removal.dependencies.length > 0 || removal.annotationReason) removals.push(removal);
  }
  return removals;
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
  /** Tables the change's earlier migrations drop: they run first, in the same rollout. */
  priorDroppedTables: ReadonlySet<string> = new Set(),
): PreviousReleaseFinding[] {
  const text = sql.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  if ((text.split("\n", 1)[0] ?? "").trim() === MAINTENANCE_HEADER) return [];
  const removals = migrationRemovals(text, contracts, priorDroppedTables);
  const findings: PreviousReleaseFinding[] = [];
  const dependencies = [...new Set(removals.flatMap((removal) => removal.dependencies))];
  if (dependencies.length > 0) {
    findings.push({
      file,
      kind: "previous-release-dependency",
      detail: `rolling migration runs while earlier releases still serve, but it ${dependencies.join("; it ")}. Ship the binary that no longer needs it first and remove it in a later release's migration (contract phase), or make this a maintenance migration`,
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
