import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Routes guarded by `requireSameOriginBrowserMutation` admit a signed-in
// browser only for a same-origin JSON request: no `content-type:
// application/json`, no admission (403). The SDK sets that header only when a
// call sends a body, so a client call to such a route must always send one,
// even `{}`. A bodiless call works with an API key and is refused for every
// person using the web app, which is how a workspace admin's Codex sign-in
// failed with "You don't have permission".
const root = fileURLToPath(new URL("..", import.meta.url));

const SKIPPED = /(^|\/)(node_modules|dist|build|\.turbo)(\/|$)/;

function sources(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (SKIPPED.test(path)) continue;
    if (statSync(path).isDirectory()) files.push(...sources(path));
    else if (/\.tsx?$/.test(name) && !/\.(test|gen)\.tsx?$/.test(name)) files.push(path);
  }
  return files;
}

type Route = { method: string; path: string; file: string };

/** `const name = "/v1/..."` and `const name = cond ? "/v1/a" : "/v1/b"` in one file. */
function pathConstants(text: string): Map<string, string[]> {
  const constants = new Map<string, string[]>();
  for (const match of text.matchAll(/const (\w+) =\s*([^;]+);/g)) {
    const literals = [...match[2]!.matchAll(/"(\/v1\/[^"]+)"/g)].map((literal) => literal[1]!);
    if (literals.length > 0) constants.set(match[1]!, literals);
  }
  return constants;
}

/** A route's first argument: a string, a path constant, or a template over one. */
function routePaths(argument: string, constants: Map<string, string[]>): string[] {
  const literal = /^"([^"]+)"$/.exec(argument);
  if (literal) return [literal[1]!];
  const constant = constants.get(argument);
  if (constant) return constant;
  const template = /^`\$\{(\w+)\}([^`$]*)`$/.exec(argument);
  if (template) return (constants.get(template[1]!) ?? []).map((base) => `${base}${template[2]}`);
  return [];
}

function guardedRoutes(): Route[] {
  const routes: Route[] = [];
  for (const file of sources(join(root, "apps/api/src"))) {
    const text = readFileSync(file, "utf8");
    const constants = pathConstants(text);
    const declarations = [
      ...text.matchAll(/app\.(post|patch|put|delete)\(\s*("[^"]+"|`[^`]+`|\w+)\s*,/g),
    ];
    declarations.forEach((match, index) => {
      const end = declarations[index + 1]?.index ?? text.length;
      if (!text.slice(match.index, end).includes("requireSameOriginBrowserMutation(")) return;
      for (const path of routePaths(match[2]!, constants)) {
        routes.push({ method: match[1]!.toUpperCase(), path, file });
      }
    });
  }
  return routes;
}

type Call = { method: string; path: string; hasBody: boolean; file: string; line: number };

// `requestJson("POST", `/v1/...`, body?)` and `requestVoid(...)`, in the SDK
// and the web app. The path's `${...}` parts stand for route parameters.
const CALL = /request(?:Json|Void)(?:<[^>]*>)?\(\s*"(POST|PATCH|PUT|DELETE)",\s*(`[^`]+`|"[^"]+")/g;

/** The argument after the path: none, `undefined`, or a body. */
function sendsBody(afterPath: string): boolean {
  const rest = afterPath.trimStart();
  if (!rest.startsWith(",")) return false;
  const next = rest.slice(1).trimStart();
  return !next.startsWith(")") && !/^undefined\b/.test(next);
}

function clientCalls(): Call[] {
  const calls: Call[] = [];
  for (const file of [
    ...sources(join(root, "packages/sdk/src")),
    ...sources(join(root, "apps/web/src")),
  ]) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(CALL)) {
      calls.push({
        method: match[1]!,
        path: match[2]!.slice(1, -1).replace(/\$\{[^}]+\}/g, ":param"),
        hasBody: sendsBody(text.slice(match.index + match[0].length)),
        file,
        line: text.slice(0, match.index).split("\n").length,
      });
    }
  }
  return calls;
}

/** A route parameter matches any one segment of the client's path. */
function routeMatches(route: string, call: string): boolean {
  const routeSegments = route.split("/");
  const callSegments = call.split("?")[0]!.split("/");
  return (
    routeSegments.length === callSegments.length &&
    routeSegments.every(
      (segment, index) =>
        segment.startsWith(":") ||
        callSegments[index] === ":param" ||
        segment === callSegments[index],
    )
  );
}

test("guarded routes are found (the scan still matches the route style)", () => {
  const routes = guardedRoutes();
  expect(routes.length).toBeGreaterThan(10);
  expect(routes).toContainEqual(
    expect.objectContaining({
      method: "POST",
      path: "/v1/workspaces/:workspaceId/codex/connect/start",
    }),
  );
});

test("every client call to a same-origin JSON route sends a JSON body", () => {
  const routes = guardedRoutes();
  const calls = clientCalls();
  const bodiless = routes.flatMap((route) =>
    calls
      .filter((call) => call.method === route.method && routeMatches(route.path, call.path))
      .filter((call) => !call.hasBody)
      .map((call) => `${route.method} ${route.path} <- ${relative(root, call.file)}:${call.line}`),
  );
  expect(bodiless).toEqual([]);
});
