import { expect, test } from "bun:test";
import { loadNativeToolSkillArtifacts } from "../src/runtime-skills";

test("packaged Documents Skill carries the direct and secondary report delivery gate", async () => {
  const source = await Bun.file(
    new URL("../src/bundled_artifact_skills/documents/SKILL.md", import.meta.url),
  ).text();
  const artifact = loadNativeToolSkillArtifacts({
    projects: false,
    editableArtifacts: true,
    videoGeneration: false,
  }).find((entry) => entry.name === "documents");
  expect(artifact).toBeDefined();
  expect(artifact?.files.find((file) => file.path === "SKILL.md")?.content).toBe(source);
  const prose = source.replace(/\s+/g, " ");
  expect(prose).toContain(
    "Create a document when the user asks for a document, asks to edit an existing document artifact, or when a deliverable is too long to read comfortably in chat (several pages); otherwise answer in chat, including briefs, letters, plans and reports written on request.",
  );
  expect(prose).toContain("the file itself is the deliverable");
  expect(prose).toContain("so do not load artifact tools just to check");
  expect(prose).toContain("only if an import fails");
  expect(prose).toContain("Do not create a goal only to declare a document.");
  expect(prose).toContain("a short summary and the artifact link, not a restatement");
  expect(prose).not.toContain("create one with the report requirement");
  expect(source).toContain("a report is a secondary output");
  expect(source).toContain("a Knowledge cleanup audit");
  expect(source).toContain("before authoring");
  expect(source).toContain(
    "append the report\nrequirement without replacing the standing objective",
  );
  expect(source).toContain("server-verified artifact delivery");
  expect(source).toContain(
    "Relevant structure and review annotations were inspected after the final edit",
  );
  expect(source).toContain("Include the returned artifact reference in the handoff");
  expect(source).toContain("unfinished requirement and state the concrete blocker");
  expect(source).toContain("internal worker findings");
  expect(source).toContain("explicitly requested local-file");
});

test("Office file Skills claim preinstalled only the Python packages the managed images install", async () => {
  const dockerfiles = await Promise.all(
    ["sandbox.Dockerfile", "desktop.Dockerfile"].map((dockerfile) =>
      Bun.file(new URL(`../../../docker/${dockerfile}`, import.meta.url)).text(),
    ),
  );
  const images = dockerfiles.map((text) => {
    const list = /^ARG OPENGENI_PYTHON_PACKAGES="([^"]+)"$/m.exec(text)?.[1];
    expect(list).toBeDefined();
    return new Set(list!.split(/\s+/).map((pin) => pin.split("==")[0]));
  });
  for (const [skill, expected, alsoClaimed] of [
    ["documents", "python-docx", " and Chromium, and no LibreOffice, pandoc or PDF library"],
    ["presentations", "python-pptx", " and no slide renderer"],
    ["spreadsheets", "openpyxl", ""],
  ] as const) {
    const prose = (
      await Bun.file(
        new URL(`../src/bundled_artifact_skills/${skill}/SKILL.md`, import.meta.url),
      ).text()
    ).replace(/\s+/g, " ");
    const claims = [
      ...prose.matchAll(/Managed sandboxes already include (.+?),? so do not check/g),
    ].map((match) => match[1]);
    expect(claims).toEqual([`${expected}${alsoClaimed}`]);
    for (const image of images) expect(image.has(expected)).toBe(true);
  }
  // The documents Skill prints PDFs with the `chromium` command: the sandbox
  // image installs Debian Chromium, the desktop image aliases that name to its
  // browser wrapper.
  expect(dockerfiles[0]).toContain('"chromium=${OPENGENI_CHROMIUM_VERSION}"');
  expect(dockerfiles[0]).toContain("chromium --version");
  expect(dockerfiles[1]).toMatch(/for alias_name in [^;]*\bchromium\b[^;]*; do \\\s+ln -sf/);
  for (const text of dockerfiles) {
    // Both Skills say these are absent, so agents neither probe for nor expect them.
    expect(text).not.toMatch(/libreoffice|pandoc|poppler/i);
  }
});

test("Office file Skills give the managed-sandbox fast path without probing", async () => {
  const prose = async (skill: string) =>
    (
      await Bun.file(
        new URL(`../src/bundled_artifact_skills/${skill}/SKILL.md`, import.meta.url),
      ).text()
    ).replace(/\s+/g, " ");
  const documents = await prose("documents");
  const presentations = await prose("presentations");
  for (const text of [documents, presentations]) {
    expect(text).toContain(
      "Making the file is one reply of work: do not set a goal for it, explore the sandbox, or search for tools other than `sandbox_file_publish`.",
    );
    expect(text).toContain(
      "Publish the file with `sandbox_file_publish` and reply with a short summary and its link. If that tool is not loaded yet, load it with `tool_search` in the same batch as your first command.",
    );
    expect(text).toContain("unless an export tool already in your context lists that format");
    expect(text).not.toContain("is unavailable or does not list that format");
  }
  expect(documents).toContain("--print-to-pdf=out.pdf in.html");
  expect(documents).toContain("--screenshot=page.png in.html");
  expect(documents).not.toContain("soffice");
  // The renderer is an explicit, narrow install, never assumed to be present.
  expect(
    presentations.indexOf("apt-get install -y --no-install-recommends libreoffice-impress"),
  ).toBeLessThan(presentations.indexOf("soffice"));
  expect(presentations).toContain(
    "This gate applies to native deck work, not to a PowerPoint file made under the procedure above.",
  );
});
