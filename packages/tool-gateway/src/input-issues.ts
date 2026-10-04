import type { ErrorObject } from "ajv";

/**
 * One argument problem found by input-schema validation. Every field is derived
 * from the property path and the tool's schema, never from an argument value,
 * so the summary is safe to show to the model and to return over HTTP.
 */
export type ToolGatewayInputIssue = {
  /** Readable path of the offending property (`context`, `filters[0].field`); empty for the arguments object itself. */
  readonly path: string;
  /** JSON Schema keyword that failed, such as `required`, `type`, or `additionalProperties`. */
  readonly keyword: string;
  /** Short, value-free sentence fragment naming the property and what the schema expects. */
  readonly message: string;
};

export type ToolGatewayInputIssueSummary = {
  readonly issues: readonly ToolGatewayInputIssue[];
  /** Distinct problems found beyond the reported cap. */
  readonly omittedIssueCount: number;
};

/** Maximum problems named in one validation error. */
export const TOOL_GATEWAY_INPUT_ISSUES_MAX = 8;

const PATH_MAX_CHARS = 120;
const MESSAGE_DETAIL_MAX_CHARS = 160;
const ALLOWED_VALUES_MAX = 10;
const ALLOWED_VALUE_MAX_CHARS = 60;

/**
 * Convert validator errors into a capped, de-duplicated list of value-free issues.
 * Validator messages only quote schema facts (types, limits, patterns), and
 * values offered here come from `enum`/`const` in the schema, not the arguments.
 * Supplying the input schema and arguments also distinguishes union alternatives;
 * arguments are inspected only to select schema facts, never included in text.
 */
export function summarizeToolGatewayInputErrors(
  errors: readonly ErrorObject[] | null | undefined,
  input?: { schema: Record<string, unknown>; arguments: Record<string, unknown> },
): ToolGatewayInputIssueSummary {
  const issues: ToolGatewayInputIssue[] = [];
  const seen = new Set<string>();
  let omittedIssueCount = 0;
  let candidates = unscopedInputIssues(errors ?? []);
  if (input) {
    try {
      candidates = unionAwareIssues(errors ?? [], input);
    } catch {
      // Diagnostics cannot replace the already-decided input rejection.
    }
  }
  for (const issue of candidates) {
    if (seen.has(issue.message)) continue;
    seen.add(issue.message);
    if (issues.length < TOOL_GATEWAY_INPUT_ISSUES_MAX) issues.push(issue);
    else omittedIssueCount += 1;
  }
  return { issues, omittedIssueCount };
}

/** Without bounded argument diagnostics, union errors are alternatives only. */
function unscopedInputIssues(errors: readonly ErrorObject[]): ToolGatewayInputIssue[] {
  const union = errors.find((error) => error.keyword === "anyOf" || error.keyword === "oneOf");
  if (!union) return errors.map(issueFromError);
  const path = displayPath(pointerSegments(union.instancePath));
  return [
    {
      path,
      keyword: union.keyword,
      message: `${describe(path)} must match ${union.keyword === "oneOf" ? "exactly one" : "one"} declared alternative input format`,
    },
  ];
}

type JsonSchema = Record<string, unknown>;
type LiteralConstraint = { path: readonly string[]; values: readonly unknown[]; required: boolean };
type UnionDiagnostic = {
  error: ErrorObject;
  branchPrefixes: readonly (readonly string[])[];
  selected: number | undefined;
  replacement: ToolGatewayInputIssue | undefined;
  unresolved?: boolean;
};

/**
 * An anyOf/oneOf failure contains errors from mutually exclusive alternatives.
 * A supplied const/enum tag can rule alternatives out, but a missing property or
 * a count of failures cannot choose one. Without a unique compatible branch,
 * describe the alternatives explicitly instead of combining their requirements.
 */
