import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

const skill = readFileSync(
  new URL("../src/bundled_site_skills/sites/SKILL.md", import.meta.url),
  "utf8",
);
const reference = (name: string) =>
  readFileSync(
    new URL(`../src/bundled_site_skills/sites/references/${name}`, import.meta.url),
    "utf8",
  );

describe("Sites skill simple-page path", () => {
  test("keeps the main file small: a simple page needs nothing else", () => {
    // The main file is all a simple page reads; app material lives in references.
    expect(Buffer.byteLength(skill)).toBeLessThan(16 * 1024);
    expect(skill).toContain('Follow "Simple page" below; nothing else in this Skill is needed.');
  });

  test("puts the path choice and the simple page before any app material", () => {
    const choice = skill.indexOf("## Pick the path first");
    const simple = skill.indexOf("## Simple page");
    const apps = skill.indexOf("## Apps");
    expect(choice).toBeGreaterThan(-1);
    expect(choice).toBeLessThan(simple);
    expect(simple).toBeLessThan(apps);
    expect(simple).toBeLessThan(skill.indexOf("## Sites have no server"));
    const section = skill.slice(simple, skill.indexOf("## Make new Sites readable by default"));
    expect(section).toContain("Do not set a goal");
    expect(section).toContain("At most one quick look at phone width");
    expect(section).toContain("`requestedTools: []`");
    expect(section).toContain("ask before making it public");
  });

  test("scopes the heavy checks to apps", () => {
    expect(skill).not.toContain("## Completion gate");
    const build = reference("build-and-preview.md");
    expect(build).toContain("## Completion gate (apps)");
    expect(build).toContain("This gate applies to apps.");
    const readable = skill.slice(
      skill.indexOf("## Make new Sites readable by default"),
      skill.indexOf("## Edit an existing Site"),
    );
    expect(readable).toContain("For an app, before publishing");
    expect(readable).toContain("text enlarged to 200%");
  });

  test("names every reference file, and every named reference exists", () => {
    const files = readdirSync(
      new URL("../src/bundled_site_skills/sites/references", import.meta.url),
    );
    for (const file of files) expect(skill).toContain(`references/${file}`);
    for (const [, file] of skill.matchAll(/references\/([a-z-]+\.md)/gu))
      expect(files).toContain(file!);
  });

  test("explains a login-only deployment's sign-in page instead of calling sharing broken", () => {
    const web = skill.slice(skill.indexOf("## Publish to the web"), skill.indexOf("## Apps"));
    expect(web).toContain("Ask before making a Site public");
    expect(web).toContain("`public_sign_in_required`");
    expect(web).toContain("not a broken link");
  });
});

describe("Sites skill host-bridge rule", () => {
  test("states up front that a Site never needs its own server for Opengeni AI", () => {
    const rule = skill.indexOf("## Sites have no server; AI comes from the host");
    const durable = skill.indexOf("## Start from the durable Site");
    expect(rule).toBeGreaterThan(-1);
    expect(rule).toBeLessThan(durable);
    expect(reference("ai-and-chat.md")).toContain("## Prefer Opengeni's UI and typed client");

    const section = skill.slice(rule, durable);
    expect(section).toContain("A Site never needs its own server, API key, or hosting provider");
    expect(section).toContain("`createOpenGeniSiteClient` from `@opengeni/sdk/site`");
    expect(section).toContain("`@opengeni/react/session-ui`");
    expect(section).toContain(
      '"keep\ncredentials server-side" is already satisfied by that bridge',
    );
    expect(section).toContain('"Ask the data", or a "backend"');
    expect(section).toContain(
      "Do not propose Vercel, another\nserver, a tunnel, or a Connected Machine",
    );
    expect(section).toContain("do not spawn a\nchild to build a separate backend");
    expect(section).toContain(
      "do not post a Connect card for a\nhosting provider the user did not name",
    );
    expect(section).toContain("say which designs are possible and ask before building");
  });

  test("keeps the backend escape hatch scoped to external compute and asks first", () => {
    expect(skill).toContain("Workspace AI and tool access are\n  never such a backend (see above)");
    expect(skill).toContain(
      "explain that constraint and ask how the user\n  wants to proceed instead of dropping functionality or choosing a host",
    );
    expect(skill).not.toContain(
      "If the app requires a backend that\n  Sites cannot host, explain that constraint instead of dropping functionality.",
    );
  });

  test("points persistent data at Site Data instead of a separate server", () => {
    const rule = skill.indexOf("## Sites have no server; AI comes from the host");
    const durable = skill.indexOf("## Start from the durable Site");
    const section = skill.slice(rule, durable);
    expect(section).toContain("Saved data needs no server either");
    expect(section).not.toContain("a persistent database, or scheduled jobs");
    expect(skill).toContain("`references/site-data.md`");
    const guide = reference("site-data.md");
    expect(guide).toContain("## Save data with Site Data");
    for (const mode of ["`shared`", "`shared_read`", "`per_viewer`", "`append_only`"])
      expect(guide).toContain(mode);
    expect(guide).toContain("never `innerHTML`");
    expect(guide).toContain("`quota_exceeded`");
    expect(guide).toContain("`opengeni__site_data_define_collection`");
  });
});
