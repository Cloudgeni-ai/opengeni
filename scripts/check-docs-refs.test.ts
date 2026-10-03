import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const guardPath = join(import.meta.dir, "check-docs-refs.ts");
const architecture = [
  "# Architecture",
  "### 6.1 Applications",
  "### 6.2 Packages",
  "`packages/sdk`",
  "### 6.3 Examples",
  "### 6.4 Rust agent and relay",
].join("\n");
const integrationConsumers = [
  "README.md",
  "docs/README.md",
  "docs/credentials.md",
  "docs/organization-tenancy.md",
  "packages/sdk/README.md",
  "examples/northstar-support/README.md",
  ".agents/skills/opengeni/SKILL.md",
  ".agents/skills/opengeni/references/client-integration.md",
  ".agents/skills/opengeni-client/SKILL.md",
  ".agents/skills/opengeni-client/references/product-integration-shapes.md",
  ".agents/skills/opengeni-client/references/api-workflows.md",
];
const integrationGuide = [
  "organization API key",
  "organization workspace",
  'kind: "shared"',
  "Personal workspaces",
  "`listOrganizationApiKeys`",
  "`createOrganizationApiKey`",
  "`deleteOrganizationApiKey`",
  "`ensureWorkspace`",
  "`GET /v1/organizations/:organizationId/api-keys`",
  "`POST /v1/organizations/:organizationId/api-keys`",
  "`DELETE /v1/organizations/:organizationId/api-keys/:apiKeyId`",
  "`PUT /v1/workspaces/external`",
  "accountId: organizationId",
  "const { workspace, created } = await client.ensureWorkspace",
  "an empty `workspaceGrants` array does not mean",
  "`CreateSessionRequest.skills`",
  "There is no organization-wide Skill registry or Skill inheritance",
].join("\n");

async function withFixture(
  run: (fixture: {
    write(path: string, text: string): Promise<void>;
    inspect(): Promise<{ exitCode: number; stderr: string }>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "opengeni-docs-refs-"));
  const write = async (path: string, text: string) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, text);
  };
  try {
    await write("package.json", JSON.stringify({ workspaces: ["packages/*"] }));
    await write("packages/sdk/package.json", JSON.stringify({ name: "@opengeni/sdk" }));
    await write("docs/architecture.md", architecture);
    await write("docs/product-integration.md", integrationGuide);
    for (const path of integrationConsumers) {
      await write(path, "[Product integration](product-integration.md)\n");
    }
    await run({
      write,
      inspect: async () => {
        const proc = Bun.spawn([process.execPath, guardPath], {
          cwd: root,
          stdout: "ignore",
          stderr: "pipe",
        });
        const [exitCode, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stderr).text(),
        ]);
        return { exitCode, stderr };
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("valid architecture orientation is reference-checked regardless of total word count", async () => {
  const currentArchitecture = await Bun.file(
    new URL("../docs/architecture.md", import.meta.url),
  ).text();
  const currentWords = currentArchitecture.match(/\S+/gu)?.length ?? 0;
  const expandedOrientation =
    "Additional subsystem orientation remains reference-checked.\n".repeat(currentWords * 2);
  await withFixture(async (fixture) => {
    await fixture.write("docs/architecture.md", `${architecture}\n${expandedOrientation}`);
    expect(await fixture.inspect()).toEqual({ exitCode: 0, stderr: "" });
  });
});

test("architecture still rejects references to missing repository paths", async () => {
  await withFixture(async (fixture) => {
    await fixture.write("docs/architecture.md", `${architecture}\n\`docs/missing-topic.md\``);
    const result = await fixture.inspect();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("docs/missing-topic.md");
  });
});

test("architecture still rejects unknown workspace packages", async () => {
  await withFixture(async (fixture) => {
    await fixture.write("docs/architecture.md", `${architecture}\n\`@opengeni/missing-package\``);
    const result = await fixture.inspect();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("@opengeni/missing-package");
  });
});

test.each([
  architecture.replace("### 6.3 Examples", ""),
  architecture
    .replace("### 6.2 Packages", "### 6.3 Examples")
    .replace("`packages/sdk`\n### 6.3 Examples", "`packages/sdk`\n### 6.2 Packages"),
])("architecture still rejects missing or reordered workspace-map headings", async (text) => {
  await withFixture(async (fixture) => {
    await fixture.write("docs/architecture.md", text);
    const result = await fixture.inspect();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("§6 workspace map");
  });
});

test("architecture still requires every declared workspace in the map", async () => {
  await withFixture(async (fixture) => {
    await fixture.write(
      "packages/additional/package.json",
      JSON.stringify({ name: "@opengeni/additional" }),
    );
    const result = await fixture.inspect();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("packages/additional");
  });
});

test("the canonical product-integration guide remains required", async () => {
  await withFixture(async (fixture) => {
    await fixture.write("docs/product-integration.md", "");
    const result = await fixture.inspect();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("docs/product-integration.md");
  });
});

test.each([
  "`CreateSessionRequest.skills`",
  "an empty `workspaceGrants` array does not mean",
  "There is no organization-wide Skill registry or Skill inheritance",
])("the integration guide still requires its authority and Skills contract: %s", async (token) => {
  await withFixture(async (fixture) => {
    await fixture.write("docs/product-integration.md", integrationGuide.replace(token, ""));
    const result = await fixture.inspect();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(token);
  });
});

test("required integration consumers still link to the canonical guide", async () => {
  await withFixture(async (fixture) => {
    await fixture.write("README.md", "# Product\n");
    const result = await fixture.inspect();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("README.md");
    expect(result.stderr).toContain("product-integration.md");
  });
});
