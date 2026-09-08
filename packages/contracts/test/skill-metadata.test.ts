import { expect, test } from "bun:test";
import {
  AutomationSessionTemplate,
  CapabilityPackSkill,
  SessionSkill,
  SessionSkills,
  StoredSessionSkills,
  StoredAutomationSessionTemplate,
  StoredCapabilityPack,
  PackInstallation,
} from "../src/index";

const files = [
  {
    path: "SKILL.md",
    content: "---\nname: deploy\ndescription: Run deployment checks\n---\n# Deploy",
  },
];

test("installation audit snapshots preserve historical manifests instead of admitting them again", () => {
  const historical = {
    id: "legacy-pack",
    name: "Historical Pack",
    description: "Original description",
    role: "agent",
    category: "test",
    version: "1",
    skills: [
      {
        name: "Original Name",
        description: "Original descriptor",
        files: [{ path: "SKILL.md", content: "Original headerless instructions" }],
      },
    ],
    extension: { retained: true },
  };
  const wire = {
    id: crypto.randomUUID(),
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    packId: historical.id,
    status: "disabled" as const,
    version: 1,
    manifestSnapshot: historical,
    manifestDigest: "a".repeat(64),
    selectedRigId: null,
    installedBySubjectId: "user:original",
    metadata: {},
    enabledAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  expect(PackInstallation.parse(wire)).toEqual(wire);
  expect(StoredCapabilityPack.safeParse(historical).success).toBe(false);
  const yamlManifest = { ...historical, skills: [{ ...historical.skills[0], files }] };
  expect(
    PackInstallation.parse({ ...wire, manifestSnapshot: yamlManifest }).manifestSnapshot,
  ).toEqual(yamlManifest);
  expect(StoredCapabilityPack.parse(yamlManifest).skills[0]!.description).toBe(
    "Run deployment checks",
  );
  expect(PackInstallation.safeParse({ ...wire, manifestSnapshot: [] }).success).toBe(false);
});

test("inline and Pack Skills derive metadata from files without duplicate input fields", () => {
  expect(SessionSkill.parse({ files })).toEqual({
    name: "deploy",
    description: "Run deployment checks",
    files,
  });
  expect(CapabilityPackSkill.parse({ files, activationMode: "session_selected" })).toEqual({
    name: "deploy",
    description: "Run deployment checks",
    files,
    activationMode: "session_selected",
  });
});

test("legacy metadata fields are checked rather than overriding frontmatter", () => {
  expect(
    SessionSkill.parse({ files, name: "deploy", description: "Run deployment checks" }).name,
  ).toBe("deploy");
  expect(() => SessionSkill.parse({ files, name: "other" })).toThrow("must match SKILL.md");
  expect(() => SessionSkill.parse({ files, description: "Competing summary" })).toThrow(
    "must match SKILL.md",
  );
});

test("missing frontmatter cannot enter session or Pack context through inline content", () => {
  const legacy = {
    name: "deploy",
    description: "Run deployment checks",
    files: [{ path: "SKILL.md", content: "Instructions" }],
  };
  expect(() => SessionSkill.parse(legacy)).toThrow("safe name");
  expect(() => CapabilityPackSkill.parse(legacy)).toThrow("safe name");
});

test("session deduplication compares the derived metadata and exact files", () => {
  expect(SessionSkills.parse([{ files }, { files, name: "deploy" }])).toHaveLength(1);
});

test("automation admission uses the same authoritative Skill contract as dispatch", () => {
  const template = AutomationSessionTemplate.parse({
    prompt: "Deploy safely",
    skills: [{ files }, { files, name: "deploy" }],
  });
  expect(template.skills).toEqual(SessionSkills.parse([{ files }]));
  for (const skill of [
    { name: "deploy", files: [{ path: "SKILL.md", content: "Missing frontmatter" }] },
    { files, description: "Competing summary" },
    { files: [...files, ...files] },
  ]) {
    expect(
      AutomationSessionTemplate.safeParse({ prompt: "Deploy safely", skills: [skill] }).success,
    ).toBe(false);
  }
});

test("every inline admission rejects non-text, oversized and conflicting folder content", () => {
  const invalidFiles = [
    [...files, { path: "data.bin", content: "a\u0000b" }],
    [...files, { path: "bad.txt", content: "\ud800" }],
    [...files, { path: "big.txt", content: "é".repeat(140_000) }],
    [...files, { path: "scripts", content: "file" }, { path: "scripts/run", content: "code" }],
    [...files, { path: "bad:path", content: "text" }],
    [...files, { path: "bad\ud800path", content: "text" }],
    [
      ...files,
      ...Array.from({ length: 5 }, (_, index) => ({
        path: `part-${index}`,
        content: "x".repeat(250_000),
      })),
    ],
  ];
  for (const candidate of invalidFiles) {
    expect(SessionSkill.safeParse({ files: candidate }).success).toBe(false);
    expect(CapabilityPackSkill.safeParse({ files: candidate }).success).toBe(false);
    expect(
      AutomationSessionTemplate.safeParse({ prompt: "Use Skill", skills: [{ files: candidate }] })
        .success,
    ).toBe(false);
  }
  const text = [
    ...files,
    { path: "no-extension", content: "日本語\n" },
    { path: "custom.bin", content: "\ufeffThis is text." },
  ];
  expect(SessionSkill.parse({ files: text }).files).toEqual(text);
});

test("stored metadata is derived without rewriting historical files or manifests", () => {
  const legacy = { name: "old-label", description: "Old database description", files };
  const template = { prompt: "Use the deployment Skill", skills: [legacy] };
  const manifest = {
    id: "deploy-pack",
    name: "Deployment",
    description: "Deployment workflows",
    role: "engineering",
    category: "development",
    version: "1.0.0",
    skills: [legacy],
    automationTemplates: [
      {
        id: "deploy",
        name: "Deploy",
        description: "Deploy a service",
        adapterId: "signed-json.v1",
        eventTypes: ["deploy"],
        sessionTemplate: template,
      },
    ],
  };
  const historicalBytes = JSON.stringify(manifest);
  expect(StoredSessionSkills.parse([legacy])).toEqual(SessionSkills.parse([{ files }]));
  expect(StoredAutomationSessionTemplate.parse(template).skills).toEqual(
    SessionSkills.parse([{ files }]),
  );
  const projected = StoredCapabilityPack.parse(manifest);
  expect(projected.skills[0]!.description).toBe("Run deployment checks");
  expect(projected.automationTemplates![0]!.sessionTemplate.skills[0]!.name).toBe("deploy");
  expect(JSON.stringify(manifest)).toBe(historicalBytes);
  expect(SessionSkill.safeParse(legacy).success).toBe(false);
});

test("stored projection never invents missing frontmatter or hides invalid content", () => {
  const plain = {
    name: "legacy",
    description: "Old description",
    files: [{ path: "SKILL.md", content: "No frontmatter" }],
  };
  expect(StoredSessionSkills.safeParse([plain]).success).toBe(false);
  expect(
    StoredAutomationSessionTemplate.safeParse({ prompt: "Use Skill", skills: [plain] }).success,
  ).toBe(false);
});
