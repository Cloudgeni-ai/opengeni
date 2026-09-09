import { describe, expect, test } from "bun:test";
import { convertLegacyConfigSkills, convertLegacyPackConfig } from "../src/skill-config-migration";
import { PROTECTED_NO_DIRECT_DML_TABLES, RUNTIME_TABLE_PRIVILEGES } from "../src/runtime-posture";

const plain = {
  name: "Legacy Name",
  description: "Historical description",
  files: [
    { path: "SKILL.md", content: "Body  \r\n" },
    { path: "support/data.txt", content: "unchanged\r\n" },
  ],
};
describe("stored Skill configuration maintenance", () => {
  test("keeps archived private configuration inaccessible to the runtime role", () => {
    expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain("skill_config_conversion_receipts");
    expect(RUNTIME_TABLE_PRIVILEGES.skill_config_conversion_receipts).toBeUndefined();
  });
  test("preserves complete body, supporting files, extension fields and stable identity", () => {
    const value = [{ ...plain, custom: { retained: true } }];
    const converted = convertLegacyConfigSkills(value, "session:stable") as typeof value;
    expect(converted[0]!.files[0]!.content).toBe(
      '---\nname: "legacy-name"\ndescription: "Historical description"\n---\nBody  \r\n',
    );
    expect(converted[0]!.files[1]).toEqual(plain.files[1]);
    expect(converted[0]!.custom).toEqual({ retained: true });
    expect(value[0]!.files[0]!.content).toBe("Body  \r\n");
    expect(convertLegacyConfigSkills(converted, "session:stable")).toEqual(converted);
  });
  test("valid YAML and even stale cached descriptors remain exactly unchanged", () => {
    const value = [
      {
        ...plain,
        files: [
          {
            path: "SKILL.md",
            content:
              "---\r\nname: canonical\r\ndescription: |-\r\n  Exact description\r\n---\r\nBody\r\n",
          },
        ],
      },
    ];
    expect(convertLegacyConfigSkills(value, "stable")).toEqual(value);
  });
  test("rejects malformed headers, absent metadata, canonical collisions and size overflow", () => {
    expect(() =>
      convertLegacyConfigSkills(
        [{ ...plain, files: [{ path: "SKILL.md", content: "---\nname: [\n---\nbody" }] }],
        "id",
      ),
    ).toThrow();
    expect(() => convertLegacyConfigSkills([{ files: plain.files }], "id")).toThrow(
      "historical name and description",
    );
    expect(() =>
      convertLegacyConfigSkills([plain, { ...plain, name: "legacy-name" }], "id"),
    ).toThrow("collision");
    expect(() =>
      convertLegacyConfigSkills(
        [{ ...plain, files: [{ path: "SKILL.md", content: "x".repeat(256 * 1024) }] }],
        "id",
      ),
    ).toThrow("exceeds");
    expect(() => convertLegacyConfigSkills([{ ...plain, description: "" }], "id")).toThrow();
  });
  test("changes only known Pack execution fields and retains unparsed audit metadata", () => {
    const pack = {
      id: "legacy-pack",
      name: "Legacy",
      description: "Legacy pack",
      role: "agent",
      category: "test",
      version: "1",
      skills: [plain],
      metadata: { historical: { skills: [plain] } },
    };
    const converted = convertLegacyPackConfig(pack, "pack-id");
    expect(converted.metadata).toEqual(pack.metadata);
    expect(converted.skills).not.toEqual(pack.skills);
    expect(convertLegacyPackConfig(converted, "pack-id")).toEqual(converted);
  });
});