function unionAwareIssues(
  errors: readonly ErrorObject[],
  input: { schema: JsonSchema; arguments: Record<string, unknown> },
): ToolGatewayInputIssue[] {
  if (!errors.some((error) => error.keyword === "anyOf" || error.keyword === "oneOf"))
    return errors.map(issueFromError);
  const unions: UnionDiagnostic[] = [];
  const order = new Map(errors.map((error, index) => [error, index]));
  const independent = unconditionalErrorSites(input.schema, input.arguments, errors);
  const uncertainByPath = indexByPath(independent.uncertain, (entry) => entry.instancePath, false);
  const ownershipUncertain = (error: ErrorObject) =>
    !independent.sites.has(errorSite(error.schemaPath, error.instancePath)) &&
    pathAncestors(error.instancePath).some((path) =>
      (uncertainByPath.get(path) ?? []).some(
        (entry) =>
          error.schemaPath === entry.prefix || error.schemaPath.startsWith(`${entry.prefix}/`),
      ),
    );
  const belongs = (error: ErrorObject, union: ErrorObject, prefixes: readonly string[]) =>
    order.get(error)! < order.get(union)! &&
    !independent.sites.has(errorSite(error.schemaPath, error.instancePath)) &&
    !ownershipUncertain(error) &&
    belongsToBranch(error, union, prefixes);
  for (const error of errors) {
    if (error.keyword !== "anyOf" && error.keyword !== "oneOf") continue;
    const site = errorSite(error.schemaPath, error.instancePath);
    const alternatives = independent.ambiguous.has(site)
      ? undefined
      : independent.schemas.has(site)
        ? independent.schemas.get(site)
        : schemaAt(input.schema, error.schemaPath);
    if (
      !Array.isArray(alternatives) ||
      alternatives.some((branch) => !isSchema(branch) && typeof branch !== "boolean")
    ) {
      unions.push({
        error,
        branchPrefixes: [],
        selected: undefined,
        unresolved: true,
        replacement: {
          path: displayPath(pointerSegments(error.instancePath)),
          keyword: error.keyword,
          message: `${describe(displayPath(pointerSegments(error.instancePath)))} must match ${error.keyword === "oneOf" ? "exactly one" : "one"} declared alternative input format`,
        },
      });
      continue;
    }
    const branches = alternatives as (JsonSchema | boolean)[];
    const branchPrefixes = branches.map((branch, index) =>
      isSchema(branch)
        ? schemaPrefixes(branch, `${error.schemaPath}/${index}`, input.schema)
        : [`${error.schemaPath}/${index}`],
    );
    const constraints = branches.map((branch) =>
      isSchema(branch) ? literalConstraints(branch, input.schema) : [],
    );
    const at = argumentAt(input.arguments, pointerSegments(error.instancePath));
    const compatible = constraints.flatMap((branch, index) =>
      branches[index] === false ||
      branch.some((constraint) => {
        const supplied = argumentAt(at.value, constraint.path);
        return supplied.present && !constraint.values.some((value) => value === supplied.value);
      })
        ? []
        : [index],
    );
    const selected =
      compatible.length === 1 && compatible.length < branches.length ? compatible[0] : undefined;
    let replacement: ToolGatewayInputIssue | undefined;
    if (selected === undefined) {
      const common = constraints[0]?.find((constraint) =>
        constraints.every((branch) =>
          branch.some((other) => samePath(other.path, constraint.path)),
        ),
      );
      const supplied = common && argumentAt(at.value, common.path);
      const commonConstraints =
        common &&
        constraints.map(
          (branch) => branch.find((constraint) => samePath(constraint.path, common.path))!,
        );
      const allowed = commonConstraints?.flatMap((constraint) => constraint.values);
      const uniqueAllowed = allowed && [...new Set(allowed)];
      if (
        common &&
        supplied &&
        commonConstraints &&
        uniqueAllowed?.length &&
        ((supplied.present && !uniqueAllowed.some((value) => value === supplied.value)) ||
          (!supplied.present && commonConstraints.every((constraint) => constraint.required)))
      ) {
        const path = displayPath([...pointerSegments(error.instancePath), ...common.path]);
        const allowedText = allowedValuesText(uniqueAllowed);
        const missing =
          !supplied.present && commonConstraints.every((constraint) => constraint.required);
        replacement = {
          path,
          keyword: missing ? "required" : error.keyword,
          message: missing
            ? `missing required property "${path}" (selects one of ${allowedText})`
            : `${describe(path)} must be one of ${allowedText}`,
        };
      }
    }

    unions.push({ error, branchPrefixes, selected, replacement });
  }
  const replacements = new Map<UnionDiagnostic, ToolGatewayInputIssue>();
  const errorsWithin = indexByPath(errors, (error) => error.instancePath, true);
  const unionsWithin = indexByPath(unions, (union) => union.error.instancePath, true);
  const scopeIndexes = new WeakMap<readonly UnionDiagnostic[], Map<string, UnionDiagnostic[]>>();
  const project = (
    error: ErrorObject,
    scope: readonly UnionDiagnostic[],
  ): ToolGatewayInputIssue[] => {
    let scopeIndex = scopeIndexes.get(scope);
    if (!scopeIndex) {
      scopeIndex = indexByPath(scope, (union) => union.error.instancePath, false);
      scopeIndexes.set(scope, scopeIndex);
    }
    const applicable = pathAncestors(error.instancePath).flatMap(
      (path) => scopeIndex.get(path) ?? [],
    );
    for (const union of applicable) {
      if (error === union.error) continue;
      if (
        union.unresolved &&
        order.get(error)! < order.get(union.error)! &&
        !independent.sites.has(errorSite(error.schemaPath, error.instancePath)) &&
        !ownershipUncertain(error) &&
        (error.instancePath === union.error.instancePath ||
          error.instancePath.startsWith(`${union.error.instancePath}/`))
      )
        return [];
      const matchingBranches = union.branchPrefixes.flatMap((prefixes, index) =>
        belongs(error, union.error, prefixes) ? [index] : [],
      );
      if (
        matchingBranches.length &&
        (union.selected === undefined || !matchingBranches.includes(union.selected))
      )
        return [];
    }
    const union = applicable.find((candidate) => candidate.error === error);
    if (!union) {
      const issue = issueFromError(error);
      return [
        ownershipUncertain(error)
          ? {
              ...issue,
              message: `an independent constraint or alternative reports: ${issue.message}`,
            }
          : issue,
      ];
    }
    if (union.selected !== undefined) return [];
    if (union.replacement) return [union.replacement];
    const cached = replacements.get(union);
    if (cached) return [cached];
    const alternatives = union.branchPrefixes
      .slice(0, ALLOWED_VALUES_MAX)
      .map((prefixes, index) => {
        const nested = (unionsWithin.get(union.error.instancePath) ?? []).filter(
          (candidate) =>
            order.get(candidate.error)! < order.get(union.error)! &&
            belongs(candidate.error, union.error, prefixes),
        );
        const details = (errorsWithin.get(union.error.instancePath) ?? [])
          .filter(
            (candidate) => candidate !== union.error && belongs(candidate, union.error, prefixes),
          )
          .flatMap((candidate) => project(candidate, nested))
          .map((issue) => issue.message);
        const distinct = [...new Set(details)];
        const shown = distinct.slice(0, 2);
        if (distinct.length > shown.length) shown.push("other declared requirements");
        return `alternative ${index + 1}${shown.length ? ` (${shown.join("; ")})` : ""}`;
      });
    if (union.branchPrefixes.length > ALLOWED_VALUES_MAX)
      alternatives.push("other declared alternatives");
    const issue = {
      path: displayPath(pointerSegments(error.instancePath)),
      keyword: error.keyword,
      message: bounded(
        `${describe(displayPath(pointerSegments(error.instancePath)))} must match ${
          error.keyword === "oneOf" ? "exactly one" : "one"
        } declared input format: ${alternatives.join(" or ")}`,
        640,
      ),
    };
    replacements.set(union, issue);
    return [issue];
  };
  return errors.flatMap((error) => project(error, unions));
}

