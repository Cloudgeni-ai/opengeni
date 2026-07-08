import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// P0.4 guard: apps/api accesses sandbox construction/resume symbols ONLY via the
// agent-loop-free leaf `@opengeni/runtime/sandbox` — NEVER the bare
// `@opengeni/runtime` barrel (which re-exports the @openai/agents agent loop:
// Agent/run/Runner/RunState). Importing the barrel would pull the agent-loop
// graph into the API process and break the API-direct control-plane invariant.
// This test fails-closed if any apps/api source file regresses by importing the
// barrel (or any agent-loop entrypoint) directly.

const here = dirname(fileURLToPath(import.meta.url));
const apiSrc = resolve(here, "..", "src");

// Forbidden module specifiers in apps/api source: the runtime barrel + the raw
// @openai agent-loop roots. The /sandbox subpath is the ONLY allowed runtime
// import.
const FORBIDDEN_SPECIFIERS = new Set([
  "@opengeni/runtime",
  "@openai/agents",
  "@openai/agents-extensions",
  "@openai/agents-core",
]);

const ALLOWED_RUNTIME_SUBPATH = "@opengeni/runtime/sandbox";

function importSpecifiersOf(source: string): string[] {
  const specifiers: string[] = [];
  // static `import ... from "x"` / `export ... from "x"` / bare `import "x"` /
  // dynamic `import("x")` — string-literal module specifiers.
  const re =
    /(?:import|export)\b[^;]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    specifiers.push((match[1] ?? match[2] ?? match[3])!);
  }
  return specifiers;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("apps/api — sandbox access only via @opengeni/runtime/sandbox (P0.4 guard)", () => {
  test("no apps/api source imports the bare runtime barrel or any agent-loop root", () => {
    const files = listSourceFiles(apiSrc);
    expect(files.length).toBeGreaterThan(0);

    const offenders: Array<{ file: string; specifier: string }> = [];
    let sawAllowedRuntimeImport = false;

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const spec of importSpecifiersOf(source)) {
        if (FORBIDDEN_SPECIFIERS.has(spec)) {
          offenders.push({ file: file.slice(apiSrc.length + 1), specifier: spec });
        }
        if (spec === ALLOWED_RUNTIME_SUBPATH) {
          sawAllowedRuntimeImport = true;
        }
        // Defensive: any @opengeni/runtime/* subpath other than /sandbox is also
        // a violation (only the leaf is allowed). None exist today, but pin it.
        if (spec.startsWith("@opengeni/runtime/") && spec !== ALLOWED_RUNTIME_SUBPATH) {
          offenders.push({ file: file.slice(apiSrc.length + 1), specifier: spec });
        }
      }
    }

    expect(offenders).toEqual([]);
    // And the API DOES use the leaf (the access seam exists) — so this guard is
    // protecting a live import, not vacuously green.
    expect(sawAllowedRuntimeImport).toBe(true);
  });

  test("the sandbox access seam imports the leaf and exposes resumeBoxById", async () => {
    const accessSource = readFileSync(join(apiSrc, "sandbox", "access.ts"), "utf8");
    expect(accessSource).toContain('from "@opengeni/runtime/sandbox"');
    expect(accessSource).not.toContain('from "@opengeni/runtime"');

    const mod = await import("../src/sandbox/access");
    expect(typeof mod.createApiSandboxClient).toBe("function");
    expect(typeof mod.makeResumeBoxById).toBe("function");
  });
});
