import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SOURCE = resolve(import.meta.dir, "../src");

// What the recorder entry may load before its capture code: a host mounts it
// above every route, so anything more lands in the host's startup code.
const ALLOWED_PACKAGES = new Set(["react", "react/jsx-runtime", "@opengeni/sdk/desktop-bridge"]);

// The value imports and re-exports of a module, leaving out type-only ones
// and dynamic import(), which loads later in its own chunk.
function staticImports(code: string): string[] {
  const specifiers: string[] = [];
  for (const match of code.matchAll(
    /^(import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gms,
  )) {
    if (!match[2] && match[3]) specifiers.push(match[3]);
  }
  for (const match of code.matchAll(/^import\s+["']([^"']+)["']/gm)) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

function resolveModule(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")]) {
    if (existsSync(candidate) && candidate.match(/\.tsx?$/)) return candidate;
  }
  throw new Error(`cannot resolve ${specifier} from ${from}`);
}

describe("@opengeni/react/meetings-recorder", () => {
  test("loads only React and the desktop bridge until capture starts", () => {
    const seen = new Set<string>();
    const packages = new Set<string>();
    const pending = [resolve(SOURCE, "meetings-recorder.ts")];
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const specifier of staticImports(readFileSync(file, "utf8"))) {
        if (specifier.startsWith(".")) pending.push(resolveModule(file, specifier));
        else packages.add(specifier);
      }
    }
    expect([...packages].filter((name) => !ALLOWED_PACKAGES.has(name))).toEqual([]);
    expect([...seen].map((file) => file.slice(SOURCE.length + 1)).sort()).toEqual([
      "meetings-recorder.ts",
      "meetings/recorder-context.tsx",
    ]);
    // The recorder host and everything it needs arrive in a separate chunk.
    expect(readFileSync(resolve(SOURCE, "meetings/recorder-context.tsx"), "utf8")).toContain(
      'import("./recorder-host")',
    );
  });

  // Read, not imported: loading the Meetings UI here, before a DOM exists,
  // would change what later test files in the same run see.
  test("shares its recorder module with the Meetings UI", () => {
    const full = staticImports(readFileSync(resolve(SOURCE, "meetings.ts"), "utf8"));
    const light = staticImports(readFileSync(resolve(SOURCE, "meetings-recorder.ts"), "utf8"));
    expect(light).toEqual(["./meetings/recorder-context"]);
    expect(full).toContain("./meetings/recorder-context");
  });
});