/** Index instances once so many array-item unions never scan one another's errors. */
function indexByPath<T>(
  values: readonly T[],
  pathOf: (value: T) => string,
  includeDescendants: boolean,
): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const value of values) {
    const paths = includeDescendants ? pathAncestors(pathOf(value)) : [pathOf(value)];
    for (const path of paths) {
      const group = index.get(path);
      if (group) group.push(value);
      else index.set(path, [value]);
    }
  }
  return index;
}

function pathAncestors(path: string): string[] {
  const ancestors = [path];
  let parent = path;
  while (parent) {
    parent = parent.slice(0, parent.lastIndexOf("/"));
    ancestors.push(parent);
  }
  return ancestors;
}

function belongsToBranch(
  error: ErrorObject,
  union: ErrorObject,
  prefixes: readonly string[],
): boolean {
  return (
    (error.instancePath === union.instancePath ||
      error.instancePath.startsWith(`${union.instancePath}/`)) &&
    prefixes.some(
      (prefix) => error.schemaPath === prefix || error.schemaPath.startsWith(`${prefix}/`),
    )
  );
}

function isSchema(value: unknown): value is JsonSchema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const schemaReferenceIndexes = new WeakMap<JsonSchema, Map<string, JsonSchema>>();
const schemaReferenceBases = new WeakMap<JsonSchema, WeakMap<JsonSchema, string>>();
const schemaReferenceLocals = new WeakMap<JsonSchema, WeakMap<JsonSchema, string>>();

