#!/usr/bin/env bun
/**
 * PR fast check: every checked-in generated artifact that Batch CI verifies is
 * re-rendered and compared with the committed file, and a stale one fails with
 * the exact command that regenerates it. Batch fails on the same staleness
 * (`batchEnforcedBy`), but only after the PR has joined a batch of up to 15.
 *
 * Every check is a seconds-cheap re-render, so all of them run on every PR:
 * scoping by changed paths would have to follow bundler and generator imports
 * across workspaces to stay sound, for no meaningful saving.
 *
 *   bun scripts/ci/check-generated-artifacts.ts
 */

export type GeneratedArtifactCheck = {
  name: string;
  /** Committed files (or directories) the check keeps current. */
  artifacts: readonly string[];
  /** Exits non-zero when any artifact differs from a fresh render. */
  check: readonly string[];
  /** The exact command that regenerates the artifacts. */
  regenerate: string;
  /** The Batch CI script or unit test that fails on the same staleness. */
  batchEnforcedBy: string;
};

export const GENERATED_ARTIFACT_CHECKS: readonly GeneratedArtifactCheck[] = [
  {
    name: "Site browser runtime",
    artifacts: ["packages/sdk/src/site-browser-runtime.gen.ts"],
    check: ["bun", "scripts/generate-site-browser-runtime.ts", "--check"],
    regenerate: "bun scripts/generate-site-browser-runtime.ts",
    batchEnforcedBy: "scripts/ci/batch-source.ts",
  },
  {
    name: "Organization MCP action catalog",
    artifacts: [
      "packages/contracts/src/app-action-catalog.gen.ts",
      "apps/api/src/mcp/action-schema-imports.gen.ts",
    ],
    check: ["bun", "scripts/public-api/action-catalog.ts", "--check"],
    regenerate: "bun scripts/public-api/action-catalog.ts --write",
    batchEnforcedBy: "apps/api/test/organization-mcp.test.ts",
  },
  {
    name: "React compiled CSS",
    artifacts: ["packages/react/styles/compiled.css", "packages/react/styles/effective-tokens.css"],
    check: ["bun", "run", "--cwd", "packages/react", "check:css"],
    regenerate: "bun run --cwd packages/react build:css",
    batchEnforcedBy: "packages/react/test/compiled-css.test.ts",
  },
  {
    name: "Site gateway shell",
    artifacts: ["apps/site-gateway/src/shell/shell-script.gen.ts"],
    check: ["bun", "run", "--cwd", "apps/site-gateway", "check:shell"],
    regenerate: "bun run --cwd apps/site-gateway build:shell",
    batchEnforcedBy: "apps/site-gateway/test/shell.test.ts",
  },
  {
    name: "Child lifecycle notice protocol",
    artifacts: ["packages/contracts/src/child-lifecycle-notice-protocol.gen.json"],
    check: ["bun", "scripts/generate-child-lifecycle-notice-protocol.ts", "--check"],
    regenerate: "bun scripts/generate-child-lifecycle-notice-protocol.ts",
    batchEnforcedBy: "packages/contracts/test/child-lifecycle-notice-protocol.test.ts",
  },
  {
    name: "Client Skill mirrors",
    artifacts: [
      "packages/runtime/src/bundled_default_skills/opengeni-client",
      "docs-site/reference/opengeni-client-skill.mdx",
      "plugins/opengeni/skills/build-with-opengeni/opengeni-client",
      "plugins/opengeni/skills/opengeni-setup",
    ],
    check: ["bun", "scripts/sync-client-skill.ts", "--check"],
    regenerate: "bun scripts/sync-client-skill.ts",
    batchEnforcedBy: "scripts/sync-client-skill.test.ts",
  },
];

/**
 * Generated files (`*.gen.*`, `*.generated.*`) this step does not re-render,
 * with the reason. A new generated file must be added here or above.
 */
export const GENERATED_ARTIFACTS_NOT_RECHECKED: Readonly<Record<string, string>> = {
  "scripts/public-api/surface.gen.json": "the impact plan's public-api guard (PR and Batch)",
  "apps/api/src/routes/github-browser-fonts.gen.ts": "the generated-fonts guard (PR and Batch)",
  "packages/react/src/lib/noto-sans-jp-loader.generated.ts":
    "the generated-fonts guard (PR and Batch)",
  "packages/contracts/src/cua-desktop-tools.gen.json":
    "built from the Python CUA worker; Batch does not check it",
  "packages/contracts/src/cua-desktop-tools.linux.gen.json":
    "built from the Python CUA worker; Batch does not check it",
  "packages/contracts/src/cua-desktop-tools.windows.gen.json":
    "built from the Python CUA worker; Batch does not check it",
  "packages/react-native/src/timeline/icon-nodes.generated.ts":
    "one-off generator with no check mode; Batch does not check it",
  "packages/react-native/src/ui/web-tokens.gen.ts":
    "one-off generator with no check mode; Batch does not check it",
  "packages/react/src/components/artifacts/visualization-assets.gen.ts":
    "rewritten by the @opengeni/react build; Batch does not check it",
};

export type GeneratedArtifactResult = {
  check: GeneratedArtifactCheck;
  exit: number;
  output: string;
};

export async function runGeneratedArtifactChecks(
  checks: readonly GeneratedArtifactCheck[] = GENERATED_ARTIFACT_CHECKS,
): Promise<GeneratedArtifactResult[]> {
  return Promise.all(
    checks.map(async (check) => {
      const child = Bun.spawn([...check.check], {
        cwd: process.cwd(),
        env: process.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { check, exit, output: `${stdout}${stderr}`.trim() };
    }),
  );
}

/** GitHub annotation for one stale artifact, naming the command that fixes it. */
export function staleArtifactAnnotation(check: GeneratedArtifactCheck): string {
  return (
    `::error title=Stale generated artifact::${check.name} (${check.artifacts.join(", ")}) ` +
    `is stale. Run \`${check.regenerate}\` and commit the result.`
  );
}

if (import.meta.main) {
  const results = await runGeneratedArtifactChecks();
  for (const { check, exit, output } of results) {
    process.stdout.write(`[generated] ${check.name}: ${exit === 0 ? "current" : "STALE"}\n`);
    if (exit !== 0 && output) process.stdout.write(`${output}\n`);
  }
  const stale = results.filter((result) => result.exit !== 0);
  for (const { check } of stale) process.stdout.write(`${staleArtifactAnnotation(check)}\n`);
  if (stale.length > 0) process.exit(1);
}
