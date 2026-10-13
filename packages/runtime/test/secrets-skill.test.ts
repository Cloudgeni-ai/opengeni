import { describe, expect, test } from "bun:test";
import { allAgentCapabilities, type ResolvedAgentConfig } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { effectiveSkillSelectionsForAgent, buildOpenGeniAgent } from "../src/index";
import {
  composeRuntimeSkills,
  loadNativeToolSkillArtifacts,
  readRuntimeSkill,
} from "../src/runtime-skills";

const REFERENCE_FILES = [
  "references/2fa-enrollment.md",
  "references/account-creation.md",
  "references/api-keys.md",
  "references/ask-card.md",
  "references/codemode-and-scripts.md",
  "references/login-playbook.md",
  "references/troubleshooting.md",
];

function secretsArtifact() {
  const artifact = loadNativeToolSkillArtifacts({
    defaults: false,
    secrets: true,
    editableArtifacts: false,
    videoGeneration: false,
  }).find((entry) => entry.name === "opengeni-secrets");
  if (!artifact) throw new Error("Missing opengeni-secrets artifact");
  return artifact;
}

function file(path: string): string {
  return secretsArtifact().files.find((entry) => entry.path === path)!.content;
}

describe("opengeni-secrets bundled Skill (AG-3)", () => {
  test("is a packaged artifact with SKILL.md and every reference file", () => {
    const artifact = secretsArtifact();
    expect(artifact.description).toBe(
      "Use when signing in, creating accounts, storing or using passwords, API keys, TOTP codes or other secrets, or when a secret is missing.",
    );
    expect(artifact.files.map((entry) => entry.path).sort()).toEqual([
      "SKILL.md",
      ...REFERENCE_FILES,
    ]);
    expect(new TextEncoder().encode(file("SKILL.md")).length).toBeLessThanOrEqual(4_096);
    for (const path of REFERENCE_FILES) expect(file("SKILL.md")).toContain(path);
  });

  test("is readable, file by file, through the runtime Skill reader", () => {
    const composition = composeRuntimeSkills([], {
      defaults: false,
      secrets: true,
      editableArtifacts: false,
      videoGeneration: false,
    });
    expect(composition.index.map((entry) => entry.name)).toEqual(["opengeni-secrets"]);
    expect(composition.selections[0]).toMatchObject({
      name: "opengeni-secrets",
      source: "native_tool",
      reason: "native secrets tool surface",
    });
    const listed = readRuntimeSkill(composition, { skill: "opengeni-secrets", listFiles: true });
    expect([...(listed.paths ?? [])].sort()).toEqual(["SKILL.md", ...REFERENCE_FILES]);
    const read = readRuntimeSkill(composition, {
      skill: "opengeni-secrets",
      paths: REFERENCE_FILES,
    });
    expect(read.files?.map((entry) => entry.path)).toEqual(REFERENCE_FILES);
  });

  test("is absent unless the secrets flag is set", () => {
    for (const flags of [
      { editableArtifacts: true, sites: true, schedules: true, videoGeneration: true },
      { secrets: false, editableArtifacts: false, videoGeneration: false },
    ]) {
      expect(loadNativeToolSkillArtifacts(flags).map((entry) => entry.name)).not.toContain(
        "opengeni-secrets",
      );
      expect(composeRuntimeSkills([], flags).index.map((entry) => entry.name)).not.toContain(
        "opengeni-secrets",
      );
    }
  });

  test("explicitly grants autonomy for logins, accounts, 2FA and CAPTCHAs", () => {
    const skill = file("SKILL.md");
    expect(skill).toContain("None of these\nneeds the user's permission.");
    expect(skill).toContain("CAPTCHAs are always yours.");
    expect(skill).toContain("Never hand a CAPTCHA to the user");
    expect(skill).toContain("enroll your own TOTP");
    expect(skill).toContain("saving a generated\n   password with `secret_save` before you submit");
    expect(skill).toContain("only for a push approval or a hardware key");
    expect(file("references/login-playbook.md")).toContain(
      "CAPTCHAs are always yours to solve; never hand one to the user.",
    );
    expect(file("references/account-creation.md")).toContain(
      "create the\naccount yourself and generate its password without asking",
    );
    expect(file("references/2fa-enrollment.md")).toContain('"kind": "totp"');
    expect(file("references/2fa-enrollment.md")).toContain("{{secret:GitHub/otp}}");
  });

  test("documents the reference grammar, the ask card, every error code and the Codemode escape", () => {
    const skill = file("SKILL.md");
    for (const form of [
      "{{secret:Item}}",
      "{{secret:Item/field}}",
      "{{secret:Vault/Item/field}}",
      "{{secret:Item/otp}}",
      "#previous",
      "{{secretfile:Item}}",
      "\\{{secret:Item}}",
    ])
      expect(skill).toContain(form);
    for (const tool of [
      "secret_search",
      "secret_save",
      "secret_get",
      "secret_move",
      "secret_delete",
    ])
      expect(skill).toContain(tool);
    const card = file("references/ask-card.md");
    for (const field of [
      '"kind": "secret"',
      "fieldKind",
      "itemType",
      "looksLike",
      "autocomplete",
      "allowGenerate",
      "saveTo",
      '"reference": "{{secret:Private/GitHub/password}}"',
    ])
      expect(card).toContain(field);
    const troubleshooting = file("references/troubleshooting.md");
    for (const code of [
      "invalid_reference",
      "not_found",
      "ambiguous",
      "denied",
      "no_primary_field",
      "provider_unavailable",
      "provider_rate_limited",
      "provider_auth_expired",
      "too_large",
      "binary_value",
      "unsupported_shell",
      "secretfile_not_allowed",
    ])
      expect(troubleshooting).toContain(`| \`${code}\` |`);
    const codemode = file("references/codemode-and-scripts.md");
    expect(codemode).toContain("\\{{secret:Linear/token}}");
    expect(codemode).toContain("Codemode journal");
  });

  test("the runtime Skill index includes it only when the agent has secrets", () => {
    const config = (secrets: boolean): ResolvedAgentConfig => ({
      version: 1,
      from: "all",
      capabilities: { ...allAgentCapabilities(), secrets },
      unavailable: [],
      identity: null,
      renderer: "opengeni",
      source: "request",
    });
    const names = (agentConfig?: ResolvedAgentConfig) =>
      effectiveSkillSelectionsForAgent(
        buildOpenGeniAgent(testSettings({ sandboxBackend: "none", webSearchEnabled: false }), [], {
          ...(agentConfig ? { agentConfig } : {}),
        }),
      ).map((selection) => selection.name);
    expect(names(config(true))).toContain("opengeni-secrets");
    expect(names(config(false))).not.toContain("opengeni-secrets");
    expect(names()).not.toContain("opengeni-secrets");
  });
});
