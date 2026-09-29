/**
 * Public API surface inventory and compatibility diff.
 *
 * `docs/design/api-compatibility-policy.md` defines OpenGeni's public surface:
 * the `/v1` routes reachable through public `@opengeni/sdk` methods, the
 * documented session event envelope and event types, the exported names of
 * `@opengeni/sdk` and `@opengeni/react`, and the automation webhook ingress.
 * This module derives that surface from source so it can be committed as a
 * snapshot (`scripts/public-api/surface.gen.json`) and diffed:
 *
 * - Routes: every HTTP call site in `packages/sdk/src` (a `/v1/...` path literal
 *   plus the HTTP verb used by the same SDK method) is matched against the routes
 *   the API app actually registers (`createApp(...).app.routes`). Only matched,
 *   registered routes are public; unmatched SDK paths are reported separately.
 * - Schemas: request/response type names in each SDK method signature are the
 *   hand-written mirrors of `@opengeni/contracts` zod schemas (pinned by
 *   `packages/sdk/test/contract-parity.test.ts`). Each is converted to JSON Schema
 *   (`io: "input"` for requests, `"output"` for responses) and flattened into a
 *   path -> descriptor map, which makes additive vs breaking changes decidable.
 * - Exports: every package.json `exports` entry of the SDK and React package is
 *   parsed and its exported names (value or type-only) collected transitively.
 *
 * A method whose JSDoc carries `@internal` is excluded (web-app-only surface).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseSync } from "oxc-parser";

export const SNAPSHOT_PATH = "scripts/public-api/surface.gen.json";
export const ALLOWLIST_PATH = "scripts/public-api/breaking-changes.json";

const HTTP_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * Public ingress formats that no SDK method calls (third parties post to them).
 * Provider callbacks whose format the provider owns (Stripe, GitHub, Slack) are
 * not OpenGeni's surface and stay out.
 */
export const PUBLIC_INGRESS_ROUTES: readonly string[] = [
  "POST /v1/webhooks/automations/:endpointId",
];

/** Documented event contracts, by `@opengeni/contracts` export name. */
export const PUBLIC_EVENT_SCHEMAS: readonly string[] = ["SessionEvent"];
export const PUBLIC_EVENT_ENUMS: readonly string[] = ["SessionEventType"];

export type SchemaIo = "input" | "output";

/** One flattened JSON-schema node. `req` is only meaningful below an object. */
export type ShapeNode = {
  t: string;
  req?: boolean;
  nullable?: boolean;
  enum?: string[];
};
export type Shape = Record<string, ShapeNode>;

export type RouteEntry = {
  method: string;
  path: string;
  sdk: string[];
  request: string[];
  response: string[];
};

export type ExportKind = "value" | "type";

export type Snapshot = {
  schemaVersion: 1;
  generatedBy: string;
  sdkMajor: number;
  routes: RouteEntry[];
  ingress: string[];
  unmatchedSdkCalls: string[];
  events: Record<string, string[]>;
  schemas: Record<string, { io: SchemaIo[]; shape: Record<string, string> }>;
  exports: Record<string, Record<string, ExportKind>>;
  sdkMembers: Record<string, string[]>;
};

// ---------------------------------------------------------------------------
// AST helpers (oxc ESTree + TS nodes)
// ---------------------------------------------------------------------------

type Node = { type: string; start: number; end: number; [key: string]: unknown };

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function children(node: Node): Node[] {
  const out: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) out.push(item);
    } else if (isNode(value)) {
      out.push(value);
    }
  }
  return out;
}

function walk(node: Node, visit: (node: Node) => boolean | void): void {
  if (visit(node) === false) return;
  for (const child of children(node)) walk(child, visit);
}

function parse(path: string): { program: Node; comments: { value: string; end: number }[] } {
  const source = readFileSync(path, "utf8");
  const result = parseSync(path, source, {
    lang: path.endsWith(".tsx") ? "tsx" : "ts",
    sourceType: "module",
  });
  if (result.errors.length > 0) {
    throw new Error(`${path}: ${result.errors[0]!.message}`);
  }
  return {
    program: result.program as unknown as Node,
    comments: result.comments as unknown as { value: string; end: number }[],
  };
}

function literalString(node: Node, bindings?: ReadonlyMap<string, string>): string | null {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "StringLiteral" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral") {
    const quasis = node.quasis as Node[];
    const expressions = node.expressions as Node[];
    // `${root(workspaceId)}/catalog` where `root` is a local `/v1/...` helper.
    const firstQuasi = quasis[0]?.value as { cooked?: string; raw: string } | undefined;
    const lead = expressions[0];
    if (bindings && lead && (firstQuasi?.cooked ?? firstQuasi?.raw) === "") {
      const leadName =
        lead.type === "Identifier"
          ? String(lead.name)
          : lead.type === "CallExpression" && (lead.callee as Node).type === "Identifier"
            ? String((lead.callee as Node).name)
            : null;
      const prefix = leadName ? bindings.get(leadName) : undefined;
      if (prefix !== undefined) {
        const rest = quasis
          .slice(1)
          .map((quasi, index) => {
            const value = quasi.value as { cooked?: string; raw: string };
            return (value.cooked ?? value.raw) + (index < quasis.length - 2 ? "\0" : "");
          })
          .join("");
        return prefix + rest;
      }
    }
    return quasis
      .map((quasi, index) => {
        const cooked = (quasi.value as { cooked?: string; raw: string }).cooked;
        return (
          (cooked ?? (quasi.value as { raw: string }).raw) + (index < quasis.length - 1 ? "\0" : "")
        );
      })
      .join("");
  }
  return null;
}