/** Resolve local pointers, anchors and identifiers declared inside this schema. */
function schemaAt(root: JsonSchema, pointer: string, context?: JsonSchema): unknown {
  let index = schemaReferenceIndexes.get(root);
  if (!index) {
    index = new Map([["#", root]]);
    const ambiguous = new Set<string>();
    const bases = new WeakMap<JsonSchema, string>();
    const locals = new WeakMap<JsonSchema, string>();
    const active = new Set<JsonSchema>();
    const register = (name: string, schema: JsonSchema) => {
      if (ambiguous.has(name)) return;
      const previous = index!.get(name);
      if (previous && previous !== schema) {
        index!.delete(name);
        ambiguous.add(name);
      } else index!.set(name, schema);
    };
    const visit = (schema: JsonSchema, path: string, inheritedId: string, localPath: string) => {
      if (active.has(schema)) return;
      active.add(schema);
      register(path, schema);
      let id = inheritedId;
      if (typeof schema.$id === "string") {
        id = schema.$id;
        try {
          if (inheritedId) id = new URL(id, inheritedId).href;
        } catch {
          /* Non-URL identifiers remain exact aliases. */
        }
        register(id, schema);
        register(`${id}#`, schema);
        localPath = "#";
      }
      bases.set(schema, id);
      locals.set(schema, localPath);
      if (typeof schema.$anchor === "string") {
        register(`#${schema.$anchor}`, schema);
        if (id) register(`${id}#${schema.$anchor}`, schema);
      }
      for (const [suffix, child] of schemaChildren(schema))
        visit(child, `${path}/${suffix}`, id, `${localPath}/${suffix}`);
      active.delete(schema);
    };
    visit(root, "#", "", "#");
    schemaReferenceIndexes.set(root, index);
    schemaReferenceBases.set(root, bases);
    schemaReferenceLocals.set(root, locals);
  }
  const base = context && schemaReferenceBases.get(root)?.get(context);
  if (base) {
    if (pointer.startsWith("#")) pointer = `${base}${pointer}`;
    else
      try {
        pointer = new URL(pointer, base).href;
      } catch {
        /* Exact aliases remain available. */
      }
  }
  const exact = index.get(pointer);
  if (exact) return exact;
  // AJV appends keyword paths to the reference it followed, including anchors.
  let separator = pointer.lastIndexOf("/");
  while (separator >= 0) {
    const target = index.get(pointer.slice(0, separator));
    if (target) {
      let value: unknown = target;
      for (const segment of pointerSegments(pointer.slice(separator))) {
        if (!value || typeof value !== "object") return undefined;
        value = (value as Record<string, unknown>)[segment];
      }
      return value;
    }
    separator = separator === 0 ? -1 : pointer.lastIndexOf("/", separator - 1);
  }
  return undefined;
}

