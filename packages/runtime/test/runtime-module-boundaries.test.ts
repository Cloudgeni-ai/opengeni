import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(here, "..");
const packageJson = JSON.parse(readFileSync(join(runtimeRoot, "package.json"), "utf8")) as {
  exports?: Record<string, unknown>;
};

const implementationModules = ["model-input", "model-provider", "run-events"] as const;

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

  test("the public facade re-exports each domain without wrappers", async () => {
    const [barrel, modelInput, modelProvider, runEvents] = await Promise.all([
      import("../src/index"),
      import("../src/model-input"),
      import("../src/model-provider"),
      import("../src/run-events"),
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
  });
});
