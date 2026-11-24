import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { SITE_CHARTS_JS, SITE_UI_CSS } from "@opengeni/sdk/site-ui";

const skill = readFileSync(
  new URL("../src/bundled_site_skills/sites/SKILL.md", import.meta.url),
  "utf8",
);
const reference = (name: string) =>
  readFileSync(
    new URL(`../src/bundled_site_skills/sites/references/${name}`, import.meta.url),
    "utf8",
  );

describe("Sites skill single-file path", () => {
  test("keeps the main file small: a single-file Site needs nothing else but dashboards", () => {
    // The main file is all a single-file Site reads, except the dashboard
    // reference for pages with charts; app material lives in references.
    expect(Buffer.byteLength(skill)).toBeLessThan(16 * 1024);
    const section = skill.slice(skill.indexOf("## Single-file app"), skill.indexOf("## Look"));
    expect(section).toContain("A dashboard or chart: read\n   `references/dashboards.md` first.");
  });

  test("the dashboard reference stays short and names only what the host ships", () => {
    const guide = reference("dashboards.md");
    expect(Buffer.byteLength(guide)).toBeLessThan(6 * 1024);
    expect(guide).toContain('<script src="/__opengeni/charts.js"></script>');
    for (const name of new Set(guide.match(/(?<![\w-])og-[a-z0-9-]+/g) ?? []))
      expect(SITE_UI_CSS).toContain(`.${name}`);
    for (const token of new Set(guide.match(/--og-[a-z0-9-]+/g) ?? []))
      expect(SITE_UI_CSS).toContain(`${token}:`);
    for (const call of new Set(guide.match(/\bog\.(?:fmt\.)?[a-z]+/g) ?? [])) {
      const name = call.split(".").pop()!;
      if (name === "fmt") continue;
      expect(SITE_CHARTS_JS).toMatch(new RegExp(`\\b${name}: (?:function|${name})\\b`));
    }
  });

  test("sends every new app to the design reference in the first read", () => {
    const description = /^description: (.+)$/mu.exec(skill)?.[1] ?? "";
    expect(description).toContain(
      "read `references/design.md` in the same `skill_read` as `SKILL.md`",
    );
    const look = skill.slice(skill.indexOf("## Look"), skill.indexOf("## Edit an existing app"));
    expect(look).toContain(
      "Before writing markup for a new app or a restyle, read\n`references/design.md`.",
    );
    // A page shown to others gets its own design before the Opengeni look.
    expect(look.indexOf("a design of its own")).toBeGreaterThan(-1);
    expect(look.indexOf("a design of its own")).toBeLessThan(
      look.indexOf("Otherwise the Opengeni look"),
    );

    const design = reference("design.md");
    // One extra file in the fast path, so it stays short.
    expect(Buffer.byteLength(design)).toBeLessThan(8 * 1024);
    for (const heading of [
      "## Decide before writing markup",
      "## Tools in the Opengeni look",
      "## Pages with a design of their own",
      "## Every app",
      "## Signs of a generated page",
      "## Before saving",
    ])
      expect(design).toContain(heading);
    // The person's or workspace's design, and an installed design Skill, win.
    expect(design).toContain("A design the person or the workspace gave you wins");
    expect(design).toContain("`frontend-design`");
    // Dashboards and charts have their own guide, and it wins for those pages.
    expect(design).toContain("`references/dashboards.md`, which\nwins over this file");
    expect(design).toContain("A small edit keeps the app's look.");
    // Nothing may load beside the app, fonts included.
    expect(design).toContain("Nothing may load from a font or CSS CDN");
    expect(design).not.toMatch(/https?:\/\//u);
    // Every class and token it names exists in the shipped stylesheet.
    const tools = design.slice(
      design.indexOf("## Tools in the Opengeni look"),
      design.indexOf("## Pages with a design of their own"),
    );
    const names = new Set(
      [...tools.matchAll(/`(-{0,2}og-[a-z0-9-]+)`/gu)].map(([, name]) => name!),
    );
    expect(names.size).toBeGreaterThan(12);
    for (const name of names)
      expect(SITE_UI_CSS, name).toContain(name.startsWith("--") ? `${name}:` : `.${name}`);
  });

  test("puts the path choice and the single-file Site before any app material", () => {
    const choice = skill.indexOf("## Pick the path first");
    const simple = skill.indexOf("## Single-file app");
    const apps = skill.indexOf("## Full apps");
    expect(choice).toBeGreaterThan(-1);
    expect(choice).toBeLessThan(simple);
    expect(simple).toBeLessThan(apps);
    const section = skill.slice(simple, skill.indexOf("## Look"));
    expect(simple).toBeLessThan(skill.indexOf("## AI and tools come from the host"));
    expect(section).toContain("Do not set a goal");
    expect(section).toContain("At most one quick look at phone width");
    expect(section).toContain("`requestedTools: []`");
    expect(section).toContain("ask before making it public");
    expect(skill.slice(choice, simple)).toContain(
      "An app you can finish in this turn needs no goal.",
    );
  });

  test("covers a personal tracker with saved entries without the app path", () => {
    const choice = skill.slice(
      skill.indexOf("## Pick the path first"),
      skill.indexOf("## Single-file app"),
    );
    expect(choice).toContain("keeps the viewer's own entries");
    expect(choice).toContain("Build what the person asked for.");
    expect(choice).toContain("instead of building them");
    const section = skill.slice(skill.indexOf("## Single-file app"), skill.indexOf("## Look"));
    expect(section).toContain('<script src="/__opengeni/site-tools/client.js"></script>');
    expect(section).toContain('.data.collection("entries")');
    expect(section).toContain("`opengeni__app_data_define_collection`");
    expect(section).toContain("`per_viewer`");
    expect(section).toContain("preview servers and test harnesses");
    expect(section).toContain("Reply with the link once that works");
    expect(skill).toContain("Mention source files, tests or tool names only to");
  });

  test("scopes the heavy checks to apps", () => {
    expect(skill).not.toContain("## Completion gate");
    const build = reference("build-and-preview.md");
    expect(build).toContain("## Completion gate (full apps)");
    expect(build).toContain("This gate applies to full apps.");
    const readable = skill.slice(
      skill.indexOf("## Look"),
      skill.indexOf("## Edit an existing app"),
    );
    expect(readable).toContain("For a full app, before publishing");
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
    const web = skill.slice(skill.indexOf("## Publish to the web"), skill.indexOf("## Full apps"));
    expect(web).toContain("Ask before making an app public");
    expect(web).toContain("`public_sign_in_required`");
    expect(web).toContain("not a broken link");
  });

  test("tells Sites to page growing data instead of failing at a fixed size", () => {
    const normalize = (text: string) => text.replace(/\s+/gu, " ");
    expect(normalize(reference("site-data.md"))).toContain(
      "Never fail the whole page once a collection passes a fixed number of records",
    );
    expect(normalize(reference("site-sql.md"))).toContain(
      "treat `truncated: true` as more rows to page or narrow, not as a failure of the whole page",
    );
    expect(normalize(reference("build-and-preview.md"))).toContain(
      "never fail the whole page once a result passes a fixed size",
    );
  });
});

describe("Sites skill host-bridge rule", () => {
  test("states up front that a Site never needs its own server for Opengeni AI", () => {
    const rule = skill.indexOf("## AI and tools come from the host");
    const durable = skill.indexOf("## Start from the durable app");
    expect(rule).toBeGreaterThan(-1);
    expect(rule).toBeLessThan(durable);
    expect(reference("ai-and-chat.md")).toContain("## Prefer Opengeni's UI and typed client");

    const section = skill.slice(rule, durable);
    expect(section).toContain("An app never needs its own server, API key, or hosting provider");
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
    expect(section).toContain("`references/server-code.md`");
    expect(section).toContain("Never another host for that.");
  });

  test("runs server code as the app on shared accounts only", () => {
    const guide = reference("server-code.md");
    expect(guide).toContain("runs **as the\napp**, never as the person viewing it");
    expect(guide).toContain("never a viewer's own connection");
    expect(guide).toContain("`site.server.fetch(path, init)`");
    expect(guide).toContain("do not fall back to\nthe viewer's connection");
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
    const rule = skill.indexOf("## AI and tools come from the host");
    const durable = skill.indexOf("## Start from the durable app");
    const section = skill.slice(rule, durable);
    expect(section).toContain("Saved data needs no server either");
    expect(section).not.toContain("a persistent database, or scheduled jobs");
    expect(skill).toContain("`references/site-data.md`");
    const guide = reference("site-data.md");
    expect(guide).toContain("## Save data with app data");
    for (const mode of ["`shared`", "`shared_read`", "`per_viewer`", "`append_only`"])
      expect(guide).toContain(mode);
    expect(guide).toContain("never `innerHTML`");
    expect(guide).toContain("`quota_exceeded`");
    expect(guide).toContain("`opengeni__app_data_define_collection`");
  });
});