function schemaChildren(schema: JsonSchema): [string, JsonSchema][] {
  const children: [string, JsonSchema][] = [];
  for (const keyword of [
    "$defs",
    "definitions",
    "properties",
    "patternProperties",
    "dependentSchemas",
    "dependencies",
  ]) {
    const values = schema[keyword];
    if (isSchema(values))
      for (const [name, child] of Object.entries(values))
        if (isSchema(child)) children.push([`${keyword}/${pointerSegment(name)}`, child]);
  }
  for (const keyword of ["anyOf", "oneOf", "allOf", "prefixItems", "items"]) {
    const values = schema[keyword];
    if (Array.isArray(values))
      values.forEach((child, index) => {
        if (isSchema(child)) children.push([`${keyword}/${index}`, child]);
      });
  }
  for (const keyword of [
    "items",
    "additionalItems",
    "additionalProperties",
    "unevaluatedProperties",
    "not",
    "if",
    "then",
    "else",
    "contains",
    "propertyNames",
  ]) {
    const child = schema[keyword];
    if (isSchema(child)) children.push([keyword, child]);
  }
  return children;
}

function pointerSegment(value: string): string {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function errorSite(schemaPath: string, instancePath: string): string {
  return JSON.stringify([schemaPath, instancePath]);
}

/**
 * Shared references erase their source location in AJV errors. Preserve failures
 * reached independently of alternatives, even when the same referenced schema
 * also occurs in a later branch. Only conjunctions, supplied properties/items,
 * and uniquely selected literal tags mark sites as independent. Other branches
 * are indexed for resource-scoped lookup without marking them independent.
 */
function unconditionalErrorSites(
  root: JsonSchema,
  args: Record<string, unknown>,
  errors: readonly ErrorObject[],
): {
  sites: Set<string>;
  schemas: Map<string, unknown>;
  ambiguous: Set<string>;
  uncertain: { prefix: string; instancePath: string }[];
} {
  const sites = new Set<string>();
  const schemaSites = new Map<string, unknown>();
  const uncertain: { prefix: string; instancePath: string }[] = [];
  const ambiguous = new Set<string>();
  const conditionalBranches = new Map(
    errors
      .filter((error) => error.keyword === "if")
      .map((error) => [
        errorSite(error.schemaPath, error.instancePath),
        error.params.failingKeyword,
      ]),
  );
  const active = new Set<string>();
  const schemas = new WeakMap<JsonSchema, number>();
  let schemaId = 0;
  const visit = (
    schema: JsonSchema,
    schemaPath: string,
    value: unknown,
    instancePath: string,
    independent: boolean,
  ) => {
    let id = schemas.get(schema);
    if (id === undefined) {
      id = schemaId++;
      schemas.set(schema, id);
    }
    const key = JSON.stringify([id, schemaPath, instancePath, independent]);
    if (active.has(key)) return;
    active.add(key);
    const base = schemaReferenceBases.get(root)?.get(schema);
    const local = base && schemaReferenceLocals.get(root)?.get(schema);
    const aliases = [...new Set([schemaPath, ...(local ? [local, `${base}${local}`] : [])])];
    for (const alias of aliases)
      for (const [keyword, child] of Object.entries(schema)) {
        const site = errorSite(`${alias}/${keyword}`, instancePath);
        if (independent) sites.add(site);
        if (ambiguous.has(site)) continue;
        if (schemaSites.has(site) && schemaSites.get(site) !== child) {
          schemaSites.delete(site);
          ambiguous.add(site);
        } else schemaSites.set(site, child);
      }
    if (typeof schema.$ref === "string") {
      const target = schemaAt(root, schema.$ref, schema);
      if (isSchema(target)) visit(target, schema.$ref, value, instancePath, independent);
    }
    if (Array.isArray(schema.allOf))
      schema.allOf.forEach((child, index) => {
        if (isSchema(child))
          visit(child, `${schemaPath}/allOf/${index}`, value, instancePath, independent);
      });
    for (const keyword of ["anyOf", "oneOf"]) {
      const alternatives = schema[keyword];
      if (!Array.isArray(alternatives)) continue;
      const compatible = alternatives.flatMap((branch, index) => {
        if (branch === false) return [];
        if (!isSchema(branch)) return [index];
        return literalConstraints(branch, root).some((constraint) => {
          const supplied = argumentAt(value, constraint.path);
          return supplied.present && !constraint.values.includes(supplied.value);
        })
          ? []
          : [index];
      });
      const selected =
        compatible.length === 1 && compatible.length < alternatives.length
          ? compatible[0]
          : undefined;
      alternatives.forEach((child, index) => {
        if (isSchema(child))
          visit(
            child,
            `${schemaPath}/${keyword}/${index}`,
            value,
            instancePath,
            independent && index === selected,
          );
      });
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (isSchema(schema.properties))
        for (const [name, child] of Object.entries(schema.properties)) {
          if (isSchema(child) && Object.hasOwn(value, name))
            visit(
              child,
              `${schemaPath}/properties/${pointerSegment(name)}`,
              (value as Record<string, unknown>)[name],
              `${instancePath}/${pointerSegment(name)}`,
              independent,
            );
        }
      if (isSchema(schema.dependentSchemas))
        for (const [name, child] of Object.entries(schema.dependentSchemas)) {
          if (isSchema(child) && Object.hasOwn(value, name))
            visit(
              child,
              `${schemaPath}/dependentSchemas/${pointerSegment(name)}`,
              value,
              instancePath,
              independent,
            );
        }
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const declared = isSchema(schema.properties) ? schema.properties : {};
      const patterns = isSchema(schema.patternProperties)
        ? Object.entries(schema.patternProperties).map(
            ([pattern, child]) => [pattern, new RegExp(pattern, "u"), child] as const,
          )
        : [];
      for (const [name, childValue] of Object.entries(value)) {
        let matched = false;
        for (const [pattern, regexp, child] of patterns) {
          if (regexp.test(name)) {
            matched = true;
            if (isSchema(child))
              visit(
                child,
                `${schemaPath}/patternProperties/${pointerSegment(pattern)}`,
                childValue,
                `${instancePath}/${pointerSegment(name)}`,
                independent,
              );
          }
        }
        if (!Object.hasOwn(declared, name) && !matched && isSchema(schema.additionalProperties))
          visit(
            schema.additionalProperties,
            `${schemaPath}/additionalProperties`,
            childValue,
            `${instancePath}/${pointerSegment(name)}`,
            independent,
          );
      }
      if (isSchema(schema.dependencies))
        for (const [name, child] of Object.entries(schema.dependencies)) {
          if (isSchema(child) && Object.hasOwn(value, name))
            visit(
              child,
              `${schemaPath}/dependencies/${pointerSegment(name)}`,
              value,
              instancePath,
              independent,
            );
        }
    }
    if (Array.isArray(value)) {
      const tuple = Array.isArray(schema.prefixItems)
        ? schema.prefixItems
        : Array.isArray(schema.items)
          ? schema.items
          : [];
      const tupleKeyword = Array.isArray(schema.prefixItems) ? "prefixItems" : "items";
      value.forEach((item, index) => {
        const child =
          tuple[index] ?? (isSchema(schema.items) ? schema.items : schema.additionalItems);
        if (isSchema(child))
          visit(
            child,
            tuple[index]
              ? `${schemaPath}/${tupleKeyword}/${index}`
              : `${schemaPath}/${isSchema(schema.items) ? "items" : "additionalItems"}`,
            item,
            `${instancePath}/${index}`,
            independent,
          );
      });
    }
    // These applicators have existential or annotation semantics. A reused
    // reference cannot prove branch ownership here, so retain its failures as
    // explicitly ambiguous constraint evidence rather than suppressing them.
    for (const keyword of [
      "contains",
      "propertyNames",
      "unevaluatedProperties",
      "unevaluatedItems",
    ]) {
      const child = schema[keyword];
      if (isSchema(child))
        for (const prefix of schemaPrefixes(child, `${schemaPath}/${keyword}`, root).slice(1))
          uncertain.push({ prefix, instancePath });
    }
    // Failed conditionals name the branch AJV actually evaluated.
    const branch = conditionalBranches.get(errorSite(`${schemaPath}/if`, instancePath));
    if ((branch === "then" || branch === "else") && isSchema(schema[branch]))
      visit(schema[branch], `${schemaPath}/${branch}`, value, instancePath, independent);
    active.delete(key);
  };
  schemaAt(root, "#"); // Initialize resource scopes before recording any sites.
  visit(root, "#", args, "", true);
  return { sites, schemas: schemaSites, ambiguous, uncertain };
}

function schemaPrefixes(schema: JsonSchema, pointer: string, root: JsonSchema): string[] {
  const prefixes = [pointer];
  const seen = new Set<JsonSchema>();
  const visit = (value: JsonSchema) => {
    if (seen.has(value)) return;
    seen.add(value);
    if (typeof value.$ref === "string") {
      const target = schemaAt(root, value.$ref, value);
      if (isSchema(target)) {
        prefixes.push(value.$ref);
        visit(target);
      }
    }
    // References below a branch have schema paths outside its path prefix.
    for (const keyword of ["properties", "patternProperties", "dependentSchemas"]) {
      const children = value[keyword];
      if (isSchema(children))
        for (const child of Object.values(children)) if (isSchema(child)) visit(child);
    }
    for (const keyword of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
      const children = value[keyword];
      if (Array.isArray(children)) for (const child of children) if (isSchema(child)) visit(child);
    }
    for (const keyword of [
      "items",
      "additionalItems",
      "additionalProperties",
      "unevaluatedProperties",
      "not",
      "if",
      "then",
      "else",
      "contains",
      "propertyNames",
    ]) {
      const child = value[keyword];
      if (isSchema(child)) visit(child);
      else if (keyword === "items" && Array.isArray(child))
        for (const entry of child) if (isSchema(entry)) visit(entry);
    }
  };
  visit(schema);
  return prefixes;
}

function literalConstraints(schema: JsonSchema, root: JsonSchema): LiteralConstraint[] {
  const constraints: LiteralConstraint[] = [];
  const active = new Set<JsonSchema>();
  const visit = (value: JsonSchema, path: readonly string[], required: boolean) => {
    if (active.has(value)) return;
    active.add(value);
    if (typeof value.$ref === "string") {
      const target = schemaAt(root, value.$ref, value);
      if (isSchema(target)) {
        visit(target, path, required);
      }
    }
    const literals = "const" in value ? [value.const] : Array.isArray(value.enum) ? value.enum : [];
    if (
      literals.length &&
      literals.every(
        (literal) => literal === null || ["string", "number", "boolean"].includes(typeof literal),
      )
    ) {
      constraints.push({ path, values: literals, required });
    }
    if (Array.isArray(value.allOf))
      for (const child of value.allOf) if (isSchema(child)) visit(child, path, required);
    if (isSchema(value.properties))
      for (const [key, child] of Object.entries(value.properties)) {
        if (isSchema(child))
          visit(
            child,
            [...path, key],
            required && Array.isArray(value.required) && value.required.includes(key),
          );
      }
    active.delete(value);
  };
  visit(schema, [], true);
  // Multiple conjunctions may constrain the same tag; all must hold.
  const combined: LiteralConstraint[] = [];
  for (const constraint of constraints) {
    const index = combined.findIndex((other) => samePath(other.path, constraint.path));
    if (index < 0) combined.push(constraint);
    else {
      const previous = combined[index]!;
      combined[index] = {
        path: constraint.path,
        values: previous.values.filter((value) => constraint.values.includes(value)),
        required: previous.required || constraint.required,
      };
    }
  }
  return combined;
}

function argumentAt(root: unknown, path: readonly string[]): { present: boolean; value: unknown } {
  let value = root;
  for (const segment of path) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, segment))
      return { present: false, value: undefined };
    value = (value as Record<string, unknown>)[segment];
  }
  return { present: true, value };
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

