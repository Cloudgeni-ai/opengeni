import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// P0.4 guard: apps/api accesses runtime symbols ONLY via explicitly approved
// leaves — NEVER the bare
// `@opengeni/runtime` barrel (which re-exports the @openai/agents agent loop:
// Agent/run/Runner/RunState). Importing the barrel would pull the agent-loop
// graph into the API process and break the API-direct control-plane invariant.
// This test fails-closed if any apps/api source file regresses by importing the
// barrel (or any agent-loop entrypoint) directly.

const here = dirname(fileURLToPath(import.meta.url));
const apiSrc = resolve(here, "..", "src");

// Forbidden module specifiers in apps/api source: the runtime barrel + the raw
// @openai agent-loop roots. Every runtime subpath must be explicitly allowlisted
// here as an agent-loop-free leaf.
const FORBIDDEN_SPECIFIERS = new Set([
  "@opengeni/runtime",
  "@openai/agents",
  "@openai/agents-extensions",
  "@openai/agents-core",
]);

const ALLOWED_RUNTIME_SUBPATHS = new Set([
  // Bounded first-party Gmail transport adapter. Its only Agents dependency is
  // an erased MCPServer type import; it does not import or execute the loop.
  "@opengeni/runtime/gmail-rest-mcp",
  "@opengeni/runtime/mcp-network",
  "@opengeni/runtime/sandbox",
  // Immutable curated Skill metadata/artifact reader. This leaf imports only
  // Node filesystem/crypto utilities and does not import the agent loop.
  "@opengeni/runtime/skill-library",
  // The unified current-human gateway deliberately reuses the canonical MCP
  // preparation path used by model execution and Codemode. This entrypoint
  // exports only that preparation contract, never Agent/run/sandbox APIs.
  "@opengeni/runtime/workspace-tool-gateway",
]);

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
  test("no apps/api source imports the runtime barrel, an unapproved subpath, or any agent-loop root", () => {
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
        if (spec === "@opengeni/runtime/sandbox") {
          sawAllowedRuntimeImport = true;
        }
        // Defensive: every @opengeni/runtime/* subpath must be proven
        // agent-loop-free and named in the narrow allowlist above.
        if (spec.startsWith("@opengeni/runtime/") && !ALLOWED_RUNTIME_SUBPATHS.has(spec)) {
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
