import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { build } from "vite";

const packageRoot = join(import.meta.dir, "..");
const sessionEntry = join(packageRoot, "src/session.ts");
function importSpecifiersOf(source: string): string[] {
  const specifiers: string[] = [];
  const pattern =
    /(?:import|export)\b[^;]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const specifier = match[1] ?? match[2];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function resolveRelative(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      // Try the next supported source form.
    }
  }
  return null;
}

describe("session-only entry", () => {
  test("reaches only session React, SDK, and local source", () => {
    const visited = new Set<string>();
    const thirdParty = new Set<string>();
    const queue = [sessionEntry];

    while (queue.length > 0) {
      const file = queue.pop();
      if (!file || visited.has(file)) continue;
      visited.add(file);
      for (const specifier of importSpecifiersOf(readFileSync(file, "utf8"))) {
        const local = resolveRelative(specifier, file);
        if (local) queue.push(local);
        else thirdParty.add(specifier);
      }
    }

    expect(visited.has(join(packageRoot, "src/timeline/index.ts"))).toBe(false);
    expect(visited.has(join(packageRoot, "src/provider.tsx"))).toBe(false);
    expect(visited.has(join(packageRoot, "src/session-context.ts"))).toBe(true);
    expect([...visited].some((file) => file.includes("/src/components/"))).toBe(false);
    expect([...visited].some((file) => file.includes("/src/commands/"))).toBe(false);
    expect([...thirdParty].sort()).toEqual(["@opengeni/sdk", "react"]);
    expect(visited.size).toBeGreaterThan(5);
  });

  test("builds from the public package subpath without the workbench graph", async () => {
    const transformed = new Set<string>();
    const result = await build({
      configFile: false,
      root: packageRoot,
      logLevel: "silent",
      plugins: [
        {
          name: "session-entry-closure",
          transform(_code, id) {
            transformed.add(id.split("?")[0] ?? id);
            return null;
          },
        },
      ],
      build: {
        write: false,
        minify: true,
        rollupOptions: {
          input: join(import.meta.dir, "fixtures/session-consumer.ts"),
          external: ["react", "react/jsx-runtime", "@opengeni/sdk"],
        },
      },
    });

    if (Array.isArray(result) || !("output" in result)) {
      throw new Error("Expected a single completed Vite build output");
    }

    const reactSources = [...transformed].filter((id) => id.includes("/packages/react/src/"));
    expect(reactSources.some((id) => id.endsWith("/src/session.ts"))).toBe(true);
    expect(reactSources.some((id) => id.endsWith("/src/timeline/index.ts"))).toBe(false);
    expect(reactSources.some((id) => id.endsWith("/src/provider.tsx"))).toBe(false);
    expect(reactSources.some((id) => id.endsWith("/src/session-context.ts"))).toBe(true);
    expect(reactSources.some((id) => id.includes("/src/components/"))).toBe(false);
    expect(reactSources.some((id) => id.includes("/src/commands/"))).toBe(false);
    expect(reactSources.length).toBeLessThanOrEqual(14);

    const chunks = result.output.filter((item) => item.type === "chunk");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.code.length ?? Number.POSITIVE_INFINITY).toBeLessThan(100_000);
    const text = chunks.map((chunk) => chunk.code).join("\n");

    expect(text).not.toContain("@uiw/react-codemirror");
    expect(text).not.toContain("@xterm/");
    expect(text).not.toContain("@novnc/novnc");
    expect(text).not.toContain("@pierre/diffs");
  });
});