/** `/v1/workspaces/\0/sessions?x` -> `/v1/workspaces/:p/sessions` (null if dynamic root). */
export function normalizeSdkPath(raw: string): string | null {
  if (!raw.startsWith("/v1/")) return null;
  const withoutQuery = raw.split("?")[0]!.split("#")[0]!;
  const segments = withoutQuery.split("/").slice(1);
  if (segments.length < 2) return null;
  const normalized = segments.map((segment) =>
    segment.includes("\0") ? segment.replace(/\0/g, ":p") : segment,
  );
  // `${base}${query}`: a placeholder glued to the end of the last literal
  // segment is a query-string suffix, not part of the route.
  const last = normalized.length - 1;
  if (/^[^:]+:p$/.test(normalized[last]!)) normalized[last] = normalized[last]!.slice(0, -2);
  // `/v1/${dynamic}` is an asset or passthrough URL, not a route call.
  if (normalized[1]!.includes(":p")) return null;
  const path = `/${normalized.join("/")}`.replace(/\/+$/, "");
  return path;
}

function typeNamesIn(node: Node | undefined | null, names: Set<string>): void {
  if (!node) return;
  walk(node, (child) => {
    if (child.type === "TSTypeReference") {
      const typeName = child.typeName as Node;
      if (typeName.type === "Identifier") names.add(String(typeName.name));
      else if (typeName.type === "TSQualifiedName") {
        const right = typeName.right as Node;
        names.add(String(right.name));
      }
    }
    if (child.type === "TSImportType") {
      const qualifier = child.qualifier as Node | null;
      if (qualifier?.type === "Identifier") names.add(String(qualifier.name));
    }
  });
}

type SdkMethod = {
  name: string;
  internal: boolean;
  paths: Set<string>;
  verbs: Set<string>;
  requestTypes: Set<string>;
  responseTypes: Set<string>;
};

function jsdocBefore(
  comments: { value: string; end: number }[],
  start: number,
  source: string,
): string {
  let best: { value: string; end: number } | null = null;
  for (const comment of comments) {
    if (comment.end <= start && (!best || comment.end > best.end)) best = comment;
  }
  if (!best) return "";
  const between = source.slice(best.end, start);
  // Only whitespace, decorators, or modifiers may sit between a doc block and its member.
  return /^[\s]*(?:(?:export|async|static|public|readonly|declare|override)\s+)*$/.test(between)
    ? best.value
    : "";
}

function collectFunctionInfo(fn: Node, method: SdkMethod): void {
  for (const param of (fn.params as Node[] | undefined) ?? []) {
    const annotation =
      (param.typeAnnotation as Node | undefined) ??
      ((param.left as Node | undefined)?.typeAnnotation as Node | undefined);
    typeNamesIn(annotation, method.requestTypes);
  }
  const returnNames = new Set<string>();
  typeNamesIn(fn.returnType as Node | undefined, returnNames);
  for (const name of returnNames) if (name !== "Promise") method.responseTypes.add(name);
  const body = fn.body as Node | undefined;
  if (!body) return;
  const bindings = new Map<string, string>();
  walk(body, (child) => {
    if (child.type !== "VariableDeclarator" || (child.id as Node).type !== "Identifier") return;
    let init = child.init as Node | null;
    if (init?.type === "ArrowFunctionExpression" && (init.body as Node).type !== "BlockStatement") {
      init = init.body as Node;
    }
    const text = init ? literalString(init) : null;
    if (text?.startsWith("/v1/")) bindings.set(String((child.id as Node).name), text);
  });
  walk(body, (child) => {
    const text = literalString(child, bindings);
    if (text !== null) {
      if (HTTP_VERBS.has(text)) method.verbs.add(text);
      const path = normalizeSdkPath(text.startsWith("/v1/") ? text : "");
      if (path) method.paths.add(path);
      if (child.type === "TemplateLiteral") return false;
    }
    if (child.type === "CallExpression") {
      const typeArguments = (child.typeArguments ?? child.typeParameters) as Node | undefined;
      if (typeArguments) {
        const names = new Set<string>();
        typeNamesIn(typeArguments, names);
        for (const name of names) method.responseTypes.add(name);
      }
    }
  });
}

