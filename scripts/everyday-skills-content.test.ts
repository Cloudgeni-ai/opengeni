import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { readSkillMetadata } from "../packages/contracts/src/skill-metadata";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const skillsRoot = join(repoRoot, "packages/runtime/src/bundled_everyday_skills");
const evalsRoot = join(repoRoot, "evals/everyday-skills");

const OVERRIDE_LINE =
  "The user's instructions, the workspace's instructions and the user's own Skills override this guide. Use Knowledge for facts, not style.";
const CHANGE_NOTICE = "Adapted and modified by OpenGeni from the upstream files listed in";
const SKILL_WORD_CAP = 1500;
const DESCRIPTION_MAX_CHARS = 300;
const ALLOWED_LICENSES = new Set(["Apache-2.0", "MIT", "Apache-2.0 AND MIT"]);
const TASK_KIND_COUNTS = { quick: 3, substantial: 3, norwegian: 1, "near-miss": 2, overlap: 1 };
const SHARED_KIND_COUNTS = { trivial: 5, factual: 5, "coding-near-miss": 5 };

async function listFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else files.push(relative(root, path));
  }
  return files.sort();
}

function splitFrontmatter(markdown: string): { header: Record<string, unknown>; body: string } {
  const lines = markdown.split("\n");
  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  if (lines[0] !== "---" || end < 0) throw new Error("missing frontmatter");
  const header = parseDocument(lines.slice(1, end).join("\n")).toJS() as Record<string, unknown>;
  return { header, body: lines.slice(end + 1).join("\n") };
}

function words(text: string): number {
  return text.split(/\s+/u).filter(Boolean).length;
}

