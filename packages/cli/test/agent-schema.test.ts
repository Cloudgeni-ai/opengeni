import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ORG_AGENT_FILE_JSON_SCHEMA_URL,
  orgAgentFileJsonSchema,
} from "@opengeni/contracts/organization-agents";
import { parse } from "yaml";

const committedPath = join(import.meta.dir, "..", "schemas", "agent.schema.json");

describe("agent file JSON Schema", () => {
  test("the committed schema matches the OrgAgentFile contract", () => {
    // Regenerate with: bun scripts/generate-agent-file-schema.ts
    expect(readFileSync(committedPath, "utf8")).toBe(
      `${JSON.stringify(orgAgentFileJsonSchema(), null, 2)}\n`,
    );
  });

  test("describes the agent file format", () => {
    const schema = JSON.parse(readFileSync(committedPath, "utf8")) as {
      $id: string;
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(schema.$id).toBe(ORG_AGENT_FILE_JSON_SCHEMA_URL);
    expect(schema.required.sort()).toEqual(["key", "name"]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(
      [
        "capabilities",
        "description",
        "identity",
        "instructions",
        "key",
        "model",
        "name",
        "reasoningEffort",
        "renderer",
        "titleInstructions",
        "toolServers",
        "workers",
      ].sort(),
    );
  });

  test("the example agent file uses the published schema URL", () => {
    const text = readFileSync(join(import.meta.dir, "fixtures", "agents", "support.yaml"), "utf8");
    expect(text.split("\n")[0]).toBe(
      `# yaml-language-server: $schema=${ORG_AGENT_FILE_JSON_SCHEMA_URL}`,
    );
    expect(parse(text).key).toBe("support");
  });
});
