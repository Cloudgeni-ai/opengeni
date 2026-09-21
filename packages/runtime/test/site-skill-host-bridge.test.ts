import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const skill = readFileSync(
  new URL(
    "../src/bundled_site_skills/opengeni-sites/SKILL.md",
    import.meta.url,
  ),
  "utf8",
);

describe("Sites skill host-bridge rule", () => {
  test("states up front that a Site never needs its own server for OpenGeni AI", () => {
    const rule = skill.indexOf(
      "## Sites have no server; AI comes from the host",
    );
    const durable = skill.indexOf("## Start from the durable Site");
    const bridge = skill.indexOf("## Prefer OpenGeni's UI and typed client");
    expect(rule).toBeGreaterThan(-1);
    expect(rule).toBeLessThan(durable);
    expect(durable).toBeLessThan(bridge);

    const section = skill.slice(rule, durable);
    expect(section).toContain(
      "A Site never needs its own server, API key, or hosting provider",
    );
    expect(section).toContain(
      "`createOpenGeniSiteClient` from `@opengeni/sdk/site`",
    );
    expect(section).toContain("`@opengeni/react/session-ui`");
    expect(section).toContain(
      '"keep\ncredentials server-side" is already satisfied by that bridge',
    );
    expect(section).toContain('"Ask the data", or a "backend"');
    expect(section).toContain(
      "Do not propose Vercel, another\nserver, a tunnel, or a Connected Machine",
    );
    expect(section).toContain(
      "do not spawn a\nchild to build a separate backend",
    );
    expect(section).toContain(
      "do not post a Connect card for a\nhosting provider the user did not name",
    );
    expect(section).toContain(
      "say which designs are possible and ask before building",
    );
  });

  test("keeps the backend escape hatch scoped to non-OpenGeni compute and asks first", () => {
    expect(skill).toContain(
      "OpenGeni AI and tool access are\n  never such a backend (see above)",
    );
    expect(skill).toContain(
      "explain that constraint and ask how the user\n  wants to proceed instead of dropping functionality or choosing a host",
    );
    expect(skill).not.toContain(
      "If the app requires a backend that\n  Sites cannot host, explain that constraint instead of dropping functionality.",
    );
  });
});
