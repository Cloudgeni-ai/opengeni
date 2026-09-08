import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EDITABLE_ARTIFACT_MCP_CODEMODE_PATHS } from "@opengeni/contracts";
import {
  ARTIFACT_SKILL_NAMES,
  SITE_SKILL_NAMES,
  VIDEO_SKILL_NAMES,
  checkArtifactSkillBundle,
} from "./sync-artifact-skills";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMMAND_KINDS_BY_SKILL = {
  "opengeni-documents": [
    "document.flags.set",
    "paragraph.add",
    "paragraph.edit",
    "paragraph.format",
    "paragraph.style.set",
    "table.add",
    "table.style.set",
    "page-break.add",
    "section.add",
    "section.title-page.set",
    "section.page.set",
    "comment.add",
    "comment.reply.add",
    "comment.resolved.set",
    "tracked-change.add",
  ],
  "opengeni-spreadsheets": [
    "sheet.create",
    "sheet.rename",
    "sheet.delete",
    "cells.set",
    "range.clear",
  ],
  "opengeni-presentations": [
    "master.create",
    "layout.create",
    "slide.create",
    "master.delete",
    "layout.delete",
    "slide.delete",
    "slide.title.set",
    "slide.layout.set",
    "slide.notes.set",
    "node.insert",
    "node.delete",
    "node.move",
    "node.bounds.set",
    "node.transform.set",
    "node.content.set",
    "presentation.size.set",
  ],
} as const satisfies Record<(typeof ARTIFACT_SKILL_NAMES)[number], readonly string[]>;

describe("bundled editable-artifact skills", () => {
  test("are a deterministic copy of the repo agent skills", async () => {
    await expect(checkArtifactSkillBundle()).resolves.toBeUndefined();
  });

  test("teach the canonical durable artifact surface and only explicit file boundaries", async () => {
    for (const name of ARTIFACT_SKILL_NAMES) {
      const root = join(repoRoot, ".agents", "skills", name);
      const skill = await readFile(join(root, "SKILL.md"), "utf8");
      const api = await readFile(join(root, "references", "api.md"), "utf8");
      expect(skill).toStartWith("---\nname:");
      expect(skill).toContain("description:");
      expect(skill).toContain("opengeni__editable_artifact_list");
      expect(skill).toContain("opengeni__editable_artifact_apply");
      expect(api).toContain("opengeni__editable_artifact_export_status");
      expect(skill).toContain("Artifacts dock");
      expect(api).toContain('from "@opengeni/codemode"');
      expect(api).toContain("$OPENGENI_ARTIFACT_TOOL_ENTRY");
      for (const commandKind of COMMAND_KINDS_BY_SKILL[name]) {
        expect(api).toContain(`\`${commandKind}\``);
      }
      for (const toolName of Object.keys(EDITABLE_ARTIFACT_MCP_CODEMODE_PATHS)) {
        expect(api).toContain(`opengeni__${toolName}`);
      }
      expect(api).toContain("openGeni.artifacts.use(");
      expect(api).toContain("Do not export and re-import to continue editing.");
      expect(api).toContain("expectedHeadSequence");
      expect(api).toContain("expectedStateHash");
      expect(api).toContain("pass the query below as\n`request`");
      expect(`${skill}\n${api}`).not.toContain("publish_editable_artifact");
      expect(api).not.toMatch(/from ["']@opengeni\/artifact-tool/u);
      expect(api).not.toContain("@opengeni/artifact-tool@latest");
    }
  });

  test("keeps video guidance provider-neutral and independent from Office runtime", async () => {
    for (const name of VIDEO_SKILL_NAMES) {
      const skill = await readFile(join(repoRoot, ".agents", "skills", name, "SKILL.md"), "utf8");
      expect(skill).toStartWith("---\nname:");
      expect(skill).toContain("get_video_generation_capabilities");
      expect(skill).toContain("generate_video");
      expect(skill).not.toContain("Seedance");
      expect(skill).not.toContain("apiKey");
      expect(skill).not.toContain("opengeni-artifact-runtime");
    }
  });

  test("teaches Sites as approval-free exact-version tool clients", async () => {
    for (const name of SITE_SKILL_NAMES) {
      const skill = await readFile(join(repoRoot, ".agents", "skills", name, "SKILL.md"), "utf8");
      expect(skill).toStartWith("---\nname:");
      expect(skill).toContain('from "@opengeni/sdk/site"');
      expect(skill).toContain("opengeni__artifacts_create");
      expect(skill).toContain("opengeni__artifacts_get_source");
      expect(skill).toContain("opengeni__artifacts_publish");
      expect(skill).toContain("do not open\n   per-call approval dialogs");
      expect(skill).toContain("viewer's\n   live workspace, permission, and connection authority");
      expect(skill).not.toContain("declined approvals");
      expect(skill).not.toContain("one-shot approval dialog");
    }
  });
});
