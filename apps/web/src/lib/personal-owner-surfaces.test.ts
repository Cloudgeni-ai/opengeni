import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webSrc = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The owner of a Personal workspace has no `workspace:admin` grant, but
// administers these surfaces (the API uses requireWorkspaceSettingsGrant).
// A bare `workspace:admin` check here would hide them from that owner again.
const OWNER_ADMINISTERED_SURFACES = [
  "routes/insights.tsx",
  "components/settings/settings-rail.tsx",
  "components/knowledge/knowledge-page.tsx",
  "components/settings/default-machine-row.tsx",
] as const;

describe("Personal-workspace owner surfaces", () => {
  for (const file of OWNER_ADMINISTERED_SURFACES) {
    test(`${file} gates on canManageWorkspaceSettings, not a bare workspace:admin check`, () => {
      const source = readFileSync(resolve(webSrc, file), "utf8");
      expect(source).toContain("canManageWorkspaceSettings(");
      expect(source).not.toContain('"workspace:admin"');
    });
  }

  test("the Secrets page links Agent defaults for anyone who can change them", () => {
    const source = readFileSync(resolve(webSrc, "routes/secrets.tsx"), "utf8");
    expect(source).toMatch(/const canEditAgentDefaults = canManageWorkspaceSettings\(/);
  });
});
