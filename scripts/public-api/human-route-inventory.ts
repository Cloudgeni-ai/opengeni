/** Source inventory for OPE-647. Classifications are reviewed, never inferred. */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseSync } from "oxc-parser";

type Node = { type: string; [key: string]: unknown };
type Environment = Map<string, string[]>;
export type HumanRoute = { method: string; path: string; source: string; gates: string[] };

// Authentication resolvers are not gates. Stop at named policy boundaries so
// resolving an ordinary AccessGrant does not classify every authenticated API.
export const HUMAN_GATE_FUNCTIONS = new Set([
  "requireManagedHuman",
  "managedCookieHuman",
  "requireOrganizationCodexHuman",
  "requireSameOriginBrowserMutation",
  "requireRedemptionHuman",
  "requireCodexAppsHuman",
  "requirePrivateHuman",
  "requireScopeMutation",
  "requireCanonicalLocalAccountAdministrator",
  "requireCanonicalHumanRequestIdentity",
  "admitManagedSignInMutation",
  "requireRecoveryIdentity",
  "nativeConfirmation",
  "requireHumanMutation",
  "requireDirectAccountAdmin",
  "requireDirectWorkspaceAdmin",
  "requireCurrentHumanToolAccess",
  "requireManagedSlackLinkHuman",
  "hasVerifiedOwningUserAuthorization",
  "requireCanonicalManagedHuman",
  "requireOwningUser",
  "getManagedHumanSessionCreateCapabilities",
  "updateManagedHumanSessionVisibility",
  "forkManagedHumanSession",
  "getManagedHumanSandboxRecovery",
  "consentManagedHumanSandboxRecovery",
  "getUserResourceAuthorities",
  "putUserResourceAuthority",
  "deleteUserResourceAuthority",
  "requireVerifiedOwningUser",
  "requireWorkspaceToolGatewayAuthorization",
  "requireManagedAuthMutationAdmission",
  "getManagedSession",
  "requireManagedAuthProviderRouteAllowed",
  "listManagedHumanUserResourceAuthorities",
  "issueManagedHumanUserResourceGrant",
  "revokeManagedHumanUserResourceGrant",
  "refreshScheduledTaskAccess",
  "getManagedAuthSessionSetSnapshot",
  "requireManagedHumanPrivateSessionCreate",
  "requireWorkspaceSettingsGrant",
  "rotateSessionMcpCredentialsForRequest",
  "createArchivedSessionForRequest",
  "importArchivedSessionForRequest",
  "appendArchivedSessionEventsForRequest",
  "requireConnectOwnerAuthority",
  "requireManagedHumanRouteIdentity",
  "requireOrganizationRouteAdministrator",
  "requireOrganizationCodexAdministrator",
  "requireNonCookieOrSameOriginMutation",
  "requirePersonPresentRouteAuthorization",
  "requireDelegableHumanRouteAuthorization",
  "requireUserOrOrganizationRouteAuthorization",
  "requireLegacyOAuthActor",
]);
const HUMAN_GATE_PROPERTIES = new Set([
  "canonicalManagedHumanSession",
  "canonicalLocalHumanSession",
]);

function isNode(value: unknown): value is Node {
  return value !== null && typeof value === "object" && typeof (value as Node).type === "string";
}
function children(node: Node): Node[] {
  return Object.values(node).flatMap((value) =>
    Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : [],
  );
}
function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of children(node)) walk(child, visit);
}
function name(node: unknown): string | null {
  if (!isNode(node)) return null;
  if (node.type === "Identifier") return String(node.name);
  if (node.type === "MemberExpression") return name(node.property);
  return null;
}
function strings(node: unknown, env: Environment): string[] {
  if (!isNode(node)) return [];
  if (node.type === "Literal" && typeof node.value === "string") return [node.value];
  if (node.type === "Identifier") return env.get(String(node.name)) ?? [];
  if (node.type === "TSAsExpression") return strings(node.expression, env);
  if (node.type === "ConditionalExpression")
    return [...new Set([...strings(node.consequent, env), ...strings(node.alternate, env)])];
  if (node.type === "ArrayExpression")
    return (node.elements as unknown[]).flatMap((value) => strings(value, env));
  if (node.type === "BinaryExpression" && node.operator === "+")
    return strings(node.left, env).flatMap((left) =>
      strings(node.right, env).map((right) => left + right),
    );
  if (node.type === "TemplateLiteral") {
    let values = [""];
    const expressions = node.expressions as Node[];
    for (const [index, quasi] of (node.quasis as Node[]).entries()) {
      const value = quasi.value as { cooked: string; raw: string };
      values = values.map((prefix) => prefix + (value.cooked ?? value.raw));
      if (expressions[index])
        values = values.flatMap((prefix) =>
          strings(expressions[index], env).map((v) => prefix + v),
        );
    }
    return values;
  }
  return [];
}
function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}
type Module = {
  path: string;
  program: Node;
  functions: Map<string, Node[]>;
  imports: Map<string, { path: string; symbol: string }>;
};

