import { afterEach, describe, expect, test } from "bun:test";
import {
  deploymentDepthPolicy,
  preinstalledVectorPolicy,
  type MigrationRuntimeOptions,
} from "../src/migrate";

// The command-line runner always passes its phase options, never these fields.
const cliOptions: MigrationRuntimeOptions = { phase: "post", onPhaseComplete: () => {} };
const saved = {
  vector: process.env.OPENGENI_MIGRATIONS_PREINSTALLED_VECTOR,
  depth: process.env.OPENGENI_MAX_NESTED_AGENT_DEPTH,
};

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("OPENGENI_MIGRATIONS_PREINSTALLED_VECTOR", saved.vector);
  restore("OPENGENI_MAX_NESTED_AGENT_DEPTH", saved.depth);
});

describe("preinstalled-vector policy", () => {
  test("the command-line runner honours the deployment environment", () => {
    process.env.OPENGENI_MIGRATIONS_PREINSTALLED_VECTOR = "true";
    expect(preinstalledVectorPolicy(cliOptions)).toBe(true);
    expect(preinstalledVectorPolicy(undefined)).toBe(true);
  });

  test("an explicit option wins over the environment", () => {
    process.env.OPENGENI_MIGRATIONS_PREINSTALLED_VECTOR = "true";
    expect(preinstalledVectorPolicy({ ...cliOptions, preinstalledVector: false })).toBe(false);
    process.env.OPENGENI_MIGRATIONS_PREINSTALLED_VECTOR = "false";
    expect(preinstalledVectorPolicy({ ...cliOptions, preinstalledVector: true })).toBe(true);
  });

  test("unset stays off and an invalid value is refused", () => {
    delete process.env.OPENGENI_MIGRATIONS_PREINSTALLED_VECTOR;
    expect(preinstalledVectorPolicy(cliOptions)).toBe(false);
    process.env.OPENGENI_MIGRATIONS_PREINSTALLED_VECTOR = "yes";
    expect(() => preinstalledVectorPolicy(cliOptions)).toThrow("must be true or false");
  });
});

describe("deployment depth policy", () => {
  test("the command-line runner honours the deployment environment", () => {
    process.env.OPENGENI_MAX_NESTED_AGENT_DEPTH = "5";
    expect(deploymentDepthPolicy(cliOptions)).toEqual({
      maxNestedAgentDepth: 5,
      source: "deployment",
    });
  });

  test("an explicit option wins and unset uses the default", () => {
    process.env.OPENGENI_MAX_NESTED_AGENT_DEPTH = "5";
    expect(deploymentDepthPolicy({ ...cliOptions, maxNestedAgentDepth: 1 })).toEqual({
      maxNestedAgentDepth: 1,
      source: "deployment",
    });
    delete process.env.OPENGENI_MAX_NESTED_AGENT_DEPTH;
    expect(deploymentDepthPolicy(cliOptions).source).toBe("default");
  });
});