export function extractSdkMethods(files: readonly string[]): SdkMethod[] {
  const methods: SdkMethod[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const { program, comments } = parse(file);
    const add = (name: string, fn: Node, docStart: number) => {
      const method: SdkMethod = {
        name,
        internal: /@internal\b/.test(jsdocBefore(comments, docStart, source)),
        paths: new Set(),
        verbs: new Set(),
        requestTypes: new Set(),
        responseTypes: new Set(),
      };
      collectFunctionInfo(fn, method);
      if (method.paths.size > 0) methods.push(method);
    };
    walk(program, (node) => {
      if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
        const className = String((node.id as Node | null)?.name ?? "anonymous");
        for (const member of ((node.body as Node).body as Node[]) ?? []) {
          const key = member.key as Node | undefined;
          const memberName = key?.type === "Identifier" ? String(key.name) : null;
          if (
            !memberName ||
            member.accessibility === "private" ||
            key?.type === "PrivateIdentifier"
          )
            continue;
          if (member.type === "MethodDefinition") {
            add(`${className}.${memberName}`, member.value as Node, member.start);
          } else if (member.type === "PropertyDefinition" && isNode(member.value)) {
            const value = member.value as Node;
            if (value.type === "ArrowFunctionExpression" || value.type === "FunctionExpression") {
              add(`${className}.${memberName}`, value, member.start);
            }
          }
        }
        return false;
      }
      if (node.type === "FunctionDeclaration" && node.id) {
        add(String((node.id as Node).name), node, node.start);
        return false;
      }
      if (node.type === "VariableDeclarator" && isNode(node.init)) {
        const init = node.init as Node;
        if (
          (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") &&
          (node.id as Node).type === "Identifier"
        ) {
          add(String((node.id as Node).name), init, node.start);
          return false;
        }
      }
      return undefined;
    });
  }
  return methods;
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

type RegisteredRoute = { method: string; path: string };

function routeSegmentIsParam(segment: string): boolean {
  return segment.startsWith(":") || segment === "*";
}

/** 2 = SDK dynamic on route param, 1 = SDK dynamic on route literal, 0 = no match. */
function matchQuality(sdkPath: string, routePath: string): 0 | 1 | 2 {
  const sdk = sdkPath.split("/");
  const route = routePath.split("/");
  if (route.at(-1) === "*") {
    if (sdk.length < route.length - 1) return 0;
  } else if (sdk.length !== route.length) {
    return 0;
  }
  let quality: 1 | 2 = 2;
  for (let index = 0; index < route.length; index += 1) {
    const r = route[index]!;
    const s = sdk[index];
    if (r === "*") return quality;
    if (s === undefined) return 0;
    if (routeSegmentIsParam(r)) continue;
    if (s === r) continue;
    if (s.includes(":p")) {
      const pattern = new RegExp(
        `^${s
          .split(":p")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]+")}$`,
      );
      if (!pattern.test(r)) return 0;
      quality = 1;
      continue;
    }
    return 0;
  }
  return quality;
}

export function matchRoutes(
  sdkPath: string,
  verb: string,
  registered: readonly RegisteredRoute[],
): RegisteredRoute[] {
  const candidates = registered
    .filter((route) => route.method === verb)
    .map((route) => ({ route, quality: matchQuality(sdkPath, route.path) }))
    .filter((entry) => entry.quality > 0);
  const best = Math.max(0, ...candidates.map((entry) => entry.quality));
  return candidates.filter((entry) => entry.quality === best).map((entry) => entry.route);
}

// ---------------------------------------------------------------------------
// JSON schema flattening
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

const MAX_DEPTH = 12;

function resolveRef(schema: JsonSchema, root: JsonSchema): JsonSchema {
  const ref = schema.$ref;
  if (typeof ref !== "string") return schema;
  if (ref === "#") return root;
  const parts = ref.replace(/^#\//, "").split("/");
  let current: unknown = root;
  for (const part of parts) current = (current as Record<string, unknown>)?.[part];
  return (current as JsonSchema) ?? {};
}

function scalarType(schema: JsonSchema): string {
  if ("const" in schema) return "const";
  if (Array.isArray(schema.enum)) return "enum";
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) return [...(schema.type as string[])].sort().join("|");
  if (schema.properties || schema.additionalProperties) return "object";
  return "unknown";
}

function unionBranches(schema: JsonSchema): JsonSchema[] | null {
  const branches = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  return Array.isArray(branches) ? branches : null;
}

function discriminatorLabel(branch: JsonSchema, root: JsonSchema): string | null {
  const resolved = resolveRef(branch, root);
  const properties = resolved.properties as Record<string, JsonSchema> | undefined;
  if (!properties) return null;
  for (const key of ["type", "kind", "status", "mode", "backend", "source", "state"]) {
    const property = properties[key] ? resolveRef(properties[key]!, root) : undefined;
    if (!property) continue;
    if ("const" in property) return `${key}=${String(property.const)}`;
    if (Array.isArray(property.enum) && property.enum.length === 1)
      return `${key}=${String(property.enum[0])}`;
  }
  for (const [key, raw] of Object.entries(properties)) {
    const property = resolveRef(raw, root);
    if ("const" in property) return `${key}=${String(property.const)}`;
  }
  return null;
}

function enumValues(schema: JsonSchema): string[] | undefined {
  if ("const" in schema) return [JSON.stringify(schema.const)];
  if (Array.isArray(schema.enum))
    return (schema.enum as unknown[]).map((v) => JSON.stringify(v)).sort();
  return undefined;
}

/**
 * Flatten a JSON schema into `path -> node`. `nameFor` lets a nested subschema
 * that is itself a named, fingerprinted contract collapse to `ref(Name)`, so a
 * change to `Session` is reported once under `Session` instead of under every
 * response that embeds it.
 */
export function flattenJsonSchema(
  root: JsonSchema,
  nameFor: (schema: JsonSchema) => string | null = () => null,
): Shape {
  const shape: Shape = {};
  const visit = (
    raw: JsonSchema,
    path: string,
    required: boolean | undefined,
    depth: number,
    refs: ReadonlySet<string>,
  ): void => {
    const ref = typeof raw.$ref === "string" ? raw.$ref : null;
    if (ref && refs.has(ref)) {
      shape[path] = {
        t: `ref(${ref.split("/").at(-1)})`,
        ...(required !== undefined ? { req: required } : {}),
      };
      return;
    }
    const nextRefs = ref ? new Set([...refs, ref]) : refs;
    let schema = resolveRef(raw, root);
    let nullable = false;
    if (depth > 0) {
      const alternatives = unionBranches(schema);
      const nonNull = alternatives?.filter((branch) => resolveRef(branch, root).type !== "null");
      const candidate = nonNull && nonNull.length === 1 ? resolveRef(nonNull[0]!, root) : schema;
      const name = nameFor(candidate);
      if (name) {
        shape[path] = {
          t: `ref(${name})`,
          ...(required !== undefined ? { req: required } : {}),
          ...(nonNull && nonNull.length !== alternatives!.length ? { nullable: true } : {}),
        };
        return;
      }
    }
    const branches = unionBranches(schema);
    if (branches) {
      const nonNull = branches.filter((branch) => resolveRef(branch, root).type !== "null");
      nullable = nonNull.length !== branches.length;
      if (nonNull.length === 1) {
        schema = resolveRef(nonNull[0]!, root);
      } else {
        const labels = nonNull.map(
          (branch, index) => discriminatorLabel(branch, root) ?? `${index}`,
        );
        shape[path] = {
          t: "union",
          ...(required !== undefined ? { req: required } : {}),
          ...(nullable ? { nullable } : {}),
          enum: [...labels].sort(),
        };
        if (depth >= MAX_DEPTH) return;
        nonNull.forEach((branch, index) => {
          visit(branch, `${path}|${labels[index]}`, undefined, depth + 1, nextRefs);
        });
        return;
      }
    }
    if (Array.isArray(schema.type) && (schema.type as string[]).includes("null")) {
      nullable = true;
      const rest = (schema.type as string[]).filter((type) => type !== "null");
      schema = { ...schema, type: rest.length === 1 ? rest[0] : rest };
    }
    const values = enumValues(schema);
    if (values?.includes("null")) {
      nullable = true;
      values.splice(values.indexOf("null"), 1);
    }
    const t = scalarType(schema);
    shape[path] = {
      t,
      ...(required !== undefined ? { req: required } : {}),
      ...(nullable ? { nullable } : {}),
      ...(values ? { enum: values } : {}),
    };
    if (depth >= MAX_DEPTH) return;
    if (t === "object") {
      const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
      const requiredSet = new Set((schema.required as string[] | undefined) ?? []);
      for (const key of Object.keys(properties).sort()) {
        visit(properties[key]!, `${path}.${key}`, requiredSet.has(key), depth + 1, nextRefs);
      }
      const additional = schema.additionalProperties;
      if (additional && typeof additional === "object") {
        visit(additional as JsonSchema, `${path}{}`, undefined, depth + 1, nextRefs);
      }
    } else if (t === "array" && schema.items && typeof schema.items === "object") {
      visit(schema.items as JsonSchema, `${path}[]`, undefined, depth + 1, nextRefs);
    }
  };
  visit(root, "$", undefined, 0, new Set());
  return shape;
}

/** Compact, line-diffable node encoding: `type[!|?][ null][=["enum",...]]`. */
export function encodeNode(node: ShapeNode): string {
  return `${node.t}${node.req === true ? "!" : node.req === false ? "?" : ""}${node.nullable ? " null" : ""}${
    node.enum ? `=${JSON.stringify(node.enum)}` : ""
  }`;
}

export function decodeNode(text: string): ShapeNode {
  const match = /^([^!? =]+)([!?])?( null)?(?:=(.*))?$/.exec(text);
  if (!match) throw new Error(`malformed shape node: ${text}`);
  return {
    t: match[1]!,
    ...(match[2] ? { req: match[2] === "!" } : {}),
    ...(match[3] ? { nullable: true } : {}),
    ...(match[4] ? { enum: JSON.parse(match[4]) as string[] } : {}),
  };
}

export function encodeShape(shape: Shape): Record<string, string> {
  return Object.fromEntries(Object.entries(shape).map(([path, node]) => [path, encodeNode(node)]));
}

export function decodeShape(shape: Record<string, string>): Shape {
  return Object.fromEntries(Object.entries(shape).map(([path, text]) => [path, decodeNode(text)]));
}

// ---------------------------------------------------------------------------
// Export surface
// ---------------------------------------------------------------------------

function resolveModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.d.ts`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  const withoutJs = base.replace(/\.js$/, "");
  for (const candidate of [`${withoutJs}.ts`, `${withoutJs}.tsx`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

type ModuleExports = Map<string, ExportKind>;

function mergeKind(map: ModuleExports, name: string, kind: ExportKind): void {
  if (map.get(name) === "value") return;
  map.set(name, kind);
}

export function moduleExports(
  file: string,
  cache = new Map<string, ModuleExports>(),
): ModuleExports {
  const cached = cache.get(file);
  if (cached) return cached;
  const exports: ModuleExports = new Map();
  cache.set(file, exports);
  const { program } = parse(file);
  const localKinds = new Map<string, ExportKind>();
  const importOrigins = new Map<
    string,
    { file: string | null; imported: string; typeOnly: boolean }
  >();
  for (const statement of program.body as Node[]) {
    if (statement.type === "ImportDeclaration") {
      const source = String((statement.source as Node).value);
      const resolved = resolveModule(file, source);
      const typeOnly = statement.importKind === "type";
      for (const specifier of (statement.specifiers as Node[]) ?? []) {
        const local = String((specifier.local as Node).name);
        const imported =
          specifier.type === "ImportSpecifier"
            ? String(
                ((specifier.imported as Node).name ?? (specifier.imported as Node).value) as string,
              )
            : specifier.type === "ImportDefaultSpecifier"
              ? "default"
              : "*";
        importOrigins.set(local, {
          file: resolved,
          imported,
          typeOnly: typeOnly || specifier.importKind === "type",
        });
      }
    }
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? (statement.declaration as Node | null)
        : statement;
    if (!declaration) continue;
    for (const [name, kind] of declaredNames(declaration)) mergeKind(localKinds, name, kind);
  }
  const kindOfLocal = (name: string): ExportKind => {
    const local = localKinds.get(name);
    if (local) return local;
    const origin = importOrigins.get(name);
    if (!origin) return "value";
    if (origin.typeOnly) return "type";
    if (origin.file && origin.imported !== "*") {
      return moduleExports(origin.file, cache).get(origin.imported) ?? "value";
    }
    return "value";
  };
  for (const statement of program.body as Node[]) {
    if (statement.type === "ExportNamedDeclaration") {
      const declaration = statement.declaration as Node | null;
      const typeOnly = statement.exportKind === "type";
      if (declaration) {
        for (const [name, kind] of declaredNames(declaration)) mergeKind(exports, name, kind);
        continue;
      }
      const sourceNode = statement.source as Node | null;
      const sourceFile = sourceNode ? resolveModule(file, String(sourceNode.value)) : null;
      const sourceExports = sourceFile ? moduleExports(sourceFile, cache) : null;
      for (const specifier of (statement.specifiers as Node[]) ?? []) {
        const localNode = specifier.local as Node;
        const exportedNode = specifier.exported as Node;
        const local = String(localNode.name ?? localNode.value);
        const exported = String(exportedNode.name ?? exportedNode.value);
        let kind: ExportKind;
        if (typeOnly || specifier.exportKind === "type") kind = "type";
        else if (sourceNode) kind = sourceExports?.get(local) ?? "value";
        else kind = kindOfLocal(local);
        mergeKind(exports, exported, kind);
      }
    } else if (statement.type === "ExportAllDeclaration") {
      const specifier = String((statement.source as Node).value);
      const exported = statement.exported as Node | null;
      if (exported) {
        mergeKind(
          exports,
          String(exported.name ?? exported.value),
          statement.exportKind === "type" ? "type" : "value",
        );
        continue;
      }
      const sourceFile = resolveModule(file, specifier);
      if (!sourceFile) {
        mergeKind(exports, `* from ${specifier}`, "value");
        continue;
      }
      for (const [name, kind] of moduleExports(sourceFile, cache)) {
        if (name === "default") continue;
        mergeKind(exports, name, statement.exportKind === "type" ? "type" : kind);
      }
    } else if (statement.type === "ExportDefaultDeclaration") {
      mergeKind(exports, "default", "value");
    }
  }
  return exports;
}

function declaredNames(declaration: Node): [string, ExportKind][] {
  switch (declaration.type) {
    case "TSTypeAliasDeclaration":
    case "TSInterfaceDeclaration":
      return [[String((declaration.id as Node).name), "type"]];
    case "FunctionDeclaration":
    case "ClassDeclaration":
    case "TSEnumDeclaration":
    case "TSDeclareFunction":
      return declaration.id ? [[String((declaration.id as Node).name), "value"]] : [];
    case "TSModuleDeclaration": {
      const id = declaration.id as Node;
      return id.type === "Identifier" ? [[String(id.name), "value"]] : [];
    }
    case "VariableDeclaration": {
      const names: [string, ExportKind][] = [];
      for (const declarator of declaration.declarations as Node[]) {
        walk(declarator.id as Node, (node) => {
          if (node.type === "Identifier") names.push([String(node.name), "value"]);
          if (node.type === "TSTypeAnnotation") return false;
          return undefined;
        });
      }
      return names;
    }
    default:
      return [];
  }
}

function packageEntryExports(
  packageDir: string,
  packageName: string,
): Record<string, Record<string, ExportKind>> {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    exports: Record<string, string | { types?: string; default?: string; import?: string }>;
  };
  const cache = new Map<string, ModuleExports>();
  const out: Record<string, Record<string, ExportKind>> = {};
  for (const [subpath, target] of Object.entries(manifest.exports).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const file =
      typeof target === "string" ? target : (target.types ?? target.default ?? target.import);
    const entryName =
      subpath === "." ? packageName : `${packageName}/${subpath.replace(/^\.\//, "")}`;
    if (!file || !/\.(ts|tsx)$/.test(file)) {
      // CSS and other asset entry points: the entry itself is the surface.
      out[entryName] = {};
      continue;
    }
    const exports = moduleExports(resolve(packageDir, file), cache);
    out[entryName] = Object.fromEntries(
      [...exports.entries()].sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  return out;
}

function sdkClassMembers(files: readonly string[]): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const { program, comments } = parse(file);
    for (const statement of program.body as Node[]) {
      const declaration =
        statement.type === "ExportNamedDeclaration" ? (statement.declaration as Node | null) : null;
      if (!declaration || declaration.type !== "ClassDeclaration" || !declaration.id) continue;
      const className = String((declaration.id as Node).name);
      const members = (out[className] ??= new Set());
      for (const member of ((declaration.body as Node).body as Node[]) ?? []) {
        const key = member.key as Node | undefined;
        if (!key || key.type !== "Identifier") continue;
        if (member.accessibility === "private" || member.accessibility === "protected") continue;
        if (member.type !== "MethodDefinition" && member.type !== "PropertyDefinition") continue;
        if (member.kind === "constructor") continue;
        if (/@internal\b/.test(jsdocBefore(comments, member.start, source))) continue;
        members.add(String(key.name));
      }
    }
  }
  return Object.fromEntries(
    Object.entries(out)
      .filter(([, members]) => members.size > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, members]) => [name, [...members].sort()]),
  );
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

function sdkSourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (
        /\.tsx?$/.test(entry.name) &&
        !/\.(test|gen)\.tsx?$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts")
      )
        files.push(path);
    }
  };
  visit(root);
  return files;
}

export type SurfaceSources = {
  repositoryRoot: string;
  registeredRoutes: readonly RegisteredRoute[];
  contractSchemas: ReadonlyMap<string, unknown>;
  toJsonSchema: (schema: unknown, io: SchemaIo) => JsonSchema;
};

export function generateSnapshot(sources: SurfaceSources): Snapshot {
  const root = sources.repositoryRoot;
  const sdkDir = join(root, "packages/sdk");
  const files = sdkSourceFiles(join(sdkDir, "src"));
  const methods = extractSdkMethods(files).filter((method) => !method.internal);
  const registered = sources.registeredRoutes.filter((route) => route.path.startsWith("/v1/"));
  const routes = new Map<string, RouteEntry>();
  const unmatched = new Set<string>();
  const schemaUse = new Map<string, Set<SchemaIo>>();
  const noteSchema = (name: string, io: SchemaIo) => {
    if (!sources.contractSchemas.has(name)) return false;
    (schemaUse.get(name) ?? schemaUse.set(name, new Set()).get(name)!).add(io);
    return true;
  };
  for (const method of methods) {
    const verbs = method.verbs.size > 0 ? [...method.verbs] : ["GET"];
    for (const path of method.paths) {
      let matchedAny = false;
      for (const verb of verbs) {
        for (const route of matchRoutes(path, verb, registered)) {
          matchedAny = true;
          const key = `${route.method} ${route.path}`;
          const entry =
            routes.get(key) ??
            routes
              .set(key, {
                method: route.method,
                path: route.path,
                sdk: [],
                request: [],
                response: [],
              })
              .get(key)!;
          if (!entry.sdk.includes(method.name)) entry.sdk.push(method.name);
          for (const name of method.requestTypes) {
            if (noteSchema(name, "input") && !entry.request.includes(name))
              entry.request.push(name);
          }
          for (const name of method.responseTypes) {
            if (noteSchema(name, "output") && !entry.response.includes(name))
              entry.response.push(name);
          }
        }
      }
      const isHelperPrefix = [...method.paths].some((other) => other.startsWith(`${path}/`));
      if (!matchedAny && !isHelperPrefix)
        unmatched.add(`${[...verbs].sort().join("|")} ${path} (${method.name})`);
    }
  }
  for (const route of PUBLIC_INGRESS_ROUTES) {
    const [method, path] = route.split(" ") as [string, string];
    if (!registered.some((candidate) => candidate.method === method && candidate.path === path)) {
      throw new Error(`public ingress route is not registered by the API: ${route}`);
    }
  }
  for (const name of PUBLIC_EVENT_SCHEMAS) noteSchema(name, "output");
  const events: Record<string, string[]> = {};
  for (const name of PUBLIC_EVENT_ENUMS) {
    const schema = sources.contractSchemas.get(name) as { options?: unknown[] } | undefined;
    if (!schema?.options) throw new Error(`public event enum missing from contracts: ${name}`);
    events[name] = schema.options.map(String).sort();
  }
  const jsonCache = new Map<string, JsonSchema>();
  const jsonFor = (name: string, io: SchemaIo): JsonSchema => {
    const key = `${io}:${name}`;
    let json = jsonCache.get(key);
    if (!json) {
      const { $schema: _ignored, ...rest } = sources.toJsonSchema(
        sources.contractSchemas.get(name),
        io,
      );
      json = rest;
      jsonCache.set(key, json);
    }
    return json;
  };
  const candidates = new Map<SchemaIo, Map<string, string>>();
  const candidatesFor = (io: SchemaIo): Map<string, string> => {
    let map = candidates.get(io);
    if (map) return map;
    map = new Map();
    const names = [...sources.contractSchemas.keys()].sort(
      (a, b) => a.length - b.length || a.localeCompare(b),
    );
    for (const name of names) {
      const json = jsonFor(name, io);
      if (json.$defs) continue;
      const branches = unionBranches(json);
      const referenceable =
        (json.type === "object" &&
          Object.keys((json.properties as object | undefined) ?? {}).length > 0) ||
        (branches !== null && branches.length >= 2) ||
        (Array.isArray(json.enum) && json.enum.length >= 2);
      if (!referenceable) continue;
      const key = JSON.stringify(json);
      if (!map.has(key)) map.set(key, name);
    }
    candidates.set(io, map);
    return map;
  };
  let schemas: Snapshot["schemas"] = {};
  // Iterate to a fixpoint: a nested named contract becomes its own entry, and
  // the direction(s) it is used in can grow as more parents reference it.
  for (let changed = true; changed;) {
    changed = false;
    schemas = {};
    for (const name of [...schemaUse.keys()].sort()) {
      const ios = [...schemaUse.get(name)!].sort() as SchemaIo[];
      // A type used both ways is fingerprinted in its stricter (input) form and
      // diffed with both rule sets.
      const io: SchemaIo = ios.includes("input") ? "input" : "output";
      const json = jsonFor(name, io);
      const shape = flattenJsonSchema(json, (sub) => {
        const referenced = candidatesFor(io).get(JSON.stringify(sub));
        if (!referenced || referenced === name) return null;
        const uses =
          schemaUse.get(referenced) ?? schemaUse.set(referenced, new Set()).get(referenced)!;
        if (!uses.has(io)) {
          uses.add(io);
          changed = true;
        }
        return referenced;
      });
      schemas[name] = { io: ios, shape: encodeShape(shape) };
    }
  }
  const sdkVersion = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8"))
    .version as string;
  const sortedRoutes = [...routes.values()]
    .map((entry) => ({
      ...entry,
      sdk: entry.sdk.sort(),
      request: entry.request.sort(),
      response: entry.response.sort(),
    }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return {
    schemaVersion: 1,
    generatedBy: "bun run public-api:refresh",
    sdkMajor: Number(sdkVersion.split(".")[0]),
    routes: sortedRoutes,
    ingress: [...PUBLIC_INGRESS_ROUTES].sort(),
    unmatchedSdkCalls: [...unmatched].sort(),
    events,
    schemas,
    exports: {
      ...packageEntryExports(sdkDir, "@opengeni/sdk"),
      ...packageEntryExports(join(root, "packages/react"), "@opengeni/react"),
    },
    sdkMembers: sdkClassMembers(files),
  };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export type Finding = {
  /** Stable identifier an allowlist entry references. */
  id: string;
  breaking: boolean;
  message: string;
};

function shapeFindings(
  name: string,
  ios: readonly SchemaIo[],
  before: Shape,
  after: Shape,
): Finding[] {
  const findings: Finding[] = [];
  const input = ios.includes("input");
  const output = ios.includes("output");
  const push = (path: string, breaking: boolean, message: string) =>
    findings.push({
      id: `schema:${name}:${path}`,
      breaking,
      message: `${name} ${path}: ${message}`,
    });
  for (const [path, old] of Object.entries(before)) {
    const next = after[path];
    if (!next) {
      // A removed union variant is reported by its union node's value diff.
      if (/\|[^.|[\]{}]+$/.test(path)) continue;
      // A child of a removed parent is reported once, at the parent.
      const parent = path.replace(/(\.[^.|[\]{}]+|\[\]|\{\}|\|[^.|[\]{}]+)$/, "");
      if (parent !== path && before[parent] && !after[parent]) continue;
      push(path, true, "field removed");
      continue;
    }
    if (old.t !== next.t) {
      const widenedInput = input && !output && next.t === "unknown";
      const narrowedOutput = output && !input && old.t === "unknown";
      if (!widenedInput && !narrowedOutput) push(path, true, `type changed ${old.t} -> ${next.t}`);
      continue;
    }
    if (old.req !== undefined && next.req !== undefined && old.req !== next.req) {
      if (input && !old.req && next.req) push(path, true, "became required in a request");
      else if (output && old.req && !next.req) push(path, true, "became optional in a response");
      else push(path, false, `required ${old.req} -> ${next.req}`);
    }
    if (Boolean(old.nullable) !== Boolean(next.nullable)) {
      if (input && old.nullable && !next.nullable) push(path, true, "no longer accepts null");
      else if (output && !old.nullable && next.nullable)
        push(path, true, "may now be null in a response");
      else push(path, false, `nullable ${Boolean(old.nullable)} -> ${Boolean(next.nullable)}`);
    }
    if (old.enum || next.enum) {
      const removed = (old.enum ?? []).filter((value) => !(next.enum ?? []).includes(value));
      const added = (next.enum ?? []).filter((value) => !(old.enum ?? []).includes(value));
      // Union variants behave like enum values: a removed request variant
      // breaks callers; response variants may come and go for tolerant readers.
      if (removed.length > 0) push(path, input, `values removed: ${removed.join(", ")}`);
      if (added.length > 0) push(path, false, `values added: ${added.join(", ")}`);
    }
  }
  for (const [path, next] of Object.entries(after)) {
    if (before[path]) continue;
    const parent = path.replace(/(\.[^.|[\]{}]+|\[\]|\{\}|\|[^.|[\]{}]+)$/, "");
    const parentExisted = parent === path || Boolean(before[parent]);
    if (input && next.req && parentExisted) push(path, true, "new required request field");
    else if (parentExisted) push(path, false, "field added");
  }
  return findings;
}

export function diffSnapshots(before: Snapshot, after: Snapshot): Finding[] {
  const findings: Finding[] = [];
  const afterRoutes = new Map(
    after.routes.map((route) => [`${route.method} ${route.path}`, route]),
  );
  const beforeRoutes = new Map(
    before.routes.map((route) => [`${route.method} ${route.path}`, route]),
  );
  for (const [key, route] of beforeRoutes) {
    const next = afterRoutes.get(key);
    if (!next) {
      findings.push({
        id: `route:${key}`,
        breaking: true,
        message: `route removed from the public surface: ${key}`,
      });
      continue;
    }
    for (const side of ["request", "response"] as const) {
      const removed = route[side].filter((name) => !next[side].includes(name));
      if (removed.length > 0) {
        findings.push({
          id: `route:${key}:${side}`,
          breaking: true,
          message: `${key} ${side} schema changed: ${removed.join(", ")} -> ${next[side].join(", ") || "(none)"}`,
        });
      }
      const added = next[side].filter((name) => !route[side].includes(name));
      if (added.length > 0 && removed.length === 0) {
        findings.push({
          id: `route:${key}:${side}`,
          breaking: false,
          message: `${key} ${side} schema added: ${added.join(", ")}`,
        });
      }
    }
  }
  for (const key of afterRoutes.keys()) {
    if (!beforeRoutes.has(key))
      findings.push({ id: `route:${key}`, breaking: false, message: `route added: ${key}` });
  }
  for (const ingress of before.ingress) {
    if (!after.ingress.includes(ingress))
      findings.push({
        id: `ingress:${ingress}`,
        breaking: true,
        message: `ingress removed: ${ingress}`,
      });
  }
  for (const [name, values] of Object.entries(before.events)) {
    const next = after.events[name] ?? [];
    for (const value of values) {
      if (!next.includes(value))
        findings.push({
          id: `event:${name}:${value}`,
          breaking: true,
          message: `${name} value removed: ${value}`,
        });
    }
    for (const value of next) {
      if (!values.includes(value))
        findings.push({
          id: `event:${name}:${value}`,
          breaking: false,
          message: `${name} value added: ${value}`,
        });
    }
  }
  for (const [name, schema] of Object.entries(before.schemas)) {
    const next = after.schemas[name];
    if (!next) {
      const stillReferenced = after.routes.some(
        (route) => route.request.includes(name) || route.response.includes(name),
      );
      if (!stillReferenced) continue; // reported through the route/side change
      findings.push({
        id: `schema:${name}`,
        breaking: true,
        message: `schema ${name} no longer fingerprinted`,
      });
      continue;
    }
    const ios = [...new Set([...schema.io, ...next.io])] as SchemaIo[];
    findings.push(...shapeFindings(name, ios, decodeShape(schema.shape), decodeShape(next.shape)));
  }
  for (const [entry, names] of Object.entries(before.exports)) {
    const next = after.exports[entry];
    if (!next) {
      findings.push({
        id: `export:${entry}`,
        breaking: true,
        message: `package entry point removed: ${entry}`,
      });
      continue;
    }
    for (const [name, kind] of Object.entries(names)) {
      if (!(name in next)) {
        findings.push({
          id: `export:${entry}:${name}`,
          breaking: true,
          message: `${entry} no longer exports ${name}`,
        });
      } else if (kind === "value" && next[name] === "type") {
        findings.push({
          id: `export:${entry}:${name}`,
          breaking: true,
          message: `${entry} export ${name} became type-only`,
        });
      }
    }
    for (const name of Object.keys(next)) {
      if (!(name in names))
        findings.push({
          id: `export:${entry}:${name}`,
          breaking: false,
          message: `${entry} exports ${name}`,
        });
    }
  }
  for (const entry of Object.keys(after.exports)) {
    if (!(entry in before.exports))
      findings.push({
        id: `export:${entry}`,
        breaking: false,
        message: `package entry point added: ${entry}`,
      });
  }
  for (const [className, members] of Object.entries(before.sdkMembers)) {
    const next = after.sdkMembers[className] ?? [];
    for (const member of members) {
      if (!next.includes(member))
        findings.push({
          id: `member:${className}.${member}`,
          breaking: true,
          message: `${className}.${member} removed`,
        });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Allowlist (the breaking-change log)
// ---------------------------------------------------------------------------

export type AllowlistEntry = {
  /** Finding id(s) this entry covers; a trailing `*` matches a prefix. */
  ids: string[];
  /** Where the deprecation was announced: changeset, docs URL, or ADR log anchor. */
  deprecation: string;
  /** SDK/API major that removes the old behaviour; must exceed the base major. */
  removedInMajor: number;
  /** Earliest removal date on the managed service (Sunset), ISO date. */
  sunset: string;
  reason: string;
  /** Optional emergency security exception (ADR (d)); still logged here. */
  securityException?: boolean;
};

export function validateAllowlist(entries: unknown): AllowlistEntry[] {
  if (!Array.isArray(entries)) throw new Error(`${ALLOWLIST_PATH} must be a JSON array`);
  return entries.map((raw, index) => {
    const entry = raw as Partial<AllowlistEntry>;
    const where = `${ALLOWLIST_PATH}[${index}]`;
    if (
      !Array.isArray(entry.ids) ||
      entry.ids.length === 0 ||
      !entry.ids.every((id) => typeof id === "string" && id)
    )
      throw new Error(`${where}.ids must be a non-empty string array`);
    if (
      typeof entry.deprecation !== "string" ||
      !/(\.changeset\/|https?:\/\/|docs\/)/.test(entry.deprecation)
    )
      throw new Error(
        `${where}.deprecation must reference a changeset, docs path, or URL announcing the deprecation`,
      );
    if (!Number.isInteger(entry.removedInMajor))
      throw new Error(`${where}.removedInMajor must be an integer major`);
    if (typeof entry.sunset !== "string" || Number.isNaN(Date.parse(entry.sunset)))
      throw new Error(`${where}.sunset must be an ISO date`);
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 10)
      throw new Error(`${where}.reason must explain the change`);
    return entry as AllowlistEntry;
  });
}

export function allowlisted(
  finding: Finding,
  entries: readonly AllowlistEntry[],
  baseMajor: number,
): AllowlistEntry | null {
  for (const entry of entries) {
    const matches = entry.ids.some((id) =>
      id.endsWith("*") ? finding.id.startsWith(id.slice(0, -1)) : finding.id === id,
    );
    if (!matches) continue;
    if (entry.securityException || entry.removedInMajor > baseMajor) return entry;
  }
  return null;
}
