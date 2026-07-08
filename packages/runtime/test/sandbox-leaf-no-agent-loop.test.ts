import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// P0.2 guard: @opengeni/runtime/sandbox is the agent-loop-free leaf. The API
// imports resume-by-id + file/exec/port helpers from it WITHOUT pulling in the
// @openai/agents agent loop. These tests fail-closed if a future edit
// reintroduces an agent-loop import into the leaf's transitive graph.

const here = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(here, "..");
const leafEntry = join(runtimeRoot, "src", "sandbox", "index.ts");

// The agent-loop entrypoints the leaf must NEVER statically import. These are
// the bare package roots whose index re-exports Agent/run/Runner/RunState (the
// @openai/agents loop graph). The per-provider sandbox SUBPATHS
// (`@openai/agents/sandbox`, `.../sandbox/local`,
// `@openai/agents-extensions/sandbox/modal`) are explicitly allowed — they are
// the sandbox SDK build imports the leaf is built on.
const FORBIDDEN_AGENT_LOOP_SPECIFIERS = new Set([
  "@openai/agents",
  "@openai/agents-extensions",
  "@openai/agents-core",
]);

// The OpenGeni agent-loop barrel markers (defined in packages/runtime/src/index.ts).
// If any of these strings appear in the LEAF's resolved bundle, the leaf is
// transitively pulling the runtime agent code back in — a regression.
const AGENT_BARREL_MARKERS = ["buildOpenGeniAgent", "prepareRunInput", "withSandboxLifecycleHooks"];

function importSpecifiersOf(source: string): string[] {
  const specifiers: string[] = [];
  // `import ... from "x"` / `export ... from "x"` / `import "x"` — string-literal
  // module specifiers (covers static import + re-export; the leaf has no dynamic
  // import()).
  const re =
    /(?:import|export)\b[^;]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    specifiers.push((match[1] ?? match[2])!);
  }
  return specifiers;
}

describe("@opengeni/runtime/sandbox — agent-loop-free leaf (P0.2 guard)", () => {
  test("leaf source imports no @openai/agents* agent-loop entrypoint", () => {
    const source = readFileSync(leafEntry, "utf8");
    const specifiers = importSpecifiersOf(source);

    expect(specifiers.length).toBeGreaterThan(0);

    const offenders = specifiers.filter((spec) => FORBIDDEN_AGENT_LOOP_SPECIFIERS.has(spec));
    expect(offenders).toEqual([]);

    // Every @openai/* import the leaf takes must be a /sandbox subpath (the SDK
    // build import), never a bare loop root.
    const openaiImports = specifiers.filter((spec) => spec.startsWith("@openai/"));
    expect(openaiImports.length).toBeGreaterThan(0);
    for (const spec of openaiImports) {
      expect(spec).toMatch(/\/sandbox(\/|$)/);
    }
  });

  test("leaf's transitive OpenGeni-authored import graph reaches no agent-loop entrypoint", () => {
    // Crawl the resolved transitive import set of the leaf, following only the
    // OpenGeni-authored source (relative `./` imports + workspace `@opengeni/*`
    // packages). Third-party packages are inspected as leaves but not recursed.
    // If ANY reachable source file imports a forbidden agent-loop entrypoint —
    // including the runtime barrel (packages/runtime/src/index.ts, whose markers
    // are listed below) — the leaf has regressed. This is the hermetic
    // dep-graph assertion (no bundler third-party resolution needed).
    const workspaceRoot = resolve(runtimeRoot, "..", "..");

    const resolveLocal = (spec: string, fromFile: string): string | null => {
      let basePath: string | null = null;
      if (spec.startsWith(".")) {
        basePath = resolve(dirname(fromFile), spec);
      } else if (spec === "@opengeni/runtime") {
        basePath = join(workspaceRoot, "packages", "runtime", "src", "index");
      } else if (spec === "@opengeni/runtime/sandbox") {
        basePath = join(workspaceRoot, "packages", "runtime", "src", "sandbox", "index");
      } else if (spec.startsWith("@opengeni/")) {
        basePath = join(workspaceRoot, "packages", spec.slice("@opengeni/".length), "src", "index");
      } else {
        return null; // third-party — inspected by the import-specifier check, not recursed
      }
      for (const candidate of [basePath, `${basePath}.ts`, join(basePath, "index.ts")]) {
        try {
          readFileSync(candidate, "utf8");
          return candidate;
        } catch {
          // try next
        }
      }
      return null;
    };

    const visited = new Set<string>();
    const offenders: Array<{ file: string; specifier: string }> = [];
    const queue = [leafEntry];

    while (queue.length > 0) {
      const file = queue.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);

      const source = readFileSync(file, "utf8");
      for (const spec of importSpecifiersOf(source)) {
        if (FORBIDDEN_AGENT_LOOP_SPECIFIERS.has(spec)) {
          offenders.push({ file, specifier: spec });
        }
        const resolved = resolveLocal(spec, file);
        if (resolved && !visited.has(resolved)) {
          queue.push(resolved);
        }
      }
    }

    expect(offenders).toEqual([]);

    // The leaf must NOT transitively reach the runtime agent-loop barrel
    // (packages/runtime/src/index.ts) — that file is where the agent loop and
    // its barrel-only markers live; pulling it would re-import the loop.
    const runtimeBarrel = join(runtimeRoot, "src", "index.ts");
    expect(visited.has(runtimeBarrel)).toBe(false);

    // Sanity-check the markers actually live in the (excluded) barrel — so this
    // guard is asserting against a real, present agent-loop surface, not a typo.
    const barrelSource = readFileSync(runtimeBarrel, "utf8");
    for (const marker of AGENT_BARREL_MARKERS) {
      expect(barrelSource).toContain(marker);
    }

    // And the leaf reached at least its own file + @opengeni/config.
    expect(visited.has(leafEntry)).toBe(true);
    expect(visited.size).toBeGreaterThanOrEqual(2);
  });

  test("leaf exports the resume/recovery surface and matches the barrel re-export", async () => {
    const leaf = await import("../src/sandbox");
    const barrel = await import("../src/index");

    for (const name of [
      "createSandboxClient",
      "deserializeSandboxSessionStateEnvelope",
      "restoredSandboxSessionStateFromEntry",
      "sandboxStateEntryFromRunState",
      "collectSandboxEnvironment",
      "parseExposedPorts",
    ] as const) {
      expect(typeof (leaf as Record<string, unknown>)[name]).toBe("function");
      // `export * from "./sandbox"` keeps the barrel surface identical.
      expect((barrel as Record<string, unknown>)[name]).toBe(
        (leaf as Record<string, unknown>)[name],
      );
    }
  });

  test("sandboxStateEntryFromRunState decodes the recovery envelope without an agent loop", async () => {
    const { sandboxStateEntryFromRunState } = await import("../src/sandbox");

    expect(sandboxStateEntryFromRunState(undefined)).toBeNull();
    expect(sandboxStateEntryFromRunState({})).toBeNull();

    const entry = sandboxStateEntryFromRunState({
      _sandbox: {
        currentAgentKey: "root",
        sessionsByAgent: {
          root: {
            backendId: "modal",
            currentAgentKey: "root",
            sessionState: { providerState: { id: "sb-1" } },
          },
        },
      },
    });
    expect(entry).not.toBeNull();
    expect((entry as Record<string, unknown>).backendId).toBe("modal");
  });
});