/** One-line summary of issues, for example `missing required property "context"`. */
export function formatToolGatewayInputIssues(
  issues: readonly ToolGatewayInputIssue[],
  omittedIssueCount = 0,
): string {
  const parts = issues.map((issue) => issue.message);
  if (omittedIssueCount > 0) {
    parts.push(`and ${omittedIssueCount} more ${omittedIssueCount === 1 ? "problem" : "problems"}`);
  }
  return parts.join("; ");
}

function issueFromError(error: ErrorObject): ToolGatewayInputIssue {
  const params = (error.params ?? {}) as Record<string, unknown>;
  const at = pointerSegments(error.instancePath);
  const subject = describe(displayPath(at));
  // A `propertyNames` subschema failure describes a key of the object at
  // `instancePath`, not the object itself; name the object, never the key.
  const keyword =
    (error as { propertyName?: unknown }).propertyName !== undefined
      ? "propertyNames"
      : error.keyword;
  switch (keyword) {
    case "required": {
      const path = displayPath([...at, String(params.missingProperty)]);
      return { path, keyword: error.keyword, message: `missing required property "${path}"` };
    }
    case "dependentRequired":
    case "dependencies": {
      const path = displayPath([...at, String(params.missingProperty)]);
      const trigger = displayPath([...at, String(params.property)]);
      return {
        path,
        keyword: error.keyword,
        message: `missing required property "${path}" (required when "${trigger}" is present)`,
      };
    }
    case "additionalProperties":
    case "unevaluatedProperties": {
      const name = params.additionalProperty ?? params.unevaluatedProperty;
      const path = displayPath([...at, String(name)]);
      return { path, keyword: error.keyword, message: `property "${path}" is not allowed` };
    }
    case "type": {
      const expected = Array.isArray(params.type) ? params.type.join(" or ") : String(params.type);
      return {
        path: displayPath(at),
        keyword: error.keyword,
        message: `${subject} must be ${bounded(expected, MESSAGE_DETAIL_MAX_CHARS)}`,
      };
    }
    case "enum": {
      const allowed = Array.isArray(params.allowedValues)
        ? allowedValuesText(params.allowedValues)
        : null;
      return {
        path: displayPath(at),
        keyword: error.keyword,
        message: allowed
          ? `${subject} must be one of ${allowed}`
          : `${subject} must be one of the allowed values`,
      };
    }
    case "const":
      return {
        path: displayPath(at),
        keyword: error.keyword,
        message: `${subject} must equal ${schemaValueText(params.allowedValue)}`,
      };
    case "propertyNames":
      return {
        path: displayPath(at),
        keyword,
        message: `${subject} has a property name the schema does not allow`,
      };
    default:
      return {
        path: displayPath(at),
        keyword: bounded(error.keyword, 64),
        message: `${subject} ${bounded(cleanText(error.message ?? "is invalid"), MESSAGE_DETAIL_MAX_CHARS)}`,
      };
  }
}