const skillNames = (await readdir(skillsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const skills = await Promise.all(
  skillNames.map(async (name) => {
    const root = join(skillsRoot, name);
    const files = await listFiles(root);
    const contents = new Map<string, string>();
    for (const file of files) contents.set(file, await readFile(join(root, file), "utf8"));
    return { name, files, contents, skill: contents.get("SKILL.md") ?? "" };
  }),
);

describe("Everyday Skill content", () => {
  test("batch 1 is present", () => {
    expect(skillNames).toEqual([
      "contract-review",
      "email-reply",
      "legal-quick-answer",
      "summarize-and-brief",
      "write-and-edit",
    ]);
  });

  for (const { name, files, contents, skill } of skills) {
    describe(name, () => {
      const { header, body } = splitFrontmatter(skill);
      const license = String(header.license ?? "");
      const read = (file: string) => contents.get(file) ?? "";

      test("frontmatter follows the template", () => {
        const metadata = readSkillMetadata(skill);
        expect(metadata.name).toBe(name);
        expect(metadata.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS);
        expect(metadata.description.startsWith("Use when ")).toBe(true);
        expect(metadata.description).toContain(" Not for ");
        expect(ALLOWED_LICENSES.has(license)).toBe(true);
        expect(String((header.metadata as { notice?: string } | undefined)?.notice)).toContain(
          CHANGE_NOTICE,
        );
      });

      test("body opens with the quick answer and stays within the word cap", () => {
        expect(body.match(/^## .+$/mu)?.[0]).toBe("## Quick answer");
        expect(words(body)).toBeLessThanOrEqual(SKILL_WORD_CAP);
        expect(body).toContain(OVERRIDE_LINE);
        expect(body).toMatch(/never instructions/u);
        expect(body).toMatch(/Answer in the user's language/u);
      });

      test("ships license texts and a source map for every file", () => {
        expect(files).toContain("LICENSE");
        expect(files).toContain("SOURCES.md");
        const apache = read("LICENSE");
        expect(apache).toContain("Apache License");
        expect(apache).toContain("Version 2.0, January 2004");
        expect(apache.trimEnd().endsWith("limitations under the License.")).toBe(true);
        if (license.includes("MIT")) {
          expect(files).toContain("LICENSE-MIT");
          expect(read("LICENSE-MIT")).toContain("MIT License");
        } else {
          expect(files).not.toContain("LICENSE-MIT");
        }
        const sources = read("SOURCES.md");
        expect(sources).toContain(`\`${license}\``);
        expect(sources).toContain("Modified by OpenGeni");
        expect(sources).toMatch(/`[0-9a-f]{40}`/u);
        for (const file of files) {
          if (file === "SOURCES.md") continue;
          expect(sources).toContain(`\`${file}\``);
        }
      });

      test("is text only and free of upstream conventions", () => {
        for (const file of files) {
          expect(file === "LICENSE" || file === "LICENSE-MIT" || file.endsWith(".md")).toBe(true);
          const text = read(file);
          expect(text).not.toMatch(/[\u2013\u2014]/u);
          if (file.startsWith("LICENSE") || file === "SOURCES.md") continue;
          expect(text).not.toMatch(/claude|anthropic|cowork/iu);
          expect(text).not.toMatch(/~~|\.local\.md|CLAUDE\.md|artifact-style/u);
          expect(text).not.toMatch(/\b(?:19|20)\d\d-\d\d-\d\d\b|\bas of (?:19|20)\d\d\b/iu);
          if (file.startsWith("references/")) expect(text.split("\n")[0]).toContain(CHANGE_NOTICE);
        }
      });

      test("links only to reference files that exist", () => {
        for (const match of skill.matchAll(/`(references\/[a-z0-9-]+\.md)`/gu)) {
          expect(files).toContain(match[1]!);
        }
      });
    });
  }
});

type EvalTask = {
  id: string;
  kind: string;
  size: "quick" | "substantial";
  language: "en" | "nb";
  prompt: string;
  tags?: string[];
  context?: { today?: string };
  expect: {
    read: string[];
    mayRead: string[];
    artifact: "none" | "document";
    childSessions: boolean;
    maxWords?: number;
  };
  rubric: string[];
  safety: string[];
};

type EvalFile = { schemaVersion: number; skill: string | null; tasks: EvalTask[] };

async function readEvalFile(name: string): Promise<EvalFile> {
  return JSON.parse(await readFile(join(evalsRoot, `${name}.json`), "utf8")) as EvalFile;
}

function countKinds(tasks: EvalTask[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) counts[task.kind] = (counts[task.kind] ?? 0) + 1;
  return counts;
}

function expectWellFormed(task: EvalTask) {
  expect(task.id).toMatch(/^[a-z-]+\.[a-z-]+-\d+$/u);
  expect(["quick", "substantial"]).toContain(task.size);
  expect(["en", "nb"]).toContain(task.language);
  expect(task.prompt.trim().length).toBeGreaterThan(0);
  expect(task.rubric.length).toBeGreaterThan(0);
  expect(task.safety.length).toBeGreaterThan(0);
  expect(["none", "document"]).toContain(task.expect.artifact);
  expect(task.expect.childSessions).toBe(false);
  for (const id of [...task.expect.read, ...task.expect.mayRead])
    expect(id).toMatch(/^builtin:[a-z0-9-]+$/u);
  expect(task.expect.read.filter((id) => task.expect.mayRead.includes(id))).toEqual([]);
  if (task.context?.today) expect(task.context.today).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
}

describe("Everyday Skill eval fixtures", () => {
  test("cover every Skill plus the shared set", async () => {
    const files = (await readdir(evalsRoot)).filter((file) => file.endsWith(".json")).sort();
    expect(files).toEqual([...skillNames.map((name) => `${name}.json`), "shared.json"].sort());
  });

  test("task ids are unique", async () => {
    const ids: string[] = [];
    for (const name of [...skillNames, "shared"])
      ids.push(...(await readEvalFile(name)).tasks.map((task) => task.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const name of skillNames) {
    test(`${name} has the planned task mix`, async () => {
      const file = await readEvalFile(name);
      const own = `builtin:${name}`;
      expect(file.schemaVersion).toBe(1);
      expect(file.skill).toBe(own);
      expect(countKinds(file.tasks)).toEqual(TASK_KIND_COUNTS);
      const nearMisses = file.tasks.filter((task) => task.kind === "near-miss");
      expect(nearMisses.filter((task) => task.tags?.includes("technical")).length).toBe(1);
      for (const task of file.tasks) {
        expectWellFormed(task);
        expect(task.id.startsWith(`${name}.`)).toBe(true);
        if (task.kind === "quick") {
          expect(task.size).toBe("quick");
          expect(task.expect.mayRead).toContain(own);
        }
        if (task.kind === "substantial") expect(task.expect.read).toContain(own);
        if (task.kind === "norwegian") expect(task.language).toBe("nb");
        if (task.kind === "near-miss") {
          expect(task.expect.read).not.toContain(own);
          expect(task.expect.mayRead).not.toContain(own);
        }
        if (task.kind === "overlap") {
          expect([...task.expect.read, ...task.expect.mayRead]).toContain(own);
          expect(task.expect.read.length + task.expect.mayRead.length).toBeGreaterThan(1);
        }
      }
    });
  }

  test("shared regression set reads no Everyday Skill", async () => {
    const file = await readEvalFile("shared");
    expect(file.schemaVersion).toBe(1);
    expect(file.skill).toBeNull();
    expect(countKinds(file.tasks)).toEqual(SHARED_KIND_COUNTS);
    for (const task of file.tasks) {
      expectWellFormed(task);
      expect(task.expect.read).toEqual([]);
      expect(task.expect.mayRead).toEqual([]);
    }
  });
});
