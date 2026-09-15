import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginUninstallPreview, UninstallPluginResult } from "@opengeni/sdk";
import { PluginRemovalImpact, pluginRetentionReason } from "./plugin-removal-impact";
import { pluginRemovalMessage } from "./plugin-removal-result";

const customized = {
  capabilityId: "skill:security-review",
  name: "Security review",
  kind: "skill" as const,
  skillId: "00000000-0000-4000-8000-000000000001",
  disposition: "retained" as const,
  retainedByOtherOwners: false,
  retentionReasons: ["customized" as const],
  remainingOwners: [],
};
const shared = {
  capabilityId: "mcp:scanner",
  name: "Scanner tools",
  kind: "mcp" as const,
  disposition: "retained" as const,
  retainedByOtherOwners: true,
  retentionReasons: ["other_owners" as const],
  remainingOwners: [{ kind: "plugin" as const, name: "Code review" }],
};
function preview(components: PluginUninstallPreview["components"]): PluginUninstallPreview {
  return {
    pluginKey: "aikido",
    installed: true,
    version: "1.0.0",
    installationVersion: 1,
    previewToken: "a".repeat(64),
    components,
  };
}

test("removal names customized Skills that stay even with no other installation", () => {
  const html = renderToStaticMarkup(<PluginRemovalImpact preview={preview([customized])} />);
  expect(html).toContain("Will stay");
  expect(html).toContain("Security review");
  expect(html).toContain("Customized in this workspace.");
  expect(html).not.toContain("Will be removed");
  expect(html).not.toContain("owner");
  expect(html.match(/Your connected accounts will stay connected/g)).toHaveLength(1);
});

test("simple and empty removals omit empty retention groups and retain semantic lists", () => {
  const html = renderToStaticMarkup(
    <PluginRemovalImpact
      preview={preview([{ ...customized, disposition: "removed", retentionReasons: [] }])}
    />,
  );
  expect(html).toContain("Will be removed");
  expect(html).toContain("<ul");
  expect(html).not.toContain("Will stay");
  expect(html).not.toContain("Already inactive");
  const empty = renderToStaticMarkup(<PluginRemovalImpact preview={preview([])} />);
  expect(empty).toContain("no installed skills or tools");
  expect(empty).not.toContain("0 will remain");
});

test("retention reasons name shared installations without internal ownership terms", () => {
  expect(pluginRetentionReason(shared)).toBe("Also included in Code review.");
  expect(
    pluginRetentionReason({
      ...shared,
      remainingOwners: [{ kind: "direct", name: "Direct installation" }],
    }),
  ).toBe("Also installed separately.");
  expect(pluginRetentionReason({ ...customized, retentionReasons: ["re_scoped"] })).toBe(
    "Managed outside this workspace.",
  );
});

test("completion combines shared components and preserved Skills from the mutation receipt", () => {
  const result: UninstallPluginResult = {
    pluginKey: "aikido",
    status: "uninstalled",
    retainedComponents: [shared.capabilityId],
    skillReleases: [
      {
        skillId: customized.skillId,
        revisionId: null,
        disposition: "preserved",
        eventId: null,
        warning: null,
      },
    ],
  };
  expect(pluginRemovalMessage(result, preview([customized, shared]))).toBe(
    "Security review, Scanner tools were kept. Your connected accounts are unchanged.",
  );
  expect(
    pluginRemovalMessage(
      { ...result, retainedComponents: [], skillReleases: [] },
      preview([customized, shared]),
    ),
  ).toBe("Your connected accounts are unchanged.");
});