function describe(path: string): string {
  return path ? `"${path}"` : "arguments";
}

function pointerSegments(pointer: string): string[] {
  if (!pointer) return [];
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

/**
 * Render JSON Pointer segments as `a.b[0].c`. A top-level name is shown as is;
 * an unusual nested name is bracket-quoted so the path stays unambiguous.
 */
function displayPath(segments: readonly string[]): string {
  let path = "";
  for (const segment of segments) {
    if (/^(?:0|[1-9][0-9]*)$/u.test(segment)) path += `[${segment}]`;
    else if (!path) path = cleanText(segment);
    else if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/u.test(segment)) path += `.${segment}`;
    else path += `[${JSON.stringify(segment)}]`;
    if (path.length > PATH_MAX_CHARS) break;
  }
  return bounded(path, PATH_MAX_CHARS);
}

function allowedValuesText(values: readonly unknown[]): string | null {
  if (values.length === 0) return null;
  const shown = values.slice(0, ALLOWED_VALUES_MAX).map(schemaValueText);
  if (values.length > ALLOWED_VALUES_MAX) shown.push("...");
  return shown.join(", ");
}

function schemaValueText(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = "the schema constant";
  }
  return bounded(cleanText(text), ALLOWED_VALUE_MAX_CHARS);
}

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}
