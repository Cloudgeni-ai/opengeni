import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { z } from "zod";
import { cachedJsonSchemaConversion } from "../src/interaction-tool-json-schema";
import { createInteractionAttemptToolDefinitions } from "../src/interaction-tools";
import { loadNativeToolSkillArtifacts } from "../src/runtime-skills";

const allNativeSkills = {
  projects: true,
  schedules: true,
  editableArtifacts: true,
  sites: true,
  secrets: true,
  videoGeneration: true,
};

test("packaged Skills are read once and every caller gets its own list", () => {
  const first = loadNativeToolSkillArtifacts(allNativeSkills);
  const reads = spyOn(fs, "readdirSync");
  let second: ReturnType<typeof loadNativeToolSkillArtifacts>;
  try {
    second = loadNativeToolSkillArtifacts(allNativeSkills);
    // The second load reads no Skill directory.
    expect(reads).not.toHaveBeenCalled();
  } finally {
    reads.mockRestore();
  }
  expect(second).not.toBe(first);
  expect(second).toEqual(first);
  (first as unknown[]).length = 0;
  expect(loadNativeToolSkillArtifacts(allNativeSkills)).toEqual(second);
  expect(Object.isFrozen(second[0])).toBe(true);
});

test("the Sites package versions follow the environment", () => {
  const sitesVersions = () =>
    loadNativeToolSkillArtifacts({ sites: true })
      .find((artifact) => artifact.name === "sites")
      ?.files.find((file) => file.path === "package-versions.json")?.content;
  const previous = process.env.OPENGENI_SITE_PACKAGE_VERSIONS;
  const pinned = {
    "@opengeni/sdk": "9.9.9-canary.1",
    "@opengeni/react": "9.9.9-canary.1",
    "@opengeni/codemode": "9.9.9-canary.1",
    "@opengeni/ogtool": "9.9.9-canary.1",
  };
  try {
    delete process.env.OPENGENI_SITE_PACKAGE_VERSIONS;
    const defaults = sitesVersions();
    process.env.OPENGENI_SITE_PACKAGE_VERSIONS = JSON.stringify(pinned);
    // A new key misses the cache and reads the directory again (this also
    // shows the read spy in the test above observes the loader's reads).
    const reads = spyOn(fs, "readdirSync");
    try {
      expect(JSON.parse(sitesVersions()!)).toEqual(pinned);
      expect(reads).toHaveBeenCalled();
    } finally {
      reads.mockRestore();
    }
    delete process.env.OPENGENI_SITE_PACKAGE_VERSIONS;
    expect(sitesVersions()).toBe(defaults);
  } finally {
    if (previous === undefined) delete process.env.OPENGENI_SITE_PACKAGE_VERSIONS;
    else process.env.OPENGENI_SITE_PACKAGE_VERSIONS = previous;
  }
});

test("interaction tool schemas are converted once and every attempt gets its own copy", () => {
  const transport = new Proxy({}, { get: () => async () => ({}) }) as never;
  const definitions = () =>
    createInteractionAttemptToolDefinitions({
      transport,
      workspaceId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      permissions: ["workspace:admin"],
    });
  const first = definitions();
  const second = definitions();
  expect(second.length).toBeGreaterThan(0);
  const schemas = (tools: typeof first) =>
    tools.map((tool) => [tool.modelName, tool.inputSchema, tool.outputSchema]);
  expect(schemas(second)).toEqual(schemas(first));
  for (const [index, tool] of first.entries()) {
    // Desktop (CUA) tools build their schemas separately.
    if (tool.modelName.startsWith("interaction__cua_")) continue;
    expect(second[index]!.inputSchema).not.toBe(tool.inputSchema);
    expect(second[index]!.outputSchema).not.toBe(tool.outputSchema);
  }
  const before = structuredClone(second[0]!.inputSchema);
  (first[0]!.inputSchema as Record<string, unknown>).description = "changed by one attempt";
  expect(definitions()[0]!.inputSchema).toEqual(before);
});

test("a cached conversion runs once per schema and equals a fresh conversion", () => {
  let converted = 0;
  const convert = (schema: z.ZodType) => {
    converted++;
    return z.toJSONSchema(schema, { target: "draft-2020-12" }) as never;
  };
  const cached = cachedJsonSchemaConversion(convert);
  const schema = z.object({ id: z.string(), tags: z.array(z.enum(["a", "b"])) });
  const first = cached(schema);
  const second = cached(schema);
  expect(converted).toBe(1);
  expect(second).toEqual(z.toJSONSchema(schema, { target: "draft-2020-12" }) as never);
  expect(second).not.toBe(first);
  (first as Record<string, unknown>).description = "changed by one caller";
  expect(cached(schema)).toEqual(second);
  cached(z.object({ id: z.string() }));
  expect(converted).toBe(2);
});
