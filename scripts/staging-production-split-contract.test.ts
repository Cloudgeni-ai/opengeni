import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflows = join(import.meta.dir, "..", ".github", "workflows");

function workflow(name: string): string {
  return readFileSync(join(workflows, name), "utf8");
}

describe("staging / production split workflows", () => {
  test("staging dispatch pins existing canary-sha tags and refuses unsigned rebuild", () => {
    const source = workflow("staging-canary-dispatch.yml");
    expect(source).toContain("workflow_dispatch:");
    expect(source).toContain("git fetch --no-tags origin main");
    expect(source).toContain('git merge-base --is-ancestor "$SOURCE_SHA" origin/main');
    expect(source).toContain(":canary-sha-$SOURCE_SHA");
    expect(source).toContain("canary-sha tags missing; refuse unsigned rebuild");
    expect(source).toContain("pendingChangesetsAllowed:true");
    expect(source).toContain("docker/login-action@v4.4.0");
    expect(source).toContain("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(source).not.toContain("docker/build-push-action");
    expect(source).not.toContain(":ci");
  });

  test("production PR heads admit only live main or hotfix/*", () => {
    const source = workflow("production-pr-heads.yml");
    expect(source).toContain("branches:\n      - production");
    expect(source).toContain('if [ "$HEAD_REF" = "main" ]; then');
    expect(source).toContain("hotfix/*)");
    expect(source).toContain("PRs into production must use head main (promote) or hotfix/*.");
  });

  test("canary npm publish does not consume changesets or move latest", () => {
    const source = workflow("publish-canary.yml");
    expect(source).toContain("bun scripts/publish-canary.ts");
    expect(source).toContain("group: publish-canary");
    expect(source).toContain("NPM_CONFIG_PROVENANCE: \"true\"");
    expect(source).toContain("registry-url: https://registry.npmjs.org");
    expect(source).not.toContain("changeset publish");
    expect(source).not.toContain("--tag latest");
  });

  test("manual Version PR dispatches exact-head CI and is not push-triggered", () => {
    const source = workflow("open-version-pr.yml");
    expect(source).toContain("workflow_dispatch:");
    expect(source).not.toContain("push:");
    expect(source).toContain("dispatch-version-ci");
    expect(source).toContain("changesets/action@a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d");
  });

  test("source admission freeze-head runs only for hotfix/* into production", () => {
    const source = workflow("source-admission.yml");
    expect(source).toContain("branches:\n      - production");
    expect(source).toContain("startsWith(github.event.pull_request.head.ref, 'hotfix/')");
    expect(source).toContain("name: Verify hotfix freeze-head");
    expect(source).toContain("name: Current-base source admission");
    expect(source).toContain("if: ${{ always() }}");
  });
});