/** Includes conditional gates and provenance-limited projections, not only denials. */
export function inventoryHumanRoutes(repoRoot: string): HumanRoute[] {
  const modules = new Map<string, Module>();
  for (const path of files(join(repoRoot, "apps/api/src"))) {
    if (path.includes("/mcp/")) continue;
    const parsed = parseSync(path, readFileSync(path, "utf8"));
    if (parsed.errors.length) throw new Error(`${path}: ${parsed.errors[0]!.message}`);
    const module: Module = {
      path,
      program: parsed.program as unknown as Node,
      functions: new Map(),
      imports: new Map(),
    };
    walk(module.program, (node) => {
      let symbol: string | null = null;
      let body: Node | null = null;
      if (node.type === "FunctionDeclaration") {
        symbol = name(node.id);
        body = node.body as Node;
      } else if (
        node.type === "VariableDeclarator" &&
        isNode(node.init) &&
        ["ArrowFunctionExpression", "FunctionExpression"].includes(node.init.type)
      ) {
        symbol = name(node.id);
        body = node.init.body as Node;
      }
      if (symbol && body)
        module.functions.set(symbol, [...(module.functions.get(symbol) ?? []), body]);
      if (node.type === "ImportDeclaration") {
        const source = (node.source as Node).value;
        if (typeof source !== "string" || !source.startsWith(".")) return;
        for (const specifier of node.specifiers as Node[]) {
          if (specifier.type !== "ImportSpecifier") continue;
          module.imports.set(name(specifier.local)!, {
            path: resolve(dirname(path), source + ".ts"),
            symbol: name(specifier.imported)!,
          });
        }
      }
    });
    modules.set(path, module);
  }
  function gatesFor(node: Node, module: Module, seen = new Set<string>()): Set<string> {
    if (node.type === "Identifier") {
      return gatesFor({ type: "CallExpression", callee: node, arguments: [] }, module, seen);
    }
    const gates = new Set<string>();
    walk(node, (child) => {
      if (child.type === "MemberExpression") {
        const property = name(child.property);
        if (property && HUMAN_GATE_PROPERTIES.has(property)) gates.add(property);
      }
      if (child.type === "BinaryExpression" && ["===", "!=="].includes(String(child.operator))) {
        for (const [member, literal] of [
          [child.left, child.right],
          [child.right, child.left],
        ]) {
          if (
            isNode(member) &&
            member.type === "MemberExpression" &&
            name(member.property) === "principalKind" &&
            isNode(literal) &&
            literal.value === "human_session"
          )
            gates.add("principalKind=human_session");
          if (
            isNode(member) &&
            member.type === "MemberExpression" &&
            name(member.property) === "kind" &&
            isNode(member.object) &&
            member.object.type === "MemberExpression" &&
            name(member.object.property) === "actor" &&
            isNode(literal) &&
            literal.value === "human"
          )
            gates.add("actor.kind=human");
        }
      }
      if (child.type !== "CallExpression") return;
      const symbol = name(child.callee);
      if (!symbol) return;
      if (
        HUMAN_GATE_FUNCTIONS.has(symbol) ||
        /^require.*(?:Human|SameOrigin|PersonPresent)/u.test(symbol)
      ) {
        gates.add(symbol);
        return;
      }
      const imported = module.imports.get(symbol);
      const target = imported ? modules.get(imported.path) : module;
      const targetSymbol = imported?.symbol ?? symbol;
      if (!target) return;
      const identity = `${target.path}:${targetSymbol}`;
      if (seen.has(identity)) return;
      const nextSeen = new Set([...seen, identity]);
      for (const body of target.functions.get(targetSymbol) ?? [])
        for (const gate of gatesFor(body, target, nextSeen)) gates.add(gate);
    });
    return gates;
  }
  const routes = new Map<string, HumanRoute>();
  for (const module of modules.values()) {
    function visit(node: Node, env: Environment): void {
      if (node.type === "ForOfStatement") {
        const left = node.left as Node;
        const binding =
          left.type === "VariableDeclaration"
            ? name((left.declarations as Node[])[0]?.id)
            : name(left);
        const values = strings(node.right, env);
        if (binding && values.length) {
          for (const value of values)
            visit(node.body as Node, new Map([...env, [binding, [value]]]));
          return;
        }
      }
      if (node.type === "VariableDeclarator") {
        const binding = name(node.id);
        const values = strings(node.init, env);
        if (binding && values.length) env.set(binding, values);
      }
      if (
        node.type === "CallExpression" &&
        isNode(node.callee) &&
        node.callee.type === "MemberExpression" &&
        name(node.callee.object) === "app"
      ) {
        const verb = name(node.callee.property);
        const args = node.arguments as Node[];
        if (verb && ["get", "post", "put", "patch", "delete", "all", "on"].includes(verb)) {
          const methods = verb === "on" ? strings(args[0], env) : [verb.toUpperCase()];
          const paths = strings(args[verb === "on" ? 1 : 0], env);
          const gates = new Set<string>();
          for (const handler of args.slice(verb === "on" ? 2 : 1))
            for (const gate of gatesFor(handler, module)) gates.add(gate);
          if (gates.size && !paths.length)
            throw new Error(`Unresolved gated route in ${module.path}: ${verb} at ${node.start}`);
          for (const method of methods)
            for (const path of paths) {
              if (!gates.size) continue;
              const key = `${method} ${path}`;
              const existing = routes.get(key);
              routes.set(key, {
                method,
                path,
                source: module.path.slice(repoRoot.length + 1),
                gates: [...new Set([...(existing?.gates ?? []), ...gates])].sort(),
              });
            }
        }
      }
      const localEnv = [
        "BlockStatement",
        "FunctionDeclaration",
        "ArrowFunctionExpression",
      ].includes(node.type)
        ? new Map(env)
        : env;
      for (const child of children(node)) visit(child, localEnv);
    }
    visit(module.program, new Map());
  }
  return [...routes.values()].sort((a, b) =>
    `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`),
  );
}

if (import.meta.main)
  console.log(JSON.stringify(inventoryHumanRoutes(resolve(import.meta.dir, "../..")), null, 2));
