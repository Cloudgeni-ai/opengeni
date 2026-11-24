import { describe, expect, test } from "bun:test";

import {
  readSkillUpload,
  readSkillUploadEntries,
  skillFilesProblem,
  SkillUploadError,
  unzipSkillArchive,
} from "../src/skills";

const encoder = new TextEncoder();
const SKILL =
  "---\nname: release-notes\ndescription: Use when writing release notes.\n---\n\nSteps.\n";

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A minimal ZIP writer for fixtures: stored or deflated entries, no CRC checks on read. */
async function zip(
  files: Array<{ path: string; content: string | Uint8Array; deflate?: boolean }>,
): Promise<Uint8Array> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of files) {
    const name = encoder.encode(entry.path);
    const raw = typeof entry.content === "string" ? encoder.encode(entry.content) : entry.content;
    const data = entry.deflate ? await deflateRaw(raw) : raw;
    const method = entry.deflate ? 8 : 0;
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directorySize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function file(path: string, content: string | Uint8Array): File & { relativePath: string } {
  return Object.assign(new File([content as BlobPart], path.split("/").at(-1)!), {
    relativePath: path,
  });
}

describe("readSkillUploadEntries", () => {
  test("a lone Markdown file is the SKILL.md, whatever it is called", async () => {
    const upload = await readSkillUploadEntries([
      { path: "skill.md", bytes: encoder.encode(SKILL) },
    ]);
    expect(upload).toEqual({
      files: [{ path: "SKILL.md", content: SKILL }],
      name: "release-notes",
      skipped: [],
    });
    const renamed = await readSkillUploadEntries([
      { path: "notes.markdown", bytes: encoder.encode(SKILL) },
    ]);
    expect(renamed.files.map((entry) => entry.path)).toEqual(["SKILL.md"]);
  });

  test("a folder's wrapping directory is dropped and junk and binaries are left out", async () => {
    const upload = await readSkillUploadEntries([
      { path: "release-notes/references/style.md", bytes: encoder.encode("Style") },
      { path: "release-notes/SKILL.md", bytes: encoder.encode(SKILL) },
      { path: "release-notes/.DS_Store", bytes: new Uint8Array([0, 1, 2]) },
      { path: "release-notes/logo.png", bytes: new Uint8Array([0x89, 0x50, 0, 0xff]) },
      { path: "README.md", bytes: encoder.encode("Outside") },
    ]);
    expect(upload.files.map((entry) => entry.path)).toEqual(["SKILL.md", "references/style.md"]);
    expect(upload.skipped).toEqual([
      "logo.png (not a text file)",
      "README.md (outside the skill folder)",
    ]);
  });

  test("an upload without a SKILL.md, or with several skills, says what to do", async () => {
    await expect(
      readSkillUploadEntries([
        { path: "a.txt", bytes: encoder.encode("a") },
        { path: "b.txt", bytes: encoder.encode("b") },
      ]),
    ).rejects.toThrow("There's no SKILL.md in this upload");
    await expect(
      readSkillUploadEntries([
        { path: "skills/one/SKILL.md", bytes: encoder.encode(SKILL) },
        { path: "skills/two/SKILL.md", bytes: encoder.encode(SKILL) },
      ]),
    ).rejects.toThrow("This upload holds 2 skills (one, two). Upload one skill at a time.");
  });

  test("a nested SKILL.md below the top one stays a supporting file", async () => {
    const upload = await readSkillUploadEntries([
      { path: "SKILL.md", bytes: encoder.encode(SKILL) },
      { path: "examples/SKILL.md", bytes: encoder.encode("Example") },
    ]);
    expect(upload.files.map((entry) => entry.path)).toEqual(["SKILL.md", "examples/SKILL.md"]);
  });
});

describe("zip uploads", () => {
  test("stored and deflated entries expand into the skill folder", async () => {
    const archive = await zip([
      { path: "release-notes/", content: "" },
      { path: "release-notes/SKILL.md", content: SKILL, deflate: true },
      { path: "release-notes/references/style.md", content: "Style ".repeat(200), deflate: true },
      { path: "__MACOSX/release-notes/._SKILL.md", content: "junk" },
    ]);
    const upload = await readSkillUpload([file("release-notes.zip", archive)]);
    expect(upload.name).toBe("release-notes");
    expect(upload.files).toEqual([
      { path: "SKILL.md", content: SKILL },
      { path: "references/style.md", content: "Style ".repeat(200) },
    ]);
  });

  test("a damaged or encrypted archive fails with a plain sentence", async () => {
    await expect(unzipSkillArchive(encoder.encode("not a zip at all"))).rejects.toBeInstanceOf(
      SkillUploadError,
    );
    const archive = await zip([{ path: "SKILL.md", content: SKILL }]);
    new DataView(archive.buffer).setUint16(30 + 8 + 0, 0, true);
    const central = archive.length - 22 - (46 + "SKILL.md".length);
    new DataView(archive.buffer).setUint16(central + 8, 1, true);
    await expect(unzipSkillArchive(archive)).rejects.toThrow("password-protected");
  });

  test("a zip with other files is refused", async () => {
    const archive = await zip([{ path: "SKILL.md", content: SKILL }]);
    await expect(readSkillUpload([file("a.zip", archive), file("notes.md", "x")])).rejects.toThrow(
      "Upload one .zip file on its own",
    );
  });
});

describe("skillFilesProblem", () => {
  const withSkill = (content: string) => [{ path: "SKILL.md", content }];
  test("names what to fix in the SKILL.md header", () => {
    expect(skillFilesProblem(withSkill(SKILL))).toBeNull();
    expect(skillFilesProblem(withSkill("Just text"))).toContain("Start SKILL.md with a header");
    expect(skillFilesProblem(withSkill("---\ndescription: Use it\n---\n"))).toContain("Add a name");
    expect(
      skillFilesProblem(withSkill("---\nname: Release Notes\ndescription: x\n---\n")),
    ).toContain('The name "Release Notes" can only use lowercase letters');
    expect(skillFilesProblem(withSkill("---\nname: notes\n---\n"))).toContain("Add a description");
    expect(skillFilesProblem(withSkill("---\nname: [a\n---\n"))).toContain("isn't valid YAML");
    expect(skillFilesProblem([])).toBe("A skill needs a SKILL.md file.");
  });
  test("rejects unsafe paths and duplicate files", () => {
    expect(
      skillFilesProblem([...withSkill(SKILL), { path: "../outside.md", content: "x" }]),
    ).toContain("isn't a file name a skill can use");
    expect(
      skillFilesProblem([
        ...withSkill(SKILL),
        { path: "a.md", content: "x" },
        { path: "a.md", content: "y" },
      ]),
    ).toBe("Two files have the same name. Rename one of them.");
  });
});
