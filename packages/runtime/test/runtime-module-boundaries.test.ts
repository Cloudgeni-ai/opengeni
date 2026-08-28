import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(here, "..");
const packageJson = JSON.parse(readFileSync(join(runtimeRoot, "package.json"), "utf8")) as {
  exports?: Record<string, unknown>;
};

const implementationModules = [
  "model-input",
  "model-provider",
  "model-provider-client",
  "model-provider-errors",
  "model-provider-request-policy",
  "model-provider-routing",
  "model-provider-transport",
  "run-events",
  "tool-call-identity",
] as const;

type ImplementationModule = (typeof implementationModules)[number];

function importSpecifiersOf(source: string): string[] {
  const specifiers: string[] = [];
  const re =
    /(?:import|export)\b[^;]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    specifiers.push((match[1] ?? match[2])!);
  }
  return specifiers;
}

describe("runtime implementation module boundaries", () => {
  test("package-private domains never import the public runtime facade", () => {
    for (const moduleName of implementationModules) {
      const source = readFileSync(join(runtimeRoot, "src", `${moduleName}.ts`), "utf8");
      const specifiers = importSpecifiersOf(source);

      expect(specifiers).not.toContain("./index");
      expect(specifiers).not.toContain("./index.ts");
      expect(specifiers).not.toContain("@opengeni/runtime");
    }
  });

  test("extracted domains remain private implementation details", () => {
    const publicSubpaths = Object.keys(packageJson.exports ?? {});

    for (const moduleName of implementationModules) {
      expect(publicSubpaths).not.toContain(`./${moduleName}`);
    }
  });

  test("package-private implementation modules stay acyclic", () => {
    const implementationSet = new Set<string>(implementationModules);
    const dependencies = new Map<ImplementationModule, ImplementationModule[]>();

    for (const moduleName of implementationModules) {
      const source = readFileSync(join(runtimeRoot, "src", `${moduleName}.ts`), "utf8");
      const localDependencies = importSpecifiersOf(source)
        .filter((specifier) => specifier.startsWith("./"))
        .map((specifier) => specifier.slice(2).replace(/\.ts$/, ""))
        .filter((specifier): specifier is ImplementationModule => implementationSet.has(specifier));
      dependencies.set(moduleName, localDependencies);
    }

    const visited = new Set<ImplementationModule>();
    const visiting = new Set<ImplementationModule>();
    const path: ImplementationModule[] = [];

    function visit(moduleName: ImplementationModule): void {
      if (visited.has(moduleName)) return;
      if (visiting.has(moduleName)) {
        const cycleStart = path.indexOf(moduleName);
        const cycle = [...path.slice(cycleStart), moduleName].join(" -> ");
        throw new Error(`Runtime implementation dependency cycle: ${cycle}`);
      }
      visiting.add(moduleName);
      path.push(moduleName);
      for (const dependency of dependencies.get(moduleName) ?? []) {
        visit(dependency);
      }
      path.pop();
      visiting.delete(moduleName);
      visited.add(moduleName);
    }

    for (const moduleName of implementationModules) {
      visit(moduleName);
    }
  });

  test("the public facade re-exports each domain without wrappers", async () => {
    const [barrel, modelInput, modelProvider, runEvents, toolCallIdentity] = await Promise.all([
      import("../src/index"),
      import("../src/model-input"),
      import("../src/model-provider"),
      import("../src/run-events"),
      import("../src/tool-call-identity"),
    ]);

    for (const name of [
      "callModelInputFilterForSettings",
      "contextRobustnessFilterForSettings",
      "projectModelInputForCapabilities",
    ] as const) {
      expect(barrel[name]).toBe(modelInput[name]);
    }
    for (const name of [
      "buildProviderClient",
      "modelRequestPolicyForProvider",
      "resolveTurnModel",
    ] as const) {
      expect(barrel[name]).toBe(modelProvider[name]);
    }
    for (const name of [
      "modelTerminalResponseFromSdkEvent",
      "normalizeSdkEvent",
      "serializeHumanInputRequests",
    ] as const) {
      expect(barrel[name]).toBe(runEvents[name]);
    }
    expect(barrel.toolCallIdFromSdkItem).toBe(toolCallIdentity.toolCallIdFromSdkItem);
  });
});
